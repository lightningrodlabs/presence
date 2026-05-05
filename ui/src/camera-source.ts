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

    if (!this._track) {
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

    const old = this._track;
    const oldStream = this._rawStream;

    let newStream: MediaStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: this._videoConstraints(deviceId),
      });
    } catch (e) {
      console.error('CameraSource: changeDevice getUserMedia failed', e);
      return;
    }

    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) {
      console.error('CameraSource: changeDevice got no video track');
      try { newStream.getTracks().forEach(t => t.stop()); } catch {}
      return;
    }

    this._track = newTrack;
    this._rawStream = newStream;

    // Store-level fanout first (mainStream + peer add/removeTrack).
    try {
      this.bindings.onTrackChange(newTrack, old);
    } catch (e) {
      console.warn('CameraSource: onTrackChange threw on device change', e);
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
    } else {
      try { old.stop(); } catch {}
    }
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
    if (this._track) return true;
    if (this._openingPromise) return this._openingPromise;

    this._openingPromise = (async () => {
      try {
        const deviceId = this.bindings.getDeviceId();
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: this._videoConstraints(deviceId),
          });
        } catch (e) {
          console.error('CameraSource: getUserMedia failed', e);
          return false;
        }
        const track = stream.getVideoTracks()[0];
        if (!track) {
          console.error('CameraSource: getUserMedia returned no video track');
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          return false;
        }
        this._rawStream = stream;
        this._track = track;
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

  private _closeDevice(): void {
    const old = this._track;
    const oldStream = this._rawStream;
    this._track = null;
    this._rawStream = null;
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

  private _videoConstraints(deviceId: string | undefined): MediaTrackConstraints | true {
    return deviceId ? { deviceId } : true;
  }
}
