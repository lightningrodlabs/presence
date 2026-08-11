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
import type { AgentInfo, LastSeenBucket } from './types';

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

/**
 * The **passively-observed present** predicate's staleness window: an agent
 * whose PingUi arrived within this window is shown as "in the room" by
 * observers who have NOT joined the call (lobby room cards, the home
 * screen's main-room list — both via `passive-presence.ts`, the one
 * implementation). Wider than PRESENT_STALENESS_MS because a passive
 * observer has only ping evidence — no pongs, no media flow — so a longer
 * window buys flap resistance at the cost of a slower observed leave. Also
 * the sweep cadence: the pruner runs once per window, so worst-case
 * eviction latency is 2x the window (unchanged from the two inline models
 * this replaced, which used a bare 10000 for both roles).
 */
export const PASSIVE_PRESENT_STALENESS_MS = 5 * PING_INTERVAL;

/**
 * Freshness window for **observer testimony** (another peer's broadcast
 * peerLinks / connection statuses): testimony older than this is ignored
 * so a departed observer cannot keep ghost peers alive. Slightly under
 * the present staleness window so remote claims never outlive the
 * direct evidence they summarize. Previously the literal
 * `2.8 * PING_INTERVAL` at five call sites.
 */
export const OBSERVER_FRESHNESS_MS = 2.8 * PING_INTERVAL;

/**
 * The **reachable** buckets for the last direct pong from a peer, shown
 * as the status dot and broadcast in peerLinks. One decision for the
 * store (`StreamsStore.lastSeenBucket`) and the status-icon rendering,
 * which previously hand-duplicated the 15s/30s thresholds.
 */
export const LAST_SEEN_FRESH_MS = 15_000;
export const LAST_SEEN_GONE_MS = 30_000;

export function lastSeenBucket(
  lastSeen: number | undefined,
  now: number
): LastSeenBucket {
  if (typeof lastSeen !== 'number') return 'unknown';
  const age = now - lastSeen;
  if (age < LAST_SEEN_FRESH_MS) return 'fresh';
  if (age < LAST_SEEN_GONE_MS) return 'stale';
  return 'gone';
}

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

/**
 * The **media-flowing** predicate's window: signals-carrier voice or
 * filmstrip frames received within this window count as flowing media.
 * (WebRTC media-flowing is `connected` — ICE + DTLS up — and needs no
 * window.) Moved from streams-store's MEDIA_LIVE_WINDOW_MS.
 */
export const MEDIA_LIVE_WINDOW_MS = 3000;

export interface MediaLiveSnapshot {
  /** `_openConnections[peer]?.connected` — WebRTC media-flowing. */
  webrtcConnected: boolean;
  lastVoiceMs: number | undefined;
  lastFilmstripMs: number | undefined;
  now: number;
  windowMs: number;
}

/**
 * The **media-flowing** predicate: media is actively flowing to/from a
 * peer on either carrier. The single implementation behind
 * `StreamsStore.isPeerMediaLive` and `computePresentPeers`.
 */
export function isMediaLive(s: MediaLiveSnapshot): boolean {
  if (s.webrtcConnected) return true;
  if (s.lastVoiceMs !== undefined && s.now - s.lastVoiceMs < s.windowMs) {
    return true;
  }
  if (
    s.lastFilmstripMs !== undefined &&
    s.now - s.lastFilmstripMs < s.windowMs
  ) {
    return true;
  }
  return false;
}

/**
 * The **signal-carrier-down** predicate's window: if no known peer has
 * ponged within this long, the bidirectional Holochain signal path is
 * presumed down. 3 ticks of the presence clock, same reasoning as
 * `PRESENT_STALENESS_MS` (absorb one lost ping/pong pair without a
 * flap) — but this is a distinct predicate: carrier health, not peer
 * presence. `_signalCarrierDownSince` (`streams-store.ts`) is the one
 * store field it feeds, and `decideSignalsMediaCadence`
 * (`transport/signals-cadence-policy.ts`) is the one downstream
 * consumer of the resulting `down` flag.
 */
export const SIGNAL_CARRIER_DOWN_MS = 3 * PING_INTERVAL;

export type SignalCarrierState =
  | { down: false }
  | { down: true; downSince: number };

/**
 * The **signal-carrier-down** predicate: down when we know of at least
 * one peer but none of them have ponged within `SIGNAL_CARRIER_DOWN_MS`.
 * Zero known peers is defined as up — no evidence of peers is not
 * evidence the channel is dead, so a freshly-joined room with nobody
 * else in it never reports a down carrier.
 *
 * `downSince` is sticky across calls while still down (`prevDownSince`
 * carries the stamp from the first down evaluation forward) so the
 * duration reported at recovery is measured from the actual onset, not
 * from whichever tick last happened to call this.
 */
export function decideSignalCarrier(inputs: {
  /** lastSeen stamps for known, non-self, non-blocked peers. */
  knownPeerLastSeen: number[];
  prevDownSince: number | undefined;
  now: number;
}): SignalCarrierState {
  const { knownPeerLastSeen, prevDownSince, now } = inputs;
  if (knownPeerLastSeen.length === 0) return { down: false };
  const anyFresh = knownPeerLastSeen.some(
    t => now - t < SIGNAL_CARRIER_DOWN_MS
  );
  if (anyFresh) return { down: false };
  return { down: true, downSince: prevDownSince ?? now };
}

export interface PresentPeersSnapshot {
  /** Keys of the ping-fresh set (already excludes self and blocked). */
  activeAgents: AgentPubKeyB64[];
  openConnections: Record<AgentPubKeyB64, { connected: boolean }>;
  lastVoiceMs: ReadonlyMap<AgentPubKeyB64, number>;
  lastFilmstripMs: ReadonlyMap<AgentPubKeyB64, number>;
  blocked: AgentPubKeyB64[];
  myPubKey: AgentPubKeyB64;
  now: number;
  mediaLiveWindowMs: number;
}

/**
 * The **present** predicate: ping-fresh OR media-flowing on either
 * carrier. THE authority for every join/leave-shaped effect — chimes,
 * tiles, grid counts, phantom exclusion (Phase 2 item 5). A peer with
 * flowing media is present regardless of pong staleness; a signal-relay
 * hiccup must not remove (or re-announce) a peer we can still hear.
 *
 * Ordering: ping-fresh peers first in their given order, then media-only
 * peers sorted lexically, so tile order is stable across evaluations.
 */
export function computePresentPeers(s: PresentPeersSnapshot): AgentPubKeyB64[] {
  const out: AgentPubKeyB64[] = [...s.activeAgents];
  const seen = new Set<AgentPubKeyB64>(out);
  const mediaCandidates = new Set<AgentPubKeyB64>([
    ...Object.keys(s.openConnections),
    ...s.lastVoiceMs.keys(),
    ...s.lastFilmstripMs.keys(),
  ]);
  const extras: AgentPubKeyB64[] = [];
  for (const peer of mediaCandidates) {
    if (peer === s.myPubKey || seen.has(peer) || s.blocked.includes(peer)) {
      continue;
    }
    if (
      isMediaLive({
        webrtcConnected: !!s.openConnections[peer]?.connected,
        lastVoiceMs: s.lastVoiceMs.get(peer),
        lastFilmstripMs: s.lastFilmstripMs.get(peer),
        now: s.now,
        windowMs: s.mediaLiveWindowMs,
      })
    ) {
      extras.push(peer);
    }
  }
  extras.sort();
  return [...out, ...extras];
}

/**
 * The **present** predicate's leave hysteresis: a departure only sounds
 * after the peer has been continuously absent for this long, so a
 * presence flap shorter than the dwell produces no sound at all (no
 * leave-then-join blip). Joins sound immediately — hearing an arrival
 * promptly matters; it is the spurious departure that was the bug.
 * Clocked in ticks of the presence clock (working agreement 2), and
 * evaluated on that tick via the store's `_presentPeers` subscription.
 */
export const PRESENCE_LEAVE_DWELL_MS = 2 * PING_INTERVAL;

export interface PresenceSoundState {
  /** Peers audibly present: join has sounded, leave has not. */
  sounded: AgentPubKeyB64[];
  /** Peers in the leave dwell: absent since (clock ms). */
  pendingLeave: Record<AgentPubKeyB64, number>;
}

export const INITIAL_PRESENCE_SOUND_STATE: PresenceSoundState = {
  sounded: [],
  pendingLeave: {},
};

export type PresenceSoundEvent =
  | { kind: 'join'; peer: AgentPubKeyB64; reason: 'appeared' }
  | { kind: 'leave'; peer: AgentPubKeyB64; reason: 'dwell-elapsed' };

/**
 * Decide which join/leave sounds to play given the current present set.
 * Pure state machine: feed it every present-set change AND every
 * presence tick (dwell expiry needs re-evaluation even when the set is
 * unchanged). A peer that reappears during its dwell is silently
 * retained — the flap is absorbed.
 */
export function decidePresenceSoundEvents(input: {
  state: PresenceSoundState;
  present: AgentPubKeyB64[];
  now: number;
  leaveDwellMs: number;
}): { state: PresenceSoundState; events: PresenceSoundEvent[] } {
  const { state, present, now, leaveDwellMs } = input;
  const presentSet = new Set(present);
  const events: PresenceSoundEvent[] = [];
  const sounded: AgentPubKeyB64[] = [];
  const pendingLeave: Record<AgentPubKeyB64, number> = {};

  // Existing sounded peers: keep, start dwell, or leave.
  for (const peer of state.sounded) {
    if (presentSet.has(peer)) {
      sounded.push(peer); // present again (or still) — any dwell is dropped
      continue;
    }
    const absentSince = state.pendingLeave[peer] ?? now;
    if (now - absentSince >= leaveDwellMs) {
      events.push({ kind: 'leave', peer, reason: 'dwell-elapsed' });
    } else {
      sounded.push(peer);
      pendingLeave[peer] = absentSince;
    }
  }

  // New arrivals: join immediately.
  for (const peer of present) {
    if (!state.sounded.includes(peer)) {
      events.push({ kind: 'join', peer, reason: 'appeared' });
      sounded.push(peer);
    }
  }

  return { state: { sounded, pendingLeave }, events };
}
