import { describe, it, expect } from 'vitest';
import { decideInitRetry } from '../init-retry-policy';
import type { InitRetryInputs } from '../init-retry-policy';

const NOW = 1_000_000;
const THRESHOLD = 5_000;

// PEER_LOW < MY < PEER_HIGH alphabetically.
const MY = 'mmmm';
const PEER_LOW = 'aaaa';
const PEER_HIGH = 'zzzz';

const video = (over: Partial<InitRetryInputs> = {}): InitRetryInputs => ({
  kind: 'video',
  alreadyOpen: false,
  myPubKeyB64: MY,
  peerPubKeyB64: PEER_LOW,
  pendingInitT0s: undefined,
  now: NOW,
  retryThresholdMs: THRESHOLD,
  ...over,
});

const screen = (over: Partial<InitRetryInputs> = {}): InitRetryInputs => ({
  ...video(over),
  kind: 'screen-share',
  // Screen share ignores the tie-break; default to the peer the video
  // path would defer to, so any test passing by accident of pubkey
  // ordering fails loudly instead.
  peerPubKeyB64: over.peerPubKeyB64 ?? PEER_HIGH,
});

describe('decideInitRetry — video', () => {
  it('sends a first init to a lower-pubkey peer with nothing pending', () => {
    expect(decideInitRetry(video())).toEqual({
      action: 'send-init',
      attempt: 1,
      setStatusInitSent: true,
      reason: 'no-pending-init',
    });
  });

  it('holds while already open', () => {
    expect(decideInitRetry(video({ alreadyOpen: true }))).toEqual({
      action: 'hold',
      setStatusInitSent: false,
      reason: 'already-open',
    });
  });

  it('defers to a higher-pubkey peer: AwaitingInit when nothing is pending', () => {
    expect(decideInitRetry(video({ peerPubKeyB64: PEER_HIGH }))).toEqual({
      action: 'await-peer-init',
      reason: 'peer-initiates-no-pending',
    });
  });

  it('defers to a higher-pubkey peer: silent hold when something is pending', () => {
    expect(
      decideInitRetry(video({ peerPubKeyB64: PEER_HIGH, pendingInitT0s: [NOW - 1] })),
    ).toEqual({
      action: 'hold',
      setStatusInitSent: false,
      reason: 'peer-initiates',
    });
  });

  it('retries once the latest pending init exceeds the threshold', () => {
    expect(
      decideInitRetry(video({ pendingInitT0s: [NOW - THRESHOLD - 1] })),
    ).toEqual({
      action: 'send-init',
      attempt: 2,
      setStatusInitSent: true,
      reason: 'retry-threshold-exceeded',
    });
  });

  it('the LATEST pending init is what the threshold measures', () => {
    // An old stale entry must not trigger a retry while a fresh one waits.
    expect(
      decideInitRetry(
        video({ pendingInitT0s: [NOW - THRESHOLD * 10, NOW - 1] }),
      ).action,
    ).toBe('hold');
  });

  it('within the threshold, holds WITHOUT re-asserting InitSent', () => {
    // The divergence row, video column.
    expect(decideInitRetry(video({ pendingInitT0s: [NOW - 1] }))).toEqual({
      action: 'hold',
      setStatusInitSent: false,
      reason: 'within-threshold',
    });
  });

  it('exactly at the threshold is within it (strict >)', () => {
    expect(
      decideInitRetry(video({ pendingInitT0s: [NOW - THRESHOLD] })).action,
    ).toBe('hold');
  });
});

describe('decideInitRetry — screen share', () => {
  it('has no tie-break: the sharer initiates toward a higher-pubkey peer', () => {
    expect(decideInitRetry(screen({ peerPubKeyB64: PEER_HIGH }))).toEqual({
      action: 'send-init',
      attempt: 1,
      setStatusInitSent: true,
      reason: 'no-pending-init',
    });
  });

  it('and toward a lower-pubkey peer', () => {
    expect(decideInitRetry(screen({ peerPubKeyB64: PEER_LOW })).action).toBe(
      'send-init',
    );
  });

  it('holds while an outgoing share slot already exists', () => {
    expect(decideInitRetry(screen({ alreadyOpen: true }))).toEqual({
      action: 'hold',
      setStatusInitSent: false,
      reason: 'already-open',
    });
  });

  it('retries past the threshold, counting attempts', () => {
    expect(
      decideInitRetry(
        screen({ pendingInitT0s: [NOW - THRESHOLD * 3, NOW - THRESHOLD - 1] }),
      ),
    ).toEqual({
      action: 'send-init',
      attempt: 3,
      setStatusInitSent: true,
      reason: 'retry-threshold-exceeded',
    });
  });

  it('within the threshold, holds but RE-ASSERTS InitSent', () => {
    // The divergence row, screen column: the inline code wrote
    // updateScreenShareConnectionStatus(InitSent) outside the threshold
    // check, so it fired on every pong while waiting. Preserved on
    // purpose; flip this expectation only as a deliberate behavior
    // change.
    expect(decideInitRetry(screen({ pendingInitT0s: [NOW - 1] }))).toEqual({
      action: 'hold',
      setStatusInitSent: true,
      reason: 'within-threshold',
    });
  });
});
