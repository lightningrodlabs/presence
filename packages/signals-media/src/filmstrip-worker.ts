// Copied from presence ui/src/room/modules/filmstrip-worker.ts at ab90584 (signals-media extraction). Presence keeps its own copy until the adoption round.

/**
 * Filmstrip JPEG encoder, in a Web Worker.
 *
 * The reason for the Worker is unchanged from the origin: main-thread JS
 * event-loop congestion (voice's 50/sec encode, the message channel, UI
 * render) starves the capture pipeline, and `convertToBlob` off the main
 * thread keeps the JPEG encode out of that contention.
 *
 * What DID change: the origin received a transferred
 * `MediaStreamTrackProcessor` readable and ran the sample loop itself.
 * WebKitGTK has no `MediaStreamTrackProcessor`, so the sample loop now lives
 * on the main thread (`filmstrip-sampler.ts`, a `<video>` +
 * `createImageBitmap`) and this worker receives one already-sampled
 * `ImageBitmap` per frame. `ImageBitmap` is transferable everywhere the rest
 * of this package runs.
 *
 * Wire (postMessage) protocol with the main thread:
 *
 *   main → worker:
 *     { type: 'frame', bitmap, t0, capturePeriodMs, captureSide }  transfer: [bitmap]
 *     { type: 'stop' }
 *
 *   worker → main:
 *     { type: 'clip', bytes, w, h, n, p, t0, capturedAt }   transfer: [bytes]
 *     { type: 'stats', clipsPerSec, kbps, cycleMs }
 *     { type: 'error', message }
 *
 * The worker hands off raw JPEG bytes; the main thread does the base64 +
 * JSON envelope + `host.send` (the message channel is the host's, on the
 * main thread).
 *
 * No imports: this file is built to a standalone `dist/filmstrip-worker.js`
 * that is also inlined verbatim as a Blob URL (`inline-sources.ts`).
 */

const DEFAULT_CAPTURE_SIDE = 192;
const JPEG_QUALITY = 0.6;

interface FrameMessage {
  type: 'frame';
  bitmap: ImageBitmap;
  /** Sender wall-clock ms at sample time; see FilmstripClipPayload.t0. */
  t0: number;
  capturePeriodMs: number;
  captureSide: number;
}
interface StopMessage {
  type: 'stop';
}
type WorkerInputMessage = FrameMessage | StopMessage;

// Types use `any` because the DOM lib doesn't fully cover OffscreenCanvas /
// convertToBlob; runtime is fine.
let canvas: any = null;
let cctx: any = null;
let side = DEFAULT_CAPTURE_SIDE;

// Rolling-window stats. "frames" here = sent 1-frame clips; the message
// field names keep the historical clip terminology so the main thread's
// logger doesn't need to change. The origin's read-gap fields are gone with
// the reader that produced them.
let framesThisWindow = 0;
let bytesThisWindow = 0;
let encodeSumMs = 0;
let windowStart = performance.now();

self.onmessage = (e: MessageEvent<WorkerInputMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'frame':
      encodeFrame(msg).catch((err: any) => {
        (self as any).postMessage({
          type: 'error',
          message: `encode error: ${err?.message ?? err}`,
        });
      });
      break;
    case 'stop':
      stopCapture();
      break;
  }
};

/**
 * Encode one sampled bitmap and post it as a 1-frame clip (n=1) — no
 * batching. Clip assembly was the largest structural source of
 * video-behind-audio skew: a frame waited up to a full clip length before it
 * was even sent, and the receiver's startup buffer was denominated in clips.
 * Per-frame send costs ~fps signals/sec (≤7/s, trivial next to voice's 50/s)
 * and loses JPEG-strip header amortization (~a few hundred bytes/frame). The
 * wire format is unchanged — receivers already handle any n, so legacy
 * receivers play n=1 clips as-is.
 */
async function encodeFrame(msg: FrameMessage): Promise<void> {
  const start = performance.now();
  const wanted = msg.captureSide || DEFAULT_CAPTURE_SIDE;
  // Re-read the side each frame so a setCaptureSide() on the main thread
  // applies to the next frame.
  if (!canvas || side !== wanted) {
    side = wanted;
    canvas = new (self as any).OffscreenCanvas(side, side);
    cctx = canvas.getContext('2d');
  }
  if (!cctx) {
    try {
      msg.bitmap.close();
    } catch {}
    return;
  }

  try {
    const bw = msg.bitmap.width || side;
    const bh = msg.bitmap.height || side;
    const s = Math.min(bw, bh);
    const sx = (bw - s) / 2;
    const sy = (bh - s) / 2;
    cctx.drawImage(msg.bitmap, sx, sy, s, s, 0, 0, side, side);
  } finally {
    try {
      msg.bitmap.close();
    } catch {}
  }

  const blob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: JPEG_QUALITY,
  });
  const encodeEnd = performance.now();
  if (!blob) return;

  const buf = await blob.arrayBuffer();
  // Transfer the ArrayBuffer to the main thread (zero-copy).
  (self as any).postMessage(
    {
      type: 'clip',
      bytes: buf,
      w: side,
      h: side,
      n: 1,
      p: msg.capturePeriodMs,
      t0: msg.t0,
      capturedAt: Date.now(),
    },
    [buf]
  );
  framesThisWindow += 1;
  bytesThisWindow += buf.byteLength;
  encodeSumMs += encodeEnd - start;

  // Stats once per second.
  const checkNow = performance.now();
  if (checkNow - windowStart >= 1000 && framesThisWindow > 0) {
    const elapsed = checkNow - windowStart;
    (self as any).postMessage({
      type: 'stats',
      clipsPerSec: (framesThisWindow * 1000) / elapsed,
      kbps: (bytesThisWindow * 8) / elapsed,
      cycleMs: encodeSumMs / framesThisWindow,
    });
    framesThisWindow = 0;
    bytesThisWindow = 0;
    encodeSumMs = 0;
    windowStart = checkNow;
  }
}

function stopCapture(): void {
  canvas = null;
  cctx = null;
  framesThisWindow = 0;
  bytesThisWindow = 0;
  encodeSumMs = 0;
  windowStart = performance.now();
}

// TypeScript: ensure this file is treated as a module so `self` typings
// can be augmented if needed.
export {};
