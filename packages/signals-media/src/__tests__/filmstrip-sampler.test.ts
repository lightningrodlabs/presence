import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FilmstripSampler } from '../filmstrip-sampler.js';

/**
 * The sampler is the WebKit-portable replacement for the transferred
 * `MediaStreamTrackProcessor` readable (design spec decision 5), so what has
 * to hold is the cadence contract the old pump gave the worker: one sample
 * per period, never overlapping, re-armable, and fully stopped on `stop()`.
 *
 * Constrains: src/filmstrip-sampler.ts.
 */

interface FakeVideo {
  muted: boolean;
  playsInline: boolean;
  srcObject: unknown;
  videoWidth: number;
  played: number;
  paused: number;
  play(): Promise<void>;
  pause(): void;
}

let videos: FakeVideo[] = [];
let bitmapCalls: unknown[] = [];
/** Set by a test to control when `createImageBitmap` settles. */
let bitmapResolver: ((b: unknown) => void) | null = null;

function makeFakeVideo(): FakeVideo {
  return {
    muted: false,
    playsInline: false,
    srcObject: null,
    videoWidth: 640,
    played: 0,
    paused: 0,
    async play() {
      this.played += 1;
    },
    pause() {
      this.paused += 1;
    },
  };
}

const g = globalThis as unknown as Record<string, unknown>;

function fakeTrack(): MediaStreamTrack {
  return { kind: 'video', readyState: 'live' } as unknown as MediaStreamTrack;
}

describe('FilmstripSampler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    videos = [];
    bitmapCalls = [];
    bitmapResolver = null;
    g.document = {
      createElement: (tag: string) => {
        if (tag !== 'video') throw new Error(`unexpected createElement(${tag})`);
        const v = makeFakeVideo();
        videos.push(v);
        return v;
      },
    };
    g.MediaStream = class {
      tracks: unknown[];
      constructor(tracks: unknown[] = []) {
        this.tracks = tracks;
      }
    };
    g.createImageBitmap = (src: unknown) => {
      bitmapCalls.push(src);
      if (bitmapResolver) {
        return new Promise(resolve => {
          bitmapResolver = resolve;
        });
      }
      return Promise.resolve({ width: 640, height: 480, close: () => {} });
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete g.document;
    delete g.MediaStream;
    delete g.createImageBitmap;
  });

  it('samples once per period, stamping each sample with wall-clock t0', async () => {
    const s = new FilmstripSampler();
    const samples: number[] = [];
    const ok = await s.start(fakeTrack(), 100, (_b, t0) => samples.push(t0));

    expect(ok).toBe(true);
    expect(videos).toHaveLength(1);
    expect(videos[0].muted).toBe(true);
    expect(videos[0].played).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(samples).toHaveLength(3);
    expect(samples[1]).toBeGreaterThan(samples[0]);
    expect(samples[2]).toBeGreaterThan(samples[1]);

    s.stop();
  });

  it('skips a tick while a bitmap is still pending', async () => {
    bitmapResolver = () => {};
    const s = new FilmstripSampler();
    const samples: unknown[] = [];
    await s.start(fakeTrack(), 100, b => samples.push(b));

    await vi.advanceTimersByTimeAsync(100); // first sample starts, never settles
    await vi.advanceTimersByTimeAsync(100); // busy — skipped
    await vi.advanceTimersByTimeAsync(100); // busy — skipped

    expect(bitmapCalls).toHaveLength(1);
    expect(samples).toHaveLength(0);

    // Settling the pending bitmap delivers it and releases the sampler.
    bitmapResolver?.({ width: 2, height: 2, close: () => {} });
    bitmapResolver = null;
    await Promise.resolve();
    expect(samples).toHaveLength(1);

    // The next tick now samples again.
    await vi.advanceTimersByTimeAsync(100);
    expect(samples).toHaveLength(2);

    s.stop();
  });

  it('skips a tick before the video has dimensions', async () => {
    const s = new FilmstripSampler();
    const samples: unknown[] = [];
    await s.start(fakeTrack(), 100, b => samples.push(b));
    videos[0].videoWidth = 0;

    await vi.advanceTimersByTimeAsync(100);
    expect(bitmapCalls).toHaveLength(0);

    videos[0].videoWidth = 320;
    await vi.advanceTimersByTimeAsync(100);
    expect(samples).toHaveLength(1);

    s.stop();
  });

  it('setPeriod re-arms the interval at the new period', async () => {
    const s = new FilmstripSampler();
    const samples: unknown[] = [];
    await s.start(fakeTrack(), 100, b => samples.push(b));

    s.setPeriod(500);
    await vi.advanceTimersByTimeAsync(100);
    expect(samples).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(samples).toHaveLength(1);

    s.stop();
  });

  it('replaceTrack re-points the same video element and replays it', async () => {
    const s = new FilmstripSampler();
    await s.start(fakeTrack(), 100, () => {});
    const first = videos[0].srcObject;

    s.replaceTrack(fakeTrack());

    expect(videos).toHaveLength(1);
    expect(videos[0].srcObject).not.toBe(first);
    expect(videos[0].played).toBe(2);

    s.stop();
  });

  it('stop clears the interval and releases the video element', async () => {
    const s = new FilmstripSampler();
    const samples: unknown[] = [];
    await s.start(fakeTrack(), 100, b => samples.push(b));
    expect(vi.getTimerCount()).toBe(1);

    s.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(videos[0].paused).toBe(1);
    expect(videos[0].srcObject).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    expect(samples).toHaveLength(0);
  });

  it('start refuses without a document or createImageBitmap', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete g.createImageBitmap;
    const s = new FilmstripSampler();

    expect(await s.start(fakeTrack(), 100, () => {})).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    err.mockRestore();
  });

  it('start refuses — and arms nothing — when video.play() rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    g.document = {
      createElement: () => {
        const v = makeFakeVideo();
        v.play = () => Promise.reject(new Error('no autoplay'));
        videos.push(v);
        return v;
      },
    };
    const s = new FilmstripSampler();

    expect(await s.start(fakeTrack(), 100, () => {})).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    err.mockRestore();
  });
});
