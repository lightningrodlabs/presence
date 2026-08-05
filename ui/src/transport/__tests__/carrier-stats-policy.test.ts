import { describe, expect, it } from 'vitest';
import {
  decideFlowGlyph,
  foldSignalsRtt,
  statsForPeer,
  SIGNALS_RTT_EWMA_ALPHA,
  SIGNALS_RTT_PLAUSIBLE_MAX_MS,
} from '../carrier-stats-policy';

const WEBRTC = { rttMs: 40, jitterMs: 5, lossPercent: 0.5 };
const SIGNALS = { rttMs: 900, jitterMs: 60, lossPercent: 4 };

describe('statsForPeer — carrier picked by the carrier-coverage authority', () => {
  const table = [
    {
      name: 'no slot → signals stats (no-webrtc-attempt)',
      snap: { slot: undefined, webrtcStats: WEBRTC, signalsStats: SIGNALS },
      want: { carrier: 'signals', reason: 'no-webrtc-attempt', ...SIGNALS },
    },
    {
      name: 'half-open slot → signals stats, NOT webrtc (the panel lie this replaces)',
      snap: {
        slot: { connected: false },
        webrtcStats: WEBRTC,
        signalsStats: SIGNALS,
      },
      want: { carrier: 'signals', reason: 'webrtc-not-yet-connected', ...SIGNALS },
    },
    {
      name: 'connected slot → webrtc stats',
      snap: {
        slot: { connected: true },
        webrtcStats: WEBRTC,
        signalsStats: SIGNALS,
      },
      want: { carrier: 'webrtc', reason: 'webrtc-connected', ...WEBRTC },
    },
    {
      name: 'connected slot, no webrtc sample yet → webrtc carrier with null fields (never falls back to signals numbers)',
      snap: {
        slot: { connected: true },
        webrtcStats: undefined,
        signalsStats: SIGNALS,
      },
      want: {
        carrier: 'webrtc',
        reason: 'webrtc-connected',
        rttMs: null,
        jitterMs: null,
        lossPercent: null,
      },
    },
    {
      name: 'signals carrier, no sample → nulls',
      snap: { slot: undefined, webrtcStats: undefined, signalsStats: undefined },
      want: {
        carrier: 'signals',
        reason: 'no-webrtc-attempt',
        rttMs: null,
        jitterMs: null,
        lossPercent: null,
      },
    },
    {
      name: 'partial signals sample → per-field nulls, no cross-carrier fill',
      snap: {
        slot: undefined,
        webrtcStats: WEBRTC,
        signalsStats: { rttMs: 120, jitterMs: null, lossPercent: null },
      },
      want: {
        carrier: 'signals',
        reason: 'no-webrtc-attempt',
        rttMs: 120,
        jitterMs: null,
        lossPercent: null,
      },
    },
  ] as const;

  for (const row of table) {
    it(row.name, () => {
      expect(statsForPeer(row.snap as any)).toEqual(row.want);
    });
  }
});

describe('decideFlowGlyph — one flow predicate for both carrier arms (Round 3 item 5)', () => {
  const base = {
    carrier: 'signals' as const,
    now: 10_000,
    windowMs: 3000,
    encoderRunning: true,
    lastSentMs: 9_000,
    lastRecvMs: 9_000,
    webrtcConnected: false,
    webrtcAudioIn: false,
    linkMuted: false,
  };

  it('signals: fresh frames both ways → both', () => {
    expect(decideFlowGlyph(base)).toEqual({ flow: 'both', reason: 'signals-frames' });
  });

  it('signals: stamps outside the media-flowing window are not flow', () => {
    expect(
      decideFlowGlyph({ ...base, lastSentMs: 6_999, lastRecvMs: 6_999 }).flow,
    ).toBe('idle');
  });

  it('signals: tx additionally requires the encoder to be running', () => {
    expect(decideFlowGlyph({ ...base, encoderRunning: false }).flow).toBe('rx');
  });

  it('signals: rx-only and tx-only resolve to their single arrow', () => {
    expect(decideFlowGlyph({ ...base, lastSentMs: undefined }).flow).toBe('rx');
    expect(decideFlowGlyph({ ...base, lastRecvMs: undefined }).flow).toBe('tx');
  });

  it('webrtc: connected with a remote audio track → both', () => {
    expect(
      decideFlowGlyph({
        ...base,
        carrier: 'webrtc',
        webrtcConnected: true,
        webrtcAudioIn: true,
      }),
    ).toEqual({ flow: 'both', reason: 'webrtc-flowing' });
  });

  it('webrtc: connected without a remote track yet → tx only', () => {
    expect(
      decideFlowGlyph({ ...base, carrier: 'webrtc', webrtcConnected: true }).flow,
    ).toBe('tx');
  });

  it('webrtc: NOT connected shows no flow even with a leftover audio flag (the declared change — flow keys on connected, never on slot fields)', () => {
    expect(
      decideFlowGlyph({
        ...base,
        carrier: 'webrtc',
        webrtcConnected: false,
        webrtcAudioIn: true,
      }),
    ).toEqual({ flow: 'idle', reason: 'webrtc-not-flowing' });
  });

  it('muted wins over idle but never over actual flow', () => {
    expect(
      decideFlowGlyph({
        ...base,
        carrier: 'webrtc',
        linkMuted: true,
      }),
    ).toEqual({ flow: 'muted', reason: 'muted-overrides-idle' });
    expect(decideFlowGlyph({ ...base, linkMuted: true }).flow).toBe('both');
  });
});

describe('foldSignalsRtt — the pong-echo RTT fold (§9 item 4)', () => {
  const NOW = 1_000_000;

  const table = [
    {
      name: 'no echoed t0 (peer on older code) → no-sample',
      input: { pingT0: undefined, now: NOW, prevEwmaMs: 42, slot: undefined },
      want: { action: 'no-sample', reason: 'no-ping-echo' },
    },
    {
      name: 'a sample at the plausibility bound is dropped, carrying the raw value',
      input: {
        pingT0: NOW - SIGNALS_RTT_PLAUSIBLE_MAX_MS,
        now: NOW,
        prevEwmaMs: 42,
        slot: undefined,
      },
      want: {
        action: 'drop',
        reason: 'implausible',
        rawRttMs: SIGNALS_RTT_PLAUSIBLE_MAX_MS,
      },
    },
    {
      name: 'a negative sample (clock artifact) is dropped, not clamped',
      input: { pingT0: NOW + 5, now: NOW, prevEwmaMs: 42, slot: undefined },
      want: { action: 'drop', reason: 'implausible', rawRttMs: -5 },
    },
    {
      name: 'first sample seeds the EWMA with itself',
      input: { pingT0: NOW - 300, now: NOW, prevEwmaMs: undefined, slot: undefined },
      want: {
        action: 'fold',
        reason: 'signals-active',
        ewmaMs: 300,
        emitQualityCheck: true,
      },
    },
    {
      name: 'later samples fold at alpha (rounded)',
      input: { pingT0: NOW - 500, now: NOW, prevEwmaMs: 100, slot: undefined },
      want: {
        action: 'fold',
        reason: 'signals-active',
        ewmaMs: Math.round(
          SIGNALS_RTT_EWMA_ALPHA * 500 + (1 - SIGNALS_RTT_EWMA_ALPHA) * 100
        ),
        emitQualityCheck: true,
      },
    },
    {
      name: 'half-open slot is still the signals carrier → quality check emits',
      input: {
        pingT0: NOW - 100,
        now: NOW,
        prevEwmaMs: 100,
        slot: { connected: false },
      },
      want: {
        action: 'fold',
        reason: 'signals-active',
        ewmaMs: 100,
        emitQualityCheck: true,
      },
    },
    {
      name: 'webrtc connected → fold still lands (the map write) but the emit gate closes: the getStats poll owns bucket emission',
      input: {
        pingT0: NOW - 100,
        now: NOW,
        prevEwmaMs: 100,
        slot: { connected: true },
      },
      want: {
        action: 'fold',
        reason: 'webrtc-active',
        ewmaMs: 100,
        emitQualityCheck: false,
      },
    },
    {
      name: 'zero RTT is a valid sample, not a drop',
      input: { pingT0: NOW, now: NOW, prevEwmaMs: undefined, slot: undefined },
      want: {
        action: 'fold',
        reason: 'signals-active',
        ewmaMs: 0,
        emitQualityCheck: true,
      },
    },
  ] as const;

  for (const row of table) {
    it(row.name, () => {
      expect(foldSignalsRtt(row.input)).toEqual(row.want);
    });
  }

  it('the alpha smooths: a spike moves the EWMA by only alpha of its excess', () => {
    const spiked = foldSignalsRtt({
      pingT0: NOW - 1100,
      now: NOW,
      prevEwmaMs: 100,
      slot: undefined,
    });
    expect(spiked.action).toBe('fold');
    if (spiked.action === 'fold') {
      expect(spiked.ewmaMs).toBe(400); // 100 + 0.3 * 1000
    }
  });
});
