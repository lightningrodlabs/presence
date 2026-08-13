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
  clearVideoStreamSlot: false,
  clearPendingInits: false,
  clearLastBytesReceived: false,
  clearStaleCycles: false,
  clearReconcileAttemptCount: false,
  clearIceDisconnectedAt: false,
  clearQualityBucket: false,
  clearWebrtcExitReason: false,
  recordLastDisconnect: false,
  clearLastDisconnectTime: false,
  clearLastReconcileTime: false,
  clearSignalsRttEwma: false,
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

describe('closeCleanupPlan — every cell of the table answers', () => {
  it.each(allCells)('%o returns a plan', ctx => {
    const plan = closeCleanupPlan(ctx);
    expect(typeof plan.reason).toBe('string');
    expect(plan.reason.length).toBeGreaterThan(0);
  });
});

describe('closeCleanupPlan — the media full close set, pinned field-by-field', () => {
  // THE cleanup set item 1 exists to state once. §8's seven-entry skip
  // list (`_lastQualityBucket`, `_lastWebrtcExitReason`, `_pendingInits`,
  // `_lastBytesReceived`, `_staleCycles`, `_reconcileAttemptCount`,
  // `_iceDisconnectedAt`) plus `_lastDisconnectTime` and CarrierSwitch
  // are each an explicit true below — re-dropping any one is a failing
  // equality, which is the reviewer's mutation check.
  const MEDIA_FULL_EXPECTED: Omit<CloseCleanupPlan, 'reason' | 'closeTransport'> = {
    logSuperseded: false,
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
    // The cooldown DELETES belong to peer-leave only: a close keeps the
    // stamp (retry-gap semantics), a leave wipes it (§9 item 5).
    clearLastDisconnectTime: false,
    clearLastReconcileTime: false,
    // Same rule for the signals-RTT EWMA (review M5): a plain close keeps
    // the entry (the peer's link is what it is), a leave wipes it.
    clearSignalsRttEwma: false,
    clearPerceivedStreamInfo: true,
    removeAudioAnalyser: true,
    clearWebrtcStats: true,
    emitCarrierSwitch: true,
    teardownOutgoingScreenShare: true,
    clearScreenShareStream: false,
    clearScreenShareIceDisconnectedAt: false,
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
  it('outgoing close clears the slot and the screen ICE bookkeeping', () => {
    expect(
      closeCleanupPlan({ target: 'screen-share-outgoing', via: 'close-event', outcome: 'live' }),
    ).toEqual({
      reason: 'screen-out-close',
      ...OFF,
      clearSlot: true,
      clearScreenShareIceDisconnectedAt: true,
      setDisconnectedStatus: 'screen-share',
    });
  });

  it('incoming close clears the slot and the stream mirror and fires the view event', () => {
    expect(
      closeCleanupPlan({ target: 'screen-share-incoming', via: 'close-event', outcome: 'live' }),
    ).toEqual({
      reason: 'screen-in-close',
      ...OFF,
      clearSlot: true,
      clearScreenShareStream: true,
      fireEvent: 'peer-screen-share-disconnected',
      setDisconnectedStatus: 'screen-share',
    });
  });

});

describe('closeCleanupPlan — the stale rows (former staleTeardownPlan, preserved)', () => {
  it('media stale closes first (delegating the full set to the nested close) and clears slot + pending inits + stream slot as the vanished-pc residue', () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'stale-teardown', outcome: 'live' }),
    ).toEqual({
      reason: 'media-stale',
      ...OFF,
      closeTransport: 'before-slot-clear',
      clearSlot: true,
      clearPendingInits: true,
      clearVideoStreamSlot: true,
    });
  });

  it('outgoing screen stale clears the slot only — no pending map (Phase 3), no stream slot', () => {
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
  it('media leave: close-first, slot + streams + pending inits + quality bucket, status Disconnected', () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'peer-leave', outcome: 'live' }),
    ).toEqual({
      reason: 'media-leave',
      ...OFF,
      closeTransport: 'before-slot-clear',
      clearSlot: true,
      clearVideoStreamSlot: true,
      clearPendingInits: true,
      clearQualityBucket: true,
      // §9 item 5: a rejoining peer must not inherit the departed
      // session's init-retry cooldown or reconcile throttle.
      clearLastDisconnectTime: true,
      clearLastReconcileTime: true,
      // Review M5: nor its signals-RTT EWMA — a collapsed EWMA from the
      // departed session would pause media on a healthy rejoin for ~5
      // ticks of hysteresis walk-back.
      clearSignalsRttEwma: true,
      setDisconnectedStatus: 'media',
    });
  });

  it('media leave with no slot still clears the per-peer maps (the clears were unconditional)', () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'peer-leave', outcome: 'no-slot' }),
    ).toEqual({
      reason: 'media-leave-no-slot',
      ...OFF,
      clearVideoStreamSlot: true,
      clearPendingInits: true,
      clearQualityBucket: true,
      clearLastDisconnectTime: true,
      clearLastReconcileTime: true,
      clearSignalsRttEwma: true,
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

  it('incoming leave drops the stream mirror whether or not a slot exists', () => {
    expect(
      closeCleanupPlan({ target: 'screen-share-incoming', via: 'peer-leave', outcome: 'live' }),
    ).toEqual({
      reason: 'screen-in-leave',
      ...OFF,
      closeTransport: 'before-slot-clear',
      clearSlot: true,
      clearScreenShareStream: true,
    });
    expect(
      closeCleanupPlan({ target: 'screen-share-incoming', via: 'peer-leave', outcome: 'no-slot' }),
    ).toEqual({
      reason: 'screen-in-leave-no-slot',
      ...OFF,
      clearScreenShareStream: true,
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
    for (const ctx of allCells) {
      const plan = closeCleanupPlan(ctx);
      if (ctx.target !== 'media') {
        expect(plan.clearVideoStreamSlot, JSON.stringify(ctx)).toBe(false);
        expect(plan.clearStaleCycles, JSON.stringify(ctx)).toBe(false);
        expect(plan.teardownOutgoingScreenShare, JSON.stringify(ctx)).toBe(false);
        expect(plan.fireEvent, JSON.stringify(ctx)).not.toBe('peer-disconnected');
        expect(plan.clearSignalsRttEwma, JSON.stringify(ctx)).toBe(false);
      }
      // The signals-RTT EWMA delete is a rejoin-inheritance clear
      // (review M5): peer-leave rows only, like the cooldown deletes.
      if (ctx.via !== 'peer-leave') {
        expect(plan.clearSignalsRttEwma, JSON.stringify(ctx)).toBe(false);
      }
      if (ctx.target !== 'screen-share-incoming') {
        expect(plan.clearScreenShareStream, JSON.stringify(ctx)).toBe(false);
        expect(plan.fireEvent, JSON.stringify(ctx)).not.toBe(
          'peer-screen-share-disconnected',
        );
      }
      if (ctx.target !== 'screen-share-outgoing') {
        expect(plan.clearScreenShareIceDisconnectedAt, JSON.stringify(ctx)).toBe(false);
      }
    }
  });
});
