import { describe, expect, it } from 'vitest';
import {
  decideAudioLink,
  buildPeerLinkSnapshot,
  countAudiblePeers,
} from '../peer-link-policy';
import type { AudioLinkInputs } from '../peer-link-policy';

const NOW = 100_000;
const WINDOW = 3_000;

/** A reachable, unmuted, idle peer — rows override what they test. */
function base(overrides: Partial<AudioLinkInputs> = {}): AudioLinkInputs {
  return {
    blocked: false,
    reachableBucket: 'fresh',
    slot: undefined,
    audioStaleCycles: 0,
    lastVoiceMs: undefined,
    now: NOW,
    mediaLiveWindowMs: WINDOW,
    peerMicMuted: false,
    statusType: undefined,
    ...overrides,
  };
}

describe('decideAudioLink — flow beats reachability, reachability gates the rest', () => {
  const table: Array<{ name: string; input: AudioLinkInputs; want: string }> = [
    {
      name: 'blocked wins over everything',
      input: base({
        blocked: true,
        slot: { connected: true, audio: true },
      }),
      want: 'blocked',
    },
    {
      name: 'webrtc audio flowing → webrtc',
      input: base({ slot: { connected: true, audio: true } }),
      want: 'webrtc',
    },
    {
      name:
        'THE REORDER: webrtc audio flowing while signals bucket is gone → webrtc, not absent ' +
        '(a 30s pong outage must not veto ICE+DTLS+flowing RTP)',
      input: base({
        reachableBucket: 'gone',
        slot: { connected: true, audio: true },
      }),
      want: 'webrtc',
    },
    {
      name: 'signals voice frames flowing while bucket is gone → signals (frames ARE reachability evidence)',
      input: base({ reachableBucket: 'gone', lastVoiceMs: NOW - 1_000 }),
      want: 'signals',
    },
    {
      name: 'webrtc connected but audio bytes stale ≥2 cycles → falls through to signals check',
      input: base({
        slot: { connected: true, audio: true },
        audioStaleCycles: 2,
        lastVoiceMs: NOW - 1_000,
      }),
      want: 'signals',
    },
    {
      name: 'signals frames outside the media-flowing window do not count',
      input: base({ lastVoiceMs: NOW - WINDOW }),
      want: 'down',
    },
    {
      name: 'no flow + bucket gone → absent',
      input: base({ reachableBucket: 'gone' }),
      want: 'absent',
    },
    {
      name: 'no flow + bucket unknown → absent',
      input: base({ reachableBucket: 'unknown' }),
      want: 'absent',
    },
    {
      name: 'no flow + bucket gone beats muted (without flow, pongs are the only existence evidence)',
      input: base({ reachableBucket: 'gone', peerMicMuted: true }),
      want: 'absent',
    },
    {
      name: 'reachable + peer muted → muted, even mid-negotiation (intent beats stale status)',
      input: base({ peerMicMuted: true, statusType: 'InitSent' }),
      want: 'muted',
    },
    {
      name: 'reachable + negotiating status → negotiating',
      input: base({ statusType: 'SdpExchange' }),
      want: 'negotiating',
    },
    {
      name: 'reachable + Disconnected status → down (only the four in-flight stages negotiate)',
      input: base({ statusType: 'Disconnected' }),
      want: 'down',
    },
    {
      name: 'reachable, no flow, no status → down',
      input: base(),
      want: 'down',
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      expect(decideAudioLink(row.input)).toBe(row.want);
    });
  }
});

describe('buildPeerLinkSnapshot — wire fields keep their carrier-tagged meanings', () => {
  it('audioLink webrtc → carrier webrtc, audio live', () => {
    const snap = buildPeerLinkSnapshot({
      audioLink: 'webrtc',
      slot: { connected: true, audio: true, video: false },
      filmstripLive: false,
      lastSeen: 'fresh',
    });
    expect(snap).toMatchObject({ carrier: 'webrtc', audio: 'live', video: 'off' });
  });

  it('audioLink signals → carrier signals even alongside a connected slot (what you hear wins)', () => {
    const snap = buildPeerLinkSnapshot({
      audioLink: 'signals',
      slot: { connected: true, audio: false, video: false },
      filmstripLive: false,
      lastSeen: 'fresh',
    });
    expect(snap).toMatchObject({ carrier: 'signals', audio: 'live' });
  });

  it('no flow but connected slot → carrier webrtc (agrees with carrierFor: a connected slot owns the link)', () => {
    const snap = buildPeerLinkSnapshot({
      audioLink: 'down',
      slot: { connected: true, audio: false, video: false },
      filmstripLive: false,
      lastSeen: 'fresh',
    });
    expect(snap).toMatchObject({ carrier: 'webrtc', audio: 'off' });
  });

  it('slot claims connected+audio but flow checks failed → audio stale (claim contradicted by bytes)',
    () => {
      const snap = buildPeerLinkSnapshot({
        audioLink: 'down',
        slot: { connected: true, audio: true, video: false },
        filmstripLive: false,
        lastSeen: 'fresh',
      });
      expect(snap).toMatchObject({ carrier: 'webrtc', audio: 'stale' });
    });

  it('nothing at all → carrier none, audio off', () => {
    const snap = buildPeerLinkSnapshot({
      audioLink: 'absent',
      slot: undefined,
      filmstripLive: false,
      lastSeen: 'gone',
    });
    expect(snap).toMatchObject({
      carrier: 'none',
      audio: 'off',
      video: 'off',
      lastSeen: 'gone',
    });
  });

  it('muted audioLink → audio muted', () => {
    const snap = buildPeerLinkSnapshot({
      audioLink: 'muted',
      slot: undefined,
      filmstripLive: false,
      lastSeen: 'fresh',
    });
    expect(snap).toMatchObject({ carrier: 'none', audio: 'muted' });
  });

  it('video live via webrtc track OR filmstrip window; muted only from the slot flag', () => {
    expect(
      buildPeerLinkSnapshot({
        audioLink: 'down',
        slot: { connected: true, audio: false, video: true },
        filmstripLive: false,
        lastSeen: 'fresh',
      }).video,
    ).toBe('live');
    expect(
      buildPeerLinkSnapshot({
        audioLink: 'signals',
        slot: undefined,
        filmstripLive: true,
        lastSeen: 'fresh',
      }).video,
    ).toBe('live');
    expect(
      buildPeerLinkSnapshot({
        audioLink: 'down',
        slot: { connected: true, audio: false, video: false, videoMuted: true },
        filmstripLive: false,
        lastSeen: 'fresh',
      }).video,
    ).toBe('muted');
  });
});

describe('countAudiblePeers — one rule for the icon-strip audible counter', () => {
  const links = (...ls: string[]) => ls as any[];

  it('self basis: counts webrtc and signals links only', () => {
    expect(
      countAudiblePeers({
        selfLinks: links('webrtc', 'signals', 'muted', 'down', 'absent', 'negotiating', 'blocked'),
        observerStatusTypes: [],
      }),
    ).toEqual({ count: 2, basis: 'self-links' });
  });

  it('observer basis: counts the broadcast peerLinks, same audibility rule', () => {
    expect(
      countAudiblePeers({
        observerLinks: [
          { audioLink: 'webrtc' },
          { audioLink: 'muted' },
          { audioLink: 'signals' },
        ],
        observerStatusTypes: ['Connected', 'Connected', 'Connected'],
      }),
    ).toEqual({ count: 2, basis: 'observer-links' });
  });

  it('an EMPTY broadcast still wins over the fallback — "I hear nobody" is data, not absence', () => {
    expect(
      countAudiblePeers({
        observerLinks: [],
        observerStatusTypes: ['Connected', 'Connected'],
      }),
    ).toEqual({ count: 0, basis: 'observer-links' });
  });

  it('selfLinks beats observerLinks when both are present', () => {
    expect(
      countAudiblePeers({
        selfLinks: links('webrtc'),
        observerLinks: [{ audioLink: 'muted' as any }],
        observerStatusTypes: [],
      }),
    ).toEqual({ count: 1, basis: 'self-links' });
  });

  it("fallback counts only 'Connected' (ICE+DTLS, the Phase 4 copy rule) — declared legacy lower bound", () => {
    expect(
      countAudiblePeers({
        observerStatusTypes: ['Connected', 'InitSent', 'SdpExchange', 'Disconnected', 'Connected'],
      }),
    ).toEqual({ count: 2, basis: 'connected-fallback' });
  });
});
