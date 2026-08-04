/**
 * Round 3 item 1 as amended (review F2) — the transport's error-event
 * forwarding, pinned at the FsmTransport seam.
 *
 * FSM error events (negotiation exceptions, data-channel errors) used to
 * die inside ConnectionManager; the manager now forwards them (pinned in
 * the library's connection-manager.test.ts) and FsmTransport emits them
 * as transport `error` events — forensic-only; the store handlers log
 * and touch nothing.
 *
 * The declared decision pinned here: blocked-transition error records
 * (`data.blocked === true`) are NOT forwarded — the FSM reports refused
 * transitions on the `onTransition` stream too, which the store already
 * logs as `FsmTransition BLOCKED:` entries; forwarding them would state
 * the same fact under a second event name. Whoever wants blocked
 * transitions on the transport surface retires this filter AND this pin
 * together.
 */

import { describe, it, expect } from 'vitest';
import { FsmTransport } from '../fsm/fsm-transport';
import type { TransportEvent } from '../types';
import { MockRTCPeerConnection } from '../../../../packages/webrtc-peer/src/__tests__/test-helpers';

const PEER_A = 'aaaa';
const PEER_B = 'bbbb';

function setup() {
  const transport = new FsmTransport({
    myAgentId: PEER_A,
    onOutgoingSignal: () => {},
    createPeerConnection: (config: RTCConfiguration) =>
      new MockRTCPeerConnection(config) as unknown as RTCPeerConnection,
  });
  const events: TransportEvent[] = [];
  transport.onAny(ev => events.push(ev));
  // The manager seam: emitting through it exercises exactly the
  // subscription FsmTransport installs (the manager's own fsm→manager
  // forwarding is the library test's job).
  const emitManagerError = (data: unknown) =>
    (transport as any)._manager._emitManagerEvent({
      type: 'error',
      remoteAgent: PEER_B,
      connectionId: 'c-1',
      data,
    });
  return { transport, events, emitManagerError };
}

describe('FsmTransport error forwarding (forensic-only surface)', () => {
  it('forwards a manager error event as a transport error with the exception preserved', () => {
    const { events, emitManagerError } = setup();
    const boom = new Error('setRemoteDescription failed: InvalidStateError');
    emitManagerError(boom);
    const errors = events.filter(e => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      peer: PEER_B,
      connectionId: 'c-1',
      error: boom,
    });
  });

  it('normalizes non-Error payloads into an Error so the store logs something readable', () => {
    const { events, emitManagerError } = setup();
    emitManagerError('string went wrong');
    const errors = events.filter(e => e.type === 'error') as Array<
      Extract<TransportEvent, { type: 'error' }>
    >;
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBeInstanceOf(Error);
    expect(errors[0].error.message).toBe('string went wrong');
  });

  it('DECLARED DECISION: blocked-transition records are filtered, not forwarded', () => {
    const { events, emitManagerError } = setup();
    emitManagerError({ blocked: true, fromState: 'connected', toState: 'idle', trigger: 'x' });
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
    // Negative control: the same shape without the blocked flag forwards.
    emitManagerError({ fromState: 'connected' });
    expect(events.filter(e => e.type === 'error')).toHaveLength(1);
  });
});
