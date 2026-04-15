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
  ModuleStateEnvelope,
  StoreEventPayload,
  StreamAndTrackInfo,
  AudioLinkState,
  LastSeenBucket,
  PeerLinkSnapshot,
} from './types';
import { getModule } from './room/modules/registry';
import {
  DEFAULT_CONVERSATION_PAYLOAD,
  ConversationPayload,
  parseConversationPayload,
} from './room/modules/conversation';
import { RoomClient } from './room/room-client';
import { RoomStore } from './room/room-store';
import { PresenceLogger } from './logging';
import { MicSource, MicAcquireResult } from './mic-source';
import { voiceController } from './room/modules/voice';
import { getStreamInfo } from './utils';

declare const __APP_VERSION__: string;

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/**
 * Timeout in ms for the SDP exchange phase. If a connection does not progress
 * from SdpExchange to Connected within this duration, the stale peer is destroyed
 * and the connection is reset to Disconnected so the next ping/pong cycle can retry.
 */
const SDP_EXCHANGE_TIMEOUT = 15000;

/**
 * If an InitRequest does not succeed within this duration (ms) another InitRequest will be sent
 */
const INIT_RETRY_THRESHOLD = 5000;

export const PING_INTERVAL = 2000;

/**
 * A store that handles the creation and management of WebRTC streams with
 * holochain peers
 */
export class StreamsStore {
  private roomClient: RoomClient;

  myPubKeyB64: AgentPubKeyB64;

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
   * Global WebRTC kill switch. When true, no WebRTC connections are
   * initiated or accepted for any peer. Audio flows via signals only.
   * Independent of the conversation module's active state — you can
   * still talk (mic on, signals carrier) with WebRTC globally disabled.
   * Persisted in localStorage as 'disableAllWebrtc'.
   */
  webrtcGloballyDisabled = false;

  /**
   * Max random delay in ms to add before processing each incoming signal.
   * 0 = no delay (production). Set via settings UI to simulate high-latency signaling.
   */
  signalDelayMs = 0;

  private _signalQueue: RoomSignal[] = [];

  private _processingSignal = false;

  /**
   * Transport-agnostic microphone owner. Consumers (WebRTC audio, the
   * voice module, a future transcription module) acquire a track from it
   * rather than calling getUserMedia themselves. See ui/src/mic-source.ts
   * for the full rationale.
   */
  micSource: MicSource;

  /**
   * Whether the voice encoder is currently running (sending audio to
   * peers without WebRTC via Holochain signals). Driven by
   * `_reconcileSignalsAudio` — starts when mic is held AND at least one
   * peer is in `_signalsTargets`; stops when either condition drops.
   */
  private _voiceEncoderRunning = false;

  /** Unsubscribe from the _signalsTargets subscription. */
  private _signalsTargetsUnsub: (() => void) | null = null;

  /**
   * Release handle held by the WebRTC audio path. Populated on `audioOn`,
   * cleared on full release. `audioOff` does NOT release — it just calls
   * `micSource.setMuted(true)` so the track stays alive for fast
   * re-enable without WebRTC renegotiation.
   */
  private _webrtcMicHandle: MicAcquireResult | null = null;

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

    const ACTIVE_AGENT_STALENESS = 3 * PING_INTERVAL;
    this._activeAgents = derived(
      [this._knownAgents, this.blockedAgents] as [Writable<Record<AgentPubKeyB64, AgentInfo>>, Writable<AgentPubKeyB64[]>],
      ([knownAgents, blocked]) => {
        const now = Date.now();
        const active: Record<AgentPubKeyB64, AgentInfo> = {};
        for (const [pubkey, info] of Object.entries(knownAgents)) {
          if (
            pubkey !== this.myPubKeyB64 &&
            !blocked.includes(pubkey) &&
            info.lastSeen !== undefined &&
            now - info.lastSeen < ACTIVE_AGENT_STALENESS
          ) {
            active[pubkey] = info;
          }
        }
        return active;
      },
    );

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
    this.webrtcGloballyDisabled = window.localStorage.getItem('disableAllWebrtc') === 'true';
    this.turnUrl = window.localStorage.getItem('turnUrl') || '';
    this.turnUsername = window.localStorage.getItem('turnUsername') || '';
    this.turnCredential = window.localStorage.getItem('turnCredential') || '';
    const signalDelay = window.localStorage.getItem('signalDelayMs');
    if (signalDelay) {
      this.signalDelayMs = parseInt(signalDelay, 10) || 0;
    }
    this._signalsTargets = derived(
      [this._activeAgents, this._openConnections],
      ([active, connections]) => {
        const targets = new Set<AgentPubKeyB64>();
        for (const pubkey of Object.keys(active)) {
          if (!connections[pubkey]) {
            targets.add(pubkey);
          }
        }
        return targets;
      },
    );

    navigator.mediaDevices.ondevicechange = e => {
      console.log('Got devide change: ', e);
    };

    this.micSource = new MicSource({
      getDeviceId: () => get(this._audioInputId),
      setDeviceId: id => this._audioInputId.set(id),
      onTrackChange: (newTrack, oldTrack) => {
        this._onMicTrackChange(newTrack, oldTrack);
      },
      onMutedChange: muted => {
        // Fan the mute state out to cloned streams (simple-peer issue #606).
        // The primary track's `enabled` flag is flipped inside MicSource;
        // only the clones need to be touched here.
        this.mainStreamClones.forEach(clonedStream => {
          clonedStream.getAudioTracks().forEach(track => {
            // eslint-disable-next-line no-param-reassign
            track.enabled = !muted;
          });
        });
      },
    });

    // Bind the voice controller to this store permanently so the receive
    // side (decoder + playback) works regardless of whether the local mic
    // is on. The send side (encoder) is gated separately by
    // _reconcileSignalsAudio. Unbind happens in disconnect().
    voiceController.bind(this);

    // Subscribe to _signalsTargets changes. When the set transitions
    // between empty and non-empty while the mic is held, start or stop
    // the voice encoder so audio automatically flows to peers without
    // WebRTC. The subscription fires on every _activeAgents or
    // _openConnections change, but _reconcileSignalsAudio is cheap
    // (a boolean check + set size).
    this._signalsTargetsUnsub = this._signalsTargets.subscribe(() => {
      this._reconcileSignalsAudio();
    });
  }

  /**
   * Start or stop the voice encoder based on whether the mic is held AND
   * at least one peer needs audio via signals. Called from the
   * _signalsTargets subscription and from audioOn/audioOff.
   */
  private _reconcileSignalsAudio(): void {
    const micHeld = !!this._webrtcMicHandle || this.micSource.consumerCount > 0;
    const hasTargets = get(this._signalsTargets).size > 0;
    const shouldRun = micHeld && hasTargets;

    if (shouldRun && !this._voiceEncoderRunning) {
      // Only start the encoder (send side). The controller is already
      // bound to the store at construction time so the receive side works
      // regardless.
      voiceController.startCapture().then(ok => {
        if (!ok) {
          this._voiceEncoderRunning = false;
          console.warn('Voice encoder failed to start');
        }
      });
      this._voiceEncoderRunning = true;
    } else if (!shouldRun && this._voiceEncoderRunning) {
      voiceController.stopCapture().catch(() => {});
      this._voiceEncoderRunning = false;
    }
  }

  /**
   * Handles MicSource track lifecycle events. Branches on the (new, old)
   * pair because opening, replacing, and closing all have different
   * implications for `mainStream`, `mainStreamClones`, and peer fanout.
   *
   *   - open         (newTrack, null)   : lazily create mainStream if needed,
   *                                       add the track, addTrack on peers.
   *   - device-change (newTrack, oldTrack): removeTrack/addTrack on
   *                                       mainStream, replaceTrack on peers.
   *                                       mainStreamClones are intentionally
   *                                       left alone here — device-change
   *                                       during an active reconnection path
   *                                       is a latent bug that predates this
   *                                       refactor; don't introduce new
   *                                       regressions while fixing the
   *                                       normal path.
   *   - close         (null, oldTrack)  : removeTrack from mainStream, remove
   *                                       from peers.
   */
  private _onMicTrackChange(
    newTrack: MediaStreamTrack | null,
    oldTrack: MediaStreamTrack | null,
  ): void {
    // --- open ---
    if (newTrack && !oldTrack) {
      if (!this.mainStream) {
        this.mainStream = new MediaStream();
      }
      // Drop any stale audio track (shouldn't happen, but cheap to guard).
      this.mainStream.getAudioTracks().forEach(t => {
        this.mainStream!.removeTrack(t);
      });
      this.mainStream.addTrack(newTrack);
      Object.values(get(this._openConnections)).forEach(conn => {
        try {
          conn.peer.addTrack(newTrack, this.mainStream!);
        } catch (e: any) {
          console.warn('MicSource open: peer.addTrack failed:', e.message);
        }
      });
      return;
    }

    // --- device change ---
    if (newTrack && oldTrack) {
      if (this.mainStream) {
        try { this.mainStream.removeTrack(oldTrack); } catch {}
        try { this.mainStream.addTrack(newTrack); } catch {}
      }
      Object.values(get(this._openConnections)).forEach(conn => {
        try {
          conn.peer.replaceTrack(oldTrack, newTrack, this.mainStream!);
        } catch (e: any) {
          console.warn('MicSource device-change: peer.replaceTrack failed:', e.message);
        }
      });
      return;
    }

    // --- close ---
    if (!newTrack && oldTrack) {
      if (this.mainStream) {
        try { this.mainStream.removeTrack(oldTrack); } catch {}
      }
      Object.values(get(this._openConnections)).forEach(conn => {
        try {
          conn.peer.removeTrack(oldTrack, this.mainStream!);
        } catch (e: any) {
          console.warn('MicSource close: peer.removeTrack failed:', e.message);
        }
      });
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
    // Close all connections and stop all streams
    Object.values(get(this._openConnections)).forEach(conn => {
      conn.peer.destroy();
    });
    Object.values(get(this._screenShareConnectionsIncoming)).forEach(conn => {
      conn.peer.destroy();
    });
    this.videoOff();
    this.audioOff();
    // Stop the voice encoder if running, then unbind the controller
    // (tears down both send and receive state).
    if (this._voiceEncoderRunning) {
      voiceController.stopCapture().catch(() => {});
      this._voiceEncoderRunning = false;
    }
    voiceController.unbind();
    if (this._signalsTargetsUnsub) {
      this._signalsTargetsUnsub();
      this._signalsTargetsUnsub = null;
    }
    // Release the WebRTC mic handle and force-close the MicSource (which
    // stops the underlying track and closes the shared AudioContext).
    if (this._webrtcMicHandle) {
      try { this._webrtcMicHandle.release(); } catch {}
      this._webrtcMicHandle = null;
    }
    this.micSource.dispose();
    this.screenShareOff();
    this.mainStream = null;
    this.screenShareStream = null;
    this._openConnections.set({});
    this._screenShareConnectionsOutgoing.set({});
    this._screenShareConnectionsIncoming.set({});
    this._pendingAccepts = {};
    this._pendingInits = {};
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
    // Include a send-side timestamp so peers can echo it back in their
    // pong, letting us compute signals-carrier RTT on receipt without
    // adding new messages. See handlePingUi / handlePongUi.
    await this.roomStore.client.sendMessage(
      agentsToPing,
      'PingUi',
      JSON.stringify({ t0: Date.now() }),
    );

    // Log our stream state
    this.logger.logMyStreamInfo(getStreamInfo(this.mainStream));

    // Cleanup stale pending accepts older than 20 seconds
    const now = Date.now();
    const PENDING_ACCEPT_TTL = 20000;
    for (const [agent, accepts] of Object.entries(this._pendingAccepts)) {
      const stale = accepts.filter(a => now - a.createdAt > PENDING_ACCEPT_TTL);
      if (stale.length > 0) {
        stale.forEach(a => a.peer.destroy());
        const remaining = accepts.filter(
          a => now - a.createdAt <= PENDING_ACCEPT_TTL
        );
        if (remaining.length > 0) {
          this._pendingAccepts[agent] = remaining;
        } else {
          delete this._pendingAccepts[agent];
        }
      }
    }
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

    // Health check for dead tracks (bytesReceived stall detection)
    await this._checkTrackHealth();
  }

  async changeVideoInput(deviceId: string) {
    this._videoInputId.set(deviceId);
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'ChangeMyVideoInput',
    });
    Object.values(get(this._openConnections)).forEach(conn => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'change-video-input',
      };
      try {
        conn.peer.send(JSON.stringify(msg));
      } catch (e: any) {
        console.error(
          "Failed to send 'change-video-input' message to peer: ",
          e.toString()
        );
      }
    });
    const videoTrack = this.mainStream?.getVideoTracks()[0];
    if (videoTrack && videoTrack.enabled) {
      await this.videoOff();
      await this.videoOn();
    }
  }

  async videoOn() {
    // Camera needs WebRTC — video doesn't go over the signals carrier.
    // Implicitly re-enable WebRTC if the user has it globally disabled,
    // otherwise turning the camera on would silently fail to reach any
    // peer and be deeply confusing.
    if (this.webrtcGloballyDisabled) {
      this.webrtcGloballyDisabled = false;
      window.localStorage.removeItem('disableAllWebrtc');
      await this._syncConversationPayload({ webrtcDisabled: false });
    }
    const deviceId = get(this._videoInputId);
    if (this.mainStream) {
      if (this.mainStream.getVideoTracks()[0]) {
        console.log('### CASE A');
        this.mainStream.getVideoTracks()[0].enabled = true;
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
        try {
          Object.values(get(this._openConnections)).forEach(conn => {
            conn.peer.addTrack(videoTrack, this.mainStream!);
          });
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
      try {
        Object.values(get(this._openConnections)).forEach(conn => {
          conn.peer.addStream(this.mainStream!);
        });
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
    Object.values(get(this._openConnections)).forEach(conn => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'video-on',
      };
      try {
        conn.peer.send(JSON.stringify(msg));
      } catch (e) {
        console.warn('Could not send video-on message to peer: ', e);
      }
    });
  }

  videoOff() {
    if (this.mainStream) {
      this.mainStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.stop();
      });
      Object.values(get(this._openConnections)).forEach(conn => {
        try {
          this.mainStream!.getVideoTracks().forEach(track => {
            conn.peer.removeTrack(track, this.mainStream!);
          });
        } catch (e) {
          console.warn('Could not remove video track from peer: ', e);
        }
        const msg: RTCMessage = {
          type: 'action',
          message: 'video-off',
        };
        try {
          conn.peer.send(JSON.stringify(msg));
        } catch (e) {
          console.warn('Could not send video-off message to peer: ', e);
        }
      });
      this.mainStream.getVideoTracks().forEach(track => {
        this.mainStream!.removeTrack(track);
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
    // MicSource owns the device-switch path: it stores the new id, opens a
    // new track, replaces the active track, and fires _onMicTrackChange,
    // which is what updates mainStream and replaceTracks on all peers.
    // If no consumer currently holds the mic (WebRTC off + voice off), the
    // id is stored and the next acquire picks it up.
    await this.micSource.changeDevice(deviceId);
    Object.values(get(this._openConnections)).forEach(conn => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'change-audio-input',
      };
      try {
        conn.peer.send(JSON.stringify(msg));
      } catch (e: any) {
        console.error(
          "Failed to send 'change-audio-input' message to peer: ",
          e.toString()
        );
      }
    });
  }

  async audioOn(enabled: boolean) {
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'MyAudioOn',
    });

    // Acquire the mic via MicSource on the first audioOn. Subsequent calls
    // just flip the mute flag — we hold the handle until disconnect, or
    // until a future explicit release path wants it back.
    if (!this._webrtcMicHandle) {
      const handle = await this.micSource.acquire({ id: 'webrtc' });
      if (!handle) {
        const error = 'Failed to acquire mic for WebRTC audio';
        console.error(error);
        this.eventCallback({ type: 'error', error });
        return;
      }
      this._webrtcMicHandle = handle;
      // The acquire call triggered _onMicTrackChange → mainStream.addTrack
      // and peer.addTrack for every open connection. Nothing more to do on
      // the stream-attachment side here.
    }

    // Apply the requested mute state. MicSource.setMuted is a no-op if the
    // state already matches, so calling audioOn(true) while already
    // unmuted is cheap.
    this.micSource.setMuted(!enabled);

    // Activate or update the `mic` module so peers' icon strips render the
    // mute state from its broadcast payload rather than from the WebRTC
    // `conn.audio` flag. This is the new source of truth for peer mic
    // state; the RTCMessage 'audio-on'/'audio-off' path below is kept
    // running for backward compatibility with peers on older code that
    // haven't learned about the conversation module yet.
    await this._syncConversationPayload({ micMuted: !enabled });

    // Start the voice encoder if peers need signals-carried audio.
    this._reconcileSignalsAudio();

    this.eventCallback({ type: 'my-audio-on' });

    Object.values(get(this._openConnections)).forEach(conn => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'audio-on',
      };
      try {
        conn.peer.send(JSON.stringify(msg));
      } catch (e: any) {
        console.error(
          "Failed to send 'audio-on' message to peer: ",
          e.toString()
        );
      }
    });
  }

  /**
   * Update the conversation module's broadcast payload, activating the
   * module if it isn't already. Merges into the existing payload (so
   * toggling `micMuted` preserves `disableWebrtcWith` and vice versa).
   */
  async _syncConversationPayload(
    patch: Partial<ConversationPayload>,
  ): Promise<void> {
    const existing = get(this._myModuleStates)['conversation'];
    const prev: ConversationPayload = existing
      ? (parseConversationPayload(existing) ?? { ...DEFAULT_CONVERSATION_PAYLOAD })
      : { ...DEFAULT_CONVERSATION_PAYLOAD };
    const next: ConversationPayload = { ...prev, ...patch };
    const payload = JSON.stringify(next);
    if (existing) {
      await this.updateModuleState('conversation', payload);
    } else {
      await this.activateModule('conversation', payload);
    }
  }

  async audioOff() {
    console.log('### AUDIO OFF');
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'MyAudioOff',
    });

    // Mute via MicSource. This flips track.enabled on the primary track and
    // fires the onMutedChange binding, which fans the flag out to every
    // mainStreamClones entry — matching the old behavior without any
    // per-stream track iteration here. We intentionally do NOT release the
    // WebRTC mic handle: the track stays alive for fast re-enable without
    // WebRTC renegotiation.
    this.micSource.setMuted(true);

    // Propagate mute state to the conversation module so peers' icon
    // strips update.
    await this._syncConversationPayload({ micMuted: true });

    Object.values(get(this._openConnections)).forEach(conn => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'audio-off',
      };
      try {
        conn.peer.send(JSON.stringify(msg));
      } catch (e: any) {
        console.error(
          'Failed to send audio-off message to peer: ',
          e.toString()
        );
      }
    });
    this.eventCallback({
      type: 'my-audio-off',
    });
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
    const relevantConnection = get(this._openConnections)[pubKeyB64];
    if (relevantConnection) relevantConnection.peer.destroy();
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
    this.disconnectFromPeerVideo(pubKey64);
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
   * Clones of the main stream. These are required in case a reconnection needs to be made for
   * an individual peer because our audio and/or video track is non-functional from their
   * perspective
   */
  mainStreamClones: MediaStream[] = [];

  /**
   * Tracks the last time reconcileVideoStreamState was triggered per agent,
   * to avoid firing more than once per 30s interval.
   */
  _lastReconcileTime: Record<AgentPubKeyB64, number> = {};

  /**
   * Tracks the timestamp of the last connection close/error per agent,
   * used to log the retry gap when a new InitRequest is created.
   */
  _lastDisconnectTime: Record<AgentPubKeyB64, number> = {};

  /**
   * Tracks how many consecutive reconciliation attempts have been made per agent,
   * for exponential backoff of the cooldown.
   */
  _reconcileAttemptCount: Record<AgentPubKeyB64, number> = {};

  /**
   * Tracks the last bytesReceived value per peer per track kind,
   * for detecting dead tracks via getStats().
   */
  private _lastBytesReceived: Record<AgentPubKeyB64, { audio: number; video: number }> = {};

  /**
   * The set of active peers that do NOT have a WebRTC connection. Audio
   * for these peers should be carried over Holochain remote signals
   * (the voice encoder path). Precomputed as a derived store so the
   * voice encoder's pump loop doesn't recompute per-chunk — it just
   * reads the cached set.
   *
   * Updates when: a peer appears/disappears in _activeAgents, a WebRTC
   * connection opens/closes in _openConnections, or disableWebrtcWith
   * changes (which tears down WebRTC, adding the peer to this set).
   */
  _signalsTargets!: Readable<Set<AgentPubKeyB64>>;

  /**
   * Number of consecutive health check cycles where bytesReceived did not increase.
   */
  private _staleCycles: Record<AgentPubKeyB64, { audio: number; video: number }> = {};

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
  // CONNECTION ESTABLISHMENT
  // ===========================================================================================

  /**
   * Pending Init requests
   */
  _pendingInits: Record<AgentPubKeyB64, PendingInit[]> = {};

  /**
   * Pending Accepts
   */
  _pendingAccepts: Record<AgentPubKeyB64, PendingAccept[]> = {};

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
   * Connections where the Init/Accept handshake succeeded and we have an active WebRTC connection
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
   * Agents that are actively present (recent pong within staleness threshold).
   * Derived from _knownAgents. Drives pane rendering instead of _openConnections.
   * Excludes self and blocked agents.
   */
  _activeAgents!: Readable<Record<AgentPubKeyB64, AgentInfo>>;

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
        /**
         * Their per-peer snapshot of every other agent's audio link state.
         * Drives the pair-wise indicators in the details overlay.
         */
        peerLinks?: Record<AgentPubKeyB64, PeerLinkSnapshot>;
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
  // MODULE SYSTEM
  // ===========================================================================================

  /** My own active module states, keyed by moduleId */
  _myModuleStates: Writable<Record<string, ModuleStateEnvelope>> = writable({});

  /** Peer module states, keyed by AgentPubKeyB64 then moduleId */
  _peerModuleStates: Writable<Record<AgentPubKeyB64, Record<string, ModuleStateEnvelope>>> = writable({});

  /** Receiver-controlled overrides: which replace module to view per peer (local only) */
  _receiverModuleOverrides: Writable<Record<AgentPubKeyB64, string>> = writable({});

  async activateModule(moduleId: string, payload?: string): Promise<void> {
    const mod = getModule(moduleId);
    const actualPayload = payload ?? mod?.defaultState?.() ?? '{}';
    const envelope: ModuleStateEnvelope = {
      moduleId,
      active: true,
      payload: actualPayload,
      updatedAt: Date.now(),
    };
    this._myModuleStates.update(s => ({ ...s, [moduleId]: envelope }));
    await this._broadcastModuleState(envelope);
    mod?.onActivate?.({ streamsStore: this, myPubKeyB64: this.myPubKeyB64 });
  }

  async deactivateModule(moduleId: string): Promise<void> {
    const mod = getModule(moduleId);
    const envelope: ModuleStateEnvelope = {
      moduleId,
      active: false,
      payload: '',
      updatedAt: Date.now(),
    };
    this._myModuleStates.update(s => {
      const next = { ...s };
      delete next[moduleId];
      return next;
    });
    await this._broadcastModuleState(envelope);
    mod?.onDeactivate?.();
  }

  async updateModuleState(moduleId: string, payload: string): Promise<void> {
    const envelope: ModuleStateEnvelope = {
      moduleId,
      active: true,
      payload,
      updatedAt: Date.now(),
    };
    this._myModuleStates.update(s => ({ ...s, [moduleId]: envelope }));
    await this._broadcastModuleState(envelope);
  }

  async sendModuleData(
    moduleId: string,
    chunk: string,
    targets?: Iterable<AgentPubKeyB64>,
  ): Promise<void> {
    const agentsToNotify = targets
      ? Array.from(targets).map(a => decodeHashFromBase64(a))
      : Object.keys(get(this._knownAgents))
          .filter(a => a !== this.myPubKeyB64)
          .map(a => decodeHashFromBase64(a));
    if (agentsToNotify.length > 0) {
      try {
        await this.roomClient.sendMessage(
          agentsToNotify,
          'ModuleData',
          JSON.stringify({ moduleId, chunk })
        );
      } catch (e) {
        console.error('Failed to send ModuleData signal:', e);
      }
    }
  }

  /**
   * Returns true iff WebRTC is disabled for the link between us and
   * `peerB64`. Symmetric union semantics: either side having the other
   * in their `disableWebrtcWith` list is sufficient.
   *
   * Reads synchronously from the module state stores so it can gate the
   * retry loop in `handlePongUi` without making that path async.
   */
  webrtcDisabled(peerB64: AgentPubKeyB64): boolean {
    // Check my per-peer override
    const myConv = get(this._myModuleStates)['conversation'];
    if (myConv) {
      const myPayload = parseConversationPayload(myConv);
      if (myPayload && myPayload.disableWebrtcWith.includes(peerB64)) {
        return true;
      }
    }
    // Check peer's broadcast state: both per-peer and global
    const peerConv = get(this._peerModuleStates)[peerB64]?.['conversation'];
    if (peerConv) {
      const peerPayload = parseConversationPayload(peerConv);
      if (peerPayload) {
        // Peer has globally disabled WebRTC
        if (peerPayload.webrtcDisabled) return true;
        // Peer has disabled WebRTC specifically for us
        if (peerPayload.disableWebrtcWith.includes(this.myPubKeyB64)) return true;
      }
    }
    return false;
  }

  /**
   * Freshness bucket for the last pong we received from a peer. Thresholds
   * match `lastSeenToColor` in agent-connection-status-icon.ts so broadcast
   * and locally-rendered dots pick the same bucket.
   */
  lastSeenBucket(peerB64: AgentPubKeyB64): LastSeenBucket {
    const known = get(this._knownAgents)[peerB64];
    if (!known || typeof known.lastSeen !== 'number') return 'unknown';
    const age = Date.now() - known.lastSeen;
    if (age < 15_000) return 'fresh';
    if (age < 30_000) return 'stale';
    return 'gone';
  }

  /**
   * Roll-up audio link state from this agent's local observations of the
   * given peer. Parallel FSM to `ConnectionStatus`: that one answers "what
   * stage is the WebRTC negotiation in?" — this one answers "can I hear
   * this peer right now, and via what carrier?"
   */
  audioLinkFor(peerB64: AgentPubKeyB64): AudioLinkState {
    if (get(this.blockedAgents).includes(peerB64)) return 'blocked';

    const bucket = this.lastSeenBucket(peerB64);
    if (bucket === 'gone' || bucket === 'unknown') return 'absent';

    const conn = get(this._openConnections)[peerB64];
    const status = get(this._connectionStatuses)[peerB64];

    // Active flow takes precedence over everything else: if audio is
    // actually arriving, the link is working regardless of any stale
    // intent or status flags.
    const webrtcAudioLive =
      !!conn?.connected &&
      !!conn?.audio &&
      (this._staleCycles[peerB64]?.audio ?? 0) < 2;
    if (webrtcAudioLive) return 'webrtc';

    const lastRecv = voiceController.peerLastRecvMs.get(peerB64);
    const signalsLive = !!lastRecv && Date.now() - lastRecv < 2000;
    if (signalsLive) return 'signals';

    // No flow. Peer intent comes BEFORE the negotiation check: a stale
    // ConnectionStatus stuck in InitSent/AcceptSent (e.g. left over from
    // before webrtc was globally disabled) would otherwise mask the fact
    // that the peer is intentionally muted. Muted is the more accurate
    // answer when both could apply.
    const peerConv = get(this._peerModuleStates)[peerB64]?.['conversation'];
    if (peerConv) {
      const payload = parseConversationPayload(peerConv);
      if (payload?.micMuted) return 'muted';
    }

    // Genuine in-progress negotiation (no flow, peer not muted).
    if (status) {
      switch (status.type) {
        case 'AwaitingInit':
        case 'InitSent':
        case 'AcceptSent':
        case 'SdpExchange':
          return 'negotiating';
        default:
          break;
      }
    }

    // Reachable, not muted, no flow and not negotiating — broken.
    return 'down';
  }

  /**
   * Build the pair-wise snapshot broadcast in pong metadata so every peer
   * can render "how I see each other agent."
   */
  peerLinkFor(peerB64: AgentPubKeyB64): PeerLinkSnapshot {
    const conn = get(this._openConnections)[peerB64];
    const audioLink = this.audioLinkFor(peerB64);

    let carrier: PeerLinkSnapshot['carrier'];
    if (audioLink === 'webrtc') carrier = 'webrtc';
    else if (audioLink === 'signals') carrier = 'signals';
    else if (conn?.connected) carrier = 'webrtc';
    else carrier = 'none';

    let audio: PeerLinkSnapshot['audio'];
    if (audioLink === 'webrtc' || audioLink === 'signals') audio = 'live';
    else if (audioLink === 'muted') audio = 'muted';
    else if (conn?.connected && conn.audio) audio = 'stale';
    else audio = 'off';

    const video: PeerLinkSnapshot['video'] = conn?.video
      ? 'live'
      : conn?.videoMuted
        ? 'muted'
        : 'off';

    return {
      audioLink,
      carrier,
      audio,
      video,
      lastSeen: this.lastSeenBucket(peerB64),
    };
  }

  /**
   * Set of agents anyone (me or any peer with a fresh broadcast) reports
   * as currently present in the room. Drives the icon list in the
   * connection-details overlay so that:
   *
   *   - An agent first noticed by some other peer pops onto everyone's
   *     list immediately, without waiting for our own ping cycle.
   *   - An agent nobody sees is hidden entirely rather than lingering as
   *     a "not in room" entry on every tile.
   *
   * Per-tile rendering still asks "does THIS observer see them?" — that
   * gates the audio/video icons and ring color.
   */
  globalPresenceSet(): Set<AgentPubKeyB64> {
    const out = new Set<AgentPubKeyB64>();
    // We know we're here. Including self matters because peer tiles need
    // to render their observer's view of US — the icon strip on Gaston's
    // tile must include me. Excluding self happens at the per-tile level
    // (drop the observer from each tile's iteration), not here.
    out.add(this.myPubKeyB64);
    // My own active agents.
    for (const k of Object.keys(get(this._activeAgents))) {
      out.add(k);
    }
    // Anyone any fresh observer reports as present (lastSeen bucket
    // 'fresh' or 'stale' in their broadcast peerLinks).
    const others = get(this._othersConnectionStatuses);
    for (const observerKey of Object.keys(others)) {
      const obs = others[observerKey];
      if (!obs.peerLinks) continue;
      for (const [peerKey, snap] of Object.entries(obs.peerLinks)) {
        if (snap.lastSeen === 'fresh' || snap.lastSeen === 'stale') {
          out.add(peerKey);
        }
      }
    }
    return out;
  }

  /**
   * Build the full peerLinks map that goes into a pong — one snapshot per
   * known agent including the recipient (so they can render "how X sees
   * me" with the same pair-wise path as any other pair). Excludes only
   * self.
   */
  private _buildPeerLinks(): Record<AgentPubKeyB64, PeerLinkSnapshot> {
    const out: Record<AgentPubKeyB64, PeerLinkSnapshot> = {};
    const known = get(this._knownAgents);
    for (const pubkey of Object.keys(known)) {
      if (pubkey === this.myPubKeyB64) continue;
      out[pubkey] = this.peerLinkFor(pubkey);
    }
    return out;
  }

  /**
   * Toggle a peer in/out of our `disableWebrtcWith` list and broadcast
   * the updated conversation module payload. When a peer is added, the
   * retry loop stops initiating WebRTC for them and the conversation
   * module's `onModulePayloadChange` on the remote side tears down the
   * existing connection. When removed, the next pong cycle restarts
   * WebRTC.
   *
   * Also tears down the local WebRTC connection immediately when adding
   * (we don't wait for the next pong cycle).
   */
  async toggleDisableWebrtc(peerB64: AgentPubKeyB64): Promise<void> {
    const existing = get(this._myModuleStates)['conversation'];
    const payload: ConversationPayload = existing
      ? (parseConversationPayload(existing) ?? { ...DEFAULT_CONVERSATION_PAYLOAD })
      : { ...DEFAULT_CONVERSATION_PAYLOAD };

    const idx = payload.disableWebrtcWith.indexOf(peerB64);
    if (idx >= 0) {
      payload.disableWebrtcWith = payload.disableWebrtcWith.filter(p => p !== peerB64);
      console.log(`toggleDisableWebrtc: re-enabled WebRTC for ${peerB64.slice(0, 8)}`);
    } else {
      payload.disableWebrtcWith = [...payload.disableWebrtcWith, peerB64];
      console.log(`toggleDisableWebrtc: disabled WebRTC for ${peerB64.slice(0, 8)}`);
    }

    await this._syncConversationPayload(payload);

    if (idx < 0) {
      this.disconnectFromPeerVideo(peerB64);
      this._clearPendingWebrtcStatus(peerB64);
    }
  }

  /**
   * Force a peer's WebRTC `ConnectionStatus` to `Disconnected` if it is
   * currently in any negotiation phase. The close handler clears Connected
   * statuses on its own; pending Init/Accept/SDP states have no equivalent
   * teardown event, so they otherwise persist forever once webrtc is
   * disabled — leaving `audioLinkFor` to misreport "negotiating" when the
   * link is actually permanently down by intent.
   */
  _clearPendingWebrtcStatus(peerB64?: AgentPubKeyB64): void {
    const isPending = (s: ConnectionStatus | undefined) =>
      !!s &&
      (s.type === 'AwaitingInit' ||
        s.type === 'InitSent' ||
        s.type === 'AcceptSent' ||
        s.type === 'SdpExchange');

    this._connectionStatuses.update(curr => {
      if (peerB64) {
        if (isPending(curr[peerB64])) curr[peerB64] = { type: 'Disconnected' };
      } else {
        for (const k of Object.keys(curr)) {
          if (isPending(curr[k])) curr[k] = { type: 'Disconnected' };
        }
      }
      return curr;
    });
    this._pendingInits = peerB64
      ? Object.fromEntries(
          Object.entries(this._pendingInits).filter(([k]) => k !== peerB64),
        )
      : {};
    this._pendingAccepts = peerB64
      ? Object.fromEntries(
          Object.entries(this._pendingAccepts).filter(([k]) => k !== peerB64),
        )
      : {};
  }

  /**
   * Per-peer peak audio level from the voice (signals) carrier.
   * Range 0.0–1.0. Updated per decoded frame (~50/sec per peer).
   * Plain Map — not reactive. Read by the audio-level-meter element.
   */
  get signalsAudioLevels(): Map<string, number> {
    return voiceController.peerAudioLevels;
  }

  /** True iff the signals-carrier voice encoder is currently capturing. */
  get voiceEncoderRunning(): boolean {
    return this._voiceEncoderRunning;
  }

  /** Wall-clock ms of the last voice frame sent to each peer. */
  get signalsLastSent(): Map<string, number> {
    return voiceController.peerLastSentMs;
  }

  /** Wall-clock ms of the last voice frame received from each peer. */
  get signalsLastRecv(): Map<string, number> {
    return voiceController.peerLastRecvMs;
  }

  /** True iff a WebRTC video connection currently exists to this peer. */
  hasWebrtcConnection(pubKeyB64: string): boolean {
    return !!get(this._openConnections)[pubKeyB64];
  }

  /** Current OpenConnectionInfo for a peer, or undefined. */
  openConnectionInfo(pubKeyB64: string): OpenConnectionInfo | undefined {
    return get(this._openConnections)[pubKeyB64];
  }

  /**
   * Per-peer WebRTC AnalyserNodes for reading incoming audio levels.
   * Created when a peer stream arrives, removed on disconnect.
   * The audio-level-meter element polls these at 10fps.
   */
  private _peerAnalysers = new Map<string, AnalyserNode>();
  private _peerAnalyserBuffers = new Map<string, Uint8Array>();

  /**
   * Per-peer latency/quality stats for the signals carrier. Updated on
   * each pong receive (RTT) and by VoiceController (jitter, loss).
   * Plain Map — read by the peer-stats-panel element at its own poll rate.
   */
  signalsStats = new Map<string, import('./types').CarrierStats>();

  /**
   * Per-peer latency/quality stats for the WebRTC carrier. Updated by
   * the periodic getStats() poll. Plain Map — not reactive.
   */
  webrtcStats = new Map<string, import('./types').CarrierStats>();

  /**
   * Rolling EWMA of signals-carrier RTT per peer. Smooths out noise
   * from jitter on individual ping/pong round trips.
   */
  private _signalsRttEwma = new Map<string, number>();

  /**
   * Set up an AnalyserNode for a peer's incoming WebRTC audio stream.
   * Connected as: MediaStreamSource → AnalyserNode (no destination —
   * the <video> element handles playback). Called from the peer-stream
   * event handler.
   */
  setupPeerAudioAnalyser(pubKeyB64: string, stream: MediaStream): void {
    // Clean up any existing analyser for this peer
    this._peerAnalysers.delete(pubKeyB64);
    this._peerAnalyserBuffers.delete(pubKeyB64);

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const ctx = this.micSource.ensureAudioContext();
    if (!ctx) return;

    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      // Do NOT connect analyser to destination — <video> handles playback
      this._peerAnalysers.set(pubKeyB64, analyser);
      this._peerAnalyserBuffers.set(pubKeyB64, new Uint8Array(analyser.fftSize));
    } catch (e) {
      console.warn('Failed to create audio analyser for peer:', e);
    }
  }

  /**
   * Remove the AnalyserNode for a peer. Called on disconnect/leave.
   */
  removePeerAudioAnalyser(pubKeyB64: string): void {
    this._peerAnalysers.delete(pubKeyB64);
    this._peerAnalyserBuffers.delete(pubKeyB64);
  }

  /**
   * Read the current peak audio level for a peer from the WebRTC
   * AnalyserNode. Returns 0.0–1.0, or 0 if no analyser exists.
   * Called by the audio-level-meter element at 10fps.
   */
  getWebrtcAudioLevel(pubKeyB64: string): number {
    const analyser = this._peerAnalysers.get(pubKeyB64);
    const buffer = this._peerAnalyserBuffers.get(pubKeyB64);
    if (!analyser || !buffer) return 0;

    analyser.getByteTimeDomainData(buffer);
    let peak = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      // Byte domain data is 0–255 centered at 128
      const v = Math.abs(buffer[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  setReceiverOverride(agentPubKeyB64: AgentPubKeyB64, moduleId: string | null): void {
    this._receiverModuleOverrides.update(o => {
      const next = { ...o };
      if (moduleId) {
        next[agentPubKeyB64] = moduleId;
      } else {
        delete next[agentPubKeyB64];
      }
      return next;
    });
  }

  /**
   * Fire a module's onPeerStateChange callback when a peer's *effective*
   * active state actually transitions. "Effective active" means
   * `envelope.active === true && phase !== 'acquiring'`; an envelope in
   * `acquiring` is treated as not-yet-active for peer dispatch purposes,
   * so transitions acquiring → active will fire the callback, and
   * inactive → acquiring will not. Payload-only changes do not trigger.
   */
  private _dispatchPeerModuleTransition(
    pubkeyB64: AgentPubKeyB64,
    moduleId: string,
    prev: ModuleStateEnvelope | null,
    next: ModuleStateEnvelope | null,
  ) {
    const wasActive = !!prev?.active && prev?.phase !== 'acquiring';
    const isActive = !!next?.active && next?.phase !== 'acquiring';
    if (wasActive === isActive) return;
    try {
      getModule(moduleId)?.onPeerStateChange?.(pubkeyB64, prev, next, this);
    } catch (e) {
      console.warn(`onPeerStateChange threw for ${moduleId}:`, e);
    }
  }

  /**
   * Fire a module's onModulePayloadChange callback when the module is
   * active on both sides of the transition AND the payload differs. Not
   * fired when either side has `phase === 'acquiring'`.
   */
  private _dispatchPeerModulePayloadChange(
    pubkeyB64: AgentPubKeyB64,
    moduleId: string,
    prev: ModuleStateEnvelope | null,
    next: ModuleStateEnvelope | null,
  ) {
    if (!prev || !next) return;
    if (!prev.active || !next.active) return;
    if (prev.phase === 'acquiring' || next.phase === 'acquiring') return;
    if (prev.payload === next.payload) return;
    try {
      getModule(moduleId)?.onModulePayloadChange?.(pubkeyB64, prev, next, this);
    } catch (e) {
      console.warn(`onModulePayloadChange threw for ${moduleId}:`, e);
    }
  }

  handleModuleState(signal: Extract<RoomSignal, { type: 'Message' }>): void {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    try {
      const envelope: ModuleStateEnvelope = JSON.parse(signal.payload);
      const prev = get(this._peerModuleStates)[pubkeyB64]?.[envelope.moduleId] || null;
      this._peerModuleStates.update(all => {
        const updated = { ...all };
        if (!updated[pubkeyB64]) updated[pubkeyB64] = {};
        if (envelope.active) {
          updated[pubkeyB64] = { ...updated[pubkeyB64], [envelope.moduleId]: envelope };
        } else {
          const agentModules = { ...updated[pubkeyB64] };
          delete agentModules[envelope.moduleId];
          updated[pubkeyB64] = agentModules;
        }
        return updated;
      });
      const next = envelope.active ? envelope : null;
      this._dispatchPeerModuleTransition(pubkeyB64, envelope.moduleId, prev, next);
      this._dispatchPeerModulePayloadChange(pubkeyB64, envelope.moduleId, prev, next);
    } catch (e) {
      console.warn('Failed to parse ModuleState payload:', e);
    }
  }

  handleModuleData(signal: Extract<RoomSignal, { type: 'Message' }>): void {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    try {
      const { moduleId, chunk } = JSON.parse(signal.payload);
      const mod = getModule(moduleId);
      mod?.onData?.(pubkeyB64, chunk);
    } catch (e) {
      console.warn('Failed to parse ModuleData payload:', e);
    }
  }

  private async _broadcastModuleState(envelope: ModuleStateEnvelope): Promise<void> {
    const agentsToNotify = Object.keys(get(this._knownAgents))
      .filter(a => a !== this.myPubKeyB64)
      .map(a => decodeHashFromBase64(a));
    if (agentsToNotify.length > 0) {
      try {
        await this.roomClient.sendMessage(
          agentsToNotify,
          'ModuleState',
          JSON.stringify(envelope)
        );
      } catch (e) {
        console.error('Failed to send ModuleState signal:', e);
      }
    }
  }

  // ********************************************************************************************
  //
  //   S I M P L E   P E E R   H A N D L I N G
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

  createPeer(
    connectingAgent: AgentPubKey,
    connectionId: string,
    initiator: boolean
  ): SimplePeer.Instance {
    const pubKeyB64 = encodeHashToBase64(connectingAgent);
    const options: SimplePeer.Options = {
      initiator,
      config: {
        iceServers: this.iceConfig,
      },
      objectMode: true,
      trickle: this.trickleICE,
    };
    const peer = new SimplePeer(options);

    // Monitor ICE connection state for diagnostics (uses addEventListener to
    // avoid overwriting SimplePeer's own on* property handlers)
    const monitorICE = () => {
      const pc = (peer as any)._pc as RTCPeerConnection | undefined;
      if (!pc) {
        setTimeout(monitorICE, 100);
        return;
      }
      pc.addEventListener('iceconnectionstatechange', () => {
        const state = pc.iceConnectionState;
        this.logger.logCustomMessage(
          `ICE [${pubKeyB64.slice(0, 8)}]: ${state} connId=${connectionId.slice(0, 8)}`
        );
        // On terminal states, log the last selected candidate pair for post-mortem
        if (state === 'failed' || state === 'disconnected') {
          try {
            const transport = (pc.getSenders()[0]?.transport as any)?.iceTransport;
            const pair = transport?.getSelectedCandidatePair?.() as { local?: RTCIceCandidate; remote?: RTCIceCandidate } | undefined;
            if (pair) {
              this.logger.logCustomMessage(
                `ICE failed pair [${pubKeyB64.slice(0, 8)}]: local=${(pair.local as any)?.address}:${(pair.local as any)?.port} (${pair.local?.type}) remote=${(pair.remote as any)?.address}:${(pair.remote as any)?.port} (${pair.remote?.type})`
              );
            }
          } catch (_) {
            // getSenders/iceTransport may not be available on all browsers
          }
        }
      });
      pc.addEventListener('icegatheringstatechange', () => {
        this.logger.logCustomMessage(
          `ICE gathering [${pubKeyB64.slice(0, 8)}]: ${pc.iceGatheringState}`
        );
        // When gathering completes, log whether relay candidates were generated
        if (pc.iceGatheringState === 'complete') {
          const stats = (pc as any).localDescription?.sdp;
          const hasRelay = stats ? stats.includes('typ relay') : false;
          this.logger.logCustomMessage(
            `ICE candidates summary [${pubKeyB64.slice(0, 8)}]: relay=${hasRelay}`
          );
        }
      });
      pc.addEventListener('icecandidate', (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate) {
          // Log full candidate including address:port for NAT analysis
          const c = event.candidate;
          this.logger.logCustomMessage(
            `ICE candidate [${pubKeyB64.slice(0, 8)}]: ${c.type} ${c.protocol} ${c.address}:${c.port}`
          );
        }
      });
    };
    monitorICE();

    peer.on('signal', async data => {
      this.roomClient.sendMessage(
        [connectingAgent],
        'SdpData',
        JSON.stringify({ connection_id: connectionId, data: JSON.stringify(data) }),
      );
    });
    peer.on('data', data => {
      try {
        const msg: RTCMessage = JSON.parse(data);
        if (msg.type === 'action') {
          if (msg.message === 'video-off') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKeyB64];
              relevantConnection.video = false;
              openConnections[pubKeyB64] = relevantConnection;
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
              relevantConnection.audio = false;
              openConnections[pubKeyB64] = relevantConnection;
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
              relevantConnection.audio = true;
              openConnections[pubKeyB64] = relevantConnection;
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
    peer.on('stream', stream => {
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
      const existingPeerStreams = this._videoStreams;
      existingPeerStreams[pubKeyB64] = stream;
      this._videoStreams = existingPeerStreams;

      const audioTracks = stream.getAudioTracks();
      const videoTracks = stream.getVideoTracks();
      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        const relevantConnection = openConnections[pubKeyB64];
        if (relevantConnection) {
          // Audio: set immediately (audio muted state is less critical for UX)
          if (audioTracks.length > 0) {
            relevantConnection.audio = true;
          }
          // Video: only set if the track is not muted; the 'track' handler
          // will handle muted tracks via the onunmute patience logic
          if (videoTracks.length > 0 && !videoTracks[0].muted) {
            relevantConnection.video = true;
          } else if (videoTracks.length > 0 && videoTracks[0].muted) {
            relevantConnection.videoMuted = true;
          }
          openConnections[pubKeyB64] = relevantConnection;
        }
        return openConnections;
      });
      // Set up audio analyser for level metering before firing the event
      this.setupPeerAudioAnalyser(pubKeyB64, stream);
      // Always fire peer-stream so srcObject gets assigned to the <video> element
      this.eventCallback({
        type: 'peer-stream',
        pubKeyB64,
        connectionId,
        stream,
      });
    });
    peer.on('track', track => {
      console.log('#### GOT TRACK from:', pubKeyB64, track, 'muted:', track.muted);
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'SimplePeerTrack',
        connectionId,
      });

      if (!track.muted) {
        // Track is immediately usable — set flags and fire events right away
        this._setTrackReady(pubKeyB64, connectionId, track);
      } else {
        // Track arrived muted — wait for onunmute with a 5-second timeout
        console.log(`#### TRACK from ${pubKeyB64.slice(0, 8)} arrived muted (${track.kind}), waiting for unmute...`);
        this.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: Date.now(),
          event: 'TrackArrivedMuted',
        });

        // Mark as "connecting media" in the UI for video tracks
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
            // Still set the flag so the tile shows something; the health check can request recovery later
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
    peer.on('connect', async () => {
      console.log('#### CONNECTED with', pubKeyB64);
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'Connected',
        connectionId,
      });

      delete this._pendingInits[pubKeyB64];

      const openConnections = get(this._openConnections);
      const relevantConnection = openConnections[pubKeyB64];
      relevantConnection.connected = true;

      // Add stream if not already added before connect (e.g. mainStream was null at peer
      // creation time but is available now). If already added, the try-catch silently
      // ignores the duplicate-track error from RTCPeerConnection.addTrack.
      if (this.mainStream) {
        try {
          relevantConnection.peer.addStream(this.mainStream);
          this.logger.logCustomMessage(
            `addStream on-connect [${pubKeyB64.slice(0, 8)}]: ${this.mainStream.getTracks().length} tracks`
          );
        } catch (e: any) {
          // Tracks were already included in the initial offer/answer — no action needed
        }
      }

      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        openConnections[pubKeyB64] = relevantConnection;
        return openConnections;
      });

      this.updateConnectionStatus(pubKeyB64, { type: 'Connected' });
      this.eventCallback({
        type: 'peer-connected',
        pubKeyB64,
        connectionId,
      });

      // Check whether connection is relayed (TURN) after ICE settles
      setTimeout(async () => {
        try {
          const pc = (peer as any)._pc as RTCPeerConnection | undefined;
          if (!pc) return;
          const stats = await pc.getStats();
          let isRelayed = false;
          const reportsById: Record<string, any> = {};
          stats.forEach((report: any) => {
            reportsById[report.id] = report;
          });
          Object.values(reportsById).forEach((report: any) => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              const localCandidate = reportsById[report.localCandidateId];
              const remoteCandidate = reportsById[report.remoteCandidateId];
              if (localCandidate?.candidateType === 'relay') {
                isRelayed = true;
              }
              this.logger.logCustomMessage(
                `ICE pair [${pubKeyB64.slice(0, 8)}]: local=${localCandidate?.candidateType} ${localCandidate?.address}:${localCandidate?.port} remote=${remoteCandidate?.candidateType} ${remoteCandidate?.address}:${remoteCandidate?.port} proto=${localCandidate?.protocol}`
              );
            }
          });
          this._openConnections.update(current => {
            const conn = current[pubKeyB64];
            if (conn) {
              conn.relayed = isRelayed;
            }
            return current;
          });
          if (isRelayed) {
            this.logger.logCustomMessage(
              `Connection [${pubKeyB64.slice(0, 8)}]: relayed via TURN`
            );
          }
        } catch (e) {
          // getStats may fail if connection was already closed
        }
      }, 2000);
    });
    peer.on('close', async () => {
      console.log('#### GOT CLOSE EVENT ####');

      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'SimplePeerClose',
        connectionId,
      });
      this._lastDisconnectTime[pubKeyB64] = Date.now();

      // Remove from existing streams
      const existingPeerStreams = this._videoStreams;
      delete existingPeerStreams[pubKeyB64];
      this._videoStreams = existingPeerStreams;

      peer.destroy();

      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        delete openConnections[pubKeyB64];
        return openConnections;
      });

      // Clear stale perceivedStreamInfo so icons don't show stale state during reconnection
      this._othersConnectionStatuses.update(statuses => {
        if (statuses[pubKeyB64]) {
          statuses[pubKeyB64] = {
            ...statuses[pubKeyB64],
            perceivedStreamInfo: undefined,
          };
        }
        return statuses;
      });

      // Clean up health check state and audio analyser for this peer
      delete this._lastBytesReceived[pubKeyB64];
      delete this._staleCycles[pubKeyB64];
      delete this._reconcileAttemptCount[pubKeyB64];
      this.removePeerAudioAnalyser(pubKeyB64);
      this.webrtcStats.delete(pubKeyB64);

      // Also tear down any outgoing screen share to this peer since they
      // have disconnected. Without this, the stale WebRTC connection may
      // linger and block re-initiation when the peer rejoins.
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

      this.updateConnectionStatus(pubKeyB64, { type: 'Disconnected' });
      this.eventCallback({
        type: 'peer-disconnected',
        pubKeyB64,
        connectionId,
      });
    });
    peer.on('error', e => {
      console.log('#### GOT ERROR EVENT ####: ', e);
      peer.destroy();

      this.logger.logCustomMessage(
        `SimplePeerError [${pubKeyB64.slice(0, 8)}]: ${e.message || e}`
      );
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'SimplePeerError',
        connectionId,
      });

      // Remove from existing streams
      const existingPeerStreams = this._videoStreams;
      delete existingPeerStreams[pubKeyB64];
      this._videoStreams = existingPeerStreams;

      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        delete openConnections[pubKeyB64];
        return openConnections;
      });

      // Clear stale perceivedStreamInfo so icons don't show stale state during reconnection
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
      const outgoingScreenShare2 = get(this._screenShareConnectionsOutgoing)[pubKeyB64];
      if (outgoingScreenShare2) {
        outgoingScreenShare2.peer.destroy();
        this._screenShareConnectionsOutgoing.update(currentValue => {
          delete currentValue[pubKeyB64];
          return currentValue;
        });
        delete this._pendingScreenShareInits[pubKeyB64];
      }
      this.removePeerAudioAnalyser(pubKeyB64);
      this.webrtcStats.delete(pubKeyB64);

      this.updateConnectionStatus(pubKeyB64, { type: 'Disconnected' });
      this.eventCallback({
        type: 'peer-disconnected',
        pubKeyB64,
        connectionId,
      });
    });

    return peer;
  }

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

  updateConnectionStatus(pubKey: AgentPubKeyB64, status: ConnectionStatus) {
    this._connectionStatuses.update(currentValue => {
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

      if (status.type === 'SdpExchange') {
        const currentStatus = connectionStatuses[pubKey];
        if (currentStatus.type === 'Connected') {
          // If already connected, don't change anything. SdpExchange
          // is also expected to occur when turning on video when
          // already connected.
          return connectionStatuses;
        }
      }

      connectionStatuses[pubKey] = status;
      return connectionStatuses;
    });

    // When transitioning to Connected, send an immediate Pong to all known agents
    // so their UI updates within milliseconds rather than waiting for the next ping cycle
    if (status.type === 'Connected') {
      this._sendImmediatePongToAll();
    }
  }

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
          peerLinks: this._buildPeerLinks(),
          appVersion: __APP_VERSION__,
          streamInfo,
          audio: get(this._openConnections)[agentB64]?.audio,
          moduleStates: Object.keys(get(this._myModuleStates)).length > 0
            ? get(this._myModuleStates)
            : undefined,
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
   * Compares how the other peer sees our stream and if this mismatches our expectations,
   * reset streams accordingly. Uses exponential backoff (10s, 20s, 40s...) and tries
   * lightweight replaceTrack first before falling back to the heavier clone approach.
   *
   * @param pubkey
   * @param streamAndTrackInfo
   */
  reconcileVideoStreamState(
    pubkey: AgentPubKeyB64,
    streamAndTrackInfo: StreamAndTrackInfo
  ) {
    // Exponential backoff: 10s, 20s, 40s, 80s, 160s (capped)
    const BASE_COOLDOWN_MS = 10_000;
    const reconcileCount = this._reconcileAttemptCount[pubkey] || 0;
    const cooldown = BASE_COOLDOWN_MS * Math.pow(2, Math.min(reconcileCount, 4));
    const lastReconcile = this._lastReconcileTime[pubkey] || 0;
    if (Date.now() - lastReconcile < cooldown) return;

    if (!this.mainStream) return;

    // Case 1: Peer doesn't see our stream at all — re-add the whole stream
    if (!streamAndTrackInfo.stream) {
      console.warn(
        'Peer does not seem to see our own stream. Re-adding it to their peer object...'
      );
      this.logger.logAgentEvent({
        agent: pubkey,
        timestamp: Date.now(),
        event: 'ReconcileStream',
      });
      const peer = get(this._openConnections)[pubkey];
      if (peer) {
        try {
          peer.peer.addStream(this.mainStream);
          this._lastReconcileTime[pubkey] = Date.now();
          this._reconcileAttemptCount[pubkey] = reconcileCount + 1;
        } catch (e: any) {
          console.warn('Failed to re-add stream during reconcile:', e.message);
        }
      }
      return;
    }

    const connInfo = get(this._openConnections)[pubkey];
    if (!connInfo) return;

    const myAudioTrack = this.mainStream.getAudioTracks()[0];
    const myVideoTrack = this.mainStream.getVideoTracks()[0];

    let needsRecovery = false;

    // Check audio track
    if (myAudioTrack) {
      const perceived = streamAndTrackInfo.tracks.find(t => t.kind === 'audio');
      if (!perceived || perceived.muted) {
        needsRecovery = true;
        this.logger.logAgentEvent({ agent: pubkey, timestamp: Date.now(), event: 'ReconcileAudio' });
      }
    }

    // Check video track
    if (myVideoTrack) {
      const perceived = streamAndTrackInfo.tracks.find(t => t.kind === 'video');
      if (!perceived || perceived.muted) {
        needsRecovery = true;
        this.logger.logAgentEvent({ agent: pubkey, timestamp: Date.now(), event: 'ReconcileVideo' });
      }
    }

    if (!needsRecovery) {
      // Tracks are healthy — reset attempt count
      this._reconcileAttemptCount[pubkey] = 0;
      return;
    }

    console.warn(`Reconciling tracks for ${pubkey.slice(0, 8)} (attempt ${reconcileCount + 1})`);

    // Try lightweight replaceTrack first
    const success = this._tryReplaceTrackRecovery(pubkey, connInfo, myAudioTrack, myVideoTrack);

    if (!success) {
      // Fall back to heavier clone approach
      this._cloneStreamRecovery(pubkey, connInfo, myAudioTrack, myVideoTrack);
    }

    this._lastReconcileTime[pubkey] = Date.now();
    this._reconcileAttemptCount[pubkey] = reconcileCount + 1;
  }

  /**
   * Attempt lightweight track recovery using replaceTrack on the RTCRtpSender.
   * This avoids renegotiation and stream cloning.
   * Returns true if replaceTrack was possible, false if fallback is needed.
   */
  private _tryReplaceTrackRecovery(
    pubkey: AgentPubKeyB64,
    connInfo: OpenConnectionInfo,
    audioTrack: MediaStreamTrack | undefined,
    videoTrack: MediaStreamTrack | undefined
  ): boolean {
    try {
      const pc = (connInfo.peer as any)._pc as RTCPeerConnection | undefined;
      if (!pc) return false;

      const senders = pc.getSenders();
      let success = true;

      if (audioTrack) {
        const audioSender = senders.find(s => s.track?.kind === 'audio');
        if (audioSender) {
          connInfo.peer.replaceTrack(audioSender.track!, audioTrack, this.mainStream!);
          this.logger.logCustomMessage(`replaceTrack audio [${pubkey.slice(0, 8)}]: success`);
        } else {
          success = false;
        }
      }

      if (videoTrack) {
        const videoSender = senders.find(s => s.track?.kind === 'video');
        if (videoSender) {
          connInfo.peer.replaceTrack(videoSender.track!, videoTrack, this.mainStream!);
          this.logger.logCustomMessage(`replaceTrack video [${pubkey.slice(0, 8)}]: success`);
        } else {
          success = false;
        }
      }

      return success;
    } catch (e: any) {
      console.warn(`replaceTrack recovery failed for ${pubkey.slice(0, 8)}:`, e.message);
      this.logger.logCustomMessage(`replaceTrack [${pubkey.slice(0, 8)}]: failed -- ${e.message}`);
      return false;
    }
  }

  /**
   * Heavier track recovery: removes the stream, clones it, and re-adds tracks.
   * This triggers renegotiation but is more reliable than replaceTrack for some edge cases.
   *
   * NOTE: It is important that cloned streams are stored in mainStreamClones so that
   * audioOff() can disable audio tracks on them too. See simple-peer issue #606.
   */
  private _cloneStreamRecovery(
    pubkey: AgentPubKeyB64,
    connInfo: OpenConnectionInfo,
    audioTrack: MediaStreamTrack | undefined,
    videoTrack: MediaStreamTrack | undefined
  ) {
    if (!this.mainStream) return;
    console.warn(`Falling back to clone-based recovery for ${pubkey.slice(0, 8)}`);
    this.logger.logCustomMessage(`Clone recovery [${pubkey.slice(0, 8)}]`);
    connInfo.peer.removeStream(this.mainStream);
    const clonedStream = this.mainStream.clone();
    this.mainStreamClones = [...this.mainStreamClones, clonedStream];
    if (audioTrack) connInfo.peer.addTrack(audioTrack, clonedStream);
    if (videoTrack) connInfo.peer.addTrack(videoTrack, clonedStream);
  }

  /**
   * Public method for manual track recovery. Tries replaceTrack first,
   * falls back to clone approach. Does not tear down the WebRTC connection.
   */
  refreshTracksForPeer(pubKeyB64: AgentPubKeyB64) {
    const connInfo = get(this._openConnections)[pubKeyB64];
    if (!connInfo || !this.mainStream) {
      console.warn(`Cannot refresh tracks for ${pubKeyB64.slice(0, 8)}: no connection or stream`);
      return;
    }
    const myAudioTrack = this.mainStream.getAudioTracks()[0];
    const myVideoTrack = this.mainStream.getVideoTracks()[0];

    this.logger.logCustomMessage(
      `Track refresh [${pubKeyB64.slice(0, 8)}]: audio=${myAudioTrack ? `${myAudioTrack.enabled ? 'enabled' : 'disabled'},${myAudioTrack.muted ? 'muted' : 'unmuted'},${myAudioTrack.readyState}` : 'none'} video=${myVideoTrack ? `${myVideoTrack.enabled ? 'enabled' : 'disabled'},${myVideoTrack.muted ? 'muted' : 'unmuted'},${myVideoTrack.readyState}` : 'none'}`
    );

    const success = this._tryReplaceTrackRecovery(pubKeyB64, connInfo, myAudioTrack, myVideoTrack);
    if (!success) {
      this._cloneStreamRecovery(pubKeyB64, connInfo, myAudioTrack, myVideoTrack);
    }
    this.logger.logCustomMessage(
      `Manual track refresh [${pubKeyB64.slice(0, 8)}]: ${success ? 'replaceTrack' : 'clone fallback'}`
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

  /**
   * Checks inbound RTP bytesReceived for each open connection.
   * If bytes haven't increased for 2+ consecutive cycles (4+ seconds at 2s ping interval),
   * the track is considered dead and we request the sender to refresh via data channel.
   */
  private async _checkTrackHealth() {
    const openConnections = get(this._openConnections);
    for (const [pubKeyB64, connInfo] of Object.entries(openConnections)) {
      if (!connInfo.connected) continue;
      if (!connInfo.video && !connInfo.audio) continue;

      const pc = (connInfo.peer as any)._pc as RTCPeerConnection | undefined;
      if (!pc) continue;

      try {
        const stats = await pc.getStats();
        let audioBytes = 0;
        let videoBytes = 0;
        // Per-kind jitter/loss. Prefer audio for display when available
        // (more time-sensitive); fall back to video otherwise.
        let audioJitter: number | null = null;
        let audioPacketsReceived = 0;
        let audioPacketsLost = 0;
        let videoJitter: number | null = null;
        let videoPacketsReceived = 0;
        let videoPacketsLost = 0;
        let rttMs: number | null = null;
        let candPairRttMs: number | null = null;

        stats.forEach((report: any) => {
          if (report.type === 'inbound-rtp') {
            const kind = report.kind || report.mediaType;
            if (kind === 'audio') {
              audioBytes = report.bytesReceived || 0;
              if (typeof report.jitter === 'number') audioJitter = report.jitter;
              audioPacketsReceived = report.packetsReceived || 0;
              audioPacketsLost = report.packetsLost || 0;
            } else if (kind === 'video') {
              videoBytes = report.bytesReceived || 0;
              if (typeof report.jitter === 'number') videoJitter = report.jitter;
              videoPacketsReceived = report.packetsReceived || 0;
              videoPacketsLost = report.packetsLost || 0;
            }
          }
          // RTT from remote-inbound-rtp (our outgoing direction).
          if (report.type === 'remote-inbound-rtp' &&
              typeof report.roundTripTime === 'number') {
            rttMs = Math.round(report.roundTripTime * 1000);
          }
          // Fallback: candidate-pair gives ICE-level RTT.
          if (report.type === 'candidate-pair' &&
              report.state === 'succeeded' &&
              typeof report.currentRoundTripTime === 'number') {
            candPairRttMs = Math.round(report.currentRoundTripTime * 1000);
          }
        });

        if (rttMs === null) rttMs = candPairRttMs;

        // Pick whichever kind has data. Audio is preferred when both
        // are flowing. If neither, leave jitter/loss null.
        const hasAudio = audioPacketsReceived + audioPacketsLost > 0;
        const hasVideo = videoPacketsReceived + videoPacketsLost > 0;
        const jitter = hasAudio
          ? audioJitter
          : (hasVideo ? videoJitter : null);
        const pktsRecv = hasAudio
          ? audioPacketsReceived
          : (hasVideo ? videoPacketsReceived : 0);
        const pktsLost = hasAudio
          ? audioPacketsLost
          : (hasVideo ? videoPacketsLost : 0);
        const totalPackets = pktsRecv + pktsLost;

        this.webrtcStats.set(pubKeyB64, {
          rttMs,
          jitterMs: jitter !== null
            ? Math.round((jitter as number) * 1000 * 10) / 10
            : null,
          lossPercent: totalPackets > 0
            ? Math.round((pktsLost / totalPackets) * 1000) / 10
            : null,
        });

        const lastBytes = this._lastBytesReceived[pubKeyB64] || { audio: 0, video: 0 };
        const stale = this._staleCycles[pubKeyB64] || { audio: 0, video: 0 };

        // Check video
        if (connInfo.video && videoBytes > 0) {
          if (videoBytes === lastBytes.video) {
            stale.video++;
          } else {
            stale.video = 0;
          }
        }

        // Check audio
        if (connInfo.audio && audioBytes > 0) {
          if (audioBytes === lastBytes.audio) {
            stale.audio++;
          } else {
            stale.audio = 0;
          }
        }

        this._lastBytesReceived[pubKeyB64] = { audio: audioBytes, video: videoBytes };
        this._staleCycles[pubKeyB64] = stale;

        // If 2+ consecutive stale cycles (4+ seconds), request track refresh
        if (stale.video >= 2 || stale.audio >= 2) {
          console.warn(
            `Dead track detected for ${pubKeyB64.slice(0, 8)}: audio stale=${stale.audio}, video stale=${stale.video}`
          );
          this.logger.logCustomMessage(
            `Dead track [${pubKeyB64.slice(0, 8)}]: audio=${stale.audio} video=${stale.video} cycles stale`
          );

          const msg: RTCMessage = {
            type: 'action',
            message: 'request-track-refresh',
          };
          try {
            connInfo.peer.send(JSON.stringify(msg));
            // Reset stale count to avoid spamming
            this._staleCycles[pubKeyB64] = { audio: 0, video: 0 };
          } catch (e: any) {
            console.error('Failed to send request-track-refresh:', e.toString());
          }
        }
      } catch (e) {
        // getStats may fail if connection was already closed
      }
    }
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
          case 'InitRequest':
            await this.handleInitRequest(signal);
            break;
          case 'InitAccept':
            await this.handleInitAccept(signal);
            break;
          case 'SdpData':
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
          case 'ModuleState':
            this.handleModuleState(signal);
            break;
          case 'ModuleData':
            this.handleModuleData(signal);
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

    // Extract the sender's ping timestamp so we can echo it back for RTT.
    // Old peers send an empty payload — pingT0 stays undefined in that case.
    let pingT0: number | undefined;
    if (signal.payload && signal.payload.length > 0) {
      try {
        const parsed = JSON.parse(signal.payload);
        if (typeof parsed?.t0 === 'number') pingT0 = parsed.t0;
      } catch {}
    }

    if (pubkeyB64 !== this.myPubKeyB64) {
      const metaData: PongMetaData<PongMetaDataV1> = {
        formatVersion: 1,
        data: {
          connectionStatuses: get(this._connectionStatuses),
          screenShareConnectionStatuses: this.screenShareStream
            ? get(this._screenShareConnectionStatuses)
            : undefined,
          knownAgents: get(this._knownAgents),
          peerLinks: this._buildPeerLinks(),
          appVersion: __APP_VERSION__,
          streamInfo,
          audio: get(this._openConnections)[pubkeyB64]?.audio,
          pingT0,
          moduleStates: Object.keys(get(this._myModuleStates)).length > 0
            ? get(this._myModuleStates)
            : undefined,
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

    // Clear lastSeen so agent immediately drops from _activeAgents (pane
    // removal). Same observable as "never joined" — both surface as
    // `absent` from this observer's view.
    this._knownAgents.update(agents => {
      if (agents[pubkeyB64]) {
        agents[pubkeyB64] = { ...agents[pubkeyB64], lastSeen: undefined };
      }
      return agents;
    });

    // Destroy video connection
    const openConn = get(this._openConnections)[pubkeyB64];
    if (openConn) {
      openConn.peer.destroy();
      this._openConnections.update(v => { delete v[pubkeyB64]; return v; });
    }

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
    delete this._pendingInits[pubkeyB64];
    delete this._pendingAccepts[pubkeyB64];
    delete this._pendingScreenShareInits[pubkeyB64];
    delete this._pendingScreenShareAccepts[pubkeyB64];

    // Mark as disconnected
    this.updateConnectionStatus(pubkeyB64, { type: 'Disconnected' });
    this.updateScreenShareConnectionStatus(pubkeyB64, { type: 'Disconnected' });

    // Clean up module states for this peer (capture pre-image for transition dispatch)
    const peerModulesAtLeave = get(this._peerModuleStates)[pubkeyB64] || {};
    this._peerModuleStates.update(all => {
      const updated = { ...all };
      delete updated[pubkeyB64];
      return updated;
    });
    for (const [moduleId, envelope] of Object.entries(peerModulesAtLeave)) {
      this._dispatchPeerModuleTransition(pubkeyB64, moduleId, envelope, null);
    }

    // Fire event so UI updates (peer-leave = agent left the room, distinct from WebRTC disconnect)
    this.eventCallback({ type: 'peer-leave', pubKeyB64: pubkeyB64 });
  }

  /**
   * If we get a PongUI we do the following:
   *
   * - Update our stored metadata for this agent
   * - Send a video InitRequest if necessary
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

      // Compute signals-carrier RTT from the echoed ping timestamp.
      // Smooth with EWMA so single-cycle jitter doesn't make the display
      // jump around. Alpha = 0.3 gives ~3-sample effective window.
      if (typeof metaData.data.pingT0 === 'number') {
        const rtt = Date.now() - metaData.data.pingT0;
        if (rtt >= 0 && rtt < 60000) {
          const prev = this._signalsRttEwma.get(pubkeyB64) ?? rtt;
          const next = Math.round(0.3 * rtt + 0.7 * prev);
          this._signalsRttEwma.set(pubkeyB64, next);
          const existing = this.signalsStats.get(pubkeyB64) ?? {
            rttMs: null, jitterMs: null, lossPercent: null,
          };
          existing.rttMs = next;
          this.signalsStats.set(pubkeyB64, existing);
        }
      } else {
        // Peer on old code — their pong doesn't echo pingT0 yet.
        console.debug(
          `[stats] No pingT0 in pong from ${pubkeyB64.slice(0, 8)} — remote may be on older code`
        );
      }
      this._othersConnectionStatuses.update(statuses => {
        const newStatuses = statuses;
        newStatuses[pubkeyB64] = {
          lastUpdated: now,
          statuses: metaData.data.connectionStatuses,
          screenShareStatuses: metaData.data.screenShareConnectionStatuses,
          knownAgents: metaData.data.knownAgents,
          perceivedStreamInfo: metaData.data.streamInfo,
          peerLinks: metaData.data.peerLinks,
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
      // Reconcile module states from pong for late-joiners
      if (metaData.data.moduleStates) {
        const current = get(this._peerModuleStates)[pubkeyB64] || {};
        const prevSnapshot = { ...current };
        const incoming = metaData.data.moduleStates;
        let changed = false;
        const merged = { ...current };
        for (const [moduleId, envelope] of Object.entries(incoming)) {
          if (!merged[moduleId] ||
              (envelope.updatedAt > merged[moduleId].updatedAt &&
               (envelope.payload !== merged[moduleId].payload || envelope.active !== merged[moduleId].active))) {
            merged[moduleId] = envelope;
            changed = true;
          }
        }
        // Remove modules no longer in pong (agent deactivated them)
        for (const moduleId of Object.keys(merged)) {
          if (!incoming[moduleId]) {
            delete merged[moduleId];
            changed = true;
          }
        }
        if (changed) {
          this._peerModuleStates.update(all => ({ ...all, [pubkeyB64]: merged }));
          // Fire transition + payload-change callbacks for affected modules
          const allIds = new Set([...Object.keys(prevSnapshot), ...Object.keys(merged)]);
          for (const moduleId of allIds) {
            const prevEnv = prevSnapshot[moduleId] || null;
            const nextEnv = merged[moduleId] || null;
            this._dispatchPeerModuleTransition(pubkeyB64, moduleId, prevEnv, nextEnv);
            this._dispatchPeerModulePayloadChange(pubkeyB64, moduleId, prevEnv, nextEnv);
          }
        }
      } else {
        // No module states in pong — clear any we had for this peer
        const cleared = get(this._peerModuleStates)[pubkeyB64];
        if (cleared && Object.keys(cleared).length > 0) {
          this._peerModuleStates.update(all => {
            const updated = { ...all };
            delete updated[pubkeyB64];
            return updated;
          });
          for (const [moduleId, envelope] of Object.entries(cleared)) {
            this._dispatchPeerModuleTransition(pubkeyB64, moduleId, envelope, null);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to parse pong meta data.');
    }

    /**
     * Normal video/audio stream
     *
     * If our agent puglic key is alphabetically "higher" than the agent public key
     * sending the pong and there is no open connection yet with this agent and there is
     * no pending InitRequest from less than 5 seconds ago (and we therefore have to
     * assume that a remote signal got lost), send an InitRequest.
     *
     * Only initiate if the conversation module is active (i.e., we want WebRTC).
     */
    const conversationActive = !!get(this._myModuleStates)['conversation'];

    // Per-peer WebRTC override: if either side has disabled WebRTC for
    // this link, skip the entire init/retry path. Audio will flow over
    // Holochain remote signals automatically (Step 3 carrier routing).
    const peerWebrtcDisabled = this.webrtcDisabled(pubkeyB64);

    // Clean up stale video connection if the underlying WebRTC is dead.
    // This allows the normal initiation flow to proceed for a re-joining peer.
    const existingConn = get(this._openConnections)[pubkeyB64];
    if (existingConn) {
      const pc = (existingConn.peer as any)._pc as RTCPeerConnection | undefined;
      const iceState = pc?.iceConnectionState;
      if (iceState === 'disconnected' || iceState === 'failed' || iceState === 'closed') {
        console.log(`#### CLEANING UP STALE VIDEO CONNECTION TO ${pubkeyB64.slice(0, 8)} (ICE: ${iceState})`);
        this.logger.logCustomMessage(`Stale cleanup [${pubkeyB64.slice(0, 8)}]: ICE=${iceState}`);
        this.logger.logAgentEvent({
          agent: pubkeyB64,
          timestamp: Date.now(),
          event: 'StaleCleanup',
          connectionId: existingConn.connectionId,
        });
        existingConn.peer.destroy();
        this._openConnections.update(v => { delete v[pubkeyB64]; return v; });
        delete this._pendingInits[pubkeyB64];
        delete this._videoStreams[pubkeyB64];
      }
    }

    // alreadyOpen here does not include the case where SDP exchange is already ongoing
    // but no actual connection has happened yet
    const alreadyOpen = get(this._openConnections)[pubkeyB64];

    // Only initiate/manage WebRTC video connections when conversation
    // module is active AND WebRTC is not disabled for this peer.
    if (conversationActive && !peerWebrtcDisabled && !this.webrtcGloballyDisabled) {
      const pendingInits = this._pendingInits[pubkeyB64];
      if (!alreadyOpen && pubkeyB64 < this.myPubKeyB64) {
        if (!pendingInits) {
          console.log('#### SENDING FIRST INIT REQUEST.');
          const lastDisconnect = this._lastDisconnectTime[pubkeyB64];
          if (lastDisconnect) {
            const gap = Date.now() - lastDisconnect;
            this.logger.logCustomMessage(
              `Retry gap [${pubkeyB64.slice(0, 8)}]: ${gap}ms since last disconnect (initiator)`
            );
          }
          const newConnectionId = uuidv4();
          this._pendingInits[pubkeyB64] = [
            { connectionId: newConnectionId, t0: now },
          ];
          await this.roomClient.sendMessage(
            [signal.from_agent],
            'InitRequest',
            JSON.stringify({ connection_id: newConnectionId, connection_type: 'video' }),
          );
          this.updateConnectionStatus(pubkeyB64, { type: 'InitSent' });
        } else {
          console.log(
            `#--# SENDING INIT REQUEST NUMBER ${pendingInits.length + 1}.`
          );
          const latestInit = pendingInits.sort(
            (init_a, init_b) => init_b.t0 - init_a.t0
          )[0];
          if (now - latestInit.t0 > INIT_RETRY_THRESHOLD) {
            const newConnectionId = uuidv4();
            pendingInits.push({ connectionId: newConnectionId, t0: now });
            this._pendingInits[pubkeyB64] = pendingInits;
            await this.roomClient.sendMessage(
              [signal.from_agent],
              'InitRequest',
              JSON.stringify({ connection_id: newConnectionId, connection_type: 'video' }),
            );
            this.updateConnectionStatus(pubkeyB64, { type: 'InitSent' });
          }
        }
      } else if (!alreadyOpen && !pendingInits) {
        this.updateConnectionStatus(pubkeyB64, { type: 'AwaitingInit' });
      } else if (alreadyOpen && metaDataExt?.data.streamInfo) {
        // If the connection is already open, reconcile with our expected stream state
        this.reconcileVideoStreamState(pubkeyB64, metaDataExt.data.streamInfo);
      }
    }

    // Check whether they have the right expectation of our audio state and if not,
    // send an audio-off signal
    if (alreadyOpen && metaDataExt?.data.audio) {
      if (!this.mainStream?.getAudioTracks()[0]?.enabled) {
        const msg: RTCMessage = {
          type: 'action',
          message: 'audio-off',
        };
        try {
          alreadyOpen.peer.send(JSON.stringify(msg));
        } catch (e: any) {
          console.error(
            'Failed to send audio-off message to peer: ',
            e.toString()
          );
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
   * Handle an InitRequest signal
   *
   * @param signal
   */
  async handleInitRequest(
    signal: Extract<RoomSignal, { type: 'Message' }>
  ) {
    const pubKey64 = encodeHashToBase64(signal.from_agent);
    const { connection_id, connection_type } = JSON.parse(signal.payload) as InitPayload;
    this.logger.logAgentEvent({
      agent: pubKey64,
      timestamp: Date.now(),
      event: 'InitRequest',
      connectionId: connection_id,
    });
    console.log(
      `#### GOT ${
        connection_type === 'screen' ? 'SCREEN SHARE ' : ''
      }INIT REQUEST.`
    );

    // Log retry gap if this is a reconnection attempt
    const lastDisconnect = this._lastDisconnectTime[pubKey64];
    if (lastDisconnect) {
      const gap = Date.now() - lastDisconnect;
      this.logger.logCustomMessage(
        `Retry gap [${pubKey64.slice(0, 8)}]: ${gap}ms since last disconnect`
      );
    }

    /**
     * InitRequests for normal audio/video stream
     *
     * Only accept init requests from agents who's pubkey is alphabetically  "higher" than ours
     */
    if (connection_type === 'video' && pubKey64 > this.myPubKeyB64) {
      // Reject if WebRTC is globally disabled or disabled for this peer.
      if (this.webrtcGloballyDisabled || this.webrtcDisabled(pubKey64)) {
        console.log(`#### IGNORING INIT REQUEST from ${pubKey64.slice(0, 8)}: WebRTC disabled`);
        return;
      }
      console.log(
        '#### SENDING INIT ACCEPT. connection_type: ',
        connection_type
      );
      console.log('#### Creating normal peer');
      const newPeer = this.createPeer(
        signal.from_agent,
        connection_id,
        false
      );

      // Add stream before processing the offer so our tracks are included in the answer.
      // This prevents the non-initiator from needing to renegotiate post-connect.
      if (this.mainStream) {
        newPeer.addStream(this.mainStream);
        this.logger.logCustomMessage(
          `addStream pre-SDP [${pubKey64.slice(0, 8)}]: ${this.mainStream.getTracks().length} tracks (acceptor)`
        );
      }

      const accept: PendingAccept = {
        connectionId: connection_id,
        peer: newPeer,
        createdAt: Date.now(),
      };
      const allPendingAccepts = this._pendingAccepts;
      const pendingAcceptsForAgent = allPendingAccepts[pubKey64];
      const newPendingAcceptsForAgent: PendingAccept[] = pendingAcceptsForAgent
        ? [...pendingAcceptsForAgent, accept]
        : [accept];
      allPendingAccepts[pubKey64] = newPendingAcceptsForAgent;
      this._pendingAccepts = allPendingAccepts;
      await this.roomClient.sendMessage(
        [signal.from_agent],
        'InitAccept',
        JSON.stringify({ connection_id, connection_type }),
      );
      this.updateConnectionStatus(pubKey64, { type: 'AcceptSent' });
    }

    /**
     * InitRequests for incoming screen shares
     */
    if (connection_type === 'screen') {
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
  }

  /**
   * Handle an InitAccept signal
   *
   * @param signal
   */
  async handleInitAccept(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubKey64 = encodeHashToBase64(signal.from_agent);
    const { connection_id, connection_type } = JSON.parse(signal.payload) as InitPayload;
    this.logger.logAgentEvent({
      agent: pubKey64,
      timestamp: Date.now(),
      event: 'InitAccept',
      connectionId: connection_id,
    });
    /**
     * For normal video/audio connections
     *
     * If there is no open connection with this agent yet and the connectionId
     * is one matching an InitRequest we sent earlier, create a Simple Peer
     * Instance and add it to open connections, then delete all PendingInits
     * for this agent.
     *
     */
    if (connection_type === 'video') {
      const agentPendingInits = this._pendingInits[pubKey64];
      if (!Object.keys(get(this._openConnections)).includes(pubKey64)) {
        if (!agentPendingInits) {
          console.warn(
            `Got a video InitAccept from an agent (${pubKey64}) for which we have no pending init stored.`
          );
          return;
        }
        if (
          agentPendingInits
            .map(pendingInit => pendingInit.connectionId)
            .includes(connection_id)
        ) {
          // Measure signaling round-trip time
          const matchingInit = agentPendingInits.find(
            pi => pi.connectionId === connection_id
          );
          if (matchingInit) {
            const rtt = Date.now() - matchingInit.t0;
            this.logger.logCustomMessage(
              `Signaling RTT [${pubKey64.slice(0, 8)}]: ${rtt}ms`
            );
          }

          console.log('#### RECEIVED INIT ACCEPT AND CEATING INITIATING PEER.');
          const newPeer = this.createPeer(
            signal.from_agent,
            connection_id,
            true
          );

          // Add stream before SDP exchange so tracks are included in the initial offer.
          // This prevents the need for post-connect renegotiation on the initiator side.
          if (this.mainStream) {
            newPeer.addStream(this.mainStream);
            this.logger.logCustomMessage(
              `addStream pre-SDP [${pubKey64.slice(0, 8)}]: ${this.mainStream.getTracks().length} tracks (initiator)`
            );
          }

          this._openConnections.update(currentValue => {
            const openConnections = currentValue;
            openConnections[pubKey64] = {
              connectionId: connection_id,
              peer: newPeer,
              video: false,
              audio: false,
              connected: false,
              direction: 'duplex',
            };
            return openConnections;
          });

          delete this._pendingInits[pubKey64];

          this.updateConnectionStatus(pubKey64, { type: 'SdpExchange' });

          // SDP exchange timeout: if still not connected after 15s, clean up and retry
          setTimeout(() => {
            const currentStatus = get(this._connectionStatuses)[pubKey64];
            if (currentStatus && currentStatus.type === 'SdpExchange') {
              this.logger.logCustomMessage(
                `SDP timeout [${pubKey64.slice(0, 8)}]: destroying stale connection`
              );
              const conn = get(this._openConnections)[pubKey64];
              if (conn && !conn.connected) {
                conn.peer.destroy();
                this._openConnections.update(current => {
                  delete current[pubKey64];
                  return current;
                });
              }
              this.updateConnectionStatus(pubKey64, { type: 'Disconnected' });
            }
          }, SDP_EXCHANGE_TIMEOUT);
        }
      }
    }

    /**
     * For screen share connections
     *
     * If there is no open connection with this agent yet and the connectionId
     * is one matching an InitRequest we sent earlier, create a Simple Peer
     * Instance and add it to open connections, then delete all PendingInits
     * for this agent
     */
    if (connection_type === 'screen') {
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
  }

  /**
   * Handle an SdpData signal
   *
   * @param signal
   */
  async handleSdpData(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    const { connection_id, data } = JSON.parse(signal.payload) as SdpPayload;
    console.log(`## Got SDP Data from : ${pubkeyB64}:\n`, data);

    // Log the SDP sub-type for diagnostics
    try {
      const sdpContent = JSON.parse(data);
      const sdpType = sdpContent.type || 'candidate';
      this.logger.logCustomMessage(
        `SDP ${sdpType} [${pubkeyB64.slice(0, 8)}] connId=${connection_id.slice(0, 8)}`
      );
    } catch {
      // ignore parse errors for logging
    }

    this.logger.logAgentEvent({
      agent: pubkeyB64,
      timestamp: Date.now(),
      event: 'SdpData',
      connectionId: connection_id,
    });

    // Update connection status
    this.updateConnectionStatus(pubkeyB64, { type: 'SdpExchange' });

    /**
     * Normal video/audio connections
     */
    const maybeOpenConnection = get(this._openConnections)[pubkeyB64];
    if (
      maybeOpenConnection &&
      maybeOpenConnection.connectionId === connection_id
    ) {
      maybeOpenConnection.peer.signal(JSON.parse(data));
    } else {
      /**
       * If there is no open connection yet but a PendingAccept then move that
       * PendingAccept to the open connections and destroy all other
       * Peer Instances for PendingAccepts of this agent and delete the
       * PendingAccepts
       */
      const allPendingAccepts = this._pendingAccepts;
      const pendingAcceptsForAgent = allPendingAccepts[pubkeyB64];
      if (pendingAcceptsForAgent) {
        const maybePendingAccept = pendingAcceptsForAgent.find(
          pendingAccept => pendingAccept.connectionId === connection_id
        );
        if (maybePendingAccept) {
          maybePendingAccept.peer.signal(JSON.parse(data));
          console.log(
            '#### FOUND PENDING ACCEPT! Moving to open connections...'
          );
          this._openConnections.update(currentValue => {
            const openConnections = currentValue;
            openConnections[pubkeyB64] = {
              connectionId: connection_id,
              peer: maybePendingAccept.peer,
              video: false,
              audio: false,
              connected: false,
              direction: 'duplex',
            };
            return openConnections;
          });
          const otherPendingAccepts = pendingAcceptsForAgent.filter(
            pendingAccept => pendingAccept.connectionId !== connection_id
          );
          otherPendingAccepts.forEach(pendingAccept =>
            pendingAccept.peer.destroy()
          );

          delete this._pendingAccepts[pubkeyB64];
        }
      } else {
        console.warn(
          `Got SDP data from agent (${pubkeyB64}) but no pending accepts exist for this agent. Discarding as stale.`
        );
      }
    }

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
