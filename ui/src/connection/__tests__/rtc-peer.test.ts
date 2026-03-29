import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RTCPeer } from '../rtc-peer';
import type { ConnectionConfig } from '../types';
import {
  MockRTCPeerConnection,
  MockRTCDataChannel,
  createMockTrack,
  createMockStream,
} from './test-helpers';

const DEFAULT_CONFIG: ConnectionConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  trickleICE: true,
  connectionTimeoutMs: 15000,
  sdpExchangeTimeoutMs: 15000,
  role: 'mesh',
};

function createPeer(options: {
  polite?: boolean;
  onSignal?: (data: any) => void;
} = {}) {
  const onSignal = options.onSignal ?? vi.fn();
  let mockPc: MockRTCPeerConnection;

  const peer = new RTCPeer({
    polite: options.polite ?? true,
    config: DEFAULT_CONFIG,
    onSignal,
    createPeerConnection: (config: RTCConfiguration) => {
      mockPc = new MockRTCPeerConnection(config);
      return mockPc as unknown as RTCPeerConnection;
    },
  });

  return { peer, get mockPc() { return mockPc!; }, onSignal };
}

describe('RTCPeer', () => {
  describe('construction', () => {
    it('creates an RTCPeerConnection with provided ICE servers', () => {
      const { mockPc } = createPeer();
      expect(mockPc.configuration).toEqual({
        iceServers: DEFAULT_CONFIG.iceServers,
      });
    });

    it('creates a data channel labeled "data"', () => {
      const { mockPc } = createPeer();
      expect(mockPc.createDataChannel).toHaveBeenCalledWith('data', { ordered: true });
    });

    it('starts with destroyed = false', () => {
      const { peer } = createPeer();
      expect(peer.destroyed).toBe(false);
    });
  });

  describe('ICE config', () => {
    it('passes STUN-only config', () => {
      const { mockPc } = createPeer();
      expect(mockPc.configuration.iceServers).toEqual([
        { urls: 'stun:stun.l.google.com:19302' },
      ]);
    });

    it('passes STUN+TURN config', () => {
      const config: ConnectionConfig = {
        ...DEFAULT_CONFIG,
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
        ],
      };

      let capturedConfig: RTCConfiguration | undefined;
      new RTCPeer({
        polite: true,
        config,
        onSignal: vi.fn(),
        createPeerConnection: (cfg) => {
          capturedConfig = cfg;
          return new MockRTCPeerConnection(cfg) as unknown as RTCPeerConnection;
        },
      });

      expect(capturedConfig!.iceServers).toHaveLength(2);
      expect(capturedConfig!.iceServers![1]).toEqual({
        urls: 'turn:turn.example.com:3478',
        username: 'user',
        credential: 'pass',
      });
    });
  });

  describe('Perfect Negotiation — offer/answer flow', () => {
    it('creates and sends an offer on negotiationneeded', async () => {
      const onSignal = vi.fn();
      const { mockPc } = createPeer({ onSignal });

      // Trigger negotiationneeded
      mockPc.addTrack(createMockTrack('audio'));
      // Wait for async
      await vi.waitFor(() => expect(onSignal).toHaveBeenCalled());

      expect(mockPc.setLocalDescription).toHaveBeenCalled();
      expect(onSignal).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'offer' }),
      );
    });

    it('handles a remote offer and sends an answer', async () => {
      const onSignal = vi.fn();
      const { peer, mockPc } = createPeer({ polite: true, onSignal });

      await peer.handleSignal({ type: 'offer', sdp: 'remote-offer-sdp' });

      expect(mockPc.setRemoteDescription).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'offer', sdp: 'remote-offer-sdp' }),
      );
      expect(mockPc.setLocalDescription).toHaveBeenCalled();
      // Answer should be sent via onSignal
      expect(onSignal).toHaveBeenCalled();
    });

    it('handles a remote answer', async () => {
      const { peer, mockPc } = createPeer();

      await peer.handleSignal({ type: 'answer', sdp: 'remote-answer-sdp' });

      expect(mockPc.setRemoteDescription).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'answer', sdp: 'remote-answer-sdp' }),
      );
    });
  });

  describe('Perfect Negotiation — glare handling', () => {
    it('impolite peer ignores colliding offer', async () => {
      const onSignal = vi.fn();
      const { peer, mockPc } = createPeer({ polite: false, onSignal });

      // Simulate that we're in the middle of making an offer
      // by having signalingState be have-local-offer
      mockPc.signalingState = 'have-local-offer';

      await peer.handleSignal({ type: 'offer', sdp: 'colliding-offer' });

      // Should NOT have set remote description (ignored the offer)
      expect(mockPc.setRemoteDescription).not.toHaveBeenCalled();
    });

    it('polite peer yields to colliding offer', async () => {
      const onSignal = vi.fn();
      const { peer, mockPc } = createPeer({ polite: true, onSignal });

      // Simulate that we have a local offer
      mockPc.signalingState = 'have-local-offer';

      await peer.handleSignal({ type: 'offer', sdp: 'colliding-offer' });

      // Polite peer should accept the offer (implicit rollback)
      expect(mockPc.setRemoteDescription).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'offer', sdp: 'colliding-offer' }),
      );
      // And send an answer
      expect(mockPc.setLocalDescription).toHaveBeenCalled();
    });
  });

  describe('ICE candidate handling', () => {
    it('forwards local ICE candidates via onSignal', async () => {
      const onSignal = vi.fn();
      const { mockPc } = createPeer({ onSignal });

      const candidate = { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 };
      mockPc.simulateIceCandidate(candidate);

      expect(onSignal).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: 'candidate:123' }),
      );
    });

    it('queues remote ICE candidates until remote description is set', async () => {
      // Use an impolite peer so there's no collision/rollback when we send an answer
      const { peer, mockPc } = createPeer({ polite: false });

      // Send candidate before remote description
      const candidate = { candidate: 'candidate:456', sdpMid: '0', sdpMLineIndex: 0 };
      await peer.handleSignal(candidate);

      // Should NOT have called addIceCandidate yet (no remote description)
      expect(mockPc.addIceCandidate).not.toHaveBeenCalled();

      // Now set remote description with an answer (no collision for impolite peer)
      await peer.handleSignal({ type: 'answer', sdp: 'remote-answer' });

      expect(mockPc.addIceCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: 'candidate:456' }),
      );
    });

    it('clears pending candidates on collision rollback (polite peer)', async () => {
      const { peer, mockPc } = createPeer({ polite: true });

      // Queue a candidate (no remote description yet)
      await peer.handleSignal({ candidate: 'candidate:stale', sdpMid: '0', sdpMLineIndex: 0 });
      expect(mockPc.addIceCandidate).not.toHaveBeenCalled();

      // Receive an offer — polite peer rolls back, clearing stale candidates
      await peer.handleSignal({ type: 'offer', sdp: 'remote-offer' });

      // The stale candidate should NOT have been applied
      expect(mockPc.addIceCandidate).not.toHaveBeenCalledWith(
        expect.objectContaining({ candidate: 'candidate:stale' }),
      );
    });
  });

  describe('track management', () => {
    it('addTrack adds a track to the peer connection', () => {
      const { peer, mockPc } = createPeer();
      const track = createMockTrack('video');
      const stream = createMockStream();

      peer.addTrack(track, stream);

      expect(mockPc.addTrack).toHaveBeenCalledWith(track, stream);
    });

    it('addTrack throws if peer is destroyed', () => {
      const { peer } = createPeer();
      peer.destroy();

      expect(() => peer.addTrack(createMockTrack('audio'), createMockStream()))
        .toThrow('RTCPeer is destroyed');
    });

    it('removeTrack removes a track sender', () => {
      const { peer, mockPc } = createPeer();
      const track = createMockTrack('audio');
      const stream = createMockStream();
      const sender = peer.addTrack(track, stream);

      peer.removeTrack(sender);

      expect(mockPc.removeTrack).toHaveBeenCalledWith(sender);
    });

    it('getSenders returns current senders', () => {
      const { peer, mockPc } = createPeer();
      peer.getSenders();
      expect(mockPc.getSenders).toHaveBeenCalled();
    });
  });

  describe('stats collection', () => {
    it('getStats delegates to RTCPeerConnection', async () => {
      const { peer, mockPc } = createPeer();
      await peer.getStats();
      expect(mockPc.getStats).toHaveBeenCalled();
    });
  });

  describe('ICE restart', () => {
    it('restartIce delegates to RTCPeerConnection', () => {
      const { peer, mockPc } = createPeer();
      peer.restartIce();
      expect(mockPc.restartIce).toHaveBeenCalled();
    });

    it('restartIce is a no-op when destroyed', () => {
      const { peer, mockPc } = createPeer();
      peer.destroy();
      peer.restartIce();
      // restartIce was called once during setup (negotiationneeded fires it indirectly)
      // but not after destroy
      expect(mockPc.restartIce).not.toHaveBeenCalled();
    });
  });

  describe('data channel', () => {
    it('send delivers data when channel is open', () => {
      const { peer, mockPc } = createPeer();

      // Get the data channel that was created
      const dc = mockPc.createDataChannel.mock.results[0]?.value;
      if (dc && dc.simulateOpen) {
        dc.simulateOpen();
      }

      peer.send('hello');

      // Verify send was called on the data channel
      if (dc) {
        expect(dc.send).toHaveBeenCalledWith('hello');
      }
    });

    it('send is silently ignored when destroyed', () => {
      const { peer } = createPeer();
      peer.destroy();
      // Should not throw
      peer.send('hello');
    });
  });

  describe('event forwarding', () => {
    it('emits ice-state-change on ICE connection state change', () => {
      const { peer, mockPc } = createPeer();
      const handler = vi.fn();
      peer.on('ice-state-change', handler);

      mockPc.simulateIceConnectionState('checking');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ice-state-change', data: 'checking' }),
      );
    });

    it('emits connect when connection state becomes connected', () => {
      const { peer, mockPc } = createPeer();
      const handler = vi.fn();
      peer.on('connect', handler);

      mockPc.simulateConnectionState('connected');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'connect' }),
      );
    });

    it('emits close when connection state becomes failed', () => {
      const { peer, mockPc } = createPeer();
      const handler = vi.fn();
      peer.on('close', handler);

      mockPc.simulateConnectionState('failed');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'close', data: 'failed' }),
      );
    });

    it('emits track on remote track', () => {
      const { peer, mockPc } = createPeer();
      const handler = vi.fn();
      peer.on('track', handler);

      const track = createMockTrack('video');
      mockPc.simulateTrack(track);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'track',
          data: expect.objectContaining({ track }),
        }),
      );
    });

    it('does not emit events after destroy', () => {
      const { peer, mockPc } = createPeer();
      const handler = vi.fn();
      peer.on('ice-state-change', handler);

      peer.destroy();
      mockPc.simulateIceConnectionState('failed');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('transport snapshot', () => {
    it('returns current transport states', () => {
      const { peer, mockPc } = createPeer();

      mockPc.simulateIceConnectionState('connected');

      const snapshot = peer.transportSnapshot;
      expect(snapshot.ice).toBe('connected');
      expect(snapshot.signaling).toBe('stable');
      expect(snapshot.gathering).toBe('new');
    });
  });

  describe('destroy', () => {
    it('closes the peer connection', () => {
      const { peer, mockPc } = createPeer();
      peer.destroy();

      expect(mockPc.close).toHaveBeenCalled();
      expect(peer.destroyed).toBe(true);
    });

    it('is idempotent', () => {
      const { peer, mockPc } = createPeer();
      peer.destroy();
      peer.destroy();

      expect(mockPc.close).toHaveBeenCalledTimes(1);
    });

    it('clears event handlers', () => {
      const { peer, mockPc } = createPeer();
      const handler = vi.fn();
      peer.on('connect', handler);

      peer.destroy();
      // Try to trigger event — handler should have been cleared
      mockPc.simulateConnectionState('connected');
      expect(handler).not.toHaveBeenCalled();
    });

    it('handleSignal is a no-op after destroy', async () => {
      const { peer, mockPc } = createPeer();
      peer.destroy();

      await peer.handleSignal({ type: 'offer', sdp: 'test' });
      expect(mockPc.setRemoteDescription).not.toHaveBeenCalled();
    });
  });

  describe('event subscription', () => {
    it('returns an unsubscribe function', () => {
      const { peer, mockPc } = createPeer();
      const handler = vi.fn();
      const unsub = peer.on('ice-state-change', handler);

      mockPc.simulateIceConnectionState('checking');
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();
      mockPc.simulateIceConnectionState('connected');
      expect(handler).toHaveBeenCalledTimes(1); // not called again
    });
  });
});
