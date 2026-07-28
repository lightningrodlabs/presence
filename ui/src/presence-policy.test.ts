import { describe, expect, it } from 'vitest';
import {
  computeActiveAgents,
  PING_INTERVAL,
  PRESENT_STALENESS_MS,
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
