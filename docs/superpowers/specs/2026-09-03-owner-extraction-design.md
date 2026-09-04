# Owner extraction — design spec (store-decomposition round two)

Written 2026-09-03, brainstormed as the round-two follow-on named in
`docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md`
("Next steps after this round"). Round one consolidated all per-peer
state onto `PeerRecord`; this round lifts five concern clusters out of
`ui/src/streams-store.ts` into owner objects. Built on `main-0.7`
(@ `d33834a`), branch `owner-extraction`.

## Problem

`ui/src/streams-store.ts` is 6,854 lines after round one. Per-peer
*state* now has one home, but concern *behavior* is still co-located in
one class: a design-time inventory (2026-09-03, this brainstorm) mapped
~17 clusters, of which five are extractable now with modest coupling,
while the genuinely entangled mass (the transport-glue/close-cleanup
kernel ~1,113 lines; `handlePongUi`, one 337-line method carrying
fragments of five concerns; the `start()`/`disconnect()` composition
root) needs method-splitting first and is round three.

The file split is the by-product of the extraction, never its own task
(the round-one handoff's argument, still binding).

## Decisions (made in brainstorming, 2026-09-03)

1. **Round two extracts five clusters**: peer audio analysis,
   settings/devices, diagnostics pipeline, track/stale health, screen
   share — the spec-named four plus settings — plus one narrow
   janitorial task deleting verified-dead residue. Zero behavior
   change. Everything else stays; the entangled mass is round three by
   name.
2. **Owners own state; the record is injected.** Each owner is a class
   over a bindings record (the `capture-reconciler.ts` /
   `room-ownership.ts` shape): it constructs and owns its concern's
   `Writable`s and non-record state; the store exposes the same names
   as delegating members so views and the wiring suite keep their read
   paths. `PeerRecord` stays the ONE per-peer home — owners reach it
   only through injected `{peerRecord, ensurePeerRecord}` accessors,
   never their own maps (that would undo round one).
3. **Fat bindings are accepted as honest coupling.** Screen share's
   bindings record has ~10 entries; that documents the real coupling
   instead of hiding it behind `this`.
4. **Edge resolution is uniform.** Inbound edges (another cluster
   calling an extracted method) stay at their call sites and become
   `this.<owner>.<method>(...)` — extraction never restructures the
   calling cluster. Outbound edges (an extracted method calling store
   internals: `_applyCloseCleanup`, `_sendRtcAction`,
   `_maybeEmitQualityChange`, `_computeSdpTimeout`,
   `_nextConnectionEpoch`, `_peerCaps`, module activate/deactivate)
   become named callbacks in the bindings record, bound at store
   construction/start. The shared teardown kernel stays on the store
   this round.
5. **Verbatim moves.** Method bodies move unchanged except for the
   mechanical `this._x` → binding/accessor rewrites. The identity rules
   from round one bind: no added guards, no dropped defaults, no read
   turned into a get-or-create, no assertion changed in meaning.

## The five owners

Flat files in `ui/src/`, following the existing owner-object naming.
Line counts are from the design-time inventory (approximate; the plan
verifies exact ranges).

| Owner | File | Moves (~lines) | Bindings beyond `clock`/`logger` |
|---|---|---|---|
| `PeerAudioLevels` | `ui/src/peer-audio-levels.ts` | `setupPeerAudioAnalyser`, `getWebrtcAudioLevel` (~42; analyser *removal* is already `resetPeerRecord`'s `media-close-full` arm, not a method) | `ensureAudioContext`, record accessors |
| `MediaSettings` | `ui/src/media-settings.ts` | device enumeration + device-id `Writable`s, TURN/ICE storage getters, trickle toggles, `iceConfig`, `changeVideoInput`/`changeAudioInput` (~133) | `storage.local`, `deps.mediaDevices`, `changeDevice` callbacks into mic/camera sources |
| `DiagnosticsHub` | `ui/src/diagnostics-hub.ts` | request/retry/RTT-scaled timeout, merged-log export, `handleDiagnosticRequest`/`Response`, the three diagnostic `Writable`s, `_conversationParticipants` (~283) | `sendMessage`, a present-peers snapshot fn, a `signalsRttEwma` read accessor |
| `TrackHealthMonitor` | `ui/src/track-health.ts` | `_checkTrackHealth`, `_applyStaleTeardown` trigger path, `reconcileVideoStreamState`, replace/clone recovery, `refreshTracksForPeer` (~263) | `mediaTransport` ops, `applyCloseCleanup`, `sendRtcAction`, `maybeEmitQualityChange`, record accessors, mic/camera lifecycles |
| `ScreenShareLinks` | `ui/src/screen-share-links.ts` | both-direction transport handlers, `_ensureOutgoingScreenShare`, `screenShareOn/Off`, `stopScreenShare`, `disconnectFromPeerScreen`, `updateScreenShareConnectionStatus`, `handleSdpFsmScreen`, the two screen-share connection `Writable`s + `_screenShareConnectionStatuses` (~470) | both screen transports, `applyCloseCleanup`, `computeSdpTimeout`, `nextConnectionEpoch`, `peerCaps`, module activate/deactivate, `eventCallback`, display-capture acquisition |

(The name `screen-share-links.ts` avoids colliding with
`ui/src/room/modules/screen-share.ts`.)

**Amendment (2026-09-03, plan-writing verification):** the gesture entry
points `screenShareOn`, `screenShareOff`, and `stopScreenShare` STAY on
`StreamsStore` — `ui/src/__tests__/intent-write-sites.test.ts` pins
`_applyIntent` as store-only-writer and greps `streams-store.ts` for the
gesture-method headers (exact signatures) whose bodies must contain the
`_applyIntent` calls, including `screenShareOn`'s `track.onended`
gesture-equivalent. The owner therefore takes the connection/status/
routing mechanics (transport handlers, ensure/close, status bookkeeping,
`handleSdpFsmScreen`, the three screen-share `Writable`s); the store's
gesture methods keep intent writes + acquisition and call the owner for
connection work. Moved-line estimate drops to roughly 400.

## What deliberately does not move (round three by name)

- `handlePongUi`'s five embedded fragments (signals-RTT fold, module
  merge sweep, stale teardown, screen-share ensure, eligibility reads)
  and `pingAgents`' inline cadence block — splitting those methods is
  round three's entry work.
- The transport-glue/close-cleanup kernel (`_dispatchMediaEvent`,
  `_applyCloseCleanup` and the media handlers) — every teardown path
  routes through it; it stays the store's shared kernel this round.
  (`_handleMediaRemoteStream`/`Track` stay here and call the
  audio-levels owner.)
- `start()`/`disconnect()` — the composition root; `disconnect()`
  keeps its inline three-field record wipe unchanged.
- Reactive-`Writable` unification and the forensic composite fold
  (`_iceTimings`, `_sdpDataAggregates`) — deferred as in round one's
  spec.

## Janitorial task (added at approval)

Delete verified-dead residue, each candidate proven dead in the task
itself before deletion: `mainStreamClones` (inventory finding: nothing
ever pushes to it, so its fan-out loop in `start()` is a no-op —
re-verify, then delete field + loop + the comments citing it). NOT
dead, do not touch: the retired wire-flow log-and-drop arms
(`SdpData`, screen-typed Init branches — declared diagnostic arms) and
the commentary blocks that ARE the declarations for Round-3 deletions.
Anything else found dead during the round is flagged to the
controller, not deleted on an implementer's own judgment.

## Testing and enforcement

- **Coverage carries through delegation**: the wiring suite drives the
  store's glue, which now delegates — the same assertions exercise the
  owners' moved code. Test edits are mechanical re-points only; an
  assertion that must change in meaning is a stop signal.
- New tests only where a move creates a genuinely new seam: at most a
  small construction test per owner. No speculative suites — the
  wiring net stays the authority (round-one precedent).
- Each owner file joins `no-ambient-clock.test.ts`'s `PINNED_FILES`
  with `FULL_PATTERNS` (owners take the clock injected, like
  `capture-reconciler.ts`). `event-taxonomy.test.ts` walks the whole
  source tree, so moved emission sites stay covered — keep them as
  literals on `event:` lines through the move.
- **Per-task repo-wide reference grep** (round-one lesson): every task
  ends with a grep proving the moved method/field names have no stale
  references outside the owner and its delegation points — `ui/harness`
  is not typechecked, so `tsc` cannot catch a miss there.
- Gate: `nix develop -c npm run verify` green before every commit
  claim (run unsandboxed — the sandboxed `nix develop` fails on
  `.gitmodules` yet exits 0). Zero declared behavior changes is the
  round's definition of done.
- Process: `superpowers:writing-plans` →
  `superpowers:subagent-driven-development` (fresh implementer per
  task, independent adversarial review per task, final whole-branch
  review), in worktree `.claude/worktrees/owner-extraction`.

## Task plan

1. **Landed** `818e5cd` (+ fixup `b20e2d5`) — `PeerAudioLevels`
   (smallest; proves the pattern).
2. **Landed** `29b2ff2` (+ fixup `f52b0aa`, shared with task 3) —
   `MediaSettings`.
3. **Landed** `c1bf254` (+ fixup `f52b0aa`, shared with task 2 — the
   fixup touches `media-settings.ts`, `diagnostics-hub.ts`, and
   `streams-store.ts` (delegate-doc trim), landed as one commit between
   tasks 3 and 4) — `DiagnosticsHub`.
4. **Landed** `79d158d` — `TrackHealthMonitor`. In-review amendment:
   the bindings-record sketch above named `applyStaleTeardown`,
   `myPubKeyB64`, and `localIntent`, none of which the moved bodies
   actually reference; the landed `TrackHealthBindings`
   (`ui/src/track-health.ts`) drops all three and adds `mainStream`
   (late-bound, `StreamsStore.mainStream` is reassigned outside the
   constructor) and `webrtcStats` (a direct mutable-Map reference,
   field-initialized before this owner is constructed, so no
   late-binding was needed) — found true to the bodies during
   implementation, not a scope change.
5. **Landed** `e47e6dc` — `ScreenShareLinks` (largest; landed last so
   the pattern was settled). In-review amendment: `closeGuardOutcome`
   — read by the moved close handler, `_handleScreenShareClosed`
   (`ui/src/screen-share-links.ts:291`) — was relocated from
   `streams-store.ts` to `ui/src/transport/close-cleanup-policy.ts` as
   the one exported (target × via × outcome)-table outcome adapter,
   table-tested there, rather than added to the owner's bindings
   record; both the owner and the store import it from its new home.
6. **Landed** `fc72032` — janitorial dead-code deletion
   (`mainStreamClones`), its own branch rather than folded into task 5.
7. **Landed** `475c3da` (deferred comment fixes) + this commit —
   doc-sync: CLAUDE.md "True today" bullet per its contract; landed
   markers here; the round-three list recorded below and in CLAUDE.md
   where the next session will find it.

Also landed, outside the numbered plan: `ac62385` — six review-deferred
normalizations spanning tasks 2–5, folded in at task 6's close rather
than reopening each task's branch: (1) `media-settings.ts`'s header
cites the design spec by path, matching `peer-audio-levels.ts`; (2)
`StreamsStore`'s `MediaSettings` construction moved from the end of the
constructor to immediately after the `_localIntent` assignment — a
code-position change, not a behavior one, but worth recording in a
zero-behavior round; it shrinks the window where a delegating getter
could read an unconstructed owner (verified no statement between the
old and new positions reads a `mediaSettings`-delegated member); (3)
`TrackHealthMonitor.reconcileVideoStreamState`'s JSDoc, dropped by the
extraction, was restored verbatim from the pre-extraction
`streams-store.ts` at `d33834a`; (4) stale prose in
`init-retry-policy.test.ts` and `compat-corpus.test.ts` re-pointed from
the deleted `StreamsStore._ensureOutgoingScreenShare` to its current
home, `ScreenShareLinks.ensureOutgoingScreenShare`
(`ui/src/screen-share-links.ts`) — comments only, no assertion changes;
(5) `screen-share-harness.ts`'s header layering claim (the listed paths
are store code, now `ui/src/screen-share-links.ts`, not harness code)
was restored after task 5's edit lost it; (6) a table-driven `describe`
block for the newly exported `closeGuardOutcome` was added to
`close-cleanup-policy.test.ts`, covering all `SlotWrite` arms it maps
onto the outcome axis.

## Risks (named)

- **Delegation drift** — a delegating member that subtly reorders or
  wraps the moved call changes behavior; review checks each delegation
  is a bare forward.
- **Binding-closure staleness** — bindings must preserve live-read
  semantics where the current code reads live (e.g. storage-backed
  getters read per call today; a binding that snapshots at construction
  changes behavior). The plan marks each binding live-closure vs
  snapshot explicitly.
- **`this`-capture** — moved methods referencing store state not in
  their bindings record fail `tsc`; strict mode is the net, but the
  per-task grep backstops the untypechecked harness.

## Definition of done

Five owners landed with their clusters deleted from `streams-store.ts`
(net-negative store, verbatim moves); janitorial deletions verified;
`verify` green with zero declared behavior changes; adversarial review
clean per task plus final whole-branch review; doc-sync updates
CLAUDE.md and this spec; round three's entry work (method-splitting the
pong/ping/kernel mass) recorded as the named next step.
