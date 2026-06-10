/**
 * Pure playout-scheduling decision for the signals voice carrier, extracted
 * from `voice.ts` so it can be exercised in isolation (no AudioContext, no
 * WebCodecs, no store). Given the previous playback-head position and the
 * current audio-clock time, it decides where — or whether — to schedule the
 * next decoded frame.
 *
 * This is the locus of the "voice on top of itself" investigation
 * (docs/SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md): the hazard is re-anchoring the
 * head *backward* while audio is already scheduled ahead, which overlaps it.
 */

export type PlayoutReason = 'first' | 'behind' | 'steady' | 'overcap-drop';

export interface PlayoutDecision {
  /** `play`: schedule the source at `at`. `drop`: skip this frame entirely. */
  action: 'play' | 'drop';
  /** ctx-time to `source.start(at)`; NaN when action === 'drop'. */
  at: number;
  /** New value for the caller's `nextPlaybackTime` head. */
  nextPlaybackTime: number;
  /** Which branch fired — for diagnostics and tests. */
  reason: PlayoutReason;
}

/**
 * Decide where to schedule one decoded frame.
 *
 * - head behind real time (`< now`): re-anchor forward to `now + jitter`.
 *   Nothing is scheduled in `[now, head)`, so this cannot overlap. `head === 0`
 *   is the first-ever frame (reported as `first` rather than `behind`).
 * - head too far ahead (`> now + jitter + drift`): the buffer is deeper than the
 *   drift cap — frames arrived faster than real time. Up to `drift` of audio is
 *   already committed ahead of `now`; re-anchoring backward here would overlap
 *   it. **Drop** this frame to shed depth instead. Latency drains back to
 *   ~jitter between bursts.
 * - otherwise: schedule at the head and advance it (steady state).
 */
export function decidePlayout(
  head: number,
  now: number,
  frameDurationSec: number,
  jitterSec: number,
  driftSec: number,
): PlayoutDecision {
  if (head < now) {
    const at = now + jitterSec;
    return {
      action: 'play',
      at,
      nextPlaybackTime: at + frameDurationSec,
      reason: head === 0 ? 'first' : 'behind',
    };
  }
  if (head > now + jitterSec + driftSec) {
    return { action: 'drop', at: NaN, nextPlaybackTime: head, reason: 'overcap-drop' };
  }
  return {
    action: 'play',
    at: head,
    nextPlaybackTime: head + frameDurationSec,
    reason: 'steady',
  };
}

/**
 * The pre-fix behavior, retained ONLY so tests can demonstrate the overlap it
 * produced on a burst (it snaps the head backward instead of dropping). Not used
 * in production. Always plays — never drops.
 */
export function decidePlayoutLegacy(
  head: number,
  now: number,
  frameDurationSec: number,
  jitterSec: number,
  driftSec: number,
): { at: number; nextPlaybackTime: number } {
  let h = head;
  if (h < now || h > now + jitterSec + driftSec) {
    h = now + jitterSec;
  }
  return { at: h, nextPlaybackTime: h + frameDurationSec };
}
