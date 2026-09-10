import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { VoiceCapture } from '../voice-capture.js';

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

// ---------------------------------------------------------------------------
// Main-thread pump: graph construction must not reject
// ---------------------------------------------------------------------------

/**
 * `VoiceCapture.start` is the caller's ONE failure signal: `VoiceCarrier`
 * releases the mic handle and closes the encoder on a false return, and a
 * REJECTION would skip that arm and strand the device open with no capture
 * graph (Presence contained the same class of failure inside
 * `buildTrackReader`). These cases pin that every graph-construction throw
 * resolves false and leaves no nodes behind.
 */

class FakeAudioNode {
  disconnects = 0;

  connect(_dest: unknown): void {}

  disconnect(): void {
    this.disconnects += 1;
  }
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeWorkletNode extends FakeAudioNode {
  port: { onmessage: ((e: { data: Float32Array }) => void) | null } = {
    onmessage: null,
  };
}

let workletNodeThrows = false;
const workletNodes: FakeWorkletNode[] = [];

const makeCtx = (failAt?: 'source' | 'gain' | 'addModule') => {
  const created: FakeAudioNode[] = [];
  const ctx = {
    sampleRate: 48000,
    destination: new FakeAudioNode(),
    audioWorklet: {
      addModule: async (_url: string) => {
        if (failAt === 'addModule') throw new Error('module fetch failed');
      },
    },
    createMediaStreamSource: (_stream: unknown) => {
      if (failAt === 'source') throw new Error('InvalidStateError: context closed');
      const n = new FakeAudioNode();
      created.push(n);
      return n;
    },
    createGain: () => {
      if (failAt === 'gain') throw new Error('InvalidStateError: context closed');
      const n = new FakeGainNode();
      created.push(n);
      return n;
    },
  };
  return { ctx: ctx as unknown as AudioContext, created };
};

const noNodes = (cap: VoiceCapture): boolean => {
  const c = cap as unknown as { src: unknown; node: unknown; sink: unknown };
  return c.src === null && c.node === null && c.sink === null;
};

const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('VoiceCapture.start containment', () => {
  let errors: ReturnType<typeof silenceErrors>;

  beforeEach(() => {
    workletNodeThrows = false;
    workletNodes.length = 0;
    (globalThis as Record<string, unknown>).MediaStream = class {
      constructor(_tracks: unknown[]) {}
    };
    (globalThis as Record<string, unknown>).AudioWorkletNode = class {
      constructor(_ctx: unknown, _name: string, _opts: unknown) {
        if (workletNodeThrows) throw new Error('unknown processor name');
        const node = new FakeWorkletNode();
        workletNodes.push(node);
        return node as unknown as object;
      }
    };
    errors = silenceErrors();
  });

  afterEach(() => {
    errors.mockRestore();
    delete (globalThis as Record<string, unknown>).MediaStream;
    delete (globalThis as Record<string, unknown>).AudioWorkletNode;
  });

  const track = {} as MediaStreamTrack;

  it('builds the graph and pumps worklet messages as 20 ms-spaced frames', async () => {
    const cap = new VoiceCapture();
    const frames: Array<{ pcm: Float32Array; ts: number }> = [];
    const { ctx } = makeCtx();
    await expect(
      cap.start(ctx, track, (pcm, ts) => frames.push({ pcm, ts }), 'worklet.js')
    ).resolves.toBe(true);

    const block = new Float32Array(960);
    workletNodes[0].port.onmessage!({ data: block });
    workletNodes[0].port.onmessage!({ data: block });
    expect(frames.map(f => f.ts)).toEqual([0, 20_000]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('resolves false, does not reject, when createMediaStreamSource throws', async () => {
    const cap = new VoiceCapture();
    const { ctx } = makeCtx('source');
    await expect(cap.start(ctx, track, () => {}, 'worklet.js')).resolves.toBe(false);
    expect(noNodes(cap)).toBe(true);
    expect(errors).toHaveBeenCalledWith(
      'voice: failed to build the capture graph',
      expect.anything()
    );
  });

  it('resolves false and tears the partial graph down when the worklet node throws', async () => {
    workletNodeThrows = true;
    const cap = new VoiceCapture();
    const { ctx, created } = makeCtx();
    await expect(cap.start(ctx, track, () => {}, 'worklet.js')).resolves.toBe(false);
    expect(noNodes(cap)).toBe(true);
    // The source node built before the throw is disconnected, not stranded.
    expect(created[0].disconnects).toBe(1);
  });

  it('resolves false when the sink cannot be created', async () => {
    const cap = new VoiceCapture();
    const { ctx } = makeCtx('gain');
    await expect(cap.start(ctx, track, () => {}, 'worklet.js')).resolves.toBe(false);
    expect(noNodes(cap)).toBe(true);
  });

  it('resolves false on a wrong sample rate and on an addModule failure', async () => {
    const cap = new VoiceCapture();
    const { ctx } = makeCtx();
    (ctx as unknown as { sampleRate: number }).sampleRate = 44100;
    await expect(cap.start(ctx, track, () => {}, 'worklet.js')).resolves.toBe(false);

    const failing = makeCtx('addModule');
    await expect(cap.start(failing.ctx, track, () => {}, 'worklet.js')).resolves.toBe(
      false
    );
    expect(noNodes(cap)).toBe(true);
  });
});
