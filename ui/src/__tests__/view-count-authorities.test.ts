import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gridTileCount } from '../room/layout';

/**
 * View-layer round (§8 view-misc row): the room view's two counts each
 * have one authority.
 *
 *   - tile count: `gridTileCount` (room/layout.ts). Three sites used to
 *     hand-copy `visiblePeers + phantoms + (selfViewHidden ? 0 : 1)`
 *     with keep-in-sync comments — PR #4 F7 was one of them drifting.
 *   - audible count: `countAudiblePeers` (peer-link-policy.ts; tables
 *     live in peer-link-policy.test.ts beside the module's other
 *     decisions).
 *
 * The source pins below mechanize "no hand-rolled copy comes back",
 * in the no-ambient-clock.test.ts style.
 */

describe('gridTileCount', () => {
  const table: Array<{
    name: string;
    input: Parameters<typeof gridTileCount>[0];
    want: number;
  }> = [
    {
      name: 'peers + phantoms + self',
      input: { visiblePeerCount: 3, phantomCount: 2, selfViewHidden: false },
      want: 6,
    },
    {
      name: 'hidden self-view takes no grid slot',
      input: { visiblePeerCount: 3, phantomCount: 2, selfViewHidden: true },
      want: 5,
    },
    {
      name: 'empty room, self visible → the lone own tile',
      input: { visiblePeerCount: 0, phantomCount: 0, selfViewHidden: false },
      want: 1,
    },
    {
      name: 'empty room, self hidden → zero tiles',
      input: { visiblePeerCount: 0, phantomCount: 0, selfViewHidden: true },
      want: 0,
    },
    {
      name: 'phantoms count toward layout sizing even with no live peers',
      input: { visiblePeerCount: 0, phantomCount: 4, selfViewHidden: true },
      want: 4,
    },
  ];

  it.each(table)('$name', ({ input, want }) => {
    expect(gridTileCount(input)).toBe(want);
  });
});

describe('room-view reads the count authorities, not private re-sums', () => {
  const src = readFileSync(
    join(__dirname, '..', 'room', 'room-view.ts'),
    'utf8'
  );

  it('calls _tileCount at all three grid sites and hand-rolls no tile sum', () => {
    // The helper plus its three consumers (_updateGrid, idToLayout, the
    // CSS-var n).
    const calls = src.match(/this\._tileCount\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // The hand-sum signature every drifted copy shared: adding onto the
    // visible-peer or phantom count inline.
    expect(src).not.toMatch(/_visiblePeers\(\)\.length\s*\+/);
    expect(src).not.toMatch(/phantomAgents\(\)\.length\s*\+/);
  });

  it('routes the audible counter through countAudiblePeers and keeps no inline audibility filter', () => {
    expect(src).toContain('countAudiblePeers({');
    // The inline shapes the old IIFE used.
    expect(src).not.toMatch(/audioLink === 'webrtc' \|\|/);
    expect(src).not.toMatch(/type === 'Connected'/);
  });
});
