// @vitest-environment jsdom
/**
 * View-layer round (§8 view-misc row): the peer-stats-panel's `_last*`
 * render cache is invalidated on pubkey reassignment.
 *
 * repeat() reuses DOM: when the roster shifts, an existing panel element
 * can be handed a NEW agentPubKeyB64. Pre-fix, the cache kept the old
 * peer's numbers until the next 1Hz poll tick — up to a second of peer
 * A's RTT rendered under peer B's tile — and the willUpdate resample is
 * what closes it. These tests never advance timers, so any correct
 * number visible after reassignment can only have come from the
 * willUpdate path, not the interval.
 */
import { describe, it, expect, afterEach } from 'vitest';
import '../room/elements/peer-stats-panel';

type Stats = {
  carrier: 'webrtc' | 'signals' | 'none';
  rttMs: number | null;
  jitterMs: number | null;
  lossPercent: number | null;
};

function fakeStore(statsByPeer: Record<string, Stats>) {
  return {
    clock: { now: () => 1_000 },
    statsFor: (pk: string): Stats =>
      statsByPeer[pk] ?? {
        carrier: 'none',
        rttMs: null,
        jitterMs: null,
        lossPercent: null,
      },
    openConnectionInfo: () => undefined,
    signalsLastSent: new Map<string, number>(),
    signalsLastRecv: new Map<string, number>(),
    audioLinkFor: () => 'down',
    voiceEncoderRunning: false,
  };
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

async function mountPanel(store: ReturnType<typeof fakeStore>, peer: string) {
  const el = document.createElement('peer-stats-panel') as any;
  el.streamsStore = store;
  el.agentPubKeyB64 = peer;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  return el;
}

describe('peer-stats-panel cache on pubkey reassignment', () => {
  const store = () =>
    fakeStore({
      peerA: { carrier: 'webrtc', rttMs: 42, jitterMs: 5, lossPercent: 1 },
      peerB: { carrier: 'signals', rttMs: 99, jitterMs: 7, lossPercent: 3 },
    });

  it('renders the peer it was mounted for', async () => {
    const el = await mountPanel(store(), 'peerA');
    expect(el._lastRtt).toBe(42);
    expect(el._lastCarrier).toBe('webrtc');
    expect(el.shadowRoot!.textContent).toContain('42ms');
  });

  it('reassignment resamples in the same update cycle — no interval tick needed', async () => {
    const el = await mountPanel(store(), 'peerA');
    el.agentPubKeyB64 = 'peerB';
    await el.updateComplete;
    expect(el._lastRtt).toBe(99);
    expect(el._lastCarrier).toBe('signals');
    expect(el.shadowRoot!.textContent).toContain('99ms');
    expect(el.shadowRoot!.textContent).not.toContain('42ms');
  });

  it('reassignment to a peer with no stats clears the old numbers instead of keeping them', async () => {
    const el = await mountPanel(store(), 'peerA');
    el.agentPubKeyB64 = 'peerUnknown';
    await el.updateComplete;
    expect(el._lastRtt).toBe(null);
    expect(el._lastCarrier).toBe('none');
    expect(el.shadowRoot!.textContent).not.toContain('42ms');
  });
});
