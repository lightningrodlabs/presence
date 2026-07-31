import { describe, expect, it, afterEach } from 'vitest';
import { get } from '@holochain-open-dev/stores';
import { encodeHashToBase64 } from '@holochain/client';
import type { AgentPubKey } from '@holochain/client';
import { StreamsStore } from '../streams-store';
import { ManualClock } from '../clock.testing';
import { makeFakeDeps, FakeLogger } from '../store-deps.testing';
import type { FakeDeps } from '../store-deps.testing';
import { PING_INTERVAL, PRESENT_STALENESS_MS } from '../presence-policy';
import { voiceController } from '../room/modules/voice';
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
