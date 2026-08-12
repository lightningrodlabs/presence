import { describe, expect, it, afterEach, vi } from 'vitest';
import { get } from '@holochain-open-dev/stores';
import { encodeHashToBase64 } from '@holochain/client';
import type { AgentPubKey } from '@holochain/client';
import { StreamsStore, SDP_EXCHANGE_TIMEOUT } from '../streams-store';
import { ManualClock } from '../clock.testing';
import { makeFakeDeps, FakeLogger } from '../store-deps.testing';
import type { FakeDeps } from '../store-deps.testing';
import {
  PING_INTERVAL,
  PRESENT_STALENESS_MS,
  SIGNAL_CARRIER_DOWN_MS,
} from '../presence-policy';
import {
  SIGNALS_RTT_COLLAPSED_MS,
  SIGNALS_RTT_DEGRADED_MS,
} from '../transport/signals-cadence-policy';
import { CAP_VOICE_BATCH } from '../transport/wire-contract';
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
const peerAKey = new Uint8Array(39).fill(2) as AgentPubKey;
const peerA = encodeHashToBase64(peerAKey);
const peerBKey = new Uint8Array(39).fill(3) as AgentPubKey;
const peerB = encodeHashToBase64(peerBKey);

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

  /** Arm the voice gate: a present signals target + a held mic. */
  function armVoice(started: Started) {
    const { store, clock } = started;
    store._knownAgents.set(knownFresh(clock, peerA));
    (store as unknown as { _webrtcMicHandle: unknown })._webrtcMicHandle = {
      release: () => {},
    };
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
    (
      started.store as unknown as { _webrtcCameraHandle: unknown }
    )._webrtcCameraHandle = { release: () => {} };

    await tick(started);
    expect(spy).toHaveBeenCalledTimes(1);
    await tick(started);
    expect(spy).toHaveBeenCalledTimes(2);
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

    // The attempt never connects: ITS OWN timer fires and tears it down.
    clock.advance(SDP_EXCHANGE_TIMEOUT);
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

    // Halfway through the window the transport replaces the FSM in
    // place (the adopt route) — a successor attempt now owns the slot.
    clock.advance(SDP_EXCHANGE_TIMEOUT / 2);
    media.emitPhase(peerA, 'conn-2', 'signaling');
    expect(get(store._openConnections)[peerA].connectionId).toBe('conn-2');

    // The predecessor's deadline passes. Before §9 item 5 the untracked
    // timer saw SdpExchange status + an unconnected slot and destroyed
    // the SUCCESSOR. Attempt-scoping makes it a no-op.
    clock.advance(SDP_EXCHANGE_TIMEOUT / 2);
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
   *  foldSignalsRtt input (first sample seeds the EWMA at the raw RTT). */
  function pongEchoing(started: Started, rttMs: number): RoomSignal {
    return message(
      peerAKey,
      'PongUi',
      JSON.stringify({
        formatVersion: 1,
        data: { connectionStatuses: {}, pingT0: started.clock.now() - rttMs },
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
    expect(batch1.frames.map(f => f.seq)).toEqual([0, 1, 2]);
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
    expect(batch2.frames.map(f => f.seq)).toEqual([3, 4, 5]);
    expect(batch2.frames[0].red!.map(f => f.seq)).toEqual([1, 2]);
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

    encodeVoiceFrame();
    encodeVoiceFrame();
    await voiceController.stopCapture();
    encodeVoiceFrame(); // starts a NEW batch; must not flush the old one
    await flush();
    expect(moduleData(bus, 'voice')).toHaveLength(0);
  });
});
