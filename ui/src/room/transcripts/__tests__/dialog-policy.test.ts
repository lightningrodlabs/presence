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
  const cases: Array<{ name: string; live: StoredTranscript | null; stored: StoredTranscript[]; ids: string[] }> = [
    { name: 'no live, stored kept in order', live: null, stored: [t('b', { frames: [1] }), t('a', { frames: [1] })], ids: ['b', 'a'] },
    { name: 'stored entries without frames are dropped', live: null, stored: [t('b'), t('a', { frames: [1] })], ids: ['a'] },
    { name: 'live with frames comes first', live: t('l', { frames: [1] }), stored: [t('a', { frames: [1] })], ids: ['l', 'a'] },
    { name: 'live without frames is not listed', live: t('l'), stored: [t('a', { frames: [1] })], ids: ['a'] },
    { name: "live's stored copy is excluded", live: t('l', { frames: [1, 2] }), stored: [t('l', { frames: [1] }), t('a', { frames: [1] })], ids: ['l', 'a'] },
    { name: "live's stored copy is excluded while live has no frames", live: t('l'), stored: [t('l', { frames: [1] })], ids: [] },
    { name: 'nothing at all', live: null, stored: [], ids: [] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(selectTranscriptRows(c.live, c.stored).map((r) => r.id)).toEqual(c.ids);
    });
  }

  it('returns the live object itself, so the row reflects the latest frames', () => {
    const live = t('l', { frames: [1, 2] });
    expect(selectTranscriptRows(live, [t('l', { frames: [1] })])[0]).toBe(live);
  });
});

describe('describeDuration', () => {
  const cases: Array<{ name: string; t: StoredTranscript; liveId: string | null; want: ReturnType<typeof describeDuration> }> = [
    { name: 'the live visit', t: t('l', { endedAt: 50, frames: [10] }), liveId: 'l', want: { kind: 'live' } },
    { name: 'ended', t: t('a', { startedAt: 100, endedAt: 4_100 }), liveId: 'l', want: { kind: 'ended', ms: 4_000 } },
    { name: 'ended with no live visit', t: t('a', { startedAt: 100, endedAt: 100 }), liveId: null, want: { kind: 'ended', ms: 0 } },
    { name: 'left open: last frame offset, frames out of order', t: t('a', { startedAt: 100, frames: [900, 2_100, 400] }), liveId: null, want: { kind: 'open', ms: 2_000 } },
    { name: 'left open with no frames', t: t('a', { startedAt: 100 }), liveId: 'l', want: { kind: 'empty' } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(describeDuration(c.t, c.liveId)).toEqual(c.want);
    });
  }
});
