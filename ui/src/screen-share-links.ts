/**
 * ScreenShareLinks — owner of the two screen-share FSM transports (out =
 * sharer, in = viewer) and their signal/event wiring (store-decomposition
 * round two, Task 5; see
 * docs/superpowers/sdd/2026-09-03-owner-extraction). Owns the three
 * screen-share `Writable`s, the transport event subscription, the
 * connected/closed/remote-stream/remote-track/ice-diagnostic/error
 * handlers, outgoing-share establishment, the `SdpFsmScreen` signal
 * handler, and the connection-status writer.
 *
 * `screenShareOn`, `screenShareOff`, and `stopScreenShare` do NOT live
 * here: `ui/src/__tests__/intent-write-sites.test.ts` greps
 * `streams-store.ts` for those gesture-method headers and requires every
 * `_applyIntent` call to sit inside them, so they stay on the store
 * byte-identical (including `screenShareOn`'s local-track acquisition and
 * its `track.onended` gesture-equivalent wiring). They read/write the
 * connections `Writable`s and the `screenShareOutTransport` directly,
 * through the store's own fields and its delegating getters onto this
 * owner. `_applyCloseCleanup` also does NOT live here — it is the shared
 * teardown bridge into `closeCleanupPlan` used by the media path and the
 * stale-connection supervisor too, so it stays on the store and is
 * reached via the `applyCloseCleanup` binding.
 */
import { AgentPubKeyB64, encodeHashToBase64 } from '@holochain/client';
import { get, writable, type Writable } from '@holochain-open-dev/stores';
import type { PeerTransport, TransportEvent, IceDiagnostic } from './transport';
import {
  routeTransportPhase,
  decideSlotWrite,
  attributeSlotEvent,
} from './transport/media-event-policy';
import {
  closeCleanupPlan,
  closeGuardOutcome,
} from './transport/close-cleanup-policy';
import type {
  CloseCleanupContext,
  CloseCleanupPlan,
} from './transport/close-cleanup-policy';
import { decideScreenSignalRoute } from './transport/screen-signal-policy';
import { CAP_SDP_FSM_SCREEN } from './transport/wire-contract';
import { parseSignalPayload } from './signal-payload';
import type { PeerRecord } from './peer-record';
import type {
  ConnectionStatus,
  ConnectionStatuses,
  OpenConnectionInfo,
  RoomSignal,
  StoreEventPayload,
} from './types';
import type { PresenceLogger } from './logging';

export type ScreenShareLinksBindings = {
  /** this.screenShareOutTransport, late-bound (constructed in start(),
   *  after this owner exists). */
  outTransport: () => PeerTransport;
  /** this.screenShareInTransport, late-bound. */
  inTransport: () => PeerTransport;
  /** StreamsStore._applyCloseCleanup, late-bound (real signature). Stays
   *  on the store — it is the shared teardown bridge for media AND both
   *  screen-share directions, not screen-share-only. */
  applyCloseCleanup: (
    ctx: CloseCleanupContext,
    plan: CloseCleanupPlan,
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    closeReason: string,
  ) => void;
  /** StreamsStore._computeSdpTimeout, late-bound (real signature). */
  computeSdpTimeout: (peerB64: AgentPubKeyB64) => number | undefined;
  /** StreamsStore._nextConnectionEpoch, late-bound. */
  nextConnectionEpoch: (peer: AgentPubKeyB64) => number;
  /** StreamsStore._peerCaps, late-bound. */
  peerCaps: (peerB64: AgentPubKeyB64) => ReadonlySet<string>;
  peerRecord: (k: AgentPubKeyB64) => PeerRecord | undefined;
  ensurePeerRecord: (k: AgentPubKeyB64) => PeerRecord;
  /** StreamsStore._logSdpDataEvent, late-bound — shared with the media
   *  SdpFsm handler's burst-aggregation state, so it stays on the store. */
  logSdpDataEvent: (agent: AgentPubKeyB64, connectionId: string, sdpType: string) => void;
  eventCallback: (e: StoreEventPayload) => any;
  logger: PresenceLogger;
  now: () => number;
  /** StreamsStore.screenShareStream, late-bound (reassigned outside the
   *  constructor by the gesture methods, which stay on the store). */
  screenShareStream: () => MediaStream | undefined | null;
};

export class ScreenShareLinks {
  constructor(private readonly bindings: ScreenShareLinksBindings) {}

  /**
   * Connections where we are sharing our own screen and the Init/Accept
   * handshake succeeded
   */
  _screenShareConnectionsOutgoing: Writable<
    Record<AgentPubKeyB64, OpenConnectionInfo>
  > = writable({});

  /**
   * Connections where others are sharing their screen and the Init/Accept
   * handshake succeeded
   */
  _screenShareConnectionsIncoming: Writable<
    Record<AgentPubKeyB64, OpenConnectionInfo>
  > = writable({});

  /**
   * The statuses of WebRTC connections with peers to our own screen share
   * stream
   */
  _screenShareConnectionStatuses: Writable<ConnectionStatuses> = writable({});

  subscribe(transport: PeerTransport, initiator: boolean): void {
    transport.onAny((event: TransportEvent) => {
      switch (event.type) {
        case 'connection-state-change': {
          // Same authority as the media path: `routeTransportPhase` is
          // exhaustive over ConnectionPhase, so `failed` clears the slot
          // and `reconnecting`/`disconnected` defer to the FSM's own
          // recovery instead of tearing the share down.
          const route = routeTransportPhase({
            phase: event.phase,
            connectionId: event.connectionId,
            openConnectionId:
              get(this._screenShareStore(initiator))[event.peer]?.connectionId,
          });
          switch (route.handler) {
            case 'signaling': {
              const slotWrite = decideSlotWrite(
                { kind: 'signaling', slot: route.slot },
                event.connectionId,
                get(this._screenShareStore(initiator))[event.peer],
              );
              if (slotWrite.write === 'install' || slotWrite.write === 'replace') {
                if (slotWrite.write === 'replace') {
                  // The FSM behind the slot was replaced in place
                  // (higher-epoch offer / new remote session) with no
                  // close event — adopt the live connectionId, exactly
                  // like the media path.
                  this.bindings.logger.logAgentEvent({
                    agent: event.peer,
                    timestamp: this.bindings.now(),
                    event: 'Superseded',
                    connectionId: slotWrite.supersedes,
                    detail: `superseded-by=${event.connectionId}; path=screen-transport-replace`,
                  });
                }
                this._screenShareStore(initiator).update(currentValue => {
                  currentValue[event.peer] = {
                    ...slotWrite.slot,
                    video: initiator,
                    audio: false,
                    direction: initiator ? 'outgoing' : 'incoming',
                  };
                  return currentValue;
                });
                this.updateScreenShareConnectionStatus(event.peer, {
                  type: 'SdpExchange',
                });
              }
              break;
            }
            case 'media-connected':
              this._handleScreenShareConnected(event.peer, event.connectionId, initiator);
              break;
            case 'media-closed':
              this._handleScreenShareClosed(event.peer, event.connectionId, initiator);
              break;
            case 'ignore':
              break;
          }
          break;
        }
        case 'remote-stream':
          this._handleScreenShareRemoteStream(event.peer, event.connectionId, event.stream);
          break;
        case 'remote-track':
          this._handleScreenShareRemoteTrack(event.peer, event.connectionId, event.track);
          break;
        case 'ice-diagnostic':
          // Outgoing side only: the stale-cleanup grace bookkeeping (the
          // net itself stands down while the FSM owns recovery, but the
          // timestamps keep the forensic story readable). The viewer side
          // has no stale supervisor and needs nothing here.
          if (initiator) {
            this._handleScreenShareIceDiagnostic(event.peer, event.diag);
          }
          break;
        case 'error':
          this._handleScreenShareError(event.peer, event.connectionId, event.error, initiator);
          break;
      }
    });
  }

  private _screenShareStore(initiator: boolean): Writable<Record<AgentPubKeyB64, OpenConnectionInfo>> {
    return initiator
      ? this._screenShareConnectionsOutgoing
      : this._screenShareConnectionsIncoming;
  }

  /**
   * `ice-diagnostic` bookkeeping for the outgoing screen-share transport:
   * maintains the invariant on `screenShareIceDisconnectedAt` — an entry
   * exists iff the share's iceState is currently 'disconnected' — which
   * the stale-connection net reads for its grace window. No log lines:
   * the media transport is the forensic subject; the share only needs
   * the timestamps.
   */
  private _handleScreenShareIceDiagnostic(
    pubKeyB64: AgentPubKeyB64,
    diag: IceDiagnostic,
  ): void {
    if (diag.kind !== 'ice-state') return;
    if (diag.state === 'disconnected') {
      this.bindings.ensurePeerRecord(pubKeyB64).screenShareIceDisconnectedAt = this.bindings.now();
    } else {
      const r = this.bindings.peerRecord(pubKeyB64);
      if (r) r.screenShareIceDisconnectedAt = undefined;
    }
  }

  private _handleScreenShareConnected(
    pubKeyB64: AgentPubKeyB64,
    _connectionId: string,
    initiator: boolean,
  ): void {

    const store = this._screenShareStore(initiator);
    // Supersede guard, same decision as the media path: a `connected` for
    // a connectionId that no longer owns the slot must not flip the flag.
    const write = decideSlotWrite(
      { kind: 'connected' },
      _connectionId,
      get(store)[pubKeyB64],
    );
    if (write.write !== 'set-connected') return;
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
    const screenShareStream = this.bindings.screenShareStream();
    if (initiator && screenShareStream) {
      const conn = get(this._screenShareConnectionsOutgoing)[pubKeyB64];
      if (conn && conn.direction === 'outgoing') {
        try {
          for (const track of screenShareStream.getTracks()) {
            this.bindings.outTransport().addTrack(track, screenShareStream);
          }
        } catch (_e) {
          // duplicate tracks are silently ignored
        }
      }
    }

    if (!initiator) {
      this.bindings.eventCallback({
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

    // Supersede guard: a stale close from a replaced FSM must not clear
    // the slot a newer connection owns (decideSlotWrite drops it).
    const write = decideSlotWrite(
      { kind: 'closed' },
      connectionId,
      get(this._screenShareStore(initiator))[pubKeyB64],
    );
    const ctx: CloseCleanupContext = {
      target: initiator ? 'screen-share-outgoing' : 'screen-share-incoming',
      via: 'close-event',
      outcome: closeGuardOutcome(write),
    };
    this.bindings.applyCloseCleanup(
      ctx,
      closeCleanupPlan(ctx),
      pubKeyB64,
      connectionId,
      'close event',
    );
  }

  private _handleScreenShareRemoteStream(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
    stream: MediaStream,
  ): void {
    // Keep the stream reachable for room-view's paint-restore path
    // (`screenShareStream` was declared for exactly this and written
    // nowhere — the unscheduled-defects table; wired here by Phase 3).
    this.bindings.ensurePeerRecord(pubKeyB64).screenShareStream = stream;
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

    this.bindings.eventCallback({
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
    this.bindings.eventCallback({
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
    this.bindings.logger.logCustomMessage(
      `ScreenSharePeerError [${pubKeyB64.slice(0, 8)}]: ${error.message || error}`
    );

    // FORENSIC-ONLY, like the media error handler above (Round 3 item 1
    // as amended by review F2): the FSM owns screen-share recovery too,
    // and its `failed`/`closed` phases drive the teardown rows. The
    // attribution keeps a stale (replaced) FSM's error from reading as
    // the live share failing — the Phase 3 review-F1 hazard, now with no
    // writes to guard at all.
    const attribution = attributeSlotEvent(
      connectionId,
      get(this._screenShareStore(initiator))[pubKeyB64],
    );
    if (attribution.outcome === 'superseded') {
      this.bindings.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.bindings.now(),
        event: 'SupersededError',
        connectionId,
        detail: `superseded-by=${attribution.supersededBy}; err=${error.message || error}; path=screen`,
      });
      return;
    }
    this.bindings.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.bindings.now(),
      event: 'FsmError',
      connectionId,
      detail: `${error.message || String(error)}; path=screen; slot=${attribution.outcome}`,
    });
  }

  /**
   * Ensure an outgoing screen-share connection toward `pubkeyB64` exists.
   *
   * Replaces the InitRequest/InitAccept handshake the SimplePeer screen
   * path needed: the FSM acceptor creates state lazily from the incoming
   * offer, so there is no reservation to negotiate, no pending-init map,
   * and no retry cadence of our own — `ensureConnection` is idempotent,
   * the FSM owns signaling timeouts/retries, and when it gives up the
   * `failed` route clears the slot so the next ping/pong re-enters here.
   *
   * Emission gate (wire-contract.ts): a peer that has not declared
   * `sdp-fsm-screen` never receives an `SdpFsmScreen` signal — releases
   * ≤ v0.14.8 spoke SimplePeer screen share, which this port retires, so
   * those peers simply do not get our share.
   */
  ensureOutgoingScreenShare(pubkeyB64: AgentPubKeyB64): void {
    const screenShareStream = this.bindings.screenShareStream();
    if (!screenShareStream) return;
    if (get(this._screenShareConnectionsOutgoing)[pubkeyB64]) return;
    if (!this.bindings.peerCaps(pubkeyB64).has(CAP_SDP_FSM_SCREEN)) return;

    this.bindings.outTransport().setLocalStream(screenShareStream);
    const connectionId = this.bindings.outTransport().ensureConnection(pubkeyB64, {
      sdpExchangeTimeoutMs: this.bindings.computeSdpTimeout(pubkeyB64),
      epoch: this.bindings.nextConnectionEpoch(pubkeyB64),
    });
    this._screenShareConnectionsOutgoing.update(currentValue => {
      currentValue[pubkeyB64] = {
        connectionId,
        video: true,
        audio: false,
        connected: false,
        direction: 'outgoing',
      };
      return currentValue;
    });
    this.updateScreenShareConnectionStatus(pubkeyB64, { type: 'SdpExchange' });
  }

  disconnectFromPeerScreen(pubKeyB64: AgentPubKeyB64): void {
    if (get(this._screenShareConnectionsIncoming)[pubKeyB64]) {
      this.bindings.inTransport().closeConnection(pubKeyB64, 'disconnectFromPeerScreen');
    }
  }

  updateScreenShareConnectionStatus(
    pubKey: AgentPubKeyB64,
    status: ConnectionStatus
  ): void {
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
   * Handle an SdpFsmScreen signal — feeds the two screen-share FSM
   * transports (Phase 3 item 2).
   *
   * Routing is by the sender's declared role, not by connectionId: each
   * side's FSM allocates its own connectionId, so the id on the wire is
   * the *sender's* and cannot select a local transport. A signal from the
   * peer's sharer side (`dir: 'sharer'`) belongs to our incoming-share
   * transport; a signal from their viewer side answers our outgoing
   * share. Mutual sharing is simply both matches at once on two
   * independent connections.
   *
   * Like the media FSM path, the viewer needs no reservation: the first
   * offer creates the acceptor FSM lazily, and the slot is installed by
   * the `signaling` transition in `subscribe`.
   */
  handleSdpFsmScreen(signal: Extract<RoomSignal, { type: 'Message' }>): void {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    const parsedScreen = parseSignalPayload<{
      connection_id: string;
      peer_session_id?: number;
      epoch?: number;
      dir?: string;
      data: unknown;
    }>(signal.payload);
    if (!parsedScreen.ok) {
      console.warn(
        `Dropped SdpFsmScreen from ${pubkeyB64.slice(0, 8)}: ${parsedScreen.error}`
      );
      return;
    }
    const parsed = parsedScreen.value;
    // The routing rule is `decideScreenSignalRoute`
    // (transport/screen-signal-policy.ts) — by the sender's role, never by
    // connectionId, and drop-not-guess on anything malformed.
    const routed = decideScreenSignalRoute(parsed.dir);
    if (routed.route === 'drop') {
      this.bindings.logger.logCustomMessage(
        `Dropped SdpFsmScreen from ${pubkeyB64.slice(0, 8)}: ${routed.reason} dir=${String(parsed.dir)}`
      );
      return;
    }
    const transport =
      routed.route === 'incoming-share'
        ? this.bindings.inTransport()
        : this.bindings.outTransport();
    const data = parsed.data as { type?: string } | null;
    const sdpType = data && typeof data === 'object' && 'type' in data && data.type
      ? data.type
      : 'candidate';
    transport.processIncomingSignal({
      from: pubkeyB64,
      connectionId: parsed.connection_id,
      peerSessionId: parsed.peer_session_id,
      epoch: parsed.epoch,
      data: parsed.data,
    });
    // Log under the LOCAL connectionId (see handleSdpFsm for why).
    const localConnId = transport.getConnectionId(pubkeyB64) ?? parsed.connection_id;
    this.bindings.logSdpDataEvent(pubkeyB64, localConnId, `screen-fsm-${sdpType}`);
  }
}
