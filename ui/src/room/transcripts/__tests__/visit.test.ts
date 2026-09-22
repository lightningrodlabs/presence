import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from '@holochain-open-dev/stores';
import type { StreamsStore } from '../../../streams-store';
import { transcriptionController, type TranscriptEntry, type TranscriptFrame } from '../../modules/transcription';
import { MemoryTranscriptStore } from '../store';

function frame(speaker: string, seq: number, text: string, committedAtMs: number): TranscriptFrame {
  return { speaker, transcriber: speaker, seq, tStart: 0, tEnd: 1000, committedAtMs, text };
}

function fakeStore(store: MemoryTranscriptStore, roomKey: string) {
  return {
    myPubKeyB64: 'me',
    _myModuleStates: writable({}),
    _transcriptLog: writable(new Map<string, TranscriptEntry[]>()),
    sendModuleData: async () => {},
    transcripts: { store, roomKey },
  } as unknown as StreamsStore;
}

/** The controller's ingestion entry point for a peer frame, as the module's onData calls it. */
function ingest(fromAgent: string, f: TranscriptFrame) {
  transcriptionController.receiveFrame(fromAgent, JSON.stringify(f));
}

describe('transcript visit lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    transcriptionController.unbind();
    vi.useRealTimers();
  });

  it('opens a visit on bind, writes frames from every speaker, and closes it on endVisit', async () => {
    const store = new MemoryTranscriptStore();
    transcriptionController.bind(fakeStore(store, 'room-a'));
    transcriptionController.setVisitRoomName('Main Room');
    transcriptionController.setSpeakerLabelResolver((pk) => (pk === 'alice' ? 'Alice' : undefined));
    await vi.runOnlyPendingTimersAsync();

    let list = await store.listForRoom('room-a');
    expect(list).toHaveLength(1);
    expect(list[0].startedAt).toBe(1_000_000);
    expect(list[0].endedAt).toBeUndefined();
    expect(get(transcriptionController.liveVisit)?.id).toBe(list[0].id);

    ingest('alice', frame('alice', 0, 'hello', 1_001_000));
    ingest('bob', frame('bob', 0, 'hi', 1_002_000));
    ingest('alice', frame('alice', 0, 'hello again', 1_001_000)); // duplicate (transcriber, seq)
    list = await store.listForRoom('room-a');
    expect(list[0].frames).toHaveLength(0); // not written yet: writes are coalesced
    await vi.advanceTimersByTimeAsync(2_000);
    list = await store.listForRoom('room-a');
    expect(list[0].frames.map((f) => f.text)).toEqual(['hello', 'hi']);
    expect(list[0].roomName).toBe('Main Room');

    await transcriptionController.endVisit();
    list = await store.listForRoom('room-a');
    expect(typeof list[0].endedAt).toBe('number');
    expect(list[0].endedAt).toBeGreaterThanOrEqual(list[0].startedAt);
    expect(list[0].labels).toEqual({ alice: 'Alice' });
    expect(get(transcriptionController.liveVisit)).toBeNull();
  });

  it('deletes a visit that received no frames', async () => {
    const store = new MemoryTranscriptStore();
    transcriptionController.bind(fakeStore(store, 'room-a'));
    await vi.runOnlyPendingTimersAsync();
    expect(await store.listForRoom('room-a')).toHaveLength(1);
    await transcriptionController.endVisit();
    expect(await store.listForRoom('room-a')).toHaveLength(0);
  });

  it('does nothing without a transcripts dep', async () => {
    const s = fakeStore(new MemoryTranscriptStore(), 'room-a');
    delete (s as any).transcripts;
    transcriptionController.bind(s);
    ingest('alice', frame('alice', 0, 'hello', 1_001_000));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(get(transcriptionController.liveVisit)).toBeNull();
    await transcriptionController.endVisit();
  });
});
