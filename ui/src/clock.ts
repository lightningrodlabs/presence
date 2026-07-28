/**
 * The single time authority for presence and connection logic.
 *
 * Every timing decision in `StreamsStore` (and the modules it binds) routes
 * through a `Clock` so tests can substitute `ManualClock` and drive the 2s
 * ping cadence, the 15s ICE grace, and the freshness windows in
 * `presence-policy.ts` deterministically instead of sleeping through them.
 *
 * `systemClock` is the production implementation and the default
 * everywhere. The test fake lives in `clock.testing.ts` so it cannot be
 * pulled into the production bundle by an accidental import.
 */
export interface Clock {
  /** Milliseconds since the epoch, like `Date.now()`. */
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number | undefined): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: id => {
    if (id !== undefined) globalThis.clearTimeout(id);
  },
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as number,
  clearInterval: id => {
    if (id !== undefined) globalThis.clearInterval(id);
  },
};
