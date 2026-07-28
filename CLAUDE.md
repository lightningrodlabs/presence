- Communication style: No emotional tags or exclamation points. Just code-related information. Don't be "agreeable", test claims, be rigorous, evidence based, and rational.
- Commit & PR hygiene: No claude co-authored messages.
- run all tests and commands that would need dependencies with `nix develop -c`

## Which branch is real

`main-0.6` is the line that ships. v0.14.8 was built from it. **`main` is a dead end** — two commits since the split at `c589a6b`, both substantively present on `main-0.6`, one ui version behind, no `packages/` directory, no `test` script, no FSM work. The `v0.14.8` tag points at `main`, which is wrong; nothing tagged corresponds to what shipped.

Check your branch before reading source. Reading `ui/src/` from a `main` checkout gives answers that do not describe the shipped app.

## Read before changing connection, presence, or carrier code

`MAINTAINABILITY_ASSESSMENT.md` (repo root, 2026-07-27). It is verified against `main-0.6` @ `8eb07e5` with `file:line` citations, and was independently spot-checked 2026-07-28 (its "Meta-review" section). Its §3 documents defects that are live in the shipped build; do not rediscover them, and do not "fix" a symptom without checking whether it is already described there. But treat §3 as a verified **sample**, not a complete inventory — every phase so far has surfaced causes it does not list.

Documents in `docs/` are **not** reliable unless they carry a status header. 17 assertions across the docs and long comment blocks were verified FALSE and 13 more stale. `docs/WEBRTC_CONNECTION_PLAN.md` §2–§3 is wrong about what `connected` means, and `docs/CONNECTION_LIFECYCLE_PLAN.md` contradicts itself. The five documents verified sound are `WEBRTC_PEER_CLAIM2_DATACHANNEL_GATING.md`, `SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md`, `WEBRTC_CARRIER_ANALYSIS.md`, `packages/webrtc-peer/ROADMAP.md`, and `packages/webrtc-peer/README.md`. When code and prose disagree, the code is what ships.

## True today (facts, not goals)

- The FSM is the default media carrier. SimplePeer is unreachable by default **except** for screen share, which is hard-typed to it across 34 references (`screenShareOutTransport`/`screenShareInTransport`, all in `streams-store.ts`).
- Signals is a **module-layer fallback**, not a `PeerTransport` — `ui/src/transport/types.ts:26` says so explicitly. The `PeerTransport` interface exists but is never used as a type annotation.
- There are 21 independent sources of truth about peer liveness, using **at least 13 distinct time constants across 5 files** (re-counted 2026-07-28; the original "six clocks" undercounted). There is no single authority. Phase 1 fixed the carrier hole, not this.
- `nix develop -c npm run verify` is the gate: 428 unit tests plus a `tsc --noEmit` of both workspaces, in under 2 seconds. CI runs the same command on push and PR to `main-0.6`. (Phase 0 landed this; the `ui/` typecheck is green at `strict: true`, but only against a built `packages/webrtc-peer` — `verify` builds it first.)
- `StreamsStore` cannot be instantiated under `vitest` (`environment: 'node'`, constructor reads `window.sessionStorage`). Characterization tests around the class are not currently possible; extract pure decision functions instead. Phase 6 items 1–2 (injectable clock; construction/activation split) are promoted to run before Phase 2 (decision 2026-07-28) — the rest of Phase 6 stays behind the extraction phases.
- **Post-Phase 1 carrier facts.** Signals carries a present peer unless WebRTC is `connected` (ICE + DTLS up) — the complement of *media flowing*, not of *an attempt existing*; the rule is in `ui/src/transport/carrier-coverage.ts`. Every `ConnectionPhase` is routed by `routeTransportPhase` (`transport/media-event-policy.ts`), exhaustive over the union, with `failed`/`idle`/`closed` clearing the slot and `signaling` adopting a new `connectionId` when the transport replaced an FSM underneath us — **`ConnectionManager.fsm.destroy()` emits no transition, so a connection can disappear with no event at all**; never assume you will be told. On FSM links the FSM owns transport recovery and the pong-driven teardown stands down (`transport/stale-connection-policy.ts`); on SimplePeer links it does not. A link resolves to `'fsm'` only if the peer's payload proves their build can parse `SdpFsm` — capability outranks every preference. **None of this is field-validated**; the extracted decisions are covered, their wiring into `streams-store.ts` is not. Known bounded exception to the carrier invariant (recorded 2026-07-28): during `reconnecting`/`disconnected` the slot keeps `connected: true` (`routeTransportPhase` → `transport-owns-recovery`), so a peer can be off signals with no media flowing for the length of the transport's recovery window — and clearing a wedged FSM slot depends entirely on the FSM emitting `failed`.
- **Cross-version interop with ≤ v0.14.7 is a declared non-goal** (business decision, 2026-07-28). `resolveWebrtcImpl` rule 0 (capability outranks preference) stays as already-paid-for insurance. *Forward* interop is guarded by Phase 1.5's wire-contract gate — wire surface declared once and snapshot-tested, a per-release compat-corpus fixture, capability declared in the payload (`caps`) rather than inferred by field-probing — not by building old versions.

## Target state (not yet true — do not describe as current)

The plan in `MAINTAINABILITY_ASSESSMENT.md` §5 converges liveness onto four predicates with one authority each: **present**, **reachable**, **media-flowing**, **carrier-active**. Until a phase lands, do not write comments or docs asserting these as if they hold.

## Where knowledge goes

**Types > tests > this file > prose.** Push every invariant as far up that list as it will go. Anything that lands in prose is temporary and will rot silently — 17 assertions in this repo's documents were verified false while reading as current fact. The insights were right; the storage medium was wrong.

## The unit of change

Decisions go in pure functions: snapshot in, tagged union out, carrying a `reason`. Table-driven tests, no mocks. `ui/src/transport/auto-flip-policy.ts` is the template — copy its shape.

- **Exhaustive `switch` over a union type**, so an unhandled case is a compile error rather than a silent drop. `_dispatchMediaEvent` dropping five of eight `ConnectionPhase` members is the bug this prevents.
- **One authority per concept, one exported name.** A second implementation must delete the first. Adding a parallel path is the cheap wrong move and is how this codebase acquired 21 liveness sources.
- **Every important mock needs a negative control** — a test that fails if the mock cannot reproduce the bug the mock exists to catch. `MockRTCPeerConnection` cannot throw, which is why the `InvalidStateError` fix in `rtc-peer.ts` has no coverage and would survive being inverted.
- **Chase decision coverage, not line coverage.** The library sits at 90% and the orchestrator at 0%; every production bug has been in the orchestrator.
- **An abstraction not used as a type annotation gets deleted, not kept.** `PeerTransport` looks like a constraint and imposes nothing.

## Working agreements

1. **Replace or declare.** Every change either names the mechanism it replaces, or states explicitly that it adds a parallel one and why. "Runs in parallel with X; X remains the source of truth" is how this codebase acquired four parallel models — it requires a justification, not a passing mention.
2. **No new threshold without a named predicate.** Six liveness clocks arrived one constant at a time. A new timeout must say which predicate it serves and reuse that predicate's clock.
3. **Prose cites code or gets deleted.** An invariant comment names the `file:line` it constrains. Every document gets `Status: ACTIVE` / `SUPERSEDED (see X)` / `HISTORICAL`, following `docs/WEBRTC_PEER_CLAIM2_DATACHANNEL_GATING.md`, which does it correctly. A design doc marks each item landed or not-landed once it ships. Living prose cites files and tests, not commit hashes — the Phase 1 branch rewrite invalidated four hash citations.
4. **Decisions become pure functions before they become complicated.** `ui/src/transport/auto-flip-policy.ts` is the template: plain-object in, tagged union out, table-driven tests, no mocks.
5. **The gate runs, or it isn't a gate.** A disabled workflow, an unrun typecheck, and an unenforced `strict` flag are all recorded intentions, not constraints.
6. **One intent per branch.**
7. **A conclusion may not dismiss field evidence on the strength of passing tests.** This happened (`12cb027`, then `c143cda` six weeks later proved it wrong). The mocks in `packages/webrtc-peer` cannot throw, so they cannot reproduce the failure modes that actually occur in the field.
8. **A fix names the symptom's previous fixes.** Use "supersedes `<hash>`" in the commit message. The same pane-survival symptom was fixed three times in three layers over 71 days, and the third broke an invariant the first documented.
9. **Every phase PR gets an adversarial review by a session that did not write it**, reading only the diff and the code. The second cause of the §3.1(c) wedge was found exactly this way, before the field found it. The authoring session's self-review converges to agreement with itself; independence is the property that caught it.
