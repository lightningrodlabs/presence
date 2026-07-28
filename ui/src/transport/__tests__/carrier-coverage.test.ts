import { describe, it, expect } from 'vitest';
import { carrierFor, computeSignalsTargets } from '../carrier-coverage';
import type { WebrtcSlot } from '../carrier-coverage';

describe('carrierFor — one carrier owns each present peer', () => {
  const table: Array<[string, WebrtcSlot | undefined, ReturnType<typeof carrierFor>]> = [
    [
      'no WebRTC attempt at all',
      undefined,
      { carrier: 'signals', reason: 'no-webrtc-attempt' },
    ],
    [
      'negotiation started but not connected',
      { connected: false },
      { carrier: 'signals', reason: 'webrtc-not-yet-connected' },
    ],
    [
      'WebRTC up (ICE + DTLS)',
      { connected: true },
      { carrier: 'webrtc', reason: 'webrtc-connected' },
    ],
  ];

  it.each(table)('%s', (_label, slot, expected) => {
    expect(carrierFor(slot)).toEqual(expected);
  });
});

describe('computeSignalsTargets — the carrier-coverage invariant', () => {
  /**
   * The invariant, stated as a test: no present peer may be excluded from
   * the signals carrier unless WebRTC is actually connected for them.
   */
  it('leaves no present peer without a carrier', () => {
    const presentPeers = ['a', 'b', 'c', 'd'];
    const openConnections = {
      a: { connected: true },
      b: { connected: false },
      c: { connected: false },
      // d has no entry at all
    };

    const targets = computeSignalsTargets({ presentPeers, openConnections });

    for (const peer of presentPeers) {
      const covered =
        targets.has(peer) || openConnections[peer as 'a']?.connected === true;
      expect(covered, `${peer} has no carrier`).toBe(true);
    }
  });

  it('keeps sending signals through a negotiation (make-before-break)', () => {
    // This is the regression the old `!connections[pubkey]` test produced:
    // the entry is installed at signaling-start with connected: false, so
    // the peer dropped out of the signals carrier before WebRTC could
    // carry anything — a silence window on every attempt, reopened on
    // every retry (§3.1a).
    const targets = computeSignalsTargets({
      presentPeers: ['peer'],
      openConnections: { peer: { connected: false } },
    });

    expect(targets.has('peer')).toBe(true);
  });

  it('stands down once WebRTC is connected', () => {
    const targets = computeSignalsTargets({
      presentPeers: ['peer'],
      openConnections: { peer: { connected: true } },
    });

    expect(targets.has('peer')).toBe(false);
  });

  it('resumes when a connected peer drops back to not-connected', () => {
    const before = computeSignalsTargets({
      presentPeers: ['peer'],
      openConnections: { peer: { connected: true } },
    });
    const after = computeSignalsTargets({
      presentPeers: ['peer'],
      openConnections: { peer: { connected: false } },
    });

    expect(before.has('peer')).toBe(false);
    expect(after.has('peer')).toBe(true);
  });

  it('carries a peer with a wedged connected:false entry', () => {
    // §3.1(c): the entry that outlives its RTCPeerConnection. Phase 1's
    // routing fixes clear it, but even if one survives, the peer keeps a
    // carrier rather than going permanently silent.
    const targets = computeSignalsTargets({
      presentPeers: ['ghost'],
      openConnections: { ghost: { connected: false } },
    });

    expect(targets.has('ghost')).toBe(true);
  });

  it('never targets a peer who is not present', () => {
    const targets = computeSignalsTargets({
      presentPeers: ['a'],
      openConnections: { a: { connected: false }, gone: { connected: false } },
    });

    expect([...targets]).toEqual(['a']);
  });

  it('is empty when every present peer is on WebRTC', () => {
    const targets = computeSignalsTargets({
      presentPeers: ['a', 'b'],
      openConnections: { a: { connected: true }, b: { connected: true } },
    });

    expect(targets.size).toBe(0);
  });
});
