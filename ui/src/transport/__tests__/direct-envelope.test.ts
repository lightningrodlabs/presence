import { describe, expect, it } from 'vitest';
import { encode } from '@msgpack/msgpack';
import {
  DIRECT_ENVELOPE_VERSION,
  decodeDirectEnvelope,
  encodeDirectEnvelope,
} from '../direct-envelope';

const FROM = new Uint8Array(39).fill(7);

describe('direct envelope', () => {
  it('round-trips a message', () => {
    const bytes = encodeDirectEnvelope({
      from: FROM,
      msgType: 'ModuleData',
      payload: '{"moduleId":"voice"}',
    });
    const decoded = decodeDirectEnvelope(bytes);
    expect(decoded).toEqual({
      ok: true,
      value: { from: FROM, msgType: 'ModuleData', payload: '{"moduleId":"voice"}' },
    });
  });

  it('encodes the sender key as msgpack bin, not an int array', () => {
    // A bin-encoded 39-byte key costs 41 bytes; an int array would cost ~78.
    const bytes = encodeDirectEnvelope({ from: FROM, msgType: 'PingUi', payload: '' });
    expect(bytes.byteLength).toBeLessThan(80);
  });

  it.each([
    ['not msgpack at all', new Uint8Array([0xc1])],
    ['a msgpack scalar', encode(4)],
    ['an array', encode([1, 2, 3])],
    ['a map missing msgType', encode({ v: 1, from: FROM, payload: '' })],
    [
      'a map with a non-string payload',
      encode({ v: 1, from: FROM, msgType: 'PingUi', payload: 3 }),
    ],
    [
      'a map with an unknown msgType',
      encode({ v: 1, from: FROM, msgType: 'Nope', payload: '' }),
    ],
    [
      'a map with a non-bytes from',
      encode({ v: 1, from: 'me', msgType: 'PingUi', payload: '' }),
    ],
    [
      'a future envelope version',
      encode({ v: 2, from: FROM, msgType: 'PingUi', payload: '' }),
    ],
  ])('rejects %s without throwing', (_label, bytes) => {
    const decoded = decodeDirectEnvelope(bytes as Uint8Array);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toBeTruthy();
  });

  it('declares version 1', () => {
    expect(DIRECT_ENVELOPE_VERSION).toBe(1);
  });
});
