# Low-bandwidth video — encoder bake-off spike

Single-page bake-off comparing three encoders for the
Holochain-signals video fallback path. See `LOW_BANDWIDTH_VIDEO_PLAN.md`
at the repo root for context.

## What it does

Captures N webcam frames at W×H at a fixed period, then encodes the same
frames three ways and records `(bytes, encode_ms, decode_ms)` per format.
Stats are rolling averages over the last 5 clips. Outputs are rendered
side-by-side so visual quality can be eyeballed against the numbers.

Encoders:

1. **GIF** via `gifenc` (palette-quantized, plays natively in `<img>`).
2. **JPEG filmstrip** — N frames vertically stacked into one JPEG,
   animated by stepping CSS `background-position-y` (seatcamp's pattern).
3. **WebCodecs avc1** — every frame encoded as a keyframe (each frame
   independently decodable, matching the lossy-fallback use case where
   any clip can drop without breaking subsequent clips).

## Run it

`getUserMedia` requires a secure context, which means localhost or
HTTPS — `file://` will not work. From this directory:

```
nix develop -c python3 -m http.server 8000
```

Then open <http://localhost:8000/>. Click **Start**, grant camera
permission, and watch the stats fill in.

## Knobs

The control panel exposes the parameters that move the numbers:

- **W / H** — output resolution per frame.
- **frames** — number of frames per clip.
- **period ms** — interframe interval (also the playback delay).
- **JPEG q** — JPEG quality for the filmstrip (0.1–1.0).
- **AVC kbps** — target bitrate for the WebCodecs encoder.

The defaults match the plan (120×90, 8 frames, 250 ms, q=0.6, 100 kbps).

## What to look for

- **bytes** column — at the spike defaults the per-clip target is a few
  KB. The plan's nominal cap is well under 60 KB; if any encoder is
  blowing past 20 KB at default settings, that's a real signal.
- **encode ms** — must stay well under the clip period (2 s at defaults)
  or the pipeline starves. Anything over ~500 ms is suspicious for a
  fallback path.
- **decode ms** — same threshold. Note GIF/JPEG decode includes the
  blob-URL roundtrip, which dominates the cheap actual work.
- **kbps** — projected sustained throughput at 1.5 s clip cadence.
  Compare against the existing 24 kbps voice path.

## Notes

- WebCodecs is Chromium-only at time of writing. On Firefox/Safari the
  `webcodecs` row will show an error; the other two still measure.
- The spike runs encoders on the main thread to keep the page small.
  Production will move them to Web Workers — encode times here are an
  upper bound on the eventual pipeline cost.
- `gifenc` is loaded from `esm.sh`. If offline-spike is needed later,
  vendor it locally.
