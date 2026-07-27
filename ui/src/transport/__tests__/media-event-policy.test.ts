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
      { handler: 'start-ice-monitor', installSlot: true, reason: 'signaling-started' },
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
      routeTransportPhase({ phase, impl: 'fsm', hasOpenConnection: false }),
    ).toEqual(expected);
  });

  it.each(ALL_PHASES)('simplepeer/%s never returns an unhandled route', phase => {
    const route = routeTransportPhase({
      phase,
      impl: 'simplepeer',
      hasOpenConnection: false,
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
        routeTransportPhase({ phase, impl, hasOpenConnection: true }).handler,
      ).toBe('media-closed');
    }
  });

  const TRANSIENT: ConnectionPhase[] = ['reconnecting', 'disconnected', 'connecting'];

  it.each(TRANSIENT)('%s does not clear the slot — the transport owns recovery', phase => {
    for (const impl of ['fsm', 'simplepeer'] as const) {
      expect(
        routeTransportPhase({ phase, impl, hasOpenConnection: true }).handler,
      ).toBe('ignore');
    }
  });
});

describe('routeTransportPhase — acceptor slot installation', () => {
  it('installs a slot for an FSM peer that has none (acceptor path)', () => {
    expect(
      routeTransportPhase({
        phase: 'signaling',
        impl: 'fsm',
        hasOpenConnection: false,
      }),
    ).toEqual({
      handler: 'start-ice-monitor',
      installSlot: true,
      reason: 'signaling-started',
    });
  });

  it('does not overwrite an existing FSM slot', () => {
    expect(
      routeTransportPhase({
        phase: 'signaling',
        impl: 'fsm',
        hasOpenConnection: true,
      }),
    ).toEqual({
      handler: 'start-ice-monitor',
      installSlot: false,
      reason: 'signaling-started',
    });
  });

  it('never installs a slot for SimplePeer — handleSdpData/handleInitAccept own that', () => {
    for (const hasOpenConnection of [true, false]) {
      expect(
        routeTransportPhase({
          phase: 'signaling',
          impl: 'simplepeer',
          hasOpenConnection,
        }),
      ).toEqual({
        handler: 'start-ice-monitor',
        installSlot: false,
        reason: 'signaling-started',
      });
    }
  });
});
