import { describe, it, expect } from 'vitest';
import {
  decideVoiceAdmission,
  nextVoiceEpoch,
  VOICE_SESSION_ADOPT_GAP_MS,
  type VoiceAdmissionSnapshot,
} from '../room/modules/voice-admission';

/**
 * Table tests for the voice-frame admission decision (the fix for the
 * 2026-08-26 field deafness: sender resets `seq` to 0 on every
 * stopCapture, the receiver's `lastSeq` high-water persisted forever, so
 * each new capture session was silently dropped until its seq climbed
 * past the old high-water — deafness lasting exactly the previous
 * session's length; 7.2s / 23.1s / 51.3s across the three observed
 * windows).
 *
 * The capture-session epoch is the discriminator: ordered adoption
 * (newer epoch wins), stale-epoch frames dropped (late old-session
 * packets can no longer re-trigger adoption or replay), and a
 * quiet-window fallback arm so a sender whose wall clock stepped
 * backwards across an app restart cannot deafen the receiver forever.
 */

const snap = (s: Partial<VoiceAdmissionSnapshot>): VoiceAdmissionSnapshot => ({
  epoch: null,
  seq: 1,
  lastEpoch: null,
  lastSeq: 0,
  msSinceAccepted: null,
  ...s,
});

describe('decideVoiceAdmission', () => {
  describe('legacy sender (no epoch on the frame) — pre-epoch behavior preserved', () => {
    it('accepts the first frame ever', () => {
      const d = decideVoiceAdmission(snap({ epoch: null, seq: 1, lastSeq: 0 }));
      expect(d.action).toBe('accept');
    });

    it('drops a stale/duplicate seq', () => {
      const d = decideVoiceAdmission(snap({ epoch: null, seq: 5, lastSeq: 5 }));
      expect(d).toEqual({ action: 'drop', reason: 'stale-seq' });
    });

    it('accepts an in-order seq', () => {
      const d = decideVoiceAdmission(snap({ epoch: null, seq: 6, lastSeq: 5 }));
      expect(d.action).toBe('accept');
    });

    it('still drops a restarted legacy sender (declared limitation: epoch-less senders keep the deafness bug)', () => {
      const d = decideVoiceAdmission(
        snap({ epoch: null, seq: 1, lastSeq: 2500, msSinceAccepted: 60_000 })
      );
      expect(d).toEqual({ action: 'drop', reason: 'stale-seq' });
    });
  });

  describe('epoch-bearing frames', () => {
    it('adopts the first epoch ever seen (covers receiver restart and legacy->epoch upgrade mid-map)', () => {
      const d = decideVoiceAdmission(
        snap({ epoch: 1000, seq: 1, lastEpoch: null, lastSeq: 2500 })
      );
      expect(d).toEqual({ action: 'adopt-session', reason: 'first-epoch' });
    });

    it('same epoch: in-order seq accepted', () => {
      const d = decideVoiceAdmission(
        snap({ epoch: 1000, seq: 6, lastEpoch: 1000, lastSeq: 5 })
      );
      expect(d).toEqual({ action: 'accept', reason: 'in-session' });
    });

    it('same epoch: stale seq dropped (normal reorder/duplicate dedupe)', () => {
      const d = decideVoiceAdmission(
        snap({ epoch: 1000, seq: 5, lastEpoch: 1000, lastSeq: 5 })
      );
      expect(d).toEqual({ action: 'drop', reason: 'stale-seq' });
    });

    it('newer epoch adopts immediately regardless of seq high-water — THE deafness fix', () => {
      const d = decideVoiceAdmission(
        snap({ epoch: 2000, seq: 1, lastEpoch: 1000, lastSeq: 2500, msSinceAccepted: 100 })
      );
      expect(d).toEqual({ action: 'adopt-session', reason: 'newer-epoch' });
    });

    it('older epoch with a recent accept drops — late old-session packets cannot re-adopt backwards', () => {
      const d = decideVoiceAdmission(
        snap({ epoch: 1000, seq: 2600, lastEpoch: 2000, lastSeq: 3, msSinceAccepted: 100 })
      );
      expect(d).toEqual({ action: 'drop', reason: 'stale-epoch' });
    });

    it('older epoch after a quiet window adopts — the clock-stepped-backwards pathology arm (a live stream beats a stored epoch)', () => {
      const d = decideVoiceAdmission(
        snap({
          epoch: 1000,
          seq: 1,
          lastEpoch: 2000,
          lastSeq: 3,
          msSinceAccepted: VOICE_SESSION_ADOPT_GAP_MS + 1,
        })
      );
      expect(d).toEqual({ action: 'adopt-session', reason: 'quiet-stale-epoch' });
    });

    it('older epoch exactly at the quiet window boundary still drops (strict inequality)', () => {
      const d = decideVoiceAdmission(
        snap({
          epoch: 1000,
          seq: 1,
          lastEpoch: 2000,
          lastSeq: 3,
          msSinceAccepted: VOICE_SESSION_ADOPT_GAP_MS,
        })
      );
      expect(d).toEqual({ action: 'drop', reason: 'stale-epoch' });
    });

    it('older epoch with no accepted-frame stamp adopts (total function; liveness wins in the unreachable corner)', () => {
      const d = decideVoiceAdmission(
        snap({ epoch: 1000, seq: 1, lastEpoch: 2000, lastSeq: 0, msSinceAccepted: null })
      );
      expect(d).toEqual({ action: 'adopt-session', reason: 'quiet-stale-epoch' });
    });
  });
});

describe('nextVoiceEpoch', () => {
  it('uses the wall clock when it is ahead of the previous epoch (unique across app restarts)', () => {
    expect(nextVoiceEpoch(1_787_766_000_000, 0)).toBe(1_787_766_000_000);
  });

  it('stays strictly increasing when the clock has not advanced past the previous epoch', () => {
    expect(nextVoiceEpoch(1000, 5000)).toBe(5001);
  });

  it('two successive sessions in the same millisecond still get distinct ordered epochs', () => {
    const e1 = nextVoiceEpoch(7777, 0);
    const e2 = nextVoiceEpoch(7777, e1);
    expect(e2).toBeGreaterThan(e1);
  });
});
