import { afterEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from '@holochain-open-dev/stores';
import type { StreamsStore } from '../../../streams-store';
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

function fakeStore(host: ReturnType<typeof fakeHost>, me: string) {
  return {
    myPubKeyB64: me,
    localModels: host.localModels,
    _myModuleStates: writable({}),
    _transcriptLog: writable(new Map<string, TranscriptEntry[]>()),
    sendModuleData: async () => {},
  } as unknown as StreamsStore;
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

  it('keeps numbering frames across stop and restart in one room, and restarts on rebind', async () => {
    g.MediaStreamTrackProcessor = class {};
    if (!g.window) g.window = { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), localStorage: { getItem: () => null } };
    const host = fakeHost();
    const store = fakeStore(host, 'me');
    transcriptionController.bind(store);

    expect(await transcriptionController.startCapture()).toBe(true);
    host.sessions[0].emit({ text: 'first session', tStart: 0, tEnd: 1000 });
    await transcriptionController.stopCapture();

    expect(await transcriptionController.startCapture()).toBe(true);
    host.sessions[1].emit({ text: 'second session', tStart: 0, tEnd: 1000 });
    await transcriptionController.stopCapture();

    const mine = get(store._transcriptLog).get('me') ?? [];
    expect(mine.map((e) => e.text)).toEqual(['first session', 'second session']);
    expect(mine.map((e) => e.seq)).toEqual([0, 1]);

    // A new room (new store) starts its own numbering.
    const store2 = fakeStore(host, 'me');
    transcriptionController.bind(store2);
    expect(await transcriptionController.startCapture()).toBe(true);
    host.sessions[2].emit({ text: 'new room', tStart: 0, tEnd: 1000 });
    await transcriptionController.stopCapture();
    expect((get(store2._transcriptLog).get('me') ?? []).map((e) => e.seq)).toEqual([0]);
  });
});
