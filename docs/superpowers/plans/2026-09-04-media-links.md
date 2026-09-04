# Fragment Splits + MediaLinks Implementation Plan

**Status: LANDED on `media-links`.** All five tasks executed and committed to that branch (`f6a4563`..`2ca43c8` for the four code tasks, the Task 1 fixup `103ab37` included, plus the Task 5 doc-sync commits `87a8e34` and this one). Merging `media-links` into `main-0.7` is a pending human step — this document describes the `media-links` branch, not `main-0.7`, until that merge lands. The corresponding `CLAUDE.md` "True today" bullet was added by the Task 5 doc-sync (see the "Media-links round facts" bullet).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `handlePongUi` and `pingAgents` into pipelines of named single-concern methods, then extract the media transport glue + shared teardown kernel + establishment into a `MediaLinks` owner — with zero behavior change.

**Architecture:** Part 1 is pure method extraction on `StreamsStore` (bodies verbatim, `try/catch` scope pinned). Part 2 creates `ui/src/media-links.ts` on the round-two owner pattern (`bindings` record, late-bound arrows, store-delegating members); the store keeps bare delegates for the four kernel/forensic methods other code still calls, so the round-two owner files need zero edits.

**Tech Stack:** TypeScript strict, Svelte stores (`@holochain-open-dev/stores`), vitest 1.6.1 (ui workspace), nix devshell (node 22).

**Spec:** `docs/superpowers/specs/2026-09-04-media-links-design.md` — read it first; the ownership boundary, kernel-delegation rule, and fragment-variable rule come from there.

## Global Constraints

- Branch `media-links` off `main-0.7` @ `612e7da`, worktree `.claude/worktrees/media-links`. Landing target `main-0.7`.
- Gate before EVERY commit: `nix develop -c npm run verify` (sandbox disabled — sandboxed `nix develop` fails on `.gitmodules` yet exits 0; require real test summaries). Focused runs: `nix develop -c npm run test -w ui -- <path>`; never `npx vitest`.
- **Zero behavior change.** Moved/split bodies are VERBATIM except each task's substitution table. Any `this.X` in a moved body not covered by the table: STOP and report.
- **Fragment-variable rule (part 1):** a local shared across fragment boundaries becomes a PARAMETER unless its recomputation is a provably pure re-read; each task's table declares parameter-vs-recompute per variable — deviating from the table is a STOP.
- **Delegates are bare forwards**; the kernel chain (round-two owner binding → store delegate → MediaLinks) must stay a bare two-hop forward.
- **Round-two owner files are untouched** (`peer-audio-levels.ts`, `media-settings.ts`, `diagnostics-hub.ts`, `track-health.ts`, `screen-share-links.ts`) — their bindings keep working through the store delegates.
- Late-bound bindings for mutable store state (`() => this.mediaTransport` etc.); record reads via `_peerRecord`, writes via `ensurePeerRecord` only where origin wrote; `@holochain-open-dev/stores` imports; owner constructed in the constructor body; bindings field named `bindings`.
- `media-links.ts` joins `no-ambient-clock.test.ts` `PINNED_FILES` with `FULL_PATTERNS` in Task 3.
- Moved `logger.logAgentEvent` calls keep `event:` literals on their own lines (event-taxonomy walks the tree).
- Per-task repo-wide reference grep (given per task) — `ui/harness` is not typechecked.
- The wiring, intent-write-sites, construction, settings-path, and peer-record suites stay green UNMODIFIED; an assertion changing in meaning is a STOP.
- Stage explicit paths only; no co-authored footer; no emotional phrasing.
- Line numbers below verified at `612e7da`; earlier tasks shift later numbers — re-locate by quoted names.

---

### Task 1: Split `handlePongUi`

**Files:**
- Modify: `ui/src/streams-store.ts` (`handlePongUi` 5082–5418 at 612e7da)

**Interfaces:**
- Produces (Task 4 moves one of these): five private methods —
  - `_applyPongStats(pubkeyB64: AgentPubKeyB64, metaData: PongMetaData<PongMetaDataV1>): void` (origin 5103–5146: the `foldSignalsRtt` block through the quality emit)
  - `_applyPongRoster(pubkeyB64: AgentPubKeyB64, metaData: PongMetaData<PongMetaDataV1>, now: number): void` (origin 5147–5190: the `_othersConnectionStatuses` update + `_knownAgents` merge)
  - `_applyPongModuleSweep(pubkeyB64: AgentPubKeyB64, metaData: PongMetaData<PongMetaDataV1>): void` (origin 5191–5238: the `decideModuleStateMerge` sweep + dispatches; keep the surrounding `{ }` block's contents verbatim)
  - `async _drivePongMediaLink(pubkeyB64: AgentPubKeyB64, fromAgent: AgentPubKey, metaDataExt: PongMetaData<PongMetaDataV1> | undefined, now: number): Promise<void>` (origin 5249–5381: the `conversationActive`/`peerWebrtcDisabled`/`peerCapsKnown` reads, stale video cleanup, eligibility + `decideInitRetry` drive including the InitRequest send — `signal.from_agent` becomes the `fromAgent` parameter — and the audio-expectation check; `alreadyOpen` is computed inside, used by both the drive and the audio check)
  - `_drivePongScreenShare(pubkeyB64: AgentPubKeyB64, now: number): void` (origin 5395–5417: outgoing-share stale check + `ensureOutgoingScreenShare`)
- `handlePongUi` becomes: pubkey/now/parse guard + `logAgentPongMetaData` + `metaDataExt` capture (verbatim), then

```ts
try {
  this._applyPongStats(pubkeyB64, metaData);
  this._applyPongRoster(pubkeyB64, metaData, now);
  this._applyPongModuleSweep(pubkeyB64, metaData);
} catch (e) {
  // existing catch body verbatim (5239–5247)
}
await this._drivePongMediaLink(pubkeyB64, signal.from_agent, metaDataExt, now);
this._drivePongScreenShare(pubkeyB64, now);
```

CAUTION — the parse guard and its `return` (5089–5098) plus `logAgentPongMetaData`/`metaDataExt = metaData` (5100–5101) currently sit INSIDE the `try`. Restructure minimally: parse+early-return+log+capture move ABOVE the `try` (the parse path cannot throw past its own `.ok` check — `parseSignalPayload` returns a result, verify by reading it; if it can throw, keep the parse inside the try with the same early-return and STOP to report the deviation), and the `try` wraps exactly the three apply calls so the catch covers the same fragment set it covers today (its comment says so: "spans the RTT stats, presence merge and module-state reconciliation").

**Amended 2026-09-04, post-implementation (Task 1 review round 1):** the pipeline sketch above and this CAUTION paragraph are SUPERSEDED. `parseSignalPayload` is confirmed non-throwing, but the origin `try` in fact covered four fragments, not three — `logAgentPongMetaData` and `metaDataExt = metaData` sat inside it too, ahead of the three apply calls, and `logAgentPongMetaData` is throw-capable on reachable paths. The implementer's first cut followed this sketch verbatim (move both above the `try`) and a reviewer caught that this widens what escapes uncaught, contradicting the zero-behavior-change contract. Controller ruling: zero-behavior-change wins over this sketch. Landed shape (`103ab37`): only the parse guard and its early `return` move above the `try`; `logAgentPongMetaData` and `metaDataExt = metaData` stay inside it, immediately before the three apply calls, so the catch covers all four fragments (its comment now says so). See `.superpowers/sdd/2026-09-04-media-links/task-1-report.md`'s "Fix report" section for the full account.

**Fragment-variable table (binding):** `pubkeyB64`, `now` — parameters (computed once at top, as today). `metaData` — parameter to the three try-block methods. `metaDataExt` — parameter to `_drivePongMediaLink` (nullable exactly as today). `conversationActive`, `peerWebrtcDisabled`, `peerCapsKnown`, `existingConn`, `alreadyOpen` — recomputed inside `_drivePongMediaLink` in the same order and by the same expressions as origin (pure re-reads; they were computed after the try block and are used only by the drive). `signal.from_agent` — the `fromAgent` parameter.

- [x] **Step 1: Perform the split** — cut each origin range into its method verbatim; write the new pipeline body.
- [x] **Step 2: Focused run** — `nix develop -c npm run test -w ui -- src/__tests__/streams-store-wiring.test.ts` (drives handlePongUi via real pong traffic) — green, UNMODIFIED.
- [x] **Step 3: Full gate; diff review** — `git diff` shows only the split (moved lines + pipeline + signatures); no expression changed.
- [x] **Step 4: Commit** — `git add ui/src/streams-store.ts && git commit -m "refactor: split handlePongUi into single-concern methods"` (+ a body line citing this plan Task 1).

---

### Task 2: Split `pingAgents`

**Files:**
- Modify: `ui/src/streams-store.ts` (`pingAgents` 2377–2509 at 612e7da)

**Interfaces:**
- Produces: four private methods —
  - `_applyPingRosterSweep(): void` (origin 2394–2439: the `_knownAgents` merge + the `_connectionStatuses` seed; the two blocks are one roster concern)
  - `async _sendPings(): Promise<void>` (origin 2441–2453: recipient filter + `sendMessage('PingUi', …)`)
  - `_sweepPendingInits(now: number): void` (origin 2463–2466: the records loop; `now` a parameter)
  - `_evaluateSignalsCadence(): void` (origin 2490–2508: the `bestRttEwmaMs` fold + `decideSignalsMediaCadence` + `_voiceBatchCapAllTargets`)
- `pingAgents` becomes, in order (comments at 2378–2391 and 2477–2489 stay attached to their statements):

```ts
this._emitPresenceForensics();          // stays FIRST — review-C1 ordering comment travels verbatim
this._applyPingRosterSweep();
await this._sendPings();
this.logger.logMyStreamInfo(getStreamInfo(this.mainStream));   // stays inline
const now = this.clock.now();
this._sweepPendingInits(now);
await this.trackHealth.checkTrackHealth();   // stays inline
this._checkAudibilityOutages();              // stays inline
this._flushStaleSdpAggregates();             // stays inline
this._evaluateSignalsCadence();
```

**Fragment-variable table:** `now` (2463) — parameter to `_sweepPendingInits`; everything else fragment-local. Order and `await`s exactly as origin.

- [x] **Step 1: Perform the split.**
- [x] **Step 2: Focused run** — wiring suite (its carrier-hold and encoder-retry tests drive `pingAgents`) — green, UNMODIFIED.
- [x] **Step 3: Full gate; diff review** (split-only diff).
- [x] **Step 4: Commit** — `refactor: split pingAgents into single-concern methods` (+ plan Task 2 line).

---

### Task 3: MediaLinks A — glue + kernel + forensics + `_openConnections`

**Files:**
- Create: `ui/src/media-links.ts`
- Modify: `ui/src/streams-store.ts`
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts` (add pinned file)
- Modify (prose only): `ui/harness/carrier-handover-harness.ts:9`, `ui/harness/carrier-handover.spec.ts:11` (re-point `_dispatchMediaEvent` citations to `ui/src/media-links.ts`; same claims)

**Interfaces:**
- Consumes: parts 1–2 landed; round-two owner pattern (read `ui/src/screen-share-links.ts` FIRST — MediaLinks is its twin).
- Produces: `MediaLinks` class owning the `_openConnections` `Writable` and these members (moved verbatim from 612e7da anchors): `subscribe` (was `_subscribeMediaTransport` 895), `_dispatchMediaEvent` 901, `_applyMediaSignalingRoute` 981, `_handleEstablishmentTimeline` 1037, `_stakeIceTiming` 1084, `_clearIceTiming` 1098, `_handleMediaIceDiagnostic` 1108, `_emitIceEstablishment` 1184, `_emitIceNeverConnected` 1226, `_videoMaxBitrate` 1289, `_applySenderPriorities` 1312, `_handleMediaConnected` 1331, `applyCloseCleanup` (was `_applyCloseCleanup` 1479), `_handleMediaClosed` 1598, `_handleMediaRemoteStream` 1653, `_handleMediaRemoteTrack` 1697, `_handleMediaDataChannelMessage` 1762, `_handleMediaError` 1831, `logSdpDataEvent` (was `_logSdpDataEvent` 4528), `_emitSdpAggregateSummary` 4565, `flushStaleSdpAggregates` 4636, `_flushSdpAggregatesForConnection` 4652, `applyStaleTeardown` (was `_applyStaleTeardown` 4750); fields `_iceTimings` and `_sdpDataAggregates` (+ `SDP_AGGREGATE_WINDOW_MS`) move as-is.
- Store keeps EXACTLY these surfaces: delegating getter `get _openConnections()` (writers at `disconnect()` 2295 and `_clearPendingWebrtcStatus` 4267 keep calling `.set`/`.update` THROUGH the getter — verify both compile and behave, round-two screen-share precedent); bare delegates `_applyCloseCleanup(...)`, `_applyStaleTeardown(...)`, `_logSdpDataEvent(...)`, `_flushStaleSdpAggregates()` (callers: the ScreenShareLinks bindings at ~638/645, `handleLeaveUi`, the pong screen fragment, `pingAgents`, `handleSdpFsm` until Task 4). `start()` re-points `this._subscribeMediaTransport()` → `this.mediaLinks.subscribe()`.
- STAY on the store (Task 3 binds them): `_readDtlsStallTimeoutMs` 1249 and `_readIceTransportPolicy` 1267 (BOTH have `start()` transport-construction callers at 730–771 — composition root, out of scope), `_sendRtcAction`, `_maybeEmitQualityChange`, `_sendImmediatePongToAll` 4376 (caller 4368 is not media glue), `updateConnectionStatus` (moves in Task 4; Task 3's moved glue calls it via a binding), `_nextConnectionEpoch`, `_peerCaps`.

Bindings sketch (the moved bodies are the authority; uncovered `this.X` = STOP; copy real signatures):

```ts
export type MediaLinksBindings = {
  mediaTransport: () => PeerTransport;                    // late-bound
  updateConnectionStatus: (peer: AgentPubKeyB64, status: ConnectionStatus) => void;
  sendRtcAction: /* mirror _sendRtcAction */;
  maybeEmitQualityChange: /* mirror */;
  readIceTransportPolicy: () => RTCIceTransportPolicy | undefined;
  setupPeerAudioAnalyser: (peer: string, stream: MediaStream) => void;   // peerAudioLevels
  refreshTracksForPeer: (peer: AgentPubKeyB64) => void;                  // trackHealth
  noteConversationParticipant: (peer: AgentPubKeyB64) => void;           // diagnosticsHub
  screenShareStatuses: /* whatever _applyCloseCleanup reads/writes for screen rows — mirror the body */;
  teardownOutgoingScreenShare: (peer: AgentPubKeyB64) => void;
  peerRecord / ensurePeerRecord / resetPeerRecord-import;
  connectionStatusesStore: () => Writable<ConnectionStatuses>;           // _connectionStatuses stays store-side
  othersConnectionStatuses: () => Writable<...>;                         // if the close path clears perceivedStreamInfo — mirror body
  eventCallback, logger, clock (now/setTimeout as needed), myPubKeyB64, mainStream: () => ...,
};
```

- [x] **Step 1: Read `screen-share-links.ts` (the twin) and the moved bodies; write `media-links.ts`** with the members above, substitution table in your report.
- [x] **Step 2: Wire the store** — construct `mediaLinks` in the constructor body (after deps/logger/clock/owners it binds); delete moved members; add the getter + four bare delegates; re-point `start()`'s subscribe call.
- [x] **Step 3: no-ambient-clock pin** (`'../media-links.ts'`, `FULL_PATTERNS`).
- [x] **Step 4: Reference grep** — `grep -rn '_subscribeMediaTransport\|_dispatchMediaEvent\|_handleMedia\|_stakeIceTiming\|_emitIceEstablishment\|_emitIceNeverConnected\|_videoMaxBitrate\|_applySenderPriorities\|_iceTimings\|_sdpDataAggregates\|_emitSdpAggregateSummary\|_flushSdpAggregatesForConnection' ui/ packages/ --include='*.ts' | grep -v media-links` — remaining hits only delegates, bindings, re-pointed prose.
- [x] **Step 5: Focused (wiring + construction + no-ambient-clock) then full gate** — all green, wiring UNMODIFIED.
- [x] **Step 6: Commit** — `refactor: extract MediaLinks owner — transport glue, teardown kernel, ICE/SDP forensics` (+ plan Task 3 line).

---

### Task 4: MediaLinks B — establishment + `drivePong` + status

**Files:**
- Modify: `ui/src/media-links.ts`, `ui/src/streams-store.ts`

**Interfaces:**
- Consumes: Task 3's owner + delegates; Task 1's `_drivePongMediaLink`.
- Produces: MediaLinks gains (moved verbatim, 612e7da anchors): `updateConnectionStatus` 4303 (writes `_connectionStatuses` via the Task 3 binding; the Task 3 glue binding `updateConnectionStatus` is REBOUND to the owner's own method — one-line constructor change, or call it internally as `this.updateConnectionStatus`), `handleInitRequest` 5425, `handleInitAccept` 5547, `handleSdpFsm` 5719, `_computeSdpTimeout` 2664, `_computeSdpBackstopTimeout` 2691, and `drivePong` (Task 1's `_drivePongMediaLink`, moved with pubkey/fromAgent/meta/now signature intact). New bindings from the bodies (verify each): `sendMessage` (bus, InitRequest/InitAccept sends), `signalsRttEwma` read for `_computeSdpTimeout` (via `peerRecord`), `webrtcDisabled`, `webrtcGloballyDisabled`, `webrtcAvailableFor`, `myModuleStates`/`peerModuleStates` reads (`conversationActive`/`peerCapsKnown`), `nextConnectionEpoch`, `peerCaps`, `blockedAgents` if read, `_signalsCadence`? — NO: cadence is ping-side, stays. The bodies are the authority.
- Store: `_processSignal`'s `InitRequest`/`InitAccept`/`SdpFsm` cases → `this.mediaLinks.*`; `handlePongUi`'s `await this._drivePongMediaLink(...)` → `await this.mediaLinks.drivePong(...)`; delete the store methods; keep the existing `_computeSdpTimeout` surface ONLY as needed by the ScreenShareLinks binding (~line 630 region constructs `computeSdpTimeout: peerB64 => this._computeSdpTimeout(peerB64)`) — keep a bare store delegate so the round-two file stays untouched. `updateConnectionStatus`: grep first (`grep -rn 'updateConnectionStatus' ui/ --include='*.ts' | grep -v media-links | grep -v Screen`) — at 612e7da its callers are all moving code; if the grep at your HEAD agrees, delete the store method with NO delegate; any surviving caller means keep a bare delegate instead.
- [x] **Step 1: Move the members; extend bindings; rebind the Task 3 `updateConnectionStatus` arrow to the owner method.**
- [x] **Step 2: Re-point `_processSignal` + `handlePongUi`; delete store methods; keep the `_computeSdpTimeout` delegate.**
- [x] **Step 3: Reference grep** — `grep -rn 'handleInitRequest\|handleInitAccept\|handleSdpFsm\b\|_computeSdpTimeout\|_computeSdpBackstopTimeout\|_drivePongMediaLink\|updateConnectionStatus' ui/ --include='*.ts' | grep -v media-links | grep -v screen-share-links` — only the delegate, re-pointed call sites, prose.
- [x] **Step 4: Focused (wiring — its init/accept/SDP-timer/backstop pins all drive this surface) then full gate** — green, UNMODIFIED.
- [x] **Step 5: Commit** — `refactor: move establishment and pong drive into MediaLinks` (+ plan Task 4 line).

---

### Task 5: Doc-sync

**Files:** `CLAUDE.md`, the spec, this plan.

- [x] **Step 1: CLAUDE.md "True today" bullet** per its contract (read the two prior round bullets first; anchored date/branch/commits + closing-commit clause; present tense only naming enforcing file/test; no counters/snapshots/unanchored negations — run the drift test). Record: the two method splits (named fragments); `ui/src/media-links.ts` as the one home of the media glue, teardown kernel, ICE/SDP forensics, establishment, and `_openConnections` (in the no-ambient-clock pin); the four store bare delegates and why (round-two owner bindings unchanged); what stayed (`_readDtls*`/`_readIceTransportPolicy` with the composition root, `_sendRtcAction`, `_maybeEmitQualityChange`, `_connectionStatuses`); zero declared behavior changes; round four's list (composition root, reactive unification, forensic fold, presence owner for the ping/pong roster fragments).
- [x] **Step 2: Spec landed-markers + plan Status line** (intent-reconciliation plan pattern). Also inline-correct any earlier CLAUDE.md bullet that names a member this round moved (grep the moved names against CLAUDE.md; the "since the 2026-09 …; previously …" clause is the house shape — the §9 bullet's `_applyMediaSignalingRoute` mention and the Post-Phase-4 bullet's `_iceTimings` mention are known candidates; verdict every hit).
- [x] **Step 3: Drift guard focused + full gate; commit** — `docs: sync CLAUDE.md and round docs for media-links round`.

---

## Deliberately out of scope (spec)

`start()`/`disconnect()` composition root (`disconnect()`'s `_openConnections.set({})` keeps working through the delegating getter — verified writer list, spec decision 4 as amended); reactive-`Writable` unification; the forensic fold (`_iceTimings`/`_sdpDataAggregates` move unchanged); a presence owner for the ping/pong roster fragments.

## Notes for reviewers

- Review question: identity. Parts 1–2: the diff must be a pure split — same expressions, same order, same awaits, the pong catch covering exactly stats+roster+modules. Parts 3–4: origin-diff the moved bodies (origin = `612e7da`); kernel chain = bare two-hop; bindings late-bound; round-two owner files show ZERO diff hunks.
- The fragment-variable tables are binding; a recompute not listed there is a finding.
- `_openConnections` writers through the delegating getter: confirm `disconnect()` and `_clearPendingWebrtcStatus` still hit the same `Writable` instance.
