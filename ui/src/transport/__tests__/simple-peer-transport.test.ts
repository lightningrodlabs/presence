import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimplePeerTransport } from '../simplepeer/simple-peer-transport';
import type { OutgoingSignal, TransportEvent } from '../types';
import {
  MockSimplePeer,
  createFakeStream,
  createFakeTrack,
  createMockFactory,
  FakeSignalingChannel,
} from './test-helpers';

const PEER_A = 'aaaa';
const PEER_B = 'bbbb';

function setup() {
  const { factory, peers } = createMockFactory();
  const outgoing: OutgoingSignal[] = [];
  const events: TransportEvent[] = [];

  const transport = new SimplePeerTransport({
    myAgentId: PEER_A,
    onOutgoingSignal: (signal) => outgoing.push(signal),
    createPeer: factory,
  });
  transport.onAny((e) => events.push(e));
  return { transport, peers, outgoing, events };
}

describe('SimplePeerTransport — lifecycle', () => {
  it('ensureConnection creates a SimplePeer and emits idle → signaling', () => {
    const { transport, peers, events } = setup();

    const connectionId = transport.ensureConnection(PEER_B, { initiator: true });

    expect(peers).toHaveLength(1);
    expect(peers[0].options.initiator).toBe(true);
    expect(transport.hasConnection(PEER_B)).toBe(true);
    expect(transport.getPhase(PEER_B)).toBe('signaling');
    expect(transport.getConnectionId(PEER_B)).toBe(connectionId);

    const stateChanges = events.filter((e) => e.type === 'connection-state-change');
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toMatchObject({
      type: 'connection-state-change',
      peer: PEER_B,
      connectionId,
      phase: 'signaling',
      previous: 'idle',
    });
  });

  it('ensureConnection is idempotent for the same connectionId', () => {
    const { transport, peers } = setup();
    const id1 = transport.ensureConnection(PEER_B, { connectionId: 'fixed' });
    const id2 = transport.ensureConnection(PEER_B, { connectionId: 'fixed' });
    expect(id1).toBe('fixed');
    expect(id2).toBe('fixed');
    expect(peers).toHaveLength(1);
  });

  it('ensureConnection without explicit connectionId returns existing one if active', () => {
    const { transport, peers } = setup();
    const id1 = transport.ensureConnection(PEER_B);
    const id2 = transport.ensureConnection(PEER_B);
    expect(id1).toBe(id2);
    expect(peers).toHaveLength(1);
  });

  it('ensureConnection with a different connectionId destroys old and creates new', () => {
    const { transport, peers, events } = setup();
    const id1 = transport.ensureConnection(PEER_B, { connectionId: 'old' });
    const id2 = transport.ensureConnection(PEER_B, { connectionId: 'new' });

    expect(id1).toBe('old');
    expect(id2).toBe('new');
    expect(peers).toHaveLength(2);
    expect(peers[0].destroyed).toBe(true);
    expect(transport.getConnectionId(PEER_B)).toBe('new');
    expect(transport.getPhase(PEER_B)).toBe('signaling');

    // Should see: signaling(old), closed(old), signaling(new). The old peer's
    // destroy() also fires a close event from MockSimplePeer.emit('close'),
    // so 'closed' may appear twice — we just check both ids saw their phases.
    const closedForOld = events.filter(
      (e) => e.type === 'connection-state-change' && e.connectionId === 'old' && e.phase === 'closed'
    );
    expect(closedForOld.length).toBeGreaterThanOrEqual(1);
    const signalingForNew = events.filter(
      (e) =>
        e.type === 'connection-state-change' &&
        e.connectionId === 'new' &&
        e.phase === 'signaling'
    );
    expect(signalingForNew).toHaveLength(1);
  });

  it('closeConnection destroys peer and emits closed', () => {
    const { transport, peers, events } = setup();
    const id = transport.ensureConnection(PEER_B);
    transport.closeConnection(PEER_B, 'test');

    expect(peers[0].destroyed).toBe(true);
    expect(transport.hasConnection(PEER_B)).toBe(false);
    expect(transport.getPhase(PEER_B)).toBe('idle');

    const closedEvents = events.filter(
      (e) => e.type === 'connection-state-change' && e.phase === 'closed' && e.connectionId === id
    );
    expect(closedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('peer.connect transitions phase to connected', () => {
    const { transport, peers, events } = setup();
    const id = transport.ensureConnection(PEER_B);
    peers[0].emit('connect');

    expect(transport.getPhase(PEER_B)).toBe('connected');
    const connected = events.find(
      (e) => e.type === 'connection-state-change' && e.phase === 'connected' && e.connectionId === id
    );
    expect(connected).toBeDefined();
  });

  it('peer.error emits error event', () => {
    const { transport, peers, events } = setup();
    const id = transport.ensureConnection(PEER_B);
    const err = new Error('ICE failed');
    peers[0].emit('error', err);

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: 'error',
      peer: PEER_B,
      connectionId: id,
      error: err,
    });
  });
});

describe('SimplePeerTransport — signaling', () => {
  it('outgoing peer.signal becomes onOutgoingSignal call', () => {
    const { transport, peers, outgoing } = setup();
    const id = transport.ensureConnection(PEER_B);
    const sdp = { type: 'offer', sdp: 'v=0...' };
    peers[0].emit('signal', sdp);

    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).toEqual({ to: PEER_B, connectionId: id, data: sdp });
  });

  it('processIncomingSignal forwards data to peer.signal', () => {
    const { transport, peers } = setup();
    const id = transport.ensureConnection(PEER_B);
    const incoming = { type: 'answer', sdp: 'v=0...' };
    transport.processIncomingSignal({ from: PEER_B, connectionId: id, data: incoming });

    expect(peers[0].signaledIn).toEqual([incoming]);
  });

  it('processIncomingSignal drops on connectionId mismatch', () => {
    const { transport, peers } = setup();
    transport.ensureConnection(PEER_B, { connectionId: 'current' });
    transport.processIncomingSignal({
      from: PEER_B,
      connectionId: 'stale',
      data: { type: 'answer' },
    });

    expect(peers[0].signaledIn).toHaveLength(0);
  });

  it('processIncomingSignal drops when no connection exists', () => {
    const { transport } = setup();
    expect(() =>
      transport.processIncomingSignal({
        from: PEER_B,
        connectionId: 'whatever',
        data: { type: 'offer' },
      })
    ).not.toThrow();
  });

  it('peer.signal after close does not emit outgoing', () => {
    const { transport, peers, outgoing } = setup();
    transport.ensureConnection(PEER_B);
    transport.closeConnection(PEER_B);
    peers[0].emit('signal', { type: 'offer' });
    expect(outgoing).toHaveLength(0);
  });
});

describe('SimplePeerTransport — local media', () => {
  it('setLocalStream + ensureConnection auto-attaches stream to new peer', () => {
    const { transport, peers } = setup();
    const stream = createFakeStream();
    transport.setLocalStream(stream);
    transport.ensureConnection(PEER_B);

    expect(peers[0].addedStreams).toEqual([stream]);
  });

  it('ensureConnection without setLocalStream does not addStream', () => {
    const { transport, peers } = setup();
    transport.ensureConnection(PEER_B);
    expect(peers[0].addedStreams).toHaveLength(0);
  });

  it('addTrack propagates to all active connections', () => {
    const { transport, peers } = setup();
    transport.ensureConnection(PEER_B);
    transport.ensureConnection('cccc');

    const stream = createFakeStream();
    const track = createFakeTrack('audio');
    transport.addTrack(track, stream);

    expect(peers[0].addedTracks).toEqual([{ track, stream }]);
    expect(peers[1].addedTracks).toEqual([{ track, stream }]);
  });

  it('removeTrack propagates to all active connections', () => {
    const { transport, peers } = setup();
    transport.ensureConnection(PEER_B);

    const stream = createFakeStream();
    const track = createFakeTrack('video');
    transport.removeTrack(track, stream);

    expect(peers[0].removedTracks).toEqual([{ track, stream }]);
  });

  it('replaceTrack propagates with old/new', () => {
    const { transport, peers } = setup();
    transport.ensureConnection(PEER_B);

    const stream = createFakeStream();
    const oldTrack = createFakeTrack('audio', 'old');
    const newTrack = createFakeTrack('audio', 'new');
    transport.replaceTrack(oldTrack, newTrack, stream);

    expect(peers[0].replacedTracks).toEqual([{ oldTrack, newTrack, stream }]);
  });

  it('addTrack skips terminal-phase connections', () => {
    const { transport, peers } = setup();
    transport.ensureConnection(PEER_B);
    transport.closeConnection(PEER_B);

    const track = createFakeTrack('audio');
    const stream = createFakeStream();
    transport.addTrack(track, stream);

    expect(peers[0].addedTracks).toHaveLength(0);
  });
});

describe('SimplePeerTransport — data channel & events', () => {
  it('send drops silently when not connected', () => {
    const { transport, peers } = setup();
    transport.ensureConnection(PEER_B);
    // Phase is 'signaling' — not 'connected'
    transport.send(PEER_B, 'hello');
    expect(peers[0].sentDataChannelMessages).toHaveLength(0);
  });

  it('send forwards when connected', () => {
    const { transport, peers } = setup();
    transport.ensureConnection(PEER_B);
    peers[0].emit('connect');
    transport.send(PEER_B, 'hello');
    expect(peers[0].sentDataChannelMessages).toEqual(['hello']);
  });

  it('send drops silently with no connection at all', () => {
    const { transport } = setup();
    expect(() => transport.send(PEER_B, 'hello')).not.toThrow();
  });

  it('peer data event becomes data-channel-message event', () => {
    const { transport, peers, events } = setup();
    const id = transport.ensureConnection(PEER_B);
    peers[0].emit('connect');
    peers[0].emit('data', 'incoming');

    const dataEvents = events.filter((e) => e.type === 'data-channel-message');
    expect(dataEvents).toHaveLength(1);
    expect(dataEvents[0]).toMatchObject({
      type: 'data-channel-message',
      peer: PEER_B,
      connectionId: id,
      data: 'incoming',
    });
  });

  it('peer stream/track events fire transport remote-stream/remote-track', () => {
    const { transport, peers, events } = setup();
    transport.ensureConnection(PEER_B);
    const stream = createFakeStream();
    const track = createFakeTrack('video');

    peers[0].emit('stream', stream);
    peers[0].emit('track', track, stream);

    expect(events.find((e) => e.type === 'remote-stream')).toMatchObject({
      type: 'remote-stream',
      peer: PEER_B,
      stream,
    });
    expect(events.find((e) => e.type === 'remote-track')).toMatchObject({
      type: 'remote-track',
      peer: PEER_B,
      track,
      stream,
    });
  });

  it('typed on() subscriber only receives events of its type', () => {
    const { transport, peers } = setup();
    const sigChanges: TransportEvent[] = [];
    const dataMessages: TransportEvent[] = [];
    transport.on('connection-state-change', (e) => sigChanges.push(e));
    transport.on('data-channel-message', (e) => dataMessages.push(e));

    transport.ensureConnection(PEER_B);
    peers[0].emit('connect');
    peers[0].emit('data', 'hi');

    expect(sigChanges.map((e) => (e as any).phase)).toEqual(['signaling', 'connected']);
    expect(dataMessages).toHaveLength(1);
  });

  it('unsubscribe stops further events', () => {
    const { transport, peers } = setup();
    const seen: TransportEvent[] = [];
    const unsub = transport.on('connection-state-change', (e) => seen.push(e));
    transport.ensureConnection(PEER_B);
    expect(seen).toHaveLength(1);

    unsub();
    peers[0].emit('connect');
    expect(seen).toHaveLength(1);
  });

  it('destroy closes all connections and clears handlers', () => {
    const { transport, peers, events } = setup();
    transport.ensureConnection(PEER_B);
    transport.ensureConnection('cccc');
    expect(peers).toHaveLength(2);

    transport.destroy();
    expect(peers[0].destroyed).toBe(true);
    expect(peers[1].destroyed).toBe(true);
    expect(transport.hasConnection(PEER_B)).toBe(false);

    // Subsequent operations are no-ops (but don't throw); ensureConnection should throw.
    expect(() => transport.ensureConnection(PEER_B)).toThrow();
    void events;
  });
});

describe('SimplePeerTransport — ICE restart on disconnected', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function setupForIce() {
    return setup();
  }

  it('calls pc.restartIce() after the disconnected grace expires', () => {
    const { transport, peers } = setupForIce();
    transport.ensureConnection(PEER_B);
    const pc = peers[0]._pc;

    // Simulate a healthy connect, then a disconnected flap.
    pc.setIceConnectionState('connected');
    pc.setIceConnectionState('disconnected');

    // Within the grace window, no restart yet.
    vi.advanceTimersByTime(4999);
    expect(pc.restartIceCalls).toBe(0);

    // After the grace expires, restartIce fires.
    vi.advanceTimersByTime(2);
    expect(pc.restartIceCalls).toBe(1);
  });

  it('cancels the restart attempt if ICE recovers within the grace window', () => {
    const { transport, peers } = setupForIce();
    transport.ensureConnection(PEER_B);
    const pc = peers[0]._pc;

    pc.setIceConnectionState('connected');
    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(2000);
    pc.setIceConnectionState('connected');

    // Run out the rest of the grace window — no restart should fire.
    vi.advanceTimersByTime(10_000);
    expect(pc.restartIceCalls).toBe(0);
  });

  it('coalesces back-to-back disconnected events into a single restart', () => {
    const { transport, peers } = setupForIce();
    transport.ensureConnection(PEER_B);
    const pc = peers[0]._pc;

    pc.setIceConnectionState('connected');
    pc.setIceConnectionState('disconnected');
    pc.setIceConnectionState('disconnected');
    pc.setIceConnectionState('disconnected');

    vi.advanceTimersByTime(6000);
    expect(pc.restartIceCalls).toBe(1);
  });

  it('caps in-place restarts at ICE_RESTART_MAX_ATTEMPTS', () => {
    const { transport, peers } = setupForIce();
    transport.ensureConnection(PEER_B);
    const pc = peers[0]._pc;

    // Simulate three full disconnect-then-connect-then-disconnect cycles
    // WITHOUT a successful 'connected' transition between them — the
    // counter resets only on connected/completed.
    pc.setIceConnectionState('connected'); // reset baseline
    for (let i = 0; i < 5; i++) {
      pc.setIceConnectionState('disconnected');
      vi.advanceTimersByTime(6000);
      // back to checking (e.g. restart in progress) — no reset
      pc.setIceConnectionState('checking');
    }

    expect(pc.restartIceCalls).toBe(3);
  });

  it('resets the restart budget after a successful reconnection', () => {
    const { transport, peers } = setupForIce();
    transport.ensureConnection(PEER_B);
    const pc = peers[0]._pc;

    pc.setIceConnectionState('connected');

    // First flap — uses 1 restart.
    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(6000);
    expect(pc.restartIceCalls).toBe(1);

    // ICE recovers (real or via the restart) — budget should reset.
    pc.setIceConnectionState('connected');

    // Three more flaps after recovery — all three restarts allowed.
    for (let i = 0; i < 5; i++) {
      pc.setIceConnectionState('disconnected');
      vi.advanceTimersByTime(6000);
      pc.setIceConnectionState('checking');
    }

    expect(pc.restartIceCalls).toBe(1 + 3);
  });

  it('skips restart when signalingState is not stable', () => {
    const { transport, peers } = setupForIce();
    transport.ensureConnection(PEER_B);
    const pc = peers[0]._pc;

    pc.setIceConnectionState('connected');
    pc.signalingState = 'have-local-offer';
    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(6000);

    expect(pc.restartIceCalls).toBe(0);
  });

  it('detaches the listener after the peer is closed', () => {
    const { transport, peers } = setupForIce();
    transport.ensureConnection(PEER_B);
    const pc = peers[0]._pc;

    pc.setIceConnectionState('connected');
    transport.closeConnection(PEER_B, 'test');

    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(10_000);

    expect(pc.restartIceCalls).toBe(0);
  });
});

describe('SimplePeerTransport — two transports via FakeSignalingChannel', () => {
  it('signals exchanged between two transports route to the right peer', async () => {
    const channel = new FakeSignalingChannel();
    const fA = createMockFactory();
    const fB = createMockFactory();

    const tA = new SimplePeerTransport({
      myAgentId: PEER_A,
      onOutgoingSignal: channel.attachSender(PEER_A),
      createPeer: fA.factory,
    });
    const tB = new SimplePeerTransport({
      myAgentId: PEER_B,
      onOutgoingSignal: channel.attachSender(PEER_B),
      createPeer: fB.factory,
    });
    channel.attachReceiver(PEER_A, (s) => tA.processIncomingSignal(s));
    channel.attachReceiver(PEER_B, (s) => tB.processIncomingSignal(s));

    // A creates a connection with a known id, B creates the matching one.
    tA.ensureConnection(PEER_B, { initiator: true, connectionId: 'pair-1' });
    tB.ensureConnection(PEER_A, { initiator: false, connectionId: 'pair-1' });

    // A's mock peer fires 'signal' (simulated SDP offer).
    const offer = { type: 'offer', sdp: 'A-offer' };
    fA.peers[0].emit('signal', offer);

    await new Promise<void>((r) => queueMicrotask(r));

    // B's mock peer should have received the signal via processIncomingSignal.
    expect(fB.peers[0].signaledIn).toEqual([offer]);

    // B replies with an answer.
    const answer = { type: 'answer', sdp: 'B-answer' };
    fB.peers[0].emit('signal', answer);
    await new Promise<void>((r) => queueMicrotask(r));

    expect(fA.peers[0].signaledIn).toEqual([answer]);
  });
});
