/**
 * WebRTC Connection State Machine Types
 *
 * Two-layer state model:
 * - Layer 1 (ConnectionPhase): Application-level states for UI and ConnectionManager
 * - Layer 2 (TransportState): Mirrors browser's native WebRTC state machines
 *
 * See docs/webrtc-state-machine-plan.md and docs/webrtc-state-machine-research.md
 */

/**
 * Opaque, stable identity for a peer. The library never inspects it beyond
 * comparing two ids to assign polite/impolite roles for Perfect Negotiation.
 */
export type PeerId = string;

/**
 * Default public STUN servers used by `DEFAULT_CONFIG`. STUN only — provide
 * your own TURN servers via `ConnectionConfig.iceServers` for NAT traversal
 * where direct/srflx paths fail.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
    ],
  },
];

// ---------------------------------------------------------------------------
// Layer 1 — Application Connection State
// ---------------------------------------------------------------------------

/**
 * The application-level phases a peer connection can be in.
 * UI components subscribe to this, not to raw WebRTC states.
 */
export type ConnectionPhase =
  | 'idle'
  | 'signaling'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'
  | 'closed';

/**
 * Valid state transitions. Used by the FSM to guard transitions.
 * Key = from state, value = set of legal target states.
 */
export const VALID_TRANSITIONS: Record<ConnectionPhase, Set<ConnectionPhase>> = {
  idle:          new Set(['signaling', 'closed']),
  signaling:     new Set(['connecting', 'disconnected', 'closed']),
  connecting:    new Set(['connected', 'signaling', 'disconnected', 'closed']),
  connected:     new Set(['reconnecting', 'disconnected', 'failed', 'closed']),
  reconnecting:  new Set(['reconnecting', 'signaling', 'connected', 'disconnected', 'failed', 'closed']),
  disconnected:  new Set(['signaling', 'idle', 'closed']),
  failed:        new Set(['idle', 'closed']),
  closed:        new Set([]),  // terminal — no transitions out
};

// ---------------------------------------------------------------------------
// Layer 2 — Transport State (mirrors browser)
// ---------------------------------------------------------------------------

export type IceTransportState =
  | 'new' | 'checking' | 'connected' | 'completed'
  | 'disconnected' | 'failed' | 'closed';

export type IceGatheringState = 'new' | 'gathering' | 'complete';

export type DtlsTransportState = 'new' | 'connecting' | 'connected' | 'failed' | 'closed';

export type SignalingState =
  | 'stable' | 'have-local-offer' | 'have-remote-offer'
  | 'have-local-pranswer' | 'have-remote-pranswer' | 'closed';

export type DataChannelState = 'connecting' | 'open' | 'closing' | 'closed';

/**
 * Snapshot of all transport-level states at a given moment.
 * Logged on every FSM transition for debugging.
 */
export type TransportSnapshot = {
  ice: IceTransportState;
  dtls: DtlsTransportState;
  signaling: SignalingState;
  gathering: IceGatheringState;
  dataChannel: DataChannelState | null;
};

// ---------------------------------------------------------------------------
// Connection Roles (SFU scaffolding)
// ---------------------------------------------------------------------------

/**
 * Per-connection role.
 *
 * Only `'mesh'` is functional today. The `sfu-*` values are **reserved** for
 * upcoming SFU (selective-forwarding) support and carry **no behavior yet** —
 * setting them is equivalent to `'mesh'`. They are also **unstable**: the shape
 * may change before SFU ships (the relay direction is per-connection, so the
 * eventual model is likely per-connection media direction + a relay capability
 * rather than this flat enum). Do not depend on the `sfu-*` values. See
 * ROADMAP.md.
 */
export type ConnectionRole =
  | 'mesh'            // Standard P2P bidirectional (default; the only functional value)
  | 'sfu-upstream'    // RESERVED: send-only to SFU volunteer
  | 'sfu-downstream'  // RESERVED: receive-only from SFU volunteer
  | 'sfu-relay';      // RESERVED: we ARE the SFU volunteer

// ---------------------------------------------------------------------------
// Reactive UX View Model
// ---------------------------------------------------------------------------

export type ConnectionViewModel = {
  /** Current application-level phase */
  phase: ConnectionPhase;

  /**
   * Progress within the current phase (0.0 to 1.0).
   * Signaling: 0.0 = started, 0.5 = offer sent, 1.0 = answer applied
   * Connecting: 0.0 = ICE checking, 0.5 = ICE connected, 1.0 = DTLS + data channel ready
   * Reconnecting: progress through retry attempts (attemptNumber / maxAttempts)
   */
  progress: number;

  /** Human-readable status for accessibility and tooltips */
  statusText: string;

  /** How long we've been in this phase (ms) */
  phaseElapsedMs: number;

  /** Timestamp when current phase was entered */
  phaseEnteredAt: number;

  /** Retry context (only present in reconnecting/disconnected phases) */
  retry: {
    attemptNumber: number;
    maxAttempts: number;
    nextRetryMs: number | null;
    strategy: 'ice-restart' | 'full-reconnect';
  } | null;

  /** Connection quality (only present when connected) */
  quality: {
    relayed: boolean;
    candidateType: 'host' | 'srflx' | 'relay' | 'unknown';
    roundTripMs: number | null;
  } | null;

  /** Track state (only present when connected) */
  tracks: {
    audioSending: boolean;
    audioReceiving: boolean;
    videoSending: boolean;
    videoReceiving: boolean;
    videoMuted: boolean;
  } | null;

  /** Composite health signal: connected and tracks flowing */
  healthy: boolean;

  /**
   * Whether the data channel is currently open. Decoupled from `phase` since
   * §6.1: a connection is `connected` (media flowing) the instant ICE+DTLS are
   * up, which can precede — or briefly outlast, during in-place recovery — the
   * data channel. Consumers that send control messages over the channel (mute /
   * input-state sync) can watch this to know when the channel is live; while it
   * is `false`, sends are buffered by the transport and flushed on open rather
   * than dropped. `false` outside `connected`.
   */
  dataChannelReady: boolean;
};

export type ConnectionManagerSummary = {
  totalPeers: number;
  connectedPeers: number;
  connectingPeers: number;
  troubledPeers: number;
  allHealthy: boolean;
};

export type ConnectionManagerViewModel = {
  agents: Record<string, ConnectionViewModel>;
  summary: ConnectionManagerSummary;
};

/**
 * Creates a default ConnectionViewModel in idle state.
 */
export function createIdleViewModel(): ConnectionViewModel {
  return {
    phase: 'idle',
    progress: 0,
    statusText: 'Not connected',
    phaseElapsedMs: 0,
    phaseEnteredAt: Date.now(),
    retry: null,
    quality: null,
    tracks: null,
    healthy: false,
    dataChannelReady: false,
  };
}

// ---------------------------------------------------------------------------
// FSM Events
// ---------------------------------------------------------------------------

export type FSMEventType =
  | 'state-changed'
  | 'remote-stream'
  | 'remote-track'
  | 'data-channel-message'
  | 'data-channel-open'
  | 'establishment-timeline'
  | 'error';

/**
 * One structured establishment-timeline record, emitted once when a connection
 * first reaches `connected`. Collapses the per-stage timing that otherwise has
 * to be reconstructed by hand-reading interleaved transition logs (§6.6) into a
 * single event: how long each sub-transport took to come up, measured from the
 * start of this establishment attempt (entering `signaling`, or `reconnecting`
 * for a reconnect).
 *
 * All durations are milliseconds from establishment start, or `null` if that
 * stage hadn't been reached at emit time. Because §6.1 promotes to `connected`
 * on ICE+DTLS, the data channel typically opens *after* `connected`, so
 * `dataChannelMs` is usually `null` here — the data channel's own timing arrives
 * via the separate `data-channel-open` event. The selected candidate type /
 * relay status are not known synchronously (they require a stats pass ~2s after
 * connect) and are surfaced via the `quality` view-model fields instead.
 */
export type EstablishmentTimeline = {
  /** Establishment attempt start (ms epoch) — entering signaling/reconnecting. */
  startedAt: number;
  /** ms from start to ICE connected/completed. */
  iceMs: number | null;
  /** ms from start to DTLS connected (inferred from connectionState). */
  dtlsMs: number | null;
  /** ms from start to FSM `connected` (media-ready: ICE+DTLS). */
  connectedMs: number;
  /** ms from start to data channel open, or null if not yet open at emit. */
  dataChannelMs: number | null;
  /** Whether this attempt was a reconnect (vs. the initial connect). */
  wasReconnect: boolean;
  /** Local peer session counter at emit time. */
  peerSessionId: number;
};

export type FSMEvent = {
  type: FSMEventType;
  connectionId: string;
  remoteAgent: string;
  data?: any;
};

export type FSMEventHandler = (event: FSMEvent) => void;
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Connection Manager Events
// ---------------------------------------------------------------------------

export type ManagerEventType =
  | 'connection-created'
  | 'connection-state-changed'
  | 'connection-closed'
  | 'remote-stream'
  | 'remote-track'
  | 'data-channel-message'
  | 'establishment-timeline';

export type ManagerEvent = {
  type: ManagerEventType;
  remoteAgent: string;
  connectionId: string;
  data?: any;
};

export type ManagerEventHandler = (event: ManagerEvent) => void;

// ---------------------------------------------------------------------------
// Signaling Adapter (decouples from Holochain)
// ---------------------------------------------------------------------------

export type SignalMessage = {
  type: 'offer' | 'answer' | 'candidate' | 'leave';
  connectionId: string;
  /** Monotonic counter incremented each time a new RTCPeerConnection is created.
   *  Used to discard stale signals from previous peer sessions within the same FSM. */
  peerSessionId?: number;
  /**
   * Connection generation ("epoch") for this peer pair. Unlike `peerSessionId`
   * (which is per-FSM-instance and resets to 0 when the FSM is recreated), the
   * epoch is allocated by the orchestrator that outlives any single FSM, so it
   * is **monotonic across teardown + recreate**. When present on both the
   * incoming signal and the receiving FSM, it is the authoritative "which
   * attempt is current" order: a strictly-higher epoch supersedes the FSM, a
   * strictly-lower epoch is dropped, equal epochs fall back to
   * connectionId/peerSessionId handling. Optional and backward-compatible: when
   * absent, routing uses the legacy connectionId/peerSessionId logic unchanged.
   * See docs/WEBRTC_RECONNECT_IDENTITY.md.
   */
  epoch?: number;
  data?: any;
};

export interface SignalingAdapter {
  sendSignal(to: string, message: SignalMessage): void;
  onSignal(handler: (from: string, message: SignalMessage) => void): Unsubscribe;
}

/**
 * Send-only signaling callback. Pass this in place of a full `SignalingAdapter`
 * when your P2P transport hands you messages via its own callback (you call
 * `manager.deliverSignal(from, message)` when a signal arrives). This is the
 * natural shape for most P2P substrates (Holochain remote signals, PeerKit
 * messages, libp2p streams) — they don't expose a `register(handler)` model.
 */
export type SignalSender = (to: string, message: SignalMessage) => void;

// ---------------------------------------------------------------------------
// Connection Configuration
// ---------------------------------------------------------------------------

export type ConnectionConfig = {
  iceServers: RTCIceServer[];
  /**
   * Optional WebRTC ICE transport policy. Pass `'relay'` to force TURN-only
   * (host/srflx candidates are not gathered). Omit for normal ICE, where the
   * agent gathers all candidate types and falls back to relay automatically
   * when host/srflx paths fail. Mirrors `RTCConfiguration.iceTransportPolicy`.
   */
  iceTransportPolicy?: RTCIceTransportPolicy;
  /**
   * Optional `RTCConfiguration.iceCandidatePoolSize`. Pre-gathers this many ICE
   * candidates eagerly (before the first offer is created) so they're ready at
   * offer time, shaving gathering latency off establishment on slow signaling
   * paths. Only affects gathering eagerness — does not change which candidates
   * are used. Omit (or 0) for the browser default. See §6.7 of the connection plan.
   */
  iceCandidatePoolSize?: number;
  trickleICE: boolean;
  connectionTimeoutMs: number;
  sdpExchangeTimeoutMs: number;
  dtlsStallTimeoutMs: number;
  /**
   * How long ICE+DTLS may be connected with the data channel still not open
   * before the channel is recreated *in place* (a fresh `createDataChannel` on
   * the same RTCPeerConnection — no new ICE/DTLS, no renegotiation of the
   * already-negotiated SCTP m-section). Recovers a data channel whose DCEP open
   * was lost on a lossy path without throwing away the (expensive) transport.
   */
  dataChannelStallTimeoutMs: number;
  /**
   * Maximum in-place data-channel recreate attempts before escalating to a full
   * reconnect. Bounds the recovery loop so a genuinely dead SCTP association
   * doesn't retry forever.
   */
  maxDataChannelRecreateAttempts: number;
  /**
   * How long an established peer may sit in iceConnectionState 'disconnected'
   * before we treat it as a transport failure and enter `reconnecting`. WebRTC
   * keeps probing the active candidate pair while 'disconnected' and may
   * return to 'connected' if the path heals; tearing down on the first
   * 'disconnected' aborts that recovery and (because the resulting reconnect
   * supersedes the peer's still-recovering connection) often lands the new
   * attempt on the same broken path. 'failed' bypasses this grace.
   * Only applied while FSM phase is `connected`.
   */
  iceDisconnectedGraceMs: number;
  role: ConnectionRole;
};

export const DEFAULT_CONFIG: ConnectionConfig = {
  iceServers: DEFAULT_ICE_SERVERS,
  // Pre-gather one candidate set so srflx/relay candidates are ready at offer
  // time instead of being discovered mid-exchange — trims establishment latency
  // on slow signaling paths (§6.7). Modest by design; only affects eagerness.
  iceCandidatePoolSize: 1,
  trickleICE: true,
  connectionTimeoutMs: 7_000,
  sdpExchangeTimeoutMs: 15_000,
  dtlsStallTimeoutMs: 5_000,
  dataChannelStallTimeoutMs: 4_000,
  maxDataChannelRecreateAttempts: 3,
  iceDisconnectedGraceMs: 15_000,
  role: 'mesh',
};

// ---------------------------------------------------------------------------
// Reconnect Policy
// ---------------------------------------------------------------------------

export type ReconnectContext = {
  retryCount: number;
  elapsedMs: number;
  /** `ice-closed` means `pc.iceConnectionState` reached `closed` — the
   *  RTCPeerConnection itself is gone, so an ICE restart has nothing to
   *  restart. `ReconnectPolicy.strategy` forces a full reconnect for it. */
  retryReason: 'ice-failed' | 'ice-closed' | 'ice-disconnected' | 'dtls-failed' | 'dtls-stall' | 'data-channel-stall' | 'timeout' | 'error';
  lastStrategy: 'ice-restart' | 'full-reconnect';
};

export interface ReconnectPolicy {
  /**
   * Returns the delay in ms before the next retry, or null to stop retrying.
   */
  nextRetryDelayMs(context: ReconnectContext): number | null;

  /**
   * Returns which strategy to use for this retry attempt.
   */
  strategy(context: ReconnectContext): 'ice-restart' | 'full-reconnect';

  /** Maximum number of retry attempts */
  readonly maxAttempts: number;
}

// ---------------------------------------------------------------------------
// RTCPeer Events
// ---------------------------------------------------------------------------

export type RTCPeerEventType =
  | 'signal'             // SDP or ICE candidate to send to remote
  | 'connect'            // ICE + DTLS + data channel all ready
  | 'data'               // data channel message received
  | 'stream'             // remote media stream
  | 'track'              // remote media track
  | 'ice-state-change'   // ICE transport state changed
  | 'dtls-state-change'  // DTLS transport state changed
  | 'signaling-state-change'
  | 'gathering-state-change'
  | 'data-channel-state-change'
  | 'negotiation-needed'
  | 'close'
  | 'error';

export type RTCPeerEvent = {
  type: RTCPeerEventType;
  data?: any;
};

export type RTCPeerEventHandler = (event: RTCPeerEvent) => void;

// ---------------------------------------------------------------------------
// FSM Transition Logging
// ---------------------------------------------------------------------------

export type FSMTransitionEntry = {
  timestamp: number;
  connectionId: string;
  remoteAgent: string;
  fromState: ConnectionPhase;
  toState: ConnectionPhase;
  trigger: string;
  peerSessionId?: number;
  transportSnapshot?: TransportSnapshot;
  metadata?: Record<string, any>;
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Sink for non-fatal diagnostics the library would otherwise drop. The library
 * never writes to `console` on its own — pass a `logger` to surface warnings
 * and recovered errors. Defaults to a no-op. The structured forensic trail is
 * the `onTransition` callback (`FSMTransitionEntry`), not this.
 */
export interface Logger {
  debug(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/** A `Logger` that discards everything. Default when no logger is supplied. */
export const NOOP_LOGGER: Logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};
