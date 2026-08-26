import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { voiceController, packVoiceFrames } from '../room/modules/voice';
import { systemClock } from '../clock';

/**
 * Integration pins for the voice capture-session epoch on the REAL
 * VoiceController (the 2026-08-26 field deafness: after each
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
 * path stays out of scope here — it is covered by the voice-playout
 * harness).
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

beforeAll(() => {
  (globalThis as any).AudioDecoder = StubAudioDecoder;
  (globalThis as any).EncodedAudioChunk = StubEncodedAudioChunk;
  // openPeer needs an AudioContext reference; the decoder stub never emits
  // output, so nothing ever schedules into it.
  (voiceController as any).audioContext = { currentTime: 0 };
});

afterEach(() => {
  (voiceController as any).audioContext = { currentTime: 0 };
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

const decoderFor = (peer: string): StubAudioDecoder => {
  const state = (voiceController as any).peers.get(peer);
  expect(state, `no peer state for ${peer}`).toBeTruthy();
  return state.decoder as StubAudioDecoder;
};

describe('voice receive: capture-session epoch admission', () => {
  it('a restarted sender session (newer epoch, seq from 1) is accepted immediately — the deafness fix', () => {
    const peer = 'epoch-restart-peer';
    // Session A: epoch 1000, seqs 1..5 (mixed legacy-shape and v2 batch).
    for (let seq = 1; seq <= 3; seq++) {
      voiceController.receiveFrame(peer, JSON.stringify(framePayload(seq, 1000)));
    }
    voiceController.receiveFrame(
      peer,
      packVoiceFrames([framePayload(4, 1000), framePayload(5, 1000)])
    );
    expect(decoderFor(peer).decoded.length).toBe(5);

    // Sender restart: new capture session, higher epoch, seq space replayed
    // from 1. Pre-fix these are all `seq <= lastSeq` and silently dropped.
    voiceController.receiveFrame(
      peer,
      packVoiceFrames([framePayload(1, 2000), framePayload(2, 2000), framePayload(3, 2000)])
    );
    expect(decoderFor(peer).decoded.length).toBe(8);
  });

  it('after adoption, late frames from the superseded session are dropped even when their seq passes the plain dedupe', () => {
    const peer = 'epoch-stale-drop-peer';
    for (let seq = 1; seq <= 5; seq++) {
      voiceController.receiveFrame(peer, JSON.stringify(framePayload(seq, 1000)));
    }
    voiceController.receiveFrame(peer, JSON.stringify(framePayload(1, 2000)));
    voiceController.receiveFrame(peer, JSON.stringify(framePayload(2, 2000)));
    expect(decoderFor(peer).decoded.length).toBe(7);

    // A delayed session-1000 packet: seq 6 would pass the plain seq dedupe
    // (6 > lastSeq 2). Ordered epochs must drop it instead of replaying
    // stale audio or re-adopting backwards.
    voiceController.receiveFrame(peer, JSON.stringify(framePayload(6, 1000)));
    expect(decoderFor(peer).decoded.length).toBe(7);
  });

  it('adoption resets the per-session playout mappings (anchor and wts map)', () => {
    const peer = 'epoch-anchor-reset-peer';
    voiceController.receiveFrame(peer, JSON.stringify(framePayload(1, 1000)));
    const state = (voiceController as any).peers.get(peer);
    state.playoutAnchor = { senderWtsMs: 1, atCtxSec: 0, setAtMs: Date.now() };
    state.wtsByTs.set(123, 456);

    voiceController.receiveFrame(peer, JSON.stringify(framePayload(1, 2000)));
    expect(state.playoutAnchor).toBeNull();
    // The adopted frame's own wts entry may be present; the pre-adoption
    // entry must be gone.
    expect(state.wtsByTs.has(123)).toBe(false);
  });

  it('legacy epoch-less senders keep the pre-epoch dedupe exactly (declared limitation: a restarted legacy sender is still dropped)', () => {
    const peer = 'legacy-peer';
    for (let seq = 1; seq <= 3; seq++) {
      voiceController.receiveFrame(peer, JSON.stringify(framePayload(seq)));
    }
    expect(decoderFor(peer).decoded.length).toBe(3);

    voiceController.receiveFrame(peer, JSON.stringify(framePayload(2))); // duplicate
    voiceController.receiveFrame(peer, JSON.stringify(framePayload(1))); // "restart"
    expect(decoderFor(peer).decoded.length).toBe(3);

    voiceController.receiveFrame(peer, JSON.stringify(framePayload(4)));
    expect(decoderFor(peer).decoded.length).toBe(4);
  });
});

describe('voice send: capture-session epoch stamping', () => {
  it('outgoing frames carry the controller epoch as `ep`', async () => {
    const sent: string[] = [];
    const fakeStore = {
      clock: systemClock,
      _signalsTargets: {
        subscribe(run: (v: Set<string>) => void) {
          run(new Set(['target-peer']));
          return () => {};
        },
      },
      signalsCadence: () => ({ mode: 'full' }),
      voiceBatchEligible: () => false,
      sendModuleData: async (_module: string, data: string) => {
        sent.push(data);
      },
    };
    voiceController.bind(fakeStore as any);
    try {
      (voiceController as any).epoch = 7777;
      (voiceController as any).handleEncodedChunk({
        byteLength: 2,
        copyTo: () => {},
        timestamp: 20_000,
        type: 'key',
      });
      expect(sent.length).toBe(1);
      const payload = JSON.parse(sent[0]);
      expect(payload.ep).toBe(7777);
    } finally {
      voiceController.unbind();
      (voiceController as any).audioContext = { currentTime: 0 };
    }
  });

  it('each startCapture attempt takes a fresh, strictly increasing epoch', async () => {
    // Mic acquisition fails (no getUserMedia in node), so capture never
    // starts — but the epoch must already be assigned for the attempt,
    // and a second attempt must get a larger one.
    (globalThis as any).AudioEncoder = class { constructor(_: unknown) {} configure(_: unknown) {} close() {} };
    (globalThis as any).MediaStreamTrackProcessor = class { constructor(_: unknown) {} };
    const fakeStore = {
      clock: systemClock,
      micSource: {
        acquire: async () => null,
        ensureAudioContext: () => ({ currentTime: 0 }),
      },
    };
    voiceController.bind(fakeStore as any);
    try {
      const before = Date.now();
      expect(await voiceController.startCapture()).toBe(false);
      const first = (voiceController as any).epoch;
      expect(first).toBeGreaterThanOrEqual(before);
      expect(await voiceController.startCapture()).toBe(false);
      const second = (voiceController as any).epoch;
      expect(second).toBeGreaterThan(first);
    } finally {
      voiceController.unbind();
      delete (globalThis as any).AudioEncoder;
      delete (globalThis as any).MediaStreamTrackProcessor;
      (voiceController as any).audioContext = { currentTime: 0 };
    }
  });
});
