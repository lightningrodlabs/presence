import { describe, expect, it } from 'vitest';
import { PeerAudioLevels } from '../peer-audio-levels';
import { initialPeerRecord, type PeerRecord } from '../peer-record';

describe('PeerAudioLevels', () => {
  it('returns 0 with no record and no analyser', () => {
    const records = new Map<string, PeerRecord>();
    const levels = new PeerAudioLevels({
      ensureAudioContext: () => null,
      peerRecord: k => records.get(k),
      ensurePeerRecord: k => {
        let r = records.get(k);
        if (!r) { r = initialPeerRecord(); records.set(k, r); }
        return r;
      },
    });
    expect(levels.getWebrtcAudioLevel('peer')).toBe(0);
    expect(records.size).toBe(0); // a read never creates a row
  });

  it('setup is a no-op when the stream has no audio tracks', () => {
    const records = new Map<string, PeerRecord>();
    let ensureAudioContextCalls = 0;
    const levels = new PeerAudioLevels({
      ensureAudioContext: () => { ensureAudioContextCalls += 1; return null; },
      peerRecord: k => records.get(k),
      ensurePeerRecord: k => {
        let r = records.get(k);
        if (!r) { r = initialPeerRecord(); records.set(k, r); }
        return r;
      },
    });
    levels.setupPeerAudioAnalyser('peer', { getAudioTracks: () => [] } as unknown as MediaStream);
    expect(records.get('peer')?.analyser).toBeUndefined();
    expect(records.size).toBe(0); // the cleanup read never creates a row
    expect(ensureAudioContextCalls).toBe(0); // the no-audio-tracks early return survived the move
  });
});
