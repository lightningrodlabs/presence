# Presence — Maintainability Assessment and Forward Plan

**Scope:** `main-0.6` @ `8eb07e5` — the line that shipped as v0.14.8 (webhapp `7fb64e01dee9…`, released 2026-06-16).
**Date:** 2026-07-27.

## Method and confidence

Every claim is cited to `file:line` at the revision above and was checked against code, not inferred from commit messages or comments. Where a comment or document asserts something, that assertion is treated as a claim to be verified, not as evidence — several turned out to be false. Findings that could not be verified are marked as such.

Nothing runtime was observed. The failure scenarios below are traced statically through the code; where the network premise matters (e.g. that pong loss and media loss decorrelate), the code consequence is verified but the premise is not.

Note: the repository working tree is checked out at `main` (`cc0ce47`), a *different lineage* from the shipped app — older SimplePeer-era code at ui 0.14.7. All analysis used a clean export of `main-0.6`. That divergence is itself a finding (§3.7).

---

## 1. Verdict

The code is not falling apart, and the sense of being on a cusp is accurate but misdirected. The runtime is genuinely in its best state yet — which is consistent with what the code shows, because the parts that carry a call (the WebRTC engine, refcounted device ownership, the frame carriers) are the well-built parts.

What has degraded is **verifiability**, not correctness. The system holds several parallel models of the same concept, each individually reasonable, none retired when its successor arrived. There are 21 independent sources of truth about whether a peer is present or their media is flowing. The cost falls entirely on the ability to reason about a change *before* making it — precisely the reluctance being experienced.

This is tractable, and it does not call for a rewrite. The largest single item in the plan is a deletion, and the highest-value item is wiring up 315 tests that already exist and already pass.

Two defects are serious enough to fix regardless of the plan:

- **A single unhandled throw permanently kills all signal processing for the session** (§3.0) — three lines to fix, and there are four unguarded `JSON.parse` calls plus one missing null check that can trigger it.
- **The signals fallback is gated on the absence of a WebRTC *attempt*, not the absence of working WebRTC *media*** (§3.1) — which has a permanent-failure mode where a peer loses both carriers for the rest of the session.

---

## 2. The pattern underneath the debt

> **Intent gets recorded in artifacts that don't execute, while the code that runs keeps its older logic.**

Five verified instances:

| Intent recorded in… | …that never executes | The older logic still running |
|---|---|---|
| `AudioLinkState`, a complete user-facing liveness model (`ui/src/types.ts:106`) | used only to paint: status ring, stats panel, overlay, logging | sounds, panes, carrier routing and teardown each read raw signals directly |
| `PeerTransport`, a 15-member interface (`ui/src/transport/types.ts:143`) | never used as a type annotation; the consumer's import at `streams-store.ts:8` is unused | consumers hold the concrete union `SimplePeerTransport \| FsmTransport` |
| `ui/tsconfig.json` — `"strict": true`, `"noEmitOnError": true` | nothing invokes `tsc` on `ui/`; `vite build` strips types via esbuild without checking | ~25,000 lines where a type error cannot fail a build |
| `packages/webrtc-peer/README.md` — two coherent recovery contracts, one for single-transport consumers and one for multi-transport orchestrators (`:205-225`) | no enforcement | Presence follows **neither**: it never passes a `reconnectPolicy` (there is no `ReconnectPolicy` anywhere in `ui/src`), so the FSM runs its default persistent retry *and* `streams-store.ts:5816` runs a competing teardown loop *and* two independent 15s grace clocks run side by side — the exact anti-pattern `README.md:224-225` names |
| 315 unit tests, passing in under 2 seconds | no CI, and root `npm test` runs **zero** of them | every change ships unverified |

These are not coincidences. Each is a case where a better model was authored, adopted where adoption was cheap (a type, a doc, a config, a rendering path), and never propagated to the code that decides. The result: **the most articulate description of a subsystem is reliably not the one in force** — which is what makes the codebase unreadable both to you and to any future AI session that reads the prose and believes it.

"AI coherence drift" names the outcome fairly, but the mechanism is more specific and more fixable than model degradation: **additive change without retirement, in the absence of any enforcement gate.** Nothing ever forced the old path to be removed when the new one landed, and nothing ever failed when prose and code diverged. Fix the gates and the drift largely stops.

---

## 3. Evidence

### 3.0 Lead finding — one unhandled throw permanently kills all signal processing

This was not on the list of things to look for. It is the most severe defect found, and the cheapest to fix.

`handleSignal` (`streams-store.ts:5390-5404`) drains its queue with no `try/finally`:

```ts
this._processingSignal = true;              // :5394
while (this._signalQueue.length > 0) {
  await this._processSignal(nextSignal);    // :5401  ← can reject
}
this._processingSignal = false;             // :5403  ← skipped on throw
```

`_processingSignal` has exactly four references in the file (declaration `:181`, read `:5392`, set true `:5394`, set false `:5403`). If `_processSignal` ever rejects, the flag is stranded `true` and `:5392` turns every subsequent signal into push-and-return — **for the rest of the session**. Holochain signals carry pings, pongs, presence, SDP, and module data, so the room goes quiet with no error surfaced and no recovery short of a page reload.

Reachable throw sites, all outside any `try`:

- `handleSdpData:6344` — `JSON.parse(signal.payload)`, unguarded, the first statement of the handler. Same at `:6360`, and at `handleInitRequest:6005` / `handleInitAccept:6097`. Any malformed, truncated, or version-skewed payload from any peer is sufficient.
- `handleSdpData:6357` calls `updateConnectionStatus(peer, {type:'SdpExchange'})`, which reaches `:4386`: `if (currentStatus.type === 'Connected')` — **missing the `currentStatus &&` guard that both sibling branches have** (`:4348` for `InitSent`, `:4366` for `AcceptSent`). A peer with no entry in `_connectionStatuses` throws `TypeError`.

That last path is reachable through a real window: `pingAgents` seeds `_connectionStatuses` for known agents every 2s (`:2124-2132`), but `handlePongUi` populates `_knownAgents` from pong metadata (`:5719-5732`) **without** seeding statuses. A peer learned via pong who sends `SdpData` before the next ping tick hits an undefined status. The FSM acceptor path at `:484` calls the same method on an incoming offer.

Fix: `try/finally` around the drain, plus `currentStatus &&`. Roughly three lines, testable in about ten, no browser needed.

### 3.1 The carrier-coverage hole — the one real bug class

`_signalsTargets` (`streams-store.ts:312-323`) is `activeAgents \ openConnections`. Membership requires that **no entry exists** in `_openConnections` — not that WebRTC media is actually flowing:

```ts
for (const pubkey of Object.keys(active)) {
  if (!connections[pubkey]) targets.add(pubkey);
}
```

But an entry is installed the moment FSM signaling *begins*, with `connected: false` (`streams-store.ts:474-484`). So a peer drops out of the signals carrier at the **start** of a WebRTC attempt, and only rejoins if the entry is deleted.

Three consequences, in ascending severity:

**(a) Every negotiation opens a silence window.** For a peer currently carried by signals, audio stops when negotiation starts and does not resume until WebRTC connects. On a flapping link this repeats each retry cycle (`INIT_RETRY_THRESHOLD = 5000`, `:86`). It self-heals: the SDP-exchange timeout at `:6214-6230` deletes the entry after 15s — **but only if the status is still `SdpExchange`**.

**(b) A stale-pong peer loses outbound audio while the UI counsels patience.** `_signalsTargets` derives from `_activeAgents` (the 6-second clock) alone, while the tile survives on media liveness (`isPeerMediaLive`, 3s window, `:3400`). A pong gap therefore removes them as a signals *send* target — we still hear them, they hear nothing from us — while the tile stays up and the amber tooltip says "It should recover on its own" (`room-view.ts:3147`). Voice sends no stop notice (`voice.ts:404-421`), unlike the filmstrip (`:494-508`), so the far end just goes quiet.

**(c) Retry exhaustion wedges the peer permanently.** This is the serious one, and it compounds with the above:

- `packages/webrtc-peer/src/peer-connection-fsm.ts:632-639` — `failed` starts a 5s timer → `idle`; `:693-698` — entering `idle` calls `_destroyPeer()`, so the `pc` is gone.
- `connection-manager.ts:506-521` — the comment says "Clean up closed/failed connections from the map"; the code is `if (entry.toState === 'closed')`. **`failed` is not handled.** No `connection-closed` is emitted.
- `streams-store.ts:463-492` — `_dispatchMediaEvent` is an if/else-if chain with **no else**, handling only `signaling`, `connected`, `closed`. Five of the eight declared phases, including `failed`, are silently dropped.
- The pong-driven backstop can't save it: `:5818` reads `pc?.iceConnectionState`, and the pc was destroyed, so `iceState` is `undefined` — no branch fires.
- The SDP timeout can't either: it requires status `SdpExchange`, and a peer that connected and later failed is past that.

Net: `_openConnections[peer]` survives with `connected: true` forever → a rendered pane for a dead link, **and** permanent exclusion from `_signalsTargets`, so the fallback carrier can never engage for that peer again. Recovery requires rejoining the room.

The fix for the first half exists, unmerged, on `webrtc-peer-spec-fixes` (`279d533`). **Order matters**: routing `failed` through `_handleMediaClosed` is safe alone; adding that commit's `handlePongUi` guard *without* it removes the only thing that currently clears an FSM slot and makes the wedge worse.

### 3.2 Liveness is answered 21 different ways, with at least six clocks

| Authority | Threshold | Governs |
|---|---|---|
| `_activeAgents` (`:276-294`) | **6s** (`3 * PING_INTERVAL`) | join/leave sounds, `_signalsTargets` |
| `isPeerMediaLive` (`:3400`) | **3s** flow window | pane survival, presence set |
| `lastSeenBucket` (`:3279`) | **15s** fresh / **30s** gone | status dot; `absent` in the roll-up |
| voice `peerLastRecvMs` | 2000 / 3000 (three call sites) | audio-link roll-up, stats |
| filmstrip TTLs | 3000 (`:3367`), 5000 (`video-filmstrip.ts:114`), plus a dead 3000 (`:60`) | video liveness, display clearing |
| remote testimony (`peerLinks`) | 5600 (`2.8 * PING_INTERVAL`, duplicated at **four** sites) | phantom detection, observer views |

**Your reported bug lives here.** Join/leave chimes diff `_activeAgents` keys directly (`room-view.ts:538-553`) with no media guard, so a signal gap plays leave-then-join while the FSM stream is untouched and the ring stays green. Commit `cd05dde` hardened the *pane* against exactly this and left the *sound* alone. One refinement to the mechanism: `_activeAgents` is a `derived` that calls `Date.now()` inside the derivation, so it recomputes only when `_knownAgents` is written — eviction actually fires on the next `pingAgents()` write (`:2121`), making real latency 6–8s rather than exactly 6s.

Related divergences from the same root: a signals-only peer with stale pongs gets **audio with no tile** (`_visiblePeers` tests only `conn?.connected`, `room-view.ts:700`, contradicting its own docblock); three separate grid-geometry counters disagree during the flap (`room-view.ts:733`, `:856-859`, `:2896-2899`); and for the 9 seconds between the 6s and 15s thresholds a peer shows a green dot with no tile.

Worth noting what the app *doesn't* use: `_checkTrackHealth` (`:5239-5382`) observes `inbound-rtp.bytesReceived` — the only real media-byte measurement anywhere in the system — and its sole action is to send a `request-track-refresh` message. It drives no presence and no teardown decision. The one authority that actually knows whether media is flowing has no authority over anything.

### 3.3 The transport abstraction is decorative

`PeerTransport` is declared, implemented by both classes, imported once by the consumer, and **never used as a type annotation**. Every consumer declaration is the concrete union (`streams-store.ts:252-254`, `:262`, `:591`, `:602`, `:612`, `:617`, `:850`). A third implementation cannot be slotted in without editing `streams-store.ts`. The unused `import type { … PeerTransport }` at `:8` is the fossil of the intended design — and nothing flags it, because there is no lint config and no typecheck gate.

`getRTCPeerConnection` sits on both classes but on **neither the interface**, reachable only because callers hold concrete types. Nine call sites, all in `streams-store.ts`: five are control/recovery (`:1064` sender params, `:4597` per-peer `replaceTrack`, and the three ICE-teardown supervisors at `:5818`, `:5511`, `:5929`), and of the four "diagnostic" uses, two duplicate the interface's own `getStats()` and two exist only to feed the sensors those supervisors read. **No remaining use requires the escape hatch.**

Also dead: `recreateDataChannel` and `restartIce` (`fsm-transport.ts:259`, `:268`) have zero callers outside their own tests.

### 3.4 Three independent teardown authorities on one connection

1. `streams-store.ts:5818` — pong-driven, 15s grace, evaluated every 2s per peer.
2. `simple-peer-transport.ts:565-654` — SimplePeer's own, 5s grace, 3 restarts.
3. `packages/webrtc-peer/src/peer-connection-fsm.ts` — the FSM's own reconnect policy and grace.

For an FSM peer, #1 and #3 are both live, and #1 will call `closeConnection()` while #3 is performing an in-place ICE restart — the "media flows briefly then suddenly reconnects" churn that the comment directly above #1 warns about.

### 3.5 The carrier tax, quantified

**48 branch points** and **323 carrier-aware lines** across 10 files, **73% of them in `streams-store.ts`** (235 lines, 34 branches). By origin: **89 lines** exist only because there are two WebRTC implementations; **121 lines** exist only because signals is a third thing that isn't a transport.

### 3.6 315 tests exist, pass in under 2 seconds, and guard nothing

| | `packages/webrtc-peer` | `ui/` |
|---|---|---|
| source | 3,079 lines | ~25,000 (`streams-store.ts` 6,600; `room-view.ts` 4,540) |
| tests | 3,456 lines, 205 tests, 90% stmt coverage | 110 tests; **zero** for either large file |
| typecheck script | yes | **none** |
| publish gate | `prepublishOnly: typecheck && test && build` | none |

Root `npm test` builds wasm, packs the happ, then runs `npm t -w tests` — and `tests/` contains one 3-line file with no tests, so it exits `No test files found`. There is no CI (`.github/workflows/test.yaml.notinuse` is disabled by filename). Running the suites manually: **205 + 110 pass in under 2 seconds combined.**

Two fidelity caveats on what those tests prove:

- **The mock never throws.** All 205 engine tests drive a hand-written `MockRTCPeerConnection` whose `setRemoteDescription` accepts anything in any state. The defensive `try/catch` at `rtc-peer.ts:381-396` — written specifically for the duplicate-answer `InvalidStateError` that is your #1 documented production failure — has **zero** tests. Invert its condition and 205 tests still pass.
- `peer-connection-fsm.test.ts` (78 tests) is genuinely good and would catch transition regressions; `rtc-peer.test.ts` is substantially delegation-assertion (45 of 73 assertions are `toHaveBeenCalled*`); `two-peer-integration.test.ts` integrates the FSM against itself through mocks, which proves protocol self-consistency, not browser behavior.
- `ui/src/transport/fsm/__tests__/test-helpers.ts` is a **verbatim 571-line duplicate** of the package's copy, differing in one import line, with nothing detecting drift.
- The highest-fidelity test in the repo — `ui/harness/voice-playout.spec.ts`, a real decoder in real Chromium *with a negative control* that reproduces the bug it fixed — is also the one least likely ever to run (separate script, needs Playwright and a dev server).

**And a hard constraint that shapes the plan: `StreamsStore` cannot currently be instantiated in the test runner at all.** `ui/vitest.config.ts` sets `environment: 'node'`, and the constructor reads `window.sessionStorage` at `:301`, so `new StreamsStore(...)` throws immediately. Getting to a first assertion would require jsdom plus stubs for `navigator.mediaDevices` (`:392`), `RTCPeerConnection`, `MediaStream`, `AudioContext`/`AnalyserNode` (`:4121`), fakes for `RoomClient`/`RoomStore`/`PresenceLogger`, and neutralizing the two singletons handed `this` during construction (`:427-428`). Beyond that, the behavior most worth pinning is timing-dependent (15s ICE grace, 15s SDP timeout, 5s init retry, 2s ping), so such a suite would be slow, flaky, and would pin the defects above as expected behavior. **Wrapping the class in characterization tests is not the route.** Extracting its decisions as pure functions is.

### 3.7 The release path is unverified end to end

v0.14.8 was hand-built: the shipped webhapp is byte-identical to `workdir/presence.webhapp`, built locally 2026-06-15 19:42 from `main-0.6` @ `7b86951`. But the `v0.14.8` tag — locally and on `origin` — points at `cc0ce47` on `main`, a different lineage whose `ui/package.json` still reads 0.14.7. **Nothing tagged corresponds to what shipped.** The release hashing script still reads `weave hash-webhapp FIXME ./workdir/presence.webhapp`.

### 3.8 SimplePeer survives only because screen share needs it

The FSM is the effective default: `myWebrtcImpl()` returns `'fsm'` (`:3653`), the conversation module's default payload sets `webrtcImpl: 'fsm'` (`conversation.ts:86`), and `resolveWebrtcImpl` returns `'fsm'` if *either* side's global is `'fsm'` (`auto-flip-policy.ts:155`). But screen share is hard-typed `SimplePeerTransport` (`:253-254`, constructed `:351-352`) across **32 call sites**, with no FSM screen-share path anywhere.

Two defects found alongside:
- `conversation.ts:73-76` says that when both sides set disagreeing per-peer overrides, `simplepeer` wins. The code returns `fsm` (`auto-flip-policy.ts:149-152`, confirmed by its own tests). The comment is wrong.
- The backward-compatibility path is inert: a missing payload field maps to `'simplepeer'` (`conversation.ts:96`) so pre-FSM peers are "recognised as simplepeer clients", but the union rule resolves the link to `'fsm'` regardless — so we send `SdpFsm` to a peer listening for `SdpData` and the connection silently never forms.

### 3.9 `streams-store.ts` — the shape of the fragility

6,600 lines, one class, **155 methods, 82 instance fields, 965 `this.` references**, no tests.

Size is not the finding; **fragmentation** is. The three largest concerns are each split across seven or eight non-contiguous ranges: media capture (1,182 lines / 8 ranges), diagnostics (934 / 7), presence and signals (585 / 7). The file's own section banners do not match the real partition — the block labelled `SIGNAL HANDLERS` (`:5385-6600`, 1,215 lines) contains presence, carrier policy, teardown, handshake, media reconciliation, screen share, and module-state merging.

`handlePongUi` (`:5643-5994`) is the concentrate: **352 lines, 8 levels of nesting, 38 branches, 29 distinct members touched, nine sequential unrelated decisions** — RTT statistics, presence merge, module-state reconciliation, carrier policy, stale-ICE teardown, InitRequest retry with tie-break, an audio-flag comparison that sends a data-channel message, and then the entire teardown-plus-retry sequence again for screen share. Decisions 1–4 sit inside one `try/catch` whose handler logs "Failed to parse pong meta data", so a throw in the module merge is reported as a parse error.

Three structural hazards worth naming:

- **The stale-ICE teardown predicate exists in triplicate** — `:5514-5518`, `:5821-5825`, `:5934-5938`, verbatim, each followed by a *different* cleanup set. Any change to the grace rule must be made correctly three times.
- **Teardown cleanup diverges by call site.** `_handleMediaClosed` clears eleven pieces of state; `handlePongUi:5834` clears three; `handleLeaveUi:5589` clears a different set again. This is only correct because transport `_emit` is *synchronous*, so `closeConnection()` re-enters `_handleMediaClosed` before the caller deletes the entry. That invariant spans a package boundary, is documented nowhere, and is asserted by no test. Make any emit deferred and the duplicate-close guard at `:1151` silently skips all eleven cleanups.
- **`_openConnections` is mutated from 18 sites across 13 methods.**

Smaller confirmed defects in the same file: `:6247` calls `Object.keys()` on a Svelte `Writable` without `get()`, so that screen-share guard is dead and always true (the correct form appears 20 times elsewhere, including at `:5948` doing the same job); `:5989` sets `InitSent` on every pong regardless of whether a request was sent, inflating the attempt counter shown in the UI; and `_screenShareStreams` (`:3002`) is written nowhere and read by `room-view.ts:782` — permanently `{}`.

One piece of good news about the boundary: `room-view.ts` makes **65 reads of internal fields and zero writes**. All mutation flows through public methods, so the decomposition below can proceed without coordinated changes to the view layer.

### 3.10 The prose has drifted from the code — 17 false assertions

Every checkable assertion in the design docs and the long invariant comments was verified against the shipped code. Result: **17 FALSE** (contradicts the code, presented as current fact, no hedge), **13 groups STALE**, **6 UNVERIFIABLE** (reads as a constraint, constrains nothing), and **5 documents fully trustworthy**.

This is the drift you suspected, and it is measurable. The ones that would actively mislead a change:

- **`docs/WEBRTC_CONNECTION_PLAN.md` §2–§3 is the most urgent single item.** It is the longest and most-consulted description of the connection stack, carries no supersession marker, and is wrong on the three things a reader most needs: it says `connected` requires "ICE + DTLS + data channel open" (the FSM checks only ICE and DTLS — `peer-connection-fsm.ts:1172-1174`, changed by its own §6.1); it says `iceCandidatePoolSize` is unset (it ships as 1); and it says TURN is a manual localStorage field (Cloudflare auto-provisioning shipped in `dbf0429`). Meanwhile its §6 presents five *already-shipped* features as unbuilt proposals.
- **`streams-store.ts:3396-3398`** asserts that "a surviving `connected` entry is genuinely live" because failed/closed connections are already removed. Both premises are false: FSM `failed` never removes the entry, and the grace-exceeded cleanup runs only inside `handlePongUi` — i.e. only when a pong arrives, which is exactly the condition `isPeerMediaLive` exists to survive. The one comment telling a reader to trust `conn.connected` is wrong in precisely the failure mode the function was written for.
- **`docs/CONNECTION_LIFECYCLE_PLAN.md` contradicts itself**, and the way it does is the purest specimen of drift in the repo. Lines 19-23 retract an earlier finding and promise "see the revised note in Phase 1C below"; Phase 1C still carries the retracted claim verbatim and the revised note was never written. Worse, the retraction was *too broad* — the real residual leak is `failed`, not `closed`, so a correction closed the wrong door and left the live bug (§3.1c) standing. Its file paths are also entirely dead: the library moved to `packages/webrtc-peer/src/` and every cited path still points at `transport/fsm/`.
- **`docs/WEBRTC_PEER_SIZE_AUDIT.md`** presents a "Measured footprint" table in which every number is wrong (3,144 claimed vs 3,664 actual), and the whole size argument plus the `README`'s and `CHANGELOG`'s "~550 lines" are derived from it.
- **`ui/src/transport/types.ts:286` claims `DEFAULT_ICE_SERVERS` is the single source of truth**; there is a second independent literal in `packages/webrtc-peer/src/types.ts:22-32`, and the package's own `DEFAULT_CONFIG` falls back to *that* one. The two arrays are currently byte-identical, which is why the drift would go unnoticed.
- **The `PeerTransport` interface documents behavior one implementation violates**: `setLocalStream` is documented as not reconciling existing connections (`types.ts:193`), which SimplePeer honors and the FSM does not (`fsm-transport.ts:288` → `connection-manager.ts:206-210` iterates every live FSM). `ensureConnection` is documented as restarting a `failed` connection (`types.ts:148`); the code has no `failed` branch and could not work if it did, since `VALID_TRANSITIONS.failed` is `{idle, closed}`.

One finding here changes the picture on auto-flip: its three damping rules are documented as applying "in order", but at the sole call site (`streams-store.ts:3895-3902`) rules 1 and 3 are passed neutered values, so only the transport-up rule can fire. With FSM as the default carrier, that rule short-circuits `_maybeAutoFlipImpl` for any connected FSM peer — meaning `TRANSPORT_REFACTOR_PLAN.md`'s "Phase 3 — Automated failure toggle (DONE)" describes an escape hatch that a later change largely disarmed, with no note anywhere saying so.

**There is already a model for how to fix this, written by the same hand.** `docs/WEBRTC_PEER_CLAIM2_DATACHANNEL_GATING.md` carries a `Status: SUPERSEDED` header, a "Current contract (post §6.1)" section that matches the code exactly, and retains the reversed original under an explicit historical marker. Every claim in it verifies. `SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md`, `WEBRTC_CARRIER_ANALYSIS.md`, and `ROADMAP.md` are likewise sound. The problem is not that the project can't write accurate documents — it's that nothing distinguishes those from the stale ones on sight.

### 3.11 What the commit history says about intent

**The FSM migration was attempted once as a replacement, abandoned, and restarted as a coexistence — and the change of goal was never stated anywhere.**

On 2026-03-29/30, branch `feat/webrtc-state-machine` produced `9f0c6d8` "replace SimplePeer with WebRTC connection state machine" and `682b523` "migrate screen share to ConnectionManager, **remove SimplePeer**". Those 38 commits were never merged. The restart on 2026-04-30 (`ed36ab3` Phase 1A → `2d20e93` "FSM as second WebRTC transport") is a *coexistence* design that keeps SimplePeer permanently. **The screen-share port that Phase 3 of this plan calls the main blocker was already written once, on that branch.** It should be read before being rewritten.

**The default carrier flip was never designed.** `c8176ec` (2026-05-28) contains "DEFAULT_CONVERSATION_PAYLOAD.webrtcImpl: simplepeer → fsm" as one bullet in a commit whose subject is about an audio analyser. No design document proposes it; `TRANSPORT_REFACTOR_PLAN.md:102` still says the default is `'simplepeer'`. Seventeen days earlier, `4078fbe`'s message had asserted "SimplePeer remains the default on quiet links — only the conflict case inverts." Neither commit acknowledges the other. Likewise the SimplePeer screen-share default was never decided at all — it is simply what remains after a migration that stopped.

**One symptom, three fixes, 71 days, three different layers, no cross-references:**

| | | |
|---|---|---|
| `da8ac1b` | 2026-04-15 | `phantomAgents()` |
| `80940ca` | 2026-05-15 | `isPeerMediaLive()` + `globalPresenceSet()` |
| `cd05dde` | 2026-06-25 | `_visiblePeers()` |

The May fix built a single source of truth; the render path never consulted it, so June built a parallel one. Both ship. And `cd05dde` broke a documented invariant while doing it: it moved `_updateGrid`'s tile count to `_visiblePeers()` (`room-view.ts:733`) but left the CSS-variable count at `:2896-2899` on `_activeAgents`, directly under a comment placed by `509d0f6` reading "n must match `_updateGrid`'s count". The two now differ by exactly the media-live-but-pong-stale peers.

**The clearest single specimen of drift.** `12cb027` (2026-05-16) declared "**Phase 4B — DONE** … Duplicate FSM connections to a peer are structurally impossible … All covered by passing tests. The multiple connection-ids seen for one peer-pair in the 2026-05-13 log are *different layers* … not duplicate live FSMs." Six weeks later `c143cda` (06-29) re-opened exactly that problem: "Each FSM also mints an independent random connectionId, so the two peers had no ordered, shared identity for 'which attempt is current' … a ~20s reconnect deadlock seen in the field." **A conclusion dismissed a field log on the strength of passing unit tests, and was wrong.** It does not cite the earlier claim, and both texts still ship.

**Prescriptions written, never followed.** `maxAttempts` has three: `reconnect-policy.ts:18-23` says use `Infinity` "for presence-style apps"; `README.md:214-221`, three days later, says keep it "low" for multi-transport apps; `WEBRTC_RECONNECT_IDENTITY.md:288-291` repeats "low". Presence is both kinds of app, and the code passes **no** `reconnectPolicy` at all, so it silently gets the default of 10. Similarly, `WEBRTC_CARRIER_ANALYSIS.md:133-140` defines a validation plan for the inverted tiebreaker ending "if the data does not support the claim, the inverted tiebreaker should be reverted" — no record exists of it ever being run.

**Diagnostics and forensics have accumulated without a retirement path.** Ten explicitly-forensic commits total +1,071/−149, of which **+825/−103 landed in `streams-store.ts`** — roughly 12.5% of that file. `logging.ts` declares 54 event types: 4 are never emitted (one comment says so) yet still have colour arms in the graph, and 19 are emitted with no render arm at all. A 900,000 ms default log window is hard-coded from one debugging session's needs. The library's `diagnostics` flag is double-dead: it defaults false, the app never sets it, and `streams-store.ts:5092` discards `DIAG:` output even if it were set. `TransitionRecorder` is exported and never constructed outside its own test.

**And the shipped line ends mid-investigation.** The tip of `main-0.6`, `8eb07e5`, adds `FsmEstablishmentTimeline` instrumentation whose own comment points at "the flash investigation". Branch `fix/flash` is unmerged, its instrumentation doesn't compile (it imports an uncommitted file), and no fix commit follows anywhere. The last thing that happened on the line that ships to users was adding forensics for a question that was never answered.

---

## 4. What is solid

This matters as much as the debt, because it defines what not to disturb — and it is why the calls have been working.

- **`packages/webrtc-peer`** — 205 tests, 90% statement coverage, fully isolated from the store, covering Perfect Negotiation glare, epoch ordering, DTLS stall watchdog, 8-peer scale, and a 13-test characterization of the ICE-disconnected grace fix from `969d6a6`. A genuinely well-factored library.
- **`ui/src/transport/auto-flip-policy.ts`** — 157 lines, pure functions, plain-object in, discriminated-union out with `reason` tags, 24 tests, no mocks. The best file in the repo and the template for everything in Phase 1–2 below.
- **`voice-playout.ts` / `av-sync.ts`** — same pure-decision shape; the `overcap-drop` fix only became expressible once the decision was lifted out of the playback loop.
- **`_signalsTargets`'s *intent*** (`:312-323`) — twelve declarative lines stating that signals is the **complement** of WebRTC, not an alternative to it. The relationship is right; only its input is wrong (§3.1).
- **`MicSource` / `CameraSource` refcounted device ownership** — the reason two carriers coexist without fighting over the microphone and the reason muting behaves uniformly. The best shared infrastructure in the system.
- **`TransportEvent` union + `onAny` dispatch** (`:451-514`) — one entry point, supersede guards keyed consistently on `connectionId`. Right design; only the missing `else` and the threaded `impl` tag spoil it.

---

## 5. Plan

Sequenced so that each phase ends in a state that is *more* verifiable than it started, and so that no phase depends on the judgment of the phase after it. Phases 0 and 1 are worth doing even if nothing else ever happens.

### Phase 0 — Restore the ability to verify (no behavior change)

1. Add a root `test:unit` that runs the package tests, **then** `build:packages`, then the ui tests — the ordering is load-bearing: without the build, `fsm-transport.test.ts` fails to resolve `@lightningrodlabs/webrtc-peer`.
2. Rename `.github/workflows/test.yaml.notinuse` and make it run that script on push and PR.
3. Add `"typecheck": "tsc --noEmit"` to `ui/` and include it. Measure the error count before promising it will be green — `strict` has never run against these 25,000 lines.
4. Delete the duplicated `ui/src/transport/fsm/__tests__/test-helpers.ts`; import the package's copy.
5. **Settle which branch is trunk, and tag what actually shipped.** `main` is a dead end: since the split at `c589a6b` it has two commits, and `main-0.6` substantively contains both — `cc0ce47` is patch-equivalent to `67a01dd`, and `969d6a6` (118 lines, streams-store only) is the lesser half of `8b23a48` (391 lines, which added the same ICE grace in *both* layers on the same day). Nothing unique would be lost by retiring `main`. But `main` is where `HEAD` and `origin/HEAD` point and where the `v0.14.8` tag sits, so anyone who clones this repo — or any future AI session that reads files without checking the branch — is reading the wrong lineage, one ui version behind, with no `packages/`, no `test` script, and no FSM work. That is a trap worth removing before anything else in this plan. Then tag the commit that shipped, and fix the `FIXME` in the `hash` script.
6. **Docs triage, one hour of work with a large payoff.** Add a status header to every file in `docs/` and every top-level plan. Mark `WEBRTC_CONNECTION_PLAN.md`, `CONNECTION_LIFECYCLE_PLAN.md`, `TRANSPORT_REFACTOR_PLAN.md`, `WEBRTC_PEER_SIZE_AUDIT.md`, and `LOW_BANDWIDTH_VIDEO_PLAN.md` as superseded or correct their §2–§3 "current state" sections; the five sound documents (`WEBRTC_PEER_CLAIM2…`, `SIGNALS_DOUBLE_AUDIO_INVESTIGATION`, `WEBRTC_CARRIER_ANALYSIS`, `ROADMAP`, and `packages/webrtc-peer/README.md`) can be marked active as they stand. This is the cheapest way to stop future sessions from reasoning off descriptions that stopped being true months ago.

**Exit criterion:** one command runs 315 tests plus a typecheck, in CI, and you know its exit code without asking anyone.

### Phase 0.5 — The three-line fix, immediately

Independent of everything else, and the best risk-reduction-per-line in this document:

1. `try { … } finally { this._processingSignal = false; }` around the drain at `:5394-5403`.
2. Add `currentStatus &&` at `:4386`, matching its two siblings.
3. Guard the four unprotected `JSON.parse` calls (`:6005`, `:6097`, `:6344`, `:6360`) — a malformed payload from any peer should drop one signal, not the session.

Test it by making a stub `_processSignal` throw and asserting the next signal still processes. No browser, no jsdom, roughly ten lines.

### Phase 1 — Close the carrier-coverage hole (the bug fix)

Adopt one invariant and enforce it with tests:

> **For every peer that is present, at least one carrier must be actively transmitting.** No peer may be simultaneously excluded from `_signalsTargets` and not flowing on WebRTC. Handover is make-before-break.

1. Extract `routeTransportPhase(phase, impl, hasOpenConnection) → {handler, reason}` from `_dispatchMediaEvent` (`:463-492`), with a table test **exhaustive over all eight `ConnectionPhase` members**, so a dropped phase becomes a failing row rather than an invisible omission. Route `failed`/`idle` to `_handleMediaClosed`.
2. Fix `connection-manager.ts:506-521` to clear the map and emit `connection-closed` on `failed`, and add the assertion that file currently lacks entirely.
3. Change `_signalsTargets` to key on *media flowing*, not entry existence.
4. **Only then** apply the `handlePongUi` FSM guard from `279d533` — it is unsafe before step 1.
5. Extract `decideStaleConnectionCleanup({hasExistingConn, iceState, disconnectedAt, now, graceMs}) → {action, reason}` from `:5816-5839`; the `iceState: undefined` row is the zombie case.

Validate with the live multi-agent VPN-flap test; there is no unit coverage for streams-store and these paths cross it.

### Phase 2 — One presence clock

1. Extract `computeActiveAgents({knownAgents, blocked, myPubKey, now, stalenessMs})` and `computeSignalsTargets(...)` as pure functions taking `now` explicitly — which also documents the time-dependency the `derived` currently hides.
2. Evaluate staleness on a tick, not on a store write.
3. Key **every** join/leave-shaped effect off one predicate: chimes, tiles, grid counts, phantoms. Extract `decidePresenceSoundEvents(prev, current)` and add the dwell/hysteresis it lacks (mirroring `minDwellMs` in `decideCarrierSwitch`). This is where your reported bug actually gets fixed.
4. Collapse the six freshness windows into one per predicate; delete the dead `RECEIVE_TTL_MS`/`hasFreshFrame`.
5. Give `_pendingInits` a TTL like `_pendingAccepts` has, and clear it on close/error.

### Phase 2b — Mechanical extractions (no behavior change)

Each moves a pure expression out of a god-method into a tested function. The compiler verifies the move; the tests verify the logic. These are strictly *lower* risk than leaving the code alone, because the alternative is editing the same predicate correctly in three places.

- **Consolidate the triplicate teardown predicate** (`:5514`, `:5821`, `:5934`) into one `decideStaleTeardown`. Note the latent edge while you are there: the current `!!disconnectedAt` treats a timestamp of `0` as absent.
- **`decodeRtcMessage(raw) → RtcAction[]`** from `_handleMediaDataChannelMessage` (`:1358-1439`) — seven sequential non-exclusive `if`s over disjoint message types; a table test makes an unknown message an explicit `ignore` rather than silence.
- **`summarizeRtcStats(reports)` and `decideTrackRefresh(...)`** from `_checkTrackHealth` (`:5269-5319`, `:5333-5358`) — about 100 of its 144 lines are already pure and touch no `this`.
- **`decideInitRetry(...)`** from `:5849-5893` and `:5952-5992`. **Do this one last and carefully**: the two copies are *not* identical — the video path applies the `pubkeyB64 < myPubKeyB64` tie-break and the screen path has none, and the screen path re-fires `InitSent` outside the threshold check. Unifying them changes screen-share behavior, so resolve that divergence as a decision rather than a silent merge.

### Phase 3 — Retire a carrier

Largest debt reduction in the plan, and it is mostly deletion. Strict order:

1. Add the missing `FsmTransport` adapter tests for `remote-stream`, `remote-track`, `data-channel-message` — currently **zero**, and they are the events that carry all media.
2. Port screen share to the FSM (32 call sites). This is the real blocker and is independently valuable. **Read `682b523` on the abandoned `feat/webrtc-state-machine` branch first** — it already did this migration in March against an earlier version of the ConnectionManager. Even if none of it applies directly, it tells you which call sites are load-bearing and where the previous attempt ran into trouble.
3. Delete SimplePeer: 3 files / ~1,426 lines, two dependencies, ~89 carrier-aware lines, ~25 of the 48 branch points, and the whole `SdpData`/`SdpFsm` split.

Accept knowingly: auto-flip's intermediate fsm→simplepeer escape disappears, so a failing FSM link degrades straight to signals. Phase 1's make-before-break handover is the prerequisite that makes that acceptable.

### Phase 4 — Say what signals actually is

Signals is a module-layer fallback, and the code already says so (`transport/types.ts:26`). Stop presenting three siblings:

1. Replace `carrierMode()`'s three-way collapse with two explicit axes (WebRTC on/off; signals always available as fallback). The UI can keep its three buttons — it just stops being the internal model.
2. One `statsFor(peer) → {carrier, rtt, jitter, loss}`; the stats panel already does this branch by hand.
3. Move the three ICE-teardown supervisors into the transports that already own that logic, then remove `getRTCPeerConnection`'s control callers — at which point the escape hatch can leave the class and `PeerTransport` can become a real annotation.
4. Name the two meanings honestly: for WebRTC, *connected* = ICE + DTLS up; for signals, *reachable* = a frame arrived recently. Never compare them.

Estimated 200–400 lines, concentrated in `streams-store.ts` §3243-3400 and §3630-3840.

**Explicitly not recommended:** making signals conform to `PeerTransport`. That interface is track-and-connection shaped (`setLocalStream`, `addTrack`, `remote-stream` events); signals is frame-shaped and plays into an `AudioBufferSourceNode` directly. Conforming would mean fabricating `getPhase()` and `getConnectionId()` answers and adopting a Chromium-only API. Roughly 5× the work of Phase 4 for a smaller reduction in conditionals.

---

## 6. Working agreements for AI-assisted change

The debt above was produced by a specific mechanism, and these are aimed at that mechanism rather than at AI in general.

**Where these belong: `CLAUDE.md`.** It is currently three lines — communication style, commit hygiene, and `nix develop -c`. It says nothing about the architecture, the invariants, or which of the parallel models is authoritative. That is the whole story of how this happened: every session began with no information about what already existed, so each one added its model beside the last. The agreements below only bite if they are in the file every session reads, alongside a short statement of the four liveness predicates (§5 Phase 1–2) and the ownership rule that the library — not the store — drives transport recovery.

1. **Replace or declare.** Every change either names the existing mechanism it replaces, or states explicitly that it adds a parallel one and why. "Runs in parallel with X; X remains the source of truth" is the exact sentence that produced this assessment — it should require a justification, not pass unremarked.
2. **No new threshold without a named predicate.** Six liveness clocks arrived one constant at a time, each locally reasonable. A new timeout must say which of the four predicates (present / reachable / media-flowing / carrier-active) it serves, and reuse that predicate's clock.
3. **Prose cites code or it gets deleted.** 17 assertions in the docs and comments are outright false and 13 more are stale (§3.10). Every document gets a status header — `Status: ACTIVE` / `SUPERSEDED (see X)` / `HISTORICAL` — following `WEBRTC_PEER_CLAIM2_DATACHANNEL_GATING.md`, which already does this correctly. A design document that describes a proposal must mark each item landed or not-landed once it ships; `WEBRTC_CONNECTION_PLAN.md` §6 lists five shipped features as open proposals. An invariant comment that cannot name the `file:line` it constrains is a wish, not an invariant, and should be deleted rather than left to be believed.
4. **Decisions become pure functions before they become complicated.** `auto-flip-policy.ts` is the proof this works here: plain-object in, tagged union out, table-driven tests, no mocks, 24 tests in 6ms. Any decision worth a second `if` is worth extracting first.
5. **The gate runs, or it isn't a gate.** A disabled workflow, an unrun typecheck, and a `strict` flag nothing invokes are all the same thing: a recorded intention. If a rule matters, it fails a build.
6. **One intent per branch.** The FSM migration and the signals fallback were pursued simultaneously in the same files, and their collision — the dual recovery controllers — is still shipping.
7. **A conclusion may not dismiss field evidence on the strength of passing tests.** `12cb027` closed a duplicate-connection investigation as "structurally impossible … all covered by passing tests" and explicitly reinterpreted a field log as something else; six weeks later the same problem was rediscovered in the field and fixed for real (§3.11). When a log and a test suite disagree, the test suite is the thing that is wrong about reality — especially here, where the mocks cannot throw and therefore cannot reproduce the failure modes that actually occur (§3.6).
8. **A fix names the symptom's previous fixes.** The same pane-survival symptom was fixed three times in three layers over 71 days, with no commit citing its predecessor, and the third broke an invariant the first had documented. A one-line "supersedes `<hash>`" in the commit message would have surfaced each of those collisions at the time.
