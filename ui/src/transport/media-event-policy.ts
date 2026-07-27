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
  /** Which media transport emitted the event. */
  impl: 'simplepeer' | 'fsm';
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
 *   have something to mutate. The SimplePeer acceptor and both initiator
 *   paths create it themselves in `handleSdpData` / `handleInitAccept`.
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
 * - `keep` — the slot already matches, or this is SimplePeer, whose slot
 *   the store owns.
 */
export type SlotAction =
  | { action: 'install' }
  | { action: 'adopt'; supersedes: string }
  | { action: 'keep' };

export type TransportPhaseRoute =
  | { handler: 'start-ice-monitor'; slot: SlotAction; reason: 'signaling-started' }
  | { handler: 'media-connected'; reason: 'transport-up' }
  | {
      handler: 'media-closed';
      reason: 'transport-closed' | 'gave-up' | 'peer-destroyed';
    }
  | { handler: 'ignore'; reason: 'establishing' | 'transport-owns-recovery' };

function slotActionFor(input: TransportPhaseInputs): SlotAction {
  // SimplePeer honours the connectionId the store hands it, and the store
  // writes the slot itself on both its paths. Nothing to do here, and
  // adopting would fight the supersede semantics those paths rely on.
  if (input.impl !== 'fsm') return { action: 'keep' };
  if (input.openConnectionId === undefined) return { action: 'install' };
  if (input.openConnectionId === input.connectionId) return { action: 'keep' };
  return { action: 'adopt', supersedes: input.openConnectionId };
}

export function routeTransportPhase(
  input: TransportPhaseInputs,
): TransportPhaseRoute {
  switch (input.phase) {
    case 'signaling':
      return {
        handler: 'start-ice-monitor',
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
