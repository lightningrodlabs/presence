/**
 * Real-WebCodecs tier of the Symptom B harness
 * (docs/SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md).
 *
 * The deterministic unit harness (`voice-playout.test.ts`) proves the scheduling
 * LOGIC given an arrival pattern. It cannot answer the load-bearing assumption:
 * does a *real* AudioDecoder, handed a backlog, emit output faster than real
 * time so the playback head races ahead? This harness answers that empirically.
 *
 * It encodes a tone to Opus, then decodes it back through the PRODUCTION
 * `decidePlayout` against a real AudioContext clock, at a controlled arrival
 * rate (real-time vs burst), recording every scheduled playback interval. A
 * Playwright spec then asserts:
 *   - burst mode actually trips the `overcap-drop` branch (the assumption holds)
 *   - the fixed scheduler never overlaps
 *   - the legacy scheduler DOES overlap on the same burst (the bug)
 *
 * Exposes `window.runVoicePlayout(opts)`.
 */
import { decidePlayout, decidePlayoutLegacy } from '../src/room/modules/voice-playout';

// Mirror the production constants (voice.ts module locals).
const JITTER_SEC = 80 / 1000;
const DRIFT_SEC = 400 / 1000;
const SAMPLE_RATE = 48000;
const FRAME_SAMPLES = 960; // 20ms @ 48kHz

type Mode = 'realtime' | 'burst' | 'burst-legacy';

interface RunOpts {
  mode: Mode;
  frames?: number;
}

interface RunResult {
  mode: Mode;
  ok: boolean;
  error?: string;
  intervals: [number, number][];
  reasons: string[];
  drops: number;
  played: number;
  hasOverlap: boolean;
}

const G: any = globalThis as any;

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

/** Synthesize `count` 20ms mono frames of a 440Hz tone, encode to Opus. */
async function encodeTone(count: number): Promise<Array<{ type: string; timestamp: number; data: Uint8Array }>> {
  const chunks: Array<{ type: string; timestamp: number; data: Uint8Array }> = [];
  const encoder = new G.AudioEncoder({
    output: (chunk: any) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data: buf });
    },
    error: (e: any) => console.error('encoder error', e),
  });
  encoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 24000 });

  for (let i = 0; i < count; i++) {
    const pcm = new Float32Array(FRAME_SAMPLES);
    for (let n = 0; n < FRAME_SAMPLES; n++) {
      const t = (i * FRAME_SAMPLES + n) / SAMPLE_RATE;
      pcm[n] = Math.sin(2 * Math.PI * 440 * t) * 0.25;
    }
    const audioData = new G.AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: FRAME_SAMPLES,
      numberOfChannels: 1,
      timestamp: i * 20000, // µs
      data: pcm,
    });
    encoder.encode(audioData);
    audioData.close();
  }
  await encoder.flush();
  encoder.close();
  return chunks;
}

async function run(opts: RunOpts): Promise<RunResult> {
  const mode = opts.mode;
  const frameCount = opts.frames ?? 60;
  const result: RunResult = {
    mode, ok: false, intervals: [], reasons: [], drops: 0, played: 0, hasOverlap: false,
  };

  if (!G.AudioEncoder || !G.AudioDecoder || !G.AudioData || !G.AudioContext) {
    result.error = 'WebCodecs / AudioContext unavailable in this browser';
    return result;
  }

  const ctx: AudioContext = new G.AudioContext({ sampleRate: SAMPLE_RATE });
  try { await ctx.resume(); } catch { /* best effort */ }

  let encoded: Array<{ type: string; timestamp: number; data: Uint8Array }>;
  try {
    encoded = await encodeTone(frameCount);
  } catch (e: any) {
    result.error = `encode failed: ${e?.message ?? e}`;
    try { await ctx.close(); } catch { /* noop */ }
    return result;
  }

  const decide = mode === 'burst-legacy' ? decidePlayoutLegacy : decidePlayout;
  let head = 0;

  const onDecoded = (audioData: any) => {
    const frameDur = audioData.numberOfFrames / audioData.sampleRate;
    const now = ctx.currentTime;
    if (decide === decidePlayout) {
      const d = decidePlayout(head, now, frameDur, JITTER_SEC, DRIFT_SEC);
      head = d.nextPlaybackTime;
      result.reasons.push(d.reason);
      if (d.action === 'play') {
        scheduleSilent(ctx, audioData, d.at, frameDur);
        result.intervals.push([d.at, d.at + frameDur]);
        result.played++;
      } else {
        result.drops++;
      }
    } else {
      const r = decidePlayoutLegacy(head, now, frameDur, JITTER_SEC, DRIFT_SEC);
      head = r.nextPlaybackTime;
      result.reasons.push('legacy');
      scheduleSilent(ctx, audioData, r.at, frameDur);
      result.intervals.push([r.at, r.at + frameDur]);
      result.played++;
    }
    audioData.close();
  };

  const decoder = new G.AudioDecoder({
    output: onDecoded,
    error: (e: any) => console.error('decoder error', e),
  });
  decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });

  // Feed chunks at the chosen arrival rate.
  for (const c of encoded) {
    decoder.decode(new G.EncodedAudioChunk({ type: c.type, timestamp: c.timestamp, data: c.data }));
    if (mode === 'realtime') {
      await sleep(20); // one frame per 20ms — paced like the wire
    }
    // burst / burst-legacy: feed with no delay — hand the decoder a backlog.
  }
  await decoder.flush();
  decoder.close();

  result.hasOverlap = hasOverlap(result.intervals);
  result.ok = true;
  try { await ctx.close(); } catch { /* noop */ }
  return result;
}

/** Schedule a real (silent) buffer source so the path mirrors production load. */
function scheduleSilent(ctx: AudioContext, audioData: any, at: number, _dur: number) {
  try {
    const buf = ctx.createBuffer(1, audioData.numberOfFrames, audioData.sampleRate);
    const ch = new Float32Array(audioData.numberOfFrames);
    try { audioData.copyTo(ch, { planeIndex: 0, format: 'f32-planar' }); } catch { /* fmt */ }
    buf.copyToChannel(ch, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0; // silent — we measure scheduling, not sound
    src.connect(gain).connect(ctx.destination);
    src.start(Math.max(at, ctx.currentTime));
  } catch { /* scheduling fidelity is best-effort */ }
}

function hasOverlap(intervals: [number, number][]): boolean {
  const s = [...intervals].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < s.length; i++) {
    if (s[i][0] < s[i - 1][1] - 1e-9) return true;
  }
  return false;
}

G.runVoicePlayout = run;

// Render the last result for eyeballing when opened manually.
(async () => {
  const out = document.getElementById('out');
  if (out) out.textContent = 'ready — call window.runVoicePlayout({mode:"burst"})';
})();
