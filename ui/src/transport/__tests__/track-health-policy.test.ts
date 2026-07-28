import { describe, it, expect } from 'vitest';
import {
  summarizeRtcStats,
  decideTrackRefresh,
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

describe('summarizeRtcStats', () => {
  it('returns all-null / zero for an empty report set', () => {
    expect(summarizeRtcStats([])).toEqual({
      audioBytes: 0,
      videoBytes: 0,
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
};

describe('decideTrackRefresh', () => {
  it('bytes advancing resets the counters and requests nothing', () => {
    expect(decideTrackRefresh(base)).toEqual({
      action: 'none',
      nextStale: { audio: 0, video: 0 },
      reason: 'flowing',
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
});
