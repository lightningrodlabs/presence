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

export { RTCPeer } from './rtc-peer';
export type { RTCPeerOptions } from './rtc-peer';

export { PeerConnectionFSM } from './peer-connection-fsm';
export type { PeerConnectionFSMOptions, PeerCreatedContext } from './peer-connection-fsm';

export { ConnectionManager } from './connection-manager';
export type { ConnectionManagerOptions } from './connection-manager';

export { DefaultReconnectPolicy, DEFAULT_RECONNECT_OPTIONS } from './reconnect-policy';
export type { DefaultReconnectPolicyOptions } from './reconnect-policy';

export { TransitionRecorder } from './transition-recorder';
export type { TransitionRecorderOptions } from './transition-recorder';

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
} from './types';

export {
  VALID_TRANSITIONS,
  DEFAULT_CONFIG,
  DEFAULT_ICE_SERVERS,
  NOOP_LOGGER,
  createIdleViewModel,
} from './types';
