# Stale Signal Poisoning: Root Cause Analysis

**Date:** 2026-03-30
**Status:** Open — needs proper implementation

---

## Problem

Connections frequently fail to reach `connected` state despite ICE reporting `connected`. The FSM stays in `connecting` for 15 seconds then times out. The data channel never opens. This happens most often on the second or third connection attempt between the same peers.

## Evidence

Across multiple log sessions, the pattern is consistent:

1. **Inflated candidate counts** — On localhost, a clean connection shows `local=1-2 remote=1-2`. Failed connections show `local=3-8 remote=4-8`, indicating candidates from previous sessions are being mixed in.

2. **ICE connected but no composite readiness** — ICE finds a candidate pair, but DTLS handshake or data channel setup fails silently. The FSM never transitions from `connecting` to `connected`.

3. **Chrome SDP errors** — `"Failed to set remote answer sdp: Called in wrong state: stable"` appears in console, indicating stale answers arriving after the signaling exchange completed.

4. **Repeated connection cycling** — Sessions show 3-5 connection attempts (`signaling → connecting → disconnected → signaling → ...`) before one succeeds, each accumulating more stale candidates.

## Root Cause

When a peer disconnects and reconnects, the old connection's signals (offers, answers, ICE candidates) are still in-flight through Holochain's remote signal system. These arrive at the new RTCPeerConnection and corrupt its state:

- **Stale answers** arriving at `stable` signaling state — caught and ignored by the try-catch we added, but the renegotiation they belonged to is lost.
- **Stale ICE candidates** with wrong ufrag/pwd — Chrome's ICE agent may reject these silently, but the count inflation suggests some are being applied, potentially interfering with DTLS.
- **Stale offers** causing unnecessary renegotiation cycles.

The `connectionId` is already present on every `SignalMessage` (set by the sender's FSM). But `_routeSignalToFSM` ignores it — it routes solely by agent pubkey. The connectionId on the incoming signal is never compared against the current FSM's connectionId.

## Why Previous Fixes Were Insufficient

1. **Task queue serialization** (Bug 5 fix) — Prevents concurrent `setLocalDescription`/`setRemoteDescription` within a single RTCPeerConnection. Does not prevent stale signals from previous RTCPeerConnections.

2. **Stale answer catch** — Catches the Chrome error but silently swallows it. The renegotiation that the answer belonged to (e.g., for adding a video track) is lost. The `request-track-refresh` fallback helps but adds latency and complexity.

3. **Candidate queue clearing on rollback** — Only clears candidates queued before remote description. Does not filter candidates arriving after the rollback from the old session.

4. **`_ignoreOffer` flag** — Only active during a single collision resolution. Resets when the next non-colliding description arrives, at which point stale candidates flow through again.

## Proposed Fix: Connection-Scoped Signal Filtering

### Design

Every signal carries the sender's `connectionId`. The receiving side should only accept signals whose connectionId matches either:
- **Its own FSM's connectionId** (for signals related to our offer), OR
- **A connectionId from the current SDP session** (for signals related to the remote's offer)

Since each side generates its own connectionId independently, we need a handshake to associate them:

1. When FSM A sends an offer to FSM B, the offer signal carries A's connectionId.
2. When FSM B receives the offer and creates an answer, B should remember A's connectionId as the "remote connectionId" for this session.
3. Subsequent candidates from A should carry A's connectionId. B accepts them only if they match the remembered remote connectionId.
4. If A disconnects and reconnects with a new connectionId, stale signals carrying the old connectionId are dropped.

### Implementation Steps

1. **Add `remoteConnectionId` tracking to RTCPeer or PeerConnectionFSM:**
   - When we receive and accept an offer, store the connectionId from the signal as `remoteConnectionId`.
   - When we receive and accept an answer, store the connectionId from the signal as `remoteConnectionId`.
   - Reset `remoteConnectionId` when creating a new RTCPeerConnection.

2. **Filter in `_routeSignalToFSM`:**
   - For `offer` signals: always accept (they establish a new session). Update `remoteConnectionId`.
   - For `answer` signals: accept only if the signal's connectionId matches `remoteConnectionId` or the FSM's own connectionId.
   - For `candidate` signals: accept only if the signal's connectionId matches `remoteConnectionId` or the FSM's own connectionId.
   - Drop all others silently.

3. **Ensure connectionId is propagated correctly:**
   - The `HolochainSignalingAdapter.sendSignal()` includes `connectionId` in the payload.
   - The `_handleIncomingSignal` passes `message.connectionId` through to the FSM.
   - The FSM needs access to the connectionId on each signal to compare.

### Alternative Approach: Timestamp-Based Filtering

Instead of connectionId matching, each signal could carry a monotonic session counter. The FSM increments a counter each time it creates a new RTCPeerConnection. Signals with a counter less than the current counter are dropped. Simpler but requires synchronized counters.

### Alternative Approach: SDP ufrag Matching

Extract the ufrag from the SDP offer/answer and use it to tag subsequent ICE candidates. Only accept candidates whose ufrag matches the current session's ufrag. This is what the browser's ICE agent should do internally, but it appears to not be fully effective in all cases.

## Temporary Mitigations In Place

- Stale answers caught and silently ignored (prevents Chrome errors but loses renegotiation)
- `request-track-refresh` sent when `video-on` data channel message arrives without a corresponding RemoteTrack
- CASE A `videoOn()` calls `updateLocalStream` to retry track delivery

## Files Involved

- `ui/src/connection/connection-manager.ts` — `_routeSignalToFSM` needs connectionId filtering
- `ui/src/connection/peer-connection-fsm.ts` — needs `remoteConnectionId` tracking
- `ui/src/connection/rtc-peer.ts` — stale answer catch, candidate handling
- `ui/src/connection/holochain-signaling-adapter.ts` — connectionId is already in the signal payload
- `ui/src/connection/types.ts` — `SignalMessage` already has `connectionId` field
