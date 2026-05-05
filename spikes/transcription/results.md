# Phase 0 spike results

## Spike 0a — Capture pipeline (done)

**Harness:** `capture/index.html` + `capture/capture.js`, served over
plain HTTP on localhost.

**Device under test:** default mic on Eric's workstation. Track
settings as reported by `getUserMedia`:

```json
{
  "autoGainControl": true,
  "channelCount": 1,
  "echoCancellation": true,
  "latency": 0.01,
  "noiseSuppression": true,
  "sampleRate": 48000,
  "sampleSize": 16,
  "voiceIsolation": false
}
```

Chromium honored `channelCount: 1` but ignored any target sample rate
(48000 Hz native). Expected; `OfflineAudioContext` handles the
resample.

**Observations:**

- `MediaStreamTrackProcessor` emits **480-frame AudioData chunks**
  = 10 ms per chunk at 48 kHz. Voice module code assumes ~20 ms
  chunks in places — not wrong (encoder handles it) but worth
  knowing when sizing the producer-queue flush cadence in Phase 1.
- 17.32 s captured → 831,360 native frames → 277,120 resampled
  16 kHz frames → 554,284-byte WAV (PCM16). All arithmetic matches.
- No clicks, no dropouts, no buffer overruns during ~17 s capture.
- Offline resample at stop time is fine for a spike. For streaming
  ASR in Phase 1 the resample has to be per-chunk; either feed
  `whisper.cpp` at 48 kHz (it resamples internally) or add a small
  streaming resampler. Defer decision until Phase 1 integration.

**Go/no-go:** GO. WebCodecs path is solid.

## Spike 0b — ASR round-trip (done)

**Harness:** `asr-roundtrip/run-bench.sh` invoking `whisper-cli` from
`nixpkgs#whisper-cpp` (upstream binary, no custom build).

**Sample:** the 17.32 s WAV from 0a, spoken clearly into a mid-range
desktop mic.

**Hardware:** 4 threads on the CPU whisper.cpp picked up; no GPU
detected (`whisper_backend_init_gpu: no GPU found`). AVX2/AVX512
available. This is a conservative baseline — a Mac with CoreML
enabled, or a Linux box with CUDA, would be significantly faster.

### Timing and quality

| model    | size MB | whisper.cpp total | RTF    | transcript notes               |
| -------- | ------- | ----------------- | ------ | ------------------------------ |
| tiny.en  |      74 |             586 ms | 0.034  | "how to" for "patterns" (WER)  |
| base.en  |     141 |            1066 ms | 0.062  | correct, good punctuation      |
| small.en |     465 |            3361 ms | 0.194  | correct, lowercase, no commas  |

RTF (real-time factor) = processing seconds / audio seconds. <1 means
faster than real-time. Lower is better.

All three are comfortably faster than real-time even without GPU. Even
small.en at RTF 0.194 processes a 5-minute monologue in ~1 minute —
plenty fast for opportunistic, seconds-behind-realtime broadcast.

### Transcripts for reference

Source speech: *"Okay, this is a test of the emergency broadcasting
system of the FCC explaining patterns number one, two, three, and I
don't know what you think about that but that sounds cool."*

- **tiny.en**: `"Okay, this is a test of the Emergency Broadcasting System of the FCC explaining how to number one, two, three. And I don't know what you think about that, but that sounds cool."`
  → One word wrong ("how to" for "patterns"), otherwise fine. Word
  error introduced by the smaller model on a noisy input region.
- **base.en**: `"Okay, this is a test of the emergency broadcasting system of the FCC explaining patterns number one, two, three, and I don't know what you think about that but that sounds cool."`
  → Perfect. Good punctuation.
- **small.en**: `"okay this is a test of the emergency broadcasting system of the FCC explaining patterns number one two three and I don't know what you think about that but that sounds cool"`
  → Perfect words, but no punctuation or capitalization. Surprising
  regression vs base.en — probably a decode parameter difference or
  prompt sensitivity on this specific sample; not a general small.en
  failing. Worth re-confirming on longer / harder samples before
  generalizing.

### Takeaways for the plan

- **base.en is the right default.** Sweet spot of size (141 MB
  download), speed (16× RT CPU-only), and quality (correct +
  punctuated).
- **tiny.en as a low-power / fast-start fallback.** Under 80 MB, ~29×
  RT, quality is "usable if you squint."
- **small.en for quality upgrades.** 465 MB, 5× RT, but punctuation
  is model-sensitive — we might need to pass different decode flags
  or a priming prompt to get consistently nice formatting.
- **GPU is not required** for the opportunistic use case. Presence
  can assume the Moss-side runtime is CPU-only for capacity planning
  and be pleasantly surprised by GPU installs.
- **No word-level timestamps** from whisper.cpp by default; utterance
  spans (`[start --> end]`) are what we get. Fine for v1 — the plan
  already says word-level sync is out of scope.

**Go/no-go:** GO. whisper.cpp + base.en is the v1 baseline for
`MOSS_LOCAL_MODELS_PLAN.md` M0.

## Cross-reference: Moss M0 spike (2026-04-17)

The Moss-side agent ran its own M0 spike against `smart-whisper`
(whisper.cpp N-API binding) on its Linux x64 machine. Results in
`../moss-ai-transcription/spikes/asr-m0/RESULTS.md`. Two findings
change our picture:

1. **Hardware variance is large.** Their tiny.en batch ran at
   **RTF 0.38 (2.6× real-time)** — vs our **RTF 0.034 (29× real-time)**
   on the same model. ~10× spread. Their Linux box is older / has
   fewer AVX features / uses default thread count. For user-facing
   capacity planning, cite the Moss numbers, not ours. Our machine
   is the optimistic end of the distribution.
2. **Fixed-window streaming is empirically bad.** They tried a
   3 s window + 0.5 s overlap on the 11 s JFK sample. Per-window
   inference: 4.6–6.7 s = **2.7× slower than real-time** per chunk
   (encoder cost not amortized). Word-boundary errors ("ask not
   what" → "ask not why?"). Confirms our plan's batch-on-silence
   approach is the right one — we should never drive streaming at
   sub-utterance granularity.

The Moss agent added `latencyTier: 'fast' | 'ok' | 'slow'` to
`LocalModelCapabilities.asr` to let tools adapt. Our Phase 1 module
should read this and — on `slow` — still run (opportunistic fits),
but consider hiding a future live-caption toggle if we add one.

## Spike 0c — Opportunistic broadcast timing (deferred)

Less urgent than 0a/0b were. The question it asks — "do real
conversations have enough silence gaps ≥ 1.5 s for opportunistic
broadcast to flush queues quickly?" — can be answered with any
multi-speaker recording plus a VAD analysis script. Not a blocker for
Phase 1 since the plan's fallback (soft deadline flush under sustained
speech) is already in the risks section.

Will do when we have a real Presence-call recording to analyze, or
before wiring the producer-queue flush logic in Phase 1, whichever
comes first.
