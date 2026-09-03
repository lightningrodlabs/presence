/**
 * Phase 2b — pure decision logic for the pong-driven InitRequest send/retry.
 *
 * On every pong, `handlePongUi` decides whether to (re)send a video
 * InitRequest to the ponging peer.
 *
 * Since Phase 3 this serves the video connection only: the screen-share
 * port replaced that path's InitRequest cadence with an idempotent
 * `ScreenShareLinks.ensureOutgoingScreenShare`
 * (ui/src/screen-share-links.ts; store-decomposition round two, Task 5 —
 * previously `StreamsStore._ensureOutgoingScreenShare`) — the FSM
 * acceptor needs no reservation and the FSM owns retry — which deleted
 * this function's `kind` axis and both
 * divergences the extraction had preserved (the screen path's missing
 * tie-break and its InitSent re-assertion).
 *
 *   - **Tie-break.** Video connections are symmetric — both peers pong
 *     each other, so without a rule both would race to initiate. The rule
 *     is: the peer whose pubkey is alphabetically *higher* initiates
 *     toward the lower (`peer < mine` on the initiator's side; the
 *     acceptor mirror-guards `peer > mine` in `handleInitRequest`).
 *
 * Not this function's problem: the `conversationActive` / per-peer
 * webrtc-disabled gate stays at the call site.
 *
 * Constrains `streams-store.ts:handlePongUi`.
 */

export type InitRetryInputs = {
  /** Whether a connection slot already exists for this peer
   *  (`_openConnections`). */
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
      reason: 'no-pending-init' | 'retry-threshold-exceeded';
    }
  | {
      action: 'hold';
      reason: 'already-open' | 'peer-initiates' | 'within-threshold';
    }
  | {
      /** The peer holds the initiator role and we have nothing pending —
       *  advertise `AwaitingInit`. */
      action: 'await-peer-init';
      reason: 'peer-initiates-no-pending';
    };

export function decideInitRetry(input: InitRetryInputs): InitRetryDecision {
  const hasPending =
    input.pendingInitT0s !== undefined && input.pendingInitT0s.length > 0;

  if (input.alreadyOpen) {
    return { action: 'hold', reason: 'already-open' };
  }

  // The tie-break row: defer to the peer when our pubkey is not the
  // higher one.
  if (!(input.peerPubKeyB64 < input.myPubKeyB64)) {
    return hasPending
      ? { action: 'hold', reason: 'peer-initiates' }
      : { action: 'await-peer-init', reason: 'peer-initiates-no-pending' };
  }

  if (!hasPending) {
    return {
      action: 'send-init',
      attempt: 1,
      reason: 'no-pending-init',
    };
  }

  const latestT0 = Math.max(...input.pendingInitT0s!);
  if (input.now - latestT0 > input.retryThresholdMs) {
    return {
      action: 'send-init',
      attempt: input.pendingInitT0s!.length + 1,
      reason: 'retry-threshold-exceeded',
    };
  }

  return { action: 'hold', reason: 'within-threshold' };
}
