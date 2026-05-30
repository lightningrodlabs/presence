# Claim 2 investigation — "forced, unused data channel gating connectivity"

> Reviewer: "It forces creating a data channel that is not used, to gate
> connectivity, but then that channel sits unused while media channels are used."

Status: **investigate / observe** — no code change recommended. This documents
the two separable parts of the claim and what the running app shows.

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

## Part B — "gates connectivity": true, intentional, and safe

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

## Recommendation

No change for Presence: the channel is used and the gate is correct and
safety-netted. The only defensible enhancement is for *other* consumers: an
optional `gateOnDataChannel?: boolean` (default true) in `ConnectionConfig` so a
pure-media embedder can reach `connected` on ICE+DTLS alone. Defer until such a
consumer exists; it pairs naturally with the diagnostics/feature switches in
[WEBRTC_PEER_SIZE_AUDIT.md](WEBRTC_PEER_SIZE_AUDIT.md).
