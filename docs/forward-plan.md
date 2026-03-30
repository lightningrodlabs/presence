# Forward Plan: WebRTC Connection Architecture Hardening

**Date:** 2026-03-30
**Status:** Proposed — for review before implementation

---

## Diagnosis: Why the Bug Fixing Process Was Slow

The debugging transcript (docs/state-machine-bug-fixing-transcript.md) documents 8 bugs found in live testing, where each fix introduced the next bug. The stale signal analysis (docs/stale-signal-analysis.md) identifies a still-open root cause. The pattern reveals a structural problem in how the code was built and tested.

### The Cascade Pattern

```
Bug 3 fix (send leave, replace FSMs on offer)
  → caused Bug 4 (renegotiation offers treated as new connections)
Bug 4 fix (don't replace connected FSMs)
  → exposed Bug 5 (concurrent signaling ops corrupt state)
Bug 5 fix (task queue)
  → exposed Bug 6 (track accumulation from addTrack vs replaceTrack)
```

Each fix was correct for its immediate symptom but violated an unstated invariant somewhere else. This happens when invariants exist only in the developer's head, not in the code or tests.

### Three Missing Architectural Pillars

**1. Connection-scoped signal filtering (connectionId enforcement)**

The type system defines `connectionId` on every `SignalMessage`. The local branch (`feat/peer-connection-state-machine`) made connectionId a first-class member of every FSM state — `InitSent{connectionId}`, `SdpExchange{connectionId}`, `Connected{connectionId}` — and validated every incoming signal against it. The remote branch defined it in types but _explicitly ignores it_ (`_connectionId` parameter in `_routeSignalToFSM`). This is the direct cause of the stale signal poisoning problem and a contributing factor in bugs 3, 4, and 8.

**2. Proactive track health monitoring**

The current code is purely reactive: it responds to browser events (track added, track muted) but never polls to check if tracks are actually delivering data. The local branch polled `RTCStatsReport` for `bytesReceived` on inbound RTP streams every ping cycle, detecting dead tracks before the user noticed black video. This class of monitoring doesn't exist in the remote branch.

**3. Stream reconciliation via application-level metadata**

The pong message carries `streamInfo` (what tracks the sender believes they're sending). The current code stores this metadata but never compares it against what we're actually receiving. The local branch compared pong metadata against received track state and triggered recovery when they diverged. This catches the entire class of "connected but no video" bugs that accounts for most of the live-testing time.

### Why the Tests Didn't Catch These

The transcript's process observation #3 is precise: "MockRTCPeerConnection doesn't simulate real ICE candidate generation, concurrent negotiationneeded events, or signal delivery timing." The test infrastructure models the _API shape_ of RTCPeerConnection but not its _temporal behavior_. Specifically:

- **No stale signal injection**: Tests create one connection, never simulate disconnect/reconnect with lingering signals
- **No concurrent event simulation**: `negotiationneeded` never fires asynchronously during `handleSignal`
- **No track lifecycle**: Mocks don't simulate track.stop(), track.enabled, or transceiver reuse
- **FakeSignalingChannel exists but isn't used for the right scenarios**: It models latency/drops but not stale-session signal pollution

---

## Mapping Local Branch Features to Open Problems

The earlier comparison recommended porting 5 features from the local branch. Here's how each maps to the documented bugs and the open stale signal problem:

| Feature | Bugs It Would Have Prevented/Detected | Open Problem It Addresses |
|---------|---------------------------------------|---------------------------|
| **connectionId scoping** (every state carries connectionId, signals validated against it) | Bug 3 (stale FSM receives new offers), Bug 4 (renegotiation misrouted), Bug 8 (disconnected FSM gets stale signals) | **Stale signal poisoning** — this is the direct fix |
| **Track health monitoring** (RTP bytesReceived polling) | Bug 1 (video not established — would detect 0 bytes), Bug 6 (accumulated tracks — would detect only one delivering) | Proactive dead-track detection |
| **Track recovery** (replaceTrack → cloneStream fallback) | Bug 6 (track accumulation recovery), Bug 1 (video recovery) | Self-healing after track failures |
| **Stream reconciliation** (pong metadata vs actual received state) | Bug 1 (peer says video-on but we have no track), post-Bug 7 scenarios | Catches "connected but no video" class |
| **ICE diagnostics** (failed pair logging, candidate IP:port) | Bug 2 (peers can't connect — would show which candidates failed) | Debugging aid, not a fix itself |

**Key insight**: connectionId scoping is not just one feature among five — it's the architectural foundation that the stale signal analysis independently arrived at. The local branch had this from the start because its state machine was designed around connectionId as a discriminant. The remote branch needs it retrofitted.

---

## Implementation Plan

### Guiding Principles

1. **Each phase must leave the code in a working state** — no multi-phase dependencies that break the middle
2. **Each phase must add or improve tests that would have caught the bugs it addresses** — the test must fail before the fix
3. **No ad-hoc guards** — if a condition needs checking, it belongs in a state transition rule or a filter at a routing boundary, not scattered in handler code

### Phase 1: Connection-Scoped Signal Filtering

**Goal**: Stale signals from previous sessions are silently dropped before reaching any FSM or RTCPeer.

**Why first**: This is the open root cause. Every subsequent phase benefits from clean signal routing.

#### 1a. Add `remoteConnectionId` tracking to PeerConnectionFSM

When the FSM processes an offer or answer, it records the `connectionId` from the signal as `remoteConnectionId`. This represents the remote peer's session identity.

```
PeerConnectionFSM:
  connectionId: string          // our session ID (already exists)
  remoteConnectionId?: string   // their session ID (new)
```

- Set `remoteConnectionId` when we accept an offer (the offer carries the remote's connectionId)
- Set `remoteConnectionId` when we receive an answer (the answer carries the remote's connectionId)
- Clear `remoteConnectionId` when creating a new RTCPeer (full reconnect)

**File**: `ui/src/connection/peer-connection-fsm.ts`

#### 1b. Implement connectionId filter in `_routeSignalToFSM`

Replace the currently-ignored `_connectionId` parameter with actual filtering:

```
For 'offer' signals:
  - If no FSM exists: accept (creates FSM, store remoteConnectionId)
  - If FSM exists and is idle/disconnected/failed: accept (new session)
  - If FSM exists and is connected/signaling/connecting:
    accept (renegotiation or new session from reconnected peer)
    Update remoteConnectionId
  - If FSM exists and is closed: replace FSM, accept

For 'answer' signals:
  - Accept only if signal.connectionId matches fsm.remoteConnectionId
    OR fsm.connectionId
  - Drop otherwise (stale answer from previous session)

For 'candidate' signals:
  - Accept only if signal.connectionId matches fsm.remoteConnectionId
    OR fsm.connectionId
  - Drop otherwise (stale candidate from previous session)
```

Log dropped signals with reason for diagnostics.

**File**: `ui/src/connection/connection-manager.ts`

#### 1c. Ensure connectionId propagation is complete

Verify that `HolochainSignalingAdapter.sendSignal()` includes connectionId on every outgoing signal (offers, answers, AND candidates). Currently candidates may not carry it.

**File**: `ui/src/connection/holochain-signaling-adapter.ts`, `ui/src/connection/peer-connection-fsm.ts`

#### 1d. Tests for stale signal rejection

Add to `two-peer-integration.test.ts`:

- **Stale answer after reconnect**: Peer A connects to B, disconnects, reconnects with new connectionId. An answer from the old session arrives. Assert: dropped silently, new session unaffected.
- **Stale candidates after reconnect**: Same setup, stale ICE candidates arrive. Assert: dropped.
- **Renegotiation offer on connected FSM**: Peer A adds a track while connected. Assert: offer accepted (not treated as stale), renegotiation succeeds.
- **Simultaneous reconnect**: Both peers disconnect and reconnect. Old signals from both cross in flight. Assert: both eventually connect with no corruption.

Add to `FakeSignalingChannel`:
- `injectStaleSignal(from, connectionId, signal)` — inject a signal with an old connectionId to simulate in-flight stale signals.

### Phase 2: Track Health Monitoring

**Goal**: Detect tracks that are nominally "receiving" but delivering zero bytes, before the user sees black video.

**Why second**: With clean signal routing from Phase 1, track health issues are genuinely about track/media problems, not masked signal corruption.

#### 2a. Add RTP stats polling to PeerConnectionFSM

Add a `checkTrackHealth()` method that:
1. Calls `peer.getStats()` (RTCPeerConnection.getStats())
2. For each `inbound-rtp` stat, records `bytesReceived`
3. Compares against previous poll — if `bytesReceived` hasn't changed for N consecutive cycles, the track is stale
4. Emits a new event: `track-stale` with `{ kind: 'audio' | 'video', staleCycles: number }`

State to add to FSM:
```typescript
_lastBytesReceived: Map<string, number>  // trackId → bytes
_staleCycles: Map<string, number>        // trackId → consecutive stale count
```

Constants:
```typescript
STALE_THRESHOLD = 2  // cycles before declaring stale (matches local branch)
```

**File**: `ui/src/connection/peer-connection-fsm.ts`

#### 2b. Wire polling into StreamsStore ping cycle

In `pingAgents()` (already runs every 2s), iterate connected FSMs and call `checkTrackHealth()`. On `track-stale` event, trigger recovery (Phase 3).

**File**: `ui/src/streams-store.ts`

#### 2c. Add getStats() to RTCPeer

Expose `getStats(): Promise<RTCStatsReport>` on RTCPeer — thin passthrough to the underlying RTCPeerConnection.

**File**: `ui/src/connection/rtc-peer.ts`

#### 2d. Tests for track health detection

Extend `MockRTCPeerConnection` to support `getStats()` returning configurable `inbound-rtp` reports. Test scenarios:

- **Healthy track**: bytesReceived increases each poll → no event
- **Stale track**: bytesReceived unchanged for STALE_THRESHOLD polls → `track-stale` emitted
- **Track recovers**: bytesReceived resumes after stale → staleCycles resets

### Phase 3: Track Recovery and Stream Reconciliation

**Goal**: When a track is detected as stale or pong metadata shows a mismatch, automatically attempt recovery without full reconnection.

**Why third**: Depends on Phase 2 for detection. The recovery mechanisms are the response to what detection finds.

#### 3a. Two-tier track recovery in PeerConnectionFSM

When `track-stale` is detected or reconciliation triggers:

**Tier 1 — replaceTrack recovery** (lightweight):
- For each sender of the stale kind, call `replaceTrack(sender, existingTrack)` — even with the same track object, this forces re-encoding
- Wait one poll cycle to check if bytesReceived resumes

**Tier 2 — stream clone recovery** (heavier):
- If Tier 1 fails (still stale after one cycle), clone the local MediaStream
- Remove old senders, add tracks from the clone
- This triggers full renegotiation but preserves ICE/DTLS

Track which tier was last attempted to avoid repeating the same recovery:
```typescript
_lastRecoveryTier: Map<string, 1 | 2>  // trackId → tier
_lastRecoveryTime: Map<string, number>  // trackId → timestamp
```

Apply exponential backoff to recovery attempts (10s, 20s, 40s, 80s, 160s) to avoid thrashing.

**File**: `ui/src/connection/peer-connection-fsm.ts`

#### 3b. Stream reconciliation via pong metadata

In `handlePongUi()`, after receiving `streamInfo` from a peer:

```
peerSaysVideo: boolean  = pong.streamInfo.video
weReceiveVideo: boolean = _videoStreams has active video track for this peer

If peerSaysVideo && !weReceiveVideo && connection is Connected:
  → trigger reconciliation for this peer (request track refresh via data channel,
    and initiate local replaceTrack recovery)

If !peerSaysVideo && weReceiveVideo:
  → stale local state, clean up video stream display
```

Add reconciliation backoff per-peer to avoid spamming recovery on every pong (every 2s):
```typescript
_lastReconcileTime: Map<AgentPubKeyB64, number>
RECONCILE_MIN_INTERVAL = 10_000  // 10s minimum between reconciliation attempts per peer
```

**File**: `ui/src/streams-store.ts`

#### 3c. Tests for recovery

- **replaceTrack recovery**: Simulate stale track → Tier 1 recovery → bytesReceived resumes → assert no Tier 2
- **Clone recovery fallback**: Simulate stale track → Tier 1 fails → Tier 2 triggered → assert stream cloned and re-added
- **Reconciliation from pong**: Inject pong with `video: true` when no video track received → assert recovery triggered
- **Backoff**: Trigger recovery, then immediately trigger again → assert second attempt deferred

### Phase 4: ICE Diagnostics

**Goal**: When ICE fails, log enough information to diagnose why without speculation.

**Why fourth**: This is observability, not functionality. Phases 1-3 fix bugs; this phase ensures future bugs are diagnosable from logs alone.

#### 4a. Failed candidate pair logging

When ICE transitions to `failed`, query `getStats()` for:
- All candidate pairs and their states
- The nominated pair (if any) before failure
- Local and remote candidate types (host/srflx/relay) and addresses
- `bytesReceived`/`bytesSent` on the failed pair

Log as a structured `IceFailureDiagnostic` event.

**File**: `ui/src/connection/peer-connection-fsm.ts`

#### 4b. Candidate count tracking (already partially done)

The FSM already tracks `_localCandidateCount` and `_remoteCandidateCount`. Ensure these are:
- Logged on every ICE state change (already done)
- Reset on full reconnect (verify)
- Included in diagnostic log exports

#### 4c. Tests

- Mock `getStats()` to return candidate pair data → assert `IceFailureDiagnostic` event contains expected fields
- Verify candidate counts reset on full reconnect

### Phase 5: Test Infrastructure Upgrade

**Goal**: Tests model the temporal and lifecycle behaviors that caused all 8 documented bugs, so regressions are caught before live testing.

**Why last**: Phases 1-4 introduce the features. Phase 5 ensures the test infrastructure can verify them under realistic conditions and catch regressions going forward.

#### 5a. Fix vitest configuration

Tests currently fail with import errors (vitest `vi` undefined). Fix the config before adding new tests.

**File**: `ui/vitest.config.ts`

#### 5b. Enhance MockRTCPeerConnection

Add to `test-helpers.ts`:

| Capability | What It Models | Bugs It Would Catch |
|-----------|---------------|---------------------|
| `simulateNegotiationNeeded()` | Async `negotiationneeded` firing after addTrack | Bug 5 (concurrent signaling) |
| `simulateTrackEnded()` | Track.stop() followed by getUserMedia | Bug 6 (accumulation), Bug 7 (permission) |
| `getStats()` returning configurable RTP reports | bytesReceived polling | Track health scenarios |
| `simulateTransceiverReuse()` | replaceTrack on existing transceiver | Bug 6 (accumulation) |

#### 5c. Enhance FakeSignalingChannel

Add to `test-helpers.ts`:

| Capability | What It Models | Bugs It Would Catch |
|-----------|---------------|---------------------|
| `injectStaleSignal(from, oldConnectionId, signal)` | Signals from previous session arriving late | Stale signal poisoning |
| `simulateDisconnectReconnect(agent)` | Agent leaves and rejoins with new connectionId | Bug 3, Bug 8 |
| `interleaveSignals(signal1, signal2)` | Two signals arriving in reversed order | Bug 5 (SDP state corruption) |

#### 5d. Add regression test suite

Create `__tests__/regression-scenarios.test.ts` with one test per documented bug:

1. **Video on first connect**: Connect → videoOn after connect → assert remote receives video track
2. **Renegotiation preserves connection**: Connected → addTrack → assert same connectionId, no FSM replacement
3. **Manual disconnect + reconnect**: Connect → close → reconnect → assert remote receives leave, new connection established
4. **Track toggle doesn't accumulate**: Connect → videoOn → videoOff → videoOn → assert exactly 1 video transceiver
5. **Stale signals dropped**: Connect → disconnect → reconnect with new ID → inject stale answer → assert ignored
6. **Timeout triggers retry**: Connect → simulate ICE timeout → assert retry from pong cycle
7. **Concurrent renegotiation**: Both peers addTrack simultaneously → assert connection survives (Perfect Negotiation glare)

Each test should:
- Set up the scenario using FakeSignalingChannel
- Trigger the exact sequence that caused the original bug
- Assert the correct behavior
- Be named after the bug it prevents (e.g., `it('Bug3: manual disconnect sends leave signal')`)

#### 5e. Add integration smoke test for track lifecycle

Create `__tests__/track-lifecycle.test.ts`:

- videoOn → replaceTrack → videoOff (disable, not stop) → videoOn (re-enable) → assert single transceiver, track.enabled toggles correctly
- Audio and video independent toggle sequences
- Track health polling detects stale → recovery → resumed

---

### Phase 1.5: Pong Liveness Detection and Peer Departure

**Goal**: When a peer's process is killed (no LeaveUi signal), detect their absence within ~10 seconds and clean up the connection and UI tile. Stop wasting reconnect attempts against dead peers.

**Why now**: The log from session 3 shows uhCAky-S entering `reconnecting` and cycling through full reconnects (sessions 2, 3, 4) for 90+ seconds against a dead peer. The peer stopped sending pongs at +18s but nobody noticed. This is more urgent than track health monitoring (Phase 2), because it affects every peer departure.

#### 1.5a. Track last pong timestamp per agent in StreamsStore

In `handlePongUi()`, record `Date.now()` for each agent that sends a pong:

```typescript
_lastPongTime: Map<AgentPubKeyB64, number>
```

Update on every pong received.

**File**: `ui/src/streams-store.ts`

#### 1.5b. Pong timeout check in pingAgents()

In the existing `pingAgents()` cycle (runs every 2s), after sending pings, check each agent in `_lastPongTime`:

```
For each agent with an active connection (signaling/connecting/connected/reconnecting):
  if (now - lastPongTime > PONG_TIMEOUT_MS):
    connectionManager.closeConnection(agent, 'pong timeout')
    clean up video streams, screen share connections
    remove from _lastPongTime
```

`PONG_TIMEOUT_MS = 10_000` (5 missed pongs at 2s intervals). This is aggressive enough to catch killed processes but tolerant of occasional pong delays.

Do NOT apply pong timeout to peers in `idle`/`disconnected`/`failed`/`closed` — they're not expected to be sending pongs.

**File**: `ui/src/streams-store.ts`

#### 1.5c. Tests

- **Pong keeps connection alive**: Peer connects, pongs arrive every 2s, connection stays open after 10s
- **Pong timeout closes connection**: Peer connects, pongs stop, after 10s the connection is closed
- **Pong timeout only applies to active connections**: Peer in `idle` state is not closed by pong timeout

### Phase 1.6: Connection State UI Visibility

**Goal**: The user sees distinct visual states for "connected", "reconnecting", "connection lost", and "peer left" — not frozen/black video with no explanation.

**Why now**: The FSM has 8 states but the UI only sees 4 (`Disconnected`, `InitSent`, `SdpExchange`, `Connected`) via `_phaseToConnectionStatus`. The `reconnecting` state maps to `SdpExchange`, making reconnection invisible. The user sees frozen video for 90 seconds with no feedback.

#### 1.6a. Add `Reconnecting` to ConnectionStatus type

In `ui/src/types.ts`, add a new status variant:

```typescript
type ConnectionStatus =
  | { type: 'Disconnected' }
  | { type: 'Connected' }
  | { type: 'InitSent' }
  | { type: 'AcceptSent' }
  | { type: 'SdpExchange' }
  | { type: 'Reconnecting' }   // NEW
  | { type: 'Blocked' }
```

Update `_phaseToConnectionStatus`:
```
reconnecting → { type: 'Reconnecting' }
```

**Files**: `ui/src/types.ts`, `ui/src/streams-store.ts`

#### 1.6b. Render reconnecting state in peer video tile

In the room view's peer tile rendering, when status is `Reconnecting`:
- Show overlay text "Reconnecting..." on the video tile
- Dim the tile or add a visual indicator (e.g., pulsing border or opacity change)
- Keep the tile visible (don't remove it — the peer may come back)

When status transitions to `Disconnected` (from pong timeout or close):
- Remove the video stream
- Either remove the tile or show "Disconnected" briefly before removal

**Files**: `ui/src/room/room-view.ts` or relevant tile component

#### 1.6c. Show peer departure in agent list

When a peer's connection closes (pong timeout, leave signal, or FSM failure):
- Remove them from the video grid
- Keep them in the "known agents" list briefly if they might rejoin (e.g., if pongs resume)

**File**: `ui/src/streams-store.ts`, room view components

---

## Implementation Order and Dependencies

```
Phase 1 (connectionId + peerSessionId filtering)  ←  DONE
    │
    └── Refactored into FSM state with entry actions  ←  DONE

Phase 5a (fix vitest)  ←  DONE (was nix develop issue, not config)

Phase 1.5 (pong liveness detection)  ←  NEXT
    │
    ├── 1.5a: track last pong timestamp
    ├── 1.5b: pong timeout in pingAgents
    └── 1.5c: tests

Phase 1.6 (connection state UI visibility)  ←  after 1.5
    │
    ├── 1.6a: add Reconnecting status
    ├── 1.6b: render reconnecting in tile
    └── 1.6c: peer departure cleanup in UI

Phase 2 (track health monitoring)  ←  depends on Phase 1 (clean signals)
    │
    ├── 2a: RTP stats polling in FSM
    ├── 2b: wire to ping cycle
    ├── 2c: getStats on RTCPeer
    └── 2d: tests

Phase 3 (track recovery + reconciliation)  ←  depends on Phase 2 (detection)
    │
    ├── 3a: two-tier recovery
    ├── 3b: pong reconciliation
    └── 3c: tests

Phase 4 (ICE diagnostics)  ←  independent, can parallel with 2/3
    │
    ├── 4a: failed pair logging
    ├── 4b: verify candidate counts
    └── 4c: tests

Phase 5b-5e (test infrastructure + regression suite)  ←  depends on all above
```

**Recommended actual order**: 5a → 1 → 1.5 → 1.6 → 2 → 3 → 4 → 5b-5e

---

## Success Criteria

After all phases:

1. **Stale signals are provably dropped**: Test injects stale signals → they never reach RTCPeer
2. **Dead peers detected within 10s**: Pong timeout fires, connection closed, tile cleaned up
3. **User sees reconnection state**: `Reconnecting` status renders as overlay on tile, not frozen video
4. **Dead tracks are detected within 2 poll cycles (4s)**: Test stalls bytesReceived → event fires
5. **Recovery succeeds without full reconnect in >80% of cases**: replaceTrack recovery resolves most track issues
6. **Pong metadata mismatches trigger reconciliation**: Test simulates mismatch → recovery initiated
7. **All 8 transcript bugs have regression tests**: Each test named after its bug, each would fail without the fix
8. **No test relies on setTimeout timing**: Tests use explicit state transitions and mock clocks
9. **streams-store.ts does not grow**: Connection logic lives in the connection module; store is integration glue

---

## What This Plan Does NOT Cover

- **Screen share connection hardening**: Same patterns apply but screen share uses separate ConnectionManager. Port fixes after main video is solid.
- **SFU scaffolding**: The ConnectionRole enum exists for future use. Not addressed here.
- **Holochain signal reliability**: Fire-and-forget signals will always have delivery gaps. This plan makes the WebRTC layer resilient to those gaps rather than trying to fix the transport.
- **Multi-peer mesh scaling**: The plan addresses 2-3 peer scenarios matching current test environment. Mesh scaling is a separate concern.
