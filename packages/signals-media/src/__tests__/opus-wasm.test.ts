import { describe, it, expect, vi } from 'vitest';
import { createEncoder as libCreateEncoder } from 'libopus-wasm';
import { wasmOpus, WASM_PENDING_MAX } from '../opus-wasm.js';
import { VOICE_SAMPLE_RATE, VOICE_FRAME_SAMPLES } from '../voice-capture.js';
import type { OpusPacket } from '../types.js';

/**
 * The WASM Opus backend (`wasmOpus`, reached only via the `./opus-wasm`
 * subpath): the real `libopus-wasm` module runs in Node, so most of these
 * exercise it directly rather than through a stub. `createEncoder`/
 * `createDecoder` on the returned `OpusCodec` must be synchronous (R6) even
 * though `libopus-wasm`'s own factories are Promise-returning — the facade
 * (R7) queues calls made before the real handle resolves and drains them in
 * order once it does. Constrains: src/opus-wasm.ts.
 */

// `vi.mock` is file-scoped by hoisting, but its default behavior below just
// delegates to the real implementation via `vi.fn(actual.fn)` — so every
// test except the one rejection case below runs against real libopus-wasm,
// unaffected by the mock's presence. Only that one test reconfigures the
// mock's next call via `mockRejectedValueOnce`, i.e. "for this case only".
vi.mock('libopus-wasm', async () => {
  const actual = await vi.importActual<typeof import('libopus-wasm')>('libopus-wasm');
  return {
    ...actual,
    createEncoder: vi.fn(actual.createEncoder),
    createDecoder: vi.fn(actual.createDecoder),
  };
});

/** Resolves after any already-queued microtasks (and the facades' internal
 * Promise chains) have run — the decoder has no `flush()` to await, so tests
 * that queue decodes before the module is ready use this instead. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** One 20 ms, 960-sample frame of a 440 Hz tone at the given frame index. */
function toneFrame(frameIndex: number): Float32Array {
  const pcm = new Float32Array(VOICE_FRAME_SAMPLES);
  for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
    const t = (frameIndex * VOICE_FRAME_SAMPLES + i) / VOICE_SAMPLE_RATE;
    pcm[i] = 0.8 * Math.sin(2 * Math.PI * 440 * t);
  }
  return pcm;
}

describe('wasmOpus round trip', () => {
  it('encodes 20 frames of a 440 Hz tone queued before ready, and decodes them back', async () => {
    const codec = await wasmOpus();
    const packets: OpusPacket[] = [];
    const enc = codec.createEncoder(
      p => packets.push(p),
      e => {
        throw e;
      }
    );

    // All 20 frames go in synchronously, before any await — the real
    // libopus-wasm handle cannot possibly exist yet.
    for (let i = 0; i < 20; i++) {
      enc.encode(toneFrame(i), i * 20_000);
    }
    await enc.flush();

    expect(packets).toHaveLength(20);
    packets.forEach((p, i) => {
      expect(p.type).toBe('key');
      expect(p.timestampUs).toBe(i * 20_000);
      expect(p.data.byteLength).toBeGreaterThanOrEqual(40);
      expect(p.data.byteLength).toBeLessThanOrEqual(120);
    });

    const samples: number[] = [];
    const timestamps: number[] = [];
    const dec = codec.createDecoder(
      (pcm, ts) => {
        samples.push(...pcm);
        timestamps.push(ts);
      },
      e => {
        throw e;
      }
    );
    for (const p of packets) dec.decode(p);
    await tick();

    expect(samples).toHaveLength(19_200);
    expect(timestamps).toEqual(packets.map(p => p.timestampUs));
    const peak = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    expect(peak).toBeGreaterThan(0.1);
  });

  it('preserves ordering across the ready boundary', async () => {
    const codec = await wasmOpus();
    const packets: OpusPacket[] = [];
    const enc = codec.createEncoder(
      p => packets.push(p),
      e => {
        throw e;
      }
    );

    for (let i = 0; i < 5; i++) enc.encode(toneFrame(i), i * 20_000);
    await tick(); // the real handle resolves and drains the first 5 here
    for (let i = 5; i < 10; i++) enc.encode(toneFrame(i), i * 20_000);
    await enc.flush();

    expect(packets).toHaveLength(10);
    expect(packets.map(p => p.timestampUs)).toEqual(
      Array.from({ length: 10 }, (_, i) => i * 20_000)
    );
    expect(new Set(packets.map(p => p.timestampUs)).size).toBe(10);
  });
});

describe('wasmOpus encoder queue bound', () => {
  it('drops the oldest queued frame once WASM_PENDING_MAX is exceeded, warning once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const codec = await wasmOpus();
    const packets: OpusPacket[] = [];
    const enc = codec.createEncoder(
      p => packets.push(p),
      e => {
        throw e;
      }
    );

    const total = WASM_PENDING_MAX + 5;
    for (let i = 0; i < total; i++) {
      enc.encode(toneFrame(i % 20), i * 20_000);
    }
    await enc.flush();

    expect(packets).toHaveLength(WASM_PENDING_MAX);
    // The oldest 5 (timestamps 0..80000) were dropped; the surviving oldest
    // packet is frame index 5.
    expect(packets[0].timestampUs).toBe(5 * 20_000);
    expect(packets[packets.length - 1].timestampUs).toBe((total - 1) * 20_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

describe('wasmOpus encoder close before ready', () => {
  it('emits nothing and reports no error when closed before the module resolves', async () => {
    const codec = await wasmOpus();
    const packets: OpusPacket[] = [];
    const errors: unknown[] = [];
    const enc = codec.createEncoder(
      p => packets.push(p),
      e => errors.push(e)
    );

    enc.encode(toneFrame(0), 0);
    enc.encode(toneFrame(1), 20_000);
    enc.close();

    // Give the real (still-pending) handle every chance to resolve and the
    // facade every chance to (wrongly) drain or error after close.
    await tick();
    await tick();

    expect(packets).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

describe('wasmOpus encoder rejection', () => {
  it('reports onError once and drops the queue when the module fails to load', async () => {
    const boom = new Error('wasm init failed');
    vi.mocked(libCreateEncoder).mockRejectedValueOnce(boom);

    const codec = await wasmOpus();
    const packets: OpusPacket[] = [];
    const errors: unknown[] = [];
    const enc = codec.createEncoder(
      p => packets.push(p),
      e => errors.push(e)
    );

    enc.encode(toneFrame(0), 0);
    await tick();

    expect(errors).toEqual([boom]);
    expect(packets).toHaveLength(0);

    // Later encode calls are a no-op — no throw, no further packets/errors.
    enc.encode(toneFrame(1), 20_000);
    await tick();
    expect(packets).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});

describe('wasmOpus decoder', () => {
  it('queues decodes made before ready and drains them in order', async () => {
    const codec = await wasmOpus();

    // Build real packets first (fully resolved encoder) so the decoder test
    // below is exercising only the decoder's own pre-ready queue.
    const packets: OpusPacket[] = [];
    const enc = codec.createEncoder(
      p => packets.push(p),
      e => {
        throw e;
      }
    );
    for (let i = 0; i < 6; i++) enc.encode(toneFrame(i), i * 20_000);
    await enc.flush();
    expect(packets).toHaveLength(6);

    const got: Array<{ pcm: Float32Array; ts: number }> = [];
    const dec = codec.createDecoder(
      (pcm, ts) => got.push({ pcm, ts }),
      e => {
        throw e;
      }
    );
    for (const p of packets) dec.decode(p);
    await tick();

    expect(got).toHaveLength(6);
    expect(got.map(g => g.ts)).toEqual(packets.map(p => p.timestampUs));
    got.forEach(g => expect(g.pcm).toHaveLength(VOICE_FRAME_SAMPLES));
  });
});
