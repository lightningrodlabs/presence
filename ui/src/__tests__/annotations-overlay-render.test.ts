// ui/src/__tests__/annotations-overlay-render.test.ts
// @vitest-environment jsdom
/**
 * The share-annotations overlay element over a fake store (spec
 * "Rendering"). Same style as intent-diff-surfaces.test.ts: a real Lit
 * element, mounted into a frame, driven through its public properties.
 * The pure decisions are table-tested in annotation-policy.test.ts and
 * annotation-geometry.test.ts; here we pin what the element does with
 * them: the strip, the pen gate, the SVG placement and the one write.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { writable } from '@holochain-open-dev/stores';
import '../room/modules';
import { ModuleAnnotationsShareOverlay } from '../room/modules/annotations';
import {
  ANNOTATION_PALETTE,
  ANNOTATIONS_MODULE_ID,
  emptyAnnotations,
  applyStroke,
} from '../room/annotation-policy';
import type { AnnotationsPayload } from '../room/annotation-policy';

const ME = 'uhCAkme';
const SHARER = 'uhCAksharer';
const PEER = 'uhCAkpeer';
const EPOCH = 7;

const env = (moduleId: string, payload: object | string, active = true) => ({
  moduleId,
  active,
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  updatedAt: 1,
});

function makeStore(opts: { mine?: Record<string, unknown>; peers?: Record<string, Record<string, unknown>> } = {}) {
  return {
    _myModuleStates: writable(opts.mine ?? {}),
    _peerModuleStates: writable(opts.peers ?? {}),
    clock: { now: () => 5000 },
    updateModuleState: vi.fn(async (_moduleId: string, _payload: string) => {}),
    clearShareAnnotations: vi.fn(async () => {}),
  };
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const f of mounted.splice(0)) f.remove();
});

async function mount(opts: {
  isMe: boolean;
  shareModuleId: string;
  store: ReturnType<typeof makeStore>;
  video?: { w: number; h: number } | null;
}): Promise<ModuleAnnotationsShareOverlay> {
  const frame = document.createElement('div');
  if (opts.video !== undefined) {
    const v = document.createElement('video');
    Object.defineProperty(v, 'videoWidth', { value: opts.video?.w ?? 0, configurable: true });
    Object.defineProperty(v, 'videoHeight', { value: opts.video?.h ?? 0, configurable: true });
    frame.appendChild(v);
  }
  const el = document.createElement('module-annotations-share-overlay') as ModuleAnnotationsShareOverlay;
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
  el.sharerPubKeyB64 = SHARER;
  el.shareModuleId = opts.shareModuleId;
  el.context = {
    isMe: opts.isMe,
    connected: true,
    circleView: false,
    streamsStore: opts.store as any,
    myPubKeyB64: ME,
  };
  frame.appendChild(el);
  document.body.appendChild(frame);
  mounted.push(frame);
  await el.updateComplete;
  return el;
}

const q = (el: Element, sel: string) => el.shadowRoot!.querySelector(sel);
const qa = (el: Element, sel: string) => Array.from(el.shadowRoot!.querySelectorAll(sel));

const pointer = (target: Element, type: string, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true }));

const drawSquare = (el: Element) => {
  const canvas = q(el, '.canvas')!;
  pointer(canvas, 'pointerdown', 10, 10);
  pointer(canvas, 'pointermove', 200, 10);
  pointer(canvas, 'pointermove', 200, 200);
  pointer(canvas, 'pointerup', 10, 200);
};

const sharerStates = (shareModuleId: string, extraMine: Record<string, unknown> = {}) => ({
  mine: { [shareModuleId]: env(shareModuleId, { annotationsEpoch: EPOCH }), ...extraMine },
});

const viewerStates = (shareModuleId: string, extraMine: Record<string, unknown> = {}, peerAnnotations?: AnnotationsPayload) => ({
  mine: extraMine,
  peers: {
    [SHARER]: { [shareModuleId]: env(shareModuleId, { annotationsEpoch: EPOCH }) },
    ...(peerAnnotations ? { [PEER]: { [ANNOTATIONS_MODULE_ID]: env(ANNOTATIONS_MODULE_ID, peerAnnotations) } } : {}),
  },
});

describe('the tool strip', () => {
  it('renders clear-all only on the sharer\'s own tile', async () => {
    const own = await mount({ isMe: true, shareModuleId: 'wal', store: makeStore(sharerStates('wal')) });
    expect(q(own, '.clear-all')).not.toBeNull();
    const theirs = await mount({ isMe: false, shareModuleId: 'wal', store: makeStore(viewerStates('wal')) });
    expect(q(theirs, '.clear-all')).toBeNull();
  });

  it('clear-all calls the store with the share module id', async () => {
    const store = makeStore(sharerStates('wal'));
    const own = await mount({ isMe: true, shareModuleId: 'wal', store });
    (q(own, '.clear-all') as HTMLElement).click();
    expect(store.clearShareAnnotations).toHaveBeenCalledWith('wal');
  });

  it('the pen toggles the reflected `pen` attribute and shows the palette only while on', async () => {
    const el = await mount({ isMe: false, shareModuleId: 'wal', store: makeStore(viewerStates('wal')) });
    expect(el.hasAttribute('pen')).toBe(false);
    expect(qa(el, '.swatch')).toHaveLength(0);
    (q(el, '.pen') as HTMLElement).click();
    await el.updateComplete;
    expect(el.hasAttribute('pen')).toBe(true);
    expect(qa(el, '.swatch')).toHaveLength(ANNOTATION_PALETTE.length);
  });

  it('the stylesheet gates pointer capture on the pen attribute (source pin)', () => {
    const css = (ModuleAnnotationsShareOverlay.styles as { cssText: string }).cssText.replace(/\s+/g, ' ');
    expect(css).toMatch(/\.canvas \{[^}]*pointer-events: none/);
    expect(css).toMatch(/:host\(\[pen\]\) \.canvas \{[^}]*pointer-events: auto/);
    expect(css).toMatch(/:host\(\[pen\]\) \.canvas \{[^}]*touch-action: none/);
  });

  it('the strip clears the maximize icon (source pin)', () => {
    const css = (ModuleAnnotationsShareOverlay.styles as { cssText: string }).cssText.replace(/\s+/g, ' ');
    // room-view's .maximize-icon covers x 5-45px at the bottom-left; the strip starts at 55px.
    expect(css).toMatch(/\.strip \{[^}]*left: 55px/);
    expect(css).toMatch(/\.strip \{[^}]*flex-wrap: wrap/);
  });
});

describe('the surface', () => {
  it('a wal tile draws over the whole tile and needs no video', async () => {
    const el = await mount({ isMe: false, shareModuleId: 'wal', store: makeStore(viewerStates('wal')) });
    const svg = q(el, 'svg.board') as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.style.left).toBe('0px');
    expect(svg.style.width).toBe('400px');
    expect(svg.style.height).toBe('300px');
    expect((q(el, '.pen') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a screen-share tile draws over the contained video box', async () => {
    const el = await mount({
      isMe: false,
      shareModuleId: 'screen-share',
      store: makeStore(viewerStates('screen-share')),
      video: { w: 1600, h: 900 },
    });
    const svg = q(el, 'svg.board') as SVGElement;
    expect(svg.style.top).toBe('37.5px');
    expect(svg.style.width).toBe('400px');
    expect(svg.style.height).toBe('225px');
  });

  it('a screen-share tile without video metadata disables the pen and ignores drawing (Review Focus 3)', async () => {
    const store = makeStore(viewerStates('screen-share'));
    const el = await mount({ isMe: false, shareModuleId: 'screen-share', store, video: { w: 0, h: 0 } });
    expect(q(el, 'svg.board')).toBeNull();
    expect((q(el, '.pen') as HTMLButtonElement).disabled).toBe(true);
    el.pen = true;
    await el.updateComplete;
    drawSquare(el);
    expect(store.updateModuleState).not.toHaveBeenCalled();
  });

  it('loadedmetadata on the video re-measures', async () => {
    const store = makeStore(viewerStates('screen-share'));
    const el = await mount({ isMe: false, shareModuleId: 'screen-share', store, video: { w: 0, h: 0 } });
    const video = el.parentElement!.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 1600, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 900, configurable: true });
    video.dispatchEvent(new Event('loadedmetadata'));
    await el.updateComplete;
    expect(q(el, 'svg.board')).not.toBeNull();
  });
});

describe('strokes', () => {
  const mine = applyStroke(emptyAnnotations(), SHARER, 'screen-share', { id: 'm', epoch: EPOCH, color: 0, pts: [0, 0, 500, 500] });
  const theirs = applyStroke(
    applyStroke(emptyAnnotations(), SHARER, 'screen-share', { id: 'p', epoch: EPOCH, color: 3, pts: [0, 0, 900, 900] }),
    SHARER,
    'screen-share',
    { id: 'stale', epoch: EPOCH - 1, color: 5, pts: [0, 0, 100, 100] },
  );
  const wal = applyStroke(emptyAnnotations(), SHARER, 'wal', { id: 'w', epoch: EPOCH, color: 2, pts: [0, 0, 100, 100] });

  it('renders every author\'s current-epoch strokes in their palette colors and nothing stale', async () => {
    const store = makeStore(
      viewerStates('screen-share', { [ANNOTATIONS_MODULE_ID]: env(ANNOTATIONS_MODULE_ID, mine) }, theirs),
    );
    const el = await mount({ isMe: false, shareModuleId: 'screen-share', store, video: { w: 1600, h: 900 } });
    const lines = qa(el, 'polyline.stroke');
    expect(lines.map(l => l.getAttribute('data-author'))).toEqual([ME, PEER]);
    expect(lines.map(l => l.getAttribute('stroke'))).toEqual([ANNOTATION_PALETTE[0], ANNOTATION_PALETTE[3]]);
    expect(lines[0].getAttribute('points')).toBe('0,0 500,500');
  });

  it('keeps one sharer\'s two share tiles apart (Review Focus 4)', async () => {
    const store = makeStore({
      mine: {},
      peers: {
        [SHARER]: {
          'screen-share': env('screen-share', { annotationsEpoch: EPOCH }),
          wal: env('wal', { annotationsEpoch: EPOCH }),
        },
        [PEER]: { [ANNOTATIONS_MODULE_ID]: env(ANNOTATIONS_MODULE_ID, wal) },
      },
    });
    const onScreen = await mount({ isMe: false, shareModuleId: 'screen-share', store, video: { w: 1600, h: 900 } });
    expect(qa(onScreen, 'polyline.stroke')).toHaveLength(0);
    const onWal = await mount({ isMe: false, shareModuleId: 'wal', store });
    expect(qa(onWal, 'polyline.stroke')).toHaveLength(1);
  });

  it('a pen-up writes one thinned stroke under the share epoch in the chosen color', async () => {
    const store = makeStore(viewerStates('wal'));
    const el = await mount({ isMe: false, shareModuleId: 'wal', store });
    (q(el, '.pen') as HTMLElement).click();
    await el.updateComplete;
    (qa(el, '.swatch')[4] as HTMLElement).click();
    await el.updateComplete;
    drawSquare(el);
    expect(store.updateModuleState).toHaveBeenCalledTimes(1);
    const [moduleId, payload] = store.updateModuleState.mock.calls[0] as [string, string];
    expect(moduleId).toBe(ANNOTATIONS_MODULE_ID);
    const strokes = JSON.parse(payload).boards[SHARER]['wal'].strokes;
    expect(strokes).toHaveLength(1);
    expect(strokes[0].epoch).toBe(EPOCH);
    expect(strokes[0].color).toBe(4);
    expect(strokes[0].pts).toEqual([250, 333, 5000, 333, 5000, 6667, 250, 6667]);
  });

  it('negative control: with the pen off a pointer sequence writes nothing', async () => {
    const store = makeStore(viewerStates('wal'));
    const el = await mount({ isMe: false, shareModuleId: 'wal', store });
    drawSquare(el);
    expect(store.updateModuleState).not.toHaveBeenCalled();
  });

  it('pointercancel discards the in-progress stroke (Review Focus 2)', async () => {
    const store = makeStore(viewerStates('wal'));
    const el = await mount({ isMe: false, shareModuleId: 'wal', store });
    el.pen = true;
    await el.updateComplete;
    const canvas = q(el, '.canvas')!;
    pointer(canvas, 'pointerdown', 10, 10);
    pointer(canvas, 'pointermove', 200, 200);
    canvas.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    pointer(canvas, 'pointerup', 300, 300);
    expect(store.updateModuleState).not.toHaveBeenCalled();
  });

  it('a right-button press starts no stroke', async () => {
    const store = makeStore(viewerStates('wal'));
    const el = await mount({ isMe: false, shareModuleId: 'wal', store });
    el.pen = true;
    await el.updateComplete;
    const canvas = q(el, '.canvas')!;
    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 2, bubbles: true, composed: true }));
    pointer(canvas, 'pointermove', 200, 200);
    pointer(canvas, 'pointerup', 300, 300);
    expect(store.updateModuleState).not.toHaveBeenCalled();
  });

  it('a second pointer does not alter the primary stroke', async () => {
    const secondary = (target: Element, type: string, x: number, y: number) => {
      const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, composed: true });
      Object.defineProperty(ev, 'isPrimary', { value: false });
      target.dispatchEvent(ev);
    };
    const run = async (withSecond: boolean) => {
      const store = makeStore(viewerStates('wal'));
      const el = await mount({ isMe: false, shareModuleId: 'wal', store });
      el.pen = true;
      await el.updateComplete;
      const canvas = q(el, '.canvas')!;
      pointer(canvas, 'pointerdown', 10, 10);
      pointer(canvas, 'pointermove', 200, 10);
      if (withSecond) {
        secondary(canvas, 'pointerdown', 350, 250);
        secondary(canvas, 'pointermove', 380, 280);
        secondary(canvas, 'pointerup', 390, 290);
      }
      pointer(canvas, 'pointermove', 200, 200);
      pointer(canvas, 'pointerup', 10, 200);
      expect(store.updateModuleState).toHaveBeenCalledTimes(1);
      return JSON.parse((store.updateModuleState.mock.calls[0] as [string, string])[1]).boards[SHARER]['wal'].strokes[0].pts;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('a stroke of one point writes nothing', async () => {
    const store = makeStore(viewerStates('wal'));
    const el = await mount({ isMe: false, shareModuleId: 'wal', store });
    el.pen = true;
    await el.updateComplete;
    const canvas = q(el, '.canvas')!;
    pointer(canvas, 'pointerdown', 10, 10);
    pointer(canvas, 'pointerup', 10, 10);
    expect(store.updateModuleState).not.toHaveBeenCalled();
  });

  it('undo and clear-mine write the reduced board', async () => {
    const store = makeStore(viewerStates('wal', { [ANNOTATIONS_MODULE_ID]: env(ANNOTATIONS_MODULE_ID, applyStroke(applyStroke(emptyAnnotations(), SHARER, 'wal', { id: 'a', epoch: EPOCH, color: 0, pts: [0, 0, 1, 1] }), SHARER, 'wal', { id: 'b', epoch: EPOCH, color: 0, pts: [0, 0, 2, 2] })) }));
    const el = await mount({ isMe: false, shareModuleId: 'wal', store });
    (q(el, '.undo') as HTMLElement).click();
    const afterUndo = JSON.parse((store.updateModuleState.mock.calls[0] as [string, string])[1]);
    expect(afterUndo.boards[SHARER]['wal'].strokes.map((s: { id: string }) => s.id)).toEqual(['a']);
    (q(el, '.clear-mine') as HTMLElement).click();
    const afterClear = JSON.parse((store.updateModuleState.mock.calls[1] as [string, string])[1]);
    expect(afterClear).toEqual(emptyAnnotations());
  });

  it('a write prunes boards of shares that are no longer active', async () => {
    const stale = applyStroke(emptyAnnotations(), PEER, 'screen-share', { id: 'z', epoch: 1, color: 0, pts: [0, 0, 1, 1] });
    const store = makeStore(viewerStates('wal', { [ANNOTATIONS_MODULE_ID]: env(ANNOTATIONS_MODULE_ID, stale) }));
    const el = await mount({ isMe: false, shareModuleId: 'wal', store });
    el.pen = true;
    await el.updateComplete;
    drawSquare(el);
    const written = JSON.parse((store.updateModuleState.mock.calls[0] as [string, string])[1]);
    expect(Object.keys(written.boards)).toEqual([SHARER]);
  });

  it('dblclick is stopped while the pen is on and passes through while it is off', async () => {
    const el = await mount({ isMe: false, shareModuleId: 'wal', store: makeStore(viewerStates('wal')) });
    let reached = 0;
    el.parentElement!.addEventListener('dblclick', () => (reached += 1));
    const canvas = q(el, '.canvas')!;
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    expect(reached).toBe(1);
    el.pen = true;
    await el.updateComplete;
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    expect(reached).toBe(1);
  });
});
