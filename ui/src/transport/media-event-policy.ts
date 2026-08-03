/**
 * Phase 1 — pure decision logic for routing a transport's
 * `connection-state-change` event to a StreamsStore handler.
 *
 * Extracted from `StreamsStore._dispatchMediaEvent`, which was an
 * if/else-if chain over three of the eight `ConnectionPhase` members with
 * no `else`. The five unhandled members were dropped silently, and one of
 * them — `failed` — is the phase the FSM reaches when it gives up. Dropping
 * it left `_openConnections[peer]` populated with `connected: true` for a
 * peer whose `RTCPeerConnection` had already been destroyed: a rendered
 * pane over a dead link, and (because `_signalsTargets` is the complement
 * of `_openConnections`) permanent exclusion from the fallback carrier.
 *
 * The `switch` below is exhaustive over `ConnectionPhase` and ends in a
 * `never` assignment, so adding a phase to the union is a compile error
 * here rather than an invisible omission. That is the whole point of the
 * extraction; the table test in `__tests__/media-event-policy.test.ts`
 * enumerates all eight so a *changed* routing is a failing row.
 *
 * Constrains `streams-store.ts:_dispatchMediaEvent`.
 */

import type { ConnectionPhase } from './types';

export type TransportPhaseInputs = {
  /** The phase the transport just entered. */
  phase: ConnectionPhase;
  /** The connectionId this event belongs to. */
  connectionId: string;
  /**
   * `_openConnections[peer].connectionId`, or `undefined` when the peer has
   * no slot. Not a boolean: whether the slot's id *matches* is the whole
   * question — see `SlotAction`.
   */
  openConnectionId: string | undefined;
};

/**
 * What to do with the peer's `_openConnections` entry on a `signaling`
 * event.
 *
 * - `install` — no slot exists. The FSM acceptor path builds a connection
 *   from an incoming offer without streams-store knowing in advance, so
 *   the slot has to be created here for later connect/stream events to
 *   have something to mutate. The initiator path creates it itself in
 *   `handleInitAccept` (video) / `_ensureOutgoingScreenShare` (screen).
 *
 * - `adopt` — a slot exists but holds a *different* connectionId, so the
 *   FSM behind it is gone. `ConnectionManager` replaces an FSM in place on
 *   two acceptor-side paths — a higher-epoch offer, and a new remote
 *   session — and both call `fsm.destroy()`, which clears handlers and the
 *   pc **without emitting any transition**. The store therefore never sees
 *   a `closed` for the old id. Leaving the stale id in place desynchronises
 *   the slot from the live connection permanently: every later
 *   `_handleMediaConnected` / `_handleMediaClosed` for the new id hits its
 *   supersede guard and returns early, so a slot that was `connected: true`
 *   at the moment of replacement stays `connected: true` forever — a
 *   rendered pane over a dead link and permanent exclusion from
 *   `_signalsTargets`. That is MAINTAINABILITY_ASSESSMENT.md §3.1(c)
 *   reached by a route Phase 1's `failed`-routing does not cover, because
 *   no event is emitted at all.
 *
 *   Adoption is safe because `ConnectionManager` holds at most one FSM per
 *   peer and destroys the old one synchronously before creating the new
 *   one, so the newest `signaling` event is authoritative by construction.
 *
 * - `keep` — the slot already matches.
 */
export type SlotAction =
  | { action: 'install' }
  | { action: 'adopt'; supersedes: string }
  | { action: 'keep' };

export type TransportPhaseRoute =
  | { handler: 'signaling'; slot: SlotAction; reason: 'signaling-started' }
  | { handler: 'media-connected'; reason: 'transport-up' }
  | {
      handler: 'media-closed';
      reason: 'transport-closed' | 'gave-up' | 'peer-destroyed';
    }
  | { handler: 'ignore'; reason: 'establishing' | 'transport-owns-recovery' };

function slotActionFor(input: TransportPhaseInputs): SlotAction {
  if (input.openConnectionId === undefined) return { action: 'install' };
  if (input.openConnectionId === input.connectionId) return { action: 'keep' };
  return { action: 'adopt', supersedes: input.openConnectionId };
}

/** The `_openConnections` fields the slot-write decision reads and writes.
 *  Deliberately narrow: `OpenConnectionInfo` satisfies it structurally. */
export type SlotState = { connectionId: string; connected: boolean };

/** The route outcomes that touch the slot, as a discriminated input.
 *  `ignore` routes never reach this decision. `error` (Round 3 item 1) is
 *  the transport's error event: same guard structure as `closed` — before
 *  it existed, both error handlers hand-rolled the supersede/no-slot
 *  guards and had diverged. */
export type SlotEvent =
  | { kind: 'signaling'; slot: SlotAction }
  | { kind: 'connected' }
  | { kind: 'closed' }
  | { kind: 'error' };

export type SlotWrite =
  /** Create the slot fresh. Both `install` and `replace` start from
   *  `connected: false` — that is the truth in either case, and preserving
   *  a stale `connected: true` across an adopt is exactly the drift the
   *  PR #3 review caught in the harness mirror (finding F1). */
  | { write: 'install'; slot: SlotState }
  | { write: 'replace'; slot: SlotState; supersedes: string }
  | { write: 'set-connected'; slot: SlotState }
  | { write: 'clear' }
  | {
      write: 'none';
      reason: 'kept' | 'superseded' | 'no-slot';
      /** For 'superseded': the live connectionId that outranks the event's. */
      supersededBy?: string;
    };

/**
 * The single slot-transition decision, executed by BOTH
 * `StreamsStore._dispatchMediaEvent` / `_handleMediaConnected` /
 * `_handleMediaClosed` and the carrier-handover harness
 * (`ui/harness/carrier-handover-harness.ts`). Before this existed the
 * harness carried a hand-written mirror of these rules, and the mirror had
 * already drifted (adopt kept the stale `connected`; connect skipped the
 * supersede guard) — in the same PR that introduced it. A shared decision
 * makes that drift a compile error instead of a header caveat.
 *
 * Guard semantics preserved verbatim from the store:
 *  - `connected`/`closed` for a connectionId that does not match the slot's
 *    is superseded — a newer connection owns the slot; do not touch it.
 *  - `connected`/`closed` with no slot at all is a drop (closed mid-handshake
 *    / duplicate close respectively; the store stops the ICE monitor on the
 *    latter — a side effect, not a slot write).
 *
 * Constrains `streams-store.ts:_dispatchMediaEvent`,
 * `_handleMediaConnected`, `_handleMediaClosed`.
 */
export function decideSlotWrite(
  ev: SlotEvent,
  eventConnectionId: string,
  current: SlotState | undefined,
): SlotWrite {
  switch (ev.kind) {
    case 'signaling': {
      const slot = ev.slot;
      switch (slot.action) {
        case 'install':
          return {
            write: 'install',
            slot: { connectionId: eventConnectionId, connected: false },
          };
        case 'adopt':
          return {
            write: 'replace',
            slot: { connectionId: eventConnectionId, connected: false },
            supersedes: slot.supersedes,
          };
        case 'keep':
          return { write: 'none', reason: 'kept' };
      }
      const exhaustiveAction: never = slot;
      return exhaustiveAction;
    }
    case 'connected': {
      if (!current) return { write: 'none', reason: 'no-slot' };
      if (current.connectionId !== eventConnectionId) {
        return {
          write: 'none',
          reason: 'superseded',
          supersededBy: current.connectionId,
        };
      }
      return {
        write: 'set-connected',
        slot: { connectionId: current.connectionId, connected: true },
      };
    }
    case 'closed':
    case 'error': {
      // Same cell structure for both: an error for the live connection
      // clears the slot (the error path's cleanup plan then drives the
      // transport close); a superseded or duplicate error must not touch
      // a slot a newer connection owns. What differs between close and
      // error is the *cleanup set*, and that lives in
      // `closeCleanupPlan` (close-cleanup-policy.ts), not here.
      if (!current) return { write: 'none', reason: 'no-slot' };
      if (current.connectionId !== eventConnectionId) {
        return {
          write: 'none',
          reason: 'superseded',
          supersededBy: current.connectionId,
        };
      }
      return { write: 'clear' };
    }
  }
  const exhaustive: never = ev;
  return exhaustive;
}

export function routeTransportPhase(
  input: TransportPhaseInputs,
): TransportPhaseRoute {
  switch (input.phase) {
    case 'signaling':
      return {
        handler: 'signaling',
        slot: slotActionFor(input),
        reason: 'signaling-started',
      };

    case 'connecting':
      // Between SDP exchange and ICE+DTLS up. Nothing to do; `connected`
      // is the edge that matters.
      return { handler: 'ignore', reason: 'establishing' };

    case 'connected':
      return { handler: 'media-connected', reason: 'transport-up' };

    case 'reconnecting':
    case 'disconnected':
      // Transient, and the transport owns recovery from here (ICE restart,
      // full reconnect, disconnected-grace). Tearing app state down on
      // these is the second recovery controller the FSM exists to avoid;
      // the pane is presence-keyed and survives the gap.
      return { handler: 'ignore', reason: 'transport-owns-recovery' };

    case 'failed':
      // The FSM reaches `failed` only after exhausting its own reconnection
      // budget — a genuine give-up. Clear the slot so the signals carrier
      // can take the peer back and the next ping/pong re-initiates.
      return { handler: 'media-closed', reason: 'gave-up' };

    case 'idle':
      // `failed` auto-transitions to `idle` after 5s, and entering `idle`
      // from `failed` destroys the `RTCPeerConnection`. Whatever the slot
      // still claims, there is no connection behind it.
      //
      // **Defensive, and believed unreachable today.** `ConnectionManager`
      // now closes an FSM as soon as it reaches `failed`, so its
      // failed-cleanup timer finds the state already `closed` and the
      // `idle` transition never fires. The one FSM that can still reach
      // `idle` is a superseded one, whose event `_handleMediaClosed`
      // discards on connectionId anyway. Do not read this row as evidence
      // the path is exercised — nothing asserts that it runs, only that it
      // would be answered correctly if it did.
      return { handler: 'media-closed', reason: 'peer-destroyed' };

    case 'closed':
      return { handler: 'media-closed', reason: 'transport-closed' };

    default: {
      const exhaustive: never = input.phase;
      return exhaustive;
    }
  }
}
