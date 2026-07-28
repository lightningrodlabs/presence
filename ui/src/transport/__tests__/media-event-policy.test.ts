import { describe, it, expect } from 'vitest';
import { routeTransportPhase } from '../media-event-policy';
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

  it.each(table)('fsm/%s routes as expected', (phase, expected) => {
    expect(
      routeTransportPhase({
        phase,
        impl: 'fsm',
        connectionId: 'c1',
        openConnectionId: undefined,
      }),
    ).toEqual(expected);
  });

  it.each(ALL_PHASES)('simplepeer/%s never returns an unhandled route', phase => {
    const route = routeTransportPhase({
      phase,
      impl: 'simplepeer',
      connectionId: 'c1',
      openConnectionId: undefined,
    });
    expect(['start-ice-monitor', 'media-connected', 'media-closed', 'ignore']).toContain(
      route.handler,
    );
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
    for (const impl of ['fsm', 'simplepeer'] as const) {
      expect(
        routeTransportPhase({
          phase,
          impl,
          connectionId: 'c1',
          openConnectionId: 'c1',
        }).handler,
      ).toBe('media-closed');
    }
  });

  const TRANSIENT: ConnectionPhase[] = ['reconnecting', 'disconnected', 'connecting'];

  it.each(TRANSIENT)('%s does not clear the slot — the transport owns recovery', phase => {
    for (const impl of ['fsm', 'simplepeer'] as const) {
      expect(
        routeTransportPhase({
          phase,
          impl,
          connectionId: 'c1',
          openConnectionId: 'c1',
        }).handler,
      ).toBe('ignore');
    }
  });
});

describe('routeTransportPhase — slot identity', () => {
  const signaling = (
    impl: 'simplepeer' | 'fsm',
    connectionId: string,
    openConnectionId: string | undefined,
  ) =>
    routeTransportPhase({ phase: 'signaling', impl, connectionId, openConnectionId });

  it('installs a slot for an FSM peer that has none (acceptor path)', () => {
    expect(signaling('fsm', 'new', undefined)).toEqual({
      handler: 'start-ice-monitor',
      slot: { action: 'install' },
      reason: 'signaling-started',
    });
  });

  it('keeps a slot that already names this connection', () => {
    expect(signaling('fsm', 'same', 'same')).toEqual({
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
    expect(signaling('fsm', 'new', 'stale')).toEqual({
      handler: 'start-ice-monitor',
      slot: { action: 'adopt', supersedes: 'stale' },
      reason: 'signaling-started',
    });
  });

  it('carries the superseded id so the caller can retire its per-connection state', () => {
    const route = signaling('fsm', 'new', 'stale');
    expect(route.handler).toBe('start-ice-monitor');
    if (route.handler !== 'start-ice-monitor') throw new Error('unreachable');
    expect(route.slot).toEqual({ action: 'adopt', supersedes: 'stale' });
  });

  it('never touches the slot for SimplePeer — the store owns both its paths', () => {
    // SimplePeer honours the connectionId the store hands it, so a mismatch
    // here would mean the store superseding itself; adopting would fight the
    // supersede semantics handleSdpData / handleInitAccept rely on.
    for (const open of [undefined, 'same', 'stale']) {
      expect(signaling('simplepeer', 'same', open)).toEqual({
        handler: 'start-ice-monitor',
        slot: { action: 'keep' },
        reason: 'signaling-started',
      });
    }
  });
});
