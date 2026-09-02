# PeerRecord Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the ~17 pubkey-keyed per-peer collections in `ui/src/streams-store.ts` into one `Map<AgentPubKeyB64, PeerRecord>`, then collapse `closeCleanupPlan`'s per-peer clear booleans into lifecycle-reset arms — with zero behavior change.

**Architecture:** New `ui/src/peer-record.ts` holds the `PeerRecord` type (fields grouped by lifecycle class), `initialPeerRecord`, `prunePendingInits`, and (Task 4) `resetPeerRecord`. The store gains `_peerRecords` + read/write helpers; each fold task rewrites a group's access sites and deletes the folded collections in the same commit. Task 4 rewrites `closeCleanupPlan` and its executor onto reset arms.

**Tech Stack:** TypeScript strict, Svelte stores (untouched), vitest 1.6.1 (ui workspace), nix devshell (node 22 on this line).

**Spec:** `docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md` — read it first; the mapping rules (strict fidelity, executor-owned side effects, existence-is-never-liveness) come from there.

## Global Constraints

- Branch: `peer-record-consolidation`, off `main-0.7` @ `cd60a69`, worktree `.claude/worktrees/peer-record-consolidation`. Landing target is `main-0.7`; any 0.6 backport is a separate later decision.
- Gate before EVERY commit: `nix develop -c npm run verify` (run with sandbox disabled — under the sandbox `nix develop` fails on `.gitmodules` yet exits 0; a "green" run showing a `.gitmodules` error did NOT run).
- Focused test: `nix develop -c npm run test -w ui -- src/__tests__/<file>` (never `npx vitest` — wrong root version).
- **Zero behavior change.** If a test assertion must change in *meaning* (not just re-point a field read), STOP — the refactor changed behavior.
- Delete folded collections in the same commit that folds them. No parallel state, no shims.
- Stage explicit paths only — never `git add -A` (shared-tree lesson).
- Commits: no Claude co-authored footer, no emotional phrasing.
- Node 22: never assign `globalThis.navigator =` in tests; use `Object.defineProperty(globalThis, 'navigator', {value, configurable: true})`.
- All `streams-store.ts` line numbers below were verified at `cd60a69`; earlier tasks shift later numbers — re-locate by the quoted code, not the number.
- Access patterns (use these consistently):
  - read: `this._peerRecords.get(k)?.field`
  - clear: `const r = this._peerRecords.get(k); if (r) r.field = undefined;`
  - write: `this._ensurePeerRecord(k).field = v;`

---

### Task 1: Scaffold + numeric bookkeeping fold

**Files:**
- Create: `ui/src/peer-record.ts`
- Create: `ui/src/__tests__/peer-record.test.ts`
- Modify: `ui/src/streams-store.ts` (declarations ~3584–3670 and ~4458–4495; sites listed per collection below)

**Interfaces:**
- Consumes: `PendingInit` (`ui/src/types.ts:35`), `AgentPubKeyB64` (`@holochain/client`).
- Produces (later tasks rely on these exact names):
  - `PeerRecord` type, `initialPeerRecord(): PeerRecord` (from `ui/src/peer-record.ts`)
  - On `StreamsStore`: `_peerRecords: Map<AgentPubKeyB64, PeerRecord>`, `_peerRecord(k: AgentPubKeyB64): PeerRecord | undefined`, `_ensurePeerRecord(k: AgentPubKeyB64): PeerRecord` — all underscore-internal, NOT `private` (wiring tests seed via `_ensurePeerRecord`).

- [ ] **Step 1: Write `ui/src/peer-record.ts`**

```ts
/**
 * PeerRecord — the ONE per-peer state record (store-decomposition round
 * one; docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md).
 * Fields are grouped by lifecycle class; `resetPeerRecord` (Task 4) is
 * the one authority for what survives which teardown.
 *
 * INVARIANT: record existence is never a liveness predicate. Presence
 * and membership have their own authorities (`_presentPeers`,
 * `_activeAgents`, `_knownAgents`); nothing may iterate `_peerRecords`
 * or test row existence to answer "who is here". A row may outlive the
 * peer (the leave reset keeps `connectionEpoch` — monotonic for the
 * session, see docs/WEBRTC_RECONNECT_IDENTITY.md).
 */
import type { AgentPubKeyB64 } from '@holochain/client';
import type { PendingInit } from './types';

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
  /** clock.setTimeout handle; the executor disarms before dropping. */
  sdpTimeoutTimer?: number;
  analyser?: { node: AnalyserNode; buffer: Uint8Array };
  /** Managed solely by the outage sweep — no reset arm touches it. */
  outageState?: { startedAt: number; emitted: boolean };
  // — screen-share session: reset on the screen-share close rows
  screenShareStream?: MediaStream; // incoming
  screenShareIceDisconnectedAt?: number; // outgoing
  // — close survivors: reset only on peer-leave
  lastDisconnectTime?: number;
  lastReconcileTime?: number;
  signalsRttEwma?: number;
  // — session survivor: never reset
  connectionEpoch: number;
};

export function initialPeerRecord(): PeerRecord {
  return { connectionEpoch: 0 };
}

// AgentPubKeyB64 re-exported so streams-store's helper signatures can
// reference it without a second import line.
export type { AgentPubKeyB64 };
```

(`prunePendingInits` and `resetPeerRecord` are added by Tasks 2 and 4 — do not stub them.)

- [ ] **Step 2: Write the failing test `ui/src/__tests__/peer-record.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { initialPeerRecord } from '../peer-record';

describe('initialPeerRecord', () => {
  it('starts at epoch 0 with no session state', () => {
    const r = initialPeerRecord();
    expect(r.connectionEpoch).toBe(0);
    expect(r.pendingInits).toBeUndefined();
    expect(r.videoStream).toBeUndefined();
    expect(r.lastDisconnectTime).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it — verify it passes (pure module, no store needed)**

Run: `nix develop -c npm run test -w ui -- src/__tests__/peer-record.test.ts`
Expected: PASS (the module from Step 1 satisfies it; the red-first discipline applies to `resetPeerRecord`'s tables in Task 4 — this task's risk is carried by the wiring suite staying green).

- [ ] **Step 4: Add the map + helpers to `StreamsStore`**

Next to the per-peer declarations (put it directly above `_sdpTimeoutTimers`, ~line 3559), with the invariant comment:

```ts
/**
 * The ONE per-peer state record (peer-record.ts). INVARIANT: record
 * existence is never a liveness predicate — presence/membership come
 * from _presentPeers/_activeAgents/_knownAgents, never from this map.
 * Underscore-internal (not private): the wiring suite seeds rows.
 */
_peerRecords: Map<AgentPubKeyB64, PeerRecord> = new Map();

/** Read a peer's record. Never creates. */
_peerRecord(k: AgentPubKeyB64): PeerRecord | undefined {
  return this._peerRecords.get(k);
}

/** Get-or-create. Write paths only — a read must never create a row. */
_ensurePeerRecord(k: AgentPubKeyB64): PeerRecord {
  let r = this._peerRecords.get(k);
  if (!r) {
    r = initialPeerRecord();
    this._peerRecords.set(k, r);
  }
  return r;
}
```

Add the import: `import { initialPeerRecord, type PeerRecord } from './peer-record';`

- [ ] **Step 5: Fold the six numeric/bookkeeping collections, site by site**

Delete these declarations: `_iceDisconnectedAt` (~3604), `_reconcileAttemptCount` (~3638), `_lastBytesReceived` (~3644), `_staleCycles` (~3670), `_lastQualityBucket` (~4486), `_lastWebrtcExitReason` (~4495). Move each declaration's doc comment onto the corresponding `PeerRecord` field in `peer-record.ts` (condensed is fine; the invariant sentences must survive). Rewrite every site:

`_iceDisconnectedAt` → `iceDisconnectedAt`:
| Line | Current | Replacement |
|---|---|---|
| 963 | `delete this._iceDisconnectedAt[peer];` | `{ const r = this._peerRecords.get(peer); if (r) r.iceDisconnectedAt = undefined; }` |
| 1175 | `this._iceDisconnectedAt[pubKeyB64] = this.clock.now();` | `this._ensurePeerRecord(pubKeyB64).iceDisconnectedAt = this.clock.now();` |
| 1177 | `delete this._iceDisconnectedAt[pubKeyB64];` | clear pattern |
| 1629 | `if (plan.clearIceDisconnectedAt) delete this._iceDisconnectedAt[pubKeyB64];` | `if (plan.clearIceDisconnectedAt) { const r = this._peerRecords.get(pubKeyB64); if (r) r.iceDisconnectedAt = undefined; }` |
| 6422 | `disconnectedAt: this._iceDisconnectedAt[pubkeyB64],` | `disconnectedAt: this._peerRecords.get(pubkeyB64)?.iceDisconnectedAt,` |

`_reconcileAttemptCount` → `reconcileAttemptCount`:
| Line | Current | Replacement |
|---|---|---|
| 1628 | executor clear | clear pattern (guarded by `plan.clearReconcileAttemptCount`) |
| 5022 | `this._reconcileAttemptCount[pubkey] \|\| 0` | `this._peerRecords.get(pubkey)?.reconcileAttemptCount \|\| 0` |
| 5068, 5119 | `this._reconcileAttemptCount[pubkey] = reconcileCount + 1;` | `this._ensurePeerRecord(pubkey).reconcileAttemptCount = reconcileCount + 1;` |
| 5104 | `= 0` | `this._ensurePeerRecord(pubkey).reconcileAttemptCount = 0;` |

`_staleCycles` → `staleCycles`:
| Line | Current | Replacement |
|---|---|---|
| 1627 | executor clear | clear pattern |
| 4017 | `this._staleCycles[peerB64]?.audio ?? 0` | `this._peerRecords.get(peerB64)?.staleCycles?.audio ?? 0` |
| 5842 | `this._staleCycles[pubKeyB64] \|\| {...}` | `this._peerRecords.get(pubKeyB64)?.staleCycles \|\| { audio: 0, video: 0 }` |
| 5850, 5863 | writes | `this._ensurePeerRecord(pubKeyB64).staleCycles = ...` |

`_lastBytesReceived` → `lastBytesReceived`: same three shapes (1626 executor clear; 5841 read-with-default; 5846 write via ensure).

`_lastQualityBucket` → `qualityBucket`:
| Line | Current | Replacement |
|---|---|---|
| 1441 | `.delete(pubKeyB64)` (signals→webrtc CarrierSwitch site) | clear pattern |
| 1583 | executor `.delete` | clear pattern |
| 5562 | `.get(pubKeyB64)` | `this._peerRecords.get(pubKeyB64)?.qualityBucket` |
| 5564 | `.set(pubKeyB64, bucket)` | `this._ensurePeerRecord(pubKeyB64).qualityBucket = bucket;` |

`_lastWebrtcExitReason` → `webrtcExitReason`:
| Line | Current | Replacement |
|---|---|---|
| 1573 | `.get(pubKeyB64) ?? 'unknown'` | `this._peerRecords.get(pubKeyB64)?.webrtcExitReason ?? 'unknown'` |
| 1582 | executor `.delete` | clear pattern |
| 5666 | `.set(entry.remoteAgent, entry.trigger)` | `this._ensurePeerRecord(entry.remoteAgent).webrtcExitReason = entry.trigger;` |

- [ ] **Step 6: Re-point the wiring-test seed/assert for `_iceDisconnectedAt`**

`ui/src/__tests__/streams-store-wiring.test.ts`:
- line 512: `store._iceDisconnectedAt[peerA] = clock.now() - 1000;` → `store._ensurePeerRecord(peerA).iceDisconnectedAt = clock.now() - 1000;`
- line 535: `expect(store._iceDisconnectedAt[peerA]).toBeDefined();` → `expect(store._peerRecord(peerA)?.iceDisconnectedAt).toBeDefined();`

- [ ] **Step 7: Focused run**

Run: `nix develop -c npm run test -w ui -- src/__tests__/streams-store-wiring.test.ts`
Expected: PASS, same test count as baseline.

- [ ] **Step 8: Full gate**

Run: `nix develop -c npm run verify`
Expected: green, both typechecks clean (the deleted declarations must leave zero dangling references — `noUnusedLocals` is on).

- [ ] **Step 9: Commit**

```bash
git add ui/src/peer-record.ts ui/src/__tests__/peer-record.test.ts ui/src/streams-store.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "refactor: introduce PeerRecord; fold six numeric per-peer collections

Task 1 of docs/superpowers/plans/2026-09-02-peer-record-consolidation.md.
No behavior change."
```

---

### Task 2: Streams + establishment fold

**Files:**
- Modify: `ui/src/peer-record.ts` (add `prunePendingInits`)
- Modify: `ui/src/streams-store.ts`
- Modify: `ui/src/__tests__/streams-store-wiring.test.ts`
- Modify: `ui/src/__tests__/pending-handshake.test.ts`

**Interfaces:**
- Consumes: `_peerRecords` / `_peerRecord` / `_ensurePeerRecord`, `PeerRecord` (Task 1).
- Produces: `prunePendingInits(entries: PendingInit[], now: number, ttlMs: number): PendingInit[] | undefined` in `peer-record.ts` — returns `undefined` when nothing survives (the old Record-shape helper dropped empty rows; field-undefined is the fold's equivalent).

- [ ] **Step 1: Add `prunePendingInits` to `peer-record.ts`**

```ts
/**
 * Prune expired pending-init entries (PENDING_HANDSHAKE_TTL_MS sweep).
 * Returns undefined when none survive — the field-level equivalent of
 * the pre-fold pruneExpiredPending dropping empty rows.
 */
export function prunePendingInits(
  entries: PendingInit[],
  now: number,
  ttlMs: number,
): PendingInit[] | undefined {
  const remaining = entries.filter(e => now - e.t0 <= ttlMs);
  return remaining.length > 0 ? remaining : undefined;
}
```

- [ ] **Step 2: Migrate the prune table tests**

Rewrite `ui/src/__tests__/pending-handshake.test.ts` against `prunePendingInits`, preserving each case's semantics: fresh entries kept verbatim; expired entries dropped; all-expired returns `undefined`; boundary `now - t0 === ttl` kept (the old filter is `<=`); input array not mutated. Run it red first if written before Step 1 lands, then green:
`nix develop -c npm run test -w ui -- src/__tests__/pending-handshake.test.ts`

- [ ] **Step 3: Fold the five collections**

Delete declarations: `_videoStreams` (~3680), `_screenShareStreams` (~3685), `_screenShareIceDisconnectedAt` (~3632), `_pendingInits` (~3694), `_sdpTimeoutTimers` (~3559). Delete `pruneExpiredPending` (~246–258, now caller-less). Rewrites:

`_videoStreams` → `videoStream`:
| Line | Current | Replacement |
|---|---|---|
| 1598 | executor clear (guarded `plan.clearVideoStreamSlot`) | clear pattern |
| 1758 | `this._videoStreams[pubKeyB64] = stream;` | `this._ensurePeerRecord(pubKeyB64).videoStream = stream;` |
| 4930 | `getStreamInfo(this._videoStreams[agentB64])` | `getStreamInfo(this._peerRecords.get(agentB64)?.videoStream)` |
| 6044 | same shape | same replacement (key `pubkeyB64`) |

(If `getStreamInfo`'s parameter type rejects `undefined`, today's `Record` lookup already produced `undefined` at runtime — widen the parameter type to `MediaStream | undefined`, do not add a guard that changes behavior.)

`_screenShareStreams` → `screenShareStream`:
| Line | Current | Replacement |
|---|---|---|
| 1637 | `delete ...[pubKeyB64]` (executor, guarded `plan.clearScreenShareStream`) | clear pattern |
| 2043 | `= stream` | `this._ensurePeerRecord(pubKeyB64).screenShareStream = stream;` |
| 2565 | `this._screenShareStreams = {};` (disconnect) | see Step 4 |

`_screenShareIceDisconnectedAt` → `screenShareIceDisconnectedAt`:
| Line | Current | Replacement |
|---|---|---|
| 1303 | `= this.clock.now()` | write via ensure |
| 1305, 1631 | deletes | clear pattern |
| 6106, 6537 | reads | `this._peerRecords.get(pubkeyB64)?.screenShareIceDisconnectedAt` |

`_pendingInits` → `pendingInits`:
| Line | Current | Replacement |
|---|---|---|
| 1443 | `delete this._pendingInits[pubKeyB64];` | clear pattern |
| 1603 | executor clear | clear pattern |
| 2566 | `this._pendingInits = {};` (disconnect) | see Step 4 |
| 2757–2758 | `this._pendingInits = pruneExpiredPending(...)` | `for (const r of this._peerRecords.values()) { if (r.pendingInits) r.pendingInits = prunePendingInits(r.pendingInits, now, PENDING_HANDSHAKE_TTL_MS); }` |
| 4402–4406 | `this._pendingInits = peerB64 ? Object.fromEntries(Object.entries(this._pendingInits).filter(([k]) => k !== peerB64)) : {};` | `if (peerB64) { const r = this._peerRecords.get(peerB64); if (r) r.pendingInits = undefined; } else { for (const r of this._peerRecords.values()) r.pendingInits = undefined; }` — NOTE the current code is inverted vs. its look: `peerB64` set ⇒ keep only OTHER peers' entries... read it again before editing. It filters OUT `k !== peerB64`?? No: `.filter(([k]) => k !== peerB64)` KEEPS others, i.e. **deletes `peerB64`'s entry**; the no-arg branch clears all. The replacement above matches that. Verify against the surrounding method's intent before committing. |
| 6457 | read | `this._peerRecords.get(pubkeyB64)?.pendingInits` |
| 6478 | `this._pendingInits[pubkeyB64] = [...]` | `this._ensurePeerRecord(pubkeyB64).pendingInits = [...]` |
| 6705 | read | `this._peerRecords.get(pubKey64)?.pendingInits` |
| 6784 | `delete this._pendingInits[pubKey64];` | clear pattern |

`_sdpTimeoutTimers` → `sdpTimeoutTimer`:
| Line | Current | Replacement |
|---|---|---|
| 2509–2512 | disconnect loop + `= {}` | see Step 4 |
| 6800 | `const priorSdpTimer = this._sdpTimeoutTimers[pubKey64];` | `const priorSdpTimer = this._peerRecords.get(pubKey64)?.sdpTimeoutTimer;` |
| 6802 | `this._sdpTimeoutTimers[pubKey64] = this.clock.setTimeout(...)` | `this._ensurePeerRecord(pubKey64).sdpTimeoutTimer = this.clock.setTimeout(...)` |
| 6803 | `delete this._sdpTimeoutTimers[pubKey64];` (inside the timer body) | clear pattern |

- [ ] **Step 4: Rewrite `disconnect()`'s wipes with strict fidelity**

Replace the three wipe sites (2509–2512, 2565, 2566) with ONE block — placed where the timer loop is today, keeping the other two lines' positions vacated:

```ts
for (const r of this._peerRecords.values()) {
  if (r.sdpTimeoutTimer !== undefined) this.clock.clearTimeout(r.sdpTimeoutTimer);
  r.sdpTimeoutTimer = undefined;
  r.screenShareStream = undefined;
  r.pendingInits = undefined;
}
```

Do NOT clear any other field and do NOT `_peerRecords.clear()` — today's `disconnect()` leaves every other per-peer collection intact (spec, "Store integration").

- [ ] **Step 5: Re-point wiring-test sites**

`streams-store-wiring.test.ts`:
| Line | Current | Replacement |
|---|---|---|
| 456, 463 | `store._screenShareStreams[peerA]` | `store._peerRecord(peerA)?.screenShareStream` |
| 511 | `store._pendingInits[peerA] = [{...}];` | `store._ensurePeerRecord(peerA).pendingInits = [{...}];` |
| 534 | `expect(store._pendingInits[peerA]).toHaveLength(1);` | `expect(store._peerRecord(peerA)?.pendingInits).toHaveLength(1);` |
| 1070–1077 | `store._pendingInits = { [peerA]: [...] };` | `store._ensurePeerRecord(peerA).pendingInits = [...];` (same literal entries) |
| 1079, 1084 | asserts | `store._peerRecord(peerA)?.pendingInits` |
| 1695 | seed | `started.store._ensurePeerRecord(peerA).pendingInits = [...]` |

- [ ] **Step 6: Focused run**

Run: `nix develop -c npm run test -w ui -- src/__tests__/streams-store-wiring.test.ts src/__tests__/pending-handshake.test.ts`
Expected: PASS.

- [ ] **Step 7: Full gate** — `nix develop -c npm run verify`, green.

- [ ] **Step 8: Commit**

```bash
git add ui/src/peer-record.ts ui/src/streams-store.ts ui/src/__tests__/streams-store-wiring.test.ts ui/src/__tests__/pending-handshake.test.ts
git commit -m "refactor: fold stream/establishment per-peer collections into PeerRecord

Task 2. pruneExpiredPending becomes per-row prunePendingInits (peer-record.ts);
disconnect() wipes exactly the three fields it wiped before. No behavior change."
```

---

### Task 3: Objects + survivors fold

**Files:**
- Modify: `ui/src/streams-store.ts`
- Modify: `ui/src/__tests__/streams-store-wiring.test.ts`

**Interfaces:**
- Consumes: Task 1's map + helpers.
- Produces: nothing new — after this task NO folded collection remains; `grep -n '_iceDisconnectedAt\|_staleCycles\|_lastBytesReceived\|_videoStreams\|_screenShareStreams\|_pendingInits\|_sdpTimeoutTimers\|_lastDisconnectTime\|_lastReconcileTime\|_signalsRttEwma\|_connectionEpoch\|_peerAnalysers\|_peerAnalyserBuffers\|_outageStates\|_lastQualityBucket\|_lastWebrtcExitReason\|_reconcileAttemptCount\|_screenShareIceDisconnectedAt' ui/src/streams-store.ts` returns zero hits.

- [ ] **Step 1: Fold the analyser pair (merged field)**

Delete `_peerAnalysers` (~4458) and `_peerAnalyserBuffers` (~4459).
| Line | Current | Replacement |
|---|---|---|
| 1803 | `... && !this._peerAnalysers.has(pubKeyB64)` | `... && !this._peerRecords.get(pubKeyB64)?.analyser` |
| 4607–4608 (setup's cleanup) | two `.delete(pubKeyB64)` | `{ const r = this._peerRecords.get(pubKeyB64); if (r) r.analyser = undefined; }` |
| 4630–4631 | two `.set(...)` | `this._ensurePeerRecord(pubKeyB64).analyser = { node: analyser, buffer: new Uint8Array(analyser.fftSize) };` |
| 4641–4642 (`removePeerAudioAnalyser`) | two `.delete` | clear pattern (one statement) |
| 4651–4652 (`getWebrtcAudioLevel`) | two `.get` + `if (!analyser \|\| !buffer) return 0;` | `const a = this._peerRecords.get(pubKeyB64)?.analyser; if (!a) return 0;` then use `a.node` / `a.buffer` below |

- [ ] **Step 2: Fold `_outageStates` → `outageState`**

Delete declaration (~4576, keep its doc comment on the `PeerRecord` field).
| Line | Current | Replacement |
|---|---|---|
| 5745, 6135 | `.get(...)` | `this._peerRecords.get(peerB64)?.outageState` (6135: key `pubkeyB64`) |
| 5749 | `.set(peerB64, {...})` | `this._ensurePeerRecord(peerB64).outageState = { startedAt: now, emitted: false };` |
| 5794, 6145 | `.delete` | clear pattern |

- [ ] **Step 3: Fold the three close-survivors**

`_lastDisconnectTime` → `lastDisconnectTime` (delete ~3571):
| Line | Current | Replacement |
|---|---|---|
| 405 | `return this._lastDisconnectTime[peerB64] !== undefined;` | `return this._peerRecords.get(peerB64)?.lastDisconnectTime !== undefined;` |
| 1585 | `= this.clock.now()` (executor stamp, guarded `plan.recordLastDisconnect`) | `this._ensurePeerRecord(pubKeyB64).lastDisconnectTime = this.clock.now();` |
| 1592 | executor clear | clear pattern |
| 6469, 6577 | reads | `this._peerRecords.get(...)?.lastDisconnectTime` |

`_lastReconcileTime` → `lastReconcileTime` (delete ~3565): 1593 executor clear → clear pattern; 5024 read-with-`|| 0`; 5067/5118 writes via ensure.

`_signalsRttEwma` → `signalsRttEwma` (delete ~4478):
| Line | Current | Replacement |
|---|---|---|
| 1597 | executor `.delete` | clear pattern |
| 2784, 2957, 5288, 6244 | `.get(...)` | `this._peerRecords.get(...)?.signalsRttEwma` |
| 2909 | `.set(target, SIGNALS_RTT_DEGRADED_MS)` | `this._ensurePeerRecord(target).signalsRttEwma = SIGNALS_RTT_DEGRADED_MS;` |
| 6257 | `.set(pubkeyB64, rttFold.ewmaMs)` | write via ensure |

- [ ] **Step 4: Fold `_connectionEpoch` → `connectionEpoch`**

Delete declaration (~3584; move the monotonic-epoch doc comment onto the `PeerRecord` field — it is the record's most important invariant). Rewrite `_nextConnectionEpoch` (~3587–3591):

```ts
/** Allocate the next connection epoch for `peer` (monotonic, per session). */
private _nextConnectionEpoch(peer: AgentPubKeyB64): number {
  const r = this._ensurePeerRecord(peer);
  r.connectionEpoch += 1;
  return r.connectionEpoch;
}
```

- [ ] **Step 5: Re-point wiring-test survivor sites**

| Line | Current | Replacement |
|---|---|---|
| 536 | `expect(store._lastDisconnectTime[peerA]).toBeUndefined();` | `expect(store._peerRecord(peerA)?.lastDisconnectTime).toBeUndefined();` |
| 1796, 1815, 1816 | seeds `store._lastReconcileTime[peerA] = clock.now();` etc. | `store._ensurePeerRecord(peerA).lastReconcileTime = clock.now();` etc. |
| 1801–1802, 1810–1811, 1818–1819 | asserts | `store._peerRecord(peerA)?.lastDisconnectTime` / `?.lastReconcileTime` |
| ~1826/1852 region | `_signalsRttEwma` seeds (find the `.set(` calls in those tests) | `store._ensurePeerRecord(peerA).signalsRttEwma = <same value>;` |

- [ ] **Step 6: Verify no folded collection remains**

Run the grep from this task's Produces block. Expected: zero hits in `ui/src/streams-store.ts`.

- [ ] **Step 7: Focused + full gate** — wiring suite, then `nix develop -c npm run verify`. Green.

- [ ] **Step 8: Commit**

```bash
git add ui/src/peer-record.ts ui/src/streams-store.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "refactor: fold analyser/outage/survivor collections into PeerRecord

Task 3. All 17 per-peer collections now live on the one record; the three
close-survivors and the never-reset connectionEpoch keep their lifecycles
via the existing closeCleanupPlan booleans (collapsed in Task 4). No
behavior change."
```

---

### Task 4: Lifecycle collapse — `resetPeerRecord` + `closeCleanupPlan` rewrite

**Files:**
- Modify: `ui/src/peer-record.ts` (add `PeerRecordResetArm`, `resetPeerRecord`)
- Modify: `ui/src/__tests__/peer-record.test.ts` (arm × field tables)
- Modify: `ui/src/transport/close-cleanup-policy.ts`
- Modify: `ui/src/transport/__tests__/close-cleanup-policy.test.ts` (the table test); check `ui/src/transport/__tests__/stale-connection-policy.test.ts` too — it also references `closeCleanupPlan`
- Modify: `ui/src/streams-store.ts` (`_applyCloseCleanup`, ~1570–1640 pre-shift)

**Interfaces:**
- Consumes: `PeerRecord`, Task 3's fully-folded store.
- Produces:
  - `PeerRecordResetArm = 'media-close-full' | 'media-stale-residue' | 'media-leave-residue' | 'screen-out-close' | 'screen-in-close'`
  - `resetPeerRecord(r: PeerRecord, arm: PeerRecordResetArm): PeerRecord` (pure, returns a new object)
  - `CloseCleanupPlan.recordReset: PeerRecordResetArm | 'none'` replacing the 14 booleans: `clearVideoStreamSlot, clearPendingInits, clearLastBytesReceived, clearStaleCycles, clearReconcileAttemptCount, clearIceDisconnectedAt, clearQualityBucket, clearWebrtcExitReason, clearLastDisconnectTime, clearLastReconcileTime, clearSignalsRttEwma, clearScreenShareStream, clearScreenShareIceDisconnectedAt, removeAudioAnalyser`. KEEP: `reason, logSuperseded, closeTransport, clearSlot, clearIceTiming, emitIceNeverConnected, recordLastDisconnect, clearPerceivedStreamInfo, clearWebrtcStats, emitCarrierSwitch, teardownOutgoingScreenShare, fireEvent, setDisconnectedStatus`.

- [ ] **Step 1: Write the failing arm tables in `peer-record.test.ts`**

```ts
import { initialPeerRecord, resetPeerRecord, type PeerRecord } from '../peer-record';

function fullRecord(): PeerRecord {
  return {
    iceDisconnectedAt: 1, lastBytesReceived: { audio: 2, video: 3 },
    staleCycles: { audio: 4, video: 5 }, reconcileAttemptCount: 6,
    qualityBucket: 'poor', webrtcExitReason: 'ice-failed',
    videoStream: {} as MediaStream, pendingInits: [{ connectionId: 'c', t0: 7 }],
    sdpTimeoutTimer: 8, analyser: { node: {} as AnalyserNode, buffer: new Uint8Array(1) },
    outageState: { startedAt: 9, emitted: true },
    screenShareStream: {} as MediaStream, screenShareIceDisconnectedAt: 10,
    lastDisconnectTime: 11, lastReconcileTime: 12, signalsRttEwma: 13,
    connectionEpoch: 14,
  };
}

describe('resetPeerRecord', () => {
  it('media-close-full wipes the media session, keeps survivors, screen state, timer, outage, epoch', () => {
    const r = resetPeerRecord(fullRecord(), 'media-close-full');
    for (const f of ['iceDisconnectedAt','lastBytesReceived','staleCycles','reconcileAttemptCount','qualityBucket','webrtcExitReason','videoStream','pendingInits','analyser'] as const)
      expect(r[f], f).toBeUndefined();
    expect(r.sdpTimeoutTimer).toBe(8);       // executor-owned, not arm-owned
    expect(r.outageState).toEqual({ startedAt: 9, emitted: true }); // sweep-owned
    expect(r.screenShareStream).toBeDefined();
    expect(r.screenShareIceDisconnectedAt).toBe(10);
    expect(r.lastDisconnectTime).toBe(11);   // close survivor
    expect(r.lastReconcileTime).toBe(12);
    expect(r.signalsRttEwma).toBe(13);
    expect(r.connectionEpoch).toBe(14);      // session survivor
  });
  it('media-stale-residue wipes only videoStream + pendingInits', () => {
    const r = resetPeerRecord(fullRecord(), 'media-stale-residue');
    expect(r.videoStream).toBeUndefined();
    expect(r.pendingInits).toBeUndefined();
    expect(r.staleCycles).toBeDefined();
    expect(r.lastDisconnectTime).toBe(11);
  });
  it('media-leave-residue additionally wipes qualityBucket and the three close-survivors, never epoch', () => {
    const r = resetPeerRecord(fullRecord(), 'media-leave-residue');
    for (const f of ['videoStream','pendingInits','qualityBucket','lastDisconnectTime','lastReconcileTime','signalsRttEwma'] as const)
      expect(r[f], f).toBeUndefined();
    expect(r.iceDisconnectedAt).toBe(1);     // outer leave row's residue only; nested close row did the rest
    expect(r.connectionEpoch).toBe(14);
  });
  it('screen-out-close wipes only screenShareIceDisconnectedAt', () => {
    const r = resetPeerRecord(fullRecord(), 'screen-out-close');
    expect(r.screenShareIceDisconnectedAt).toBeUndefined();
    expect(r.screenShareStream).toBeDefined();
  });
  it('screen-in-close wipes only screenShareStream', () => {
    const r = resetPeerRecord(fullRecord(), 'screen-in-close');
    expect(r.screenShareStream).toBeUndefined();
    expect(r.screenShareIceDisconnectedAt).toBe(10);
  });
  it('does not mutate its input', () => {
    const input = fullRecord();
    resetPeerRecord(input, 'media-close-full');
    expect(input.videoStream).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (`resetPeerRecord` not exported).**

- [ ] **Step 3: Implement `resetPeerRecord` in `peer-record.ts`**

```ts
export type PeerRecordResetArm =
  | 'media-close-full'
  | 'media-stale-residue'
  | 'media-leave-residue'
  | 'screen-out-close'
  | 'screen-in-close';

/**
 * The ONE authority for which PeerRecord fields survive which teardown.
 * Arms mirror closeCleanupPlan's distinct per-peer clear signatures
 * (strict fidelity to the pre-fold table — see the design spec's
 * mapping rules). sdpTimeoutTimer and outageState are never arm-owned:
 * the timer is executor-disarmed, the outage state sweep-owned.
 */
export function resetPeerRecord(r: PeerRecord, arm: PeerRecordResetArm): PeerRecord {
  switch (arm) {
    case 'media-close-full':
      return {
        ...r,
        iceDisconnectedAt: undefined, lastBytesReceived: undefined,
        staleCycles: undefined, reconcileAttemptCount: undefined,
        qualityBucket: undefined, webrtcExitReason: undefined,
        videoStream: undefined, pendingInits: undefined, analyser: undefined,
      };
    case 'media-stale-residue':
      return { ...r, videoStream: undefined, pendingInits: undefined };
    case 'media-leave-residue':
      return {
        ...r, videoStream: undefined, pendingInits: undefined,
        qualityBucket: undefined, lastDisconnectTime: undefined,
        lastReconcileTime: undefined, signalsRttEwma: undefined,
      };
    case 'screen-out-close':
      return { ...r, screenShareIceDisconnectedAt: undefined };
    case 'screen-in-close':
      return { ...r, screenShareStream: undefined };
    default: {
      const exhaustive: never = arm;
      return exhaustive;
    }
  }
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Rewrite `closeCleanupPlan`**

In `close-cleanup-policy.ts`: import `type { PeerRecordResetArm } from '../peer-record'`; replace the 14 booleans in `CloseCleanupPlan` with `recordReset: PeerRecordResetArm | 'none'`; set `recordReset: 'none'` in `NONE`. Row mapping (strict fidelity — each row's old boolean set must equal its arm's field set exactly; if any mismatch is found, STOP and add a narrower arm rather than approximating):

| Row (`reason`) | recordReset |
|---|---|
| `media-close` (MEDIA_FULL) | `'media-close-full'` (its old booleans: videoStream+pendingInits+lastBytes+staleCycles+reconcileCount+iceDisconnectedAt+qualityBucket+webrtcExitReason+analyser = the arm, exactly) |
| `media-close-superseded`, `media-close-duplicate` | `'none'` (keep `clearIceTiming`/`logSuperseded` as-is) |
| `media-stale` | `'media-stale-residue'` |
| `media-stale-unreachable` | `'none'` |
| `media-leave` | `'media-leave-residue'` |
| `media-leave-no-slot` | `'media-leave-residue'` |
| `media-leave-unreachable` | `'none'` |
| `screen-out-close` | `'screen-out-close'` |
| `screen-out-close-guarded`, `screen-out-stale*`, `screen-out-leave*` | `'none'` (the leave/stale rows close the transport; the nested close-event row carries the arm — exactly as the booleans work today) |
| `screen-in-close` | `'screen-in-close'` |
| `screen-in-leave`, `screen-in-leave-no-slot` | `'screen-in-close'` (both had `clearScreenShareStream: true`) |
| every other row | `'none'` |

Update the file's header comment: the per-peer clear set now lives in `resetPeerRecord` (`peer-record.ts`); this table names WHICH arm runs and keeps the routing/ordering/event fields.

- [ ] **Step 6: Rewrite the executor `_applyCloseCleanup`**

Replace the run of `if (plan.clearX) ...` per-peer statements with, in this order (preserving today's ordering semantics — forensic reads before wipes):
1. existing `logSuperseded` / `emitCarrierSwitch` handling unchanged — the CarrierSwitch emit already reads `webrtcExitReason` BEFORE any clear (pre-fold line 1573 vs 1582; keep that read above the reset);
2. existing `emitIceNeverConnected` → `clearIceTiming` order unchanged;
3. `if (plan.recordLastDisconnect) this._ensurePeerRecord(pubKeyB64).lastDisconnectTime = this.clock.now();`
4. ```ts
   if (plan.recordReset !== 'none') {
     const r = this._peerRecords.get(pubKeyB64);
     if (r) this._peerRecords.set(pubKeyB64, resetPeerRecord(r, plan.recordReset));
   }
   ```
5. everything else (`clearSlot`, `clearPerceivedStreamInfo`, `clearWebrtcStats`, events, statuses) unchanged.

Ordering note: on `media-leave`/live the nested close-event row stamps `lastDisconnectTime` (step 3) during the transport close, and the OUTER leave row's `media-leave-residue` reset then wipes it — same delete-wins outcome as today's boolean pair, already pinned in the wiring suite (lines ~1796–1819).

The `removeAudioAnalyser` boolean's executor call (`removePeerAudioAnalyser`) is deleted; the arm's `analyser: undefined` replaces it (reference-dropping is the entire teardown — spec amendment).

- [ ] **Step 7: Update the close-cleanup table test row-for-row**

In `ui/src/transport/__tests__/close-cleanup-policy.test.ts` (and any affected assertions in `ui/src/transport/__tests__/stale-connection-policy.test.ts`): for each row assertion, replace the boolean-set expectations with the `recordReset` arm from Step 5's table. The survivor pins (close keeps `lastDisconnectTime`/`lastReconcileTime`/`signalsRttEwma`; leave clears them) are now carried by `peer-record.test.ts`'s arm tables (Task 4 Step 1) — cross-reference them in a comment, don't duplicate.

- [ ] **Step 8: Focused + full gate**

Run: `nix develop -c npm run test -w ui -- src/__tests__/peer-record.test.ts src/__tests__/streams-store-wiring.test.ts` plus the close-cleanup table test, then `nix develop -c npm run verify`. Green; wiring assertions unchanged in meaning.

- [ ] **Step 9: Commit**

```bash
git add ui/src/peer-record.ts ui/src/__tests__/peer-record.test.ts ui/src/transport/close-cleanup-policy.ts ui/src/streams-store.ts ui/src/transport/__tests__/close-cleanup-policy.test.ts ui/src/transport/__tests__/stale-connection-policy.test.ts
git commit -m "refactor: collapse closeCleanupPlan per-peer clears into resetPeerRecord arms

Task 4. The field-level teardown knowledge moves to the one pure
resetPeerRecord (peer-record.ts, table-tested); the plan keeps routing,
ordering, and events. Strict-fidelity row mapping. No behavior change."
```

---

### Task 5: Doc-sync

**Files:**
- Modify: `CLAUDE.md` (repo root, this branch)
- Modify: `docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md`
- Modify: `docs/superpowers/plans/2026-09-02-peer-record-consolidation.md` (this file)

**Interfaces:** none — prose only.

- [ ] **Step 1: Add the round's fact bullet to CLAUDE.md's "True today" section**

Follow the existing bullets' contract exactly: anchor to the merge date, name enforcing files/tests for present-tense claims, no counters, no unanchored negations. Content to record: `ui/src/peer-record.ts` is the one per-peer state record (`PeerRecord`, `Map` on `StreamsStore._peerRecords`); the 17 folded collections are deleted; `resetPeerRecord` is the one teardown-survivor authority (pinned by `ui/src/__tests__/peer-record.test.ts`); `closeCleanupPlan` names arms, not field clears; record existence is never a liveness predicate (documented on the field); `connectionEpoch` monotonic-per-session semantics unchanged; zero declared behavior changes.

- [ ] **Step 2: Mark the spec's task plan landed**

Add "landed" markers per task (working agreement 3 — a design doc marks each item landed once it ships). Record in the spec's "Next steps" that they remain open: round two (concern extraction), optional forensic fold, reactive unification.

- [ ] **Step 3: Note the branch-line decision**

In the spec header: the round was built on `main-0.7` (user decision 2026-09-02, superseding the handoff's 0.6-first practice); the handoff doc `docs/superpowers/plans/2026-09-02-store-decomposition-handoff.md` lives on `main-0.6` and gets its status note when this round merges (post-merge step, main checkout).

- [ ] **Step 4: Run the drift guard + full gate**

`nix develop -c npm run test -w ui -- src/__tests__/claude-md-drift.test.ts`, then `nix develop -c npm run verify`. Green.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-02-peer-record-consolidation-design.md docs/superpowers/plans/2026-09-02-peer-record-consolidation.md
git commit -m "docs: sync CLAUDE.md and round docs for PeerRecord consolidation"
```

---

## Deliberately out of scope (from the spec)

Reactive `Writable` replacement; concern extraction (round two); `_iceTimings` / `_sdpDataAggregates` fold; any behavior change. `_conversationParticipants` and `_lastPresenceSet` stay — membership sets, not per-peer rows.

## Notes for reviewers

- The review question per task is "prove this is identity", not "is this right". Diff every rewritten site against the access-pattern table; anything that adds a guard, drops a default, or turns a read into an `_ensurePeerRecord` call changes behavior.
- Task 2's `disconnect()` block and Task 4's row mapping are where infidelity would hide — check them against the pre-fold code at `cd60a69`, not against the plan's prose.
- Reads must never create rows: grep the diff for `_ensurePeerRecord` and confirm every call site is a write path.
- Adversarial review per task by a session that did not write it (working agreement 9); final whole-branch review before merge.
