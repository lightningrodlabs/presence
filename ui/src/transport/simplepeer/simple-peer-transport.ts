/**
 * SimplePeerTransport — wraps `simple-peer` behind the PeerTransport interface.
 *
 * Responsibilities:
 *   - One `SimplePeer.Instance` per remote peer.
 *   - SimplePeer events ('signal', 'connect', 'stream', 'track', 'data',
 *     'close', 'error') become PeerTransport events.
 *   - Per-peer phase: idle → signaling → connected → closed.
 *     SimplePeer doesn't expose 'reconnecting'/'failed' — they collapse into
 *     'closed' here and the application calls ensureConnection again to retry.
 *   - Local-stream changes propagate to all active connections.
 *
 * Not in scope (kept in streams-store):
 *   - InitRequest/InitAccept handshake (caller decides when to ensureConnection).
 *   - Holochain signal delivery (caller handles via onOutgoingSignal).
 *   - Audio analyser, level metering, squelch, supersede policy decisions.
 *   - Diagnostic ICE/gathering logging (PresenceLogger lives in streams-store).
 *
 * Supersede semantics: each event handler closures over its `state` object
 * and checks identity in `_connections` before mutating. Events are still
 * emitted for stale states (with their original connectionId) so callers can
 * see them for forensics; callers filter by connectionId.
 */

import SimplePeer from 'simple-peer';
import type {
  ConnectionId,
  ConnectionPhase,
  IncomingSignal,
  OutgoingSignal,
  PeerTransport,
  PeerTransportOptions,
  SimplePeerLike,
  TransportEvent,
  TransportEventHandler,
  TransportEventType,
  TransportStats,
  Unsubscribe,
} from '../types';
import type { AgentPubKeyB64 } from '@holochain/client';

type PerPeerState = {
  connectionId: ConnectionId;
  peer: SimplePeerLike;
  phase: ConnectionPhase;
  initiator: boolean;
  /** The stream most recently attached via setLocalStream / addTrack ops.
   *  Used to know what to attach when a fresh peer is created. */
  attachedStream: MediaStream | null;
};

/** Test seam: factory for SimplePeer instances. */
export type SimplePeerFactory = (options: SimplePeer.Options) => SimplePeerLike;

export type SimplePeerTransportOptions = PeerTransportOptions & {
  /** Override SimplePeer construction. Defaults to `new SimplePeer(options)`.
   *  Used by tests to inject a mock that doesn't require a WebRTC stack. */
  createPeer?: SimplePeerFactory;
};

const TERMINAL_PHASES: ReadonlySet<ConnectionPhase> = new Set([
  'closed',
  'failed',
]);

export class SimplePeerTransport implements PeerTransport {
  private _myAgentId: AgentPubKeyB64;
  private _onOutgoingSignal: (signal: OutgoingSignal) => void;
  private _getIceServers: () => RTCIceServer[];
  private _getTrickleICE: () => boolean;
  private _createPeer: SimplePeerFactory;

  private _connections = new Map<AgentPubKeyB64, PerPeerState>();
  private _localStream: MediaStream | null = null;

  private _typedHandlers = new Map<TransportEventType, Set<TransportEventHandler>>();
  private _anyHandlers = new Set<TransportEventHandler>();

  private _destroyed = false;

  constructor(options: SimplePeerTransportOptions) {
    this._myAgentId = options.myAgentId;
    this._onOutgoingSignal = options.onOutgoingSignal;
    const ice = options.iceServers ?? [];
    this._getIceServers = typeof ice === 'function' ? ice : () => ice;
    const trickle = options.trickleICE ?? true;
    this._getTrickleICE = typeof trickle === 'function' ? trickle : () => trickle;
    this._createPeer =
      options.createPeer ??
      ((opts: SimplePeer.Options) => new SimplePeer(opts) as unknown as SimplePeerLike);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ensureConnection(
    peer: AgentPubKeyB64,
    opts?: { initiator?: boolean; connectionId?: ConnectionId }
  ): ConnectionId {
    if (this._destroyed) {
      throw new Error('SimplePeerTransport: destroyed');
    }

    const existing = this._connections.get(peer);
    const desiredId = opts?.connectionId;

    if (existing && !TERMINAL_PHASES.has(existing.phase)) {
      // If caller didn't pin a connectionId or matches existing, this is a no-op.
      if (!desiredId || existing.connectionId === desiredId) {
        return existing.connectionId;
      }
      // Different connectionId — caller wants a fresh attempt. Close old first.
      // Emit close synchronously so listeners observe the supersede in order;
      // SimplePeer's own 'close' event will still fire later but its handler
      // will detect the slot has been replaced and skip.
      this._closeStateInternal(peer, existing, 'superseded by new connectionId');
    } else if (existing && TERMINAL_PHASES.has(existing.phase)) {
      // Stale terminal state — drop it, create fresh below.
      this._connections.delete(peer);
    }

    const connectionId = desiredId ?? this._newConnectionId();
    const initiator = opts?.initiator ?? false;

    const peerInstance = this._createPeer({
      initiator,
      config: { iceServers: this._getIceServers() },
      objectMode: true,
      trickle: this._getTrickleICE(),
    });

    const state: PerPeerState = {
      connectionId,
      peer: peerInstance,
      phase: 'signaling',
      initiator,
      attachedStream: null,
    };

    this._connections.set(peer, state);
    this._wirePeerEvents(peer, state);

    // Auto-attach the canonical local stream, if any.
    if (this._localStream) {
      try {
        peerInstance.addStream(this._localStream);
        state.attachedStream = this._localStream;
      } catch (e) {
        console.warn(`SimplePeerTransport: addStream failed for ${peer}:`, e);
      }
    }

    this._emit({
      type: 'connection-state-change',
      peer,
      connectionId,
      phase: 'signaling',
      previous: 'idle',
    });

    return connectionId;
  }

  closeConnection(peer: AgentPubKeyB64, reason?: string): void {
    const state = this._connections.get(peer);
    if (!state) return;
    this._closeStateInternal(peer, state, reason ?? 'closeConnection called');
  }

  hasConnection(peer: AgentPubKeyB64): boolean {
    return this._connections.has(peer);
  }

  getPhase(peer: AgentPubKeyB64): ConnectionPhase {
    return this._connections.get(peer)?.phase ?? 'idle';
  }

  getConnectionId(peer: AgentPubKeyB64): ConnectionId | undefined {
    return this._connections.get(peer)?.connectionId;
  }

  // ---------------------------------------------------------------------------
  // Local media
  // ---------------------------------------------------------------------------

  setLocalStream(stream: MediaStream | null): void {
    this._localStream = stream;
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    for (const [peer, state] of this._connections) {
      if (TERMINAL_PHASES.has(state.phase)) continue;
      try {
        state.peer.addTrack(track, stream);
        state.attachedStream = stream;
      } catch (e) {
        console.warn(`SimplePeerTransport.addTrack failed for ${peer}:`, e);
      }
    }
  }

  removeTrack(track: MediaStreamTrack, stream: MediaStream): void {
    for (const [peer, state] of this._connections) {
      if (TERMINAL_PHASES.has(state.phase)) continue;
      try {
        state.peer.removeTrack(track, stream);
      } catch (e) {
        console.warn(`SimplePeerTransport.removeTrack failed for ${peer}:`, e);
      }
    }
  }

  replaceTrack(
    oldTrack: MediaStreamTrack | null,
    newTrack: MediaStreamTrack | null,
    stream: MediaStream
  ): void {
    for (const [peer, state] of this._connections) {
      if (TERMINAL_PHASES.has(state.phase)) continue;
      try {
        // SimplePeer's replaceTrack signature: (oldTrack, newTrack, stream)
        // where oldTrack and newTrack can be null in some implementations.
        // The @types/simple-peer typing is strict about MediaStreamTrack;
        // cast to satisfy the call. RTCRtpSender.replaceTrack handles null.
        state.peer.replaceTrack(
          oldTrack as MediaStreamTrack,
          newTrack as MediaStreamTrack,
          stream
        );
      } catch (e) {
        console.warn(`SimplePeerTransport.replaceTrack failed for ${peer}:`, e);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Data channel
  // ---------------------------------------------------------------------------

  send(peer: AgentPubKeyB64, data: string | ArrayBuffer | Uint8Array): void {
    const state = this._connections.get(peer);
    if (!state || state.phase !== 'connected') {
      // Drop silently — matches voice-over-signals' tolerance for broadcasts
      // that hit not-yet-connected peers.
      return;
    }
    try {
      // SimplePeer's send accepts string | Buffer | ArrayBufferView | ArrayBuffer.
      state.peer.send(data as any);
    } catch (e) {
      console.warn(`SimplePeerTransport.send failed for ${peer}:`, e);
    }
  }

  // ---------------------------------------------------------------------------
  // Signaling
  // ---------------------------------------------------------------------------

  processIncomingSignal(signal: IncomingSignal): void {
    const state = this._connections.get(signal.from);
    if (!state) {
      // No connection state — caller (streams-store) is responsible for the
      // InitRequest/InitAccept handshake before signals start arriving. A
      // signal for an unknown peer at this layer is a stale-after-close case
      // or protocol error; drop.
      return;
    }
    if (state.connectionId !== signal.connectionId) {
      // Mismatch — stale signal from a previous connection attempt. Drop.
      return;
    }
    if (TERMINAL_PHASES.has(state.phase)) {
      return;
    }
    try {
      state.peer.signal(signal.data as SimplePeer.SignalData);
    } catch (e) {
      this._emit({
        type: 'error',
        peer: signal.from,
        connectionId: state.connectionId,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  async getStats(peer: AgentPubKeyB64): Promise<TransportStats | null> {
    const state = this._connections.get(peer);
    if (!state || state.phase !== 'connected') return null;

    return new Promise<TransportStats | null>((resolve) => {
      try {
        // SimplePeer.getStats invokes the callback with (err, reports) where
        // reports is an array of stats dictionaries. The underlying
        // RTCStatsReport (a Map) is more useful — pull it from _pc.
        const pc = (state.peer as unknown as { _pc?: RTCPeerConnection })._pc;
        if (!pc) {
          resolve(null);
          return;
        }
        pc.getStats()
          .then((raw) => resolve({ raw }))
          .catch((err) => {
            console.warn(`SimplePeerTransport.getStats failed for ${peer}:`, err);
            resolve(null);
          });
      } catch (e) {
        console.warn(`SimplePeerTransport.getStats threw for ${peer}:`, e);
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------------------

  on<T extends TransportEventType>(
    type: T,
    handler: TransportEventHandler<Extract<TransportEvent, { type: T }>>
  ): Unsubscribe {
    let set = this._typedHandlers.get(type);
    if (!set) {
      set = new Set();
      this._typedHandlers.set(type, set);
    }
    const wrapped = handler as TransportEventHandler;
    set.add(wrapped);
    return () => {
      set!.delete(wrapped);
    };
  }

  onAny(handler: TransportEventHandler): Unsubscribe {
    this._anyHandlers.add(handler);
    return () => {
      this._anyHandlers.delete(handler);
    };
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    // Snapshot keys so we can iterate while mutating the map.
    for (const peer of Array.from(this._connections.keys())) {
      const state = this._connections.get(peer);
      if (state) {
        this._closeStateInternal(peer, state, 'transport destroyed');
      }
    }
    this._connections.clear();
    this._typedHandlers.clear();
    this._anyHandlers.clear();
    this._localStream = null;
  }

  // ---------------------------------------------------------------------------
  // Private — SimplePeer event wiring
  // ---------------------------------------------------------------------------

  private _wirePeerEvents(peerB64: AgentPubKeyB64, state: PerPeerState): void {
    const { peer, connectionId } = state;

    peer.on('signal', (data) => {
      // Stale guard: if this state has been superseded, still emit the signal
      // (the application may need to ignore it via connectionId — we have no
      // way to know here), but skip if peer is closed.
      if (TERMINAL_PHASES.has(state.phase)) return;
      this._onOutgoingSignal({
        to: peerB64,
        connectionId,
        data,
      });
    });

    peer.on('connect', () => {
      // Identity check — if the slot has been replaced, this peer is a zombie.
      // Application's supersede guard (matching connectionId in _openConnections)
      // handles UI-level filtering; we still emit so it can log forensically.
      const previous = state.phase;
      if (this._connections.get(peerB64) === state) {
        state.phase = 'connected';
      }
      this._emit({
        type: 'connection-state-change',
        peer: peerB64,
        connectionId,
        phase: 'connected',
        previous,
      });
    });

    peer.on('stream', (stream: MediaStream) => {
      this._emit({
        type: 'remote-stream',
        peer: peerB64,
        connectionId,
        stream,
      });
    });

    peer.on('track', (track: MediaStreamTrack, stream: MediaStream) => {
      this._emit({
        type: 'remote-track',
        peer: peerB64,
        connectionId,
        track,
        stream,
      });
    });

    peer.on('data', (data) => {
      this._emit({
        type: 'data-channel-message',
        peer: peerB64,
        connectionId,
        data,
      });
    });

    peer.on('close', () => {
      const previous = state.phase;
      const isCurrent = this._connections.get(peerB64) === state;
      if (!TERMINAL_PHASES.has(state.phase)) {
        state.phase = 'closed';
      }
      if (isCurrent) {
        this._connections.delete(peerB64);
      }
      this._emit({
        type: 'connection-state-change',
        peer: peerB64,
        connectionId,
        phase: 'closed',
        previous,
      });
    });

    peer.on('error', (error) => {
      this._emit({
        type: 'error',
        peer: peerB64,
        connectionId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }

  /** Close a specific state. Used by closeConnection, supersede paths, and destroy. */
  private _closeStateInternal(
    peer: AgentPubKeyB64,
    state: PerPeerState,
    _reason: string
  ): void {
    const previous = state.phase;
    const isCurrent = this._connections.get(peer) === state;

    // Mark phase before destroying so the close handler sees terminal state.
    if (!TERMINAL_PHASES.has(state.phase)) {
      state.phase = 'closed';
    }
    if (isCurrent) {
      this._connections.delete(peer);
    }

    try {
      state.peer.destroy();
    } catch (e) {
      // SimplePeer.destroy is generally safe to call multiple times, but
      // some edge cases throw. Don't propagate.
      console.warn(`SimplePeerTransport: destroy threw for ${peer}:`, e);
    }

    this._emit({
      type: 'connection-state-change',
      peer,
      connectionId: state.connectionId,
      phase: 'closed',
      previous,
    });
  }

  private _emit(event: TransportEvent): void {
    const typed = this._typedHandlers.get(event.type);
    if (typed) {
      // Iterate snapshot — handlers may unsubscribe during dispatch.
      for (const h of Array.from(typed)) {
        try {
          h(event);
        } catch (e) {
          console.error(
            `SimplePeerTransport handler error for ${event.type}:`,
            e
          );
        }
      }
    }
    for (const h of Array.from(this._anyHandlers)) {
      try {
        h(event);
      } catch (e) {
        console.error('SimplePeerTransport onAny handler error:', e);
      }
    }
  }

  private _newConnectionId(): ConnectionId {
    const c = (globalThis as any).crypto;
    if (c?.randomUUID) return c.randomUUID();
    return `conn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
