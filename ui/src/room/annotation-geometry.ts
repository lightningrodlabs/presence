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
