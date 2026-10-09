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
 *   content = fill | peer        (default fill) — `peer` gives tile 0 the
 *            in-flow content stack of RoomView._renderPeerTile instead of
 *            the flat fill, and exposes `harness.peerTile` to drive it
 *            through the WebRTC establishment states. See peerTileContent.
 */
import { PresenceApp } from '../src/presence-app';
import { RoomContainer } from '../src/room/room-container';
import { RoomView } from '../src/room/room-view';
import { bestColumns, GRID_TOOLBAR_RESERVE } from '../src/room/layout';
import { bindVideoStream } from '../src/room/video-bind';
import { describePeerTile } from '../src/peer-tile-policy';
import type { PeerTileInputs } from '../src/peer-tile-policy';

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
// content=peer: tile 0 carries the real peer-tile content stack (see
// peerTileContent) so the tile's automatic minimum height is driven by the
// same in-flow children the live tile has. Default `fill` keeps the flat
// fill the layout invariants were written against.
const content = params.get('content') ?? 'fill';
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
  expectAspect: number,
  inner?: string
): string {
  const cls = ['video-container', ...classes].join(' ');
  const body = inner ?? `<div class="harness-fill">${label}</div>`;
  const peerAttr = inner ? ' data-peer-tile' : '';
  return `<div class="${cls}" data-tile data-role="${role}" data-aspect="${expectAspect}"${peerAttr}>
    ${body}
  </div>`;
}

/**
 * The IN-FLOW content stack of one peer tile, mirroring
 * RoomView._renderPeerTile (src/room/room-view.ts) child by child, in
 * document order, with the same inline styles the template writes. Only
 * in-flow children can feed the tile's content-based automatic minimum
 * height, so that is where fidelity matters:
 *
 *   avatar-with-nickname   in-flow, `width: 35%`; hidden iff the policy's
 *                          `background !== 'avatar'` (filmstrip
 *                          inactive here). Stand-in:
 *                          a 35%-wide square, the profile-image branch
 *                          (`img { width:100%; height:auto }`). The
 *                          identicon branch is a fixed 40px
 *                          `holo-identicon`, taller than the 35% square
 *                          below ~115px tile width; immaterial to the
 *                          pin, since the avatar never shares the flow
 *                          with the video.
 *   peer-filmstrip         host is position:absolute (its :host rule);
 *                          out of flow. Stand-in keeps that positioning.
 *   video.video-el         in-flow when the policy's `background ===
 *                          'video'` (`display:none` otherwise);
 *                          `.video-el { width:100%; height:100% }` from
 *                          the real sheet.
 *   .tile-status           in-flow div (`_renderTileStatusLine`), real
 *                          `.tile-status*` classes, present iff the
 *                          policy returns a `statusLine`; rendered after
 *                          the video, outside the `conn` conditional.
 *   .tile-meta             position:absolute bottom rows (30px icon row +
 *                          4px margin, 36px avatar row); out of flow.
 *
 * Visibility and copy come from the REAL `describePeerTile`
 * (src/peer-tile-policy.ts) over each state's inputs, so a state here is
 * one render of the live template's in-flow stack.
 *
 * Not mirrored: the module-replace content and the connection-details
 * block — both position:absolute in the template.
 * The two custom elements are stand-ins because the real ones need a
 * profiles context / streams store the harness does not construct.
 */
function peerTileContent(): string {
  return `
    <div data-avatar style="width: 35%;">
      <div style="width: 100%; aspect-ratio: 1 / 1; border-radius: 50%; background: #556;"></div>
    </div>
    <div data-filmstrip style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%; pointer-events: none;"></div>
    <video data-video class="video-el" style="display: none;" muted playsinline></video>
    <div data-status class="tile-status" style="display: none;"></div>
    <div class="tile-meta" style="display: flex; flex-direction: column; align-items: center; position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); background: none; white-space: nowrap;">
      <div style="height: 30px; margin-bottom: 4px; width: 60px;"></div>
      <div style="height: 36px; width: 60px;"></div>
    </div>`;
}

function peopleTiles(count: number): string {
  const layout = layoutClass(count);
  const shapeCls = isRect ? 'square-view' : '';
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const inner = content === 'peer' && i === 0 ? peerTileContent() : undefined;
    out += tile(
      `${i + 1}`,
      [layout, shapeCls].filter(Boolean),
      'person',
      aspect,
      inner
    );
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

// ---- content=peer: drive tile 0 through the WebRTC establishment states ----
//
// Each state is a `PeerTileInputs` snapshot — the slot shapes are the
// ones the store writes to `_openConnections[peer]` (src/media-links.ts)
// and the rest are what `StreamsStore.peerTileFor` gathers. The real
// `describePeerTile` turns it into background + status line, and the
// stack's visibility follows with the SAME expressions
// RoomView._renderPeerTile uses, so a state here is one render of the
// live template.
//
// The oval-prone states are the ones where a visible <video> and a
// status line are in flow together: since the peer-tile round that is
// the spec's row 1k (slot still `connected` through ICE recovery, the
// frozen track shown, audio down) — `video-with-wait-line` and
// `video-with-act-line`. `video-before-connected`, the state the
// original field report came from, no longer shows the <video> at all
// (the policy requires `connected`), and is kept as the control.
const TILE_NOW = 1_000_000;
const TILE_BASE: PeerTileInputs = {
  webrtcExpected: true,
  audioLink: 'signals',
  peerMicMuted: false,
  peerCameraOn: true,
  slot: undefined,
  filmstripLive: false,
  audioSilentSince: undefined,
  videoSilentSince: undefined,
  qualityBucket: undefined,
  reconnectAvailable: false,
  now: TILE_NOW,
};
type PeerTileState =
  | 'no-conn' // no slot, audio over signals: avatar, no line
  | 'establishing-silent' // slot, not connected, silent past grace: avatar + wait line
  | 'video-before-connected' // video && !connected: avatar (video hidden), no line
  | 'connected-video-track-muted' // track arrived muted: avatar + "connecting video…"
  | 'connected-video' // connected && video: <video> only
  | 'video-with-wait-line' // row 1k: <video> + "no audio — reconnecting…"
  | 'video-with-act-line'; // row 1k past the act threshold: <video> + the act line

const PEER_STATES: Record<PeerTileState, Partial<PeerTileInputs>> = {
  'no-conn': {},
  'establishing-silent': {
    slot: { connected: false, video: false },
    audioLink: 'negotiating',
    audioSilentSince: TILE_NOW - 3_000,
    reconnectAvailable: true,
  },
  'video-before-connected': { slot: { connected: false, video: true } },
  'connected-video-track-muted': {
    slot: { connected: true, video: true, videoMuted: true },
    audioLink: 'webrtc',
  },
  'connected-video': { slot: { connected: true, video: true }, audioLink: 'webrtc' },
  'video-with-wait-line': {
    slot: { connected: true, video: true },
    audioLink: 'down',
    audioSilentSince: TILE_NOW - 3_000,
    reconnectAvailable: true,
  },
  'video-with-act-line': {
    slot: { connected: true, video: true },
    audioLink: 'down',
    audioSilentSince: TILE_NOW - 31_000,
    reconnectAvailable: true,
  },
};

interface PeerTileMeasure {
  state: PeerTileState;
  tile: { width: number; height: number };
  video: { shown: boolean; width: number; height: number };
  /** summed heights of the in-flow children currently displayed */
  inFlow: number;
  lines: string[];
}

let peerStream: MediaStream | null = null;
function peerVideoStream(): MediaStream {
  if (peerStream) return peerStream;
  // A 4:3 source, like a 640x480 camera: the shape a real remote stream
  // would give the <video> if its percentage height ever fell back to the
  // intrinsic ratio.
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#2a6';
    ctx.fillRect(0, 0, 640, 480);
  }
  peerStream = canvas.captureStream(5);
  return peerStream;
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => {
      if (left <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => step(left - 1));
    };
    step(n);
  });
}

function peerTileEls() {
  const tileEl = rvShadow.querySelector('[data-peer-tile]') as HTMLElement | null;
  if (!tileEl) throw new Error('content=peer not active');
  const q = (sel: string) => tileEl.querySelector(sel) as HTMLElement;
  return {
    tileEl,
    avatar: q('[data-avatar]'),
    video: q('[data-video]') as HTMLVideoElement,
    status: q('[data-status]'),
  };
}

let peerState: PeerTileState = 'no-conn';

async function setPeerTileState(state: PeerTileState): Promise<PeerTileMeasure> {
  const tile = describePeerTile({ ...TILE_BASE, ...PEER_STATES[state] });
  const { avatar, video, status } = peerTileEls();
  peerState = state;

  // Mirrors _renderPeerTile's `avatarHidden` (filmstrip inactive):
  // `filmstripActive || tile.background !== 'avatar'`.
  avatar.style.display = tile.background !== 'avatar' ? 'none' : '';

  // Mirrors `style="${tile.background === 'video' ? '' : 'display: none;'}"`.
  const videoShown = tile.background === 'video';
  video.style.display = videoShown ? '' : 'none';
  if (videoShown) {
    const stream = peerVideoStream();
    const bound = bindVideoStream(video, stream, 'ensure');
    if (bound.action === 'bound' && video.readyState < 1) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        video.addEventListener(
          'loadedmetadata',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      });
    }
  }

  // Mirrors _renderTileStatusLine: copy and attention only from the policy.
  status.textContent = tile.statusLine ?? '';
  status.style.display = tile.statusLine ? '' : 'none';
  status.className =
    tile.attention === 'act'
      ? 'tile-status tile-status-act'
      : tile.attention === 'wait'
        ? 'tile-status tile-status-wait'
        : 'tile-status';

  await nextFrames(2);
  return measurePeerTile();
}

function measurePeerTile(): PeerTileMeasure {
  const { tileEl, avatar, video, status } = peerTileEls();
  const tr = tileEl.getBoundingClientRect();
  const vr = video.getBoundingClientRect();
  const inFlowEls = [avatar, video, status].filter(
    (el) => el.style.display !== 'none'
  );
  const inFlow = inFlowEls.reduce(
    (sum, el) => sum + el.getBoundingClientRect().height,
    0
  );
  const lines = [status]
    .filter((el) => el.style.display !== 'none')
    .map((el) => el.textContent?.trim() ?? '');
  return {
    state: peerState,
    tile: { width: tr.width, height: tr.height },
    video: {
      shown: video.style.display !== 'none',
      width: vr.width,
      height: vr.height,
    },
    inFlow,
    lines,
  };
}

(window as unknown as Record<string, unknown>).harness = {
  relayout,
  measure,
  expectedAspect: aspect,
  peerTile:
    content === 'peer'
      ? { setState: setPeerTileState, measure: measurePeerTile, states: Object.keys(PEER_STATES) }
      : undefined,
};
