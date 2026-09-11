// Extracted from presence ui/src/room/elements/peer-filmstrip.ts at ab90584
// (signals-media extraction, Task 4). Presence keeps its own copy until the
// adoption round.
import type { FilmstripFrame } from './filmstrip-carrier.js';
import { framePaceMs } from './av-sync.js';

/**
 * Initial buffer depth, in clips. Playback starts once BUFFER_CLIPS
 * clips' worth of frames have arrived; every buffered clip is added
 * latency for the whole session, which directly widens audio/video
 * skew (audio runs at ~80ms of jitter buffer). BUFFER_CLIPS = 1 starts
 * on the first clip — a late next clip freezes on the last frame and
 * resumes on arrival (no re-buffering), which costs less than carrying
 * a permanent extra clip of latency. With per-frame clips (n=1) this
 * means display starts on the first received frame.
 */
export const BUFFER_CLIPS = 1;

/**
 * Hard cap on queue depth, in clips. Drops oldest frames if exceeded.
 * Prevents unbounded growth from sender bursts (e.g. clips queued by a
 * network gap arrive together).
 */
export const MAX_BUFFER_CLIPS = 4;

export interface QueuedFrame {
  url: string;
  index: number;
  count: number;
  periodMs: number;
  /** Per-frame edge length (px), used to scale the display max-size. */
  width: number;
  /**
   * Sender wall-clock ms when this frame was captured (clip t0 +
   * index × period). Same sender clock as voice `wts`, so comparing it
   * against the voice playout sender-time yields A/V skew with no
   * cross-machine clock sync.
   */
  captureTimeMs: number;
}

export interface FilmstripPlaybackSinks {
  /** Invoked once per frame, at playback cadence, to display it. */
  paint(frame: QueuedFrame): void;
  /** Invoked whenever queue depth changes, for stats/diagnostics. */
  depth(frames: number): void;
  /** Timer source; defaults to `globalThis` (real `setTimeout`). */
  timers?: {
    setTimeout(fn: () => void, ms: number): number;
    clearTimeout(id: number): void;
  };
}

/**
 * Receiver-side display pacing for one peer's filmstrip stream.
 *
 * On clip arrival, push that clip's N frames onto a queue. A single
 * setTimeout chain pops one frame every period and paints it via the
 * `paint` sink, regardless of when clips arrive. This decouples
 * display timing from receive timing — the visible playback is at
 * constant cadence even when clip arrivals jitter.
 *
 * Trade-off: latency. Initial playback waits for `BUFFER_CLIPS` clips
 * to accumulate so a slow clip arrival doesn't underrun immediately.
 * After playback has started, underrun (queue drains before the next
 * clip arrives) freezes on the last frame; the next clip arrival
 * resumes playback immediately (no re-buffering).
 *
 * Buffer cap: if clips arrive faster than they're consumed (e.g. signal
 * burst after a network gap), drop OLDEST frames first so the latency
 * doesn't grow unbounded.
 */
export class FilmstripPlayback {
  private _queue: QueuedFrame[] = [];
  private _started = false;
  private _animTimer: number | null = null;

  constructor(private readonly sinks: FilmstripPlaybackSinks) {}

  get depth(): number {
    return this._queue.length;
  }

  push(frame: FilmstripFrame): void {
    // Push N entries (one per frame) into the queue. The setTimeout
    // chain consumes them at periodMs intervals.
    //
    // This loop trusts `frameCount` and `periodMs`: it does NOT re-check
    // them. The single validation site is FilmstripCarrier.receiveFrame
    // (filmstrip-carrier.ts, the MAX_CLIP_FRAMES geometry check), which
    // drops any clip whose `n` is not an integer in 1..MAX_CLIP_FRAMES or
    // whose `p` is not finite and positive — so a remote sender cannot
    // reach this loop with a count that never terminates or a period
    // that makes the setTimeout chain spin. A host that constructs
    // `FilmstripFrame`s from some other source owns that check itself.
    for (let i = 0; i < frame.frameCount; i++) {
      this._queue.push({
        url: frame.url,
        index: i,
        count: frame.frameCount,
        periodMs: frame.periodMs,
        width: frame.width,
        captureTimeMs: frame.captureT0Ms + i * frame.periodMs,
      });
    }

    // Cap the queue depth — drop oldest if a sender burst pushed us
    // over MAX_BUFFER_CLIPS. Preferring to lose old frames keeps the
    // displayed video as close to real-time as the cap allows.
    const max = MAX_BUFFER_CLIPS * frame.frameCount;
    while (this._queue.length > max) {
      this._queue.shift();
    }

    this.sinks.depth(this._queue.length);

    if (!this._started) {
      // Initial buffering: wait for BUFFER_CLIPS clips before the first
      // frame is displayed. Adds startup latency, gains jitter tolerance.
      const target = BUFFER_CLIPS * frame.frameCount;
      if (this._queue.length >= target) {
        this._started = true;
        this._popAndSchedule();
      }
    } else if (this._animTimer === null) {
      // Resuming after underrun. Don't re-buffer — the user has already
      // seen the freeze; pushing them through more wait is worse than
      // resuming with whatever just arrived.
      this._popAndSchedule();
    }
    // Else: already playing with a tick pending — this push just grows
    // the queue. Pacing is re-evaluated only at the next pop (see
    // _popAndSchedule), not mid-wait; a burst that arrives while a tick
    // is pending doesn't speed up the CURRENT wait, only the ones after
    // it. Verbatim element semantics — see the class doc comment.
  }

  clear(): void {
    const timers = this.sinks.timers ?? globalThis;
    if (this._animTimer !== null) {
      timers.clearTimeout(this._animTimer);
      this._animTimer = null;
    }
    this._queue = [];
    this._started = false;
    this.sinks.depth(0);
  }

  /**
   * Pop one frame from the queue, display it, and schedule the next
   * tick. If the queue is empty, leave the timer null so a new clip's
   * `push` can resume playback. The displayed frame stays on screen
   * during the underrun (frozen on last shown frame).
   *
   * The tick period is paced by queue depth (framePaceMs): when a
   * relay burst leaves more than ~1.5 clips queued, play 25% fast
   * until the backlog drains, instead of letting the excess sit as
   * permanent added latency (and A/V skew) until the hard cap drops
   * frames.
   */
  private _popAndSchedule(): void {
    const next = this._queue.shift();
    if (!next) return;
    this.sinks.paint(next);
    this.sinks.depth(this._queue.length);
    const pace = framePaceMs(this._queue.length, next.count, next.periodMs);
    const timers = this.sinks.timers ?? globalThis;
    this._animTimer = timers.setTimeout(() => {
      this._animTimer = null;
      this._popAndSchedule();
    }, pace);
  }
}
