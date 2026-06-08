/**
 * Reconnect Policy — Pluggable retry/backoff for WebRTC reconnection.
 *
 * Default uses quadratic backoff with jitter (inspired by LiveKit):
 * [0, 300, 1200, 2700, 4800, 7000, 7000, 7000, 7000, 7000]
 * Formula: min(n^2 * baseDelayMs, maxDelayMs) + random(0, jitterMs) for n > 1
 *
 * Two-tier strategy:
 * - First attempts use ICE restart (fast path, preserves DTLS)
 * - After iceRestartMaxAttempts, switches to full reconnect (slow path)
 * - DTLS failures always use full reconnect (a fresh DTLS handshake needs a
 *   new transport, which only a full reconnect provides)
 *
 * Every tuning knob is a constructor option with a documented default; nothing
 * is hard-wired. The whole policy is also replaceable — pass any `ReconnectPolicy`
 * to `ConnectionManager`/`PeerConnectionFSM` if you need different behaviour.
 *
 * Note on giving up: the WebRTC spec mandates no retry count or backoff — this
 * is purely application policy. A fixed `maxAttempts` can give up mid-outage
 * (a VPN flap or network handover can exceed the backoff window). For
 * presence-style apps that already know when a peer is still wanted, set
 * `maxAttempts: Infinity` and close the connection from the higher layer when
 * the peer leaves, rather than relying on a count.
 */

import type { ReconnectContext, ReconnectPolicy } from './types.js';

/** Defaults for `DefaultReconnectPolicy`. Exported so callers can reference or
 *  partially override them without re-deriving the magic numbers. */
export const DEFAULT_RECONNECT_OPTIONS = {
  /** Max retry attempts before giving up (FSM transitions to `failed`). */
  maxAttempts: 10,
  /** Fast-path ICE-restart attempts before escalating to full reconnect. */
  iceRestartMaxAttempts: 3,
  /** Base backoff unit (ms): delay = min(n^2 * baseDelayMs, maxDelayMs). */
  baseDelayMs: 300,
  /** Backoff cap (ms). */
  maxDelayMs: 7_000,
  /** Max random jitter (ms) added after the first attempt (thundering-herd). */
  jitterMs: 1_000,
} as const;

export type DefaultReconnectPolicyOptions = {
  /**
   * Maximum retry attempts before giving up; on exhaustion the FSM transitions
   * to `failed`. Default {@link DEFAULT_RECONNECT_OPTIONS.maxAttempts}. Set to
   * `Infinity` to retry until the caller closes the connection — recommended
   * for presence-style apps where a fixed count can give up during a transient
   * outage.
   */
  maxAttempts?: number;
  /**
   * Number of fast-path ICE-restart attempts before escalating to full
   * reconnect. Default {@link DEFAULT_RECONNECT_OPTIONS.iceRestartMaxAttempts}.
   */
  iceRestartMaxAttempts?: number;
  /**
   * Base backoff unit in ms; the delay grows as `min(n^2 * baseDelayMs,
   * maxDelayMs)`. Default {@link DEFAULT_RECONNECT_OPTIONS.baseDelayMs}.
   */
  baseDelayMs?: number;
  /** Backoff cap in ms. Default {@link DEFAULT_RECONNECT_OPTIONS.maxDelayMs}. */
  maxDelayMs?: number;
  /**
   * Maximum random jitter in ms added to every attempt after the first, to
   * desynchronise both peers. Default {@link DEFAULT_RECONNECT_OPTIONS.jitterMs}.
   */
  jitterMs?: number;
};

export class DefaultReconnectPolicy implements ReconnectPolicy {
  readonly maxAttempts: number;
  private _iceRestartMaxAttempts: number;
  private _baseDelayMs: number;
  private _maxDelayMs: number;
  private _jitterMs: number;

  constructor(options?: DefaultReconnectPolicyOptions) {
    this.maxAttempts = options?.maxAttempts ?? DEFAULT_RECONNECT_OPTIONS.maxAttempts;
    this._iceRestartMaxAttempts =
      options?.iceRestartMaxAttempts ?? DEFAULT_RECONNECT_OPTIONS.iceRestartMaxAttempts;
    this._baseDelayMs = options?.baseDelayMs ?? DEFAULT_RECONNECT_OPTIONS.baseDelayMs;
    this._maxDelayMs = options?.maxDelayMs ?? DEFAULT_RECONNECT_OPTIONS.maxDelayMs;
    this._jitterMs = options?.jitterMs ?? DEFAULT_RECONNECT_OPTIONS.jitterMs;
  }

  nextRetryDelayMs(context: ReconnectContext): number | null {
    if (context.retryCount >= this.maxAttempts) {
      return null; // Stop retrying
    }

    const n = context.retryCount;
    const baseDelay = Math.min(n * n * this._baseDelayMs, this._maxDelayMs);

    // Add jitter after first attempt to prevent thundering herd
    const jitter = n > 0 ? Math.floor(Math.random() * this._jitterMs) : 0;

    return baseDelay + jitter;
  }

  strategy(context: ReconnectContext): 'ice-restart' | 'full-reconnect' {
    // DTLS failure needs a fresh handshake — always full reconnect. A
    // data-channel stall that survived in-place recreate implies a sick SCTP
    // association, so it likewise needs a fresh peer rather than an ICE restart.
    if (context.retryReason === 'dtls-failed' || context.retryReason === 'data-channel-stall') {
      return 'full-reconnect';
    }

    // First N attempts use ICE restart (fast path)
    if (context.retryCount < this._iceRestartMaxAttempts) {
      return 'ice-restart';
    }

    // After that, switch to full reconnect (slow path)
    return 'full-reconnect';
  }
}
