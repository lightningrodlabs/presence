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
  it('skips a __proto__ sharer key and leaves Object.prototype untouched', () => {
    const raw = `{"v":1,"boards":{"__proto__":{"x":{"strokes":[${JSON.stringify(stroke('a'))}]}}}}`;
    expect(parseAnnotationsPayload(raw)).toEqual(emptyAnnotations());
    expect(({} as any).x).toBeUndefined();
  });
  it('skips a __proto__ share-module key under a normal sharer', () => {
    const raw = `{"v":1,"boards":{"${SHARER}":{"__proto__":{"strokes":[${JSON.stringify(stroke('a'))}]}}}}`;
    expect(parseAnnotationsPayload(raw)).toEqual(emptyAnnotations());
    expect(({} as any).strokes).toBeUndefined();
    expect(Object.getPrototypeOf(parseAnnotationsPayload(raw).boards)).toBe(Object.prototype);
  });
  it('whitelists stroke fields so unknown fields never enter state', () => {
    const raw = JSON.stringify(payloadWith([[SHARER, 'wal', [{ ...stroke('a'), extra: 1 } as AnnotationStroke]]]));
    expect(parseAnnotationsPayload(raw)).toEqual(payloadWith([[SHARER, 'wal', [stroke('a')]]]));
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
