import { describe, it, expect } from 'vitest';
import { estimatePlayoutSenderTimeMs, framePaceMs } from '../av-sync';

describe('estimatePlayoutSenderTimeMs', () => {
  it('returns the anchor sender time exactly at the anchor instant', () => {
    const anchor = { senderWtsMs: 1_000_000, atCtxSec: 10.0 };
    expect(estimatePlayoutSenderTimeMs(anchor, 10.0)).toBe(1_000_000);
  });

  it('projects forward along the audio clock after the anchor', () => {
    const anchor = { senderWtsMs: 1_000_000, atCtxSec: 10.0 };
    // 250ms of audio-clock time later, the audible sender time is 250ms later.
    expect(estimatePlayoutSenderTimeMs(anchor, 10.25)).toBe(1_000_250);
  });

  it('projects backward when queried before the anchored frame plays', () => {
    // The anchor is the most recently SCHEDULED frame, which sits at the
    // jitter-buffer horizon — queries land slightly before it plays.
    const anchor = { senderWtsMs: 1_000_000, atCtxSec: 10.0 };
    expect(estimatePlayoutSenderTimeMs(anchor, 9.92)).toBeCloseTo(999_920, 6);
  });
});

describe('framePaceMs', () => {
  const PERIOD = 167; // 6 fps
  const CLIP = 3; // frames per 500ms clip at 6 fps

  it('plays at the nominal period at steady-state depth (≤ ~1 clip)', () => {
    expect(framePaceMs(0, CLIP, PERIOD)).toBe(PERIOD);
    expect(framePaceMs(CLIP, CLIP, PERIOD)).toBe(PERIOD);
    // exactly at the 1.5-clip threshold: not over it, still nominal
    expect(framePaceMs(Math.floor(CLIP * 1.5), CLIP, PERIOD)).toBe(PERIOD);
  });

  it('plays 25% fast when a burst leaves more than 1.5 clips queued', () => {
    expect(framePaceMs(CLIP * 2, CLIP, PERIOD)).toBe(Math.round(PERIOD * 0.75));
    expect(framePaceMs(CLIP * 4, CLIP, PERIOD)).toBe(Math.round(PERIOD * 0.75));
  });

  it('handles one-frame clips (very low fps) without a zero target', () => {
    // 1 fps → 1 frame per clip, period 1000ms. Depth 1 is steady state;
    // depth 2 (> 1.5 clips) triggers catch-up.
    expect(framePaceMs(1, 1, 1000)).toBe(1000);
    expect(framePaceMs(2, 1, 1000)).toBe(750);
  });

  it('catch-up drains a burst back to steady state', () => {
    // Simulate a 4-clip backlog being consumed with no new arrivals:
    // paced ticks must shrink the queue and return to nominal pace.
    let queue = CLIP * 4;
    let fastTicks = 0;
    while (queue > 0) {
      const pace = framePaceMs(queue, CLIP, PERIOD);
      if (pace < PERIOD) fastTicks++;
      queue--;
    }
    expect(fastTicks).toBeGreaterThan(0);
    // The final few frames (≤ 1.5 clips) play at nominal pace.
    expect(framePaceMs(Math.floor(CLIP * 1.5), CLIP, PERIOD)).toBe(PERIOD);
  });
});
