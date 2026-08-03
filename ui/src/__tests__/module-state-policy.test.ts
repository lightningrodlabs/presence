import { describe, it, expect } from 'vitest';
import { decideModuleStateMerge } from '../module-state-policy';
import type { ModuleStateMergeInputs } from '../module-state-policy';
import type { ModuleStateEnvelope } from '../types';

/**
 * Round 3 item 3 — the one `_peerModuleStates` merge rule, table-tested.
 * The named row this file exists for is the flicker interleave:
 * push-then-stale-pong must NOT delete
 * (`in-flight-pong-older-than-entry`).
 */

const env = (over: Partial<ModuleStateEnvelope> = {}): ModuleStateEnvelope => ({
  moduleId: 'clock',
  active: true,
  payload: '{}',
  updatedAt: 1000,
  ...over,
});

const decide = (over: Partial<ModuleStateMergeInputs>) =>
  decideModuleStateMerge({
    current: null,
    incoming: null,
    source: 'push',
    ...over,
  });

describe('push rows — updatedAt LWW for set AND delete', () => {
  it('a new active push installs', () => {
    expect(decide({ incoming: env() })).toEqual({
      action: 'set',
      envelope: env(),
      reason: 'new-module',
    });
  });

  it('a newer active push replaces', () => {
    expect(
      decide({ current: env({ updatedAt: 500 }), incoming: env({ updatedAt: 1000 }) }),
    ).toMatchObject({ action: 'set', reason: 'newer-push' });
  });

  it('an equal-stamp push wins — the sender repeating itself, latest arrival applies', () => {
    expect(
      decide({
        current: env({ payload: '{"a":1}' }),
        incoming: env({ payload: '{"a":2}' }),
      }),
    ).toMatchObject({ action: 'set', reason: 'newer-push' });
  });

  it('a STALE active push loses (declared change: it used to apply unconditionally)', () => {
    expect(
      decide({ current: env({ updatedAt: 2000 }), incoming: env({ updatedAt: 1000 }) }),
    ).toEqual({ action: 'keep', reason: 'stale-push' });
  });

  it('a newer deactivation push deletes', () => {
    expect(
      decide({
        current: env({ updatedAt: 500 }),
        incoming: env({ active: false, updatedAt: 1000 }),
      }),
    ).toEqual({ action: 'delete', reason: 'push-deactivated' });
  });

  it('a stale deactivation push loses everywhere', () => {
    expect(
      decide({
        current: env({ updatedAt: 2000 }),
        incoming: env({ active: false, updatedAt: 1000 }),
      }),
    ).toEqual({ action: 'keep', reason: 'stale-push' });
  });

  it('deactivating an absent module is inert', () => {
    expect(decide({ incoming: env({ active: false }) })).toEqual({
      action: 'keep',
      reason: 'already-absent',
    });
  });

  it('a push without an envelope is inert, not a delete', () => {
    expect(decide({ incoming: null })).toEqual({
      action: 'keep',
      reason: 'push-without-envelope',
    });
  });
});

describe('pong-sweep entry rows', () => {
  const sweep = (over: Partial<ModuleStateMergeInputs>) =>
    decide({ source: 'pong-sweep', sweepStamp: 5000, ...over });

  it('an unknown module from the pong installs (late-joiner catch-up)', () => {
    expect(sweep({ incoming: env() })).toMatchObject({
      action: 'set',
      reason: 'new-from-pong',
    });
  });

  it('a strictly newer, different entry replaces', () => {
    expect(
      sweep({
        current: env({ updatedAt: 500, payload: '{"a":1}' }),
        incoming: env({ updatedAt: 1000, payload: '{"a":2}' }),
      }),
    ).toMatchObject({ action: 'set', reason: 'newer-pong-entry' });
  });

  it('a newer but identical entry is a keep (the pre-change dedupe, preserved)', () => {
    expect(
      sweep({
        current: env({ updatedAt: 500 }),
        incoming: env({ updatedAt: 1000 }),
      }),
    ).toEqual({ action: 'keep', reason: 'identical' });
  });

  it('an equal-or-older pong entry never overwrites (strict >, unlike push)', () => {
    expect(
      sweep({
        current: env({ updatedAt: 1000, payload: '{"a":1}' }),
        incoming: env({ updatedAt: 1000, payload: '{"a":2}' }),
      }),
    ).toEqual({ action: 'keep', reason: 'stale-pong-entry' });
  });

  it('a strictly newer inactive entry deletes; a stale one does not', () => {
    expect(
      sweep({
        current: env({ updatedAt: 500 }),
        incoming: env({ active: false, updatedAt: 1000 }),
      }),
    ).toEqual({ action: 'delete', reason: 'pong-entry-deactivated' });
    expect(
      sweep({
        current: env({ updatedAt: 2000 }),
        incoming: env({ active: false, updatedAt: 1000 }),
      }),
    ).toEqual({ action: 'keep', reason: 'stale-pong-entry' });
  });
});

describe('pong-sweep absence rows — the flicker interleave', () => {
  it('THE NAMED ROW: a module pushed AFTER the pong was serialized survives the sweep (push-then-stale-pong must not delete)', () => {
    // The interleave: peer activates a module at t=2000 and pushes; a
    // pong serialized at t=1500 (before the activation) arrives after
    // the push and does not list the module. Deleting here was the
    // silent ~2s module flicker.
    expect(
      decide({
        source: 'pong-sweep',
        current: env({ updatedAt: 2000 }),
        incoming: null,
        sweepStamp: 1500,
      }),
    ).toEqual({ action: 'keep', reason: 'in-flight-pong-older-than-entry' });
  });

  it('a pong serialized after the entry was stamped sweeps it (genuine deactivation healing)', () => {
    expect(
      decide({
        source: 'pong-sweep',
        current: env({ updatedAt: 2000 }),
        incoming: null,
        sweepStamp: 2500,
      }),
    ).toEqual({ action: 'delete', reason: 'swept-by-newer-pong' });
  });

  it('an equal-stamp sweep keeps — deletion requires strictly newer evidence', () => {
    expect(
      decide({
        source: 'pong-sweep',
        current: env({ updatedAt: 2000 }),
        incoming: null,
        sweepStamp: 2000,
      }),
    ).toEqual({ action: 'keep', reason: 'in-flight-pong-older-than-entry' });
  });

  it('a legacy pong with no stamp at all keeps the pre-change unconditional sweep', () => {
    expect(
      decide({
        source: 'pong-sweep',
        current: env({ updatedAt: 2000 }),
        incoming: null,
        sweepStamp: undefined,
      }),
    ).toEqual({ action: 'delete', reason: 'legacy-pong-unconditional-sweep' });
  });

  it('absence of an absent module is inert', () => {
    expect(
      decide({ source: 'pong-sweep', incoming: null, sweepStamp: 5000 }),
    ).toEqual({ action: 'keep', reason: 'already-absent' });
  });
});
