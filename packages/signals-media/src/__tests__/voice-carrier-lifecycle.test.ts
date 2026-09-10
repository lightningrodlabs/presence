import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  static instances: StubAudioEncoder[] = [];

  state = 'configured';

  constructor(_init: unknown) {
    StubAudioEncoder.instances.push(this);
  }

  configure(_config: unknown): void {}

  encode(_data: unknown): void {}

  close(): void {
    this.state = 'closed';
  }
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

const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});

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

/**
 * `VoiceCapture.start` returning false is the carrier's failure signal for
 * the whole capture path — including every graph-construction throw, which
 * `VoiceCapture` contains rather than rejecting. What must follow is a full
 * teardown: the device handle released, the encoder closed, and the next
 * attempt actually retrying (the `if (this.micHandle) return true` early
 * return would otherwise report success over a dead pipeline).
 * Constrains: src/voice-carrier.ts (`startCapture`), src/voice-capture.ts.
 */
describe('VoiceCarrier.startCapture failure arm', () => {
  let errors: ReturnType<typeof silenceErrors>;

  beforeEach(() => {
    StubAudioEncoder.instances = [];
    const g = globalThis as Record<string, unknown>;
    g.AudioDecoder = StubAudioDecoder;
    g.EncodedAudioChunk = StubEncodedAudioChunk;
    g.AudioEncoder = StubAudioEncoder;
    g.AudioData = StubAudioData;
    g.AudioWorkletNode = class {
      constructor(..._args: unknown[]) {}
    };
    errors = silenceErrors();
    voice = new VoiceCarrier();
  });

  afterEach(() => {
    errors.mockRestore();
    const g = globalThis as Record<string, unknown>;
    delete g.AudioDecoder;
    delete g.EncodedAudioChunk;
    delete g.AudioEncoder;
    delete g.AudioData;
    delete g.AudioWorkletNode;
  });

  const hostWithMicSpy = () => {
    const releases: number[] = [];
    let acquires = 0;
    const fake = makeFakeHost({ clock: new ManualClock(1_000) });
    const host: VoiceHost = {
      ...fake.host,
      acquireMic: async () => {
        acquires += 1;
        return {
          track: { enabled: true } as MediaStreamTrack,
          release: () => releases.push(acquires),
        };
      },
    };
    return { host, releases, acquireCount: () => acquires };
  };

  it('releases the mic and closes the encoder when capture.start resolves false, and retries next time', async () => {
    const { host, releases, acquireCount } = hostWithMicSpy();
    voice.bind(host);
    let starts = 0;
    (voice as any).capture = {
      start: async () => {
        starts += 1;
        return false;
      },
      stop() {},
      replaceTrack() {},
    };

    expect(await voice.startCapture()).toBe(false);
    expect(starts).toBe(1);
    expect(acquireCount()).toBe(1);
    // Teardown ran: device released, encoder closed, no handle retained.
    expect(releases).toEqual([1]);
    expect(StubAudioEncoder.instances[0].state).toBe('closed');
    expect((voice as any).micHandle).toBeNull();
    expect((voice as any).encoder).toBeNull();

    // The next attempt actually attempts — no `if (this.micHandle) return
    // true` short-circuit over a dead pipeline.
    expect(await voice.startCapture()).toBe(false);
    expect(starts).toBe(2);
    expect(acquireCount()).toBe(2);
    expect(releases).toEqual([1, 2]);
  });

  it('succeeds and holds the handle when capture.start resolves true', async () => {
    const { host, releases, acquireCount } = hostWithMicSpy();
    voice.bind(host);
    (voice as any).capture = {
      start: async () => true,
      stop() {},
      replaceTrack() {},
    };

    expect(await voice.startCapture()).toBe(true);
    expect(releases).toEqual([]);
    expect((voice as any).micHandle).not.toBeNull();
    // A second call is the idempotent no-op, not a second acquisition.
    expect(await voice.startCapture()).toBe(true);
    expect(acquireCount()).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });
});
