import { describe, expect, it } from 'vitest';
import type { StoredTranscript } from '../store';
import {
  formatOffset,
  renderTranscriptMarkdown,
  speakerCount,
  speakerLabel,
  transcriptFileName,
  transcriptLines,
  wordCount,
} from '../export';

function frame(speaker: string, seq: number, committedAtMs: number, text: string) {
  return { speaker, transcriber: speaker, seq, tStart: 0, tEnd: 1000, committedAtMs, text };
}

const base: StoredTranscript = {
  id: 'r:1000',
  roomKey: 'r',
  roomName: 'Main Room',
  startedAt: 1000,
  endedAt: 90_000,
  frames: [
    frame('bob', 0, 20_000, 'second speaker'),
    frame('alice', 0, 10_000, 'hello'),
    frame('alice', 1, 11_000, 'there'),
    frame('alice', 2, 16_000, 'after a pause'),
    frame('alice', 3, 17_000, '[BLANK_AUDIO]'),
    frame('alice', 4, 18_000, '  '),
  ],
  labels: { alice: 'Alice' },
};

describe('speakerLabel', () => {
  it('prefers the frozen label, then the live resolver, then a pubkey prefix', () => {
    expect(speakerLabel(base, 'alice', () => 'Live Alice')).toBe('Alice');
    expect(speakerLabel(base, 'bob', () => 'Bob')).toBe('Bob');
    expect(speakerLabel(base, 'uhCAk0123456789abcdef')).toBe('uhCAk01234…');
  });
});

describe('transcriptLines', () => {
  it('orders by commit time, drops blank and marker frames, and coalesces same-speaker runs within 3 s', () => {
    const lines = transcriptLines(base, (pk) => (pk === 'bob' ? 'Bob' : undefined));
    expect(lines.map((l) => `${l.label}: ${l.text}`)).toEqual([
      'Alice: hello there ⋯ after a pause',
      'Bob: second speaker',
    ]);
    expect(lines[0].ts).toBe(10_000);
  });

  it('starts a new line when the speaker changes even within 3 s', () => {
    const t: StoredTranscript = {
      ...base,
      frames: [frame('alice', 0, 1000, 'a'), frame('bob', 0, 1500, 'b'), frame('alice', 1, 2000, 'c')],
    };
    expect(transcriptLines(t).map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('renderTranscriptMarkdown', () => {
  it('writes a header, offset-stamped lines, and a participants key', () => {
    const md = renderTranscriptMarkdown(base, (pk) => (pk === 'bob' ? 'Bob' : undefined));
    expect(md.startsWith('# Transcript — Main Room\n')).toBe(true);
    expect(md).toContain('**[00:00]** **Alice:** hello there ⋯ after a pause');
    expect(md).toContain('**[00:10]** **Bob:** second speaker');
    expect(md).toContain('## Participants');
    expect(md).toContain('- **Alice** — `alice`');
    expect(md).toContain('- **Bob** — `bob`');
  });
});

describe('counts and names', () => {
  it('counts words of kept frames and distinct speakers', () => {
    expect(wordCount(base)).toBe(7);
    expect(speakerCount(base)).toBe(2);
  });

  it('formats offsets as MM:SS or HH:MM:SS', () => {
    expect(formatOffset(0)).toBe('00:00');
    expect(formatOffset(65_000)).toBe('01:05');
    expect(formatOffset(3_725_000)).toBe('01:02:05');
  });

  it('builds a file name from the room and start time', () => {
    expect(transcriptFileName(base)).toBe('transcript-Main-Room-1970-01-01T00-00-01-000Z.md');
  });
});
