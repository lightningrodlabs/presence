/**
 * Which camera frames the filmstrip sender samples.
 *
 * Replaces the inline rule in `filmstrip-worker.ts:pumpCapture`, which
 * sampled the first frame at least one period after the previous sample
 * and then reset the schedule to that frame's arrival time. The frame
 * arrived up to one camera interval late, and the reset threw that
 * lateness away every cycle, so the achieved rate snapped down to the
 * camera rate divided by a whole number of frames: with a 30 fps camera,
 * a 3 fps setting gave 2.75 fps and 4 fps gave 3.75 fps (measured in the
 * field 2026-11-18, `[filmstrip tx] clips/s`). Every rate above 6 fps
 * would have snapped to 7.5, 10 or 15.
 *
 * The schedule now advances by whole periods from where it was due, not
 * from when the frame arrived, so the lateness is carried into the next
 * cycle and the long-run rate equals 1000 / periodMs whenever the camera
 * delivers frames faster than that. Individual gaps still alternate
 * between whole camera intervals; only the average is exact.
 *
 * A schedule that falls more than one period behind (a stalled reader, a
 * suspended tab) restarts from the current frame instead of sampling a
 * burst of frames back to back to catch up.
 *
 * `periodMs` is a send-pacing control, not a liveness predicate.
 */

export type SampleInputs = {
  /** Arrival time of the current camera frame, in ms (monotonic). */
  frameMs: number;
  /**
   * When the next sample is due, in ms; `null` when nothing has been
   * sampled since the schedule was (re)started.
   */
  nextDueMs: number | null;
  /** Target interval between samples, in ms. Must be positive. */
  periodMs: number;
};

export type SampleDecision =
  | { sample: false; reason: 'not-due'; nextDueMs: number }
  | {
      sample: true;
      reason: 'first' | 'due' | 'resync';
      nextDueMs: number;
    };

export function decideSample({
  frameMs,
  nextDueMs,
  periodMs,
}: SampleInputs): SampleDecision {
  if (nextDueMs === null) {
    return { sample: true, reason: 'first', nextDueMs: frameMs + periodMs };
  }
  if (frameMs < nextDueMs) {
    return { sample: false, reason: 'not-due', nextDueMs };
  }
  const nextFromSchedule = nextDueMs + periodMs;
  if (frameMs >= nextFromSchedule) {
    return { sample: true, reason: 'resync', nextDueMs: frameMs + periodMs };
  }
  return { sample: true, reason: 'due', nextDueMs: nextFromSchedule };
}
