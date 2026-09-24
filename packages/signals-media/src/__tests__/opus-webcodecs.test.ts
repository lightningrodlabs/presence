import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { webCodecsOpus } from '../opus-webcodecs.js';
import type { OpusPacket } from '../types.js';

/**
 * The WebCodecs Opus backend against stub constructors: what the carrier is
 * promised is that PCM in yields packets out carrying the chunk's type and
 * timestamp, and that packets in yield the decoder's Float32 samples.
 * Constrains: src/opus-webcodecs.ts.
 */

interface AudioDataInit {
  format: string;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: Float32Array;
}

class StubAudioData {
  static constructed: StubAudioData[] = [];

  closed = false;

  constructor(public init: AudioDataInit) {
    StubAudioData.constructed.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

/** One encoded packet per encode() call; bytes are a fixed 3-byte payload. */
class StubAudioEncoder {
  static instances: StubAudioEncoder[] = [];

  state = 'unconfigured';

  config: unknown = null;

  flushed = 0;

  output: (chunk: unknown) => void;

  errorCb: (e: unknown) => void;

  constructor(init: { output: (chunk: unknown) => void; error: (e: unknown) => void }) {
    this.output = init.output;
    this.errorCb = init.error;
    StubAudioEncoder.instances.push(this);
  }

  configure(config: unknown): void {
    this.config = config;
    this.state = 'configured';
  }

  encode(data: StubAudioData): void {
    const bytes = Uint8Array.from([1, 2, 3]);
    this.output({
      type: 'key',
      timestamp: data.init.timestamp,
      byteLength: bytes.length,
      copyTo: (dest: Uint8Array) => dest.set(bytes),
    });
  }

  async flush(): Promise<void> {
    this.flushed += 1;
  }

  close(): void {
    this.state = 'closed';
  }
}

class StubEncodedAudioChunk {
  constructor(public init: { type: string; timestamp: number; data: Uint8Array }) {}
}

/** Emits one AudioData of 4 exactly-representable samples per chunk. */
class StubAudioDecoder {
  static instances: StubAudioDecoder[] = [];

  state = 'unconfigured';

  config: unknown = null;

  emitted: StubDecodedAudioData[] = [];

  output: (data: unknown) => void;

  errorCb: (e: unknown) => void;

  constructor(init: { output: (data: unknown) => void; error: (e: unknown) => void }) {
    this.output = init.output;
    this.errorCb = init.error;
    StubAudioDecoder.instances.push(this);
  }

  configure(config: unknown): void {
    this.config = config;
    this.state = 'configured';
  }

  decode(chunk: StubEncodedAudioChunk): void {
    const base = chunk.init.data[0] ?? 0;
    const data = new StubDecodedAudioData(chunk.init.timestamp, [
      base,
      base + 0.5,
      base - 0.25,
      base + 0.75,
    ]);
    this.emitted.push(data);
    this.output(data);
  }

  close(): void {
    this.state = 'closed';
  }
}

class StubDecodedAudioData {
  closed = false;

  numberOfFrames: number;

  constructor(
    public timestamp: number,
    private samples: number[]
  ) {
    this.numberOfFrames = samples.length;
  }

  copyTo(dest: Float32Array, opts: { planeIndex: number; format?: string }): void {
    if (opts.format !== 'f32-planar') throw new Error('unsupported format');
    dest.set(this.samples);
  }

  close(): void {
    this.closed = true;
  }
}

const install = (): void => {
  const g = globalThis as Record<string, unknown>;
  g.AudioEncoder = StubAudioEncoder;
  g.AudioDecoder = StubAudioDecoder;
  g.EncodedAudioChunk = StubEncodedAudioChunk;
  g.AudioData = StubAudioData;
};

const uninstall = (): void => {
  const g = globalThis as Record<string, unknown>;
  delete g.AudioEncoder;
  delete g.AudioDecoder;
  delete g.EncodedAudioChunk;
  delete g.AudioData;
};

describe('webCodecsOpus availability', () => {
  afterEach(uninstall);

  it('is null when this engine has no WebCodecs audio', () => {
    expect(webCodecsOpus()).toBeNull();
  });

  it('is null when only some of the four constructors exist (Safari 16.4–18 ships the video half)', () => {
    (globalThis as Record<string, unknown>).EncodedAudioChunk = StubEncodedAudioChunk;
    (globalThis as Record<string, unknown>).AudioData = StubAudioData;
    expect(webCodecsOpus()).toBeNull();
  });

  it('is the webcodecs backend when all four exist', () => {
    install();
    expect(webCodecsOpus()?.name).toBe('webcodecs');
  });
});

describe('webCodecsOpus encoder', () => {
  beforeEach(() => {
    StubAudioEncoder.instances = [];
    StubAudioData.constructed = [];
    install();
  });

  afterEach(uninstall);

  it('configures Opus at 48 kHz mono 24 kbps — the Presence wire settings', () => {
    webCodecsOpus()!.createEncoder(
      () => {},
      () => {}
    );
    expect(StubAudioEncoder.instances[0].config).toEqual({
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 24000,
    });
  });

  it('wraps PCM in an f32-planar AudioData, closes it, and emits the chunk as a packet', () => {
    const packets: OpusPacket[] = [];
    const enc = webCodecsOpus()!.createEncoder(
      p => packets.push(p),
      () => {}
    );
    const pcm = new Float32Array(960);
    pcm[0] = 0.5;
    enc.encode(pcm, 40_000);

    const ad = StubAudioData.constructed[0];
    expect(ad.init).toMatchObject({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: 960,
      numberOfChannels: 1,
      timestamp: 40_000,
    });
    expect(ad.init.data).toBe(pcm);
    expect(ad.closed).toBe(true);

    expect(packets).toHaveLength(1);
    expect(packets[0].type).toBe('key');
    expect(packets[0].timestampUs).toBe(40_000);
    expect(Array.from(packets[0].data)).toEqual([1, 2, 3]);
  });

  it('does not encode once the encoder is closed, and close is idempotent', () => {
    const packets: OpusPacket[] = [];
    const enc = webCodecsOpus()!.createEncoder(
      p => packets.push(p),
      () => {}
    );
    enc.close();
    enc.close();
    enc.encode(new Float32Array(960), 0);
    expect(packets).toHaveLength(0);
    // The AudioData of the discarded frame is still released — no leak.
    expect(StubAudioData.constructed[0].closed).toBe(true);
  });

  it('forwards encoder errors to onError', () => {
    const errors: unknown[] = [];
    webCodecsOpus()!.createEncoder(
      () => {},
      e => errors.push(e)
    );
    const boom = new Error('encoder failed');
    StubAudioEncoder.instances[0].errorCb(boom);
    expect(errors).toEqual([boom]);
  });

  it('flush awaits the underlying encoder', async () => {
    const enc = webCodecsOpus()!.createEncoder(
      () => {},
      () => {}
    );
    await enc.flush();
    expect(StubAudioEncoder.instances[0].flushed).toBe(1);
  });
});

describe('webCodecsOpus decoder', () => {
  beforeEach(() => {
    StubAudioDecoder.instances = [];
    install();
  });

  afterEach(uninstall);

  it('configures Opus at 48 kHz mono', () => {
    webCodecsOpus()!.createDecoder(
      () => {},
      () => {}
    );
    expect(StubAudioDecoder.instances[0].config).toEqual({
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 1,
    });
  });

  it('feeds the packet through as an EncodedAudioChunk and copies the samples out', () => {
    const got: Array<{ pcm: Float32Array; ts: number }> = [];
    const dec = webCodecsOpus()!.createDecoder(
      (pcm, ts) => got.push({ pcm, ts }),
      () => {}
    );
    dec.decode({ type: 'key', timestampUs: 60_000, data: Uint8Array.from([2, 9]) });

    expect(got).toHaveLength(1);
    expect(got[0].ts).toBe(60_000);
    expect(Array.from(got[0].pcm)).toEqual([2, 2.5, 1.75, 2.75]);
    // The decoded AudioData is released whatever the consumer does.
    expect(StubAudioDecoder.instances[0].emitted[0].closed).toBe(true);
  });

  it('forwards decoder errors to onError', () => {
    const errors: unknown[] = [];
    webCodecsOpus()!.createDecoder(
      () => {},
      e => errors.push(e)
    );
    const boom = new Error('decoder failed');
    StubAudioDecoder.instances[0].errorCb(boom);
    expect(errors).toEqual([boom]);
  });

  it('drops packets once closed rather than throwing at the caller', () => {
    const got: Float32Array[] = [];
    const dec = webCodecsOpus()!.createDecoder(
      pcm => got.push(pcm),
      () => {}
    );
    dec.close();
    dec.decode({ type: 'key', timestampUs: 0, data: Uint8Array.from([1]) });
    expect(got).toHaveLength(0);
  });
});
