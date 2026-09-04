/**
 * Round 3 item 1 (MAINTAINABILITY_ASSESSMENT.md §8) — the ONE per-peer
 * connection-teardown cleanup table.
 *
 * Before this file, the close-path cleanup set was stated five times and
 * had diverged (the superseded-close arm leaked `_iceTimings` per
 * superseded attempt; the two error handlers hand-rolled divergent
 * guards). `closeCleanupPlan` states the set once, per
 * (target × via × outcome) cell; `StreamsStore._applyCloseCleanup` is the
 * single executor. This file also absorbs Phase 2b's `staleTeardownPlan`
 * (deleted — one authority per concept): its two rows are the
 * `stale-teardown` cells below.
 *
 * ## Task 4 (peer-record-consolidation round): field-level clears moved out
 *
 * This table used to carry 14 per-peer boolean fields, one per
 * `PeerRecord` field cleared on teardown (`clearVideoStreamSlot`,
 * `clearPendingInits`, `clearLastBytesReceived`, `clearStaleCycles`,
 * `clearReconcileAttemptCount`, `clearIceDisconnectedAt`,
 * `clearQualityBucket`, `clearWebrtcExitReason`, `clearLastDisconnectTime`,
 * `clearLastReconcileTime`, `clearSignalsRttEwma`, `clearScreenShareStream`,
 * `clearScreenShareIceDisconnectedAt`, `removeAudioAnalyser`). That
 * field-level knowledge now lives in the ONE authority `resetPeerRecord`
 * (`../peer-record.ts`, table-tested in `../__tests__/peer-record.test.ts`);
 * this table now names only WHICH arm runs
 * (`recordReset: PeerRecordResetArm | 'none'`) and keeps routing,
 * ordering, and event fields. The row → arm mapping is strict fidelity:
 * each row's old boolean set equals its arm's field set exactly (see
 * docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md,
 * "Lifecycle: resetPeerRecord and the closeCleanupPlan collapse", and the
 * per-row pins in `__tests__/close-cleanup-policy.test.ts`).
 *
 * ## Errors are NOT a teardown path (amended 2026-08-04, review F2)
 *
 * The first cut of this table carried `error-event` rows performing the
 * full close set. Review F2 established that transport `error` events
 * had NO production producer — `ConnectionManager` had dropped FSM error
 * events since the FSM carrier landed (SimplePeer's `peer.on('error')`,
 * for which the store's error-teardown was written, was the last real
 * producer, deleted in Phase 3). Under the FSM the contract is
 * different: errors are SYMPTOMS (a negotiation exception the FSM will
 * retry, a data-channel error its watchdog recovers) and the give-up
 * VERDICT arrives as the `failed` phase. Wiring errors to teardown would
 * have re-created the dual-recovery-controller race (§3.4). So the
 * error path is forensic-only — the manager now forwards FSM errors, the
 * transport emits them (minus blocked-transition records, declared in
 * `fsm-transport.ts`), and the store handlers log `FsmError` /
 * `SupersededError` and touch NOTHING else. The error rows were deleted
 * from this table; the log-only invariant is pinned in
 * `streams-store-wiring.test.ts`.
 *
 * ## The transport-close ordering field
 *
 * Every transport's `closeConnection` synchronously emits a final
 * `closed` event (the Phase 2b emit-invariant, pinned in
 * `transport-emit-invariant.test.ts`). That makes ordering part of the
 * cleanup semantics, so the table declares it: `'before-slot-clear'`
 * (stale-teardown and peer-leave) closes the transport FIRST, so when a
 * live connection object exists the nested `closed` event runs the full
 * `close-event/live` row synchronously — that is where the
 * FsmClose/CarrierSwitch forensics and `peer-disconnected` come from on
 * these paths. The row's own clears are the residue that must ALSO hold
 * when there is no connection object behind the slot (the vanished-pc
 * case, where `closeConnection` emits nothing). `close-event` rows never
 * close the transport (it just closed).
 *
 * Declared behavior changes carried by this table (§8 item 1 as
 * amended): the superseded-close arm now clears the event connection's
 * `_iceTimings` entry (the leak dies as a table row). The original
 * item's error-path behavior claims were retracted as field claims —
 * they described a path with no producer (see the amendment in §8
 * item 1).
 *
 * Constrains `streams-store.ts:_applyCloseCleanup` (a bare delegate onto
 * `media-links.ts:MediaLinks.applyCloseCleanup` since store-decomposition
 * round three, Task 3 — the real executor lives there now) and its
 * callers (`MediaLinks._handleMediaClosed`/`applyStaleTeardown`, both in
 * `media-links.ts`, plus `streams-store.ts:handleLeaveUi`) and
 * `ui/src/screen-share-links.ts:ScreenShareLinks._handleScreenShareClosed`
 * (store-decomposition round two, Task 5).
 */
import type { PeerRecordResetArm } from '../peer-record';
import type { SlotWrite } from './media-event-policy';

/** Which connection family is being torn down. */
export type CloseCleanupTarget =
  | 'media'
  | 'screen-share-outgoing'
  | 'screen-share-incoming';

/** Which path is tearing it down. (No `error-event`: errors are
 *  forensic-only since the F2 amendment — see the header.) */
export type CloseCleanupVia =
  | 'close-event'
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
  /** Log the SupersededClose forensic event (handler-side). The log-only
   *  error handlers log SupersededError themselves — they never consult
   *  this table. */
  logSuperseded: boolean;
  /** `transport.closeConnection` and when, relative to the slot clear.
   *  See the header for why the ordering is semantics, not style. */
  closeTransport: 'none' | 'before-slot-clear';
  /** Delete the target's connection slot
   *  (`_openConnections` / `_screenShareConnections{Outgoing,Incoming}`). */
  clearSlot: boolean;
  /** `_clearIceTiming(peer, eventConnectionId)` — connection-scoped. */
  clearIceTiming: boolean;
  /** `_emitIceNeverConnected(peer, eventConnectionId)` — must run before
   *  `clearIceTiming` wipes the record; the executor owns that order. */
  emitIceNeverConnected: boolean;
  /**
   * Which `resetPeerRecord` arm to run against this peer's record, or
   * `'none'`. Replaces the 14 field-level clear booleans this table used
   * to carry directly — see the Task 4 header note above. Field-level
   * survivor semantics (what a close keeps vs. what a leave wipes,
   * including `clearLastDisconnectTime`/`clearLastReconcileTime`/
   * `clearSignalsRttEwma`'s old rejoin-inheritance rule, and the analyser
   * reference-drop) are documented on `resetPeerRecord` and its arm
   * tests in `../__tests__/peer-record.test.ts`.
   */
  recordReset: PeerRecordResetArm | 'none';
  /** Stamp the peer record's `lastDisconnectTime` (init-retry cooldown input).
   *  On `media-leave`/live the nested close-event row stamps this first
   *  (transport closes before the clears); the executor then applies
   *  `recordReset`'s `'media-leave-residue'` arm, which wipes
   *  `lastDisconnectTime` again — the delete wins, pinned in the wiring
   *  suite. */
  recordLastDisconnect: boolean;
  /** Wipe `perceivedStreamInfo` in `_othersConnectionStatuses`. */
  clearPerceivedStreamInfo: boolean;
  clearWebrtcStats: boolean;
  /** Emit `CarrierSwitch webrtc->signals` IF the slot claimed
   *  `connected` at entry (the executor reads that before clearing). */
  emitCarrierSwitch: boolean;
  /** Media rows: also tear down the peer's outgoing screen share. */
  teardownOutgoingScreenShare: boolean;
  fireEvent: 'peer-disconnected' | 'peer-screen-share-disconnected' | 'none';
  setDisconnectedStatus: 'media' | 'screen-share' | 'none';
};

const NONE: Omit<CloseCleanupPlan, 'reason'> = {
  logSuperseded: false,
  closeTransport: 'none',
  clearSlot: false,
  clearIceTiming: false,
  emitIceNeverConnected: false,
  recordReset: 'none',
  recordLastDisconnect: false,
  clearPerceivedStreamInfo: false,
  clearWebrtcStats: false,
  emitCarrierSwitch: false,
  teardownOutgoingScreenShare: false,
  fireEvent: 'none',
  setDisconnectedStatus: 'none',
};

/** The full media close set — the one authority for "what a media
 *  connection's death must clean up". */
const MEDIA_FULL: Omit<CloseCleanupPlan, 'reason' | 'closeTransport'> = {
  ...NONE,
  clearSlot: true,
  clearIceTiming: true,
  emitIceNeverConnected: true,
  recordReset: 'media-close-full',
  recordLastDisconnect: true,
  clearPerceivedStreamInfo: true,
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
                recordReset: 'media-stale-residue',
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
                recordReset: 'media-leave-residue',
                setDisconnectedStatus: 'media',
              };
            case 'no-slot':
              // handleLeaveUi's map clears were unconditional; preserved.
              return {
                reason: 'media-leave-no-slot',
                ...NONE,
                recordReset: 'media-leave-residue',
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
                recordReset: 'screen-out-close',
                setDisconnectedStatus: 'screen-share',
              };
            case 'superseded':
            case 'no-slot':
              return { reason: 'screen-out-close-guarded', ...NONE };
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
                recordReset: 'screen-in-close',
                fireEvent: 'peer-screen-share-disconnected',
                setDisconnectedStatus: 'screen-share',
              };
            case 'superseded':
            case 'no-slot':
              return { reason: 'screen-in-close-guarded', ...NONE };
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
                recordReset: 'screen-in-close',
              };
            case 'no-slot':
              return { reason: 'screen-in-leave-no-slot', ...NONE, recordReset: 'screen-in-close' };
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

/**
 * Map a `closed` `decideSlotWrite` result onto this table's outcome axis.
 * Only the guard outcomes a `closed` event can produce appear here;
 * `install`/`replace`/`set-connected` belong to other event kinds and
 * reaching this with one is a programming error. (The log-only error
 * handlers use `attributeSlotEvent` directly — they perform no slot write
 * and never consult this table.) Shared by the media close handler
 * (`media-links.ts:MediaLinks._handleMediaClosed`, moved from
 * `streams-store.ts` in store-decomposition round three, Task 3) and the
 * screen-share one
 * (`ui/src/screen-share-links.ts:ScreenShareLinks._handleScreenShareClosed`)
 * — moved here from `streams-store.ts` in store-decomposition round two,
 * Task 5, so both call sites import the one authority instead of one
 * defining it and the other reaching across modules for it.
 */
export function closeGuardOutcome(write: SlotWrite): CloseCleanupOutcome {
  if (write.write === 'clear') return 'live';
  if (write.write === 'none' && write.reason === 'superseded') return 'superseded';
  return 'no-slot';
}
