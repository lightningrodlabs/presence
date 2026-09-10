# signals-media testbed

A place to run `@lightningrodlabs/signals-media` against **real engines and
real devices**, because the vitest suites cannot: they drive a manual clock, a
fake host and no encoder at all. Here the carriers meet a real WebCodecs Opus
encoder/decoder, a real `AudioWorklet`, a real `OffscreenCanvas` JPEG encode in
a real `Worker`, a real camera and mic, and a real message channel between
separate processes.

Three things live here:

| Piece | What it is |
|---|---|
| `relay.mjs` | A dumb WebSocket broadcast relay. One text frame in, the same frame out to every other socket. Stands in for the Holochain remote-signal path. |
| `ui/` | The testbed page. One host record drives BOTH carriers; `?mode=selftest` loops `host.send` back to itself, `?mode=room` addresses the relay. |
| `src-tauri/` | A Tauri 2 desktop shell that opens the page on **WebKitGTK**, does the Linux media plumbing, prints every `report` line to stdout and exits on `SUMMARY`. |

Plus `testbed.spec.ts` + `playwright.config.ts`: the automated Chromium gate.

The testbed always consumes the package's **built `dist/`**, never `src/`
(controller ruling R11). `ui/vite.config.js` aliases
`@lightningrodlabs/signals-media` → `../../dist/index.js` and its
`./opus-wasm` subpath → `../../dist/opus-wasm.js`, and the `predev` /
`prebuild` / `pretest` scripts run `npm --prefix .. run build` first. That is
what makes `new URL('./voice-capture-worklet.js', import.meta.url)`, the
`new Worker(new URL('./filmstrip-worker.js', …))` reference and `?inline=1`
(which needs the real strings in `dist/inline-sources.generated.js`) all
exercise what a consumer would actually get.

## Page parameters

All optional; they are read from `location.search`, or from
`window.__TESTBED_QUERY` under Tauri (the asset-protocol URL carries no search
string, so `src-tauri` injects the query as an initialization script).

| Param | Default | Meaning |
|---|---|---|
| `mode` | `selftest` | `selftest` (loopback) or `room` (relay) |
| `peer` | random | our peer id |
| `relay` | `ws://127.0.0.1:8765` | relay URL for `room` |
| `duration` | `8` | seconds to run before evaluating and emitting `SUMMARY` |
| `auto` | off | click Start automatically after 500 ms |
| `inline` | off | use `createInlineFilmstripWorker` / `voiceWorkletModuleUrl` instead of the `import.meta.url` references |
| `tone` | off | drive voice from a 440 Hz oscillator instead of the mic — the deterministic path (a real mic in a quiet room is legitimately near-silent, so audio-level assertions only bind under `tone=1`) |
| `codec` | `webcodecs` | `wasm` pulls the `./opus-wasm` subpath and passes it as `VoiceHost.codec` |

`window.__testbed` is the automation surface: `stats()`, `results`, `done`,
`consoleErrors()`, `logLines()`, `restartVoice()`, `setTargets(list)`.

## Running it

Everything below runs inside **this package's own devshell** (controller ruling
R1) — `packages/signals-media/flake.nix`. It is the only shell that has all
three of: a Rust toolchain and the GTK/WebKitGTK libraries Tauri links against;
the GStreamer plugin set WebKitGTK needs at runtime (it exports
`GST_PLUGIN_SYSTEM_PATH_1_0` for you via the gstreamer setup hook — base, good,
**bad**, libav, libnice, pipewire); and a pinned Playwright browser set
(`PLAYWRIGHT_BROWSERS_PATH`).

```bash
cd packages/signals-media
nix develop            # everything below is inside this shell
npm --prefix testbed install
```

### 1. Selftest in a browser

```bash
npm --prefix testbed run dev          # http://localhost:5173
# then open /?mode=selftest&auto=1&tone=1
```

### 2. Selftest under Tauri (WebKitGTK)

```bash
npm --prefix testbed run build                  # builds dist/ then ui/dist/
cargo build --manifest-path testbed/src-tauri/Cargo.toml

DISPLAY=:1 TESTBED_EXIT_ON_SUMMARY=1 \
  testbed/src-tauri/target/debug/signals-media-testbed

DISPLAY=:1 TESTBED_EXIT_ON_SUMMARY=1 \
  TESTBED_URL_QUERY='mode=selftest&auto=1&inline=1' \
  testbed/src-tauri/target/debug/signals-media-testbed
```

The binary embeds `ui/dist` **at compile time**: re-run `cargo build` after
every frontend build or you will test the previous bundle. `TESTBED_URL_QUERY`
overrides the page query; the process exit code is the run's verdict (0 all-OK,
1 otherwise) when `TESTBED_EXIT_ON_SUMMARY=1`.

### 3. Two-instance room

```bash
PORT=8765 node testbed/relay.mjs &

DISPLAY=:1 TESTBED_EXIT_ON_SUMMARY=1 \
  TESTBED_URL_QUERY='mode=room&auto=1&peer=a&duration=20&relay=ws://127.0.0.1:8765' \
  testbed/src-tauri/target/debug/signals-media-testbed &

DISPLAY=:1 TESTBED_EXIT_ON_SUMMARY=1 \
  TESTBED_URL_QUERY='mode=room&auto=1&peer=b&duration=20&relay=ws://127.0.0.1:8765' \
  testbed/src-tauri/target/debug/signals-media-testbed &
```

Add `&tone=1` to both for a deterministic audio level. Across machines, point
`relay=` at the relay host and run the relay with `HOST=0.0.0.0` (the default).

### 4. The Chromium gate

```bash
cd packages/signals-media
nix develop -c npm run test:browser        # THIS package's devshell
```

It must be **this** package's devshell: the repo-root one does not export
`PLAYWRIGHT_BROWSERS_PATH`, and the run then dies with *"Executable doesn't
exist at ~/.cache/ms-playwright/chromium_headless_shell-1217"*.

`test:browser` delegates to `npm --prefix testbed test` — the testbed's own
Playwright, after a `pretest` that rebuilds `dist/` and typechecks the two
`.ts` files here (Playwright's esbuild transform strips types without checking
them).

That indirection is load-bearing: the repo root also has `@playwright/test` (for
`ui/harness`), and running the root's runner against a config that resolves the
testbed's copy fails with *"Playwright Test did not expect test.beforeAll() to
be called here… two different versions of @playwright/test"*. One installation
must own both the binary and the module.

`@playwright/test` is pinned to **1.59.1** rather than a caret range so that it
matches `playwright-driver.browsers` in the flake pin (chromium **1217**); the
devshell sets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, so a version that wanted a
different revision would have no browser at all. Outside nix:
`npm --prefix testbed exec playwright install --with-deps chromium`.

The gate covers: the selftest page end to end; two pages in a room (voice and
video, both directions, asserted after a fixed 8 s rather than on first
crossing); a voice `stopCapture`/`startCapture` restart, its epoch adoption on
the receiver and its measured cost; the host dropping and re-adding a peer from
`targets()` (the carrier-switch shape); and cross-backend Opus in both
directions (WASM sender → WebCodecs receiver and the reverse).

## The Linux (WebKitGTK) plumbing

Three things, all of which a real Tauri app would have to do too. The first two
are in `src-tauri/src/main.rs`, copied from the spike at
`spikes/webkitgtk-media-probe/` in the Presence repo (read its `FINDINGS.md`
for the evidence and the corroborating sources).

1. **Webview settings**: `set_enable_media_stream(true)` and
   `set_enable_media_capabilities(true)` via `WebviewWindow::with_webview`,
   then `reload()` so the page runs under them.
2. **A `permission-request` handler that allows.** WebKit's default handler
   *denies*, so `getUserMedia` fails with `NotAllowedError` in a stock Tauri
   app. `connect_permission_request(|_, r| { r.allow(); true })` is the whole
   fix.
3. **GStreamer plugins on the runtime path.** WebKitGTK's media backend *is*
   GStreamer: with no plugins there is no `AudioContext`, no Opus, and no
   devices. The devshell handles this; a distro bundle must depend on
   `gstreamer1.0-plugins-base`, `-good`, `-bad` (this one is not optional —
   without it WebKit 2.52 asks for `autovideoflip`, does not find it, and the
   camera silently produces blank frames) and `-pipewire` (or `-pulseaudio`),
   plus `-libav` for avc1/av1.

**`enable_webrtc` is deliberately NOT set.** It is inert: WebRTC is compiled out
of WebKitGTK 2.52 in both nixpkgs and Ubuntu 24.04, the setting reads back
`true` and `RTCPeerConnection` still does not exist. The runs below confirm it
(`RTCPeerConnection=false`). This is the entire reason the signals carrier
exists.

One Tauri configuration trap, learned here: leaving `build.devUrl` in
`tauri.conf.json` makes a **debug** `cargo build` load that URL instead of
`frontendDist`, so the window silently shows a dead `http://localhost:5173`.
`tauri.conf.json` has no `devUrl`; `beforeDevCommand` builds the frontend
instead.

## Results

Measured 2026-09-10 on Ubuntu 24.04 (x86_64, X11 on `DISPLAY=:1`), inside
`packages/signals-media`'s devshell, with a real mic and a real V4L2 laptop
camera.

| Component | Version |
|---|---|
| WebKitGTK | **2.52.5** (`pkg-config --modversion webkit2gtk-4.1`) |
| GStreamer | **1.26.11** (base, good, bad, libav, libnice, pipewire) |
| tauri (crate) | **2.11.5** |
| wry | **0.55.1** |
| tao | **0.35.3** |
| webkit2gtk (crate) | **2.0.2** |
| rustc/cargo | 1.98.1 |
| node | 22.23.1 |
| Playwright / Chromium | 1.59.1 / 1217 |
| Vite | 6.4.3 |

Webview UA: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15`.
Feature probe in that webview: `AudioEncoder=true AudioWorkletNode=true
OffscreenCanvas=true createImageBitmap=true Worker=true
RTCPeerConnection=false`.

### Tauri / WebKitGTK

| Run | Result |
|---|---|
| `mode=selftest&auto=1` (8 s, default worker/worklet, real mic + camera) | **all OK**, exit 0. 144 voice sends, loss 0%, jitter 1.0 ms; 44 filmstrip clips → 44 frames painted at 5.62 fps; `peerAudioLevel=0.0026` (real quiet mic, reported not asserted) |
| `mode=selftest&auto=1&inline=1` (inline worker + worklet) | **all OK**, exit 0. 145 voice sends, loss 0%, jitter 1.2 ms; 44 painted at 5.61 fps |
| room, two instances, `peer=a`/`peer=b`, 20 s, real devices | **all OK** both sides, exit 0/0. a←b: recv, level 0.0044, loss 0%, 100 frames at 5.56 fps. b←a: recv, level 0.0027, loss 0%, 105 frames at 5.57 fps |
| room, two instances, `+tone=1`, 20 s | **all OK** both sides. a←b: level **0.3997**, loss 0%, 104 frames at 5.58 fps. b←a: level **0.4015**, loss 0%, 105 frames at 5.56 fps |

Notes on what those numbers mean:

- 5.6 fps against a 6 fps sender is the expected steady state — one frame per
  clip, paced on receive by `FilmstripPlayback`, measured between the first and
  last painted frame.
- Both room instances opened the **same** mic and the **same** V4L2 camera
  concurrently without either failing.
- The default (non-inline) path works under Tauri because Vite inlines the
  worklet as a `data:` module URL and emits the filmstrip worker as an asset;
  `inline=1` is the fallback for bundlers that do neither. Both were exercised.

### Chromium (Playwright gate)

`nix develop -c npm run test:browser -w packages/signals-media` — **6 passed
(27.8 s)**:

```
✓ 1 selftest: voice round-trips and the filmstrip paints (6.9s)
✓ 2 room › voice and video flow in both directions (8.0s)
[testbed] voice restart cost: 67 ms (stop+start to first packet sent)
✓ 3 room › a voice restart is admitted as a new session, and costs little (1.1s)
✓ 4 room › dropping a from the target set stops voice, and re-adding resumes it (4.0s)
✓ 5 cross-backend Opus: wasm sender → webcodecs receiver (1.8s)
✓ 6 cross-backend Opus: webcodecs sender → wasm receiver (1.6s)
```

**Measured restart cost: 67–75 ms** across runs — from `stopCapture()` +
`startCapture()` to the first voice frame handed to `host.send`. That is the
cost of the carrier switch the design spec claims is cheap; the receiver adopts
the new session epoch and audio resumes without a decoder reset.

Not covered anywhere yet: Android WebView, macOS/iOS WKWebView, sustained
encode CPU under load, and echo cancellation quality.
