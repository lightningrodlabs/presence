import { describe, expect, test } from 'vitest';
import { decideSample } from '../filmstrip-sampling-policy';

/**
 * Frame arrival times of a camera with deterministic jitter of up to
 * ±2 ms per frame. The field camera showed the same spread
 * (`[filmstrip tx] avgGap=33ms maxGap=36ms`, 2026-11-18).
 */
function cameraFrames(fps: number, durationMs: number): number[] {
  const out: number[] = [];
  const interval = 1000 / fps;
  for (let k = 0; k * interval < durationMs; k++) {
    out.push(k * interval + ((k * 7919) % 5) - 2);
  }
  return out;
}

/** Samples per second that `rule` takes from `frames`. */
function achievedRate(
  frames: number[],
  durationMs: number,
  rule: (frameMs: number) => boolean,
): number {
  return frames.filter(rule).length / (durationMs / 1000);
}

function withinOnePercent(achieved: number, periodMs: number): boolean {
  const target = 1000 / periodMs;
  return Math.abs(achieved - target) / target < 0.01;
}

describe('decideSample', () => {
  test.each([
    {
      name: 'first frame after a (re)start is sampled',
      inputs: { frameMs: 1000, nextDueMs: null, periodMs: 200 },
      expected: { sample: true, reason: 'first', nextDueMs: 1200 },
    },
    {
      name: 'a frame before the due time is skipped',
      inputs: { frameMs: 1199, nextDueMs: 1200, periodMs: 200 },
      expected: { sample: false, reason: 'not-due', nextDueMs: 1200 },
    },
    {
      name: 'a frame exactly at the due time is sampled',
      inputs: { frameMs: 1200, nextDueMs: 1200, periodMs: 200 },
      expected: { sample: true, reason: 'due', nextDueMs: 1400 },
    },
    {
      name: 'a late frame keeps the schedule instead of moving it to the frame',
      inputs: { frameMs: 1231, nextDueMs: 1200, periodMs: 200 },
      expected: { sample: true, reason: 'due', nextDueMs: 1400 },
    },
    {
      name: 'a frame a whole period late restarts the schedule (no burst)',
      inputs: { frameMs: 1400, nextDueMs: 1200, periodMs: 200 },
      expected: { sample: true, reason: 'resync', nextDueMs: 1600 },
    },
  ])('$name', ({ inputs, expected }) => {
    expect(decideSample(inputs)).toEqual(expected);
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15])(
    'a 30 fps camera yields %i fps on average',
    (fps) => {
      const periodMs = Math.round(1000 / fps);
      let nextDueMs: number | null = null;
      const achieved = achievedRate(cameraFrames(30, 60_000), 60_000, (t) => {
        const d = decideSample({ frameMs: t, nextDueMs, periodMs });
        nextDueMs = d.nextDueMs;
        return d.sample;
      });
      expect(withinOnePercent(achieved, periodMs)).toBe(true);
    },
  );

  /**
   * The rule this policy replaced: sample the first frame at least one
   * period after the previous sample, then reset the schedule to that
   * frame's arrival. Through the same harness it misses the 1% bound at
   * every rate except 3 fps, whose 333 ms period happens to fit 10 frames
   * of this model camera (the field camera measured 2.75 fps there).
   */
  test('negative control: the old reset-to-arrival rule misses the bound', () => {
    const missed: number[] = [];
    for (const fps of [3, 4, 5, 6, 7, 8, 10, 12, 15]) {
      const periodMs = Math.round(1000 / fps);
      let lastSampleMs: number | null = null;
      const achieved = achievedRate(cameraFrames(30, 60_000), 60_000, (t) => {
        if (lastSampleMs !== null && t - lastSampleMs < periodMs) return false;
        lastSampleMs = t;
        return true;
      });
      if (!withinOnePercent(achieved, periodMs)) missed.push(fps);
    }
    expect(missed).toEqual([4, 5, 6, 7, 8, 10, 12, 15]);
  });

  test('a camera slower than the target yields the camera rate, not a burst', () => {
    const periodMs = Math.round(1000 / 30);
    const frames = cameraFrames(15, 10_000);
    let nextDueMs: number | null = null;
    const sampled = frames.filter((t) => {
      const d = decideSample({ frameMs: t, nextDueMs, periodMs });
      nextDueMs = d.nextDueMs;
      return d.sample;
    });
    expect(sampled.length).toBe(frames.length);
  });
});
