import { describe, it, expect } from 'vitest';
import {
  decideCaptureAction,
  CAPTURE_REOPEN_MIN_INTERVAL_MS,
  CAPTURE_REOPEN_MAX_ATTEMPTS,
} from '../capture-reconcile-policy';
import type {
  CaptureReconcileInput,
  CaptureReconcileDecision,
} from '../capture-reconcile-policy';
import type { CaptureLifecycle } from '../mic-source';

/**
 * Task 3: the capture-reconcile policy is the pure decision that maps
 * (durable intent × observed capture lifecycle × retry pacing) to the ONE
 * action the reconciler executes. Snapshot in, tagged union out, `reason`
 * tag — table-driven, no mocks (CLAUDE.md, the unit of change). It is the
 * authority that replaces the observation-standing-in-for-intent conflation
 * the whole round exists to kill: the reconciler acts on what the user
 * asked for, not on which handle happens to be held.
 */

const NOW = 100_000;

const live: CaptureLifecycle = {
  state: 'live',
  track: {} as MediaStreamTrack,
};
const idle: CaptureLifecycle = { state: 'idle' };
const acquiring: CaptureLifecycle = { state: 'acquiring', since: NOW - 10 };
const ended: CaptureLifecycle = { state: 'ended', endedAt: NOW - 10 };
const failed: CaptureLifecycle = {
  state: 'failed',
  error: 'Permission denied',
  failedAt: NOW - 10,
};

function decide(
  partial: Partial<CaptureReconcileInput> & { wanted: boolean; lifecycle: CaptureLifecycle }
): CaptureReconcileDecision {
  return decideCaptureAction({
    lastAttemptAt: undefined,
    attemptsSinceGesture: 0,
    now: NOW,
    ...partial,
  });
}

describe('decideCaptureAction — the wanted × lifecycle table', () => {
  it('wanted + idle → open/wanted-idle', () => {
    expect(decide({ wanted: true, lifecycle: idle })).toEqual({
      action: 'open',
      reason: 'wanted-idle',
    });
  });

  it('wanted + acquiring → hold/attempt-in-flight', () => {
    expect(decide({ wanted: true, lifecycle: acquiring })).toEqual({
      action: 'hold',
      reason: 'attempt-in-flight',
    });
  });

  it('wanted + live → none/satisfied', () => {
    expect(decide({ wanted: true, lifecycle: live })).toEqual({
      action: 'none',
      reason: 'satisfied',
    });
  });

  it('wanted + ended, first time (unpaced-not-applicable) → open/wanted-ended', () => {
    expect(
      decide({ wanted: true, lifecycle: ended, lastAttemptAt: undefined })
    ).toEqual({ action: 'open', reason: 'wanted-ended' });
  });

  it('wanted + failed, retryable → open/retry-after-failure', () => {
    expect(
      decide({ wanted: true, lifecycle: failed, lastAttemptAt: undefined })
    ).toEqual({ action: 'open', reason: 'retry-after-failure' });
  });

  it('unwanted + live → close/unwanted-live', () => {
    expect(decide({ wanted: false, lifecycle: live })).toEqual({
      action: 'close',
      reason: 'unwanted-live',
    });
  });

  it('unwanted + acquiring → hold/attempt-in-flight (let it land, next tick closes)', () => {
    expect(decide({ wanted: false, lifecycle: acquiring })).toEqual({
      action: 'hold',
      reason: 'attempt-in-flight',
    });
  });

  it('unwanted + idle/ended/failed → none/unwanted-idle', () => {
    for (const lifecycle of [idle, ended, failed]) {
      expect(decide({ wanted: false, lifecycle })).toEqual({
        action: 'none',
        reason: 'unwanted-idle',
      });
    }
  });
});

describe('decideCaptureAction — retry pacing', () => {
  it('holds (reopen-paced) when the reopen interval has not elapsed', () => {
    expect(
      decide({
        wanted: true,
        lifecycle: ended,
        lastAttemptAt: NOW - (CAPTURE_REOPEN_MIN_INTERVAL_MS - 1),
        attemptsSinceGesture: 1,
      })
    ).toEqual({ action: 'hold', reason: 'reopen-paced' });
  });

  it('opens exactly at the interval boundary (>= is paced)', () => {
    expect(
      decide({
        wanted: true,
        lifecycle: ended,
        lastAttemptAt: NOW - CAPTURE_REOPEN_MIN_INTERVAL_MS,
        attemptsSinceGesture: 1,
      })
    ).toEqual({ action: 'open', reason: 'wanted-ended' });
  });

  it('a failed lifecycle paces the same way, reason retry-after-failure', () => {
    expect(
      decide({
        wanted: true,
        lifecycle: failed,
        lastAttemptAt: NOW - (CAPTURE_REOPEN_MIN_INTERVAL_MS - 1),
        attemptsSinceGesture: 2,
      })
    ).toEqual({ action: 'hold', reason: 'reopen-paced' });
  });
});

describe('decideCaptureAction — the attempts ceiling reports once', () => {
  it('reports failure exactly when attempts reach the max, even if paced', () => {
    // Ceiling preempts pacing: an exhausted device stops retrying and the
    // user is told once, rather than the reopen interval gating a report
    // that will never come.
    expect(
      decide({
        wanted: true,
        lifecycle: ended,
        lastAttemptAt: NOW, // freshly attempted (would otherwise be paced -> hold)
        attemptsSinceGesture: CAPTURE_REOPEN_MAX_ATTEMPTS,
      })
    ).toEqual({ action: 'report-failure', reason: 'attempts-exhausted' });
  });

  it('is silent (already-reported) once attempts pass the max', () => {
    expect(
      decide({
        wanted: true,
        lifecycle: failed,
        lastAttemptAt: NOW,
        attemptsSinceGesture: CAPTURE_REOPEN_MAX_ATTEMPTS + 1,
      })
    ).toEqual({ action: 'none', reason: 'already-reported' });
  });

  it('still opens on the attempt just below the ceiling (when paced)', () => {
    expect(
      decide({
        wanted: true,
        lifecycle: ended,
        lastAttemptAt: undefined,
        attemptsSinceGesture: CAPTURE_REOPEN_MAX_ATTEMPTS - 1,
      })
    ).toEqual({ action: 'open', reason: 'wanted-ended' });
  });

  it('a fresh gesture (attempts back to 0, no last attempt) opens again', () => {
    // noteGesture resets attemptsSinceGesture to 0 and clears lastAttemptAt,
    // so a device the user re-requests after exhaustion retries immediately.
    expect(
      decide({
        wanted: true,
        lifecycle: failed,
        lastAttemptAt: undefined,
        attemptsSinceGesture: 0,
      })
    ).toEqual({ action: 'open', reason: 'retry-after-failure' });
  });
});
