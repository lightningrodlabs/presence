/**
 * The ONE implementation of passively-observed room presence — tracking who
 * is in a room from its PingUi / LeaveUi signals without joining the call.
 *
 * Consumers: the lobby room cards (`lobby/room-online-agents.ts`) and the
 * home screen's main-room list (`presence-app.ts`). Replaces the two
 * hand-rolled copies of this model (each with its own `Date.now()` and bare
 * `10000` literals) found by the 2026-08 retro — `MAINTAINABILITY_ASSESSMENT.md`
 * §7.4 item 2. A third copy is the parallel-path move working agreement 1
 * forbids: extend this one.
 *
 * The decision halves are pure (`applyPassivePresenceSignal`,
 * `prunePassivePresence`, table-tested); `PassivePresenceTracker` is the thin
 * stateful wrapper on an injectable `Clock`. The staleness window and sweep
 * cadence are `PASSIVE_PRESENT_STALENESS_MS` (`presence-policy.ts`), the
 * named home of the presence-family constants.
 */
import type { AgentPubKey } from '@holochain/client';
import { Clock, systemClock } from './clock';
import { PASSIVE_PRESENT_STALENESS_MS } from './presence-policy';
import type { RoomSignal } from './types';

export interface PassiveParticipant {
  pubkey: AgentPubKey;
  lastSeen: number;
}

/**
 * Fold one room signal into the participant list. Returns the next list, or
 * `null` when the signal is not presence-relevant (caller keeps its state and
 * skips the re-render). A LeaveUi for an agent not in the list still returns
 * a (fresh, equal) list — matching the inline models this replaced, which
 * reassigned on every LeaveUi.
 */
export function applyPassivePresenceSignal(
  participants: readonly PassiveParticipant[],
  signal: RoomSignal,
  now: number
): PassiveParticipant[] | null {
  if (signal.type !== 'Message') return null;
  if (signal.msg_type === 'PingUi') {
    const next = participants.filter(
      info => info.pubkey.toString() !== signal.from_agent.toString()
    );
    next.push({ pubkey: signal.from_agent, lastSeen: now });
    return next;
  }
  if (signal.msg_type === 'LeaveUi') {
    return participants.filter(
      info => info.pubkey.toString() !== signal.from_agent.toString()
    );
  }
  return null;
}

/** Drop participants whose last ping is outside the staleness window. */
export function prunePassivePresence(
  participants: readonly PassiveParticipant[],
  now: number,
  stalenessMs: number = PASSIVE_PRESENT_STALENESS_MS
): PassiveParticipant[] {
  return participants.filter(info => now - info.lastSeen < stalenessMs);
}

export class PassivePresenceTracker {
  private _participants: PassiveParticipant[] = [];

  private _gcHandle: number | undefined;

  constructor(
    private onChange: (participants: PassiveParticipant[]) => void,
    private clock: Clock = systemClock
  ) {}

  get participants(): readonly PassiveParticipant[] {
    return this._participants;
  }

  /** Arm the staleness sweep. Idempotent while armed. */
  start(): void {
    if (this._gcHandle !== undefined) return;
    this._gcHandle = this.clock.setInterval(() => {
      this._participants = prunePassivePresence(
        this._participants,
        this.clock.now()
      );
      // Emit on every sweep, changed or not — consumers assign to a Lit
      // @state, where a redundant fresh array is a cheap re-render and a
      // skipped emit is a stale list. Same behavior as the inline models.
      this.onChange(this._participants);
    }, PASSIVE_PRESENT_STALENESS_MS);
  }

  handleSignal(signal: RoomSignal): void {
    const next = applyPassivePresenceSignal(
      this._participants,
      signal,
      this.clock.now()
    );
    if (next !== null) {
      this._participants = next;
      this.onChange(next);
    }
  }

  /** Disarm the sweep and clear the list. Safe to call repeatedly. */
  stop(): void {
    this.clock.clearInterval(this._gcHandle);
    this._gcHandle = undefined;
    this._participants = [];
  }
}
