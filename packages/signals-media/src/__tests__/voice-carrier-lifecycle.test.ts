import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VoiceCarrier } from '../voice-carrier.js';
import { makeFakeHost } from './fake-host.js';
import { ManualClock } from './manual-clock.js';
import type { OpusPacket, VoiceHost } from '../types.js';

/**
 * Bind/unbind symmetry: "the receive side is live once bound" (design spec
 * decision 3) has to mean the reverse too — an unbound carrier holds no
 * per-peer state, closes what it opened, and opens nothing new.
 * Constrains: src/voice-carrier.ts (`bind`/`unbind`/`isBound`).
 */

class StubDecodedAudioData {
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

  close(): void {}
}

/** Emits one decoded block per packet so the playout path (and with it
 *  `peerAudioLevels`) actually runs. */
class StubAudioDecoder {
  static instances: StubAudioDecoder[] = [];

  state = 'configured';

  private output: (data: unknown) => void;

  constructor(init: { output: (data: unknown) => void }) {
    this.output = init.output;
    StubAudioDecoder.instances.push(this);
  }

  configure(_config: unknown): void {}

  decode(chunk: { timestamp: number }): void {
    this.output(new StubDecodedAudioData(chunk.timestamp, [0.5, -0.25, 0.5, 0]));
  }

  close(): void {
    this.state = 'closed';
  }
}

class StubEncodedAudioChunk {
  timestamp: number;

  constructor(opts: { type: string; timestamp: number; data: unknown }) {
    this.timestamp = opts.timestamp;
  }
}

class StubAudioEncoder {
  state = 'configured';

  constructor(_init: unknown) {}

  configure(_config: unknown): void {}

  encode(_data: unknown): void {}

  close(): void {}
}

class StubAudioData {
  constructor(public init: unknown) {}

  close(): void {}
}

const fakeAudioContext = (): AudioContext =>
  ({
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => {},
      start: () => {},
      stop: () => {},
    }),
  }) as unknown as AudioContext;

const peer = 'uhCAk_lifecycle_peer';

const framePayload = (seq: number, ep: number) =>
  JSON.stringify({
    seq,
    ts: seq * 20_000,
    type: 'key' as const,
    data: btoa('opus'),
    wts: Date.now(),
    ep,
  });

const packet = (): OpusPacket => ({
  type: 'key',
  timestampUs: 20_000,
  data: Uint8Array.from([7]),
});

let voice: VoiceCarrier;

const bindHost = (clock: ManualClock) => {
  const fake = makeFakeHost({ targets: [peer], clock });
  const host: VoiceHost = { ...fake.host, audioContext: () => fakeAudioContext() };
  voice.bind(host);
  return fake;
};

describe('VoiceCarrier bind/unbind symmetry', () => {
  beforeEach(() => {
    StubAudioDecoder.instances = [];
    const g = globalThis as Record<string, unknown>;
    g.AudioDecoder = StubAudioDecoder;
    g.EncodedAudioChunk = StubEncodedAudioChunk;
    g.AudioEncoder = StubAudioEncoder;
    g.AudioData = StubAudioData;
    voice = new VoiceCarrier();
  });

  afterEach(() => {
    voice.unbind();
    const g = globalThis as Record<string, unknown>;
    delete g.AudioDecoder;
    delete g.EncodedAudioChunk;
    delete g.AudioEncoder;
    delete g.AudioData;
  });

  it('binds, receives, then unbind drops every per-peer map and closes the decoder', () => {
    const clock = new ManualClock(1_000_000);
    bindHost(clock);
    expect(voice.isBound).toBe(true);

    voice.receiveFrame(peer, framePayload(1, 4242));
    // Send stamps come from the same path the carrier uses in capture.
    (voice as unknown as { handleEncodedPacket(p: OpusPacket): void }).handleEncodedPacket(
      packet()
    );
    // Close the ~1s stats window on the next arrival.
    const state = (voice as unknown as { peers: Map<string, { windowStartMs: number }> }).peers.get(
      peer
    )!;
    state.windowStartMs = Date.now() - 2000;
    voice.receiveFrame(peer, framePayload(2, 4242));

    expect(voice.peerLastRecvMs.get(peer)).toBe(1_000_000);
    expect(voice.peerLastSentMs.get(peer)).toBe(1_000_000);
    expect(voice.peerAudioLevels.get(peer)).toBeCloseTo(0.5, 5);
    // Jitter is a wall-clock inter-arrival measure — pin that the window
    // wrote an entry and that loss is accounted, not the timing value.
    const stats = voice.voiceRxStats.get(peer)!;
    expect(stats.lossPercent).toBe(0);
    expect(typeof stats.jitterMs).toBe('number');
    expect(StubAudioDecoder.instances).toHaveLength(1);

    voice.unbind();

    expect(voice.isBound).toBe(false);
    expect(voice.peerLastRecvMs.size).toBe(0);
    expect(voice.peerLastSentMs.size).toBe(0);
    expect(voice.peerAudioLevels.size).toBe(0);
    expect(voice.voiceRxStats.size).toBe(0);
    expect(
      (voice as unknown as { peers: Map<string, unknown> }).peers.size
    ).toBe(0);
    expect(StubAudioDecoder.instances[0].state).toBe('closed');
  });

  it('a frame received while unbound opens no decoder', () => {
    expect(voice.isBound).toBe(false);
    voice.receiveFrame(peer, framePayload(1, 4242));
    expect(StubAudioDecoder.instances).toHaveLength(0);
    expect(voice.peerLastRecvMs.size).toBe(0);
  });

  it('a frame received after unbind opens no decoder either', () => {
    bindHost(new ManualClock(1_000_000));
    voice.receiveFrame(peer, framePayload(1, 4242));
    expect(StubAudioDecoder.instances).toHaveLength(1);

    voice.unbind();
    voice.receiveFrame(peer, framePayload(2, 4242));
    expect(StubAudioDecoder.instances).toHaveLength(1);
    expect(voice.peerLastRecvMs.size).toBe(0);
  });

  it('sends nothing while unbound', () => {
    const fake = bindHost(new ManualClock(1_000_000));
    voice.unbind();
    (voice as unknown as { handleEncodedPacket(p: OpusPacket): void }).handleEncodedPacket(
      packet()
    );
    expect(fake.sent).toHaveLength(0);
  });

  it('presence stamps ride the host clock, not wall clock', () => {
    const clock = new ManualClock(5_000);
    bindHost(clock);
    voice.receiveFrame(peer, framePayload(1, 4242));
    expect(voice.peerLastRecvMs.get(peer)).toBe(5_000);
    clock.advance(1_000);
    voice.receiveFrame(peer, framePayload(2, 4242));
    expect(voice.peerLastRecvMs.get(peer)).toBe(6_000);
  });
});
