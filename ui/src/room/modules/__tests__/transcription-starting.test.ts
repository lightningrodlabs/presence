import { afterEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from '@holochain-open-dev/stores';
import type { StreamsStore } from '../../../streams-store';
import { transcriptionController } from '../transcription';

/** Host whose openSession blocks until the test releases it, to observe the starting phase. */
function gatedHost() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const warmUp = vi.fn(async () => {});
  const localModels = {
    capabilities: async () => ({ asr: { available: true } }),
    asr: {
      warmUp,
      status: async () => 'idle' as const,
      openSession: async () => {
        await gate;
        return {
          sessionId: 's1',
          onFinal: () => () => {},
          onError: () => () => {},
          onPartial: () => () => {},
          pushAudio: async () => {},
          close: async () => {},
        };
      },
    },
  };
  return { localModels, release, warmUp };
}

function fakeStore(localModels: unknown) {
  return {
    myPubKeyB64: 'me',
    localModels,
    _myModuleStates: writable({}),
    _transcriptLog: writable(new Map()),
    sendModuleData: async () => {},
  } as unknown as StreamsStore;
}

describe('transcription start phase', () => {
  const g = globalThis as any;
  const savedProcessor = g.MediaStreamTrackProcessor;
  const savedWindow = g.window;

  afterEach(() => {
    transcriptionController.unbind();
    g.MediaStreamTrackProcessor = savedProcessor;
    g.window = savedWindow;
  });

  it('warms the model on bind and reports starting until the session is open', async () => {
    g.MediaStreamTrackProcessor = class {};
    if (!g.window) g.window = { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), localStorage: { getItem: () => null } };
    const host = gatedHost();
    transcriptionController.bind(fakeStore(host.localModels));
    await Promise.resolve();
    expect(host.warmUp).toHaveBeenCalledTimes(1);

    expect(get(transcriptionController.isStarting)).toBe(false);
    const starting = transcriptionController.startCapture();
    await Promise.resolve();
    await Promise.resolve();
    expect(get(transcriptionController.isStarting)).toBe(true);
    host.release();
    expect(await starting).toBe(true);
    expect(get(transcriptionController.isStarting)).toBe(false);
  });

  it('clears starting when the session open fails', async () => {
    g.MediaStreamTrackProcessor = class {};
    if (!g.window) g.window = { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), localStorage: { getItem: () => null } };
    const host = gatedHost();
    host.localModels.asr.openSession = async () => { throw new Error('nope'); };
    transcriptionController.bind(fakeStore(host.localModels));
    expect(await transcriptionController.startCapture()).toBe(false);
    expect(get(transcriptionController.isStarting)).toBe(false);
  });
});
