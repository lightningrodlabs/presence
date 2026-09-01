import { describe, it, expect } from 'vitest';
import {
  describeIntentDiffs,
  describeLinkEstablishment,
  INTENT_DIFF_GRACE_MS,
} from '../intent-diff-policy';
import type { IntentDiffInput } from '../intent-diff-policy';
import { CAPTURE_REOPEN_MAX_ATTEMPTS } from '../capture-reconcile-policy';
import type { CaptureLifecycle } from '../mic-source';
import type { LocalIntent } from '../intent';

/**
 * Task 5: the intent-diff policy turns (durable intent x observed reality)
 * into the list of user-facing "unfulfilled intent" diffs. Pure: snapshot
 * in, tagged-union-list out, table-driven, no mocks (CLAUDE.md, the unit of
 * change). Copy is exact and lives only here — Task 6 renders it verbatim
 * and pins that this file is the only source (grep-pin).
 */

const NOW = 1_000_000;

const idle: CaptureLifecycle = { state: 'idle' };
const acquiringFresh: CaptureLifecycle = { state: 'acquiring', since: NOW };
const ACQUIRING_PAST_GRACE_SINCE = NOW - INTENT_DIFF_GRACE_MS;
const acquiringPastGrace: CaptureLifecycle = {
  state: 'acquiring',
  since: ACQUIRING_PAST_GRACE_SINCE,
};
const acquiringJustUnderGrace: CaptureLifecycle = {
  state: 'acquiring',
  since: NOW - INTENT_DIFF_GRACE_MS + 1,
};
const live: CaptureLifecycle = { state: 'live', track: {} as MediaStreamTrack };
const ENDED_AT = NOW - 500;
const ended: CaptureLifecycle = { state: 'ended', endedAt: ENDED_AT };
const FAILED_AT = NOW - 500;
const failed: CaptureLifecycle = {
  state: 'failed',
  error: 'NotFoundError',
  failedAt: FAILED_AT,
};

function baseIntent(): LocalIntent {
  return {
    mic: { wanted: false, muted: true },
    camera: { wanted: false },
    screenShare: { wanted: false },
    webrtc: { enabled: true, disabledWith: new Set() },
  };
}

function input(partial: Partial<IntentDiffInput>): IntentDiffInput {
  return {
    intent: baseIntent(),
    micLifecycle: idle,
    micAttempts: 0,
    cameraLifecycle: idle,
    cameraAttempts: 0,
    carrierDownSince: undefined,
    now: NOW,
    ...partial,
  };
}

describe('describeIntentDiffs — satisfied intent', () => {
  it('unwanted mic/camera, no carrier outage → []', () => {
    expect(describeIntentDiffs(input({}))).toEqual([]);
  });

  it('wanted mic + camera both live → []', () => {
    const intent = { ...baseIntent(), mic: { wanted: true, muted: false }, camera: { wanted: true } };
    expect(
      describeIntentDiffs(
        input({ intent, micLifecycle: live, cameraLifecycle: live })
      )
    ).toEqual([]);
  });

  it('wanted mic idle (not yet started) → [] (no timestamp to report yet)', () => {
    const intent = { ...baseIntent(), mic: { wanted: true, muted: false } };
    expect(describeIntentDiffs(input({ intent, micLifecycle: idle }))).toEqual([]);
  });

  it('wanted mic acquiring, under grace → []', () => {
    const intent = { ...baseIntent(), mic: { wanted: true, muted: false } };
    expect(
      describeIntentDiffs(input({ intent, micLifecycle: acquiringJustUnderGrace }))
    ).toEqual([]);
  });
});

describe('describeIntentDiffs — mic arms', () => {
  const wantMic: LocalIntent = { ...baseIntent(), mic: { wanted: true, muted: false } };

  it('ended, attempts < max → mic/pending/"Microphone unavailable — retrying…"', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wantMic, micLifecycle: ended, micAttempts: CAPTURE_REOPEN_MAX_ATTEMPTS - 1 })
    );
    expect(diffs).toEqual([
      {
        scope: 'mic',
        severity: 'pending',
        since: ENDED_AT,
        reason: 'mic-ended',
        copy: 'Microphone unavailable — retrying…',
      },
    ]);
  });

  it('ended, attempts >= max → mic/failed/"Microphone unavailable"', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wantMic, micLifecycle: ended, micAttempts: CAPTURE_REOPEN_MAX_ATTEMPTS })
    );
    expect(diffs).toEqual([
      {
        scope: 'mic',
        severity: 'failed',
        since: ENDED_AT,
        reason: 'mic-attempts-exhausted',
        copy: 'Microphone unavailable',
      },
    ]);
  });

  it('failed lifecycle, attempts < max → mic/pending/retrying copy, since = failedAt', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wantMic, micLifecycle: failed, micAttempts: 0 })
    );
    expect(diffs).toEqual([
      {
        scope: 'mic',
        severity: 'pending',
        since: FAILED_AT,
        reason: 'mic-failed',
        copy: 'Microphone unavailable — retrying…',
      },
    ]);
  });

  it('failed lifecycle, attempts >= max → mic/failed/plain copy', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wantMic, micLifecycle: failed, micAttempts: CAPTURE_REOPEN_MAX_ATTEMPTS + 3 })
    );
    expect(diffs).toEqual([
      {
        scope: 'mic',
        severity: 'failed',
        since: FAILED_AT,
        reason: 'mic-attempts-exhausted',
        copy: 'Microphone unavailable',
      },
    ]);
  });

  it('acquiring, exactly at grace boundary → diff appears (>= grace)', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wantMic, micLifecycle: acquiringPastGrace, micAttempts: 0 })
    );
    expect(diffs).toEqual([
      {
        scope: 'mic',
        severity: 'pending',
        since: ACQUIRING_PAST_GRACE_SINCE,
        reason: 'mic-acquiring-slow',
        copy: 'Microphone unavailable — retrying…',
      },
    ]);
  });

  it('acquiring one ms under grace boundary → []', () => {
    expect(
      describeIntentDiffs(input({ intent: wantMic, micLifecycle: acquiringJustUnderGrace }))
    ).toEqual([]);
  });

  it('acquiring past grace, attempts >= max → mic/failed (attempts still gate severity)', () => {
    const diffs = describeIntentDiffs(
      input({
        intent: wantMic,
        micLifecycle: acquiringPastGrace,
        micAttempts: CAPTURE_REOPEN_MAX_ATTEMPTS,
      })
    );
    expect(diffs).toEqual([
      {
        scope: 'mic',
        severity: 'failed',
        since: ACQUIRING_PAST_GRACE_SINCE,
        reason: 'mic-attempts-exhausted',
        copy: 'Microphone unavailable',
      },
    ]);
  });

  it('not wanted, even if ended/failed → [] (only wanted devices produce diffs)', () => {
    expect(describeIntentDiffs(input({ micLifecycle: ended, micAttempts: 99 }))).toEqual([]);
    expect(describeIntentDiffs(input({ micLifecycle: failed, micAttempts: 99 }))).toEqual([]);
  });

  it('acquiring fresh (since = now), even if wanted → [] (no grace elapsed)', () => {
    expect(
      describeIntentDiffs(input({ intent: wantMic, micLifecycle: acquiringFresh }))
    ).toEqual([]);
  });
});

describe('describeIntentDiffs — camera arms (symmetric with mic)', () => {
  const wantCamera: LocalIntent = { ...baseIntent(), camera: { wanted: true } };

  it('ended, attempts < max → camera/pending/"Camera unavailable — retrying…"', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wantCamera, cameraLifecycle: ended, cameraAttempts: 0 })
    );
    expect(diffs).toEqual([
      {
        scope: 'camera',
        severity: 'pending',
        since: ENDED_AT,
        reason: 'camera-ended',
        copy: 'Camera unavailable — retrying…',
      },
    ]);
  });

  it('failed, attempts >= max → camera/failed/"Camera unavailable"', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wantCamera, cameraLifecycle: failed, cameraAttempts: CAPTURE_REOPEN_MAX_ATTEMPTS })
    );
    expect(diffs).toEqual([
      {
        scope: 'camera',
        severity: 'failed',
        since: FAILED_AT,
        reason: 'camera-attempts-exhausted',
        copy: 'Camera unavailable',
      },
    ]);
  });

  it('camera satisfied (live) → []', () => {
    expect(
      describeIntentDiffs(input({ intent: wantCamera, cameraLifecycle: live }))
    ).toEqual([]);
  });
});

describe('describeIntentDiffs — carrier arm', () => {
  it('carrierDownSince undefined → []', () => {
    expect(describeIntentDiffs(input({ carrierDownSince: undefined }))).toEqual([]);
  });

  it('carrierDownSince set but under grace → []', () => {
    expect(
      describeIntentDiffs(input({ carrierDownSince: NOW - (INTENT_DIFF_GRACE_MS - 1) }))
    ).toEqual([]);
  });

  it('carrierDownSince set, exactly at grace boundary → carrier/pending diff', () => {
    const diffs = describeIntentDiffs(input({ carrierDownSince: NOW - INTENT_DIFF_GRACE_MS }));
    expect(diffs).toEqual([
      {
        scope: 'carrier',
        severity: 'pending',
        since: NOW - INTENT_DIFF_GRACE_MS,
        reason: 'carrier-down',
        copy: 'Your connection dropped — reconnecting…',
      },
    ]);
  });

  it('carrierDownSince set, well past grace → carrier/pending diff', () => {
    const diffs = describeIntentDiffs(input({ carrierDownSince: NOW - 60_000 }));
    expect(diffs).toEqual([
      {
        scope: 'carrier',
        severity: 'pending',
        since: NOW - 60_000,
        reason: 'carrier-down',
        copy: 'Your connection dropped — reconnecting…',
      },
    ]);
  });
});

describe('describeIntentDiffs — coexisting diffs (Incident B vs C confusability)', () => {
  it('mic AND carrier diffs both appear when both hold', () => {
    const intent: LocalIntent = { ...baseIntent(), mic: { wanted: true, muted: false } };
    const diffs = describeIntentDiffs(
      input({
        intent,
        micLifecycle: ended,
        micAttempts: 0,
        carrierDownSince: NOW - 60_000,
      })
    );
    expect(diffs).toHaveLength(2);
    expect(diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'mic', copy: 'Microphone unavailable — retrying…' }),
        expect.objectContaining({ scope: 'carrier', copy: 'Your connection dropped — reconnecting…' }),
      ])
    );
  });

  it('mic AND camera AND carrier all coexist', () => {
    const intent: LocalIntent = {
      ...baseIntent(),
      mic: { wanted: true, muted: false },
      camera: { wanted: true },
    };
    const diffs = describeIntentDiffs(
      input({
        intent,
        micLifecycle: failed,
        micAttempts: CAPTURE_REOPEN_MAX_ATTEMPTS,
        cameraLifecycle: ended,
        cameraAttempts: 0,
        carrierDownSince: NOW - 5_000,
      })
    );
    expect(diffs.map(d => d.scope).sort()).toEqual(['camera', 'carrier', 'mic']);
  });
});

describe('describeLinkEstablishment', () => {
  it('connected → null', () => {
    expect(describeLinkEstablishment({ connected: true, reconnecting: false })).toBeNull();
    expect(describeLinkEstablishment({ connected: true, reconnecting: true })).toBeNull();
  });

  it('not connected, first time → "establishing WebRTC carrier…"', () => {
    expect(describeLinkEstablishment({ connected: false, reconnecting: false })).toEqual({
      copy: 'establishing WebRTC carrier…',
    });
  });

  it('not connected, had a prior session → "connection lost — reconnecting…"', () => {
    expect(describeLinkEstablishment({ connected: false, reconnecting: true })).toEqual({
      copy: 'connection lost — reconnecting…',
    });
  });
});

describe('INTENT_DIFF_GRACE_MS', () => {
  it('is the declared 2000ms UI-feedback pacing value', () => {
    expect(INTENT_DIFF_GRACE_MS).toBe(2000);
  });
});
