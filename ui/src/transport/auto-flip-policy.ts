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
 *   2. If both sides set an override and disagree, `'simplepeer'` wins
 *      (broader compat, less reconnect machinery — also lets the
 *      auto-toggle pin a link to simplepeer unilaterally).
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
    return 'simplepeer';
  }
  if (myOverride) return myOverride;
  if (peerOverride) return peerOverride;
  if (myGlobal === 'fsm' || peerGlobal === 'fsm') return 'fsm';
  return 'simplepeer';
}
