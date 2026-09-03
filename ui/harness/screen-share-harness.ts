/**
 * Screen-share field harness — page side (Phase 3.5; rebuilt by Phase 6.5
 * to run the REAL StreamsStore).
 *
 * One page = one agent running the production orchestrator: a real
 * `StreamsStore` (Phase 6 deps record) whose two screen-share transports
 * are real `FsmTransport`s over real `RTCPeerConnection`s (loopback ICE +
 * DTLS). Signaling rides a `BroadcastChannel` bus with Holochain's
 * fire-and-forget semantics, in the production `SdpFsmScreen` wire
 * envelope — produced and parsed by the store's own glue
 * (`start()`'s onOutgoingSignal wrap / `ScreenShareLinks.handleSdpFsmScreen`,
 * ui/src/screen-share-links.ts), not by this file. Slot writes, role
 * routing, the `_peerRecords` screenShareStream mirror, and outgoing-share
 * initiation (`ScreenShareLinks.ensureOutgoingScreenShare` off the real
 * ping/pong cycle) are all store-decomposition round two, Task 5 code
 * (previously `StreamsStore._ensureOutgoingScreenShare` /
 * `StreamsStore.handleSdpFsmScreen`). The Phase 3.5 mirror of that glue
 * is DELETED per one-authority (working agreement 1).
 *
 * What the harness still supplies (declared, not mirrored logic):
 *   - the deps binding and dwell compression, identical in role to
 *     carrier-handover-harness.ts (see its header);
 *   - the ping-loop arming, peer seeding, and conversation-module
 *     activation (`_syncConversationPayload` — the real path) that give
 *     both builds their wire caps, since `CAP_SDP_FSM_SCREEN` gates every
 *     screen link;
 *   - `share()` = ACQUISITION INJECTION ONLY: it assigns a
 *     `canvas.captureStream` track to `store.screenShareStream`, standing
 *     exactly where `screenShareOn`'s `getUserMedia` stands — that call
 *     needs Electron's `chromeMediaSource: 'desktop'` and cannot run in
 *     plain Chromium (the declared out-of-scope media-acquisition area).
 *     Everything downstream — per-peer initiation, setLocalStream, slot
 *     install — is the store's pong-driven path;
 *   - the `epoch0` seam: production's per-peer epoch counter is
 *     session-scoped, so a re-initiating SHARER allocates a later
 *     generation than the attempt the viewer still holds. A fresh page
 *     starts at 0; `?epoch0=N` pre-seeds the store's private counter to
 *     stand in for the same-session re-initiation the supersede route
 *     needs. (A plain reload is the equal-epoch case — absorbed inside
 *     the FSM, no slot events; the spec documents that separately.)
 *
 * Timeline `write` labels are DERIVED from the real slot state observed
 * after the store applied each event (prev/next comparison) — a readable
 * projection of what the store did, never a second decision path.
 *
 * Exposes `window.screenHarness`.
 */

import { encodeHashToBase64, decodeHashFromBase64 } from '@holochain/client';
import type { AgentPubKey } from '@holochain/client';
import { get } from '@holochain-open-dev/stores';
import { DefaultReconnectPolicy } from '@lightningrodlabs/webrtc-peer';
import { StreamsStore } from '../src/streams-store';
import { PresenceLogger } from '../src/logging';
import { systemClock } from '../src/clock';
import { FsmTransport } from '../src/transport/fsm/fsm-transport';
import { PING_INTERVAL } from '../src/presence-policy';
import type { StreamsStoreDeps } from '../src/store-deps';
import type { RoomSignal } from '../src/types';
import type { ConnectionPhase, PeerTransport } from '../src/transport/types';

type Role = 'out' | 'in';

type Slot = { connectionId: string; connected: boolean };

type TimelineEntry = {
  /** ms since harness start */
  t: number;
  role: Role;
  phase: ConnectionPhase;
  connectionId: string;
  /** Derived from the REAL slot state around this event:
   *  install / replace / set-connected / clear / none. `replace` is the
   *  adopt path — the FSM was replaced in place with no close event
   *  (§3.1(c)); `none` covers guarded/no-op events (stale connectionIds,
   *  duplicate closes, recovery phases). */
  write: string;
  outSlotConnected: boolean | null;
  inSlotConnected: boolean | null;
};

type HarnessState = {
  me: string;
  peer: string;
  started: boolean;
  sharing: boolean;
  peerPresent: boolean;
  out: { phase: ConnectionPhase | 'none'; slot: Slot | null };
  in: { phase: ConnectionPhase | 'none'; slot: Slot | null };
  /** The store's real `_peerRecords` screenShareStream mirror, video-track counts. */
  streams: Record<string, { video: number }>;
  /** Observe-only tallies. toIn/toOut count arriving envelopes by their
   *  raw `dir` tag (the store does the actual routing); `dropped` counts
   *  the store's own drop verdicts, read from its forensic log. */
  routed: { toIn: number; toOut: number; dropped: number };
  /** Store-logged 'Superseded' adopt events for the peer (screen path). */
  supersededCount: number;
  timeline: TimelineEntry[];
};

const params = new URLSearchParams(location.search);
const ME = params.get('me') ?? 'A';
const PEER = params.get('peer') ?? (ME === 'A' ? 'B' : 'A');
const EPOCH0 = parseInt(params.get('epoch0') ?? '0', 10) || 0;
const T0 = performance.now();

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

// --- the bus (see carrier-handover-harness.ts) ---
const channel = new BroadcastChannel('screen-share-signaling');
const busHandlers = new Set<(signal: RoomSignal) => void | Promise<void>>();
const routed = { toIn: 0, toOut: 0 };

function deliver(from: string, msgType: string, payload: string): void {
  // Observe-only tally of arriving screen envelopes by their raw dir tag;
  // the store's ScreenShareLinks.handleSdpFsmScreen does the actual
  // routing (and the dropping — see `droppedCount`).
  if (msgType === 'SdpFsmScreen') {
    try {
      const dir = JSON.parse(payload)?.dir;
      if (dir === 'sharer') routed.toIn += 1;
      else if (dir === 'viewer') routed.toOut += 1;
    } catch {
      // unparseable payloads are the store's problem, deliberately
    }
  }
  const signal: RoomSignal = {
    type: 'Message',
    from_agent: decodeHashFromBase64(from),
    msg_type: msgType,
    payload,
  };
  busHandlers.forEach(handler => handler(signal));
}

channel.onmessage = (msg: MessageEvent) => {
  const { from, to, msgType, payload } = msg.data ?? {};
  if (to !== MY_B64) return;
  deliver(from, msgType, payload ?? '');
};

const logger = new PresenceLogger();

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
let shareStream: MediaStream | null = null;

function slotOf(role: Role): Slot | null {
  if (!store) return null;
  const table =
    role === 'out'
      ? get(store._screenShareConnectionsOutgoing)
      : get(store._screenShareConnectionsIncoming);
  const slot = table[PEER_B64];
  return slot
    ? { connectionId: slot.connectionId, connected: !!slot.connected }
    : null;
}

/** Derive the write label from the real slot before/after the event. */
function deriveWrite(prev: Slot | null, next: Slot | null): string {
  if (!prev && next) return 'install';
  if (prev && !next) return 'clear';
  if (prev && next && prev.connectionId !== next.connectionId) return 'replace';
  if (prev && next && !prev.connected && next.connected) return 'set-connected';
  return 'none';
}

function droppedCount(): number {
  return logger
    .getRecentCustomLogs()
    .filter(l => l.log.startsWith('Dropped SdpFsmScreen')).length;
}

function supersededCount(): number {
  const events = logger.getRecentAgentEvents()[PEER_B64] ?? [];
  return events.filter(
    e => e.event === 'Superseded' && e.detail?.includes('screen-transport-replace')
  ).length;
}

function observe(role: Role, transport: PeerTransport): void {
  let prevSlot = slotOf(role);
  transport.onAny(event => {
    if (event.type !== 'connection-state-change') return;
    const nextSlot = slotOf(role);
    timeline.push({
      t: Math.round(performance.now() - T0),
      role,
      phase: event.phase,
      connectionId: event.connectionId,
      write: deriveWrite(prevSlot, nextSlot),
      outSlotConnected: slotOf('out')?.connected ?? null,
      inSlotConnected: slotOf('in')?.connected ?? null,
    });
    prevSlot = nextSlot;
    render();
  });
}

function start(): void {
  if (store) return;
  store = new StreamsStore(deps, async () => '', logger);
  store.start();

  // Observe (never apply) both real screen transports, after the store's
  // own subscriptions so every entry reflects applied state.
  observe('out', store.screenShareOutTransport);
  observe('in', store.screenShareInTransport);

  // The epoch0 seam: pre-seed the store's session-scoped per-peer epoch
  // counter so this page's first share allocates generation EPOCH0+1 —
  // standing in for a sharer that re-initiates WITHIN a session, which is
  // what drives the manager's supersede route on the viewer.
  if (EPOCH0 > 0) {
    store._ensurePeerRecord(PEER_B64).connectionEpoch = EPOCH0;
  }

  // static connect's glue, reproduced: roster + ping cadence. The
  // conversation module is activated through the real path so this
  // build's wire caps (including sdp-fsm-screen) travel in pong metadata
  // — without them the peer's capability gate keeps every screen link
  // closed.
  store._knownAgents.update(agents => {
    agents[PEER_B64] = {
      pubkey: PEER_B64,
      type: 'known',
      lastSeen: undefined,
      appVersion: undefined,
    };
    return agents;
  });
  store._syncConversationPayload({}).catch(() => {});
  store.pingAgents().catch(() => {});
  window.setInterval(() => {
    store?.pingAgents().catch(() => {});
    render();
  }, PING_INTERVAL);

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

/**
 * Acquisition injection — the ONLY stand-in for `screenShareOn`, whose
 * `getUserMedia({chromeMediaSource:'desktop'})` needs Electron. Assigning
 * the stream is all it takes: the store's own pong cycle notices
 * (`handlePingUi`/`handlePongUi` → `ScreenShareLinks.ensureOutgoingScreenShare`),
 * sets the transport's local stream, allocates the epoch, and installs
 * the slot.
 */
function share(): void {
  if (!store || store.screenShareStream) return;
  if (!shareStream) shareStream = makeShareStream();
  store.screenShareStream = shareStream;
  render();
}

/** Test seam: feed a raw envelope from the peer through the store's real
 *  handleSignal → ScreenShareLinks.handleSdpFsmScreen path (e.g. a
 *  malformed `dir`). */
function injectIncoming(dir: unknown): void {
  deliver(
    PEER_B64,
    'SdpFsmScreen',
    JSON.stringify({
      connection_id: 'bogus-conn',
      dir,
      data: { type: 'offer', payload: { type: 'offer', sdp: 'v=0' } },
    }),
  );
}

function state(): HarnessState {
  const stream = store?._peerRecord(PEER_B64)?.screenShareStream;
  return {
    me: ME,
    peer: PEER,
    started: store !== null,
    sharing: !!store?.screenShareStream,
    peerPresent: store ? get(store._presentPeers).includes(PEER_B64) : false,
    out: {
      phase: store?.screenShareOutTransport.getPhase(PEER_B64) ?? 'none',
      slot: slotOf('out'),
    },
    in: {
      phase: store?.screenShareInTransport.getPhase(PEER_B64) ?? 'none',
      slot: slotOf('in'),
    },
    streams: stream ? { [PEER]: { video: stream.getVideoTracks().length } } : {},
    routed: { ...routed, dropped: droppedCount() },
    supersededCount: supersededCount(),
    timeline,
  };
}

function render(): void {
  const el = document.getElementById('state');
  if (el) el.textContent = JSON.stringify(state(), null, 2);
}

(globalThis as any).screenHarness = { start, share, injectIncoming, state };
render();
