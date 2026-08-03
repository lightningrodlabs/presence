# WebRTC Carrier Analysis — Best Practices vs Our Two Carriers

**Status: HISTORICAL (2026-08-03).** One of the two carriers this document compares no longer exists: `SimplePeerTransport` was deleted in Phase 3 (`MAINTAINABILITY_ASSESSMENT.md`), and the FSM is the only WebRTC carrier. The analysis was verified sound by the 2026-07 assessment and is kept for its best-practices evidence and the signals-vs-WebRTC framing; every SimplePeer-side observation is now archaeology.

Written 2026-05-11. Comparison of `SimplePeerTransport` and `FsmTransport` against
industry-recommended WebRTC patterns, framed by the project goal: **non-TURN
P2P connectivity in marginal NAT conditions on Electron**.

## 1. Best practices found in the industry

### Perfect Negotiation
MDN's recommended pattern. Symmetric code on both sides, polite/impolite role
assignment determined by some stable ordering (here: agent-ID lexicographic
compare). On offer collision ("glare") the polite peer rolls back and processes
the incoming offer. Eliminates the asymmetric caller/callee race conditions
that surface during reconnect storms.

- MDN: <https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation>
- Mozilla blog: <https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/>

### ICE restart on `disconnected`, not on `failed`
Trigger `RTCPeerConnection.restartIce()` ~3–4 seconds after
`iceConnectionState='disconnected'`. Waiting for `failed` costs ~30s of dead
audio. ICE restart preserves DTLS keys and SRTP state and is cheap. Full
tear-down/recreate is expensive and should only be the second-line response
to repeated ICE-restart failure or DTLS death.

- BlogGeek.me: <https://bloggeek.me/webrtcglossary/ice-restart/>
- MDN: <https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce>

### Bounded backoff with jitter
Reconnect storms on hostile networks (Starlink, CGNAT, cellular handoff) are a
known failure mode. Quadratic or exponential backoff with jitter is the
standard mitigation; it prevents saturating both the signaling channel and the
TURN allocation.

### TURN is mandatory, not optional
~8–15% of real-world users sit behind symmetric NAT or CGNAT where STUN cannot
work. Mobile carrier networks deploy CGNAT widely; symmetric NAT is common in
corporate and consumer routers. STUN is the optimization; TURN is the
correctness floor.

- LiveSwitch: <https://www.liveswitch.io/blog/webrtc-nat-traversal-methods-a-case-for-embedded-turn>
- webrtcHacks symmetric-NAT diagnostic: <https://webrtchacks.com/symmetric-nat/>

### Electron-specific gotchas
- **Stale IP cache on interface change.** Electron's Chromium can hold cached
  IPs after Wi-Fi/VPN flaps; ICE binds to obsolete addresses until process
  restart. (simple-peer #382)
- **ICE gathering delays of 30–40s** observed in Electron + simple-peer
  combinations. Library appears sensitive to Electron's host enumeration.
- **PeerConnection leak in Chromium** (simple-peer #787): long-running sessions
  accumulate un-GC'd `RTCPeerConnection` objects until "Cannot create so many
  PeerConnections" breaks the app. Serious risk for a presence app rotating
  many peers over hours.
- **simple-peer is effectively unmaintained.** No significant releases in
  years; the native API has gained features (explicit `restartIce()`,
  ICE-controlling role hints) that wrappers don't expose cleanly.

## 2. Mapping the two carriers against the best-practice checklist

| Best-practice property | SimplePeer carrier | FSM carrier |
|---|---|---|
| Perfect Negotiation (polite/impolite, glare handling) | No — simple-peer's caller/callee model | Yes — polite/impolite by agent-ID ordering (`peer-connection-fsm.ts:40`) |
| ICE restart on `disconnected` (not `failed`) | Partial — 5s grace then `restartIce()`, but library still destroys on `failed` | Yes — explicit state, restart-first policy (`reconnect-policy.ts`) |
| Bounded backoff with jitter | No — no backoff | Yes — quadratic + jitter |
| Session ID for stale-signal rejection | No — `connectionId` only | Yes — `peerSessionId` monotonic, blocks cross-session offer/answer pollution (`fsm-transport.ts:100`) |
| DTLS stuck-handshake detection | No | Yes — watchdog + composite-readiness gating |
| Library risk (PC leaks, abandoned) | High | None (direct RTCPeerConnection) |
| Debuggability of state | Opaque library state | Named FSM phases |
| Code maturity | Battle-tested library | Newer, 149 unit tests |

## 3. From first principles: which is more robust on marginal links?

Marginal NAT scenarios produce specific, predictable failure shapes that the
FSM is structurally better equipped to handle:

1. **Glare under retries.** Marginal networks cause both sides to retry
   simultaneously. Without Perfect Negotiation, simultaneous offers deadlock
   or oscillate. The FSM resolves this deterministically via the
   polite/impolite role assigned by agent ID.

2. **Stale-signal poisoning.** When Electron's interface flaps the peer often
   re-fires the whole signaling sequence while old SDP is still in-flight on
   Holochain's remote-signal channel. SimplePeer's `connectionId`-only
   filtering accepts a late offer from a prior attempt and corrupts the new
   connection. The FSM's `peerSessionId` makes stale signals provably
   distinguishable.

3. **Reconnect storms on Starlink/CGNAT.** ICE failure rates spike to 30–50%
   on these networks. With no backoff, SimplePeer's tear-down/recreate loop
   saturates the signaling channel and TURN allocation. FSM's quadratic
   backoff is the textbook fix.

4. **DTLS stalls.** On hostile NATs ICE sometimes succeeds (candidate pair
   nominated) but DTLS gets dropped by a middlebox. SimplePeer never observes
   this directly; it sits in "connected" with no media. The FSM's DTLS
   watchdog escalates to a full reconnect — which is exactly when full
   reconnect is justified.

5. **Long-session leak risk.** A 4-hour Presence call cycling through 6 peers
   with retries can easily provoke the Chromium PC-leak bug under SimplePeer.
   Direct `RTCPeerConnection` use in the FSM is not immune, but the lifecycle
   is explicit and disposable.

### Counter-evidence
- FSM has fewer real-world hours. SimplePeer is boring and well-trodden — for
  *easy* networks it's likely to be more reliable simply because its bugs are
  known.
- FSM's reconnect latency (backoff means slower recovery on transient blips)
  is a real cost. On a good network SimplePeer's instant-recreate will look
  faster.

## 4. Decisions taken

### Inverted tiebreaker
In `resolveWebrtcImpl`, when both sides have disagreeing overrides the
tiebreaker is now **FSM**, not SimplePeer. Rationale: the auto-flip exists
to escape a stuck link; if the per-peer state has converged on disagreement
it is more likely to recover under the carrier with the better marginal-NAT
machinery.

### Latency instrumentation
A new `IceEstablishment` SimpleEvent type records, per (peer, connectionId,
impl), the milestone latencies from first signaling to ICE-connected and to
transport-connected. Emitted at the existing `phase='connected'` dispatch
point so both carriers contribute through the same funnel. Detail string
format: `impl=<simplepeer|fsm> ice=<ms> gather=<ms> connect=<ms> relay=<bool>`.
On close before connect a complementary `IceNeverConnected` event captures
the partial timings and the final ICE state.

These events flow through the same `logger.logAgentEvent` path as everything
else, so they appear in the merged-log download added in commit `2e74d8a`.

## 5. Validation plan

The first-principles claim is testable. On a flaky link the FSM should
produce a measurably higher rate of `srflx`/`host` candidate-pair nomination
(non-TURN success) and lower median `ice` latency than SimplePeer over a
multi-session sample. The new instrumentation gives the substrate to check
this. If the data does not support the claim, the inverted tiebreaker should
be reverted.

## Sources

- [MDN — Perfect Negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
- [MDN — Lifetime of a WebRTC session](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Session_lifetime)
- [BlogGeek.me — ICE restart in WebRTC](https://bloggeek.me/webrtcglossary/ice-restart/)
- [Mozilla blog — Perfect negotiation in WebRTC](https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/)
- [simple-peer #787 — RTC peers not garbage collected on Chromium](https://github.com/feross/simple-peer/issues/787)
- [simple-peer #382 — ICE gathering 40s in Electron](https://github.com/feross/simple-peer/issues/382)
- [webrtcHacks — Am I behind a Symmetric NAT?](https://webrtchacks.com/symmetric-nat/)
- [RTC Insights — Why your ICE connection fails](https://www.rtcinsights.com/blog/ice-connection-failures/)
- [LiveSwitch — WebRTC NAT traversal methods](https://www.liveswitch.io/blog/webrtc-nat-traversal-methods-a-case-for-embedded-turn)
