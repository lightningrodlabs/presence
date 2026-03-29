# WebRTC Connection State Machine: Research Analysis

**Date:** 2026-03-28
**Purpose:** Research findings informing the design of a proper WebRTC connection state machine to replace SimplePeer and ad-hoc connection management in Presence.

---

## 1. W3C/IETF Defined State Machines

The WebRTC specs define **6 interrelated state machines**, not one. Any application-level state machine must be designed in relationship to these.

### 1A. RTCSignalingState (RFC 9429, Section 3.2)

**States:** `stable`, `have-local-offer`, `have-remote-offer`, `have-local-pranswer`, `have-remote-pranswer`, `closed`

| From State | Action | To State |
|---|---|---|
| `stable` | `setLocalDescription(offer)` | `have-local-offer` |
| `stable` | `setRemoteDescription(offer)` | `have-remote-offer` |
| `have-local-offer` | `setRemoteDescription(pranswer)` | `have-remote-pranswer` |
| `have-local-offer` | `setRemoteDescription(answer)` | `stable` |
| `have-remote-offer` | `setLocalDescription(pranswer)` | `have-local-pranswer` |
| `have-remote-offer` | `setLocalDescription(answer)` | `stable` |
| `have-local-pranswer` | `setLocal(answer)` | `stable` |
| `have-remote-pranswer` | `setRemote(answer)` | `stable` |
| Any state | `close()` | `closed` |

Rollback is valid only from `have-local-offer`, `have-remote-offer`, `have-local-pranswer`, or `have-remote-pranswer`.

### 1B. RTCIceTransportState (W3C WebRTC API Spec, Section 5.6)

**States:** `new`, `checking`, `connected`, `completed`, `disconnected`, `failed`, `closed`

**Transitions (including back-edges):**
- `new` → `checking` (checks begin)
- `checking` → `connected` (viable pair found)
- `connected` → `completed` (final pair confirmed, gathering done)
- `connected` → `disconnected` (transient network interruption)
- `connected` → `checking` (consent revoked on active pair)
- `completed` → `checking` (ICE restart triggered)
- `disconnected` → `checking` (recovery attempts or new pairs)
- `disconnected` → `connected` (recovery succeeds)
- `checking`/`connected`/`completed` → `failed` (exhaustion or timeout)
- Any state → `closed`

### 1C. RTCIceGatheringState

**States:** `new`, `gathering`, `complete`

- `new` → `gathering` (gathering begins)
- `gathering` → `complete` (gathering finishes)
- `complete` → `gathering` (ICE restart or new network interfaces)

### 1D. RTCPeerConnectionState (Aggregate)

Combines ICE + DTLS using **worst-case-wins** precedence (first matching rule wins):

| State | Derivation Rule |
|---|---|
| `closed` | `isClosed` is true |
| `failed` | Any ICE transport `failed` OR any DTLS transport `failed` |
| `disconnected` | Any ICE transport `disconnected` AND none `failed`/`connecting`/`checking` |
| `new` | All transports `new`/`closed` or none exist |
| `connecting` | Any transport `new`/`checking`/`connecting` |
| `connected` | All transports `connected`/`completed`/`closed` |

### 1E. RTCDtlsTransportState

**States:** `new`, `connecting`, `connected`, `failed`, `closed`

**Critical:** DTLS has **no recovery path** from `failed`. Once failed, the transport is done. Only ICE `failed` can be recovered via ICE restart.

### 1F. ICE Candidate Pair States (RFC 8445, Section 6.1.2.6)

**States:** `Frozen`, `Waiting`, `In-Progress`, `Succeeded`, `Failed`

### 1G. ICE Role Conflict Resolution (RFC 8445, Section 7.3.1.1)

Each agent carries a 64-bit random tiebreaker. If a 487 (Role Conflict) error response is received, agents swap controlling/controlled roles.

---

## 2. Perfect Negotiation Pattern (W3C/MDN Recommended)

The canonical solution for glare (simultaneous offers) in P2P WebRTC.

**Roles:** Each peer is assigned **polite** (yields on collision) or **impolite** (wins on collision). Deterministic assignment via agent ID comparison (lower = polite).

**State tracking (3 booleans):**
- `makingOffer` — true during `setLocalDescription` call
- `ignoreOffer` — true when impolite peer should discard incoming offer
- `isSettingRemoteAnswerPending` — prevents race during `setRemoteDescription`

**Collision detection:**
```javascript
const readyForOffer = !makingOffer && (pc.signalingState === "stable" || isSettingRemoteAnswerPending);
const offerCollision = description.type === "offer" && !readyForOffer;
ignoreOffer = !polite && offerCollision;
```

**Key advantage:** Same code runs on both sides. Eliminates separate initiator/responder paths. Replaces the custom InitRequest/InitAccept handshake currently in Presence.

---

## 3. Existing Implementation Analysis

### LiveKit (client-sdk-js) — Apache 2.0

**States (two layers):**
- Room: `Disconnected`, `Connecting`, `Connected`, `Reconnecting`, `SignalReconnecting`
- Engine: `New`, `Connected`, `Disconnected`, `Reconnecting`, `Closed`

**Key patterns:**
- **Two-tier reconnection:** ICE restart (fast, preserves state) → full rejoin (slow, clean slate)
- **Signal vs media separation:** `SignalReconnecting` as distinct state — signal channel can fail independently from media
- **Pluggable retry policy:** `ReconnectPolicy` interface with `nextRetryDelayInMs(context)` returning delay or null
- **Default backoff:** Quadratic `[0, 300, 1200, 2700, 4800, 7000, 7000...]` with 0-1000ms random jitter after attempt 2

**Reusability:** Patterns are excellent; code is tightly coupled to LiveKit server protocol.

### Matrix/Element (matrix-js-sdk) — Apache 2.0

**States:** `Fledgling`, `WaitLocalMedia`, `CreateOffer`, `InviteSent`, `CreateAnswer`, `Ringing`, `Connecting`, `Connected`, `Ended`

**Key pattern:** Explicit pre-connection states give debugging visibility into where connections stall.

**Reconnection:** Single ICE restart attempt, 30s hard timeout. No backoff.

### mediasoup-client — ISC

**States:** Mirrors browser's `RTCPeerConnection.connectionState` 1:1.

**Key pattern:** Trust the browser for transport states. Don't re-implement them. Build application states on top.

### Pion WebRTC (Go) — MIT

**Key pattern:** Faithful implementation of W3C worst-case-wins aggregation algorithm for deriving connection state from transport states. Idempotency check prevents redundant state change callbacks.

### simple-peer — MIT

**No formal state machine.** Uses boolean flags: `_connected`, `_pcReady`, `_channelReady`, `destroyed`, `destroying`.

**Key patterns:**
- **Composite readiness:** `_maybeReady()` fires only when ALL conditions met (pcReady AND channelReady)
- **Negotiation batching:** Microtask coalescing prevents redundant offer/answer cycles
- **Terminal flag:** Separate `destroying` from `destroyed` to handle teardown races
- **No recovery:** On failure, destroy and recreate. Application handles reconnection.

### PeerJS — MIT

No formal state machine. Their issue tracker demonstrates the cost of skipping one: "connection drops immediately," "open event never fires," "cannot signal after peer is destroyed."

---

## 4. Canonical Test Scenarios

### W3C web-platform-tests (wpt/webrtc/) — 184+ tests

**Signaling state:** All transitions for offer, answer, pranswer, rollback (6+ test files, 30+ individual cases).

**Rollback:** 14 scenarios including rollback-from-stable (rejected), rollback-survives-re-offer, onremovetrack during rollback, implicit rollback with data channels.

**ICE restart (restartIce.html):** 15 scenarios:
1. No effect on closed PC
2. No effect ahead of initial negotiation
3. No effect on initial negotiation itself
4. Fires `negotiationneeded` after initial negotiation
5. Causes fresh ufrags
6. Retains DTLS transports
7. Works in `have-local-offer`
8. Works in initial `have-local-offer`
9. Works in `have-remote-offer`
10. No effect in initial `have-remote-offer`
11. Survives remote offer
12. Satisfied by remote ICE restart
13. Trumps `{iceRestart: false}`
14. Survives rollback
15. Survives remote offer containing partial restart

**ICE connection state (iceConnectionState.html):** 12 scenarios including per-bundle-policy behavior.

**Connection state (connectionState.html):** 8 scenarios including adding datachannel to unbundled connected PC.

### Pion renegotiation tests

12 integration tests including: add/remove tracks, role switching (answerer becomes offerer), trickle ICE timing, codec changes, simultaneous data channel + media, 500-track stress test.

### Application-level test scenarios (our own)

Informed by RFC edge cases and signal delivery concerns:
- Signal reordering, loss, duplication
- One-sided failure (asymmetric ICE state)
- TURN fallback timing
- Concurrent connection attempts (Perfect Negotiation collision)
- Recovery path selection (ICE restart vs. full reconnect)
- Trickle ICE candidates arriving before remote description
- Candidates from previous ICE session after restart (must be ignored)

---

## 5. Known Edge Cases

### Glare / Simultaneous Offer
Both peers create offers simultaneously. Perfect Negotiation resolves via polite/impolite roles.

### ICE Restart Recovery
- Works in ~2/3 of cases empirically
- In 85% of failures, no answer arrives (remote peer likely offline)
- Simultaneous ICE restart: polite peer must rollback its offer and accept the other's
- Partial restart (one media section only) must be handled

### Trickle ICE Timing (RFC 8838)
- Candidates must be delivered exactly once, in order
- Must be correlated to correct ICE session (reject stale candidates after restart)
- `end-of-candidates` indication required
- Remote candidates may arrive before `setRemoteDescription` completes — must queue

### NAT Traversal Failures
- Symmetric NAT: STUN fails, requires TURN
- Double symmetric NAT: only TURN works
- Candidate priority: host > srflx > relay

### DTLS Terminal Failure
DTLS `failed` has NO recovery path. ICE restart preserves DTLS transports but cannot recover a failed DTLS handshake. Full reconnect is the only option.

### Browser Differences
- Safari: H.264 only, limited Insertable Streams
- iOS: all browsers inherit Safari WebRTC limitations
- Firefox: doesn't honor vEthernet candidates; different autoplay policies

---

## 6. Build vs. Reuse Assessment

**No existing implementation is both:**
- (a) Decoupled from a specific server/signaling protocol, AND
- (b) Designed for P2P mesh with future SFU role flexibility

**What to take from each:**

| Source | Pattern to Adopt |
|---|---|
| LiveKit | Two-tier reconnect (ICE restart → full reconnect); pluggable retry policy with quadratic backoff + jitter; signal vs media state separation |
| W3C/MDN | Perfect Negotiation pattern replacing custom init/accept handshake |
| simple-peer | Composite readiness (`_maybeReady()`); negotiation batching; terminal flag pattern |
| Pion | Worst-case-wins aggregation for deriving app state from transport states |
| Matrix | Explicit pre-connection states for debugging visibility |
| mediasoup | Trust the browser for transport states; build application states on top |

---

## 7. Key RFC References

| Topic | Document | Section |
|---|---|---|
| Signaling state machine | RFC 9429 | Section 3.2 |
| Glare is app responsibility | RFC 9429 | Section 3.1 |
| Candidate pair states | RFC 8445 | Section 6.1.2.6 |
| Checklist states | RFC 8445 | Section 6.1.2.1 |
| ICE agent state | RFC 8445 | Section 6.1.3 |
| Role conflict resolution | RFC 8445 | Section 7.3.1.1 |
| Nomination (regular only) | RFC 8445 | Section 8 |
| Trickle ICE | RFC 8838 | Sections 4-16 |
| ICE PAC (Patiently Awaiting) | RFC 8863 | Full document |
| RTCSignalingState | W3C WebRTC API | Section 4.4.1.5 |
| RTCIceConnectionState | W3C WebRTC API | Section 4.4.1.6 |
| RTCPeerConnectionState | W3C WebRTC API | Section 4.4.3 |
| RTCDtlsTransportState | W3C WebRTC API | Section 5.5 |
| RTCIceTransportState | W3C WebRTC API | Section 5.6 |

## 8. Source Links

- [RFC 9429 (JSEP, obsoletes 8829)](https://datatracker.ietf.org/doc/rfc9429/)
- [RFC 8445 (ICE)](https://datatracker.ietf.org/doc/html/rfc8445)
- [RFC 8838 (Trickle ICE)](https://datatracker.ietf.org/doc/rfc8838/)
- [RFC 8863 (ICE PAC)](https://datatracker.ietf.org/doc/html/rfc8863)
- [W3C WebRTC API Spec](https://www.w3.org/TR/webrtc/)
- [MDN Perfect Negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
- [WPT WebRTC Tests](https://github.com/web-platform-tests/wpt/tree/master/webrtc)
- [Pion WebRTC](https://github.com/pion/webrtc)
- [LiveKit client-sdk-js](https://github.com/livekit/client-sdk-js)
- [Matrix call.ts](https://github.com/matrix-org/matrix-js-sdk/blob/develop/src/webrtc/call.ts)
- [mediasoup-client](https://github.com/versatica/mediasoup-client/blob/v3/src/Transport.ts)
- [simple-peer](https://github.com/feross/simple-peer)
- [Understanding WebRTC State Machines (Vacca)](https://www.giacomovacca.com/2026/02/understanding-webrtc-state-machines.html)
