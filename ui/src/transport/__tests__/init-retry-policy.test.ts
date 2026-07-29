import { describe, it, expect } from 'vitest';
import { decideInitRetry } from '../init-retry-policy';
import type { InitRetryInputs } from '../init-retry-policy';

// Since Phase 3 this policy serves the video connection only: the
// screen-share port replaced its InitRequest cadence with the idempotent
// `_ensureOutgoingScreenShare`, deleting the `kind` axis and both screen
// divergence rows (no-tie-break, InitSent re-assertion) this file used to
// pin.

const NOW = 1_000_000;
const THRESHOLD = 5_000;

// PEER_LOW < MY < PEER_HIGH alphabetically.
const MY = 'mmmm';
const PEER_LOW = 'aaaa';
const PEER_HIGH = 'zzzz';

const inputs = (over: Partial<InitRetryInputs> = {}): InitRetryInputs => ({
  alreadyOpen: false,
  myPubKeyB64: MY,
  peerPubKeyB64: PEER_LOW,
  pendingInitT0s: undefined,
  now: NOW,
  retryThresholdMs: THRESHOLD,
  ...over,
});

describe('decideInitRetry', () => {
  it('sends a first init to a lower-pubkey peer with nothing pending', () => {
    expect(decideInitRetry(inputs())).toEqual({
      action: 'send-init',
      attempt: 1,
      reason: 'no-pending-init',
    });
  });

  it('holds while already open', () => {
    expect(decideInitRetry(inputs({ alreadyOpen: true }))).toEqual({
      action: 'hold',
      reason: 'already-open',
    });
  });

  it('defers to a higher-pubkey peer: AwaitingInit when nothing is pending', () => {
    expect(decideInitRetry(inputs({ peerPubKeyB64: PEER_HIGH }))).toEqual({
      action: 'await-peer-init',
      reason: 'peer-initiates-no-pending',
    });
  });

  it('defers to a higher-pubkey peer: silent hold when something is pending', () => {
    expect(
      decideInitRetry(inputs({ peerPubKeyB64: PEER_HIGH, pendingInitT0s: [NOW - 1] })),
    ).toEqual({
      action: 'hold',
      reason: 'peer-initiates',
    });
  });

  it('retries once the latest pending init exceeds the threshold', () => {
    expect(
      decideInitRetry(inputs({ pendingInitT0s: [NOW - THRESHOLD - 1] })),
    ).toEqual({
      action: 'send-init',
      attempt: 2,
      reason: 'retry-threshold-exceeded',
    });
  });

  it('the LATEST pending init is what the threshold measures', () => {
    // An old stale entry must not trigger a retry while a fresh one waits.
    expect(
      decideInitRetry(
        inputs({ pendingInitT0s: [NOW - THRESHOLD * 10, NOW - 1] }),
      ).action,
    ).toBe('hold');
  });

  it('within the threshold, holds', () => {
    expect(decideInitRetry(inputs({ pendingInitT0s: [NOW - 1] }))).toEqual({
      action: 'hold',
      reason: 'within-threshold',
    });
  });

  it('exactly at the threshold is within it (strict >)', () => {
    expect(
      decideInitRetry(inputs({ pendingInitT0s: [NOW - THRESHOLD] })).action,
    ).toBe('hold');
  });

  it('counts attempts from the full pending list on retry', () => {
    expect(
      decideInitRetry(
        inputs({ pendingInitT0s: [NOW - THRESHOLD * 3, NOW - THRESHOLD - 1] }),
      ),
    ).toEqual({
      action: 'send-init',
      attempt: 3,
      reason: 'retry-threshold-exceeded',
    });
  });
});
