# Streaming transport — next steps

Working notes for the in-progress voice-over-signals branch
(`feature/voice-over-signals`). Captures the architectural decisions
still owed before further code lands. Written 2026-04-11.

## Context

Voice-over-signals shipped as a parallel module alongside the existing
WebRTC path. That was the wrong shape: voice and WebRTC-audio are not
two separate features, they are two transports for the same conceptual
thing (the user's microphone). Symptoms of the wrong shape:

- "waiting for connection" overlay sticks around when WebRTC is off
  even though the Holochain-level circle (and therefore the room
  membership) is fine.
- Two simultaneous `getUserMedia` calls (one from WebRTC, one from the
  voice module) compete for the same input device.
- Mute state, device-picker state, and AGC/NS settings live inside the
  WebRTC code path and aren't reusable.
- No coherent way for one Starlink user to "downgrade" their incoming
  audio without the rest of the room coordinating in chat.

## Confirmed direction

- **Lift the audio source out of WebRTC.** Create a transport-agnostic
  `MicSource` (or similar) that owns the `getUserMedia` call, the
  selected device id, the mute flag, and exposes a `MediaStreamTrack`
  for consumers. WebRTC's `audioOn`/`audioOff` becomes one consumer;
  voice's `MediaStreamTrackProcessor` becomes another.
- **Reuse the existing mic button.** Mute / device-pick UX stays
  identical regardless of transport — "the mic" is the user's mental
  model, transport is plumbing.
- **Fix the overlay text.** "waiting for connection" was always wrong:
  the connection (Holochain room membership) is established, indicated
  by the agent circle. The thing actually being waited on is media
  bytes, so the message should be "waiting for stream…" or similar.
  Trigger condition becomes "agent in room AND no media flowing yet,"
  not "no WebRTC peer connection."

## Open question 1 — who picks transport

Three plausible models:

### (A) Sender picks
"I am sending my audio via signals." Local action, local effect.
Easy to reason about. Failure mode: a friend who can't receive WebRTC
has to ask you in chat to flip your switch — coordination cost on
every degraded link.

### (B) Receiver picks
"Please send me audio via signals." Captures the actual problem case
(struggling Starlink user downgrades their own incoming stream
unilaterally). Awkward semantically — you're commanding another
machine — and weird to extend to other modules.

### (C) Per-pair, union wins
Either side of an (A, B) link can mark "this pair uses signals." If
either flag is set, both directions use signals. State is symmetric,
broadcast as part of the module's normal state envelope.

### Recommendation: (C)

Network reachability between two peers is fundamentally symmetric.
WebRTC ICE either finds a viable path between you or it doesn't; if
it doesn't, both directions are dead. The asymmetric cases are rare
enough that pretending symmetry costs us little. (C) gives the
"Starlink user downgrades themselves and everyone in the room adapts"
UX from (B) AND the "I notice my friend can't hear me, I downgrade
for them" UX from (A).

The semantic shift in (C) is subtle but worth being explicit about:
**"I am using transport X with peer Y" is a property of the (me, Y)
edge, not of me alone**. It's not "my preference" — it's "our
agreement about this link." When I click the toggle on Alice's pane,
I'm declaring that the link to Alice is signals-only. When Alice's UI
receives my declaration, she shows the same link as signals-only too.
Either of us can flip it back. There is no negotiation, no
precedence — just "either flag = signals."

This also gives a clean answer to the WebRTC-retry-loop concern: the
global "WebRTC off" toggle goes away, and per-peer transport becomes
the kill switch for retries. Marking a peer as signals-only:

1. Tears down the existing WebRTC peer connection if any
2. Removes the peer from the auto-retry init loop in
   `_processPongMetaData` (the thing that fires `InitRequest` every 5s
   when `_openConnections` has no entry)
3. Routes audio bytes via signals
4. Persists across pongs (it lives in module state, which is in
   `PongMetaDataV1.moduleStates`)

Manual retry on "I switched routers" becomes: click the per-peer
toggle back to WebRTC, which kicks the init flow on the next pong.
No new affordance, just inverting the same action.

A global mic-chevron entry can still exist for bulk-setting ("use
signals with everyone in this room") but it is just a convenience
that flips the per-peer flag for every current peer.

## Open question 2 — where the mic indicator lives

Once audio transport is pluggable, **the voice module's "active" state
is no longer a per-module concept** — it becomes "mic state for
transport=signals on this edge." The other storage location for the
same conceptual fact ("Alice's mic is on") is the existing WebRTC
`conn.audio` flag.

So the badges should consolidate: **one mic indicator per peer**,
with the icon (or color, or badge shape) hinting at *which* transport
is delivering it.

- WebRTC mic on: small filled mic
- WebRTC mic off: small filled mic with slash
- Signals mic on: small mic with a broadcast aura, or mic-with-dot
- Signals mic off: same shape but slashed

Same affordance, transport hinted by appearance. No green broadcast
badge stacking on top of a separate WebRTC indicator.

If consolidation lands, the `getStateIcons` currently on the voice
module becomes wrong — the indicator should be owned by a unified
"mic" concept, not by either transport module. Which suggests the
voice module shouldn't *have* state icons at all, and the existing
WebRTC mic icon in [video.ts:46-52](ui/src/room/modules/video.ts#L46-L52)
needs to grow transport-awareness.

### Two paths for ownership of the mic icon

- **Cleanest:** introduce a `mic` module that owns mic state and
  renders the icon. `video` and `voice` both become transport
  implementations that subscribe to it. Bigger refactor than the
  surface task.
- **Pragmatic:** leave the icon in `video.ts` for now and have it
  look at both `conn.audio` (WebRTC) and the voice module state
  (signals), with a comment noting the eventual extraction. Less
  pretty, less work.

## Open question 3 — squelch and module transitions

The WebAudio squelch synth + `onPeerStateChange` hook drafted in this
branch are coupled to the bigger ontology question. Once mic state
lives in a transport-agnostic `MicSource` abstraction, **transitions
stop being a "voice module" concern and become a "mic state changed"
concern**. The squelch should fire when the unified mic state flips,
regardless of transport. That probably wants its own callback hook
or store subscription, not the per-module `onPeerStateChange` from
this branch.

Decision: hold the squelch work until the unified mic abstraction
exists. The `onPeerStateChange` plumbing in `streams-store.ts` and
`types.ts` is independently useful for other future modules but
should be revisited in the same pass.

## Concrete sign-offs needed before the next code lands

1. **Adopt per-pair union model (option C above)?**
2. **Mic-icon ownership: dedicated `mic` module, or kept in
   `video.ts` with transport-awareness?** The cleaner answer is the
   `mic` module but it widens the diff.
3. **`MicSource` shape:** a class on `streamsStore` that owns
   `getUserMedia`, device id, mute flag, and exposes a
   `MediaStreamTrack` consumers attach to. WebRTC `addTrack` and
   voice `MediaStreamTrackProcessor` both consume the same track.
   Sound right?
4. **Per-peer toggle UI placement:** in the icon strip on each peer
   pane, as a clickable badge cycling WebRTC ↔ signals (same place
   as `mdiPhoneRefresh`). Acceptable, or elsewhere?

## Work to do once signed off (single pass)

- `MicSource` class with shared track, device/mute state
- Refactor `audioOn`/`audioOff` to consume `MicSource`
- Per-pair transport store (symmetric union semantics)
- Suppress WebRTC init retries for peers marked signals-only
- Voice module reads from `MicSource` instead of its own
  `getUserMedia`
- Unified mic indicator (location TBD per Q2)
- "Waiting for stream…" overlay copy + corrected trigger condition
- Per-peer toggle in the icon strip
- Bulk "use signals for everyone" entry in mic chevron
- Remove the standalone "video" toolbar toggle added earlier in this
  branch (replaced by the per-peer mechanism)

## Out of scope for this pass

- Renaming the `video` module (worth doing eventually but noisy)
- Squelch + module transitions (revisit after mic abstraction)
- Unreliable-datagram path through kitsune2 (pursue only if measured
  signal latency under load proves unacceptable)
- Native (Moss-side) AEC or audio capture
