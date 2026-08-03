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
 * Round 3 item 1 — every (target × via × outcome) cell answered, the key
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
  'error-event',
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

  it('error-event/live performs the SAME full set plus an after-slot-clear transport close (declared change b)', () => {
    expect(
      closeCleanupPlan({ target: 'media', via: 'error-event', outcome: 'live' }),
    ).toEqual({
      reason: 'media-error',
      closeTransport: 'after-slot-clear',
      ...MEDIA_FULL_EXPECTED,
    });
  });
});

describe('closeCleanupPlan — the guard rows', () => {
  it.each(['close-event', 'error-event'] as const)(
    'media %s/superseded logs and clears the event connection\'s ice timing, touching nothing else (the _iceTimings leak row)',
    via => {
      expect(closeCleanupPlan({ target: 'media', via, outcome: 'superseded' })).toEqual({
        reason: `media-${via === 'close-event' ? 'close' : 'error'}-superseded`,
        ...OFF,
        logSuperseded: true,
        clearIceTiming: true,
      });
    },
  );

  it.each(['close-event', 'error-event'] as const)(
    'media %s/no-slot (duplicate) clears only the ice timing',
    via => {
      expect(closeCleanupPlan({ target: 'media', via, outcome: 'no-slot' })).toEqual({
        reason: `media-${via === 'close-event' ? 'close' : 'error'}-duplicate`,
        ...OFF,
        clearIceTiming: true,
      });
    },
  );

  it('screen close guards (superseded and no-slot, both directions) touch nothing', () => {
    for (const target of ['screen-share-outgoing', 'screen-share-incoming'] as const) {
      for (const outcome of ['superseded', 'no-slot'] as const) {
        const plan = closeCleanupPlan({ target, via: 'close-event', outcome });
        expect(plan).toEqual({ reason: plan.reason, ...OFF });
      }
    }
  });

  it('screen error/superseded logs and touches nothing else — a stale error must not tear down the live share', () => {
    for (const target of ['screen-share-outgoing', 'screen-share-incoming'] as const) {
      const plan = closeCleanupPlan({ target, via: 'error-event', outcome: 'superseded' });
      expect(plan).toEqual({ reason: plan.reason, ...OFF, logSuperseded: true });
    }
  });

  it('screen-share error with no slot does NOT fire peer-screen-share-disconnected (declared change a)', () => {
    const incoming = closeCleanupPlan({
      target: 'screen-share-incoming',
      via: 'error-event',
      outcome: 'no-slot',
    });
    expect(incoming).toEqual({
      reason: 'screen-in-error-duplicate',
      ...OFF,
      closeTransport: 'after-slot-clear',
      clearScreenShareStream: true,
      setDisconnectedStatus: 'screen-share',
    });
    const outgoing = closeCleanupPlan({
      target: 'screen-share-outgoing',
      via: 'error-event',
      outcome: 'no-slot',
    });
    expect(outgoing).toEqual({
      reason: 'screen-out-error-duplicate',
      ...OFF,
      closeTransport: 'after-slot-clear',
      setDisconnectedStatus: 'screen-share',
    });
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

  it('outgoing error matches outgoing close plus the transport close (family fix: _screenShareIceDisconnectedAt no longer leaks on the error path)', () => {
    expect(
      closeCleanupPlan({ target: 'screen-share-outgoing', via: 'error-event', outcome: 'live' }),
    ).toEqual({
      reason: 'screen-out-error',
      ...OFF,
      closeTransport: 'after-slot-clear',
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

  it('incoming error matches incoming close plus the transport close', () => {
    expect(
      closeCleanupPlan({ target: 'screen-share-incoming', via: 'error-event', outcome: 'live' }),
    ).toEqual({
      reason: 'screen-in-error',
      ...OFF,
      closeTransport: 'after-slot-clear',
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

  it('close-first (nested full cleanup) is exclusively the stale and leave paths; error paths always clear the slot first', () => {
    for (const ctx of allCells) {
      const plan = closeCleanupPlan(ctx);
      if (plan.closeTransport === 'before-slot-clear') {
        expect(['stale-teardown', 'peer-leave'], JSON.stringify(ctx)).toContain(ctx.via);
      }
      if (plan.closeTransport === 'after-slot-clear') {
        expect(ctx.via, JSON.stringify(ctx)).toBe('error-event');
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
