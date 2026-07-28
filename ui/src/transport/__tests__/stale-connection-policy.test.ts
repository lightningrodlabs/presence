import { describe, it, expect } from 'vitest';
import { decideStaleConnectionCleanup } from '../stale-connection-policy';
import type {
  StaleConnectionInputs,
  StaleConnectionDecision,
} from '../stale-connection-policy';

const NOW = 1_000_000;
const GRACE = 15_000;

/** SimplePeer carrier, established connection, ICE healthy. */
const base: StaleConnectionInputs = {
  hasExistingConn: true,
  slotClaimsConnected: true,
  carrierOwnsRecovery: false,
  iceState: 'connected',
  disconnectedAt: undefined,
  now: NOW,
  graceMs: GRACE,
};

describe('decideStaleConnectionCleanup — every ICE state is answered', () => {
  const ALL_ICE_STATES: Array<RTCIceConnectionState | undefined> = [
    undefined,
    'new',
    'checking',
    'connected',
    'completed',
    'disconnected',
    'failed',
    'closed',
  ];

  const table: Array<
    [RTCIceConnectionState | undefined, StaleConnectionDecision]
  > = [
    [undefined, { action: 'teardown', reason: 'pc-vanished' }],
    ['new', { action: 'keep', reason: 'ice-healthy' }],
    ['checking', { action: 'keep', reason: 'ice-healthy' }],
    ['connected', { action: 'keep', reason: 'ice-healthy' }],
    ['completed', { action: 'keep', reason: 'ice-healthy' }],
    // No `disconnectedAt` recorded, so the grace window has not started.
    ['disconnected', { action: 'keep', reason: 'within-grace' }],
    ['failed', { action: 'teardown', reason: 'ice-failed' }],
    ['closed', { action: 'teardown', reason: 'ice-closed' }],
  ];

  it('covers every ICE state, including the absent-pc case', () => {
    expect(table.map(([s]) => s)).toEqual(ALL_ICE_STATES);
  });

  it.each(table)('iceState=%s', (iceState, expected) => {
    expect(decideStaleConnectionCleanup({ ...base, iceState })).toEqual(expected);
  });
});

describe('decideStaleConnectionCleanup — the disconnected grace window', () => {
  it('holds inside the window', () => {
    expect(
      decideStaleConnectionCleanup({
        ...base,
        iceState: 'disconnected',
        disconnectedAt: NOW - GRACE,
      }),
    ).toEqual({ action: 'keep', reason: 'within-grace' });
  });

  it('tears down once the window is exceeded', () => {
    expect(
      decideStaleConnectionCleanup({
        ...base,
        iceState: 'disconnected',
        disconnectedAt: NOW - GRACE - 1,
      }),
    ).toEqual({ action: 'teardown', reason: 'grace-exceeded' });
  });

  it('treats a disconnectedAt of 0 as a real timestamp, not as absent', () => {
    // The inline form was `!!disconnectedAt`, which read 0 as "never
    // disconnected" and held the connection open forever.
    expect(
      decideStaleConnectionCleanup({
        ...base,
        iceState: 'disconnected',
        disconnectedAt: 0,
      }),
    ).toEqual({ action: 'teardown', reason: 'grace-exceeded' });
  });
});

describe('decideStaleConnectionCleanup — the zombie row (§3.1c)', () => {
  it('tears down a connected slot whose pc has vanished', () => {
    expect(
      decideStaleConnectionCleanup({
        ...base,
        iceState: undefined,
        slotClaimsConnected: true,
      }),
    ).toEqual({ action: 'teardown', reason: 'pc-vanished' });
  });

  it('leaves a slot that has no pc yet alone', () => {
    // Between installing the slot and the transport creating the peer,
    // `getRTCPeerConnection` legitimately returns undefined. Tearing down
    // here would kill every connection during setup.
    expect(
      decideStaleConnectionCleanup({
        ...base,
        iceState: undefined,
        slotClaimsConnected: false,
      }),
    ).toEqual({ action: 'keep', reason: 'establishing' });
  });
});

describe('decideStaleConnectionCleanup — one recovery controller per link', () => {
  /**
   * §3.4: this supervisor and the FSM's own recovery were both live on FSM
   * links. The guard has to dominate *every* teardown row — a full
   * reconnect has no pc for a moment while the slot still claims connected,
   * which is exactly the `pc-vanished` shape.
   */
  const TEARDOWN_SHAPES: Array<Partial<StaleConnectionInputs>> = [
    { iceState: 'failed' },
    { iceState: 'closed' },
    { iceState: undefined, slotClaimsConnected: true },
    { iceState: 'disconnected', disconnectedAt: NOW - GRACE - 1 },
  ];

  it.each(TEARDOWN_SHAPES)(
    'stands down for an FSM link that would otherwise be torn down (%o)',
    shape => {
      expect(
        decideStaleConnectionCleanup({
          ...base,
          ...shape,
          carrierOwnsRecovery: true,
        }),
      ).toEqual({ action: 'keep', reason: 'transport-owns-recovery' });
    },
  );

  it.each(TEARDOWN_SHAPES)(
    'still tears the same shape down on a SimplePeer link (%o)',
    shape => {
      expect(
        decideStaleConnectionCleanup({
          ...base,
          ...shape,
          carrierOwnsRecovery: false,
        }).action,
      ).toBe('teardown');
    },
  );
});

describe('decideStaleConnectionCleanup — no slot', () => {
  it('does nothing when there is no connection to clean up', () => {
    expect(
      decideStaleConnectionCleanup({
        ...base,
        hasExistingConn: false,
        iceState: 'failed',
      }),
    ).toEqual({ action: 'keep', reason: 'no-connection' });
  });
});
