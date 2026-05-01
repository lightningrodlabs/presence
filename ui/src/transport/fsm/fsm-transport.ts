/**
 * FsmTransport — wraps the hand-rolled WebRTC ConnectionManager (Phase 2)
 * behind the PeerTransport interface.
 *
 * Differences from SimplePeerTransport that the wrapper papers over:
 *   - The FSM allocates its own per-peer connectionId at ensureConnection
 *     time. The connectionId hint passed by the application is ignored;
 *     callers must use the returned ConnectionId.
 *   - Perfect Negotiation handles offer/answer choreography internally,
 *     so an `initiator` flag is not meaningful — both sides call
 *     ensureConnection and the FSM works out who offers first based on
 *     polite/impolite role assignment from agent IDs.
 *   - There is no per-peer addTrack/removeTrack/replaceTrack on
 *     ConnectionManager; track changes propagate via updateLocalStream
 *     and refreshMedia. The wrapper translates accordingly.
 *
 * Wire format for outgoing/incoming signals: the OutgoingSignal.data
 * payload is a `{ type, payload }` envelope where `type` is one of
 * 'offer' | 'answer' | 'candidate' | 'leave' and `payload` is the
 * SDP / candidate body. The application is responsible for transporting
 * this envelope (e.g. via Holochain remote-signal of type 'SdpFsm') and
 * delivering it back via processIncomingSignal on the receiving side.
 */

import type { AgentPubKeyB64 } from '@holochain/client';
import type {
  ConnectionId,
  ConnectionPhase,
  IncomingSignal,
  OutgoingSignal,
  PeerTransport,
  PeerTransportOptions,
  TransportEvent,
  TransportEventHandler,
  TransportEventType,
  TransportStats,
  Unsubscribe,
} from '../types';
import { ConnectionManager } from './connection-manager';
import { DEFAULT_CONFIG } from './types';
import type {
  ConnectionConfig,
  SignalingAdapter,
  SignalMessage,
  Unsubscribe as FsmUnsubscribe,
} from './types';

export type FsmSignalEnvelope = {
  type: SignalMessage['type'];
  payload: SignalMessage['data'];
};

export type FsmTransportOptions = PeerTransportOptions & {
  /** Override ConnectionConfig defaults (timeouts, role). iceServers/trickleICE
   *  are pulled from PeerTransportOptions and override the config. */
  configOverrides?: Partial<ConnectionConfig>;
  /** Test seam: factory for RTCPeerConnection. */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
};

export class FsmTransport implements PeerTransport {
  private _myAgentId: AgentPubKeyB64;
  private _onOutgoingSignal: (signal: OutgoingSignal) => void;
  private _getIceServers: () => RTCIceServer[];
  private _getTrickleICE: () => boolean;

  private _config: ConnectionConfig;
  private _manager: ConnectionManager;
  private _signalHandlers: Array<(from: string, message: SignalMessage) => void> = [];

  private _typedHandlers = new Map<TransportEventType, Set<TransportEventHandler>>();
  private _anyHandlers = new Set<TransportEventHandler>();
  /** Last known phase per peer; used to fire transitions out of 'idle'. */
  private _lastPhase = new Map<AgentPubKeyB64, ConnectionPhase>();
  private _localStream: MediaStream | null = null;
  private _destroyed = false;

  constructor(options: FsmTransportOptions) {
    this._myAgentId = options.myAgentId;
    this._onOutgoingSignal = options.onOutgoingSignal;
    const ice = options.iceServers ?? [];
    this._getIceServers = typeof ice === 'function' ? ice : () => ice;
    const trickle = options.trickleICE ?? true;
    this._getTrickleICE = typeof trickle === 'function' ? trickle : () => trickle;

    this._config = {
      ...DEFAULT_CONFIG,
      ...(options.configOverrides ?? {}),
      iceServers: this._getIceServers(),
      trickleICE: this._getTrickleICE(),
    };

    // Inline SignalingAdapter that bridges to the PeerTransport
    // onOutgoingSignal callback / processIncomingSignal entrypoint.
    const adapter: SignalingAdapter = {
      sendSignal: (to, message) => {
        this._onOutgoingSignal({
          to,
          connectionId: message.connectionId,
          peerSessionId: message.peerSessionId,
          data: { type: message.type, payload: message.data } as FsmSignalEnvelope,
        });
      },
      onSignal: (handler): FsmUnsubscribe => {
        this._signalHandlers.push(handler);
        return () => {
          this._signalHandlers = this._signalHandlers.filter(h => h !== handler);
        };
      },
    };

    this._manager = new ConnectionManager({
      myAgentId: this._myAgentId,
      signaling: adapter,
      config: this._config,
      createPeerConnection: options.createPeerConnection,
    });

    this._manager.on('connection-state-changed', (e: any) => {
      const next = e.data?.toState as ConnectionPhase;
      const prev = (e.data?.fromState as ConnectionPhase) ?? this._lastPhase.get(e.remoteAgent) ?? 'idle';
      this._lastPhase.set(e.remoteAgent, next);
      this._emit({
        type: 'connection-state-change',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        phase: next,
        previous: prev,
      });
    });

    this._manager.on('connection-created', (e: any) => {
      // Synthesize a 'signaling' transition for newly-created FSMs whose
      // very first state-change event we haven't seen yet (the FSM
      // transitions idle -> signaling on connect()/incoming-offer, but
      // ConnectionManager fires 'connection-created' before that).
      this._lastPhase.set(e.remoteAgent, 'idle');
    });

    this._manager.on('remote-stream', (e: any) => {
      this._emit({
        type: 'remote-stream',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        stream: e.data?.stream ?? e.data,
      });
    });

    this._manager.on('remote-track', (e: any) => {
      const track = e.data?.track ?? e.data;
      const stream = e.data?.stream ?? e.data?.streams?.[0];
      this._emit({
        type: 'remote-track',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        track,
        stream,
      });
    });

    this._manager.on('data-channel-message', (e: any) => {
      this._emit({
        type: 'data-channel-message',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        data: e.data,
      });
    });

    this._manager.on('connection-closed', (e: any) => {
      const prev = this._lastPhase.get(e.remoteAgent) ?? 'connected';
      this._lastPhase.delete(e.remoteAgent);
      this._emit({
        type: 'connection-state-change',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        phase: 'closed',
        previous: prev,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ensureConnection(
    peer: AgentPubKeyB64,
    _opts?: { initiator?: boolean; connectionId?: ConnectionId }
  ): ConnectionId {
    if (this._destroyed) {
      throw new Error('FsmTransport: destroyed');
    }
    // Apply current iceServers/trickleICE before creating any new peer.
    this._manager.updateConfig({
      iceServers: this._getIceServers(),
      trickleICE: this._getTrickleICE(),
    });
    this._manager.ensureConnection(peer);
    const fsm = this._manager.getFSM(peer);
    return fsm?.connectionId ?? '';
  }

  closeConnection(peer: AgentPubKeyB64, reason?: string): void {
    this._manager.closeConnection(peer, reason ?? 'closeConnection called');
  }

  hasConnection(peer: AgentPubKeyB64): boolean {
    return !!this._manager.getFSM(peer);
  }

  getPhase(peer: AgentPubKeyB64): ConnectionPhase {
    return this._manager.getState(peer) ?? 'idle';
  }

  getConnectionId(peer: AgentPubKeyB64): ConnectionId | undefined {
    return this._manager.getFSM(peer)?.connectionId;
  }

  // ---------------------------------------------------------------------------
  // Local media
  // ---------------------------------------------------------------------------

  setLocalStream(stream: MediaStream | null): void {
    this._localStream = stream;
    this._manager.updateLocalStream(stream);
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    // ConnectionManager only exposes whole-stream propagation. Treat
    // addTrack as "the stream changed" — updateLocalStream walks all
    // active FSMs and refreshes their tracks on the next negotiation.
    this._localStream = stream;
    this._manager.updateLocalStream(stream);
    void track;
  }

  removeTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this._localStream = stream;
    // updateLocalStream re-asserts current senders against the stream's
    // current track set; tracks no longer present on the stream are
    // implicitly removed by the FSM's reconciliation pass.
    this._manager.updateLocalStream(stream);
    void track;
  }

  replaceTrack(
    oldTrack: MediaStreamTrack | null,
    newTrack: MediaStreamTrack | null,
    _stream: MediaStream
  ): void {
    if (!oldTrack || !newTrack) return;
    // Drive replaceTrack on every active FSM in parallel. The FSM's
    // replaceTrack uses the underlying RTCRtpSender so no renegotiation
    // is triggered.
    for (const peer of this._manager.viewModel.agents
      ? Object.keys(this._manager.viewModel.agents)
      : []) {
      const fsm = this._manager.getFSM(peer);
      if (!fsm) continue;
      fsm.replaceTrack(oldTrack, newTrack).catch(e => {
        console.warn(`FsmTransport.replaceTrack failed for ${peer}:`, e);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Data channel
  // ---------------------------------------------------------------------------

  send(peer: AgentPubKeyB64, data: string | ArrayBuffer | Uint8Array): void {
    const fsm = this._manager.getFSM(peer);
    if (!fsm || fsm.state !== 'connected') return;
    try {
      const payload =
        typeof data === 'string'
          ? data
          : new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      fsm.send(payload);
    } catch (e) {
      console.warn(`FsmTransport.send failed for ${peer}:`, e);
    }
  }

  // ---------------------------------------------------------------------------
  // Signaling
  // ---------------------------------------------------------------------------

  processIncomingSignal(signal: IncomingSignal): void {
    const envelope = signal.data as FsmSignalEnvelope;
    if (!envelope || typeof envelope !== 'object') return;
    const message: SignalMessage = {
      type: envelope.type,
      connectionId: signal.connectionId,
      peerSessionId: signal.peerSessionId,
      data: envelope.payload,
    };
    for (const handler of this._signalHandlers) {
      try {
        handler(signal.from, message);
      } catch (e) {
        console.error('FsmTransport signal handler error:', e);
      }
    }
  }

  async getStats(peer: AgentPubKeyB64): Promise<TransportStats | null> {
    const pc = this.getRTCPeerConnection(peer);
    if (!pc) return null;
    try {
      const raw = await pc.getStats();
      return { raw };
    } catch (e) {
      console.warn(`FsmTransport.getStats failed for ${peer}:`, e);
      return null;
    }
  }

  /**
   * Escape hatch matching SimplePeerTransport.getRTCPeerConnection — exposes
   * the underlying RTCPeerConnection for ICE diagnostics, stats poll, and
   * per-peer track recovery. This is the bridge that lets the existing
   * streams-store diagnostic and recovery code work for FSM peers
   * without further changes.
   */
  getRTCPeerConnection(peer: AgentPubKeyB64): RTCPeerConnection | undefined {
    return this._manager.getFSM(peer)?.peer?.pc;
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
    this._manager.destroy();
    this._typedHandlers.clear();
    this._anyHandlers.clear();
    this._signalHandlers = [];
    this._lastPhase.clear();
    this._localStream = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _emit(event: TransportEvent): void {
    const typed = this._typedHandlers.get(event.type);
    if (typed) {
      for (const h of Array.from(typed)) {
        try {
          h(event);
        } catch (e) {
          console.error(`FsmTransport handler error for ${event.type}:`, e);
        }
      }
    }
    for (const h of Array.from(this._anyHandlers)) {
      try {
        h(event);
      } catch (e) {
        console.error('FsmTransport onAny handler error:', e);
      }
    }
  }
}
