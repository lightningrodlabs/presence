/**
 * Deterministic Clock for tests. Kept out of `clock.ts` so the fake can
 * never reach the production bundle — nothing under `ui/src` may import
 * this outside a `*.test.ts` or the harness.
 */
import type { Clock } from './clock';

interface ManualTimer {
  id: number;
  /** Absolute fire time in clock ms. */
  at: number;
  fn: () => void;
  /** Repeat period; undefined for one-shot timeouts. */
  intervalMs?: number;
}

/**
 * Deterministic clock for tests. Time only moves when `advance()` is called;
 * due timers run inline, in fire-time order, with ties broken by creation
 * order (matching the event loop's ordering guarantee for equal deadlines).
 *
 * A callback scheduled during `advance()` (e.g. a timeout that re-arms
 * itself) fires within the same `advance()` call if its deadline falls
 * inside the advanced window — this is what lets a test step through an
 * entire retry cycle with one `advance()`.
 */
export class ManualClock implements Clock {
  private _now: number;

  private _nextId = 1;

  private _timers: ManualTimer[] = [];

  constructor(startAt = 0) {
    this._now = startAt;
  }

  now(): number {
    return this._now;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this._nextId;
    this._nextId += 1;
    this._timers.push({ id, at: this._now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(id: number | undefined): void {
    if (id === undefined) return;
    this._timers = this._timers.filter(t => t.id !== id);
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this._nextId;
    this._nextId += 1;
    const period = Math.max(1, ms);
    this._timers.push({ id, at: this._now + period, fn, intervalMs: period });
    return id;
  }

  clearInterval(id: number | undefined): void {
    this.clearTimeout(id);
  }

  /** Number of currently armed timers. The wiring tests use this to
   *  assert start()/disconnect() symmetry — a disconnect() that leaves a
   *  timer armed is a leak, visible here without waiting for it to fire. */
  get pendingTimerCount(): number {
    return this._timers.length;
  }

  /** Advance time by `ms`, running every timer that comes due, in order. */
  advance(ms: number): void {
    const target = this._now + ms;
    for (;;) {
      const due = this._timers
        .filter(t => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      // Move time to the timer's deadline before running it so callbacks
      // reading now() see the time they were scheduled for.
      this._now = due.at;
      if (due.intervalMs !== undefined) {
        due.at += due.intervalMs;
      } else {
        this._timers = this._timers.filter(t => t.id !== due.id);
      }
      due.fn();
    }
    this._now = target;
  }
}
