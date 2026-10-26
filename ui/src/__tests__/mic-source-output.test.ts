/**
 * MicSource.setOutputDevice — the AudioContext half of the audio output
 * selection (`audio-sink.ts`). Signals voice playout connects to the shared
 * context's destination, so this is what moves signals-carried voice to
 * the chosen speaker.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MicSource, type MicSourceBindings } from '../mic-source';

class FakeAudioContext {
  sinkId = '';
  state = 'running';
  sinkCalls: string[] = [];
  rejectNext = false;
  setSinkId = async (id: string) => {
    this.sinkCalls.push(id);
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error('NotFoundError');
    }
    this.sinkId = id;
  };
  resume = async () => {};
  close = async () => {};
}

class NoSinkAudioContext {
  state = 'running';
  resume = async () => {};
  close = async () => {};
}

function rig() {
  const bindings: MicSourceBindings = {
    getDeviceId: () => undefined,
    setDeviceId: () => {},
    onTrackChange: () => {},
    onMutedChange: () => {},
    onLifecycleChange: () => {},
    onMixinDropped: () => {},
    now: () => 0,
  };
  return new MicSource(bindings);
}

afterEach(() => {
  delete (globalThis as any).AudioContext;
});

describe('MicSource.setOutputDevice', () => {
  it('a choice made before the lazy context exists is applied when it is created', () => {
    (globalThis as any).AudioContext = FakeAudioContext;
    const mic = rig();
    mic.setOutputDevice('spk-2');
    const ctx = (mic.ensureAudioContext() as unknown) as FakeAudioContext;
    expect(ctx.sinkCalls).toEqual(['spk-2']);
    expect(ctx.sinkId).toBe('spk-2');
  });

  it('a choice made after the context exists is applied immediately; the default clears it', () => {
    (globalThis as any).AudioContext = FakeAudioContext;
    const mic = rig();
    const ctx = (mic.ensureAudioContext() as unknown) as FakeAudioContext;
    expect(ctx.sinkCalls).toEqual([]); // default selection on a default context: no call
    mic.setOutputDevice('spk-2');
    expect(ctx.sinkCalls).toEqual(['spk-2']);
    mic.setOutputDevice(undefined);
    expect(ctx.sinkCalls).toEqual(['spk-2', '']);
    expect(ctx.sinkId).toBe('');
  });

  it('a context without setSinkId is left alone and nothing throws', () => {
    (globalThis as any).AudioContext = NoSinkAudioContext;
    const mic = rig();
    expect(mic.ensureAudioContext()).not.toBeNull();
    expect(() => mic.setOutputDevice('spk-2')).not.toThrow();
  });

  it('a rejected setSinkId leaves the context on its previous sink and the selection is retried on a new context', async () => {
    (globalThis as any).AudioContext = FakeAudioContext;
    const mic = rig();
    const ctx = (mic.ensureAudioContext() as unknown) as FakeAudioContext;
    ctx.rejectNext = true;
    mic.setOutputDevice('gone');
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.sinkId).toBe('');
    // The choice is held: a fresh context (after dispose) comes up on it.
    mic.dispose();
    const next = (mic.ensureAudioContext() as unknown) as FakeAudioContext;
    expect(next).not.toBe(ctx);
    expect(next.sinkCalls).toEqual(['gone']);
  });
});
