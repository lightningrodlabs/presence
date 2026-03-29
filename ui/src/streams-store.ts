import SimplePeer from 'simple-peer';
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
import { v4 as uuidv4 } from 'uuid';
import {
  AgentInfo,
  ConnectionStatus,
  ConnectionStatuses,
  DiagnosticSnapshot,
  InitPayload,
  OpenConnectionInfo,
  PendingAccept,
  PendingInit,
  PongMetaData,
  PongMetaDataV1,
  RoomSignal,
  RTCMessage,
  SdpPayload,
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

/**
 * If an InitRequest does not succeed within this duration (ms) another InitRequest will be sent.
 * (Only used for screen share connections which still use the old SimplePeer protocol.)
 */
const INIT_RETRY_THRESHOLD = 5000;

export const PING_INTERVAL = 2000;

/**
 * A store that handles the creation and management of WebRTC streams with
 * holochain peers
 */
export class StreamsStore {
  private roomClient: RoomClient;

  private myPubKeyB64: AgentPubKeyB64;

  private signalUnsubscribe: () => void;

  private pingInterval: number | undefined;

  private roomStore: RoomStore;

  private allAgents: AgentPubKey[] = [];

  private screenSourceSelection: () => Promise<string>;

  private eventCallback: (ev: StoreEventPayload) => any = () => undefined;

  logger: PresenceLogger;

  trickleICE = true;

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

  // ---------------------------------------------------------------------------
  // ConnectionManager (replaces SimplePeer for video/audio connections)
  // ---------------------------------------------------------------------------

  connectionManager!: ConnectionManager;

  private _signalingAdapter!: HolochainSignalingAdapter;

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

    // Initialize ConnectionManager
    this._signalingAdapter = new HolochainSignalingAdapter(this.roomClient);
    this.connectionManager = new ConnectionManager({
      myAgentId: this.myPubKeyB64,
      signaling: this._signalingAdapter,
      config: {
        iceServers: this.iceConfig,
        trickleICE: this.trickleICE,
        connectionTimeoutMs: 15_000,
        sdpExchangeTimeoutMs: 15_000,
        role: 'mesh',
      },
      onTransition: (entry) => {
        this.logger.logCustomMessage(
          `FSM [${entry.remoteAgent.slice(0, 8)}]: ${entry.fromState} → ${entry.toState} (${entry.trigger})`
        );
      },
    });
    this._setupConnectionManagerEvents();

    // TODO potentially move this to a connect() method which also returns
    // the Unsubscribe function
    this.signalUnsubscribe = this.roomClient.onSignal(async signal =>
      this.handleSignal(signal)
    );
    const blockedAgentsJson = window.sessionStorage.getItem('blockedAgents');
    this.blockedAgents.set(
      blockedAgentsJson ? JSON.parse(blockedAgentsJson) : []
    );
    const trickleICE = window.localStorage.getItem('trickleICE');
    if (trickleICE) {
      this.trickleICE = JSON.parse(trickleICE);
    }
    this.turnUrl = window.localStorage.getItem('turnUrl') || '';
    this.turnUsername = window.localStorage.getItem('turnUsername') || '';
    this.turnCredential = window.localStorage.getItem('turnCredential') || '';
    const signalDelay = window.localStorage.getItem('signalDelayMs');
    if (signalDelay) {
      this.signalDelayMs = parseInt(signalDelay, 10) || 0;
    }
    navigator.mediaDevices.ondevicechange = e => {
      console.log('Got devide change: ', e);
    };
  }

  /**
   * Wire ConnectionManager events to StreamsStore behavior.
   * Replaces the old SimplePeer event handlers (peer.on('stream'), peer.on('track'), etc.)
   */
  private _setupConnectionManagerEvents() {
    // Handle remote stream arrival
    this.connectionManager.on('remote-stream', (event) => {
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
      console.log(
        '#### GOT STREAM with tracks from:',
        pubKeyB64,
        stream.getTracks()
      );

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
    });

    // Handle remote track arrival
    this.connectionManager.on('remote-track', (event) => {
      const pubKeyB64 = event.remoteAgent;
      const connectionId = event.connectionId;
      const { track } = event.data;

      console.log('#### GOT TRACK from:', pubKeyB64, track, 'muted:', track.muted);
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'RemoteTrack',
        connectionId,
      });

      if (!track.muted) {
        this._setTrackReady(pubKeyB64, connectionId, track);
      } else {
        console.log(`#### TRACK from ${pubKeyB64.slice(0, 8)} arrived muted (${track.kind}), waiting for unmute...`);
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
          if (track.muted) {
            console.warn(`#### TRACK from ${pubKeyB64.slice(0, 8)} (${track.kind}) still muted after 5s timeout`);
            this.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: Date.now(),
              event: 'TrackUnmuteTimeout',
            });
            this._setTrackReady(pubKeyB64, connectionId, track);
          }
        }, 5000);

        track.onunmute = () => {
          clearTimeout(unmuteTimeout);
          console.log(`#### TRACK from ${pubKeyB64.slice(0, 8)} (${track.kind}) unmuted!`);
          this.logger.logAgentEvent({
            agent: pubKeyB64,
            timestamp: Date.now(),
            event: 'TrackUnmuted',
          });
          this._setTrackReady(pubKeyB64, connectionId, track);
        };
      }
    });

    // Handle data channel messages
    this.connectionManager.on('data-channel-message', (event) => {
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
            console.log(`#### GOT request-track-refresh from ${pubKeyB64.slice(0, 8)}`);
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
    });

    // Handle connection state changes
    this.connectionManager.on('connection-state-changed', (event) => {
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
        console.log('#### CONNECTED with', pubKeyB64);

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

        this.eventCallback({
          type: 'peer-connected',
          pubKeyB64,
          connectionId,
        });

        // Send immediate pong so peers see green rings
        this._sendImmediatePongToAll();
      } else if (toState === 'disconnected' || toState === 'closed' || toState === 'failed') {
        console.log(`#### CONNECTION ${toState.toUpperCase()} with ${pubKeyB64.slice(0, 8)}`);

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

        // Also tear down any outgoing screen share to this peer
        const outgoingScreenShare = get(this._screenShareConnectionsOutgoing)[pubKeyB64];
        if (outgoingScreenShare) {
          console.log(`#### TEARING DOWN OUTGOING SCREEN SHARE TO ${pubKeyB64.slice(0, 8)} (video peer closed)`);
          outgoingScreenShare.peer.destroy();
          this._screenShareConnectionsOutgoing.update(currentValue => {
            delete currentValue[pubKeyB64];
            return currentValue;
          });
          delete this._pendingScreenShareInits[pubKeyB64];
        }

        this._rebuildConnectionStatuses();
        this.eventCallback({
          type: 'peer-disconnected',
          pubKeyB64,
          connectionId,
        });
      } else {
        // For signaling, connecting, reconnecting — just rebuild statuses
        this._rebuildConnectionStatuses();
      }
    });
  }

  /**
   * Rebuild _openConnections from ConnectionManager state.
   * The `peer` field is set to `null as any` since UI components use
   * StreamsStore methods rather than calling SimplePeer directly.
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
        newOpenConnections[agent] = {
          connectionId: fsm?.connectionId ?? '',
          peer: null as any,
          video: existing?.video ?? false,
          audio: existing?.audio ?? false,
          connected: state === 'connected',
          relayed: vm?.quality?.relayed ?? existing?.relayed,
          videoMuted: existing?.videoMuted,
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
      case 'reconnecting':
        return { type: 'SdpExchange' };
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
    await new Promise<void>((resolve) => {
      roomStore.allAgents.subscribe(val => {
        if (val.status === 'complete') {
          streamsStore.allAgents = val.value;
          resolve();
        } else if (val.status === 'error') {
          console.error('Failed to get all agents: ', val.error);
          resolve(); // Don't block forever on error
        }
      });
    });

    // Keep subscribing for ongoing updates
    roomStore.allAgents.subscribe(val => {
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

    // Destroy ConnectionManager (handles all video/audio connections)
    this.connectionManager.destroy();

    // Close screen share connections (still using SimplePeer)
    Object.values(get(this._screenShareConnectionsIncoming)).forEach(conn => {
      conn.peer.destroy();
    });
    Object.values(get(this._screenShareConnectionsOutgoing)).forEach(conn => {
      conn.peer.destroy();
    });

    this.videoOff();
    this.audioOff();
    this.screenShareOff();
    this.mainStream = null;
    this.screenShareStream = null;
    this._openConnections.set({});
    this._screenShareConnectionsOutgoing.set({});
    this._screenShareConnectionsIncoming.set({});
    this._pendingScreenShareInits = {};
    this._pendingScreenShareAccepts = {};
  }

  enableTrickleICE() {
    window.localStorage.setItem('trickleICE', 'true');
    this.trickleICE = true;
  }

  disableTrickleICE() {
    window.localStorage.setItem('trickleICE', 'false');
    this.trickleICE = false;
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
  }

  setTurnUsername(username: string) {
    this.turnUsername = username;
    window.localStorage.setItem('turnUsername', username);
  }

  setTurnCredential(credential: string) {
    this.turnCredential = credential;
    window.localStorage.setItem('turnCredential', credential);
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

    // Log our stream state
    this.logger.logMyStreamInfo(getStreamInfo(this.mainStream));

    // Cleanup stale pending screen share accepts older than 20 seconds
    const now = Date.now();
    const PENDING_ACCEPT_TTL = 20000;
    for (const [agent, accepts] of Object.entries(
      this._pendingScreenShareAccepts
    )) {
      const stale = accepts.filter(a => now - a.createdAt > PENDING_ACCEPT_TTL);
      if (stale.length > 0) {
        stale.forEach(a => a.peer.destroy());
        const remaining = accepts.filter(
          a => now - a.createdAt <= PENDING_ACCEPT_TTL
        );
        if (remaining.length > 0) {
          this._pendingScreenShareAccepts[agent] = remaining;
        } else {
          delete this._pendingScreenShareAccepts[agent];
        }
      }
    }
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
        console.log('### CASE A');
        this.mainStream.getVideoTracks()[0].enabled = true;
        this.eventCallback({
          type: 'my-video-on',
        });
      } else {
        console.log('### CASE B');
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
        this.eventCallback({
          type: 'my-audio-on',
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
    console.log('### AUDIO OFF');
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'MyAudioOff',
    });
    console.log('this._mainStream.getTracks(): ', this.mainStream?.getTracks());
    if (this.mainStream) {
      console.log('### DISABLING ALL AUDIO TRACKS');
      this.mainStream.getAudioTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = false;
        console.log('### DISABLED AUDIO TRACK: ', track);
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
      // If there's an error here it's potentially possible that 'my-screen-share-on' further
      // down never gets emitted.
      Object.values(get(this._screenShareConnectionsOutgoing)).forEach(conn => {
        if (this.screenShareStream) {
          conn.peer.addStream(this.screenShareStream);
        }
      });
    }
    this.eventCallback({
      type: 'my-screen-share-on',
    });
  }

  /**
   * Turning screen sharing off is equivalent to closing the corresponding peer connection
   */
  screenShareOff() {
    if (this.screenShareStream) {
      this.screenShareStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.stop();
      });
      Object.values(get(this._screenShareConnectionsOutgoing)).forEach(conn => {
        conn.peer.destroy();
      });
      this.screenShareStream = null;
      this.eventCallback({
        type: 'my-screen-share-off',
      });
    }
  }

  disconnectFromPeerVideo(pubKeyB64: AgentPubKeyB64) {
    this.connectionManager.closeConnection(pubKeyB64, 'manual disconnect');
  }

  disconnectFromPeerScreen(pubKeyB64: AgentPubKeyB64) {
    const relevantConnection = get(this._screenShareConnectionsIncoming)[
      pubKeyB64
    ];
    if (relevantConnection) relevantConnection.peer.destroy();
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

  // ===========================================================================================
  // CONNECTION ESTABLISHMENT (Screen share only — video uses ConnectionManager)
  // ===========================================================================================

  /**
   * Pending Init requests for screen sharing
   */
  _pendingScreenShareInits: Record<AgentPubKeyB64, PendingInit[]> = {};

  /**
   * Pending Init Accepts for screen sharing
   */
  _pendingScreenShareAccepts: Record<AgentPubKeyB64, PendingAccept[]> = {};

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
      this.eventCallback({
        type: 'peer-video-on',
        pubKeyB64,
        connectionId,
      });
    }
  }

  // ********************************************************************************************
  //
  //   S C R E E N   S H A R E   P E E R   ( S T I L L   U S I N G   S I M P L E P E E R )
  //
  // ********************************************************************************************

  createScreenSharePeer(
    connectingAgent: AgentPubKey,
    connectionId: string,
    initiator: boolean
  ): SimplePeer.Instance {
    const pubKeyB64 = encodeHashToBase64(connectingAgent);
    const options: SimplePeer.Options = {
      initiator,
      config: { iceServers: this.iceConfig },
      objectMode: true,
      trickle: this.trickleICE,
    };
    const peer = new SimplePeer(options);
    peer.on('signal', async data => {
      this.roomStore.client.sendMessage(
        [connectingAgent],
        'SdpData',
        JSON.stringify({ connection_id: connectionId, data: JSON.stringify(data) }),
      );
    });
    peer.on('stream', stream => {
      console.log(
        '#### GOT SCREEN SHARE STREAM. With tracks: ',
        stream.getTracks()
      );
      this._screenShareConnectionsIncoming.update(currentValue => {
        const screenShareConnections = currentValue;
        const relevantConnection = screenShareConnections[pubKeyB64];
        if (relevantConnection) {
          if (stream.getAudioTracks().length > 0) {
            relevantConnection.audio = true;
          }
          if (stream.getVideoTracks().length > 0) {
            relevantConnection.video = true;
          }
          screenShareConnections[pubKeyB64] = relevantConnection;
        }
        return screenShareConnections;
      });

      this.eventCallback({
        type: 'peer-screen-share-stream',
        pubKeyB64,
        connectionId,
        stream,
      });
    });
    peer.on('track', track => {
      console.log('#### GOT TRACK: ', track);
      this._screenShareConnectionsIncoming.update(currentValue => {
        const screenShareConnections = currentValue;
        const relevantConnection = screenShareConnections[pubKeyB64];
        if (track.kind === 'audio' && track.enabled) {
          relevantConnection.audio = true;
        }
        if (track.kind === 'video' && track.enabled) {
          relevantConnection.video = true;
        }
        screenShareConnections[pubKeyB64] = relevantConnection;
        return screenShareConnections;
      });
      this.eventCallback({
        type: 'peer-screen-share-track',
        pubKeyB64,
        connectionId,
        track,
      });
    });
    peer.on('connect', () => {
      console.log('#### SCREEN SHARE CONNECTED');

      const screenShareConnections = initiator
        ? get(this._screenShareConnectionsOutgoing)
        : get(this._screenShareConnectionsIncoming);

      const relevantConnection = screenShareConnections[pubKeyB64];

      relevantConnection.connected = true;

      // if we are already sharing the screen, add the relevant stream
      if (
        this.screenShareStream &&
        relevantConnection.direction === 'outgoing'
      ) {
        relevantConnection.peer.addStream(this.screenShareStream);
      }

      screenShareConnections[pubKeyB64] = relevantConnection;

      if (initiator) {
        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnections = currentValue;
          screenShareConnections[pubKeyB64] = relevantConnection;
          return screenShareConnections;
        });
      } else {
        this._screenShareConnectionsIncoming.update(currentValue => {
          const screenShareConnections = currentValue;
          screenShareConnections[pubKeyB64] = relevantConnection;
          return screenShareConnections;
        });
        this.eventCallback({
          type: 'peer-screen-share-connected',
          pubKeyB64,
          connectionId,
        });
      }

      this.updateScreenShareConnectionStatus(pubKeyB64, { type: 'Connected' });
    });
    peer.on('close', () => {
      console.log('#### GOT SCREEN SHARE CLOSE EVENT ####');

      peer.destroy();

      if (initiator) {
        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKeyB64];
          return screenShareConnections;
        });
      } else {
        this._screenShareConnectionsIncoming.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKeyB64];
          return screenShareConnections;
        });
        this.eventCallback({
          type: 'peer-screen-share-disconnected',
          pubKeyB64,
          connectionId,
        });
      }

      this.updateScreenShareConnectionStatus(pubKeyB64, {
        type: 'Disconnected',
      });
    });
    peer.on('error', e => {
      console.log('#### GOT SCREEN SHARE ERROR EVENT ####: ', e);
      this.logger.logCustomMessage(
        `ScreenSharePeerError [${pubKeyB64.slice(0, 8)}]: ${e.message || e}`
      );
      peer.destroy();

      if (initiator) {
        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKeyB64];
          return screenShareConnections;
        });
      } else {
        this._screenShareConnectionsIncoming.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKeyB64];
          return screenShareConnections;
        });
        this.eventCallback({
          type: 'peer-screen-share-disconnected',
          pubKeyB64,
          connectionId,
        });
      }

      this.updateScreenShareConnectionStatus(pubKeyB64, {
        type: 'Disconnected',
      });
    });

    return peer;
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

  updateScreenShareConnectionStatus(
    pubKey: AgentPubKeyB64,
    status: ConnectionStatus
  ) {
    this._screenShareConnectionStatuses.update(currentValue => {
      const connectionStatuses = currentValue;
      if (status.type === 'InitSent') {
        const currentStatus = connectionStatuses[pubKey];
        if (currentStatus && currentStatus.type === 'InitSent') {
          // increase number of attempts by 1
          connectionStatuses[pubKey] = {
            type: 'InitSent',
            attemptCount: currentStatus.attemptCount
              ? currentStatus.attemptCount + 1
              : 1,
          };
        } else {
          connectionStatuses[pubKey] = {
            type: 'InitSent',
            attemptCount: 1,
          };
        }
        return connectionStatuses;
      }
      if (status.type === 'AcceptSent') {
        const currentStatus = connectionStatuses[pubKey];
        if (currentStatus && currentStatus.type === 'AcceptSent') {
          // increase number of attempts by 1
          connectionStatuses[pubKey] = {
            type: 'AcceptSent',
            attemptCount: currentStatus.attemptCount
              ? currentStatus.attemptCount + 1
              : 1,
          };
        } else {
          connectionStatuses[pubKey] = {
            type: 'AcceptSent',
            attemptCount: 1,
          };
        }
        return connectionStatuses;
      }
      connectionStatuses[pubKey] = status;
      return connectionStatuses;
    });
  }

  /**
   * Public method for manual track recovery. Sends a request-track-refresh
   * message via the data channel asking the peer to re-send their tracks.
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

    // Re-add the local stream to trigger renegotiation
    try {
      fsm.addLocalStream(this.mainStream);
      this.logger.logCustomMessage(
        `Manual track refresh [${pubKeyB64.slice(0, 8)}]: re-added local stream`
      );
    } catch (e: any) {
      console.warn(`Track refresh failed for ${pubKeyB64.slice(0, 8)}: ${e.toString()}`);
    }
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
            // Route to ConnectionManager via the signaling adapter
            this._signalingAdapter.dispatchSignal(signal.from_agent, signal.payload);
            break;
          case 'InitRequest':
            // Only handle screen share InitRequests now
            await this.handleInitRequest(signal);
            break;
          case 'InitAccept':
            // Only handle screen share InitAccepts now
            await this.handleInitAccept(signal);
            break;
          case 'SdpData':
            // Only handle screen share SDP data now
            await this.handleSdpData(signal);
            break;
          case 'LeaveUi':
            await this.handleLeaveUi(signal);
            break;
          case 'DiagnosticRequest':
            await this.handleDiagnosticRequest(signal);
            break;
          case 'DiagnosticResponse':
            this.handleDiagnosticResponse(signal);
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
        },
      };
      await this.roomClient.sendMessage(
        [signal.from_agent],
        'PongUi',
        JSON.stringify(metaData),
      );

      // If we have an active screen share, check whether we need to
      // initiate a screen share connection to this peer. This handles
      // the case where a peer re-joins and pings us — we can start the
      // screen share connection immediately rather than waiting for
      // the next Pong cycle.
      if (this.screenShareStream) {
        // Clean up stale outgoing connection if WebRTC state is dead
        const outgoing = get(this._screenShareConnectionsOutgoing)[pubkeyB64];
        if (outgoing) {
          const pc = (outgoing.peer as any)._pc as RTCPeerConnection | undefined;
          const iceState = pc?.iceConnectionState;
          if (iceState === 'disconnected' || iceState === 'failed' || iceState === 'closed') {
            outgoing.peer.destroy();
            this._screenShareConnectionsOutgoing.update(v => {
              delete v[pubkeyB64];
              return v;
            });
            delete this._pendingScreenShareInits[pubkeyB64];
          }
        }
        const hasOutgoing = Object.keys(
          get(this._screenShareConnectionsOutgoing)
        ).includes(pubkeyB64);
        const hasPending = this._pendingScreenShareInits[pubkeyB64];
        if (!hasOutgoing && !hasPending) {
          console.log(`#### SENDING SCREEN SHARE INIT REQUEST ON PING FROM ${pubkeyB64.slice(0, 8)}`);
          const newConnectionId = uuidv4();
          this._pendingScreenShareInits[pubkeyB64] = [
            { connectionId: newConnectionId, t0: Date.now() },
          ];
          await this.roomClient.sendMessage(
            [signal.from_agent],
            'InitRequest',
            JSON.stringify({ connection_id: newConnectionId, connection_type: 'screen' }),
          );
          this.updateScreenShareConnectionStatus(pubkeyB64, {
            type: 'InitSent',
          });
        }
      }
    }
  }

  /**
   * Handle a LeaveUi signal — the remote peer is leaving the room.
   * Immediately tear down all connections and pending state for this agent.
   */
  async handleLeaveUi(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    console.log(`#### GOT LeaveUi FROM ${pubkeyB64.slice(0, 8)}`);
    this.logger.logAgentEvent({
      agent: pubkeyB64,
      timestamp: Date.now(),
      event: 'PeerLeave',
    });

    // Close video connection via ConnectionManager
    this.connectionManager.closeConnection(pubkeyB64, 'peer left');

    // Destroy incoming screen share
    const inSS = get(this._screenShareConnectionsIncoming)[pubkeyB64];
    if (inSS) {
      inSS.peer.destroy();
      this._screenShareConnectionsIncoming.update(v => { delete v[pubkeyB64]; return v; });
    }

    // Destroy outgoing screen share
    const outSS = get(this._screenShareConnectionsOutgoing)[pubkeyB64];
    if (outSS) {
      outSS.peer.destroy();
      this._screenShareConnectionsOutgoing.update(v => { delete v[pubkeyB64]; return v; });
    }

    // Clean up video streams and pending state
    delete this._videoStreams[pubkeyB64];
    delete this._pendingScreenShareInits[pubkeyB64];
    delete this._pendingScreenShareAccepts[pubkeyB64];

    // Mark as disconnected
    this._connectionStatuses.update(v => {
      v[pubkeyB64] = { type: 'Disconnected' };
      return v;
    });
    this.updateScreenShareConnectionStatus(pubkeyB64, { type: 'Disconnected' });

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

    /**
     * Outgoing screen share stream
     *
     * If our screen share stream is active and there is no open outgoing
     * screen share connection yet with this agent and there is no pending
     * InitRequest from less than 5 seconds ago (and we therefore have to
     * assume that a remote signal got lost), send an InitRequest.
     *
     * Also clean up stale outgoing screen share connections where the
     * underlying WebRTC connection is no longer alive (e.g. peer left
     * without a clean close event reaching us).
     */
    const outgoingScreenShare = get(this._screenShareConnectionsOutgoing)[pubkeyB64];
    if (outgoingScreenShare) {
      const pc = (outgoingScreenShare.peer as any)._pc as RTCPeerConnection | undefined;
      const iceState = pc?.iceConnectionState;
      if (iceState === 'disconnected' || iceState === 'failed' || iceState === 'closed') {
        console.log(`#### CLEANING UP STALE OUTGOING SCREEN SHARE TO ${pubkeyB64.slice(0, 8)} (ICE: ${iceState})`);
        outgoingScreenShare.peer.destroy();
        this._screenShareConnectionsOutgoing.update(currentValue => {
          delete currentValue[pubkeyB64];
          return currentValue;
        });
        delete this._pendingScreenShareInits[pubkeyB64];
      }
    }
    const alreadyOpenScreenShareOutgoing = Object.keys(
      get(this._screenShareConnectionsOutgoing)
    ).includes(pubkeyB64);
    const pendingScreenShareInits = this._pendingScreenShareInits[pubkeyB64];
    if (!!this.screenShareStream && !alreadyOpenScreenShareOutgoing) {
      if (!pendingScreenShareInits) {
        console.log('#### SENDING FIRST SCREEN SHARE INIT REQUEST.');
        const newConnectionId = uuidv4();
        this._pendingScreenShareInits[pubkeyB64] = [
          { connectionId: newConnectionId, t0: now },
        ];
        await this.roomClient.sendMessage(
          [signal.from_agent],
          'InitRequest',
          JSON.stringify({ connection_id: newConnectionId, connection_type: 'screen' }),
        );
        this.updateScreenShareConnectionStatus(pubkeyB64, {
          type: 'InitSent',
        });
      } else {
        console.log(
          `#--# SENDING SCREEN SHARE INIT REQUEST NUMBER ${
            pendingScreenShareInits.length + 1
          }.`
        );
        const latestInit = pendingScreenShareInits.sort(
          (init_a, init_b) => init_b.t0 - init_a.t0
        )[0];
        if (now - latestInit.t0 > INIT_RETRY_THRESHOLD) {
          const newConnectionId = uuidv4();
          pendingScreenShareInits.push({
            connectionId: newConnectionId,
            t0: now,
          });
          this._pendingScreenShareInits[pubkeyB64] = pendingScreenShareInits;
          await this.roomClient.sendMessage(
            [signal.from_agent],
            'InitRequest',
            JSON.stringify({ connection_id: newConnectionId, connection_type: 'screen' }),
          );
        }
        this.updateScreenShareConnectionStatus(pubkeyB64, {
          type: 'InitSent',
        });
      }
    }
  }

  /**
   * Handle an InitRequest signal — ONLY for screen share connections.
   * Video connections use ConnectionManager + Perfect Negotiation.
   */
  async handleInitRequest(
    signal: Extract<RoomSignal, { type: 'Message' }>
  ) {
    const pubKey64 = encodeHashToBase64(signal.from_agent);
    const { connection_id, connection_type } = JSON.parse(signal.payload) as InitPayload;

    // Only handle screen share InitRequests
    if (connection_type !== 'screen') {
      // Video InitRequests are no longer used — ConnectionManager handles
      // connection establishment via Perfect Negotiation + Sdp signals.
      return;
    }

    this.logger.logAgentEvent({
      agent: pubKey64,
      timestamp: Date.now(),
      event: 'InitRequest',
      connectionId: connection_id,
    });
    console.log('#### GOT SCREEN SHARE INIT REQUEST.');

    const newPeer = this.createScreenSharePeer(
      signal.from_agent,
      connection_id,
      false
    );
    const accept: PendingAccept = {
      connectionId: connection_id,
      peer: newPeer,
      createdAt: Date.now(),
    };
    const allPendingScreenShareAccepts = this._pendingScreenShareAccepts;
    const pendingScreenShareAcceptsForAgent =
      allPendingScreenShareAccepts[pubKey64];
    const newPendingAcceptsForAgent: PendingAccept[] =
      pendingScreenShareAcceptsForAgent
        ? [...pendingScreenShareAcceptsForAgent, accept]
        : [accept];
    allPendingScreenShareAccepts[pubKey64] = newPendingAcceptsForAgent;
    this._pendingScreenShareAccepts = allPendingScreenShareAccepts;
    await this.roomClient.sendMessage(
      [signal.from_agent],
      'InitAccept',
      JSON.stringify({ connection_id, connection_type }),
    );
  }

  /**
   * Handle an InitAccept signal — ONLY for screen share connections.
   * Video connections use ConnectionManager + Perfect Negotiation.
   */
  async handleInitAccept(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubKey64 = encodeHashToBase64(signal.from_agent);
    const { connection_id, connection_type } = JSON.parse(signal.payload) as InitPayload;

    // Only handle screen share InitAccepts
    if (connection_type !== 'screen') {
      return;
    }

    this.logger.logAgentEvent({
      agent: pubKey64,
      timestamp: Date.now(),
      event: 'InitAccept',
      connectionId: connection_id,
    });

    const agentPendingScreenShareInits =
      this._pendingScreenShareInits[pubKey64];
    if (
      !Object.keys(this._screenShareConnectionsOutgoing).includes(pubKey64)
    ) {
      if (!agentPendingScreenShareInits) {
        console.warn(
          `Got a screen share InitAccept from an agent (${pubKey64}) for which we have no pending init stored.`
        );
        return;
      }

      if (
        agentPendingScreenShareInits
          .map(pendingInit => pendingInit.connectionId)
          .includes(connection_id)
      ) {
        console.log(
          '#### RECEIVED INIT ACCEPT FOR SCREEN SHARING AND INITIATING PEER.'
        );
        const newPeer = this.createScreenSharePeer(
          signal.from_agent,
          connection_id,
          true
        );

        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnectionsOutgoing = currentValue;
          screenShareConnectionsOutgoing[pubKey64] = {
            connectionId: connection_id,
            peer: newPeer,
            video: true,
            audio: false,
            connected: false,
            direction: 'outgoing', // if we initiated the request, we're the ones delivering the stream
          };
          return screenShareConnectionsOutgoing;
        });

        delete this._pendingScreenShareInits[pubKey64];

        this.updateScreenShareConnectionStatus(pubKey64, {
          type: 'SdpExchange',
        });
      }
    }
  }

  /**
   * Handle an SdpData signal — ONLY for screen share connections.
   * Video connections use the 'Sdp' message type routed through ConnectionManager.
   */
  async handleSdpData(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    const { connection_id, data } = JSON.parse(signal.payload) as SdpPayload;

    /**
     * Outgoing Screen Share connections
     */
    const maybeOutgoingScreenShareConnection = get(
      this._screenShareConnectionsOutgoing
    )[pubkeyB64];
    if (
      maybeOutgoingScreenShareConnection &&
      maybeOutgoingScreenShareConnection.connectionId === connection_id
    ) {
      maybeOutgoingScreenShareConnection.peer.signal(JSON.parse(data));
    }

    /**
     * Incoming Screen Share connections
     */
    const maybeIncomingScreenShareConnection = get(
      this._screenShareConnectionsIncoming
    )[pubkeyB64];
    if (
      maybeIncomingScreenShareConnection &&
      maybeIncomingScreenShareConnection.connectionId === connection_id
    ) {
      maybeIncomingScreenShareConnection.peer.signal(JSON.parse(data));
    } else {
      /**
       * If there's no open connection but a PendingAccept then move that
       * PendingAccept to the open connections and destroy all other
       * Peer Instances for PendingAccepts of this agent and delete the
       * PendingAccepts
       */
      const pendingScreenShareAccepts =
        this._pendingScreenShareAccepts[pubkeyB64];
      if (pendingScreenShareAccepts) {
        const maybePendingAccept = pendingScreenShareAccepts.find(
          pendingAccept => pendingAccept.connectionId === connection_id
        );
        if (maybePendingAccept) {
          maybePendingAccept.peer.signal(JSON.parse(data));
          this._screenShareConnectionsIncoming.update(currentValue => {
            const screenShareConnectionsIncoming = currentValue;
            screenShareConnectionsIncoming[pubkeyB64] = {
              connectionId: connection_id,
              peer: maybePendingAccept.peer,
              video: false,
              audio: false,
              connected: false,
              direction: 'incoming',
            };
            return screenShareConnectionsIncoming;
          });
          const otherPendingAccepts = pendingScreenShareAccepts.filter(
            pendingAccept => pendingAccept.connectionId !== connection_id
          );
          otherPendingAccepts.forEach(pendingAccept =>
            pendingAccept.peer.destroy()
          );

          delete this._pendingScreenShareAccepts[pubkeyB64];
        } else {
          console.warn(
            `Got SDP data from agent (${pubkeyB64}) for which we have pending screen share accepts but none with a matching connection id.`
          );
        }
      }
    }
  }

  /**
   * Handle a DiagnosticRequest signal — gather recent logs and send back.
   */
  async handleDiagnosticRequest(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    console.log(`#### GOT DiagnosticRequest from ${pubkeyB64.slice(0, 8)}`);

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
    console.log(`#### GOT DiagnosticResponse from ${pubkeyB64.slice(0, 8)}`);

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
}
