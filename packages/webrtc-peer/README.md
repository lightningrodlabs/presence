# @lightningrodlabs/webrtc-peer

**Bring your own P2P transport. Get a managed `RTCPeerConnection` per peer.**

Give the library two callbacks — one to send a signal, one that you call when a
signal arrives — and it takes care of establishing the `RTCPeerConnection`,
keeping it alive, and surfacing the media. No signal server required, no
assumptions about how the bytes get there.

```ts
const manager = new ConnectionManager({
  myAgentId: myPeerId,
  signaling: (to, msg) => myP2P.send(to, JSON.stringify(msg)),
});

myP2P.onMessage((from, raw) =>
  manager.deliverSignal(from, JSON.parse(raw)),
);

manager.ensureConnection(otherPeerId);
manager.on('remote-stream', ({ remoteAgent, data }) => attachVideo(remoteAgent, data));
```

That is the complete integration. Works with Holochain remote signals, libp2p streams, a plain WebSocket — anything that can ship an opaque JSON blob from one peer to another.

## Why this exists

Raw `RTCPeerConnection` gives you primitives, not a connection. To ship reliable
P2P media you have to solve, yourself:

- **Offer collisions (glare).** Both peers negotiating at once corrupts signaling
  state. The W3C Perfect Negotiation pattern handles this.
- **Reconnection.** ICE paths drop. Knowing *when* to ICE-restart vs. full-reconnect,
  with backoff, is non-trivial — and tearing down too eagerly lands you back on the
  same broken path.
- **Lifecycle.** ICE / DTLS / signaling / data-channel states each have their own
  machine; your UI needs one coherent answer to "what is this connection doing?"
- **Forensics.** When a connection fails in the field, you need a structured trail,
  not scattered console logs.

This library solves these once, behind a small signaling-agnostic API. It does
**not** do peer discovery, identity, authentication, or signal transport — those
belong to your P2P substrate. The library cares only about WebRTC, and trusts
your transport to deliver SDP and ICE messages between two known peers.

## What you get

- **Perfect Negotiation** — W3C polite/impolite pattern, glare handling,
  ICE-candidate queueing, trickle and non-trickle ICE.
- **Lifecycle FSM** — one `ConnectionPhase` (`idle → signaling → connecting →
  connected → reconnecting → disconnected → failed → closed`) with guarded
  transitions. Subscribe to phases, not raw browser states.
- **Two-tier reconnection** — fast ICE-restart first, then full reconnect, with
  quadratic backoff + jitter. Bring your own `ReconnectPolicy` to override.
- **Multi-peer `ConnectionManager`** — one object owns every peer, routes signals,
  propagates local media, exposes an aggregate view model for room UI.
- **Reactive view models** — phase, progress, retry context, connection quality
  (relayed? candidate type?), track flow, a composite `healthy` flag.
- **Structured forensics** — every transition emits an `FSMTransitionEntry` with
  a full `TransportSnapshot` (ICE / DTLS / signaling / gathering / data-channel).
  `TransitionRecorder` captures a ring buffer you can dump on failure.
- **`onPeerCreated` hook** — get the bare `RTCPeerConnection` before any tracks
  are attached, to install simulcast transceivers, codec preferences, etc.
- **Zero runtime dependencies.** Browser WebRTC APIs only. Fully typed. Testable —
  inject a mock `RTCPeerConnection` via `createPeerConnection`.

## Install

```sh
npm install @lightningrodlabs/webrtc-peer
```

## Plugging into a P2P transport

The library accepts signaling in either of two forms. **Pick the one that matches
your transport's shape.**

### Send-callback form (recommended for most P2P transports)

P2P substrates typically deliver messages via "I receive a message, dispatch it"
— not a subscription model. Pass a `SignalSender` function and call
`manager.deliverSignal(from, message)` when an inbound message arrives:

```ts
import { ConnectionManager } from '@lightningrodlabs/webrtc-peer';

const manager = new ConnectionManager({
  myAgentId: 'my-stable-peer-id',
  signaling: (to, msg) => myP2P.send(to, JSON.stringify(msg)),
});

myP2P.onMessage((from, raw) => manager.deliverSignal(from, JSON.parse(raw)));
```

#### Holochain remote signals

```ts
const manager = new ConnectionManager({
  myAgentId: encodeHashToBase64(myAgentPubKey),
  signaling: (to, msg) =>
    roomClient.sendMessage([decodeHashFromBase64(to)], 'Sdp', JSON.stringify(msg)),
});

// in your AppSignal handler:
if (signal.type === 'Sdp') {
  manager.deliverSignal(encodeHashToBase64(signal.from), JSON.parse(signal.payload));
}
```

### Adapter form

If your transport already exposes a clean subscription API, implement
`SignalingAdapter` and pass that instead. The library will call `onSignal` itself.

```ts
const manager = new ConnectionManager({
  myAgentId,
  signaling: {
    sendSignal(to, msg) { /* ... */ },
    onSignal(handler) { /* return unsubscribe */ },
  },
});
```

## What the library expects of your transport

Minimal. The wire format is a small `SignalMessage` JSON envelope (`offer` |
`answer` | `candidate` | `leave`) that you ship opaquely between two peers.

- **Authenticated peer identity.** You give the library a stable `from` per
  inbound signal. The library uses string comparison on peer ids to assign
  polite/impolite roles. Identity is your transport's job.
- **Agent-to-agent delivery.** No broadcast required. The library only ever
  sends to one peer at a time.
- **Best-effort, not exactly-once.** The library tolerates loss, reordering and
  duplicates. A connection-scoped `peerSessionId` filters stale signals from
  previous peer sessions.

You do **not** need:
- A reliable ordered channel.
- A signal server, relay, or rendezvous service.
- Anything beyond "deliver this byte string to that peer."

## Reconnection

`DefaultReconnectPolicy` uses quadratic backoff with jitter and a two-tier
strategy: the first attempts use ICE restart (fast, preserves DTLS), then it
switches to full reconnect; DTLS failures go straight to full reconnect (a fresh
DTLS handshake needs a new transport). Every knob is a documented constructor
option — nothing is hard-wired:

```ts
new ConnectionManager({
  myAgentId,
  signaling: send,
  reconnectPolicy: new DefaultReconnectPolicy({
    maxAttempts: Infinity,     // retry until you close the connection
    iceRestartMaxAttempts: 3,  // fast-path attempts before full reconnect
    baseDelayMs: 300,
    maxDelayMs: 7_000,
    jitterMs: 1_000,
  }),
});
```

The WebRTC spec mandates no retry count or backoff — this is application policy.
A fixed `maxAttempts` can give up mid-outage (a VPN flap or Wi-Fi→cellular
handover can exceed the backoff window). If a higher layer already knows when a
peer is still wanted (e.g. room membership), prefer `maxAttempts: Infinity` and
`closeConnection()` when the peer leaves, rather than relying on a count. Or
replace the policy entirely with any `ReconnectPolicy` implementation.

### How a failed connection is handled

`connectionState === 'failed'` aggregates the ICE and DTLS transports. The FSM
reads the underlying states to attribute it: an ICE-transport failure recovers
via ICE restart, a DTLS-transport failure via full reconnect. Neither is
terminal — `failed` is reached only when the configured retry count is
exhausted. The raw `ice=…`/`dtls=…` states are embedded in the transition
`trigger` (and in the structured `TransportSnapshot`) for diagnosis.

## Configuring the `RTCPeerConnection`

`ConnectionConfig.iceServers` carries STUN/TURN servers. ICE handles relay
fallback automatically when host/srflx paths fail. Set
`iceTransportPolicy: 'relay'` to force TURN-only.

Media direction is implicit: attach a stream with only an audio track to send
audio only, omit a stream entirely to send nothing (the data channel still
forms). To **receive** a kind you never send (recvonly), or to pin a direction
up front, pre-create the transceiver in `onPeerCreated`:

```ts
onPeerCreated: ({ pc }) => {
  pc.addTransceiver('video', { direction: 'recvonly' }); // receive, never send
};
```

For lower-level configuration (simulcast, codec preferences, custom
transceivers), `onPeerCreated` fires once per peer session with the bare
`RTCPeerConnection`, before any local tracks are attached:

```ts
const manager = new ConnectionManager({
  myAgentId,
  signaling: send,
  onPeerCreated: ({ pc, remoteAgent }) => {
    pc.addTransceiver('video', {
      direction: 'sendrecv',
      sendEncodings: [
        { rid: 'h', maxBitrate: 1_200_000 },
        { rid: 'm', maxBitrate: 300_000, scaleResolutionDownBy: 2 },
        { rid: 'l', maxBitrate: 100_000, scaleResolutionDownBy: 4 },
      ],
    });
  },
});
```

## Forensics

`onTransition` is the firehose: one structured `FSMTransitionEntry` per
transition, each carrying timestamp, connection id, from/to phase, trigger
string, peer-session id, and a `TransportSnapshot` of all underlying browser
states. `TransitionRecorder` keeps the last N entries; `dump()` / `toJSON()`
produce a portable record for bug reports. The library never writes to
`console` — pass a `logger` (`Logger`) if you want recovered errors and
warnings surfaced.

```ts
const recorder = new TransitionRecorder({ capacity: 500 });
const manager = new ConnectionManager({
  myAgentId,
  signaling: send,
  onTransition: (entry) => recorder.record(entry),
});

window.onerror = () => navigator.clipboard.writeText(recorder.toJSON());
```

## Lower-level API

`ConnectionManager` is the recommended entrypoint. For a single connection or
custom orchestration, use `PeerConnectionFSM` (one peer, full lifecycle) or
`RTCPeer` (a thin Perfect-Negotiation wrapper over `RTCPeerConnection`)
directly.

## Platforms

Targets the W3C `RTCPeerConnection` API. Works in any browser, in Electron's
renderer process, and — via [`react-native-webrtc`][rnw]'s `globalThis`
polyfills — in React Native. The `createPeerConnection` factory lets you
inject a non-global constructor explicitly if needed.

[rnw]: https://github.com/react-native-webrtc/react-native-webrtc

## Testing

The library never constructs an `RTCPeerConnection` directly — it goes through
an injectable `createPeerConnection` factory. Pass a mock to run the full FSM
headless in Node, with no browser or DOM environment. See `src/__tests__/` for
the suite (160+ tests, including two-peer integration).

## License

MIT
