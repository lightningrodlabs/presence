import type { CaptureLifecycle } from './mic-source';

/**
 * capture-reconcile-policy — the ONE decision that reconciles what the user
 * asked for (durable intent) against what the capture device is actually
 * doing (`CaptureLifecycle`), plus retry pacing. Pure: snapshot in, tagged
 * union out, `reason` tag (CLAUDE.md, the unit of change). The reconciler
 * (`capture-reconciler.ts`) is the only executor; it holds the acquire
 * handle and the pacing state and runs this table for mic and camera on
 * every presence tick and every media gesture.
 *
 * This kills the observation-standing-in-for-intent conflation the round
 * exists to close: recovery keys on `wanted`, never on "is a handle held"
 * — a device that dies underneath a held handle (Incident B / D3) is
 * `ended`/`failed` here and reopens, instead of reading as "still open"
 * because the handle is non-null.
 */

/** Capture-device retry pacing. NOT a liveness predicate — it bounds how
 *  fast the reconciler may re-open a device that keeps dying, so a
 *  device that ends immediately on open cannot spin. */
export const CAPTURE_REOPEN_MIN_INTERVAL_MS = 3000;

/** Attempts after the last gesture before the reconciler stops retrying
 *  and reports failure once. A new gesture resets the count. */
export const CAPTURE_REOPEN_MAX_ATTEMPTS = 5;

export type CaptureReconcileInput = {
  wanted: boolean;
  lifecycle: CaptureLifecycle;
  /** clock stamp of the last open/reopen attempt; undefined = none yet */
  lastAttemptAt: number | undefined;
  /** attempts since the last gesture touching this device */
  attemptsSinceGesture: number;
  now: number;
};

export type CaptureReconcileDecision =
  | { action: 'open'; reason: 'wanted-idle' | 'wanted-ended' | 'retry-after-failure' }
  | { action: 'close'; reason: 'unwanted-live' }
  | { action: 'report-failure'; reason: 'attempts-exhausted' }
  | { action: 'hold'; reason: 'attempt-in-flight' | 'reopen-paced' }
  | { action: 'none'; reason: 'satisfied' | 'unwanted-idle' | 'already-reported' };

function isPaced(input: CaptureReconcileInput): boolean {
  return (
    input.lastAttemptAt === undefined ||
    input.now - input.lastAttemptAt >= CAPTURE_REOPEN_MIN_INTERVAL_MS
  );
}

/**
 * The dead-device arm (`ended`/`failed`): report failure once when the
 * attempts ceiling is reached, stay silent past it, otherwise open when
 * paced and hold otherwise. `openReason` differs by lifecycle so the log
 * distinguishes a device that died live (`ended`) from one that never
 * opened (`failed`); the ceiling and pacing arms are identical.
 */
function decideDeadDevice(
  input: CaptureReconcileInput,
  openReason: 'wanted-ended' | 'retry-after-failure'
): CaptureReconcileDecision {
  // Ceiling preempts pacing: at the max we tell the user once; past it we
  // are silent until a fresh gesture resets the count. The reconciler bumps
  // attemptsSinceGesture past the max as it emits the one report, so the
  // strict `>` arm is what makes "report once" hold.
  if (input.attemptsSinceGesture > CAPTURE_REOPEN_MAX_ATTEMPTS) {
    return { action: 'none', reason: 'already-reported' };
  }
  if (input.attemptsSinceGesture === CAPTURE_REOPEN_MAX_ATTEMPTS) {
    return { action: 'report-failure', reason: 'attempts-exhausted' };
  }
  if (isPaced(input)) return { action: 'open', reason: openReason };
  return { action: 'hold', reason: 'reopen-paced' };
}

export function decideCaptureAction(
  input: CaptureReconcileInput
): CaptureReconcileDecision {
  const { wanted, lifecycle } = input;

  switch (lifecycle.state) {
    case 'idle':
      return wanted
        ? { action: 'open', reason: 'wanted-idle' }
        : { action: 'none', reason: 'unwanted-idle' };
    case 'acquiring':
      // Either way an attempt is in flight — let it land. When unwanted,
      // the next tick sees `live` and closes.
      return { action: 'hold', reason: 'attempt-in-flight' };
    case 'live':
      return wanted
        ? { action: 'none', reason: 'satisfied' }
        : { action: 'close', reason: 'unwanted-live' };
    case 'ended':
      return wanted
        ? decideDeadDevice(input, 'wanted-ended')
        : { action: 'none', reason: 'unwanted-idle' };
    case 'failed':
      return wanted
        ? decideDeadDevice(input, 'retry-after-failure')
        : { action: 'none', reason: 'unwanted-idle' };
    default: {
      const exhaustive: never = lifecycle;
      void exhaustive;
      return { action: 'none', reason: 'satisfied' };
    }
  }
}
