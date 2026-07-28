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
 * Which layer owns reconnection and give-up — this FSM or the caller — is the
 * distinction most likely to be got wrong when embedding it. See "Reconnection"
 * and "Ownership: who drives recovery" in README.md.
 */

import { RTCPeer } from './rtc-peer.js';
import type { RTCPeerOptions } from './rtc-peer.js';
import { DefaultReconnectPolicy } from './reconnect-policy.js';
import type {
  ConnectionPhase,
  ConnectionConfig,
  ConnectionRole,
  ConnectionViewModel,
  EstablishmentTimeline,
  FSMEvent,
  FSMEventHandler,
  FSMTransitionEntry,
  Logger,
  ReconnectContext,
  ReconnectPolicy,
  TransportSnapshot,
  Unsubscribe,
} from './types.js';
import { VALID_TRANSITIONS, createIdleViewModel, DEFAULT_CONFIG, NOOP_LOGGER } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PeerConnectionFSMOptions = {
  remoteAgent: string;
  connectionId: string;
  /**
   * Connection generation for this peer pair, allocated by the orchestrator
   * (survives FSM recreation). When set, it is the authoritative cross-FSM
   * "which attempt is current" order; see `SignalMessage.epoch` and
   * docs/WEBRTC_RECONNECT_IDENTITY.md. Optional/backward-compatible.
   */
  epoch?: number;
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
  /**
   * Optional per-connection SDP-exchange timeout (ms), overriding
   * `config.sdpExchangeTimeoutMs`. The application sets this RTT-scaled
   * for initiator connections so a clearly-dead exchange fails faster
   * than the fixed 15s default; omitted (acceptor / no RTT sample) it
   * falls back to the config value.
   */
  sdpExchangeTimeoutMs?: number;
  /** Optional sink for non-fatal diagnostics. Defaults to a no-op. */
  logger?: Logger;
  /**
   * Called synchronously after a fresh `RTCPeerConnection` is constructed for
   * this peer, and before any local tracks are attached or any SDP exchange
   * begins. Use this to install transceivers with custom `sendEncodings`
   * (simulcast), set codec preferences, or otherwise configure the pc before
   * the first offer is generated. Fires once per peer session — i.e. once
   * on initial connect, and once again after each full reconnect.
   */
  onPeerCreated?: (ctx: PeerCreatedContext) => void;
};

export type PeerCreatedContext = {
  remoteAgent: string;
  connectionId: string;
  /** The newly-created peer connection. Mutable; configure it here. */
  pc: RTCPeerConnection;
  role: ConnectionRole;
  /** Local peer session counter — increments each time a new pc is created. */
  peerSessionId: number;
};

type Timer = {
  id: ReturnType<typeof setTimeout>;
  name: string;
};

/** Context passed to _transition, used by entry actions. */
type TransitionContext = {
  trigger: string;
  metadata?: Record<string, any>;
  /** Stream to attach after peer creation (only relevant for signaling entry). */
  localStream?: MediaStream;
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
  /** Per-connection SDP-exchange timeout override; see options. */
  private _sdpTimeoutOverrideMs: number | undefined;
  private _polite: boolean;
  private _reconnectPolicy: ReconnectPolicy;
  private _onSignalCallback: (data: RTCSessionDescriptionInit | RTCIceCandidateInit) => void;
  private _onTransition: ((entry: FSMTransitionEntry) => void) | undefined;
  private _createPeerConnection: ((config: RTCConfiguration) => RTCPeerConnection) | undefined;
  private _onPeerCreated: ((ctx: PeerCreatedContext) => void) | undefined;
  private _logger: Logger;

  private _peer: RTCPeer | null = null;
  private _handlers: Map<string, FSMEventHandler[]> = new Map();
  private _timers: Timer[] = [];
  private _destroyed = false;

  // Phase tracking
  private _phaseEnteredAt: number = Date.now();

  // Reconnection state
  private _reconnectCount = 0;
  private _disconnectedRetryCount = 0;
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

  // Establishment-timeline timestamps (§6.6). Captured per attempt, reset on a
  // fresh establishment, emitted once when `connected` is first reached.
  private _establishmentStartedAt: number | null = null;
  private _dtlsConnectedAt: number | null = null;
  private _dataChannelOpenAt: number | null = null;
  private _establishmentIsReconnect = false;

  // DTLS watchdog — tracks when ICE connects but DTLS hasn't completed
  private _iceConnectedAt: number | null = null;
  private _dtlsWatchdogId: ReturnType<typeof setTimeout> | null = null;
  private _dataChannelWatchdogId: ReturnType<typeof setTimeout> | null = null;
  private _dataChannelRecreateAttempts = 0;

  // Track event listener cleanup
  private _trackCleanups: (() => void)[] = [];
  private _dtlsStallCount = 0;

  // Diagnostic counters
  private _localCandidateCount = 0;
  private _remoteCandidateCount = 0;
  /** Stored local stream for re-addition after peer recreation (reconnect) */
  private _localStream: MediaStream | null = null;

  // Remote peer's connectionId — set when we receive an offer or answer.
  // Used by ConnectionManager to filter stale signals from previous sessions.
  private _remoteConnectionId: string | null = null;

  // Connection generation ("epoch") for this peer pair (orchestrator-allocated,
  // monotonic across FSM recreation). `_epoch` is our attempt's generation;
  // `_remoteEpoch` is the highest generation seen from the peer. Used for the
  // authoritative cross-FSM "newest attempt wins" ordering. null => not in use
  // (legacy connectionId/peerSessionId path). See docs/WEBRTC_RECONNECT_IDENTITY.md.
  private _epoch: number | null = null;
  private _remoteEpoch: number | null = null;

  // Peer session identity — managed by the FSM's transition logic.
  // local: incremented each time a new RTCPeerConnection is created (entry action for signaling, full reconnect).
  // remote: updated when accepting an offer/answer with a higher session ID.
  private _session = { local: 0, remote: 0 };

  // View model — reactive store (simple callback-based for now, will be wrapped in Writable by ConnectionManager)
  private _viewModelListeners: Set<(vm: ConnectionViewModel) => void> = new Set();
  private _currentViewModel: ConnectionViewModel;

  constructor(options: PeerConnectionFSMOptions) {
    this.remoteAgent = options.remoteAgent;
    this.connectionId = options.connectionId;
    this._epoch = options.epoch ?? null;
    this.role = options.role ?? 'mesh';
    this._config = options.config ?? DEFAULT_CONFIG;
    this._sdpTimeoutOverrideMs = options.sdpExchangeTimeoutMs;
    this._polite = options.polite;
    this._reconnectPolicy = options.reconnectPolicy ?? new DefaultReconnectPolicy();
    this._onSignalCallback = options.onSignal;
    this._onTransition = options.onTransition;
    this._createPeerConnection = options.createPeerConnection;
    this._onPeerCreated = options.onPeerCreated;
    this._logger = options.logger ?? NOOP_LOGGER;
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

  /**
   * Recreate the data channel in place on the existing RTCPeerConnection — no
   * ICE/DTLS teardown, no new peer session, no SDP renegotiation of the
   * already-negotiated SCTP m-section. The same recovery the data-channel
   * watchdog performs automatically, exposed for deliberate use. Returns true
   * if delegated to a live peer, false if there is none (idle/destroyed).
   */
  recreateDataChannel(): boolean {
    if (this._destroyed || !this._peer) return false;
    this._peer.recreateDataChannel();
    return true;
  }

  /**
   * Trigger an ICE restart on the existing peer connection without tearing it
   * down (preserves the DTLS session). Returns true if delegated to a live
   * peer, false if there is none (idle/destroyed).
   */
  restartIce(): boolean {
    if (this._destroyed || !this._peer) return false;
    this._peer.restartIce();
    return true;
  }

  get viewModel(): ConnectionViewModel {
    return this._computeViewModel();
  }

  /** The remote peer's connectionId, learned from their offer/answer signals. */
  get remoteConnectionId(): string | null {
    return this._remoteConnectionId;
  }

  /** This connection's generation ("epoch"), or null if epochs are not in use. */
  get epoch(): number | null {
    return this._epoch;
  }

  /** Highest remote epoch seen from the peer, or null if none seen / not in use. */
  get remoteEpoch(): number | null {
    return this._remoteEpoch;
  }

  /** Current peer session counter — increments on each new RTCPeerConnection. */
  get peerSessionId(): number {
    return this._session.local;
  }

  /** Remote peer's session counter — learned from their signals. */
  get remotePeerSessionId(): number {
    return this._session.remote;
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
    this._transition('signaling', { trigger: 'connect() called', localStream });
  }

  /**
   * Handle a remote signal (SDP offer/answer or ICE candidate).
   * Can trigger Idle → Signaling if we receive a signal before connect() is called.
   *
   * @param signal — the SDP or ICE candidate data
   * @param remoteConnectionId — the connectionId from the signal's sender,
   *   used to track which remote session this signal belongs to.
   */
  async handleRemoteSignal(signal: RTCSessionDescriptionInit | RTCIceCandidateInit, remoteConnectionId?: string, remotePeerSessionId?: number, remoteEpoch?: number): Promise<void> {
    if (this._destroyed) return;

    // Record the highest remote epoch seen (diagnostic / getter). Cross-epoch
    // ordering is enforced upstream in ConnectionManager._routeSignalToFSM;
    // by the time a signal reaches here it is same-epoch (or epochs are unused).
    if (remoteEpoch != null) {
      this._remoteEpoch = this._remoteEpoch == null ? remoteEpoch : Math.max(this._remoteEpoch, remoteEpoch);
    }

    // Validate signal session — part of the FSM's contract
    const validation = this._validateSignalSession(signal, remotePeerSessionId);
    if (validation === 'drop') return;
    if (validation === 'update') {
      this._session.remote = remotePeerSessionId ?? 0;
    }

    // If we're idle and receive a signal, auto-transition to signaling
    if (this._state === 'idle') {
      this._transition('signaling', { trigger: 'remote signal received' });
    }

    // If we're disconnected and receive an offer, treat it as a fresh
    // connection opportunity. The stale RTCPeerConnection's m-lines won't
    // match the new offer (causes "order of m-lines doesn't match" error).
    // Transition to signaling creates a fresh peer via _newPeerSession().
    if (this._state === 'disconnected' && 'type' in signal && signal.type === 'offer') {
      this._transition('signaling', { trigger: 'remote signal received' });
    }

    // When in reconnecting/connecting state and receiving an offer from a new
    // remote connection (the remote peer has refreshed/reconnected), the old
    // RTCPeerConnection has m-lines from the previous session that won't
    // match the fresh offer. Trying to setRemoteDescription on the old peer
    // causes "The order of m-lines in subsequent offer doesn't match" errors.
    // Fix: destroy the old peer and create a fresh one before processing.
    // We check: either remoteConnectionId changed (new remote session), or
    // _remoteConnectionId was never set (local-initiated connection where
    // the remote peer's connectionId was never recorded).
    const isNewRemoteSession = remoteConnectionId &&
      (this._remoteConnectionId === null || remoteConnectionId !== this._remoteConnectionId);
    if ((this._state === 'reconnecting' || this._state === 'connecting') &&
        'type' in signal && signal.type === 'offer' &&
        isNewRemoteSession) {
      this._transition('signaling', {
        trigger: `fresh peer for new remote connection ${remoteConnectionId!.slice(0, 8)} (was ${this._remoteConnectionId?.slice(0, 8) ?? 'null'})`,
      });
    }

    // Record the remote peer's connectionId from offer/answer signals.
    // Must happen after entry action which resets _remoteConnectionId.
    if (remoteConnectionId && 'type' in signal && (signal.type === 'offer' || signal.type === 'answer')) {
      this._remoteConnectionId = remoteConnectionId;
    }

    // Count remote candidates for diagnostics
    if ('candidate' in signal && (signal as any).candidate !== undefined) {
      this._remoteCandidateCount++;
    }

    // If we're in a state that can handle signals, forward to peer
    if (this._peer && !this._peer.destroyed && !this._destroyed) {
      try {
        await this._peer.handleSignal(signal);
      } catch (err) {
        this._logger.warn(`[FSM ${this.remoteAgent.slice(0, 8)}] handleSignal error:`, err);
      }
    }
  }

  /** Add a local media stream to the connection */
  addLocalStream(stream: MediaStream): void {
    this._localStream = stream;
    if (this._destroyed || !this._peer) return;
    this._addLocalStream(stream);
  }

  /** Remove a local media stream */
  removeLocalStream(stream: MediaStream): void {
    this._localStream = null;
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
          this._logger.warn(`refreshMedia: replaceTrack failed for ${track.kind}:`, e);
        });
      } else {
        // No existing sender for this kind — add it (triggers renegotiation)
        try {
          this._peer.addTrack(track, stream);
        } catch (e) {
          this._logger.warn(`refreshMedia: addTrack failed for ${track.kind}:`, e);
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
    this._transition('closed', { trigger: reason });
  }

  /** Destroy the FSM entirely — no further operations possible */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._clearAllTimers();
    this._cancelDtlsWatchdog();
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

  private _transition(newState: ConnectionPhase, ctx: TransitionContext): void {
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
        trigger: `BLOCKED: ${ctx.trigger}`,
        peerSessionId: this._session.local,
        transportSnapshot: this.transportSnapshot,
        metadata: ctx.metadata,
      };
      this._onTransition?.(entry);
      this._emitEvent({
        type: 'error',
        connectionId: this.connectionId,
        remoteAgent: this.remoteAgent,
        data: { blocked: true, fromState: oldState, toState: newState, trigger: ctx.trigger },
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
      trigger: ctx.trigger,
      peerSessionId: this._session.local,
      transportSnapshot: this.transportSnapshot,
      metadata: ctx.metadata,
    };
    this._onTransition?.(entry);

    // Entry actions — side effects of entering the new state
    this._onEnterState(newState, oldState, ctx);

    // Start timers for the new state
    this._startTimersForState(newState, oldState);

    // Reset reconnection state on successful connection
    if (newState === 'connected') {
      this._reconnectCount = 0;
      this._disconnectedRetryCount = 0;
      this._reconnectStartedAt = 0;
    }

    // Emit state change event
    this._emitEvent({
      type: 'state-changed',
      connectionId: this.connectionId,
      remoteAgent: this.remoteAgent,
      data: { fromState: oldState, toState: newState, trigger: ctx.trigger },
    });

    // Update view model
    this._notifyViewModelChange();
  }

  private _startTimersForState(state: ConnectionPhase, oldState: ConnectionPhase): void {
    switch (state) {
      case 'signaling': {
        // Timeout if SDP exchange takes too long. Use the per-connection
        // RTT-scaled override when present, else the config default.
        const sdpTimeoutMs =
          this._sdpTimeoutOverrideMs ?? this._config.sdpExchangeTimeoutMs;
        this._startTimer('sdp-exchange-timeout', sdpTimeoutMs, () => {
          if (this._state === 'signaling') {
            // Record the RTCPeerConnection signalingState so log analysis
            // can tell where the SDP exchange stalled (e.g. stuck in
            // have-local-offer = answer never arrived).
            const snap = this.transportSnapshot;
            this._transition('disconnected', {
              trigger:
                `SDP exchange timeout (${sdpTimeoutMs}ms, ` +
                `signaling=${snap.signaling} ice=${snap.ice})`,
            });
          }
        });
        break;
      }

      case 'connecting':
        // Timeout if connection doesn't complete
        this._startTimer('connection-timeout', this._config.connectionTimeoutMs, () => {
          if (this._state === 'connecting') {
            this._transition('disconnected', { trigger: `connection timeout (${this._config.connectionTimeoutMs}ms)` });
          }
        });
        break;

      case 'disconnected': {
        // Guard: give up after max attempts to avoid infinite retry loops
        // (e.g., remote peer never responds to the initial connection).
        if (this._disconnectedRetryCount >= this._reconnectPolicy.maxAttempts) {
          this._transition('failed', { trigger: 'disconnected retry limit reached' });
          break;
        }
        this._disconnectedRetryCount++;

        // Auto-retry with jitter to desynchronize both peers' retry cadence.
        // Without jitter, both sides create new NAT mappings simultaneously,
        // invalidating each other's previous STUN bindings.
        const jitterMs = 500 + Math.floor(Math.random() * 1500); // 500-2000ms
        this._startTimer('retry-jitter', jitterMs, () => {
          if (this._state === 'disconnected') {
            this.connect();
          }
        });
        break;
      }

      case 'reconnecting':
        // Self-transition (full reconnect): timeout is started by _onEnterState
        // First entry: schedule reconnect attempt via policy
        if (oldState !== 'reconnecting') {
          this._scheduleReconnectAttempt();
        }
        break;

      case 'failed':
        // Auto-transition to idle after a cleanup delay
        this._startTimer('failed-cleanup', 5000, () => {
          if (this._state === 'failed') {
            this._transition('idle', { trigger: 'cleanup after failure' });
          }
        });
        break;
    }
  }

  /**
   * Entry actions — side effects triggered by entering a state.
   * Peer creation/destruction happens here, not at scattered call sites.
   */
  private _onEnterState(newState: ConnectionPhase, oldState: ConnectionPhase, ctx: TransitionContext): void {
    switch (newState) {
      case 'signaling':
        // Mark the start of this establishment attempt for the timeline (§6.6).
        // From idle it's the initial join; from any other state it's a retry /
        // fresh-peer-for-new-remote-session, which we count as a reconnect.
        this._beginEstablishmentTimer(oldState !== 'idle');
        // Create a new RTCPeerConnection (new peer session)
        this._resetReadinessFlags();
        this._newPeerSession();
        this._logTransition(`new peer session ${this._session.local}`);
        // Fall back to the cached local stream when entering signaling
        // without an explicit ctx.localStream — happens on the acceptor
        // side, where handleRemoteSignal triggers the transition with no
        // metadata but ConnectionManager.updateLocalStream has already
        // populated `_localStream`. Without this fallback the answer is
        // generated with no outgoing tracks and the remote sees us silent
        // until a renegotiation kicks in.
        {
          const stream = ctx.localStream ?? this._localStream;
          if (stream) {
            this._addLocalStream(stream);
          }
        }
        break;

      case 'reconnecting':
        // Time the reconnect as its own establishment attempt (§6.6).
        this._beginEstablishmentTimer(true);
        // Self-transition (reconnecting → reconnecting): full reconnect with new peer session
        if (oldState === 'reconnecting') {
          this._destroyPeer();
          this._resetReadinessFlags();
          this._newPeerSession();
          this._logTransition(`new peer session ${this._session.local} (full reconnect)`);
          // Wait for the new peer to connect; if it doesn't, schedule another attempt
          this._startTimer('full-reconnect-timeout', this._config.connectionTimeoutMs, () => {
            if (this._state === 'reconnecting') {
              this._scheduleReconnectAttempt();
            }
          });
        }
        // First entry (connected → reconnecting): ICE restart uses existing peer,
        // handled by _scheduleReconnectAttempt via _startTimersForState.
        break;

      case 'idle':
        // Clean up peer when returning to idle (e.g., from failed)
        if (oldState === 'failed') {
          this._destroyPeer();
        }
        break;

      case 'closed':
        this._destroyPeer();
        break;
    }
  }

  /**
   * Signal session validation — part of the FSM's contract.
   * Determines whether an incoming signal should be accepted, accepted with
   * a remote session update, or dropped as stale.
   *
   * Rules:
   * - Offers always pass (they establish a new remote session)
   * - Non-offers with session < _session.remote → 'drop' (stale)
   * - Non-offers with session >= _session.remote → 'accept' or 'update'
   */
  private _validateSignalSession(
    signal: RTCSessionDescriptionInit | RTCIceCandidateInit,
    remotePeerSessionId: number | undefined,
  ): 'accept' | 'update' | 'drop' {
    const sessionId = remotePeerSessionId ?? 0;
    const isOffer = 'type' in signal && signal.type === 'offer';

    // Offers always accepted — they indicate a new remote peer session
    if (isOffer) {
      return sessionId > this._session.remote ? 'update' : 'accept';
    }

    // Non-offers: reject if from older session
    if (sessionId < this._session.remote) {
      const signalType = ('type' in signal) ? signal.type : 'candidate';
      this._logTransition(
        `Dropped stale ${signalType}: remote session ${sessionId} < current ${this._session.remote}`,
      );
      return 'drop';
    }

    return sessionId > this._session.remote ? 'update' : 'accept';
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
      // Retries exhausted — transition to failed (not disconnected, which auto-retries)
      this._transition('failed', { trigger: 'reconnect retries exhausted' });
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
    // Self-transition: reconnecting → reconnecting with a new peer session.
    // The entry action handles peer destruction, readiness reset, and peer creation.
    this._transition('reconnecting', { trigger: 'full reconnect (new peer session)' });
  }

  // ---------------------------------------------------------------------------
  // RTCPeer Management
  // ---------------------------------------------------------------------------

  private _newPeerSession(): void {
    this._destroyPeer();

    this._localCandidateCount = 0;
    this._remoteCandidateCount = 0;
    this._remoteConnectionId = null;
    this._session.local++;

    const options: RTCPeerOptions = {
      polite: this._polite,
      config: this._config,
      trickleICE: this._config.trickleICE,
      onSignal: (data) => {
        if ('candidate' in data && (data as any).candidate !== undefined) {
          this._localCandidateCount++;
        }
        this._onSignalCallback(data);
      },
      createPeerConnection: this._createPeerConnection,
      logger: this._logger,
    };

    this._peer = new RTCPeer(options);
    this._setupPeerEvents(this._peer);

    // Hand the fresh pc to the consumer before tracks are attached, so they
    // can install transceivers with custom sendEncodings (simulcast) etc.
    if (this._onPeerCreated) {
      try {
        this._onPeerCreated({
          remoteAgent: this.remoteAgent,
          connectionId: this.connectionId,
          pc: this._peer.pc,
          role: this.role,
          peerSessionId: this._session.local,
        });
      } catch (e) {
        this._logger.error('onPeerCreated handler error:', e);
      }
    }

    // Re-add local stream so reconnected peer has media tracks
    if (this._localStream) {
      this._addLocalStream(this._localStream);
    }
  }

  private _destroyPeer(): void {
    for (const cleanup of this._trackCleanups) cleanup();
    this._trackCleanups = [];
    if (this._peer) {
      this._peer.destroy();
      this._peer = null;
    }
    // Reset track flags so they don't carry stale state into the next peer
    this._audioSending = false;
    this._audioReceiving = false;
    this._videoSending = false;
    this._videoReceiving = false;
    this._videoMuted = false;
    this._relayed = false;
    this._candidateType = 'unknown';
    this._roundTripMs = null;
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
      // a new transceiver (which causes track accumulation on renegotiation).
      // Only reuse if the transceiver direction already permits sending
      // (sendrecv or sendonly). If the direction is recvonly, we must use
      // addTrack instead — it updates direction to sendrecv and fires
      // negotiationneeded, which replaceTrack does not do.
      const reusableSender = senders.find(s =>
        (!s.track || s.track.readyState === 'ended') &&
        this._senderMatchesKind(s, track.kind) &&
        this._senderCanSend(s)
      );

      try {
        if (reusableSender) {
          this._peer.replaceTrack(reusableSender, track).catch(e => {
            this._logger.warn(`Failed to replace ${track.kind} track, falling back to addTrack:`, e);
            this._peer!.addTrack(track, stream);
          });
        } else {
          this._peer.addTrack(track, stream);
        }
      } catch (e) {
        this._logger.warn(`Failed to add ${track.kind} track: `, e);
        continue;
      }
      if (track.kind === 'audio') this._audioSending = true;
      if (track.kind === 'video') this._videoSending = true;
    }
  }

  /** Check if a sender's transceiver direction permits sending (sendrecv or sendonly) */
  private _senderCanSend(sender: RTCRtpSender): boolean {
    try {
      const pc = this._peer?.pc;
      if (pc) {
        const transceiver = pc.getTransceivers().find(t => t.sender === sender);
        if (transceiver) {
          return transceiver.direction === 'sendrecv' || transceiver.direction === 'sendonly';
        }
      }
    } catch (e) {
      // getTransceivers not available
    }
    // If we can't determine direction, don't treat as reusable — safer to use addTrack
    return false;
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
      this._logTransition(`ICE: ${iceState} (local=${this._localCandidateCount} remote=${this._remoteCandidateCount})`);

      if (iceState === 'connected' || iceState === 'completed') {
        this._iceConnected = true;
        this._iceConnectedAt = Date.now();
        // Maintain the invariant that 'ice-disconnected-grace' is pending
        // iff iceConnectionState is currently 'disconnected'. If we
        // arrived here from a 'disconnected' flicker during the grace
        // window, the connection healed on its own — no reconnect needed.
        this._clearTimer('ice-disconnected-grace');
        // ICE connected — DTLS watchdog takes over from the flat connection-timeout
        if (this._state === 'connecting') {
          const timerCount = this._timers.filter(t => t.name === 'connection-timeout').length;
          this._clearTimer('connection-timeout');
          const afterCount = this._timers.filter(t => t.name === 'connection-timeout').length;
          this._logDiag(`cancelled connection-timeout (had=${timerCount}, after=${afterCount}), starting DTLS watchdog (dtlsConnected=${this._dtlsConnected}, dcOpen=${this._dataChannelOpen}, timeoutMs=${this._config.dtlsStallTimeoutMs})`);
        }
        this._startDtlsWatchdog();
        this._checkCompositeReadiness();
      } else if (iceState === 'disconnected') {
        // 'disconnected' is recoverable: the browser keeps probing the
        // active candidate pair and may return to 'connected' on its own.
        // For an established connection, give it iceDisconnectedGraceMs
        // before treating this as a transport failure. DTLS survives ICE
        // blips per spec — leave its watchdog (if any) running.
        //
        // Outside `connected` (e.g. during initial 'connecting'), we
        // keep the prior immediate-failure behaviour: there's no
        // established connection worth preserving and a 15s wait would
        // just delay legitimate retries.
        this._iceConnected = false;
        if (this._state === 'connected') {
          // Restart on each entry — flicker disconnected→connected→
          // disconnected gets a fresh window each time, matching the
          // streams-store fix's `Date.now()`-on-every-event semantics.
          this._startTimer(
            'ice-disconnected-grace',
            this._config.iceDisconnectedGraceMs,
            () => {
              if (this._destroyed) return;
              // Healed during the window — handler for 'connected'
              // already cleared the timer; this is just defensive.
              if (this._iceConnected) return;
              this._iceConnectedAt = null;
              this._cancelDtlsWatchdog();
              this._handleTransportFailure('ice-disconnected');
            },
          );
        } else {
          this._iceConnectedAt = null;
          this._cancelDtlsWatchdog();
          this._handleTransportFailure('ice-disconnected');
        }
      } else if (iceState === 'failed') {
        // 'failed' is terminal at the ICE layer — bypass any grace.
        this._iceConnected = false;
        this._iceConnectedAt = null;
        this._clearTimer('ice-disconnected-grace');
        this._cancelDtlsWatchdog();
        this._handleTransportFailure('ice-failed');
      } else if (iceState === 'closed') {
        // The RTCPeerConnection itself is closed. Previously this was lumped
        // in with 'new'/'checking' as benign, so the FSM stayed in
        // `connected` over a dead pc and never emitted a phase change —
        // leaving every consumer permanently wrong about the link
        // (MAINTAINABILITY_ASSESSMENT.md §3.12).
        //
        // Our own teardown also lands here, and that must stay a no-op:
        // `_onEnterState('closed')` sets `_state` before calling
        // `_destroyPeer()`, and `_handleTransportFailure` only acts from
        // `connected`/`connecting`, so a self-inflicted close falls through
        // harmlessly. Only an externally-closed pc reaches the transition.
        this._iceConnected = false;
        this._iceConnectedAt = null;
        this._clearTimer('ice-disconnected-grace');
        this._cancelDtlsWatchdog();
        this._handleTransportFailure('ice-closed');
      } else {
        // 'new' / 'checking' — maintain the invariant by clearing any
        // pending grace timer.
        this._clearTimer('ice-disconnected-grace');
      }
    });



    // Connection state changes (aggregate ICE + DTLS)
    peer.on('connect', () => {
      if (this._destroyed) return;
      this._iceConnected = true;
      this._dtlsConnected = true;
      if (this._dtlsConnectedAt === null) this._dtlsConnectedAt = Date.now();
      this._cancelDtlsWatchdog();
      this._checkCompositeReadiness();
      // ICE+DTLS are up. If the data channel hasn't opened yet, watch it: a
      // stalled channel is recovered in place rather than blocking the call
      // (and ultimately costing a full reconnect of the transport).
      if (!this._dataChannelOpen) this._startDataChannelWatchdog();
    });

    peer.on('close', (event) => {
      if (this._destroyed) return;
      const reason = event.data as string;
      if (reason === 'failed') {
        // connectionState 'failed' aggregates the ICE and DTLS transports —
        // per W3C it signals that *some* transport failed, not which one. Read
        // the authoritative transport states to attribute it, rather than
        // guessing: if ICE itself is 'failed' it's an ICE failure (recoverable
        // via ICE restart) even when DTLS also reports failed; only when ICE is
        // NOT failed and the DTLS transport is positively 'failed' do we treat
        // it as a DTLS failure (which needs a full reconnect). iceConnectionState
        // is always populated; the dtls reading falls back to a value derived
        // from connectionState when the DTLS transport isn't directly
        // observable — consistent with this by-elimination logic.
        //
        // When the ICE layer reports 'failed' first, its own handler has
        // already moved us to 'reconnecting', so the call below is a no-op
        // (_handleTransportFailure only acts from connected/connecting).
        if (this._state === 'connected' || this._state === 'connecting') {
          const snap = this._peer?.transportSnapshot;
          const dtlsFailed = snap?.ice !== 'failed' && snap?.dtls === 'failed';
          this._handleTransportFailure(dtlsFailed ? 'dtls-failed' : 'ice-failed');
        }
      }
    });

    // Data channel state
    peer.on('data-channel-state-change', (event) => {
      if (this._destroyed) return;
      const dcState = event.data as string;
      this._dataChannelOpen = dcState === 'open';
      if (this._dataChannelOpen) {
        if (this._dataChannelOpenAt === null) this._dataChannelOpenAt = Date.now();
        this._cancelDataChannelWatchdog();
        this._dataChannelRecreateAttempts = 0;
        this._checkCompositeReadiness();
        this._emitEvent({
          type: 'data-channel-open',
          connectionId: this.connectionId,
          remoteAgent: this.remoteAgent,
        });
      }
    });

    // Signaling state — move from signaling to connecting
    peer.on('signaling-state-change', (event) => {
      if (this._destroyed) return;
      const sigState = event.data as string;
      // When we return to stable after offer/answer exchange, we're connecting
      if (sigState === 'stable' && this._state === 'signaling') {
        this._transition('connecting', { trigger: 'SDP exchange complete (signaling stable)' });
      }
    });

    // Remote tracks
    peer.on('track', (event) => {
      if (this._destroyed) return;
      const { track } = event.data;
      if (track.kind === 'audio') this._audioReceiving = true;
      if (track.kind === 'video') {
        this._videoReceiving = true;
        this._videoMuted = track.muted;
        const onMute = () => {
          if (this._destroyed) return;
          this._videoMuted = true;
          this._notifyViewModelChange();
        };
        const onUnmute = () => {
          if (this._destroyed) return;
          this._videoMuted = false;
          this._notifyViewModelChange();
        };
        track.addEventListener('mute', onMute);
        track.addEventListener('unmute', onUnmute);
        this._trackCleanups.push(() => {
          track.removeEventListener('mute', onMute);
          track.removeEventListener('unmute', onUnmute);
        });
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
   * Media readiness — the connection is "connected" once ICE + DTLS are up.
   *
   * Media (RTP) flows the instant ICE+DTLS are established, independent of the
   * data channel, and track availability downstream is driven by `track` events,
   * not by the data channel. So the data channel is NOT a gate on `connected`:
   * gating the whole call on it let a stuck channel read as "not connected" and
   * invite a teardown of an otherwise-good transport (§6.1). The channel is
   * instead surfaced as a separate signal — the `data-channel-open` event and
   * the `dataChannelReady` view-model flag — and a stuck channel is recovered in
   * the background by the data-channel watchdog.
   */
  private _checkCompositeReadiness(): void {
    if (!this._iceConnected || !this._dtlsConnected) {
      return;
    }

    if (this._state === 'connecting') {
      this._dtlsStallCount = 0;
      this._transition('connected', { trigger: 'media readiness achieved (ICE + DTLS)' });
      this._emitEstablishmentTimeline();
      this._detectRelayAfterConnect();
    } else if (this._state === 'reconnecting') {
      this._dtlsStallCount = 0;
      this._transition('connected', { trigger: 'reconnection succeeded (ICE + DTLS)' });
      this._emitEstablishmentTimeline();
      this._detectRelayAfterConnect();
    }
  }

  /** Begin (or restart) the establishment timer for a fresh connect attempt. */
  private _beginEstablishmentTimer(isReconnect: boolean): void {
    this._establishmentStartedAt = Date.now();
    this._establishmentIsReconnect = isReconnect;
    this._dtlsConnectedAt = null;
    this._dataChannelOpenAt = null;
  }

  /**
   * Emit the one-shot establishment-timeline record (§6.6) when a connection
   * first reaches `connected`. Folds the per-stage timing into a single
   * structured event so consumers don't have to reconstruct it from interleaved
   * transition logs.
   */
  private _emitEstablishmentTimeline(): void {
    const start = this._establishmentStartedAt;
    if (start === null) return;
    const rel = (t: number | null) => (t === null ? null : Math.max(0, t - start));
    const timeline: EstablishmentTimeline = {
      startedAt: start,
      iceMs: rel(this._iceConnectedAt),
      dtlsMs: rel(this._dtlsConnectedAt),
      connectedMs: Math.max(0, Date.now() - start),
      dataChannelMs: rel(this._dataChannelOpenAt),
      wasReconnect: this._establishmentIsReconnect,
      peerSessionId: this._session.local,
    };
    // One record per attempt — clear the start so a later readiness re-check
    // (or a flag flip when the DC finally opens) can't re-emit it.
    this._establishmentStartedAt = null;
    this._emitEvent({
      type: 'establishment-timeline',
      connectionId: this.connectionId,
      remoteAgent: this.remoteAgent,
      data: timeline,
    });
  }

  private _resetReadinessFlags(): void {
    this._iceConnected = false;
    this._dtlsConnected = false;
    this._dataChannelOpen = false;
    this._iceConnectedAt = null;
    this._cancelDtlsWatchdog();
    this._cancelDataChannelWatchdog();
    this._dataChannelRecreateAttempts = 0;
  }

  // ---------------------------------------------------------------------------
  // DTLS Watchdog Diagnostic
  // ---------------------------------------------------------------------------

  /**
   * Start the DTLS watchdog: if ICE is connected but DTLS hasn't completed
   * within dtlsStallTimeoutMs, log a diagnostic and transition to disconnected
   * to trigger a retry with a fresh peer session. Detects the pattern where
   * srflx STUN checks pass but the path can't sustain DTLS handshake traffic
   * (common on Starlink and other aggressive-NAT environments).
   */
  private _startDtlsWatchdog(): void {
    // Only watch during connecting/reconnecting phases
    if (this._state !== 'connecting' && this._state !== 'reconnecting') {
      this._logDiag(`watchdog skipped (state=${this._state}, expected connecting|reconnecting)`);
      return;
    }
    // Already connected — no need to watch
    if (this._dtlsConnected && this._dataChannelOpen) {
      this._logDiag(`watchdog skipped (already connected: dtls=${this._dtlsConnected}, dc=${this._dataChannelOpen})`);
      return;
    }
    // Cancel any existing watchdog
    this._cancelDtlsWatchdog();

    this._logDiag(`watchdog armed (${this._config.dtlsStallTimeoutMs}ms, ice=${this._iceConnected}, dtls=${this._dtlsConnected}, dc=${this._dataChannelOpen})`);

    this._dtlsWatchdogId = setTimeout(() => {
      this._dtlsWatchdogId = null;
      if (this._destroyed) return;
      // Only fire if ICE is still connected but DTLS hasn't completed
      if (!this._iceConnected || this._dtlsConnected) {
        this._logDiag(`watchdog fired but conditions not met (ice=${this._iceConnected}, dtls=${this._dtlsConnected}, state=${this._state})`);
        return;
      }

      const stallMs = this._iceConnectedAt ? Date.now() - this._iceConnectedAt : 0;
      const snapshot = this.transportSnapshot;
      this._dtlsStallCount++;

      // Act FIRST — transition to disconnected before any async work.
      // The getStats() call below can hang on a stalled peer connection,
      // which would block the retry if we awaited it before transitioning.
      // Capture DTLS / data-channel state so log analysis can tell a
      // handshake that never started from one that hung mid-negotiation.
      const dtlsDetail = `dtls=${snapshot.dtls} dc=${snapshot.dataChannel}`;
      if (this._state === 'connecting') {
        this._transition('disconnected', { trigger: `DTLS stall after ${stallMs}ms (stall #${this._dtlsStallCount}, ${dtlsDetail})` });
      } else if (this._state === 'reconnecting') {
        this._transition('disconnected', { trigger: `DTLS stall during reconnect after ${stallMs}ms (stall #${this._dtlsStallCount}, ${dtlsDetail})` });
      }
    }, this._config.dtlsStallTimeoutMs);
  }

  private _cancelDtlsWatchdog(): void {
    if (this._dtlsWatchdogId !== null) {
      clearTimeout(this._dtlsWatchdogId);
      this._dtlsWatchdogId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Data-channel Watchdog
  // ---------------------------------------------------------------------------

  /**
   * Start the data-channel watchdog: when ICE+DTLS are connected but the data
   * channel hasn't opened within dataChannelStallTimeoutMs, recreate the
   * channel in place on the existing RTCPeerConnection (no ICE/DTLS teardown,
   * no new peer session). Re-arms after each attempt; once
   * maxDataChannelRecreateAttempts is exhausted, escalates to a full reconnect.
   *
   * This is what keeps a stuck data channel — observed in production when DCEP
   * open packets are lost on a lossy relay path — from forcing the whole
   * connection to be torn down and re-established from scratch.
   */
  private _startDataChannelWatchdog(): void {
    if (this._state !== 'connecting' && this._state !== 'connected') return;
    if (this._dataChannelOpen) return;
    this._cancelDataChannelWatchdog();

    this._logDiag(
      `data-channel watchdog armed (${this._config.dataChannelStallTimeoutMs}ms, ` +
      `attempts=${this._dataChannelRecreateAttempts}/${this._config.maxDataChannelRecreateAttempts})`
    );

    this._dataChannelWatchdogId = setTimeout(() => {
      this._dataChannelWatchdogId = null;
      if (this._destroyed) return;
      // Only act while the transport is up but the channel still isn't open.
      if (this._dataChannelOpen || !this._iceConnected || !this._dtlsConnected) return;

      if (this._dataChannelRecreateAttempts < this._config.maxDataChannelRecreateAttempts) {
        this._dataChannelRecreateAttempts++;
        this._logTransition(
          `data-channel stall — recreating channel in place ` +
          `(attempt ${this._dataChannelRecreateAttempts}/${this._config.maxDataChannelRecreateAttempts}, ` +
          `preserving ICE+DTLS)`
        );
        try {
          this._peer?.recreateDataChannel();
        } catch (_e) {
          // Recreation failed synchronously — fall through to re-arm; the next
          // expiry will escalate if attempts are exhausted.
        }
        this._startDataChannelWatchdog(); // re-arm for the next attempt
      } else {
        this._handleTransportFailure('data-channel-stall');
      }
    }, this._config.dataChannelStallTimeoutMs);
  }

  private _cancelDataChannelWatchdog(): void {
    if (this._dataChannelWatchdogId !== null) {
      clearTimeout(this._dataChannelWatchdogId);
      this._dataChannelWatchdogId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Transport Failure Handling
  // ---------------------------------------------------------------------------

  private _handleTransportFailure(reason: ReconnectContext['retryReason']): void {
    // Embed the raw transport states in the trigger so consumers that log only
    // the trigger string (not the structured TransportSnapshot on the entry)
    // can still see what the browser reported at the moment of failure.
    const snap = this.transportSnapshot;
    const states = `ice=${snap.ice} dtls=${snap.dtls}`;
    if (this._state === 'connected') {
      this._reconnectReason = reason;
      this._reconnectStartedAt = Date.now();
      this._reconnectCount = 0;

      // A 'failed' connectionState does not auto-recover, but it is not a dead
      // end: ICE failures recover via ICE restart and DTLS failures via a full
      // reconnect (fresh peer + new DTLS handshake). The reconnect policy picks
      // the strategy per reason — it forces full-reconnect for 'dtls-failed' —
      // and the bounded retry count is what eventually lands us in 'failed' if
      // recovery never succeeds. So route every transport failure through
      // 'reconnecting' rather than treating DTLS as terminal here.
      this._transition('reconnecting', { trigger: `transport failure: ${reason} (${states})` });
    } else if (this._state === 'connecting') {
      // Connection never completed — go to disconnected
      this._transition('disconnected', { trigger: `connection failed during setup: ${reason} (${states})` });
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
    // Clear any existing timer with the same name to prevent duplicates
    this._clearTimer(name);
    const id = setTimeout(() => {
      this._timers = this._timers.filter(t => t.name !== name);
      callback();
    }, delayMs);
    this._timers.push({ id, name });
  }

  private _clearTimer(name: string): void {
    this._timers = this._timers.filter(t => {
      if (t.name === name) {
        clearTimeout(t.id);
        return false;
      }
      return true;
    });
  }

  private _clearAllTimers(): void {
    for (const timer of this._timers) {
      clearTimeout(timer.id);
    }
    this._timers = [];
    this._cancelDtlsWatchdog();
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
      dataChannelReady: this._state === 'connected' && this._dataChannelOpen,
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
        // ICE+DTLS up promotes straight to `connected` now (§6.1), so the data
        // channel is never the thing we're waiting on in `connecting` — only
        // ICE and DTLS are.
        if (this._iceConnected && !this._dtlsConnected) return 'Securing connection...';
        return 'Establishing connection...';
      }
      case 'connected':
        // The call is live on ICE+DTLS regardless of the data channel; never
        // report "opening data channel" over flowing media. The data-channel
        // state is surfaced separately via the `dataChannelReady` flag.
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
        this._logger.error('View model listener error:', e);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Transition logging
  // ---------------------------------------------------------------------------

  /**
   * Emit a same-state log entry on the `onTransition` stream
   * (fromState === toState === current phase). Used for sub-phase events that
   * aren't real state changes — new peer session, ICE state, dropped signals.
   */
  private _logTransition(trigger: string): void {
    this._onTransition?.({
      timestamp: Date.now(),
      connectionId: this.connectionId,
      remoteAgent: this.remoteAgent,
      fromState: this._state,
      toState: this._state,
      trigger,
      peerSessionId: this._session.local,
    });
  }

  /**
   * Verbose library-internal instrumentation, gated behind `config.diagnostics`
   * (default off). For debugging the library itself; most consumers filter
   * `DIAG:` entries out, so building them by default is wasted work.
   */
  private _logDiag(trigger: string): void {
    if (!this._config.diagnostics) return;
    this._logTransition(`DIAG: ${trigger}`);
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
          this._logger.error('FSM event handler error:', e);
        }
      }
    }
  }
}
