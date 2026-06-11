/**
 * Pure helpers for cross-carrier (audio/video) timing on the signals
 * transport, extracted so they can be unit-tested without an
 * AudioContext or DOM (same pattern as voice-playout.ts).
 *
 * Both signals carriers now stamp media with the SENDER's wall clock
 * (`Date.now()` on the sending machine): voice frames carry `wts`,
 * filmstrip clips carry `t0` (capture time of the clip's first frame).
 * Because both timestamps come from the same sender clock, comparing
 * them needs no clock synchronization between machines — receiver-side
 * skew math cancels any sender/receiver clock offset.
 */

/**
 * Anchor mapping one scheduled audio frame's sender capture time to the
 * local AudioContext time at which it plays. Written by voice.ts each
 * time a frame is scheduled; read to estimate "what sender-time is
 * audible right now".
 */
export interface PlayoutAnchor {
  /** Sender wall-clock ms (`wts`) of the anchored frame. */
  senderWtsMs: number;
  /** Local AudioContext time (seconds) the anchored frame starts. */
  atCtxSec: number;
  /** Local wall-clock ms when the anchor was written (staleness check). */
  setAtMs: number;
}

/**
 * Estimate the sender wall-clock time of the audio currently audible,
 * by projecting forward (or back) from the anchor along the audio clock.
 * Both the anchor and `ctxNowSec` are on the same AudioContext clock, so
 * the projection is exact up to scheduling granularity (one 20ms frame).
 */
export function estimatePlayoutSenderTimeMs(
  anchor: Pick<PlayoutAnchor, 'senderWtsMs' | 'atCtxSec'>,
  ctxNowSec: number,
): number {
  return anchor.senderWtsMs + (ctxNowSec - anchor.atCtxSec) * 1000;
}

/**
 * Receiver-side display pacing for the filmstrip queue.
 *
 * The queue's steady-state depth is ~1 clip (BUFFER_CLIPS = 1). When a
 * relay burst delivers several clips at once the queue deepens, which
 * is pure added latency — every queued frame pushes video further
 * behind the audio. Rather than dropping frames (a visible jump), play
 * slightly fast until the queue is back near one clip. 25% fast is
 * below the threshold where motion looks sped-up at filmstrip frame
 * rates, and drains one excess clip per ~4 clips of playback.
 *
 * The MAX_BUFFER_CLIPS hard cap in peer-filmstrip still backstops
 * pathological bursts; this pace adjustment handles the common case
 * smoothly before the cap is hit.
 */
export function framePaceMs(
  queueLen: number,
  clipFrameCount: number,
  periodMs: number,
): number {
  const targetDepth = Math.max(1, clipFrameCount); // ~1 clip of frames
  if (queueLen > targetDepth * 1.5) {
    return Math.round(periodMs * 0.75);
  }
  return periodMs;
}
