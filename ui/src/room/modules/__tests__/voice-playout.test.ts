import { describe, it, expect } from 'vitest';
import {
  decidePlayout,
  decidePlayoutLegacy,
  type PlayoutReason,
} from '../voice-playout';

/**
 * Deterministic harness for the signals-voice playout scheduler — the locus of
 * the "voice on top of itself" investigation
 * (docs/SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md). No AudioContext / WebCodecs: we
 * drive the pure decision through arrival patterns and assert on the resulting
 * schedule. The whole point is that NO two scheduled frames overlap.
 *
 * An "arrival" is one decoded frame becoming available, with the audio-clock
 * time (`now`) at the moment its output callback fires. A real-time stream
 * advances `now` by ~frameDuration each arrival; a burst advances `now` by
 * almost nothing across many arrivals (the decoder drained a backlog faster than
 * real time — the untested assumption this models).
 */

const JITTER = 0.08; // 80ms  (JITTER_BUFFER_MS)
const DRIFT = 0.4; //   400ms (PLAYBACK_RESET_DRIFT_MS)
const FRAME = 0.02; // 20ms Opus frame

type Arrival = { now: number };
type Interval = [start: number, end: number];

/** Run the production scheduler over an arrival pattern. */
function simulate(arrivals: Arrival[]) {
  let head = 0;
  const intervals: Interval[] = [];
  const reasons: PlayoutReason[] = [];
  for (const a of arrivals) {
    const d = decidePlayout(head, a.now, FRAME, JITTER, DRIFT);
    head = d.nextPlaybackTime;
    reasons.push(d.reason);
    if (d.action === 'play') intervals.push([d.at, d.at + FRAME]);
  }
  return { intervals, reasons };
}

/** Run the pre-fix (legacy) scheduler — always plays, snaps the head backward. */
function simulateLegacy(arrivals: Arrival[]) {
  let head = 0;
  const intervals: Interval[] = [];
  for (const a of arrivals) {
    const r = decidePlayoutLegacy(head, a.now, FRAME, JITTER, DRIFT);
    head = r.nextPlaybackTime;
    intervals.push([r.at, r.at + FRAME]);
  }
  return { intervals };
}

/** True iff any two scheduled intervals overlap (sorted-sweep, epsilon-tolerant). */
function hasOverlap(intervals: Interval[]): boolean {
  const s = [...intervals].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < s.length; i++) {
    if (s[i][0] < s[i - 1][1] - 1e-9) return true;
  }
  return false;
}

/** Real-time arrival: `now` advances one frame per arrival, starting at t0. */
function realtimeArrivals(count: number, t0 = 5): Arrival[] {
  return Array.from({ length: count }, (_, i) => ({ now: t0 + i * FRAME }));
}

/** Burst arrival: many frames while `now` barely moves (faster than real time). */
function burstArrivals(count: number, t0 = 5, perFrameNowAdvanceSec = 0.001): Arrival[] {
  return Array.from({ length: count }, (_, i) => ({ now: t0 + i * perFrameNowAdvanceSec }));
}

describe('decidePlayout — signals voice scheduler', () => {
  it('first frame anchors at now + jitter', () => {
    const d = decidePlayout(0, 5, FRAME, JITTER, DRIFT);
    expect(d).toMatchObject({ action: 'play', at: 5 + JITTER, reason: 'first' });
    expect(d.nextPlaybackTime).toBeCloseTo(5 + JITTER + FRAME, 9);
  });

  it('steady real-time stream: every frame plays, none drop, no overlap', () => {
    const { intervals, reasons } = simulate(realtimeArrivals(200));
    expect(intervals).toHaveLength(200);
    expect(reasons.filter(r => r === 'overcap-drop')).toHaveLength(0);
    // first frame is 'first'; the rest are 'steady' (or an occasional 'behind'
    // if clock == head exactly — tolerate, but never overcap).
    expect(hasOverlap(intervals)).toBe(false);
  });

  it('re-anchors forward (no overlap) after a stall', () => {
    // Steady, then a 2s gap where `now` jumps past the head, then resume.
    const arrivals: Arrival[] = [
      ...realtimeArrivals(10, 5),
      { now: 9 }, // ~3.8s gap: head ~5.3, now 9  => 'behind'
      ...realtimeArrivals(10, 9.04),
    ];
    const { intervals, reasons } = simulate(arrivals);
    expect(reasons).toContain('behind');
    expect(hasOverlap(intervals)).toBe(false);
  });

  it('faster-than-real-time burst: sheds frames (drops) and never overlaps', () => {
    const { intervals, reasons } = simulate(burstArrivals(60));
    // The buffer fills to the drift cap, then excess frames are dropped.
    expect(reasons.filter(r => r === 'overcap-drop').length).toBeGreaterThan(0);
    expect(hasOverlap(intervals)).toBe(false);
  });

  it('REGRESSION: the pre-fix snap-back DID overlap on the same burst', () => {
    // Same burst, legacy scheduler. This is the bug the fix removes: the
    // backward snap re-schedules burst frames on top of already-committed audio.
    const legacy = simulateLegacy(burstArrivals(60));
    expect(hasOverlap(legacy.intervals)).toBe(true);

    // And the fix, on the identical input, does not.
    const fixed = simulate(burstArrivals(60));
    expect(hasOverlap(fixed.intervals)).toBe(false);
  });

  it('buffer drains back below the cap once the burst ends (latency recovers)', () => {
    // A burst followed by real-time arrivals: after the drop phase, the head
    // should fall back into the steady band rather than staying pinned at the cap.
    const arrivals = [...burstArrivals(40, 5), ...realtimeArrivals(40, 6)];
    const { reasons } = simulate(arrivals);
    // The tail (real-time) arrivals should be steady, not perpetual drops.
    const tail = reasons.slice(-20);
    expect(tail.every(r => r === 'overcap-drop')).toBe(false);
  });
});
