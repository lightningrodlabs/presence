/**
 * Phase 2b — pure decision logic for the pong-driven InitRequest send/retry.
 *
 * On every pong, `handlePongUi` decides whether to (re)send an InitRequest
 * to the ponging peer — once for the video connection, once for the
 * outgoing screen share. The two inline copies were *not* identical, and
 * the differences are resolved here as decisions rather than silently
 * merged (MAINTAINABILITY_ASSESSMENT.md, Phase 2b item 4):
 *
 *   - **Tie-break.** Video connections are symmetric — both peers pong
 *     each other, so without a rule both would race to initiate. The rule
 *     is: the peer whose pubkey is alphabetically *higher* initiates
 *     toward the lower (`peer < mine` on the initiator's side; the
 *     acceptor mirror-guards `peer > mine` in `handleInitRequest`). The
 *     outgoing screen share has **no tie-break on purpose**: only the
 *     sharer runs this path at all, so the link is directional and there
 *     is no race to break.
 *
 *   - **Status re-assertion.** While a pending init is inside the retry
 *     threshold, the video path writes no status; the screen path
 *     re-asserts `InitSent` on every pong. Kept divergent deliberately —
 *     unifying either way changes observable screen-share behavior, and
 *     this table is where that change would be made on purpose. The
 *     `setStatusInitSent` field carries the divergence to the caller.
 *
 * Not this function's problem: the `conversationActive` / per-peer
 * webrtc-disabled gate (video) and the is-sharing gate (screen) stay at
 * the call sites, as does the `handlePingUi` screen-share block — that
 * site sends only *first* inits, never retries, and routing it through
 * this function would add retry traffic to every ping.
 *
 * Constrains `streams-store.ts:handlePongUi`.
 */

export type InitRetryInputs = {
  kind: 'video' | 'screen-share';
  /** Whether a connection slot already exists for this peer
   *  (`_openConnections` / `_screenShareConnectionsOutgoing`). */
  alreadyOpen: boolean;
  myPubKeyB64: string;
  peerPubKeyB64: string;
  /** `t0` timestamps of inits already sent to this peer; undefined when
   *  none have been sent (distinct from an empty list, which the store
   *  never produces but which is treated the same way). */
  pendingInitT0s: number[] | undefined;
  now: number;
  /** How long the latest init may sit unanswered before resending. */
  retryThresholdMs: number;
};

export type InitRetryDecision =
  | {
      action: 'send-init';
      /** 1 for a first init, pending-count + 1 for a retry. */
      attempt: number;
      setStatusInitSent: true;
      reason: 'no-pending-init' | 'retry-threshold-exceeded';
    }
  | {
      action: 'hold';
      /**
       * True only on the screen-share `within-threshold` row — the
       * status re-assertion divergence described in the header.
       */
      setStatusInitSent: boolean;
      reason: 'already-open' | 'peer-initiates' | 'within-threshold';
    }
  | {
      /** Video only: the peer holds the initiator role and we have
       *  nothing pending — advertise `AwaitingInit`. */
      action: 'await-peer-init';
      reason: 'peer-initiates-no-pending';
    };

export function decideInitRetry(input: InitRetryInputs): InitRetryDecision {
  const hasPending =
    input.pendingInitT0s !== undefined && input.pendingInitT0s.length > 0;

  if (input.alreadyOpen) {
    return { action: 'hold', setStatusInitSent: false, reason: 'already-open' };
  }

  // The tie-break row. Video defers to the peer when our pubkey is not
  // the higher one; screen share never defers (see header).
  if (input.kind === 'video' && !(input.peerPubKeyB64 < input.myPubKeyB64)) {
    return hasPending
      ? { action: 'hold', setStatusInitSent: false, reason: 'peer-initiates' }
      : { action: 'await-peer-init', reason: 'peer-initiates-no-pending' };
  }

  if (!hasPending) {
    return {
      action: 'send-init',
      attempt: 1,
      setStatusInitSent: true,
      reason: 'no-pending-init',
    };
  }

  const latestT0 = Math.max(...input.pendingInitT0s!);
  if (input.now - latestT0 > input.retryThresholdMs) {
    return {
      action: 'send-init',
      attempt: input.pendingInitT0s!.length + 1,
      setStatusInitSent: true,
      reason: 'retry-threshold-exceeded',
    };
  }

  // The status re-assertion row (see header).
  return {
    action: 'hold',
    setStatusInitSent: input.kind === 'screen-share',
    reason: 'within-threshold',
  };
}
