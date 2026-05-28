/**
 * Standalone layout harness — renders the video-tile grid with the EXACT CSS
 * and column math used by the live room, but with fake tiles and no Holochain.
 *
 * Fidelity is the whole point. Earlier this mounted .videos-container in a
 * pinned `position:fixed; inset:0` box, which silently gave the grid a bounded
 * height the real app does not have — so it could not reproduce the live
 * overflow. This version reproduces the real ancestor chain instead:
 *
 *     <presence-app host>           :host height:100vh; flex column; center
 *       <div.room-container host>   .room-container { display:flex; flex:1 }
 *         <room-view host>          :host flex column; flex:1; min-height:0
 *           .videos-container ...
 *
 * Each layer is a real shadow host with the REAL adopted stylesheets
 * (PresenceApp.styles / RoomContainer.styles / RoomView.styles), nested exactly
 * as production nests the custom elements. The only thing faked is leaf content
 * (tiles) — the height-constraint chain is identical, so a broken chain breaks
 * here too. Column choice uses the same bestColumns + document measurement as
 * the live `_updateGrid`.
 *
 * URL params:
 *   mode   = grid | split        (default grid)
 *   shape  = circle | rect       (default circle)
 *   n      = people tile count   (default 2)
 *   shares = screen-share count  (default 1, split mode only)
 *   split  = split ratio %       (default 50, split mode only)
 */
import { PresenceApp } from '../src/presence-app';
import { RoomContainer } from '../src/room/room-container';
import { RoomView } from '../src/room/room-view';
import { bestColumns, GRID_TOOLBAR_RESERVE } from '../src/room/layout';

type Mode = 'grid' | 'split';

interface PaneReport {
  role: string;
  clientW: number;
  clientH: number;
  scrollW: number;
  scrollH: number;
  scrollbar: boolean;
}
interface TileReport {
  index: number;
  pane: string;
  role: string;
  expectAspect: number;
  left: number;
  top: number;
  width: number;
  height: number;
  aspect: number;
  overflow: number; // px past the immediate pane content box
  windowOverflow: number; // px past the visible window (documentElement)
}
interface HarnessReport {
  mode: Mode;
  shape: string;
  n: number;
  shares: number;
  cols: number;
  rows: number;
  // The document-derived size that the live _updateGrid feeds to bestColumns.
  measuredW: number;
  measuredH: number;
  // Height-constraint chain — proves whether each host is viewport-bounded
  // (offsetH ≈ viewport) or content-driven (scrollH >> clientH = unbounded).
  chain: {
    viewportH: number;
    appHostH: number;
    rcHostH: number;
    rvHostH: number;
    containerClientH: number;
    containerScrollH: number;
  };
  panes: PaneReport[];
  tiles: TileReport[];
}

const params = new URLSearchParams(location.search);
const mode = (params.get('mode') as Mode) ?? 'grid';
const shape = params.get('shape') ?? 'circle';
const n = Math.max(1, parseInt(params.get('n') ?? '2', 10));
const shares = Math.max(1, parseInt(params.get('shares') ?? '1', 10));
const splitRatio = parseFloat(params.get('split') ?? '50');
// bound=viewport (default): host height pinned to 100vh, like a top-level
// document. bound=content: drop that pin so the height chain is content-driven
// — reproduces what a nested/seamless embedder does, where cqh resolves against
// an over-tall container and tiles overflow the visible window.
const bound = params.get('bound') ?? 'viewport';
const isRect = shape === 'rect';
const aspect = isRect ? 16 / 9 : 1;

// Flatten a Lit `static styles` array into adoptable CSSStyleSheets.
function sheetsOf(cls: { styles?: unknown }): CSSStyleSheet[] {
  const styles = (cls.styles ?? []) as unknown[];
  return styles
    .flat()
    .map((s) => (s as { styleSheet?: CSSStyleSheet }).styleSheet)
    .filter((s): s is CSSStyleSheet => !!s);
}

function adopt(host: HTMLElement, cls: { styles?: unknown }): ShadowRoot {
  const sr = host.attachShadow({ mode: 'open' });
  sr.adoptedStyleSheets = sheetsOf(cls);
  return sr;
}

// ---- Reproduce the real ancestor chain ----
// Layer 1: stand-in for <presence-app> (real :host rules size it to 100vh).
const appHost = document.createElement('div');
appHost.setAttribute('style', 'display:flex; flex:1');
document.body.appendChild(appHost);
const appShadow = adopt(appHost, PresenceApp);

// Layer 2: stand-in for <room-container> — gets .room-container from the
// PresenceApp sheet (display:flex; flex:1; width:100%), exactly as production.
const rcHost = document.createElement('div');
rcHost.className = 'room-container';
appShadow.appendChild(rcHost);
const rcShadow = adopt(rcHost, RoomContainer);

// Layer 3: stand-in for <room-view> (its :host flex column / flex:1).
const rvHost = document.createElement('div');
rcShadow.appendChild(rvHost);
const rvShadow = adopt(rvHost, RoomView);

// Simulate an embedder that does not bound the app's height: inline style on
// the host beats the adopted `:host { height: 100vh }`, so the whole chain
// becomes content-driven and cqh stops tracking the visible window.
if (bound === 'content') {
  appHost.style.height = 'auto';
  appHost.style.minHeight = '0';
}

// vh=<px>: force the host to a definite height that differs from the visible
// window — simulates a nested iframe reporting 100vh/clientHeight taller than
// the actual pane (the documented unreliable-measurement case). With a value
// larger than the viewport this reproduces the live "tiles too big, window
// scrolls" overflow (distinct from the contain:size collapse of bound=content).
const vhOverride = params.get('vh');
if (vhOverride) {
  appHost.style.height = `${parseInt(vhOverride, 10)}px`;
}

// forceScroll=1: pin a vertical scrollbar on the grid (overflow-y:scroll) to
// reproduce the live "stuck scrollbar" state, where the scrollbar steals width
// but the container-query width the tiles size against does not shrink to
// match — so cols tiles no longer fit one row and flex-wrap stacks them.
if (params.get('forceScroll') === '1') {
  const c = rvShadow.querySelector('.videos-container') as HTMLElement | null;
  if (c) c.style.overflowY = 'scroll';
  // Headless Chromium uses 0-width overlay scrollbars; styling the webkit
  // pseudo forces a classic, space-stealing scrollbar (~14px) like Linux
  // hc-spin, so the width-steal that broke flex-wrap is reproducible here.
  const sb = document.createElement('style');
  sb.textContent = `
    .videos-container::-webkit-scrollbar { width: 14px; height: 14px; }
    .videos-container::-webkit-scrollbar-thumb { background: #666; }
  `;
  rvShadow.appendChild(sb);
}

// Mirror RoomView.idToLayout's count -> class mapping (split mode relies on it).
function layoutClass(num: number): string {
  if (num === 1) return 'single';
  if (num <= 2) return 'double';
  if (num === 3) return 'triplett';
  if (num <= 4) return 'quartett';
  if (num <= 6) return 'sextett';
  if (num <= 8) return 'octett';
  return 'unlimited';
}

function tile(
  label: string,
  classes: string[],
  role: 'person' | 'share',
  expectAspect: number
): string {
  const cls = ['video-container', ...classes].join(' ');
  return `<div class="${cls}" data-tile data-role="${role}" data-aspect="${expectAspect}">
    <div class="harness-fill">${label}</div>
  </div>`;
}

function peopleTiles(count: number): string {
  const layout = layoutClass(count);
  const shapeCls = isRect ? 'square-view' : '';
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += tile(`${i + 1}`, [layout, shapeCls].filter(Boolean), 'person', aspect);
  }
  return out;
}

function shareTiles(count: number): string {
  const layout = layoutClass(count);
  // Screen shares letterbox 16:9 content via object-fit:contain, so the
  // container aspect is intentionally free; tagged 'share' to skip aspect.
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += tile(`S${i + 1}`, ['screen-share', layout], 'share', 16 / 9);
  }
  return out;
}

function buildGrid(): string {
  // Mirror the real render(): tiles live inside a display:contents wrapper
  // (.layout-transparent), so they participate in the grid as if direct
  // children but :last-child / direct-child selectors see the wrapper. Without
  // this wrapper the harness gave a false positive on last-row centering.
  return `
    <div class="row center-content room-name">Main Room</div>
    <div class="videos-container auto-grid" data-pane="videos-container">
      <div class="layout-transparent">
        ${peopleTiles(n)}
      </div>
    </div>`;
}

function buildSplit(): string {
  return `
    <div class="row center-content room-name">Main Room</div>
    <div class="videos-container split-mode" data-pane="videos-container">
      <div class="screen-share-panel" data-pane="screen-share-panel"
           style="flex-basis:${splitRatio}%">
        ${shareTiles(shares)}
      </div>
      <div class="resize-handle"></div>
      <div class="people-panel" data-pane="people-panel">
        ${peopleTiles(n)}
      </div>
    </div>`;
}

rvShadow.innerHTML = mode === 'split' ? buildSplit() : buildGrid();

// A little fill so tiles are visible in screenshots without a real <video>.
const fillStyle = document.createElement('style');
fillStyle.textContent = `
  .harness-fill {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    color: #ffe100; font: 600 20px sans-serif;
    background: repeating-linear-gradient(45deg,#1b1f33,#1b1f33 10px,#232846 10px,#232846 20px);
  }
`;
rvShadow.appendChild(fillStyle);

let lastCols = 1;
let lastRows = 1;
let measuredW = 0;
let measuredH = 0;

/**
 * Re-run the production column math. Mirrors RoomView._updateGrid exactly:
 * measures document.documentElement (NOT the container) and reserves the
 * toolbar strip — so the harness chooses the same column count the live app
 * would for the same window size.
 */
function relayout(): void {
  if (mode !== 'grid') return;
  const container = rvShadow.querySelector(
    '.videos-container'
  ) as HTMLElement | null;
  if (!container) return;
  const doc = document.documentElement;
  const W = doc.clientWidth;
  const headerHeight = Math.max(
    0,
    container.getBoundingClientRect().top + window.scrollY
  );
  const H = Math.max(0, doc.clientHeight - headerHeight - GRID_TOOLBAR_RESERVE);
  measuredW = W;
  measuredH = H;
  const cols = bestColumns(W, H, n, aspect);
  const rows = Math.ceil(n / cols);
  lastCols = cols;
  lastRows = rows;
  container.style.setProperty('--cols', `${cols}`);
  container.style.setProperty('--rows', `${rows}`);
  container.style.setProperty('--tile-aspect', isRect ? '1.7778' : '1');
  container.style.setProperty('--tile-min', '60px');
  // Match room-view: when the last row holds a single item, let it span the
  // row so justify-items:center centers it across the columns above.
  const lastK = ((n - 1) % cols) + 1;
  const lastSpans = lastK === 1 && cols > 1 ? cols : 1;
  container.style.setProperty('--last-spans', `${lastSpans}`);
}

/** Read back exact geometry for assertions / screenshots. */
function measure(): HarnessReport {
  const paneEls = Array.from(
    rvShadow.querySelectorAll('[data-pane]')
  ) as HTMLElement[];
  const panes: PaneReport[] = paneEls.map((el) => ({
    role: el.dataset.pane ?? 'unknown',
    clientW: el.clientWidth,
    clientH: el.clientHeight,
    scrollW: el.scrollWidth,
    scrollH: el.scrollHeight,
    scrollbar:
      el.scrollWidth > el.clientWidth + 1 ||
      el.scrollHeight > el.clientHeight + 1,
  }));

  const vpW = document.documentElement.clientWidth;
  const vpH = document.documentElement.clientHeight;

  const tileEls = Array.from(
    rvShadow.querySelectorAll('[data-tile]')
  ) as HTMLElement[];
  const tiles: TileReport[] = tileEls.map((el, index) => {
    const paneEl = (el.closest('[data-pane]') as HTMLElement) ?? rvHost;
    const pr = paneEl.getBoundingClientRect();
    const tr = el.getBoundingClientRect();
    const paneLeft = pr.left + paneEl.clientLeft;
    const paneTop = pr.top + paneEl.clientTop;
    const paneRight = paneLeft + paneEl.clientWidth;
    const paneBottom = paneTop + paneEl.clientHeight;
    const overflow = Math.max(
      0,
      paneLeft - tr.left,
      paneTop - tr.top,
      tr.right - paneRight,
      tr.bottom - paneBottom
    );
    // Overflow past the visible window — the real "tiles must stay inside the
    // pane if they could be shrunk to fit" invariant. Catches the embedding
    // failure where the pane itself grows past the window with the tiles.
    const windowOverflow = Math.max(
      0,
      -tr.left,
      -tr.top,
      tr.right - vpW,
      tr.bottom - vpH
    );
    return {
      index,
      pane: paneEl.dataset?.pane ?? 'root',
      role: el.dataset.role ?? 'person',
      expectAspect: parseFloat(el.dataset.aspect ?? '1'),
      left: tr.left - paneLeft,
      top: tr.top - paneTop,
      width: tr.width,
      height: tr.height,
      aspect: tr.height > 0 ? tr.width / tr.height : 0,
      overflow,
      windowOverflow,
    };
  });

  const container = rvShadow.querySelector(
    '.videos-container'
  ) as HTMLElement | null;

  return {
    mode,
    shape,
    n,
    shares,
    cols: lastCols,
    rows: lastRows,
    measuredW,
    measuredH,
    chain: {
      viewportH: document.documentElement.clientHeight,
      appHostH: appHost.getBoundingClientRect().height,
      rcHostH: rcHost.getBoundingClientRect().height,
      rvHostH: rvHost.getBoundingClientRect().height,
      containerClientH: container?.clientHeight ?? 0,
      containerScrollH: container?.scrollHeight ?? 0,
    },
    panes,
    tiles,
  };
}

relayout();
window.addEventListener('resize', () => relayout());

(window as unknown as Record<string, unknown>).harness = {
  relayout,
  measure,
  expectedAspect: aspect,
};
