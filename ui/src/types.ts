import {
  SignedActionHashed,
  AgentPubKey,
  Create,
  Update,
  Delete,
  CreateLink,
  DeleteLink,
  DnaHash,
  AgentPubKeyB64,
} from '@holochain/client';
import { WeaveClient } from '@theweave/api';
import { createContext } from '@lit/context';

export const weaveClientContext = createContext<WeaveClient>('we_client');


/**
 * Frontend
 */

export type ConnectionId = string;

export type RTCMessage =
  | {
      type: 'action';
      message: 'video-off' | 'video-on' | 'audio-off' | 'audio-on' | 'change-audio-input' | 'change-video-input' | 'request-track-refresh';
    }
  | {
      type: 'text';
      message: string;
    };

export type OpenConnectionInfo = {
  connectionId: ConnectionId;
  video: boolean;
  audio: boolean;
  connected: boolean;
  relayed?: boolean; // true if the ICE candidate pair uses a TURN relay
  videoMuted?: boolean; // true when a video track arrived but is still muted (waiting for unmute)
  direction: 'outgoing' | 'incoming' | 'duplex'; // In which direction streams are expected
};

export type PendingInit = {
  /**
   * UUID to identify the connection
   */
  connectionId: ConnectionId;
  /**
   * Timestamp when init was sent. If InitAccept is not received within a certain duration
   * after t0, a next InitRequest is sent.
   */
  t0: number;
};

export type StreamInfo = {
  active: boolean;
};

export type TrackInfo = {
  kind: 'audio' | 'video';
  enabled: boolean;
  muted: boolean;
  readyState: 'live' | 'ended';
};

export type StreamAndTrackInfo = {
  stream: StreamInfo | null;
  tracks: TrackInfo[];
};

export type PongMetaData<T> = {
  formatVersion: number;
  data: T;
};

export type SharedWalPayload = {
  /** WeaveUrl for use as wal-embed src (e.g. weave-0.15://...) */
  weaveUrl: string;
  /** Human-readable name of the asset (if available at share time) */
  assetName?: string;
  /** Icon src of the asset (if available at share time) */
  assetIconSrc?: string;
};

/**
 * User-facing per-peer audio link state. Distinct from `ConnectionStatus`
 * (which is the pure WebRTC negotiation FSM): this rolls up reachability,
 * WebRTC media liveness, signals-carrier flow, and peer intent into the
 * single answer "can I hear this peer right now, and over what?"
 *
 * Runs in parallel with `ConnectionStatus`; the latter remains the source
 * of truth for init/accept/SDP state.
 */
export type AudioLinkState =
  /**
   * From the observer's perspective, the agent is not currently in the
   * room — no recent pong, regardless of whether they ever joined or
   * intentionally left. Both cases collapse here because the user-facing
   * answer is the same: this observer doesn't see them.
   */
  | 'absent'
  | 'blocked'
  | 'negotiating' // webrtc handshaking, no signals fallback flowing yet
  | 'webrtc' // webrtc connected + recent media
  | 'signals' // voice frames arriving via signals carrier
  | 'muted' // peer reachable but intentionally silent
  | 'down' // reachable, not muted, no working audio path
  | 'unknown';

/**
 * Discrete freshness bucket for "last time I heard from this peer via
 * signals." Broadcast instead of an absolute timestamp so clock skew
 * between observers does not flip the color.
 *
 * This is the **signals-reachable** predicate — evidence about the
 * Holochain signal path only. Never compare it with, or substitute it
 * for, WebRTC `connected` (ICE + DTLS up): the two carriers fail
 * independently, and `decideAudioLink` (`peer-link-policy.ts`) is where
 * their precedence is decided — observed media flow beats this bucket.
 */
export type LastSeenBucket = 'fresh' | 'stale' | 'gone' | 'unknown';

/**
 * One observer's snapshot of a single other peer's audio/video link state.
 * Broadcast inside `PongMetaDataV1.peerLinks` so every peer can render
 * "how X sees Y" — the pair-wise information that makes the details
 * overlay genuinely relational rather than a repetition of the local
 * view on each tile.
 */
export type PeerLinkSnapshot = {
  audioLink: AudioLinkState;
  carrier: 'webrtc' | 'signals' | 'none';
  audio: 'live' | 'stale' | 'muted' | 'off';
  video: 'live' | 'muted' | 'off';
  lastSeen: LastSeenBucket;
};

export type PongMetaDataV1 = {
  connectionStatuses: ConnectionStatuses;
  screenShareConnectionStatuses?: ConnectionStatuses;
  knownAgents?: Record<AgentPubKeyB64, AgentInfo>;
  /**
   * Per-peer observation snapshot from this sender's perspective. Key is
   * the observed peer's pubkey. Enables pair-wise UI ("X can't hear Y")
   * without N² broadcasts — piggybacks on the existing pong.
   */
  peerLinks?: Record<AgentPubKeyB64, PeerLinkSnapshot>;
  appVersion?: string;
  /**
   * Echo of the t0 timestamp from the Ping that triggered this Pong.
   * Used by the sender to compute signals-carrier RTT on receipt:
   * `rtt = Date.now() - pingT0`. Clock skew is irrelevant since only
   * the sender compares two timestamps from its own clock.
   */
  pingT0?: number;
  /**
   * Info about how we see the stream of the peer to
   * which we're sending this PongMetaData
   */
  streamInfo?: StreamAndTrackInfo;
  /**
   * Info of whether we consider the audio of the peer
   * to be on or off
   */
  audio?: boolean;
  /**
   * Info of whether we consider the video of the peer
   * to be on or off
   */
  video?: boolean;
  /** Active module states for this agent, keyed by moduleId */
  moduleStates?: Record<string, ModuleStateEnvelope>;
};

/**
 * Per-peer latency/quality stats for a single carrier. Null = unknown
 * or not yet measured. Rendered in the stats panel under the connection
 * detail avatars.
 */
export type CarrierStats = {
  rttMs: number | null;
  jitterMs: number | null;
  lossPercent: number | null;
};

/**
 * Envelope for module state data sent over signals and included in pong metadata.
 *
 * `phase` lets a module reserve its local slot ("acquiring") so self-facing UI
 * can mount — e.g. the <video> element for screen-share, or a loading-state
 * mic icon — before peers are told anything is happening. Peer-facing dispatch
 * surfaces (peer icon strip, peer overlays, onPeerStateChange) suppress
 * acquiring envelopes; self-facing surfaces honor them. Default when omitted
 * is 'active', so existing modules keep their current behavior unchanged.
 */
export type ModuleStateEnvelope = {
  moduleId: string;
  active: boolean;
  payload: string;
  updatedAt: number;
  phase?: 'acquiring' | 'active';
};

export type ConnectionStatuses = Record<AgentPubKeyB64, ConnectionStatus>;

/**
 * Connection status with a peer
 */
export type ConnectionStatus =
  | {
      /**
       * No WebRTC connection or freshly disconnected
       */
      type: 'Disconnected';
    }
  | {
      /**
       * Agent has been blocked by us
       */
      type: 'Blocked';
    }
  | {
      /**
       * Waiting for an init of a peer whose pubkey is alphabetically higher than ours
       */
      type: 'AwaitingInit';
    }
  | {
      /**
       * Waiting for an Accept of a peer whose pubkey is alphabetically lower than ours
       */
      type: 'InitSent';
      attemptCount?: number;
    }
  | {
      /**
       * Waiting for SDP exchange to start
       */
      type: 'AcceptSent';
      attemptCount?: number;
    }
  | {
      /**
       * SDP exchange is ongoing
       */
      type: 'SdpExchange';
    }
  | {
      /**
       * WebRTC connection is established
       */
      type: 'Connected';
    };

export type AgentInfo = {
  pubkey: AgentPubKeyB64;
  /**
   * If I know from the all_agents anchor that this agent exists in the Room, the
   * type is "known". If I've learnt about this agent only from other's Pong meta data
   * or from receiving a Pong from that agent themselves the type is "told".
   */
  type: 'known' | 'told';
  /**
   * last time when a PongUi from this agent was received
   */
  lastSeen?: number;
  appVersion?: string;
};

/**
 * EVENTS:
 *
 * my-video-on
 * my-video-off
 * my-audio-on
 * my-audio-off
 * my-screen-share-on
 * my-screen-share-off
 *
 * peer-connected
 * peer-disconnected
 * peer-audio-on
 * peer-audio-off
 * peer-video-on
 * peer-video-off
 *
 * error
 *
 */

export type StoreEventPayload =
  | {
      type: 'my-video-on';
    }
  | {
      type: 'my-video-off';
    }
  | {
      type: 'my-audio-on';
    }
  | {
      type: 'my-audio-off';
    }
  | {
      type: 'my-screen-share-on';
    }
  | {
      type: 'my-screen-share-off';
    }
  | {
      type: 'peer-audio-on';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-stream';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
      stream: MediaStream;
    }
  | {
      type: 'peer-audio-off';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-video-on';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-video-off';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-screen-share-stream';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
      stream: MediaStream;
    }
  | {
      type: 'peer-screen-share-track';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
      track: MediaStreamTrack;
    }
  | {
      type: 'peer-connected';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-disconnected';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-leave';
      pubKeyB64: AgentPubKeyB64;
    }
  /**
   * Presence-predicate transitions (present = ping-fresh OR
   * media-flowing; see presence-policy.ts). Emitted by the store's
   * decidePresenceSoundEvents subscription — joins immediately, leaves
   * after the dwell — and consumed by room-view for the join/leave
   * chimes. Distinct from peer-connected/peer-disconnected, which are
   * WebRTC connection events.
   */
  | {
      type: 'peer-joined-presence';
      pubKeyB64: AgentPubKeyB64;
    }
  | {
      type: 'peer-left-presence';
      pubKeyB64: AgentPubKeyB64;
    }
  | {
      type: 'peer-screen-share-connected';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-screen-share-disconnected';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'error';
      error: string;
    };



/**
 * Backend
 */

export type RoomInfo = {
  name: string;
  icon_src: string | undefined;
  meta_data: string | undefined;
};

export type Attachment = {
  wal: string;
};

export type DescendentRoom = {
  network_seed_appendix: string;
  dna_hash: DnaHash;
  name: string;
  icon_src: string | undefined;
  meta_data: string | undefined;
};

/**
 * Typed payload for InitRequest / InitAccept messages
 */
export type InitPayload = {
  connection_id: string;
  connection_type?: string;
};

export type RoomSignal =
  | {
      type: 'Pong';
      from_agent: AgentPubKey;
    }
  | {
      type: 'Message';
      from_agent: AgentPubKey;
      msg_type: string;
      payload: string;
    }
  | {
      type: 'EntryCreated';
      action: SignedActionHashed<Create>;
      app_entry: EntryTypes;
    }
  | {
      type: 'EntryUpdated';
      action: SignedActionHashed<Update>;
      app_entry: EntryTypes;
      original_app_entry: EntryTypes;
    }
  | {
      type: 'EntryDeleted';
      action: SignedActionHashed<Delete>;
      original_app_entry: EntryTypes;
    }
  | {
      type: 'LinkCreated';
      action: SignedActionHashed<CreateLink>;
      link_type: string;
    }
  | {
      type: 'LinkDeleted';
      action: SignedActionHashed<DeleteLink>;
      link_type: string;
    };

export type EntryTypes = {};

export type DiagnosticSnapshot = {
  fromAgent: AgentPubKeyB64;
  sessionId: string;
  agentEvents: import('./logging').SimpleEvent[];
  customLogs: import('./logging').CustomLog[];
  generatedAt: number;
};
