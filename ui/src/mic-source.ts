/**
 * MicSource — transport-agnostic owner of the user's microphone.
 *
 * Background: before this class existed, both `audioOn`/`audioOff` (WebRTC)
 * and the `voice` module (opus-over-signals) each called `getUserMedia`
 * separately, racing for the same input device and fragmenting mute /
 * device-picker / AGC state. `MicSource` centralizes the mic: one
 * `getUserMedia` call, one device id, one mute flag, one `AudioContext`.
 *
 * Consumers (WebRTC's audio path, the voice module's encoder, a future
 * transcription module) call `acquire()` to get a track and a release
 * handle. The underlying device is opened on the first acquire and closed
 * when the last consumer releases — refcount semantics. Mute is a single
 * source of truth across all consumers: calling `setMuted(true)` disables
 * the track via `track.enabled = false` (fast re-enable, no renegotiation)
 * and every consumer sees the effect simultaneously.
 *
 * Device change: `changeDevice(id)` opens a new track on the new device,
 * replaces the active track, and notifies two levels of callback:
 *
 *   1. A store-level `onTrackChange` callback (passed at construction) that
 *      updates `StreamsStore.mainStream` and calls `replaceTrack` on every
 *      open WebRTC peer. This keeps the WebRTC path working without each
 *      consumer having to know about peers.
 *   2. Per-consumer `onTrackChanged` callbacks provided at `acquire()` time,
 *      for consumers that hold a specific track instance (e.g. the voice
 *      module's `MediaStreamTrackProcessor`) and must rebuild their pipeline.
 *
 * AudioContext: `ensureAudioContext()` lazily creates a single shared
 * `AudioContext` owned by this instance. The voice module's squelch synth
 * and future audio consumers should use it rather than creating their own,
 * so we don't end up with clock drift between contexts or multiple
 * autoplay-gesture prompts.
 */

export type MicConsumerId = string;

export interface MicConsumerOptions {
  id: MicConsumerId;
  /**
   * Fired when the underlying track is replaced (device change) *while this
   * consumer holds a reference*. Consumers that just hold a track reference
   * and rely on the store-level `replaceTrack` fanout don't need to
   * implement this. Consumers that bind a specific track instance to a
   * downstream object (MediaStreamTrackProcessor, MediaStreamSource nodes,
   * etc.) must rebuild on this callback.
   */
  onTrackChanged?: (newTrack: MediaStreamTrack) => void;
}

export interface MicAcquireResult {
  track: MediaStreamTrack;
  release: () => void;
}

export interface MicSourceBindings {
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
   * The store-level handler is responsible for keeping `mainStream`,
   * `mainStreamClones`, and all open WebRTC peers in sync. This callback
   * fires *before* per-consumer `onTrackChanged` callbacks so that the
   * `replaceTrack` fanout happens before any consumer-local rebuild work.
   */
  onTrackChange: (
    newTrack: MediaStreamTrack | null,
    oldTrack: MediaStreamTrack | null,
  ) => void;
  /**
   * Called after `setMuted` flips the mute flag. Lets the store fan out
   * the enabled/disabled state to `mainStreamClones` — see the (retired) simple-peer
   * issue #606 for why clones need their own enable/disable passes.
   */
  onMutedChange: (muted: boolean) => void;
}

export class MicSource {
  private bindings: MicSourceBindings;

  private _track: MediaStreamTrack | null = null;

  /**
   * The raw MediaStream returned by getUserMedia. Held so we can stop the
   * stream's tracks on device change or release. Consumers should never
   * read this directly — they should use the track from `acquire()`.
   */
  private _rawStream: MediaStream | null = null;

  private consumers = new Map<MicConsumerId, MicConsumerOptions>();

  private _muted = false;

  private _audioContext: AudioContext | null = null;

  /**
   * Guards against concurrent open attempts from multiple parallel
   * `acquire()` callers. If the device is being opened, later callers wait
   * on the same promise.
   */
  private _openingPromise: Promise<boolean> | null = null;

  constructor(bindings: MicSourceBindings) {
    this.bindings = bindings;
  }

  get track(): MediaStreamTrack | null {
    return this._track;
  }

  get muted(): boolean {
    return this._muted;
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  /**
   * Acquire a reference to the mic. Opens the underlying device on first
   * acquire. Returns `null` if `getUserMedia` fails or the consumer id is
   * already in use.
   *
   * The caller holds a reference until it calls the returned `release()`.
   * When the last consumer releases, the device is closed.
   */
  async acquire(options: MicConsumerOptions): Promise<MicAcquireResult | null> {
    if (this.consumers.has(options.id)) {
      console.warn(`MicSource: consumer "${options.id}" already acquired`);
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

  private _release(id: MicConsumerId): void {
    if (!this.consumers.delete(id)) return;
    if (this.consumers.size === 0) {
      this._closeDevice();
    }
  }

  /**
   * Set the mute state. Affects every consumer simultaneously — any
   * consumer can mute, every consumer observes the same state via the
   * store-level `onMutedChange` fanout.
   *
   * Semantics: `track.enabled = false` (fast re-enable, no WebRTC
   * renegotiation, keeps the RTCRtpSender open). This is distinct from
   * `track.stop()`, which fully releases the device and requires a new
   * `getUserMedia` call to bring back.
   */
  setMuted(muted: boolean): void {
    if (this._muted === muted) return;
    this._muted = muted;
    if (this._track) {
      this._track.enabled = !muted;
    }
    try {
      this.bindings.onMutedChange(muted);
    } catch (e) {
      console.warn('MicSource: onMutedChange handler threw', e);
    }
  }

  /**
   * Change the active audio input device. Writes the new id to the outer
   * store's `_audioInputId`, opens a new track, replaces the active track,
   * and notifies both the store-level and per-consumer callbacks.
   *
   * If no consumer currently holds the mic, the new id is stored but the
   * device is not opened — the next `acquire()` will use it.
   */
  async changeDevice(deviceId: string | undefined): Promise<void> {
    this.bindings.setDeviceId(deviceId);

    if (!this._track) return;

    const old = this._track;
    const oldStream = this._rawStream;

    let newStream: MediaStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: this._audioConstraints(deviceId),
      });
    } catch (e) {
      console.error('MicSource: changeDevice getUserMedia failed', e);
      return;
    }

    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) {
      console.error('MicSource: changeDevice got no audio track');
      try { newStream.getTracks().forEach(t => t.stop()); } catch {}
      return;
    }
    if (this._muted) newTrack.enabled = false;

    this._track = newTrack;
    this._rawStream = newStream;

    // Store-level fanout first (replaceTrack on peers, update mainStream).
    try {
      this.bindings.onTrackChange(newTrack, old);
    } catch (e) {
      console.warn('MicSource: onTrackChange threw on device change', e);
    }

    // Then per-consumer callbacks for consumers that bind to track identity.
    for (const c of this.consumers.values()) {
      try {
        c.onTrackChanged?.(newTrack);
      } catch (e) {
        console.warn(`MicSource: consumer "${c.id}" onTrackChanged threw`, e);
      }
    }

    // Stop the old stream last so any mid-flight operations above observed
    // a live track.
    if (oldStream) {
      try { oldStream.getTracks().forEach(t => t.stop()); } catch {}
    } else {
      try { old.stop(); } catch {}
    }
  }

  /**
   * Lazily create and return a single shared AudioContext. Consumers that
   * need audio playback (squelch, voice decoder) should borrow this rather
   * than creating their own, so we don't end up with multiple contexts
   * fighting over the audio device / autoplay gesture.
   */
  ensureAudioContext(): AudioContext | null {
    if (this._audioContext) return this._audioContext;
    try {
      this._audioContext = new AudioContext({ sampleRate: 48000 });
      // Best-effort unlock; in Electron this normally succeeds without a
      // gesture, and the error path is harmless on browsers that require one.
      this._audioContext.resume().catch(() => {});
      return this._audioContext;
    } catch (e) {
      console.error('MicSource: failed to create AudioContext', e);
      return null;
    }
  }

  /**
   * Dispose the MicSource. Force-closes the device even if consumers still
   * hold references (they'll see no further callbacks). Closes the shared
   * AudioContext. Called by `StreamsStore.disconnect()`.
   */
  dispose(): void {
    this.consumers.clear();
    this._closeDevice();
    const ac = this._audioContext;
    this._audioContext = null;
    if (ac) {
      try { ac.close(); } catch {}
    }
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
            audio: this._audioConstraints(deviceId),
          });
        } catch (e) {
          console.error('MicSource: getUserMedia failed', e);
          return false;
        }
        const track = stream.getAudioTracks()[0];
        if (!track) {
          console.error('MicSource: getUserMedia returned no audio track');
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          return false;
        }
        if (this._muted) track.enabled = false;
        this._rawStream = stream;
        this._track = track;
        try {
          this.bindings.onTrackChange(track, null);
        } catch (e) {
          console.warn('MicSource: onTrackChange threw on open', e);
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
        console.warn('MicSource: onTrackChange threw on close', e);
      }
    }
  }

  private _audioConstraints(deviceId: string | undefined): MediaTrackConstraints {
    // Matches the voice module's constraints (the tightest in the tree) so
    // both WebRTC and the voice encoder see the same shape.
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
      ...(deviceId ? { deviceId } : {}),
    };
  }
}
