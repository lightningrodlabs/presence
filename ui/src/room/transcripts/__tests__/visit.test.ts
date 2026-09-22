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

/**
 * Drains the microtask queue enough times to let a chain of Promise
 * `.then()`s settle. Independent of fake timers: Promise scheduling is
 * unaffected by `vi.useFakeTimers()`, which only replaces Date/timer
 * globals, so this works regardless of which timer mode is active.
 */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

type FinalCb = (ev: { text: string; tStart: number; tEnd: number }) => void;

interface FakeSession {
  emit: FinalCb;
  /** Resolves once the controller has actually called this session's
   *  close() — i.e. stopCapture has finished stopPump and reached the
   *  session-close step. */
  closeStarted: Promise<void>;
  /** Lets a pending close() resolve. Until called, `stopCapture`'s
   *  `await s.close()` stays pending, mirroring Moss holding close()
   *  open while it commits buffered audio and delivers the resulting
   *  final. */
  resolveClose: () => void;
}

/**
 * Minimal ASR host, shaped like transcription-seq.test.ts's fakeHost:
 * capabilities say available, sessions capture their onFinal callback.
 * Unlike that fixture, close() here stays pending until the test calls
 * resolveClose(), so a test can emit a final and/or rebind while a
 * session close is still in flight — reproducing the two fix-round-1
 * races.
 */
function fakeHost() {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    localModels: {
      capabilities: async () => ({ asr: { available: true } }),
      asr: {
        openSession: async () => {
          let cb: FinalCb = () => {};
          let resolveClose: () => void = () => {};
          let resolveCloseStarted: () => void = () => {};
          const closeStarted = new Promise<void>(r => { resolveCloseStarted = r; });
          const session = {
            sessionId: `s${sessions.length}`,
            onFinal: (f: FinalCb) => { cb = f; return () => {}; },
            onError: () => () => {},
            onPartial: () => () => {},
            pushAudio: async () => {},
            close: () => {
              resolveCloseStarted();
              return new Promise<void>(resolve => { resolveClose = resolve; });
            },
          };
          sessions.push({ emit: ev => cb(ev), closeStarted, resolveClose: () => resolveClose() });
          return session;
        },
      },
    },
  };
}

function fakeStoreWithHost(
  store: MemoryTranscriptStore,
  roomKey: string,
  host: ReturnType<typeof fakeHost>,
  me: string,
) {
  return {
    myPubKeyB64: me,
    localModels: host.localModels,
    _myModuleStates: writable({}),
    _transcriptLog: writable(new Map<string, TranscriptEntry[]>()),
    sendModuleData: async () => {},
    transcripts: { store, roomKey },
  } as unknown as StreamsStore;
}

describe('transcript visit lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    transcriptionController.unbind();
    transcriptionController.setSpeakerLabelResolver(null);
    vi.useRealTimers();
  });

  it('opens a visit on bind, writes frames from every speaker, and closes it on endVisit', async () => {
    const store = new MemoryTranscriptStore();
    transcriptionController.bind(fakeStore(store, 'room-a'));
    transcriptionController.setVisitRoomName('Main Room');
    transcriptionController.setSpeakerLabelResolver((pk) => (pk === 'alice' ? 'Alice' : undefined));
    await vi.runOnlyPendingTimersAsync();

    // A visit becomes a record on its first frame.
    let list = await store.listForRoom('room-a');
    expect(list).toHaveLength(0);
    expect(get(transcriptionController.liveVisit)?.startedAt).toBe(1_000_000);

    ingest('alice', frame('alice', 0, 'hello', 1_001_000));
    ingest('bob', frame('bob', 0, 'hi', 1_002_000));
    ingest('alice', frame('alice', 0, 'hello again', 1_001_000)); // duplicate (transcriber, seq)
    list = await store.listForRoom('room-a');
    expect(list).toHaveLength(0); // not written yet: writes are coalesced
    await vi.advanceTimersByTimeAsync(2_000);
    list = await store.listForRoom('room-a');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(get(transcriptionController.liveVisit)?.id);
    expect(list[0].startedAt).toBe(1_000_000);
    expect(list[0].endedAt).toBeUndefined();
    expect(list[0].frames.map((f) => f.text)).toEqual(['hello', 'hi']);
    expect(list[0].roomName).toBe('Main Room');

    await transcriptionController.endVisit();
    list = await store.listForRoom('room-a');
    expect(typeof list[0].endedAt).toBe('number');
    expect(list[0].endedAt).toBeGreaterThanOrEqual(list[0].startedAt);
    expect(list[0].labels).toEqual({ alice: 'Alice' });
    expect(get(transcriptionController.liveVisit)).toBeNull();
  });

  it('never stores a visit that received no frames', async () => {
    const store = new MemoryTranscriptStore();
    transcriptionController.bind(fakeStore(store, 'room-a'));
    transcriptionController.setVisitRoomName('Main Room'); // marks the visit dirty
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await store.listForRoom('room-a')).toHaveLength(0);
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

describe('transcript visit lifecycle races (fix round 1)', () => {
  const g = globalThis as any;
  const savedProcessor = g.MediaStreamTrackProcessor;
  const savedWindow = g.window;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    g.MediaStreamTrackProcessor = class {};
    if (!g.window) {
      g.window = {
        setInterval: vi.fn(() => 1),
        clearInterval: vi.fn(),
        localStorage: { getItem: () => null },
      };
    }
  });
  afterEach(() => {
    transcriptionController.unbind();
    transcriptionController.setSpeakerLabelResolver(null);
    vi.useRealTimers();
    g.MediaStreamTrackProcessor = savedProcessor;
    g.window = savedWindow;
  });

  it('a final emitted from inside session.close() lands in the visit, and the closed record has endedAt', async () => {
    const store = new MemoryTranscriptStore();
    const host = fakeHost();
    transcriptionController.bind(fakeStoreWithHost(store, 'room-a', host, 'me'));

    expect(await transcriptionController.startCapture()).toBe(true);

    transcriptionController.unbind();
    // Wait until stopCapture has actually reached the session-close
    // step (stopPump has nothing to do here since the mic was never
    // acquired, but the wait keeps this independent of that detail).
    await host.sessions[0].closeStarted;
    // Moss commits buffered audio and delivers the resulting final
    // while close() is in flight, strictly before it resolves.
    host.sessions[0].emit({ text: 'closing words', tStart: 0, tEnd: 500 });
    host.sessions[0].resolveClose();
    await flush();

    const list = await store.listForRoom('room-a');
    expect(list).toHaveLength(1);
    expect(list[0].frames.map(f => f.text)).toEqual(['closing words']);
    expect(typeof list[0].endedAt).toBe('number');
  });

  it('a rebind while an unbind close is pending closes only the old visit, and leaves the new one live and unswept', async () => {
    const storeA = new MemoryTranscriptStore();
    const storeB = new MemoryTranscriptStore();
    const host = fakeHost();
    transcriptionController.bind(fakeStoreWithHost(storeA, 'room-a', host, 'me'));

    expect(await transcriptionController.startCapture()).toBe(true);
    ingest('alice', frame('alice', 0, 'hello', 1_001_000));

    transcriptionController.unbind();
    // stopCapture is now paused inside `await s.close()` — A's store
    // and visit are still the live ones until that resolves.
    await host.sessions[0].closeStarted;

    // Enter room B before A's close resolves.
    transcriptionController.bind(fakeStoreWithHost(storeB, 'room-b', host, 'me'));
    expect(get(transcriptionController.liveVisit)?.roomKey).toBe('room-b');

    // Now let A's pending close resolve; unbind()'s deferred callback
    // must see that both `store` and `visit` have moved on and do
    // nothing to B.
    host.sessions[0].resolveClose();
    await flush();

    const listA = await storeA.listForRoom('room-a');
    expect(listA).toHaveLength(1);
    expect(listA[0].frames).toHaveLength(1);
    expect(typeof listA[0].endedAt).toBe('number');

    expect(get(transcriptionController.liveVisit)?.roomKey).toBe('room-b');

    // B's own coalesced write lands normally once it has a frame — it
    // was never touched by A's deferred close.
    ingest('bob', frame('bob', 0, 'hi', 1_002_000));
    await vi.advanceTimersByTimeAsync(2_000);
    const listB = await storeB.listForRoom('room-b');
    expect(listB).toHaveLength(1);
  });

  it('labels the closed visit through the resolver set at unbind time, not one set while the close is pending', async () => {
    const store = new MemoryTranscriptStore();
    const host = fakeHost();
    transcriptionController.bind(fakeStoreWithHost(store, 'room-a', host, 'me'));
    transcriptionController.setSpeakerLabelResolver((pk) => (pk === 'alice' ? 'Alice in A' : undefined));

    expect(await transcriptionController.startCapture()).toBe(true);
    ingest('alice', frame('alice', 0, 'hello', 1_001_000));

    transcriptionController.unbind();
    await host.sessions[0].closeStarted;

    // The next room's room-view installs its own resolver before the
    // old visit's deferred close has run.
    transcriptionController.setSpeakerLabelResolver((pk) => (pk === 'alice' ? 'Alice in B' : undefined));

    host.sessions[0].resolveClose();
    await flush();

    const list = await store.listForRoom('room-a');
    expect(list).toHaveLength(1);
    expect(typeof list[0].endedAt).toBe('number');
    expect(list[0].labels).toEqual({ alice: 'Alice in A' });
  });

  it('a second bind without an intervening unbind closes the first visit before opening the second', async () => {
    const storeA = new MemoryTranscriptStore();
    const storeB = new MemoryTranscriptStore();
    transcriptionController.bind(fakeStore(storeA, 'room-a'));
    ingest('alice', frame('alice', 0, 'hello', 1_001_000));

    transcriptionController.bind(fakeStore(storeB, 'room-b'));
    await flush();

    const listA = await storeA.listForRoom('room-a');
    expect(listA).toHaveLength(1);
    expect(listA[0].frames).toHaveLength(1);
    expect(typeof listA[0].endedAt).toBe('number');

    expect(get(transcriptionController.liveVisit)?.roomKey).toBe('room-b');
  });

  it('repeated unbind() calls before the closing commit settles do not drop it (fix round 2)', async () => {
    const store = new MemoryTranscriptStore();
    const host = fakeHost();
    transcriptionController.bind(fakeStoreWithHost(store, 'room-a', host, 'me'));

    expect(await transcriptionController.startCapture()).toBe(true);

    transcriptionController.unbind();
    await host.sessions[0].closeStarted;
    // StreamsStore.disconnect() has no re-entry guard and runs up to
    // three times per room leave (the quit button, then teardown from
    // both room-view and room-container); every call reaches unbind()
    // while the first close() is still in flight. Without a shared
    // in-flight stop, each of these would see `this.session` already
    // null and resolve its own stopCapture immediately, settling long
    // before the real close() below — which is exactly the drop this
    // test guards against, so the flush here is load-bearing: it lets
    // an unshared second/third stop (and its store/visit teardown) run
    // to completion before the real closing commit ever arrives.
    transcriptionController.unbind();
    transcriptionController.unbind();
    await flush();

    // Moss delivers the closing commit only now, strictly before the
    // real close() resolves.
    host.sessions[0].emit({ text: 'closing words', tStart: 0, tEnd: 500 });
    host.sessions[0].resolveClose();
    await flush();

    const list = await store.listForRoom('room-a');
    expect(list).toHaveLength(1);
    expect(list[0].frames.map(f => f.text)).toEqual(['closing words']);
    expect(typeof list[0].endedAt).toBe('number');
    expect(get(transcriptionController.liveVisit)).toBeNull();
  });
});
