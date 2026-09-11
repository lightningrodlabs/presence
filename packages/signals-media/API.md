# API reference — `@lightningrodlabs/signals-media`

One section per exported symbol of `src/index.ts`, plus the two names the
`./opus-wasm` subpath adds. Signatures are copied from the source, not
paraphrased; `src/types.ts` and the carriers are the authority and this file is
checked against the barrel by `src/__tests__/api-doc.test.ts` (every export has
a section, every section names an export).

This is a reference. The narrative — how to build the host record, wire a
channel, switch carriers, choose a codec backend — is [`README.md`](README.md),
and where a behavior is already documented there, the section below states the
contract in one line and links it rather than repeating the prose.

## Call order

```
new VoiceCarrier() / new FilmstripCarrier()
  → bind(host)            // the RECEIVE side is live from here: receiveFrame works
  → startCapture()        // the SEND side; resolves false rather than throwing
  → … setFps / setCaptureSide / playSquelch / receiveFrame / stats reads …
  → stopCapture()         // idempotent; filmstrip sends a courtesy stop payload
  → unbind()              // stops capture, tears down playout, clears per-peer state
```

`bind` is required before anything: an unbound carrier's `startCapture()`
returns `false` and its `receiveFrame` cannot open a peer. `bind` adopts
`host.clock` for every host-visible stamp; wire-timestamp arithmetic
(jitter, transit) stays on wall clock by construction.

Three things must be true before `startCapture()` on the voice carrier, or it
resolves `false` after logging:

1. **`host.audioContext()` returns a resumed 48 kHz `AudioContext`** — the
   worklet's 960-sample block and the Opus encoder are both configured for
   48 kHz, and `VoiceCapture.start` refuses any other `sampleRate`. See
   [README, The AudioContext](README.md#the-audiocontext).
2. **A codec is available** — `host.codec?.()` if provided, otherwise
   `webCodecsOpus()`. Neither means no capture and no decode. See
   [README, Opus backends](README.md#opus-backends).
3. **`host.targets()` is non-empty for anything to leave the machine.** An
   empty set is not a failure — capture runs and every frame is dropped at the
   send gate. See [README, Carrier switching](README.md#carrier-switching).

Neither carrier owns its device or its `AudioContext`: `acquireMic` /
`acquireCamera` hand back a `TrackHandle` the carrier releases on
`stopCapture`, and the `AudioContext` reference is dropped on `unbind`, never
closed.

---

## Carriers

### `VoiceCarrier`

```ts
class VoiceCarrier
```

Opus voice over the host's message channel: AudioWorklet capture → Opus encode
→ `host.send('voice', …)` → decode → jitter-buffered playout. Construct with no
arguments; one instance serves every peer.

**Send gate, per encoded packet** (`handleEncodedPacket`): no host → drop;
`host.targets()` empty → drop; `host.cadence() === 'paused'` → drop the frame
*and* discard any partially-accumulated batch (stale audio is never buffered
across a pause). `'voice-only'` still sends. `host.batchEligible()` decides
`{ v: 2, frames }` vs the per-frame shape at every packet; a capability flip
mid-batch flushes the buffered frames per-frame first.

**Mute** is the shared track's `enabled` flag, read per block — muting needs no
carrier call and tears nothing down.

#### `VoiceCarrier.bind(host)`

```ts
bind(host: VoiceHost)
```

Adopts the host and its clock. The receive side is live immediately. Idempotent
in effect but not a re-`bind` guard: binding a second host replaces the first
without tearing down per-peer state — `unbind()` first.

#### `VoiceCarrier.unbind()`

```ts
unbind()
```

Calls `stopCapture()` (fire-and-forget), closes every peer decoder, clears the
stats maps and the codec cache, and drops the `AudioContext` reference **without
closing it** (disposal is the host's). Safe to call unbound.

#### `VoiceCarrier.isBound`

```ts
get isBound(): boolean
```

#### `VoiceCarrier.startCapture()`

```ts
async startCapture(): Promise<boolean>
```

Acquires the mic, configures an encoder, starts the worklet pump, and stamps a
new capture-session epoch (`nextVoiceEpoch`) before acquisition, so a failed
attempt burns an epoch harmlessly rather than reusing one.

Returns `true` if already capturing. Resolves `false` — never rejects — when
unbound, when `AudioWorkletNode` does not exist, when no codec resolves, when
`acquireMic` resolves `null` **or rejects**, when `host.audioContext()` is null,
or when the capture graph fails to build (including a non-48 kHz context);
everything already acquired is released on that path. Each failure logs through
`console.error`, not `host.log`.

#### `VoiceCarrier.stopCapture()`

```ts
async stopCapture(): Promise<void>
```

Stops the pump, closes the encoder, releases the mic handle, resets `seq` to 0
and discards the RED and batch buffers (buffered frames are dropped, not
flushed — they would be stale). Idempotent. The next `startCapture()` is a new
session with a new epoch, which the receiver admits immediately
([README, Carrier switching](README.md#carrier-switching)).

#### `VoiceCarrier.receiveFrame(peer, chunk)`

```ts
receiveFrame(peer: PeerId, chunk: string)
```

Call on every arriving `'voice'` payload. Synchronous end to end: it opens the
peer's decoder on first sight and decodes in the same tick. Accepts both wire
shapes regardless of what the host advertises (`unpackVoicePayload`). Per
payload, admission is `decideVoiceAdmission`; an adopted session logs one
`VoiceSessionAdopt` line through `host.log`.

Drops silently on unparseable JSON, on a non-frame JSON value (no numeric
`seq`), and when no decoder can be opened — no codec (one `console.error` per
peer) or no `AudioContext`. Stamps `peerLastRecvMs` and the rx stats only for
payloads that reach the decode path.

#### `VoiceCarrier.getPlayoutSenderTimeMs(peer)`

```ts
getPlayoutSenderTimeMs(peer: PeerId): number | null
```

Sender wall-clock ms of the audio currently audible from `peer`, projected from
the latest playout anchor along the audio clock (`estimatePlayoutSenderTimeMs`).
`null` when the peer is unknown, has never sent `wts`, the anchor is older than
3 s, or there is no `AudioContext`. Feed it against a clip's `captureT0Ms` to
get A/V skew, then report it with `FilmstripCarrier.setAvSkew`.

#### `VoiceCarrier.playSquelch(direction)`

```ts
playSquelch(direction: 'up' | 'down')
```

Synthesizes a short band-limited noise burst on the host's `AudioContext` — a
join/leave chirp with no asset. No-op when no `AudioContext` is reachable.
Nothing in the library calls it; it is there for the host's roster events.

#### `VoiceCarrier.voiceRxStats`

```ts
voiceRxStats = new Map<PeerId, VoiceRxStats>()
```

Per-peer receive quality over a rolling ~1 s window. Plain maps, not reactive
stores — read them on your own render cycle. Cleared by `unbind`.

#### `VoiceCarrier.peerAudioLevels`

```ts
peerAudioLevels = new Map<PeerId, number>()
```

Peak level (0.0–1.0) of each peer's most recently decoded block, for a meter.

#### `VoiceCarrier.peerLastSentMs`

```ts
peerLastSentMs = new Map<PeerId, number>()
```

Host-clock ms of the last voice frame sent **to** this peer, stamped per target
at actual send time (batching defers it by at most one batch).

#### `VoiceCarrier.peerLastRecvMs`

```ts
peerLastRecvMs = new Map<PeerId, number>()
```

Host-clock ms of the last voice frame received **from** this peer. Same
timebase as `peerLastSentMs`, so a consumer never compares two clocks.

---

### `FilmstripCarrier`

```ts
class FilmstripCarrier
```

Low-fps JPEG video: camera track → `<video>` → `createImageBitmap` → worker →
`OffscreenCanvas.convertToBlob` → `host.send('filmstrip', …)` → decode to an
object URL → subscribers. Construct with no arguments.

**Send gate, per clip**: no host → drop; `host.targets()` empty → drop;
`host.cadence() !== 'full'` → drop. Filmstrip is the heaviest signals payload,
so `'voice-only'` drops it and keeps voice.

#### `FilmstripCarrier.bind(host)`

```ts
bind(host: FilmstripHost)
```

As `VoiceCarrier.bind`. The receive side is live from here.

#### `FilmstripCarrier.unbind()`

```ts
unbind()
```

Calls `stopCapture()` (fire-and-forget), cancels every per-peer inactivity
timer, revokes the retained object URLs, and clears the subscriber, stats and
stamp maps. Subscriptions do not survive it.

#### `FilmstripCarrier.isBound`

```ts
get isBound(): boolean
```

#### `FilmstripCarrier.startCapture()`

```ts
async startCapture(): Promise<boolean>
```

Acquires the camera, hints `contentHint = 'motion'`, spawns the worker
(`host.createWorker?.()` or the default `new URL(…, import.meta.url)` worker)
and starts the sampler at the current fps.

Returns `true` if already capturing. Resolves `false` — never rejects — when
unbound, when `acquireCamera` resolves `null` **or rejects**, when the worker
cannot be spawned, or when the sampler cannot start (no `document`, no
`createImageBitmap`, `video.play()` refused); the camera handle is released on
every one of those paths.

#### `FilmstripCarrier.stopCapture()`

```ts
async stopCapture(): Promise<void>
```

Sends one explicit **stop** payload to the peers it has recently sent to — but
only while bound and only at `'full'` cadence; below that, receivers fall back
to their inactivity TTL. Then stops the sampler, terminates the worker,
releases the camera and resets `seq`. Idempotent.

#### `FilmstripCarrier.receiveFrame(peer, chunk)`

```ts
receiveFrame(peer: PeerId, chunk: string): void
```

Call on every arriving `'filmstrip'` payload. Decodes a clip into an object URL
and hands a `FilmstripFrame` to that peer's subscribers; a `kind: 'stop'`
payload (and the receive-inactivity TTL) delivers `null` instead. Swapped-out
URLs are revoked on a delay, so a subscriber that has not yet painted the new
one is not left pointing at a dead URL.

Drops silently on unparseable JSON. Drops a clip whose geometry could not come
from an honest sender — `n` not an integer in `1..MAX_CLIP_FRAMES`, or `p` not
finite and positive — **before any per-peer state is touched**, warning once per
peer per bind. This is the one declared divergence from Presence's receive path
and the check that keeps a remote sender from wedging `FilmstripPlayback`.

#### `FilmstripCarrier.subscribe(peer, callback)`

```ts
subscribe(
  peer: PeerId,
  callback: (frame: FilmstripFrame | null) => void,
): () => void
```

Subscribe to one peer's frames. The callback fires immediately with that peer's
latest frame if there is one, then on every receive. Returns the unsubscribe
function. A callback that throws is caught and logged on the replay path.

#### `FilmstripCarrier.getLatest(peer)`

```ts
getLatest(peer: PeerId): FilmstripFrame | null
```

Most recent frame for a first paint outside the subscription.

#### `FilmstripCarrier.getFps()`

```ts
getFps(): FilmstripFps
```

Current sender frame rate, derived from the capture period; falls back to 6
when the period does not round to a listed option.

#### `FilmstripCarrier.setFps(fps)`

```ts
setFps(fps: FilmstripFps): void
```

Ignores anything outside `FILMSTRIP_FPS_OPTIONS`. The sampler re-arms
immediately and the period rides the next frame message, so the receiver's
playback period follows on the next clip.

#### `FilmstripCarrier.getCaptureSide()`

```ts
getCaptureSide(): FilmstripCaptureSize
```

Current per-frame edge length in px; falls back to 192.

#### `FilmstripCarrier.setCaptureSide(side)`

```ts
setCaptureSide(side: FilmstripCaptureSize): void
```

Ignores anything outside `FILMSTRIP_CAPTURE_SIZES`. Takes effect on the next
frame.

#### `FilmstripCarrier.setBufferDepth(peer, depth)`

```ts
setBufferDepth(peer: PeerId, depth: number): void
```

Publish a display's queue depth into that peer's stats. Wire it to
`FilmstripPlaybackSinks.depth`.

#### `FilmstripCarrier.setAvSkew(peer, skewMs)`

```ts
setAvSkew(peer: PeerId, skewMs: number | null): void
```

Publish measured audio/video skew (ms, sender timebase, positive = video lags)
into that peer's stats. Rounded on write.

#### `FilmstripCarrier.signalsVideoStats`

```ts
signalsVideoStats = new Map<PeerId, VideoSignalsStats>()
```

Per-peer receive stats on a rolling ~1 s window, plus whatever the display
publishes through `setBufferDepth` / `setAvSkew`.

#### `FilmstripCarrier.peerLastSentMs`

```ts
peerLastSentMs = new Map<PeerId, number>()
```

Host-clock ms of the last clip sent **to** this peer. Also the set
`stopCapture()` addresses its courtesy stop payload to; cleared there.

#### `FilmstripCarrier.peerLastRecvMs`

```ts
peerLastRecvMs = new Map<PeerId, number>()
```

Host-clock ms of the last clip received **from** this peer.

---

## Playback

### `FilmstripPlayback`

```ts
class FilmstripPlayback {
  constructor(sinks: FilmstripPlaybackSinks)
}
```

Receiver-side display pacing for **one** peer's stream, framework-free: a queue
plus a single `setTimeout` chain that pops one frame per period and paints it,
so display cadence is constant even when clip arrivals jitter. Painting is
yours. Usage: [README, Receiving video](README.md#receiving-video).

Playback starts once `BUFFER_CLIPS` clips' worth of frames are queued; an
underrun freezes on the last painted frame and resumes on the next push without
re-buffering; depth above `MAX_BUFFER_CLIPS` clips drops **oldest** frames; a
backlog above ~1.5 clips plays 25% fast (`framePaceMs`) until it drains.

#### `FilmstripPlayback.push(frame)`

```ts
push(frame: FilmstripFrame): void
```

Enqueues `frame.frameCount` entries and starts or resumes the chain. **Trusts
`frameCount` and `periodMs`** — the validation site is
`FilmstripCarrier.receiveFrame`. A host that builds `FilmstripFrame`s from some
other source owns that check itself.

#### `FilmstripPlayback.clear()`

```ts
clear(): void
```

Cancels the pending tick, empties the queue, reports depth 0 and returns to the
pre-first-frame state. Call it on a `null` frame from `subscribe`.

#### `FilmstripPlayback.depth`

```ts
get depth(): number
```

Queued frames (not clips).

### `QueuedFrame`

```ts
interface QueuedFrame {
  url: string;
  index: number;
  count: number;
  periodMs: number;
  width: number;
  captureTimeMs: number;
}
```

One frame handed to `paint`. `url` is the whole clip's filmstrip image and
`index`/`count` say which cell of it to show; `width` is the per-frame edge
length, for scaling. `captureTimeMs` is on the **sender's** wall clock
(`clip t0 + index × period`) — the same clock voice frames stamp as `wts`, so
skew needs no cross-machine clock sync.

### `FilmstripPlaybackSinks`

```ts
interface FilmstripPlaybackSinks {
  paint(frame: QueuedFrame): void;
  depth(frames: number): void;
  timers?: {
    setTimeout(fn: () => void, ms: number): number;
    clearTimeout(id: number): void;
  };
}
```

`paint` is called once per frame at playback cadence; `depth` on every queue
change (wire it to `FilmstripCarrier.setBufferDepth`). `timers` defaults to
`globalThis` and exists so a test can drive the chain deterministically.

### `BUFFER_CLIPS`

```ts
const BUFFER_CLIPS = 1
```

Clips buffered before the first frame is painted. 1 = start on the first clip:
every buffered clip is permanent added latency and directly widens A/V skew.

### `MAX_BUFFER_CLIPS`

```ts
const MAX_BUFFER_CLIPS = 4
```

Hard queue cap in clips. Above it, oldest frames are dropped so a relay burst
cannot become permanent latency.

---

## Capture internals

Exported because the carriers' pumps are useful to test and to reuse, not
because a host normally touches them — `VoiceCarrier` / `FilmstripCarrier` own
one each.

### `VoiceCapture`

```ts
class VoiceCapture {
  async start(
    ctx: AudioContext,
    track: MediaStreamTrack,
    onFrame: (pcm: Float32Array, timestampUs: number) => void,
    moduleUrl: string
  ): Promise<boolean>
  replaceTrack(ctx: AudioContext, track: MediaStreamTrack): void
  stop(): void
}
```

Mic track → `MediaStreamAudioSourceNode` → the `AudioWorkletProcessor` in
`voice-capture-worklet.ts` → 960-sample Float32 blocks, with a zero-gain sink
so engines that only pull connected graphs (WebKit) keep processing.

`start` resolves `false` — never rejects — when `ctx.sampleRate` is not
`VOICE_SAMPLE_RATE`, when `addModule` fails, or when the graph cannot be built;
the caller's failure arm is what releases the device. `addModule` runs once per
context. `replaceTrack` rebinds only the source node, so the frame counter and
therefore encoder timestamps stay continuous across a device change.

### `FilmstripSampler`

```ts
class FilmstripSampler {
  async start(
    track: MediaStreamTrack,
    periodMs: number,
    onSample: (bitmap: ImageBitmap, t0: number) => void,
    timers: SamplerTimers = globalThis
  ): Promise<boolean>
  setPeriod(ms: number, timers: SamplerTimers = globalThis): void
  replaceTrack(track: MediaStreamTrack): void
  stop(timers: SamplerTimers = globalThis): void
}
```

Camera track → a detached `<video>` → `createImageBitmap` on an interval. A
tick that lands while a capture is in flight is skipped, never queued, so a
slow camera cannot build a backlog. `t0` is deliberately wall clock — it is the
cross-carrier sender timebase.

`start` resolves `false` — never rejects — without a `document` or
`createImageBitmap`, or when `video.play()` is refused. `replaceTrack` re-points
the same element, so the interval and period continue uninterrupted. The
`timers` parameter is injectable for tests; its type `SamplerTimers` lives in
`src/filmstrip-sampler.ts` and is not re-exported from the barrel.

### `VOICE_SAMPLE_RATE`

```ts
const VOICE_SAMPLE_RATE = 48000
```

The one sample rate this carrier speaks. The `AudioContext`, the worklet block
and both Opus backends are all configured for it; anything else fails capture.

### `VOICE_FRAME_SAMPLES`

```ts
const VOICE_FRAME_SAMPLES = 960
```

Samples per Opus frame — 20 ms at `VOICE_SAMPLE_RATE`.

---

## Host interfaces

The seam. The library owns encode/decode, pacing and admission; the host owns
the channel, the devices, the clock and the log sink. `src/types.ts` is the
authority; see [README, The host record](README.md#the-host-record).

### `MediaHost`

```ts
interface MediaHost {
  targets(): ReadonlySet<PeerId>;
  cadence(): SignalsMediaCadence['mode'];
  send(kind: MediaKind, payload: string, targets: ReadonlySet<PeerId>): Promise<void>;
  clock: MediaClock;
  log(line: string): void;
}
```

- `targets()` is read at **every** encode — moving a peer between carriers is a
  set change, not a library call. Empty = the frame is dropped.
- `cadence()` is read at every encode too. A host without an RTT measure
  returns `'full'`.
- `send` is broadcast: one payload for the whole target set. A rejection is
  swallowed by the carriers (`.catch(() => {})`); retry policy is the host's.
- `log` receives the library's few narrative lines (session adoption, throttled
  rx and playout-reset lines). Failure paths use `console.error` instead — see
  [README, Stats and forensics](README.md#stats-and-forensics).

### `VoiceHost`

```ts
interface VoiceHost extends MediaHost {
  acquireMic(onTrackChanged: (track: MediaStreamTrack) => void): Promise<TrackHandle | null>;
  audioContext(): AudioContext | null;
  batchEligible(): boolean;
  workletModuleUrl?(): string;
  codec?(): OpusCodec;
}
```

`acquireMic` may resolve `null` or reject — both read as "no mic", and
`startCapture()` resolves `false`. Call `onTrackChanged` when the shared device
is replaced; the carrier rebinds without restarting the session.
`audioContext()` must be a resumed 48 kHz context, shared with playout.
`batchEligible()` must be true only when **every current target** parses a
batch ([README, Batching and the capability gate](README.md#batching-and-the-capability-gate)).
`codec()` is asked once per bind and cached until `unbind`; one that throws
reads as "no codec".

### `FilmstripHost`

```ts
interface FilmstripHost extends MediaHost {
  acquireCamera(onTrackChanged: (track: MediaStreamTrack) => void): Promise<TrackHandle | null>;
  createWorker?(): Worker;
}
```

Same acquisition contract as `acquireMic`. `createWorker` overrides the default
`new URL('./filmstrip-worker.js', import.meta.url)` resolution — pass
`createInlineFilmstripWorker` where a bundler neither emits nor inlines the
asset.

### `TrackHandle`

```ts
interface TrackHandle {
  track: MediaStreamTrack;
  release(): void;
}
```

A lease, not ownership: the carrier calls `release()` on `stopCapture` and
reads `track.enabled` as the mute gate, but never stops the track itself. A
host sharing one device between consumers refcounts behind `release`.

### `MediaClock`

```ts
interface MediaClock {
  now(): number;
}
```

Adopted at `bind`. Every host-visible stamp (`peerLastSentMs`,
`peerLastRecvMs`, admission's quiet window) rides it. Wire-timestamp
arithmetic — jitter, transit, `wts`, `t0`, the epoch — stays on wall clock,
because those compare against another machine's payload.

### `PeerId`

```ts
type PeerId = string
```

Whatever string identifies a peer on your channel. The library treats it as
opaque and only slices it for log lines; Presence uses a base64 agent pubkey.

### `MediaKind`

```ts
type MediaKind = 'voice' | 'filmstrip'
```

Which carrier a payload belongs to, passed to `MediaHost.send`. Map it onto
your channel's own type field — Presence sends it as the zome's `msg_type`.

### `VoiceRxStats`

```ts
interface VoiceRxStats {
  jitterMs: number | null;
  lossPercent: number | null;
}
```

Voice receive quality over the rolling window, per peer.

### `VideoSignalsStats`

```ts
interface VideoSignalsStats {
  jitterMs: number | null;
  lossPercent: number | null;
  kbps: number | null;
  fpsActual: number | null;
  bufferDepth: number | null;
  transitMs: number | null;
  avSkewMs: number | null;
}
```

Filmstrip receive quality per peer. `bufferDepth` and `avSkewMs` are written by
the display through `setBufferDepth` / `setAvSkew`, not by the receive path.
`transitMs` is the one cross-clock figure by construction (receiver wall clock
minus the sender's `ts`), so it carries any clock offset between the machines.

### `FilmstripFrame`

```ts
interface FilmstripFrame {
  url: string;
  width: number;
  height: number;
  frameCount: number;
  periodMs: number;
  captureT0Ms: number;
}
```

One decoded clip: an object URL for the stacked JPEG filmstrip, the per-frame
geometry, and the sender-clock capture time of frame 0 (derived from `ts` on
legacy clips without `t0`). Delivered by `subscribe` / `getLatest`, consumed by
`FilmstripPlayback.push`.

---

## Codec seam

Wire bytes are raw Opus packets either way, and the two backends interoperate.
See [README, Opus backends](README.md#opus-backends).

### `OpusCodec`

```ts
interface OpusCodec {
  name: 'webcodecs' | 'wasm' | string;
  createEncoder(
    onPacket: (p: OpusPacket) => void,
    onError: (e: unknown) => void
  ): OpusEncoder;
  createDecoder(
    onPcm: (pcm: Float32Array, timestampUs: number) => void,
    onError: (e: unknown) => void
  ): OpusDecoder;
}
```

Both factories are **synchronous** and may throw — the receive path opens a
decoder and decodes in the same tick. Anything genuinely asynchronous belongs
in acquiring the backend (`wasmOpus()`), not in creating an encoder from one. A
throw is contained: `startCapture()` returns `false`, `receiveFrame` drops the
frame. Backends are configured 48 kHz mono, 20 ms frames, ~24 kbps.

### `OpusEncoder`

```ts
interface OpusEncoder {
  encode(pcm: Float32Array, timestampUs: number): void;
  flush(): Promise<void>;
  close(): void;
}
```

`encode` takes one `VOICE_FRAME_SAMPLES` block; packets come back through the
factory's `onPacket`, errors through `onError`. `close` is called on
`stopCapture` and must tolerate being called twice.

### `OpusDecoder`

```ts
interface OpusDecoder {
  decode(packet: OpusPacket): void;
  close(): void;
}
```

One decoder per peer, closed on `unbind`. PCM comes back through the factory's
`onPcm`.

### `OpusPacket`

```ts
interface OpusPacket {
  type: 'key' | 'delta';
  timestampUs: number;
  data: Uint8Array;
}
```

The unit crossing the seam. `data` is base64-encoded onto the wire as a frame's
`data`, and `timestampUs` becomes its `ts`. The WASM backend always reports
`'key'` (Opus has no delta frames; the field exists for wire compatibility).

### `webCodecsOpus`

```ts
function webCodecsOpus(): OpusCodec | null
```

The default backend, `name: 'webcodecs'`. Returns `null` when this engine has
no WebCodecs **audio** — the video codecs alone are not enough, which is
exactly what Safari 16.4–18.x ship. Called by the carrier when the host
provides no `codec()`; the carrier never falls back to the WASM backend on its
own.

### `wasmOpus`

```ts
function wasmOpus(): Promise<OpusCodec>
```

Imported from `@lightningrodlabs/signals-media/opus-wasm` — never from the
barrel, so a host that does not need it never loads `libopus-wasm` (an optional
dependency you must install yourself). Instantiates the WASM module and
resolves to a codec, `name: 'wasm'`; resolve it once and hand it to
`host.codec`.

Because `libopus-wasm` creates handles asynchronously, its
`createEncoder`/`createDecoder` return **queueing facades**: synchronous objects
that buffer input in a bounded FIFO until the handle resolves, then drain in
order. A rejection reports once through `onError` and the facade goes inert;
closing before the handle is ready closes it on resolve.

### `WASM_PENDING_MAX`

```ts
const WASM_PENDING_MAX = 50
```

Facade queue depth — 1 s of 20 ms audio. Overflow drops the **oldest** item and
warns once per facade. Also from the `./opus-wasm` subpath.

---

## Decisions

Pure functions: snapshot in, tagged union out, table-testable, no mocks. A host
may call them directly; the carriers already do where they apply.

### `decidePlayout`

```ts
function decidePlayout(
  head: number,
  now: number,
  frameDurationSec: number,
  jitterSec: number,
  driftSec: number,
): PlayoutDecision
```

Where — or whether — to schedule one decoded frame, all times on the
`AudioContext` clock in seconds. Head behind real time re-anchors forward to
`now + jitter` (`first` on the very first frame, otherwise `behind`); head
further ahead than `jitter + drift` **drops** the frame to shed depth, because
re-anchoring backward would overlap audio already scheduled; otherwise it
schedules at the head (`steady`). The drop arm is the fix for voice playing on
top of itself after a burst.

### `decidePlayoutLegacy`

```ts
function decidePlayoutLegacy(
  head: number,
  now: number,
  frameDurationSec: number,
  jitterSec: number,
  driftSec: number,
): { at: number; nextPlaybackTime: number }
```

The pre-fix behavior — always plays, snapping the head backward on a deep
buffer. **Not used in production.** Exported so a test can demonstrate the
overlap `decidePlayout` prevents; a negative control, not an option.

### `PlayoutDecision`

```ts
interface PlayoutDecision {
  action: 'play' | 'drop';
  at: number;
  nextPlaybackTime: number;
  reason: PlayoutReason;
}
```

`at` is `NaN` when `action === 'drop'`. `nextPlaybackTime` is the caller's new
head either way.

### `PlayoutReason`

```ts
type PlayoutReason = 'first' | 'behind' | 'steady' | 'overcap-drop'
```

Which branch fired. `overcap-drop` accumulating is the signature of a bursty
channel, and is what the throttled `VoicePlayoutReset` log line reports.

### `decideVoiceAdmission`

```ts
function decideVoiceAdmission(s: VoiceAdmissionSnapshot): VoiceAdmission
```

The one decision for whether an incoming voice payload enters the decode path.
Same epoch → plain seq dedupe. Newer epoch (or none adopted yet) → adopt the
session and reset the seq high-water. Older epoch → drop while the adopted
session is live, but adopt anyway after `VOICE_SESSION_ADOPT_GAP_MS` of silence,
so a sender whose wall clock stepped backwards cannot deafen the receiver
forever. Frames with no `ep` keep the pre-epoch dedupe exactly, including its
restart deafness — a declared limitation.

### `VoiceAdmissionSnapshot`

```ts
interface VoiceAdmissionSnapshot {
  epoch: number | null;
  seq: number;
  lastEpoch: number | null;
  lastSeq: number;
  msSinceAccepted: number | null;
}
```

`epoch` is the frame's `ep` (null on legacy senders); `lastSeq` 0 means nothing
accepted yet; `msSinceAccepted` is on the host clock, null if nothing was ever
accepted.

### `VoiceAdmission`

```ts
type VoiceAdmission =
  | { action: 'accept'; reason: 'legacy' | 'in-session' }
  | { action: 'adopt-session'; reason: 'first-epoch' | 'newer-epoch' | 'quiet-stale-epoch' }
  | { action: 'drop'; reason: 'stale-seq' | 'stale-epoch' };
```

On `adopt-session` the caller resets the seq high-water **and** the per-session
playout mappings (anchor, wts index), then treats the frame as accepted.

### `nextVoiceEpoch`

```ts
function nextVoiceEpoch(nowMs: number, prevEpoch: number): number
```

The epoch for a new capture session: the sender's wall clock, forced strictly
past the previous one. Wall clock deliberately — the epoch is compared only
against the same sender's earlier values, so cross-restart uniqueness is the
whole job and cross-machine comparison never happens.

### `VOICE_SESSION_ADOPT_GAP_MS`

```ts
const VOICE_SESSION_ADOPT_GAP_MS = 2000
```

Quiet window before an older-epoch stream is adopted as a new session.
Declared **not** a liveness predicate: it serves voice admission only.

### `decideSignalsMediaCadence`

```ts
function decideSignalsMediaCadence(inputs: {
  carrierDown: boolean;
  bestRttEwmaMs: number | undefined;
  prevMode: SignalsMediaCadence['mode'];
}): SignalsMediaCadence
```

How much media to keep sending as the channel degrades. Hysteretic: escalates
(`full` → `voice-only` → `paused`) the instant a threshold is crossed, recovers
one level per evaluation and only below half the threshold that would re-trigger
it. `bestRttEwmaMs` is the **minimum** across current targets; `undefined` (no
sample) is `'full'`. `carrierDown` is a liveness fact the host supplies — this
function does not re-derive it. A worked host-side RTT loop is in
[README, Carrier switching](README.md#carrier-switching).

### `SignalsMediaCadence`

```ts
type SignalsMediaCadence =
  | { mode: 'full'; reason: 'healthy' | 'no-sample' }
  | { mode: 'voice-only'; reason: 'rtt-degraded' }
  | { mode: 'paused'; reason: 'carrier-down' | 'rtt-collapsed' };
```

`MediaHost.cadence()` returns the `mode` half. `'voice-only'` drops filmstrip
clips and keeps voice; `'paused'` drops both and discards the partial voice
batch rather than sending stale audio.

### `SIGNALS_RTT_DEGRADED_MS`

```ts
const SIGNALS_RTT_DEGRADED_MS = 2_000
```

Escalation threshold to `'voice-only'`. Declared **not** a liveness predicate —
it decides what to send, never whether a peer is present.

### `SIGNALS_RTT_COLLAPSED_MS`

```ts
const SIGNALS_RTT_COLLAPSED_MS = 5_000
```

Escalation threshold to `'paused'`. Same declaration.

### `estimatePlayoutSenderTimeMs`

```ts
function estimatePlayoutSenderTimeMs(
  anchor: Pick<PlayoutAnchor, 'senderWtsMs' | 'atCtxSec'>,
  ctxNowSec: number,
): number
```

Projects an anchor forward (or back) along the audio clock to give the sender
wall-clock time of the audio audible right now. Both inputs ride the same
`AudioContext` clock, so the projection is exact to one frame.
`VoiceCarrier.getPlayoutSenderTimeMs` is this with the staleness check.

### `PlayoutAnchor`

```ts
interface PlayoutAnchor {
  senderWtsMs: number;
  atCtxSec: number;
  setAtMs: number;
}
```

One scheduled frame's sender capture time mapped onto the local audio clock,
plus the local wall-clock ms it was written for the staleness check.

### `framePaceMs`

```ts
function framePaceMs(
  queueLen: number,
  clipFrameCount: number,
  periodMs: number,
): number
```

Display pacing for the filmstrip queue: above ~1.5 clips of backlog, return 75%
of the period (play 25% fast) to drain it; otherwise the period unchanged.
Draining is preferred to dropping because a drop is a visible jump, and a
standing backlog is permanent added latency and A/V skew.

---

## Wire helpers

The four payload shapes are recorded in `src/__tests__/fixtures/wire.json` and
described in [README, Wire format](README.md#wire-format).

### `packVoiceFrames`

```ts
function packVoiceFrames(frames: VoiceFramePayload[]): string
```

The batch envelope, `{ v: 2, frames }`. Byte-equality against the fixture is
pinned by `wire-fixture.test.ts`.

### `unpackVoicePayload`

```ts
function unpackVoicePayload(json: string): VoiceFramePayload[]
```

Inverse, tolerant of legacy senders: a v2 batch yields its frames, any other
JSON value is treated as one single-frame payload. Throws only on non-JSON —
callers keep their own drop-one-signal `try`/`catch`. Receivers parse both
formats regardless of what they advertise; `batchEligible()` gates only what is
**sent**.

### `VoiceFrame`

```ts
interface VoiceFrame {
  seq: number;
  ts: number;
  type: 'key' | 'delta';
  data: string;
  wts?: number;
  ep?: number;
}
```

`seq` restarts at 1 per capture session; `ts` is the encoder timestamp in µs;
`data` is the base64 Opus packet; `wts` is the sender's wall clock at encoder
output (the cross-carrier timebase filmstrip stamps as `t0`); `ep` is the
capture-session epoch. Absent `wts`/`ep` mean a legacy sender.

### `VoiceFramePayload`

```ts
interface VoiceFramePayload extends VoiceFrame {
  red?: VoiceFrame[];
}
```

What actually goes on the wire. `red` carries the immediately preceding frames,
oldest first, so a packet lost in flight is recoverable from the copy riding a
later one. On the batched path the block rides the batch's first frame only.

### `VOICE_BATCH_FRAMES`

```ts
const VOICE_BATCH_FRAMES = 3
```

Frames per batched voice signal. Trades up to `VOICE_BATCH_FRAMES × 20 ms` of
send latency — inside the jitter buffer — for a third of the packet rate.
Declared **not** a liveness threshold: it serves send cadence only.

### `MAX_CLIP_FRAMES`

```ts
const MAX_CLIP_FRAMES = 64
```

Upper bound on a clip's declared frame count `n` that the receive path will act
on. Far above any honest value — this package sends `n: 1` — and far below one
that could wedge the playback loop.

### `FILMSTRIP_FPS_OPTIONS`

```ts
const FILMSTRIP_FPS_OPTIONS = [1, 2, 3, 4, 5, 6, 7] as const
```

Sender frame rates `setFps` accepts. 6 is the tested reliable ceiling and the
default; 7 is one step above it for experimentation; 8 was tested and proved
unreliable.

### `FilmstripFps`

```ts
type FilmstripFps = typeof FILMSTRIP_FPS_OPTIONS[number]
```

### `FILMSTRIP_CAPTURE_SIZES`

```ts
const FILMSTRIP_CAPTURE_SIZES = [48, 64, 96, 128, 160, 192, 256] as const
```

Sender capture resolutions in px per (square) frame, accepted by
`setCaptureSide`. Larger = crisper, more bytes/s.

### `FilmstripCaptureSize`

```ts
type FilmstripCaptureSize = typeof FILMSTRIP_CAPTURE_SIZES[number]
```

### `FILMSTRIP_RX_LOG_INTERVAL_MS`

```ts
const FILMSTRIP_RX_LOG_INTERVAL_MS = 30_000
```

How often, at most, the receive side writes one `FilmstripRx` line per peer
into `host.log`. A reporting cadence that bounds log volume, **not** a liveness
window.

---

## Worker and worklet delivery

Fallbacks for bundlers that neither emit nor inline the two separate script
entry points. In a source checkout both are backed by empty sources — the real
strings are generated into `dist/` by `npm run build`. See
[README, Worker and worklet delivery](README.md#worker-and-worklet-delivery).

### `createInlineFilmstripWorker`

```ts
function createInlineFilmstripWorker(): Worker
```

A filmstrip worker over a Blob URL of the inlined source; the URL is revoked
immediately, since the `Worker` holds its own reference. Assign to
`FilmstripHost.createWorker`.

### `voiceWorkletModuleUrl`

```ts
function voiceWorkletModuleUrl(): string
```

A Blob URL for the capture worklet module. **Not** revoked — `addModule` may
fetch it later. Assign to `VoiceHost.workletModuleUrl`.

---

## Base64

### `bytesToBase64`

```ts
function bytesToBase64(bytes: Uint8Array): string
```

`btoa` over a chunked `String.fromCharCode`, so a large input cannot overflow
the stack. This is how Opus packets and JPEG filmstrips reach the string wire.

### `base64ToBytes`

```ts
function base64ToBytes(b64: string): Uint8Array
```

Inverse. Exported for hosts that record or replay payloads; the carriers use
both internally.
