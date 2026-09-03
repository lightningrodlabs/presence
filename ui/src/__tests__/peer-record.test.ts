import { describe, expect, it } from 'vitest';
import { initialPeerRecord, resetPeerRecord, type PeerRecord } from '../peer-record';

describe('initialPeerRecord', () => {
  it('starts at epoch 0 with no session state', () => {
    const r = initialPeerRecord();
    expect(r.connectionEpoch).toBe(0);
    expect(r.pendingInits).toBeUndefined();
    expect(r.videoStream).toBeUndefined();
    expect(r.lastDisconnectTime).toBeUndefined();
  });
});

function fullRecord(): PeerRecord {
  return {
    iceDisconnectedAt: 1, lastBytesReceived: { audio: 2, video: 3 },
    staleCycles: { audio: 4, video: 5 }, reconcileAttemptCount: 6,
    qualityBucket: 'poor', webrtcExitReason: 'ice-failed',
    videoStream: { id: 'video' } as unknown as MediaStream, pendingInits: [{ connectionId: 'c', t0: 7 }],
    sdpTimeoutTimer: 8, analyser: { node: {} as AnalyserNode, buffer: new Uint8Array(1) },
    outageState: { startedAt: 9, emitted: true },
    screenShareStream: { id: 'screen' } as unknown as MediaStream, screenShareIceDisconnectedAt: 10,
    lastDisconnectTime: 11, lastReconcileTime: 12, signalsRttEwma: 13,
    connectionEpoch: 14,
  };
}

describe('resetPeerRecord', () => {
  // Each arm test asserts the FULL resulting record against fullRecord()
  // overridden only by the fields that arm wipes — so an arm that clears
  // (or fails to clear) a field outside its declared set fails the test.
  // `toEqual` treats `{k: undefined}` and a missing `k` as equal, which is
  // exactly the semantics resetPeerRecord's spread-and-undefine style relies on.
  it('media-close-full wipes the media session, keeps survivors, screen state, timer, outage, epoch', () => {
    expect(resetPeerRecord(fullRecord(), 'media-close-full')).toEqual({
      ...fullRecord(),
      iceDisconnectedAt: undefined, lastBytesReceived: undefined,
      staleCycles: undefined, reconcileAttemptCount: undefined,
      qualityBucket: undefined, webrtcExitReason: undefined,
      videoStream: undefined, pendingInits: undefined, analyser: undefined,
      // sdpTimeoutTimer, outageState, screen state, close survivors, and
      // connectionEpoch are inherited unchanged from fullRecord() below.
    });
  });
  it('media-stale-residue wipes only videoStream + pendingInits', () => {
    expect(resetPeerRecord(fullRecord(), 'media-stale-residue')).toEqual({
      ...fullRecord(), videoStream: undefined, pendingInits: undefined,
    });
  });
  it('media-leave-residue additionally wipes qualityBucket and the three close-survivors, never epoch', () => {
    expect(resetPeerRecord(fullRecord(), 'media-leave-residue')).toEqual({
      ...fullRecord(),
      videoStream: undefined, pendingInits: undefined,
      qualityBucket: undefined, lastDisconnectTime: undefined,
      lastReconcileTime: undefined, signalsRttEwma: undefined,
      // iceDisconnectedAt survives this row alone — the nested close row
      // (media-close-full, applied first by the executor) did the rest.
    });
  });
  it('screen-out-close wipes only screenShareIceDisconnectedAt', () => {
    expect(resetPeerRecord(fullRecord(), 'screen-out-close')).toEqual({
      ...fullRecord(), screenShareIceDisconnectedAt: undefined,
    });
  });
  it('screen-in-close wipes only screenShareStream', () => {
    expect(resetPeerRecord(fullRecord(), 'screen-in-close')).toEqual({
      ...fullRecord(), screenShareStream: undefined,
    });
  });
  it('does not mutate its input', () => {
    const input = fullRecord();
    resetPeerRecord(input, 'media-close-full');
    expect(input.videoStream).toBeDefined();
  });
});
