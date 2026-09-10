// Copied from presence ui/src/room/modules/voice.ts at ab90584 (signals-media extraction). Presence keeps its own copy until the adoption round.
import { decidePlayout } from './voice-playout.js';
import { decideVoiceAdmission, nextVoiceEpoch } from './voice-admission.js';
import { estimatePlayoutSenderTimeMs, type PlayoutAnchor } from './av-sync.js';
import { VoiceCapture, VOICE_SAMPLE_RATE } from './voice-capture.js';
import { webCodecsOpus } from './opus-webcodecs.js';
import { bytesToBase64, base64ToBytes } from './base64.js';
import type {
  MediaClock,
  OpusCodec,
  OpusDecoder,
  OpusEncoder,
  OpusPacket,
  PeerId,
  TrackHandle,
  VoiceHost,
  VoiceRxStats,
} from './types.js';

/**
 * How long a playout anchor stays projectable after it was set. NOT a
 * liveness window — it serves A/V-sync projection validity, not any
 * liveness predicate (a stale anchor would drift open-loop; the jitter
 * buffer + drift cap horizon is ~0.5s, so 3s is comfortably past any
 * legitimate scheduling gap). Both sides of the comparison (`setAtMs`, the
 * read in `getPlayoutSenderTimeMs`) are local wall-clock stamps, per this
 * file's clock rule: presence-relevant stamps ride the host clock, local
 * scheduling arithmetic stays on wall clock.
 */
const PLAYOUT_ANCHOR_MAX_AGE_MS = 3000;

/**
 * Voice carrier — sends audio to a host-supplied set of peers over whatever
 * message channel the host owns (Holochain remote signals, a WebSocket, …).
 * No WebRTC.
 *
 * Capture: `host.acquireMic()` track → AudioWorklet (`voice-capture.ts`) →
 *          Opus encoder (`OpusCodec`, WebCodecs by default)
 * Wire   : { seq, ts, wts, ep, type, data(base64) } in JSON, sent via
 *          `host.send('voice', …)`; batches are `{ v: 2, frames }`
 * Play   : Opus decoder → AudioBufferSourceNode scheduled into a small
 *          jitter buffer
 *
 * The mic device is the host's: `acquireMic` yields a `TrackHandle` that
 * may be shared with other consumers (Presence shares it with WebRTC), so
 * muting is observed through `track.enabled` rather than owned here, and
 * the shared `AudioContext` comes from `host.audioContext()`.
 *
 * NOTE: intentionally minimal on the wire — no AEC beyond what
 * `getUserMedia` provides, no PLC, no FEC beyond the 2-frame `red`
 * redundancy, no per-peer subscription: every peer in `host.targets()`
 * receives every frame.
 */

/** Default clock when unbound; `bind()` adopts the host's. */
const systemClock: MediaClock = { now: () => Date.now() };

/** Where the worklet module lives when the host does not override it. */
const defaultWorkletUrl = (): string =>
  new URL('./voice-capture-worklet.js', import.meta.url).href;

export interface VoiceFrame {
  seq: number;
  ts: number; // microseconds (matches WebCodecs timestamp)
  type: 'key' | 'delta';
  data: string; // base64-encoded packet bytes
  /**
   * Sender wall-clock ms (`Date.now()`) at encoder output — the shared
   * cross-carrier timebase. Filmstrip clips stamp the same sender clock
   * (`t0`), so a receiver can measure audio/video skew by comparing the
   * two without any clock sync between machines. Carries a small
   * constant bias (frame duration + encode time, ~25ms) which cancels
   * out of skew deltas. Absent on legacy senders.
   */
  wts?: number;
  /**
   * Capture-session epoch: `nextVoiceEpoch` per `startCapture`
   * (voice-admission.ts). `seq` restarts at 1 for every capture session
   * (stopCapture resets it), so the receiver needs the session identity
   * to admit a restarted sender instead of dropping it against the old
   * high-water — the 2026-08-26 deafness. Absent on legacy senders,
   * which keep the pre-epoch dedupe (declared limitation).
   */
  ep?: number;
}

export interface VoiceFramePayload extends VoiceFrame {
  /**
   * Up to `redundancy` immediately-preceding frames, oldest→newest, carried
   * redundantly so a frame lost in its own packet can be recovered from the
   * copy piggybacked on a later packet. The signals carrier (Holochain
   * remote-signal relay) routinely drops 10–50% of packets. On the
   * per-frame path, RED-style redundancy makes any single (and most
   * double) consecutive packet losses fully recoverable for ~2× the
   * (tiny) audio bytes. On the batched path (`packVoiceFrames`) the block
   * rides only the batch's first frame and covers the `redundancy` frames
   * preceding the batch, so a wholly-lost batch loses `VOICE_BATCH_FRAMES`
   * frames and the next packet recovers `redundancy` of them — bounded
   * recovery, not near-zero loss. Absent on legacy senders — receivers
   * fall back to the single primary frame, so the wire format stays
   * compatible both ways.
   */
  red?: VoiceFrame[];
}

interface PeerVoiceState {
  decoder: OpusDecoder;
  /** audioContext.currentTime at which the next decoded frame should start */
  nextPlaybackTime: number;
  /** highest seq seen from this peer WITHIN the adopted session (for
   *  drop-old-packets; reset to 0 on session adoption) */
  lastSeq: number;
  /** Adopted capture-session epoch (frame `ep`); null before any
   *  epoch-bearing frame from this peer. */
  epoch: number | null;
  /** Host-clock ms of the last ACCEPTED frame — the quiet-window input
   *  to `decideVoiceAdmission`'s stale-epoch fallback arm. 0 = none. */
  lastAcceptedMs: number;
  /** wall-clock ms at which we received the previous frame (for jitter calc) */
  lastArrivalMs: number;
  /** EWMA of inter-arrival deviation from the 20ms Opus nominal period */
  jitterEwma: number;
  /** Count of lost packets inferred from seq gaps (rolling window) */
  lostCount: number;
  /** Count of packets received in the rolling window */
  receivedCount: number;
  /** Wall-clock ms of the window start */
  windowStartMs: number;
  /**
   * Encoder timestamp (µs) → sender wall-clock ms (`wts`), bridging
   * the encoded frame (which carries wts) to the decoded PCM (which only
   * carries the µs timestamp) across the async decoder. Entries are
   * deleted at playout; pruned by size as a leak guard for frames the
   * decoder swallows.
   */
  wtsByTs: Map<number, number>;
  /**
   * Sender-time ↔ audio-clock mapping of the most recently scheduled
   * frame. Null until a frame carrying `wts` has been scheduled.
   */
  playoutAnchor: PlayoutAnchor | null;
}

const JITTER_BUFFER_MS = 80;
const PLAYBACK_RESET_DRIFT_MS = 400;

/**
 * Frames per batched voice signal when the host reports every current
 * target as batch-capable (`VoiceHost.batchEligible()`; Presence gates that
 * on the `voice-batch-v1` capability). Batching adds ≤ `VOICE_BATCH_FRAMES`
 * × 20 ms = 60 ms send latency — inside the existing 80 ms jitter buffer
 * (`JITTER_BUFFER_MS`) — and cuts the send rate from 50/s to ~17/s, which
 * is what stops the voice sender from collapsing a signal relay under load.
 * NOT a liveness threshold: it serves send cadence only.
 */
export const VOICE_BATCH_FRAMES = 3;

/** Wire encoding of a voice batch: `{ v: 2, frames }`. Receivers accept
 *  this AND the legacy single-object payload regardless of capability —
 *  the host's eligibility verdict gates what we *send*, never what we can
 *  parse. */
export function packVoiceFrames(frames: VoiceFramePayload[]): string {
  return JSON.stringify({ v: 2, frames });
}

/** Inverse of `packVoiceFrames`, tolerant of legacy senders: a v2 batch
 *  yields its frames, any other JSON value is treated as one legacy
 *  single-frame payload (`[obj]`). Throws only on non-JSON — callers keep
 *  the drop-one-signal try/catch. */
export function unpackVoicePayload(json: string): VoiceFramePayload[] {
  const parsed = JSON.parse(json);
  if (parsed && parsed.v === 2 && Array.isArray(parsed.frames)) return parsed.frames;
  return [parsed];
}

export class VoiceCarrier {
  private host: VoiceHost | null = null;

  /** Host clock while bound (see bind()); wall clock otherwise. */
  private _clock: MediaClock = systemClock;

  // Send-side state (capture pipeline)
  private micHandle: TrackHandle | null = null;

  /** The resolved Opus backend — `host.codec?.()`, else WebCodecs. */
  private codec: OpusCodec | null = null;

  private encoder: OpusEncoder | null = null;

  /** The portable capture pump (AudioWorklet); see voice-capture.ts. */
  private capture = new VoiceCapture();

  private seq = 0;

  /**
   * Capture-session epoch stamped on every outgoing frame (`ep`).
   * Assigned per startCapture via `nextVoiceEpoch` — wall clock forced
   * strictly past the previous value, so it is unique across app
   * restarts and ordered within one. Deliberately NOT reset in
   * stopCapture (monotonicity is the property; `seq` is what resets).
   */
  private epoch = 0;

  /**
   * Number of preceding frames to carry redundantly on each packet (RED-style
   * loss recovery for the lossy signals carrier). 2 recovers any single, and
   * most double, consecutive packet losses for ~2× audio bytes. 0 disables.
   */
  private redundancy = 2;

  /** Ring of the last `redundancy` encoded frames, oldest→newest. */
  private redBuffer: VoiceFrame[] = [];

  /**
   * Frames accumulated toward the next batched send (see
   * `handleEncodedPacket`). Non-empty only while `host.batchEligible()`.
   * Dropped — never sent — on `stopCapture()`: by then the buffered audio
   * is stale, and a trailing send would race the teardown that stopped the
   * capture.
   */
  private batchBuffer: VoiceFramePayload[] = [];

  // Receive-side state
  private audioContext: AudioContext | null = null;

  private peers = new Map<PeerId, PeerVoiceState>();

  /** Peers already told (once) that no Opus backend is available. */
  private _noCodecLogged = new Set<PeerId>();

  /**
   * Per-peer peak audio level from the most recent decoded frame.
   * Range 0.0–1.0. Written in playPcm, read by the host on its own render
   * cycle (a plain Map, not a reactive store, to avoid triggering
   * re-renders at 50 fps). Entries are removed when a peer's decoder is
   * closed.
   */
  peerAudioLevels = new Map<PeerId, number>();

  /**
   * Host-clock ms of the last voice frame we sent TO this peer. Updated in
   * handleEncodedPacket per target. Consumers compare against
   * `host.clock.now()` to decide if audio is actively flowing in each
   * direction.
   */
  peerLastSentMs = new Map<PeerId, number>();

  /**
   * Host-clock ms of the last voice frame we received FROM this peer.
   * Updated in receiveFrame.
   */
  peerLastRecvMs = new Map<PeerId, number>();

  /**
   * Per-peer receive quality over the last ~1s window. This replaces
   * Presence's `store.signalsStats` write: the carrier owns the voice half
   * (jitter, loss) and a host merges it into whatever wider stats record it
   * keeps.
   */
  voiceRxStats = new Map<PeerId, VoiceRxStats>();

  /** Diagnostic (investigate/signals-double-audio): cumulative playout-head
   *  resets per peer, split by branch. `overcap-drop` is the burst-overlap
   *  avoidance; a non-trivial count there confirms the double-audio mechanism. */
  private _playoutResetCounts = new Map<PeerId, { behind: number; overcapDrop: number }>();

  /** Throttle for VoicePlayoutReset logging (one line per peer per ~2s). */
  private _lastPlayoutLogMs = new Map<PeerId, number>();

  bind(host: VoiceHost) {
    this.host = host;
    // Presence-relevant stamps (peerLastRecvMs) share the host's clock so
    // the host's freshness comparisons read the same timebase.
    // Wire-timestamp arithmetic (jitter/transit vs the sender's payload.ts)
    // deliberately stays on wall-clock Date.now().
    this._clock = host.clock;
  }

  unbind() {
    this.stopCapture().catch(() => {});
    for (const [, p] of this.peers) {
      try {
        p.decoder.close();
      } catch {
        // decoder already closed
      }
    }
    this.peers.clear();
    this.peerAudioLevels.clear();
    this.peerLastSentMs.clear();
    this.peerLastRecvMs.clear();
    this.voiceRxStats.clear();
    this._playoutResetCounts.clear();
    this._lastPlayoutLogMs.clear();
    this._noCodecLogged.clear();
    // The AudioContext is the host's — drop the reference, don't close it.
    // It stays alive across deactivate/reactivate and is disposed by the
    // host.
    this.audioContext = null;
    this.codec = null;
    this.host = null;
    this._clock = systemClock;
  }

  get isBound(): boolean {
    return this.host !== null;
  }

  // ----- arrival/leave squelch (synth, no assets) ------------------------
  //
  // Cheap walkie-talkie idiom: a short burst of band-limited noise with a
  // sharp attack and a quick decay. Two slightly different tunings for
  // arrive vs leave so the ear can tell them apart even at low volume.

  playSquelch(direction: 'up' | 'down') {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = 0.09; // 90 ms

    // Short white-noise buffer.
    const sampleCount = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter — different center for up vs down.
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = direction === 'up' ? 1800 : 1100;
    filter.Q.value = 4;

    // Gain envelope: fast attack, exponential decay.
    const gain = ctx.createGain();
    const peak = 0.18;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    source.start(now);
    source.stop(now + dur + 0.02);
  }

  // ----- send side --------------------------------------------------------

  async startCapture(): Promise<boolean> {
    if (!this.host) return false;
    if (this.micHandle) return true;

    // AudioWorklet is the capture path (design spec decision 5); the ENCODER
    // requirement is the codec seam's business, not a global probe — a host
    // on an engine without WebCodecs audio passes `wasmOpus()` instead.
    const g: any = globalThis as any;
    if (!g.AudioWorkletNode) {
      console.error('voice: AudioWorklet not available');
      return false;
    }

    const codec = this.resolveCodec();
    if (!codec) {
      console.error(
        'voice: no Opus codec available (pass VoiceHost.codec, e.g. wasmOpus())'
      );
      return false;
    }

    // New capture session, new epoch — assigned before acquisition so a
    // failed attempt burns an epoch harmlessly (the receiver never saw
    // it) rather than ever reusing one. Device-change rebuilds
    // (onMicTrackChanged) deliberately do NOT come through here: the
    // encoder and seq continue uninterrupted, so the session identity
    // must too.
    this.epoch = nextVoiceEpoch(Date.now(), this.epoch);

    // Acquire the mic from the host. The device may already be open for
    // another consumer (Presence shares it with WebRTC), in which case both
    // consumers get the same track.
    const handle = await this.host.acquireMic((newTrack: MediaStreamTrack) => {
      this.onMicTrackChanged(newTrack).catch(e =>
        console.error('voice: onMicTrackChanged failed', e)
      );
    });
    if (!handle) {
      console.error('voice: acquireMic failed');
      return false;
    }
    this.micHandle = handle;

    try {
      this.encoder = codec.createEncoder(
        (p: OpusPacket) => this.handleEncodedPacket(p),
        (e: unknown) => console.error('voice: encoder error', e)
      );
    } catch (e) {
      console.error('voice: encoder configure failed', e);
      this.stopCapture().catch(() => {});
      return false;
    }

    const ctx = this.host.audioContext();
    if (!ctx) {
      console.error('voice: no AudioContext for capture');
      this.stopCapture().catch(() => {});
      return false;
    }
    const ok = await this.capture.start(
      ctx,
      handle.track,
      (pcm, ts) => this.encodePcm(pcm, ts),
      this.host.workletModuleUrl?.() ?? defaultWorkletUrl()
    );
    if (!ok) {
      this.stopCapture().catch(() => {});
      return false;
    }
    return true;
  }

  /**
   * Called by the host when the shared track is replaced (device change).
   * Only the capture graph's source node is rebound — the encoder stays
   * (it is track-agnostic) so seq numbers and timestamps continue
   * uninterrupted and peers' decoders don't see a discontinuity.
   */
  private async onMicTrackChanged(newTrack: MediaStreamTrack): Promise<void> {
    if (!this.micHandle) return;
    const ctx = this.host?.audioContext() ?? null;
    if (!ctx) {
      console.error('voice: no AudioContext to rebind capture after device change');
      return;
    }
    this.capture.replaceTrack(ctx, newTrack);
  }

  /**
   * One 20 ms block out of the capture worklet. The mute gate is the shared
   * track's `enabled` flag: a host muting the device flips it across every
   * consumer at once, so muting silences voice without voice subscribing to
   * any separate mute event.
   */
  private encodePcm(pcm: Float32Array, timestampUs: number): void {
    const track = this.micHandle?.track;
    if (track && track.enabled === false) {
      // Same rationale as the paused-cadence clear in
      // handleEncodedPacket (review I1, final-review wave F4): frames
      // buffered before a mute are stale by the whole mute duration —
      // left in place they would lead the first post-unmute flush,
      // resetting playout and poisoning av-sync on the receiver.
      this.batchBuffer = [];
      return;
    }
    try {
      this.encoder?.encode(pcm, timestampUs);
    } catch (e) {
      console.error('voice: encode failed', e);
    }
  }

  /** The host's backend if it supplies one, else WebCodecs (null on an
   *  engine with neither). */
  private resolveCodec(): OpusCodec | null {
    this.codec = this.host?.codec?.() ?? webCodecsOpus();
    return this.codec;
  }

  private handleEncodedPacket(p: OpusPacket) {
    if (!this.host) return;
    // Read the host's current target set. Empty = nobody to send to.
    const targets = this.host.targets();
    if (targets.size === 0) return;
    // Cadence gate (the host's `decideSignalsMediaCadence` verdict):
    // `paused` gates the SEND only — capture teardown remains the host's,
    // so recovery is just this check reading a different mode. Voice keeps
    // sending in 'voice-only'; frames encoded while paused are dropped, not
    // buffered (stale audio).
    if (this.host.cadence() === 'paused') {
      // A pause also discards any partially-accumulated batch (review
      // I1): a pause lasts seconds-to-minutes, so frames buffered before
      // it are stale audio by resume time — left in place they led the
      // first post-resume batch (a playout reset, and their old `wts`
      // briefly poisoning av-sync). The dropped seqs read as ordinary
      // loss at the receiver — truthful accounting.
      this.batchBuffer = [];
      return;
    }
    const frame: VoiceFrame = {
      // Pre-increment: session seqs start at 1, keeping seq 0 free as the
      // receiver's "nothing accepted yet" sentinel (which session adoption
      // resets lastSeq to).
      seq: ++this.seq,
      ts: p.timestampUs,
      type: p.type,
      data: bytesToBase64(p.data),
      wts: Date.now(),
      ep: this.epoch,
    };

    // Batching applies only when EVERY current target is batch-capable: the
    // payload is one broadcast, so a single legacy peer forces per-frame for
    // everyone (mixed room ⇒ legacy). Batching adds ≤ VOICE_BATCH_FRAMES ×
    // 20 ms = 60 ms send latency — inside the 80 ms jitter buffer.
    // Receivers parse both formats regardless of capability
    // (`unpackVoicePayload`).
    if (this.host.batchEligible()) {
      // RED stays at `redundancy` (2) and rides the batch's PRIMARY —
      // its first frame: at this point `redBuffer` holds exactly the
      // frames preceding the batch, i.e. the ones a lost previous packet
      // took. Later batch members carry no red block — their
      // predecessors travel in the same packet, so a copy would be
      // in-packet duplication with zero loss protection.
      const payload: VoiceFramePayload =
        this.batchBuffer.length === 0 && this.redundancy > 0 && this.redBuffer.length > 0
          ? { ...frame, red: this.redBuffer.slice() }
          : frame;
      this.batchBuffer.push(payload);
      this.retainForRed(frame);
      if (this.batchBuffer.length < VOICE_BATCH_FRAMES) return;
      const packed = packVoiceFrames(this.batchBuffer);
      this.batchBuffer = [];
      this.stampSent(targets);
      this.host.send('voice', packed, targets).catch(() => {});
      return;
    }

    // Legacy per-frame path — the wire shape every released build parses.
    // A capability flip mid-batch (a legacy peer just became a target)
    // flushes the buffered frames per-frame first, so they are neither
    // stranded nor reordered behind newer frames.
    if (this.batchBuffer.length > 0) {
      const buffered = this.batchBuffer;
      this.batchBuffer = [];
      for (const b of buffered) {
        this.host.send('voice', JSON.stringify(b), targets).catch(() => {});
      }
    }
    const payload: VoiceFramePayload =
      this.redundancy > 0 && this.redBuffer.length > 0
        ? { ...frame, red: this.redBuffer.slice() }
        : frame;
    this.retainForRed(frame);
    this.stampSent(targets);
    this.host.send('voice', JSON.stringify(payload), targets).catch(() => {});
  }

  /** Retain a frame to piggyback redundantly on subsequent packets. */
  private retainForRed(frame: VoiceFrame): void {
    if (this.redundancy <= 0) return;
    this.redBuffer.push(frame);
    while (this.redBuffer.length > this.redundancy) this.redBuffer.shift();
  }

  /** Local send stamp (not a wire timestamp — `wts` is that, and stays
   *  wall-clock). Consumers compare this against peerLastRecvMs, so both
   *  must share the host's timebase. Stamped at actual send time —
   *  batching defers it by ≤ 60 ms, well inside every consumer's window. */
  private stampSent(targets: ReadonlySet<PeerId>): void {
    const now = this._clock.now();
    for (const peer of targets) {
      this.peerLastSentMs.set(peer, now);
    }
  }

  async stopCapture(): Promise<void> {
    this.capture.stop();
    if (this.encoder) {
      try {
        this.encoder.close();
      } catch {
        // encoder already closed
      }
      this.encoder = null;
    }
    if (this.micHandle) {
      try {
        this.micHandle.release();
      } catch {
        // handle already released
      }
      this.micHandle = null;
    }
    this.seq = 0;
    this.redBuffer = [];
    // Drop, don't send: buffered batch frames are stale audio by the time
    // capture stops, and a trailing send would race the teardown that
    // stopped us (see `batchBuffer`).
    this.batchBuffer = [];
  }

  // ----- receive side -----------------------------------------------------

  /**
   * Sender wall-clock time (ms) of the audio currently audible from this
   * peer, projected from the most recent playout anchor along the audio
   * clock. Null when no anchored audio is flowing (peer never sent `wts`,
   * voice idle/muted, or the anchor is stale). A filmstrip display uses
   * this to measure audio/video skew on the shared sender timebase.
   */
  getPlayoutSenderTimeMs(peer: PeerId): number | null {
    const state = this.peers.get(peer);
    const anchor = state?.playoutAnchor;
    if (!state || !anchor) return null;
    if (Date.now() - anchor.setAtMs > PLAYOUT_ANCHOR_MAX_AGE_MS) return null;
    const ctx = this.audioContext;
    if (!ctx) return null;
    return estimatePlayoutSenderTimeMs(anchor, ctx.currentTime);
  }

  receiveFrame(peer: PeerId, chunk: string) {
    // Both wire formats, regardless of what the host advertises: a v2
    // batch yields its member payloads, a legacy sender yields one.
    let payloads: VoiceFramePayload[];
    try {
      payloads = unpackVoicePayload(chunk);
    } catch {
      return;
    }
    let state = this.peers.get(peer);
    if (!state) {
      const created = this.openPeer(peer);
      if (!created) return;
      state = created;
    }
    const st = state;
    // Per-payload admission (`decideVoiceAdmission`) — session-epoch
    // routing wrapped around the old playhead dedupe: a primary already
    // played means every redundant copy it carries is older still; a
    // batch member is judged on its own seq, exactly as its legacy
    // single-frame equivalent was. Also drops non-frame JSON a legacy
    // parse accepted. Adoption mutates the session state in payload
    // order, so later members of the adopting packet admit as
    // in-session.
    const nowClockMs = this._clock.now();
    const fresh: VoiceFramePayload[] = [];
    for (const p of payloads) {
      if (p == null || typeof p.seq !== 'number') continue;
      const admission = decideVoiceAdmission({
        epoch: typeof p.ep === 'number' ? p.ep : null,
        seq: p.seq,
        lastEpoch: st.epoch,
        lastSeq: st.lastSeq,
        msSinceAccepted: st.lastAcceptedMs === 0 ? null : nowClockMs - st.lastAcceptedMs,
      });
      switch (admission.action) {
        case 'adopt-session': {
          const prev = st.epoch;
          st.epoch = p.ep as number;
          st.lastSeq = 0;
          // Per-session playout mappings: the new encoder session restarts
          // its µs timestamps, so projecting through the old anchor/wts
          // entries would mis-anchor A/V sync until they aged out.
          st.playoutAnchor = null;
          st.wtsByTs.clear();
          this.host?.log(
            `VoiceSessionAdopt [${peer.slice(0, 8)}] ` +
              `epoch=${p.ep} prev=${prev ?? 'none'} seq=${p.seq} reason=${admission.reason}`
          );
          fresh.push(p);
          break;
        }
        case 'accept':
          fresh.push(p);
          break;
        case 'drop':
          break;
        default: {
          const exhaustive: never = admission;
          void exhaustive;
        }
      }
    }
    if (fresh.length === 0) return;

    st.lastAcceptedMs = nowClockMs;
    this.peerLastRecvMs.set(peer, nowClockMs);

    // --- jitter: EWMA of absolute deviation of packet inter-arrival from
    // the nominal period. Measured per PACKET (one signal arrival), not per
    // carried frame: a v2 batch of N frames nominally arrives N×20ms after
    // its predecessor, so the nominal period scales with the frame count
    // (legacy payloads keep the old 20ms). alpha = 0.1 for slow smoothing. ---
    const now = Date.now();
    if (state.lastArrivalMs > 0) {
      const delta = now - state.lastArrivalMs;
      // Cap the per-sample deviation. A frame arriving after a long
      // silence/stall produces a huge inter-arrival delta that is not
      // jitter — feeding it raw spiked the EWMA to nonsense values
      // (e.g. jit=148966ms in merged logs). 200ms is well past any real
      // jitter for 20ms Opus frames.
      const nominalMs = 20 * payloads.length;
      const deviation = Math.min(Math.abs(delta - nominalMs), 200);
      state.jitterEwma = 0.1 * deviation + 0.9 * state.jitterEwma;
    }
    state.lastArrivalMs = now;

    // Iterate batch members in order through the existing per-frame path.
    // For each payload: assemble redundant (older) frames + the primary,
    // ascending by seq, and play any we haven't yet. A frame dropped in its
    // own packet is recovered here from the copy piggybacked on a later
    // packet. Loss is counted post-recovery and per FRAME (not per packet):
    // only seqs carried by NO packet count as lost, which is exactly the
    // UX-relevant figure — a wholly-lost batch of 3 counts 3.
    for (const payload of fresh) {
      const frames: VoiceFrame[] = [];
      if (Array.isArray(payload.red)) {
        for (const f of payload.red) frames.push(f);
      }
      frames.push({
        seq: payload.seq,
        ts: payload.ts,
        type: payload.type,
        data: payload.data,
        wts: payload.wts,
      });
      frames.sort((a, b) => a.seq - b.seq);

      for (const f of frames) {
        if (state.lastSeq !== 0 && f.seq <= state.lastSeq) continue; // already played
        if (state.lastSeq !== 0) {
          const gap = f.seq - state.lastSeq - 1;
          if (gap > 0) state.lostCount += gap;
        }
        state.receivedCount += 1;
        this.decodeVoiceFrame(state, f);
        state.lastSeq = f.seq;
      }
    }

    // Publish stats on a ~1s cadence (when the window closes). Computing
    // per-frame would write 50 times/sec for no visual benefit.
    if (now - state.windowStartMs >= 1000) {
      const total = state.receivedCount + state.lostCount;
      const loss = total > 0 ? (state.lostCount / total) * 100 : 0;
      const existing = this.voiceRxStats.get(peer) ?? {
        jitterMs: null,
        lossPercent: null,
      };
      existing.jitterMs = Math.round(state.jitterEwma * 10) / 10;
      existing.lossPercent = Math.round(loss * 10) / 10;
      this.voiceRxStats.set(peer, existing);
      state.lostCount = 0;
      state.receivedCount = 0;
      state.windowStartMs = now;
    }
  }

  /** Hand one frame's packet to the peer decoder. */
  private decodeVoiceFrame(state: PeerVoiceState, frame: VoiceFrame) {
    // Remember the sender wall-clock stamp so playPcm (which only sees the
    // decoded µs timestamp) can anchor sender time to the audio clock.
    // Prune oldest entries if the decoder swallows frames without emitting
    // output (insertion order = oldest first).
    if (typeof frame.wts === 'number') {
      state.wtsByTs.set(frame.ts, frame.wts);
      if (state.wtsByTs.size > 64) {
        const oldest = state.wtsByTs.keys().next().value;
        if (oldest !== undefined) state.wtsByTs.delete(oldest);
      }
    }
    // The backend contains its own failures (the WebCodecs one logs and
    // returns); this catch keeps a throwing third-party codec from taking
    // the whole receive loop down with one bad frame, as Presence's
    // per-frame try/catch did.
    try {
      state.decoder.decode({
        type: frame.type,
        timestampUs: frame.ts,
        data: base64ToBytes(frame.data),
      });
    } catch (e) {
      console.error('voice: decode failed', e);
    }
  }

  private ensureAudioContext(): AudioContext | null {
    if (this.audioContext) return this.audioContext;
    // Borrow the host's shared context. On unbind we drop the reference but
    // don't close it — disposal is the host's.
    if (!this.host) return null;
    const ac = this.host.audioContext();
    this.audioContext = ac;
    return ac;
  }

  private openPeer(peer: PeerId): PeerVoiceState | null {
    const codec = this.resolveCodec();
    if (!codec) {
      if (!this._noCodecLogged.has(peer)) {
        this._noCodecLogged.add(peer);
        console.error(
          'voice: no Opus codec available (pass VoiceHost.codec, e.g. wasmOpus())'
        );
      }
      return null;
    }
    const ctx = this.ensureAudioContext();
    if (!ctx) return null;

    const state: PeerVoiceState = {
      // Assigned immediately below — the decoder's output callback closes
      // over `state`, so the record has to exist first.
      decoder: null as unknown as OpusDecoder,
      nextPlaybackTime: 0,
      lastSeq: 0,
      epoch: null,
      lastAcceptedMs: 0,
      lastArrivalMs: 0,
      jitterEwma: 0,
      lostCount: 0,
      receivedCount: 0,
      windowStartMs: Date.now(),
      wtsByTs: new Map(),
      playoutAnchor: null,
    };
    try {
      state.decoder = codec.createDecoder(
        (pcm, ts) => this.playPcm(state, peer, pcm, ts),
        (e: unknown) => console.error(`voice: decoder error ${peer.slice(0, 8)}`, e)
      );
    } catch (e) {
      console.error('voice: decoder configure failed', e);
      return null;
    }
    this.peers.set(peer, state);
    return state;
  }

  /**
   * One decoded 20 ms block. Below the codec seam this is Presence's
   * `playAudioData` minus the AudioData→Float32 copy (the backend does it):
   * mono, `VOICE_SAMPLE_RATE`, `pcm.length` frames.
   */
  private playPcm(
    state: PeerVoiceState,
    peer: PeerId,
    pcm: Float32Array,
    timestampUs: number
  ) {
    const ctx = this.audioContext;
    if (!ctx) return;
    try {
      const sampleRate = VOICE_SAMPLE_RATE;
      const numberOfFrames = pcm.length;
      const buffer = ctx.createBuffer(1, numberOfFrames, sampleRate);
      // `getChannelData(0).set` rather than `copyToChannel`: identical for a
      // freshly created buffer, and it accepts the decoder's Float32Array
      // whatever backing buffer it carries.
      buffer.getChannelData(0).set(pcm);

      // Peak detection for the volume indicator. Sample every 10th
      // value — 96 iterations for a typical 960-sample Opus frame.
      // ~1 microsecond per peer, zero allocations.
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 10) {
        const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
        if (v > peak) peak = v;
      }
      this.peerAudioLevels.set(peer, peak);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const jitterSec = JITTER_BUFFER_MS / 1000;
      const driftSec = PLAYBACK_RESET_DRIFT_MS / 1000;
      const frameDurationSec = numberOfFrames / sampleRate;
      // Pure scheduling decision (see voice-playout.ts). The key property: for a
      // buffer that has drifted too deep (a relay-delivered backlog decoded
      // faster than real time) it DROPS the frame rather than re-anchoring the
      // head backward — re-anchoring would overlap audio already committed
      // ahead, the "voice on top of itself" bug.
      const prevHead = state.nextPlaybackTime;
      const decision = decidePlayout(prevHead, now, frameDurationSec, jitterSec, driftSec);
      state.nextPlaybackTime = decision.nextPlaybackTime;
      if (decision.reason === 'behind') {
        this._logPlayoutReset(peer, 'behind', now - prevHead);
      } else if (decision.reason === 'overcap-drop') {
        this._logPlayoutReset(peer, 'overcap-drop', prevHead - now);
      }
      // Resolve the sender wall-clock stamp for this frame (set in
      // decodeVoiceFrame keyed by the µs timestamp, which the decoder
      // preserves onto its output). Consumed whether we play or drop.
      const wts = state.wtsByTs.get(timestampUs);
      if (wts !== undefined) state.wtsByTs.delete(timestampUs);
      if (decision.action === 'drop') return;
      if (wts !== undefined) {
        state.playoutAnchor = {
          senderWtsMs: wts,
          atCtxSec: decision.at,
          setAtMs: Date.now(),
        };
      }
      source.start(decision.at);
    } catch (e) {
      console.error('voice: playback error', e);
    }
  }

  /**
   * Diagnostic for the hypothesized burst-overlap ("voice on top of itself")
   * bug. Counts playout-head re-anchors per peer and logs a throttled summary.
   * The `overcap-drop` branch is the one that previously snapped the head
   * backward and overlapped already-scheduled audio; sustained counts there
   * (correlate the timestamps against relay flaps to find the cadence driver)
   * are what would confirm the burst-delivery mechanism.
   */
  private _logPlayoutReset(
    peer: PeerId,
    branch: 'behind' | 'overcap-drop',
    aheadOrBehindSec: number
  ) {
    const c = this._playoutResetCounts.get(peer) ?? { behind: 0, overcapDrop: 0 };
    if (branch === 'behind') c.behind += 1;
    else c.overcapDrop += 1;
    this._playoutResetCounts.set(peer, c);

    const now = Date.now();
    const last = this._lastPlayoutLogMs.get(peer) ?? 0;
    if (now - last < 2000) return; // throttle
    this._lastPlayoutLogMs.set(peer, now);

    this.host?.log(
      `VoicePlayoutReset [${peer.slice(0, 8)}] branch=${branch} ` +
        `${branch === 'overcap-drop' ? 'ahead' : 'behind'}=${Math.round(aheadOrBehindSec * 1000)}ms ` +
        `totals: behind=${c.behind} overcap-drop=${c.overcapDrop}`
    );
  }
}
