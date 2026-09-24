// Copied from presence ui/src/__tests__/voice-session-epoch.test.ts at ab90584 (signals-media extraction), re-targeted from the fake StreamsStore onto the VoiceHost seam.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { VoiceCarrier, packVoiceFrames } from '../voice-carrier.js';
import { makeFakeHost } from './fake-host.js';
import type { OpusPacket, VoiceHost } from '../types.js';

/**
 * Integration pins for the voice capture-session epoch on the REAL
 * carrier (the 2026-08-26 Presence field deafness: after each
 * webrtc->signals switch, the sender's restarted seq space was silently
 * dropped against the receiver's persisted `lastSeq` high-water for
 * 7.2s / 23.1s / 51.3s — exactly the previous capture session's length;
 * the drop happened before any stats or log write, so it was invisible).
 *
 * The receive tests replay that wire shape: session A's frames advance
 * the high-water, then a restarted session (higher epoch, seq from 1)
 * must be accepted immediately. Acceptance is observed at the decoder
 * seam — one `decode()` call per admitted frame — via a WebCodecs stub
 * (node has no AudioDecoder; the stub never emits output, so the playout
 * path stays out of scope here — it is covered by voice-playout's own
 * suite).
 */

class StubAudioDecoder {
  static instances: StubAudioDecoder[] = [];

  state = 'configured';

  decoded: unknown[] = [];

  constructor(_init: unknown) {
    StubAudioDecoder.instances.push(this);
  }

  configure(_config: unknown): void {}

  decode(chunk: unknown): void {
    this.decoded.push(chunk);
  }

  close(): void {
    this.state = 'closed';
  }
}

class StubEncodedAudioChunk {
  constructor(public init: unknown) {}
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

let voice: VoiceCarrier;

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.AudioDecoder = StubAudioDecoder;
  g.EncodedAudioChunk = StubEncodedAudioChunk;
  g.AudioEncoder = StubAudioEncoder;
  g.AudioData = StubAudioData;
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.AudioDecoder;
  delete g.EncodedAudioChunk;
  delete g.AudioEncoder;
  delete g.AudioData;
});

beforeEach(() => {
  StubAudioDecoder.instances = [];
  voice = new VoiceCarrier();
  // openPeer needs an AudioContext reference; the decoder stub never emits
  // output, so nothing ever schedules into it.
  (voice as any).audioContext = { currentTime: 0 };
});

afterEach(() => {
  voice.unbind();
});

/** Wire-shaped legacy single-frame payload; `ep` added when given. */
const framePayload = (seq: number, ep?: number) => ({
  seq,
  ts: seq * 20_000,
  type: 'key' as const,
  data: btoa('opus'),
  wts: Date.now(),
  ...(ep !== undefined ? { ep } : {}),
});

/** Each `it` below opens exactly one peer, so the single constructed
 *  decoder stub is that peer's. */
const decoderFor = (peer: string): StubAudioDecoder => {
  const state = (voice as any).peers.get(peer);
  expect(state, `no peer state for ${peer}`).toBeTruthy();
  const stub = StubAudioDecoder.instances[0];
  expect(stub, `no decoder constructed for ${peer}`).toBeTruthy();
  return stub;
};

describe('voice receive: capture-session epoch admission', () => {
  it('a restarted sender session (newer epoch, seq from 1) is accepted immediately — the deafness fix', () => {
    const peer = 'epoch-restart-peer';
    // Session A: epoch 1000, seqs 1..5 (mixed legacy-shape and v2 batch).
    for (let seq = 1; seq <= 3; seq++) {
      voice.receiveFrame(peer, JSON.stringify(framePayload(seq, 1000)));
    }
    voice.receiveFrame(
      peer,
      packVoiceFrames([framePayload(4, 1000), framePayload(5, 1000)])
    );
    expect(decoderFor(peer).decoded.length).toBe(5);

    // Sender restart: new capture session, higher epoch, seq space replayed
    // from 1. Pre-fix these are all `seq <= lastSeq` and silently dropped.
    voice.receiveFrame(
      peer,
      packVoiceFrames([
        framePayload(1, 2000),
        framePayload(2, 2000),
        framePayload(3, 2000),
      ])
    );
    expect(decoderFor(peer).decoded.length).toBe(8);
  });

  it('after adoption, late frames from the superseded session are dropped even when their seq passes the plain dedupe', () => {
    const peer = 'epoch-stale-drop-peer';
    for (let seq = 1; seq <= 5; seq++) {
      voice.receiveFrame(peer, JSON.stringify(framePayload(seq, 1000)));
    }
    voice.receiveFrame(peer, JSON.stringify(framePayload(1, 2000)));
    voice.receiveFrame(peer, JSON.stringify(framePayload(2, 2000)));
    expect(decoderFor(peer).decoded.length).toBe(7);

    // A delayed session-1000 packet: seq 6 would pass the plain seq dedupe
    // (6 > lastSeq 2). Ordered epochs must drop it instead of replaying
    // stale audio or re-adopting backwards.
    voice.receiveFrame(peer, JSON.stringify(framePayload(6, 1000)));
    expect(decoderFor(peer).decoded.length).toBe(7);
  });

  it('adoption resets the per-session playout mappings (anchor and wts map)', () => {
    const peer = 'epoch-anchor-reset-peer';
    voice.receiveFrame(peer, JSON.stringify(framePayload(1, 1000)));
    const state = (voice as any).peers.get(peer);
    state.playoutAnchor = { senderWtsMs: 1, atCtxSec: 0, setAtMs: Date.now() };
    state.wtsByTs.set(123, 456);

    voice.receiveFrame(peer, JSON.stringify(framePayload(1, 2000)));
    expect(state.playoutAnchor).toBeNull();
    // The adopted frame's own wts entry may be present; the pre-adoption
    // entry must be gone.
    expect(state.wtsByTs.has(123)).toBe(false);
  });

  it('legacy epoch-less senders keep the pre-epoch dedupe exactly (declared limitation: a restarted legacy sender is still dropped)', () => {
    const peer = 'legacy-peer';
    for (let seq = 1; seq <= 3; seq++) {
      voice.receiveFrame(peer, JSON.stringify(framePayload(seq)));
    }
    expect(decoderFor(peer).decoded.length).toBe(3);

    voice.receiveFrame(peer, JSON.stringify(framePayload(2))); // duplicate
    voice.receiveFrame(peer, JSON.stringify(framePayload(1))); // "restart"
    expect(decoderFor(peer).decoded.length).toBe(3);

    voice.receiveFrame(peer, JSON.stringify(framePayload(4)));
    expect(decoderFor(peer).decoded.length).toBe(4);
  });
});

describe('voice send: capture-session epoch stamping', () => {
  const packet = (): OpusPacket => ({
    type: 'key',
    timestampUs: 20_000,
    data: Uint8Array.from([1, 2]),
  });

  it('outgoing frames carry the carrier epoch as `ep`', () => {
    const fake = makeFakeHost({ targets: ['target-peer'], cadence: 'full' });
    voice.bind(fake.host);
    (voice as any).epoch = 7777;
    (voice as any).handleEncodedPacket(packet());

    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].kind).toBe('voice');
    expect(fake.sent[0].targets).toEqual(['target-peer']);
    const payload = JSON.parse(fake.sent[0].payload);
    expect(payload.ep).toBe(7777);
  });

  it('each failed startCapture attempt still takes a fresh, strictly increasing epoch', async () => {
    // Mic acquisition fails, so capture never starts — but the epoch must
    // already be assigned for the attempt, and a second attempt must get a
    // larger one.
    (globalThis as any).AudioWorkletNode = class {
      constructor(..._args: unknown[]) {}
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = makeFakeHost();
    const host: VoiceHost = { ...fake.host, acquireMic: async () => null };
    voice.bind(host);
    try {
      const before = Date.now();
      expect(await voice.startCapture()).toBe(false);
      const first = (voice as any).epoch;
      expect(first).toBeGreaterThanOrEqual(before);
      expect(await voice.startCapture()).toBe(false);
      const second = (voice as any).epoch;
      expect(second).toBeGreaterThan(first);
      expect(errors).toHaveBeenCalledWith('voice: acquireMic failed');
    } finally {
      errors.mockRestore();
      delete (globalThis as any).AudioWorkletNode;
    }
  });

  it('a restarted capture (stop then start) takes a fresh epoch', async () => {
    // Capture itself is stubbed out — this pins epoch assignment across a
    // stop/start, the carrier-switch sequence the README promises never
    // deafens a receiver.
    (globalThis as any).AudioWorkletNode = class {
      constructor(..._args: unknown[]) {}
    };
    (voice as any).capture = {
      start: async () => true,
      stop() {},
      replaceTrack() {},
    };
    const fake = makeFakeHost();
    voice.bind(fake.host);
    try {
      expect(await voice.startCapture()).toBe(true);
      const first = (voice as any).epoch;
      await voice.stopCapture();
      expect(await voice.startCapture()).toBe(true);
      expect((voice as any).epoch).toBeGreaterThan(first);
      // `seq` restarts with the session — that is why the epoch exists.
      expect((voice as any).seq).toBe(0);
    } finally {
      delete (globalThis as any).AudioWorkletNode;
    }
  });
});
