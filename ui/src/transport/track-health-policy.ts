/**
 * Phase 2b — pure decision logic for the WebRTC track-health poll.
 *
 * Every 2s, `TrackHealthMonitor.checkTrackHealth` (`ui/src/track-health.ts`)
 * polls `pc.getStats()` for each connected peer and answers two questions:
 *
 *   1. What are the display stats for this link (RTT, jitter, loss)?
 *   2. Are the tracks we expect to be flowing actually flowing — and if
 *      they have been frozen long enough, should we ask the peer to
 *      re-send them?
 *
 * Both answers were computed inline; roughly 100 of the method's 144 lines
 * touched no `this` and are moved here verbatim so they can be table tested
 * without a `StreamsStore` or `TrackHealthMonitor` instance. `TrackHealthMonitor`
 * (store-decomposition round two, Task 4) keeps the I/O: getStats, the peer-
 * record writes, and the request-track-refresh send.
 *
 * Constrains `ui/src/track-health.ts:TrackHealthMonitor.checkTrackHealth`.
 */

/**
 * The subset of an RTCStats report this policy reads. Reports are produced
 * by the browser and vary by type; every field is optional and unknown
 * report types are skipped.
 */
export type RtcStatsReportLike = {
  type?: string;
  /** Some browsers report `kind`, older ones `mediaType`. */
  kind?: string;
  mediaType?: string;
  bytesReceived?: number;
  /** outbound-rtp: our sender's counter. Forensics only (spec Part 2). */
  bytesSent?: number;
  /** Seconds, per spec. */
  jitter?: number;
  packetsReceived?: number;
  packetsLost?: number;
  /** remote-inbound-rtp: seconds. */
  roundTripTime?: number;
  /** candidate-pair fields. */
  state?: string;
  currentRoundTripTime?: number;
};

export type RtcStatsSummary = {
  /** inbound-rtp bytesReceived per kind; 0 when the kind is absent. */
  audioBytes: number;
  videoBytes: number;
  /** outbound-rtp bytesSent per kind; 0 when the kind is absent. Read by
   *  the request-track-refresh receipt log only, never by a decision. */
  audioBytesSent: number;
  videoBytesSent: number;
  /**
   * RTT in whole ms. remote-inbound-rtp (our outgoing direction) is
   * preferred; candidate-pair (ICE-level) is the fallback. Null when
   * neither reported.
   */
  rttMs: number | null;
  /**
   * Jitter in ms, 0.1 precision. Audio preferred when both kinds have
   * packet counts (more time-sensitive); video otherwise; null when
   * neither kind has seen a packet.
   */
  jitterMs: number | null;
  /** Loss percent, 0.1 precision, same kind-preference as jitter. */
  lossPercent: number | null;
};

export function summarizeRtcStats(reports: RtcStatsReportLike[]): RtcStatsSummary {
  let audioBytes = 0;
  let videoBytes = 0;
  let audioBytesSent = 0;
  let videoBytesSent = 0;
  let audioJitter: number | null = null;
  let audioPacketsReceived = 0;
  let audioPacketsLost = 0;
  let videoJitter: number | null = null;
  let videoPacketsReceived = 0;
  let videoPacketsLost = 0;
  let rttMs: number | null = null;
  let candPairRttMs: number | null = null;

  for (const report of reports) {
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
    if (report.type === 'outbound-rtp') {
      const kind = report.kind || report.mediaType;
      if (kind === 'audio') {
        audioBytesSent = report.bytesSent || 0;
      } else if (kind === 'video') {
        videoBytesSent = report.bytesSent || 0;
      }
    }
    if (
      report.type === 'remote-inbound-rtp' &&
      typeof report.roundTripTime === 'number'
    ) {
      rttMs = Math.round(report.roundTripTime * 1000);
    }
    if (
      report.type === 'candidate-pair' &&
      report.state === 'succeeded' &&
      typeof report.currentRoundTripTime === 'number'
    ) {
      candPairRttMs = Math.round(report.currentRoundTripTime * 1000);
    }
  }

  if (rttMs === null) rttMs = candPairRttMs;

  const hasAudio = audioPacketsReceived + audioPacketsLost > 0;
  const hasVideo = videoPacketsReceived + videoPacketsLost > 0;
  const jitter = hasAudio ? audioJitter : hasVideo ? videoJitter : null;
  const pktsRecv = hasAudio
    ? audioPacketsReceived
    : hasVideo
      ? videoPacketsReceived
      : 0;
  const pktsLost = hasAudio ? audioPacketsLost : hasVideo ? videoPacketsLost : 0;
  const totalPackets = pktsRecv + pktsLost;

  const jitterMs = jitter !== null ? Math.round(jitter * 1000 * 10) / 10 : null;
  const lossPercent =
    totalPackets > 0 ? Math.round((pktsLost / totalPackets) * 1000) / 10 : null;

  return { audioBytes, videoBytes, audioBytesSent, videoBytesSent, rttMs, jitterMs, lossPercent };
}

export type StaleCycleCounts = { audio: number; video: number };

/**
 * Consecutive poll cycles a track's byte counter may sit frozen before we
 * ask the peer to re-send. At the 2s poll interval this is 4+ seconds.
 * Serves the media-flowing predicate; the counters it thresholds are
 * advanced once per `TrackHealthMonitor.checkTrackHealth` poll.
 */
export const STALE_CYCLES_REFRESH_THRESHOLD = 2;

/**
 * Refresh requests a connection may spend on a frozen track before the
 * receiver escalates to a close + re-establish. Serves the media-flowing
 * predicate on the track-health poll's clock (`PING_INTERVAL`): with
 * STALE_CYCLES_REFRESH_THRESHOLD = 2 and a 2s poll, requests go out at
 * t≈4/8/12s and escalation fires at t≈16s. NOT a liveness constant.
 * 2026-09-24 incident: 18 dead-track cycles over 70s with no exit.
 */
export const DEAD_TRACK_REFRESH_BUDGET = 3;

/**
 * Cap on the doubling of the budget across successive escalations to
 * the same peer (3, 6, 12, 24, 24, …). Bounds a pathological loop where
 * the fresh connection is also dead, without ever giving up.
 */
export const DEAD_TRACK_ESCALATION_BACKOFF_CAP = 3;

/** The refresh budget for a connection, given how many times this peer
 *  has already been escalated since it last left. */
export function deadTrackRefreshBudget(priorEscalations: number): number {
  const exp = Math.max(0, Math.min(priorEscalations, DEAD_TRACK_ESCALATION_BACKOFF_CAP));
  return DEAD_TRACK_REFRESH_BUDGET << exp;
}

export type TrackRefreshInputs = {
  /** Whether the slot expects this kind to be flowing (`conn.video` / `conn.audio`). */
  videoExpected: boolean;
  audioExpected: boolean;
  /** This cycle's inbound byte counters, from `summarizeRtcStats`. */
  audioBytes: number;
  videoBytes: number;
  /** Last cycle's byte counters. */
  lastBytes: StaleCycleCounts;
  /** Consecutive-frozen counts carried over from last cycle. */
  staleCycles: StaleCycleCounts;
  staleThresholdCycles: number;
  /** Refresh requests already sent on this connection without bytes
   *  resuming (the peer record's `refreshRequestsSent`). */
  refreshRequestsSent: number;
  /** Requests allowed before escalation: `deadTrackRefreshBudget(...)`. */
  refreshBudget: number;
};

export type TrackRefreshDecision =
  | {
      action: 'request-refresh';
      nextStale: StaleCycleCounts;
      reason: 'stale-cycles-exceeded';
    }
  | {
      /** The budget is spent: close the connection and let the pong
       *  drive re-establish it. */
      action: 'escalate';
      nextStale: StaleCycleCounts;
      reason: 'refresh-budget-exhausted';
    }
  | {
      action: 'none';
      nextStale: StaleCycleCounts;
      reason: 'flowing';
      /** True when both counters are zero (bytes resumed on every
       *  expected kind): the caller zeroes `refreshRequestsSent`. */
      resetRefreshBudget: boolean;
    };

/**
 * Advance the per-kind frozen-counters and decide whether to request a
 * track refresh.
 *
 * A kind's counter only moves while the slot expects it *and* bytes have
 * ever arrived (`bytes > 0`) — a track that never started is the
 * establishment path's problem, not a dead track. The threshold check
 * reads the advanced counters unconditionally, so a counter that crossed
 * the threshold in an earlier cycle still fires even if its kind stopped
 * being expected this cycle — exactly what the inline code did.
 *
 * The caller resets the counters to zero only after the refresh request
 * was actually sent; a send failure keeps them, so the next cycle retries.
 * The caller increments `refreshRequestsSent` on the same condition.
 * `escalate` replaces `request-refresh` once that count reaches
 * `refreshBudget`; a `none` with `resetRefreshBudget` zeroes it.
 */
export function decideTrackRefresh(input: TrackRefreshInputs): TrackRefreshDecision {
  const nextStale: StaleCycleCounts = { ...input.staleCycles };

  if (input.videoExpected && input.videoBytes > 0) {
    if (input.videoBytes === input.lastBytes.video) {
      nextStale.video++;
    } else {
      nextStale.video = 0;
    }
  }

  if (input.audioExpected && input.audioBytes > 0) {
    if (input.audioBytes === input.lastBytes.audio) {
      nextStale.audio++;
    } else {
      nextStale.audio = 0;
    }
  }

  const crossed =
    nextStale.video >= input.staleThresholdCycles ||
    nextStale.audio >= input.staleThresholdCycles;
  if (crossed) {
    if (input.refreshRequestsSent >= input.refreshBudget) {
      return { action: 'escalate', nextStale, reason: 'refresh-budget-exhausted' };
    }
    return { action: 'request-refresh', nextStale, reason: 'stale-cycles-exceeded' };
  }
  return {
    action: 'none',
    nextStale,
    reason: 'flowing',
    resetRefreshBudget: nextStale.audio === 0 && nextStale.video === 0,
  };
}
