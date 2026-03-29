/**
 * ConnectionManager — Owns all PeerConnectionFSM instances.
 *
 * Dispatches signals to the correct FSM, manages media stream propagation,
 * and exposes an aggregate ConnectionManagerViewModel for room-level UI.
 *
 * See docs/webrtc-state-machine-plan.md
 */

import { PeerConnectionFSM } from './peer-connection-fsm';
import type { PeerConnectionFSMOptions } from './peer-connection-fsm';
import { DefaultReconnectPolicy } from './reconnect-policy';
import type {
  ConnectionConfig,
  ConnectionManagerViewModel,
  ConnectionManagerSummary,
  ConnectionPhase,
  ConnectionRole,
  ConnectionViewModel,
  FSMTransitionEntry,
  ManagerEvent,
  ManagerEventHandler,
  ReconnectPolicy,
  SignalingAdapter,
  SignalMessage,
  Unsubscribe,
} from './types';
import { DEFAULT_CONFIG, createIdleViewModel } from './types';

export type ConnectionManagerOptions = {
  /** Our agent identity (for polite/impolite role assignment) */
  myAgentId: string;
  /** Signaling adapter (abstraction over Holochain) */
  signaling: SignalingAdapter;
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
};

export class ConnectionManager {
  private _myAgentId: string;
  private _signaling: SignalingAdapter;
  private _config: ConnectionConfig;
  private _role: ConnectionRole;
  private _reconnectPolicy: ReconnectPolicy;
  private _onTransition: ((entry: FSMTransitionEntry) => void) | undefined;
  private _createPeerConnection: ((config: RTCConfiguration) => RTCPeerConnection) | undefined;

  private _connections: Map<string, PeerConnectionFSM> = new Map();
  private _eventHandlers: Map<string, ManagerEventHandler[]> = new Map();
  private _signalingUnsub: Unsubscribe;
  private _destroyed = false;

  // Local media stream to propagate to new connections
  private _localStream: MediaStream | null = null;

  // View model listeners
  private _viewModelListeners: Set<(vm: ConnectionManagerViewModel) => void> = new Set();

  constructor(options: ConnectionManagerOptions) {
    this._myAgentId = options.myAgentId;
    this._signaling = options.signaling;
    this._config = options.config ?? DEFAULT_CONFIG;
    this._role = options.role ?? 'mesh';
    this._reconnectPolicy = options.reconnectPolicy ?? new DefaultReconnectPolicy();
    this._onTransition = options.onTransition;
    this._createPeerConnection = options.createPeerConnection;

    // Listen for incoming signals
    this._signalingUnsub = this._signaling.onSignal((from, message) => {
      this._handleIncomingSignal(from, message);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Ensure a connection exists to the given agent.
   * If no FSM exists, creates one and calls connect().
   * If an FSM exists in idle/disconnected state, restarts it.
   */
  ensureConnection(agent: string): void {
    if (this._destroyed) return;

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
    if (state === 'idle' || state === 'disconnected') {
      fsm.connect(this._localStream ?? undefined);
    }
    // If already signaling/connecting/connected/reconnecting, do nothing
  }

  /**
   * Handle a signal from the signaling adapter.
   * Routes to the correct FSM or creates one if needed.
   */
  handleSignal(from: string, type: string, payload: string): void {
    if (this._destroyed) return;

    // Parse the signal
    let signal: any;
    try {
      signal = JSON.parse(payload);
    } catch (e) {
      return;
    }

    this._routeSignalToFSM(from, signal);
  }

  /** Update the local media stream. Propagated to all active connections. */
  updateLocalStream(stream: MediaStream | null): void {
    this._localStream = stream;
    if (!stream) return;

    for (const [_agent, fsm] of this._connections) {
      if (fsm.state === 'connected' || fsm.state === 'signaling' || fsm.state === 'connecting') {
        fsm.addLocalStream(stream);
      }
    }
  }

  /** Get the FSM for a specific agent */
  getFSM(agent: string): PeerConnectionFSM | undefined {
    return this._connections.get(agent);
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
      this._signaling.sendSignal(agent, {
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

    this._signalingUnsub();

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
      this._routeSignalToFSM(from, message.data);
    }
  }

  private async _routeSignalToFSM(from: string, signal: any): Promise<void> {
    let fsm = this._connections.get(from);

    // Only replace a closed FSM — connected FSMs handle incoming offers as
    // renegotiation via Perfect Negotiation (e.g., when remote adds a track).
    if (fsm && fsm.state === 'closed') {
      fsm.destroy();
      fsm = undefined;
      this._connections.delete(from);
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

    await fsm.handleRemoteSignal(signal);
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

        this._signaling.sendSignal(remoteAgent, {
          type,
          connectionId,
          data,
        });
      },
      onTransition: (entry) => {
        this._onTransition?.(entry);
        this._notifyViewModelChange();

        // Emit connection state change event
        this._emitManagerEvent({
          type: 'connection-state-changed',
          remoteAgent,
          connectionId,
          data: { fromState: entry.fromState, toState: entry.toState },
        });

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
        console.error('ConnectionManager view model listener error:', e);
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
          console.error('ConnectionManager event handler error:', e);
        }
      }
    }
  }
}
