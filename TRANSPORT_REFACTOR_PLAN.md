# Transport Refactor — Phased Plan

Worktree: `../presence-transport-refactor`
Branch: `transport-refactor` (based on `origin/main` at `c589a6b`, which includes the voice-over-signals merge + 0.14.7 bump)

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
- Composite-readiness gating (ICE+DTLS+data-channel).
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
- [x] Test baseline finding: **no test files on `main`** — `tests/src/` contains only `unzoom/unzoom/common.ts`. Vitest reports "No test files found, exiting with code 1" (this is masked by the `| tail` pipe in `npm test`). Phase-1 verification cannot rely on a regression suite; will be manual smoke tests + optional new unit tests for the `PeerTransport` interface.
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

## Phase 2 — FSM as second transport, manual per-peer selection

**Goal**: both implementations work, manually selectable per peer.

Tasks:
1. Import `ui/src/connection/*` from `feat/webrtc-state-machine` as `ui/src/transport/fsm/*`. Adapt to `PeerTransport` interface.
2. Separate signaling channel: SimplePeer keeps `Sdp`, FSM uses `SdpFsm`. `HolochainSignalingAdapter` instantiated separately per transport.
3. Conversation module payload extension: `webrtcImpl: 'simplepeer' | 'fsm'`, default `simplepeer`. Symmetric union — if either side picks `fsm`, both use it (avoids signaling-channel mismatch).
4. Transport selector reads payload, routes `ensureConnection` to the right transport.
5. `onModulePayloadChange` swaps transports: close on old, ensure on new.
6. UI: developer-only toggle in settings panel for forcing per-peer transport choice.
7. `CarrierSwitch` values extended to `'simplepeer' | 'fsm' | 'signals'`.

**Exit**: can flip a peer's transport from settings UI, see CarrierSwitch + QualityBucketChange events flow correctly for both, no regressions on `simplepeer` default.

---

## Phase 3 — Automated failure toggle

**Goal**: when one WebRTC implementation fails, automatically try the other for that peer.

Tasks:
1. Failure signal: `AudibilityOutage` fires (≥30s `down`/`negotiating` to a peer reachable by a third observer) AND we're not currently using `signals` carrier (signals doesn't have an "other impl").
2. Toggle logic: flip `webrtcImpl` for that peer in conversation payload, transport selector picks it up, swap happens.
3. Anti-ping-pong: per-peer toggle cooldown (60s); track toggle count and stop after N flips, fall back to signals.
4. Per-peer toggle history surfaced in logs-graph for debugging.

**Exit**: induce a connection failure (e.g. block one transport's signaling), watch the other take over within a bounded window.

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

- **Tests**: each phase adds integration tests at the new boundary. Phase 1 verifies behavior parity. Phase 2 adds 2-peer FSM-vs-SimplePeer matrix. Phase 5/6 add 3-peer relay scenarios. Use the existing `tests/` infra and add fixtures under `tests/src/transport/`. Run with `nix develop -c`.
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
