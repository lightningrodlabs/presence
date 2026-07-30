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
