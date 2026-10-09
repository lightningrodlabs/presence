# Peer tile state: the tile says what the user can hear and see

Date: 2026-09-30. Branch `feat/peer-tile-state` off `main-0.7` @ `cf7084f` (v0.16.0).

## Why

The 2026-09-30 field log (`Presence_merged_0.16.0_2026-9-30-10_06_04.json`, the
Uruguay link) showed a tile reading "establishing WebRTC carrier…" with the avatar
hidden for 26 seconds while the peer's audio was audible over signals, then
"connection lost — reconnecting…" for a link that had never connected, then
"connecting media..." flickering while video muted and unmuted. Each line was
true of the WebRTC negotiation and false of what the user could hear.

The tile's status today is keyed on the WebRTC slot (`conn` defined, `conn.connected`,
`conn.video`, `conn.videoMuted`) and on `lastDisconnectTime`, none of which is a
statement about media reaching the user. The carrier is connection-details
material. The tile has to answer three questions only: **can I hear them, can I
see them, do I wait or act.**

## Decisions

1. **One pure authority for the tile: `describePeerTile`** (`ui/src/peer-tile-policy.ts`).
   Snapshot in, tagged record out, `reason` on every arm, table-tested against the
   grid below (`ui/src/__tests__/peer-tile-policy.test.ts`). Output:

   ```ts
   type PeerTileState = {
     background: 'avatar' | 'video' | 'filmstrip';
     audio: 'live' | 'silent' | 'muted';       // meter lit / meter dark / peer muted (icon strip shows the glyph)
     statusLine: string | undefined;           // exact user copy, pinned; at most one line
     attention: 'none' | 'wait' | 'act';
     reason: string;
   };
   ```

   The view (`room-view.ts`, `_renderPeerTile`) renders exactly what it returns and
   holds no copy of the strings (the copy-singleton pin in
   `intent-diff-surfaces.test.ts` extends to this file). `StreamsStore.peerTileFor(peer)`
   gathers the inputs from the existing authorities and calls it at render time, the
   same shape as `audioLinkFor`.

   Replaces, and deletes: `describeLinkEstablishment` (`intent-diff-policy.ts`) and
   `StreamsStore.peerReconnecting`; the inline `connecting media...` literal; the
   `avatarHidden` rule's `!conn.connected` arm; the amber "signaling-held" dot and
   its tooltip; the `if (payload?.micMuted) return html``` arm of
   `_renderAudioLevelMeter`.

   _Landed._

2. **Carrier never appears on the tile.** No string produced by `describePeerTile`
   names WebRTC or signals (pinned by a negative grep in the policy test). The
   details overlay (`_showConnectionDetails`) keeps every carrier fact: phase icons,
   the carrier toggle, the stats panel, and the pong-freshness fact the amber dot
   used to carry (it moves there as a "signals: stale" marker beside the carrier
   toggle — same predicate, `!_activeAgents[peer]`, new home).

   _Landed._

3. **Flow beats everything.** Whenever `audioLinkFor(peer)` is `webrtc` or `signals`
   the status line is empty and attention is `none`, regardless of WebRTC phase,
   pong freshness, or how many establishment attempts have failed. This is the
   existing `decideAudioLink` contract carried one layer up.

   _Landed._

4. **"Connecting" and "lost" are one line.** The user knows whether they were
   hearing someone a moment ago; the action is the same. One string,
   `no audio — reconnecting…`, shown once nothing has flowed for
   `INTENT_DIFF_GRACE_MS` (2 s, reused — UI-feedback pacing, not liveness), escalating
   to `can't connect — try Reconnect` with attention `act` at `LINK_STUCK_ACT_MS`
   (30 s, new, named in `peer-tile-policy.ts`, declared NOT-liveness: it paces when
   the UI suggests a manual action; the link authorities keep their own clocks).
   The act copy names Reconnect only when the control exists: the Reconnect icon
   renders only when a media slot exists (`conversation.ts`), so the store passes
   `reconnectAvailable` (`slot !== undefined && webrtcExpected`) and without it the
   copy is `can't connect` (attention still `act`, reason `silent-act-no-control`).

   _Landed._

5. **Two local timestamps, one mechanism: `PeerRecord.audioSilentSince` and
   `PeerRecord.videoSilentSince`.** Stamped on the presence tick when the
   corresponding flow is absent and the field is unset (audio: `audioLinkFor` ∉
   {`webrtc`, `signals`}; video: no live WebRTC video and no active filmstrip),
   cleared on the tick the flow is present; both wiped by the `media-leave-residue`
   arm of `resetPeerRecord` (arm tests in `peer-record.test.ts` gain both fields in
   every arm's expected record). Never a liveness predicate — `PeerRecord`'s
   invariant holds; they pace UI copy only. `lastDisconnectTime` is not used by
   the tile: it is stamped on every close, including attempts that never
   connected, which is the "reconnecting" misreport in the log.

   _Landed._

6. **Peer mic muted: no meter, as before this round.** The module icon strip already
   renders the muted glyph (`conversation.ts`), so the tile adds none, and the level
   meter is not rendered for a muted peer — there is no level to show.

   History of this decision, kept because it was wrong twice: the first cut added a
   muted glyph in the meter's slot on the false premise that nothing else showed
   mute; the final review removed it but kept the meter mounted in every audio
   state; a field report the next day (2026-10-01) showed that meter frozen at the
   last level, because the signals peak map is never decayed and the element fell
   through to it whenever the WebRTC analyser read exactly 0. The pre-round
   behavior (meter absent when muted) is restored, and the freeze is fixed at its
   source: `decideMeterLevel` (`transport/carrier-stats-policy.ts`) reads the active
   carrier's level only and expires a signals peak after `SIGNALS_LEVEL_HOLD_MS`.

   _Landed (restored 2026-10-01)._

7. **Peer camera intent goes on the wire: `ConversationPayload.cameraOn: boolean`.**
   Additive field, same push-on-change (`_syncConversationPayload`) and pong-sweep
   path as `micMuted`; written by ONE reconciler, `StreamsStore._syncCameraOnPayload`
   (value = camera wanted AND capture live; run on the presence tick and at `videoOn`/`videoOff`,
   so a denied or failed camera never advertises `true`); `CONVERSATION_PAYLOAD_WRITES`
   gains it (`wire-contract.test.ts` snapshot and the v0.16.0 compat-corpus fixture
   updated). Parse default for a payload without the field is `undefined`
   ("unknown"), and every unknown arm of the grid shows nothing extra — the safe
   default, so a v0.16.0 peer renders exactly as today minus the misreports.

   Replaces the **send** side of the `video-on`/`video-off` RTC actions:
   `_broadcastRtcAction('video-on'|'video-off')` in `videoOn`/`videoOff` is
   deleted. Those actions travel over the data channel and so never reach a
   signals-only peer — the payload does. The **receive** arm stays as a declared
   legacy read (`KNOWN_ACTION_MESSAGES` keeps both, the `set-peer-track` video
   arm keeps writing `conn.video`, the taxonomy rows stay `emitted`), the same
   write-set/read-set split `CONVERSATION_PAYLOAD_READS` already makes for
   `muted`/`signalsOnlyWith`. It has to: `videoOff` does not remove the video
   track, it swaps in the canvas keepalive (`_ensureVideoKeepaliveTrack`), so a
   receiver sees a live video track the whole time and the action is the only
   thing that tells a v0.16.0-era receiver the track is blank.

   Show rule, in the policy: video renders iff the slot is `connected`, a live
   video track is present, and `peerCameraOn !== false`. The `connected` conjunct
   is new: today `_handleMediaRemoteStream`/`_setTrackReady` write `conn.video`
   before ICE+DTLS completes, and a track with no DTLS carries no frames — that
   `video && !connected` window is what the circle-tile oval fix
   (`fix/circle-tile-oval`, 2026-09-30) measured as its trigger. A new sender with the camera off says
   `cameraOn: false` → avatar. A v0.16.0 sender with the camera off sends
   `video-off`, which clears `conn.video` as today → avatar. `cameraOn`
   undefined with `conn.video` true (legacy sender, camera on) → video.

   Declared interop change: a v0.16.0 **receiver** of ours no longer gets
   `video-off` and will render our keepalive track as blank video while our
   camera is off. Accepted for this round (cross-version compatibility is not a
   constraint at this point, room owner 2026-09-30); retire the note when
   v0.16.0 is no longer in the field.

   Declared, not done: `audio-on`/`audio-off` are the same shape beside `micMuted`
   and their send side should go the same way. Deferred so this round's wire diff
   is one field; trigger: the next change that touches `set-peer-track`.

   _Landed._

8. **Quality shows as the meter's frame colour, never as text.** `PeerRecord.qualityBucket`'s
   RTT band (second segment; the first is the carrier): ok/good → no frame, poor → amber, bad → red;
   loss and jitter bands are not read (declared). The bucket
   authority (`_maybeEmitQualityChange`) is unchanged.

   _Landed._

9. **Own-side addition: one intent diff.** `describeIntentDiffs` gains scope
   `camera`, reason `camera-paced`, copy `video paused — slow connection`, when
   `localIntent.camera.wanted` and `signalsCadence().mode !== 'full'` and at least
   one signals target exists. Rendered as the existing camera-button badge. This is
   the one place the signals-pacing work and this UX meet; it is additive and
   reads the cadence authority, never re-derives it.

   _Landed._

10. **The backstop SDP timer misfire is out of scope** (`media-links.ts`, the
    `sdpTimeoutTimer` arm keyed on `SdpExchange` alone) — a separate bounded fix
    on its own branch. The 7 s FSM connection timeout and the cadence gate's
    reaction lag belong to the signals-pacing line, not here.

    _Out of scope by declaration._

## The grid (the table-test contract)

Attention: `none`; `wait` = amber text, auto-recovering; `act` = red text.
"silence" = `audioLinkFor` ∉ {`webrtc`, `signals`} and peer not muted.

### Group 1 — WebRTC expected

`decideWebrtcEligibility(peer).eligible` and `!webrtcDisabled(peer)`.

| # | State | background | audio | statusLine | attention |
|---|---|---|---|---|---|
| 1a | silence < 2 s | avatar | silent | — | none |
| 1b | silence ≥ 2 s, < 30 s (any WebRTC phase) | avatar | silent | no audio — reconnecting… | wait |
| 1c | silence ≥ 30 s, a media slot exists (Reconnect control rendered) | avatar | silent | can't connect — try Reconnect | act |
| 1c-no-slot | silence ≥ 30 s, no media slot (no Reconnect control) | avatar | silent | can't connect | act |
| 1d | audio via signals, no filmstrip, WebRTC in any non-connected phase | avatar | live | — | none |
| 1e | audio via signals, filmstrip active | filmstrip | live | — | none |
| 1f | WebRTC up, audio live, `cameraOn` false or unknown, no video track | avatar | live | — | none |
| 1g | WebRTC up, audio live, video track present, `videoMuted` | avatar | live | connecting video… | wait |
| 1h | WebRTC up, audio + video live | video | live | — | none |
| 1i | WebRTC up, audio live, `cameraOn` true, no video track ≥ 2 s | avatar | live | connecting video… | wait |
| 1j | peer mic muted, any phase | per video rows | muted | — (video rows' line still applies) | per video |
| 1k | WebRTC ICE-disconnected (slot still `connected`), audio stale → `down` | video | silent | as 1b/1c by silence age | wait/act |
| 1l | pongs stale/gone, media flowing | as the flow row | live | — | none |
| 1m | pongs gone, no media | tile removed by the present predicate — unchanged | | | |

### Group 2 — signals only

My carrier mode `signals`, or per-peer pinned, or the peer's `webrtcDisabled` /
`disableWebrtcWith`, or the peer lacks `sdp-fsm`, or caps not yet known.

| # | State | background | audio | statusLine | attention |
|---|---|---|---|---|---|
| 2a | silence < 2 s | avatar | silent | — | none |
| 2b | silence ≥ 2 s, < 30 s | avatar | silent | no audio — reconnecting… | wait |
| 2c | silence ≥ 30 s (Group 2 has no slot, so no Reconnect control) | avatar | silent | can't connect | act |
| 2d | voice flowing, no filmstrip, `cameraOn` false or unknown | avatar | live | — | none |
| 2e | voice flowing, filmstrip active | filmstrip | live | — | none |
| 2f | voice flowing, `cameraOn` true, no filmstrip ≥ 2 s | avatar | live | video paused — slow connection | none |
| 2g | peer mic muted | per video rows | muted | — | none |

Rows 1d and 2d are identical by construction, so the caps-unknown → known
transition is invisible. Row 2f's copy is the peer-side twin of decision 9's
own-side badge: their cadence throttled their video; nothing to act on.

### Group 3 — own side (existing surfaces, one addition)

| # | State | where | shows |
|---|---|---|---|
| 3a | my signal carrier down | room banner | unchanged |
| 3b | my mic/camera wanted, unavailable | button badges | unchanged |
| 3c | my camera wanted, cadence ≠ `full`, a signals target exists | camera badge | video paused — slow connection (decision 9) |

## Inputs to `describePeerTile`

| Input | Authority |
|---|---|
| `webrtcExpected` | `decideWebrtcEligibility` ∧ `!webrtcDisabled(peer)` |
| `audioLink` | `audioLinkFor(peer)` |
| `peerMicMuted` | `parseConversationPayload(...).micMuted` |
| `peerCameraOn: boolean \| undefined` | `parseConversationPayload(...).cameraOn` (decision 7) |
| `videoTrack: 'none' \| 'muted' \| 'live'` | `conn.video` / `conn.videoMuted` |
| `filmstripActive` | `_filmstripActivePeers` (paint-hold TTL, not liveness) |
| `audioSilentSince` | `PeerRecord.audioSilentSince` (decision 5) |
| `qualityBucket` | `PeerRecord.qualityBucket` |
| `now` | `clock.now()` |

Rows 1i/2f measure their 2 s from `videoSilentSince` (decision 5); the
"live video track" input is `conn.video && peerCameraOn !== false` per
decision 7's show rule.

## Testing and enforcement

- `peer-tile-policy.test.ts`: every grid row as a table entry, full-object
  `toEqual`; a negative grep that no `statusLine` contains `WebRTC`, `webrtc`,
  `signals`, `carrier`, `ICE`, `SDP`.
- `peer-record.test.ts`: the two new fields in every arm's expected record.
- `streams-store-wiring.test.ts`: the tick stamps and clears `audioSilentSince`;
  a backstop-style close of a never-connected attempt leaves the tile at row 1a/1b
  by silence age, never at a "lost" wording (there is none); `videoOn`/`videoOff`
  write `cameraOn` and send no RTC action.
- `intent-diff-surfaces.test.ts`: the meter absent when muted, the quality frame, and each
  status line rendered off a stubbed `peerTileFor`; the copy-singleton pin covers
  `peer-tile-policy.ts`.
- `wire-contract.test.ts` / `compat-corpus.test.ts`: `cameraOn` in the write set;
  the fixture row for this release.
- `event-taxonomy.test.ts`: unchanged (the receive arm still emits
  `PeerVideoOnSignal`/`PeerVideoOffSignal` for legacy senders).
- `intent-write-sites.test.ts`: unmodified — no new `_applyIntent` site.
- `no-ambient-clock.test.ts`: `peer-tile-policy.ts` pinned.

## Definition of done

`nix develop -c npm run verify` green; the grid is the policy test; the six
deleted mechanisms in decision 1 and the two `_broadcastRtcAction` video sends in
decision 7 have zero references; CLAUDE.md gains a "Peer-tile round facts" bullet
naming the file, the `LINK_STUCK_ACT_MS` NOT-liveness declaration, the two
`PeerRecord` fields, and the wire change with its declared interop consequence.

Met 2026-09-30 at c1902f8 (final-review fix wave).

## Declared behavior changes

- A peer audible over signals shows no status text and keeps the avatar.
- "reconnecting" wording no longer exists; "no audio — reconnecting…" is keyed on
  silence age, not on `lastDisconnectTime`.
- The amber tile dot is gone; its fact is in the details overlay.
- No change for a muted peer: the meter is absent and the icon strip shows the muted
  glyph, as before this round (decision 6's history).
- Camera intent reaches signals-only peers (new wire field); we stop sending the
  data-channel `video-on`/`video-off` actions but keep reading them. A v0.16.0
  receiver shows our keepalive as blank video while our camera is off (decision
  7's declared interop change).
