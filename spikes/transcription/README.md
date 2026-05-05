# Transcription Phase 0 spikes

Exploratory work for the transcription module. Not part of the main
build; nothing here is expected to survive into Phase 1 source code.
See `/TRANSCRIPTION_PLAN.md` for the broader plan.

Three spikes listed in the plan:

## Spike 0a — Capture pipeline

**Location:** `capture/`

Standalone browser harness (no Presence boot) that opens the mic,
pulls audio via `MediaStreamTrackProcessor` (the same path voice.ts
uses), resamples to 16 kHz mono, and emits a WAV download. Produces
files ready to feed into Spike 0b.

**Goal:** confirm WebCodecs capture works cleanly in a browser/Electron
renderer environment the same way it does inside Presence. Catches
platform-specific issues before they block Phase 1 integration.

**How to run:**

```
cd spikes/transcription/capture
python3 -m http.server 8000   # or any static server
# open http://localhost:8000 in Chromium / Electron-devtools-compatible browser
```

getUserMedia requires a secure context — http://localhost counts as
secure in Chromium, so the plain http server works. Don't just
`file://` open the HTML, getUserMedia will refuse.

## Spike 0b — ASR round-trip

**Location:** `asr-roundtrip/` (TODO)

Feed the PCM/WAV from 0a to a local `whisper.cpp`
(or whisper-server, or equivalent), measure:

- wall-clock latency per utterance
- CPU load during transcription
- RSS / peak memory
- WER on a known-text reference (optional, rough eyeball comparison
  is fine for go/no-go)

**Goal:** confirm the "seconds-behind-realtime with opportunistic
broadcast" design is comfortably achievable on expected hardware.

## Spike 0c — Opportunistic broadcast timing

**Location:** `broadcast-timing/` (TODO)

Analyze recorded calls (not necessarily from Presence — any
2–6-person conversation audio) for the distribution of silence gaps
in each speaker's track. Asks: if we flush queued transcripts only
during gaps ≥ 1.5s, what's the median / P90 / P99 queue depth at
flush time? What's the tail look like for a monologue-heavy call?

**Goal:** decide whether the plan's "flush on silence" is enough, or
whether we need a soft deadline.
