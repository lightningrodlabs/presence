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
    videoStream: {} as MediaStream, pendingInits: [{ connectionId: 'c', t0: 7 }],
    sdpTimeoutTimer: 8, analyser: { node: {} as AnalyserNode, buffer: new Uint8Array(1) },
    outageState: { startedAt: 9, emitted: true },
    screenShareStream: {} as MediaStream, screenShareIceDisconnectedAt: 10,
    lastDisconnectTime: 11, lastReconcileTime: 12, signalsRttEwma: 13,
    connectionEpoch: 14,
  };
}

describe('resetPeerRecord', () => {
  it('media-close-full wipes the media session, keeps survivors, screen state, timer, outage, epoch', () => {
    const r = resetPeerRecord(fullRecord(), 'media-close-full');
    for (const f of ['iceDisconnectedAt','lastBytesReceived','staleCycles','reconcileAttemptCount','qualityBucket','webrtcExitReason','videoStream','pendingInits','analyser'] as const)
      expect(r[f], f).toBeUndefined();
    expect(r.sdpTimeoutTimer).toBe(8);       // executor-owned, not arm-owned
    expect(r.outageState).toEqual({ startedAt: 9, emitted: true }); // sweep-owned
    expect(r.screenShareStream).toBeDefined();
    expect(r.screenShareIceDisconnectedAt).toBe(10);
    expect(r.lastDisconnectTime).toBe(11);   // close survivor
    expect(r.lastReconcileTime).toBe(12);
    expect(r.signalsRttEwma).toBe(13);
    expect(r.connectionEpoch).toBe(14);      // session survivor
  });
  it('media-stale-residue wipes only videoStream + pendingInits', () => {
    const r = resetPeerRecord(fullRecord(), 'media-stale-residue');
    expect(r.videoStream).toBeUndefined();
    expect(r.pendingInits).toBeUndefined();
    expect(r.staleCycles).toBeDefined();
    expect(r.lastDisconnectTime).toBe(11);
  });
  it('media-leave-residue additionally wipes qualityBucket and the three close-survivors, never epoch', () => {
    const r = resetPeerRecord(fullRecord(), 'media-leave-residue');
    for (const f of ['videoStream','pendingInits','qualityBucket','lastDisconnectTime','lastReconcileTime','signalsRttEwma'] as const)
      expect(r[f], f).toBeUndefined();
    expect(r.iceDisconnectedAt).toBe(1);     // outer leave row's residue only; nested close row did the rest
    expect(r.connectionEpoch).toBe(14);
  });
  it('screen-out-close wipes only screenShareIceDisconnectedAt', () => {
    const r = resetPeerRecord(fullRecord(), 'screen-out-close');
    expect(r.screenShareIceDisconnectedAt).toBeUndefined();
    expect(r.screenShareStream).toBeDefined();
  });
  it('screen-in-close wipes only screenShareStream', () => {
    const r = resetPeerRecord(fullRecord(), 'screen-in-close');
    expect(r.screenShareStream).toBeUndefined();
    expect(r.screenShareIceDisconnectedAt).toBe(10);
  });
  it('does not mutate its input', () => {
    const input = fullRecord();
    resetPeerRecord(input, 'media-close-full');
    expect(input.videoStream).toBeDefined();
  });
});
