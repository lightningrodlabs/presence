import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  packVoiceFrames,
  unpackVoicePayload,
  VOICE_BATCH_FRAMES,
  voiceController,
} from '../voice';
import { ManualClock } from '../../../clock.testing';
import type { StreamsStore } from '../../../streams-store';

/**
 * The pure batch/parse helpers (Task 7): testable without WebCodecs. The
 * receive-path tests below stub the two WebCodecs constructors the decoder
 * path touches, so the per-frame seq/loss accounting over batched arrivals
 * runs in node against the real `receiveFrame` glue.
 */

const f = (seq: number) => ({
  seq,
  ts: seq * 20_000,
  type: 'key' as const,
  data: 'AA==',
  wts: 1,
});

describe('voice batch pack/unpack helpers', () => {
  it('round-trips a batch', () => {
    const frames = [f(1), f(2), f(3)];
    expect(unpackVoicePayload(packVoiceFrames(frames))).toEqual(frames);
  });

  it('unpacks a legacy single-frame payload as a one-element array', () => {
    expect(unpackVoicePayload(JSON.stringify(f(7)))).toEqual([f(7)]);
  });

  it('batch size constant is 3', () => expect(VOICE_BATCH_FRAMES).toBe(3));
});

// ---------------------------------------------------------------------------
// Receive path: batched arrivals through the real per-frame accounting
// ---------------------------------------------------------------------------

class StubAudioDecoder {
  static instances: StubAudioDecoder[] = [];

  state = 'configured';

  decodedTimestamps: number[] = [];

  constructor(_opts: unknown) {
    StubAudioDecoder.instances.push(this);
  }

  configure(_config: unknown): void {}

  decode(chunk: { timestamp: number }): void {
    this.decodedTimestamps.push(chunk.timestamp);
  }

  close(): void {
    this.state = 'closed';
  }
}

class StubEncodedAudioChunk {
  type: string;

  timestamp: number;

  constructor(opts: { type: string; timestamp: number; data: unknown }) {
    this.type = opts.type;
    this.timestamp = opts.timestamp;
  }
}

const peer = 'uhCAk_voice_batch_peer';

type PeerAccounting = {
  lastSeq: number;
  lostCount: number;
  receivedCount: number;
};

function peerState(): PeerAccounting {
  return (
    voiceController as unknown as {
      peers: Map<string, PeerAccounting>;
    }
  ).peers.get(peer)!;
}

function decodedTimestamps(): number[] {
  return StubAudioDecoder.instances[0]?.decodedTimestamps ?? [];
}

describe('receiveFrame over batched payloads (per-frame accounting)', () => {
  beforeEach(() => {
    StubAudioDecoder.instances = [];
    (globalThis as Record<string, unknown>).AudioDecoder = StubAudioDecoder;
    (globalThis as Record<string, unknown>).EncodedAudioChunk =
      StubEncodedAudioChunk;
    const clock = new ManualClock(1_000_000);
    const fakeStore = {
      clock,
      micSource: { ensureAudioContext: () => ({}) as AudioContext },
      signalsStats: new Map(),
      logger: { logCustomMessage: () => {} },
    } as unknown as StreamsStore;
    voiceController.bind(fakeStore);
  });

  afterEach(() => {
    voiceController.unbind();
    delete (globalThis as Record<string, unknown>).AudioDecoder;
    delete (globalThis as Record<string, unknown>).EncodedAudioChunk;
  });

  it('a v2 batch decodes every member, in seq order, through the per-frame path', () => {
    voiceController.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    expect(decodedTimestamps()).toEqual([f(1).ts, f(2).ts, f(3).ts]);
    const state = peerState();
    expect(state.lastSeq).toBe(3);
    expect(state.lostCount).toBe(0);
    expect(state.receivedCount).toBe(3);
  });

  it('loss windows count per FRAME, not per packet, across a batch gap', () => {
    voiceController.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    // One whole packet ([f4,f5,f6]) lost: the gap is 3 frames, not 1 packet.
    voiceController.receiveFrame(peer, packVoiceFrames([f(7), f(8), f(9)]));
    const state = peerState();
    expect(state.lostCount).toBe(3);
    expect(state.receivedCount).toBe(6);
    expect(state.lastSeq).toBe(9);
  });

  it('a wholly-duplicate batch is dropped without touching accounting', () => {
    voiceController.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    voiceController.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    expect(decodedTimestamps()).toHaveLength(3);
    expect(peerState().receivedCount).toBe(3);
  });

  it('a legacy single-frame payload with RED still recovers the missing frame', () => {
    voiceController.receiveFrame(peer, JSON.stringify(f(1)));
    // f(2) lost in its own packet; f(3) carries it redundantly.
    voiceController.receiveFrame(peer, JSON.stringify({ ...f(3), red: [f(2)] }));
    expect(decodedTimestamps()).toEqual([f(1).ts, f(2).ts, f(3).ts]);
    expect(peerState().lostCount).toBe(0);
  });

  it('RED carried on a batch member recovers frames from a lost previous packet', () => {
    voiceController.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    // Packet [f4,f5,f6] lost; the next batch's primary (first) frame
    // carries the two frames preceding the batch redundantly.
    voiceController.receiveFrame(
      peer,
      packVoiceFrames([{ ...f(7), red: [f(5), f(6)] }, f(8), f(9)]),
    );
    expect(decodedTimestamps()).toEqual(
      [1, 2, 3, 5, 6, 7, 8, 9].map(n => n * 20_000),
    );
    // Only f4 was carried by NO packet.
    expect(peerState().lostCount).toBe(1);
  });

  it('malformed payloads and non-frame JSON are dropped without throwing', () => {
    voiceController.receiveFrame(peer, 'not json');
    voiceController.receiveFrame(peer, 'null');
    voiceController.receiveFrame(peer, JSON.stringify({ v: 2, frames: 'x' }));
    expect(StubAudioDecoder.instances.flatMap(d => d.decodedTimestamps)).toEqual([]);
  });
});
