/**
 * The `direct-path-usable` predicate — one authority for which carrier a
 * signal takes to one peer (`docs/DIRECT_SIGNALS_PLAN.md` §4 phase 2).
 *
 * **NOT a liveness predicate.** Presence liveness has its own four
 * authorities (`presence-policy.ts`, `carrier-coverage.ts`,
 * `peer-link-policy.ts`); nothing here may be read as "is this peer here".
 * These constants serve this predicate only (working agreement 2), and a
 * peer whose direct path is unusable is a peer we talk to over the zome
 * carrier — the declared fallback, not a degraded peer.
 *
 * Why a declared capability is not enough on its own. `CAP_DIRECT_SIGNAL`
 * says the peer's *build* speaks this carrier. It cannot say whether their
 * *conductor* will deliver: on a conductor that enforces holochain PR
 * #5974's capability grant, a receiver with no `Capability::DirectSignal`
 * grant drops the signal and **the sender is never told** — best-effort
 * fan-out with no error and no log on the send path (DIRECT_SIGNALS_PLAN.md
 * §1.1 item 3). Routing on the declaration alone would therefore send voice
 * into a black hole. So the path must be *observed*: one `PingUi` out over
 * the direct carrier, one `PongUi` back over it, before any other traffic
 * is routed there. The same gate covers every other one-way carrier
 * failure — a missing grant, an old conductor, a peer whose client cannot
 * decode `app_direct`, a relay that silently drops.
 *
 * `DIRECT_PROBE_RETRY_MS` is what lets a peer that commits its grant later
 * (or upgrades mid-session) recover without a reload.
 *
 * Pure by construction — snapshot in, tagged union out, each arm carrying
 * its `reason` — so it is table tested with no mocks
 * (`transport/media-event-policy.ts` is the template).
 */

/**
 * Largest envelope this build will hand to the direct carrier.
 *
 * Sized for the conductor this repo currently pins: holochain 0.7.0 signs
 * the raw payload through lair, whose IPC frames cap at 8 KiB, so ~8 KB is
 * a hard wall and 7 KiB leaves envelope headroom. Holochain #5956 (first in
 * `holochain-0.7.1-rc.0`) signs a hash instead and lifts the real ceiling to
 * `DIRECT_SIGNAL_MAX_SIZE` = 1 MiB, so this constant rises once the holonix
 * pin does — check with `nix develop -c holochain --version`, and re-measure
 * with `tests/src/signal-latency/direct-signal-latency.test.ts` before
 * raising it (DIRECT_SIGNALS_PLAN.md §1.1 item 1).
 */
export const DIRECT_SIGNAL_MAX_PAYLOAD_BYTES = 7 * 1024;

/** How long a direct probe may stay unanswered before the path is called
 *  unusable. Generous against the measured direct RTT (single-digit ms on
 *  loopback, phase 0) because a probe competes with a cold peer-store
 *  lookup and the peer's own UI startup. */
export const DIRECT_PROBE_TIMEOUT_MS = 4000;

/** How long an unusable path waits before being re-probed. The recovery
 *  path for a peer that commits its capability grant, upgrades its
 *  conductor, or reopens its UI mid-session. */
export const DIRECT_PROBE_RETRY_MS = 30000;

export type DirectPathState = 'unknown' | 'probing' | 'usable' | 'unusable';

export type DirectPathRecord = {
  state: DirectPathState;
  /** When the in-flight probe was sent; `null` unless `state === 'probing'`. */
  probeSentAt: number | null;
  /** When the last probe resolved either way; the retry clock reads it. */
  lastResultAt: number | null;
  /** Probes sent for this peer this session. Forensics only — no decision
   *  reads it, so there is no attempt cap to tune. */
  attempts: number;
};

export function initialDirectPathRecord(): DirectPathRecord {
  return { state: 'unknown', probeSentAt: null, lastResultAt: null, attempts: 0 };
}

/** Which of the two holochain signal carriers a message takes. Distinct
 *  from `decideSignalCarrier` (`presence-policy.ts`), which is about
 *  whether the signal channel is up at all. */
export type SignalPath = 'direct' | 'zome';

export type SignalPathDecision = {
  path: SignalPath;
  reason: string;
};

/**
 * Which carrier one message to one peer takes.
 *
 * Order matters: environment (do we even have a port) before peer
 * declaration before observed path before payload size, so the `reason` a
 * caller logs names the outermost cause rather than an incidental one.
 */
export function decideSignalPath(input: {
  capDeclared: boolean;
  record: DirectPathRecord;
  payloadBytes: number;
  portAvailable: boolean;
}): SignalPathDecision {
  if (!input.portAvailable) return { path: 'zome', reason: 'no-direct-port' };
  if (!input.capDeclared) {
    return { path: 'zome', reason: 'peer-lacks-direct-signal-cap' };
  }

  switch (input.record.state) {
    case 'unknown':
    case 'probing':
      return { path: 'zome', reason: 'path-unproven' };
    case 'unusable':
      return { path: 'zome', reason: 'path-unusable' };
    case 'usable':
      return input.payloadBytes > DIRECT_SIGNAL_MAX_PAYLOAD_BYTES
        ? { path: 'zome', reason: 'payload-over-direct-ceiling' }
        : { path: 'direct', reason: 'path-proven' };
  }
}

export type DirectProbeDecision = {
  action: 'send-probe' | 'expire-probe' | 'idle';
  reason: string;
};

/**
 * What the probe driver should do for one peer on this tick.
 *
 * `send-probe` means send a direct `PingUi` and call `markDirectProbeSent`;
 * `expire-probe` means call `applyDirectProbeResult(…, 'timeout')`. The
 * driver never decides; it only executes these two.
 */
export function decideDirectProbeAction(input: {
  now: number;
  capDeclared: boolean;
  portAvailable: boolean;
  record: DirectPathRecord;
}): DirectProbeDecision {
  if (!input.portAvailable) return { action: 'idle', reason: 'no-direct-port' };
  if (!input.capDeclared) {
    return { action: 'idle', reason: 'peer-lacks-direct-signal-cap' };
  }

  const { state, probeSentAt, lastResultAt } = input.record;

  switch (state) {
    case 'unknown':
      return { action: 'send-probe', reason: 'path-unknown' };
    case 'probing':
      return probeSentAt !== null && input.now - probeSentAt >= DIRECT_PROBE_TIMEOUT_MS
        ? { action: 'expire-probe', reason: 'probe-timed-out' }
        : { action: 'idle', reason: 'probe-in-flight' };
    case 'unusable':
      return lastResultAt !== null && input.now - lastResultAt >= DIRECT_PROBE_RETRY_MS
        ? { action: 'send-probe', reason: 'retry-window-open' }
        : { action: 'idle', reason: 'retry-window-closed' };
    case 'usable':
      return { action: 'idle', reason: 'path-usable' };
  }
}

/** Record that a probe went out. Keeps `lastResultAt` so the retry clock is
 *  not rewound by the send itself. */
export function markDirectProbeSent(
  record: DirectPathRecord,
  now: number
): DirectPathRecord {
  return {
    state: 'probing',
    probeSentAt: now,
    lastResultAt: record.lastResultAt,
    attempts: record.attempts + 1,
  };
}

/**
 * Fold a probe outcome into the record.
 *
 * An `answered` outcome always wins, from any state: observed delivery is
 * stronger evidence than the timeout that preceded it, and a `PongUi` that
 * arrives over the direct carrier is exactly that observation. A `timeout`
 * only applies to a probe that is actually in flight, so a stale expiry
 * cannot demote a path that has since been proven.
 */
export function applyDirectProbeResult(
  record: DirectPathRecord,
  result: { now: number; outcome: 'answered' | 'timeout' }
): DirectPathRecord {
  if (result.outcome === 'answered') {
    return {
      state: 'usable',
      probeSentAt: null,
      lastResultAt: result.now,
      attempts: record.attempts,
    };
  }

  if (record.state !== 'probing') return record;

  return {
    state: 'unusable',
    probeSentAt: null,
    lastResultAt: result.now,
    attempts: record.attempts,
  };
}
