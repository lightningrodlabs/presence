/**
 * System-audio mix harness — page side.
 *
 * The node suite (`mic-source-mixin.test.ts`) proves the graph PLUMBING
 * against a fake AudioContext. It cannot answer what the output track
 * actually carries, and the one field-visible bug this feature found — a
 * `MediaStreamAudioDestinationNode` built at Web Audio's stereo default
 * feeding 2-channel AudioData into the voice module's 1-channel
 * AudioEncoder — was invisible to those fakes by construction. This page
 * runs the PRODUCTION `MicSource` in real Chromium:
 *
 *   fake microphone (`--use-fake-device-for-media-stream`)
 *     → MicSource.acquire → device track
 *   oscillator → MediaStreamAudioDestinationNode → "system" track
 *     (what the host seam's capture hands us: a destination-node track in
 *      the app's own 48 kHz context)
 *     → MicSource.setMixin → OUTPUT track (`MicSource.track`)
 *   OUTPUT → MediaStreamTrackProcessor → AudioData frames, read for
 *     channel count / sample rate / RMS / energy at the oscillator's
 *     frequency (Goertzel), and fed to an AudioEncoder configured exactly
 *     as `ui/src/room/modules/voice.ts` configures its own.
 *
 * Stand-ins, declared: the store is not constructed (the swap fanout is
 * the node suite's territory — `streams-store-wiring.test.ts`); the host
 * seam is replaced by the oscillator track. Everything on the audio path
 * from `setMixin` to the encoder is production code or the real engine.
 *
 * Exposes `window.runSystemAudioMix(opts)`.
 */
import { MicSource, type MicSourceBindings } from '../src/mic-source';

const G: any = globalThis as any;
const SAMPLE_RATE = 48000;
/** Off any harmonic Chromium's fake microphone beep is likely to carry. */
const TONE_HZ = 3001;

export type TrackReading = {
  frames: number;
  channels: number;
  sampleRate: number;
  rms: number;
  /** Mean Goertzel power at TONE_HZ, normalised per frame. */
  tone: number;
};

export type EncoderReading = { chunks: number; errors: string[] };

export type RunResult = {
  ok: boolean;
  error?: string;
  deviceOnly: TrackReading;
  mixed: TrackReading;
  mixedEncoder: EncoderReading;
  torn: TrackReading;
  /** Negative control: the same oscillator + device through a destination
   *  left at the stereo default, into the same mono encoder config. */
  stereoControl: { channels: number; encoder: EncoderReading };
};

const emptyReading = (): TrackReading => ({ frames: 0, channels: 0, sampleRate: 0, rms: 0, tone: 0 });

function goertzel(samples: Float32Array, freq: number, rate: number): number {
  const k = Math.round((samples.length * freq) / rate);
  const w = (2 * Math.PI * k) / samples.length;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power / (samples.length * samples.length);
}

/** Read `count` AudioData frames off a track; optionally feed each to `encode`. */
async function readTrack(
  track: MediaStreamTrack,
  count: number,
  encode?: (data: any) => void,
): Promise<TrackReading> {
  const r = emptyReading();
  const processor = new G.MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  let sumSq = 0, samples = 0, toneSum = 0;
  try {
    while (r.frames < count) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      r.frames += 1;
      r.channels = value.numberOfChannels;
      r.sampleRate = value.sampleRate;
      const plane = new Float32Array(value.numberOfFrames);
      value.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
      for (let i = 0; i < plane.length; i++) sumSq += plane[i] * plane[i];
      samples += plane.length;
      toneSum += goertzel(plane, TONE_HZ, value.sampleRate);
      if (encode) encode(value);
      value.close();
    }
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  r.rms = samples ? Math.sqrt(sumSq / samples) : 0;
  r.tone = r.frames ? toneSum / r.frames : 0;
  return r;
}

/** The voice module's encoder, configured as `voice.ts` configures it. */
function voiceEncoder(): { encoder: any; reading: EncoderReading; finish: () => Promise<void> } {
  const reading: EncoderReading = { chunks: 0, errors: [] };
  const encoder = new G.AudioEncoder({
    output: () => { reading.chunks += 1; },
    error: (e: any) => { reading.errors.push(String(e?.message ?? e)); },
  });
  encoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 24000 });
  return {
    encoder,
    reading,
    finish: async () => {
      try { await encoder.flush(); } catch (e: any) { reading.errors.push(`flush: ${e?.message ?? e}`); }
      try { encoder.close(); } catch { /* noop */ }
    },
  };
}

/** Encode through the voice config, swallowing the synchronous throw a
 *  closed encoder makes so the error callback's record is what we read. */
function feed(enc: any, reading: EncoderReading) {
  return (data: any) => {
    try { enc.encode(data); } catch (e: any) { reading.errors.push(`encode: ${e?.message ?? e}`); }
  };
}

async function run(opts: { frames?: number } = {}): Promise<RunResult> {
  const frames = opts.frames ?? 50;
  const result: RunResult = {
    ok: false,
    deviceOnly: emptyReading(), mixed: emptyReading(), torn: emptyReading(),
    mixedEncoder: { chunks: 0, errors: [] },
    stereoControl: { channels: 0, encoder: { chunks: 0, errors: [] } },
  };
  if (!G.AudioEncoder || !G.MediaStreamTrackProcessor || !G.AudioContext) {
    result.error = 'WebCodecs / MediaStreamTrackProcessor / AudioContext unavailable';
    return result;
  }

  const bindings: MicSourceBindings = {
    getDeviceId: () => undefined,
    setDeviceId: () => {},
    onTrackChange: () => {},
    onMutedChange: () => {},
    onLifecycleChange: () => {},
    onMixinDropped: reason => { result.error = `mixin dropped: ${reason}`; },
    now: () => performance.now(),
  };
  const mic = new MicSource(bindings);
  const handle = await mic.acquire({ id: 'harness' });
  if (!handle || !mic.track) {
    result.error = `acquire failed: ${JSON.stringify(mic.lifecycle)}`;
    return result;
  }
  const ctx = mic.ensureAudioContext();
  if (!ctx) { result.error = 'no AudioContext'; return result; }
  try { await ctx.resume(); } catch { /* best effort */ }

  // The "system audio": what the host seam hands back is a destination-node
  // track in this same context; an oscillator stands in for the sources.
  const osc = ctx.createOscillator();
  osc.frequency.value = TONE_HZ;
  const gain = ctx.createGain();
  gain.gain.value = 0.3;
  const mixinDest = ctx.createMediaStreamDestination();
  mixinDest.channelCount = 1;
  osc.connect(gain).connect(mixinDest);
  osc.start();
  const mixinTrack = mixinDest.stream.getAudioTracks()[0];

  try {
    result.deviceOnly = await readTrack(mic.track, frames);

    if (!mic.setMixin(mixinTrack)) {
      result.error = 'setMixin refused';
      return result;
    }
    const mixedTrack = mic.track;
    const enc = voiceEncoder();
    result.mixed = await readTrack(mixedTrack, frames, feed(enc.encoder, enc.reading));
    await enc.finish();
    result.mixedEncoder = enc.reading;

    mic.setMixin(null);
    result.torn = await readTrack(mic.track!, frames);

    // Negative control — the bug as shipped before the final review: the
    // same graph through a destination at the stereo default, into the
    // same mono encoder. Built by hand, not by MicSource (which is mono).
    const stereoDest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream([mic.deviceTrack!])).connect(stereoDest);
    gain.connect(stereoDest);
    const control = voiceEncoder();
    const stereo = await readTrack(stereoDest.stream.getAudioTracks()[0], frames, feed(control.encoder, control.reading));
    await control.finish();
    result.stereoControl = { channels: stereo.channels, encoder: control.reading };
    stereoDest.stream.getTracks().forEach(t => t.stop());

    result.ok = !result.error;
    return result;
  } catch (e: any) {
    result.error = `run failed: ${e?.message ?? e}`;
    return result;
  } finally {
    try { osc.stop(); } catch { /* noop */ }
    handle.release();
  }
}

G.runSystemAudioMix = run;
document.getElementById('out')!.textContent = 'ready: window.runSystemAudioMix()';
