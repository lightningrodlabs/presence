import {
  AgentPubKey,
  AgentPubKeyB64,
  decodeHashFromBase64,
  encodeHashToBase64,
} from '@holochain/client';
import { Clock, systemClock } from './clock';
import {
  computeActiveAgents,
  computePresentPeers,
  decidePresenceSoundEvents,
  decideSignalCarrier,
  INITIAL_PRESENCE_SOUND_STATE,
  isMediaLive,
  lastSeenBucket,
  MEDIA_LIVE_WINDOW_MS,
  OBSERVER_FRESHNESS_MS,
  PING_INTERVAL,
  PRESENCE_LEAVE_DWELL_MS,
  PRESENT_STALENESS_MS,
  type PresenceSoundState,
} from './presence-policy';
import { buildPeerLinkSnapshot, decideAudioLink } from './peer-link-policy';
import { initialPeerRecord, prunePendingInits, resetPeerRecord, type PeerRecord } from './peer-record';
import { FsmTransport } from './transport';
import type { PeerTransport, TransportEvent } from './transport';
import {
  routeTransportPhase,
  decideSlotWrite,
  attributeSlotEvent,
} from './transport/media-event-policy';
import type { SlotAction } from './transport/media-event-policy';
import {
  computeSignalsTargets,
  decideWebrtcEligibility,
} from './transport/carrier-coverage';
import { foldSignalsRtt, statsForPeer } from './transport/carrier-stats-policy';
import {
  decideSignalsMediaCadence,
  SIGNALS_RTT_DEGRADED_MS,
} from './transport/signals-cadence-policy';
import type { SignalsMediaCadence } from './transport/signals-cadence-policy';
import type { PeerStats } from './transport/carrier-stats-policy';
import { decideStaleConnectionCleanup } from './transport/stale-connection-policy';
import { closeCleanupPlan } from './transport/close-cleanup-policy';
import type {
  CloseCleanupContext,
  CloseCleanupOutcome,
  CloseCleanupPlan,
} from './transport/close-cleanup-policy';
import { decideInitRetry } from './transport/init-retry-policy';
import { decideModuleStateMerge } from './module-state-policy';
import { decideScreenSignalRoute } from './transport/screen-signal-policy';
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
  PongMetaData,
  PongMetaDataV1,
  RoomSignal,
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
import {
  CAP_SDP_FSM,
  CAP_SDP_FSM_SCREEN,
  CAP_VOICE_BATCH,
  isSignalMsgType,
} from './transport/wire-contract';
import { RoomStore } from './room/room-store';
import type { StreamsStoreDeps } from './store-deps';
import { PresenceLogger } from './logging';
import { MicSource } from './mic-source';
import { CameraSource } from './camera-source';
import { CaptureReconciler } from './capture-reconciler';
import { PeerAudioLevels } from './peer-audio-levels';
import { MediaSettings } from './media-settings';
import { DiagnosticsHub } from './diagnostics-hub';
import { TrackHealthMonitor } from './track-health';
import { voiceController } from './room/modules/voice';
import { filmstripController } from './room/modules/video-filmstrip';
import { getStreamInfo } from './utils';
import { parseSignalPayload } from './signal-payload';
import { decodeRtcMessage, encodeRtcAction } from './rtc-message-policy';
import type { ActionMessage } from './rtc-message-policy';
import { applyIntentGesture, initialLocalIntent } from './intent';
import type { IntentGesture, LocalIntent } from './intent';
import { describeIntentDiffs } from './intent-diff-policy';
import type { IntentDiff } from './intent-diff-policy';

declare const __APP_VERSION__: string;

/**
 * Timeout in ms for the SDP exchange phase. If a connection does not progress
 * from SdpExchange to Connected within this duration, the stale peer is destroyed
 * and the connection is reset to Disconnected so the next ping/pong cycle can retry.
 * Used as the no-RTT-sample fallback for `_computeSdpTimeout`.
 */
export const SDP_EXCHANGE_TIMEOUT = 15000;

/**
 * Ceiling for the RTT-scaled SDP-exchange timeout (`_computeSdpTimeout`).
 * Serves the SDP-exchange predicate: how long an initiator's own attempt
 * may go unanswered before it is torn down and retried.
 *
 * Field observation (2026-08-11): 8 consecutive SDP timeouts sat at the
 * former 15s ceiling while measured signals RTT was 20-58s. At K=20 that
 * RTT range needs 400-1160s to clear on its own multiplier — the ceiling
 * was always going to bind, so every attempt was pure teardown-and-reflood
 * with no chance to succeed. Raised to 30s so links in the low end of
 * that range get a timeout retrying can actually complete within.
 */
export const SDP_TIMEOUT_CEILING_MS = 30_000;

/** RTT multiplier for the SDP-exchange timeout (`_computeSdpTimeout`). */
export const SDP_TIMEOUT_RTT_MULTIPLIER = 20;

/** Floor for the RTT-scaled SDP-exchange timeout (`_computeSdpTimeout`),
 *  avoiding an over-tight timeout on very low-RTT links. */
export const SDP_TIMEOUT_FLOOR_MS = 5000;

/**
 * Ceiling for the store's tracked SDP-exchange backstop timer
 * (`_computeSdpBackstopTimeout`), NOT the same predicate as
 * `SDP_TIMEOUT_CEILING_MS`. The backstop is second-line cleanup for an
 * FSM that wedges without ever emitting a phase transition — it must
 * always leave the FSM's own per-attempt timeout (`_computeSdpTimeout`,
 * passed as `sdpExchangeTimeoutMs`) and that timeout's own first backoff
 * retry undisturbed, so it is pinned strictly greater than the per-attempt
 * timeout (2x, plus `SDP_BACKSTOP_RETRY_HEADROOM_MS`) rather than sharing
 * its value. Sharing the value was Task 9's original defect (review C1,
 * 2026-08-11): the backstop fired in the same tick as the FSM's own
 * timeout, destroying the FSM's in-place Task-4 recovery retry instead of
 * letting it run. Set to 2x `SDP_TIMEOUT_CEILING_MS` plus the same
 * headroom, so the ceiling itself never re-introduces that preemption at
 * the RTT-scaled per-attempt ceiling (final-review wave F1, 2026-08-13).
 */
export const SDP_BACKSTOP_CEILING_MS = 68_000;

/** Multiplier applied to the per-attempt SDP timeout to get the store's
 *  tracked backstop timeout (`_computeSdpBackstopTimeout`) — kept at 2x
 *  so the backstop can never fire before the FSM's own timeout has had a
 *  chance to run its first in-place retry. */
export const SDP_BACKSTOP_MULTIPLIER = 2;

/**
 * Headroom (ms) added on top of `SDP_BACKSTOP_MULTIPLIER * perAttempt` in
 * `_computeSdpBackstopTimeout`. At exactly 2x the per-attempt timeout, the
 * FSM's own attempt-2 deadline is `2 * perAttempt + retryDelay` (its first
 * in-place backoff retry, not `2 * perAttempt`) — `retryDelay` can run up
 * to `maxDelayMs` (7000) + `jitterMs` (1000) under the reconnect policy's
 * default options (`packages/webrtc-peer/src/reconnect-policy.ts`,
 * `DEFAULT_RECONNECT_OPTIONS`), so a bare 2x backstop could fire 0.3-1.3s
 * before that retry completes (final-review wave F1, 2026-08-13). This
 * headroom covers the full maxDelayMs + jitterMs budget so the backstop
 * never preempts the FSM's first in-place retry.
 */
export const SDP_BACKSTOP_RETRY_HEADROOM_MS = 8_000;

/**
 * How long an established peer may sit in iceConnectionState 'disconnected'
 * before the stale-connection net would tear it down. WebRTC treats
 * 'disconnected' as recoverable: it keeps probing the active candidate pair
 * and may transition back to 'connected' if the path heals (e.g. brief
 * packet loss, NAT mapping that resettles). Tearing down at the first
 * 'disconnected' aborts that recovery and forces a full re-establishment on
 * both sides; with no relay candidate available, the new attempt frequently
 * lands on the same broken path and fails the same way.
 *
 * Input to `decideStaleConnectionCleanup` only. Since Phase 3 every live
 * transport owns its recovery (the FSM runs its own grace of the same
 * duration, ConnectionConfig.iceDisconnectedGraceMs), so the net always
 * stands down before this grace is consulted — it is the declared safety
 * net for a future carrier that does not own recovery, not a second live
 * controller. (This comment previously claimed both graces were needed
 * concurrently; that stopped being true when Phase 1 item 4 made the
 * supervisor stand down for recovery-owning transports.)
 */
const ICE_DISCONNECTED_GRACE_MS = 15000;

/**
 * If an InitRequest does not succeed within this duration (ms) another InitRequest will be sent
 */
const INIT_RETRY_THRESHOLD = 5000;

/**
 * TTL for pending handshake reservations — InitRequests we sent
 * (`PeerRecord.pendingInits`, keyed by `t0`). (`_pendingAccepts` and the
 * screen-share twins were retired in Phase 3: the FSM acceptor creates
 * state lazily from the incoming offer, so nothing needs reserving.)
 * Serves the connection-establishment predicate: an entry older
 * than this belongs to a handshake that will never complete, and only
 * caps state growth — the retry loop is governed by
 * INIT_RETRY_THRESHOLD, which this deliberately exceeds by 4x so a live
 * retry cycle is never truncated. Swept from `pingAgents` on the ping
 * cadence. (Phase 2 item 7: previously only the accepts had this;
 * pendingInits grew unboundedly against an unresponsive peer.)
 */
const PENDING_HANDSHAKE_TTL_MS = 20000;

/**
 * Map a `closed` `decideSlotWrite` result onto the cleanup table's
 * outcome axis. Only the guard outcomes a `closed` event can produce
 * appear here; `install`/`replace`/`set-connected` belong to other event
 * kinds and reaching this with one is a programming error. (The log-only
 * error handlers use `attributeSlotEvent` directly — they perform no
 * slot write and never consult the cleanup table.)
 */
function closeGuardOutcome(
  write: ReturnType<typeof decideSlotWrite>,
): CloseCleanupOutcome {
  if (write.write === 'clear') return 'live';
  if (write.write === 'none' && write.reason === 'superseded') return 'superseded';
  return 'no-slot';
}

/**
 * A store that handles the creation and management of WebRTC streams with
 * holochain peers
 */
export class StreamsStore {
  /**
   * The ambient world, injected (Phase 6 item 1): clock, storage, the
   * signal bus, the transport factory, media devices. `static connect`
   * builds the production record; the wiring tests build fakes. Every
   * ambient read in this class goes through it — a new `window.` /
   * `navigator.` / direct-RoomClient touch outside the declared
   * out-of-scope media paths is a regression against the Phase 6 seam.
   */
  private readonly deps: StreamsStoreDeps;

  /**
   * The single time authority (Phase 2 item 1). Every timing read and
   * timer in this class — and in the controllers bound to it — goes
   * through this clock so tests can drive staleness windows and retry
   * cycles deterministically with a ManualClock. Alias of `deps.clock`
   * (kept as a field because controllers and tests read `store.clock`).
   */
  readonly clock: Clock;

  myPubKeyB64: AgentPubKeyB64;

  private signalUnsubscribe: (() => void) | null = null;

  private pingInterval: number | undefined;

  private allAgents: AgentPubKey[] = [];

  private screenSourceSelection: () => Promise<string>;

  private eventCallback: (ev: StoreEventPayload) => any = () => undefined;

  logger: PresenceLogger;

  _pageLifecycleUnsub: (() => void) | null = null;

  // Set by static connect; releasing it is what lets the room store's
  // lazy allAgents polling deactivate after the room is left.
  _allAgentsUnsub: (() => void) | null = null;

  // ICE/TURN settings, device enumeration/selection, and the storage-backed
  // trickle toggle are owned by MediaSettings (store-decomposition round
  // two, Task 2; see media-settings.ts). Bare-forward delegates below.
  get trickleICE(): boolean {
    return this.mediaSettings.trickleICE;
  }

  get turnUrl(): string {
    return this.mediaSettings.turnUrl;
  }

  get turnUsername(): string {
    return this.mediaSettings.turnUsername;
  }

  get turnCredential(): string {
    return this.mediaSettings.turnCredential;
  }

  get cfTurnUrl(): string {
    return this.mediaSettings.cfTurnUrl;
  }

  get cfTurnUsername(): string {
    return this.mediaSettings.cfTurnUsername;
  }

  get cfTurnCredential(): string {
    return this.mediaSettings.cfTurnCredential;
  }

  blockedAgents: Writable<AgentPubKeyB64[]> = writable([]);

  /**
   * The durable record of what the user last asked for — see intent.ts
   * for the type and the write-discipline invariant it documents.
   * Constructed in the constructor from
   * `initialLocalIntent(this.deps.storage.local)`. Read by the capture
   * reconciler (mic/camera wants), `webrtcGloballyDisabled`, and the
   * per-peer WebRTC eligibility conjunct (Task 4).
   */
  _localIntent: Writable<LocalIntent>;

  get localIntent(): Readable<LocalIntent> {
    return this._localIntent;
  }

  /**
   * The user-facing list of unfulfilled-intent diffs (mic/camera/carrier)
   * — Task 6's ONE source for the toggle-button badges, the tile
   * establishment copy, and the carrier banner. Recomputed by
   * `_recomputeIntentDiffs` INSIDE the presence-tick subscription in
   * `start()`, the same site the capture reconciler and signals-encoder
   * reconcilers fire, so the UI can never show a diff the reconciler is
   * not acting on. The list content is decided by the pure
   * `describeIntentDiffs` (intent-diff-policy.ts); this field is only its
   * cache. Empty until `start()` runs.
   */
  private _intentDiffs: Writable<IntentDiff[]> = writable([]);

  get intentDiffs(): Readable<IntentDiff[]> {
    return this._intentDiffs;
  }

  /**
   * Recompute the intent diffs from the current durable intent, both
   * capture-source lifecycles, both reconciler attempt counts, and the
   * signal-carrier-down stamp. Pure decision in `describeIntentDiffs`;
   * this reads the live inputs and publishes the result. Called once per
   * presence tick from the `_signalsTargets` subscription.
   */
  private _recomputeIntentDiffs(): void {
    this._intentDiffs.set(
      describeIntentDiffs({
        intent: get(this._localIntent),
        micLifecycle: this.micSource.lifecycle,
        micAttempts: this.captureReconciler.micAttemptState.attemptsSinceGesture,
        cameraLifecycle: this.cameraSource.lifecycle,
        cameraAttempts:
          this.captureReconciler.cameraAttemptState.attemptsSinceGesture,
        carrierDownSince: this._signalCarrierDownSince,
        now: this.clock.now(),
      }),
    );
  }

  /**
   * Minimal read for the tile establishment copy (Task 6, surface 2): has
   * this peer had a prior connected session this room-session, i.e. is a
   * fresh WebRTC attempt actually a reconnection? Exposes the boolean the
   * view needs for `describeLinkEstablishment` without handing it the raw
   * `lastDisconnectTime` field.
   */
  peerReconnecting(peerB64: AgentPubKeyB64): boolean {
    return this._peerRecords.get(peerB64)?.lastDisconnectTime !== undefined;
  }

  /**
   * The ONE intent writer (pinned by intent-write-sites.test.ts). Called
   * only from user-gesture entry points — see intent.ts's header for the
   * one documented gesture-equivalent exception.
   */
  private _applyIntent(gesture: IntentGesture): void {
    this._localIntent.update(prev => {
      const next = applyIntentGesture(prev, gesture);
      this.logger.logCustomMessage(`IntentChange: ${gesture.type}`);
      return next;
    });
  }

  /**
   * Global WebRTC kill switch. When true, no WebRTC connections are
   * initiated or accepted for any peer. Audio flows via signals only.
   * Independent of the conversation module's active state — you can
   * still talk (mic on, signals carrier) with WebRTC globally disabled.
   * Persisted in localStorage as 'disableAllWebrtc'.
   *
   * ONE authority: `localIntent.webrtc.enabled` (Task 4). This is a
   * getter, not a field — `setCarrierMode` writes intent via
   * `_applyIntent` and keeps the `disableAllWebrtc` storage write
   * alongside it (`initialLocalIntent` reads that key back at
   * construction), but there is no second place this flips.
   */
  get webrtcGloballyDisabled(): boolean {
    return !get(this._localIntent).webrtc.enabled;
  }

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
   * for the full rationale. Assigned in start().
   */
  micSource!: MicSource;

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
   * cleanly into a generic open/close handler. Assigned in start().
   */
  cameraSource!: CameraSource;

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

  /** The ONE owner of the WebRTC mic/camera acquire handles and their
   *  retry state (Task 3; see capture-reconciler.ts). Assigned in start(). */
  captureReconciler!: CaptureReconciler;

  /** The ONE owner of the per-peer WebRTC AnalyserNode surface (store-
   *  decomposition round two, Task 1; see peer-audio-levels.ts). */
  peerAudioLevels: PeerAudioLevels = new PeerAudioLevels({
    ensureAudioContext: () => this.micSource.ensureAudioContext(),
    peerRecord: k => this._peerRecord(k),
    ensurePeerRecord: k => this._ensurePeerRecord(k),
  });

  /** The ONE owner of device enumeration/selection and the storage-backed
   *  ICE/TURN configuration (store-decomposition round two, Task 2; see
   *  media-settings.ts). Constructed in the constructor body, not as a
   *  field initializer, because its bindings dereference `this.deps`
   *  directly (a live storage/mediaDevices handle, not a late-bound
   *  arrow) — field initializers run before `this.deps = deps` in the
   *  constructor body. */
  mediaSettings!: MediaSettings;

  /** The ONE owner of the diagnostic-log request/response pipeline
   *  (store-decomposition round two, Task 3; see diagnostics-hub.ts).
   *  Constructed in the constructor body, not as a field initializer,
   *  for the same reason as `mediaSettings`: its `sendMessage` binding
   *  dereferences `this.deps.bus` directly. */
  diagnosticsHub!: DiagnosticsHub;

  /** The ONE owner of the dead-track detection/recovery surface
   *  (store-decomposition round two, Task 4; see track-health.ts).
   *  Constructed in the constructor body, not as a field initializer,
   *  for the same reason as `mediaSettings`/`diagnosticsHub`: several of
   *  its bindings dereference `this` state assigned later in the
   *  constructor body (or in `start()`). `_applyStaleTeardown` stays on
   *  the store — it is a shared teardown bridge, not track-health-only. */
  trackHealth!: TrackHealthMonitor;

  /**
   * WebRTC transports. Three instances by purpose:
   *  - mediaTransport: bidirectional mic+camera (one connection per peer).
   *  - screenShareOutTransport: outgoing screen share (we are the sharer).
   *  - screenShareInTransport: incoming screen share (we are the recipient).
   *
   * All three are FSM transports (SimplePeer was retired in Phase 3).
   * Media signals over the 'SdpFsm' Holochain message type; the two
   * screen-share transports signal over 'SdpFsmScreen'. Because the FSM
   * allocates its own connectionId per side, incoming screen signals are
   * routed by the sender's declared role (`dir: 'sharer' | 'viewer'`),
   * not by connectionId — see `handleSdpFsmScreen`.
   */
  // Typed as the interface, not the implementation (Phase 4 item 3 made
  // `PeerTransport` a real annotation): the store can only use the
  // declared transport surface, so an impl-specific reach-in — the
  // escape hatch this codebase spent three phases removing — is a
  // compile error here, not a code-review catch.
  mediaTransport!: PeerTransport;
  screenShareOutTransport!: PeerTransport;
  screenShareInTransport!: PeerTransport;

  constructor(
    deps: StreamsStoreDeps,
    screenSourceSelection: () => Promise<string>,
    logger: PresenceLogger
  ) {
    this.deps = deps;
    this.screenSourceSelection = screenSourceSelection;
    this.logger = logger;
    this.clock = deps.clock;
    this.myPubKeyB64 = encodeHashToBase64(deps.bus.myPubKey);
    this._localIntent = writable(initialLocalIntent(this.deps.storage.local));

    this._activeAgents = derived(
      [this._knownAgents, this.blockedAgents, this._presenceTick] as [
        Writable<Record<AgentPubKeyB64, AgentInfo>>,
        Writable<AgentPubKeyB64[]>,
        Writable<number>,
      ],
      ([knownAgents, blocked, _tick]) =>
        computeActiveAgents({
          knownAgents,
          blocked,
          myPubKey: this.myPubKeyB64,
          now: this.clock.now(),
          stalenessMs: PRESENT_STALENESS_MS,
        }),
    );

    // The **present** predicate: ping-fresh OR media-flowing. THE
    // authority for every join/leave-shaped effect — chimes, tiles, grid
    // counts, phantom exclusion. The controllers' recv maps are not
    // stores, so the _presenceTick dependency is what re-evaluates the
    // media half once per ping cadence.
    this._presentPeers = derived(
      [this._activeAgents, this._openConnections, this._presenceTick] as [
        Readable<Record<AgentPubKeyB64, AgentInfo>>,
        Writable<Record<AgentPubKeyB64, OpenConnectionInfo>>,
        Writable<number>,
      ],
      ([active, connections, _tick]) => {
        // heldPresent is last tick's result, read before this tick
        // overwrites it below — see the field comment on
        // `_lastComputedPresent` for why that staleness is intentional.
        const result = computePresentPeers({
          activeAgents: Object.keys(active),
          openConnections: connections,
          lastVoiceMs: voiceController.peerLastRecvMs,
          lastFilmstripMs: filmstripController.peerLastRecvMs,
          blocked: get(this.blockedAgents),
          myPubKey: this.myPubKeyB64,
          now: this.clock.now(),
          mediaLiveWindowMs: MEDIA_LIVE_WINDOW_MS,
          carrierDownSince: this._signalCarrierDownSince,
          heldPresent: this._lastComputedPresent,
        });
        this._lastComputedPresent = result;
        return result;
      },
    );

    // Signals is the complement of *WebRTC carrying media*, not of *a
    // WebRTC attempt existing*. Decision and rationale live in
    // `transport/carrier-coverage.ts`.
    //
    // Its input is the **present** set, not `_activeAgents`: the invariant
    // is "for every peer that is PRESENT, at least one carrier must be
    // actively transmitting", and since Phase 2 `present` has a real
    // definition that includes media-flowing peers whose pongs have gone
    // stale. Keying on `_activeAgents` was §3.1(b) — such a peer kept a
    // tile and kept being heard while silently dropping out of our send
    // set, i.e. one-way audio.
    //
    // Yes, this is partly self-referential for the signals-only case: we
    // send to them because we hear them. That is intended and bounded —
    // media-only presence decays within MEDIA_LIVE_WINDOW_MS (3s), which
    // is *tighter* than the 6s ping window, so a peer who genuinely stops
    // sending leaves the set faster than ping staleness would remove them.
    // The alternative (ping-fresh only) makes the carrier that is
    // demonstrably working the one we refuse to use.
    this._signalsTargets = derived(
      [this._presentPeers, this._openConnections],
      ([present, connections]) =>
        computeSignalsTargets({
          presentPeers: present,
          openConnections: connections,
        }),
    );
    this.mediaSettings = new MediaSettings({
      storage: this.deps.storage.local,
      mediaDevices: this.deps.mediaDevices,
      changeMicDevice: id => this.micSource.changeDevice(id),
      changeCameraDevice: id => this.cameraSource.changeDevice(id),
      broadcastRtcAction: a => this._broadcastRtcAction(a),
      logAgentEvent: e => this.logger.logAgentEvent(e),
      now: () => this.clock.now(),
      myPubKeyB64: () => this.myPubKeyB64,
    });
    this.diagnosticsHub = new DiagnosticsHub({
      sendMessage: (agents, msgType, payload) =>
        this.deps.bus.sendMessage(agents, msgType, payload),
      logger: this.logger,
      now: () => this.clock.now(),
      setTimeout: (fn, ms) => this.clock.setTimeout(fn, ms),
      myPubKeyB64: () => this.myPubKeyB64,
      globalPresenceSet: () => this.globalPresenceSet(),
      peerRttEwma: k => this._peerRecord(k)?.signalsRttEwma,
    });
    this.trackHealth = new TrackHealthMonitor({
      mediaTransport: () => this.mediaTransport,
      openConnections: () => get(this._openConnections),
      sendRtcAction: (message, peers) => this._sendRtcAction(message, peers),
      maybeEmitQualityChange: (pubKeyB64, carrier, rttMs, jitterMs, lossPercent) =>
        this._maybeEmitQualityChange(pubKeyB64, carrier, rttMs, jitterMs, lossPercent),
      peerRecord: k => this._peerRecord(k),
      ensurePeerRecord: k => this._ensurePeerRecord(k),
      micLifecycle: () => this.micSource.lifecycle,
      cameraLifecycle: () => this.cameraSource.lifecycle,
      mainStream: () => this.mainStream,
      webrtcStats: this.webrtcStats,
      logger: this.logger,
      now: () => this.clock.now(),
    });

    // Construction ends here: fields and derived stores only, no
    // subscriptions, no transports, no browser APIs. Everything that
    // touches the ambient world (window, navigator, the signal bus, the
    // module singletons) happens in start(), so a test can hold an
    // inactive instance in a node environment. `static connect` is the
    // one production caller of both.
  }

  /**
   * Activate the store: subscribe to Holochain signals, construct the
   * WebRTC transports, register device listeners, create the mic/camera
   * sources and bind the module controllers. Constructing joins nothing;
   * starting joins the room's signal fabric. Idempotence is NOT provided —
   * call exactly once, then disconnect() to tear down.
   */
  start(): void {
    this.signalUnsubscribe = this.deps.bus.onSignal(async signal =>
      this.handleSignal(signal)
    );

    // Drive the presence tick from the store clock so _activeAgents
    // re-evaluates staleness once per ping cadence even when no store
    // write happens (Phase 2 item 4). _emitPresenceForensics() runs
    // FIRST, in the same breath, so _signalCarrierDownSince is current
    // before the tick bump triggers _presentPeers' recompute: carrier-
    // down (SIGNAL_CARRIER_DOWN_MS) and a lone surviving peer's own
    // ping-staleness (PRESENT_STALENESS_MS) are the same 3-tick window
    // by design, so they cross on the SAME tick, and pingAgents() (the
    // only other _emitPresenceForensics call site) is not guaranteed to
    // run before this interval fires — without this, the carrier-hold
    // (Task 8) reads a stale `undefined` on exactly the tick it needs
    // to catch, and _lastComputedPresent gets wiped before the hold can
    // apply. decideSignalCarrier's stickiness makes calling this from
    // both sites idempotent: whichever call notices the transition
    // first logs it, the other sees it already applied and no-ops.
    // pingAgents() has the matching guard internally (forensics runs
    // before ITS OWN `_knownAgents.set()` write, review C1) — the two
    // fixes are independent because either evaluator can be the first
    // to observe a given crossing.
    this._presenceTickInterval = this.clock.setInterval(
      () => {
        this._emitPresenceForensics();
        this._presenceTick.update(n => n + 1);
      },
      PING_INTERVAL
    );

    const blockedAgentsJson = this.deps.storage.session.getItem('blockedAgents');
    this.blockedAgents.set(
      blockedAgentsJson ? JSON.parse(blockedAgentsJson) : []
    );
    // trickleICE / turnUrl / turnUsername / turnCredential are read live from
    // storage.local via getters, so there is nothing to snapshot here.
    // webrtcGloballyDisabled used to be re-read from 'disableAllWebrtc'
    // here; it is now a getter over `_localIntent`, which the constructor
    // already seeded from the same storage key via `initialLocalIntent`.
    const signalDelay = this.deps.storage.local.getItem('signalDelayMs');
    if (signalDelay) {
      this.signalDelayMs = parseInt(signalDelay, 10) || 0;
    }

    // Construct transports. iceServers / trickleICE are getters so the
    // transport always uses the current values (TURN credentials, trickle
    // toggle, etc. can change at runtime).

    // Screen-share FSM transports (Phase 3 item 2). One outgoing (we are
    // the sharer) and one incoming (we are the viewer); mutual sharing is
    // two independent connections, one per transport pair. Signals travel
    // as 'SdpFsmScreen' tagged with the sender's role so the receiver can
    // route to the complementary transport — connectionId cannot do that
    // job here because each side's FSM allocates its own id.
    const screenShareTransport = (dir: 'sharer' | 'viewer') =>
      this.deps.transportFactory(
        dir === 'sharer' ? 'screen-share-out' : 'screen-share-in',
        {
          myAgentId: this.myPubKeyB64,
          iceServers: () => this.iceConfig,
          trickleICE: () => this.trickleICE,
          iceTransportPolicy: () => this._readIceTransportPolicy(),
          configOverrides: {
            dtlsStallTimeoutMs: this._readDtlsStallTimeoutMs(),
          },
          onOutgoingSignal: (signal) => {
            const toAgent = decodeHashFromBase64(signal.to);
            this.deps.bus.sendMessage(
              [toAgent],
              'SdpFsmScreen',
              JSON.stringify({
                connection_id: signal.connectionId,
                peer_session_id: signal.peerSessionId,
                epoch: signal.epoch,
                dir,
                data: signal.data,
              }),
            );
          },
          onTransition: (entry) => this._logFsmTransition(entry),
        },
      );
    this.screenShareOutTransport = screenShareTransport('sharer');
    this.screenShareInTransport = screenShareTransport('viewer');

    // Media FSM transport. Outgoing signals carry an FSM-shaped envelope
    // (type/payload) wrapped on the wire as 'SdpFsm'; incoming 'SdpFsm'
    // signals route here via handleSdpFsm.
    this.mediaTransport = this.deps.transportFactory('media', {
      myAgentId: this.myPubKeyB64,
      iceServers: () => this.iceConfig,
      trickleICE: () => this.trickleICE,
      iceTransportPolicy: () => this._readIceTransportPolicy(),
      // The DTLS watchdog's default 5s is too aggressive on lossy / high-RTT
      // last-mile uplinks (a handshake there can need several seconds of
      // retransmits); a single stall tore the connection down to the lossy
      // signals carrier and churned reconnects. Raise to a viable default,
      // user-overridable via storage.local('dtlsStallTimeoutMs'). NOTE:
      // snapshotted here at transport construction, unlike the live
      // iceServers/trickleICE closures — the wiring tests pin this
      // distinction.
      configOverrides: {
        dtlsStallTimeoutMs: this._readDtlsStallTimeoutMs(),
      },
      onOutgoingSignal: (signal) => {
        const toAgent = decodeHashFromBase64(signal.to);
        this.deps.bus.sendMessage(
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
    this._subscribeScreenShareTransport(this.screenShareOutTransport, true);
    this._subscribeScreenShareTransport(this.screenShareInTransport, false);

    this.deps.mediaDevices.ondevicechange = e => {
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
      // Nothing consumes mic lifecycle yet — Task 3's reconciler reads
      // `micSource.lifecycle` directly on the presence tick rather than
      // subscribing here. Wire this if a push-driven consumer arrives.
      onLifecycleChange: () => {},
      now: () => this.clock.now(),
    });

    this.cameraSource = new CameraSource({
      getDeviceId: () => get(this._videoInputId),
      setDeviceId: id => this._videoInputId.set(id),
      onTrackChange: (newTrack, oldTrack) => {
        this._onCameraTrackChange(newTrack, oldTrack);
      },
      // See MicSource's onLifecycleChange comment above.
      onLifecycleChange: () => {},
      now: () => this.clock.now(),
    });

    // Polls the sources' lifecycle on the tick (onLifecycleChange stays a
    // no-op above); acquire/reopen/release live here, not in the store.
    this.captureReconciler = new CaptureReconciler({
      clock: this.clock,
      getIntent: () => get(this._localIntent),
      mic: this.micSource,
      camera: this.cameraSource,
      onError: message => this.eventCallback({ type: 'error', error: message }),
      log: message => this.logger.logCustomMessage(message),
      onCameraAcquired: () => this._attachCameraToPeers(),
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
    // fires on every _activeAgents or _openConnections change — which
    // includes once per presence tick, because the derived chain rebuilds
    // its objects each recompute; the reconcilers are cheap (a boolean
    // check + set size). That per-tick firing is load-bearing: it is the
    // encoder-start RETRY cadence after a failed startCapture (the
    // reconcilers reset the running flag on failure and this subscription
    // re-invokes them within PING_INTERVAL). Pinned by the encoder-retry
    // wiring tests — if store notification semantics ever get memoized,
    // those tests go red and the retry needs an explicit home.
    this._signalsTargetsUnsub = this._signalsTargets.subscribe(() => {
      // Two-site invariant (final-review re-review N1): the target set can
      // grow SYNCHRONOUSLY off this subscription — a peer's first pong adds
      // it to _activeAgents/_presentPeers/_signalsTargets before the next
      // presence tick. If `_voiceBatchCapAllTargets` were left stale-true
      // from last tick, voice would broadcast a v2 batch to a peer who
      // never declared the cap: every released build's decoder does a bare
      // JSON.parse there, so an uncapped peer throws (seq undefined) on
      // every payload until the next tick recomputed the boolean. The
      // per-tick evaluation in pingAgents() stays — it is what catches a
      // cap arriving (via ModuleState) for an ALREADY-present target, whose
      // unsafe direction (stale-false, not stale-true) never breaks a
      // decoder — but a target-set GROW must recompute here too, so the
      // boolean is never stale-true across it.
      this._voiceBatchCapAllTargets = this.signalsTargetsAllHaveCap(CAP_VOICE_BATCH);
      // Load-bearing per-tick cadence: the correctness backstop that
      // reopens a device whose ended/failed edge was missed. Pinned by the
      // capture-reconciler wiring tests (mutation-check ii).
      this.captureReconciler.tick().catch(() => {});
      this._reconcileSignalsAudio();
      this._reconcileSignalsVideo();
      // Task 6: recompute the user-facing intent diffs at the SAME tick
      // the reconcilers act on, so a surfaced diff always tracks a
      // reconciliation attempt in flight (never a stale phantom warning).
      this._recomputeIntentDiffs();
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
   * slot-write policy. Two callers: the transport event glue
   * (`_dispatchMediaEvent`) and the initiator path (`handleInitAccept`,
   * which used to hand-write `_openConnections` around the policy — §9
   * item 5). `path` tags the Superseded forensic with which caller
   * adopted.
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
      this.logger.logAgentEvent({
        agent: peer,
        timestamp: this.clock.now(),
        event: 'Superseded',
        connectionId: slotAction.supersedes,
        detail: `superseded-by=${connectionId}; path=${path}`,
      });
      this._clearIceTiming(peer, slotAction.supersedes);
      // Keyed to the old connection; the new connection's
      // ice-diagnostic events set their own.
      { const r = this._peerRecords.get(peer); if (r) r.iceDisconnectedAt = undefined; }
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
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.clock.now(),
      event: 'FsmEstablishmentTimeline',
      connectionId,
      detail:
        `ice=${timeline.iceMs ?? -1} dtls=${timeline.dtlsMs ?? -1} ` +
        `connected=${timeline.connectedMs} dc=${timeline.dataChannelMs ?? -1} ` +
        `reconnect=${timeline.wasReconnect} session=${timeline.peerSessionId}`,
    });
  }

  /**
   * Whether WebRTC can be attempted with `peerB64` at all: their build
   * must declare (or, for pre-caps builds, be inferred to hold) the
   * `sdp-fsm` capability — the wire-contract emission rule for `SdpFsm`.
   *
   * This is what remains of `webrtcImplFor`/`resolveWebrtcImpl` after
   * Phase 3 deleted SimplePeer: with one implementation there is no
   * preference to resolve, only capability. A peer without the cap gets
   * signals as their carrier, full stop.
   */
  webrtcAvailableFor(peerB64: AgentPubKeyB64): boolean {
    return this._peerCaps(peerB64).has(CAP_SDP_FSM);
  }

  /** The one media transport (fan-out helper retained where operations
   *  are broadcast-shaped: setLocalStream, add/remove/replaceTrack). */
  private _allMediaTransports(): Array<PeerTransport> {
    return [this.mediaTransport];
  }

  private _subscribeScreenShareTransport(
    transport: PeerTransport,
    initiator: boolean,
  ): void {
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
                  this.logger.logAgentEvent({
                    agent: event.peer,
                    timestamp: this.clock.now(),
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

  // --- media transport event handlers ---

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
      this._iceTimings[key] = { t0: this.clock.now(), impl: 'fsm' };
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
    diag: import('./transport').IceDiagnostic,
  ): void {
    const key = `${pubKeyB64}:${connectionId}`;
    switch (diag.kind) {
      case 'ice-state': {
        const state = diag.state;
        this.logger.logCustomMessage(
          `ICE [${pubKeyB64.slice(0, 8)}]: ${state} connId=${connectionId.slice(0, 8)}`
        );
        // First entry to 'connected' (or 'completed') marks the ICE-only
        // milestone — DTLS may still be in flight. Record once; later
        // disconnect/recover cycles must not overwrite the initial timing.
        const t = this._iceTimings[key];
        if (t && t.tIceConnected === undefined && (state === 'connected' || state === 'completed')) {
          t.tIceConnected = this.clock.now();
        }
        if (t) t.finalIceState = state;
        // Maintain the invariant: an entry exists iff iceState is
        // currently 'disconnected'. The stale-connection net uses a grace
        // period before treating 'disconnected' as terminal.
        if (state === 'disconnected') {
          this._ensurePeerRecord(pubKeyB64).iceDisconnectedAt = this.clock.now();
        } else {
          { const r = this._peerRecords.get(pubKeyB64); if (r) r.iceDisconnectedAt = undefined; }
        }
        if (diag.selectedPair) {
          const { local, remote } = diag.selectedPair;
          this.logger.logCustomMessage(
            `ICE failed pair [${pubKeyB64.slice(0, 8)}]: local=${local?.address}:${local?.port} (${local?.type}) remote=${remote?.address}:${remote?.port} (${remote?.type})`
          );
        }
        break;
      }
      case 'gathering-state': {
        this.logger.logCustomMessage(
          `ICE gathering [${pubKeyB64.slice(0, 8)}]: ${diag.state}`
        );
        if (diag.state === 'complete') {
          const hasRelay = diag.localSdpHasRelay ?? false;
          this.logger.logCustomMessage(
            `ICE candidates summary [${pubKeyB64.slice(0, 8)}]: relay=${hasRelay}`
          );
          // Stamp gather-complete timing on first transition; the SDP
          // can re-gather on ICE restart but the establishment-latency
          // metric refers to the initial gather only.
          const t = this._iceTimings[key];
          if (t && t.tGatherComplete === undefined) {
            t.tGatherComplete = this.clock.now();
            t.relay = hasRelay;
          }
        }
        break;
      }
      case 'candidate': {
        this.logger.logCustomMessage(
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
    const now = this.clock.now();
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
    const now = this.clock.now();
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
   * `ice-diagnostic` bookkeeping for the outgoing screen-share transport:
   * maintains the invariant on `screenShareIceDisconnectedAt` — an entry
   * exists iff the share's iceState is currently 'disconnected' — which
   * the stale-connection net reads for its grace window. No log lines:
   * the media transport is the forensic subject; the share only needs
   * the timestamps.
   */
  private _handleScreenShareIceDiagnostic(
    pubKeyB64: AgentPubKeyB64,
    diag: import('./transport').IceDiagnostic,
  ): void {
    if (diag.kind !== 'ice-state') return;
    if (diag.state === 'disconnected') {
      this._ensurePeerRecord(pubKeyB64).screenShareIceDisconnectedAt = this.clock.now();
    } else {
      { const r = this._peerRecords.get(pubKeyB64); if (r) r.screenShareIceDisconnectedAt = undefined; }
    }
  }

  /** DTLS-stall watchdog timeout (ms) for the FSM transport. Defaults to a
   *  link-tolerant 12s; override via localStorage('dtlsStallTimeoutMs').
   *  Floored at 1s to avoid an unusably twitchy watchdog. */
  private _readDtlsStallTimeoutMs(): number {
    const DEFAULT_MS = 12_000;
    try {
      const raw = this.deps.storage.local.getItem('dtlsStallTimeoutMs');
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
      const raw = this.deps.storage.local.getItem('iceTransportPolicy');
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
      const raw = this.deps.storage.local.getItem('videoMaxBitrateKbps');
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
    const outcomes = await this.mediaTransport.prioritizeAudio(peerB64, {
      videoMaxBitrateBps: this._videoMaxBitrate(),
    });
    if (outcomes.length === 0) return;
    const report = outcomes.map(o => {
      if ('failed' in o) return `${o.kind}:setParameters-failed`;
      let s = `${o.kind}:want=${o.want} priority=${o.priority} netPriority=${o.networkPriority}${o.applied ? '' : ' NOT-APPLIED'}`;
      if (o.kind === 'video') s += ` maxBitrate=${o.maxBitrate ?? 'unset'}`;
      return s;
    });
    this.logger.logAgentEvent({
      agent: peerB64,
      timestamp: this.clock.now(),
      event: 'SenderParams',
      detail: report.join(' | '),
    });
  }

  private _handleMediaConnected(
    pubKeyB64: AgentPubKeyB64,
    connectionId: string,
  ): void {
    const transport = this.mediaTransport;
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
        this.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: this.clock.now(),
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
    this.diagnosticsHub.noteConversationParticipant(pubKeyB64);
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.clock.now(),
      event: 'Connected',
      connectionId,
    });
    this._emitIceEstablishment(pubKeyB64, connectionId);
    // Audio carrier flipped from signals → webrtc (impl-specific) for this peer.
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.clock.now(),
      event: 'CarrierSwitch',
      connectionId,
      detail: 'signals->webrtc',
    });
    { const r = this._peerRecords.get(pubKeyB64); if (r) r.qualityBucket = undefined; }

    { const r = this._peerRecords.get(pubKeyB64); if (r) r.pendingInits = undefined; }

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
    void this._applySenderPriorities(pubKeyB64);

    this.updateConnectionStatus(pubKeyB64, { type: 'Connected' });
    this.eventCallback({
      type: 'peer-connected',
      pubKeyB64,
      connectionId,
    });

    // After ICE settles, sample the selected candidate pair to detect
    // relay (TURN) usage so the UI can flag it.
    this.clock.setTimeout(async () => {
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
   * close row first (see the policy header).
   */
  private _applyCloseCleanup(
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
          ? this._screenShareConnectionsOutgoing
          : this._screenShareConnectionsIncoming;
    const transport =
      ctx.target === 'media'
        ? this.mediaTransport
        : ctx.target === 'screen-share-outgoing'
          ? this.screenShareOutTransport
          : this.screenShareInTransport;

    const wasWebrtcCarrier = !!get(slotStore)[pubKeyB64]?.connected;

    if (plan.closeTransport === 'before-slot-clear') {
      transport.closeConnection(pubKeyB64, closeReason);
    }

    if (plan.emitCarrierSwitch && wasWebrtcCarrier) {
      // Annotate the downgrade with *why* we left webrtc (§6.6) — the
      // reason the FSM took this peer out of `connected`, captured in
      // `_logFsmTransition`. Falls back to 'unknown' if the root reason
      // wasn't seen.
      const reason = this._peerRecords.get(pubKeyB64)?.webrtcExitReason ?? 'unknown';
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.clock.now(),
        event: 'CarrierSwitch',
        connectionId,
        detail: `webrtc->signals reason="${reason}"`,
      });
    }
    if (plan.recordLastDisconnect) {
      this._ensurePeerRecord(pubKeyB64).lastDisconnectTime = this.clock.now();
    }
    // recordReset runs AFTER recordLastDisconnect on purpose: on the
    // peer-leave/live path the nested close-event row (via the
    // synchronous `closed` from closeTransport above) has already
    // stamped the cooldown, and the leave row's `media-leave-residue`
    // reset then wipes it — the delete wins (§9 item 5).
    if (plan.recordReset !== 'none') {
      const r = this._peerRecords.get(pubKeyB64);
      if (r) this._peerRecords.set(pubKeyB64, resetPeerRecord(r, plan.recordReset));
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
      this._othersConnectionStatuses.update(statuses => {
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
    if (plan.clearWebrtcStats) this.webrtcStats.delete(pubKeyB64);

    if (plan.teardownOutgoingScreenShare) {
      // Tear down any outgoing screen share to this peer since they
      // have disconnected. Without this, a stale connection may linger
      // and block re-initiation when the peer rejoins.
      const outgoingScreenShare = get(this._screenShareConnectionsOutgoing)[pubKeyB64];
      if (outgoingScreenShare) {
        this.screenShareOutTransport.closeConnection(
          pubKeyB64,
          'media peer closed',
        );
        this._screenShareConnectionsOutgoing.update(currentValue => {
          delete currentValue[pubKeyB64];
          return currentValue;
        });
      }
    }

    if (plan.setDisconnectedStatus === 'media') {
      this.updateConnectionStatus(pubKeyB64, { type: 'Disconnected' });
    } else if (plan.setDisconnectedStatus === 'screen-share') {
      this.updateScreenShareConnectionStatus(pubKeyB64, { type: 'Disconnected' });
    }
    if (plan.fireEvent === 'peer-disconnected') {
      this.eventCallback({
        type: 'peer-disconnected',
        pubKeyB64,
        connectionId,
      });
    } else if (plan.fireEvent === 'peer-screen-share-disconnected') {
      this.eventCallback({
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
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.clock.now(),
        event: 'SupersededClose',
        connectionId,
        detail: `superseded-by=${slotWrite.supersededBy}`,
      });
    }

    if (ctx.outcome === 'live') {
      // Flush any in-flight SdpData bursts for this connection so the
      // summary lands before the close event in the timeline.
      this._flushSdpAggregatesForConnection(connectionId);
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.clock.now(),
        event: 'FsmClose',
        connectionId,
        detail: `cause=${cause}`,
      });
    }

    this._applyCloseCleanup(ctx, plan, pubKeyB64, connectionId, 'close event');
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
      timestamp: this.clock.now(),
      event: 'StreamReceived',
      connectionId,
    });
    this._ensurePeerRecord(pubKeyB64).videoStream = stream;

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
    this.peerAudioLevels.setupPeerAudioAnalyser(pubKeyB64, stream);
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
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.clock.now(),
      event: 'RemoteTrack',
      connectionId,
    });

    // Ensure the audio analyser is wired up for this peer. The 'remote-stream'
    // event is deduped per stream.id in the underlying RTCPeer, so a stream
    // whose first track was video (analyser-setup early-returns on no audio)
    // never gets a second pass when the audio track arrives later. Hook it
    // here as well: idempotent if the analyser already exists.
    if (track.kind === 'audio' && stream && !this._peerRecords.get(pubKeyB64)?.analyser) {
      this.peerAudioLevels.setupPeerAudioAnalyser(pubKeyB64, stream);
    }

    if (!track.muted) {
      this._setTrackReady(pubKeyB64, connectionId, track);
      return;
    }

    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.clock.now(),
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

    const unmuteTimeout = this.clock.setTimeout(() => {
      if (track.muted) {
        this.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: this.clock.now(),
          event: 'TrackUnmuteTimeout',
        });
        this._setTrackReady(pubKeyB64, connectionId, track);
      }
    }, 5000);

    track.onunmute = () => {
      this.clock.clearTimeout(unmuteTimeout);
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.clock.now(),
        event: 'TrackUnmuted',
      });
      this._setTrackReady(pubKeyB64, connectionId, track);
    };
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
          this.logger.logAgentEvent({
            agent: pubKeyB64,
            timestamp: this.clock.now(),
            event: action.event,
          });
          break;
        }
        case 'log-input-change': {
          this.logger.logAgentEvent({
            agent: pubKeyB64,
            timestamp: this.clock.now(),
            event: action.event,
          });
          break;
        }
        case 'refresh-tracks': {
          this.logger.logCustomMessage(
            `request-track-refresh received from [${pubKeyB64.slice(0, 8)}]`
          );
          this.trackHealth.refreshTracksForPeer(pubKeyB64);
          break;
        }
        case 'ignore':
          // `not-action` frames (text, primitives) stay silent — they are
          // not this handler's traffic. An unknown *action* message is
          // worth a trace: it usually means the peer runs a newer build.
          if (action.reason === 'unknown-action') {
            this.logger.logCustomMessage(
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
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.clock.now(),
        event: 'SupersededError',
        connectionId,
        detail: `superseded-by=${attribution.supersededBy}; err=${error.message || error}`,
      });
      return;
    }
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.clock.now(),
      event: 'FsmError',
      connectionId,
      detail: `${error.message || String(error)}; slot=${attribution.outcome}`,
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
    this._applyCloseCleanup(
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
    this._ensurePeerRecord(pubKeyB64).screenShareStream = stream;
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
    this.logger.logCustomMessage(
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
      this.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.clock.now(),
        event: 'SupersededError',
        connectionId,
        detail: `superseded-by=${attribution.supersededBy}; err=${error.message || error}; path=screen`,
      });
      return;
    }
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.clock.now(),
      event: 'FsmError',
      connectionId,
      detail: `${error.message || String(error)}; path=screen; slot=${attribution.outcome}`,
    });
  }

  /**
   * The ONE send-side seam for RTCMessage action frames (§9 item 6);
   * the decode side is `decodeRtcMessage` and the wire shape is
   * `encodeRtcAction`, both in rtc-message-policy.ts. Six verbatim
   * broadcast loops, the pong-side conditional audio-off, and the
   * track-refresh request all send through here — future per-peer send
   * policy (rate limits, capability gating) goes in this method,
   * nowhere else. A per-peer send failure is logged (console.warn —
   * the alternating error/warn catches are unified, console output
   * only) and does not stop the remaining sends.
   *
   * Returns the number of sends that did not throw — the track-refresh
   * caller couples its stale-count reset to that.
   */
  private _sendRtcAction(
    message: ActionMessage,
    peers: AgentPubKeyB64[],
  ): number {
    const encoded = encodeRtcAction(message);
    let sent = 0;
    for (const peerB64 of peers) {
      try {
        this.mediaTransport.send(peerB64, encoded);
        sent += 1;
      } catch (e) {
        console.warn(`Could not send '${message}' message to peer: `, e);
      }
    }
    return sent;
  }

  /** `_sendRtcAction` to every peer with an open media connection. */
  private _broadcastRtcAction(message: ActionMessage): number {
    return this._sendRtcAction(
      message,
      Object.keys(get(this._openConnections)),
    );
  }

  /**
   * Start or stop the voice encoder based on whether the mic is held AND
   * at least one peer needs audio via signals. Called from the
   * _signalsTargets subscription and from audioOn/audioOff.
   */
  private _reconcileSignalsAudio(): void {
    // Gate on INTENT, not a held-handle observation (Task 3 replacement #3
    // — the conflation this round kills). Mutation-check (i) / test (b').
    const micWanted = get(this._localIntent).mic.wanted;
    const hasTargets = get(this._signalsTargets).size > 0;
    const shouldRun = micWanted && hasTargets;

    if (shouldRun && !this._voiceEncoderRunning) {
      // Only start the encoder (send side). The controller is already
      // bound to the store at construction time so the receive side works
      // regardless.
      //
      // Failure (resolved false OR rejection) resets the flag so the next
      // reconcile retries. The retry cadence is the presence tick: the
      // `_signalsTargets` subscription in start() fires once per tick
      // whenever this store is live, so a failed start is re-attempted
      // within PING_INTERVAL — pinned by the encoder-retry wiring tests.
      // Without the rejection arm the flag wedged true forever and signals
      // audio stayed off until the mic/target gate cycled (§9 item 2).
      voiceController.startCapture().then(
        ok => {
          if (!ok) {
            this._voiceEncoderRunning = false;
            console.warn('Voice encoder failed to start');
          }
        },
        e => {
          this._voiceEncoderRunning = false;
          console.warn('Voice encoder failed to start', e);
        }
      );
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
   */
  private _reconcileSignalsVideo(): void {
    // Gate on INTENT (Task 3 replacement #3): set by the video-on/off
    // gesture, so the filmstrip's own camera acquire can't hold the gate
    // true — retiring the consumer-count cycle the old gate dodged.
    const cameraWanted = get(this._localIntent).camera.wanted;
    const hasTargets = get(this._signalsTargets).size > 0;
    const shouldRun = cameraWanted && hasTargets;

    if (shouldRun && !this._filmstripEncoderRunning) {
      // Failure handling mirrors `_reconcileSignalsAudio`: both failure
      // shapes reset the flag; the presence-tick-driven `_signalsTargets`
      // subscription retries within PING_INTERVAL (pinned by the
      // encoder-retry wiring tests).
      filmstripController.startCapture().then(
        ok => {
          if (!ok) {
            this._filmstripEncoderRunning = false;
            console.warn('Filmstrip encoder failed to start');
          }
        },
        e => {
          this._filmstripEncoderRunning = false;
          console.warn('Filmstrip encoder failed to start', e);
        }
      );
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
    // The production deps record — the ONE place the ambient world is
    // bound to the store. It reproduces the pre-Phase-6 ambient reads
    // exactly: storage getters stay live reads (the record holds the
    // Storage objects, not snapshots), the bus adapts RoomClient, and
    // the factory yields FsmTransport for all three purposes.
    const roomClient = roomStore.client;
    const deps: StreamsStoreDeps = {
      clock: systemClock,
      storage: {
        local: window.localStorage,
        session: window.sessionStorage,
      },
      bus: {
        myPubKey: roomClient.client.myPubKey,
        onSignal: handler => roomClient.onSignal(handler),
        sendMessage: (toAgents, msgType, payload) =>
          roomClient.sendMessage(toAgents, msgType, payload),
      },
      transportFactory: (_purpose, options) => new FsmTransport(options),
      mediaDevices: navigator.mediaDevices,
    };
    const streamsStore = new StreamsStore(
      deps,
      screenSourceSelection,
      logger
    );
    streamsStore.start();

    // One subscription serves both jobs: gate the first ping on the initial
    // load, then keep feeding updates. (Two parallel subscriptions lived here
    // once — the load-gate one was never released, so both wrote allAgents
    // for the life of the store and the lazy store could never deactivate.)
    let resolveInitialLoad: (() => void) | undefined;
    const initialLoad = new Promise<void>(resolve => {
      resolveInitialLoad = resolve;
    });
    streamsStore._allAgentsUnsub = roomStore.allAgents.subscribe(val => {
      if (val.status === 'complete') {
        streamsStore.allAgents = val.value;
        resolveInitialLoad?.();
      } else if (val.status === 'error') {
        console.error('Failed to get all agents: ', val.error);
        resolveInitialLoad?.(); // Don't block forever on error
      }
    });
    // Wait for allAgents to load before first ping so we actually have peers to contact
    await initialLoad;

    // ping all agents that are not already connected to you every PING_INTERVAL milliseconds
    await streamsStore.pingAgents();
    streamsStore.pingInterval = streamsStore.clock.setInterval(() => {
      streamsStore.pingAgents().catch(e => {
        console.error('pingAgents failed:', e);
      });
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

    streamsStore.clock.setTimeout(async () => {
      const mediaDevices = await deps.mediaDevices.enumerateDevices();
      streamsStore.mediaDevices.set(mediaDevices);
    }, 0);
    return streamsStore;
  }

  disconnect(reason: string = 'unknown') {
    this._applyIntent({ type: 'session-end' });
    // Forensics: capture WHO called disconnect (button vs. Lit lifecycle
    // unmount) so we can tell user-initiated leaves from DOM-remount leaves.
    // Stack is best-effort — useful when reason='unknown' to find a new caller.
    const stack = new Error().stack?.split('\n').slice(1, 4).join(' | ') ?? '';
    // `document` is guarded so disconnect() stays executable in node —
    // the wiring tests exercise start()/disconnect() symmetry there.
    const visibility =
      typeof document !== 'undefined' ? document.visibilityState : 'no-dom';
    this.logger.logCustomMessage(
      `Disconnect reason=${reason} visibility=${visibility} ${stack}`
    );

    // Notify peers immediately before tearing down
    const agentsToNotify = Object.keys(get(this._knownAgents))
      .filter(a => a !== this.myPubKeyB64)
      .map(b64 => decodeHashFromBase64(b64));
    if (agentsToNotify.length > 0) {
      this.deps.bus.sendMessage(agentsToNotify, 'LeaveUi').catch(() => {});
    }

    if (this.pingInterval) this.clock.clearInterval(this.pingInterval);
    if (this._presenceTickInterval !== undefined) {
      this.clock.clearInterval(this._presenceTickInterval);
      this._presenceTickInterval = undefined;
    }
    for (const r of this._peerRecords.values()) {
      if (r.sdpTimeoutTimer !== undefined) this.clock.clearTimeout(r.sdpTimeoutTimer);
      r.sdpTimeoutTimer = undefined;
      r.screenShareStream = undefined;
      r.pendingInits = undefined;
    }
    if (this.signalUnsubscribe) this.signalUnsubscribe();
    if (this._pageLifecycleUnsub) {
      this._pageLifecycleUnsub();
      this._pageLifecycleUnsub = null;
    }
    if (this._allAgentsUnsub) {
      this._allAgentsUnsub();
      this._allAgentsUnsub = null;
    }
    // Close all connections and stop all streams. (A duplicated
    // `mediaTransport.destroy()` line lived here until Phase 6's
    // symmetry test asserted destroy-exactly-once per transport;
    // destroy() is idempotent, so the duplicate was harmless noise.)
    this.mediaTransport.destroy();
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
    if (this._presentPeersUnsub) {
      this._presentPeersUnsub();
      this._presentPeersUnsub = null;
    }
    // Release both WebRTC acquire handles (Task 3: reconciler-owned;
    // releaseAll is disconnect-only cleanup), then force-close the sources.
    this.captureReconciler.releaseAll();
    this.micSource.dispose();
    this.cameraSource.dispose();
    this.screenShareOff();
    this.mainStream = null;
    this.screenShareStream = null;
    this._openConnections.set({});
    this._screenShareConnectionsOutgoing.set({});
    this._screenShareConnectionsIncoming.set({});
    this._lastComputedPresent = [];
  }

  enableTrickleICE() {
    this.mediaSettings.enableTrickleICE();
  }

  disableTrickleICE() {
    this.mediaSettings.disableTrickleICE();
  }

  get iceConfig(): RTCIceServer[] {
    return this.mediaSettings.iceConfig;
  }

  // The setTurnUrl/setTurnUsername/setTurnCredential/setSignalDelay
  // setters were deleted (Round 3 item 6, delete-and-declare): they had
  // zero callers — the Settings panel writes localStorage directly —
  // and public methods are invisible to noUnusedLocals. The declared
  // semantics, stated where the panel renders them (presence-app.ts,
  // pinned by settings-path.test.ts): TURN settings are live closures
  // read when a connection is created, so edits apply to NEW
  // connections; `signalDelayMs` is a start()-time snapshot, so edits
  // take effect on the next room join. Live-apply of signalDelay
  // mid-room would need a deliberate re-read path — add it as a
  // decision, not by resurrecting a setter nothing calls.

  onEvent(cb: (ev: StoreEventPayload) => any) {
    this.eventCallback = cb;
    // Arm the presence-sound decision here rather than in start(): the
    // subscription fires immediately with the current present set, and
    // any decision made before a listener exists is a *lost* event that
    // still marks the peer sounded — so a pong landing in the window
    // between StreamsStore.connect() and room-view's firstUpdated meant
    // that peer never chimed at all (PR #4 F6). Arming at registration
    // makes the first evaluation deterministic: whoever is present at
    // that instant is seeded silently, and every change after it sounds.
    this._armPresenceSounds();
  }

  /**
   * Subscribe the join/leave sound decision to the present predicate.
   * Keys off `_presentPeers` — NOT raw `_activeAgents` — so a pong gap
   * with media still flowing produces no sound, and a genuine departure
   * sounds only after the leave dwell. Replaces room-view's direct
   * `_activeAgents` diff (the mechanism behind the leave-then-join chime
   * blip). Fires on every `_presenceTick`, which is what expires the
   * dwell. Idempotent: re-registering a callback re-uses the existing
   * subscription and its accumulated state.
   */
  private _armPresenceSounds(): void {
    if (this._presentPeersUnsub) return;
    let seeded = false;
    this._presentPeersUnsub = this._presentPeers.subscribe(present => {
      // The subscribe() call itself delivers the current set. Adopt it as
      // the baseline instead of chiming for peers who were already here
      // when we started listening.
      if (!seeded) {
        seeded = true;
        this._presenceSoundState = { sounded: [...present], pendingLeave: {} };
        return;
      }
      const decision = decidePresenceSoundEvents({
        state: this._presenceSoundState,
        present,
        now: this.clock.now(),
        leaveDwellMs: PRESENCE_LEAVE_DWELL_MS,
      });
      this._presenceSoundState = decision.state;
      for (const ev of decision.events) {
        this.eventCallback({
          type:
            ev.kind === 'join' ? 'peer-joined-presence' : 'peer-left-presence',
          pubKeyB64: ev.peer,
        });
      }
    });
  }

  async pingAgents() {
    // Forensics FIRST, before the roster-merge write below: the merge
    // only adds unstamped entries (new agents) or upgrades `type` for
    // already-known agents while preserving their `lastSeen` — it never
    // touches an existing `lastSeen` stamp, so `_emitPresenceForensics`
    // reading the PRE-merge `_knownAgents` sees the identical
    // `knownPeerLastSeen` input either way. Ordering here is NOT
    // cosmetic: the merge's `_knownAgents.set()` below synchronously
    // re-derives `_activeAgents` -> `_presentPeers` (Task 8's carrier
    // hold reads `_signalCarrierDownSince` there), so if forensics ran
    // after that write, the hold would see this cycle's carrier verdict
    // one write too late on exactly the tick a lone surviving peer's
    // own staleness crosses — review C1, reproduced with a mid-cycle
    // crossing (pingAgents() as the FIRST evaluator after the flip,
    // ahead of the next presence tick).
    this._emitPresenceForensics();

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
    await this.deps.bus.sendMessage(
      agentsToPing,
      'PingUi',
      JSON.stringify({ t0: this.clock.now() }),
    );

    // Log our stream state
    this.logger.logMyStreamInfo(getStreamInfo(this.mainStream));

    // Sweep stale pending handshake reservations (PENDING_HANDSHAKE_TTL_MS).
    // Accepts are connectionId reservations — the transport owns the peer
    // lifecycle, so dropping the entry is the entire teardown. Inits are
    // our sent-InitRequest records; without the sweep they grow one entry
    // per 5s retry for as long as a peer stays unresponsive.
    const now = this.clock.now();
    for (const r of this._peerRecords.values()) {
      if (r.pendingInits) r.pendingInits = prunePendingInits(r.pendingInits, now, PENDING_HANDSHAKE_TTL_MS);
    }

    // Health check for dead tracks (bytesReceived stall detection)
    await this.trackHealth.checkTrackHealth();

    // Scan for sustained audibility outages with a relay opportunity
    this._checkAudibilityOutages();

    // Flush any SdpData bursts that ended without a follow-up event.
    this._flushStaleSdpAggregates();

    // Forensics (signal-carrier liveness + presence-set membership)
    // already ran at the top of this function, before the roster-merge
    // write — see the comment there. Not repeated here (review C1: a
    // second call this late would just be dead weight, since nothing
    // between the two spots can change `_knownAgents`' lastSeen stamps).

    // Signals media cadence: one evaluation per ping cycle, reading
    // `_signalCarrierDownSince` from this cycle's forensics call above.
    // `bestRttEwmaMs` is the min RTT EWMA over the CURRENT signals
    // targets — the healthiest link bounds what the relay can still
    // deliver; targets with no sample yet contribute nothing, and no
    // samples at all reads as `undefined` ('no-sample' ⇒ full, by the
    // policy's declared design).
    let bestRttEwmaMs: number | undefined;
    for (const target of get(this._signalsTargets)) {
      const rtt = this._peerRecords.get(target)?.signalsRttEwma;
      if (rtt !== undefined && (bestRttEwmaMs === undefined || rtt < bestRttEwmaMs)) {
        bestRttEwmaMs = rtt;
      }
    }
    this._signalsCadence = decideSignalsMediaCadence({
      carrierDown: this._signalCarrierDownSince !== undefined,
      bestRttEwmaMs,
      prevMode: this._signalsCadence.mode,
    });

    // Voice batching eligibility: same once-per-tick cadence as the
    // cadence evaluation above (final-review wave F2) — see
    // `_voiceBatchCapAllTargets` for the two-site invariant (this site
    // plus the `_signalsTargets` subscription, re-review N1) and why this
    // moved out of the per-chunk send path.
    this._voiceBatchCapAllTargets = this.signalsTargetsAllHaveCap(CAP_VOICE_BATCH);
  }

  /** The signals media cadence the voice/filmstrip senders must obey —
   *  see `_signalsCadence` for who evaluates it and when. */
  signalsCadence(): SignalsMediaCadence {
    return this._signalsCadence;
  }

  /**
   * True when EVERY current signals target's build declares `cap`
   * (`conversationPayloadCaps` — the one capability read). The voice
   * batching gate: `sendModuleData` is one broadcast for the whole target
   * set, so a payload-format upgrade applies only when every recipient
   * can parse it — a mixed room falls back to the legacy format for
   * everyone. False with no targets (nothing to send to; senders gate on
   * the target set first).
   */
  signalsTargetsAllHaveCap(cap: string): boolean {
    const targets = get(this._signalsTargets);
    if (targets.size === 0) return false;
    for (const target of targets) {
      if (!this._peerCaps(target).has(cap)) return false;
    }
    return true;
  }

  /**
   * Per-ping-cycle forensics and the signal-carrier-down authority:
   *
   *  - SignalCarrierDown/Up — delegates to `decideSignalCarrier`
   *    (`presence-policy.ts`), which is down when at least one known
   *    peer has ponged before but none of those ponged-at-least-once
   *    peers is fresh within `SIGNAL_CARRIER_DOWN_MS`. Makes signal-relay
   *    outages visible in merged logs, and the resulting
   *    `_signalCarrierDownSince` feeds `decideSignalsMediaCadence`
   *    (Tasks 7-8) — this is no longer forensic-only.
   *  - PresenceAdd/PresenceRemove — diff of `globalPresenceSet()` with the
   *    reason a peer entered (media-live / ping-fresh / observer-reported),
   *    so the pane-survival behaviour of `isPeerMediaLive` is observable.
   */
  private _emitPresenceForensics(): void {
    const now = this.clock.now();

    const known = get(this._knownAgents);
    const blocked = get(this.blockedAgents);
    const knownPeers = Object.keys(known).filter(
      k => k !== this.myPubKeyB64 && !blocked.includes(k),
    );
    // Peers with no `lastSeen` yet are deliberately excluded here, not
    // passed through as a value `decideSignalCarrier` could treat as
    // "not fresh" — there are three paths that leave `lastSeen`
    // undefined: initial roster seeding (`this._knownAgents.update` in
    // the all-agents subscription, ~2474), a peer-leave clear
    // (~5715), and a told-only agent we've never received a Pong from
    // directly (~5877). Declared behavior change from the old inline
    // predicate: it counted a known-but-never-ponged peer as
    // "not fresh", so a relay that was dead from the very first tick
    // (nobody had ponged yet) logged a spurious SignalCarrierDown on
    // tick 1. `decideSignalCarrier` cannot distinguish "never ponged"
    // from "not here" and refuses to call either one channel death, so
    // that dead-from-start detection is forfeited on purpose — it survives
    // as long as at least one peer has ponged at least once and then
    // goes stale.
    const knownPeerLastSeen = knownPeers
      .map(k => known[k]?.lastSeen)
      .filter((ls): ls is number => ls !== undefined);
    const prevDownSince = this._signalCarrierDownSince;
    const carrierState = decideSignalCarrier({
      knownPeerLastSeen,
      prevDownSince,
      now,
    });
    this._signalCarrierDownSince = carrierState.down
      ? carrierState.downSince
      : undefined;
    if (carrierState.down && prevDownSince === undefined) {
      // Immediate back-off, in the same breath as the flip: the per-tick
      // evaluation in pingAgents() would land on 'paused' anyway, but the
      // senders must not get frames into a relay that just proved dead
      // for however long a caller-ordering change could delay that
      // evaluation. Recovery is NOT forced here — it rides the per-tick
      // evaluation and the policy's one-level-per-tick hysteresis.
      this._signalsCadence = { mode: 'paused', reason: 'carrier-down' };
      this.logger.logCustomMessage(
        `SignalCarrierDown: no pong from any of ${knownPeers.length} known peer(s)`,
      );
    } else if (!carrierState.down && prevDownSince !== undefined) {
      const downMs = now - prevDownSince;
      this.logger.logCustomMessage(
        `SignalCarrierUp: pong path recovered after ${downMs}ms`,
      );
      // Reset the RTT EWMA for current signals targets to
      // SIGNALS_RTT_DEGRADED_MS, not delete it (final-review wave F5,
      // amended per re-review N2): a sample folded across the outage is
      // evidence about the DEAD channel, not the one that just recovered
      // — carrying it forward fed the cadence policy's one-level-per-tick
      // hysteresis a stale collapsed reading and forced a ~20s walk-back
      // (paused -> voice-only -> full) even once the link was fine again.
      // A bare delete (no-sample) would have jumped straight to 'full' —
      // resuming both voice AND filmstrip at full rate into a relay that
      // JUST recovered, one tick ahead of any real evidence it can carry
      // that load. Landing exactly at the degraded threshold instead
      // means `decideSignalsMediaCadence` resumes at 'voice-only' on this
      // tick (same one-tick honesty: no stale collapsed reading survives
      // the flip), and the next real sample governs from there — a
      // healthy pong decays the EWMA below half-degraded and walks it on
      // to 'full' over the following ticks, same as any other recovery.
      for (const target of get(this._signalsTargets)) {
        this._ensurePeerRecord(target).signalsRttEwma = SIGNALS_RTT_DEGRADED_MS;
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
   * (`SDP_TIMEOUT_CEILING_MS`) is raised past today's fixed default —
   * see that constant's comment for the field rationale. K/FLOOR are
   * provisional — see docs/CONNECTION_LIFECYCLE_PLAN.md Phase 4A.
   */
  private _computeSdpTimeout(peerB64: AgentPubKeyB64): number | undefined {
    const rtt = this._peerRecords.get(peerB64)?.signalsRttEwma;
    if (rtt === undefined || rtt <= 0) return undefined;
    return Math.min(
      SDP_TIMEOUT_CEILING_MS,
      Math.max(SDP_TIMEOUT_FLOOR_MS, Math.round(rtt * SDP_TIMEOUT_RTT_MULTIPLIER))
    );
  }

  /**
   * Timeout (ms) for the store's own tracked SDP-exchange backstop timer
   * — second-line cleanup for an FSM that wedges without ever emitting a
   * phase transition. Deliberately NOT the same value as
   * `_computeSdpTimeout` (the FSM's own per-attempt timeout, passed as
   * `sdpExchangeTimeoutMs`): the backstop must always leave that timeout
   * and its first in-place backoff retry undisturbed, so it is pinned
   * strictly greater — `SDP_BACKSTOP_MULTIPLIER` (2x) times the
   * per-attempt timeout plus `SDP_BACKSTOP_RETRY_HEADROOM_MS`, capped at
   * `SDP_BACKSTOP_CEILING_MS`. Sharing the per-attempt value was Task 9's
   * original defect (review C1): the backstop fired in the same tick as
   * the FSM's own timeout and destroyed its in-place recovery attempt
   * instead of letting it run. The bare 2x multiplier without headroom
   * was a second, narrower instance of the same defect (final-review wave
   * F1): the FSM's attempt-2 deadline is `2 * perAttempt + retryDelay`,
   * not `2 * perAttempt`, so the headroom covers that retry's own delay
   * budget (see `SDP_BACKSTOP_RETRY_HEADROOM_MS`).
   */
  private _computeSdpBackstopTimeout(peerB64: AgentPubKeyB64): number {
    const perAttempt = this._computeSdpTimeout(peerB64) ?? SDP_EXCHANGE_TIMEOUT;
    return Math.min(
      SDP_BACKSTOP_CEILING_MS,
      perAttempt * SDP_BACKSTOP_MULTIPLIER + SDP_BACKSTOP_RETRY_HEADROOM_MS
    );
  }

  async changeVideoInput(deviceId: string) {
    return this.mediaSettings.changeVideoInput(deviceId);
  }

  async videoOn() {
    this._applyIntent({ type: 'video-on' });
    // Reconciler acquires the camera (Task 3 replacement #2); on a fresh
    // acquire it calls back into `_attachCameraToPeers` (below), so the
    // peer attach + my-video-on happen on WHICHEVER tick actually acquires
    // — this gesture's, or a later bare tick if this one's first acquire
    // failed transiently. No inline attach here (would double-fire).
    this.captureReconciler.noteGesture('camera');
    await this.captureReconciler.tick();

    // Start the filmstrip encoder if peers need signals-carried video.
    this._reconcileSignalsVideo();

    this.logger.logAgentEvent({
      agent: this.myPubKeyB64,
      timestamp: this.clock.now(),
      event: 'MyVideoOn',
    });

    // Send 'video-on' signal to peers
    this._broadcastRtcAction('video-on');
  }

  /**
   * Attach the freshly-acquired camera track to every peer and fire
   * `my-video-on`. Called by the capture reconciler's fresh-acquire arm
   * (no-handle → held) — from `videoOn`'s tick OR a later bare presence
   * tick if `videoOn`'s first acquire failed transiently. This peer fanout
   * stays in the store (not the source binding) because it is tied to the
   * WebRTC handle coming up, not to the device open: a keepalive sender
   * left by `videoOff` is swapped for the real track via `replaceTrack`
   * (no renegotiation, same RTCRtpSender / m-line); with no prior sender,
   * `addTrack` creates one.
   */
  private _attachCameraToPeers(): void {
    const keepalive = this._videoKeepaliveTrack;
    const videoTrack = this.cameraSource.track;
    if (videoTrack) {
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
    }
    this.eventCallback({ type: 'my-video-on' });
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
    // Stop every track the retained stream produced (today just the one;
    // stop() is idempotent), then free the canvas bitmap by zeroing its
    // dimensions. The two retention fields exist as GC anchors while the
    // captureStream track is live — this is their one read.
    this._videoKeepaliveStream?.getTracks().forEach(t => {
      try { t.stop(); } catch {}
    });
    if (this._videoKeepaliveTrack) {
      try { this._videoKeepaliveTrack.stop(); } catch {}
    }
    if (this._videoKeepaliveCanvas) {
      this._videoKeepaliveCanvas.width = 0;
      this._videoKeepaliveCanvas.height = 0;
    }
    this._videoKeepaliveTrack = null;
    this._videoKeepaliveStream = null;
    this._videoKeepaliveCanvas = null;
  }

  videoOff() {
    this._applyIntent({ type: 'video-off' });
    if (!this.captureReconciler.cameraHandleHeld) return;

    // Swap the keepalive onto every peer's video sender while the camera
    // track is still live (Task 3 replacement #2: this peer fanout stays in
    // the store — tied to the WebRTC handle going off, not the device
    // closing, so the filmstrip keeping the device open must not stop it).
    // A black-frame keepalive keeps RTP flowing so the NAT mapping stays
    // warm (dropping the sender entirely was the NAT-cooldown ICE failure).
    if (this.mainStream) {
      const videoTracks = this.mainStream.getVideoTracks();
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
        // fall back to dropping the sender. This path is the source of the
        // NAT cooldown bug; supported browsers take the keepalive path.
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
    }

    // Intent now says camera unwanted, so the reconciler's `close` arm
    // releases the handle (Task 3 replacement #2). The device closes only
    // if no other consumer (filmstrip) still holds it.
    this.captureReconciler.noteGesture('camera');
    this.captureReconciler.tick();

    // Stop the filmstrip encoder — videoOff means no video in any carrier.
    this._reconcileSignalsVideo();

    this._broadcastRtcAction('video-off');

    this.logger.logAgentEvent({
      agent: this.myPubKeyB64,
      timestamp: this.clock.now(),
      event: 'MyVideoOff',
    });
    this.eventCallback({
      type: 'my-video-off',
    });
  }

  async changeAudioInput(deviceId: string) {
    return this.mediaSettings.changeAudioInput(deviceId);
  }

  async audioOn(enabled: boolean) {
    this._applyIntent({ type: enabled ? 'audio-on' : 'audio-mute' });
    this.logger.logAgentEvent({
      agent: this.myPubKeyB64,
      timestamp: this.clock.now(),
      event: 'MyAudioOn',
    });

    // Reconciler acquires the mic (Task 3 replacement #1); a transient
    // failure no longer aborts here — it retries and reports once.
    this.captureReconciler.noteGesture('mic');
    await this.captureReconciler.tick();

    // Apply mute for the already-live case (a toggle with no (re)open,
    // where the reconciler's own setMuted did not run). No-op if unchanged.
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

    this._broadcastRtcAction('audio-on');
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
    this._applyIntent({ type: 'audio-mute' });
    this.logger.logAgentEvent({
      agent: this.myPubKeyB64,
      timestamp: this.clock.now(),
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

    this._broadcastRtcAction('audio-off');
    this.eventCallback({
      type: 'my-audio-off',
    });
  }

  /** The wire capabilities `peerB64`'s build declares (or, for pre-caps
   *  builds, is inferred to hold). One read, `conversationPayloadCaps`. */
  private _peerCaps(peerB64: AgentPubKeyB64): ReadonlySet<string> {
    return conversationPayloadCaps(
      get(this._peerModuleStates)[peerB64]?.['conversation'] ?? null,
    );
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
  private _ensureOutgoingScreenShare(pubkeyB64: AgentPubKeyB64): void {
    if (!this.screenShareStream) return;
    if (get(this._screenShareConnectionsOutgoing)[pubkeyB64]) return;
    if (!this._peerCaps(pubkeyB64).has(CAP_SDP_FSM_SCREEN)) return;

    this.screenShareOutTransport.setLocalStream(this.screenShareStream);
    const connectionId = this.screenShareOutTransport.ensureConnection(pubkeyB64, {
      sdpExchangeTimeoutMs: this._computeSdpTimeout(pubkeyB64),
      epoch: this._nextConnectionEpoch(pubkeyB64),
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
        // A display-capture track ending is a user/platform action (the
        // browser's native "Stop sharing" bar, the OS revoking capture) —
        // there is no picker-less way to re-acquire it, so `ended` here
        // *is* the user ending the share. This is the ONE documented
        // gesture-equivalent (intent.ts, IntentGesture): writing intent
        // from a track event is banned everywhere else (mic/camera `ended`
        // is Task 3's reconciler's concern, not a gesture).
        track.onended = () => {
          this._applyIntent({ type: 'screen-share-track-ended' });
          this.stopScreenShare();
        };
      }
    }
    // Activate the module only after a source has been picked, so the share
    // pane opens on remote peers (and locally) only once sharing actually
    // starts. The activation must precede 'my-screen-share-on' so the local
    // video element is rendered when room-view sets its srcObject.
    //
    // Intent is applied here too, not as the method's first statement: a
    // canceled picker expressed no intent (brief, Task 1).
    this._applyIntent({ type: 'screen-share-on' });
    await this.activateModule('screen-share');
    this.eventCallback({
      type: 'my-screen-share-on',
    });
  }

  /**
   * Turning screen sharing off is equivalent to closing the corresponding peer connection
   */
  screenShareOff() {
    this._applyIntent({ type: 'screen-share-off' });
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
      this.mediaTransport.closeConnection(pubKeyB64, 'disconnectFromPeerVideo');
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
    const blockedAgentsJson = this.deps.storage.session.getItem('blockedAgents');
    const blockedAgents: AgentPubKeyB64[] = blockedAgentsJson
      ? JSON.parse(blockedAgentsJson)
      : [];
    if (!blockedAgents.includes(pubKey64))
      this.deps.storage.session.setItem(
        'blockedAgents',
        JSON.stringify([...blockedAgents, pubKey64])
      );
    this.disconnectFromPeerVideo(pubKey64);
    this.disconnectFromPeerScreen(pubKey64);
    this.clock.setTimeout(() => {
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
    const blockedAgentsJson = this.deps.storage.session.getItem('blockedAgents');
    const blockedAgents: AgentPubKeyB64[] = blockedAgentsJson
      ? JSON.parse(blockedAgentsJson)
      : [];
    this.deps.storage.session.setItem(
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

  get mediaDevices(): Writable<MediaDeviceInfo[]> {
    return this.mediaSettings.mediaDevices;
  }

  async updateMediaDevices() {
    return this.mediaSettings.updateMediaDevices();
  }

  audioInputDevices(): Readable<MediaDeviceInfo[]> {
    return this.mediaSettings.audioInputDevices();
  }

  videoInputDevices(): Readable<MediaDeviceInfo[]> {
    return this.mediaSettings.videoInputDevices();
  }

  audioOutputDevices(): Readable<MediaDeviceInfo[]> {
    return this.mediaSettings.audioOutputDevices();
  }

  get _audioInputId(): Writable<string | undefined> {
    return this.mediaSettings._audioInputId;
  }

  audioInputId(): Readable<string | undefined> {
    return this.mediaSettings.audioInputId();
  }

  get _audioOutputId(): Writable<string | undefined> {
    return this.mediaSettings._audioOutputId;
  }

  audioOutputId(): Readable<string | undefined> {
    return this.mediaSettings.audioOutputId();
  }

  get _videoInputId(): Writable<string | undefined> {
    return this.mediaSettings._videoInputId;
  }

  videoInputId(): Readable<string | undefined> {
    return this.mediaSettings.videoInputId();
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
   * The ONE per-peer state record (peer-record.ts). INVARIANT: record
   * existence is never a liveness predicate — presence/membership come
   * from _presentPeers/_activeAgents/_knownAgents, never from this map.
   * Underscore-internal (not private): the wiring suite seeds rows.
   */
  _peerRecords: Map<AgentPubKeyB64, PeerRecord> = new Map();

  /** Read a peer's record. Never creates. */
  _peerRecord(k: AgentPubKeyB64): PeerRecord | undefined {
    return this._peerRecords.get(k);
  }

  /** Get-or-create. Write paths only — a read must never create a row. */
  _ensurePeerRecord(k: AgentPubKeyB64): PeerRecord {
    let r = this._peerRecords.get(k);
    if (!r) {
      r = initialPeerRecord();
      this._peerRecords.set(k, r);
    }
    return r;
  }

  /** Allocate the next connection epoch for `peer` (monotonic, per session). */
  private _nextConnectionEpoch(peer: AgentPubKeyB64): number {
    const r = this._ensurePeerRecord(peer);
    r.connectionEpoch += 1;
    return r.connectionEpoch;
  }

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
   * The set of **present** peers whose media is NOT currently flowing
   * over WebRTC. Audio and filmstrip video for these peers are carried
   * over Holochain remote signals. Precomputed as a derived store so the
   * voice encoder's pump loop doesn't recompute per-chunk — it just reads
   * the cached set.
   *
   * Membership is the complement of `connected` — ICE + DTLS up — not the
   * complement of "an entry exists". A peer mid-negotiation, mid-reconnect,
   * or holding a wedged entry is still carried by signals, so handover is
   * make-before-break in both directions. The rule and its rationale are in
   * `transport/carrier-coverage.ts`; the constructor's `derived` is the only
   * caller.
   *
   * Updates when: a peer enters/leaves `_presentPeers` (which includes the
   * presence tick re-evaluating the media-flowing half), or any
   * `_openConnections` write changes a peer's `connected` flag — which
   * includes connect, close, give-up, and the disableWebrtcWith teardown.
   */
  _signalsTargets!: Readable<Set<AgentPubKeyB64>>;

  /**
   * Our own screen share stream
   */
  screenShareStream: MediaStream | undefined | null;

  // ===========================================================================================
  // CONNECTION ESTABLISHMENT
  // ===========================================================================================

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
   * The presence clock's tick, incremented every PING_INTERVAL from
   * `start()`. `_activeAgents` derives from it so staleness is evaluated
   * on a tick rather than only when `_knownAgents` happens to be written —
   * previously eviction waited for `pingAgents`' next write, making real
   * eviction latency 6–8s instead of the declared 6s (§3.2 note).
   * Public like the other underscore stores so tests can fire a tick
   * without arming the interval (which lives in start()).
   */
  _presenceTick: Writable<number> = writable(0);

  private _presenceTickInterval: number | undefined;

  /**
   * The **present** predicate: ping-fresh OR media-flowing peers, in
   * stable tile order. Defined in the constructor from
   * `computePresentPeers` (presence-policy.ts); the one authority for
   * chimes, tiles, grid counts and phantom exclusion.
   */
  _presentPeers!: Readable<AgentPubKeyB64[]>;

  /**
   * The previous tick's `computePresentPeers` output — what
   * `PRESENCE_CARRIER_HOLD_MAX_MS` holds alive while
   * `_signalCarrierDownSince` is set. Updated at the end of every
   * `_presentPeers` re-evaluation, so it is always exactly one
   * evaluation stale by construction: the tick that reads it as
   * `heldPresent` is deciding this tick's set from last tick's, never
   * its own. Reset on `disconnect()` so a stale held set from a prior
   * session can't leak into the next one.
   */
  private _lastComputedPresent: AgentPubKeyB64[] = [];

  /** State of the join/leave sound decision; see decidePresenceSoundEvents. */
  private _presenceSoundState: PresenceSoundState = INITIAL_PRESENCE_SOUND_STATE;

  /** Unsubscribe from the _presentPeers sound subscription. */
  private _presentPeersUnsub: (() => void) | null = null;

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

  // Diagnostic log request/response pipeline is owned by `diagnosticsHub`
  // (store-decomposition round two, Task 3; see diagnostics-hub.ts). The
  // three Writables, the conversation-participants set, and the moved
  // methods now live there; these are bare view-surface/wiring delegates.

  get _receivedDiagnosticLogs(): Writable<Record<AgentPubKeyB64, DiagnosticSnapshot>> {
    return this.diagnosticsHub._receivedDiagnosticLogs;
  }

  get _pendingDiagnosticRequests(): Writable<Record<AgentPubKeyB64, { attempts: number; startedAt: number }>> {
    return this.diagnosticsHub._pendingDiagnosticRequests;
  }

  get _failedDiagnosticRequests(): Writable<Record<AgentPubKeyB64, true>> {
    return this.diagnosticsHub._failedDiagnosticRequests;
  }

  /** Delegates to `diagnosticsHub`. */
  clearReceivedDiagnostics(pubKeyB64?: AgentPubKeyB64): void {
    this.diagnosticsHub.clearReceivedDiagnostics(pubKeyB64);
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
      updatedAt: this.clock.now(),
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
      updatedAt: this.clock.now(),
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
      updatedAt: this.clock.now(),
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
        await this.deps.bus.sendMessage(
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
   * `peerB64`. Union semantics: OUR OWN per-peer disable (read from
   * `localIntent.webrtc.disabledWith` — Task 4 makes intent the one
   * authority for what WE have declared) OR the PEER'S broadcast state
   * (their global kill switch, or their own per-peer disable naming us —
   * an observation about the peer, not something intent can carry, so it
   * still reads their conversation payload). Either half being true is
   * sufficient — this is the ONE composition, read by both the
   * eligibility conjunct (`handlePongUi`/`handleInitRequest`) and
   * room-view's display (`_renderCarrierToggle`).
   *
   * Reads synchronously from the intent/module-state stores so it can
   * gate the retry loop in `handlePongUi` without making that path async.
   */
  webrtcDisabled(peerB64: AgentPubKeyB64): boolean {
    // My own per-peer override — intent, not a re-parse of my broadcast
    // payload (they are written together in `setPeerCarrier`, but intent
    // is the declared authority).
    if (get(this._localIntent).webrtc.disabledWith.has(peerB64)) {
      return true;
    }
    // Check peer's broadcast state: both per-peer and global. This is an
    // observation about the peer — not ours to declare via intent — so it
    // stays sourced from their conversation payload.
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
   * Freshness bucket for the last pong we received from a peer. The
   * decision lives in presence-policy.ts and is shared with the
   * status-icon rendering, so broadcast and locally-rendered dots pick
   * the same bucket by construction.
   */
  lastSeenBucket(peerB64: AgentPubKeyB64): LastSeenBucket {
    const known = get(this._knownAgents)[peerB64];
    return lastSeenBucket(known?.lastSeen, this.clock.now());
  }

  /**
   * Roll-up audio link state from this agent's local observations of the
   * given peer. Parallel FSM to `ConnectionStatus`: that one answers "what
   * stage is the WebRTC negotiation in?" — this one answers "can I hear
   * this peer right now, and via what carrier?"
   */
  audioLinkFor(peerB64: AgentPubKeyB64): AudioLinkState {
    // The decision — including the contract that observed media flow
    // beats the signals-reachability veto — lives in
    // `peer-link-policy.ts:decideAudioLink`. This method only gathers
    // the snapshot.
    const peerConv = get(this._peerModuleStates)[peerB64]?.['conversation'];
    const payload = peerConv ? parseConversationPayload(peerConv) : null;
    return decideAudioLink({
      blocked: get(this.blockedAgents).includes(peerB64),
      reachableBucket: this.lastSeenBucket(peerB64),
      slot: get(this._openConnections)[peerB64],
      audioStaleCycles: this._peerRecords.get(peerB64)?.staleCycles?.audio ?? 0,
      lastVoiceMs: voiceController.peerLastRecvMs.get(peerB64),
      now: this.clock.now(),
      // Same media-flowing window as isMediaLive / computePresentPeers —
      // one window per predicate. (Was a bespoke 2000ms literal.)
      mediaLiveWindowMs: MEDIA_LIVE_WINDOW_MS,
      peerMicMuted: !!payload?.micMuted,
      statusType: get(this._connectionStatuses)[peerB64]?.type,
    });
  }

  /**
   * Build the pair-wise snapshot broadcast in pong metadata so every peer
   * can render "how I see each other agent."
   */
  peerLinkFor(peerB64: AgentPubKeyB64): PeerLinkSnapshot {
    // Field semantics (carrier vs the carrierFor authority, the 'stale'
    // audio arm) are documented on `buildPeerLinkSnapshot`
    // (`peer-link-policy.ts`); this method only gathers the snapshot.
    const lastFilmstripMs = filmstripController.peerLastRecvMs.get(peerB64);
    return buildPeerLinkSnapshot({
      audioLink: this.audioLinkFor(peerB64),
      slot: get(this._openConnections)[peerB64],
      filmstripLive:
        lastFilmstripMs !== undefined &&
        this.clock.now() - lastFilmstripMs < MEDIA_LIVE_WINDOW_MS,
      lastSeen: this.lastSeenBucket(peerB64),
    });
  }

  /**
   * True iff media is actively flowing to/from this peer on either
   * carrier: a connected WebRTC connection, or signals-carrier voice or
   * filmstrip-video frames received within `MEDIA_LIVE_WINDOW_MS`.
   *
   * The media-flowing half of the **present** predicate. The predicate
   * itself is `computePresentPeers` (`presence-policy.ts`), which calls
   * the same `isMediaLive`; this method is the per-peer question, used by
   * `_presenceReason` and the phantom/observer paths. A Holochain-signal
   * hiccup of more than PRESENT_STALENESS_MS must not remove the pane of
   * a peer we can still see and hear.
   *
   * Note what `connected` does and does not prove: it means the transport
   * last reported ICE + DTLS up. During the declared recovery-window
   * exception (`transport/carrier-coverage.ts`) that claim can be stale
   * for the length of the transport's recovery budget, and a wedged FSM
   * slot depends on the FSM emitting `failed` to be cleared. (This
   * docblock previously asserted the opposite — that a surviving
   * `connected` entry is "genuinely live" — one of the 17 false
   * assertions in MAINTAINABILITY_ASSESSMENT.md §3.10.)
   */
  isPeerMediaLive(peerB64: AgentPubKeyB64): boolean {
    return isMediaLive({
      webrtcConnected: !!get(this._openConnections)[peerB64]?.connected,
      lastVoiceMs: voiceController.peerLastRecvMs.get(peerB64),
      lastFilmstripMs: filmstripController.peerLastRecvMs.get(peerB64),
      now: this.clock.now(),
      windowMs: MEDIA_LIVE_WINDOW_MS,
    });
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
    // Everyone present to us directly — ping-fresh OR media-flowing on
    // either carrier (the present predicate; excludes self and blocked).
    // Ping/pong staleness must not prune a peer we can still see or hear.
    for (const k of get(this._presentPeers)) {
      out.add(k);
    }
    // Anyone a *fresh* observer reports as present. We require the
    // observer's broadcast itself to be recent so that an observer who
    // dropped out doesn't keep ghost peers in the set forever.
    const now = this.clock.now();
    const observerStaleness = OBSERVER_FRESHNESS_MS;
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
   * `observersHearing()` so the placeholder can label the observer
   * list accurately.
   */
  phantomAgents(): AgentPubKeyB64[] {
    const active = get(this._activeAgents);
    // The present predicate (ping-fresh OR media-flowing) is the one
    // authority for "we see them directly"; a phantom is an observer
    // report about a peer who is NOT present to us.
    const present = new Set(get(this._presentPeers));
    const blocked = new Set(get(this.blockedAgents));
    const out = new Set<AgentPubKeyB64>();
    const now = this.clock.now();
    const observerStaleness = OBSERVER_FRESHNESS_MS;
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
        if (present.has(peerKey)) continue; // we already see them directly
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
    const now = this.clock.now();
    const observerStaleness = OBSERVER_FRESHNESS_MS;
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
   * Subset of `observersSeeing` who report actually hearing the phantom
   * (audioLink 'webrtc' or 'signals'). Used to pick the observer-list
   * label: "heard by" when this is non-empty, "last seen by" otherwise.
   *
   * Was `observersConnectedTo`, which also counted 'negotiating' links
   * and labeled the result "connected via" — presenting an in-flight
   * handshake, or signals reachability, as "connected". Phase 4 item 4:
   * that word is reserved for ICE + DTLS up; what this list can honestly
   * claim about a phantom is audibility. Declared behavior change: an
   * observer whose only link to the phantom is a pending negotiation now
   * falls back to the "last seen by" framing.
   */
  observersHearing(peerB64: AgentPubKeyB64): AgentPubKeyB64[] {
    const out: AgentPubKeyB64[] = [];
    const now = this.clock.now();
    const observerStaleness = OBSERVER_FRESHNESS_MS;
    const others = get(this._othersConnectionStatuses);
    for (const observerKey of Object.keys(others)) {
      const obs = others[observerKey];
      if (!obs.peerLinks) continue;
      if (now - obs.lastUpdated > observerStaleness) continue;
      const snap = obs.peerLinks[peerB64];
      if (!snap) continue;
      if (snap.audioLink === 'webrtc' || snap.audioLink === 'signals') {
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
   * Unified carrier selection. Since Phase 3 deleted SimplePeer there is
   * exactly one WebRTC implementation, so the model collapses to the two
   * honest axes (the shape Phase 4 asks for):
   *   - `'webrtc'`:  WebRTC enabled (FSM transport).
   *   - `'signals'`: WebRTC globally off; audio (Opus) and low-bandwidth
   *                  video (JPEG filmstrip) over Holochain signals.
   */
  carrierMode(): 'webrtc' | 'signals' {
    return this.webrtcGloballyDisabled ? 'signals' : 'webrtc';
  }

  /**
   * Apply a unified carrier mode. Tears down existing media connections
   * so the next pong cycle re-establishes via the new selection. The
   * conversation module's payload carries `webrtcDisabled` so peers see
   * the change in one broadcast.
   */
  async setCarrierMode(mode: 'webrtc' | 'signals'): Promise<void> {
    // `previous` MUST be read before `_applyIntent`: `carrierMode()`
    // reads the `webrtcGloballyDisabled` getter, which is now sourced
    // from `_localIntent` — the same record `_applyIntent` is about to
    // update. Reading it after would make `previous === mode` always,
    // short-circuiting the teardown below on every call.
    const previous = this.carrierMode();
    this._applyIntent({ type: 'carrier-mode', mode });
    if (previous === mode) return;

    if (mode === 'signals') {
      this.deps.storage.local.setItem('disableAllWebrtc', 'true');
      this.logger.logAgentEvent({
        agent: this.myPubKeyB64,
        timestamp: this.clock.now(),
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

    // mode === 'webrtc'
    this.deps.storage.local.removeItem('disableAllWebrtc');
    this.logger.logAgentEvent({
      agent: this.myPubKeyB64,
      timestamp: this.clock.now(),
      event: 'MyWebrtcEnable',
      detail: 'global',
    });
    await this._syncConversationPayload({ webrtcDisabled: false });
  }

  /**
   * Read our own per-peer carrier selection for `peerB64`. Reflects our
   * explicit override only — not the peer's own choice. Returns:
   *   - `'signals'`: peer is in our `disableWebrtcWith` list
   *   - `'inherit'`: no override — the link follows the global carrier
   *
   * The per-peer impl override (`peerImpl`) died with SimplePeer: with
   * one implementation, "pin this link to an impl" has no meaning left,
   * so the only per-peer choice is forcing signals.
   */
  myPeerCarrier(peerB64: AgentPubKeyB64): 'inherit' | 'signals' {
    const existing = get(this._myModuleStates)['conversation'];
    const payload = existing ? parseConversationPayload(existing) : null;
    if (!payload) return 'inherit';
    return payload.disableWebrtcWith.includes(peerB64) ? 'signals' : 'inherit';
  }

  /**
   * Set the per-peer carrier for `peerB64` in a single conversation-payload
   * broadcast, mirroring `setCarrierMode` for the global control:
   *   - `'signals'`: add to `disableWebrtcWith`
   *   - `'inherit'`: remove — the link follows the global carrier again
   * Tears down the existing media connection so the next pong cycle
   * re-establishes via the new selection. Stale `peerImpl` overrides from
   * pre-Phase-3 payloads are cleared opportunistically on write.
   */
  async setPeerCarrier(
    peerB64: AgentPubKeyB64,
    carrier: 'inherit' | 'signals',
  ): Promise<void> {
    this._applyIntent({
      type: 'peer-webrtc',
      peer: peerB64,
      disabled: carrier === 'signals',
    });
    const previous = this.myPeerCarrier(peerB64);
    if (previous === carrier) return;

    const existing = get(this._myModuleStates)['conversation'];
    const payload: ConversationPayload = existing
      ? (parseConversationPayload(existing) ?? { ...DEFAULT_CONVERSATION_PAYLOAD })
      : { ...DEFAULT_CONVERSATION_PAYLOAD };

    const nextPeerImpl = { ...payload.peerImpl };
    delete nextPeerImpl[peerB64];
    payload.peerImpl = nextPeerImpl;

    payload.disableWebrtcWith = payload.disableWebrtcWith.filter(p => p !== peerB64);
    if (carrier === 'signals') {
      payload.disableWebrtcWith = [...payload.disableWebrtcWith, peerB64];
    }

    this.logger.logAgentEvent({
      agent: peerB64,
      timestamp: this.clock.now(),
      event: carrier === 'signals' ? 'MyWebrtcDisable' : 'MyWebrtcEnable',
      detail: `carrier=${previous}->${carrier} (per-peer)`,
    });

    await this._syncConversationPayload(payload);

    this.disconnectFromPeerVideo(peerB64);
    if (carrier === 'signals') {
      this._clearPendingWebrtcStatus(peerB64);
    }
  }

  // The Phase-3 automated impl toggle (auto-flip) lived here until
  // SimplePeer was deleted: with one WebRTC implementation there is no
  // fsm->simplepeer escape to flip to, so the whole machinery
  // (decideAutoFlip, decideCarrierSwitch, cooldown/max-attempt state)
  // went with it — the deletion the unscheduled-defects table called for.
  // A failing WebRTC link now degrades straight to signals via the FSM's
  // own `failed` route; Phase 1's make-before-break handover is what makes
  // that acceptable.

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
    if (peerB64) {
      const r = this._peerRecords.get(peerB64);
      if (r) r.pendingInits = undefined;
    } else {
      for (const r of this._peerRecords.values()) r.pendingInits = undefined;
    }
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

  /**
   * The one per-peer stats answer: which carrier owns the link right now
   * (the `carrierFor` authority — ICE + DTLS up, never "an attempt
   * exists") and that carrier's rtt/jitter/loss. Decision in
   * `transport/carrier-stats-policy.ts`; the stats panel renders this
   * instead of branching over the raw maps by hand (Phase 4 item 2).
   */
  statsFor(pubKeyB64: AgentPubKeyB64): PeerStats {
    return statsForPeer({
      slot: get(this._openConnections)[pubKeyB64],
      webrtcStats: this.webrtcStats.get(pubKeyB64),
      signalsStats: this.signalsStats.get(pubKeyB64),
    });
  }

  /** Current OpenConnectionInfo for a peer, or undefined. */
  openConnectionInfo(pubKeyB64: string): OpenConnectionInfo | undefined {
    return get(this._openConnections)[pubKeyB64];
  }

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
   * The **signal-carrier-down** authority's state: `this.clock` timestamp
   * since `decideSignalCarrier` (`presence-policy.ts`) found no known
   * peer ponged within `SIGNAL_CARRIER_DOWN_MS`, or undefined while it is
   * up. Set from `_emitPresenceForensics`, which also emits the
   * SignalCarrierDown/Up log lines on the transition. No longer
   * forensic-only: this is the one field Tasks 7-8 (signals media
   * cadence) read to decide `carrierDown` for
   * `decideSignalsMediaCadence` (`transport/signals-cadence-policy.ts`).
   */
  private _signalCarrierDownSince: number | undefined;

  /**
   * The signals-carried media cadence — how much media the voice/filmstrip
   * senders may put on the signals carrier right now. ONE authority:
   * `decideSignalsMediaCadence` (`transport/signals-cadence-policy.ts`),
   * re-evaluated once per presence tick in `pingAgents()` AFTER
   * `_emitPresenceForensics` (so it reads this tick's carrier verdict),
   * and forced to `paused` in the same breath as a carrier-down flip.
   * Senders read it via `signalsCadence()`: voice sends in `full` and
   * `voice-only` and drops frames while `paused`; filmstrip sends only in
   * `full`. The gate is on the SEND — capture ownership stays with the
   * reconcilers/`_signalsTargets`, so recovery needs no re-arm.
   */
  _signalsCadence: SignalsMediaCadence = { mode: 'full', reason: 'no-sample' };

  /**
   * Whether EVERY current signals target advertises `CAP_VOICE_BATCH`
   * (`voice-batch-v1`) (final-review wave F2). `signalsTargetsAllHaveCap`
   * remains the one evaluation authority — this field is its cache, kept
   * fresh from TWO sites (re-review N1 — a single site left an unsafe
   * window):
   *
   *  1. Once per presence tick in `pingAgents()`, right beside
   *     `_signalsCadence`. Catches a cap arriving (via ModuleState) for an
   *     ALREADY-present target — that direction (stale-false correcting to
   *     true) is safe to lag a tick: it only costs a few frames of legacy
   *     format on a peer who can already parse v2.
   *  2. Synchronously inside the `_signalsTargets` subscription
   *     (constructor, above) — required because the target SET can grow
   *     synchronously off a peer's first pong (pong handler →
   *     `_knownAgents` → `_activeAgents` → `_presentPeers` →
   *     `_signalsTargets`), ahead of the next tick. Left stale-true across
   *     a grow, a v2 batch would broadcast to a peer who never declared
   *     the cap — every released build's decoder does a bare `JSON.parse`
   *     there and throws per payload until the next tick recomputed this.
   *
   * Invariant: this boolean must never be stale-true across a target-set
   * grow. Previously voice.ts called `signalsTargetsAllHaveCap` directly
   * inside `handleEncodedChunk` — once per encoded chunk, 50/s, each call
   * doing a per-target `conversationPayloadCaps` JSON.parse — which
   * contradicted the cached-derived-value convention documented at
   * voice.ts's `_signalsTargets` read; hoisting to this cache, read via
   * `voiceBatchEligible()`, moves that off the per-chunk send path while
   * the two sites above keep it correct on both directions of change.
   */
  private _voiceBatchCapAllTargets = false;

  /** The per-tick voice-batching eligibility — see
   *  `_voiceBatchCapAllTargets` for the evaluation cadence and rationale. */
  voiceBatchEligible(): boolean {
    return this._voiceBatchCapAllTargets;
  }

  /**
   * Last computed `globalPresenceSet()`, kept so the ping cycle can diff
   * membership and emit PresenceAdd/PresenceRemove forensic events.
   */
  private _lastPresenceSet = new Set<AgentPubKeyB64>();

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

  /** View-surface delegate to `peerAudioLevels` (Task 1; see
   *  peer-audio-levels.ts). Called by the audio-level-meter element. */
  getWebrtcAudioLevel(pubKeyB64: string): number {
    return this.peerAudioLevels.getWebrtcAudioLevel(pubKeyB64);
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
      // The merge rule is `decideModuleStateMerge` (module-state-policy.ts,
      // Round 3 item 3) — shared with the pong sweep in handlePongUi.
      // Declared change: a push whose stamp is older than the held entry
      // is now ignored instead of applied unconditionally.
      const decision = decideModuleStateMerge({
        current: prev,
        incoming: envelope,
        source: 'push',
      });
      if (decision.action === 'keep') return;
      this._peerModuleStates.update(all => {
        const updated = { ...all };
        const agentModules = { ...(updated[pubkeyB64] ?? {}) };
        if (decision.action === 'set') {
          agentModules[envelope.moduleId] = decision.envelope;
        } else {
          delete agentModules[envelope.moduleId];
        }
        updated[pubkeyB64] = agentModules;
        return updated;
      });
      const next = decision.action === 'set' ? decision.envelope : null;
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
        await this.deps.bus.sendMessage(
          agentsToNotify,
          'ModuleState',
          JSON.stringify(envelope)
        );
      } catch (e) {
        console.error('Failed to send ModuleState signal:', e);
      }
    }
  }

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
      const streamInfo = getStreamInfo(this._peerRecords.get(agentB64)?.videoStream);
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
          moduleStatesAt: this.clock.now(),
        },
      };
      try {
        await this.deps.bus.sendMessage(
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
   * Request diagnostic logs from a specific peer (or, with no argument,
   * every peer in this conversation). Delegates to `diagnosticsHub`
   * (store-decomposition round two, Task 3).
   */
  async requestDiagnosticLogs(pubKeyB64?: AgentPubKeyB64) {
    return this.diagnosticsHub.requestDiagnosticLogs(pubKeyB64);
  }

  /**
   * Build a merged diagnostic log combining local and received remote
   * events for a peer. Delegates to `diagnosticsHub`.
   */
  exportMergedLogs(pubKeyB64: AgentPubKeyB64): object {
    return this.diagnosticsHub.exportMergedLogs(pubKeyB64);
  }

  /**
   * Build a merged diagnostic log combining local events with every
   * received remote snapshot. Delegates to `diagnosticsHub`.
   */
  exportMergedLogsAll(): object {
    return this.diagnosticsHub.exportMergedLogsAll();
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
    const last = this._peerRecords.get(pubKeyB64)?.qualityBucket;
    if (bucket === last) return;
    this._ensurePeerRecord(pubKeyB64).qualityBucket = bucket;
    const detail =
      `${bucket}` +
      (rttMs !== null ? ` rtt=${rttMs}ms` : '') +
      (jitterMs !== null ? ` jit=${jitterMs}ms` : '') +
      (lossPercent !== null ? ` loss=${lossPercent}%` : '');
    this.logger.logAgentEvent({
      agent: pubKeyB64,
      timestamp: this.clock.now(),
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
    const now = this.clock.now();
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
    // Capture the reason a peer leaves a live webrtc call so the downgrade to
    // signals can name it (§6.6). The FSM logs the transition (onTransition)
    // before the corresponding state-change event reaches `_handleMediaClosed`,
    // so this is populated in time. Use the connected->X trigger (root cause:
    // disconnectFromPeerVideo / peer-left / transport-failure) rather than the
    // eventual close trigger, which is often a downstream "stale ICE" note.
    if (entry.fromState === 'connected' && entry.toState !== 'connected') {
      this._ensurePeerRecord(entry.remoteAgent).webrtcExitReason = entry.trigger;
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
    const now = this.clock.now();
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
    const now = this.clock.now();
    const presence = this.globalPresenceSet();
    const others = get(this._othersConnectionStatuses);

    for (const peerB64 of presence) {
      if (peerB64 === this.myPubKeyB64) continue;

      const link = this.audioLinkFor(peerB64);
      const isOutage = link === 'down' || link === 'negotiating';
      const state = this._peerRecords.get(peerB64)?.outageState;

      if (isOutage) {
        if (!state) {
          this._ensurePeerRecord(peerB64).outageState = { startedAt: now, emitted: false };
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
        // The auto-flip that used to fire here was deleted with
        // SimplePeer (Phase 3): there is no second WebRTC impl to flip
        // to. The outage event stands as the forensic record; recovery
        // belongs to the FSM (reconnect/ICE-restart) and, if it gives
        // up, the failed route's fall-back to signals.
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
        { const r = this._peerRecords.get(peerB64); if (r) r.outageState = undefined; }
      }
    }
  }

  /**
   * The one executor for a stale-connection teardown. The predicate that
   * decides *whether* to tear down is `decideStaleConnectionCleanup`
   * (`transport/stale-connection-policy.ts`); the cleanup set is the
   * `stale-teardown` rows of `closeCleanupPlan`
   * (`transport/close-cleanup-policy.ts`). All three supervisor sites
   * call this: the screen-share check in `handlePingUi`, and the video
   * and screen-share checks in `handlePongUi`. Site-specific forensics
   * (console/custom/agent-event logging) stay at the sites.
   */
  private _applyStaleTeardown(
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
        : get(this._screenShareConnectionsOutgoing)[pubkeyB64];
    this._applyCloseCleanup(
      ctx,
      closeCleanupPlan(ctx),
      pubkeyB64,
      slot?.connectionId ?? '',
      `stale ICE=${iceState}`,
    );
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
          await new Promise<void>(resolve => this.clock.setTimeout(resolve, delay));
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
            // Retired wire flow (Phase 3): SdpData carried the SimplePeer
            // SDP exchange, and SimplePeer is deleted. Only ≤ v0.14.8
            // peers still emit it; drop explicitly, never silently.
            this.logger.logCustomMessage(
              `Dropped SdpData from ${
                encodeHashToBase64(signal.from_agent).slice(0, 8)
              }: retired wire flow (SimplePeer removed in Phase 3)`
            );
            break;
          case 'SdpFsm':
            this.handleSdpFsm(signal);
            break;
          case 'SdpFsmScreen':
            this.handleSdpFsmScreen(signal);
            break;
          case 'LeaveUi':
            await this.handleLeaveUi(signal);
            break;
          case 'DiagnosticRequest':
            await this.diagnosticsHub.handleDiagnosticRequest(signal);
            break;
          case 'DiagnosticResponse':
            this.diagnosticsHub.handleDiagnosticResponse(signal);
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

    const streamInfo = getStreamInfo(this._peerRecords.get(pubkeyB64)?.videoStream);

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
          moduleStatesAt: this.clock.now(),
        },
      };
      await this.deps.bus.sendMessage(
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
        // Screen share is FSM-carried since Phase 3, so
        // `ownsTransportRecovery` (read from the transport, never
        // hardcoded — the deliberate design that let this port stand the
        // supervisor down without touching it) makes the decision
        // `transport-owns-recovery` in practice; the FSM's own `failed`
        // route is what clears a wedged slot.
        const outgoing = get(this._screenShareConnectionsOutgoing)[pubkeyB64];
        if (outgoing) {
          const iceState =
            this.screenShareOutTransport.getIceConnectionState(pubkeyB64);
          const decision = decideStaleConnectionCleanup({
            hasExistingConn: true,
            slotClaimsConnected: !!outgoing.connected,
            carrierOwnsRecovery:
              this.screenShareOutTransport.ownsTransportRecovery,
            iceState,
            disconnectedAt: this._peerRecords.get(pubkeyB64)?.screenShareIceDisconnectedAt,
            now: this.clock.now(),
            graceMs: ICE_DISCONNECTED_GRACE_MS,
          });
          if (decision.action === 'teardown') {
            this._applyStaleTeardown('screen-share-outgoing', pubkeyB64, iceState);
          }
        }
        // Re-joining peer pinged us while we're sharing: start the screen
        // connection immediately rather than waiting for the pong cycle.
        this._ensureOutgoingScreenShare(pubkeyB64);
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
      timestamp: this.clock.now(),
      event: 'PeerLeave',
    });
    // If we were mid-outage for this peer, close it out — the peer is
    // gone, not silently unreachable. Wouldn't fire via _checkAudibilityOutages
    // because peer drops from the presence set on next tick.
    const outage = this._peerRecords.get(pubkeyB64)?.outageState;
    if (outage?.emitted) {
      const durationSec = Math.floor((this.clock.now() - outage.startedAt) / 1000);
      this.logger.logAgentEvent({
        agent: pubkeyB64,
        timestamp: this.clock.now(),
        event: 'AudibilityOutageEnd',
        detail: `${durationSec}s; peer left`,
      });
    }
    { const r = this._peerRecords.get(pubkeyB64); if (r) r.outageState = undefined; }

    // Clear lastSeen so agent immediately drops from _activeAgents (pane
    // removal). Same observable as "never joined" — both surface as
    // `absent` from this observer's view.
    this._knownAgents.update(agents => {
      if (agents[pubkeyB64]) {
        agents[pubkeyB64] = { ...agents[pubkeyB64], lastSeen: undefined };
      }
      return agents;
    });

    // Destroy the peer's connections (media, then both screen-share
    // directions) and clear the per-peer maps — the `peer-leave` rows of
    // `closeCleanupPlan`. The map clears run whether or not a slot
    // exists (they always did on this path); the transport close runs
    // first when a slot exists, so a live connection gets the full
    // close-event cleanup via the synchronously emitted nested `closed`.
    for (const target of [
      'media',
      'screen-share-incoming',
      'screen-share-outgoing',
    ] as const) {
      const slot =
        target === 'media'
          ? get(this._openConnections)[pubkeyB64]
          : target === 'screen-share-incoming'
            ? get(this._screenShareConnectionsIncoming)[pubkeyB64]
            : get(this._screenShareConnectionsOutgoing)[pubkeyB64];
      const ctx: CloseCleanupContext = {
        target,
        via: 'peer-leave',
        outcome: slot ? 'live' : 'no-slot',
      };
      this._applyCloseCleanup(
        ctx,
        closeCleanupPlan(ctx),
        pubkeyB64,
        slot?.connectionId ?? '',
        'peer left',
      );
    }

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
    const now = this.clock.now();
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

      // The pong-echo RTT fold — plausibility bound, EWMA smoothing, and
      // the emit gate — is one pure decision (`foldSignalsRtt`,
      // carrier-stats-policy.ts, §9 item 4). This block only executes it.
      const rttFold = foldSignalsRtt({
        pingT0:
          typeof metaData.data.pingT0 === 'number'
            ? metaData.data.pingT0
            : undefined,
        now: this.clock.now(),
        prevEwmaMs: this._peerRecords.get(pubkeyB64)?.signalsRttEwma,
        slot: get(this._openConnections)[pubkeyB64],
      });
      switch (rttFold.action) {
        case 'no-sample':
          // Peer on old code — their pong doesn't echo pingT0 yet.
          console.debug(
            `[stats] No pingT0 in pong from ${pubkeyB64.slice(0, 8)} — remote may be on older code`
          );
          break;
        case 'drop':
          break;
        case 'fold': {
          this._ensurePeerRecord(pubkeyB64).signalsRttEwma = rttFold.ewmaMs;
          const existing = this.signalsStats.get(pubkeyB64) ?? {
            rttMs: null, jitterMs: null, lossPercent: null,
          };
          existing.rttMs = rttFold.ewmaMs;
          this.signalsStats.set(pubkeyB64, existing);
          if (rttFold.emitQualityCheck) {
            this._maybeEmitQualityChange(
              pubkeyB64,
              'signals',
              existing.rttMs,
              existing.jitterMs,
              existing.lossPercent,
            );
          }
          break;
        }
        default: {
          const exhaustive: never = rttFold;
          void exhaustive;
        }
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
          maybeKnownAgent.lastSeen = this.clock.now();
        } else {
          knownAgents[pubkeyB64] = {
            pubkey: pubkeyB64,
            type: 'told',
            lastSeen: this.clock.now(),
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
      // Reconcile module states from the pong (late-joiner catch-up and
      // lost-push healing). The per-module merge rule is
      // `decideModuleStateMerge` (module-state-policy.ts, Round 3
      // item 3) — the SAME rule the push path applies. The sweep stamp
      // is the sender's `moduleStatesAt` (or, for legacy pongs, the max
      // updatedAt across the pong's own entries), so an in-flight pong
      // serialized before a fresh push cannot delete the pushed module —
      // the ~2s module flicker this replaces.
      {
        const currentModules = get(this._peerModuleStates)[pubkeyB64] || {};
        const prevSnapshot = { ...currentModules };
        const incoming = metaData.data.moduleStates ?? {};
        const incomingStamps = Object.values(incoming).map(e => e.updatedAt);
        const sweepStamp =
          metaData.data.moduleStatesAt ??
          (incomingStamps.length ? Math.max(...incomingStamps) : undefined);
        const merged = { ...currentModules };
        let changed = false;
        const allIds = new Set([
          ...Object.keys(currentModules),
          ...Object.keys(incoming),
        ]);
        for (const moduleId of allIds) {
          const decision = decideModuleStateMerge({
            current: currentModules[moduleId] ?? null,
            incoming: incoming[moduleId] ?? null,
            source: 'pong-sweep',
            sweepStamp,
          });
          if (decision.action === 'set') {
            merged[moduleId] = decision.envelope;
            changed = true;
          } else if (decision.action === 'delete') {
            delete merged[moduleId];
            changed = true;
          }
        }
        if (changed) {
          this._peerModuleStates.update(all => ({ ...all, [pubkeyB64]: merged }));
          // Fire transition + payload-change callbacks for affected modules
          for (const moduleId of allIds) {
            const prevEnv = prevSnapshot[moduleId] || null;
            const nextEnv = merged[moduleId] || null;
            this._dispatchPeerModuleTransition(pubkeyB64, moduleId, prevEnv, nextEnv);
            this._dispatchPeerModulePayloadChange(pubkeyB64, moduleId, prevEnv, nextEnv);
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

    // Per-peer WebRTC override: `webrtcDisabled` unions our own
    // intent-sourced disable with the peer's broadcast disable (Task 4 —
    // see its docblock for the composition). Skips the entire init/retry
    // path; audio flows over Holochain remote signals automatically
    // (Step 3 carrier routing).
    const peerWebrtcDisabled = this.webrtcDisabled(pubkeyB64);
    // Has the peer's conversation payload (and therefore their declared
    // caps) arrived at all? Distinct from `peerHasSdpFsmCap` below — see
    // `peerCapsKnown`'s docblock in carrier-coverage.ts (field incident D2).
    const peerCapsKnown = get(this._peerModuleStates)[pubkeyB64]?.['conversation'] !== undefined;

    // Clean up stale video connection if the underlying WebRTC is dead.
    // This allows the normal initiation flow to proceed for a re-joining peer.
    // The predicate lives in `transport/stale-connection-policy.ts` — it is
    // the same rule the two screen-share sites below apply, and it is where
    // the grace-window and one-recovery-controller rationale is written down.
    const existingConn = get(this._openConnections)[pubkeyB64];
    {
      const activeTransport = this.mediaTransport;
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
        disconnectedAt: this._peerRecords.get(pubkeyB64)?.iceDisconnectedAt,
        now: this.clock.now(),
        graceMs: ICE_DISCONNECTED_GRACE_MS,
      });
      if (existingConn && decision.action === 'teardown') {
        this.logger.logCustomMessage(`Stale cleanup [${pubkeyB64.slice(0, 8)}]: ICE=${iceState} ${decision.reason}`);
        this.logger.logAgentEvent({
          agent: pubkeyB64,
          timestamp: this.clock.now(),
          event: 'StaleCleanup',
          connectionId: existingConn.connectionId,
        });
        this._applyStaleTeardown('media', pubkeyB64, iceState);
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
        webrtcGloballyDisabled: this.webrtcGloballyDisabled,
        peerCapsKnown,
        peerHasSdpFsmCap: this.webrtcAvailableFor(pubkeyB64),
      }).eligible
    ) {
      const pendingInits = this._peerRecords.get(pubkeyB64)?.pendingInits;
      const decision = decideInitRetry({
        alreadyOpen: !!alreadyOpen,
        myPubKeyB64: this.myPubKeyB64,
        peerPubKeyB64: pubkeyB64,
        pendingInitT0s: pendingInits?.map(init => init.t0),
        now,
        retryThresholdMs: INIT_RETRY_THRESHOLD,
      });
      switch (decision.action) {
        case 'send-init': {
          if (decision.reason === 'no-pending-init') {
            const lastDisconnect = this._peerRecords.get(pubkeyB64)?.lastDisconnectTime;
            if (lastDisconnect) {
              const gap = this.clock.now() - lastDisconnect;
              this.logger.logCustomMessage(
                `Retry gap [${pubkeyB64.slice(0, 8)}]: ${gap}ms since last disconnect (initiator)`
              );
            }
          }
          const newConnectionId = uuidv4();
          this._ensurePeerRecord(pubkeyB64).pendingInits = [
            ...(pendingInits ?? []),
            { connectionId: newConnectionId, t0: now },
          ];
          await this.deps.bus.sendMessage(
            [signal.from_agent],
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
            this.trackHealth.reconcileVideoStreamState(pubkeyB64, metaDataExt.data.streamInfo);
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
      if (!this.mainStream?.getAudioTracks()[0]?.enabled) {
        this._sendRtcAction('audio-off', [pubkeyB64]);
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
      const iceState =
        this.screenShareOutTransport.getIceConnectionState(pubkeyB64);
      // Same predicate as the video path — see `stale-connection-policy.ts`.
      const decision = decideStaleConnectionCleanup({
        hasExistingConn: true,
        slotClaimsConnected: !!outgoingScreenShare.connected,
        carrierOwnsRecovery: this.screenShareOutTransport.ownsTransportRecovery,
        iceState,
        disconnectedAt: this._peerRecords.get(pubkeyB64)?.screenShareIceDisconnectedAt,
        now,
        graceMs: ICE_DISCONNECTED_GRACE_MS,
      });
      if (decision.action === 'teardown') {
        this._applyStaleTeardown('screen-share-outgoing', pubkeyB64, iceState);
      }
    }
    // The FSM screen path has no InitRequest cadence: ensureConnection is
    // idempotent per pong, the FSM owns retry/timeout, and a failed link
    // cleared its slot so this re-enters. Guards (are we sharing, slot
    // exists, peer capability) live inside.
    this._ensureOutgoingScreenShare(pubkeyB64);
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
      timestamp: this.clock.now(),
      event: 'InitRequest',
      connectionId: connection_id,
    });

    // Log retry gap if this is a reconnection attempt
    const lastDisconnect = this._peerRecords.get(pubKey64)?.lastDisconnectTime;
    if (lastDisconnect) {
      const gap = this.clock.now() - lastDisconnect;
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
      // One eligibility predicate, shared with the initiator arm in
      // `handlePongUi` (Round 3 item 2). Declared behavior change: the
      // acceptor now requires `conversationActive` too — before this,
      // a node with the conversation module inactive refused to initiate
      // but would answer an inbound InitRequest and stand up a full
      // connection. The decision and its reason live in the predicate's
      // docblock (`decideWebrtcEligibility`, carrier-coverage.ts).
      const eligibility = decideWebrtcEligibility({
        role: 'acceptor',
        conversationActive: !!get(this._myModuleStates)['conversation'],
        // `webrtcDisabled` unions our own intent-sourced disable with the
        // peer's broadcast disable — see the initiator arm's comment.
        peerWebrtcDisabled: this.webrtcDisabled(pubKey64),
        webrtcGloballyDisabled: this.webrtcGloballyDisabled,
        peerCapsKnown: get(this._peerModuleStates)[pubKey64]?.['conversation'] !== undefined,
        peerHasSdpFsmCap: this.webrtcAvailableFor(pubKey64),
      });
      if (!eligibility.eligible) {
        const reason = eligibility.reason;
        switch (reason) {
          case 'conversation-inactive':
            this.logger.logCustomMessage(
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
            this.logger.logCustomMessage(
              `Dropped video InitRequest from ${pubKey64.slice(0, 8)}: peer caps not yet received`
            );
            break;
          case 'peer-lacks-sdp-fsm-cap':
            // A peer whose build cannot parse SdpFsm has no WebRTC path
            // to us at all since Phase 3 deleted SimplePeer; answering
            // their InitRequest would lure them into an SDP exchange we
            // drop.
            this.logger.logCustomMessage(
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
      await this.deps.bus.sendMessage(
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
      this.logger.logCustomMessage(
        `Dropped screen-share InitRequest from ${pubKey64.slice(0, 8)}: ` +
          'peer build predates the FSM screen-share channel (SdpFsmScreen)'
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
      timestamp: this.clock.now(),
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
      const agentPendingInits = this._peerRecords.get(pubKey64)?.pendingInits;
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
            const rtt = this.clock.now() - matchingInit.t0;
            this.logger.logCustomMessage(
              `Signaling RTT [${pubKey64.slice(0, 8)}]: ${rtt}ms`
            );
          }

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
          const transport = this.mediaTransport;
          const effectiveConnId = transport.ensureConnection(pubKey64, {
            initiator: true,
            connectionId: connection_id,
            sdpExchangeTimeoutMs: this._computeSdpTimeout(pubKey64),
            epoch: this._nextConnectionEpoch(pubKey64),
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

          { const r = this._peerRecords.get(pubKey64); if (r) r.pendingInits = undefined; }

          // Second-line backstop: if the FSM wedges without ever emitting
          // a phase transition, this store-level timer cleans up and lets
          // the next ping/pong cycle retry. Deliberately NOT the same
          // window as the FSM's own per-attempt SDP timeout above
          // (`sdpExchangeTimeoutMs: _computeSdpTimeout(...)`) — it is
          // `_computeSdpBackstopTimeout`, pinned strictly greater (2x plus
          // `SDP_BACKSTOP_RETRY_HEADROOM_MS`, own ceiling) so it never
          // preempts the FSM's own timeout and first in-place backoff
          // retry (review C1; the headroom term closed a narrower
          // instance of the same defect — final-review wave F1). The timer is
          // ATTEMPT-scoped and TRACKED (§9 item 5): it may only tear down
          // the attempt that armed it — a successor attempt's slot must
          // survive this timer firing — and a new attempt for the same
          // peer disarms the previous timer, as does disconnect().
          const priorSdpTimer = this._peerRecords.get(pubKey64)?.sdpTimeoutTimer;
          if (priorSdpTimer !== undefined) this.clock.clearTimeout(priorSdpTimer);
          this._ensurePeerRecord(pubKey64).sdpTimeoutTimer = this.clock.setTimeout(() => {
            { const r = this._peerRecords.get(pubKey64); if (r) r.sdpTimeoutTimer = undefined; }
            const conn = get(this._openConnections)[pubKey64];
            // A successor attempt owns the slot now: its own timer owns
            // its deadline. (Pinned by the successor-survival wiring test.)
            if (conn && conn.connectionId !== effectiveConnId) return;
            const currentStatus = get(this._connectionStatuses)[pubKey64];
            if (!currentStatus || currentStatus.type !== 'SdpExchange') return;
            this.logger.logCustomMessage(
              `SDP timeout [${pubKey64.slice(0, 8)}]: destroying stale connection`
            );
            if (conn && !conn.connected) {
              this.mediaTransport.closeConnection(pubKey64, 'SDP exchange timeout');
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
      this.logger.logCustomMessage(
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
    this.mediaTransport.processIncomingSignal({
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
    const localConnId = this.mediaTransport.getConnectionId(pubkeyB64) ?? parsed.connection_id;
    this._logSdpDataEvent(pubkeyB64, localConnId, `fsm-${sdpType}`);
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
   * the `signaling` transition in `_subscribeScreenShareTransport`.
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
      this.logger.logCustomMessage(
        `Dropped SdpFsmScreen from ${pubkeyB64.slice(0, 8)}: ${routed.reason} dir=${String(parsed.dir)}`
      );
      return;
    }
    const transport =
      routed.route === 'incoming-share'
        ? this.screenShareInTransport
        : this.screenShareOutTransport;
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
    this._logSdpDataEvent(pubkeyB64, localConnId, `screen-fsm-${sdpType}`);
  }

}
