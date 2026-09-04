/**
 * MediaLinks — owner of the media FSM transport's event glue, the shared
 * connection-teardown kernel, the ICE/SDP forensics pipeline, and (since
 * store-decomposition round three, Task 4; see
 * docs/superpowers/specs/2026-09-04-media-links-design.md)
 * connection establishment and the pong-driven initiation loop. Owns the
 * `_openConnections` `Writable`, the media transport's event
 * subscription, the connected/closed/remote-stream/remote-track/data-
 * channel/ice-diagnostic/error handlers, the ICE establishment-latency
 * forensics (`_iceTimings`), the SdpData burst-aggregation forensics
 * (`_sdpDataAggregates`), `updateConnectionStatus`, the RTT-scaled SDP-
 * exchange timeout pair (`computeSdpTimeout`/`_computeSdpBackstopTimeout`),
 * the InitRequest/InitAccept handshake (`handleInitRequest`/
 * `handleInitAccept`), the SdpFsm signal feed (`handleSdpFsm`), and the
 * pong-driven initiator loop (`drivePong`, née `StreamsStore._drivePongMediaLink`,
 * Task 1).
 *
 * `applyCloseCleanup` (the single executor of `closeCleanupPlan` rows,
 * shared by the media path AND both screen-share directions) and
 * `applyStaleTeardown` live here too — MediaLinks is where the shared
 * teardown kernel now lives. Every caller that is not MediaLinks itself
 * reaches them through the store's `_applyCloseCleanup`/
 * `_applyStaleTeardown` bare delegates: the ScreenShareLinks bindings,
 * `handleLeaveUi`, the stale-connection supervisor sites
 * (`handlePingUi`/`_drivePongScreenShare`), and `pingAgents`.
 * `logSdpDataEvent`/`flushStaleSdpAggregates` are reached the same way,
 * by `ScreenShareLinks.handleSdpFsmScreen` and `pingAgents` — `handleSdpFsm`
 * is MediaLinks' own method since Task 4 and calls `logSdpDataEvent`
 * directly, not through the store's bare delegate.
 *
 * Do NOT live here (stay on the store): `_readDtlsStallTimeoutMs` /
 * `_readIceTransportPolicy` (start()'s transport-construction callers —
 * composition root, out of scope for an owner extraction); `_sendRtcAction`,
 * `_sendImmediatePongToAll`, `webrtcDisabled`, `webrtcGloballyDisabled`,
 * `webrtcAvailableFor`, `_nextConnectionEpoch`, `_allMediaTransports` —
 * each reached here via its binding; `_maybeEmitQualityChange`, `_peerCaps`,
 * `_logFsmTransition` — stay on the store, untouched by this owner. `_drivePongScreenShare` also stays on the
 * store (it is `drivePong`'s screen-share twin, not part of this owner's
 * concern) and keeps calling the store's own `_applyStaleTeardown`/
 * `webrtcAvailableFor`/etc. directly, unaffected by this move.
 *
 * `_applyMediaSignalingRoute` is `private` since Task 4: its two callers
 * — the transport event glue below (`_dispatchMediaEvent`) and
 * `handleInitAccept` (the initiator's own send path) — are both methods
 * of this class now that `handleInitAccept` moved here too, so the
 * cross-file publicness Task 3 needed no longer applies.
 *
 * `_setTrackReady` (not in the Task 3 move list by name, but the sole
 * private helper closure of `_handleMediaRemoteTrack`, with no other
 * caller anywhere in the codebase) moved with it rather than staying
 * behind as a single-caller orphan on the store.
 */
import { AgentPubKey, AgentPubKeyB64, encodeHashToBase64 } from '@holochain/client';
import { get, writable, type Writable } from '@holochain-open-dev/stores';
import { v4 as uuidv4 } from 'uuid';
import type { PeerTransport, TransportEvent, IceDiagnostic } from './transport';
import {
  routeTransportPhase,
  decideSlotWrite,
  attributeSlotEvent,
} from './transport/media-event-policy';
import type { SlotAction } from './transport/media-event-policy';
import {
  closeCleanupPlan,
  closeGuardOutcome,
} from './transport/close-cleanup-policy';
import type {
  CloseCleanupContext,
  CloseCleanupPlan,
} from './transport/close-cleanup-policy';
import { decideWebrtcEligibility } from './transport/carrier-coverage';
import { decideStaleConnectionCleanup } from './transport/stale-connection-policy';
import { decideInitRetry } from './transport/init-retry-policy';
import type { SignalMsgType } from './transport/wire-contract';
import { resetPeerRecord } from './peer-record';
import type { PeerRecord } from './peer-record';
import { decodeRtcMessage } from './rtc-message-policy';
import type { ActionMessage } from './rtc-message-policy';
import { parseSignalPayload } from './signal-payload';
import type {
  CarrierStats,
  ConnectionStatus,
  ConnectionStatuses,
  InitPayload,
  ModuleStateEnvelope,
  OpenConnectionInfo,
  OthersConnectionStatusEntry,
  PongMetaData,
  PongMetaDataV1,
  RoomSignal,
  StoreEventPayload,
  StreamAndTrackInfo,
} from './types';
import type { PresenceLogger } from './logging';

export type MediaLinksBindings = {
  /** this.mediaTransport, late-bound (constructed in start(), after this
   *  owner exists). */
  mediaTransport: () => PeerTransport;
  /** this.screenShareOutTransport, late-bound. Needed by
   *  `applyCloseCleanup`/`applyStaleTeardown` for the
   *  'screen-share-outgoing' target. */
  screenShareOutTransport: () => PeerTransport;
  /** this.screenShareInTransport, late-bound. Needed by
   *  `applyCloseCleanup` for the 'screen-share-incoming' target. */
  screenShareInTransport: () => PeerTransport;
  /** screenShareLinks._screenShareConnectionsOutgoing, late-bound. */
  screenShareConnectionsOutgoing: () => Writable<Record<AgentPubKeyB64, OpenConnectionInfo>>;
  /** screenShareLinks._screenShareConnectionsIncoming, late-bound. */
  screenShareConnectionsIncoming: () => Writable<Record<AgentPubKeyB64, OpenConnectionInfo>>;
  /** screenShareLinks.updateScreenShareConnectionStatus, late-bound. */
  updateScreenShareConnectionStatus: (peer: AgentPubKeyB64, status: ConnectionStatus) => void;
  /** StreamsStore._othersConnectionStatuses, late-bound. */
  othersConnectionStatuses: () => Writable<Record<AgentPubKeyB64, OthersConnectionStatusEntry>>;
  /** StreamsStore.webrtcStats — direct Map reference, like
   *  TrackHealthMonitor's binding of the same field. */
  webrtcStats: Map<string, CarrierStats>;
  peerRecord: (k: AgentPubKeyB64) => PeerRecord | undefined;
  ensurePeerRecord: (k: AgentPubKeyB64) => PeerRecord;
  /** StreamsStore._peerRecords.set, for the resetPeerRecord write-back —
   *  resetPeerRecord returns a new record rather than mutating in place,
   *  so `ensurePeerRecord`'s returned reference isn't enough here. */
  setPeerRecord: (k: AgentPubKeyB64, r: PeerRecord) => void;
  eventCallback: (e: StoreEventPayload) => any;
  logger: PresenceLogger;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number | undefined) => void;
  /** deps.storage.local — live handle, passed directly like
   *  MediaSettings' `storage` binding (this owner is constructed in the
   *  constructor body, after `this.deps` is assigned). */
  storage: { getItem(key: string): string | null };
  /** StreamsStore._readIceTransportPolicy, late-bound (stays on the
   *  store). */
  readIceTransportPolicy: () => RTCIceTransportPolicy | undefined;
  /** StreamsStore.turnUrl getter, late-bound. */
  turnUrl: () => string;
  /** StreamsStore.cfTurnUrl getter, late-bound. */
  cfTurnUrl: () => string;
  /** peerAudioLevels.setupPeerAudioAnalyser, late-bound. */
  setupPeerAudioAnalyser: (peer: AgentPubKeyB64, stream: MediaStream) => void;
  /** trackHealth.refreshTracksForPeer, late-bound. */
  refreshTracksForPeer: (peer: AgentPubKeyB64) => void;
  /** diagnosticsHub.noteConversationParticipant, late-bound. */
  noteConversationParticipant: (peer: AgentPubKeyB64) => void;
  /** StreamsStore.mainStream, late-bound (reassigned outside the
   *  constructor). */
  mainStream: () => MediaStream | undefined | null;

  // -- Establishment + pong drive (Task 4) -----------------------------

  /** StreamsStore.myPubKeyB64, late-bound (read fresh — it is assigned in
   *  the store's constructor before this owner is constructed, but a
   *  function keeps the binding shape uniform with the rest of the
   *  record). */
  myPubKeyB64: () => AgentPubKeyB64;
  /** deps.bus.sendMessage, late-bound (InitRequest send in `drivePong`,
   *  InitAccept send in `handleInitRequest`). */
  sendMessage: (
    toAgents: AgentPubKey[],
    msgType: SignalMsgType,
    payload?: string
  ) => Promise<void>;
  /** StreamsStore._connectionStatuses, late-bound. Written by
   *  `updateConnectionStatus`. */
  connectionStatuses: () => Writable<ConnectionStatuses>;
  /** StreamsStore._myModuleStates, late-bound. Read by `drivePong` and
   *  `handleInitRequest` for the `conversationActive` eligibility
   *  conjunct. */
  myModuleStates: () => Writable<Record<string, ModuleStateEnvelope>>;
  /** StreamsStore._peerModuleStates, late-bound. Read by `drivePong` and
   *  `handleInitRequest` for the `peerCapsKnown` eligibility conjunct. */
  peerModuleStates: () => Writable<Record<AgentPubKeyB64, Record<string, ModuleStateEnvelope>>>;
  /** StreamsStore.webrtcDisabled, late-bound (stays on the store — unions
   *  our own intent-sourced disable with the peer's broadcast state). */
  webrtcDisabled: (peerB64: AgentPubKeyB64) => boolean;
  /** StreamsStore.webrtcGloballyDisabled getter, late-bound (stays on the
   *  store — reads `localIntent.webrtc.enabled`). */
  webrtcGloballyDisabled: () => boolean;
  /** StreamsStore.webrtcAvailableFor, late-bound (stays on the store —
   *  reads the peer's declared `sdp-fsm` capability). */
  webrtcAvailableFor: (peerB64: AgentPubKeyB64) => boolean;
  /** StreamsStore._nextConnectionEpoch, late-bound (stays on the store —
   *  the peer record's monotonic-per-session epoch counter). */
  nextConnectionEpoch: (peer: AgentPubKeyB64) => number;
  /** StreamsStore._allMediaTransports, late-bound (stays on the store —
   *  the media-transport fan-out helper `handleInitAccept` uses to prime
   *  the local stream before the offer). */
  allMediaTransports: () => Array<PeerTransport>;
  /** StreamsStore._sendRtcAction, late-bound (stays on the store — the
   *  one RTCMessage action send seam). */
  sendRtcAction: (message: ActionMessage, peers: AgentPubKeyB64[]) => number;
  /** StreamsStore._sendImmediatePongToAll, late-bound (stays on the store
   *  — fire-and-forget, matching the origin call site's lack of await). */
  sendImmediatePongToAll: () => void;
  /** trackHealth.reconcileVideoStreamState, late-bound (the hold-arm
   *  reconcile `drivePong` calls when an init is held because a
   *  connection is already open). */
  reconcileVideoStreamState: (peer: AgentPubKeyB64, streamAndTrackInfo: StreamAndTrackInfo) => void;
  /** `ICE_DISCONNECTED_GRACE_MS` (streams-store.ts), passed as a value —
   *  not imported, to avoid ADDING a media-links.ts -> streams-store.ts
   *  value-import edge on top of the existing streams-store.ts ->
   *  media-links.ts one (the class import: streams-store.ts imports
   *  `MediaLinks`; media-links.ts imports nothing from streams-store.ts);
   *  the constant is also used by two store-resident callers
   *  (`handlePingUi`, `_drivePongScreenShare`), so streams-store.ts stays
   *  its one declaration site. */
  iceDisconnectedGraceMs: number;
  /** `SDP_TIMEOUT_CEILING_MS` (streams-store.ts, exported — the wiring
   *  suite imports it directly), passed as a value for the same reason
   *  as `iceDisconnectedGraceMs`. */
  sdpTimeoutCeilingMs: number;
  /** `SDP_TIMEOUT_RTT_MULTIPLIER` (streams-store.ts), passed as a value. */
  sdpTimeoutRttMultiplier: number;
  /** `SDP_TIMEOUT_FLOOR_MS` (streams-store.ts), passed as a value. */
  sdpTimeoutFloorMs: number;
  /** `SDP_EXCHANGE_TIMEOUT` (streams-store.ts) — the no-RTT-sample
   *  fallback `_computeSdpBackstopTimeout` uses, passed as a value. */
  sdpExchangeTimeoutFallbackMs: number;
  /** `SDP_BACKSTOP_CEILING_MS` (streams-store.ts), passed as a value. */
  sdpBackstopCeilingMs: number;
  /** `SDP_BACKSTOP_MULTIPLIER` (streams-store.ts), passed as a value. */
  sdpBackstopMultiplier: number;
  /** `SDP_BACKSTOP_RETRY_HEADROOM_MS` (streams-store.ts), passed as a
   *  value. */
  sdpBackstopRetryHeadroomMs: number;
};

export class MediaLinks {
  constructor(private readonly bindings: MediaLinksBindings) {}

  /**
   * Connections where the Init/Accept handshake succeeded and we have an
   * active WebRTC connection.
   */
  _openConnections: Writable<Record<AgentPubKeyB64, OpenConnectionInfo>> =
    writable({});

  /**
   * Per-(peer, connectionId) establishment timings, captured for forensic
   * A/B-ing of establishment latency on marginal links. t0 is staked on
   * the `signaling` transition (`_stakeIceTiming`); the ICE milestones
   * arrive as `ice-diagnostic` transport events. Emitted as a single
   * `IceEstablishment` SimpleEvent on phase='connected', or as
   * `IceNeverConnected` if the connection closes first. See
   * WEBRTC_CARRIER_ANALYSIS.md for the analysis goal. Key format
   * `<peerB64>:<connectionId>`.
   */
  _iceTimings: Record<string, {
    t0: number;
    impl: 'fsm';
    tIceConnected?: number;
    tGatherComplete?: number;
    relay?: boolean;
    finalIceState?: string;
    emitted?: boolean;
  }> = {};

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
  subscribe(): void {
    this.bindings.mediaTransport().onAny((event: TransportEvent) => {
      this._dispatchMediaEvent(event);
    });
  }

  private _dispatchMediaEvent(event: TransportEvent): void {
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
          connectionId: event.connectionId,
          openConnectionId: get(this._openConnections)[event.peer]?.connectionId,
        });
        switch (route.handler) {
          case 'signaling':
            this._applyMediaSignalingRoute(
              event.peer,
              event.connectionId,
              route.slot,
              'transport-replace',
            );
            break;
          case 'media-connected':
            this._handleMediaConnected(event.peer, event.connectionId);
            break;
          case 'media-closed':
            this._handleMediaClosed(
              event.peer,
              event.connectionId,
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
      case 'ice-diagnostic':
        this._handleMediaIceDiagnostic(event.peer, event.connectionId, event.diag);
        break;
      case 'error':
        this._handleMediaError(event.peer, event.connectionId, event.error);
        break;
    }
  }

  /**
   * The apply half of a media `signaling` route — ONE apply for the ONE
   * slot-write policy. Two callers, both methods of this class since
   * Task 4 moved `handleInitAccept` here: the transport event glue
   * (`_dispatchMediaEvent`, above) and the initiator path
   * (`handleInitAccept`, below, which used to hand-write
   * `_openConnections` around the policy — §9 item 5). `path` tags the
   * Superseded forensic with which caller adopted.
   *
   * `install`: FSM acceptor path — an incoming offer creates an FSM
   * without streams-store knowing in advance, so the slot has to exist
   * for later connect/stream events to mutate. `replace` (adopt): same
   * write, replacing a slot whose connection is gone. The decision —
   * including that both start from `connected: false` — is
   * `decideSlotWrite`, shared with the carrier-handover harness so the
   * two cannot drift.
   */
  private _applyMediaSignalingRoute(
    peer: AgentPubKeyB64,
    connectionId: string,
    slotAction: SlotAction,
    path: 'transport-replace' | 'initiator',
  ): void {
    if (slotAction.action === 'adopt') {
      // The FSM behind the slot's connectionId was replaced in place
      // by ConnectionManager (higher-epoch offer, or a new remote
      // session) via `fsm.destroy()`, which emits no transition — so
      // no `closed` ever reached us for it. Re-point the slot at the
      // live connection; leaving the stale id would make every later
      // connect/close for this peer hit its supersede guard, and a
      // slot that was `connected: true` at replacement would stay
      // that way forever.
      this.bindings.logger.logAgentEvent({
        agent: peer,
        timestamp: this.bindings.now(),
        event: 'Superseded',
        connectionId: slotAction.supersedes,
        detail: `superseded-by=${connectionId}; path=${path}`,
      });
      this._clearIceTiming(peer, slotAction.supersedes);
      // Keyed to the old connection; the new connection's
      // ice-diagnostic events set their own.
      { const r = this.bindings.peerRecord(peer); if (r) r.iceDisconnectedAt = undefined; }
    }
    this._stakeIceTiming(peer, connectionId);
    const slotWrite = decideSlotWrite(
      { kind: 'signaling', slot: slotAction },
      connectionId,
      get(this._openConnections)[peer],
    );
    if (slotWrite.write === 'install' || slotWrite.write === 'replace') {
      this._openConnections.update(currentValue => {
        currentValue[peer] = {
          ...slotWrite.slot,
          video: false,
          audio: false,
          direction: 'duplex',
        };
        return currentValue;
      });
      this.updateConnectionStatus(peer, { type: 'SdpExchange' });
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
    this.bindings.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.bindings.now(),
      event: 'FsmEstablishmentTimeline',
      connectionId,
      detail:
        `ice=${timeline.iceMs ?? -1} dtls=${timeline.dtlsMs ?? -1} ` +
        `connected=${timeline.connectedMs} dc=${timeline.dataChannelMs ?? -1} ` +
        `reconnect=${timeline.wasReconnect} session=${timeline.peerSessionId}`,
    });
  }

  /**
   * Stake t0 for the (peer, connectionId) establishment-latency record on
   * the first `signaling` transition. The ICE-level milestones that fill
   * the rest of the record arrive as `ice-diagnostic` transport events
   * (`_handleMediaIceDiagnostic`) — the transport owns the pc and its
   * listeners since Phase 4 item 3; the store only keeps the forensic
   * bookkeeping.
   */
  private _stakeIceTiming(pubKeyB64: AgentPubKeyB64, connectionId: string): void {
    const key = `${pubKeyB64}:${connectionId}`;
    if (!this._iceTimings[key]) {
      this._iceTimings[key] = { t0: this.bindings.now(), impl: 'fsm' };
    }
  }

  /**
   * Drop the establishment-timing record for a (peer, connectionId) pair.
   * Called from the close/error paths so a future reconnect with a fresh
   * connectionId starts a clean record. Listener detachment is the
   * transport's job now (one listener set per peer session, aborted on
   * close/replace inside `FsmTransport`).
   */
  private _clearIceTiming(pubKeyB64: AgentPubKeyB64, connectionId: string): void {
    delete this._iceTimings[`${pubKeyB64}:${connectionId}`];
  }

  /**
   * Route an `ice-diagnostic` event from the media transport: forensic log
   * lines (same formats the in-store pc listeners produced before Phase 4,
   * so log analysis stays stable), establishment-latency milestones, and
   * the `iceDisconnectedAt` grace bookkeeping.
   */
  private _handleMediaIceDiagnostic(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    diag: IceDiagnostic,
  ): void {
    const key = `${pubKeyB64}:${connectionId}`;
    switch (diag.kind) {
      case 'ice-state': {
        const state = diag.state;
        this.bindings.logger.logCustomMessage(
          `ICE [${pubKeyB64.slice(0, 8)}]: ${state} connId=${connectionId.slice(0, 8)}`
        );
        // First entry to 'connected' (or 'completed') marks the ICE-only
        // milestone — DTLS may still be in flight. Record once; later
        // disconnect/recover cycles must not overwrite the initial timing.
        const t = this._iceTimings[key];
        if (t && t.tIceConnected === undefined && (state === 'connected' || state === 'completed')) {
          t.tIceConnected = this.bindings.now();
        }
        if (t) t.finalIceState = state;
        // Maintain the invariant: an entry exists iff iceState is
        // currently 'disconnected'. The stale-connection net uses a grace
        // period before treating 'disconnected' as terminal.
        if (state === 'disconnected') {
          this.bindings.ensurePeerRecord(pubKeyB64).iceDisconnectedAt = this.bindings.now();
        } else {
          { const r = this.bindings.peerRecord(pubKeyB64); if (r) r.iceDisconnectedAt = undefined; }
        }
        if (diag.selectedPair) {
          const { local, remote } = diag.selectedPair;
          this.bindings.logger.logCustomMessage(
            `ICE failed pair [${pubKeyB64.slice(0, 8)}]: local=${local?.address}:${local?.port} (${local?.type}) remote=${remote?.address}:${remote?.port} (${remote?.type})`
          );
        }
        break;
      }
      case 'gathering-state': {
        this.bindings.logger.logCustomMessage(
          `ICE gathering [${pubKeyB64.slice(0, 8)}]: ${diag.state}`
        );
        if (diag.state === 'complete') {
          const hasRelay = diag.localSdpHasRelay ?? false;
          this.bindings.logger.logCustomMessage(
            `ICE candidates summary [${pubKeyB64.slice(0, 8)}]: relay=${hasRelay}`
          );
          // Stamp gather-complete timing on first transition; the SDP
          // can re-gather on ICE restart but the establishment-latency
          // metric refers to the initial gather only.
          const t = this._iceTimings[key];
          if (t && t.tGatherComplete === undefined) {
            t.tGatherComplete = this.bindings.now();
            t.relay = hasRelay;
          }
        }
        break;
      }
      case 'candidate': {
        this.bindings.logger.logCustomMessage(
          `ICE candidate [${pubKeyB64.slice(0, 8)}]: ${diag.candidateType} ${diag.protocol} ${diag.address}:${diag.port}`
        );
        break;
      }
      default: {
        const exhaustive: never = diag;
        void exhaustive;
      }
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
    const now = this.bindings.now();
    const ice = t.tIceConnected !== undefined ? t.tIceConnected - t.t0 : -1;
    const gather = t.tGatherComplete !== undefined ? t.tGatherComplete - t.t0 : -1;
    const connect = now - t.t0;
    // Record the effective ICE policy and whether a TURN server was actually
    // configured. Force-TURN ('relay') auto-disarms when turnUrl is empty
    // (see _readIceTransportPolicy), so logging the resolved values makes a
    // silent disarm — e.g. force-TURN toggled on but no/unfetched credentials —
    // visible in diagnostics rather than inferred from candidate types.
    const policy = this.bindings.readIceTransportPolicy() ?? 'all';
    const turnSources = [
      this.bindings.turnUrl().trim() ? 'manual' : '',
      this.bindings.cfTurnUrl().trim() ? 'cloudflare' : '',
    ].filter(Boolean);
    const turn = turnSources.length > 0 ? turnSources.join('+') : 'none';
    this.bindings.logger.logAgentEvent({
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
    const now = this.bindings.now();
    const ice = t.tIceConnected !== undefined ? t.tIceConnected - t.t0 : -1;
    const gather = t.tGatherComplete !== undefined ? t.tGatherComplete - t.t0 : -1;
    const elapsed = now - t.t0;
    const iceReachedConnected =
      t.finalIceState === 'connected' || t.finalIceState === 'completed';
    this.bindings.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: now,
      event: iceReachedConnected ? 'ConnectionAborted' : 'IceNeverConnected',
      connectionId,
      detail: `impl=${t.impl} ice=${ice} gather=${gather} elapsed=${elapsed} relay=${t.relay ?? 'unknown'} finalIceState=${t.finalIceState ?? 'none'}`,
    });
  }

  /** Per-sender video bitrate cap (bps), or null to leave uncapped. Override
   *  via localStorage('videoMaxBitrateKbps'); '0' disables the cap. */
  private _videoMaxBitrate(): number | null {
    const DEFAULT_KBPS = 2_000;
    try {
      const raw = this.bindings.storage.getItem('videoMaxBitrateKbps');
      const kbps = raw != null ? parseInt(raw, 10) : DEFAULT_KBPS;
      if (!Number.isFinite(kbps) || kbps <= 0) return raw === '0' ? null : DEFAULT_KBPS * 1_000;
      return kbps * 1_000;
    } catch {
      return DEFAULT_KBPS * 1_000;
    }
  }

  /**
   * Bias the encoder toward audio on a constrained uplink: audio senders
   * high network priority, video low + capped bitrate, so a saturated
   * upload starves video before voice. The mechanism lives in the
   * transport (`prioritizeAudio` — the pc no longer leaves it, Phase 4
   * item 3); the store keeps the policy inputs (the bitrate-cap setting)
   * and the forensic record. `networkPriority` is not universally
   * honored; the outcome's `applied` flag surfaces a silent revert —
   * exactly the periodic-dropout symptom we chase — as NOT-APPLIED in
   * capture rather than leaving it inferred.
   */
  private async _applySenderPriorities(peerB64: AgentPubKeyB64): Promise<void> {
    const outcomes = await this.bindings.mediaTransport().prioritizeAudio(peerB64, {
      videoMaxBitrateBps: this._videoMaxBitrate(),
    });
    if (outcomes.length === 0) return;
    const report = outcomes.map(o => {
      if ('failed' in o) return `${o.kind}:setParameters-failed`;
      let s = `${o.kind}:want=${o.want} priority=${o.priority} netPriority=${o.networkPriority}${o.applied ? '' : ' NOT-APPLIED'}`;
      if (o.kind === 'video') s += ` maxBitrate=${o.maxBitrate ?? 'unset'}`;
      return s;
    });
    this.bindings.logger.logAgentEvent({
      agent: peerB64,
      timestamp: this.bindings.now(),
      event: 'SenderParams',
      detail: report.join(' | '),
    });
  }

  private _handleMediaConnected(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
  ): void {
    const transport = this.bindings.mediaTransport();
    // Guards live in `decideSlotWrite` (shared with the carrier-handover
    // harness): superseded — an old peer that completed ICE after being
    // replaced must not mutate the new connection's slot; no-slot — likely
    // closed mid-handshake, drop.
    const currentOnConnect = get(this._openConnections)[pubKeyB64];
    const slotWrite = decideSlotWrite(
      { kind: 'connected' },
      connectionId,
      currentOnConnect,
    );
    if (slotWrite.write !== 'set-connected') {
      if (slotWrite.write === 'none' && slotWrite.reason === 'superseded') {
        this.bindings.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: this.bindings.now(),
          event: 'SupersededConnect',
          connectionId,
          detail: `superseded-by=${slotWrite.supersededBy}`,
        });
        // Transport already handled supersede destroy on its side.
      }
      return;
    }
    this._flushSdpAggregatesForConnection(connectionId);
    // Record this peer as a genuine call participant for diagnostic-log
    // targeting. Kept for the whole session even if they later drop.
    this.bindings.noteConversationParticipant(pubKeyB64);
    this.bindings.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.bindings.now(),
      event: 'Connected',
      connectionId,
    });
    this._emitIceEstablishment(pubKeyB64, connectionId);
    // Audio carrier flipped from signals → webrtc (impl-specific) for this peer.
    this.bindings.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.bindings.now(),
      event: 'CarrierSwitch',
      connectionId,
      detail: 'signals->webrtc',
    });
    { const r = this.bindings.peerRecord(pubKeyB64); if (r) r.qualityBucket = undefined; }

    { const r = this.bindings.peerRecord(pubKeyB64); if (r) r.pendingInits = undefined; }

    this._openConnections.update(currentValue => {
      const conn = currentValue[pubKeyB64];
      if (conn) conn.connected = true;
      return currentValue;
    });

    // Ensure mainStream is attached. The transport's auto-attach handles
    // peers created after setLocalStream; this addTrack-per-track pass
    // is the on-connect fallback for peers created before mainStream
    // existed. Duplicate-track adds are silently ignored by the transport.
    const mainStream = this.bindings.mainStream();
    if (mainStream) {
      try {
        for (const track of mainStream.getTracks()) {
          transport.addTrack(track, mainStream);
        }
        this.bindings.logger.logCustomMessage(
          `addStream on-connect [${pubKeyB64.slice(0, 8)}]: ${mainStream.getTracks().length} tracks`
        );
      } catch (_e) {
        // Tracks may already be in the offer — silently ignore duplicate-track errors.
      }
    }

    // Prioritise audio over video on the now-live sender (protects voice on
    // constrained uplinks). Fire-and-forget; senders exist post-addTrack.
    void this._applySenderPriorities(pubKeyB64);

    this.updateConnectionStatus(pubKeyB64, { type: 'Connected' });
    this.bindings.eventCallback({
      type: 'peer-connected',
      pubKeyB64,
      connectionId,
    });

    // After ICE settles, sample the selected candidate pair to detect
    // relay (TURN) usage so the UI can flag it.
    this.bindings.setTimeout(async () => {
      try {
        const stats = await transport.getStats(pubKeyB64);
        if (!stats) return;
        let isRelayed = false;
        const reportsById: Record<string, any> = {};
        stats.raw.forEach((report: any) => {
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
            this.bindings.logger.logCustomMessage(
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
          this.bindings.logger.logCustomMessage(
            `Connection [${pubKeyB64.slice(0, 8)}]: relayed via TURN`
          );
        }
      } catch (_e) {
        // getStats may fail if connection was already closed
      }
    }, 2000);
  }

  /**
   * The single executor of `closeCleanupPlan` rows
   * (transport/close-cleanup-policy.ts) — every connection-TEARDOWN path
   * (close event, stale teardown, peer leave; media and both
   * screen-share directions) applies its cleanup through here. Error
   * events are NOT a teardown path (F2 amendment) — their handlers are
   * log-only and never reach this executor. The step ORDER below is part
   * of the contract: CarrierSwitch reads the slot's `connected` before
   * the clear; `_emitIceNeverConnected` runs before `_clearIceTiming`
   * wipes the record; a `before-slot-clear` transport close deliberately
   * lets the synchronously emitted nested `closed` event run the full
   * close row first (see the policy header). Public (not `private`) —
   * reached by every non-media-transport caller through the store's
   * `_applyCloseCleanup` bare delegate.
   */
  applyCloseCleanup(
    ctx: CloseCleanupContext,
    plan: CloseCleanupPlan,
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    closeReason: string,
  ): void {
    const slotStore =
      ctx.target === 'media'
        ? this._openConnections
        : ctx.target === 'screen-share-outgoing'
          ? this.bindings.screenShareConnectionsOutgoing()
          : this.bindings.screenShareConnectionsIncoming();
    const transport =
      ctx.target === 'media'
        ? this.bindings.mediaTransport()
        : ctx.target === 'screen-share-outgoing'
          ? this.bindings.screenShareOutTransport()
          : this.bindings.screenShareInTransport();

    const wasWebrtcCarrier = !!get(slotStore)[pubKeyB64]?.connected;

    if (plan.closeTransport === 'before-slot-clear') {
      transport.closeConnection(pubKeyB64, closeReason);
    }

    if (plan.emitCarrierSwitch && wasWebrtcCarrier) {
      // Annotate the downgrade with *why* we left webrtc (§6.6) — the
      // reason the FSM took this peer out of `connected`, captured in
      // `_logFsmTransition`. Falls back to 'unknown' if the root reason
      // wasn't seen.
      const reason = this.bindings.peerRecord(pubKeyB64)?.webrtcExitReason ?? 'unknown';
      this.bindings.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.bindings.now(),
        event: 'CarrierSwitch',
        connectionId,
        detail: `webrtc->signals reason="${reason}"`,
      });
    }
    if (plan.recordLastDisconnect) {
      this.bindings.ensurePeerRecord(pubKeyB64).lastDisconnectTime = this.bindings.now();
    }
    // recordReset runs AFTER recordLastDisconnect on purpose: on the
    // peer-leave/live path the nested close-event row (via the
    // synchronous `closed` from closeTransport above) has already
    // stamped the cooldown, and the leave row's `media-leave-residue`
    // reset then wipes it — the delete wins (§9 item 5).
    if (plan.recordReset !== 'none') {
      const r = this.bindings.peerRecord(pubKeyB64);
      if (r) this.bindings.setPeerRecord(pubKeyB64, resetPeerRecord(r, plan.recordReset));
    }

    if (plan.clearSlot) {
      slotStore.update(currentValue => {
        delete currentValue[pubKeyB64];
        return currentValue;
      });
    }

    if (plan.clearPerceivedStreamInfo) {
      // Clear stale perceivedStreamInfo so icons don't show stale state
      // during reconnection.
      this.bindings.othersConnectionStatuses().update(statuses => {
        if (statuses[pubKeyB64]) {
          statuses[pubKeyB64] = {
            ...statuses[pubKeyB64],
            perceivedStreamInfo: undefined,
          };
        }
        return statuses;
      });
    }

    // Capture failure-side latency before _clearIceTiming wipes the
    // timing entry. _emitIceNeverConnected no-ops if the establishment
    // event already fired (i.e. this is a normal close after a
    // successful connect).
    if (plan.emitIceNeverConnected) this._emitIceNeverConnected(pubKeyB64, connectionId);
    if (plan.clearIceTiming) this._clearIceTiming(pubKeyB64, connectionId);
    if (plan.clearWebrtcStats) this.bindings.webrtcStats.delete(pubKeyB64);

    if (plan.teardownOutgoingScreenShare) {
      // Tear down any outgoing screen share to this peer since they
      // have disconnected. Without this, a stale connection may linger
      // and block re-initiation when the peer rejoins.
      const outgoingConnections = this.bindings.screenShareConnectionsOutgoing();
      const outgoingScreenShare = get(outgoingConnections)[pubKeyB64];
      if (outgoingScreenShare) {
        this.bindings.screenShareOutTransport().closeConnection(
          pubKeyB64,
          'media peer closed',
        );
        outgoingConnections.update(currentValue => {
          delete currentValue[pubKeyB64];
          return currentValue;
        });
      }
    }

    if (plan.setDisconnectedStatus === 'media') {
      this.updateConnectionStatus(pubKeyB64, { type: 'Disconnected' });
    } else if (plan.setDisconnectedStatus === 'screen-share') {
      this.bindings.updateScreenShareConnectionStatus(pubKeyB64, { type: 'Disconnected' });
    }
    if (plan.fireEvent === 'peer-disconnected') {
      this.bindings.eventCallback({
        type: 'peer-disconnected',
        pubKeyB64,
        connectionId,
      });
    } else if (plan.fireEvent === 'peer-screen-share-disconnected') {
      this.bindings.eventCallback({
        type: 'peer-screen-share-disconnected',
        pubKeyB64,
        connectionId,
      });
    }
  }

  private _handleMediaClosed(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    /** Why the slot is being cleared — the `phase/reason` pair from
     *  `routeTransportPhase`, or a call-site tag for the paths that close a
     *  connection directly. Recorded on the FsmClose event so
     *  a give-up is distinguishable from an ordinary close in the log. */
    cause = 'close-event',
  ): void {

    // Guards live in `decideSlotWrite` (shared with the carrier-handover
    // harness). Superseded: the slot points at a different connectionId, a
    // newer connection has taken over and we must NOT wipe its state.
    // No-slot: duplicate close — the first close already deleted
    // _openConnections[peer], cleared analyser/stats, and fired
    // peer-disconnected; a second would emit a redundant
    // FsmClose and re-fire peer-disconnected on consumers.
    const slotWrite = decideSlotWrite(
      { kind: 'closed' },
      connectionId,
      get(this._openConnections)[pubKeyB64],
    );
    const ctx: CloseCleanupContext = {
      target: 'media',
      via: 'close-event',
      outcome: closeGuardOutcome(slotWrite),
    };
    const plan = closeCleanupPlan(ctx);

    if (plan.logSuperseded && slotWrite.write === 'none') {
      this.bindings.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.bindings.now(),
        event: 'SupersededClose',
        connectionId,
        detail: `superseded-by=${slotWrite.supersededBy}`,
      });
    }

    if (ctx.outcome === 'live') {
      // Flush any in-flight SdpData bursts for this connection so the
      // summary lands before the close event in the timeline.
      this._flushSdpAggregatesForConnection(connectionId);
      this.bindings.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.bindings.now(),
        event: 'FsmClose',
        connectionId,
        detail: `cause=${cause}`,
      });
    }

    this.applyCloseCleanup(ctx, plan, pubKeyB64, connectionId, 'close event');
  }

  private _handleMediaRemoteStream(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    stream: MediaStream,
  ): void {
    const trackDesc = stream.getTracks().map(t =>
      `${t.kind}:muted=${t.muted},readyState=${t.readyState}`
    ).join(', ');
    this.bindings.logger.logCustomMessage(
      `stream received [${pubKeyB64.slice(0, 8)}]: ${stream.getTracks().length} tracks [${trackDesc}]`
    );
    this.bindings.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.bindings.now(),
      event: 'StreamReceived',
      connectionId,
    });
    this.bindings.ensurePeerRecord(pubKeyB64).videoStream = stream;

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
    this.bindings.setupPeerAudioAnalyser(pubKeyB64, stream);
    this.bindings.eventCallback({
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
    this.bindings.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.bindings.now(),
      event: 'RemoteTrack',
      connectionId,
    });

    // Ensure the audio analyser is wired up for this peer. The 'remote-stream'
    // event is deduped per stream.id in the underlying RTCPeer, so a stream
    // whose first track was video (analyser-setup early-returns on no audio)
    // never gets a second pass when the audio track arrives later. Hook it
    // here as well: idempotent if the analyser already exists.
    if (track.kind === 'audio' && stream && !this.bindings.peerRecord(pubKeyB64)?.analyser) {
      this.bindings.setupPeerAudioAnalyser(pubKeyB64, stream);
    }

    if (!track.muted) {
      this._setTrackReady(pubKeyB64, connectionId, track);
      return;
    }

    this.bindings.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.bindings.now(),
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

    const unmuteTimeout = this.bindings.setTimeout(() => {
      if (track.muted) {
        this.bindings.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: this.bindings.now(),
          event: 'TrackUnmuteTimeout',
        });
        this._setTrackReady(pubKeyB64, connectionId, track);
      }
    }, 5000);

    track.onunmute = () => {
      this.bindings.clearTimeout(unmuteTimeout);
      this.bindings.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.bindings.now(),
        event: 'TrackUnmuted',
      });
      this._setTrackReady(pubKeyB64, connectionId, track);
    };
  }

  /**
   * Marks a received track as ready — sets the audio/video flag on the
   * connection and fires the appropriate event callback. Called either
   * immediately when a track arrives unmuted, or later via
   * onunmute/timeout for initially-muted tracks. The sole caller is
   * `_handleMediaRemoteTrack` above (no other caller anywhere in the
   * codebase) — moved with it rather than left behind on the store.
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
      this.bindings.eventCallback({
        type: 'peer-audio-on',
        pubKeyB64,
        connectionId,
      });
    }
    if (track.kind === 'video') {
      this.bindings.eventCallback({
        type: 'peer-video-on',
        pubKeyB64,
        connectionId,
      });
    }
  }

  private _handleMediaDataChannelMessage(
    pubKeyB64: AgentPubKeyB64,
    data: unknown,
  ): void {
    for (const action of decodeRtcMessage(data)) {
      switch (action.kind) {
        case 'set-peer-track': {
          this._openConnections.update(currentValue => {
            const conn = currentValue[pubKeyB64];
            if (conn) conn[action.track] = action.enabled;
            return currentValue;
          });
          this.bindings.logger.logAgentEvent({
            agent: pubKeyB64,
            timestamp: this.bindings.now(),
            event: action.event,
          });
          break;
        }
        case 'log-input-change': {
          this.bindings.logger.logAgentEvent({
            agent: pubKeyB64,
            timestamp: this.bindings.now(),
            event: action.event,
          });
          break;
        }
        case 'refresh-tracks': {
          this.bindings.logger.logCustomMessage(
            `request-track-refresh received from [${pubKeyB64.slice(0, 8)}]`
          );
          this.bindings.refreshTracksForPeer(pubKeyB64);
          break;
        }
        case 'ignore':
          // `not-action` frames (text, primitives) stay silent — they are
          // not this handler's traffic. An unknown *action* message is
          // worth a trace: it usually means the peer runs a newer build.
          if (action.reason === 'unknown-action') {
            this.bindings.logger.logCustomMessage(
              `Unknown RTCMessage action from [${pubKeyB64.slice(0, 8)}] — newer peer build? Frame: ${data}`
            );
          }
          break;
        case 'parse-error': {
          console.warn(
            `Failed to parse RTCMessage: ${action.detail}. Got message: ${data}}`
          );
          break;
        }
        default: {
          const exhaustive: never = action;
          void exhaustive;
        }
      }
    }
  }

  /**
   * FORENSIC-ONLY (Round 3 item 1 as amended by review F2). Transport
   * error events carry the root-cause text of RTCPeer operational
   * failures — negotiation exceptions, data-channel errors — which the
   * FSM's own recovery owns and its `failed` phase adjudicates. This
   * handler logs and touches NOTHING else: no slot write, no transport
   * close, no view event, no status change. Teardown has exactly one
   * authority (the phase routes); wiring errors to teardown was the
   * dual-controller race §3.4 documents. The log-only invariant is
   * pinned in `streams-store-wiring.test.ts`.
   */
  private _handleMediaError(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    error: Error,
  ): void {
    const attribution = attributeSlotEvent(
      connectionId,
      get(this._openConnections)[pubKeyB64],
    );
    if (attribution.outcome === 'superseded') {
      // A stale FSM's error, attributed so it cannot be misread as the
      // live connection failing.
      this.bindings.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.bindings.now(),
        event: 'SupersededError',
        connectionId,
        detail: `superseded-by=${attribution.supersededBy}; err=${error.message || error}`,
      });
      return;
    }
    this.bindings.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.bindings.now(),
      event: 'FsmError',
      connectionId,
      detail: `${error.message || String(error)}; slot=${attribution.outcome}`,
    });
  }

  /**
   * Log an SdpData event with burst aggregation. See `_sdpDataAggregates`
   * for the rationale. First event of a burst always passes through with
   * full detail; subsequent events within SDP_AGGREGATE_WINDOW_MS are
   * coalesced into a count. When a new event arrives after the window
   * expires the prior burst (if count > 1) is flushed as a summary
   * before the new event is emitted. `flushStaleSdpAggregates` handles
   * bursts that end with no follow-up event. Public — called directly by
   * `handleSdpFsm` (below, this class since Task 4) and reached by
   * `ScreenShareLinks.handleSdpFsmScreen` through the store's
   * `_logSdpDataEvent` bare delegate.
   */
  logSdpDataEvent(
    agent: AgentPubKeyB64,
    connectionId: string,
    sdpType: string,
  ): void {
    const key = `${agent}:${connectionId}:${sdpType}`;
    const now = this.bindings.now();
    const entry = this._sdpDataAggregates.get(key);
    const withinWindow = entry && (now - entry.lastTimestamp) < MediaLinks.SDP_AGGREGATE_WINDOW_MS;

    if (withinWindow) {
      entry!.count += 1;
      entry!.lastTimestamp = now;
      return;
    }

    if (entry && entry.count > 1) {
      this._emitSdpAggregateSummary(entry);
    }

    this.bindings.logger.logAgentEvent({
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
    this.bindings.logger.logAgentEvent({
      agent: entry.agent,
      timestamp: entry.lastTimestamp,
      event: 'SdpData',
      connectionId: entry.connectionId,
      detail: `${entry.sdpType} x${entry.count} over ${(durationMs / 1000).toFixed(1)}s`,
    });
  }

  /**
   * Flush SdpData aggregates whose last event is older than the window —
   * i.e. bursts that ended without another event to push them out
   * naturally. Called on the same 2s ping tick that drives the rest of
   * the periodic bookkeeping. Public — reached by `pingAgents` through
   * the store's `_flushStaleSdpAggregates` bare delegate.
   */
  flushStaleSdpAggregates(): void {
    const now = this.bindings.now();
    for (const [key, entry] of this._sdpDataAggregates) {
      if ((now - entry.lastTimestamp) >= MediaLinks.SDP_AGGREGATE_WINDOW_MS) {
        if (entry.count > 1) this._emitSdpAggregateSummary(entry);
        this._sdpDataAggregates.delete(key);
      }
    }
  }

  /**
   * Flush all SdpData aggregates for a given connectionId. Called from
   * the close/error paths so the storm summary lands in the timeline
   * immediately before the FsmClose / FsmError event,
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
   * The one executor for a stale-connection teardown. The predicate that
   * decides *whether* to tear down is `decideStaleConnectionCleanup`
   * (`transport/stale-connection-policy.ts`); the cleanup set is the
   * `stale-teardown` rows of `closeCleanupPlan`
   * (`transport/close-cleanup-policy.ts`). All three supervisor sites
   * call this: the video check in `drivePong` (below, this class — a
   * direct internal call since Task 4) and the screen-share checks in
   * `handlePingUi`/`_drivePongScreenShare`, both store-resident, through
   * the `_applyStaleTeardown` bare delegate. Site-specific forensics
   * (console/custom/agent-event logging) stay at the sites. Public —
   * reached by the two store sites through that bare delegate.
   */
  applyStaleTeardown(
    target: 'media' | 'screen-share-outgoing',
    pubkeyB64: AgentPubKeyB64,
    iceState: RTCIceConnectionState | undefined,
  ): void {
    // The supervisor only fires against an existing slot
    // (`hasExistingConn` is the first input to the predicate), so the
    // outcome axis is 'live' by construction here.
    const ctx: CloseCleanupContext = {
      target,
      via: 'stale-teardown',
      outcome: 'live',
    };
    const slot =
      target === 'media'
        ? get(this._openConnections)[pubkeyB64]
        : get(this.bindings.screenShareConnectionsOutgoing())[pubkeyB64];
    this.applyCloseCleanup(
      ctx,
      closeCleanupPlan(ctx),
      pubkeyB64,
      slot?.connectionId ?? '',
      `stale ICE=${iceState}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Establishment + pong drive (store-decomposition round three, Task 4)
  //
  // The InitRequest/InitAccept handshake, the SdpFsm signal feed, the
  // pong-driven initiator loop, the RTT-scaled SDP-exchange timeout pair,
  // and the connection-status writer they all share.
  // ---------------------------------------------------------------------------

  /** If an InitRequest does not succeed within this duration (ms) another
   *  InitRequest will be sent. Moved from streams-store.ts's
   *  `INIT_RETRY_THRESHOLD` (store-decomposition round three, Task 4) —
   *  `drivePong` is its only caller. */
  private static readonly INIT_RETRY_THRESHOLD_MS = 5000;

  /**
   * RTT-scaled SDP-exchange timeout (ms) for an FSM initiator connection,
   * or undefined when no signaling-RTT sample exists yet — the FSM then
   * falls back to its config default (15s), i.e. unchanged behaviour.
   *
   * The SDP exchange rides the same Holochain signal transport as
   * ping/pong, so the signals-carrier RTT EWMA is the correct latency
   * proxy. K is kept generous to absorb signal-relay retransmits; the
   * floor avoids an over-tight timeout on very low-RTT links; the ceiling
   * (`SDP_TIMEOUT_CEILING_MS`, streams-store.ts) is raised past today's
   * fixed default — see that constant's comment for the field rationale.
   * K/FLOOR are provisional — see docs/CONNECTION_LIFECYCLE_PLAN.md Phase
   * 4A. Public — reached by `ScreenShareLinks`'s `computeSdpTimeout`
   * binding through the store's `_computeSdpTimeout` bare delegate.
   */
  computeSdpTimeout(peerB64: AgentPubKeyB64): number | undefined {
    const rtt = this.bindings.peerRecord(peerB64)?.signalsRttEwma;
    if (rtt === undefined || rtt <= 0) return undefined;
    return Math.min(
      this.bindings.sdpTimeoutCeilingMs,
      Math.max(
        this.bindings.sdpTimeoutFloorMs,
        Math.round(rtt * this.bindings.sdpTimeoutRttMultiplier),
      ),
    );
  }

  /**
   * Timeout (ms) for this class's own tracked SDP-exchange backstop timer
   * — second-line cleanup for an FSM that wedges without ever emitting a
   * phase transition. Deliberately NOT the same value as
   * `computeSdpTimeout` (the FSM's own per-attempt timeout, passed as
   * `sdpExchangeTimeoutMs`): the backstop must always leave that timeout
   * and its first in-place backoff retry undisturbed, so it is pinned
   * strictly greater — `SDP_BACKSTOP_MULTIPLIER` (2x, streams-store.ts)
   * times the per-attempt timeout plus `SDP_BACKSTOP_RETRY_HEADROOM_MS`,
   * capped at `SDP_BACKSTOP_CEILING_MS`. Sharing the per-attempt value
   * was Task 9's original defect (review C1): the backstop fired in the
   * same tick as the FSM's own timeout and destroyed its in-place
   * recovery attempt instead of letting it run. The bare 2x multiplier
   * without headroom was a second, narrower instance of the same defect
   * (final-review wave F1): the FSM's attempt-2 deadline is
   * `2 * perAttempt + retryDelay`, not `2 * perAttempt`, so the headroom
   * covers that retry's own delay budget (see
   * `SDP_BACKSTOP_RETRY_HEADROOM_MS`). Private — the sole caller,
   * `handleInitAccept` below, is a method of this class; unlike
   * `computeSdpTimeout`, no bare store delegate exists for this one.
   */
  private _computeSdpBackstopTimeout(peerB64: AgentPubKeyB64): number {
    const perAttempt =
      this.computeSdpTimeout(peerB64) ?? this.bindings.sdpExchangeTimeoutFallbackMs;
    return Math.min(
      this.bindings.sdpBackstopCeilingMs,
      perAttempt * this.bindings.sdpBackstopMultiplier +
        this.bindings.sdpBackstopRetryHeadroomMs,
    );
  }

  /**
   * Write the connection-status slot for `pubKey`, coalescing repeated
   * `InitSent`/`AcceptSent` into an attempt counter, and refusing to
   * regress a `Connected` peer back to `SdpExchange` (video-toggle
   * SdpExchange re-entry while already connected is expected and must be
   * a no-op). On transition to `Connected`, fires an immediate pong to
   * every known agent so their UI updates within milliseconds rather than
   * waiting for the next ping cycle. Public — was `StreamsStore.updateConnectionStatus`
   * until store-decomposition round three, Task 4 moved it here with no
   * external caller surviving (grepped: every prior caller was itself
   * moving code).
   */
  updateConnectionStatus(pubKey: AgentPubKeyB64, status: ConnectionStatus) {
    this.bindings.connectionStatuses().update(currentValue => {
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
      this.bindings.sendImmediatePongToAll();
    }
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
   *
   * Public since store-decomposition round three, Task 4 (was
   * `StreamsStore._drivePongMediaLink`, née Task 1); called from the
   * store's `handlePongUi` as `this.mediaLinks.drivePong(...)`.
   */
  async drivePong(
    pubkeyB64: AgentPubKeyB64,
    fromAgent: AgentPubKey,
    metaDataExt: PongMetaData<PongMetaDataV1> | undefined,
    now: number
  ): Promise<void> {
    const conversationActive = !!get(this.bindings.myModuleStates())['conversation'];

    // Per-peer WebRTC override: `webrtcDisabled` unions our own
    // intent-sourced disable with the peer's broadcast disable (Task 4 —
    // see its docblock for the composition). Skips the entire init/retry
    // path; audio flows over Holochain remote signals automatically
    // (Step 3 carrier routing).
    const peerWebrtcDisabled = this.bindings.webrtcDisabled(pubkeyB64);
    // Has the peer's conversation payload (and therefore their declared
    // caps) arrived at all? Distinct from `peerHasSdpFsmCap` below — see
    // `peerCapsKnown`'s docblock in carrier-coverage.ts (field incident D2).
    const peerCapsKnown =
      get(this.bindings.peerModuleStates())[pubkeyB64]?.['conversation'] !== undefined;

    // Clean up stale video connection if the underlying WebRTC is dead.
    // This allows the normal initiation flow to proceed for a re-joining peer.
    // The predicate lives in `transport/stale-connection-policy.ts` — it is
    // the same rule the two screen-share sites below apply, and it is where
    // the grace-window and one-recovery-controller rationale is written down.
    const existingConn = get(this._openConnections)[pubkeyB64];
    {
      const activeTransport = this.bindings.mediaTransport();
      const iceState = existingConn
        ? activeTransport.getIceConnectionState(pubkeyB64)
        : undefined;
      const decision = decideStaleConnectionCleanup({
        hasExistingConn: !!existingConn,
        slotClaimsConnected: !!existingConn?.connected,
        // The transport declares whether it recovers itself; we do not
        // infer it from which transport this is.
        carrierOwnsRecovery: activeTransport.ownsTransportRecovery,
        iceState,
        disconnectedAt: this.bindings.peerRecord(pubkeyB64)?.iceDisconnectedAt,
        now: this.bindings.now(),
        graceMs: this.bindings.iceDisconnectedGraceMs,
      });
      if (existingConn && decision.action === 'teardown') {
        this.bindings.logger.logCustomMessage(`Stale cleanup [${pubkeyB64.slice(0, 8)}]: ICE=${iceState} ${decision.reason}`);
        this.bindings.logger.logAgentEvent({
          agent: pubkeyB64,
          timestamp: this.bindings.now(),
          event: 'StaleCleanup',
          connectionId: existingConn.connectionId,
        });
        this.applyStaleTeardown('media', pubkeyB64, iceState);
      }
    }

    // alreadyOpen here does not include the case where SDP exchange is already ongoing
    // but no actual connection has happened yet
    const alreadyOpen = get(this._openConnections)[pubkeyB64];

    // Only initiate/manage WebRTC video connections when eligible. The
    // predicate (conversation module active, kill switch, per-peer
    // disable, sdp-fsm capability) is `decideWebrtcEligibility` — the
    // ONE composition of these conjuncts, shared with the acceptor arm
    // in `handleInitRequest` (Round 3 item 2).
    if (
      decideWebrtcEligibility({
        role: 'initiator',
        conversationActive,
        peerWebrtcDisabled,
        webrtcGloballyDisabled: this.bindings.webrtcGloballyDisabled(),
        peerCapsKnown,
        peerHasSdpFsmCap: this.bindings.webrtcAvailableFor(pubkeyB64),
      }).eligible
    ) {
      const pendingInits = this.bindings.peerRecord(pubkeyB64)?.pendingInits;
      const decision = decideInitRetry({
        alreadyOpen: !!alreadyOpen,
        myPubKeyB64: this.bindings.myPubKeyB64(),
        peerPubKeyB64: pubkeyB64,
        pendingInitT0s: pendingInits?.map(init => init.t0),
        now,
        retryThresholdMs: MediaLinks.INIT_RETRY_THRESHOLD_MS,
      });
      switch (decision.action) {
        case 'send-init': {
          if (decision.reason === 'no-pending-init') {
            const lastDisconnect = this.bindings.peerRecord(pubkeyB64)?.lastDisconnectTime;
            if (lastDisconnect) {
              const gap = this.bindings.now() - lastDisconnect;
              this.bindings.logger.logCustomMessage(
                `Retry gap [${pubkeyB64.slice(0, 8)}]: ${gap}ms since last disconnect (initiator)`
              );
            }
          }
          const newConnectionId = uuidv4();
          this.bindings.ensurePeerRecord(pubkeyB64).pendingInits = [
            ...(pendingInits ?? []),
            { connectionId: newConnectionId, t0: now },
          ];
          await this.bindings.sendMessage(
            [fromAgent],
            'InitRequest',
            JSON.stringify({ connection_id: newConnectionId, connection_type: 'video' }),
          );
          this.updateConnectionStatus(pubkeyB64, { type: 'InitSent' });
          break;
        }
        case 'await-peer-init':
          this.updateConnectionStatus(pubkeyB64, { type: 'AwaitingInit' });
          break;
        case 'hold': {
          if (decision.reason === 'already-open' && metaDataExt?.data.streamInfo) {
            // If the connection is already open, reconcile with our expected stream state
            this.bindings.reconcileVideoStreamState(pubkeyB64, metaDataExt.data.streamInfo);
          }
          break;
        }
        default: {
          const exhaustive: never = decision;
          void exhaustive;
        }
      }
    }

    // Check whether they have the right expectation of our audio state and if not,
    // send an audio-off signal
    if (alreadyOpen && metaDataExt?.data.audio) {
      if (!this.bindings.mainStream()?.getAudioTracks()[0]?.enabled) {
        this.bindings.sendRtcAction('audio-off', [pubkeyB64]);
      }
    }
  }

  /**
   * Handle an InitRequest signal
   *
   * @param signal
   *
   * Public method of this class since store-decomposition round three,
   * Task 4 (was `StreamsStore.handleInitRequest`); called from the
   * store's `_processSignal` as `this.mediaLinks.handleInitRequest(signal)`.
   */
  async handleInitRequest(
    signal: Extract<RoomSignal, { type: 'Message' }>
  ) {
    const pubKey64 = encodeHashToBase64(signal.from_agent);
    const parsedInit = parseSignalPayload<InitPayload>(signal.payload);
    if (!parsedInit.ok) {
      this.bindings.logger.logCustomMessage(
        `Dropped InitRequest from ${pubKey64.slice(0, 8)}: ${parsedInit.error}`
      );
      return;
    }
    const { connection_id, connection_type } = parsedInit.value;
    this.bindings.logger.logAgentEvent({
      agent: pubKey64,
      timestamp: this.bindings.now(),
      event: 'InitRequest',
      connectionId: connection_id,
    });

    // Log retry gap if this is a reconnection attempt
    const lastDisconnect = this.bindings.peerRecord(pubKey64)?.lastDisconnectTime;
    if (lastDisconnect) {
      const gap = this.bindings.now() - lastDisconnect;
      this.bindings.logger.logCustomMessage(
        `Retry gap [${pubKey64.slice(0, 8)}]: ${gap}ms since last disconnect`
      );
    }

    /**
     * InitRequests for normal audio/video stream
     *
     * Only accept init requests from agents who's pubkey is alphabetically  "higher" than ours
     */
    if (connection_type === 'video' && pubKey64 > this.bindings.myPubKeyB64()) {
      // One eligibility predicate, shared with the initiator arm in
      // `handlePongUi` (Round 3 item 2). Declared behavior change: the
      // acceptor now requires `conversationActive` too — before this,
      // a node with the conversation module inactive refused to initiate
      // but would answer an inbound InitRequest and stand up a full
      // connection. The decision and its reason live in the predicate's
      // docblock (`decideWebrtcEligibility`, carrier-coverage.ts).
      const eligibility = decideWebrtcEligibility({
        role: 'acceptor',
        conversationActive: !!get(this.bindings.myModuleStates())['conversation'],
        // `webrtcDisabled` unions our own intent-sourced disable with the
        // peer's broadcast disable — see the initiator arm's comment.
        peerWebrtcDisabled: this.bindings.webrtcDisabled(pubKey64),
        webrtcGloballyDisabled: this.bindings.webrtcGloballyDisabled(),
        peerCapsKnown: get(this.bindings.peerModuleStates())[pubKey64]?.['conversation'] !== undefined,
        peerHasSdpFsmCap: this.bindings.webrtcAvailableFor(pubKey64),
      });
      if (!eligibility.eligible) {
        const reason = eligibility.reason;
        switch (reason) {
          case 'conversation-inactive':
            this.bindings.logger.logCustomMessage(
              `Ignored video InitRequest from ${pubKey64.slice(0, 8)}: conversation module inactive (symmetric eligibility, §8 item 2)`
            );
            break;
          case 'webrtc-globally-disabled':
          case 'peer-webrtc-disabled':
            break;
          case 'peer-caps-unknown':
            // The peer's conversation payload (and therefore their
            // declared caps) has not arrived yet — distinct from actually
            // lacking the capability (field incident D2). Never answer:
            // the lure-warning below applies just as much to a peer we
            // cannot yet confirm holds sdp-fsm. No parking is needed —
            // this join's next pong re-evaluates eligibility once the
            // payload lands (`decideInitRetry` is level-triggered).
            this.bindings.logger.logCustomMessage(
              `Dropped video InitRequest from ${pubKey64.slice(0, 8)}: peer caps not yet received`
            );
            break;
          case 'peer-lacks-sdp-fsm-cap':
            // A peer whose build cannot parse SdpFsm has no WebRTC path
            // to us at all since Phase 3 deleted SimplePeer; answering
            // their InitRequest would lure them into an SDP exchange we
            // drop.
            this.bindings.logger.logCustomMessage(
              `Dropped video InitRequest from ${pubKey64.slice(0, 8)}: peer lacks sdp-fsm capability`
            );
            break;
          default: {
            const exhaustive: never = reason;
            void exhaustive;
          }
        }
        return;
      }
      // No reservation is needed on the acceptor side: the FSM creates
      // per-peer state lazily from the incoming offer (SdpFsm), so the
      // InitAccept is purely the initiator's go-signal. `_pendingAccepts`
      // died with the SimplePeer SdpData path that consumed it.
      await this.bindings.sendMessage(
        [signal.from_agent],
        'InitAccept',
        JSON.stringify({ connection_id, connection_type }),
      );
      this.updateConnectionStatus(pubKey64, { type: 'AcceptSent' });
    }

    /**
     * Screen-share InitRequests are a retired wire flow (Phase 3): the FSM
     * screen path negotiates over `SdpFsmScreen` with no reservation
     * handshake. Only a ≤ v0.14.8 peer still sends these — their
     * SimplePeer screen share cannot interoperate with this build, so the
     * request is dropped explicitly rather than silently.
     */
    if (connection_type === 'screen') {
      this.bindings.logger.logCustomMessage(
        `Dropped screen-share InitRequest from ${pubKey64.slice(0, 8)}: ` +
          'peer build predates the FSM screen-share channel (SdpFsmScreen)'
      );
    }
  }

  /**
   * Handle an InitAccept signal
   *
   * @param signal
   *
   * Public method of this class since store-decomposition round three,
   * Task 4 (was `StreamsStore.handleInitAccept`); called from the store's
   * `_processSignal` as `this.mediaLinks.handleInitAccept(signal)`. Task
   * 3's extraction left this on the store because it is the initiator's
   * own send path, not transport-event glue — but it always called
   * `_applyMediaSignalingRoute` directly, and now that it lives in the
   * same class as that method, there is no more reason for the split.
   */
  async handleInitAccept(signal: Extract<RoomSignal, { type: 'Message' }>) {
    const pubKey64 = encodeHashToBase64(signal.from_agent);
    const parsedAccept = parseSignalPayload<InitPayload>(signal.payload);
    if (!parsedAccept.ok) {
      this.bindings.logger.logCustomMessage(
        `Dropped InitAccept from ${pubKey64.slice(0, 8)}: ${parsedAccept.error}`
      );
      return;
    }
    const { connection_id, connection_type } = parsedAccept.value;
    this.bindings.logger.logAgentEvent({
      agent: pubKey64,
      timestamp: this.bindings.now(),
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
      const agentPendingInits = this.bindings.peerRecord(pubKey64)?.pendingInits;
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
            const rtt = this.bindings.now() - matchingInit.t0;
            this.bindings.logger.logCustomMessage(
              `Signaling RTT [${pubKey64.slice(0, 8)}]: ${rtt}ms`
            );
          }

          // Make sure the transport has the latest local stream cached
          // so the initial offer includes our tracks. Set on both impls
          // so a future swap doesn't lose the stream.
          const mainStream = this.bindings.mainStream();
          if (mainStream) {
            for (const t of this.bindings.allMediaTransports()) t.setLocalStream(mainStream);
            this.bindings.logger.logCustomMessage(
              `addStream pre-SDP [${pubKey64.slice(0, 8)}]: ${mainStream.getTracks().length} tracks (initiator)`
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
          const transport = this.bindings.mediaTransport();
          const effectiveConnId = transport.ensureConnection(pubKey64, {
            initiator: true,
            connectionId: connection_id,
            sdpExchangeTimeoutMs: this.computeSdpTimeout(pubKey64),
            epoch: this.bindings.nextConnectionEpoch(pubKey64),
          });

          // The slot write goes through the ONE slot policy — the same
          // routeTransportPhase('signaling') + decideSlotWrite pair the
          // transport event glue runs — instead of the hand-written
          // `_openConnections.update` this replaces (§9 item 5). If the
          // transport synchronously emitted `signaling` during
          // ensureConnection the route resolves to `keep` and the write
          // half is a no-op; against a transport that emits nothing this
          // is the installer. (The old code also carried a supersede
          // block here that could never run: it read the slot inside the
          // no-open-connection guard, before ensureConnection, so its
          // prior-slot capture was always undefined. The adopt arm of
          // the shared apply now owns that path for real.)
          const route = routeTransportPhase({
            phase: 'signaling',
            connectionId: effectiveConnId,
            openConnectionId: get(this._openConnections)[pubKey64]?.connectionId,
          });
          if (route.handler === 'signaling') {
            this._applyMediaSignalingRoute(
              pubKey64,
              effectiveConnId,
              route.slot,
              'initiator',
            );
          }

          { const r = this.bindings.peerRecord(pubKey64); if (r) r.pendingInits = undefined; }

          // Second-line backstop: if the FSM wedges without ever emitting
          // a phase transition, this store-level timer cleans up and lets
          // the next ping/pong cycle retry. Deliberately NOT the same
          // window as the FSM's own per-attempt SDP timeout above
          // (`sdpExchangeTimeoutMs: computeSdpTimeout(...)`) — it is
          // `_computeSdpBackstopTimeout`, pinned strictly greater (2x plus
          // `SDP_BACKSTOP_RETRY_HEADROOM_MS`, own ceiling) so it never
          // preempts the FSM's own timeout and first in-place backoff
          // retry (review C1; the headroom term closed a narrower
          // instance of the same defect — final-review wave F1). The timer is
          // ATTEMPT-scoped and TRACKED (§9 item 5): it may only tear down
          // the attempt that armed it — a successor attempt's slot must
          // survive this timer firing — and a new attempt for the same
          // peer disarms the previous timer, as does disconnect().
          const priorSdpTimer = this.bindings.peerRecord(pubKey64)?.sdpTimeoutTimer;
          if (priorSdpTimer !== undefined) this.bindings.clearTimeout(priorSdpTimer);
          this.bindings.ensurePeerRecord(pubKey64).sdpTimeoutTimer = this.bindings.setTimeout(() => {
            { const r = this.bindings.peerRecord(pubKey64); if (r) r.sdpTimeoutTimer = undefined; }
            const conn = get(this._openConnections)[pubKey64];
            // A successor attempt owns the slot now: its own timer owns
            // its deadline. (Pinned by the successor-survival wiring test.)
            if (conn && conn.connectionId !== effectiveConnId) return;
            const currentStatus = get(this.bindings.connectionStatuses())[pubKey64];
            if (!currentStatus || currentStatus.type !== 'SdpExchange') return;
            this.bindings.logger.logCustomMessage(
              `SDP timeout [${pubKey64.slice(0, 8)}]: destroying stale connection`
            );
            if (conn && !conn.connected) {
              this.bindings.mediaTransport().closeConnection(pubKey64, 'SDP exchange timeout');
              this._openConnections.update(current => {
                delete current[pubKey64];
                return current;
              });
            }
            this.updateConnectionStatus(pubKey64, { type: 'Disconnected' });
          }, this._computeSdpBackstopTimeout(pubKey64));
        }
      }
    }

    /**
     * Screen-share InitAccepts are a retired wire flow (Phase 3) — this
     * build never sends the screen InitRequest they answer. Only a
     * ≤ v0.14.8 peer can produce one (answering a request from its own
     * lineage); drop explicitly.
     */
    if (connection_type === 'screen') {
      this.bindings.logger.logCustomMessage(
        `Dropped screen-share InitAccept from ${pubKey64.slice(0, 8)}: retired wire flow`
      );
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
   *
   * Public method of this class since store-decomposition round three,
   * Task 4 (was `StreamsStore.handleSdpFsm`); called from the store's
   * `_processSignal` as `this.mediaLinks.handleSdpFsm(signal)`.
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
    this.bindings.mediaTransport().processIncomingSignal({
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
    const localConnId = this.bindings.mediaTransport().getConnectionId(pubkeyB64) ?? parsed.connection_id;
    this.logSdpDataEvent(pubkeyB64, localConnId, `fsm-${sdpType}`);
  }
}
