import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderTiles } from '../room/tile-order-policy';

/**
 * Grid tile order has ONE authority: `orderTiles` (room/tile-order-policy.ts).
 *
 * The key is the agent's ALL_AGENTS anchor-link timestamp — when they first
 * joined this room, ever — read from the DHT so every participant sorts the
 * same values. Present tiles and phantom tiles interleave on the same key,
 * so a peer flipping between present and phantom (or between ping-fresh and
 * media-only inside `computePresentPeers`) keeps its slot. Before this
 * policy, order was `_knownAgents` insertion order with media-only peers and
 * phantoms appended in later segments, and a pong hiccup on a peer with
 * live media moved their tile to the tail and back.
 */

const A = 'uhCAkAAAA';
const B = 'uhCAkBBBB';
const C = 'uhCAkCCCC';
const D = 'uhCAkDDDD';

describe('orderTiles', () => {
  it('sorts present peers by joinedAt ascending, independent of input order', () => {
    const joinedAt = { [A]: 300, [B]: 100, [C]: 200 };
    const fromOne = orderTiles({ present: [A, B, C], phantoms: [], joinedAt });
    const fromOther = orderTiles({ present: [C, A, B], phantoms: [], joinedAt });
    const want = [
      { pubkey: B, kind: 'present' },
      { pubkey: C, kind: 'present' },
      { pubkey: A, kind: 'present' },
    ];
    expect(fromOne).toEqual(want);
    expect(fromOther).toEqual(want);
  });

  it('interleaves phantoms with present peers on the same key', () => {
    const joinedAt = { [A]: 1, [B]: 2, [C]: 3 };
    expect(
      orderTiles({ present: [A, C], phantoms: [B], joinedAt })
    ).toEqual([
      { pubkey: A, kind: 'present' },
      { pubkey: B, kind: 'phantom' },
      { pubkey: C, kind: 'present' },
    ]);
  });

  it('a peer flipping present → phantom keeps its index', () => {
    const joinedAt = { [A]: 1, [B]: 2, [C]: 3 };
    const before = orderTiles({ present: [A, B, C], phantoms: [], joinedAt });
    const after = orderTiles({ present: [A, C], phantoms: [B], joinedAt });
    expect(before.map(t => t.pubkey)).toEqual(after.map(t => t.pubkey));
    expect(after[1]).toEqual({ pubkey: B, kind: 'phantom' });
  });

  it('peers with no joinedAt sort after every stamped peer, lexically', () => {
    const joinedAt = { [D]: 50 };
    expect(
      orderTiles({ present: [C, D, A], phantoms: [], joinedAt }).map(t => t.pubkey)
    ).toEqual([D, A, C]);
  });

  it('equal joinedAt breaks ties lexically by pubkey', () => {
    const joinedAt = { [A]: 7, [B]: 7, [C]: 7 };
    expect(
      orderTiles({ present: [C, B, A], phantoms: [], joinedAt }).map(t => t.pubkey)
    ).toEqual([A, B, C]);
  });

  it('a pubkey listed as both present and phantom renders once, as present', () => {
    expect(
      orderTiles({ present: [A], phantoms: [A], joinedAt: { [A]: 1 } })
    ).toEqual([{ pubkey: A, kind: 'present' }]);
  });

  it('empty inputs yield no tiles', () => {
    expect(orderTiles({ present: [], phantoms: [], joinedAt: {} })).toEqual([]);
  });
});

describe('room-view renders the grid through orderTiles', () => {
  const src = readFileSync(
    join(__dirname, '..', 'room', 'room-view.ts'),
    'utf8'
  );

  it('keys one repeat() on the ordered tile list and keeps no separate phantom block', () => {
    expect(src).toContain('orderTiles({');
    expect(src).toMatch(/repeat\(\s*this\._orderedTiles\(\)/);
    // The two-segment shape this policy replaces: a present repeat over
    // _visiblePeers() followed by a phantom-only block appended after it.
    expect(src).not.toMatch(/repeat\(\s*this\._visiblePeers\(\)/);
    expect(src).not.toContain('${this._renderPhantomTiles()}');
  });
});
