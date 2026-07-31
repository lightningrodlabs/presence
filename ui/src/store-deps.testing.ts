/**
 * Scriptable fakes for `StreamsStoreDeps` (Phase 6 item 2). Kept out of
 * `store-deps.ts` so they can never reach the production bundle — nothing
 * under `ui/src` may import this outside a `*.test.ts` or the harness
 * (same rule as `clock.testing.ts`). Phase 6.5 — the harness constructing
 * the real store — is expected to import from here.
 *
 * `FakeTransport` must be able to do the nasty things the field does
 * (working agreement 3's mock-tautology defense):
 *  - vanish with no event (`vanish()` — `ConnectionManager.fsm.destroy()`
 *    emits no transition, so a connection can disappear silently);
 *  - replace an FSM in place (emit `signaling` under a NEW connectionId
 *    with no `closed` for the old one — the §3.1(c) route);
 *  - emit a duplicate `closed` (the trailing duplicate that follows a
 *    `failed`, observed in the field and pinned by Phase 2b/3.5).
 * The wiring tests carry negative controls asserting the fake really
 * produced those shapes (no hidden close, both duplicates emitted).
 */
import { encodeHashToBase64 } from '@holochain/client';
import type { AgentPubKey, AgentPubKeyB64 } from '@holochain/client';
import type { Clock } from './clock';
import { ManualClock } from './clock.testing';
import type { RoomSignal, StreamAndTrackInfo } from './types';
import type { SimpleEvent } from './logging';
import type { SignalMsgType } from './transport/wire-contract';
import type {
  ConnectionId,
  ConnectionPhase,
  FsmTransportOptions,
  IncomingSignal,
  PeerTransport,
  SenderPriorityOutcome,
  TransportEvent,
  TransportEventHandler,
  TransportEventType,
  TransportStats,
  Unsubscribe,
} from './transport';
import type {
  SignalBus,
  StorageDep,
  StreamsStoreDeps,
  TransportPurpose,
} from './store-deps';
import type { PresenceLogger } from './logging';

/** Map-backed KeyValueStore with the Web Storage API subset. */
export class FakeKeyValueStore {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export type SentMessage = {
  /** Recipients, base64-encoded for assertion convenience. */
  to: AgentPubKeyB64[];
  msgType: SignalMsgType;
  payload?: string;
};

/** Recording signal bus. `deliver()` pushes a signal through whatever
 *  handler(s) the store registered — the real `handleSignal` glue. */
export class FakeSignalBus implements SignalBus {
  readonly myPubKey: AgentPubKey;

  /** Every sendMessage call, in order. */
  readonly sent: SentMessage[] = [];

  private handlers = new Set<(signal: RoomSignal) => unknown>();

  constructor(myPubKey: AgentPubKey) {
    this.myPubKey = myPubKey;
  }

  get subscriberCount(): number {
    return this.handlers.size;
  }

  onSignal(handler: (signal: RoomSignal) => unknown): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async sendMessage(
    toAgents: AgentPubKey[],
    msgType: SignalMsgType,
    payload?: string
  ): Promise<void> {
    this.sent.push({
      to: toAgents.map(a => encodeHashToBase64(a)),
      msgType,
      payload,
    });
  }

  /** Deliver an incoming signal to the store and await its processing. */
  async deliver(signal: RoomSignal): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(signal);
    }
  }

  sentOfType(msgType: SignalMsgType): SentMessage[] {
    return this.sent.filter(m => m.msgType === msgType);
  }
}

/**
 * Scriptable PeerTransport. Tests drive it with `emit()` (arbitrary
 * transport events, including the nasty shapes) and script per-peer
 * phase/connectionId; the store's calls are recorded for assertion.
 */
export class FakeTransport implements PeerTransport {
  readonly ownsTransportRecovery = true;

  readonly purpose: TransportPurpose;

  /** The options the store constructed this transport with — tests
   *  inspect the live closures (iceServers/trickleICE) and the
   *  construction-time snapshot (configOverrides.dtlsStallTimeoutMs),
   *  and call `options.onOutgoingSignal` to simulate the transport
   *  producing a signal. */
  readonly options: FsmTransportOptions;

  /** Every event emitted through this fake, in order — the wiring tests'
   *  negative controls read this to prove the nasty shapes were really
   *  produced (e.g. no hidden `closed` before a replacement). */
  readonly emitted: TransportEvent[] = [];

  destroyCount = 0;

  readonly processedSignals: IncomingSignal[] = [];

  readonly ensureCalls: Array<{ peer: AgentPubKeyB64; opts?: unknown }> = [];

  readonly closeCalls: Array<{ peer: AgentPubKeyB64; reason?: string }> = [];

  readonly sentData: Array<{ peer: AgentPubKeyB64; data: unknown }> = [];

  private phases = new Map<AgentPubKeyB64, ConnectionPhase>();

  private connectionIds = new Map<AgentPubKeyB64, ConnectionId>();

  private iceStates = new Map<AgentPubKeyB64, RTCIceConnectionState>();

  private typedHandlers = new Map<TransportEventType, Set<TransportEventHandler>>();

  private anyHandlers = new Set<TransportEventHandler>();

  private nextConnId = 1;

  constructor(purpose: TransportPurpose, options: FsmTransportOptions) {
    this.purpose = purpose;
    this.options = options;
  }

  // --- test scripting surface ---

  /** Emit a transport event into the store's subscription glue. */
  emit(event: TransportEvent): void {
    this.emitted.push(event);
    if (event.type === 'connection-state-change') {
      this.phases.set(event.peer, event.phase);
      if (event.phase === 'closed' || event.phase === 'failed' || event.phase === 'idle') {
        this.connectionIds.delete(event.peer);
      } else {
        this.connectionIds.set(event.peer, event.connectionId);
      }
    }
    for (const handler of [...(this.typedHandlers.get(event.type) ?? [])]) {
      handler(event);
    }
    for (const handler of [...this.anyHandlers]) {
      handler(event);
    }
  }

  /** Convenience: emit a connection-state-change. */
  emitPhase(
    peer: AgentPubKeyB64,
    connectionId: ConnectionId,
    phase: ConnectionPhase,
    previous: ConnectionPhase = 'idle'
  ): void {
    this.emit({ type: 'connection-state-change', peer, connectionId, phase, previous });
  }

  /** The §3.1(c) shape: the connection disappears with NO event at all
   *  (`fsm.destroy()` emits no transition). State is dropped silently. */
  vanish(peer: AgentPubKeyB64): void {
    this.phases.delete(peer);
    this.connectionIds.delete(peer);
  }

  setIceConnectionState(peer: AgentPubKeyB64, state: RTCIceConnectionState | undefined): void {
    if (state === undefined) this.iceStates.delete(peer);
    else this.iceStates.set(peer, state);
  }

  // --- PeerTransport surface ---

  ensureConnection(
    peer: AgentPubKeyB64,
    opts?: { initiator?: boolean; connectionId?: ConnectionId; sdpExchangeTimeoutMs?: number; epoch?: number }
  ): ConnectionId {
    this.ensureCalls.push({ peer, opts });
    const existing = this.connectionIds.get(peer);
    if (existing) return existing;
    const id = opts?.connectionId ?? `${this.purpose}-conn-${this.nextConnId++}`;
    this.connectionIds.set(peer, id);
    this.phases.set(peer, 'signaling');
    return id;
  }

  closeConnection(peer: AgentPubKeyB64, reason?: string): void {
    this.closeCalls.push({ peer, reason });
    const id = this.connectionIds.get(peer);
    const previous = this.phases.get(peer) ?? 'idle';
    if (id) {
      // Contract: emits a final 'closed'. Synchronous, like the real
      // transports (the Phase 2b emit-invariant).
      this.emitPhase(peer, id, 'closed', previous);
    }
  }

  hasConnection(peer: AgentPubKeyB64): boolean {
    return this.connectionIds.has(peer);
  }

  getPhase(peer: AgentPubKeyB64): ConnectionPhase {
    return this.phases.get(peer) ?? 'idle';
  }

  getConnectionId(peer: AgentPubKeyB64): ConnectionId | undefined {
    return this.connectionIds.get(peer);
  }

  setLocalStream(_stream: MediaStream | null): void {}

  addTrack(_track: MediaStreamTrack, _stream: MediaStream): void {}

  removeTrack(_track: MediaStreamTrack, _stream: MediaStream): void {}

  replaceTrack(
    _oldTrack: MediaStreamTrack | null,
    _newTrack: MediaStreamTrack | null,
    _stream: MediaStream
  ): void {}

  send(peer: AgentPubKeyB64, data: string | ArrayBuffer | Uint8Array): void {
    this.sentData.push({ peer, data });
  }

  async getStats(_peer: AgentPubKeyB64): Promise<TransportStats | null> {
    return null;
  }

  getIceConnectionState(peer: AgentPubKeyB64): RTCIceConnectionState | undefined {
    return this.iceStates.get(peer);
  }

  async prioritizeAudio(
    _peer: AgentPubKeyB64,
    _opts: { videoMaxBitrateBps: number | null }
  ): Promise<SenderPriorityOutcome[]> {
    return [];
  }

  refreshMediaForPeer(_peer: AgentPubKeyB64, _stream: MediaStream): boolean {
    return false;
  }

  processIncomingSignal(signal: IncomingSignal): void {
    this.processedSignals.push(signal);
  }

  on<T extends TransportEventType>(
    type: T,
    handler: TransportEventHandler<Extract<TransportEvent, { type: T }>>
  ): Unsubscribe {
    let set = this.typedHandlers.get(type);
    if (!set) {
      set = new Set();
      this.typedHandlers.set(type, set);
    }
    set.add(handler as TransportEventHandler);
    return () => {
      set!.delete(handler as TransportEventHandler);
    };
  }

  onAny(handler: TransportEventHandler): Unsubscribe {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  destroy(): void {
    this.destroyCount += 1;
  }
}

/** Recording PresenceLogger stand-in. Only the surface the store calls. */
export class FakeLogger {
  sessionId = 'test-session';

  readonly agentEvents: SimpleEvent[] = [];

  readonly customMessages: string[] = [];

  logAgentEvent(event: SimpleEvent): void {
    this.agentEvents.push(event);
  }

  logCustomMessage(msg: string, _timestamp?: number): void {
    this.customMessages.push(msg);
  }

  logMyStreamInfo(_info: StreamAndTrackInfo): void {}

  logAgentPongMetaData(_agent: AgentPubKeyB64, _data: unknown): void {}

  getRecentAgentEvents(): Record<AgentPubKeyB64, SimpleEvent[]> {
    return {};
  }

  getRecentCustomLogs(): [] {
    return [];
  }

  eventsNamed(name: string): SimpleEvent[] {
    return this.agentEvents.filter(e => e.event === name);
  }

  asPresenceLogger(): PresenceLogger {
    return this as unknown as PresenceLogger;
  }
}

export type FakeDeps = {
  deps: StreamsStoreDeps;
  clock: Clock;
  bus: FakeSignalBus;
  local: FakeKeyValueStore;
  session: FakeKeyValueStore;
  /** Transports created by start(), keyed by purpose. Empty until start(). */
  transports: Partial<Record<TransportPurpose, FakeTransport>>;
};

/**
 * Build a full fake deps record. Transports are created lazily when the
 * store's start() calls the factory — exactly like production — so
 * construction-only tests never see one.
 */
export function makeFakeDeps(
  opts: { clock?: Clock; myPubKey?: AgentPubKey } = {}
): FakeDeps {
  const clock = opts.clock ?? new ManualClock(1_000_000);
  const myPubKey = opts.myPubKey ?? new Uint8Array(39).fill(1);
  const bus = new FakeSignalBus(myPubKey);
  const local = new FakeKeyValueStore();
  const session = new FakeKeyValueStore();
  const storage: StorageDep = { local, session };
  const transports: Partial<Record<TransportPurpose, FakeTransport>> = {};
  const deps: StreamsStoreDeps = {
    clock,
    storage,
    bus,
    transportFactory: (purpose, options) => {
      const transport = new FakeTransport(purpose, options);
      transports[purpose] = transport;
      return transport;
    },
    mediaDevices: {
      enumerateDevices: async () => [],
      ondevicechange: null,
    },
  };
  return { deps, clock, bus, local, session, transports };
}
