import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Source pins over room-view's `_renderPeerTile` template mapping
 * (peer-tile spec 2026-09-30, final-review finding I4). The view tests in
 * intent-diff-surfaces.test.ts render the helper methods in isolation and
 * cannot see where `_renderPeerTile` places them; these pins can. Same
 * source-pin shape as video-el-paint-order.test.ts.
 *
 * Negative controls — the mutation each pin catches:
 *   (1) replace `peerTileFor(` with an inline re-derivation in the view.
 *   (2) move `this._renderTileStatusLine(tile)` back inside the
 *       `${conn ? … : html``}` video conditional (the status line then
 *       vanishes whenever there is no media slot — exactly the signals-
 *       only peer the line exists for), or below the details overlay.
 *   (3) read `conn.video` / `conn?.video` in the tile (a second, raw
 *       video-state read that bypasses `tile.background`).
 *   (4) drive `.hideAvatar=` from anything but `tile.background`.
 *   (5) drop the details-overlay signals-stale marker
 *       (`!this._activeAgents.value[pubkeyB64]` inside the
 *       `_showConnectionDetails` block), the carrier fact CLAUDE.md
 *       records as now rendering there.
 */

const src = readFileSync(join(__dirname, '..', 'room', 'room-view.ts'), 'utf8');

function methodBody(name: string): string {
  const start = src.indexOf(`private ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf('\n  /**\n', start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('_renderPeerTile template mapping', () => {
  const body = methodBody('_renderPeerTile');

  it('(1) gathers the tile through the store authority', () => {
    expect(body).toContain('this.streamsStore.peerTileFor(');
  });

  it('(2) the status line renders after the video conditional closes and before the details overlay', () => {
    const closeConditional = body.indexOf(': html``}');
    const call = body.indexOf('this._renderTileStatusLine(tile)');
    const overlay = body.indexOf('<!-- Connection detail statuses');
    expect(closeConditional).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(overlay).toBeGreaterThan(-1);
    // The video conditional is the one that opens with `${conn`.
    expect(body.indexOf('${conn\n')).toBeGreaterThan(-1);
    const videoCondClose = body.indexOf(': html``}', body.indexOf('${conn\n'));
    expect(call).toBeGreaterThan(videoCondClose);
    expect(call).toBeLessThan(overlay);
  });

  it('(3) reads no raw video state off the slot', () => {
    expect(body).not.toMatch(/conn\??\.video/);
  });

  it('(4) every .hideAvatar= binding reads tile.background', () => {
    const bindings = body.match(/\.hideAvatar=\$\{[^}]*\}/g) ?? [];
    expect(bindings.length).toBeGreaterThan(0);
    for (const b of bindings) expect(b).toContain('tile.background');
  });

  it('(5) the details overlay carries the signals-stale marker', () => {
    const overlay = body.indexOf('${this._showConnectionDetails');
    const marker = body.indexOf('!this._activeAgents.value[pubkeyB64]');
    expect(overlay).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(overlay);
  });
});
