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

// Square capture (source center-cropped to a square) so the frame fits
// the square peer pane without aspect-ratio distortion. A 4:3 source
// shown in a 1:1 container would otherwise vertically stretch the face
// when the strip's background-size is set to 100% × N*100%.
const CAPTURE_SIDE = 96;
const CAPTURE_WIDTH = CAPTURE_SIDE;
const CAPTURE_HEIGHT = CAPTURE_SIDE;
const DEFAULT_CAPTURE_PERIOD_MS = 250; // 4 fps
const JPEG_QUALITY = 0.6;

/**
 * Target clip cadence — one filmstrip is sent roughly every CLIP_TARGET_MS,
 * regardless of fps. The number of frames per clip equals fps (so 1 fps =
 * 1-frame snapshot per second; 8 fps = 8 frames in a 1 s loop). Keeping
 * clip cadence ~constant is what makes low fps feel near-real-time
 * instead of "8 s of buffered footage every 8 s".
 */
const CLIP_TARGET_MS = 1000;

/** Sender frame rates the UI exposes via setFps(). */
export const FILMSTRIP_FPS_OPTIONS = [1, 2, 4, 8] as const;
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

interface FilmstripPayload {
  seq: number;
  ts: number; // wall-clock ms when sent
  w: number;  // single-frame width
  h: number;  // single-frame height
  n: number;  // frame count
  p: number;  // playback period ms
  data: string; // base64-encoded JPEG filmstrip
}

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
}

class FilmstripController {
  private store: StreamsStore | null = null;

  // ----- send side -----
  private cameraHandle: CameraAcquireResult | null = null;
  private captureVideo: HTMLVideoElement | null = null;
  /**
   * Monotonic generation counter for the capture pipeline. Bumped on
   * every (re)build — start, stop, device change. The pump loop captures
   * its generation on entry and exits when the counter moves out from
   * under it. Same defense voice.ts uses against overlapping pump loops.
   */
  private pipelineGeneration = 0;
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
  private subscribers = new Map<string, Set<(frame: FilmstripFrame) => void>>();

  bind(store: StreamsStore) {
    this.store = store;
  }

  unbind() {
    this.stopCapture().catch(() => {});
    for (const [, state] of this.peers) {
      if (state.latest) {
        try { URL.revokeObjectURL(state.latest.url); } catch {}
      }
    }
    this.peers.clear();
    this.subscribers.clear();
    this.store = null;
  }

  // ----- send side --------------------------------------------------------

  async startCapture(): Promise<boolean> {
    if (!this.store) return false;
    if (this.cameraHandle) return true;

    const handle = await this.store.cameraSource.acquire({
      id: 'video-filmstrip',
      onTrackChanged: (newTrack) => {
        this.onCameraTrackChanged(newTrack).catch(e =>
          console.error('video-filmstrip: onCameraTrackChanged failed', e)
        );
      },
    });
    if (!handle) {
      console.error('video-filmstrip: cameraSource.acquire failed');
      return false;
    }
    this.cameraHandle = handle;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([handle.track]);
    // Mount hidden in the DOM. Off-DOM <video> elements get decoder
    // throttling in some browsers — the codec advances slowly or stalls
    // when there's no rendering surface, which manifests as drawImage
    // repeatedly grabbing the same frame at fast capture intervals.
    // A 1px positioned element keeps the decoder fed without affecting
    // layout.
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    video.style.top = '0';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    try {
      await video.play();
    } catch (e) {
      console.error('video-filmstrip: video.play() rejected', e);
      try { video.remove(); } catch {}
      try { handle.release(); } catch {}
      this.cameraHandle = null;
      return false;
    }
    this.captureVideo = video;

    this.pipelineGeneration += 1;
    const gen = this.pipelineGeneration;
    this.pumpCapture(gen).catch(e =>
      console.error('video-filmstrip: pump error', e)
    );
    return true;
  }

  /**
   * Called by CameraSource when the shared track is replaced (device
   * change). Rebuild the video element's source MediaStream — the
   * existing pump loop continues, just reading from the new track. seq
   * does not reset, so peers' sequence-deduping keeps working across
   * the boundary.
   */
  private async onCameraTrackChanged(newTrack: MediaStreamTrack): Promise<void> {
    if (!this.captureVideo) return;
    this.captureVideo.srcObject = new MediaStream([newTrack]);
    try {
      await this.captureVideo.play();
    } catch (e) {
      console.error('video-filmstrip: play() rejected after device change', e);
    }
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
   * Set the sender frame rate. Takes effect on the next clip (does not
   * tear down the current capture loop — the pump reads the period
   * fresh per clip).
   */
  setFps(fps: FilmstripFps): void {
    if (!(FILMSTRIP_FPS_OPTIONS as readonly number[]).includes(fps)) return;
    this._capturePeriodMs = Math.round(1000 / fps);
  }

  async stopCapture(): Promise<void> {
    // Invalidate any in-flight pump loop.
    this.pipelineGeneration += 1;
    if (this.captureVideo) {
      try {
        this.captureVideo.pause();
        this.captureVideo.srcObject = null;
        this.captureVideo.remove();
      } catch {}
      this.captureVideo = null;
    }
    if (this.cameraHandle) {
      try { this.cameraHandle.release(); } catch {}
      this.cameraHandle = null;
    }
    this.seq = 0;
  }

  private async pumpCapture(gen: number): Promise<void> {
    const W = CAPTURE_WIDTH;
    const H = CAPTURE_HEIGHT;

    // HTMLCanvasElement (not OffscreenCanvas) — the project's TS lib
    // (es2017 + dom) doesn't fully cover OffscreenCanvas. The runtime
    // cost is identical for our main-thread use case.
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = W;
    captureCanvas.height = H;
    const cctx = captureCanvas.getContext('2d');
    if (!cctx) return;

    while (
      gen === this.pipelineGeneration &&
      this.cameraHandle &&
      this.captureVideo
    ) {
      // Read the period (and derived frame count) fresh every clip so
      // setFps() takes effect on the next clip boundary (≤ 1 s away).
      // N = fps, so the clip duration is approximately CLIP_TARGET_MS
      // (1 s) at every fps setting. At 1 fps a clip is a single-frame
      // snapshot per second; at 8 fps it's an 8-frame loop per second.
      const cycleStart = performance.now();
      const P = this._capturePeriodMs;
      const N = Math.max(1, Math.round(CLIP_TARGET_MS / P));

      const stripCanvas = document.createElement('canvas');
      stripCanvas.width = W;
      stripCanvas.height = H * N;
      const sctx = stripCanvas.getContext('2d');
      if (!sctx) return;

      // Capture N frames spaced P apart. The last frame is captured
      // immediately before encode/send so the freshest sample has
      // minimal end-to-end latency. Inter-frame sleep happens BEFORE
      // the capture to spread the N captures across the clip duration
      // (rather than bunching them up at the start with a long tail
      // sleep, which would delay the latest frame by P*(N-1) ms).
      //
      // Use the 9-arg drawImage to center-crop the camera source to a
      // square before scaling to W×H. Without this, a 4:3 or 16:9
      // source stretched directly into a square frame produces visibly
      // squashed faces on the receiver.
      for (let i = 0; i < N; i++) {
        if (i > 0) {
          await sleep(P);
          if (gen !== this.pipelineGeneration) return;
        }
        try {
          const vw = this.captureVideo.videoWidth || W;
          const vh = this.captureVideo.videoHeight || H;
          const side = Math.min(vw, vh);
          const sx = (vw - side) / 2;
          const sy = (vh - side) / 2;
          cctx.drawImage(this.captureVideo, sx, sy, side, side, 0, 0, W, H);
          sctx.drawImage(captureCanvas, 0, i * H);
        } catch (e) {
          // Video may have been torn down between iterations.
        }
      }

      const blob = await new Promise<Blob | null>(resolve => {
        stripCanvas.toBlob(b => resolve(b), 'image/jpeg', JPEG_QUALITY);
      });
      if (gen !== this.pipelineGeneration) return;
      if (!this.store) {
        await this._padCycle(cycleStart, gen);
        continue;
      }
      if (!blob) {
        console.error('video-filmstrip: toBlob returned null');
        await this._padCycle(cycleStart, gen);
        continue;
      }

      // _signalsTargets is a derived store updated by the same wiring as
      // voice — pull it fresh per clip. If empty, skip the network
      // roundtrip; the reconciler will stop us shortly.
      const targets = get(this.store._signalsTargets);
      if (targets.size > 0) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        const payload: FilmstripPayload = {
          seq: this.seq++,
          ts: Date.now(),
          w: W, h: H, n: N, p: P,
          data: bytesToBase64(buf),
        };
        this.store
          .sendModuleData('video-filmstrip', JSON.stringify(payload), targets)
          .catch(() => {});
      }

      await this._padCycle(cycleStart, gen);
    }
  }

  /**
   * Sleep until CLIP_TARGET_MS has elapsed since `cycleStart`, so the
   * pump emits ~1 clip/sec at every fps. Without this, low-fps clips
   * (which finish capture quickly) would loop-burst the encoder.
   */
  private async _padCycle(cycleStart: number, gen: number): Promise<void> {
    const elapsed = performance.now() - cycleStart;
    const remaining = CLIP_TARGET_MS - elapsed;
    if (remaining > 0) {
      await sleep(remaining);
    }
    // Caller checks generation after we return.
    void gen;
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
      state = { latest: null, lastSeq: 0 };
      this.peers.set(agentPubKeyB64, state);
    }
    if (payload.seq <= state.lastSeq && state.lastSeq !== 0) {
      // out-of-order or duplicate; cheap drop
      return;
    }
    state.lastSeq = payload.seq;

    const bytes = base64ToBytes(payload.data);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);

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
   * Subscribe to filmstrip frames for a specific peer. The callback fires
   * once with the latest frame (if any) at subscribe time, and again on
   * every subsequent receive. Returns an unsubscribe function.
   */
  subscribe(
    agentPubKeyB64: string,
    callback: (frame: FilmstripFrame) => void,
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

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
