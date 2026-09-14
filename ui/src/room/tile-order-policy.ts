import type { AgentPubKeyB64 } from '@holochain/client';

/**
 * Grid tile order — the ONE authority for where a peer's tile sits in the
 * room grid (pinned by `__tests__/tile-order-policy.test.ts`, which also
 * source-pins room-view onto this function).
 *
 * Key: the agent's ALL_AGENTS anchor-link timestamp, committed once per
 * cell by the room zome's `init` (dnas/presence/zomes/coordinator/room/src/
 * all_agents.rs) and read from the DHT by every participant. Because the
 * value is stored, not measured, every screen sorts the same numbers and
 * clock skew is irrelevant; the room keeps the same seating across calls.
 *
 * Present tiles and phantom tiles ("reported in room by others, not
 * reachable by you") interleave on that key, so a peer moving between the
 * two — or between the ping-fresh and media-only halves of
 * `computePresentPeers` — keeps its slot. That segment jumping was the
 * field symptom: a pong hiccup on a peer with live WebRTC media sent their
 * tile to the tail and back.
 *
 * Membership stays elsewhere: `computePresentPeers` (presence-policy.ts)
 * decides who is present, `StreamsStore.phantomAgents` who is a phantom.
 * This function only orders what it is handed. A pubkey whose anchor link
 * has not reached us yet sorts after every stamped peer, lexically, until
 * the next poll delivers it.
 */
export interface TileOrderSnapshot {
  /** `StreamsStore._presentPeers` — the present predicate's output. */
  present: AgentPubKeyB64[];
  /** `StreamsStore.phantomAgents()` — disjoint from `present` by construction. */
  phantoms: AgentPubKeyB64[];
  /** `RoomStore.agentJoinedAt` — anchor-link timestamps by pubkey (µs). */
  joinedAt: Record<AgentPubKeyB64, number>;
}

export type OrderedTile = {
  pubkey: AgentPubKeyB64;
  kind: 'present' | 'phantom';
};

export function orderTiles(s: TileOrderSnapshot): OrderedTile[] {
  const tiles = new Map<AgentPubKeyB64, OrderedTile>();
  for (const pubkey of s.phantoms) tiles.set(pubkey, { pubkey, kind: 'phantom' });
  // Present wins over phantom for the same key.
  for (const pubkey of s.present) tiles.set(pubkey, { pubkey, kind: 'present' });
  return [...tiles.values()].sort((x, y) => {
    const jx = s.joinedAt[x.pubkey];
    const jy = s.joinedAt[y.pubkey];
    if (jx !== undefined && jy !== undefined && jx !== jy) return jx - jy;
    if (jx !== undefined && jy === undefined) return -1;
    if (jx === undefined && jy !== undefined) return 1;
    return x.pubkey < y.pubkey ? -1 : x.pubkey > y.pubkey ? 1 : 0;
  });
}
