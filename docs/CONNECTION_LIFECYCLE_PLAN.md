# Connection Lifecycle & Diagnostics Implementation Plan

Status: in progress
Date: 2026-05-15

## Implementation progress

- **Phase 1A — DONE & typecheck-verified.** `isPeerMediaLive(peer)` predicate
  + `globalPresenceSet()` union (`ui/src/streams-store.ts`); covers a connected
  WebRTC connection and recent signals-carrier voice/filmstrip frames
  (`MEDIA_LIVE_WINDOW_MS = 3000`). This is the fix for the reported incident.
- **Phase 3A — DONE & typecheck-verified.** `clearReceivedDiagnostics()` store
  method; room-view clears cached results after download so the button
  returns to its requestable colour.
- **Phase 3B — DONE & typecheck-verified.** `_conversationParticipants` set
  (populated on first `Connected` per peer); `requestDiagnosticLogs()` no-arg
  now targets `_conversationParticipants ∪ globalPresenceSet()` instead of all
  `_knownAgents`, excluding merely heard-about peers.
- **Phase 1C — scope revised.** The connection-manager already prunes closed
  FSMs from its `_connections` map via a deferred cleanup on the `closed`
  transition (`transport/fsm/connection-manager.ts:362-377`). The earlier
  finding that closed FSMs linger was imprecise. Remaining 1C work is narrower
  than first stated — see the revised note in Phase 1C below.
- **Phase 2 — DONE & typecheck-verified** (240/240 tests pass). All five
  items: `SignalCarrierDown/Up` events (1), `PresenceAdd/PresenceRemove`
  events with reason (2), DTLS/data-channel state in the DTLS-stall
  trigger (3), RTCPeerConnection `signalingState` in the SDP-exchange-
  timeout trigger (4), and a jitter-deviation clamp in `voice.ts` (5).
- **Phase 4A — DONE & typecheck-verified** (240/240 tests pass).
  Per-connection `sdpExchangeTimeoutMs` threaded through
  `ensureConnection` opts → `ConnectionManager` (per-agent override map) →
  `PeerConnectionFSM`. `streams-store._computeSdpTimeout()` derives it
  from the signals-carrier RTT EWMA (`clamp(rtt*20, 5000, 15000)`);
  no sample → undefined → FSM falls back to the 15s config default, so a
  no-RTT connection is never worse than before. K/FLOOR provisional.
- **Phase 4B — DONE (verification, no code change needed).** Duplicate
  FSM connections to a peer are structurally impossible:
  `ConnectionManager._connections` is a `Map` keyed by agent;
  `ensureConnection` is idempotent (`connection-manager.test.ts` "does
  not create duplicate FSMs"); simultaneous bilateral initiation does not
  deadlock (`two-peer-integration.test.ts` test 4); glare is resolved by
  Perfect Negotiation with deterministic polite/impolite roles
  (`rtc-peer.test.ts` "Perfect Negotiation — glare handling"). All
  covered by passing tests. The multiple connection-ids seen for one
  peer-pair in the 2026-05-13 log are *different layers* — the FSM
  allocates its own connectionId and ignores the InitRequest/InitAccept
  handshake id — not duplicate live FSMs.
- **Phases 1B, 1C, 1D — not yet implemented.** They touch the realtime
  connection-teardown path and should land as separate, runtime-tested
  increments rather than alongside 1A.


Source: forensic analysis of merged logs `Presence_merged_0.14.7_2026-5-13` and
`2026-5-15`, plus a reported "peer dropped from screen mid-call" incident.

## Background — the bug that drives Phase 1

A remote participant's pane is removed from the UI when that peer drops out of
`globalPresenceSet()`. That set is computed purely from Holochain-signal
ping/pong staleness:

- `PING_INTERVAL = 2000ms` — `PingUi` broadcast over Holochain signals
  (`ui/src/streams-store.ts:93`).
- `ACTIVE_AGENT_STALENESS = 3 * PING_INTERVAL = 6000ms`
  (`ui/src/streams-store.ts:240`).
- `observerStaleness = 2.8 * PING_INTERVAL = 5600ms`
  (`ui/src/streams-store.ts:2973`).
- `lastSeen` is refreshed only on `PongUi` receipt
  (`ui/src/streams-store.ts:5063`).

Nothing in the presence-set computation consults the WebRTC connection state.
WebRTC itself tolerates a 15s ICE-disconnected grace
(`ICE_DISCONNECTED_GRACE_MS = 15000`, `ui/src/streams-store.ts:86`;
`iceDisconnectedGraceMs` in `transport/fsm/types.ts:264`).

Consequence: a Holochain-signal-relay hiccup of >6s removes a peer's pane even
though the WebRTC media connection is healthy and streaming. The signal carrier
is demonstrably unreliable in the logs (loss=12%, multi-second jitter spikes),
so 6s+ outages are routine. This is the most likely explanation for the
reported "peer dropped from my screen" incident, and it is self-correcting
(the pane returns on signal recovery), which matches the "seen it a couple
times" observation.

## Phase 1 — Presence lifecycle + connection cleanup (highest priority)

### 1A. Media liveness keeps the pane

A peer whose media is actively flowing must not be pruned from the presence
set by ping staleness alone. Liveness covers **both carriers**:

- **WebRTC carrier** — the active transport has a connection for the peer in
  the `connected` phase, not in ICE `failed`/`closed`, not past the
  disconnected grace window. The FSM exposes connection state via the
  connection-manager view model (`transport/fsm/connection-manager.ts`);
  `_openConnections` (`ui/src/streams-store.ts`) carries the per-peer
  `connectionId`.
- **Signals carrier** — when a peer is on the `signals` carrier (post
  `CarrierSwitch ...->signals`), flowing signal-relayed audio or video also
  counts. Use recent media-frame/stats arrival, not pong receipt, as the
  signal: the carrier produces `QualityBucketChange signals:...` events with
  rtt/jitter/loss derived from received media, so a recent signals-carrier
  media-stats sample is the liveness marker.

- Add a predicate `isPeerMediaLive(pubkey)` returning true if either carrier
  shows recent flowing media.
- In `globalPresenceSet()` (`ui/src/streams-store.ts:2957`), union in every
  peer for which `isPeerMediaLive` holds, regardless of `lastSeen`.
- Net effect: the maximum "ghost pane" window after an ungraceful peer
  disappearance becomes ~15s (ICE grace) instead of 6s, and a graceful leave
  still removes the pane immediately because `handleLeaveUi`
  (`ui/src/streams-store.ts:4907`) closes the connection and stops media — so
  a real leave fails `isPeerMediaLive` at once.

Rationale: actual flowing media is the strongest possible evidence of
presence; the 2s heartbeat on a separate lossy transport is the weakest. Today
the weakest signal overrides the strongest. Including signals-carrier media
means a peer who has fallen back to the signal relay but is still being seen
and heard is not pruned just because the ping/pong specifically went stale.

### 1B. Connection-teardown symmetry

With 1A, presence and WebRTC liveness must stay coupled in both directions:

- When a peer is removed from the presence set (genuinely gone — ping stale
  AND not WebRTC-alive), explicitly close all transports for that peer
  (video, screen-in, screen-out) via `closeConnection`. This prevents an
  orphaned WebRTC connection lingering for a peer with no pane.
- Verify `_handleMediaClosed` (`ui/src/streams-store.ts:901`) is the single
  funnel for connection teardown and that it clears: `_openConnections`,
  video/screen streams, audio analyzer, and emits `peer-disconnected`.

### 1C. Stale-state audit + reconciliation

Audit every per-peer collection for entries that can outlive the connection,
and add one reconciliation pass.

Collections to audit:
- `_openConnections` — removed in `_handleMediaClosed`; confirm no path leaves
  a half-open entry.
- FSM `_connections` map (`transport/fsm/connection-manager.ts`) — a `closed`
  FSM is only destroyed/replaced on the next `ensureConnection` call; if that
  call never comes the closed FSM lingers. Add proactive destroy on close.
- `_pendingInits` (`ui/src/streams-store.ts:2598`) — confirm entries are
  cleared on connect/leave/timeout (`_pendingAccepts` already has a 20s TTL;
  `_pendingInits` needs the same check).
- `_othersConnectionStatuses`, `_lastQualityBucket`, and any per-peer maps
  added later (e.g. the signaling-RTT EWMA from Phase 4) — clear on peer
  leave.

Add `_reconcilePeerState()`:
- Cross-checks `_knownAgents`, the presence set, `_openConnections`, and the
  FSM connection map for each peer; logs any discrepancy as a diagnostic
  event (see Phase 2) and cleans it.
- Runs on `peer-disconnected`, on `handleLeaveUi`, and on a low-frequency
  timer (e.g. every 10s) as a backstop.

### 1D. Signal-connection outage handling

Today nothing clears or rebuilds peer state when the Holochain signal
websocket drops/reconnects — it relies on staleness decay. With 1A this is
mostly fine (WebRTC-alive peers survive the outage). Two small additions:
- On signal-connection re-establish, trigger an immediate `pingAgents()`
  instead of waiting up to 2s for the next interval.
- Emit explicit signal-up/signal-down diagnostic events (Phase 2) so outages
  are visible in merged logs — without this, the Phase 1 bug class is
  invisible in forensics.

## Phase 2 — Forensics

Prioritised by how directly they support diagnosing the failures actually seen.

1. **Signal-carrier connection up/down events.** There is currently no log
   line when the Holochain signal transport drops or recovers. This is the
   single most important gap: the Phase 1 bug is undetectable in a merged log
   without it. Emit `SignalCarrierDown` / `SignalCarrierUp` with duration.
2. **Presence-set membership changes with reason.** Log every add/remove of a
   peer from `globalPresenceSet()` with the cause: `ping-stale`,
   `observer-stale`, `leave`, `webrtc-alive-hold`, `webrtc-closed`. Directly
   documents the reported symptom and confirms whether 1A is working.
3. **DTLS transport state at stall.** The `DTLS stall after 5000ms` events
   (`transport/fsm/peer-connection-fsm.ts:1120`) currently carry no DTLS
   detail. Add `RTCDtlsTransport.state` and `.error` to the trigger string so
   we can tell "handshake never started" from "handshake hung".
4. **SDP-exchange-timeout step reached.** The `SDP exchange timeout (15000ms)`
   trigger (`transport/fsm/peer-connection-fsm.ts:471`) should record the last
   SDP step completed: `offer-sent`, `answer-received`, `candidates-pending`,
   etc. Four identical 15s timeouts in the 5/13 log were indistinguishable.
5. **Fix nonsense signal-carrier metrics.** `jit=148966.5ms`,
   `jit=7065.6ms`, `Retry gap 1490955ms` are stale/uninitialised values. Clamp
   or suppress jitter/retry-gap reporting on the `signals` carrier rather than
   emitting garbage into the merged log.

Not included (deliberately): quality-bucket hysteresis and simplepeer ICE-dump
parity — out of scope per the "no behaviour changes" constraint; revisit later
if log noise becomes a problem.

## Phase 3 — Diagnostic-log-request UI

### 3A. Button resets to requestable after logs are handled

Today the button is green (`#09b500`) whenever `_receivedDiagnosticLogs` has an
entry for the peer, and stays green indefinitely
(`ui/src/room/room-view.ts:1128-1172`, room-level `1315-1341`; stores at
`ui/src/streams-store.ts:2706-2719`).

Plan: after the merged log is exported/downloaded — peer-level
`exportMergedLogs` or room-level `exportMergedLogsAll`
(`ui/src/streams-store.ts:4147` / `4225`) — clear the corresponding
`_receivedDiagnosticLogs` (and `_failedDiagnosticRequests`) entries so the
button returns to its default requestable colour and a fresh request can be
made.

Open decision: reset on download (recommended — green = "results ready, click
to download", clears once consumed) vs. reset on receipt with auto-download
(sprays one file per peer for per-peer requests). Recommendation: reset on
download.

### 3B. Request logs only from conversation participants

Today the room-level `requestDiagnosticLogs()` with no argument targets every
known agent (`ui/src/streams-store.ts:4080-4098`):

```ts
const targetKeys = pubKeyB64
  ? [pubKeyB64]
  : Object.keys(get(this._knownAgents)).filter(a => a !== this.myPubKeyB64);
```

`_knownAgents` includes `'told'` agents (heard about via others) who were never
in the call — this is why requests almost always fan out to absent peers and
pollute the merged log with timeouts.

Plan: introduce a session-scoped `_conversationParticipants: Set<AgentPubKeyB64>`:
- A peer is added the first time a WebRTC connection to them reaches the
  `connected`/`Connected` state.
- Entries are kept for the whole session even after the peer drops — that is
  exactly the set you want logs from when diagnosing a drop.
- `requestDiagnosticLogs()` with no argument targets this set instead of
  `_knownAgents`.

This captures everyone genuinely in the call, including a peer who has since
disconnected, and excludes peers who were merely known-about.

### 3C. Incremental request window (optional, only if cheap)

`getRecentAgentEvents` / `getRecentCustomLogs` (`ui/src/logging.ts:588-607`)
pull a fixed 15-minute window per request. Optionally persist the last
request timestamp in `localStorage` and pass it as the `sinceMs` lower bound so
a follow-up request fetches only new data.

Treat as a stretch item: do it only if it drops in cleanly. Re-fetched
overlapping data is not harmful (it can be de-duplicated at analysis time), so
this is a nice-to-have, not a requirement. Skip if it introduces clock-skew or
cross-session-staleness complications.

## Phase 4 — SDP timeout (RTT-scaled) + tiebreaker verification

### 4A. RTT-scaled SDP-exchange timeout

Current: fixed `sdpExchangeTimeoutMs = 15_000` (`transport/fsm/types.ts:262`),
armed on entering the `signaling` state (`transport/fsm/peer-connection-fsm.ts:471`).

**Can we trust the RTT data?** Yes, for this purpose. Signaling RTT is measured
as `Date.now() - matchingInit.t0` — the InitRequest→InitAccept round trip
(`ui/src/streams-store.ts:5467-5475`). That traverses the *same Holochain
signal transport* the SDP exchange uses, so it is the correct latency proxy.
It is a single, potentially noisy sample, so it must be smoothed.

**Is it always available?** No.
- Initiator side: the InitAccept that precedes the FSM `signaling` state yields
  a fresh RTT sample for the current attempt — available exactly when the SDP
  timer would be armed. So first contact works on the initiator side.
- Acceptor side (`remote signal received`): the acceptor does not measure
  InitRequest→InitAccept RTT, so on true first contact with a peer it has no
  sample.
- Per-peer RTT is currently only logged, not stored.

**Plan:**
- Add a per-peer signaling-RTT EWMA (`alpha ≈ 0.3`), updated wherever the
  RTT is currently measured. Clear it on peer leave (Phase 1C).
- When building the per-connection `ConnectionConfig`, compute:
  `sdpExchangeTimeoutMs = clamp(rttEwma * K, FLOOR, 15_000)`
  with provisional `K = 20`, `FLOOR = 5_000`, `CEILING = 15_000`.
- **Fallback when no sample exists** (acceptor first contact, or stale sample):
  use `15_000` — i.e. exactly today's behaviour. The change can never make a
  no-data connection worse than current.

Provisional numbers: RTT 200ms → 5s (floored); 350ms → 7s; ≥750ms → 15s.
Most peers (observed RTTs 113-351ms) get 5-7s instead of 15s, cutting ~8-10s
off each failed exchange, while genuinely high-latency peers retain the full
15s. `K`, `FLOOR` are tunable; the 15s ceiling/fallback keeps the worst case
bounded to today's behaviour. The exchange rides a lossy relay, so `K` is kept
generous to absorb one or two signal retransmits.

### 4B. Auto-flip / glare tiebreaker verification (no code change unless a bug is found)

The 5/13 log shows two connections to the same peer created concurrently
(`a216662e` initiated locally, `a050c0ea` initiated by the remote) both running
until timeout. Verify the collision machinery actually suppresses the loser:

- `resolveWebrtcImpl` (`transport/auto-flip-policy.ts:83-97`) — impl selection,
  FSM wins on disagreement (commit `4078fbe`).
- Polite/impolite role — `polite = _myAgentId < remoteAgent`
  (`transport/fsm/connection-manager.ts:321-323`).
- Glare handling — Perfect Negotiation in `transport/fsm/rtc-peer.ts:313-331`.
- Stale-signal filtering — `_validateSignalSession`
  (`transport/fsm/peer-connection-fsm.ts:610-638`).

Verification method: trace the `a216662e` / `a050c0ea` connection IDs through
the 5/13 log against this code path and confirm the impolite side cleanly
abandons its attempt. If both attempts genuinely run to completion, file a
follow-up. Where practical, add a unit test that drives simultaneous
`ensureConnection` from both polite and impolite roles and asserts a single
surviving connection.

## Out of scope (explicitly not doing)

From the original forensic suggestions, the following behaviour changes are
deferred: forcing TURN-only after one SDP timeout; holding the prior carrier
until the new connection reaches ICE-connected; quality-bucket hysteresis;
simplepeer ICE-dump parity. Only the RTT-scaled SDP timeout (4A) and the
tiebreaker verification (4B) are in scope from that list.

## Resolved decisions

1. Button reset trigger — **on download** (confirmed).
2. Phase 4A constants `K` / `FLOOR` — provisional; **confirm against a wider
   RTT sample before merge** (confirmed).
3. Phase 3C incremental window — include only if it lands cleanly.
4. Liveness (1A) covers flowing media on **both** the WebRTC and signals
   carriers (confirmed).
