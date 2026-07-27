/**
 * PeerTransport — abstraction for a per-peer WebRTC transport implementation.
 *
 * Two known implementations land against this interface:
 *   - SimplePeerTransport: wraps the legacy `simple-peer` package.
 *   - FsmTransport: wraps the hand-rolled state machine from feat/webrtc-state-machine.
 *
 * Goals: let streams-store consume one shape regardless of which implementation
 * is in use, so we can A/B them per peer (Phase 2/3) and slot in a third
 * carrier (QUIC/WebTransport) later (Phase 7).
 *
 * Scope of a transport:
 *   - per-peer connection lifecycle (idle → signaling → connected → ...)
 *   - outgoing signal generation (delivered via `onOutgoingSignal` callback)
 *   - incoming signal routing to the right per-peer connection
 *   - track / stream attachment to outgoing connections
 *   - data channel send/receive
 *   - WebRTC stats collection
 *
 * NOT in scope (stays in streams-store):
 *   - InitRequest/InitAccept handshake (decides WHEN to ensureConnection)
 *   - the signaling channel itself (Holochain remote-signal sending)
 *   - peer presence / pong scheduling
 *   - audio mixing, voice activity detection, mute UI
 *   - module activation state, conversation routing
 *   - signals carrier (separate carrier kind, not a PeerTransport)
 */

import type { AgentPubKeyB64 } from '@holochain/client';
import type { EstablishmentTimeline } from '@lightningrodlabs/webrtc-peer';

/** Stable identity for a single connection attempt to a peer. */
export type ConnectionId = string;

/**
 * Application-level connection phase. Mirrors feat/webrtc-state-machine's
 * ConnectionPhase. SimplePeerTransport will collapse some of these (e.g.
 * 'reconnecting' is not a state SimplePeer exposes — the wrapper either
 * stays 'connected' or transitions to 'closed'/'failed' and lets the app
 * decide to ensureConnection again).
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
 * Outgoing signal — produced by the transport, shipped to the remote peer
 * by the application (e.g. via `roomClient.sendMessage(..., 'SdpData', ...)`).
 *
 * `data` is opaque — for SimplePeer it's whatever SimplePeer emits on its
 * 'signal' event; for the FSM it's `{ type: 'offer'|'answer'|'candidate', sdp/candidate: ... }`.
 * The transport only requires that whatever it produces, it can also consume
 * via `processIncomingSignal`.
 */
export type OutgoingSignal = {
  to: AgentPubKeyB64;
  connectionId: ConnectionId;
  data: unknown;
  /** Monotonic per-session counter for stale-signal filtering. FSM-only. */
  peerSessionId?: number;
  /** Orchestrator-allocated connection generation; ordered across teardown+
   *  recreate (unlike `peerSessionId`). FSM-only. See OutgoingSignal consumers
   *  and docs/WEBRTC_RECONNECT_IDENTITY.md. */
  epoch?: number;
};

/** Incoming signal — application received from remote, hands to transport. */
export type IncomingSignal = {
  from: AgentPubKeyB64;
  connectionId: ConnectionId;
  data: unknown;
  peerSessionId?: number;
  /** Orchestrator-allocated connection generation (see OutgoingSignal.epoch). */
  epoch?: number;
};

/** Events emitted by the transport. All carry peer + connectionId for supersede-guards. */
export type TransportEvent =
  | {
      type: 'connection-state-change';
      peer: AgentPubKeyB64;
      connectionId: ConnectionId;
      phase: ConnectionPhase;
      previous: ConnectionPhase;
    }
  | {
      type: 'remote-stream';
      peer: AgentPubKeyB64;
      connectionId: ConnectionId;
      stream: MediaStream;
    }
  | {
      type: 'remote-track';
      peer: AgentPubKeyB64;
      connectionId: ConnectionId;
      track: MediaStreamTrack;
      stream: MediaStream;
    }
  | {
      type: 'data-channel-message';
      peer: AgentPubKeyB64;
      connectionId: ConnectionId;
      data: unknown;
    }
  | {
      // One-shot per-connection establishment timeline (per-stage ms) from the
      // FSM. FSM transport only; SimplePeer never emits this.
      type: 'establishment-timeline';
      peer: AgentPubKeyB64;
      connectionId: ConnectionId;
      timeline: EstablishmentTimeline;
    }
  | {
      type: 'error';
      peer: AgentPubKeyB64;
      connectionId: ConnectionId;
      error: Error;
    };

export type TransportEventType = TransportEvent['type'];
export type TransportEventHandler<T extends TransportEvent = TransportEvent> = (event: T) => void;
export type Unsubscribe = () => void;

/** Stats for one peer connection. Both impls provide raw RTCStatsReport;
 *  the wrapper may pre-derive common fields. */
export type TransportStats = {
  raw: RTCStatsReport;
  derived?: {
    rttMs?: number;
    jitterMs?: number;
    packetLossPct?: number;
    relayed?: boolean;
    candidateType?: 'host' | 'srflx' | 'relay' | 'unknown';
  };
};

export interface PeerTransport {
  /**
   * Ensure a connection to `peer` exists. Idempotent.
   *
   *  - If no connection: create one, transition idle → signaling, return new connectionId.
   *  - If existing in idle/disconnected/failed: restart, return new (or same) connectionId.
   *  - If existing in signaling/connecting/connected/reconnecting: no-op, return current connectionId.
   *
   * `opts.connectionId` lets the application supply a connectionId from the
   * InitRequest/InitAccept handshake (matches voice-over-signals' existing
   * model). If omitted, the transport allocates one.
   */
  ensureConnection(
    peer: AgentPubKeyB64,
    opts?: {
      initiator?: boolean;
      connectionId?: ConnectionId;
      /**
       * Optional RTT-scaled SDP-exchange timeout (ms). Honoured by the FSM
       * transport for initiator connections; ignored by transports that do
       * not model an SDP-exchange phase.
       */
      sdpExchangeTimeoutMs?: number;
      /**
       * Monotonic per-peer connection generation ("epoch"), allocated by the
       * orchestrator so it survives FSM teardown+recreate. The FSM transport
       * stamps it on outgoing signals and uses it for cross-attempt
       * "newest-wins" ordering; transports that do not model it ignore it.
       * See docs/WEBRTC_RECONNECT_IDENTITY.md.
       */
      epoch?: number;
    }
  ): ConnectionId;

  /** Tear down the connection to `peer`. Emits a final 'connection-state-change' to 'closed'. */
  closeConnection(peer: AgentPubKeyB64, reason?: string): void;

  /** Whether we currently track any state for this peer. */
  hasConnection(peer: AgentPubKeyB64): boolean;

  /**
   * Whether this transport recovers its own connections — ICE restart,
   * full reconnect, a disconnected-grace window — without the application
   * doing anything.
   *
   * A consumer running its own teardown-and-reinitiate supervisor against
   * `pc.iceConnectionState` MUST stand down when this is true, or the two
   * controllers race and produce the "media flows briefly then suddenly
   * reconnects" churn (MAINTAINABILITY_ASSESSMENT.md §3.4). The
   * give-up decision still belongs to the application; the transport
   * signals it by reaching `failed`.
   *
   * Declared on the transport rather than derived by the consumer from the
   * transport's identity, so that swapping which transport carries a given
   * stream purpose cannot silently invert the answer. Read by
   * `streams-store.ts` at all three `decideStaleConnectionCleanup` sites.
   */
  readonly ownsTransportRecovery: boolean;

  /** Current phase, or 'idle' if no connection. */
  getPhase(peer: AgentPubKeyB64): ConnectionPhase;

  /** ConnectionId for this peer's current attempt, or undefined. */
  getConnectionId(peer: AgentPubKeyB64): ConnectionId | undefined;

  /**
   * Set the canonical local stream. The transport remembers it and
   * auto-attaches it to any new connection created after this call.
   *
   * Does NOT retroactively reconcile tracks on existing connections —
   * use addTrack/removeTrack/replaceTrack for that. Pass null to clear.
   *
   * Per-stream-purpose isolation (e.g. media vs screen-share) is handled by
   * using separate PeerTransport instances, not by per-peer targeting.
   */
  setLocalStream(stream: MediaStream | null): void;

  /** Add a track to all active connections. Triggers SDP renegotiation. */
  addTrack(track: MediaStreamTrack, stream: MediaStream): void;

  /** Remove a track from all active connections. Triggers SDP renegotiation. */
  removeTrack(track: MediaStreamTrack, stream: MediaStream): void;

  /** Replace a track on all active connections. No renegotiation —
   *  uses RTCRtpSender.replaceTrack(). For device switches. `stream` is
   *  the MediaStream the tracks belong to (SimplePeer requires it; FSM
   *  tolerates it but does not strictly need it). */
  replaceTrack(
    oldTrack: MediaStreamTrack | null,
    newTrack: MediaStreamTrack | null,
    stream: MediaStream
  ): void;

  /** Send a data-channel message to a peer. No-op (with logged warning) if no open data channel. */
  send(peer: AgentPubKeyB64, data: string | ArrayBuffer | Uint8Array): void;

  /** Get WebRTC stats. Returns null if connection is not in a state that has stats. */
  getStats(peer: AgentPubKeyB64): Promise<TransportStats | null>;

  /** Process an incoming signal received via the application's signaling channel. */
  processIncomingSignal(signal: IncomingSignal): void;

  /** Subscribe to one event type. */
  on<T extends TransportEventType>(
    type: T,
    handler: TransportEventHandler<Extract<TransportEvent, { type: T }>>
  ): Unsubscribe;

  /** Subscribe to all events. */
  onAny(handler: TransportEventHandler): Unsubscribe;

  /** Tear down everything: close all connections, drop handlers. */
  destroy(): void;
}

/** Construction options shared across implementations. */
export type PeerTransportOptions = {
  myAgentId: AgentPubKeyB64;
  /** The transport calls this when it produces an outgoing signal that needs
   *  to be shipped to the remote peer. Application is responsible for delivery
   *  (Holochain remote-signal, WebSocket, etc.). */
  onOutgoingSignal: (signal: OutgoingSignal) => void;
  /** ICE servers. Pass an array for static config, or a function for dynamic
   *  (e.g. TURN credentials that change at runtime). Evaluated at each
   *  ensureConnection. */
  iceServers?: RTCIceServer[] | (() => RTCIceServer[]);
  /** Whether to use trickle ICE. Pass a function to read at each ensureConnection. */
  trickleICE?: boolean | (() => boolean);
  /** Forced ICE transport policy — 'relay' restricts candidates to TURN relays
   *  (force-TURN), 'all' is normal ICE. Pass a function to read at each
   *  ensureConnection; undefined leaves the browser default. */
  iceTransportPolicy?:
    | RTCIceTransportPolicy
    | (() => RTCIceTransportPolicy | undefined);
  /** Implementation-specific knobs (e.g. FSM timeouts). Passed through opaquely. */
  config?: Record<string, unknown>;
};

/**
 * Minimal subset of SimplePeer's instance shape that the transport actually
 * uses. Exposed so tests (and alternate WebRTC stacks) can substitute their
 * own implementation via the `createPeer` option on SimplePeerTransport.
 */
export interface SimplePeerLike {
  signal(data: unknown): void;
  send(data: string | ArrayBuffer | Uint8Array): void;
  destroy(): void;
  addTrack(track: MediaStreamTrack, stream: MediaStream): void;
  removeTrack(track: MediaStreamTrack, stream: MediaStream): void;
  replaceTrack(
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    stream: MediaStream
  ): void;
  addStream(stream: MediaStream): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

/** Identifier for which transport implementation is in use for a peer.
 *  Matches the planned `webrtcImpl` field on the conversation module payload. */
export type TransportImpl = 'simplepeer' | 'fsm';

/**
 * Default ICE/STUN servers used by every transport implementation. Single
 * source of truth: streams-store passes this into both SimplePeerTransport and
 * FsmTransport at construction, and FSM's DEFAULT_CONFIG falls back to it
 * when no `iceServers` getter is wired in (tests).
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
    ],
  },
];
