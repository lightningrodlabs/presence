/**
 * PeerRecord — the ONE per-peer state record (store-decomposition round
 * one; docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md).
 * Fields are grouped by lifecycle class; `resetPeerRecord` (Task 4) is
 * the one authority for what survives which teardown.
 *
 * INVARIANT: record existence is never a liveness predicate. Presence
 * and membership have their own authorities (`_presentPeers`,
 * `_activeAgents`, `_knownAgents`); nothing may iterate `_peerRecords`
 * or test row existence to answer "who is here". A row may outlive the
 * peer (the leave reset keeps `connectionEpoch` — monotonic for the
 * session, see docs/WEBRTC_RECONNECT_IDENTITY.md).
 */
import type { PendingInit } from './types';

export type PeerRecord = {
  // — media-session bookkeeping: reset on media close
  /**
   * Timestamp at which a video peer's iceConnectionState most recently
   * entered 'disconnected', for the grace-period recovery window in
   * stale cleanup. Maintained by `_handleMediaIceDiagnostic` from the
   * transport's `ice-diagnostic` events; the invariant is that this is
   * set iff the connection's iceConnectionState is currently
   * 'disconnected'. Cleared on entry to any other ICE state, on
   * close-cleanup, and on the supersede paths.
   */
  iceDisconnectedAt?: number;
  /** Last bytesReceived value per track kind, for dead-track detection via getStats(). */
  lastBytesReceived?: { audio: number; video: number };
  /** Consecutive health-check cycles where bytesReceived did not increase. */
  staleCycles?: { audio: number; video: number };
  /** Consecutive reconciliation attempts, for exponential backoff of the cooldown. */
  reconcileAttemptCount?: number;
  /**
   * Last-emitted quality bucket, e.g. `"webrtc:ok:clean"`. Dedupes so
   * QualityBucketChange events only fire when the bucket actually
   * changes rather than every poll cycle.
   */
  qualityBucket?: string;
  /**
   * Most recent reason this peer left the `connected` webrtc phase,
   * captured from the FSM transition that took it out of `connected`
   * (e.g. "disconnectFromPeerVideo", "peer left", "transport failure:
   * dtls-failed"). Read by `_handleMediaClosed` to annotate the
   * `CarrierSwitch fsm->signals` downgrade with *why* webrtc was
   * abandoned (§6.6).
   */
  webrtcExitReason?: string;
  videoStream?: MediaStream;
  pendingInits?: PendingInit[];
  /** clock.setTimeout handle; the executor disarms before dropping. */
  sdpTimeoutTimer?: number;
  /**
   * WebRTC AnalyserNode for reading this peer's incoming audio level.
   * Created when a peer stream arrives, removed on disconnect. The
   * audio-level-meter element polls it at 10fps.
   */
  analyser?: { node: AnalyserNode; buffer: Uint8Array };
  /**
   * Audibility-outage tracking. When our audioLink to this peer has been
   * 'down' or 'negotiating' for ≥ OUTAGE_THRESHOLD_MS, *and* some third
   * peer reports being audible to that target, we emit an
   * AudibilityOutageStart event. The `emitted` flag guards against
   * multiple Starts per outage and tells the End side whether to fire on
   * recovery. Populated / drained by `_checkAudibilityOutages` on the 2s
   * ping tick. Managed solely by the outage sweep — no reset arm
   * touches it.
   */
  outageState?: { startedAt: number; emitted: boolean };
  // — screen-share session: reset on the screen-share close rows
  screenShareStream?: MediaStream; // incoming
  /**
   * As `iceDisconnectedAt`, but for outgoing screen-share peers. Kept
   * separate because a single agent can have both a video connection and
   * an outgoing screen-share connection in flight with independent ICE
   * states; one going 'disconnected' must not affect the other's grace.
   */
  screenShareIceDisconnectedAt?: number; // outgoing
  // — close survivors: reset only on peer-leave
  /**
   * Timestamp of the last connection close/error for this peer, used to
   * log the retry gap when a new InitRequest is created.
   */
  lastDisconnectTime?: number;
  /**
   * Last time reconcileVideoStreamState was triggered for this peer, to
   * avoid firing more than once per 30s interval.
   */
  lastReconcileTime?: number;
  /**
   * Rolling EWMA of signals-carrier RTT for this peer. Smooths out noise
   * from jitter on individual ping/pong round trips.
   */
  signalsRttEwma?: number;
  // — session survivor: never reset
  /**
   * Monotonic per-peer connection generation ("epoch"). Allocated by the
   * initiator on each new connection attempt and passed into the FSM
   * transport, which stamps it on outgoing signals and uses it for
   * cross-attempt "newest-wins" ordering. Because it lives on the store
   * (which outlives any FSM), it does NOT reset when an FSM is torn down
   * and recreated — unlike the FSM's own `peerSessionId`, which resets to
   * 0 per instance and so cannot order signals across a reconnect. Never
   * reset for the session (a rejoining peer gets a strictly higher epoch,
   * so in-flight stale signals stay older). See
   * docs/WEBRTC_RECONNECT_IDENTITY.md.
   */
  connectionEpoch: number;
};

export function initialPeerRecord(): PeerRecord {
  return { connectionEpoch: 0 };
}

export type PeerRecordResetArm =
  | 'media-close-full'
  | 'media-stale-residue'
  | 'media-leave-residue'
  | 'screen-out-close'
  | 'screen-in-close';

/**
 * The ONE authority for which PeerRecord fields survive which teardown.
 * Arms mirror closeCleanupPlan's distinct per-peer clear signatures
 * (strict fidelity to the pre-fold table — see
 * docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md,
 * "Lifecycle: resetPeerRecord and the closeCleanupPlan collapse"). Field
 * groups and arm × field expectations are pinned in
 * `__tests__/peer-record.test.ts`. `sdpTimeoutTimer` and `outageState`
 * are never arm-owned: the timer is executor-disarmed, the outage state
 * sweep-owned.
 */
export function resetPeerRecord(r: PeerRecord, arm: PeerRecordResetArm): PeerRecord {
  switch (arm) {
    case 'media-close-full':
      return {
        ...r,
        iceDisconnectedAt: undefined, lastBytesReceived: undefined,
        staleCycles: undefined, reconcileAttemptCount: undefined,
        qualityBucket: undefined, webrtcExitReason: undefined,
        videoStream: undefined, pendingInits: undefined, analyser: undefined,
      };
    case 'media-stale-residue':
      return { ...r, videoStream: undefined, pendingInits: undefined };
    case 'media-leave-residue':
      return {
        ...r, videoStream: undefined, pendingInits: undefined,
        qualityBucket: undefined, lastDisconnectTime: undefined,
        lastReconcileTime: undefined, signalsRttEwma: undefined,
      };
    case 'screen-out-close':
      return { ...r, screenShareIceDisconnectedAt: undefined };
    case 'screen-in-close':
      return { ...r, screenShareStream: undefined };
    default: {
      const exhaustive: never = arm;
      return exhaustive;
    }
  }
}

/**
 * Prune expired pending-init entries (PENDING_HANDSHAKE_TTL_MS sweep).
 * Returns undefined when none survive — the field-level equivalent of
 * the pre-fold pruneExpiredPending dropping empty rows.
 */
export function prunePendingInits(
  entries: PendingInit[],
  now: number,
  ttlMs: number,
): PendingInit[] | undefined {
  const remaining = entries.filter(e => now - e.t0 <= ttlMs);
  return remaining.length > 0 ? remaining : undefined;
}
