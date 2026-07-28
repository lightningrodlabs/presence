/**
 * Phase 2b — pure decision logic for the WebRTC track-health poll.
 *
 * Every 2s, `StreamsStore._checkTrackHealth` polls `pc.getStats()` for each
 * connected peer and answers two questions:
 *
 *   1. What are the display stats for this link (RTT, jitter, loss)?
 *   2. Are the tracks we expect to be flowing actually flowing — and if
 *      they have been frozen long enough, should we ask the peer to
 *      re-send them?
 *
 * Both answers were computed inline; roughly 100 of the method's 144 lines
 * touched no `this` and are moved here verbatim so they can be table tested
 * without a `StreamsStore` instance (which cannot be built under vitest;
 * see CLAUDE.md). The store keeps the I/O: getStats, the store writes, and
 * the request-track-refresh send.
 *
 * Constrains `streams-store.ts:_checkTrackHealth`.
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

  return { audioBytes, videoBytes, rttMs, jitterMs, lossPercent };
}

export type StaleCycleCounts = { audio: number; video: number };

/**
 * Consecutive poll cycles a track's byte counter may sit frozen before we
 * ask the peer to re-send. At the 2s poll interval this is 4+ seconds.
 * Serves the media-flowing predicate; the counters it thresholds are
 * advanced once per `_checkTrackHealth` poll.
 */
export const STALE_CYCLES_REFRESH_THRESHOLD = 2;

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
};

export type TrackRefreshDecision =
  | {
      action: 'request-refresh';
      nextStale: StaleCycleCounts;
      reason: 'stale-cycles-exceeded';
    }
  | { action: 'none'; nextStale: StaleCycleCounts; reason: 'flowing' };

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

  if (
    nextStale.video >= input.staleThresholdCycles ||
    nextStale.audio >= input.staleThresholdCycles
  ) {
    return { action: 'request-refresh', nextStale, reason: 'stale-cycles-exceeded' };
  }
  return { action: 'none', nextStale, reason: 'flowing' };
}
