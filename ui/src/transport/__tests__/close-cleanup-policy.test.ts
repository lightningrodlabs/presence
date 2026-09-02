import { describe, it, expect } from 'vitest';
import { closeCleanupPlan } from '../close-cleanup-policy';
import type {
  CloseCleanupContext,
  CloseCleanupOutcome,
  CloseCleanupPlan,
  CloseCleanupTarget,
  CloseCleanupVia,
} from '../close-cleanup-policy';

/**
 * Round 3 item 1 (as amended by review F2: errors are forensic-only and have no rows here) — every (target × via × outcome) cell answered, the key
 * rows pinned field-by-field, and cross-row invariants swept over the
 * whole table. The independent restatement below is deliberate: the
 * expected objects are written out, not derived from the policy's own
 * helpers, so a dropped cleanup entry is a failing row, not a shared
 * constant silently agreeing with itself.
 *
 * Task 4 (peer-record-consolidation round): the table used to carry 14
 * per-peer clear booleans directly; they are now the one `recordReset`
 * field naming a `PeerRecordResetArm`. This file pins WHICH arm each row
 * selects; the field-level survivor semantics of each arm (what a close
 * keeps vs. what a leave wipes) are pinned once in
 * `../../__tests__/peer-record.test.ts` and cross-referenced below rather
 * than duplicated.
 */

const TARGETS: CloseCleanupTarget[] = [
  'media',
  'screen-share-outgoing',
  'screen-share-incoming',
];
const VIAS: CloseCleanupVia[] = [
  'close-event',
  'stale-teardown',
  'peer-leave',
];
const OUTCOMES: CloseCleanupOutcome[] = ['live', 'superseded', 'no-slot'];

const allCells: CloseCleanupContext[] = TARGETS.flatMap(target =>
  VIAS.flatMap(via => OUTCOMES.map(outcome => ({ target, via, outcome }))),
);

/** Independent statement of an all-off plan (everything false / 'none'). */
const OFF: Omit<CloseCleanupPlan, 'reason'> = {
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

describe('closeCleanupPlan — every cell of the table answers', () => {
  it.each(allCells)('%o returns a plan', ctx => {
    const plan = closeCleanupPlan(ctx);
    expect(typeof plan.reason).toBe('string');
    expect(plan.reason.length).toBeGreaterThan(0);
  });
});

describe('closeCleanupPlan — the media full close set, pinned field-by-field', () => {
  // THE cleanup set item 1 exists to state once. The nine PeerRecord
  // fields the 'media-close-full' arm wipes (iceDisconnectedAt,
  // lastBytesReceived, staleCycles, reconcileAttemptCount, qualityBucket,
  // webrtcExitReason, videoStream, pendingInits, analyser) are pinned
  // field-by-field in peer-record.test.ts's 'media-close-full' case, not
  // duplicated here; this row pins that `recordReset` selects that arm,
  // plus `recordLastDisconnect` and CarrierSwitch. Re-dropping any one is
  // a failing equality, which is the reviewer's mutation check.
  const MEDIA_FULL_EXPECTED: Omit<CloseCleanupPlan, 'reason' | 'closeTransport'> = {
    logSuperseded: false,
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

  it('close-event/live is the full set with no transport close (the transport emitted the close)', () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'close-event', outcome: 'live' }),
    ).toEqual({ reason: 'media-close', closeTransport: 'none', ...MEDIA_FULL_EXPECTED });
  });

});

describe('closeCleanupPlan — the guard rows', () => {
  it("media close/superseded logs and clears the event connection's ice timing, touching nothing else (the _iceTimings leak row)", () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'close-event', outcome: 'superseded' }),
    ).toEqual({
      reason: 'media-close-superseded',
      ...OFF,
      logSuperseded: true,
      clearIceTiming: true,
    });
  });

  it('media close/no-slot (duplicate) clears only the ice timing', () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'close-event', outcome: 'no-slot' }),
    ).toEqual({
      reason: 'media-close-duplicate',
      ...OFF,
      clearIceTiming: true,
    });
  });

  it('screen close guards (superseded and no-slot, both directions) touch nothing', () => {
    for (const target of ['screen-share-outgoing', 'screen-share-incoming'] as const) {
      for (const outcome of ['superseded', 'no-slot'] as const) {
        const plan = closeCleanupPlan({ target, via: 'close-event', outcome });
        expect(plan).toEqual({ reason: plan.reason, ...OFF });
      }
    }
  });

});

describe('closeCleanupPlan — the screen-share live rows', () => {
  it('outgoing close clears the slot and selects the screen-out-close reset arm', () => {
    expect(
      closeCleanupPlan({ target: 'screen-share-outgoing', via: 'close-event', outcome: 'live' }),
    ).toEqual({
      reason: 'screen-out-close',
      ...OFF,
      clearSlot: true,
      recordReset: 'screen-out-close',
      setDisconnectedStatus: 'screen-share',
    });
  });

  it('incoming close clears the slot, selects the screen-in-close reset arm, and fires the view event', () => {
    expect(
      closeCleanupPlan({ target: 'screen-share-incoming', via: 'close-event', outcome: 'live' }),
    ).toEqual({
      reason: 'screen-in-close',
      ...OFF,
      clearSlot: true,
      recordReset: 'screen-in-close',
      fireEvent: 'peer-screen-share-disconnected',
      setDisconnectedStatus: 'screen-share',
    });
  });

});

describe('closeCleanupPlan — the stale rows (former staleTeardownPlan, preserved)', () => {
  it('media stale closes first (delegating the full set to the nested close) and selects the media-stale-residue reset arm as the vanished-pc residue', () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'stale-teardown', outcome: 'live' }),
    ).toEqual({
      reason: 'media-stale',
      ...OFF,
      closeTransport: 'before-slot-clear',
      clearSlot: true,
      recordReset: 'media-stale-residue',
    });
  });

  it('outgoing screen stale clears the slot only — no pending map (Phase 3), no reset arm', () => {
    expect(
      closeCleanupPlan({ target: 'screen-share-outgoing', via: 'stale-teardown', outcome: 'live' }),
    ).toEqual({
      reason: 'screen-out-stale',
      ...OFF,
      closeTransport: 'before-slot-clear',
      clearSlot: true,
    });
  });

  it('the viewer side has no stale supervisor — its stale cells are inert', () => {
    for (const outcome of OUTCOMES) {
      const plan = closeCleanupPlan({
        target: 'screen-share-incoming',
        via: 'stale-teardown',
        outcome,
      });
      expect(plan).toEqual({ reason: 'screen-in-stale-unreachable', ...OFF });
    }
  });
});

describe('closeCleanupPlan — the peer-leave rows (handleLeaveUi semantics, preserved)', () => {
  it('media leave: close-first, the media-leave-residue reset arm, status Disconnected', () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'peer-leave', outcome: 'live' }),
    ).toEqual({
      reason: 'media-leave',
      ...OFF,
      closeTransport: 'before-slot-clear',
      clearSlot: true,
      // §9 item 5 / review M5: the 'media-leave-residue' arm additionally
      // wipes lastDisconnectTime/lastReconcileTime/signalsRttEwma versus
      // 'media-close-full' — a rejoining peer must not inherit the
      // departed session's cooldowns. Field-by-field pin:
      // peer-record.test.ts's 'media-leave-residue' case.
      recordReset: 'media-leave-residue',
      setDisconnectedStatus: 'media',
    });
  });

  it('media leave with no slot still selects the media-leave-residue reset arm (the clears were unconditional)', () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'peer-leave', outcome: 'no-slot' }),
    ).toEqual({
      reason: 'media-leave-no-slot',
      ...OFF,
      recordReset: 'media-leave-residue',
      setDisconnectedStatus: 'media',
    });
  });

  it('the screen-share status is set exactly once per leave — carried by the outgoing rows only', () => {
    const statusSetters = (['live', 'no-slot'] as const).flatMap(outcome =>
      (['screen-share-outgoing', 'screen-share-incoming'] as const).map(target => ({
        target,
        plan: closeCleanupPlan({ target, via: 'peer-leave', outcome }),
      })),
    );
    for (const { target, plan } of statusSetters) {
      expect(plan.setDisconnectedStatus).toBe(
        target === 'screen-share-outgoing' ? 'screen-share' : 'none',
      );
    }
  });

  it('incoming leave selects the screen-in-close reset arm whether or not a slot exists', () => {
    expect(
      closeCleanupPlan({ target: 'screen-share-incoming', via: 'peer-leave', outcome: 'live' }),
    ).toEqual({
      reason: 'screen-in-leave',
      ...OFF,
      closeTransport: 'before-slot-clear',
      clearSlot: true,
      recordReset: 'screen-in-close',
    });
    expect(
      closeCleanupPlan({ target: 'screen-share-incoming', via: 'peer-leave', outcome: 'no-slot' }),
    ).toEqual({
      reason: 'screen-in-leave-no-slot',
      ...OFF,
      recordReset: 'screen-in-close',
    });
  });
});

describe('closeCleanupPlan — cross-table invariants', () => {
  it('only a live outcome may clear a slot, fire a view event, or emit CarrierSwitch', () => {
    for (const ctx of allCells) {
      const plan = closeCleanupPlan(ctx);
      if (ctx.outcome !== 'live') {
        expect(plan.clearSlot, JSON.stringify(ctx)).toBe(false);
        expect(plan.fireEvent, JSON.stringify(ctx)).toBe('none');
        expect(plan.emitCarrierSwitch, JSON.stringify(ctx)).toBe(false);
      }
    }
  });

  it('a superseded outcome never closes the transport — closing by peer key would kill the live connection', () => {
    for (const ctx of allCells.filter(c => c.outcome === 'superseded')) {
      expect(closeCleanupPlan(ctx).closeTransport, JSON.stringify(ctx)).toBe('none');
    }
  });

  it('close-first (nested full cleanup) is exclusively the stale and leave paths', () => {
    for (const ctx of allCells) {
      const plan = closeCleanupPlan(ctx);
      if (plan.closeTransport === 'before-slot-clear') {
        expect(['stale-teardown', 'peer-leave'], JSON.stringify(ctx)).toContain(ctx.via);
      }
      // A close event never re-closes the transport that just closed.
      if (ctx.via === 'close-event') {
        expect(plan.closeTransport, JSON.stringify(ctx)).toBe('none');
      }
    }
  });

  it('media-only cleanups never appear on screen rows, and vice versa', () => {
    const MEDIA_ARMS = ['media-close-full', 'media-stale-residue', 'media-leave-residue'];
    for (const ctx of allCells) {
      const plan = closeCleanupPlan(ctx);
      if (ctx.target !== 'media') {
        expect(MEDIA_ARMS, JSON.stringify(ctx)).not.toContain(plan.recordReset);
        expect(plan.teardownOutgoingScreenShare, JSON.stringify(ctx)).toBe(false);
        expect(plan.fireEvent, JSON.stringify(ctx)).not.toBe('peer-disconnected');
      }
      // The 'media-leave-residue' arm (which wipes the signals-RTT EWMA
      // among other rejoin-inheritance fields — review M5) is a
      // peer-leave-only arm.
      if (ctx.via !== 'peer-leave') {
        expect(plan.recordReset, JSON.stringify(ctx)).not.toBe('media-leave-residue');
      }
      if (ctx.target !== 'screen-share-incoming') {
        expect(plan.recordReset, JSON.stringify(ctx)).not.toBe('screen-in-close');
        expect(plan.fireEvent, JSON.stringify(ctx)).not.toBe(
          'peer-screen-share-disconnected',
        );
      }
      if (ctx.target !== 'screen-share-outgoing') {
        expect(plan.recordReset, JSON.stringify(ctx)).not.toBe('screen-out-close');
      }
    }
  });
});
