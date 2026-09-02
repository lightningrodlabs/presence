import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { get } from '@holochain-open-dev/stores';
import { encodeHashToBase64 } from '@holochain/client';
import type { AgentPubKey } from '@holochain/client';
import {
  StreamsStore,
  SDP_EXCHANGE_TIMEOUT,
  SDP_TIMEOUT_CEILING_MS,
  SDP_BACKSTOP_MULTIPLIER,
  SDP_BACKSTOP_RETRY_HEADROOM_MS,
} from '../streams-store';
import { ManualClock } from '../clock.testing';
import { makeFakeDeps, FakeLogger } from '../store-deps.testing';
import type { FakeDeps, FakeTransport } from '../store-deps.testing';
import {
  PING_INTERVAL,
  PRESENT_STALENESS_MS,
  SIGNAL_CARRIER_DOWN_MS,
  PRESENCE_CARRIER_HOLD_MAX_MS,
} from '../presence-policy';
import {
  SIGNALS_RTT_COLLAPSED_MS,
  SIGNALS_RTT_DEGRADED_MS,
} from '../transport/signals-cadence-policy';
import { CAP_VOICE_BATCH } from '../transport/wire-contract';
import { encodeRtcAction } from '../rtc-message-policy';
import {
  CAPTURE_REOPEN_MIN_INTERVAL_MS,
  CAPTURE_REOPEN_MAX_ATTEMPTS,
} from '../capture-reconcile-policy';
import { VOICE_BATCH_FRAMES } from '../room/modules/voice';
import { voiceController } from '../room/modules/voice';
import { filmstripController } from '../room/modules/video-filmstrip';
import type { RoomSignal, StoreEventPayload } from '../types';

/**
 * Phase 6 item 2 — the point of the phase: the wiring between the pure
 * decision functions and the world is executed here, in node, against
 * fake deps. Until this suite, the apply halves were verified nowhere —
 * the harness MIRRORS this glue (`decideSlotWrite` is shared code, but
 * the dispatch around it was modeled), and every production bug in the
 * assessment lived exactly in this layer:
 *
 *   transport event → routeTransportPhase → decideSlotWrite → actual
 *   slot mutation (both §3.1(c) causes), and present set →
 *   computeSignalsTargets → actual sendMessage traffic (§3.1(b)).
 *
 * The fake transport can do the nasty things the field does — vanish
 * with no event, replace an FSM in place, emit a duplicate `closed` —
 * and the negative controls below assert it really produced those
 * shapes, so the suite cannot go tautological (working agreement 3).
 */

const myPubKey = new Uint8Array(39).fill(1);
const myPubKeyB64 = encodeHashToBase64(myPubKey as unknown as AgentPubKey);
const peerAKey = new Uint8Array(39).fill(2) as AgentPubKey;
const peerA = encodeHashToBase64(peerAKey);
const peerBKey = new Uint8Array(39).fill(3) as AgentPubKey;
const peerB = encodeHashToBase64(peerBKey);
/** Alphabetically LOWER than `myPubKey` (fill(1)) — the initiator arm's
 *  ordering condition (`handlePongUi` only initiates toward a lower
 *  peer key; see the acceptor arm's `pubKey64 > this.myPubKeyB64` gate
 *  for the converse). Used by the D2 caps-race wiring test below, where
 *  the store itself must be the initiator. */
const peerLowerKey = new Uint8Array(39).fill(0) as AgentPubKey;
const peerLower = encodeHashToBase64(peerLowerKey);

type Started = FakeDeps & {
  store: StreamsStore;
  clock: ManualClock;
  logger: FakeLogger;
  events: StoreEventPayload[];
};

const live: StreamsStore[] = [];

/** Construct with fakes, start(), capture store events. */
function makeStarted(
  prepare?: (fakes: FakeDeps) => void
): Started {
  const clock = new ManualClock(1_000_000);
  const fakes = makeFakeDeps({ clock, myPubKey });
  prepare?.(fakes);
  const logger = new FakeLogger();
  const store = new StreamsStore(fakes.deps, async () => '', logger.asPresenceLogger());
  const events: StoreEventPayload[] = [];
  store.start();
  live.push(store);
  store.onEvent(ev => events.push(ev));
  return { ...fakes, clock, store, logger, events };
}

function knownFresh(clock: ManualClock, ...peers: string[]) {
  const entry = (p: string) => [
    p,
    { pubkey: p, type: 'known', lastSeen: clock.now(), appVersion: undefined },
  ];
  return Object.fromEntries(peers.map(entry));
}

function message(
  from: AgentPubKey,
  msgType: string,
  payload: string
): RoomSignal {
  return { type: 'Message', from_agent: from, msg_type: msgType, payload };
}

/** A PongUi from `from` echoing a pingT0 `rttMs` in the past — seeds
 *  `_signalsRttEwma` at the raw RTT on the first sample (`foldSignalsRtt`,
 *  first-sample-seeds-raw). Carries `moduleStatesAt` so it doesn't read
 *  as a legacy no-stamp pong (same shape as the Task 7 `pongEchoing`
 *  fixture in the cadence describe below). */
function pongEchoingRtt(
  from: AgentPubKey,
  clock: ManualClock,
  rttMs: number
): RoomSignal {
  return message(
    from,
    'PongUi',
    JSON.stringify({
      formatVersion: 1,
      data: {
        connectionStatuses: {},
        pingT0: clock.now() - rttMs,
        moduleStatesAt: 1,
      },
    })
  );
}

/** The `sdpExchangeTimeoutMs` the store's most recent `ensureConnection`
 *  call passed to the media transport — the FSM's own per-attempt SDP
 *  override, distinct from the store's tracked backstop timer (review
 *  C1). `FakeTransport.ensureCalls` types `opts` as `unknown`; this is
 *  the one place that narrows it back. */
function lastSdpOverride(media: FakeTransport): number | undefined {
  const calls = media.ensureCalls;
  const opts = calls[calls.length - 1]?.opts as
    | { sdpExchangeTimeoutMs?: number }
    | undefined;
  return opts?.sdpExchangeTimeoutMs;
}

afterEach(() => {
  // Unbind the module singletons even when a test fails mid-way; a bound
  // controller would leak the store (and its clock) into the next test.
  for (const store of live.splice(0)) {
    try {
      store.disconnect('wiring-test-cleanup');
    } catch {
      // disconnect() twice is not part of the contract; cleanup only.
    }
  }
});

describe('start() wiring', () => {
  it('creates the three transports through the factory and subscribes the bus once', () => {
    const { bus, transports } = makeStarted();
    expect(bus.subscriberCount).toBe(1);
    expect(Object.keys(transports).sort()).toEqual([
      'media',
      'screen-share-in',
      'screen-share-out',
    ]);
  });

  it('gives transports live storage closures but snapshots dtlsStallTimeoutMs (the declared knob-timing distinction)', () => {
    const { local, transports } = makeStarted(f => {
      f.local.setItem('dtlsStallTimeoutMs', '7777');
    });
    const options = transports.media!.options;
    // Snapshot: taken once, at transport construction.
    expect(options.configOverrides?.dtlsStallTimeoutMs).toBe(7777);
    // Live closures: a Settings edit is visible on the next read.
    const before = (options.iceServers as () => RTCIceServer[])();
    expect(before.some(s => String(s.urls).includes('turn:example.test'))).toBe(false);
    local.setItem('turnUrl', 'turn:example.test:3478');
    local.setItem('turnUsername', 'u');
    local.setItem('turnCredential', 'c');
    const after = (options.iceServers as () => RTCIceServer[])();
    expect(after.some(s => String(s.urls).includes('turn:example.test'))).toBe(true);
    expect((options.trickleICE as () => boolean)()).toBe(true);
    local.setItem('trickleICE', 'false');
    expect((options.trickleICE as () => boolean)()).toBe(false);
    // The snapshot did not move.
    expect(options.configOverrides?.dtlsStallTimeoutMs).toBe(7777);
  });

  it('start() reads blockedAgents from session storage and the kill switch from local storage', () => {
    const { store } = makeStarted(f => {
      f.session.setItem('blockedAgents', JSON.stringify([peerB]));
      f.local.setItem('disableAllWebrtc', 'true');
    });
    expect(get(store.blockedAgents)).toEqual([peerB]);
    expect(store.webrtcGloballyDisabled).toBe(true);
  });
});

describe('incoming wire → transport routing (real handleSignal glue)', () => {
  it('answers PingUi with a PongUi to the sender, echoing t0', async () => {
    const { bus } = makeStarted();
    await bus.deliver(message(peerAKey, 'PingUi', JSON.stringify({ t0: 424242 })));
    const pongs = bus.sentOfType('PongUi');
    expect(pongs).toHaveLength(1);
    expect(pongs[0].to).toEqual([peerA]);
    const meta = JSON.parse(pongs[0].payload!);
    expect(meta.data.pingT0).toBe(424242);
  });

  it('routes SdpFsm into the media transport', async () => {
    const { bus, transports } = makeStarted();
    await bus.deliver(
      message(
        peerAKey,
        'SdpFsm',
        JSON.stringify({
          connection_id: 'remote-conn-1',
          peer_session_id: 4,
          epoch: 2,
          data: { type: 'offer', payload: { sdp: 'x' } },
        })
      )
    );
    const processed = transports.media!.processedSignals;
    expect(processed).toHaveLength(1);
    expect(processed[0]).toMatchObject({
      from: peerA,
      connectionId: 'remote-conn-1',
      peerSessionId: 4,
      epoch: 2,
    });
    expect(transports['screen-share-in']!.processedSignals).toHaveLength(0);
    expect(transports['screen-share-out']!.processedSignals).toHaveLength(0);
  });

  it("routes SdpFsmScreen by the sender's declared role and drops malformed dir", async () => {
    const { bus, transports, logger } = makeStarted();
    const screen = (dir: unknown) =>
      message(
        peerAKey,
        'SdpFsmScreen',
        JSON.stringify({
          connection_id: 'sc-1',
          dir,
          data: { type: 'offer', payload: {} },
        })
      );
    // Their sharer side talks to our incoming-share transport…
    await bus.deliver(screen('sharer'));
    expect(transports['screen-share-in']!.processedSignals).toHaveLength(1);
    // …their viewer side answers our outgoing share…
    await bus.deliver(screen('viewer'));
    expect(transports['screen-share-out']!.processedSignals).toHaveLength(1);
    // …and an unknown dir is dropped, touching no transport.
    await bus.deliver(screen('sideways'));
    expect(transports['screen-share-in']!.processedSignals).toHaveLength(1);
    expect(transports['screen-share-out']!.processedSignals).toHaveLength(1);
    expect(transports.media!.processedSignals).toHaveLength(0);
    expect(
      logger.customMessages.some(m => m.startsWith('Dropped SdpFsmScreen'))
    ).toBe(true);
  });
});

describe('outgoing transport signal → wire envelope', () => {
  it('wraps media FSM signals as SdpFsm with the wire field names', () => {
    const { bus, transports } = makeStarted();
    transports.media!.options.onOutgoingSignal({
      to: peerA,
      connectionId: 'c-out',
      peerSessionId: 7,
      epoch: 3,
      data: { type: 'offer', payload: { sdp: 'y' } },
    });
    const sent = bus.sentOfType('SdpFsm');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([peerA]);
    expect(JSON.parse(sent[0].payload!)).toEqual({
      connection_id: 'c-out',
      peer_session_id: 7,
      epoch: 3,
      data: { type: 'offer', payload: { sdp: 'y' } },
    });
  });

  it('stamps SdpFsmScreen with this side\'s role', () => {
    const { bus, transports } = makeStarted();
    const signal = {
      to: peerA,
      connectionId: 's-out',
      data: {},
    };
    transports['screen-share-out']!.options.onOutgoingSignal(signal);
    transports['screen-share-in']!.options.onOutgoingSignal(signal);
    const sent = bus.sentOfType('SdpFsmScreen');
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0].payload!).dir).toBe('sharer');
    expect(JSON.parse(sent[1].payload!).dir).toBe('viewer');
  });
});

describe('slot lifecycle applied from transport events (the exit criterion)', () => {
  it('install → connected → in-place FSM replacement (no close event) → failed → trailing duplicate closed', () => {
    const { store, transports, logger, events } = makeStarted();
    const media = transports.media!;

    // signaling installs the slot, not yet connected.
    media.emitPhase(peerA, 'conn-1', 'signaling');
    let slot = get(store._openConnections)[peerA];
    expect(slot).toBeDefined();
    expect(slot.connectionId).toBe('conn-1');
    expect(slot.connected).toBe(false);

    // connected flips the slot and reaches consumers.
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    slot = get(store._openConnections)[peerA];
    expect(slot.connected).toBe(true);
    expect(logger.eventsNamed('Connected')).toHaveLength(1);
    expect(events.some(e => e.type === 'peer-connected')).toBe(true);

    // Transport-owned recovery phases must NOT clear the slot (the
    // documented bounded exception to the carrier invariant).
    media.emitPhase(peerA, 'conn-1', 'reconnecting', 'connected');
    expect(get(store._openConnections)[peerA].connected).toBe(true);

    // The §3.1(c) route: ConnectionManager replaced the FSM in place —
    // fsm.destroy() emits no transition, so the first sign of life is
    // `signaling` under a NEW connectionId. The slot must adopt it.
    media.emitPhase(peerA, 'conn-2', 'signaling');
    slot = get(store._openConnections)[peerA];
    expect(slot.connectionId).toBe('conn-2');
    expect(slot.connected).toBe(false);
    expect(logger.eventsNamed('Superseded')).toHaveLength(1);
    // Negative control: the fake really produced the nasty shape — no
    // closed/failed ever reached us for conn-1.
    expect(
      media.emitted.filter(
        e =>
          e.type === 'connection-state-change' &&
          e.connectionId === 'conn-1' &&
          (e.phase === 'closed' || e.phase === 'failed')
      )
    ).toHaveLength(0);

    // failed clears the slot…
    media.emitPhase(peerA, 'conn-2', 'failed', 'signaling');
    expect(get(store._openConnections)[peerA]).toBeUndefined();
    expect(logger.eventsNamed('FsmClose')).toHaveLength(1);
    const disconnects = events.filter(e => e.type === 'peer-disconnected');

    // …and the trailing duplicate closed (field-real, pinned by the
    // harness) is absorbed: no throw, no second FsmClose, no re-fired
    // peer-disconnected.
    media.emitPhase(peerA, 'conn-2', 'closed', 'failed');
    expect(get(store._openConnections)[peerA]).toBeUndefined();
    expect(logger.eventsNamed('FsmClose')).toHaveLength(1);
    expect(events.filter(e => e.type === 'peer-disconnected')).toEqual(disconnects);
    // Negative control: both terminal events for conn-2 really fired.
    expect(
      media.emitted.filter(
        e =>
          e.type === 'connection-state-change' &&
          e.connectionId === 'conn-2' &&
          (e.phase === 'failed' || e.phase === 'closed')
      )
    ).toHaveLength(2);
  });

  it('screen-share (sharer side): install → connected → adopt-on-replacement → stale events guarded → failed clears (review F1)', () => {
    const { store, transports, logger } = makeStarted();
    const out = transports['screen-share-out']!;

    // signaling installs the outgoing slot, not yet connected.
    out.emitPhase(peerA, 'ss-1', 'signaling');
    let slot = get(store._screenShareConnectionsOutgoing)[peerA];
    expect(slot).toMatchObject({
      connectionId: 'ss-1',
      connected: false,
      direction: 'outgoing',
      video: true,
    });

    // connected flips the flag through _handleScreenShareConnected.
    out.emitPhase(peerA, 'ss-1', 'connected', 'connecting');
    expect(get(store._screenShareConnectionsOutgoing)[peerA].connected).toBe(true);

    // In-place FSM replacement (sharer re-initiated at a higher epoch —
    // the Phase 3.5 field-real route): signaling under a NEW id, no
    // close for the old one. The slot must adopt.
    out.emitPhase(peerA, 'ss-2', 'signaling');
    slot = get(store._screenShareConnectionsOutgoing)[peerA];
    expect(slot.connectionId).toBe('ss-2');
    expect(slot.connected).toBe(false);
    const superseded = logger.eventsNamed('Superseded');
    expect(superseded).toHaveLength(1);
    expect(superseded[0].detail).toContain('screen-transport-replace');
    // Negative control: no closed/failed ever fired for ss-1.
    expect(
      out.emitted.filter(
        e =>
          e.type === 'connection-state-change' &&
          e.connectionId === 'ss-1' &&
          (e.phase === 'closed' || e.phase === 'failed')
      )
    ).toHaveLength(0);

    // Stale events from the replaced connection must not mutate the new
    // slot: a late connected may not flip the flag, a late closed may
    // not clear it (both supersede guards in the screen apply half).
    out.emitPhase(peerA, 'ss-1', 'connected', 'connecting');
    slot = get(store._screenShareConnectionsOutgoing)[peerA];
    expect(slot.connectionId).toBe('ss-2');
    expect(slot.connected).toBe(false);
    out.emitPhase(peerA, 'ss-1', 'closed', 'connected');
    expect(get(store._screenShareConnectionsOutgoing)[peerA]).toBeDefined();

    // failed clears the live slot; the trailing duplicate closed is a
    // no-op (same idempotency contract as the media path).
    out.emitPhase(peerA, 'ss-2', 'failed', 'signaling');
    expect(get(store._screenShareConnectionsOutgoing)[peerA]).toBeUndefined();
    out.emitPhase(peerA, 'ss-2', 'closed', 'failed');
    expect(get(store._screenShareConnectionsOutgoing)[peerA]).toBeUndefined();
  });

  it('screen-share (viewer side): install → connected fires the event → remote stream wires _screenShareStreams → failed clears both (review F1)', () => {
    const { store, transports, events } = makeStarted();
    const inc = transports['screen-share-in']!;

    inc.emitPhase(peerA, 'sv-1', 'signaling');
    expect(get(store._screenShareConnectionsIncoming)[peerA]).toMatchObject({
      connectionId: 'sv-1',
      connected: false,
      direction: 'incoming',
      video: false,
    });

    inc.emitPhase(peerA, 'sv-1', 'connected', 'connecting');
    expect(get(store._screenShareConnectionsIncoming)[peerA].connected).toBe(true);
    expect(events.some(e => e.type === 'peer-screen-share-connected')).toBe(true);

    // The viewer's stream mirror (`_screenShareStreams`, the unscheduled
    // -table row Phase 3 wired) is set on remote-stream…
    const fakeStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
      getVideoTracks: () => [{}],
    } as unknown as MediaStream;
    inc.emit({
      type: 'remote-stream',
      peer: peerA,
      connectionId: 'sv-1',
      stream: fakeStream,
    });
    expect(store._screenShareStreams[peerA]).toBe(fakeStream);
    expect(get(store._screenShareConnectionsIncoming)[peerA].video).toBe(true);

    // …and dies with the connection, so paint-restore cannot resurrect
    // a dead share.
    inc.emitPhase(peerA, 'sv-1', 'failed', 'connected');
    expect(get(store._screenShareConnectionsIncoming)[peerA]).toBeUndefined();
    expect(store._screenShareStreams[peerA]).toBeUndefined();
    expect(events.some(e => e.type === 'peer-screen-share-disconnected')).toBe(true);
  });

  it('a vanished connection (no event at all) keeps its slot — never assume you will be told', () => {
    const { store, clock, transports } = makeStarted();
    const media = transports.media!;
    store._knownAgents.set(knownFresh(clock, peerA));
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    const emittedBefore = media.emitted.length;

    media.vanish(peerA);

    // Negative control: vanish really emitted nothing.
    expect(media.emitted.length).toBe(emittedBefore);
    // The slot still claims connected — clearing a wedged slot depends
    // entirely on the FSM emitting `failed`. This is the documented
    // bounded exception, pinned so a change here is a decision, not an
    // accident.
    expect(get(store._openConnections)[peerA].connected).toBe(true);
  });

  it('slot writes from real events drive the signals send set (§3.1(b) wiring)', () => {
    const { store, clock, transports } = makeStarted();
    const media = transports.media!;
    store._knownAgents.set(knownFresh(clock, peerA));
    expect(get(store._signalsTargets)).toEqual(new Set([peerA]));

    // WebRTC comes up: the signals carrier stands down for this peer.
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    expect(get(store._signalsTargets)).toEqual(new Set());
    expect(get(store._presentPeers)).toContain(peerA);

    // WebRTC dies: signals resumes covering the (still-present) peer.
    media.emitPhase(peerA, 'conn-1', 'failed', 'connected');
    expect(get(store._signalsTargets)).toEqual(new Set([peerA]));
  });
});

describe('the error path is forensic-only (Round 3 item 1 as amended by review F2)', () => {
  it('THE LOG-ONLY PIN: a media error logs FsmError with the root-cause text and mutates NOTHING', () => {
    const { store, clock, transports, logger, events } = makeStarted();
    const media = transports.media!;

    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    store._pendingInits[peerA] = [{ connectionId: 'conn-1', t0: clock.now() }];
    store._iceDisconnectedAt[peerA] = clock.now() - 1000;

    media.emit({
      type: 'error',
      peer: peerA,
      connectionId: 'conn-1',
      error: new Error('setRemoteDescription failed: InvalidStateError'),
    });

    // The forensic landed, carrying the exception text that used to be
    // dropped at the ConnectionManager boundary.
    const errors = logger.eventsNamed('FsmError');
    expect(errors).toHaveLength(1);
    expect(errors[0].detail).toContain('InvalidStateError');

    // …and NOTHING else moved: errors are symptoms; the FSM owns
    // recovery and the failed/closed phases own teardown.
    expect(get(store._openConnections)[peerA]).toMatchObject({
      connectionId: 'conn-1',
      connected: true,
    });
    expect(media.closeCalls).toHaveLength(0);
    expect(store._pendingInits[peerA]).toHaveLength(1);
    expect(store._iceDisconnectedAt[peerA]).toBeDefined();
    expect(store._lastDisconnectTime[peerA]).toBeUndefined();
    expect(events.filter(e => e.type === 'peer-disconnected')).toHaveLength(0);
    expect(
      logger
        .eventsNamed('CarrierSwitch')
        .filter(e => e.detail?.startsWith('webrtc->signals')),
    ).toHaveLength(0);

    // A later error for the same connection is another forensic entry,
    // still write-free.
    media.emit({
      type: 'error',
      peer: peerA,
      connectionId: 'conn-1',
      error: new Error('again'),
    });
    expect(logger.eventsNamed('FsmError')).toHaveLength(2);
    expect(get(store._openConnections)[peerA]).toBeDefined();
  });

  it('THE FORENSIC-SURVIVAL PIN: an error before establishment must not preempt IceNeverConnected on the eventual phase close', () => {
    const { store, transports, logger } = makeStarted();
    const media = transports.media!;

    // signaling stakes the establishment-timing record (t0).
    media.emitPhase(peerA, 'conn-1', 'signaling');
    // A negotiation exception mid-handshake: log-only, so the timing
    // record must survive it (review F1's hazard — the first cut's
    // error teardown wiped it via a nested close before emitting).
    media.emit({
      type: 'error',
      peer: peerA,
      connectionId: 'conn-1',
      error: new Error('negotiation exploded'),
    });
    // The FSM gives up: the phase close row emits the failure-side
    // latency forensic exactly once.
    media.emitPhase(peerA, 'conn-1', 'failed', 'signaling');
    expect(logger.eventsNamed('IceNeverConnected')).toHaveLength(1);
    expect(get(store._openConnections)[peerA]).toBeUndefined();
  });

  it('a stale error from a replaced FSM is attributed as SupersededError and cannot touch the adopted connection', () => {
    const { store, transports, logger } = makeStarted();
    const media = transports.media!;

    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    // In-place replacement: signaling under a new id, no close for conn-1.
    media.emitPhase(peerA, 'conn-2', 'signaling');

    media.emit({
      type: 'error',
      peer: peerA,
      connectionId: 'conn-1',
      error: new Error('stale'),
    });

    expect(get(store._openConnections)[peerA]).toMatchObject({
      connectionId: 'conn-2',
    });
    expect(logger.eventsNamed('SupersededError')).toHaveLength(1);
    expect(logger.eventsNamed('FsmError')).toHaveLength(0);
    expect(media.closeCalls).toHaveLength(0);
  });

  it('screen-share errors are log-only too: no slot change, no view event, teardown arrives with the phase', () => {
    const { store, transports, logger, events } = makeStarted();
    const inc = transports['screen-share-in']!;

    inc.emitPhase(peerA, 'sv-1', 'signaling');
    inc.emitPhase(peerA, 'sv-1', 'connected', 'connecting');
    inc.emit({
      type: 'error',
      peer: peerA,
      connectionId: 'sv-1',
      error: new Error('screen boom'),
    });

    // Logged with the screen attribution; the share survives the symptom.
    expect(
      logger.eventsNamed('FsmError').filter(e => e.detail?.includes('path=screen')),
    ).toHaveLength(1);
    expect(get(store._screenShareConnectionsIncoming)[peerA]).toBeDefined();
    expect(
      events.filter(e => e.type === 'peer-screen-share-disconnected'),
    ).toHaveLength(0);

    // The verdict is the phase: failed clears the slot and fires the
    // view event exactly once.
    inc.emitPhase(peerA, 'sv-1', 'failed', 'connected');
    expect(get(store._screenShareConnectionsIncoming)[peerA]).toBeUndefined();
    expect(
      events.filter(e => e.type === 'peer-screen-share-disconnected'),
    ).toHaveLength(1);
  });
});

describe('screen-share track-ended watch (Task 2): the display-capture gesture-equivalent', () => {
  /** A display-capture track ending is a user/platform action (the
   *  browser's native "Stop sharing" bar, the OS revoking capture) — there
   *  is no picker-less way to re-acquire it, so `ended` here is the ONE
   *  documented gesture-equivalent (intent.ts, IntentGesture). This pins
   *  that `screenShareOn` wires `track.onended` to write intent AND tear
   *  the share down, closing what was previously a real gap: before this
   *  task, stopping a share from outside the app UI left the pane open. */
  class FakeScreenTrack {
    readyState: 'live' | 'ended' = 'live';

    onended: (() => void) | null = null;

    stop(): void {
      if (this.readyState === 'ended') return;
      this.readyState = 'ended';
      this.onended?.();
    }
  }

  class FakeScreenStream {
    constructor(private tracks: FakeScreenTrack[]) {}

    getTracks(): FakeScreenTrack[] {
      return this.tracks;
    }

    getVideoTracks(): FakeScreenTrack[] {
      return this.tracks;
    }

    getAudioTracks(): FakeScreenTrack[] {
      return [];
    }
  }

  const flush = () => new Promise<void>(r => setTimeout(r, 0));

  afterEach(() => {
    delete (globalThis as any).navigator;
  });

  it('ending the display track tears the share down and clears screenShare intent', async () => {
    const track = new FakeScreenTrack();
    // node 22 (0.7 devshell) makes `navigator` a getter-only global — a
    // plain assignment throws; defineProperty replaces it and the
    // afterEach `delete` still works (configurable).
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => new FakeScreenStream([track]),
        },
      },
      configurable: true,
      writable: true,
    });
    const { store, events } = makeStarted();

    await store.screenShareOn();

    // Sanity: the share is actually up before we end it, so the
    // assertions below prove teardown rather than a no-op.
    expect(get(store._myModuleStates)['screen-share']?.active).toBe(true);
    expect(get(store.localIntent).screenShare.wanted).toBe(true);

    track.stop(); // the platform/browser ends the share, not the app
    await flush();
    await flush();

    expect(get(store._myModuleStates)['screen-share']).toBeUndefined();
    expect(get(store.localIntent).screenShare.wanted).toBe(false);
    expect(events.some(e => e.type === 'my-screen-share-off')).toBe(true);
  });
});

describe('acceptor eligibility through the started store (Round 3 item 2)', () => {
  const conversationEnvelope = (clock: ManualClock, payload: object) => ({
    moduleId: 'conversation',
    active: true,
    payload: JSON.stringify(payload),
    updatedAt: clock.now(),
  });

  it('an inactive conversation module ignores inbound video InitRequests; activating it answers (the declared symmetry change)', async () => {
    const { store, clock, bus, logger } = makeStarted();
    // The peer (alphabetically higher than us — the acceptor arm's
    // ordering condition) declares the sdp-fsm capability.
    store._peerModuleStates.set({
      [peerA]: {
        conversation: conversationEnvelope(clock, { caps: ['sdp-fsm'] }),
      },
    });

    // Our conversation module is inactive: the acceptor now refuses,
    // where the pre-predicate code would have sent InitAccept.
    await bus.deliver(
      message(
        peerAKey,
        'InitRequest',
        JSON.stringify({ connection_id: 'ir-1', connection_type: 'video' })
      )
    );
    expect(bus.sentOfType('InitAccept')).toHaveLength(0);
    expect(
      logger.customMessages.some(m => m.includes('conversation module inactive'))
    ).toBe(true);

    // Activate the module: the same request is now answered.
    store._myModuleStates.set({
      conversation: conversationEnvelope(clock, {}),
    });
    await bus.deliver(
      message(
        peerAKey,
        'InitRequest',
        JSON.stringify({ connection_id: 'ir-2', connection_type: 'video' })
      )
    );
    const accepts = bus.sentOfType('InitAccept');
    expect(accepts).toHaveLength(1);
    expect(accepts[0].to).toEqual([peerA]);
  });

  it('a peer without the sdp-fsm capability is refused even with the conversation module active', async () => {
    const { store, clock, bus, logger } = makeStarted();
    store._myModuleStates.set({
      conversation: conversationEnvelope(clock, {}),
    });
    // Declared empty caps — "baseline only", which excludes sdp-fsm.
    store._peerModuleStates.set({
      [peerA]: { conversation: conversationEnvelope(clock, { caps: [] }) },
    });
    await bus.deliver(
      message(
        peerAKey,
        'InitRequest',
        JSON.stringify({ connection_id: 'ir-3', connection_type: 'video' })
      )
    );
    expect(bus.sentOfType('InitAccept')).toHaveLength(0);
    expect(
      logger.customMessages.some(m => m.includes('lacks sdp-fsm capability'))
    ).toBe(true);
  });
});

describe('caps-unknown vs lacks-cap — the D2 join-race fix (Task 4)', () => {
  const conversationEnvelope = (clock: ManualClock, payload: object) => ({
    moduleId: 'conversation',
    active: true,
    payload: JSON.stringify(payload),
    updatedAt: clock.now(),
  });

  // `moduleStatesAt` is required for a non-legacy pong: without it, an
  // empty `moduleStates` reads as "legacy pong, no stamp" and
  // unconditionally sweeps every held peer module entry
  // (`decideModuleStateMerge`'s `legacy-pong-unconditional-sweep` row) —
  // which would delete the very conversation entry the ModuleState push
  // just set. A same-build peer's pong always carries this stamp.
  const bareSignalsPong = (clock: ManualClock) =>
    JSON.stringify({
      formatVersion: 1,
      data: { connectionStatuses: {}, moduleStatesAt: clock.now() },
    });

  it('acceptor: an InitRequest from a peer whose conversation payload has not arrived is dropped with a distinct "caps not yet received" log, never "lacks sdp-fsm capability"', async () => {
    const { store, clock, bus, logger } = makeStarted();
    store._myModuleStates.set({
      conversation: conversationEnvelope(clock, {}),
    });
    // No entry at all for peerA in _peerModuleStates — their conversation
    // payload (and therefore their declared caps) has not arrived yet.
    // This is the D2 shape: distinct from the "declared empty caps"
    // scenario above, which IS a known, capability-less peer.
    expect(get(store._peerModuleStates)[peerA]).toBeUndefined();

    await bus.deliver(
      message(
        peerAKey,
        'InitRequest',
        JSON.stringify({ connection_id: 'ir-caps-unknown', connection_type: 'video' })
      )
    );

    expect(bus.sentOfType('InitAccept')).toHaveLength(0);
    expect(
      logger.customMessages.some(m => m.includes('caps not yet received'))
    ).toBe(true);
    expect(
      logger.customMessages.some(m => m.includes('lacks sdp-fsm capability'))
    ).toBe(false);
  });

  it('initiator: the join-race end to end — no InitRequest while the peer\'s payload is unknown, and the very next pong after it lands drives the init with no parking machinery needed', async () => {
    const { store, clock, bus } = makeStarted();
    store._myModuleStates.set({
      conversation: conversationEnvelope(clock, {}),
    });

    // Peer pongs immediately after joining — their conversation payload
    // (and caps) has not arrived yet. Pre-fix, `webrtcAvailableFor`
    // reported no caps here and `decideWebrtcEligibility` returned
    // `peer-lacks-sdp-fsm-cap`, indistinguishable from a genuinely old
    // build — dropping this join's first InitRequest.
    await bus.deliver(message(peerLowerKey, 'PongUi', bareSignalsPong(clock)));
    expect(bus.sentOfType('InitRequest')).toHaveLength(0);

    // The payload lands (a real 'ModuleState' push, exercising the same
    // wiring a late module-state broadcast uses).
    await bus.deliver(
      message(
        peerLowerKey,
        'ModuleState',
        JSON.stringify(conversationEnvelope(clock, { caps: ['sdp-fsm'] }))
      )
    );
    expect(bus.sentOfType('InitRequest')).toHaveLength(0);

    // No parking/re-drive trigger is needed: the initiator drive is
    // already level-triggered per pong (`decideInitRetry`), so the very
    // next pong re-evaluates eligibility with caps now known and drives
    // the init on its own.
    await bus.deliver(message(peerLowerKey, 'PongUi', bareSignalsPong(clock)));
    const inits = bus.sentOfType('InitRequest');
    expect(inits).toHaveLength(1);
    expect(inits[0].to).toEqual([peerLower]);
  });
});

describe('per-peer WebRTC disable is a union of our intent and the peer\'s broadcast (Task 4 review finding B)', () => {
  const conversationEnvelope = (clock: ManualClock, payload: object) => ({
    moduleId: 'conversation',
    active: true,
    payload: JSON.stringify(payload),
    updatedAt: clock.now(),
  });

  const bareSignalsPong = (clock: ManualClock) =>
    JSON.stringify({
      formatVersion: 1,
      data: { connectionStatuses: {}, moduleStatesAt: clock.now() },
    });

  it('a peer who has broadcast a per-peer disable-with-us is never sent an InitRequest, even though our own intent never disabled them', async () => {
    const { store, clock, bus } = makeStarted();
    store._myModuleStates.set({
      conversation: conversationEnvelope(clock, {}),
    });
    // The peer (lower key — we are the key-designated initiator) declares
    // sdp-fsm capability AND has disabled WebRTC specifically with us on
    // their end. Our own intent never touched `disabledWith` for this
    // peer — `_localIntent.webrtc.disabledWith` is empty throughout this
    // test. If the eligibility conjunct only read our own intent (the
    // bug this test catches), we would wrongly attempt to initiate every
    // pong cycle, and the peer would silently refuse each one (their own
    // eligibility check, evaluated with their own intent) — continuous
    // one-sided churn.
    store._peerModuleStates.set({
      [peerLower]: {
        conversation: conversationEnvelope(clock, {
          caps: ['sdp-fsm'],
          disableWebrtcWith: [myPubKeyB64],
        }),
      },
    });
    expect(get(store._localIntent).webrtc.disabledWith.has(peerLower)).toBe(false);

    await bus.deliver(message(peerLowerKey, 'PongUi', bareSignalsPong(clock)));
    await bus.deliver(message(peerLowerKey, 'PongUi', bareSignalsPong(clock)));

    expect(bus.sentOfType('InitRequest')).toHaveLength(0);
    // The union is honored in both directions: webrtcDisabled itself
    // reports the link disabled, sourced from the peer's broadcast half.
    expect(store.webrtcDisabled(peerLower)).toBe(true);
  });

  it('a peer who has broadcast a GLOBAL webrtc disable is never sent an InitRequest', async () => {
    const { store, clock, bus } = makeStarted();
    store._myModuleStates.set({
      conversation: conversationEnvelope(clock, {}),
    });
    store._peerModuleStates.set({
      [peerLower]: {
        conversation: conversationEnvelope(clock, {
          caps: ['sdp-fsm'],
          webrtcDisabled: true,
        }),
      },
    });

    await bus.deliver(message(peerLowerKey, 'PongUi', bareSignalsPong(clock)));
    await bus.deliver(message(peerLowerKey, 'PongUi', bareSignalsPong(clock)));

    expect(bus.sentOfType('InitRequest')).toHaveLength(0);
    expect(store.webrtcDisabled(peerLower)).toBe(true);
  });
});

describe("setCarrierMode teardown — regression pin for the previous/_applyIntent ordering bug (Task 4 review finding A)", () => {
  it('switching to signals tears down an open WebRTC connection', async () => {
    const { store, transports } = makeStarted();
    const media = transports.media!;

    // Get a connected slot up via the real transport-event routing —
    // `setCarrierMode` must find it in `_openConnections` for the
    // teardown branch to do anything observable.
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'signaling');
    expect(get(store._openConnections)[peerA]?.connected).toBe(true);

    // `carrierMode()` starts at 'webrtc' (default), so this actually
    // flips the mode and must run the teardown branch, not the
    // previous-equals-mode early return. `setCarrierMode` read
    // `previous = this.carrierMode()` AFTER calling `_applyIntent` at one
    // point in development; since `carrierMode()` now reads the
    // `webrtcGloballyDisabled` getter (sourced from `_localIntent`, the
    // same record `_applyIntent` had just updated), `previous` came back
    // already equal to `mode` and the teardown below never ran. This test
    // is the regression pin for that ordering bug — see the fix report
    // for the RED-under-bad-ordering / GREEN-under-the-fix reproduction.
    await store.setCarrierMode('signals');

    expect(
      media.closeCalls.some(
        c => c.peer === peerA && c.reason === 'disconnectFromPeerVideo'
      )
    ).toBe(true);
    expect(get(store._openConnections)[peerA]).toBeUndefined();
    expect(store.webrtcGloballyDisabled).toBe(true);
  });
});

describe('module-state merge through the started store (Round 3 item 3)', () => {
  const envelopeOf = (
    moduleId: string,
    updatedAt: number,
    active = true,
    payload = '{}'
  ) => ({ moduleId, active, payload, updatedAt });

  const pongPayload = (
    moduleStates: Record<string, unknown> | undefined,
    moduleStatesAt: number | undefined
  ) =>
    JSON.stringify({
      formatVersion: 1,
      data: { connectionStatuses: {}, moduleStates, moduleStatesAt },
    });

  it('push-then-stale-pong keeps the module (the flicker interleave); a genuinely newer pong sweeps it', async () => {
    const { store, bus } = makeStarted();

    // Peer activates 'clock' at t=2000 (their clock) and pushes.
    await bus.deliver(
      message(peerAKey, 'ModuleState', JSON.stringify(envelopeOf('clock', 2000)))
    );
    expect(get(store._peerModuleStates)[peerA]?.clock).toBeDefined();

    // An in-flight pong serialized at t=1500 — before the activation —
    // carries no module states. Pre-policy, this deleted the module and
    // it flickered back ~2s later. It must survive.
    await bus.deliver(message(peerAKey, 'PongUi', pongPayload(undefined, 1500)));
    expect(get(store._peerModuleStates)[peerA]?.clock).toBeDefined();

    // A pong serialized after the entry's stamp is genuine deactivation
    // evidence and sweeps it.
    await bus.deliver(message(peerAKey, 'PongUi', pongPayload(undefined, 2500)));
    expect(get(store._peerModuleStates)[peerA]?.clock).toBeUndefined();
  });

  it('a stale push loses to a newer held entry, in the real handleSignal glue (declared change)', async () => {
    const { store, bus } = makeStarted();
    await bus.deliver(
      message(
        peerAKey,
        'ModuleState',
        JSON.stringify(envelopeOf('clock', 3000, true, '{"v":"newer"}'))
      )
    );
    await bus.deliver(
      message(
        peerAKey,
        'ModuleState',
        JSON.stringify(envelopeOf('clock', 2500, true, '{"v":"stale"}'))
      )
    );
    expect(get(store._peerModuleStates)[peerA]?.clock?.payload).toBe('{"v":"newer"}');
  });

  it('a pong entry stamped newer than the held entry replaces it; a stale pong entry does not', async () => {
    const { store, bus } = makeStarted();
    await bus.deliver(
      message(
        peerAKey,
        'ModuleState',
        JSON.stringify(envelopeOf('clock', 2000, true, '{"v":"pushed"}'))
      )
    );
    // Stale pong entry (t=1500) loses.
    await bus.deliver(
      message(
        peerAKey,
        'PongUi',
        pongPayload({ clock: envelopeOf('clock', 1500, true, '{"v":"old"}') }, 1500)
      )
    );
    expect(get(store._peerModuleStates)[peerA]?.clock?.payload).toBe('{"v":"pushed"}');
    // Newer pong entry (t=2600) wins.
    await bus.deliver(
      message(
        peerAKey,
        'PongUi',
        pongPayload({ clock: envelopeOf('clock', 2600, true, '{"v":"healed"}') }, 2600)
      )
    );
    expect(get(store._peerModuleStates)[peerA]?.clock?.payload).toBe('{"v":"healed"}');
  });
});

describe('the manual clock drives the ambient cadences through start()', () => {
  it('the presence tick armed by start() evicts a stale peer with no store write', () => {
    const { store, clock } = makeStarted();
    store._knownAgents.set(knownFresh(clock, peerA));
    const seen: string[][] = [];
    const unsub = store._activeAgents.subscribe(v => seen.push(Object.keys(v)));
    expect(seen[seen.length - 1]).toEqual([peerA]);
    // No writes; only time. The interval from start() must re-evaluate.
    clock.advance(PRESENT_STALENESS_MS + PING_INTERVAL);
    expect(seen[seen.length - 1]).toEqual([]);
    unsub();
  });

  it('pingAgents stamps t0 from the store clock and sweeps pending inits after PENDING_HANDSHAKE_TTL_MS', async () => {
    const { store, clock, bus } = makeStarted();
    store._knownAgents.set(knownFresh(clock, peerA));
    store._pendingInits = {
      [peerA]: [{ connectionId: 'stale-init', t0: clock.now() }],
    };

    await store.pingAgents();
    const pings = bus.sentOfType('PingUi');
    expect(pings).toHaveLength(1);
    expect(JSON.parse(pings[0].payload!).t0).toBe(clock.now());
    // Inside the TTL: the reservation survives.
    expect(store._pendingInits[peerA]).toHaveLength(1);

    clock.advance(20_001);
    await store.pingAgents();
    // Past the TTL: swept by the pure prune through the real call site.
    expect(store._pendingInits[peerA]).toBeUndefined();
  });

  it('holds a peer through a signal-carrier outage, then drops it past PRESENCE_CARRIER_HOLD_MAX_MS, with no peer-left-presence during the hold (Task 8)', async () => {
    const { store, clock, events } = makeStarted();
    store._knownAgents.set(knownFresh(clock, peerA));
    await store.pingAgents();
    expect(get(store._presentPeers)).toEqual([peerA]);

    // Silent ticks: no PongUi delivered, so lastSeen never refreshes.
    // By SIGNAL_CARRIER_DOWN_MS (== PRESENT_STALENESS_MS) the carrier
    // flips down in the same breath peerA's own ping-freshness expires
    // (both windows are 3 ticks by design — the exact scenario this
    // task exists for). A couple more silent ticks confirm the hold
    // keeps applying, not just surviving the one boundary tick.
    for (let i = 0; i < 5; i++) {
      clock.advance(PING_INTERVAL);
      await store.pingAgents();
    }
    expect(store.signalsCadence()).toEqual({
      mode: 'paused',
      reason: 'carrier-down',
    });
    // Held, not evidenced: activeAgents/openConnections/media all say
    // absent, yet the peer is still present because the carrier — not
    // the peer — is what went quiet.
    expect(get(store._presentPeers)).toEqual([peerA]);
    expect(events.some(e => e.type === 'peer-left-presence')).toBe(false);

    // Past the cap: absence wins even though the carrier is still down.
    clock.advance(PRESENCE_CARRIER_HOLD_MAX_MS);
    expect(get(store._presentPeers)).toEqual([]);
    expect(events.some(e => e.type === 'peer-left-presence')).toBe(true);
  });

  it('holds through a mid-cycle crossing where pingAgents() is the FIRST evaluator to see it (review C1)', async () => {
    const { store, clock } = makeStarted();

    // Stamp lastSeen 500ms into the cycle, off the presence-tick's own
    // 2000ms phase, so the staleness/carrier-down crossing (lastSeen +
    // 6000 = +6500) falls strictly BETWEEN two ticks (+6000 and +8000)
    // instead of landing exactly on one — pingAgents(), not the tick
    // interval, is then the first evaluator to observe it.
    clock.advance(500);
    store._knownAgents.set(knownFresh(clock, peerA));
    await store.pingAgents();

    // Three pre-crossing ticks: still ping-fresh throughout.
    clock.advance(1500); // -> +2000
    clock.advance(2000); // -> +4000
    clock.advance(2000); // -> +6000
    expect(get(store._presentPeers)).toEqual([peerA]);

    // pingAgents() lands at +6600 — past the +6500 crossing, and
    // strictly before the next tick at +8000. Without forensics-first
    // (review C1), its own `_knownAgents.set()` write would re-derive
    // `_presentPeers` against a still-`undefined` carrierDownSince and
    // wipe `_lastComputedPresent` to [] before forensics ever runs.
    clock.advance(600); // -> +6600
    await store.pingAgents();
    expect(get(store._presentPeers)).toEqual([peerA]);
    expect(store.signalsCadence()).toEqual({
      mode: 'paused',
      reason: 'carrier-down',
    });

    // The next tick (+8000) confirms the hold persists, not just the
    // single evaluation that caught the crossing.
    clock.advance(1400); // -> +8000
    expect(get(store._presentPeers)).toEqual([peerA]);
  });
});

describe('start()/disconnect() symmetry', () => {
  it('disconnect notifies peers, destroys each transport exactly once, unsubscribes and disarms timers', async () => {
    const { store, clock, bus, transports } = makeStarted();
    store._knownAgents.set(knownFresh(clock, peerA, peerB));
    expect(bus.subscriberCount).toBe(1);
    expect(clock.pendingTimerCount).toBeGreaterThan(0);

    store.disconnect('wiring-test');
    live.length = 0; // cleaned up here; afterEach must not double-disconnect

    const leaves = bus.sentOfType('LeaveUi');
    expect(leaves).toHaveLength(1);
    expect(leaves[0].to.sort()).toEqual([peerA, peerB].sort());
    // Exactly once per transport — the duplicated media destroy() call
    // deleted in Phase 6 stays deleted.
    expect(transports.media!.destroyCount).toBe(1);
    expect(transports['screen-share-in']!.destroyCount).toBe(1);
    expect(transports['screen-share-out']!.destroyCount).toBe(1);
    expect(bus.subscriberCount).toBe(0);
    expect(clock.pendingTimerCount).toBe(0);
    expect(get(store._openConnections)).toEqual({});
    // The module singletons are unbound (a bound controller would leak
    // this store into the next session).
    expect((voiceController as unknown as { store: unknown }).store).toBeNull();

    // A signal delivered after disconnect reaches nothing: no pong.
    await bus.deliver(message(peerAKey, 'PingUi', ''));
    expect(bus.sentOfType('PongUi')).toHaveLength(0);
  });
});

describe('encoder-start retry (the §9 item 2 flag wedge)', () => {
  // The retry cadence is the presence tick: `_signalsTargets` notifies
  // once per tick (the derived chain rebuilds its objects), so the
  // reconcilers re-run within PING_INTERVAL of a failed start. These
  // tests are the pin the reconcilers' comments cite — if store
  // notification semantics ever get memoized, the retry dies and these
  // go red.
  const flush = () => new Promise<void>(r => setTimeout(r, 0));

  /** Arm the voice gate: a present signals target + mic WANTED (intent).
   *  Task 3 replacement #3 gates the signals encoders on intent, not on a
   *  held handle, so the arm is an intent write. */
  function armVoice(started: Started) {
    const { store, clock } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    store._localIntent.update(i => ({ ...i, mic: { wanted: true, muted: false } }));
  }

  /** One presence tick with the target peer kept ping-fresh. */
  async function tick(started: Started) {
    const { store, clock } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    clock.advance(PING_INTERVAL);
    await flush();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a startCapture that resolves false is retried on the next presence tick', async () => {
    const spy = vi
      .spyOn(voiceController, 'startCapture')
      .mockResolvedValue(false);
    const started = makeStarted();
    armVoice(started);

    await tick(started);
    expect(spy).toHaveBeenCalledTimes(1);
    // The failure resolved: the flag converged to reality.
    expect(started.store.voiceEncoderRunning).toBe(false);

    await tick(started);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(started.store.voiceEncoderRunning).toBe(false);
  });

  it('a startCapture that REJECTS resets the flag and retries — the wedge: no rejection arm left the flag true forever', async () => {
    const spy = vi
      .spyOn(voiceController, 'startCapture')
      .mockRejectedValue(new Error('NotAllowedError: mic denied'));
    const started = makeStarted();
    armVoice(started);

    await tick(started);
    expect(spy).toHaveBeenCalledTimes(1);
    // Without the rejection arm this read `true` while no encoder ran,
    // and every later reconcile no-opped: signals audio off until the
    // mic/target gate cycled.
    expect(started.store.voiceEncoderRunning).toBe(false);

    await tick(started);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a healthy start is not re-invoked by the tick (the flag gates the reconciler)', async () => {
    const spy = vi
      .spyOn(voiceController, 'startCapture')
      .mockResolvedValue(true);
    const started = makeStarted();
    armVoice(started);

    await tick(started);
    await tick(started);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(started.store.voiceEncoderRunning).toBe(true);
  });

  it('the filmstrip reconciler retries a rejected startCapture the same way', async () => {
    const spy = vi
      .spyOn(filmstripController, 'startCapture')
      .mockRejectedValue(new Error('camera busy'));
    const started = makeStarted();
    started.store._knownAgents.set(knownFresh(started.clock, peerA));
    started.store._localIntent.update(i => ({ ...i, camera: { wanted: true } }));

    await tick(started);
    expect(spy).toHaveBeenCalledTimes(1);
    await tick(started);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('the capture reconciler (Task 3): intent reconciled against capture lifecycle', () => {
  // The round's highest-risk seam: the store no longer acquires the mic /
  // camera inline nor gates the signals encoders on "is a handle held".
  // The reconciler owns the acquire handles and reconciles them against
  // `localIntent` on the presence tick; the signals reconcilers read
  // `intent.mic.wanted` / `intent.camera.wanted`. These tests drive the
  // real started store over fake capture devices.
  class FakeTrack {
    readyState: 'live' | 'ended' = 'live';

    enabled = true;

    onended: (() => void) | null = null;

    onmute: (() => void) | null = null;

    onunmute: (() => void) | null = null;

    muted = false;

    constructor(public kind: 'audio' | 'video') {}

    stop(): void {
      if (this.readyState === 'ended') return;
      this.readyState = 'ended';
      this.onended?.();
    }
  }

  class FakeStream {
    constructor(private tracks: FakeTrack[]) {}

    getTracks(): FakeTrack[] {
      return this.tracks;
    }

    getAudioTracks(): FakeTrack[] {
      return this.tracks.filter(t => t.kind === 'audio');
    }

    getVideoTracks(): FakeTrack[] {
      return this.tracks.filter(t => t.kind === 'video');
    }
  }

  /** Minimal MediaStream stand-in — node has none, and the store's mic /
   *  camera open branch does `new MediaStream()` + add/get/removeTrack. */
  class FakeMediaStream {
    private tracks: FakeTrack[] = [];

    addTrack(t: FakeTrack): void {
      this.tracks.push(t);
    }

    removeTrack(t: FakeTrack): void {
      this.tracks = this.tracks.filter(x => x !== t);
    }

    getTracks(): FakeTrack[] {
      return this.tracks;
    }

    getAudioTracks(): FakeTrack[] {
      return this.tracks.filter(t => t.kind === 'audio');
    }

    getVideoTracks(): FakeTrack[] {
      return this.tracks.filter(t => t.kind === 'video');
    }
  }

  const flush = () => new Promise<void>(r => setTimeout(r, 0));

  beforeEach(() => {
    (globalThis as any).MediaStream = FakeMediaStream;
  });

  /** Record every getUserMedia call and hand back a scripted stream. */
  function installNavigator(
    respond: (constraints: unknown) => Promise<FakeStream>
  ): { calls: unknown[] } {
    const calls: unknown[] = [];
    // node 22 (0.7 devshell): `navigator` is a getter-only global — use
    // defineProperty, not assignment (see the screen-share block above).
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async (constraints: unknown) => {
            calls.push(constraints);
            return respond(constraints);
          },
        },
      },
      configurable: true,
      writable: true,
    });
    return { calls };
  }

  /** Fire the presence-tick site: the `_signalsTargets` subscription runs
   *  captureReconciler.tick() once per tick, the same cadence and pin as
   *  the encoder reconcilers. Kept ping-fresh so a target stays present. */
  async function presenceTick(started: Started) {
    started.store._knownAgents.set(knownFresh(started.clock, peerA));
    started.clock.advance(PING_INTERVAL);
    await flush();
    await flush();
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).navigator;
    delete (globalThis as any).MediaStream;
  });

  it('(a) audioOn(true) acquires the mic through the reconciler and applies mute', async () => {
    const track = new FakeTrack('audio');
    installNavigator(async () => new FakeStream([track]));
    const started = makeStarted();

    await started.store.audioOn(true);
    await flush();

    expect(started.store.micSource.lifecycle.state).toBe('live');
    expect(started.store.micSource.track).toBe(track as unknown as MediaStreamTrack);
    expect(started.store.micSource.muted).toBe(false);
  });

  it('(a2) audioOff after audioOn(true) mutes but keeps the device live', async () => {
    // audioOff is `audio-mute`: the mic stays WANTED (fast re-enable, no
    // renegotiation), so the reconciler keeps the handle and only the mute
    // flips. (audioOn(false) from scratch never acquires — a never-wanted
    // mic stays unwanted, intent.ts — and is not a production path.)
    const track = new FakeTrack('audio');
    installNavigator(async () => new FakeStream([track]));
    const started = makeStarted();

    await started.store.audioOn(true);
    await flush();
    expect(started.store.micSource.muted).toBe(false);

    await started.store.audioOff();
    await flush();

    expect(started.store.micSource.lifecycle.state).toBe('live');
    expect(started.store.micSource.muted).toBe(true);
    expect(get(started.store.localIntent).mic.wanted).toBe(true);
  });

  it('(b) a killed track is reopened on the next tick and the new track reaches peers via replaceTrack', async () => {
    const trackA = new FakeTrack('audio');
    const trackB = new FakeTrack('audio');
    const nav = installNavigator(
      (() => {
        let n = 0;
        return async () => new FakeStream([[trackA, trackB][n++]!]);
      })()
    );
    const started = makeStarted();
    const media = started.transports.media!;

    await started.store.audioOn(true);
    await flush();
    expect(started.store.micSource.track).toBe(trackA as unknown as MediaStreamTrack);
    media.replaceCalls.length = 0;

    // The device dies underneath the held handle (Incident B / D3).
    trackA.stop();
    expect(started.store.micSource.lifecycle.state).toBe('ended');

    // Tick site drives the reopen. Two ticks clear the reopen pacing
    // interval (PING_INTERVAL < CAPTURE_REOPEN_MIN_INTERVAL_MS).
    await presenceTick(started);
    await presenceTick(started);

    expect(nav.calls.length).toBe(2); // opened a fresh device
    expect(started.store.micSource.track).toBe(trackB as unknown as MediaStreamTrack);
    // The reopen swaps the corpse for the new track on every peer transport.
    expect(
      media.replaceCalls.some(
        c => c.newTrack === (trackB as unknown as MediaStreamTrack)
      )
    ).toBe(true);
  });

  it("(b') the signals-audio gate reads intent, not device observation: wanted mic with a dead device still runs the encoder", async () => {
    // Mutation guard (Step 5 i): if `_reconcileSignalsAudio` reverts to a
    // device-held observation, this goes red — intent says wanted, but no
    // handle is held / no live track exists.
    const spy = vi.spyOn(voiceController, 'startCapture').mockResolvedValue(true);
    const started = makeStarted();
    // Intent: mic wanted. No fake navigator installed, so the reconciler's
    // acquire fails and no live track ever exists — the dead-device case.
    started.store._localIntent.update(i => ({
      ...i,
      mic: { wanted: true, muted: false },
    }));

    await presenceTick(started);

    expect(started.store.micSource.lifecycle.state).not.toBe('live');
    expect(spy).toHaveBeenCalled();
    expect(started.store.voiceEncoderRunning).toBe(true);
  });

  it('(c) a device that keeps failing is retried to the ceiling then reported exactly once', async () => {
    installNavigator(async () => {
      throw new Error('NotAllowedError: mic denied');
    });
    const started = makeStarted();
    const errors: string[] = [];
    started.store.onEvent(e => {
      if (e.type === 'error') errors.push(e.error);
    });

    // Gesture: attempt 1 (audioOn ticks once).
    await started.store.audioOn(true);
    await flush();

    // Drive further paced ticks well past the ceiling.
    for (let i = 0; i < 10; i += 1) {
      started.clock.advance(CAPTURE_REOPEN_MIN_INTERVAL_MS);
      await started.store.captureReconciler.tick();
      await flush();
    }

    expect(started.store.captureReconciler.micAttemptState.attemptsSinceGesture).toBe(
      CAPTURE_REOPEN_MAX_ATTEMPTS + 1
    );
    expect(errors.filter(e => e.includes('Microphone'))).toHaveLength(1);
  });

  it('(c2) getUserMedia is called exactly CAPTURE_REOPEN_MAX_ATTEMPTS times then stops', async () => {
    const nav = installNavigator(async () => {
      throw new Error('mic denied');
    });
    const started = makeStarted();

    await started.store.audioOn(true);
    await flush();
    for (let i = 0; i < 10; i += 1) {
      started.clock.advance(CAPTURE_REOPEN_MIN_INTERVAL_MS);
      await started.store.captureReconciler.tick();
      await flush();
    }

    expect(nav.calls.length).toBe(CAPTURE_REOPEN_MAX_ATTEMPTS);
  });

  it('(d) a fresh gesture resets the retry pacing and reopens immediately', async () => {
    const trackA = new FakeTrack('audio');
    const trackB = new FakeTrack('audio');
    const nav = installNavigator(
      (() => {
        let n = 0;
        return async () => new FakeStream([[trackA, trackB][n++]!]);
      })()
    );
    const started = makeStarted();

    await started.store.audioOn(true);
    await flush();
    expect(nav.calls.length).toBe(1);

    trackA.stop(); // device dies
    // No clock advance: the reopen interval has NOT elapsed. A bare tick
    // would hold (paced). The gesture must reset pacing and reopen now.
    await started.store.captureReconciler.tick();
    await flush();
    expect(nav.calls.length).toBe(1); // confirm: paced, no reopen yet

    await started.store.audioOn(true); // the gesture
    await flush();

    expect(nav.calls.length).toBe(2); // reopened immediately despite pacing
    expect(started.store.micSource.track).toBe(trackB as unknown as MediaStreamTrack);
  });

  it('(e) inbound request-track-refresh with a dead source defers instead of pushing a dead track', async () => {
    // Incident B's exact wedge: a peer asks us to refresh tracks, our mic
    // died, and the old code replaceTrack'd the corpse and logged success.
    const track = new FakeTrack('audio');
    installNavigator(async () => new FakeStream([track]));
    const started = makeStarted();
    const media = started.transports.media!;

    // Bring up mic + an open connection to peerA.
    await started.store.audioOn(true);
    await flush();
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    media.refreshMediaCalls.length = 0;

    // The mic dies underneath us.
    track.stop();
    expect(started.store.micSource.lifecycle.state).toBe('ended');

    // Inbound request-track-refresh over the real data-channel glue.
    media.emit({
      type: 'data-channel-message',
      peer: peerA,
      connectionId: 'conn-1',
      data: encodeRtcAction('request-track-refresh'),
    });

    expect(media.refreshMediaCalls).toHaveLength(0);
    expect(
      started.logger.customMessages.some(m =>
        m.includes('source dead, deferring to capture reconciler')
      )
    ).toBe(true);
    // The dishonest "replaceTrack: refreshed via transport" success line
    // must NOT appear for this dead-source refresh.
    expect(
      started.logger.customMessages.some(m => m.includes('refreshed via transport'))
    ).toBe(false);
  });

  it('(f) videoOn whose first acquire fails still reaches peers + fires my-video-on when a later tick acquires', async () => {
    // Review finding #1: the camera peer attach and `my-video-on` must be
    // reachable from a RECONCILER-driven fresh acquire, not only from
    // videoOn. If videoOn's first acquire fails transiently (camera busy —
    // the exact class this reconciler handles), intent stays wanted and a
    // later bare tick acquires; the track must still reach RTCRtpSenders
    // and my-video-on must fire, else WebRTC peers see no video until a
    // manual off/on.
    const camTrack = new FakeTrack('video');
    let call = 0;
    installNavigator(async () => {
      call += 1;
      if (call === 1) throw new Error('NotReadableError: camera busy');
      return new FakeStream([camTrack]);
    });
    const started = makeStarted();
    const media = started.transports.media!;
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');

    // First videoOn: acquire fails. No handle, but intent stays wanted.
    await started.store.videoOn();
    await flush();
    expect(started.store.cameraSource.lifecycle.state).not.toBe('live');
    expect(get(started.store.localIntent).camera.wanted).toBe(true);
    expect(started.events.some(e => e.type === 'my-video-on')).toBe(false);
    media.addTrackCalls.length = 0;

    // A later bare presence tick (paced) — the reconciler acquires.
    started.clock.advance(CAPTURE_REOPEN_MIN_INTERVAL_MS);
    await presenceTick(started);

    expect(started.store.cameraSource.track).toBe(camTrack as unknown as MediaStreamTrack);
    // The freshly-acquired track reached the peer transport (addTrack: no
    // prior video sender existed) — not stranded on mainStream.
    expect(
      media.addTrackCalls.some(t => t === (camTrack as unknown as MediaStreamTrack))
    ).toBe(true);
    expect(started.events.some(e => e.type === 'my-video-on')).toBe(true);
  });

  // Task 6: the store recomputes `intentDiffs` at the SAME presence-tick
  // site where the reconciler runs, so the UI can never show a diff the
  // reconciler is not acting on. These pin that wiring — the pure
  // `describeIntentDiffs` decision is table-tested in intent-diff-policy.
  it('(e) a dead-but-wanted mic surfaces a pending mic diff on the tick', async () => {
    installNavigator(async () => {
      throw new Error('NotAllowedError: mic denied');
    });
    const started = makeStarted();

    // Gesture: mic wanted; the reconciler's acquire fails (no live device).
    await started.store.audioOn(true);
    await flush();
    expect(started.store.micSource.lifecycle.state).toBe('failed');

    // Recompute happens in the presence-tick subscription, not in audioOn.
    await presenceTick(started);

    const diffs = get(started.store.intentDiffs);
    const mic = diffs.find(d => d.scope === 'mic');
    expect(mic?.severity).toBe('pending');
    expect(mic?.copy).toBe('Microphone unavailable — retrying…');
  });

  it('(f) once the reconciler exhausts its attempts the mic diff goes failed', async () => {
    installNavigator(async () => {
      throw new Error('NotAllowedError: mic denied');
    });
    const started = makeStarted();

    await started.store.audioOn(true);
    await flush();
    // Drive paced ticks past the ceiling; report-failure bumps the count
    // past the max so the diff's severity flips to 'failed'.
    for (let i = 0; i < CAPTURE_REOPEN_MAX_ATTEMPTS + 2; i += 1) {
      started.clock.advance(CAPTURE_REOPEN_MIN_INTERVAL_MS);
      await started.store.captureReconciler.tick();
      await flush();
    }
    expect(
      started.store.captureReconciler.micAttemptState.attemptsSinceGesture
    ).toBeGreaterThanOrEqual(CAPTURE_REOPEN_MAX_ATTEMPTS);

    // A recompute tick reflects the exhausted state.
    await presenceTick(started);

    const mic = get(started.store.intentDiffs).find(d => d.scope === 'mic');
    expect(mic?.severity).toBe('failed');
    expect(mic?.copy).toBe('Microphone unavailable');
  });
});

describe('InitAccept lifecycle (§9 item 5)', () => {
  /** Seed a pending init and deliver the matching video InitAccept. */
  async function acceptVideo(started: Started, connectionId: string) {
    started.store._pendingInits[peerA] = [
      { connectionId, t0: started.clock.now() },
    ];
    await started.bus.deliver(
      message(
        peerAKey,
        'InitAccept',
        JSON.stringify({ connection_id: connectionId, connection_type: 'video' })
      )
    );
  }

  // The store's tracked SDP backstop with no RTT sample: SDP_EXCHANGE_TIMEOUT
  // (the FSM's own no-sample default) * SDP_BACKSTOP_MULTIPLIER, plus
  // SDP_BACKSTOP_RETRY_HEADROOM_MS (review C1 — the backstop is pinned
  // strictly greater than the FSM's per-attempt timeout AND its first
  // in-place backoff retry, never equal to either; see
  // _computeSdpBackstopTimeout). This is a declared change from the
  // pre-review-C1 value of a flat SDP_EXCHANGE_TIMEOUT.
  const NO_SAMPLE_BACKSTOP_MS =
    SDP_EXCHANGE_TIMEOUT * SDP_BACKSTOP_MULTIPLIER + SDP_BACKSTOP_RETRY_HEADROOM_MS;

  it('the initiator slot install goes through the slot policy; the tracked SDP timer tears down its own attempt', async () => {
    const started = makeStarted();
    const { store, clock, transports } = started;
    const media = transports.media!;
    await acceptVideo(started, 'init-1');

    // The slot exists, keyed to the transport-returned connectionId,
    // fresh (connected: false), with SdpExchange status — the same
    // decideSlotWrite apply the transport event glue runs, not a
    // hand-written update.
    const slot = get(store._openConnections)[peerA];
    expect(slot).toBeDefined();
    expect(slot.connectionId).toBe('init-1');
    expect(slot.connected).toBe(false);
    expect(get(store._connectionStatuses)[peerA]?.type).toBe('SdpExchange');

    // No RTT sample: the FSM's own per-attempt timeout is undefined (its
    // own 15s default applies inside the FSM, out of view here).
    expect(lastSdpOverride(media)).toBeUndefined();

    // The attempt never connects: ITS OWN backstop timer fires and tears
    // it down, at NO_SAMPLE_BACKSTOP_MS (38_000) — NOT the plain
    // SDP_EXCHANGE_TIMEOUT (15_000) it used before review C1.
    clock.advance(NO_SAMPLE_BACKSTOP_MS - 1);
    expect(get(store._openConnections)[peerA]).toBeDefined();
    clock.advance(1);
    expect(get(store._openConnections)[peerA]).toBeUndefined();
    expect(
      media.closeCalls.some(c => c.reason === 'SDP exchange timeout')
    ).toBe(true);
    expect(get(store._connectionStatuses)[peerA]?.type).toBe('Disconnected');
  });

  it('THE SUCCESSOR PIN: a replacement attempt survives the predecessor SDP timer firing', async () => {
    const started = makeStarted();
    const { store, clock, transports } = started;
    const media = transports.media!;
    await acceptVideo(started, 'init-1');

    // Halfway through the backstop window the transport replaces the FSM
    // in place (the adopt route) — a successor attempt now owns the slot.
    clock.advance(NO_SAMPLE_BACKSTOP_MS / 2);
    media.emitPhase(peerA, 'conn-2', 'signaling');
    expect(get(store._openConnections)[peerA].connectionId).toBe('conn-2');

    // The predecessor's deadline passes. Before §9 item 5 the untracked
    // timer saw SdpExchange status + an unconnected slot and destroyed
    // the SUCCESSOR. Attempt-scoping makes it a no-op.
    clock.advance(NO_SAMPLE_BACKSTOP_MS / 2);
    expect(get(store._openConnections)[peerA]?.connectionId).toBe('conn-2');
    expect(media.closeCalls).toHaveLength(0);
    expect(get(store._connectionStatuses)[peerA]?.type).toBe('SdpExchange');
  });

  it('a new attempt after teardown replaces the tracked timer; disconnect() disarms it', async () => {
    const started = makeStarted();
    const { store, clock } = started;
    await acceptVideo(started, 'init-1');
    const armed = clock.pendingTimerCount;

    // A fresh attempt for the same peer re-arms, not stacks.
    started.transports.media!.emitPhase(peerA, 'init-1', 'closed', 'signaling');
    await acceptVideo(started, 'init-2');
    expect(clock.pendingTimerCount).toBe(armed);

    // disconnect() leaves no timer behind (start/disconnect symmetry).
    store.disconnect('sdp-timer-hygiene');
    live.length = 0;
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('peer-leave wipes the init-retry cooldown and reconcile throttle; a plain close keeps the cooldown (the rejoin-inheritance fix)', async () => {
    const started = makeStarted();
    const { store, clock, bus, transports } = started;
    const media = transports.media!;
    store._knownAgents.set(knownFresh(clock, peerA));

    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    store._lastReconcileTime[peerA] = clock.now();

    // A close STAMPS the cooldown and leaves the throttle alone — the
    // retry-gap semantics, unchanged.
    media.emitPhase(peerA, 'conn-1', 'failed', 'connected');
    expect(store._lastDisconnectTime[peerA]).toBeDefined();
    expect(store._lastReconcileTime[peerA]).toBeDefined();

    // The peer LEAVES mid-connection: the leave row's deletes must win
    // even though the nested close (transport closes first) re-stamps
    // the cooldown on the way down — the executor-order pin.
    media.emitPhase(peerA, 'conn-2', 'signaling');
    media.emitPhase(peerA, 'conn-2', 'connected', 'connecting');
    await bus.deliver(message(peerAKey, 'LeaveUi', ''));
    expect(store._lastDisconnectTime[peerA]).toBeUndefined();
    expect(store._lastReconcileTime[peerA]).toBeUndefined();

    // And the no-slot leave clears them too (the clears are
    // unconditional per leave, as they always were on this path).
    store._lastDisconnectTime[peerA] = clock.now();
    store._lastReconcileTime[peerA] = clock.now();
    await bus.deliver(message(peerAKey, 'LeaveUi', ''));
    expect(store._lastDisconnectTime[peerA]).toBeUndefined();
    expect(store._lastReconcileTime[peerA]).toBeUndefined();
  });

  it('an elevated signals RTT: the FSM override sits at the raised 30s ceiling, and the tracked backstop is 2x that (review C1) (Task 9)', async () => {
    const started = makeStarted();
    const { store, clock, bus, transports } = started;
    const media = transports.media!;
    // Seed _signalsRttEwma[peerA] = 2_000ms before the InitAccept arrives.
    await bus.deliver(pongEchoingRtt(peerAKey, clock, 2_000));

    await acceptVideo(started, 'init-1');
    expect(get(store._openConnections)[peerA]).toBeDefined();

    // The FSM's own per-attempt timeout (sdpExchangeTimeoutMs, passed to
    // ensureConnection): min(SDP_TIMEOUT_CEILING_MS, 20 * 2_000) = 30_000.
    expect(lastSdpOverride(media)).toBe(SDP_TIMEOUT_CEILING_MS);

    // The store's own tracked backstop is deliberately NOT the same value
    // (review C1 — sharing it destroyed the FSM's in-place recovery retry
    // mid-flight): min(SDP_BACKSTOP_CEILING_MS, 2 * 30_000 + 8_000) = 68_000.
    clock.advance(2 * SDP_TIMEOUT_CEILING_MS + SDP_BACKSTOP_RETRY_HEADROOM_MS - 1);
    expect(get(store._openConnections)[peerA]).toBeDefined();
    clock.advance(1);
    expect(get(store._openConnections)[peerA]).toBeUndefined();
    expect(
      media.closeCalls.some(c => c.reason === 'SDP exchange timeout')
    ).toBe(true);
  });

  it('a low signals RTT: the FSM override is unaffected, and the tracked backstop is 2x it, not equal to it (review C1) (Task 9)', async () => {
    const started = makeStarted();
    const { store, clock, bus, transports } = started;
    const media = transports.media!;
    // Seed _signalsRttEwma[peerA] = 400ms: 20 * 400 = 8_000, well under
    // both the old and new ceiling.
    await bus.deliver(pongEchoingRtt(peerAKey, clock, 400));

    await acceptVideo(started, 'init-1');

    // FSM override: 20 * 400 = 8_000 — unaffected by review C1.
    expect(lastSdpOverride(media)).toBe(8_000);

    // Backstop: 2 * 8_000 + 8_000 = 24_000. Before review C1 this timer
    // shared the override's value (8_000) and would already have fired
    // by now.
    clock.advance(23_999);
    expect(get(store._openConnections)[peerA]).toBeDefined();
    clock.advance(1);
    expect(get(store._openConnections)[peerA]).toBeUndefined();
    expect(
      media.closeCalls.some(c => c.reason === 'SDP exchange timeout')
    ).toBe(true);
  });

  it('invariant: the tracked backstop always arms strictly greater than the FSM per-attempt override, across RTTs (review C1)', async () => {
    const cases: Array<{
      rttMs: number | undefined;
      expectedOverride: number | undefined;
      expectedBackstop: number;
    }> = [
      // No sample: FSM falls back to its own default (undefined here);
      // the backstop is 2x SDP_EXCHANGE_TIMEOUT plus the retry headroom.
      { rttMs: undefined, expectedOverride: undefined, expectedBackstop: 38_000 },
      // Below the floor multiplier: unaffected by either ceiling.
      { rttMs: 400, expectedOverride: 8_000, expectedBackstop: 24_000 },
      // Ceiling-bound override: the backstop's own doubling plus headroom
      // lands exactly at SDP_BACKSTOP_CEILING_MS (68_000), by construction
      // (SDP_BACKSTOP_CEILING_MS = 2 * SDP_TIMEOUT_CEILING_MS + headroom).
      { rttMs: 2_000, expectedOverride: 30_000, expectedBackstop: 68_000 },
      // Deep into the plausible RTT range: override still ceiling-bound,
      // backstop still just the doubled ceiling plus headroom.
      { rttMs: 5_000, expectedOverride: 30_000, expectedBackstop: 68_000 },
    ];

    for (const { rttMs, expectedOverride, expectedBackstop } of cases) {
      const started = makeStarted();
      const { store, clock, bus, transports } = started;
      const media = transports.media!;
      if (rttMs !== undefined) {
        await bus.deliver(pongEchoingRtt(peerAKey, clock, rttMs));
      }

      await acceptVideo(started, 'init-1');
      expect(lastSdpOverride(media)).toBe(expectedOverride);
      expect(expectedBackstop).toBeGreaterThan(
        expectedOverride ?? SDP_EXCHANGE_TIMEOUT
      );

      clock.advance(expectedBackstop - 1);
      expect(get(store._openConnections)[peerA]).toBeDefined();
      clock.advance(1);
      expect(get(store._openConnections)[peerA]).toBeUndefined();
      expect(
        media.closeCalls.some(c => c.reason === 'SDP exchange timeout')
      ).toBe(true);
    }
  });
});

describe('diagnostic attempt timeout scales with signals RTT (Task 9)', () => {
  it('an elevated signals RTT (5_000ms) scales the per-attempt timeout to 4x RTT (20_000ms)', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    await bus.deliver(pongEchoingRtt(peerAKey, clock, 5_000));

    await store.requestDiagnosticLogs(peerA);
    expect(get(store._pendingDiagnosticRequests)[peerA]?.attempts).toBe(1);

    // 4 * 5_000 = 20_000, under DIAGNOSTIC_ATTEMPT_TIMEOUT_MAX_MS (30_000).
    clock.advance(19_999);
    expect(get(store._pendingDiagnosticRequests)[peerA]?.attempts).toBe(1);
    clock.advance(1);
    expect(get(store._pendingDiagnosticRequests)[peerA]?.attempts).toBe(2);
  });

  it('no RTT sample keeps the per-attempt timeout at the unscaled 8_000ms default', async () => {
    const started = makeStarted();
    const { store, clock } = started;

    await store.requestDiagnosticLogs(peerA);
    expect(get(store._pendingDiagnosticRequests)[peerA]?.attempts).toBe(1);

    clock.advance(7_999);
    expect(get(store._pendingDiagnosticRequests)[peerA]?.attempts).toBe(1);
    clock.advance(1);
    expect(get(store._pendingDiagnosticRequests)[peerA]?.attempts).toBe(2);
  });
});

describe('the RTCMessage send seam (§9 item 6)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a broadcast reaches every open-connection peer, and one failing send does not stop the rest', async () => {
    const started = makeStarted();
    const { store, transports } = started;
    const media = transports.media!;
    media.emitPhase(peerA, 'conn-a', 'signaling');
    media.emitPhase(peerB, 'conn-b', 'signaling');

    // peerA's channel throws; the per-peer catch must let peerB's send
    // proceed (the unified catch is per peer, not per broadcast).
    const realSend = media.send.bind(media);
    vi.spyOn(media, 'send').mockImplementation((peer, data) => {
      if (peer === peerA) throw new Error('channel closed');
      realSend(peer, data);
    });

    // changeAudioInput broadcasts unconditionally (no consumer holds
    // the mic in node, so MicSource just stores the id).
    await store.changeAudioInput('device-2');

    const frames = media.sentData.filter(f => {
      const parsed = JSON.parse(String(f.data)) as {
        type?: string;
        message?: string;
      };
      return parsed.type === 'action' && parsed.message === 'change-audio-input';
    });
    expect(frames.map(f => f.peer)).toEqual([peerB]);
  });
});

describe('signals media cadence gates the senders (Task 7)', () => {
  const flush = () => new Promise<void>(r => setTimeout(r, 0));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** ModuleData sends for one module, envelope-parsed. */
  function moduleData(bus: Started['bus'], moduleId: string) {
    return bus
      .sentOfType('ModuleData')
      .map(m => JSON.parse(m.payload!) as { moduleId: string; chunk: string })
      .filter(p => p.moduleId === moduleId);
  }

  /** Drive one encoded voice frame through the bound controller — the
   *  real handleEncodedChunk send path, minus WebCodecs. */
  function encodeVoiceFrame(ts = 0) {
    (
      voiceController as unknown as {
        handleEncodedChunk(c: unknown): void;
      }
    ).handleEncodedChunk({
      byteLength: 2,
      timestamp: ts,
      type: 'key',
      copyTo: (_buf: Uint8Array) => {},
    });
  }

  /** Drive one filmstrip clip through the bound controller's send site. */
  function sendFilmstripClip() {
    (
      filmstripController as unknown as {
        _handleClipFromWorker(m: unknown): void;
      }
    )._handleClipFromWorker({
      bytes: new ArrayBuffer(2),
      w: 1,
      h: 1,
      n: 1,
      p: 1,
      t0: 1,
      capturedAt: 1,
    });
  }

  /** A PongUi from peerA echoing a pingT0 `rttMs` in the past — the real
   *  foldSignalsRtt input (first sample seeds the EWMA at the raw RTT).
   *  Carries `moduleStatesAt` matching the capsDeclaration stamp so the
   *  pong does not read as a legacy no-stamp pong, whose unconditional
   *  sweep would wipe the caps declaration between sends. */
  function pongEchoing(started: Started, rttMs: number): RoomSignal {
    return message(
      peerAKey,
      'PongUi',
      JSON.stringify({
        formatVersion: 1,
        data: {
          connectionStatuses: {},
          pingT0: started.clock.now() - rttMs,
          moduleStatesAt: 1,
        },
      })
    );
  }

  /** peerA's conversation payload declaring `caps`. */
  function capsDeclaration(caps: string[]): RoomSignal {
    return message(
      peerAKey,
      'ModuleState',
      JSON.stringify({
        moduleId: 'conversation',
        active: true,
        payload: JSON.stringify({ caps }),
        updatedAt: 1,
      })
    );
  }

  it('paused cadence (collapsed RTT) stops ModuleData sends without tearing down capture', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    const stopSpy = vi.spyOn(voiceController, 'stopCapture');

    // Baseline: full cadence, one legacy frame per encoded chunk.
    expect(store.signalsCadence().mode).toBe('full');
    encodeVoiceFrame();
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(1);

    // Drive peerA's RTT EWMA above SIGNALS_RTT_COLLAPSED_MS through the
    // fake bus (a pong echoing an old t0), then run the ping cycle the
    // per-tick evaluation rides.
    await bus.deliver(pongEchoing(started, SIGNALS_RTT_COLLAPSED_MS + 1_000));
    await store.pingAgents();
    expect(store.signalsCadence()).toEqual({
      mode: 'paused',
      reason: 'rtt-collapsed',
    });

    // The gate holds for voice AND filmstrip…
    encodeVoiceFrame();
    encodeVoiceFrame();
    sendFilmstripClip();
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(1);
    expect(moduleData(bus, 'video-filmstrip')).toHaveLength(0);
    // …while capture is untouched: paused gates the send, not the
    // pipeline — teardown stays owned by the reconcilers/_signalsTargets,
    // and the peer is still a signals target.
    expect(stopSpy).not.toHaveBeenCalled();
    expect(get(store._signalsTargets).has(peerA)).toBe(true);
  });

  it('carrier-down pauses immediately (no pong from any peer for SIGNAL_CARRIER_DOWN_MS)', async () => {
    const started = makeStarted();
    const { store, clock, bus, logger } = started;
    // peerA has ponged at least once (a lastSeen stamp) — never-ponged
    // peers are excluded from decideSignalCarrier by declared design.
    store._knownAgents.set(knownFresh(clock, peerA));
    await store.pingAgents();
    expect(store.signalsCadence().mode).toBe('full');

    // Three silent ticks: the forensics call inside pingAgents flips the
    // carrier down and forces the cadence to paused in the same breath.
    clock.advance(SIGNAL_CARRIER_DOWN_MS);
    await store.pingAgents();
    expect(store.signalsCadence()).toEqual({
      mode: 'paused',
      reason: 'carrier-down',
    });
    expect(
      logger.customMessages.some(m => m.startsWith('SignalCarrierDown'))
    ).toBe(true);
    encodeVoiceFrame();
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);
  });

  it('carrier recovery resets the stale RTT EWMA to the degraded threshold — cadence resumes at voice-only on the recovery tick, not the paused wait nor a bare full jump (final-review wave F5, amended per re-review N2)', async () => {
    const started = makeStarted();
    const { store, clock, bus, logger } = started;
    store._knownAgents.set(knownFresh(clock, peerA));

    // Collapse the RTT EWMA well past SIGNALS_RTT_COLLAPSED_MS.
    await bus.deliver(pongEchoing(started, SIGNALS_RTT_COLLAPSED_MS + 5_000));
    await store.pingAgents();
    expect(store.signalsCadence()).toEqual({
      mode: 'paused',
      reason: 'rtt-collapsed',
    });

    // Silence pongs for SIGNAL_CARRIER_DOWN_MS: the carrier itself drops.
    clock.advance(SIGNAL_CARRIER_DOWN_MS);
    await store.pingAgents();
    expect(store.signalsCadence()).toEqual({
      mode: 'paused',
      reason: 'carrier-down',
    });
    expect(
      logger.customMessages.some(m => m.startsWith('SignalCarrierDown'))
    ).toBe(true);

    // Recovery: a fresh, healthy pong arrives and the carrier flips up.
    store._knownAgents.set(knownFresh(clock, peerA));
    await bus.deliver(pongEchoing(started, 0));
    await store.pingAgents();
    expect(
      logger.customMessages.some(m => m.startsWith('SignalCarrierUp'))
    ).toBe(true);

    // The up-flip resets the collapsed-era EWMA sample to
    // SIGNALS_RTT_DEGRADED_MS, not delete (N2): no stale collapsed
    // reading survives the flip, but the probe lands at voice-only, not a
    // bare jump straight to full sending both voice and filmstrip into a
    // relay that just recovered.
    expect(store.signalsCadence()).toEqual({
      mode: 'voice-only',
      reason: 'rtt-degraded',
    });
    sendFilmstripClip();
    encodeVoiceFrame();
    await flush();
    expect(moduleData(bus, 'video-filmstrip')).toHaveLength(0);
    expect(moduleData(bus, 'voice')).toHaveLength(1);

    // A fresh, healthy pong then walks the EWMA down and the cadence on
    // to full, same as any other recovery from voice-only.
    await walkRecovery(started, mode => mode === 'voice-only');
    expect(store.signalsCadence().mode).toBe('full');
  });

  it('voice-only cadence (degraded RTT) drops filmstrip clips but keeps voice flowing', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));

    sendFilmstripClip();
    await flush();
    expect(moduleData(bus, 'video-filmstrip')).toHaveLength(1);

    await bus.deliver(pongEchoing(started, SIGNALS_RTT_DEGRADED_MS + 500));
    await store.pingAgents();
    expect(store.signalsCadence()).toEqual({
      mode: 'voice-only',
      reason: 'rtt-degraded',
    });

    sendFilmstripClip();
    encodeVoiceFrame();
    await flush();
    expect(moduleData(bus, 'video-filmstrip')).toHaveLength(1);
    expect(moduleData(bus, 'voice')).toHaveLength(1);
  });

  it('voice batches VOICE_BATCH_FRAMES frames per signal when every target holds the cap; RED rides the batch primary', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    await bus.deliver(capsDeclaration([CAP_VOICE_BATCH]));
    expect(store.signalsTargetsAllHaveCap(CAP_VOICE_BATCH)).toBe(true);
    // The batching gate (F2) is a once-per-tick cache read via
    // voiceBatchEligible() — a tick must run before the sender sees it.
    await store.pingAgents();

    // Two frames buffer; the third flushes ONE packed signal.
    encodeVoiceFrame(0);
    encodeVoiceFrame(20_000);
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);
    encodeVoiceFrame(40_000);
    await flush();
    const sent = moduleData(bus, 'voice');
    expect(sent).toHaveLength(1);
    const batch1 = JSON.parse(sent[0].chunk) as {
      v: number;
      frames: Array<{ seq: number; red?: Array<{ seq: number }> }>;
    };
    expect(batch1.v).toBe(2);
    expect(batch1.frames.map(f => f.seq)).toEqual([1, 2, 3]);
    expect(batch1.frames).toHaveLength(VOICE_BATCH_FRAMES);
    // Nothing preceded the first batch: no red anywhere.
    expect(batch1.frames.every(f => f.red === undefined)).toBe(true);

    // Second batch: RED (redundancy 2) rides the batch's FIRST frame and
    // carries exactly the two frames preceding the batch; later members
    // carry none (their predecessors travel in the same packet).
    encodeVoiceFrame();
    encodeVoiceFrame();
    encodeVoiceFrame();
    await flush();
    const sent2 = moduleData(bus, 'voice');
    expect(sent2).toHaveLength(2);
    const batch2 = JSON.parse(sent2[1].chunk) as typeof batch1;
    expect(batch2.frames.map(f => f.seq)).toEqual([4, 5, 6]);
    expect(batch2.frames[0].red!.map(f => f.seq)).toEqual([2, 3]);
    expect(batch2.frames[1].red).toBeUndefined();
    expect(batch2.frames[2].red).toBeUndefined();
  });

  it('a mixed room (one target without the cap) falls back to legacy per-frame for everyone', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA, peerB));
    // peerA declares the cap; peerB declares nothing (baseline caps only).
    await bus.deliver(capsDeclaration([CAP_VOICE_BATCH]));
    expect(store.signalsTargetsAllHaveCap(CAP_VOICE_BATCH)).toBe(false);

    encodeVoiceFrame();
    encodeVoiceFrame();
    encodeVoiceFrame();
    await flush();
    const sent = moduleData(bus, 'voice');
    expect(sent).toHaveLength(3);
    // Legacy single-frame shape (no v2 envelope), each one broadcast to
    // BOTH targets — the one-broadcast constraint the cap rule exists for.
    for (const s of sent) {
      expect((JSON.parse(s.chunk) as { v?: number }).v).toBeUndefined();
    }
    const raw = bus.sentOfType('ModuleData');
    expect(raw[0].to.slice().sort()).toEqual([peerA, peerB].sort());
  });

  it('stopCapture drops buffered batch frames instead of sending them (stale audio)', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    await bus.deliver(capsDeclaration([CAP_VOICE_BATCH]));
    await store.pingAgents(); // F2: batching gate is a once-per-tick cache

    encodeVoiceFrame();
    encodeVoiceFrame();
    await voiceController.stopCapture();
    encodeVoiceFrame(); // starts a NEW batch; must not flush the old one
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);
  });

  /** Walk the RTT EWMA back down with fresh pongs, one presence tick per
   *  iteration, until the cadence leaves `stopAt` (bounded). Returns the
   *  mode observed after each tick. */
  async function walkRecovery(
    started: Started,
    stopWhile: (mode: string) => boolean
  ): Promise<string[]> {
    const { store, clock, bus } = started;
    const modes: string[] = [];
    for (let i = 0; i < 12 && stopWhile(store.signalsCadence().mode); i++) {
      store._knownAgents.set(knownFresh(clock, peerA));
      await bus.deliver(pongEchoing(started, 0));
      clock.advance(PING_INTERVAL);
      await store.pingAgents();
      modes.push(store.signalsCadence().mode);
    }
    return modes;
  }

  it('a pause discards a partially-accumulated batch — the first post-resume flush carries only fresh frames (review I1)', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    await bus.deliver(capsDeclaration([CAP_VOICE_BATCH]));
    await store.pingAgents(); // F2: batching gate is a once-per-tick cache

    // Two frames buffered pre-pause — stale audio by resume time.
    encodeVoiceFrame(111);
    encodeVoiceFrame(222);
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);

    // Collapse the RTT → paused; a frame encoded while paused is dropped.
    await bus.deliver(pongEchoing(started, SIGNALS_RTT_COLLAPSED_MS + 1_000));
    await store.pingAgents();
    expect(store.signalsCadence().mode).toBe('paused');
    encodeVoiceFrame(333);
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);

    // Recover past 'paused' (voice sends in 'voice-only' too).
    await walkRecovery(started, mode => mode === 'paused');
    expect(store.signalsCadence().mode).not.toBe('paused');

    // The next flush contains ONLY post-resume frames: the pre-pause
    // timestamps are gone, and their seqs are simply absent — they read
    // as ordinary loss at the receiver (truthful accounting).
    encodeVoiceFrame(444);
    encodeVoiceFrame(555);
    encodeVoiceFrame(666);
    await flush();
    const sent = moduleData(bus, 'voice');
    expect(sent).toHaveLength(1);
    const batch = JSON.parse(sent[0].chunk) as {
      frames: Array<{ seq: number; ts: number }>;
    };
    expect(batch.frames.map(f => f.ts)).toEqual([444, 555, 666]);
    // seqs 1,2 (buffered pre-pause) never reached the wire; the frame
    // encoded while paused never consumed a seq at all.
    expect(batch.frames.map(f => f.seq)).toEqual([3, 4, 5]);
  });

  it('a cap flip mid-batch flushes the buffered frames per-frame, in seq order (review I2)', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    await bus.deliver(capsDeclaration([CAP_VOICE_BATCH]));
    await store.pingAgents(); // F2: batching gate is a once-per-tick cache

    // Two frames buffer under the cap gate…
    encodeVoiceFrame(111);
    encodeVoiceFrame(222);
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);

    // …then a caps-silent peer becomes a signals target (mixed room). The
    // flip is a raw-evaluation fact immediately, but the sender only sees
    // it on the next tick (F2 — the flip now takes effect within one
    // tick, not same-chunk; the mid-batch flush below is what makes that
    // safe, so this is a declared cadence change, not a regression).
    store._knownAgents.set(knownFresh(clock, peerA, peerB));
    expect(store.signalsTargetsAllHaveCap(CAP_VOICE_BATCH)).toBe(false);
    await store.pingAgents();

    // The next frame flushes the buffered two per-frame FIRST, then
    // itself: 3 legacy sends in seq order — nothing stranded, nothing
    // reordered behind newer frames.
    encodeVoiceFrame(333);
    await flush();
    const sent = moduleData(bus, 'voice');
    expect(sent).toHaveLength(3);
    const parsed = sent.map(
      s => JSON.parse(s.chunk) as { seq: number; ts: number; v?: number }
    );
    expect(parsed.map(p => p.v)).toEqual([undefined, undefined, undefined]);
    expect(parsed.map(p => p.seq)).toEqual([1, 2, 3]);
    expect(parsed.map(p => p.ts)).toEqual([111, 222, 333]);
  });

  it('a caps-silent peer\'s first pong grows the target set synchronously — the batch gate closes within the same tick, not just at the next pingAgents (re-review N1)', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    await bus.deliver(capsDeclaration([CAP_VOICE_BATCH]));
    await store.pingAgents(); // batching gate active for peer A alone

    // Two frames buffer under the cap gate.
    encodeVoiceFrame(111);
    encodeVoiceFrame(222);
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);

    // A caps-silent peer B's FIRST pong arrives — no pingAgents() call
    // anywhere in this test after this point. B enters _knownAgents ->
    // _activeAgents -> _presentPeers -> _signalsTargets synchronously off
    // the pong handler, inside this single bus.deliver.
    await bus.deliver(
      message(
        peerBKey,
        'PongUi',
        JSON.stringify({
          formatVersion: 1,
          data: { connectionStatuses: {} },
        })
      )
    );
    expect(get(store._signalsTargets).has(peerB)).toBe(true);

    // The next chunk, encoded in the SAME tick, must go out legacy
    // per-frame to both targets — NOT a v2 batch, which every released
    // build's decoder would throw on for B (bare JSON.parse, seq
    // undefined). Before the fix, `_voiceBatchCapAllTargets` stayed
    // stale-true from peer A's tick and this chunk (plus the 2 buffered)
    // would have gone out as one v2 batch instead.
    encodeVoiceFrame(333);
    await flush();
    const sent = moduleData(bus, 'voice');
    expect(sent).toHaveLength(3);
    const parsed = sent.map(s => JSON.parse(s.chunk) as { v?: number });
    expect(parsed.map(p => p.v)).toEqual([undefined, undefined, undefined]);
  });

  it("pumpEncoder's mute branch clears the batch buffer — a mute discards stale pre-mute frames (final-review wave F4)", async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    await bus.deliver(capsDeclaration([CAP_VOICE_BATCH]));
    await store.pingAgents(); // F2: batching gate is a once-per-tick cache

    // Two frames buffer pre-mute — stale audio by unmute time.
    encodeVoiceFrame(111);
    encodeVoiceFrame(222);
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);

    // Drive pumpEncoder's mute branch directly against a disabled track,
    // without standing up a full WebCodecs/MediaStreamTrackProcessor
    // harness: one queued read, then done. If the mute check regressed
    // and `encode()` ran anyway, the stub throws and fails the test loudly.
    const controller = voiceController as unknown as {
      micHandle: { track: { enabled: boolean } } | null;
      pipelineGeneration: number;
      encoder: { state: string; encode: (d: unknown) => void } | null;
      encoderReader: {
        read: () => Promise<{ done: boolean; value?: unknown }>;
      } | null;
      pumpEncoder(gen: number): Promise<void>;
    };
    controller.micHandle = { track: { enabled: false } };
    controller.encoder = {
      state: 'configured',
      encode: () => {
        throw new Error('must not encode while the track is disabled');
      },
    };
    let reads = 0;
    controller.encoderReader = {
      read: async () => {
        reads += 1;
        return reads === 1 ? { done: false, value: {} } : { done: true };
      },
    };
    controller.pipelineGeneration += 1;
    await controller.pumpEncoder(controller.pipelineGeneration);

    // Re-enable and encode fresh frames: the first post-unmute flush must
    // carry only the fresh trio, not the stale pre-mute pair.
    encodeVoiceFrame(444);
    encodeVoiceFrame(555);
    encodeVoiceFrame(666);
    await flush();
    const sent = moduleData(bus, 'voice');
    expect(sent).toHaveLength(1);
    const batch = JSON.parse(sent[0].chunk) as {
      frames: Array<{ seq: number; ts: number }>;
    };
    expect(batch.frames.map(f => f.ts)).toEqual([444, 555, 666]);
    expect(batch.frames.map(f => f.seq)).toEqual([3, 4, 5]);
  });

  it('recovery walks paused → voice-only → full via the per-tick re-evaluation, and sends resume (review I3)', async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));

    // Collapse: sends stop.
    await bus.deliver(pongEchoing(started, SIGNALS_RTT_COLLAPSED_MS + 1_000));
    await store.pingAgents();
    expect(store.signalsCadence()).toEqual({
      mode: 'paused',
      reason: 'rtt-collapsed',
    });
    encodeVoiceFrame();
    sendFilmstripClip();
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);
    expect(moduleData(bus, 'video-filmstrip')).toHaveLength(0);

    // Fresh pongs walk the EWMA down; each ping cycle re-evaluates. The
    // hysteresis recovers ONE level per evaluation — never paused → full
    // in a single tick.
    const modes = [
      'paused',
      ...(await walkRecovery(started, mode => mode !== 'full')),
    ];
    const transitions = modes.filter((m, i) => i === 0 || m !== modes[i - 1]);
    expect(transitions).toEqual(['paused', 'voice-only', 'full']);

    // Sends actually resume at full — voice AND filmstrip. This is the
    // permanently-muted-audio pin: if the per-tick re-evaluation ever
    // breaks, the walk above never reaches 'full' and this fails.
    encodeVoiceFrame();
    sendFilmstripClip();
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(1);
    expect(moduleData(bus, 'video-filmstrip')).toHaveLength(1);
  });

  it("a rejoining peer does not inherit the departed session's collapsed RTT EWMA (review M5)", async () => {
    const started = makeStarted();
    const { store, clock, bus } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    await bus.deliver(pongEchoing(started, SIGNALS_RTT_COLLAPSED_MS + 1_000));
    await store.pingAgents();
    expect(store.signalsCadence().mode).toBe('paused');

    // The peer LEAVES: the media peer-leave cleanup row deletes their
    // _signalsRttEwma entry (closeCleanupPlan clearSignalsRttEwma).
    await bus.deliver(message(peerAKey, 'LeaveUi', ''));

    // They rejoin ping-fresh. With no sample, the very next evaluation is
    // full/no-sample — not a ~5-tick hysteresis walk-back against the
    // departed session's collapsed EWMA on a healthy network.
    store._knownAgents.set(knownFresh(clock, peerA));
    await store.pingAgents();
    expect(store.signalsCadence()).toEqual({
      mode: 'full',
      reason: 'no-sample',
    });
  });
});
