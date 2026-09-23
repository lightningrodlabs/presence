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

/** A mixin is usable only while live: an ended track would feed silence forever. */
export function isUsableMixin(track: MediaStreamTrack | null): track is MediaStreamTrack {
  return !!track && track.readyState === 'live';
}

export function decideMicOutput(input: MicOutputInput): MicOutputDecision {
  const { device, current } = input;
  const mixinUsable = isUsableMixin(input.mixin);
  const mixinEnded = !!input.mixin && !mixinUsable;

  if (!device) {
    if (current?.mode === 'mixed') return { kind: 'tear-mix', reason: 'device-closed' };
    return { kind: 'none', reason: 'no-device' };
  }

  if (!mixinUsable) {
    if (current?.mode === 'mixed') {
      return { kind: 'tear-mix', reason: mixinEnded ? 'mixin-ended' : 'mixin-removed' };
    }
    if (current?.mode === 'device') return { kind: 'none', reason: 'already-device' };
    return { kind: 'use-device', reason: 'device-only' };
  }

  const mixin = input.mixin as MediaStreamTrack;
  if (current?.mode !== 'mixed') return { kind: 'build-mix', reason: 'mixin-added' };
  if (current.device !== device) return { kind: 'build-mix', reason: 'device-changed' };
  if (current.mixin !== mixin) return { kind: 'build-mix', reason: 'mixin-changed' };
  return { kind: 'none', reason: 'already-mixed' };
}
