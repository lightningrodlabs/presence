import { describe, it, expect } from 'vitest';
import wire from './fixtures/wire.json';
import {
  packVoiceFrames,
  unpackVoicePayload,
  VOICE_BATCH_FRAMES,
  type VoiceFramePayload,
} from '../voice-carrier.js';

/**
 * Golden wire fixture (design spec decision 8): the four payload shapes a
 * Presence 0.15.6 sender puts on the wire, recorded at `ab90584`.
 *
 * This suite reads ONLY `fixtures/wire.json` — no path outside this package
 * (spec decision 13, self-contained directory). The cross-tree question —
 * does Presence's own copy still emit these names — is the monorepo's
 * `scripts/check-signals-media-drift.mjs`, which is dropped on extraction.
 *
 * What it pins:
 *  - the exact top-level key set AND order of each payload, so a field
 *    added, removed or reordered in this package's senders fails here;
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
