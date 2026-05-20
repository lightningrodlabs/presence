# Changelog

## 0.1.0 — unreleased

Initial extraction from the Presence project.

- `RTCPeer` — thin Perfect-Negotiation wrapper over `RTCPeerConnection`.
- `PeerConnectionFSM` — single-peer connection lifecycle state machine.
- `ConnectionManager` — multi-peer orchestration with signal routing and an
  aggregate view model.
- `DefaultReconnectPolicy` — two-tier (ICE-restart then full-reconnect) backoff.
- `TransitionRecorder` — ring buffer for the `onTransition` forensic stream.
- Injectable `Logger`; the library never writes to `console` on its own.
- No runtime dependencies.
