# Direct signals: investigation and adoption plan

Written 2026-08-06 against holochain `develop` at `d49786ad3c` (feature commit `9c604f0df1`,
"chore: direct signals (#5818)", 2026-06-08 — contained in the `holochain-0.7.0` release tag)
and the presence `main-0.7` working tree. Per working agreement 3, file:line citations into
`../holochain` are pinned to those revisions; citations into this repo are living.

Updated 2026-09-14: this branch is rebased onto `main-0.7`, and §1 is corrected against three
upstream changes that postdate the original writing — see §1.1, which is where the citations
into `../holochain` are re-pinned (`upstream/develop` at `b740fc8c4a`, `upstream/main-0.7` at
`a0f7880494`, and PR #5974's head `60a2297c0e` = `upstream/direct-signal-cap-grants`). Which
release an upstream commit is in is checked with `git tag --contains <commit>` and
`git branch -r --contains <commit>`, never trusted from this file.

## 1. What the feature is

Holochain 0.7 adds `AppRequest::SendDirectSignal`
(`holochain_conductor_api/src/app_interface.rs:283-308`): an app-websocket request
`{ dna_hash, agents: Vec<AgentPubKey>, signal: Vec<u8> }` that sends an opaque byte payload
to a set of peers with **no WASM execution on either side**:

- **Send path** (`holochain/src/conductor/conductor.rs:2944-3004` `send_direct_signal`):
  validates the DNA belongs to the calling app, enforces
  `DIRECT_SIGNAL_MAX_SIZE = 1 MiB` (`holochain_types/src/signal.rs:78`; the ~8 KB lair
  ceiling phase 0 measured was a signing bug, fixed upstream — §1.1), signs the payload
  **once** with the app agent's key, then fans out per agent over kitsune2 notify
  (`holochain_p2p/src/spawn/actor.rs:1870-1945`). Fire-and-forget: per-peer send errors are
  debug-logged and swallowed; an agent missing from the peer store is **silently skipped**;
  an empty `agents` vec is an error. Two apps on the same conductor short-circuit through an
  in-process bridge (`should_bridge`), never touching the network.
- **Receive path** (`holochain/src/conductor/cell.rs:426-470` `handle_remote_signal_direct`):
  size check, signature verify against the wire-level `from_agent`, then pushes
  `Signal::AppDirect { cell_id, signal: Vec<u8> }` (`holochain_types/src/signal.rs:25-32`)
  straight onto the app-interface signal broadcaster. No `recv_remote_signal`, no
  `emit_signal`, and — on the 0.7 line — no cap-grant check (bypassing the grant mechanism is
  documented in the request's doc comment). PR #5974 reverses that on the 0.8 line: §1.1.

Two properties that shape everything below:

- **Provenance is verified but not delivered — on the 0.7 line only.** The conductor checks
  that `from_agent` signed the payload, then delivers only `{ cell_id, signal }` — the
  receiving app never sees `from_agent` (`holochain_types/src/signal.rs:26-32` @
  `a0f7880494`). Sender identity must ride inside the payload, unauthenticated at the
  app layer. Fixed on 0.8 by #5945 (§1.1). This is **not a regression** for presence:
  today's `recv_remote_signal`
  (`dnas/presence/zomes/coordinator/room/src/remote_signals.rs:25`) also never reads
  provenance — `from_agent` in `SignalPayload` is sender-self-declared, and the cap grant is
  unrestricted, so any network member can already claim any identity. Trust level: equal.
- **Receiving requires a connected UI.** `Signal::AppDirect` goes to app-interface
  subscribers only. The zome-level `Ping` → auto-`Pong` (`remote_signals.rs:30-35`), which
  answers with the receiver's UI closed, has no direct-signal equivalent. Passive presence
  must keep the zome path.

What the current path spends per message that the direct path does not:
client-side zome-call signing in the sender's UI, the sender-conductor zome call
(`send_message`, `remote_signals.rs:74`) with WASM + workspace + a per-agent
serialize-and-hash + sign loop (`host_fn/send_remote_signal.rs:44-100`), and on every
receiver a full inbound zome call (signature verify + WASM `recv_remote_signal` +
`emit_signal`). The direct path keeps one keystore sign on the sending conductor and one
verify on each receiving conductor. At voice's ~50 messages/sec
(`ui/src/room/modules/voice.ts`) plus filmstrip's 6-7/sec, that is the bulk of the
signals-carrier CPU on both conductors, and the removed hops are the bulk of its latency.

## 1.1 Upstream state (checked 2026-09-14) — three changes since §1 was written

| change | commit | first tag | on the 0.7 line? |
| --- | --- | --- | --- |
| *(baseline)* direct signals | #5818 `9c604f0df1` | `holochain-0.7.0` | yes |
| sign a hash of the envelope, not the raw payload | #5956 `28628f6333` | `holochain-0.8.0-dev.3` | **yes** — backport batch #5983 `ae9a4ffd3a`, first in `holochain-0.7.1-rc.0` |
| deliver the verified sender as `from_agent` | #5945 `b14368dfae` | `holochain-0.8.0-dev.3` | **no** |
| gate receiving behind a `Capability::DirectSignal` grant | #5974, OPEN and marked draft, head `60a2297c0e` | unreleased | **no** |

**1. The ~8 KB payload ceiling is gone, by conductor version.** `send_direct_signal` now signs
`sha2_512` of the encoded envelope instead of streaming the payload through lair
(`holochain/src/conductor/conductor.rs:3508` @ `a0f7880494`), so the declared
`DIRECT_SIGNAL_MAX_SIZE = 1 MiB` is real. The receive-side pre-decode bound is
`DIRECT_SIGNAL_MAX_SIZE + 5` on the 0.7 line (`holochain/src/conductor/cell.rs:435` @
`a0f7880494`) and becomes
`DIRECT_SIGNAL_MAX_ENCODED_SIZE = MAX + 128` under #5974 (`holochain_types/src/signal.rs:91` @
`60a2297c0e`), to
cover the `cap_secret` field. Phase 0's ceiling result is therefore a property of the conductor
build, not of the feature — and **presence's own devshell still has the old behavior**:
`flake.lock` pins holochain `84cdce7d4d` (the 0.7.0 release commit, 2026-07-30), which predates
the backport. Check before re-measuring: `nix develop -c holochain --version`, and
`git merge-base --is-ancestor 28628f6333 <pinned rev>` in `../holochain`; lift it with
`nix flake update holonix`.

**2. On 0.8, provenance is delivered.** `Signal::AppDirect { cell_id, from_agent, signal }`
(`holochain_types/src/signal.rs:28-37` @ `b740fc8c4a`) — the issue §4 phase 1 proposed filing
was filed and fixed upstream (#5938 → #5945). Not backported to 0.7. So the envelope's
self-declared `from` stays load-bearing on 0.7.1, and on 0.8 it becomes *checkable* against a
conductor-verified value — the first sender authentication this app's signals carrier has ever
had, since the zome path never carried provenance either. Treat that as a phase-3 item
(check-and-reject on mismatch, log-only first), not a blocker.

**3. On 0.8, receiving requires a committed capability grant.** PR #5974 (still draft, pending
its hdi/hdk dependency releases) makes the receiving conductor look up a
`Capability::DirectSignal` grant on the recipient's own source chain and drop the signal if none
matches (`holochain/src/conductor/cell.rs:459-478`, `holochain_state/src/dht_store/reads.rs:2390`
`valid_direct_signal_grant`, both @ `60a2297c0e`). Properties that matter here, each asserted by
a test on that branch (`holochain_state/src/source_chain.rs` `direct_signal_grant_validity`,
and the e2e suite `holochain/tests/tests/signals/direct.rs`):

- **No implicit access, not even for the recipient's own key**, and **a zome-call grant never
  authorizes a signal** — presence's existing `init` grant for `recv_remote_signal` buys nothing
  here.
- The grant must be **committed by a coordinator zome** (`CapGrant::new_direct_signal_grant(tag,
  constraint)` → `create_cap_grant`, `holochain_integrity_types/src/capability/grant.rs:97` @
  `60a2297c0e`); the request gains `cap_secret: Option<CapSecret>`
  (`holochain_conductor_api/src/app_interface.rs:355`), which travels *inside* the signed
  bytes so a relaying peer cannot strip or swap it.
- `GrantConstraint::Unrestricted` + `cap_secret: None` needs no secret distribution and matches
  the trust level presence already runs at. Gotcha for any later tightening: offering a secret
  narrows matching to secret-bearing grants only, so a mixed population needs one request per
  distinct secret.
- **A recipient with no matching grant drops the signal and the sender is never told** — the
  send is best-effort either way. There is no error to route on; the failure is silent and total.
- The omitted-`cap_secret` wire case is serde-defaulted, so a client that predates the field
  still talks to a #5974 conductor (that file's
  `send_direct_signal_request_defaults_omitted_cap_secret` test) — the *send* side needs no
  change for 0.8; only the receiver's grant does.

The grant work is §4 phase 2.5 below. It cannot be written against presence's current SDK: the
`Capability`/`CapGrant` constructors are develop-only (the PR's upstream deps are hdi
`0.9.0-dev.7` and an unreleased hdk), while presence's zomes are on hdk 0.7.0 / hdi 0.8.0, whose
API is `CapGrantEntry::new(tag, access, GrantedFunctions)`
(`dnas/presence/zomes/coordinator/room/src/lib.rs` `init`). Whether #5974 is ever backported to
the 0.7 line is checked with `git branch -r --contains 60a2297c0e`, not assumed.

## 2. Client support status (measured 2026-08-06, re-verify before phase 1)

`@holochain/client` 0.21.0 (the 0.7-line JS client, and what the `ui/` and `tests/`
workspaces now target) has **no support**:

- No `sendDirectSignal` request method.
- Incoming `app_direct` signals **throw** in `assertHolochainSignal`
  (`lib/api/app/decode.js` — only `app` and `system` accepted), inside `WsClient`'s
  `socket.onmessage` (`lib/api/client.js:178-182`): the signal is dropped and the throw
  surfaces as an unhandled promise rejection. The connection survives.

Workable without forking, because the escape hatches are public API:

- **Send**: `AppWebsocket.client` (public readonly `WsClient`) exposes generic
  `request<Response>(request: unknown)`. The wire shape, from the serde attrs on
  `AppRequest` (`tag = "type"`, `content = "value"`, snake_case):
  `{ type: "send_direct_signal", value: { dna_hash, agents, signal } }` → `AppResponse::Ok`
  (`api/api_external/app_interface.rs:235-246`). Open encoding question for the spike:
  whether rmp-serde accepts msgpack `bin` (JS `Uint8Array`) for the `signal: Vec<u8>` field
  or needs an integer array — settle empirically in phase 0.
- **Receive**: `WsClient.socket` is public. A second `message` listener on the same
  websocket can decode the wire message and handle `{ type: "signal" }` payloads whose inner
  signal is `{ type: "app_direct", value: { cell_id, signal } }`, independently of the stock
  handler. This works even when the `AppWebsocket` was constructed by someone else's copy of
  the library — which is exactly the Moss situation (the applet-iframe shim builds the
  `AppWebsocket` with *its* bundled client: `moss/iframes/applet-iframe/src/index.ts:718`,
  `setupAppClient`). Cost under an unpatched host client: one unhandled-rejection log line
  per received direct signal from the stock handler.

The clean fix is an upstream PR to holochain-client-js. That track has a first cut already
written in the client-js repo: local branch `feat/send-direct-signal`, commit `1eaf66f`
("feat(signal)!: add direct signal support from holochain 0.7"), on top of its `main-0.7` —
unpushed, with its `SEND_DIRECT_SIGNAL_PLAN.md` still uncommitted. That cut predates §1.1's
changes and needs three edits before it goes upstream: `cap_secret?: CapSecret` on
`SendDirectSignalRequest`, `from_agent: AgentPubKey` on `AppDirectSignal` (and in
`isWellFormedAppDirectValue`, which currently requires only `cell_id`/`signal`), and deletion of
the ~8 KB lair caveat its doc comments carry on `sendDirectSignal`. Whether it targets the 0.7 or
0.8 client line is now a real decision, because `from_agent` only exists on 0.8. The original
track notes stand: based on
`main-0.7` (the 0.7 maintenance line — upstream has no `develop`; a stale local
remote-tracking ref will claim otherwise), separate from and landing **before** the open
`feat/tauri-direct-app-calls` branch, whose overlap is textual only (`decode.ts`,
`websocket.ts`). The adapter below is written so it can be deleted when a *released*
client version contains the feature.

## 3. Fit with presence's architecture

The seam could not be better placed. Everything `StreamsStore` sends goes through one
closure and everything it receives through one subscription — the `bus`
(`SignalBus`, `ui/src/store-deps.ts`), bound at the single production site in
`StreamsStore.connect` (`ui/src/streams-store.ts` static connect, bus literal). Migrating
the carrier means rebinding two closures; the store body does not change. Two non-store
subscribers also consume signals (`ui/src/presence-app.ts` and
`ui/src/lobby/room-online-agents.ts`, both feeding `PassivePresenceTracker`) and stay on
the zome path by design (see passive presence above).

What stays on the zome path permanently:

- `ping`/backend auto-`pong` (`remote_signals.rs:41`, `RoomClient.pingBackend`) — passive
  presence for lobby cards works with the room UI closed; a UI-terminated direct signal
  cannot reproduce that.
- All `post_commit` app signals (entry/link CRUD, `lib.rs:27-71`) — those are genuinely
  zome-emitted.

What migrates: every `SignalMsgType` in `ui/src/transport/wire-contract.ts` — PingUi/PongUi,
Init*, SdpFsm/SdpFsmScreen, ModuleState, **ModuleData** (the voice + filmstrip carrier,
the payload that matters), Leave, Diagnostics.

Interop: the 0.7 DNA hash change already severs the network from all 0.6/0.14.x agents
(declared in the 0.7 step-1 facts). If direct signals ship inside the first 0.7 release,
there is no deployed 0.7 population speaking only zome signals. We still gate per-peer with
a capability (repo pattern, cheap) rather than declaring a flag-day: peers that don't
declare the cap get the zome path.

Known ceilings that do NOT move with this change, so expectations stay honest:

- The receive-side `_signalQueue`/`_processingSignal` serial drain in
  `StreamsStore.handleSignal` remains the UI-side throughput ceiling.
- Kitsune2 transport loss characteristics are unchanged — voice's RED redundancy
  (`redundancy = 2`, `voice.ts`) exists because the carrier drops packets, and only phase 0
  measurement will say whether removing the zome-call machinery changes delivery rates at
  50/sec (plausible: today every inbound message is a full zome call competing for conductor
  resources; but it is a hypothesis until measured).

## 4. Plan

Sequencing constraint: this work sits **after** 0.7 step 2 (UI client-0.21 migration,
in progress in the working tree) lands on `main-0.7`. One intent per branch (working
agreement 6); every phase PR gets the independent adversarial review (agreement 9).

### Phase 0 — measure before building (extend the latency rig)

Extend `tests/src/signal-latency/` with direct-signal variants of its existing tests 2-4:
RTT distribution, RTT × payload size (80 B → 500 KB — the rig's current 50 KB cap was the
self-imposed UI guard, not a protocol limit; direct signals have a declared 1 MiB ceiling),
and sustained-rate delivery % at 2/5/10/20/50 msg/sec, side by side with the zome-path
numbers the rig already produces. Two changes to the rig itself:

- Use **two conductors**, not two app interfaces on one — `should_bridge` short-circuits
  same-conductor sends in-process and would flatter the numbers.
- Drive the direct path with a throwaway raw `client.request` + raw-socket listener inside
  the test (this doubles as the empirical settlement of the `Vec<u8>` encoding question and
  the exact `app_direct` wire shape).

Exit criteria: measured RTT delta, measured delivery-% delta at voice rates, confirmed max
payload, confirmed wire encoding. If the deltas are marginal, stop here — the rest of the
plan is not worth its interop surface. Keep the tests as instrument, not gate, per
`tests/README.md`.

**Phase 0 results (run 2026-08-07, `tests/src/signal-latency/direct-signal-latency.test.ts`,
two conductors on one machine — loopback network, so absolute numbers are floors and field
loss is not reproduced):**

- **Wire encoding settled: msgpack `bin`.** Plain `Uint8Array` for every `Vec<u8>` request
  field deserializes fine conductor-side. No int-array fallback needed.
- **Echo RTT (median, 20 iterations/size):** direct 2.75–4.07 ms vs zome 13.16–14.13 ms
  across 80–5000 B payloads — **4.4–4.9× faster**. Under sustained load the gap holds:
  at 50 msg/sec one-way median is 1.69 ms direct vs 6.57 ms zome.
- **Delivery:** 100% on both paths at 10/20/50 msg/sec × 10 s on loopback. The field's
  10–50% voice-frame loss is not reproducible in this environment; re-measure delivery in
  the nightly/field once phase 2 lands.
- **The declared 1 MiB limit is not real under lair** — *retired 2026-09-14 by #5956 and its
  0.7.1 backport (§1.1); true of conductors at or before `holochain-0.7.0`, which is still what
  this repo's `flake.lock` pins.* `send_direct_signal` signs the RAW
  payload through the lair keystore (`conductor.rs:2985-2991`), and lair's IPC frames are
  hard-capped at 8 KiB (`lair_keystore_api` 0.6.3, `sodium_secretstream/framed.rs`
  `MAX_FRAME = 8192`): an 8000 B payload sends, 8192 B fails with `FrameOverflow` before
  anything touches the network. The zome path is unaffected (it signs a 32-byte hash —
  `serialize_and_hash` in `host_fn/send_remote_signal.rs`) and carried 50 KB payloads
  (25 ms RTT) in the same run. **Every real deployment uses lair, so the practical
  direct-signal payload ceiling today is ~8 KB minus envelope.**

Consequences applied to the phases below:

- Verdict: **proceed** — the latency delta is large, delivery is no worse, and the CPU
  savings (unmeasured by this rig) come on top.
- Phase 2's send seam must route by **size as well as capability** *while any peer may be on a
  pre-0.7.1 conductor*: payloads over that peer's ceiling go via the zome path. Today's
  filmstrip frames (4–10 KB after base64) straddle 8 KB, so without this a naive carrier switch
  would break video. The conductor build is not observable from the app, so the size route is
  either kept unconditionally or folded into the `direct-signal` capability declaration — the
  declaring side knows its own conductor version (`AdminWebsocket`/`AppInfo` do not carry it;
  settle how at phase 2, and if the answer is "not cheaply", keep the size route
  unconditionally).
- Phase 3 item 1 (binary frames) keeps its value on byte count alone, but is no longer what
  makes filmstrip fit: on a 0.7.1+ conductor the ceiling is 1 MiB.
- Phase 3 item 3 (real VideoEncoder over large signals) is **no longer gated on an upstream
  fix** — #5956 landed it and #5983 backported it (§1.1). It is now gated on lifting this
  repo's holonix pin to a 0.7.1 build and re-measuring RTT at 100 KB–1 MiB payloads, which
  phase 0's rig cannot answer today (its 50 KB cap was the UI guard; the zome path carried
  50 KB at 25 ms RTT in the same run).
- Re-measurement owed, and its shape depends on the conductor: on 0.7.1 re-run the rig as-is
  against the lifted pin; on 0.8 the rig must first commit a `Capability::DirectSignal` grant
  for every receiving agent (§1.1 item 3) or every direct-path test silently reads as 0%
  delivery.

### Phase 1 — client adapter (`ui/src/direct-signal.ts`)

One module owning the raw-wire knowledge, shaped for deletion when upstream support ships:

- `sendDirectSignal(client, dnaHash, agents, bytes)` — via `AppWebsocket.client.request`.
- `onDirectSignal(client, cellId, handler)` — raw `WsClient.socket` listener, decode,
  filter `app_direct` + cell match, deliver `{ bytes }`. Synchronous cell filter — this
  also sheds `ZomeClient.onSignal`'s per-signal async `isSignalFromCellWithRole` lookup.
- Envelope codec as pure functions beside it: msgpack `{ v: 1, from: AgentPubKey,
  msgType: SignalMsgType, payload }` — mirrors today's `RoomSignal` Message shape so
  `_processSignal` semantics carry over; `from` keeps exactly its current
  (self-declared) trust level. Table-driven tests, media-event-policy template.

In parallel, not gating: the upstream client-js PR per that repo's
`SEND_DIRECT_SIGNAL_PLAN.md` — the receive-side change is a bug fix on its own terms
(stock 0.21.0 throws unhandled rejections on any `app_direct` traffic), and its e2e test
settles the `Vec<u8>` encoding question phase 0 also needs, so whichever runs first feeds
the other. The upstream PR does not gate phases 0-2 here (the adapter keeps presence
independent of review and release latency); it DOES gate the Moss deployment path, since
Moss's applet-iframe bundles its own client and only a released version fixes it there.
The `from_agent` issue this section proposed filing is closed: upstream filed #5938 and fixed it
in #5945, on the 0.8 line only (§1.1 item 2). The adapter's envelope keeps `from` regardless —
it is what 0.7.1 has — and gains a *check* against the delivered value on 0.8.

### Phase 2 — carrier switch behind a capability

- New cap `direct-signal` in `conversationPayload` caps beside `CAP_SDP_FSM`
  (`wire-contract.ts`); wire-contract table row + compat-corpus fixture for the new
  envelope (the contract tests trip on this by design). What the cap declares is settled in
  phase 2.5: on a #5974 conductor it must mean "my grant is committed", not "my client speaks
  the protocol", and the per-peer switch wants an observed direct round trip on top of it.
- Pure policy `decideSignalPath(peerCaps) → { path: 'direct' | 'zome', reason }` in
  `ui/src/transport/` — the ONE place the choice is made, replacing nothing (new decision)
  but consumed by the one send closure.
- Rebind the bus in `StreamsStore.connect`: `sendMessage` partitions targets by
  `decideSignalPath` and sends one direct fan-out + one zome fan-out as needed; `onSignal`
  merges the zome subscription and the direct listener into the same handler signature.
  The store body, `_processSignal`, and all handlers are untouched.
- The two passive-presence subscribers are explicitly left on the zome path; document that
  in `passive-presence.ts`'s header (it is a different predicate with a different
  transport requirement, not an oversight).
- Teardown symmetry: the direct listener unhooks in `disconnect()` alongside
  `signalUnsubscribe` (view-teardown-symmetry pattern applies).

Field validation before merge: the Phase 6.5 harnesses drive the store over the `bus` seam
with BroadcastChannel semantics, so they validate the partition/merge glue in node; the
nightly real-RTC harness plus a manual two-conductor session validate the real path.

### Phase 2.5 — the receive-side cap grant (#5974)

Sequenced by the conductor version, not by phase number.

Required the moment presence's conductor crosses onto a #5974 build (0.8 line today). Not
writable before presence moves off hdk 0.7.0 (§1.1 item 3), and **blocking on the 0.8 upgrade in
the other direction**: if phases 1–2 ship on 0.7.1 and the conductor is later lifted to 0.8
without this, every direct signal stops being delivered, silently, with no sender-side error and
no log on the send path. Put it on the 0.8 upgrade's release gate, not on a backlog.

- Commit `CapGrant::new_direct_signal_grant("Receiving direct signals",
  GrantConstraint::Unrestricted)` beside the existing zome-call grant in the room coordinator's
  `init` (`dnas/presence/zomes/coordinator/room/src/lib.rs`). Unrestricted + `cap_secret: None`
  is the matching trust level: presence's `recv_remote_signal` grant is already unrestricted and
  its envelope `from` is already self-declared, so this grants no new authority to anyone (§1's
  "trust level: equal" argument survives #5974 intact).
- **`init` alone is not enough.** `init` runs once per agent, so every already-initialized agent
  — i.e. every existing user — would have no grant. Needs an idempotent extern
  (`grant_direct_signal`) called at app start / room join, committing only when a query of the
  agent's own `CapGrant` entries finds no live unrestricted direct-signal grant (verify at
  implementation time that `query` over `EntryType::CapGrant` returns private own-chain entries
  on the SDK version in use; if it does not, the fallback is an idempotence marker of our own).
  Duplicate unrestricted grants are harmless to matching ("if *any* grant is valid") but write
  chain entries, so guard the commit, not the call.
- Coordinator-only change ⇒ integrity zomes and the DNA hash are untouched, happ bytes change ⇒
  a declared `HAPP_CHANGE=1` release, the same shape as the stable-tile-order round.
- **Capability declaration must mean "grant committed", not "client supports it".** Because a
  missing grant is a silent total drop, the `direct-signal` cap in `conversationPayload`
  (phase 2) is only sound if a peer declares it *after* its own grant commit is confirmed.
- **And gate the per-peer switch on an observed round trip, not on the declaration alone.** Send
  PingUi over the direct path and require a direct-carried PongUi before routing that peer's
  ModuleData direct; fall back to the zome path on no answer. This is what converts #5974's
  silent drop — and any other single-direction carrier failure — into something the existing
  presence machinery can see. Cheap: PingUi/PongUi already run every tick.
- Rig consequence: the tryorama rig must commit grants for receiving agents before any
  direct-path measurement on a 0.8 conductor (phase 0 results, re-measurement bullet).

### Phase 3 — spend the new budget (separate branches, only after phase 0/2 numbers)

Ordered by expected return:

1. **Kill the string tax on `ModuleData`.** The envelope is msgpack; frames become binary.
   Voice loses base64 (×1.33) and the double-JSON escape
   (`sendModuleData`'s `JSON.stringify({ moduleId, chunk })` over an already-stringified
   chunk); filmstrip loses base64 on multi-KB JPEGs. ~25-40% byte reduction for zero
   behavior change.
2. **Re-tune voice against measured loss.** RED `redundancy = 2` (~3× bytes) was calibrated
   against 10-50% loss through the zome path. If phase 0 shows materially better delivery,
   lower redundancy or raise the 24 kbps opus bitrate inside the same byte budget.
3. **Real video over signals.** Replace the JPEG filmstrip with a WebCodecs `VideoEncoder`
   (VP8/AV1 at 100-300 kbps, keyframe-on-join) riding large direct signals — the lair-ceiling
   fix it was gated on has landed (§1.1 item 1), so the remaining gate is the holonix pin and
   large-payload measurement. This is the
   "close to WebRTC UX" candidate and is a phase of its own with its own plan — a third
   signals-carried media type is already flagged as a phase-by-declaration in the
   dormant-until-trigger list (CLAUDE.md).
4. **Authenticate the envelope's sender** (0.8 conductors only). Compare the envelope's
   self-declared `from` against the conductor-verified `from_agent` (§1.1 item 2); log-only
   first, reject on mismatch once the field confirms no false positives. This is strictly new
   security, not a fix — neither carrier has ever had it — so it lands on its own and never
   gates a carrier switch.

### Phase 4 — retire what the field says is dead

After field time: if the zome fallback path for `Message` sees no traffic (all peers
declare the cap), delete `send_message` and the `Message` arm of `recv_remote_signal`,
keeping `ping`/`pong`. DNA change ⇒ new DNA hash ⇒ do this only riding an already-breaking
DNA release. Until then the zome path stays as the declared fallback — that is a
"parallel mechanism, justification: cap-gated fallback for peers without the cap"
declaration under working agreement 1.

## 5. Deployment gates

- **Conductor 0.7.0+** everywhere for the feature to exist at all; **0.7.1+** for payloads over
  ~8 KB (§1.1 item 1). Presence `main-0.7` pins holonix `main-0.7`, but the pinned holochain rev
  is the 0.7.0 release commit — lifting the pin is a prerequisite of any large-payload phase,
  not a formality.
- **Conductor 0.8 (once #5974 lands) requires phase 2.5's cap grant.** No grant ⇒ every direct
  signal is silently dropped by the recipient. This is the one gate that fails invisibly, so it
  belongs on the 0.8 upgrade's release checklist rather than here alone.
- **Moss**: presence-under-Moss needs the *host* conductor on 0.7 before any of this
  activates in that environment; the raw-socket adapter functions under an unpatched Moss
  applet-iframe client (with rejection-log noise), but the real fix is Moss bumping its
  bundled client once the upstream PR lands. Standalone presence controls its own client
  and has no such dependency.
- **Tryorama**: the rig drives conductors directly with the JS client, so phase 0 needs no
  tryorama feature support beyond multi-conductor scenarios, which it has.
