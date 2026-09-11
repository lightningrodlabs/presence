# Changelog

All notable changes to `@lightningrodlabs/signals-media`.

## 0.1.0 — 2026-09-10

Initial release. Opus voice and low-fps JPEG filmstrip video between peers over
a host-supplied message channel, with no WebRTC.

### Provenance

Copied from Presence (`lightningrodlabs/presence`) at `ab90584` — the shipping
`ui/src/room/modules/voice.ts` and `video-filmstrip.ts` controllers, the pure
helpers beside them (`voice-playout`, `voice-admission`, `av-sync`,
`signals-cadence-policy`), and the receive-side pacing lifted out of the
`peer-filmstrip` Lit element. Presence keeps its own copy until its adoption
round; the two copies are a declared parallel path with a named sunset, not an
accident.

### Added

- `VoiceCarrier` and `FilmstripCarrier` over injected `VoiceHost` /
  `FilmstripHost` bindings (`bind`/`unbind`, `startCapture`/`stopCapture`,
  `receiveFrame`). The host owns the channel, the devices, the clock, the log
  sink, the target set and the cadence verdict; the library owns encode,
  decode, pacing and admission.
- `FilmstripPlayback` — framework-free receive-side pacing (queue, burst
  pacing, buffer cap, first-clip start, underrun resume, depth reporting).
- Pure decision helpers, exported: `decidePlayout`, `decideVoiceAdmission` /
  `nextVoiceEpoch`, `estimatePlayoutSenderTimeMs` / `framePaceMs`,
  `packVoiceFrames` / `unpackVoicePayload`, `decideSignalsMediaCadence`,
  `bytesToBase64` / `base64ToBytes`.
- An Opus codec seam with two backends: `webCodecsOpus()` (default where
  `AudioEncoder`/`AudioDecoder` exist) and `wasmOpus()` behind the
  `./opus-wasm` subpath, wrapping `libopus-wasm` as an **optional**
  dependency so hosts that never target pre-Safari-26 WebKit pay nothing.
  `createEncoder`/`createDecoder` are synchronous on both; the WASM backend
  returns bounded queueing facades (`WASM_PENDING_MAX`) that drain in order
  once the module resolves. The two backends interoperate on the wire.
- Worker and worklet shipped as `dist/filmstrip-worker.js` and
  `dist/voice-capture-worklet.js`, resolved by `new URL(…, import.meta.url)`,
  with Blob-URL fallbacks (`createInlineFilmstripWorker`,
  `voiceWorkletModuleUrl`) for bundlers that neither emit nor inline them.
- A Tauri 2 testbed (`testbed/`, excluded from the npm tarball) with a
  WebSocket relay, a self-asserting `selftest` mode and an N-instance `room`
  mode; the same page is the package's Playwright Chromium gate.

### Changed from Presence

- **Capture path replaced, declared.** Presence captures through
  `MediaStreamTrackProcessor`, which WebKit does not implement for audio. This
  package captures audio through an `AudioWorkletProcessor` (20 ms, 960-sample,
  48 kHz blocks) and video through a detached `<video>` element sampled with
  `createImageBitmap`. Both paths were exercised on WebKitGTK and Chromium.
  Consequence: AudioWorklet capture adds up to one 128-frame block (~2.7 ms) of
  latency over the `MediaStreamTrackProcessor` path, and the capture
  `AudioContext` must run at 48 kHz.
- Presence's store coupling, room-module registration, `@mdi/js` icons and
  `@holochain-open-dev/stores` dependencies are gone; the store members the
  controllers reached into are the `MediaHost` seam.
- **Clip geometry is validated on receive — a declared divergence from
  Presence's `video-filmstrip.ts` receive path** (design spec decision 8,
  ruling R20). `FilmstripCarrier.receiveFrame` drops a clip whose frame count
  `n` is not an integer in `1..MAX_CLIP_FRAMES` (exported; 64) or whose
  playback period `p` is not finite and positive, before any per-peer state is
  touched, and warns once per peer. Presence passed both straight through to
  its playback loop, where a hostile or corrupt sender could bound a loop or
  pace a timer chain with them; a library taking remote input from arbitrary
  hosts cannot. Honest senders are unaffected — this package sends `n: 1`, and
  the legacy batching senders the receive path still accepts stayed far below
  64. The adoption round carries this divergence into Presence.
- **Host callbacks that throw are contained, not propagated.** A rejecting
  `acquireMic`/`acquireCamera` (a denied permission prompt reaching the carrier
  as a rejection rather than a resolved `null`) now resolves `startCapture()`
  to `false` and logs, matching the documented boolean contract instead of
  rejecting out of it. A `VoiceHost.codec()` that throws on probe reads as "no
  codec": `openPeer` drops the frame and logs once per peer, `startCapture()`
  returns `false`. `codec()` is also now asked once per bind rather than once
  per peer (the resolved backend is cached until `unbind`).

### Wire compatibility

Intended to be byte-identical to **Presence 0.15.6**. What is tested:
`src/__tests__/fixtures/wire.json` records the four payload shapes (voice
per-frame with RED, voice `{ v: 2, frames }` batch, filmstrip clip, filmstrip
stop), derived by reading Presence's construction sites at `ab90584`, and
`wire-fixture.test.ts` drives this package's carriers through a fake host and
asserts the emitted payloads carry exactly those keys in that order, plus
`packVoiceFrames` byte-equality and `unpackVoicePayload` round-trips. No suite
runs a package peer against a Presence peer, so package↔Presence interop is an
inference from those checks, not a tested property. Chromium↔WebKitGTK interop
is likewise inferred; what the testbed did exercise for real is the cross-backend
Opus pair (WASM sender → WebCodecs receiver and the reverse) under Chromium.

### Known limitations

- No AEC beyond `getUserMedia`'s, no PLC, no FEC beyond the 2-frame RED
  redundancy, no per-peer subscription — a send is a broadcast to the target
  set.
- Senders that omit `ep` (pre-2026-08-26 builds) keep the pre-epoch restart
  deafness on a capture restart.
- The filmstrip receive path writes a per-peer `console.log` line about once a
  second, and the capture path logs track settings and a periodic tx stats
  line. Console-only, carried over verbatim; routing them through `host.log` or
  a debug flag is a later decision.
- In a source checkout `createInlineFilmstripWorker()` and
  `voiceWorkletModuleUrl()` produce empty sources — the generated strings are
  written into `dist/` by `npm run build`.

### Platform status at release

Linux WebKitGTK 2.52.5 (GStreamer 1.26.11, Tauri 2.11.5 / wry 0.55.1) and the
Chromium Playwright gate both green 2026-09-10. Android: debug APK built and its
permissions verified 2026-09-10, on-device run pending a device. macOS, iOS and
Windows: configured with their permission plumbing and a run procedure, runs
pending hardware. Details in `testbed/README.md`.
