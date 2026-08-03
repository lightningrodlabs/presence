/**
 * Round 3 item 1 (MAINTAINABILITY_ASSESSMENT.md §8) — the ONE per-peer
 * connection-teardown cleanup table.
 *
 * Before this file, the close-path cleanup set was stated five times and
 * had diverged: `_handleMediaError` skipped seven of `_handleMediaClosed`'s
 * cleanups (`_lastQualityBucket`, `_lastWebrtcExitReason`, `_pendingInits`,
 * `_lastBytesReceived`, `_staleCycles`, `_reconcileAttemptCount`,
 * `_iceDisconnectedAt`), never recorded `_lastDisconnectTime`, and never
 * emitted the `CarrierSwitch` forensic event; `_handleScreenShareError`
 * fell through its no-slot guard and re-fired
 * `peer-screen-share-disconnected` into the view on every duplicate error;
 * and the superseded-close arm leaked `_iceTimings` per superseded
 * attempt. `closeCleanupPlan` states the set once, per
 * (target × via × outcome) cell; `StreamsStore._applyCloseCleanup` is the
 * single executor.
 *
 * This file also absorbs Phase 2b's `staleTeardownPlan` (deleted — one
 * authority per concept): its two rows are the `stale-teardown` cells
 * below.
 *
 * ## The transport-close ordering field
 *
 * Every transport's `closeConnection` synchronously emits a final
 * `closed` event (the Phase 2b emit-invariant, pinned in
 * `transport-emit-invariant.test.ts`). That makes ordering part of the
 * cleanup semantics, so the table declares it instead of leaving it to
 * call-site accident:
 *
 * - `'after-slot-clear'` (error paths): the slot is cleared FIRST, so the
 *   nested `closed` event hits the no-slot guard and the error row's own
 *   cleanup set is the complete story.
 * - `'before-slot-clear'` (stale-teardown and peer-leave): the transport
 *   is closed FIRST, so when a live connection object exists the nested
 *   `closed` event runs the full `close-event/live` row synchronously —
 *   that is where the FsmClose/CarrierSwitch forensics and
 *   `peer-disconnected` come from on these paths. The row's own clears
 *   are the residue that must ALSO hold when there is no connection
 *   object behind the slot (the vanished-pc case, where `closeConnection`
 *   emits nothing).
 *
 * Declared behavior changes carried by this table (§8 item 1):
 *  (a) a screen-share error with no matching slot no longer fires
 *      `peer-screen-share-disconnected` (the duplicate-error re-fire was
 *      the divergence, not the spec);
 *  (b) the media error path performs the full close-path cleanup set,
 *      including the `CarrierSwitch webrtc->signals` forensic event;
 *  (c) same-family leak fixes: superseded close/error arms clear the
 *      event connection's `_iceTimings` entry, and the outgoing
 *      screen-share error path clears `_screenShareIceDisconnectedAt`
 *      like its close path does.
 *
 * Constrains `streams-store.ts:_applyCloseCleanup` and its callers
 * (`_handleMediaClosed`, `_handleMediaError`, `_handleScreenShareClosed`,
 * `_handleScreenShareError`, `_applyStaleTeardown`, `handleLeaveUi`).
 */

/** Which connection family is being torn down. */
export type CloseCleanupTarget =
  | 'media'
  | 'screen-share-outgoing'
  | 'screen-share-incoming';

/** Which path is tearing it down. */
export type CloseCleanupVia =
  | 'close-event'
  | 'error-event'
  | 'stale-teardown'
  | 'peer-leave';

/**
 * The slot-guard outcome. For event-driven paths this is the
 * `decideSlotWrite` result ('clear' → 'live'); for `stale-teardown` the
 * caller has already verified the slot exists ('live'); for `peer-leave`
 * it is simply whether a slot exists.
 */
export type CloseCleanupOutcome = 'live' | 'superseded' | 'no-slot';

export type CloseCleanupContext = {
  target: CloseCleanupTarget;
  via: CloseCleanupVia;
  outcome: CloseCleanupOutcome;
};

/**
 * Every field names a `StreamsStore` structure or side effect. A field
 * absent from a row (false/'none') is a decision, pinned by the table
 * test — not an omission.
 */
export type CloseCleanupPlan = {
  /** Row tag, for logs and table-test readability. */
  reason: string;
  /** Log the Superseded{Close,Error} forensic event (handler-side — the
   *  event name and detail differ per caller). */
  logSuperseded: boolean;
  /** `transport.closeConnection` and when, relative to the slot clear.
   *  See the header for why the ordering is semantics, not style. */
  closeTransport: 'none' | 'before-slot-clear' | 'after-slot-clear';
  /** Delete the target's connection slot
   *  (`_openConnections` / `_screenShareConnections{Outgoing,Incoming}`). */
  clearSlot: boolean;
  /** `_clearIceTiming(peer, eventConnectionId)` — connection-scoped. */
  clearIceTiming: boolean;
  /** `_emitIceNeverConnected(peer, eventConnectionId)` — must run before
   *  `clearIceTiming` wipes the record; the executor owns that order. */
  emitIceNeverConnected: boolean;
  clearVideoStreamSlot: boolean;
  clearPendingInits: boolean;
  clearLastBytesReceived: boolean;
  clearStaleCycles: boolean;
  clearReconcileAttemptCount: boolean;
  clearIceDisconnectedAt: boolean;
  clearQualityBucket: boolean;
  clearWebrtcExitReason: boolean;
  /** Stamp `_lastDisconnectTime[peer] = now` (init-retry cooldown input). */
  recordLastDisconnect: boolean;
  /** Wipe `perceivedStreamInfo` in `_othersConnectionStatuses`. */
  clearPerceivedStreamInfo: boolean;
  removeAudioAnalyser: boolean;
  clearWebrtcStats: boolean;
  /** Emit `CarrierSwitch webrtc->signals` IF the slot claimed
   *  `connected` at entry (the executor reads that before clearing). */
  emitCarrierSwitch: boolean;
  /** Media rows: also tear down the peer's outgoing screen share. */
  teardownOutgoingScreenShare: boolean;
  /** Incoming screen rows: drop `_screenShareStreams[peer]` so
   *  paint-restore cannot resurrect a dead share. */
  clearScreenShareStream: boolean;
  /** Outgoing screen rows: drop `_screenShareIceDisconnectedAt[peer]`. */
  clearScreenShareIceDisconnectedAt: boolean;
  fireEvent: 'peer-disconnected' | 'peer-screen-share-disconnected' | 'none';
  setDisconnectedStatus: 'media' | 'screen-share' | 'none';
};

const NONE: Omit<CloseCleanupPlan, 'reason'> = {
  logSuperseded: false,
  closeTransport: 'none',
  clearSlot: false,
  clearIceTiming: false,
  emitIceNeverConnected: false,
  clearVideoStreamSlot: false,
  clearPendingInits: false,
  clearLastBytesReceived: false,
  clearStaleCycles: false,
  clearReconcileAttemptCount: false,
  clearIceDisconnectedAt: false,
  clearQualityBucket: false,
  clearWebrtcExitReason: false,
  recordLastDisconnect: false,
  clearPerceivedStreamInfo: false,
  removeAudioAnalyser: false,
  clearWebrtcStats: false,
  emitCarrierSwitch: false,
  teardownOutgoingScreenShare: false,
  clearScreenShareStream: false,
  clearScreenShareIceDisconnectedAt: false,
  fireEvent: 'none',
  setDisconnectedStatus: 'none',
};

/** The full media close set — the one authority for "what a media
 *  connection's death must clean up". Close and error rows share it;
 *  error additionally drives the transport close. */
const MEDIA_FULL: Omit<CloseCleanupPlan, 'reason' | 'closeTransport'> = {
  ...NONE,
  clearSlot: true,
  clearIceTiming: true,
  emitIceNeverConnected: true,
  clearVideoStreamSlot: true,
  clearPendingInits: true,
  clearLastBytesReceived: true,
  clearStaleCycles: true,
  clearReconcileAttemptCount: true,
  clearIceDisconnectedAt: true,
  clearQualityBucket: true,
  clearWebrtcExitReason: true,
  recordLastDisconnect: true,
  clearPerceivedStreamInfo: true,
  removeAudioAnalyser: true,
  clearWebrtcStats: true,
  emitCarrierSwitch: true,
  teardownOutgoingScreenShare: true,
  fireEvent: 'peer-disconnected',
  setDisconnectedStatus: 'media',
};

export function closeCleanupPlan(ctx: CloseCleanupContext): CloseCleanupPlan {
  switch (ctx.target) {
    case 'media':
      switch (ctx.via) {
        case 'close-event':
          switch (ctx.outcome) {
            case 'live':
              return { reason: 'media-close', ...MEDIA_FULL, closeTransport: 'none' };
            case 'superseded':
              // logSuperseded + clearIceTiming: the superseded-close
              // `_iceTimings` leak dies here as a table row.
              return { reason: 'media-close-superseded', ...NONE, logSuperseded: true, clearIceTiming: true };
            case 'no-slot':
              return { reason: 'media-close-duplicate', ...NONE, clearIceTiming: true };
          }
          break;
        case 'error-event':
          switch (ctx.outcome) {
            case 'live':
              // Declared change (b): the error path performs the full
              // close set. It closes the transport AFTER the slot clear
              // so the nested `closed` hits the no-slot guard.
              return { reason: 'media-error', ...MEDIA_FULL, closeTransport: 'after-slot-clear' };
            case 'superseded':
              return { reason: 'media-error-superseded', ...NONE, logSuperseded: true, clearIceTiming: true };
            case 'no-slot':
              return { reason: 'media-error-duplicate', ...NONE, clearIceTiming: true };
          }
          break;
        case 'stale-teardown':
          switch (ctx.outcome) {
            case 'live':
              // Close-first delegation: with a live connection object the
              // nested `closed` runs the full media-close row; the clears
              // here are the residue that must also hold when the pc has
              // vanished and `closeConnection` emits nothing.
              return {
                reason: 'media-stale',
                ...NONE,
                closeTransport: 'before-slot-clear',
                clearSlot: true,
                clearPendingInits: true,
                clearVideoStreamSlot: true,
              };
            case 'superseded':
            case 'no-slot':
              // The stale supervisor only runs against an existing slot.
              return { reason: 'media-stale-unreachable', ...NONE };
          }
          break;
        case 'peer-leave':
          switch (ctx.outcome) {
            case 'live':
              return {
                reason: 'media-leave',
                ...NONE,
                closeTransport: 'before-slot-clear',
                clearSlot: true,
                clearVideoStreamSlot: true,
                clearPendingInits: true,
                clearQualityBucket: true,
                setDisconnectedStatus: 'media',
              };
            case 'no-slot':
              // handleLeaveUi's map clears were unconditional; preserved.
              return {
                reason: 'media-leave-no-slot',
                ...NONE,
                clearVideoStreamSlot: true,
                clearPendingInits: true,
                clearQualityBucket: true,
                setDisconnectedStatus: 'media',
              };
            case 'superseded':
              return { reason: 'media-leave-unreachable', ...NONE };
          }
          break;
        default: {
          const exhaustive: never = ctx.via;
          return exhaustive;
        }
      }
      break;

    case 'screen-share-outgoing':
      switch (ctx.via) {
        case 'close-event':
          switch (ctx.outcome) {
            case 'live':
              return {
                reason: 'screen-out-close',
                ...NONE,
                clearSlot: true,
                clearScreenShareIceDisconnectedAt: true,
                setDisconnectedStatus: 'screen-share',
              };
            case 'superseded':
            case 'no-slot':
              return { reason: 'screen-out-close-guarded', ...NONE };
          }
          break;
        case 'error-event':
          switch (ctx.outcome) {
            case 'live':
              return {
                reason: 'screen-out-error',
                ...NONE,
                closeTransport: 'after-slot-clear',
                clearSlot: true,
                clearScreenShareIceDisconnectedAt: true,
                setDisconnectedStatus: 'screen-share',
              };
            case 'superseded':
              return { reason: 'screen-out-error-superseded', ...NONE, logSuperseded: true };
            case 'no-slot':
              // Duplicate error: still drive the transport close (no-op if
              // already closed, tears down an orphan FSM otherwise) but
              // nothing else — no view event, no slot to clear.
              return {
                reason: 'screen-out-error-duplicate',
                ...NONE,
                closeTransport: 'after-slot-clear',
                setDisconnectedStatus: 'screen-share',
              };
          }
          break;
        case 'stale-teardown':
          switch (ctx.outcome) {
            case 'live':
              return {
                reason: 'screen-out-stale',
                ...NONE,
                closeTransport: 'before-slot-clear',
                clearSlot: true,
              };
            case 'superseded':
            case 'no-slot':
              return { reason: 'screen-out-stale-unreachable', ...NONE };
          }
          break;
        case 'peer-leave':
          switch (ctx.outcome) {
            case 'live':
              return {
                reason: 'screen-out-leave',
                ...NONE,
                closeTransport: 'before-slot-clear',
                clearSlot: true,
                setDisconnectedStatus: 'screen-share',
              };
            case 'no-slot':
              // Status was set unconditionally on leave; the outgoing row
              // carries it so it is set exactly once per leave.
              return { reason: 'screen-out-leave-no-slot', ...NONE, setDisconnectedStatus: 'screen-share' };
            case 'superseded':
              return { reason: 'screen-out-leave-unreachable', ...NONE };
          }
          break;
        default: {
          const exhaustive: never = ctx.via;
          return exhaustive;
        }
      }
      break;

    case 'screen-share-incoming':
      switch (ctx.via) {
        case 'close-event':
          switch (ctx.outcome) {
            case 'live':
              return {
                reason: 'screen-in-close',
                ...NONE,
                clearSlot: true,
                clearScreenShareStream: true,
                fireEvent: 'peer-screen-share-disconnected',
                setDisconnectedStatus: 'screen-share',
              };
            case 'superseded':
            case 'no-slot':
              return { reason: 'screen-in-close-guarded', ...NONE };
          }
          break;
        case 'error-event':
          switch (ctx.outcome) {
            case 'live':
              return {
                reason: 'screen-in-error',
                ...NONE,
                closeTransport: 'after-slot-clear',
                clearSlot: true,
                clearScreenShareStream: true,
                fireEvent: 'peer-screen-share-disconnected',
                setDisconnectedStatus: 'screen-share',
              };
            case 'superseded':
              return { reason: 'screen-in-error-superseded', ...NONE, logSuperseded: true };
            case 'no-slot':
              // Declared change (a): the duplicate-error re-fire of
              // `peer-screen-share-disconnected` is gone. A stale stream
              // entry is still dropped.
              return {
                reason: 'screen-in-error-duplicate',
                ...NONE,
                closeTransport: 'after-slot-clear',
                clearScreenShareStream: true,
                setDisconnectedStatus: 'screen-share',
              };
          }
          break;
        case 'stale-teardown':
          // The viewer side has no stale supervisor.
          return { reason: 'screen-in-stale-unreachable', ...NONE };
        case 'peer-leave':
          switch (ctx.outcome) {
            case 'live':
              return {
                reason: 'screen-in-leave',
                ...NONE,
                closeTransport: 'before-slot-clear',
                clearSlot: true,
                clearScreenShareStream: true,
              };
            case 'no-slot':
              return { reason: 'screen-in-leave-no-slot', ...NONE, clearScreenShareStream: true };
            case 'superseded':
              return { reason: 'screen-in-leave-unreachable', ...NONE };
          }
          break;
        default: {
          const exhaustive: never = ctx.via;
          return exhaustive;
        }
      }
      break;

    default: {
      const exhaustive: never = ctx.target;
      return exhaustive;
    }
  }
  // Outcome switches above are exhaustive over the union; TS cannot see
  // that through the nested breaks.
  const unreachable: never = ctx.outcome as never;
  return unreachable;
}
