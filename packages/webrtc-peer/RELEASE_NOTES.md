# @lightningrodlabs/webrtc-peer — 0.3.0

Connection-lifecycle hardening over 0.2.0, driven by a real production failure on
a lossy signaling carrier: ICE+DTLS reached `connected` and media flowed, but the
data channel never opened within budget and the whole connection was torn down
and rebuilt (~26s of churn). The fix decouples media-readiness from the data
channel and recovers a stuck channel in place.

## Breaking

- **`connected` now means media-ready (ICE + DTLS), not ICE + DTLS +
  data-channel-open.** Media (RTP) flows on ICE+DTLS, and remote track
  availability is driven by `track` events — the data channel no longer gates the
  phase. A stuck channel is recovered in place by the data-channel watchdog
  without holding the call in `connecting`. **Consumers that treated `connected`
  as "data channel is open" must switch to the new `dataChannelReady` signal.**

## Highlights

- **`ConnectionViewModel.dataChannelReady: boolean`** — data-channel-open exposed
  as a signal separate from `phase`; `true` only when `connected` and the channel
  is open. Also surfaced via the `data-channel-open` event.
- **Buffered `RTCPeer.send()`.** Messages sent while the data channel is closed
  (connected-but-DC-pending, or mid in-place recreate) are buffered (bounded FIFO,
  oldest dropped on overflow) and flushed in order on open — control/state-sync
  messages are delayed, not silently dropped.
- **`establishment-timeline` event** (FSM + `ConnectionManager`) — one structured
  `EstablishmentTimeline` record per connect with per-stage ms (ICE / DTLS /
  connected / data channel), `wasReconnect`, and `peerSessionId`.
- **`ConnectionConfig.iceCandidatePoolSize`** — passthrough to `RTCConfiguration`
  to pre-gather candidates (default 1); trims establishment latency on slow
  signaling paths. Omitted from the `RTCConfiguration` when unset.
- **Fix: `connection-state-changed` fires only on actual phase changes.** It was
  previously emitted from the `onTransition` log stream, so same-state sub-phase
  entries (ICE blips, in-place data-channel recreate, dropped-signal notes)
  surfaced as spurious `connected->connected` "state changes" — making consumers
  re-run on-connect side effects (re-add tracks → renegotiation, re-tag carrier,
  re-apply sender params) repeatedly on a live call. Now gated on
  `fromState !== toState`; the view model still updates on every entry.
- Status strings updated so a live call never reports `"Opening data channel..."`.

## What's validated

- Unit + two-FSM integration tests (200 tests) cover Perfect Negotiation, glare,
  signal loss/dup, reconnection, give-up, and the new in-place data-channel
  recovery (`data-channel-recovery.test.ts`): a stalled channel is recreated on
  the *same* `RTCPeerConnection` (no new ICE/DTLS/peer session), bounded by
  `maxDataChannelRecreateAttempts`, escalating to a full reconnect only if
  recreation never succeeds.

## Known scope & limitations

Unchanged from 0.2.0 — see CHANGELOG.md and README.md:

- **You need a TURN server for cross-NAT / VPN paths.** `DEFAULT_ICE_SERVERS` is
  STUN-only; supply your own `iceServers` (STUN + TURN) for symmetric-NAT/VPN
  environments.
- **Single-transport vs. multi-transport ownership.** Let the library own
  recovery for a single transport (express give-up via `maxAttempts` /
  `closeConnection()`); if a higher layer orchestrates multiple carriers, that
  orchestrator owns the timing — keep `maxAttempts` low so WebRTC yields fast.
  See README "Ownership".
- **SFU is reserved, not implemented.** `ConnectionRole`'s `sfu-*` values carry no
  behavior yet and are unstable. See ROADMAP.md.

## Install

```sh
npm install @lightningrodlabs/webrtc-peer
```

See README.md for usage, ROADMAP.md for planned SFU support, and CHANGELOG.md for
the full change list.
