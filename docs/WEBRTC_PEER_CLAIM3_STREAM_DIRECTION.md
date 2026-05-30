# Claim 3 investigation — "can't completely disable a stream"

> Reviewer: "It doesn't appear to support completely disabling some streams, if I
> don't want either audio or video sent."

Status: **investigate-only** (no code change). This documents what the current
API can and cannot do, why Presence itself does not want the requested feature,
and the options if a general-purpose consumer needs it.

## What the library does today

Media direction is **implicit**, derived from which tracks you attach:

- `addLocalStream(stream)` →
  [`_addLocalStream`](../packages/webrtc-peer/src/peer-connection-fsm.ts#L817-L856)
  iterates `stream.getTracks()` and `addTrack`/`replaceTrack`s each one.
- `RTCPeer.addTrack` is a thin pass-through to `pc.addTrack`
  ([rtc-peer.ts:185-188](../packages/webrtc-peer/src/rtc-peer.ts#L185-L188)).

There is no `media: { audio, video }` option and no call to `addTransceiver`
with an explicit `direction`. So:

| Goal | Supported? | How |
|------|-----------|-----|
| Send audio only | **Yes** | Pass a stream containing only an audio track |
| Send video only | **Yes** | Pass a stream containing only a video track |
| Send neither (data channel only) | **Yes** | Pass no stream / a stream with no tracks |
| Stop sending a kind mid-call | **Yes** | `replaceTrack(sender, null)` or `removeLocalStream` |
| **Receive a kind without ever sending it (recvonly)** | **Not first-class** | Only via the `onPeerCreated` escape hatch (below) |
| **Declare sendonly / inactive up front** | **Not first-class** | Same escape hatch |

So the literal reading of the claim — "I don't want audio or video sent" — *is*
already achievable by omitting the track. What is genuinely missing is
**declarative direction control**: pre-negotiating a `recvonly` m-line so a peer
can receive a kind it never sends, without a later renegotiation. With the
add-track-only model, if neither side attaches a video track there is no video
m-line at all, and receiving video later requires `addTrack` → renegotiation.

## The escape hatch that already exists

[`onPeerCreated`](../packages/webrtc-peer/src/peer-connection-fsm.ts#L61-L70)
hands the consumer the fresh `RTCPeerConnection` *before* any track is attached
or SDP is generated
([peer-connection-fsm.ts:779-796](../packages/webrtc-peer/src/peer-connection-fsm.ts#L779-L796)).
A consumer that wants receive-only video can do:

```ts
new ConnectionManager({
  // ...
  onPeerCreated: ({ pc }) => {
    pc.addTransceiver('video', { direction: 'recvonly' });
  },
});
```

The FSM already cooperates with pre-created transceivers: `_addLocalStream`
checks `_senderCanSend` and will not try to send on a `recvonly` transceiver
([peer-connection-fsm.ts:830-873](../packages/webrtc-peer/src/peer-connection-fsm.ts#L830-L873)).
So the building block is present; it is just undocumented and manual.

## Why Presence itself does NOT want "completely disable"

Presence's `videoOff` deliberately **keeps the video sender alive** rather than
removing it: it swaps a black-frame keepalive track onto every peer's existing
sender via `replaceTrack`
([streams-store.ts:2194-2233](../ui/src/streams-store.ts#L2199-L2233)).

The comment documents why: dropping the sender entirely — i.e. "completely
disabling" the stream — starved RTP egress, the remote NAT aged out the
candidate-pair mapping, and ICE went `disconnected → failed`. The keepalive is
the fix for that NAT-cooldown failure mode. `audioOff` is similar: it mutes
rather than releasing the sender.

So for Presence, the reviewer's requested behavior is an **anti-pattern they
already engineered around**. The library not pushing consumers toward
sender-removal is, for this use-case, correct. The gap only matters for a
different consumer (e.g. a viewer-only / broadcast topology) that genuinely wants
asymmetric media.

## Options if a general consumer needs first-class direction control

1. **Document the `onPeerCreated` recipe** (lowest cost). Add a README section
   showing recvonly/sendonly via `addTransceiver`. No code change. Covers the
   real need for most consumers.
2. **Add a `media` config** — e.g.
   `ConnectionConfig.media?: { audio?: RTCRtpTransceiverDirection; video?: ... }`,
   applied in `_newPeerSession` by pre-creating transceivers before SDP. Largest
   change; only worth it if direction control becomes a common request.
3. **Do nothing.** Acceptable for Presence, since Presence needs symmetric mesh
   media with persistent senders.

## Recommendation

For Presence: **option 3 / option 1** — no behavioral change is needed, and
removing senders would reintroduce the NAT-cooldown bug. If/when the library is
published for outside use, ship **option 1** (document the escape hatch) and
defer option 2 until an actual asymmetric-media consumer appears.

The reviewer's observation is accurate as an API-surface gap, but for Presence's
topology it is not a defect — and "completely disabling" a stream is exactly the
behavior Presence avoids on purpose.
