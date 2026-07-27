# Low-bandwidth video over Holochain signals

Ships video as tiny JPEG filmstrips over Holochain remote signals when WebRTC
video is unavailable, pairing with the voice-over-signals path so a degraded
room has both audio and low-fps video.

**This is built and shipping.** The design reasoning below — why filmstrips over
GIF or WebCodecs, the bandwidth budget, the architectural mirror of `voice.ts` —
is why the code looks the way it does, and is the part still worth reading.
Steps 1–4 landed as `ui/src/room/modules/video-filmstrip.ts`,
`filmstrip-worker.ts`, `ui/src/camera-source.ts` (the clean option, not the v1
shortcut), `_reconcileSignalsVideo` in `streams-store.ts`, and
`ui/src/room/elements/peer-filmstrip.ts`. Clip batching was later dropped in
favour of per-frame sends, and a shared sender timebase plus A/V skew
measurement was added alongside (`av-sync.ts`).

## References

- [David Walsh — Webcam to animated GIF](https://davidwalsh.name/webcam-animated-gif)
  `getUserMedia` → `<video>` → canvas `drawImage` → `Animated_GIF.addFrame` /
  `gif.js`. 10 frames over 2 s, encoder runs in a Web Worker, output is a
  base64 GIF.
- [tec27/seatcamp](https://github.com/tec27/seatcamp) — Despite the name,
  does **not** ship GIFs. Sends a vertically-stacked **JPEG filmstrip**
  (10 frames as one `image/jpeg` ArrayBuffer) and animates by stepping
  `background-position` in CSS. Their docs call this "more efficient" than
  h264 for their use case.

## Why this fits Presence

`voice.ts` already proves the pattern: capture via
`MediaStreamTrackProcessor` → encode with WebCodecs → JSON envelope
`{seq, ts, type, data(base64)}` → `sendModuleData('voice', ...)` → backend
rebroadcasts → peer `onData` decodes/plays. The `_signalsTargets` derived
store and the `_reconcileSignalsAudio` reconciler give the exact lifecycle
hooks.

A new `video-gif` module is structurally a copy of `voice.ts` with:

- video track instead of audio track
- GIF (or filmstrip / WebCodecs keyframes) instead of Opus
- `<img>` swap instead of `AudioBufferSourceNode` scheduling

## Architecture (mirror of voice)

**Send path** (`ui/src/room/modules/video-gif.ts`):

1. Acquire camera handle from a new `CameraSource` (analogous to
   `ui/src/mic-source.ts`) — single shared track, fans out to WebRTC and
   to this module.
2. Wrap the track in `MediaStreamTrackProcessor` to get `VideoFrame`s.
3. Sample at low fps (start: 4 fps). Drop everything else.
4. Downscale to ~120×90 on `OffscreenCanvas` via `drawImage`.
5. Buffer 8 frames (~2 s of clip); hand off to a Web Worker encoder.
6. Worker emits one of: GIF (`gif.js` / `gifenc`), JPEG filmstrip, or
   WebCodecs keyframe sequence (`AVC` or `AV1`).
7. Base64 → `sendModuleData('video-gif', JSON.stringify({seq, ts, fmt, data}),
   get(_signalsTargets))`. One packet per ~1–2 s.

**Receive path:**

- `onData(agentPubKey, chunk)` parses the JSON, blob-URLs the bytes, and
  swaps it into the peer tile's `<img>` overlay (or animates the JPEG
  filmstrip with CSS). Revokes the previous blob URL on swap.

**Lifecycle wiring** (in `ui/src/streams-store.ts`):

- New `_reconcileSignalsVideo()` parallel to `_reconcileSignalsAudio()`.
  Triggers the encode loop iff `conversation.cameraOn && _signalsTargets.size > 0`.
  Subscribes to the same `_signalsTargets` derived store.

## Bandwidth budget

The only concrete signal-size constraint in this repo is the 60 KB
truncation guard on `DiagnosticResponse` in `streams-store.ts:5320–5327`.
A 120×90 / 8-frame palette-quantized GIF lands ~3–8 KB; one per ~1.5 s ≈
16–43 kbps per outbound link. That's the same order as the existing 24
kbps Opus voice, so the per-peer signal budget roughly doubles. Acceptable
for a fallback. Confirm the actual Holochain `send_remote_signal` ceiling
during the spike — the 60 KB number is a self-imposed UI guard, not
necessarily the protocol limit.

## Encoder decision: JPEG filmstrip

The spike at `spikes/low-bandwidth-video/` ran all three candidates against
the same source frames at default knobs (120×90, 8 frames, 250 ms period).
Rolling average over 12 clips on Chrome:

| format     | bytes  | encode ms | decode ms | kbps @ 1.5 s |
| ---------- | ------ | --------- | --------- | ------------ |
| gif        | 72,073 | 300.6     |  9.1      | 384.4        |
| filmstrip  | 18,863 |  12.2     |  8.8      | 100.6        |
| webcodecs  | 29,686 |   6.9     |  6.8      | 158.3        |

Filmstrip wins decisively:

- **3.8× smaller** than GIF, **1.6× smaller** than WebCodecs all-keyframes.
- **25× faster encode** than GIF; ~2× slower than WebCodecs but still 12 ms
  (no Worker needed).
- **No encoder dependency** — just `canvas.convertToBlob('image/jpeg')`.
- **Visually solid** at q=0.6 (subjective check during spike).

Why GIF lost: 72 KB blows past the 60 KB self-imposed truncation guard
already in `streams-store.ts` for `DiagnosticResponse`, and 300 ms encode
would force a Web Worker just to keep the UI responsive.

Why WebCodecs all-keyframes lost: forcing every frame to be a keyframe
discards H.264's inter-frame compression — the only reason to pay the
codec complexity cost. A delta-mode WebCodecs run would be smaller, but
breaks the "every clip independently displayable" semantic the signals
fallback needs (a dropped clip would freeze playback until the next
keyframe). The tradeoff isn't worth the additional decode pipeline,
codec dependency, and Chromium-only support.

## Implementation steps

Spike done; encoder picked. Module name updated to `video-filmstrip`
(was `video-gif`).

1. **Module** — `ui/src/room/modules/video-filmstrip.ts`, modeled on
   `voice.ts`. Controller + module registration with `onData` hook. No
   encoder dep — `canvas.convertToBlob('image/jpeg', q)` only.
2. **CameraSource (or v1 shortcut)** — either introduce
   `ui/src/camera-source.ts` mirroring `mic-source.ts` (clean), or read
   directly from `streamsStore.mainStream` in v1 and refactor later.
   v1 ships sooner; v2 lines up with the architectural symmetry of the
   mic side.
3. **Reconciler** — `_reconcileSignalsVideo` in `streams-store.ts`,
   parallel to `_reconcileSignalsAudio`. Activates when
   `conversation.cameraOn && _signalsTargets.size > 0`. Subscription
   wiring next to `_signalsTargetsUnsub` in the constructor.
4. **Render** — extend the conversation pane to show the received
   filmstrip when WebRTC video is absent and a `video-filmstrip`
   payload has arrived within the last ~3 s. CSS
   `background-image` + `background-position-y` stepping animator
   (seatcamp pattern). After TTL, fall back to the static avatar.
5. **Tests** — **not done.** There are no tests for `video-filmstrip.ts`,
   `filmstrip-worker.ts`, `camera-source.ts`, or `_reconcileSignalsVideo`. The
   three originally scoped — encode/decode roundtrip, size-cap enforcement, and
   reconciler activation over the `cameraOn × signalsTargets` matrix — are all
   still owed. The `__tests__` directory next to the module covers only
   `av-sync` and `voice-playout`.

## Risks and open questions

- **Encode latency on low-end devices.** Worker encode time may exceed
  the clip duration → pipeline starves. Mitigation: drop fps adaptively,
  or skip a clip rather than queue.
- **CameraSource scope.** Cleaner long-term to introduce the source
  abstraction up front, but it's the larger refactor. v1 can read from
  `mainStream` directly and refactor later.
- **Signal hard cap.** Only the self-imposed 60 KB truncation in
  `DiagnosticResponse` is documented in this repo. Confirm the actual
  `send_remote_signal` ceiling during the spike before sizing decisions.
- **Many peers in a room.** Each sender fans out to N−1 targets per clip.
  Voice already does this at 50 fps; video at 0.5–1 fps adds <2% to
  signal traffic — should be fine, but worth measuring once the encoder
  is chosen.
