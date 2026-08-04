# webrtc-peer — size & feature-necessity audit

Status: HISTORICAL (assessment §8 item 7, second drift). The deletions this
audit recommended are banked: `transition-recorder.ts` and the
`ConnectionConfig.diagnostics` flag were deleted in Phase 5 (see CLAUDE.md's
Post-Phase 5 facts and the package CHANGELOG), so the table below asserts
files and flags that no longer exist. Re-run `wc -l packages/webrtc-peer/src/*.ts`
for current figures; nothing below describes current code.

Benchmark context: a reviewer evaluating whether to adopt this library flagged its
size (~3.1k lines) against their own working implementation of ~450 lines
(Perfect Negotiation + ICE restart, validated over a VPN). This document
attributes every line to a concern, identifies what is irreducible vs optional,
and proposes switches so the library can scale down per use-case.

## Measured footprint (source only, excludes tests)

Counted 2026-07-27 with `wc -l packages/webrtc-peer/src/*.ts`. Re-run that
command rather than trusting this table if the numbers matter to a decision —
the previous version of this table was ~550 lines under the real figure and
every derived number in the document inherited the error.

| File | Lines | Primary concern |
|------|------:|-----------------|
| `peer-connection-fsm.ts` | 1,613 | FSM lifecycle + reconnect orchestration + diagnostics + view-model |
| `connection-manager.ts` | 647 | Multi-peer (mesh) orchestration + signal routing + aggregate view-model |
| `rtc-peer.ts` | 622 | **Core** Perfect-Negotiation wrapper (≈ the reviewer's 450-line equivalent) |
| `types.ts` | 499 | Types, defaults, transition table (mostly type-erased at runtime) |
| `reconnect-policy.ts` | 117 | Resilience (pluggable backoff) |
| `transition-recorder.ts` | 89 | Pure observability (opt-in ring buffer) |
| `index.ts` | 77 | Exports |
| `core.ts` | 31 | Core-tier entrypoint (see Recommendations) |
| **Total** | **3,695** | |

Tests add a further 4,124 lines across `src/__tests__/` (not counted above).

## The 8× gap, explained

The reviewer's ~450 lines map onto `rtc-peer.ts` (622). The other ~3,070 lines
are **three optional layers the minimal implementation does not have**, each
cleanly separable:

1. **FSM lifecycle + resilience** (`peer-connection-fsm.ts`, `reconnect-policy.ts`)
2. **Multi-peer mesh orchestration** (`connection-manager.ts`)
3. **Observability** (view-models, diagnostic transition emissions, recorder)

None of the three is load-bearing for a *single* working connection; all three
exist because Presence is an N-way mesh with a live connection-health UI and a
forensic trail requirement (see the Presence-pane / connection-lifecycle work).

### Concern attribution within `peer-connection-fsm.ts` (approximate)

The per-concern line counts below were taken when the file was 1,441 lines; it is
**1,613** today. The proportions are still indicative, the absolute numbers are
not — the ~170 lines of growth are mostly the tiered-readiness and
establishment-timeline work.

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

Each switch is independent and subtractive from the 3,695-line baseline.

| Switch | What it removes | ~Lines saved | Default |
|--------|-----------------|-------------:|---------|
| **A. Diagnostics off** | `DIAG:` transition emissions + per-event ICE logging in FSM; don't import `TransitionRecorder` | ~210 | Flag exists; **off** — see Recommendations |
| **B. No view-model** | FSM + manager view-model computation/notify; `ConnectionViewModel` plumbing | ~230 | On for Presence (health UI) |
| **C. 1:1 (no manager)** | Use `PeerConnectionFSM`/`RTCPeer` directly; drop `ConnectionManager` | ~647 | On for Presence (mesh) |
| **D. Core only (no FSM)** | Import `@lightningrodlabs/webrtc-peer/core`; drop FSM + policy + manager + recorder | ~2,900 | — |
| **E. Drop SFU roles** | Collapse `ConnectionRole` to `'mesh'` | ~10 | — |

### Realistic floors

- **Current (mesh + observability):** ~3,695
- **Mesh, diagnostics stripped (A):** ~3,485
- **Mesh, headless — no diag, no view-model (A+B):** ~3,255
- **1:1 with full FSM + reconnect + diag (C):** ~3,050
- **1:1, lean (A+B+C):** ~2,610
- **Core tier (D) — `RTCPeer` + its types + a minimal reconnect loop:** **~700–800**

The core tier lands within range of the reviewer's ~450 once you discount the
types module it shares, confirming the gap is **the three optional layers**, not
bloat in the connection core. That tier is now a real entrypoint, not a claim:
`@lightningrodlabs/webrtc-peer/core` exports `RTCPeer` and nothing else.

## Recommendations (ordered)

1. **Make the tiers explicit and documented** — **done.** `src/core.ts` is a real
   entrypoint (`@lightningrodlabs/webrtc-peer/core`) exporting `RTCPeer` and the
   types its API uses, and `README.md` documents the three tiers with a line cost
   each. An evaluator can see they aren't forced to take 3.7k lines to get a
   working connection.
2. **Gate diagnostics behind a flag** (switch A) — **half done, and the half that
   landed does nothing.** `ConnectionConfig.diagnostics` exists and defaults to
   `false` (`types.ts:390`, `:407`). The Presence app never sets it, and
   `streams-store.ts:5092` discards `DIAG:` output even if it were set. So the
   flag is dead in both directions: the forensic trail this document assumed was
   "on for Presence" is not being collected through this path. Either wire it up
   or delete the flag and the emissions — do not leave it as a switch that
   appears to work.
3. **Drop SFU role scaffolding** until an SFU actually exists (switch E). Note
   `TRANSPORT_REFACTOR_PLAN.md` Phase 6 still plans to use these roles, so this is
   a genuine either/or, not a cleanup.
4. **Fold the claim-4 fix in first** — it may shrink the failure-handling code
   rather than add to it.
5. **Defer view-model extraction** (switch B). Presence depends on it; only worth
   separating if a headless embedder appears.

These are quality/structure recommendations; none changes connection behavior.
Behavioral fixes (claims 1 and 4) are tracked separately and are sequenced ahead
of any size refactor so the audit measures corrected code.
