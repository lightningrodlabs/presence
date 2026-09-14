import { describe, expect, it } from 'vitest';

import {
  DIRECT_PROBE_RETRY_MS,
  DIRECT_PROBE_TIMEOUT_MS,
  DIRECT_SIGNAL_MAX_PAYLOAD_BYTES,
  applyDirectProbeResult,
  decideDirectProbeAction,
  decideSignalPath,
  initialDirectPathRecord,
  markDirectProbeSent,
  type DirectPathRecord,
} from '../direct-signal-policy';

const usable: DirectPathRecord = {
  state: 'usable',
  probeSentAt: null,
  lastResultAt: 1000,
  attempts: 1,
};

describe('decideSignalPath', () => {
  it.each([
    [
      'no port in this environment',
      { capDeclared: true, record: usable, payloadBytes: 10, portAvailable: false },
      'zome',
      'no-direct-port',
    ],
    [
      'peer has not declared the carrier cap',
      { capDeclared: false, record: usable, payloadBytes: 10, portAvailable: true },
      'zome',
      'peer-lacks-direct-signal-cap',
    ],
    [
      'the path has never been proven',
      {
        capDeclared: true,
        record: initialDirectPathRecord(),
        payloadBytes: 10,
        portAvailable: true,
      },
      'zome',
      'path-unproven',
    ],
    [
      'a proven path',
      { capDeclared: true, record: usable, payloadBytes: 10, portAvailable: true },
      'direct',
      'path-proven',
    ],
    [
      'an oversize payload on a proven path',
      {
        capDeclared: true,
        record: usable,
        payloadBytes: DIRECT_SIGNAL_MAX_PAYLOAD_BYTES + 1,
        portAvailable: true,
      },
      'zome',
      'payload-over-direct-ceiling',
    ],
    [
      'a payload exactly at the ceiling',
      {
        capDeclared: true,
        record: usable,
        payloadBytes: DIRECT_SIGNAL_MAX_PAYLOAD_BYTES,
        portAvailable: true,
      },
      'direct',
      'path-proven',
    ],
    [
      'a path proven unusable',
      {
        capDeclared: true,
        record: { state: 'unusable', probeSentAt: null, lastResultAt: 5, attempts: 3 },
        payloadBytes: 1,
        portAvailable: true,
      },
      'zome',
      'path-unusable',
    ],
    [
      'a probe still in flight',
      {
        capDeclared: true,
        record: { state: 'probing', probeSentAt: 100, lastResultAt: null, attempts: 1 },
        payloadBytes: 1,
        portAvailable: true,
      },
      'zome',
      'path-unproven',
    ],
  ])('%s → %s (%s)', (_label, input, path, reason) => {
    const decision = decideSignalPath(input as Parameters<typeof decideSignalPath>[0]);
    expect(decision).toEqual({ path, reason });
  });
});

describe('decideDirectProbeAction', () => {
  it('probes an unknown path once the peer declares the cap', () => {
    expect(
      decideDirectProbeAction({
        now: 100,
        capDeclared: true,
        portAvailable: true,
        record: initialDirectPathRecord(),
      })
    ).toEqual({ action: 'send-probe', reason: 'path-unknown' });
  });

  it.each([
    ['without the cap', { capDeclared: false, portAvailable: true }],
    ['without a port', { capDeclared: true, portAvailable: false }],
  ])('does nothing %s', (_label, gates) => {
    expect(
      decideDirectProbeAction({
        now: 100,
        record: initialDirectPathRecord(),
        ...gates,
      } as Parameters<typeof decideDirectProbeAction>[0])
    ).toMatchObject({ action: 'idle' });
  });

  it('waits out an in-flight probe, then expires it', () => {
    const probing: DirectPathRecord = {
      state: 'probing',
      probeSentAt: 1000,
      lastResultAt: null,
      attempts: 1,
    };
    expect(
      decideDirectProbeAction({
        now: 1000 + DIRECT_PROBE_TIMEOUT_MS - 1,
        capDeclared: true,
        portAvailable: true,
        record: probing,
      })
    ).toEqual({ action: 'idle', reason: 'probe-in-flight' });
    expect(
      decideDirectProbeAction({
        now: 1000 + DIRECT_PROBE_TIMEOUT_MS,
        capDeclared: true,
        portAvailable: true,
        record: probing,
      })
    ).toEqual({ action: 'expire-probe', reason: 'probe-timed-out' });
  });

  it('re-probes an unusable path after the retry window, so a peer that commits its grant recovers', () => {
    const unusable: DirectPathRecord = {
      state: 'unusable',
      probeSentAt: null,
      lastResultAt: 1000,
      attempts: 1,
    };
    expect(
      decideDirectProbeAction({
        now: 1000 + DIRECT_PROBE_RETRY_MS - 1,
        capDeclared: true,
        portAvailable: true,
        record: unusable,
      })
    ).toEqual({ action: 'idle', reason: 'retry-window-closed' });
    expect(
      decideDirectProbeAction({
        now: 1000 + DIRECT_PROBE_RETRY_MS,
        capDeclared: true,
        portAvailable: true,
        record: unusable,
      })
    ).toEqual({ action: 'send-probe', reason: 'retry-window-open' });
  });

  it('leaves a usable path alone forever', () => {
    expect(
      decideDirectProbeAction({
        now: 10_000_000,
        capDeclared: true,
        portAvailable: true,
        record: usable,
      })
    ).toEqual({ action: 'idle', reason: 'path-usable' });
  });
});

describe('markDirectProbeSent', () => {
  it('moves the record to probing and counts the attempt', () => {
    expect(markDirectProbeSent(initialDirectPathRecord(), 500)).toEqual({
      state: 'probing',
      probeSentAt: 500,
      lastResultAt: null,
      attempts: 1,
    });
  });

  it('keeps counting attempts across retries', () => {
    const retried = markDirectProbeSent(
      { state: 'unusable', probeSentAt: null, lastResultAt: 400, attempts: 2 },
      900
    );
    expect(retried).toEqual({
      state: 'probing',
      probeSentAt: 900,
      lastResultAt: 400,
      attempts: 3,
    });
  });
});

describe('applyDirectProbeResult', () => {
  const probing: DirectPathRecord = {
    state: 'probing',
    probeSentAt: 1000,
    lastResultAt: null,
    attempts: 1,
  };

  it('marks an answered probe usable', () => {
    expect(applyDirectProbeResult(probing, { now: 1200, outcome: 'answered' })).toEqual({
      state: 'usable',
      probeSentAt: null,
      lastResultAt: 1200,
      attempts: 1,
    });
  });

  it('marks a timed-out probe unusable', () => {
    expect(applyDirectProbeResult(probing, { now: 1200, outcome: 'timeout' })).toEqual({
      state: 'unusable',
      probeSentAt: null,
      lastResultAt: 1200,
      attempts: 1,
    });
  });

  it('accepts an answer that arrives on an already-usable path', () => {
    expect(applyDirectProbeResult(usable, { now: 2000, outcome: 'answered' })).toEqual({
      state: 'usable',
      probeSentAt: null,
      lastResultAt: 2000,
      attempts: 1,
    });
  });

  it('promotes an unusable path on a late answer — evidence of delivery beats the timeout', () => {
    const unusable: DirectPathRecord = {
      state: 'unusable',
      probeSentAt: null,
      lastResultAt: 1500,
      attempts: 2,
    };
    expect(applyDirectProbeResult(unusable, { now: 1600, outcome: 'answered' })).toEqual({
      state: 'usable',
      probeSentAt: null,
      lastResultAt: 1600,
      attempts: 2,
    });
  });

  it('ignores a timeout for a probe that is no longer in flight', () => {
    expect(applyDirectProbeResult(usable, { now: 2000, outcome: 'timeout' })).toEqual(usable);
    const unknown = initialDirectPathRecord();
    expect(applyDirectProbeResult(unknown, { now: 2000, outcome: 'timeout' })).toEqual(unknown);
  });
});
