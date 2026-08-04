# Transport Refactor — Phased Plan

Status: HISTORICAL (superseded by CLAUDE.md's carrier facts — "Post-Phase 3
carrier facts" and after — and `MAINTAINABILITY_ASSESSMENT.md`). This document
drifted false a second time (assessment §8 item 7): its Phase 3 section
describes symbols deleted in the 2026-07-29 carrier retirement as live
(`_maybeAutoFlipImpl`, `setPeerImpl`, `auto-flip-policy.ts`, `decideAutoFlip`,
`WebrtcImplFlip`, …), says screen share is SimplePeer-only, quotes a test count,
and asserts the `tests/` workspace has no test files (see `tests/README.md`).
Do not read any section below as a description of current code. The Phase 4–7
direction (subscription axis, relay forwarding, SFU, QUIC) is retained as
design rationale only; if that work is picked up, it gets a fresh plan cut
against the code as it then stands.

Phases 0–3 shipped and are on `main-0.6`; their entries below record what was
built at the time.

Originally worked in the `../presence-transport-refactor` worktree on branch
`transport-refactor`, cut from `origin/main` at `c589a6b`. That lineage is dead —
`main-0.6` is the line that ships. See `CLAUDE.md`.

## Goals

Three goals share one foundational refactor:

1. **Failure-toggle** between SimplePeer and the hand-rolled FSM (`feat/webrtc-state-machine`) so we can validate which works better in difficult-network scenarios (Starlink, CGNAT) and land the better solution per peer.
2. **SFU-style "micro-centralization"** so high-bandwidth nodes can volunteer to relay a subset of peers, breaking the n² mesh limit and getting toward 30-peer rooms with full video.
3. **QUIC/WebTransport** as a future carrier, including moss-mediated relaying.

The shared foundation: a `PeerTransport` interface (carrier axis) plus an `AudioSubscription` abstraction (topology axis). The conversation module's per-pair pong-broadcast payload is the right channel for selection state on both axes.

## What we already have (don't redo)

From `feature/voice-over-signals`:
- Module abstraction (`registerModule`, lifecycle hooks, render hooks, icon strip).
- Conversation module per-pair payload, broadcast via pong, with `disableWebrtcWith[]` providing the symmetric-union shape we'll extend.
- AudioLink FSM (`absent | blocked | negotiating | webrtc | signals | muted | down | unknown`) — flow-takes-precedence semantics.
- Observability events: `CarrierSwitch`, `QualityBucketChange` (de-duped per `(carrier, rtt_band, loss_band)`), `AudibilityOutage` (30s threshold, third-observer relay-opportunity detection).
- Signals carrier as a working alternative to WebRTC: `mic-source.ts`, `voice.ts`, Opus frames over Holochain remote signals.
- Phantom tiles for agents present elsewhere but unreachable.
- Logs-graph timeline visualization.

From `feat/webrtc-state-machine`:
- `ConnectionManager` / `PeerConnectionFSM` / `RTCPeer` — clean three-layer architecture.
- Perfect Negotiation (polite/impolite by `myAgentId < remoteAgentId`).
- `connectionId` + monotonic `peerSessionId` for stale-signal filtering.
- Pluggable `ReconnectPolicy` (ICE-restart for first 3 attempts, then full reconnect, quadratic backoff with jitter).
- `dtlsStallTimeoutMs` watchdog acting on stall (not just logging).
- Composite-readiness gating. (Then ICE+DTLS+data-channel; **now ICE+DTLS only** —
  the data channel is no longer a gate. See `docs/WEBRTC_CONNECTION_PLAN.md` §5.D.)
- Per-connection `role: 'mesh' | 'sfu-upstream' | 'sfu-downstream' | 'sfu-relay'` scaffolding.
- Two `ConnectionManager` instances coexisting (media on `Sdp`, screen-share on `ScreenSdp`) — pattern for adding more.

What does NOT exist in either branch:
- A `PeerTransport` interface — both branches call their implementations directly.
- A subscription/topology axis distinct from the carrier axis.
- Relay-capability advertisement.
- Loop-prevention machinery for relay topologies.

## Phasing principle

Each phase ships something usable on its own. Earlier phases deliberately don't do later phases' work. The carrier interface gets exercised against multiple implementations before SFU starts depending on it.

---

## Phase 0 — Worktree, baseline, branch hygiene

- [x] Worktree at `../presence-transport-refactor`, branch `transport-refactor`.
- [x] voice-over-signals merged to `main` (commit `3b219e7`); branch rebased onto `origin/main` (`c589a6b`).
- [x] `npm install` complete (872 packages, 56s).
- [x] Build baseline captured: zomes compile, happ packs, vitest infra runs.
- [x] Test baseline finding, updated 2026-08-03: the `tests/` workspace holds one committed tryorama suite (`tests/src/signal-latency/` — a latency/throughput measurement rig, untracked from 2026-04 until the retro sweep; see `tests/README.md` for why it cannot currently run) and no regression tests, so root `npm test` still verifies nothing. The unit suite lives in `ui/` and `packages/webrtc-peer/` and is run by `npm run verify` (614 tests + typecheck, in CI — the count in this line goes stale; `CLAUDE.md` tracks it). The tryorama integration fixtures this phase envisaged under `tests/src/transport/` were never written.
- [x] Reconciliation strategy with `feat/webrtc-state-machine`: cherry-pick the new files (`ui/src/connection/*` plus its 4 test files in `__tests__/` and `ui/vitest.config.ts`) rather than merge — the streams-store changes there will conflict heavily with main. The FSM lands as new files in Phase 2 and gets adapted to the Phase-1 interface.

---

## Phase 1 — Carrier interface + SimplePeer behind it

**Goal**: zero behavior change. Every direct `peer.addTrack/send/signal/...` call in `streams-store.ts` is gone, replaced by calls through a `PeerTransport` interface. SimplePeer is only referenced inside `SimplePeerTransport`.

### Phase 1A — Foundation (DONE in this worktree, uncommitted)

Landed:
- [x] `ui/src/transport/types.ts` — `PeerTransport` interface, `TransportEvent` union, `SimplePeerLike` test seam, `PeerTransportOptions` with getter-shaped `iceServers` / `trickleICE` for runtime config changes.
- [x] `ui/src/transport/simplepeer/simple-peer-transport.ts` — full `SimplePeerTransport` implementation (ensureConnection idempotent + supersede, closeConnection, addTrack/removeTrack/replaceTrack, send, processIncomingSignal with connectionId match, getStats via `_pc.getStats()`, `_createPeer` factory option for tests).
- [x] `ui/src/transport/index.ts` — barrel.
- [x] `ui/src/transport/__tests__/test-helpers.ts` — `MockSimplePeer`, `FakeSignalingChannel`, fake stream/track factories.
- [x] `ui/src/transport/__tests__/simple-peer-transport.test.ts` — 27 unit tests, all passing.
- [x] `ui/vitest.config.ts` + `test` / `test:watch` scripts in `ui/package.json`.
- [x] `ui/src/types.ts` — `peer: SimplePeer.Instance` field removed from `OpenConnectionInfo` and `PendingAccept` (intentional — drives the type errors that map every streams-store call site needing migration).
- [x] `ui/src/streams-store.ts` — three `SimplePeerTransport` instances (mediaTransport, screenShareOutTransport, screenShareInTransport), constructor wiring (onOutgoingSignal → `roomClient.sendMessage('SdpData', ...)`), stub `_subscribeMediaTransport` / `_subscribeScreenShareTransport` methods (no-op).

State: `npm run -w ui test` passes 27/27. `tsc --noEmit` reports 77 errors in `streams-store.ts` — all of the form `Property 'peer' does not exist on type 'OpenConnectionInfo' / 'PendingAccept'`. The errors are intentional — they mark every call site that needs migration in Phase 1B.

### Phase 1B — streams-store migration (DONE)

Landed:
- [x] **`createPeer` body migrated** to `_subscribeMediaTransport` event handlers — six `_handleMedia*` methods (signaling/connected/closed connection-state-change arms, remote-stream, remote-track, data-channel-message, error). Supersede guards keyed off `_openConnections[peer].connectionId`. `createPeer` deleted.
- [x] **`createScreenSharePeer` body migrated** to `_subscribeScreenShareTransport`. The `initiator` flag selects between `_screenShareConnectionsOutgoing` (true) and `_screenShareConnectionsIncoming` (false). `createScreenSharePeer` deleted.
- [x] **ICE diagnostic logging** preserved via the chosen escape-hatch path: added `getRTCPeerConnection(peer)` on `SimplePeerTransport` and a `_startMediaIceMonitor` method that hooks `iceconnectionstatechange` / `icegatheringstatechange` / `icecandidate` on the underlying `RTCPeerConnection` once `phase=signaling` fires. Health-check stats poll, stale-cleanup ICE peeks, and per-peer track recovery (`_tryReplaceTrackRecovery` operating on `RTCRtpSender.replaceTrack` directly to keep recovery scoped to a single peer) all use the same hatch.
- [x] **`conn.peer.X` call sites swept** (≈50 places). Loop forms collapsed to single `this.mediaTransport.addTrack/removeTrack/replaceTrack` calls; single-peer destroys became `closeConnection(peerB64)`; sends became `mediaTransport.send(peerB64, ...)`; per-peer addStream at handshake replaced by `setLocalStream` (auto-attach on `ensureConnection`) plus per-track addTrack as on-connect fallback.
- [x] **`_pendingAccepts` simplified**: peer field removed. `handleInitRequest` only reserves the connectionId; the actual peer is created lazily in `handleSdpData` via `mediaTransport.ensureConnection({ initiator: false, connectionId })` once the offer arrives. Stale-pending cleanup is now just dropping the entry.
- [x] **`handleSdpData` updated** to route the three signal-target paths through `mediaTransport.processIncomingSignal`, `screenShareOutTransport.processIncomingSignal`, `screenShareInTransport.processIncomingSignal`. Each transport drops on connectionId mismatch silently.
- [x] **`handleInitAccept` updated**: drops `createPeer` calls; transport's internal supersede handles old-peer destroy when a new connectionId is supplied.
- [x] **`disconnect()` cleanup** delegates to `mediaTransport.destroy()` / `screenShareInTransport.destroy()` / `screenShareOutTransport.destroy()` — peer destroys cascade through the transport-emitted close events.
- [x] **`_cloneStreamRecovery` simplified** to a transport `closeConnection` + reconnect fallback (clone-stream-and-re-add semantics relied on direct SimplePeer access; the pong-driven retry loop now picks up the new connection).
- [x] **`import SimplePeer from 'simple-peer'`** removed from `streams-store.ts`. The package is now only referenced inside `src/transport/simplepeer/`.

State: `tsc --noEmit` clean. `npm test` passes 27/27 (existing transport unit tests). `npm run build` clean. Manual smoke testing of `CarrierSwitch` / `QualityBucketChange` / `AudibilityOutage` event parity is the remaining verification step.

---

## Phase 2 — FSM as second transport, manual per-peer selection (DONE)

Landed:
- [x] **FSM source cherry-picked** from `feat/webrtc-state-machine` into `ui/src/transport/fsm/*` — `connection-manager.ts`, `peer-connection-fsm.ts`, `rtc-peer.ts`, `reconnect-policy.ts`, `holochain-signaling-adapter.ts`, `types.ts`, `index.ts`, plus the four `__tests__/` files. 149 FSM tests run alongside the 27 SimplePeer transport tests = 176 total green. (**The library has since moved** to `packages/webrtc-peer/src/` and is consumed as `@lightningrodlabs/webrtc-peer`; only the `FsmTransport` adapter remains under `ui/src/transport/fsm/`.)
- [x] **`FsmTransport` wrapper** at `ui/src/transport/fsm/fsm-transport.ts` adapts `ConnectionManager` to the `PeerTransport` interface. Owns an inline `SignalingAdapter` that bridges to the application's `onOutgoingSignal` callback / `processIncomingSignal` entrypoint. Exposes the same `getRTCPeerConnection(peer)` escape hatch as `SimplePeerTransport` so streams-store ICE diagnostics, stats poll, and per-peer track recovery work uniformly.
- [x] **Signaling channel separation**: SimplePeer continues over Holochain `Sdp` messages; FSM uses a new `SdpFsm` message type. `streams-store.handleSdpFsm` parses the FSM-shaped envelope (`{ connection_id, peer_session_id, data: { type, payload } }`) and forwards via `mediaTransportFsm.processIncomingSignal`. No zome change needed — `msg_type` is opaque to the backend.
- [x] **Conversation payload extended** with `webrtcImpl: 'simplepeer' | 'fsm'` and `fsmWith: AgentPubKeyB64[]` for per-peer overrides. `parseConversationPayload` accepts older payloads that omit the fields. (The default was `'simplepeer'` here; **it is `'fsm'` today** — `conversation.ts:86`.)
- [x] **Symmetric-union routing**: `streamsStore.webrtcImplFor(peerB64)` returns `'fsm'` if either side chose FSM (globally via `webrtcImpl` or per-peer via `fsmWith`). `_mediaTransportFor(peer)` selects the new-connection transport; `_activeMediaTransportFor(peer)` returns whichever transport currently hosts the live connection (used for sends, closes, and ICE peeks during a flip in flight).
- [x] **`onModulePayloadChange` transport-swap**: when the effective `prefersFsm` flips, the existing media connection is torn down via `disconnectFromPeerVideo`. The next pong cycle re-establishes through the newly-selected transport.
- [x] **UI toggle**: global "Use FSM transport (dev)" switch added to the connection-details settings panel next to "Disable all WebRTC". `streamsStore.setWebrtcImpl()` flips the conversation payload and tears down all media connections in one shot. (Per-peer `toggleFsmFor` helper is in place; per-peer UI surface is left for a later session — global toggle covers Phase 2's "manually selectable" exit criterion via the symmetric-union union with peer state.)
- [x] **`CarrierSwitch` event detail extended** — `_handleMediaConnected`/`_handleMediaClosed` emit `signals->simplepeer`, `signals->fsm`, `simplepeer->signals`, `fsm->signals` based on the impl that owns the connection. New `FsmClose` / `FsmError` log event types added to `SimpleEventType` so logs-graph can disambiguate.
- [x] Broadcast operations (`setLocalStream`, `addTrack`, `removeTrack`, `replaceTrack`, `destroy`) fan out via `_allMediaTransports()` so future ensureConnections on either transport auto-attach the current stream and tracks. Per-peer operations (`send`, `closeConnection`, `getRTCPeerConnection`) route via `_activeMediaTransportFor()`.
- [x] Screen-share connections continue to use SimplePeer only — keeps Phase 2 scoped to media. SFU work in Phase 6 will introduce FSM-relay topology there.

State: `tsc --noEmit` clean. `npm test` 176/176 green. `npm run build` clean. Manual two-peer toggle test (one or both sides flip "Use FSM transport (dev)" and verify a fresh `signals->fsm` `CarrierSwitch` followed by `QualityBucketChange` events) is the remaining verification before checkpointing.

---

## Phase 3 — Automated failure toggle (built, but largely inert today)

> **Read this before relying on auto-flip.** Everything below was built and its
> tests pass. But `_maybeAutoFlipImpl` now returns early for any peer whose FSM
> transport is up: the carrier-hysteresis check immediately above it
> (`streams-store.ts:3890-3903`) returns `stay`/`transport-up`, and FSM is the
> default carrier. So for the common case — a connected FSM peer — **the
> automated flip described here does not fire.** The escape hatch is still
> reachable manually via `setPeerImpl`. Nothing in the tests catches this,
> because the policy functions are tested in isolation from the caller that
> disarms them.

Landed:
- [x] **`peerImpl` map** replaces `fsmWith` in the conversation payload — `Record<AgentPubKeyB64, 'simplepeer' | 'fsm'>` so per-peer overrides can pin either direction. Backwards-compat parsing promotes legacy `fsmWith` entries to `peerImpl[peer] = 'fsm'` automatically.
- [x] **Resolution rules** (`resolveWebrtcImpl` in `ui/src/transport/auto-flip-policy.ts`): both-side overrides agree → that value; **both override and disagree → `'fsm'` wins** (`auto-flip-policy.ts:149-152`, asserted by its own tests); one side overrides → that value; neither overrides → symmetric union of globals (FSM if either picks FSM).

  The disagreement rule was originally specified as simplepeer-wins, for broader
  compat and to let the auto-toggle pin a failing link unilaterally. **The code
  does the opposite**, which means a peer cannot unilaterally pin a link back to
  simplepeer. Note that `conversation.ts:73-76` still documents the old
  simplepeer-wins rule and is wrong.
- [x] **Auto-toggle hook**: `_checkAudibilityOutages` calls `_maybeAutoFlipImpl(peer)` at the same point it emits `AudibilityOutageStart`. The decision is gated by the pure `decideAutoFlip` policy in `auto-flip-policy.ts`:
   - already on signals → noop;
   - inside the per-peer cooldown window (60s) → noop;
   - flip count ≥ max attempts (3) → fallback (pin to signals via `disableWebrtcWith`);
   - otherwise → flip the impl (FSM ↔ simple-peer).
- [x] **Anti-ping-pong**: `_lastAutoFlipMs` and `_autoFlipCount` per-peer maps on the store. Both sides observing the same outage at the same moment land on the same impl thanks to the deterministic tiebreaker (now fsm-wins, see above); subsequent flips wait out the cooldown.
- [x] **Logs-graph**: new `WebrtcImplFlip` `SimpleEventType`. Manual flips log `prev->next; reason=manual`; auto-flips log `reason=auto-outage`; exhaustion logs `exhausted after N flips; pinning to signals`. `setPeerImpl(peer, impl, reason)` is the single entry point.
- [x] **`onModulePayloadChange` reacts to remote flips**: reads my peerImpl for the peer alongside the prev/next conversation payload and recomputes effective impl on both sides via `webrtcImplForGiven`. Tears down the connection only when the effective impl actually changed, so a peer flipping their unrelated `peerImpl[other_agent]` field doesn't trigger spurious teardowns.
- [x] **Tests**: 16 new pure-policy tests for `decideAutoFlip` and `resolveWebrtcImpl` (cooldown, max-flip, exhaustion, signals fallback, tiebreaker, override precedence).

State: the suite is **315 green** today across both workspaces; run it with
`nix develop -c npm run verify`.

**Exit criterion, still unmet**: induce a connection failure (e.g. block one
transport's signaling) and watch the other take over within a bounded window.
This was never run, and given the disarming described above it would currently
fail for an FSM peer.

---

## Phase 4 — Subscription axis (SFU groundwork, no relays yet)

**Goal**: introduce topology as an axis orthogonal to carrier. All subscriptions are `direct` for now.

Tasks:
1. `ui/src/transport/subscription.ts` — `AudioSubscription { source: { kind: 'direct' } | { kind: 'relay', via: AgentPubKeyB64 }, carrier, fallback?: AudioSubscription }`.
2. `StreamsStore` moves from "ensure connection to peer X" to "ensure subscription for peer X." Subscription resolver maps to one or more transport actions.
3. AudioLink FSM gains topology states: `webrtc-direct | webrtc-relay | signals-direct | signals-relay`. `audioLinkFor()` reports both flow and topology.
4. `QualityBucketChange` tuple extended to `(carrier, topology, rtt_band, loss_band)`.
5. `CarrierSwitch` becomes `SubscriptionSwitch` — captures both carrier and topology changes.

**Exit**: subscription layer in place, all subscriptions still resolve to direct, identical observable behavior to Phase 3.

---

## Phase 5 — Signals-carrier relay forwarding

**Goal**: a peer volunteers to forward signals-carrier audio for others. Easiest SFU path because signals envelopes already carry signed source identity.

Tasks:
1. New `relay-capability` module: declares slots (audio-only initially), broadcasts via pong. UI: "donate uplink" toggle.
2. New `subscription` module (or extend conversation): `subscribedTo: { [origPeer]: relayPeer }`, `relayingFor: { [origPeer]: subscriberPubKeyB64[] }`.
3. Relay forwarding for signals: when I'm `relayingFor[X]`, I receive X's signed Opus envelopes and re-emit them with the original envelope intact to my subscribers. Identity preserved via Holochain signature path — no trust hop.
4. Loop prevention: subscription specifies source chain; relay refuses to forward to a node already in the chain.
5. Relay selection policy v1: `AudibilityOutage` event surfaces `relay-via` candidate; subscription resolver subscribes to first relay with capacity.
6. Relay departure: subscriber re-resolves on relay-leave or relay-no-capacity events.
7. UI: phantom tile gets a "via R" indicator when peer is relayed.

**Exit**: two peers blocked by NAT/connectivity issues can hear each other through a third peer running the relay module.

---

## Phase 6 — FSM-carrier SFU forwarding

**Goal**: relay nodes can forward via WebRTC for higher-bandwidth scenarios (rooms with video at 30 peers).

Tasks:
1. SFU role on FSM transport: `role: 'sfu-relay'` connections aggregate multiple originals on a single RTCPeerConnection via per-source transceivers. SimplePeer cannot do this — FSM transport is the only WebRTC carrier eligible for SFU.
2. SSRC → original-peer mapping signaled over data channel on the relay link.
3. Identity policy decision documented: in-room trust assumption — any room member can assert source identity for relayed RTP. Acceptable for friendly Holochain rooms; revisit for adversarial contexts.
4. Composite-readiness gating: relay link going down means downstream subscribers fall back per their `fallback` subscription (typically signals-relay or direct-attempt).
5. Relay selection policy v2: prefer FSM-carrier relays for video subscriptions; signals-carrier relays for audio-only or low-bandwidth.
6. Bandwidth metering on relay node; refuse new subscriptions over capacity.
7. Loop prevention extends naturally — same source-chain mechanism.

**Exit**: 30-peer demo room with full video, two volunteer relays, total bandwidth per non-relay peer ≪ n² mesh.

---

## Phase 7 — QUIC / WebTransport carrier

**Goal**: third carrier family slots into existing abstraction.

Tasks:
1. `ui/src/transport/webtransport/` — Opus frame transport over WebTransport, structurally close to signals carrier (encode → frames → transport → decode + jitter buffer).
2. Plugs into both axes: direct (peer-to-peer WebTransport) and relay (relay node forwards WebTransport frames).
3. Decision point: peer-to-peer WebTransport requires browser support (currently Chromium); moss-mediated WebTransport relay is more portable.
4. Carrier value extended: `'simplepeer' | 'fsm' | 'signals' | 'quic'`.
5. Conversation payload `carrier` field becomes a preference order rather than a single value, so transport selector can fall back through the list.

**Exit**: QUIC carrier toggleable from settings, observability events fire, demo a peer using QUIC for direct and another using QUIC over relay.

---

## Cross-cutting

- **Tests**: each phase adds integration tests at the new boundary. Phase 5/6 add 3-peer relay scenarios. Fixtures were meant to go under `tests/src/transport/` on the tryorama infra; **none were ever written**, and the `tests/` workspace still contains no test files. A phase that claims an integration exit criterion needs to actually add one — the unit suite (`npm run verify`) cannot prove relay behavior.
- **Observability**: every phase verifies its events surface in logs-graph.
- **Config knobs**: per-phase settings exposed in the developer settings panel (`webrtcImpl` override, relay capacity, carrier preference order).
- **Decisions deferred until needed**: relay-selection policy starts dumb, gets smarter only when the dumb version visibly fails; identity-on-relay deferred to Phase 6 since signals/QUIC preserve identity natively.

## Dependency graph

```
P0 → P1 → P2 → P3
          ↓
          P4 → P5 → P6 → P7
```

P3 (auto-toggle) and P4 (subscription axis) are independent after P2 and could run in parallel by different people. P5 and P6 are sequential because P6's identity policy depends on having lived with P5's identity-preserved-by-default model.
