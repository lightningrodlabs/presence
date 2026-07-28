/**
 * Pure presence decisions and the named freshness constants they use.
 *
 * Shape follows `transport/auto-flip-policy.ts`: plain-object snapshot in,
 * plain data out, table-driven tests, no mocks. The `StreamsStore` derived
 * stores are thin wiring around these functions; every threshold in here
 * names the predicate it serves (working agreement 2 — no new threshold
 * without a named predicate).
 */
import type { AgentPubKeyB64 } from '@holochain/client';
import type { AgentInfo } from './types';

/**
 * Cadence of the presence clock: pings go out and the staleness tick
 * fires every PING_INTERVAL ms. Every presence threshold below is a
 * multiple of this so the whole predicate family shares one clock.
 */
export const PING_INTERVAL = 2000;

/**
 * The **present** predicate's staleness window: a peer with a pong within
 * this window is present. 3 ticks absorbs a single lost ping/pong pair
 * without a flap.
 */
export const PRESENT_STALENESS_MS = 3 * PING_INTERVAL;

export interface ActiveAgentsSnapshot {
  knownAgents: Record<AgentPubKeyB64, AgentInfo>;
  blocked: AgentPubKeyB64[];
  myPubKey: AgentPubKeyB64;
  /** Current time from the owning store's Clock. */
  now: number;
  stalenessMs: number;
}

/**
 * The ping-fresh half of the **present** predicate: agents whose last
 * pong is within `stalenessMs`, excluding self and blocked agents.
 *
 * Taking `now` explicitly documents the time dependency the old inline
 * `derived` hid — the result is only as fresh as the last evaluation,
 * which is why the store re-derives it on a clock tick (Phase 2 item 4)
 * rather than only on a store write.
 */
export function computeActiveAgents(
  snapshot: ActiveAgentsSnapshot
): Record<AgentPubKeyB64, AgentInfo> {
  const { knownAgents, blocked, myPubKey, now, stalenessMs } = snapshot;
  const active: Record<AgentPubKeyB64, AgentInfo> = {};
  for (const [pubkey, info] of Object.entries(knownAgents)) {
    if (
      pubkey !== myPubKey &&
      !blocked.includes(pubkey) &&
      info.lastSeen !== undefined &&
      now - info.lastSeen < stalenessMs
    ) {
      active[pubkey] = info;
    }
  }
  return active;
}
