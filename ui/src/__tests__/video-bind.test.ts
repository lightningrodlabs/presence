import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindVideoStream } from '../room/video-bind';
import type { VideoSurface } from '../room/video-bind';

/**
 * View-layer round (§8 view-misc row): the four stream-onto-<video>
 * implementations collapsed onto bindVideoStream (room/video-bind.ts).
 *
 * The two apply-half invariants pinned here:
 *   - `ensure` never touches an element already bound to the target
 *     stream — a re-run against live playback must not interrupt it
 *     (zero srcObject writes, zero play calls).
 *   - `restore` always null-then-reassigns — a plain same-stream
 *     reassign is a no-op to the media pipeline, so recovery REQUIRES
 *     the null write first.
 *
 * Plus the source pin: room-view keeps no raw srcObject write, so a
 * fifth hand-rolled bind cannot regrow silently.
 */

function makeSurface(initial: MediaProvider | null = null) {
  const writes: Array<MediaProvider | null> = [];
  let current = initial;
  let playCalls = 0;
  const el: VideoSurface = {
    get srcObject() {
      return current;
    },
    set srcObject(v: MediaProvider | null) {
      writes.push(v);
      current = v;
    },
    autoplay: false,
    play() {
      playCalls += 1;
      return Promise.resolve();
    },
  };
  return { el, writes, playCalls: () => playCalls };
}

const stream = () => ({ id: 'stream' }) as unknown as MediaProvider;

describe('bindVideoStream decisions', () => {
  it('skips with no element', () => {
    expect(bindVideoStream(null, stream(), 'ensure')).toEqual({
      action: 'skipped',
      reason: 'no-element',
    });
    expect(bindVideoStream(undefined, stream(), 'restore')).toEqual({
      action: 'skipped',
      reason: 'no-element',
    });
  });

  it('skips with no stream, touching nothing', () => {
    const s = makeSurface();
    expect(bindVideoStream(s.el, null, 'ensure')).toEqual({
      action: 'skipped',
      reason: 'no-stream',
    });
    expect(bindVideoStream(s.el, undefined, 'restore')).toEqual({
      action: 'skipped',
      reason: 'no-stream',
    });
    expect(s.writes).toEqual([]);
    expect(s.playCalls()).toBe(0);
  });

  it('ensure binds a fresh element: one srcObject write, autoplay, play', () => {
    const s = makeSurface();
    const target = stream();
    expect(bindVideoStream(s.el, target, 'ensure')).toEqual({
      action: 'bound',
      mode: 'ensure',
    });
    expect(s.writes).toEqual([target]);
    expect(s.el.autoplay).toBe(true);
    expect(s.playCalls()).toBe(1);
  });

  it('ensure NEVER interrupts an already-bound element (the per-render re-bind invariant)', () => {
    const target = stream();
    const s = makeSurface(target);
    expect(bindVideoStream(s.el, target, 'ensure')).toEqual({
      action: 'skipped',
      reason: 'already-bound',
    });
    expect(s.writes).toEqual([]);
    expect(s.playCalls()).toBe(0);
  });

  it('ensure rebinds when the element holds a DIFFERENT stream', () => {
    const s = makeSurface(stream());
    const target = stream();
    expect(bindVideoStream(s.el, target, 'ensure')).toEqual({
      action: 'bound',
      mode: 'ensure',
    });
    expect(s.writes).toEqual([target]);
  });

  it('restore null-then-reassigns even when already bound (the dead-context recovery invariant)', () => {
    const target = stream();
    const s = makeSurface(target);
    expect(bindVideoStream(s.el, target, 'restore')).toEqual({
      action: 'bound',
      mode: 'restore',
    });
    expect(s.writes).toEqual([null, target]);
    expect(s.el.autoplay).toBe(true);
    expect(s.playCalls()).toBe(1);
  });

  it('a rejecting play() (autoplay policy) is swallowed — the bind still reports bound', async () => {
    const s = makeSurface();
    s.el.play = () => Promise.reject(new Error('NotAllowedError'));
    expect(bindVideoStream(s.el, stream(), 'ensure')).toEqual({
      action: 'bound',
      mode: 'ensure',
    });
    // Let the rejection propagate if it was left unhandled — vitest
    // fails the run on unhandled rejections, so surviving this tick IS
    // the assertion.
    await new Promise(r => setTimeout(r, 0));
  });
});

describe('room-view binds video only through the authority', () => {
  const src = readFileSync(
    join(__dirname, '..', 'room', 'room-view.ts'),
    'utf8'
  );

  it('keeps no raw srcObject write or comparison', () => {
    // Matches assignment and comparison, not property reads: the old
    // hand-rolled binds all wrote or compared `.srcObject =`/`===`.
    const offenders = src
      .split('\n')
      .flatMap((line, i) =>
        /\.srcObject\s*[!=]?==?/.test(line) ? [`${i + 1}: ${line.trim()}`] : []
      );
    expect(offenders).toEqual([]);
  });

  it('calls bindVideoStream at every bind family', () => {
    const calls = src.match(/bindVideoStream\(/g) ?? [];
    // my-video-on, my-screen-share-on, peer-stream,
    // peer-screen-share-stream, _ensurePeerVideoStreams, restoreVideo.
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it('uses the named paint delays, no bare magic reapply timeouts', () => {
    expect(src).toContain('MAXIMIZE_REAPPLY_DELAY_MS');
    expect(src).toContain('LAYOUT_SWITCH_REAPPLY_DELAY_MS');
    expect(src).toContain('STREAM_EVENT_DOM_SETTLE_MS');
    expect(src).not.toMatch(/_reapplyVideoStreams\(\),\s*\d/);
  });
});
