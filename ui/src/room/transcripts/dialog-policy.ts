import type { StoredTranscript } from './store';

/**
 * The rows the transcripts dialog lists: the live visit first once it
 * holds a frame, then the stored entries in store order (newest first),
 * minus the live visit's own stored copy and any entry without frames.
 */
export function selectTranscriptRows(
  live: StoredTranscript | null,
  stored: StoredTranscript[],
): StoredTranscript[] {
  const liveRow = live && live.frames.length > 0 ? live : null;
  const liveId = live?.id ?? null;
  const rest = stored.filter((t) => t.id !== liveId && t.frames.length > 0);
  return liveRow ? [liveRow, ...rest] : rest;
}

export type TranscriptDuration =
  | { kind: 'live' }
  | { kind: 'ended'; ms: number }
  | { kind: 'open'; ms: number }
  | { kind: 'empty' };

/**
 * How long a listed transcript ran. `live` is reserved for the visit being
 * recorded; a record with no `endedAt` (its page was killed mid-call) is
 * `open` and spans up to its last frame.
 */
export function describeDuration(t: StoredTranscript, liveId: string | null): TranscriptDuration {
  if (t.id === liveId) return { kind: 'live' };
  if (t.endedAt !== undefined) return { kind: 'ended', ms: t.endedAt - t.startedAt };
  if (t.frames.length === 0) return { kind: 'empty' };
  let last = t.frames[0].committedAtMs;
  for (const f of t.frames) if (f.committedAtMs > last) last = f.committedAtMs;
  return { kind: 'open', ms: last - t.startedAt };
}
