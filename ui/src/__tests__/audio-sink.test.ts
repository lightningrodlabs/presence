import { describe, it, expect, vi } from 'vitest';
import { applyAudioSink, sinkIdFor, type AudioSinkTarget } from '../audio-sink';

function target(sinkId: unknown, impl?: (id: string) => Promise<void>) {
  const calls: string[] = [];
  const t: AudioSinkTarget & { calls: string[] } = {
    sinkId,
    calls,
    setSinkId: async (id: string) => {
      calls.push(id);
      if (impl) await impl(id);
    },
  };
  return t;
}

describe('sinkIdFor', () => {
  it('maps the undefined selection to the default sink and passes ids through', () => {
    expect(sinkIdFor(undefined)).toBe('');
    expect(sinkIdFor('default')).toBe('default');
    expect(sinkIdFor('spk-2')).toBe('spk-2');
  });
});

describe('applyAudioSink', () => {
  it('a target without setSinkId (WebKitGTK, Firefox) is left alone', () => {
    expect(applyAudioSink({} as AudioSinkTarget, 'spk-2')).toBe('unsupported');
    expect(applyAudioSink(null, 'spk-2')).toBe('unsupported');
    expect(applyAudioSink(undefined, 'spk-2')).toBe('unsupported');
  });

  it('a target already on the wanted sink is not touched (idempotent per render)', () => {
    const t = target('spk-2');
    expect(applyAudioSink(t, 'spk-2')).toBe('unchanged');
    expect(t.calls).toEqual([]);
  });

  it('the default selection is the empty sink id, unchanged when already default', () => {
    const t = target('');
    expect(applyAudioSink(t, undefined)).toBe('unchanged');
    const back = target('spk-2');
    expect(applyAudioSink(back, undefined)).toBe('applied');
    expect(back.calls).toEqual(['']);
  });

  it('a different sink is applied', () => {
    const t = target('');
    expect(applyAudioSink(t, 'spk-2')).toBe('applied');
    expect(t.calls).toEqual(['spk-2']);
  });

  it('a rejected setSinkId reaches onError and nothing throws', async () => {
    const onError = vi.fn();
    const t = target('', async () => {
      throw new Error('NotFoundError');
    });
    expect(applyAudioSink(t, 'gone', onError)).toBe('applied');
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a synchronously throwing setSinkId reaches onError and nothing throws', () => {
    const onError = vi.fn();
    const t: AudioSinkTarget = {
      sinkId: '',
      setSinkId: () => {
        throw new Error('InvalidStateError');
      },
    };
    expect(() => applyAudioSink(t, 'spk-2', onError)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
