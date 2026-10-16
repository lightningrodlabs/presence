import { describe, it, expect } from 'vitest';
import { decode, encode } from '@msgpack/msgpack';
import { decodeDirectSignal, encodeDirectSignal } from '../direct-signal';

/**
 * The direct-signal wire body: msgpack `{ msg_type, payload }`. The encoder
 * is the only thing that writes it (`RoomClient.sendMessage`); the decoder
 * is the only thing that reads it (`RoomClient.onSignal`). `from_agent` is
 * NOT in the body — the conductor stamps it on the `AppDirect` envelope,
 * so a peer cannot forge it.
 */
describe('encodeDirectSignal', () => {
  it('produces a msgpack map with exactly msg_type and payload', () => {
    const bytes = encodeDirectSignal('PingUi', '{"a":1}');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decode(bytes)).toEqual({ msg_type: 'PingUi', payload: '{"a":1}' });
  });

  it('round-trips through the decoder', () => {
    const r = decodeDirectSignal(encodeDirectSignal('ModuleData', 'x'.repeat(20_000)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.msg_type).toBe('ModuleData');
      expect(r.value.payload).toHaveLength(20_000);
    }
  });

  it('keeps the empty payload (the LeaveUi / DiagnosticRequest shape)', () => {
    const r = decodeDirectSignal(encodeDirectSignal('LeaveUi', ''));
    expect(r).toEqual({ ok: true, value: { msg_type: 'LeaveUi', payload: '' } });
  });

  it('is byte-stable for the same input (the tryorama test pins this layout)', () => {
    expect(encodeDirectSignal('t', 'p')).toEqual(encodeDirectSignal('t', 'p'));
    expect(encodeDirectSignal('t', 'p')).toEqual(
      encode({ msg_type: 't', payload: 'p' })
    );
  });
});

describe('decodeDirectSignal', () => {
  const cases: Array<{ name: string; bytes: Uint8Array; errorMatch: RegExp }> = [
    {
      name: 'truncated msgpack',
      bytes: encodeDirectSignal('PingUi', 'hello').slice(0, 5),
      errorMatch: /./,
    },
    { name: 'empty bytes', bytes: new Uint8Array(0), errorMatch: /./ },
    {
      name: 'a msgpack string instead of a map',
      bytes: encode('PingUi'),
      errorMatch: /expected object/,
    },
    { name: 'msgpack nil', bytes: encode(null), errorMatch: /expected object/ },
    {
      name: 'an array',
      bytes: encode(['PingUi', 'x']),
      errorMatch: /expected object/,
    },
    {
      name: 'a map missing payload',
      bytes: encode({ msg_type: 'PingUi' }),
      errorMatch: /payload/,
    },
    {
      name: 'a map missing msg_type',
      bytes: encode({ payload: '' }),
      errorMatch: /msg_type/,
    },
    {
      name: 'a non-string msg_type',
      bytes: encode({ msg_type: 7, payload: '' }),
      errorMatch: /msg_type/,
    },
    {
      name: 'a non-string payload (bytes, the raw-frame temptation)',
      bytes: encode({ msg_type: 'voice', payload: new Uint8Array([1, 2]) }),
      errorMatch: /payload/,
    },
  ];

  cases.forEach(({ name, bytes, errorMatch }) => {
    it(`rejects ${name} without throwing`, () => {
      const r = decodeDirectSignal(bytes);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(errorMatch);
    });
  });

  it('ignores extra keys (a newer peer may add fields)', () => {
    const r = decodeDirectSignal(
      encode({ msg_type: 'PingUi', payload: 'p', future: true })
    );
    expect(r).toEqual({ ok: true, value: { msg_type: 'PingUi', payload: 'p' } });
  });

  it('never throws, whatever bytes it is handed', () => {
    const hostile = [
      new Uint8Array([0xc1]), // never-used msgpack byte
      new Uint8Array([0x81, 0xa8]), // map header, truncated key
      new Uint8Array(1024).fill(0xff),
      encode(new Map([[1, 2]])),
    ];
    for (const bytes of hostile) {
      expect(() => decodeDirectSignal(bytes)).not.toThrow();
      expect(decodeDirectSignal(bytes).ok).toBe(false);
    }
  });
});
