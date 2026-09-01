# Field-Incident Fixes Implementation Plan (2026-09-01)

**Status: PROPOSED**, except where noted per-task below. Diagnosis complete and evidence-cited. Tasks 1, 2, 8, 9 and Task 6's UI half were absorbed or superseded by the companion `docs/superpowers/plans/2026-09-01-intent-reconciliation.md` round (landed 2026-09-01 on `docs/2026-09-01-intent-reconciliation`) before this plan's own tasks were started — see the per-task notes below. Tasks 3, 4, 5, 7 and Task 6's behavior half remain proposed and independent of that round. Do not update `CLAUDE.md` fact bullets from this document until this plan's own closing doc-sync task (Task 10) runs for whatever remains in it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the defects behind three separate field failures observed in one morning on Presence 0.15.4 (2026-09-01): a present peer that renders no tile, a local capture track that dies with no recovery path, and reconnect churn during a peer's own network outage. Two of the three were total-loss failures for the affected user that only a full room quit/rejoin cleared.

**Architecture:** Three of the fixes are pure-decision changes in existing policy modules (`track-health-policy`, `peer-link-policy`) per repo convention. Two are lifecycle guards in owner objects (`MicSource`, `room-view`'s `_maximizedVideo`). One promotes an existing, already-tracked signal (`_signalCarrierDownSince`) from cadence control to reconnect gating. No wire-surface change in any task.

**Tech Stack:** TypeScript, vitest (node env; wiring suite + fakes in `store-deps.testing.ts`; per-file jsdom for view tests), Playwright nightly harness, npm workspaces.

---

## Context: the three incidents (read before executing)

Source data: four merged diagnostic exports in `~/Downloads`, `Presence_merged_0.15.4_2026-9-1-{8_55_49, 8_58_21, 10_13_40, 10_14_38, 10_14_56}.json`. `DIAGNOSTIC_WINDOW_MS` is 900 s (`logging.ts:89`) but the logger keeps only the **current session**, so a snapshot whose earliest entry for a node is recent proves that node restarted its session, not that the window truncated.

Participants across the captures:

| log id | endpoint evidence | label |
|---|---|---|
| `uhCAk1VOF…` | srflx 216.227.63.114, Tailscale 100.110.241.111, Cloudflare TURN | Eric (log collector) |
| `uhCAkNvmu…` | srflx 37.67.189.33 (Orange FR) | France |
| `uhCAkEk5c…` | srflx 95.214.231.108, `2a02:6b6f…` | London |
| `uhCAkSPd2…` | srflx 148.227.105.51, `2803:9810…` (Antel UY) | Uruguay |

### Incident A — France: peer present, connected, no tile (08:55–08:58)

Uruguay joined at 08:55:09. France's store had them present from 08:55:11.6 (`PresenceAdd reason=ping-fresh`, no `PresenceRemove` in the capture), WebRTC connected at 08:55:17.4, and Uruguay's **video track arrived at 08:55:20.3** (`PeerVideoOnSignal` → `RemoteTrack` → `TrackUnmuted`). Link quality was stable (`webrtc:poor:clean:smooth rtt=309ms loss=0%`). Eric's node took the byte-identical path at 08:55:20.4 with no problem.

France nonetheless saw no panel for Uruguay, while hearing them, until France left and rejoined at 08:57:58 (`User-Initiated Abort, reason=Close called` + `PeerLeave` observed by both other nodes; France's logger starts a new session at that instant).

Store and transport were both correct, so the failure is view-layer. See **D1**.

France also dropped Uruguay's first `InitRequest` at 08:55:09.827 — see **D2**.

### Incident B — Uruguay: local mic track ended, nobody could hear them (10:00–10:04)

Uruguay enabled audio at 10:00:17.9. Audio flowed ~5 s, then the capture track died. From 10:00:26 to 10:01:19, London's dead-track detector and Uruguay's refresh handler ran a closed loop 14 times:

```
10:00:26.301 LON  Dead track [>uru]: audio=2 video=0 cycles stale
10:00:27.843 URU  request-track-refresh received from [>lon]
10:00:27.843 URU  Track refresh [>lon]: audio=enabled,unmuted,ended  video=none
10:00:27.843 URU  replaceTrack [>lon]: refreshed via transport
10:00:27.843 URU  Manual track refresh [>lon]: replaceTrack
```

Uruguay's mute toggle at 10:00:46/48 did not help — the log shows `audio=disabled,unmuted,ended` → `audio=enabled,unmuted,ended`. Four per-peer WebRTC reconnects (10:01:21, 10:01:58, 10:02:10, 10:03:28) and a `MyWebrtcDisable global` at 10:02:10 also did not help. **Neither London nor Eric logged a single `VoiceSessionAdopt` or `VoicePlayoutReset` for Uruguay in the whole 4.5-minute capture** — no audio on the signals carrier either, ever. Uruguay adopted both of theirs; nothing came back.

Fixed only by `Disconnect reason=quitRoom-button` at 10:04:30 → `MyAudioOn` 10:04:39 → `LON PeerAudioOnSignal` 10:04:39.9.

See **D3** (no recovery path), **D4** (detector goes blind after the first reconnect), **D5** (the UI reported it as audible anyway), **D6** (the outage detector was blind for the first two minutes because only two people were in the room).

### Incident C — Uruguay: link outage, then reconnect churn (10:12–10:14)

Precursor: RTT to Uruguay doubles on both peers (`webrtc:bad rtt=609ms` / `rtt=561ms` at 10:12:42–44). Then everything to Uruguay dies inside 3 s, across **different address families and candidate types**:

```
10:12:47.549 ERIC ICE failed pair [>uru]: local=216.227.63.114:34012 (srflx) remote=148.227.105.51:64164 (srflx)
10:12:50.315 LON  ICE failed pair [>uru]: local=[2a02:6b6f…]:52510 (host)  remote=[2803:9810…]:57842 (host)
10:12:48.492 URU  SignalCarrierDown: no pong from any of 9 known peer(s)
```

**Only Uruguay logged `SignalCarrierDown`.** Eric successfully fetched London's diagnostics at 10:12:58 mid-outage, and the Eric↔London link logged nothing at all across the window — no quality change, no ICE event, no dead track. Uruguay's outage: down 10:12:48.5–10:13:06.5 (18 s), up 8 s, down 10:13:14.5–10:14:16.5 (62 s). On recovery the signal RTTs were 15–23 s.

**The drop itself is not an app defect** — it is Uruguay's local link. The recovery behaviour is: see **D7** (Uruguay fired three full reconnects into a relay it had itself declared dead, producing the stale-candidate storm London logged at 10:14:18) and **D8** (manual reconnect tearing down in-flight recovery: London's `disconnectFromPeerVideo` at 10:13:41.242 killed Uruguay's session 4 at 10:13:42.833, 1.1 s into ICE checking). Full recovery at 10:14:28, `webrtc:ok rtt=184ms loss=0%`. Total dead time ~100 s.

---

## Defect inventory

Each defect states its confidence. **Proven** = the log line or the code path is decisive on its own. **Inferred** = the mechanism is proven in code and matches the symptom, but the specific instance is not directly evidenced.

### D1 — `_maximizedVideo` hides every other tile and is never checked for reachability
**Confidence: mechanism proven, instance inferred.** View state is not logged, so the specific France instance cannot be confirmed from the exports. It is, however, the only mechanism in the render path that yields *zero* panel for a peer the store holds present.

Tiles come from `_visiblePeers()` → `_presentPeers` ([`room-view.ts:719`](../../../ui/src/room/room-view.ts#L719)), rendered by the `repeat()` at `room-view.ts:3105`. Every present peer gets a container classed by `idToLayout` ([`room-view.ts:899`](../../../ui/src/room/room-view.ts#L899)):

```ts
if (id === this._maximizedVideo) return 'maximized';
if (this._maximizedVideo) return 'hidden';        // .hidden { display: none }
```

`display: none` keeps the `<video>` in the DOM, so **WebRTC audio keeps playing while nothing is visible** — the exact "could hear, saw nothing, not even a panel" shape. Signals-carried voice runs through the AudioContext and is DOM-independent regardless.

`_maximizedVideo` is `@state()` with no persistence (so a reload clears it) and is cleared on only three events: `my-screen-share-off` (`room-view.ts:483`), `peer-leave` for that exact pubkey (`room-view.ts:508`), `peer-screen-share-disconnected` for that share key (`room-view.ts:547`). **It is not cleared when the maximized peer drops out of `_presentPeers`** — their tile leaves the `repeat()`, the key survives, every other tile stays `hidden`, and the room is blank. Round 3 item 4a fixed one instance of this family (own screen share) with `screen-share-maximize-key.test.ts`; the presence-drop case has no clear arm and no test (the suite's four cases are own-share-off, peer-share-disconnect, an unrelated-tile negative control, and the key-constructor identity).

The benign variant produces the same symptom: France had someone maximized (a double-click on any tile does it, `room-view.ts:3142`), which looks normal in a two-person room and silently swallows the third person when they arrive.

### D2 — the capability race drops the first `InitRequest` of every join
**Confidence: proven.**

```
08:55:09.827 Nvm [uhCAkSPd] InitRequest
08:55:09.827 Nvm Dropped video InitRequest from uhCAkSPd: peer lacks sdp-fsm capability
```

[`streams-store.ts:6528`](../../../ui/src/streams-store.ts#L6528). 700 ms after Uruguay joined, France had not yet received their conversation payload, so `webrtcAvailableFor()` reported no caps and `decideWebrtcEligibility` returned `peer-lacks-sdp-fsm-cap`. The drop is correct policy against a genuinely old peer and wrong against a peer whose payload is merely in flight. Cost: a fixed `INIT_RETRY_THRESHOLD` (5 s) + retry on every join, with no re-drive if the retry also races.

### D3 — a local capture track can end, and nothing re-acquires it
**Confidence: proven.**

- `MicSource.acquire()` re-opens only when `!this._track` ([`mic-source.ts:140`](../../../ui/src/mic-source.ts#L140)), and `_ensureOpen()` short-circuits on `if (this._track) return true;` ([`mic-source.ts:280`](../../../ui/src/mic-source.ts#L280)). **An `ended` track is still non-null**, so both hand back the dead track forever.
- `StreamsStore.audioOn()` acquires only on `!this._webrtcMicHandle` (`streams-store.ts:3103`), so the mute toggle never re-acquires — it only flips `track.enabled` via `MicSource.setMuted`.
- There is **no `onended` handler anywhere in `ui/src`** (grep for `onended` / `addEventListener('ended'` returns zero hits). The only `readyState === 'ended'` test in the repo is in `packages/webrtc-peer/src/peer-connection-fsm.ts:1004`, unrelated to local capture.
- `refreshTracksForPeer` ([`streams-store.ts:5109`](../../../ui/src/streams-store.ts#L5109)) reads `mainStream.getAudioTracks()[0]`, **logs its `readyState`**, then passes that same track to `refreshMediaForPeer`. It returns `true`, so it logs `refreshed via transport` and the heavier `_cloneStreamRecovery` reconnect fallback never fires either. The one function that observes the fault reports success.

Net: once the OS or another app takes the capture device, the only escape is a full room quit (which releases the last consumer, closes the device, and forces `getUserMedia` on rejoin). `CameraSource` (`ui/src/camera-source.ts`) has the same shape and should be fixed symmetrically.

### D4 — the dead-track detector is disarmed on never-started media
**Confidence: proven.**

[`track-health-policy.ts:171`](../../../ui/src/transport/track-health-policy.ts#L171):

```ts
if (input.audioExpected && input.audioBytes > 0) {   // ← only arms once bytes have arrived
  if (input.audioBytes === input.lastBytes.audio) nextStale.audio++;
```

The docblock's rationale ("a track that never started is the establishment path's problem, not a dead track") holds for the establishment window and fails for everything after it. Incident B is the proof: session 1 had real bytes that froze, so the detector fired 14 times; every connection created after the 10:01:26 reconnect had `audioBytes === 0` for its whole life, the counter never advanced, and **the detector never fired again** across the following 3 minutes of total silence.

### D5 — `decideAudioLink` reports a zero-byte connection as audible
**Confidence: proven.**

[`peer-link-policy.ts:87`](../../../ui/src/peer-link-policy.ts#L87):

```ts
const webrtcAudioLive = !!s.slot?.connected && !!s.slot?.audio &&
                        s.audioStaleCycles < STALE_CYCLES_REFRESH_THRESHOLD;
if (webrtcAudioLive) return 'webrtc';
```

`audioStaleCycles` is D4's counter. A connection that has never delivered a single audio byte reads `0` and therefore returns `'webrtc'` — the "heard by" arm. Field consequence, with nothing actually recovered:

```
10:02:52.302 LON [>uru] AudibilityOutageEnd 41s; recovered via webrtc
```

D4 and D5 share one root: `bytes > 0` as the arming condition conflates *never started* with *healthy*. It costs the detector and the honesty of the UI roll-up simultaneously.

### D6 — the audibility-outage detector requires a third peer
**Confidence: proven.**

`_checkAudibilityOutages` ([`streams-store.ts:5647`](../../../ui/src/streams-store.ts#L5647)) computes `relayVia` from `_othersConnectionStatuses` and `continue`s when no third peer reports hearing the target. London and Uruguay were alone until 10:02:34, so the first two minutes of Incident B produced no `AudibilityOutage*` event at all. It fired 8 s after Eric joined (`relay-via=uhCAk1VO`). The detector needs three people, which is the case where someone would have said something anyway.

### D7 — reconnect escalation ignores our own known-dead signal carrier
**Confidence: proven.**

`_signalCarrierDownSince` already exists, is behavior-bearing, and feeds `decideSignalsMediaCadence` and `computePresentPeers`' carrier hold. It does **not** gate reconnect escalation. Uruguay logged `SignalCarrierDown` at 10:13:14.497 and then escalated full reconnects at 10:13:25.8 (session 2), 10:13:28.6 (session 3) and 10:13:41.35 (session 4) — three renegotiations fired into a relay it had itself declared dead 11 s earlier. Every queued candidate from those sessions arrived at once on recovery; London logged 11 × `Dropped stale candidate: remote session N < current 4` at 10:14:18. The webrtc-peer 0.5.0 session-scoping fix discarded all of them correctly, so this is churn rather than a wedge — but it is avoidable churn that burns session numbers and floods the relay exactly as it recovers.

### D8 — the manual reconnect button tears down in-flight recovery
**Confidence: timings proven; counterfactual unknown.**

```
10:13:41.242 LON  reconnecting->closed trigger="disconnectFromPeerVideo" peerSession=3
10:13:41.577 URU  reconnecting->signaling trigger="fresh peer for new remote connection 2eae7579"
10:13:41.691 URU  ICE [>lon]: checking connId=1cd515cb
10:13:42.833 URU  connecting->closed trigger="remote peer left" peerSession=4
```

Uruguay's session 4 was 1.1 s into ICE checking when London's teardown arrived. Eric did the same to his own attempt at 10:13:31.292. Whether either attempt would have completed is unknowable — Uruguay's relay was still down — so do not claim the button caused the outage. The pattern is still wrong: pressing reconnect on an FSM already in `reconnecting`/`connecting` restarts the clock instead of helping, and the UI gives the user no indication that recovery is already under way, which is why they press it.

### D9 — no UI surface for `SignalCarrierDown`
**Confidence: gap, not a bug.** Uruguay was offline for 88 s and the room's only clue was tiles going stale. The node that is offline is the one that knows (`_signalCarrierDownSince` is local), and it tells nobody, including its own user.

### Diagnostic gap: view state is invisible
Incident A cannot be confirmed from the exports because `_maximizedVideo` transitions are not logged. Task 4 includes the instrumentation so the next occurrence is one grep.

---

## Global Constraints

- Target branch: `main-0.6` (the shipping line); `main-0.7` picks the fixes up by merge.
- One intent per branch (working agreement 6); merge `--no-ff`; each branch gets an adversarial review by a session that did not write it (working agreement 9).
- Decisions are pure functions: snapshot in, tagged union out, carrying a `reason` (`ui/src/transport/media-event-policy.ts` is the template). No mocks in policy tests; table-driven.
- No new threshold without a named predicate, and every new constant states which predicate/clock it serves (working agreement 2).
- Replace or declare (working agreement 1): every task below either replaces a named mechanism or states explicitly that it adds one.
- All timing in the store goes through `this.clock`; policy functions take `now` as input (the `no-ambient-clock.test.ts` pin covers the enumerated file list — check it before touching a pinned file).
- Every important mock needs a negative control — a test that fails if the mock cannot reproduce the bug the mock exists to catch.
- Gate: `nix develop -c npm run verify` green before every commit claim.
- Commit messages: no Claude co-authored footer. A fix names the symptom's previous fixes ("supersedes `<hash>`", working agreement 8) — Task 4 supersedes the Round 3 item-4a fix.
- `CLAUDE.md` "True today" bullets are updated only in the closing doc-sync task, per the drift-gate contract (`claude-md-drift.test.ts` rejects test-count and similar derivable claims).

**Recommended order:** Tasks 1–3 first (Incident B is a total-loss failure with the cheapest fixes), then 4, then 5–6, then 7–9. **Superseded as of 2026-09-01: Tasks 1, 2, 8, 9 and Task 6's UI half — see the per-task notes.** Remaining recommended order among what's left: Task 3, then Task 6's behavior half, then 4, 5, 7.

---

### Task 1: `MicSource`/`CameraSource` — recover an ended capture track

**Status: ABSORBED — do not implement as written.** Superseded by `docs/superpowers/plans/2026-09-01-intent-reconciliation.md` Tasks 2–3 (landed 2026-09-01, merges `2620e80` and `102ed1c`): the `CaptureLifecycle` union (`idle|acquiring|live|ended|failed`, `ui/src/mic-source.ts`/`ui/src/camera-source.ts`) plus the `CaptureReconciler` owner object (`ui/src/capture-reconciler.ts`) replace the `onended`-plus-predicate design sketched below. The `readyState === 'live'` predicate and its negative control (a fake track that can transition to `ended`) survive verbatim in the landed code. The `CAPTURE_REOPEN_MIN_INTERVAL_MS` pacing constant named here was carried into `ui/src/capture-reconcile-policy.ts` alongside `CAPTURE_REOPEN_MAX_ATTEMPTS`.

**Branch:** `fix/capture-track-ended-recovery`

**Files:**
- Modify: `ui/src/mic-source.ts` (`acquire` ~:133, `_ensureOpen` ~:279, `changeDevice` ~:190 for the reopen/fanout shape)
- Modify: `ui/src/camera-source.ts` (symmetric)
- Test: `ui/src/__tests__/` — new `capture-source-recovery.test.ts`
- Test: `ui/src/__tests__/streams-store-wiring.test.ts` (fanout reaches the transport)

**Design:** `_track` is only usable while `readyState === 'live'`. Three changes:

1. `_ensureOpen()` treats a non-live `_track` as closed: `if (this._track && this._track.readyState === 'live') return true;` — and clears the stale reference before re-opening so `_rawStream` is stopped, not leaked.
2. `acquire()` uses the same predicate rather than `!this._track`.
3. New `private _watchTrack(track)` attaches `track.onended` and calls a new `reopen()` that reuses `changeDevice`'s body: `getUserMedia` with the current device id, swap `_track`/`_rawStream`, `bindings.onTrackChange(newTrack, old)` **first** (store-level `replaceTrack` fanout to every peer and `mainStream`), then per-consumer `onTrackChanged`. Attach the watch in `_ensureOpen`, `changeDevice` and `reopen`.

Declared: this **replaces** the "quit the room and rejoin" recovery path — it does not run alongside it. Re-open failure (device genuinely gone) must emit a store `error` event so the user is told, rather than looping.

Reopen must be rate-limited (a device that ends immediately on open must not spin). Name the constant and its predicate: `CAPTURE_REOPEN_MIN_INTERVAL_MS`, capture-device retry pacing, NOT liveness.

- [ ] **Step 1: Write the failing tests** — a fake `getUserMedia` returning a controllable track. (a) track ends → `onTrackChange(new, old)` fires with a live track; (b) `acquire()` after an end returns a live track, not the ended one; (c) `audioOn` → end → `audioOn` again yields a live track; (d) reopen failure emits `error` and does not spin. **Negative control:** a test that fails if the fake track cannot transition to `ended` — otherwise the whole suite is vacuous (this is the `MockRTCPeerConnection`-cannot-throw lesson).
- [ ] **Step 2: Implement 1–3 above in `mic-source.ts`.**
- [ ] **Step 3: Mirror in `camera-source.ts`.** If the shapes are close enough to share, extract; if not, state why in the commit message rather than leaving two silent copies.
- [ ] **Step 4: Wiring test** — the reopen's `replaceTrack` fanout reaches `mediaTransport` for every open connection.
- [ ] **Step 5: Mutation-verify** — invert the `readyState === 'live'` check and confirm the suite goes red.
- [ ] **Step 6:** `nix develop -c npm run verify`; commit.

### Task 2: `refreshTracksForPeer` must refuse a dead track

**Status: ABSORBED — do not implement as written.** Superseded by `docs/superpowers/plans/2026-09-01-intent-reconciliation.md` Task 3 Step 7 (landed 2026-09-01, merge `102ed1c`): `refreshTracksForPeer` now defers to the capture reconciler when the source lifecycle is not `live`, logging a distinct "source dead, deferring to capture reconciler" line instead of a false `replaceTrack` success.

**Branch:** `fix/track-refresh-refuses-ended-track`

**Files:**
- Modify: `ui/src/streams-store.ts` (`refreshTracksForPeer` ~:5109, `_tryReplaceTrackRecovery` ~:5063)
- Test: `ui/src/__tests__/streams-store-wiring.test.ts`

**Design:** Depends on Task 1. When `myAudioTrack`/`myVideoTrack` is non-live, do not call `refreshMediaForPeer` and do not report success. Ask the source to reopen (Task 1's `reopen()`), log the outcome distinctly (`Track refresh [x]: source dead, reopening`), and let the reopen's own fanout do the replace. The success/failure log line must reflect what happened — the current `Manual track refresh: replaceTrack` on a dead track is the specific line that made this invisible for a full minute in the field.

- [ ] **Step 1: Failing test** — dead source track + inbound `request-track-refresh` → no `refreshMediaForPeer` call, a reopen request, and a log line that is not `replaceTrack`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Mutation-verify** the guard.
- [ ] **Step 4:** verify; commit.

### Task 3: "never started" is a distinct verdict from "flowing"

**Branch:** `fix/never-started-media-verdict`

**Files:**
- Modify: `ui/src/transport/track-health-policy.ts` (`decideTrackRefresh` ~:171, `TrackRefreshInputs`/`TrackRefreshDecision`)
- Modify: `ui/src/peer-link-policy.ts` (`decideAudioLink` ~:78)
- Modify: `ui/src/streams-store.ts` (`_checkTrackHealth` ~:5717 — pass the new input, act on the new arm)
- Test: `ui/src/transport/__tests__/track-health-policy.test.ts`, `ui/src/__tests__/peer-link-policy.test.ts`

**Design:** Closes D4 and D5 together, because they read the same counter.

Split the counter into two named quantities carried on the decision:
- `staleCycles` — frozen after flowing (today's meaning, `bytes > 0` arming preserved).
- `neverStartedCycles` — `expected && bytes === 0`, advanced whenever the slot is `connected` and past a named establishment grace so the establishment path keeps its window. Name it: `MEDIA_START_GRACE_CYCLES`, serving the media-flowing predicate, on the existing 2 s track-health poll.

`decideTrackRefresh` gains a `'request-refresh'` reason `'never-started'` alongside `'stale-cycles-exceeded'` — same action, different reason, so the log tells the two apart.

`decideAudioLink`'s `webrtcAudioLive` conjunct becomes `s.audioStaleCycles < STALE_CYCLES_REFRESH_THRESHOLD && !s.audioNeverStarted`. A connection that has never carried audio must **not** report `'webrtc'`; it should fall through to `'negotiating'` or `'down'` as the remaining arms decide. This is a declared behavior change: a freshly-connected slot will read `negotiating` rather than `webrtc` until real bytes arrive, which is what "heard by" is supposed to mean.

Both are pure functions with table-driven tests — no store instance, no mocks.

- [ ] **Step 1: Failing table rows in `track-health-policy.test.ts`** — `expected && bytes===0` past the grace yields `request-refresh` / `never-started`; inside the grace yields `none`; the existing frozen-after-flowing rows are unchanged (regression guard).
- [ ] **Step 2: Failing table rows in `peer-link-policy.test.ts`** — connected + `audio: true` + never-started → not `'webrtc'`. Include the `AudibilityOutageEnd` scenario as a named row.
- [ ] **Step 3: Implement both policies.**
- [ ] **Step 4: Wire `_checkTrackHealth`** to track and pass `neverStartedCycles`, and to log the reason.
- [ ] **Step 5:** verify; confirm the whole suite is green (this touches the audible-count and stats-panel readers — check `countAudiblePeers` and `decideFlowGlyph` callers).
- [ ] **Step 6:** commit.

### Task 4: clear `_maximizedVideo` when its target stops being renderable

**Branch:** `fix/maximize-reachability-guard`
**Commit message must include:** `supersedes` the Round 3 item-4a fix (`screen-share-maximize-key.test.ts` / `shareMaximizeKey`) — same symptom family, third instance.

**Files:**
- Modify: `ui/src/room/room-view.ts` (`updated` ~:672, `idToLayout` ~:899, `toggleMaximized` ~:664)
- Test: `ui/src/__tests__/screen-share-maximize-key.test.ts` (extend)

**Design:** Replace the three event-specific clear arms' *coverage gap* with one invariant, evaluated every render: if `_maximizedVideo` is set and matches neither a member of `_visiblePeers()`, nor `'my-own-stream'`, nor any active share key from `_getActiveShares()` (via `shareMaximizeKey`, the one key constructor), clear it. Declared: this **replaces** the per-event clear arms as the authority; keep or delete them as the implementation prefers, but do not leave both as independent sources of truth — say which in the commit message.

Also add the diagnostic that would have made Incident A provable: log `_maximizedVideo` transitions through `logger.logCustomMessage` (set / cleared / cleared-by-guard, with the id). This is a **new** forensic surface, declared, not a replacement.

- [ ] **Step 1: Failing test (red first)** — maximize peer B, drop B from `_presentPeers` with no `peer-leave` event, assert peer C's tile is not `hidden`. This must fail before the fix.
- [ ] **Step 2: Negative control** — a legitimately maximized, still-present tile keeps every other tile `hidden`. The guard must not un-maximize a valid maximize.
- [ ] **Step 3: Implement the guard.**
- [ ] **Step 4: Add the transition logging.**
- [ ] **Step 5: Confirm the three existing suite cases still pass**, plus the `view-teardown-symmetry` and `view-count-authorities` pins.
- [ ] **Step 6:** verify; commit.

### Task 5: gate reconnect escalation on our own signal carrier

**Branch:** `fix/reconnect-gate-on-carrier-down`

**Files:**
- Modify: `ui/src/streams-store.ts` (the escalation site that drives full reconnects; `_signalCarrierDownSince` ~:490 is already the input)
- New: `ui/src/transport/reconnect-escalation-policy.ts` (pure)
- Test: `ui/src/transport/__tests__/reconnect-escalation-policy.test.ts`, `ui/src/__tests__/streams-store-wiring.test.ts`

**Design:** While `_signalCarrierDownSince !== undefined`, hold the FSM in `reconnecting` and do not spend a new peer session — SDP that cannot be delivered is not a reconnect attempt, it is queued garbage that lands as a stale-candidate storm when the relay drains. Resume escalation on `SignalCarrierUp`.

New pure function `decideReconnectEscalation({ carrierDownSince, now, attemptsSinceCarrierUp, … }) → { action: 'escalate' | 'hold', reason }`. Bound the hold with a named ceiling so a mis-detected carrier-down cannot wedge recovery forever: `RECONNECT_CARRIER_HOLD_MAX_MS`, reconnect pacing, NOT liveness. Precedent and rationale: `PRESENCE_CARRIER_HOLD_MAX_MS` in `presence-policy.ts`.

Note for the implementer: this only helps the node whose own carrier is down. Eric's and London's carriers were healthy throughout Incident C, so their escalations were reasonable. Do not try to infer a remote peer's carrier state here.

- [ ] **Step 1: Failing table tests** for the policy, including the ceiling arm.
- [ ] **Step 2: Implement the policy.**
- [ ] **Step 3: Wire the escalation site;** delete the unconditional path (replace, don't parallel).
- [ ] **Step 4: Wiring test** — carrier down → no new peer session; carrier up → escalation resumes on the next tick.
- [ ] **Step 5:** verify; commit.

### Task 6: the reconnect control must not kill an in-flight recovery

**Status: PARTIALLY ABSORBED.** The UI half (the tile must show that recovery is under way) was absorbed by `docs/superpowers/plans/2026-09-01-intent-reconciliation.md` Task 6 (landed 2026-09-01, merge `3f3928c`): `describeLinkEstablishment` (`ui/src/intent-diff-policy.ts`) now distinguishes first-establishment ("establishing WebRTC carrier…") from reconnect-after-failure ("connection lost — reconnecting…"), replacing the single inline literal this task's design section cited at the old `room-view.ts:3186`. The **behavior half below (the guard on `disconnectFromPeerVideo` itself) is NOT done** and remains this plan's to implement.

**Branch:** `fix/reconnect-control-respects-recovery`

**Files:**
- Modify: `ui/src/room/room-view.ts` (the `disconnectFromPeerVideo` control and its tile chrome)
- Modify: `ui/src/streams-store.ts` (`disconnectFromPeerVideo` entry point)
- Test: `ui/src/__tests__/` — extend the view suite

**Design:** Two halves.

1. **Behaviour:** when the peer's FSM is already in `reconnecting` or `connecting`, `disconnectFromPeerVideo` becomes a no-op (or an explicit "retry now" that does not tear down an attempt already past `signaling`). Decide which and state it — do not ship both.
2. **UI:** the tile must show that recovery is under way. ~~The template already renders `establishing WebRTC carrier...` when `conn && !conn.connected` (`room-view.ts:3186`); extend it to distinguish first-establishment from reconnect-after-failure so the user has a reason not to press the button.~~ Done via `describeLinkEstablishment` — see the Status note above.

Declared behavior change: a user who presses reconnect during an active attempt no longer restarts it.

- [ ] **Step 1: Failing test** — FSM in `reconnecting`, control invoked, assert no `closeConnection`.
- [ ] **Step 2: Implement the guard.**
- [x] **Step 3: Implement the tile state;** pin the copy in a test so it cannot silently regress. — done as part of the intent-reconciliation round; copy pinned in `ui/src/__tests__/intent-diff-policy.test.ts`.
- [ ] **Step 4:** verify; commit.

### Task 7: audibility outage without a third peer

**Branch:** `fix/audibility-outage-two-person-room`

**Files:**
- Modify: `ui/src/streams-store.ts` (`_checkAudibilityOutages` ~:5647, `_outageStates` ~:4504)
- Test: `ui/src/__tests__/streams-store-wiring.test.ts`

**Design:** Depends on Task 3 (`never-started` is what makes a self-evidenced outage detectable without a relay). Add a second arm that fires without `relayVia` when the evidence is local and unambiguous: slot `connected`, `audio` expected, zero bytes for the `OUTAGE_THRESHOLD_MS` window. Keep the existing relayed arm — it carries stronger evidence and a different detail string. Declared: this **adds** an arm, and the reason is that the relayed arm is structurally blind in the two-person case, which is precisely Incident B's first two minutes.

Distinguish the two in the event detail so merged logs stay readable (`relay-via=…` vs `self-evidenced`).

- [ ] **Step 1: Failing wiring test** — two-person room, zero audio bytes, no third-party observer, assert `AudibilityOutageStart` fires after the threshold.
- [ ] **Step 2: Negative control** — the relayed arm still fires with its own detail string when a third peer is present.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** verify; commit.

### Task 8: the capability race on join

**Status: SUPERSEDED — do not implement as written.** Superseded by `docs/superpowers/plans/2026-09-01-intent-reconciliation.md` Task 4 (landed 2026-09-01, merge `332489c`): `decideWebrtcEligibility` (`ui/src/transport/carrier-coverage.ts`) gained a `'peer-caps-unknown'` reason distinct from `'peer-lacks-sdp-fsm-cap'`, resolving this task's option debate in favor of option 2 plus a twist — no park-and-re-drive machinery was built, because the existing per-pong `decideInitRetry` drive already re-evaluates eligibility once the peer's payload arrives, so a bounded parking window would have solved a problem that reconciler already absorbs.

**Branch:** `fix/init-request-caps-race`

**Files:**
- Modify: `ui/src/streams-store.ts` (`handleInitRequest` ~:6463, the `peer-lacks-sdp-fsm-cap` arm ~:6522)
- Modify: `ui/src/transport/carrier-coverage.ts` if the eligibility predicate needs a third state
- Test: `ui/src/transport/__tests__/carrier-coverage.test.ts`, `ui/src/__tests__/streams-store-wiring.test.ts`

**Design:** Distinguish *known to lack the cap* from *caps not yet received*. `decideWebrtcEligibility` currently collapses both into `peer-lacks-sdp-fsm-cap`. Options, in preference order:

1. Add a `caps-unknown` reason and, on that reason, park the request briefly and re-drive when the peer's payload arrives (the `_peerModuleStates` write is the natural trigger). Bounded by a named window; if caps never arrive, fall through to today's drop.
2. If (1) is too invasive, at minimum log the two cases differently so the field can tell a real old-build refusal from a race.

Do **not** simply answer an InitRequest from a peer with unknown caps — that reintroduces the lure the current comment correctly warns about (`streams-store.ts:6523-6527`).

- [ ] **Step 1: Failing table rows** for the third eligibility state.
- [ ] **Step 2: Implement the predicate change.**
- [ ] **Step 3: Implement the re-drive** (or the log split, if the plan lands on option 2 — say which in the commit message).
- [ ] **Step 4:** verify; commit.

### Task 9: surface `SignalCarrierDown` to the local user

**Status: ABSORBED — do not implement as written.** Superseded by `docs/superpowers/plans/2026-09-01-intent-reconciliation.md` Task 6 (landed 2026-09-01, merge `3f3928c`): the room-level carrier banner is one arm of the `StreamsStore.intentDiffs` surface (`ui/src/intent-diff-policy.ts`'s `carrier` scope), rendered against `_signalCarrierDownSince` the same way this task proposed, but sharing its authority and copy-pinning discipline with the mic/camera diff arms instead of being a standalone banner implementation.

**Branch:** `feat/signal-carrier-down-banner`

**Files:**
- Modify: `ui/src/room/room-view.ts`
- Modify: `ui/src/streams-store.ts` (expose `_signalCarrierDownSince` as a readable store if it is not already)
- Test: view suite

**Design:** A room-level banner on the node whose own carrier is down: "Your connection dropped — reconnecting". Purely local; no wire change. This is the cheapest thing on the list and would have ended Incident C's guessing in one second, and would also have distinguished Incident B (dead mic, network fine) from Incident C (network gone) for the users involved.

- [ ] **Step 1:** implement; pin the banner's presence/absence against `_signalCarrierDownSince` in a test.
- [ ] **Step 2:** verify; commit.

### Task 10: doc-sync

**Branch:** `docs/2026-09-01-field-incident-fixes`

- [ ] **Step 1:** Mark each task above landed or not-landed in this document (working agreement 3).
- [ ] **Step 2:** Update this document's Status header.
- [ ] **Step 3:** Add a `CLAUDE.md` "True today" bullet for the round — records of landed changes, anchored to the merge; present-tense claims only where they name the enforcing file or test; no test counts, no repo-state snapshots, no unanchored negations.
- [ ] **Step 4:** `nix develop -c npm run verify` (includes `claude-md-drift.test.ts`); commit.

---

## Notes for reviewers

- **Three separate failures, one morning, two of them total-loss for the affected user.** Incidents A and B were both "the app is running, the connection is fine, and the feature is entirely absent" — the class of failure this codebase's liveness-authority work was meant to eliminate. Both slipped through because the failing signal was *view state* (A) or *local capture state* (B), and neither is covered by any liveness predicate.
- **D3+D4+D5 compound.** The capture died, the detector was blinded by the first reconnect, and the UI then reported the peer as audible. Each defect alone is survivable; together they made a 4-minute total audio loss invisible to every automatic mechanism in the system. Fix all three or the field symptom will recur in a different shape.
- **Incident C's drop is not an app defect.** Say so plainly in any summary. The app-side findings there (D7, D8) are about recovery hygiene, not the outage.
- **`bytes > 0` is the shared root of D4 and D5.** If a reviewer only has budget for one task, Task 3 is the highest-information change: it converts a silent-blind state into a named verdict that two consumers already read.
- **D1's instance is inferred.** The mechanism is proven in code and is the only path to the observed symptom, but the France session's view state was wiped by the rejoin. Task 4's logging closes that for next time; do not present the attribution as confirmed until it is.
- **Tasks 1, 2, 8, 9 and Task 6's UI half were absorbed/superseded by the intent-reconciliation round before this plan's own execution began** — see `docs/superpowers/plans/2026-09-01-intent-reconciliation.md`'s "Relationship to the field-incident plan" section for the original disposition table, and the per-task Status notes above for what actually landed. Tasks 3, 4, 5, 7 and Task 6's behavior half are unaffected and remain to be executed from this document as written.
