import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Paint-order pins for the peer pane's filmstrip/video layering.
 *
 * The invariant: the WebRTC <video> must paint ABOVE the always-mounted
 * peer-filmstrip overlay. CSS paint order puts positioned elements
 * (z-index auto) above ALL in-flow content regardless of document
 * order — document order breaks ties only among positioned siblings.
 * The filmstrip host is `position: absolute`, so an un-positioned
 * `.video-el` sits BELOW it no matter where it appears in the template
 * (field symptom: a filmstrip frame painted over a live WebRTC video).
 *
 * Both halves are pinned because either side regressing silently
 * reintroduces the bug:
 *   - `.video-el` must be positioned (joins the positioned paint
 *     group; its later document position then wins over the filmstrip)
 *     while keeping z-index auto so `.module-replace-content`
 *     (z-index: 1) still covers it.
 *   - the peer-filmstrip host must stay positioned WITHOUT an explicit
 *     z-index — a z-index there would lift it back over the video and
 *     over the un-z-indexed pane chrome rendered after it.
 *
 * jsdom does no layout/painting, so this is a source pin over the two
 * stylesheets, following video-bind.test.ts's source-pin shape.
 */

const roomViewSrc = readFileSync(
  join(__dirname, '..', 'room', 'room-view.ts'),
  'utf8'
);
const filmstripSrc = readFileSync(
  join(__dirname, '..', 'room', 'elements', 'peer-filmstrip.ts'),
  'utf8'
);

/**
 * The rule body whose selector line is exactly `selector` (not a
 * compound selector merely ending in it, e.g. the border-radius
 * override `.video-container:... .video-el`).
 */
function ruleBlock(src: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = src.match(new RegExp(`^\\s*${escaped} \\{`, 'm'));
  expect(match, `rule "${selector}" not found`).not.toBeNull();
  const open = src.indexOf('{', match!.index!);
  const close = src.indexOf('}', open);
  return src.slice(open + 1, close);
}

describe('peer pane paint order', () => {
  it('.video-el is positioned so it paints above the filmstrip overlay', () => {
    const block = ruleBlock(roomViewSrc, '.video-el');
    expect(block).toContain('position: relative');
    expect(block).not.toMatch(/^\s*z-index\s*:/m);
  });

  it('peer-filmstrip host stays positioned with no explicit z-index', () => {
    const block = ruleBlock(filmstripSrc, ':host');
    expect(block).toContain('position: absolute');
    expect(block).not.toMatch(/^\s*z-index\s*:/m);
  });
});
