import { describe, expect, it } from 'vitest';
import { pruneExpiredPending } from '../streams-store';

const TTL = 20_000;
const NOW = 1_000_000;

describe('pruneExpiredPending (Phase 2 item 7)', () => {
  it('keeps entries at or under the TTL', () => {
    const map = { a: [{ t0: NOW - TTL }, { t0: NOW }] };
    expect(pruneExpiredPending(map, e => e.t0, NOW, TTL)).toEqual(map);
  });

  it('drops entries older than the TTL and deletes emptied agents', () => {
    const map = {
      a: [{ t0: NOW - TTL - 1 }],
      b: [{ t0: NOW - TTL - 1 }, { t0: NOW - 100 }],
    };
    expect(pruneExpiredPending(map, e => e.t0, NOW, TTL)).toEqual({
      b: [{ t0: NOW - 100 }],
    });
  });

  it('treats a timestamp of 0 as a real (very old) timestamp, not absence', () => {
    const map = { a: [{ t0: 0 }] };
    expect(pruneExpiredPending(map, e => e.t0, NOW, TTL)).toEqual({});
    expect(pruneExpiredPending(map, e => e.t0, TTL, TTL)).toEqual({
      a: [{ t0: 0 }],
    });
  });

  it('leaves the input untouched (pure)', () => {
    const map = { a: [{ t0: NOW - TTL - 1 }] };
    pruneExpiredPending(map, e => e.t0, NOW, TTL);
    expect(map.a).toHaveLength(1);
  });
});
