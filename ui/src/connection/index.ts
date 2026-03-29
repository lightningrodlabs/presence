/**
 * WebRTC Connection State Machine Module
 *
 * Replaces SimplePeer with a proper finite state machine for WebRTC connections.
 * Uses the W3C Perfect Negotiation pattern and two-tier reconnection strategy.
 *
 * See docs/webrtc-state-machine-plan.md
 * See docs/webrtc-state-machine-research.md
 */

export { RTCPeer } from './rtc-peer';
export type { RTCPeerOptions } from './rtc-peer';

export { PeerConnectionFSM } from './peer-connection-fsm';
export type { PeerConnectionFSMOptions } from './peer-connection-fsm';

export { ConnectionManager } from './connection-manager';
export type { ConnectionManagerOptions } from './connection-manager';

export { HolochainSignalingAdapter } from './holochain-signaling-adapter';

export { DefaultReconnectPolicy } from './reconnect-policy';

export type {
  ConnectionPhase,
  ConnectionRole,
  ConnectionConfig,
  ConnectionViewModel,
  ConnectionManagerViewModel,
  ConnectionManagerSummary,
  TransportSnapshot,
  FSMTransitionEntry,
  SignalingAdapter,
  SignalMessage,
  ReconnectPolicy,
  ReconnectContext,
  Unsubscribe,
} from './types';

export { VALID_TRANSITIONS, DEFAULT_CONFIG, createIdleViewModel } from './types';
