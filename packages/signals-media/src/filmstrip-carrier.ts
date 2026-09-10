// Copied from presence ui/src/room/modules/video-filmstrip.ts at ab90584 (signals-media extraction). Presence keeps its own copy until the adoption round.
import { FilmstripSampler } from './filmstrip-sampler.js';
import { bytesToBase64, base64ToBytes } from './base64.js';
import type { FilmstripHost, MediaClock, PeerId, TrackHandle } from './types.js';

/**
 * Filmstrip carrier — sends low-fps JPEG video frames to a host-supplied set
 * of peers over whatever message channel the host owns (Holochain remote
 * signals, a WebSocket, …), as a low-bandwidth fallback where WebRTC video
 * isn't available. Mirrors `VoiceCarrier` for video.
 *
 * Wire format: a JPEG "filmstrip" — N frames stacked vertically into one
 * JPEG ArrayBuffer (the seatcamp pattern). The sender now sends each
 * frame immediately as its own 1-frame clip (n=1): clip batching was
 * the largest structural source of video-behind-audio skew (a frame
 * waited up to a clip length before send), and per-frame signals cost
 * ≤7/sec next to voice's 50/sec. The receive path still handles any N
 * for compatibility with older batching senders.
 *
 * Capture: `host.acquireCamera()` track -> `FilmstripSampler` (`<video>` +
 *          createImageBitmap at the sample period) -> the JPEG worker
 *          (`filmstrip-worker.ts`, OffscreenCanvas drawImage +
 *          convertToBlob('image/jpeg') per frame).
 * Wire   : { seq, ts, w, h, n, p, t0, data(base64) } in JSON via
 *          `host.send('filmstrip', …)`.
 * Play   : URL.createObjectURL on receive; subscribers (a per-peer overlay
 *          element) swap their <img> src and step a CSS background-position
 *          animator at the original sample period.
 *
 * Lifecycle: the receive side is always live once `bind(host)` is called
 * (mirrors voice). The send side is the host's to gate — it calls
 * `startCapture()` only when the user has the camera on AND at least one
 * peer is in `host.targets()`. `stopCapture()` releases the camera handle;
 * the device closes via the host's refcount.
 */

const DEFAULT_CAPTURE_PERIOD_MS = 167; // 6 fps

/** Default clock when unbound; `bind()` adopts the host's. */
const systemClock: MediaClock = { now: () => Date.now() };

/**
 * Sender frame rates a host may expose via setFps(). 8 fps was tested but
 * proved unreliable (the encode pipeline can't keep up consistently
 * once you add receiver-side decode + display); 6 is the tested
 * reliable ceiling and the default. 7 is exposed as a single step
 * above it for experimentation, staying below the known-bad 8.
 */
export const FILMSTRIP_FPS_OPTIONS = [1, 2, 3, 4, 5, 6, 7] as const;
export type FilmstripFps = typeof FILMSTRIP_FPS_OPTIONS[number];

/**
 * Sender capture resolutions (square, in pixels per frame). Larger =
 * crisper image but more bytes/sec on the wire. A receiver's size
 * slider interpolates display size between the capture size and the
 * full pane, so larger captures stay crisp when scaled up.
 */
export const FILMSTRIP_CAPTURE_SIZES = [48, 64, 96, 128, 160, 192, 256] as const;
export type FilmstripCaptureSize = typeof FILMSTRIP_CAPTURE_SIZES[number];

const DEFAULT_CAPTURE_SIDE = 192;

/** Where the worker lives when the host does not override `createWorker`. */
const defaultWorker = (): Worker =>
  new Worker(new URL('./filmstrip-worker.js', import.meta.url), {
    type: 'module',
  });

/**
 * Delay before revoking a swapped-out blob URL. Must be safely larger
 * than the clip cadence and any reasonable JS event-loop hiccup,
 * otherwise the OLD URL can be revoked before the receiver has applied
 * the NEW bg-image, leaving the strip pointed at a now-dead URL —
 * visible as an avatar flash through the (transparent) host. With
 * per-frame clips (~7/s of a few KB each) 10 s keeps ≤ ~70 small blobs
 * alive — a few hundred KB, negligible.
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
  /**
   * Sender wall-clock ms when the clip's FIRST frame was captured, so
   * frame i's capture time is t0 + i*p on the same sender clock that
   * voice frames stamp as `wts` — the shared timebase for receiver-side
   * A/V skew measurement. Absent on legacy senders (receivers fall back
   * to deriving it from `ts`).
   */
  t0?: number;
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
 * the avatar shows through). 5 s is far longer than any clip cadence
 * (≤1 s even at 1 fps) + reasonable jitter, so this only fires when the sender
 * has actually stopped (without managing to send a stop signal — e.g.
 * the sender's tab crashed). Normal stops use the explicit stop
 * payload and clear immediately.
 *
 * This is a display-hold TTL, not a liveness window: liveness is the
 * host's business (Presence: MEDIA_LIVE_WINDOW_MS in presence-policy.ts).
 * It is deliberately longer than that window so the last frame doesn't
 * flicker to the avatar at normal clip cadence.
 */
const RECEIVE_INACTIVITY_TTL_MS = 5000;

/**
 * How often (at most) the receive side writes one `FilmstripRx` stats
 * line per peer into the host's log sink. A reporting cadence, NOT a
 * liveness window: it exists purely to bound log volume, the same role
 * as VoicePlayoutReset's 2 s throttle in voice-carrier.ts. Motivating
 * gap (2026-08-25 field diagnosis): the rx stats were console.log-only,
 * so exported logs could not answer "was video still flowing from this
 * peer?" during an audio outage.
 */
export const FILMSTRIP_RX_LOG_INTERVAL_MS = 30_000;

export interface FilmstripFrame {
  /** Blob URL of the JPEG filmstrip. Revoked ~10 s after replacement. */
  url: string;
  width: number;
  height: number;
  frameCount: number;
  periodMs: number;
  /**
   * Sender wall-clock ms of the clip's first frame capture (frame i was
   * captured at captureT0Ms + i*periodMs). Derived from ts on legacy
   * clips without t0.
   */
  captureT0Ms: number;
}

interface PeerFilmstripState {
  latest: FilmstripFrame | null;
  lastSeq: number;
  /** Wall-clock ms of the previous arrival (for inter-arrival jitter). */
  lastArrivalMs: number;
  /** EWMA of |inter-arrival - nominal clip span (n × p)|, in ms. */
  jitterEwma: number;
  /** EWMA of (Date.now() - payload.ts), in ms — channel transit time. */
  transitEwma: number;
  /** Bytes received in the current rolling window. */
  bytesReceived: number;
  /** Clips received in the current rolling window. */
  clipsReceived: number;
  /** Clips inferred lost (seq gaps) in the current rolling window. */
  clipsLost: number;
  /** Wall-clock ms of the rolling window start. */
  windowStartMs: number;
  /**
   * Inactivity TTL timer — clears the display if no clip arrives in time.
   * Typed off `setTimeout` itself rather than as `number` because the
   * package typechecks with and without the Node globals in scope (the test
   * config pulls them in via vitest).
   */
  inactivityTimer: ReturnType<typeof globalThis.setTimeout> | null;
}

/**
 * Per-peer signals-video stats. Updated by the receive side on a 1 s
 * rolling window. Read by a host's stats surface.
 */
export interface VideoSignalsStats {
  /** EWMA of clip inter-arrival deviation from the nominal span (n × p), ms. */
  jitterMs: number | null;
  /** Loss percent over the rolling window (0–100). */
  lossPercent: number | null;
  /** Bandwidth over the rolling window, kilobits per second. */
  kbps: number | null;
  /** Effective frames-per-second (clips/sec × frames/clip) at receive. */
  fpsActual: number | null;
  /** Receiver-side queue depth (frames buffered, set by the display element). */
  bufferDepth: number | null;
  /**
   * EWMA of channel transit time (`Date.now() - payload.ts`), in ms.
   * On a single machine this is approximately the time from the sender's
   * `host.send` call to the receiver's `receiveFrame`. Diagnostic for
   * pinpointing whether the sender pump or the message channel is the
   * bottleneck.
   */
  transitMs: number | null;
  /**
   * Audio/video skew in ms on the SENDER's timebase, measured at frame
   * display time by the display element: (sender-time of the audio
   * currently audible) − (sender capture time of the video frame being
   * shown). Positive = video lags audio. Null when no anchored audio is
   * flowing (peer muted, voice idle, or a legacy sender without
   * timestamps).
   */
  avSkewMs: number | null;
}

export class FilmstripCarrier {
  private host: FilmstripHost | null = null;

  /** Host clock while bound (see bind()); wall clock otherwise. */
  private _clock: MediaClock = systemClock;

  // ----- send side -----
  private cameraHandle: TrackHandle | null = null;

  /**
   * Web Worker hosting the JPEG encode. We delegate the encode to a
   * worker because `convertToBlob` on the main thread competes with
   * voice's 50/sec encode and the UI render. The sample loop itself
   * lives on the main thread (`FilmstripSampler`) because the portable
   * way to sample a track — a `<video>` element — needs a document. The
   * main thread receives encoded JPEG bytes via postMessage and ships
   * them via `host.send` (the message channel is the host's, on the main
   * thread).
   */
  private worker: Worker | null = null;

  /** The portable capture pump; see filmstrip-sampler.ts. */
  private sampler = new FilmstripSampler();

  private seq = 0;

  /**
   * Inter-frame period in ms for the capture loop. Settable via
   * `setFps()`. The receiver echoes the same period on each frame so
   * playback animates at the original rate.
   */
  private _capturePeriodMs = DEFAULT_CAPTURE_PERIOD_MS;

  /**
   * Square edge length (px) of each captured frame. Settable via
   * `setCaptureSide()`. Larger = crisper picture but more bytes per
   * clip; should be tuned to network conditions.
   */
  private _captureSide: number = DEFAULT_CAPTURE_SIDE;

  // ----- receive side -----
  private peers = new Map<PeerId, PeerFilmstripState>();
  /**
   * Subscriber callback receives `FilmstripFrame` on each new clip and
   * `null` when the sender has explicitly stopped or the inactivity TTL
   * has fired — receivers use null to clear their display.
   */
  private subscribers = new Map<PeerId, Set<(frame: FilmstripFrame | null) => void>>();

  // ----- per-peer carrier stats -----

  /**
   * Host-clock ms of the last filmstrip clip we sent TO this peer.
   * Updated per send, per peer. Mirrors VoiceCarrier.peerLastSentMs.
   */
  peerLastSentMs = new Map<PeerId, number>();

  /**
   * Host-clock ms of the last filmstrip clip we received FROM this peer.
   * Updated in receiveFrame.
   */
  peerLastRecvMs = new Map<PeerId, number>();

  /**
   * Wall-clock ms of the last `FilmstripRx` log line per peer —
   * throttle state for `FILMSTRIP_RX_LOG_INTERVAL_MS`. Wall-clock like
   * the stats windows it summarizes, not the host clock.
   */
  private lastRxLogMs = new Map<PeerId, number>();

  /**
   * Per-peer signals-video stats. Updated by `receiveFrame` on a ~1 s
   * rolling window. A host's stats surface reads this map; display
   * elements publish their buffer depth here via `setBufferDepth`.
   */
  signalsVideoStats = new Map<PeerId, VideoSignalsStats>();

  /**
   * Update the buffer-depth field of a peer's stats. Called by the
   * display element when its queue grows or drains, so a stats surface
   * can surface it without polling the element.
   */
  setBufferDepth(peer: PeerId, depth: number): void {
    const existing = this._statsFor(peer);
    existing.bufferDepth = depth;
    this.signalsVideoStats.set(peer, existing);
  }

  /**
   * Update the A/V-skew field of a peer's stats. Called by the display
   * element each time it displays a frame while anchored audio is
   * flowing (see VideoSignalsStats.avSkewMs).
   */
  setAvSkew(peer: PeerId, skewMs: number | null): void {
    const existing = this._statsFor(peer);
    existing.avSkewMs = skewMs === null ? null : Math.round(skewMs);
    this.signalsVideoStats.set(peer, existing);
  }

  private _statsFor(peer: PeerId): VideoSignalsStats {
    return this.signalsVideoStats.get(peer) ?? {
      jitterMs: null, lossPercent: null, kbps: null, fpsActual: null,
      bufferDepth: null, transitMs: null, avSkewMs: null,
    };
  }

  bind(host: FilmstripHost) {
    this.host = host;
    // Presence-relevant stamps (peerLastRecvMs) share the host's clock so
    // the host's freshness comparisons read the same timebase.
    // Wire-timestamp arithmetic (jitter/transit vs the sender's payload.ts)
    // and the display-hold TTL deliberately stay on wall-clock timers.
    this._clock = host.clock;
  }

  unbind() {
    this.stopCapture().catch(() => {});
    for (const [, state] of this.peers) {
      if (state.inactivityTimer !== null) {
        globalThis.clearTimeout(state.inactivityTimer);
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
    this.lastRxLogMs.clear();
    this.signalsVideoStats.clear();
    this.host = null;
    this._clock = systemClock;
  }

  get isBound(): boolean {
    return this.host !== null;
  }

  // ----- send side --------------------------------------------------------

  async startCapture(): Promise<boolean> {
    if (!this.host) return false;
    if (this.cameraHandle) return true;

    const handle = await this.host.acquireCamera((newTrack: MediaStreamTrack) => {
      this.sampler.replaceTrack(newTrack);
    });
    if (!handle) {
      console.error('filmstrip: acquireCamera failed');
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

    const ok = await this.sampler.start(
      handle.track,
      this._capturePeriodMs,
      (bitmap, t0) => this._postFrameToWorker(bitmap, t0)
    );
    if (!ok) {
      // The sampler logged why. Unwind rather than leaving the camera
      // open behind a pump that will never produce a frame.
      console.error('filmstrip: sampler failed to start');
      await this.stopCapture();
      return false;
    }
    return true;
  }

  private _postFrameToWorker(bitmap: ImageBitmap, t0: number): void {
    if (!this.worker) {
      try { bitmap.close(); } catch {}
      return;
    }
    this.worker.postMessage(
      {
        type: 'frame',
        bitmap,
        t0,
        capturePeriodMs: this._capturePeriodMs,
        captureSide: this._captureSide,
      },
      [bitmap]
    );
  }

  private _spawnWorker(): boolean {
    try {
      this.worker = this.host?.createWorker?.() ?? defaultWorker();
      this.worker.onmessage = (e) => this._onWorkerMessage(e);
      this.worker.onerror = (e) => {
        console.error('filmstrip worker error:', e.message);
      };
      return true;
    } catch (e) {
      console.error('filmstrip: failed to spawn worker', e);
      return false;
    }
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
          `bw=${msg.kbps.toFixed(1)}kbps cycle=${msg.cycleMs.toFixed(0)}ms`
        );
        break;
      case 'error':
        console.error('[filmstrip worker]', msg.message);
        break;
    }
  }

  private _handleClipFromWorker(msg: {
    bytes: ArrayBuffer;
    w: number; h: number; n: number; p: number;
    t0: number;
    capturedAt: number;
  }): void {
    if (!this.host) return;
    const targets = this.host.targets();
    if (targets.size === 0) return;
    // Cadence gate (`decideSignalsMediaCadence`, evaluated by the host):
    // filmstrip is the heaviest signals payload, so clips go out only at
    // 'full' cadence — 'voice-only' and 'paused' both drop them. Gates the
    // SEND only: capture teardown stays the host's to decide.
    if (this.host.cadence() !== 'full') return;

    const buf = new Uint8Array(msg.bytes);
    const payload: FilmstripClipPayload = {
      seq: this.seq++,
      ts: msg.capturedAt,
      w: msg.w, h: msg.h, n: msg.n, p: msg.p,
      t0: msg.t0,
      data: bytesToBase64(buf),
    };
    // Local send stamp on the host's timebase, matching peerLastRecvMs
    // so consumers never compare two clocks (PR #4 F2).
    const sentAt = this._clock.now();
    for (const peer of targets) {
      this.peerLastSentMs.set(peer, sentAt);
    }
    this.host
      .send('filmstrip', JSON.stringify(payload), targets)
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
      : 6;
  }

  /**
   * Set the sender frame rate. The sampler re-arms its interval
   * immediately; the period also rides every frame message, so the
   * worker echoes the new value on the next clip.
   */
  setFps(fps: FilmstripFps): void {
    if (!(FILMSTRIP_FPS_OPTIONS as readonly number[]).includes(fps)) return;
    this._capturePeriodMs = Math.round(1000 / fps);
    this.sampler.setPeriod(this._capturePeriodMs);
  }

  getCaptureSide(): FilmstripCaptureSize {
    const s = this._captureSide as FilmstripCaptureSize;
    return (FILMSTRIP_CAPTURE_SIZES as readonly number[]).includes(s)
      ? s
      : DEFAULT_CAPTURE_SIDE as FilmstripCaptureSize;
  }

  /**
   * Set the sender capture-frame edge length (px). Takes effect on the
   * next frame (the side rides every frame message). Larger = crisper
   * image, more bytes/sec.
   */
  setCaptureSide(side: FilmstripCaptureSize): void {
    if (!(FILMSTRIP_CAPTURE_SIZES as readonly number[]).includes(side)) return;
    this._captureSide = side;
  }

  async stopCapture(): Promise<void> {
    // Send an explicit stop payload to peers we've been transmitting
    // to, so they clear their display immediately rather than waiting
    // for the inactivity TTL to fire. Cadence-gated like the clip send:
    // below 'full' the courtesy stop is skipped (receivers fall back to
    // the TTL) — the condition wraps only the send so the worker/camera
    // teardown below always runs.
    if (
      this.host &&
      this.peerLastSentMs.size > 0 &&
      this.host.cadence() === 'full'
    ) {
      const recentTargets = new Set(this.peerLastSentMs.keys());
      const stopPayload: FilmstripStopPayload = {
        kind: 'stop',
        seq: this.seq++,
        ts: Date.now(),
      };
      this.host
        .send('filmstrip', JSON.stringify(stopPayload), recentTargets)
        .catch(() => {});
    }
    this.peerLastSentMs.clear();

    // Stop sampling before the worker goes away, so no frame message can
    // be posted at a terminated worker.
    this.sampler.stop();

    // Tell the worker to stop, then terminate it. terminate() is
    // synchronous and abruptly kills the worker, which is fine — the
    // 'stop' message gives it a chance to drop its canvas cleanly first.
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

  receiveFrame(peer: PeerId, chunk: string): void {
    let payload: FilmstripPayload;
    try {
      payload = JSON.parse(chunk);
    } catch {
      return;
    }

    let state = this.peers.get(peer);
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
      this.peers.set(peer, state);
    }
    if (payload.seq <= state.lastSeq && state.lastSeq !== 0) {
      // out-of-order or duplicate; cheap drop
      return;
    }

    // Explicit stop signal — sender turned video off. Clear the
    // display immediately rather than waiting for the inactivity TTL.
    if (payload.kind === 'stop') {
      state.lastSeq = payload.seq;
      this._clearPeerDisplay(peer);
      return;
    }

    const now = Date.now();
    this.peerLastRecvMs.set(peer, this._clock.now());

    // --- stats accounting ---
    // Loss: any seq gap > 0 implies missed clips.
    if (state.lastSeq !== 0) {
      const gap = payload.seq - state.lastSeq - 1;
      if (gap > 0) state.clipsLost += gap;
    }
    state.clipsReceived += 1;

    // Jitter: EWMA of |inter-arrival - nominal cadence|, where the
    // nominal cadence is this clip's actual span (n × p — at very low
    // fps a clip is longer than CLIP_TARGET_MS because frame count is
    // floored at 1). alpha = 0.2 — slightly faster smoothing than
    // voice's 0.1 because video clips are far slower so we have fewer
    // samples per second to integrate.
    if (state.lastArrivalMs > 0) {
      const interval = now - state.lastArrivalMs;
      const nominalMs = payload.n * payload.p;
      const deviation = Math.abs(interval - nominalMs);
      state.jitterEwma = 0.2 * deviation + 0.8 * state.jitterEwma;
    }
    state.lastArrivalMs = now;

    // Transit time: how long the signal took from the sender's send to
    // the receiver's receiveFrame. Both Date.now() values are wall-clock —
    // on the same machine the clocks are identical so this is
    // approximately the message channel's routing latency. EWMA at
    // alpha = 0.2.
    const transit = now - payload.ts;
    state.transitEwma = state.transitEwma === 0
      ? transit
      : 0.2 * transit + 0.8 * state.transitEwma;

    state.lastSeq = payload.seq;

    const bytes = base64ToBytes(payload.data);
    state.bytesReceived += bytes.byteLength;
    // The cast is TypeScript's, not the runtime's: since TS 5.7 `Uint8Array`
    // is generic over `ArrayBufferLike` while `BlobPart` admits only
    // `ArrayBufferView<ArrayBuffer>`. `base64ToBytes` always allocates a
    // plain ArrayBuffer.
    const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);

    // Publish stats on a ~1 s cadence (one window per ~fps clip
    // arrivals with per-frame clips).
    if (now - state.windowStartMs >= 1000 && this.host) {
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
          this.signalsVideoStats.get(peer)?.bufferDepth ?? null,
        transitMs: Math.round(state.transitEwma * 10) / 10,
        avSkewMs:
          this.signalsVideoStats.get(peer)?.avSkewMs ?? null,
      };
      this.signalsVideoStats.set(peer, stats);
      // Also log so a user testing in DevTools can see the numbers
      // without wiring up a stats surface yet. One line per peer per
      // second.
      console.log(
        `[filmstrip rx ${peer.slice(0, 8)}] ` +
        `jitter=${stats.jitterMs}ms transit=${stats.transitMs}ms ` +
        `loss=${stats.lossPercent}% ` +
        `bw=${stats.kbps}kbps fps=${stats.fpsActual} ` +
        `buf=${stats.bufferDepth ?? '-'} ` +
        `avSkew=${stats.avSkewMs ?? '-'}ms`
      );
      // Also write a throttled line into the host's log sink so exported
      // diagnostics can answer "was signals video flowing from this
      // peer?" directly — the console line above never leaves DevTools.
      const lastRxLog = this.lastRxLogMs.get(peer);
      if (
        lastRxLog === undefined ||
        now - lastRxLog >= FILMSTRIP_RX_LOG_INTERVAL_MS
      ) {
        this.lastRxLogMs.set(peer, now);
        this.host.log(
          `FilmstripRx [${peer.slice(0, 8)}] ` +
          `fps=${stats.fpsActual} bw=${stats.kbps}kbps ` +
          `loss=${stats.lossPercent}% jitter=${stats.jitterMs}ms ` +
          `transit=${stats.transitMs}ms`,
        );
      }
      state.bytesReceived = 0;
      state.clipsReceived = 0;
      state.clipsLost = 0;
      state.windowStartMs = now;
    }

    // Revoke prior URL after a short delay (in case any consumer is
    // mid-read on the old one).
    if (state.latest) {
      const oldUrl = state.latest.url;
      globalThis.setTimeout(() => {
        try { URL.revokeObjectURL(oldUrl); } catch {}
      }, URL_REVOKE_DELAY_MS);
    }

    const frame: FilmstripFrame = {
      url,
      width: payload.w,
      height: payload.h,
      frameCount: payload.n,
      periodMs: payload.p,
      // Legacy clips lack t0; their ts is stamped at clip end, so the
      // first frame was captured ~ (n-1) periods earlier.
      captureT0Ms: payload.t0 ?? payload.ts - (payload.n - 1) * payload.p,
    };
    state.latest = frame;

    // Reset the inactivity TTL on every clip arrival. If the sender
    // genuinely stops without sending an explicit stop payload (e.g.
    // tab closed unexpectedly), the timer fires and clears the display.
    if (state.inactivityTimer !== null) {
      globalThis.clearTimeout(state.inactivityTimer);
    }
    state.inactivityTimer = globalThis.setTimeout(() => {
      this._clearPeerDisplay(peer);
    }, RECEIVE_INACTIVITY_TTL_MS);

    const subs = this.subscribers.get(peer);
    if (subs) {
      for (const cb of subs) {
        try { cb(frame); } catch (e) {
          console.error('filmstrip: subscriber callback threw', e);
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
  private _clearPeerDisplay(peer: PeerId): void {
    const state = this.peers.get(peer);
    if (!state) return;
    if (state.inactivityTimer !== null) {
      globalThis.clearTimeout(state.inactivityTimer);
      state.inactivityTimer = null;
    }
    if (state.latest) {
      const oldUrl = state.latest.url;
      globalThis.setTimeout(() => {
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

    // Drop the published stats so a stats surface hides its video row.
    this.signalsVideoStats.delete(peer);

    const subs = this.subscribers.get(peer);
    if (subs) {
      for (const cb of subs) {
        try { cb(null); } catch (e) {
          console.error('filmstrip: subscriber callback threw on clear', e);
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
    peer: PeerId,
    callback: (frame: FilmstripFrame | null) => void,
  ): () => void {
    let set = this.subscribers.get(peer);
    if (!set) {
      set = new Set();
      this.subscribers.set(peer, set);
    }
    set.add(callback);
    const state = this.peers.get(peer);
    if (state?.latest) {
      try { callback(state.latest); } catch (e) {
        console.error('filmstrip: replay subscriber callback threw', e);
      }
    }
    return () => {
      const s = this.subscribers.get(peer);
      if (!s) return;
      s.delete(callback);
      if (s.size === 0) this.subscribers.delete(peer);
    };
  }

  /** Most recently received filmstrip for a peer, or null. */
  getLatest(peer: PeerId): FilmstripFrame | null {
    return this.peers.get(peer)?.latest ?? null;
  }
}
