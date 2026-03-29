# WebRTC Connection State Machine: Implementation Plan

**Date:** 2026-03-28
**Status:** Draft — awaiting review
**Research:** See [webrtc-state-machine-research.md](webrtc-state-machine-research.md)

---

## Problem Statement

The current connection management in `streams-store.ts` (~3175 lines) has grown organically with guards, checks, and special cases scattered throughout:

1. **No unified state machine** — Connection state is split across `_pendingInits`, `_pendingAccepts`, `_openConnections`, and `_connectionStatuses` with no single source of truth governing transitions
2. **Race conditions** — Multiple simultaneous connection attempts occur despite alphabetical pubkey ordering, because guards are spread across different handler methods with no atomic state transitions
3. **SimplePeer abstraction leaks** — Direct `RTCPeerConnection` access (`(peer as any)._pc`) is needed for health checks, relay detection, and ICE monitoring
4. **Custom handshake protocol** — The InitRequest/InitAccept protocol duplicates work that the W3C Perfect Negotiation pattern handles more robustly
5. **No foundation for SFU** — The mesh-only architecture has no concept of connection roles needed for planned ad-hoc SFU volunteer system

---

## Architecture: Two-Layer State Model

Based on research of W3C specs, LiveKit, Matrix, mediasoup, Pion, and simple-peer (see research document), the state machine uses two layers.

### Layer 1 — Application Connection State

What the UI, ConnectionManager, and logging care about. Each `PeerConnectionFSM` instance tracks one of these states:

```
                    ┌──────────────────────────────────┐
                    │                                  │
                    v                                  │
Idle ──> Signaling ──> Connecting ──> Connected ──> Reconnecting
  ^         │              │             │              │
  │         │              │             │              │
  │         v              v             v              v
  │      Closed         Failed      Disconnected    Disconnected
  │                       │              │              │
  │                       v              v              v
  └───────────────────── Idle <──────── Idle <──────── Idle
```

| State | Meaning | Entry Condition | Owns |
|-------|---------|-----------------|------|
| **Idle** | No connection attempt | Initial state, or after cleanup from Failed/Disconnected | Nothing |
| **Signaling** | Exchanging offer/answer via Perfect Negotiation | `ensureConnection()` called, or remote offer received | Negotiation flags (`makingOffer`, `ignoreOffer`, `isSettingRemoteAnswerPending`) |
| **Connecting** | SDP applied, ICE checking, DTLS handshaking | Local+remote descriptions set | Connection timeout timer |
| **Connected** | Composite readiness achieved | ICE connected/completed AND DTLS connected AND data channel open | Health monitor, track state |
| **Reconnecting** | Recovery in progress | ICE disconnected/failed from Connected state | Recovery strategy (ICE restart or full reconnect), backoff timer |
| **Disconnected** | Recovery failed, awaiting next ping cycle to retry | Max retries exceeded in Reconnecting, or timeout in Connecting | Retry-on-ping flag |
| **Failed** | Unrecoverable error (DTLS failed, fatal error) | DTLS `failed` (terminal per spec), or repeated full reconnect failures | Cleanup timer before → Idle |
| **Closed** | Explicit teardown | Peer left room, peer blocked, or local leave | Nothing (terminal) |

**Composite readiness** (from simple-peer pattern): `Connected` requires ALL of:
- ICE transport state is `connected` or `completed`
- DTLS transport state is `connected`
- Data channel is `open`
- At least one track exchange has occurred (or timed out gracefully)

### Layer 2 — Transport State (Internal)

Mirrors the browser's native state machines directly (mediasoup pattern). Not exposed to UI, but logged for debugging:

- **ICE transport state** — `new`, `checking`, `connected`, `completed`, `disconnected`, `failed`, `closed`
- **ICE gathering state** — `new`, `gathering`, `complete`
- **DTLS transport state** — `new`, `connecting`, `connected`, `failed`, `closed`
- **Signaling state** — `stable`, `have-local-offer`, `have-remote-offer`, etc.

Layer 1 state is **derived** from Layer 2 using the W3C worst-case-wins aggregation (Pion algorithm):
1. Any DTLS `failed` → Layer 1 = `Failed` (DTLS failure is terminal, no recovery)
2. Any ICE `failed` → Layer 1 = `Reconnecting` (attempt ICE restart)
3. Any ICE `disconnected` → Layer 1 = `Reconnecting` (transient, may self-resolve)
4. All ICE `connected`/`completed` AND all DTLS `connected` → Layer 1 = `Connected`
5. Any ICE `checking` or DTLS `connecting` → Layer 1 = `Connecting`

---

## Perfect Negotiation Integration

Replaces the current InitRequest/InitAccept handshake with the W3C-recommended pattern.

### Current Flow (being replaced)
```
A (lower pubkey) decides to initiate
A sends InitRequest → B
B sends InitAccept → A
A creates SimplePeer(initiator: true)
B creates SimplePeer(initiator: false)
SDP exchange via SdpData messages
```

### New Flow (Perfect Negotiation)
```
Either side can initiate at any time.
Both sides run identical code.
Polite peer (lower pubkey) yields on collision.
Impolite peer (higher pubkey) wins on collision.
```

**Implementation:**
```typescript
// On negotiationneeded (both sides, identical code):
async function handleNegotiationNeeded() {
  makingOffer = true;
  try {
    await pc.setLocalDescription();  // browser generates offer
    sendSignal(pc.localDescription);  // send via Holochain
  } finally {
    makingOffer = false;
  }
}

// On receiving a signal (both sides, identical code):
async function handleSignal(description) {
  const readyForOffer = !makingOffer &&
    (pc.signalingState === "stable" || isSettingRemoteAnswerPending);
  const offerCollision = description.type === "offer" && !readyForOffer;
  ignoreOffer = !polite && offerCollision;  // polite = lower pubkey

  if (ignoreOffer) return;

  isSettingRemoteAnswerPending = description.type === "answer";
  await pc.setRemoteDescription(description);
  isSettingRemoteAnswerPending = false;

  if (description.type === "offer") {
    await pc.setLocalDescription();  // browser generates answer
    sendSignal(pc.localDescription);
  }
}
```

**What this eliminates:**
- `_pendingInits` map and retry logic
- `_pendingAccepts` map and TTL cleanup
- Separate InitRequest/InitAccept signal types
- Separate code paths for initiator vs responder
- The `INIT_RETRY_THRESHOLD` timer
- The `PendingInit` and `PendingAccept` types

**What we still need Holochain signaling for:**
- Peer discovery (PingUi/PongUi — unchanged)
- SDP/ICE candidate relay (offer, answer, candidate messages)
- Leave notification (LeaveUi — unchanged)
- Data channel messages for media control (unchanged, via RTCDataChannel)

### Connection Trigger

The ping/pong cycle remains the discovery mechanism. When a pong is received from an agent we're not connected to:

- Both sides create an `RTCPeerConnection` and enter `Signaling` state
- The `negotiationneeded` event fires when tracks are added
- Perfect Negotiation handles the rest — no need to decide who initiates
- If both sides fire `negotiationneeded` simultaneously, the polite/impolite resolution handles it

---

## Reconnection Strategy (from LiveKit)

Two-tier approach:

### Fast Path: ICE Restart
- **Trigger:** ICE state transitions to `disconnected` or `failed` while DTLS is still healthy
- **Action:** Call `pc.restartIce()`, which triggers `negotiationneeded` → new offer with ICE restart flag
- **Perfect Negotiation handles the renegotiation** — same code as initial connection
- **Timeout:** 15 seconds. If ICE doesn't recover, escalate to slow path.

### Slow Path: Full Reconnect
- **Trigger:** ICE restart failed, or DTLS `failed` (terminal)
- **Action:** Destroy `RTCPeerConnection`, create new one, re-enter `Signaling`
- **This is equivalent to a fresh connection** but preserves application state (known agent, media preferences)

### Retry Policy
Pluggable interface, default uses quadratic backoff with jitter (from LiveKit):

```typescript
interface ReconnectPolicy {
  nextRetryDelayMs(context: ReconnectContext): number | null;  // null = stop
}

// Default: [0, 300, 1200, 2700, 4800, 7000, 7000, 7000, 7000, 7000]
// Formula: min(n^2 * 300, 7000) + random(0, 1000) for attempt > 1
// Returns null after 10 attempts
```

---

## New File Structure

```
ui/src/connection/
  types.ts                  -- ConnectionState, ConnectionRole, ConnectionViewModel, events, configs
  rtc-peer.ts               -- Thin RTCPeerConnection wrapper (replaces SimplePeer)
  peer-connection-fsm.ts    -- Per-peer state machine + reactive ConnectionViewModel store
  connection-manager.ts     -- Owns all FSM instances, dispatches signals, exposes aggregate view model
  reconnect-policy.ts       -- Pluggable retry/backoff policy
  __tests__/
    rtc-peer.test.ts
    peer-connection-fsm.test.ts
    connection-manager.test.ts
    two-peer-integration.test.ts
    test-helpers.ts          -- Mock signaling channel, fake timers, etc.
```

---

## Component Details

### `rtc-peer.ts` — Direct RTCPeerConnection Wrapper

Replaces SimplePeer. NOT a full abstraction — keeps `RTCPeerConnection` accessible.

**Provides:**
- RTCPeerConnection creation with ICE config (STUN + optional TURN)
- Perfect Negotiation signal handling (offer/answer/candidate)
- ICE candidate handling (trickle or batch, with pre-remote-description queuing)
- Data channel creation and management
- Track/stream add/remove/replace (no more clone workarounds)
- Stats collection via `getStats()` (no more `(peer as any)._pc`)
- Event forwarding for all transport state changes

**Does NOT provide:**
- State management (that's the FSM's job)
- Retry logic (that's the reconnect policy's job)
- Signal transport (injected as callback)

### `peer-connection-fsm.ts` — Per-Peer State Machine

One instance per remote agent. Single source of truth for that connection's state.

```typescript
interface PeerConnectionFSM {
  readonly state: ConnectionState;
  readonly transportState: TransportState;  // Layer 2
  readonly remoteAgent: AgentPubKeyB64;
  readonly connectionId: string;
  readonly role: ConnectionRole;
  readonly metrics: ConnectionMetrics;

  // Reactive view model — subscribable by UI components
  readonly viewModel: Writable<ConnectionViewModel>;

  // Lifecycle
  connect(localStream?: MediaStream): void;  // Idle → Signaling
  close(reason: string): void;               // Any → Closed
  destroy(): void;                           // Cleanup, terminal

  // Signal inputs (from ConnectionManager)
  handleRemoteSignal(signal: RTCSessionDescriptionInit | RTCIceCandidateInit): void;

  // Media management
  addLocalStream(stream: MediaStream): void;
  removeLocalStream(stream: MediaStream): void;
  replaceTrack(oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack): void;

  // Events
  on(event: FSMEvent, handler: FSMEventHandler): Unsubscribe;
}
```

**Guarded transitions:** Every state change goes through a `transition(newState, trigger)` method that:
1. Validates the transition is legal (lookup table)
2. Cancels timers owned by the exiting state
3. Starts timers owned by the entering state
4. Logs the transition (always, unconditionally)
5. Emits the state change event

**Invalid transitions are logged as `FSMTransitionBlocked` and rejected** — never silently ignored.

### `connection-manager.ts` — Orchestration

```typescript
class ConnectionManager {
  private connections: Map<AgentPubKeyB64, PeerConnectionFSM>;
  private signaling: SignalingAdapter;
  private reconnectPolicy: ReconnectPolicy;

  // Reactive aggregate view model — subscribable by room-level UI
  readonly viewModel: Writable<ConnectionManagerViewModel>;

  // Per-agent view model access
  getViewModel(agent: AgentPubKeyB64): Writable<ConnectionViewModel> | undefined;

  // Called by ping/pong cycle
  ensureConnection(agent: AgentPubKeyB64): void;

  // Signal dispatch (from Holochain signal handler)
  handleSignal(from: AgentPubKeyB64, type: string, payload: string): void;

  // Media (propagated to all active FSMs)
  updateLocalStream(stream: MediaStream): void;

  // State queries
  getState(agent: AgentPubKeyB64): ConnectionState;
  getAllStates(): Map<AgentPubKeyB64, ConnectionState>;

  // Events
  on(event: ManagerEvent, handler: ManagerEventHandler): Unsubscribe;
}
```

**SignalingAdapter interface** (decouples from Holochain):
```typescript
interface SignalingAdapter {
  sendSignal(to: AgentPubKeyB64, signal: RTCSessionDescriptionInit | RTCIceCandidateInit): void;
  sendLeave(to: AgentPubKeyB64): void;
  onSignal(handler: (from: AgentPubKeyB64, signal: any) => void): Unsubscribe;
}
```

---

## Connection Roles (SFU Scaffolding)

```typescript
type ConnectionRole =
  | 'mesh'            // Standard P2P (current behavior, all connections use this initially)
  | 'sfu-upstream'    // We send our stream to an SFU volunteer
  | 'sfu-downstream'  // We receive forwarded streams from an SFU volunteer
  | 'sfu-relay'       // We ARE the SFU volunteer for this connection
```

The FSM accepts a `role` parameter that affects:
- **Track directionality:** mesh = bidirectional, sfu-upstream = sendonly, sfu-downstream = recvonly
- **Data channel usage:** relay nodes need a control channel for routing metadata
- **Health check strategy:** relay nodes monitor forwarding latency, not just bytesReceived
- **Recovery strategy:** relay failure triggers re-election (future), not just reconnect

**All connections use `mesh` role initially.** The type system and FSM transitions are role-aware from day one to prevent a second rewrite when SFU is implemented.

---

## Reactive UX Observability

The state machine must be designed as a **subscribable reactive data source from day one**, so that UI components can experiment with visual representations of connection progress, retry, and health without coupling to FSM internals.

### Design Principle

The FSM does not own any UI. Instead, it exposes a reactive store that UI components subscribe to. The store emits a rich, pre-computed view model on every state change — not raw FSM internals, but a UX-oriented projection that any visual component can consume without needing to understand WebRTC.

### Reactive Store: `ConnectionViewModel`

Each `PeerConnectionFSM` exposes a `Writable<ConnectionViewModel>` that updates on every transition:

```typescript
type ConnectionPhase =
  | 'idle'
  | 'signaling'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'
  | 'closed';

type ConnectionViewModel = {
  // Core state — what phase is this connection in?
  phase: ConnectionPhase;

  // Progress within the current phase (0.0 to 1.0)
  // e.g., signaling: 0.5 = offer sent, waiting for answer
  //        connecting: 0.7 = ICE connected, waiting for DTLS
  //        reconnecting: progress through retry attempts
  progress: number;

  // Human-readable status for accessibility and tooltips
  statusText: string;

  // How long we've been in this phase (updates on subscription tick)
  phaseElapsedMs: number;

  // Retry context (only meaningful in reconnecting/disconnected)
  retry: {
    attemptNumber: number;
    maxAttempts: number;
    nextRetryMs: number | null;   // null = no more retries
    strategy: 'ice-restart' | 'full-reconnect';
  } | null;

  // Connection quality (only meaningful when connected)
  quality: {
    relayed: boolean;             // using TURN?
    candidateType: 'host' | 'srflx' | 'relay';
    roundTripMs: number | null;   // from ICE candidate pair stats
  } | null;

  // Track state (only meaningful when connected)
  tracks: {
    audioSending: boolean;
    audioReceiving: boolean;
    videoSending: boolean;
    videoReceiving: boolean;
    videoMuted: boolean;          // track arrived but muted, waiting for unmute
  } | null;

  // Is this connection healthy? Composite signal for simple UX
  // true = connected and tracks flowing
  // false = any problem state
  healthy: boolean;
};
```

### Aggregate Store: `ConnectionManagerViewModel`

The `ConnectionManager` exposes an aggregate reactive store for room-level UX:

```typescript
type ConnectionManagerViewModel = {
  // Per-agent view models
  agents: Record<AgentPubKeyB64, ConnectionViewModel>;

  // Room-level summary
  summary: {
    totalPeers: number;
    connectedPeers: number;
    connectingPeers: number;      // signaling + connecting
    troubledPeers: number;        // reconnecting + disconnected + failed
    allHealthy: boolean;          // every connection is healthy
  };
};
```

### How UI Components Subscribe

Using the existing Lit reactive context pattern already in use throughout the app:

```typescript
// Any Lit component can subscribe to per-agent state:
@consume({ context: streamsStoreContext, subscribe: true })
streamsStore!: StreamsStore;

// The ConnectionManager is accessible via StreamsStore:
// this.streamsStore.connectionManager.viewModel  → ConnectionManagerViewModel
// this.streamsStore.connectionManager.getViewModel(agent) → ConnectionViewModel
```

Components re-render automatically when the view model updates. The view model is a plain object — no WebRTC types leak into the UI layer.

### Placeholder UX Concepts

The actual visual design is TBD and should be iterated on. The view model is designed to support all of these patterns without changes to the state machine:

**Per-peer connection indicator (replacing current colored dot):**
- The `phase` + `progress` fields enable a stepped or animated progress indicator rather than a single color dot
- Placeholder: a multi-segment arc or ring around the peer avatar, where segments light up as phases complete (signaling → connecting → connected)
- The `retry` field enables showing "attempt 2/10" or a countdown to next retry
- The `quality` field enables showing relay/direct distinction and latency

**Room-level health bar (new):**
- The `summary` fields enable a compact room-wide indicator
- Placeholder: a subtle bar or badge showing "5/5 connected" or "3/5 connected, 2 reconnecting"
- `allHealthy` enables a simple green/amber binary for the common "is everything working?" question

**Connection timeline (for advanced/debug view):**
- The `phaseElapsedMs` field enables showing how long each phase has taken
- Combined with the FSM transition log, the logs-graph visualization can show the full connection lifecycle
- This is the developer-facing view; the per-peer indicator is the end-user-facing view

**Reconnection feedback (new):**
- When `phase === 'reconnecting'`, the UI can show the retry strategy (`ice-restart` vs `full-reconnect`), attempt count, and countdown to next attempt
- Placeholder: a pulsing or breathing animation on the peer tile with "reconnecting (attempt 2)..." text
- When `nextRetryMs` is null (retries exhausted), show a distinct "connection lost" state with manual retry option

### Implementation Expectations

1. **The view model store is created in Step 2** (FSM implementation) — not deferred to UI integration
2. **The aggregate store is created in Step 4** (ConnectionManager) — available before any UI changes
3. **Step 5** (integration into streams-store) wires the new stores into the existing Lit context, replacing `_connectionStatuses`
4. **UI component updates are a separate task** after the state machine is integrated — the view model contract is stable, so UI iteration doesn't require FSM changes
5. **The existing `agent-connection-status.ts` and `agent-connection-status-icon.ts` components** will be updated to consume `ConnectionViewModel` instead of the old `ConnectionStatus` type, but the visual design can evolve independently after that initial port

---

## Logging Updates

### New Event Types for `logging.ts`

```typescript
// FSM lifecycle events
| 'FSMTransition'           // state A → state B, with trigger reason
| 'FSMTransitionBlocked'    // attempted invalid transition (bug indicator)
| 'FSMTimerStart'           // timeout/retry timer started (which timer, duration)
| 'FSMTimerFire'            // timer fired (which timer)
| 'FSMTimerCancel'          // timer cancelled by state exit (which timer)

// Transport-level events (Layer 2, for debugging)
| 'ICETransportState'       // ICE transport state change
| 'ICEGatheringState'       // ICE gathering state change
| 'ICECandidateLocal'       // local ICE candidate generated (type, protocol, address)
| 'ICECandidateRemote'      // remote ICE candidate received (type, protocol)
| 'DTLSTransportState'      // DTLS transport state change
| 'SignalingState'           // RTCPeerConnection signaling state change
| 'DataChannelState'        // data channel open/close/error

// Negotiation events
| 'NegotiationNeeded'       // negotiationneeded fired
| 'OfferCreated'            // local SDP offer created
| 'AnswerCreated'           // local SDP answer created
| 'OfferCollision'          // glare detected
| 'OfferIgnored'            // impolite peer ignored colliding offer
| 'OfferAccepted'           // polite peer yielded to colliding offer
| 'SDPApplied'              // remote description applied (type)

// Reconnection events
| 'ICERestartInitiated'     // fast-path recovery started
| 'FullReconnectInitiated'  // slow-path recovery started
| 'ReconnectAttempt'        // retry attempt number, delay used
| 'ReconnectSuccess'        // recovery succeeded (which path)
| 'ReconnectFailed'         // recovery exhausted retries
```

### FSM Transition Log Entry

```typescript
type FSMTransitionEntry = {
  timestamp: number;
  connectionId: string;
  remoteAgent: AgentPubKeyB64;
  fromState: ConnectionState;
  toState: ConnectionState;
  trigger: string;           // what caused the transition
  transportSnapshot?: {      // Layer 2 state at transition time
    ice: string;
    dtls: string;
    signaling: string;
    gathering: string;
  };
  metadata?: Record<string, any>;  // trigger-specific data
};
```

### Updates to `logs-graph.ts`

- **New trace row:** FSM state timeline — colored blocks showing time spent in each state
  - Idle: gray, Signaling: light blue, Connecting: yellow, Connected: green, Reconnecting: orange, Disconnected: red, Failed: dark red, Closed: black
- **Transition markers:** Vertical lines at state transitions with trigger labels
- **Blocked transitions:** Red markers with exclamation icon (indicates potential bugs)
- **Timer visualization:** Start→fire or start→cancel arcs
- **Transport state sub-row:** Expandable row showing Layer 2 ICE/DTLS states
- **Collision events:** Special marker when Perfect Negotiation detects and resolves glare
- **Side-by-side merged view:** When diagnostic logs from remote peer are available, show both FSMs for the same connection aligned on the same timeline

### Diagnostic Export Update

The existing `exportMergedLogs()` output gains an `fsmTransitions` array:

```typescript
type MergedDiagnosticExport = {
  // ... existing fields ...
  fsmTransitions: FSMTransitionEntry[];  // chronological, both local and remote
};
```

---

## Testing Strategy

### Unit Tests: `rtc-peer.test.ts`

- ICE config construction (STUN-only, STUN+TURN, custom servers)
- Trickle vs. batch ICE candidate handling
- ICE candidate queuing before remote description is set
- Offer/answer SDP flow with mock RTCPeerConnection
- Track add/remove/replace operations
- Stats collection returns expected shape
- Data channel creation and message passing

### Unit Tests: `peer-connection-fsm.test.ts`

**Valid transitions (from state machine table):**
- Idle → Signaling (connect called)
- Signaling → Connecting (SDP exchange complete)
- Signaling → Closed (close called)
- Connecting → Connected (composite readiness achieved)
- Connecting → Disconnected (timeout)
- Connected → Reconnecting (ICE disruption)
- Connected → Closed (explicit leave)
- Reconnecting → Connected (recovery succeeded)
- Reconnecting → Disconnected (retries exhausted)
- Disconnected → Signaling (retry on next ping)
- Disconnected → Idle (cleanup)
- Failed → Idle (after cleanup timer)

**Invalid transitions (must be blocked and logged):**
- Idle → Connected (skipping negotiation)
- Connecting → Reconnecting (not yet connected)
- Closed → anything (terminal state)
- Failed → Connected (must go through Idle → Signaling)

**Timer tests (with fake timers):**
- Connection timeout fires → Connecting → Disconnected
- SDP exchange timeout fires → log + transition
- Reconnect backoff delays match policy
- Timer cancellation on state exit (no stale timer fires)

**Recovery tests:**
- ICE `disconnected` from Connected → Reconnecting (ICE restart path)
- ICE `failed` from Connected → Reconnecting (ICE restart path)
- DTLS `failed` from Connected → Failed (terminal, no ICE restart)
- ICE restart succeeds → Reconnecting → Connected
- ICE restart fails → full reconnect attempt
- Full reconnect succeeds → Connected
- Full reconnect fails → Disconnected
- Backoff progression: 0ms, 300ms, 1200ms, 2700ms, 4800ms, 7000ms...
- Max retries reached → stop retrying, return null

**Role tests:**
- mesh role adds bidirectional tracks
- sfu-upstream role configures sendonly
- sfu-downstream role configures recvonly

### Unit Tests: `connection-manager.test.ts`

- Signal dispatch routes to correct FSM instance
- `ensureConnection` creates FSM only when none exists for agent
- Duplicate `ensureConnection` calls don't create duplicate FSMs
- Remote signal for unknown agent creates FSM automatically
- Cleanup when FSM reaches Closed (removed from map)
- Cleanup when FSM reaches Failed (scheduled removal)
- Media stream propagation to all Connected FSMs
- Track replacement propagated to all Connected FSMs
- Manager events aggregate FSM events correctly

### Integration Tests: `two-peer-integration.test.ts`

**Test harness:** Two `ConnectionManager` instances connected by a `FakeSignalingChannel`:

```typescript
class FakeSignalingChannel implements SignalingAdapter {
  // In-memory message delivery
  // Configurable: latency, jitter, packet loss, reordering
  // Observable: message log for assertions
}
```

**Scenarios derived from W3C/Pion test suites and known edge cases:**

**Basic connectivity:**
1. Happy path: peer A and B both call ensureConnection → connected on both sides
2. One-sided initiation: only A calls ensureConnection → both still connect (B gets remote offer)
3. Connection with tracks: both sides add audio+video → streams received on both sides

**Glare / simultaneous offers (Perfect Negotiation):**
4. Both peers fire negotiationneeded at the same instant → exactly one connection established
5. Offer collision with polite peer yielding → connection succeeds
6. Offer collision with impolite peer winning → connection succeeds
7. Rapid sequential offers from both sides → converges to single stable connection

**Signal delivery issues:**
8. Signal reordering: answer arrives before offer → queued and applied correctly
9. Signal loss: offer is dropped → timeout → retry → success
10. Signal duplication: same offer delivered twice → idempotent handling
11. ICE candidates arrive before remote description → queued until description is set
12. Stale ICE candidates from previous session after restart → rejected

**Disconnection and recovery:**
13. ICE disconnected → ICE restart → reconnected (fast path)
14. ICE failed → ICE restart → reconnected (fast path)
15. ICE restart fails → full reconnect → connected (slow path)
16. DTLS failed → full reconnect (no ICE restart attempt, DTLS failure is terminal)
17. One-sided failure: A sees disconnect, B doesn't yet → both converge to reconnection
18. Recovery during recovery: new failure while reconnecting → backoff resets

**Cleanup and teardown:**
19. Peer A closes → B receives close → both in Closed/Idle
20. Peer A closes during Signaling → B cleans up
21. Peer A closes during Connecting → B cleans up
22. Destroy while reconnecting → no stale timers fire

**Media management:**
23. Add track after connected → renegotiation → remote receives track
24. Remove track → renegotiation → remote stops receiving
25. Replace track (device switch) → no renegotiation needed, track replaced in-place
26. Track health: stalled bytesReceived → refresh requested via data channel

**Scale / stress:**
27. 6 peers in mesh (each manager has 5 FSMs) → all connections established
28. Peer joins while others are mid-reconnect → new connection unaffected

### Test Framework

Vitest (aligned with Vite build). Add as dev dependency if not already present.

**Test utilities in `test-helpers.ts`:**
- `FakeSignalingChannel` — configurable latency, loss, reordering
- `MockRTCPeerConnection` — minimal mock that emits state changes on command
- `FakeTimers` — wrapper around Vitest's `vi.useFakeTimers()`
- `waitForState(fsm, state, timeout)` — async helper for state assertions
- `createTestPair()` — factory that creates two managers connected by fake signaling

---

## Implementation Order

### Step 1: Test infrastructure + `rtc-peer.ts`
- Set up Vitest if not configured
- Create `test-helpers.ts` with MockRTCPeerConnection and FakeSignalingChannel
- Implement `rtc-peer.ts` — thin RTCPeerConnection wrapper
- Write and pass `rtc-peer.test.ts`
- **No changes to existing code**

### Step 2: `peer-connection-fsm.ts`
- Implement all states and guarded transitions
- Integrate Perfect Negotiation logic
- Integrate `rtc-peer.ts` for WebRTC operations
- Implement reconnection with two-tier strategy
- **Implement `ConnectionViewModel` reactive store** — updated on every transition, computes progress/statusText/retry/quality/tracks/healthy
- Every transition logs unconditionally
- Write and pass `peer-connection-fsm.test.ts` (including view model assertions: correct phase, progress values, statusText, retry state)
- **No changes to existing code**

### Step 3: Update logging infrastructure
- Add new event types to `logging.ts`
- Add FSM transition entry type
- Update `logs-graph.ts` with FSM state timeline trace
- Update diagnostic export format with `fsmTransitions`
- **Backwards compatible** — existing events still work

### Step 4: `connection-manager.ts` + integration tests
- Implement manager that owns FSM instances
- Implement signal dispatch via SignalingAdapter
- Implement media stream propagation
- **Implement `ConnectionManagerViewModel` aggregate store** — derives summary from per-agent view models, updates reactively
- Wire up to logging
- Write and pass `connection-manager.test.ts` (including aggregate view model: summary counts, per-agent access)
- Write and pass `two-peer-integration.test.ts`
- **No changes to existing code**

### Step 5: Integrate into `streams-store.ts` and UI
- Create HolochainSignalingAdapter implementing SignalingAdapter
- Replace `_pendingInits`, `_pendingAccepts`, `_openConnections` with ConnectionManager
- Remove all SimplePeer-specific code
- Remove scattered guard logic (FSM handles it)
- Keep media UI logic (video/audio on/off, device switching) but delegate connection concerns
- **Wire `ConnectionManagerViewModel` into Lit context**, replacing `_connectionStatuses`
- **Update `agent-connection-status.ts` and `agent-connection-status-icon.ts`** to consume `ConnectionViewModel` instead of old `ConnectionStatus` type (initial port — visual design can iterate independently after)
- **Incremental:** video connections first, then screen share connections
- Integration tests serve as regression suite; existing logging for manual E2E

### Step 6: Remove SimplePeer dependency
- Remove `simple-peer` and `@types/simple-peer` from `package.json`
- Clean up any remaining references
- Verify all tests pass

### Step 7: Connection role scaffolding
- Add `ConnectionRole` type (already defined in Step 1 types)
- Thread role through FSM and manager
- All connections default to `mesh`
- Add role-specific tests
- Document SFU integration points for next phase

---

## Risk Mitigation

- **Steps 1-4 are purely additive** — new files, no changes to existing code. Can be developed and tested in isolation.
- **Step 5 is the only destructive refactor** — done incrementally (video first, then screen share). Can be partially reverted.
- **Integration tests (Step 4) must pass before Step 5 begins** — they validate the new system works correctly in isolation.
- **Logging is updated before integration (Step 3)** — debugging tools are ready before the refactor starts.
- **Feature parity validation** — existing diagnostic export + new FSM logging allows before/after comparison.
- **SimplePeer removal (Step 6) is separate from integration (Step 5)** — both paths can coexist temporarily if needed.
- **Perfect Negotiation is a W3C-recommended pattern** — well-tested across browsers, not a novel invention.
