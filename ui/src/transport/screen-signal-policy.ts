/**
 * Phase 3 item 2 — pure decision logic for routing an incoming
 * `SdpFsmScreen` signal to one of the two screen-share FSM transports.
 *
 * The FSM allocates a connectionId per *side*, so the id on the wire is
 * the sender's and cannot select a local transport (the trick the
 * SimplePeer screen path used). Routing is instead by the sender's
 * declared role: a signal from the peer's **sharer** side belongs to our
 * incoming-share transport; a signal from their **viewer** side answers
 * our outgoing share. Mutual sharing is both matches at once on two
 * independent connections.
 *
 * Anything else — a missing `dir`, an unknown value, a non-string — is a
 * drop with a reason, never a guess: mis-routing an offer would create a
 * phantom connection on the wrong transport.
 *
 * Constrains `streams-store.ts:handleSdpFsmScreen`.
 */

export type ScreenSignalRoute =
  | { route: 'incoming-share'; reason: 'peer-is-sharer' }
  | { route: 'outgoing-share'; reason: 'peer-is-viewer' }
  | { route: 'drop'; reason: 'missing-or-unknown-dir' };

export function decideScreenSignalRoute(dir: unknown): ScreenSignalRoute {
  switch (dir) {
    case 'sharer':
      return { route: 'incoming-share', reason: 'peer-is-sharer' };
    case 'viewer':
      return { route: 'outgoing-share', reason: 'peer-is-viewer' };
    default:
      return { route: 'drop', reason: 'missing-or-unknown-dir' };
  }
}
