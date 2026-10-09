import type { LocalIntent } from './intent';
import type { CaptureLifecycle } from './mic-source';
import { CAPTURE_REOPEN_MAX_ATTEMPTS } from './capture-reconcile-policy';

/**
 * intent-diff-policy — the ONE decision that turns (durable intent x
 * observed reality) into the list of user-facing "unfulfilled intent"
 * diffs. Pure: snapshot in, tagged-union-list out, `reason` tag for logs
 * (CLAUDE.md, the unit of change), copy exact and pinned by table tests.
 * Task 6 renders exactly what this produces — no other call site may
 * hold a copy of this text.
 */

/** How long an intent may go unfulfilled before the UI says so. UI
 *  feedback pacing, NOT liveness — it exists so normal sub-second
 *  device acquisition and SDP exchange never flash a warning. */
export const INTENT_DIFF_GRACE_MS = 2000;

export type IntentDiff = {
  scope: 'mic' | 'camera' | 'carrier';
  severity: 'pending' | 'failed'; // pending = reconciler still trying
  since: number;                  // clock stamp the diff opened
  reason: string;                 // machine-readable, for logs
  copy: string;                   // exact user-facing string, pinned
};

export type IntentDiffInput = {
  intent: LocalIntent;
  micLifecycle: CaptureLifecycle;
  micAttempts: number;            // captureReconciler.micAttemptState (Task 3)
  cameraLifecycle: CaptureLifecycle;
  cameraAttempts: number;         // captureReconciler.cameraAttemptState
  carrierDownSince: number | undefined; // _signalCarrierDownSince
  /** `StreamsStore.signalsCadence().mode` — the ONE send-cadence authority
   *  (`transport/signals-cadence-policy.ts`), read, never re-derived. */
  signalsCadenceMode: 'full' | 'voice-only' | 'paused';
  /** `get(_signalsTargets).size` — how many peers receive over signals. */
  signalsTargetCount: number;
  now: number;
};

type CaptureCopy = { retrying: string; failed: string };

const MIC_COPY: CaptureCopy = {
  retrying: 'Microphone unavailable — retrying…',
  failed: 'Microphone unavailable',
};

const CAMERA_COPY: CaptureCopy = {
  retrying: 'Camera unavailable — retrying…',
  failed: 'Camera unavailable',
};

/** Peer-side and own-side twin copy for a camera that is on but whose
 *  frames are throttled by the signals cadence (spec decisions 9 and
 *  the grid's row 2f). Lives here, once — `peer-tile-policy.ts` imports
 *  it, so the copy-singleton pin sees exactly one holder. */
export const VIDEO_PACED_COPY = 'video paused — slow connection';

/**
 * One scope's capture arm: ended/failed report immediately (something is
 * already visibly wrong); acquiring must clear `INTENT_DIFF_GRACE_MS`
 * first so a normal sub-second device open never flashes a warning.
 * Severity is keyed on `attempts >= CAPTURE_REOPEN_MAX_ATTEMPTS`
 * regardless of which lifecycle state triggered the diff — the
 * reconciler's attempt count is the one answer to "still trying or
 * given up", shared with `capture-reconcile-policy.ts`.
 */
function describeCaptureDiff(
  scope: 'mic' | 'camera',
  wanted: boolean,
  lifecycle: CaptureLifecycle,
  attempts: number,
  now: number,
  copy: CaptureCopy,
): IntentDiff | null {
  if (!wanted) return null;

  let since: number;
  let reasonBase: string;
  switch (lifecycle.state) {
    case 'idle':
    case 'live':
      return null;
    case 'acquiring':
      if (now - lifecycle.since < INTENT_DIFF_GRACE_MS) return null;
      since = lifecycle.since;
      reasonBase = 'acquiring-slow';
      break;
    case 'ended':
      since = lifecycle.endedAt;
      reasonBase = 'ended';
      break;
    case 'failed':
      since = lifecycle.failedAt;
      reasonBase = 'failed';
      break;
    default: {
      const exhaustive: never = lifecycle;
      void exhaustive;
      return null;
    }
  }

  const exhausted = attempts >= CAPTURE_REOPEN_MAX_ATTEMPTS;
  return {
    scope,
    severity: exhausted ? 'failed' : 'pending',
    since,
    reason: exhausted ? `${scope}-attempts-exhausted` : `${scope}-${reasonBase}`,
    copy: exhausted ? copy.failed : copy.retrying,
  };
}

export function describeIntentDiffs(input: IntentDiffInput): IntentDiff[] {
  const diffs: IntentDiff[] = [];

  const mic = describeCaptureDiff(
    'mic',
    input.intent.mic.wanted,
    input.micLifecycle,
    input.micAttempts,
    input.now,
    MIC_COPY,
  );
  if (mic) diffs.push(mic);

  const camera = describeCaptureDiff(
    'camera',
    input.intent.camera.wanted,
    input.cameraLifecycle,
    input.cameraAttempts,
    input.now,
    CAMERA_COPY,
  );
  if (camera) diffs.push(camera);

  // Own-side twin of the tile's row 2f: my camera is on, the signals
  // cadence has throttled my frames, and someone is on signals.
  if (
    !camera &&
    input.intent.camera.wanted &&
    input.signalsCadenceMode !== 'full' &&
    input.signalsTargetCount > 0
  ) {
    diffs.push({
      scope: 'camera',
      severity: 'pending',
      // The camera badge does not render elapsed time, so `since` is the
      // evaluation time rather than a first-seen stamp.
      since: input.now,
      reason: 'camera-paced',
      copy: VIDEO_PACED_COPY,
    });
  }

  if (
    input.carrierDownSince !== undefined &&
    input.now - input.carrierDownSince >= INTENT_DIFF_GRACE_MS
  ) {
    diffs.push({
      scope: 'carrier',
      severity: 'pending',
      since: input.carrierDownSince,
      reason: 'carrier-down',
      copy: 'Your connection dropped — reconnecting…',
    });
  }

  return diffs;
}

