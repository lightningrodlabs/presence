import type { AgentPubKeyB64 } from '@holochain/client';
import type { StoredTranscript } from './store';

export type LabelFor = (pk: AgentPubKeyB64) => string | undefined;

export interface TranscriptLine {
  /** Commit time of the first frame in the line (sender wall clock). */
  ts: number;
  speaker: AgentPubKeyB64;
  label: string;
  text: string;
}

/** Sub-3 s gaps are phrase breaks; wider gaps get a visible stitch. */
const COALESCE_MS = 3000;
const STITCH_GLYPH = '⋯';
/** Whisper's non-speech markers, e.g. [BLANK_AUDIO], [NOISE]. */
const MARKER = /^\[[^\]]*\]\.?$/;

/** Fallback label for a speaker with no stored or live nickname. */
export function pubkeyPrefixLabel(pk: AgentPubKeyB64): string {
  return pk.slice(0, 10) + '…';
}

export function speakerLabel(
  t: StoredTranscript,
  pk: AgentPubKeyB64,
  live?: LabelFor,
): string {
  return t.labels[pk] ?? live?.(pk) ?? pubkeyPrefixLabel(pk);
}

function keptFrames(t: StoredTranscript) {
  return t.frames
    .map((f) => ({ ...f, text: f.text.trim() }))
    .filter((f) => f.text && !MARKER.test(f.text))
    .sort((a, b) => a.committedAtMs - b.committedAtMs);
}

export function transcriptLines(t: StoredTranscript, live?: LabelFor): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const f of keptFrames(t)) {
    const prev = lines[lines.length - 1];
    if (prev && prev.speaker === f.speaker) {
      const joiner = f.committedAtMs - prev.ts < COALESCE_MS ? ' ' : ` ${STITCH_GLYPH} `;
      prev.text = `${prev.text}${joiner}${f.text}`;
    } else {
      lines.push({
        ts: f.committedAtMs,
        speaker: f.speaker,
        label: speakerLabel(t, f.speaker, live),
        text: f.text,
      });
    }
  }
  return lines;
}

export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function renderTranscriptMarkdown(t: StoredTranscript, live?: LabelFor): string {
  const lines = transcriptLines(t, live);
  const t0 = lines.length > 0 ? lines[0].ts : t.startedAt;
  const header =
    `# Transcript — ${t.roomName}\n` +
    `_Started ${new Date(t.startedAt).toISOString()}_\n\n`;
  const body = lines
    .map((l) => `**[${formatOffset(l.ts - t0)}]** **${l.label}:** ${l.text}`)
    .join('\n\n');
  const speakers = [...new Set(lines.map((l) => l.speaker))];
  const key = speakers.map((pk) => `- **${speakerLabel(t, pk, live)}** — \`${pk}\``).join('\n');
  const keySection = speakers.length > 0 ? `\n\n---\n\n## Participants\n\n${key}\n` : '';
  return header + body + keySection;
}

export function wordCount(t: StoredTranscript): number {
  return keptFrames(t).reduce((n, f) => n + f.text.split(/\s+/).filter(Boolean).length, 0);
}

export function speakerCount(t: StoredTranscript): number {
  return new Set(keptFrames(t).map((f) => f.speaker)).size;
}

export function transcriptFileName(t: StoredTranscript): string {
  const room = t.roomName.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'room';
  const stamp = new Date(t.startedAt).toISOString().replace(/[:.]/g, '-');
  return `transcript-${room}-${stamp}.md`;
}
