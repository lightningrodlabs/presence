import { describe, expect, it } from 'vitest';
import {
  computeActiveAgents,
  computePresentPeers,
  decidePresenceSoundEvents,
  decideSignalCarrier,
  INITIAL_PRESENCE_SOUND_STATE,
  isMediaLive,
  lastSeenBucket,
  MEDIA_LIVE_WINDOW_MS,
  PING_INTERVAL,
  PRESENCE_LEAVE_DWELL_MS,
  PRESENT_STALENESS_MS,
  type PresenceSoundState,
} from './presence-policy';
import type { AgentInfo } from './types';

const info = (pubkey: string, lastSeen: number | undefined): AgentInfo => ({
  pubkey,
  type: 'known',
  lastSeen,
  appVersion: undefined,
});

const NOW = 1_000_000;

describe('computeActiveAgents', () => {
  const base = {
    blocked: [] as string[],
    myPubKey: 'me',
    now: NOW,
    stalenessMs: PRESENT_STALENESS_MS,
  };

  const table: Array<{
    name: string;
    knownAgents: Record<string, AgentInfo>;
    blocked?: string[];
    expected: string[];
  }> = [
    {
      name: 'fresh pong is active',
      knownAgents: { a: info('a', NOW - 1000) },
      expected: ['a'],
    },
    {
      name: 'pong exactly at the window edge is stale (strict <)',
      knownAgents: { a: info('a', NOW - PRESENT_STALENESS_MS) },
      expected: [],
    },
    {
      name: 'one ms inside the window is active',
      knownAgents: { a: info('a', NOW - PRESENT_STALENESS_MS + 1) },
      expected: ['a'],
    },
    {
      name: 'never-seen agent (lastSeen undefined) is not active',
      knownAgents: { a: info('a', undefined) },
      expected: [],
    },
    {
      name: 'self is excluded even when fresh',
      knownAgents: { me: info('me', NOW) },
      expected: [],
    },
    {
      name: 'blocked agent is excluded even when fresh',
      knownAgents: { a: info('a', NOW) },
      blocked: ['a'],
      expected: [],
    },
    {
      name: 'mixed set keeps only fresh, unblocked, non-self agents',
      knownAgents: {
        a: info('a', NOW - 1000),
        b: info('b', NOW - PRESENT_STALENESS_MS - 1),
        c: info('c', undefined),
        me: info('me', NOW),
        d: info('d', NOW - 500),
      },
      blocked: ['d'],
      expected: ['a'],
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      const result = computeActiveAgents({
        ...base,
        knownAgents: row.knownAgents,
        blocked: row.blocked ?? [],
      });
      expect(Object.keys(result)).toEqual(row.expected);
    });
  }

  it('carries the full AgentInfo through unchanged', () => {
    const a = info('a', NOW - 1);
    const result = computeActiveAgents({ ...base, knownAgents: { a } });
    expect(result.a).toBe(a);
  });

  it('staleness window is 3 ping ticks (the present predicate clock)', () => {
    expect(PRESENT_STALENESS_MS).toBe(3 * PING_INTERVAL);
  });
});

describe('lastSeenBucket', () => {
  const table: Array<{
    name: string;
    lastSeen: number | undefined;
    expected: string;
  }> = [
    { name: 'no timestamp is unknown', lastSeen: undefined, expected: 'unknown' },
    { name: 'just seen is fresh', lastSeen: NOW, expected: 'fresh' },
    { name: '14.999s is fresh', lastSeen: NOW - 14_999, expected: 'fresh' },
    { name: '15s exactly is stale', lastSeen: NOW - 15_000, expected: 'stale' },
    { name: '29.999s is stale', lastSeen: NOW - 29_999, expected: 'stale' },
    { name: '30s exactly is gone', lastSeen: NOW - 30_000, expected: 'gone' },
    // A timestamp of 0 is a real timestamp, not absence (the !lastSeen
    // bug class the stale-connection policy also had to close).
    { name: 'timestamp 0 with now 0 is fresh', lastSeen: 0, expected: 'fresh' },
  ];
  for (const row of table) {
    it(row.name, () => {
      const now = row.lastSeen === 0 ? 0 : NOW;
      expect(lastSeenBucket(row.lastSeen, now)).toBe(row.expected);
    });
  }
});

describe('isMediaLive', () => {
  const base = { now: NOW, windowMs: MEDIA_LIVE_WINDOW_MS };

  const table: Array<{
    name: string;
    webrtcConnected: boolean;
    lastVoiceMs?: number;
    lastFilmstripMs?: number;
    expected: boolean;
  }> = [
    { name: 'webrtc connected alone is live', webrtcConnected: true, expected: true },
    { name: 'nothing at all is not live', webrtcConnected: false, expected: false },
    {
      name: 'voice inside the window is live',
      webrtcConnected: false,
      lastVoiceMs: NOW - MEDIA_LIVE_WINDOW_MS + 1,
      expected: true,
    },
    {
      name: 'voice exactly at the window edge is not live (strict <)',
      webrtcConnected: false,
      lastVoiceMs: NOW - MEDIA_LIVE_WINDOW_MS,
      expected: false,
    },
    {
      name: 'filmstrip inside the window is live',
      webrtcConnected: false,
      lastFilmstripMs: NOW - 100,
      expected: true,
    },
    {
      name: 'stale voice but fresh filmstrip is live',
      webrtcConnected: false,
      lastVoiceMs: NOW - 60_000,
      lastFilmstripMs: NOW - 100,
      expected: true,
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      expect(
        isMediaLive({
          webrtcConnected: row.webrtcConnected,
          lastVoiceMs: row.lastVoiceMs,
          lastFilmstripMs: row.lastFilmstripMs,
          ...base,
        })
      ).toBe(row.expected);
    });
  }
});

describe('computePresentPeers', () => {
  const base = {
    blocked: [] as string[],
    myPubKey: 'me',
    now: NOW,
    mediaLiveWindowMs: MEDIA_LIVE_WINDOW_MS,
  };
  const noVoice = new Map<string, number>();
  const noFilmstrip = new Map<string, number>();

  it('ping-fresh peers are present in their given order', () => {
    expect(
      computePresentPeers({
        ...base,
        activeAgents: ['b', 'a'],
        openConnections: {},
        lastVoiceMs: noVoice,
        lastFilmstripMs: noFilmstrip,
      })
    ).toEqual(['b', 'a']);
  });

  it('a connected WebRTC peer with stale pongs is still present', () => {
    expect(
      computePresentPeers({
        ...base,
        activeAgents: [],
        openConnections: { a: { connected: true } },
        lastVoiceMs: noVoice,
        lastFilmstripMs: noFilmstrip,
      })
    ).toEqual(['a']);
  });

  it('a signals-voice peer with stale pongs is still present (closes the audio-with-no-tile divergence)', () => {
    expect(
      computePresentPeers({
        ...base,
        activeAgents: [],
        openConnections: {},
        lastVoiceMs: new Map([['a', NOW - 100]]),
        lastFilmstripMs: noFilmstrip,
      })
    ).toEqual(['a']);
  });

  it('a non-connected slot with no recent media is not present', () => {
    expect(
      computePresentPeers({
        ...base,
        activeAgents: [],
        openConnections: { a: { connected: false } },
        lastVoiceMs: noVoice,
        lastFilmstripMs: noFilmstrip,
      })
    ).toEqual([]);
  });

  it('media-only extras come after active peers, sorted', () => {
    expect(
      computePresentPeers({
        ...base,
        activeAgents: ['z'],
        openConnections: { c: { connected: true }, b: { connected: true } },
        lastVoiceMs: noVoice,
        lastFilmstripMs: noFilmstrip,
      })
    ).toEqual(['z', 'b', 'c']);
  });

  it('excludes self and blocked from the media half too', () => {
    expect(
      computePresentPeers({
        ...base,
        blocked: ['a'],
        activeAgents: [],
        openConnections: { a: { connected: true }, me: { connected: true } },
        lastVoiceMs: noVoice,
        lastFilmstripMs: noFilmstrip,
      })
    ).toEqual([]);
  });

  it('does not duplicate a peer both ping-fresh and media-live', () => {
    expect(
      computePresentPeers({
        ...base,
        activeAgents: ['a'],
        openConnections: { a: { connected: true } },
        lastVoiceMs: noVoice,
        lastFilmstripMs: noFilmstrip,
      })
    ).toEqual(['a']);
  });
});

describe('carrier-hold', () => {
  const noVoice = new Map<string, number>();
  const noFilmstrip = new Map<string, number>();
  const base = {
    openConnections: {},
    lastVoiceMs: noVoice,
    lastFilmstripMs: noFilmstrip,
    blocked: [] as string[],
    myPubKey: 'me',
    mediaLiveWindowMs: MEDIA_LIVE_WINDOW_MS,
  };

  it('holds previously-present peers while the carrier is down', () => {
    const r = computePresentPeers({
      ...base,
      activeAgents: [],
      now: 20_000,
      carrierDownSince: 15_000,
      heldPresent: ['peerA', 'peerB'],
    });
    expect(r).toEqual(['peerA', 'peerB']);
  });

  it('does not hold past PRESENCE_CARRIER_HOLD_MAX_MS', () => {
    const r = computePresentPeers({
      ...base,
      activeAgents: [],
      now: 50_001,
      carrierDownSince: 20_000,
      heldPresent: ['peerA'],
    });
    expect(r).toEqual([]);
  });

  it('the exact boundary (now - downSince === PRESENCE_CARRIER_HOLD_MAX_MS) is NOT held — the guard is a strict `<`', () => {
    const r = computePresentPeers({
      ...base,
      activeAgents: [],
      now: 50_000,
      carrierDownSince: 20_000,
      heldPresent: ['peerA'],
    });
    expect(r).toEqual([]);
  });

  it('never holds blocked peers or self, and does not duplicate fresh peers', () => {
    const r = computePresentPeers({
      ...base,
      activeAgents: ['peerA'],
      blocked: ['peerC'],
      now: 20_000,
      carrierDownSince: 15_000,
      heldPresent: ['peerA', 'peerC', 'me'],
    });
    expect(r).toEqual(['peerA']);
  });

  it('carrier up: absent carrierDownSince changes nothing', () => {
    const r = computePresentPeers({
      ...base,
      activeAgents: [],
      now: 20_000,
      heldPresent: ['peerA'],
    });
    expect(r).toEqual([]);
  });
});

describe('decidePresenceSoundEvents', () => {
  const DWELL = PRESENCE_LEAVE_DWELL_MS;

  const step = (
    state: PresenceSoundState,
    present: string[],
    now: number
  ) => decidePresenceSoundEvents({ state, present, now, leaveDwellMs: DWELL });

  it('a new peer joins immediately', () => {
    const r = step(INITIAL_PRESENCE_SOUND_STATE, ['a'], NOW);
    expect(r.events).toEqual([{ kind: 'join', peer: 'a', reason: 'appeared' }]);
    expect(r.state.sounded).toEqual(['a']);
  });

  it('an unchanged present set produces no events', () => {
    const r1 = step(INITIAL_PRESENCE_SOUND_STATE, ['a'], NOW);
    const r2 = step(r1.state, ['a'], NOW + PING_INTERVAL);
    expect(r2.events).toEqual([]);
  });

  it('a departure produces no event until the dwell elapses', () => {
    const r1 = step(INITIAL_PRESENCE_SOUND_STATE, ['a'], NOW);
    const r2 = step(r1.state, [], NOW + PING_INTERVAL);
    expect(r2.events).toEqual([]);
    expect(r2.state.sounded).toEqual(['a']); // still audibly present
    const r3 = step(r2.state, [], NOW + PING_INTERVAL + DWELL);
    expect(r3.events).toEqual([
      { kind: 'leave', peer: 'a', reason: 'dwell-elapsed' },
    ]);
    expect(r3.state.sounded).toEqual([]);
  });

  it('a flap shorter than the dwell produces no sound at all (the reported bug)', () => {
    const r1 = step(INITIAL_PRESENCE_SOUND_STATE, ['a'], NOW);
    // Peer vanishes from the present set (pong gap), then reappears
    // before the dwell elapses.
    const r2 = step(r1.state, [], NOW + PING_INTERVAL);
    const r3 = step(r2.state, ['a'], NOW + PING_INTERVAL + DWELL - 1);
    expect(r2.events).toEqual([]);
    expect(r3.events).toEqual([]); // no leave, and no re-join either
    expect(r3.state.sounded).toEqual(['a']);
    expect(r3.state.pendingLeave).toEqual({});
  });

  it('dwell expiry is evaluated on a tick with an unchanged (still absent) set', () => {
    const r1 = step(INITIAL_PRESENCE_SOUND_STATE, ['a'], NOW);
    const r2 = step(r1.state, [], NOW + 1000);
    // Ticks keep arriving with the same empty set; only the one past the
    // dwell emits.
    const r3 = step(r2.state, [], NOW + 1000 + DWELL - 1);
    expect(r3.events).toEqual([]);
    const r4 = step(r3.state, [], NOW + 1000 + DWELL);
    expect(r4.events).toEqual([
      { kind: 'leave', peer: 'a', reason: 'dwell-elapsed' },
    ]);
  });

  it('a join and an unrelated leave can happen in one step', () => {
    const r1 = step(INITIAL_PRESENCE_SOUND_STATE, ['a'], NOW);
    const r2 = step(r1.state, [], NOW + 1000);
    const r3 = step(r2.state, ['b'], NOW + 1000 + DWELL);
    expect(r3.events).toEqual([
      { kind: 'leave', peer: 'a', reason: 'dwell-elapsed' },
      { kind: 'join', peer: 'b', reason: 'appeared' },
    ]);
    expect(r3.state.sounded).toEqual(['b']);
  });

  it('leave dwell is 2 ping ticks (the present predicate clock)', () => {
    expect(PRESENCE_LEAVE_DWELL_MS).toBe(2 * PING_INTERVAL);
  });
});

describe('decideSignalCarrier', () => {
  it('down when no known peer is fresh within SIGNAL_CARRIER_DOWN_MS', () => {
    expect(decideSignalCarrier({ knownPeerLastSeen: [1000, 2000], prevDownSince: undefined, now: 10_000 }))
      .toEqual({ down: true, downSince: 10_000 });
  });
  it('preserves downSince while still down', () => {
    expect(decideSignalCarrier({ knownPeerLastSeen: [1000], prevDownSince: 8_000, now: 12_000 }))
      .toEqual({ down: true, downSince: 8_000 });
  });
  it('up when any peer is fresh; up with zero known peers (no evidence is not channel death)', () => {
    expect(decideSignalCarrier({ knownPeerLastSeen: [9_500], prevDownSince: 8_000, now: 10_000 })).toEqual({ down: false });
    expect(decideSignalCarrier({ knownPeerLastSeen: [], prevDownSince: undefined, now: 10_000 })).toEqual({ down: false });
  });
  it('a nonempty roster where nobody has ever ponged is indistinguishable from an empty roster', () => {
    // Mirrors the call site's filter (presence-loop.ts _emitPresenceForensics):
    // three known peers, none has a lastSeen stamp yet, so knownPeerLastSeen
    // comes out empty even though the roster itself has three entries. The
    // function only ever sees stamps, never roster size, so this input is
    // bitwise identical to the zero-known-peers case above -- deliberately:
    // "never ponged" and "not here" both read as "no evidence" here.
    const neverPongedRoster: Array<number | undefined> = [
      undefined,
      undefined,
      undefined,
    ];
    const knownPeerLastSeen = neverPongedRoster.filter(
      (ls): ls is number => ls !== undefined
    );
    expect(knownPeerLastSeen).toEqual([]);
    expect(
      decideSignalCarrier({ knownPeerLastSeen, prevDownSince: undefined, now: 10_000 })
    ).toEqual({ down: false });
  });
});
