# Share Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any participant draws freehand strokes on any share tile and every participant sees them. The strokes travel as the author's own module state over signals.

**Architecture:** A new agent-type module, `annotations`, carries each author's strokes in their own `ModuleState` envelope, keyed by sharer and share module id. A share overlay element mounted into every share tile aggregates all authors' boards and draws them as SVG over the tile's declared drawing surface. The sharer clears the board by stamping a new `annotationsEpoch` into its share payload, and the store stamps that field generically on every share-type activation.

**Tech Stack:** TypeScript, Lit, Svelte stores from `@holochain-open-dev/stores`, vitest (node and per-file jsdom), `@mdi/js` icons.

**Spec:** `docs/superpowers/specs/2026-10-09-screen-share-annotations-design.md`

## Global Constraints

- Branch `feat/screen-share-annotations` off `main-0.7` at `cf7084f`. The spec is committed as `f3dc7f7`.
- Run every test and command through `nix develop -c`. The gate is `nix develop -c npm run verify`.
- Commit messages carry no co-author footer and no Claude attribution.
- No new signal type and no new capability. The wire-contract snapshot, the event taxonomy and the compat corpus do not change.
- Constants: `ANNOTATION_GRID` 10000, `MAX_STROKE_POINTS` 200, `MAX_BOARD_STROKES` 50, `MAX_ANNOTATIONS_PAYLOAD_BYTES` 12288, `MIN_POINT_SPACING` 40. All four policy constants are declared NOT-liveness in their doc comment.
- The module id is `annotations`. The overlay tag is `module-annotations-share-overlay`.
- Pure modules take plain objects and return plain objects. No DOM, no time, no mocks in their tests. `ui/src/transport/media-event-policy.ts` is the template.
- New source files go into `ui/src/__tests__/no-ambient-clock.test.ts`'s `PINNED_FILES` with `FULL_PATTERNS`.
- `ui/src/__tests__/intent-write-sites.test.ts` must stay byte-identical. No new `_applyIntent` call site.
- Prose in code comments cites the file it constrains, per working agreement 3.

## Review Focus

1. A peer sends an `annotations` payload far above the caps. The receiver keeps only the newest `MAX_BOARD_STROKES` per board and drops over-long strokes, so a hostile or buggy sender cannot grow memory or paint time. Pinned in Task 2's parser rows.
2. The pointer is cancelled mid-stroke, for example by a touch gesture or a window blur. The in-progress points are discarded and nothing is written. Pinned in Task 4's render test.
3. A screen-share tile whose video has no metadata yet. The pen button is disabled and a pointer sequence writes nothing. Pinned in Task 4's render test.
4. One sharer runs a screen share and an asset share at once. Each tile keeps its own board, and a clear on one does not touch the other. Pinned in Task 2's `visibleStrokes`/`pruneBoards` rows and Task 4's render test.
5. A peer leaves while their strokes are on a board. Their strokes vanish, because the store drops the peer's module states on leave. Pinned in Task 5's wiring test.

---

### Task 1: Geometry

**Files:**
- Create: `ui/src/room/annotation-geometry.ts`
- Test: `ui/src/__tests__/annotation-geometry.test.ts`
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts` (add the pin)

**Interfaces:**
- Consumes: nothing.
- Produces: `ANNOTATION_GRID: 10000`, `type AnnotationSurfaceKind = 'tile' | 'contained-video'`, `interface SurfaceBox { left; top; width; height }`, `containedVideoBox(tileW, tileH, videoW, videoH): SurfaceBox | null`, `surfaceBox(kind, tileW, tileH, videoW?, videoH?): SurfaceBox | null`, `toGrid(box, x, y): [number, number]`, `fromGrid(box, gx, gy): [number, number]`.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/__tests__/annotation-geometry.test.ts
import { describe, it, expect } from 'vitest';
import {
  ANNOTATION_GRID,
  containedVideoBox,
  surfaceBox,
  toGrid,
  fromGrid,
} from '../room/annotation-geometry';

describe('containedVideoBox (object-fit: contain)', () => {
  const rows: Array<[string, [number, number, number, number], ReturnType<typeof containedVideoBox>]> = [
    ['wide video in a tall tile is letterboxed top and bottom', [400, 600, 1600, 900], { left: 0, top: 187.5, width: 400, height: 225 }],
    ['tall video in a wide tile is pillarboxed left and right', [600, 400, 900, 1600], { left: 187.5, top: 0, width: 225, height: 400 }],
    ['exact fit fills the tile', [800, 450, 1600, 900], { left: 0, top: 0, width: 800, height: 450 }],
    ['zero-size video has no surface', [800, 450, 0, 0], null],
    ['zero-size tile has no surface', [0, 0, 1600, 900], null],
  ];
  for (const [name, args, expected] of rows) {
    it(name, () => {
      expect(containedVideoBox(...args)).toEqual(expected);
    });
  }
});

describe('surfaceBox', () => {
  it("'tile' is the whole tile and needs no video", () => {
    expect(surfaceBox('tile', 400, 300)).toEqual({ left: 0, top: 0, width: 400, height: 300 });
  });
  it("'tile' with a zero-size tile has no surface", () => {
    expect(surfaceBox('tile', 0, 300)).toBeNull();
  });
  it("'contained-video' delegates to containedVideoBox", () => {
    expect(surfaceBox('contained-video', 400, 600, 1600, 900)).toEqual(containedVideoBox(400, 600, 1600, 900));
  });
  it("'contained-video' without video metadata has no surface", () => {
    expect(surfaceBox('contained-video', 400, 600)).toBeNull();
  });
});

describe('toGrid / fromGrid', () => {
  const box = { left: 10, top: 20, width: 400, height: 200 };
  it('round-trips a grid point through pixels', () => {
    const [x, y] = fromGrid(box, 1234, 5678);
    expect(toGrid(box, x, y)).toEqual([1234, 5678]);
  });
  it('maps the surface corners to the grid corners', () => {
    expect(toGrid(box, 10, 20)).toEqual([0, 0]);
    expect(toGrid(box, 410, 220)).toEqual([ANNOTATION_GRID, ANNOTATION_GRID]);
  });
  it('clamps a pointer outside the surface onto its edge', () => {
    expect(toGrid(box, -50, 1000)).toEqual([0, ANNOTATION_GRID]);
  });
  it('rounds to integers', () => {
    const [x, y] = toGrid(box, 10 + 400 / 3, 20 + 200 / 3);
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to make sure that it fails**

Run: `nix develop -c npx vitest run src/__tests__/annotation-geometry.test.ts --root ui`
Expected: FAIL, the module `../room/annotation-geometry` is not found.

- [ ] **Step 3: Write the implementation**

```ts
// ui/src/room/annotation-geometry.ts
/**
 * Pure geometry for share annotations. Spec:
 * docs/superpowers/specs/2026-10-09-screen-share-annotations-design.md,
 * "The drawing surface" and "Coordinates". No DOM and no time: the
 * overlay element (room/modules/annotations.ts) measures and calls in.
 *
 * A stroke point is an integer pair on a square ANNOTATION_GRID grid
 * laid over the tile's drawing surface. The surface is either the whole
 * tile ('tile') or the rectangle a video image occupies under
 * `object-fit: contain` ('contained-video', the screen share), so every
 * screen lands a mark on the same shared pixels however it letterboxes.
 */

export const ANNOTATION_GRID = 10000;

export type AnnotationSurfaceKind = 'tile' | 'contained-video';

/** A rectangle in CSS pixels, relative to the overlay host's top-left. */
export interface SurfaceBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The box a `videoW`×`videoH` image occupies in a `tileW`×`tileH` tile
 *  under `object-fit: contain`. Null when either size is empty. */
export function containedVideoBox(
  tileW: number,
  tileH: number,
  videoW: number,
  videoH: number,
): SurfaceBox | null {
  if (!(tileW > 0 && tileH > 0 && videoW > 0 && videoH > 0)) return null;
  const scale = Math.min(tileW / videoW, tileH / videoH);
  const width = videoW * scale;
  const height = videoH * scale;
  return { left: (tileW - width) / 2, top: (tileH - height) / 2, width, height };
}

export function surfaceBox(
  kind: AnnotationSurfaceKind,
  tileW: number,
  tileH: number,
  videoW?: number,
  videoH?: number,
): SurfaceBox | null {
  switch (kind) {
    case 'tile':
      return tileW > 0 && tileH > 0 ? { left: 0, top: 0, width: tileW, height: tileH } : null;
    case 'contained-video':
      return containedVideoBox(tileW, tileH, videoW ?? 0, videoH ?? 0);
  }
}

const clampGrid = (v: number) => Math.min(ANNOTATION_GRID, Math.max(0, Math.round(v)));

/** Pixel position (relative to the host) to integer grid units, clamped. */
export function toGrid(box: SurfaceBox, x: number, y: number): [number, number] {
  return [
    clampGrid(((x - box.left) / box.width) * ANNOTATION_GRID),
    clampGrid(((y - box.top) / box.height) * ANNOTATION_GRID),
  ];
}

/** Grid units back to a pixel position relative to the host. */
export function fromGrid(box: SurfaceBox, gx: number, gy: number): [number, number] {
  return [
    box.left + (gx / ANNOTATION_GRID) * box.width,
    box.top + (gy / ANNOTATION_GRID) * box.height,
  ];
}
```

- [ ] **Step 4: Add the no-ambient-clock pin**

In `ui/src/__tests__/no-ambient-clock.test.ts`, append to `PINNED_FILES`:

```ts
  // Share annotations (spec 2026-10-09): pure geometry, no time at all,
  // pinned per the owner pattern.
  { relPath: '../room/annotation-geometry.ts', patterns: FULL_PATTERNS },
```

- [ ] **Step 5: Run the tests**

Run: `nix develop -c npx vitest run src/__tests__/annotation-geometry.test.ts src/__tests__/no-ambient-clock.test.ts --root ui`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/room/annotation-geometry.ts ui/src/__tests__/annotation-geometry.test.ts ui/src/__tests__/no-ambient-clock.test.ts
git commit -m "feat(annotations): pure surface geometry for share annotations"
```

---

### Task 2: Policy

**Files:**
- Create: `ui/src/room/annotation-policy.ts`
- Test: `ui/src/__tests__/annotation-policy.test.ts`
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts` (add the pin)

**Interfaces:**
- Consumes: `ANNOTATION_GRID` from Task 1. `ModuleStateEnvelope` and `AgentPubKeyB64` from `ui/src/types.ts`.
- Produces: the constants above, `ANNOTATIONS_MODULE_ID` and `ANNOTATION_PALETTE` (8 hex strings). The types `AnnotationStroke`, `AnnotationBoard`, `AnnotationsPayload`, `ActiveShareEpochs` and `VisibleStroke`. The functions `emptyAnnotations()`, `defaultColorFor(pubKeyB64)`, `parseAnnotationsPayload(raw)`, `readShareAnnotationsEpoch(envelope)` and `stampShareAnnotationsEpoch(payload, epoch)`. Also `thinPoints(pts, minSpacing?)`, `payloadBytes(p)`, `enforceBounds(p)` and `applyStroke(p, sharer, shareModuleId, stroke)`. Also `undoLastStroke(p, sharer, shareModuleId)`, `clearMyBoard(p, sharer, shareModuleId)`, `pruneBoards(p, active)`, `visibleStrokes(authors, sharer, shareModuleId, epoch)` and `activeShareEpochs(mine, myPubKeyB64, peers, shareModuleIds)`.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/__tests__/annotation-policy.test.ts
import { describe, it, expect } from 'vitest';
import {
  ANNOTATION_PALETTE,
  MAX_BOARD_STROKES,
  MAX_STROKE_POINTS,
  MAX_ANNOTATIONS_PAYLOAD_BYTES,
  MIN_POINT_SPACING,
  emptyAnnotations,
  defaultColorFor,
  parseAnnotationsPayload,
  readShareAnnotationsEpoch,
  stampShareAnnotationsEpoch,
  thinPoints,
  payloadBytes,
  enforceBounds,
  applyStroke,
  undoLastStroke,
  clearMyBoard,
  pruneBoards,
  visibleStrokes,
  activeShareEpochs,
} from '../room/annotation-policy';
import type { AnnotationStroke, AnnotationsPayload } from '../room/annotation-policy';
import { ANNOTATION_GRID } from '../room/annotation-geometry';

const SHARER = 'uhCAksharer';
const ME = 'uhCAkme';
const PEER = 'uhCAkpeer';

const stroke = (id: string, epoch = 1, color = 0, pts: number[] = [0, 0, 100, 100]): AnnotationStroke => ({
  id,
  epoch,
  color,
  pts,
});

const payloadWith = (
  boards: Array<[sharer: string, moduleId: string, strokes: AnnotationStroke[]]>,
): AnnotationsPayload => {
  const p = emptyAnnotations();
  for (const [sharer, moduleId, strokes] of boards) {
    (p.boards[sharer] ??= {})[moduleId] = { strokes };
  }
  return p;
};

describe('thinPoints', () => {
  it('keeps the first and last points and drops points closer than the spacing', () => {
    const pts = [0, 0, 10, 0, 20, 0, 60, 0, 70, 0, 75, 0];
    expect(thinPoints(pts, MIN_POINT_SPACING)).toEqual([0, 0, 60, 0, 75, 0]);
  });
  it('keeps the last point even when it is close to the previous kept point', () => {
    expect(thinPoints([0, 0, 100, 0, 105, 0])).toEqual([0, 0, 100, 0, 105, 0]);
  });
  it('leaves a one-point or two-point stroke alone', () => {
    expect(thinPoints([5, 5])).toEqual([5, 5]);
    expect(thinPoints([5, 5, 6, 6])).toEqual([5, 5, 6, 6]);
  });
});

describe('enforceBounds', () => {
  it(`cuts a stroke at MAX_STROKE_POINTS and nothing else`, () => {
    const long = Array.from({ length: (MAX_STROKE_POINTS + 5) * 2 }, (_, i) => i % ANNOTATION_GRID);
    const p = payloadWith([[SHARER, 'screen-share', [stroke('a', 1, 0, long), stroke('b')]]]);
    const out = enforceBounds(p);
    expect(out.boards[SHARER]['screen-share'].strokes[0].pts).toHaveLength(MAX_STROKE_POINTS * 2);
    expect(out.boards[SHARER]['screen-share'].strokes[1]).toEqual(stroke('b'));
  });
  it(`keeps the newest MAX_BOARD_STROKES strokes of a board`, () => {
    const many = Array.from({ length: MAX_BOARD_STROKES + 3 }, (_, i) => stroke(`s${i}`));
    const out = enforceBounds(payloadWith([[SHARER, 'screen-share', many]]));
    const ids = out.boards[SHARER]['screen-share'].strokes.map(s => s.id);
    expect(ids).toHaveLength(MAX_BOARD_STROKES);
    expect(ids[0]).toBe('s3');
    expect(ids[ids.length - 1]).toBe(`s${MAX_BOARD_STROKES + 2}`);
  });
  it('drops the oldest stroke of the largest board until the payload fits the byte cap', () => {
    const big = (id: string) =>
      stroke(id, 1, 0, Array.from({ length: 2 * MAX_STROKE_POINTS }, (_, i) => 1000 + (i % 100)));
    const small = stroke('small');
    const p = payloadWith([
      [SHARER, 'screen-share', Array.from({ length: 12 }, (_, i) => big(`big${i}`))],
      [SHARER, 'wal', [small]],
    ]);
    expect(payloadBytes(p)).toBeGreaterThan(MAX_ANNOTATIONS_PAYLOAD_BYTES);
    const out = enforceBounds(p);
    expect(payloadBytes(out)).toBeLessThanOrEqual(MAX_ANNOTATIONS_PAYLOAD_BYTES);
    expect(out.boards[SHARER]['wal'].strokes).toEqual([small]);
    const kept = out.boards[SHARER]['screen-share'].strokes.map(s => s.id);
    expect(kept[kept.length - 1]).toBe('big11');
    expect(kept[0]).not.toBe('big0');
  });
  it('removes a board and a sharer entry that end up empty', () => {
    const out = enforceBounds(payloadWith([[SHARER, 'screen-share', []]]));
    expect(out).toEqual(emptyAnnotations());
  });
});

describe('board writes', () => {
  it('applyStroke appends to an existing board', () => {
    const p = payloadWith([[SHARER, 'screen-share', [stroke('a')]]]);
    expect(applyStroke(p, SHARER, 'screen-share', stroke('b'))).toEqual(
      payloadWith([[SHARER, 'screen-share', [stroke('a'), stroke('b')]]]),
    );
  });
  it('applyStroke creates the board and the sharer entry when absent', () => {
    expect(applyStroke(emptyAnnotations(), SHARER, 'wal', stroke('a'))).toEqual(
      payloadWith([[SHARER, 'wal', [stroke('a')]]]),
    );
  });
  it('applyStroke does not mutate its input', () => {
    const p = emptyAnnotations();
    applyStroke(p, SHARER, 'wal', stroke('a'));
    expect(p).toEqual(emptyAnnotations());
  });
  it('undoLastStroke removes the newest stroke and drops an empty board', () => {
    const p = payloadWith([[SHARER, 'screen-share', [stroke('a'), stroke('b')]]]);
    const once = undoLastStroke(p, SHARER, 'screen-share');
    expect(once).toEqual(payloadWith([[SHARER, 'screen-share', [stroke('a')]]]));
    expect(undoLastStroke(once, SHARER, 'screen-share')).toEqual(emptyAnnotations());
  });
  it('undoLastStroke on a missing board returns the payload unchanged', () => {
    const p = payloadWith([[SHARER, 'wal', [stroke('a')]]]);
    expect(undoLastStroke(p, SHARER, 'screen-share')).toEqual(p);
  });
  it('clearMyBoard removes only the named board', () => {
    const p = payloadWith([
      [SHARER, 'screen-share', [stroke('a')]],
      [SHARER, 'wal', [stroke('b')]],
    ]);
    expect(clearMyBoard(p, SHARER, 'screen-share')).toEqual(payloadWith([[SHARER, 'wal', [stroke('b')]]]));
  });
});

describe('pruneBoards', () => {
  it('drops strokes behind the share epoch, boards of inactive shares, and keeps the rest', () => {
    const p = payloadWith([
      [SHARER, 'screen-share', [stroke('old', 1), stroke('cur', 2), stroke('ahead', 3)]],
      [SHARER, 'wal', [stroke('w', 5)]],
      [PEER, 'screen-share', [stroke('gone', 1)]],
    ]);
    const out = pruneBoards(p, { [SHARER]: { 'screen-share': 2, wal: 5 } });
    expect(out).toEqual(
      payloadWith([
        [SHARER, 'screen-share', [stroke('cur', 2), stroke('ahead', 3)]],
        [SHARER, 'wal', [stroke('w', 5)]],
      ]),
    );
  });
  it('returns the same object when nothing is pruned', () => {
    const p = payloadWith([[SHARER, 'wal', [stroke('w', 5)]]]);
    expect(pruneBoards(p, { [SHARER]: { wal: 5 } })).toBe(p);
  });
});

describe('visibleStrokes', () => {
  const mine = payloadWith([[SHARER, 'screen-share', [stroke('m1', 7, 0), stroke('m0', 6, 0)]]]);
  const theirs = payloadWith([
    [SHARER, 'screen-share', [stroke('p1', 7, 3)]],
    [SHARER, 'wal', [stroke('pw', 7, 3)]],
  ]);
  const authors = [
    { author: ME, payload: mine },
    { author: PEER, payload: theirs },
  ];
  it('returns every author\'s strokes for the tile under the current epoch only', () => {
    expect(visibleStrokes(authors, SHARER, 'screen-share', 7)).toEqual([
      { author: ME, stroke: stroke('m1', 7, 0) },
      { author: PEER, stroke: stroke('p1', 7, 3) },
    ]);
  });
  it('keeps the two share modules of one sharer apart', () => {
    expect(visibleStrokes(authors, SHARER, 'wal', 7)).toEqual([{ author: PEER, stroke: stroke('pw', 7, 3) }]);
  });
  it('is empty after a clear (a newer epoch)', () => {
    expect(visibleStrokes(authors, SHARER, 'screen-share', 8)).toEqual([]);
  });
});

describe('the share epoch', () => {
  const env = (payload: string, active = true) => ({ moduleId: 'screen-share', active, payload, updatedAt: 1 });
  it('reads annotationsEpoch from an active share envelope', () => {
    expect(readShareAnnotationsEpoch(env(JSON.stringify({ annotationsEpoch: 42 })))).toBe(42);
  });
  it('reads a missing field, an inactive envelope, a non-JSON payload and a null envelope as 0', () => {
    expect(readShareAnnotationsEpoch(env('{}'))).toBe(0);
    expect(readShareAnnotationsEpoch(env(JSON.stringify({ annotationsEpoch: 42 }), false))).toBe(0);
    expect(readShareAnnotationsEpoch(env('not json'))).toBe(0);
    expect(readShareAnnotationsEpoch(null)).toBe(0);
  });
  it('stampShareAnnotationsEpoch merges into a JSON object and keeps the other fields', () => {
    expect(JSON.parse(stampShareAnnotationsEpoch(JSON.stringify({ weaveUrl: 'x' }), 9))).toEqual({
      weaveUrl: 'x',
      annotationsEpoch: 9,
    });
    expect(JSON.parse(stampShareAnnotationsEpoch('{}', 9))).toEqual({ annotationsEpoch: 9 });
  });
  it('stampShareAnnotationsEpoch leaves a non-object payload unchanged', () => {
    expect(stampShareAnnotationsEpoch('"text"', 9)).toBe('"text"');
    expect(stampShareAnnotationsEpoch('[1]', 9)).toBe('[1]');
    expect(stampShareAnnotationsEpoch('not json', 9)).toBe('not json');
  });
  it('activeShareEpochs lists every active share of self and peers with its epoch', () => {
    const mineStates = { 'screen-share': env(JSON.stringify({ annotationsEpoch: 3 })) };
    const peers = {
      [PEER]: {
        wal: env(JSON.stringify({ annotationsEpoch: 4 })),
        'screen-share': env('{}', false),
        conversation: env('{}'),
      },
    };
    expect(activeShareEpochs(mineStates, ME, peers, ['screen-share', 'wal'])).toEqual({
      [ME]: { 'screen-share': 3 },
      [PEER]: { wal: 4 },
    });
  });
});

describe('parseAnnotationsPayload (remote input)', () => {
  const valid = payloadWith([[SHARER, 'screen-share', [stroke('a', 1, 2, [0, 0, ANNOTATION_GRID, ANNOTATION_GRID])]]]);
  it('accepts a valid payload', () => {
    expect(parseAnnotationsPayload(JSON.stringify(valid))).toEqual(valid);
  });
  const bad = (patch: Partial<AnnotationStroke> | Record<string, unknown>) =>
    JSON.stringify(payloadWith([[SHARER, 'screen-share', [{ ...stroke('a'), ...patch } as AnnotationStroke]]]));
  const rejections: Array<[string, string]> = [
    ['odd-length pts', bad({ pts: [1, 2, 3] })],
    ['non-integer point', bad({ pts: [0, 0.5, 1, 1] })],
    ['point above the grid', bad({ pts: [0, 0, ANNOTATION_GRID + 1, 0] })],
    ['negative point', bad({ pts: [0, 0, -1, 0] })],
    ['too many points', bad({ pts: Array.from({ length: (MAX_STROKE_POINTS + 1) * 2 }, () => 1) })],
    ['color outside the palette', bad({ color: ANNOTATION_PALETTE.length })],
    ['non-integer color', bad({ color: 1.5 })],
    ['non-finite epoch', bad({ epoch: 'x' })],
    ['missing id', bad({ id: 3 })],
  ];
  for (const [name, raw] of rejections) {
    it(`drops a stroke with ${name}, and the board with it`, () => {
      expect(parseAnnotationsPayload(raw)).toEqual(emptyAnnotations());
    });
  }
  it('drops the whole payload when v is not 1', () => {
    expect(parseAnnotationsPayload(JSON.stringify({ ...valid, v: 2 }))).toEqual(emptyAnnotations());
  });
  it('returns empty for null, empty, non-JSON and non-object input', () => {
    expect(parseAnnotationsPayload(null)).toEqual(emptyAnnotations());
    expect(parseAnnotationsPayload('')).toEqual(emptyAnnotations());
    expect(parseAnnotationsPayload('{')).toEqual(emptyAnnotations());
    expect(parseAnnotationsPayload('[]')).toEqual(emptyAnnotations());
  });
  it('keeps the valid strokes of a board beside an invalid one', () => {
    const raw = JSON.stringify(payloadWith([[SHARER, 'wal', [stroke('ok'), { ...stroke('bad'), pts: [1] }]]]));
    expect(parseAnnotationsPayload(raw)).toEqual(payloadWith([[SHARER, 'wal', [stroke('ok')]]]));
  });
  it('keeps only the newest MAX_BOARD_STROKES of an over-full remote board (Review Focus 1)', () => {
    const many = Array.from({ length: MAX_BOARD_STROKES + 10 }, (_, i) => stroke(`s${i}`));
    const out = parseAnnotationsPayload(JSON.stringify(payloadWith([[SHARER, 'wal', many]])));
    const ids = out.boards[SHARER]['wal'].strokes.map(s => s.id);
    expect(ids).toHaveLength(MAX_BOARD_STROKES);
    expect(ids[0]).toBe('s10');
  });
});

describe('defaultColorFor', () => {
  it('is a stable palette index', () => {
    const i = defaultColorFor(ME);
    expect(i).toBe(defaultColorFor(ME));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(ANNOTATION_PALETTE.length);
  });
});
```

- [ ] **Step 2: Run the test to make sure that it fails**

Run: `nix develop -c npx vitest run src/__tests__/annotation-policy.test.ts --root ui`
Expected: FAIL, the module `../room/annotation-policy` is not found.

- [ ] **Step 3: Write the implementation**

```ts
// ui/src/room/annotation-policy.ts
/**
 * Share annotations: the payload, its bounds, and every pure decision
 * over it. Spec:
 * docs/superpowers/specs/2026-10-09-screen-share-annotations-design.md.
 *
 * ONE home for the `annotations` module's wire payload and board
 * arithmetic. The overlay element (room/modules/annotations.ts) only
 * measures, draws and calls in; the store (streams-store.ts,
 * `activateModule` / `clearShareAnnotations`) only stamps the epoch.
 *
 * Plain objects in, plain objects out. No DOM, no time. The functions
 * never mutate their input.
 */
import type { AgentPubKeyB64, ModuleStateEnvelope } from '../types';
import { ANNOTATION_GRID } from './annotation-geometry';

export const ANNOTATIONS_MODULE_ID = 'annotations';

/**
 * Payload bounds. All three serve the pong payload size — every pong
 * re-echoes the full payload to every peer (`PongMetaDataV1.moduleStates`)
 * — which is a wire cost, NOT a liveness predicate (working agreement 2).
 */
export const MAX_STROKE_POINTS = 200;
export const MAX_BOARD_STROKES = 50;
export const MAX_ANNOTATIONS_PAYLOAD_BYTES = 12288;
/** Pen-up thinning: drop a point closer than this (grid units) to the
 *  previous kept point. Payload size, NOT liveness. */
export const MIN_POINT_SPACING = 40;

export const ANNOTATION_PALETTE = [
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#00c7be',
  '#007aff',
  '#af52de',
  '#ffffff',
] as const;

export interface AnnotationStroke {
  /** Unique within this author's board. */
  id: string;
  /** The share's `annotationsEpoch` the stroke was drawn under. */
  epoch: number;
  /** Index into ANNOTATION_PALETTE. */
  color: number;
  /** Flat [x0, y0, x1, y1, ...], integers on 0..ANNOTATION_GRID. */
  pts: number[];
}

export interface AnnotationBoard {
  strokes: AnnotationStroke[];
}

/** The author's boards, keyed by sharer and then by share module id. */
export interface AnnotationsPayload {
  v: 1;
  boards: Record<AgentPubKeyB64, Record<string, AnnotationBoard>>;
}

/** Current epoch per active share: `active[sharer][shareModuleId]`. */
export type ActiveShareEpochs = Record<AgentPubKeyB64, Record<string, number>>;

export interface VisibleStroke {
  author: AgentPubKeyB64;
  stroke: AnnotationStroke;
}

export function emptyAnnotations(): AnnotationsPayload {
  return { v: 1, boards: {} };
}

export function defaultColorFor(pubKeyB64: string): number {
  let h = 0;
  for (let i = 0; i < pubKeyB64.length; i++) h = (h * 31 + pubKeyB64.charCodeAt(i)) >>> 0;
  return h % ANNOTATION_PALETTE.length;
}

// --- parsing (remote input) -------------------------------------------

function isValidStroke(s: unknown): s is AnnotationStroke {
  if (!s || typeof s !== 'object') return false;
  const { id, epoch, color, pts } = s as Record<string, unknown>;
  if (typeof id !== 'string') return false;
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return false;
  if (!Number.isInteger(color) || (color as number) < 0 || (color as number) >= ANNOTATION_PALETTE.length) {
    return false;
  }
  if (!Array.isArray(pts) || pts.length % 2 !== 0 || pts.length > MAX_STROKE_POINTS * 2) return false;
  return pts.every(p => Number.isInteger(p) && p >= 0 && p <= ANNOTATION_GRID);
}

/**
 * Validate a payload from the wire. Drops every stroke that breaks a
 * rule, every board left without a valid stroke, and the whole payload
 * when `v` is not 1. Keeps only the newest MAX_BOARD_STROKES of a board,
 * so an over-full remote board cannot grow memory or paint time.
 */
export function parseAnnotationsPayload(raw: string | null | undefined): AnnotationsPayload {
  if (!raw) return emptyAnnotations();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyAnnotations();
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyAnnotations();
  if ((data as { v?: unknown }).v !== 1) return emptyAnnotations();
  const out = emptyAnnotations();
  const rawBoards = (data as { boards?: unknown }).boards;
  if (!rawBoards || typeof rawBoards !== 'object') return out;
  for (const [sharer, perModule] of Object.entries(rawBoards as Record<string, unknown>)) {
    if (!perModule || typeof perModule !== 'object') continue;
    for (const [shareModuleId, board] of Object.entries(perModule as Record<string, unknown>)) {
      const rawStrokes = (board as { strokes?: unknown } | null)?.strokes;
      if (!Array.isArray(rawStrokes)) continue;
      const strokes = rawStrokes.filter(isValidStroke).slice(-MAX_BOARD_STROKES);
      if (strokes.length === 0) continue;
      (out.boards[sharer] ??= {})[shareModuleId] = { strokes };
    }
  }
  return out;
}

// --- the share epoch -----------------------------------------------------

/** The sharer's current clear epoch, or 0 when the share envelope is
 *  absent, inactive, unparsable, or from a build that sends none. */
export function readShareAnnotationsEpoch(envelope: ModuleStateEnvelope | null | undefined): number {
  if (!envelope?.active || !envelope.payload) return 0;
  try {
    const e = (JSON.parse(envelope.payload) as { annotationsEpoch?: unknown }).annotationsEpoch;
    return typeof e === 'number' && Number.isFinite(e) ? e : 0;
  } catch {
    return 0;
  }
}

/** Merge `annotationsEpoch` into a JSON-object payload. Any other
 *  payload shape is returned unchanged. */
export function stampShareAnnotationsEpoch(payload: string, epoch: number): string {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return payload;
  return JSON.stringify({ ...(data as object), annotationsEpoch: epoch });
}

/** Every active share of self and peers with its epoch. */
export function activeShareEpochs(
  mine: Record<string, ModuleStateEnvelope>,
  myPubKeyB64: AgentPubKeyB64,
  peers: Record<AgentPubKeyB64, Record<string, ModuleStateEnvelope>>,
  shareModuleIds: string[],
): ActiveShareEpochs {
  const out: ActiveShareEpochs = {};
  const all: Array<[AgentPubKeyB64, Record<string, ModuleStateEnvelope>]> = [
    [myPubKeyB64, mine],
    ...Object.entries(peers),
  ];
  for (const [agent, modules] of all) {
    for (const id of shareModuleIds) {
      const env = modules[id];
      if (!env?.active) continue;
      (out[agent] ??= {})[id] = readShareAnnotationsEpoch(env);
    }
  }
  return out;
}

// --- geometry of a stroke -------------------------------------------------

export function thinPoints(pts: number[], minSpacing = MIN_POINT_SPACING): number[] {
  if (pts.length < 4) return pts.slice();
  const out = [pts[0], pts[1]];
  let kx = pts[0];
  let ky = pts[1];
  const last = pts.length - 2;
  for (let i = 2; i < last; i += 2) {
    const dx = pts[i] - kx;
    const dy = pts[i + 1] - ky;
    if (dx * dx + dy * dy >= minSpacing * minSpacing) {
      out.push(pts[i], pts[i + 1]);
      kx = pts[i];
      ky = pts[i + 1];
    }
  }
  out.push(pts[last], pts[last + 1]);
  return out;
}

// --- board arithmetic ------------------------------------------------------

function boardOf(p: AnnotationsPayload, sharer: AgentPubKeyB64, shareModuleId: string): AnnotationBoard | undefined {
  return p.boards[sharer]?.[shareModuleId];
}

/** Return a copy with the named board replaced, or removed when `board`
 *  is null. A sharer entry with no boards left is removed too. */
function withBoard(
  p: AnnotationsPayload,
  sharer: AgentPubKeyB64,
  shareModuleId: string,
  board: AnnotationBoard | null,
): AnnotationsPayload {
  const perModule = { ...(p.boards[sharer] ?? {}) };
  if (board) perModule[shareModuleId] = board;
  else delete perModule[shareModuleId];
  const boards = { ...p.boards };
  if (Object.keys(perModule).length) boards[sharer] = perModule;
  else delete boards[sharer];
  return { v: 1, boards };
}

export function payloadBytes(p: AnnotationsPayload): number {
  return new TextEncoder().encode(JSON.stringify(p)).length;
}

/** Apply the three bounds. Strokes over MAX_STROKE_POINTS are cut at the
 *  tail, a board keeps its newest MAX_BOARD_STROKES, and while the
 *  payload exceeds the byte cap the oldest stroke of the largest board
 *  goes. Empty boards and sharer entries are removed. */
export function enforceBounds(p: AnnotationsPayload): AnnotationsPayload {
  let next = emptyAnnotations();
  for (const [sharer, perModule] of Object.entries(p.boards)) {
    for (const [shareModuleId, board] of Object.entries(perModule)) {
      const strokes = board.strokes
        .slice(-MAX_BOARD_STROKES)
        .map(s => (s.pts.length > MAX_STROKE_POINTS * 2 ? { ...s, pts: s.pts.slice(0, MAX_STROKE_POINTS * 2) } : s));
      if (strokes.length) next = withBoard(next, sharer, shareModuleId, { strokes });
    }
  }
  while (payloadBytes(next) > MAX_ANNOTATIONS_PAYLOAD_BYTES) {
    let largest: { sharer: string; shareModuleId: string; bytes: number } | null = null;
    for (const [sharer, perModule] of Object.entries(next.boards)) {
      for (const [shareModuleId, board] of Object.entries(perModule)) {
        const bytes = JSON.stringify(board).length;
        if (!largest || bytes > largest.bytes) largest = { sharer, shareModuleId, bytes };
      }
    }
    if (!largest) break;
    const board = next.boards[largest.sharer][largest.shareModuleId];
    next = withBoard(
      next,
      largest.sharer,
      largest.shareModuleId,
      board.strokes.length > 1 ? { strokes: board.strokes.slice(1) } : null,
    );
  }
  return next;
}

export function applyStroke(
  p: AnnotationsPayload,
  sharer: AgentPubKeyB64,
  shareModuleId: string,
  stroke: AnnotationStroke,
): AnnotationsPayload {
  const board = boardOf(p, sharer, shareModuleId) ?? { strokes: [] };
  return enforceBounds(withBoard(p, sharer, shareModuleId, { strokes: [...board.strokes, stroke] }));
}

export function undoLastStroke(p: AnnotationsPayload, sharer: AgentPubKeyB64, shareModuleId: string): AnnotationsPayload {
  const board = boardOf(p, sharer, shareModuleId);
  if (!board) return p;
  return withBoard(p, sharer, shareModuleId, board.strokes.length > 1 ? { strokes: board.strokes.slice(0, -1) } : null);
}

export function clearMyBoard(p: AnnotationsPayload, sharer: AgentPubKeyB64, shareModuleId: string): AnnotationsPayload {
  return withBoard(p, sharer, shareModuleId, null);
}

/** Drop strokes behind their share's current epoch and boards of shares
 *  that are not active. Returns the same object when nothing changes. */
export function pruneBoards(p: AnnotationsPayload, active: ActiveShareEpochs): AnnotationsPayload {
  let next = p;
  for (const [sharer, perModule] of Object.entries(p.boards)) {
    for (const [shareModuleId, board] of Object.entries(perModule)) {
      const epoch = active[sharer]?.[shareModuleId];
      if (epoch === undefined) {
        next = withBoard(next, sharer, shareModuleId, null);
        continue;
      }
      const kept = board.strokes.filter(s => s.epoch >= epoch);
      if (kept.length !== board.strokes.length) {
        next = withBoard(next, sharer, shareModuleId, kept.length ? { strokes: kept } : null);
      }
    }
  }
  return next;
}

/** Every author's strokes on one tile under the share's current epoch,
 *  in author order then stroke order. */
export function visibleStrokes(
  authors: Array<{ author: AgentPubKeyB64; payload: AnnotationsPayload }>,
  sharer: AgentPubKeyB64,
  shareModuleId: string,
  epoch: number,
): VisibleStroke[] {
  const out: VisibleStroke[] = [];
  for (const { author, payload } of authors) {
    for (const stroke of payload.boards[sharer]?.[shareModuleId]?.strokes ?? []) {
      if (stroke.epoch === epoch) out.push({ author, stroke });
    }
  }
  return out;
}
```

- [ ] **Step 4: Add the no-ambient-clock pin**

In `ui/src/__tests__/no-ambient-clock.test.ts`, append to `PINNED_FILES` beside the geometry entry:

```ts
  { relPath: '../room/annotation-policy.ts', patterns: FULL_PATTERNS },
```

- [ ] **Step 5: Run the tests**

Run: `nix develop -c npx vitest run src/__tests__/annotation-policy.test.ts src/__tests__/no-ambient-clock.test.ts --root ui`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/room/annotation-policy.ts ui/src/__tests__/annotation-policy.test.ts ui/src/__tests__/no-ambient-clock.test.ts
git commit -m "feat(annotations): payload, bounds and board arithmetic as pure policy"
```

---

### Task 3: Module aspects and the store's epoch

**Files:**
- Modify: `ui/src/room/modules/types.ts` (the `ModuleDefinition` interface, after `shareWrapperClass`)
- Modify: `ui/src/room/modules/screen-share.ts` (the `screenShareModule` literal)
- Modify: `ui/src/streams-store.ts` (`activateModule`, and a new `clearShareAnnotations` after `updateModuleState`)
- Test: `ui/src/__tests__/streams-store-wiring.test.ts` (new describe block at the end of the file)

**Interfaces:**
- Consumes: `stampShareAnnotationsEpoch` and `readShareAnnotationsEpoch` from Task 2. `AnnotationSurfaceKind` from Task 1.
- Produces: `ModuleDefinition.shareOverlayElement?: string`, `ModuleDefinition.annotationSurface?: AnnotationSurfaceKind`, `StreamsStore.clearShareAnnotations(shareModuleId: string): Promise<void>`, and the rule that `activateModule` stamps `annotationsEpoch` on share-type payloads.

- [ ] **Step 1: Write the failing wiring tests**

Append to `ui/src/__tests__/streams-store-wiring.test.ts`:

```ts
describe('share annotations: the epoch the store stamps (spec "Clearing")', () => {
  it('activating a share-type module stamps annotationsEpoch from the clock and keeps the payload fields', async () => {
    const { store, clock } = makeStarted();
    await store.activateModule('wal', JSON.stringify({ weaveUrl: 'weave://x' }));
    const payload = JSON.parse(get(store._myModuleStates)['wal'].payload);
    expect(payload).toEqual({ weaveUrl: 'weave://x', annotationsEpoch: clock.now() });
  });

  it('negative control: activating an agent-type module stamps nothing', async () => {
    const { store } = makeStarted();
    await store.activateModule('reactions');
    expect(JSON.parse(get(store._myModuleStates)['reactions'].payload)).toEqual({ reactions: [] });
  });

  it('a share module with no payload gets an object holding only the epoch', async () => {
    const { store, clock } = makeStarted();
    await store.activateModule('screen-share');
    expect(JSON.parse(get(store._myModuleStates)['screen-share'].payload)).toEqual({
      annotationsEpoch: clock.now(),
    });
  });

  it('clearShareAnnotations rewrites the share payload with a newer epoch and broadcasts it', async () => {
    const { store, clock, bus } = makeStarted();
    store._knownAgents.set(knownFresh(clock, peerA));
    await store.activateModule('screen-share');
    const first = JSON.parse(get(store._myModuleStates)['screen-share'].payload).annotationsEpoch;
    clock.advance(1000);
    await store.clearShareAnnotations('screen-share');
    const second = JSON.parse(get(store._myModuleStates)['screen-share'].payload).annotationsEpoch;
    expect(second).toBeGreaterThan(first);
    const sent = bus.sentOfType('ModuleState');
    expect(sent).toHaveLength(2);
    const last = JSON.parse(sent[1].payload!);
    expect(last.moduleId).toBe('screen-share');
    expect(JSON.parse(last.payload).annotationsEpoch).toBe(second);
  });

  it('clearShareAnnotations on a module that is not active does nothing', async () => {
    const { store, clock, bus } = makeStarted();
    store._knownAgents.set(knownFresh(clock, peerA));
    await store.clearShareAnnotations('screen-share');
    expect(get(store._myModuleStates)['screen-share']).toBeUndefined();
    expect(bus.sentOfType('ModuleState')).toHaveLength(0);
  });
});
```

`clock.advance` is the `ManualClock` method the suite already uses. Check its name with `grep -n "advance" ui/src/clock.testing.ts` and use what is there.

- [ ] **Step 2: Run the tests to make sure that they fail**

Run: `nix develop -c npx vitest run src/__tests__/streams-store-wiring.test.ts -t "share annotations" --root ui`
Expected: FAIL. The stamp rows see no `annotationsEpoch`, and the clear rows fail on `clearShareAnnotations` not being a function.

- [ ] **Step 3: Add the two module aspects**

In `ui/src/room/modules/types.ts`, add the import at the top:

```ts
import type { AnnotationSurfaceKind } from '../annotation-geometry';
```

Then, inside `ModuleDefinition`, after the `shareWrapperClass?: string;` member:

```ts
  /**
   * Custom element tag mounted into EVERY share tile, on top of the share
   * content and under the maximize icon (room-view.ts, renderSharedPanel).
   * It receives `.sharerPubKeyB64`, `.shareModuleId` and `.context` as
   * properties. Share annotations (room/modules/annotations.ts) is the
   * first consumer.
   */
  shareOverlayElement?: string;

  /**
   * Where annotation strokes land on THIS module's share tile
   * (annotation-geometry.ts, surfaceBox). 'tile' (the default) is the
   * tile's content box; 'contained-video' is the rectangle the tile's
   * one <video> occupies under `object-fit: contain`.
   */
  annotationSurface?: AnnotationSurfaceKind;
```

In `ui/src/room/modules/screen-share.ts`, inside the `screenShareModule` literal after `shareWrapperClass: 'video-container screen-share',`:

```ts
  // The share image is letterboxed by `.video-container.screen-share
  // .video-el { object-fit: contain }` (room-view.ts), so strokes map to
  // the video's content box, not the tile (spec "The drawing surface").
  annotationSurface: 'contained-video',
```

- [ ] **Step 4: Stamp the epoch in the store**

In `ui/src/streams-store.ts`, add to the imports:

```ts
import { stampShareAnnotationsEpoch } from './room/annotation-policy';
```

Replace the first two lines of `activateModule`'s body:

```ts
    const mod = getModule(moduleId);
    const actualPayload = payload ?? mod?.defaultState?.() ?? '{}';
```

with:

```ts
    const mod = getModule(moduleId);
    let actualPayload = payload ?? mod?.defaultState?.() ?? '{}';
    // Share annotations (spec "Clearing"): every share-type module's
    // payload carries `annotationsEpoch`, stamped HERE on the injected
    // clock — the ONE generic site — so a share restart mints a new epoch
    // and empties the board on every screen. A non-object payload is
    // left alone and reads as epoch 0 (annotation-policy.ts).
    if (mod?.type === 'share') {
      actualPayload = stampShareAnnotationsEpoch(actualPayload, this.clock.now());
    }
```

After `updateModuleState`, add:

```ts
  /**
   * The sharer's clear-all for share annotations (spec "Clearing"): a new
   * `annotationsEpoch` in the share payload, which every overlay reads
   * through `readShareAnnotationsEpoch` (annotation-policy.ts). One
   * ModuleState signal empties the board on every screen. No-op when the
   * share is not active.
   */
  async clearShareAnnotations(shareModuleId: string): Promise<void> {
    const existing = get(this._myModuleStates)[shareModuleId];
    if (!existing?.active) return;
    await this.updateModuleState(
      shareModuleId,
      stampShareAnnotationsEpoch(existing.payload, this.clock.now()),
    );
  }
```

- [ ] **Step 5: Run the tests**

Run: `nix develop -c npx vitest run src/__tests__/streams-store-wiring.test.ts --root ui`
Expected: PASS, the whole file. The existing screen-share rows read only `active`, so the new payload field does not break them.

- [ ] **Step 6: Typecheck**

Run: `nix develop -c npm run typecheck -w ui`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/room/modules/types.ts ui/src/room/modules/screen-share.ts ui/src/streams-store.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "feat(annotations): share-overlay and surface aspects; the store stamps the clear epoch"
```

---

### Task 4: The overlay element and the module

**Files:**
- Create: `ui/src/room/modules/annotations.ts`
- Modify: `ui/src/room/modules/index.ts` (add the side-effect import)
- Test: `ui/src/__tests__/annotations-overlay-render.test.ts`
- Modify: `ui/src/__tests__/view-teardown-symmetry.test.ts` (new describe block)
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts` (add the pin)

**Interfaces:**
- Consumes: everything from Tasks 1 and 2. `getModule`, `getShareModules` and `registerModule` from `./registry`. `StreamsStore.updateModuleState` and `clearShareAnnotations` from Task 3. `ModuleRenderContext` from `./types`.
- Produces: the element class `ModuleAnnotationsShareOverlay` (tag `module-annotations-share-overlay`). Its properties are `sharerPubKeyB64`, `shareModuleId`, `context` and the reflected boolean `pen`. It holds the internal `_mine` and `_peers` StoreSubscribers. The task also registers the module `annotations`.

- [ ] **Step 1: Write the failing render test**

```ts
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
    updateModuleState: vi.fn(async () => {}),
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
});

describe('the surface', () => {
  it('a wal tile draws over the whole tile and needs no video', async () => {
    const el = await mount({ isMe: false, shareModuleId: 'wal', store: makeStore(viewerStates('wal')) });
    const svg = q(el, 'svg') as SVGElement;
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
    const svg = q(el, 'svg') as SVGElement;
    expect(svg.style.top).toBe('37.5px');
    expect(svg.style.width).toBe('400px');
    expect(svg.style.height).toBe('225px');
  });

  it('a screen-share tile without video metadata disables the pen and ignores drawing (Review Focus 3)', async () => {
    const store = makeStore(viewerStates('screen-share'));
    const el = await mount({ isMe: false, shareModuleId: 'screen-share', store, video: { w: 0, h: 0 } });
    expect(q(el, 'svg')).toBeNull();
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
    expect(q(el, 'svg')).not.toBeNull();
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
```

The expected thinned points in the pen-up row come from a 400×300 tile: `x = round(10/400*10000) = 250`, `y = round(10/300*10000) = 333`, `200/400 → 5000`, `200/300 → 6667`. All four corners are far apart, so thinning keeps all of them.

- [ ] **Step 2: Run the test to make sure that it fails**

Run: `nix develop -c npx vitest run src/__tests__/annotations-overlay-render.test.ts --root ui`
Expected: FAIL, the module `../room/modules/annotations` is not found.

- [ ] **Step 3: Write the element and the module**

```ts
// ui/src/room/modules/annotations.ts
/**
 * Share annotations: the `annotations` module and its share-tile overlay.
 * Spec: docs/superpowers/specs/2026-10-09-screen-share-annotations-design.md.
 *
 * The module is agent-type, activated at join (room-view.ts, beside
 * `reactions`), with no toolbar button and no agent-tile overlay. Its
 * state is the author's own boards (annotation-policy.ts,
 * AnnotationsPayload). The overlay element below is mounted into EVERY
 * share tile by room-view's renderSharedPanel through the
 * `shareOverlayElement` aspect (modules/types.ts), aggregates every
 * author's board for that tile, and draws them as SVG over the tile's
 * declared surface (`annotationSurface`, annotation-geometry.ts).
 *
 * No ambient time: the stroke id reads the store's injected clock.
 */
import { LitElement, css, html, nothing, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { StoreSubscriber } from '@holochain-open-dev/stores';
import { mdiDeleteSweep, mdiEraser, mdiPencil, mdiUndo } from '@mdi/js';
import { getModule, getShareModules, registerModule } from './registry';
import type { ModuleDefinition, ModuleRenderContext, ModuleStateEnvelope } from './types';
import type { AgentPubKeyB64 } from '../../types';
import { surfaceBox, toGrid } from '../annotation-geometry';
import type { SurfaceBox } from '../annotation-geometry';
import {
  ANNOTATION_PALETTE,
  ANNOTATIONS_MODULE_ID,
  activeShareEpochs,
  applyStroke,
  clearMyBoard,
  defaultColorFor,
  emptyAnnotations,
  parseAnnotationsPayload,
  pruneBoards,
  readShareAnnotationsEpoch,
  thinPoints,
  undoLastStroke,
  visibleStrokes,
} from '../annotation-policy';
import type { AnnotationsPayload, AnnotationStroke, VisibleStroke } from '../annotation-policy';

const icon = (path: string) => svg`<svg viewBox="0 0 24 24" width="18" height="18"><path d=${path} fill="currentColor"></path></svg>`;

const pairs = (pts: number[]): string => {
  const out: string[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(`${pts[i]},${pts[i + 1]}`);
  return out.join(' ');
};

@customElement('module-annotations-share-overlay')
export class ModuleAnnotationsShareOverlay extends LitElement {
  @property({ attribute: false }) sharerPubKeyB64: AgentPubKeyB64 = '';
  @property({ attribute: false }) shareModuleId = '';
  @property({ attribute: false }) context!: ModuleRenderContext;

  /** Pen armed. Reflected so the stylesheet can gate pointer capture. */
  @property({ type: Boolean, reflect: true }) pen = false;

  @state() private _color: number | null = null;
  @state() private _surface: SurfaceBox | null = null;
  @state() private _drawing: number[] | null = null;

  private _counter = 0;
  private _video: HTMLVideoElement | null = null;
  private _resizeObserver: ResizeObserver | null = null;

  _mine = new StoreSubscriber(
    this,
    () => this.context.streamsStore._myModuleStates,
    () => [this.context],
  );
  _peers = new StoreSubscriber(
    this,
    () => this.context.streamsStore._peerModuleStates,
    () => [this.context],
  );

  static styles = css`
    :host {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 2;
      pointer-events: none;
    }
    .canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    :host([pen]) .canvas {
      pointer-events: auto;
      touch-action: none;
      cursor: crosshair;
    }
    svg.board {
      position: absolute;
      overflow: visible;
    }
    polyline.stroke {
      fill: none;
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }
    .strip {
      position: absolute;
      bottom: 10px;
      left: 10px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.55);
      pointer-events: auto;
    }
    .tool {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #fff;
      cursor: pointer;
    }
    .tool.on {
      background: rgba(255, 255, 255, 0.25);
    }
    .tool:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .swatch {
      width: 18px;
      height: 18px;
      border: 2px solid transparent;
      border-radius: 50%;
      cursor: pointer;
      padding: 0;
    }
    .swatch.on {
      border-color: #fff;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // The share tile holds at most one <video> (screen-share.ts,
    // renderShare); the asset tile holds none and uses the tile surface.
    this._video = this.parentElement?.querySelector('video') ?? null;
    this._video?.addEventListener('loadedmetadata', this._measure);
    this._video?.addEventListener('resize', this._measure);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._measure);
      this._resizeObserver.observe(this);
    }
    this._measure();
  }

  disconnectedCallback() {
    this._video?.removeEventListener('loadedmetadata', this._measure);
    this._video?.removeEventListener('resize', this._measure);
    this._video = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._drawing = null;
    super.disconnectedCallback();
  }

  private _measure = () => {
    const kind = getModule(this.shareModuleId)?.annotationSurface ?? 'tile';
    const rect = this.getBoundingClientRect();
    this._surface = surfaceBox(kind, rect.width, rect.height, this._video?.videoWidth, this._video?.videoHeight);
  };

  // --- reads ---------------------------------------------------------------

  private _myPayload(): AnnotationsPayload {
    return parseAnnotationsPayload(this._mine.value?.[ANNOTATIONS_MODULE_ID]?.payload);
  }

  private _shareEnvelope(): ModuleStateEnvelope | null {
    return this.context.isMe
      ? (this._mine.value?.[this.shareModuleId] ?? null)
      : (this._peers.value?.[this.sharerPubKeyB64]?.[this.shareModuleId] ?? null);
  }

  private _epoch(): number {
    return readShareAnnotationsEpoch(this._shareEnvelope());
  }

  private _visible(): VisibleStroke[] {
    const authors = [{ author: this.context.myPubKeyB64, payload: this._myPayload() }];
    for (const [peer, modules] of Object.entries(this._peers.value ?? {})) {
      authors.push({ author: peer, payload: parseAnnotationsPayload(modules[ANNOTATIONS_MODULE_ID]?.payload) });
    }
    return visibleStrokes(authors, this.sharerPubKeyB64, this.shareModuleId, this._epoch());
  }

  private _colorIndex(): number {
    return this._color ?? defaultColorFor(this.context.myPubKeyB64);
  }

  // --- writes --------------------------------------------------------------

  private _write(next: AnnotationsPayload): void {
    const active = activeShareEpochs(
      this._mine.value ?? {},
      this.context.myPubKeyB64,
      this._peers.value ?? {},
      getShareModules().map(m => m.id),
    );
    void this.context.streamsStore.updateModuleState(
      ANNOTATIONS_MODULE_ID,
      JSON.stringify(pruneBoards(next, active)),
    );
  }

  private _toGrid(e: MouseEvent): [number, number] {
    const rect = this.getBoundingClientRect();
    return toGrid(this._surface!, e.clientX - rect.left, e.clientY - rect.top);
  }

  private _onPointerDown(e: PointerEvent) {
    if (!this.pen || !this._surface) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    this._drawing = [...this._toGrid(e)];
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._drawing || !this._surface) return;
    this._drawing = [...this._drawing, ...this._toGrid(e)];
  }

  private _onPointerUp(e: PointerEvent) {
    const raw = this._drawing;
    this._drawing = null;
    if (!raw || !this._surface) return;
    const pts = thinPoints([...raw, ...this._toGrid(e)]);
    if (pts.length < 4) return;
    const stroke: AnnotationStroke = {
      id: `${this.context.streamsStore.clock.now()}-${++this._counter}`,
      epoch: this._epoch(),
      color: this._colorIndex(),
      pts,
    };
    this._write(applyStroke(this._myPayload(), this.sharerPubKeyB64, this.shareModuleId, stroke));
  }

  private _onPointerCancel() {
    this._drawing = null;
  }

  private _onDblClick(e: Event) {
    if (this.pen) e.stopPropagation();
  }

  // --- render --------------------------------------------------------------

  private _renderStrip() {
    const canDraw = !!this._surface;
    return html`
      <div class="strip">
        <button
          class="tool pen ${this.pen ? 'on' : ''}"
          title=${this.pen ? 'Pen off' : 'Pen on'}
          ?disabled=${!canDraw}
          @click=${() => (this.pen = !this.pen)}
        >${icon(mdiPencil)}</button>
        ${this.pen
          ? ANNOTATION_PALETTE.map(
              (hex, i) => html`<button
                class="swatch ${i === this._colorIndex() ? 'on' : ''}"
                style="background: ${hex}"
                title="Color"
                @click=${() => (this._color = i)}
              ></button>`,
            )
          : nothing}
        <button
          class="tool undo"
          title="Undo my last stroke"
          @click=${() => this._write(undoLastStroke(this._myPayload(), this.sharerPubKeyB64, this.shareModuleId))}
        >${icon(mdiUndo)}</button>
        <button
          class="tool clear-mine"
          title="Clear mine"
          @click=${() => this._write(clearMyBoard(this._myPayload(), this.sharerPubKeyB64, this.shareModuleId))}
        >${icon(mdiEraser)}</button>
        ${this.context?.isMe
          ? html`<button
              class="tool clear-all"
              title="Clear all"
              @click=${() => void this.context.streamsStore.clearShareAnnotations(this.shareModuleId)}
            >${icon(mdiDeleteSweep)}</button>`
          : nothing}
      </div>
    `;
  }

  render() {
    const s = this._surface;
    const strokes = s ? this._visible() : [];
    return html`
      <div
        class="canvas"
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointercancel=${this._onPointerCancel}
        @dblclick=${this._onDblClick}
      >
        ${s
          ? html`<svg
              class="board"
              viewBox="0 0 10000 10000"
              preserveAspectRatio="none"
              style="left: ${s.left}px; top: ${s.top}px; width: ${s.width}px; height: ${s.height}px;"
            >
              ${strokes.map(
                v => svg`<polyline
                  class="stroke"
                  data-author=${v.author}
                  points=${pairs(v.stroke.pts)}
                  stroke=${ANNOTATION_PALETTE[v.stroke.color]}
                ></polyline>`,
              )}
              ${this._drawing && this._drawing.length >= 4
                ? svg`<polyline
                    class="stroke drawing"
                    points=${pairs(this._drawing)}
                    stroke=${ANNOTATION_PALETTE[this._colorIndex()]}
                  ></polyline>`
                : nothing}
            </svg>`
          : nothing}
      </div>
      ${this._renderStrip()}
    `;
  }
}

const annotationsModule: ModuleDefinition = {
  id: ANNOTATIONS_MODULE_ID,
  type: 'agent',
  label: 'Annotations',
  icon: mdiPencil,
  activationControl: 'sender',

  shareOverlayElement: 'module-annotations-share-overlay',

  defaultState() {
    return JSON.stringify(emptyAnnotations());
  },
};

registerModule(annotationsModule);
```

In `ui/src/room/modules/index.ts`, after `import './transcription';`:

```ts
import './annotations';
```

- [ ] **Step 4: Run the render test**

Run: `nix develop -c npx vitest run src/__tests__/annotations-overlay-render.test.ts --root ui`
Expected: PASS. If the `viewBox` of `10000` must read as `ANNOTATION_GRID`, import it and interpolate; keep the attribute literal otherwise.

- [ ] **Step 5: Write the teardown pin**

Append to `ui/src/__tests__/view-teardown-symmetry.test.ts`:

```ts
describe('module-annotations-share-overlay teardown (share annotations)', () => {
  it('disconnect releases both store subscriptions, the video listeners and the ResizeObserver', async () => {
    const observed: Array<{ disconnected: boolean }> = [];
    class FakeResizeObserver {
      private rec = { disconnected: false };
      constructor(_cb: unknown) {
        observed.push(this.rec);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.rec.disconnected = true;
      }
    }
    (globalThis as any).ResizeObserver = FakeResizeObserver;
    try {
      await import('../room/modules/annotations');
      let active = 0;
      const counting = (value: unknown) => ({
        subscribe(cb: (v: unknown) => void) {
          active += 1;
          cb(value);
          return () => {
            active -= 1;
          };
        },
      });
      const frame = document.createElement('div');
      const video = document.createElement('video');
      let listeners = 0;
      const add = video.addEventListener.bind(video);
      const remove = video.removeEventListener.bind(video);
      video.addEventListener = ((...args: Parameters<typeof add>) => {
        listeners += 1;
        return add(...args);
      }) as typeof video.addEventListener;
      video.removeEventListener = ((...args: Parameters<typeof remove>) => {
        listeners -= 1;
        return remove(...args);
      }) as typeof video.removeEventListener;
      frame.appendChild(video);
      const el = document.createElement('module-annotations-share-overlay') as any;
      el.sharerPubKeyB64 = 'uhCAksharer';
      el.shareModuleId = 'screen-share';
      el.context = {
        isMe: false,
        connected: true,
        circleView: false,
        myPubKeyB64: 'uhCAkme',
        streamsStore: { _myModuleStates: counting({}), _peerModuleStates: counting({}), clock: { now: () => 0 } },
      };
      frame.appendChild(el);
      document.body.appendChild(frame);
      await el.updateComplete;
      expect(active).toBe(2);
      expect(listeners).toBe(2);
      expect(observed).toHaveLength(1);

      frame.remove();
      expect(active).toBe(0);
      expect(listeners).toBe(0);
      expect(observed[0].disconnected).toBe(true);
    } finally {
      delete (globalThis as any).ResizeObserver;
    }
  });
});
```

The file already runs in jsdom and mocks `logs-graph`. If `document.body.appendChild` is not what that file uses, follow its existing mount style.

- [ ] **Step 6: Add the no-ambient-clock pin**

In `ui/src/__tests__/no-ambient-clock.test.ts`, append to `PINNED_FILES` beside the two annotation entries:

```ts
  // The overlay element: the stroke id reads the store's injected clock.
  { relPath: '../room/modules/annotations.ts', patterns: FULL_PATTERNS },
```

- [ ] **Step 7: Run the three suites and the typecheck**

Run: `nix develop -c npx vitest run src/__tests__/annotations-overlay-render.test.ts src/__tests__/view-teardown-symmetry.test.ts src/__tests__/no-ambient-clock.test.ts --root ui && nix develop -c npm run typecheck -w ui`
Expected: PASS and no type errors. `noUnusedLocals` is on, so every import in the element must be used.

- [ ] **Step 8: Commit**

```bash
git add ui/src/room/modules/annotations.ts ui/src/room/modules/index.ts ui/src/__tests__/annotations-overlay-render.test.ts ui/src/__tests__/view-teardown-symmetry.test.ts ui/src/__tests__/no-ambient-clock.test.ts
git commit -m "feat(annotations): the annotations module and its share-tile overlay element"
```

---

### Task 5: Mount in the share panel, activate at join, and the wire round trip

**Files:**
- Modify: `ui/src/room/room-view.ts` (`renderSharedPanel`, the join-time activation block near `activateModule('reactions')`)
- Test: `ui/src/__tests__/shared-panel-overlays.test.ts` (new, jsdom)
- Test: `ui/src/__tests__/streams-store-wiring.test.ts` (extend the Task 3 describe block)

**Interfaces:**
- Consumes: `getAllModules`, which room-view already imports from `./modules/registry`. `ModuleDefinition.shareOverlayElement` from Task 3 and the element from Task 4. From Task 2: `visibleStrokes`, `parseAnnotationsPayload`, `readShareAnnotationsEpoch` and `applyStroke`.
- Produces: `room-view.ts`'s private `_renderShareOverlays(shareModuleId, sharerPubKeyB64, context)`.

- [ ] **Step 1: Write the failing render pin**

```ts
// ui/src/__tests__/shared-panel-overlays.test.ts
// @vitest-environment jsdom
/**
 * renderSharedPanel mounts every registered `shareOverlayElement` into
 * every share tile (spec "Two new module aspects"). Same style as
 * intent-diff-surfaces.test.ts: a constructed, never-mounted room-view
 * with a fake store, rendering the template method into a detached host.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../room/logs-graph', () => ({}));

import { render } from 'lit';
import { writable } from '@holochain-open-dev/stores';
import '../room/room-view';

const myPubKey = new Uint8Array(39).fill(1);
const PEER = 'uhCAkpeer';

function makeRoomView(mine: Record<string, unknown>, peers: Record<string, Record<string, unknown>>): any {
  const el = document.createElement('room-view') as any;
  el.streamsStore = {
    _myModuleStates: writable(mine),
    _peerModuleStates: writable(peers),
    _screenShareConnectionsIncoming: writable({}),
    clock: { now: () => 0 },
    disconnect: vi.fn(),
  };
  el.roomStore = { client: { client: { myPubKey } } };
  el._myModuleStates = { value: mine };
  el._peerModuleStates = { value: peers };
  el._showConnectionDetails = false;
  return el;
}

const env = (moduleId: string, payload: object) => ({ moduleId, active: true, payload: JSON.stringify(payload), updatedAt: 1 });

describe('renderSharedPanel share overlays', () => {
  it('mounts the annotations overlay into an own screen-share tile and a peer wal tile', () => {
    const el = makeRoomView(
      { 'screen-share': env('screen-share', { annotationsEpoch: 1 }) },
      { [PEER]: { wal: env('wal', { weaveUrl: 'weave://x', annotationsEpoch: 1 }) } },
    );
    const host = document.createElement('div');
    render(el.renderSharedPanel(), host);
    const frames = Array.from(host.querySelectorAll('.shared-panel-frame'));
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      const overlay = frame.querySelector('module-annotations-share-overlay') as any;
      expect(overlay).not.toBeNull();
      // Under the maximize icon in document order, so the icon paints on top.
      const icon = frame.querySelector('.maximize-icon')!;
      expect(overlay.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const own = frames[0].querySelector('module-annotations-share-overlay') as any;
    expect(own.shareModuleId).toBe('screen-share');
    expect(own.context.isMe).toBe(true);
    const theirs = frames[1].querySelector('module-annotations-share-overlay') as any;
    expect(theirs.shareModuleId).toBe('wal');
    expect(theirs.sharerPubKeyB64).toBe(PEER);
    expect(theirs.context.isMe).toBe(false);
  });

  it('negative control: with no share active nothing is mounted', () => {
    const el = makeRoomView({}, {});
    const host = document.createElement('div');
    render(el.renderSharedPanel(), host);
    expect(host.querySelector('module-annotations-share-overlay')).toBeNull();
  });
});
```

If `renderSharedPanel` reads more store fields than the fake provides, add them to the fake as `writable({})` or plain values. Do not change `renderSharedPanel`'s reads to fit the test.

- [ ] **Step 2: Run the pin to make sure that it fails**

Run: `nix develop -c npx vitest run src/__tests__/shared-panel-overlays.test.ts --root ui`
Expected: FAIL, no `module-annotations-share-overlay` in the frames.

- [ ] **Step 3: Mount the overlays and activate at join**

In `ui/src/room/room-view.ts`, before `renderSharedPanel()` add:

```ts
  /**
   * Every registered module's `shareOverlayElement` (modules/types.ts),
   * mounted into one share tile. Share annotations is the first consumer
   * (modules/annotations.ts). Rendered after the share content and the
   * diagnostics overlay and before the maximize icon, so the icon stays
   * on top.
   */
  private _renderShareOverlays(
    shareModuleId: string,
    sharerPubKeyB64: AgentPubKeyB64,
    context: ModuleRenderContext,
  ): unknown[] {
    return getAllModules()
      .filter(m => !!m.shareOverlayElement)
      .map(m => {
        const tag = unsafeStatic(m.shareOverlayElement!);
        return staticHtml`<${tag}
          .sharerPubKeyB64=${sharerPubKeyB64}
          .shareModuleId=${shareModuleId}
          .context=${context}
        ></${tag}>`;
      });
  }
```

In `renderSharedPanel`'s tile template, change:

```ts
            ${content}
            ${diagnosticsOverlay}
            <sl-icon
```

to:

```ts
            ${content}
            ${diagnosticsOverlay}
            ${this._renderShareOverlays(moduleId, agentPubKeyB64, context)}
            <sl-icon
```

In the join-time activation block, after `this.streamsStore.activateModule('reactions');`:

```ts
    // Share annotations (spec "Activation"): on by default like reactions;
    // the module has no toolbar button.
    this.streamsStore.activateModule('annotations');
```

- [ ] **Step 4: Run the pin**

Run: `nix develop -c npx vitest run src/__tests__/shared-panel-overlays.test.ts --root ui`
Expected: PASS.

- [ ] **Step 5: Write the failing wire round-trip tests**

Append inside the Task 3 describe block (`share annotations: the epoch the store stamps`) in `ui/src/__tests__/streams-store-wiring.test.ts`, or in a sibling block right after it:

```ts
describe('share annotations: the wire round trip (spec "Approaches considered", A)', () => {
  const annotationsOf = (store: StreamsStore, author: string) =>
    parseAnnotationsPayload(get(store._peerModuleStates)[author]?.[ANNOTATIONS_MODULE_ID]?.payload);

  /** A second started store with its own key, so a signal sent by one can
   *  be delivered to the other. */
  function makePeerStore(clock: ManualClock, key: AgentPubKey) {
    const fakes = makeFakeDeps({ clock, myPubKey: key });
    const logger = new FakeLogger();
    const store = new StreamsStore(fakes.deps, async () => '', logger.asPresenceLogger());
    store.start();
    live.push(store);
    return { ...fakes, store };
  }

  it('a board write leaves the author as one ModuleState and lands in the peer\'s view under the share epoch', async () => {
    const { store: author, clock, bus } = makeStarted();
    const viewer = makePeerStore(clock, peerAKey);
    author._knownAgents.set(knownFresh(clock, peerA));
    // The viewer already holds the sharer's (peerB's) share envelope.
    const shareEnv = { moduleId: 'screen-share', active: true, payload: JSON.stringify({ annotationsEpoch: 9 }), updatedAt: clock.now() };
    viewer.store._peerModuleStates.set({ [peerB]: { 'screen-share': shareEnv } });

    const board = applyStroke(emptyAnnotations(), peerB, 'screen-share', { id: 's1', epoch: 9, color: 1, pts: [0, 0, 100, 100] });
    await author.updateModuleState(ANNOTATIONS_MODULE_ID, JSON.stringify(board));
    const sent = bus.sentOfType('ModuleState');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([peerA]);

    await viewer.bus.deliver(message(myPubKey as unknown as AgentPubKey, 'ModuleState', sent[0].payload!));
    const epoch = readShareAnnotationsEpoch(get(viewer.store._peerModuleStates)[peerB]['screen-share']);
    const visible = visibleStrokes([{ author: myPubKeyB64, payload: annotationsOf(viewer.store, myPubKeyB64) }], peerB, 'screen-share', epoch);
    expect(visible.map(v => v.stroke.id)).toEqual(['s1']);
  });

  it('a store that joins after the write gets the board from a pong', async () => {
    const { store: author, clock } = makeStarted();
    const board = applyStroke(emptyAnnotations(), peerB, 'screen-share', { id: 's1', epoch: 9, color: 1, pts: [0, 0, 100, 100] });
    await author.updateModuleState(ANNOTATIONS_MODULE_ID, JSON.stringify(board));

    const late = makePeerStore(clock, peerAKey);
    await late.bus.deliver(
      message(
        myPubKey as unknown as AgentPubKey,
        'PongUi',
        JSON.stringify({
          formatVersion: 1,
          data: {
            connectionStatuses: {},
            moduleStates: get(author._myModuleStates),
            moduleStatesAt: clock.now(),
          },
        }),
      ),
    );
    expect(annotationsOf(late.store, myPubKeyB64)).toEqual(board);
  });

  it('the sharer\'s clear-all empties the viewer\'s board with one ModuleState, and a leave removes a peer\'s strokes (Review Focus 5)', async () => {
    const { store: sharer, clock, bus } = makeStarted();
    sharer._knownAgents.set(knownFresh(clock, peerA));
    await sharer.activateModule('screen-share');
    const shareSignal = bus.sentOfType('ModuleState')[0];
    const viewer = makePeerStore(clock, peerAKey);
    await viewer.bus.deliver(message(myPubKey as unknown as AgentPubKey, 'ModuleState', shareSignal.payload!));
    const epochBefore = readShareAnnotationsEpoch(get(viewer.store._peerModuleStates)[myPubKeyB64]['screen-share']);

    // peerB drew on the sharer's screen under that epoch; the viewer holds it.
    const theirs = applyStroke(emptyAnnotations(), myPubKeyB64, 'screen-share', { id: 'b1', epoch: epochBefore, color: 2, pts: [0, 0, 50, 50] });
    await viewer.bus.deliver(
      message(peerBKey, 'ModuleState', JSON.stringify({ moduleId: ANNOTATIONS_MODULE_ID, active: true, payload: JSON.stringify(theirs), updatedAt: clock.now() })),
    );
    const authors = () => [{ author: peerB, payload: annotationsOf(viewer.store, peerB) }];
    const epoch = () => readShareAnnotationsEpoch(get(viewer.store._peerModuleStates)[myPubKeyB64]['screen-share']);
    expect(visibleStrokes(authors(), myPubKeyB64, 'screen-share', epoch())).toHaveLength(1);

    clock.advance(1000);
    await sharer.clearShareAnnotations('screen-share');
    const clearSignal = bus.sentOfType('ModuleState')[1];
    await viewer.bus.deliver(message(myPubKey as unknown as AgentPubKey, 'ModuleState', clearSignal.payload!));
    expect(epoch()).toBeGreaterThan(epochBefore);
    expect(visibleStrokes(authors(), myPubKeyB64, 'screen-share', epoch())).toHaveLength(0);

    // Review Focus 5: peerB leaves; the viewer drops peerB's module states.
    await viewer.bus.deliver(message(peerBKey, 'LeaveUi', ''));
    expect(get(viewer.store._peerModuleStates)[peerB]).toBeUndefined();
  });
});
```

Add to the file's imports:

```ts
import {
  ANNOTATIONS_MODULE_ID,
  applyStroke,
  emptyAnnotations,
  parseAnnotationsPayload,
  readShareAnnotationsEpoch,
  visibleStrokes,
} from '../room/annotation-policy';
```

Check the exact leave message type with `grep -n "'LeaveUi'" ui/src/streams-store.ts` and the payload `handleLeaveUi` expects, and match it in the last delivery.

- [ ] **Step 6: Run the wiring tests**

Run: `nix develop -c npx vitest run src/__tests__/streams-store-wiring.test.ts -t "share annotations" --root ui`
Expected: PASS. If the late-joiner row fails on the merge, the pong's `moduleStatesAt` must be at or after the envelope's `updatedAt`. Both read `clock.now()` here, so advance nothing between them.

- [ ] **Step 7: Run the whole ui suite and the typecheck**

Run: `nix develop -c npm run test -w ui && nix develop -c npm run typecheck -w ui`
Expected: PASS. `intent-write-sites.test.ts` is untouched: `git diff cf7084f -- ui/src/__tests__/intent-write-sites.test.ts` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add ui/src/room/room-view.ts ui/src/__tests__/shared-panel-overlays.test.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "feat(annotations): mount share overlays in the share panel, activate at join, pin the wire round trip"
```

---

### Task 6: Gate, docs and the fact bullet

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-screen-share-annotations-design.md` (decision markers, status line)
- Modify: `CLAUDE.md` (one fact bullet under "True today")
- Test: `ui/src/__tests__/claude-md-drift.test.ts` (run only)

- [ ] **Step 1: Run the gate**

Run: `nix develop -c npm run verify`
Expected: PASS end to end, including the drift script.

- [ ] **Step 2: Mark the spec**

In the spec, change the status line to `Status: landed on feat/screen-share-annotations (see the commits in git log). Decisions 1-6 landed.` and append ` (landed)` to each numbered decision. If any decision changed during implementation, write ` (landed with amendment: ...)` with one sentence that says what changed and why.

- [ ] **Step 3: Add the CLAUDE.md fact bullet**

Append under "True today", after the transcription bullet. Keep it free of test counts, line counts and coverage numbers, which `claude-md-drift.test.ts` rejects:

```markdown
- **Share annotations round facts** (landed 2026-10-09 on branch `feat/screen-share-annotations` off `main-0.7` @ `cf7084f`; spec `docs/superpowers/specs/2026-10-09-screen-share-annotations-design.md`, plan `docs/superpowers/plans/2026-10-09-screen-share-annotations.md`; whether the branch has reached a given line is checked with `git merge-base --is-ancestor <branch tip> <line>`, never trusted from this line). Any participant draws freehand strokes on any share-type tile and every participant sees them. The `annotations` module (`ui/src/room/modules/annotations.ts`, agent-type, activated at join beside `reactions`, no toolbar button) carries each author's own boards in their `ModuleState` envelope, keyed by sharer then share module id (`AnnotationsPayload`, `ui/src/room/annotation-policy.ts`, the ONE home of the payload, its bounds and every board decision; `parseAnnotationsPayload` validates remote strokes and keeps only the newest `MAX_BOARD_STROKES`). No new signal type and no capability. Two module aspects: `shareOverlayElement` (mounted by `room-view.ts`'s `renderSharedPanel` into every share tile through `_renderShareOverlays`) and `annotationSurface` (`'tile'` default, `'contained-video'` on `screen-share`; `surfaceBox` in `ui/src/room/annotation-geometry.ts` is the ONE mapping, strokes live on a square `ANNOTATION_GRID` grid over the surface). Clear-all is an epoch: `StreamsStore.activateModule` stamps `annotationsEpoch` from the injected clock into EVERY share-type payload (the ONE generic site, so a share restart empties the board), `clearShareAnnotations(shareModuleId)` restamps it, and `readShareAnnotationsEpoch` reads a missing field as 0 (declared interop: a sharer on a pre-round build cannot clear, and a pre-round peer stores and ignores the envelope). Bounds `MAX_STROKE_POINTS`/`MAX_BOARD_STROKES`/`MAX_ANNOTATIONS_PAYLOAD_BYTES`/`MIN_POINT_SPACING` serve the pong payload size and are declared NOT-liveness; the recorded cost of author-owned state is the full payload riding every pong, with a digest-and-fetch design triggered only by a field export that shows pong size as a cause of signal delay. Pinned: `annotation-geometry.test.ts`, `annotation-policy.test.ts`, `annotations-overlay-render.test.ts`, `shared-panel-overlays.test.ts`, the `share annotations` blocks of `streams-store-wiring.test.ts`, the overlay's teardown pin in `view-teardown-symmetry.test.ts`, and the three files in `no-ambient-clock.test.ts`. Declared behavior changes: share tiles gain a tool strip; every share-type payload carries `annotationsEpoch`; a participant's pong grows by their annotations payload. Not done: live preview while the pen moves, shapes/text/eraser, line width, a surface kind for an embed that reports its own content box, strokes past the share.
```

- [ ] **Step 4: Run the drift test and the gate again**

Run: `nix develop -c npx vitest run src/__tests__/claude-md-drift.test.ts --root ui && nix develop -c npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit the doc sync**

```bash
git add docs/superpowers/specs/2026-10-09-screen-share-annotations-design.md CLAUDE.md
git commit -m "docs(annotations): spec markers and the CLAUDE.md fact bullet"
```

- [ ] **Step 6: Manual check, owner-run**

On two machines in one room:

1. Share a screen on machine A. Resize the share tile on machine B so the video is letterboxed.
2. Draw on B with the pen on. Make sure that the stroke lands on the same part of the shared image on A.
3. Draw on A's own tile. Make sure that B sees it in A's color.
4. Press clear-all on A. Make sure that both screens empty.
5. Share an asset on A. Draw on it from B. Make sure that A sees the stroke.
6. Stop the screen share on A and start it again. Make sure that the old strokes do not return.

Record the result in the final review, not in the spec.
