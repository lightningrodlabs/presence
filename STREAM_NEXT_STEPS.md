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

## Sign-offs (resolved 2026-04-11)

1. **Per-pair union model (option C).** Adopted. The global "WebRTC
   off" toggle goes away; per-peer transport becomes the kill switch
   for retries. Bulk "use signals for everyone" stays as a chevron
   entry but is a convenience over the per-peer flag.
2. **Mic-icon ownership: dedicated `mic` module.** Chosen over the
   "keep it in `video.ts` with transport-awareness" pragmatic path.
   Bigger diff, cleaner ontology — `video` and `voice` become
   transport implementations that subscribe to the `mic` module's
   state; the mic module owns the indicator and the device-picker UX.
3. **`MicSource` shape: confirmed.** Class on `streamsStore` owning
   `getUserMedia`, device id, mute flag, exposing a
   `MediaStreamTrack`. WebRTC `addTrack` and voice
   `MediaStreamTrackProcessor` both consume the same track.
4. **Per-peer toggle placement: confirmed.** Clickable badge in the
   pane's icon strip, same region as `mdiPhoneRefresh`, cycling
   WebRTC ↔ signals.

## Additional decision — phased module activation (2026-04-11)

Screen-share today broadcasts `activateModule('screen-share')` *before*
calling `getDisplayMedia`, to guarantee the initiator's own `<video>`
element is in the DOM when the stream arrives (see comment at
[screen-share.ts:96-106](ui/src/room/modules/screen-share.ts#L96-L106)).
The network-visible side effect is that peers render an
`establishing connection...` tile for the entire OS-picker duration —
seconds to minutes, or indefinite if the initiator walks away — and
the shared panel re-layouts twice per share attempt.

The two concerns conflated on one lever:

- **Local**: the initiator needs the `<video>` element in the DOM
  before stream bytes arrive.
- **Remote**: peers should only see a share tile once there is
  actually something to show.

Fix: introduce a `phase` field on `ModuleStateEnvelope`
(`'acquiring' | 'active'`, default `'active'` for modules that don't
opt in).

- **Initiator path**: activate with `{ phase: 'acquiring' }`. The
  module is in the local active set — its `renderShare`/DOM hooks
  fire so the `<video>` element exists — but the pane renderer
  **does not produce a share tile on peer sides** for envelopes in
  `acquiring`. On `screenShareOn()` success, transition to
  `{ phase: 'active' }` and broadcast. On picker cancel, deactivate
  from `acquiring`; peers never saw anything.
- **Framework responsibility**: the pane renderer (not each module's
  `renderShare`) filters share-type modules by phase. A
  module-by-module "return empty template" approach leaves empty
  wrapper tiles and invites drift.
- **Generalizes beyond screen-share**: mic and camera both have a
  smaller but real acquiring gap (permission prompt on first grant),
  and the `mic` module should use the same convention rather than
  inventing a local equivalent.

Decision: land the phase convention as part of the mic refactor pass
(cheap once the module framework is already being touched) and fix
screen-share to use it in the same pass or immediately after. The
screen-share fix is standalone enough to defer if scope pressure
demands.

## Pre-flight findings (code pass 2026-04-11)

Things the decisions above don't yet pin down, found by reading the
actual code. Each is an open question the fresh implementation
session needs to answer **before** writing code, not a decided fact.

### MicSource vs. existing `mainStream` ownership

- `audioOn`/`videoOn` each call `getUserMedia` separately and both
  deposit tracks into `this.mainStream`, which is the `MediaStream`
  bound into every WebRTC peer (see
  [streams-store.ts:407-505](ui/src/streams-store.ts#L407-L505) and
  [streams-store.ts:597-689](ui/src/streams-store.ts#L597-L689)).
  `MicSource` can cleanly own the audio-only `getUserMedia`, but the
  resulting track still has to end up in `mainStream` (or whatever
  replaces it) so the WebRTC path continues to work. **Decide:** does
  `mainStream` survive as a composed view over `MicSource.track` +
  camera track, or does WebRTC switch to per-track `addTrack` calls
  and stop composing a local stream at all? This is the first
  structural choice the fresh session will hit.
- `audioOff` at [streams-store.ts:691-732](ui/src/streams-store.ts#L691-L732)
  only sets `track.enabled = false`; it does NOT stop or remove the
  track. This is deliberate: it keeps the RTC transceiver open for
  fast re-enable without renegotiation. The **voice** module in
  contrast calls `tracks.forEach(t => t.stop())` on deactivate
  ([voice.ts:239-243](ui/src/room/modules/voice.ts#L239-L243)).
  These two models are incompatible for a shared `MicSource`.
  **Decide:** `MicSource.setMuted(true)` means `track.enabled = false`
  (shared, fast, WebRTC-friendly). Voice's current "stop on
  deactivate" becomes "release consumer reference; source stays
  alive if other consumers attached."
- `changeAudioInput` at [streams-store.ts:545-595](ui/src/streams-store.ts#L545-L595)
  owns the device-switching path: new `getUserMedia`, stop old track,
  `replaceTrack` on every peer. Currently it does **not** touch
  voice's `mediaStream`, which is a latent bug today (switching input
  in the WebRTC chevron leaves voice on the old device). The unified
  `mic` module naturally fixes it — but the refactor has to move this
  logic into `MicSource` and make voice subscribe to track changes.
- `mainStreamClones` at [streams-store.ts:907-913](ui/src/streams-store.ts#L907-L913)
  exists for the `refreshTracksForPeer` reconnection path
  ([streams-store.ts:2245](ui/src/streams-store.ts#L2245)). If
  `MicSource` becomes the audio owner, the clone machinery has to be
  re-justified or removed. Don't regress the "peer sees stale stream,
  reset and rebuild" path while doing the refactor — has been a
  source of bugs historically.

### Per-peer transport state: shape, broadcast, teardown

- Retry suppression already has a hook at
  [streams-store.ts:2793](ui/src/streams-store.ts#L2793):
  `const videoModuleActive = !!get(this._myModuleStates)['video'];`
  gates the entire init-request branch at
  [streams-store.ts:2822-2869](ui/src/streams-store.ts#L2822-L2869).
  Per-peer suppression slots in as an additional `&& !signalsOnly(pubkeyB64)`
  on that condition — small edit, but means the per-peer transport
  store has to be a synchronous `get`-able store, not an async lookup.
- **Shape of per-peer transport state is unspecified.** Module state
  envelopes are keyed by `moduleId`, not by `(moduleId, peerId)` —
  see [streams-store.ts:1080-1084](ui/src/streams-store.ts#L1080-L1084).
  The natural encoding is: the `mic` module's payload carries
  `{ signalsOnlyWith: [pubkeyA, pubkeyB, ...] }`. Other peers read it
  and check whether *they* are in the list. Union semantics: the link
  (me, Y) is signals-only iff my list contains Y OR Y's list
  contains me. **Decide and document this explicitly before coding.**
- **Teardown hook on flag flip.** `_dispatchPeerModuleTransition`
  ([streams-store.ts:1164-1178](ui/src/streams-store.ts#L1164-L1178))
  only fires when the `active` flag transitions, NOT on payload-only
  updates. Marking a peer signals-only is payload-only, so there's no
  existing callback to hang "tear down the WebRTC connection now" on.
  Two options: (a) add an `onModulePayloadChange` hook that fires on
  payload updates and dispatch the teardown from there; (b) do the
  imperative teardown from the UI action that sets the flag. (a) is
  more general and the right shape if we want the `mic` module to
  react declaratively to its own state changes; (b) is cheaper but
  couples the icon-strip click handler to WebRTC internals. Lean (a).
- Initiator side of retry suppression works naturally because
  `handlePongUi` re-evaluates on every pong. Receiver side
  (`AwaitingInit`) similarly re-reads. No polling needed beyond
  what's already there.

### Phase convention — filter sites

- **Share-type modules**: the filter lives in `_getActiveShares` at
  [room-view.ts:1781-1815](ui/src/room/room-view.ts#L1781-L1815).
  Lines 1799 and 1808 currently filter on `envelope.active` alone;
  they need to also skip `phase === 'acquiring'`. One-line change at
  each site.
- **Agent-type modules** (mic, video, voice, reactions, raise-hand)
  don't go through `_getActiveShares`, so phase filtering for them is
  a different question: `getStateIcons`, `renderOverlay`, and
  `onPeerStateChange` dispatch all run as soon as the module is
  active, regardless of phase. For the `mic` module specifically,
  an `acquiring` phase probably **should** show the local mic icon
  (in an "acquiring" visual state) but should **not** yet cause peers
  to render "Alice's mic is on" indicators. Define what phase gates
  for each dispatch surface in the framework, rather than asking each
  module to opt in.
- **Voice module has the same "activate-first" defect** as screen-share
  ([voice.ts:463-473](ui/src/room/modules/voice.ts#L463-L473)):
  `activateModule('voice')` → `startCapture()` → deactivate on
  failure. Cheap because getUserMedia is fast, but the failure
  window is still peer-visible. The phase convention fixes this for
  free when voice gets refactored to consume `MicSource`.
- Screen-share uses `navigator.mediaDevices.getUserMedia` with
  `chromeMediaSource: 'desktop'`
  ([screen-share.ts + streams-store.ts:743](ui/src/streams-store.ts#L743)),
  not `getDisplayMedia` — the picker is an Electron/We-launcher
  custom flow, not the browser-native OS picker. Doesn't change the
  decision, just means "OS picker latency" in the earlier discussion
  is actually "custom picker latency," which can be even more
  variable.

### Audio context sharing

- Voice module creates its own `AudioContext` for the squelch synth
  ([voice.ts:293-305](ui/src/room/modules/voice.ts#L293-L305)). When
  the squelch moves to the `mic` module, there should be exactly
  **one** `AudioContext` in the app, owned by mic (or `MicSource`),
  shared across squelch + future voice-module playback + any other
  audio consumer. Two contexts will eventually cause clock drift or
  autoplay-gesture headaches. Minor but worth pinning down now so
  the refactor doesn't leave two.

### Out-of-scope reminder (confirmed not regressed)

- `_lastReconcileTime` / `reconcileVideoStreamState` /
  `refreshTracksForPeer` flow ([streams-store.ts:915-919, 2245, 2865-2868](ui/src/streams-store.ts#L915))
  is the "peer's perception of my stream is stale, reset it" path.
  Refactor should preserve it. It does not need to be extended to
  signals transport in this pass (signals has no analogous failure
  mode since there's no WebRTC state to reconcile).

## Pre-flight resolutions (2026-04-11, session 2)

Answers to the "pre-flight findings" above, agreed before Phase 1 code
lands. Listed in the same order as the findings so they're easy to
cross-reference.

### D1 — `mainStream` ownership

Keep `mainStream` as a composed view for now. `MicSource` owns the
audio-only `getUserMedia` and exposes a track; existing camera logic
still owns the video track; `mainStream` is assembled from both for the
WebRTC `addTrack`/`addStream` path. Dropping `mainStream` entirely
(per-track only) would touch `mainStreamClones` and
`refreshTracksForPeer` — explicitly out-of-scope for this pass. Separate
those later.

### D2 — shared mute semantics + refcounted consumers

`MicSource.setMuted(true)` means `track.enabled = false` (fast
re-enable, no renegotiation, WebRTC-friendly). Mute is a single source
of truth across all consumers — any consumer can set it; every
consumer sees it simultaneously.

Consumer lifetime is **refcounted**. Justified by at least three
concrete consumers:

1. WebRTC (`audioOn`/`audioOff`)
2. Voice module (`MediaStreamTrackProcessor` → Opus encoder)
3. Hypothetical but plausible: a transcription module doing
   `MediaStreamTrackProcessor` → ASR

Refcount is not speculative — it exists to stop voice's deactivate from
tearing down the track while WebRTC (or a future transcription consumer)
still holds it. API sketch:

```
acquire(consumerId): { track: MediaStreamTrack; release: () => void }
setMuted(muted: boolean)
changeDevice(deviceId: string)
onTrackChanged(cb: (newTrack: MediaStreamTrack) => void)
```

The underlying device is opened on first `acquire`, closed on last
`release`. Device-change broadcasts a track-replacement event so
consumers that bind to a specific track instance (voice's
`MediaStreamTrackProcessor` is the only one today) can rebuild their
pipeline. WebRTC consumers that just hold a reference can continue
working through `replaceTrack` without rebuild. Event shape gets
pinned in Phase 2.

### D3 — per-peer transport encoding

The new `mic` module's payload carries:

```
{
  muted: boolean,
  deviceId?: string,
  signalsOnlyWith: AgentPubKeyB64[]
}
```

Resolution is symmetric union:

```
signalsOnly(peer) =
     myState.mic.signalsOnlyWith.includes(peer)
  || peerStates[peer].mic.signalsOnlyWith.includes(me)
```

Read synchronously via `get()` so the retry-loop gate at
[streams-store.ts:2793](ui/src/streams-store.ts#L2793) doesn't need to
become async.

Transient-gap note: when A flips signals-only-with-B and broadcasts,
A's retry loop stops on A's next pong; B's retry loop only stops once
A's `ModuleState` signal reaches B. During the gap B may fire one stray
`InitRequest`. Acceptable as a transient — both sides converge. Comment
it in the mic module teardown code so it's not mistaken for a bug later.

### D4 — teardown hook: `onModulePayloadChange`

Add a new `onModulePayloadChange(agentPubKeyB64, prev, next)` hook to
`ModuleDefinition` in `types.ts`. Fired from `handleModuleState` (and
pong reconciliation) when a module's payload changes while `active`
stays true — the case `_dispatchPeerModuleTransition` currently ignores
([streams-store.ts:1164-1178](ui/src/streams-store.ts#L1164-L1178)).

The mic module uses it to WebRTC-tear-down a peer transitioning into
its `signalsOnlyWith` set. Generic enough that future modules can
react declaratively to their own peer-state evolution without hanging
imperative logic off UI click handlers.

**Fire-condition caveat:** dispatch should not fire the hook on *every*
payload delta. The mic module's payload changes on every mute toggle,
and most consumers only care about `signalsOnlyWith` membership. Two
options for avoiding the storm:

- (a) Fire on any payload diff; make the mic module's handler cheap and
  idempotent (re-check membership, no-op if unchanged).
- (b) Let modules opt in to hook dispatch via a predicate on the module
  definition.

Lean (a) for simplicity. Revisit if handler cost becomes measurable.

### D5 — phase convention dispatch rules

`phase?: 'acquiring' | 'active'` on `ModuleStateEnvelope`, default
`'active'` when absent (backward compatible with all current modules).

**Share-type modules**: filter in `_getActiveShares` at
[room-view.ts:1799,1808](ui/src/room/room-view.ts#L1799) — skip
envelopes where `phase === 'acquiring'`. One-line edit at each site.

**Agent-type modules**: framework-level rules, applied by the dispatch
surfaces rather than per-module opt-in.

| Surface              | `acquiring` behavior                               |
| -------------------- | -------------------------------------------------- |
| `getStateIcons`      | Suppressed for peer views. Allowed for `isMe`.     |
| `renderOverlay`      | Suppressed for peer views. Allowed for `isMe`.     |
| `onPeerStateChange`  | Does not fire; waits for transition to `active`.   |
| `onModulePayloadChange` | Does not fire while either prev or next is `acquiring`. |
| `onData`             | Unchanged — data arrival is independent of phase. |

Rationale: `acquiring` means "I've reserved the module slot locally so
my UI can mount (mic icon in loading state, `<video>` element in DOM)
but peers should not yet believe anything is happening." Self-facing
dispatch surfaces fire; peer-facing ones wait.

### D6 — single shared `AudioContext`

One `AudioContext` in the app, owned by `MicSource` (the longest-lived
object that cares about audio timing). Squelch, voice playback, and
any future audio consumer borrow it. Voice's `ensureAudioContext`
([voice.ts:293-305](ui/src/room/modules/voice.ts#L293-L305)) goes away
in Phase 4.

## Work to do (single pass)

- `MicSource` class with shared track, device/mute state
- New `mic` module owning the mic indicator and device-picker UX;
  `video` and `voice` become transport implementations subscribing
  to it
- Refactor `audioOn`/`audioOff` to consume `MicSource`
- Per-pair transport store (symmetric union semantics)
- Suppress WebRTC init retries for peers marked signals-only
- Voice module reads from `MicSource` instead of its own
  `getUserMedia`
- Add `phase: 'acquiring' | 'active'` to `ModuleStateEnvelope`; pane
  renderer filters share tiles by phase; `mic` module uses
  `acquiring` across the permission prompt
- Fix `screen-share` to use the phase convention (activate as
  `acquiring`, transition to `active` on stream arrival, deactivate
  directly from `acquiring` on picker cancel)
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
- **Generalized `StreamSource<T>` abstraction.** Tempting given that
  `mic`, eventually `camera`, already-shipped `screen-share`, and
  hypothetical sensor feeds all "produce something consumers
  subscribe to." Premature: only one source (`MicSource`) is being
  designed in depth; per-source surfaces (AEC/NS/AGC, display-media
  picker, facingMode, sensor sampling) don't compress; the
  unification breaks on non-`MediaStreamTrack` sources (sensors).
  Revisit when `MicSource` plus at least one other concrete source
  exist and have diverged in ways that a base class would have
  prevented. The phase convention above is the actually-shared
  cross-source concept and lives at the module-framework level, not
  in a source base class.
