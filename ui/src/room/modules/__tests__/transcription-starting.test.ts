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

/**
 * A host whose sessions hand the test their onError subscribers. Every
 * openSession returns a fresh session; `fire` reaches the most recent
 * one. `errorOnClose` fires an error from inside close(); `gateClose`
 * holds every close() until `releaseClose()`.
 */
function erroringHost(opts: { errorOnClose?: boolean; gateClose?: boolean; errorOnEndOfUtterance?: boolean } = {}) {
  let current = new Set<(e: Error) => void>();
  const fire = (e: Error) => { for (const cb of [...current]) cb(e); };
  let releaseClose!: () => void;
  const closeGate = new Promise<void>(r => (releaseClose = r));
  let opened = 0;
  const localModels = {
    capabilities: async () => ({ asr: { available: true } }),
    asr: {
      openSession: async () => {
        opened += 1;
        const subs = new Set<(e: Error) => void>();
        current = subs;
        return {
          sessionId: `s-err-${opened}`,
          onFinal: () => () => {},
          onPartial: () => () => {},
          onError: (cb: (e: Error) => void) => {
            subs.add(cb);
            return () => subs.delete(cb);
          },
          pushAudio: async (_pcm: Int16Array, endOfUtterance?: boolean) => {
            if (endOfUtterance && opts.errorOnEndOfUtterance) {
              // Delivered as the host does: from the transport's incoming
              // message, after the call that caused it, while it is awaited.
              await Promise.resolve();
              for (const cb of [...subs]) cb(new Error('push failed mid-stop'));
            }
          },
          close: async () => {
            if (opts.errorOnClose) for (const cb of [...subs]) cb(new Error('closed mid-stop'));
            if (opts.gateClose) await closeGate;
          },
        };
      },
    },
  };
  return { localModels, fire, releaseClose, opened: () => opened };
}

async function ticks(n: number) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('a running session that fails (Task 4 fix rounds 2 and 3)', () => {
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

  async function started(host: ReturnType<typeof erroringHost>) {
    const m = moduleStore(host.localModels);
    transcriptionController.bind(m.store);
    m.states.set({ transcription: requestedEnvelope() });
    expect(await transcriptionController.startCapture()).toBe(true);
    return m;
  }

  it('onError mid-call deactivates the module through the one revert and keeps lastError', async () => {
    const host = erroringHost();
    const { states, deactivateModule } = await started(host);
    expect(deactivateModule).not.toHaveBeenCalled();

    host.fire(new Error('sidecar crashed'));

    await vi.waitFor(() => expect(deactivateModule).toHaveBeenCalledWith('transcription'));
    expect(deactivateModule).toHaveBeenCalledTimes(1);
    expect(get(states)['transcription']).toBeUndefined();
    expect(get(transcriptionController.lastError)).toContain('sidecar crashed');
  });

  it('an error raised while stopAndAnnounce closes the session adds no revert and no error toast', async () => {
    const host = erroringHost({ errorOnClose: true });
    const { deactivateModule } = await started(host);

    await transcriptionController.stopAndAnnounce();
    await new Promise(r => setTimeout(r, 0));
    expect(deactivateModule).toHaveBeenCalledTimes(1); // stopAndAnnounce's own
    expect(get(transcriptionController.lastError)).toBeNull();
  });

  it('ordering independence: the same, with the enabled:false write delayed by extra microtasks', async () => {
    // The reviewer's measured reorder: ticks between stopAndAnnounce's
    // `await this.stopCapture()` and its updateModuleState write. The
    // error is told apart when it fires, so the delay changes nothing.
    const host = erroringHost({ errorOnClose: true });
    const m = await started(host);
    const realUpdate = (m.store as any).updateModuleState;
    (m.store as any).updateModuleState = async (id: string, payload: string) => {
      await ticks(20);
      return realUpdate(id, payload);
    };

    await transcriptionController.stopAndAnnounce();
    await new Promise(r => setTimeout(r, 0));
    expect(m.deactivateModule).toHaveBeenCalledTimes(1);
  });

  it('an error raised during the stop\'s end-of-utterance push (before the session is nulled) adds no revert', async () => {
    // _doStopCapture awaits stopPump — whose end-of-utterance pushAudio
    // runs while this.session is still set — before it nulls the session
    // and closes it. The stop is told apart by stopInFlight, which spans
    // that window too.
    g.MediaStreamTrackProcessor = class {
      readable = {
        getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }),
      };
    };
    const host = erroringHost({ errorOnEndOfUtterance: true });
    const m = moduleStore(host.localModels);
    (m.store as any).micSource = {
      acquire: async () => ({
        track: { getSettings: () => ({ sampleRate: 48_000 }), enabled: true },
        release: () => {},
      }),
    };
    m.states.set({
      transcription: requestedEnvelope(),
      conversation: {
        moduleId: 'conversation',
        active: true,
        payload: JSON.stringify({ micMuted: false }),
        updatedAt: 1,
      },
    });
    transcriptionController.bind(m.store);
    expect(await transcriptionController.startCapture()).toBe(true);
    await vi.waitFor(() => expect(get(transcriptionController.isCapturing)).toBe(true));

    await transcriptionController.stopAndAnnounce();
    await new Promise(r => setTimeout(r, 0));
    expect(m.deactivateModule).toHaveBeenCalledTimes(1);
    expect(get(transcriptionController.lastError)).toBeNull();
  });

  it('an error raised while unbind (leaving) closes the session does not deactivate', async () => {
    const host = erroringHost({ errorOnClose: true });
    const { deactivateModule } = await started(host);

    transcriptionController.unbind();
    await new Promise(r => setTimeout(r, 0));
    expect(deactivateModule).not.toHaveBeenCalled();
  });

  it('a re-enable between the error and the end of the stop is not reverted', async () => {
    const host = erroringHost({ gateClose: true });
    const m = await started(host);

    host.fire(new Error('sidecar crashed')); // stop begins; close() is held
    await ticks(5);
    // The user turns transcription back on inside the close() window.
    await m.store.activateModule(
      'transcription',
      JSON.stringify({ enabled: true, requested: true }),
    );
    host.releaseClose();
    await new Promise(r => setTimeout(r, 0));

    expect(m.deactivateModule).not.toHaveBeenCalled();
    expect(get(m.states)['transcription']).toBeDefined();
  });

  it('a bind() to another room before the stop resolves leaves that room alone', async () => {
    const host = erroringHost({ gateClose: true });
    await started(host);

    host.fire(new Error('sidecar crashed'));
    await ticks(5);
    const roomB = moduleStore(host.localModels);
    roomB.states.set({ transcription: requestedEnvelope() });
    transcriptionController.bind(roomB.store);
    host.releaseClose();
    await new Promise(r => setTimeout(r, 0));

    expect(roomB.deactivateModule).not.toHaveBeenCalled();
  });
});
