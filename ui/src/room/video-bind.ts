/**
 * The ONE stream-onto-<video> implementation (view-layer round, §8
 * view-misc row). Four call-site families used to hand-roll this bind —
 * the store-event handlers, _ensurePeerVideoStreams, and
 * _reapplyVideoStreams' restoreVideo — with three magic delays and two
 * subtly different rebind rules. The two rules are now named modes:
 *
 *   - `ensure`: bind only when the element's srcObject is not already
 *     this stream. NEVER null-and-reassign — re-running it against a
 *     live element must not interrupt active playback. This is the
 *     after-every-render / event-handler mode.
 *   - `restore`: unconditionally null-then-assign to recover a <video>
 *     whose rendering context was destroyed (the display:contents
 *     transition on maximize/minimize kills paint while srcObject still
 *     looks bound — only a forced reassign revives it).
 *
 * Whether a reapplied srcObject actually PAINTS is browser-real and out
 * of scope here (decided Option A, §9 brief): the decision and its
 * apply-half invariants are pinned in node (video-bind.test.ts); the
 * end-to-end paint proof stays with the Playwright harness territory.
 */

/**
 * The surface this binder touches, structurally — so tests need no
 * jsdom media stubs and the functions accept real HTMLVideoElements.
 */
export type VideoSurface = {
  srcObject: MediaProvider | null;
  autoplay: boolean;
  play(): Promise<void>;
};

export type VideoBindMode = 'ensure' | 'restore';

export type VideoBindResult =
  | { action: 'bound'; mode: VideoBindMode }
  | {
      action: 'skipped';
      reason: 'no-element' | 'no-stream' | 'already-bound';
    };

export function bindVideoStream(
  el: VideoSurface | null | undefined,
  stream: MediaProvider | null | undefined,
  mode: VideoBindMode
): VideoBindResult {
  if (!el) return { action: 'skipped', reason: 'no-element' };
  if (!stream) return { action: 'skipped', reason: 'no-stream' };
  if (mode === 'ensure' && el.srcObject === stream) {
    return { action: 'skipped', reason: 'already-bound' };
  }
  if (mode === 'restore') {
    // Force the media pipeline to re-attach — a plain reassign of the
    // same stream is a no-op to the element.
    el.srcObject = null;
  }
  el.srcObject = stream;
  el.autoplay = true;
  // Autoplay policies can reject; the bind itself already succeeded and
  // the element will start on the next user gesture.
  el.play().catch(() => {});
  return { action: 'bound', mode };
}

/**
 * Paint timers, NOT liveness windows (working agreement 2: named for the
 * predicate they serve — here "the DOM I am about to touch exists yet").
 * Each waits for Lit to commit a render that creates or recreates the
 * <video> element before binding to it.
 */
/** Maximize/minimize display:contents transition settle. */
export const MAXIMIZE_REAPPLY_DELAY_MS = 50;
/** Receiver-override switch back to video recreates the element. */
export const LAYOUT_SWITCH_REAPPLY_DELAY_MS = 100;
/** A peer-stream store event may precede the tile's first render. */
export const STREAM_EVENT_DOM_SETTLE_MS = 200;
