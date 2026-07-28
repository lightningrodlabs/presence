import { describe, it, expect } from 'vitest';
import {
  decodeRtcMessage,
  KNOWN_ACTION_MESSAGES,
} from '../rtc-message-policy';
import type { RtcAction } from '../rtc-message-policy';

const frame = (message: string): string =>
  JSON.stringify({ type: 'action', message });

describe('decodeRtcMessage — every known action message decodes to a real action', () => {
  const table: Array<[(typeof KNOWN_ACTION_MESSAGES)[number], RtcAction]> = [
    [
      'video-off',
      { kind: 'set-peer-track', track: 'video', enabled: false, event: 'PeerVideoOffSignal' },
    ],
    [
      'video-on',
      { kind: 'set-peer-track', track: 'video', enabled: true, event: 'PeerVideoOnSignal' },
    ],
    [
      'audio-off',
      { kind: 'set-peer-track', track: 'audio', enabled: false, event: 'PeerAudioOffSignal' },
    ],
    [
      'audio-on',
      { kind: 'set-peer-track', track: 'audio', enabled: true, event: 'PeerAudioOnSignal' },
    ],
    ['change-audio-input', { kind: 'log-input-change', event: 'PeerChangeAudioInput' }],
    ['change-video-input', { kind: 'log-input-change', event: 'PeerChangeVideoInput' }],
    ['request-track-refresh', { kind: 'refresh-tracks' }],
  ];

  it('covers every message in KNOWN_ACTION_MESSAGES', () => {
    expect(table.map(([m]) => m)).toEqual([...KNOWN_ACTION_MESSAGES]);
  });

  it.each(table)('%s', (message, expected) => {
    expect(decodeRtcMessage(frame(message))).toEqual([expected]);
  });
});

describe('decodeRtcMessage — nothing is silent', () => {
  it('an unknown action message is an explicit ignore, not a fall-through', () => {
    expect(decodeRtcMessage(frame('some-future-message'))).toEqual([
      { kind: 'ignore', reason: 'unknown-action' },
    ]);
  });

  it('a text frame is ignored as not-action', () => {
    expect(
      decodeRtcMessage(JSON.stringify({ type: 'text', message: 'hi' })),
    ).toEqual([{ kind: 'ignore', reason: 'not-action' }]);
  });

  it('an object with no type is ignored as not-action', () => {
    expect(decodeRtcMessage('{}')).toEqual([
      { kind: 'ignore', reason: 'not-action' },
    ]);
  });

  it('malformed JSON is a parse-error', () => {
    const [action] = decodeRtcMessage('{not json');
    expect(action.kind).toBe('parse-error');
  });

  it('non-string input is a parse-error', () => {
    const [action] = decodeRtcMessage(undefined);
    expect(action.kind).toBe('parse-error');
  });
});

describe('decodeRtcMessage — inherited edges, kept deliberately', () => {
  // These two document what the inline code in
  // _handleMediaDataChannelMessage actually did, not what a fresh design
  // would choose. Changing them is a behavior change; do it on purpose.
  it('JSON null is a parse-error (the property access threw inline too)', () => {
    const [action] = decodeRtcMessage('null');
    expect(action.kind).toBe('parse-error');
  });

  it('a bare primitive parses and is ignored as not-action', () => {
    expect(decodeRtcMessage('4')).toEqual([
      { kind: 'ignore', reason: 'not-action' },
    ]);
  });
});
