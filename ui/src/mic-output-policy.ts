/**
 * decideMicOutput — the ONE decision about what MicSource's output track
 * is (spec Section 4). Plain object in, tagged union out, `reason` on every
 * arm; `media-event-policy.ts` shape. MicSource applies it; nothing else
 * decides.
 *
 * The output is either the raw device track ('device') or the track of a
 * MediaStreamAudioDestinationNode ('mixed') fed by whichever sources
 * exist: the device, the mixin, or both. A mixin with no device is a
 * one-source mix — including audio from the machine does not require the
 * microphone and never opens it, so no recording indicator lights for a
 * user who only wanted to share what they are playing. The mic's own
 * branch is what mute silences (`MicSource.setMuted`), so a muted user's
 * share keeps flowing.
 *
 * The decision is total: for every (device, mixin, current) triple it says
 * what the output must become, including clearing it. MicSource never
 * hand-writes an output change outside this.
 */

export type MicOutputMode = 'device' | 'mixed';

export type MicOutputInput = {
  /** The raw device track, or null when no device is open. */
  device: MediaStreamTrack | null;
  /** The mixin track the user asked to include, or null. */
  mixin: MediaStreamTrack | null;
  /** What the output currently is; when mixed, which sources the graph was built from. */
  current:
    | { mode: 'device' }
    | { mode: 'mixed'; device: MediaStreamTrack | null; mixin: MediaStreamTrack }
    | null;
};

export type MicOutputDecision =
  /** Install the raw device track as the output. */
  | { kind: 'use-device'; reason: 'device-only' }
  /** Build a graph for these sources and install its destination track. */
  | { kind: 'build-mix'; reason: 'mixin-added' | 'mixin-changed' }
  /**
   * Add, swap or drop the device's node inside the EXISTING graph. The
   * destination track is untouched, so no consumer and no peer sees a
   * swap — turning the microphone on or off during a share costs nothing
   * on the wire.
   */
  | { kind: 'sync-mix-device'; reason: 'device-added' | 'device-changed' | 'device-removed' }
  /** Drop the graph; the output becomes the device track, or nothing. */
  | { kind: 'tear-mix'; reason: 'mixin-removed' | 'mixin-ended' }
  /** No sources remain and something is installed: the output goes away. */
  | { kind: 'clear-output'; reason: 'no-source' }
  | { kind: 'none'; reason: 'no-source' | 'already-device' | 'already-mixed' };

/**
 * The ONE track-liveness predicate for the mic path: `decideMicOutput`
 * reads both the device and the mixin through it, `MicSource.acquire`/
 * `_ensureOpen` and `CameraSource` decide "needs (re)opening" with it, and
 * the store refuses a capture whose track resolved already ended with it.
 * An ended track is silence forever, whichever side of the mix it is on.
 */
export function isLiveTrack(track: MediaStreamTrack | null): track is MediaStreamTrack {
  return !!track && track.readyState === 'live';
}

/** Why a system-audio request cannot start right now (`decideSystemAudioRequest`). */
export type SystemAudioRequestBlock = 'no-seam' | 'already-active' | 'request-pending';

export type SystemAudioRequestInput = {
  /** The host offers `captureAudioSources` (older hosts do not). */
  seamAvailable: boolean;
  /** A capture is held. */
  active: boolean;
  /** A request is awaiting the host picker (the host allows one). */
  pending: boolean;
};

export type SystemAudioRequestDecision =
  | { ok: true }
  | { ok: false; reason: SystemAudioRequestBlock };

/**
 * The ONE gate on starting a system-audio request. `StreamsStore.systemAudioOn`
 * refuses on it and the menu row (`room-view.ts`, `_renderSystemAudioRow`)
 * disables and labels itself from the same decision, so the row can never
 * offer a click the store will refuse.
 *
 * The microphone is deliberately NOT a condition. It was, while the mix
 * had to be built on a device track; `decideMicOutput` now mixes the
 * mixin alone, so sharing what you are playing neither requires nor opens
 * the microphone (field feedback, 2026-09-24).
 */
export function decideSystemAudioRequest(input: SystemAudioRequestInput): SystemAudioRequestDecision {
  if (!input.seamAvailable) return { ok: false, reason: 'no-seam' };
  if (input.active) return { ok: false, reason: 'already-active' };
  if (input.pending) return { ok: false, reason: 'request-pending' };
  return { ok: true };
}

export function decideMicOutput(input: MicOutputInput): MicOutputDecision {
  const current = input.current;
  // Liveness, not presence, on both sources: a track that ended without
  // its `ended` event (the capture reconciler reads the lifecycle, not
  // `readyState`) is silence, not a source. Read `input.mixin` for
  // presence separately — a non-live mixin that is still there ended
  // under us, which is a different report than the caller removing it.
  const device = isLiveTrack(input.device) ? input.device : null;
  const mixin = isLiveTrack(input.mixin) ? input.mixin : null;

  if (!mixin) {
    // The mixin is what a graph is for. Without one the output is the
    // device track itself — no nodes, nothing to keep in sync.
    if (current?.mode === 'mixed') {
      return { kind: 'tear-mix', reason: input.mixin !== null ? 'mixin-ended' : 'mixin-removed' };
    }
    if (device) {
      return current?.mode === 'device'
        ? { kind: 'none', reason: 'already-device' }
        : { kind: 'use-device', reason: 'device-only' };
    }
    return current
      ? { kind: 'clear-output', reason: 'no-source' }
      : { kind: 'none', reason: 'no-source' };
  }

  // A live mixin: the output is the graph, with or without the microphone.
  if (current?.mode !== 'mixed') return { kind: 'build-mix', reason: 'mixin-added' };
  if (current.mixin !== mixin) return { kind: 'build-mix', reason: 'mixin-changed' };
  if (current.device !== device) {
    return {
      kind: 'sync-mix-device',
      reason: !device ? 'device-removed' : !current.device ? 'device-added' : 'device-changed',
    };
  }
  return { kind: 'none', reason: 'already-mixed' };
}
