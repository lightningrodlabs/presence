import { describe, it, expect } from 'vitest';
import { routeTransportPhase, decideSlotWrite } from '../media-event-policy';
import type { TransportPhaseRoute } from '../media-event-policy';
import type { ConnectionPhase } from '../types';

/**
 * The point of this suite is the first table: it enumerates **all eight**
 * `ConnectionPhase` members. The bug this replaces was an omission, not a
 * wrong answer — `_dispatchMediaEvent` handled three phases and dropped
 * five, including `failed`. A row per phase makes a dropped phase a
 * failing test rather than an invisible gap, and the `never` assignment in
 * the policy makes a *new* phase a compile error.
 */

const ALL_PHASES: ConnectionPhase[] = [
  'idle',
  'signaling',
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
  'failed',
  'closed',
];

describe('routeTransportPhase — every ConnectionPhase is routed', () => {
  const table: Array<[ConnectionPhase, TransportPhaseRoute]> = [
    ['idle', { handler: 'media-closed', reason: 'peer-destroyed' }],
    [
      'signaling',
      {
        handler: 'start-ice-monitor',
        slot: { action: 'install' },
        reason: 'signaling-started',
      },
    ],
    ['connecting', { handler: 'ignore', reason: 'establishing' }],
    ['connected', { handler: 'media-connected', reason: 'transport-up' }],
    ['reconnecting', { handler: 'ignore', reason: 'transport-owns-recovery' }],
    ['disconnected', { handler: 'ignore', reason: 'transport-owns-recovery' }],
    ['failed', { handler: 'media-closed', reason: 'gave-up' }],
    ['closed', { handler: 'media-closed', reason: 'transport-closed' }],
  ];

  it('covers the whole union — no phase may be added without a row here', () => {
    expect(table.map(([phase]) => phase).sort()).toEqual([...ALL_PHASES].sort());
  });

  it.each(table)('%s routes as expected', (phase, expected) => {
    expect(
      routeTransportPhase({
        phase,
        connectionId: 'c1',
        openConnectionId: undefined,
      }),
    ).toEqual(expected);
  });
});

describe('routeTransportPhase — the carrier-coverage invariant', () => {
  /**
   * §3.1(c): a peer must never be left with an `_openConnections` entry
   * that no longer has a live `RTCPeerConnection` behind it, because the
   * signals carrier is the complement of that map. Every terminal phase
   * has to clear the slot.
   */
  const TERMINAL: ConnectionPhase[] = ['failed', 'idle', 'closed'];

  it.each(TERMINAL)('%s clears the connection slot', phase => {
    expect(
      routeTransportPhase({
        phase,
        connectionId: 'c1',
        openConnectionId: 'c1',
      }).handler,
    ).toBe('media-closed');
  });

  const TRANSIENT: ConnectionPhase[] = ['reconnecting', 'disconnected', 'connecting'];

  it.each(TRANSIENT)('%s does not clear the slot — the transport owns recovery', phase => {
    expect(
      routeTransportPhase({
        phase,
        connectionId: 'c1',
        openConnectionId: 'c1',
      }).handler,
    ).toBe('ignore');
  });
});

describe('routeTransportPhase — slot identity', () => {
  const signaling = (
    connectionId: string,
    openConnectionId: string | undefined,
  ) =>
    routeTransportPhase({ phase: 'signaling', connectionId, openConnectionId });

  it('installs a slot for an FSM peer that has none (acceptor path)', () => {
    expect(signaling('new', undefined)).toEqual({
      handler: 'start-ice-monitor',
      slot: { action: 'install' },
      reason: 'signaling-started',
    });
  });

  it('keeps a slot that already names this connection', () => {
    expect(signaling('same', 'same')).toEqual({
      handler: 'start-ice-monitor',
      slot: { action: 'keep' },
      reason: 'signaling-started',
    });
  });

  /**
   * The §3.1(c) route that Phase 1's `failed` handling does not cover.
   * `ConnectionManager` replaces an FSM in place on a higher-epoch offer and
   * on a new remote session, both via `fsm.destroy()` — which emits no
   * transition, so the store never sees a `closed` for the old id. If the
   * slot keeps that id, every later connect/close for this peer hits its
   * supersede guard and returns early, and a slot that was `connected: true`
   * at the moment of replacement stays `connected: true` forever: a rendered
   * pane over a dead link, permanently excluded from `_signalsTargets`.
   */
  it('adopts the live connection when the slot names a replaced one', () => {
    expect(signaling('new', 'stale')).toEqual({
      handler: 'start-ice-monitor',
      slot: { action: 'adopt', supersedes: 'stale' },
      reason: 'signaling-started',
    });
  });

  it('carries the superseded id so the caller can retire its per-connection state', () => {
    const route = signaling('new', 'stale');
    expect(route.handler).toBe('start-ice-monitor');
    if (route.handler !== 'start-ice-monitor') throw new Error('unreachable');
    expect(route.slot).toEqual({ action: 'adopt', supersedes: 'stale' });
  });

});

describe('decideSlotWrite — the slot transition, shared by store and harness', () => {
  // PR #3 review finding F1: the harness's hand-written mirror of these
  // rules drifted from the store before it merged — adopt preserved a stale
  // `connected: true`, and connect skipped the supersede guard. These rows
  // pin both, and the shared function makes a re-divergence impossible
  // rather than merely tested.

  const live = { connectionId: 'live-1', connected: true };
  const establishing = { connectionId: 'live-1', connected: false };

  it('signaling/install creates the slot at connected: false', () => {
    expect(
      decideSlotWrite({ kind: 'signaling', slot: { action: 'install' } }, 'new-1', undefined),
    ).toEqual({ write: 'install', slot: { connectionId: 'new-1', connected: false } });
  });

  it('signaling/adopt REPLACES the slot at connected: false — never preserves the stale claim (F1a pin)', () => {
    expect(
      decideSlotWrite(
        { kind: 'signaling', slot: { action: 'adopt', supersedes: 'dead-0' } },
        'new-1',
        live,
      ),
    ).toEqual({
      write: 'replace',
      slot: { connectionId: 'new-1', connected: false },
      supersedes: 'dead-0',
    });
  });

  it('signaling/keep writes nothing', () => {
    expect(
      decideSlotWrite({ kind: 'signaling', slot: { action: 'keep' } }, 'live-1', establishing),
    ).toEqual({ write: 'none', reason: 'kept' });
  });

  it('connected with the matching id sets connected: true', () => {
    expect(decideSlotWrite({ kind: 'connected' }, 'live-1', establishing)).toEqual({
      write: 'set-connected',
      slot: { connectionId: 'live-1', connected: true },
    });
  });

  it('connected with a mismatched id is superseded — the old peer must not mutate the new slot (F1b pin)', () => {
    expect(decideSlotWrite({ kind: 'connected' }, 'old-0', live)).toEqual({
      write: 'none',
      reason: 'superseded',
      supersededBy: 'live-1',
    });
  });

  it('connected with no slot is a drop (closed mid-handshake)', () => {
    expect(decideSlotWrite({ kind: 'connected' }, 'any', undefined)).toEqual({
      write: 'none',
      reason: 'no-slot',
    });
  });

  it('closed with the matching id clears the slot', () => {
    expect(decideSlotWrite({ kind: 'closed' }, 'live-1', live)).toEqual({ write: 'clear' });
  });

  it('closed with a mismatched id is superseded — a newer connection owns the slot', () => {
    expect(decideSlotWrite({ kind: 'closed' }, 'old-0', live)).toEqual({
      write: 'none',
      reason: 'superseded',
      supersededBy: 'live-1',
    });
  });

  it('closed with no slot is a duplicate close — nothing to write', () => {
    expect(decideSlotWrite({ kind: 'closed' }, 'live-1', undefined)).toEqual({
      write: 'none',
      reason: 'no-slot',
    });
  });
});
