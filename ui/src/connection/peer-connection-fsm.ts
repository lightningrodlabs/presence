/**
 * PeerConnectionFSM — Per-peer finite state machine for WebRTC connections.
 *
 * Single source of truth for one peer connection's lifecycle.
 * Manages state transitions, timers, reconnection, and exposes a reactive
 * ConnectionViewModel for UI subscription.
 *
 * Two-layer state model:
 * - Layer 1 (ConnectionPhase): Application-level state, drives UI
 * - Layer 2 (TransportSnapshot): Mirrors browser WebRTC states, for debugging
 *
 * See docs/webrtc-state-machine-plan.md
 */

import { RTCPeer } from './rtc-peer';
import type { RTCPeerOptions } from './rtc-peer';
import { DefaultReconnectPolicy } from './reconnect-policy';
import type {
  ConnectionPhase,
  ConnectionConfig,
  ConnectionRole,
  ConnectionViewModel,
  FSMEvent,
  FSMEventHandler,
  FSMTransitionEntry,
  ReconnectContext,
  ReconnectPolicy,
  TransportSnapshot,
  Unsubscribe,
} from './types';
import { VALID_TRANSITIONS, createIdleViewModel, DEFAULT_CONFIG } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PeerConnectionFSMOptions = {
  remoteAgent: string;
  connectionId: string;
  polite: boolean;
  config?: ConnectionConfig;
  role?: ConnectionRole;
  reconnectPolicy?: ReconnectPolicy;
  /** Callback to send signaling data to remote peer */
  onSignal: (data: RTCSessionDescriptionInit | RTCIceCandidateInit) => void;
  /** Optional: log callback for FSM transitions */
  onTransition?: (entry: FSMTransitionEntry) => void;
  /** Optional: factory for RTCPeerConnection (for testing) */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
};

type Timer = {
  id: ReturnType<typeof setTimeout>;
  name: string;
};

// ---------------------------------------------------------------------------
// FSM Implementation
// ---------------------------------------------------------------------------

export class PeerConnectionFSM {
  readonly remoteAgent: string;
  readonly connectionId: string;
  readonly role: ConnectionRole;

  private _state: ConnectionPhase = 'idle';
  private _config: ConnectionConfig;
  private _polite: boolean;
  private _reconnectPolicy: ReconnectPolicy;
  private _onSignalCallback: (data: RTCSessionDescriptionInit | RTCIceCandidateInit) => void;
  private _onTransition: ((entry: FSMTransitionEntry) => void) | undefined;
  private _createPeerConnection: ((config: RTCConfiguration) => RTCPeerConnection) | undefined;

  private _peer: RTCPeer | null = null;
  private _handlers: Map<string, FSMEventHandler[]> = new Map();
  private _timers: Timer[] = [];
  private _destroyed = false;

  // Phase tracking
  private _phaseEnteredAt: number = Date.now();

  // Reconnection state
  private _reconnectCount = 0;
  private _reconnectStartedAt = 0;
  private _reconnectReason: ReconnectContext['retryReason'] = 'ice-failed';
  private _lastReconnectStrategy: 'ice-restart' | 'full-reconnect' = 'ice-restart';

  // Track state
  private _audioSending = false;
  private _audioReceiving = false;
  private _videoSending = false;
  private _videoReceiving = false;
  private _videoMuted = false;

  // Connection quality
  private _relayed = false;
  private _candidateType: 'host' | 'srflx' | 'relay' | 'unknown' = 'unknown';
  private _roundTripMs: number | null = null;

  // Composite readiness flags
  private _iceConnected = false;
  private _dtlsConnected = false;
  private _dataChannelOpen = false;

  // Diagnostic counters
  private _localCandidateCount = 0;
  private _remoteCandidateCount = 0;

  // Remote peer's connectionId — set when we receive an offer or answer.
  // Used by ConnectionManager to filter stale signals from previous sessions.
  private _remoteConnectionId: string | null = null;

  // Monotonic counter — incremented each time _createPeer() is called.
  // Stamps outgoing signals; incoming signals with a lower value are stale.
  private _peerSessionId = 0;
  private _remotePeerSessionId = 0;

  // View model — reactive store (simple callback-based for now, will be wrapped in Writable by ConnectionManager)
  private _viewModelListeners: Set<(vm: ConnectionViewModel) => void> = new Set();
  private _currentViewModel: ConnectionViewModel;

  constructor(options: PeerConnectionFSMOptions) {
    this.remoteAgent = options.remoteAgent;
    this.connectionId = options.connectionId;
    this.role = options.role ?? 'mesh';
    this._config = options.config ?? DEFAULT_CONFIG;
    this._polite = options.polite;
    this._reconnectPolicy = options.reconnectPolicy ?? new DefaultReconnectPolicy();
    this._onSignalCallback = options.onSignal;
    this._onTransition = options.onTransition;
    this._createPeerConnection = options.createPeerConnection;
    this._currentViewModel = createIdleViewModel();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get state(): ConnectionPhase {
    return this._state;
  }

  get peer(): RTCPeer | null {
    return this._peer;
  }

  get viewModel(): ConnectionViewModel {
    return this._computeViewModel();
  }

  /** The remote peer's connectionId, learned from their offer/answer signals. */
  get remoteConnectionId(): string | null {
    return this._remoteConnectionId;
  }

  /** Current peer session counter — increments on each new RTCPeerConnection. */
  get peerSessionId(): number {
    return this._peerSessionId;
  }

  /** Remote peer's session counter — learned from their signals. */
  get remotePeerSessionId(): number {
    return this._remotePeerSessionId;
  }

  get transportSnapshot(): TransportSnapshot {
    if (this._peer && !this._peer.destroyed) {
      return this._peer.transportSnapshot;
    }
    return {
      ice: 'new',
      dtls: 'new',
      signaling: 'stable',
      gathering: 'new',
      dataChannel: null,
    };
  }

  /** Subscribe to view model changes */
  onViewModelChange(listener: (vm: ConnectionViewModel) => void): Unsubscribe {
    this._viewModelListeners.add(listener);
    // Immediately emit current state
    listener(this._computeViewModel());
    return () => {
      this._viewModelListeners.delete(listener);
    };
  }

  /**
   * Start a connection. Transitions Idle → Signaling.
   * Creates the RTCPeer and begins the Perfect Negotiation process.
   */
  connect(localStream?: MediaStream): void {
    if (this._destroyed) return;
    this._transition('signaling', 'connect() called');
    this._createPeer();
    if (localStream) {
      this._addLocalStream(localStream);
    }
  }

  /**
   * Handle a remote signal (SDP offer/answer or ICE candidate).
   * Can trigger Idle → Signaling if we receive a signal before connect() is called.
   *
   * @param signal — the SDP or ICE candidate data
   * @param remoteConnectionId — the connectionId from the signal's sender,
   *   used to track which remote session this signal belongs to.
   */
  async handleRemoteSignal(signal: RTCSessionDescriptionInit | RTCIceCandidateInit, remoteConnectionId?: string, remotePeerSessionId?: number): Promise<void> {
    if (this._destroyed) return;

    // Filter stale signals from the remote peer's previous RTCPeerConnection sessions.
    // Offers always pass — they indicate the remote created a new peer session.
    const isOffer = 'type' in signal && signal.type === 'offer';
    if (!isOffer && remotePeerSessionId !== undefined && remotePeerSessionId < this._remotePeerSessionId) {
      console.debug(
        `[FSM ${this.remoteAgent.slice(5, 13)}] Dropped stale ${('type' in signal) ? signal.type : 'candidate'}: ` +
        `remote session ${remotePeerSessionId} < current ${this._remotePeerSessionId}`
      );
      return;
    }

    // Update remote peer session tracking from offers/answers.
    if (remotePeerSessionId !== undefined && remotePeerSessionId > this._remotePeerSessionId) {
      this._remotePeerSessionId = remotePeerSessionId;
    }

    // If we're idle and receive a signal, auto-transition to signaling
    if (this._state === 'idle') {
      this._transition('signaling', 'remote signal received');
      this._createPeer();
    }

    // Record the remote peer's connectionId from offer/answer signals.
    // Must happen after _createPeer() which resets _remoteConnectionId.
    if (remoteConnectionId && 'type' in signal && (signal.type === 'offer' || signal.type === 'answer')) {
      this._remoteConnectionId = remoteConnectionId;
    }

    // Count remote candidates for diagnostics
    if ('candidate' in signal && (signal as any).candidate !== undefined) {
      this._remoteCandidateCount++;
    }

    // If we're in a state that can handle signals, forward to peer
    if (this._peer && !this._peer.destroyed) {
      await this._peer.handleSignal(signal);
    }
  }

  /** Add a local media stream to the connection */
  addLocalStream(stream: MediaStream): void {
    if (this._destroyed || !this._peer) return;
    this._addLocalStream(stream);
  }

  /** Remove a local media stream */
  removeLocalStream(stream: MediaStream): void {
    if (this._destroyed || !this._peer) return;
    for (const sender of this._peer.getSenders()) {
      if (sender.track) {
        this._peer.removeTrack(sender);
      }
    }
  }

  /** Replace a track on an existing sender */
  async replaceTrack(oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack): Promise<void> {
    if (this._destroyed || !this._peer) return;
    const sender = this._peer.getSenders().find(s => s.track === oldTrack);
    if (sender) {
      await this._peer.replaceTrack(sender, newTrack);
    }
  }

  /**
   * Force-refresh media tracks without tearing down the connection.
   * Replaces each sender's track with the corresponding fresh track from the
   * stream, triggering re-encoding. If the stream has tracks that aren't on
   * any sender, they're added. This is a lighter recovery than full reconnect
   * — preserves the ICE/DTLS session.
   */
  refreshMedia(stream: MediaStream): void {
    if (this._destroyed || !this._peer) return;
    const senders = this._peer.getSenders();

    for (const track of stream.getTracks()) {
      // Find a sender for this track kind
      const sender = senders.find(s =>
        s.track?.kind === track.kind || this._senderMatchesKind(s, track.kind)
      );

      if (sender) {
        // Replace the track even if it's the same object — forces re-encoding
        this._peer.replaceTrack(sender, track).catch(e => {
          console.warn(`refreshMedia: replaceTrack failed for ${track.kind}:`, e);
        });
      } else {
        // No existing sender for this kind — add it (triggers renegotiation)
        try {
          this._peer.addTrack(track, stream);
        } catch (e) {
          console.warn(`refreshMedia: addTrack failed for ${track.kind}:`, e);
        }
      }

      if (track.kind === 'audio') this._audioSending = true;
      if (track.kind === 'video') this._videoSending = true;
    }
  }

  /** Send data via the data channel */
  send(data: string): void {
    if (this._destroyed || !this._peer) return;
    this._peer.send(data);
  }

  /** Close the connection explicitly (peer left, blocked, etc.) */
  close(reason: string): void {
    if (this._destroyed) return;
    if (this._state === 'closed') return;
    this._transition('closed', reason);
    this._destroyPeer();
  }

  /** Destroy the FSM entirely — no further operations possible */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._clearAllTimers();
    this._destroyPeer();
    this._handlers.clear();
    this._viewModelListeners.clear();
  }

  /** Subscribe to FSM events */
  on(type: string, handler: FSMEventHandler): Unsubscribe {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, []);
    }
    this._handlers.get(type)!.push(handler);
    return () => {
      const handlers = this._handlers.get(type);
      if (handlers) {
        this._handlers.set(type, handlers.filter(h => h !== handler));
      }
    };
  }

  // ---------------------------------------------------------------------------
  // State Machine Core
  // ---------------------------------------------------------------------------

  private _transition(newState: ConnectionPhase, trigger: string, metadata?: Record<string, any>): void {
    const oldState = this._state;

    // Guard: check if transition is valid
    const validTargets = VALID_TRANSITIONS[oldState];
    if (!validTargets.has(newState)) {
      // Log blocked transition
      const entry: FSMTransitionEntry = {
        timestamp: Date.now(),
        connectionId: this.connectionId,
        remoteAgent: this.remoteAgent,
        fromState: oldState,
        toState: newState,
        trigger: `BLOCKED: ${trigger}`,
        transportSnapshot: this.transportSnapshot,
        metadata,
      };
      this._onTransition?.(entry);
      this._emitEvent({
        type: 'error',
        connectionId: this.connectionId,
        remoteAgent: this.remoteAgent,
        data: { blocked: true, fromState: oldState, toState: newState, trigger },
      });
      return;
    }

    // Cancel timers owned by the exiting state
    this._clearAllTimers();

    // Perform transition
    this._state = newState;
    this._phaseEnteredAt = Date.now();

    // Log the transition
    const entry: FSMTransitionEntry = {
      timestamp: Date.now(),
      connectionId: this.connectionId,
      remoteAgent: this.remoteAgent,
      fromState: oldState,
      toState: newState,
      trigger,
      transportSnapshot: this.transportSnapshot,
      metadata,
    };
    this._onTransition?.(entry);

    // Start timers for the new state
    this._startTimersForState(newState);

    // Reset reconnection state on successful connection
    if (newState === 'connected') {
      this._reconnectCount = 0;
      this._reconnectStartedAt = 0;
    }

    // Emit state change event
    this._emitEvent({
      type: 'state-changed',
      connectionId: this.connectionId,
      remoteAgent: this.remoteAgent,
      data: { fromState: oldState, toState: newState, trigger },
    });

    // Update view model
    this._notifyViewModelChange();
  }

  private _startTimersForState(state: ConnectionPhase): void {
    switch (state) {
      case 'signaling':
        // Timeout if SDP exchange takes too long
        this._startTimer('sdp-exchange-timeout', this._config.sdpExchangeTimeoutMs, () => {
          if (this._state === 'signaling') {
            this._transition('disconnected', 'SDP exchange timeout');
          }
        });
        break;

      case 'connecting':
        // Timeout if connection doesn't complete
        this._startTimer('connection-timeout', this._config.connectionTimeoutMs, () => {
          if (this._state === 'connecting') {
            this._transition('disconnected', 'connection timeout');
          }
        });
        break;

      case 'reconnecting':
        // Schedule reconnect attempt
        this._scheduleReconnectAttempt();
        break;

      case 'failed':
        // Auto-transition to idle after a cleanup delay
        this._startTimer('failed-cleanup', 5000, () => {
          if (this._state === 'failed') {
            this._destroyPeer();
            this._transition('idle', 'cleanup after failure');
          }
        });
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Reconnection
  // ---------------------------------------------------------------------------

  private _scheduleReconnectAttempt(): void {
    const context: ReconnectContext = {
      retryCount: this._reconnectCount,
      elapsedMs: Date.now() - this._reconnectStartedAt,
      retryReason: this._reconnectReason,
      lastStrategy: this._lastReconnectStrategy,
    };

    const delayMs = this._reconnectPolicy.nextRetryDelayMs(context);
    if (delayMs === null) {
      // Retries exhausted
      this._transition('disconnected', 'reconnect retries exhausted');
      return;
    }

    const strategy = this._reconnectPolicy.strategy(context);
    this._lastReconnectStrategy = strategy;

    this._startTimer('reconnect-attempt', delayMs, () => {
      if (this._state !== 'reconnecting') return;

      this._reconnectCount++;

      if (strategy === 'ice-restart') {
        this._attemptIceRestart();
      } else {
        this._attemptFullReconnect();
      }
    });
  }

  private _attemptIceRestart(): void {
    if (!this._peer || this._peer.destroyed) {
      // No peer to restart — escalate to full reconnect
      this._attemptFullReconnect();
      return;
    }

    this._peer.restartIce();

    // Set a timeout for the ICE restart
    this._startTimer('ice-restart-timeout', this._config.connectionTimeoutMs, () => {
      if (this._state === 'reconnecting') {
        // ICE restart didn't work, try again (policy decides strategy)
        this._scheduleReconnectAttempt();
      }
    });
  }

  private _attemptFullReconnect(): void {
    // Destroy current peer and create a new one
    this._destroyPeer();
    this._resetReadinessFlags();
    this._createPeer();

    // Set a timeout for the full reconnect
    this._startTimer('full-reconnect-timeout', this._config.connectionTimeoutMs, () => {
      if (this._state === 'reconnecting') {
        this._scheduleReconnectAttempt();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // RTCPeer Management
  // ---------------------------------------------------------------------------

  private _createPeer(): void {
    if (this._peer && !this._peer.destroyed) {
      this._peer.destroy();
    }

    this._localCandidateCount = 0;
    this._remoteCandidateCount = 0;
    this._remoteConnectionId = null;
    this._peerSessionId++;

    const options: RTCPeerOptions = {
      polite: this._polite,
      config: this._config,
      onSignal: (data) => {
        if ('candidate' in data && (data as any).candidate !== undefined) {
          this._localCandidateCount++;
        }
        this._onSignalCallback(data);
      },
      createPeerConnection: this._createPeerConnection,
    };

    this._peer = new RTCPeer(options);
    this._setupPeerEvents(this._peer);
  }

  private _destroyPeer(): void {
    if (this._peer) {
      this._peer.destroy();
      this._peer = null;
    }
  }

  private _addLocalStream(stream: MediaStream): void {
    if (!this._peer || this._peer.destroyed) return;

    const senders = this._peer.getSenders();

    for (const track of stream.getTracks()) {
      // Check if this exact track is already on a sender
      const alreadyAdded = senders.find(s => s.track && s.track.id === track.id);
      if (alreadyAdded) continue;

      // Check if there's an existing sender for this track kind with a
      // null/ended track — reuse it via replaceTrack to avoid creating
      // a new transceiver (which causes track accumulation on renegotiation)
      const reusableSender = senders.find(s =>
        (!s.track || s.track.readyState === 'ended') &&
        // Match by kind: check the transceiver's receiver track kind
        // since sender.track may be null
        this._senderMatchesKind(s, track.kind)
      );

      try {
        if (reusableSender) {
          this._peer.replaceTrack(reusableSender, track).catch(e => {
            console.warn(`Failed to replace ${track.kind} track, falling back to addTrack:`, e);
            this._peer!.addTrack(track, stream);
          });
        } else {
          this._peer.addTrack(track, stream);
        }
      } catch (e) {
        console.warn(`Failed to add ${track.kind} track: `, e);
        continue;
      }
      if (track.kind === 'audio') this._audioSending = true;
      if (track.kind === 'video') this._videoSending = true;
    }
  }

  /** Check if a sender's transceiver matches a given track kind */
  private _senderMatchesKind(sender: RTCRtpSender, kind: string): boolean {
    // If the sender still has a track, check its kind
    if (sender.track) return sender.track.kind === kind;
    // Otherwise, check the transceiver (if accessible via getTransceivers)
    try {
      const pc = this._peer?.pc;
      if (pc) {
        const transceiver = pc.getTransceivers().find(t => t.sender === sender);
        if (transceiver) {
          return transceiver.receiver.track.kind === kind;
        }
      }
    } catch (e) {
      // getTransceivers not available
    }
    return false;
  }

  private _setupPeerEvents(peer: RTCPeer): void {
    // ICE state changes — drive Layer 1 transitions
    peer.on('ice-state-change', (event) => {
      if (this._destroyed) return;
      const iceState = event.data as string;
      const agentShort = this.remoteAgent.slice(0, 8);
      this._onTransition?.({
        timestamp: Date.now(),
        connectionId: this.connectionId,
        remoteAgent: this.remoteAgent,
        fromState: this._state,
        toState: this._state,
        trigger: `ICE: ${iceState} (local=${this._localCandidateCount} remote=${this._remoteCandidateCount})`,
      });

      if (iceState === 'connected' || iceState === 'completed') {
        this._iceConnected = true;
        this._checkCompositeReadiness();
      } else if (iceState === 'disconnected' || iceState === 'failed') {
        this._iceConnected = false;
        this._handleTransportFailure(iceState === 'failed' ? 'ice-failed' : 'ice-disconnected');
      }
    });



    // Connection state changes (aggregate ICE + DTLS)
    peer.on('connect', () => {
      if (this._destroyed) return;
      this._iceConnected = true;
      this._dtlsConnected = true;
      this._checkCompositeReadiness();
    });

    peer.on('close', (event) => {
      if (this._destroyed) return;
      const reason = event.data as string;
      if (reason === 'failed') {
        // connectionState 'failed' means ICE or DTLS failed.
        // Use worst-case interpretation: treat as DTLS failure (terminal)
        // since DTLS has no recovery path per W3C spec.
        // If it's actually just ICE, the ice-state-change handler handles it.
        if (this._state === 'connected' || this._state === 'connecting') {
          this._handleTransportFailure('dtls-failed');
        }
      }
    });

    // Data channel state
    peer.on('data-channel-state-change', (event) => {
      if (this._destroyed) return;
      const dcState = event.data as string;
      this._dataChannelOpen = dcState === 'open';
      if (this._dataChannelOpen) {
        this._checkCompositeReadiness();
      }
    });

    // Signaling state — move from signaling to connecting
    peer.on('signaling-state-change', (event) => {
      if (this._destroyed) return;
      const sigState = event.data as string;
      // When we return to stable after offer/answer exchange, we're connecting
      if (sigState === 'stable' && this._state === 'signaling') {
        this._transition('connecting', 'SDP exchange complete (signaling stable)');
      }
    });

    // Remote tracks
    peer.on('track', (event) => {
      if (this._destroyed) return;
      const { track } = event.data;
      if (track.kind === 'audio') this._audioReceiving = true;
      if (track.kind === 'video') {
        if (track.muted) {
          this._videoMuted = true;
        } else {
          this._videoReceiving = true;
          this._videoMuted = false;
        }
      }
      this._emitEvent({
        type: 'remote-track',
        connectionId: this.connectionId,
        remoteAgent: this.remoteAgent,
        data: event.data,
      });
      this._notifyViewModelChange();
    });

    peer.on('stream', (event) => {
      if (this._destroyed) return;
      this._emitEvent({
        type: 'remote-stream',
        connectionId: this.connectionId,
        remoteAgent: this.remoteAgent,
        data: event.data,
      });
    });

    // Data channel messages
    peer.on('data', (event) => {
      if (this._destroyed) return;
      this._emitEvent({
        type: 'data-channel-message',
        connectionId: this.connectionId,
        remoteAgent: this.remoteAgent,
        data: event.data,
      });
    });

    // Data channel open
    peer.on('data-channel-state-change', (event) => {
      if (this._destroyed) return;
      if (event.data === 'open') {
        this._emitEvent({
          type: 'data-channel-open',
          connectionId: this.connectionId,
          remoteAgent: this.remoteAgent,
        });
      }
    });

    // Errors
    peer.on('error', (event) => {
      if (this._destroyed) return;
      this._emitEvent({
        type: 'error',
        connectionId: this.connectionId,
        remoteAgent: this.remoteAgent,
        data: event.data,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Composite Readiness (from simple-peer pattern)
  // ---------------------------------------------------------------------------

  /**
   * Connection is only "connected" when ALL of:
   * - ICE transport is connected/completed
   * - DTLS transport is connected
   * - Data channel is open
   */
  private _checkCompositeReadiness(): void {
    if (!this._iceConnected || !this._dtlsConnected || !this._dataChannelOpen) {
      return;
    }

    if (this._state === 'connecting') {
      this._transition('connected', 'composite readiness achieved (ICE + DTLS + data channel)');
      this._detectRelayAfterConnect();
    } else if (this._state === 'reconnecting') {
      this._transition('connected', 'reconnection succeeded');
      this._detectRelayAfterConnect();
    }
  }

  private _resetReadinessFlags(): void {
    this._iceConnected = false;
    this._dtlsConnected = false;
    this._dataChannelOpen = false;
  }

  // ---------------------------------------------------------------------------
  // Transport Failure Handling
  // ---------------------------------------------------------------------------

  private _handleTransportFailure(reason: ReconnectContext['retryReason']): void {
    if (this._state === 'connected') {
      // Transition to reconnecting
      this._reconnectReason = reason;
      this._reconnectStartedAt = Date.now();
      this._reconnectCount = 0;

      if (reason === 'dtls-failed') {
        // DTLS failure is terminal per W3C spec — go to failed, not reconnecting
        this._transition('failed', 'DTLS transport failed (terminal)');
      } else {
        this._transition('reconnecting', `transport failure: ${reason}`);
      }
    } else if (this._state === 'connecting') {
      // Connection never completed — go to disconnected
      this._transition('disconnected', `connection failed during setup: ${reason}`);
    }
    // If already reconnecting, the reconnect timer handles it
  }

  // ---------------------------------------------------------------------------
  // Connection Quality Detection
  // ---------------------------------------------------------------------------

  private _detectRelayAfterConnect(): void {
    // Check relay status after 2 seconds to let ICE settle
    this._startTimer('relay-detection', 2000, async () => {
      if (!this._peer || this._peer.destroyed || this._state !== 'connected') return;

      try {
        const stats = await this._peer.getStats();
        stats.forEach((report: any) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            // Find the local candidate
            stats.forEach((r: any) => {
              if (r.id === report.localCandidateId) {
                this._candidateType = r.candidateType || 'unknown';
                this._relayed = r.candidateType === 'relay';
              }
            });
            if (report.currentRoundTripTime != null) {
              this._roundTripMs = report.currentRoundTripTime * 1000;
            }
          }
        });
      } catch (e) {
        // Stats not available — leave as unknown
      }
      this._notifyViewModelChange();
    });
  }

  // ---------------------------------------------------------------------------
  // Timer Management
  // ---------------------------------------------------------------------------

  private _startTimer(name: string, delayMs: number, callback: () => void): void {
    const id = setTimeout(() => {
      this._timers = this._timers.filter(t => t.name !== name);
      callback();
    }, delayMs);
    this._timers.push({ id, name });
  }

  private _clearAllTimers(): void {
    for (const timer of this._timers) {
      clearTimeout(timer.id);
    }
    this._timers = [];
  }

  // ---------------------------------------------------------------------------
  // View Model
  // ---------------------------------------------------------------------------

  private _computeViewModel(): ConnectionViewModel {
    const now = Date.now();
    const vm: ConnectionViewModel = {
      phase: this._state,
      progress: this._computeProgress(),
      statusText: this._computeStatusText(),
      phaseElapsedMs: now - this._phaseEnteredAt,
      phaseEnteredAt: this._phaseEnteredAt,
      retry: this._state === 'reconnecting' || this._state === 'disconnected'
        ? {
            attemptNumber: this._reconnectCount,
            maxAttempts: this._reconnectPolicy.maxAttempts,
            nextRetryMs: this._reconnectPolicy.nextRetryDelayMs({
              retryCount: this._reconnectCount,
              elapsedMs: now - this._reconnectStartedAt,
              retryReason: this._reconnectReason,
              lastStrategy: this._lastReconnectStrategy,
            }),
            strategy: this._lastReconnectStrategy,
          }
        : null,
      quality: this._state === 'connected'
        ? {
            relayed: this._relayed,
            candidateType: this._candidateType,
            roundTripMs: this._roundTripMs,
          }
        : null,
      tracks: this._state === 'connected'
        ? {
            audioSending: this._audioSending,
            audioReceiving: this._audioReceiving,
            videoSending: this._videoSending,
            videoReceiving: this._videoReceiving,
            videoMuted: this._videoMuted,
          }
        : null,
      healthy: this._state === 'connected' && this._iceConnected && this._dtlsConnected,
    };
    this._currentViewModel = vm;
    return vm;
  }

  private _computeProgress(): number {
    switch (this._state) {
      case 'idle': return 0;
      case 'signaling': {
        // Estimate progress based on signaling state
        if (!this._peer) return 0;
        const sigState = this._peer.pc?.signalingState;
        if (sigState === 'have-local-offer' || sigState === 'have-remote-offer') return 0.5;
        if (sigState === 'stable' && this._state === 'signaling') return 0.9;
        return 0.2;
      }
      case 'connecting': {
        let p = 0;
        if (this._iceConnected) p += 0.4;
        if (this._dtlsConnected) p += 0.3;
        if (this._dataChannelOpen) p += 0.3;
        return p;
      }
      case 'connected': return 1;
      case 'reconnecting': {
        if (this._reconnectPolicy.maxAttempts === 0) return 0;
        return this._reconnectCount / this._reconnectPolicy.maxAttempts;
      }
      case 'disconnected': return 0;
      case 'failed': return 0;
      case 'closed': return 0;
      default: return 0;
    }
  }

  private _computeStatusText(): string {
    switch (this._state) {
      case 'idle': return 'Not connected';
      case 'signaling': return 'Exchanging connection info...';
      case 'connecting': {
        if (this._iceConnected && !this._dtlsConnected) return 'Securing connection...';
        if (this._iceConnected && this._dtlsConnected && !this._dataChannelOpen) return 'Opening data channel...';
        return 'Establishing connection...';
      }
      case 'connected':
        if (this._relayed) return 'Connected (relayed)';
        return 'Connected';
      case 'reconnecting':
        return `Reconnecting (attempt ${this._reconnectCount + 1}/${this._reconnectPolicy.maxAttempts})...`;
      case 'disconnected': return 'Disconnected';
      case 'failed': return 'Connection failed';
      case 'closed': return 'Connection closed';
      default: return 'Unknown';
    }
  }

  private _notifyViewModelChange(): void {
    const vm = this._computeViewModel();
    for (const listener of this._viewModelListeners) {
      try {
        listener(vm);
      } catch (e) {
        console.error('View model listener error:', e);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event Emission
  // ---------------------------------------------------------------------------

  private _emitEvent(event: FSMEvent): void {
    const handlers = this._handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (e) {
          console.error('FSM event handler error:', e);
        }
      }
    }
  }
}
