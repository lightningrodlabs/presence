# Connection-Thrash Fixes Implementation Plan

**Status: Tasks 1-10 landed on `main-0.6` as of this doc-sync merge (2026-08-12); Task 11 (forward-port to `main-0.7`) pending.** See `CLAUDE.md`'s "Connection-thrash round facts" bullet for the doc-sync summary.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the two mechanisms behind the 2026-08-11 field thrash (the `Presence_merged_0.15.0` five-peer session): the same-epoch session-staleness deadlock in `@lightningrodlabs/webrtc-peer`, and the unthrottled voice/filmstrip-over-signals load that collapses the Holochain remote-signal channel and drives presence/retry flapping.

**Architecture:** Library fixes first (session identity, retry-limit edge, candidate hygiene, retry backoff — each a small pinned change in `packages/webrtc-peer`, released as 0.5.0). Then app-side congestion control as pure decision functions per repo convention (`decideSignalsMediaCadence`, `decideSignalCarrier`), wired into the voice/filmstrip senders and `computePresentPeers`. Every behavior change lands with a table-driven test, and the CLAUDE.md fact bullets get a closing doc-sync commit.

**Tech Stack:** TypeScript, vitest (node env, mock RTCPeerConnection for the library; wiring suite + fakes for the store), Playwright nightly harness, npm workspaces.

## Context: validated diagnosis (read before executing)

Field evidence (three merged diagnostic logs, 2026-08-11) and code reading agree on this chain:

1. **Deadlock (library).** `peer-connection-fsm.ts:716-738` `_validateSignalSession` drops any non-offer whose `peerSessionId` is below `_session.remote`. `_session.remote` is never reset for the life of the FSM. The manager's closed-FSM replacement (`connection-manager.ts:397-405`) and the FSM's own `retry budget exhausted` path let the *remote* side recreate its FSM **at the same epoch** with `peerSessionId` restarted at 0. Result in the field: one side latched `_session.remote = 11`, the other side's fresh answers/candidates arrived as session 1-3 and were all dropped (`Dropped stale candidate: remote session 1 < current 11`, dozens of occurrences). Offers still pass, so the wedge hits exactly when the surviving side is the answerer — documented as defect D2 in `docs/WEBRTC_RECONNECT_IDENTITY.md:242-244`. The epoch mechanism (§7 of that doc) was built to fix this class but step 4 ("peerSessionId ordering becomes a sub-order under epoch") **was never implemented**: `handleRemoteSignal` stores `remoteEpoch` for diagnostics only (`peer-connection-fsm.ts:328-330`) and runs the session filter unconditionally.
2. **Refused give-up (library).** `disconnected` → `failed` is not in `VALID_TRANSITIONS` (`types.ts:59`), so the retry-limit guard at `peer-connection-fsm.ts:606-608` logs `BLOCKED: disconnected retry limit reached` and the transition is refused — visible verbatim in the field log. The manager's deferred cleanup happens to close it anyway, but the FSM emits no `failed` phase.
3. **Congestion engine (app).** Voice-over-signals sends one zome call per 20 ms Opus chunk (50/s, `voice.ts:428`), each carrying 3 frames of RED-in-base64; filmstrip adds up to 7/s. There is **no backpressure anywhere** — `_signalsRttEwma` exists (`streams-store.ts:4137`) but is display-only. Field RTT EWMAs reached 44-58 s.
4. **Presence flap feedback loop (app).** `computePresentPeers` (`presence-policy.ts:165-192`) sees only local ping-freshness (6 s window) and media-liveness (3 s window); a relay outage kills both. `_signalCarrierDownSince` (`streams-store.ts:4161`) already detects "no pong from ANY peer = channel evidence, not peer evidence" but is forensic-only. Worse, `_signalsTargets` derives from `_presentPeers`, so dropping a peer stops sending them media, guaranteeing they drop us too.
5. **Candidate spam (library).** One signal per trickled candidate, no dedupe, no filtering (`rtc-peer.ts:464-486`); every retry session re-floods ~35 candidates including useless `host tcp <addr>:9` active-TCP candidates.
6. **Retry pacing (both).** The FSM's disconnected auto-retry uses flat 500-2000 ms jitter (`peer-connection-fsm.ts:615`), and the app's adaptive SDP timeout (`streams-store.ts:_computeSdpTimeout`, K=20, floor 5 s) is capped at the 15 s default ceiling — the field sat at that ceiling for 8+ consecutive timeouts.

**Prior agent's recommendations, disposition:** #1 (session deadlock) confirmed, sharpened to the epoch sub-order fix. #2 (voice throttle) confirmed, highest-leverage. #3 (adaptive timeouts/backoff) partially exists; re-scoped to ceiling raise + FSM backoff. #4 (candidate hygiene) confirmed; note package-core *negotiation* coalescing was tried and reverted (`docs/WEBRTC_CONNECTION_PLAN.md:375-395`) — candidate filtering/dedup is a different, safe change; candidate *batching* is deferred (wire-format change requiring a cap). #5 (freeze presence on carrier-down) confirmed, implemented as an input to the one authority `computePresentPeers`, bounded. #6 (diagnostics over data channels) **rejected for now** — the field logs show `dc=-1` in every establishment timeline (data channels never opened) and the unreachable peer had WebRTC disabled entirely; replaced by an RTT-scaled diagnostic timeout. #7 (TURN deprioritized) agreed — every ICE success in the logs was `relay=false`.

**Field-build provenance (resolved 2026-08-11):** the field build is the `v0.15.0` tag (`3c2320e`, `origin/release/0.15.0`), cut from `main-0.7` at `d9c24d3` — the first release of the Holochain 0.7 line. Its `ui/src` differs from `main-0.6` only in `types.ts` (client-stack migration) and its declared wire surface is unchanged from 0.14.9, so everything this plan analyzes on `main-0.6` is what ran in the field. The puzzling log line `FsmError Rejected data channel transport with mid=2; slot=live` is not unknown code: `Rejected data channel transport with mid=2` is a Chromium/libwebrtc SDP-apply exception message surfaced verbatim by the Round 3 forensic error forwarding, and `; slot=live` is the store's attribution suffix (`streams-store.ts:1726`). It is log-only by design and is a downstream symptom of the same negotiation churn Tasks 1 and 4 reduce — a watch-item after the fixes land, not a separate task. Fixes land on `main-0.6`, merge forward to `main-0.7`, and ship as 0.15.1.

## Global Constraints

- Target branch: `main-0.6` (the shipping line); `main-0.7` picks the fixes up by merge.
- One intent per branch (working agreement 6); merge `--no-ff`; each branch gets an adversarial review by a session that did not write it (working agreement 9).
- Decisions are pure functions: snapshot in, tagged union out, carrying a `reason` (`ui/src/transport/media-event-policy.ts` is the template). No mocks in policy tests; table-driven.
- No new threshold without a named predicate, and every new constant states which predicate/clock it serves (working agreement 2). Cadence/hold constants below are declared NOT-liveness.
- Replace or declare (working agreement 1): promoting `_signalCarrierDownSince` deletes the inline forensic predicate; nothing runs "in parallel with" an existing authority.
- Gate: `nix develop -c npm run verify` green before every commit claim; library tests via `npm test -w packages/webrtc-peer`.
- All timing in the store goes through `this.clock`; policy functions take `now` as input (no-ambient-clock pin).
- Library changes get a CHANGELOG row per change; version bump to 0.5.0 happens once, in Task 5.
- Commit messages: no Claude co-authored footer. Fix commits name the symptom's previous fixes where applicable ("supersedes" per working agreement 8).
- CLAUDE.md "True today" bullets are updated only in the closing doc-sync task (Task 10), per the drift-gate contract.

---

### Task 1: Library — same-epoch session identity fix (the deadlock)

**Branch:** `fix/session-relatch-on-remote-fsm-recreate`

**Files:**
- Modify: `packages/webrtc-peer/src/peer-connection-fsm.ts` (`_validateSignalSession` ~:716, `handleRemoteSignal` ~:333, `_session` ~:196, offer latch ~:373)
- Test: `packages/webrtc-peer/src/__tests__/peer-connection-fsm.test.ts` (extend `signal session validation` describe, ~:863)
- Test: `packages/webrtc-peer/src/__tests__/connection-manager.test.ts` (extend `epoch ordering` describe, ~:378)
- Modify: `packages/webrtc-peer/CHANGELOG.md`
- Modify: `docs/WEBRTC_RECONNECT_IDENTITY.md` (mark §7 step 4 landed)

**Interfaces:**
- Produces: `_validateSignalSession(signal, remotePeerSessionId, remoteConnectionId): 'accept' | 'update' | 'drop' | 'relatch'` (private; behavior visible through `handleRemoteSignal`). New private field `_abandonedRemoteConnectionIds: Set<string>`.
- Consumes: existing `handleRemoteSignal(signal, remoteConnectionId, remotePeerSessionId, remoteEpoch)` plumbing — `remoteConnectionId` is already a parameter on every call.

**Design (the fix, precisely):** `_session.remote` is a counter in the *remote FSM's* namespace. It is only comparable while the remote FSM is the same one we latched (`_remoteConnectionId`). A non-offer arriving with a **different** remote connectionId is either (a) a fresh remote FSM whose counter restarted — re-latch and accept — or (b) a resurrected signal from a remote FSM we already abandoned — drop via tombstone. ConnectionIds are `crypto.randomUUID()`, so a dead FSM cannot mint new ones; the tombstone set makes re-latching deterministic against reordered stale bursts (the D2 hazard). Offer handling is unchanged except that latching a new id tombstones the old one. Cross-epoch routing in the manager is untouched — this closes the *equal-epoch* hole.

- [ ] **Step 1: Write the failing FSM test**

In `peer-connection-fsm.test.ts` inside the `signal session validation` describe (follow the setup pattern of the existing `drops stale non-offer signals` test at ~:864 — same helper that constructs an FSM with the mock pc and feeds `handleRemoteSignal`):

```ts
it('re-latches when the remote FSM was recreated (non-offer with new remoteConnectionId and regressed session)', async () => {
  const fsm = makeFsm(); // existing helper in this describe
  // Latch remote FSM "A" at a high session via an offer.
  await fsm.handleRemoteSignal({ type: 'offer', sdp: 'v=0...' }, 'remote-A', 11, undefined);
  // Remote side recreated its FSM at the same epoch: new id, counter restarted.
  await fsm.handleRemoteSignal({ candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host' }, 'remote-B', 1, undefined);
  // Must NOT log a stale drop; the candidate must reach the peer.
  expect(transitionLog().some(t => t.trigger.includes('Dropped stale'))).toBe(false);
  expect(mockPc.addedCandidates.length).toBe(1); // or the equivalent observable in test-helpers
});

it('still drops non-offers from an abandoned (tombstoned) remote FSM', async () => {
  const fsm = makeFsm();
  await fsm.handleRemoteSignal({ type: 'offer', sdp: 'v=0...' }, 'remote-A', 3, undefined);
  await fsm.handleRemoteSignal({ type: 'offer', sdp: 'v=0...' }, 'remote-B', 1, undefined); // remote recreated; A is now abandoned
  await fsm.handleRemoteSignal({ candidate: 'candidate:...' }, 'remote-A', 3, undefined);   // resurrected dead burst
  expect(transitionLog().some(t => t.trigger.includes('Dropped stale candidate'))).toBe(true);
});
```

Adjust helper/observable names to what the existing describe actually uses — read those tests first; do not invent new harness machinery.

- [ ] **Step 2: Run tests to verify the first fails and the second's setup works**

Run: `npm test -w packages/webrtc-peer -- -t 'signal session validation'`
Expected: new re-latch test FAILS (currently logs `Dropped stale candidate: remote session 1 < current 11`).

- [ ] **Step 3: Implement**

In `peer-connection-fsm.ts`:

```ts
// near _session (~:196)
private _abandonedRemoteConnectionIds = new Set<string>();
```

Rewrite `_validateSignalSession` (keep the docblock, extend the Rules list):

```ts
private _validateSignalSession(
  signal: RTCSessionDescriptionInit | RTCIceCandidateInit,
  remotePeerSessionId: number | undefined,
  remoteConnectionId: string | undefined,
): 'accept' | 'update' | 'drop' | 'relatch' {
  const sessionId = remotePeerSessionId ?? 0;
  const isOffer = 'type' in signal && signal.type === 'offer';
  if (isOffer) {
    return sessionId > this._session.remote ? 'update' : 'accept';
  }
  // The remote session counter is only ordered WITHIN one remote FSM
  // (identified by its connectionId). A different id at the same epoch is a
  // recreated remote FSM whose counter restarted — comparing across
  // namespaces is the deadlock this guards against
  // (docs/WEBRTC_RECONNECT_IDENTITY.md §7 step 4, D2).
  if (
    remoteConnectionId &&
    this._remoteConnectionId !== null &&
    remoteConnectionId !== this._remoteConnectionId
  ) {
    if (this._abandonedRemoteConnectionIds.has(remoteConnectionId)) {
      const signalType = 'type' in signal ? signal.type : 'candidate';
      this._logTransition(
        `Dropped stale ${signalType}: abandoned remote connection ${remoteConnectionId.slice(0, 8)}`,
      );
      return 'drop';
    }
    return 'relatch';
  }
  if (sessionId < this._session.remote) {
    const signalType = 'type' in signal ? signal.type : 'candidate';
    this._logTransition(
      `Dropped stale ${signalType}: remote session ${sessionId} < current ${this._session.remote}`,
    );
    return 'drop';
  }
  return sessionId > this._session.remote ? 'update' : 'accept';
}
```

At the call site (~:333), thread the id and handle `relatch`:

```ts
const validation = this._validateSignalSession(signal, remotePeerSessionId, remoteConnectionId);
if (validation === 'drop') return;
if (validation === 'relatch') {
  if (this._remoteConnectionId) this._abandonedRemoteConnectionIds.add(this._remoteConnectionId);
  this._remoteConnectionId = remoteConnectionId ?? null;
  this._session.remote = remotePeerSessionId ?? 0;
  this._logTransition(
    `Re-latched remote connection ${remoteConnectionId?.slice(0, 8)} at session ${this._session.remote}`,
  );
} else if (validation === 'update') {
  this._session.remote = remotePeerSessionId ?? 0;
}
```

At the existing offer latch (~:373-375), when `_remoteConnectionId` changes, tombstone the previous id before overwriting (same `_abandonedRemoteConnectionIds.add(...)` line).

- [ ] **Step 4: Run the full library suite**

Run: `npm test -w packages/webrtc-peer`
Expected: PASS, including the pre-existing `CONTRAST: without epochs...` test at `connection-manager.test.ts:475` (read its assertions; if it pinned the old drop behavior for the cross-FSM case, update its name/assertions to pin the new re-latch behavior and say so in the commit message — this is a declared behavior change, not a regression).

- [ ] **Step 5: Add the manager-level end-to-end test**

In `connection-manager.test.ts`, `epoch ordering` describe, add the field scenario (two managers, same epoch; follow the two-manager plumbing already used there):

```ts
it('same epoch: peer whose FSM was recreated (closed-FSM replacement) can still deliver answers', async () => {
  // A and B connected attempt at epoch 5. B's FSM closes (retry budget) and a
  // late signal from A recreates it via the closed-FSM path at the same epoch.
  // B's fresh answers (peerSessionId 1) must be accepted by A's long-lived FSM
  // whose _session.remote latched a higher value.
  ...
  expect(aTransitions.some(t => t.trigger.includes('Dropped stale answer'))).toBe(false);
});
```

Run: `npm test -w packages/webrtc-peer` — Expected: PASS.

- [ ] **Step 6: CHANGELOG + doc, commit**

CHANGELOG (Unreleased): `Fixed: equal-epoch session-staleness deadlock — the remote peerSessionId counter is now scoped to the remote FSM's connectionId; a recreated remote FSM re-latches instead of having its answers/candidates dropped as stale, with tombstones preventing resurrected dead-session signals (WEBRTC_RECONNECT_IDENTITY.md §7 step 4, defect D2).`

Mark §7 step 4 as landed in `docs/WEBRTC_RECONNECT_IDENTITY.md` (design doc item-status rule, working agreement 3).

```bash
git add packages/webrtc-peer docs/WEBRTC_RECONNECT_IDENTITY.md
git commit -m "fix(webrtc-peer): re-latch remote session identity when the remote FSM is recreated at the same epoch

Closes the field deadlock from 2026-08-11 (Dropped stale answer: remote
session 1 < current 11). Supersedes the epoch routing fix's manager-level
half; implements WEBRTC_RECONNECT_IDENTITY.md §7 step 4."
```

---

### Task 2: Library — allow `disconnected → failed` (the refused give-up)

**Branch:** `fix/disconnected-failed-edge`

**Files:**
- Modify: `packages/webrtc-peer/src/types.ts:59` (`VALID_TRANSITIONS.disconnected`)
- Test: `packages/webrtc-peer/src/__tests__/peer-connection-fsm.test.ts` (`valid transitions` ~:85 and `reconnection` ~:410 describes)
- Modify: `packages/webrtc-peer/CHANGELOG.md`

**Interfaces:**
- Produces: `VALID_TRANSITIONS.disconnected = ['signaling', 'idle', 'failed', 'closed']`. Downstream, the app's `routeTransportPhase` already clears the slot on `failed` — no app change needed.

- [ ] **Step 1: Write the failing test**

```ts
it('gives up cleanly: retry limit reached in disconnected transitions to failed (not BLOCKED)', () => {
  const fsm = makeFsm({ reconnectPolicy: { ...DEFAULT, maxAttempts: 0 } }); // or drive _disconnectedRetryCount via repeated timeouts
  driveTo(fsm, 'disconnected');
  // entering disconnected with the limit hit must reach failed
  expect(fsm.state).toBe('failed');
  expect(transitionLog().some(t => t.trigger.startsWith('BLOCKED:'))).toBe(false);
});
```

Use the existing state-driving helpers from the `reconnection` describe (~:410) rather than new machinery.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w packages/webrtc-peer -- -t 'gives up cleanly'`
Expected: FAIL — state stays `disconnected`, log contains `BLOCKED: disconnected retry limit reached`.

- [ ] **Step 3: Implement**

`types.ts:59`: `disconnected: ['signaling', 'idle', 'failed', 'closed'],`

- [ ] **Step 4: Run full library suite** — `npm test -w packages/webrtc-peer`, expected PASS (check the `invalid transitions (blocked)` describe ~:348 for a test that pinned the old table; update it as a declared change if so).

- [ ] **Step 5: CHANGELOG + commit**

CHANGELOG: `Fixed: the disconnected-state retry-limit give-up was an illegal transition (logged BLOCKED and left a dead FSM in disconnected); disconnected → failed is now a valid edge, so the manager emits connection-closed through the normal path.`

```bash
git add packages/webrtc-peer
git commit -m "fix(webrtc-peer): allow disconnected->failed so the retry-limit give-up is not BLOCKED"
```

---

### Task 3: Library — outbound candidate hygiene (filter + dedupe)

**Branch:** `feat/candidate-hygiene`

**Files:**
- Modify: `packages/webrtc-peer/src/rtc-peer.ts` (`icecandidate` listener, ~:464-486)
- Test: `packages/webrtc-peer/src/__tests__/rtc-peer.test.ts`
- Modify: `packages/webrtc-peer/CHANGELOG.md`

**Interfaces:**
- Produces: exported pure predicate `shouldTrickleCandidate(candidate: RTCIceCandidateInit, alreadySent: ReadonlySet<string>): { send: true } | { send: false; reason: 'tcp-active' | 'duplicate' }` from `rtc-peer.ts` (exported for tests). End-of-candidates marker (`{ candidate: '' }`) is never filtered.
- Scope note: candidate *batching* (many candidates per signal) is deliberately out — it changes the SdpFsm wire payload and needs a capability; record it as deferred in the CHANGELOG entry. Package-core negotiation coalescing was previously implemented and reverted (`docs/WEBRTC_CONNECTION_PLAN.md:375-395`); this task must not touch negotiation.

- [ ] **Step 1: Write the failing tests**

```ts
describe('shouldTrickleCandidate', () => {
  const sent = new Set<string>();
  it('drops active-TCP discard-port candidates', () => {
    const c = { candidate: 'candidate:2 1 tcp 1518214911 192.168.1.131 9 typ host tcptype active generation 0', sdpMid: '0' };
    expect(shouldTrickleCandidate(c, sent)).toEqual({ send: false, reason: 'tcp-active' });
  });
  it('sends UDP host/srflx candidates', () => {
    const c = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.131 50124 typ host generation 0', sdpMid: '0' };
    expect(shouldTrickleCandidate(c, sent)).toEqual({ send: true });
  });
  it('drops an exact repeat (same sdpMid + candidate string)', () => {
    const c = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.131 50124 typ host generation 0', sdpMid: '0' };
    const seen = new Set([`0|${c.candidate}`]);
    expect(shouldTrickleCandidate(c, seen)).toEqual({ send: false, reason: 'duplicate' });
  });
  it('never filters the end-of-candidates marker', () => {
    expect(shouldTrickleCandidate({ candidate: '' }, sent)).toEqual({ send: true });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w packages/webrtc-peer -- -t shouldTrickleCandidate`, expected FAIL (function not defined).

- [ ] **Step 3: Implement**

In `rtc-peer.ts`:

```ts
/**
 * Outbound trickle filter. Active-TCP candidates advertise the discard port
 * (9) and cannot be connected to by the remote; libwebrtc re-emits identical
 * candidates per m-section under bundle. Both classes only pad the signaling
 * channel — the 2026-08-11 field logs show ~35-candidate floods per retry,
 * roughly half of them tcp:9 repeats. End-of-candidates ('' ) always passes.
 */
export function shouldTrickleCandidate(
  candidate: RTCIceCandidateInit,
  alreadySent: ReadonlySet<string>,
): { send: true } | { send: false; reason: 'tcp-active' | 'duplicate' } {
  const str = candidate.candidate ?? '';
  if (str === '') return { send: true };
  if (/ tcp /i.test(str) && (/tcptype active/i.test(str) || / 9 typ /.test(str))) {
    return { send: false, reason: 'tcp-active' };
  }
  const key = `${candidate.sdpMid ?? ''}|${str}`;
  if (alreadySent.has(key)) return { send: false, reason: 'duplicate' };
  return { send: true };
}
```

Wire it into the listener (add `private _sentCandidateKeys = new Set<string>();`, cleared where the pc is (re)created):

```ts
if (event.candidate) {
  if (this._trickleICE) {
    const init = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
    const verdict = shouldTrickleCandidate(init, this._sentCandidateKeys);
    if (verdict.send) {
      this._sentCandidateKeys.add(`${init.sdpMid ?? ''}|${init.candidate ?? ''}`);
      this._onSignal(init);
    }
  }
}
```

- [ ] **Step 4: Run full library suite** — `npm test -w packages/webrtc-peer`, expected PASS. Check `two-peer-integration.test.ts` still passes (mock pc candidates are UDP-shaped; if a test emitted tcp candidates expecting delivery, update it as a declared change).

- [ ] **Step 5: CHANGELOG + commit**

CHANGELOG: `Changed: outbound trickle candidates are filtered (active-TCP/discard-port dropped, exact per-m-section duplicates deduped) via the exported shouldTrickleCandidate predicate. Candidate batching (multiple candidates per signal) is deferred — it changes the signal payload shape and needs a capability gate.`

```bash
git add packages/webrtc-peer
git commit -m "feat(webrtc-peer): filter and dedupe outbound trickle candidates"
```

---

### Task 4: Library — exponential backoff for the disconnected auto-retry

**Branch:** `feat/disconnected-retry-backoff`

**Files:**
- Modify: `packages/webrtc-peer/src/peer-connection-fsm.ts:610-620` (the disconnected entry action)
- Test: `packages/webrtc-peer/src/__tests__/peer-connection-fsm.test.ts` (`timer management` ~:373 / `reconnection` ~:410)
- Modify: `packages/webrtc-peer/CHANGELOG.md`

**Interfaces:**
- Consumes: `ReconnectPolicy` fields already present in `reconnect-policy.ts` (`baseDelayMs: 300`, `maxDelayMs: 7000`, `jitterMs: 1000`).
- Produces: retry delay = `min(maxDelayMs, baseDelayMs * 2^retryCount) + random(0..jitterMs)` replacing the flat 500-2000 ms jitter. The 2026-08-11 field trace shows 11 back-to-back sessions, each re-flooding candidates; backoff spaces them 0.3 s → 7 s.

- [ ] **Step 1: Write the failing test**

```ts
it('spaces disconnected retries exponentially (base*2^n, capped, jittered)', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic jitter = 0
  const fsm = makeFsm();
  driveTo(fsm, 'disconnected');            // retry #0
  expect(pendingTimerDelay(fsm, 'retry-jitter')).toBe(300);
  fireTimer(fsm, 'retry-jitter'); driveTo(fsm, 'disconnected'); // retry #1
  expect(pendingTimerDelay(fsm, 'retry-jitter')).toBe(600);
  // ... retry #5 caps:
  // 300*2^5 = 9600 -> capped at 7000
});
```

Use the fake-timer helpers the `timer management` describe already uses (`vi.useFakeTimers` etc.); `pendingTimerDelay`/`fireTimer` stand for whatever inspection that describe employs — read it first.

- [ ] **Step 2: Run to verify failure** — expected FAIL: delay is 500 (flat jitter floor with random=0).

- [ ] **Step 3: Implement**

Replace `peer-connection-fsm.ts:615` region:

```ts
// Exponential backoff with jitter, using the reconnect policy's pacing
// fields. Flat 500-2000ms jitter let a dead relay drive 11 sessions in
// 144s in the field (2026-08-11), each re-flooding candidates.
const attempt = this._disconnectedRetryCount - 1; // incremented just above
const base = Math.min(
  this._reconnectPolicy.maxDelayMs,
  this._reconnectPolicy.baseDelayMs * 2 ** attempt,
);
const jitterMs = base + Math.floor(Math.random() * this._reconnectPolicy.jitterMs);
```

(If `_reconnectPolicy` exposes those fields only through `DefaultReconnectPolicy`, read `reconnect-policy.ts` and take them from the same source `nextRetryDelayMs` uses; do not duplicate constants.)

- [ ] **Step 4: Run full library suite** — expected PASS.

- [ ] **Step 5: CHANGELOG + commit**

```bash
git add packages/webrtc-peer
git commit -m "feat(webrtc-peer): exponential backoff for disconnected auto-retry"
```

---

### Task 5: Library — release 0.5.0

**Branch:** `chore/webrtc-peer-0.5.0` (follow the ceremony used for 0.4.0 on `chore/webrtc-peer-release`)

**Files:**
- Modify: `packages/webrtc-peer/package.json` (version 0.4.0 → 0.5.0)
- Modify: `packages/webrtc-peer/CHANGELOG.md` (bank Unreleased under 0.5.0)

- [ ] **Step 1:** Set version 0.5.0; move the four Unreleased rows under a `## 0.5.0` heading with today's date.
- [ ] **Step 2:** Run `nix develop -c npm run verify` (this rebuilds the package and typechecks ui against it). Expected: PASS.
- [ ] **Step 3:** Commit: `git commit -am "release(webrtc-peer): 0.5.0 — session re-latch, disconnected->failed edge, candidate hygiene, retry backoff"`. Publishing to npm (`npm publish -w packages/webrtc-peer` + tag `webrtc-peer-v0.5.0`) is done by the human after review, per the 0.4.0 precedent; registry state is checked with `npm view @lightningrodlabs/webrtc-peer version`, never trusted from prose.

---

### Task 6: App — carrier-state authority + signals media cadence policy (pure functions only)

**Branch:** `feat/signals-cadence-policy`

**Files:**
- Modify: `ui/src/presence-policy.ts` (add `decideSignalCarrier`, `SIGNAL_CARRIER_DOWN_MS`)
- Create: `ui/src/transport/signals-cadence-policy.ts`
- Test: `ui/src/presence-policy.test.ts`, `ui/src/transport/__tests__/signals-cadence-policy.test.ts`
- Modify: `ui/src/streams-store.ts:2554-2601` (`_emitPresenceForensics` delegates to `decideSignalCarrier`; the inline `3 * PING_INTERVAL` literal is deleted — replace, not parallel)

**Interfaces (produces — later tasks consume these exact names):**

```ts
// presence-policy.ts
export const SIGNAL_CARRIER_DOWN_MS = 3 * PING_INTERVAL; // serves the signal-carrier predicate, presence clock
export type SignalCarrierState = { down: false } | { down: true; downSince: number };
export function decideSignalCarrier(inputs: {
  knownPeerLastSeen: number[];      // lastSeen stamps for known, non-self, non-blocked peers
  prevDownSince: number | undefined;
  now: number;
}): SignalCarrierState;

// transport/signals-cadence-policy.ts  — cadence control, declared NOT-liveness
export const SIGNALS_RTT_DEGRADED_MS = 2_000;
export const SIGNALS_RTT_COLLAPSED_MS = 5_000;
export type SignalsMediaCadence =
  | { mode: 'full'; reason: 'healthy' | 'no-sample' }
  | { mode: 'voice-only'; reason: 'rtt-degraded' }
  | { mode: 'paused'; reason: 'carrier-down' | 'rtt-collapsed' };
export function decideSignalsMediaCadence(inputs: {
  carrierDown: boolean;
  bestRttEwmaMs: number | undefined; // min of _signalsRttEwma across current signals targets
  prevMode: SignalsMediaCadence['mode'];
}): SignalsMediaCadence;
```

- [ ] **Step 1: Write the failing tables**

`signals-cadence-policy.test.ts`:

```ts
import { decideSignalsMediaCadence, SIGNALS_RTT_DEGRADED_MS, SIGNALS_RTT_COLLAPSED_MS } from '../signals-cadence-policy';

describe('decideSignalsMediaCadence', () => {
  const cases: Array<[string, Parameters<typeof decideSignalsMediaCadence>[0], ReturnType<typeof decideSignalsMediaCadence>]> = [
    ['healthy',            { carrierDown: false, bestRttEwmaMs: 300,   prevMode: 'full' },      { mode: 'full', reason: 'healthy' }],
    ['no sample yet',      { carrierDown: false, bestRttEwmaMs: undefined, prevMode: 'full' },  { mode: 'full', reason: 'no-sample' }],
    ['degraded sheds filmstrip', { carrierDown: false, bestRttEwmaMs: 2500, prevMode: 'full' }, { mode: 'voice-only', reason: 'rtt-degraded' }],
    ['collapsed pauses',   { carrierDown: false, bestRttEwmaMs: 6000, prevMode: 'voice-only' }, { mode: 'paused', reason: 'rtt-collapsed' }],
    ['carrier down pauses regardless of rtt', { carrierDown: true, bestRttEwmaMs: 100, prevMode: 'full' }, { mode: 'paused', reason: 'carrier-down' }],
    // hysteresis: recovery requires dropping below half the threshold
    ['no flap at threshold edge', { carrierDown: false, bestRttEwmaMs: 1900, prevMode: 'voice-only' }, { mode: 'voice-only', reason: 'rtt-degraded' }],
    ['recovers below half threshold', { carrierDown: false, bestRttEwmaMs: 900, prevMode: 'voice-only' }, { mode: 'full', reason: 'healthy' }],
    ['paused recovers one level',     { carrierDown: false, bestRttEwmaMs: 2200, prevMode: 'paused' },   { mode: 'voice-only', reason: 'rtt-degraded' }],
  ];
  it.each(cases)('%s', (_n, input, expected) => {
    expect(decideSignalsMediaCadence(input)).toEqual(expected);
  });
});
```

`presence-policy.test.ts` additions:

```ts
describe('decideSignalCarrier', () => {
  it('down when no known peer is fresh within SIGNAL_CARRIER_DOWN_MS', () => {
    expect(decideSignalCarrier({ knownPeerLastSeen: [1000, 2000], prevDownSince: undefined, now: 10_000 }))
      .toEqual({ down: true, downSince: 10_000 });
  });
  it('preserves downSince while still down', () => {
    expect(decideSignalCarrier({ knownPeerLastSeen: [1000], prevDownSince: 8_000, now: 12_000 }))
      .toEqual({ down: true, downSince: 8_000 });
  });
  it('up when any peer is fresh; up with zero known peers (no evidence is not channel death)', () => {
    expect(decideSignalCarrier({ knownPeerLastSeen: [9_500], prevDownSince: 8_000, now: 10_000 })).toEqual({ down: false });
    expect(decideSignalCarrier({ knownPeerLastSeen: [], prevDownSince: undefined, now: 10_000 })).toEqual({ down: false });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run -w ui src/transport/__tests__/signals-cadence-policy.test.ts src/presence-policy.test.ts`, expected FAIL (modules/functions missing).

- [ ] **Step 3: Implement both functions**

```ts
// presence-policy.ts
export function decideSignalCarrier(inputs: {
  knownPeerLastSeen: number[];
  prevDownSince: number | undefined;
  now: number;
}): SignalCarrierState {
  const { knownPeerLastSeen, prevDownSince, now } = inputs;
  if (knownPeerLastSeen.length === 0) return { down: false };
  const anyFresh = knownPeerLastSeen.some((t) => now - t < SIGNAL_CARRIER_DOWN_MS);
  if (anyFresh) return { down: false };
  return { down: true, downSince: prevDownSince ?? now };
}
```

```ts
// transport/signals-cadence-policy.ts
export function decideSignalsMediaCadence(inputs: {
  carrierDown: boolean;
  bestRttEwmaMs: number | undefined;
  prevMode: SignalsMediaCadence['mode'];
}): SignalsMediaCadence {
  const { carrierDown, bestRttEwmaMs, prevMode } = inputs;
  if (carrierDown) return { mode: 'paused', reason: 'carrier-down' };
  if (bestRttEwmaMs === undefined) return { mode: 'full', reason: 'no-sample' };
  // Hysteresis: escalate at the threshold, recover only below half of it,
  // and recover one level per evaluation (paused -> voice-only -> full).
  const overCollapsed = bestRttEwmaMs >= SIGNALS_RTT_COLLAPSED_MS;
  const overDegraded = bestRttEwmaMs >= SIGNALS_RTT_DEGRADED_MS;
  const underCollapsedRecovery = bestRttEwmaMs < SIGNALS_RTT_COLLAPSED_MS / 2;
  const underDegradedRecovery = bestRttEwmaMs < SIGNALS_RTT_DEGRADED_MS / 2;
  switch (prevMode) {
    case 'paused':
      if (overCollapsed) return { mode: 'paused', reason: 'rtt-collapsed' };
      if (!underCollapsedRecovery) return { mode: 'paused', reason: 'rtt-collapsed' };
      return { mode: 'voice-only', reason: 'rtt-degraded' };
    case 'voice-only':
      if (overCollapsed) return { mode: 'paused', reason: 'rtt-collapsed' };
      if (underDegradedRecovery) return { mode: 'full', reason: 'healthy' };
      return { mode: 'voice-only', reason: 'rtt-degraded' };
    case 'full':
      if (overCollapsed) return { mode: 'paused', reason: 'rtt-collapsed' };
      if (overDegraded) return { mode: 'voice-only', reason: 'rtt-degraded' };
      return { mode: 'full', reason: 'healthy' };
  }
}
```

Reconcile the table in Step 1 with this hysteresis (the `paused recovers one level` row: 2200 ≥ half of 5000 is false → recovers to voice-only; verify each row by hand and fix rows, not the function, unless the function is wrong).

- [ ] **Step 4: Delegate `_emitPresenceForensics`**

In `streams-store.ts:2554-2601`: build `knownPeerLastSeen` from the same known/blocked filtering it already does, call `decideSignalCarrier({ knownPeerLastSeen, prevDownSince: this._signalCarrierDownSince, now })`, keep the two existing log lines keyed off the state transitions, and store `this._signalCarrierDownSince = state.down ? state.downSince : undefined`. Delete the inline `3 * PING_INTERVAL` expression. This promotes `_signalCarrierDownSince` from forensic-only to the carrier-down authority — update its docblock accordingly (it is no longer "no behaviour change"; Tasks 7-8 read it).

- [ ] **Step 5: Run** `npx vitest run -w ui` — expected PASS. **Step 6: Commit**

```bash
git add ui/src/presence-policy.ts ui/src/transport/signals-cadence-policy.ts ui/src/streams-store.ts ui/src/presence-policy.test.ts ui/src/transport/__tests__/signals-cadence-policy.test.ts
git commit -m "feat: signal-carrier authority (decideSignalCarrier) and signals media cadence policy

Replaces the inline forensic carrier predicate in _emitPresenceForensics;
_signalCarrierDownSince is now the one carrier-down authority."
```

---

### Task 7: App — wire cadence into the voice/filmstrip senders + voice frame batching

**Branch:** `feat/signals-media-backpressure`

**Files:**
- Modify: `ui/src/streams-store.ts` (new `_signalsCadence` field + per-presence-tick evaluation; expose `signalsCadence(): SignalsMediaCadence`)
- Modify: `ui/src/room/modules/voice.ts` (`handleEncodedChunk` ~:397-429: cadence gate + batching; receive side `handleModuleData` parse: accept both formats)
- Modify: `ui/src/room/modules/video-filmstrip.ts` (send sites ~:448-450, ~:518: cadence gate)
- Modify: `ui/src/transport/wire-contract.ts` (add cap `voice-batch-v1` to the caps list ~:83-99)
- Test: `ui/src/__tests__/streams-store-wiring.test.ts` (new describe), `ui/src/room/modules/__tests__/` (voice batching unit test; create `voice-batch.test.ts` if voice has no unit file — the pure batch/parse helpers below make that possible without WebCodecs)
- Fixture: `fixtures/wire-contract.json` regen (`UPDATE_WIRE_FIXTURE=1 npx vitest run src/transport/__tests__/wire-contract.test.ts` in ui/)

**Interfaces:**
- Consumes: `decideSignalsMediaCadence`, `_signalCarrierDownSince`, `_signalsRttEwma` (Task 6).
- Produces:
  - `StreamsStore._signalsCadence: SignalsMediaCadence` (initialized `{ mode: 'full', reason: 'no-sample' }`), re-evaluated once per presence tick inside `pingAgents()` (same cadence the reconcilers already ride), and additionally forced to `paused` immediately when `decideSignalCarrier` flips down in `_emitPresenceForensics`.
  - `export const VOICE_BATCH_FRAMES = 3;` and pure helpers in `voice.ts`:
    `packVoiceFrames(frames: VoiceFramePayload[]): string` → `JSON.stringify({ v: 2, frames })`
    `unpackVoicePayload(json: string): VoiceFramePayload[]` → handles both v2 batches and legacy single-object payloads (returns `[obj]`).
  - Cap constant `CAP_VOICE_BATCH = 'voice-batch-v1'` in `wire-contract.ts`, advertised in the conversation payload caps, read via the existing one capability read (`conversationPayloadCaps`).

**Behavioral contract (state in code comments):** batching applies only when **every** current signals target advertises `voice-batch-v1` (payload is one broadcast; mixed rooms fall back to legacy per-frame). Batching adds ≤ `VOICE_BATCH_FRAMES × 20 ms` = 60 ms send latency — inside the existing 80 ms jitter buffer. RED stays at 2. `paused` gates the *send*, not capture (capture teardown remains owned by the reconcilers/`_signalsTargets`). Filmstrip sends only in `full` mode.

- [ ] **Step 1: Failing unit tests for the pure helpers**

```ts
// ui/src/room/modules/__tests__/voice-batch.test.ts
import { packVoiceFrames, unpackVoicePayload, VOICE_BATCH_FRAMES } from '../voice';

const f = (seq: number) => ({ seq, ts: seq * 20_000, type: 'key', data: 'AA==', wts: 1 });

it('round-trips a batch', () => {
  const frames = [f(1), f(2), f(3)];
  expect(unpackVoicePayload(packVoiceFrames(frames))).toEqual(frames);
});
it('unpacks a legacy single-frame payload as a one-element array', () => {
  expect(unpackVoicePayload(JSON.stringify(f(7)))).toEqual([f(7)]);
});
it('batch size constant is 3', () => expect(VOICE_BATCH_FRAMES).toBe(3));
```

- [ ] **Step 2: Run to verify failure**, then implement the helpers in `voice.ts` (exported, no class state):

```ts
export const VOICE_BATCH_FRAMES = 3;
export function packVoiceFrames(frames: VoiceFramePayload[]): string {
  return JSON.stringify({ v: 2, frames });
}
export function unpackVoicePayload(json: string): VoiceFramePayload[] {
  const parsed = JSON.parse(json);
  if (parsed && parsed.v === 2 && Array.isArray(parsed.frames)) return parsed.frames;
  return [parsed];
}
```

Run the test — PASS.

- [ ] **Step 3: Failing wiring test for the cadence gate**

In `streams-store-wiring.test.ts` (use the started-store fixture and `FakeSignalBus.sentOfType('ModuleData')`; follow the encoder-retry describe at ~:790 for setup):

```ts
describe('signals media cadence gates the senders', () => {
  it('paused cadence stops ModuleData sends without tearing down capture', async () => {
    // arrange: store started, one signals target, voice frames flowing
    // act: drive _signalsRttEwma for that peer above SIGNALS_RTT_COLLAPSED_MS
    //      (deliver a PongUi with an old t0 through the fake bus), advance one PING_INTERVAL
    // assert: cadence mode is 'paused'; subsequent handleEncodedChunk-driven
    //         sends do not appear in bus.sentOfType('ModuleData')
  });
  it('carrier-down pauses immediately (no pong from any peer for SIGNAL_CARRIER_DOWN_MS)', async () => {
    // advance clock 3 ticks with no pongs; assert cadence paused
  });
});
```

Write these as real tests against the fakes (the fake bus + fake clock make both drivable); the comments above are the arrange/act/assert skeleton, not placeholders — flesh out with the same helpers `tick()` etc. used at :812-818.

- [ ] **Step 4: Implement store + module wiring**

- `streams-store.ts`: add `_signalsCadence` field; in `pingAgents()` (after the forensics call) compute `bestRttEwmaMs = min` of `_signalsRttEwma.get(k)` over `get(this._signalsTargets)` (undefined if no samples), then `this._signalsCadence = decideSignalsMediaCadence({ carrierDown: this._signalCarrierDownSince !== undefined, bestRttEwmaMs, prevMode: this._signalsCadence.mode })`. In `_emitPresenceForensics`, when the carrier flips down, set `this._signalsCadence = { mode: 'paused', reason: 'carrier-down' }` in the same breath (don't wait a tick). Add `signalsCadence()` getter.
- `voice.ts` `handleEncodedChunk`: after the targets check, `const cadence = this.store.signalsCadence(); if (cadence.mode === 'paused') return;`. Then batching: accumulate frames in `this.batchBuffer: VoiceFramePayload[]`; when every target has `CAP_VOICE_BATCH` (read via a new `store.signalsTargetsAllHaveCap(CAP_VOICE_BATCH)` helper that maps `conversationPayloadCaps` over the target set), push and send only when `batchBuffer.length >= VOICE_BATCH_FRAMES` using `packVoiceFrames`; otherwise send legacy per-frame exactly as today. Flush the buffer in `stopCapture()` (drop, don't send — stale audio). RED attachment stays on the primary frame of each batch.
- Receive side: replace the single `JSON.parse` with `unpackVoicePayload(...)` and iterate frames in order through the existing per-frame path.
- `video-filmstrip.ts`: at both send sites, `if (this.store.signalsCadence().mode !== 'full') return;` before `sendModuleData`.
- `wire-contract.ts`: add `voice-batch-v1` to the caps declaration and to the payload the current build advertises; regen `fixtures/wire-contract.json` via the documented ceremony; confirm `compat-corpus.test.ts` still passes (caps are additive).

- [ ] **Step 5: Run** `npx vitest run -w ui` — expected PASS. Then `nix develop -c npm run verify` — PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src fixtures/wire-contract.json
git commit -m "feat: backpressure + batching for signals-carried media

Voice batches 3 opus frames per signal when all targets advertise
voice-batch-v1 (50/s -> ~17/s); filmstrip sends only at full cadence;
both senders pause on carrier-down or collapsed signals RTT via
decideSignalsMediaCadence. Declared change: peers without the cap keep
receiving legacy per-frame voice."
```

---

### Task 8: App — presence carrier-hold (stop the flap and the target-set feedback loop)

**Branch:** `feat/presence-carrier-hold`

**Files:**
- Modify: `ui/src/presence-policy.ts` (`PresentPeersSnapshot` ~:143-153, `computePresentPeers` ~:165-192, new constant)
- Modify: `ui/src/streams-store.ts` (`_presentPeers` derivation ~:404-421: pass the two new snapshot fields; keep a `_lastComputedPresent: AgentPubKeyB64[]` field updated after each evaluation)
- Test: `ui/src/presence-policy.test.ts`, `ui/src/__tests__/streams-store-wiring.test.ts`

**Interfaces:**
- Produces:

```ts
export const PRESENCE_CARRIER_HOLD_MAX_MS = 30_000; // = LAST_SEEN_GONE_MS; serves the present predicate, presence clock.
// PresentPeersSnapshot gains:
//   carrierDownSince?: number;
//   heldPresent?: AgentPubKeyB64[];   // the previous computed present set
```

- Semantics: while the signal carrier is down (`carrierDownSince` set) and for at most `PRESENCE_CARRIER_HOLD_MAX_MS`, peers in `heldPresent` are kept present even when ping-stale and media-silent — "no pong from anyone" is channel evidence, not peer evidence. New appearances still add normally. After the cap, absence wins (a genuinely dead network eventually empties the room). This also holds `_signalsTargets` stable, which is safe because Task 7's cadence pauses sends while the carrier is down — **this task must land after Task 7**.

- [ ] **Step 1: Failing policy tests**

```ts
describe('carrier-hold', () => {
  const base = { openConnections: {}, lastVoiceMs: {}, lastFilmstripMs: {}, blocked: new Set<string>(), myPubKey: 'me', mediaLiveWindowMs: MEDIA_LIVE_WINDOW_MS };
  it('holds previously-present peers while the carrier is down', () => {
    const r = computePresentPeers({ ...base, activeAgents: [], now: 20_000, carrierDownSince: 15_000, heldPresent: ['peerA', 'peerB'] });
    expect(r).toEqual(['peerA', 'peerB']);
  });
  it('does not hold past PRESENCE_CARRIER_HOLD_MAX_MS', () => {
    const r = computePresentPeers({ ...base, activeAgents: [], now: 50_001, carrierDownSince: 20_000, heldPresent: ['peerA'] });
    expect(r).toEqual([]);
  });
  it('never holds blocked peers or self, and does not duplicate fresh peers', () => {
    const r = computePresentPeers({ ...base, activeAgents: ['peerA'], blocked: new Set(['peerC']), now: 20_000, carrierDownSince: 15_000, heldPresent: ['peerA', 'peerC', 'me'] });
    expect(r).toEqual(['peerA']);
  });
  it('carrier up: absent carrierDownSince changes nothing', () => {
    const r = computePresentPeers({ ...base, activeAgents: [], now: 20_000, heldPresent: ['peerA'] });
    expect(r).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement — append to `computePresentPeers` after the existing ping-fresh ++ media-live merge:

```ts
if (
  snapshot.carrierDownSince !== undefined &&
  snapshot.now - snapshot.carrierDownSince < PRESENCE_CARRIER_HOLD_MAX_MS
) {
  for (const key of snapshot.heldPresent ?? []) {
    if (key === snapshot.myPubKey) continue;
    if (snapshot.blocked.has(key)) continue;
    if (result.includes(key)) continue;
    result.push(key); // held peers appended after evidenced ones, input order
  }
}
```

- [ ] **Step 3: Wire the store derivation** — in the `_presentPeers` derived callback pass `carrierDownSince: this._signalCarrierDownSince` and `heldPresent: this._lastComputedPresent`, and assign `this._lastComputedPresent = result` before returning. Document the one-evaluation-stale nature of `heldPresent` in a comment (it is the previous tick's output by construction).

- [ ] **Step 4: Wiring test** — in `streams-store-wiring.test.ts` (clock-driven cadences describe ~:725): start a store with one ping-fresh peer, then advance 3+ ticks delivering **no** pongs; assert the peer is still in `get(store._presentPeers)` (held), then advance past `PRESENCE_CARRIER_HOLD_MAX_MS` and assert it is removed. Also assert no `peer-left-presence` store event fired during the hold (the chime/flap pin).

- [ ] **Step 5: Run** `npx vitest run -w ui` (the existing test at construction ~:120 "keeps a media-live peer with stale pongs" must stay green) then `nix develop -c npm run verify`. **Step 6: Commit**

```bash
git add ui/src
git commit -m "feat: hold presence through a signal-carrier outage

computePresentPeers keeps previously-present peers while
decideSignalCarrier reports the channel down, capped at
PRESENCE_CARRIER_HOLD_MAX_MS. Kills the remove/re-add flap and the
present->signalsTargets->mutual-drop feedback loop from 2026-08-11.
Depends on the cadence pause landing first (sends stay quiet during the
hold)."
```

---

### Task 9: App — adaptive timeout ceiling + RTT-scaled diagnostics timeout

**Branch:** `feat/adaptive-timeout-ceilings`

**Files:**
- Modify: `ui/src/streams-store.ts` (`_computeSdpTimeout` ~:2624-2631; `DIAGNOSTIC_ATTEMPT_TIMEOUT_MS` use at ~:4871)
- Test: `ui/src/__tests__/streams-store-wiring.test.ts` (InitAccept lifecycle describe ~:885 has the SDP-timer helpers)

**Interfaces:**
- Produces: `_computeSdpTimeout` ceiling raised from 15 000 to a named `SDP_TIMEOUT_CEILING_MS = 30_000` (serves the SDP-exchange predicate; K=20 and FLOOR_MS=5000 unchanged). Diagnostic attempt timeout becomes `max(DIAGNOSTIC_ATTEMPT_TIMEOUT_MS, 4 × bestRttEwmaMs for that peer)` capped at `DIAGNOSTIC_ATTEMPT_TIMEOUT_MAX_MS = 30_000`.
- Rationale from the field: 8 consecutive SDP timeouts sat at the 15 s ceiling while measured RTT was 20-58 s; each timeout tears down and re-floods. A 30 s ceiling halves the teardown rate under exactly the conditions where retrying cannot help. Diagnostics failed 3×8 s against the same RTTs — the retries were noise.

- [ ] **Step 1: Failing test** — drive `_signalsRttEwma` for a peer to 2 000 ms via a pong with an old `t0` (helper exists in the wiring suite, ~:135-143 pattern), trigger the InitAccept path, and assert the tracked SDP timer was armed with `min(30_000, 20 × 2_000) = 30_000` (today it arms 15 000). Second test: RTT 400 ms → timer 8 000 (unchanged behavior below the old ceiling).
- [ ] **Step 2: Verify failure, implement** (constants module-level next to `SDP_EXCHANGE_TIMEOUT` at :111, with a comment naming the predicate each serves), **run, commit**:

```bash
git commit -am "feat: raise adaptive SDP-timeout ceiling to 30s under measured signals RTT; scale diagnostic attempt timeout by RTT"
```

---

### Task 10: Doc sync — CLAUDE.md fact bullets + plan status

**Branch:** folded into the final merge branch (this is the closing doc-sync commit the "True today" contract requires)

**Files:**
- Modify: `CLAUDE.md` (add one "connection-thrash round" fact bullet; amend the Post-Phase 2 presence bullet's constants list with `PRESENCE_CARRIER_HOLD_MAX_MS`, `SIGNAL_CARRIER_DOWN_MS`; amend the §9 bullet's carrier facts with the cadence policy; record webrtc-peer 0.5.0)
- Modify: `docs/superpowers/plans/2026-08-11-connection-thrash-fixes.md` (mark tasks landed/not-landed)

- [ ] **Step 1:** Write the fact bullet in the established style: past-tense, anchored to the merge, present-tense claims only where they name the enforcing file/test (e.g. "the signals send cadence has ONE authority: `decideSignalsMediaCadence` in `transport/signals-cadence-policy.ts`, pinned by `signals-cadence-policy.test.ts`; `_signalCarrierDownSince` is the carrier-down authority (`decideSignalCarrier`, `presence-policy.ts`) — the forensic-only docblock is deleted"). No test counts, no repo-state snapshots.
- [ ] **Step 2:** Run `nix develop -c npm run verify` (the `claude-md-drift.test.ts` gate runs in it). Expected: PASS.
- [ ] **Step 3:** Commit: `git commit -am "docs: sync CLAUDE.md facts for the connection-thrash round; mark plan items landed"`.

---

### Task 11: Forward-port to main-0.7 + profiles bump (0.7 side only)

**Branch:** work directly in the `presence-0.7` worktree (`/home/eric/code/metacurrency/holochain/presence-0.7`, branch `main-0.7`) via a merge branch `chore/forward-port-thrash-fixes`

**Files:**
- Merge: `main-0.6` into `main-0.7` (after Tasks 1-10 are merged on main-0.6)
- Modify: `presence-0.7` `ui/package.json:25` (`@holochain-open-dev/profiles` `^0.700.0` → `^0.701.0`) + lockfile
- Decision (room owner, 2026-08-11): the profiles bump happens **only on the 0.7 side** — main-0.6 keeps `^0.601.3`.

- [ ] **Step 1:** In the 0.7 worktree: `git checkout -b chore/forward-port-thrash-fixes && git merge main-0.6` (resolve conflicts — expected: none in ui/src except possibly `types.ts` context; `packages/webrtc-peer` merges clean).
- [ ] **Step 2:** Bump profiles to `^0.701.0`, run `npm install` to sync the lockfile.
- [ ] **Step 3 (room-owner request, 2026-08-11):** Replace every spurious network get with a local get: any `GetOptions::network()` whose fetched data is necessarily local already. Audited sites in `dnas/presence/zomes/coordinator/room/src/`: `lib.rs:72` (the `DeleteLink` arm's `get` in `signal_action`) and `lib.rs:130` (`get_entry_for_action`'s `get_details`) — both in the `post_commit` chain fetching self-authored data → flip to `GetOptions::local()`. The two sites in `helper.rs:27/:47` are already caller-conditional (`false => network()`) and stay as-is. Verify with the conductor-level DNA tests: `nix develop -c npm test` (root Tryorama suite, gated on main-0.7 CI).
- [ ] **Step 4:** Run `nix develop -c npm run verify` in the 0.7 worktree. Expected: PASS.
- [ ] **Step 5:** Commit the bump + zome fix (`chore: bump @holochain-open-dev/profiles to ^0.701.0; use local gets in post_commit signal chain`), merge the branch `--no-ff` into `main-0.7`.

## Validation beyond unit tests

- Nightly harness (`carrier-handover.spec.ts`, `screen-share.spec.ts`, `voice-playout.spec.ts`) must stay green — the carrier-handover spec exercises exactly the establishment/flap/handover paths Tasks 1-4 touch. Run locally once after Task 5 and once after Task 8: `npm run build:packages && npm run test:harness -w ui` (needs Playwright chromium).
- Manual conductor-level smoke (the pre-release step already recorded in the plan-state memory): a 3+ peer room on the 0.7 conductor with one peer's WebRTC disabled (reproducing the field topology: signals-voice fanning into a congested relay), watching for: no `Dropped stale ... < current N` wedges, `SignalCarrierDown` no longer accompanied by PresenceRemove storms, voice ModuleData rate ≤ ~17/s per sender.
- After merge to `main-0.6`, merge forward to `main-0.7` and rebuild the 0.7 app; the field failure was observed there.

## Explicitly deferred (record, don't do)

- Candidate batching (multiple candidates per SdpFsm signal) — wire-payload change, needs a cap; revisit only if the Task 3 filter + Task 4 backoff leave candidate volume a problem in the field.
- Diagnostics over data channels — rejected for now: field timelines show `dc=-1` (channels never open) and the unreachable peer had WebRTC disabled; Task 9's RTT-scaled timeout is the proportionate fix.
- TURN — every successful ICE pairing in the field logs was `relay=false`; nothing here was a NAT-traversal failure.
- Ping piggybacking/coalescing with module data — YAGNI until measured.
