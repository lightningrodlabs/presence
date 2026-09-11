# WebKitGTK media probe — spike findings (2026-09-08)

Question: what can a Tauri app on Linux (WebKitGTK) do for audio/video, given
that the Presence signals carrier and WebRTC carrier both assume Chromium APIs?

Method: a throwaway Tauri 2 window (`main.rs`, `probe.js` beside this file)
that feature-tests the media APIs and then exercises each for real: AudioWorklet
PCM tap, WebCodecs Opus encode/decode, JPEG on main thread and in a worker,
`getUserMedia` audio+video, live camera → `<video>` → canvas → JPEG at 6 fps,
`VideoEncoder` support, and a loopback `RTCPeerConnection` pair. Two builds:

- **nix**: `android-service-runtime` `main-0.7` devshell (@ `81193a9`),
  nixpkgs WebKitGTK **2.52.5**, GStreamer 1.26.11. Worktree
  `../android-service-runtime-0.7-spike/spike/webkit-probe` (not committed).
- **host**: Ubuntu 24.04, distro WebKitGTK **2.52.3**, GStreamer 1.24.2.

Runs: A = default WebKit settings; B/C/H = `enable-media-stream`,
`enable-webrtc`, `enable-media-capabilities` set to true via
`WebviewWindow::with_webview` + a `permission-request` handler that allows;
C additionally exports `GST_PLUGIN_SYSTEM_PATH_1_0` with nixpkgs
gst-plugins-base/good/bad/libav, libnice, pipewire.

## Results

| Probe | nix A (default) | nix C (settings + gst plugins) | host H (settings, distro gst) |
|---|---|---|---|
| `AudioEncoder`/`AudioDecoder`/`VideoEncoder`/`VideoDecoder` present | yes | yes | yes |
| `MediaStreamTrackProcessor` | absent | absent | absent |
| `RTCPeerConnection` | absent | absent | absent |
| `AudioWorkletNode`, `OffscreenCanvas`, `WebAssembly`, `Worker` | yes | yes | yes |
| `SharedArrayBuffer` | absent | absent | absent |
| AudioContext starts | FAIL (no gst `appsink`/`autoaudiosink`) | OK | OK |
| AudioWorklet 1 s PCM tap (oscillator) | FAIL | OK, peak 1.0 | OK |
| Opus encode via `AudioEncoder` (20 × 20 ms) | FAIL "No GStreamer encoder found for codec opus" | OK, 69 B/frame | OK, 69 B/frame |
| Opus decode via `AudioDecoder` | FAIL | OK | OK |
| JPEG `canvas.toBlob` / worker `convertToBlob` | OK / OK | OK / OK | OK / OK |
| `getUserMedia` audio / video | FAIL (0 devices: no pipewire gst plugin) | OK / OK (real mic + V4L2 camera) | OK / OK (after permission handler; default run → `NotAllowedError`) |
| live camera → canvas → JPEG, 2 s @ 6 fps | n/a | OK: 12 frames, 4 KB each, real pixels | 12 frames but BLANK pixels; WebKit logs `GStreamer element autovideoflip not found` |
| `VideoEncoder.isConfigSupported` | n/a | vp8, vp9, avc1, av1 all true | vp8, vp9 true; avc1, av1 false (no libav) |
| `VideoEncoder` vp8 10 frames | n/a | OK, 679 B | OK, 679 B |
| loopback `RTCPeerConnection` | absent | absent | absent |

## Conclusions

1. **WebRTC is compiled out of WebKitGTK 2.52 in both nixpkgs and Ubuntu
   24.04.** The runtime `enable-webrtc` setting reads back `true` and
   `RTCPeerConnection` still does not exist. nixpkgs gates it behind
   `ENABLE_EXPERIMENTAL_FEATURES` (`-DENABLE_EXPERIMENTAL_FEATURES=OFF`;
   the derivation lists `openssl`/`librice` "For ENABLE_WEB_RTC" only under
   `enableExperimental`). On Linux Tauri the WebRTC carrier is not flaky, it
   is absent. Enabling WebKit settings is therefore not an option; only a
   native engine in the Rust process or a Chromium shell gives WebRTC there.
2. **The signals carrier is feasible on WebKitGTK with a different capture
   path.** `MediaStreamTrackProcessor` is absent, but AudioWorklet PCM →
   `AudioEncoder('opus')` works, `AudioDecoder` works, and camera →
   `<video>` → canvas → JPEG works at 6 fps. Same wire format as Chromium
   peers. `VideoEncoder` vp8/vp9 also works, so real video over signals is
   possible later.
3. **Everything media depends on the GStreamer plugins the app finds at
   runtime.** With none (nix devshell default) no AudioContext, no codecs,
   no devices. A Linux Tauri bundle must declare gstreamer1.0-plugins-base,
   -good, -bad, and -pipewire (or pulseaudio) as dependencies; -libav adds
   avc1/av1. The host (distro 1.24) additionally produced blank camera
   frames while WebKit 2.52 asked for `autovideoflip`; the nix run with
   GStreamer 1.26 produced real frames. Not fully pinned, but a WebKit /
   distro-GStreamer version mismatch is the likely cause and is the kind of
   thing a bundle cannot control.
4. **A Tauri app must handle `permission-request` itself.** With default
   settings `getUserMedia` fails with `NotAllowedError`; `enable-media-stream`
   is already on. `WebviewWindow::with_webview` → `webkit2gtk::WebViewExt::
   connect_permission_request` → `allow()` is the whole fix (`main.rs`).
5. Not measured: sustained encode CPU at 50 frames/s, echo cancellation
   quality, and `getDisplayMedia` (present, untested).

## Consequences for the signals-media extraction plan

- Replace the spec's "Chromium-only, declared limitation" with a capture
  backend seam: `MediaStreamTrackProcessor` where present, AudioWorklet +
  `<video>`/canvas sampling otherwise. Opus stays WebCodecs on both.
- Ship the AudioWorklet processor the way the filmstrip worker ships
  (`dist/` file + inline Blob fallback).
- README "Browser support" becomes: Chromium (full), WebKitGTK 2.52+ with
  GStreamer plugins (signals carrier only; no WebRTC), Safari/WKWebView
  untested.

## Corroboration from public sources (2026-09-08, web research)

- **WebRTC is off in the GTK port unless experimental features are built
  in.** WebKit's own port options declare
  `WEBKIT_OPTION_DEFAULT_PORT_VALUE(ENABLE_WEB_RTC PRIVATE ${ENABLE_EXPERIMENTAL_FEATURES})`
  (`Source/cmake/OptionsGTK.cmake`), while `ENABLE_MEDIA_STREAM` and
  `ENABLE_WEB_CODECS` default `PRIVATE ON`. The runtime setting's
  documentation says only "Enable WebRTC support for loaded pages" with
  default FALSE; it cannot add a compiled-out feature. WebKitGTK 2.37.1's
  release notes introduced the GstWebRTC backend as "disabled by default
  via web view settings"; the 2.52 highlights still describe GstWebRTC
  work in progress (network-process sandboxing, `USE_LIBRICE`), and
  FOSDEM 2025 and 2026 talks by the Igalia maintainers are titled
  "status update" / "current status and plans" — no release has flipped
  it on by default.
- **Ubuntu 24.04 does not enable it.** The noble `debian/rules`
  (Launchpad, `ubuntu/noble-updates`) sets no `ENABLE_WEB_RTC`,
  `ENABLE_EXPERIMENTAL_FEATURES`, or `USE_GSTREAMER_WEBRTC`, so WebKit's
  default (off) applies — matching the probe on the distro 2.52.3.
- **The only known working recipe under Tauri rebuilt WebKitGTK from
  source** with `-DENABLE_MEDIA_STREAM=ON -DENABLE_WEB_RTC=ON` (Tauri
  discussion #8426), then set `enable_webrtc` and registered a
  `permission-request` handler — the same two runtime steps the probe
  took, which are insufficient on a stock build.
- **`getUserMedia` denial is Tauri's default, not a WebKit limit.** Tauri
  issue #8346 (Ubuntu 22.04, `NotAllowedError`) was closed "not planned";
  WebKit's `permission-request` signal docs describe the default handler
  as denying. The probe's `connect_permission_request` → `allow()` is the
  documented fix.
- **WebCodecs on GStreamer is a shipped feature since WebKitGTK 2.44**
  ("a WebCodecs backend that leverages the wide range of GStreamer audio
  and video decoders/encoders"), improved in 2.48 and 2.52 — consistent
  with the Opus/VP8 results.
- **`MediaStreamTrackProcessor`**: caniuse records Safari 18+ shipping it,
  and WebKit's preferences gate it on the compile flag
  `ENABLE(MEDIA_STREAM_TRACK_PROCESSOR)` (`UnifiedWebPreferences.yaml`),
  which the GTK port's options do not set. So its absence is a GTK-port
  fact; WKWebView on recent Apple OSes may have it. Untested here.
- **Correction to conclusion 3:** `autovideoflip` is an element of the
  `autoconvert` plugin in **gst-plugins-bad**, and the host has
  `gstreamer1.0-plugins-bad` NOT installed. The blank camera frames on
  the host are therefore the missing plugin package, not a WebKit /
  GStreamer version mismatch. Consequence unchanged: a Linux Tauri bundle
  must depend on gst-plugins-bad (plus base, good, pipewire).

Sources: [OptionsGTK.cmake](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/cmake/OptionsGTK.cmake),
[WebKit2.Settings:enable-webrtc](https://webkitgtk.org/reference/webkit2gtk/2.42.4/property.Settings.enable-webrtc.html),
[WebKitGTK 2.37.1 released](https://webkitgtk.org/2022/07/12/webkitgtk2.37.1-released.html),
[WebKitGTK 2.52 highlights](https://webkitgtk.org/2026/03/18/webkitgtk-2.52-highlights.html),
[FOSDEM 2025 status update](https://archive.fosdem.org/2025/schedule/event/fosdem-2025-4651-webrtc-support-in-webkitgtk-and-wpewebkit-with-gstreamer-status-update/),
[FOSDEM 2026 current status and plans](https://archive.fosdem.org/2026/schedule/event/KMMLGM-webrtc_support_in_webkitgtk_and_wpewebkit_with_gstreamer_current_status_and_plan/),
[Ubuntu noble debian/rules](https://git.launchpad.net/ubuntu/+source/webkit2gtk/plain/debian/rules?h=ubuntu/noble-updates),
[Tauri discussion #8426](https://github.com/tauri-apps/tauri/discussions/8426),
[Tauri issue #8346](https://github.com/tauri-apps/tauri/issues/8346),
[WebKit2.WebView::permission-request](https://webkitgtk.org/reference/webkit2gtk/2.41.4/signal.WebView.permission-request.html),
[WebKitGTK 2.48 highlights](https://webkitgtk.org/2025/04/08/webkitgtk-2.48.html),
[caniuse MediaStreamTrackProcessor](https://caniuse.com/mdn-api_mediastreamtrackprocessor),
[UnifiedWebPreferences.yaml](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml),
[autovideoflip](https://gstreamer.freedesktop.org/documentation/autoconvert/autovideoflip.html).
