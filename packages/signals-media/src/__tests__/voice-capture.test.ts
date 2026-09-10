import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * The AudioWorkletProcessor in `voice-capture-worklet.ts` is the ONE
 * 128 → 960 accumulator (design spec decision 5: the portable capture path
 * that replaces `MediaStreamTrackProcessor`). It carries no imports and
 * cannot be loaded as a normal module in a browser, so this test supplies
 * the two worklet globals, imports the module for its `registerProcessor`
 * side effect, and drives the captured class's `process()` directly.
 * Constrains: src/voice-capture-worklet.ts.
 */

type Processor = { process(inputs: Float32Array[][]): boolean };
type ProcessorCtor = new () => Processor;

const posted: Float32Array[] = [];
let Captured: ProcessorCtor | undefined;
let registeredName: string | undefined;

const make = (): Processor => {
  if (!Captured) throw new Error('registerProcessor was never called');
  return new Captured();
};

const ramp = (n: number, from: number): Float32Array => {
  const block = new Float32Array(n);
  for (let i = 0; i < n; i++) block[i] = from + i;
  return block;
};

beforeAll(async () => {
  (globalThis as Record<string, unknown>).AudioWorkletProcessor = class {
    port = {
      postMessage: (data: Float32Array) => {
        posted.push(data);
      },
    };
  };
  (globalThis as Record<string, unknown>).registerProcessor = (
    name: string,
    ctor: ProcessorCtor
  ) => {
    registeredName = name;
    Captured = ctor;
  };
  await import('../voice-capture-worklet.js');
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).AudioWorkletProcessor;
  delete (globalThis as Record<string, unknown>).registerProcessor;
});

beforeEach(() => {
  posted.length = 0;
});

describe('voice capture worklet: render quanta → 20 ms frames', () => {
  it('registers under the name the main-thread pump constructs', () => {
    expect(registeredName).toBe('signals-media-voice-capture');
  });

  it('accumulates eight 128-sample quanta into one 960-sample frame and carries the remainder', () => {
    const p = make();
    for (let b = 0; b < 8; b++) {
      expect(p.process([[ramp(128, b * 128)]])).toBe(true);
    }
    // 8 x 128 = 1024 = one 960-sample frame + 64 carried.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toHaveLength(960);
    // Sample order is preserved across the quantum boundaries.
    expect(Array.from(posted[0])).toEqual(
      Array.from({ length: 960 }, (_, i) => i)
    );

    // The carried 64 samples lead the next frame: 64 + 896 = 960.
    p.process([[ramp(896, 1024)]]);
    expect(posted).toHaveLength(2);
    expect(posted[1][0]).toBe(960);
    expect(posted[1][959]).toBe(1919);
  });

  it('a 960-sample block yields exactly one frame', () => {
    const p = make();
    p.process([[ramp(960, 0)]]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toHaveLength(960);
    expect(posted[0][959]).toBe(959);
  });

  it('a block larger than one frame yields every whole frame it contains', () => {
    const p = make();
    p.process([[ramp(1920, 0)]]);
    expect(posted).toHaveLength(2);
    expect(posted[0][0]).toBe(0);
    expect(posted[1][0]).toBe(960);
  });

  it('an absent input channel is a no-op', () => {
    const p = make();
    expect(p.process([[]])).toBe(true);
    expect(p.process([])).toBe(true);
    expect(posted).toHaveLength(0);
  });
});
