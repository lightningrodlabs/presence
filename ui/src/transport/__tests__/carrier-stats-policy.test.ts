import { describe, expect, it } from 'vitest';
import { statsForPeer } from '../carrier-stats-policy';

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
