/**
 * Core tier — the Perfect-Negotiation `RTCPeer` wrapper and the types its API
 * uses, with none of the lifecycle FSM, multi-peer manager, reconnection
 * engine, or forensic recorder.
 *
 * Import this (`@lightningrodlabs/webrtc-peer/core`) when you only want a thin,
 * managed `RTCPeerConnection` and will supply your own state/retry logic — it
 * is the smallest dependency surface the package offers. Importing the package
 * root and using only `RTCPeer` tree-shakes to the same code; this entry just
 * makes the intent explicit and guarantees it.
 */

export { RTCPeer } from './rtc-peer.js';
export type { RTCPeerOptions } from './rtc-peer.js';

export type {
  ConnectionConfig,
  TransportSnapshot,
  IceTransportState,
  IceGatheringState,
  DtlsTransportState,
  SignalingState,
  DataChannelState,
  RTCPeerEvent,
  RTCPeerEventType,
  RTCPeerEventHandler,
  Logger,
  Unsubscribe,
} from './types.js';

export { DEFAULT_CONFIG, DEFAULT_ICE_SERVERS, NOOP_LOGGER } from './types.js';
