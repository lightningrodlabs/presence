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
 *     { type: 'clip', bytes, w, h, n, p, t0, capturedAt }   transfer: [bytes]
 *     { type: 'stats', clipsPerSec, kbps, cycleMs, reads, avgGapMs, maxGapMs }
 *     { type: 'error', message }
 *
 * The worker hands off raw JPEG bytes; the main thread does the
 * base64 + JSON envelope + sendModuleData (the Holochain client lives
 * on the main thread).
 */

const DEFAULT_CAPTURE_SIDE = 192;
const JPEG_QUALITY = 0.6;

interface StartMessage {
  type: 'start';
  readable: ReadableStream;
  capturePeriodMs: number;
  captureSide: number;
}
interface SetFpsMessage {
  type: 'setFps';
  capturePeriodMs: number;
}
interface SetCaptureSideMessage {
  type: 'setCaptureSide';
  captureSide: number;
}
interface StopMessage {
  type: 'stop';
}
type WorkerInputMessage =
  | StartMessage
  | SetFpsMessage
  | SetCaptureSideMessage
  | StopMessage;

let captureReader: ReadableStreamDefaultReader<any> | null = null;
let pipelineGeneration = 0;
let capturePeriodMs = 167;
let captureSide = DEFAULT_CAPTURE_SIDE;

self.onmessage = (e: MessageEvent<WorkerInputMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'start':
      capturePeriodMs = msg.capturePeriodMs;
      captureSide = msg.captureSide;
      startCapture(msg.readable);
      break;
    case 'setFps':
      capturePeriodMs = msg.capturePeriodMs;
      break;
    case 'setCaptureSide':
      captureSide = msg.captureSide;
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
  // Each sampled frame is encoded and posted immediately as a 1-frame
  // clip (n=1) — no batching. Clip assembly was the largest structural
  // source of video-behind-audio skew: a frame waited up to a full clip
  // length before it was even sent, and the receiver's startup buffer
  // was denominated in clips. Per-frame send costs ~fps signals/sec
  // (≤7/s, trivial next to voice's 50/s) and loses JPEG-strip header
  // amortization (~a few hundred bytes/frame). The wire format is
  // unchanged — receivers already handle any n, so legacy receivers
  // play n=1 clips as-is.

  // Types use `any` because the project's TS lib (es2017 + dom)
  // doesn't fully cover OffscreenCanvas / convertToBlob; runtime is fine.
  let W = captureSide;
  let H = captureSide;
  let canvas: any = null;
  let cctx: any = null;
  let lastSampleMs = 0;

  // Rolling-window stats. "frames" here = sent 1-frame clips; the
  // message field names keep the historical clip terminology so the
  // main thread's logger doesn't need to change.
  let framesThisWindow = 0;
  let bytesThisWindow = 0;
  let encodeSumMs = 0;
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
      const dueForSample = lastSampleMs === 0 || now - lastSampleMs >= P;
      if (dueForSample) {
        // Re-read the side each sample so setCaptureSide() applies on
        // the next frame.
        if (!canvas || W !== captureSide) {
          W = captureSide;
          H = captureSide;
          canvas = new (self as any).OffscreenCanvas(W, H);
          cctx = canvas.getContext('2d');
        }
        if (!cctx) continue;

        const vw = vf.displayWidth || vf.codedWidth || W;
        const vh = vf.displayHeight || vf.codedHeight || H;
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        cctx.drawImage(vf, sx, sy, side, side, 0, 0, W, H);
        lastSampleMs = now;
        // Sender wall-clock ms at frame capture — the shared timebase
        // with voice's `wts`, basis for receiver-side A/V skew.
        const t0 = Date.now();

        const blob = await canvas.convertToBlob({
          type: 'image/jpeg',
          quality: JPEG_QUALITY,
        });
        const encodeEnd = performance.now();

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
              n: 1,
              p: P,
              t0,
              capturedAt: Date.now(),
            },
            [buf]
          );
          framesThisWindow += 1;
          bytesThisWindow += buf.byteLength;
        }
        encodeSumMs += encodeEnd - now;

        // Stats once per second.
        const checkNow = performance.now();
        if (checkNow - windowStart >= 1000 && framesThisWindow > 0) {
          const elapsed = checkNow - windowStart;
          (self as any).postMessage({
            type: 'stats',
            clipsPerSec: (framesThisWindow * 1000) / elapsed,
            kbps: (bytesThisWindow * 8) / elapsed,
            cycleMs: encodeSumMs / framesThisWindow,
            reads: (readsThisWindow * 1000) / elapsed,
            avgGapMs: readsThisWindow > 0 ? readGapSumMs / readsThisWindow : 0,
            maxGapMs: readGapMaxMs,
          });
          framesThisWindow = 0;
          bytesThisWindow = 0;
          encodeSumMs = 0;
          readsThisWindow = 0;
          readGapSumMs = 0;
          readGapMaxMs = 0;
          windowStart = checkNow;
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
