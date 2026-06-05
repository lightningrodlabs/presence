# Changelog

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
  `RTCPeer` wrapper (~550 lines); the FSM and manager tiers tree-shake out when
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
