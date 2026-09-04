/**
 * PresenceLoop — owner of the presence roster state, the signal-carrier-
 * down forensics authority, the per-ping-cycle roster sweep/merge
 * fragments, and the join/leave sound subscription (store-decomposition
 * round four, Task 1; see
 * docs/superpowers/specs/2026-09-04-presence-loop-design.md).
 *
 * Owns the roster `Writable`s (`_knownAgents`, `_presenceTick`,
 * `_othersConnectionStatuses` — the store keeps same-named delegating
 * getters, since views (`room-view.ts`) and the wiring/construction tests
 * and both field harnesses read/write them directly), the signal-carrier-
 * down authority's state (`_signalCarrierDownSince`) and the presence-
 * hold cache it feeds (`_lastComputedPresent` — the store keeps
 * delegating get/set ACCESSOR PAIRS for these two, not bare getters,
 * because both are plain values reassigned in place, not `Writable`s
 * mutated through `.set()`: the derived `_presentPeers` callback in the
 * store's constructor reads both and writes `_lastComputedPresent` every
 * tick, `_recomputeIntentDiffs` and `_evaluateSignalsCadence` read
 * `_signalCarrierDownSince`, and `disconnect()` resets
 * `_lastComputedPresent`), the forensic membership diff (`_lastPresenceSet`),
 * and the join/leave sound-decision state (`_presenceSoundState`,
 * `_presentPeersUnsub`).
 *
 * Methods: `_applyPingRosterSweep` (the known-agents/connection-status
 * roster seed, called once per `pingAgents()` cycle), `_applyPongRoster`
 * (the per-pong roster/othersConnectionStatuses merge, called from
 * `handlePongUi`), `_emitPresenceForensics` (the signal-carrier-down
 * transition detector plus the PresenceAdd/PresenceRemove forensic diff,
 * called from both `pingAgents()` and the presence-tick interval in
 * `start()` — review C1's ordering comment on why forensics must run
 * before the roster-merge write travelled with the method), and
 * `armPresenceSounds`/`disarmPresenceSounds` (the `_presentPeers`
 * subscription driving join/leave chimes — `disarmPresenceSounds` is the
 * one sanctioned wrapper extracting `disconnect()`'s inline unsub block).
 * All four method names are unchanged from their store-resident names
 * except `_armPresenceSounds`, renamed `armPresenceSounds` per the design
 * (the other three keep their underscore names, matching `_openConnections`
 * staying underscore-prefixed as a public field on `MediaLinks`).
 *
 * `_presenceReason` (not in the design's move list by name, but the sole
 * private helper closure of `_emitPresenceForensics`, with no other caller
 * anywhere in the codebase) moved with it rather than staying behind as a
 * single-caller orphan on the store — same rationale as `MediaLinks`'
 * `_setTrackReady`.
 *
 * Do NOT live here (stay on the store): `_activeAgents`/`_presentPeers`/
 * `_signalsTargets` (the derived stores themselves — defined in the
 * store's constructor, reading this owner's state only through the
 * delegating getters/accessors so construction order is a documented
 * CAUTION there, not a dependency on this file); `_connectionStatuses`
 * (the roster-seed WRITE target — shared with `handleLeaveUi` and other
 * non-presence write paths, so it stays store-resident and is reached
 * here via the `connectionStatuses` binding); `_signalsCadence`,
 * `_evaluateSignalsCadence`, `_sweepPendingInits`, `_sendPings` (the rest
 * of `pingAgents`'s fragments — the carrier-down transition writes
 * `_signalsCadence` through the `setSignalsCadence` binding, but the
 * field and its per-tick evaluation stay store-resident, per the design's
 * round-four list); `globalPresenceSet`/`isPeerMediaLive`/`_activeAgents`
 * (used far beyond forensics — reached here via bindings);
 * `_presenceTickInterval` (the timer handle — `start()`/`disconnect()`
 * composition root, out of scope for an owner extraction).
 */
import { AgentPubKey, AgentPubKeyB64, encodeHashToBase64 } from '@holochain/client';
import { get, writable, type Readable, type Writable } from '@holochain-open-dev/stores';
import {
  decidePresenceSoundEvents,
  decideSignalCarrier,
  INITIAL_PRESENCE_SOUND_STATE,
  PRESENCE_LEAVE_DWELL_MS,
} from './presence-policy';
import type { PresenceSoundState } from './presence-policy';
import { SIGNALS_RTT_DEGRADED_MS } from './transport/signals-cadence-policy';
import type { SignalsMediaCadence } from './transport/signals-cadence-policy';
import type { PeerRecord } from './peer-record';
import type {
  AgentInfo,
  ConnectionStatuses,
  OthersConnectionStatusEntry,
  PongMetaData,
  PongMetaDataV1,
  StoreEventPayload,
} from './types';
import type { PresenceLogger } from './logging';

export type PresenceLoopBindings = {
  clock: { now(): number };
  logger: PresenceLogger;
  /** StreamsStore.myPubKeyB64, late-bound (kept a function for uniformity
   *  with the rest of the record, per `MediaLinksBindings.myPubKeyB64`). */
  myPubKeyB64: () => AgentPubKeyB64;
  /** StreamsStore.allAgents (private), late-bound — populated by the
   *  all-agents subscription in `start()`, after this owner is
   *  constructed. */
  allAgents: () => AgentPubKey[];
  /** StreamsStore.blockedAgents, late-bound. */
  blockedAgents: () => Writable<AgentPubKeyB64[]>;
  eventCallback: (e: StoreEventPayload) => any;
  /** StreamsStore._connectionStatuses, late-bound — the roster-sweep
   *  write target; stays store-resident (shared with `handleLeaveUi`). */
  connectionStatuses: () => Writable<ConnectionStatuses>;
  /** StreamsStore._presentPeers, late-bound — the derived store the
   *  join/leave sound subscription subscribes to. */
  presentPeers: () => Readable<AgentPubKeyB64[]>;
  /** StreamsStore._activeAgents, late-bound — read by `_presenceReason`. */
  activeAgents: () => Readable<Record<AgentPubKeyB64, AgentInfo>>;
  /** StreamsStore._signalsTargets, late-bound — read by
   *  `_emitPresenceForensics`'s carrier-recovery RTT-EWMA reset. */
  signalsTargets: () => Readable<Set<AgentPubKeyB64>>;
  /** StreamsStore.globalPresenceSet, late-bound. */
  globalPresenceSet: () => Set<AgentPubKeyB64>;
  /** StreamsStore.isPeerMediaLive, late-bound. */
  isPeerMediaLive: (peerB64: AgentPubKeyB64) => boolean;
  /** StreamsStore._ensurePeerRecord, late-bound — record access origin. */
  ensurePeerRecord: (k: AgentPubKeyB64) => PeerRecord;
  /** StreamsStore._signalsCadence, late-bound setter — written on the
   *  carrier-down transition, in the same breath as the flip. */
  setSignalsCadence: (c: SignalsMediaCadence) => void;
};

export class PresenceLoop {
  constructor(private readonly bindings: PresenceLoopBindings) {}

  /**
   * Agents in the room that we know exist either because we saw their public key
   * linked from the ALL_AGENTS anchor ourselves or because we learnt via remote
   * signals from other peers that their public key is linked from the ALL_AGENTS
   * anchor (in case this hasn't gossiped to us yet).
   */
  _knownAgents: Writable<Record<AgentPubKeyB64, AgentInfo>> = writable({});

  /**
   * The presence clock's tick, incremented every PING_INTERVAL from
   * `start()`. `_activeAgents` derives from it so staleness is evaluated
   * on a tick rather than only when `_knownAgents` happens to be written —
   * previously eviction waited for `pingAgents`' next write, making real
   * eviction latency 6–8s instead of the declared 6s (§3.2 note).
   * Public like the other underscore stores so tests can fire a tick
   * without arming the interval (which lives in start()).
   */
  _presenceTick: Writable<number> = writable(0);

  /**
   * Connection statuses of other peers from their perspective. Is sent to us
   * via remote signals (as part of pingAgents())
   */
  _othersConnectionStatuses: Writable<
    Record<AgentPubKeyB64, OthersConnectionStatusEntry>
  > = writable({});

  /**
   * The previous tick's `computePresentPeers` output — what
   * `PRESENCE_CARRIER_HOLD_MAX_MS` holds alive while
   * `_signalCarrierDownSince` is set. Updated at the end of every
   * `_presentPeers` re-evaluation, so it is always exactly one
   * evaluation stale by construction: the tick that reads it as
   * `heldPresent` is deciding this tick's set from last tick's, never
   * its own. Reset on `disconnect()` so a stale held set from a prior
   * session can't leak into the next one. Public (not `private`): the
   * store keeps a delegating get/set accessor pair onto this field, read
   * and written from the derived `_presentPeers` callback in the store's
   * constructor and reset from `disconnect()`.
   */
  _lastComputedPresent: AgentPubKeyB64[] = [];

  /** State of the join/leave sound decision; see decidePresenceSoundEvents. */
  private _presenceSoundState: PresenceSoundState = INITIAL_PRESENCE_SOUND_STATE;

  /** Unsubscribe from the _presentPeers sound subscription. */
  private _presentPeersUnsub: (() => void) | null = null;

  /**
   * The **signal-carrier-down** authority's state: `this.clock` timestamp
   * since `decideSignalCarrier` (`presence-policy.ts`) found no known
   * peer ponged within `SIGNAL_CARRIER_DOWN_MS`, or undefined while it is
   * up. Set from `_emitPresenceForensics`, which also emits the
   * SignalCarrierDown/Up log lines on the transition. No longer
   * forensic-only: this is the one field Tasks 7-8 (signals media
   * cadence) read to decide `carrierDown` for
   * `decideSignalsMediaCadence` (`transport/signals-cadence-policy.ts`).
   * Public (not `private`): the store keeps a delegating get/set accessor
   * pair onto this field — see this file's header for the touch points.
   */
  _signalCarrierDownSince: number | undefined;

  /**
   * Last computed `globalPresenceSet()`, kept so the ping cycle can diff
   * membership and emit PresenceAdd/PresenceRemove forensic events.
   */
  private _lastPresenceSet = new Set<AgentPubKeyB64>();

  /**
   * Subscribe the join/leave sound decision to the present predicate.
   * Keys off `_presentPeers` — NOT raw `_activeAgents` — so a pong gap
   * with media still flowing produces no sound, and a genuine departure
   * sounds only after the leave dwell. Replaces room-view's direct
   * `_activeAgents` diff (the mechanism behind the leave-then-join chime
   * blip). Fires on every `_presenceTick`, which is what expires the
   * dwell. Idempotent: re-registering a callback re-uses the existing
   * subscription and its accumulated state.
   */
  armPresenceSounds(): void {
    if (this._presentPeersUnsub) return;
    let seeded = false;
    this._presentPeersUnsub = this.bindings.presentPeers().subscribe(present => {
      // The subscribe() call itself delivers the current set. Adopt it as
      // the baseline instead of chiming for peers who were already here
      // when we started listening.
      if (!seeded) {
        seeded = true;
        this._presenceSoundState = { sounded: [...present], pendingLeave: {} };
        return;
      }
      const decision = decidePresenceSoundEvents({
        state: this._presenceSoundState,
        present,
        now: this.bindings.clock.now(),
        leaveDwellMs: PRESENCE_LEAVE_DWELL_MS,
      });
      this._presenceSoundState = decision.state;
      for (const ev of decision.events) {
        this.bindings.eventCallback({
          type:
            ev.kind === 'join' ? 'peer-joined-presence' : 'peer-left-presence',
          pubKeyB64: ev.peer,
        });
      }
    });
  }

  /**
   * The one sanctioned wrapper: extracted verbatim from `disconnect()`'s
   * inline `_presentPeersUnsub` release block.
   */
  disarmPresenceSounds(): void {
    if (this._presentPeersUnsub) {
      this._presentPeersUnsub();
      this._presentPeersUnsub = null;
    }
  }

  _applyPingRosterSweep(): void {
    const knownAgents = get(this._knownAgents);
    this.bindings.allAgents()
      .map(agent => encodeHashToBase64(agent))
      .forEach(agentB64 => {
        if (agentB64 !== this.bindings.myPubKeyB64()) {
          const alreadyKnown = knownAgents[agentB64];
          if (alreadyKnown && alreadyKnown.type !== 'known') {
            knownAgents[agentB64] = {
              pubkey: agentB64,
              type: 'known',
              lastSeen: alreadyKnown.lastSeen,
              appVersion: alreadyKnown.appVersion,
            };
          } else if (!alreadyKnown) {
            knownAgents[agentB64] = {
              pubkey: agentB64,
              type: 'known',
              lastSeen: undefined,
              appVersion: undefined,
            };
          }
        }
      });
    // NOTE: There is a minor chance that this._knownAgents changes as a result from code
    // elsewhere while we looped through this.allAgents above and we're overwriting these
    // changes from elsewhere here. But we consider this possibility negligible for now.
    this._knownAgents.set(knownAgents);

    // Update connection statuses with known people for which we do not yet have a connection status
    this.bindings.connectionStatuses().update(currentValue => {
      const connectionStatuses = currentValue;
      Object.keys(get(this._knownAgents)).forEach(agentB64 => {
        if (!connectionStatuses[agentB64]) {
          if (get(this.bindings.blockedAgents()).includes(agentB64)) {
            connectionStatuses[agentB64] = {
              type: 'Blocked',
            };
          } else {
            connectionStatuses[agentB64] = {
              type: 'Disconnected',
            };
          }
        }
      });
      return connectionStatuses;
    });
  }

  _applyPongRoster(
    pubkeyB64: AgentPubKeyB64,
    metaData: PongMetaData<PongMetaDataV1>,
    now: number
  ): void {
    this._othersConnectionStatuses.update(statuses => {
      const newStatuses = statuses;
      newStatuses[pubkeyB64] = {
        lastUpdated: now,
        statuses: metaData.data.connectionStatuses,
        screenShareStatuses: metaData.data.screenShareConnectionStatuses,
        knownAgents: metaData.data.knownAgents,
        perceivedStreamInfo: metaData.data.streamInfo,
        peerLinks: metaData.data.peerLinks,
      };
      return statuses;
    });

    // Update known agents based on the agents that they know
    this._knownAgents.update(store => {
      const knownAgents = store;
      const maybeKnownAgent = knownAgents[pubkeyB64];
      if (maybeKnownAgent) {
        maybeKnownAgent.appVersion = metaData.data.appVersion;
        maybeKnownAgent.lastSeen = this.bindings.clock.now();
      } else {
        knownAgents[pubkeyB64] = {
          pubkey: pubkeyB64,
          type: 'told',
          lastSeen: this.bindings.clock.now(),
          appVersion: metaData.data.appVersion,
        };
      }
      if (metaData.data.knownAgents) {
        Object.entries(metaData.data.knownAgents).forEach(
          ([agentB64, agentInfo]) => {
            if (!knownAgents[agentB64] && agentB64 !== this.bindings.myPubKeyB64()) {
              knownAgents[agentB64] = {
                pubkey: agentB64,
                type: 'told',
                lastSeen: undefined, // We did not receive a Pong from them directly
                appVersion: agentInfo.appVersion,
              };
            }
          }
        );
      }
      return knownAgents;
    });
  }

  /**
   * Per-ping-cycle forensics and the signal-carrier-down authority:
   *
   *  - SignalCarrierDown/Up — delegates to `decideSignalCarrier`
   *    (`presence-policy.ts`), which is down when at least one known
   *    peer has ponged before but none of those ponged-at-least-once
   *    peers is fresh within `SIGNAL_CARRIER_DOWN_MS`. Makes signal-relay
   *    outages visible in merged logs, and the resulting
   *    `_signalCarrierDownSince` feeds `decideSignalsMediaCadence`
   *    (Tasks 7-8) — this is no longer forensic-only.
   *  - PresenceAdd/PresenceRemove — diff of `globalPresenceSet()` with the
   *    reason a peer entered (media-live / ping-fresh / observer-reported),
   *    so the pane-survival behaviour of `isPeerMediaLive` is observable.
   *
   * Ordering (review C1): both call sites — `pingAgents()` and the
   * presence-tick interval in `start()` — must run this BEFORE the next
   * write that re-derives `_activeAgents` -> `_presentPeers`
   * (`pingAgents()`'s roster-merge `_knownAgents.set()`, the interval's
   * own `_presenceTick.update()`), so the carrier hold reading
   * `_signalCarrierDownSince` there sees THIS tick's verdict, not last
   * tick's. See the full rationale at each call site in streams-store.ts
   * (`pingAgents`'s comment above its call, and `start()`'s comment above
   * the interval) — not repeated here to avoid a second copy drifting.
   */
  _emitPresenceForensics(): void {
    const now = this.bindings.clock.now();

    const known = get(this._knownAgents);
    const blocked = get(this.bindings.blockedAgents());
    const knownPeers = Object.keys(known).filter(
      k => k !== this.bindings.myPubKeyB64() && !blocked.includes(k),
    );
    // Peers with no `lastSeen` yet are deliberately excluded here, not
    // passed through as a value `decideSignalCarrier` could treat as
    // "not fresh" — there are three paths that leave `lastSeen`
    // undefined: initial roster seeding (this class's own
    // `_applyPingRosterSweep`'s `!alreadyKnown` branch, which seeds a
    // newly-seen `allAgents` entry with no `lastSeen`), a peer-leave
    // clear (`handleLeaveUi`), and a told-only agent we've never
    // received a Pong from directly (`_applyPongRoster`'s `knownAgents`
    // merge).
    // Declared behavior change from the old inline predicate: it counted
    // a known-but-never-ponged peer as "not fresh", so a relay that was
    // dead from the very first tick (nobody had ponged yet) logged a
    // spurious SignalCarrierDown on tick 1. `decideSignalCarrier` cannot
    // distinguish "never ponged" from "not here" and refuses to call
    // either one channel death, so that dead-from-start detection is
    // forfeited on purpose — it survives as long as at least one peer has
    // ponged at least once and then goes stale.
    const knownPeerLastSeen = knownPeers
      .map(k => known[k]?.lastSeen)
      .filter((ls): ls is number => ls !== undefined);
    const prevDownSince = this._signalCarrierDownSince;
    const carrierState = decideSignalCarrier({
      knownPeerLastSeen,
      prevDownSince,
      now,
    });
    this._signalCarrierDownSince = carrierState.down
      ? carrierState.downSince
      : undefined;
    if (carrierState.down && prevDownSince === undefined) {
      // Immediate back-off, in the same breath as the flip: the per-tick
      // evaluation in pingAgents() would land on 'paused' anyway, but the
      // senders must not get frames into a relay that just proved dead
      // for however long a caller-ordering change could delay that
      // evaluation. Recovery is NOT forced here — it rides the per-tick
      // evaluation and the policy's one-level-per-tick hysteresis.
      this.bindings.setSignalsCadence({ mode: 'paused', reason: 'carrier-down' });
      this.bindings.logger.logCustomMessage(
        `SignalCarrierDown: no pong from any of ${knownPeers.length} known peer(s)`,
      );
    } else if (!carrierState.down && prevDownSince !== undefined) {
      const downMs = now - prevDownSince;
      this.bindings.logger.logCustomMessage(
        `SignalCarrierUp: pong path recovered after ${downMs}ms`,
      );
      // Reset the RTT EWMA for current signals targets to
      // SIGNALS_RTT_DEGRADED_MS, not delete it (final-review wave F5,
      // amended per re-review N2): a sample folded across the outage is
      // evidence about the DEAD channel, not the one that just recovered
      // — carrying it forward fed the cadence policy's one-level-per-tick
      // hysteresis a stale collapsed reading and forced a ~20s walk-back
      // (paused -> voice-only -> full) even once the link was fine again.
      // A bare delete (no-sample) would have jumped straight to 'full' —
      // resuming both voice AND filmstrip at full rate into a relay that
      // JUST recovered, one tick ahead of any real evidence it can carry
      // that load. Landing exactly at the degraded threshold instead
      // means `decideSignalsMediaCadence` resumes at 'voice-only' on this
      // tick (same one-tick honesty: no stale collapsed reading survives
      // the flip), and the next real sample governs from there — a
      // healthy pong decays the EWMA below half-degraded and walks it on
      // to 'full' over the following ticks, same as any other recovery.
      for (const target of get(this.bindings.signalsTargets())) {
        this.bindings.ensurePeerRecord(target).signalsRttEwma = SIGNALS_RTT_DEGRADED_MS;
      }
    }

    const current = this.bindings.globalPresenceSet();
    const prev = this._lastPresenceSet;
    for (const peer of current) {
      if (peer === this.bindings.myPubKeyB64() || prev.has(peer)) continue;
      this.bindings.logger.logAgentEvent({
        agent: peer,
        timestamp: now,
        event: 'PresenceAdd',
        detail: `reason=${this._presenceReason(peer)}`,
      });
    }
    for (const peer of prev) {
      if (peer === this.bindings.myPubKeyB64() || current.has(peer)) continue;
      this.bindings.logger.logAgentEvent({
        agent: peer,
        timestamp: now,
        event: 'PresenceRemove',
        detail: 'reason=ping-stale+no-media',
      });
    }
    this._lastPresenceSet = current;
  }

  /** Why a peer is currently in `globalPresenceSet()`. Forensics helper. */
  private _presenceReason(peer: AgentPubKeyB64): string {
    if (this.bindings.isPeerMediaLive(peer)) return 'media-live';
    if (get(this.bindings.activeAgents())[peer]) return 'ping-fresh';
    return 'observer-reported';
  }
}
