import { describe, it, expect } from 'vitest';
import {
  carrierFor,
  computeSignalsTargets,
  decideWebrtcEligibility,
} from '../carrier-coverage';
import type {
  WebrtcEligibilityInputs,
  WebrtcSlot,
} from '../carrier-coverage';

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

describe('decideWebrtcEligibility — one predicate for both handshake ends (Round 3 item 2)', () => {
  const ROLES = ['initiator', 'acceptor'] as const;

  const eligibleBase = (role: (typeof ROLES)[number]): WebrtcEligibilityInputs => ({
    role,
    conversationActive: true,
    peerWebrtcDisabled: false,
    webrtcGloballyDisabled: false,
    peerHasSdpFsmCap: true,
  });

  // role × conjunct: flipping any single conjunct makes the peer
  // ineligible with that conjunct's reason, identically for both roles.
  // Inverting a conjunct inside the policy fails the corresponding row —
  // the reviewer's mutation check.
  const conjunctRows: Array<
    [Partial<WebrtcEligibilityInputs>, string]
  > = [
    [{ conversationActive: false }, 'conversation-inactive'],
    [{ webrtcGloballyDisabled: true }, 'webrtc-globally-disabled'],
    [{ peerWebrtcDisabled: true }, 'peer-webrtc-disabled'],
    [{ peerHasSdpFsmCap: false }, 'peer-lacks-sdp-fsm-cap'],
  ];

  for (const role of ROLES) {
    it(`${role}: all conjuncts holding is eligible`, () => {
      expect(decideWebrtcEligibility(eligibleBase(role))).toEqual({
        eligible: true,
        reason: 'all-conjuncts-hold',
      });
    });

    it.each(conjunctRows)(
      `${role}: %o → ineligible (%s)`,
      (flip, reason) => {
        expect(decideWebrtcEligibility({ ...eligibleBase(role), ...flip })).toEqual({
          eligible: false,
          reason,
        });
      },
    );
  }

  it('is symmetric by decision: the acceptor requires conversationActive too (the declared behavior change)', () => {
    // Before the predicate, the acceptor omitted this conjunct — an
    // inactive-conversation node would answer an InitRequest and stand
    // up the very connection the module toggle exists to prevent.
    expect(
      decideWebrtcEligibility({
        ...eligibleBase('acceptor'),
        conversationActive: false,
      }).eligible,
    ).toBe(false);
  });

  it('answers identically for both roles on every single-conjunct flip', () => {
    for (const [flip] of conjunctRows) {
      expect(
        decideWebrtcEligibility({ ...eligibleBase('initiator'), ...flip }),
      ).toEqual(
        decideWebrtcEligibility({ ...eligibleBase('acceptor'), ...flip }),
      );
    }
  });

  it('reason precedence: conversation, then kill switch, then per-peer, then capability', () => {
    expect(
      decideWebrtcEligibility({
        role: 'initiator',
        conversationActive: false,
        webrtcGloballyDisabled: true,
        peerWebrtcDisabled: true,
        peerHasSdpFsmCap: false,
      }).reason,
    ).toBe('conversation-inactive');
    expect(
      decideWebrtcEligibility({
        role: 'initiator',
        conversationActive: true,
        webrtcGloballyDisabled: true,
        peerWebrtcDisabled: true,
        peerHasSdpFsmCap: false,
      }).reason,
    ).toBe('webrtc-globally-disabled');
    expect(
      decideWebrtcEligibility({
        role: 'initiator',
        conversationActive: true,
        webrtcGloballyDisabled: false,
        peerWebrtcDisabled: true,
        peerHasSdpFsmCap: false,
      }).reason,
    ).toBe('peer-webrtc-disabled');
  });
});
