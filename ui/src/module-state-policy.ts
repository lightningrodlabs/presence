/**
 * Round 3 item 3 (MAINTAINABILITY_ASSESSMENT.md §8) — the ONE merge rule
 * for `_peerModuleStates`.
 *
 * Two writers used incompatible rules before this file: the pong
 * reconcile block in `handlePongUi` applied `updatedAt` last-writer-wins
 * plus an *unconditional* delete-anything-absent-from-this-pong sweep,
 * while `handleModuleState` (the push path) ignored `updatedAt` entirely
 * and let `envelope.active` alone set or delete. Consequence: a module
 * activated by push, arriving after the peer serialized an in-flight
 * pong, was deleted by that pong on arrival and re-established ~2s
 * later — a silent module flicker, on exactly the surface (`room/modules/`)
 * new features compose.
 *
 * ## The rule (decided 2026-08-03, §8 item 3, following its recommendation)
 *
 * **`updatedAt` last-writer-wins for set AND delete.** All stamps
 * compared here are minted by the SAME peer's clock (`envelope.updatedAt`
 * and the pong's `moduleStatesAt` are both sender-side), so the
 * comparison never crosses clocks.
 *
 *  - A push (ModuleState signal) sets on `active` / deletes on
 *    `!active`, but only if its stamp is `>=` the held entry's — a stale
 *    push loses everywhere (declared change: it used to apply
 *    unconditionally). `>=`, not `>`: a re-push with an unchanged stamp
 *    is the sender repeating itself, and the latest arrival wins.
 *  - A pong-sweep entry sets only if strictly newer AND actually
 *    different (today's dedupe, preserved); an inactive pong entry
 *    deletes only if strictly newer.
 *  - A pong-sweep DELETE for an absent module needs the pong's own
 *    stamp (`sweepStamp`) to be strictly newer than the entry — the
 *    named interleave row `in-flight-pong-older-than-entry` is the
 *    flicker fix: a pong serialized before the activation carries an
 *    older stamp and may not delete the fresh entry.
 *  - `sweepStamp` is `PongMetaDataV1.moduleStatesAt` (added by this
 *    change, stamped by the sender whenever it builds pong meta), or —
 *    legacy pongs — the max `updatedAt` across the pong's own module
 *    entries. A legacy pong carrying no entries at all has no stamp;
 *    its sweep stays unconditional (`legacy-pong-unconditional-sweep`),
 *    which is exactly the pre-change behavior for exactly the peers
 *    that predate the stamp.
 *
 * Constrains `streams-store.ts:handleModuleState` and the pong
 * module-state reconcile in `streams-store.ts:handlePongUi` — both
 * writers apply this decision per module; neither carries inline merge
 * logic.
 */

import type { ModuleStateEnvelope } from './types';

export type ModuleStateMergeInputs = {
  /** The held entry for this (peer, moduleId), or null. */
  current: ModuleStateEnvelope | null;
  /**
   * The incoming envelope — from the push signal, or the pong's
   * moduleStates entry. `null` means the module is ABSENT from a pong
   * sweep (never null for a push; a push always carries an envelope).
   */
  incoming: ModuleStateEnvelope | null;
  source: 'push' | 'pong-sweep';
  /**
   * pong-sweep only: when the pong's moduleStates was serialized, on
   * the sender's clock. Gates absent-module deletes. `undefined` for a
   * legacy pong with no stamp and no entries to infer one from.
   */
  sweepStamp?: number;
};

export type ModuleStateMergeAction =
  | {
      action: 'set';
      envelope: ModuleStateEnvelope;
      reason: 'new-module' | 'newer-push' | 'new-from-pong' | 'newer-pong-entry';
    }
  | {
      action: 'delete';
      reason:
        | 'push-deactivated'
        | 'pong-entry-deactivated'
        | 'swept-by-newer-pong'
        | 'legacy-pong-unconditional-sweep';
    }
  | {
      action: 'keep';
      reason:
        | 'stale-push'
        | 'stale-pong-entry'
        | 'identical'
        | 'already-absent'
        | 'in-flight-pong-older-than-entry'
        | 'push-without-envelope';
    };

export function decideModuleStateMerge(
  input: ModuleStateMergeInputs,
): ModuleStateMergeAction {
  const { current, incoming } = input;

  if (input.source === 'push') {
    if (!incoming) {
      // A push always carries an envelope; treat a missing one as inert
      // rather than inventing delete semantics for it.
      return { action: 'keep', reason: 'push-without-envelope' };
    }
    if (incoming.active) {
      if (!current) return { action: 'set', envelope: incoming, reason: 'new-module' };
      return incoming.updatedAt >= current.updatedAt
        ? { action: 'set', envelope: incoming, reason: 'newer-push' }
        : { action: 'keep', reason: 'stale-push' };
    }
    if (!current) return { action: 'keep', reason: 'already-absent' };
    return incoming.updatedAt >= current.updatedAt
      ? { action: 'delete', reason: 'push-deactivated' }
      : { action: 'keep', reason: 'stale-push' };
  }

  // pong-sweep
  if (incoming) {
    if (incoming.active) {
      if (!current) return { action: 'set', envelope: incoming, reason: 'new-from-pong' };
      if (incoming.updatedAt > current.updatedAt) {
        const identical =
          incoming.payload === current.payload && incoming.active === current.active;
        return identical
          ? { action: 'keep', reason: 'identical' }
          : { action: 'set', envelope: incoming, reason: 'newer-pong-entry' };
      }
      return { action: 'keep', reason: 'stale-pong-entry' };
    }
    if (!current) return { action: 'keep', reason: 'already-absent' };
    return incoming.updatedAt > current.updatedAt
      ? { action: 'delete', reason: 'pong-entry-deactivated' }
      : { action: 'keep', reason: 'stale-pong-entry' };
  }

  // Absent from the pong.
  if (!current) return { action: 'keep', reason: 'already-absent' };
  if (input.sweepStamp === undefined) {
    return { action: 'delete', reason: 'legacy-pong-unconditional-sweep' };
  }
  return input.sweepStamp > current.updatedAt
    ? { action: 'delete', reason: 'swept-by-newer-pong' }
    : // THE flicker row: the pong was serialized before this entry was
      // pushed; deleting here is the module flicker item 3 exists to fix.
      { action: 'keep', reason: 'in-flight-pong-older-than-entry' };
}
