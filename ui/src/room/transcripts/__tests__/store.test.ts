import { describe, expect, it } from 'vitest';
import {
  FallbackTranscriptStore,
  IndexedDbTranscriptStore,
  MemoryTranscriptStore,
  transcriptId,
  type StoredTranscript,
  type TranscriptStore,
} from '../store';

function transcript(roomKey: string, startedAt: number, text = 'hi'): StoredTranscript {
  return {
    id: transcriptId(roomKey, startedAt),
    roomKey,
    roomName: 'Main Room',
    startedAt,
    frames: [
      {
        speaker: 'a', transcriber: 'a', seq: 0, tStart: 0, tEnd: 1000,
        committedAtMs: startedAt + 1000, text,
      },
    ],
    labels: {},
  };
}

/** Contract every implementation must satisfy. */
function contract(name: string, make: () => TranscriptStore) {
  describe(`${name} contract`, () => {
    it('lists a room newest first and keeps rooms apart', async () => {
      const s = make();
      await s.put(transcript('room-a', 1000));
      await s.put(transcript('room-a', 3000));
      await s.put(transcript('room-b', 2000));
      const a = await s.listForRoom('room-a');
      expect(a.map((t) => t.startedAt)).toEqual([3000, 1000]);
      expect((await s.listForRoom('room-b')).map((t) => t.startedAt)).toEqual([2000]);
      expect(await s.listForRoom('room-c')).toEqual([]);
    });

    it('put replaces by id and get returns the latest', async () => {
      const s = make();
      await s.put(transcript('room-a', 1000, 'first'));
      await s.put(transcript('room-a', 1000, 'second'));
      const got = await s.get(transcriptId('room-a', 1000));
      expect(got?.frames[0].text).toBe('second');
      expect(await s.listForRoom('room-a')).toHaveLength(1);
    });

    it('delete removes and is idempotent', async () => {
      const s = make();
      await s.put(transcript('room-a', 1000));
      await s.delete(transcriptId('room-a', 1000));
      await s.delete(transcriptId('room-a', 1000));
      expect(await s.get(transcriptId('room-a', 1000))).toBeUndefined();
    });

    it('returns copies, so mutating a result does not change the store', async () => {
      const s = make();
      await s.put(transcript('room-a', 1000));
      const got = (await s.get(transcriptId('room-a', 1000)))!;
      got.frames.push({ ...got.frames[0], seq: 1, text: 'leak' });
      expect((await s.get(transcriptId('room-a', 1000)))!.frames).toHaveLength(1);
    });
  });
}

contract('MemoryTranscriptStore', () => new MemoryTranscriptStore());

describe('MemoryTranscriptStore degraded flag', () => {
  it('is false by default', () => {
    expect(new MemoryTranscriptStore().degraded).toBe(false);
  });

  it('is true when constructed with true', () => {
    expect(new MemoryTranscriptStore(true).degraded).toBe(true);
  });
});

const hasIndexedDb = typeof indexedDB !== 'undefined';
(hasIndexedDb ? describe : describe.skip)(
  'IndexedDbTranscriptStore (needs an indexedDB global; skipped in node)',
  () => {
    let dbCounter = 0;
    contract('IndexedDbTranscriptStore', () =>
      new IndexedDbTranscriptStore(indexedDB, `presence-transcripts-test-${dbCounter++}`),
    );
  },
);

describe('FallbackTranscriptStore', () => {
  class Broken implements TranscriptStore {
    readonly degraded = false;
    async listForRoom(): Promise<StoredTranscript[]> { throw new Error('idb down'); }
    async get(): Promise<StoredTranscript | undefined> { throw new Error('idb down'); }
    async put(): Promise<void> { throw new Error('idb down'); }
    async delete(): Promise<void> { throw new Error('idb down'); }
  }

  it('switches to the fallback after the first failure and reports degraded', async () => {
    const s = new FallbackTranscriptStore(new Broken(), new MemoryTranscriptStore());
    expect(s.degraded).toBe(false);
    await s.put(transcript('room-a', 1000));
    expect(s.degraded).toBe(true);
    expect((await s.listForRoom('room-a')).map((t) => t.startedAt)).toEqual([1000]);
  });

  contract('FallbackTranscriptStore over memory', () =>
    new FallbackTranscriptStore(new MemoryTranscriptStore(), new MemoryTranscriptStore()),
  );
});

describe('transcriptId', () => {
  it('joins room key and start time', () => {
    expect(transcriptId('uhC#presence', 1700000000000)).toBe('uhC#presence:1700000000000');
  });
});
