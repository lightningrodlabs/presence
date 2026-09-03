# PeerRecord consolidation — design spec

Written 2026-09-02, brainstormed from
`docs/superpowers/plans/2026-09-02-store-decomposition-handoff.md` (the
pre-plan brief for the store-decomposition effort). This is round one of
that effort: consolidate per-peer state; extract nothing.

**Landed** 2026-09-02/03 on branch `peer-record-consolidation`, built on
`main-0.7` — a user decision (2026-09-02) superseding the handoff brief's
0.6-first practice. The handoff doc
(`docs/superpowers/plans/2026-09-02-store-decomposition-handoff.md`) lives
on `main-0.6`; it gets its status note as a post-merge step from a
`main-0.6` checkout once this round reaches that branch.

## Problem

`ui/src/streams-store.ts` (7,013 lines at 2026-09-02, `main-0.6` @
`3eee500`) keeps "the state of one peer" smeared across ~17
separately-keyed per-peer collections that every method mutates by
hand. The coupling, not the line count, is the problem: no single type
states what a peer's state *is*, and teardown correctness depends on a
hand-maintained clear-set (`closeCleanupPlan`,
`ui/src/transport/close-cleanup-policy.ts`) whose width exists only
because the state is scattered.

Splitting the file by concern first would make this worse — five files
sharing invisible coupling instead of one file with co-located
coupling. Consolidation is the enabler; the file split is round two's
by-product. (Full argument: the handoff brief, "Why PeerLink before any
file split".)

## Decisions (made in brainstorming, 2026-09-02)

1. **Round one is consolidation only.** No concern extraction, no
   reactive-store replacement, no behavior change. One intent per
   branch (working agreement 6).
2. **Coexist with the reactive stores.** The per-peer `Writable`s
   (`_openConnections`, `_screenShareConnectionsOutgoing/Incoming`,
   `_connectionStatuses`, `_othersConnectionStatuses`, module-state
   stores, diagnostic stores) are consumed by twelve non-test files
   including `room/room-view.ts` and two room modules. They stay
   untouched; `PeerRecord` is the non-reactive bookkeeping half.
3. **The type is named `PeerRecord`**, not `PeerLink` — `PeerLinkSnapshot`
   (`ui/src/peer-link-policy.ts`) already exists and is wire-carried in
   pings (`_othersConnectionStatuses[..].peerLinks`); a second adjacent
   "peer link" type would suggest a derivation relationship that does
   not exist.
4. **`connectionEpoch` folds into the record as a never-reset survivor.**
   It is semantically part of the link (it orders connection attempts to
   that peer) and must survive both close and leave (monotonic for the
   session — `streams-store.ts`, `_connectionEpoch` doc comment, and
   `docs/WEBRTC_RECONNECT_IDENTITY.md`). Keeping it as a side collection
   would re-create the scattered-state disease in miniature; instead the
   peer-leave reset carries it forward, leaving a residual row. That is
   safe because of decision 5.
5. **Record existence is never a liveness predicate.** Membership and
   presence have their own single authorities (`_presentPeers`,
   `_activeAgents`, `_knownAgents`); nothing may iterate `_peerRecords`
   or test row existence to answer "who is here". Verified true of the
   current collections at design time: the only iterations over the
   foldable collections are the disconnect-time timer disarm and a
   filter-out, neither a membership read. The invariant is documented on
   the field and is what makes residual rows (decision 4) harmless.
6. **Incremental fold, delete-as-you-go.** Collections fold in
   lifecycle-grouped tasks; each task rewrites the group's access sites
   and deletes the folded collections in the same commit — no parallel
   period, no accessor shims (working agreement 1).

## What folds, what does not

Folds into `PeerRecord` (all verified pubkey-keyed):

- `Record<AgentPubKeyB64, …>`: `_connectionEpoch`, `_iceDisconnectedAt`,
  `_lastBytesReceived`, `_lastDisconnectTime`, `_lastReconcileTime`,
  `_pendingInits`, `_reconcileAttemptCount`,
  `_screenShareIceDisconnectedAt`, `_screenShareStreams`,
  `_sdpTimeoutTimers`, `_staleCycles`, `_videoStreams`.
- Pubkey-keyed `Map`s: `_lastWebrtcExitReason`, `_lastQualityBucket`,
  `_outageStates`, `_peerAnalysers` + `_peerAnalyserBuffers` (merged
  into one `analyser` field — every current site sets and deletes them
  together), `_signalsRttEwma`.

Does NOT fold (each for a stated reason):

- `_iceTimings` — keyed `` `${peer}:${connectionId}` ``, per-attempt
  forensics, not a per-peer row.
- `_sdpDataAggregates` — keyed `` `${agent}:${connectionId}:${sdpType}` ``,
  burst-aggregation forensics.
- `_conversationParticipants`, `_lastPresenceSet` — aggregate membership
  sets, not per-peer rows (handoff brief).
- Every `Writable`/`Readable` (decision 2).

The composite-keyed pair is a candidate for a later fold as per-attempt
sub-maps inside the record; see "Next steps".

## PeerRecord shape

`ui/src/peer-record.ts`, new file:

```ts
export type PeerRecord = {
  // — media-session bookkeeping: reset on media close
  iceDisconnectedAt?: number;
  lastBytesReceived?: { audio: number; video: number };
  staleCycles?: { audio: number; video: number };
  reconcileAttemptCount?: number;
  qualityBucket?: string;
  webrtcExitReason?: string;
  videoStream?: MediaStream;
  pendingInits?: PendingInit[];
  sdpTimeoutTimer?: number;          // handle; executor disarms before a reset drops it
  analyser?: { node: AnalyserNode; buffer: Uint8Array };
  outageState?: { startedAt: number; emitted: boolean };
  // — screen-share session: reset on the screen-share close rows
  screenShareStream?: MediaStream;          // incoming
  screenShareIceDisconnectedAt?: number;    // outgoing
  // — close survivors: reset only on peer-leave
  lastDisconnectTime?: number;
  lastReconcileTime?: number;
  signalsRttEwma?: number;
  // — session survivor: never reset
  connectionEpoch: number;
};
```

The lifecycle-class grouping is the point of the type: the close
survivors carry the retry-gap and rejoin-inheritance semantics
(`close-cleanup-policy.ts` rows `clearLastDisconnectTime` /
`clearLastReconcileTime` / `clearSignalsRttEwma` and their doc
comments); the session survivor carries the monotonic-epoch invariant.
Exact optionality and the reset class of `webrtcExitReason` /
`outageState` are confirmed against every access site during
plan-writing — the plan's per-task steps carry the verified
field-by-field mapping, and any discrepancy found there amends this
spec in place.

Also exported: `initialPeerRecord(): PeerRecord` and (landing with the
lifecycle-collapse task) `resetPeerRecord(record, arm): PeerRecord`.

## Lifecycle: resetPeerRecord and the closeCleanupPlan collapse

`resetPeerRecord` is pure and table-tested
(`ui/src/transport/media-event-policy.ts` is the shape template). Its
arms correspond to the distinct per-peer clear signatures the current
`closeCleanupPlan` rows encode (full media close, media leave,
screen-out close, screen-in close/leave, …). All field-level teardown
knowledge lives in this one function.

`closeCleanupPlan` then shrinks: the per-peer clear booleans
(`clearVideoStreamSlot`, `clearPendingInits`, `clearLastBytesReceived`,
`clearStaleCycles`, `clearReconcileAttemptCount`,
`clearIceDisconnectedAt`, `clearQualityBucket`,
`clearWebrtcExitReason`, `clearLastDisconnectTime`,
`clearLastReconcileTime`, `clearSignalsRttEwma`,
`clearScreenShareStream`, `clearScreenShareIceDisconnectedAt`,
`removeAudioAnalyser`) collapse to one `recordReset: <arm> | 'none'`
field plus the stamp `recordLastDisconnect`. The table keeps what is
genuinely routing, not per-peer clears: `closeTransport` ordering,
`clearSlot`, `clearIceTiming` / `emitIceNeverConnected`
(composite-keyed, out of scope), `logSuperseded`,
`clearPerceivedStreamInfo` (lives in a `Writable`), `emitCarrierSwitch`,
`teardownOutgoingScreenShare`, `fireEvent`, `setDisconnectedStatus`.

Two mapping rules, because this is a prove-nothing-changed refactor:

1. **Strict fidelity.** Each current row maps to the arm matching its
   exact clear set. Where an arm would clear strictly more than the row
   does today (e.g. `media-leave-no-slot` clears a subset of the full
   media set), either a narrower arm is added or the extra clears are
   proven no-ops on that path. No behavior change smuggled in as
   "surely harmless".
2. **Side effects stay in the executor**, ordered as today: disarm
   `sdpTimeoutTimer` handles before a reset drops them; forensic reads
   (the CarrierSwitch emit reads `webrtcExitReason`) before the reset
   wipes the field; `emitIceNeverConnected` before `clearIceTiming`,
   unchanged. Analyser removal is pure reference-dropping today (no
   `AudioNode` teardown — verified at `removePeerAudioAnalyser`) and
   stays so.

## Store integration

`StreamsStore` gains
`private _peerRecords = new Map<AgentPubKeyB64, PeerRecord>()` and two
helpers: `_peerRecord(k)` (read; may return `undefined`; never
creates) and `_ensurePeerRecord(k)` (get-or-create via
`initialPeerRecord()`; write paths only). The read/write split exists
because today's `record[k] = v` sites create rows implicitly and a
get-or-create used on a read path would turn reads into writes.

`disconnect()` follows today's wipes exactly (verified 2026-09-02
during plan-writing): the current `disconnect()` clears only
`_sdpTimeoutTimers` (disarming each handle), `_screenShareStreams`, and
`_pendingInits` — every other per-peer collection survives it. So
`disconnect()` iterates the records, disarms each `sdpTimeoutTimer`,
and clears only those three fields; it does NOT `_peerRecords.clear()`
(strict-fidelity rule — a full wipe would be a behavior change).

The map and both helpers are underscore-internal (not `private`),
matching the store's existing convention for wiring-test-visible fields
(`_lastReconcileTime` et al.): the wiring suite seeds and asserts
per-peer state directly.

## Task plan

Fold tasks (1–3) each fold a group, rewrite its access sites, and
delete the folded collections in the same commit; every task ends
`verify` green.

1. **Landed** (`402b8ba`). **Scaffold + numeric bookkeeping** — `peer-record.ts` (type +
   `initialPeerRecord`), the map + helpers; fold `_iceDisconnectedAt`,
   `_reconcileAttemptCount`, `_staleCycles`, `_lastBytesReceived`,
   `_lastQualityBucket`, `_lastWebrtcExitReason`.
2. **Landed** (`7b641b8`, fixup `f49e5c1`). **Streams + establishment** — fold `_videoStreams`,
   `_screenShareStreams`, `_screenShareIceDisconnectedAt`,
   `_pendingInits`, `_sdpTimeoutTimers`.
3. **Landed** (`6cb7ed4`). **Objects + survivors** — fold `_peerAnalysers` +
   `_peerAnalyserBuffers` (merged), `_outageStates`, then
   `_lastDisconnectTime`, `_lastReconcileTime`, `_signalsRttEwma`,
   `_connectionEpoch`.
4. **Landed** (`cd6d50e`). **Lifecycle collapse** — `resetPeerRecord` + table tests;
   `closeCleanupPlan` booleans → `recordReset` arms;
   `_applyCloseCleanup` executor rewrite; `close-cleanup-policy.test.ts`
   updated row-for-row. Until this task, fold tasks keep the existing
   plan booleans, re-pointing their executor clears at record fields.
5. **Landed** (`d516fbe` review-cleanup rider, plus this doc-sync commit).
   **Doc-sync** — CLAUDE.md "True today" bullet, handoff/plan status,
   and the written next steps (below).

Process: `superpowers:writing-plans` produces the implementation plan;
execution is subagent-driven (fresh subagent per task, independent
adversarial review per task, final whole-branch review — working
agreement 9) in an isolated worktree, branched off `main-0.6`.
Forward-port to `main-0.7` afterward as cherry-picks (not a merge — the
handoff brief records why).

## Testing and enforcement

- `streams-store-wiring.test.ts` and `streams-store-construction.test.ts`
  are the safety net. Where a wiring test reads a folded collection
  directly, the read is mechanically re-pointed at the record with the
  asserted value unchanged; an assertion that must change in *meaning*
  is a stop signal — the refactor changed behavior.
- New `ui/src/__tests__/peer-record.test.ts`: table tests over
  `resetPeerRecord`, every arm × every field group, pinning the close
  survivors and the never-reset epoch. The survivor pins currently in
  `close-cleanup-policy.test.ts` move here without loss as that table
  shrinks.
- Gate: `nix develop -c npm run verify` green before every commit
  claim. Zero declared behavior changes is the round's definition of
  done; the per-task review question is "show me this is identity".

## Risks (named)

- **Implicit-creation drift** — reads must not create rows; the
  read/write helper split addresses it, and review checks each rewritten
  read site.
- **Arm-mapping infidelity** — the strict-fidelity rule is where a
  behavior change would sneak in; each mapping is reviewed against the
  current row's exact clear set.
- **Handle lifetimes** — timer handles move into the record;
  disarm-before-drop ordering is executor-owned and covered by the
  existing disconnect-symmetry wiring assertions. (`AnalyserNode`
  removal needs no teardown call — verified, reference-dropping only.)

## Deliberately out of scope (this round)

- Replacing the reactive per-peer `Writable`s.
- Any concern extraction into owner objects.
- Folding `_iceTimings` / `_sdpDataAggregates`.
- Any behavior change.

## Next steps after this round (for the next session)

1. **Round two — concern extraction.** With per-peer state on one
   record, lift concern clusters (screen share, stale-health checks,
   audio analysis, diagnostics) into owner objects on the
   `capture-reconciler.ts` / `mic-source.ts` / `room-ownership.ts`
   pattern: each owns its `PeerRecord` fields plus injected bindings;
   the store keeps construction and delegation. The file split falls
   out of this; it is never its own task.
2. **Optional — forensic fold.** Restructure `_iceTimings` and
   `_sdpDataAggregates` as per-attempt sub-maps inside `PeerRecord`
   (keyed by `connectionId` / `connectionId:sdpType`), so attempt-scoped
   forensics share the peer row's lifecycle. Do this only if round two
   shows the split keys causing real friction; they are forensic-only
   and the fold adds risk without behavioral payoff today.
3. **Later — reactive unification.** Whether `PeerRecord` should drive
   the per-peer `Writable`s (or a single derived store) is a view-layer
   round with its own review; decision 2 deliberately deferred it.
