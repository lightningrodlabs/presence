/**
 * Carrier-handover field harness — page side (Phase 1.5 item 4).
 *
 * One page = one agent. It runs the PRODUCTION transport stack over a REAL
 * `RTCPeerConnection` — `FsmTransport` wrapping `ConnectionManager`, real
 * ICE, real DTLS, real data channel on the loopback interface — with
 * signaling relayed over a `BroadcastChannel` standing in for Holochain
 * remote signals (same fire-and-forget, no delivery guarantee semantics:
 * a closed page simply stops answering, exactly like a vanished peer).
 *
 * On every `connection-state-change` it applies the PRODUCTION decision
 * functions — `routeTransportPhase` for the slot, `computeSignalsTargets`
 * for the carrier set — to a slot table shaped like
 * `_openConnections[peer]`. So the fidelity statement is:
 *
 *   REAL:    RTCPeerConnection, ICE/DTLS state machine, ConnectionManager,
 *            FsmTransport, routeTransportPhase, decideSlotWrite (the slot
 *            rules the store itself executes), carrierFor,
 *            computeSignalsTargets, reconnect/backoff behavior.
 *   MODELED: only the glue — route.handler → SlotEvent, and applying the
 *            returned SlotWrite to a plain table (`StreamsStore` itself
 *            cannot run without Holochain — MAINTAINABILITY_ASSESSMENT.md
 *            §3.6).
 *
 * A divergence in that glue is the kind of bug the harness cannot catch —
 * Phase 6 (constructible orchestrator) retires the gap entirely; until then
 * this is the highest-fidelity check the carrier logic gets against a real
 * network stack. (The slot rules themselves stopped being glue when they
 * moved into `decideSlotWrite`: the store executes the same function.)
 *
 * Timeouts and the reconnect budget are shortened via the transport's test
 * seams so a silent peer drop reaches `failed` in tens of seconds, not
 * minutes. The PHASES traversed are the production ones; only the dwell in
 * each is compressed.
 *
 * Exposes `window.carrierHarness`.
 */

import { FsmTransport } from '../src/transport/fsm/fsm-transport';
import {
  routeTransportPhase,
  decideSlotWrite,
  type SlotEvent,
} from '../src/transport/media-event-policy';
import { computeSignalsTargets, carrierFor } from '../src/transport/carrier-coverage';
import type { OutgoingSignal, TransportEvent, ConnectionPhase } from '../src/transport/types';
import { DefaultReconnectPolicy } from '@lightningrodlabs/webrtc-peer';

type TimelineEntry = {
  /** ms since harness start */
  t: number;
  phase: ConnectionPhase;
  connectionId: string;
  route: string;
  /** Whether the peer is a signals target AFTER applying this event. */
  onSignals: boolean;
  /** Slot's `connected` claim AFTER applying this event. */
  slotConnected: boolean | null;
};

type HarnessState = {
  me: string;
  peer: string;
  started: boolean;
  phase: ConnectionPhase | 'none';
  carrier: 'webrtc' | 'signals';
  onSignals: boolean;
  slot: { connectionId: string; connected: boolean } | null;
  timeline: TimelineEntry[];
};

const params = new URLSearchParams(location.search);
const ME = params.get('me') ?? 'A';
const PEER = params.get('peer') ?? (ME === 'A' ? 'B' : 'A');
const T0 = performance.now();

// Signaling relay. Fire-and-forget like Holochain remote signals: no acks,
// no queue for absent listeners — a closed page is silence, not an error.
const bus = new BroadcastChannel('carrier-handover-signaling');

// The slot table this page's carrier decision reads — the shape of
// `_openConnections`, one peer wide.
const slots: Record<string, { connectionId: string; connected: boolean }> = {};
const timeline: TimelineEntry[] = [];

let transport: FsmTransport | null = null;

function onSignalsNow(): boolean {
  return computeSignalsTargets({
    presentPeers: [PEER],
    openConnections: slots,
  }).has(PEER);
}

/**
 * `StreamsStore._dispatchMediaEvent`'s connection-state-change arm: route
 * via the production policy, then EXECUTE the production slot decision —
 * `decideSlotWrite` is the same function the store runs, so the slot rules
 * here cannot drift from the app's (PR #3 review finding F1: the previous
 * hand-written mirror had already diverged on the adopt and
 * connected-supersede paths before it merged). What remains modeled is
 * only this glue: route.handler → SlotEvent, and applying the returned
 * write to a plain table.
 */
function applyPhaseEvent(event: Extract<TransportEvent, { type: 'connection-state-change' }>): void {
  const route = routeTransportPhase({
    phase: event.phase,
    connectionId: event.connectionId,
    openConnectionId: slots[event.peer]?.connectionId,
  });

  const slotEvent: SlotEvent | null =
    route.handler === 'start-ice-monitor'
      ? { kind: 'signaling', slot: route.slot }
      : route.handler === 'media-connected'
        ? { kind: 'connected' }
        : route.handler === 'media-closed'
          ? { kind: 'closed' }
          : null;

  if (slotEvent) {
    const write = decideSlotWrite(slotEvent, event.connectionId, slots[event.peer]);
    switch (write.write) {
      case 'install':
      case 'replace':
      case 'set-connected':
        slots[event.peer] = write.slot;
        break;
      case 'clear':
        delete slots[event.peer];
        break;
      case 'none':
        break;
    }
  }

  timeline.push({
    t: Math.round(performance.now() - T0),
    phase: event.phase,
    connectionId: event.connectionId,
    route: `${route.handler}/${route.reason}`,
    onSignals: onSignalsNow(),
    slotConnected: slots[event.peer]?.connected ?? null,
  });
  render();
}

function start(): void {
  if (transport) return;
  transport = new FsmTransport({
    myAgentId: ME,
    onOutgoingSignal: (signal: OutgoingSignal) => {
      // JSON round-trip, as production does over the Holochain wire
      // (streams-store wraps the envelope in JSON.stringify). Also
      // load-bearing here: an offer's payload is an RTCSessionDescription
      // platform object, which structured clone rejects (DataCloneError);
      // toJSON flattens it to { type, sdp }.
      bus.postMessage(JSON.parse(JSON.stringify({ from: ME, ...signal })));
    },
    // Loopback host candidates only — no external STUN in CI.
    iceServers: [],
    trickleICE: true,
    // Compress the dwell in each phase, not the phases themselves.
    configOverrides: {
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
  });

  transport.onAny((event: TransportEvent) => {
    if (event.type === 'connection-state-change') applyPhaseEvent(event);
  });

  bus.onmessage = (msg: MessageEvent) => {
    const { from, to, connectionId, peerSessionId, epoch, data } = msg.data ?? {};
    if (to !== ME || !transport) return;
    transport.processIncomingSignal({ from, connectionId, peerSessionId, epoch, data });
  };

  render();
}

function connect(): void {
  transport?.ensureConnection(PEER, {});
}

function state(): HarnessState {
  const slot = slots[PEER] ?? null;
  return {
    me: ME,
    peer: PEER,
    started: transport !== null,
    phase: transport?.getPhase(PEER) ?? 'none',
    carrier: carrierFor(slot ?? undefined).carrier,
    onSignals: onSignalsNow(),
    slot,
    timeline,
  };
}

function render(): void {
  const el = document.getElementById('state');
  if (el) el.textContent = JSON.stringify(state(), null, 2);
}

(globalThis as any).carrierHarness = { start, connect, state };
render();
