/**
 * Signals-carrier media cadence: how much media to keep sending over the
 * signals fallback carrier as its round-trip time degrades.
 *
 * Declared NOT-liveness (working agreement 2): `SIGNALS_RTT_DEGRADED_MS`
 * and `SIGNALS_RTT_COLLAPSED_MS` are cadence-control thresholds on the
 * pong-echo RTT EWMA (`foldSignalsRtt`, `carrier-stats-policy.ts`), not a
 * presence or reachability predicate — they decide what to *send*, never
 * whether a peer is present. The **carrier-down** input is the one
 * liveness fact this cadence reacts to, and it comes from
 * `decideSignalCarrier` (`presence-policy.ts`), the signal-carrier-down
 * authority — this module does not re-derive it.
 *
 * Hysteresis: a mode escalates (full -> voice-only -> collapsed) the
 * instant its threshold is crossed, but only recovers one level per
 * evaluation, and only once the RTT has fallen below *half* the
 * threshold that would re-trigger it. That asymmetry is what stops a RTT
 * oscillating around a single threshold from flapping the cadence.
 */

export const SIGNALS_RTT_DEGRADED_MS = 2_000;
export const SIGNALS_RTT_COLLAPSED_MS = 5_000;

export type SignalsMediaCadence =
  | { mode: 'full'; reason: 'healthy' | 'no-sample' }
  | { mode: 'voice-only'; reason: 'rtt-degraded' }
  | { mode: 'paused'; reason: 'carrier-down' | 'rtt-collapsed' };

export function decideSignalsMediaCadence(inputs: {
  carrierDown: boolean;
  /** Min of `_signalsRttEwma` across current signals targets. */
  bestRttEwmaMs: number | undefined;
  prevMode: SignalsMediaCadence['mode'];
}): SignalsMediaCadence {
  const { carrierDown, bestRttEwmaMs, prevMode } = inputs;
  if (carrierDown) return { mode: 'paused', reason: 'carrier-down' };
  if (bestRttEwmaMs === undefined) return { mode: 'full', reason: 'no-sample' };
  // Hysteresis: escalate at the threshold, recover only below half of it,
  // and recover one level per evaluation (paused -> voice-only -> full).
  const overCollapsed = bestRttEwmaMs >= SIGNALS_RTT_COLLAPSED_MS;
  const overDegraded = bestRttEwmaMs >= SIGNALS_RTT_DEGRADED_MS;
  const underCollapsedRecovery = bestRttEwmaMs < SIGNALS_RTT_COLLAPSED_MS / 2;
  const underDegradedRecovery = bestRttEwmaMs < SIGNALS_RTT_DEGRADED_MS / 2;
  switch (prevMode) {
    case 'paused':
      if (overCollapsed) return { mode: 'paused', reason: 'rtt-collapsed' };
      if (!underCollapsedRecovery) return { mode: 'paused', reason: 'rtt-collapsed' };
      return { mode: 'voice-only', reason: 'rtt-degraded' };
    case 'voice-only':
      if (overCollapsed) return { mode: 'paused', reason: 'rtt-collapsed' };
      if (underDegradedRecovery) return { mode: 'full', reason: 'healthy' };
      return { mode: 'voice-only', reason: 'rtt-degraded' };
    case 'full':
      if (overCollapsed) return { mode: 'paused', reason: 'rtt-collapsed' };
      if (overDegraded) return { mode: 'voice-only', reason: 'rtt-degraded' };
      return { mode: 'full', reason: 'healthy' };
  }
}
