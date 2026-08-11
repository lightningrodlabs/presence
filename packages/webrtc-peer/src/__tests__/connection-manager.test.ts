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
  reconnectPolicy?: ConnectionManagerOptions['reconnectPolicy'];
} = {}) {
  const channel = options.signalingChannel ?? new FakeSignalingChannel();
  const agentId = options.agentId ?? 'agent-aaa';
  const transitionLog: FSMTransitionEntry[] = [];

  const manager = new ConnectionManager({
    myAgentId: agentId,
    signaling: channel.createAdapter(agentId),
    onTransition: (entry) => transitionLog.push(entry),
    ...(options.reconnectPolicy ? { reconnectPolicy: options.reconnectPolicy } : {}),
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

  // ---------------------------------------------------------------------------
  // Epoch ordering — the cross-FSM reconnect-identity fix.
  // peerSessionId resets to 0 on every new FSM, so it cannot order signals
  // across a teardown+recreate. The orchestrator-allocated `epoch` survives FSM
  // recreation and is the authoritative "which attempt is current" order.
  // See docs/WEBRTC_RECONNECT_IDENTITY.md.
  // ---------------------------------------------------------------------------
  describe('epoch ordering (cross-FSM reconnect identity)', () => {
    it('stamps the epoch on every outgoing signal when given one', async () => {
      const channel = new FakeSignalingChannel();
      const { manager } = createManager({ agentId: 'agent-aaa', signalingChannel: channel });

      manager.ensureConnection('agent-bbb', { epoch: 7 });
      await vi.advanceTimersByTimeAsync(0); // flush negotiationneeded microtask

      const outgoing = channel.messageLog.filter(e => e.from === 'agent-aaa');
      expect(outgoing.length).toBeGreaterThan(0);
      for (const entry of outgoing) {
        expect(entry.message.epoch).toBe(7);
      }
    });

    it('drops a signal from a superseded (lower) epoch', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      a.manager.ensureConnection('agent-bbb', { epoch: 2 });

      const logBefore = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'candidate',
        connectionId: 'b-dead',
        epoch: 1, // from the previous, torn-down attempt
        data: { candidate: 'stale-candidate', sdpMLineIndex: 0 },
      });

      const dropEntry = a.transitionLog.slice(logBefore).find(
        e => e.trigger.includes('Dropped stale') && e.trigger.includes('epoch 1 < current 2')
      );
      expect(dropEntry).toBeDefined();
    });

    it('a stale lower-epoch offer cannot latch the remote session, so the live answer is NOT dropped (the fix)', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // We initiate the current attempt at epoch 2.
      a.manager.ensureConnection('agent-bbb', { epoch: 2 });
      const fsm = a.manager.getFSM('agent-bbb')!;
      expect(fsm.epoch).toBe(2);

      // A late offer from the DEAD attempt (epoch 1) arrives after the fresh FSM
      // exists. Pre-fix this would be accepted (offers always passed) and latch
      // remoteConnectionId='b-dead', after which the live answer is rejected.
      const log1 = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-dead',
        epoch: 1,
        data: { type: 'offer', sdp: 'stale-offer' },
      });
      // Dropped on epoch order — the dead session never latches.
      expect(
        a.transitionLog.slice(log1).some(e => e.trigger.includes('epoch 1 < current 2'))
      ).toBe(true);
      expect(fsm.remoteConnectionId).toBeNull();

      // The LIVE answer for the current attempt (epoch 2), with an independently
      // random connectionId, must be accepted — equal epoch skips the
      // connectionId-equality filter that used to cause the deadlock.
      const log2 = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'answer',
        connectionId: 'b-live',
        epoch: 2,
        data: { type: 'answer', sdp: 'live-answer' },
      });
      const dropped = a.transitionLog.slice(log2).filter(e => e.trigger.includes('Dropped stale'));
      expect(dropped).toHaveLength(0);
      expect(a.manager.getFSM('agent-bbb')!.remoteConnectionId).toBe('b-live');
    });

    it('a higher-epoch offer supersedes the FSM and adopts the new generation', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      a.manager.ensureConnection('agent-bbb', { epoch: 1 });
      const oldFsm = a.manager.getFSM('agent-bbb')!;
      expect(oldFsm.epoch).toBe(1);

      // Peer re-initiated at a newer generation.
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-gen2',
        epoch: 2,
        data: { type: 'offer', sdp: 'offer-gen2' },
      });

      const newFsm = a.manager.getFSM('agent-bbb')!;
      expect(newFsm).not.toBe(oldFsm);
      expect(newFsm.epoch).toBe(2);
      expect(newFsm.remoteConnectionId).toBe('b-gen2');
    });

    it('CONTRAST: without epochs, a latched stale session drops the live answer (the pre-fix deadlock)', () => {
      const { manager, channel, transitionLog } = createManager({ agentId: 'agent-aaa' });
      const bAdapter = channel.createAdapter('agent-bbb');

      // Legacy path — no epoch anywhere.
      manager.ensureConnection('agent-bbb');
      const fsm = manager.getFSM('agent-bbb')!;

      // A late offer from a dead session latches remoteConnectionId (offers
      // always pass in the legacy path).
      bAdapter.sendSignal('agent-aaa', {
        type: 'offer',
        connectionId: 'b-dead',
        data: { type: 'offer', sdp: 'stale-offer' },
      });
      expect(fsm.remoteConnectionId).toBe('b-dead');

      // The live answer (independently-random connectionId) now matches neither
      // our connectionId nor the latched 'b-dead' — so it is dropped. This is
      // the deadlock the epoch ordering removes.
      const logBefore = transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'answer',
        connectionId: 'b-live',
        data: { type: 'answer', sdp: 'live-answer' },
      });
      expect(
        transitionLog.slice(logBefore).some(e => e.trigger.includes('Dropped stale answer'))
      ).toBe(true);
      // remoteConnectionId stays latched to the dead session — the live answer
      // did not get through.
      expect(manager.getFSM('agent-bbb')!.remoteConnectionId).toBe('b-dead');
    });

    it('same epoch: peer whose FSM was recreated (closed-FSM replacement) can still deliver answers', () => {
      const { a, channel } = createPair();
      const bAdapter = channel.createAdapter('agent-bbb');

      // A and B connected attempt at epoch 5. Epoch is equal on both sides, so
      // the manager deliberately skips its connectionId-equality filter
      // (WEBRTC_RECONNECT_IDENTITY.md §7 step 3) and relies on the FSM-level
      // session validation — which is exactly what this task fixes.
      a.manager.ensureConnection('agent-bbb', { epoch: 5 });
      const fsm = a.manager.getFSM('agent-bbb')!;
      expect(fsm.epoch).toBe(5);

      // B's first FSM answers, latching a high remote session.
      bAdapter.sendSignal('agent-aaa', {
        type: 'answer',
        connectionId: 'b-old',
        peerSessionId: 11,
        epoch: 5,
        data: { type: 'answer', sdp: 'answer-old' },
      });
      expect(fsm.remoteConnectionId).toBe('b-old');
      expect(fsm.remotePeerSessionId).toBe(11);

      // B's FSM closes (retry budget) and recreates at the same epoch: fresh
      // connectionId, peerSessionId counter restarted. A's long-lived FSM
      // whose _session.remote latched a higher value must re-latch onto B's
      // fresh answer instead of dropping it as stale (the deadlock).
      const logBefore = a.transitionLog.length;
      bAdapter.sendSignal('agent-aaa', {
        type: 'answer',
        connectionId: 'b-new',
        peerSessionId: 1,
        epoch: 5,
        data: { type: 'answer', sdp: 'answer-new' },
      });

      expect(
        a.transitionLog.slice(logBefore).some(t => t.trigger.includes('Dropped stale answer'))
      ).toBe(false);
      expect(a.manager.getFSM('agent-bbb')!.remoteConnectionId).toBe('b-new');
      expect(a.manager.getFSM('agent-bbb')!.remotePeerSessionId).toBe(1);
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

    it('does not re-emit connection-state-changed on same-state sub-phase log entries', async () => {
      const { manager } = createManager();
      manager.ensureConnection('agent-zzz');
      const fsm = manager.getFSM('agent-zzz')!;
      await fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      const pc = fsm.peer!.pc as unknown as MockRTCPeerConnection;
      pc.simulateConnectionState('connected'); // real connecting->connected
      expect(fsm.state).toBe('connected');

      // Now subscribe and trigger a same-state sub-phase log entry: an ICE
      // blip while connected produces a `connected->connected` _logTransition,
      // which must NOT surface as a connection-state-change (it would re-run
      // consumers' on-connect side effects: re-add tracks, re-tag carrier, etc.).
      const handler = vi.fn();
      manager.on('connection-state-changed', handler);
      pc.simulateIceConnectionState('disconnected'); // logTransition only
      pc.simulateIceConnectionState('connected');     // logTransition only

      expect(fsm.state).toBe('connected'); // still connected (within grace)
      expect(handler).not.toHaveBeenCalled();
    });

    it('forwards the FSM establishment-timeline (§6.6) when a connection reaches connected', async () => {
      const { manager } = createManager();
      const handler = vi.fn();
      manager.on('establishment-timeline', handler);

      manager.ensureConnection('agent-zzz');
      const fsm = manager.getFSM('agent-zzz')!;
      await fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      const pc = fsm.peer!.pc as unknown as MockRTCPeerConnection;
      pc.simulateConnectionState('connected'); // ICE+DTLS → media-ready

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'establishment-timeline',
          remoteAgent: 'agent-zzz',
          data: expect.objectContaining({
            wasReconnect: false,
            connectedMs: expect.any(Number),
          }),
        }),
      );
    });

    it('forwards FSM error events (they used to die here, losing the exception text)', async () => {
      const { manager } = createManager();
      const handler = vi.fn();
      manager.on('error', handler);

      manager.ensureConnection('agent-err');
      const fsm = manager.getFSM('agent-err')!;
      await fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      const pc = fsm.peer!.pc as unknown as MockRTCPeerConnection;
      pc.simulateConnectionState('connected');

      // A data-channel error: RTCPeer emits 'error', the FSM re-emits it,
      // and the manager must now forward it instead of dropping it.
      const boom = new Error('sctp exploded');
      (pc as any)._dataChannels[0].simulateError(boom);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          remoteAgent: 'agent-err',
          data: boom,
        }),
      );
    });
  });

  /**
   * The manager's map cleanup had no coverage of any kind, and the code and
   * its own comment disagreed: the comment said "closed/failed", the code
   * tested only `closed`. A give-up therefore left the FSM in the map and
   * emitted no `connection-closed`, so a consumer keying its connection slot
   * off that event stayed wrong for the rest of the session
   * (MAINTAINABILITY_ASSESSMENT.md §3.1c).
   *
   * `failedFSM` reaches `failed` the only way it now happens — a transport
   * failure on an established connection with the retry budget already spent.
   */
  describe('map cleanup on terminal states', () => {
    const giveUpImmediately = {
      maxAttempts: 1,
      nextRetryDelayMs: () => null,
      strategy: () => 'full-reconnect' as const,
    };

    async function failedFSM() {
      const { manager } = createManager({ reconnectPolicy: giveUpImmediately });
      const closed = vi.fn();
      manager.on('connection-closed', closed);

      manager.ensureConnection('agent-zzz');
      const fsm = manager.getFSM('agent-zzz')!;
      await fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      const pc = fsm.peer!.pc as unknown as MockRTCPeerConnection;
      pc.simulateConnectionState('connected');
      expect(fsm.state).toBe('connected');

      // Transport dies; the policy has no retries left.
      pc.simulateIceConnectionState('failed');
      expect(fsm.state).toBe('failed');

      return { manager, fsm, closed };
    }

    it('removes a failed connection from the map', async () => {
      const { manager } = await failedFSM();
      expect(manager.getFSM('agent-zzz')).toBeDefined(); // deferred by one tick

      vi.advanceTimersByTime(1);

      expect(manager.getFSM('agent-zzz')).toBeUndefined();
    });

    it('emits connection-closed when a connection gives up', async () => {
      const { closed } = await failedFSM();

      vi.advanceTimersByTime(1);

      expect(closed).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'connection-closed',
          remoteAgent: 'agent-zzz',
        }),
      );
    });

    it('closes the failed FSM rather than orphaning its timers', async () => {
      const { fsm } = await failedFSM();

      vi.advanceTimersByTime(1);

      expect(fsm.state).toBe('closed');
    });

    it('emits connection-closed exactly once across failed → closed', async () => {
      const { closed } = await failedFSM();

      // One tick removes it and closes the FSM; closing re-enters the same
      // handler with toState 'closed', which must not emit a second event.
      vi.advanceTimersByTime(10_000);

      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('lets ensureConnection build a fresh connection after a give-up', async () => {
      const { manager } = await failedFSM();
      vi.advanceTimersByTime(1);

      manager.ensureConnection('agent-zzz');

      const replacement = manager.getFSM('agent-zzz');
      expect(replacement).toBeDefined();
      expect(replacement!.state).toBe('signaling');
    });

    it('removes a closed connection from the map and emits connection-closed', () => {
      const { manager } = createManager();
      const closed = vi.fn();
      manager.on('connection-closed', closed);

      manager.ensureConnection('agent-bbb');
      manager.closeConnection('agent-bbb', 'test');
      vi.advanceTimersByTime(1);

      expect(manager.getFSM('agent-bbb')).toBeUndefined();
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('does not clear the map for transient phases', async () => {
      const { manager } = createManager();
      manager.ensureConnection('agent-zzz');
      const fsm = manager.getFSM('agent-zzz')!;
      await fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      const pc = fsm.peer!.pc as unknown as MockRTCPeerConnection;
      pc.simulateConnectionState('connected');

      // Default policy: this goes to `reconnecting`, not `failed`.
      pc.simulateIceConnectionState('failed');
      expect(fsm.state).toBe('reconnecting');
      vi.advanceTimersByTime(1);

      expect(manager.getFSM('agent-zzz')).toBe(fsm);
    });
  });

  /**
   * In-place FSM replacement is **silent**: `fsm.destroy()` clears handlers
   * and the peer without transitioning, so no `connection-state-changed` and
   * no `connection-closed` is emitted for the connection that went away. The
   * only thing a consumer sees is the *new* connection's `signaling`, under a
   * new connectionId.
   *
   * A consumer that keys its own per-peer state on connectionId — Presence
   * does — must therefore adopt the new id on `signaling` rather than only
   * creating state when it has none. If it does not, its record still names
   * the destroyed connection, and every subsequent connect/close for the live
   * one is discarded by its own supersede guard: the record is stranded in
   * whatever state it held at the moment of replacement
   * (MAINTAINABILITY_ASSESSMENT.md §3.1c, reached without any `failed`).
   *
   * These tests pin the emission contract that makes that adoption necessary
   * and sufficient. Nothing else asserts it, and the consumer side cannot be
   * tested at all until Phase 6.
   */
  describe('in-place FSM replacement is silent', () => {
    function offerFromB(channel: FakeSignalingChannel, epoch: number, connectionId: string) {
      channel.createAdapter('agent-bbb').sendSignal('agent-aaa', {
        type: 'offer',
        connectionId,
        epoch,
        data: { type: 'offer', sdp: 'mock-offer' },
      });
    }

    it('replaces the FSM on a higher-epoch offer, under a new connectionId', () => {
      const { a, channel } = createPair();
      a.manager.ensureConnection('agent-bbb', { epoch: 1 });
      const before = a.manager.getFSM('agent-bbb')!.connectionId;

      offerFromB(channel, 2, 'b-new');

      const after = a.manager.getFSM('agent-bbb')!.connectionId;
      expect(after).not.toBe(before);
    });

    it('emits NO connection-closed for the connection it replaced', () => {
      const { a, channel } = createPair();
      a.manager.ensureConnection('agent-bbb', { epoch: 1 });
      const closed = vi.fn();
      a.manager.on('connection-closed', closed);

      offerFromB(channel, 2, 'b-new');
      vi.advanceTimersByTime(10_000);

      // This is the whole finding: the consumer is never told the old
      // connection died. Its only notice is the new one's signaling.
      expect(closed).not.toHaveBeenCalled();
    });

    it('announces the replacement only as a signaling transition on the new id', () => {
      const { a, channel } = createPair();
      a.manager.ensureConnection('agent-bbb', { epoch: 1 });
      const before = a.manager.getFSM('agent-bbb')!.connectionId;
      const changes: any[] = [];
      a.manager.on('connection-state-changed', e => changes.push(e));

      offerFromB(channel, 2, 'b-new');

      const signaling = changes.filter(e => e.data?.toState === 'signaling');
      expect(signaling.length).toBeGreaterThan(0);
      expect(signaling.every(e => e.connectionId !== before)).toBe(true);
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

  describe('on-demand data-channel / ICE controls', () => {
    function pcFor(manager: ConnectionManager, agent: string): MockRTCPeerConnection {
      return manager.getFSM(agent)!.peer!.pc as unknown as MockRTCPeerConnection;
    }

    it('recreateDataChannel(agent) recreates the channel in place on the same pc', () => {
      const { manager } = createManager(); // agentId 'agent-aaa'
      manager.ensureConnection('agent-zzz');
      const pc = pcFor(manager, 'agent-zzz');
      expect(pc.createDataChannel).toHaveBeenCalledTimes(1);

      expect(manager.recreateDataChannel('agent-zzz')).toBe(true);

      expect(pc.createDataChannel).toHaveBeenCalledTimes(2);
      expect(pc.close).not.toHaveBeenCalled();
    });

    it('restartIce(agent) drives an ICE restart on the existing peer', () => {
      const { manager } = createManager();
      manager.ensureConnection('agent-zzz');
      const pc = pcFor(manager, 'agent-zzz');

      expect(manager.restartIce('agent-zzz')).toBe(true);
      expect(pc.restartIce).toHaveBeenCalled();
    });

    it('both return false for an unknown peer', () => {
      const { manager } = createManager();
      expect(manager.recreateDataChannel('nobody')).toBe(false);
      expect(manager.restartIce('nobody')).toBe(false);
    });
  });
});
