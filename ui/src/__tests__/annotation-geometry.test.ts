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
