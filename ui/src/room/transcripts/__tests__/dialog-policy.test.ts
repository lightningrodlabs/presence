import { describe, expect, it } from 'vitest';
import type { TranscriptFrame } from '../../modules/transcription';
import type { StoredTranscript } from '../store';
import { describeDuration, selectTranscriptRows } from '../dialog-policy';

function frame(committedAtMs: number): TranscriptFrame {
  return { speaker: 'a', transcriber: 'a', seq: committedAtMs, tStart: 0, tEnd: 1, committedAtMs, text: 'x' };
}

function t(id: string, opts: { frames?: number[]; startedAt?: number; endedAt?: number } = {}): StoredTranscript {
  return {
    id,
    roomKey: 'r',
    roomName: '',
    startedAt: opts.startedAt ?? 0,
    endedAt: opts.endedAt,
    frames: (opts.frames ?? []).map(frame),
    labels: {},
  };
}

describe('selectTranscriptRows', () => {
  const cases: Array<{ name: string; stored: StoredTranscript[]; ids: string[] }> = [
    { name: 'stored kept in order', stored: [t('b', { frames: [1] }), t('a', { frames: [1] })], ids: ['b', 'a'] },
    { name: 'entries without frames are dropped', stored: [t('b'), t('a', { frames: [1] })], ids: ['a'] },
    { name: 'order survives dropping', stored: [t('c', { frames: [1] }), t('b'), t('a', { frames: [1] })], ids: ['c', 'a'] },
    { name: 'nothing at all', stored: [], ids: [] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(selectTranscriptRows(c.stored).map((r) => r.id)).toEqual(c.ids);
    });
  }
});

describe('describeDuration', () => {
  const cases: Array<{ name: string; t: StoredTranscript; want: ReturnType<typeof describeDuration> }> = [
    { name: 'ended', t: t('a', { startedAt: 100, endedAt: 4_100 }), want: { kind: 'ended', ms: 4_000 } },
    { name: 'ended at once', t: t('a', { startedAt: 100, endedAt: 100 }), want: { kind: 'ended', ms: 0 } },
    { name: 'ended wins over frames', t: t('a', { startedAt: 100, endedAt: 600, frames: [10_000] }), want: { kind: 'ended', ms: 500 } },
    { name: 'left open: last frame offset, frames out of order', t: t('a', { startedAt: 100, frames: [900, 2_100, 400] }), want: { kind: 'open', ms: 2_000 } },
    { name: 'left open with no frames', t: t('a', { startedAt: 100 }), want: { kind: 'empty' } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(describeDuration(c.t)).toEqual(c.want);
    });
  }
});
