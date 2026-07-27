- Communication style: No emotional tags or exclamation points. Just code-related information. Don't be "agreeable", test claims, be rigorous, evidence based, and rational.
- Commit & PR hygiene: No claude co-authored messages.
- run all tests and commands that would need dependencies with `nix develop -c`

## Which branch is real

`main-0.6` is the line that ships. v0.14.8 was built from it. **`main` is a dead end** — two commits since the split at `c589a6b`, both substantively present on `main-0.6`, one ui version behind, no `packages/` directory, no `test` script, no FSM work. The `v0.14.8` tag points at `main`, which is wrong; nothing tagged corresponds to what shipped.

Check your branch before reading source. Reading `ui/src/` from a `main` checkout gives answers that do not describe the shipped app.

## Read before changing connection, presence, or carrier code

`MAINTAINABILITY_ASSESSMENT.md` (repo root, 2026-07-27). It is verified against `main-0.6` @ `8eb07e5` with `file:line` citations. Its §3 documents defects that are live in the shipped build; do not rediscover them, and do not "fix" a symptom without checking whether it is already described there.

Documents in `docs/` are **not** reliable unless they carry a status header. 17 assertions across the docs and long comment blocks were verified FALSE and 13 more stale. `docs/WEBRTC_CONNECTION_PLAN.md` §2–§3 is wrong about what `connected` means, and `docs/CONNECTION_LIFECYCLE_PLAN.md` contradicts itself. The five documents verified sound are `WEBRTC_PEER_CLAIM2_DATACHANNEL_GATING.md`, `SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md`, `WEBRTC_CARRIER_ANALYSIS.md`, `packages/webrtc-peer/ROADMAP.md`, and `packages/webrtc-peer/README.md`. When code and prose disagree, the code is what ships.

## True today (facts, not goals)

- The FSM is the default media carrier. SimplePeer is unreachable by default **except** for screen share, which is hard-typed to it across 32 call sites.
- Signals is a **module-layer fallback**, not a `PeerTransport` — `ui/src/transport/types.ts:26` says so explicitly. The `PeerTransport` interface exists but is never used as a type annotation.
- There are 21 independent sources of truth about peer liveness, using at least six different time constants. There is no single authority.
- `ui/` has no typecheck script; `vite build` never checks types, so `"strict": true` in `ui/tsconfig.json` does not run.
- 315 unit tests exist and pass in under 2 seconds. Nothing runs them: root `npm test` runs zero tests, and CI is disabled by filename.
- `StreamsStore` cannot be instantiated under `vitest` (`environment: 'node'`, constructor reads `window.sessionStorage`). Characterization tests around the class are not currently possible; extract pure decision functions instead.

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
3. **Prose cites code or gets deleted.** An invariant comment names the `file:line` it constrains. Every document gets `Status: ACTIVE` / `SUPERSEDED (see X)` / `HISTORICAL`, following `docs/WEBRTC_PEER_CLAIM2_DATACHANNEL_GATING.md`, which does it correctly. A design doc marks each item landed or not-landed once it ships.
4. **Decisions become pure functions before they become complicated.** `ui/src/transport/auto-flip-policy.ts` is the template: plain-object in, tagged union out, table-driven tests, no mocks.
5. **The gate runs, or it isn't a gate.** A disabled workflow, an unrun typecheck, and an unenforced `strict` flag are all recorded intentions, not constraints.
6. **One intent per branch.**
7. **A conclusion may not dismiss field evidence on the strength of passing tests.** This happened (`12cb027`, then `c143cda` six weeks later proved it wrong). The mocks in `packages/webrtc-peer` cannot throw, so they cannot reproduce the failure modes that actually occur in the field.
8. **A fix names the symptom's previous fixes.** Use "supersedes `<hash>`" in the commit message. The same pane-survival symptom was fixed three times in three layers over 71 days, and the third broke an invariant the first documented.
