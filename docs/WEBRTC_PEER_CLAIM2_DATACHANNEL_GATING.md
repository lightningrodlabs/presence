# Claim 2 investigation — "forced, unused data channel gating connectivity"

> Reviewer: "It forces creating a data channel that is not used, to gate
> connectivity, but then that channel sits unused while media channels are used."

Status: **SUPERSEDED** by the §6.1 tiered-readiness change (see
[WEBRTC_CONNECTION_PLAN.md](WEBRTC_CONNECTION_PLAN.md)). The original conclusion
below ("Part B — gating is correct; defer decoupling until a media-only consumer
exists") has been **reversed**: `connected` is now reached on **ICE + DTLS
alone**, and the data channel is surfaced as a separate signal rather than a
gate. The enhancement Part B deferred (`gateOnDataChannel`) effectively landed —
unconditionally, not behind a config flag. The investigation text is retained
below for history; **the current contract is the post-supersession summary in
the next section.**

## Current contract (post §6.1)

- `connected` ⇐ `iceConnected && dtlsConnected`
  ([peer-connection-fsm.ts `_checkCompositeReadiness`](../packages/webrtc-peer/src/peer-connection-fsm.ts)).
  Media (RTP) flows on ICE+DTLS, and remote track availability is driven by
  `track` events — not the data channel — which is the justification for
  decoupling.
- The data channel is exposed separately: the `data-channel-open` FSM event and
  the `ConnectionViewModel.dataChannelReady` flag. A stuck channel is recovered
  in place in the background by the data-channel watchdog (recreate, bounded,
  then escalate) and never gates the call.
- Outbound `RTCPeer.send()` while the channel is closed is **buffered** (bounded
  FIFO) and flushed on open, so control/state-sync messages are delayed during
  the DC-pending / recovery window, not dropped.

---

_Original investigation (historical — conclusion superseded above):_

This documents the two separable parts of the claim and what the running app
showed at the time.

## Part A — "the channel sits unused": false for Presence

The data channel is created unconditionally
([rtc-peer.ts:481-482](../packages/webrtc-peer/src/rtc-peer.ts#L481-L482)), but it
is **not unused**. Presence sends application control traffic over it via
`fsm.send` → `RTCPeer.send`
([fsm-transport.ts:301](../ui/src/transport/fsm/fsm-transport.ts#L301),
[rtc-peer.ts:219-224](../packages/webrtc-peer/src/rtc-peer.ts#L219-L224)).
Observed message types on the channel include:

- `change-video-input` ([streams-store.ts:2080](../ui/src/streams-store.ts#L2080))
- `video-off` ([streams-store.ts:2251-2261](../ui/src/streams-store.ts#L2251-L2261))
- per-peer perceived-stream / link snapshots and other `RTCMessage` actions
  (data-channel-message handling at
  [streams-store.ts:469](../ui/src/streams-store.ts#L469))

So the "unused" premise does not hold here. A media-only embedder that never
calls `send()` would indeed leave it idle — but that is a different consumer.

## Part B — "gates connectivity": true, intentional, and safe — **SUPERSEDED**

> This section described the pre-§6.1 behavior and recommended keeping it. It is
> no longer accurate — `connected` no longer requires the data channel. See the
> "Current contract" section at the top. Retained verbatim for history.

`connected` requires the data channel to be open, alongside ICE and DTLS
([peer-connection-fsm.ts:1111-1118](../packages/webrtc-peer/src/peer-connection-fsm.ts#L1111-L1118)).
This is a deliberate composite-readiness gate, not an accident. The risk the
reviewer implies — media flows but the channel never opens, so the FSM never
reaches `connected` — is real in principle but bounded by a safety net:

- The **DTLS watchdog** fires if ICE is connected but DTLS+data-channel haven't
  completed within `dtlsStallTimeoutMs` (default 5s), transitioning to
  `disconnected` to trigger a retry rather than hanging
  ([peer-connection-fsm.ts:1146-1219](../packages/webrtc-peer/src/peer-connection-fsm.ts#L1146-L1219)).

So a data channel that never opens produces a retry, not a permanent limbo.

## Observation from the running app

`npm run applet-dev-3` (3 agents) connects successfully with the integrated
build. Since DC-open gating has always been in effect and connections establish,
the empirical signal is that the gate is not blocking establishment in practice.
A targeted confirmation, if desired, is to grep the FSM transition log for the
watchdog's `DTLS stall` trigger — its absence on successful connects confirms the
data channel opens within the window and is not the limiting factor.

## Recommendation — **SUPERSEDED**

> Original recommendation was "no change; defer decoupling behind an optional
> `gateOnDataChannel` flag." That was reversed by §6.1: decoupling landed
> unconditionally (no flag) because production captures showed a stuck data
> channel reading as "not connected" was inviting teardown of an otherwise-good
> ICE+DTLS transport — the dominant churn cost. The data channel is now a
> separate, recoverable signal, not a gate. See the "Current contract" section
> at the top of this file and §5.A/§6.1 of
> [WEBRTC_CONNECTION_PLAN.md](WEBRTC_CONNECTION_PLAN.md).
