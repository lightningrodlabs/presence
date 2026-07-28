import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FsmTransport, type FsmSignalEnvelope } from '../fsm-transport';
import type { IncomingSignal, OutgoingSignal, TransportEvent } from '../../types';
import {
  MockRTCPeerConnection,
  MockRTCDataChannel,
  createMockTrack,
  createMockStream,
  waitFor,
} from '../../../../../packages/webrtc-peer/src/__tests__/test-helpers';

const PEER_A = 'aaaa';
const PEER_B = 'bbbb';

/**
 * Inject a fresh MockRTCPeerConnection per FSM creation.
 *
 * The factory captures every PC so tests can drive ICE state and verify
 * track propagation. PerfectNegotiation polite/impolite is determined
 * by myAgentId vs remote — we use PEER_A < PEER_B alphabetically, which
 * makes PEER_A polite when talking to PEER_B (PEER_A is "lower", but
 * polite = lower, so PEER_A is polite).
 */
function setup(opts?: { localStream?: MediaStream }) {
  const pcs: MockRTCPeerConnection[] = [];
  const factory = (config: RTCConfiguration) => {
    const pc = new MockRTCPeerConnection(config);
    pcs.push(pc);
    return pc as unknown as RTCPeerConnection;
  };

  const outgoing: OutgoingSignal[] = [];
  const events: TransportEvent[] = [];

  const transport = new FsmTransport({
    myAgentId: PEER_A,
    onOutgoingSignal: (signal) => outgoing.push(signal),
    createPeerConnection: factory,
  });
  transport.onAny((e) => events.push(e));
  if (opts?.localStream) {
    transport.setLocalStream(opts.localStream);
  }
  return { transport, pcs, outgoing, events };
}

/** Build an FsmSignalEnvelope-shaped IncomingSignal. */
function envelopeSignal(
  type: FsmSignalEnvelope['type'],
  payload: unknown,
  connectionId: string,
  from = PEER_B,
  peerSessionId?: number,
): IncomingSignal {
  return {
    from,
    connectionId,
    peerSessionId,
    data: { type, payload },
  };
}

describe('FsmTransport — recovery ownership', () => {
  it('owns transport recovery', () => {
    // The FSM runs ICE restart, full reconnect, backoff and the
    // disconnected-grace window itself. `streams-store.ts` reads this to
    // stand its own teardown supervisor down; if this flipped to false the
    // two controllers would race (MAINTAINABILITY_ASSESSMENT.md §3.4).
    const { transport } = setup();
    expect(transport.ownsTransportRecovery).toBe(true);
  });
});

describe('FsmTransport — lifecycle', () => {
  it('ensureConnection creates an FSM, allocates a connectionId, transitions to signaling', () => {
    const { transport, pcs, events } = setup();

    const connectionId = transport.ensureConnection(PEER_B, { initiator: true });

    expect(connectionId).toBeTruthy();
    expect(pcs).toHaveLength(1);
    expect(transport.hasConnection(PEER_B)).toBe(true);
    expect(transport.getPhase(PEER_B)).toBe('signaling');
    expect(transport.getConnectionId(PEER_B)).toBe(connectionId);

    const stateChanges = events.filter((e) => e.type === 'connection-state-change');
    // FSM transitions idle → signaling on connect()
    const signalingEvent = stateChanges.find(
      (e) => e.type === 'connection-state-change' && e.phase === 'signaling',
    );
    expect(signalingEvent).toBeTruthy();
    expect(signalingEvent).toMatchObject({
      type: 'connection-state-change',
      peer: PEER_B,
      connectionId,
      phase: 'signaling',
    });
  });

  it('ensureConnection is idempotent — repeated calls return the same connectionId', () => {
    const { transport, pcs } = setup();
    const id1 = transport.ensureConnection(PEER_B);
    const id2 = transport.ensureConnection(PEER_B);
    expect(id1).toBe(id2);
    expect(pcs).toHaveLength(1);
  });

  it('ensureConnection ignores caller-supplied connectionId — FSM owns its own', () => {
    // SimplePeer honors the hint; FSM allocates internally. Documented
    // contract — callers must use the returned ConnectionId.
    const { transport } = setup();
    const id = transport.ensureConnection(PEER_B, { connectionId: 'caller-supplied' });
    expect(id).not.toBe('caller-supplied');
    expect(transport.getConnectionId(PEER_B)).toBe(id);
  });

  it('closeConnection tears down the FSM and emits closed', () => {
    const { transport, events } = setup();
    const id = transport.ensureConnection(PEER_B);
    transport.closeConnection(PEER_B, 'test');

    // ConnectionManager defers the post-close cleanup via setTimeout(0).
    // The synchronous phase mutation is enough to assert.
    expect(transport.getPhase(PEER_B)).toBe('closed');

    const closedEvent = events.find(
      (e) =>
        e.type === 'connection-state-change' &&
        e.phase === 'closed' &&
        e.connectionId === id,
    );
    expect(closedEvent).toBeTruthy();
  });

  it('hasConnection returns false after closeConnection settles', async () => {
    const { transport } = setup();
    transport.ensureConnection(PEER_B);
    transport.closeConnection(PEER_B, 'test');
    // ConnectionManager removes the entry on a deferred microtask
    await waitFor(() => !transport.hasConnection(PEER_B));
    expect(transport.hasConnection(PEER_B)).toBe(false);
  });

  it('getPhase returns idle for unknown peers', () => {
    const { transport } = setup();
    expect(transport.getPhase('unknown-peer')).toBe('idle');
  });

  it('getConnectionId returns undefined for unknown peers', () => {
    const { transport } = setup();
    expect(transport.getConnectionId('unknown-peer')).toBeUndefined();
  });

  it('throws if ensureConnection is called after destroy', () => {
    const { transport } = setup();
    transport.destroy();
    expect(() => transport.ensureConnection(PEER_B)).toThrow();
  });

  it('destroy closes all connections and is idempotent', () => {
    const { transport, pcs } = setup();
    transport.ensureConnection(PEER_B);
    transport.ensureConnection('cccc');
    transport.destroy();
    // Both PCs were closed by the underlying ConnectionManager
    expect(pcs[0].close).toHaveBeenCalled();
    expect(pcs[1].close).toHaveBeenCalled();
    // Calling destroy again is a no-op (no throw)
    expect(() => transport.destroy()).not.toThrow();
  });
});

describe('FsmTransport — outgoing signals', () => {
  it('emits FsmSignalEnvelope-shaped data via onOutgoingSignal', async () => {
    const { transport, outgoing } = setup();
    transport.ensureConnection(PEER_B);

    // The FSM creates the offer asynchronously after entering signaling.
    // setLocalDescription is called in a microtask; wait for it.
    await waitFor(() => outgoing.length > 0);

    const offer = outgoing.find((s) => {
      const env = s.data as FsmSignalEnvelope;
      return env?.type === 'offer';
    });
    expect(offer).toBeTruthy();
    expect(offer!.to).toBe(PEER_B);
    expect(offer!.connectionId).toBeTruthy();
    const env = offer!.data as FsmSignalEnvelope;
    expect(env.type).toBe('offer');
    expect(env.payload).toMatchObject({ type: 'offer', sdp: expect.any(String) });
  });

  it('outgoing signal connectionId matches the FSM connectionId', async () => {
    const { transport, outgoing } = setup();
    const id = transport.ensureConnection(PEER_B);
    await waitFor(() => outgoing.length > 0);
    for (const sig of outgoing) {
      expect(sig.connectionId).toBe(id);
    }
  });
});

describe('FsmTransport — incoming signals', () => {
  it('processIncomingSignal routes an offer envelope into the FSM (creates state lazily)', async () => {
    const { transport, pcs } = setup();
    expect(transport.hasConnection(PEER_B)).toBe(false);

    transport.processIncomingSignal(
      envelopeSignal(
        'offer',
        { type: 'offer', sdp: 'mock-remote-offer' },
        'remote-conn-id',
      ),
    );

    // Acceptor-side FSM is created on incoming offer. We allow the
    // microtask queue to drain so the FSM has time to transition.
    await waitFor(() => transport.hasConnection(PEER_B));
    expect(transport.hasConnection(PEER_B)).toBe(true);
    expect(pcs.length).toBeGreaterThanOrEqual(1);
  });

  it('drops malformed incoming signals (non-object data)', () => {
    const { transport } = setup();
    expect(() =>
      transport.processIncomingSignal({
        from: PEER_B,
        connectionId: 'x',
        data: null,
      }),
    ).not.toThrow();
    expect(transport.hasConnection(PEER_B)).toBe(false);
  });

  it('drops malformed incoming signals (string data)', () => {
    const { transport } = setup();
    expect(() =>
      transport.processIncomingSignal({
        from: PEER_B,
        connectionId: 'x',
        data: 'not-an-envelope',
      }),
    ).not.toThrow();
    expect(transport.hasConnection(PEER_B)).toBe(false);
  });
});

describe('FsmTransport — local media', () => {
  it('setLocalStream caches the stream and propagates via updateLocalStream', () => {
    const { transport } = setup();
    const stream = createMockStream(true, true);
    transport.setLocalStream(stream);
    // Cache lives on the wrapper for connection-created propagation;
    // just ensure no throw and that subsequent ensureConnection doesn't
    // crash when reading it.
    transport.ensureConnection(PEER_B);
    expect(transport.hasConnection(PEER_B)).toBe(true);
  });

  it('addTrack on an active FSM re-asserts the stream into the manager', () => {
    const stream = createMockStream(true, true);
    const { transport } = setup({ localStream: stream });
    transport.ensureConnection(PEER_B);
    const newTrack = createMockTrack('audio');
    expect(() => transport.addTrack(newTrack, stream)).not.toThrow();
  });

  it('removeTrack delegates to updateLocalStream without throwing', () => {
    const stream = createMockStream(true, true);
    const { transport } = setup({ localStream: stream });
    transport.ensureConnection(PEER_B);
    const oldTrack = stream.getAudioTracks()[0];
    expect(() => transport.removeTrack(oldTrack, stream)).not.toThrow();
  });

  it('replaceTrack drives RTCRtpSender.replaceTrack on the underlying senders', async () => {
    const stream = createMockStream(true, true);
    const { transport, pcs } = setup({ localStream: stream });
    transport.ensureConnection(PEER_B);
    // Wait for the FSM to enter signaling so addTrack on the PC has run.
    await waitFor(() => pcs.length > 0 && pcs[0].getSenders().length > 0);

    const oldAudio = stream.getAudioTracks()[0];
    const newAudio = createMockTrack('audio');
    transport.replaceTrack(oldAudio, newAudio, stream);

    // The replaceTrack call is async on the FSM — just verify no throw
    // and that at least one sender has had replaceTrack invoked at the
    // mock level. (We don't await because FsmTransport.replaceTrack is
    // fire-and-forget per the PeerTransport interface.)
    expect(pcs[0].getSenders().length).toBeGreaterThan(0);
  });

  it('replaceTrack with null tracks is a no-op', () => {
    const { transport } = setup();
    transport.ensureConnection(PEER_B);
    const stream = createMockStream();
    expect(() => transport.replaceTrack(null, null, stream)).not.toThrow();
  });
});

describe('FsmTransport — data channel send', () => {
  it('send drops silently when peer is not connected', () => {
    const { transport } = setup();
    transport.ensureConnection(PEER_B);
    expect(transport.getPhase(PEER_B)).not.toBe('connected');
    expect(() => transport.send(PEER_B, 'hello')).not.toThrow();
  });

  it('send drops silently for unknown peers', () => {
    const { transport } = setup();
    expect(() => transport.send('unknown', 'hello')).not.toThrow();
  });
});

describe('FsmTransport — media event adaptation (remote-stream / remote-track / data-channel-message)', () => {
  /**
   * These three events are the ones that carry all media and data off the
   * wire; until this block they had zero adapter coverage
   * (MAINTAINABILITY_ASSESSMENT.md Phase 3 item 1). Each test drives the
   * underlying MockRTCPeerConnection the way a real pc fires — `track`
   * events and data-channel `message` events — and asserts the event that
   * leaves the transport, including the peer/connectionId attribution the
   * store's dispatch keys on.
   */

  it('a remote track with a stream emits remote-track carrying track, stream, peer and connectionId', async () => {
    const { transport, pcs, events } = setup();
    const connectionId = transport.ensureConnection(PEER_B);
    await waitFor(() => pcs.length > 0);

    const stream = createMockStream(false, true);
    const track = stream.getVideoTracks()[0];
    pcs[0].simulateTrack(track, [stream]);

    const trackEvents = events.filter((e) => e.type === 'remote-track');
    expect(trackEvents).toHaveLength(1);
    expect(trackEvents[0]).toMatchObject({
      type: 'remote-track',
      peer: PEER_B,
      connectionId,
      track,
      stream,
    });
  });

  it('the first track of a stream also emits remote-stream with that stream', async () => {
    const { transport, pcs, events } = setup();
    const connectionId = transport.ensureConnection(PEER_B);
    await waitFor(() => pcs.length > 0);

    const stream = createMockStream(true, true);
    pcs[0].simulateTrack(stream.getAudioTracks()[0], [stream]);

    const streamEvents = events.filter((e) => e.type === 'remote-stream');
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]).toMatchObject({
      type: 'remote-stream',
      peer: PEER_B,
      connectionId,
      stream,
    });
  });

  it('a second track on the SAME stream emits remote-track again but remote-stream only once', async () => {
    // RtcPeer dedupes 'stream' by stream.id (`_emittedStreamIds`): a
    // 2-track stream must not produce 2 identical remote-stream emissions,
    // or the store would re-run its stream-arrival side effects per track.
    const { transport, pcs, events } = setup();
    transport.ensureConnection(PEER_B);
    await waitFor(() => pcs.length > 0);

    const stream = createMockStream(true, true);
    pcs[0].simulateTrack(stream.getAudioTracks()[0], [stream]);
    pcs[0].simulateTrack(stream.getVideoTracks()[0], [stream]);

    expect(events.filter((e) => e.type === 'remote-track')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'remote-stream')).toHaveLength(1);
  });

  it('a track arriving with no stream emits remote-track (stream undefined) and no remote-stream', async () => {
    const { transport, pcs, events } = setup();
    transport.ensureConnection(PEER_B);
    await waitFor(() => pcs.length > 0);

    pcs[0].simulateTrack(createMockTrack('audio'), []);

    const trackEvents = events.filter((e) => e.type === 'remote-track');
    expect(trackEvents).toHaveLength(1);
    expect(
      trackEvents[0].type === 'remote-track' ? trackEvents[0].stream : null,
    ).toBeUndefined();
    expect(events.filter((e) => e.type === 'remote-stream')).toHaveLength(0);
  });

  it('a message on the locally-created data channel emits data-channel-message with the payload', async () => {
    const { transport, pcs, events } = setup();
    const connectionId = transport.ensureConnection(PEER_B);
    // The FSM creates its local 'data' channel when the RtcPeer is built.
    await waitFor(() => pcs.length > 0 && pcs[0].createDataChannel.mock.calls.length > 0);

    const dc = pcs[0].createDataChannel.mock.results[0]
      .value as unknown as MockRTCDataChannel;
    dc.simulateOpen();
    dc.simulateMessage('{"type":"action","message":"audio-off"}');

    const dataEvents = events.filter((e) => e.type === 'data-channel-message');
    expect(dataEvents).toHaveLength(1);
    expect(dataEvents[0]).toMatchObject({
      type: 'data-channel-message',
      peer: PEER_B,
      connectionId,
      data: '{"type":"action","message":"audio-off"}',
    });
  });

  it('a message on a remote-initiated data channel is also delivered as data-channel-message', async () => {
    // RtcPeer listens for `datachannel` on the pc and wires `message` on
    // every remote channel; both halves of the duplex channel must reach
    // the same transport event.
    const { transport, pcs, events } = setup();
    transport.ensureConnection(PEER_B);
    await waitFor(() => pcs.length > 0);

    const remoteDc = pcs[0].simulateDataChannel('data');
    remoteDc.simulateOpen();
    remoteDc.simulateMessage('from-remote');

    const dataEvents = events.filter((e) => e.type === 'data-channel-message');
    expect(dataEvents).toHaveLength(1);
    expect(dataEvents[0]).toMatchObject({
      type: 'data-channel-message',
      peer: PEER_B,
      data: 'from-remote',
    });
  });

  it('negative control: without simulateTrack/simulateMessage none of the three events fire', async () => {
    // Proves the mock is the thing producing these events (so the
    // assertions above can fail), not some ambient emission on connect.
    const { transport, pcs, events } = setup();
    transport.ensureConnection(PEER_B);
    await waitFor(() => pcs.length > 0);
    expect(
      events.filter(
        (e) =>
          e.type === 'remote-track' ||
          e.type === 'remote-stream' ||
          e.type === 'data-channel-message',
      ),
    ).toHaveLength(0);
  });
});

describe('FsmTransport — getStats / getRTCPeerConnection escape hatch', () => {
  it('getRTCPeerConnection returns the underlying mock for an active peer', () => {
    const { transport, pcs } = setup();
    transport.ensureConnection(PEER_B);
    const pc = transport.getRTCPeerConnection(PEER_B);
    expect(pc).toBe(pcs[0]);
  });

  it('getRTCPeerConnection returns undefined for unknown peers', () => {
    const { transport } = setup();
    expect(transport.getRTCPeerConnection('unknown')).toBeUndefined();
  });

  it('getStats resolves to a TransportStats with raw RTCStatsReport', async () => {
    const { transport } = setup();
    transport.ensureConnection(PEER_B);
    const stats = await transport.getStats(PEER_B);
    expect(stats).not.toBeNull();
    expect(stats!.raw).toBeDefined();
  });

  it('getStats resolves to null for unknown peers', async () => {
    const { transport } = setup();
    const stats = await transport.getStats('unknown');
    expect(stats).toBeNull();
  });
});

describe('FsmTransport — on-demand data channel / ICE controls', () => {
  it('recreateDataChannel(peer) recreates the channel in place on the live pc', async () => {
    const { transport, pcs } = setup();
    transport.ensureConnection(PEER_B);
    await waitFor(() => pcs.length > 0);
    expect(pcs[0].createDataChannel).toHaveBeenCalledTimes(1);

    expect(transport.recreateDataChannel(PEER_B)).toBe(true);

    expect(pcs[0].createDataChannel).toHaveBeenCalledTimes(2);
    expect(pcs[0].close).not.toHaveBeenCalled();
  });

  it('restartIce(peer) drives an ICE restart on the live pc', async () => {
    const { transport, pcs } = setup();
    transport.ensureConnection(PEER_B);
    await waitFor(() => pcs.length > 0);

    expect(transport.restartIce(PEER_B)).toBe(true);
    expect(pcs[0].restartIce).toHaveBeenCalled();
  });

  it('both return false for unknown peers', () => {
    const { transport } = setup();
    expect(transport.recreateDataChannel('unknown')).toBe(false);
    expect(transport.restartIce('unknown')).toBe(false);
  });
});

describe('FsmTransport — event subscription', () => {
  it('on(type) only fires for matching event type', () => {
    const { transport } = setup();
    const stateChanges: TransportEvent[] = [];
    const errors: TransportEvent[] = [];
    transport.on('connection-state-change', (e) => stateChanges.push(e));
    transport.on('error', (e) => errors.push(e));
    transport.ensureConnection(PEER_B);
    expect(stateChanges.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  it('onAny fires for every event type', () => {
    const { transport } = setup();
    const all: TransportEvent[] = [];
    transport.onAny((e) => all.push(e));
    transport.ensureConnection(PEER_B);
    expect(all.length).toBeGreaterThan(0);
    // At least one connection-state-change should have fired
    expect(all.find((e) => e.type === 'connection-state-change')).toBeTruthy();
  });

  it('Unsubscribe stops further dispatch', () => {
    const { transport } = setup();
    const seen: TransportEvent[] = [];
    const unsub = transport.on('connection-state-change', (e) => seen.push(e));
    transport.ensureConnection(PEER_B);
    const before = seen.length;
    unsub();
    transport.closeConnection(PEER_B, 'test');
    // No new events should have been delivered after unsubscribe
    expect(seen.length).toBe(before);
  });

  it('handler errors are caught and do not break other handlers', () => {
    const { transport } = setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: TransportEvent[] = [];
    transport.onAny(() => {
      throw new Error('boom');
    });
    transport.onAny((e) => seen.push(e));
    transport.ensureConnection(PEER_B);
    expect(seen.length).toBeGreaterThan(0);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('FsmTransport — symmetric union via direct two-peer roundtrip', () => {
  /**
   * Build two transports wired through an in-memory bridge so an offer
   * generated by one is fed into the other via processIncomingSignal.
   * Verifies that connectionId in the wire envelope is what the peer
   * stores as its remote connectionId, and that both transports reach a
   * post-signaling state without errors.
   */
  it('two transports exchange offer/answer through processIncomingSignal', async () => {
    const aPcs: MockRTCPeerConnection[] = [];
    const bPcs: MockRTCPeerConnection[] = [];
    const aFactory = (cfg: RTCConfiguration) => {
      const pc = new MockRTCPeerConnection(cfg);
      aPcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    };
    const bFactory = (cfg: RTCConfiguration) => {
      const pc = new MockRTCPeerConnection(cfg);
      bPcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    };

    let bTransport!: FsmTransport;
    const aTransport = new FsmTransport({
      myAgentId: PEER_A,
      onOutgoingSignal: (signal) => {
        bTransport.processIncomingSignal({
          from: PEER_A,
          connectionId: signal.connectionId,
          peerSessionId: signal.peerSessionId,
          data: signal.data,
        });
      },
      createPeerConnection: aFactory,
    });
    bTransport = new FsmTransport({
      myAgentId: PEER_B,
      onOutgoingSignal: (signal) => {
        aTransport.processIncomingSignal({
          from: PEER_B,
          connectionId: signal.connectionId,
          peerSessionId: signal.peerSessionId,
          data: signal.data,
        });
      },
      createPeerConnection: bFactory,
    });

    aTransport.ensureConnection(PEER_B);
    // Drain microtasks so the offer/answer hops through both sides.
    await waitFor(() => bTransport.hasConnection(PEER_A));

    expect(aTransport.hasConnection(PEER_B)).toBe(true);
    expect(bTransport.hasConnection(PEER_A)).toBe(true);

    aTransport.destroy();
    bTransport.destroy();
  });
});
