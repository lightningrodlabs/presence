/**
 * TrackHealthMonitor — owner of the WebRTC dead-track detection/recovery
 * surface (store-decomposition round two, Task 4; see
 * docs/superpowers/specs/2026-09-03-owner-extraction-design.md). Owns the
 * periodic bytesReceived-stall poll, the peer-reported stream/track
 * reconciliation driven by pong metadata, and the three-rung recovery
 * ladder: replaceTrack via request-track-refresh, escalation to a close
 * once the refresh budget is spent (`DEAD_TRACK_REFRESH_BUDGET`), and the
 * reconcile path's reconnect fallback.
 *
 * `StreamsStore._applyStaleTeardown` does NOT live here: it is the shared
 * teardown bridge into `closeCleanupPlan` used by other supervisor sites
 * (stale-ICE checks in `handlePingUi`/`handlePongUi`) as well, so it stays
 * on the store.
 */
import type { AgentPubKeyB64 } from '@holochain/client';
import type { PeerRecord } from './peer-record';
import type { PeerTransport } from './transport';
import type { OpenConnectionInfo, StreamAndTrackInfo, CarrierStats } from './types';
import type { ActionMessage } from './rtc-message-policy';
import type { CaptureLifecycle } from './mic-source';
import type { PresenceLogger } from './logging';
import {
  summarizeRtcStats,
  decideTrackRefresh,
  deadTrackRefreshBudget,
  STALE_CYCLES_REFRESH_THRESHOLD,
} from './transport/track-health-policy';
import type { RtcStatsReportLike } from './transport/track-health-policy';

export type TrackHealthBindings = {
  /** deps.transportFactory('media', …), late-bound (constructed in
   *  start(), after this owner exists): getStats, hasConnection, addTrack,
   *  refreshMediaForPeer, closeConnection. */
  mediaTransport: () => PeerTransport;
  /** get(this._openConnections), late-bound (live read). */
  openConnections: () => Record<AgentPubKeyB64, OpenConnectionInfo>;
  /** StreamsStore._sendRtcAction, late-bound (real signature). */
  sendRtcAction: (message: ActionMessage, peers: AgentPubKeyB64[]) => number;
  /** StreamsStore._maybeEmitQualityChange, late-bound (real signature).
   *  Stays on the store because it is also driven by the pong handler's
   *  signals-carrier stats poll — not moved here. */
  maybeEmitQualityChange: (
    pubKeyB64: AgentPubKeyB64,
    carrier: 'webrtc' | 'signals',
    rttMs: number | null,
    jitterMs: number | null,
    lossPercent: number | null,
  ) => void;
  peerRecord: (k: AgentPubKeyB64) => PeerRecord | undefined;
  ensurePeerRecord: (k: AgentPubKeyB64) => PeerRecord;
  /** micSource.lifecycle, late-bound (micSource is constructed in
   *  start()). */
  micLifecycle: () => CaptureLifecycle;
  /** cameraSource.lifecycle, late-bound. */
  cameraLifecycle: () => CaptureLifecycle;
  /** StreamsStore.mainStream, late-bound — reassigned outside the
   *  constructor (audio/video acquire and disconnect paths). */
  mainStream: () => MediaStream | undefined | null;
  /** StreamsStore.webrtcStats, direct reference: the Map is mutable and
   *  is field-initialized before this owner is constructed, so no
   *  late-binding is needed to keep writes live. */
  webrtcStats: Map<AgentPubKeyB64, CarrierStats>;
  logger: PresenceLogger;
  now: () => number;
};

export class TrackHealthMonitor {
  constructor(private readonly bindings: TrackHealthBindings) {}

  /**
   * Checks inbound RTP bytesReceived for each open connection.
   * If bytes haven't increased for 2+ consecutive cycles (4+ seconds at 2s ping interval),
   * the track is considered dead and we request the sender to refresh via data channel.
   */
  async checkTrackHealth(): Promise<void> {
    const openConnections = this.bindings.openConnections();
    for (const [pubKeyB64, connInfo] of Object.entries(openConnections)) {
      if (!connInfo.connected) continue;
      // Don't gate on remote tracks here — RTT is observable from
      // candidate-pair.currentRoundTripTime (and from remote-inbound-rtp
      // once we're sending) even when the remote has neither mic nor
      // camera open. The per-kind dead-track detection further down has
      // its own (connInfo.video / connInfo.audio) gates and self-skips
      // when bytesReceived is 0, so removing the outer gate doesn't
      // perturb that path.

      try {
        const stats = await this.bindings.mediaTransport().getStats(pubKeyB64);
        if (!stats) continue;
        const reports: RtcStatsReportLike[] = [];
        stats.raw.forEach((report: RtcStatsReportLike) => reports.push(report));
        const summary = summarizeRtcStats(reports);

        this.bindings.webrtcStats.set(pubKeyB64, {
          rttMs: summary.rttMs,
          jitterMs: summary.jitterMs,
          lossPercent: summary.lossPercent,
        });
        this.bindings.maybeEmitQualityChange(
          pubKeyB64,
          'webrtc',
          summary.rttMs,
          summary.jitterMs,
          summary.lossPercent,
        );

        const record = this.bindings.peerRecord(pubKeyB64);
        const priorEscalations = record?.deadTrackEscalations ?? 0;
        const refreshBudget = deadTrackRefreshBudget(priorEscalations);
        const decision = decideTrackRefresh({
          videoExpected: connInfo.video,
          audioExpected: connInfo.audio,
          audioBytes: summary.audioBytes,
          videoBytes: summary.videoBytes,
          lastBytes: record?.lastBytesReceived || { audio: 0, video: 0 },
          staleCycles: record?.staleCycles || { audio: 0, video: 0 },
          staleThresholdCycles: STALE_CYCLES_REFRESH_THRESHOLD,
          refreshRequestsSent: record?.refreshRequestsSent ?? 0,
          refreshBudget,
          transportPhase: this.bindings.mediaTransport().getPhase(pubKeyB64),
          iceDisconnected: record?.iceDisconnectedAt !== undefined,
        });

        this.bindings.ensurePeerRecord(pubKeyB64).lastBytesReceived = {
          audio: summary.audioBytes,
          video: summary.videoBytes,
        };
        this.bindings.ensurePeerRecord(pubKeyB64).staleCycles = decision.nextStale;

        switch (decision.action) {
          case 'none':
            if (decision.resetRefreshBudget) {
              this.bindings.ensurePeerRecord(pubKeyB64).refreshRequestsSent = 0;
            }
            break;
          case 'request-refresh': {
            const stale = decision.nextStale;
            console.warn(
              `Dead track detected for ${pubKeyB64.slice(0, 8)}: audio stale=${stale.audio}, video stale=${stale.video}`
            );
            this.bindings.logger.logCustomMessage(
              `Dead track [${pubKeyB64.slice(0, 8)}]: audio=${stale.audio} video=${stale.video} cycles stale`
            );
            const r = this.bindings.ensurePeerRecord(pubKeyB64);
            // The budget counts ATTEMPTS, not deliveries (declared,
            // 2026-09-24 round): FsmTransport.send swallows every failure
            // (no FSM, not connected, throw), so delivery is unobservable
            // here, and a data channel that cannot carry the request is
            // itself evidence of a dead link. Escalation must not depend
            // on it. The stale reset keeps its pre-existing sent>0 rule.
            r.refreshRequestsSent = (r.refreshRequestsSent ?? 0) + 1;
            if (this.bindings.sendRtcAction('request-track-refresh', [pubKeyB64]) > 0) {
              r.staleCycles = { audio: 0, video: 0 };
            }
            break;
          }
          case 'escalate': {
            // Spec Part 1 (2026-09-24 incident): replaceTrack cannot
            // repair a transport-level fault, and the link was left
            // `connected` for 70s with no exit. Close through the
            // transport so the peer gets the `leave`; the existing
            // close-event cleanup row and the pong drive do the rest.
            const stale = decision.nextStale;
            const spent = record?.refreshRequestsSent ?? 0;
            this.bindings.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: this.bindings.now(),
              event: 'DeadTrackEscalation',
              connectionId: connInfo.connectionId,
              detail: `refreshes=${spent} budget=${refreshBudget} prior=${priorEscalations} audioStale=${stale.audio} videoStale=${stale.video}`,
            });
            // Bump the survivor BEFORE the close: media-close-full keeps
            // it, and the next connection reads it for its budget. Zero
            // the session counters too: when the close clears the slot
            // this is redundant; it is defense in depth for a close that
            // does not clear the slot (a throwing or no-op
            // closeConnection), so escalation cannot re-fire every poll.
            // The §3.1(c) vanish shape never reaches this arm: the
            // transport-phase hold in decideTrackRefresh covers it, and
            // the real transport's getStats returns null with no pc.
            const r = this.bindings.ensurePeerRecord(pubKeyB64);
            r.deadTrackEscalations = priorEscalations + 1;
            r.staleCycles = { audio: 0, video: 0 };
            r.refreshRequestsSent = 0;
            this.bindings.mediaTransport().closeConnection(pubKeyB64, 'dead-track-escalation');
            break;
          }
          default: {
            const exhaustive: never = decision;
            void exhaustive;
          }
        }
      } catch (e) {
        // getStats may fail if connection was already closed
      }
    }
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
    const reconcileCount = this.bindings.peerRecord(pubkey)?.reconcileAttemptCount || 0;
    const cooldown = BASE_COOLDOWN_MS * Math.pow(2, Math.min(reconcileCount, 4));
    const lastReconcile = this.bindings.peerRecord(pubkey)?.lastReconcileTime || 0;
    if (this.bindings.now() - lastReconcile < cooldown) return;

    const mainStream = this.bindings.mainStream();
    if (!mainStream) return;

    // Case 1: Peer doesn't see our stream at all — re-add the whole stream
    if (!streamAndTrackInfo.stream) {
      console.warn(
        'Peer does not seem to see our own stream. Re-adding it to their peer object...'
      );
      this.bindings.logger.logAgentEvent({
        agent: pubkey,
        timestamp: this.bindings.now(),
        event: 'ReconcileStream',
      });
      const conn = this.bindings.openConnections()[pubkey];
      if (conn) {
        // Repair on the media transport, but only when it actually holds
        // this peer (the hasConnection guard below). History: before
        // Phase 3 this addressed the bare SimplePeer transport, whose
        // addTrack iterates its own connection map — a silent no-op for
        // FSM-carried peers that still consumed the cooldown and attempt
        // budget (MAINTAINABILITY_ASSESSMENT.md §3.12). With one
        // transport since Phase 3, the wrong-map failure mode is gone;
        // the guard remains because a slot can outlive transport state.
        // Transport-level addTrack (updateLocalStream) is chosen over
        // per-peer pc.addTrack so the FSM's own negotiation stays in
        // charge of the renegotiation.
        const transport = this.bindings.mediaTransport();
        if (!transport.hasConnection(pubkey)) {
          // The slot has outlived the transport's own state; there is
          // nothing to add a track to. Return without recording an
          // attempt — burning the budget on a no-op is what let this
          // defect hide.
          this.bindings.logger.logCustomMessage(
            `Reconcile skipped [${pubkey.slice(0, 8)}]: no transport connection`,
          );
          return;
        }
        try {
          for (const track of mainStream.getTracks()) {
            transport.addTrack(track, mainStream);
          }
          this.bindings.ensurePeerRecord(pubkey).lastReconcileTime = this.bindings.now();
          this.bindings.ensurePeerRecord(pubkey).reconcileAttemptCount = reconcileCount + 1;
        } catch (e: any) {
          console.warn('Failed to re-add stream during reconcile:', e.message);
        }
      }
      return;
    }

    const connInfo = this.bindings.openConnections()[pubkey];
    if (!connInfo) return;

    const myAudioTrack = mainStream.getAudioTracks()[0];
    const myVideoTrack = mainStream.getVideoTracks()[0];

    let needsRecovery = false;

    // Check audio track
    if (myAudioTrack) {
      const perceived = streamAndTrackInfo.tracks.find(t => t.kind === 'audio');
      if (!perceived || perceived.muted) {
        needsRecovery = true;
        this.bindings.logger.logAgentEvent({ agent: pubkey, timestamp: this.bindings.now(), event: 'ReconcileAudio' });
      }
    }

    // Check video track
    if (myVideoTrack) {
      const perceived = streamAndTrackInfo.tracks.find(t => t.kind === 'video');
      if (!perceived || perceived.muted) {
        needsRecovery = true;
        this.bindings.logger.logAgentEvent({ agent: pubkey, timestamp: this.bindings.now(), event: 'ReconcileVideo' });
      }
    }

    if (!needsRecovery) {
      // Tracks are healthy — reset attempt count
      this.bindings.ensurePeerRecord(pubkey).reconcileAttemptCount = 0;
      return;
    }

    console.warn(`Reconciling tracks for ${pubkey.slice(0, 8)} (attempt ${reconcileCount + 1})`);

    // Try lightweight replaceTrack first
    const success = this._tryReplaceTrackRecovery(pubkey, connInfo, myAudioTrack, myVideoTrack);

    if (!success) {
      // Fall back to heavier clone approach
      this._cloneStreamRecovery(pubkey, connInfo, myAudioTrack, myVideoTrack);
    }

    this.bindings.ensurePeerRecord(pubkey).lastReconcileTime = this.bindings.now();
    this.bindings.ensurePeerRecord(pubkey).reconcileAttemptCount = reconcileCount + 1;
  }

  /**
   * Attempt lightweight track recovery: the transport's per-peer
   * `refreshMediaForPeer` replaces each sender's track with the matching
   * mainStream track (forcing re-encoding) without perturbing other
   * peers, and adds a track that has no sender yet. Returns true if the
   * peer had a live connection to refresh, false if the heavier
   * reconnect fallback is needed.
   *
   * Declared behavior change (Phase 4 item 3): a missing sender for one
   * kind no longer fails the whole recovery into a full reconnect — the
   * transport adds the track in place (one renegotiation instead of a
   * teardown + InitRequest cycle).
   */
  private _tryReplaceTrackRecovery(
    pubkey: AgentPubKeyB64,
    _connInfo: OpenConnectionInfo,
    _audioTrack: MediaStreamTrack | undefined,
    _videoTrack: MediaStreamTrack | undefined
  ): boolean {
    const mainStream = this.bindings.mainStream();
    if (!mainStream) return false;
    try {
      const ok = this.bindings.mediaTransport().refreshMediaForPeer(pubkey, mainStream);
      this.bindings.logger.logCustomMessage(
        `replaceTrack [${pubkey.slice(0, 8)}]: ${ok ? 'refreshed via transport' : 'no live connection'}`
      );
      return ok;
    } catch (e: any) {
      console.warn(`replaceTrack recovery failed for ${pubkey.slice(0, 8)}:`, e.message);
      this.bindings.logger.logCustomMessage(`replaceTrack [${pubkey.slice(0, 8)}]: failed -- ${e.message}`);
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
    if (!this.bindings.mainStream()) return;
    console.warn(`Falling back to reconnect-based recovery for ${pubkey.slice(0, 8)}`);
    this.bindings.logger.logCustomMessage(`Reconnect recovery [${pubkey.slice(0, 8)}]`);
    this.bindings.mediaTransport().closeConnection(pubkey, 'clone-recovery fallback');
  }

  /**
   * Public method for manual track recovery. Tries replaceTrack first,
   * falls back to clone approach. Does not tear down the WebRTC connection.
   */
  refreshTracksForPeer(pubKeyB64: AgentPubKeyB64): boolean {
    const mainStream = this.bindings.mainStream();
    const connInfo = this.bindings.openConnections()[pubKeyB64];
    // Forensics (2026-09-24 incident, spec Part 2): the peer says our
    // media is dead. Record what our sender thinks it sent, so an export
    // shows whether the encoder or the path is at fault. Fire-and-forget;
    // this method stays synchronous for its data-channel caller.
    if (connInfo) void this._logOutboundForRefresh(pubKeyB64);
    if (!connInfo || !mainStream) {
      console.warn(`Cannot refresh tracks for ${pubKeyB64.slice(0, 8)}: no connection or stream`);
      return false;
    }
    const myAudioTrack = mainStream.getAudioTracks()[0];
    const myVideoTrack = mainStream.getVideoTracks()[0];

    // Task 3 replacement #4 (Incident B): refuse to push a track whose
    // source is not live — replaceTrack'ing a dead track and logging
    // "refreshed via transport" was the dishonest success that hid the
    // wedge. Defer to the reconciler's reopen fanout; return false so a
    // later real recovery (`_cloneStreamRecovery`) stays available.
    const audioDead = !!myAudioTrack && this.bindings.micLifecycle().state !== 'live';
    const videoDead = !!myVideoTrack && this.bindings.cameraLifecycle().state !== 'live';
    if (audioDead || videoDead) {
      this.bindings.logger.logCustomMessage(
        `Track refresh [${pubKeyB64.slice(0, 8)}]: source dead, deferring to capture reconciler`
      );
      return false;
    }

    this.bindings.logger.logCustomMessage(
      `Track refresh [${pubKeyB64.slice(0, 8)}]: audio=${myAudioTrack ? `${myAudioTrack.enabled ? 'enabled' : 'disabled'},${myAudioTrack.muted ? 'muted' : 'unmuted'},${myAudioTrack.readyState}` : 'none'} video=${myVideoTrack ? `${myVideoTrack.enabled ? 'enabled' : 'disabled'},${myVideoTrack.muted ? 'muted' : 'unmuted'},${myVideoTrack.readyState}` : 'none'}`
    );

    const success = this._tryReplaceTrackRecovery(pubKeyB64, connInfo, myAudioTrack, myVideoTrack);
    if (!success) {
      this._cloneStreamRecovery(pubKeyB64, connInfo, myAudioTrack, myVideoTrack);
    }
    this.bindings.logger.logCustomMessage(
      `Manual track refresh [${pubKeyB64.slice(0, 8)}]: ${success ? 'replaceTrack' : 'clone fallback'}`
    );
    return success;
  }

  private async _logOutboundForRefresh(pubKeyB64: AgentPubKeyB64): Promise<void> {
    try {
      const stats = await this.bindings.mediaTransport().getStats(pubKeyB64);
      if (!stats) return;
      const reports: RtcStatsReportLike[] = [];
      stats.raw.forEach((report: RtcStatsReportLike) => reports.push(report));
      const s = summarizeRtcStats(reports);
      this.bindings.logger.logCustomMessage(
        `Track refresh outbound [${pubKeyB64.slice(0, 8)}]: audioSent=${s.audioBytesSent} videoSent=${s.videoBytesSent} rtt=${s.rttMs ?? 'n/a'}ms`
      );
    } catch (_e) {
      // getStats may fail if the connection was already closed
    }
  }
}
