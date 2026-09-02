import { describe, expect, it } from 'vitest';
import { initialPeerRecord } from '../peer-record';

describe('initialPeerRecord', () => {
  it('starts at epoch 0 with no session state', () => {
    const r = initialPeerRecord();
    expect(r.connectionEpoch).toBe(0);
    expect(r.pendingInits).toBeUndefined();
    expect(r.videoStream).toBeUndefined();
    expect(r.lastDisconnectTime).toBeUndefined();
  });
});
