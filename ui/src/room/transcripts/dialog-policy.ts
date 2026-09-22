import type { StoredTranscript } from './store';

/**
 * The rows the transcripts dialog lists: the stored entries in store
 * order (newest first), minus any entry without frames.
 */
export function selectTranscriptRows(stored: StoredTranscript[]): StoredTranscript[] {
  return stored.filter((t) => t.frames.length > 0);
}

export type TranscriptDuration =
  | { kind: 'ended'; ms: number }
  | { kind: 'open'; ms: number }
  | { kind: 'empty' };

/**
 * How long a listed transcript ran. A record with no `endedAt` (its page
 * was killed mid-call) is `open` and spans up to its last frame.
 */
export function describeDuration(t: StoredTranscript): TranscriptDuration {
  if (t.endedAt !== undefined) return { kind: 'ended', ms: t.endedAt - t.startedAt };
  if (t.frames.length === 0) return { kind: 'empty' };
  let last = t.frames[0].committedAtMs;
  for (const f of t.frames) if (f.committedAtMs > last) last = f.committedAtMs;
  return { kind: 'open', ms: last - t.startedAt };
}
