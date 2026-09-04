# PresenceLoop + composition-root split — design spec (store-decomposition round four, closing the line)

Written 2026-09-04, the final round of the store-decomposition line
(rounds: PeerRecord consolidation → owner extraction → media-links →
this). Built on `main-0.7` (@ `5b63272`), branch `presence-loop`.
After this round the line is DECLARED CLOSED — see "Closing the line".

## Problem

`ui/src/streams-store.ts` is 4,196 lines (2026-09-04). Two things
remain worth doing at refactor risk, and two things on the round-four
list no longer justify their cost:

- The presence/roster loop (~800 lines: `pingAgents`'s pipeline and
  fragments, the ping/pong presence fragments, carrier forensics,
  presence sounds, and the roster `Writable`s) is the last large
  coherent concern living loose on the store.
- `start()` (~420 lines) and `disconnect()` are single unreadable
  bodies; they are the composition root and should STAY on the store,
  but as named phases.
- The forensic fold's own trigger ("only if extraction shows
  friction") never fired — `_iceTimings`/`_sdpDataAggregates` moved
  cleanly through two rounds with their composite keys intact. YAGNI:
  not done, dormant.
- Reactive-`Writable` unification drags the view layer in and has
  been deferred by declaration since round one. Dormant.

## Decisions (made in brainstorming, 2026-09-04)

1. **Round four = PresenceLoop owner + composition-root split, then
   the line closes.** Zero behavior change throughout, the same
   contract as rounds one–three.
2. **PresenceLoop owns presence state and behavior; the pong/ping
   HANDLERS stay store dispatchers.** The signal hub story stays
   one-hop (hub → store handler → owner fragment); the handlers are
   already thin pipelines after round three. Fragments move by
   concern, not by handler.
3. **Non-presence tick work stays on the store**: `_applyPongStats`
   (signals-stats), `_applyPongModuleSweep` (module concern),
   `_evaluateSignalsCadence` and `_sweepPendingInits`
   (signals-media/establishment bookkeeping that happens to run on
   the tick). The pipelines call them exactly where they do today.
4. **The roster `Writable`s move into the owner** behind store
   delegating getters (the round-two/three pattern): `_knownAgents`,
   `_presenceTick`, `_othersConnectionStatuses`. The constructor's
   derived stores (`_activeAgents`, `_presentPeers`,
   `_signalsTargets`) read through the getters, so `presenceLoop` is
   constructed before those `derived(...)` definitions — the
   `mediaLinks`-first precedent extended to two early owners. The
   derived stores themselves STAY on the store (views and owner
   bindings read them).
5. **The composition root stays the composition root.** `start()` and
   `disconnect()` split into named store-private phase methods —
   Part-1-style pure extraction (verbatim bodies, order and awaits
   identical), no owner. Interval arming stays in the root phases;
   the owner exposes methods the phases call.
6. **Round-one-to-three conventions bind unchanged** (bindings field
   `bindings`; late-bound arrows; record access via `_peerRecord`/
   `ensurePeerRecord` as origin; real signatures; owner constructed in
   the constructor body; class doc records what did NOT move;
   `@holochain-open-dev/stores`). NEW this round, adopted from the
   round-three final review: **code comments cite only tracked
   files** — never `.superpowers/` paths.

## Part 1 — PresenceLoop (`ui/src/presence-loop.ts`)

Moves in (verbatim under a substitution table; the plan pins exact
members and line anchors at `5b63272`):

- State: `_knownAgents`, `_presenceTick`, `_othersConnectionStatuses`
  `Writable`s (store keeps same-named delegating getters);
  `_lastPresenceSet`, `_lastComputedPresent`, `_presenceSoundState`,
  `_signalCarrierDownSince` (+ any presence-sound unsub handle the
  plan finds attached).
- Methods: `pingAgents`'s pipeline (the owner method drives the tick
  work, calling store-resident pieces via bindings where decision 3
  keeps them), `_applyPingRosterSweep`, `_sendPings`,
  `_emitPresenceForensics` (the review-C1 forensics-before-
  roster-write ordering is a pinned invariant that travels with the
  pipeline — its comment moves verbatim), `_applyPongRoster`, the
  presence-sound arming/decision glue, and ~~`handlePingUi`'s presence
  half (the plan draws the exact line; its screen-share stale check
  stays a store/MediaLinks-side call as today)~~ — **AMENDED at plan
  time (recorded in the plan header, landed Task 4):** `handlePingUi`
  moves NOTHING. Its body is a pong-reply builder over cross-concern
  reads plus the screen-share fragment, so it stays a store dispatcher
  entirely; the pong side contributes only `_applyPongRoster` to the
  owner. This sketch is superseded by that line.
- The presence-tick subscription work currently armed in `start()`
  moves behind owner methods that the root's phase methods call.

Stays on the store: the pong/ping/leave HANDLERS (dispatchers);
`_applyPongStats`; `_applyPongModuleSweep`; `_evaluateSignalsCadence`
(+ `_signalsCadence`/`_voiceBatchCapAllTargets` fields);
`_sweepPendingInits`; `_checkAudibilityOutages` (audio-relay
forensics, reads presence via bindings/getters as today);
`globalPresenceSet` and the peer-link reporting family; the derived
stores; `handleLeaveUi` (it is a teardown dispatcher into the kernel
delegates — its roster write, if any, becomes an owner call the plan
pins).

Bindings sketched (bodies are the authority; uncovered `this.X` =
STOP): `sendMessage`, `clock`, `logger`, `myPubKeyB64`, `allAgents`
read, `blockedAgents` read, `mainStream` read (stream-info log),
`checkTrackHealth`/`flushStaleSdpAggregates`/`evaluateSignalsCadence`/
`sweepPendingInits`/`checkAudibilityOutages` callbacks (decision 3),
`_connectionStatuses` store (the roster seed writes it — it STAYS
store-resident, round-three decision reaffirmed), record accessors,
`decideSignalCarrier`/`computePresentPeers`/
`decidePresenceSoundEvents` pure imports (move with the bodies),
`eventCallback` (presence sound events).

## Part 2 — composition-root split

`start()` splits into named store-private phases, verbatim bodies,
order identical (names indicative; the plan fixes them from the actual
body): `_startTransports`, `_startSignalRouting`,
`_startPresenceTicking`, `_startCaptureSources`,
`_startPageLifecycle`, plus whatever residue the body dictates.
`disconnect()` splits into teardown twins the same way. No behavior
change; the destroy-exactly-once and start/disconnect symmetry pins in
the wiring suite stay green unmodified.

## Closing the line

**Landed** (Task 4 doc-sync). The doc-sync task DECLARES the store-decomposition line closed and
moves the two remaining items to CLAUDE.md's dormant-until-trigger
list (the meta-review precedent):

- **Reactive-`Writable` unification** — trigger: a view-layer round
  that needs the store surface reshaped.
- **`_iceTimings`/`_sdpDataAggregates` forensic fold** — trigger:
  observed friction from the composite keys (two rounds of moves
  produced none).

No standing loop remains; further decomposition happens only when
feature traffic demands it.

## Testing and enforcement

Identical regime to rounds one–three: verbatim moves/splits under
substitution tables; per-task origin diffs by independent reviewers;
wiring/intent/construction/settings-path/peer-record suites green
UNMODIFIED (the wiring suite's presence, carrier-hold, sounds, and
symmetry tests drive this surface through the store, which delegates);
per-task repo-wide reference greps; `presence-loop.ts` joins
`no-ambient-clock.test.ts` `PINNED_FILES` with `FULL_PATTERNS`; gate
`nix develop -c npm run verify` green before every commit claim
(unsandboxed — the `.gitmodules` gotcha); zero declared behavior
changes is the definition of done.

## Task plan

1. **Landed** (`2805192`, fixup `9b9580d`). PresenceLoop A — state +
   roster fragments (`_applyPingRosterSweep`, `_applyPongRoster`,
   forensics, sounds) + the `Writable` getters.
2. **Landed** (`3def783`). PresenceLoop B — the `pingAgents` pipeline +
   `_sendPings` + start()-side tick-arming behind owner methods (NOT
   `handlePingUi`'s presence half — amended at plan time, see Part 1
   above: `handlePingUi` moves nothing).
3. **Landed** (`aab830a`, fixup `2765dfe`). Composition-root split
   (`start()`/`disconnect()` phases).
4. **Landed** (prose-fix commit `8d6c315`, plus this doc-sync). Doc-sync
   + closing declaration (CLAUDE.md bullet per its contract; dormant
   list entries; spec/plan markers; Status line).

Process: `superpowers:writing-plans` →
`superpowers:subagent-driven-development`, worktree
`.claude/worktrees/presence-loop`.

## Risks (named)

- **Derived-store construction order** — the derived definitions read
  the delegating getters at constructor time; `presenceLoop` must be
  constructed before them (the gate's construction test catches a
  miss).
- **The C1 ordering invariant** — forensics before the roster-merge
  write; the comment travels and the reviewer re-checks the order in
  the owner pipeline.
- **Tick-arming ownership** — the interval stays armed by the root
  phase; an owner that arms its own interval would double-fire (the
  wiring suite's tick tests are the canary).

## Definition of done

`PresenceLoop` owns presence state/behavior with the store delegating;
`start()`/`disconnect()` are named-phase pipelines; round one–three
owner files untouched; `verify` green, zero declared behavior changes;
adversarial review clean per task plus final whole-branch review;
doc-sync lands the closing declaration and dormant list.
