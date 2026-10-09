# UX backport to the Holochain 0.6 line: design spec

Written 2026-10-09. Branch `backport/ux-0.6` off `origin/main-0.6` at `9dfde3f`, in the worktree `.claude/worktrees/backport-0.6`. The plan is `docs/superpowers/plans/2026-10-09-ux-backport-0.6.md`.

Status: design approved in conversation. Not landed.

## Problem

`main-0.6` (Holochain 0.6, Moss 0.15, releases 0.14.x) last gained user-facing work in the intent-reconciliation round of 2026-09-01. Since then `main-0.7` landed several rounds that users of the 0.6 line never received. Three of them are UI-only and fit the 0.6 code as it stands.

## Decisions

Made in conversation on 2026-10-09.

1. Features in scope: share annotations, the circle-tile oval fix, and the UI-only variant of stable tile order.
2. The branch ends with a 0.14.12 release from `main-0.6`, including the curation entry.
3. Out of scope, with the reason for each:
   - The peer-tile state round. It builds on `PeerRecord` and the store-decomposition line, which `main-0.6` closed out as 0.7-only (`9dfde3f`), and it adds a conversation-payload field. It is a later round of its own, not a backport.
   - The zome half of stable tile order. On 0.6 it is a declared happ change and a separate install for every 0.14.x user.
   - The muted-peer meter fix (`da9bc85`). It repairs a regression the peer-tile round introduced. The 0.6 meter never had it.
   - System audio and transcription. They need Moss host seams that exist only in `@theweave/api` 0.7.x. The 0.6 line is on `^0.6.9`.
   - Dead-track escalation and the SDP backstop rework. They are connection logic, not UX, and they build on `PeerRecord` and `MediaLinks`.
4. Provenance: each feature arrives by `git cherry-pick -x` of its 0.7 code commits where they apply, and by hand where 0.6 diverged, so every commit names its source. The 0.7 docs commits are not picked. The 0.6 `CLAUDE.md` gets one backport fact bullet.

## Baseline

The worktree gets its own `npm ci`. `nix develop -c npm run verify` must be green at `9dfde3f` before any change, so a later red test is attributable. The 0.6 gate is the `ui` and `packages/webrtc-peer` unit suites plus their typechecks. It has no signals-media workspace and no drift script.

## Share annotations

Source: the 0.7 round in `docs/superpowers/specs/2026-10-09-screen-share-annotations-design.md` (on `main-0.7`), code commits `216f848` through `c2acd30` (nine commits, listed in the plan).

Fit on 0.6: the three store and room-view regions the round touches (`activateModule`, the method after `updateModuleState`, and the share-panel tile template plus the join-time activation) are identical between the lines. The module files differ by one import. Every test fixture the round's suites use exists on 0.6 (`makeStarted`, `knownFresh`, `ManualClock.advance`, the jsdom pragma, the inlined packages). Expected hand merges: the `PINNED_FILES` list in `no-ambient-clock.test.ts`, which on 0.6 ends at `capture-reconciler.ts`, and the import block of the wiring suite.

One check at execution: 0.6's `.maximize-icon` rule is at `bottom: 5px; left: 5px` (room-view.ts, the rule near line 3918). The strip offset and its paired pins carry over unchanged if it still is.

Behavior on 0.6 is the 0.7 behavior. The payload cap is 4096 bytes.

## Circle-tile oval fix

Source: `24ecce8` on `main-0.7`. One rule, `min-height: 0` on `.video-container`, with a comment that explains the css-sizing rule it defeats. A layout-harness case and a Playwright pin (`circle tile stays 1:1`) come with it.

Fit on 0.6: the `.video-container` block with `aspect-ratio: 1 / 1` is on 0.6 verbatim, and 0.6 has `ui/harness/layout-harness.ts` and `layout.spec.ts`. The pick drops the commit's `CLAUDE.md` hunk. The pin runs under `npm run test:layout`, which is not part of `verify`. The plan runs it once if Playwright browsers are installed, and otherwise declares the pin ported and unrun.

## Stable tile order, UI only

Source: the `tile-order-policy.ts` module and its table test from `56eb42a` on `main-0.7`, and the room-view change to one `repeat()`. The room-store, room-client, types and zome parts of that round are not ported.

Design: `ui/src/room/tile-order-policy.ts` is copied unchanged. Its `joinedAt` input exists so the function stays identical to 0.7's, and on this line the caller always passes an empty map. Room-view gains `_orderedTiles()`, which calls `orderTiles` over `_visiblePeers()`, `phantomAgents()` and `{}`. The inline peer-tile template inside the grid `repeat()` moves into `_renderPeerTile(pubkey)` with its body unchanged. `_renderPhantomTiles()` becomes `_renderPhantomTile(pubkey)`, one tile. The grid renders both kinds through one `repeat()` keyed by pubkey in `orderTiles` order. The count authorities (`_tileCount`, `countAudiblePeers`) and their source pins in `view-count-authorities.test.ts` do not change.

Declared behavior change: tiles sort lexically by pubkey. The order is stable and the same on every screen, and it is arbitrary. Before this change, present tiles rendered in `_knownAgents` insertion order with phantoms appended, so a peer crossing present and phantom, or ping-fresh and media-only, moved to the tail and back. The 0.7 line sorts by the stored join time instead. The two lines agree on stability and disagree on seating.

## Release 0.14.12

The ceremony in the 0.6 line's `docs/RELEASING.md`, run from the worktree after the merge into `main-0.6`:

- A point release. The happ must stay byte-identical to the shipped `ae12f592…` (0.14.8 through 0.14.11). If `npm run package:ui` repacks a different happ, the recovery is the one that document describes: unpack the v0.14.11 asset, restore its happ and dna over the workdir files, and pack without `--recursive`.
- The hash triple is the raw sha256 of the asset and of its members after `hc web-app unpack`, never the weave CLI's `happSha256`, which is version-dependent on this line.
- The release notes open with a Compatibility section: same happ, same DNA, same network. Wire: no new signal type and no capability. Two additive payloads ride the existing module-state signal, a new `annotations` module and an `annotationsEpoch` field on share payloads. A peer on 0.14.8 through 0.14.11 stores both and ignores them. The compat fixture diff against 0.14.11 is version and provenance only.
- The curation entry goes into the Presence `0.14.x` block of `0.15/modify/tool-list-0.15.ts` in `weave-tool-curation`, regenerated with `npm run write-lists` in `0.15/`, on a branch off `origin/main`, as a PR. The changelog carries no in-place-update sentence.

## Testing and enforcement

- The 0.6 gate, `nix develop -c npm run verify`, green after every task.
- The annotation suites as they exist on 0.7: `annotation-geometry`, `annotation-policy`, `annotations-overlay-render`, `shared-panel-overlays`, the two `share annotations` blocks of the wiring suite, the overlay block of `view-teardown-symmetry`, and the three pinned files in `no-ambient-clock`.
- `tile-order-policy.test.ts` with its source pin that room-view renders the grid through `orderTiles` and keeps no separate phantom block, plus `view-count-authorities.test.ts` unchanged and green.
- The Playwright `circle tile stays 1:1` case, run once if browsers are available.
- `ui/src/__tests__/intent-write-sites.test.ts` and `claude-md-drift.test.ts` unchanged and green.
- The two-machine drawing check over a real network stays owner-run, as on 0.7.

## Definition of done

- Every feature in decision 1 is on `backport/ux-0.6` with its tests green under `verify`.
- `CLAUDE.md` on the branch carries one backport fact bullet. It names the three features, their source commits on `main-0.7`, the declared tile-order behavior change, and the exclusions with reasons.
- The branch is merged `--no-ff` into `main-0.6` and pushed.
- v0.14.12 is released and recorded in `fixtures/releases.json`, and the curation PR is open.
- When the branch closes, each numbered decision above carries a landed or not-landed marker.
