import { afterEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from '@holochain-open-dev/stores';
import type { StreamsStore } from '../../../streams-store';
import { ManualClock } from '../../../clock.testing';
import { transcriptionController, type TranscriptEntry } from '../transcription';

type FinalCb = (ev: { text: string; tStart: number; tEnd: number }) => void;

/** Minimal host: capabilities say available; sessions capture their onFinal callback. */
function fakeHost() {
  const sessions: Array<{ emit: FinalCb }> = [];
  return {
    sessions,
    localModels: {
      capabilities: async () => ({ asr: { available: true } }),
      asr: {
        openSession: async () => {
          let cb: FinalCb = () => {};
          const session = {
            sessionId: `s${sessions.length}`,
            onFinal: (f: FinalCb) => { cb = f; return () => {}; },
            onError: () => () => {},
            onPartial: () => () => {},
            pushAudio: async () => {},
            close: async () => {},
          };
          sessions.push({ emit: (ev) => cb(ev) });
          return session;
        },
      },
    },
  };
}

/** A store at `nowMs` on its clock; `sent` collects every broadcast frame's JSON. */
function fakeStore(host: ReturnType<typeof fakeHost>, me: string, nowMs: number) {
  const sent: string[] = [];
  const store = {
    myPubKeyB64: me,
    clock: new ManualClock(nowMs),
    localModels: host.localModels,
    _myModuleStates: writable({}),
    _transcriptLog: writable(new Map<string, TranscriptEntry[]>()),
    sendModuleData: async (_module: string, json: string) => { sent.push(json); },
  } as unknown as StreamsStore;
  return { store, sent };
}

describe('transcription frame sequence across capture sessions', () => {
  const g = globalThis as any;
  const savedProcessor = g.MediaStreamTrackProcessor;
  const savedWindow = g.window;

  afterEach(() => {
    transcriptionController.unbind();
    g.MediaStreamTrackProcessor = savedProcessor;
    g.window = savedWindow;
  });

  it('keeps numbering frames across stop and restart in one room, from a base seeded off the store clock', async () => {
    g.MediaStreamTrackProcessor = class {};
    if (!g.window) g.window = { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), localStorage: { getItem: () => null } };
    const host = fakeHost();
    const { store } = fakeStore(host, 'me', 1_000_000);
    transcriptionController.bind(store);

    expect(await transcriptionController.startCapture()).toBe(true);
    host.sessions[0].emit({ text: 'first session', tStart: 0, tEnd: 1000 });
    await transcriptionController.stopCapture();

    expect(await transcriptionController.startCapture()).toBe(true);
    host.sessions[1].emit({ text: 'second session', tStart: 0, tEnd: 1000 });
    await transcriptionController.stopCapture();

    const mine = get(store._transcriptLog).get('me') ?? [];
    expect(mine.map((e) => e.text)).toEqual(['first session', 'second session']);
    // Base = floor(clock / 1000) * 1000; the count continues across the restart.
    expect(mine.map((e) => e.seq)).toEqual([1_000_000, 1_000_001]);

    // A new room (new store, later clock) seeds its own base.
    const { store: store2 } = fakeStore(host, 'me', 1_010_000);
    transcriptionController.bind(store2);
    expect(await transcriptionController.startCapture()).toBe(true);
    host.sessions[2].emit({ text: 'new room', tStart: 0, tEnd: 1000 });
    await transcriptionController.stopCapture();
    expect((get(store2._transcriptLog).get('me') ?? []).map((e) => e.seq)).toEqual([1_010_000]);
  });

  it('a rejoin\'s first frame survives a receiver still holding the previous visit\'s frames (release review I2)', async () => {
    // Receivers dedupe by (transcriber, seq) in ingestFrame and never
    // clear on peer leave. A bind that restarted at 0 made A's first
    // frame after a leave-and-rejoin a duplicate of A's very first frame
    // in B's eyes, and B dropped it — and every frame up to the old count.
    g.MediaStreamTrackProcessor = class {};
    if (!g.window) g.window = { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), localStorage: { getItem: () => null } };
    const host = fakeHost();

    // A's first visit: two frames go out.
    const a1 = fakeStore(host, 'A', 1_000_000);
    transcriptionController.bind(a1.store);
    expect(await transcriptionController.startCapture()).toBe(true);
    host.sessions[0].emit({ text: 'one', tStart: 0, tEnd: 1000 });
    host.sessions[0].emit({ text: 'two', tStart: 1000, tEnd: 2000 });
    await transcriptionController.stopCapture();
    expect(a1.sent).toHaveLength(2);

    // B, who stays in the room, receives both.
    const b = fakeStore(host, 'B', 1_000_500);
    transcriptionController.bind(b.store);
    for (const json of a1.sent) transcriptionController.receiveFrame('A', json);
    expect((get(b.store._transcriptLog).get('A') ?? []).map(e => e.text)).toEqual(['one', 'two']);

    // A leaves and rejoins ten seconds later: a fresh store, a fresh bind.
    const a2 = fakeStore(host, 'A', 1_010_000);
    transcriptionController.bind(a2.store);
    expect(await transcriptionController.startCapture()).toBe(true);
    host.sessions[1].emit({ text: 'three', tStart: 0, tEnd: 1000 });
    await transcriptionController.stopCapture();
    expect(a2.sent).toHaveLength(1);

    // B receives A's first frame of the new visit: it must not be dropped.
    transcriptionController.bind(b.store);
    transcriptionController.receiveFrame('A', a2.sent[0]);
    // The log slots by tStart (session-relative), so read it in seq order.
    const atB = (get(b.store._transcriptLog).get('A') ?? []).slice().sort((x, y) => x.seq - y.seq);
    expect(atB.map(e => e.text)).toEqual(['one', 'two', 'three']);
    expect(new Set(atB.map(e => e.seq)).size).toBe(3);
  });

  it('finalSeq is undefined when a visit sent nothing, and the last seq when it did (the base is not "nothing sent")', async () => {
    g.MediaStreamTrackProcessor = class {};
    if (!g.window) g.window = { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), localStorage: { getItem: () => null } };
    const host = fakeHost();
    const announced: string[] = [];
    const { store } = fakeStore(host, 'me', 1_000_000);
    (store as any).updateModuleState = async (_id: string, payload: string) => { announced.push(payload); };
    (store as any).deactivateModule = async () => {};
    store._myModuleStates.set({
      transcription: { moduleId: 'transcription', active: true, payload: JSON.stringify({ enabled: true, requested: true }), updatedAt: 1 },
    });
    transcriptionController.bind(store);

    expect(await transcriptionController.startCapture()).toBe(true);
    await transcriptionController.stopAndAnnounce();
    expect(JSON.parse(announced[announced.length - 1]).finalSeq).toBeUndefined();

    expect(await transcriptionController.startCapture()).toBe(true);
    host.sessions[1].emit({ text: 'said', tStart: 0, tEnd: 1000 });
    await transcriptionController.stopAndAnnounce();
    expect(JSON.parse(announced[announced.length - 1]).finalSeq).toBe(1_000_000);
  });
});
