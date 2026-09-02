import type { AgentPubKeyB64 } from '@holochain/client';

/**
 * LocalIntent — the durable record of what the user last asked for.
 *
 * INVARIANT (pinned by __tests__/intent-write-sites.test.ts): intent is
 * written only by StreamsStore._applyIntent, and _applyIntent is called
 * only from user-gesture entry points — never from event handlers,
 * timers, transport callbacks, or reconcilers. One documented
 * gesture-equivalent exception exists: the `ended` event on a local
 * display-capture track ('screen-share-track-ended'), because stopping a
 * share from outside the app UI is a user action the platform delivers
 * as a track event.
 *
 * EXTENSION POINT (not built — YAGNI, no automatic writer exists today):
 * if a future feature must override intent automatically (a flap
 * watchdog, an auto-mute policy), do NOT add a writer here. Add a
 * separate named-override layer (effectiveIntent = applyPolicyOverrides
 * (intent, overrides, now)) so the user's record survives to be
 * restored when the condition clears.
 *
 * Device-id selection is deliberately NOT here: it is storage-backed
 * with live-read semantics via MicSource/CameraSource bindings and
 * moving it changes nothing observable.
 */
export type LocalIntent = {
  /** wanted: the device should be held with a live track (mute keeps the
   *  device — audioOff mutes, it does not release; see streams-store
   *  audioOff's comment). muted: track.enabled state. */
  mic: { wanted: boolean; muted: boolean };
  camera: { wanted: boolean };
  screenShare: { wanted: boolean };
  webrtc: { enabled: boolean; disabledWith: ReadonlySet<AgentPubKeyB64> };
};

export type IntentGesture =
  | { type: 'audio-on' }                 // audioOn(true)
  | { type: 'audio-mute' }               // audioOn(false) or audioOff
  | { type: 'video-on' }
  | { type: 'video-off' }
  | { type: 'screen-share-on' }          // fires only after the picker succeeds
  | { type: 'screen-share-off' }         // toolbar button / stop overlay
  | { type: 'screen-share-track-ended' } // gesture-equivalent (see header)
  | { type: 'carrier-mode'; mode: 'webrtc' | 'signals' }
  | { type: 'peer-webrtc'; peer: AgentPubKeyB64; disabled: boolean }
  | { type: 'session-end' };             // disconnect(): all wants drop

export function applyIntentGesture(
  intent: LocalIntent,
  gesture: IntentGesture,
): LocalIntent {
  switch (gesture.type) {
    case 'audio-on':
      return { ...intent, mic: { wanted: true, muted: false } };
    case 'audio-mute':
      // audioOn(false) acquires-then-mutes; audioOff mutes an already
      // wanted mic. Either way the device stays wanted once it has been
      // wanted (fast re-enable, no renegotiation) — matching audioOff's
      // do-not-release semantics. A never-wanted mic stays unwanted.
      return {
        ...intent,
        mic: { wanted: intent.mic.wanted, muted: true },
      };
    case 'video-on':
      return { ...intent, camera: { wanted: true } };
    case 'video-off':
      return { ...intent, camera: { wanted: false } };
    case 'screen-share-on':
      return { ...intent, screenShare: { wanted: true } };
    case 'screen-share-off':
    case 'screen-share-track-ended':
      return { ...intent, screenShare: { wanted: false } };
    case 'carrier-mode':
      return {
        ...intent,
        webrtc: { ...intent.webrtc, enabled: gesture.mode === 'webrtc' },
      };
    case 'peer-webrtc': {
      const next = new Set(intent.webrtc.disabledWith);
      if (gesture.disabled) next.add(gesture.peer);
      else next.delete(gesture.peer);
      return { ...intent, webrtc: { ...intent.webrtc, disabledWith: next } };
    }
    case 'session-end':
      return {
        ...intent,
        mic: { wanted: false, muted: intent.mic.muted },
        camera: { wanted: false },
        screenShare: { wanted: false },
        // carrier selection survives the session — it is persisted intent
      };
    default: {
      const exhaustive: never = gesture;
      void exhaustive;
      return intent;
    }
  }
}

/** Initial intent at store construction. Carrier selection is persisted
 *  ('disableAllWebrtc' in local storage). `StreamsStore.webrtcGloballyDisabled`
 *  is a getter over this record's `webrtc.enabled` (Task 4) — this is the
 *  only place that key is read back into a running value. Media wants
 *  start false. */
export function initialLocalIntent(local: {
  getItem(key: string): string | null;
}): LocalIntent {
  return {
    mic: { wanted: false, muted: true },
    camera: { wanted: false },
    screenShare: { wanted: false },
    webrtc: {
      enabled: local.getItem('disableAllWebrtc') !== 'true',
      disabledWith: new Set(),
    },
  };
}
