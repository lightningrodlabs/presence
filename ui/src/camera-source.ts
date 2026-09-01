/**
 * CameraSource — transport-agnostic owner of the user's camera.
 *
 * Mirrors `MicSource`. Before this class existed, `videoOn` / `videoOff`
 * called `getUserMedia` directly and there was no shared abstraction for
 * a future second consumer. The low-bandwidth-video module needs to read
 * the same camera track that WebRTC is using; running its own
 * `getUserMedia` would race for the device and fragment device-change /
 * teardown semantics.
 *
 * Consumers (WebRTC's video path, the `video-filmstrip` module) call
 * `acquire()` to get a track and a release handle. The underlying device
 * is opened on first acquire and stopped when the last consumer releases
 * — refcount semantics. There is no mute-vs-off split for video like
 * there is for audio: the existing `videoOff` path stops the track (the
 * camera LED-off signal matters), so a release IS the off path.
 *
 * Device change: `changeDevice(id)` opens a new track on the new device,
 * replaces the active track, and notifies two levels of callback —
 *
 *   1. A store-level `onTrackChange` (passed at construction) that
 *      updates `StreamsStore.mainStream` and addTrack/removeTrack on
 *      every open WebRTC peer. Mirrors the mic-side handler.
 *   2. Per-consumer `onTrackChanged` callbacks for consumers that bind
 *      to a specific track instance (e.g. a future
 *      `MediaStreamTrackProcessor` in the filmstrip encoder) and must
 *      rebuild on the new track.
 */

import type { CaptureLifecycle } from './mic-source';
import { isLiveTrack } from './mic-source';

export type CameraConsumerId = string;

export interface CameraConsumerOptions {
  id: CameraConsumerId;
  /**
   * Fired when the underlying track is replaced (device change) *while
   * this consumer holds a reference*. Consumers that just hold a track
   * reference and rely on the store-level fanout (peer addTrack /
   * removeTrack) don't need to implement this.
   */
  onTrackChanged?: (newTrack: MediaStreamTrack) => void;
}

export interface CameraAcquireResult {
  track: MediaStreamTrack;
  release: () => void;
}

export interface CameraSourceBindings {
  /** Read the currently-selected device id from the outer store. */
  getDeviceId: () => string | undefined;
  /** Write the selected device id back to the outer store. */
  setDeviceId: (id: string | undefined) => void;
  /**
   * Called on every track lifecycle event:
   *   - open:         (newTrack, null)
   *   - device change:(newTrack, oldTrack)
   *   - close:        (null,     oldTrack)
   *
   * The store-level handler is responsible for keeping `mainStream`
   * and all open WebRTC peers in sync. Fires *before* per-consumer
   * `onTrackChanged` callbacks so the WebRTC fanout happens before
   * any consumer-local rebuild work.
   */
  onTrackChange: (
    newTrack: MediaStreamTrack | null,
    oldTrack: MediaStreamTrack | null,
  ) => void;
  /** Fired on every `_setLifecycle` transition (wrapped in try/catch,
   *  mirroring `MicSource`). Task 3's reconciler and Task 5's diff policy
   *  are the intended consumers. */
  onLifecycleChange: (lifecycle: CaptureLifecycle) => void;
  /** Clock read for lifecycle timestamps — routed from `StreamsStore.clock`
   *  so this file carries no ambient time (see `no-ambient-clock.test.ts`). */
  now: () => number;
}

export class CameraSource {
  private bindings: CameraSourceBindings;

  private _track: MediaStreamTrack | null = null;

  /**
   * Raw MediaStream from getUserMedia. Held so we can stop the stream's
   * tracks on device change or release. Consumers should never read this
   * directly — they should use the track from `acquire()`.
   */
  private _rawStream: MediaStream | null = null;

  private consumers = new Map<CameraConsumerId, CameraConsumerOptions>();

  private _lifecycle: CaptureLifecycle = { state: 'idle' };

  /**
   * Guards against concurrent open attempts from multiple parallel
   * `acquire()` callers. If the device is being opened, later callers
   * wait on the same promise.
   */
  private _openingPromise: Promise<boolean> | null = null;

  constructor(bindings: CameraSourceBindings) {
    this.bindings = bindings;
  }

  get track(): MediaStreamTrack | null {
    return this._track;
  }

  get lifecycle(): CaptureLifecycle {
    return this._lifecycle;
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  /**
   * Acquire a reference to the camera. Opens the underlying device on
   * first acquire. Returns `null` if `getUserMedia` fails or the consumer
   * id is already in use.
   *
   * The caller holds a reference until it calls the returned `release()`.
   * When the last consumer releases, the device is closed (track stopped,
   * camera LED goes off).
   */
  async acquire(options: CameraConsumerOptions): Promise<CameraAcquireResult | null> {
    if (this.consumers.has(options.id)) {
      console.warn(`CameraSource: consumer "${options.id}" already acquired`);
      return null;
    }

    if (!isLiveTrack(this._track)) {
      const ok = await this._ensureOpen();
      if (!ok || !this._track) return null;
    }

    this.consumers.set(options.id, options);
    const track = this._track;
    return {
      track,
      release: () => this._release(options.id),
    };
  }

  private _release(id: CameraConsumerId): void {
    if (!this.consumers.delete(id)) return;
    if (this.consumers.size === 0) {
      this._closeDevice();
    }
  }

  /**
   * Change the active video input device. Writes the new id to the outer
   * store, opens a new track, replaces the active track, and notifies
   * both the store-level and per-consumer callbacks.
   *
   * If no consumer currently holds the camera, the new id is stored but
   * the device is not opened — the next `acquire()` will use it.
   */
  async changeDevice(deviceId: string | undefined): Promise<void> {
    this.bindings.setDeviceId(deviceId);

    if (!this._track) return;

    // A device switch keeps the old track live if the new one fails to
    // open — `markFailed: false` leaves the lifecycle untouched on error.
    await this._openAndSwap(deviceId, { markFailed: false });
  }

  /**
   * Reopen a dead-but-held device — Task 3's capture reconciler `open`
   * arm for a handle whose track has `ended`/`failed`. Opens a fresh track
   * on the current device and swaps it in through the SAME store-level
   * `onTrackChange` fanout `changeDevice` uses (device-change branch →
   * `replaceTrack` on peers), so a dead camera's sender recovers without a
   * renegotiation. Unlike `changeDevice`, a reopen failure IS a lifecycle
   * `failed`. Returns whether a live track is now installed.
   */
  async reopen(): Promise<boolean> {
    return this._openAndSwap(this.bindings.getDeviceId(), { markFailed: true });
  }

  /**
   * Open a fresh track and swap it in via the device-change fanout. Shared
   * by `changeDevice` (keeps the old track on failure) and `reopen`
   * (records `failed` on failure). Returns true iff a new live track is
   * installed.
   */
  private async _openAndSwap(
    deviceId: string | undefined,
    opts: { markFailed: boolean },
  ): Promise<boolean> {
    const old = this._track;
    const oldStream = this._rawStream;

    let newStream: MediaStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: this._videoConstraints(deviceId),
      });
    } catch (e) {
      console.error('CameraSource: _openAndSwap getUserMedia failed', e);
      if (opts.markFailed) {
        this._setLifecycle({ state: 'failed', error: String(e), failedAt: this.bindings.now() });
      }
      return false;
    }

    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) {
      console.error('CameraSource: _openAndSwap got no video track');
      try { newStream.getTracks().forEach(t => t.stop()); } catch {}
      if (opts.markFailed) {
        this._setLifecycle({ state: 'failed', error: 'no video track', failedAt: this.bindings.now() });
      }
      return false;
    }

    newTrack.onended = () => this._onTrackEnded(newTrack);

    this._track = newTrack;
    this._rawStream = newStream;
    this._setLifecycle({ state: 'live', track: newTrack });

    // Store-level fanout first (mainStream + peer replaceTrack).
    try {
      this.bindings.onTrackChange(newTrack, old);
    } catch (e) {
      console.warn('CameraSource: onTrackChange threw on swap', e);
    }

    // Then per-consumer callbacks for consumers that bind to track identity.
    for (const c of this.consumers.values()) {
      try {
        c.onTrackChanged?.(newTrack);
      } catch (e) {
        console.warn(`CameraSource: consumer "${c.id}" onTrackChanged threw`, e);
      }
    }

    // Stop the old stream last so any mid-flight operations above
    // observed a live track.
    if (oldStream) {
      try { oldStream.getTracks().forEach(t => t.stop()); } catch {}
    } else if (old) {
      try { old.stop(); } catch {}
    }
    return true;
  }

  /**
   * Force-close the device. Called by `StreamsStore.disconnect()`.
   * Consumers still holding handles will see no further callbacks.
   */
  dispose(): void {
    this.consumers.clear();
    this._closeDevice();
  }

  private async _ensureOpen(): Promise<boolean> {
    if (isLiveTrack(this._track)) return true;
    if (this._openingPromise) return this._openingPromise;

    this._openingPromise = (async () => {
      this._setLifecycle({ state: 'acquiring', since: this.bindings.now() });
      try {
        // A stale (ended) track can still be sitting here — the last
        // consumer never released it, the device just died underneath
        // them. Stop its stream before opening a replacement so it
        // doesn't leak.
        if (this._track) {
          const staleStream = this._rawStream;
          if (staleStream) {
            try { staleStream.getTracks().forEach(t => t.stop()); } catch {}
          } else {
            try { this._track.stop(); } catch {}
          }
          this._track = null;
          this._rawStream = null;
        }

        const deviceId = this.bindings.getDeviceId();
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: this._videoConstraints(deviceId),
          });
        } catch (e) {
          console.error('CameraSource: getUserMedia failed', e);
          this._setLifecycle({ state: 'failed', error: String(e), failedAt: this.bindings.now() });
          return false;
        }
        const track = stream.getVideoTracks()[0];
        if (!track) {
          console.error('CameraSource: getUserMedia returned no video track');
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          this._setLifecycle({ state: 'failed', error: 'no video track', failedAt: this.bindings.now() });
          return false;
        }
        track.onended = () => this._onTrackEnded(track);
        this._rawStream = stream;
        this._track = track;
        this._setLifecycle({ state: 'live', track });
        try {
          this.bindings.onTrackChange(track, null);
        } catch (e) {
          console.warn('CameraSource: onTrackChange threw on open', e);
        }
        return true;
      } finally {
        this._openingPromise = null;
      }
    })();

    return this._openingPromise;
  }

  /**
   * The `ended` event on the currently-installed track. Observation only
   * — it writes the lifecycle and stops there. Reopening the device is
   * Task 3's reconciler's job, which polls `lifecycle` on the presence
   * tick as the correctness backstop if this edge is ever missed.
   */
  private _onTrackEnded(track: MediaStreamTrack): void {
    if (this._track !== track) return; // stale event from a superseded track
    this._setLifecycle({ state: 'ended', endedAt: this.bindings.now() });
  }

  private _setLifecycle(next: CaptureLifecycle): void {
    this._lifecycle = next;
    try {
      this.bindings.onLifecycleChange(next);
    } catch (e) {
      console.warn('CameraSource: onLifecycleChange handler threw', e);
    }
  }

  private _closeDevice(): void {
    const old = this._track;
    const oldStream = this._rawStream;
    this._track = null;
    this._rawStream = null;
    this._setLifecycle({ state: 'idle' });
    if (oldStream) {
      try { oldStream.getTracks().forEach(t => t.stop()); } catch {}
    } else if (old) {
      try { old.stop(); } catch {}
    }
    if (old) {
      try {
        this.bindings.onTrackChange(null, old);
      } catch (e) {
        console.warn('CameraSource: onTrackChange threw on close', e);
      }
    }
  }

  private _videoConstraints(deviceId: string | undefined): MediaTrackConstraints {
    // Explicit frameRate constraint matters when the camera is consumed
    // ONLY via MediaStreamTrackProcessor (e.g. the video-filmstrip
    // module in signals carrier mode). WebRTC's RTCRtpSender negotiates
    // its own frame-rate hints and the camera adapts; a track-processor
    // consumer doesn't, so without an explicit `ideal` here the camera
    // stays at whatever low default the device picks (some cameras
    // settle at 5 fps when no consumer is asking for more). 30 fps is
    // both sufficient for the filmstrip's max 8 fps sample rate and
    // standard for video calls.
    return {
      frameRate: { ideal: 30, min: 15 },
      ...(deviceId ? { deviceId } : {}),
    };
  }
}
