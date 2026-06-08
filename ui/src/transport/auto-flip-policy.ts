/**
 * Phase 3 — pure decision logic for the automated WebRTC-impl failure
 * toggle. Lives outside StreamsStore so it can be unit-tested without
 * the Holochain runtime dependencies the store carries.
 *
 * The policy answers a single question: when an `AudibilityOutage`
 * fires for a peer link, what should we do?
 *
 *   - `'noop'`     — do nothing. Either we're already on signals (no
 *                    other webrtc impl to flip to), or we're inside
 *                    the per-peer cooldown window after a previous
 *                    flip.
 *   - `'flip'`     — flip the impl. `nextImpl` carries the target.
 *                    Caller should record the flip and broadcast it.
 *   - `'fallback'` — exhausted: we've flipped too many times for this
 *                    peer. Pin the link to signals via
 *                    `disableWebrtcWith` instead of trying again.
 *
 * Keeping this stateless makes the rules grep-able and the test surface
 * tiny. The store wires `now`, `lastFlipMs`, `flipCount`, etc. on each
 * call.
 */

// ---------------------------------------------------------------------------
// Carrier-switch hysteresis (§6.4)
// ---------------------------------------------------------------------------

/**
 * Pure damping for the webrtc↔signals carrier decision. Borderline links
 * oscillate, and every switch is an audio seam plus a reconnect; the captured
 * data shows webrtc at 80ms+3% loss is far better than the signals carrier at
 * 400–1800ms, so the bias is to be *reluctant* to leave webrtc. The rules, in
 * order:
 *
 *   1. **Dwell** — never switch again within `minDwellMs` of the last switch.
 *      Pure anti-thrash.
 *   2. **Transport-up bias** — while on webrtc with ICE+DTLS up (`transportUp`),
 *      stay regardless of audio dips. Media flows on ICE+DTLS independent of
 *      momentary RTP loss; abandoning a live transport for the far-worse signals
 *      carrier is the audible damage, and last-mile uplink loss (the usual cause)
 *      isn't fixed by switching anyway.
 *   3. **Sustained-bad** — only switch once `consecutiveBad` reaches
 *      `badThreshold`. A single bad bucket is noise.
 *
 * Stateless: the store wires the counts, the dwell clock, and the thresholds on
 * each call. Returns whether to switch and, if so, to which carrier.
 */
export type CarrierSwitchInputs = {
  /** Carrier currently carrying this peer's audio. */
  current: 'webrtc' | 'signals';
  /** Whether the webrtc transport (ICE+DTLS) is currently up for this peer. */
  transportUp: boolean;
  /** Consecutive "bad" quality observations for the current carrier. */
  consecutiveBad: number;
  /** ms since the last carrier switch for this peer (dwell). */
  msSinceLastSwitch: number;
  /** Consecutive-bad observations required before leaving the current carrier. */
  badThreshold: number;
  /** Minimum dwell on the current carrier before another switch is allowed. */
  minDwellMs: number;
};

export type CarrierSwitchDecision =
  | { action: 'stay'; reason: 'dwell' | 'transport-up' | 'below-threshold' }
  | { action: 'switch'; to: 'webrtc' | 'signals'; reason: 'sustained-bad' };

export function decideCarrierSwitch(input: CarrierSwitchInputs): CarrierSwitchDecision {
  if (input.msSinceLastSwitch < input.minDwellMs) {
    return { action: 'stay', reason: 'dwell' };
  }
  if (input.current === 'webrtc' && input.transportUp) {
    return { action: 'stay', reason: 'transport-up' };
  }
  if (input.consecutiveBad < input.badThreshold) {
    return { action: 'stay', reason: 'below-threshold' };
  }
  return {
    action: 'switch',
    to: input.current === 'webrtc' ? 'signals' : 'webrtc',
    reason: 'sustained-bad',
  };
}

export type AutoFlipDecision =
  | { action: 'noop'; reason: 'on-signals' | 'cooldown' }
  | { action: 'flip'; nextImpl: 'simplepeer' | 'fsm' }
  | { action: 'fallback'; reason: 'exhausted' };

export type AutoFlipInputs = {
  /** Current effective impl for the peer link. */
  currentImpl: 'simplepeer' | 'fsm';
  /** True when the link is already on signals (webrtc disabled either
   *  globally or per-peer). No other webrtc impl exists to flip to. */
  onSignals: boolean;
  /** Now, in ms. */
  now: number;
  /** Last auto-flip timestamp for this peer, or undefined if no prior flip. */
  lastFlipMs: number | undefined;
  /** Cumulative auto-flip count for this peer this session. */
  flipCount: number;
  /** Min time between auto-flips for the same peer. */
  cooldownMs: number;
  /** Max auto-flips per peer before pinning to signals. */
  maxAttempts: number;
};

export function decideAutoFlip(input: AutoFlipInputs): AutoFlipDecision {
  if (input.onSignals) {
    return { action: 'noop', reason: 'on-signals' };
  }
  if (
    input.lastFlipMs !== undefined &&
    input.now - input.lastFlipMs < input.cooldownMs
  ) {
    return { action: 'noop', reason: 'cooldown' };
  }
  if (input.flipCount >= input.maxAttempts) {
    return { action: 'fallback', reason: 'exhausted' };
  }
  return {
    action: 'flip',
    nextImpl: input.currentImpl === 'fsm' ? 'simplepeer' : 'fsm',
  };
}

/**
 * Pure resolver for the per-link impl selection. Same logic as
 * `StreamsStore.webrtcImplForGiven` — extracted here so tests don't
 * need the store and so the rules live in one place.
 *
 * Resolution order:
 *   1. If both sides set an override and they agree, use it.
 *   2. If both sides set an override and disagree, `'fsm'` wins. The FSM
 *      carrier implements Perfect Negotiation, session-ID stale-signal
 *      rejection, and quadratic backoff — the three patterns that the
 *      industry identifies as load-bearing on marginal NAT paths, which
 *      is exactly the regime in which an auto-flip-driven disagreement
 *      tends to land. See WEBRTC_CARRIER_ANALYSIS.md.
 *   3. If only one side has an override, that override applies.
 *   4. Otherwise the global default applies — `'fsm'` if either side
 *      has `webrtcImpl: 'fsm'`, else `'simplepeer'`.
 */
export function resolveWebrtcImpl(
  myGlobal: 'simplepeer' | 'fsm',
  myOverride: 'simplepeer' | 'fsm' | undefined,
  peerGlobal: 'simplepeer' | 'fsm',
  peerOverride: 'simplepeer' | 'fsm' | undefined,
): 'simplepeer' | 'fsm' {
  if (myOverride && peerOverride) {
    if (myOverride === peerOverride) return myOverride;
    return 'fsm';
  }
  if (myOverride) return myOverride;
  if (peerOverride) return peerOverride;
  if (myGlobal === 'fsm' || peerGlobal === 'fsm') return 'fsm';
  return 'simplepeer';
}
