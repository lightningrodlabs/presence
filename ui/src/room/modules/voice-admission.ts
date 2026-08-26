/**
 * Voice-frame admission: the ONE decision for whether an incoming voice
 * payload enters the decode path, replacing the bare `seq <= lastSeq`
 * dedupe that caused the 2026-08-26 field deafness (the sender resets
 * `seq` to 0 on every `stopCapture` — voice.ts — while the receiver's
 * high-water persisted forever, so every carrier switch back to signals
 * silently dropped the restarted session until its seq climbed past the
 * old high-water: one-way silence lasting exactly the previous session's
 * length; 7.2s / 23.1s / 51.3s across the three observed windows).
 *
 * The discriminator is a capture-session epoch (`ep` on each frame,
 * assigned per `startCapture` via `nextVoiceEpoch`):
 *   - same epoch      -> plain seq dedupe, as before;
 *   - newer epoch     -> adopt the session, reset the seq high-water;
 *   - older epoch     -> drop (a late packet from a superseded session
 *                        must not replay stale audio or re-adopt
 *                        backwards — this is why the comparison is
 *                        ORDERED, not equality: an equality rule
 *                        oscillates on interleaved delivery);
 *   - older epoch after a quiet window -> adopt anyway. This is the
 *     fallback for the one pathology ordering cannot cover: a sender
 *     whose wall clock stepped backwards across an app restart would
 *     otherwise be dropped forever. A live stream beats a stored epoch.
 *
 * Frames with no `ep` (legacy senders) keep the pre-epoch dedupe exactly,
 * including its restart-deafness bug — declared limitation, acceptable
 * because both ends of a dev-mode room run epoch-stamping builds.
 *
 * Shape per the repo template (`transport/media-event-policy.ts`):
 * snapshot in, tagged union out with a `reason`, table-tested, no mocks.
 */

/**
 * Quiet window for the stale-epoch fallback arm. NOT a liveness
 * predicate: it serves voice-session admission only (how long the
 * receiver must have accepted nothing before an older-epoch stream is
 * adopted as a new session). Both sides of the comparison ride the
 * store clock (`lastAcceptedMs` stamps and the caller's `now`), the same
 * timebase as `peerLastRecvMs`. Chosen above any plausible in-session
 * reorder horizon (~hundreds of ms on the signals carrier) and well
 * below human-noticeable deafness.
 */
export const VOICE_SESSION_ADOPT_GAP_MS = 2000;

/**
 * The epoch for a new capture session: the sender's wall clock, forced
 * strictly past the previous epoch. Wall clock (not the injectable
 * store clock) because the epoch is a wire value compared only against
 * the SAME sender's previous values — cross-restart uniqueness is the
 * point, cross-machine comparison never happens.
 */
export function nextVoiceEpoch(nowMs: number, prevEpoch: number): number {
  return Math.max(nowMs, prevEpoch + 1);
}

export interface VoiceAdmissionSnapshot {
  /** The frame's capture-session epoch (`ep`); null on legacy frames. */
  epoch: number | null;
  /** The frame's sequence number within its session. */
  seq: number;
  /** The receiver's adopted epoch for this peer; null before any epoch-bearing frame. */
  lastEpoch: number | null;
  /** The receiver's seq high-water within the adopted session (0 = none yet). */
  lastSeq: number;
  /** Store-clock ms since the last ACCEPTED frame from this peer; null if none ever. */
  msSinceAccepted: number | null;
}

export type VoiceAdmission =
  | { action: 'accept'; reason: 'legacy' | 'in-session' }
  | { action: 'adopt-session'; reason: 'first-epoch' | 'newer-epoch' | 'quiet-stale-epoch' }
  | { action: 'drop'; reason: 'stale-seq' | 'stale-epoch' };

export function decideVoiceAdmission(s: VoiceAdmissionSnapshot): VoiceAdmission {
  if (s.epoch === null) {
    // Legacy sender: the pre-epoch dedupe, verbatim.
    if (s.lastSeq !== 0 && s.seq <= s.lastSeq) {
      return { action: 'drop', reason: 'stale-seq' };
    }
    return { action: 'accept', reason: 'legacy' };
  }
  if (s.lastEpoch === null) {
    return { action: 'adopt-session', reason: 'first-epoch' };
  }
  if (s.epoch === s.lastEpoch) {
    if (s.lastSeq !== 0 && s.seq <= s.lastSeq) {
      return { action: 'drop', reason: 'stale-seq' };
    }
    return { action: 'accept', reason: 'in-session' };
  }
  if (s.epoch > s.lastEpoch) {
    return { action: 'adopt-session', reason: 'newer-epoch' };
  }
  // Older epoch. Drop while the adopted session is live; adopt after a
  // quiet window (or in the nothing-ever-accepted corner) so a
  // backwards-stepped sender clock cannot deafen the receiver forever.
  if (s.msSinceAccepted === null || s.msSinceAccepted > VOICE_SESSION_ADOPT_GAP_MS) {
    return { action: 'adopt-session', reason: 'quiet-stale-epoch' };
  }
  return { action: 'drop', reason: 'stale-epoch' };
}
