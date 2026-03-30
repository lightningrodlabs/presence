/**
 * WebRTC Connection State Machine Types
 *
 * Two-layer state model:
 * - Layer 1 (ConnectionPhase): Application-level states for UI and ConnectionManager
 * - Layer 2 (TransportState): Mirrors browser's native WebRTC state machines
 *
 * See docs/webrtc-state-machine-plan.md and docs/webrtc-state-machine-research.md
 */

// Re-export AgentPubKeyB64 for convenience within the connection module
export type { AgentPubKeyB64 } from '@holochain/client';

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
  connecting:    new Set(['connected', 'disconnected', 'closed']),
  connected:     new Set(['reconnecting', 'disconnected', 'failed', 'closed']),
  reconnecting:  new Set(['connected', 'disconnected', 'failed', 'closed']),
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

export type ConnectionRole =
  | 'mesh'            // Standard P2P bidirectional (default)
  | 'sfu-upstream'    // Send-only to SFU volunteer
  | 'sfu-downstream'  // Receive-only from SFU volunteer
  | 'sfu-relay';      // We ARE the SFU volunteer

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
  | 'error'
  | 'closed';

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
  | 'data-channel-message';

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
  data?: any;
};

export interface SignalingAdapter {
  sendSignal(to: string, message: SignalMessage): void;
  onSignal(handler: (from: string, message: SignalMessage) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Connection Configuration
// ---------------------------------------------------------------------------

export type ConnectionConfig = {
  iceServers: RTCIceServer[];
  trickleICE: boolean;
  connectionTimeoutMs: number;
  sdpExchangeTimeoutMs: number;
  role: ConnectionRole;
};

export const DEFAULT_CONFIG: ConnectionConfig = {
  iceServers: [
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  trickleICE: true,
  connectionTimeoutMs: 15_000,
  sdpExchangeTimeoutMs: 15_000,
  role: 'mesh',
};

// ---------------------------------------------------------------------------
// Reconnect Policy
// ---------------------------------------------------------------------------

export type ReconnectContext = {
  retryCount: number;
  elapsedMs: number;
  retryReason: 'ice-failed' | 'ice-disconnected' | 'dtls-failed' | 'timeout' | 'error';
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
  transportSnapshot?: TransportSnapshot;
  metadata?: Record<string, any>;
};
