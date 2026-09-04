/**
 * Phase 4 item 2 — the one answer to "what are this peer's link stats,
 * and which carrier do they describe?"
 *
 * The stats panel used to pick the carrier by hand from
 * `hasWebrtcConnection` — *any* `_openConnections` entry, including a
 * half-open negotiation — while the store's own quality-bucket emission
 * keyed on `connected`. A half-open connection made the panel claim
 * `webrtc` with stale/empty `webrtcStats` while signals was actually
 * carrying the audio; the panel's own comment admitted the inference
 * "can lie". The carrier question already has an authority —
 * `carrierFor` (`carrier-coverage.ts`, keyed on ICE + DTLS up) — so this
 * decision delegates to it and only chooses which stats map to read.
 *
 * The two maps deliberately stay separate upstream (`webrtcStats` from
 * the getStats poll, `signalsStats` from pong-echo RTT + voice-frame
 * EWMAs): their numbers mean different things (Phase 4 item 4), and this
 * function is the single place that picks per the active carrier — it
 * never mixes fields across carriers.
 *
 * Constrains `StreamsStore.statsFor` and the peer-stats-panel.
 */

import type { CarrierStats } from '../types';
import { carrierFor, type WebrtcSlot } from './carrier-coverage';

export type PeerStatsSnapshot = {
  /** The peer's `_openConnections` entry (or absence). Only `connected` is read. */
  slot: WebrtcSlot | undefined;
  /** WebRTC-side stats: getStats poll via `summarizeRtcStats`. */
  webrtcStats: CarrierStats | undefined;
  /** Signals-side stats: pong-echo RTT EWMA + voice jitter/loss EWMAs. */
  signalsStats: CarrierStats | undefined;
};

export type PeerStats = {
  carrier: 'webrtc' | 'signals';
  /** Why that carrier: the `carrierFor` reason, carried for forensics. */
  reason: 'webrtc-connected' | 'no-webrtc-attempt' | 'webrtc-not-yet-connected';
  rttMs: number | null;
  jitterMs: number | null;
  lossPercent: number | null;
};

export function statsForPeer(snap: PeerStatsSnapshot): PeerStats {
  const coverage = carrierFor(snap.slot);
  const stats =
    coverage.carrier === 'webrtc' ? snap.webrtcStats : snap.signalsStats;
  return {
    carrier: coverage.carrier,
    reason: coverage.reason,
    rttMs: stats?.rttMs ?? null,
    jitterMs: stats?.jitterMs ?? null,
    lossPercent: stats?.lossPercent ?? null,
  };
}

// ---------------------------------------------------------------------------
// Signals-RTT fold (§9 item 4)
// ---------------------------------------------------------------------------

/**
 * Plausibility bound on a single pong-echo RTT sample — a sample at or
 * above this is a clock artifact (peer wall-clock step, machine resumed
 * from sleep), not a measurement, and is dropped rather than folded.
 * NOT-liveness (working agreement 2): this bounds a control/display
 * input, never a presence or reachability predicate — those live in
 * `presence-policy.ts`. Since the connection-thrash round the folded
 * value (the peer record's `signalsRttEwma`) feeds more than display: it is
 * `decideSignalsMediaCadence`'s `bestRttEwmaMs` input
 * (`signals-cadence-policy.ts`) and both `_computeSdpTimeout`
 * (streams-store.ts, delegating to `media-links.ts`) and
 * `_computeSdpBackstopTimeout`'s (media-links.ts) RTT-scaled ceilings
 * — cadence/timeout control and display, not display alone.
 */
export const SIGNALS_RTT_PLAUSIBLE_MAX_MS = 60_000;

/**
 * EWMA smoothing factor for the signals-carrier RTT. 0.3 gives a
 * ~3-sample effective window: enough to stop single-cycle jitter from
 * making the stats panel jump, small enough to track a real change
 * within a few ping cadences. NOT-liveness (working agreement 2) — same
 * predicate note as `SIGNALS_RTT_PLAUSIBLE_MAX_MS`: cadence/timeout
 * control and display, not display smoothing alone.
 */
export const SIGNALS_RTT_EWMA_ALPHA = 0.3;

export type SignalsRttFoldInputs = {
  /** Echoed ping t0 from the pong meta; undefined = peer on older code. */
  pingT0: number | undefined;
  /** Receive stamp, on the store clock (same clock that stamped t0). */
  now: number;
  /** Previous EWMA value for this peer, if any (the peer record's `signalsRttEwma`). */
  prevEwmaMs: number | undefined;
  /** The peer's `_openConnections` entry — carrier via `carrierFor`. */
  slot: WebrtcSlot | undefined;
};

export type SignalsRttFold =
  | { action: 'no-sample'; reason: 'no-ping-echo' }
  | { action: 'drop'; reason: 'implausible'; rawRttMs: number }
  | {
      action: 'fold';
      reason: 'signals-active' | 'webrtc-active';
      /** The new EWMA value: write it to the map and the stats entry. */
      ewmaMs: number;
      /**
       * The emit-gate half of the old interleave: evaluate the quality
       * bucket on the signals path ONLY when signals is the active
       * carrier — otherwise the webrtc getStats poll is the source of
       * truth and will emit if the bucket changes. Carrier by
       * `carrierFor`, the one carrier authority, never a hand-rolled
       * slot read.
       */
      emitQualityCheck: boolean;
    };

/**
 * The pong-echo RTT fold, extracted from `handlePongUi`'s inline block
 * (§9 item 4): sample plausibility, EWMA smoothing, and the
 * map-write/emit-gate interleave as one pure decision. The caller owns
 * the writes (the peer record's `signalsRttEwma`, `signalsStats`) and the
 * `_maybeEmitQualityChange` call; this function owns every number.
 *
 * Constrains `StreamsStore.handlePongUi`.
 */
export function foldSignalsRtt(input: SignalsRttFoldInputs): SignalsRttFold {
  if (input.pingT0 === undefined) {
    return { action: 'no-sample', reason: 'no-ping-echo' };
  }
  const raw = input.now - input.pingT0;
  if (raw < 0 || raw >= SIGNALS_RTT_PLAUSIBLE_MAX_MS) {
    return { action: 'drop', reason: 'implausible', rawRttMs: raw };
  }
  const prev = input.prevEwmaMs ?? raw;
  const ewmaMs = Math.round(
    SIGNALS_RTT_EWMA_ALPHA * raw + (1 - SIGNALS_RTT_EWMA_ALPHA) * prev
  );
  const carrier = carrierFor(input.slot).carrier;
  return {
    action: 'fold',
    reason: carrier === 'signals' ? 'signals-active' : 'webrtc-active',
    ewmaMs,
    emitQualityCheck: carrier === 'signals',
  };
}

// ---------------------------------------------------------------------------
// Flow glyph (Round 3 item 5)
// ---------------------------------------------------------------------------

export type FlowGlyph = 'both' | 'tx' | 'rx' | 'idle' | 'muted';

export type FlowGlyphInputs = {
  /** The active carrier, from `statsForPeer` — never re-derived. */
  carrier: 'webrtc' | 'signals';
  now: number;
  /**
   * The media-flowing predicate's window (`MEDIA_LIVE_WINDOW_MS`) — the
   * same window `isMediaLive` applies to signals frames. One window per
   * predicate (working agreement 2).
   */
  windowMs: number;
  /** Signals arm: is the local voice encoder running (tx gate)? */
  encoderRunning: boolean;
  /** Signals arm: last frame sent/received stamps, on the store clock. */
  lastSentMs: number | undefined;
  lastRecvMs: number | undefined;
  /**
   * WebRTC arm: the slot's `connected` claim (ICE + DTLS up) — the
   * WebRTC half of the media-flowing predicate (`isMediaLive` treats
   * `webrtcConnected` as flow; there are no per-frame stamps on this
   * carrier).
   */
  webrtcConnected: boolean;
  /** WebRTC arm: a remote audio track has arrived on the connection. */
  webrtcAudioIn: boolean;
  /** The audio-link roll-up says the peer is muted (`decideAudioLink`). */
  linkMuted: boolean;
};

export type FlowGlyphDecision = {
  flow: FlowGlyph;
  reason:
    | 'signals-frames'
    | 'signals-window-empty'
    | 'webrtc-flowing'
    | 'webrtc-not-flowing'
    | 'muted-overrides-idle';
};

/**
 * The tx/rx flow glyph for the stats panel — extracted from
 * `peer-stats-panel._tick`, where the two carrier arms answered
 * different questions under a comment claiming they were the same
 * predicate: the signals arm windowed frame stamps on
 * `MEDIA_LIVE_WINDOW_MS` while the WebRTC arm read raw slot fields with
 * no window and no `connected` requirement on rx.
 *
 * Both arms now answer via the media-flowing predicate's rules
 * (`isMediaLive`): signals flow is frame stamps inside `windowMs`;
 * WebRTC flow is keyed on `connected` — declared change: with
 * `connected` false, a leftover `audio` flag on the slot can no longer
 * paint an rx glyph.
 *
 * The muted glyph wins over idle but never over actual flow.
 *
 * Constrains `peer-stats-panel.ts:_tick`.
 */
export function decideFlowGlyph(input: FlowGlyphInputs): FlowGlyphDecision {
  let tx: boolean;
  let rx: boolean;
  if (input.carrier === 'signals') {
    tx =
      input.encoderRunning &&
      input.lastSentMs !== undefined &&
      input.now - input.lastSentMs < input.windowMs;
    rx =
      input.lastRecvMs !== undefined &&
      input.now - input.lastRecvMs < input.windowMs;
  } else {
    tx = input.webrtcConnected;
    rx = input.webrtcConnected && input.webrtcAudioIn;
  }
  const flow: FlowGlyph = tx && rx ? 'both' : tx ? 'tx' : rx ? 'rx' : 'idle';
  if (flow === 'idle' && input.linkMuted) {
    return { flow: 'muted', reason: 'muted-overrides-idle' };
  }
  if (input.carrier === 'signals') {
    return {
      flow,
      reason: flow === 'idle' ? 'signals-window-empty' : 'signals-frames',
    };
  }
  return {
    flow,
    reason: flow === 'idle' ? 'webrtc-not-flowing' : 'webrtc-flowing',
  };
}
