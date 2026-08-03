/**
 * Carrier-handover field harness — page side (Phase 1.5 item 4; rebuilt by
 * Phase 6.5 to run the REAL StreamsStore).
 *
 * One page = one agent running the PRODUCTION orchestrator: a real
 * `StreamsStore`, constructed with the Phase 6 deps record and started, so
 * every piece of glue between the wire and the slot table is the store's
 * own — `handleSignal` → ping/pong presence → the InitRequest/InitAccept
 * handshake → `_dispatchMediaEvent` → `routeTransportPhase` →
 * `decideSlotWrite` → the actual `_openConnections` mutation →
 * `computeSignalsTargets` over the real present set. The transports are
 * real `FsmTransport`s over real `RTCPeerConnection`s (loopback ICE +
 * DTLS); signaling rides a `BroadcastChannel` bus with Holochain's
 * fire-and-forget semantics (a closed page is silence, not an error).
 *
 * The Phase 1.5 mirror this file replaced applied `routeTransportPhase` /
 * `decideSlotWrite` to its own slot table and hardcoded the present set —
 * the "MODELED: only the glue" caveat. That mirror is DELETED per
 * one-authority (working agreement 1): the store executes its own glue
 * here, and a divergence in that glue is now a failing harness run, not an
 * invisible gap.
 *
 * What the harness still supplies (declared, not mirrored logic):
 *   - the deps record's production binding (`static connect` needs a
 *     RoomStore/Holochain; this page IS the binder, standing where
 *     `connect` stands): real clock, real page storage, the
 *     BroadcastChannel bus, `navigator.mediaDevices`;
 *   - the transport factory, which passes the store's own options through
 *     to a real `FsmTransport` but compresses the DWELL (timeouts,
 *     reconnect budget) via the transport's test seams and pins
 *     `iceServers: []` so CI never leaves loopback. The PHASES traversed
 *     are the production ones;
 *   - the ping-loop arming and peer seeding that `static connect` does
 *     from `roomStore.allAgents` in production;
 *   - `connect()` = activating the conversation module through the real
 *     `_syncConversationPayload` path — production's "join the call",
 *     which is what arms WebRTC initiation in `handlePongUi`. Capability
 *     declarations then propagate peer-to-peer inside real pong metadata.
 *
 * Consequence of real presence (a deliberate fidelity gain over the
 * mirror): `onSignals` requires the peer to be PRESENT — pong-fresh or
 * media-live — so a silently-dropped peer leaves the signals send set when
 * their pongs go stale, independent of the WebRTC give-up. The spec's
 * carrier assertions therefore key on `carrier` (the slot's claim, the
 * carrier-coverage authority) and use `onSignals` only where presence is
 * guaranteed by flowing pongs.
 *
 * Exposes `window.carrierHarness`.
 */

import { encodeHashToBase64, decodeHashFromBase64 } from '@holochain/client';
import type { AgentPubKey } from '@holochain/client';
import { get } from '@holochain-open-dev/stores';
import { DefaultReconnectPolicy } from '@lightningrodlabs/webrtc-peer';
import { StreamsStore } from '../src/streams-store';
import { PresenceLogger } from '../src/logging';
import { systemClock } from '../src/clock';
import { FsmTransport } from '../src/transport/fsm/fsm-transport';
import { carrierFor } from '../src/transport/carrier-coverage';
import { PING_INTERVAL } from '../src/presence-policy';
import type { StreamsStoreDeps } from '../src/store-deps';
import type { RoomSignal } from '../src/types';
import type { ConnectionPhase } from '../src/transport/types';

type TimelineEntry = {
  /** ms since harness start */
  t: number;
  phase: ConnectionPhase;
  connectionId: string;
  /** Carrier AFTER the store applied this event (carrierFor over the real
   *  `_openConnections` slot — the same authority production reads). */
  carrier: 'webrtc' | 'signals';
  /** Whether the peer is in the real `_signalsTargets` AFTER this event. */
  onSignals: boolean;
  /** The real slot's `connected` claim AFTER this event; null = no slot. */
  slotConnected: boolean | null;
};

type HarnessState = {
  me: string;
  peer: string;
  started: boolean;
  connected: boolean;
  phase: ConnectionPhase | 'none';
  carrier: 'webrtc' | 'signals';
  onSignals: boolean;
  peerPresent: boolean;
  slot: { connectionId: string; connected: boolean } | null;
  timeline: TimelineEntry[];
};

const params = new URLSearchParams(location.search);
const ME = params.get('me') ?? 'A';
const PEER = params.get('peer') ?? (ME === 'A' ? 'B' : 'A');
const T0 = performance.now();

/** Deterministic 39-byte agent key from a name — enough for
 *  encode/decodeHashFromBase64 round-trips; no conductor exists to care. */
function agentKey(name: string): AgentPubKey {
  const bytes = new Uint8Array(39);
  for (let i = 0; i < name.length && i < 39; i += 1) {
    bytes[i] = name.charCodeAt(i);
  }
  return bytes as AgentPubKey;
}

const MY_KEY = agentKey(ME);
const MY_B64 = encodeHashToBase64(MY_KEY);
const PEER_B64 = encodeHashToBase64(agentKey(PEER));

// --- the bus: BroadcastChannel with Holochain remote-signal semantics ---
// Fire-and-forget: no acks, no queue for absent listeners. Payloads are
// the store's own JSON strings (the SDP flattening already happened in
// the store's onOutgoingSignal), so structured clone never sees a
// platform object.
const channel = new BroadcastChannel('carrier-handover-signaling');
const busHandlers = new Set<(signal: RoomSignal) => void | Promise<void>>();
channel.onmessage = (msg: MessageEvent) => {
  const { from, to, msgType, payload } = msg.data ?? {};
  if (to !== MY_B64) return;
  const signal: RoomSignal = {
    type: 'Message',
    from_agent: decodeHashFromBase64(from),
    msg_type: msgType,
    payload: payload ?? '',
  };
  busHandlers.forEach(handler => handler(signal));
};

const deps: StreamsStoreDeps = {
  clock: systemClock,
  storage: {
    local: window.localStorage,
    session: window.sessionStorage,
  },
  bus: {
    myPubKey: MY_KEY,
    onSignal: handler => {
      busHandlers.add(handler);
      return () => busHandlers.delete(handler);
    },
    sendMessage: async (toAgents, msgType, payload = '') => {
      for (const agent of toAgents) {
        channel.postMessage({
          from: MY_B64,
          to: encodeHashToBase64(agent),
          msgType,
          payload,
        });
      }
    },
  },
  // Real FsmTransport with the store's own options (onOutgoingSignal,
  // onTransition — the production glue), dwell compressed via the
  // transport's test seams. iceServers pinned to [] : loopback host
  // candidates only, no external STUN in CI.
  transportFactory: (_purpose, options) =>
    new FsmTransport({
      ...options,
      iceServers: [],
      configOverrides: {
        ...options.configOverrides,
        connectionTimeoutMs: 5_000,
        sdpExchangeTimeoutMs: 4_000,
        dtlsStallTimeoutMs: 3_000,
        iceDisconnectedGraceMs: 1_500,
      },
      reconnectPolicy: new DefaultReconnectPolicy({
        maxAttempts: 2,
        iceRestartMaxAttempts: 1,
        baseDelayMs: 250,
        maxDelayMs: 1_000,
        jitterMs: 100,
      }),
    }),
  mediaDevices: navigator.mediaDevices,
};

const timeline: TimelineEntry[] = [];
let store: StreamsStore | null = null;
let pingLoop: number | undefined;

function carrierNow(): 'webrtc' | 'signals' {
  const slot = store ? get(store._openConnections)[PEER_B64] : undefined;
  return carrierFor(slot).carrier;
}

function onSignalsNow(): boolean {
  return store ? get(store._signalsTargets).has(PEER_B64) : false;
}

/**
 * Construct and start the real store, then stand where `static connect`
 * stands: seed the peer (production seeds `_knownAgents` from
 * `roomStore.allAgents` inside `pingAgents`) and arm the ping loop on the
 * same cadence. Establishment is NOT armed here — that is `connect()`.
 */
function start(): void {
  if (store) return;
  store = new StreamsStore(deps, async () => '', new PresenceLogger());
  store.start();

  // Observe (never apply): record the timeline AFTER the store's own
  // subscription — registered in start(), so it runs first — has applied
  // each event. What lands in `slotConnected`/`carrier` is the store's
  // real state, not a recomputation.
  store.mediaTransport.onAny(event => {
    if (event.type !== 'connection-state-change') return;
    timeline.push({
      t: Math.round(performance.now() - T0),
      phase: event.phase,
      connectionId: event.connectionId,
      carrier: carrierNow(),
      onSignals: onSignalsNow(),
      slotConnected: get(store!._openConnections)[PEER_B64]?.connected ?? null,
    });
    render();
  });

  // static connect's glue, reproduced: peer roster + ping cadence.
  store._knownAgents.update(agents => {
    agents[PEER_B64] = {
      pubkey: PEER_B64,
      type: 'known',
      lastSeen: undefined,
      appVersion: undefined,
    };
    return agents;
  });
  store.pingAgents().catch(() => {});
  pingLoop = window.setInterval(() => {
    store?.pingAgents().catch(() => {});
    render();
  }, PING_INTERVAL);

  render();
}

/**
 * Production's "join the call": activate the conversation module through
 * the real `_syncConversationPayload` path. This is what makes
 * `handlePongUi` start initiating (conversationActive) and what declares
 * this build's wire caps to the peer (inside real pong metadata) so the
 * peer's capability gate opens. WebRTC establishment then happens by
 * itself on the next pong cycles — initiator tie-break, InitRequest,
 * InitAccept, SDP over the bus — all store code.
 */
function connect(): void {
  store?._syncConversationPayload({}).catch(() => {});
}

function state(): HarnessState {
  const slot = store ? (get(store._openConnections)[PEER_B64] ?? null) : null;
  return {
    me: ME,
    peer: PEER,
    started: store !== null,
    connected: !!slot?.connected,
    phase: store?.mediaTransport.getPhase(PEER_B64) ?? 'none',
    carrier: carrierNow(),
    onSignals: onSignalsNow(),
    peerPresent: store ? get(store._presentPeers).includes(PEER_B64) : false,
    slot: slot
      ? { connectionId: slot.connectionId, connected: !!slot.connected }
      : null,
    timeline,
  };
}

function render(): void {
  const el = document.getElementById('state');
  if (el) el.textContent = JSON.stringify(state(), null, 2);
}

(globalThis as any).carrierHarness = { start, connect, state };
void pingLoop;
render();
