/**
 * Cross-pane room-ownership protocol (view-layer round; §8's flagship
 * extraction candidate). A presence room may be open in ONE pane per
 * origin: a Web Lock per room DNA is the mutual exclusion, and a
 * BroadcastChannel carries the two-message takeover handshake
 * (kick → released) so a second pane can ask the holder to hand over.
 *
 * This module owns the whole protocol behind injected seams
 * (StreamsStoreDeps-shaped: lock manager, channel factory, clock) so the
 * message decisions table-test pure and the handshake runs end-to-end in
 * plain node — it was inline presence-app view code with zero tests and
 * two unnamed timing windows before this file.
 *
 * Protocol invariant (pinned in room-ownership.test.ts): the holder acks
 * `released` BEFORE releasing — release() closes the holder's channel,
 * after which the ack postMessage would throw and the taker would sit
 * out its full ack window for a handover that actually happened.
 *
 * `AbortSignal.timeout` (acquire's bounded wait) is the one timer here
 * that does not route through the clock seam: the signal is consumed by
 * the lock manager, not by us, and aborting a LockManager request is
 * signal-only API. It is bounded-wait plumbing, not a liveness window.
 */

import type { Clock } from './clock';

/** Both protocol windows are handshake timing, NOT liveness predicates. */
/** How long a taker waits for the holder's `released` ack. */
export const TAKEOVER_ACK_TIMEOUT_MS = 2000;
/**
 * How long a taker waits for the freed lock after a successful ack —
 * covers the holder's release racing the taker's re-acquire.
 */
export const TAKEOVER_LOCK_WAIT_MS = 3000;

/** The one channel name; every pane of the origin meets here. */
export const ROOM_CHANNEL_NAME = 'presence-room';

export const roomLockName = (dnaHashB64: string) =>
  `presence-room:${dnaHashB64}`;

/**
 * Structural slice of BroadcastChannel the protocol touches. The
 * production binding casts `new BroadcastChannel(name)` to this — the
 * DOM type's `onmessage` takes a full MessageEvent, which is not
 * mutually assignable with the `{ data }` slice under strict function
 * types, but every handler written against the slice is safe on it.
 */
export type RoomChannelLike = {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
};

/** Structural slice of navigator.locks. */
export type LockManagerLike = {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: object | null) => unknown
  ): Promise<unknown>;
};

export type RoomOwnershipSeams = {
  /**
   * Live read — resolved per acquire, like the original
   * `(navigator as any).locks` probe, so an environment gaining or
   * losing the API between rooms is honoured.
   */
  getLocks: () => LockManagerLike | undefined;
  openChannel: (name: string) => RoomChannelLike;
  clock: Clock;
};

// ---------------------------------------------------------------------------
// Pure message decisions (the media-event-policy shape: snapshot in,
// tagged union with a reason out).

export type HolderDecision =
  | { action: 'ack-and-release' }
  | { action: 'ignore'; reason: 'malformed' | 'other-room' | 'not-kick' };

/** What the CURRENT holder does with a channel message. */
export function decideHolderMessage(
  data: unknown,
  dnaHashB64: string
): HolderDecision {
  if (!data || typeof data !== 'object') {
    return { action: 'ignore', reason: 'malformed' };
  }
  const msg = data as { type?: unknown; dnaHashB64?: unknown };
  if (msg.dnaHashB64 !== dnaHashB64) {
    return { action: 'ignore', reason: 'other-room' };
  }
  if (msg.type !== 'kick') return { action: 'ignore', reason: 'not-kick' };
  return { action: 'ack-and-release' };
}

export type TakerDecision =
  | { action: 'takeover-acknowledged' }
  | { action: 'ignore'; reason: 'malformed' | 'other-room' | 'not-released' };

/** What a WAITING taker does with a channel message. */
export function decideTakerMessage(
  data: unknown,
  dnaHashB64: string
): TakerDecision {
  if (!data || typeof data !== 'object') {
    return { action: 'ignore', reason: 'malformed' };
  }
  const msg = data as { type?: unknown; dnaHashB64?: unknown };
  if (msg.type !== 'released') {
    return { action: 'ignore', reason: 'not-released' };
  }
  if (msg.dnaHashB64 !== dnaHashB64) {
    return { action: 'ignore', reason: 'other-room' };
  }
  return { action: 'takeover-acknowledged' };
}

// ---------------------------------------------------------------------------

export type AcquireOutcome =
  /** We hold the room now; a kick handler is armed. */
  | 'acquired'
  /** Another pane holds it (or the lock manager errored/timed out). */
  | 'already-open'
  /** No Web Locks API — single-pane environment, proceed lock-less. */
  | 'no-lock-manager';

export class RoomOwnership {
  private _release: (() => void) | undefined;

  private _channel: RoomChannelLike | undefined;

  constructor(private readonly seams: RoomOwnershipSeams) {}

  /** True while this pane holds a room lock. */
  get holding(): boolean {
    return this._release !== undefined;
  }

  /**
   * Try to become the room's pane. `waitMs` bounds a wait for the
   * current holder to let go (the takeover path passes
   * TAKEOVER_LOCK_WAIT_MS); without it the request fails fast via
   * `ifAvailable`. On 'acquired', a kick from another pane acks +
   * releases and then calls `onKicked` — the caller decides what view
   * to show.
   */
  async acquire(
    dnaHashB64: string,
    opts: { waitMs?: number; onKicked: () => void }
  ): Promise<AcquireOutcome> {
    const locks = this.seams.getLocks();
    if (!locks) return 'no-lock-manager';

    const requestOpts = opts.waitMs
      ? { signal: AbortSignal.timeout(opts.waitMs) }
      : { ifAvailable: true };
    const acquired = new Promise<{ release?: () => void }>(resolveOuter => {
      locks
        .request(roomLockName(dnaHashB64), requestOpts, (lock: object | null) => {
          if (!lock) {
            resolveOuter({});
            return undefined;
          }
          // Hold the lock until release() resolves this inner promise.
          return new Promise<void>(resolveInner => {
            resolveOuter({ release: resolveInner });
          });
        })
        .catch((err: unknown) => {
          if (err && (err as { name?: string }).name !== 'AbortError') {
            console.warn('locks.request failed', err);
          }
          resolveOuter({});
        });
    });
    const { release } = await acquired;
    if (!release) return 'already-open';

    this._release = release;
    const channel = this.seams.openChannel(ROOM_CHANNEL_NAME);
    channel.onmessage = e => {
      if (decideHolderMessage(e.data, dnaHashB64).action !== 'ack-and-release')
        return;
      // Ack BEFORE releasing — release() closes this same channel, after
      // which postMessage throws and the taker times out (pinned).
      try {
        channel.postMessage({ type: 'released', dnaHashB64 });
      } catch (err) {
        console.warn('released broadcast failed', err);
      }
      this.release();
      opts.onKicked();
    };
    this._channel = channel;
    return 'acquired';
  }

  /**
   * Ask whichever pane holds `dnaHashB64` to hand it over. Resolves true
   * on an ack within TAKEOVER_ACK_TIMEOUT_MS (the lock is then free or
   * about to be — re-acquire with TAKEOVER_LOCK_WAIT_MS), false if
   * nobody answered.
   */
  async requestTakeover(dnaHashB64: string): Promise<boolean> {
    const channel = this.seams.openChannel(ROOM_CHANNEL_NAME);
    const { clock } = this.seams;
    const released = new Promise<boolean>(resolve => {
      const timer = clock.setTimeout(() => {
        resolve(false);
      }, TAKEOVER_ACK_TIMEOUT_MS);
      channel.onmessage = e => {
        if (
          decideTakerMessage(e.data, dnaHashB64).action ===
          'takeover-acknowledged'
        ) {
          clock.clearTimeout(timer);
          resolve(true);
        }
      };
    });
    channel.postMessage({ type: 'kick', dnaHashB64 });
    const ok = await released;
    channel.close();
    return ok;
  }

  /** Let go of the lock and channel. Idempotent; safe when not holding. */
  release(): void {
    if (this._release) {
      this._release();
      this._release = undefined;
    }
    if (this._channel) {
      this._channel.close();
      this._channel = undefined;
    }
  }
}
