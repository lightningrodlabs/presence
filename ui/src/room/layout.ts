/**
 * Pure tile-grid layout math, shared by the live room view and the standalone
 * layout harness so the harness can never drift from production behavior.
 *
 * The grid only commits to a column/row *count*. Actual pixel sizing is done in
 * CSS with container-query units (cqw/cqh) against the real pane, so absolute
 * measurement error (e.g. inside the nested Holochain iframe) cannot make a
 * tile overflow its box. Therefore every function here depends only on the
 * W:H *ratio* of the container, never on absolute pixels.
 */

// Smallest tile width the area-maximizing grid produces before it lets the
// pane scroll (matches the CSS `--tile-min` floor).
export const GRID_MIN_TILE_WIDTH = 60;

// Vertical space reserved at the bottom of the viewport for the fixed toolbar,
// subtracted from the measured height when choosing the grid shape.
export const GRID_TOOLBAR_RESERVE = 84;

// Per-tile margin+border subtracted by the CSS sizing rule (keep in sync with
// the `- 14px` terms in the .auto-grid tile width calc).
export const TILE_GAP_PX = 14;

/**
 * Pick the column count that maximizes tile area for the container's aspect
 * ratio. For each candidate count, lay out ceil(n/cols) rows and find the
 * largest tile of the given aspect ratio that fits a cell; keep the count that
 * yields the biggest tile. Only the ratio of W:H matters here.
 */
export function bestColumns(
  W: number,
  H: number,
  n: number,
  aspect: number
): number {
  if (n <= 1 || W <= 0 || H <= 0) return 1;
  let bestCols = 1;
  let best = 0;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    // Largest tile of the given aspect that fits a cell (gaps are a small
    // constant fraction, irrelevant to the comparison, so ignored here).
    const tileW = Math.min(W / cols, (H / rows) * aspect);
    if (tileW > best) {
      best = tileW;
      bestCols = cols;
    }
  }
  return bestCols;
}

/**
 * The one tile-count rule for the people grid: present peers + phantom
 * placeholders + the own tile, own only when self-view actually occupies
 * a grid slot (hidden self-view is display:none and takes none). Before
 * this function, three room-view sites hand-copied the sum with
 * keep-in-sync comments (_updateGrid, idToLayout, the CSS-var `n`) —
 * PR #4 F7 was exactly one of them drifting on `_selfViewHidden`.
 */
export function gridTileCount(input: {
  visiblePeerCount: number;
  phantomCount: number;
  selfViewHidden: boolean;
}): number {
  return (
    input.visiblePeerCount +
    input.phantomCount +
    (input.selfViewHidden ? 0 : 1)
  );
}

/** Column/row shape for n tiles in a W:H box of the given tile aspect. */
export function gridShape(
  W: number,
  H: number,
  n: number,
  aspect: number
): { cols: number; rows: number } {
  const cols = bestColumns(W, H, n, aspect);
  return { cols, rows: Math.ceil(n / cols) };
}
