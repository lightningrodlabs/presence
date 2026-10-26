/**
 * Audio output (sink) selection — the ONE place a chosen output device is
 * applied to a playback target.
 *
 * Two kinds of target play remote audio in Presence:
 *   - `HTMLMediaElement`: the peer-tile and screen-share `<video>` elements
 *     (WebRTC audio) and the join/leave chime `Audio` objects, all owned by
 *     `room-view.ts` (`_applyAudioOutput`, run after every render);
 *   - the shared `AudioContext` owned by `MicSource` (`ensureAudioContext`):
 *     signals voice playout connects to `ctx.destination`
 *     (`room/modules/voice.ts`). `MicSource.setOutputDevice` applies the
 *     selection there, and re-applies it when the context is created later.
 *
 * Both expose the same `setSinkId`/`sinkId` contract (Audio Output Devices
 * API; Web Audio API 1.1 for `AudioContext`). TypeScript 4.9's lib.dom
 * declares neither, so `AudioSinkTarget` is the structural type both are
 * read through. `''` is the default output on both; a platform without the
 * API (WebKitGTK, Firefox) has no `setSinkId` and the call is a no-op.
 *
 * The selection itself has one home: `MediaSettings._audioOutputId`
 * (`ui/src/media-settings.ts`), written only by `changeAudioOutput`.
 * `undefined` there means "the default output" and maps to `''` here; any
 * other id (including Chromium's literal `'default'`) is passed through.
 */
export interface AudioSinkTarget {
  readonly sinkId?: unknown;
  setSinkId?: (sinkId: string) => Promise<void>;
}

export type AudioSinkOutcome = 'unsupported' | 'unchanged' | 'applied';

/** The sink id a stored output selection maps to. */
export function sinkIdFor(deviceId: string | undefined): string {
  return deviceId ?? '';
}

/**
 * Apply `deviceId` to `target`. Idempotent: a target already on that sink
 * is left alone, so this is safe to run after every render. A rejected
 * `setSinkId` (device unplugged, permission) is reported to `onError` and
 * otherwise swallowed — the target keeps playing on its previous sink.
 */
export function applyAudioSink(
  // `object`, not `AudioSinkTarget`: the interface is all-optional, so TS's
  // weak-type check would reject the real `AudioContext`/`HTMLMediaElement`
  // (whose lib.dom declarations lack both members). Read through the
  // structural type inside.
  target: object | null | undefined,
  deviceId: string | undefined,
  onError: (e: unknown) => void = () => {}
): AudioSinkOutcome {
  const t = target as AudioSinkTarget | null | undefined;
  if (!t || typeof t.setSinkId !== 'function') return 'unsupported';
  const wanted = sinkIdFor(deviceId);
  if (t.sinkId === wanted) return 'unchanged';
  try {
    t.setSinkId(wanted).catch(onError);
  } catch (e) {
    onError(e);
  }
  return 'applied';
}
