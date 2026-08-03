import { describe, expect, it } from 'vitest';
import type { AgentPubKey } from '@holochain/client';
import {
  PassiveParticipant,
  PassivePresenceTracker,
  applyPassivePresenceSignal,
  prunePassivePresence,
} from '../passive-presence';
import { PASSIVE_PRESENT_STALENESS_MS } from '../presence-policy';
import { ManualClock } from '../clock.testing';
import type { RoomSignal } from '../types';

// AgentPubKey is a Uint8Array on the wire; the tracker only ever compares
// via toString(), so distinct byte contents are what matter.
const key = (n: number) => new Uint8Array([n, n, n]) as unknown as AgentPubKey;

const ping = (from: AgentPubKey): RoomSignal =>
  ({ type: 'Message', from_agent: from, msg_type: 'PingUi', payload: '' }) as RoomSignal;
const leave = (from: AgentPubKey): RoomSignal =>
  ({ type: 'Message', from_agent: from, msg_type: 'LeaveUi', payload: '' }) as RoomSignal;

const list = (...entries: [AgentPubKey, number][]): PassiveParticipant[] =>
  entries.map(([pubkey, lastSeen]) => ({ pubkey, lastSeen }));

describe('applyPassivePresenceSignal', () => {
  const a = key(1);
  const b = key(2);

  const table: {
    name: string;
    participants: PassiveParticipant[];
    signal: RoomSignal;
    now: number;
    expected: PassiveParticipant[] | null;
  }[] = [
    {
      name: 'ping from a new agent adds them',
      participants: [],
      signal: ping(a),
      now: 100,
      expected: list([a, 100]),
    },
    {
      name: 'ping from a known agent refreshes lastSeen (no duplicate)',
      participants: list([a, 100], [b, 100]),
      signal: ping(a),
      now: 200,
      expected: list([b, 100], [a, 200]),
    },
    {
      name: 'leave removes the agent',
      participants: list([a, 100], [b, 100]),
      signal: leave(a),
      now: 200,
      expected: list([b, 100]),
    },
    {
      name: 'leave for an unknown agent still returns a list (re-render, matching the inline models)',
      participants: list([b, 100]),
      signal: leave(a),
      now: 200,
      expected: list([b, 100]),
    },
    {
      name: 'a non-presence Message is null (no change)',
      participants: list([a, 100]),
      signal: {
        type: 'Message',
        from_agent: b,
        msg_type: 'PongUi',
        payload: '',
      } as RoomSignal,
      now: 200,
      expected: null,
    },
    {
      name: 'a non-Message signal is null',
      participants: list([a, 100]),
      signal: { type: 'Pong', from_agent: b } as RoomSignal,
      now: 200,
      expected: null,
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      const before = [...row.participants];
      const result = applyPassivePresenceSignal(
        row.participants,
        row.signal,
        row.now
      );
      expect(result).toEqual(row.expected);
      // Pure: the input list is never mutated.
      expect(row.participants).toEqual(before);
      if (result !== null) expect(result).not.toBe(row.participants);
    });
  }
});

describe('prunePassivePresence', () => {
  const a = key(1);
  const b = key(2);

  it('drops exactly the entries at or past the staleness window', () => {
    const now = 100_000;
    const fresh = now - PASSIVE_PRESENT_STALENESS_MS + 1;
    const stale = now - PASSIVE_PRESENT_STALENESS_MS;
    expect(prunePassivePresence(list([a, fresh], [b, stale]), now)).toEqual(
      list([a, fresh])
    );
  });

  it('keeps everything inside the window untouched', () => {
    const now = 100_000;
    const l = list([a, now], [b, now - 1]);
    expect(prunePassivePresence(l, now)).toEqual(l);
  });
});

describe('PassivePresenceTracker', () => {
  const a = key(1);
  const b = key(2);

  it('tracks ping/leave through handleSignal and notifies onChange', () => {
    const clock = new ManualClock();
    const seen: PassiveParticipant[][] = [];
    const tracker = new PassivePresenceTracker(l => seen.push(l), clock);

    tracker.handleSignal(ping(a));
    tracker.handleSignal(ping(b));
    tracker.handleSignal(leave(a));
    expect(seen).toHaveLength(3);
    expect(tracker.participants.map(p => p.pubkey)).toEqual([b]);
  });

  it('ignores non-presence signals without notifying', () => {
    const clock = new ManualClock();
    const seen: PassiveParticipant[][] = [];
    const tracker = new PassivePresenceTracker(l => seen.push(l), clock);
    tracker.handleSignal({ type: 'Pong', from_agent: a } as RoomSignal);
    expect(seen).toHaveLength(0);
  });

  it('sweeps stale agents one window after their last ping', () => {
    const clock = new ManualClock();
    const seen: PassiveParticipant[][] = [];
    const tracker = new PassivePresenceTracker(l => seen.push(l), clock);
    tracker.start();

    tracker.handleSignal(ping(a));
    clock.advance(PASSIVE_PRESENT_STALENESS_MS - 1);
    tracker.handleSignal(ping(b)); // refreshes nothing for a; b is fresh
    clock.advance(1); // first sweep fires: a is exactly at the window edge
    expect(tracker.participants.map(p => p.pubkey)).toEqual([b]);

    clock.advance(PASSIVE_PRESENT_STALENESS_MS); // second sweep: b now stale
    expect(tracker.participants).toEqual([]);
  });

  it('emits on every sweep even when nothing was pruned (paint contract of the inline models)', () => {
    const clock = new ManualClock();
    const seen: PassiveParticipant[][] = [];
    const tracker = new PassivePresenceTracker(l => seen.push(l), clock);
    tracker.start();
    clock.advance(PASSIVE_PRESENT_STALENESS_MS);
    clock.advance(PASSIVE_PRESENT_STALENESS_MS);
    expect(seen).toHaveLength(2);
  });

  it('start is idempotent while armed; stop disarms and clears; restart works', () => {
    const clock = new ManualClock();
    const seen: PassiveParticipant[][] = [];
    const tracker = new PassivePresenceTracker(l => seen.push(l), clock);

    tracker.start();
    tracker.start(); // second arm must not double the sweep
    clock.advance(PASSIVE_PRESENT_STALENESS_MS);
    expect(seen).toHaveLength(1);

    tracker.handleSignal(ping(a));
    tracker.stop();
    expect(tracker.participants).toEqual([]);
    const emitted = seen.length;
    clock.advance(10 * PASSIVE_PRESENT_STALENESS_MS);
    expect(seen).toHaveLength(emitted); // no sweeps after stop

    tracker.stop(); // safe to repeat
    tracker.start();
    tracker.handleSignal(ping(b));
    clock.advance(PASSIVE_PRESENT_STALENESS_MS + 1);
    expect(tracker.participants).toEqual([]); // sweep runs again after restart
  });
});
