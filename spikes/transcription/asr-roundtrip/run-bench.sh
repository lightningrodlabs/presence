#!/usr/bin/env bash
# Spike 0b — ASR round-trip benchmark.
#
# Runs whisper-cli on a sample WAV with multiple model sizes and
# collects wall-clock + internal timings. Prints a summary table.
#
# Usage: ./run-bench.sh path/to/sample.wav
# Requires the whisper-cpp nix package.

set -euo pipefail

WAV="${1:-sample.wav}"
if [[ ! -f "$WAV" ]]; then
  echo "usage: $0 <path-to-wav>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_DIR="$SCRIPT_DIR/models"

# Ordered small → large.
MODELS=(tiny.en base.en small.en)

# Extract audio duration for real-time-factor calc.
AUDIO_SEC=$(nix shell nixpkgs#ffmpeg-headless --command ffprobe \
  -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \
  "$WAV")

printf "\n=== Spike 0b: whisper.cpp round-trip ===\n"
printf "wav: %s (%.2f s)\n\n" "$WAV" "$AUDIO_SEC"
printf "%-10s %8s %10s %10s %8s\n" \
  "model" "size_MB" "wall_ms" "whisper_ms" "rtf"
printf "%-10s %8s %10s %10s %8s\n" \
  "-----" "-------" "-------" "----------" "---"

for m in "${MODELS[@]}"; do
  MODEL_PATH="$MODELS_DIR/ggml-$m.bin"
  if [[ ! -f "$MODEL_PATH" ]]; then
    printf "%-10s  (missing %s — skipping)\n" "$m" "$MODEL_PATH"
    continue
  fi
  SIZE_MB=$(( $(stat -c %s "$MODEL_PATH") / 1024 / 1024 ))

  # Time twice: first run warms caches, second is the measurement.
  TMPOUT=$(mktemp)
  nix shell nixpkgs#whisper-cpp --command whisper-cli \
    -m "$MODEL_PATH" -f "$WAV" --no-prints >/dev/null 2>&1 || true

  WALL_START=$(date +%s%3N)
  nix shell nixpkgs#whisper-cpp --command whisper-cli \
    -m "$MODEL_PATH" -f "$WAV" > "$TMPOUT" 2>&1 || true
  WALL_END=$(date +%s%3N)
  WALL_MS=$((WALL_END - WALL_START))

  # whisper.cpp prints an internal "total time = X ms" line.
  W_MS=$(grep -E "total time = " "$TMPOUT" | awk '{print $5}' | head -1)
  W_MS=${W_MS:-0}

  # RTF = processing_sec / audio_sec. Lower is better; <1 = realtime.
  RTF=$(awk -v w="$W_MS" -v a="$AUDIO_SEC" 'BEGIN{ printf "%.3f", (w/1000)/a }')

  printf "%-10s %8s %10s %10s %8s\n" "$m" "$SIZE_MB" "$WALL_MS" "$W_MS" "$RTF"

  # Save transcript alongside for eyeballing.
  TRANSCRIPT_FILE="$SCRIPT_DIR/transcript-$m.txt"
  grep -E "^\[" "$TMPOUT" > "$TRANSCRIPT_FILE" || true

  rm -f "$TMPOUT"
done

printf "\nTranscripts saved as transcript-<model>.txt next to this script.\n"
printf "wall_ms = total time including nix shell startup overhead.\n"
printf "whisper_ms = whisper.cpp's own \"total time\" (load + infer).\n"
printf "rtf = whisper_ms / audio_ms. <1 means faster-than-realtime.\n"
