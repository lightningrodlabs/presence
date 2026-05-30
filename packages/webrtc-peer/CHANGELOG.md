# Changelog

## 0.1.0 — unreleased

Initial extraction from the Presence project.

- `RTCPeer` — thin Perfect-Negotiation wrapper over `RTCPeerConnection`.
- `PeerConnectionFSM` — single-peer connection lifecycle state machine.
- `ConnectionManager` — multi-peer orchestration with signal routing and an
  aggregate view model.
- `DefaultReconnectPolicy` — two-tier (ICE-restart then full-reconnect) backoff.
  All tuning knobs (`maxAttempts`, `iceRestartMaxAttempts`, `baseDelayMs`,
  `maxDelayMs`, `jitterMs`) are documented constructor options; defaults are
  exported as `DEFAULT_RECONNECT_OPTIONS`. `maxAttempts: Infinity` retries until
  the caller closes the connection.
- `connectionState === 'failed'` is attributed to the actual failed transport
  (ICE vs DTLS) by reading the underlying transport states, and is recoverable:
  ICE failures retry via ICE restart, DTLS failures via full reconnect. `failed`
  is reached only on retry exhaustion — not on the first transport failure.
- Trickle ICE emits an end-of-candidates marker (`{candidate: ''}`) on gathering
  completion (RFC 8838) so the remote can finalize its checklist promptly.
- Failure transitions embed the raw `ice=…`/`dtls=…` states in the `trigger`
  string, in addition to the structured `TransportSnapshot`.
- `TransitionRecorder` — ring buffer for the `onTransition` forensic stream.
- Injectable `Logger`; the library never writes to `console` on its own.
- Tiered consumption: `@lightningrodlabs/webrtc-peer/core` exposes just the
  `RTCPeer` wrapper (~550 lines); the FSM and manager tiers tree-shake out when
  unused (`sideEffects: false`). See README "Footprint & tiers".
- `config.diagnostics` (default `false`) gates verbose `DIAG:` instrumentation;
  real connection events are always emitted.
- `ConnectionRole`'s `sfu-*` values are documented as reserved/unstable markers
  for planned SFU support (no behavior yet). See ROADMAP.md.
- No runtime dependencies.
