import { describe, expect, it } from 'vitest';
import {
  applyIntentGesture,
  initialLocalIntent,
  type IntentGesture,
  type LocalIntent,
} from '../intent';

/**
 * Table-driven, no mocks: `applyIntentGesture` is a pure reducer, so every
 * row is state-in/gesture-in/state-out. See intent.ts for the invariant
 * this record pins (written only by StreamsStore._applyIntent from
 * user-gesture entry points — see intent-write-sites.test.ts).
 */

const INITIAL: LocalIntent = {
  mic: { wanted: false, muted: true, includeSystemAudio: false },
  camera: { wanted: false },
  screenShare: { wanted: false },
  webrtc: { enabled: true, disabledWith: new Set() },
};

describe('applyIntentGesture: each gesture from the initial state', () => {
  const rows: Array<[string, IntentGesture, Partial<LocalIntent>]> = [
    [
      'audio-on',
      { type: 'audio-on' },
      { mic: { wanted: true, muted: false, includeSystemAudio: false } },
    ],
    [
      'audio-mute',
      { type: 'audio-mute' },
      { mic: { wanted: false, muted: true, includeSystemAudio: false } },
    ],
    ['video-on', { type: 'video-on' }, { camera: { wanted: true } }],
    ['video-off', { type: 'video-off' }, { camera: { wanted: false } }],
    ['screen-share-on', { type: 'screen-share-on' }, { screenShare: { wanted: true } }],
    ['screen-share-off', { type: 'screen-share-off' }, { screenShare: { wanted: false } }],
    [
      'screen-share-track-ended',
      { type: 'screen-share-track-ended' },
      { screenShare: { wanted: false } },
    ],
    [
      'carrier-mode webrtc',
      { type: 'carrier-mode', mode: 'webrtc' },
      { webrtc: { enabled: true, disabledWith: new Set() } },
    ],
    [
      'carrier-mode signals',
      { type: 'carrier-mode', mode: 'signals' },
      { webrtc: { enabled: false, disabledWith: new Set() } },
    ],
    [
      'system-audio-on',
      { type: 'system-audio-on' },
      { mic: { wanted: false, muted: true, includeSystemAudio: true } },
    ],
    [
      'system-audio-off',
      { type: 'system-audio-off' },
      { mic: { wanted: false, muted: true, includeSystemAudio: false } },
    ],
    [
      'system-audio-ended',
      { type: 'system-audio-ended' },
      { mic: { wanted: false, muted: true, includeSystemAudio: false } },
    ],
    [
      'session-end',
      { type: 'session-end' },
      {
        mic: { wanted: false, muted: true, includeSystemAudio: false },
        camera: { wanted: false },
        screenShare: { wanted: false },
      },
    ],
  ];

  it.each(rows)('%s', (_name, gesture, expected) => {
    const next = applyIntentGesture(INITIAL, gesture);
    expect(next).toMatchObject(expected);
  });
});

describe('applyIntentGesture: audio-mute mic.wanted preservation', () => {
  it('audio-mute on a never-wanted mic keeps wanted: false', () => {
    const next = applyIntentGesture(INITIAL, { type: 'audio-mute' });
    expect(next.mic).toEqual({ wanted: false, muted: true, includeSystemAudio: false });
  });

  it('audio-mute after audio-on keeps wanted: true', () => {
    const onceOn = applyIntentGesture(INITIAL, { type: 'audio-on' });
    const muted = applyIntentGesture(onceOn, { type: 'audio-mute' });
    expect(muted.mic).toEqual({ wanted: true, muted: true, includeSystemAudio: false });
  });
});

describe('applyIntentGesture: session-end preserves carrier selection', () => {
  it('drops all wants but leaves webrtc.enabled untouched', () => {
    const busy: LocalIntent = {
      mic: { wanted: true, muted: false, includeSystemAudio: false },
      camera: { wanted: true },
      screenShare: { wanted: true },
      webrtc: { enabled: false, disabledWith: new Set(['peerA']) },
    };
    const next = applyIntentGesture(busy, { type: 'session-end' });
    expect(next.mic.wanted).toBe(false);
    expect(next.camera.wanted).toBe(false);
    expect(next.screenShare.wanted).toBe(false);
    expect(next.webrtc).toEqual({ enabled: false, disabledWith: new Set(['peerA']) });
  });
});

describe('applyIntentGesture: peer-webrtc add/remove round-trip', () => {
  it('adds a peer to disabledWith, then removes it', () => {
    const disabled = applyIntentGesture(INITIAL, {
      type: 'peer-webrtc',
      peer: 'peerA',
      disabled: true,
    });
    expect(disabled.webrtc.disabledWith).toEqual(new Set(['peerA']));

    const reenabled = applyIntentGesture(disabled, {
      type: 'peer-webrtc',
      peer: 'peerA',
      disabled: false,
    });
    expect(reenabled.webrtc.disabledWith).toEqual(new Set());
  });

  it('does not mutate the input disabledWith set', () => {
    const before = new Set(['peerA']);
    const intent: LocalIntent = { ...INITIAL, webrtc: { enabled: true, disabledWith: before } };
    applyIntentGesture(intent, { type: 'peer-webrtc', peer: 'peerB', disabled: true });
    expect(before).toEqual(new Set(['peerA']));
  });
});

describe('initialLocalIntent', () => {
  it('disableAllWebrtc = "true" yields webrtc.enabled: false', () => {
    const intent = initialLocalIntent({ getItem: () => 'true' });
    expect(intent.webrtc.enabled).toBe(false);
    expect(intent.webrtc.disabledWith).toEqual(new Set());
  });

  it('disableAllWebrtc = null yields webrtc.enabled: true', () => {
    const intent = initialLocalIntent({ getItem: () => null });
    expect(intent.webrtc.enabled).toBe(true);
  });

  it('media wants all start false', () => {
    const intent = initialLocalIntent({ getItem: () => null });
    expect(intent.mic.wanted).toBe(false);
    expect(intent.camera.wanted).toBe(false);
    expect(intent.screenShare.wanted).toBe(false);
  });
});

describe('system audio rides the mic: what clears it and what does not', () => {
  const included: LocalIntent = {
    ...INITIAL,
    mic: { wanted: true, muted: false, includeSystemAudio: true },
  };

  it('audio-mute keeps includeSystemAudio (mute silences the mixed track, it does not end the share)', () => {
    expect(applyIntentGesture(included, { type: 'audio-mute' }).mic).toEqual({
      wanted: true,
      muted: true,
      includeSystemAudio: true,
    });
  });

  it('audio-on keeps includeSystemAudio', () => {
    expect(applyIntentGesture(included, { type: 'audio-on' }).mic.includeSystemAudio).toBe(true);
  });

  it('system-audio-off and system-audio-ended both clear it and touch nothing else', () => {
    for (const type of ['system-audio-off', 'system-audio-ended'] as const) {
      expect(applyIntentGesture(included, { type }).mic).toEqual({
        wanted: true,
        muted: false,
        includeSystemAudio: false,
      });
    }
  });

  it('session-end clears it along with the other wants', () => {
    const next = applyIntentGesture(included, { type: 'session-end' });
    expect(next.mic).toEqual({ wanted: false, muted: false, includeSystemAudio: false });
  });

  it('initialLocalIntent starts with includeSystemAudio false', () => {
    expect(initialLocalIntent({ getItem: () => null }).mic.includeSystemAudio).toBe(false);
  });
});
