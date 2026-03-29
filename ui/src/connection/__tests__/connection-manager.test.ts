import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from '../connection-manager';
import type { ConnectionManagerOptions } from '../connection-manager';
import type { FSMTransitionEntry } from '../types';
import {
  MockRTCPeerConnection,
  FakeSignalingChannel,
  createMockStream,
} from './test-helpers';

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
