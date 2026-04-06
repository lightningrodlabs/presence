import {
  AgentPubKey,
  AgentPubKeyB64,
  decodeHashFromBase64,
  encodeHashToBase64,
} from '@holochain/client';
import {
  derived,
  get,
  Readable,
  writable,
  Writable,
} from '@holochain-open-dev/stores';
import {
  AgentInfo,
  ConnectionStatus,
  ConnectionStatuses,
  DiagnosticSnapshot,
  OpenConnectionInfo,
  PongMetaData,
  PongMetaDataV1,
  RoomSignal,
  RTCMessage,
  SharedWalPayload,
  StoreEventPayload,
  StreamAndTrackInfo,
} from './types';
import { RoomClient } from './room/room-client';
import { RoomStore } from './room/room-store';
import { PresenceLogger, SimpleEventType } from './logging';
import { getStreamInfo } from './utils';
import { ConnectionManager, HolochainSignalingAdapter } from './connection';
import type { ConnectionPhase } from './connection';

declare const __APP_VERSION__: string;

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

export const PING_INTERVAL = 2000;

/**
 * A store that handles the creation and management of WebRTC streams with
 * holochain peers
 */
export class StreamsStore {
  private roomClient: RoomClient;

  private myPubKeyB64: AgentPubKeyB64;

  private signalUnsubscribe: () => void;

  private allAgentsUnsubscribe: (() => void) | undefined;

  private pingInterval: number | undefined;

  private roomStore: RoomStore;

  private allAgents: AgentPubKey[] = [];

  private screenSourceSelection: () => Promise<string>;

  private eventCallback: (ev: StoreEventPayload) => any = () => undefined;

  logger: PresenceLogger;

  trickleICE = true;

  connectionTimeoutMs = 7_000;
  sdpExchangeTimeoutMs = 15_000;
  dtlsStallTimeoutMs = 5_000;

  turnUrl = '';

  turnUsername = '';

  turnCredential = '';

  blockedAgents: Writable<AgentPubKeyB64[]> = writable([]);

  /**
   * Max random delay in ms to add before processing each incoming signal.
   * 0 = no delay (production). Set via settings UI to simulate high-latency signaling.
   */
  signalDelayMs = 0;

  private _signalQueue: RoomSignal[] = [];

  private _processingSignal = false;

  /** Per-agent unmute timeout IDs, cleared on peer disconnect */
  private _unmuteTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Unsubscribers for ConnectionManager event handlers */
  private _managerEventUnsubs: (() => void)[] = [];

  // ---------------------------------------------------------------------------
  // ConnectionManager (replaces SimplePeer for video/audio connections)
  // ---------------------------------------------------------------------------

  connectionManager!: ConnectionManager;

  private _signalingAdapter!: HolochainSignalingAdapter;

  // ---------------------------------------------------------------------------
  // Screen share ConnectionManager
  // ---------------------------------------------------------------------------

  screenShareConnectionManager!: ConnectionManager;

  private _screenShareSignalingAdapter!: HolochainSignalingAdapter;

  constructor(
    roomStore: RoomStore,
    screenSourceSelection: () => Promise<string>,
    logger: PresenceLogger
  ) {
    this.roomStore = roomStore;
    this.screenSourceSelection = screenSourceSelection;
    this.logger = logger;
    const roomClient = roomStore.client;
    this.roomClient = roomClient;
    this.myPubKeyB64 = encodeHashToBase64(roomClient.client.myPubKey);

    // Read persisted settings BEFORE constructing managers so they get
    // the user's saved config, not class-level defaults.
    const trickleICE = window.localStorage.getItem('trickleICE');
    if (trickleICE) {
      this.trickleICE = JSON.parse(trickleICE);
    }
    const connTimeout = window.localStorage.getItem('connectionTimeoutMs');
    if (connTimeout) this.connectionTimeoutMs = parseInt(connTimeout, 10);
    const sdpTimeout = window.localStorage.getItem('sdpExchangeTimeoutMs');
    if (sdpTimeout) this.sdpExchangeTimeoutMs = parseInt(sdpTimeout, 10);
    const dtlsTimeout = window.localStorage.getItem('dtlsStallTimeoutMs');
    if (dtlsTimeout) this.dtlsStallTimeoutMs = parseInt(dtlsTimeout, 10);
    this.turnUrl = window.localStorage.getItem('turnUrl') || '';
    this.turnUsername = window.localStorage.getItem('turnUsername') || '';
    this.turnCredential = window.localStorage.getItem('turnCredential') || '';
    const signalDelay = window.localStorage.getItem('signalDelayMs');
    if (signalDelay) {
      this.signalDelayMs = parseInt(signalDelay, 10) || 0;
    }

    // Initialize ConnectionManager
    this._signalingAdapter = new HolochainSignalingAdapter(this.roomClient);
    this.connectionManager = new ConnectionManager({
      myAgentId: this.myPubKeyB64,
      signaling: this._signalingAdapter,
      config: {
        iceServers: this.iceConfig,
        trickleICE: this.trickleICE,
        connectionTimeoutMs: this.connectionTimeoutMs,
        sdpExchangeTimeoutMs: this.sdpExchangeTimeoutMs,
        dtlsStallTimeoutMs: this.dtlsStallTimeoutMs,
        role: 'mesh',
      },
      onTransition: (entry) => {
        this.logger.logCustomMessage(
          `FSM [${entry.remoteAgent.slice(0, 8)}]: ${entry.fromState} → ${entry.toState} (${entry.trigger})`
        );
      },
    });
    this._setupConnectionManagerEvents();

    // Screen share ConnectionManager — uses 'ScreenSdp' message type to avoid
    // colliding with the main connection's 'Sdp' messages
    this._screenShareSignalingAdapter = new HolochainSignalingAdapter(this.roomClient, 'ScreenSdp');
    this.screenShareConnectionManager = new ConnectionManager({
      myAgentId: this.myPubKeyB64,
      signaling: this._screenShareSignalingAdapter,
      config: {
        iceServers: this.iceConfig,
        trickleICE: this.trickleICE,
        connectionTimeoutMs: this.connectionTimeoutMs,
        sdpExchangeTimeoutMs: this.sdpExchangeTimeoutMs,
        dtlsStallTimeoutMs: this.dtlsStallTimeoutMs,
        role: 'mesh',
      },
      onTransition: (entry) => {
        this.logger.logCustomMessage(
          `ScreenFSM [${entry.remoteAgent.slice(0, 8)}]: ${entry.fromState} → ${entry.toState} (${entry.trigger})`
        );
      },
    });
    this._setupScreenShareConnectionManagerEvents();

    // TODO potentially move this to a connect() method which also returns
    // the Unsubscribe function
    this.signalUnsubscribe = this.roomClient.onSignal(async signal =>
      this.handleSignal(signal)
    );
    const blockedAgentsJson = window.sessionStorage.getItem('blockedAgents');
    this.blockedAgents.set(
      blockedAgentsJson ? JSON.parse(blockedAgentsJson) : []
    );
    navigator.mediaDevices.ondevicechange = e => {
      console.log('Got device change: ', e);
    };
  }

  /**
   * Wire ConnectionManager events to StreamsStore behavior.
   * Replaces the old SimplePeer event handlers (peer.on('stream'), peer.on('track'), etc.)
   */
  private _setupConnectionManagerEvents() {
    // Handle remote stream arrival
    this._managerEventUnsubs.push(this.connectionManager.on('remote-stream', (event) => {
      const pubKeyB64 = event.remoteAgent;
      const connectionId = event.connectionId;
      const stream = event.data as MediaStream;

      const trackDesc = stream.getTracks().map(t =>
        `${t.kind}:muted=${t.muted},readyState=${t.readyState}`
      ).join(', ');
      this.logger.logCustomMessage(
        `stream received [${pubKeyB64.slice(0, 8)}]: ${stream.getTracks().length} tracks [${trackDesc}]`
      );
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'StreamReceived',
        connectionId,
      });
      // Store to existing streams
      this._videoStreams[pubKeyB64] = stream;

      const audioTracks = stream.getAudioTracks();
      const videoTracks = stream.getVideoTracks();
      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        const relevantConnection = openConnections[pubKeyB64];
        if (relevantConnection) {
          if (audioTracks.length > 0) {
            relevantConnection.audio = true;
          }
          if (videoTracks.length > 0 && !videoTracks[0].muted) {
            relevantConnection.video = true;
          } else if (videoTracks.length > 0 && videoTracks[0].muted) {
            relevantConnection.videoMuted = true;
          }
          openConnections[pubKeyB64] = relevantConnection;
        }
        return openConnections;
      });
      // Always fire peer-stream so srcObject gets assigned to the <video> element
      this.eventCallback({
        type: 'peer-stream',
        pubKeyB64,
        connectionId,
        stream,
      });
    }));

    // Handle remote track arrival
    this._managerEventUnsubs.push(this.connectionManager.on('remote-track', (event) => {
      const pubKeyB64 = event.remoteAgent;
      const connectionId = event.connectionId;
      const { track } = event.data;

      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'RemoteTrack',
        connectionId,
      });

      if (!track.muted) {
        this._setTrackReady(pubKeyB64, connectionId, track);
      } else {
        this.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: Date.now(),
          event: 'TrackArrivedMuted',
        });

        if (track.kind === 'video') {
          this._openConnections.update(current => {
            const conn = current[pubKeyB64];
            if (conn) {
              conn.videoMuted = true;
            }
            return current;
          });
        }

        const unmuteTimeout = setTimeout(() => {
          this._unmuteTimeouts.delete(pubKeyB64);
          if (track.muted) {
            this.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: Date.now(),
              event: 'TrackUnmuteTimeout',
            });
            this._setTrackReady(pubKeyB64, connectionId, track);
          }
        }, 5000);
        this._unmuteTimeouts.set(pubKeyB64, unmuteTimeout);

        track.onunmute = () => {
          clearTimeout(unmuteTimeout);
          this._unmuteTimeouts.delete(pubKeyB64);
          this.logger.logAgentEvent({
            agent: pubKeyB64,
            timestamp: Date.now(),
            event: 'TrackUnmuted',
          });
          this._setTrackReady(pubKeyB64, connectionId, track);
        };
      }
    }));

    // Handle data channel messages
    this._managerEventUnsubs.push(this.connectionManager.on('data-channel-message', (event) => {
      const pubKeyB64 = event.remoteAgent;
      const connectionId = event.connectionId;
      const data = event.data;

      try {
        const msg: RTCMessage = JSON.parse(data);
        if (msg.type === 'action') {
          if (msg.message === 'video-off') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKeyB64];
              if (relevantConnection) {
                relevantConnection.video = false;
                openConnections[pubKeyB64] = relevantConnection;
              }
              return openConnections;
            });
            this.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: Date.now(),
              event: 'PeerVideoOffSignal',
            });
          }
          if (msg.message === 'video-on') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKeyB64];
              if (relevantConnection) {
                relevantConnection.video = true;
                openConnections[pubKeyB64] = relevantConnection;
              }
              return openConnections;
            });
            this.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: Date.now(),
              event: 'PeerVideoOnSignal',
            });
            // If we got a video-on signal but have no video track from this
            // peer, their renegotiation offer may have been lost (stale answer).
            // Request they re-send their tracks.
            const hasVideoTrack = this._videoStreams[pubKeyB64]?.getVideoTracks().some(
              t => t.readyState === 'live'
            );
            if (!hasVideoTrack) {
              const fsm = this.connectionManager.getFSM(pubKeyB64);
              if (fsm) {
                const refreshMsg: RTCMessage = { type: 'action', message: 'request-track-refresh' };
                fsm.send(JSON.stringify(refreshMsg));
              }
            }
          }
          if (msg.message === 'audio-off') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKeyB64];
              if (relevantConnection) {
                relevantConnection.audio = false;
                openConnections[pubKeyB64] = relevantConnection;
              }
              return openConnections;
            });
            this.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: Date.now(),
              event: 'PeerAudioOffSignal',
            });
          }
          if (msg.message === 'audio-on') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKeyB64];
              if (relevantConnection) {
                relevantConnection.audio = true;
                openConnections[pubKeyB64] = relevantConnection;
              }
              return openConnections;
            });
            this.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: Date.now(),
              event: 'PeerAudioOnSignal',
            });
          }
          if (msg.message === 'change-audio-input') {
            this.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: Date.now(),
              event: 'PeerChangeAudioInput',
            });
          }
          if (msg.message === 'change-video-input') {
            this.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: Date.now(),
              event: 'PeerChangeVideoInput',
            });
          }
          if (msg.message === 'request-track-refresh') {
            this.logger.logCustomMessage(
              `request-track-refresh received from [${pubKeyB64.slice(0, 8)}]`
            );
            this.refreshTracksForPeer(pubKeyB64);
          }
        }
      } catch (e) {
        console.warn(
          `Failed to parse RTCMessage: ${JSON.stringify(
            e
          )}. Got message: ${data}}`
        );
      }
    }));

    // Handle connection state changes
    this._managerEventUnsubs.push(this.connectionManager.on('connection-state-changed', (event) => {
      const pubKeyB64 = event.remoteAgent;
      const connectionId = event.connectionId;
      const { toState, fromState } = event.data as { fromState: ConnectionPhase; toState: ConnectionPhase };

      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: `ConnectionState_${toState}` as SimpleEventType,
        connectionId,
      });

      if (toState === 'connected') {
        // Rebuild open connections entry
        this._rebuildOpenConnections();

        // Update connection status store
        this._rebuildConnectionStatuses();

        // Add mainStream if available
        if (this.mainStream) {
          try {
            const fsm = this.connectionManager.getFSM(pubKeyB64);
            if (fsm) {
              fsm.addLocalStream(this.mainStream);
              this.logger.logCustomMessage(
                `addStream on-connect [${pubKeyB64.slice(0, 8)}]: ${this.mainStream.getTracks().length} tracks`
              );
            }
          } catch (e: any) {
            // Tracks were already included — no action needed
          }
        }

        // Only play join sound on genuine first connection — not reconnection
        // recovery and not same-state ICE informational events
        if (fromState !== 'reconnecting' && fromState !== 'connected') {
          this.eventCallback({
            type: 'peer-connected',
            pubKeyB64,
            connectionId,
          });
        }

        // If we have an active screen share, ensure a screen share connection
        if (this.screenShareStream) {
          this.screenShareConnectionManager.ensureConnection(pubKeyB64);
        }

        // Send immediate pong so peers see green rings
        this._sendImmediatePongToAll();
      } else if (toState === 'disconnected' || toState === 'closed' || toState === 'failed') {
        // Clear any pending unmute timeout for this peer
        const pendingUnmute = this._unmuteTimeouts.get(pubKeyB64);
        if (pendingUnmute) {
          clearTimeout(pendingUnmute);
          this._unmuteTimeouts.delete(pubKeyB64);
        }

        // Remove from existing streams
        delete this._videoStreams[pubKeyB64];

        // Rebuild open connections (this will remove the closed one)
        this._rebuildOpenConnections();

        // Clear stale perceivedStreamInfo
        this._othersConnectionStatuses.update(statuses => {
          if (statuses[pubKeyB64]) {
            statuses[pubKeyB64] = {
              ...statuses[pubKeyB64],
              perceivedStreamInfo: undefined,
            };
          }
          return statuses;
        });

        // Also tear down any screen share connection to this peer
        this.screenShareConnectionManager.closeConnection(pubKeyB64, 'video peer closed');

        this._rebuildConnectionStatuses();
        this.eventCallback({
          type: 'peer-disconnected',
          pubKeyB64,
          connectionId,
        });
      } else if (toState === 'reconnecting') {
        // Clear frozen video and stale media flags — show avatar + "Reconnecting..." instead
        delete this._videoStreams[pubKeyB64];
        this._openConnections.update(current => {
          if (current[pubKeyB64]) {
            current[pubKeyB64] = { ...current[pubKeyB64], video: false, audio: false, videoMuted: false };
          }
          return current;
        });
        this._rebuildOpenConnections();
        this._rebuildConnectionStatuses();
        // Notify UI to clear the frozen video element
        this.eventCallback({
          type: 'peer-reconnecting',
          pubKeyB64,
          connectionId,
        });
      } else {
        // For signaling, connecting — rebuild both stores
        this._rebuildOpenConnections();
        this._rebuildConnectionStatuses();
      }
    }));
  }

  /**
   * Wire screen share ConnectionManager events to StreamsStore behavior.
   * Mirrors _setupConnectionManagerEvents() but updates screen share stores.
   */
  private _setupScreenShareConnectionManagerEvents() {
    // Handle remote screen share stream arrival
    this._managerEventUnsubs.push(this.screenShareConnectionManager.on('remote-stream', (event) => {
      const pubKeyB64 = event.remoteAgent;
      const connectionId = event.connectionId;
      const stream = event.data as MediaStream;

      this.logger.logCustomMessage(
        `screen share stream received [${pubKeyB64.slice(0, 8)}]: ${stream.getTracks().length} tracks`
      );

      this._screenShareStreams[pubKeyB64] = stream;

      this._screenShareConnectionsIncoming.update(currentValue => {
        const conn = currentValue[pubKeyB64];
        if (conn) {
          if (stream.getAudioTracks().length > 0) conn.audio = true;
          if (stream.getVideoTracks().length > 0) conn.video = true;
        }
        return currentValue;
      });

      this.eventCallback({
        type: 'peer-screen-share-stream',
        pubKeyB64,
        connectionId,
        stream,
      });
    }));

    // Handle remote screen share track arrival
    this._managerEventUnsubs.push(this.screenShareConnectionManager.on('remote-track', (event) => {
      const pubKeyB64 = event.remoteAgent;
      const connectionId = event.connectionId;
      const { track } = event.data;

      this._screenShareConnectionsIncoming.update(currentValue => {
        const conn = currentValue[pubKeyB64];
        if (conn) {
          if (track.kind === 'audio' && track.enabled) conn.audio = true;
          if (track.kind === 'video' && track.enabled) conn.video = true;
        }
        return currentValue;
      });

      this.eventCallback({
        type: 'peer-screen-share-track',
        pubKeyB64,
        connectionId,
        track,
      });
    }));

    // Handle screen share connection state changes
    this._managerEventUnsubs.push(this.screenShareConnectionManager.on('connection-state-changed', (event) => {
      const pubKeyB64 = event.remoteAgent;
      const connectionId = event.connectionId;
      const { toState } = event.data as { fromState: string; toState: string };

      if (toState === 'connected') {
        // Determine direction based on whether we have a screen share stream
        const direction = this.screenShareStream ? 'outgoing' : 'incoming';

        if (direction === 'outgoing') {
          this._screenShareConnectionsOutgoing.update(currentValue => {
            currentValue[pubKeyB64] = {
              connectionId,
              video: true,
              audio: false,
              connected: true,
              direction: 'outgoing',
            };
            return currentValue;
          });

          // Add screen share stream if available
          if (this.screenShareStream) {
            const fsm = this.screenShareConnectionManager.getFSM(pubKeyB64);
            if (fsm) {
              try {
                fsm.addLocalStream(this.screenShareStream);
              } catch (e: any) {
                // Stream may already be added
              }
            }
          }
        } else {
          this._screenShareConnectionsIncoming.update(currentValue => {
            currentValue[pubKeyB64] = {
              connectionId,
              video: false,
              audio: false,
              connected: true,
              direction: 'incoming',
            };
            return currentValue;
          });

          this.eventCallback({
            type: 'peer-screen-share-connected',
            pubKeyB64,
            connectionId,
          });
        }

        this._rebuildScreenShareConnectionStatuses();
      } else if (toState === 'disconnected' || toState === 'closed' || toState === 'failed') {
        delete this._screenShareStreams[pubKeyB64];

        // Clean up from both outgoing and incoming stores
        const wasOutgoing = !!get(this._screenShareConnectionsOutgoing)[pubKeyB64];
        this._screenShareConnectionsOutgoing.update(v => { delete v[pubKeyB64]; return v; });
        this._screenShareConnectionsIncoming.update(v => { delete v[pubKeyB64]; return v; });

        if (!wasOutgoing) {
          this.eventCallback({
            type: 'peer-screen-share-disconnected',
            pubKeyB64,
            connectionId,
          });
        }

        this._rebuildScreenShareConnectionStatuses();
      } else {
        this._rebuildScreenShareConnectionStatuses();
      }
    }));
  }

  /**
   * Rebuild _openConnections from ConnectionManager state.
   * The `peer` field is set to `null as any` since UI components use
   * StreamsStore methods rather than accessing peer connections directly.
   */
  private _rebuildOpenConnections() {
    const states = this.connectionManager.getAllStates();
    const newOpenConnections: Record<AgentPubKeyB64, OpenConnectionInfo> = {};

    // Preserve existing entries for connected peers (to keep audio/video/relayed flags)
    const currentOpenConnections = get(this._openConnections);

    for (const [agent, state] of states) {
      if (state === 'connected' || state === 'signaling' || state === 'connecting' || state === 'reconnecting') {
        const existing = currentOpenConnections[agent];
        const fsm = this.connectionManager.getFSM(agent);
        const vm = this.connectionManager.getViewModel(agent);
        // Check if we have an active video/audio stream for this agent.
        // Note: only used as a fallback when there's no inherited state —
        // data channel messages (video-on/off, audio-on/off) are the
        // authoritative source for the sender's media intent.
        const hasVideoStream = !!this._videoStreams[agent]?.getVideoTracks().some(
          t => t.readyState === 'live'
        );
        const hasAudioStream = !!this._videoStreams[agent]?.getAudioTracks().some(
          t => t.readyState === 'live'
        );
        // Only inherit video/audio flags from the previous entry if the
        // connection has progressed past the initial handshake. For signaling
        // and connecting states, use only the actual stream state — otherwise
        // a stale video:true from a destroyed-and-replaced FSM persists and
        // shows a blank video rectangle instead of the avatar.
        const canInheritMedia = state === 'connected' || state === 'reconnecting';
        // When inheriting from an existing entry, trust its video/audio flags
        // — they are maintained by data channel messages (video-on/off, audio-on/off)
        // which reflect the sender's intent. Only fall back to raw stream checks
        // when there is no existing entry (initial connection before any data
        // channel messages have arrived).
        const inheritVideo = canInheritMedia && existing != null;
        newOpenConnections[agent] = {
          connectionId: fsm?.connectionId ?? '',
          video: inheritVideo ? existing!.video : hasVideoStream,
          audio: inheritVideo ? existing!.audio : hasAudioStream,
          connected: state === 'connected',
          relayed: vm?.quality?.relayed ?? existing?.relayed,
          videoMuted: inheritVideo ? existing!.videoMuted : undefined,
          direction: 'duplex',
        };
      }
    }

    this._openConnections.set(newOpenConnections);
  }

  /**
   * Rebuild _connectionStatuses from ConnectionManager state.
   * Maps ConnectionPhase to the legacy ConnectionStatus type.
   */
  private _rebuildConnectionStatuses() {
    const states = this.connectionManager.getAllStates();
    const currentStatuses = get(this._connectionStatuses);
    const newStatuses: ConnectionStatuses = { ...currentStatuses };

    for (const [agent, state] of states) {
      // Don't override 'Blocked' status
      if (newStatuses[agent]?.type === 'Blocked') continue;

      newStatuses[agent] = this._phaseToConnectionStatus(state);
    }

    this._connectionStatuses.set(newStatuses);
  }

  /**
   * Rebuild _screenShareConnectionStatuses from screen share ConnectionManager state.
   */
  private _rebuildScreenShareConnectionStatuses() {
    const states = this.screenShareConnectionManager.getAllStates();
    const newStatuses: ConnectionStatuses = {};

    for (const [agent, state] of states) {
      newStatuses[agent] = this._phaseToConnectionStatus(state);
    }

    this._screenShareConnectionStatuses.set(newStatuses);
  }

  /**
   * Map a ConnectionPhase to the legacy ConnectionStatus type.
   */
  private _phaseToConnectionStatus(phase: ConnectionPhase): ConnectionStatus {
    switch (phase) {
      case 'idle':
      case 'disconnected':
      case 'failed':
      case 'closed':
        return { type: 'Disconnected' };
      case 'signaling':
        return { type: 'InitSent' };
      case 'connecting':
        return { type: 'SdpExchange' };
      case 'reconnecting':
        return { type: 'Reconnecting' };
      case 'connected':
        return { type: 'Connected' };
      default:
        return { type: 'Disconnected' };
    }
  }

  /**
   * Send a message to all connected peers via data channel.
   */
  private _sendToAllConnected(message: RTCMessage) {
    const states = this.connectionManager.getAllStates();
    for (const [agent, state] of states) {
      if (state === 'connected') {
        const fsm = this.connectionManager.getFSM(agent);
        if (fsm) {
          try {
            fsm.send(JSON.stringify(message));
          } catch (e: any) {
            console.warn(`Failed to send message to ${agent.slice(0, 8)}: ${e.toString()}`);
          }
        }
      }
    }
  }

  static async connect(
    roomStore: RoomStore,
    screenSourceSelection: () => Promise<string>,
    logger: PresenceLogger
  ): Promise<StreamsStore> {
    const streamsStore = new StreamsStore(
      roomStore,
      screenSourceSelection,
      logger
    );

    // Wait for allAgents to load before first ping so we actually have peers to contact
    let initUnsub: (() => void) | undefined;
    await new Promise<void>((resolve) => {
      initUnsub = roomStore.allAgents.subscribe(val => {
        if (val.status === 'complete') {
          streamsStore.allAgents = val.value;
          resolve();
        } else if (val.status === 'error') {
          console.error('Failed to get all agents: ', val.error);
          resolve(); // Don't block forever on error
        }
      });
    });
    // Unsubscribe the one-shot — the ongoing subscription below takes over
    initUnsub?.();

    // Keep subscribing for ongoing updates
    streamsStore.allAgentsUnsubscribe = roomStore.allAgents.subscribe(val => {
      if (val.status === 'complete') {
        streamsStore.allAgents = val.value;
      }
    });

    // ping all agents that are not already connected to you every PING_INTERVAL milliseconds
    await streamsStore.pingAgents();
    streamsStore.pingInterval = window.setInterval(async () => {
      await streamsStore.pingAgents();
    }, PING_INTERVAL);

    setTimeout(async () => {
      const mediaDevices = await navigator.mediaDevices.enumerateDevices();
      streamsStore.mediaDevices.set(mediaDevices);
    });
    return streamsStore;
  }

  disconnect() {
    // Notify peers immediately before tearing down
    const agentsToNotify = Object.keys(get(this._knownAgents))
      .filter(a => a !== this.myPubKeyB64)
      .map(b64 => decodeHashFromBase64(b64));
    if (agentsToNotify.length > 0) {
      this.roomClient.sendMessage(agentsToNotify, 'LeaveUi').catch(() => {});
    }

    if (this.pingInterval) window.clearInterval(this.pingInterval);
    if (this.signalUnsubscribe) this.signalUnsubscribe();
    if (this.allAgentsUnsubscribe) this.allAgentsUnsubscribe();
    for (const timeout of this._unmuteTimeouts.values()) clearTimeout(timeout);
    this._unmuteTimeouts.clear();
    for (const unsub of this._managerEventUnsubs) unsub();
    this._managerEventUnsubs.length = 0;

    // Destroy ConnectionManager (handles all video/audio connections)
    this.connectionManager.destroy();

    // Destroy screen share ConnectionManager
    this.screenShareConnectionManager.destroy();

    navigator.mediaDevices.ondevicechange = null;
    this.videoOff();
    this.audioOff();
    this.screenShareOff();
    this.mainStream = null;
    this.screenShareStream = null;
    this._openConnections.set({});
    this._screenShareConnectionsOutgoing.set({});
    this._screenShareConnectionsIncoming.set({});
    this._videoStreams = {};
    this._screenShareStreams = {};
  }

  enableTrickleICE() {
    window.localStorage.setItem('trickleICE', 'true');
    this.trickleICE = true;
    this.connectionManager.updateConfig({ trickleICE: true });
    this.screenShareConnectionManager.updateConfig({ trickleICE: true });
  }

  disableTrickleICE() {
    window.localStorage.setItem('trickleICE', 'false');
    this.trickleICE = false;
    this.connectionManager.updateConfig({ trickleICE: false });
    this.screenShareConnectionManager.updateConfig({ trickleICE: false });
  }

  setConnectionTimeoutMs(ms: number) {
    this.connectionTimeoutMs = ms;
    window.localStorage.setItem('connectionTimeoutMs', String(ms));
    this.connectionManager.updateConfig({ connectionTimeoutMs: ms });
    this.screenShareConnectionManager.updateConfig({ connectionTimeoutMs: ms });
  }

  setSdpExchangeTimeoutMs(ms: number) {
    this.sdpExchangeTimeoutMs = ms;
    window.localStorage.setItem('sdpExchangeTimeoutMs', String(ms));
    this.connectionManager.updateConfig({ sdpExchangeTimeoutMs: ms });
    this.screenShareConnectionManager.updateConfig({ sdpExchangeTimeoutMs: ms });
  }

  setDtlsStallTimeoutMs(ms: number) {
    this.dtlsStallTimeoutMs = ms;
    window.localStorage.setItem('dtlsStallTimeoutMs', String(ms));
    this.connectionManager.updateConfig({ dtlsStallTimeoutMs: ms });
    this.screenShareConnectionManager.updateConfig({ dtlsStallTimeoutMs: ms });
  }

  get iceConfig(): RTCIceServer[] {
    const servers: RTCIceServer[] = [...STUN_SERVERS];
    if (this.turnUrl) {
      servers.push({
        urls: this.turnUrl,
        username: this.turnUsername,
        credential: this.turnCredential,
      });
    }
    return servers;
  }

  setTurnUrl(url: string) {
    this.turnUrl = url;
    window.localStorage.setItem('turnUrl', url);
    this._propagateIceServers();
  }

  setTurnUsername(username: string) {
    this.turnUsername = username;
    window.localStorage.setItem('turnUsername', username);
    this._propagateIceServers();
  }

  setTurnCredential(credential: string) {
    this.turnCredential = credential;
    window.localStorage.setItem('turnCredential', credential);
    this._propagateIceServers();
  }

  private _propagateIceServers() {
    const iceServers = this.iceConfig;
    this.connectionManager.updateConfig({ iceServers });
    this.screenShareConnectionManager.updateConfig({ iceServers });
  }

  setSignalDelay(ms: number) {
    this.signalDelayMs = ms;
    window.localStorage.setItem('signalDelayMs', String(ms));
  }

  onEvent(cb: (ev: StoreEventPayload) => any) {
    this.eventCallback = cb;
  }

  async pingAgents() {
    const knownAgents = get(this._knownAgents);
    this.allAgents
      .map(agent => encodeHashToBase64(agent))
      .forEach(agentB64 => {
        if (agentB64 !== this.myPubKeyB64) {
          const alreadyKnown = knownAgents[agentB64];
          if (alreadyKnown && alreadyKnown.type !== 'known') {
            knownAgents[agentB64] = {
              pubkey: agentB64,
              type: 'known',
              lastSeen: alreadyKnown.lastSeen,
              appVersion: alreadyKnown.appVersion,
            };
          } else if (!alreadyKnown) {
            knownAgents[agentB64] = {
              pubkey: agentB64,
              type: 'known',
              lastSeen: undefined,
              appVersion: undefined,
            };
          }
        }
      });
    // NOTE: There is a minor chance that this._knownAgents changes as a result from code
    // elsewhere while we looped through this.allAgents above and we're overwriting these
    // changes from elsewhere here. But we consider this possibility negligible for now.
    this._knownAgents.set(knownAgents);

    // Update connection statuses with known people for which we do not yet have a connection status
    this._connectionStatuses.update(currentValue => {
      const connectionStatuses = currentValue;
      Object.keys(get(this._knownAgents)).forEach(agentB64 => {
        if (!connectionStatuses[agentB64]) {
          if (get(this.blockedAgents).includes(agentB64)) {
            connectionStatuses[agentB64] = {
              type: 'Blocked',
            };
          } else {
            connectionStatuses[agentB64] = {
              type: 'Disconnected',
            };
          }
        }
      });
      return connectionStatuses;
    });

    // Ping known agents
    // This could potentially be optimized by only pinging agents that are online according to Moss (which would only work in shared rooms though)
    const agentsToPing = Object.keys(get(this._knownAgents))
      .filter(agent => !get(this.blockedAgents).includes(agent))
      .map(pubkeyB64 => decodeHashFromBase64(pubkeyB64));
    await this.roomStore.client.sendMessage(agentsToPing, 'PingUi');

    // Pong liveness check: close connections to peers that stopped responding.
    // If a peer's process is killed (no LeaveUi signal), this is the only
    // mechanism to detect their absence and clean up.
    const PONG_TIMEOUT_MS = 10_000;
    const now = Date.now();
    const currentKnown = get(this._knownAgents);
    for (const [agentB64, info] of Object.entries(currentKnown)) {
      if (agentB64 === this.myPubKeyB64) continue;
      const state = this.connectionManager.getState(agentB64);
      const isActive = state && state !== 'idle' && state !== 'closed' && state !== 'failed' && state !== 'disconnected';
      if (!isActive) continue;

      if (info.lastSeen && (now - info.lastSeen) > PONG_TIMEOUT_MS) {
        this.logger.logCustomMessage(`Pong timeout for ${agentB64.slice(5, 13)}: last pong ${now - info.lastSeen}ms ago, closing connection`);
        this.connectionManager.closeConnection(agentB64, 'pong timeout');
        this.screenShareConnectionManager.closeConnection(agentB64, 'pong timeout');
        // Clean up video streams
        delete this._videoStreams[agentB64];
        this._rebuildConnectionStatuses();
      }
    }

    // Log our stream state
    this.logger.logMyStreamInfo(getStreamInfo(this.mainStream));
  }

  async changeVideoInput(deviceId: string) {
    this._videoInputId.set(deviceId);
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'ChangeMyVideoInput',
    });
    this._sendToAllConnected({
      type: 'action',
      message: 'change-video-input',
    });
    const videoTrack = this.mainStream?.getVideoTracks()[0];
    if (videoTrack && videoTrack.enabled) {
      await this.videoOff();
      await this.videoOn();
    }
  }

  async videoOn() {
    const deviceId = get(this._videoInputId);
    if (this.mainStream) {
      if (this.mainStream.getVideoTracks()[0]) {
        this.mainStream.getVideoTracks()[0].enabled = true;
        this.eventCallback({
          type: 'my-video-on',
        });
        // Ensure the track is on all connections — if a previous renegotiation
        // failed (e.g., stale answer), the track may not have been delivered
        // to some peers. updateLocalStream checks for missing tracks.
        this.connectionManager.updateLocalStream(this.mainStream);
      } else {
        let videoStream: MediaStream | undefined;
        try {
          videoStream = await navigator.mediaDevices.getUserMedia({
            video: deviceId ? { deviceId } : true,
          });
        } catch (e: any) {
          const error = `Failed to get media devices (video): ${e.toString()}`;
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
          return;
        }
        if (!videoStream) {
          const error = 'Video stream undefined after getUserMedia.';
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
          return;
        }
        const videoTrack = videoStream.getVideoTracks()[0];
        if (!videoTrack) {
          const error = 'No video track found on video stream.';
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
          return;
        }
        this.mainStream.addTrack(videoTrack);
        this.eventCallback({
          type: 'my-video-on',
        });
        // Propagate stream update to all connections via ConnectionManager
        try {
          this.connectionManager.updateLocalStream(this.mainStream);
        } catch (e: any) {
          console.error(`Failed to add video track: ${e.toString()}`);
        }
      }
    } else {
      try {
        this.mainStream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId } : true,
        });
      } catch (e: any) {
        const error = `Failed to get media devices (video): ${e.toString()}`;
        console.error(error);
        this.eventCallback({
          type: 'error',
          error,
        });
        return;
      }
      this.eventCallback({
        type: 'my-video-on',
      });
      // Propagate stream to all connections via ConnectionManager
      try {
        this.connectionManager.updateLocalStream(this.mainStream);
      } catch (e: any) {
        console.error(`Failed to add video track: ${e.toString()}`);
      }
    }

    // Log event
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'MyVideoOn',
    });

    // Send 'video-on' signal to peers
    this._sendToAllConnected({
      type: 'action',
      message: 'video-on',
    });
  }

  videoOff() {
    if (this.mainStream) {
      this.mainStream.getVideoTracks().forEach(track => {
        // Disable instead of stop — keeps camera allocated so videoOn()
        // can re-enable without calling getUserMedia() (avoids re-prompting
        // for permissions). This matches standard behavior in Zoom/Meet/Teams.
        // eslint-disable-next-line no-param-reassign
        track.enabled = false;
      });
      // Send video-off message to all connected peers
      this._sendToAllConnected({
        type: 'action',
        message: 'video-off',
      });
      this.logger.logAgentEvent({
        agent: encodeHashToBase64(this.roomClient.client.myPubKey),
        timestamp: Date.now(),
        event: 'MyVideoOff',
      });
      this.eventCallback({
        type: 'my-video-off',
      });
    }
  }

  async changeAudioInput(deviceId: string) {
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'ChangeMyAudioInput',
    });
    console.log('Changing audio input to: ', deviceId);
    this._audioInputId.set(deviceId);
    // If a stream is running with audio track, remove the existing track
    // and turn audio back on
    if (this.mainStream) {
      const audioTrack = this.mainStream.getAudioTracks()[0];
      if (audioTrack) {
        const enabled = audioTrack.enabled;
        audioTrack.stop();
        this.mainStream!.removeTrack(audioTrack);
        const newAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
            deviceId,
          },
        });
        const newAudioTrack = newAudioStream.getAudioTracks()[0];
        if (!enabled) {
          newAudioTrack.enabled = false;
        }
        this.mainStream.addTrack(newAudioTrack);
        // Replace track on all connected FSMs
        const states = this.connectionManager.getAllStates();
        for (const [agent, state] of states) {
          if (state === 'connected') {
            const fsm = this.connectionManager.getFSM(agent);
            if (fsm) {
              try {
                await fsm.replaceTrack(audioTrack, newAudioTrack);
              } catch (e: any) {
                console.warn(`Failed to replace audio track for ${agent.slice(0, 8)}: ${e.toString()}`);
              }
            }
          }
        }
      }
    }
    this._sendToAllConnected({
      type: 'action',
      message: 'change-audio-input',
    });
  }

  async audioOn(enabled: boolean) {
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'MyAudioOn',
    });
    const deviceId = get(this._audioInputId);
    if (this.mainStream) {
      if (this.mainStream.getAudioTracks()[0]) {
        // Apparently, it is not necessary to enable the tracks of the
        // cloned streams explicitly as well here.
        if (enabled) {
          this.mainStream.getAudioTracks()[0].enabled = true;
        }
      } else {
        let audioStream: MediaStream | undefined;
        try {
          audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              noiseSuppression: true,
              echoCancellation: true,
              deviceId,
            },
          });
        } catch (e: any) {
          const error = `Failed to get media devices (audio): ${e.toString()}`;
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
          return;
        }
        try {
          const audioTrack = audioStream.getAudioTracks()[0];
          if (!enabled) {
            audioTrack.enabled = false;
          }
          this.mainStream.addTrack(audioTrack);
          // Propagate stream update via ConnectionManager
          this.connectionManager.updateLocalStream(this.mainStream);
        } catch (e: any) {
          console.error(`Failed to add audio track: ${e.toString()}`);
        }
      }
    } else {
      try {
        this.mainStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
            deviceId,
          },
        });
        if (!enabled) {
          const audioTrack = this.mainStream.getAudioTracks()[0];
          audioTrack.enabled = false;
        }
      } catch (e: any) {
        const error = `Failed to get media devices (audio): ${e.toString()}`;
        console.error(error);
        this.eventCallback({
          type: 'error',
          error,
        });
        return;
      }
      // Propagate stream via ConnectionManager
      this.connectionManager.updateLocalStream(this.mainStream);
    }
    this.eventCallback({
      type: 'my-audio-on',
    });
    // Send 'audio-on' signal to peers
    this._sendToAllConnected({
      type: 'action',
      message: 'audio-on',
    });
  }

  audioOff() {
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'MyAudioOff',
    });
    if (this.mainStream) {
      this.mainStream.getAudioTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = false;
      });
      // Send audio-off message to all connected peers
      this._sendToAllConnected({
        type: 'action',
        message: 'audio-off',
      });
      this.eventCallback({
        type: 'my-audio-off',
      });
    }
  }

  async screenShareOn() {
    if (this.screenShareStream) {
      this.screenShareStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = true;
      });
    } else {
      try {
        const screenSource = await this.screenSourceSelection();
        this.screenShareStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource,
            },
          } as any,
        });
      } catch (e: any) {
        if (!e.toString().includes('Selection canceled by user')) {
          const error = `Failed to get media devices (screen share): ${e.toString()}`;
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
        }
      }
      // Propagate screen share stream to all existing screen share connections
      if (this.screenShareStream) {
        this.screenShareConnectionManager.updateLocalStream(this.screenShareStream);

        // Ensure screen share connections to all video-connected peers
        const states = this.connectionManager.getAllStates();
        for (const [agent, state] of states) {
          if (state === 'connected') {
            this.screenShareConnectionManager.ensureConnection(agent);
          }
        }
      }
    }
    this.eventCallback({
      type: 'my-screen-share-on',
    });
  }

  /**
   * Turning screen sharing off closes all screen share connections.
   */
  screenShareOff() {
    if (this.screenShareStream) {
      this.screenShareStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.stop();
      });
      // Close all screen share connections
      for (const [agent] of this.screenShareConnectionManager.getAllStates()) {
        this.screenShareConnectionManager.closeConnection(agent, 'screen share off');
      }
      this.screenShareStream = null;
      this._screenShareConnectionsOutgoing.set({});
      this.eventCallback({
        type: 'my-screen-share-off',
      });
    }
  }

  // ===========================================================================================
  // SHARE WAL
  // ===========================================================================================

  async shareWal(payload: SharedWalPayload) {
    this._mySharedWal.set(payload);
    const knownAgents = get(this._knownAgents);
    const agentsToNotify = Object.keys(knownAgents)
      .filter(a => a !== this.myPubKeyB64)
      .map(a => decodeHashFromBase64(a));
    if (agentsToNotify.length > 0) {
      try {
        await this.roomClient.sendMessage(
          agentsToNotify,
          'ShareWal',
          JSON.stringify(payload),
        );
      } catch (e) {
        console.error('Failed to send ShareWal signal:', e);
      }
    }
  }

  async stopShareWal() {
    this._mySharedWal.set(null);
    const knownAgents = get(this._knownAgents);
    const agentsToNotify = Object.keys(knownAgents)
      .filter(a => a !== this.myPubKeyB64)
      .map(a => decodeHashFromBase64(a));
    if (agentsToNotify.length > 0) {
      try {
        await this.roomClient.sendMessage(
          agentsToNotify,
          'StopShareWal',
          '',
        );
      } catch (e) {
        console.error('Failed to send StopShareWal signal:', e);
      }
    }
  }

  disconnectFromPeerVideo(pubKeyB64: AgentPubKeyB64) {
    this.connectionManager.closeConnection(pubKeyB64, 'manual disconnect');
  }

  disconnectFromPeerScreen(pubKeyB64: AgentPubKeyB64) {
    this.screenShareConnectionManager.closeConnection(pubKeyB64, 'manual disconnect');
  }

  blockAgent(pubKey64: AgentPubKeyB64) {
    const currentlyBlockedAgents = get(this.blockedAgents);
    if (!currentlyBlockedAgents.includes(pubKey64)) {
      this.blockedAgents.set([...currentlyBlockedAgents, pubKey64]);
    }
    const blockedAgentsJson = window.sessionStorage.getItem('blockedAgents');
    const blockedAgents: AgentPubKeyB64[] = blockedAgentsJson
      ? JSON.parse(blockedAgentsJson)
      : [];
    if (!blockedAgents.includes(pubKey64))
      window.sessionStorage.setItem(
        'blockedAgents',
        JSON.stringify([...blockedAgents, pubKey64])
      );
    this.connectionManager.closeConnection(pubKey64, 'blocked');
    this.disconnectFromPeerScreen(pubKey64);
    setTimeout(() => {
      this._connectionStatuses.update(currentValue => {
        const connectionStatuses = currentValue;
        connectionStatuses[pubKey64] = {
          type: 'Blocked',
        };
        return connectionStatuses;
      });
    }, 500);
  }

  unblockAgent(pubKey64: AgentPubKeyB64) {
    const currentlyBlockedAgents = get(this.blockedAgents);
    this.blockedAgents.set(
      currentlyBlockedAgents.filter(pubkey => pubkey !== pubKey64)
    );
    const blockedAgentsJson = window.sessionStorage.getItem('blockedAgents');
    const blockedAgents: AgentPubKeyB64[] = blockedAgentsJson
      ? JSON.parse(blockedAgentsJson)
      : [];
    window.sessionStorage.setItem(
      'blockedAgents',
      JSON.stringify(blockedAgents.filter(pubkey => pubkey !== pubKey64))
    );
  }

  isAgentBlocked(pubKey64: AgentPubKeyB64): Readable<boolean> {
    return derived(this.blockedAgents, val => val.includes(pubKey64));
  }

  // ===========================================================================================
  // MEDIA DEVICES
  // ===========================================================================================

  mediaDevices: Writable<MediaDeviceInfo[]> = writable([]);

  async updateMediaDevices() {
    const mediaDevices = await navigator.mediaDevices.enumerateDevices();
    this.mediaDevices.set(mediaDevices);
  }

  audioInputDevices(): Readable<MediaDeviceInfo[]> {
    return derived(this.mediaDevices, devices =>
      devices.filter(device => device.kind === 'audioinput')
    );
  }

  videoInputDevices(): Readable<MediaDeviceInfo[]> {
    return derived(this.mediaDevices, devices =>
      devices.filter(device => device.kind === 'videoinput')
    );
  }

  audioOutputDevices(): Readable<MediaDeviceInfo[]> {
    return derived(this.mediaDevices, devices =>
      devices.filter(device => device.kind === 'audiooutput')
    );
  }

  _audioInputId: Writable<string | undefined> = writable(undefined); // if undefined, the default audio input source is used

  audioInputId(): Readable<string | undefined> {
    return derived(this._audioInputId, id => id);
  }

  _audioOutputId: Writable<string | undefined> = writable(undefined); // if undefined, the default audio output is used

  audioOutputId(): Readable<string | undefined> {
    return derived(this._audioOutputId, id => id);
  }

  _videoInputId: Writable<string | undefined> = writable(undefined); // if undefined, the default video input source is used

  videoInputId(): Readable<string | undefined> {
    return derived(this._videoInputId, id => id);
  }

  // ===========================================================================================
  // WEBRTC STREAMS
  // ===========================================================================================

  /**
   * Our own video/audio stream
   */
  mainStream: MediaStream | undefined | null;

  /**
   * Our own screen share stream
   */
  screenShareStream: MediaStream | undefined | null;

  /**
   * Streams of others
   */
  _videoStreams: Record<AgentPubKeyB64, MediaStream> = {};

  /**
   * Screen share streams of others
   */
  _screenShareStreams: Record<AgentPubKeyB64, MediaStream> = {};

  // ********************************************************************************************
  //
  //   W R I T A B L E   S T O R E S
  //
  // ********************************************************************************************

  // ===========================================================================================
  // ACTIVE CONNECTIONS
  // ===========================================================================================

  /**
   * Connections where we have an active WebRTC connection.
   * For video connections, derived from ConnectionManager state.
   */
  _openConnections: Writable<Record<AgentPubKeyB64, OpenConnectionInfo>> =
    writable({});

  /**
   * Connections where we are sharing our own screen and the Init/Accept handshake succeeded
   */
  _screenShareConnectionsOutgoing: Writable<
    Record<AgentPubKeyB64, OpenConnectionInfo>
  > = writable({});

  /**
   * Connections where others are sharing their screen and the Init/Accept handshake succeeded
   */
  _screenShareConnectionsIncoming: Writable<
    Record<AgentPubKeyB64, OpenConnectionInfo>
  > = writable({});

  // ===========================================================================================
  // CONNECTION META DATA
  // ===========================================================================================

  /**
   * Agents in the room that we know exist either because we saw their public key
   * linked from the ALL_AGENTS anchor ourselves or because we learnt via remote
   * signals from other peers that their public key is linked from the ALL_AGENTS
   * anchor (in case this hasn't gossiped to us yet).
   */
  _knownAgents: Writable<Record<AgentPubKeyB64, AgentInfo>> = writable({});

  /**
   * The statuses of WebRTC main stream connections to peers
   */
  _connectionStatuses: Writable<ConnectionStatuses> = writable({});

  /**
   * The statuses of WebRTC connections with peers to our own screen share
   * stream
   */
  _screenShareConnectionStatuses: Writable<ConnectionStatuses> = writable({});

  /**
   * Connection statuses of other peers from their perspective. Is sent to us
   * via remote signals (as part of pingAgents())
   */
  _othersConnectionStatuses: Writable<
    Record<
      AgentPubKeyB64,
      {
        lastUpdated: number;
        statuses: ConnectionStatuses;
        /**
         * Connection statuses to their screen share in case their sharing screen
         */
        screenShareStatuses?: ConnectionStatuses;
        knownAgents?: Record<AgentPubKeyB64, AgentInfo>;
        /**
         * How they perceive our stream
         */
        perceivedStreamInfo?: StreamAndTrackInfo;
      }
    >
  > = writable({});

  /**
   * Diagnostic logs received from remote peers via Holochain signals
   */
  _receivedDiagnosticLogs: Writable<Record<AgentPubKeyB64, import('./types').DiagnosticSnapshot>> = writable({});

  /**
   * Tracks pending diagnostic requests (for UI timeout display)
   */
  _pendingDiagnosticRequests: Set<AgentPubKeyB64> = new Set();

  // ===========================================================================================
  // SHARED WAL
  // ===========================================================================================

  /**
   * WAL that we are currently sharing (null if not sharing)
   */
  _mySharedWal: Writable<SharedWalPayload | null> = writable(null);

  /**
   * WALs that peers are currently sharing, keyed by AgentPubKeyB64
   */
  _peerSharedWals: Writable<Record<AgentPubKeyB64, SharedWalPayload>> = writable({});

  // ********************************************************************************************
  //
  //   T R A C K   R E A D I N E S S
  //
  // ********************************************************************************************

  /**
   * Marks a received track as ready — sets the audio/video flag on the connection
   * and fires the appropriate event callback. Called either immediately when a track
   * arrives unmuted, or later via onunmute/timeout for initially-muted tracks.
   */
  private _setTrackReady(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    track: MediaStreamTrack
  ) {
    this._openConnections.update(currentValue => {
      const openConnections = currentValue;
      const relevantConnection = openConnections[pubKeyB64];
      if (!relevantConnection) return openConnections;
      if (track.kind === 'audio') {
        relevantConnection.audio = true;
      }
      if (track.kind === 'video') {
        relevantConnection.video = true;
        relevantConnection.videoMuted = false;
      }
      openConnections[pubKeyB64] = relevantConnection;
      return openConnections;
    });
    if (track.kind === 'audio') {
      this.eventCallback({
        type: 'peer-audio-on',
        pubKeyB64,
        connectionId,
      });
    }
    if (track.kind === 'video') {
      // Re-fire peer-stream so the video element gets srcObject assigned
      // after it becomes visible. The initial peer-stream may have set srcObject
      // while the element had display:none (track arrived muted), and some browsers
      // don't start decoding until the element is visible.
      const stream = this._videoStreams[pubKeyB64];
      if (stream) {
        this.eventCallback({
          type: 'peer-stream',
          pubKeyB64,
          connectionId,
          stream,
        });
      }
      this.eventCallback({
        type: 'peer-video-on',
        pubKeyB64,
        connectionId,
      });
    }
  }

  // ********************************************************************************************
  //
  //   H E L P E R   M E T H O D S
  //
  // ********************************************************************************************

  /**
   * Send an immediate PongUi to all known agents. Used when connection status
   * changes to Connected so other peers see green rings right away.
   */
  private async _sendImmediatePongToAll() {
    const knownAgents = get(this._knownAgents);
    const agentsToPong = Object.keys(knownAgents)
      .filter(agent => agent !== this.myPubKeyB64 && !get(this.blockedAgents).includes(agent));

    for (const agentB64 of agentsToPong) {
      const streamInfo = getStreamInfo(this._videoStreams[agentB64]);
      const metaData: PongMetaData<PongMetaDataV1> = {
        formatVersion: 1,
        data: {
          connectionStatuses: get(this._connectionStatuses),
          screenShareConnectionStatuses: this.screenShareStream
            ? get(this._screenShareConnectionStatuses)
            : undefined,
          knownAgents: get(this._knownAgents),
          appVersion: __APP_VERSION__,
          streamInfo,
          audio: get(this._openConnections)[agentB64]?.audio,
          sharedWal: get(this._mySharedWal) ?? undefined,
        },
      };
      try {
        await this.roomClient.sendMessage(
          [decodeHashFromBase64(agentB64)],
          'PongUi',
          JSON.stringify(metaData),
        );
      } catch (e) {
        // Best-effort; don't block on failure
      }
    }
  }

  /**
   * Public method for manual track recovery. Sends a request-track-refresh
   * message via the data channel asking the peer to re-send their tracks.
   */
  /**
   * Force-refresh media tracks for a peer without tearing down the connection.
   * Replaces tracks on existing senders, triggering re-encoding while preserving
   * the ICE/DTLS session. Lighter than full reconnect.
   */
  refreshTracksForPeer(pubKeyB64: AgentPubKeyB64) {
    if (!this.mainStream) {
      console.warn(`Cannot refresh tracks for ${pubKeyB64.slice(0, 8)}: no stream`);
      return;
    }

    const fsm = this.connectionManager.getFSM(pubKeyB64);
    if (!fsm) {
      console.warn(`Cannot refresh tracks for ${pubKeyB64.slice(0, 8)}: no FSM`);
      return;
    }

    const myAudioTrack = this.mainStream.getAudioTracks()[0];
    const myVideoTrack = this.mainStream.getVideoTracks()[0];

    this.logger.logCustomMessage(
      `Track refresh [${pubKeyB64.slice(0, 8)}]: audio=${myAudioTrack ? `${myAudioTrack.enabled ? 'enabled' : 'disabled'},${myAudioTrack.muted ? 'muted' : 'unmuted'},${myAudioTrack.readyState}` : 'none'} video=${myVideoTrack ? `${myVideoTrack.enabled ? 'enabled' : 'disabled'},${myVideoTrack.muted ? 'muted' : 'unmuted'},${myVideoTrack.readyState}` : 'none'}`
    );

    fsm.refreshMedia(this.mainStream);
    this.logger.logCustomMessage(
      `Media refresh [${pubKeyB64.slice(0, 8)}]: replaced tracks on existing senders`
    );
  }

  /**
   * Request diagnostic logs from a specific peer (or all known agents) via Holochain signal.
   */
  async requestDiagnosticLogs(pubKeyB64?: AgentPubKeyB64) {
    const targets = pubKeyB64
      ? [decodeHashFromBase64(pubKeyB64)]
      : Object.keys(get(this._knownAgents))
          .filter(a => a !== this.myPubKeyB64)
          .map(b64 => decodeHashFromBase64(b64));

    if (targets.length === 0) return;

    const targetKeys = pubKeyB64
      ? [pubKeyB64]
      : Object.keys(get(this._knownAgents)).filter(a => a !== this.myPubKeyB64);
    targetKeys.forEach(k => this._pendingDiagnosticRequests.add(k));

    await this.roomClient.sendMessage(targets, 'DiagnosticRequest', '');
    this.logger.logCustomMessage(
      `Requested diagnostic logs from ${targetKeys.map(k => k.slice(0, 8)).join(', ')}`
    );

    // Timeout: clear pending state after 10s if no response
    setTimeout(() => {
      targetKeys.forEach(k => this._pendingDiagnosticRequests.delete(k));
    }, 10_000);
  }

  /**
   * Build a merged diagnostic log combining local and received remote events for a peer.
   */
  exportMergedLogs(pubKeyB64: AgentPubKeyB64): object {
    const localAgentEvents = this.logger.getRecentAgentEvents();
    const localCustomLogs = this.logger.getRecentCustomLogs();
    const remoteSnapshot = get(this._receivedDiagnosticLogs)[pubKeyB64];

    type MergedEntry = { timestamp: number; source: 'local' | 'remote'; type: string; detail: string; connectionId?: string };
    const merged: MergedEntry[] = [];

    // Add local agent events (all agents, to see the full picture)
    Object.entries(localAgentEvents).forEach(([agent, events]) => {
      events.forEach(e => {
        merged.push({
          timestamp: e.timestamp,
          source: 'local',
          type: 'event',
          detail: `[${agent.slice(0, 8)}] ${e.event}`,
          connectionId: e.connectionId,
        });
      });
    });

    // Add local custom logs
    localCustomLogs.forEach(log => {
      merged.push({
        timestamp: log.timestamp,
        source: 'local',
        type: 'custom',
        detail: log.log,
      });
    });

    // Add remote events if available
    if (remoteSnapshot) {
      Object.entries(
        remoteSnapshot.agentEvents.reduce((acc, e) => {
          (acc[e.agent] = acc[e.agent] || []).push(e);
          return acc;
        }, {} as Record<string, typeof remoteSnapshot.agentEvents>)
      ).forEach(([agent, events]) => {
        events.forEach(e => {
          merged.push({
            timestamp: e.timestamp,
            source: 'remote',
            type: 'event',
            detail: `[${agent.slice(0, 8)}] ${e.event}`,
            connectionId: e.connectionId,
          });
        });
      });

      remoteSnapshot.customLogs.forEach(log => {
        merged.push({
          timestamp: log.timestamp,
          source: 'remote',
          type: 'custom',
          detail: log.log,
        });
      });
    }

    merged.sort((a, b) => a.timestamp - b.timestamp);

    return {
      generatedAt: Date.now(),
      localAgent: this.myPubKeyB64,
      remoteAgent: pubKeyB64,
      hasRemoteLogs: !!remoteSnapshot,
      remoteSessionId: remoteSnapshot?.sessionId,
      entries: merged,
    };
  }

  // ********************************************************************************************
  //
  //   S I G N A L   H A N D L E R S
  //
  // ********************************************************************************************

  async handleSignal(signal: RoomSignal) {
    this._signalQueue.push(signal);
    if (this._processingSignal) return;

    this._processingSignal = true;
    while (this._signalQueue.length > 0) {
      const nextSignal = this._signalQueue.shift()!;
      if (this.signalDelayMs > 0) {
        const delay = Math.floor(Math.random() * this.signalDelayMs);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      await this._processSignal(nextSignal);
    }
    this._processingSignal = false;
  }

  private async _processSignal(signal: RoomSignal) {
    switch (signal.type) {
      case 'Message': {
        switch (signal.msg_type) {
          case 'PingUi':
            await this.handlePingUi(signal);
            break;
          case 'PongUi':
            await this.handlePongUi(signal);
            break;
          case 'Sdp':
          case 'ScreenSdp': {
            // Don't create new connections to agents whose pongs have gone stale.
            // Accepts signals from unknown agents (lastSeen undefined — genuinely new)
            // and from agents with recent pongs. Rejects signals from agents we know
            // about but who stopped responding — these are stale signals from dead peers.
            const senderB64 = encodeHashToBase64(signal.from_agent);
            const senderInfo = get(this._knownAgents)[senderB64];
            const PONG_TIMEOUT_MS = 10_000;
            if (senderInfo?.lastSeen && (Date.now() - senderInfo.lastSeen) > PONG_TIMEOUT_MS) {
              const hasActiveFsm = signal.msg_type === 'Sdp'
                ? this.connectionManager.getState(senderB64)
                : this.screenShareConnectionManager.getState(senderB64);
              // Only block if there's no active FSM — if there IS one, let the FSM's
              // own signal validation handle it
              if (!hasActiveFsm || hasActiveFsm === 'closed') {
                this.logger.logCustomMessage(
                  `Dropped SDP signal from stale agent ${senderB64.slice(5, 13)}: last pong ${Date.now() - senderInfo.lastSeen}ms ago`
                );
                break;
              }
            }
            if (signal.msg_type === 'Sdp') {
              this._signalingAdapter.dispatchSignal(signal.from_agent, signal.payload);
            } else {
              this._screenShareSignalingAdapter.dispatchSignal(signal.from_agent, signal.payload);
            }
            break;
          }
          case 'LeaveUi':
            await this.handleLeaveUi(signal);
            break;
          case 'DiagnosticRequest':
            await this.handleDiagnosticRequest(signal);
            break;
          case 'DiagnosticResponse':
            this.handleDiagnosticResponse(signal);
            break;
          case 'ShareWal':
            this.handleShareWal(signal);
            break;
          case 'StopShareWal':
            this.handleStopShareWal(signal);
            break;
          default:
            console.warn('Unknown msg_type:', signal.msg_type);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * If we get a PingUI we respond with a PongUI containing metadata
   *
   * @param signal
   */
  async handlePingUi(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    if (get(this.blockedAgents).includes(pubkeyB64)) return;
    // console.log(`Got PingUi from ${pubkeyB64}: `, signal);

    const streamInfo = getStreamInfo(this._videoStreams[pubkeyB64]);

    if (pubkeyB64 !== this.myPubKeyB64) {
      const metaData: PongMetaData<PongMetaDataV1> = {
        formatVersion: 1,
        data: {
          connectionStatuses: get(this._connectionStatuses),
          screenShareConnectionStatuses: this.screenShareStream
            ? get(this._screenShareConnectionStatuses)
            : undefined,
          knownAgents: get(this._knownAgents),
          appVersion: __APP_VERSION__,
          streamInfo,
          audio: get(this._openConnections)[pubkeyB64]?.audio,
          sharedWal: get(this._mySharedWal) ?? undefined,
        },
      };
      await this.roomClient.sendMessage(
        [signal.from_agent],
        'PongUi',
        JSON.stringify(metaData),
      );

      // Show the peer tile immediately so the UI reflects their presence
      // before the pong round-trip completes and ensureConnection is called.
      // This does NOT start the WebRTC connection — just adds a UI placeholder.
      if (!get(this.blockedAgents).includes(pubkeyB64)) {
        this._openConnections.update(conns => {
          if (!conns[pubkeyB64]) {
            conns[pubkeyB64] = {
              connectionId: '',
              video: false,
              audio: false,
              connected: false,
              direction: 'duplex',
            };
          }
          return conns;
        });
      }

      // If we have an active screen share, ensure a screen share connection to this peer
      if (this.screenShareStream) {
        this.screenShareConnectionManager.ensureConnection(pubkeyB64);
      }
    }
  }

  /**
   * Handle a LeaveUi signal — the remote peer is leaving the room.
   * Immediately tear down all connections and pending state for this agent.
   */
  async handleLeaveUi(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    this.logger.logAgentEvent({
      agent: pubkeyB64,
      timestamp: Date.now(),
      event: 'PeerLeave',
    });

    // Close video connection via ConnectionManager
    this.connectionManager.closeConnection(pubkeyB64, 'peer left');

    // Close screen share connection via screen share ConnectionManager
    this.screenShareConnectionManager.closeConnection(pubkeyB64, 'peer left');

    // Clean up video streams
    delete this._videoStreams[pubkeyB64];

    // Mark as disconnected
    this._connectionStatuses.update(v => {
      v[pubkeyB64] = { type: 'Disconnected' };
      return v;
    });
    this._rebuildScreenShareConnectionStatuses();

    // Clean up any active WAL share from this peer
    this._peerSharedWals.update(v => { delete v[pubkeyB64]; return v; });

    // Fire event so UI updates
    this.eventCallback({ type: 'peer-disconnected', pubKeyB64: pubkeyB64, connectionId: '' });
  }

  /**
   * If we get a PongUI we do the following:
   *
   * - Update our stored metadata for this agent
   * - Ensure a video connection via ConnectionManager if necessary
   * - Send a screen share InitRequest if necessary
   * - Check whether the stream that they see of us matches what we
   *   expect and if not, try to reconcile
   *
   * @param signal
   */
  async handlePongUi(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    const now = Date.now();
    // Pong timing is captured via agentPongMetadataLogs (with deduplication).
    // No need for a per-pong SimpleEvent entry — it just adds noise.
    // Update their connection statuses and the list of known agents
    let metaDataExt: PongMetaData<PongMetaDataV1> | undefined;
    try {
      const metaData: PongMetaData<PongMetaDataV1> = JSON.parse(
        signal.payload
      );
      this.logger.logAgentPongMetaData(pubkeyB64, metaData.data);
      metaDataExt = metaData;
      this._othersConnectionStatuses.update(statuses => {
        const newStatuses = statuses;
        newStatuses[pubkeyB64] = {
          lastUpdated: now,
          statuses: metaData.data.connectionStatuses,
          screenShareStatuses: metaData.data.screenShareConnectionStatuses,
          knownAgents: metaData.data.knownAgents,
          perceivedStreamInfo: metaData.data.streamInfo,
        };
        return statuses;
      });

      // Update known agents based on the agents that they know
      this._knownAgents.update(store => {
        const knownAgents = store;
        const maybeKnownAgent = knownAgents[pubkeyB64];
        if (maybeKnownAgent) {
          maybeKnownAgent.appVersion = metaData.data.appVersion;
          maybeKnownAgent.lastSeen = Date.now();
        } else {
          knownAgents[pubkeyB64] = {
            pubkey: pubkeyB64,
            type: 'told',
            lastSeen: Date.now(),
            appVersion: metaData.data.appVersion,
          };
        }
        if (metaData.data.knownAgents) {
          Object.entries(metaData.data.knownAgents).forEach(
            ([agentB64, agentInfo]) => {
              if (!knownAgents[agentB64] && agentB64 !== this.myPubKeyB64) {
                knownAgents[agentB64] = {
                  pubkey: agentB64,
                  type: 'told',
                  lastSeen: undefined, // We did not receive a Pong from them directly
                  appVersion: agentInfo.appVersion,
                };
              }
            }
          );
        }
        return knownAgents;
      });
      // Handle shared WAL propagation for late-joiners
      if (metaData.data.sharedWal) {
        const currentPeerWals = get(this._peerSharedWals);
        if (!currentPeerWals[pubkeyB64] || currentPeerWals[pubkeyB64].weaveUrl !== metaData.data.sharedWal.weaveUrl) {
          this._peerSharedWals.update(v => {
            v[pubkeyB64] = metaData.data.sharedWal!;
            return v;
          });
          this.eventCallback({
            type: 'peer-share-wal',
            pubKeyB64: pubkeyB64,
            payload: metaData.data.sharedWal,
          });
        }
      } else {
        // Peer stopped sharing — clean up if we had them tracked
        if (get(this._peerSharedWals)[pubkeyB64]) {
          this._peerSharedWals.update(v => { delete v[pubkeyB64]; return v; });
          this.eventCallback({
            type: 'peer-stop-share-wal',
            pubKeyB64: pubkeyB64,
          });
        }
      }
    } catch (e) {
      console.warn('Failed to parse pong meta data.');
    }

    /**
     * Normal video/audio stream — use ConnectionManager
     *
     * If there is no connection yet with this agent and the agent is not
     * blocked, ask ConnectionManager to ensure a connection. Perfect Negotiation
     * handles role assignment (polite/impolite) — no alphabetical pubkey
     * comparison needed.
     */
    const isBlocked = get(this.blockedAgents).includes(pubkeyB64);
    const alreadyOpen = this.connectionManager.getState(pubkeyB64);
    const hasActiveConnection = alreadyOpen && alreadyOpen !== 'closed' && alreadyOpen !== 'failed' && alreadyOpen !== 'idle' && alreadyOpen !== 'disconnected';

    if (!hasActiveConnection && !isBlocked) {
      this.connectionManager.ensureConnection(pubkeyB64);
    }

    // Check whether they have the right expectation of our audio state and if not,
    // send an audio-off signal
    if (hasActiveConnection && alreadyOpen === 'connected' && metaDataExt?.data.audio) {
      if (!this.mainStream?.getAudioTracks()[0]?.enabled) {
        const fsm = this.connectionManager.getFSM(pubkeyB64);
        if (fsm) {
          const msg: RTCMessage = {
            type: 'action',
            message: 'audio-off',
          };
          try {
            fsm.send(JSON.stringify(msg));
          } catch (e: any) {
            console.error(
              'Failed to send audio-off message to peer: ',
              e.toString()
            );
          }
        }
      }
    }

    // If we have an active screen share, ensure a screen share connection to this peer
    if (this.screenShareStream) {
      this.screenShareConnectionManager.ensureConnection(pubkeyB64);
    }
  }

  /**
   * Handle a DiagnosticRequest signal — gather recent logs and send back.
   */
  async handleDiagnosticRequest(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const allRecentEvents = this.logger.getRecentAgentEvents();
    const flatEvents = Object.values(allRecentEvents).flat();
    const recentCustomLogs = this.logger.getRecentCustomLogs();

    const snapshot: DiagnosticSnapshot = {
      fromAgent: this.myPubKeyB64,
      sessionId: this.logger.sessionId,
      agentEvents: flatEvents,
      customLogs: recentCustomLogs,
      generatedAt: Date.now(),
    };

    const payload = JSON.stringify(snapshot);
    // Guard against signal size limits — truncate if too large
    if (payload.length > 60_000) {
      const truncated: DiagnosticSnapshot = {
        ...snapshot,
        agentEvents: flatEvents.slice(-200),
        customLogs: recentCustomLogs.slice(-100),
      };
      await this.roomClient.sendMessage(
        [signal.from_agent],
        'DiagnosticResponse',
        JSON.stringify(truncated),
      );
    } else {
      await this.roomClient.sendMessage(
        [signal.from_agent],
        'DiagnosticResponse',
        payload,
      );
    }
  }

  /**
   * Handle a DiagnosticResponse signal — store the received logs.
   */
  handleDiagnosticResponse(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    try {
      const snapshot: DiagnosticSnapshot = JSON.parse(signal.payload);
      this._receivedDiagnosticLogs.update(current => {
        current[pubkeyB64] = snapshot;
        return current;
      });
      this._pendingDiagnosticRequests.delete(pubkeyB64);
      this.logger.logCustomMessage(
        `Received diagnostic logs from [${pubkeyB64.slice(0, 8)}]: ${snapshot.agentEvents.length} events, ${snapshot.customLogs.length} custom logs`
      );
    } catch (e) {
      console.warn('Failed to parse DiagnosticResponse:', e);
    }
  }

  // ===========================================================================================
  // SHARE WAL SIGNAL HANDLERS
  // ===========================================================================================

  handleShareWal(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    try {
      const payload: SharedWalPayload = JSON.parse(signal.payload);
      this._peerSharedWals.update(current => {
        current[pubkeyB64] = payload;
        return current;
      });
      this.eventCallback({
        type: 'peer-share-wal',
        pubKeyB64: pubkeyB64,
        payload,
      });
    } catch (e) {
      console.warn('Failed to parse ShareWal payload:', e);
    }
  }

  handleStopShareWal(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    this._peerSharedWals.update(current => {
      delete current[pubkeyB64];
      return current;
    });
    this.eventCallback({
      type: 'peer-stop-share-wal',
      pubKeyB64: pubkeyB64,
    });
  }
}
