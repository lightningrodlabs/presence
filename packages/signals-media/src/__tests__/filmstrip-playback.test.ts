import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FilmstripPlayback, MAX_BUFFER_CLIPS } from '../filmstrip-playback.js';

const frame = (n: number, periodMs = 100) => ({ url: `u${n}`, width: 96, height: 96, frameCount: n, periodMs, captureT0Ms: 0 });

describe('FilmstripPlayback', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts on the first clip (BUFFER_CLIPS = 1) and steps one frame per period', () => {
    const painted: string[] = [];
    const p = new FilmstripPlayback({ paint: f => painted.push(`${f.url}#${f.index}`), depth: () => {} });
    p.push(frame(3));
    expect(painted).toEqual(['u3#0']);
    vi.advanceTimersByTime(100); expect(painted).toEqual(['u3#0', 'u3#1']);
    vi.advanceTimersByTime(100); expect(painted).toHaveLength(3);
  });

  it('underrun freezes on the last frame and resumes immediately on the next clip (no re-buffer)', () => {
    const painted: string[] = [];
    const p = new FilmstripPlayback({ paint: f => painted.push(f.url), depth: () => {} });
    p.push(frame(1)); vi.advanceTimersByTime(500);
    expect(painted).toEqual(['u1']);
    p.push(frame(1)); expect(painted).toEqual(['u1', 'u1']);
  });

  it('caps the queue at MAX_BUFFER_CLIPS clips, dropping OLDEST first', () => {
    const depths: number[] = [];
    const p = new FilmstripPlayback({ paint: () => {}, depth: d => depths.push(d) });
    for (let i = 0; i < MAX_BUFFER_CLIPS + 3; i++) p.push(frame(2));
    expect(Math.max(...depths)).toBeLessThanOrEqual(MAX_BUFFER_CLIPS * 2);
  });

  it('caps the queue by dropping the OLDEST clips, not the newest', () => {
    // One frame per clip (frameCount: 1), distinct urls, so each clip is
    // a single queue entry and we can tell exactly which clips survived
    // the cap. BUFFER_CLIPS = 1 means clip0 starts playback immediately
    // (its single frame pops and paints synchronously, before any later
    // clip arrives) — that is expected, not a cap effect. Every clip
    // pushed after that queues up (no timer advance between pushes), so
    // once the queue exceeds MAX_BUFFER_CLIPS the cap must evict the
    // OLDEST still-queued clips first: with MAX_BUFFER_CLIPS + 3 clips
    // pushed, clip0 plays immediately, clip1 and clip2 are evicted
    // before they ever reach the front, and the last MAX_BUFFER_CLIPS
    // clips (which fit under the cap) remain queued and eventually play.
    const painted: string[] = [];
    const p = new FilmstripPlayback({ paint: f => painted.push(f.url), depth: () => {} });
    const totalClips = MAX_BUFFER_CLIPS + 3;
    for (let i = 0; i < totalClips; i++) {
      p.push({ url: `clip${i}`, width: 96, height: 96, frameCount: 1, periodMs: 100, captureT0Ms: 0 });
    }
    // Only clip0's immediate first-clip paint has happened so far.
    expect(painted).toEqual(['clip0']);
    // Drain everything that remains queued and record which urls paint.
    for (let i = 0; i < MAX_BUFFER_CLIPS + 2; i++) vi.advanceTimersByTime(100);
    // The two clips queued directly behind clip0 were evicted as oldest
    // before the cap let them reach the front — they must never paint.
    expect(painted).not.toContain('clip1');
    expect(painted).not.toContain('clip2');
    // The most recently pushed clip survived under the cap and played.
    expect(painted).toContain(`clip${totalClips - 1}`);
  });

  it('plays 25% fast while more than ~1.5 clips are queued (framePaceMs)', () => {
    // Pace is chosen once per pop, from the queue depth AT THAT POP —
    // not re-evaluated while a tick is pending (element-verbatim
    // semantics; a burst arriving mid-wait speeds up later ticks, not
    // the one already running).
    //
    // 4 single-frame clips pushed synchronously at t=0: the first pop
    // (BUFFER_CLIPS = 1) happens inline inside the first push, before
    // clips 2-4 arrive, so its pace is computed against an EMPTY queue
    // -> framePaceMs(0, 1, 100) = 100 (targetDepth = 1, 0 is not > 1.5).
    // Clips 2-4 then just enqueue (queue = [e2, e3, e4]) — a pending
    // timer, so no accelerate-on-push per the ruling above.
    //
    // t=100: 2nd pop, queue depth after shift = 2 (e3, e4 remain) ->
    // framePaceMs(2, 1, 100): 2 > 1.5 -> Math.round(100*0.75) = 75.
    // t=175: 3rd pop, queue depth after shift = 1 (e4 remains) ->
    // framePaceMs(1, 1, 100): 1 is not > 1.5 -> 100.
    // t=275: 4th pop, queue empty.
    const painted: number[] = [];
    const p = new FilmstripPlayback({ paint: () => painted.push(Date.now()), depth: () => {} });
    vi.setSystemTime(0);
    for (let i = 0; i < 4; i++) p.push(frame(1, 100));
    expect(painted).toHaveLength(1); // the inline first pop, pace 100 next
    vi.advanceTimersByTime(100); expect(painted).toHaveLength(2); // t=100, pace now 75
    vi.advanceTimersByTime(75); expect(painted).toHaveLength(3); // t=175, pace now 100
    vi.advanceTimersByTime(99); expect(painted).toHaveLength(3); // t=274, not yet
    vi.advanceTimersByTime(1); expect(painted).toHaveLength(4); // t=275
  });

  it('clear drains the queue, stops the timer, and reports depth 0', () => {
    const depths: number[] = [];
    const p = new FilmstripPlayback({ paint: () => {}, depth: d => depths.push(d) });
    p.push(frame(3)); p.clear();
    expect(p.depth).toBe(0); expect(depths.at(-1)).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
