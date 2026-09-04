# Fragment splits + MediaLinks — design spec (store-decomposition round three)

Written 2026-09-04, brainstormed as the round-three entry work named in
`docs/superpowers/specs/2026-09-03-owner-extraction-design.md` ("round
three by name"). Rounds one and two consolidated per-peer state onto
`PeerRecord` and extracted five owner objects; this round splits the
two multi-concern methods and extracts the media-link concern plus the
shared teardown kernel. Built on `main-0.7` (@ `612e7da`), branch
`media-links`.

## Problem

`ui/src/streams-store.ts` (5,757 lines at 2026-09-04) still carries two
methods that weld multiple concerns into one body, and the media
transport glue as loose methods:

- `handlePongUi` (~337 lines) runs nine sequential fragments — pong
  parse/log, the RTT fold into `signalsStats`, two roster merges
  (`_othersConnectionStatuses`, `_knownAgents`), the module-state
  sweep, stale video cleanup, the init-retry drive, an
  audio-expectation check, and the outgoing screen-share stale/ensure
  pair. Every *decision* already lives in a pure policy
  (`foldSignalsRtt`, `decideModuleStateMerge`,
  `decideStaleConnectionCleanup`, `decideInitRetry`,
  `decideWebrtcEligibility`); the method is nine apply-halves welded
  together, so no single concern can be read, moved, or reviewed
  alone.
- `pingAgents` (~70 lines) has the same disease smaller (carrier
  forensics, roster sweep, ping send, cadence evaluation, the
  track-health call).
- The media transport glue + close-cleanup kernel (~1,100 lines:
  `_dispatchMediaEvent`, the six media handlers, ICE forensics,
  `_applyCloseCleanup`/`_applyStaleTeardown`, establishment) is the one
  large concern cluster still living as loose store methods — the
  ScreenShareLinks twin that round two deliberately deferred.

## Decisions (made in brainstorming, 2026-09-04)

1. **Round three = part 1 (fragment splits) + part 2 (MediaLinks
   owner).** The `start()`/`disconnect()` composition root,
   reactive-`Writable` unification, and the forensic *fold* stay out —
   round four by name. Zero behavior change throughout.
2. **Part 1 is pure method extraction on the same class.** Fragments
   become named store-private methods, bodies verbatim; the pong
   `try/catch` scope is preserved exactly (it spans stats + roster +
   modules — the wrapper keeps that boundary). This is the enabler:
   part 2 moves whole named methods instead of carving fragments live.
3. **MediaLinks owns the media concern AND the shared teardown
   kernel.** The kernel (`_applyCloseCleanup`, `_applyStaleTeardown`)
   is media-owned by declaration: every screen-share/track-health path
   already routes into it, and they keep doing so through unchanged
   bindings, because the store retains bare delegates for both kernel
   methods — zero edits to the round-two owner files.
4. **`_openConnections` moves into MediaLinks** (store keeps the
   delegating getter). Verified 2026-09-04: all its writers are the
   moving glue/establishment paths plus `disconnect()`'s wipe and
   `_clearPendingWebrtcStatus`'s clear — the latter two keep calling
   `.set`/`.update` THROUGH the delegating getter (amended at
   plan-writing: the getter returns the owner's `Writable` instance,
   so non-moving writers need no owner calls — the round-two
   screen-share precedent).
   `_connectionStatuses` STAYS on the store — presence (`pingAgents`'s
   status seed) and `handleLeaveUi` write it too, so moving it would
   drag non-media writers through bindings; the owner writes it via a
   binding.
5. **Round-two conventions bind unchanged**: bindings field named
   `bindings`, late-bound arrows for mutable store state, record reads
   via the store's `_peerRecord` accessor, writes via
   `ensurePeerRecord` only where origin wrote, real signatures at the
   seam, `@holochain-open-dev/stores` imports, owner constructed in the
   constructor body, class doc records what deliberately did NOT move.
6. **A fat owner is accepted deliberately** (~1,300 lines, ~20
   bindings): it is the media concern plus the kernel every teardown
   routes through, and the bindings record documents that coupling
   honestly (round-two decision 3, extended).

## Part 1 — fragment splits

`handlePongUi` becomes: parse/log guard, then

```
try {
  this._applyPongStats(pubkeyB64, metaData);
  this._applyPongRoster(pubkeyB64, metaData, now);
  this._applyPongModuleSweep(pubkeyB64, metaData);
} catch (e) { /* existing catch, verbatim */ }
await this._drivePongMediaLink(pubkeyB64, signal.from_agent, metaDataExt, now);
this._drivePongScreenShare(pubkeyB64, now);
```

- `_applyPongStats` — the `foldSignalsRtt` block, `signalsStats` write,
  quality emit.
- `_applyPongRoster` — the `_othersConnectionStatuses` and
  `_knownAgents` merges.
- `_applyPongModuleSweep` — the `decideModuleStateMerge` sweep +
  dispatches.
- `_drivePongMediaLink` — the `conversationActive`/`webrtcDisabled`/
  `peerCapsKnown` reads, stale video cleanup, `decideWebrtcEligibility`
  + `decideInitRetry` drive (including the InitRequest send and the
  `alreadyOpen` reconcile), and the audio-expectation check.
- `_drivePongScreenShare` — the outgoing-share stale check +
  `ensureOutgoingScreenShare` call.

`pingAgents` splits the same way into named methods for carrier
forensics, the roster sweep, the ping send, the cadence/voice-batch
evaluation, and the track-health call — order and `await`s preserved.
Exact method names and parameter lists are fixed by the plan; bodies
are verbatim; local variables shared across fragment boundaries (e.g.
`metaDataExt`, `alreadyOpen`) become parameters or are recomputed
exactly as the origin computes them — the plan declares which, per
variable, and any recomputation must be a pure re-read with no
side-effect (else it becomes a parameter).

## Part 2 — MediaLinks (`ui/src/media-links.ts`)

Moves (verified against the current file during brainstorming; the plan
pins exact line ranges):

- Transport glue: `_subscribeMediaTransport`, `_dispatchMediaEvent`,
  `_applyMediaSignalingRoute`, `_handleEstablishmentTimeline`, the six
  media handlers (`_handleMediaConnected`/`Closed`/`RemoteStream`/
  `RemoteTrack`/`DataChannelMessage`/`Error`),
  `_handleMediaIceDiagnostic`.
- ICE/SDP forensics: `_stakeIceTiming`, `_clearIceTiming`,
  `_emitIceEstablishment`, `_emitIceNeverConnected`, the `_iceTimings`
  field, `_sdpDataAggregates` + `_logSdpDataEvent` + its flush sweeps
  (the composite keys move as-is — same forensic shape, new home; the
  round-four fold decision is untouched).
- The kernel: `_applyCloseCleanup`, `_applyStaleTeardown`. The store
  keeps bare delegates with the current names so round-two owners'
  bindings and `handleLeaveUi` keep working with zero edits.
- Status: `updateConnectionStatus` (writes the store-resident
  `_connectionStatuses` through a binding).
- Establishment: `handleInitRequest`, `handleInitAccept`,
  `handleSdpFsm`, `_computeSdpTimeout`, `_computeSdpBackstopTimeout`,
  and part 1's `_drivePongMediaLink` (owner name: `drivePong`).
- The `_openConnections` `Writable` (store keeps the delegating
  getter; wiring tests and views read through it unchanged).
- Sender tuning used only by the moving glue: `_videoMaxBitrate`,
  `_applySenderPriorities`, `_readIceTransportPolicy`-class helpers
  move IF their only callers move (the plan verifies each; a helper
  with a surviving store caller stays and is bound).

Stays on the store: `_sendRtcAction`/`_broadcastRtcAction` (the one
send seam), `_maybeEmitQualityChange` (stats concern),
`_connectionStatuses`, `_nextConnectionEpoch`, `_peerCaps` (shared
with ScreenShareLinks — reached via bindings, as today), the gesture
methods and everything else round two placed.

Cross-owner edges become bindings: `screenShareLinks`'s status update
and outgoing-share teardown, `trackHealth.refreshTracksForPeer`,
`peerAudioLevels.setupPeerAudioAnalyser`,
`diagnosticsHub.noteConversationParticipant`, plus the store-kept
`_sendRtcAction`, `_maybeEmitQualityChange`, `_nextConnectionEpoch`,
`_peerCaps`, `sendMessage`, `eventCallback`, `logger`, `clock`, record
accessors, `mediaTransport` (late-bound), `_connectionStatuses` writer.
The bindings sketch is refined by the plan from the actual bodies —
the bodies are the authority; an uncovered `this.X` is a STOP.

## What deliberately does not move (round four by name)

- `start()`/`disconnect()` — the composition root. `disconnect()`
  keeps its inline record wipe and its `_openConnections.set({})`
  becomes an owner call or delegate write (the plan declares which,
  identity-preserving).
- Reactive-`Writable` unification.
- The `_iceTimings`/`_sdpDataAggregates` *fold* onto per-attempt
  sub-maps (they move with the glue unchanged).
- `pingAgents`'s split fragments stay store-private this round —
  the roster/presence concern has no owner yet.

## Testing and enforcement

- Same regime as round two: verbatim moves under substitution tables;
  per-task origin diffs by independent reviewers; the wiring, intent,
  and construction suites green UNMODIFIED (the wiring suite drives
  `handlePongUi`/`pingAgents`/the glue through the store surface, which
  delegates — coverage carries through); per-task repo-wide reference
  greps (`ui/harness` is untypechecked); `media-links.ts` joins
  `no-ambient-clock.test.ts`'s `PINNED_FILES` with `FULL_PATTERNS`;
  gate `nix develop -c npm run verify` green before every commit
  (unsandboxed — the `.gitmodules` gotcha).
- Part 1's splits must be invisible to every suite; a wiring assertion
  that must change in meaning is a stop signal.
- Zero declared behavior changes is the round's definition of done.

## Task plan

1. **Landed** (`f6a4563`, fixup `103ab37`). Split `handlePongUi` into
   the five named private methods.
2. **Landed** (`b726d6d`). Split `pingAgents` the same way.
3. **Landed** (`f423efd`). MediaLinks A — transport glue + kernel +
   ICE/SDP forensics + `_openConnections`, with store delegates for
   the kernel.
4. **Landed** (`2ca43c8`). MediaLinks B — establishment
   (`handleInitRequest`/`Accept`, `handleSdpFsm`, SDP timers,
   `updateConnectionStatus`, `drivePong`).
5. **Landed** (this doc-sync, plus prose-fix commit `87a8e34`).
   Doc-sync — CLAUDE.md bullet per its contract; landed markers here;
   the round-four list recorded.

Process: `superpowers:writing-plans` →
`superpowers:subagent-driven-development` (fresh implementer per task,
independent adversarial review per task, final whole-branch review), in
worktree `.claude/worktrees/media-links`.

## Risks (named)

- **Fragment-boundary variables** — a shared local recomputed instead
  of passed can diverge if the re-read is not pure; the plan declares
  parameter-vs-recompute per variable and the reviewer checks each.
- **Kernel delegation loops** — round-two owners bind
  `applyCloseCleanup` arrows to store methods that become delegates to
  MediaLinks; the chain must stay a bare two-hop forward with no
  reordering (reviewer checks the delegates are single-statement).
- **The try/catch scope** in `handlePongUi` — widening or narrowing it
  changes which fragment failures are swallowed; the split pins the
  exact current boundary.
- **Fat bindings drift** — ~20 entries; each must be late-bound where
  it reads mutable state (the round-two canary tests cover storage and
  transports; the rest is review-checked).

## Definition of done

`handlePongUi` and `pingAgents` are short pipelines of named
single-concern methods; `MediaLinks` owns the media glue, the kernel,
establishment, and `_openConnections` with the store delegating;
round-two owner files untouched; `verify` green with zero declared
behavior changes; adversarial review clean per task plus final
whole-branch review; doc-sync updates CLAUDE.md and this spec; round
four's list (composition root, reactive unification, forensic fold,
presence-owner for the ping/pong roster fragments) recorded.
