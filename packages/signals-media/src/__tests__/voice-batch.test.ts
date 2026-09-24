// Copied from presence ui/src/room/modules/__tests__/voice-batch.test.ts at ab90584 (signals-media extraction), re-targeted from the fake StreamsStore onto the VoiceHost seam.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  packVoiceFrames,
  unpackVoicePayload,
  VOICE_BATCH_FRAMES,
  VoiceCarrier,
} from '../voice-carrier.js';
import { makeFakeHost } from './fake-host.js';

/**
 * The pure batch/parse helpers: testable without WebCodecs. The receive-path
 * tests below stub the WebCodecs constructors the default Opus backend
 * touches, so the per-frame seq/loss accounting over batched arrivals runs
 * in node against the real `receiveFrame` glue.
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

/** Present only so `webCodecsOpus()` reports the backend available; the
 *  send path is not exercised here. */
class StubAudioEncoder {
  state = 'configured';

  constructor(_opts: unknown) {}

  configure(_config: unknown): void {}

  encode(_data: unknown): void {}

  close(): void {}
}

class StubAudioData {
  constructor(public init: unknown) {}

  close(): void {}
}

const peer = 'uhCAk_voice_batch_peer';

type PeerAccounting = {
  lastSeq: number;
  lostCount: number;
  receivedCount: number;
};

let voice: VoiceCarrier;

function peerState(): PeerAccounting {
  return (
    voice as unknown as {
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
    const g = globalThis as Record<string, unknown>;
    g.AudioDecoder = StubAudioDecoder;
    g.EncodedAudioChunk = StubEncodedAudioChunk;
    g.AudioEncoder = StubAudioEncoder;
    g.AudioData = StubAudioData;
    voice = new VoiceCarrier();
    voice.bind(makeFakeHost().host);
  });

  afterEach(() => {
    voice.unbind();
    const g = globalThis as Record<string, unknown>;
    delete g.AudioDecoder;
    delete g.EncodedAudioChunk;
    delete g.AudioEncoder;
    delete g.AudioData;
  });

  it('a v2 batch decodes every member, in seq order, through the per-frame path', () => {
    voice.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    expect(decodedTimestamps()).toEqual([f(1).ts, f(2).ts, f(3).ts]);
    const state = peerState();
    expect(state.lastSeq).toBe(3);
    expect(state.lostCount).toBe(0);
    expect(state.receivedCount).toBe(3);
  });

  it('loss windows count per FRAME, not per packet, across a batch gap', () => {
    voice.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    // One whole packet ([f4,f5,f6]) lost: the gap is 3 frames, not 1 packet.
    voice.receiveFrame(peer, packVoiceFrames([f(7), f(8), f(9)]));
    const state = peerState();
    expect(state.lostCount).toBe(3);
    expect(state.receivedCount).toBe(6);
    expect(state.lastSeq).toBe(9);
  });

  it('a wholly-duplicate batch is dropped without touching accounting', () => {
    voice.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    voice.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    expect(decodedTimestamps()).toHaveLength(3);
    expect(peerState().receivedCount).toBe(3);
  });

  it('a legacy single-frame payload with RED still recovers the missing frame', () => {
    voice.receiveFrame(peer, JSON.stringify(f(1)));
    // f(2) lost in its own packet; f(3) carries it redundantly.
    voice.receiveFrame(peer, JSON.stringify({ ...f(3), red: [f(2)] }));
    expect(decodedTimestamps()).toEqual([f(1).ts, f(2).ts, f(3).ts]);
    expect(peerState().lostCount).toBe(0);
  });

  it('RED carried on a batch member recovers frames from a lost previous packet', () => {
    voice.receiveFrame(peer, packVoiceFrames([f(1), f(2), f(3)]));
    // Packet [f4,f5,f6] lost; the next batch's primary (first) frame
    // carries the two frames preceding the batch redundantly.
    voice.receiveFrame(
      peer,
      packVoiceFrames([{ ...f(7), red: [f(5), f(6)] }, f(8), f(9)])
    );
    expect(decodedTimestamps()).toEqual([1, 2, 3, 5, 6, 7, 8, 9].map(n => n * 20_000));
    // Only f4 was carried by NO packet.
    expect(peerState().lostCount).toBe(1);
  });

  it('malformed payloads and non-frame JSON are dropped without throwing', () => {
    voice.receiveFrame(peer, 'not json');
    voice.receiveFrame(peer, 'null');
    voice.receiveFrame(peer, JSON.stringify({ v: 2, frames: 'x' }));
    expect(StubAudioDecoder.instances.flatMap(d => d.decodedTimestamps)).toEqual([]);
  });
});
