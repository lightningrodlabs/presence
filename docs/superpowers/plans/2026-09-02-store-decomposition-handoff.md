# Handoff: streams-store decomposition round (PeerLink first)

**Status: HISTORICAL** — round one (the per-peer consolidation this doc
commissions) landed 2026-09-03 on `main-0.7`, merged `--no-ff` as
`593e34a`, built directly on `main-0.7` by user decision (2026-09-02),
superseding this doc's 0.6-first branch practice; any `main-0.6`
backport is a separate later decision. The record type shipped as
`PeerRecord` (not `PeerLink` — name collision with the wire-carried
`PeerLinkSnapshot`). The living authorities are
`docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md`
and `docs/superpowers/plans/2026-09-02-peer-record-consolidation.md`
(both on `main-0.7`), whose "Next steps" section carries round two (the
concern extraction) and the optional forensic fold.

**For a fresh session (fable) picking up the store-size / comprehensibility problem.** This is a pre-plan brief, not a plan. Your first action is to brainstorm and scope, then write a plan, then execute it subagent-driven. Do not start cutting the file.

Written 2026-09-02 by the session that landed the intent-reconciliation round. This doc is self-contained; you do not need that session's transcript.

## The one-sentence task

`ui/src/streams-store.ts` is a 7,013-line god-object whose real problem is not its length but that "the state of one peer" is smeared across ~19 separately-keyed collections that every method mutates by hand. Consolidate that per-peer state into one `Map<AgentPubKeyB64, PeerLink>` record **first** (the enabler), then lift the concern clusters out into owner objects. This round is step 1 (+ possibly the first extraction); the file split is a *consequence* of the extraction, never its own task.

## Why PeerLink before any file split (the load-bearing insight — do not skip)

The instinct is to split the 7k-line file by concern (screen-share, presence loop, diagnostics, signals media). That is the wrong first move and makes things worse. Every one of those concerns reaches into the same ~19 per-peer collections. Split first and you get five files sharing a god-object — the coupling goes from co-located (bad) to invisible-across-file-boundaries (worse), and an agent still can't reason about a peer's lifecycle without loading all five.

Collapse the collections into one typed `PeerLink` first and two things become true that aren't now:
1. The entire per-peer state is one type definition an agent can hold in its head.
2. Teardown becomes `map.delete(key)` + declared survivors — retiring most of the `closeCleanupPlan` table (`ui/src/transport/close-cleanup-policy.ts`).

*Then* concern boundaries are drawable, because a concern owns fields on `PeerLink` instead of scattered globals, and each concern can be lifted into an owner object. Size reduction is the by-product of fixing the coupling, not the goal.

## Current state (verified 2026-09-02)

- Branches (both pushed, both carry the just-landed intent-reconciliation round; the round shipped on 0.7 in **v0.15.5**):
  - `main-0.6` @ `3eee500` (the shipping line; develop here first).
  - `main-0.7` @ `cd60a69` (0.7 upgrade line; forward-port target). The two lines' `ui/src` is nearly in lockstep — 0.7's divergence is DNA/tryorama/release work, not UI. Do this round 0.6-first then forward-port, **soon**, before 0.7's UI diverges.
- `ui/src/streams-store.ts`: **7,013 lines, ~193 methods**. (The intent round grew it ~110 lines net — only its reconciler task was constrained net-negative. This is the reason the problem is still open.)
- **~19 per-peer-keyed collections** to fold into `PeerLink` (verify each key type yourself — some are `Map<string,…>` where the string needs confirming as a pubkey vs a connectionId vs a composite):
  - 12 `Record<AgentPubKeyB64, …>`: `_connectionEpoch`, `_iceDisconnectedAt`, `_lastBytesReceived`, `_lastDisconnectTime`, `_lastReconcileTime`, `_pendingInits`, `_reconcileAttemptCount`, `_screenShareIceDisconnectedAt`, `_screenShareStreams`, `_sdpTimeoutTimers`, `_staleCycles`, `_videoStreams`.
  - 7 per-peer `Map`s: `_lastWebrtcExitReason` (keyed `AgentPubKeyB64`), `_lastQualityBucket`, `_outageStates`, `_peerAnalysers`, `_peerAnalyserBuffers`, `_sdpDataAggregates`, `_signalsRttEwma` (these six are `Map<string,…>` — confirm the string is a pubkey before folding).
- **Do NOT fold these two** — they are aggregate membership sets, not per-peer rows: `_conversationParticipants = Set<AgentPubKeyB64>` and `_lastPresenceSet = Set<AgentPubKeyB64>`. Flag any others like them during scoping.
- Also note the Svelte-store per-peer fields (`_openConnections`, `_screenShareConnectionsIncoming/Outgoing`, `_othersConnectionStatuses`, etc.) — these are reactive `Writable`s the view subscribes to, so `PeerLink` must either coexist with them or be designed to drive them. This is a real scoping decision (see below).

## What to resolve in brainstorming (scope decisions, not yet answers)

1. **PeerLink shape.** Which of the ~19 collections are genuinely one-row-per-peer with the same lifecycle (create on first contact, delete on leave)? Which have a *different* lifecycle (e.g. `_lastDisconnectTime` deliberately survives a close for retry-gap semantics — see the §9 facts in CLAUDE.md) and must be modeled as explicit survivors, not naive deletes?
2. **Reactivity.** Does `PeerLink` replace the reactive `Writable` per-peer stores the view reads, or sit beside them as the non-reactive bookkeeping half? Replacing them is cleaner but touches the view; coexisting is lower-risk for round one. Decide and declare.
3. **Round size.** Round one is almost certainly *just* the PeerLink consolidation + retiring the `closeCleanupPlan` rows it subsumes — NOT any concern extraction. The extraction is round two. Confirm that boundary; one intent per branch (working agreement 6).
4. **This is a pure refactor — no behavior change.** That inverts the review question from "does this do the right thing" to "prove this changed nothing." The wiring suite (`streams-store-wiring.test.ts`) and construction suite (`streams-store-construction.test.ts`) are the safety net; every step keeps `verify` green with zero declared behavior changes.

## Templates that already exist in this repo (copy these)

- **Owner-object with injected bindings** (the extraction target pattern): `ui/src/capture-reconciler.ts` (newest, from the intent round), `ui/src/mic-source.ts` / `ui/src/camera-source.ts`, `ui/src/room-ownership.ts`. Each holds state + takes a `{clock, …}` bindings record; the store keeps only construction + a few delegating calls.
- **Pure decision function + table tests** (the unit of change): `ui/src/transport/media-event-policy.ts` is the canonical template.
- **Plan document structure**: `docs/superpowers/plans/2026-09-01-intent-reconciliation.md` (the round this handoff follows) is a good structural model — Global Constraints, per-task Files/Interfaces/Steps, "Deliberately out of scope", "Notes for reviewers". Its "Deliberately out of scope" bullet is where this store-split was first deferred with the reasoning above.

## Process and repo constraints you must follow

- **Workflow**: `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development` (fresh subagent per task, independent adversarial review per task by a session that did not write it — working agreement 9, final whole-branch review). This is how the intent round caught four real defects passing tests missed. Use an isolated worktree (`EnterWorktree`).
- **Gate**: `nix develop -c npm run verify` (both workspaces' unit suites + `tsc --noEmit` of both, at `strict` + `noUnusedLocals`/`noUnusedParameters`). Must be green before every commit claim.
- **Commits/PRs**: no Claude co-authored footer; no emotional phrasing (see `CLAUDE.md` top + project `CLAUDE.md`).
- **CLAUDE.md "True today" contract**: records anchored to a merge; present-tense claims only where they name the enforcing file/test; banned — test/line counts (enforced by `ui/src/__tests__/claude-md-drift.test.ts`), repo-state snapshots without a check procedure, unanchored negations. The closing doc-sync task updates it.
- **Branch practice**: develop 0.6-first, land on `main-0.6`, forward-port to `main-0.7` (cherry-pick the round's commits onto a branch off `main-0.7`; the UI base is near-identical so it applies clean). Do NOT `git merge main-0.6 into main-0.7` — it drags 0.6-only release commits and duplicate-content conflicts.

## Environment gotchas (will waste your time otherwise)

- **Sandbox breaks `nix`**: this repo's worktrees have `.gitmodules` mapped to a `/dev/null` char device under the sandbox, so `nix develop` fails to launch with a "`.gitmodules` … locked: Permission denied" error AND exits 0 (masking the failure). Run every `nix develop -c …` command with `dangerouslyDisableSandbox: true`. A "green" verify that shows the `.gitmodules` error instead of test summaries did NOT run.
- **Test runner**: use `nix develop -c npm run test -w ui -- <path>` for a focused ui test (ui workspace vitest 1.6.1). `npx vitest` resolves the wrong root version and errors on collect.
- **Node version differs across lines**: `main-0.6` devshell is node 20, `main-0.7` is node 22. Node 22 makes some globals getter-only (e.g. `navigator`) — a forward-ported test that assigns `globalThis.navigator = …` throws there; use `Object.defineProperty(globalThis, 'navigator', {value, configurable:true})`. (This exact issue was already fixed in both lines' capture tests, but watch for the class of problem.)
- **Shared working tree**: `git add -A` in a shared checkout has swept concurrent sessions' edits into commits here before (recorded process lesson). Stage explicit paths.

## Definition of done for round one

`PeerLink` is the one per-peer state record; the folded collections are deleted (not paralleled); `closeCleanupPlan` shrinks to the survivors that genuinely outlive a close; `verify` green with zero declared behavior changes; `streams-store.ts` is net-negative; adversarial review clean; doc-sync updates `CLAUDE.md` and this plan. The file split itself is explicitly out of scope for round one and named as round two.
