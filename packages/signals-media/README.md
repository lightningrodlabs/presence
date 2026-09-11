# @lightningrodlabs/signals-media

Opus voice and low-fps JPEG video between peers **over any message channel** —
no WebRTC, no ICE, no TURN. You bring the transport (Holochain remote signals, a
WebSocket, anything that moves a string to a peer); the library owns capture,
encode, pacing, admission, decode and playout.

It exists because WebRTC is not always available or not always usable:

- **No WebRTC at all.** WebRTC is compiled out of stock WebKitGTK 2.52 builds
  (nixpkgs and Ubuntu 24.04 both) — `RTCPeerConnection` does not exist, and the
  `enable-webrtc` setting reads back `true` while it still does not exist. On
  Linux Tauri this carrier is the only carrier. Evidence:
  [`docs/webkitgtk-probe/FINDINGS.md`](docs/webkitgtk-probe/FINDINGS.md).
- **WebRTC available but relayed.** Where a direct ICE path fails, the choice is
  between running TURN and sending the media over the message channel you
  already have. This library makes that a per-peer, host-side decision — see
  [Carrier switching](#carrier-switching).

The code is Presence's shipping signals carrier (`lightningrodlabs/presence`),
lifted out of its store and re-targeted at an injected host record. The wire
format is meant to be byte-identical to Presence 0.15.6's. What is actually
tested: `src/__tests__/fixtures/wire.json` records the four payload shapes,
derived by reading Presence's construction sites at `ab90584`, and
`wire-fixture.test.ts` drives this package's carriers through a fake host and
asserts the payloads they emit carry exactly those keys, in that order. Nothing
in the suite talks to a real Presence peer, so interop is an inference from
those two halves rather than a tested property.

```sh
npm install @lightningrodlabs/signals-media
# only if you must run Opus without WebCodecs (WKWebView before Safari 26):
npm install libopus-wasm
```

TypeScript, ESM only, no runtime dependencies (`libopus-wasm` is an optional
dependency reached through the `./opus-wasm` subpath and nothing else).

---

## Browser support

| Engine | Capture | Opus | Notes |
|---|---|---|---|
| **Chromium** — Chrome, Edge, Electron, Android WebView, WebView2 | AudioWorklet + `<video>`/`createImageBitmap` | WebCodecs | Full support. The Playwright gate runs here. |
| **WebKitGTK 2.52+** — Linux Tauri/GTK | same | WebCodecs (over GStreamer) | Works, and is the *only* carrier: no WebRTC. Needs the three runtime pieces below. |
| **WKWebView** — macOS / iOS | same | WebCodecs from Safari 26 / macOS 26 / iOS 26; `wasmOpus()` before that | `AudioEncoder`/`AudioDecoder` shipped in Safari 26. Older OSes need the WASM backend. |
| **WebView2** — Windows | same | WebCodecs | Chromium; same support as Chromium, plus WebView2's `PermissionRequested`. |

There is **one capture path per medium** and it is the portable one:
`getUserMedia` track → `MediaStreamAudioSourceNode` → an `AudioWorkletProcessor`
that posts 20 ms (960-sample, 48 kHz) blocks, and camera track → a detached
`<video>` → `createImageBitmap` → worker → `OffscreenCanvas.convertToBlob`.
`MediaStreamTrackProcessor` is deliberately not used — WebKit does not implement
it for audio.

**WebKitGTK needs three things from the embedder**, none of which this library
can do for you (all three are in the testbed's `src-tauri/src/lib.rs`):

1. `set_enable_media_stream(true)` and `set_enable_media_capabilities(true)` on
   the webview, then reload.
2. A `permission-request` handler that allows. WebKit's default handler
   **denies**, so `getUserMedia` fails with `NotAllowedError` in a stock Tauri
   app: `connect_permission_request(|_, r| { r.allow(); true })`.
3. GStreamer plugins findable at runtime — `base`, `good`, **`bad`**,
   `pipewire` (or `pulseaudio`), and `libav`. WebKitGTK's media backend *is*
   GStreamer: without plugins there is no `AudioContext`, no Opus and no
   devices. `bad` is not optional — without it WebKit 2.52 asks for
   `autovideoflip`, does not find it, and the camera silently produces blank
   frames.

Verified on 2026-09-10: WebKitGTK **2.52.5** with GStreamer **1.26.11** under
Tauri **2.11.5** / wry **0.55.1** — selftest and a two-instance room both pass
with a real mic and a real V4L2 camera; the Chromium Playwright gate passes,
including a cross-backend Opus case (WASM sender → WebCodecs receiver and the
reverse). Android: the debug APK builds and its permissions are verified; the
on-device run is pending a device. macOS, iOS and Windows are configured, with
per-platform run procedures, and their runs are pending hardware. The record,
with commands and transcripts, is [`testbed/README.md`](testbed/README.md).

---

## Carrier switching

The host owns the carrier decision per peer. The library owns making the switch
cheap. The contract:

- **`targets()` is read at every encode.** Moving a peer between carriers is a
  host-side set change and needs no library call: a peer removed from the set
  stops receiving on the next frame; a peer added starts on the next frame. An
  empty set drops the frame.
- **A target-set change does NOT restart capture**, so the receiver keeps the
  same capture-session epoch and records no session adoption. Adoption is not
  the mechanism that makes a switch work — continuity is.
- **Only `stopCapture()` + `startCapture()` produce a new epoch.** That is the
  reconciler shape a host uses when the target set empties and later refills:
  `startCapture()` when the set first becomes non-empty, `stopCapture()` when it
  empties. The device handle is the host's (`acquireMic` hands back a
  `TrackHandle` the carrier releases; the host can keep the underlying device
  open), and the worklet module is loaded once per `AudioContext`, so a restart
  costs about one encoder configure. **Measured 54–75 ms** across Chromium gate
  runs, from `stopCapture()` + `startCapture()` to the first voice frame handed
  to `host.send`.
- **A restart is admitted immediately by the receiver.** Every capture session
  stamps a new `ep` on its frames and restarts `seq` at 1;
  `decideVoiceAdmission` admits the new session against the old high-water
  instead of dropping it, so a WebRTC → signals → WebRTC → signals sequence
  never deafens. (Senders that omit `ep` — anything older than Presence's
  2026-08-26 fix — keep the pre-epoch behavior; that is a declared limitation.)
- **`cadence()` needs an RTT measure to be useful.** A host without one returns
  `'full'`.

A minimal host-side RTT loop feeding `decideSignalsMediaCadence`:

```ts
import { decideSignalsMediaCadence, type SignalsMediaCadence } from '@lightningrodlabs/signals-media';

let rttEwmaMs: number | undefined;          // per-channel, EWMA over pong echoes
let mode: SignalsMediaCadence['mode'] = 'full';
const sentAt = new Map<string, number>();   // nonce -> send time

setInterval(() => {
  const nonce = crypto.randomUUID();
  sentAt.set(nonce, Date.now());
  void myChannel.send('ping', nonce, myTargets());          // your transport
  // Re-evaluate on the same tick the pings go out.
  mode = decideSignalsMediaCadence({
    carrierDown: rttEwmaMs === undefined && sentAt.size > 3, // nothing echoed back
    bestRttEwmaMs: rttEwmaMs,                                // min across targets
    prevMode: mode,
  }).mode;
}, 3000);

export function onPong(nonce: string) {                      // your transport
  const t = sentAt.get(nonce);
  if (t === undefined) return;
  sentAt.delete(nonce);
  const rtt = Date.now() - t;
  rttEwmaMs = rttEwmaMs === undefined ? rtt : 0.2 * rtt + 0.8 * rttEwmaMs;
}
```

`decideSignalsMediaCadence` is hysteretic: it escalates
(`full` → `voice-only` → `paused`) the instant a threshold is crossed, and
recovers one level per evaluation and only below half the threshold that would
re-trigger it. `'voice-only'` drops filmstrip clips and keeps voice;
`'paused'` drops both, and a paused voice batch is discarded rather than sent
stale. The thresholds (`SIGNALS_RTT_DEGRADED_MS`, `SIGNALS_RTT_COLLAPSED_MS`)
are **cadence control, not a liveness predicate** — never reuse them to decide
whether a peer is present.

---

## Integration

### The host record

Everything ambient is injected. `MediaHost` is the common half; `VoiceHost` and
`FilmstripHost` add their device accessor.

```ts
import { VoiceCarrier, FilmstripCarrier, type VoiceHost, type FilmstripHost } from '@lightningrodlabs/signals-media';

const host: VoiceHost & FilmstripHost = {
  // Read at EVERY encode. Empty = the frame is dropped.
  targets: () => currentSignalsPeers,                  // ReadonlySet<PeerId>
  cadence: () => mode,                                 // 'full' | 'voice-only' | 'paused'
  batchEligible: () => everyTargetAdvertisesBatching(),
  async send(kind, payload, targets) {                 // kind: 'voice' | 'filmstrip'
    await sendToPeers(kind, payload, [...targets]);
  },
  clock: { now: () => Date.now() },                    // your monotonic-enough clock
  log: line => myLogger.log(line),

  audioContext: () => sharedAudioContext,              // 48 kHz, gesture-unlocked
  async acquireMic(onTrackChanged) { /* -> { track, release() } | null */ },
  async acquireCamera(onTrackChanged) { /* -> { track, release() } | null */ },
};

const voice = new VoiceCarrier();
const filmstrip = new FilmstripCarrier();
voice.bind(host);            // the receive side is live once bound
filmstrip.bind(host);
```

`bind(host)` makes the receive side live; `unbind()` tears down playout, clears
per-peer state and stops capture. Sending starts at `startCapture()`.

### Wiring the channel

The library never touches your transport. You call `receiveFrame` when a payload
arrives, and implement `send` however you like. Over Holochain remote signals the
zome pair is a generic message send plus the remote-signal receiver — in
Presence's room zome (`dnas/presence/zomes/coordinator/room/src/remote_signals.rs`):

```rust
// send_message(SendMessageInput { to_agents, msg_type, payload })
//   -> send_remote_signal(SignalPayload::Message { from_agent, msg_type, payload })
// recv_remote_signal(..) -> emit_signal(..)  // reaches the RECEIVING agent's UI
```

`msg_type` carries the `MediaKind` (`'voice'` / `'filmstrip'`) and `payload`
carries the library's string verbatim. On the client — this is the
`@holochain/client` ^0.21 shape, where `on('signal')` hands you a tagged
`Signal` and the zome payload sits under `value.payload`:

```ts
import { SignalType, encodeHashToBase64 } from '@holochain/client';

client.on('signal', signal => {
  if (signal.type !== SignalType.App) return;          // 'app' | 'system'
  const { from_agent, msg_type, payload } = signal.value.payload as {
    from_agent: Uint8Array; msg_type: string; payload: string;
  };
  const peer = encodeHashToBase64(from_agent);
  if (msg_type === 'voice') voice.receiveFrame(peer, payload);
  else if (msg_type === 'filmstrip') filmstrip.receiveFrame(peer, payload);
});
```

If you already use `@holochain-open-dev/utils`, `ZomeClient.onSignal` unwraps
the envelope for you and hands the zome payload straight to the callback —
that is what Presence does.

`receiveFrame` is synchronous end to end: it opens the peer's decoder and
decodes in the same tick, and drops the frame if a decoder cannot be
configured. A malformed payload is dropped silently.

### The AudioContext

One shared `AudioContext` at **48 kHz**, created and resumed inside a user
gesture, used for both capture and playout. `startCapture()` fails (returns
`false`, with a `console.error` line) if `audioContext()` is null or its
`sampleRate` is not 48000 — 48 kHz is what the Opus encoder is configured for
and what the worklet's 960-sample block assumes. Browsers hand out a 44.1 kHz
context by default on some devices, so ask for it explicitly:

```ts
const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
await ctx.resume();   // inside a click/tap handler
```

### Capture lifecycle

`startCapture()` on unmute, `stopCapture()` on mute — or, if you prefer
Presence's shape, drive them from the target set (see
[Carrier switching](#carrier-switching)). Both are idempotent and `startCapture`
resolves `false` rather than throwing when a device, the AudioContext, the
worklet or the codec is unavailable; everything it did acquire is released on
that path.

Momentary muting is cheaper than a stop: the carrier reads the shared track's
`enabled` flag at every block and drops muted audio without tearing anything
down (frames encoded while muted are dropped, never buffered — buffered audio
would be stale by the length of the mute).

### Batching and the capability gate

`batchEligible()` is yours to decide and must be true only when **every current
target** can parse a batch — one payload goes to all of them, so a single legacy
peer forces the per-frame format for everyone. Presence gates it on its own
`voice-batch-v1` capability string; the capability vocabulary is host business,
the `{ v: 2, frames }` format is the library's. Receivers parse both formats
regardless of what they advertise. Batching trades up to
`VOICE_BATCH_FRAMES × 20 ms = 60 ms` of send latency (inside the jitter buffer)
for a third of the packet rate.

### Signal sizes to expect

Arithmetic from the encoder's 24 kbps target and base64 (not a measurement):

| Payload | Rate | Bytes on the wire |
|---|---|---|
| Voice, per-frame with RED | 50/s | ~370 B (~18 KB/s) |
| Voice, batched (3 frames + one RED block) | ~17/s | ~560 B (~9 KB/s) |
| Filmstrip clip, 128×96 JPEG q0.6, 1 frame/clip | 6/s | a few KB |

If your channel has a per-message size limit or a rate limit, voice is the
constraint on packet *rate* and filmstrip on *size*. Both directions are
broadcast: one payload per target set, not per peer.

---

## Wire format

JSON strings. Four shapes, recorded byte-for-byte in
`src/__tests__/fixtures/wire.json`. `wire-fixture.test.ts` pins the fixture's
own consistency AND what this package's senders emit — key sets and key order,
compared against the fixture at `host.send`. The fixture's own provenance is a
reading of Presence's construction sites at `ab90584`, not a captured trace.

**Voice, per-frame** (`msg_type: 'voice'`) — the shape every released build
parses:

```jsonc
{
  "seq": 7,             // per capture session, starts at 1
  "ts": 140000,         // encoder timestamp, µs (WebCodecs timebase)
  "type": "delta",      // 'key' | 'delta'
  "data": "+PgA",       // base64 Opus packet
  "wts": 1757548800143, // sender wall-clock ms at encoder output (A/V sync)
  "ep": 3,              // capture-session epoch
  "red": [ /* the 2 preceding frames, oldest first, same shape minus `red` */ ]
}
```

**Voice, batched** — `packVoiceFrames` output; the RED block rides the batch's
first frame only:

```jsonc
{ "v": 2, "frames": [ /* VOICE_BATCH_FRAMES frames */ ] }
```

**Filmstrip clip** (`msg_type: 'filmstrip'`) — `kind` is omitted by the sender;
a receiver accepts an explicit `"clip"`:

```jsonc
{
  "seq": 12, "ts": 1757548800500,   // ts: wall-clock ms when sent
  "w": 128, "h": 96,                // single-frame size
  "n": 1, "p": 167,                 // frame count, playback period ms
  "t0": 1757548800333,              // capture time of frame 0, sender wall clock
  "data": "/9j/4AAQ…"               // base64 JPEG filmstrip (n frames stacked)
}
```

**Filmstrip stop** — sent when the sender turns video off, so the receiver
clears its display without waiting for the inactivity TTL:

```jsonc
{ "kind": "stop", "seq": 13, "ts": 1757548801000 }
```

Absent optional fields (`wts`, `ep`, `red`, `t0`, `kind`) mean a legacy sender;
receivers fall back rather than drop. `wts` and `t0` are the *same sender wall
clock*, which is what lets a receiver measure A/V skew without any clock sync
between machines.

---

## Receiving video

`FilmstripCarrier.receiveFrame` decodes a clip into an object URL and hands it
to subscribers. `FilmstripPlayback` is the framework-free pacing half lifted out
of Presence's Lit element: queue, burst pacing, buffer cap, first-clip start,
underrun resume, depth reporting. Painting is yours.

```ts
import { FilmstripPlayback } from '@lightningrodlabs/signals-media';

const playback = new FilmstripPlayback({
  paint: frame => { img.src = frame.url; },
  depth: n => filmstrip.setBufferDepth(peer, n),   // feeds the stats readout
});

const unsubscribe = filmstrip.subscribe(peer, frame => {
  if (frame === null) playback.clear();            // sender stopped, or TTL expired
  else playback.push(frame);
});
```

A `null` frame means "clear the display": an explicit stop payload arrived, or
the receive-inactivity TTL fired. `subscribe` replays the peer's latest frame
immediately if there is one, and returns an unsubscribe function. `getLatest`
is there for a first paint outside the subscription.

If you compute audio/video skew (`VoiceCarrier.getPlayoutSenderTimeMs(peer)`
projects the peer's current playout position onto the *sender's* wall clock,
against the clips' `t0`), report it back with
`filmstrip.setAvSkew(peer, skewMs)` so it appears in the video stats.

---

## Stats and forensics

Per-peer, updated as frames arrive:

- `voice.voiceRxStats: Map<PeerId, { jitterMs, lossPercent }>`
- `voice.peerAudioLevels: Map<PeerId, number>` — peak of the most recently
  decoded block, for a level meter
- `filmstrip.signalsVideoStats: Map<PeerId, VideoSignalsStats>` —
  `jitterMs`, `lossPercent`, `kbps`, `fpsActual`, `bufferDepth`, `transitMs`,
  `avSkewMs`
- `voice.peerLastSentMs` / `voice.peerLastRecvMs`, and the same pair on
  `filmstrip` — both stamped on `host.clock`, so a consumer never compares two
  clocks. `transitMs` is the exception by construction: it subtracts the
  sender's `ts` (wall clock) from the receiver's wall clock.
- `voice.getPlayoutSenderTimeMs(peer)` — playout position on the sender's
  timebase, or `null` when nothing anchored is flowing.

`host.log` is the library's log sink, and in 0.1.0 exactly three things reach
it: a `VoiceSessionAdopt` line when a peer's capture session is adopted, a
throttled `FilmstripRx` line (every `FILMSTRIP_RX_LOG_INTERVAL_MS`), and a
throttled `VoicePlayoutReset` line.

**One caveat for 0.1.0**: the filmstrip receive side also writes a per-peer
`console.log` line about once a second, and the filmstrip capture path logs its
track settings and a periodic `[filmstrip tx]` stats line. Failure paths in both
carriers use `console.error`. These are console diagnostics carried over
verbatim from Presence; routing them through `host.log` or behind a debug flag
is the Presence adoption round's decision, not a silent change here.

---

## Worker and worklet delivery

The filmstrip JPEG encoder runs in a `Worker` and voice capture runs in an
`AudioWorklet`, so two files have to reach the browser as separate scripts.
By default the library resolves them relative to itself:

```
dist/filmstrip-worker.js        new URL('./filmstrip-worker.js', import.meta.url)
dist/voice-capture-worklet.js   new URL('./voice-capture-worklet.js', import.meta.url)
```

That works under bundlers that emit the asset (Vite does, for both). Where it
does not — an inlining bundler, a `file://` origin, a custom asset protocol —
use the Blob-URL fallbacks, which carry the sources as build-generated strings:

```ts
import { createInlineFilmstripWorker, voiceWorkletModuleUrl } from '@lightningrodlabs/signals-media';

host.createWorker = createInlineFilmstripWorker;     // FilmstripHost override
host.workletModuleUrl = voiceWorkletModuleUrl;       // VoiceHost override
```

Both paths are exercised on WebKitGTK and Chromium in the testbed.

**In a source checkout both helpers are backed by empty sources.**
`createInlineFilmstripWorker()` still returns a `Worker`, but over an empty
script, and `voiceWorkletModuleUrl()` returns a Blob URL for an empty module —
neither fails loudly. The real sources are generated by `npm run build` and
written into `dist/`, so only the built package carries them. Consuming the
package from `src/` (a Vite alias to `../src/index.ts`, say) gets a worker that
never encodes; alias `dist/` instead, as the testbed does.

---

## Opus backends

`VoiceHost.codec?()` selects the backend. Absent, the carrier uses WebCodecs
when `AudioEncoder`/`AudioDecoder` exist, and otherwise logs and fails
`startCapture()` / drops received frames — it never silently pulls the WASM.

```ts
import { webCodecsOpus } from '@lightningrodlabs/signals-media';
import { wasmOpus } from '@lightningrodlabs/signals-media/opus-wasm';   // needs libopus-wasm

const codec = webCodecsOpus() ?? await wasmOpus();   // resolve once, before bind()
host.codec = () => codec;
```

`OpusCodec.createEncoder` / `createDecoder` are **synchronous** and may throw —
the receive path opens a decoder and decodes in the same tick, so anything
genuinely asynchronous belongs in acquiring the *backend*. `wasmOpus()` is the
async half: it instantiates the WASM module and resolves to a codec. Because
`libopus-wasm` creates its encoder and decoder asynchronously, the WASM
backend's `createEncoder`/`createDecoder` return **queueing facades** —
synchronous objects that buffer input in a bounded FIFO (`WASM_PENDING_MAX`
frames, oldest dropped with one warning) until the underlying handle resolves,
then drain in order. A rejection reports once through `onError` and the facade
goes inert; closing before the handle is ready closes it on resolve. Wire bytes
are raw Opus packets either way, and the two backends interoperate — pinned by
a cross-backend case in the Chromium gate.

---

## Testbed

`testbed/` is a standalone Tauri 2 app with a 40-line WebSocket broadcast relay
for a transport and no Holochain at all. Two modes on one page: `selftest` (one
instance loops its own sends back through `receiveFrame` under a second peer id,
asserts the whole capture → encode → wire → decode → playout path, prints a
pass/fail transcript and exits) and `room` (N instances on one relay, with a
live stats readout). The same page runs under Playwright Chromium as this
package's browser gate.

It also carries the platform plumbing a real consumer needs — Linux WebKit
settings and permission handler, Android manifest/runtime permissions, Apple
usage descriptions and entitlements, WebView2 permissions — with a per-platform
run procedure and the measured results.

Read [`testbed/README.md`](testbed/README.md); it is the operational document.

```sh
npm run build                 # the testbed consumes dist/, never src/
npm run test:browser          # Playwright Chromium gate
```

---

## Design notes

- [`docs/design.md`](docs/design.md) — the extraction design spec: the host
  seam, the substitution table against Presence's controllers, every decision
  and its rejected alternatives, the declared limitations.
- [`docs/webkitgtk-probe/FINDINGS.md`](docs/webkitgtk-probe/FINDINGS.md) — why
  there is no WebRTC on WebKitGTK 2.52, and what the capture path needs at
  runtime. `main.rs` and `probe.js` beside it are the probe itself.
- [`testbed/README.md`](testbed/README.md) — how to run it on each platform,
  and what has actually been run.
- `src/types.ts` — the host interfaces. Types are the authority; this README is
  prose and will rot. When they disagree, the code is what ships.

Known limitations, stated up front: no AEC beyond what `getUserMedia` gives
you, no PLC, no FEC beyond the 2-frame RED redundancy, no per-peer
subscription (a send is a broadcast to the target set), and AudioWorklet
capture adds up to one 128-frame block (~2.7 ms) of latency over a
`MediaStreamTrackProcessor` path.

## License

MIT — see [LICENSE](LICENSE).
