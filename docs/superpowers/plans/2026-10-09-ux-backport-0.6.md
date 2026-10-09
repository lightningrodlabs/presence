# UX Backport to main-0.6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring share annotations, the circle-tile oval fix and a UI-only stable tile order from `main-0.7` to `main-0.6`, and release the result as 0.14.12.

**Architecture:** Each feature arrives by `git cherry-pick -x` of its 0.7 code commits where they apply and by hand where 0.6 diverged. The annotations round picks nine commits with two expected hand merges. The oval fix picks one commit. Stable tile order copies the pure policy and refactors room-view's grid onto one ordered `repeat()`, with an always-empty join-time map because the zome half stays on 0.7.

**Tech Stack:** TypeScript, Lit, Svelte stores, vitest 1.6 (node and per-file jsdom), Playwright for the layout pin, the 0.6 line's nix devshell, `hc` and `gh` for the release, the `weave-tool-curation` repo for the curation entry.

**Spec:** `docs/superpowers/specs/2026-10-09-ux-backport-0.6-design.md`

## Global Constraints

- Work in the worktree `/home/eric/code/metacurrency/holochain/presence/.claude/worktrees/backport-0.6` on branch `backport/ux-0.6` (off `origin/main-0.6` at `9dfde3f`). The primary checkout is on `main-0.7`. Never run commands against it for this plan.
- The 0.7 source commits are read from the same repository (`git show <sha>:<path>` and `git cherry-pick -x <sha>` work from the worktree, since worktrees share the object store).
- Run every build, test and nix command through `nix develop -c`. On this machine `nix develop` fails inside the bash sandbox (a locked `.gitmodules` mount) and must be run with the sandbox disabled. Run vitest from `ui/` inside the worktree (`cd ui && nix develop -c npx vitest run src/__tests__/<file>`), never with `--root`.
- The 0.6 gate is `nix develop -c npm run verify` from the worktree root: the `ui` and `packages/webrtc-peer` unit suites and typechecks. There is no signals-media workspace on this line.
- Commit messages carry no co-author footer and no Claude attribution. Cherry-picks use `-x` so the message ends with the source commit line. Hand-written commits name their source sha in the subject or body.
- Use explicit `git add <paths>`; never `git add -A`.
- `ui/src/__tests__/intent-write-sites.test.ts`, `view-count-authorities.test.ts` and `claude-md-drift.test.ts` stay byte-identical and green.
- Constants from the annotations round: `ANNOTATION_GRID` 10000, `MAX_STROKE_POINTS` 200, `MAX_BOARD_STROKES` 50, `MAX_ANNOTATIONS_PAYLOAD_BYTES` 4096, `MIN_POINT_SPACING` 40. The tool strip is at `bottom: 10px; left: 55px`.
- The release is a point release: the shipped happ `ae12f5923442acfe498243d5a74333a7f018609d514231f43b8ec0c471743ea8` must be byte-identical inside the new webhapp.

## Review Focus

1. A cherry-pick that "applies" but lands a hunk in the wrong place in the 4,000-line 0.6 `streams-store.ts` or `room-view.ts`. Task 1 pins this with the full wiring and render suites and a grep that each inserted symbol appears exactly once.
2. A 0.14.11 peer receiving the new `annotations` module state or the `annotationsEpoch` field. 0.6's `handleModuleState` and pong sweep store unknown module ids and tolerate extra payload fields. Task 1 adds a wiring row that delivers an `annotations` envelope to a started store with no `annotations` module registered and asserts it is stored and nothing throws.
3. The tile-order refactor moving the peer-tile template and losing a binding or a closure variable in the move. Task 3 keeps the body verbatim, runs the full ui suite, and the source pin plus `view-count-authorities` stay green.
4. A room where every peer is a phantom, or none is. Task 3's table rows for `orderTiles` cover both, and the render path is the same one `repeat()` for both kinds.
5. The release gate tripping on a repacked happ. Task 5 carries the recovery procedure and verifies the happ inside the downloaded asset, not only the standalone file.

---

### Task 0: Baseline

**Files:**
- None changed. Establishes the worktree's dependencies and a green gate.

- [ ] **Step 1: Install dependencies in the worktree**

Run from the worktree root: `nix develop -c npm ci`
Expected: completes. `ui/node_modules` and the root `node_modules` exist in the worktree.

- [ ] **Step 2: Run the gate at the baseline**

Run: `nix develop -c npm run verify`
Expected: exit 0. Record the final summary lines in the report. If it is red at `9dfde3f`, stop and report BLOCKED with the output. Nothing in this plan starts on a red baseline.

- [ ] **Step 3: Confirm the seams the picks expect**

Run from the worktree root:

```bash
grep -n "async activateModule(\|async updateModuleState(" ui/src/streams-store.ts
grep -n "activateModule('reactions')\|\${diagnosticsOverlay}" ui/src/room/room-view.ts
grep -n "bottom: 5px;\|left: 5px;" ui/src/room/room-view.ts
grep -n "capture-reconciler.ts" ui/src/__tests__/no-ambient-clock.test.ts
```

Expected: each pattern found once (the `bottom`/`left` pair sits in the `.maximize-icon` rule). Record the line numbers in the report; Task 1 reads them.

---

### Task 1: Share annotations

**Files:**
- Create (by cherry-pick): `ui/src/room/annotation-geometry.ts`, `ui/src/room/annotation-policy.ts`, `ui/src/room/modules/annotations.ts`, `ui/src/__tests__/annotation-geometry.test.ts`, `ui/src/__tests__/annotation-policy.test.ts`, `ui/src/__tests__/annotations-overlay-render.test.ts`, `ui/src/__tests__/shared-panel-overlays.test.ts`
- Modify (by cherry-pick): `ui/src/room/modules/types.ts`, `ui/src/room/modules/screen-share.ts`, `ui/src/room/modules/index.ts`, `ui/src/streams-store.ts`, `ui/src/room/room-view.ts`, `ui/src/__tests__/streams-store-wiring.test.ts`, `ui/src/__tests__/view-teardown-symmetry.test.ts`, `ui/src/__tests__/no-ambient-clock.test.ts`
- Modify (by hand): `ui/src/__tests__/streams-store-wiring.test.ts` (one new row, Review Focus 2)

**Interfaces:**
- Consumes: 0.6's `activateModule`, `updateModuleState`, `renderSharedPanel`, `getAllModules`, `ModuleDefinition`.
- Produces: everything the 0.7 round exports, unchanged: `orderTiles` is NOT part of this task. `StreamsStore.clearShareAnnotations(shareModuleId)`, `ModuleDefinition.shareOverlayElement`, `ModuleDefinition.annotationSurface`, the `annotations` module, the overlay tag `module-annotations-share-overlay`.

- [ ] **Step 1: Cherry-pick the nine code commits in order**

Run from the worktree root, one at a time, and stop at the first conflict:

```bash
for c in 216f848 cbf89ab 356cce2 8e84c8a 7965bd5 290b935 4350c95 3b88fdc c2acd30; do
  git cherry-pick -x $c || break
done
```

Expected conflicts and their resolutions:

- `ui/src/__tests__/no-ambient-clock.test.ts` (in `216f848`, `cbf89ab`, `7965bd5`): 0.6's `PINNED_FILES` ends at the `capture-reconciler.ts` entry. Keep every 0.6 entry and append the picked entry after the last one. The three entries after all picks:

```ts
  // Share annotations (spec 2026-10-09): pure geometry, no time at all,
  // pinned per the owner pattern.
  { relPath: '../room/annotation-geometry.ts', patterns: FULL_PATTERNS },
  { relPath: '../room/annotation-policy.ts', patterns: FULL_PATTERNS },
  // The overlay element: the stroke id reads the store's injected clock.
  { relPath: '../room/modules/annotations.ts', patterns: FULL_PATTERNS },
```

- `ui/src/__tests__/streams-store-wiring.test.ts` (in `8e84c8a` and `4350c95`): the import hunk. 0.6's import block has no `SDP_BACKSTOP_CEILING_MS` and no `SIGNALS_LEVEL_HOLD_MS`. Keep 0.6's imports and add only the picked `annotation-policy` import block and the three side-effect imports (`../room/modules/wal`, `../room/modules/raise-hand`, `../room/modules/screen-share`) with their comment. The appended describe blocks go at the end of the file. After resolving, run the TypeScript parser on the file before continuing (a merge that drops a closing `});` at the seam has happened on this repo):

```bash
cd ui && node -e "const ts=require('typescript'),fs=require('fs');const f='src/__tests__/streams-store-wiring.test.ts';const sf=ts.createSourceFile(f,fs.readFileSync(f,'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);console.log('syntax diagnostics:',(sf.parseDiagnostics||[]).length)"
```

Expected: `syntax diagnostics: 0`.

- `ui/src/room/room-view.ts` (in `4350c95`): if the `_renderShareOverlays` method or the activation line lands with a conflict, place the method immediately before `renderSharedPanel()` and the activation line immediately after `this.streamsStore.activateModule('reactions');`, exactly as the 0.7 commit shows (`git show 4350c95 -- ui/src/room/room-view.ts`).
- `ui/src/streams-store.ts` (in `8e84c8a`): the two hunks are inside `activateModule` and right after `updateModuleState`. If git offsets them, verify by reading the result; the import goes with the other `./room/` imports.

After each resolution: `git add <the resolved files>` and `git cherry-pick --continue`. Do not edit the commit message.

- [ ] **Step 2: Verify the picks landed once each**

Run from the worktree root:

```bash
grep -c "stampShareAnnotationsEpoch(actualPayload" ui/src/streams-store.ts
grep -c "async clearShareAnnotations(" ui/src/streams-store.ts
grep -c "_renderShareOverlays(" ui/src/room/room-view.ts
grep -c "activateModule('annotations')" ui/src/room/room-view.ts
grep -c "annotationSurface: 'contained-video'" ui/src/room/modules/screen-share.ts
grep -c "import './annotations';" ui/src/room/modules/index.ts
```

Expected: `1`, `1`, `2` (declaration and call), `1`, `1`, `1`.

- [ ] **Step 3: Run the round's suites**

Run from `ui/`:

```bash
nix develop -c npx vitest run src/__tests__/annotation-geometry.test.ts src/__tests__/annotation-policy.test.ts src/__tests__/annotations-overlay-render.test.ts src/__tests__/shared-panel-overlays.test.ts src/__tests__/view-teardown-symmetry.test.ts src/__tests__/no-ambient-clock.test.ts src/__tests__/streams-store-wiring.test.ts
```

Expected: PASS. If `shared-panel-overlays.test.ts` fails because 0.6's `renderSharedPanel` or `_tileCount` reads a store field the fake lacks, add that field to the fake store in the test (as `writable({})` or a plain value) and say so in the report. Never change the production read.

If the `.maximize-icon` pin in `shared-panel-overlays.test.ts` fails, 0.6's icon is not at `bottom: 5px; left: 5px`. Stop and report NEEDS_CONTEXT with the rule's actual values; the strip offset is a controller ruling.

- [ ] **Step 4: Write the failing interop row (Review Focus 2)**

Append inside the `share annotations: the wire round trip` describe block in `ui/src/__tests__/streams-store-wiring.test.ts`:

```ts
  it('a peer on a build with no annotations module (0.14.8-0.14.11) stores the envelope and ignores it', async () => {
    // This suite registers wal, raise-hand and screen-share only, so the
    // started store has no `annotations` module — exactly a 0.14.11 peer.
    const { store, bus, clock } = makeStarted();
    const envelope = {
      moduleId: ANNOTATIONS_MODULE_ID,
      active: true,
      payload: JSON.stringify(applyStroke(emptyAnnotations(), peerB, 'screen-share', { id: 's', epoch: 1, color: 0, pts: [0, 0, 10, 10] })),
      updatedAt: clock.now(),
    };
    await expect(bus.deliver(message(peerAKey, 'ModuleState', JSON.stringify(envelope)))).resolves.toBeUndefined();
    expect(get(store._peerModuleStates)[peerA]?.[ANNOTATIONS_MODULE_ID]?.payload).toBe(envelope.payload);
    // A share payload with the new field parses as before for the share module.
    await bus.deliver(message(peerAKey, 'ModuleState', JSON.stringify({ moduleId: 'screen-share', active: true, payload: JSON.stringify({ annotationsEpoch: 5 }), updatedAt: clock.now() })));
    expect(get(store._peerModuleStates)[peerA]?.['screen-share']?.active).toBe(true);
  });
```

Run: `cd ui && nix develop -c npx vitest run src/__tests__/streams-store-wiring.test.ts -t "no annotations module"`
Expected: PASS on the first run. This row pins existing behavior (the store is module-agnostic on receive); there is no implementation step. If it fails, the 0.6 store rejects unknown modules and the task is BLOCKED: report the failure.

- [ ] **Step 5: Full suite and typecheck**

Run: `nix develop -c npm run verify` from the worktree root.
Expected: exit 0.

- [ ] **Step 6: Commit the interop row**

```bash
git add ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "test(annotations): a peer without the module stores the envelope and ignores it (0.14.x interop)"
```

---

### Task 2: Circle-tile oval fix

**Files:**
- Modify (by cherry-pick): `ui/src/room/room-view.ts`, `ui/harness/layout-harness.ts`, `ui/harness/layout.spec.ts`, `ui/harness/README.md`
- Not taken: the commit's `CLAUDE.md` hunk.

- [ ] **Step 1: Cherry-pick**

Run: `git cherry-pick -x 24ecce8`

Expected conflict: `CLAUDE.md`. Resolve by taking 0.6's version unchanged (`git checkout --ours CLAUDE.md` during the pick, then `git add CLAUDE.md`). The 0.6 bullet comes in Task 4. If `ui/harness/layout-harness.ts` conflicts, keep both sides' cases: the harness on 0.6 lacks the peer-tile state walk that 0.7 added later, so only the `circle tile stays 1:1` case and its helpers are needed; drop any hunk that references `describePeerTile` or `peerTileFor`.

- [ ] **Step 2: Check the rule landed**

Run: `grep -n "min-height: 0;" ui/src/room/room-view.ts`
Expected: one hit inside the `.video-container` block that also holds `aspect-ratio: 1 / 1`.

- [ ] **Step 3: Run the layout pin if browsers are present**

Run from `ui/`: `nix develop -c npx playwright test layout -g "circle tile stays 1:1" 2>&1 | tail -5`
Expected: PASS, or a message that no browser is installed. In the second case do not install browsers; write "pin ported, not run: no Playwright browser in this environment" in the report.

- [ ] **Step 4: Gate**

Run: `nix develop -c npm run verify` from the worktree root.
Expected: exit 0.

---

### Task 3: Stable tile order, UI only

**Files:**
- Create: `ui/src/room/tile-order-policy.ts` (copied from `main-0.7`), `ui/src/__tests__/tile-order-policy.test.ts` (copied from `main-0.7`)
- Modify: `ui/src/room/room-view.ts`
- Test: `ui/src/__tests__/view-count-authorities.test.ts` (run only, unchanged)

**Interfaces:**
- Consumes: `room-view.ts`'s `_visiblePeers(): AgentPubKeyB64[]`, `this.streamsStore.phantomAgents(): AgentPubKeyB64[]`, the inline peer-tile template inside the grid `repeat()` (the block that starts at the comment `<!-- Panes for visible peers: presence-fresh OR media-live`), and `_renderPhantomTiles()`.
- Produces: `orderTiles(s: TileOrderSnapshot): OrderedTile[]` and the types `TileOrderSnapshot`, `OrderedTile` from `ui/src/room/tile-order-policy.ts`; room-view's private `_orderedTiles(): OrderedTile[]`, `_renderPeerTile(pubkeyB64)` and `_renderPhantomTile(pubkeyB64)`.

- [ ] **Step 1: Copy the policy and its test from main-0.7**

Run from the worktree root:

```bash
git show origin/main-0.7:ui/src/room/tile-order-policy.ts > ui/src/room/tile-order-policy.ts
git show origin/main-0.7:ui/src/__tests__/tile-order-policy.test.ts > ui/src/__tests__/tile-order-policy.test.ts
```

Then edit the header comment of `ui/src/room/tile-order-policy.ts`. After the sentence that ends `the room keeps the same seating across calls.` add one paragraph:

```ts
 *
 * On the Holochain 0.6 line (main-0.6) the zome does not expose join
 * times, so room-view passes an empty `joinedAt` and every tile sorts
 * lexically by pubkey: stable and the same on every screen, but not join
 * order. The function is kept identical to main-0.7's so the two lines
 * share one authority. Declared behavior change of the 2026-10-09
 * UX backport (docs/superpowers/specs/2026-10-09-ux-backport-0.6-design.md).
```

- [ ] **Step 2: Run the test to see the source pin fail**

Run: `cd ui && nix develop -c npx vitest run src/__tests__/tile-order-policy.test.ts`
Expected: the `orderTiles` table rows PASS; the `room-view renders the grid through orderTiles` row FAILS (room-view has no `orderTiles({` yet).

- [ ] **Step 3: Add the import and `_orderedTiles` to room-view**

In `ui/src/room/room-view.ts`, add to the imports (beside the other `./` imports):

```ts
import { orderTiles } from './tile-order-policy';
import type { OrderedTile } from './tile-order-policy';
```

Add immediately after the `_visiblePeers()` method:

```ts
  /**
   * The grid's tiles in render order — `orderTiles` (room/tile-order-policy.ts)
   * over the present set and the phantom set. This line has no stored join
   * time (the zome half of stable tile order is main-0.7 only), so the
   * join map is empty and every tile sorts by pubkey: stable across screens
   * and across present/phantom flips, not join order. Declared in
   * docs/superpowers/specs/2026-10-09-ux-backport-0.6-design.md.
   */
  private _orderedTiles(): OrderedTile[] {
    return orderTiles({
      present: this._visiblePeers(),
      phantoms: this.streamsStore.phantomAgents(),
      joinedAt: {},
    });
  }
```

- [ ] **Step 4: Extract `_renderPeerTile` and `_renderPhantomTile`, render one repeat**

In `render()`, the grid currently holds:

```ts
        <!-- Panes for visible peers: presence-fresh OR media-live (a stale
             signaling pong must not drop a tile whose media still flows). -->
        ${repeat(
          this._visiblePeers(),
          (pubkeyB64) => pubkeyB64,
          (pubkeyB64) => {
            ...the peer-tile template body...
          }
        )}
        ${this._renderPhantomTiles()}
```

Do this:

1. Create a private method `_renderPeerTile(pubkeyB64: AgentPubKeyB64)` right before `render()`. Move the whole arrow-function body `{ ...the peer-tile template body... }` into it verbatim: every `const`, the `moduleContext`, the avatar-visibility comment, and the returned `html` template. The body is long (about 320 lines); move it, do not retype it. The only edit inside the body is none; the parameter name stays `pubkeyB64`.
2. Rename `_renderPhantomTiles()` to `_renderPhantomTile(pk: AgentPubKeyB64)`. Remove its `phantoms` lookup, the empty-list early return and the outer `repeat(...)`. Its body becomes the per-tile arrow function's body (the `seeing`/`hearing` lookups and the returned template), with `pk` as the parameter. Keep the doc comment and change its first line to say it renders one placeholder tile.
3. Replace the grid block above with:

```ts
        <!-- Peer and phantom tiles: ONE repeat keyed by pubkey in orderTiles
             order (room/tile-order-policy.ts), so a peer keeps its slot
             across present/phantom and ping-fresh/media-only transitions.
             Membership is still the present predicate; on this line the
             order is lexical by pubkey (see _orderedTiles). -->
        ${repeat(
          this._orderedTiles(),
          tile => tile.pubkey,
          tile =>
            tile.kind === 'present'
              ? this._renderPeerTile(tile.pubkey)
              : this._renderPhantomTile(tile.pubkey)
        )}
```

4. Check nothing else called `_renderPhantomTiles()`: `grep -n "_renderPhantomTiles" ui/src/room/room-view.ts` must print nothing.

- [ ] **Step 5: Run the policy test, the count-authority pins and the typecheck**

Run from `ui/`: `nix develop -c npx vitest run src/__tests__/tile-order-policy.test.ts src/__tests__/view-count-authorities.test.ts src/__tests__/intent-diff-surfaces.test.ts src/__tests__/view-teardown-symmetry.test.ts && nix develop -c npm run typecheck`
Expected: PASS and no type errors. `noUnusedLocals` is on: if `_visiblePeers()` is now called only from `_orderedTiles` and `_tileCount`, that is fine; if the typecheck reports an unused local from the move, it is a variable the template body used that did not travel; put it back inside `_renderPeerTile`.

- [ ] **Step 6: Gate and commit**

Run: `nix develop -c npm run verify` from the worktree root.
Expected: exit 0.

```bash
git add ui/src/room/tile-order-policy.ts ui/src/__tests__/tile-order-policy.test.ts ui/src/room/room-view.ts
git commit -m "feat(room-view): stable tile order by pubkey — one repeat over orderTiles (UI half of main-0.7's 56eb42a)"
```

---

### Task 4: Docs: the 0.6 fact bullet and the spec markers

**Files:**
- Modify: `CLAUDE.md` (the worktree's 0.6 copy), `docs/superpowers/specs/2026-10-09-ux-backport-0.6-design.md`
- Test: `ui/src/__tests__/claude-md-drift.test.ts` (run only)

- [ ] **Step 1: Add the fact bullet**

In the worktree's `CLAUDE.md`, under "True today", insert after the bullet that begins `- **Intent-reconciliation round facts**` and before the bullet that begins `- \`nix develop -c npm run verify\` is the gate`:

```markdown
- **UX backport round facts** (landed 2026-10-09 on branch `backport/ux-0.6` off `main-0.6` @ `9dfde3f`; spec `docs/superpowers/specs/2026-10-09-ux-backport-0.6-design.md`, plan `docs/superpowers/plans/2026-10-09-ux-backport-0.6.md`; whether the branch has reached a given line is checked with `git merge-base --is-ancestor <branch tip> <line>`, never trusted from this line). Three UI-only changes from `main-0.7`, each cherry-picked with `-x` so its commits name the source. (1) Share annotations: the `main-0.7` round `216f848`..`c2acd30` (spec `2026-10-09-screen-share-annotations-design.md` on that line) — the `annotations` module (`ui/src/room/modules/annotations.ts`), `ui/src/room/annotation-policy.ts` as the ONE home of the payload and its bounds, `ui/src/room/annotation-geometry.ts` as the ONE surface mapping, the `shareOverlayElement`/`annotationSurface` aspects, `StreamsStore.activateModule` stamping `annotationsEpoch` on every share-type payload and `clearShareAnnotations`; the wiring suite registers `wal`/`raise-hand`/`screen-share` by side-effect import and carries a 0.14.x-interop row (a store with no `annotations` module stores the envelope and ignores it). (2) The circle-tile oval fix, `24ecce8`: `min-height: 0` on `.video-container`, Playwright pin `circle tile stays 1:1` under `test:layout`, not under `verify`. (3) Stable tile order, UI half of `56eb42a`: `orderTiles` (`ui/src/room/tile-order-policy.ts`, identical to `main-0.7`'s, table-pinned and source-pinned in `tile-order-policy.test.ts`) over ONE `repeat()` in room-view, with an EMPTY join map because this line's zome exposes no join time — declared behavior change: tiles sort lexically by pubkey, stable and the same on every screen, not join order; the previous order was `_knownAgents` insertion with phantoms appended. Not backported, with reasons in the spec: the peer-tile state round (`PeerRecord`), the zome half of tile order (happ change), the muted-peer meter fix (repairs a 0.7-only regression), system audio and transcription (`@theweave/api` 0.7 host seams), dead-track escalation and the backstop rework (connection logic on `PeerRecord`/`MediaLinks`). Released as v0.14.12 (see `fixtures/releases.json`).
```

The bullet carries no test count, line count or coverage number.

- [ ] **Step 2: Mark the spec**

In the spec, change the status line to `Status: landed on backport/ux-0.6 (see the commits in git log). Decisions 1-4 landed.` and append ` (landed)` to each numbered decision. If an implementation task deviated, write ` (landed with amendment: ...)` with one sentence.

- [ ] **Step 3: Drift test and gate**

Run from `ui/`: `nix develop -c npx vitest run src/__tests__/claude-md-drift.test.ts`, then from the root `nix develop -c npm run verify`.
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-09-ux-backport-0.6-design.md
git commit -m "docs(backport-0.6): spec markers and the CLAUDE.md fact bullet"
```

---

### Task 5: Merge, release 0.14.12, curation

This task runs after the final whole-branch review. It is the 0.6 line's ceremony (`docs/RELEASING.md` in the worktree), with the outward-facing steps in order. Every nix, `gh` and `git push` command needs the sandbox disabled on this machine.

**Files:**
- Modify: `ui/package.json`, `package-lock.json`, `fixtures/compat/0.14.12.json` (new), `fixtures/releases.json`
- External: `weave-tool-curation` at `/home/eric/code/metacurrency/holochain/weave-tool-curation`, files `0.15/modify/tool-list-0.15.ts` and `0.15/lists/tool-list-0.15.json`

- [ ] **Step 1: Merge the backport into main-0.6**

From the worktree: `git fetch origin && git merge-base --is-ancestor origin/main-0.6 HEAD && echo "trunk unchanged"`. If trunk moved, merge `origin/main-0.6` into the branch first, re-run `verify`, and commit that merge.

Then, from the PRIMARY checkout's parent directory, create a second worktree for trunk so `main-0.6` is never checked out in the primary (which stays on `main-0.7`):

```bash
cd /home/eric/code/metacurrency/holochain/presence
git worktree add .claude/worktrees/main-0.6 main-0.6
cd .claude/worktrees/main-0.6
git pull --ff-only origin main-0.6
git merge --no-ff backport/ux-0.6 -m "Merge backport/ux-0.6: share annotations, circle-tile oval fix, stable tile order by pubkey (UI-only backports from main-0.7)"
nix develop -c npm ci && nix develop -c npm run verify
```

Expected: verify exit 0 on the merged trunk. All later steps run in `.claude/worktrees/main-0.6`.

- [ ] **Step 2: Release branch, bump, fixture**

```bash
git checkout -b release/0.14.12 main-0.6
sed -i 's/"version": "0.14.11"/"version": "0.14.12"/' ui/package.json
nix develop -c npm install
cd ui && UPDATE_COMPAT_FIXTURE=1 nix develop -c npx vitest run src/transport/__tests__/compat-corpus.test.ts && cd ..
diff fixtures/compat/0.14.11.json fixtures/compat/0.14.12.json
```

Expected: the diff shows only the `version` and `source` lines. Anything else is an undeclared wire change: stop and report.

- [ ] **Step 3: Gate, commit, merge, tag**

```bash
nix develop -c npm run verify
git add ui/package.json package-lock.json fixtures/compat/0.14.12.json
git commit -m "release: 0.14.12 — version bump and compat-corpus fixture"
git checkout main-0.6 && git merge --no-ff release/0.14.12 -m "Merge branch 'release/0.14.12' into main-0.6"
git tag v0.14.12
```

- [ ] **Step 4: Build and the artifact gate**

```bash
unset ELECTRON_RUN_AS_NODE
nix develop -c npm run package:ui
sha256sum workdir/presence.happ
nix develop -c npm run release:check
```

Expected: `release:check OK — happ bytes identical to 0.14.11`. If instead it reports a different happ (sha not `ae12f592…`), run the recovery from RELEASING.md:

```bash
D=$(mktemp -d)
gh release download v0.14.11 --repo lightningrodlabs/presence -p presence.webhapp -D $D
nix develop -c hc web-app unpack $D/presence.webhapp -o $D/wh
cp $D/wh/presence.happ workdir/presence.happ
nix develop -c hc app unpack $D/wh/presence.happ -o $D/happ
cp $D/happ/presence.dna dnas/presence/workdir/presence.dna
nix develop -c hc web-app pack workdir
nix develop -c npm run release:check
```

Expected after recovery: OK. Record which path was taken in the report.

- [ ] **Step 5: The hash triple**

```bash
D=$(mktemp -d)
sha256sum workdir/presence.webhapp
nix develop -c hc web-app unpack workdir/presence.webhapp -o $D/wh
sha256sum $D/wh/presence.happ $D/wh/dist.zip
nix develop -c hc dna hash dnas/presence/workdir/presence.dna
```

Expected: the happ line is `ae12f5923442acfe498243d5a74333a7f018609d514231f43b8ec0c471743ea8`. Record the webhapp and dist.zip values and the DNA hash. Do not use `npm run hash`'s `happSha256` on this line.

- [ ] **Step 6: Push, release, verify the upload**

Write the notes to a file first. Template (fill the two hashes from Step 5 and the DNA hash):

```markdown
For Moss 0.15 / Holochain 0.6. (The Holochain 0.7 line is versioned 0.16.x.)

## Compatibility

- **In-place update:** the happ bundle is byte-identical to v0.14.8–v0.14.11 (`happSha256 ae12f592…`, verified by `npm run release:check` and by extracting the happ from the uploaded webhapp). Moss offers this as an in-place update, same network, no reinstall.
- **DNA/network:** unchanged, `<DNA HASH>` (`hc dna hash` on the packaged bundle). 0.14.12 agents share rooms with all 0.14.x agents.
- **Wire surface:** no new signal type and no capability. Two additive payloads ride the existing module-state signal: a new `annotations` module, and an `annotationsEpoch` field on share payloads. A peer on 0.14.8 through 0.14.11 stores both and ignores them, so people on those versions see no drawings, and a share from one of those versions cannot be cleared by its owner. The compat-corpus fixture diff against 0.14.11 is version and provenance only.

## What's new

- **Draw on a shared screen or a shared asset.** Every share tile has a small tool strip at its bottom-left: a pen, eight colors, undo my last stroke, clear mine, and, on your own share, clear all. Anyone in the room can draw, and everyone sees every drawing in the author's color. Someone who joins later sees the drawings that exist. Drawings stay until their author removes them, the sharer clears them, or the share stops.
- **Drawings land on the shared image.** On a screen share, a stroke is placed relative to the video image, not the tile. Two people whose tiles letterbox the share differently still see the mark on the same spot. On a shared asset, a stroke is placed relative to the tile.
- **Tiles keep their place.** The room grid now has one stable order, the same on every screen. A peer whose connection flickers no longer jumps to the end of the grid and back. On this line the order is by participant key, not join order.

## Fixed

- **A circle tile no longer grows taller than wide** while its video connection is being set up.

Checked by the unit, render and store-wiring suites and the release gate. The two-machine drawing check over a real network has not been run for this release.
```

Then:

```bash
git push origin main-0.6 v0.14.12
gh release create v0.14.12 workdir/presence.webhapp --repo lightningrodlabs/presence --title v0.14.12 --notes-file <notes file>
D=$(mktemp -d)
gh release download v0.14.12 --repo lightningrodlabs/presence -p presence.webhapp -D $D
sha256sum $D/presence.webhapp
nix develop -c hc web-app unpack $D/presence.webhapp -o $D/wh
sha256sum $D/wh/presence.happ $D/wh/dist.zip
gh release view v0.14.12 --repo lightningrodlabs/presence --json publishedAt --jq .publishedAt
```

Expected: the three sums equal Step 5's triple. On a mismatch, delete the asset and re-upload before anything records it.

- [ ] **Step 7: Record the release**

Append to `fixtures/releases.json` an entry in the shape of the 0.14.11 entry: version `0.14.12`, the release URL, the triple, and `releasedAt` as the GitHub publish time in milliseconds (`date -u -d <publishedAt> +%s` times 1000). Then:

```bash
nix develop -c npm run release:check
git add fixtures/releases.json
git commit -m "release: record v0.14.12 artifact hashes — arms the release gate"
git push origin main-0.6
```

Expected: `release:check OK — workdir artifacts match the recorded 0.14.12 release`.

- [ ] **Step 8: Curation PR**

In `/home/eric/code/metacurrency/holochain/weave-tool-curation` (no nix wrapper there):

```bash
git fetch origin && git checkout -b presence-0.14.12 origin/main
```

Insert after the `0.14.11` version entry inside the Presence `versionBranch: "0.14.x"` block of `0.15/modify/tool-list-0.15.ts` (the 0.14.11 entry is the only `version: "0.14.11"` in that file):

```ts
        {
          version: "0.14.12",
          url: "https://github.com/lightningrodlabs/presence/releases/download/v0.14.12/presence.webhapp",
          hashes: {
            happSha256: "ae12f5923442acfe498243d5a74333a7f018609d514231f43b8ec0c471743ea8",
            webhappSha256: "<webhapp sha256 from Step 5>",
            uiSha256: "<dist.zip sha256 from Step 5>"
          },
          changelog: "Update to Presence 0.14.11. Same rooms and same network as every earlier 0.14 version.\n\nWhat is new:\n\n- Draw on a shared screen or a shared asset. Every share tile has a tool strip at its bottom-left: a pen, eight colors, undo my last stroke, clear mine, and, on your own share, clear all. Anyone in the room can draw, and everyone sees every drawing in the author's color. Someone who joins later sees the drawings that exist. Drawings stay until their author removes them, the sharer clears them, or the share stops.\n- On a screen share, a stroke is placed relative to the video image, so people whose tiles letterbox the share differently see the mark on the same spot. On a shared asset, it is placed relative to the tile.\n- Tiles keep their place. The room grid has one stable order, the same on every screen, so a peer whose connection flickers no longer jumps to the end and back.\n- A circle tile no longer grows taller than wide while its video connection is being set up.\n\nPeople on 0.14.8 to 0.14.11 see no drawings, and a share from one of those versions cannot be cleared by its owner. Everything else keeps working together as before.",
          releasedAt: <releasedAt from Step 7>,
        },
```

Then:

```bash
cd 0.15 && npm install && npm run write-lists && cd ..
git status --short   # expect exactly the .ts and the .json under 0.15/
git diff --stat
git add 0.15/modify/tool-list-0.15.ts 0.15/lists/tool-list-0.15.json
git commit -m "0.15: Presence 0.14.12 (point release on the 0.14.x line; same happ as 0.14.11)"
git push -u origin presence-0.14.12
gh pr create --base main --head presence-0.14.12 --title "0.15: Presence 0.14.12 (point release; in-place update from 0.14.11)" --body-file <body file>
```

The PR body follows PR #191's shape: what changed, same versionBranch and in-place update with the DNA hash, the hash table, and how the triple was verified. `npm run write-lists` runs the validator; if it regenerates files other than the two expected, stop and report what changed.

- [ ] **Step 9: Report**

The report lists: the merge commit on `main-0.6`, the tag, the release URL, the triple, the `releases.json` commit, the curation PR URL, and which path Step 4 took.
