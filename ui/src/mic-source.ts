import { decideMicOutput, isLiveTrack, type MicOutputMode } from './mic-output-policy';

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
 *      Both of these are about the OUTPUT. A consumer of the raw device
 *      track (transcription) gets `onDeviceTrackChanged` instead, fanned
 *      out from `_setLifecycle`'s `live` transition, because a device swap
 *      while mixed changes no output at all.
 *
 * AudioContext: `ensureAudioContext()` lazily creates a single shared
 * `AudioContext` owned by this instance. The voice module's squelch synth
 * and future audio consumers should use it rather than creating their own,
 * so we don't end up with clock drift between contexts or multiple
 * autoplay-gesture prompts.
 *
 * Mixin (spec Section 4): `setMixin(track)` includes a second audio track
 * (system audio the host granted) in the ONE output track consumers hold:
 * device + mixin → two `MediaStreamAudioSourceNode`s → one
 * `MediaStreamAudioDestinationNode` in the shared 48 kHz context; the
 * destination's track is the output. `decideMicOutput` (mic-output-policy.ts)
 * is the only decision; `_installOutputTrack` the only swap; the store's
 * `onTrackChange` device-change branch carries it to peers. A device change
 * or reopen while mixed replaces only the device source node — the output
 * track, and every consumer's view of it, is untouched. Real audio-graph
 * behaviour (the mixin audible to a peer, no echo) is validated manually —
 * see the plan's final task; node tests cover the decision and the swap
 * plumbing with fakes.
 */

/**
 * Capture lifecycle for a device-owning source (`MicSource`/`CameraSource`).
 * Replaces the old two-state `_track` null/non-null model: `ended` is the
 * state whose absence made a dead mic unrecoverable in the field (the
 * track went stale but `_track` stayed non-null, so every predicate that
 * checked "is there a track" kept answering yes). `_setLifecycle` is the
 * one place either source writes this; `_onTrackEnded` observes but never
 * reopens — recovery is Task 3's reconciler's job.
 */
export type CaptureLifecycle =
  | { state: 'idle' }
  | { state: 'acquiring'; since: number }
  | { state: 'live'; track: MediaStreamTrack }
  | { state: 'ended'; endedAt: number }
  | { state: 'failed'; error: string; failedAt: number };

/** The one track-liveness predicate lives beside the output decision that
 *  reads it (`mic-output-policy.ts`); re-exported here for `CameraSource`
 *  and the lifecycle tests, which reach it under this name. */
export { isLiveTrack } from './mic-output-policy';

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
  /**
   * Fired when a new DEVICE track goes live (open, device change, reopen)
   * while this consumer holds a reference — whether or not the output
   * changed. While mixed, a device swap replaces only the mic's source
   * node and the output is untouched, so `onTrackChanged` stays silent;
   * a consumer of the raw microphone (transcription, which must never
   * read the shared system audio) rebuilds on this one instead. Fanned
   * out from `_setLifecycle`, the one write of the device lifecycle, on
   * its `live` transition; the device closing or ending has no callback
   * here — the track itself ends, and a reader on it sees `done`.
   */
  onDeviceTrackChanged?: (track: MediaStreamTrack) => void;
  /**
   * Take whatever the output currently carries and never open the
   * microphone for it. The voice encoder sets this: with an included
   * system-audio share and the mic off there IS an output to encode, and
   * acquiring it must not light the user's recording indicator. Default
   * false — acquiring otherwise means "I want the microphone", which is
   * what the capture reconciler (the owner of the device's lifetime, on
   * `localIntent.mic.wanted`) is asking for.
   */
  outputOnly?: boolean;
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
   * The store-level handler is responsible for keeping `mainStream` and
   * all open WebRTC peers in sync. This callback fires *before*
   * per-consumer `onTrackChanged` callbacks so that the `replaceTrack`
   * fanout happens before any consumer-local rebuild work.
   */
  onTrackChange: (
    newTrack: MediaStreamTrack | null,
    oldTrack: MediaStreamTrack | null,
  ) => void;
  /**
   * Called after `setMuted` flips the mute flag. The fanout this served —
   * pushing enabled/disabled state out to `mainStreamClones` — was deleted
   * as dead code (round two Task 6, `mainStreamClones` had zero writers).
   * The store's binding is deliberately a no-op; `setMuted` itself already
   * flips the primary track's `enabled` flag before calling this.
   */
  onMutedChange: (muted: boolean) => void;
  /** Fired on every `_setLifecycle` transition (wrapped in try/catch like
   *  `onMutedChange`). Task 3's reconciler and Task 5's diff policy are
   *  the intended consumers. */
  onLifecycleChange: (lifecycle: CaptureLifecycle) => void;
  /**
   * Fired when MicSource drops a mixin it held for a reason other than a
   * `setMixin` call: the graph could not be built ('mix-failed') or the
   * mixin track ended under us ('mixin-ended'). The store's binding ends
   * the host capture and the durable intent with it, so "Including" is
   * never shown while nothing is mixed. Fires after the output swap the
   * drop caused, never from inside `setMixin`. Closing the microphone is
   * NOT one of these: the mixin outlives it (`_closeDevice`).
   */
  onMixinDropped: (reason: 'mix-failed' | 'mixin-ended') => void;
  /** Clock read for lifecycle timestamps — routed from `StreamsStore.clock`
   *  so this file carries no ambient time (see `no-ambient-clock.test.ts`). */
  now: () => number;
}

export class MicSource {
  private bindings: MicSourceBindings;

  private _deviceTrack: MediaStreamTrack | null = null;

  private _mixin: MediaStreamTrack | null = null;

  /** The output consumers hold: the device track, or the mix destination's track. */
  private _outputTrack: MediaStreamTrack | null = null;

  /**
   * The audio graph behind a 'mixed' output. The microphone side is
   * optional: a share with the mic closed is a one-source graph, and the
   * mic's node is added and removed in place (`_syncMixDeviceNode`)
   * without ever swapping the destination track.
   */
  private _mix: {
    device: MediaStreamTrack | null;
    mixin: MediaStreamTrack;
    deviceNode: MediaStreamAudioSourceNode | null;
    mixinNode: MediaStreamAudioSourceNode;
    destination: MediaStreamAudioDestinationNode;
  } | null = null;

  /**
   * The raw MediaStream returned by getUserMedia. Held so we can stop the
   * stream's tracks on device change or release. Consumers should never
   * read this directly — they should use the track from `acquire()`.
   */
  private _rawStream: MediaStream | null = null;

  private consumers = new Map<MicConsumerId, MicConsumerOptions>();

  private _muted = false;

  private _lifecycle: CaptureLifecycle = { state: 'idle' };

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
    return this._outputTrack;
  }

  /** The raw device track; the reconciler and the lifecycle are about this one. */
  get deviceTrack(): MediaStreamTrack | null {
    return this._deviceTrack;
  }

  get outputMode(): MicOutputMode | null {
    return this._outputTrack ? (this._mix ? 'mixed' : 'device') : null;
  }

  get muted(): boolean {
    return this._muted;
  }

  get lifecycle(): CaptureLifecycle {
    return this._lifecycle;
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

    if (!options.outputOnly && !isLiveTrack(this._deviceTrack)) {
      const ok = await this._ensureOpen();
      if (!ok || !this._deviceTrack) return null;
    }

    const track = this._outputTrack;
    if (!track) return null;

    this.consumers.set(options.id, options);
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
   * consumer can mute, and every consumer observes the same state because
   * they all hold the same shared track and read its `enabled` flag.
   *
   * Semantics: `track.enabled = false` (fast re-enable, no WebRTC
   * renegotiation, keeps the RTCRtpSender open). This is distinct from
   * `track.stop()`, which fully releases the device and requires a new
   * `getUserMedia` call to bring back.
   */
  setMuted(muted: boolean): void {
    if (this._muted === muted) return;
    this._muted = muted;
    this._applyMute();
    try {
      this.bindings.onMutedChange(muted);
    } catch (e) {
      console.warn('MicSource: onMutedChange handler threw', e);
    }
  }

  /**
   * Put the current mute state on the tracks. Mute means "my microphone
   * is off", never "nothing leaves this machine": while mixed it silences
   * the mic's branch and leaves the output enabled, so an included share
   * keeps flowing to peers. Without a mix the output IS the device, so
   * the two coincide. Applied on every output swap as well, since a
   * reopened or rebuilt track comes back enabled.
   */
  private _applyMute(): void {
    const muted = this._muted;
    if (this._mix) {
      if (this._outputTrack) this._outputTrack.enabled = true;
      if (this._deviceTrack) this._deviceTrack.enabled = !muted;
      return;
    }
    if (this._outputTrack) this._outputTrack.enabled = !muted;
    if (this._deviceTrack && this._deviceTrack !== this._outputTrack) {
      this._deviceTrack.enabled = !muted;
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

    if (!this._deviceTrack) return;

    // A device switch keeps the old track live if the new one fails to
    // open — `markFailed: false` leaves the lifecycle untouched on error.
    await this._openAndSwap(deviceId, { markFailed: false });
  }

  /**
   * Reopen a dead-but-held device — Task 3's capture reconciler `open`
   * arm for a handle whose track has `ended`/`failed` underneath it. Opens
   * a fresh track on the current device and swaps it in through the SAME
   * store-level `onTrackChange` fanout `changeDevice` uses (device-change
   * branch → `replaceTrack` on peers, no renegotiation), so the fanout is
   * stated once. Unlike `changeDevice`, a reopen failure IS a lifecycle
   * `failed` — the reconciler's pacing/ceiling arms act on it. Returns
   * whether a live track is now installed.
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
    const old = this._deviceTrack;
    const oldStream = this._rawStream;

    let newStream: MediaStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: this._audioConstraints(deviceId),
      });
    } catch (e) {
      console.error('MicSource: _openAndSwap getUserMedia failed', e);
      if (opts.markFailed) {
        this._setLifecycle({ state: 'failed', error: String(e), failedAt: this.bindings.now() });
      }
      return false;
    }

    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) {
      console.error('MicSource: _openAndSwap got no audio track');
      try { newStream.getTracks().forEach(t => t.stop()); } catch {}
      if (opts.markFailed) {
        this._setLifecycle({ state: 'failed', error: 'no audio track', failedAt: this.bindings.now() });
      }
      return false;
    }
    if (this._muted) newTrack.enabled = false;
    newTrack.onended = () => this._onTrackEnded(newTrack);

    this._deviceTrack = newTrack;
    this._rawStream = newStream;
    this._setLifecycle({ state: 'live', track: newTrack });

    // While mixed, a device swap only replaces the device source node in
    // the graph — the destination (output) track and every consumer's view
    // of it are untouched, so no fanout fires. Otherwise this is the
    // pre-mixin fanout: store-level replaceTrack first, then per-consumer
    // rebuilds for consumers bound to track identity.
    // A live mixin with no mix behind it is one this source was asked to
    // hold and has not built yet; reconciling here builds it onto the new
    // device (always `build-mix`, which installs). Without the mixin
    // clause this branch installed the device track straight over it and
    // nothing would have rebuilt it. A non-live mixin cannot produce an
    // installing decision, so it keeps the plain swap.
    if (this._mix || isLiveTrack(this._mixin)) {
      this._reconcileOutput();
    } else {
      this._installOutputTrack(newTrack, old);
    }

    // Stop the old stream last so any mid-flight operations above observed
    // a live track.
    if (oldStream) {
      try { oldStream.getTracks().forEach(t => t.stop()); } catch {}
    } else if (old) {
      try { old.stop(); } catch {}
    }
    return true;
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
    // The session is over, so nothing survives the device this time. The
    // store has already released the capture (`disconnect()` runs
    // `_releaseSystemAudio` before this), so there is nobody to report to.
    this._mixin = null;
    this._closeDevice();
    const ac = this._audioContext;
    this._audioContext = null;
    if (ac) {
      try { ac.close(); } catch {}
    }
  }

  private async _ensureOpen(): Promise<boolean> {
    if (isLiveTrack(this._deviceTrack)) return true;
    if (this._openingPromise) return this._openingPromise;

    this._openingPromise = (async () => {
      this._setLifecycle({ state: 'acquiring', since: this.bindings.now() });
      try {
        // A stale (ended) track can still be sitting here — the last
        // consumer never released it, the device just died underneath
        // them. Stop its stream before opening a replacement so it
        // doesn't leak.
        if (this._deviceTrack) {
          const staleStream = this._rawStream;
          if (staleStream) {
            try { staleStream.getTracks().forEach(t => t.stop()); } catch {}
          } else {
            try { this._deviceTrack.stop(); } catch {}
          }
          // Non-mixed, the output mirrors the device 1:1 — clear it with
          // the device so `_reconcileOutput` below sees `current: null`
          // rather than a stale `{mode:'device'}` pointing at the corpse
          // (which would read as "already-device" and skip installing the
          // track this call is about to open). Mixed, the output is the
          // destination track, untouched by a dead device source.
          if (this._outputTrack === this._deviceTrack) {
            this._outputTrack = null;
          }
          this._deviceTrack = null;
          this._rawStream = null;
        }

        const deviceId = this.bindings.getDeviceId();
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: this._audioConstraints(deviceId),
          });
        } catch (e) {
          console.error('MicSource: getUserMedia failed', e);
          this._setLifecycle({ state: 'failed', error: String(e), failedAt: this.bindings.now() });
          return false;
        }
        const track = stream.getAudioTracks()[0];
        if (!track) {
          console.error('MicSource: getUserMedia returned no audio track');
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          this._setLifecycle({ state: 'failed', error: 'no audio track', failedAt: this.bindings.now() });
          return false;
        }
        if (this._muted) track.enabled = false;
        track.onended = () => this._onTrackEnded(track);
        this._rawStream = stream;
        this._deviceTrack = track;
        this._setLifecycle({ state: 'live', track });
        // Installs the device output via `use-device`, or builds the mix
        // if a mixin was set before the device opened — fanout
        // `(output, null)` is the open case the store expects.
        this._reconcileOutput();
        return true;
      } finally {
        this._openingPromise = null;
        // A `setMixin` that arrived while this open was in flight was
        // deferred onto it (see `setMixin`). The reconcile above settles
        // it when the device opened; when the open failed the mixin is
        // still a source on its own, so settle it here instead of
        // dropping it — a share survives a microphone that will not open.
        // Either way this leaves a mix or, if the graph itself refused,
        // a reported drop (`_reconcileOutput`'s build arm), never a
        // mixin held silently.
        if (isLiveTrack(this._mixin)) this._reconcileOutput();
      }
    })();

    return this._openingPromise;
  }

  /**
   * The `ended` event on the currently-installed track. Observation only
   * — it writes the lifecycle and stops there. Reopening the device is
   * Task 3's reconciler's job, which polls `lifecycle` on the presence
   * tick as the correctness backstop if this edge is ever missed (a
   * suspended tab, a browser that doesn't fire `ended` reliably).
   */
  private _onTrackEnded(track: MediaStreamTrack): void {
    if (this._deviceTrack !== track) return; // stale event from a superseded track
    this._setLifecycle({ state: 'ended', endedAt: this.bindings.now() });
  }

  private _setLifecycle(next: CaptureLifecycle): void {
    this._lifecycle = next;
    try {
      this.bindings.onLifecycleChange(next);
    } catch (e) {
      console.warn('MicSource: onLifecycleChange handler threw', e);
    }
    // A new device track is live: tell the consumers bound to the raw
    // microphone (see `MicConsumerOptions.onDeviceTrackChanged`). This is
    // the device-side twin of `_installOutputTrack`'s consumer fanout, and
    // it fires from here because this is the one write of the device
    // lifecycle — both open paths and `_openAndSwap` land on it.
    if (next.state === 'live') {
      for (const c of this.consumers.values()) {
        try { c.onDeviceTrackChanged?.(next.track); } catch (e) {
          console.warn(`MicSource: consumer "${c.id}" onDeviceTrackChanged threw`, e);
        }
      }
    }
  }

  /**
   * Close the microphone. The mixin OUTLIVES it: a share of what the
   * machine is playing does not belong to the mic, so the reconcile below
   * drops the mic's node from the graph and keeps the same output track
   * (no fanout, no renegotiation) rather than tearing the share down with
   * the device. With no mixin the reconcile clears the output, which is
   * the close every consumer and peer sees.
   */
  private _closeDevice(): void {
    const old = this._deviceTrack;
    const oldStream = this._rawStream;
    this._deviceTrack = null;
    this._rawStream = null;
    this._setLifecycle({ state: 'idle' });
    this._reconcileOutput();
    // Stop the old tracks last (the order `_openAndSwap` documents), so the
    // fanout above observed live tracks.
    if (oldStream) {
      try { oldStream.getTracks().forEach(t => t.stop()); } catch {}
    } else if (old) {
      try { old.stop(); } catch {}
    }
  }

  private _notifyMixinDropped(reason: 'mix-failed' | 'mixin-ended'): void {
    try { this.bindings.onMixinDropped(reason); } catch (e) {
      console.error('MicSource: onMixinDropped binding threw', e);
    }
  }

  /** Apply decideMicOutput to the current device/mixin state. Returns true iff the output includes the mixin. */
  private _reconcileOutput(): boolean {
    const current = this._mix
      ? { mode: 'mixed' as const, device: this._mix.device, mixin: this._mix.mixin }
      : this._outputTrack ? { mode: 'device' as const } : null;
    const decision = decideMicOutput({ device: this._deviceTrack, mixin: this._mixin, current });
    switch (decision.kind) {
      case 'none':
        return this._mix !== null;
      case 'clear-output':
        this._installOutputTrack(null, this._outputTrack);
        return false;
      case 'use-device':
        this._installOutputTrack(this._deviceTrack, this._outputTrack);
        return false;
      case 'sync-mix-device': {
        // In place: the destination track does not change, so no consumer
        // rebuilds and no peer renegotiates when the mic goes on or off
        // during a share. A graph that refuses the node falls through to a
        // full rebuild, which swaps through `_installOutputTrack`.
        if (this._syncMixDeviceNode()) return true;
        const old = this._outputTrack;
        const staleMix = this._detachMix();
        if (!this._buildMix()) {
          this._mixin = null;
          this._installOutputTrack(this._deviceTrack, old);
          this._stopTracks(staleMix);
          this._notifyMixinDropped('mix-failed');
          return false;
        }
        this._installOutputTrack(this._mix!.destination.stream.getAudioTracks()[0], old);
        this._stopTracks(staleMix);
        return true;
      }
      case 'tear-mix': {
        const old = this._outputTrack;
        const staleMix = this._detachMix();
        // 'mixin-removed' is the caller's own `setMixin(null)`, which needs
        // no report; 'mixin-ended' is MicSource dropping a mixin it was
        // asked to hold, which the store must hear about.
        // A closed microphone no longer reaches this arm at all — the
        // graph keeps running on the mixin alone.
        const dropped = decision.reason === 'mixin-ended' ? decision.reason : null;
        if (dropped) this._mixin = null;
        this._installOutputTrack(this._deviceTrack, old);
        this._stopTracks(staleMix);
        if (dropped) this._notifyMixinDropped(dropped);
        return false;
      }
      case 'build-mix': {
        // The previous graph's destination track is stopped only after the
        // swap has fanned out (the order `_openAndSwap` documents).
        const old = this._outputTrack;
        const staleMix = this._detachMix();
        if (!this._buildMix()) {
          // No Web Audio, or the graph refused the nodes: keep the device
          // path and drop the request — and say so, since the store may
          // still be holding a capture for it.
          this._mixin = null;
          if (old !== this._deviceTrack) this._installOutputTrack(this._deviceTrack, old);
          this._stopTracks(staleMix);
          this._notifyMixinDropped('mix-failed');
          return false;
        }
        this._installOutputTrack(this._mix!.destination.stream.getAudioTracks()[0], old);
        this._stopTracks(staleMix);
        return true;
      }
      default: {
        const exhaustive: never = decision;
        void exhaustive;
        return false;
      }
    }
  }

  private _buildMix(): boolean {
    const ctx = this.ensureAudioContext();
    // The microphone is optional here: a share with the mic closed is a
    // one-source graph. The mixin is not — it is what a graph is for.
    const device = isLiveTrack(this._deviceTrack) ? this._deviceTrack : null;
    const mixin = this._mixin;
    if (!ctx || !mixin) return false;
    // The caller has already detached any previous graph (`_detachMix`).
    // A suspended context would produce a silent destination track;
    // `ensureAudioContext` resumes only at creation, so resume again here
    // (a no-op while running, never awaited — the graph is built either way).
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const deviceNode = device
        ? ctx.createMediaStreamSource(new MediaStream([device]))
        : null;
      const mixinNode = ctx.createMediaStreamSource(new MediaStream([mixin]));
      const destination = ctx.createMediaStreamDestination();
      // Mono, deliberately: the device track is opened mono by constraint
      // (`_audioConstraints`, channelCount: 1), the host's capture is mono
      // by request, and the voice module's
      // AudioEncoder is configured `numberOfChannels: 1`
      // (`ui/src/room/modules/voice.ts`). A MediaStreamAudioDestinationNode
      // defaults to 2 channels, and feeding 2-channel AudioData into a
      // 1-channel encoder closes it — voice over signals would go silent
      // for the rest of the session. The node's channelCountMode is
      // 'explicit', so this downmixes the sum to one channel.
      destination.channelCount = 1;
      deviceNode?.connect(destination);
      mixinNode.connect(destination);
      this._mix = { device, mixin, deviceNode, mixinNode, destination };
      return true;
    } catch (e) {
      console.error('MicSource: building the mix graph failed', e);
      this._mix = null;
      return false;
    }
  }

  /**
   * Bring the microphone's node in the EXISTING graph into line with the
   * current device: add it, swap it, or drop it. The destination — and so
   * the output track every consumer and every peer holds — is untouched,
   * which is what makes turning the mic on or off mid-share free on the
   * wire. Returns false when the graph would not take the node; the old
   * node is already disconnected by then, so the caller rebuilds.
   */
  private _syncMixDeviceNode(): boolean {
    const mix = this._mix;
    if (!mix) return false;
    const device = isLiveTrack(this._deviceTrack) ? this._deviceTrack : null;
    try { mix.deviceNode?.disconnect(); } catch {}
    if (!device) {
      this._mix = { ...mix, device: null, deviceNode: null };
      return true;
    }
    const ctx = this.ensureAudioContext();
    if (!ctx) return false;
    try {
      const deviceNode = ctx.createMediaStreamSource(new MediaStream([device]));
      deviceNode.connect(mix.destination);
      this._mix = { ...mix, device, deviceNode };
      return true;
    } catch (e) {
      console.error('MicSource: syncing the mix device node failed', e);
      return false;
    }
  }

  /**
   * Disconnect the graph and hand back its destination tracks for the
   * caller to stop AFTER the output swap has fanned out — the same
   * stop-the-old-last order `_openAndSwap` keeps, so no consumer sees an
   * ended track before its replacement.
   */
  private _detachMix(): MediaStreamTrack[] {
    const mix = this._mix;
    if (!mix) return [];
    this._mix = null;
    try { mix.deviceNode?.disconnect(); } catch {}
    try { mix.mixinNode.disconnect(); } catch {}
    try { return mix.destination.stream.getAudioTracks(); } catch { return []; }
  }

  private _stopTracks(tracks: MediaStreamTrack[]): void {
    for (const t of tracks) {
      try { t.stop(); } catch {}
    }
  }

  /**
   * The ONE output swap: mute state applied, store fanout first
   * (replaceTrack on peers), then per-consumer rebuilds. `null` new is the
   * close case (fanout with the old output).
   */
  private _installOutputTrack(newTrack: MediaStreamTrack | null, oldTrack: MediaStreamTrack | null): void {
    if (newTrack === oldTrack) return;
    this._outputTrack = newTrack;
    this._applyMute();
    try {
      this.bindings.onTrackChange(newTrack, oldTrack);
    } catch (e) {
      console.warn('MicSource: onTrackChange threw on output swap', e);
    }
    if (newTrack) {
      for (const c of this.consumers.values()) {
        try { c.onTrackChanged?.(newTrack); } catch (e) {
          console.warn(`MicSource: consumer "${c.id}" onTrackChanged threw`, e);
        }
      }
    }
  }

  /** Include (or remove, with null) a second audio track in the output. Returns true iff the output now includes it. */
  setMixin(track: MediaStreamTrack | null): boolean {
    this._mixin = isLiveTrack(track) ? track : null;
    // A device open in flight (`_ensureOpen`'s stale path has cleared the
    // dead device while `getUserMedia` is pending) reconciles when it
    // lands. Reconciling now would tear the mix onto NO device — a close
    // fanout (removeTrack on every peer) followed by the open's addTrack, a
    // renegotiation per peer — where the deferred tear is one replaceTrack.
    // The answer is the recorded intent the open will honour, not the
    // old graph's existence.
    if (this._openingPromise) return this._mixin !== null;
    return this._reconcileOutput();
  }

  /** Resume the shared context under a user gesture (`systemAudioOn`
   *  runs under the menu click); a no-op without Web Audio or while running. */
  resumeAudioContext(): void {
    const ctx = this.ensureAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
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
