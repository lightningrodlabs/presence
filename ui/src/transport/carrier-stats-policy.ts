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
