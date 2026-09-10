# Signals-media extraction — design spec

Written 2026-09-08; revised the same day after the WebKitGTK media probe
(`spikes/webkitgtk-media-probe/FINDINGS.md`) and on 2026-09-10 for the
Apple/Windows targets. Built on `main-0.7`, branch `signals-media`.
Purpose: lift the signals-based audio/video carrier out of `ui/src` into a
published package that a third-party Holochain app (Volla Messages, a
Tauri app on Android, Linux, macOS/iOS, and Windows, is the first named
consumer) can use to carry Opus voice and low-fps JPEG video over remote
signals without WebRTC — and prove it on Tauri before Presence adopts it.

Two consumer situations, both first-class:

- **No WebRTC at all** — Linux Tauri (WebKitGTK), where the probe showed
  `RTCPeerConnection` is compiled out. The signals carrier is the only
  carrier.
- **WebRTC available but relayed** — Android, Windows (WebView2), and
  Apple (WKWebView), where a direct ICE path failed and the choice is
  between a TURN relay and the signals carrier (whose bytes already ride
  the Holochain transport's relays). Volla wants to switch to signals
  there rather than run TURN. The library must therefore make a per-peer
  carrier SWITCH cheap and gap-free, not just work as a fallback of last
  resort.

## Problem

Presence has a working "no WebRTC" media path: Opus voice frames and
JPEG filmstrip clips shipped as opaque strings over the room zome's
`send_message` remote signal (`transport/carrier-coverage.ts` makes it the
carrier for every present peer that is not WebRTC-`connected`).

Two things block reuse:

1. **It is welded to `StreamsStore`.** `ui/src/room/modules/voice.ts`
   (`VoiceController`) and `ui/src/room/modules/video-filmstrip.ts`
   (`FilmstripController`) hold a `store: StreamsStore` and reach into
   eleven store members; both also carry Presence's room-module
   registration, `@mdi/js` icons, and `@holochain-open-dev/stores`. The
   receive-side video pacing lives inside a Lit element
   (`room/elements/peer-filmstrip.ts`).
2. **Its capture path is Chromium-only, and the motivating platform is
   not Chromium.** Both controllers capture through
   `MediaStreamTrackProcessor`, which WebKitGTK does not implement. The
   probe established, on nixpkgs WebKitGTK 2.52.5 and Ubuntu 24.04's
   2.52.3: `RTCPeerConnection` is compiled out (the runtime
   `enable-webrtc` setting reads back true and the class still does not
   exist — WebKit's GTK port defaults `ENABLE_WEB_RTC` to
   `ENABLE_EXPERIMENTAL_FEATURES`, which nixpkgs and Ubuntu leave OFF;
   corroborated in `spikes/webkitgtk-media-probe/FINDINGS.md`), so
   on Linux Tauri the signals carrier is the only carrier; and the
   alternative capture path works there: AudioWorklet PCM →
   `AudioEncoder('opus')` → `AudioDecoder`, camera → `<video>` → canvas →
   JPEG at 6 fps, `VideoEncoder` vp8/vp9, real mic and V4L2 camera via
   `getUserMedia` once the app allows WebKit's `permission-request`. All
   of it depends on GStreamer plugins being findable at runtime.

## Decisions

1. **Shape: bring-your-own-transport library, the `packages/webrtc-peer`
   pattern.** The package knows nothing about Holochain, zomes, signal
   envelopes, presence, or rosters. The host supplies a bindings record
   (who to send to, how to send, how to acquire mic/camera, an
   AudioContext, a clock, a log sink) and calls `receiveFrame(from,
   payload)` when a payload arrives. Rejected: a "signals session" object
   owning targets, cadence evaluation, and RTT — presence concerns, and
   Volla has its own roster.
2. **Copy, don't move — Presence is untouched this round, by
   declaration.** The two controllers and the pure helpers are COPIED into
   the package and adapted; nothing under `ui/src` changes. This is a
   declared parallel copy (working agreement 1) with a named sunset: the
   **Presence adoption round** — Presence's `voice.ts`/`video-filmstrip.ts`
   become adapters over the package and the in-tree copies are deleted —
   is triggered when the testbed (decision 9) is green on Linux, Android,
   and Chromium. Until then the package's wire fixture (decision 8) is
   derived from Presence's shapes, so drift between the copies fails the
   package's tests. CLAUDE.md records the copy and its trigger.
3. **Two carrier classes, `VoiceCarrier` and `FilmstripCarrier`, over
   injected `VoiceHost`/`FilmstripHost` bindings**, bodies taken from the
   controllers under a substitution table (`this.store.X` → `this.host.X`)
   EXCEPT for the capture path (decision 5). `bind(host)`/`unbind()`
   lifecycle is kept: "the receive side is live once bound" is a clean
   statement for a consumer, and Presence's adoption round can keep its
   singletons.
4. **The pure helpers ship in the package**: `decidePlayout`,
   `decideVoiceAdmission`/`nextVoiceEpoch`, `estimatePlayoutSenderTimeMs`/
   `framePaceMs`, `packVoiceFrames`/`unpackVoicePayload`,
   `decideSignalsMediaCadence`, plus a framework-free `FilmstripPlayback`
   extracted from `peer-filmstrip.ts` (queue, burst pacing, cap,
   first-clip start, underrun resume, depth reporting).
5. **ONE portable capture path per medium; the `MediaStreamTrackProcessor`
   dependency is dropped.** Audio: `host.acquireMic()` track →
   `MediaStreamAudioSourceNode` → an `AudioWorkletProcessor` that
   accumulates 960-sample (20 ms @ 48 kHz) blocks and posts them to the
   main thread → `AudioEncoder('opus')`. Video: `host.acquireCamera()`
   track → a detached `<video>` element → at the sample period,
   `createImageBitmap(video)` (falling back to a main-thread canvas when
   `createImageBitmap` cannot take a video element) → transferred to the
   existing worker → `OffscreenCanvas.drawImage` + `convertToBlob('image/jpeg')`.
   Both paths were exercised on WebKitGTK in the probe and both APIs exist
   on Chromium. Rejected: a Chromium backend beside the portable one — a
   second path needs a measured reason, and the Chromium testbed run
   (decision 9) is where such a reason would show up. If it does, the
   Chromium path returns as a declared second backend, not before.
   Encode/decode default to WebCodecs (WebKitGTK provides them over
   GStreamer; Chromium natively) behind the codec seam of decision 5b.
5b. **An Opus codec seam with two backends, because Apple WebKit has no
   WebCodecs audio before Safari 26.** `AudioEncoder`/`AudioDecoder` shipped
   in Safari 26.0 (macOS 26 / iOS 26, 2025); Safari 16.4–18.x expose only
   the video codecs. WKWebView follows the OS, so any Volla build that
   supports macOS 15 / iOS 18 or older needs Opus without WebCodecs. The
   carriers therefore encode and decode through an `OpusCodec` interface
   (`{ createEncoder(cb), createDecoder(cb) }` over 20 ms 48 kHz mono
   Float32 frames in, opaque packets out, and the reverse), with:
   `webCodecsOpus()` (default when `AudioEncoder`/`AudioDecoder` exist) and
   `wasmOpus()` from the subpath `@lightningrodlabs/signals-media/opus-wasm`,
   wrapping `libopus-wasm` (libopus 1.6.1 as a single-file ES module; raw
   packet encode/decode, Float32 PCM, 48 kHz) as an OPTIONAL dependency so
   hosts that never target Apple pay nothing. `VoiceHost.codec?()` selects;
   absent, the carrier picks WebCodecs when present, else logs and fails
   `startCapture()`/drops received frames (it does not silently pull the
   WASM). Wire bytes are Opus packets either way — the two backends
   interoperate, pinned by a cross-backend test in the Chromium gate. This
   is a second backend with a measured reason (the Safari version floor),
   consistent with decision 5's rule.
6. **The host evaluates cadence and batch eligibility; the carriers read
   the verdicts.** `VoiceHost.cadence()` / `batchEligible()` mirror
   Presence's `signalsCadence()` / `voiceBatchEligible()`. The capability
   string `voice-batch-v1` stays host vocabulary; the package documents
   the `{ v: 2, frames }` format and that a host gates `batchEligible()` on
   its own capability declaration.
7. **Clock rule unchanged.** Presence-relevant stamps (`peerLastRecvMs`,
   `peerLastSentMs`, `lastAcceptedMs`) ride `host.clock.now()`; wire stamps
   (`wts`, `t0`, `ts`, the capture epoch) stay `Date.now()`; display-hold
   and URL-revoke timers use `globalThis.setTimeout`.
8. **Wire format byte-identical to Presence 0.15.6, pinned by a golden
   fixture** (`src/__tests__/fixtures/wire.json`: voice v1 frame with `red`,
   voice v2 batch, filmstrip clip, filmstrip stop) with a test asserting
   parse and encode. Presence and package peers interoperate; Chromium and
   WebKitGTK peers interoperate.
9. **A standalone Tauri testbed proves the library on real platforms.**
   `packages/signals-media/testbed/`: a Tauri 2 app with no Holochain, whose
   transport is a 40-line WebSocket broadcast relay (`testbed/relay.mjs`,
   node `ws`). Two modes on one page: `selftest` (one instance loops its
   own send back to `receiveFrame` under a second peer id and asserts
   capture → encode → wire → decode → playout, reporting pass/fail to
   stdout and exiting) and `room` (N instances on one relay, manual
   two-device calls with a stats readout). The same page runs under
   Playwright Chromium with fake devices as the package's CI gate. The
   Tauri app carries the platform plumbing a real consumer needs and
   documents it: Linux — `with_webview` WebKit settings and a
   `permission-request` allow handler, plus the GStreamer plugin
   dependency list; Android — manifest permissions, runtime permission
   request, and WebView `onPermissionRequest`; macOS/iOS — Info.plist
   `NSMicrophoneUsageDescription`/`NSCameraUsageDescription`, macOS
   hardened-runtime entitlements `com.apple.security.device.audio-input`
   and `.camera`, and wry's `requestMediaCapturePermission` delegate (wry
   0.22+ prompts natively; macOS 14 double-prompts, wry issue #1195 open);
   Windows — WebView2's `PermissionRequested` (wry 0.56 added a
   cross-platform permission API with full WebView2 coverage; the testbed
   pins the Tauri version that ships it and records the default
   behavior). Targets: **Linux (WebKitGTK) and Android are built and run
   here; Chromium via Playwright is the CI gate; macOS, iOS, and Windows
   are built here as far as the toolchain allows (config, plist,
   entitlements, permission plumbing) and RUN BY VOLLA** on their
   machines, following `testbed/README.md`'s per-platform procedure, which
   is written so a run yields a pass/fail stdout transcript they paste
   back. The `selftest` mode exists for exactly this hand-off.
10. **Worker and worklet ship in the package, with bundler-proof
    fallbacks.** `dist/filmstrip-worker.js` and `dist/voice-capture-worklet.js`
    are referenced by `new URL(…, import.meta.url)` by default; both are
    also exported as build-generated source strings with
    `createInlineFilmstripWorker()` / `voiceWorkletModuleUrl()` (Blob URLs
    — the probe loaded a Blob worklet on WebKitGTK). Hosts override via
    `FilmstripHost.createWorker?()` / `VoiceHost.workletModuleUrl?()`.
11. **Package name `@lightningrodlabs/signals-media`, version 0.1.0,
    directory `packages/signals-media`**, on the `webrtc-peer` scaffold
    (tsc → `dist/`, vitest node, ES2022, strict + `noUnused*`, `sideEffects:
    false`, MIT). The testbed and `docs/` are excluded from the npm
    tarball but travel with the directory (decision 13). The name is open
    to change before publish.
12. **Zero change to Presence is the definition of done for this round**
    (`git diff --stat main-0.7 -- ui/` empty). Root scripts gain the
    package in `build:packages`/`test:unit`/`typecheck`/`verify`; CI's
    `verify` job needs no edit.
13. **Built on a branch, and extractable into its own repository with one
    command.** All work lands on `signals-media` off `main-0.7` (worktree),
    merged `--no-ff` when done. Extractability is a property of the tree
    AND the history, enforced as follows:
    - **Self-contained directory.** Nothing under `packages/signals-media/`
      imports, reads, or references a path outside it: no `extends` of a
      root tsconfig, no test that reads `ui/src`, no Vite alias to a
      sibling. The package carries its own `flake.nix` (node 22, rust,
      Tauri desktop libs, GStreamer plugins, Android SDK/NDK — composed
      from the `android-service-runtime` `main-0.7` flake), its own
      `docs/` (this spec, the probe findings and sources, the testbed
      procedure), and a `.github/workflows/verify.yaml` that is inert in
      the monorepo (only root workflows run there) and becomes the repo's
      CI on extraction. `package.json`'s `repository` points at the future
      standalone repo (`lightningrodlabs/signals-media`), as
      `webrtc-peer`'s does.
    - **Monorepo glue lives outside the directory.** Root workspace
      registration, root `verify` wiring, the nightly-harness step, and
      the Presence-drift alarm (a root `scripts/check-signals-media-drift.mjs`
      that compares the package's wire fixture against `ui/src`'s payload
      field names — the check that needs both trees) are monorepo
      concerns and are dropped, not ported, on extraction.
    - **Confined commits.** Every commit that touches
      `packages/signals-media/` touches nothing else; root glue changes are
      their own commits. Then `git subtree split --prefix=packages/signals-media`
      yields a clean standalone history. The reviewer checks
      `git log --stat` for mixed commits.
    - **Extraction rehearsal** is a plan task: run the subtree split into a
      scratch directory, `npm install && npm run verify` there under the
      package's own flake, and record the result — extractability is
      verified, not asserted.

## The package

```
packages/signals-media/
  package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts  LICENSE
  scripts/gen-inline-sources.mjs     dist worker+worklet -> exported strings
  README.md  CHANGELOG.md
  src/
    index.ts
    types.ts                  PeerId, MediaClock, TrackHandle, MediaKind,
                              MediaHost, VoiceHost, FilmstripHost, VoiceRxStats
    voice-carrier.ts          VoiceCarrier + VoiceFrame types, pack/unpack,
                              VOICE_BATCH_FRAMES
    voice-capture.ts          AudioWorklet capture pump (main-thread side)
    voice-capture-worklet.ts  the AudioWorkletProcessor (no imports)
    voice-playout.ts / voice-admission.ts / av-sync.ts / signals-cadence-policy.ts
    filmstrip-carrier.ts      FilmstripCarrier, FPS/size options, stats types
    filmstrip-sampler.ts      <video> + createImageBitmap sample pump
    filmstrip-worker.ts       JPEG encode worker (no imports)
    filmstrip-playback.ts     FilmstripPlayback
    inline-sources.ts         createInlineFilmstripWorker, voiceWorkletModuleUrl
    base64.ts
    __tests__/                copied suites re-targeted at a fake host,
                              fixtures/wire.json, manual-clock.ts, fake-host.ts
  testbed/
    relay.mjs                 WebSocket broadcast relay
    ui/index.html  ui/testbed.js  ui/vite.config.js
    src-tauri/                Cargo.toml (standalone), src/main.rs,
                              tauri.conf.json, capabilities/, icons/,
                              gen/android/ (manifest + permission plumbing)
    playwright.config.ts  testbed.spec.ts
    README.md                 how to run on Linux / Android / Chromium,
                              GStreamer + permission notes
```

### Host interfaces (`src/types.ts`)

```ts
export type PeerId = string;
export interface MediaClock { now(): number }
export interface TrackHandle { track: MediaStreamTrack; release(): void }
export type MediaKind = 'voice' | 'filmstrip';
export type SignalsMediaCadence =
  | { mode: 'full'; reason: 'healthy' | 'no-sample' }
  | { mode: 'voice-only'; reason: 'rtt-degraded' }
  | { mode: 'paused'; reason: 'carrier-down' | 'rtt-collapsed' };

export interface MediaHost {
  targets(): ReadonlySet<PeerId>;                       // read at every encode; empty = drop
  cadence(): SignalsMediaCadence['mode'];              // host evaluates decideSignalsMediaCadence, or 'full'
  send(kind: MediaKind, payload: string, targets: ReadonlySet<PeerId>): Promise<void>;
  clock: MediaClock;
  log(line: string): void;
}
export interface VoiceHost extends MediaHost {
  acquireMic(onTrackChanged: (track: MediaStreamTrack) => void): Promise<TrackHandle | null>;
  audioContext(): AudioContext | null;                 // shared, user-gesture unlocked; capture AND playout use it
  batchEligible(): boolean;
  workletModuleUrl?(): string;                         // override: where voice-capture-worklet.js lives
}
export interface FilmstripHost extends MediaHost {
  acquireCamera(onTrackChanged: (track: MediaStreamTrack) => void): Promise<TrackHandle | null>;
  createWorker?(): Worker;
}
export interface VoiceRxStats { jitterMs: number | null; lossPercent: number | null }
```

### Substitution table (Tasks 2 and 3; the reviewer's checklist)

| Presence (`this.store…`) | Package (`this.host…`) |
|---|---|
| `get(this.store._signalsTargets)` | `this.host.targets()` |
| `this.store.signalsCadence().mode` | `this.host.cadence()` |
| `this.store.voiceBatchEligible()` | `this.host.batchEligible()` |
| `this.store.sendModuleData('voice', p, t)` | `this.host.send('voice', p, t)` |
| `this.store.sendModuleData('video-filmstrip', p, t)` | `this.host.send('filmstrip', p, t)` |
| `this.store.micSource.acquire({ id: 'voice', onTrackChanged })` | `this.host.acquireMic(onTrackChanged)` |
| `this.store.cameraSource.acquire({ id: 'video-filmstrip', onTrackChanged })` | `this.host.acquireCamera(onTrackChanged)` |
| `this.store.micSource.ensureAudioContext()` | `this.host.audioContext()` |
| `this.store.logger.logCustomMessage(s)` | `this.host.log(s)` |
| `this.store.clock` | `this.host.clock` |
| `this.store.signalsStats` (voice rx window) | `this.voiceRxStats.set(peer, { jitterMs, lossPercent })` |
| `window.setTimeout/clearTimeout`, bare `setTimeout` | `globalThis.setTimeout/clearTimeout` |
| `new MediaStreamTrackProcessor({ track })` + `pumpEncoder` (voice) | `VoiceCapture` (AudioWorklet pump, `voice-capture.ts`) — REPLACED, decision 5 |
| `MediaStreamTrackProcessor` readable transferred to the worker (filmstrip) | `FilmstripSampler` (`<video>` + `createImageBitmap`, `filmstrip-sampler.ts`) — REPLACED, decision 5 |
| `new Worker(new URL('./filmstrip-worker.ts', …))` | `this.host.createWorker?.() ?? defaultWorker()` |
| `registerModule`, `@mdi/js`, `ModuleDefinition`, singleton export | deleted from the package |

Anything under `this.store` not in this table is a STOP for the
implementer.

## Carrier switching (the relayed-WebRTC case)

The host owns the carrier decision per peer; the library owns making the
switch cheap. Contract, documented in the README and exercised by the
Chromium gate:

- `targets()` is read at every encode, so moving a peer between carriers
  is a host-side set change with no library call. A peer removed from the
  set stops receiving on the next frame; a peer added starts on the next
  frame.
- `startCapture()` is called when the set first becomes non-empty and
  `stopCapture()` when it empties (Presence's reconciler pattern). The
  host keeps the device handle across switches (the `acquireMic` handle
  is the host's; the carrier only holds its `TrackHandle`), the worklet
  module is loaded once per AudioContext, so a restart costs one encoder
  configure — tens of milliseconds, measured in the testbed.
- Every restart is a new capture-session epoch; `decideVoiceAdmission`
  admits it immediately on the receiver (the 2026-08-26 deafness fix),
  so a WebRTC→signals→WebRTC→signals sequence never deafens.
- `cadence()` needs an RTT measure to be useful; a host without one
  returns `'full'`. The README shows the minimal ping/pong a host can run
  over its own channel to feed `decideSignalsMediaCadence`.

## Declared limitations

- **Platform matrix** (from the probe and public sources; the testbed
  re-verifies): Chromium (Chrome, Edge, Electron, Android WebView,
  WebView2) — full; WKWebView — capture path works (AudioWorklet,
  `<video>`+`createImageBitmap`; Safari 18's `MediaStreamTrackProcessor` is
  video-only and worker-only and is not used), Opus via WebCodecs on
  Safari 26+/macOS 26/iOS 26, via the WASM backend before that; WebKitGTK
  2.52+ — signals carrier only, no WebRTC, and only with GStreamer
  plugins base/good/bad/pipewire findable at runtime (the host with
  gst-plugins-bad NOT installed produced blank camera frames next to an
  `autovideoflip not found` log — that element lives in plugins-bad's
  `autoconvert`; with the plugin present frames are real); WKWebView —
  untested here — Volla runs the testbed on Apple hardware.
- **Legacy senders without `ep`** keep the pre-epoch restart-deafness
  behavior (`decideVoiceAdmission`'s declared limitation) — unchanged.
- **No AEC beyond `getUserMedia`'s, no PLC, no FEC beyond the 2-frame
  `red` redundancy, no per-peer subscription** — unchanged from the wire.
- **AudioWorklet capture adds up to one 128-frame block of latency over
  the MSTP path** (~2.7 ms). Measured, not assumed, in the Chromium
  testbed run.

## Not in scope

- Any change under `ui/` (decision 12). The Presence adoption round is a
  separate plan.
- Running the Windows and Apple testbed builds on this machine (decision
  9 assigns those runs to Volla).
- A Svelte/React filmstrip element; `FilmstripPlayback` gives a host the
  pacing, painting is theirs.
- Publishing. The plan ends at `npm pack --dry-run` and a CHANGELOG;
  registry state is checked with `npm view @lightningrodlabs/signals-media
  version`, never trusted from prose.
- A native WebRTC engine for Linux Tauri. The probe closed the "enable
  WebKit's WebRTC" option; a Rust-side engine is a separate decision.

## Testing and enforcement

- Package unit suites (vitest, node): copied `voice-playout`,
  `voice-admission`, `av-sync`, `signals-cadence-policy`, `voice-batch`,
  `voice-session-epoch`, `filmstrip-rx-logging` re-targeted at a fake host;
  new: wire fixture, `FilmstripPlayback` table, bind/unbind symmetry for
  both carriers, `VoiceCapture` block assembly (worklet message → 960-sample
  frames, pure), `FilmstripSampler` cadence (fake video element, fake
  timers).
- Browser-real gate: `testbed.spec.ts` under Playwright Chromium with
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, two
  pages on `relay.mjs`: audio level rises on the receiving page, filmstrip
  frames arrive at ≥5 fps, seq/epoch admission holds across a
  stop/restart, batch mode round-trips. Joins the nightly harness
  workflow.
- Platform runs (manual, recorded in `testbed/README.md` with date and
  versions): Linux Tauri selftest and a two-instance room; Android selftest
  and an Android↔Linux room.
- Cross-backend Opus test in the Chromium gate: page a encodes with
  `wasmOpus()`, page b decodes with `webCodecsOpus()`, and the reverse —
  audio level rises both ways.
- `nix develop -c npm run verify` stays the gate; `git diff --stat
  main-0.7 -- ui/` is empty at every commit.
- Per-task adversarial review by a session that did not write it
  (working agreement 9), with the substitution table as the checklist.

## Definition of done

- `packages/signals-media` builds, tests, typechecks under `verify`.
- Wire bytes identical to Presence 0.15.6's, pinned by the fixture.
- The testbed selftest passes on Linux Tauri and Android Tauri, the
  Playwright gate passes on Chromium (including the cross-backend Opus
  case), and a Linux↔Android room call carries audio both ways and video
  at ≥5 fps. macOS, iOS, and Windows builds exist with their permission
  plumbing and a run procedure; their results are recorded when Volla
  reports them (the adoption-round trigger does not wait on them).
- `ui/` unchanged. CLAUDE.md gains a bullet naming the package, the
  declared copy, and the adoption-round trigger.
- The extraction rehearsal passes: a `git subtree split` of the package
  directory builds and verifies standalone under its own flake.
