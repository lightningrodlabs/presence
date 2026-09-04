# PresenceLoop + Root Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `PresenceLoop` owner (presence state + roster/forensics/sounds behavior), split `start()`/`disconnect()` into named phase methods, and close the store-decomposition line — with zero behavior change.

**Architecture:** `ui/src/presence-loop.ts` on the established owner pattern; the store keeps delegating getters for the three roster `Writable`s, delegating get/set ACCESSOR PAIRS for the two plain presence fields store code still touches (`_signalCarrierDownSince`, `_lastComputedPresent`), and a bare `pingAgents()` delegate (harness/tests/static-connect callers). The composition root stays the root: `start()`/`disconnect()` become pipelines of named store-private phases.

**Tech Stack:** TypeScript strict, `@holochain-open-dev/stores`, vitest 1.6.1 (ui), nix devshell (node 22).

**Spec:** `docs/superpowers/specs/2026-09-04-presence-loop-design.md`. Plan-time refinement of Part 1 (amend the spec in place in Task 4): `handlePingUi` moves NOTHING — its body is a pong-reply builder over cross-concern reads plus the screen-share fragment, so it stays a store dispatcher entirely; the pong side contributes only `_applyPongRoster` to the owner. The spec's "handlePingUi's presence half" sketch is superseded by this line.

## Global Constraints

- Branch `presence-loop` off `main-0.7` @ `5b63272`, worktree `.claude/worktrees/presence-loop`. Landing target `main-0.7`.
- Gate before EVERY commit: `nix develop -c npm run verify` (sandbox disabled — sandboxed `nix develop` fails on `.gitmodules` yet exits 0; require real test summaries). Focused: `nix develop -c npm run test -w ui -- <path>`; never `npx vitest`.
- **Zero behavior change.** Moved/split bodies VERBATIM except each task's substitution table; uncovered `this.X` = STOP.
- **Delegates are bare forwards** (getters return the owner's instances; the accessor pairs forward reads AND writes).
- **Rounds one–three owner files untouched** (all six: peer-audio-levels, media-settings, diagnostics-hub, track-health, screen-share-links, media-links).
- Owner conventions as established: `bindings` field; late-bound arrows for mutable store state; record access via `_peerRecord`/`ensurePeerRecord` as origin; real signatures; constructed in the constructor body BEFORE the derived-store definitions (they read the delegating getters/accessors — the mediaLinks-first precedent); `@holochain-open-dev/stores`; class doc records what did NOT move. NEW (round-three final-review adoption): **code comments cite only TRACKED files** — never `.superpowers/` paths.
- `presence-loop.ts` joins `no-ambient-clock.test.ts` `PINNED_FILES` with `FULL_PATTERNS` in Task 1.
- The wiring, intent-write-sites, construction, settings-path, and peer-record suites green UNMODIFIED (the wiring suite's presence/carrier-hold/sounds/tick/symmetry tests drive this surface through the store, which delegates); event-taxonomy walks the tree — moved `event:` literals stay on their own lines.
- Per-task repo-wide reference grep; `ui/harness` is untypechecked.
- Stage explicit paths; no co-authored footer; no emotional phrasing.
- Line anchors verified at `5b63272`; re-locate by quoted names if shifted.
- The review-C1 invariant travels: `_emitPresenceForensics` runs BEFORE the roster-merge write in the pipeline, and before any roster write in the presence-tick callback; both ordering comments move verbatim.

---

### Task 1: PresenceLoop A — state, roster fragments, forensics, sounds

**Files:**
- Create: `ui/src/presence-loop.ts`
- Modify: `ui/src/streams-store.ts`
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts` (add pinned file)

**Interfaces:**
- Consumes: the owner pattern (read `ui/src/media-links.ts`'s header and constructor-ordering comment first — PresenceLoop is constructed in the same early slot).
- Produces (Task 2 relies on these): `PresenceLoop` class owning —
  - `Writable` fields (moved declarations, store keeps same-named delegating getters): `_knownAgents` (~streams-store 2380 region), `_presenceTick`, `_othersConnectionStatuses` (locate by name).
  - Plain fields: `_lastPresenceSet`, `_lastComputedPresent`, `_presenceSoundState`, `_presentPeersUnsub`, `_signalCarrierDownSince` (decl ~3167). Store keeps delegating ACCESSOR PAIRS (`get`/`set`) for `_signalCarrierDownSince` and `_lastComputedPresent` ONLY (their store-side touch points: the derived `_presentPeers` callback ~624–637 reads both and writes `_lastComputedPresent`; the intent-diff recompute ~334 and `_evaluateSignalsCadence` ~1667 read `_signalCarrierDownSince`; `disconnect()` ~1451 resets `_lastComputedPresent`). The other three plain fields have NO surviving store-side touch points once Task 1's methods move — verify by grep; a surviving toucher means add the accessor pair and report.
  - Methods (moved verbatim + substitution tables): `_applyPingRosterSweep` (1587–1651), `_emitPresenceForensics` (1718–~1834 — take the whole method; its C1 comment travels), `_applyPongRoster` (4052–4112), `armPresenceSounds` (was `_armPresenceSounds` 1501–1529) and a new one-line `disarmPresenceSounds()` extracting the `_presentPeersUnsub` release currently inline in `disconnect()` (~1436–1439; `disconnect()` calls the owner method — this is the one sanctioned wrapper, verbatim body inside).
- Store re-points: `disconnect()`'s unsub block → `this.presenceLoop.disarmPresenceSounds()`; `start()`'s `this._armPresenceSounds()` (~1488) → `this.presenceLoop.armPresenceSounds()`; `handlePongUi`'s `this._applyPongRoster(...)` → owner; `pingAgents`'s `this._applyPingRosterSweep()` / `this._emitPresenceForensics()` → owner (pipeline itself moves in Task 2 — this task re-points the calls in place).
- Bindings sketched (bodies are the authority; uncovered `this.X` = STOP): `clock`, `logger`, `myPubKeyB64`, `allAgents` read, `blockedAgents` read, `eventCallback` (sound events), `connectionStatusesStore` (roster seed writes the store-resident `_connectionStatuses`), `presentPeers` (the derived store, for the sound subscription), pure imports move with bodies (`decideSignalCarrier`, `decidePresenceSoundEvents`, `computeActiveAgents`-adjacent — whatever the bodies import).
- Constructor ordering: `presenceLoop` constructed immediately after `mediaLinks` (both before the derived-store definitions). CAUTION: the derived `_presentPeers` callback writes `this._lastComputedPresent` through the accessor — the accessor pair must exist before the derived definitions run (it does: accessors are prototype members).

- [ ] **Step 1: Create the owner; move state + the four methods; write the substitution table.**
- [ ] **Step 2: Wire the store: construct owner; delete moved members; add three getters + two accessor pairs + re-points.**
- [ ] **Step 3: no-ambient-clock pin (`'../presence-loop.ts'`, `FULL_PATTERNS`).**
- [ ] **Step 4: Reference grep** — `grep -rn '_applyPingRosterSweep\|_emitPresenceForensics\|_applyPongRoster\|_armPresenceSounds\|_presenceSoundState\|_lastPresenceSet\|_presentPeersUnsub' ui/ --include='*.ts' | grep -v presence-loop` — remaining hits only re-points/delegates/prose.
- [ ] **Step 5: Focused (wiring + construction + no-ambient-clock) then full gate** — wiring's carrier-hold and sound tests green UNMODIFIED.
- [ ] **Step 6: Commit** — `refactor: extract PresenceLoop owner — presence state, roster fragments, forensics, sounds` + plan Task 1 body line.

---

### Task 2: PresenceLoop B — the pingAgents pipeline + tick callback

**Files:**
- Modify: `ui/src/presence-loop.ts`, `ui/src/streams-store.ts`

**Interfaces:**
- Consumes: Task 1's owner + accessors.
- Produces: owner methods `pingAgents(): Promise<void>` (the pipeline, moved verbatim from streams-store 1530–1586 with Task 1's re-points already inside; the store-resident tick work is reached via bindings added this task: `checkTrackHealth` (→ `this.trackHealth.checkTrackHealth()` arrow), `checkAudibilityOutages`, `flushStaleSdpAggregates` (store delegate), `evaluateSignalsCadence`, `sweepPendingInits`, `logMyStreamInfo` (logger + `mainStream` read arrow), `sendMessage` + `_sendPings` (1652-region — moves, it is presence wire traffic)); and `onPresenceTick(): void` (the presence-tick callback body currently inline in `start()` ~735–751 — moved verbatim; the root keeps `this._presenceTickInterval = this.clock.setInterval(() => this.presenceLoop.onPresenceTick(), PING_INTERVAL)`).
- Store keeps: bare `pingAgents()` delegate (callers: `static connect`'s interval + await ~1330–1332, both harnesses, ~30 wiring-test sites — the delegate serves all unchanged); `_sweepPendingInits`/`_evaluateSignalsCadence`/`_checkAudibilityOutages` stay store-resident (spec decision 3) reached via bindings; the interval HANDLES (`pingInterval`, `_presenceTickInterval`) stay root state.
- The C1 ordering must hold in the owner pipeline (forensics first) AND in `onPresenceTick` — both comments verbatim.

- [ ] **Step 1: Move the pipeline + `_sendPings` + the tick callback; extend bindings (reuse Task 1's, never duplicate a seam).**
- [ ] **Step 2: Store: `pingAgents()` becomes the bare delegate; `start()`'s interval callback re-pointed to `onPresenceTick`; delete moved members.**
- [ ] **Step 3: Reference grep** — `grep -rn '_sendPings\|onPresenceTick\|pingAgents' ui/ --include='*.ts' | grep -v presence-loop` — delegate + external callers only.
- [ ] **Step 4: Focused (wiring — its ~30 pingAgents-driving tests and the tick tests must be green UNMODIFIED) then full gate.**
- [ ] **Step 5: Commit** — `refactor: move pingAgents pipeline and presence tick into PresenceLoop` + plan Task 2 line.

---

### Task 3: Composition-root split

**Files:**
- Modify: `ui/src/streams-store.ts` (`start()` ~727–1150, `disconnect()` ~1366–1529 at 5b63272 — re-locate by name)

**Interfaces:**
- Produces: `start()` and `disconnect()` as pipelines of named store-private phase methods. Names fixed from the actual bodies at implementation time following this shape (indicative set — the implementer partitions the REAL body into contiguous verbatim fragments and names each by its concern; the partition and names go in the report for review): `_startTransports`, `_startSignalRouting`, `_startPresenceTicking`, `_startCaptureSources`, `_startPageLifecycle` + residue; `_teardownTimers`, `_teardownTransports`, `_teardownCaptureAndEncoders`, `_teardownSubscriptions`, `_teardownState` + residue. RULES (binding): fragments contiguous and verbatim; order and awaits identical; no statement moves across a phase boundary relative to origin order; locals shared across fragment boundaries become parameters or provably-pure re-reads declared per variable in the report (the round-three fragment-variable discipline); any try/catch or conditional must sit wholly inside one phase or wholly wrap the pipeline exactly as origin (the round-three Task-1 lesson — verify what each guard ACTUALLY covers in origin before drawing a boundary through its neighborhood; a boundary that would change guard coverage is a STOP).
- The wiring suite's start/disconnect symmetry and destroy-exactly-once pins green UNMODIFIED.

- [ ] **Step 1: Read both bodies in full; partition; split (verbatim fragments + pipeline).**
- [ ] **Step 2: Focused (wiring + construction) then full gate; diff review — split-only.**
- [ ] **Step 3: Commit** — `refactor: split start/disconnect into named composition-root phases` + plan Task 3 line.

---

### Task 4: Doc-sync + closing declaration

**Files:** `CLAUDE.md`, the spec, this plan.

- [ ] **Step 1: CLAUDE.md "True today" bullet** per its contract (read the media-links bullet as the model; anchored range incl. closing commits by role; present tense only naming enforcing file/test; no counters/snapshots/unanchored negations; drift test run). Record: PresenceLoop's ownership (state list, the three getters, the two accessor pairs and WHY — the derived `_presentPeers` callback and cadence eval still touch those fields store-side), the bare `pingAgents()` delegate, the root phases, the handlePingUi refinement (nothing moved from it — spec amended), zero declared behavior changes. Inline-correct earlier bullets falsified by the move (grep every moved name against CLAUDE.md and verdict every hit — known candidates: the connection-thrash bullet's "both evaluators (`pingAgents`'s top and the presence-tick callback)" phrasing, the §7.5/Phase-2 bullets' `_presentPeers`/`computePresentPeers` location claims if any name store residency, the meta-review bullet's dormant list gains the two new entries below).
- [ ] **Step 2: THE CLOSING DECLARATION**: add to the dormant-until-trigger list (the meta-review bullet holds it): reactive-`Writable` unification — trigger: a view-layer round needing the store surface reshaped; `_iceTimings`/`_sdpDataAggregates` forensic fold — trigger: observed friction from the composite keys. State that the store-decomposition line (rounds one–four, PeerRecord → owner extraction → media-links → presence-loop) is closed with no standing loop; further decomposition only on feature-traffic demand.
- [ ] **Step 3: Spec landed-markers + the Part-1 handlePingUi amendment + plan Status line.**
- [ ] **Step 4: Drift guard focused + full gate; commit** — `docs: sync CLAUDE.md and close the store-decomposition line`.

---

## Deliberately out of scope

Reactive-`Writable` unification and the forensic fold (dormant, triggers named above); `static connect` (untouched — its `pingAgents` calls ride the delegate); any behavior change.

## Notes for reviewers

- Identity is the question. Tasks 1–2: origin-diff moved bodies (origin = `5b63272`); the C1 forensics-before-roster ordering verified in BOTH the owner pipeline and `onPresenceTick`. Task 3: reconstruct-verify — every origin line exactly once, in order; guard coverage unchanged (the round-three lesson is the named risk).
- Accessor pairs must forward both directions; the derived `_presentPeers` callback's write of `_lastComputedPresent` through the setter is the subtle site — verify it hits the owner's field.
- Rounds one–three owner files: zero hunks across the branch.
