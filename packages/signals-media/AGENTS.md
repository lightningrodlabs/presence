# AGENTS.md — working on `@lightningrodlabs/signals-media`

For an agent (or a person in a hurry) about to modify this package or embed it
in an app. [`README.md`](README.md) is the integration guide,
[`API.md`](API.md) the reference, [`docs/design.md`](docs/design.md) the
reasoning. This file is the short list of things that will bite you.

## What this is

Opus voice and low-fps JPEG filmstrip video between peers over any message
channel — no WebRTC, no ICE, no TURN — extracted from Presence's shipping
signals carrier and re-targeted at an injected host record. The host owns the
channel, the devices, the clock, the target set and the cadence verdict; the
library owns capture, encode, pacing, admission, decode and playout. It exists
because WebRTC is compiled out of stock WebKitGTK 2.52, where this carrier is
the only carrier.

## Invariants

Each one names what enforces it. Break one and the named gate is what should go
red — if it does not, the gate is the bug.

- **Do not change a wire key, its spelling or its order.** The four payload
  shapes are recorded in `src/__tests__/fixtures/wire.json` and pinned against
  what the carriers actually emit by `src/__tests__/wire-fixture.test.ts`. A
  field added to, removed from or reordered in a frame literal fails there.
- **The copied files stay recognizably Presence's.** `docs/design.md`'s
  substitution table is the list of what was allowed to change (`this.store…`
  → `this.host…`, the two capture pumps, the deleted Lit/`@mdi` coupling).
  Anything outside that table is a new divergence and needs declaring in
  `CHANGELOG.md`'s "Changed from Presence".
- **48 kHz, everywhere.** `VOICE_SAMPLE_RATE` / `VOICE_FRAME_SAMPLES`
  (`src/voice-capture.ts`) are what the worklet block, both Opus backends and
  the wire assume. `VoiceCapture.start` refuses any other `sampleRate`, which
  is what makes `startCapture()` resolve false on a 44.1 kHz context.
- **Consume `dist/`, never `src/`.** `createInlineFilmstripWorker` and
  `voiceWorkletModuleUrl` are backed by empty strings in a source checkout;
  `npm run build` (`scripts/gen-inline-sources.mjs`) writes the real sources
  into `dist/`. A Vite alias pointing at `../src/index.ts` gets a worker that
  never encodes. The testbed aliases `dist/` for exactly this reason.
- **`bind(host)` before `startCapture()`.** An unbound carrier returns `false`
  from `startCapture()` and cannot open a peer in `receiveFrame`. `unbind()`
  drops the host's `AudioContext` reference without closing it — disposal is
  the host's.
- **`targets()` is read at every encode, not cached.** That is what makes a
  carrier switch a host-side set change with no library call
  (README, "Carrier switching"). Caching it would break the switch and the
  cadence gate together.
- **Codec factories are synchronous and may throw.** `src/types.ts`'s
  `OpusCodec` says so; the receive path decodes in the same tick it opens a
  peer. Anything genuinely async belongs in acquiring the backend — that is
  what `wasmOpus()` is, and why `src/opus-wasm.ts` wraps `libopus-wasm`'s
  async handles in bounded queueing facades instead of making the seam async.
- **Remote clip geometry is validated before any state is touched.**
  `FilmstripCarrier.receiveFrame` drops a clip whose `n` is not an integer in
  `1..MAX_CLIP_FRAMES` or whose `p` is not finite and positive, because both
  reach `FilmstripPlayback`'s loop untouched. This is a declared divergence
  from Presence (`CHANGELOG.md`); do not "simplify" it away.
- **Nothing in this directory may reference a path outside it.** The package
  is extracted by `git subtree split`, and a `../../ui/…` import or a test
  reading a monorepo file breaks the standalone repo silently. The extraction
  rehearsal in [`docs/README.md`](docs/README.md) is the check, and it records
  exactly this class of defect being caught twice.
- **`API.md` and `src/index.ts` agree.** `src/__tests__/api-doc.test.ts` fails
  if an export has no section or a section names no export. Adding an export
  means adding its section in the same change.

## Running the gates

All of them from `packages/signals-media/`, all under the package devshell:

```sh
nix develop -c npm run typecheck     # tsc --noEmit over src, then over examples/
nix develop -c npm run test          # vitest, node environment, no DOM
nix develop -c npm run build         # tsc -p tsconfig.build.json + gen-inline-sources
nix develop -c npm run test:browser  # Playwright Chromium over the testbed page
```

What each proves:

- `typecheck` — the library compiles under `strict` + `noUnusedLocals` +
  `noUnusedParameters`, and the two host examples still compile against the
  public surface (`tsconfig.examples.json` maps the package name onto `src/`).
- `test` — the pure decisions, the wire fixture, the carrier lifecycles and the
  codec facades, headless. The browser surfaces are reached through the host
  seam, so no DOM environment is needed and none is configured.
- `build` — emits `dist/`, including the generated worker and worklet sources.
- `test:browser` — the real capture → encode → wire → decode → playout path
  against a real engine, including the cross-backend Opus pair. **It needs
  `dist/`: run `build` first.** It is also the gate that a source-only change
  cannot satisfy, because the testbed consumes the built package.

From the Presence monorepo root, `nix develop -c npm run verify` runs this
package's unit suite and typecheck alongside the others.

## Platform plumbing an embedder owes

The library cannot do any of this for you; the testbed does all of it, and
[`testbed/README.md`](testbed/README.md) has the evidence and the procedures.

- **Linux / WebKitGTK** (testbed README, "The Linux (WebKitGTK) plumbing") —
  three things, all required: `set_enable_media_stream(true)` +
  `set_enable_media_capabilities(true)` on the webview then reload; a
  `permission-request` handler that allows, because WebKit's default **denies**
  and `getUserMedia` otherwise fails with `NotAllowedError`; and GStreamer
  plugins findable at runtime — `base`, `good`, **`bad`**, `pipewire`/
  `pulseaudio`, `libav`. Without `bad`, the camera silently produces blank
  frames.
- **Android** (testbed README, "The Android plumbing") — declare
  `RECORD_AUDIO`, `CAMERA`, `MODIFY_AUDIO_SETTINGS` in the manifest (wry's
  `RustWebChromeClient` can only grant what the package declares); write no
  `onPermissionRequest` of your own, because wry already has one; optionally
  pre-grant in `MainActivity.onCreate` so the dialog lands before the page is
  interactive — and know that a pre-grant racing wry's own request can return
  denied without being shown.
- **Apple / WKWebView** (testbed README, "The Apple (WKWebView) plumbing") —
  two config files, no Rust: `Info.plist` with `NSMicrophoneUsageDescription`
  + `NSCameraUsageDescription` (absent, the OS refuses to prompt at all), and,
  on macOS, `Entitlements.plist` with `com.apple.security.device.audio-input`
  + `…device.camera`, required under Hardened Runtime. Codec support is
  OS-version-gated: `wasmOpus()` before Safari/macOS/iOS 26.
- **Windows / WebView2** (testbed README, "The Windows (WebView2) plumbing") —
  nothing to configure, but know that a "block" answer is **sticky per app**
  and persists in the WebView2 user-data folder with no in-app recovery.

## Where things are

```
src/
  index.ts                 the public barrel — the only entry point besides ./opus-wasm
  types.ts                 the host seam (MediaHost / VoiceHost / FilmstripHost)
  voice-carrier.ts         voice: send gate, batching, RED, admission, playout
  voice-capture.ts         AudioWorklet capture pump (main-thread half)
  voice-capture-worklet.ts the processor; shipped as its own dist/ script
  voice-playout.ts         decidePlayout — where to schedule one decoded frame
  voice-admission.ts       decideVoiceAdmission, nextVoiceEpoch — session epochs
  filmstrip-carrier.ts     filmstrip: send gate, clip decode, geometry check, stats
  filmstrip-sampler.ts     <video> + createImageBitmap capture pump
  filmstrip-worker.ts      JPEG encode; shipped as its own dist/ script
  filmstrip-playback.ts    FilmstripPlayback — receive-side display pacing
  av-sync.ts               cross-carrier timing helpers (sender timebase)
  signals-cadence-policy.ts decideSignalsMediaCadence — full/voice-only/paused
  opus-webcodecs.ts        the default codec backend
  opus-wasm.ts             the ./opus-wasm subpath backend + queueing facades
  inline-sources.ts        Blob-URL fallbacks for the worker and worklet
  base64.ts                bytesToBase64 / base64ToBytes
  __tests__/               vitest suites; fixtures/wire.json is the wire record
examples/                  two host examples + the zome half (typechecked, not run)
testbed/                   standalone Tauri 2 app; also the Playwright gate
docs/                      design spec, WebKitGTK probe findings, extraction record
```

## What not to do

- **Do not edit Presence's `ui/` from here.** This package is extracted on its
  own; a change that needs both is two changes, and the Presence half belongs
  to the adoption round.
- **Do not add a second capture path.** There is one per medium and it is the
  portable one. `MediaStreamTrackProcessor` is deliberately not used — WebKit
  does not implement it for audio.
- **Do not add a second implementation of a pure helper.** One authority per
  concept, one exported name; a replacement deletes the thing it replaces.
- **Do not change a wire key without the fixture.** Update
  `fixtures/wire.json` in the same change, or the change is a silent interop
  break dressed as a refactor.
- **Do not add a path outside the package** — no import, no test read, no
  config that computes a monorepo-relative root.
- **Do not route a diagnostic through a new channel.** `host.log` is the sink;
  the leftover `console.*` lines are listed in `CHANGELOG.md` under known
  limitations and are the adoption round's to resolve.

## Backlog

There is no standing loop here. What is deliberately unfinished is recorded in
two places and nowhere else:

- [`docs/design.md`](docs/design.md) — every decision carries a landed /
  landed-with-amendment / not-landed marker, plus the declared limitations and
  what is explicitly out of scope.
- [`CHANGELOG.md`](CHANGELOG.md) — "Changed from Presence" (each divergence the
  adoption round has to carry back) and "Known limitations".
