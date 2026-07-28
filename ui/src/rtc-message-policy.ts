/**
 * Phase 2b — pure decoder for media data-channel messages.
 *
 * `RTCMessage` frames arrive on the media data channel from a *remote* peer,
 * so like signal payloads (see `signal-payload.ts`) they are untrusted input.
 * The decode was previously written inline in
 * `StreamsStore._handleMediaDataChannelMessage` as seven sequential
 * non-exclusive `if`s over disjoint message strings — an unknown message fell
 * through all of them and vanished without a trace. This decoder replaces the
 * silence with an explicit `ignore` action carrying a reason, and moves the
 * message→effect mapping somewhere it can be table tested without a
 * `StreamsStore` instance (which cannot be built under vitest; see CLAUDE.md).
 *
 * Constrains `streams-store.ts:_handleMediaDataChannelMessage`, which
 * dispatches the returned actions with an exhaustive `switch`.
 */

import type { RTCMessage } from './types';
import type { SimpleEventType } from './logging';

type ActionMessage = Extract<RTCMessage, { type: 'action' }>['message'];

/**
 * Every action message the decoder knows. `satisfies` makes omitting a
 * member a compile error when a new message is added to `RTCMessage`;
 * the decode table below switches over this same set.
 */
export const KNOWN_ACTION_MESSAGES = [
  'video-off',
  'video-on',
  'audio-off',
  'audio-on',
  'change-audio-input',
  'change-video-input',
  'request-track-refresh',
] as const satisfies readonly ActionMessage[];

// Both directions: the array may not contain non-members (checked by
// `satisfies` above), and the union may not contain non-listed members
// (checked here). Adding a message to `RTCMessage` without teaching the
// decoder about it fails to compile.
const _decoderCoversEveryMessage: ActionMessage extends (typeof KNOWN_ACTION_MESSAGES)[number]
  ? true
  : never = true;
void _decoderCoversEveryMessage;

export type RtcAction =
  /** Update the peer's slot (`conn.audio` / `conn.video`) and log the event. */
  | {
      kind: 'set-peer-track';
      track: 'audio' | 'video';
      enabled: boolean;
      event: Extract<
        SimpleEventType,
        | 'PeerAudioOnSignal'
        | 'PeerAudioOffSignal'
        | 'PeerVideoOnSignal'
        | 'PeerVideoOffSignal'
      >;
    }
  /** Log only — the peer switched input devices; no slot state changes. */
  | {
      kind: 'log-input-change';
      event: Extract<SimpleEventType, 'PeerChangeAudioInput' | 'PeerChangeVideoInput'>;
    }
  /** The peer detected our tracks as dead and asks us to re-send them. */
  | { kind: 'refresh-tracks' }
  /**
   * Nothing to do — but say so. `not-action` covers `type: 'text'` frames
   * and JSON that parses to a primitive; `unknown-action` is an action
   * message this build does not know (a newer peer, or corruption that
   * still parsed).
   */
  | { kind: 'ignore'; reason: 'not-action' | 'unknown-action' }
  /** The frame did not parse. `detail` is `JSON.stringify` of the throw. */
  | { kind: 'parse-error'; detail: string };

/**
 * Decode one data-channel frame into the actions it calls for.
 *
 * Never throws. Note the inherited edge, kept deliberately: JSON that
 * parses to `null` lands in `parse-error` (the property access throws),
 * while a bare primitive like `4` parses fine and lands in
 * `ignore/not-action` — exactly what the inline code did.
 */
export function decodeRtcMessage(raw: unknown): RtcAction[] {
  try {
    const msg = JSON.parse(raw as string) as { type?: unknown; message?: unknown };
    if (msg.type !== 'action') {
      return [{ kind: 'ignore', reason: 'not-action' }];
    }
    switch (msg.message as ActionMessage) {
      case 'video-off':
        return [
          { kind: 'set-peer-track', track: 'video', enabled: false, event: 'PeerVideoOffSignal' },
        ];
      case 'video-on':
        return [
          { kind: 'set-peer-track', track: 'video', enabled: true, event: 'PeerVideoOnSignal' },
        ];
      case 'audio-off':
        return [
          { kind: 'set-peer-track', track: 'audio', enabled: false, event: 'PeerAudioOffSignal' },
        ];
      case 'audio-on':
        return [
          { kind: 'set-peer-track', track: 'audio', enabled: true, event: 'PeerAudioOnSignal' },
        ];
      case 'change-audio-input':
        return [{ kind: 'log-input-change', event: 'PeerChangeAudioInput' }];
      case 'change-video-input':
        return [{ kind: 'log-input-change', event: 'PeerChangeVideoInput' }];
      case 'request-track-refresh':
        return [{ kind: 'refresh-tracks' }];
      default:
        return [{ kind: 'ignore', reason: 'unknown-action' }];
    }
  } catch (e) {
    return [{ kind: 'parse-error', detail: JSON.stringify(e) }];
  }
}
