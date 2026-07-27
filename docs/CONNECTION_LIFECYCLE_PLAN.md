# Connection lifecycle & diagnostics

Started 2026-05-15 from forensic analysis of the merged logs
`Presence_merged_0.14.7_2026-5-13` and `2026-5-15`, plus a reported "peer dropped
from my screen mid-call" incident. Most of it shipped; this records what it
established, what it still owes, and the one conclusion it got wrong.

Paths were rewritten on 2026-07-27: the FSM library moved from
`ui/src/transport/fsm/` to `packages/webrtc-peer/src/`.

## What this established (in force today)

**Media liveness keeps the pane.** `isPeerMediaLive(peer)` and
`globalPresenceSet()` (`ui/src/streams-store.ts`) union in every peer whose media
is actually flowing on *either* carrier, so a Holochain-signal hiccup no longer
removes the pane of a peer you can still see and hear.
`MEDIA_LIVE_WINDOW_MS = 3000`.

The reasoning behind it still holds and is worth keeping: **flowing media is the
strongest possible evidence of presence; a 2s heartbeat on a separate lossy
transport is the weakest.** Before this change the weakest signal overrode the
strongest — `PING_INTERVAL = 2000`, `ACTIVE_AGENT_STALENESS = 6000`, and the
signal relay showed 12% loss with multi-second jitter in the logs, so a >6s
outage was routine while WebRTC tolerated 15s of ICE-disconnected grace.

**Forensics.** `SignalCarrierDown`/`SignalCarrierUp` with duration;
`PresenceAdd`/`PresenceRemove` carrying a reason (`ping-stale`, `observer-stale`,
`leave`, `webrtc-alive-hold`, `webrtc-closed`); DTLS transport state and error in
the DTLS-stall trigger; `signalingState` in the SDP-exchange-timeout trigger; a
jitter-deviation clamp in `voice.ts` that stopped `jit=148966.5ms` garbage
reaching the merged log.

**Diagnostic-log requests are scoped to the call.** `_conversationParticipants`
is populated on first `Connected` per peer and kept for the session, so
`requestDiagnosticLogs()` with no argument targets people who were actually in
the conversation rather than every peer ever heard about. The request button
clears on download, so green means "results ready, click to download".

**The SDP-exchange timeout scales with signaling RTT.** Per-connection
`sdpExchangeTimeoutMs` is threaded `ensureConnection` opts → `ConnectionManager`
per-agent override map → `PeerConnectionFSM`. `_computeSdpTimeout()` derives it
from the signals-carrier RTT EWMA as `clamp(rtt * 20, 5000, 15000)`. With no
sample it returns undefined and the FSM falls back to the 15s default, so a
no-RTT connection is never worse than before. `K = 20` and `FLOOR = 5000` were
provisional and were never confirmed against a wider RTT sample — that check is
still owed.

## Still outstanding

**Teardown symmetry.** When a peer is genuinely gone — ping stale *and* not
media-live — nothing explicitly closes their transports (video, screen-in,
screen-out). An orphaned connection can outlive the pane.

**Stale per-peer state.** Two concrete leaks, both confirmed on 2026-07-27:

- `_pendingInits` (`ui/src/streams-store.ts:3011`) has **no TTL sweep**, while
  its sibling `_pendingAccepts` does (`:2164-2170`). It is cleared on leave and
  on specific paths, but nothing ages out entries.
- `ConnectionManager` prunes its `_connections` map on the `closed` transition
  only (`packages/webrtc-peer/src/connection-manager.ts:506-521`). The comment
  above it reads "Clean up closed/failed connections" — **`failed` is not
  handled**, and no `connection-closed` is emitted for it. This is the live
  wedge described in `MAINTAINABILITY_ASSESSMENT.md` §3.1(c); fix it there, not
  here.

Also worth clearing on peer leave: `_othersConnectionStatuses`,
`_lastQualityBucket`, and the signaling-RTT EWMA.

A `_reconcilePeerState()` pass — cross-checking `_knownAgents`, the presence set,
`_openConnections` and the FSM connection map, logging and cleaning any
discrepancy — was the proposed backstop. Treat it as a candidate, not a
commitment: `MAINTAINABILITY_ASSESSMENT.md` §5 converges liveness onto four
predicates with one authority each, which would remove most of what such a pass
would reconcile.

**Signal-connection outage handling.** On signal-connection re-establish, trigger
an immediate `pingAgents()` rather than waiting up to 2s for the next interval.

## The conclusion this document got wrong

> **Do not repeat this.** On 2026-05-16, commit `12cb027` closed the
> duplicate-connection investigation as **"Phase 4B — DONE (verification, no code
> change needed). Duplicate FSM connections to a peer are structurally
> impossible … All covered by passing tests."** It went further and reinterpreted
> the field evidence: the two concurrent connection-ids for one peer-pair in the
> 5/13 log (`a216662e` initiated locally, `a050c0ea` by the remote) were declared
> to be *different layers*, not duplicate live FSMs.
>
> That was wrong. Six weeks later `c143cda` (2026-06-29) fixed the real problem:
> each FSM minted an independent random `connectionId`, so the two peers had no
> ordered, shared identity for "which attempt is current" — producing a ~20s
> reconnect deadlock observed in the field. The fix was a monotonic cross-FSM
> connection epoch.
>
> The mechanism of the error is the part worth keeping: the tests that "covered"
> it drive a `MockRTCPeerConnection` that **cannot throw** — `setRemoteDescription`
> accepts anything in any state. A suite built on that mock cannot reproduce the
> failure modes that actually occur, so its passing told us nothing about the log.
> When a field log and a green test suite disagree, the suite is what is wrong
> about reality.

A second, smaller version of the same error sits in this document's history: an
early finding that *closed* FSMs linger was retracted as imprecise. The
retraction was correct but too broad — it closed the wrong door. The residual
leak is `failed`, not `closed`, and it went on shipping (see "Still outstanding"
above).

## Deliberately not doing

Forcing TURN-only after one SDP timeout; holding the prior carrier until the new
connection reaches ICE-connected; quality-bucket hysteresis; simplepeer ICE-dump
parity. Note that "hold the prior carrier until the new connection is up" has
since been re-derived from a different direction as the make-before-break
handover invariant in `MAINTAINABILITY_ASSESSMENT.md` §5 Phase 1 — if it is
revisited, it should be revisited there.
