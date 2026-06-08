/**
 * @lightningrodlabs/webrtc-peer
 *
 * A managed WebRTC peer connection for the browser: W3C Perfect Negotiation,
 * a connection-lifecycle state machine, and a pluggable reconnection engine,
 * behind a small, signaling-agnostic API.
 *
 * `ConnectionManager` is the recommended entrypoint. `PeerConnectionFSM`
 * (single peer) and `RTCPeer` (thin Perfect-Negotiation wrapper) are exposed
 * for lower-level use.
 */

export { RTCPeer } from './rtc-peer.js';
export type { RTCPeerOptions } from './rtc-peer.js';

export { PeerConnectionFSM } from './peer-connection-fsm.js';
export type { PeerConnectionFSMOptions, PeerCreatedContext } from './peer-connection-fsm.js';

export { ConnectionManager } from './connection-manager.js';
export type { ConnectionManagerOptions } from './connection-manager.js';

export { DefaultReconnectPolicy, DEFAULT_RECONNECT_OPTIONS } from './reconnect-policy.js';
export type { DefaultReconnectPolicyOptions } from './reconnect-policy.js';

export { TransitionRecorder } from './transition-recorder.js';
export type { TransitionRecorderOptions } from './transition-recorder.js';

export type {
  // Identity
  PeerId,
  // Lifecycle
  ConnectionPhase,
  ConnectionRole,
  ConnectionConfig,
  // Transport-level state
  TransportSnapshot,
  IceTransportState,
  IceGatheringState,
  DtlsTransportState,
  SignalingState,
  DataChannelState,
  // View models
  ConnectionViewModel,
  ConnectionManagerViewModel,
  ConnectionManagerSummary,
  // Signaling
  SignalingAdapter,
  SignalSender,
  SignalMessage,
  // Reconnection
  ReconnectPolicy,
  ReconnectContext,
  // Events
  FSMEvent,
  FSMEventType,
  FSMEventHandler,
  EstablishmentTimeline,
  ManagerEvent,
  ManagerEventType,
  ManagerEventHandler,
  RTCPeerEvent,
  RTCPeerEventType,
  RTCPeerEventHandler,
  // Forensics
  FSMTransitionEntry,
  Logger,
  // Misc
  Unsubscribe,
} from './types.js';

export {
  VALID_TRANSITIONS,
  DEFAULT_CONFIG,
  DEFAULT_ICE_SERVERS,
  NOOP_LOGGER,
  createIdleViewModel,
} from './types.js';
