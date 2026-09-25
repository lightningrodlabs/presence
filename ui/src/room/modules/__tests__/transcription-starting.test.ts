import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from '@holochain-open-dev/stores';
import type { StreamsStore } from '../../../streams-store';
import { transcriptionController, AUTO_ACCEPT_KEY } from '../transcription';
import { getModule } from '../registry';
import type { ModuleStateEnvelope } from '../../../types';

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

/**
 * A store fake whose activate/deactivate mirror StreamsStore's: they
 * write `_myModuleStates` and then fire the registered module hooks, so
 * `acceptRequest` → onActivate → startCapture runs the production chain.
 */
function moduleStore(localModels: unknown) {
  const states = writable<Record<string, ModuleStateEnvelope>>({});
  const deactivateModule = vi.fn(async (moduleId: string) => {
    states.update(s => {
      const next = { ...s };
      delete next[moduleId];
      return next;
    });
    getModule(moduleId)?.onDeactivate?.();
  });
  const store = {
    myPubKeyB64: 'me',
    localModels,
    _myModuleStates: states,
    _transcriptLog: writable(new Map()),
    sendModuleData: async () => {},
    // Like StreamsStore.updateModuleState: the write lands before the
    // broadcast await.
    async updateModuleState(moduleId: string, payload: string) {
      states.update(s => ({
        ...s,
        [moduleId]: { moduleId, active: true, payload, updatedAt: 1 },
      }));
      await Promise.resolve();
    },
    deactivateModule,
    async activateModule(moduleId: string, payload?: string) {
      states.update(s => ({
        ...s,
        [moduleId]: { moduleId, active: true, payload: payload ?? '{}', updatedAt: 1 },
      }));
      getModule(moduleId)?.onActivate?.({ streamsStore: store, myPubKeyB64: 'me' } as any);
    },
  };
  return { store: store as unknown as StreamsStore, states, deactivateModule };
}

const requestedEnvelope = (): ModuleStateEnvelope => ({
  moduleId: 'transcription',
  active: true,
  payload: JSON.stringify({ enabled: true, requested: true }),
  updatedAt: 1,
});

describe('a host without local models (the old-Moss case)', () => {
  const g = globalThis as any;
  const savedProcessor = g.MediaStreamTrackProcessor;
  const savedWindow = g.window;
  let stored: Record<string, string>;

  beforeEach(() => {
    g.MediaStreamTrackProcessor = class {};
    stored = {};
    g.window = {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      localStorage: {
        getItem: (k: string) => stored[k] ?? null,
        setItem: (k: string, v: string) => { stored[k] = v; },
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    transcriptionController.unbind();
    transcriptionController.lastError.set(null);
    g.MediaStreamTrackProcessor = savedProcessor;
    g.window = savedWindow;
    vi.restoreAllMocks();
  });

  it('a failed start reverts our advertised enabled state (startCapture false, module deactivated)', async () => {
    const { store, states, deactivateModule } = moduleStore(undefined);
    transcriptionController.bind(store);
    states.set({ transcription: requestedEnvelope() });
    expect(await transcriptionController.startCapture()).toBe(false);
    expect(deactivateModule).toHaveBeenCalledWith('transcription');
    expect(get(states)['transcription']).toBeUndefined();
  });

  it('acceptRequest on a host whose start fails ends deactivated, not advertising enabled', async () => {
    // localModels present but reporting no ASR: the request prompt is
    // legitimate, the accept goes through onActivate, and the start fails.
    const localModels = {
      capabilities: async () => ({ asr: { available: false } }),
      asr: { openSession: async () => { throw new Error('unused'); } },
    };
    const { store, states, deactivateModule } = moduleStore(localModels);
    transcriptionController.bind(store);
    await transcriptionController.acceptRequest('peer');
    await vi.waitFor(() => expect(deactivateModule).toHaveBeenCalledWith('transcription'));
    expect(get(states)['transcription']).toBeUndefined();
  });

  it('a peer request is not queued for a prompt when the store has no localModels', () => {
    const { store } = moduleStore(undefined);
    transcriptionController.bind(store);
    transcriptionController.onPeerTranscriptionChange('peer', null, requestedEnvelope());
    expect(get(transcriptionController.pendingRequests).size).toBe(0);
  });

  it('auto-accept does not activate the module when the store has no localModels', async () => {
    stored[AUTO_ACCEPT_KEY] = 'true';
    const { store, states } = moduleStore(undefined);
    transcriptionController.bind(store);
    transcriptionController.onPeerTranscriptionChange('peer', null, requestedEnvelope());
    await Promise.resolve();
    expect(get(states)['transcription']).toBeUndefined();
  });

  it('negative control: with localModels present, the same request IS queued', () => {
    const { store } = moduleStore({ capabilities: async () => ({}), asr: {} });
    transcriptionController.bind(store);
    transcriptionController.onPeerTranscriptionChange('peer', null, requestedEnvelope());
    expect(get(transcriptionController.pendingRequests).has('peer')).toBe(true);
  });
});

/** A host whose open session hands the test its onError subscribers. */
function erroringHost(opts: { errorOnClose?: boolean } = {}) {
  const errorSubs = new Set<(e: Error) => void>();
  const fire = (e: Error) => { for (const cb of [...errorSubs]) cb(e); };
  const localModels = {
    capabilities: async () => ({ asr: { available: true } }),
    asr: {
      openSession: async () => ({
        sessionId: 's-err',
        onFinal: () => () => {},
        onPartial: () => () => {},
        onError: (cb: (e: Error) => void) => {
          errorSubs.add(cb);
          return () => errorSubs.delete(cb);
        },
        pushAudio: async () => {},
        close: async () => {
          if (opts.errorOnClose) fire(new Error('closed mid-stop'));
        },
      }),
    },
  };
  return { localModels, fire };
}

describe('a running session that fails (Task 4 fix round 2)', () => {
  const g = globalThis as any;
  const savedProcessor = g.MediaStreamTrackProcessor;
  const savedWindow = g.window;

  beforeEach(() => {
    g.MediaStreamTrackProcessor = class {};
    g.window = {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      localStorage: { getItem: () => null, setItem: () => {} },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    transcriptionController.unbind();
    transcriptionController.lastError.set(null);
    g.MediaStreamTrackProcessor = savedProcessor;
    g.window = savedWindow;
    vi.restoreAllMocks();
  });

  it('onError mid-call deactivates the module through the one revert and keeps lastError', async () => {
    const host = erroringHost();
    const { store, states, deactivateModule } = moduleStore(host.localModels);
    transcriptionController.bind(store);
    states.set({ transcription: requestedEnvelope() });
    expect(await transcriptionController.startCapture()).toBe(true);
    expect(deactivateModule).not.toHaveBeenCalled();

    host.fire(new Error('sidecar crashed'));

    await vi.waitFor(() => expect(deactivateModule).toHaveBeenCalledWith('transcription'));
    expect(deactivateModule).toHaveBeenCalledTimes(1);
    expect(get(states)['transcription']).toBeUndefined();
    expect(get(transcriptionController.lastError)).toContain('sidecar crashed');
  });

  it('negative control: stopAndAnnounce deactivates exactly once', async () => {
    const host = erroringHost();
    const { store, states, deactivateModule } = moduleStore(host.localModels);
    transcriptionController.bind(store);
    states.set({ transcription: requestedEnvelope() });
    expect(await transcriptionController.startCapture()).toBe(true);

    await transcriptionController.stopAndAnnounce();
    await new Promise(r => setTimeout(r, 0));
    expect(deactivateModule).toHaveBeenCalledTimes(1);
  });

  it('leaving the room (unbind) while the closing session errors does not deactivate', async () => {
    const host = erroringHost({ errorOnClose: true });
    const { store, states, deactivateModule } = moduleStore(host.localModels);
    transcriptionController.bind(store);
    states.set({ transcription: requestedEnvelope() });
    expect(await transcriptionController.startCapture()).toBe(true);

    transcriptionController.unbind();
    await new Promise(r => setTimeout(r, 0));
    expect(deactivateModule).not.toHaveBeenCalled();
  });

  it('an error raised while a purposeful stop closes the session does not add a second deactivate', async () => {
    const host = erroringHost({ errorOnClose: true });
    const { store, states, deactivateModule } = moduleStore(host.localModels);
    transcriptionController.bind(store);
    states.set({ transcription: requestedEnvelope() });
    expect(await transcriptionController.startCapture()).toBe(true);

    await transcriptionController.stopAndAnnounce();
    await new Promise(r => setTimeout(r, 0));
    expect(deactivateModule).toHaveBeenCalledTimes(1);
  });
});
