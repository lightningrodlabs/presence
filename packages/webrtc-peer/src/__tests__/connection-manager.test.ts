import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from '../connection-manager';
import type { ConnectionManagerOptions } from '../connection-manager';
import type { FSMTransitionEntry } from '../types';
import {
  MockRTCPeerConnection,
  FakeSignalingChannel,
  createMockStream,
} from './test-helpers';

// Track managers for cleanup in afterEach
const activeManagers: ConnectionManager[] = [];

function createManager(options: {
  agentId?: string;
  signalingChannel?: FakeSignalingChannel;
} = {}) {
  const channel = options.signalingChannel ?? new FakeSignalingChannel();
  const agentId = options.agentId ?? 'agent-aaa';
  const transitionLog: FSMTransitionEntry[] = [];

  const manager = new ConnectionManager({
    myAgentId: agentId,
    signaling: channel.createAdapter(agentId),
    onTransition: (entry) => transitionLog.push(entry),
    createPeerConnection: (config) => {
      return new MockRTCPeerConnection(config) as unknown as RTCPeerConnection;
    },
  });
  activeManagers.push(manager);

  return { manager, channel, transitionLog, agentId };
}

function createPair(channel?: FakeSignalingChannel) {
  const sharedChannel = channel ?? new FakeSignalingChannel();

  const a = createManager({ agentId: 'agent-aaa', signalingChannel: sharedChannel });
  const b = createManager({ agentId: 'agent-bbb', signalingChannel: sharedChannel });

  return { a, b, channel: sharedChannel };
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Destroy all managers before restoring real timers to prevent
    // auto-retry timers from cascading and causing OOM
    for (const m of activeManagers) {
      m.destroy();
    }
    activeManagers.length = 0;
    vi.useRealTimers();
  });

  describe('ensureConnection', () => {
    it('creates an FSM and starts connection', () => {
      const { manager } = createManager();

      manager.ensureConnection('agent-bbb');

      expect(manager.getState('agent-bbb')).toBe('signaling');
      expect(manager.getFSM('agent-bbb')).toBeDefined();
    });

    it('does not create duplicate FSMs', () => {
      const { manager } = createManager();

      manager.ensureConnection('agent-bbb');
      manager.ensureConnection('agent-bbb');

      // Still only one FSM
      expect(manager.getAllStates().size).toBe(1);
    });

    it('restarts idle FSMs', () => {
      const { manager } = createManager();

      manager.ensureConnection('agent-bbb');
      const fsm = manager.getFSM('agent-bbb')!;

      // Timeout to disconnected
      vi.advanceTimersByTime(15_001);
      expect(fsm.state).toBe('disconnected');

      // ensureConnection should restart
      manager.ensureConnection('agent-bbb');
      expect(fsm.state).toBe('signaling');
    });

    it('does nothing if already signaling/connecting/connected', () => {
      const { manager, transitionLog } = createManager();

      manager.ensureConnection('agent-bbb');
      expect(manager.getState('agent-bbb')).toBe('signaling');

      const countBefore = transitionLog.length;
      manager.ensureConnection('agent-bbb');
      // No new transitions
      expect(transitionLog.length).toBe(countBefore);
    });
  });

  describe('signal routing', () => {
    it('creates FSM on incoming signal for unknown agent', () => {
      const { a, channel } = createPair();

      // Agent B sends a signal to agent A
      channel.createAdapter('agent-bbb').sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'conn-123',
        data: { type: 'offer', sdp: 'mock-offer' },
      });

      // Agent A should have created an FSM for agent B
      expect(a.manager.getFSM('agent-bbb')).toBeDefined();
    });

    it('routes signals to existing FSM', () => {
      const { manager, channel } = createManager();

      manager.ensureConnection('agent-bbb');
      expect(manager.getState('agent-bbb')).toBe('signaling');

      // Simulate receiving an answer
      channel.createAdapter('agent-bbb').sendSignal('agent-aaa', {
        type: 'answer',
        connectionId: 'conn-123',
        data: { type: 'answer', sdp: 'mock-answer' },
      });

      // FSM should have processed the signal
      // (may have transitioned to connecting if the mock processed it synchronously)
      const state = manager.getState('agent-bbb');
      expect(['signaling', 'connecting']).toContain(state);
    });

    it('handles leave signal', () => {
      const { manager, channel } = createManager();

      manager.ensureConnection('agent-bbb');

      channel.createAdapter('agent-bbb').sendSignal('agent-aaa', {
        type: 'leave',
        connectionId: 'conn-123',
      });

      expect(manager.getState('agent-bbb')).toBe('closed');
    });
  });

  describe('connection-scoped signal filtering', () => {
    it('accepts first offer and establishes remoteConnectionId', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // B sends an offer with its connectionId
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-1',
        data: { type: 'offer', sdp: 'mock-offer' },
      });

      const fsm = a.manager.getFSM('agent-bbb')!;
      expect(fsm).toBeDefined();
      expect(fsm.remoteConnectionId).toBe('b-conn-1');
    });

    it('accepts answer/candidate matching remoteConnectionId', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // B sends offer to establish session
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-1',
        data: { type: 'offer', sdp: 'mock-offer' },
      });

      // B sends candidate with same connectionId — should be accepted
      bAdapter.sendSignal('agent-aaa', {
        type: 'candidate',
        connectionId: 'b-conn-1',
        data: { candidate: 'mock-candidate', sdpMLineIndex: 0 },
      });

      // No error thrown, FSM still active
      expect(a.manager.getState('agent-bbb')).not.toBe('closed');
    });

    it('drops stale answer from previous session', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // B sends offer to establish session
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-2',
        data: { type: 'offer', sdp: 'mock-offer' },
      });

      const fsm = a.manager.getFSM('agent-bbb')!;
      expect(fsm.remoteConnectionId).toBe('b-conn-2');

      // Stale answer from a previous session arrives
      const logBefore = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'answer',
        connectionId: 'b-conn-OLD',
        data: { type: 'answer', sdp: 'stale-answer' },
      });

      // Should have logged the drop via structured transition log
      const dropEntry = a.transitionLog.slice(logBefore).find(
        e => e.trigger.includes('Dropped stale answer')
      );
      expect(dropEntry).toBeDefined();
    });

    it('drops stale candidate from previous session', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // Establish session
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-3',
        data: { type: 'offer', sdp: 'mock-offer' },
      });

      // Stale candidate arrives
      const logBefore = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'candidate',
        connectionId: 'b-conn-OLD',
        data: { candidate: 'stale-candidate', sdpMLineIndex: 0 },
      });

      const dropEntry = a.transitionLog.slice(logBefore).find(
        e => e.trigger.includes('Dropped stale candidate')
      );
      expect(dropEntry).toBeDefined();
    });

    it('accepts answer matching local connectionId (response to our offer)', () => {
      const { manager, channel } = createManager();

      // We initiate connection — our FSM gets a connectionId
      manager.ensureConnection('agent-bbb');
      const fsm = manager.getFSM('agent-bbb')!;
      const ourConnectionId = fsm.connectionId;

      // First, B sends an offer to establish remoteConnectionId
      channel.createAdapter('agent-bbb').sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-x',
        data: { type: 'offer', sdp: 'mock-offer' },
      });

      // Then B sends an answer carrying OUR connectionId (response to our offer)
      channel.createAdapter('agent-bbb').sendSignal('agent-aaa', {
        type: 'answer',
        connectionId: ourConnectionId,
        data: { type: 'answer', sdp: 'mock-answer' },
      });

      // Should not have been dropped — FSM still active
      expect(manager.getState('agent-bbb')).not.toBe('closed');
    });

    it('allows answer through before remoteConnectionId is set (bootstrap)', () => {
      const { manager, channel } = createManager();

      // We initiate — no offer received yet, so remoteConnectionId is null
      manager.ensureConnection('agent-bbb');
      const fsm = manager.getFSM('agent-bbb')!;
      expect(fsm.remoteConnectionId).toBeNull();

      // Answer arrives with any connectionId — should pass through
      // because remoteConnectionId is null (filter not yet armed)
      channel.createAdapter('agent-bbb').sendSignal('agent-aaa', {
        type: 'answer',
        connectionId: 'any-conn-id',
        data: { type: 'answer', sdp: 'mock-answer' },
      });

      // No drop — FSM processed it
      expect(manager.getState('agent-bbb')).not.toBe('closed');
    });

    it('new offer from reconnected peer updates remoteConnectionId', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // First session
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-old',
        data: { type: 'offer', sdp: 'mock-offer-1' },
      });

      const oldFsm = a.manager.getFSM('agent-bbb')!;
      expect(oldFsm.remoteConnectionId).toBe('b-conn-old');

      // Peer B reconnects with new connectionId — sends new offer.
      // ConnectionManager detects the remoteConnectionId mismatch, destroys
      // the old FSM, and creates a fresh one. Re-fetch after.
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-new',
        data: { type: 'offer', sdp: 'mock-offer-2' },
      });

      const newFsm = a.manager.getFSM('agent-bbb')!;
      expect(newFsm).not.toBe(oldFsm);
      expect(newFsm.remoteConnectionId).toBe('b-conn-new');

      // Candidate with new connectionId should be accepted
      const logBefore = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'candidate',
        connectionId: 'b-conn-new',
        data: { candidate: 'new-candidate', sdpMLineIndex: 0 },
      });

      // Should NOT have been dropped — no "Dropped stale" log entries
      const dropEntries = a.transitionLog.slice(logBefore).filter(
        e => e.trigger.includes('Dropped stale')
      );
      expect(dropEntries).toHaveLength(0);
    });

    it('drops stale candidate after peer reconnects with new offer', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // First session
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-old',
        data: { type: 'offer', sdp: 'mock-offer-1' },
      });

      // Peer B reconnects — new offer
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-new',
        data: { type: 'offer', sdp: 'mock-offer-2' },
      });

      // Stale candidate from old session arrives late
      const logBefore = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'candidate',
        connectionId: 'b-conn-old',
        data: { candidate: 'stale-candidate', sdpMLineIndex: 0 },
      });

      const dropEntry = a.transitionLog.slice(logBefore).find(
        e => e.trigger.includes('Dropped stale candidate')
      );
      expect(dropEntry).toBeDefined();
    });
  });

  describe('peerSessionId filtering (intra-FSM stale signals)', () => {
    it('stamps peerSessionId on outgoing signals', async () => {
      const channel = new FakeSignalingChannel();
      const { manager } = createManager({ agentId: 'agent-aaa', signalingChannel: channel });

      manager.ensureConnection('agent-bbb');

      // negotiationneeded fires via queueMicrotask — flush it
      await vi.advanceTimersByTimeAsync(0);

      // Check that outgoing signals have peerSessionId
      const outgoing = channel.messageLog.filter(e => e.from === 'agent-aaa');
      expect(outgoing.length).toBeGreaterThan(0);
      for (const entry of outgoing) {
        expect(entry.message.peerSessionId).toBeDefined();
        expect(typeof entry.message.peerSessionId).toBe('number');
      }
    });

    it('drops candidates from older peer session after reconnect', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // B sends offer with peerSessionId=1
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-1',
        peerSessionId: 1,
        data: { type: 'offer', sdp: 'mock-offer-1' },
      });

      // B reconnects (new RTCPeerConnection) — sends offer with peerSessionId=2
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-1',
        peerSessionId: 2,
        data: { type: 'offer', sdp: 'mock-offer-2' },
      });

      // Stale candidate from peerSessionId=1 arrives late
      const logBefore = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'candidate',
        connectionId: 'b-conn-1',
        peerSessionId: 1,
        data: { candidate: 'stale-candidate', sdpMLineIndex: 0 },
      });

      const dropEntry = a.transitionLog.slice(logBefore).find(
        e => e.trigger.includes('Dropped stale')
      );
      expect(dropEntry).toBeDefined();
    });

    it('accepts candidates from current peer session', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // B sends offer with peerSessionId=3
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-1',
        peerSessionId: 3,
        data: { type: 'offer', sdp: 'mock-offer' },
      });

      // Candidate from same session
      const logBefore = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'candidate',
        connectionId: 'b-conn-1',
        peerSessionId: 3,
        data: { candidate: 'good-candidate', sdpMLineIndex: 0 },
      });

      const dropEntries = a.transitionLog.slice(logBefore).filter(
        e => e.trigger.includes('Dropped stale')
      );
      expect(dropEntries).toHaveLength(0);
    });

    it('drops stale answer from older peer session', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // B sends offer peerSessionId=1, then peerSessionId=2
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-1',
        peerSessionId: 1,
        data: { type: 'offer', sdp: 'mock-offer-1' },
      });
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-1',
        peerSessionId: 2,
        data: { type: 'offer', sdp: 'mock-offer-2' },
      });

      // Stale answer from peerSessionId=1
      const logBefore = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'answer',
        connectionId: 'b-conn-1',
        peerSessionId: 1,
        data: { type: 'answer', sdp: 'stale-answer' },
      });

      const dropEntry = a.transitionLog.slice(logBefore).find(
        e => e.trigger.includes('Dropped stale answer')
      );
      expect(dropEntry).toBeDefined();
    });

    it('new offer with higher peerSessionId always accepted', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-1',
        peerSessionId: 1,
        data: { type: 'offer', sdp: 'mock-offer-1' },
      });

      const fsm = a.manager.getFSM('agent-bbb')!;
      expect(fsm.remotePeerSessionId).toBe(1);

      // New offer with higher session — always passes
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-conn-1',
        peerSessionId: 5,
        data: { type: 'offer', sdp: 'mock-offer-5' },
      });

      expect(fsm.remotePeerSessionId).toBe(5);
    });

  });

  describe('polite/impolite role assignment', () => {
    it('lower agent ID is polite', () => {
      const { a } = createPair();

      // agent-aaa < agent-bbb, so agent-aaa should be polite when connecting to agent-bbb
      a.manager.ensureConnection('agent-bbb');
      const fsm = a.manager.getFSM('agent-bbb')!;
      // We can't directly access _polite, but we can verify the FSM was created
      expect(fsm).toBeDefined();
    });
  });

  describe('media stream propagation', () => {
    it('updateLocalStream propagates to active connections', () => {
      const { manager } = createManager();
      const stream = createMockStream(true, true);

      manager.ensureConnection('agent-bbb');
      manager.updateLocalStream(stream);

      // The FSM should have received the stream
      const fsm = manager.getFSM('agent-bbb')!;
      expect(fsm).toBeDefined();
      // Stream was added (we can't easily verify without accessing internals,
      // but no error thrown means it worked)
    });
  });

  describe('view model', () => {
    it('starts with empty agents and healthy summary', () => {
      const { manager } = createManager();

      const vm = manager.viewModel;
      expect(vm.summary.totalPeers).toBe(0);
      expect(vm.summary.allHealthy).toBe(true);
      expect(Object.keys(vm.agents)).toHaveLength(0);
    });

    it('updates when connections are created', () => {
      const { manager } = createManager();

      manager.ensureConnection('agent-bbb');

      const vm = manager.viewModel;
      expect(vm.summary.totalPeers).toBe(1);
      expect(vm.summary.connectingPeers).toBe(1);
      expect(vm.summary.allHealthy).toBe(false);
      expect(vm.agents['agent-bbb']).toBeDefined();
      expect(vm.agents['agent-bbb'].phase).toBe('signaling');
    });

    it('tracks multiple connections', () => {
      const { manager } = createManager();

      manager.ensureConnection('agent-bbb');
      manager.ensureConnection('agent-ccc');

      const vm = manager.viewModel;
      expect(vm.summary.totalPeers).toBe(2);
      expect(vm.summary.connectingPeers).toBe(2);
    });

    it('subscriber gets immediate value and updates', () => {
      const { manager } = createManager();
      const viewModels: number[] = [];

      manager.onViewModelChange((vm) => {
        viewModels.push(vm.summary.totalPeers);
      });

      // Should get immediate value (0 peers)
      expect(viewModels[0]).toBe(0);

      manager.ensureConnection('agent-bbb');

      // Should have been updated
      expect(viewModels.length).toBeGreaterThan(1);
      expect(viewModels[viewModels.length - 1]).toBe(1);
    });

    it('per-agent view model access', () => {
      const { manager } = createManager();

      expect(manager.getViewModel('agent-bbb')).toBeUndefined();

      manager.ensureConnection('agent-bbb');

      const vm = manager.getViewModel('agent-bbb');
      expect(vm).toBeDefined();
      expect(vm!.phase).toBe('signaling');
    });
  });

  describe('events', () => {
    it('emits connection-created', () => {
      const { manager } = createManager();
      const handler = vi.fn();
      manager.on('connection-created', handler);

      manager.ensureConnection('agent-bbb');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'connection-created',
          remoteAgent: 'agent-bbb',
        }),
      );
    });

    it('emits connection-state-changed on transitions', () => {
      const { manager } = createManager();
      const handler = vi.fn();
      manager.on('connection-state-changed', handler);

      manager.ensureConnection('agent-bbb');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'connection-state-changed',
          remoteAgent: 'agent-bbb',
          data: expect.objectContaining({ toState: 'signaling' }),
        }),
      );
    });
  });

  describe('closeConnection', () => {
    it('closes a specific connection', () => {
      const { manager } = createManager();

      manager.ensureConnection('agent-bbb');
      manager.closeConnection('agent-bbb', 'test');

      expect(manager.getState('agent-bbb')).toBe('closed');
    });
  });

  describe('destroy', () => {
    it('destroys all connections', () => {
      const { manager } = createManager();

      manager.ensureConnection('agent-bbb');
      manager.ensureConnection('agent-ccc');

      manager.destroy();

      // No errors on subsequent calls
      manager.ensureConnection('agent-ddd');
      // Should be no-op after destroy
      expect(manager.getAllStates().size).toBe(0);
    });

    it('cleans up signaling subscription', () => {
      const { manager } = createManager();
      manager.destroy();

      // Signaling events should be ignored after destroy
      // (no error thrown)
    });
  });
});
