/**
 * Phase 2b — the synchronous-emit invariant, asserted.
 *
 * `StreamsStore`'s teardown paths are only correct because a transport's
 * `_emit` is synchronous: when `closeConnection` (or a supersede inside
 * `ensureConnection`) returns, a `closed` state-change has already been
 * delivered to every subscribed handler. The store's cleanup sites
 * (`_applyStaleTeardown`, the LeaveUi teardown, the SDP-timeout teardown)
 * close the connection and then rewrite their slots in straight-line
 * code — if a transport deferred that emit to a task or microtask, it
 * would arrive *after* the slot rewrite and `routeTransportPhase` would
 * process a close against state that has already moved on.
 *
 * The invariant spans a package boundary (FsmTransport relays
 * ConnectionManager events from packages/webrtc-peer) and was previously
 * documented nowhere (MAINTAINABILITY_ASSESSMENT.md, unscheduled-defects
 * table). This suite fails if the transport starts deferring its emit.
 *
 * History: the suite used to assert the same invariant for
 * SimplePeerTransport (and pinned its double-`closed` teardown quirk);
 * that half was deleted with SimplePeer in Phase 3. Consumers of `closed`
 * must stay idempotent regardless — duplicate closes remain possible
 * across supersede races.
 *
 * The probe: record handler firings and the call's return into one
 * ordered list. A synchronous emit lands before 'returned'; a deferred
 * one lands after. The negative control at the bottom shows the probe
 * actually distinguishes the two — without it, a probe that always
 * passed would be indistinguishable from a working one.
 */

import { describe, it, expect } from 'vitest';
import { FsmTransport } from '../fsm/fsm-transport';
import type { OutgoingSignal } from '../types';
import { MockRTCPeerConnection } from '../../../../packages/webrtc-peer/src/__tests__/test-helpers';

const PEER_A = 'aaaa';
const PEER_B = 'bbbb';

function setupFsm() {
  const outgoing: OutgoingSignal[] = [];
  return new FsmTransport({
    myAgentId: PEER_A,
    onOutgoingSignal: signal => outgoing.push(signal),
    createPeerConnection: (config: RTCConfiguration) =>
      new MockRTCPeerConnection(config) as unknown as RTCPeerConnection,
  });
}

/** Everything recorded strictly before the call returned. */
const beforeReturn = (order: string[]): string[] =>
  order.slice(0, order.indexOf('returned'));

describe('synchronous-emit invariant — FsmTransport', () => {
  it('closeConnection delivers closed exactly once, before it returns', () => {
    const transport = setupFsm();
    transport.ensureConnection(PEER_B, { initiator: true });

    const order: string[] = [];
    transport.onAny(e => {
      if (e.type === 'connection-state-change' && e.phase === 'closed') {
        order.push('closed-event');
      }
    });
    transport.closeConnection(PEER_B, 'test');
    order.push('returned');

    expect(order).toEqual(['closed-event', 'returned']);
  });
});

describe('the probe itself (negative control)', () => {
  it('detects a deferred emit — the pattern above is capable of failing', async () => {
    // A hypothetical transport that defers its emit by one microtask.
    // The same record-order probe must catch it; if this test ever
    // passes with the event before 'returned', the probe is broken and
    // every assertion above is vacuous.
    const order: string[] = [];
    const deferredEmit = () => queueMicrotask(() => order.push('event'));

    deferredEmit();
    order.push('returned');

    expect(beforeReturn(order)).not.toContain('event');
    await Promise.resolve();
    expect(order).toEqual(['returned', 'event']);
  });
});
