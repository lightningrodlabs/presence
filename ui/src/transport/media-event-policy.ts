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
  /** Whether `_openConnections` already holds an entry for this peer. */
  hasOpenConnection: boolean;
};

export type TransportPhaseRoute =
  /**
   * Begin watching this connection's ICE state. `installSlot` additionally
   * asks the caller to create the `_openConnections` entry: the FSM
   * acceptor path builds a connection from an incoming offer without
   * streams-store knowing in advance, so the slot has to be installed here
   * for later connect/stream events to have something to mutate. The
   * SimplePeer acceptor and both initiator paths install it themselves in
   * `handleSdpData` / `handleInitAccept`.
   */
  | { handler: 'start-ice-monitor'; installSlot: boolean; reason: 'signaling-started' }
  | { handler: 'media-connected'; reason: 'transport-up' }
  | {
      handler: 'media-closed';
      reason: 'transport-closed' | 'gave-up' | 'peer-destroyed';
    }
  | { handler: 'ignore'; reason: 'establishing' | 'transport-owns-recovery' };

export function routeTransportPhase(
  input: TransportPhaseInputs,
): TransportPhaseRoute {
  switch (input.phase) {
    case 'signaling':
      return {
        handler: 'start-ice-monitor',
        installSlot: input.impl === 'fsm' && !input.hasOpenConnection,
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
      return { handler: 'media-closed', reason: 'peer-destroyed' };

    case 'closed':
      return { handler: 'media-closed', reason: 'transport-closed' };

    default: {
      const exhaustive: never = input.phase;
      return exhaustive;
    }
  }
}
