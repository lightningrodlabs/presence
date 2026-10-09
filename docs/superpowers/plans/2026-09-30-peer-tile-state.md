# Peer Tile State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The peer tile says what the user can hear and see (and whether to wait or act), decided by one pure function, with the carrier confined to the details overlay.

**Architecture:** A new pure policy `describePeerTile` (`ui/src/peer-tile-policy.ts`) turns a per-peer snapshot gathered by `StreamsStore.peerTileFor` into `{background, audio, quality, statusLine, attention}`; `room-view.ts` renders exactly that. Two `PeerRecord` timestamps stamped on the presence tick pace the copy; one additive wire field (`cameraOn` in the conversation payload) carries camera intent to every carrier, replacing the send side of the data-channel `video-on/off` actions. Six existing tile mechanisms are deleted.

**Tech Stack:** TypeScript, Lit, vitest (node + per-file jsdom), `@holochain-open-dev/stores`. All commands via `nix develop -c`.

**Spec:** `docs/superpowers/specs/2026-09-30-peer-tile-state-design.md`

## Global Constraints

- Branch `feat/peer-tile-state` off `main-0.7` (already exists with the spec commits). One intent per branch; commit after every task; no attribution trailers of any kind in commit messages (CLAUDE.md).
- Every command runs as `nix develop -c <cmd>`. The unit gate is `nix develop -c npm run verify` at the repo root; single suites run from `ui/` as `nix develop -c npx vitest run <path>`.
- No `statusLine` string may contain `WebRTC`, `webrtc`, `signals`, `carrier`, `ICE`, or `SDP` (spec decision 2) — pinned by a test in Task 1.
- Exact user copy (spec): `no audio — reconnecting…`, `can't connect — try Reconnect`, `connecting video…`, `video paused — slow connection`. Em dash U+2014, ellipsis U+2026, straight apostrophe.
- Constants: `INTENT_DIFF_GRACE_MS` (2000, reused from `intent-diff-policy.ts`); `LINK_STUCK_ACT_MS` = 30_000 (new, `peer-tile-policy.ts`, declared NOT-liveness).
- `ui/src/__tests__/intent-write-sites.test.ts` stays byte-identical (no new `_applyIntent` site). `ui/src/__tests__/event-taxonomy.test.ts` stays unchanged.
- Spec decision 7: the **receive** arm of `video-on`/`video-off` stays; only the two `_broadcastRtcAction('video-on'|'video-off')` sends go.
- `PeerRecord` existence is never a liveness predicate (`ui/src/peer-record.ts` header) — the stamps are UI pacing only.

## Review Focus

1. A peer whose conversation payload has not arrived yet (`peerCameraOn === undefined`, caps unknown) must render exactly as a signals-only peer with the camera off: avatar, no video line. Pinned in Task 1 (row `caps-unknown`).
2. A peer that mutes while a video line is showing must keep the video line and swap the meter for the glyph, never drop to a blank tile. Pinned in Task 1 (row `1j-muted-with-video-line`).
3. A muted peer that then unmutes must get the full 2 s grace before "no audio — reconnecting…", not an instant line — the audio stamp must be cleared while muted. Pinned in Task 2 (`decideSilenceStamps` clears on `muted`).
4. A peer that turns the camera on while its video stamp is stale from an earlier camera-off period must get the 2 s grace before "connecting video…" — the video stamp is set only while `peerCameraOn === true`. Pinned in Task 2.
5. A v0.16.0 sender (no `cameraOn` field) with the camera off sends `video-off`, which clears `conn.video`; the tile must show the avatar, not the keepalive as video. Pinned in Task 1 (row `legacy-sender-camera-off`) and Task 4 (receive arm untouched).

---

### Task 1: The pure tile policy

**Files:**
- Create: `ui/src/peer-tile-policy.ts`
- Create: `ui/src/__tests__/peer-tile-policy.test.ts`
- Modify: `ui/src/intent-diff-policy.ts` (export `VIDEO_PACED_COPY`; nothing else in this task)
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts:72-100` (add the new file to `PINNED_FILES`)

**Interfaces:**
- Consumes: `AudioLinkState` from `ui/src/types.ts`; `INTENT_DIFF_GRACE_MS` from `ui/src/intent-diff-policy.ts`.
- Produces (later tasks rely on these exact names):

```ts
export const LINK_STUCK_ACT_MS = 30_000;
export type PeerTileSlot = { connected: boolean; video: boolean; videoMuted?: boolean };
export type PeerTileInputs = {
  webrtcExpected: boolean;
  audioLink: AudioLinkState;
  peerMicMuted: boolean;
  peerCameraOn: boolean | undefined;
  slot: PeerTileSlot | undefined;
  filmstripLive: boolean;
  audioSilentSince: number | undefined;
  videoSilentSince: number | undefined;
  qualityBucket: string | undefined;
  now: number;
};
export type PeerTileState = {
  background: 'avatar' | 'video' | 'filmstrip';
  audio: 'live' | 'silent' | 'muted';
  quality: 'ok' | 'poor' | 'bad' | 'unknown';
  statusLine: string | undefined;
  attention: 'none' | 'wait' | 'act';
  reason: string;
};
export function describePeerTile(s: PeerTileInputs): PeerTileState;
export type SilenceStamps = { audioSilentSince: number | undefined; videoSilentSince: number | undefined };
export function decideSilenceStamps(s: { audioLink: AudioLinkState; peerCameraOn: boolean | undefined; videoFlowing: boolean; prev: SilenceStamps; now: number }): SilenceStamps;
```

- [ ] **Step 1: Export the shared copy constant from the intent-diff policy**

In `ui/src/intent-diff-policy.ts`, after the `CAMERA_COPY` constant (line ~46), add:

```ts
/** Peer-side and own-side twin copy for a camera that is on but whose
 *  frames are throttled by the signals cadence (spec decisions 9 and
 *  the grid's row 2f). Lives here, once — `peer-tile-policy.ts` imports
 *  it, so the copy-singleton pin sees exactly one holder. */
export const VIDEO_PACED_COPY = 'video paused — slow connection';
```

- [ ] **Step 2: Write the failing table test**

Create `ui/src/__tests__/peer-tile-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    // And the source file's string literals carry none of the words.
    const src = readFileSync(
      fileURLToPath(new URL('../peer-tile-policy.ts', import.meta.url)),
      'utf8',
    );
    const literals = src.match(/'[^'\n]*'|"[^"\n]*"/g) ?? [];
    for (const lit of literals) {
      expect(lit, `literal ${lit}`).not.toMatch(banned);
    }
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/peer-tile-policy.test.ts`
Expected: FAIL — `Cannot find module '../peer-tile-policy'`.

- [ ] **Step 4: Write the policy**

Create `ui/src/peer-tile-policy.ts`:

```ts
/**
 * peer-tile-policy — the ONE decision that turns a per-peer snapshot into
 * what the peer tile shows: what the user can hear, what they can see,
 * and whether to wait or act. Pure: snapshot in, tagged record out,
 * `reason` on every arm, table-pinned against the grid in
 * docs/superpowers/specs/2026-09-30-peer-tile-state-design.md
 * (`__tests__/peer-tile-policy.test.ts`).
 *
 * The carrier never appears in a status line (spec decision 2, pinned by
 * a negative grep in the test): WebRTC vs signals is connection-details
 * material. Flow beats everything (decision 3): while audio is arriving
 * the line is empty regardless of negotiation phase.
 *
 * Copy lives here and in `intent-diff-policy.ts` (`VIDEO_PACED_COPY`,
 * shared with the own-side camera badge) — `intent-diff-surfaces.test.ts`
 * pins that no render file re-embeds any of it.
 *
 * Replaces (spec decision 1): `describeLinkEstablishment` and
 * `StreamsStore.peerReconnecting`, room-view's inline
 * `connecting media...` literal, its `!conn.connected` avatar-hiding arm,
 * the amber signaling-held dot, and `_renderAudioLevelMeter`'s
 * meter-removed-when-muted arm.
 */
import type { AudioLinkState } from './types';
import { INTENT_DIFF_GRACE_MS, VIDEO_PACED_COPY } from './intent-diff-policy';

/**
 * How long nothing may flow before the tile suggests a manual Reconnect.
 * UI-feedback pacing, NOT liveness (working agreement 2): the link
 * authorities (`decideAudioLink`, the FSM, `computePresentPeers`) keep
 * their own clocks; this only decides when copy escalates from "wait"
 * to "act". Measured from `PeerRecord.audioSilentSince`, stamped on the
 * presence tick by `decideSilenceStamps`.
 */
export const LINK_STUCK_ACT_MS = 30_000;

export type PeerTileSlot = {
  connected: boolean;
  video: boolean;
  videoMuted?: boolean;
};

export type PeerTileInputs = {
  /** `decideWebrtcEligibility(...).eligible` for this peer. */
  webrtcExpected: boolean;
  /** `audioLinkFor(peer)` — the flow authority. */
  audioLink: AudioLinkState;
  /** The peer's broadcast `micMuted`. */
  peerMicMuted: boolean;
  /** The peer's broadcast `cameraOn`; undefined = payload absent or a
   *  build that predates the field (spec decision 7). */
  peerCameraOn: boolean | undefined;
  /** The `_openConnections` slot, if any. */
  slot: PeerTileSlot | undefined;
  /** Filmstrip frames within MEDIA_LIVE_WINDOW_MS (the store's read). */
  filmstripLive: boolean;
  audioSilentSince: number | undefined;
  videoSilentSince: number | undefined;
  /** `PeerRecord.qualityBucket`, e.g. `webrtc:poor:clean:smooth`. */
  qualityBucket: string | undefined;
  now: number;
};

export type PeerTileState = {
  background: 'avatar' | 'video' | 'filmstrip';
  /** live = meter lit; silent = meter dark; muted = the muted glyph. */
  audio: 'live' | 'silent' | 'muted';
  quality: 'ok' | 'poor' | 'bad' | 'unknown';
  /** Exact user copy; at most one line. */
  statusLine: string | undefined;
  attention: 'none' | 'wait' | 'act';
  reason: string;
};

const NO_AUDIO_COPY = 'no audio — reconnecting…';
const CANT_CONNECT_COPY = "can't connect — try Reconnect";
const CONNECTING_VIDEO_COPY = 'connecting video…';

function qualityOf(bucket: string | undefined): PeerTileState['quality'] {
  const seg = bucket?.split(':')[1];
  return seg === 'ok' || seg === 'poor' || seg === 'bad' ? seg : 'unknown';
}

/** A video track that can carry frames: the slot is `connected` (a track
 *  before DTLS carries nothing — the circle-tile oval fix's measured
 *  trigger), present, unmuted, and the peer has not said the camera is
 *  off (spec decision 7's show rule). */
function webrtcVideoLive(s: Pick<PeerTileInputs, 'slot' | 'peerCameraOn'>): boolean {
  return (
    !!s.slot?.connected &&
    !!s.slot.video &&
    !s.slot.videoMuted &&
    s.peerCameraOn !== false
  );
}

export function describePeerTile(s: PeerTileInputs): PeerTileState {
  const audioFlowing = s.audioLink === 'webrtc' || s.audioLink === 'signals';
  const background: PeerTileState['background'] = webrtcVideoLive(s)
    ? 'video'
    : s.filmstripLive
      ? 'filmstrip'
      : 'avatar';
  const audio: PeerTileState['audio'] = s.peerMicMuted
    ? 'muted'
    : audioFlowing
      ? 'live'
      : 'silent';
  const quality = qualityOf(s.qualityBucket);
  const out = (
    statusLine: string | undefined,
    attention: PeerTileState['attention'],
    reason: string,
  ): PeerTileState => ({ background, audio, quality, statusLine, attention, reason });

  // Audio line: only for genuine silence — not flowing, not muted, and
  // the peer is evidenced by the signals path (absent/blocked/unknown
  // are not "reconnecting" states; the tile exists only via the present
  // predicate's carrier hold in those cases, and says nothing).
  if (!audioFlowing && !s.peerMicMuted) {
    switch (s.audioLink) {
      case 'absent':
        return out(undefined, 'none', 'absent');
      case 'blocked':
        return out(undefined, 'none', 'blocked');
      case 'unknown':
        return out(undefined, 'none', 'unknown');
      case 'negotiating':
      case 'down': {
        const silentFor =
          s.audioSilentSince === undefined ? 0 : s.now - s.audioSilentSince;
        if (silentFor >= LINK_STUCK_ACT_MS) return out(CANT_CONNECT_COPY, 'act', 'silent-act');
        if (silentFor >= INTENT_DIFF_GRACE_MS) return out(NO_AUDIO_COPY, 'wait', 'silent-wait');
        return out(undefined, 'none', 'silent-under-grace');
      }
      case 'muted':
      case 'webrtc':
      case 'signals':
        // unreachable by the guard above; fall through to the video arms
        break;
      default: {
        const exhaustive: never = s.audioLink;
        void exhaustive;
      }
    }
  }

  // Video line (audio flowing or muted): a track that arrived muted, or a
  // camera the peer says is on whose frames are not arriving.
  if (
    s.slot?.connected &&
    s.slot.video &&
    s.slot.videoMuted &&
    s.peerCameraOn !== false
  ) {
    return out(CONNECTING_VIDEO_COPY, 'wait', 'video-track-muted');
  }
  if (s.peerCameraOn === true && background === 'avatar') {
    const waitingFor =
      s.videoSilentSince === undefined ? 0 : s.now - s.videoSilentSince;
    if (waitingFor >= INTENT_DIFF_GRACE_MS) {
      if (s.webrtcExpected && s.slot?.connected) {
        return out(CONNECTING_VIDEO_COPY, 'wait', 'video-waiting-webrtc');
      }
      // Frames would come over signals; their cadence throttled them.
      return out(VIDEO_PACED_COPY, 'none', 'video-paced');
    }
  }

  return out(undefined, 'none', s.peerMicMuted ? 'muted' : 'audio-flowing');
}

export type SilenceStamps = {
  audioSilentSince: number | undefined;
  videoSilentSince: number | undefined;
};

/**
 * The per-tick stamping rule for the two `PeerRecord` pacing timestamps
 * (spec decision 5). Audio: set while the link is `negotiating`/`down`,
 * cleared on flow, on mute, and on absent/blocked/unknown — so an
 * unmute gets the full grace. Video: set only while the peer says the
 * camera is on and nothing is arriving — so a camera turned on after a
 * long off period gets the full grace too. A stamp is kept, never
 * refreshed, while its condition holds.
 */
export function decideSilenceStamps(s: {
  audioLink: AudioLinkState;
  peerCameraOn: boolean | undefined;
  videoFlowing: boolean;
  prev: SilenceStamps;
  now: number;
}): SilenceStamps {
  const audioSilent = s.audioLink === 'negotiating' || s.audioLink === 'down';
  const videoWaiting = s.peerCameraOn === true && !s.videoFlowing;
  return {
    audioSilentSince: audioSilent ? (s.prev.audioSilentSince ?? s.now) : undefined,
    videoSilentSince: videoWaiting ? (s.prev.videoSilentSince ?? s.now) : undefined,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/peer-tile-policy.test.ts`
Expected: PASS, every row.

- [ ] **Step 6: Pin the file under the no-ambient-clock test**

In `ui/src/__tests__/no-ambient-clock.test.ts`, inside the `PINNED_FILES` array (after the `../camera-source.ts` entry, line ~96), add:

```ts
  // Peer-tile round: the policy takes `now` as an input and the stamps
  // come from the store's clock; no ambient time anywhere in it.
  { relPath: '../peer-tile-policy.ts', patterns: FULL_PATTERNS },
```

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/no-ambient-clock.test.ts`
Expected: PASS (the new file section passes every pattern).

- [ ] **Step 7: Commit**

```bash
git add ui/src/peer-tile-policy.ts ui/src/__tests__/peer-tile-policy.test.ts ui/src/intent-diff-policy.ts ui/src/__tests__/no-ambient-clock.test.ts
git commit -m "feat(peer-tile): describePeerTile — the one decision for what a peer tile shows

Pure policy over the spec's grid (table-pinned, full-object rows), with
decideSilenceStamps for the two per-tick pacing stamps and
LINK_STUCK_ACT_MS (declared NOT-liveness). No status line names a
carrier (negative grep). VIDEO_PACED_COPY is exported from
intent-diff-policy so the copy has one holder."
```

---

### Task 2: The two PeerRecord stamps and their reset arm

**Files:**
- Modify: `ui/src/peer-record.ts` (fields; the `media-leave-residue` arm)
- Modify: `ui/src/__tests__/peer-record.test.ts` (`fullRecord()` and the arm rows)

**Interfaces:**
- Produces: `PeerRecord.audioSilentSince?: number`, `PeerRecord.videoSilentSince?: number` — close survivors, wiped only by `media-leave-residue`.

- [ ] **Step 1: Write the failing arm tests**

In `ui/src/__tests__/peer-record.test.ts`, find `fullRecord()` (top of the file; it builds a record with every field set) and add the two new fields to it:

```ts
    audioSilentSince: 4_001,
    videoSilentSince: 4_002,
```

Then in the `media-leave-residue` row (the `it('media-leave-residue additionally wipes …')` block), add to the expected object:

```ts
      audioSilentSince: undefined, videoSilentSince: undefined,
```

Add one more test in the `describe('resetPeerRecord')` block:

```ts
  it('the tile pacing stamps survive a media close and die only on leave (spec decision 5)', () => {
    const afterClose = resetPeerRecord(fullRecord(), 'media-close-full');
    expect(afterClose.audioSilentSince).toBe(4_001);
    expect(afterClose.videoSilentSince).toBe(4_002);
    const afterStale = resetPeerRecord(afterClose, 'media-stale-residue');
    expect(afterStale.audioSilentSince).toBe(4_001);
    const afterLeave = resetPeerRecord(afterStale, 'media-leave-residue');
    expect(afterLeave.audioSilentSince).toBeUndefined();
    expect(afterLeave.videoSilentSince).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/peer-record.test.ts`
Expected: FAIL — TypeScript rejects the unknown fields in `fullRecord()` (vitest reports the type error via esbuild? No — esbuild strips types; the failure is the `media-leave-residue` row: expected `audioSilentSince: undefined`, received `4_001`).

- [ ] **Step 3: Add the fields and the arm clears**

In `ui/src/peer-record.ts`, in the `// — close survivors: reset only on peer-leave` group (after `deadTrackEscalations`), add:

```ts
  /**
   * Tile-copy pacing stamps (spec 2026-09-30 peer-tile state, decision
   * 5): when this peer's audio last stopped flowing (`audioLinkFor` in
   * negotiating/down), and when their camera was on with no frames
   * arriving. Stamped/cleared every presence tick by
   * `decideSilenceStamps` (`peer-tile-policy.ts`) through
   * `StreamsStore._stampTileSilence`. Close survivors: a reconnect
   * attempt must not reset the "how long has nothing flowed" clock —
   * that is what escalates the copy to "try Reconnect". NEVER a liveness
   * predicate; they pace user-facing copy only.
   */
  audioSilentSince?: number;
  videoSilentSince?: number;
```

In `resetPeerRecord`, the `media-leave-residue` arm, add `audioSilentSince: undefined, videoSilentSince: undefined,` to the returned object.

- [ ] **Step 4: Run to verify it passes**

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/peer-record.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/peer-record.ts ui/src/__tests__/peer-record.test.ts
git commit -m "feat(peer-record): audioSilentSince/videoSilentSince — tile pacing stamps, wiped on leave only"
```

---

### Task 3: `cameraOn` on the wire

**Files:**
- Modify: `ui/src/room/modules/conversation.ts:52-96` (`ConversationPayload`, `DEFAULT_CONVERSATION_PAYLOAD`) and the parse return at ~201-215
- Modify: `ui/src/transport/wire-contract.ts:197-205` (`CONVERSATION_PAYLOAD_WRITES`)
- Modify: `fixtures/wire-contract.json` (repo root; `conversationPayload.writes` and `.reads`)
- Test: `ui/src/transport/__tests__/wire-contract.test.ts` (existing snapshot test), `ui/src/room/modules/__tests__/conversation-payload.test.ts` (create if absent — check `ls ui/src/room/modules/__tests__/`)

**Interfaces:**
- Produces: `ConversationPayload.cameraOn: boolean | undefined` (required key, may be undefined), `DEFAULT_CONVERSATION_PAYLOAD.cameraOn === false`, `parseConversationPayload(...)?.cameraOn` is `undefined` for a payload without the field.

- [ ] **Step 1: Write the failing parse test**

If `ui/src/room/modules/__tests__/conversation-payload.test.ts` does not exist, create it; otherwise append the describe block:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseConversationPayload,
  DEFAULT_CONVERSATION_PAYLOAD,
} from '../conversation';
import type { ModuleStateEnvelope } from '../types';

function envelope(payload: Record<string, unknown>): ModuleStateEnvelope {
  return { moduleId: 'conversation', active: true, payload: JSON.stringify(payload), updatedAt: 0 };
}

describe('cameraOn on the conversation payload (peer-tile spec decision 7)', () => {
  it('the default declares the camera off', () => {
    expect(DEFAULT_CONVERSATION_PAYLOAD.cameraOn).toBe(false);
  });

  it('a payload without the field parses to undefined — unknown, never false', () => {
    const p = parseConversationPayload(envelope({ micMuted: true }));
    expect(p).not.toBeNull();
    expect(p!.cameraOn).toBeUndefined();
  });

  it('true/false round-trip; non-boolean coerces', () => {
    expect(parseConversationPayload(envelope({ cameraOn: true }))!.cameraOn).toBe(true);
    expect(parseConversationPayload(envelope({ cameraOn: false }))!.cameraOn).toBe(false);
    expect(parseConversationPayload(envelope({ cameraOn: 1 }))!.cameraOn).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `ui/`): `nix develop -c npx vitest run src/room/modules/__tests__/conversation-payload.test.ts`
Expected: FAIL — `expected undefined to be false` on the default.

- [ ] **Step 3: Add the field**

In `ui/src/room/modules/conversation.ts`, in `interface ConversationPayload` after `micMuted`:

```ts
  /**
   * True when the user's camera is on (peer-tile spec decision 7). The
   * one carrier-independent statement of camera intent — the
   * data-channel `video-on`/`video-off` actions never reached a
   * signals-only peer. `undefined` on parse means the sender predates
   * the field: the tile treats that as unknown and shows nothing extra.
   */
  cameraOn: boolean | undefined;
```

In `DEFAULT_CONVERSATION_PAYLOAD` add `cameraOn: false,` after `micMuted: true,`.

In `parseConversationPayload`'s return object add, after the `micMuted` line:

```ts
      cameraOn: raw.cameraOn === undefined ? undefined : !!raw.cameraOn,
```

- [ ] **Step 4: Run to verify it passes; then run the wire-contract snapshot to see it fail**

Run (from `ui/`): `nix develop -c npx vitest run src/room/modules/__tests__/conversation-payload.test.ts`
Expected: PASS.

Run (from `ui/`): `nix develop -c npx vitest run src/transport/__tests__/wire-contract.test.ts`
Expected: PASS still (the write list has not changed yet).

- [ ] **Step 5: Declare the write**

In `ui/src/transport/wire-contract.ts`, `CONVERSATION_PAYLOAD_WRITES`, add `'cameraOn',` after `'micMuted',`.

Run (from `ui/`): `nix develop -c npx vitest run src/transport/__tests__/wire-contract.test.ts`
Expected: FAIL — "The declared wire surface differs from fixtures/wire-contract.json".

- [ ] **Step 6: Update the fixture**

Edit `fixtures/wire-contract.json` (repo root): in `conversationPayload.writes` insert `"cameraOn"` after `"micMuted"`; in `conversationPayload.reads` insert `"cameraOn"` after `"micMuted"` (reads = writes + legacy encodings, so the order must match: writes first in declaration order).

Run (from `ui/`): `nix develop -c npx vitest run src/transport/__tests__/wire-contract.test.ts src/transport/__tests__/compat-corpus.test.ts`
Expected: PASS both. (The compat corpus checks signal-type interop from each release's default payload; an added payload field does not change it, and `fixtures/compat/0.16.0.json` is a released shape — do NOT edit it; the next release's ceremony appends its own entry.)

- [ ] **Step 7: Typecheck**

Run (from `ui/`): `nix develop -c npx tsc --noEmit`
Expected: clean. If any site constructs a `ConversationPayload` literal without `cameraOn` (grep `webrtcImpl: 'fsm'` across `ui/src` to find them), add `cameraOn: false` there.

- [ ] **Step 8: Commit**

```bash
git add ui/src/room/modules/conversation.ts ui/src/transport/wire-contract.ts fixtures/wire-contract.json ui/src/room/modules/__tests__/conversation-payload.test.ts
git commit -m "feat(wire): cameraOn on the conversation payload — camera intent for every carrier

Additive field beside micMuted; absent parses to undefined (unknown).
Declared in CONVERSATION_PAYLOAD_WRITES and the wire-contract fixture."
```

---

### Task 4: The store writes `cameraOn`, stamps silence, and answers `peerTileFor`

**Files:**
- Modify: `ui/src/streams-store.ts` — `videoOn` (~1783-1808), `videoOff` (~1896-1955), delete `peerReconnecting` (~374-383), add `peerTileFor`/`_webrtcExpectedFor`/`_stampTileSilence`, the tick site (~1088-1097)
- Test: `ui/src/__tests__/streams-store-wiring.test.ts` (new describe block at the end)

**Interfaces:**
- Consumes: Task 1's `describePeerTile`, `decideSilenceStamps`; Task 2's fields; Task 3's `cameraOn`.
- Produces: `StreamsStore.peerTileFor(peerB64: AgentPubKeyB64): PeerTileState` (public, called at render); `peerReconnecting` is gone.

- [ ] **Step 1: Write the failing wiring tests**

Append to `ui/src/__tests__/streams-store-wiring.test.ts` (before the file's final line). The helpers `makeStarted`, `knownFresh`, `message`, `flush`, `peerA`, `myPubKeyB64` are module-level in this file; `installNavigator`/`FakeTrack`/`FakeStream`/`presenceTick` are scoped inside earlier describe blocks, so this block carries its own minimal copies. Read `makeStarted` (line ~58) and the capture-reconciler block (line ~1285) once before writing, to confirm the names.

```ts
describe('peer tile (spec 2026-09-30): cameraOn on the wire, silence stamps on the tick, peerTileFor', () => {
  class FakeTrack {
    readyState: 'live' | 'ended' = 'live';
    enabled = true;
    onended: (() => void) | null = null;
    onmute: (() => void) | null = null;
    onunmute: (() => void) | null = null;
    muted = false;
    constructor(public kind: 'audio' | 'video') {}
    stop(): void { this.readyState = 'ended'; this.onended?.(); }
  }
  class FakeStream {
    constructor(private tracks: FakeTrack[]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  }
  class FakeMediaStream {
    private tracks: FakeTrack[] = [];
    addTrack(t: FakeTrack) { this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  }
  const flush = () => new Promise<void>(r => setTimeout(r, 0));

  function installCamera(track: FakeTrack) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: async () => new FakeStream([track]) } },
      configurable: true,
      writable: true,
    });
  }

  function myConversation(started: ReturnType<typeof makeStarted>): Record<string, unknown> | null {
    const env = get(started.store._myModuleStates)['conversation'];
    return env ? JSON.parse(env.payload) : null;
  }

  function peerConversation(started: ReturnType<typeof makeStarted>, peer: string, payload: Record<string, unknown>) {
    started.store._peerModuleStates.update(s => ({
      ...s,
      [peer]: {
        conversation: { moduleId: 'conversation', active: true, payload: JSON.stringify(payload), updatedAt: started.clock.now() },
      },
    }));
  }

  beforeEach(() => { (globalThis as any).MediaStream = FakeMediaStream; });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).navigator;
    delete (globalThis as any).MediaStream;
  });

  it('videoOn/videoOff write cameraOn to my conversation payload and send no video-on/off RTC action', async () => {
    installCamera(new FakeTrack('video'));
    const started = makeStarted();
    const media = started.transports.media!;
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    media.sentData.length = 0;

    await started.store.videoOn();
    await flush();
    expect(myConversation(started)?.cameraOn).toBe(true);

    started.store.videoOff();
    await flush();
    expect(myConversation(started)?.cameraOn).toBe(false);

    // The send side of the data-channel actions is gone (spec decision 7).
    // `FakeTransport.sentData` records every `send(peer, data)`.
    const actions = media.sentData.map(c => String(c.data));
    expect(actions.some(a => a.includes('video-on') || a.includes('video-off'))).toBe(false);
  });

  it('the receive arm of video-off still clears conn.video for a legacy sender (Review Focus 5)', async () => {
    const started = makeStarted();
    const media = started.transports.media!;
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    started.store._openConnections.update(c => { c[peerA] = { ...c[peerA], video: true }; return c; });
    media.emit({ type: 'data-channel-message', peer: peerA, connectionId: 'conn-1', data: encodeRtcAction('video-off') });
    expect(get(started.store._openConnections)[peerA]?.video).toBe(false);
  });

  it('the tick stamps audioSilentSince for a present, reachable, silent peer and clears it when voice flows', async () => {
    const started = makeStarted();
    started.store._knownAgents.set(knownFresh(started.clock, peerA));
    peerConversation(started, peerA, { micMuted: false, cameraOn: false, caps: ['sdp-fsm'] });
    started.clock.advance(PING_INTERVAL);
    await flush(); await flush();
    const t0 = started.store._peerRecords.get(peerA)?.audioSilentSince;
    expect(t0).toBe(started.clock.now());

    started.clock.advance(PING_INTERVAL);
    await flush(); await flush();
    expect(started.store._peerRecords.get(peerA)?.audioSilentSince).toBe(t0); // kept, not refreshed

    voiceController.peerLastRecvMs.set(peerA, started.clock.now());
    started.clock.advance(PING_INTERVAL);
    await flush(); await flush();
    expect(started.store._peerRecords.get(peerA)?.audioSilentSince).toBeUndefined();
    voiceController.peerLastRecvMs.delete(peerA);
  });

  it('peerTileFor: audio over signals while WebRTC is still signaling shows no line (the 2026-09-30 log)', async () => {
    const started = makeStarted();
    started.store._knownAgents.set(knownFresh(started.clock, peerA));
    peerConversation(started, peerA, { micMuted: false, cameraOn: false, caps: ['sdp-fsm'] });
    const media = started.transports.media!;
    media.emitPhase(peerA, 'conn-1', 'signaling');
    voiceController.peerLastRecvMs.set(peerA, started.clock.now());
    const tile = started.store.peerTileFor(peerA);
    expect(tile).toMatchObject({ background: 'avatar', audio: 'live', statusLine: undefined, attention: 'none' });
    voiceController.peerLastRecvMs.delete(peerA);
  });

  it('peerTileFor: a never-connected attempt closed by the backstop is "no audio", never a reconnect wording', async () => {
    const started = makeStarted();
    started.store._knownAgents.set(knownFresh(started.clock, peerA));
    peerConversation(started, peerA, { micMuted: false, cameraOn: false, caps: ['sdp-fsm'] });
    const media = started.transports.media!;
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'closed', 'signaling');
    // three ticks of silence past the grace
    for (let i = 0; i < 3; i++) { started.clock.advance(PING_INTERVAL); await flush(); await flush(); }
    const tile = started.store.peerTileFor(peerA);
    expect(tile.statusLine).toBe('no audio — reconnecting…');
    expect(tile.attention).toBe('wait');
    expect((started.store as any).peerReconnecting).toBeUndefined();
  });
});
```

Notes for the implementer: `FakeTransport` (`ui/src/store-deps.testing.ts`) records sends in `sentData: Array<{ peer, data }>`, and `emit(event)` takes a `TransportEvent` — the `data-channel-message` member is `{ type, peer, connectionId, data }` (`ui/src/transport/types.ts`). `PING_INTERVAL`, `voiceController`, `encodeRtcAction`, `get`, `vi`, `beforeEach`, `afterEach` are already imported at the top of the file. `_presentPeers`, `_peerModuleStates`, `_openConnections`, `_knownAgents`, `_myModuleStates`, `_peerRecords` are store members the suite already reads directly.

- [ ] **Step 2: Run to verify it fails**

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/streams-store-wiring.test.ts -t "peer tile"`
Expected: FAIL — `peerTileFor is not a function`; `cameraOn` undefined after `videoOn`.

- [ ] **Step 3: Replace the RTC video sends with the payload write**

In `ui/src/streams-store.ts`, `videoOn()`: replace

```ts
    // Send 'video-on' signal to peers
    this._broadcastRtcAction('video-on');
```

with

```ts
    // Camera intent reaches every carrier through the conversation
    // payload (peer-tile spec decision 7) — the data-channel `video-on`
    // action never reached a signals-only peer. The receive arm of that
    // action stays as a legacy read for v0.16.0 senders.
    await this._syncConversationPayload({ cameraOn: true });
```

In `videoOff()`: insert immediately after `this._applyIntent({ type: 'video-off' });` (before the `cameraHandleHeld` early return, so the intent reaches peers even when no device was held):

```ts
    // See videoOn: the payload carries camera intent; fire-and-forget
    // because this gesture is synchronous for its callers.
    void this._syncConversationPayload({ cameraOn: false }).catch(() => {});
```

and delete the line `this._broadcastRtcAction('video-off');`.

- [ ] **Step 4: Delete `peerReconnecting`, add `peerTileFor` and the tick stamp**

Delete the `peerReconnecting` method and its docblock (~lines 374-383).

Add the imports at the top of `streams-store.ts`:

```ts
import { describePeerTile, decideSilenceStamps } from './peer-tile-policy';
import type { PeerTileState } from './peer-tile-policy';
```

(`decideWebrtcEligibility` — check whether the store already imports it from `./transport/carrier-coverage`; if not, add it.)

Add, next to `audioLinkFor` (~line 2801):

```ts
  /**
   * What this peer's tile shows — the ONE decision is `describePeerTile`
   * (`peer-tile-policy.ts`); this method only gathers the snapshot from
   * the existing authorities, the same shape as `audioLinkFor`. Called
   * at render time by room-view's `_renderPeerTile`.
   */
  peerTileFor(peerB64: AgentPubKeyB64): PeerTileState {
    const peerConv = get(this._peerModuleStates)[peerB64]?.['conversation'];
    const payload = peerConv ? parseConversationPayload(peerConv) : null;
    const rec = this._peerRecords.get(peerB64);
    const now = this.clock.now();
    const lastFilmstripMs = filmstripController.peerLastRecvMs.get(peerB64);
    return describePeerTile({
      webrtcExpected: this._webrtcExpectedFor(peerB64),
      audioLink: this.audioLinkFor(peerB64),
      peerMicMuted: !!payload?.micMuted,
      peerCameraOn: payload?.cameraOn,
      slot: get(this._openConnections)[peerB64],
      filmstripLive:
        lastFilmstripMs !== undefined && now - lastFilmstripMs < MEDIA_LIVE_WINDOW_MS,
      audioSilentSince: rec?.audioSilentSince,
      videoSilentSince: rec?.videoSilentSince,
      qualityBucket: rec?.qualityBucket,
      now,
    });
  }

  /** Is a WebRTC link expected with this peer? The same predicate both
   *  handshake ends apply (`decideWebrtcEligibility`, role-symmetric). */
  private _webrtcExpectedFor(peerB64: AgentPubKeyB64): boolean {
    return decideWebrtcEligibility({
      role: 'initiator',
      conversationActive: !!get(this._myModuleStates)['conversation'],
      peerWebrtcDisabled: this.webrtcDisabled(peerB64),
      webrtcGloballyDisabled: this.webrtcGloballyDisabled,
      peerCapsKnown:
        get(this._peerModuleStates)[peerB64]?.['conversation'] !== undefined,
      peerHasSdpFsmCap: this.webrtcAvailableFor(peerB64),
    }).eligible;
  }

  /**
   * Presence-tick stamping of the two tile pacing timestamps (spec
   * decision 5). Runs beside `_recomputeIntentDiffs` so the copy paces
   * on the same tick the reconcilers act on. `_ensurePeerRecord` is a
   * write path by contract; a row for a present peer is not a liveness
   * claim (peer-record.ts header).
   */
  private _stampTileSilence(): void {
    const now = this.clock.now();
    for (const peerB64 of get(this._presentPeers)) {
      if (peerB64 === this.myPubKeyB64) continue;
      const peerConv = get(this._peerModuleStates)[peerB64]?.['conversation'];
      const payload = peerConv ? parseConversationPayload(peerConv) : null;
      const slot = get(this._openConnections)[peerB64];
      const lastFilmstripMs = filmstripController.peerLastRecvMs.get(peerB64);
      const filmstripLive =
        lastFilmstripMs !== undefined && now - lastFilmstripMs < MEDIA_LIVE_WINDOW_MS;
      const videoFlowing =
        (!!slot?.connected && !!slot.video && !slot.videoMuted && payload?.cameraOn !== false) ||
        filmstripLive;
      const rec = this._ensurePeerRecord(peerB64);
      const next = decideSilenceStamps({
        audioLink: this.audioLinkFor(peerB64),
        peerCameraOn: payload?.cameraOn,
        videoFlowing,
        prev: { audioSilentSince: rec.audioSilentSince, videoSilentSince: rec.videoSilentSince },
        now,
      });
      rec.audioSilentSince = next.audioSilentSince;
      rec.videoSilentSince = next.videoSilentSince;
    }
  }
```

In the `_signalsTargets` subscription (line ~1088-1097), after `this._recomputeIntentDiffs();` add:

```ts
      this._stampTileSilence();
```

- [ ] **Step 5: Run the new block, then the whole wiring suite**

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/streams-store-wiring.test.ts`
Expected: PASS, including every pre-existing test. If a pre-existing test asserted a `video-on`/`video-off` send, read it: it is asserting the deleted mechanism and must be rewritten to assert the payload write instead (say so in the commit message).

- [ ] **Step 6: Typecheck**

Run (from `ui/`): `nix develop -c npx tsc --noEmit`
Expected: errors ONLY in `room/room-view.ts` and `__tests__/intent-diff-surfaces.test.ts` (both reference the deleted `peerReconnecting`/`describeLinkEstablishment` — Tasks 5 and 6 fix them). Anything else is a defect in this task.

- [ ] **Step 7: Commit**

```bash
git add ui/src/streams-store.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "feat(store): peerTileFor over the tile policy; cameraOn replaces the video-on/off sends; silence stamps on the tick

peerReconnecting is deleted (it read lastDisconnectTime, stamped on
never-connected closes — the 'reconnecting' misreport in the
2026-09-30 log). The receive arm of video-on/off stays for v0.16.0
senders."
```

---

### Task 5: The own-side "video paused — slow connection" badge

**Files:**
- Modify: `ui/src/intent-diff-policy.ts` (`IntentDiffInput`, `describeIntentDiffs`; delete `describeLinkEstablishment`)
- Modify: `ui/src/streams-store.ts:359-372` (`_recomputeIntentDiffs` passes the two new inputs)
- Modify: `ui/src/__tests__/intent-diff-policy.test.ts` (helper defaults; delete the `describeLinkEstablishment` block; add the paced rows)

**Interfaces:**
- Produces: `IntentDiffInput.signalsCadenceMode: 'full' | 'voice-only' | 'paused'`, `IntentDiffInput.signalsTargetCount: number`; a diff `{ scope: 'camera', severity: 'pending', reason: 'camera-paced', copy: VIDEO_PACED_COPY }`.
- `describeLinkEstablishment` no longer exists.

- [ ] **Step 1: Update the test file — failing first**

In `ui/src/__tests__/intent-diff-policy.test.ts`:
- Remove `describeLinkEstablishment` from the import and delete the whole `describe('describeLinkEstablishment', …)` block (lines ~397-415).
- Add `VIDEO_PACED_COPY` to the import from `'../intent-diff-policy'`.
- In `input()`, add defaults `signalsCadenceMode: 'full', signalsTargetCount: 0,` before `...partial`.
- Add a describe block:

```ts
describe('camera paced by the signals cadence (peer-tile spec decision 9)', () => {
  const wanted = { ...baseIntent(), camera: { wanted: true } };

  it('camera wanted + cadence voice-only + a signals target → camera/pending/"video paused — slow connection"', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wanted, cameraLifecycle: live, signalsCadenceMode: 'voice-only', signalsTargetCount: 1 })
    );
    expect(diffs).toEqual([
      { scope: 'camera', severity: 'pending', since: NOW, reason: 'camera-paced', copy: VIDEO_PACED_COPY },
    ]);
  });

  it('paused cadence reports the same diff', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wanted, cameraLifecycle: live, signalsCadenceMode: 'paused', signalsTargetCount: 2 })
    );
    expect(diffs.map(d => d.reason)).toEqual(['camera-paced']);
  });

  it('no signals target → [] (nobody is receiving over signals)', () => {
    expect(
      describeIntentDiffs(input({ intent: wanted, cameraLifecycle: live, signalsCadenceMode: 'paused', signalsTargetCount: 0 }))
    ).toEqual([]);
  });

  it('full cadence → []', () => {
    expect(
      describeIntentDiffs(input({ intent: wanted, cameraLifecycle: live, signalsCadenceMode: 'full', signalsTargetCount: 3 }))
    ).toEqual([]);
  });

  it('camera not wanted → [] even when paced', () => {
    expect(
      describeIntentDiffs(input({ signalsCadenceMode: 'paused', signalsTargetCount: 3 }))
    ).toEqual([]);
  });

  it('a capture diff for the camera wins over the paced diff (one camera diff at a time)', () => {
    const diffs = describeIntentDiffs(
      input({ intent: wanted, cameraLifecycle: failed, cameraAttempts: 0, signalsCadenceMode: 'paused', signalsTargetCount: 1 })
    );
    expect(diffs.filter(d => d.scope === 'camera').map(d => d.reason)).toEqual(['camera-failed']);
  });
});
```

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/intent-diff-policy.test.ts`
Expected: FAIL — the paced rows return `[]`.

- [ ] **Step 2: Implement**

In `ui/src/intent-diff-policy.ts`:
- Add to `IntentDiffInput`:

```ts
  /** `StreamsStore.signalsCadence().mode` — the ONE send-cadence authority
   *  (`transport/signals-cadence-policy.ts`), read, never re-derived. */
  signalsCadenceMode: 'full' | 'voice-only' | 'paused';
  /** `get(_signalsTargets).length` — how many peers receive over signals. */
  signalsTargetCount: number;
```

- In `describeIntentDiffs`, after `if (camera) diffs.push(camera);`:

```ts
  // Own-side twin of the tile's row 2f: my camera is on, the signals
  // cadence has throttled my frames, and someone is on signals.
  if (
    !camera &&
    input.intent.camera.wanted &&
    input.signalsCadenceMode !== 'full' &&
    input.signalsTargetCount > 0
  ) {
    diffs.push({
      scope: 'camera',
      severity: 'pending',
      since: input.now,
      reason: 'camera-paced',
      copy: VIDEO_PACED_COPY,
    });
  }
```

- Delete `describeLinkEstablishment` and its docblock (the end of the file).

In `ui/src/streams-store.ts`, `_recomputeIntentDiffs`, add to the `describeIntentDiffs({...})` call:

```ts
        signalsCadenceMode: this._signalsCadence.mode,
        signalsTargetCount: get(this._signalsTargets).length,
```

- [ ] **Step 3: Run**

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/intent-diff-policy.test.ts src/__tests__/streams-store-wiring.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/intent-diff-policy.ts ui/src/streams-store.ts ui/src/__tests__/intent-diff-policy.test.ts
git commit -m "feat(intent-diff): camera-paced badge; describeLinkEstablishment deleted

The own-side twin of the tile's 'video paused — slow connection' row,
reading the cadence authority. describeLinkEstablishment is replaced by
describePeerTile (peer-tile-policy.ts)."
```

---

### Task 6: The view renders the policy

**Files:**
- Modify: `ui/src/room/room-view.ts` — `_tileEstablishmentCopy` (~990-1001, delete), `_renderAudioLevelMeter` (~3038-3056), `_renderPeerTile` (~3151-3300), the two bottom-row `<avatar-with-nickname .hideAvatar=…>` sites (~3325, ~3393), the import of `describeLinkEstablishment` (line ~119)
- Modify: `ui/src/room/elements/audio-level-meter.ts` (a reflected `quality` property with a frame colour)
- Modify: `ui/src/__tests__/intent-diff-surfaces.test.ts` (FakeStore, the tile surface tests, the copy-singleton pin)

**Interfaces:**
- Consumes: `StreamsStore.peerTileFor`, `PeerTileState`.
- Produces (render-authority methods the surface test drives): `_renderTileStatusLine(tile: PeerTileState): TemplateResult`, `_renderAudioLevelMeter(pubkeyB64: string, tile: PeerTileState): TemplateResult`.

- [ ] **Step 1: Rewrite the surface tests — failing first**

In `ui/src/__tests__/intent-diff-surfaces.test.ts`:

1. Change the imports: add `import type { PeerTileState } from '../peer-tile-policy';`.
2. In `FakeStore` replace `peerReconnecting: (p: string) => boolean;` with `peerTileFor: (p: string) => PeerTileState;`; in `makeRoomView`'s overrides replace `reconnecting?: …` with `tile?: PeerTileState;` and in the store literal replace the `peerReconnecting` line with:

```ts
    peerTileFor: () => overrides?.tile ?? TILE_QUIET,
```

and add above `makeRoomView`:

```ts
const TILE_QUIET: PeerTileState = {
  background: 'avatar', audio: 'live', quality: 'unknown',
  statusLine: undefined, attention: 'none', reason: 'audio-flowing',
};
```

3. Replace the `describe('tile establishment copy via the policy authority (surface 2)', …)` block with:

```ts
describe('the peer tile renders the policy (surface 2)', () => {
  function renderToDiv(tpl: unknown): HTMLElement {
    const host = document.createElement('div');
    render(tpl as any, host);
    return host;
  }

  it('a quiet tile has no status line', () => {
    const el = makeRoomView();
    const host = renderToDiv(el._renderTileStatusLine(TILE_QUIET));
    expect(host.textContent!.trim()).toBe('');
  });

  it('a wait line renders amber; an act line renders red, each with the policy copy verbatim', () => {
    const el = makeRoomView();
    const wait = renderToDiv(el._renderTileStatusLine({ ...TILE_QUIET, statusLine: 'no audio — reconnecting…', attention: 'wait' }));
    expect(wait.textContent!.trim()).toBe('no audio — reconnecting…');
    expect(wait.querySelector('.tile-status-wait')).toBeTruthy();
    const act = renderToDiv(el._renderTileStatusLine({ ...TILE_QUIET, statusLine: "can't connect — try Reconnect", attention: 'act' }));
    expect(act.textContent!.trim()).toBe("can't connect — try Reconnect");
    expect(act.querySelector('.tile-status-act')).toBeTruthy();
  });

  it('the meter slot shows the meter when audio is live or silent, and the muted glyph when muted', () => {
    const el = makeRoomView();
    const live = renderToDiv(el._renderAudioLevelMeter('peerA', TILE_QUIET));
    expect(live.querySelector('audio-level-meter')).toBeTruthy();
    expect(live.querySelector('sl-icon')).toBeNull();
    const silent = renderToDiv(el._renderAudioLevelMeter('peerA', { ...TILE_QUIET, audio: 'silent' }));
    expect(silent.querySelector('audio-level-meter')).toBeTruthy();
    const muted = renderToDiv(el._renderAudioLevelMeter('peerA', { ...TILE_QUIET, audio: 'muted' }));
    expect(muted.querySelector('audio-level-meter')).toBeNull();
    expect(muted.querySelector('sl-icon')).toBeTruthy();
  });

  it('the meter carries the quality bucket', () => {
    const el = makeRoomView();
    const host = renderToDiv(el._renderAudioLevelMeter('peerA', { ...TILE_QUIET, quality: 'bad' }));
    const meter = host.querySelector('audio-level-meter') as any;
    expect(meter.quality).toBe('bad');
  });
});
```

4. In the copy-singleton pin: change `policyFile` to a pair and update `renderOnly`:

```ts
  const policyFiles = files.filter(
    f => f.endsWith('intent-diff-policy.ts') || f.endsWith('peer-tile-policy.ts')
  );
  const roomViewFile = files.find(f => f.endsWith('room/room-view.ts'))!;

  // Copy that is pure render text — must exist in exactly ONE of the two
  // policy files.
  const renderOnly = [
    'no audio — reconnecting…',
    "can't connect — try Reconnect",
    'connecting video…',
    'video paused — slow connection',
    'Your connection dropped — reconnecting…',
  ];
```

and the exactly-one-file test becomes:

```ts
  it('policy files exist and are discovered', () => {
    expect(policyFiles).toHaveLength(2);
    expect(roomViewFile).toBeTruthy();
  });

  it('each render-copy string appears in exactly one production file — a policy', () => {
    for (const str of renderOnly) {
      const holders = files.filter(f => contents.get(f)!.includes(str));
      expect(holders, `"${str}" should live in exactly one file`).toHaveLength(1);
      expect(policyFiles, `"${str}" holder must be a policy file`).toContain(holders[0]);
    }
  });
```

Keep the `room-view re-embeds none of the policy copy` test as is (it iterates `allCopy`, which spreads `renderOnly`). Also add `'connecting media...'` and `'establishing WebRTC carrier…'` and `'connection lost — reconnecting…'` to a new list asserted absent from EVERY production file:

```ts
  it('the retired tile strings exist nowhere', () => {
    for (const str of ['connecting media...', 'establishing WebRTC carrier…', 'connection lost — reconnecting…', 'Signaling unstable']) {
      const holders = files.filter(f => contents.get(f)!.includes(str));
      expect(holders, `"${str}" is retired`).toEqual([]);
    }
  });
```

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/intent-diff-surfaces.test.ts`
Expected: FAIL — `_renderTileStatusLine is not a function`, retired strings still present.

- [ ] **Step 2: The meter element's quality frame**

In `ui/src/room/elements/audio-level-meter.ts`:
- Add after `agentPubKeyB64`:

```ts
  /** The tile policy's quality reading (`PeerTileState.quality`) — drawn
   *  as the meter's frame, never as text (peer-tile spec decision 8). */
  @property({ type: String, reflect: true })
  quality: 'ok' | 'poor' | 'bad' | 'unknown' = 'unknown';
```

- Add to `static styles`:

```css
    :host([quality='poor']) {
      box-shadow: 0 0 0 1px #e7a008;
      border-radius: 2px;
    }
    :host([quality='bad']) {
      box-shadow: 0 0 0 1px #c72100;
      border-radius: 2px;
    }
```

- [ ] **Step 3: The view**

In `ui/src/room/room-view.ts`:

1. Replace the import `import { describeLinkEstablishment } from '../intent-diff-policy';` with `import type { PeerTileState } from '../peer-tile-policy';`.

2. Delete `_tileEstablishmentCopy` (and its docblock).

3. Replace `_renderAudioLevelMeter` entirely:

```ts
  /**
   * The tile's audio indicator: the level meter (lit while audio flows,
   * dark while it does not) or, when the peer has muted, the muted-mic
   * glyph in the meter's slot — so "muted by them" and "no audio path"
   * never look alike (peer-tile spec decision 6). Reads only the policy's
   * answer; the muted fact came through `describePeerTile`.
   */
  private _renderAudioLevelMeter(pubkeyB64: AgentPubKeyB64, tile: PeerTileState) {
    if (tile.audio === 'muted') {
      return html`
        <sl-icon
          title=${msg('muted')}
          style="color: #c3c9eb; opacity: 0.7; height: 20px; width: 20px; margin-left: 3px; vertical-align: middle;"
          .src=${wrapPathInSvg(mdiMicrophoneOff)}
        ></sl-icon>
      `;
    }
    return html`
      <audio-level-meter style="margin-left:3px"
        .streamsStore=${this.streamsStore}
        .agentPubKeyB64=${pubkeyB64}
        .quality=${tile.quality}
      ></audio-level-meter>
    `;
  }

  /** The tile's one status line, or nothing. Copy and attention come
   *  from `describePeerTile`; this only maps attention to a class. */
  private _renderTileStatusLine(tile: PeerTileState) {
    if (!tile.statusLine) return html``;
    const cls =
      tile.attention === 'act'
        ? 'tile-status tile-status-act'
        : tile.attention === 'wait'
          ? 'tile-status tile-status-wait'
          : 'tile-status';
    return html`<div class=${cls}>${tile.statusLine}</div>`;
  }
```

4. In `_renderPeerTile`:
   - After `const conn = …` add `const tile = this.streamsStore.peerTileFor(pubkeyB64);`.
   - Replace the `avatarHidden` computation and its comment block with:

```ts
    // The avatar shows unless something covers it: WebRTC video or a
    // filmstrip clip (paint-hold from the element, plus the policy's
    // background). An establishing link no longer hides it — audio may
    // well be flowing (peer-tile spec decision 1).
    const filmstripActive = this._filmstripActivePeers.has(pubkeyB64);
    const avatarHidden = filmstripActive || tile.background !== 'avatar';
```

   - In the `${conn ? html\`<video …>\` : html\`\`}` block: the `<video>` style becomes `style="${tile.background === 'video' ? '' : 'display: none;'}"`; delete the `${(() => { … est … })()}` IIFE and the `connecting media...` div, leaving only the `<video>` inside the conditional.
   - Immediately AFTER that conditional (outside it, so a peer with no slot gets a line too), insert `${this._renderTileStatusLine(tile)}`.
   - Delete the whole "Signaling-held indicator" comment + `${!this._activeAgents.value[pubkeyB64] ? html\`<sl-tooltip …>\` : html\`\`}` block.
   - In the `_showConnectionDetails` block's first row (beside `_renderCarrierToggle`), add the same fact where it belongs:

```ts
              ${!this._activeAgents.value[pubkeyB64]
                ? html`<sl-tooltip hoist class="tooltip-filled" placement="top"
                    content="signals: stale — this peer is held present on live media">
                    <div style="width: 10px; height: 10px; border-radius: 50%; background: #e7a008; opacity: 0.85;"></div>
                  </sl-tooltip>`
                : html``}
```

   - Both `<avatar-with-nickname .size=${36} .hideAvatar=${!conn?.video} …>` sites (circle and square bottom rows) become `.hideAvatar=${tile.background !== 'video'}`.
   - Both `${this._renderAudioLevelMeter(pubkeyB64)}` call sites become `${this._renderAudioLevelMeter(pubkeyB64, tile)}`.

5. Add to `static styles` (near `.tile-meta`):

```css
      .tile-status {
        color: #b9a884;
        font-size: 0.8em;
        text-align: center;
      }
      .tile-status-wait {
        color: #e7a008;
      }
      .tile-status-act {
        color: #e07070;
      }
```

- [ ] **Step 4: Run the surface tests, then typecheck**

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/intent-diff-surfaces.test.ts`
Expected: PASS.

Run (from `ui/`): `nix develop -c npx tsc --noEmit`
Expected: clean. (`mdiMicrophoneOff` and `msg` are already imported in room-view.)

- [ ] **Step 5: Run the view pins that touch this template**

Run (from `ui/`): `nix develop -c npx vitest run src/__tests__/view-teardown-symmetry.test.ts src/__tests__/video-el-paint-order.test.ts src/__tests__/screen-share-maximize-key.test.ts`
Expected: PASS. `video-el-paint-order.test.ts` source-pins `.video-el { position: relative }` — untouched.

- [ ] **Step 6: Commit**

```bash
git add ui/src/room/room-view.ts ui/src/room/elements/audio-level-meter.ts ui/src/__tests__/intent-diff-surfaces.test.ts
git commit -m "feat(room-view): the peer tile renders describePeerTile

Deleted: the carrier-named establishment copy, the 'connecting media...'
literal, the !conn.connected avatar-hiding arm, the amber signaling-held
dot (its fact moves to the details overlay), and the meter removed when
muted (a muted glyph takes the slot). The meter's frame carries the
quality bucket."
```

---

### Task 7: Gate, spec markers, CLAUDE.md, oval-fix residual

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-peer-tile-state-design.md` (landed markers per decision)
- Modify: `CLAUDE.md` ("True today": one new bullet)

- [ ] **Step 1: The full gate**

Run (repo root): `nix develop -c npm run verify`
Expected: all three workspaces' suites pass, three typechecks clean, drift check clean. Paste the tail into the commit message of Step 4.

- [ ] **Step 2: Zero-reference check on the deleted mechanisms**

Run (repo root):
```bash
grep -rn "describeLinkEstablishment\|peerReconnecting\|_tileEstablishmentCopy\|connecting media\.\.\.\|Signaling unstable\|_broadcastRtcAction('video-" ui/src
```
Expected: no output. Any hit is unfinished work from Tasks 4–6.

- [ ] **Step 3: Spec markers**

In the spec, under each numbered decision, add one line `_Landed._` (decisions 1–9) or `_Out of scope by declaration._` (decision 10). Under "Definition of done" add `Met 2026-<date> at <commit>.`

- [ ] **Step 4: CLAUDE.md bullet**

Add to CLAUDE.md's "True today" list, after the "Circle-tile oval fix" bullet:

```markdown
- **Peer-tile round facts** (landed 2026-<date> on branch `feat/peer-tile-state` off `main-0.7`; root-caused from the 2026-09-30 `Presence_merged_0.16.0` field log, where a tile read "establishing WebRTC carrier…" for 26 s of audible signals audio and "connection lost — reconnecting…" for a link that had never connected; design in `docs/superpowers/specs/2026-09-30-peer-tile-state-design.md`, plan in `docs/superpowers/plans/2026-09-30-peer-tile-state.md`). What a peer tile shows has ONE authority: `describePeerTile` (`ui/src/peer-tile-policy.ts`, table-pinned against the spec's grid in `ui/src/__tests__/peer-tile-policy.test.ts`, in `no-ambient-clock.test.ts`'s `PINNED_FILES`), gathered by `StreamsStore.peerTileFor` and rendered by room-view's `_renderPeerTile`/`_renderTileStatusLine`/`_renderAudioLevelMeter`; no status line names a carrier (negative grep in the policy test) — the carrier lives in the details overlay, where the former amber signaling-held dot's fact (`!_activeAgents[peer]`) now renders. Copy paces on two `PeerRecord` close-survivor stamps, `audioSilentSince`/`videoSilentSince` (stamped per presence tick by `decideSilenceStamps` via `_stampTileSilence`, wiped by the `media-leave-residue` arm), with `INTENT_DIFF_GRACE_MS` for "no audio — reconnecting…" and `LINK_STUCK_ACT_MS` (30 s, declared NOT-liveness — it paces when copy suggests Reconnect) for "can't connect — try Reconnect". Deleted: `describeLinkEstablishment`, `StreamsStore.peerReconnecting` (read `lastDisconnectTime`, stamped on never-connected closes), room-view's `connecting media...` literal, its `!conn.connected` avatar-hiding arm, the tile dot, and the meter-removed-when-muted arm (a muted glyph takes the slot; the meter's frame carries `qualityBucket`). Wire: `ConversationPayload.cameraOn` (additive, in `CONVERSATION_PAYLOAD_WRITES` and `fixtures/wire-contract.json`; absent parses to `undefined` = unknown) replaces the SEND side of the data-channel `video-on`/`video-off` actions, which never reached a signals-only peer; the receive arm stays as a legacy read. Declared interop change: a v0.16.0 receiver no longer gets `video-off` and renders our canvas keepalive as blank video while our camera is off. Video renders only when the slot is `connected` (a track before DTLS carries no frames — the circle-tile oval fix's measured trigger), so that fix's recorded residual (the `<video>` shrinking in the `video && !connected` window) no longer has a render. Own side: `describeIntentDiffs` gained the `camera-paced` diff (`VIDEO_PACED_COPY`, camera wanted + `signalsCadence().mode !== 'full'` + a signals target).
```

Fill in the date and use the branch's final commit for any hash. If the harness that runs this plan cannot edit `CLAUDE.md` (a permission classifier declined such an edit in the session that wrote this plan), stop and hand the bullet text to the room owner instead of working around it.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-30-peer-tile-state-design.md CLAUDE.md
git commit -m "docs: peer-tile round doc-sync — spec markers and the CLAUDE.md facts bullet"
```

- [ ] **Step 6: Field check (owner-run, recorded not gated)**

From the branch, `nix develop -c npm run applet-dev`, two agents, circle view: (a) join with the other agent on signals-only — the tile shows avatar + live meter and no text; (b) mute the other agent — the glyph replaces the meter; (c) press Reconnect — no "reconnecting" wording appears while audio is audible; (d) camera on the other side — "connecting video…" at most briefly, then video. Record the outcome in the merge message.
