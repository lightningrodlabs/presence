import { describe, it, expect } from 'vitest';
import {
  decideAutoFlip,
  resolveWebrtcImpl,
} from '../auto-flip-policy';

describe('resolveWebrtcImpl — symmetric union with per-peer overrides', () => {
  it('defaults to simplepeer when neither side has a preference', () => {
    expect(resolveWebrtcImpl('simplepeer', undefined, 'simplepeer', undefined)).toBe(
      'simplepeer',
    );
  });

  it('uses fsm when my global preference is fsm', () => {
    expect(resolveWebrtcImpl('fsm', undefined, 'simplepeer', undefined)).toBe('fsm');
  });

  it('uses fsm when peer global preference is fsm (symmetric union)', () => {
    expect(resolveWebrtcImpl('simplepeer', undefined, 'fsm', undefined)).toBe('fsm');
  });

  it('my override wins over my global', () => {
    expect(resolveWebrtcImpl('fsm', 'simplepeer', 'simplepeer', undefined)).toBe(
      'simplepeer',
    );
    expect(resolveWebrtcImpl('simplepeer', 'fsm', 'simplepeer', undefined)).toBe('fsm');
  });

  it('peer override wins over my global when I have no override', () => {
    expect(resolveWebrtcImpl('fsm', undefined, 'fsm', 'simplepeer')).toBe('simplepeer');
    expect(resolveWebrtcImpl('simplepeer', undefined, 'simplepeer', 'fsm')).toBe('fsm');
  });

  it('agreeing overrides apply unchanged', () => {
    expect(resolveWebrtcImpl('fsm', 'simplepeer', 'fsm', 'simplepeer')).toBe(
      'simplepeer',
    );
    expect(resolveWebrtcImpl('simplepeer', 'fsm', 'simplepeer', 'fsm')).toBe('fsm');
  });

  it('disagreeing overrides resolve to simplepeer (conservative tiebreaker)', () => {
    // The Phase 3 auto-toggle relies on this — pinning a failing link
    // to simplepeer should stick even if the peer's last decision was fsm.
    expect(resolveWebrtcImpl('fsm', 'simplepeer', 'fsm', 'fsm')).toBe('simplepeer');
    expect(resolveWebrtcImpl('simplepeer', 'fsm', 'simplepeer', 'simplepeer')).toBe(
      'simplepeer',
    );
  });

  it('overrides outrank globals on both sides', () => {
    // Both global=fsm but I override to simplepeer — link uses simplepeer.
    expect(resolveWebrtcImpl('fsm', 'simplepeer', 'fsm', undefined)).toBe('simplepeer');
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
