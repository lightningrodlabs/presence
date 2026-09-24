import { describe, it, expect } from 'vitest';
import wire from './fixtures/wire.json';
import {
  VoiceCarrier,
  packVoiceFrames,
  unpackVoicePayload,
  VOICE_BATCH_FRAMES,
  type VoiceFramePayload,
} from '../voice-carrier.js';
import { FilmstripCarrier } from '../filmstrip-carrier.js';
import { makeFakeHost } from './fake-host.js';
import type { OpusPacket } from '../types.js';

/**
 * Golden wire fixture (design spec decision 8): the four payload shapes a
 * Presence 0.15.6 sender puts on the wire, recorded at `ab90584` by reading
 * the construction sites in `ui/src/room/modules/voice.ts` and
 * `video-filmstrip.ts`.
 *
 * This suite reads ONLY `fixtures/wire.json` — no path outside this package
 * (spec decision 13, self-contained directory). The cross-tree question —
 * does Presence's own copy still emit these names — is the monorepo's
 * `scripts/check-signals-media-drift.mjs`, which is dropped on extraction.
 * Nothing here (and no other suite) exercises a package peer against a real
 * Presence peer: interop is an inference from the two field-name checks plus
 * the shapes below, not a tested property.
 *
 * What it pins:
 *  - the recorded payloads' key sets, key order and nesting — the fixture's
 *    own consistency, which is what the rest of the suite is read against;
 *  - **what this package's SENDERS actually emit**: `VoiceCarrier` and
 *    `FilmstripCarrier` are driven through a fake host and the payloads they
 *    hand to `host.send` are compared, key for key and in order, against the
 *    fixture. A field added to, removed from or reordered in a frame literal
 *    fails here. (Mutation-checked when written: adding a field to
 *    `voice-carrier.ts`'s frame literal reddens the voice cases.)
 *  - `packVoiceFrames` byte-equality against the recorded batch envelope;
 *  - `unpackVoicePayload` round-trips, including the legacy single-frame
 *    tolerance (any non-v2 JSON value is one frame).
 */

const cases = wire.cases;

const keysOf = (json: string): string[] => Object.keys(JSON.parse(json) as object);

describe('wire fixture: recorded shapes', () => {
  for (const [name, c] of Object.entries(cases)) {
    it(`${name} has exactly the recorded top-level keys, in order`, () => {
      expect(keysOf(c.json)).toEqual(c.fields);
    });

    it(`${name} re-stringifies to the recorded bytes`, () => {
      expect(JSON.stringify(JSON.parse(c.json))).toBe(c.json);
    });
  }

  it('negative control: the key-set check catches a dropped field', () => {
    const parsed = JSON.parse(cases.voiceFrameV1.json) as Record<string, unknown>;
    delete parsed.ep;
    expect(Object.keys(parsed)).not.toEqual(cases.voiceFrameV1.fields);
  });
});

describe('wire fixture: voice v1 per-frame payload', () => {
  const payload = JSON.parse(cases.voiceFrameV1.json) as VoiceFramePayload;

  it('carries a RED block whose entries have the recorded keys', () => {
    expect(payload.red).toBeDefined();
    for (const f of payload.red!) {
      expect(Object.keys(f)).toEqual(cases.voiceFrameV1.nested.red);
    }
  });

  it('RED entries are the immediately-preceding frames, oldest first', () => {
    expect(payload.red!.map(f => f.seq)).toEqual([payload.seq - 2, payload.seq - 1]);
  });

  it('unpacks as one legacy frame', () => {
    expect(unpackVoicePayload(cases.voiceFrameV1.json)).toEqual([payload]);
  });
});

describe('wire fixture: voice v2 batch envelope', () => {
  const envelope = JSON.parse(cases.voiceBatchV2.json) as {
    v: number;
    frames: VoiceFramePayload[];
  };

  it('is a { v: 2, frames } envelope of VOICE_BATCH_FRAMES frames', () => {
    expect(envelope.v).toBe(2);
    expect(envelope.frames).toHaveLength(VOICE_BATCH_FRAMES);
  });

  it('carries RED on the first frame only', () => {
    const [first, ...rest] = envelope.frames;
    expect(Object.keys(first)).toEqual(cases.voiceBatchV2.nested.frames);
    const withoutRed = cases.voiceBatchV2.nested.frames.filter(k => k !== 'red');
    for (const f of rest) expect(Object.keys(f)).toEqual(withoutRed);
    for (const f of first.red!) {
      expect(Object.keys(f)).toEqual(cases.voiceBatchV2.nested.red);
    }
  });

  it('packVoiceFrames reproduces the recorded bytes exactly', () => {
    expect(packVoiceFrames(envelope.frames)).toBe(cases.voiceBatchV2.json);
  });

  it('unpackVoicePayload yields the frames, and the pair round-trips', () => {
    expect(unpackVoicePayload(cases.voiceBatchV2.json)).toEqual(envelope.frames);
    expect(packVoiceFrames(unpackVoicePayload(cases.voiceBatchV2.json))).toBe(
      cases.voiceBatchV2.json,
    );
  });
});

describe('wire fixture: filmstrip payloads', () => {
  const clip = JSON.parse(cases.filmstripClip.json) as Record<string, unknown>;
  const stop = JSON.parse(cases.filmstripStop.json) as Record<string, unknown>;

  it('a clip omits `kind` — clip is the default arm', () => {
    expect('kind' in clip).toBe(false);
  });

  it('a clip carries the geometry and pacing a receiver needs', () => {
    expect(typeof clip.w).toBe('number');
    expect(typeof clip.h).toBe('number');
    expect(typeof clip.n).toBe('number');
    expect(typeof clip.p).toBe('number');
    expect(typeof clip.t0).toBe('number');
    expect(typeof clip.data).toBe('string');
  });

  it('a stop payload is kind/seq/ts only — no media', () => {
    expect(stop.kind).toBe('stop');
    expect(Object.keys(stop)).toEqual(['kind', 'seq', 'ts']);
  });

  it('clip and stop share one seq series from the sender', () => {
    expect(stop.seq).toBe((clip.seq as number) + 1);
  });
});

// ---------------------------------------------------------------------------
// The senders, bound to the fixture.
//
// Everything above compares the fixture against itself. These cases drive the
// real carriers through `makeFakeHost` and assert that what reaches
// `host.send` has the fixture's keys, in the fixture's order. This is the half
// that fails when a frame literal changes.
// ---------------------------------------------------------------------------

const pkt = (timestampUs: number, type: 'key' | 'delta' = 'delta'): OpusPacket => ({
  type,
  timestampUs,
  data: new Uint8Array([0xf8, 0xf8, 0x00]),
});

/** `handleEncodedPacket` is the encoder's callback — the send path's entry
 *  point, reachable without WebCodecs or a mic. */
type EncodedSink = { handleEncodedPacket(p: OpusPacket): void };

function drivePackets(voice: VoiceCarrier, count: number): void {
  const sink = voice as unknown as EncodedSink;
  for (let i = 0; i < count; i++) sink.handleEncodedPacket(pkt(i * 20_000));
}

describe('senders emit the fixture shapes: voice', () => {
  const v1 = cases.voiceFrameV1;
  const withoutRed = v1.fields.filter(k => k !== 'red');

  it('the per-frame path emits exactly the recorded v1 keys, in order', () => {
    const h = makeFakeHost({ targets: ['p'], batchEligible: false });
    const voice = new VoiceCarrier();
    voice.bind(h.host);
    // Three packets: the first has no RED history, the third carries the
    // full two-frame block the fixture records.
    drivePackets(voice, 3);
    voice.unbind();

    expect(h.sent.map(s => s.kind)).toEqual(['voice', 'voice', 'voice']);
    expect(Object.keys(JSON.parse(h.sent[0].payload))).toEqual(withoutRed);
    const third = JSON.parse(h.sent[2].payload) as VoiceFramePayload;
    expect(Object.keys(third)).toEqual(v1.fields);
    expect(third.red).toHaveLength(2);
    for (const f of third.red!) {
      expect(Object.keys(f)).toEqual(v1.nested.red);
    }
  });

  it('the batched path emits { v, frames } with the recorded frame keys', () => {
    const batch = cases.voiceBatchV2;
    const h = makeFakeHost({ targets: ['p'], batchEligible: true });
    const voice = new VoiceCarrier();
    voice.bind(h.host);
    // Two full batches: the second one's first frame carries the RED block
    // covering the frames the previous packet took, as the fixture records.
    drivePackets(voice, VOICE_BATCH_FRAMES * 2);
    voice.unbind();

    expect(h.sent).toHaveLength(2);
    const envelope = JSON.parse(h.sent[1].payload) as {
      v: number;
      frames: VoiceFramePayload[];
    };
    expect(Object.keys(envelope)).toEqual(batch.fields);
    expect(envelope.v).toBe(2);
    expect(envelope.frames).toHaveLength(VOICE_BATCH_FRAMES);
    const [first, ...rest] = envelope.frames;
    expect(Object.keys(first)).toEqual(batch.nested.frames);
    for (const f of rest) {
      expect(Object.keys(f)).toEqual(batch.nested.frames.filter(k => k !== 'red'));
    }
    for (const f of first.red!) {
      expect(Object.keys(f)).toEqual(batch.nested.red);
    }
  });
});

describe('senders emit the fixture shapes: filmstrip', () => {
  /** The worker's clip message — the send path's entry point, reachable
   *  without a camera, a worker or `OffscreenCanvas`. */
  type ClipSink = {
    _handleClipFromWorker(msg: {
      bytes: ArrayBuffer;
      w: number;
      h: number;
      n: number;
      p: number;
      t0: number;
      capturedAt: number;
    }): void;
  };

  const clipMessage = () => ({
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer,
    w: 128,
    h: 96,
    n: 1,
    p: 167,
    t0: 1_757_548_800_333,
    capturedAt: 1_757_548_800_500,
  });

  it('a clip emits exactly the recorded clip keys, in order', () => {
    const h = makeFakeHost({ targets: ['p'], cadence: 'full' });
    const film = new FilmstripCarrier();
    film.bind(h.host);
    (film as unknown as ClipSink)._handleClipFromWorker(clipMessage());

    // Asserted before unbind: unbind tears capture down, and teardown sends
    // the courtesy stop to everyone this sender has transmitted to.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].kind).toBe('filmstrip');
    expect(Object.keys(JSON.parse(h.sent[0].payload))).toEqual(
      cases.filmstripClip.fields,
    );
    film.unbind();
  });

  it('stopCapture emits exactly the recorded stop keys, in order', async () => {
    const h = makeFakeHost({ targets: ['p'], cadence: 'full' });
    const film = new FilmstripCarrier();
    film.bind(h.host);
    // The courtesy stop goes only to peers this sender has transmitted to,
    // so a clip has to precede it.
    (film as unknown as ClipSink)._handleClipFromWorker(clipMessage());
    await film.stopCapture();
    film.unbind();

    expect(h.sent).toHaveLength(2);
    const stopPayload = JSON.parse(h.sent[1].payload) as Record<string, unknown>;
    expect(Object.keys(stopPayload)).toEqual(cases.filmstripStop.fields);
    expect(stopPayload.kind).toBe('stop');
  });
});
