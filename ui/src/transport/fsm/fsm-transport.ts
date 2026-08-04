/**
 * FsmTransport — wraps the hand-rolled WebRTC ConnectionManager (Phase 2)
 * behind the PeerTransport interface.
 *
 * Differences from the (retired, Phase 3) SimplePeerTransport that the
 * wrapper papers over — kept because they document why the interface is
 * shaped the way it is:
 *   - The FSM allocates its own per-peer connectionId at ensureConnection
 *     time. The connectionId hint passed by the application is ignored;
 *     callers must use the returned ConnectionId.
 *   - Perfect Negotiation handles offer/answer choreography internally,
 *     so an `initiator` flag is not meaningful — both sides call
 *     ensureConnection and the FSM works out who offers first based on
 *     polite/impolite role assignment from agent IDs.
 *   - There is no per-peer addTrack/removeTrack/replaceTrack on
 *     ConnectionManager; track changes propagate via updateLocalStream
 *     and refreshMedia. The wrapper translates accordingly.
 *
 * Wire format for outgoing/incoming signals: the OutgoingSignal.data
 * payload is a `{ type, payload }` envelope where `type` is one of
 * 'offer' | 'answer' | 'candidate' | 'leave' and `payload` is the
 * SDP / candidate body. The application is responsible for transporting
 * this envelope (e.g. via Holochain remote-signal of type 'SdpFsm') and
 * delivering it back via processIncomingSignal on the receiving side.
 */

import type { AgentPubKeyB64 } from '@holochain/client';
import type {
  ConnectionId,
  ConnectionPhase,
  IceDiagnostic,
  IncomingSignal,
  OutgoingSignal,
  PeerTransport,
  PeerTransportOptions,
  SenderPriorityOutcome,
  TransportEvent,
  TransportEventHandler,
  TransportEventType,
  TransportStats,
  Unsubscribe,
} from '../types';
import { ConnectionManager, DEFAULT_CONFIG } from '@lightningrodlabs/webrtc-peer';
import type { PeerCreatedContext } from '@lightningrodlabs/webrtc-peer';
import type {
  ConnectionConfig,
  FSMTransitionEntry,
  ReconnectPolicy,
  SignalingAdapter,
  SignalMessage,
  Unsubscribe as FsmUnsubscribe,
} from '@lightningrodlabs/webrtc-peer';

export type FsmSignalEnvelope = {
  type: SignalMessage['type'];
  payload: SignalMessage['data'];
};

export type FsmTransportOptions = PeerTransportOptions & {
  /** Override ConnectionConfig defaults (timeouts, role). iceServers/trickleICE
   *  are pulled from PeerTransportOptions and override the config. */
  configOverrides?: Partial<ConnectionConfig>;
  /** Test seam: factory for RTCPeerConnection. */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  /** Test seam: retry/backoff policy override, passed through to
   *  ConnectionManager. The carrier-handover harness injects a short
   *  budget so a silent peer drop reaches `failed` in seconds, not
   *  minutes; production uses the library default. */
  reconnectPolicy?: ReconnectPolicy;
  /** Forensic hook fired on every FSM state transition. Carries the
   *  trigger string the FSM logs internally — wire this up in the
   *  application layer (e.g. log as `FsmTransition` events) to make
   *  the cause of each (re)entry into signaling visible in capture. */
  onTransition?: (entry: FSMTransitionEntry) => void;
};

export class FsmTransport implements PeerTransport {
  /**
   * The FSM owns transport recovery: ICE restart, full reconnect, quadratic
   * backoff, and the disconnected-grace window all run inside the library.
   * A consumer that also tears the pc down races it. See
   * `PeerTransport.ownsTransportRecovery`.
   */
  readonly ownsTransportRecovery = true;

  private _myAgentId: AgentPubKeyB64;
  private _onOutgoingSignal: (signal: OutgoingSignal) => void;
  private _getIceServers: () => RTCIceServer[];
  private _getTrickleICE: () => boolean;
  private _getIceTransportPolicy: () => RTCIceTransportPolicy | undefined;

  private _config: ConnectionConfig;
  private _manager: ConnectionManager;
  private _signalHandlers: Array<(from: string, message: SignalMessage) => void> = [];

  private _typedHandlers = new Map<TransportEventType, Set<TransportEventHandler>>();
  private _anyHandlers = new Set<TransportEventHandler>();
  /** Last known phase per peer; used to fire transitions out of 'idle'. */
  private _lastPhase = new Map<AgentPubKeyB64, ConnectionPhase>();
  private _localStream: MediaStream | null = null;
  private _destroyed = false;
  /**
   * Per-peer abort handles for the ICE diagnostic listeners. A new peer
   * session (initial connect, full reconnect, or an in-place FSM
   * replacement — which emits no close event) aborts the previous set
   * before attaching, so an orphaned pc cannot keep leaking ICE events
   * into the log under a stale connectionId.
   */
  private _iceListenerAborts = new Map<AgentPubKeyB64, AbortController>();

  constructor(options: FsmTransportOptions) {
    this._myAgentId = options.myAgentId;
    this._onOutgoingSignal = options.onOutgoingSignal;
    const ice = options.iceServers ?? [];
    this._getIceServers = typeof ice === 'function' ? ice : () => ice;
    const trickle = options.trickleICE ?? true;
    this._getTrickleICE = typeof trickle === 'function' ? trickle : () => trickle;
    const policy = options.iceTransportPolicy;
    this._getIceTransportPolicy =
      typeof policy === 'function' ? policy : () => policy;

    this._config = {
      ...DEFAULT_CONFIG,
      ...(options.configOverrides ?? {}),
      iceServers: this._getIceServers(),
      trickleICE: this._getTrickleICE(),
      iceTransportPolicy: this._getIceTransportPolicy(),
    };

    // Inline SignalingAdapter that bridges to the PeerTransport
    // onOutgoingSignal callback / processIncomingSignal entrypoint.
    const adapter: SignalingAdapter = {
      sendSignal: (to, message) => {
        this._onOutgoingSignal({
          to,
          connectionId: message.connectionId,
          peerSessionId: message.peerSessionId,
          epoch: message.epoch,
          data: { type: message.type, payload: message.data } as FsmSignalEnvelope,
        });
      },
      onSignal: (handler): FsmUnsubscribe => {
        this._signalHandlers.push(handler);
        return () => {
          this._signalHandlers = this._signalHandlers.filter(h => h !== handler);
        };
      },
    };

    this._manager = new ConnectionManager({
      myAgentId: this._myAgentId,
      signaling: adapter,
      config: this._config,
      createPeerConnection: options.createPeerConnection,
      reconnectPolicy: options.reconnectPolicy,
      onTransition: options.onTransition,
      // Fires synchronously per peer session with the fresh pc, before
      // tracks/SDP — the attach point for ICE diagnostics. This replaces
      // the application-side poll-until-pc-appears monitor that the
      // deleted getRTCPeerConnection escape hatch required.
      onPeerCreated: (ctx) => this._attachIceDiagnostics(ctx),
    });

    this._manager.on('connection-state-changed', (e: any) => {
      const next = e.data?.toState as ConnectionPhase;
      const prev = (e.data?.fromState as ConnectionPhase) ?? this._lastPhase.get(e.remoteAgent) ?? 'idle';
      this._lastPhase.set(e.remoteAgent, next);
      this._emit({
        type: 'connection-state-change',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        phase: next,
        previous: prev,
      });
    });

    this._manager.on('connection-created', (e: any) => {
      // Synthesize a 'signaling' transition for newly-created FSMs whose
      // very first state-change event we haven't seen yet (the FSM
      // transitions idle -> signaling on connect()/incoming-offer, but
      // ConnectionManager fires 'connection-created' before that).
      this._lastPhase.set(e.remoteAgent, 'idle');
      // Ensure the cached local stream is propagated to acceptor-side FSMs.
      // ConnectionManager.updateLocalStream skips idle FSMs entirely, so an
      // FSM created by an incoming offer would otherwise enter signaling
      // with no _localStream and generate an answer with no outgoing
      // tracks. Calling addLocalStream while idle sets the field; the
      // signaling transition's entry action then picks it up.
      if (this._localStream) {
        const fsm = this._manager.getFSM(e.remoteAgent);
        if (fsm) fsm.addLocalStream(this._localStream);
      }
    });

    this._manager.on('remote-stream', (e: any) => {
      this._emit({
        type: 'remote-stream',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        stream: e.data?.stream ?? e.data,
      });
    });

    this._manager.on('remote-track', (e: any) => {
      const track = e.data?.track ?? e.data;
      const stream = e.data?.stream ?? e.data?.streams?.[0];
      this._emit({
        type: 'remote-track',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        track,
        stream,
      });
    });

    this._manager.on('data-channel-message', (e: any) => {
      this._emit({
        type: 'data-channel-message',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        data: e.data,
      });
    });

    this._manager.on('establishment-timeline', (e: any) => {
      this._emit({
        type: 'establishment-timeline',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        timeline: e.data,
      });
    });

    this._manager.on('error', (e: any) => {
      // Forensic forwarding only (Round 3 item 1 as amended): the FSM
      // owns recovery and communicates terminality via the `failed`
      // phase, so an error event never drives teardown — it carries the
      // root-cause text (negotiation/data-channel exceptions) that used
      // to be dropped at the manager boundary.
      //
      // Declared decision — blocked-transition errors are NOT forwarded:
      // the FSM reports refused transitions on the `onTransition` stream
      // too, which the store already logs as `FsmTransition` entries
      // with a `BLOCKED:` trigger. Forwarding them here would state the
      // same fact under a second event name (one authority per concept).
      if (e.data && typeof e.data === 'object' && e.data.blocked === true) {
        return;
      }
      const err =
        e.data instanceof Error
          ? e.data
          : new Error(typeof e.data === 'string' ? e.data : JSON.stringify(e.data));
      this._emit({
        type: 'error',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        error: err,
      });
    });

    this._manager.on('connection-closed', (e: any) => {
      const prev = this._lastPhase.get(e.remoteAgent) ?? 'connected';
      this._lastPhase.delete(e.remoteAgent);
      // Detach the ICE diagnostic listeners with the connection, so a pc
      // the FSM did not synchronously destroy stops emitting.
      this._iceListenerAborts.get(e.remoteAgent)?.abort();
      this._iceListenerAborts.delete(e.remoteAgent);
      this._emit({
        type: 'connection-state-change',
        peer: e.remoteAgent,
        connectionId: e.connectionId,
        phase: 'closed',
        previous: prev,
      });
    });
  }

  /**
   * Attach ICE-level listeners to a freshly-created pc and surface what
   * they see as 'ice-diagnostic' events. Runs inside the transport — the
   * pc never leaves it (Phase 4 item 3). Listener lifetime is one peer
   * session: superseded sessions are aborted on the next attach even when
   * the FSM replacement emitted no close event.
   */
  private _attachIceDiagnostics(ctx: PeerCreatedContext): void {
    const { remoteAgent, connectionId, pc } = ctx;
    this._iceListenerAborts.get(remoteAgent)?.abort();
    const ac = new AbortController();
    this._iceListenerAborts.set(remoteAgent, ac);
    const signal = ac.signal;
    const emitDiag = (diag: IceDiagnostic) =>
      this._emit({ type: 'ice-diagnostic', peer: remoteAgent, connectionId, diag });

    pc.addEventListener(
      'iceconnectionstatechange',
      () => {
        const state = pc.iceConnectionState;
        let selectedPair: Extract<IceDiagnostic, { kind: 'ice-state' }>['selectedPair'];
        if (state === 'failed' || state === 'disconnected') {
          try {
            const transport = (pc.getSenders()[0]?.transport as any)?.iceTransport;
            const pair = transport?.getSelectedCandidatePair?.() as
              | { local?: RTCIceCandidate; remote?: RTCIceCandidate }
              | undefined;
            if (pair) {
              selectedPair = {
                local: {
                  address: (pair.local as any)?.address ?? undefined,
                  port: (pair.local as any)?.port ?? undefined,
                  type: pair.local?.type ?? undefined,
                },
                remote: {
                  address: (pair.remote as any)?.address ?? undefined,
                  port: (pair.remote as any)?.port ?? undefined,
                  type: pair.remote?.type ?? undefined,
                },
              };
            }
          } catch (_) {
            // getSenders/iceTransport may not be available on all browsers
          }
        }
        emitDiag({ kind: 'ice-state', state, selectedPair });
      },
      { signal }
    );
    pc.addEventListener(
      'icegatheringstatechange',
      () => {
        const state = pc.iceGatheringState;
        const localSdpHasRelay =
          state === 'complete'
            ? (pc.localDescription?.sdp ?? '').includes('typ relay')
            : undefined;
        emitDiag({ kind: 'gathering-state', state, localSdpHasRelay });
      },
      { signal }
    );
    pc.addEventListener(
      'icecandidate',
      (event: Event) => {
        const c = (event as RTCPeerConnectionIceEvent).candidate;
        if (!c) return;
        emitDiag({
          kind: 'candidate',
          candidateType: c.type,
          protocol: c.protocol,
          address: c.address,
          port: c.port,
        });
      },
      { signal }
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ensureConnection(
    peer: AgentPubKeyB64,
    opts?: {
      initiator?: boolean;
      connectionId?: ConnectionId;
      sdpExchangeTimeoutMs?: number;
      epoch?: number;
    }
  ): ConnectionId {
    if (this._destroyed) {
      throw new Error('FsmTransport: destroyed');
    }
    // Apply current iceServers/trickleICE/transport-policy before any new peer.
    this._manager.updateConfig({
      iceServers: this._getIceServers(),
      trickleICE: this._getTrickleICE(),
      iceTransportPolicy: this._getIceTransportPolicy(),
    });
    // `epoch` is the orchestrator-allocated connection generation: it survives
    // FSM teardown+recreate (which resets the FSM's own peerSessionId to 0) and
    // gives both peers an ordered, shared "which attempt is current" key. See
    // docs/WEBRTC_RECONNECT_IDENTITY.md.
    this._manager.ensureConnection(peer, {
      sdpExchangeTimeoutMs: opts?.sdpExchangeTimeoutMs,
      epoch: opts?.epoch,
    });
    const fsm = this._manager.getFSM(peer);
    return fsm?.connectionId ?? '';
  }

  closeConnection(peer: AgentPubKeyB64, reason?: string): void {
    this._manager.closeConnection(peer, reason ?? 'closeConnection called');
  }

  hasConnection(peer: AgentPubKeyB64): boolean {
    return !!this._manager.getFSM(peer);
  }

  getPhase(peer: AgentPubKeyB64): ConnectionPhase {
    return this._manager.getState(peer) ?? 'idle';
  }

  getConnectionId(peer: AgentPubKeyB64): ConnectionId | undefined {
    return this._manager.getFSM(peer)?.connectionId;
  }

  // ---------------------------------------------------------------------------
  // Local media
  // ---------------------------------------------------------------------------

  setLocalStream(stream: MediaStream | null): void {
    this._localStream = stream;
    this._manager.updateLocalStream(stream);
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    // ConnectionManager only exposes whole-stream propagation. Treat
    // addTrack as "the stream changed" — updateLocalStream walks all
    // active FSMs and refreshes their tracks on the next negotiation.
    this._localStream = stream;
    this._manager.updateLocalStream(stream);
    void track;
  }

  removeTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this._localStream = stream;
    // updateLocalStream re-asserts current senders against the stream's
    // current track set; tracks no longer present on the stream are
    // implicitly removed by the FSM's reconciliation pass.
    this._manager.updateLocalStream(stream);
    void track;
  }

  replaceTrack(
    oldTrack: MediaStreamTrack | null,
    newTrack: MediaStreamTrack | null,
    _stream: MediaStream
  ): void {
    if (!oldTrack || !newTrack) return;
    // Drive replaceTrack on every active FSM in parallel. The FSM's
    // replaceTrack uses the underlying RTCRtpSender so no renegotiation
    // is triggered.
    for (const peer of this._manager.viewModel.agents
      ? Object.keys(this._manager.viewModel.agents)
      : []) {
      const fsm = this._manager.getFSM(peer);
      if (!fsm) continue;
      fsm.replaceTrack(oldTrack, newTrack).catch(e => {
        console.warn(`FsmTransport.replaceTrack failed for ${peer}:`, e);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Data channel
  // ---------------------------------------------------------------------------

  send(peer: AgentPubKeyB64, data: string | ArrayBuffer | Uint8Array): void {
    const fsm = this._manager.getFSM(peer);
    if (!fsm || fsm.state !== 'connected') return;
    try {
      const payload =
        typeof data === 'string'
          ? data
          : new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      fsm.send(payload);
    } catch (e) {
      console.warn(`FsmTransport.send failed for ${peer}:`, e);
    }
  }

  // ---------------------------------------------------------------------------
  // Signaling
  // ---------------------------------------------------------------------------

  processIncomingSignal(signal: IncomingSignal): void {
    const envelope = signal.data as FsmSignalEnvelope;
    if (!envelope || typeof envelope !== 'object') return;
    const message: SignalMessage = {
      type: envelope.type,
      connectionId: signal.connectionId,
      peerSessionId: signal.peerSessionId,
      epoch: signal.epoch,
      data: envelope.payload,
    };
    for (const handler of this._signalHandlers) {
      try {
        handler(signal.from, message);
      } catch (e) {
        console.error('FsmTransport signal handler error:', e);
      }
    }
  }

  async getStats(peer: AgentPubKeyB64): Promise<TransportStats | null> {
    const pc = this._pcFor(peer);
    if (!pc) return null;
    try {
      const raw = await pc.getStats();
      return { raw };
    } catch (e) {
      console.warn(`FsmTransport.getStats failed for ${peer}:`, e);
      return null;
    }
  }

  getIceConnectionState(peer: AgentPubKeyB64): RTCIceConnectionState | undefined {
    return this._pcFor(peer)?.iceConnectionState;
  }

  async prioritizeAudio(
    peer: AgentPubKeyB64,
    opts: { videoMaxBitrateBps: number | null }
  ): Promise<SenderPriorityOutcome[]> {
    const pc = this._pcFor(peer);
    if (!pc) return [];
    const outcomes: SenderPriorityOutcome[] = [];
    for (const sender of pc.getSenders()) {
      const kind = sender.track?.kind;
      if (kind !== 'audio' && kind !== 'video') continue;
      const want = kind === 'audio' ? 'high' : 'low';
      try {
        const params = sender.getParameters();
        // setParameters requires the encodings array shape returned by
        // getParameters(); if the browser hasn't populated it yet, skip.
        if (!params.encodings || params.encodings.length === 0) continue;
        const enc = params.encodings[0] as RTCRtpEncodingParameters & {
          networkPriority?: RTCPriorityType;
        };
        enc.priority = want;
        enc.networkPriority = want;
        if (kind === 'video' && opts.videoMaxBitrateBps) {
          enc.maxBitrate = opts.videoMaxBitrateBps;
        }
        await sender.setParameters(params);
        // Read back what the browser actually stored — networkPriority is
        // not universally honored, and a silent revert must be reportable.
        const rb = sender.getParameters().encodings?.[0] as
          | (RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType })
          | undefined;
        const priority = rb?.priority ?? 'unset';
        const networkPriority = rb?.networkPriority ?? 'unset';
        outcomes.push({
          kind,
          want,
          priority,
          networkPriority,
          ...(kind === 'video'
            ? { maxBitrate: rb?.maxBitrate ?? ('unset' as const) }
            : {}),
          applied: priority === want && networkPriority === want,
        });
      } catch {
        // Non-fatal: too-early call, unsupported field, or transient state.
        outcomes.push({ kind, want, failed: true });
      }
    }
    return outcomes;
  }

  refreshMediaForPeer(peer: AgentPubKeyB64, stream: MediaStream): boolean {
    const fsm = this._manager.getFSM(peer);
    if (!fsm || !this._pcFor(peer)) return false;
    // Per-peer, kind-matched replaceTrack (forces re-encoding); tracks
    // with no sender are added. Never touches other peers — recovery for
    // one link must not perturb the rest (the reason the old code drove
    // RTCRtpSender directly instead of the fan-out replaceTrack).
    fsm.refreshMedia(stream);
    return true;
  }

  /** The pc for a peer's current session, if one exists. Internal only —
   *  the pc does not leave the transport (Phase 4 item 3). */
  private _pcFor(peer: AgentPubKeyB64): RTCPeerConnection | undefined {
    return this._manager.getFSM(peer)?.peer?.pc;
  }

  // ---------------------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------------------

  on<T extends TransportEventType>(
    type: T,
    handler: TransportEventHandler<Extract<TransportEvent, { type: T }>>
  ): Unsubscribe {
    let set = this._typedHandlers.get(type);
    if (!set) {
      set = new Set();
      this._typedHandlers.set(type, set);
    }
    const wrapped = handler as TransportEventHandler;
    set.add(wrapped);
    return () => {
      set!.delete(wrapped);
    };
  }

  onAny(handler: TransportEventHandler): Unsubscribe {
    this._anyHandlers.add(handler);
    return () => {
      this._anyHandlers.delete(handler);
    };
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const ac of this._iceListenerAborts.values()) ac.abort();
    this._iceListenerAborts.clear();
    this._manager.destroy();
    this._typedHandlers.clear();
    this._anyHandlers.clear();
    this._signalHandlers = [];
    this._lastPhase.clear();
    this._localStream = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _emit(event: TransportEvent): void {
    const typed = this._typedHandlers.get(event.type);
    if (typed) {
      for (const h of Array.from(typed)) {
        try {
          h(event);
        } catch (e) {
          console.error(`FsmTransport handler error for ${event.type}:`, e);
        }
      }
    }
    for (const h of Array.from(this._anyHandlers)) {
      try {
        h(event);
      } catch (e) {
        console.error('FsmTransport onAny handler error:', e);
      }
    }
  }
}
