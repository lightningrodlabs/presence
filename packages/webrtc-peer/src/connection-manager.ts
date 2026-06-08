/**
 * ConnectionManager — Owns all PeerConnectionFSM instances.
 *
 * Dispatches signals to the correct FSM, manages media stream propagation,
 * and exposes an aggregate ConnectionManagerViewModel for room-level UI.
 *
 * See docs/webrtc-state-machine-plan.md
 */

import { PeerConnectionFSM } from './peer-connection-fsm.js';
import type { PeerConnectionFSMOptions, PeerCreatedContext } from './peer-connection-fsm.js';
import { DefaultReconnectPolicy } from './reconnect-policy.js';
import type {
  ConnectionConfig,
  ConnectionManagerViewModel,
  ConnectionManagerSummary,
  ConnectionPhase,
  ConnectionRole,
  ConnectionViewModel,
  FSMTransitionEntry,
  Logger,
  ManagerEvent,
  ManagerEventHandler,
  ReconnectPolicy,
  SignalingAdapter,
  SignalMessage,
  SignalSender,
  Unsubscribe,
} from './types.js';
import { DEFAULT_CONFIG, createIdleViewModel, NOOP_LOGGER } from './types.js';

export type ConnectionManagerOptions = {
  /** Our agent identity (for polite/impolite role assignment) */
  myAgentId: string;
  /**
   * Outbound signaling. Pass either a full `SignalingAdapter` (the library
   * subscribes via `onSignal`) or a bare `SignalSender` function (you call
   * `manager.deliverSignal(from, message)` when an incoming signal arrives).
   * The send-callback form is the natural fit for P2P transports whose
   * delivery API is "I receive a message, dispatch it" rather than
   * "register a handler" — Holochain remote signals, PeerKit messages,
   * libp2p streams, etc.
   */
  signaling: SignalingAdapter | SignalSender;
  /** WebRTC configuration */
  config?: ConnectionConfig;
  /** Default connection role */
  role?: ConnectionRole;
  /** Reconnect policy */
  reconnectPolicy?: ReconnectPolicy;
  /** Transition log callback */
  onTransition?: (entry: FSMTransitionEntry) => void;
  /** Factory for RTCPeerConnection (for testing) */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  /**
   * Called synchronously after each peer's `RTCPeerConnection` is created,
   * before any local tracks are attached or SDP is exchanged. Use this to
   * install simulcast transceivers, set codec preferences, etc. Fires once
   * per peer session (i.e. on initial connect and on each full reconnect).
   */
  onPeerCreated?: (ctx: PeerCreatedContext) => void;
  /** Optional sink for non-fatal diagnostics. Defaults to a no-op. */
  logger?: Logger;
};

export class ConnectionManager {
  private _myAgentId: string;
  private _sendSignal: SignalSender;
  private _config: ConnectionConfig;
  private _role: ConnectionRole;
  private _reconnectPolicy: ReconnectPolicy;
  private _onTransition: ((entry: FSMTransitionEntry) => void) | undefined;
  private _createPeerConnection: ((config: RTCConfiguration) => RTCPeerConnection) | undefined;
  private _onPeerCreated: ((ctx: PeerCreatedContext) => void) | undefined;
  private _logger: Logger;

  private _connections: Map<string, PeerConnectionFSM> = new Map();
  /** Per-agent RTT-scaled SDP-exchange timeout override (ms). */
  private _sdpTimeoutOverrides: Map<string, number> = new Map();
  private _eventHandlers: Map<string, ManagerEventHandler[]> = new Map();
  private _signalingUnsub: Unsubscribe | null = null;
  private _destroyed = false;

  // Local media stream to propagate to new connections
  private _localStream: MediaStream | null = null;

  // View model listeners
  private _viewModelListeners: Set<(vm: ConnectionManagerViewModel) => void> = new Set();

  constructor(options: ConnectionManagerOptions) {
    this._myAgentId = options.myAgentId;
    this._config = options.config ?? DEFAULT_CONFIG;
    this._role = options.role ?? 'mesh';
    this._reconnectPolicy = options.reconnectPolicy ?? new DefaultReconnectPolicy();
    this._onTransition = options.onTransition;
    this._createPeerConnection = options.createPeerConnection;
    this._onPeerCreated = options.onPeerCreated;
    this._logger = options.logger ?? NOOP_LOGGER;

    // signaling may be a full SignalingAdapter (subscribe via onSignal) or a
    // bare SignalSender (caller pushes inbound via deliverSignal).
    if (typeof options.signaling === 'function') {
      this._sendSignal = options.signaling;
    } else {
      const adapter = options.signaling;
      this._sendSignal = (to, msg) => adapter.sendSignal(to, msg);
      this._signalingUnsub = adapter.onSignal((from, message) => {
        this._handleIncomingSignal(from, message);
      });
    }
  }

  /**
   * Push an incoming signal into the manager. Use this when you constructed
   * the manager with a bare `SignalSender` callback; call it from your P2P
   * transport's message-arrived hook. No-op after `destroy()`.
   */
  deliverSignal(from: string, message: SignalMessage): void {
    if (this._destroyed) return;
    this._handleIncomingSignal(from, message);
  }

  /** Get the current connection config (read-only view) */
  get config(): Readonly<ConnectionConfig> {
    return this._config;
  }

  /**
   * Update connection config in-place. Since the config object is shared by
   * reference with all active FSMs, changes take effect on the next timer
   * started (e.g., next retry attempt).
   */
  updateConfig(partial: Partial<ConnectionConfig>): void {
    Object.assign(this._config, partial);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Ensure a connection exists to the given agent.
   * If no FSM exists, creates one and calls connect().
   * If an FSM exists in idle/disconnected state, restarts it.
   */
  ensureConnection(
    agent: string,
    opts?: { sdpExchangeTimeoutMs?: number },
  ): void {
    if (this._destroyed) return;

    if (opts?.sdpExchangeTimeoutMs !== undefined) {
      this._sdpTimeoutOverrides.set(agent, opts.sdpExchangeTimeoutMs);
    }

    let fsm = this._connections.get(agent);

    if (!fsm) {
      fsm = this._createFSM(agent);
      this._connections.set(agent, fsm);
      fsm.connect(this._localStream ?? undefined);
      this._emitManagerEvent({
        type: 'connection-created',
        remoteAgent: agent,
        connectionId: fsm.connectionId,
      });
      this._notifyViewModelChange();
      return;
    }

    const state = fsm.state;
    if (state === 'closed') {
      // Closed FSM is terminal — destroy and replace with a fresh one
      fsm.destroy();
      fsm = this._createFSM(agent);
      this._connections.set(agent, fsm);
      fsm.connect(this._localStream ?? undefined);
      this._emitManagerEvent({
        type: 'connection-created',
        remoteAgent: agent,
        connectionId: fsm.connectionId,
      });
      this._notifyViewModelChange();
    } else if (state === 'idle' || state === 'disconnected') {
      fsm.connect(this._localStream ?? undefined);
    }
    // If already signaling/connecting/connected/reconnecting, do nothing
  }


  /** Update the local media stream. Propagated to all active connections. */
  updateLocalStream(stream: MediaStream | null): void {
    this._localStream = stream;
    if (!stream) return;

    for (const [_agent, fsm] of this._connections) {
      if (fsm.state === 'connected' || fsm.state === 'signaling' || fsm.state === 'connecting' || fsm.state === 'reconnecting') {
        fsm.addLocalStream(stream);
      }
    }
  }

  /** Get the FSM for a specific agent */
  getFSM(agent: string): PeerConnectionFSM | undefined {
    return this._connections.get(agent);
  }

  /**
   * Recreate a peer's data channel in place (no ICE/DTLS teardown). Returns
   * true if a live connection received the call, false if there's no FSM for
   * the agent. See `PeerConnectionFSM.recreateDataChannel`.
   */
  recreateDataChannel(agent: string): boolean {
    return this._connections.get(agent)?.recreateDataChannel() ?? false;
  }

  /**
   * Trigger an ICE restart for a peer without teardown. Returns true if a live
   * connection received the call, false if there's no FSM for the agent.
   */
  restartIce(agent: string): boolean {
    return this._connections.get(agent)?.restartIce() ?? false;
  }

  /** Get the state of a specific connection */
  getState(agent: string): ConnectionPhase | undefined {
    return this._connections.get(agent)?.state;
  }

  /** Get states of all connections */
  getAllStates(): Map<string, ConnectionPhase> {
    const states = new Map<string, ConnectionPhase>();
    for (const [agent, fsm] of this._connections) {
      states.set(agent, fsm.state);
    }
    return states;
  }

  /** Get the view model for a specific agent */
  getViewModel(agent: string): ConnectionViewModel | undefined {
    return this._connections.get(agent)?.viewModel;
  }

  /** Get the aggregate view model */
  get viewModel(): ConnectionManagerViewModel {
    return this._computeViewModel();
  }

  /** Subscribe to aggregate view model changes */
  onViewModelChange(listener: (vm: ConnectionManagerViewModel) => void): Unsubscribe {
    this._viewModelListeners.add(listener);
    listener(this._computeViewModel());
    return () => {
      this._viewModelListeners.delete(listener);
    };
  }

  /** Subscribe to manager events */
  on(type: string, handler: ManagerEventHandler): Unsubscribe {
    if (!this._eventHandlers.has(type)) {
      this._eventHandlers.set(type, []);
    }
    this._eventHandlers.get(type)!.push(handler);
    return () => {
      const handlers = this._eventHandlers.get(type);
      if (handlers) {
        this._eventHandlers.set(type, handlers.filter(h => h !== handler));
      }
    };
  }

  /** Close a specific connection, notifying the remote peer */
  closeConnection(agent: string, reason: string): void {
    const fsm = this._connections.get(agent);
    if (fsm) {
      // Notify the remote peer so they can clean up their FSM
      this._sendSignal(agent, {
        type: 'leave',
        connectionId: fsm.connectionId,
      });
      fsm.close(reason);
      this._notifyViewModelChange();
    }
  }

  /** Close all connections and clean up */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    this._signalingUnsub?.();

    for (const [_agent, fsm] of this._connections) {
      fsm.destroy();
    }
    this._connections.clear();
    this._eventHandlers.clear();
    this._viewModelListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Private: Signal routing
  // ---------------------------------------------------------------------------

  private _handleIncomingSignal(from: string, message: SignalMessage): void {
    if (this._destroyed) return;

    if (message.type === 'leave') {
      const fsm = this._connections.get(from);
      if (fsm) {
        fsm.close('remote peer left');
        this._notifyViewModelChange();
      }
      return;
    }

    // Route SDP/ICE signals to FSM
    if (message.type === 'offer' || message.type === 'answer' || message.type === 'candidate') {
      this._routeSignalToFSM(from, message.connectionId, message.type, message.data, message.peerSessionId);
    }
  }

  private async _routeSignalToFSM(from: string, remoteConnectionId: string, signalType: string, signal: any, remotePeerSessionId?: number): Promise<void> {
    let fsm = this._connections.get(from);

    // Replace FSMs that can't handle a new remote session's SDP.
    // When the remote peer closed their window and re-opened, their new
    // RTCPeerConnection generates offers with different m-line ordering.
    // Our existing RTCPeerConnection will reject these with:
    //   "The order of m-lines in subsequent offer doesn't match"
    // Detect this via remoteConnectionId mismatch and replace the FSM.
    // Renegotiation offers from the SAME remote session (e.g., adding a track)
    // still go through Perfect Negotiation on the existing peer.
    if (fsm) {
      const isNewRemoteSession = signalType === 'offer' && remoteConnectionId &&
        fsm.remoteConnectionId !== null && remoteConnectionId !== fsm.remoteConnectionId;
      if (fsm.state === 'closed' || isNewRemoteSession) {
        fsm.destroy();
        fsm = undefined;
        this._connections.delete(from);
      }
    }

    if (!fsm) {
      // Remote agent is initiating — create FSM
      fsm = this._createFSM(from);
      this._connections.set(from, fsm);
      this._emitManagerEvent({
        type: 'connection-created',
        remoteAgent: from,
        connectionId: fsm.connectionId,
      });
    }

    // Connection-scoped signal filtering:
    // Offers always pass — they establish or reset the remote session identity.
    // Answers and candidates must match either our connectionId (response to
    // our offer) or the remoteConnectionId (from the session we accepted).
    // Stale signals from previous sessions are dropped.
    if (signalType !== 'offer' && fsm.remoteConnectionId !== null) {
      const matchesLocal = remoteConnectionId === fsm.connectionId;
      const matchesRemote = remoteConnectionId === fsm.remoteConnectionId;
      if (!matchesLocal && !matchesRemote) {
        this._onTransition?.({
          timestamp: Date.now(),
          connectionId: fsm.connectionId,
          remoteAgent: from,
          fromState: fsm.state,
          toState: fsm.state,
          trigger: `Dropped stale ${signalType}: signal.connectionId=${remoteConnectionId}, ` +
            `fsm.connectionId=${fsm.connectionId}, fsm.remoteConnectionId=${fsm.remoteConnectionId}`,
          peerSessionId: fsm.peerSessionId,
        });
        return;
      }
    }

    await fsm.handleRemoteSignal(signal, remoteConnectionId, remotePeerSessionId);
    this._notifyViewModelChange();
  }

  // ---------------------------------------------------------------------------
  // Private: FSM factory
  // ---------------------------------------------------------------------------

  private _createFSM(remoteAgent: string): PeerConnectionFSM {
    // Polite peer = lower agent ID (alphabetically)
    const polite = this._myAgentId < remoteAgent;

    const connectionId = crypto.randomUUID?.() ?? `conn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const fsm = new PeerConnectionFSM({
      remoteAgent,
      connectionId,
      polite,
      config: this._config,
      sdpExchangeTimeoutMs: this._sdpTimeoutOverrides.get(remoteAgent),
      role: this._role,
      reconnectPolicy: this._reconnectPolicy,
      onSignal: (data) => {
        // Determine signal type
        let type: 'offer' | 'answer' | 'candidate';
        if ('type' in data && (data.type === 'offer' || data.type === 'answer')) {
          type = data.type;
        } else {
          type = 'candidate';
        }

        this._sendSignal(remoteAgent, {
          type,
          connectionId,
          peerSessionId: fsm.peerSessionId,
          data,
        });
      },
      onTransition: (entry) => {
        this._onTransition?.(entry);
        this._notifyViewModelChange();

        // Emit a connection-state-change event ONLY on an actual phase change.
        // `onTransition` also fires for same-state sub-phase log entries
        // (`_logTransition`: ICE-state changes, in-place data-channel recreate,
        // dropped-signal notes) where fromState === toState. Forwarding those as
        // "state changes" made consumers re-run their on-connect side effects
        // (re-add tracks → renegotiation, re-tag carrier, re-apply sender params)
        // every time the FSM logged a sub-event while `connected`. Gate on a real
        // transition; the view model above still updates on every entry.
        if (entry.fromState !== entry.toState) {
          this._emitManagerEvent({
            type: 'connection-state-changed',
            remoteAgent,
            connectionId,
            data: { fromState: entry.fromState, toState: entry.toState },
          });
        }

        // Clean up closed/failed connections from the map
        if (entry.toState === 'closed') {
          // Defer cleanup to avoid modifying map during iteration
          setTimeout(() => {
            const current = this._connections.get(remoteAgent);
            if (current === fsm) {
              this._connections.delete(remoteAgent);
              this._emitManagerEvent({
                type: 'connection-closed',
                remoteAgent,
                connectionId,
              });
              this._notifyViewModelChange();
            }
          }, 0);
        }
      },
      createPeerConnection: this._createPeerConnection,
      onPeerCreated: this._onPeerCreated,
      logger: this._logger,
    });

    // Forward FSM events as manager events
    fsm.on('remote-stream', (event) => {
      this._emitManagerEvent({
        type: 'remote-stream',
        remoteAgent,
        connectionId,
        data: event.data,
      });
    });

    fsm.on('remote-track', (event) => {
      this._emitManagerEvent({
        type: 'remote-track',
        remoteAgent,
        connectionId,
        data: event.data,
      });
    });

    fsm.on('data-channel-message', (event) => {
      this._emitManagerEvent({
        type: 'data-channel-message',
        remoteAgent,
        connectionId,
        data: event.data,
      });
    });

    // Forward the one-shot establishment timeline (§6.6) so the application can
    // log a single per-connection record (per-stage ms) instead of
    // reconstructing it from interleaved transition logs.
    fsm.on('establishment-timeline', (event) => {
      this._emitManagerEvent({
        type: 'establishment-timeline',
        remoteAgent,
        connectionId,
        data: event.data,
      });
    });

    return fsm;
  }

  // ---------------------------------------------------------------------------
  // Private: View model
  // ---------------------------------------------------------------------------

  private _computeViewModel(): ConnectionManagerViewModel {
    const agents: Record<string, ConnectionViewModel> = {};
    let connectedCount = 0;
    let connectingCount = 0;
    let troubledCount = 0;
    let allHealthy = true;

    for (const [agent, fsm] of this._connections) {
      const vm = fsm.viewModel;
      agents[agent] = vm;

      switch (vm.phase) {
        case 'connected':
          connectedCount++;
          if (!vm.healthy) allHealthy = false;
          break;
        case 'signaling':
        case 'connecting':
          connectingCount++;
          allHealthy = false;
          break;
        case 'reconnecting':
        case 'disconnected':
        case 'failed':
          troubledCount++;
          allHealthy = false;
          break;
      }
    }

    const totalPeers = this._connections.size;
    if (totalPeers === 0) allHealthy = true; // No peers = healthy

    return {
      agents,
      summary: {
        totalPeers,
        connectedPeers: connectedCount,
        connectingPeers: connectingCount,
        troubledPeers: troubledCount,
        allHealthy,
      },
    };
  }

  private _notifyViewModelChange(): void {
    const vm = this._computeViewModel();
    for (const listener of this._viewModelListeners) {
      try {
        listener(vm);
      } catch (e) {
        this._logger.error('ConnectionManager view model listener error:', e);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Event emission
  // ---------------------------------------------------------------------------

  private _emitManagerEvent(event: ManagerEvent): void {
    const handlers = this._eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (e) {
          this._logger.error('ConnectionManager event handler error:', e);
        }
      }
    }
  }
}
