# WebRTC reconnect identity — architecture, the 2026‑06‑24 failure, and the fix

Status: design + fix rationale. Companion to the code in
`packages/webrtc-peer/` (the signaling‑agnostic FSM library) and
`ui/src/streams-store.ts` + `ui/src/transport/` (the Presence orchestrator).

This document exists because a *clean, connected* WebRTC link (Presence ↔
Uruguay, FSM carrier, 2.7 min stable) took **~21 s** to re‑establish after a
teardown, deadlocked on "Dropped stale answer/candidate" loops. The worry it
raised is legitimate: the FSM is supposed to handle reconnect **deterministically**,
yet a time‑ordering / non‑monotonicity hole let two nodes disagree about which
connection attempt was current. The referenced design note
(`docs/webrtc-state-machine-plan.md`, cited at the top of
`peer-connection-fsm.ts`) does not exist in the tree, so the identity model was
never written down where the orchestrator author would see its boundaries. This
doc is that missing contract.

---

## 1. Two layers, two owners

```
┌──────────────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR  (ui/src/streams-store.ts, ui/src/transport/fsm/…)       │
│  • decides WHICH carrier a peer uses (FSM-WebRTC | simple-peer |       │
│    signals) and WHEN to (re)connect or tear down                      │
│  • owns the InitRequest/InitAccept handshake + retry cadence          │
│  • owns presence, pong liveness, audibility, auto-flip policy         │
└───────────────▲───────────────────────────────────────┬──────────────┘
                │ ensureConnection() / closeConnection()  │ events, signals
┌───────────────┴───────────────────────────────────────▼──────────────┐
│ PACKAGE  (@lightningrodlabs/webrtc-peer)                              │
│  ConnectionManager  — one object, owns every peer's FSM, routes       │
│                       signals, mints the FSM connectionId             │
│  PeerConnectionFSM  — one peer's lifecycle (the state diagram §3)     │
│  RTCPeer            — Perfect-Negotiation wrapper over RTCPeerConnection│
└──────────────────────────────────────────────────────────────────────┘
```

The package README is explicit about **ownership in a multi-transport app**
(README §"Ownership: who drives recovery"): when a higher layer flips between
carriers, *that orchestrator — not the FSM — owns give‑up and timing*; the FSM
should "fail fast and yield." Presence is exactly this case (FSM‑WebRTC **and** a
signals fallback). The incident shows both layers running recovery loops at once
— the anti‑pattern the README names. See §7/§8.

---

## 2. The handshake roles are deterministic (and that part is fine)

Roles are fixed by lexical pubkey comparison, consistently across both layers:

| Role | Rule | Code | In glare |
|------|------|------|----------|
| **Initiator** (sends `InitRequest`, then the SDP **offer**) | peer key **<** my key, i.e. *I am the higher key* | `streams-store.ts:5799` | offer **wins** |
| **Acceptor** (sends `InitAccept`, then the SDP **answer**) | sender key **>** my key, i.e. *I am the lower key* | `streams-store.ts:5982` | yields |
| **Impolite** FSM peer | `myAgentId > remoteAgent` (higher key) | `connection-manager.ts:388` | keeps its offer |
| **Polite** FSM peer | `myAgentId < remoteAgent` (lower key) | `connection-manager.ts:388` | rolls back, accepts |

These line up: **higher‑key = initiator = impolite = its offer wins**;
**lower‑key = acceptor = polite = yields.** In the happy path exactly one offer
flows (initiator → acceptor) and one answer returns. There is no glare. The
determinism that *is* designed in works — until a stale signal or a fresh FSM
breaks the identity bookkeeping the roles rely on (§6).

---

## 3. The lifecycle state machine (corroborated to code)

`ConnectionPhase` and the legal edges are the single source of truth in
`types.ts → VALID_TRANSITIONS`; every transition is gated against it in
`peer-connection-fsm.ts:_transition` (line 464; illegal edges are logged
`BLOCKED:` and ignored). Reproduced verbatim from `VALID_TRANSITIONS`:

```
                 connect() / remote signal
        idle ───────────────────────────────► signaling
          │                                    │  │  │
          └── close ──► closed ◄───────────────┘  │  └─ SDP timeout ─► disconnected
                                                   │
                       SDP exchange complete       ▼
        signaling ───────────────────────────► connecting
                                                   │  │  │
                          ICE+DTLS ready           │  │  └─ conn timeout ─► disconnected
                                                   ▼  └──── new remote offer ─► signaling
        connecting ───────────────────────────► connected
                                                   │  │  │
                       transport failure           │  │  └─ ICE failed/DTLS closed ─► reconnecting
                          (ice/dtls)               │  └──── disconnected (grace) ──► disconnected
                                                   ▼
        reconnecting ─(ice-restart|full)─► reconnecting ─► connected   (recover)
                     └─ retries exhausted ─► failed ─► idle
                     └─ stale/grace ───────► disconnected ─► signaling | idle | closed

   closed = terminal (no edges out)
```

Exact adjacency (`types.ts`):

```
idle:         signaling, closed
signaling:    connecting, disconnected, closed
connecting:   connected, signaling, disconnected, closed
connected:    reconnecting, disconnected, failed, closed
reconnecting: reconnecting, signaling, connected, disconnected, failed, closed
disconnected: signaling, idle, closed
failed:       idle, closed
closed:       —
```

Semantics that matter for reconnect:
- **`connected` = media‑ready (ICE + DTLS up)**, not data‑channel‑ready
  (README §"What you get"). RTP flows in `connected`.
- **`disconnected` is recoverable**, not terminal: an offer received while
  `disconnected` re‑enters `signaling` with a fresh peer session
  (`handleRemoteSignal` line 315).
- **`reconnecting`** runs the two‑tier policy: ICE‑restart first, then full
  reconnect (`_scheduleReconnectAttempt` line 711; `reconnect-policy.ts`). A
  **full reconnect** calls `_newPeerSession()` — destroy the `RTCPeerConnection`,
  **`_remoteConnectionId = null`**, `_session.local++` (line 770‑776). This reset
  is central to the bug (§6).

---

## 4. The four identifiers — what they are, and **why** (the crux)

There are **four** distinct identity values in play. The failure is a direct
consequence of which ones are ordered, which are shared, and which silently
reset. This table is the contract that was missing.

| # | Identifier | Allocated by | When | Shape | **Ordered?** | **Shared across the two nodes?** | Scope / lifetime | Used for |
|---|-----------|--------------|------|-------|--------------|-------------------------------|------------------|----------|
| 1 | **handshake `connection_id`** | orchestrator (`streams-store`) | each `InitRequest` (initiator) `uuidv4()` `:5809`; echoed by acceptor in `PendingAccept` `:5997` | random UUID | ❌ no | ✅ yes (one per attempt, both sides hold it) | one handshake attempt | match `InitRequest`↔`InitAccept`; key `_openConnections` |
| 2 | **FSM `connectionId`** | **package** (`ConnectionManager._createFSM`) `crypto.randomUUID()` `:390` | each FSM instance creation | random UUID, **`readonly`** (`peer-connection-fsm.ts:102`) | ❌ no | ❌ **no — each side mints its own** | one FSM instance | tags every outgoing signal `:411`; correlates logs |
| 3 | **`remoteConnectionId`** | learned | from incoming offer/answer (`handleRemoteSignal:340`) | mirror of peer's #2 | ❌ no | n/a (a copy of the peer's #2) | reset to `null` on `_newPeerSession` `:775` | routing stale‑drop `:360`; m‑line‑mismatch takeover `:328` |
| 4 | **`peerSessionId`** | **package** (FSM `_session.local`) | `++` each `_newPeerSession()` `:776`; starts at 0 | small int | ✅ **monotonic… but only within one FSM** | partially (stamped on signals `:412`) | **per‑FSM‑instance; resets to 0 on a new FSM** | `_validateSignalSession` drop‑older `:683‑705` |

The intended stale‑signal defense is **#4**, and the type even says so —
`types.ts:298`: *"Used to discard stale signals from previous peer sessions
**within the same FSM**."* That is the whole problem in one phrase:

- **Within one FSM** (an in‑place full reconnect via `_newPeerSession`), `#4`
  increments monotonically, and `_validateSignalSession` correctly drops any
  signal carrying an older `peerSessionId`. Deterministic. ✅
- **Across FSMs** — which is what a *teardown + re‑`ensureConnection`* does — the
  old FSM is destroyed and a **new FSM is constructed with `_session = {local:0,
  remote:0}`**. The monotonic counter **restarts at 0**, and the only
  cross‑FSM identity (`#2`, the connectionId) is an **unordered random UUID**.
  So at the exact moment two nodes must agree on "which attempt is current,"
  **there is no ordered, shared value to compare.** ❌

That is the architectural hole: **the determinism is scoped to a single FSM
instance, but the orchestrator's reconnect strategy crosses FSM instances.**

---

## 5. Synchronous vs asynchronous boundaries

Reasoning about the race requires knowing exactly what is synchronous (atomic,
ordered) and what is not (lossy, reorderable, delayed). 

**Synchronous & ordered (cannot interleave):**
- `_transition()` (`:464`) — validate edge → clear timers → set `_state` →
  log → entry actions → start timers → emit. One atomic step.
- `connect()` → `_transition('signaling')` (`:285`) — synchronous.
- `ensureConnection()` — creates the FSM and calls `connect()` synchronously;
  returns the FSM connectionId (`fsm-transport.ts:225‑230`).
- `_validateSignalSession()` and the routing stale‑drop — synchronous decisions
  on the data in hand.

**Asynchronous, lossy, reorderable (the danger zone):**
- **Signal delivery.** `onSignal` → `sendSignal` is a synchronous *call*, but the
  bytes travel over **Holochain remote signals**: best‑effort, **may be lost,
  reordered, or duplicated** (README §"What the library expects": *"Best‑effort,
  not exactly‑once."*). A signal tagged with a dead session can arrive **after**
  a fresh FSM exists.
- **SDP/ICE.** `createOffer`/`createAnswer`/`setRemote…` and ICE gathering/checks
  are async browser operations; `handleRemoteSignal` is `async` (`:296`).
- **FSM map cleanup is deferred.** On reaching `closed`, the manager removes the
  FSM from `_connections` on a **`setTimeout(…, 0)`** (`connection-manager.ts:440`),
  "to avoid modifying the map during iteration." So there is a window where the
  FSM is `closed` (synchronously) but **still in the map** (asynchronously
  removed). A fast re‑`ensureConnection` in that window hits the closed‑FSM
  branch (`:172`) — usually fine, but it is a real sync/async seam.
- **Two independent grace clocks.** The FSM's `iceDisconnectedGraceMs = 15000`
  (`types.ts`) and the orchestrator's `ICE_DISCONNECTED_GRACE_MS`
  (`streams-store.ts:5770‑5775`) both gate teardown, on **different clocks**.

The combination — *unordered cross‑FSM identity* (§4) **plus** *reorderable
delivery that can resurrect a dead session's signal* — is what makes the
deadlock reachable. Neither alone would.

---

## 6. The 2026‑06‑24 deadlock, step by step

Peers: **LOCAL** `uhCAkCNT` (lower key → acceptor/polite), **URU** `uhCAkovI`
(higher key → initiator/impolite). Times relative to the merged log.

1. **195.7 s** — operator sets URU's per‑peer carrier to *signals* on LOCAL
   (`setPeerCarrier`, manual): the clean FSM link `a7842bf7` is closed
   (`disconnectFromPeerVideo`), LOCAL sends `leave`. (Separate concern; not this
   bug — see `project_presence_pane_bug`.)
2. URU's half loses ICE, runs its own reconnect, and around **227.9 s** is
   stale‑closed. Both sides are now tearing down and **allocating fresh FSMs**.
3. **220.2 s** — operator re‑enables (carrier → inherit). Reconnect begins.
   Through the churn, several FSMs are minted with **independent random
   connectionIds and `peerSessionId` reset to 0**: LOCAL's old `7548821a`, then
   LOCAL's new `abebb744`; URU's new `dd086be1`.
4. **234.2 s** — the deadlock fingerprint, logged by URU:
   ```
   Dropped stale answer:    signal.connectionId=abebb744,
                            fsm.connectionId=dd086be1, fsm.remoteConnectionId=7548821a   ×1
   Dropped stale candidate: …same…                                                       ×11
   ```
   URU's live FSM `dd086be1` has latched `remoteConnectionId = 7548821a` — a
   **dead** LOCAL session — because a late offer/candidate from `7548821a`
   arrived and was adopted (delivery is reorderable, §5). LOCAL has since moved
   to `abebb744` and, as the **polite acceptor, sends an answer** (not an offer).
   The routing stale‑drop (`connection-manager.ts:360‑376`) admits an
   answer/candidate only if its id matches `fsm.connectionId` **or**
   `fsm.remoteConnectionId`; `abebb744` matches neither, so **every signal from
   the live session is dropped.** The one escape — `isNewRemoteSession` takeover
   (`:335`) — fires **only for offers**, and the live side is answering. No
   ordered value exists to say "abebb744 is newer than 7548821a," so URU cannot
   tell it is rejecting the *current* peer.
5. ICE never starts → the round dies on the **7000 ms** connection timeout
   (`types.ts:387`) / **13320 ms** RTT‑scaled SDP‑exchange timeout. ~2–3 such
   rounds ≈ the observed `connect=21166ms`.

**Why determinism failed:** the roles (§2) were correct, but the *identity the
roles depend on* was non‑monotonic across the teardown. peerSessionId — the
designed filter — had reset to 0 on both new FSMs (§4), and the only cross‑FSM
id was unordered. So "newest attempt wins" was undecidable, and a resurrected
dead‑session signal out‑ranked the live one.

### Root‑cause defects

- **D1 — non‑monotonic cross‑FSM identity.** `peerSessionId` resets per FSM
  (`types.ts:298` says it's within‑FSM by design); `connectionId` is unordered.
  No shared, ordered "connection generation" survives a teardown.
- **D2 — latch‑then‑reject.** A fresh FSM can adopt a dead session's id from a
  reordered late signal, then reject the live session; the takeout path only
  triggers on offers, so an answering peer can deadlock.
- **D3 — ownership/timing conflict (multi‑transport).** FSM persistent recovery
  + orchestrator `InitRequest` retries + **two** 15 s grace clocks run at once —
  the README's named anti‑pattern.
- **D4 — undocumented contract.** The identity model and its within‑FSM scope
  were never written down (`docs/webrtc-state-machine-plan.md` is missing); the
  orchestrator's teardown+recreate strategy unknowingly crossed that scope.

---

## 7. The fix — a monotonic, shared **connection epoch**

Restore determinism by giving the two nodes one **ordered, shared** identity that
**survives FSM recreation**: a per‑peer **`epoch`** (connection generation).

**Invariant (the contract):** *For a given peer pair, every signal carries the
epoch of the attempt that produced it. A node always prefers the highest epoch it
has seen: a strictly‑higher epoch supersedes (destroy + recreate, adopt); a
strictly‑lower epoch is dropped; equal epochs use the existing
connectionId/peerSessionId handling.* Epoch is allocated by the **orchestrator**
(which already owns attempt cadence and outlives any FSM), so it is monotonic
across teardown+recreate — the property `peerSessionId` lacked.

Concretely (additive, **backward‑compatible** — when `epoch` is absent, behavior
is exactly as today, so the 200 package tests stay green):

1. **Wire** (`types.ts`): add optional `epoch?: number` to `SignalMessage` and to
   the FSM/manager options; document it as the cross‑FSM generation that
   generalizes `peerSessionId`.
2. **Orchestrator** (`streams-store.ts`): keep a per‑peer monotonic
   `_connectionEpoch`. The **initiator** bumps it on each new `InitRequest` and
   includes it in the payload; the **acceptor** adopts the epoch from the
   `InitRequest`. Both pass it into `ensureConnection({ epoch })`. Because this
   map lives in the orchestrator, it does **not** reset when an FSM is recreated.
3. **Manager** (`connection-manager.ts`): store the epoch per agent; stamp it on
   every outgoing `SignalMessage`. In `_routeSignalToFSM`, when both the incoming
   and current epoch are present, **decide supersede/drop by epoch order** — for
   **any** signal type, not just offers (this is what D2 needs: an answer from a
   higher epoch is the live session and must be adopted; a candidate from a lower
   epoch is dead and dropped). Remove the deferred `setTimeout(…,0)` map delete in
   favor of synchronous removal guarded by `current === fsm` (closes the §5 seam).
4. **FSM** (`peer-connection-fsm.ts`): accept/store the epoch, expose a getter,
   and thread `remoteEpoch` into `handleRemoteSignal` / `_validateSignalSession`
   so the within‑FSM `peerSessionId` ordering becomes a *sub‑order* under epoch.
5. **Timing (D3):** for the Presence carrier orchestrator, keep the FSM's
   reconnect attempts low (fail fast, per README) and collapse the two 15 s grace
   windows to a single owner, so a superseded attempt is abandoned in ~1
   signaling RTT instead of waiting out 7–13 s timeouts.

**Why this is deterministic.** Epoch is a total order shared by both nodes and
monotonic across every teardown. At any instant each node can answer "is this
signal from the current attempt, an older one, or a newer one?" with a single
integer comparison — no reliance on delivery order, on offer‑vs‑answer, or on a
per‑FSM counter that resets. A resurrected dead‑session signal (§6 step 4) now
carries a strictly‑lower epoch and is dropped; the live answer carries the
current epoch and is adopted. The glare rule (§2) still breaks ties *within* an
epoch via polite/impolite.

**Why it is safe to land incrementally.** The field is optional; the manager and
FSM fall back to today's connectionId/peerSessionId logic when `epoch` is
`undefined`. Existing consumers and all 200 tests are unaffected until the
orchestrator opts in by sending an epoch.

### Regression test (must fail before, pass after)

Two FSMs via a mock `RTCPeerConnection`. Drive A→B to `connected`; tear down;
recreate both; then **deliver a stale‑epoch offer/candidate from the dead session
after the fresh FSMs exist**, interleaved with the live answer. Assert: the live
(higher‑epoch) session reaches `connected` without a stale‑drop deadlock, and the
dead‑epoch signals are dropped. This reproduces §6 and pins the invariant.

---

## 8. Operating rule for Presence (multi‑transport)

Per the README ownership contract: the **carrier orchestrator owns give‑up and
timing; the FSM fails fast and yields.** Practically — one grace clock, low FSM
`maxAttempts`, orchestrator drives re‑`InitRequest` with a fresh **epoch**, and
no second recovery loop reaching into `pc.iceConnectionState`. Epoch is what lets
the orchestrator's "this is a new attempt" intent be legible to the FSM layer.

The epoch itself landed in `c143cda` + `c81bcd7`. **The rest of this rule has
not**, and the gap is worth stating plainly because three documents give three
different prescriptions and the code follows none of them:

- `reconnect-policy.ts` recommends `maxAttempts: Infinity` "for presence‑style
  apps", with the higher layer closing the connection when the peer leaves.
- `README.md` and §8 above recommend keeping `maxAttempts` **low** for
  multi‑transport orchestrators, so WebRTC yields quickly to the fallback carrier.
- **Presence passes no `reconnectPolicy` at all** — there is no `ReconnectPolicy`
  anywhere in `ui/src`, so the FSM silently uses `DefaultReconnectPolicy`.

Presence is both kinds of app, which is why the two library‑side notes disagree.
For Presence the multi‑transport rule is the operative one: a persistent FSM
fighting the carrier orchestrator starves the signals fallback. But the choice
has to actually be *passed* to be real. Until it is, the second recovery loop in
`streams-store.ts:5816` and the two independent 15s grace clocks are still
running alongside the FSM's own — the exact anti‑pattern `README.md:224-225`
names. See `MAINTAINABILITY_ASSESSMENT.md` §2 and §3.4.
