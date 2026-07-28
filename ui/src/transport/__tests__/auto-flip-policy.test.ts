import { describe, it, expect } from 'vitest';
import {
  decideAutoFlip,
  decideCarrierSwitch,
  resolveWebrtcImpl,
} from '../auto-flip-policy';
import type { CarrierSwitchInputs } from '../auto-flip-policy';

describe('decideCarrierSwitch — webrtc↔signals hysteresis (§6.4)', () => {
  const base: CarrierSwitchInputs = {
    current: 'webrtc',
    transportUp: false,
    consecutiveBad: 5,
    msSinceLastSwitch: 60_000,
    badThreshold: 3,
    minDwellMs: 10_000,
  };

  it('holds within the dwell window even with sustained badness (anti-thrash)', () => {
    expect(decideCarrierSwitch({ ...base, msSinceLastSwitch: 9_999 })).toEqual({
      action: 'stay',
      reason: 'dwell',
    });
  });

  it('stays on webrtc while the transport (ICE+DTLS) is up, regardless of audio dips', () => {
    expect(
      decideCarrierSwitch({ ...base, transportUp: true, consecutiveBad: 999 }),
    ).toEqual({ action: 'stay', reason: 'transport-up' });
  });

  it('does not switch off webrtc until badness is sustained past the threshold', () => {
    expect(
      decideCarrierSwitch({ ...base, transportUp: false, consecutiveBad: 2 }),
    ).toEqual({ action: 'stay', reason: 'below-threshold' });
  });

  it('switches webrtc → signals once badness is sustained and the transport is down', () => {
    expect(
      decideCarrierSwitch({ ...base, transportUp: false, consecutiveBad: 3 }),
    ).toEqual({ action: 'switch', to: 'signals', reason: 'sustained-bad' });
  });

  it('switches signals → webrtc on sustained badness (recovery attempt)', () => {
    expect(
      decideCarrierSwitch({ ...base, current: 'signals', consecutiveBad: 3 }),
    ).toEqual({ action: 'switch', to: 'webrtc', reason: 'sustained-bad' });
  });

  it('transport-up bias does not apply when already on signals', () => {
    // transportUp is about webrtc; on signals it must not pin us there.
    expect(
      decideCarrierSwitch({ ...base, current: 'signals', transportUp: true, consecutiveBad: 3 }),
    ).toEqual({ action: 'switch', to: 'webrtc', reason: 'sustained-bad' });
  });

  it('dwell takes precedence over the transport-up bias', () => {
    expect(
      decideCarrierSwitch({ ...base, transportUp: true, msSinceLastSwitch: 0 }),
    ).toEqual({ action: 'stay', reason: 'dwell' });
  });

  it('walks a bucket sequence: noise dips do not switch, a sustained run does', () => {
    const run = (consecutiveBad: number) =>
      decideCarrierSwitch({ ...base, transportUp: false, consecutiveBad });
    expect(run(0).action).toBe('stay');
    expect(run(1).action).toBe('stay');
    expect(run(2).action).toBe('stay');
    expect(run(3).action).toBe('switch'); // threshold reached
  });
});

describe('resolveWebrtcImpl — symmetric union with per-peer overrides', () => {
  /** Every case in this block is between two FSM-capable builds. */
  const capable = (
    myGlobal: 'simplepeer' | 'fsm',
    myOverride: 'simplepeer' | 'fsm' | undefined,
    peerGlobal: 'simplepeer' | 'fsm',
    peerOverride: 'simplepeer' | 'fsm' | undefined,
  ) =>
    resolveWebrtcImpl({
      myGlobal,
      myOverride,
      peerGlobal,
      peerOverride,
      peerSupportsFsm: true,
    });

  it('defaults to simplepeer when neither side has a preference', () => {
    expect(capable('simplepeer', undefined, 'simplepeer', undefined)).toBe(
      'simplepeer',
    );
  });

  it('uses fsm when my global preference is fsm', () => {
    expect(capable('fsm', undefined, 'simplepeer', undefined)).toBe('fsm');
  });

  it('uses fsm when peer global preference is fsm (symmetric union)', () => {
    expect(capable('simplepeer', undefined, 'fsm', undefined)).toBe('fsm');
  });

  it('my override wins over my global', () => {
    expect(capable('fsm', 'simplepeer', 'simplepeer', undefined)).toBe(
      'simplepeer',
    );
    expect(capable('simplepeer', 'fsm', 'simplepeer', undefined)).toBe('fsm');
  });

  it('peer override wins over my global when I have no override', () => {
    expect(capable('fsm', undefined, 'fsm', 'simplepeer')).toBe('simplepeer');
    expect(capable('simplepeer', undefined, 'simplepeer', 'fsm')).toBe('fsm');
  });

  it('agreeing overrides apply unchanged', () => {
    expect(capable('fsm', 'simplepeer', 'fsm', 'simplepeer')).toBe(
      'simplepeer',
    );
    expect(capable('simplepeer', 'fsm', 'simplepeer', 'fsm')).toBe('fsm');
  });

  it('disagreeing overrides resolve to fsm (marginal-NAT-favoring tiebreaker)', () => {
    // When auto-flip drives the two sides into disagreement the link is
    // already in a regime where the FSM's Perfect-Negotiation /
    // session-ID / backoff machinery is most likely to help. See
    // WEBRTC_CARRIER_ANALYSIS.md.
    expect(capable('fsm', 'simplepeer', 'fsm', 'fsm')).toBe('fsm');
    expect(capable('simplepeer', 'fsm', 'simplepeer', 'simplepeer')).toBe(
      'fsm',
    );
  });

  it('overrides outrank globals on both sides', () => {
    // Both global=fsm but I override to simplepeer — link uses simplepeer.
    expect(capable('fsm', 'simplepeer', 'fsm', undefined)).toBe('simplepeer');
  });
});

describe('resolveWebrtcImpl — capability dominates preference (§3.8)', () => {
  /**
   * The interop bug: our global default is `'fsm'`, and the union rule made
   * that alone enough to resolve the link to `'fsm'` — so we sent `SdpFsm`
   * to peers whose build has no handler for it. Every preference shape has
   * to yield to the capability.
   */
  const PREFERENCE_SHAPES = [
    { myGlobal: 'fsm', myOverride: undefined, peerGlobal: 'simplepeer', peerOverride: undefined },
    { myGlobal: 'fsm', myOverride: 'fsm', peerGlobal: 'simplepeer', peerOverride: undefined },
    { myGlobal: 'simplepeer', myOverride: 'fsm', peerGlobal: 'fsm', peerOverride: 'fsm' },
    { myGlobal: 'fsm', myOverride: 'fsm', peerGlobal: 'fsm', peerOverride: 'fsm' },
    { myGlobal: 'simplepeer', myOverride: undefined, peerGlobal: 'fsm', peerOverride: undefined },
  ] as const;

  it.each(PREFERENCE_SHAPES)(
    'resolves to simplepeer for a peer that cannot parse SdpFsm (%o)',
    shape => {
      expect(resolveWebrtcImpl({ ...shape, peerSupportsFsm: false })).toBe(
        'simplepeer',
      );
    },
  );

  it('still reaches fsm for the same shapes when the peer is capable', () => {
    // Negative control: the gate must not be the only thing deciding.
    const anyFsm = PREFERENCE_SHAPES.map(shape =>
      resolveWebrtcImpl({ ...shape, peerSupportsFsm: true }),
    );
    expect(anyFsm).toContain('fsm');
  });

  it('an incapable peer is simplepeer even when I explicitly override to fsm', () => {
    // No preference either side holds can make an old client understand a
    // signal type it has no handler for.
    expect(
      resolveWebrtcImpl({
        myGlobal: 'fsm',
        myOverride: 'fsm',
        peerGlobal: 'fsm',
        peerOverride: 'fsm',
        peerSupportsFsm: false,
      }),
    ).toBe('simplepeer');
  });
});

describe('decideAutoFlip — outage-driven implementation flip', () => {
  const baseInputs = {
    currentImpl: 'simplepeer' as const,
    onSignals: false,
    now: 100_000,
    lastFlipMs: undefined,
    flipCount: 0,
    cooldownMs: 60_000,
    maxAttempts: 3,
  };

  it('flips simplepeer → fsm on the first outage', () => {
    expect(decideAutoFlip(baseInputs)).toEqual({
      action: 'flip',
      nextImpl: 'fsm',
    });
  });

  it('flips fsm → simplepeer on the first outage', () => {
    expect(decideAutoFlip({ ...baseInputs, currentImpl: 'fsm' })).toEqual({
      action: 'flip',
      nextImpl: 'simplepeer',
    });
  });

  it('no-ops when already on signals (no other webrtc impl to flip to)', () => {
    expect(decideAutoFlip({ ...baseInputs, onSignals: true })).toEqual({
      action: 'noop',
      reason: 'on-signals',
    });
  });

  it('no-ops inside the cooldown window', () => {
    expect(
      decideAutoFlip({
        ...baseInputs,
        lastFlipMs: 50_000, // 50s ago, < cooldown
        flipCount: 1,
      }),
    ).toEqual({ action: 'noop', reason: 'cooldown' });
  });

  it('flips again once the cooldown has elapsed', () => {
    expect(
      decideAutoFlip({
        ...baseInputs,
        lastFlipMs: 30_000, // 70s ago, > cooldown
        flipCount: 1,
      }),
    ).toEqual({ action: 'flip', nextImpl: 'fsm' });
  });

  it('falls back to signals when max attempts is exceeded', () => {
    expect(
      decideAutoFlip({
        ...baseInputs,
        lastFlipMs: 30_000, // cooldown elapsed
        flipCount: 3, // == maxAttempts
      }),
    ).toEqual({ action: 'fallback', reason: 'exhausted' });
  });

  it('cooldown takes precedence over exhaustion', () => {
    // If we just flipped AND we're at max attempts, cooldown applies first.
    // The fallback fires on the NEXT scan after cooldown elapses.
    expect(
      decideAutoFlip({
        ...baseInputs,
        lastFlipMs: 90_000, // 10s ago
        flipCount: 5,
      }),
    ).toEqual({ action: 'noop', reason: 'cooldown' });
  });

  it('on-signals takes precedence over everything', () => {
    expect(
      decideAutoFlip({
        ...baseInputs,
        onSignals: true,
        lastFlipMs: 30_000,
        flipCount: 5,
      }),
    ).toEqual({ action: 'noop', reason: 'on-signals' });
  });
});
