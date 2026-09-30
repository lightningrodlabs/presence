import { describe, it, expect } from 'vitest';
import {
  describePeerTile,
  decideSilenceStamps,
  LINK_STUCK_ACT_MS,
} from '../peer-tile-policy';
import type { PeerTileInputs, PeerTileState } from '../peer-tile-policy';
import { INTENT_DIFF_GRACE_MS, VIDEO_PACED_COPY } from '../intent-diff-policy';

/**
 * The grid in docs/superpowers/specs/2026-09-30-peer-tile-state-design.md
 * is this table. Full-object toEqual per row, so an arm that changes an
 * undeclared field fails the row.
 */

const NOW = 1_000_000;

function base(p: Partial<PeerTileInputs>): PeerTileInputs {
  return {
    webrtcExpected: true,
    audioLink: 'down',
    peerMicMuted: false,
    peerCameraOn: undefined,
    slot: undefined,
    filmstripLive: false,
    audioSilentSince: undefined,
    videoSilentSince: undefined,
    qualityBucket: undefined,
    now: NOW,
    ...p,
  };
}

const NO_AUDIO = 'no audio — reconnecting…';
const CANT_CONNECT = "can't connect — try Reconnect";
const CONNECTING_VIDEO = 'connecting video…';

type Row = [string, Partial<PeerTileInputs>, PeerTileState];

const ROWS: Row[] = [
  // ---- Group 1: WebRTC expected ----
  ['1a silence, no stamp yet', { audioLink: 'negotiating' },
    { background: 'avatar', audio: 'silent', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'silent-under-grace' }],
  ['1a silence < grace', { audioLink: 'negotiating', audioSilentSince: NOW - INTENT_DIFF_GRACE_MS + 1 },
    { background: 'avatar', audio: 'silent', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'silent-under-grace' }],
  ['1b silence >= grace, WebRTC still signaling', { audioLink: 'negotiating', audioSilentSince: NOW - INTENT_DIFF_GRACE_MS, slot: { connected: false, video: false } },
    { background: 'avatar', audio: 'silent', quality: 'unknown', statusLine: NO_AUDIO, attention: 'wait', reason: 'silent-wait' }],
  ['1c silence >= act threshold', { audioLink: 'down', audioSilentSince: NOW - LINK_STUCK_ACT_MS },
    { background: 'avatar', audio: 'silent', quality: 'unknown', statusLine: CANT_CONNECT, attention: 'act', reason: 'silent-act' }],
  ['1d audio via signals while WebRTC establishes (the Uruguay log)', { audioLink: 'signals', slot: { connected: false, video: true }, audioSilentSince: NOW - 60_000 },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['1e WebRTC up, audio live, camera off', { audioLink: 'webrtc', peerCameraOn: false, slot: { connected: true, video: true }, qualityBucket: 'webrtc:ok:clean:smooth' },
    { background: 'avatar', audio: 'live', quality: 'ok', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['1f filmstrip active over signals', { audioLink: 'signals', filmstripLive: true, qualityBucket: 'signals:poor:clean:smooth' },
    { background: 'filmstrip', audio: 'live', quality: 'poor', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['1g WebRTC up, video track arrived muted', { audioLink: 'webrtc', peerCameraOn: true, slot: { connected: true, video: true, videoMuted: true } },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: CONNECTING_VIDEO, attention: 'wait', reason: 'video-track-muted' }],
  ['1h WebRTC up, audio + video live', { audioLink: 'webrtc', peerCameraOn: true, slot: { connected: true, video: true, videoMuted: false }, qualityBucket: 'webrtc:bad:lossy:rough' },
    { background: 'video', audio: 'live', quality: 'bad', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['1i WebRTC up, camera on, no track >= grace', { audioLink: 'webrtc', peerCameraOn: true, slot: { connected: true, video: false }, videoSilentSince: NOW - INTENT_DIFF_GRACE_MS },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: CONNECTING_VIDEO, attention: 'wait', reason: 'video-waiting-webrtc' }],
  ['1i-under-grace WebRTC up, camera on, no track < grace', { audioLink: 'webrtc', peerCameraOn: true, slot: { connected: true, video: false }, videoSilentSince: NOW - INTENT_DIFF_GRACE_MS + 1 },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['1j muted, WebRTC up, video live', { audioLink: 'muted', peerMicMuted: true, peerCameraOn: true, slot: { connected: true, video: true, videoMuted: false } },
    { background: 'video', audio: 'muted', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'muted' }],
  ['1j-muted-with-video-line muted keeps the video line', { audioLink: 'muted', peerMicMuted: true, peerCameraOn: true, slot: { connected: true, video: true, videoMuted: true } },
    { background: 'avatar', audio: 'muted', quality: 'unknown', statusLine: CONNECTING_VIDEO, attention: 'wait', reason: 'video-track-muted' }],
  // The slot still holds a (frozen) video track through ICE recovery, so
  // the background stays 'video' — "last frame", per the spec's row 1i —
  // under the "no audio" line.
  ['1k ICE-disconnected: slot connected, audio down >= grace', { audioLink: 'down', slot: { connected: true, video: true }, audioSilentSince: NOW - INTENT_DIFF_GRACE_MS },
    { background: 'video', audio: 'silent', quality: 'unknown', statusLine: NO_AUDIO, attention: 'wait', reason: 'silent-wait' }],
  ['1l pongs gone but media flowing: absent never shows while flowing', { audioLink: 'signals', filmstripLive: true },
    { background: 'filmstrip', audio: 'live', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['absent (carrier hold) shows nothing', { audioLink: 'absent', audioSilentSince: NOW - 60_000 },
    { background: 'avatar', audio: 'silent', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'absent' }],
  ['blocked shows nothing', { audioLink: 'blocked', audioSilentSince: NOW - 60_000 },
    { background: 'avatar', audio: 'silent', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'blocked' }],
  ['legacy-sender-camera-off: cameraOn unknown, video-off cleared conn.video', { audioLink: 'webrtc', peerCameraOn: undefined, slot: { connected: true, video: false } },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['legacy-sender-camera-on: cameraOn unknown, track live', { audioLink: 'webrtc', peerCameraOn: undefined, slot: { connected: true, video: true, videoMuted: false } },
    { background: 'video', audio: 'live', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['video before connected never renders as video', { audioLink: 'signals', peerCameraOn: true, slot: { connected: false, video: true, videoMuted: false } },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  // ---- Group 2: signals only ----
  ['2a signals-only silence < grace', { webrtcExpected: false, audioLink: 'down', audioSilentSince: NOW - 1 },
    { background: 'avatar', audio: 'silent', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'silent-under-grace' }],
  ['2b signals-only silence >= grace', { webrtcExpected: false, audioLink: 'down', audioSilentSince: NOW - INTENT_DIFF_GRACE_MS },
    { background: 'avatar', audio: 'silent', quality: 'unknown', statusLine: NO_AUDIO, attention: 'wait', reason: 'silent-wait' }],
  ['2c signals-only silence >= act', { webrtcExpected: false, audioLink: 'down', audioSilentSince: NOW - LINK_STUCK_ACT_MS - 1 },
    { background: 'avatar', audio: 'silent', quality: 'unknown', statusLine: CANT_CONNECT, attention: 'act', reason: 'silent-act' }],
  ['2d voice flowing, camera off', { webrtcExpected: false, audioLink: 'signals', peerCameraOn: false },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['caps-unknown: voice flowing, cameraOn unknown', { webrtcExpected: false, audioLink: 'signals', peerCameraOn: undefined, videoSilentSince: NOW - 60_000 },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['2e voice + filmstrip', { webrtcExpected: false, audioLink: 'signals', filmstripLive: true, peerCameraOn: true },
    { background: 'filmstrip', audio: 'live', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'audio-flowing' }],
  ['2f voice flowing, camera on, no filmstrip >= grace', { webrtcExpected: false, audioLink: 'signals', peerCameraOn: true, videoSilentSince: NOW - INTENT_DIFF_GRACE_MS },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: VIDEO_PACED_COPY, attention: 'none', reason: 'video-paced' }],
  ['1d+camera: WebRTC expected but not connected, camera on, no filmstrip >= grace → paced', { webrtcExpected: true, audioLink: 'signals', peerCameraOn: true, slot: { connected: false, video: false }, videoSilentSince: NOW - INTENT_DIFF_GRACE_MS },
    { background: 'avatar', audio: 'live', quality: 'unknown', statusLine: VIDEO_PACED_COPY, attention: 'none', reason: 'video-paced' }],
  ['2g signals-only muted', { webrtcExpected: false, audioLink: 'muted', peerMicMuted: true },
    { background: 'avatar', audio: 'muted', quality: 'unknown', statusLine: undefined, attention: 'none', reason: 'muted' }],
];

describe('describePeerTile — the grid', () => {
  it.each(ROWS)('%s', (_name, partial, expected) => {
    expect(describePeerTile(base(partial))).toEqual(expected);
  });

  it('no status line names a carrier (spec decision 2)', () => {
    const banned = /webrtc|signals|carrier|\bICE\b|\bSDP\b/i;
    for (const [name, partial] of ROWS) {
      const line = describePeerTile(base(partial)).statusLine;
      if (line !== undefined) {
        expect(line, `${name}: "${line}"`).not.toMatch(banned);
      }
    }
    // The pin is on what the user sees (statusLine). The source itself must name carriers — it compares AudioLinkState values and carries machine-readable reason tags — so no source-literal scan.
  });

  it('quality reads the bucket\'s second segment and nothing else', () => {
    expect(describePeerTile(base({ audioLink: 'webrtc', qualityBucket: 'webrtc:ok:clean:smooth' })).quality).toBe('ok');
    expect(describePeerTile(base({ audioLink: 'webrtc', qualityBucket: 'signals:poor:unknown:unknown' })).quality).toBe('poor');
    expect(describePeerTile(base({ audioLink: 'webrtc', qualityBucket: 'webrtc:bad:lossy:rough' })).quality).toBe('bad');
    expect(describePeerTile(base({ audioLink: 'webrtc', qualityBucket: 'garbage' })).quality).toBe('unknown');
  });
});

describe('decideSilenceStamps — the per-tick pacing stamps', () => {
  const none = { audioSilentSince: undefined, videoSilentSince: undefined };

  it('stamps audio silence once and keeps the first stamp', () => {
    const first = decideSilenceStamps({ audioLink: 'negotiating', peerCameraOn: undefined, videoFlowing: false, prev: none, now: NOW });
    expect(first).toEqual({ audioSilentSince: NOW, videoSilentSince: undefined });
    const second = decideSilenceStamps({ audioLink: 'down', peerCameraOn: undefined, videoFlowing: false, prev: first, now: NOW + 5_000 });
    expect(second.audioSilentSince).toBe(NOW);
  });

  it('clears audio silence on flow, on mute, on absent/blocked/unknown (Review Focus 3)', () => {
    const stamped = { audioSilentSince: NOW - 10_000, videoSilentSince: undefined };
    for (const link of ['webrtc', 'signals', 'muted', 'absent', 'blocked', 'unknown'] as const) {
      const out = decideSilenceStamps({ audioLink: link, peerCameraOn: undefined, videoFlowing: false, prev: stamped, now: NOW });
      expect(out.audioSilentSince, link).toBeUndefined();
    }
  });

  it('stamps video silence only while the peer says the camera is on (Review Focus 4)', () => {
    const off = decideSilenceStamps({ audioLink: 'webrtc', peerCameraOn: false, videoFlowing: false, prev: none, now: NOW });
    expect(off.videoSilentSince).toBeUndefined();
    const unknown = decideSilenceStamps({ audioLink: 'webrtc', peerCameraOn: undefined, videoFlowing: false, prev: none, now: NOW });
    expect(unknown.videoSilentSince).toBeUndefined();
    const on = decideSilenceStamps({ audioLink: 'webrtc', peerCameraOn: true, videoFlowing: false, prev: none, now: NOW });
    expect(on.videoSilentSince).toBe(NOW);
    const held = decideSilenceStamps({ audioLink: 'webrtc', peerCameraOn: true, videoFlowing: false, prev: on, now: NOW + 100 });
    expect(held.videoSilentSince).toBe(NOW);
    const flowing = decideSilenceStamps({ audioLink: 'webrtc', peerCameraOn: true, videoFlowing: true, prev: on, now: NOW + 200 });
    expect(flowing.videoSilentSince).toBeUndefined();
  });

  it('does not mutate prev', () => {
    const prev = { audioSilentSince: undefined, videoSilentSince: undefined };
    decideSilenceStamps({ audioLink: 'down', peerCameraOn: true, videoFlowing: false, prev, now: NOW });
    expect(prev).toEqual({ audioSilentSince: undefined, videoSilentSince: undefined });
  });
});
