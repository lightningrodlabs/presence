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
| `src-tauri/` | A Tauri 2 shell that opens the page on **WebKitGTK** (Linux) or the **Android WebView**, does each platform's media plumbing, prints every `report` line to stdout and exits on `SUMMARY` (desktop only). The app is `src/lib.rs`; `src/main.rs` is the desktop shim and `gen/android/` the Android project. |

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
| `gumretry` | `0` | seconds to keep retrying a rejected `getUserMedia`, once a second. `0` is one attempt and the rejection propagates — a missing device stays a fast failure. Set to `30` on Android, where the OS permission dialog races the first capture (see [The Android plumbing](#the-android-plumbing)) |

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

On that carrier switch the gate asserts **no** epoch adoption (controller
ruling R13): dropping a peer from `targets()` never stops capture, so voice
resumes on the *same* session epoch with a continuing `seq` — an adoption
there would be a bug, not the expected behaviour.

### 5. Android (WebView)

Everything here runs in **this package's** devshell too: it is what carries
`adb`, `cargo-ndk`, the Android SDK/NDK (`ANDROID_HOME`, `NDK_HOME`) and JDK
17. The SDK licences are accepted by the flake
(`android_sdk.accept_license = true`); nothing else has to be set by hand.

```bash
cd packages/signals-media
nix develop

# Once: generate src-tauri/gen/android (it is committed, so normally skip this)
npm --prefix testbed exec tauri -- android init

# Debug APK, with the page query baked in (see below)
TESTBED_URL_QUERY='mode=selftest&auto=1&gumretry=30' \
  npm --prefix testbed exec tauri -- android build --debug --apk --target aarch64
```

- **`--target aarch64`** builds only arm64-v8a, which is every current phone.
  Omit it and the CLI builds all four ABIs — and calls `rustup target add` for
  the ones `rust-toolchain.toml` does not list, which mutates the *user's*
  rustup toolchain rather than the devshell's Rust. `rust-toolchain.toml`
  carries `aarch64-linux-android` and `armv7-linux-androideabi`; pass
  `--target aarch64 --target armv7` for both.
- The APK lands at
  `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
  — "universal" even with one ABI; the CLI's own last line names the path.
- **Do not read the APK's size off an incremental rebuild.** AGP repacks the
  zip in place and leaves the superseded entries as slack: one observed
  rebuild produced a 260 MB file whose entries still totalled 141 MB.
  `rm -rf src-tauri/gen/android/app/build` before measuring. (It installs and
  runs either way — this is a measurement trap, not a correctness one.)

Four things had to change for this to build at all, and each is a trap worth
recognising rather than rediscovering:

| Symptom | Fix, and where it lives |
|---|---|
| *"The default value `0.0.0` is not allowed for Android package"* | `tauri.conf.json` `"version": "0.0.1"` (Task 5 had `0.0.0`; desktop did not care) |
| *"no library targets found in package `signals-media-testbed`"* | `[lib]` in `Cargo.toml` + the `lib.rs`/`main.rs` split — see the bottom of [The Android plumbing](#the-android-plumbing) |
| *"Failed to install … build-tools;35.0.0 … The SDK directory is not writable"* | AGP **8.6.1** (from the template's 8.11.0) in `gen/android/build.gradle.kts` and `gen/android/buildSrc/build.gradle.kts`, plus `buildToolsVersion = "34.0.0"` in `app/build.gradle.kts`. 8.6.1 is the newest AGP whose minimum build-tools is 34.0.0, which is what the flake's SDK contains; a newer AGP silently ignores the pin and tries to download 35.0.0 into the read-only nix store. `android.suppressUnsupportedCompileSdk=36` in `gradle.properties` silences AGP 8.6's complaint about `compileSdk = 36` (the platform is present — the flake declares 34 and 36). Raising the flake's `buildToolsVersions` would let AGP move back up; that is a flake change, and this is not. |
| *"npm error Missing script: `tauri`"* during `:app:rustBuild…` | a `"tauri": "tauri"` script in `testbed/package.json` — the rust gradle plugin shells back out to the CLI through it |
- `tauri android init` regenerates the whole `gen/android` tree. Re-running it
  **overwrites every file this target edits**: `app/src/main/AndroidManifest.xml`,
  `app/src/main/java/.../MainActivity.kt`, `app/build.gradle.kts`,
  `build.gradle.kts`, `buildSrc/build.gradle.kts` and `gradle.properties`.
  `git diff` after an init shows exactly what to put back.

#### Install, launch, watch

```bash
adb devices                                  # expect exactly one device
adb install -r testbed/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb logcat -c                                # clear, so the transcript is this run's
adb shell am start -n org.lightningrodlabs.signals_media_testbed/.MainActivity
adb logcat | grep testbed                    # the [testbed] lines, via RustStdoutStderr
```

Android has no `TESTBED_EXIT_ON_SUMMARY`: the process does not exit on
`SUMMARY`, the transcript is the verdict. Expect `[testbed] query: ?…`, one
`[testbed] page …` pair, a `[testbed] OK` line per step and a final
`[testbed] OK   SUMMARY`. On the very first launch the OS permission dialog
appears before the page is interactive — tap Allow twice; later launches are
silent.

#### The Linux↔Android room

Relay on the laptop, one Tauri instance beside it, the phone on the same
Wi-Fi. `<laptop-ip>` is the laptop's LAN address (`ip -4 addr`), never
`127.0.0.1` — that is the phone on the phone.

```bash
# laptop
PORT=8765 HOST=0.0.0.0 node testbed/relay.mjs &
DISPLAY=:1 TESTBED_EXIT_ON_SUMMARY=1 \
  TESTBED_URL_QUERY='mode=room&auto=1&peer=linux&duration=30&relay=ws://<laptop-ip>:8765' \
  testbed/src-tauri/target/debug/signals-media-testbed &

# phone: rebuild with the room query baked in, then reinstall
TESTBED_URL_QUERY='mode=room&auto=1&peer=android&duration=30&gumretry=30&relay=ws://<laptop-ip>:8765' \
  npm --prefix testbed exec tauri -- android build --debug --apk --target aarch64
adb install -r testbed/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n org.lightningrodlabs.signals_media_testbed/.MainActivity
adb logcat | grep testbed
```

Pass: both transcripts end `OK   SUMMARY`, each side reports voice received
from the other with 0% loss, and each side's filmstrip paints at ≥5 fps. Add
`&tone=1` to both for an asserted audio level rather than a reported one.
Record with the results:

```bash
adb shell getprop ro.product.model; adb shell getprop ro.build.version.release
adb shell dumpsys package com.google.android.webview | grep versionName
```

`ws://` works because the **debug** build sets
`android:usesCleartextTraffic="true"` (`app/build.gradle.kts`); a release APK
would need `wss://` or a network-security config.

### 6. macOS (WKWebView)

This machine cannot build or run this section — no Apple hardware. Everything
below is a procedure for Volla to run and report back, not something verified
here.

**Do not use `nix develop`.** The flake's `devShells` list includes
`x86_64-darwin`/`aarch64-darwin`, but both its `tauriDeps`
(`webkitgtk_4_1`, `gtk3`, …, pulled into `buildInputs`) and several entries
in its plain `packages` list (`pipewire`, `gsettings-desktop-schemas`,
`shared-mime-info`) are Linux-only and unconditional — none of them gated
behind `pkgs.stdenv.isLinux` — with no reason to exist on macOS. Whether that
shell even evaluates on darwin has not been checked from here; the plain
toolchain below is what Tauri itself documents for macOS and is what this
procedure is built against. Prerequisites,
per Tauri's own guide: Xcode Command Line Tools (`xcode-select --install`),
Rust via [rustup](https://rustup.rs) (this repo's `rust-toolchain.toml` pins
`channel = "stable"` and rustup picks it up automatically from the directory —
its `targets` list is Linux/Android-only, which is harmless extra download on
macOS, not a blocker), and Node ≥ 20 (this repo measured Node 22.23.1 on
Linux — see the Results table).

```bash
cd packages/signals-media
npm --prefix testbed install
npm --prefix testbed run build                        # builds dist/ then ui/dist/
cargo build --manifest-path testbed/src-tauri/Cargo.toml

TESTBED_EXIT_ON_SUMMARY=1 \
  TESTBED_URL_QUERY='mode=selftest&auto=1&codec=wasm' \
  ./testbed/src-tauri/target/debug/signals-media-testbed
```

Run it from Terminal.app (or another terminal emulator) — launch it by
double-clicking the binary in Finder instead and its stdout goes nowhere,
because it is a plain executable, not an `.app` bundle. `TESTBED_URL_QUERY` is
read at **runtime** here (`page_query()`, `src-tauri/src/lib.rs`); unlike
Android, no rebuild is needed between queries on desktop.

`codec=wasm` (above) is **required** below macOS 26: Apple WebKit gained
`AudioEncoder`/`AudioDecoder` only in Safari 26.0 (macOS 26) — `codec=webcodecs`,
the page default, fails the `env` step on every earlier macOS.
`MediaStreamTrackProcessor` shipped in Safari 18 but is video-only and this
library never calls it (voice and filmstrip both use the AudioWorklet/canvas
capture path — see "The Linux (WebKitGTK) plumbing" below), so its Safari
version does not gate anything here. On macOS 26+, run the `wasm` command
above **and** this one, and report both transcripts:

```bash
# macOS 26+ only, in addition to the codec=wasm run above
TESTBED_EXIT_ON_SUMMARY=1 \
  TESTBED_URL_QUERY='mode=selftest&auto=1&codec=webcodecs' \
  ./testbed/src-tauri/target/debug/signals-media-testbed
```

Expected transcript shape (values will differ from the Linux Results table —
a real mic/camera, a different WebKit build): a `[testbed] query: ?…` line,
one `[testbed] page …` pair, a `[testbed] OK` line per step (`env`, `voice`,
`filmstrip`, …), and a final `[testbed] OK   SUMMARY`, process exit 0. Two
GUI prompts (camera, then microphone) appear on first launch — **macOS 14 is
known to show the `getUserMedia` prompt twice** (wry issue #1195, open as of
this writing): expected behaviour on macOS 14, not a `FAIL` line and not
something to retry around. Paste back: the full `[testbed]` transcript for
each command run (`webcodecs` only on macOS 26+), the `env` step's reported
`navigator.userAgent`, `sw_vers -productVersion`, and whether the double
prompt was observed.

### 7. iOS (WKWebView)

Also unverified from here — no Apple hardware. Xcode (the full app, not just
the Command Line Tools — `tauri ios init` needs the iOS SDK) is Volla's first
step. `testbed/src-tauri/gen/apple` is not committed (see "Files" in the task
that added this section) — `tauri ios init` generates it locally, picking up
`Info.plist` automatically the same way the macOS build does (there is no
separate `Entitlements.plist` for iOS — see "The Apple (WKWebView) plumbing"
below for why).

```bash
cd packages/signals-media
npm --prefix testbed install
npm --prefix testbed exec tauri -- ios init      # generates src-tauri/gen/apple

TESTBED_URL_QUERY='mode=selftest&auto=1&codec=wasm' \
  npm --prefix testbed exec tauri -- ios dev
```

`tauri ios dev` is documented (Tauri's "Run on iOS" guide) to try a connected
device first and fall back to prompting for a simulator — a simulator needs no
Apple Developer Team and is the easier first run; a physical device needs one,
set via the `APPLE_DEVELOPMENT_TEAM` environment variable or Xcode's signing
settings (`tauri_utils::config::IosConfig::development_team`). Same env-var
baking pattern as Android: set `TESTBED_URL_QUERY` on the build/dev command
itself, not only at runtime — Android needed this because `adb` cannot hand an
app process an environment variable at all, and whether the iOS launch path
(simulator or device) propagates a runtime-set var the way desktop does has
not been checked from here, so baking it is the safe default. Report which one
actually worked.

**Where the `[testbed]` lines land is unverified from here too.** They are
plain `println!`s; on iOS this is normally readable in Xcode's own console
pane the way plain stdout is on desktop, but whether `tauri ios dev` running
from a terminal also mirrors them into that terminal (the way it does not need
special handling on desktop, and the way `adb logcat` surfaces them on
Android) has not been observed. First try reading them straight from the
terminal that ran `tauri ios dev`; if nothing shows there, run
`npm --prefix testbed exec tauri -- ios dev --open` instead, which opens the
project in Xcode, and read the lines from Xcode's Console pane (View → Debug
Area → Activate Console) while the app runs. Report which one worked.

`codec=wasm` is required below iOS 26 for the same reason as macOS — Safari
26.0 is when `AudioEncoder`/`AudioDecoder` arrived — and the `codec=webcodecs`
run is iOS 26+ only, same two-command pattern as the macOS section. Expected
transcript shape and what to paste back: mostly identical to the macOS
section above (the `[testbed] query`/`page`/per-step `OK` lines, the final
`[testbed] OK   SUMMARY`, `navigator.userAgent`, iOS version, the double-
prompt question), **except process exit.** The command above never sets
`TESTBED_EXIT_ON_SUMMARY` — unlike desktop, whether an env var set on
`tauri ios dev` even reaches the launched app process is unverified (see
above), so, same as Android: the transcript is the verdict, and the process
is expected to keep running past `SUMMARY` rather than exit — do not treat a
still-running process as a hang.

### 8. Windows (WebView2)

Also unverified from here — no Windows machine. Nothing in `tauri.conf.json`
is Windows-specific; WebView2 prompts for camera/microphone natively with no
handler installed (see "The Windows (WebView2) plumbing" below — only Linux
needed the `connect_permission_request` code in `src/lib.rs`). Prerequisites,
per Tauri's own Windows guide: the Microsoft C++ Build Tools ("Desktop
development with C++" workload), Rust via [rustup](https://rustup.rs) (same
`rust-toolchain.toml` as above), the WebView2 Runtime (preinstalled on
Windows 11 and recent Windows 10 updates; if `cargo build` succeeds but the
window shows nothing, install it from Microsoft first — this repo ships no
installer, so there is no Evergreen bootstrapper to do that step
automatically), and Node ≥ 20.

```powershell
cd packages\signals-media
npm --prefix testbed install
npm --prefix testbed run build
cargo build --manifest-path testbed\src-tauri\Cargo.toml

$env:TESTBED_EXIT_ON_SUMMARY = "1"
$env:TESTBED_URL_QUERY = "mode=selftest&auto=1&codec=webcodecs"
.\testbed\src-tauri\target\debug\signals-media-testbed.exe
```

`codec=webcodecs` (the page default, used explicitly above for clarity) is
correct on Windows: WebView2 is Chromium-based and Chromium has shipped
`AudioEncoder`/`AudioDecoder` since version 94, long before any WebView2
Runtime in current use — there is no wasm-fallback requirement here the way
there is on pre-26 Apple.

Run it from a console (`cmd.exe` or PowerShell), not by double-clicking the
`.exe` in Explorer. Nothing under `src-tauri` sets
`#![windows_subsystem = "windows"]` (grepped: no hits), so this binary links
with Rust's default **console** subsystem: launched from an existing console
its `[testbed]` lines print straight there; launched by double-click it opens
its own console window, so the lines are visible either way — a console you
started is just easier to copy from.

Camera/microphone prompts appear on first launch, handled entirely by
WebView2 — no Tauri or app code is involved. **The "block" answer is sticky
per app** (Tauri issue #5042): once denied, WebView2 never re-prompts, because
the answer lives in the WebView2 user-data folder, not any per-run state. To
reset it: close the app, delete
`%LOCALAPPDATA%\org.lightningrodlabs.signals-media-testbed\EBWebView` (the
whole folder — other cached state under it can carry the same stale answer,
not just `Default\Preferences`), and relaunch; a fresh prompt appears.
(That path is Tauri's default WebView2 user-data-folder location, keyed to
this app's `identifier` in `tauri.conf.json` — confirm the exact path on the
test machine if it differs.)

Expected transcript shape: same shape as the Linux Results table —
`[testbed] query: ?…`, one `[testbed] page …` pair, a `[testbed] OK` line per
step, a final `[testbed] OK   SUMMARY`, process exit 0. Paste back: the full
transcript, the Windows build (`winver`), and the WebView2 Runtime version
(`Get-Item "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application\*" |
Select-Object -ExpandProperty Name` — note the `${env:Name}` brace form: a
bare `$env:ProgramFiles(x86)` stops parsing the variable token at `(`, so it
interpolates only `$env:ProgramFiles` and appends the literal text `(x86)`,
producing `C:\Program Files(x86)\...` with no space — which does not match
the real `C:\Program Files (x86)` folder, or
`reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv`).

## The Android plumbing

Four things, and the first is the point: **almost none of it is ours.**

1. **wry already grants camera and microphone.** Checked before writing any
   Kotlin, per this task's step 1:
   `~/.cargo/registry/src/*/wry-0.55.1/src/android/kotlin/RustWebChromeClient.kt`
   **lines 94–119** override `onPermissionRequest`, map
   `android.webkit.resource.AUDIO_CAPTURE` onto `RECORD_AUDIO` +
   `MODIFY_AUDIO_SETTINGS` and `…VIDEO_CAPTURE` onto `CAMERA`, launch the OS
   request through the activity's own `ActivityResultLauncher`, and call
   `request.grant(request.resources)` when the user allows (`request.deny()`
   otherwise). That is the brief's first case: **no `WebChromeClient`
   subclass of ours, no `onPermissionRequest` override**. Android is the
   opposite of Linux here — WebKitGTK's default denies and we had to write a
   handler; the Android WebView's wry-supplied handler asks and grants.
   (Note it does *not* check `hasPermissions` first: it launches its request
   every time, which is why the pre-grant below can collide with it.)
2. **Manifest** (`gen/android/app/src/main/AndroidManifest.xml`):
   `RECORD_AUDIO`, `CAMERA`, `MODIFY_AUDIO_SETTINGS` added beside the
   template's `INTERNET`, plus `uses-feature` for camera and microphone with
   `required="false"` — a device missing either still runs the other half.
   These are the functional requirement: wry's handler can only grant a
   permission the package declares.
3. **A pre-grant in `MainActivity.onCreate`**
   (`ActivityCompat.requestPermissions` for the two dangerous ones, skipped
   when already held). Not needed for correctness — it is there so the dialog
   lands *before* the page is interactive instead of in the middle of an
   `auto=1` run, and so every launch after the first is non-interactive. Its
   one hazard: while that dialog is open, wry's own request can return denied
   without being shown, and `getUserMedia` then rejects with
   `NotAllowedError`. Hence `gumretry=30` on the page — the attempt after the
   user taps Allow succeeds. Both halves are commented at their source.
4. **The page query is baked at build time.** No env var reaches an app
   process from `adb`, so `src-tauri/src/lib.rs`'s `page_query()` falls back
   from the runtime `TESTBED_URL_QUERY` to `option_env!("TESTBED_URL_QUERY")`,
   captured when the cdylib was compiled (`build.rs` declares
   `rerun-if-env-changed` so a changed query actually rebuilds). Desktop
   behaviour is unchanged — the runtime value still wins — with one footgun
   worth knowing: a **desktop** binary compiled in a shell that exports
   `TESTBED_URL_QUERY` bakes it too, so a later run with the variable unset
   uses that query instead of the selftest default. `[testbed] query: ?…` on
   the first line of every run says which query is in force. This keeps
   `window.__TESTBED_QUERY` the single way a query reaches the page on every
   platform; the `windows[0].url` route was not taken because the window is
   built in Rust, not from `tauri.conf.json`'s (empty) `windows` array.

One structural consequence of targeting Android at all: `src-tauri` is now a
**library plus a three-line `main.rs`**. `tauri android build` runs `cargo
build --lib` (the APK `System.loadLibrary`s a cdylib; there is no Rust
`main`), and a bin-only crate fails with *"no library targets found in package
`signals-media-testbed`"*. Everything moved to `src/lib.rs` behind
`#[cfg_attr(mobile, tauri::mobile_entry_point)] pub fn run()`; apart from that
signature and the added notes in the module header, the code is the file Task 5
wrote (`git log --follow src-tauri/src/lib.rs` shows the rename).

## The Linux (WebKitGTK) plumbing

Three things, all of which a real Tauri app would have to do too. The first two
are in `src-tauri/src/lib.rs`, copied from the spike at
`../docs/webkitgtk-probe/` (read its `FINDINGS.md`
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

## The Apple (WKWebView) plumbing

Zero Rust code, on purpose — the opposite of the Linux section above, and the
same shape as Android's "almost none of it is ours." The
`connect_permission_request`/`WebKitSettings` block in `src/lib.rs` is
`#[cfg(target_os = "linux")]`-gated and compiles out entirely on `macos` and
`ios` targets; nothing replaces it there because nothing needs to. wry's
`WKUIDelegate` implementation has called `requestMediaCapturePermission` —
the native camera/microphone prompt — since wry 0.22, on both macOS and iOS.

Two config files instead:

1. **`Info.plist`** (`testbed/src-tauri/Info.plist`, this task):
   `NSMicrophoneUsageDescription` + `NSCameraUsageDescription`. Tauri merges
   it into the generated bundle Info.plist automatically because it sits next
   to `tauri.conf.json` — no `bundle.macOS.infoPlist`/`bundle.iOS.infoPlist`
   config key needed (`tauri_utils::config::IosConfig::info_plist` docs this
   file-discovery for iOS explicitly; Tauri's own macOS bundling guide
   describes the same "create `Info.plist` in `src-tauri/`, it gets merged"
   behaviour for the desktop bundle). Without these two keys `getUserMedia`
   fails outright with **no prompt at all** — iOS/macOS refuse to show a
   permission dialog for an app carrying no usage-description string, which
   is a harder failure than a denied prompt and easy to mistake for a wry or
   WebKit bug.
2. **`Entitlements.plist`** (`testbed/src-tauri/Entitlements.plist`, this
   task, macOS only — referenced by `bundle.macOS.entitlements` in
   `tauri.conf.json`): `com.apple.security.device.audio-input` +
   `com.apple.security.device.camera`. These are required under Hardened
   Runtime (`bundle.macOS.hardenedRuntime: true`, the default) independent of
   App Sandbox — Apple's Hardened Runtime documentation: a hardened-runtime
   app's camera/mic calls fail outright, again with no prompt, if the
   corresponding entitlement is absent. iOS has no entitlements file for this
   at all — device access there is governed by Info.plist plus the
   provisioning profile, so `bundle.iOS` carries no entitlements reference.
   `bundle.iOS.frameworks` is likewise left unset: this library's capture
   path (AudioWorklet + WebCodecs + `<video>`/canvas sampling — see "The
   Linux (WebKitGTK) plumbing" above) uses only APIs WKWebView already
   exposes, nothing that needs an extra bundled iOS framework.
3. **Codec support is OS-version-gated**, unlike WebKitGTK's flat
   present/absent split: Apple WebKit gained `AudioEncoder`/`AudioDecoder`
   only in Safari 26.0 (macOS 26 / iOS 26) — `codec=wasm` is required on
   every earlier release, `codec=webcodecs` only on 26+ (see the macOS/iOS
   procedures above). Safari 18's `MediaStreamTrackProcessor` is video-only
   and this library never calls it, on any platform, so its availability
   does not affect anything here.
4. **macOS 14 shows the `getUserMedia` prompt twice.** Open upstream (wry
   issue #1195) as of this writing — expected behaviour, not a `FAIL` line,
   and nothing in this codebase works around it.

Checking a newer Tauri/wry pin was this task's Step 1 (see the note in
`src/lib.rs`'s module doc, right after the WebKitGTK section): wry 0.56 added
a cross-platform `WebViewBuilder::with_permission_handler` that would also
cover macOS/iOS/Windows/Android through one closure, but no published Tauri
2.x release reaches wry 0.56 yet (`tauri-runtime-wry` tops out at 2.11.4, on
`wry ^0.55.0`) — re-check that claim before ever bumping `tauri` past 2.11.5,
since it would change everything in this section.

## The Windows (WebView2) plumbing

Also zero Rust code. `tauri.conf.json` has no Windows-specific keys at all —
WebView2 prompts for camera/microphone natively the moment `getUserMedia` is
called, with no handler installed; the same reasoning as the Apple section
above (only Linux needed `connect_permission_request` — see `src/lib.rs`'s
module doc for why Windows, like macOS/iOS/Android, needs none). WebView2 is
Chromium-based and has shipped `AudioEncoder`/`AudioDecoder` since Chromium
94, so `codec=webcodecs` (the page default) is correct out of the box — no
wasm-fallback story here.

The one thing worth knowing before it surprises someone: **a "block" answer
to the permission prompt is sticky per app** (Tauri issue #5042). WebView2
persists it in that app's WebView2 user-data folder — by Tauri's default,
`%LOCALAPPDATA%\<identifier>\EBWebView` — and never asks again once denied,
independent of reinstalling the page or the app binary. There is no in-app
recovery; the reset procedure (delete that folder, relaunch) is in the
Windows section above, where a tester actually needs it.

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

**Measured restart cost: 54–75 ms** across recorded runs — 67 ms in the
transcript above, 74 ms and 75 ms on two repeats of the same gate, and 54 ms
running the gate from inside the package's own devshell
(`nix develop -c npm run test:browser` with `packages/signals-media` as the
working directory). This file is the source for that figure; the package
README and `docs/design.md` cite it. From `stopCapture()` +
`startCapture()` to the first voice frame handed to `host.send`. That is the
cost of the carrier switch the design spec claims is cheap; the receiver adopts
the new session epoch and audio resumes without a decoder reset.

### Android — pending a device

**No Android device was attached to the build machine** when this target was
written (2026-09-10; `adb devices` empty), so the build is verified and the
device runs are not. The APK builds; nothing below it has been observed.

| Run | Result |
|---|---|
| `tauri android build --debug --apk --target aarch64`, query `mode=selftest&auto=1&gumretry=30` | **APK built**, exit 0 — `app/build/outputs/apk/universal/debug/app-universal-debug.apk`, **127.5 MiB** (133,713,031 bytes from a clean build), of which `lib/arm64-v8a/libsignals_media_testbed_lib.so` is 126,563,792: an unstripped debug cdylib with `ui/dist` embedded in it. `aapt dump permissions` reports INTERNET, RECORD_AUDIO, CAMERA, MODIFY_AUDIO_SETTINGS; the baked query is in the `.so` (`strings … \| grep gumretry`) |
| `mode=selftest&auto=1&gumretry=30` on a device | **pending a device** — not run |
| Linux↔Android room, `mode=room&relay=ws://<laptop-ip>:8765` | **pending a device** — not run |

| Component | Version |
|---|---|
| Android Gradle plugin | 8.6.1 (template default 8.11.0 — see the trap table) |
| Gradle / Kotlin plugin | 8.14.3 / 1.9.25 |
| compileSdk / targetSdk / minSdk | 36 / 36 / 24 |
| build-tools / NDK | 34.0.0 / 28.2.13676358 |
| JDK | OpenJDK 17.0.20 |
| wry (via tauri 2.11.5) | 0.55.1 |

The exact commands for both pending rows are in [5. Android
(WebView)](#5-android-webview) above. What a run must record, beside its
verdict: device model and Android release, the WebView `versionName`, and for
the room, per-direction loss and fps.

Two things a device run is expected to falsify or confirm, and they are the
reason it matters more than the build:

- **The permission race.** The pre-grant dialog and wry's own request are not
  ordered. `gumretry=30` is the mitigation, written against the reading of
  wry's Kotlin rather than against an observed failure. A device run should
  either show no `media.retry` lines at all (no race) or show them once on a
  fresh install and then a successful capture.
- **WebCodecs.** Android WebView has had `AudioEncoder`/`AudioDecoder` since
  Chromium 94, so `codec=webcodecs` should work; if it does not, the `env`
  report says so on the first line and `codec=wasm` is the fallback to try.

### macOS / iOS — pending hardware

**No Apple hardware exists on the machine that wrote this section**
(2026-09-10), so none of it — build, run, or prompt behaviour — has been
observed; unlike Android, not even the build has been exercised, since
`cargo build` for `target_os = "macos"`/`"ios"` cannot run on Linux. Config
(`Info.plist`, `Entitlements.plist`, the `bundle.macOS` block in
`tauri.conf.json`) is written and reasoned from Apple's own documentation
(cited in "The Apple (WKWebView) plumbing" above), not from an observed run.

| Run | Result |
|---|---|
| macOS, `mode=selftest&auto=1&codec=wasm` | **pending hardware** — not run |
| macOS, `mode=selftest&auto=1&codec=webcodecs` (macOS 26+ only) | **pending hardware** — not run |
| iOS, `mode=selftest&auto=1&codec=wasm` | **pending hardware** — not run |
| iOS, `mode=selftest&auto=1&codec=webcodecs` (iOS 26+ only) | **pending hardware** — not run |

The exact commands are in [6. macOS (WKWebView)](#6-macos-wkwebview) and
[7. iOS (WKWebView)](#7-ios-wkwebview) above, including what each run must
record. Three things a run is expected to falsify or confirm:

- **The two config files are sufficient.** Whether `Info.plist` and
  `Entitlements.plist` actually produce a working prompt-then-grant flow, as
  opposed to a silent `NotAllowedError`, is unverified — the reasoning is
  from Apple's Hardened Runtime and Info.plist documentation, not from a
  build that ran.
- **The macOS 14 double-prompt.** Whether it is observed as described (wry
  issue #1195) or has changed shape since.
- **Where `[testbed]` output lands on iOS.** Terminal (via `tauri ios dev`)
  or Xcode's Console pane only — see the iOS section above; this determines
  how future Apple runs should be scripted.

### Windows — pending hardware

**No Windows machine exists on the machine that wrote this section**
(2026-09-10) either; same caveat as the Apple row above — config only,
nothing built or run.

| Run | Result |
|---|---|
| `mode=selftest&auto=1&codec=webcodecs` | **pending hardware** — not run |

The exact command is in [8. Windows (WebView2)](#8-windows-webview2) above.
What a run is expected to falsify or confirm: that WebView2 prompts and
grants with zero Tauri-side configuration (as documented, `tauri.conf.json`
carries no Windows-specific keys at all), and that the sticky-block reset
procedure (delete the `EBWebView` folder) actually works as described from
Tauri issue #5042 rather than from a run.

Not covered anywhere yet: Android WebView, macOS WKWebView, iOS WKWebView,
and Windows WebView2 **on real hardware**; sustained encode CPU under load;
and echo cancellation quality.
