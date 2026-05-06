import { mdiVideo } from '@mdi/js';
import { get } from '@holochain-open-dev/stores';
import { registerModule } from './registry';
import type { ModuleDefinition } from './types';
import type { StreamsStore } from '../../streams-store';
import type { CameraAcquireResult } from '../../camera-source';

/**
 * Video-filmstrip module — sends short looping video clips over Holochain
 * remote signals as a low-bandwidth fallback when WebRTC video isn't
 * available (mirrors voice-over-signals for video).
 *
 * Wire format: a JPEG "filmstrip" — N frames stacked vertically into one
 * JPEG ArrayBuffer (the seatcamp pattern). Each clip is ~2 s at 4 fps,
 * 120x90 per frame, q=0.6. The encoder bake-off in
 * spikes/low-bandwidth-video/ measured this at ~19 KB / 12 ms /
 * 100 kbps — the smallest and fastest of GIF / filmstrip / WebCodecs.
 *
 * Capture: cameraSource.acquire() -> off-DOM <video> playing the camera
 *          track -> HTMLCanvasElement drawImage at sample rate ->
 *          filmstrip canvas -> toBlob('image/jpeg').
 * Wire   : { seq, ts, w, h, n, p, data(base64) } in JSON via sendModuleData.
 * Play   : URL.createObjectURL on receive; subscribers (per-peer overlay
 *          element) swap their <img> src and step a CSS background-position
 *          animator at the original sample period.
 *
 * Lifecycle: receive side is always live once `bind(store)` is called
 * (mirrors voice). Send side is gated by `_reconcileSignalsVideo`, which
 * starts the capture loop only when the user has the camera on AND at
 * least one peer is in `_signalsTargets`. videoOff releases the camera
 * handle here; the device closes via cameraSource refcount.
 */

const DEFAULT_CAPTURE_PERIOD_MS = 250; // 4 fps

/**
 * Target clip cadence — one filmstrip is sent roughly every CLIP_TARGET_MS,
 * regardless of fps. The number of frames per clip equals fps (so 1 fps =
 * 1-frame snapshot per second; 8 fps = 8 frames in a 1 s loop). Keeping
 * clip cadence ~constant is what makes low fps feel near-real-time
 * instead of "8 s of buffered footage every 8 s".
 */
const CLIP_TARGET_MS = 1000;

/**
 * Sender frame rates the UI exposes via setFps(). 8 fps was tested but
 * proved unreliable (the encode pipeline can't keep up consistently
 * once you add receiver-side decode + display); 6 is the practical
 * ceiling. Keeping evenly-spaced options between gives users useful
 * trade-off granularity.
 */
export const FILMSTRIP_FPS_OPTIONS = [1, 2, 3, 4, 5, 6] as const;
export type FilmstripFps = typeof FILMSTRIP_FPS_OPTIONS[number];

/** How long to keep a stale received filmstrip showing before TTL'ing it. */
const RECEIVE_TTL_MS = 3000;

/**
 * Delay before revoking a swapped-out blob URL. Must be safely larger
 * than the clip cadence (CLIP_TARGET_MS) and any reasonable JS event-
 * loop hiccup, otherwise the OLD URL can be revoked before the receiver
 * has applied the NEW bg-image, leaving the strip pointed at a now-
 * dead URL — visible as an avatar flash through the (transparent) host.
 * 10 s buys ~10 clip cycles of headroom.
 */
const URL_REVOKE_DELAY_MS = 10000;

/**
 * Wire format. `kind` distinguishes a clip payload (default, the
 * filmstrip case) from an explicit "stop" payload that tells the
 * receiver the sender has turned video off and the receiver should
 * clear its display immediately. Older peers without `kind` are
 * treated as 'clip' for backwards compat.
 */
interface FilmstripClipPayload {
  kind?: 'clip';
  seq: number;
  ts: number; // wall-clock ms when sent
  w: number;  // single-frame width
  h: number;  // single-frame height
  n: number;  // frame count
  p: number;  // playback period ms
  data: string; // base64-encoded JPEG filmstrip
}
interface FilmstripStopPayload {
  kind: 'stop';
  seq: number;
  ts: number;
}
type FilmstripPayload = FilmstripClipPayload | FilmstripStopPayload;

/**
 * How long the receiver displays a peer's last clip with no new clips
 * arriving before falling back to "no video" (clears the bg-image so
 * the avatar shows through). 5 s is far longer than the 1 s clip
 * cadence + any reasonable jitter, so this only fires when the sender
 * has actually stopped (without managing to send a stop signal — e.g.
 * the sender's tab crashed). Normal stops use the explicit stop
 * payload and clear immediately.
 */
const RECEIVE_INACTIVITY_TTL_MS = 5000;

export interface FilmstripFrame {
  /** Blob URL of the JPEG filmstrip. Revoked ~1 s after replacement. */
  url: string;
  width: number;
  height: number;
  frameCount: number;
  periodMs: number;
  /** Wall-clock ms when this frame was received locally. */
  receivedAt: number;
}

interface PeerFilmstripState {
  latest: FilmstripFrame | null;
  lastSeq: number;
  /** Wall-clock ms of the previous arrival (for inter-arrival jitter). */
  lastArrivalMs: number;
  /** EWMA of |inter-arrival - CLIP_TARGET_MS|, in ms. */
  jitterEwma: number;
  /** EWMA of (Date.now() - payload.ts), in ms — conductor transit time. */
  transitEwma: number;
  /** Bytes received in the current rolling window. */
  bytesReceived: number;
  /** Clips received in the current rolling window. */
  clipsReceived: number;
  /** Clips inferred lost (seq gaps) in the current rolling window. */
  clipsLost: number;
  /** Wall-clock ms of the rolling window start. */
  windowStartMs: number;
  /** Inactivity TTL timer — clears the display if no clip arrives in time. */
  inactivityTimer: number | null;
}

/**
 * Per-peer signals-video stats. Updated by the receive side on a 1 s
 * rolling window. Read by the stats panel.
 */
export interface VideoSignalsStats {
  /** EWMA of clip inter-arrival deviation from CLIP_TARGET_MS, ms. */
  jitterMs: number | null;
  /** Loss percent over the rolling window (0–100). */
  lossPercent: number | null;
  /** Bandwidth over the rolling window, kilobits per second. */
  kbps: number | null;
  /** Effective frames-per-second (clips/sec × frames/clip) at receive. */
  fpsActual: number | null;
  /** Receiver-side queue depth (frames buffered, set by the element). */
  bufferDepth: number | null;
  /**
   * EWMA of conductor transit time (`Date.now() - payload.ts`), in ms.
   * On a single machine this is approximately the time from sender's
   * sendModuleData call to receiver's onData callback. Diagnostic for
   * pinpointing whether sender pump or conductor routing is the
   * bottleneck.
   */
  transitMs: number | null;
}

class FilmstripController {
  private store: StreamsStore | null = null;

  // ----- send side -----
  private cameraHandle: CameraAcquireResult | null = null;
  /**
   * Web Worker hosting the capture pump. We delegate the whole pump
   * (MediaStreamTrackProcessor read loop + drawImage + JPEG encode) to
   * the worker because Chrome's main-thread MediaStreamTrackProcessor
   * gets rate-limited by main-thread congestion and `drawImage` of a
   * VideoFrame is GPU-readback-slow. The worker version, per spec, is
   * not gated by main-thread work and gets the camera's full frame
   * rate. The main thread receives encoded JPEG bytes via postMessage
   * and ships them via sendModuleData (the Holochain client lives on
   * the main thread).
   */
  private worker: Worker | null = null;
  private seq = 0;

  /**
   * Inter-frame period in ms for the capture loop. Settable via
   * `setFps()`. Total clip duration is CAPTURE_FRAMES × this. The
   * receiver echoes the same period on each frame so playback animates
   * at the original rate.
   */
  private _capturePeriodMs = DEFAULT_CAPTURE_PERIOD_MS;

  // ----- receive side -----
  private peers = new Map<string, PeerFilmstripState>();
  /**
   * Subscriber callback receives `FilmstripFrame` on each new clip and
   * `null` when the sender has explicitly stopped or the inactivity TTL
   * has fired — receivers use null to clear their display.
   */
  private subscribers = new Map<string, Set<(frame: FilmstripFrame | null) => void>>();

  // ----- per-peer carrier stats -----

  /**
   * Wall-clock ms of the last filmstrip clip we sent TO this peer.
   * Updated in the pump per peer. Mirrors VoiceController.peerLastSentMs.
   */
  peerLastSentMs = new Map<string, number>();

  /**
   * Wall-clock ms of the last filmstrip clip we received FROM this peer.
   * Updated in receiveFrame.
   */
  peerLastRecvMs = new Map<string, number>();

  /**
   * Per-peer signals-video stats. Updated by `receiveFrame` on a ~1 s
   * rolling window. The stats panel reads this map; peer-filmstrip
   * elements publish their buffer depth here via `setBufferDepth`.
   */
  signalsVideoStats = new Map<string, VideoSignalsStats>();

  /**
   * Update the buffer-depth field of a peer's stats. Called by the
   * peer-filmstrip element when its queue grows or drains, so the
   * stats panel can surface it without polling the element.
   */
  setBufferDepth(agentPubKeyB64: string, depth: number): void {
    const existing: VideoSignalsStats = this.signalsVideoStats.get(agentPubKeyB64) ?? {
      jitterMs: null, lossPercent: null, kbps: null, fpsActual: null,
      bufferDepth: null, transitMs: null,
    };
    existing.bufferDepth = depth;
    this.signalsVideoStats.set(agentPubKeyB64, existing);
  }

  bind(store: StreamsStore) {
    this.store = store;
  }

  unbind() {
    this.stopCapture().catch(() => {});
    for (const [, state] of this.peers) {
      if (state.inactivityTimer !== null) {
        window.clearTimeout(state.inactivityTimer);
        state.inactivityTimer = null;
      }
      if (state.latest) {
        try { URL.revokeObjectURL(state.latest.url); } catch {}
      }
    }
    this.peers.clear();
    this.subscribers.clear();
    this.peerLastSentMs.clear();
    this.peerLastRecvMs.clear();
    this.signalsVideoStats.clear();
    this.store = null;
  }

  // ----- send side --------------------------------------------------------

  async startCapture(): Promise<boolean> {
    if (!this.store) return false;
    if (this.cameraHandle) return true;

    const handle = await this.store.cameraSource.acquire({
      id: 'video-filmstrip',
      onTrackChanged: (newTrack) => {
        this._sendTrackToWorker(newTrack);
      },
    });
    if (!handle) {
      console.error('video-filmstrip: cameraSource.acquire failed');
      return false;
    }
    this.cameraHandle = handle;

    // Hint to Chrome that this is real-time motion video. Default is
    // unset; setting 'motion' biases the pipeline toward smooth frame
    // rate over per-frame quality.
    try { (handle.track as any).contentHint = 'motion'; } catch {}

    // Diagnostic — what did the camera negotiate?
    try {
      const settings = handle.track.getSettings?.();
      console.log('[filmstrip tx] track settings:', settings);
    } catch {}

    if (!this._spawnWorker()) {
      try { handle.release(); } catch {}
      this.cameraHandle = null;
      return false;
    }
    this._sendTrackToWorker(handle.track);
    return true;
  }

  private _spawnWorker(): boolean {
    try {
      this.worker = new Worker(
        new URL('./filmstrip-worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.worker.onmessage = (e) => this._onWorkerMessage(e);
      this.worker.onerror = (e) => {
        console.error('video-filmstrip worker error:', e.message);
      };
      return true;
    } catch (e) {
      console.error('video-filmstrip: failed to spawn worker', e);
      return false;
    }
  }

  /**
   * Build a MediaStreamTrackProcessor on the main thread (where the
   * track lives) and transfer just the readable stream of VideoFrames
   * to the worker. MediaStreamTrack itself isn't transferable in many
   * Chromium versions without a feature flag, but ReadableStream is
   * universally transferable. The throttling we were trying to avoid
   * was caused by main-thread *consumption* of the readable, not its
   * creation — the worker draining it solves that.
   */
  private _sendTrackToWorker(track: MediaStreamTrack): void {
    if (!this.worker) return;
    const g: any = globalThis as any;
    if (!g.MediaStreamTrackProcessor) {
      console.error('video-filmstrip: MediaStreamTrackProcessor not available');
      return;
    }
    let processor: any;
    try {
      processor = new g.MediaStreamTrackProcessor({ track, maxBufferSize: 30 });
    } catch (e) {
      console.error('video-filmstrip: failed to create MediaStreamTrackProcessor', e);
      return;
    }
    const readable: ReadableStream = processor.readable;
    this.worker.postMessage(
      {
        type: 'start',
        readable,
        capturePeriodMs: this._capturePeriodMs,
      },
      [readable as unknown as Transferable]
    );
  }

  private _onWorkerMessage(e: MessageEvent): void {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'clip':
        this._handleClipFromWorker(msg);
        break;
      case 'stats':
        console.log(
          `[filmstrip tx] clips/s=${msg.clipsPerSec.toFixed(2)} ` +
          `bw=${msg.kbps.toFixed(1)}kbps cycle=${msg.cycleMs.toFixed(0)}ms ` +
          `reads=${msg.reads.toFixed(1)}/s ` +
          `avgGap=${msg.avgGapMs.toFixed(0)}ms maxGap=${msg.maxGapMs.toFixed(0)}ms`
        );
        break;
      case 'trackSettings':
        console.log('[filmstrip tx] track settings:', msg.settings);
        break;
      case 'error':
        console.error('[filmstrip worker]', msg.message);
        break;
    }
  }

  private _handleClipFromWorker(msg: {
    bytes: ArrayBuffer;
    w: number; h: number; n: number; p: number;
    capturedAt: number;
  }): void {
    if (!this.store) return;
    const targets = get(this.store._signalsTargets);
    if (targets.size === 0) return;

    const buf = new Uint8Array(msg.bytes);
    const payload: FilmstripClipPayload = {
      seq: this.seq++,
      ts: msg.capturedAt,
      w: msg.w, h: msg.h, n: msg.n, p: msg.p,
      data: bytesToBase64(buf),
    };
    const sentAt = Date.now();
    for (const peer of targets) {
      this.peerLastSentMs.set(peer, sentAt);
    }
    this.store
      .sendModuleData('video-filmstrip', JSON.stringify(payload), targets)
      .catch(() => {});
  }

  /**
   * Get the current sender frame rate in fps. Reciprocal of the
   * inter-frame period.
   */
  getFps(): FilmstripFps {
    const fps = Math.round(1000 / this._capturePeriodMs) as FilmstripFps;
    return (FILMSTRIP_FPS_OPTIONS as readonly number[]).includes(fps)
      ? fps
      : 4;
  }

  /**
   * Set the sender frame rate. Takes effect on the next clip — the
   * worker reads the period fresh per clip and tells the next sample
   * apart from the previous by absolute wall-clock time, so changes
   * apply at the next clip boundary (≤ 1 s).
   */
  setFps(fps: FilmstripFps): void {
    if (!(FILMSTRIP_FPS_OPTIONS as readonly number[]).includes(fps)) return;
    this._capturePeriodMs = Math.round(1000 / fps);
    if (this.worker) {
      this.worker.postMessage({
        type: 'setFps',
        capturePeriodMs: this._capturePeriodMs,
      });
    }
  }

  async stopCapture(): Promise<void> {
    // Send an explicit stop payload to peers we've been transmitting
    // to, so they clear their display immediately rather than waiting
    // for the inactivity TTL to fire.
    if (this.store && this.peerLastSentMs.size > 0) {
      const recentTargets = new Set(this.peerLastSentMs.keys());
      const stopPayload: FilmstripStopPayload = {
        kind: 'stop',
        seq: this.seq++,
        ts: Date.now(),
      };
      this.store
        .sendModuleData('video-filmstrip', JSON.stringify(stopPayload), recentTargets)
        .catch(() => {});
    }
    this.peerLastSentMs.clear();

    // Tell the worker to stop, then terminate it. terminate() is
    // synchronous and abruptly kills the worker, which is fine — the
    // 'stop' message gives it a chance to cancel any in-flight read()
    // cleanly first.
    if (this.worker) {
      try { this.worker.postMessage({ type: 'stop' }); } catch {}
      try { this.worker.terminate(); } catch {}
      this.worker = null;
    }
    if (this.cameraHandle) {
      try { this.cameraHandle.release(); } catch {}
      this.cameraHandle = null;
    }
    this.seq = 0;
  }


  // ----- receive side -----------------------------------------------------

  receiveFrame(agentPubKeyB64: string, chunk: string): void {
    let payload: FilmstripPayload;
    try {
      payload = JSON.parse(chunk);
    } catch {
      return;
    }

    let state = this.peers.get(agentPubKeyB64);
    if (!state) {
      state = {
        latest: null,
        lastSeq: 0,
        lastArrivalMs: 0,
        jitterEwma: 0,
        transitEwma: 0,
        bytesReceived: 0,
        clipsReceived: 0,
        clipsLost: 0,
        windowStartMs: Date.now(),
        inactivityTimer: null,
      };
      this.peers.set(agentPubKeyB64, state);
    }
    if (payload.seq <= state.lastSeq && state.lastSeq !== 0) {
      // out-of-order or duplicate; cheap drop
      return;
    }

    // Explicit stop signal — sender turned video off. Clear the
    // display immediately rather than waiting for the inactivity TTL.
    if (payload.kind === 'stop') {
      state.lastSeq = payload.seq;
      this._clearPeerDisplay(agentPubKeyB64);
      return;
    }

    const now = Date.now();
    this.peerLastRecvMs.set(agentPubKeyB64, now);

    // --- stats accounting ---
    // Loss: any seq gap > 0 implies missed clips.
    if (state.lastSeq !== 0) {
      const gap = payload.seq - state.lastSeq - 1;
      if (gap > 0) state.clipsLost += gap;
    }
    state.clipsReceived += 1;

    // Jitter: EWMA of |inter-arrival - CLIP_TARGET_MS| where CLIP_TARGET_MS
    // is the sender's nominal cadence. alpha = 0.2 — slightly faster
    // smoothing than voice's 0.1 because video clips are 50× slower so
    // we have far fewer samples per second to integrate.
    if (state.lastArrivalMs > 0) {
      const interval = now - state.lastArrivalMs;
      const deviation = Math.abs(interval - CLIP_TARGET_MS);
      state.jitterEwma = 0.2 * deviation + 0.8 * state.jitterEwma;
    }
    state.lastArrivalMs = now;

    // Transit time: how long the signal took from sender's send to
    // receiver's onData. Both Date.now() values are wall-clock — on the
    // same machine the clocks are identical so this is approximately
    // the conductor's signal-routing latency. EWMA at alpha = 0.2.
    const transit = now - payload.ts;
    state.transitEwma = state.transitEwma === 0
      ? transit
      : 0.2 * transit + 0.8 * state.transitEwma;

    state.lastSeq = payload.seq;

    const bytes = base64ToBytes(payload.data);
    state.bytesReceived += bytes.byteLength;
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);

    // Publish stats on a ~1 s cadence. With clip cadence ~1 s, this
    // window captures roughly one clip arrival per emission.
    if (now - state.windowStartMs >= 1000 && this.store) {
      const elapsedMs = now - state.windowStartMs;
      const total = state.clipsReceived + state.clipsLost;
      const loss = total > 0 ? (state.clipsLost / total) * 100 : 0;
      const kbps = (state.bytesReceived * 8) / elapsedMs;
      const fpsActual = (state.clipsReceived * payload.n * 1000) / elapsedMs;
      const stats: VideoSignalsStats = {
        jitterMs: Math.round(state.jitterEwma * 10) / 10,
        lossPercent: Math.round(loss * 10) / 10,
        kbps: Math.round(kbps * 10) / 10,
        fpsActual: Math.round(fpsActual * 10) / 10,
        bufferDepth:
          this.signalsVideoStats.get(agentPubKeyB64)?.bufferDepth ?? null,
        transitMs: Math.round(state.transitEwma * 10) / 10,
      };
      this.signalsVideoStats.set(agentPubKeyB64, stats);
      // Also log so a user testing in DevTools can see the numbers
      // without wiring up the panel yet. One line per peer per second.
      console.log(
        `[filmstrip rx ${agentPubKeyB64.slice(0, 8)}] ` +
        `jitter=${stats.jitterMs}ms transit=${stats.transitMs}ms ` +
        `loss=${stats.lossPercent}% ` +
        `bw=${stats.kbps}kbps fps=${stats.fpsActual} ` +
        `buf=${stats.bufferDepth ?? '-'}`
      );
      state.bytesReceived = 0;
      state.clipsReceived = 0;
      state.clipsLost = 0;
      state.windowStartMs = now;
    }

    // Revoke prior URL after a short delay (in case any consumer is
    // mid-read on the old one).
    if (state.latest) {
      const oldUrl = state.latest.url;
      setTimeout(() => {
        try { URL.revokeObjectURL(oldUrl); } catch {}
      }, URL_REVOKE_DELAY_MS);
    }

    const frame: FilmstripFrame = {
      url,
      width: payload.w,
      height: payload.h,
      frameCount: payload.n,
      periodMs: payload.p,
      receivedAt: Date.now(),
    };
    state.latest = frame;

    // Reset the inactivity TTL on every clip arrival. If the sender
    // genuinely stops without sending an explicit stop payload (e.g.
    // tab closed unexpectedly), the timer fires and clears the display.
    if (state.inactivityTimer !== null) {
      window.clearTimeout(state.inactivityTimer);
    }
    state.inactivityTimer = window.setTimeout(() => {
      this._clearPeerDisplay(agentPubKeyB64);
    }, RECEIVE_INACTIVITY_TTL_MS);

    const subs = this.subscribers.get(agentPubKeyB64);
    if (subs) {
      for (const cb of subs) {
        try { cb(frame); } catch (e) {
          console.error('video-filmstrip: subscriber callback threw', e);
        }
      }
    }
  }

  /**
   * Clear the receiver-side display state for a peer and notify
   * subscribers with `null`. Called on explicit stop payloads and on
   * inactivity TTL.
   *
   * Also resets seq + jitter tracking so that when the sender restarts
   * (its pump resets `seq` to 0 in stopCapture), incoming clips with
   * seq=0,1,2,… aren't dropped by the dedup check
   * `payload.seq <= state.lastSeq`. Stats counters are reset too so the
   * first new window doesn't include a phantom 1-second gap left over
   * from the stop.
   */
  private _clearPeerDisplay(agentPubKeyB64: string): void {
    const state = this.peers.get(agentPubKeyB64);
    if (!state) return;
    if (state.inactivityTimer !== null) {
      window.clearTimeout(state.inactivityTimer);
      state.inactivityTimer = null;
    }
    if (state.latest) {
      const oldUrl = state.latest.url;
      setTimeout(() => {
        try { URL.revokeObjectURL(oldUrl); } catch {}
      }, URL_REVOKE_DELAY_MS);
      state.latest = null;
    }
    state.lastSeq = 0;
    state.lastArrivalMs = 0;
    state.jitterEwma = 0;
    state.transitEwma = 0;
    state.bytesReceived = 0;
    state.clipsReceived = 0;
    state.clipsLost = 0;
    state.windowStartMs = Date.now();

    // Drop the published stats so the stats panel hides its video row.
    this.signalsVideoStats.delete(agentPubKeyB64);

    const subs = this.subscribers.get(agentPubKeyB64);
    if (subs) {
      for (const cb of subs) {
        try { cb(null); } catch (e) {
          console.error('video-filmstrip: subscriber callback threw on clear', e);
        }
      }
    }
  }

  /**
   * Subscribe to filmstrip frames for a specific peer. The callback fires
   * once with the latest frame (if any) at subscribe time, and again on
   * every subsequent receive. Returns an unsubscribe function.
   */
  subscribe(
    agentPubKeyB64: string,
    callback: (frame: FilmstripFrame | null) => void,
  ): () => void {
    let set = this.subscribers.get(agentPubKeyB64);
    if (!set) {
      set = new Set();
      this.subscribers.set(agentPubKeyB64, set);
    }
    set.add(callback);
    const state = this.peers.get(agentPubKeyB64);
    if (state?.latest) {
      try { callback(state.latest); } catch (e) {
        console.error('video-filmstrip: replay subscriber callback threw', e);
      }
    }
    return () => {
      const s = this.subscribers.get(agentPubKeyB64);
      if (!s) return;
      s.delete(callback);
      if (s.size === 0) this.subscribers.delete(agentPubKeyB64);
    };
  }

  /** Most recently received filmstrip for a peer, or null. */
  getLatest(agentPubKeyB64: string): FilmstripFrame | null {
    return this.peers.get(agentPubKeyB64)?.latest ?? null;
  }

  /**
   * True iff a filmstrip arrived from this peer within RECEIVE_TTL_MS.
   * Render code uses this to decide whether to show the filmstrip overlay
   * or fall back to the static avatar.
   */
  hasFreshFrame(agentPubKeyB64: string): boolean {
    const latest = this.peers.get(agentPubKeyB64)?.latest;
    if (!latest) return false;
    return Date.now() - latest.receivedAt < RECEIVE_TTL_MS;
  }
}

const controller = new FilmstripController();

export { controller as filmstripController };

function bytesToBase64(bytes: Uint8Array): string {
  // Chunk the conversion to avoid String.fromCharCode call-stack limits
  // on large inputs. Filmstrip blobs are ~20 KB so well within a single
  // chunk, but the guard is essentially free.
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK))
    );
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const filmstripModule: ModuleDefinition = {
  id: 'video-filmstrip',
  type: 'agent',
  label: 'Filmstrip video',
  icon: mdiVideo,
  activationControl: 'sender',

  onData(agentPubKeyB64, chunk) {
    controller.receiveFrame(agentPubKeyB64, chunk);
  },
};

registerModule(filmstripModule);
