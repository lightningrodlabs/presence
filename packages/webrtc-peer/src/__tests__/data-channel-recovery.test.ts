import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerConnectionFSM } from '../peer-connection-fsm';
import type { PeerConnectionFSMOptions } from '../peer-connection-fsm';
import { RTCPeer } from '../rtc-peer';
import { DEFAULT_CONFIG } from '../types';
import type { ConnectionConfig, FSMTransitionEntry } from '../types';
import { MockRTCPeerConnection, MockRTCDataChannel } from './test-helpers';

/**
 * These tests exercise the real failure observed in production: ICE and DTLS
 * reach `connected` and media flows, but the data channel never opens within
 * the budget. The pre-fix FSM gated `connected` on the data channel and had no
 * recovery, so the whole connection (including the expensive ICE+DTLS state)
 * was torn down and rebuilt from scratch — ~26s of churn on the lossy signals
 * carrier in the captured logs.
 *
 * The contract under test: a stuck data channel is recovered *in place* — the
 * channel is recreated on the SAME RTCPeerConnection (no new ICE, no new DTLS,
 * no new peer session), bounded by a retry count, only escalating to a full
 * reconnect if recreation never succeeds.
 *
 * Nothing here stubs the behaviour being tested: the FSM/RTCPeer logic runs for
 * real against the same MockRTCPeerConnection the rest of the suite uses. The
 * only assertions against the mock are on the genuine browser API calls the
 * implementation must (or must not) make — `createDataChannel` and `close`.
 */

// FSM factory with a counter on the RTCPeerConnection factory so a test can
// prove no *new* peer connection was created during in-place DC recovery.
function createFSM(configOverride: Partial<ConnectionConfig> = {}) {
  const transitionLog: FSMTransitionEntry[] = [];
  let _mockPc: MockRTCPeerConnection | undefined;
  let pcFactoryCalls = 0;

  const fsm = new PeerConnectionFSM({
    remoteAgent: 'agent-pr',
    connectionId: 'conn-dc-1',
    polite: true,
    onSignal: vi.fn(),
    onTransition: (entry) => transitionLog.push(entry),
    config: { ...DEFAULT_CONFIG, ...configOverride },
    createPeerConnection: (config) => {
      pcFactoryCalls += 1;
      _mockPc = new MockRTCPeerConnection(config);
      return _mockPc as unknown as RTCPeerConnection;
    },
  } as PeerConnectionFSMOptions);

  return {
    fsm,
    transitionLog,
    get mockPc(): MockRTCPeerConnection { return _mockPc!; },
    get pcFactoryCalls() { return pcFactoryCalls; },
  };
}

/** Drive the FSM to ICE+DTLS connected with the data channel still closed. */
async function connectedTransportNoDataChannel(configOverride: Partial<ConnectionConfig> = {}) {
  const ctx = createFSM(configOverride);
  ctx.fsm.connect();
  await ctx.fsm.handleRemoteSignal({ type: 'answer', sdp: 'mock-answer' });
  expect(ctx.fsm.state).toBe('connecting');
  // connectionState=connected ⇒ ICE + DTLS both up (the 'connect' event).
  // The data channel is deliberately NOT opened. Since §6.1 the FSM promotes to
  // `connected` on ICE+DTLS alone (media flows), with the data channel as a
  // separate, recoverable signal — so the call is live here even though the
  // channel is still closed, and the watchdog recovers the channel in the
  // background.
  ctx.mockPc.simulateConnectionState('connected');
  return ctx;
}

function latestDataChannel(ctx: ReturnType<typeof createFSM>): MockRTCDataChannel {
  const results = ctx.mockPc.createDataChannel.mock.results;
  return results[results.length - 1].value as MockRTCDataChannel;
}

describe('data channel recovery (in-place, no ICE/DTLS teardown)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('recreates the data channel in place when it stalls, without tearing down the connection', async () => {
    const ctx = await connectedTransportNoDataChannel({
      dataChannelStallTimeoutMs: 50,
      maxDataChannelRecreateAttempts: 3,
    });

    // Transport (ICE+DTLS) is up → FSM is `connected` and media flows; the data
    // channel is not yet open, surfaced separately as dataChannelReady=false.
    expect(ctx.fsm.state).toBe('connected');
    expect(ctx.fsm.viewModel.dataChannelReady).toBe(false);
    expect(ctx.mockPc.createDataChannel).toHaveBeenCalledTimes(1); // initial channel only

    // Let the data-channel watchdog fire once.
    vi.advanceTimersByTime(51);

    // The channel was recreated ON THE SAME pc:
    expect(ctx.mockPc.createDataChannel).toHaveBeenCalledTimes(2); // recreated in place
    expect(ctx.mockPc.close).not.toHaveBeenCalled();               // ICE/DTLS preserved
    expect(ctx.pcFactoryCalls).toBe(1);                            // no new RTCPeerConnection
    expect(ctx.fsm.state).toBe('connected');                      // call stays live throughout

    // The replacement channel opening flips the readiness flag — no phase change.
    latestDataChannel(ctx).simulateOpen();
    expect(ctx.fsm.state).toBe('connected');
    expect(ctx.fsm.viewModel.dataChannelReady).toBe(true);
  });

  it('escalates to a reconnect only after exhausting the recreate budget', async () => {
    const ctx = await connectedTransportNoDataChannel({
      dataChannelStallTimeoutMs: 50,
      maxDataChannelRecreateAttempts: 2,
    });

    expect(ctx.mockPc.createDataChannel).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(51); // attempt 1 → recreate
    expect(ctx.mockPc.createDataChannel).toHaveBeenCalledTimes(2);
    expect(ctx.fsm.state).toBe('connected');

    vi.advanceTimersByTime(51); // attempt 2 → recreate
    expect(ctx.mockPc.createDataChannel).toHaveBeenCalledTimes(3);
    expect(ctx.fsm.state).toBe('connected');
    // Up to here the live call was preserved — no hard close of the transport.
    expect(ctx.mockPc.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(51); // budget exhausted → escalate
    // The live call escalates: a data-channel-stall on a `connected` connection
    // drives a reconnect (full-reconnect forced by policy) rather than holding a
    // permanently-mute channel. The escalation transition is recorded
    // synchronously regardless of when the reconnect timer subsequently fires.
    const escalation = ctx.transitionLog.find(
      t => t.fromState === 'connected' && t.toState === 'reconnecting' &&
        t.trigger.includes('data-channel-stall'),
    );
    expect(escalation).toBeDefined();
    expect(ctx.fsm.state).not.toBe('connected'); // left the live call to rebuild
  });

  it('does not arm the watchdog once the data channel is already open', async () => {
    const ctx = await connectedTransportNoDataChannel({
      dataChannelStallTimeoutMs: 50,
      maxDataChannelRecreateAttempts: 3,
    });
    latestDataChannel(ctx).simulateOpen();
    expect(ctx.fsm.state).toBe('connected');

    // Advancing well past the stall timeout must not recreate anything.
    vi.advanceTimersByTime(500);
    expect(ctx.mockPc.createDataChannel).toHaveBeenCalledTimes(1);
    expect(ctx.fsm.state).toBe('connected');
  });
});

describe('on-demand affordances (PeerConnectionFSM)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('recreateDataChannel() recreates in place on a live peer and reports success', () => {
    const ctx = createFSM();
    ctx.fsm.connect(); // creates the peer + pc on entering signaling
    expect(ctx.mockPc.createDataChannel).toHaveBeenCalledTimes(1);

    const ok = ctx.fsm.recreateDataChannel();

    expect(ok).toBe(true);
    expect(ctx.mockPc.createDataChannel).toHaveBeenCalledTimes(2); // in place
    expect(ctx.mockPc.close).not.toHaveBeenCalled();               // transport kept
    expect(ctx.pcFactoryCalls).toBe(1);                            // same pc
  });

  it('restartIce() drives an ICE restart on a live peer without teardown', () => {
    const ctx = createFSM();
    ctx.fsm.connect();
    const ok = ctx.fsm.restartIce();
    expect(ok).toBe(true);
    expect(ctx.mockPc.restartIce).toHaveBeenCalled();
    expect(ctx.mockPc.close).not.toHaveBeenCalled();
  });

  it('both are safe no-ops (return false) with no live peer', () => {
    const ctx = createFSM(); // idle — no peer created yet
    expect(ctx.fsm.recreateDataChannel()).toBe(false);
    expect(ctx.fsm.restartIce()).toBe(false);
  });
});

describe('RTCPeer.recreateDataChannel', () => {
  function createPeer() {
    let mockPc: MockRTCPeerConnection;
    const peer = new RTCPeer({
      polite: true,
      config: DEFAULT_CONFIG,
      onSignal: vi.fn(),
      createPeerConnection: (config: RTCConfiguration) => {
        mockPc = new MockRTCPeerConnection(config);
        return mockPc as unknown as RTCPeerConnection;
      },
    });
    return { peer, get mockPc() { return mockPc!; } };
  }

  it('closes the stalled channel and opens a fresh one on the same connection', () => {
    const { peer, mockPc } = createPeer();
    const opens: string[] = [];
    peer.on('data-channel-state-change', (e: any) => opens.push(e.data));

    const firstDc = mockPc.createDataChannel.mock.results[0].value as MockRTCDataChannel;
    firstDc.simulateOpen();
    expect(opens.filter(s => s === 'open')).toHaveLength(1);

    peer.recreateDataChannel();

    expect(firstDc.close).toHaveBeenCalled();                  // old channel released
    expect(mockPc.createDataChannel).toHaveBeenCalledTimes(2); // fresh channel on same pc
    expect(mockPc.close).not.toHaveBeenCalled();               // transport untouched

    const secondDc = mockPc.createDataChannel.mock.results[1].value as MockRTCDataChannel;
    secondDc.simulateOpen();
    expect(opens.filter(s => s === 'open')).toHaveLength(2);    // replacement reports open
  });
});
