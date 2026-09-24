/**
 * decideMicOutput — the ONE decision about what MicSource's output track
 * is (spec Section 4). Plain object in, tagged union out, `reason` on every
 * arm; `media-event-policy.ts` shape. MicSource applies it; nothing else
 * decides.
 *
 * The output is either the raw device track ('device') or the track of a
 * MediaStreamAudioDestinationNode fed by the device and a mixin ('mixed').
 * v1 requires the mic to be held: a mixin with no device is 'none'.
 */

export type MicOutputMode = 'device' | 'mixed';

export type MicOutputInput = {
  /** The raw device track, or null when no device is open. */
  device: MediaStreamTrack | null;
  /** The mixin track the user asked to include, or null. */
  mixin: MediaStreamTrack | null;
  /** What the output currently is; when mixed, which two tracks the graph was built from. */
  current:
    | { mode: 'device' }
    | { mode: 'mixed'; device: MediaStreamTrack; mixin: MediaStreamTrack }
    | null;
};

export type MicOutputDecision =
  | { kind: 'use-device'; reason: 'device-only' }
  | { kind: 'build-mix'; reason: 'mixin-added' | 'device-changed' | 'mixin-changed' }
  | { kind: 'tear-mix'; reason: 'mixin-removed' | 'mixin-ended' | 'device-closed' }
  | { kind: 'none'; reason: 'no-device' | 'already-device' | 'already-mixed' };

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
export type SystemAudioRequestBlock =
  | 'no-seam'
  | 'mic-not-wanted'
  | 'mic-not-live'
  | 'already-active'
  | 'request-pending';

export type SystemAudioRequestInput = {
  /** The host offers `captureAudioSources` (older hosts do not). */
  seamAvailable: boolean;
  /** `localIntent.mic.wanted`. */
  micWanted: boolean;
  /** `MicSource.lifecycle.state` — wanted is not live (permission denied, device gone). */
  micLifecycle: 'idle' | 'acquiring' | 'live' | 'ended' | 'failed';
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
 * disables and titles itself from the same decision, so the row can never
 * offer a click the store will refuse. v1 needs the mic held AND live: the
 * mix is built on the device track (`decideMicOutput` → `no-device`
 * otherwise), so a picker opened before the device is live would take a
 * choice from the user and drop it.
 */
export function decideSystemAudioRequest(input: SystemAudioRequestInput): SystemAudioRequestDecision {
  if (!input.seamAvailable) return { ok: false, reason: 'no-seam' };
  if (!input.micWanted) return { ok: false, reason: 'mic-not-wanted' };
  if (input.micLifecycle !== 'live') return { ok: false, reason: 'mic-not-live' };
  if (input.active) return { ok: false, reason: 'already-active' };
  if (input.pending) return { ok: false, reason: 'request-pending' };
  return { ok: true };
}

export function decideMicOutput(input: MicOutputInput): MicOutputDecision {
  const { device, current } = input;
  // Read before the guard: a non-null mixin that is not usable is an ended one.
  const mixinPresent = input.mixin !== null;

  // Liveness, not presence: a device track that ended without its `ended`
  // event (the reconciler reads the lifecycle, not `readyState`) is not a
  // source to mix on — the store refuses the share instead.
  if (!isLiveTrack(device)) {
    if (current?.mode === 'mixed') return { kind: 'tear-mix', reason: 'device-closed' };
    return { kind: 'none', reason: 'no-device' };
  }

  if (!isLiveTrack(input.mixin)) {
    if (current?.mode === 'mixed') {
      return { kind: 'tear-mix', reason: mixinPresent ? 'mixin-ended' : 'mixin-removed' };
    }
    if (current?.mode === 'device') return { kind: 'none', reason: 'already-device' };
    return { kind: 'use-device', reason: 'device-only' };
  }

  // The predicate narrowed input.mixin to MediaStreamTrack from here on.
  if (current?.mode !== 'mixed') return { kind: 'build-mix', reason: 'mixin-added' };
  if (current.device !== device) return { kind: 'build-mix', reason: 'device-changed' };
  if (current.mixin !== input.mixin) return { kind: 'build-mix', reason: 'mixin-changed' };
  return { kind: 'none', reason: 'already-mixed' };
}
