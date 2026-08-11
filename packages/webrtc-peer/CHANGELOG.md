# Changelog

## Unreleased

- **Changed:** disconnected auto-retry uses exponential backoff with jitter
  from the reconnect policy's pacing fields, replacing flat 500-2000ms
  jitter. `min(maxDelayMs, baseDelayMs * 2^attempt) + random(0..jitterMs)`,
  read from the `ReconnectPolicy` instance's own `baseDelayMs`/`maxDelayMs`/
  `jitterMs` (`DefaultReconnectPolicy` defaults: 300/7000/1000ms — falls back
  to `DEFAULT_RECONNECT_OPTIONS` for a policy that omits them). A dead relay
  drove 11 back-to-back retry sessions in 144s in the field (2026-08-11),
  each re-flooding candidates; backoff spaces them 0.3s -> 7s.
- **Changed:** outbound trickle candidates are filtered (active-TCP/discard-port
  dropped, exact per-m-section duplicates deduped) via the exported
  `shouldTrickleCandidate` predicate. Candidate batching (multiple candidates
  per signal) is deferred — it changes the signal payload shape and needs a
  capability gate.
- **Fixed:** the disconnected-state retry-limit give-up was an illegal
  transition (logged BLOCKED and left a dead FSM in disconnected);
  disconnected → failed is now a valid edge, so the manager emits
  connection-closed through the normal path.
- **Fixed:** equal-epoch session-staleness deadlock — the remote peerSessionId
  counter is now scoped to the remote FSM's connectionId; a recreated remote
  FSM re-latches instead of having its answers/candidates dropped as stale,
  with tombstones preventing resurrected dead-session signals
  (WEBRTC_RECONNECT_IDENTITY.md §7 step 4, defect D2).

## 0.4.0

Banks the Phase 3–Round 3 library changes (0.x semver: breaking → minor).

- **`ConnectionManager` now forwards FSM `error` events** (`ManagerEventType`
  gains `'error'`). They were dropped silently before: negotiation exceptions
  (`setLocalDescription`/`setRemoteDescription` throwing mid-handshake) and
  data-channel errors were emitted by `RTCPeer`, re-emitted by the FSM, and
  died at the manager boundary, so their root-cause text never reached any
  consumer log. Forwarded verbatim as forensics — errors are symptoms, not
  verdicts; the FSM still owns recovery and terminality is still communicated
  by the `failed` phase. `data` is either the underlying exception or the
  `{ blocked: true, ... }` record of a refused transition (which consumers may
  choose to ignore: blocked transitions are already visible on the
  `onTransition` stream with a `BLOCKED:` trigger).

- **BREAKING: `TransitionRecorder` removed** (with `TransitionRecorderOptions`).
  Exported since 0.1.0, never constructed by any consumer outside its own test.
  Capture `onTransition` entries yourself if you need a portable record.
- **BREAKING: `ConnectionConfig.diagnostics` removed**, along with the `DIAG:`
  entries it gated on the `onTransition` stream. The flag was never set by any
  consumer and the one consuming app dropped `DIAG:` entries unconditionally.
  Real connection events (ICE state, dropped stale signals, new peer sessions,
  establishment timeline) are unaffected.

## 0.3.0

Connection-lifecycle work (see the consuming app's `WEBRTC_CONNECTION_PLAN.md`).

- **BREAKING (semantics): `connected` now means media-ready (ICE + DTLS), not
  ICE + DTLS + data-channel-open.** Media (RTP) flows on ICE+DTLS and remote
  track availability is driven by `track` events, not the data channel, so the
  channel no longer gates the phase. A stuck channel is recovered in place by the
  data-channel watchdog without holding the call in `connecting`. Consumers that
  treated `connected` as "data channel is open" must switch to the new
  `dataChannelReady` signal. (Supersedes the DC-gating investigation doc.)
- **`ConnectionViewModel.dataChannelReady: boolean`** — new field exposing
  data-channel-open as a separate signal from `phase`. `true` only when
  `connected` and the channel is open.
- **Buffered `RTCPeer.send()`.** Messages sent while the data channel is closed
  (connected-but-DC-pending, or mid in-place recreate) are buffered (bounded
  FIFO, oldest dropped on overflow) and flushed in order on open — control/
  state-sync messages are delayed, not silently dropped.
- **`establishment-timeline` event** (FSM + `ConnectionManager`) — one structured
  record per connect with per-stage ms (ICE / DTLS / connected / data channel),
  `wasReconnect`, and `peerSessionId`. New `EstablishmentTimeline` type exported.
- **`ConnectionConfig.iceCandidatePoolSize`** — passthrough to
  `RTCConfiguration` to pre-gather candidates (default 1); trims establishment
  latency on slow signaling paths. Omitted from the RTCConfiguration when unset.
- Status strings updated so a live call never reports `"Opening data channel..."`.
- **Fix: `connection-state-changed` now fires only on actual phase changes.**
  `ConnectionManager` previously emitted it from the `onTransition` log stream, so
  same-state sub-phase entries (ICE blips, in-place data-channel recreate,
  dropped-signal notes) surfaced as spurious `connected->connected` "state
  changes" — making consumers re-run on-connect side effects (re-add tracks →
  renegotiation, re-tag carrier, re-apply sender params) repeatedly on a live
  call. Now gated on `fromState !== toState`; the view model still updates on
  every entry.

## 0.2.0

Reconnection, packaging, and spec-correctness improvements over the initial
0.1.0 extraction.

- **Configurable reconnection.** `DefaultReconnectPolicy`'s tuning knobs
  (`maxAttempts`, `iceRestartMaxAttempts`, `baseDelayMs`, `maxDelayMs`,
  `jitterMs`) are now documented constructor options; defaults are exported as
  `DEFAULT_RECONNECT_OPTIONS`. `maxAttempts: Infinity` retries until the caller
  closes the connection.
- **`connectionState === 'failed'` is attributed and recoverable.** The aggregate
  is mapped to the actual failed transport (ICE vs DTLS) by reading the
  underlying states: ICE failures retry via ICE restart, DTLS failures via full
  reconnect. `failed` is reached only on retry exhaustion — not on the first
  transport failure. (Previously: treated as terminal.)
- **End-of-candidates.** Trickle ICE emits an end-of-candidates marker
  (`{candidate: ''}`) on gathering completion (RFC 8838) so the remote can
  finalize its checklist promptly.
- **Tiered consumption.** `@lightningrodlabs/webrtc-peer/core` exposes just the
  `RTCPeer` wrapper (~620 lines); the FSM and manager tiers tree-shake out when
  unused (`sideEffects: false`). See README "Footprint & tiers".
- **Diagnostics gate.** `config.diagnostics` (default `false`) gates verbose
  `DIAG:` instrumentation; real connection events are always emitted. Failure
  transitions also embed the raw `ice=…`/`dtls=…` states in the `trigger`
  string, alongside the structured `TransportSnapshot`.
- **SFU markers reserved.** `ConnectionRole`'s `sfu-*` values are documented as
  reserved/unstable markers for planned SFU support (no behavior yet). See
  ROADMAP.md.
- **ESM correctness.** Relative imports now carry `.js` extensions, so the
  package resolves under Node/Deno native ESM as well as bundlers.

## 0.1.0

Initial extraction from the Presence project.

- `RTCPeer` — thin Perfect-Negotiation wrapper over `RTCPeerConnection`.
- `PeerConnectionFSM` — single-peer connection lifecycle state machine.
- `ConnectionManager` — multi-peer orchestration with signal routing and an
  aggregate view model.
- `DefaultReconnectPolicy` — two-tier (ICE-restart then full-reconnect) backoff.
- `TransitionRecorder` — ring buffer for the `onTransition` forensic stream.
- Injectable `Logger`; the library never writes to `console` on its own.
- No runtime dependencies.
