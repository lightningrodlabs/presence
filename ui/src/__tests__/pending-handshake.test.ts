import { describe, expect, it } from 'vitest';
import { prunePendingInits } from '../peer-record';
import type { PendingInit } from '../types';

const TTL = 20_000;
const NOW = 1_000_000;

const entry = (t0: number, connectionId = 'c'): PendingInit => ({ connectionId, t0 });

describe('prunePendingInits (Phase 2 item 7 / peer-record fold)', () => {
  it('keeps entries at or under the TTL, verbatim', () => {
    const entries = [entry(NOW - TTL, 'a'), entry(NOW, 'b')];
    expect(prunePendingInits(entries, NOW, TTL)).toEqual(entries);
  });

  it('drops entries older than the TTL, keeping the rest', () => {
    const entries = [entry(NOW - TTL - 1, 'a'), entry(NOW - 100, 'b')];
    expect(prunePendingInits(entries, NOW, TTL)).toEqual([entry(NOW - 100, 'b')]);
  });

  it('returns undefined when every entry has expired', () => {
    const entries = [entry(NOW - TTL - 1, 'a')];
    expect(prunePendingInits(entries, NOW, TTL)).toBeUndefined();
  });

  it('treats a timestamp of 0 as a real (very old) timestamp, not absence', () => {
    const entries = [entry(0, 'a')];
    expect(prunePendingInits(entries, NOW, TTL)).toBeUndefined();
    // At now === TTL, 0 sits exactly at the boundary (now - t0 === ttl) and survives
    // (the filter is `<=`).
    expect(prunePendingInits(entries, TTL, TTL)).toEqual([entry(0, 'a')]);
  });

  it('leaves the input array untouched (pure)', () => {
    const entries = [entry(NOW - TTL - 1, 'a')];
    prunePendingInits(entries, NOW, TTL);
    expect(entries).toHaveLength(1);
  });
});
