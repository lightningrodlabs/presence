# webrtc-peer — size & feature-necessity audit

Benchmark context: a reviewer evaluating whether to adopt this library flagged its
size (~3.1k lines) against their own working implementation of ~450 lines
(Perfect Negotiation + ICE restart, validated over a VPN). This document
attributes every line to a concern, identifies what is irreducible vs optional,
and proposes switches so the library can scale down per use-case.

## Measured footprint (source only, excludes tests)

| File | Lines | Primary concern |
|------|------:|-----------------|
| `peer-connection-fsm.ts` | 1,441 | FSM lifecycle + reconnect orchestration + diagnostics + view-model |
| `rtc-peer.ts` | 550 | **Core** Perfect-Negotiation wrapper (≈ the reviewer's 450-line equivalent) |
| `connection-manager.ts` | 540 | Multi-peer (mesh) orchestration + signal routing + aggregate view-model |
| `types.ts` | 390 | Types, defaults, transition table (mostly type-erased at runtime) |
| `transition-recorder.ts` | 89 | Pure observability (opt-in ring buffer) |
| `index.ts` | 75 | Exports |
| `reconnect-policy.ts` | 59 | Resilience (pluggable backoff) |
| **Total** | **3,144** | |

Tests add a further 3,441 lines across `src/__tests__/` (not counted above).

## The 7× gap, explained

The reviewer's ~450 lines map almost exactly onto `rtc-peer.ts` (550). The other
~2,600 lines are **three optional layers the minimal implementation does not
have**, each cleanly separable:

1. **FSM lifecycle + resilience** (`peer-connection-fsm.ts`, `reconnect-policy.ts`)
2. **Multi-peer mesh orchestration** (`connection-manager.ts`)
3. **Observability** (view-models, diagnostic transition emissions, recorder)

None of the three is load-bearing for a *single* working connection; all three
exist because Presence is an N-way mesh with a live connection-health UI and a
forensic trail requirement (see the Presence-pane / connection-lifecycle work).

### Concern attribution within `peer-connection-fsm.ts` (1,441 lines, approximate)

| Concern | ~Lines | Category | Needed for Presence? |
|---------|------:|----------|----------------------|
| State machine core (`_transition`, `_onEnterState`, `_startTimersForState`, guards) | 250 | Resilience/lifecycle | Yes |
| Reconnection (`_scheduleReconnectAttempt`, `_attemptIceRestart`, `_attemptFullReconnect`, `_handleTransportFailure`) | 120 | Resilience | Yes (the ICE-restart the reviewer added) |
| DTLS watchdog (`_startDtlsWatchdog`/`_cancelDtlsWatchdog`) | 130 | Resilience + diagnostics | Yes, but diagnostic-heavy |
| Track/sender management (`_addLocalStream`, `_senderCanSend`, `_senderMatchesKind`, `refreshMedia`, `replaceTrack`, `removeLocalStream`) | 180 | Core media + renegotiation robustness | Yes |
| View-model (`_computeViewModel`/`_computeProgress`/`_computeStatusText`/`_notifyViewModelChange` + listeners) | 150 | **Observability** | Only if UI subscribes |
| Diagnostic `_onTransition` emissions (5 `DIAG:` blocks + per-event ICE logging) | ~120 | **Observability** | No — pure instrumentation |
| Signal-session validation (`_validateSignalSession`, multi-session offer handling) | 60 | Resilience (reconnect churn) | Yes for Holochain |
| Peer event wiring (`_setupPeerEvents`) | 200 | Bridge + some diagnostics | Yes (minus diagnostics) |
| Boilerplate (ctor, getters, timer mgmt, emit) | 230 | Core | Yes |

### Dead / redundant findings

- **SFU role scaffolding** — `ConnectionRole` has `sfu-upstream`/`sfu-downstream`/`sfu-relay`
  variants ([types.ts:101-105](../packages/webrtc-peer/src/types.ts#L101-L105)) that
  never branch behavior. `role` is only stored and forwarded to `onPeerCreated`
  ([peer-connection-fsm.ts:178](../packages/webrtc-peer/src/peer-connection-fsm.ts#L178),
  [785](../packages/webrtc-peer/src/peer-connection-fsm.ts#L785)). Pure scaffolding
  until an SFU lands; could be dropped to `'mesh'` only.
- **Duplicated transceiver lookups** — `_senderCanSend` and `_senderMatchesKind`
  each independently `getTransceivers().find(t => t.sender === sender)`
  ([peer-connection-fsm.ts:858-892](../packages/webrtc-peer/src/peer-connection-fsm.ts#L858-L892)).
  Could share one lookup.
- **Worst-case `dtls-failed` path** (claim 4) — the terminal interpretation at
  [peer-connection-fsm.ts:996-1004](../packages/webrtc-peer/src/peer-connection-fsm.ts#L996-L1004)
  exists *because* the code can't currently disambiguate ICE vs DTLS failure.
  Fixing claim 4 (inspecting `iceConnectionState`/DTLS transport state) may let
  this branch and some of its complexity go away rather than grow.

Note: the **non-trickle ICE path** in `rtc-peer.ts` (~60 lines) is NOT dead — it
is user-toggleable (`trickleICE` localStorage switch in the app), so it stays.

## Switch matrix — scaling down per use-case

Each switch is independent and subtractive from the 3,144-line baseline.

| Switch | What it removes | ~Lines saved | Default |
|--------|-----------------|-------------:|---------|
| **A. Diagnostics off** | `DIAG:` transition emissions + per-event ICE logging in FSM; don't import `TransitionRecorder` | ~210 | On for Presence (forensic trail) |
| **B. No view-model** | FSM + manager view-model computation/notify; `ConnectionViewModel` plumbing | ~230 | On for Presence (health UI) |
| **C. 1:1 (no manager)** | Use `PeerConnectionFSM`/`RTCPeer` directly; drop `ConnectionManager` | ~540 | On for Presence (mesh) |
| **D. Core only (no FSM)** | Use `RTCPeer` + a ~60-line reconnect loop; drop FSM + policy + manager + recorder | ~2,500 | — |
| **E. Drop SFU roles** | Collapse `ConnectionRole` to `'mesh'` | ~10 | — |

### Realistic floors

- **Current (mesh + observability):** ~3,144
- **Mesh, diagnostics stripped (A):** ~2,930
- **Mesh, headless — no diag, no view-model (A+B):** ~2,700
- **1:1 with full FSM + reconnect + diag (C):** ~2,600
- **1:1, lean (A+B+C):** ~2,300
- **Core tier (D) — `RTCPeer` + minimal reconnect:** **~600–650**

The core tier (~600) lands within range of the reviewer's ~450, confirming the
gap is **entirely the three optional layers**, not bloat in the connection core.
A consumer who wants the reviewer's experience can already use `RTCPeer`
directly today; the FSM/manager/observability are opt-in by import.

## Recommendations (ordered)

1. **Make the tiers explicit and documented**, not just implicit in the export
   surface. Three documented entrypoints — `RTCPeer` (core), `PeerConnectionFSM`
   (single peer + resilience), `ConnectionManager` (mesh) — with a line-cost note
   each, so an evaluator sees they aren't forced to take 3.1k to get a working
   connection.
2. **Gate diagnostics behind a flag** (switch A). The `DIAG:` emissions are the
   highest-volume, lowest-value-per-line code for any consumer that isn't
   debugging this library specifically. A `diagnostics?: boolean` on
   `ConnectionConfig` (default off in the library, on in the Presence app) makes
   ~210 lines disappear from the hot path without losing them.
3. **Drop SFU role scaffolding** until an SFU actually exists (switch E).
4. **Fold the claim-4 fix in first** — it may shrink the failure-handling code
   rather than add to it.
5. **Defer view-model extraction** (switch B). Presence depends on it; only worth
   separating if a headless embedder appears.

These are quality/structure recommendations; none changes connection behavior.
Behavioral fixes (claims 1 and 4) are tracked separately and are sequenced ahead
of any size refactor so the audit measures corrected code.
