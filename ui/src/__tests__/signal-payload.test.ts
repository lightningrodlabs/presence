import { describe, it, expect } from 'vitest';
import { parseSignalPayload } from '../signal-payload';

describe('parseSignalPayload', () => {
  type InitPayload = { connection_id: string; connection_type: string };

  const cases: Array<{
    name: string;
    raw: unknown;
    ok: boolean;
    errorMatch?: RegExp;
  }> = [
    {
      name: 'a well-formed object payload',
      raw: '{"connection_id":"abc","connection_type":"video"}',
      ok: true,
    },
    { name: 'an empty object', raw: '{}', ok: true },
    {
      name: 'truncated JSON — the relay-delivery case',
      raw: '{"connection_id":"ab',
      ok: false,
    },
    { name: 'the empty string', raw: '', ok: false },
    { name: 'unparseable garbage', raw: 'not json at all', ok: false },
    {
      name: 'valid JSON that is a bare number',
      raw: '4',
      ok: false,
      errorMatch: /expected object/,
    },
    {
      name: 'valid JSON that is a bare string',
      raw: '"hello"',
      ok: false,
      errorMatch: /expected object/,
    },
    {
      name: 'valid JSON null',
      raw: 'null',
      ok: false,
      errorMatch: /null.*expected object/,
    },
    {
      name: 'valid JSON that is an array',
      raw: '[1,2,3]',
      ok: false,
      errorMatch: /array.*expected object/,
    },
    {
      name: 'a non-string payload (undefined)',
      raw: undefined,
      ok: false,
      errorMatch: /expected string/,
    },
    {
      name: 'a non-string payload (already-parsed object)',
      raw: { connection_id: 'abc' },
      ok: false,
      errorMatch: /expected string/,
    },
  ];

  cases.forEach(({ name, raw, ok, errorMatch }) => {
    it(`${ok ? 'accepts' : 'rejects'} ${name}`, () => {
      const result = parseSignalPayload<InitPayload>(raw);
      expect(result.ok).toBe(ok);
      if (!result.ok && errorMatch) {
        expect(result.error).toMatch(errorMatch);
      }
    });
  });

  it('never throws, whatever it is handed', () => {
    const hostile: unknown[] = [
      '{"a":',
      '   ',
      '{"a":{"b":{"c":',
      Symbol('x'),
      123,
      null,
      () => {},
    ];
    hostile.forEach(raw => {
      expect(() => parseSignalPayload(raw)).not.toThrow();
    });
  });

  it('returns the parsed value for the caller to destructure', () => {
    const result = parseSignalPayload<InitPayload>(
      '{"connection_id":"abc","connection_type":"video"}'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.connection_id).toBe('abc');
      expect(result.value.connection_type).toBe('video');
    }
  });
});
