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
import type { AgentPubKeyB64 } from '@holochain/client';
import type { ModuleStateEnvelope } from '../types';
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

/** Keys that would reach Object.prototype through a plain-object write. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
    if (UNSAFE_KEYS.has(sharer)) continue;
    if (!perModule || typeof perModule !== 'object') continue;
    for (const [shareModuleId, board] of Object.entries(perModule as Record<string, unknown>)) {
      if (UNSAFE_KEYS.has(shareModuleId)) continue;
      const rawStrokes = (board as { strokes?: unknown } | null)?.strokes;
      if (!Array.isArray(rawStrokes)) continue;
      const strokes = rawStrokes
        .filter(isValidStroke)
        .map(({ id, epoch, color, pts }) => ({ id, epoch, color, pts }))
        .slice(-MAX_BOARD_STROKES);
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
