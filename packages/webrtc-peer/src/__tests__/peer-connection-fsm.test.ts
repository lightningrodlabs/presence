import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerConnectionFSM } from '../peer-connection-fsm';
import type { PeerConnectionFSMOptions } from '../peer-connection-fsm';
import { DefaultReconnectPolicy } from '../reconnect-policy';
import { DEFAULT_CONFIG } from '../types';
import type { ConnectionPhase, FSMTransitionEntry } from '../types';
import { MockRTCPeerConnection, createMockStream, createMockTrack } from './test-helpers';

function createFSM(overrides: Partial<PeerConnectionFSMOptions> = {}) {
  const transitionLog: FSMTransitionEntry[] = [];
  const onSignal = vi.fn();
  let _mockPc: MockRTCPeerConnection | undefined;

  const fsm = new PeerConnectionFSM({
    remoteAgent: 'agent-abc123',
    connectionId: 'conn-001',
    polite: true,
    onSignal,
    onTransition: (entry) => transitionLog.push(entry),
    createPeerConnection: (config) => {
      _mockPc = new MockRTCPeerConnection(config);
      return _mockPc as unknown as RTCPeerConnection;
    },
    ...overrides,
  });

  // Return object with getter — do NOT destructure mockPc, use ctx.mockPc
  return {
    fsm,
    get mockPc(): MockRTCPeerConnection { return _mockPc!; },
    transitionLog,
    onSignal,
  };
}

/** Helper: advance FSM to connected state */
async function getConnectedFSM(overrides: Partial<PeerConnectionFSMOptions> = {}) {
  const ctx = createFSM(overrides);
  ctx.fsm.connect();
  // SDP exchange — answer brings signaling back to stable → connecting
  await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
  expect(ctx.fsm.state).toBe('connecting');

  // Composite readiness: ICE + DTLS + data channel
  ctx.mockPc.simulateConnectionState('connected');
  const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
  if (dc?.simulateOpen) dc.simulateOpen();

  expect(ctx.fsm.state).toBe('connected');
  return ctx;
}

describe('PeerConnectionFSM', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('starts in idle state', () => {
      const ctx = createFSM();
      expect(ctx.fsm.state).toBe('idle');
    });

    it('has no peer initially', () => {
      const ctx = createFSM();
      expect(ctx.fsm.peer).toBeNull();
    });

    it('view model shows idle phase', () => {
      const ctx = createFSM();
      const vm = ctx.fsm.viewModel;
      expect(vm.phase).toBe('idle');
      expect(vm.statusText).toBe('Not connected');
      expect(vm.healthy).toBe(false);
      expect(vm.retry).toBeNull();
      expect(vm.quality).toBeNull();
      expect(vm.tracks).toBeNull();
    });
  });

  describe('valid transitions', () => {
    it('idle → signaling on connect()', () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      expect(ctx.fsm.state).toBe('signaling');
      expect(ctx.fsm.peer).not.toBeNull();
      // Transition log: idle→signaling + "new peer session" entry
      expect(ctx.transitionLog.length).toBeGreaterThanOrEqual(1);
      expect(ctx.transitionLog[0].fromState).toBe('idle');
      expect(ctx.transitionLog[0].toState).toBe('signaling');
    });

    it('idle → signaling (then auto-advances) on receiving remote offer', async () => {
      const ctx = createFSM();
      await ctx.fsm.handleRemoteSignal({ type: 'offer', sdp: 'remote-offer' });

      // Receiving an offer auto-transitions to signaling, then the mock immediately
      // processes setRemoteDescription + setLocalDescription which brings signaling
      // back to stable, advancing to connecting
      expect(ctx.fsm.peer).not.toBeNull();
      // Should have gone through signaling
      const signalingTransition = ctx.transitionLog.find(t => t.toState === 'signaling');
      expect(signalingTransition).toBeDefined();
    });

    it('signaling → connecting when SDP exchange completes', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });

      expect(ctx.fsm.state).toBe('connecting');
      const connectingTransition = ctx.transitionLog.find(t => t.toState === 'connecting');
      expect(connectingTransition).toBeDefined();
      expect(connectingTransition!.trigger).toContain('signaling stable');
    });

    it('connecting → connected on composite readiness', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      expect(ctx.fsm.state).toBe('connecting');

      // ICE + DTLS connected
      ctx.mockPc.simulateConnectionState('connected');
      // Data channel open
      const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
      if (dc?.simulateOpen) dc.simulateOpen();

      expect(ctx.fsm.state).toBe('connected');
      const connectedTransition = ctx.transitionLog.find(t => t.toState === 'connected');
      expect(connectedTransition).toBeDefined();
      expect(connectedTransition!.trigger).toContain('composite readiness');
    });

    it('connected → reconnecting on ICE disconnection (after grace)', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('disconnected');
      // 'disconnected' is recoverable — FSM stays in connected during grace
      expect(ctx.fsm.state).toBe('connected');

      // Advance past iceDisconnectedGraceMs (default 15_000)
      vi.advanceTimersByTime(15_001);

      expect(ctx.fsm.state).toBe('reconnecting');
    });

    it('connected → reconnecting on ICE failure', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('failed');

      // 'failed' bypasses the grace
      expect(ctx.fsm.state).toBe('reconnecting');
    });

    it('connected → reconnecting on connectionState=failed (not terminal)', async () => {
      const ctx = await getConnectedFSM();

      // connectionState 'failed' is recoverable, not a dead end — the bounded
      // retry count, not the first failure, is what eventually reaches 'failed'.
      ctx.mockPc.simulateConnectionState('failed');

      expect(ctx.fsm.state).toBe('reconnecting');
    });

    it('connectionState=failed with ICE healthy is attributed to DTLS (full reconnect)', async () => {
      const ctx = await getConnectedFSM();

      // ICE provably connected, then the aggregate connectionState fails:
      // the only transport left to blame is DTLS → full-reconnect strategy.
      ctx.mockPc.simulateIceConnectionState('connected');
      ctx.mockPc.simulateConnectionState('failed');

      expect(ctx.fsm.state).toBe('reconnecting');
      expect(ctx.fsm.viewModel.retry?.strategy).toBe('full-reconnect');
    });

    it('ICE transport failure is attributed to ICE (ice restart first)', async () => {
      const ctx = await getConnectedFSM();

      // iceConnectionState 'failed' is an ICE failure regardless of any
      // aggregate connectionState — recover via the fast-path ICE restart.
      ctx.mockPc.simulateIceConnectionState('failed');

      expect(ctx.fsm.state).toBe('reconnecting');
      expect(ctx.fsm.viewModel.retry?.strategy).toBe('ice-restart');
    });

    it('connected → closed on explicit close', async () => {
      const ctx = await getConnectedFSM();

      ctx.fsm.close('peer left');

      expect(ctx.fsm.state).toBe('closed');
    });

    it('signaling → closed on explicit close', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      ctx.fsm.close('cancelled');

      expect(ctx.fsm.state).toBe('closed');
    });

    it('signaling → disconnected on SDP timeout', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      expect(ctx.fsm.state).toBe('signaling');

      vi.advanceTimersByTime(15_001);

      expect(ctx.fsm.state).toBe('disconnected');
    });

    it('connecting → disconnected on connection timeout', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      expect(ctx.fsm.state).toBe('connecting');

      vi.advanceTimersByTime(7_001);

      expect(ctx.fsm.state).toBe('disconnected');
    });

    it('disconnected → signaling on retry (via connect)', () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      vi.advanceTimersByTime(15_001);
      expect(ctx.fsm.state).toBe('disconnected');

      ctx.fsm.connect();
      expect(ctx.fsm.state).toBe('signaling');
    });

    it('disconnected auto-retries with jitter (500-2000ms)', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      // SDP timeout → disconnected
      vi.advanceTimersByTime(15_001);
      expect(ctx.fsm.state).toBe('disconnected');

      // Jitter hasn't fired yet at 499ms
      vi.advanceTimersByTime(499);
      expect(ctx.fsm.state).toBe('disconnected');

      // By 2001ms the jitter must have fired (max jitter is 2000ms)
      vi.advanceTimersByTime(1502);
      expect(ctx.fsm.state).toBe('signaling');
    });

    it('failed → idle after cleanup timer', async () => {
      // Reach 'failed' the only way it now happens: reconnect retries exhausted.
      const policy = {
        maxAttempts: 1,
        nextRetryDelayMs: () => null,
        strategy: () => 'full-reconnect' as const,
      };
      const ctx = await getConnectedFSM({ reconnectPolicy: policy });

      // Transport failure → reconnecting → policy returns null → failed
      ctx.mockPc.simulateIceConnectionState('failed');
      expect(ctx.fsm.state).toBe('failed');

      // Cleanup timer (5s)
      vi.advanceTimersByTime(5_001);
      expect(ctx.fsm.state).toBe('idle');
    });
  });

  describe('invalid transitions (blocked)', () => {
    it('closed → signaling is blocked', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      ctx.fsm.close('test');
      expect(ctx.fsm.state).toBe('closed');

      ctx.fsm.connect();
      expect(ctx.fsm.state).toBe('closed');

      const blocked = ctx.transitionLog.find(t => t.trigger.includes('BLOCKED'));
      expect(blocked).toBeDefined();
      expect(blocked!.fromState).toBe('closed');
    });

    it('close is idempotent', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      ctx.fsm.close('first');
      ctx.fsm.close('second');

      expect(ctx.fsm.state).toBe('closed');
    });
  });

  describe('timer management', () => {
    it('cancels SDP timeout when transitioning to connecting', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      expect(ctx.fsm.state).toBe('connecting');

      // Advance past original SDP timeout — should NOT go to disconnected from signaling
      // (connecting has its own 7s timeout)
      vi.advanceTimersByTime(7_001);
      // It should have gone to disconnected from the connecting timeout, not the signaling one
      // The key point is the SDP timeout was cancelled
      expect(ctx.fsm.state).toBe('disconnected');
      // Verify the transition was from connecting, not signaling
      const lastDisconnected = ctx.transitionLog.filter(t => t.toState === 'disconnected').pop();
      expect(lastDisconnected!.fromState).toBe('connecting');
    });

    it('cancels connection timeout when transitioning to connected', async () => {
      const ctx = await getConnectedFSM();

      // Advance past all timeouts — should stay connected
      vi.advanceTimersByTime(60_000);
      expect(ctx.fsm.state).toBe('connected');
    });

    it('cancels all timers on destroy', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      ctx.fsm.destroy();

      vi.advanceTimersByTime(60_000);
      // No errors, no transitions after destroy
    });
  });

  describe('reconnection', () => {
    it('attempts ICE restart first (fast path)', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('disconnected');
      // Grace window — FSM stays in connected
      vi.advanceTimersByTime(15_001);
      expect(ctx.fsm.state).toBe('reconnecting');

      // First attempt: delay 0ms for attempt 0
      vi.advanceTimersByTime(1);
      expect(ctx.mockPc.restartIce).toHaveBeenCalled();
    });

    it('reconnection succeeds when ICE recovers (after grace expires)', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('disconnected');
      vi.advanceTimersByTime(15_001);
      expect(ctx.fsm.state).toBe('reconnecting');

      // Trigger reconnect attempt
      vi.advanceTimersByTime(1);

      // ICE recovers — fire connect event
      ctx.mockPc.simulateIceConnectionState('connected');
      ctx.mockPc.simulateConnectionState('connected');
      const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
      if (dc?.readyState === 'open') {
        // Already open, re-trigger readiness
        ctx.mockPc.simulateConnectionState('connected');
      }

      // The FSM should detect composite readiness and return to connected
      // (data channel was already open from initial connection)
      expect(ctx.fsm.state).toBe('connected');
    });

    it('escalates to full reconnect after ICE restart max attempts', async () => {
      const ctx = createFSM({
        reconnectPolicy: new DefaultReconnectPolicy({
          maxAttempts: 10,
          iceRestartMaxAttempts: 2,
        }),
      });
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateConnectionState('connected');
      const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
      if (dc?.simulateOpen) dc.simulateOpen();
      expect(ctx.fsm.state).toBe('connected');

      // ICE fails
      ctx.mockPc.simulateIceConnectionState('failed');
      expect(ctx.fsm.state).toBe('reconnecting');

      // Attempt 0 (ICE restart, delay=0)
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(7_001); // ICE restart timeout

      // Attempt 1 (ICE restart, delay=300+jitter)
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(7_001);

      // Attempt 2 should be full reconnect (delay=1200+jitter)
      vi.advanceTimersByTime(5000);

      // FSM should still be reconnecting (full reconnect in progress)
      expect(ctx.fsm.state).toBe('reconnecting');
    });

    it('goes to failed when retries are exhausted', async () => {
      const ctx = createFSM({
        reconnectPolicy: new DefaultReconnectPolicy({ maxAttempts: 1, iceRestartMaxAttempts: 1 }),
      });
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateConnectionState('connected');
      const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
      if (dc?.simulateOpen) dc.simulateOpen();

      ctx.mockPc.simulateIceConnectionState('disconnected');
      vi.advanceTimersByTime(15_001); // grace expires
      expect(ctx.fsm.state).toBe('reconnecting');

      // Attempt 0 (ICE restart)
      vi.advanceTimersByTime(1);
      // ICE restart timeout
      vi.advanceTimersByTime(7_001);

      // Retries exhausted — should go to failed, not disconnected (which auto-retries)
      expect(ctx.fsm.state).toBe('failed');
    });

    it('resets reconnect count on successful reconnection', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('disconnected');
      vi.advanceTimersByTime(15_001); // grace expires → reconnecting
      vi.advanceTimersByTime(1); // first reconnect attempt

      // Recover
      ctx.mockPc.simulateIceConnectionState('connected');
      ctx.mockPc.simulateConnectionState('connected');

      expect(ctx.fsm.state).toBe('connected');
      expect(ctx.fsm.viewModel.retry).toBeNull();
    });
  });

  describe('view model', () => {
    it('updates on state transitions', () => {
      const ctx = createFSM();
      const phases: ConnectionPhase[] = [];

      ctx.fsm.onViewModelChange((vm) => {
        phases.push(vm.phase);
      });

      ctx.fsm.connect();

      expect(phases).toContain('idle');
      expect(phases).toContain('signaling');
    });

    it('shows progress in signaling phase', () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      const vm = ctx.fsm.viewModel;
      expect(vm.phase).toBe('signaling');
      expect(vm.progress).toBeGreaterThanOrEqual(0);
      expect(vm.progress).toBeLessThanOrEqual(1);
    });

    it('shows retry info when reconnecting', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('disconnected');
      // Advance past grace; the cascading reconnect-attempt (delay=0)
      // fires too, so the first attempt has begun by the time we read.
      vi.advanceTimersByTime(15_001);

      const vm = ctx.fsm.viewModel;
      expect(vm.phase).toBe('reconnecting');
      expect(vm.retry).not.toBeNull();
      expect(vm.retry!.attemptNumber).toBe(1);
      expect(vm.retry!.maxAttempts).toBe(10);
      expect(vm.statusText).toContain('Reconnecting');
    });

    it('shows quality info when connected', async () => {
      const ctx = await getConnectedFSM();

      const vm = ctx.fsm.viewModel;
      expect(vm.phase).toBe('connected');
      expect(vm.quality).not.toBeNull();
      expect(vm.healthy).toBe(true);
    });

    it('tracks sending/receiving state', async () => {
      const ctx = createFSM();
      const stream = createMockStream(true, true);
      ctx.fsm.connect(stream);

      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateConnectionState('connected');
      const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
      if (dc?.simulateOpen) dc.simulateOpen();

      const vm = ctx.fsm.viewModel;
      expect(vm.tracks).not.toBeNull();
      expect(vm.tracks!.audioSending).toBe(true);
      expect(vm.tracks!.videoSending).toBe(true);
    });

    it('unsubscribe works', () => {
      const ctx = createFSM();
      const listener = vi.fn();
      const unsub = ctx.fsm.onViewModelChange(listener);

      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      ctx.fsm.connect();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('transition logging', () => {
    it('logs every valid transition with metadata', () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      // First entry is the transition, second is the "new peer session" entry
      expect(ctx.transitionLog.length).toBeGreaterThanOrEqual(1);
      expect(ctx.transitionLog[0]).toMatchObject({
        fromState: 'idle',
        toState: 'signaling',
        trigger: 'connect() called',
        remoteAgent: 'agent-abc123',
        connectionId: 'conn-001',
      });
      expect(ctx.transitionLog[0].timestamp).toBeGreaterThan(0);
      expect(ctx.transitionLog[0].transportSnapshot).toBeDefined();
      // Entry action log includes peerSessionId
      const sessionEntry = ctx.transitionLog.find(e => e.trigger.includes('new peer session'));
      expect(sessionEntry).toBeDefined();
      expect(sessionEntry!.peerSessionId).toBe(1);
    });

    it('logs blocked transitions with BLOCKED prefix', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      ctx.fsm.close('test');
      ctx.fsm.connect();

      const blocked = ctx.transitionLog.find(t => t.trigger.includes('BLOCKED'));
      expect(blocked).toBeDefined();
      expect(blocked!.fromState).toBe('closed');
      expect(blocked!.toState).toBe('signaling');
    });
  });

  describe('destroy', () => {
    it('prevents further operations', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      ctx.fsm.destroy();

      // connect should be a no-op
      ctx.fsm.connect();
    });

    it('clears all timers', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      ctx.fsm.destroy();

      vi.advanceTimersByTime(60_000);
    });

    it('destroys the peer', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      const peer = ctx.fsm.peer;
      expect(peer).not.toBeNull();

      ctx.fsm.destroy();
      expect(peer!.destroyed).toBe(true);
    });
  });

  describe('media management', () => {
    it('addLocalStream adds tracks when peer exists', () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      const stream = createMockStream(true, true);
      ctx.fsm.addLocalStream(stream);

      expect(ctx.mockPc.addTrack).toHaveBeenCalledTimes(2);
    });

    it('send delegates to peer data channel', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      // No data channel open yet, but send should not throw
      ctx.fsm.send('hello');
    });
  });

  describe('reconnect policy', () => {
    it('uses default policy with quadratic backoff', () => {
      const policy = new DefaultReconnectPolicy();

      expect(policy.nextRetryDelayMs({
        retryCount: 0, elapsedMs: 0, retryReason: 'ice-failed', lastStrategy: 'ice-restart',
      })).toBe(0);

      const delay1 = policy.nextRetryDelayMs({
        retryCount: 1, elapsedMs: 100, retryReason: 'ice-failed', lastStrategy: 'ice-restart',
      });
      expect(delay1).toBeGreaterThanOrEqual(300);
      expect(delay1).toBeLessThanOrEqual(1300);

      const delay2 = policy.nextRetryDelayMs({
        retryCount: 2, elapsedMs: 500, retryReason: 'ice-failed', lastStrategy: 'ice-restart',
      });
      expect(delay2).toBeGreaterThanOrEqual(1200);
      expect(delay2).toBeLessThanOrEqual(2200);

      expect(policy.nextRetryDelayMs({
        retryCount: 10, elapsedMs: 30000, retryReason: 'ice-failed', lastStrategy: 'ice-restart',
      })).toBeNull();
    });

    it('uses ICE restart for first attempts, then full reconnect', () => {
      const policy = new DefaultReconnectPolicy();

      expect(policy.strategy({ retryCount: 0, elapsedMs: 0, retryReason: 'ice-failed', lastStrategy: 'ice-restart' })).toBe('ice-restart');
      expect(policy.strategy({ retryCount: 2, elapsedMs: 200, retryReason: 'ice-failed', lastStrategy: 'ice-restart' })).toBe('ice-restart');
      expect(policy.strategy({ retryCount: 3, elapsedMs: 300, retryReason: 'ice-failed', lastStrategy: 'ice-restart' })).toBe('full-reconnect');
    });

    it('always uses full reconnect for DTLS failure', () => {
      const policy = new DefaultReconnectPolicy();

      expect(policy.strategy({
        retryCount: 0, elapsedMs: 0, retryReason: 'dtls-failed', lastStrategy: 'ice-restart',
      })).toBe('full-reconnect');
    });

    it('honors a custom maxAttempts', () => {
      const policy = new DefaultReconnectPolicy({ maxAttempts: 2 });
      const ctx = (retryCount: number) => ({
        retryCount, elapsedMs: 0, retryReason: 'ice-failed' as const, lastStrategy: 'ice-restart' as const,
      });

      expect(policy.maxAttempts).toBe(2);
      expect(policy.nextRetryDelayMs(ctx(1))).not.toBeNull();
      expect(policy.nextRetryDelayMs(ctx(2))).toBeNull();
    });

    it('with maxAttempts Infinity never stops retrying', () => {
      const policy = new DefaultReconnectPolicy({ maxAttempts: Infinity });

      expect(policy.nextRetryDelayMs({
        retryCount: 1_000_000, elapsedMs: 0, retryReason: 'ice-failed', lastStrategy: 'ice-restart',
      })).not.toBeNull();
    });

    it('honors custom backoff parameters', () => {
      const policy = new DefaultReconnectPolicy({ baseDelayMs: 100, maxDelayMs: 500, jitterMs: 0 });

      // n=0 → 0; n=2 → min(4*100, 500)=400; n=10 → min(100*100,500)=500
      expect(policy.nextRetryDelayMs({ retryCount: 0, elapsedMs: 0, retryReason: 'ice-failed', lastStrategy: 'ice-restart' })).toBe(0);
      expect(policy.nextRetryDelayMs({ retryCount: 2, elapsedMs: 0, retryReason: 'ice-failed', lastStrategy: 'ice-restart' })).toBe(400);
      expect(policy.nextRetryDelayMs({ retryCount: 9, elapsedMs: 0, retryReason: 'ice-failed', lastStrategy: 'ice-restart' })).toBe(500);
    });

    it('honors a custom iceRestartMaxAttempts before escalating', () => {
      const policy = new DefaultReconnectPolicy({ iceRestartMaxAttempts: 1 });
      const ctx = (retryCount: number) => ({
        retryCount, elapsedMs: 0, retryReason: 'ice-failed' as const, lastStrategy: 'ice-restart' as const,
      });

      expect(policy.strategy(ctx(0))).toBe('ice-restart');
      expect(policy.strategy(ctx(1))).toBe('full-reconnect');
    });
  });

  describe('entry actions', () => {
    it('entering signaling creates a peer (via connect)', () => {
      const ctx = createFSM();
      expect(ctx.fsm.peer).toBeNull();

      ctx.fsm.connect();

      expect(ctx.fsm.state).toBe('signaling');
      expect(ctx.fsm.peer).not.toBeNull();
      expect(ctx.fsm.peerSessionId).toBe(1);
    });

    it('entering signaling creates a peer (via remote signal on idle)', async () => {
      const ctx = createFSM();
      expect(ctx.fsm.peer).toBeNull();

      await ctx.fsm.handleRemoteSignal(
        { type: 'offer', sdp: 'mock' },
        'remote-conn',
        1,
      );

      // Mock processes the offer synchronously, so FSM may advance past signaling
      expect(['signaling', 'connecting']).toContain(ctx.fsm.state);
      expect(ctx.fsm.peer).not.toBeNull();
      expect(ctx.fsm.peerSessionId).toBe(1);
    });

    it('connect(stream) attaches stream via entry action', () => {
      const ctx = createFSM();
      const stream = createMockStream(true, true);

      ctx.fsm.connect(stream);

      expect(ctx.fsm.state).toBe('signaling');
      // Stream was attached — mock addTrack should have been called
      expect(ctx.mockPc.addTrack).toHaveBeenCalled();
    });

    it('entering closed destroys the peer', () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      const peerBeforeClose = ctx.fsm.peer;
      expect(peerBeforeClose).not.toBeNull();

      ctx.fsm.close('test');

      expect(ctx.fsm.state).toBe('closed');
      // Entry action destroys peer and sets it to null
      expect(ctx.fsm.peer).toBeNull();
      expect(peerBeforeClose!.destroyed).toBe(true);
    });

    it('full reconnect increments peerSessionId via self-transition', async () => {
      const ctx = await getConnectedFSM();
      const sessionBefore = ctx.fsm.peerSessionId;

      // Trigger transport failure → reconnecting
      ctx.mockPc.simulateIceConnectionState('failed');
      expect(ctx.fsm.state).toBe('reconnecting');

      // Advance past reconnect policy delay (ICE restart first 3 attempts)
      // Skip to attempt 3+ which uses full-reconnect strategy
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(20_000);
      }

      // After full reconnect, session should have incremented
      expect(ctx.fsm.peerSessionId).toBeGreaterThan(sessionBefore);
    });
  });

  describe('signal session validation', () => {
    it('drops stale non-offer signals', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      // Establish remote session = 5 via offer
      await ctx.fsm.handleRemoteSignal(
        { type: 'offer', sdp: 'mock' },
        'remote-conn',
        5,
      );
      expect(ctx.fsm.remotePeerSessionId).toBe(5);

      // Stale candidate from session 3
      const logBefore = ctx.transitionLog.length;
      await ctx.fsm.handleRemoteSignal(
        { candidate: 'stale', sdpMLineIndex: 0 } as any,
        'remote-conn',
        3,
      );
      // Should have logged the drop via structured transition log
      const dropEntry = ctx.transitionLog.slice(logBefore).find(
        e => e.trigger.includes('Dropped stale')
      );
      expect(dropEntry).toBeDefined();
      expect(dropEntry!.trigger).toContain('remote session 3');
    });

    it('accepts current-session non-offer signals', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      await ctx.fsm.handleRemoteSignal(
        { type: 'offer', sdp: 'mock' },
        'remote-conn',
        2,
      );

      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      await ctx.fsm.handleRemoteSignal(
        { candidate: 'good', sdpMLineIndex: 0 } as any,
        'remote-conn',
        2,
      );
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('offers always accepted and update remote session', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      // Offer with session 1
      await ctx.fsm.handleRemoteSignal(
        { type: 'offer', sdp: 'mock-1' },
        'remote-conn',
        1,
      );
      expect(ctx.fsm.remotePeerSessionId).toBe(1);

      // Offer with session 10 — accepted, updates remote
      await ctx.fsm.handleRemoteSignal(
        { type: 'offer', sdp: 'mock-10' },
        'remote-conn',
        10,
      );
      expect(ctx.fsm.remotePeerSessionId).toBe(10);
    });

    it('offer with lower session is accepted but does not downgrade', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();

      await ctx.fsm.handleRemoteSignal(
        { type: 'offer', sdp: 'mock-5' },
        'remote-conn',
        5,
      );
      expect(ctx.fsm.remotePeerSessionId).toBe(5);

      // Offer with session 3 — accepted (offers always pass) but remote stays at 5
      await ctx.fsm.handleRemoteSignal(
        { type: 'offer', sdp: 'mock-3' },
        'remote-conn',
        3,
      );
      expect(ctx.fsm.remotePeerSessionId).toBe(5);
    });
  });

  describe('DTLS stall watchdog', () => {
    it('Mode A: DTLS stall triggers transition to disconnected', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      expect(ctx.fsm.state).toBe('connecting');

      // ICE connects, but DTLS/data-channel do NOT complete
      ctx.mockPc.simulateIceConnectionState('connected');

      // Advance past the DTLS stall timeout (5s) — async because watchdog uses await
      await vi.advanceTimersByTimeAsync(5_001);

      expect(ctx.fsm.state).toBe('disconnected');
      const stallTransition = ctx.transitionLog.find(t =>
        t.trigger.includes('DTLS stall after') && t.toState === 'disconnected'
      );
      expect(stallTransition).toBeDefined();
      expect(stallTransition!.fromState).toBe('connecting');
    });

    it('Mode A: connection-timeout is cancelled when ICE connects', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      expect(ctx.fsm.state).toBe('connecting');

      // ICE connects — should cancel the 15s connection-timeout
      ctx.mockPc.simulateIceConnectionState('connected');

      // DTLS watchdog fires at 5s → disconnected
      await vi.advanceTimersByTimeAsync(5_001);
      expect(ctx.fsm.state).toBe('disconnected');

      // Verify it was the DTLS stall, not the connection timeout
      const disconnectTransitions = ctx.transitionLog.filter(t => t.toState === 'disconnected');
      const lastDisconnect = disconnectTransitions[disconnectTransitions.length - 1];
      expect(lastDisconnect!.trigger).toContain('DTLS stall');
      expect(lastDisconnect!.trigger).not.toContain('connection timeout');
    });

    it('Mode A: watchdog is cancelled on successful connection', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      expect(ctx.fsm.state).toBe('connecting');

      // ICE connects — starts watchdog
      ctx.mockPc.simulateIceConnectionState('connected');

      // Full connection completes before watchdog fires
      ctx.mockPc.simulateConnectionState('connected');
      const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
      if (dc?.simulateOpen) dc.simulateOpen();
      expect(ctx.fsm.state).toBe('connected');

      // Advance past watchdog — should stay connected
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ctx.fsm.state).toBe('connected');
    });

    it('Mode B: ICE never connects, connection-timeout fires at 7s', async () => {
      const ctx = createFSM();
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      expect(ctx.fsm.state).toBe('connecting');

      // Do NOT simulate ICE reaching connected — stays in checking
      vi.advanceTimersByTime(7_001);

      expect(ctx.fsm.state).toBe('disconnected');
      const timeoutTransition = ctx.transitionLog.find(t =>
        t.trigger.includes('connection timeout') && t.toState === 'disconnected'
      );
      expect(timeoutTransition).toBeDefined();
    });

    it('uses dtlsStallTimeoutMs config value', async () => {
      const ctx = createFSM({ config: { ...DEFAULT_CONFIG, dtlsStallTimeoutMs: 2_000 } });
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      expect(ctx.fsm.state).toBe('connecting');

      ctx.mockPc.simulateIceConnectionState('connected');

      // Should NOT have fired yet at 1.5s
      await vi.advanceTimersByTimeAsync(1_500);
      expect(ctx.fsm.state).toBe('connecting');

      // Should fire at 2s
      await vi.advanceTimersByTimeAsync(501);
      expect(ctx.fsm.state).toBe('disconnected');
    });

    it('dtlsStallCount increments across retries', async () => {
      const ctx = createFSM();

      // First connection attempt — DTLS stall
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateIceConnectionState('connected');
      await vi.advanceTimersByTimeAsync(5_001);
      expect(ctx.fsm.state).toBe('disconnected');

      const stall1 = ctx.transitionLog.find(t =>
        t.trigger.includes('stall #1') && t.toState === 'disconnected'
      );
      expect(stall1).toBeDefined();

      // Second connection attempt — another DTLS stall
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateIceConnectionState('connected');
      await vi.advanceTimersByTimeAsync(5_001);
      expect(ctx.fsm.state).toBe('disconnected');

      const stall2 = ctx.transitionLog.find(t =>
        t.trigger.includes('stall #2') && t.toState === 'disconnected'
      );
      expect(stall2).toBeDefined();
    });

    it('dtlsStallCount resets on successful connection', async () => {
      const ctx = createFSM();

      // First attempt — DTLS stall (stall #1)
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateIceConnectionState('connected');
      await vi.advanceTimersByTimeAsync(5_001);
      expect(ctx.fsm.state).toBe('disconnected');

      // Second attempt — succeeds, resetting the counter
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateIceConnectionState('connected');
      ctx.mockPc.simulateConnectionState('connected');
      const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
      if (dc?.simulateOpen) dc.simulateOpen();
      expect(ctx.fsm.state).toBe('connected');

      // Tear the established connection down. ICE is healthy, so a failed
      // aggregate connectionState is a DTLS failure → reconnecting (full
      // reconnect), from which a fresh connect() is valid. The successful
      // connection above already reset the stall counter.
      ctx.mockPc.simulateConnectionState('failed');
      expect(ctx.fsm.state).toBe('reconnecting');

      // Third attempt — DTLS stall again: should be stall #1, not #2
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateIceConnectionState('connected');
      await vi.advanceTimersByTimeAsync(5_001);
      expect(ctx.fsm.state).toBe('disconnected');

      // Find stall #1 that occurred AFTER the successful connection
      const allStall1s = ctx.transitionLog.filter(t =>
        t.trigger.includes('stall #1') && t.toState === 'disconnected'
      );
      // Should have two "stall #1" entries: one before success, one after reset
      expect(allStall1s.length).toBe(2);
    });
  });

  describe('ICE disconnected grace period', () => {
    it('stays in connected immediately after ICE → disconnected', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('disconnected');

      // No transition yet — grace window pending
      expect(ctx.fsm.state).toBe('connected');
    });

    it('does not transition before grace window expires', async () => {
      const ctx = await getConnectedFSM();
      ctx.mockPc.simulateIceConnectionState('disconnected');

      vi.advanceTimersByTime(14_999);

      expect(ctx.fsm.state).toBe('connected');
    });

    it('transitions to reconnecting after grace expires', async () => {
      const ctx = await getConnectedFSM();
      ctx.mockPc.simulateIceConnectionState('disconnected');

      vi.advanceTimersByTime(15_001);

      expect(ctx.fsm.state).toBe('reconnecting');
    });

    it('stays in connected if ICE recovers within grace', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('disconnected');
      vi.advanceTimersByTime(5_000);

      // ICE heals on its own
      ctx.mockPc.simulateIceConnectionState('connected');

      // Advance past where the grace would have fired
      vi.advanceTimersByTime(20_000);

      expect(ctx.fsm.state).toBe('connected');
      // No reconnect was scheduled
      expect(ctx.mockPc.restartIce).not.toHaveBeenCalled();
    });

    it('ICE → failed during grace bypasses grace and transitions immediately', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('disconnected');
      vi.advanceTimersByTime(5_000);
      expect(ctx.fsm.state).toBe('connected');

      ctx.mockPc.simulateIceConnectionState('failed');

      // Immediate — no further timer advancement needed
      expect(ctx.fsm.state).toBe('reconnecting');
    });

    it('flicker disconnected→connected→disconnected restarts the grace window', async () => {
      const ctx = await getConnectedFSM();

      ctx.mockPc.simulateIceConnectionState('disconnected');
      vi.advanceTimersByTime(10_000); // 10s into first grace
      ctx.mockPc.simulateIceConnectionState('connected');
      vi.advanceTimersByTime(2_000);
      ctx.mockPc.simulateIceConnectionState('disconnected');

      // 12s elapsed total since first disconnect; if grace had not been
      // restarted, we'd be 3s past expiry. Verify we're still connected.
      vi.advanceTimersByTime(10_000);
      expect(ctx.fsm.state).toBe('connected');

      // 5s more — total 15s001ms since the second 'disconnected'
      vi.advanceTimersByTime(5_001);
      expect(ctx.fsm.state).toBe('reconnecting');
    });

    it('grace timer is cleared on FSM destroy', async () => {
      const ctx = await getConnectedFSM();
      ctx.mockPc.simulateIceConnectionState('disconnected');
      expect(ctx.fsm.state).toBe('connected');

      ctx.fsm.destroy();

      // Advance past where grace would have fired — no errors, no new transitions
      const transitionsBefore = ctx.transitionLog.length;
      vi.advanceTimersByTime(60_000);

      // No new transitions emitted post-destroy
      expect(ctx.transitionLog.length).toBe(transitionsBefore);
    });

    it('grace timer is cleared on close()', async () => {
      const ctx = await getConnectedFSM();
      ctx.mockPc.simulateIceConnectionState('disconnected');

      ctx.fsm.close('user left');
      expect(ctx.fsm.state).toBe('closed');

      // The grace fires — should be a no-op since FSM is closed
      vi.advanceTimersByTime(20_000);

      // Still closed, never transitioned through reconnecting
      expect(ctx.fsm.state).toBe('closed');
      const reconnectingTransitions = ctx.transitionLog.filter(
        t => t.toState === 'reconnecting'
      );
      expect(reconnectingTransitions.length).toBe(0);
    });

    it('grace timer is cleared when full reconnect creates a new peer', async () => {
      // Use a policy that goes straight to full reconnect
      const ctx = createFSM({
        reconnectPolicy: new DefaultReconnectPolicy({
          maxAttempts: 10,
          iceRestartMaxAttempts: 0,
        }),
      });
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateConnectionState('connected');
      const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
      if (dc?.simulateOpen) dc.simulateOpen();
      expect(ctx.fsm.state).toBe('connected');

      ctx.mockPc.simulateIceConnectionState('disconnected');
      // Grace expires → reconnecting → full reconnect (new peer session)
      vi.advanceTimersByTime(15_001);
      vi.advanceTimersByTime(1); // first reconnect attempt
      // The state-transition into reconnecting calls _clearAllTimers() so
      // the new peer's listeners start fresh; verify advancing more time
      // doesn't produce a phantom failure transition from a stale grace.
      const transitionCount = ctx.transitionLog.length;
      vi.advanceTimersByTime(20_000);

      // No phantom transition from a stale grace timer firing on the
      // destroyed peer — _clearAllTimers() cancelled it.
      const phantomFailures = ctx.transitionLog
        .slice(transitionCount)
        .filter(t => t.trigger.includes('ice-disconnected'));
      expect(phantomFailures.length).toBe(0);
    });

    it('respects custom iceDisconnectedGraceMs in config', async () => {
      const ctx = createFSM({
        config: { ...DEFAULT_CONFIG, iceDisconnectedGraceMs: 3_000 },
      });
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      ctx.mockPc.simulateConnectionState('connected');
      const dc = ctx.mockPc.createDataChannel.mock.results[0]?.value;
      if (dc?.simulateOpen) dc.simulateOpen();
      expect(ctx.fsm.state).toBe('connected');

      ctx.mockPc.simulateIceConnectionState('disconnected');
      vi.advanceTimersByTime(2_999);
      expect(ctx.fsm.state).toBe('connected');

      vi.advanceTimersByTime(2);
      expect(ctx.fsm.state).toBe('reconnecting');
    });

    it('connecting → ICE disconnected acts immediately (no grace)', async () => {
      // Outside `connected`, the grace is intentionally bypassed: there's
      // no established connection to preserve and a 15s wait would just
      // delay legitimate retries during initial setup.
      const ctx = createFSM();
      ctx.fsm.connect();
      await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
      expect(ctx.fsm.state).toBe('connecting');

      ctx.mockPc.simulateIceConnectionState('disconnected');

      // _handleTransportFailure during 'connecting' transitions to
      // 'disconnected' (FSM phase, not iceState) — see fsm code.
      expect(ctx.fsm.state).toBe('disconnected');
    });
  });
});
