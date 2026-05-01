/**
 * Reconnect Policy — Pluggable retry/backoff for WebRTC reconnection.
 *
 * Default uses quadratic backoff with jitter (inspired by LiveKit):
 * [0, 300, 1200, 2700, 4800, 7000, 7000, 7000, 7000, 7000]
 * Formula: min(n^2 * 300, 7000) + random(0, 1000) for attempt > 1
 *
 * Two-tier strategy:
 * - First attempts use ICE restart (fast path, preserves DTLS)
 * - After ICE_RESTART_MAX_ATTEMPTS, switches to full reconnect (slow path)
 * - DTLS failures always use full reconnect (DTLS failed is terminal per spec)
 */

import type { ReconnectContext, ReconnectPolicy } from './types';

const DEFAULT_MAX_ATTEMPTS = 10;
const ICE_RESTART_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 7000;
const JITTER_MS = 1000;

export class DefaultReconnectPolicy implements ReconnectPolicy {
  readonly maxAttempts: number;
  private _iceRestartMaxAttempts: number;

  constructor(options?: { maxAttempts?: number; iceRestartMaxAttempts?: number }) {
    this.maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this._iceRestartMaxAttempts = options?.iceRestartMaxAttempts ?? ICE_RESTART_MAX_ATTEMPTS;
  }

  nextRetryDelayMs(context: ReconnectContext): number | null {
    if (context.retryCount >= this.maxAttempts) {
      return null; // Stop retrying
    }

    const n = context.retryCount;
    const baseDelay = Math.min(n * n * BASE_DELAY_MS, MAX_DELAY_MS);

    // Add jitter after first attempt to prevent thundering herd
    const jitter = n > 0 ? Math.floor(Math.random() * JITTER_MS) : 0;

    return baseDelay + jitter;
  }

  strategy(context: ReconnectContext): 'ice-restart' | 'full-reconnect' {
    // DTLS failure is terminal — always full reconnect
    if (context.retryReason === 'dtls-failed') {
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
