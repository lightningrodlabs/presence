/**
 * Filmstrip capture pump, in a Web Worker.
 *
 * The whole reason for this Worker: main-thread JS event-loop
 * congestion (voice's 50/sec encode, sendModuleData, UI render) starves
 * the MediaStreamTrackProcessor reader, causing Chrome to drop video
 * frames before they reach our code. The W3C spec for
 * mediacapture-transform notes this directly: worker-only is needed
 * "to avoid jank... by never blocking the browser's real time media
 * pipeline on a busy main thread". Same camera, same source rate, but
 * the worker context isn't gated by main-thread work.
 *
 * The MediaStreamTrackProcessor is constructed on the *main thread*
 * (where the track lives) and its `readable` is transferred here for
 * the read loop. ReadableStream is universally transferable;
 * MediaStreamTrack isn't, in many Chromium builds.
 *
 * Wire (postMessage) protocol with the main thread:
 *
 *   main → worker:
 *     { type: 'start',  readable, capturePeriodMs }   transfer: [readable]
 *     { type: 'setFps', capturePeriodMs }
 *     { type: 'stop' }
 *
 *   worker → main:
 *     { type: 'clip', bytes, w, h, n, p, capturedAt }   transfer: [bytes]
 *     { type: 'stats', clipsPerSec, kbps, cycleMs, reads, avgGapMs, maxGapMs }
 *     { type: 'error', message }
 *
 * The worker hands off raw JPEG bytes; the main thread does the
 * base64 + JSON envelope + sendModuleData (the Holochain client lives
 * on the main thread).
 */

const CAPTURE_SIDE = 96;
const CLIP_TARGET_MS = 1000;
const JPEG_QUALITY = 0.6;

interface StartMessage {
  type: 'start';
  readable: ReadableStream;
  capturePeriodMs: number;
}
interface SetFpsMessage {
  type: 'setFps';
  capturePeriodMs: number;
}
interface StopMessage {
  type: 'stop';
}
type WorkerInputMessage = StartMessage | SetFpsMessage | StopMessage;

let captureReader: ReadableStreamDefaultReader<any> | null = null;
let pipelineGeneration = 0;
let capturePeriodMs = 250;

self.onmessage = (e: MessageEvent<WorkerInputMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'start':
      capturePeriodMs = msg.capturePeriodMs;
      startCapture(msg.readable);
      break;
    case 'setFps':
      capturePeriodMs = msg.capturePeriodMs;
      break;
    case 'stop':
      stopCapture();
      break;
  }
};

function startCapture(readable: ReadableStream): void {
  // Stop any existing pump before starting a new one (e.g. device change).
  stopCapture();
  pipelineGeneration += 1;
  const gen = pipelineGeneration;

  try {
    captureReader = readable.getReader();
  } catch (e: any) {
    (self as any).postMessage({
      type: 'error',
      message: `getReader() on readable failed: ${e?.message ?? e}`,
    });
    return;
  }

  pumpCapture(gen).catch((e: any) => {
    (self as any).postMessage({
      type: 'error',
      message: `pump error: ${e?.message ?? e}`,
    });
  });
}

function stopCapture(): void {
  pipelineGeneration += 1;
  if (captureReader) {
    captureReader.cancel().catch(() => {});
    captureReader = null;
  }
}

async function pumpCapture(gen: number): Promise<void> {
  const W = CAPTURE_SIDE;
  const H = CAPTURE_SIDE;

  // Per-clip state. Types use `any` because the project's TS lib
  // (es2017 + dom) doesn't fully cover OffscreenCanvas /
  // OffscreenCanvasRenderingContext2D / convertToBlob; runtime is fine.
  let stripCanvas: any = null;
  let sctx: any = null;
  let framesInClip = 0;
  let cycleStart = 0;
  let lastSampleMs = 0;
  let clipPeriodMs = 0;
  let clipFrameCount = 0;

  // Rolling-window stats.
  let clipsThisWindow = 0;
  let bytesThisWindow = 0;
  let cycleSumMs = 0;
  let readsThisWindow = 0;
  let lastReadMs = performance.now();
  let readGapSumMs = 0;
  let readGapMaxMs = 0;
  let windowStart = performance.now();

  while (gen === pipelineGeneration && captureReader) {
    let result: ReadableStreamReadResult<any>;
    try {
      result = await captureReader.read();
    } catch {
      break;
    }
    if (result.done) break;
    if (gen !== pipelineGeneration) {
      try { result.value?.close?.(); } catch {}
      break;
    }

    const vf = result.value as any;
    const now = performance.now();

    const gap = now - lastReadMs;
    readGapSumMs += gap;
    if (gap > readGapMaxMs) readGapMaxMs = gap;
    readsThisWindow += 1;
    lastReadMs = now;

    try {
      const P = capturePeriodMs;
      const N = Math.max(1, Math.round(CLIP_TARGET_MS / P));

      if (!stripCanvas || framesInClip === 0) {
        stripCanvas = new (self as any).OffscreenCanvas(W, H * N);
        sctx = stripCanvas.getContext('2d');
        framesInClip = 0;
        cycleStart = now;
        lastSampleMs = 0;
        clipPeriodMs = P;
        clipFrameCount = N;
        if (!sctx) continue;
      }

      const dueForSample =
        framesInClip === 0 || (now - lastSampleMs >= clipPeriodMs);
      if (dueForSample && sctx) {
        const vw = vf.displayWidth || vf.codedWidth || W;
        const vh = vf.displayHeight || vf.codedHeight || H;
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        sctx.drawImage(vf, sx, sy, side, side, 0, framesInClip * H, W, H);
        framesInClip += 1;
        lastSampleMs = now;

        if (framesInClip >= clipFrameCount) {
          const finishedStrip = stripCanvas;
          const finishedN = clipFrameCount;
          const finishedP = clipPeriodMs;
          const capturedAt = Date.now();

          const blob = await finishedStrip.convertToBlob({
            type: 'image/jpeg',
            quality: JPEG_QUALITY,
          });
          const cycleEnd = performance.now();
          stripCanvas = null;
          sctx = null;
          framesInClip = 0;

          if (gen !== pipelineGeneration) break;

          if (blob) {
            const buf = await blob.arrayBuffer();
            // Transfer the ArrayBuffer to the main thread (zero-copy).
            (self as any).postMessage(
              {
                type: 'clip',
                bytes: buf,
                w: W,
                h: H,
                n: finishedN,
                p: finishedP,
                capturedAt,
              },
              [buf]
            );
            clipsThisWindow += 1;
            bytesThisWindow += buf.byteLength;
          }
          cycleSumMs += cycleEnd - cycleStart;

          // Stats once per second.
          const checkNow = performance.now();
          if (checkNow - windowStart >= 1000 && clipsThisWindow > 0) {
            const elapsed = checkNow - windowStart;
            (self as any).postMessage({
              type: 'stats',
              clipsPerSec: (clipsThisWindow * 1000) / elapsed,
              kbps: (bytesThisWindow * 8) / elapsed,
              cycleMs: cycleSumMs / clipsThisWindow,
              reads: (readsThisWindow * 1000) / elapsed,
              avgGapMs: readsThisWindow > 0 ? readGapSumMs / readsThisWindow : 0,
              maxGapMs: readGapMaxMs,
            });
            clipsThisWindow = 0;
            bytesThisWindow = 0;
            cycleSumMs = 0;
            readsThisWindow = 0;
            readGapSumMs = 0;
            readGapMaxMs = 0;
            windowStart = checkNow;
          }
        }
      }
    } finally {
      try { vf.close(); } catch {}
    }
  }
}

// TypeScript: ensure this file is treated as a module so `self` typings
// can be augmented if needed.
export {};
