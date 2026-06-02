# @lightningrodlabs/webrtc-peer — 0.1.0 (evaluation release)

First published build, for evaluation. A managed WebRTC peer connection for the
browser: W3C Perfect Negotiation, a connection-lifecycle state machine, and a
pluggable reconnection engine, behind a small, signaling-agnostic API.

## Highlights

- **Perfect Negotiation** (polite/impolite, glare handling, trickle and
  non-trickle ICE), with **end-of-candidates** signalled on gathering completion
  (RFC 8838) so the remote can finalize its checklist promptly.
- **Spec-grounded `connectionState === 'failed'` handling.** The aggregate is
  attributed to the actual failed transport by reading the underlying ICE/DTLS
  states: an ICE failure recovers via ICE restart, a DTLS failure via full
  reconnect. Neither is terminal — `failed` is reached only when the configured
  retry budget is exhausted. (Replaces the previous "treat failed as terminal"
  behavior.)
- **Configurable reconnection.** `DefaultReconnectPolicy` exposes every knob as a
  documented constructor option (`maxAttempts`, `iceRestartMaxAttempts`,
  `baseDelayMs`, `maxDelayMs`, `jitterMs`); defaults exported as
  `DEFAULT_RECONNECT_OPTIONS`. `maxAttempts: Infinity` retries until you close
  the connection. Bring your own `ReconnectPolicy` to fully override.
- **Tiered consumption.** `@lightningrodlabs/webrtc-peer/core` exposes just the
  `RTCPeer` wrapper (~550 lines); the FSM and multi-peer manager tiers
  tree-shake out when unused (`sideEffects: false`). See README "Footprint &
  tiers".
- **Structured forensics.** Every transition emits an `FSMTransitionEntry` with a
  full `TransportSnapshot`; `config.diagnostics` (default off) gates verbose
  internal `DIAG:` instrumentation. The library never writes to `console`.
- **Zero runtime dependencies.** ESM with correct `.js` import specifiers —
  resolves under bundlers *and* Node/Deno native ESM.

## What's validated

- Unit + two-FSM integration tests (181 tests) cover Perfect Negotiation, glare,
  signal loss/dup, reconnection, and give-up.
- **Bounded recovery is tested:** a connected path that dies and never recovers
  exhausts `maxAttempts` and lands in `failed` → `idle` — it does not churn
  forever (`peer-connection-fsm.test.ts`).

## Known scope & limitations (please read before evaluating reconnection)

- **You need a TURN server for cross-NAT / VPN paths.** `DEFAULT_ICE_SERVERS` is
  **STUN-only**. With no relay, a path that requires TURN (symmetric NAT, many
  VPNs) genuinely cannot form, and reconnection will retry then surface failure —
  this is ICE reality, not a library defect. Supply your own
  `iceServers` (STUN + TURN) for those environments.
- **Single-transport vs. multi-transport ownership.** For a single WebRTC
  transport, let the library own recovery and express give-up via `maxAttempts`
  or `closeConnection()` — don't run a parallel teardown loop against the `pc`.
  If a higher layer orchestrates *multiple* carriers (e.g. WebRTC + a
  signals/relay fallback) and flips between them, that orchestrator owns the
  timing: keep `maxAttempts` low so WebRTC fails fast and yields. See README
  "Ownership".
- **Churn under a misbehaving/rapid remote.** A peer that rapidly tears down and
  re-initiates with a *new connectionId each time* will drive repeated FSM
  replacement on the receiving side (the FSM correctly accepts each new remote
  session). This is the remote's pattern, not an internal loop — but if you
  orchestrate carriers, avoid re-initiating faster than the backoff. A
  `ConnectionManager`-level debounce on new-remote-session replacement is a
  candidate hardening for a future release.
- **Production battle-testing is ongoing.** The reference consumer (Presence) is
  multi-carrier and deliberately subordinates the FSM's recovery to its own
  carrier orchestrator, so the library's full-reconnect path is unit/integration
  tested but not yet heavily exercised in production by us. Feedback welcome.

## Install

```sh
npm install @lightningrodlabs/webrtc-peer
```

See README.md for usage, ROADMAP.md for planned SFU support, and CHANGELOG.md for
the full change list.
