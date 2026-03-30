# WebRTC State Machine: Bug Fixing Transcript

**Date:** 2026-03-28 to 2026-03-29
**Context:** First live testing of the new WebRTC connection state machine (replacing SimplePeer) in a 2-3 peer localhost environment via hc-spin.

---

## Bug 1: Video not established on first connection

**Evidence (Log 1):** First connection established in 67ms (`idle → signaling → connecting → connected`), but video was turned on 348ms AFTER connection was already established. No `RemoteTrack` or `StreamReceived` events for the first connection. Subsequent reconnections that worked had `"addStream on-connect: 2 tracks"` logs — the first did not.

**Root Cause:** `_addLocalStream()` in `peer-connection-fsm.ts` called `peer.addTrack()` for ALL tracks in the stream. When `videoOn()` was called after connection, it called `connectionManager.updateLocalStream(mainStream)` which tried to re-add the audio track (already added) AND the new video track. Adding an already-added track throws `InvalidAccessError`, which prevented the video track from being added.

**Fix:** Added duplicate track detection in `_addLocalStream()` — check existing sender track IDs before calling `addTrack()`, skip tracks already on a sender. Added try-catch per track so one failure doesn't block others.

**File:** `ui/src/connection/peer-connection-fsm.ts`

---

## Bug 2: Two of three peers can't connect to each other

**Evidence (Log 2):** In a 3-peer session, peers uhCAkFPt and uhCAkYb6 both connected to us fine, but reported each other as `SdpExchange` (= `connecting`) → `Disconnected`. SDP exchange completed on both sides but ICE never connected.

**Initial speculation:** Holochain signal delivery issue. **User correction:** "I don't believe that Holochain signals aren't arriving. That sounds like speculation. Your instructions say to be data driven and use evidence." — We had no visibility into ICE candidate exchange between those peers (only had our own logs).

**Action taken:** Added ICE candidate counters (`_localCandidateCount`, `_remoteCandidateCount`) to FSM logging, so ICE state changes now log `"ICE: checking (local=3 remote=2)"`. This provides evidence for future diagnosis.

**Additional fix (preventive):** Identified that during simultaneous offer (glare) resolution, stale ICE candidates from the rolled-back offer could pollute the new session:
- Polite peer: `_pendingCandidates` cleared on rollback
- Impolite peer: candidates ignored while `_ignoreOffer` is true

**Files:** `ui/src/connection/peer-connection-fsm.ts`, `ui/src/connection/rtc-peer.ts`

---

## Bug 3: Manual disconnect + reconnect fails (no leave signal)

**Evidence (Log 5):** User manually disconnected from a peer, then reconnected. Our FSM went `connected → closed → idle → signaling` but never progressed past signaling. Meanwhile, the remote peer still reported us as `Connected` for ~6 seconds before noticing. When they finally processed our new offer, they were in `SdpExchange` — but our FSM was stuck in signaling, meaning their answer never reached us or was rejected.

**Root Cause:** `ConnectionManager.closeConnection()` destroyed the local FSM but **never sent a leave signal** to the remote peer. The remote peer's old FSM stayed in `connected` state. When we sent a new offer from a new FSM, it was routed to the remote's OLD FSM (still `connected`), causing SDP session mismatch.

**Fix:**
1. `closeConnection()` now sends a `leave` signal before closing the FSM
2. `_routeSignalToFSM()` replaces `closed` FSMs when a new signal arrives (handles case where leave signal was lost)

**File:** `ui/src/connection/connection-manager.ts`

---

## Bug 4: Renegotiation offers destroy working connections

**Evidence (Log 6):** Peer B's FSM had FOUR different connectionIds in 67 seconds. Each time a peer added a track (turned on video), the connection was torn down and recreated. Track accumulation: `1 track → 2 tracks → 3 tracks`. All connections showed `connected`, but video showed black.

**Root Cause:** The fix for Bug 3 was too aggressive. `_routeSignalToFSM()` replaced the FSM whenever an offer arrived at a `connected` FSM. But WebRTC renegotiation (adding tracks) naturally sends offers within an existing connection — Perfect Negotiation handles this. The code was treating renegotiation offers as "new connection" offers.

**Fix:** Reverted the aggressive FSM replacement. Only replace `closed` FSMs, not `connected` ones. Renegotiation offers flow through to the existing RTCPeer's Perfect Negotiation handler.

**File:** `ui/src/connection/connection-manager.ts`

---

## Bug 5: SDP state corruption — "Called in wrong state: have-remote-offer"

**Evidence (Log 7):** Chrome console flooded with `sdp_offer_answer.cc(955) Failed to set remote answer sdp: Called in wrong state: have-remote-offer`. Track accumulation continued: `2 tracks → 3 tracks → 4 tracks`.

**Root Cause:** `handleSignal()` and the `negotiationneeded` event handler were both async and could interleave. When a peer added a track, `negotiationneeded` fired from the browser event loop, calling `setLocalDescription()` (async). Before it completed, an incoming signal arrived and called `setRemoteDescription()`. Both operations fought over the signaling state machine.

**Fix:** Created a unified task queue in `RTCPeer` that serializes ALL signaling operations — both incoming signals (`handleSignal`) and outgoing offers (`negotiationneeded`). Tasks are enqueued and drained serially. No two `setLocalDescription`/`setRemoteDescription` calls can overlap.

**File:** `ui/src/connection/rtc-peer.ts`

---

## Bug 6: Track accumulation on video toggle

**Evidence (Log 8):** After fixing SDP errors, connections stayed stable (single connectionId). But toggling video off/on caused track accumulation: `1 tracks [video] → 2 tracks [video, video] → 3 tracks [video, video, video]`.

**Root Cause:** `videoOff()` called `track.stop()` which destroyed the track, but the RTCRtpTransceiver persisted (WebRTC transceivers can't be removed). `videoOn()` got a new track from `getUserMedia()` with a new ID and called `addTrack()`, creating a NEW transceiver instead of reusing the existing one.

**Fix:** `_addLocalStream()` now checks for existing senders with null/ended tracks of the same kind. If found, uses `replaceTrack()` to reuse the transceiver instead of `addTrack()`.

**File:** `ui/src/connection/peer-connection-fsm.ts`

---

## Bug 7: Camera permission prompt on every video toggle

**Evidence:** User reported that in the old version, camera permission was granted once permanently. Now the Weave launcher prompted "A Tool wants to access the following: camera" on every video on/off cycle.

**Root Cause:** `videoOff()` called `track.stop()` which released the camera device. `videoOn()` then called `getUserMedia()` again, triggering the permission prompt. The old code had the same `track.stop()` call, but the Weave launcher may have changed its caching behavior.

**Fix:** Changed `videoOff()` to disable the track (`track.enabled = false`) instead of stopping it. The camera stays allocated but stops sending frames. `videoOn()` now hits CASE A (track still exists, just re-enable it) instead of CASE B (call `getUserMedia()`). This matches Zoom/Meet/Teams behavior.

**Additional fix:** CASE A wasn't firing the `my-video-on` event callback, so the UI didn't update. Added the callback.

**File:** `ui/src/streams-store.ts`

---

## Bug 8: No retry after connection timeout

**Evidence (Log 9):** After a peer left and rejoined, the new connection reached `connecting` with ICE candidates (`local=2 remote=3`) but timed out after 15 seconds. No further retry attempts occurred.

**Root Cause:** In `handlePongUi()`, the condition for calling `ensureConnection()` excluded states that were "active": `alreadyOpen !== 'closed' && alreadyOpen !== 'failed' && alreadyOpen !== 'idle'`. The `disconnected` state was not excluded, so it was treated as "active" — `ensureConnection()` was never called to retry.

**Fix:** Added `alreadyOpen !== 'disconnected'` to the exclusion list so the pong cycle retries connections that timed out.

**File:** `ui/src/streams-store.ts`

---

## Process Observations

1. **Log-driven debugging was essential.** Every bug was diagnosed from JSON diagnostic logs, not from reading code. The FSM transition logging and ICE candidate counters provided the evidence needed.

2. **Each fix introduced the next bug.** Bug 3's fix (replace FSMs on incoming offers) caused Bug 4 (renegotiation offers destroy connections). Bug 4's fix (don't replace connected FSMs) was correct but required Bug 5's fix (serialize signaling). This chain suggests the initial integration was missing important invariants.

3. **The test suite didn't catch these bugs** because `MockRTCPeerConnection` doesn't simulate real ICE candidate generation, concurrent `negotiationneeded` events, or signal delivery timing. The research had identified the right scenarios (glare, ICE restart, renegotiation) but the mock fidelity was too low to exercise them.

4. **User pushed back on speculation.** When I blamed Holochain signal delivery without evidence, the user correctly demanded data. This led to adding ICE candidate counters, which proved valuable for all subsequent debugging.

5. **The "disable instead of stop" pattern** (Bug 7) is a UX design decision, not just a bug fix. It trades camera LED staying on for better user experience (no permission re-prompts, no renegotiation, no track accumulation).

6. **State machine transition table gaps** showed up in practice. `connected → failed` wasn't initially allowed (Bug in early testing). `disconnected` wasn't treated correctly in the pong handler (Bug 8). The transition table needs to be validated against all the signal handler paths, not just the FSM in isolation.
