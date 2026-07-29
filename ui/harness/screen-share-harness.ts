/**
 * Screen-share field harness — page side (Phase 3.5).
 *
 * One page = one agent running BOTH production screen-share transports —
 * `screenShareOutTransport` (sharer role) and `screenShareInTransport`
 * (viewer role), each a real `FsmTransport`/`ConnectionManager` over a
 * real `RTCPeerConnection` (loopback ICE + DTLS) — with signaling relayed
 * over a `BroadcastChannel` carrying the production `SdpFsmScreen`
 * envelope shape (`connection_id`/`peer_session_id`/`epoch`/`dir`/`data`),
 * fire-and-forget like Holochain remote signals.
 *
 * This exists because the Phase 3 screen-share port shipped with no field
 * validation at all (the Phase 3 review's F4; the assessment's
 * unscheduled-defects row). The three things only a real browser can
 * falsify:
 *
 *   1. Establishment: a sharer-side offer builds the viewer's FSM lazily
 *      (no reservation handshake exists anymore) and real ICE/DTLS comes
 *      up carrying a real captured video track.
 *   2. Role-routing under MUTUAL share: A→B and B→A are two independent
 *      connections on two transport pairs; the `dir` tag — not
 *      connectionId — is what keeps their signals apart. A mis-route here
 *      creates a phantom FSM on the wrong transport.
 *   3. Teardown on a silent peer drop: real ICE consent loss walks the
 *      production phases and the terminal `failed`/`closed` clears the
 *      slot and the `_screenShareStreams` mirror.
 *
 * Fidelity statement, same shape as carrier-handover-harness.ts:
 *
 *   REAL:    RTCPeerConnection, ICE/DTLS, ConnectionManager, FsmTransport,
 *            canvas.captureStream video track, decideScreenSignalRoute
 *            (the production routing decision, executed), routeTransportPhase,
 *            decideSlotWrite (the slot rules the store executes).
 *   MODELED: only the glue — the `_subscribeScreenShareTransport` /
 *            `handleSdpFsmScreen` / `_ensureOutgoingScreenShare` wiring is
 *            mirrored here because `StreamsStore` cannot run without
 *            Holochain (§3.6; Phase 6 retires this gap).
 *
 * Exposes `window.screenHarness`.
 */

import { FsmTransport } from '../src/transport/fsm/fsm-transport';
import {
  routeTransportPhase,
  decideSlotWrite,
  type SlotEvent,
} from '../src/transport/media-event-policy';
import { decideScreenSignalRoute } from '../src/transport/screen-signal-policy';
import type { OutgoingSignal, TransportEvent, ConnectionPhase } from '../src/transport/types';
import { DefaultReconnectPolicy } from '@lightningrodlabs/webrtc-peer';

type Role = 'out' | 'in';

type TimelineEntry = {
  /** ms since harness start */
  t: number;
  /** Which local transport the event came from. */
  role: Role;
  phase: ConnectionPhase;
  connectionId: string;
  route: string;
  /** The executed SlotWrite: install/replace/set-connected/clear, or
   *  none/<reason> (kept, superseded, no-slot), or '-' for ignore routes.
   *  `replace` is the adopt path — the FSM was replaced in place with no
   *  close event (§3.1(c)); `none/superseded` is the guard dropping a
   *  stale event from the replaced connection (the Phase 3 review's F1
   *  semantics, field-asserted by the spec). */
  write: string;
  outSlotConnected: boolean | null;
  inSlotConnected: boolean | null;
};

type Slot = { connectionId: string; connected: boolean };

type HarnessState = {
  me: string;
  peer: string;
  started: boolean;
  sharing: boolean;
  out: { phase: ConnectionPhase | 'none'; slot: Slot | null };
  in: { phase: ConnectionPhase | 'none'; slot: Slot | null };
  /** Mirror of `_screenShareStreams[peer]`: video-track count of the
   *  received share, present iff a stream arrived and its slot survives. */
  streams: Record<string, { video: number }>;
  /** Signal-routing tallies. `dropped` counts decideScreenSignalRoute
   *  drop verdicts — malformed/unknown dir. */
  routed: { toIn: number; toOut: number; dropped: number };
  timeline: TimelineEntry[];
};

const params = new URLSearchParams(location.search);
const ME = params.get('me') ?? 'A';
const PEER = params.get('peer') ?? (ME === 'A' ? 'B' : 'A');
/** Starting connection epoch (`?epoch0=N`). Production's per-peer epoch
 *  counter is session-scoped; a page that re-initiates WITHIN a session
 *  allocates a higher epoch than the attempt the viewer still holds —
 *  the manager's documented supersede route. This seam lets the spec
 *  drive that route deterministically. (A plain reload resets epochs to
 *  1 — the equal-epoch case — which the FSM absorbs internally with a
 *  fresh RtcPeer, same connectionId, no slot events at all; the spec
 *  documents that too.) */
const EPOCH0 = parseInt(params.get('epoch0') ?? '0', 10) || 0;
const T0 = performance.now();

// Fire-and-forget signaling relay; a closed page is silence, not an error.
const bus = new BroadcastChannel('screen-share-signaling');

// One slot table per direction — the shape of
// `_screenShareConnectionsOutgoing` / `_screenShareConnectionsIncoming`,
// one peer wide.
const outSlots: Record<string, Slot> = {};
const inSlots: Record<string, Slot> = {};
// Mirror of `_screenShareStreams` (incoming shares only).
const streams: Record<string, { video: number }> = {};
const routed = { toIn: 0, toOut: 0, dropped: 0 };
const timeline: TimelineEntry[] = [];

let outTransport: FsmTransport | null = null;
let inTransport: FsmTransport | null = null;
let shareStream: MediaStream | null = null;
let epochCounter = EPOCH0;

function makeTransport(dir: 'sharer' | 'viewer'): FsmTransport {
  return new FsmTransport({
    myAgentId: ME,
    onOutgoingSignal: (signal: OutgoingSignal) => {
      // The production wire payload for 'SdpFsmScreen' (streams-store
      // start()), plus from/to for the bus. JSON round-trip as production
      // does — also load-bearing: an offer's payload is an
      // RTCSessionDescription platform object that structured clone
      // rejects; toJSON flattens it.
      bus.postMessage(
        JSON.parse(
          JSON.stringify({
            from: ME,
            to: signal.to,
            connection_id: signal.connectionId,
            peer_session_id: signal.peerSessionId,
            epoch: signal.epoch,
            dir,
            data: signal.data,
          }),
        ),
      );
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
}

/**
 * `_subscribeScreenShareTransport`'s connection-state-change arm: route via
 * the production policy, then execute the production slot decision against
 * the role's slot table. The `_screenShareStreams` mirror dies with the
 * incoming slot on a `clear` write, exactly as `_handleScreenShareClosed`
 * deletes it.
 */
function applyPhaseEvent(
  role: Role,
  event: Extract<TransportEvent, { type: 'connection-state-change' }>,
): void {
  const slots = role === 'out' ? outSlots : inSlots;
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

  let writeLabel = '-';
  if (slotEvent) {
    const write = decideSlotWrite(slotEvent, event.connectionId, slots[event.peer]);
    writeLabel = write.write === 'none' ? `none/${write.reason}` : write.write;
    switch (write.write) {
      case 'install':
      case 'replace':
      case 'set-connected':
        slots[event.peer] = write.slot;
        break;
      case 'clear':
        delete slots[event.peer];
        if (role === 'in') delete streams[event.peer];
        break;
      case 'none':
        break;
    }
  }

  timeline.push({
    t: Math.round(performance.now() - T0),
    role,
    phase: event.phase,
    connectionId: event.connectionId,
    route: `${route.handler}/${route.reason}`,
    write: writeLabel,
    outSlotConnected: outSlots[event.peer]?.connected ?? null,
    inSlotConnected: inSlots[event.peer]?.connected ?? null,
  });
  render();
}

/** `handleSdpFsmScreen`: route by the SENDER's declared role, executing
 *  the production decision — drop-not-guess on anything malformed. */
function handleIncoming(envelope: {
  from: string;
  connection_id: string;
  peer_session_id?: number;
  epoch?: number;
  dir?: unknown;
  data: unknown;
}): void {
  const verdict = decideScreenSignalRoute(envelope.dir);
  if (verdict.route === 'drop') {
    routed.dropped += 1;
    render();
    return;
  }
  const transport = verdict.route === 'incoming-share' ? inTransport : outTransport;
  if (verdict.route === 'incoming-share') routed.toIn += 1;
  else routed.toOut += 1;
  transport?.processIncomingSignal({
    from: envelope.from,
    connectionId: envelope.connection_id,
    peerSessionId: envelope.peer_session_id,
    epoch: envelope.epoch,
    data: envelope.data,
  });
  render();
}

function start(): void {
  if (outTransport) return;
  outTransport = makeTransport('sharer');
  inTransport = makeTransport('viewer');

  outTransport.onAny((event: TransportEvent) => {
    if (event.type === 'connection-state-change') applyPhaseEvent('out', event);
  });
  inTransport.onAny((event: TransportEvent) => {
    if (event.type === 'connection-state-change') applyPhaseEvent('in', event);
    if (event.type === 'remote-stream') {
      // `_handleScreenShareRemoteStream`: record the share for paint.
      streams[event.peer] = { video: event.stream.getVideoTracks().length };
      render();
    }
  });

  bus.onmessage = (msg: MessageEvent) => {
    const envelope = msg.data ?? {};
    if (envelope.to !== ME) return;
    handleIncoming(envelope);
  };

  render();
}

/** A real, continuously-drawn video source without getDisplayMedia's
 *  picker: canvas.captureStream produces a live MediaStreamTrack that
 *  real senders encode. */
function makeShareStream(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d')!;
  let frame = 0;
  setInterval(() => {
    frame += 1;
    ctx.fillStyle = `hsl(${(frame * 7) % 360}, 60%, 40%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = '24px monospace';
    ctx.fillText(`${ME} f${frame}`, 12, 40);
  }, 100);
  return canvas.captureStream(10);
}

/** `_ensureOutgoingScreenShare`: idempotent; installs the outgoing slot
 *  with the FSM-allocated connectionId. (The production capability gate
 *  is omitted — both pages are this build.) */
function share(): void {
  if (!outTransport) return;
  if (outSlots[PEER]) return;
  if (!shareStream) shareStream = makeShareStream();
  outTransport.setLocalStream(shareStream);
  epochCounter += 1;
  const connectionId = outTransport.ensureConnection(PEER, { epoch: epochCounter });
  outSlots[PEER] = { connectionId, connected: false };
  render();
}

/** Test seam: feed a raw envelope from the peer through the production
 *  routing decision (e.g. a malformed `dir`) without bus plumbing. */
function injectIncoming(dir: unknown): void {
  handleIncoming({
    from: PEER,
    connection_id: 'bogus-conn',
    dir,
    data: { type: 'offer', payload: { type: 'offer', sdp: 'v=0' } },
  });
}

function state(): HarnessState {
  return {
    me: ME,
    peer: PEER,
    started: outTransport !== null,
    sharing: shareStream !== null,
    out: { phase: outTransport?.getPhase(PEER) ?? 'none', slot: outSlots[PEER] ?? null },
    in: { phase: inTransport?.getPhase(PEER) ?? 'none', slot: inSlots[PEER] ?? null },
    streams,
    routed,
    timeline,
  };
}

function render(): void {
  const el = document.getElementById('state');
  if (el) el.textContent = JSON.stringify(state(), null, 2);
}

(globalThis as any).screenHarness = { start, share, injectIncoming, state };
render();
