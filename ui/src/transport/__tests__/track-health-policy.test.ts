import { describe, it, expect } from 'vitest';
import {
  summarizeRtcStats,
  decideTrackRefresh,
  deadTrackRefreshBudget,
  DEAD_TRACK_ESCALATION_BACKOFF_CAP,
  DEAD_TRACK_REFRESH_BUDGET,
  STALE_CYCLES_REFRESH_THRESHOLD,
} from '../track-health-policy';
import type {
  RtcStatsReportLike,
  TrackRefreshInputs,
} from '../track-health-policy';

// ---------------------------------------------------------------------------
// summarizeRtcStats
// ---------------------------------------------------------------------------

const audioInbound = (over: Partial<RtcStatsReportLike> = {}): RtcStatsReportLike => ({
  type: 'inbound-rtp',
  kind: 'audio',
  bytesReceived: 1000,
  jitter: 0.012,
  packetsReceived: 90,
  packetsLost: 10,
  ...over,
});

const videoInbound = (over: Partial<RtcStatsReportLike> = {}): RtcStatsReportLike => ({
  type: 'inbound-rtp',
  kind: 'video',
  bytesReceived: 50_000,
  jitter: 0.03,
  packetsReceived: 400,
  packetsLost: 100,
  ...over,
});

const audioOutbound = (over: Partial<RtcStatsReportLike> = {}): RtcStatsReportLike => ({
  type: 'outbound-rtp',
  kind: 'audio',
  bytesSent: 7000,
  ...over,
});

const videoOutbound = (over: Partial<RtcStatsReportLike> = {}): RtcStatsReportLike => ({
  type: 'outbound-rtp',
  kind: 'video',
  bytesSent: 90_000,
  ...over,
});

describe('summarizeRtcStats', () => {
  it('returns all-null / zero for an empty report set', () => {
    expect(summarizeRtcStats([])).toEqual({
      audioBytes: 0,
      videoBytes: 0,
      audioBytesSent: 0,
      videoBytesSent: 0,
      rttMs: null,
      jitterMs: null,
      lossPercent: null,
    });
  });

  it('prefers audio jitter/loss when both kinds have packets', () => {
    const s = summarizeRtcStats([audioInbound(), videoInbound()]);
    expect(s.audioBytes).toBe(1000);
    expect(s.videoBytes).toBe(50_000);
    // audio: 0.012s -> 12ms; 10 lost of 100 -> 10%
    expect(s.jitterMs).toBe(12);
    expect(s.lossPercent).toBe(10);
  });

  it('falls back to video jitter/loss when audio has no packets', () => {
    const s = summarizeRtcStats([
      audioInbound({ packetsReceived: 0, packetsLost: 0 }),
      videoInbound(),
    ]);
    // video: 0.03s -> 30ms; 100 lost of 500 -> 20%
    expect(s.jitterMs).toBe(30);
    expect(s.lossPercent).toBe(20);
  });

  it('accepts mediaType as the kind field (older browsers)', () => {
    const s = summarizeRtcStats([audioInbound({ kind: undefined, mediaType: 'audio' })]);
    expect(s.audioBytes).toBe(1000);
  });

  it('reads outbound-rtp bytesSent per kind (sender-side forensics)', () => {
    const s = summarizeRtcStats([audioOutbound(), videoOutbound()]);
    expect(s.audioBytesSent).toBe(7000);
    expect(s.videoBytesSent).toBe(90_000);
    // Outbound reports contribute nothing to the inbound-derived fields.
    expect(s.audioBytes).toBe(0);
    expect(s.videoBytes).toBe(0);
    expect(s.jitterMs).toBeNull();
    expect(s.lossPercent).toBeNull();
  });

  it('accepts mediaType in place of kind on outbound-rtp too', () => {
    const s = summarizeRtcStats([audioOutbound({ kind: undefined, mediaType: 'audio' })]);
    expect(s.audioBytesSent).toBe(7000);
  });

  it('prefers remote-inbound-rtp RTT over the candidate-pair fallback', () => {
    const s = summarizeRtcStats([
      { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.2 },
      { type: 'remote-inbound-rtp', roundTripTime: 0.05 },
    ]);
    expect(s.rttMs).toBe(50);
  });

  it('uses the candidate-pair RTT when remote-inbound-rtp is absent', () => {
    const s = summarizeRtcStats([
      { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.2 },
    ]);
    expect(s.rttMs).toBe(200);
  });

  it('ignores candidate pairs that have not succeeded', () => {
    const s = summarizeRtcStats([
      { type: 'candidate-pair', state: 'in-progress', currentRoundTripTime: 0.2 },
    ]);
    expect(s.rttMs).toBeNull();
  });

  it('a remote-inbound RTT of 0 is a measurement, not absence', () => {
    const s = summarizeRtcStats([
      { type: 'remote-inbound-rtp', roundTripTime: 0 },
      { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.2 },
    ]);
    // rttMs computes to 0, which is null-checked by `=== null`, not
    // truthiness — the candidate-pair fallback must NOT override it.
    expect(s.rttMs).toBe(0);
  });

  it('a jitter of 0 rounds to 0, not to null', () => {
    const s = summarizeRtcStats([audioInbound({ jitter: 0 })]);
    expect(s.jitterMs).toBe(0);
  });

  it('rounds jitter to 0.1ms and loss to 0.1%', () => {
    const s = summarizeRtcStats([
      audioInbound({ jitter: 0.01234, packetsReceived: 997, packetsLost: 3 }),
    ]);
    expect(s.jitterMs).toBe(12.3);
    expect(s.lossPercent).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// decideTrackRefresh
// ---------------------------------------------------------------------------

const base: TrackRefreshInputs = {
  videoExpected: true,
  audioExpected: true,
  audioBytes: 2000,
  videoBytes: 60_000,
  lastBytes: { audio: 1000, video: 50_000 },
  staleCycles: { audio: 0, video: 0 },
  staleThresholdCycles: STALE_CYCLES_REFRESH_THRESHOLD,
  refreshRequestsSent: 0,
  refreshBudget: DEAD_TRACK_REFRESH_BUDGET,
};

describe('decideTrackRefresh', () => {
  it('bytes advancing resets the counters and requests nothing', () => {
    expect(decideTrackRefresh(base)).toEqual({
      action: 'none',
      nextStale: { audio: 0, video: 0 },
      reason: 'flowing',
      resetRefreshBudget: true,
    });
  });

  it('frozen bytes increment the stale counter for that kind only', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 1000, // === lastBytes.audio
    });
    expect(d).toEqual({
      action: 'none',
      nextStale: { audio: 1, video: 0 },
      reason: 'flowing',
      resetRefreshBudget: false,
    });
  });

  it('requests a refresh once a counter reaches the threshold', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 1000,
      staleCycles: { audio: 1, video: 0 },
    });
    expect(d).toEqual({
      action: 'request-refresh',
      nextStale: { audio: 2, video: 0 },
      reason: 'stale-cycles-exceeded',
    });
  });

  it('a kind that is not expected does not advance its counter', () => {
    const d = decideTrackRefresh({
      ...base,
      videoExpected: false,
      videoBytes: 50_000, // frozen, but video is off
      audioBytes: 1000, // frozen
    });
    expect(d.nextStale).toEqual({ audio: 1, video: 0 });
  });

  it('a track that never started (bytes 0) is not a dead track', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 0,
      lastBytes: { audio: 0, video: 50_000 },
    });
    expect(d.nextStale.audio).toBe(0);
    expect(d.action).toBe('none');
  });

  it('a counter already over threshold still fires when its kind stopped being expected', () => {
    // Inherited from the inline code: the threshold check reads the
    // carried-over counters unconditionally.
    const d = decideTrackRefresh({
      ...base,
      videoExpected: false,
      staleCycles: { audio: 0, video: 2 },
    });
    expect(d.action).toBe('request-refresh');
  });

  it('does not mutate the caller-owned staleCycles object', () => {
    const staleCycles = { audio: 1, video: 0 };
    decideTrackRefresh({ ...base, audioBytes: 1000, staleCycles });
    expect(staleCycles).toEqual({ audio: 1, video: 0 });
  });

  it('escalates instead of requesting once the refresh budget is spent', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 1000,
      staleCycles: { audio: 1, video: 0 },
      refreshRequestsSent: DEAD_TRACK_REFRESH_BUDGET,
    });
    expect(d).toEqual({
      action: 'escalate',
      nextStale: { audio: 2, video: 0 },
      reason: 'refresh-budget-exhausted',
    });
  });

  it('still requests while the budget has room', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 1000,
      staleCycles: { audio: 1, video: 0 },
      refreshRequestsSent: DEAD_TRACK_REFRESH_BUDGET - 1,
    });
    expect(d.action).toBe('request-refresh');
  });

  it('a larger budget (prior escalations) delays escalation', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 1000,
      staleCycles: { audio: 1, video: 0 },
      refreshRequestsSent: DEAD_TRACK_REFRESH_BUDGET,
      refreshBudget: deadTrackRefreshBudget(1),
    });
    expect(d.action).toBe('request-refresh');
  });

  it('never-started kinds do not move counters or escalate (Review Focus 1)', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 0,
      videoBytes: 0,
      lastBytes: { audio: 0, video: 0 },
      refreshRequestsSent: 99,
      refreshBudget: 1,
    });
    expect(d).toEqual({
      action: 'none',
      nextStale: { audio: 0, video: 0 },
      reason: 'flowing',
      resetRefreshBudget: true,
    });
  });

  it('a partially frozen link does not reset the budget', () => {
    const d = decideTrackRefresh({
      ...base,
      videoBytes: 50_000, // frozen
      staleCycles: { audio: 0, video: 0 },
    });
    expect(d).toEqual({
      action: 'none',
      nextStale: { audio: 0, video: 1 },
      reason: 'flowing',
      resetRefreshBudget: false,
    });
  });
});

describe('deadTrackRefreshBudget', () => {
  it.each([
    [0, 3],
    [1, 6],
    [2, 12],
    [3, 24],
    [4, 24],
    [10, 24],
  ])('prior escalations %i → budget %i', (prior, budget) => {
    expect(deadTrackRefreshBudget(prior)).toBe(budget);
  });

  it('is derived from the two named constants', () => {
    expect(deadTrackRefreshBudget(0)).toBe(DEAD_TRACK_REFRESH_BUDGET);
    expect(deadTrackRefreshBudget(DEAD_TRACK_ESCALATION_BACKOFF_CAP + 5)).toBe(
      DEAD_TRACK_REFRESH_BUDGET << DEAD_TRACK_ESCALATION_BACKOFF_CAP
    );
  });
});
