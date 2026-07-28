/**
 * Phase 1 — pure decision logic for the pong-driven stale-connection
 * supervisor.
 *
 * Every 2s, for each peer that pongs, `handlePongUi` asks: does the app
 * still hold a connection slot whose underlying `RTCPeerConnection` is
 * dead? The predicate was written inline three times, verbatim
 * (MAINTAINABILITY_ASSESSMENT.md §3.9) — once for video and twice for
 * outgoing screen share — each followed by a different cleanup set. This
 * file is the single authority for the *predicate*, and (since Phase 2b)
 * for the *cleanup sets*: `staleTeardownPlan` states, per target, which
 * slot and pending map a teardown clears, and
 * `StreamsStore._applyStaleTeardown` is the one executor all three sites
 * call.
 *
 * Two behavioural changes are folded in, both deliberate:
 *
 *   - **`carrierOwnsRecovery`** (Phase 1 item 4). The FSM carrier runs its
 *     own recovery — ICE restart, full reconnect, a 15s disconnected-grace.
 *     This supervisor was built for SimplePeer and never retired when the
 *     FSM landed, so on an ICE failure the FSM would restart ICE while this
 *     tore the pc down and re-initiated: two controllers racing, producing
 *     the "media flows briefly then suddenly reconnects" churn the code's
 *     own comment warns about (§3.4). When the FSM gives up it emits
 *     `failed`, which now clears the slot via `routeTransportPhase`, so the
 *     give-up decision still gets made — by the party that owns it.
 *
 *   - **`pc-vanished`** (Phase 1 item 5, the zombie row). `iceState` is
 *     `undefined` when there is no pc to ask. That is normal in the window
 *     between installing a slot and creating the peer, and it is also what
 *     a destroyed pc looks like — which is why the old code, having no
 *     branch for `undefined`, could never clean up a connection whose pc
 *     had been destroyed underneath it (§3.1c). The two are told apart by
 *     the slot's own claim: a slot that says `connected` must have had a
 *     pc, so its absence is a zombie; a slot that does not is still being
 *     established.
 *
 * Constrains `streams-store.ts:handlePongUi` and `streams-store.ts:handlePingUi`.
 */

export type StaleConnectionInputs = {
  /** Whether the app still holds a connection slot for this peer. */
  hasExistingConn: boolean;
  /**
   * Whether the slot claims the transport reached ICE + DTLS up. Only read
   * to tell a destroyed pc from one that has not been created yet.
   */
  slotClaimsConnected: boolean;
  /**
   * Whether the carrier holding this connection runs its own transport
   * recovery. True for the FSM, false for SimplePeer. When true this
   * supervisor stands down entirely — see the header.
   */
  carrierOwnsRecovery: boolean;
  /** `pc.iceConnectionState`, or `undefined` when there is no pc to ask. */
  iceState: RTCIceConnectionState | undefined;
  /** When ICE first went 'disconnected' for this connection, if it has. */
  disconnectedAt: number | undefined;
  now: number;
  /** How long 'disconnected' may persist before it counts as failure. */
  graceMs: number;
};

export type StaleConnectionDecision =
  | {
      action: 'keep';
      reason:
        | 'no-connection'
        | 'transport-owns-recovery'
        | 'establishing'
        | 'within-grace'
        | 'ice-healthy';
    }
  | {
      action: 'teardown';
      reason: 'ice-failed' | 'ice-closed' | 'pc-vanished' | 'grace-exceeded';
    };

export function decideStaleConnectionCleanup(
  input: StaleConnectionInputs,
): StaleConnectionDecision {
  if (!input.hasExistingConn) {
    return { action: 'keep', reason: 'no-connection' };
  }

  // Must precede every teardown row below, including `pc-vanished`: a full
  // reconnect legitimately has no pc for a moment while the slot still says
  // connected, and tearing down there is precisely the race this guard
  // exists to stop.
  if (input.carrierOwnsRecovery) {
    return { action: 'keep', reason: 'transport-owns-recovery' };
  }

  if (input.iceState === 'failed') {
    return { action: 'teardown', reason: 'ice-failed' };
  }
  if (input.iceState === 'closed') {
    return { action: 'teardown', reason: 'ice-closed' };
  }

  if (input.iceState === undefined) {
    return input.slotClaimsConnected
      ? { action: 'teardown', reason: 'pc-vanished' }
      : { action: 'keep', reason: 'establishing' };
  }

  if (input.iceState === 'disconnected') {
    // 'disconnected' is recoverable: the browser keeps probing the active
    // candidate pair and may return to 'connected'. Tearing down on the
    // first one aborts that recovery locally *and* — because the
    // InitRequest we would send next supersedes the peer's connection too —
    // interrupts theirs.
    //
    // `disconnectedAt !== undefined`, not `!!disconnectedAt`: the old form
    // read a timestamp of 0 as "never disconnected" and would have held the
    // connection open forever.
    const exceeded =
      input.disconnectedAt !== undefined &&
      input.now - input.disconnectedAt > input.graceMs;
    return exceeded
      ? { action: 'teardown', reason: 'grace-exceeded' }
      : { action: 'keep', reason: 'within-grace' };
  }

  return { action: 'keep', reason: 'ice-healthy' };
}

// ---------------------------------------------------------------------------
// Cleanup sets (Phase 2b)
// ---------------------------------------------------------------------------

/** Which kind of connection a stale teardown is clearing. */
export type StaleTeardownTarget = 'video' | 'screen-share-outgoing';

/**
 * What a stale teardown must clear, per target. Every field names a
 * `StreamsStore` structure; `_applyStaleTeardown` is the single executor.
 */
export type StaleTeardownPlan = {
  /** The connection slot to delete after closing the transport connection. */
  slot: 'open-connections' | 'screen-share-connections-outgoing';
  /**
   * The pending-init map to clear, so the next pong re-initiates cleanly.
   * `none` for screen share since Phase 3 retired its InitRequest
   * handshake — the FSM owns retry and there is no reservation to clear.
   */
  pendingInits: 'video' | 'none';
  /**
   * Whether to drop the peer's entry in `_videoStreams`. Only the video
   * teardown has a per-peer stream slot to clear; `_screenShareStreams`
   * (wired by Phase 3) tracks *incoming* shares and is cleared by the
   * incoming-side close/error handlers, never by this outgoing teardown.
   */
  clearVideoStreamSlot: boolean;
};

/**
 * The formerly-divergent cleanup sets, stated once. Two of the three call
 * sites share the `screen-share-outgoing` row; the divergence between the
 * rows is real (different slots, different pending maps, only video has a
 * stream slot), and the table test pins it so an edit to one row is a
 * visible decision rather than a drift.
 */
export function staleTeardownPlan(target: StaleTeardownTarget): StaleTeardownPlan {
  switch (target) {
    case 'video':
      return {
        slot: 'open-connections',
        pendingInits: 'video',
        clearVideoStreamSlot: true,
      };
    case 'screen-share-outgoing':
      return {
        slot: 'screen-share-connections-outgoing',
        pendingInits: 'none',
        clearVideoStreamSlot: false,
      };
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
