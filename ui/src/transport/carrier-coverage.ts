/**
 * Phase 1 — pure decision logic for which carrier is responsible for a
 * present peer, and therefore which peers the signals carrier must keep
 * transmitting to.
 *
 * The invariant this enforces:
 *
 * > **For every peer that is present, at least one carrier must be actively
 * > transmitting.** No peer may be simultaneously excluded from
 * > `_signalsTargets` and not flowing on WebRTC. Handover is
 * > make-before-break.
 *
 * `_signalsTargets` was `activeAgents \ openConnections` — membership
 * required that *no entry exist* in `_openConnections`. But an entry is
 * installed the moment WebRTC signaling begins, with `connected: false`, so
 * a peer left the signals carrier at the **start** of a negotiation and did
 * not rejoin until the entry was deleted. Every negotiation opened a
 * silence window, each retry cycle reopened it, and a wedged entry closed
 * the carrier for that peer permanently
 * (MAINTAINABILITY_ASSESSMENT.md §3.1).
 *
 * Keying on `connected` — ICE + DTLS up, the only thing in the app that
 * asserts WebRTC can actually carry media — makes the handover
 * make-before-break in both directions: signals runs until WebRTC is up,
 * and resumes the moment it isn't. The counterpart guarantee, that
 * `connected` is cleared when the transport gives up, is what
 * `routeTransportPhase` and the ConnectionManager `failed` cleanup provide;
 * without those this predicate would still strand a peer.
 *
 * **Declared exception — the recovery window** (decided 2026-07-28, Phase
 * 1.5 item 5; MAINTAINABILITY_ASSESSMENT.md Phase 1 meta-review, residual
 * edge (a)). During `reconnecting`/`disconnected`, `routeTransportPhase`
 * returns `ignore`/`'transport-owns-recovery'`
 * (`media-event-policy.ts:routeTransportPhase`) and nothing flips the
 * slot's `connected` back to `false`, so a peer stays excluded from
 * `_signalsTargets` while no media flows — for up to the transport's
 * recovery window (the FSM's disconnected-grace plus full-reconnect
 * budget). This is accepted, not accidental: flipping `connected` on every
 * transient ICE blip would spin the signals carrier up and down on links
 * that recover in hundreds of milliseconds, and each spin-up is an audio
 * seam (`decideCarrierSwitch`'s dwell exists for the same reason). The
 * exception is bounded by the transport's recovery budget and ends in one
 * of exactly two ways: the transport reports `connected` (media resumed)
 * or `failed` (slot cleared, signals resumes). The residual risk stands
 * with it: clearing a wedged FSM slot depends entirely on the FSM emitting
 * `failed` — `ConnectionManager.fsm.destroy()` emits no transition, and
 * only the `adopt` route in `routeTransportPhase` covers the known
 * silent-replacement case. A dwell-then-flip (declare `connected: false`
 * after N ms of `disconnected`) was considered and rejected until a phase
 * owns wiring it to one clock — it would be the 22nd liveness source.
 *
 * Constrains `streams-store.ts:_signalsTargets`.
 */

import type { AgentPubKeyB64 } from '@holochain/client';

/** The `_openConnections` fields this decision reads. Deliberately narrow. */
export type WebrtcSlot = {
  /** True once the transport reports ICE + DTLS up for this peer. */
  connected: boolean;
};

export type CarrierCoverage =
  /** WebRTC is carrying this peer. The signals carrier must stand down. */
  | { carrier: 'webrtc'; reason: 'webrtc-connected' }
  /** Signals must carry this peer — WebRTC is not up, whatever else is true. */
  | {
      carrier: 'signals';
      reason: 'no-webrtc-attempt' | 'webrtc-not-yet-connected';
    };

/**
 * Which carrier owns this peer right now, given the peer's
 * `_openConnections` entry (or its absence).
 */
export function carrierFor(slot: WebrtcSlot | undefined): CarrierCoverage {
  if (!slot) return { carrier: 'signals', reason: 'no-webrtc-attempt' };
  if (slot.connected) return { carrier: 'webrtc', reason: 'webrtc-connected' };
  // Negotiating, reconnecting, or wedged. In all three cases WebRTC is not
  // carrying audio, so signals has to.
  return { carrier: 'signals', reason: 'webrtc-not-yet-connected' };
}

export type SignalsTargetsInputs = {
  /**
   * The **present** set — `StreamsStore._presentPeers`, i.e. ping-fresh
   * OR media-flowing (`presence-policy.ts:computePresentPeers`). NOT
   * `_activeAgents` keys: the invariant above says "for every peer that
   * is present", and a peer whose pongs went stale while their signals
   * voice keeps arriving is present. Keying this on ping-freshness alone
   * was §3.1(b) — we kept hearing them, they stopped hearing us.
   */
  presentPeers: readonly AgentPubKeyB64[];
  /** `_openConnections`. Only `connected` is read. */
  openConnections: Readonly<Record<AgentPubKeyB64, WebrtcSlot>>;
};

/**
 * The set of present peers the signals carrier must transmit to: the
 * complement of *WebRTC actually carrying media*, not the complement of
 * *a WebRTC attempt existing*.
 */
export function computeSignalsTargets(
  input: SignalsTargetsInputs,
): Set<AgentPubKeyB64> {
  const targets = new Set<AgentPubKeyB64>();
  for (const pubkey of input.presentPeers) {
    if (carrierFor(input.openConnections[pubkey]).carrier === 'signals') {
      targets.add(pubkey);
    }
  }
  return targets;
}
