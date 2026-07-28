import {
  AgentPubKey,
  AgentPubKeyB64,
  decodeHashFromBase64,
  encodeHashToBase64,
} from '@holochain/client';
import { SimplePeerTransport, FsmTransport, DEFAULT_ICE_SERVERS } from './transport';
import type { TransportEvent, PeerTransport } from './transport';
import { decideAutoFlip, decideCarrierSwitch, resolveWebrtcImpl } from './transport/auto-flip-policy';
import { routeTransportPhase } from './transport/media-event-policy';
import { computeSignalsTargets } from './transport/carrier-coverage';
import { decideStaleConnectionCleanup } from './transport/stale-connection-policy';
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
  conversationPayloadCaps,
  parseConversationPayload,
} from './room/modules/conversation';
import { CAP_SDP_FSM, isSignalMsgType } from './transport/wire-contract';
import { RoomClient } from './room/room-client';
import { RoomStore } from './room/room-store';
import { PresenceLogger } from './logging';
import { MicSource, MicAcquireResult } from './mic-source';
import { CameraSource, CameraAcquireResult } from './camera-source';
import { voiceController } from './room/modules/voice';
import { filmstripController } from './room/modules/video-filmstrip';
import { getStreamInfo } from './utils';
import { parseSignalPayload } from './signal-payload';

declare const __APP_VERSION__: string;

/**
 * Timeout in ms for the SDP exchange phase. If a connection does not progress
 * from SdpExchange to Connected within this duration, the stale peer is destroyed
 * and the connection is reset to Disconnected so the next ping/pong cycle can retry.
 */
const SDP_EXCHANGE_TIMEOUT = 15000;

/**
 * How long an established peer may sit in iceConnectionState 'disconnected'
 * before stale-cleanup tears it down. WebRTC treats 'disconnected' as
 * recoverable: it keeps probing the active candidate pair and may transition
 * back to 'connected' if the path heals (e.g. brief packet loss, NAT mapping
 * that resettles). Tearing down at the first 'disconnected' aborts that
 * recovery and forces a full InitRequest/SDP/ICE cycle on both sides; with
 * no relay candidate available, the new attempt frequently lands on the same
 * broken path and fails the same way. We give ICE this window to recover
 * before giving up. 'failed' and 'closed' are still acted on immediately.
 *
 * Note: when a peer is using the FSM transport, the FSM itself runs an
 * internal grace of the same duration (configurable via
 * ConnectionConfig.iceDisconnectedGraceMs, default 15s). The two graces are
 * independent — both delay teardown — so the streams-store grace is also
 * needed to prevent stale-cleanup from destroying an FSM-managed peer
 * mid-recovery.
 */
const ICE_DISCONNECTED_GRACE_MS = 15000;

/**
 * If an InitRequest does not succeed within this duration (ms) another InitRequest will be sent
 */
const INIT_RETRY_THRESHOLD = 5000;

export const PING_INTERVAL = 2000;

/**
 * A peer with media frames received within this window on the signals
 * carrier (voice or filmstrip video) — or with a connected WebRTC
 * connection — is treated as present regardless of ping/pong staleness.
 * Holochain-signal ping/pong can go stale (>3*PING_INTERVAL) during a
 * signal-relay hiccup while media keeps flowing fine; without this the
 * peer's pane would be wrongly removed. See `isPeerMediaLive`.
 */
const MEDIA_LIVE_WINDOW_MS = 3000;

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

  _pageLifecycleUnsub: (() => void) | null = null;

  // ICE/TURN settings live in localStorage and are edited from the Settings
  // panel. Read them live (not snapshotted at construction) so edits take
  // effect on the next connection without a reload. iceConfig / the transport
  // trickle getters consult these on every ensureConnection.
  get trickleICE(): boolean {
    // Stored as 'true'/'false'; default ON when unset.
    return window.localStorage.getItem('trickleICE') !== 'false';
  }

  get turnUrl(): string {
    return window.localStorage.getItem('turnUrl') || '';
  }

  get turnUsername(): string {
    return window.localStorage.getItem('turnUsername') || '';
  }

  get turnCredential(): string {
    return window.localStorage.getItem('turnCredential') || '';
  }

  // Cloudflare-provisioned TURN. Stored under separate keys from the manual
  // TURN server so both can be offered as ICE candidates simultaneously (the
  // ICE agent gathers relay candidates from every configured server). Written
  // by the Settings panel's auto-provisioning; read live here.
  get cfTurnUrl(): string {
    return window.localStorage.getItem('cfTurnUrl') || '';
  }

  get cfTurnUsername(): string {
    return window.localStorage.getItem('cfTurnUsername') || '';
  }

  get cfTurnCredential(): string {
    return window.localStorage.getItem('cfTurnCredential') || '';
  }

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
   * Transport-agnostic camera owner. Mirrors `micSource` for video.
   * Consumers (WebRTC video, the `video-filmstrip` module) acquire a
   * track from it rather than calling getUserMedia themselves. See
   * ui/src/camera-source.ts for the full rationale.
   *
   * Note: unlike MicSource, the binding does NOT do peer-side fanout in
   * its open/close branches. videoOn/videoOff own the keepalive-aware
   * peer wiring directly because the keepalive replaceTrack pattern
   * (NAT-keepalive on videoOff, replaceTrack on videoOn) doesn't fit
   * cleanly into a generic open/close handler.
   */
  cameraSource: CameraSource;

  /**
   * Whether the voice encoder is currently running (sending audio to
   * peers without WebRTC via Holochain signals). Driven by
   * `_reconcileSignalsAudio` — starts when mic is held AND at least one
   * peer is in `_signalsTargets`; stops when either condition drops.
   */
  private _voiceEncoderRunning = false;

  /**
   * Whether the filmstrip encoder is currently running (sending video
   * clips to peers via signals). Driven by `_reconcileSignalsVideo` —
   * starts when the camera is held AND at least one peer is in
   * `_signalsTargets`; stops when either drops.
   */
  private _filmstripEncoderRunning = false;

  /** Unsubscribe from the _signalsTargets subscription. */
  private _signalsTargetsUnsub: (() => void) | null = null;

  /**
   * Release handle held by the WebRTC audio path. Populated on `audioOn`,
   * cleared on full release. `audioOff` does NOT release — it just calls
   * `micSource.setMuted(true)` so the track stays alive for fast
   * re-enable without WebRTC renegotiation.
   */
  private _webrtcMicHandle: MicAcquireResult | null = null;

  /**
   * Release handle held by the WebRTC video path. Populated on `videoOn`,
   * cleared on `videoOff`. Unlike audio, video off IS the release path —
   * the existing semantics stop the camera (LED off when refcount hits
   * 0), so there's no mute-vs-off split. Held alongside the keepalive
   * track on the senders, which stays put across videoOff/videoOn cycles
   * to preserve the m-line / RTCRtpSender.
   */
  private _webrtcCameraHandle: CameraAcquireResult | null = null;

  /**
   * WebRTC transports. Three instances by purpose:
   *  - mediaTransport: bidirectional mic+camera (one connection per peer).
   *  - screenShareOutTransport: outgoing screen share (we are the sharer).
   *  - screenShareInTransport: incoming screen share (we are the recipient).
   *
   * All three signal over the same Holochain 'SdpData' message type;
   * connectionId discriminates which transport a signal belongs to (each
   * transport drops signals whose connectionId it doesn't recognise).
   */
  mediaTransport!: SimplePeerTransport;
  screenShareOutTransport!: SimplePeerTransport;
  screenShareInTransport!: SimplePeerTransport;
  /**
   * FSM-flavored media transport (Phase 2). Selected per-peer via the
   * conversation module's `webrtcImpl` / `fsmWith` payload, with symmetric
   * union (if either side picks `'fsm'`, both use it). Signals flow on
   * the `SdpFsm` Holochain message type so the SimplePeer/FSM signaling
   * channels can't collide. Screen share stays SimplePeer-only for now.
   */
  mediaTransportFsm!: FsmTransport;

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
    // trickleICE / turnUrl / turnUsername / turnCredential are read live from
    // localStorage via getters, so there is nothing to snapshot here.
    this.webrtcGloballyDisabled = window.localStorage.getItem('disableAllWebrtc') === 'true';
    const signalDelay = window.localStorage.getItem('signalDelayMs');
    if (signalDelay) {
      this.signalDelayMs = parseInt(signalDelay, 10) || 0;
    }
    // Signals is the complement of *WebRTC carrying media*, not of *a
    // WebRTC attempt existing*. Decision and rationale live in
    // `transport/carrier-coverage.ts`.
    this._signalsTargets = derived(
      [this._activeAgents, this._openConnections],
      ([active, connections]) =>
        computeSignalsTargets({
          activeAgents: Object.keys(active),
          openConnections: connections,
        }),
    );

    // Construct transports. iceServers / trickleICE are getters so the
    // transport always uses the current values (TURN credentials, trickle
    // toggle, etc. can change at runtime).
    const sendSdpData = (toAgent: AgentPubKey, connectionId: string, data: unknown) => {
      this.roomClient.sendMessage(
        [toAgent],
        'SdpData',
        JSON.stringify({ connection_id: connectionId, data: JSON.stringify(data) }),
      );
    };

    const transportOpts = (
      kind: 'media' | 'screen-out' | 'screen-in',
    ) => ({
      myAgentId: this.myPubKeyB64,
      iceServers: () => this.iceConfig,
      trickleICE: () => this.trickleICE,
      iceTransportPolicy: () => this._readIceTransportPolicy(),
      onOutgoingSignal: (signal: { to: AgentPubKeyB64; connectionId: string; data: unknown }) => {
        const toAgent = decodeHashFromBase64(signal.to);
        sendSdpData(toAgent, signal.connectionId, signal.data);
      },
      _kind: kind, // unused at runtime, just for readability when debugging
    });

    this.mediaTransport = new SimplePeerTransport(transportOpts('media'));
    this.screenShareOutTransport = new SimplePeerTransport(transportOpts('screen-out'));
    this.screenShareInTransport = new SimplePeerTransport(transportOpts('screen-in'));

    // FSM media transport. Outgoing signals carry an FSM-shaped envelope
    // (type/payload) wrapped on the wire as 'SdpFsm'; incoming 'SdpFsm'
    // signals route here via handleSdpFsm.
    this.mediaTransportFsm = new FsmTransport({
      myAgentId: this.myPubKeyB64,
      iceServers: () => this.iceConfig,
      trickleICE: () => this.trickleICE,
      iceTransportPolicy: () => this._readIceTransportPolicy(),
      // The DTLS watchdog's default 5s is too aggressive on lossy / high-RTT
      // last-mile uplinks (a handshake there can need several seconds of
      // retransmits); a single stall tore the connection down to the lossy
      // signals carrier and churned reconnects. Raise to a viable default,
      // user-overridable via localStorage('dtlsStallTimeoutMs').
      configOverrides: {
        dtlsStallTimeoutMs: this._readDtlsStallTimeoutMs(),
      },
      onOutgoingSignal: (signal) => {
        const toAgent = decodeHashFromBase64(signal.to);
        this.roomClient.sendMessage(
          [toAgent],
          'SdpFsm',
          JSON.stringify({
            connection_id: signal.connectionId,
            peer_session_id: signal.peerSessionId,
            epoch: signal.epoch,
            data: signal.data,
          }),
        );
      },
      onTransition: (entry) => this._logFsmTransition(entry),
    });

    // Subscribe transport events to the application-level handlers.
    this._subscribeMediaTransport();
    this._subscribeMediaFsmTransport();
    this._subscribeScreenShareTransport(this.screenShareOutTransport, true);
    this._subscribeScreenShareTransport(this.screenShareInTransport, false);

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

    this.cameraSource = new CameraSource({
      getDeviceId: () => get(this._videoInputId),
      setDeviceId: id => this._videoInputId.set(id),
      onTrackChange: (newTrack, oldTrack) => {
        this._onCameraTrackChange(newTrack, oldTrack);
      },
    });

    // Bind controllers permanently so the receive side (decoders /
    // playback) works regardless of whether the local mic / camera is
    // on. Send sides are gated by the reconcilers. Unbind happens in
    // disconnect().
    voiceController.bind(this);
    filmstripController.bind(this);

    // Subscribe to _signalsTargets changes. When the set transitions
    // between empty and non-empty while the mic / camera is held, start
    // or stop the corresponding signals-carrier encoder. The subscription
    // fires on every _activeAgents or _openConnections change; the
    // reconcilers are cheap (a boolean check + set size).
    this._signalsTargetsUnsub = this._signalsTargets.subscribe(() => {
      this._reconcileSignalsAudio();
      this._reconcileSignalsVideo();
    });
  }

  // ---------------------------------------------------------------------------
  // Transport event subscription
  //
  // The application-level handling of per-peer lifecycle events that used to
  // live inside createPeer / createScreenSharePeer peer.on(...) closures now
  // lives here, dispatched off the transport's TransportEvent stream. Each
  // event carries { peer: AgentPubKeyB64, connectionId } so the supersede
  // guards (matching connectionId in _openConnections / _screenShareConnections*)
  // continue to gate cleanup against zombie connections.
  // ---------------------------------------------------------------------------
  private _subscribeMediaTransport(): void {
    this.mediaTransport.onAny((event: TransportEvent) => {
      this._dispatchMediaEvent(event, 'simplepeer');
    });
  }

  private _subscribeMediaFsmTransport(): void {
    this.mediaTransportFsm.onAny((event: TransportEvent) => {
      this._dispatchMediaEvent(event, 'fsm');
    });
  }

  private _dispatchMediaEvent(event: TransportEvent, impl: 'simplepeer' | 'fsm'): void {
    switch (event.type) {
      case 'connection-state-change': {
        // Routing lives in `routeTransportPhase` (transport/media-event-policy.ts),
        // whose switch is exhaustive over ConnectionPhase. This used to be an
        // if/else-if over three of eight phases with no else; the five it
        // dropped included `failed`, which is how a peer ended up with a
        // `connected: true` slot over a destroyed pc — a rendered pane on a
        // dead link plus permanent exclusion from `_signalsTargets`.
        const route = routeTransportPhase({
          phase: event.phase,
          impl,
          connectionId: event.connectionId,
          openConnectionId: get(this._openConnections)[event.peer]?.connectionId,
        });
        switch (route.handler) {
          case 'start-ice-monitor':
            if (route.slot.action === 'adopt') {
              // The FSM behind the slot's connectionId was replaced in place
              // by ConnectionManager (higher-epoch offer, or a new remote
              // session) via `fsm.destroy()`, which emits no transition — so
              // no `closed` ever reached us for it. Re-point the slot at the
              // live connection; leaving the stale id would make every later
              // connect/close for this peer hit its supersede guard, and a
              // slot that was `connected: true` at replacement would stay
              // that way forever. Mirrors the initiator path's supersede
              // handling in `handleInitAccept`.
              this.logger.logAgentEvent({
                agent: event.peer,
                timestamp: Date.now(),
                event: 'Superseded',
                connectionId: route.slot.supersedes,
                detail: `superseded-by=${event.connectionId}; path=transport-replace`,
              });
              this._stopMediaIceMonitor(event.peer, route.slot.supersedes);
              // Keyed to the old connection; the new monitor sets its own.
              delete this._iceDisconnectedAt[event.peer];
            }
            this._startMediaIceMonitor(event.peer, event.connectionId, impl);
            if (route.slot.action !== 'keep') {
              // `install`: FSM acceptor path — an incoming offer creates an
              // FSM without streams-store knowing in advance, so the slot
              // has to exist for later connect/stream events to mutate.
              // `adopt`: same write, replacing a slot whose connection is
              // gone. Both start from `connected: false`, which is the
              // truth in either case.
              this._openConnections.update(currentValue => {
                currentValue[event.peer] = {
                  connectionId: event.connectionId,
                  video: false,
                  audio: false,
                  connected: false,
                  direction: 'duplex',
                };
                return currentValue;
              });
              this.updateConnectionStatus(event.peer, { type: 'SdpExchange' });
            }
            break;
          case 'media-connected':
            this._handleMediaConnected(event.peer, event.connectionId, impl);
            break;
          case 'media-closed':
            this._handleMediaClosed(
              event.peer,
              event.connectionId,
              impl,
              `${event.phase}/${route.reason}`,
            );
            break;
          case 'ignore':
            break;
        }
        break;
      }
      case 'remote-stream':
        this._handleMediaRemoteStream(event.peer, event.connectionId, event.stream);
        break;
      case 'remote-track':
        this._handleMediaRemoteTrack(
          event.peer,
          event.connectionId,
          event.track,
          event.stream,
        );
        break;
      case 'data-channel-message':
        this._handleMediaDataChannelMessage(event.peer, event.data);
        break;
      case 'establishment-timeline':
        this._handleEstablishmentTimeline(event.peer, event.connectionId, event.timeline);
        break;
      case 'error':
        this._handleMediaError(event.peer, event.connectionId, event.error, impl);
        break;
    }
  }

  /**
   * Log the FSM-authoritative establishment timeline (library §6.6 one-shot
   * event) as a single `FsmEstablishmentTimeline` forensic record. Distinct
   * from the manual `IceEstablishment` path (`_emitIceEstablishment`), which
   * reaches into the pc and only sees ICE/gather: this carries the FSM's own
   * per-stage milestones (ICE / DTLS / connected / data-channel) plus whether
   * the attempt was a reconnect — the breakdown the flash investigation needs
   * to see which stage stalls. FSM transport only; SimplePeer never emits it.
   */
  private _handleEstablishmentTimeline(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    timeline: import('@lightningrodlabs/webrtc-peer').EstablishmentTimeline,
  ): void {
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: Date.now(),
      event: 'FsmEstablishmentTimeline',
      connectionId,
      detail:
        `ice=${timeline.iceMs ?? -1} dtls=${timeline.dtlsMs ?? -1} ` +
        `connected=${timeline.connectedMs} dc=${timeline.dataChannelMs ?? -1} ` +
        `reconnect=${timeline.wasReconnect} session=${timeline.peerSessionId}`,
    });
  }

  /**
   * Effective WebRTC implementation for the link between us and `peerB64`.
   *
   * Resolution order:
   *  0. If the peer's build has not declared (or, for pre-caps builds, is
   *     not inferred to hold) the `sdp-fsm` capability, the link is
   *     `'simplepeer'` regardless of anything either side prefers. See
   *     `conversationPayloadCaps`.
   *  1. If either side has set a per-peer override (`peerImpl[other]`), the
   *     override applies. If both sides override and disagree, `'fsm'` wins
   *     — it has the marginal-NAT machinery (Perfect Negotiation, session-
   *     ID stale-signal rejection, quadratic backoff) that auto-flip-driven
   *     disagreements tend to need. See WEBRTC_CARRIER_ANALYSIS.md.
   *  2. Otherwise the global default applies — `'fsm'` if either side has
   *     `webrtcImpl: 'fsm'`, else `'simplepeer'`.
   */
  webrtcImplFor(peerB64: AgentPubKeyB64): 'simplepeer' | 'fsm' {
    const myConv = get(this._myModuleStates)['conversation'];
    const myPayload = myConv ? parseConversationPayload(myConv) : null;
    const peerConv = get(this._peerModuleStates)[peerB64]?.['conversation'];
    const peerPayload = peerConv ? parseConversationPayload(peerConv) : null;
    return this.webrtcImplForGiven(
      myPayload?.webrtcImpl ?? 'fsm',
      myPayload?.peerImpl?.[peerB64],
      peerPayload?.webrtcImpl ?? 'simplepeer',
      peerPayload?.peerImpl?.[this.myPubKeyB64],
      conversationPayloadCaps(peerConv ?? null).has(CAP_SDP_FSM),
    );
  }

  /** Pure resolver for `webrtcImplFor` — exposed so other modules
   *  (e.g. `onModulePayloadChange`) can compute prev/next impls from
   *  arbitrary payload snapshots without re-reading the live stores.
   *  Thin wrapper over the standalone helper in
   *  `./transport/auto-flip-policy.ts`. */
  webrtcImplForGiven(
    myGlobal: 'simplepeer' | 'fsm',
    myOverride: 'simplepeer' | 'fsm' | undefined,
    peerGlobal: 'simplepeer' | 'fsm',
    peerOverride: 'simplepeer' | 'fsm' | undefined,
    peerSupportsFsm: boolean,
  ): 'simplepeer' | 'fsm' {
    return resolveWebrtcImpl({
      myGlobal,
      myOverride,
      peerGlobal,
      peerOverride,
      peerSupportsFsm,
    });
  }

  /** Read our own peerImpl map. Defaults to {} if conversation isn't
   *  active or the field is missing. */
  myPeerImpl(): Record<AgentPubKeyB64, 'simplepeer' | 'fsm'> {
    const existing = get(this._myModuleStates)['conversation'];
    const payload = existing ? parseConversationPayload(existing) : null;
    return payload?.peerImpl ?? {};
  }

  /** Per-peer media transport choice for a NEW connection — driven by the
   *  conversation module's webrtcImpl/fsmWith negotiation. */
  private _mediaTransportFor(peerB64: AgentPubKeyB64): SimplePeerTransport | FsmTransport {
    return this.webrtcImplFor(peerB64) === 'fsm'
      ? this.mediaTransportFsm
      : this.mediaTransport;
  }

  /** Per-peer media transport that currently hosts the live connection.
   *  Use for sends, closes, and ICE peeks where we need the transport
   *  that actually owns the peer state (which may differ from the
   *  webrtcImpl-driven choice if a flip is in flight). Falls back to the
   *  configured choice when no live connection exists. */
  private _activeMediaTransportFor(peerB64: AgentPubKeyB64): SimplePeerTransport | FsmTransport {
    if (this.mediaTransportFsm.hasConnection(peerB64)) return this.mediaTransportFsm;
    if (this.mediaTransport.hasConnection(peerB64)) return this.mediaTransport;
    return this._mediaTransportFor(peerB64);
  }

  /** Media transports to fan out broadcast-shaped operations onto
   *  (setLocalStream, addTrack, removeTrack, replaceTrack, destroy).
   *  Each transport's addTrack/etc. iterates its own connection map; calling
   *  both covers every peer regardless of which impl is selected. */
  private _allMediaTransports(): Array<SimplePeerTransport | FsmTransport> {
    return [this.mediaTransport, this.mediaTransportFsm];
  }

  private _subscribeScreenShareTransport(
    transport: SimplePeerTransport,
    initiator: boolean,
  ): void {
    transport.onAny((event: TransportEvent) => {
      switch (event.type) {
        case 'connection-state-change':
          if (event.phase === 'signaling' && initiator) {
            // Watch the outgoing-screen-share peer's ICE state so the
            // stale-cleanup paths can apply a grace period symmetric
            // with the video peer behavior. Only the outgoing
            // (initiator) side is tracked because the existing stale-
            // cleanup checks only target _screenShareConnectionsOutgoing.
            this._startScreenShareIceMonitor(event.peer, transport);
          } else if (event.phase === 'connected') {
            this._handleScreenShareConnected(event.peer, event.connectionId, initiator);
          } else if (event.phase === 'closed') {
            this._handleScreenShareClosed(event.peer, event.connectionId, initiator);
          }
          break;
        case 'remote-stream':
          this._handleScreenShareRemoteStream(event.peer, event.connectionId, event.stream);
          break;
        case 'remote-track':
          this._handleScreenShareRemoteTrack(event.peer, event.connectionId, event.track);
          break;
        case 'error':
          this._handleScreenShareError(event.peer, event.connectionId, event.error, initiator);
          break;
      }
    });
  }

  // --- media transport event handlers ---

  /**
   * Watch RTCPeerConnection ICE state for forensic logging. The transport
   * does not surface ICE-level events on its interface; we reach in via
   * the per-impl escape hatch and attach listeners.
   */
  private _startMediaIceMonitor(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    impl: 'simplepeer' | 'fsm',
  ): void {
    const key = `${pubKeyB64}:${connectionId}`;
    // Stake t0 on the first signaling transition for this (peer, connId).
    // Done before the attach-gate so re-entries during a pc-not-ready
    // retry race still anchor t0 at the actual signaling boundary rather
    // than at the moment pc finally appears.
    if (!this._iceTimings[key]) {
      this._iceTimings[key] = { t0: Date.now(), impl };
    }
    const transport = impl === 'fsm' ? this.mediaTransportFsm : this.mediaTransport;
    const attach = () => {
      // Gate inside attach (not at function entry) so a re-entry from a
      // second `signaling` transition keeps polling for pc when the first
      // call is still retrying. Claiming the key before pc is ready
      // would let later transitions short-circuit, and on LAN ICE
      // completes faster than the 100ms retry interval — the listener
      // would attach after every relevant state change had already fired.
      if (this._iceMonitorsAttached.has(key)) return;
      const pc = transport.getRTCPeerConnection(pubKeyB64);
      if (!pc) {
        setTimeout(attach, 100);
        return;
      }
      this._iceMonitorsAttached.add(key);
      const ac = new AbortController();
      this._iceMonitorAbortControllers.set(key, ac);
      const signal = ac.signal;
      pc.addEventListener('iceconnectionstatechange', () => {
        const state = pc.iceConnectionState;
        this.logger.logCustomMessage(
          `ICE [${pubKeyB64.slice(0, 8)}]: ${state} connId=${connectionId.slice(0, 8)}`
        );
        // First entry to 'connected' (or 'completed') marks the ICE-only
        // milestone — DTLS may still be in flight. Record once; later
        // disconnect/recover cycles must not overwrite the initial timing.
        const t = this._iceTimings[key];
        if (t && t.tIceConnected === undefined && (state === 'connected' || state === 'completed')) {
          t.tIceConnected = Date.now();
        }
        if (t) t.finalIceState = state;
        // Maintain the invariant: an entry exists iff iceState is
        // currently 'disconnected'. The cleanup paths use a grace
        // period before treating 'disconnected' as terminal.
        if (state === 'disconnected') {
          this._iceDisconnectedAt[pubKeyB64] = Date.now();
        } else {
          delete this._iceDisconnectedAt[pubKeyB64];
        }
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
      }, { signal });
      pc.addEventListener('icegatheringstatechange', () => {
        this.logger.logCustomMessage(
          `ICE gathering [${pubKeyB64.slice(0, 8)}]: ${pc.iceGatheringState}`
        );
        if (pc.iceGatheringState === 'complete') {
          const stats = (pc as any).localDescription?.sdp;
          const hasRelay = stats ? stats.includes('typ relay') : false;
          this.logger.logCustomMessage(
            `ICE candidates summary [${pubKeyB64.slice(0, 8)}]: relay=${hasRelay}`
          );
          // Stamp gather-complete timing on first transition; the SDP
          // can re-gather on ICE restart but the establishment-latency
          // metric refers to the initial gather only.
          const t = this._iceTimings[key];
          if (t && t.tGatherComplete === undefined) {
            t.tGatherComplete = Date.now();
            t.relay = hasRelay;
          }
        }
      }, { signal });
      pc.addEventListener('icecandidate', (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate) {
          const c = event.candidate;
          this.logger.logCustomMessage(
            `ICE candidate [${pubKeyB64.slice(0, 8)}]: ${c.type} ${c.protocol} ${c.address}:${c.port}`
          );
        }
      }, { signal });
    };
    attach();
  }

  /**
   * Release the attach-once bookkeeping for a (peer, connectionId) pair
   * AND actively detach the listeners by aborting their AbortController.
   * Called from the close/error paths so a future reconnect with a fresh
   * connectionId re-attaches a clean set, and orphaned pcs (where the
   * FSM teardown didn't synchronously destroy the underlying pc) stop
   * leaking ICE-state events into the log.
   */
  private _stopMediaIceMonitor(pubKeyB64: AgentPubKeyB64, connectionId: string): void {
    const key = `${pubKeyB64}:${connectionId}`;
    this._iceMonitorsAttached.delete(key);
    delete this._iceTimings[key];
    const ac = this._iceMonitorAbortControllers.get(key);
    if (ac) {
      ac.abort();
      this._iceMonitorAbortControllers.delete(key);
    }
  }

  /**
   * Emit a single `IceEstablishment` event with the captured milestone
   * latencies for this (peer, connectionId). No-op if already emitted,
   * or if no timing entry exists (e.g. close arrived before any
   * signaling event — defensive). The carrier identity travels in the
   * detail string so a single log query can A/B the two carriers.
   */
  private _emitIceEstablishment(pubKeyB64: AgentPubKeyB64, connectionId: string): void {
    const key = `${pubKeyB64}:${connectionId}`;
    const t = this._iceTimings[key];
    if (!t || t.emitted) return;
    t.emitted = true;
    const now = Date.now();
    const ice = t.tIceConnected !== undefined ? t.tIceConnected - t.t0 : -1;
    const gather = t.tGatherComplete !== undefined ? t.tGatherComplete - t.t0 : -1;
    const connect = now - t.t0;
    // Record the effective ICE policy and whether a TURN server was actually
    // configured. Force-TURN ('relay') auto-disarms when turnUrl is empty
    // (see _readIceTransportPolicy), so logging the resolved values makes a
    // silent disarm — e.g. force-TURN toggled on but no/unfetched credentials —
    // visible in diagnostics rather than inferred from candidate types.
    const policy = this._readIceTransportPolicy() ?? 'all';
    const turnSources = [
      this.turnUrl.trim() ? 'manual' : '',
      this.cfTurnUrl.trim() ? 'cloudflare' : '',
    ].filter(Boolean);
    const turn = turnSources.length > 0 ? turnSources.join('+') : 'none';
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: now,
      event: 'IceEstablishment',
      connectionId,
      detail: `impl=${t.impl} ice=${ice} gather=${gather} connect=${connect} relay=${t.relay ?? 'unknown'} policy=${policy} turn=${turn}`,
    });
  }

  /**
   * Counterpart to `_emitIceEstablishment`: emit on close-before-FSM-connected
   * so failure-side latency is also captured. Splits into two event types
   * based on whether ICE itself succeeded:
   *   - `IceNeverConnected`: ICE didn't reach 'connected'/'completed' —
   *     a real network/NAT diagnostic (stuck checking, failed, closed
   *     during gather).
   *   - `ConnectionAborted`: ICE was fine but the FSM was torn down before
   *     reaching `connected` (carrier flip / disconnectFromPeerVideo /
   *     remote-leave mid-handshake). Not an ICE problem; bookkeeping.
   * Both carry the same fields so log analysis is uniform; only the event
   * name differs. No-op if the establishment event already fired.
   */
  private _emitIceNeverConnected(pubKeyB64: AgentPubKeyB64, connectionId: string): void {
    const key = `${pubKeyB64}:${connectionId}`;
    const t = this._iceTimings[key];
    if (!t || t.emitted) return;
    t.emitted = true;
    const now = Date.now();
    const ice = t.tIceConnected !== undefined ? t.tIceConnected - t.t0 : -1;
    const gather = t.tGatherComplete !== undefined ? t.tGatherComplete - t.t0 : -1;
    const elapsed = now - t.t0;
    const iceReachedConnected =
      t.finalIceState === 'connected' || t.finalIceState === 'completed';
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: now,
      event: iceReachedConnected ? 'ConnectionAborted' : 'IceNeverConnected',
      connectionId,
      detail: `impl=${t.impl} ice=${ice} gather=${gather} elapsed=${elapsed} relay=${t.relay ?? 'unknown'} finalIceState=${t.finalIceState ?? 'none'}`,
    });
  }

  /**
   * Watch the underlying RTCPeerConnection of an outgoing screen-share
   * peer so the stale-cleanup paths can apply the grace period.
   * Maintains the invariant on `_screenShareIceDisconnectedAt`: an entry
   * exists iff iceState is currently 'disconnected'.
   */
  private _startScreenShareIceMonitor(
    pubKeyB64: AgentPubKeyB64,
    transport: SimplePeerTransport,
  ): void {
    const attach = () => {
      const pc = transport.getRTCPeerConnection(pubKeyB64);
      if (!pc) {
        setTimeout(attach, 100);
        return;
      }
      pc.addEventListener('iceconnectionstatechange', () => {
        const state = pc.iceConnectionState;
        if (state === 'disconnected') {
          this._screenShareIceDisconnectedAt[pubKeyB64] = Date.now();
        } else {
          delete this._screenShareIceDisconnectedAt[pubKeyB64];
        }
      });
    };
    attach();
  }

  /** DTLS-stall watchdog timeout (ms) for the FSM transport. Defaults to a
   *  link-tolerant 12s; override via localStorage('dtlsStallTimeoutMs').
   *  Floored at 1s to avoid an unusably twitchy watchdog. */
  private _readDtlsStallTimeoutMs(): number {
    const DEFAULT_MS = 12_000;
    try {
      const raw = window.localStorage.getItem('dtlsStallTimeoutMs');
      if (!raw) return DEFAULT_MS;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 1_000 ? n : DEFAULT_MS;
    } catch {
      return DEFAULT_MS;
    }
  }

  /**
   * Optional forced ICE transport policy, for validating the TURN/relay path
   * (§6.3): set localStorage('iceTransportPolicy') = 'relay' to force TURN-only
   * (host/srflx candidates are not gathered), proving the relay actually forms
   * without needing a special build. Returns undefined for normal ICE.
   */
  private _readIceTransportPolicy(): RTCIceTransportPolicy | undefined {
    try {
      const raw = window.localStorage.getItem('iceTransportPolicy');
      if (raw === 'relay') {
        // Force-TURN is only meaningful — and only safe — when a TURN server is
        // actually configured. With 'relay' and no TURN, ICE gathers zero
        // candidates and every connection dies; honor it only when a relay
        // exists (manual or Cloudflare) so clearing the TURN fields auto-disarms
        // the knob. These are live localStorage getters, so this reflects
        // in-flight UI edits and just-provisioned Cloudflare credentials.
        return this.turnUrl.trim() || this.cfTurnUrl.trim()
          ? 'relay'
          : undefined;
      }
      return raw === 'all' ? 'all' : undefined;
    } catch {
      return undefined;
    }
  }

  /** Per-sender video bitrate cap (bps), or null to leave uncapped. Override
   *  via localStorage('videoMaxBitrateKbps'); '0' disables the cap. */
  private _videoMaxBitrate(): number | null {
    const DEFAULT_KBPS = 2_000;
    try {
      const raw = window.localStorage.getItem('videoMaxBitrateKbps');
      const kbps = raw != null ? parseInt(raw, 10) : DEFAULT_KBPS;
      if (!Number.isFinite(kbps) || kbps <= 0) return raw === '0' ? null : DEFAULT_KBPS * 1_000;
      return kbps * 1_000;
    } catch {
      return DEFAULT_KBPS * 1_000;
    }
  }

  /**
   * Bias the encoder toward audio on a constrained uplink: mark the audio
   * sender high network priority and the video sender low, and cap video
   * bitrate. On a saturated upload the congestion controller then starves
   * video before audio, so voice survives loss/contention that would
   * otherwise hit both equally. Best-effort: setParameters can reject if
   * called before encodings exist or on browsers that don't support a
   * field; failures are non-fatal and logged at debug only.
   */
  private async _applySenderParams(
    pc: RTCPeerConnection | undefined,
    peerB64?: AgentPubKeyB64,
  ): Promise<void> {
    if (!pc) return;
    const report: string[] = [];
    for (const sender of pc.getSenders()) {
      const kind = sender.track?.kind;
      if (kind !== 'audio' && kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        // setParameters requires the encodings array shape returned by
        // getParameters(); if the browser hasn't populated it yet, skip.
        if (!params.encodings || params.encodings.length === 0) continue;
        const enc = params.encodings[0] as RTCRtpEncodingParameters & {
          networkPriority?: RTCPriorityType;
        };
        const want = kind === 'audio' ? 'high' : 'low';
        if (kind === 'audio') {
          enc.priority = 'high';
          enc.networkPriority = 'high';
        } else {
          enc.priority = 'low';
          enc.networkPriority = 'low';
          const cap = this._videoMaxBitrate();
          if (cap) enc.maxBitrate = cap;
        }
        await sender.setParameters(params);
        // Read back what the browser actually stored. `networkPriority` is not
        // universally honored; if it silently reverts, video can starve audio
        // on a constrained uplink — exactly the periodic-dropout symptom we are
        // chasing. Logging applied-vs-requested makes that visible in capture.
        const rb = sender.getParameters().encodings?.[0] as
          | (RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType })
          | undefined;
        const gotPrio = rb?.priority ?? 'unset';
        const gotNet = rb?.networkPriority ?? 'unset';
        const applied = gotPrio === want && gotNet === want;
        let s = `${kind}:want=${want} priority=${gotPrio} netPriority=${gotNet}${applied ? '' : ' NOT-APPLIED'}`;
        if (kind === 'video') s += ` maxBitrate=${rb?.maxBitrate ?? 'unset'}`;
        report.push(s);
      } catch {
        // Non-fatal: too-early call, unsupported field, or transient state.
        report.push(`${kind}:setParameters-failed`);
      }
    }
    if (peerB64 && report.length > 0) {
      this.logger.logAgentEvent({
        agent: peerB64,
        timestamp: Date.now(),
        event: 'SenderParams',
        detail: report.join(' | '),
      });
    }
  }

  private _handleMediaConnected(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    impl: 'simplepeer' | 'fsm',
  ): void {
    const transport = impl === 'fsm' ? this.mediaTransportFsm : this.mediaTransport;
    // Supersede guard: an old peer that completed ICE after being replaced
    // would otherwise mutate the new connection's slot.
    const currentOnConnect = get(this._openConnections)[pubKeyB64];
    if (currentOnConnect && currentOnConnect.connectionId !== connectionId) {
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'SupersededConnect',
        connectionId,
        detail: `superseded-by=${currentOnConnect.connectionId}`,
      });
      // Transport already handled supersede destroy on its side.
      return;
    }
    if (!currentOnConnect) {
      // Connected event for a peer no longer in _openConnections — likely
      // closed mid-handshake. Drop.
      return;
    }
    console.log('#### CONNECTED with', pubKeyB64);
    this._flushSdpAggregatesForConnection(connectionId);
    // Record this peer as a genuine call participant for diagnostic-log
    // targeting. Kept for the whole session even if they later drop.
    this._conversationParticipants.add(pubKeyB64);
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: Date.now(),
      event: 'Connected',
      connectionId,
    });
    this._emitIceEstablishment(pubKeyB64, connectionId);
    // Audio carrier flipped from signals → webrtc (impl-specific) for this peer.
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: Date.now(),
      event: 'CarrierSwitch',
      connectionId,
      detail: `signals->${impl}`,
    });
    this._lastQualityBucket.delete(pubKeyB64);

    delete this._pendingInits[pubKeyB64];

    this._openConnections.update(currentValue => {
      const conn = currentValue[pubKeyB64];
      if (conn) conn.connected = true;
      return currentValue;
    });

    // Ensure mainStream is attached. The transport's auto-attach handles
    // peers created after setLocalStream; this addTrack-per-track pass
    // is the on-connect fallback for peers created before mainStream
    // existed. Duplicate-track adds are silently ignored by the transport.
    if (this.mainStream) {
      try {
        for (const track of this.mainStream.getTracks()) {
          transport.addTrack(track, this.mainStream);
        }
        this.logger.logCustomMessage(
          `addStream on-connect [${pubKeyB64.slice(0, 8)}]: ${this.mainStream.getTracks().length} tracks`
        );
      } catch (_e) {
        // Tracks may already be in the offer — silently ignore duplicate-track errors.
      }
    }

    // Prioritise audio over video on the now-live sender (protects voice on
    // constrained uplinks). Fire-and-forget; senders exist post-addTrack.
    void this._applySenderParams(transport.getRTCPeerConnection(pubKeyB64), pubKeyB64);

    this.updateConnectionStatus(pubKeyB64, { type: 'Connected' });
    this.eventCallback({
      type: 'peer-connected',
      pubKeyB64,
      connectionId,
    });

    // After ICE settles, sample the selected candidate pair to detect
    // relay (TURN) usage so the UI can flag it.
    setTimeout(async () => {
      try {
        const pc = transport.getRTCPeerConnection(pubKeyB64);
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
            // A connection is relayed if EITHER endpoint's selected candidate is
            // a TURN relay. Media traverses the relay bidirectionally, but each
            // peer only sees its own side as 'relay' — the peer forcing TURN
            // sees a local relay candidate, while its counterpart sees that
            // relay only as the remote candidate. Check both so the relay
            // indicator is symmetric across the pair.
            if (
              localCandidate?.candidateType === 'relay' ||
              remoteCandidate?.candidateType === 'relay'
            ) {
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
      } catch (_e) {
        // getStats may fail if connection was already closed
      }
    }, 2000);
  }

  private _handleMediaClosed(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    impl: 'simplepeer' | 'fsm',
    /** Why the slot is being cleared — the `phase/reason` pair from
     *  `routeTransportPhase`, or a call-site tag for the paths that close a
     *  connection directly. Recorded on the FsmClose/SimplePeerClose event so
     *  a give-up is distinguishable from an ordinary close in the log. */
    cause = 'close-event',
  ): void {
    console.log('#### GOT CLOSE EVENT ####');

    // Supersede guard: the current entry for this peer points at a
    // different connectionId means a newer connection has taken over and
    // we must NOT wipe its state.
    const currentOnClose = get(this._openConnections)[pubKeyB64];
    if (currentOnClose && currentOnClose.connectionId !== connectionId) {
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'SupersededClose',
        connectionId,
        detail: `superseded-by=${currentOnClose.connectionId}`,
      });
      return;
    }

    // Duplicate-close guard: the first close already deleted
    // _openConnections[peer], cleared analyser/stats, and fired
    // peer-disconnected. A second close event for the same connectionId
    // would emit a redundant SimplePeerClose/FsmClose and re-fire
    // peer-disconnected on consumers.
    if (!currentOnClose) {
      this._stopMediaIceMonitor(pubKeyB64, connectionId);
      return;
    }

    const closingConn = currentOnClose;
    const wasWebrtcCarrier = !!closingConn?.connected;

    // Flush any in-flight SdpData bursts for this connection so the
    // summary lands before the close event in the timeline.
    this._flushSdpAggregatesForConnection(connectionId);

    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: Date.now(),
      event: impl === 'fsm' ? 'FsmClose' : 'SimplePeerClose',
      connectionId,
      detail: `cause=${cause}`,
    });
    if (wasWebrtcCarrier) {
      // Annotate the downgrade with *why* we left webrtc (§6.6) — the reason
      // the FSM took this peer out of `connected`, captured in
      // `_logFsmTransition`. Falls back to the impl-specific FSM close if the
      // root reason wasn't seen (e.g. close arrived without a connected->X log).
      const reason = this._lastWebrtcExitReason.get(pubKeyB64) ?? 'unknown';
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'CarrierSwitch',
        connectionId,
        detail: `${impl}->signals reason="${reason}"`,
      });
    }
    this._lastWebrtcExitReason.delete(pubKeyB64);
    this._lastQualityBucket.delete(pubKeyB64);
    this._lastDisconnectTime[pubKeyB64] = Date.now();

    delete this._videoStreams[pubKeyB64];

    this._openConnections.update(currentValue => {
      delete currentValue[pubKeyB64];
      return currentValue;
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

    delete this._lastBytesReceived[pubKeyB64];
    delete this._staleCycles[pubKeyB64];
    delete this._reconcileAttemptCount[pubKeyB64];
    delete this._iceDisconnectedAt[pubKeyB64];
    // Capture failure-side latency before _stopMediaIceMonitor wipes
    // the timing entry. _emitIceNeverConnected no-ops if the
    // establishment event already fired (i.e. this is a normal close
    // after a successful connect).
    this._emitIceNeverConnected(pubKeyB64, connectionId);
    this._stopMediaIceMonitor(pubKeyB64, connectionId);
    this.removePeerAudioAnalyser(pubKeyB64);
    this.webrtcStats.delete(pubKeyB64);

    // Tear down any outgoing screen share to this peer since they
    // have disconnected. Without this, a stale connection may linger
    // and block re-initiation when the peer rejoins.
    const outgoingScreenShare = get(this._screenShareConnectionsOutgoing)[pubKeyB64];
    if (outgoingScreenShare) {
      console.log(`#### TEARING DOWN OUTGOING SCREEN SHARE TO ${pubKeyB64.slice(0, 8)} (video peer closed)`);
      this.screenShareOutTransport.closeConnection(pubKeyB64, 'media peer closed');
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
  }

  private _handleMediaRemoteStream(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    stream: MediaStream,
  ): void {
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
    this._videoStreams[pubKeyB64] = stream;

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    this._openConnections.update(currentValue => {
      const relevantConnection = currentValue[pubKeyB64];
      if (relevantConnection) {
        if (audioTracks.length > 0) {
          relevantConnection.audio = true;
        }
        if (videoTracks.length > 0 && !videoTracks[0].muted) {
          relevantConnection.video = true;
        } else if (videoTracks.length > 0 && videoTracks[0].muted) {
          relevantConnection.videoMuted = true;
        }
      }
      return currentValue;
    });
    this.setupPeerAudioAnalyser(pubKeyB64, stream);
    this.eventCallback({
      type: 'peer-stream',
      pubKeyB64,
      connectionId,
      stream,
    });
  }

  private _handleMediaRemoteTrack(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    track: MediaStreamTrack,
    stream: MediaStream,
  ): void {
    console.log('#### GOT TRACK from:', pubKeyB64, track, 'muted:', track.muted);
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: Date.now(),
      event: 'SimplePeerTrack',
      connectionId,
    });

    // Ensure the audio analyser is wired up for this peer. The 'remote-stream'
    // event is deduped per stream.id in the underlying RTCPeer, so a stream
    // whose first track was video (analyser-setup early-returns on no audio)
    // never gets a second pass when the audio track arrives later. Hook it
    // here as well: idempotent if the analyser already exists.
    if (track.kind === 'audio' && stream && !this._peerAnalysers.has(pubKeyB64)) {
      this.setupPeerAudioAnalyser(pubKeyB64, stream);
    }

    if (!track.muted) {
      this._setTrackReady(pubKeyB64, connectionId, track);
      return;
    }

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

  private _handleMediaDataChannelMessage(
    pubKeyB64: AgentPubKeyB64,
    data: unknown,
  ): void {
    try {
      const msg: RTCMessage = JSON.parse(data as string);
      if (msg.type !== 'action') return;
      if (msg.message === 'video-off') {
        this._openConnections.update(currentValue => {
          const conn = currentValue[pubKeyB64];
          if (conn) conn.video = false;
          return currentValue;
        });
        this.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: Date.now(),
          event: 'PeerVideoOffSignal',
        });
      }
      if (msg.message === 'video-on') {
        this._openConnections.update(currentValue => {
          const conn = currentValue[pubKeyB64];
          if (conn) conn.video = true;
          return currentValue;
        });
        this.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: Date.now(),
          event: 'PeerVideoOnSignal',
        });
      }
      if (msg.message === 'audio-off') {
        this._openConnections.update(currentValue => {
          const conn = currentValue[pubKeyB64];
          if (conn) conn.audio = false;
          return currentValue;
        });
        this.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: Date.now(),
          event: 'PeerAudioOffSignal',
        });
      }
      if (msg.message === 'audio-on') {
        this._openConnections.update(currentValue => {
          const conn = currentValue[pubKeyB64];
          if (conn) conn.audio = true;
          return currentValue;
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
    } catch (e) {
      console.warn(
        `Failed to parse RTCMessage: ${JSON.stringify(e)}. Got message: ${data}}`
      );
    }
  }

  private _handleMediaError(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    error: Error,
    impl: 'simplepeer' | 'fsm',
  ): void {
    const transport = impl === 'fsm' ? this.mediaTransportFsm : this.mediaTransport;
    console.log('#### GOT ERROR EVENT ####: ', error);

    // Supersede guard (see _handleMediaClosed for the full rationale).
    const currentOnError = get(this._openConnections)[pubKeyB64];
    if (currentOnError && currentOnError.connectionId !== connectionId) {
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: Date.now(),
        event: 'SupersededError',
        connectionId,
        detail: `superseded-by=${currentOnError.connectionId}; err=${error.message || error}`,
      });
      return;
    }

    // Duplicate-error guard: first error already tore the connection
    // down. Subsequent error events for the same connectionId would
    // re-emit the same structured event and re-fire peer-disconnected.
    if (!currentOnError) {
      this._stopMediaIceMonitor(pubKeyB64, connectionId);
      return;
    }

    const errLabel = impl === 'fsm' ? 'FsmError' : 'SimplePeerError';
    this._flushSdpAggregatesForConnection(connectionId);
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: Date.now(),
      event: errLabel,
      connectionId,
      detail: error.message || String(error),
    });

    delete this._videoStreams[pubKeyB64];

    this._openConnections.update(currentValue => {
      delete currentValue[pubKeyB64];
      return currentValue;
    });

    this._othersConnectionStatuses.update(statuses => {
      if (statuses[pubKeyB64]) {
        statuses[pubKeyB64] = {
          ...statuses[pubKeyB64],
          perceivedStreamInfo: undefined,
        };
      }
      return statuses;
    });

    const outgoingScreenShare2 = get(this._screenShareConnectionsOutgoing)[pubKeyB64];
    if (outgoingScreenShare2) {
      this.screenShareOutTransport.closeConnection(pubKeyB64, 'media peer error');
      this._screenShareConnectionsOutgoing.update(currentValue => {
        delete currentValue[pubKeyB64];
        return currentValue;
      });
      delete this._pendingScreenShareInits[pubKeyB64];
    }
    this.removePeerAudioAnalyser(pubKeyB64);
    this.webrtcStats.delete(pubKeyB64);
    // Capture failure-side latency before _stopMediaIceMonitor wipes
    // the timing entry. Mirrors the _handleMediaClosed path.
    this._emitIceNeverConnected(pubKeyB64, connectionId);
    this._stopMediaIceMonitor(pubKeyB64, connectionId);

    // Drive transport close so the underlying peer is fully torn down.
    // The resulting close event hits _handleMediaClosed and our
    // duplicate-close guard short-circuits it (entry is already removed).
    transport.closeConnection(pubKeyB64, 'error event');

    this.updateConnectionStatus(pubKeyB64, { type: 'Disconnected' });
    this.eventCallback({
      type: 'peer-disconnected',
      pubKeyB64,
      connectionId,
    });
  }

  // --- screen-share transport event handlers ---

  private _screenShareStore(initiator: boolean): Writable<Record<AgentPubKeyB64, OpenConnectionInfo>> {
    return initiator
      ? this._screenShareConnectionsOutgoing
      : this._screenShareConnectionsIncoming;
  }

  private _handleScreenShareConnected(
    pubKeyB64: AgentPubKeyB64,
    _connectionId: string,
    initiator: boolean,
  ): void {
    console.log('#### SCREEN SHARE CONNECTED');

    const store = this._screenShareStore(initiator);
    store.update(currentValue => {
      const relevantConnection = currentValue[pubKeyB64];
      if (relevantConnection) {
        relevantConnection.connected = true;
      }
      return currentValue;
    });

    // If we are the sharer, ensure the outgoing screen-share stream is
    // attached. addStream-style auto-attach has already happened for new
    // connections via setLocalStream, but addTrack-per-track is a safe
    // no-op fallback when the stream was set after this peer was created.
    if (initiator && this.screenShareStream) {
      const conn = get(this._screenShareConnectionsOutgoing)[pubKeyB64];
      if (conn && conn.direction === 'outgoing') {
        try {
          for (const track of this.screenShareStream.getTracks()) {
            this.screenShareOutTransport.addTrack(track, this.screenShareStream);
          }
        } catch (_e) {
          // duplicate tracks are silently ignored
        }
      }
    }

    if (!initiator) {
      this.eventCallback({
        type: 'peer-screen-share-connected',
        pubKeyB64,
        connectionId: _connectionId,
      });
    }

    this.updateScreenShareConnectionStatus(pubKeyB64, { type: 'Connected' });
  }

  private _handleScreenShareClosed(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    initiator: boolean,
  ): void {
    console.log('#### GOT SCREEN SHARE CLOSE EVENT ####');

    const store = this._screenShareStore(initiator);
    store.update(currentValue => {
      delete currentValue[pubKeyB64];
      return currentValue;
    });

    if (initiator) {
      delete this._screenShareIceDisconnectedAt[pubKeyB64];
    }

    if (!initiator) {
      this.eventCallback({
        type: 'peer-screen-share-disconnected',
        pubKeyB64,
        connectionId,
      });
    }

    this.updateScreenShareConnectionStatus(pubKeyB64, {
      type: 'Disconnected',
    });
  }

  private _handleScreenShareRemoteStream(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    stream: MediaStream,
  ): void {
    console.log(
      '#### GOT SCREEN SHARE STREAM. With tracks: ',
      stream.getTracks()
    );
    this._screenShareConnectionsIncoming.update(currentValue => {
      const relevantConnection = currentValue[pubKeyB64];
      if (relevantConnection) {
        if (stream.getAudioTracks().length > 0) {
          relevantConnection.audio = true;
        }
        if (stream.getVideoTracks().length > 0) {
          relevantConnection.video = true;
        }
      }
      return currentValue;
    });

    this.eventCallback({
      type: 'peer-screen-share-stream',
      pubKeyB64,
      connectionId,
      stream,
    });
  }

  private _handleScreenShareRemoteTrack(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    track: MediaStreamTrack,
  ): void {
    console.log('#### GOT TRACK: ', track);
    this._screenShareConnectionsIncoming.update(currentValue => {
      const relevantConnection = currentValue[pubKeyB64];
      if (!relevantConnection) return currentValue;
      if (track.kind === 'audio' && track.enabled) {
        relevantConnection.audio = true;
      }
      if (track.kind === 'video' && track.enabled) {
        relevantConnection.video = true;
      }
      return currentValue;
    });
    this.eventCallback({
      type: 'peer-screen-share-track',
      pubKeyB64,
      connectionId,
      track,
    });
  }

  private _handleScreenShareError(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    error: Error,
    initiator: boolean,
  ): void {
    console.log('#### GOT SCREEN SHARE ERROR EVENT ####: ', error);
    this.logger.logCustomMessage(
      `ScreenSharePeerError [${pubKeyB64.slice(0, 8)}]: ${error.message || error}`
    );

    const store = this._screenShareStore(initiator);
    store.update(currentValue => {
      delete currentValue[pubKeyB64];
      return currentValue;
    });

    if (!initiator) {
      this.eventCallback({
        type: 'peer-screen-share-disconnected',
        pubKeyB64,
        connectionId,
      });
    }

    // Drive teardown via the transport so SimplePeer is fully closed.
    const transport = initiator ? this.screenShareOutTransport : this.screenShareInTransport;
    transport.closeConnection(pubKeyB64, 'screen-share error event');

    this.updateScreenShareConnectionStatus(pubKeyB64, {
      type: 'Disconnected',
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
   * Start or stop the filmstrip encoder based on whether the camera is
   * held AND at least one peer needs video via signals. Mirrors
   * `_reconcileSignalsAudio`. Called from the _signalsTargets
   * subscription and from videoOn/videoOff.
   *
   * Trigger uses `_webrtcCameraHandle` (not `cameraSource.consumerCount`)
   * to avoid the trivial cycle where the filmstrip controller's own
   * acquire would keep the gate true forever.
   */
  private _reconcileSignalsVideo(): void {
    const cameraHeld = !!this._webrtcCameraHandle;
    const hasTargets = get(this._signalsTargets).size > 0;
    const shouldRun = cameraHeld && hasTargets;

    if (shouldRun && !this._filmstripEncoderRunning) {
      filmstripController.startCapture().then(ok => {
        if (!ok) {
          this._filmstripEncoderRunning = false;
          console.warn('Filmstrip encoder failed to start');
        }
      });
      this._filmstripEncoderRunning = true;
    } else if (!shouldRun && this._filmstripEncoderRunning) {
      filmstripController.stopCapture().catch(() => {});
      this._filmstripEncoderRunning = false;
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
        for (const t of this._allMediaTransports()) t.setLocalStream(this.mainStream);
      }
      // Drop any stale audio track (shouldn't happen, but cheap to guard).
      this.mainStream.getAudioTracks().forEach(t => {
        this.mainStream!.removeTrack(t);
      });
      this.mainStream.addTrack(newTrack);
      for (const t of this._allMediaTransports()) {
        try {
          t.addTrack(newTrack, this.mainStream);
        } catch (e: any) {
          console.warn('MicSource open: transport.addTrack failed:', e.message);
        }
      }
      return;
    }

    // --- device change ---
    if (newTrack && oldTrack) {
      if (this.mainStream) {
        try { this.mainStream.removeTrack(oldTrack); } catch {}
        try { this.mainStream.addTrack(newTrack); } catch {}
      }
      for (const t of this._allMediaTransports()) {
        try {
          t.replaceTrack(oldTrack, newTrack, this.mainStream!);
        } catch (e: any) {
          console.warn('MicSource device-change: transport.replaceTrack failed:', e.message);
        }
      }
      return;
    }

    // --- close ---
    if (!newTrack && oldTrack) {
      if (this.mainStream) {
        try { this.mainStream.removeTrack(oldTrack); } catch {}
      }
      for (const t of this._allMediaTransports()) {
        try {
          t.removeTrack(oldTrack, this.mainStream!);
        } catch (e: any) {
          console.warn('MicSource close: transport.removeTrack failed:', e.message);
        }
      }
    }
  }

  /**
   * Handles CameraSource track lifecycle events.
   *
   * Differs from _onMicTrackChange: this handler does NOT do peer-side
   * fanout. videoOn / videoOff own that directly because the keepalive
   * replaceTrack pattern (1x1 black canvas captureStream stays on the
   * sender across videoOff/videoOn so RTP keeps flowing for NAT mapping)
   * does not fit cleanly into a generic open/close handler.
   *
   *   - open         (newTrack, null)   : add to mainStream. videoOn does
   *                                       the keepalive-aware peer attach
   *                                       after acquire returns.
   *   - device-change (newTrack, oldTrack): swap on mainStream and on
   *                                       transports via replaceTrack.
   *                                       changeVideoInput delegates to
   *                                       cameraSource.changeDevice; this
   *                                       branch keeps the senders pointed
   *                                       at the new device's track.
   *   - close         (null, oldTrack)  : remove from mainStream only.
   *                                       videoOff has already swapped the
   *                                       sender to keepalive before
   *                                       releasing the WebRTC handle.
   */
  private _onCameraTrackChange(
    newTrack: MediaStreamTrack | null,
    oldTrack: MediaStreamTrack | null,
  ): void {
    // --- open ---
    if (newTrack && !oldTrack) {
      if (!this.mainStream) {
        this.mainStream = new MediaStream();
        for (const t of this._allMediaTransports()) t.setLocalStream(this.mainStream);
      }
      // Drop any stale video track (shouldn't happen, but cheap guard).
      this.mainStream.getVideoTracks().forEach(t => {
        this.mainStream!.removeTrack(t);
      });
      this.mainStream.addTrack(newTrack);
      // No peer fanout here — videoOn does the keepalive-aware
      // replaceTrack-vs-addTrack decision once acquire() returns.
      return;
    }

    // --- device change ---
    if (newTrack && oldTrack) {
      if (this.mainStream) {
        try { this.mainStream.removeTrack(oldTrack); } catch {}
        try { this.mainStream.addTrack(newTrack); } catch {}
      }
      for (const t of this._allMediaTransports()) {
        try {
          t.replaceTrack(oldTrack, newTrack, this.mainStream!);
        } catch (e: any) {
          console.warn('CameraSource device-change: transport.replaceTrack failed:', e.message);
        }
      }
      return;
    }

    // --- close ---
    if (!newTrack && oldTrack) {
      if (this.mainStream) {
        try { this.mainStream.removeTrack(oldTrack); } catch {}
      }
      // No peer fanout — videoOff has already replaceTrack'd the camera
      // out for the keepalive (or removeTrack'd if keepalive failed).
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

    // Page-lifecycle forensics: correlate disconnect() calls with whether
    // the tab is actually being closed/hidden vs. a DOM remount from the
    // host shell. These listeners only log; they do not call disconnect().
    const onPageHide = (e: PageTransitionEvent) =>
      streamsStore.logger.logCustomMessage(
        `PageLifecycle pagehide persisted=${e.persisted}`
      );
    const onBeforeUnload = () =>
      streamsStore.logger.logCustomMessage('PageLifecycle beforeunload');
    const onVisibility = () =>
      streamsStore.logger.logCustomMessage(
        `PageLifecycle visibilitychange state=${document.visibilityState}`
      );
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    streamsStore._pageLifecycleUnsub = () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
    };

    setTimeout(async () => {
      const mediaDevices = await navigator.mediaDevices.enumerateDevices();
      streamsStore.mediaDevices.set(mediaDevices);
    });
    return streamsStore;
  }

  disconnect(reason: string = 'unknown') {
    // Forensics: capture WHO called disconnect (button vs. Lit lifecycle
    // unmount) so we can tell user-initiated leaves from DOM-remount leaves.
    // Stack is best-effort — useful when reason='unknown' to find a new caller.
    const stack = new Error().stack?.split('\n').slice(1, 4).join(' | ') ?? '';
    this.logger.logCustomMessage(
      `Disconnect reason=${reason} visibility=${document.visibilityState} ${stack}`
    );

    // Notify peers immediately before tearing down
    const agentsToNotify = Object.keys(get(this._knownAgents))
      .filter(a => a !== this.myPubKeyB64)
      .map(b64 => decodeHashFromBase64(b64));
    if (agentsToNotify.length > 0) {
      this.roomClient.sendMessage(agentsToNotify, 'LeaveUi').catch(() => {});
    }

    if (this.pingInterval) window.clearInterval(this.pingInterval);
    if (this.signalUnsubscribe) this.signalUnsubscribe();
    if (this._pageLifecycleUnsub) {
      this._pageLifecycleUnsub();
      this._pageLifecycleUnsub = null;
    }
    // Close all connections and stop all streams
    this.mediaTransport.destroy();
    this.mediaTransportFsm.destroy();
    this.screenShareInTransport.destroy();
    this.screenShareOutTransport.destroy();
    this.videoOff();
    this.audioOff();
    // videoOff allocates a keepalive track if not already; on disconnect
    // there are no peers to swap it onto, so just release the resources.
    this._releaseVideoKeepalive();
    // Stop the voice encoder if running, then unbind the controller
    // (tears down both send and receive state).
    if (this._voiceEncoderRunning) {
      voiceController.stopCapture().catch(() => {});
      this._voiceEncoderRunning = false;
    }
    voiceController.unbind();
    if (this._filmstripEncoderRunning) {
      filmstripController.stopCapture().catch(() => {});
      this._filmstripEncoderRunning = false;
    }
    filmstripController.unbind();
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
    if (this._webrtcCameraHandle) {
      try { this._webrtcCameraHandle.release(); } catch {}
      this._webrtcCameraHandle = null;
    }
    this.cameraSource.dispose();
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
  }

  disableTrickleICE() {
    window.localStorage.setItem('trickleICE', 'false');
  }

  get iceConfig(): RTCIceServer[] {
    const servers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS];
    // A TURN field may carry more than one URL (comma- or whitespace-separated)
    // so a single credential covers multiple transports — typically the UDP
    // relay `turn:host:3478` plus the TLS-over-TCP relay
    // `turns:host:443?transport=tcp`. The latter survives lossy-UDP paths and
    // firewalls that only permit 443 (§6.3). One m-line per distinct URL is
    // fine; the agent picks the best.
    const pushTurn = (url: string, username: string, credential: string) => {
      const urls = url
        .split(/[\s,]+/)
        .map(u => u.trim())
        .filter(Boolean);
      if (urls.length > 0) {
        servers.push({
          urls: urls.length === 1 ? urls[0] : urls,
          username,
          credential,
        });
      }
    };
    // Manual and Cloudflare TURN are independent entries — both are offered as
    // candidates when present (WebRTC supports multiple TURN servers).
    pushTurn(this.turnUrl, this.turnUsername, this.turnCredential);
    pushTurn(this.cfTurnUrl, this.cfTurnUsername, this.cfTurnCredential);
    return servers;
  }

  setTurnUrl(url: string) {
    window.localStorage.setItem('turnUrl', url);
  }

  setTurnUsername(username: string) {
    window.localStorage.setItem('turnUsername', username);
  }

  setTurnCredential(credential: string) {
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

    // Cleanup stale pending accepts older than 20 seconds. Pending accepts
    // are now just connectionId reservations — the transport owns the peer
    // lifecycle, so dropping the entry is the entire teardown.
    const now = Date.now();
    const PENDING_ACCEPT_TTL = 20000;
    for (const [agent, accepts] of Object.entries(this._pendingAccepts)) {
      const remaining = accepts.filter(a => now - a.createdAt <= PENDING_ACCEPT_TTL);
      if (remaining.length === accepts.length) continue;
      if (remaining.length > 0) {
        this._pendingAccepts[agent] = remaining;
      } else {
        delete this._pendingAccepts[agent];
      }
    }
    for (const [agent, accepts] of Object.entries(
      this._pendingScreenShareAccepts
    )) {
      const remaining = accepts.filter(a => now - a.createdAt <= PENDING_ACCEPT_TTL);
      if (remaining.length === accepts.length) continue;
      if (remaining.length > 0) {
        this._pendingScreenShareAccepts[agent] = remaining;
      } else {
        delete this._pendingScreenShareAccepts[agent];
      }
    }

    // Health check for dead tracks (bytesReceived stall detection)
    await this._checkTrackHealth();

    // Scan for sustained audibility outages with a relay opportunity
    this._checkAudibilityOutages();

    // Flush any SdpData bursts that ended without a follow-up event.
    this._flushStaleSdpAggregates();

    // Forensics: signal-carrier liveness + presence-set membership.
    this._emitPresenceForensics();
  }

  /**
   * Per-ping-cycle forensics (diagnostic only, no behaviour change):
   *
   *  - SignalCarrierDown/Up — inferred from pong freshness. If we know
   *    peers but none have ponged within 3*PING_INTERVAL, the bidirectional
   *    Holochain signal path is presumed down. Makes signal-relay outages
   *    visible in merged logs — without this they are invisible.
   *  - PresenceAdd/PresenceRemove — diff of `globalPresenceSet()` with the
   *    reason a peer entered (media-live / ping-fresh / observer-reported),
   *    so the pane-survival behaviour of `isPeerMediaLive` is observable.
   */
  private _emitPresenceForensics(): void {
    const now = Date.now();

    const known = get(this._knownAgents);
    const blocked = get(this.blockedAgents);
    const knownPeers = Object.keys(known).filter(
      k => k !== this.myPubKeyB64 && !blocked.includes(k),
    );
    if (knownPeers.length > 0) {
      const anyFresh = knownPeers.some(k => {
        const ls = known[k]?.lastSeen;
        return ls !== undefined && now - ls < 3 * PING_INTERVAL;
      });
      if (!anyFresh && this._signalCarrierDownSince === undefined) {
        this._signalCarrierDownSince = now;
        this.logger.logCustomMessage(
          `SignalCarrierDown: no pong from any of ${knownPeers.length} known peer(s)`,
        );
      } else if (anyFresh && this._signalCarrierDownSince !== undefined) {
        const downMs = now - this._signalCarrierDownSince;
        this._signalCarrierDownSince = undefined;
        this.logger.logCustomMessage(
          `SignalCarrierUp: pong path recovered after ${downMs}ms`,
        );
      }
    }

    const current = this.globalPresenceSet();
    const prev = this._lastPresenceSet;
    for (const peer of current) {
      if (peer === this.myPubKeyB64 || prev.has(peer)) continue;
      this.logger.logAgentEvent({
        agent: peer,
        timestamp: now,
        event: 'PresenceAdd',
        detail: `reason=${this._presenceReason(peer)}`,
      });
    }
    for (const peer of prev) {
      if (peer === this.myPubKeyB64 || current.has(peer)) continue;
      this.logger.logAgentEvent({
        agent: peer,
        timestamp: now,
        event: 'PresenceRemove',
        detail: 'reason=ping-stale+no-media',
      });
    }
    this._lastPresenceSet = current;
  }

  /** Why a peer is currently in `globalPresenceSet()`. Forensics helper. */
  private _presenceReason(peer: AgentPubKeyB64): string {
    if (this.isPeerMediaLive(peer)) return 'media-live';
    if (get(this._activeAgents)[peer]) return 'ping-fresh';
    return 'observer-reported';
  }

  /**
   * RTT-scaled SDP-exchange timeout (ms) for an FSM initiator connection,
   * or undefined when no signaling-RTT sample exists yet — the FSM then
   * falls back to its config default (15s), i.e. unchanged behaviour.
   *
   * The SDP exchange rides the same Holochain signal transport as
   * ping/pong, so the signals-carrier RTT EWMA is the correct latency
   * proxy. K is kept generous to absorb signal-relay retransmits; the
   * floor avoids an over-tight timeout on very low-RTT links; the ceiling
   * equals today's fixed default so the change can never make a
   * no-improvement case worse. K/FLOOR are provisional — see
   * docs/CONNECTION_LIFECYCLE_PLAN.md Phase 4A.
   */
  private _computeSdpTimeout(peerB64: AgentPubKeyB64): number | undefined {
    const rtt = this._signalsRttEwma.get(peerB64);
    if (rtt === undefined || rtt <= 0) return undefined;
    const K = 20;
    const FLOOR_MS = 5000;
    const CEILING_MS = 15000;
    return Math.min(CEILING_MS, Math.max(FLOOR_MS, Math.round(rtt * K)));
  }

  async changeVideoInput(deviceId: string) {
    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'ChangeMyVideoInput',
    });
    // CameraSource owns the device-switch path: it stores the new id,
    // opens a new track if a consumer holds the camera, and fires
    // _onCameraTrackChange's device-change branch to replaceTrack on
    // mainStream and on every transport. Mirrors changeAudioInput.
    await this.cameraSource.changeDevice(deviceId);
    Object.keys(get(this._openConnections)).forEach(peerB64 => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'change-video-input',
      };
      try {
        this._activeMediaTransportFor(peerB64).send(peerB64, JSON.stringify(msg));
      } catch (e: any) {
        console.error(
          "Failed to send 'change-video-input' message to peer: ",
          e.toString()
        );
      }
    });
  }

  async videoOn() {
    // Acquire the camera via CameraSource. The acquire call triggers
    // _onCameraTrackChange's open branch, which adds the track to
    // mainStream (lazily creating it) and calls setLocalStream on each
    // transport. Peer-side track attachment is done here, with the
    // keepalive-aware replaceTrack-vs-addTrack decision.
    if (!this._webrtcCameraHandle) {
      const handle = await this.cameraSource.acquire({ id: 'webrtc' });
      if (!handle) {
        const error = 'Failed to acquire camera for WebRTC video';
        console.error(error);
        this.eventCallback({ type: 'error', error });
        return;
      }
      this._webrtcCameraHandle = handle;

      // If there's a keepalive sender on each peer (left there by
      // videoOff), swap it for the real camera track via replaceTrack
      // — preserves the existing RTCRtpSender / m-line and avoids a
      // renegotiation. Otherwise (no prior video sender) addTrack creates
      // a new one with the standard renegotiation flow.
      const keepalive = this._videoKeepaliveTrack;
      const videoTrack = handle.track;
      for (const t of this._allMediaTransports()) {
        try {
          if (keepalive) {
            t.replaceTrack(keepalive, videoTrack, this.mainStream!);
          } else {
            t.addTrack(videoTrack, this.mainStream!);
          }
        } catch (e: any) {
          console.error(`Failed to attach video track: ${e.toString()}`);
        }
      }
      if (keepalive) this._releaseVideoKeepalive();
      this.eventCallback({ type: 'my-video-on' });
    }

    // Start the filmstrip encoder if peers need signals-carried video.
    this._reconcileSignalsVideo();

    this.logger.logAgentEvent({
      agent: encodeHashToBase64(this.roomClient.client.myPubKey),
      timestamp: Date.now(),
      event: 'MyVideoOn',
    });

    // Send 'video-on' signal to peers
    Object.keys(get(this._openConnections)).forEach(peerB64 => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'video-on',
      };
      try {
        this._activeMediaTransportFor(peerB64).send(peerB64, JSON.stringify(msg));
      } catch (e) {
        console.warn('Could not send video-on message to peer: ', e);
      }
    });
  }

  /**
   * Lazily build a 1x1 black canvas captureStream as a NAT-keepalive
   * video track. Idempotent — returns the existing track if already built.
   * The track is intentionally minimal (1 fps, 1x1) — its only job is to
   * keep RTP packets flowing so the candidate-pair NAT mapping stays warm.
   */
  private _ensureVideoKeepaliveTrack(): MediaStreamTrack | null {
    if (this._videoKeepaliveTrack && this._videoKeepaliveTrack.readyState === 'live') {
      return this._videoKeepaliveTrack;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      const stream = (canvas as HTMLCanvasElement & {
        captureStream: (frameRate?: number) => MediaStream;
      }).captureStream(1);
      const track = stream.getVideoTracks()[0];
      if (!track) return null;
      this._videoKeepaliveCanvas = canvas;
      this._videoKeepaliveStream = stream;
      this._videoKeepaliveTrack = track;
      return track;
    } catch (e: any) {
      console.warn('Failed to create video keepalive track:', e?.message ?? e);
      return null;
    }
  }

  private _releaseVideoKeepalive(): void {
    if (this._videoKeepaliveTrack) {
      try { this._videoKeepaliveTrack.stop(); } catch {}
    }
    this._videoKeepaliveTrack = null;
    this._videoKeepaliveStream = null;
    this._videoKeepaliveCanvas = null;
  }

  videoOff() {
    if (!this._webrtcCameraHandle) return;
    if (!this.mainStream) return;
    const videoTracks = this.mainStream.getVideoTracks();

    // Build a black-frame keepalive track and swap it onto every peer's
    // existing video sender via replaceTrack (no renegotiation, same
    // RTCRtpSender, same SDP m-line). This is the fix for the NAT
    // cooldown failure mode: with audio also muted, dropping the video
    // sender entirely (the previous behaviour) starved RTP egress, the
    // remote NAT aged out the candidate-pair mapping, and ICE went
    // disconnected -> failed.
    const keepaliveTrack = this._ensureVideoKeepaliveTrack();
    const stream = this.mainStream;

    if (keepaliveTrack) {
      for (const cameraTrack of videoTracks) {
        for (const t of this._allMediaTransports()) {
          try {
            t.replaceTrack(cameraTrack, keepaliveTrack, stream);
          } catch (e) {
            console.warn('videoOff: replaceTrack failed:', e);
          }
        }
      }
    } else {
      // No keepalive available (canvas / captureStream unsupported) —
      // fall back to the old behaviour of dropping the sender. This
      // path is the source of the NAT cooldown bug; in supported
      // browsers the keepalive path above is taken.
      for (const t of this._allMediaTransports()) {
        try {
          videoTracks.forEach(track => {
            t.removeTrack(track, stream);
          });
        } catch (e) {
          console.warn('Could not remove video track from peers: ', e);
        }
      }
    }

    // Release the WebRTC camera handle. If the filmstrip encoder is also
    // holding the camera, the device stays open until the reconciler
    // below releases that handle too. Otherwise CameraSource refcount
    // hits 0 and the device closes (LED off). _onCameraTrackChange's
    // close branch removes the (now-stopped) camera track from
    // mainStream — by then the keepalive sender is already in place on
    // every peer, so the close branch does no peer fanout.
    try { this._webrtcCameraHandle.release(); } catch {}
    this._webrtcCameraHandle = null;

    // Stop the filmstrip encoder. Clicking videoOff means the user
    // doesn't want video flowing in any carrier. Without this, the
    // filmstrip handle would keep the camera open and the LED on after
    // a "video off" click.
    this._reconcileSignalsVideo();

    Object.keys(get(this._openConnections)).forEach(peerB64 => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'video-off',
      };
      try {
        this._activeMediaTransportFor(peerB64).send(peerB64, JSON.stringify(msg));
      } catch (e) {
        console.warn('Could not send video-off message to peer: ', e);
      }
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
    Object.keys(get(this._openConnections)).forEach(peerB64 => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'change-audio-input',
      };
      try {
        this._activeMediaTransportFor(peerB64).send(peerB64, JSON.stringify(msg));
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

    Object.keys(get(this._openConnections)).forEach(peerB64 => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'audio-on',
      };
      try {
        this._activeMediaTransportFor(peerB64).send(peerB64, JSON.stringify(msg));
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

    Object.keys(get(this._openConnections)).forEach(peerB64 => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'audio-off',
      };
      try {
        this._activeMediaTransportFor(peerB64).send(peerB64, JSON.stringify(msg));
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
      // Canceled picker or acquisition failure: nothing was shared, so
      // don't activate the module or announce anything.
      if (!this.screenShareStream) return;
      this.screenShareOutTransport.setLocalStream(this.screenShareStream);
      for (const track of this.screenShareStream.getTracks()) {
        try {
          this.screenShareOutTransport.addTrack(track, this.screenShareStream);
        } catch (_e) {
          // duplicate-track adds are silently ignored
        }
      }
    }
    // Activate the module only after a source has been picked, so the share
    // pane opens on remote peers (and locally) only once sharing actually
    // starts. The activation must precede 'my-screen-share-on' so the local
    // video element is rendered when room-view sets its srcObject.
    await this.activateModule('screen-share');
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
      Object.keys(get(this._screenShareConnectionsOutgoing)).forEach(peerB64 => {
        this.screenShareOutTransport.closeConnection(peerB64, 'screenShareOff');
      });
      this.screenShareOutTransport.setLocalStream(null);
      this.screenShareStream = null;
      this.eventCallback({
        type: 'my-screen-share-off',
      });
    }
  }

  /**
   * Tear down own screen sharing fully: stop the stream and disconnect peers,
   * then deactivate the module so the share pane closes for everyone. Both
   * the big "Stop Screen Share" overlay and the toolbar button call this so
   * they can't drift on which steps they perform -- `screenShareOff` alone
   * leaves the module active and the pane open.
   */
  async stopScreenShare(): Promise<void> {
    this.screenShareOff();
    await this.deactivateModule('screen-share');
  }

  disconnectFromPeerVideo(pubKeyB64: AgentPubKeyB64) {
    if (get(this._openConnections)[pubKeyB64]) {
      this._activeMediaTransportFor(pubKeyB64).closeConnection(pubKeyB64, 'disconnectFromPeerVideo');
    }
  }

  disconnectFromPeerScreen(pubKeyB64: AgentPubKeyB64) {
    if (get(this._screenShareConnectionsIncoming)[pubKeyB64]) {
      this.screenShareInTransport.closeConnection(pubKeyB64, 'disconnectFromPeerScreen');
    }
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
   * Black-frame video track used as a NAT-keepalive replacement for the
   * camera track when the user turns video off. Generated from a 1x1
   * canvas captured at low fps. Lives ONLY on per-peer senders (via
   * replaceTrack); deliberately NOT on mainStream so local UI does not
   * render it and getVideoTracks() consumers continue to see "no video".
   *
   * Why: with audio muted (track.enabled = false) some NAT/codec combos
   * stop emitting RTP entirely, the candidate-pair mapping ages out, and
   * ICE goes disconnected -> failed within ~10s on srflx-srflx paths
   * with no relay candidate. Keeping a low-bitrate video sender alive
   * keeps RTP egress flowing and the NAT mapping warm.
   */
  private _videoKeepaliveTrack: MediaStreamTrack | null = null;
  private _videoKeepaliveCanvas: HTMLCanvasElement | null = null;
  private _videoKeepaliveStream: MediaStream | null = null;

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
   * Monotonic per-peer connection generation ("epoch"). Allocated by the
   * initiator on each new connection attempt and passed into the FSM transport,
   * which stamps it on outgoing signals and uses it for cross-attempt
   * "newest-wins" ordering. Because it lives on the store (which outlives any
   * FSM), it does NOT reset when an FSM is torn down and recreated — unlike the
   * FSM's own `peerSessionId`, which resets to 0 per instance and so cannot
   * order signals across a reconnect. Never reset for the session (a rejoining
   * peer gets a strictly higher epoch, so in-flight stale signals stay older).
   * See docs/WEBRTC_RECONNECT_IDENTITY.md.
   */
  private _connectionEpoch: Record<AgentPubKeyB64, number> = {};

  /** Allocate the next connection epoch for `peer` (monotonic, per session). */
  private _nextConnectionEpoch(peer: AgentPubKeyB64): number {
    const next = (this._connectionEpoch[peer] ?? 0) + 1;
    this._connectionEpoch[peer] = next;
    return next;
  }

  /**
   * Tracks the timestamp at which a video peer's iceConnectionState most
   * recently entered 'disconnected', for the grace-period recovery window
   * in stale cleanup. Set in the iceconnectionstatechange listener attached
   * by `_startMediaIceMonitor`; the invariant is that an entry exists iff
   * the underlying RTCPeerConnection's iceConnectionState is currently
   * 'disconnected'. Cleared on entry to any other ICE state, on close-
   * cleanup, and on the supersede paths (where the close handler is
   * short-circuited by the supersede guard).
   */
  _iceDisconnectedAt: Record<AgentPubKeyB64, number> = {};

  /**
   * (peer, connectionId) pairs that already have ICE listeners attached.
   * The FSM transitions through `signaling` more than once during
   * renegotiation, and `_dispatchMediaEvent` re-enters
   * `_startMediaIceMonitor` each time — without this guard, every
   * iceconnectionstatechange/icegatheringstatechange/icecandidate event
   * is logged N times for N signaling transitions on the same pc.
   */
  _iceMonitorsAttached = new Set<string>();

  /**
   * AbortController per (peer, connectionId) carrying the
   * `iceconnectionstatechange` / `icegatheringstatechange` / `icecandidate`
   * listeners attached by `_startMediaIceMonitor`. Calling `.abort()` on
   * stop actively removes the listeners regardless of whether the
   * underlying RTCPeerConnection is still alive — necessary because the
   * FSM-side teardown does not always destroy the pc synchronously, so
   * stale listeners on orphaned pcs would otherwise keep emitting
   * `ICE [...]: checking` events long after FsmClose (witnessed in the
   * 3-node toggle-storm capture, ~3 concurrent pcs per peer until
   * SDP timeout cleaned them up).
   */
  _iceMonitorAbortControllers = new Map<string, AbortController>();

  /**
   * Per-(peer, connectionId) establishment timings, captured for forensic
   * A/B-ing of the two WebRTC carriers on marginal links. Emitted as a
   * single `IceEstablishment` SimpleEvent on phase='connected', or as
   * `IceNeverConnected` if the connection closes first. See
   * WEBRTC_CARRIER_ANALYSIS.md for the analysis goal. Key format
   * `<peerB64>:<connectionId>`, matching `_iceMonitorsAttached`.
   */
  _iceTimings: Record<string, {
    t0: number;
    impl: 'simplepeer' | 'fsm';
    tIceConnected?: number;
    tGatherComplete?: number;
    relay?: boolean;
    finalIceState?: string;
    emitted?: boolean;
  }> = {};

  /**
   * As _iceDisconnectedAt, but for outgoing screen-share peers. Kept
   * separate because a single agent can have both a video connection and
   * an outgoing screen-share connection in flight with independent ICE
   * states; one going 'disconnected' must not affect the other's grace.
   */
  _screenShareIceDisconnectedAt: Record<AgentPubKeyB64, number> = {};

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
   * The set of active peers whose media is NOT currently flowing over
   * WebRTC. Audio and filmstrip video for these peers are carried over
   * Holochain remote signals. Precomputed as a derived store so the voice
   * encoder's pump loop doesn't recompute per-chunk — it just reads the
   * cached set.
   *
   * Membership is the complement of `connected` — ICE + DTLS up — not the
   * complement of "an entry exists". A peer mid-negotiation, mid-reconnect,
   * or holding a wedged entry is still carried by signals, so handover is
   * make-before-break in both directions. The rule and its rationale are in
   * `transport/carrier-coverage.ts`; the constructor's `derived` is the only
   * caller.
   *
   * Updates when: a peer appears/disappears in _activeAgents, or any
   * `_openConnections` write changes a peer's `connected` flag — which
   * includes connect, close, give-up, and the disableWebrtcWith teardown.
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
   * Peers a diagnostic request is in-flight for. Value carries the
   * current retry attempt (1-based). Removed on response receipt or
   * when retries are exhausted (and moved to `_failedDiagnosticRequests`).
   */
  _pendingDiagnosticRequests: Writable<Record<AgentPubKeyB64, { attempts: number; startedAt: number }>> = writable({});

  /**
   * Peers that exhausted retries with no response. UI surfaces these
   * so the user can see partial coverage and (optionally) re-try.
   */
  _failedDiagnosticRequests: Writable<Record<AgentPubKeyB64, true>> = writable({});

  /**
   * Peers we have actually had a WebRTC media connection with this
   * session — added the first time a connection to them reaches the
   * `connected` state. Session-scoped; entries are kept even after the
   * peer disconnects, because a peer who dropped mid-call is exactly who
   * we want diagnostic logs from. Drives `requestDiagnosticLogs()`'s
   * recipient list so a room-level request targets genuine call
   * participants rather than every known (incl. merely heard-about) agent.
   */
  private _conversationParticipants = new Set<AgentPubKeyB64>();

  /**
   * Clear cached diagnostic results so the request button returns to its
   * default requestable colour. Called after the merged log is downloaded
   * (results consumed). With no argument, clears every peer.
   */
  clearReceivedDiagnostics(pubKeyB64?: AgentPubKeyB64): void {
    this._receivedDiagnosticLogs.update(curr => {
      if (!pubKeyB64) return {};
      const next = { ...curr };
      delete next[pubKeyB64];
      return next;
    });
    this._failedDiagnosticRequests.update(curr => {
      if (!pubKeyB64) return {};
      const next = { ...curr };
      delete next[pubKeyB64];
      return next;
    });
  }

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

    // Video is 'live' if WebRTC has an active video track OR we've
    // received a filmstrip clip from this peer within the freshness
    // window (signals carrier carrying low-bandwidth video).
    const FILMSTRIP_LIVE_WINDOW_MS = 3000;
    const lastFilmstripMs = filmstripController.peerLastRecvMs.get(peerB64);
    const filmstripLive =
      lastFilmstripMs !== undefined &&
      Date.now() - lastFilmstripMs < FILMSTRIP_LIVE_WINDOW_MS;
    const video: PeerLinkSnapshot['video'] =
      conn?.video || filmstripLive
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
   * True iff media is actively flowing to/from this peer on either
   * carrier: a connected WebRTC connection, or signals-carrier voice or
   * filmstrip-video frames received within `MEDIA_LIVE_WINDOW_MS`.
   *
   * Used by `globalPresenceSet()` so that a peer with live media is never
   * pruned by ping/pong staleness alone. A Holochain-signal hiccup of more
   * than 3*PING_INTERVAL must not remove the pane of a peer we can still
   * see and hear. WebRTC connections that failed/closed or exceeded the
   * ICE disconnected grace are already removed from `_openConnections`, so
   * a surviving `connected` entry is genuinely live.
   */
  isPeerMediaLive(peerB64: AgentPubKeyB64): boolean {
    if (get(this._openConnections)[peerB64]?.connected) return true;
    const now = Date.now();
    const lastVoice = voiceController.peerLastRecvMs.get(peerB64);
    if (lastVoice !== undefined && now - lastVoice < MEDIA_LIVE_WINDOW_MS) {
      return true;
    }
    const lastFilmstrip = filmstripController.peerLastRecvMs.get(peerB64);
    if (
      lastFilmstrip !== undefined &&
      now - lastFilmstrip < MEDIA_LIVE_WINDOW_MS
    ) {
      return true;
    }
    return false;
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
    const blocked = new Set(get(this.blockedAgents));
    // We know we're here. Including self matters because peer tiles need
    // to render their observer's view of US — the icon strip on Gaston's
    // tile must include me. Excluding self happens at the per-tile level
    // (drop the observer from each tile's iteration), not here.
    out.add(this.myPubKeyB64);
    // My own active agents.
    for (const k of Object.keys(get(this._activeAgents))) {
      if (!blocked.has(k)) out.add(k);
    }
    // Peers with live media on either carrier. Ping/pong staleness must
    // not prune a peer we can still see or hear: a Holochain-signal hiccup
    // would otherwise remove the pane of a peer whose WebRTC (or
    // signals-carrier) media is flowing fine. See `isPeerMediaLive`.
    const mediaCandidates = new Set<AgentPubKeyB64>([
      ...Object.keys(get(this._openConnections)),
      ...voiceController.peerLastRecvMs.keys(),
      ...filmstripController.peerLastRecvMs.keys(),
    ]);
    for (const k of mediaCandidates) {
      if (k === this.myPubKeyB64 || blocked.has(k)) continue;
      if (this.isPeerMediaLive(k)) out.add(k);
    }
    // Anyone a *fresh* observer reports as present. We require the
    // observer's broadcast itself to be recent so that an observer who
    // dropped out doesn't keep ghost peers in the set forever.
    const now = Date.now();
    const observerStaleness = 2.8 * PING_INTERVAL;
    const others = get(this._othersConnectionStatuses);
    for (const observerKey of Object.keys(others)) {
      const obs = others[observerKey];
      if (!obs.peerLinks) continue;
      if (now - obs.lastUpdated > observerStaleness) continue;
      for (const [peerKey, snap] of Object.entries(obs.peerLinks)) {
        if (blocked.has(peerKey)) continue;
        if (snap.lastSeen === 'fresh' || snap.lastSeen === 'stale') {
          out.add(peerKey);
        }
      }
    }
    return out;
  }

  /**
   * Agents reported as present (ping-recent) by at least one fresh
   * observer, but who we ourselves cannot see directly. Drives placeholder
   * tiles. Ping-presence is sufficient — we do not require the observer
   * to have a working audio link, because in impolite-close scenarios
   * every peer's link to the departing agent breaks at roughly the same
   * time while `knownAgents` broadcasts still list them for ~30s; we want
   * the phantom tile to persist through that decay window rather than
   * vanishing in lockstep with everyone else's link failure.
   *
   * Whether anyone has a *working* link is exposed separately via
   * `observersConnectedTo()` so the placeholder can label the observer
   * list accurately.
   */
  phantomAgents(): AgentPubKeyB64[] {
    const active = get(this._activeAgents);
    const blocked = new Set(get(this.blockedAgents));
    const out = new Set<AgentPubKeyB64>();
    const now = Date.now();
    const observerStaleness = 2.8 * PING_INTERVAL;
    const others = get(this._othersConnectionStatuses);
    for (const observerKey of Object.keys(others)) {
      const obs = others[observerKey];
      if (!obs.peerLinks) continue;
      if (now - obs.lastUpdated > observerStaleness) continue;
      // Observer must themselves be fresh from our point of view — a peer
      // whose own broadcast we're losing shouldn't keep promoting phantoms.
      if (!active[observerKey]) continue;
      for (const [peerKey, snap] of Object.entries(obs.peerLinks)) {
        if (peerKey === this.myPubKeyB64) continue;
        if (blocked.has(peerKey)) continue;
        if (active[peerKey]) continue; // we already see them directly (ping-fresh)
        if (this.isPeerMediaLive(peerKey)) continue; // ...or via live media despite stale pong
        if (snap.lastSeen === 'fresh' || snap.lastSeen === 'stale') {
          out.add(peerKey);
        }
      }
    }
    return Array.from(out);
  }

  /**
   * For a phantom agent, which fresh observers still ping-see them
   * (lastSeen bucket 'fresh' or 'stale' in their broadcast peerLinks).
   * Drives the observer list on the placeholder tile.
   */
  observersSeeing(peerB64: AgentPubKeyB64): AgentPubKeyB64[] {
    const out: AgentPubKeyB64[] = [];
    const now = Date.now();
    const observerStaleness = 2.8 * PING_INTERVAL;
    const others = get(this._othersConnectionStatuses);
    for (const observerKey of Object.keys(others)) {
      const obs = others[observerKey];
      if (!obs.peerLinks) continue;
      if (now - obs.lastUpdated > observerStaleness) continue;
      const snap = obs.peerLinks[peerB64];
      if (!snap) continue;
      if (snap.lastSeen === 'fresh' || snap.lastSeen === 'stale') {
        out.push(observerKey);
      }
    }
    return out;
  }

  /**
   * Subset of `observersSeeing` who additionally have a working or
   * in-progress audio link to the phantom. Used to pick the observer-list
   * label: "connected via" when this is non-empty, "last seen by"
   * otherwise.
   */
  observersConnectedTo(peerB64: AgentPubKeyB64): AgentPubKeyB64[] {
    const out: AgentPubKeyB64[] = [];
    const now = Date.now();
    const observerStaleness = 2.8 * PING_INTERVAL;
    const others = get(this._othersConnectionStatuses);
    for (const observerKey of Object.keys(others)) {
      const obs = others[observerKey];
      if (!obs.peerLinks) continue;
      if (now - obs.lastUpdated > observerStaleness) continue;
      const snap = obs.peerLinks[peerB64];
      if (!snap) continue;
      if (
        snap.audioLink === 'webrtc' ||
        snap.audioLink === 'signals' ||
        snap.audioLink === 'negotiating'
      ) {
        out.push(observerKey);
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
      this.logger.logAgentEvent({
        agent: peerB64,
        timestamp: Date.now(),
        event: 'MyWebrtcEnable',
        detail: 'per-peer',
      });
    } else {
      payload.disableWebrtcWith = [...payload.disableWebrtcWith, peerB64];
      console.log(`toggleDisableWebrtc: disabled WebRTC for ${peerB64.slice(0, 8)}`);
      this.logger.logAgentEvent({
        agent: peerB64,
        timestamp: Date.now(),
        event: 'MyWebrtcDisable',
        detail: 'per-peer',
      });
    }

    await this._syncConversationPayload(payload);

    if (idx < 0) {
      this.disconnectFromPeerVideo(peerB64);
      this._clearPendingWebrtcStatus(peerB64);
    }
  }

  /**
   * Set the global default WebRTC implementation in the conversation
   * module's payload. Existing connections are torn down so the next
   * pong cycle re-establishes them via the newly-selected impl.
   * Symmetric union still applies — if the peer has 'fsm' set, the link
   * uses FSM regardless of our preference.
   */
  async setWebrtcImpl(impl: 'simplepeer' | 'fsm'): Promise<void> {
    await this._syncConversationPayload({ webrtcImpl: impl });
    this.logger.logAgentEvent({
      agent: this.myPubKeyB64,
      timestamp: Date.now(),
      event: impl === 'fsm' ? 'MyWebrtcEnable' : 'MyWebrtcDisable',
      detail: `impl=${impl} (global)`,
    });
    // Tear down all existing media connections so they re-establish
    // via the newly-selected impl on the next pong cycle.
    for (const peerB64 of Object.keys(get(this._openConnections))) {
      this.disconnectFromPeerVideo(peerB64);
    }
  }

  /** Read the current global webrtcImpl preference from our conversation
   *  payload. Defaults to 'fsm' (auto-flip falls back to 'simplepeer'). */
  myWebrtcImpl(): 'simplepeer' | 'fsm' {
    const existing = get(this._myModuleStates)['conversation'];
    const payload = existing ? parseConversationPayload(existing) : null;
    return payload?.webrtcImpl ?? 'fsm';
  }

  /**
   * Unified carrier selection — collapses `webrtcGloballyDisabled` and
   * `webrtcImpl` into one of three user-facing choices:
   *   - `'simplepeer'`: WebRTC enabled, simple-peer transport.
   *   - `'fsm'`:        WebRTC enabled, hand-rolled FSM transport.
   *   - `'signals'`:    WebRTC globally off, audio (Opus) and low-bandwidth
   *                     video (JPEG filmstrip) over Holochain signals.
   */
  carrierMode(): 'simplepeer' | 'fsm' | 'signals' {
    if (this.webrtcGloballyDisabled) return 'signals';
    return this.myWebrtcImpl();
  }

  /**
   * Apply a unified carrier mode. Tears down existing media connections
   * so the next pong cycle re-establishes via the new selection. The
   * conversation module's payload carries both `webrtcDisabled` and
   * `webrtcImpl` so peers see the change in one broadcast.
   */
  async setCarrierMode(mode: 'simplepeer' | 'fsm' | 'signals'): Promise<void> {
    const previous = this.carrierMode();
    if (previous === mode) return;

    if (mode === 'signals') {
      this.webrtcGloballyDisabled = true;
      window.localStorage.setItem('disableAllWebrtc', 'true');
      this.logger.logAgentEvent({
        agent: this.myPubKeyB64,
        timestamp: Date.now(),
        event: 'MyWebrtcDisable',
        detail: 'global',
      });
      // Tear down all current WebRTC media connections. Camera is left
      // alone — with the video-filmstrip module on the signals carrier,
      // the camera continues to feed video to peers; turning it off
      // would defeat the point of the new fallback. The reconciler
      // notices _signalsTargets becoming non-empty and starts the
      // filmstrip encoder against the still-acquired camera.
      for (const pubKeyB64 of Object.keys(get(this._openConnections))) {
        this.disconnectFromPeerVideo(pubKeyB64);
      }
      this._clearPendingWebrtcStatus();
      await this._syncConversationPayload({ webrtcDisabled: true });
      return;
    }

    // mode is 'simplepeer' or 'fsm'
    if (this.webrtcGloballyDisabled) {
      this.webrtcGloballyDisabled = false;
      window.localStorage.removeItem('disableAllWebrtc');
      this.logger.logAgentEvent({
        agent: this.myPubKeyB64,
        timestamp: Date.now(),
        event: 'MyWebrtcEnable',
        detail: 'global',
      });
    }
    await this._syncConversationPayload({
      webrtcDisabled: false,
      webrtcImpl: mode,
    });
    this.logger.logAgentEvent({
      agent: this.myPubKeyB64,
      timestamp: Date.now(),
      event: mode === 'fsm' ? 'MyWebrtcEnable' : 'MyWebrtcDisable',
      detail: `impl=${mode} (global)`,
    });
    // Force a re-establish so a flip between 'simplepeer' and 'fsm'
    // takes effect immediately rather than waiting for the next
    // natural reconnect.
    for (const pubKeyB64 of Object.keys(get(this._openConnections))) {
      this.disconnectFromPeerVideo(pubKeyB64);
    }
  }

  /**
   * Set or clear a per-peer impl override (`peerImpl[peerB64]`).
   *
   * `impl === null` clears the override; the link falls back to the
   * global `webrtcImpl` symmetric-union resolution. Tears down the
   * existing media connection so the swap takes effect on the next
   * pong cycle. `reason` is recorded in the `WebrtcImplFlip` log event
   * so the auto-toggle path and manual flips can be distinguished in
   * logs-graph.
   */
  async setPeerImpl(
    peerB64: AgentPubKeyB64,
    impl: 'simplepeer' | 'fsm' | null,
    reason: 'manual' | 'auto-outage' = 'manual',
  ): Promise<void> {
    const existing = get(this._myModuleStates)['conversation'];
    const payload: ConversationPayload = existing
      ? (parseConversationPayload(existing) ?? { ...DEFAULT_CONVERSATION_PAYLOAD })
      : { ...DEFAULT_CONVERSATION_PAYLOAD };
    const prevOverride = payload.peerImpl[peerB64];
    const nextPeerImpl: Record<AgentPubKeyB64, 'simplepeer' | 'fsm'> = { ...payload.peerImpl };
    if (impl === null) {
      delete nextPeerImpl[peerB64];
    } else {
      nextPeerImpl[peerB64] = impl;
    }
    payload.peerImpl = nextPeerImpl;
    this.logger.logAgentEvent({
      agent: peerB64,
      timestamp: Date.now(),
      event: 'WebrtcImplFlip',
      detail: `${prevOverride ?? 'inherit'}->${impl ?? 'inherit'}; reason=${reason}`,
    });
    await this._syncConversationPayload(payload);
    this.disconnectFromPeerVideo(peerB64);
  }

  /**
   * Read our own per-peer carrier selection for `peerB64`. Reflects our
   * explicit override only — not the symmetric-union resolution or the
   * peer's own choice. Returns:
   *   - `'signals'`:            peer is in our `disableWebrtcWith` list
   *   - `'simplepeer'`/`'fsm'`: we have a `peerImpl` override for them
   *   - `'inherit'`:            no per-peer override — the link follows
   *                             the global carrier and auto-flip policy
   */
  myPeerCarrier(peerB64: AgentPubKeyB64): 'inherit' | 'simplepeer' | 'fsm' | 'signals' {
    const existing = get(this._myModuleStates)['conversation'];
    const payload = existing ? parseConversationPayload(existing) : null;
    if (!payload) return 'inherit';
    if (payload.disableWebrtcWith.includes(peerB64)) return 'signals';
    return payload.peerImpl[peerB64] ?? 'inherit';
  }

  /**
   * Set the per-peer carrier for `peerB64` in a single conversation-payload
   * broadcast. Collapses the two underlying per-peer fields
   * (`disableWebrtcWith`, `peerImpl`) into one user-facing choice,
   * mirroring `setCarrierMode` for the global control:
   *   - `'signals'`:            add to `disableWebrtcWith`, clear any
   *                             impl override
   *   - `'simplepeer'`/`'fsm'`: set the `peerImpl` override, remove from
   *                             `disableWebrtcWith`
   *   - `'inherit'`:            clear both — the link follows the global
   *                             carrier and the auto-flip policy again
   * Tears down the existing media connection so the next pong cycle
   * re-establishes via the new selection.
   */
  async setPeerCarrier(
    peerB64: AgentPubKeyB64,
    carrier: 'inherit' | 'simplepeer' | 'fsm' | 'signals',
  ): Promise<void> {
    const previous = this.myPeerCarrier(peerB64);
    if (previous === carrier) return;

    const existing = get(this._myModuleStates)['conversation'];
    const payload: ConversationPayload = existing
      ? (parseConversationPayload(existing) ?? { ...DEFAULT_CONVERSATION_PAYLOAD })
      : { ...DEFAULT_CONVERSATION_PAYLOAD };

    const nextPeerImpl: Record<AgentPubKeyB64, 'simplepeer' | 'fsm'> = { ...payload.peerImpl };
    delete nextPeerImpl[peerB64];
    if (carrier === 'simplepeer' || carrier === 'fsm') {
      nextPeerImpl[peerB64] = carrier;
    }
    payload.peerImpl = nextPeerImpl;

    payload.disableWebrtcWith = payload.disableWebrtcWith.filter(p => p !== peerB64);
    if (carrier === 'signals') {
      payload.disableWebrtcWith = [...payload.disableWebrtcWith, peerB64];
    }

    this.logger.logAgentEvent({
      agent: peerB64,
      timestamp: Date.now(),
      event: carrier === 'signals' ? 'MyWebrtcDisable' : 'MyWebrtcEnable',
      detail: `carrier=${previous}->${carrier} (per-peer)`,
    });

    await this._syncConversationPayload(payload);

    this.disconnectFromPeerVideo(peerB64);
    if (carrier === 'signals') {
      this._clearPendingWebrtcStatus(peerB64);
    }
  }

  // ===========================================================================================
  // PHASE 3 — Automated failure toggle bookkeeping
  // ===========================================================================================

  /** Cooldown (ms) between auto-toggle flips for the same peer. Prevents
   *  ping-pong when both sides observe an outage and try to flip
   *  simultaneously. */
  private static readonly AUTO_FLIP_COOLDOWN_MS = 60_000;

  /** Maximum number of auto-toggle flips per peer per session before
   *  giving up on WebRTC for that link and pinning to signals. */
  private static readonly AUTO_FLIP_MAX_ATTEMPTS = 3;

  /** Wall-clock time of the last auto-flip for each peer, keyed by
   *  pubkey. Read by `_maybeAutoFlipImpl` to enforce the cooldown. */
  private _lastAutoFlipMs = new Map<AgentPubKeyB64, number>();

  /** Auto-flip count per peer (this session). Once it hits
   *  `AUTO_FLIP_MAX_ATTEMPTS`, the next outage falls back to signals
   *  via `disableWebrtcWith` instead of flipping again. */
  private _autoFlipCount = new Map<AgentPubKeyB64, number>();

  /**
   * Phase 3 auto-toggle. Called from `_checkAudibilityOutages` at the
   * point where an `AudibilityOutageStart` is about to be emitted, with
   * a confirmed relay opportunity (a third peer can hear the target).
   *
   * Decision tree:
   *   - We're already on signals for this link (no other webrtc impl
   *     to flip to) → no-op, let the outage event fire.
   *   - Cooldown active (< AUTO_FLIP_COOLDOWN_MS since last flip) →
   *     no-op, the previous flip hasn't had time to settle.
   *   - Flip count exceeded → pin the link to signals via
   *     `disableWebrtcWith`. Future outages won't trigger more flips.
   *   - Otherwise → flip the impl (FSM ↔ simple-peer) and record the
   *     attempt.
   *
   * The flip is broadcast in the conversation payload; the peer's
   * `onModulePayloadChange` tears down their side of the connection
   * so both sides reconnect on the new impl in lockstep.
   */
  private async _maybeAutoFlipImpl(peerB64: AgentPubKeyB64): Promise<void> {
    const now = Date.now();

    // Carrier-switch hysteresis (§6.4): bias toward staying on a healthy webrtc
    // transport. Since §6.1 an FSM phase of `connected` means ICE+DTLS are up —
    // media flows regardless of momentary RTP loss — so an audibility dip there
    // is most likely last-mile uplink loss, which flipping to the (far worse)
    // signals carrier does not fix. The 30s outage gate already supplies the
    // "sustained" requirement; dwell is enforced by decideAutoFlip's cooldown,
    // so here decideCarrierSwitch contributes the transport-up bias.
    const fsmTransportUp =
      this.webrtcImplFor(peerB64) === 'fsm' &&
      this.mediaTransportFsm.getPhase(peerB64) === 'connected';
    const hysteresis = decideCarrierSwitch({
      current: 'webrtc',
      transportUp: fsmTransportUp,
      consecutiveBad: 1, // the outage scan already waited out the sustained window
      msSinceLastSwitch: Number.POSITIVE_INFINITY, // dwell handled by decideAutoFlip
      badThreshold: 1,
      minDwellMs: 0,
    });
    if (hysteresis.action === 'stay' && hysteresis.reason === 'transport-up') {
      this.logger.logAgentEvent({
        agent: peerB64,
        timestamp: now,
        event: 'CarrierHold',
        detail: 'webrtc transport up (ICE+DTLS) — holding through audibility dip',
      });
      return;
    }

    const decision = decideAutoFlip({
      currentImpl: this.webrtcImplFor(peerB64),
      onSignals: this.webrtcGloballyDisabled || this.webrtcDisabled(peerB64),
      now,
      lastFlipMs: this._lastAutoFlipMs.get(peerB64),
      flipCount: this._autoFlipCount.get(peerB64) ?? 0,
      cooldownMs: StreamsStore.AUTO_FLIP_COOLDOWN_MS,
      maxAttempts: StreamsStore.AUTO_FLIP_MAX_ATTEMPTS,
    });

    if (decision.action === 'noop') return;

    if (decision.action === 'fallback') {
      // Exhausted — pin this peer link to signals. The user can
      // re-enable manually via the per-peer toggle in the UI.
      const flipCount = this._autoFlipCount.get(peerB64) ?? 0;
      this.logger.logAgentEvent({
        agent: peerB64,
        timestamp: now,
        event: 'WebrtcImplFlip',
        detail: `exhausted after ${flipCount} flips; pinning to signals`,
      });
      const existing = get(this._myModuleStates)['conversation'];
      const payload: ConversationPayload = existing
        ? (parseConversationPayload(existing) ?? { ...DEFAULT_CONVERSATION_PAYLOAD })
        : { ...DEFAULT_CONVERSATION_PAYLOAD };
      if (!payload.disableWebrtcWith.includes(peerB64)) {
        payload.disableWebrtcWith = [...payload.disableWebrtcWith, peerB64];
        await this._syncConversationPayload(payload);
        this.disconnectFromPeerVideo(peerB64);
        this._clearPendingWebrtcStatus(peerB64);
      }
      return;
    }

    // decision.action === 'flip'
    this._lastAutoFlipMs.set(peerB64, now);
    this._autoFlipCount.set(peerB64, (this._autoFlipCount.get(peerB64) ?? 0) + 1);
    await this.setPeerImpl(peerB64, decision.nextImpl, 'auto-outage');
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
   * Last-emitted quality bucket per peer, keyed by pubKeyB64. Value is
   * a stable string like `"webrtc:ok:clean"`. Used to dedupe so that
   * QualityBucketChange events only fire when the bucket actually changes
   * rather than every poll cycle.
   */
  private _lastQualityBucket = new Map<string, string>();

  /**
   * Most recent reason a peer left the `connected` webrtc phase, captured from
   * the FSM transition that took it out of `connected` (e.g. "disconnectFromPeerVideo",
   * "peer left", "transport failure: dtls-failed"). Read by `_handleMediaClosed`
   * to annotate the `CarrierSwitch fsm->signals` downgrade with *why* webrtc was
   * abandoned (§6.6), instead of leaving the analyst to correlate timestamps.
   */
  private _lastWebrtcExitReason = new Map<AgentPubKeyB64, string>();

  /**
   * Wall-clock ms since the signal carrier was inferred down (no pong from
   * any known peer), or undefined while it is up. Drives the
   * SignalCarrierDown/Up forensic events emitted from `pingAgents`.
   */
  private _signalCarrierDownSince: number | undefined;

  /**
   * Last computed `globalPresenceSet()`, kept so the ping cycle can diff
   * membership and emit PresenceAdd/PresenceRemove forensic events.
   */
  private _lastPresenceSet = new Set<AgentPubKeyB64>();

  /**
   * Per-peer audibility-outage tracking. When our audioLink to this peer
   * has been 'down' or 'negotiating' for ≥ OUTAGE_THRESHOLD_MS, *and* some
   * third peer reports being audible to that target, we emit an
   * AudibilityOutageStart event. The `emitted` flag guards against
   * multiple Starts per outage and tells the End side whether to fire on
   * recovery. Populated / drained by `_checkAudibilityOutages` on the
   * 2s ping tick.
   */
  private _outageStates = new Map<string, { startedAt: number; emitted: boolean }>();

  /**
   * Aggregation state for SdpData events, keyed by `${peer}:${connId}:${sdpType}`.
   * FSM Perfect-Negotiation glare can fire hundreds of offer/answer pairs
   * per second on the same connection; ICE trickle on simplepeer fires
   * dozens of `candidate` events. The first event in a burst passes
   * through normally for forensic fidelity; subsequent events within
   * `SDP_AGGREGATE_WINDOW_MS` are coalesced. A summary
   * `SdpData fsm-offer x47 over 1.0s` flushes either when the next event
   * arrives outside the window or when the periodic sweep catches a
   * stale burst (e.g. storm ended without another event).
   */
  private _sdpDataAggregates = new Map<string, {
    count: number;
    firstTimestamp: number;
    lastTimestamp: number;
    agent: AgentPubKeyB64;
    connectionId: string;
    sdpType: string;
  }>();
  private static readonly SDP_AGGREGATE_WINDOW_MS = 1000;

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

    // Resume if still suspended (Electron/Wayland sometimes leaves the
    // context suspended past creation; a suspended context means the audio
    // graph doesn't run and the analyser reads back zeros, even though the
    // <video> element plays audio fine).
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

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
      // The surrounding try/catch stays: it protects the store updates and the
      // two dispatch calls below, not just the parse.
      const parsed = parseSignalPayload<ModuleStateEnvelope>(signal.payload);
      if (!parsed.ok) {
        console.warn(`Dropped ModuleState from ${pubkeyB64.slice(0, 8)}: ${parsed.error}`);
        return;
      }
      const envelope = parsed.value;
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
      // The surrounding try/catch stays: `mod.onData` is arbitrary module code
      // (voice decode, filmstrip decode) and can throw for reasons unrelated to
      // the payload being well-formed.
      // `chunk` stays `any`: it is module-defined payload handed straight to
      // `onData`, whose signature differs per module. Narrowing it here would
      // only move the cast.
      const parsed = parseSignalPayload<{ moduleId: string; chunk: any }>(
        signal.payload
      );
      if (!parsed.ok) {
        console.warn(`Dropped ModuleData from ${pubkeyB64.slice(0, 8)}: ${parsed.error}`);
        return;
      }
      const { moduleId, chunk } = parsed.value;
      const mod = getModule(moduleId);
      mod?.onData?.(pubkeyB64, chunk);
    } catch (e) {
      console.warn('ModuleData handler failed:', e);
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
        // `currentStatus &&` is required, matching the InitSent and AcceptSent
        // branches above. A peer can reach here with no entry: `pingAgents`
        // seeds `_connectionStatuses` every 2s, but `handlePongUi` adds peers to
        // `_knownAgents` from pong metadata without seeding a status. A peer
        // learned via pong that sends SdpData before the next ping tick — or an
        // incoming FSM offer — hits an undefined status, and the TypeError used
        // to escape into handleSignal's drain.
        if (currentStatus && currentStatus.type === 'Connected') {
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
      const conn = get(this._openConnections)[pubkey];
      if (conn) {
        // Repair on the transport that actually owns this peer's
        // connection. This was `this.mediaTransport` — the bare SimplePeer
        // transport — whose `addTrack` iterates its *own* connection map.
        // For a peer on the FSM, which is the default carrier, that map
        // does not contain them, so the repair was a silent no-op that
        // still consumed the cooldown and the attempt budget
        // (MAINTAINABILITY_ASSESSMENT.md §3.12).
        //
        // `_activeMediaTransportFor` is the same authority Case 2
        // (`_tryReplaceTrackRecovery`) already uses, so the two halves of
        // this recovery family now agree. It is chosen over
        // `_allMediaTransports()` because addressing the owning transport
        // is strictly narrower, and over per-peer `pc.addTrack` because
        // that would need a renegotiation contract the two carriers do not
        // share — SimplePeer owns its own negotiation, and bypassing its
        // `addTrack` is not equivalent. Retiring that asymmetry is Phase 4.
        const transport = this._activeMediaTransportFor(pubkey);
        if (!transport.hasConnection(pubkey)) {
          // The slot has outlived the transport's own state; there is
          // nothing to add a track to. Return without recording an
          // attempt — burning the budget on a no-op is what let this
          // defect hide.
          this.logger.logCustomMessage(
            `Reconcile skipped [${pubkey.slice(0, 8)}]: no transport connection`,
          );
          return;
        }
        try {
          for (const track of this.mainStream.getTracks()) {
            transport.addTrack(track, this.mainStream);
          }
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
    _connInfo: OpenConnectionInfo,
    audioTrack: MediaStreamTrack | undefined,
    videoTrack: MediaStreamTrack | undefined
  ): boolean {
    try {
      const pc = this._activeMediaTransportFor(pubkey).getRTCPeerConnection(pubkey);
      if (!pc) return false;

      const senders = pc.getSenders();
      let success = true;

      // Single-peer recovery: drive replaceTrack directly on the
      // RTCRtpSender so we don't perturb other peers via the
      // transport-wide replaceTrack fan-out.
      if (audioTrack) {
        const audioSender = senders.find(s => s.track?.kind === 'audio');
        if (audioSender) {
          audioSender.replaceTrack(audioTrack);
          this.logger.logCustomMessage(`replaceTrack audio [${pubkey.slice(0, 8)}]: success`);
        } else {
          success = false;
        }
      }

      if (videoTrack) {
        const videoSender = senders.find(s => s.track?.kind === 'video');
        if (videoSender) {
          videoSender.replaceTrack(videoTrack);
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
   * Heavier track recovery: closes the connection so the next ensureConnection
   * cycle re-creates the peer with fresh tracks. This triggers renegotiation
   * but is more reliable than replaceTrack for some edge cases.
   *
   * The original implementation cloned the local stream and re-added tracks
   * on the live peer; with the transport abstraction we drop that mode and
   * fall back to a full reconnect, which the conversation module's normal
   * pong-driven retry will execute on the next cycle.
   */
  private _cloneStreamRecovery(
    pubkey: AgentPubKeyB64,
    _connInfo: OpenConnectionInfo,
    _audioTrack: MediaStreamTrack | undefined,
    _videoTrack: MediaStreamTrack | undefined
  ) {
    if (!this.mainStream) return;
    console.warn(`Falling back to reconnect-based recovery for ${pubkey.slice(0, 8)}`);
    this.logger.logCustomMessage(`Reconnect recovery [${pubkey.slice(0, 8)}]`);
    this._activeMediaTransportFor(pubkey).closeConnection(pubkey, 'clone-recovery fallback');
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

  /** Maximum number of attempts before marking a diagnostic request failed. */
  private static readonly DIAGNOSTIC_MAX_ATTEMPTS = 3;
  /** Per-attempt timeout (ms) before retrying or giving up. */
  private static readonly DIAGNOSTIC_ATTEMPT_TIMEOUT_MS = 8_000;

  /**
   * Request diagnostic logs from a specific peer (or, with no argument,
   * every peer in this conversation) via Holochain signal. Retries up to
   * DIAGNOSTIC_MAX_ATTEMPTS times if no response arrives within
   * DIAGNOSTIC_ATTEMPT_TIMEOUT_MS per attempt. Peers that exhaust retries
   * land in `_failedDiagnosticRequests`.
   *
   * The room-level recipient set is the union of `_conversationParticipants`
   * (peers we have had a media connection with this session, incl. ones who
   * have since dropped) and the current `globalPresenceSet()`. This
   * deliberately excludes merely heard-about (`'told'`) agents who were
   * never in the call — requesting from them only produced timeouts and
   * polluted the merged log.
   *
   * Calling again for a peer already in pending/failed re-starts the
   * retry loop from attempt 1 — lets the user manually retry from the UI.
   */
  async requestDiagnosticLogs(pubKeyB64?: AgentPubKeyB64) {
    const targetKeys = pubKeyB64
      ? [pubKeyB64]
      : [
          ...new Set<AgentPubKeyB64>([
            ...this._conversationParticipants,
            ...this.globalPresenceSet(),
          ]),
        ].filter(a => a !== this.myPubKeyB64);
    if (targetKeys.length === 0) return;

    // Clear any prior failed state for these peers — manual re-trigger.
    this._failedDiagnosticRequests.update(curr => {
      const next = { ...curr };
      targetKeys.forEach(k => delete next[k]);
      return next;
    });

    targetKeys.forEach(k => this._startDiagnosticAttempt(k, 1));

    this.logger.logCustomMessage(
      `Requested diagnostic logs from ${targetKeys.map(k => k.slice(0, 8)).join(', ')}`
    );
  }

  /**
   * Single attempt of a diagnostic request to one peer. Sends the signal,
   * schedules a timeout that either retries (attempt + 1) or marks failed.
   * Handler is no-op if a response has already arrived by the time the
   * timeout fires (the peer is no longer pending).
   */
  private _startDiagnosticAttempt(peerB64: AgentPubKeyB64, attempt: number): void {
    this._pendingDiagnosticRequests.update(curr => ({
      ...curr,
      [peerB64]: { attempts: attempt, startedAt: Date.now() },
    }));

    const peerHash = decodeHashFromBase64(peerB64);
    this.roomClient.sendMessage([peerHash], 'DiagnosticRequest', '').catch(e => {
      this.logger.logCustomMessage(
        `DiagnosticRequest send failed [${peerB64.slice(0, 8)}] attempt ${attempt}: ${e?.message ?? e}`
      );
    });

    setTimeout(() => {
      const stillPending = get(this._pendingDiagnosticRequests)[peerB64];
      // Response arrived (handler cleared pending) or user re-triggered
      // a fresh attempt that supersedes this one.
      if (!stillPending || stillPending.attempts !== attempt) return;

      if (attempt < StreamsStore.DIAGNOSTIC_MAX_ATTEMPTS) {
        this.logger.logCustomMessage(
          `DiagnosticRequest timeout [${peerB64.slice(0, 8)}] attempt ${attempt}, retrying`
        );
        this._startDiagnosticAttempt(peerB64, attempt + 1);
      } else {
        this.logger.logCustomMessage(
          `DiagnosticRequest failed [${peerB64.slice(0, 8)}] after ${attempt} attempts`
        );
        this._pendingDiagnosticRequests.update(curr => {
          const next = { ...curr };
          delete next[peerB64];
          return next;
        });
        this._failedDiagnosticRequests.update(curr => ({ ...curr, [peerB64]: true }));
      }
    }, StreamsStore.DIAGNOSTIC_ATTEMPT_TIMEOUT_MS);
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
   * Build a merged diagnostic log combining local events with every
   * received remote snapshot. The result is a single timeline ordered
   * by timestamp, tagged with which agent emitted each entry. Used by
   * the room-level bulk download path.
   */
  exportMergedLogsAll(): object {
    const localAgentEvents = this.logger.getRecentAgentEvents();
    const localCustomLogs = this.logger.getRecentCustomLogs();
    const allRemote = get(this._receivedDiagnosticLogs);

    type MergedEntry = {
      timestamp: number;
      source: AgentPubKeyB64; // emitter of the entry
      sourceLabel: 'local' | 'remote';
      type: string;
      detail: string;
      connectionId?: string;
    };
    const merged: MergedEntry[] = [];

    Object.entries(localAgentEvents).forEach(([agent, events]) => {
      events.forEach(e => {
        merged.push({
          timestamp: e.timestamp,
          source: this.myPubKeyB64,
          sourceLabel: 'local',
          type: 'event',
          detail: `[${agent.slice(0, 8)}] ${e.event}${e.detail ? ` ${e.detail}` : ''}`,
          connectionId: e.connectionId,
        });
      });
    });
    localCustomLogs.forEach(log => {
      merged.push({
        timestamp: log.timestamp,
        source: this.myPubKeyB64,
        sourceLabel: 'local',
        type: 'custom',
        detail: log.log,
      });
    });

    const respondingPeers: AgentPubKeyB64[] = [];
    Object.entries(allRemote).forEach(([peerB64, snapshot]) => {
      respondingPeers.push(peerB64);
      snapshot.agentEvents.forEach(e => {
        merged.push({
          timestamp: e.timestamp,
          source: peerB64,
          sourceLabel: 'remote',
          type: 'event',
          detail: `[${e.agent.slice(0, 8)}] ${e.event}${e.detail ? ` ${e.detail}` : ''}`,
          connectionId: e.connectionId,
        });
      });
      snapshot.customLogs.forEach(log => {
        merged.push({
          timestamp: log.timestamp,
          source: peerB64,
          sourceLabel: 'remote',
          type: 'custom',
          detail: log.log,
        });
      });
    });

    merged.sort((a, b) => a.timestamp - b.timestamp);

    return {
      generatedAt: Date.now(),
      localAgent: this.myPubKeyB64,
      respondingPeers,
      entries: merged,
    };
  }

  /**
   * Bucket RTT, loss, and jitter into coarse human-scale bands. The goal
   * is log compression: every poll cycle the raw numbers wiggle, but the
   * bucket changes only when quality actually shifts category. RTT bands
   * are tuned for voice — >200ms is where duplex conversation starts to
   * feel laggy; >400ms is walkie-talkie territory. Loss bands match the
   * points where Opus concealment starts to be audible (1%) and where
   * most listeners will complain (3%). Jitter bands are tuned around the
   * voice jitter buffer (80 ms target) — anything past `rough` means the
   * buffer is being overrun and audio starts to glitch. The signals
   * carrier can hit `choppy`/`broken` under Holochain signal overload;
   * surfacing that as a bucket transition (rather than hiding it in the
   * `detail` text) makes it usable as a failover input.
   */
  private _qualityBucket(
    carrier: 'webrtc' | 'signals',
    rttMs: number | null,
    jitterMs: number | null,
    lossPercent: number | null,
  ): string {
    const rttBand =
      rttMs === null ? 'unknown'
      : rttMs <= 80 ? 'good'
      : rttMs <= 200 ? 'ok'
      : rttMs <= 400 ? 'poor'
      : 'bad';
    const lossBand =
      lossPercent === null ? 'unknown'
      : lossPercent < 1 ? 'clean'
      : lossPercent <= 3 ? 'mild'
      : 'lossy';
    const jitBand =
      jitterMs === null ? 'unknown'
      : jitterMs < 30 ? 'smooth'
      : jitterMs <= 100 ? 'rough'
      : jitterMs <= 500 ? 'choppy'
      : 'broken';
    return `${carrier}:${rttBand}:${lossBand}:${jitBand}`;
  }

  /**
   * Emit a QualityBucketChange event iff the (carrier, rtt-band, loss-band)
   * tuple for this peer has changed since the last emission. Called from
   * both the WebRTC stats poll and the pong handler — whichever carrier is
   * currently active drives the emission. Skip the initial transition from
   * `unknown`-only buckets to avoid a spurious event on first sample.
   */
  private _maybeEmitQualityChange(
    pubKeyB64: AgentPubKeyB64,
    carrier: 'webrtc' | 'signals',
    rttMs: number | null,
    jitterMs: number | null,
    lossPercent: number | null,
  ) {
    // WebRTC: the first stats poll after `connected` often returns RTT
    // before any inbound-rtp packets, leaving loss null for ~1 cycle.
    // That used to fire a spurious "webrtc:good:unknown" bucket one tick
    // before the real "webrtc:good:clean". Require a fully-defined sample
    // on the webrtc carrier — bucketing is cheap, we can wait a poll.
    // Signals: RTT comes from pong-echo every cycle, loss/jitter only
    // exist while voice is flowing. Don't gate signals on loss or we'd
    // never bucket idle/muted links. Just require any signal at all.
    if (carrier === 'webrtc' && (rttMs === null || lossPercent === null)) return;
    if (rttMs === null && lossPercent === null) return;
    const bucket = this._qualityBucket(carrier, rttMs, jitterMs, lossPercent);
    const last = this._lastQualityBucket.get(pubKeyB64);
    if (bucket === last) return;
    this._lastQualityBucket.set(pubKeyB64, bucket);
    const detail =
      `${bucket}` +
      (rttMs !== null ? ` rtt=${rttMs}ms` : '') +
      (jitterMs !== null ? ` jit=${jitterMs}ms` : '') +
      (lossPercent !== null ? ` loss=${lossPercent}%` : '');
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: Date.now(),
      event: 'QualityBucketChange',
      detail,
    });
  }

  /**
   * Log an SdpData event with burst aggregation. See `_sdpDataAggregates`
   * for the rationale. First event of a burst always passes through with
   * full detail; subsequent events within SDP_AGGREGATE_WINDOW_MS are
   * coalesced into a count. When a new event arrives after the window
   * expires the prior burst (if count > 1) is flushed as a summary
   * before the new event is emitted. `_flushStaleSdpAggregates` handles
   * bursts that end with no follow-up event.
   */
  private _logSdpDataEvent(
    agent: AgentPubKeyB64,
    connectionId: string,
    sdpType: string,
  ): void {
    const key = `${agent}:${connectionId}:${sdpType}`;
    const now = Date.now();
    const entry = this._sdpDataAggregates.get(key);
    const withinWindow = entry && (now - entry.lastTimestamp) < StreamsStore.SDP_AGGREGATE_WINDOW_MS;

    if (withinWindow) {
      entry!.count += 1;
      entry!.lastTimestamp = now;
      return;
    }

    if (entry && entry.count > 1) {
      this._emitSdpAggregateSummary(entry);
    }

    this.logger.logAgentEvent({
      agent,
      timestamp: now,
      event: 'SdpData',
      connectionId,
      detail: sdpType,
    });
    this._sdpDataAggregates.set(key, {
      count: 1,
      firstTimestamp: now,
      lastTimestamp: now,
      agent,
      connectionId,
      sdpType,
    });
  }

  private _emitSdpAggregateSummary(entry: {
    count: number;
    firstTimestamp: number;
    lastTimestamp: number;
    agent: AgentPubKeyB64;
    connectionId: string;
    sdpType: string;
  }): void {
    const durationMs = entry.lastTimestamp - entry.firstTimestamp;
    this.logger.logAgentEvent({
      agent: entry.agent,
      timestamp: entry.lastTimestamp,
      event: 'SdpData',
      connectionId: entry.connectionId,
      detail: `${entry.sdpType} x${entry.count} over ${(durationMs / 1000).toFixed(1)}s`,
    });
  }

  /**
   * Log a single FSM transition as a structured event. Driven by the
   * FsmTransport's onTransition callback (which forwards every
   * PeerConnectionFSM._onTransition call). The detail string carries
   * `<from>-><to> trigger="..."` so log analysis can attribute
   * signaling re-entries to specific causes — notably the
   * "fresh peer for new remote connection" path that fires on glare-
   * induced renegotiation cycles. peerSessionId, when present, makes
   * it possible to count distinct peer-session generations within a
   * single connectionId.
   *
   * Self-transitions (fromState === toState) are still logged: the
   * FSM uses these to signal sub-state changes within a phase (e.g.
   * reconnecting → reconnecting on a full reconnect) and they're the
   * very events we need to see when diagnosing storm-like behaviour.
   */
  private _logFsmTransition(entry: import('@lightningrodlabs/webrtc-peer').FSMTransitionEntry): void {
    // Drop internal DTLS-watchdog bookkeeping. These are self-transitions
    // within `connecting`, fire 3-4 times per successful FSM connection,
    // and duplicate the information already carried by the surrounding
    // ICE state events. Keep them out of the timeline unless we're
    // specifically debugging DTLS / data-channel readiness.
    if (entry.trigger.startsWith('DIAG:')) return;
    // Capture the reason a peer leaves a live webrtc call so the downgrade to
    // signals can name it (§6.6). The FSM logs the transition (onTransition)
    // before the corresponding state-change event reaches `_handleMediaClosed`,
    // so this is populated in time. Use the connected->X trigger (root cause:
    // disconnectFromPeerVideo / peer-left / transport-failure) rather than the
    // eventual close trigger, which is often a downstream "stale ICE" note.
    if (entry.fromState === 'connected' && entry.toState !== 'connected') {
      this._lastWebrtcExitReason.set(entry.remoteAgent, entry.trigger);
    }
    // Include the underlying transport states so a transition's cause can be
    // read straight from the log (e.g. confirm ICE vs DTLS on a 'failed'
    // attribution) without correlating against separate ICE-state events. Only
    // real transitions carry a snapshot; same-state log entries omit it.
    const snap = entry.transportSnapshot;
    const transport = snap
      ? ` ice=${snap.ice} dtls=${snap.dtls} sig=${snap.signaling} gather=${snap.gathering} dc=${snap.dataChannel ?? 'none'}`
      : '';
    const detail =
      `${entry.fromState}->${entry.toState} trigger="${entry.trigger}"` +
      (entry.peerSessionId !== undefined ? ` peerSession=${entry.peerSessionId}` : '') +
      transport;
    this.logger.logAgentEvent({
      agent: entry.remoteAgent,
      timestamp: entry.timestamp,
      event: 'FsmTransition',
      connectionId: entry.connectionId,
      detail,
    });
  }

  /**
   * Flush SdpData aggregates whose last event is older than the window —
   * i.e. bursts that ended without another event to push them out
   * naturally. Called on the same 2s ping tick that drives the rest of
   * the periodic bookkeeping.
   */
  private _flushStaleSdpAggregates(): void {
    const now = Date.now();
    for (const [key, entry] of this._sdpDataAggregates) {
      if ((now - entry.lastTimestamp) >= StreamsStore.SDP_AGGREGATE_WINDOW_MS) {
        if (entry.count > 1) this._emitSdpAggregateSummary(entry);
        this._sdpDataAggregates.delete(key);
      }
    }
  }

  /**
   * Flush all SdpData aggregates for a given connectionId. Called from
   * the close/error paths so the storm summary lands in the timeline
   * immediately before the FsmClose / SimplePeerClose / *Error event,
   * not at the next periodic tick (where it would orphan).
   */
  private _flushSdpAggregatesForConnection(connectionId: string): void {
    for (const [key, entry] of this._sdpDataAggregates) {
      if (entry.connectionId === connectionId) {
        if (entry.count > 1) this._emitSdpAggregateSummary(entry);
        this._sdpDataAggregates.delete(key);
      }
    }
  }

  /**
   * Scan every peer in the presence set for sustained audibility outages.
   * The condition is: our audioLinkFor(peer) has been in 'down' or
   * 'negotiating' for ≥30s AND at least one other peer's broadcast
   * peerLinks reports *they* are audible to that same peer (webrtc or
   * signals). That's the "a relay could fix this" signal — we skip
   * flagging outages where no relay opportunity exists (the peer is
   * actually unreachable from everyone, or we're the only observer).
   *
   * Called from pingAgents() every PING_INTERVAL (2s). The 30s threshold
   * means a Start event fires no sooner than ~3 poll cycles after the
   * link first goes bad. End fires on any transition back to an audible
   * state ('webrtc', 'signals', 'muted', 'blocked', 'absent').
   */
  private _checkAudibilityOutages(): void {
    const OUTAGE_THRESHOLD_MS = 30_000;
    const now = Date.now();
    const presence = this.globalPresenceSet();
    const others = get(this._othersConnectionStatuses);

    for (const peerB64 of presence) {
      if (peerB64 === this.myPubKeyB64) continue;

      const link = this.audioLinkFor(peerB64);
      const isOutage = link === 'down' || link === 'negotiating';
      const state = this._outageStates.get(peerB64);

      if (isOutage) {
        if (!state) {
          this._outageStates.set(peerB64, { startedAt: now, emitted: false });
          continue;
        }
        if (state.emitted) continue;
        if (now - state.startedAt < OUTAGE_THRESHOLD_MS) continue;

        // Relay opportunity: does any third peer report they can hear
        // this target right now?
        let relayVia: AgentPubKeyB64 | undefined;
        for (const [otherB64, entry] of Object.entries(others)) {
          if (otherB64 === this.myPubKeyB64 || otherB64 === peerB64) continue;
          const theirView = entry.peerLinks?.[peerB64];
          if (
            theirView &&
            (theirView.audioLink === 'webrtc' || theirView.audioLink === 'signals')
          ) {
            relayVia = otherB64;
            break;
          }
        }
        if (!relayVia) continue;

        state.emitted = true;
        const durationSec = Math.floor((now - state.startedAt) / 1000);
        this.logger.logAgentEvent({
          agent: peerB64,
          timestamp: now,
          event: 'AudibilityOutageStart',
          detail: `${link} ${durationSec}s; relay-via=${relayVia.slice(0, 8)}`,
        });
        // Phase 3: try the other webrtc impl for this peer. Cooldown
        // and max-flip guards inside _maybeAutoFlipImpl prevent
        // ping-pong; pinning to signals is the terminal fallback.
        // Fire-and-forget — _syncConversationPayload's broadcast and
        // teardown are independent of the outage scan loop.
        void this._maybeAutoFlipImpl(peerB64);
      } else if (state) {
        if (state.emitted) {
          const durationSec = Math.floor((now - state.startedAt) / 1000);
          this.logger.logAgentEvent({
            agent: peerB64,
            timestamp: now,
            event: 'AudibilityOutageEnd',
            detail: `${durationSec}s; recovered via ${link}`,
          });
        }
        this._outageStates.delete(peerB64);
      }
    }
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
      // Don't gate on remote tracks here — RTT is observable from
      // candidate-pair.currentRoundTripTime (and from remote-inbound-rtp
      // once we're sending) even when the remote has neither mic nor
      // camera open. The per-kind dead-track detection further down has
      // its own (connInfo.video / connInfo.audio) gates and self-skips
      // when bytesReceived is 0, so removing the outer gate doesn't
      // perturb that path.

      const pc = this._activeMediaTransportFor(pubKeyB64).getRTCPeerConnection(pubKeyB64);
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

        const jitterRounded = jitter !== null
          ? Math.round((jitter as number) * 1000 * 10) / 10
          : null;
        const lossRounded = totalPackets > 0
          ? Math.round((pktsLost / totalPackets) * 1000) / 10
          : null;
        this.webrtcStats.set(pubKeyB64, {
          rttMs,
          jitterMs: jitterRounded,
          lossPercent: lossRounded,
        });
        this._maybeEmitQualityChange(
          pubKeyB64,
          'webrtc',
          rttMs,
          jitterRounded,
          lossRounded,
        );

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
            this._activeMediaTransportFor(pubKeyB64).send(pubKeyB64, JSON.stringify(msg));
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

    // `_processingSignal` is a latch, not a flag: the early return at the top of
    // this method turns every incoming signal into push-and-return while it is
    // true. If it is ever left true the room goes permanently silent — pings,
    // pongs, presence, SDP and module data all arrive on this path — with no
    // error surfaced and no recovery short of a reload. Two guards prevent that:
    //
    //   `finally` — the latch is released even if the loop throws.
    //   per-signal `catch` — one bad signal drops itself, not the rest of the
    //     queue. Without it a throw would abandon every signal already queued
    //     behind the offender.
    //
    // Handlers are expected to reject malformed input themselves (see
    // `parseSignalPayload` in signal-payload.ts); this is the backstop for
    // whatever they miss.
    this._processingSignal = true;
    try {
      while (this._signalQueue.length > 0) {
        const nextSignal = this._signalQueue.shift()!;
        if (this.signalDelayMs > 0) {
          const delay = Math.floor(Math.random() * this.signalDelayMs);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        try {
          await this._processSignal(nextSignal);
        } catch (e) {
          const label =
            nextSignal.type === 'Message'
              ? `Message/${nextSignal.msg_type}`
              : nextSignal.type;
          this.logger.logCustomMessage(
            `Dropped signal (${label}): ${
              e instanceof Error ? e.message : String(e)
            }`
          );
          // The log line above is what ships in a merged forensic log, and it
          // is deliberately one line. But this catch also absorbs genuine
          // handler bugs, and a message without a stack makes those very hard
          // to locate. Keep the full error in devtools.
          console.error(`Dropped signal (${label}):`, e);
        }
      }
    } finally {
      this._processingSignal = false;
    }
  }

  private async _processSignal(signal: RoomSignal) {
    switch (signal.type) {
      case 'Message': {
        // Narrow the wire string to the declared union
        // (`wire-contract.ts:SIGNAL_MSG_TYPES`), then switch exhaustively:
        // a union member without a handler arm is a compile error, so a new
        // signal type cannot be added to the wire and silently dropped
        // here. An *unknown* string (a peer on a newer build) drops one
        // signal with a warn, never the session.
        const msgType = signal.msg_type;
        if (!isSignalMsgType(msgType)) {
          console.warn('Unknown msg_type:', msgType);
          break;
        }
        switch (msgType) {
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
          case 'SdpFsm':
            this.handleSdpFsm(signal);
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
          default: {
            const _exhaustive: never = msgType;
            void _exhaustive;
          }
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
        // Clean up stale outgoing connection if WebRTC state is dead. Same
        // predicate as the video path — see `stale-connection-policy.ts`.
        // Screen share is SimplePeer today, which owns no recovery, so this
        // supervisor is in force for it. Read from the transport rather
        // than hardcoded, so porting screen share to the FSM (Phase 3)
        // stands this down automatically instead of leaving two literals
        // that no test covers and no compiler checks.
        const outgoing = get(this._screenShareConnectionsOutgoing)[pubkeyB64];
        if (outgoing) {
          const pc = this.screenShareOutTransport.getRTCPeerConnection(pubkeyB64);
          const iceState = pc?.iceConnectionState;
          const decision = decideStaleConnectionCleanup({
            hasExistingConn: true,
            slotClaimsConnected: !!outgoing.connected,
            carrierOwnsRecovery:
              this.screenShareOutTransport.ownsTransportRecovery,
            iceState,
            disconnectedAt: this._screenShareIceDisconnectedAt[pubkeyB64],
            now: Date.now(),
            graceMs: ICE_DISCONNECTED_GRACE_MS,
          });
          if (decision.action === 'teardown') {
            this.screenShareOutTransport.closeConnection(pubkeyB64, `stale ICE=${iceState}`);
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
    this._lastQualityBucket.delete(pubkeyB64);
    // If we were mid-outage for this peer, close it out — the peer is
    // gone, not silently unreachable. Wouldn't fire via _checkAudibilityOutages
    // because peer drops from the presence set on next tick.
    const outage = this._outageStates.get(pubkeyB64);
    if (outage?.emitted) {
      const durationSec = Math.floor((Date.now() - outage.startedAt) / 1000);
      this.logger.logAgentEvent({
        agent: pubkeyB64,
        timestamp: Date.now(),
        event: 'AudibilityOutageEnd',
        detail: `${durationSec}s; peer left`,
      });
    }
    this._outageStates.delete(pubkeyB64);

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
    if (get(this._openConnections)[pubkeyB64]) {
      this._activeMediaTransportFor(pubkeyB64).closeConnection(pubkeyB64, 'peer left');
      this._openConnections.update(v => { delete v[pubkeyB64]; return v; });
    }

    // Destroy incoming screen share
    if (get(this._screenShareConnectionsIncoming)[pubkeyB64]) {
      this.screenShareInTransport.closeConnection(pubkeyB64, 'peer left');
      this._screenShareConnectionsIncoming.update(v => { delete v[pubkeyB64]; return v; });
    }

    // Destroy outgoing screen share
    if (get(this._screenShareConnectionsOutgoing)[pubkeyB64]) {
      this.screenShareOutTransport.closeConnection(pubkeyB64, 'peer left');
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
      const parsedMeta = parseSignalPayload<PongMetaData<PongMetaDataV1>>(
        signal.payload
      );
      if (!parsedMeta.ok) {
        console.warn(
          `Dropped PongUi meta from ${pubkeyB64.slice(0, 8)}: ${parsedMeta.error}`
        );
        return;
      }
      const metaData = parsedMeta.value;
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
          // Only evaluate bucket on the signals path if signals is the
          // active carrier for this peer — otherwise the webrtc poll is
          // the source of truth and will emit if bucket changes.
          const openConn = get(this._openConnections)[pubkeyB64];
          if (!openConn?.connected) {
            this._maybeEmitQualityChange(
              pubkeyB64,
              'signals',
              existing.rttMs,
              existing.jitterMs,
              existing.lossPercent,
            );
          }
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
      // Not a parse failure — the payload is validated and returned on above.
      // This block spans the RTT stats, presence merge and module-state
      // reconciliation, so the throw came from one of those.
      console.warn(
        `Pong handling failed for ${pubkeyB64.slice(0, 8)} (post-parse):`,
        e
      );
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
    // The predicate lives in `transport/stale-connection-policy.ts` — it is
    // the same rule the two screen-share sites below apply, and it is where
    // the grace-window and one-recovery-controller rationale is written down.
    const existingConn = get(this._openConnections)[pubkeyB64];
    {
      const activeTransport = this._activeMediaTransportFor(pubkeyB64);
      const pc = existingConn
        ? activeTransport.getRTCPeerConnection(pubkeyB64)
        : undefined;
      const iceState = pc?.iceConnectionState;
      const decision = decideStaleConnectionCleanup({
        hasExistingConn: !!existingConn,
        slotClaimsConnected: !!existingConn?.connected,
        // The transport declares whether it recovers itself; we do not
        // infer it from which transport this is.
        carrierOwnsRecovery: activeTransport.ownsTransportRecovery,
        iceState,
        disconnectedAt: this._iceDisconnectedAt[pubkeyB64],
        now: Date.now(),
        graceMs: ICE_DISCONNECTED_GRACE_MS,
      });
      if (existingConn && decision.action === 'teardown') {
        console.log(`#### CLEANING UP STALE VIDEO CONNECTION TO ${pubkeyB64.slice(0, 8)} (ICE: ${iceState}, ${decision.reason})`);
        this.logger.logCustomMessage(`Stale cleanup [${pubkeyB64.slice(0, 8)}]: ICE=${iceState} ${decision.reason}`);
        this.logger.logAgentEvent({
          agent: pubkeyB64,
          timestamp: Date.now(),
          event: 'StaleCleanup',
          connectionId: existingConn.connectionId,
        });
        activeTransport.closeConnection(pubkeyB64, `stale ICE=${iceState}`);
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
          this._activeMediaTransportFor(pubkeyB64).send(pubkeyB64, JSON.stringify(msg));
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
      const pc = this.screenShareOutTransport.getRTCPeerConnection(pubkeyB64);
      const iceState = pc?.iceConnectionState;
      // Same predicate as the video path — see `stale-connection-policy.ts`.
      const decision = decideStaleConnectionCleanup({
        hasExistingConn: true,
        slotClaimsConnected: !!outgoingScreenShare.connected,
        carrierOwnsRecovery: this.screenShareOutTransport.ownsTransportRecovery,
        iceState,
        disconnectedAt: this._screenShareIceDisconnectedAt[pubkeyB64],
        now,
        graceMs: ICE_DISCONNECTED_GRACE_MS,
      });
      if (decision.action === 'teardown') {
        console.log(`#### CLEANING UP STALE OUTGOING SCREEN SHARE TO ${pubkeyB64.slice(0, 8)} (ICE: ${iceState}, ${decision.reason})`);
        this.screenShareOutTransport.closeConnection(pubkeyB64, `stale ICE=${iceState}`);
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
    const parsedInit = parseSignalPayload<InitPayload>(signal.payload);
    if (!parsedInit.ok) {
      this.logger.logCustomMessage(
        `Dropped InitRequest from ${pubKey64.slice(0, 8)}: ${parsedInit.error}`
      );
      return;
    }
    const { connection_id, connection_type } = parsedInit.value;
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
      // Reserve the connectionId for the acceptor side. The actual peer is
      // not created here — handleSdpData will call ensureConnection once
      // the remote offer arrives, and the transport's auto-attach picks
      // up the current mainStream so our tracks land in the answer.
      const accept: PendingAccept = {
        connectionId: connection_id,
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
      const accept: PendingAccept = {
        connectionId: connection_id,
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
    const parsedAccept = parseSignalPayload<InitPayload>(signal.payload);
    if (!parsedAccept.ok) {
      this.logger.logCustomMessage(
        `Dropped InitAccept from ${pubKey64.slice(0, 8)}: ${parsedAccept.error}`
      );
      return;
    }
    const { connection_id, connection_type } = parsedAccept.value;
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
          // Capture any prior openConnection for this peer for forensic
          // logging. ensureConnection with a new connectionId triggers
          // the transport's internal supersede (closes the old peer).
          const priorOpenForInitAccept = get(this._openConnections)[pubKey64];

          // Make sure the transport has the latest local stream cached
          // so the initial offer includes our tracks. Set on both impls
          // so a future swap doesn't lose the stream.
          if (this.mainStream) {
            for (const t of this._allMediaTransports()) t.setLocalStream(this.mainStream);
            this.logger.logCustomMessage(
              `addStream pre-SDP [${pubKey64.slice(0, 8)}]: ${this.mainStream.getTracks().length} tracks (initiator)`
            );
          }

          // Route to the right transport for this peer. The FSM allocates
          // its own connectionId (the InitAccept connectionId is ignored
          // by FsmTransport); use the returned id as the source of truth
          // for openConnections tracking.
          //
          // Allocate a fresh, monotonic connection epoch for this attempt. The
          // initiator is the single allocator; the acceptor adopts the epoch
          // from the offer the FSM transport stamps it on. This is the ordered,
          // shared identity that survives teardown+recreate and lets a stale
          // signal from a prior attempt be dropped deterministically instead of
          // deadlocking reconnect. See docs/WEBRTC_RECONNECT_IDENTITY.md.
          const transport = this._mediaTransportFor(pubKey64);
          const effectiveConnId = transport.ensureConnection(pubKey64, {
            initiator: true,
            connectionId: connection_id,
            sdpExchangeTimeoutMs: this._computeSdpTimeout(pubKey64),
            epoch: this._nextConnectionEpoch(pubKey64),
          });

          this._openConnections.update(currentValue => {
            currentValue[pubKey64] = {
              connectionId: effectiveConnId,
              video: false,
              audio: false,
              connected: false,
              direction: 'duplex',
            };
            return currentValue;
          });

          if (
            priorOpenForInitAccept &&
            priorOpenForInitAccept.connectionId !== connection_id
          ) {
            this.logger.logCustomMessage(
              `Superseding [${pubKey64.slice(0, 8)}]: prior open ` +
                `connId=${priorOpenForInitAccept.connectionId.slice(0, 8)} ` +
                `replaced by new connId=${connection_id.slice(0, 8)} (initiator path)`
            );
            this.logger.logAgentEvent({
              agent: pubKey64,
              timestamp: Date.now(),
              event: 'Superseded',
              connectionId: priorOpenForInitAccept.connectionId,
              detail: `superseded-by=${connection_id}; path=initiator`,
            });
            // The prior peer's close handler will hit the supersede
            // guard in _handleMediaClosed and return early without
            // running cleanup, so any _iceDisconnectedAt entry from the
            // old connection would leak. The new peer's ICE listener
            // will set/clear based on its own state transitions.
            delete this._iceDisconnectedAt[pubKey64];
            // Transport's ensureConnection has already closed the old peer.
          }

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
                this._activeMediaTransportFor(pubKey64).closeConnection(pubKey64, 'SDP exchange timeout');
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
          if (this.screenShareStream) {
            this.screenShareOutTransport.setLocalStream(this.screenShareStream);
          }
          this.screenShareOutTransport.ensureConnection(pubKey64, {
            initiator: true,
            connectionId: connection_id,
          });

          this._screenShareConnectionsOutgoing.update(currentValue => {
            currentValue[pubKey64] = {
              connectionId: connection_id,
              video: true,
              audio: false,
              connected: false,
              direction: 'outgoing', // if we initiated the request, we're the ones delivering the stream
            };
            return currentValue;
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
   * Handle an SdpFsm signal — feeds the FSM media transport.
   *
   * The FSM creates per-peer state on the first incoming offer (no pendingAccept
   * dance is needed); subsequent offers/answers/candidates route to the
   * existing FSM. The wire payload is `{ connection_id, peer_session_id, data: { type, payload } }`.
   * The openConnections entry is created lazily in the connection-state-change
   * handler when the FSM transitions to 'signaling' for a peer not already
   * tracked. Initiator-side openConnections entries are still installed by
   * handleInitAccept (with the FSM-allocated connectionId returned from
   * ensureConnection).
   */
  handleSdpFsm(signal: Extract<RoomSignal, { type: 'Message' }>): void {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    const parsedFsm = parseSignalPayload<{
      connection_id: string;
      peer_session_id?: number;
      epoch?: number;
      data: unknown;
    }>(signal.payload);
    if (!parsedFsm.ok) {
      console.warn(
        `Dropped SdpFsm from ${pubkeyB64.slice(0, 8)}: ${parsedFsm.error}`
      );
      return;
    }
    const parsed = parsedFsm.value;
    // Surface the sub-type so the FSM path is as readable in logs as
    // the simplepeer path (which records 'offer'/'answer'/'candidate').
    const data = parsed.data as { type?: string } | null;
    const sdpType = data && typeof data === 'object' && 'type' in data && data.type
      ? data.type
      : 'candidate';
    // processIncomingSignal first so a fresh-from-remote offer creates the
    // local FSM before we ask for its connectionId.
    this.mediaTransportFsm.processIncomingSignal({
      from: pubkeyB64,
      connectionId: parsed.connection_id,
      peerSessionId: parsed.peer_session_id,
      epoch: parsed.epoch,
      data: parsed.data,
    });
    // Log with the LOCAL FSM's connectionId so SdpData entries correlate
    // with ICE, Connected, FsmClose etc. The wire payload's connection_id
    // is the SENDER's local id; without this remapping a single FSM
    // session would show up under two different ids in the timeline.
    const localConnId = this.mediaTransportFsm.getConnectionId(pubkeyB64) ?? parsed.connection_id;
    this._logSdpDataEvent(pubkeyB64, localConnId, `fsm-${sdpType}`);
  }

  /**
   * Handle an SdpData signal
   *
   * @param signal
   */
  async handleSdpData(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    const parsedPayload = parseSignalPayload<SdpPayload>(signal.payload);
    if (!parsedPayload.ok) {
      this.logger.logCustomMessage(
        `Dropped SdpData from ${pubkeyB64.slice(0, 8)}: ${parsedPayload.error}`
      );
      return;
    }
    const { connection_id, data } = parsedPayload.value;
    console.log(`## Got SDP Data from : ${pubkeyB64}:\n`, data);

    // `data` is a second, nested JSON string carrying the SDP itself, so it
    // needs its own guard rather than riding on the envelope's — the envelope
    // can be perfectly well-formed while its payload is not.
    const parsedSdpResult = parseSignalPayload<any>(data);
    if (!parsedSdpResult.ok) {
      this.logger.logCustomMessage(
        `Dropped SdpData from ${pubkeyB64.slice(0, 8)} (connection ${
          connection_id
        }): malformed inner SDP — ${parsedSdpResult.error}`
      );
      return;
    }
    const parsedSdp = parsedSdpResult.value;
    const sdpType = parsedSdp.type || 'candidate';

    this._logSdpDataEvent(pubkeyB64, connection_id, sdpType);

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
      this.mediaTransport.processIncomingSignal({
        from: pubkeyB64,
        connectionId: connection_id,
        data: parsedSdp,
      });
    } else {
      /**
       * If there is no open connection yet but a PendingAccept then create
       * the acceptor peer via the transport and route the offer into it.
       * Other pending accepts for this agent are dropped (no peers to
       * destroy — the transport owns peer lifecycle now).
       */
      const allPendingAccepts = this._pendingAccepts;
      const pendingAcceptsForAgent = allPendingAccepts[pubkeyB64];
      if (pendingAcceptsForAgent) {
        const maybePendingAccept = pendingAcceptsForAgent.find(
          pendingAccept => pendingAccept.connectionId === connection_id
        );
        if (maybePendingAccept) {
          console.log(
            '#### FOUND PENDING ACCEPT! Moving to open connections...'
          );

          // Capture any prior openConnection for forensic logging. The
          // transport's ensureConnection will supersede the old peer
          // internally when it sees a new connectionId.
          const priorOpenForSdp = get(this._openConnections)[pubkeyB64];

          // Make sure tracks are included in the answer.
          if (this.mainStream) {
            this.mediaTransport.setLocalStream(this.mainStream);
            this.logger.logCustomMessage(
              `addStream pre-SDP [${pubkeyB64.slice(0, 8)}]: ${this.mainStream.getTracks().length} tracks (acceptor)`
            );
          }

          this.mediaTransport.ensureConnection(pubkeyB64, {
            initiator: false,
            connectionId: connection_id,
          });

          this._openConnections.update(currentValue => {
            currentValue[pubkeyB64] = {
              connectionId: connection_id,
              video: false,
              audio: false,
              connected: false,
              direction: 'duplex',
            };
            return currentValue;
          });

          this.mediaTransport.processIncomingSignal({
            from: pubkeyB64,
            connectionId: connection_id,
            data: parsedSdp,
          });

          if (
            priorOpenForSdp &&
            priorOpenForSdp.connectionId !== connection_id
          ) {
            this.logger.logCustomMessage(
              `Superseding [${pubkeyB64.slice(0, 8)}]: prior open ` +
                `connId=${priorOpenForSdp.connectionId.slice(0, 8)} ` +
                `replaced by new connId=${connection_id.slice(0, 8)} (acceptor path)`
            );
            this.logger.logAgentEvent({
              agent: pubkeyB64,
              timestamp: Date.now(),
              event: 'Superseded',
              connectionId: priorOpenForSdp.connectionId,
              detail: `superseded-by=${connection_id}; path=acceptor`,
            });
            // The prior peer's close handler will hit the supersede
            // guard in _handleMediaClosed and return early without
            // running cleanup, so any _iceDisconnectedAt entry from the
            // old connection would leak. The new peer's ICE listener
            // will set/clear based on its own state transitions.
            delete this._iceDisconnectedAt[pubkeyB64];
          }

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
      this.screenShareOutTransport.processIncomingSignal({
        from: pubkeyB64,
        connectionId: connection_id,
        data: parsedSdp,
      });
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
      this.screenShareInTransport.processIncomingSignal({
        from: pubkeyB64,
        connectionId: connection_id,
        data: parsedSdp,
      });
    } else {
      const pendingScreenShareAccepts =
        this._pendingScreenShareAccepts[pubkeyB64];
      if (pendingScreenShareAccepts) {
        const maybePendingAccept = pendingScreenShareAccepts.find(
          pendingAccept => pendingAccept.connectionId === connection_id
        );
        if (maybePendingAccept) {
          this.screenShareInTransport.ensureConnection(pubkeyB64, {
            initiator: false,
            connectionId: connection_id,
          });
          this._screenShareConnectionsIncoming.update(currentValue => {
            currentValue[pubkeyB64] = {
              connectionId: connection_id,
              video: false,
              audio: false,
              connected: false,
              direction: 'incoming',
            };
            return currentValue;
          });
          this.screenShareInTransport.processIncomingSignal({
            from: pubkeyB64,
            connectionId: connection_id,
            data: parsedSdp,
          });

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
      const parsedSnapshot = parseSignalPayload<DiagnosticSnapshot>(signal.payload);
      if (!parsedSnapshot.ok) {
        console.warn(
          `Dropped DiagnosticResponse from ${pubkeyB64.slice(0, 8)}: ${parsedSnapshot.error}`
        );
        return;
      }
      const snapshot = parsedSnapshot.value;
      this._receivedDiagnosticLogs.update(current => ({ ...current, [pubkeyB64]: snapshot }));
      this._pendingDiagnosticRequests.update(curr => {
        const next = { ...curr };
        delete next[pubkeyB64];
        return next;
      });
      this._failedDiagnosticRequests.update(curr => {
        if (!curr[pubkeyB64]) return curr;
        const next = { ...curr };
        delete next[pubkeyB64];
        return next;
      });
      this.logger.logCustomMessage(
        `Received diagnostic logs from [${pubkeyB64.slice(0, 8)}]: ${snapshot.agentEvents.length} events, ${snapshot.customLogs.length} custom logs`
      );
    } catch (e) {
      console.warn('Failed to parse DiagnosticResponse:', e);
    }
  }

}
