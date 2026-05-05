// Spike 0a — capture pipeline harness.
//
// Intentionally mirrors the voice module's capture path
// (MediaStreamTrackProcessor → pump loop → AudioData chunks) so that
// findings here transfer to the real integration. getUserMedia
// constraints match what MicSource uses in Presence.
//
// Output: WAV file, PCM16, 16 kHz, mono. Resample happens offline after
// the recording stops, via OfflineAudioContext — a proper streaming
// resampler is a Phase 1 concern, not a spike concern.

const TARGET_RATE = 16000;

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const levelBar = document.querySelector('#level > div');

let state = null;

startBtn.addEventListener('click', () => start().catch(reportError));
stopBtn.addEventListener('click', () => stop().catch(reportError));

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  statusEl.textContent += `[${ts}] ${msg}\n`;
  statusEl.scrollTop = statusEl.scrollHeight;
}

function clearLog() {
  statusEl.textContent = '';
}

function reportError(e) {
  console.error(e);
  log(`ERROR: ${e?.message ?? e}`);
}

async function start() {
  if (state) return;
  clearLog();

  if (!('MediaStreamTrackProcessor' in window)) {
    throw new Error('MediaStreamTrackProcessor not available in this browser');
  }

  // Constraints: mirror what voice/WebRTC asks for. Include the three
  // DSP toggles so we see whether the browser honors them; values
  // logged below.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  log(`track settings: ${JSON.stringify(settings, null, 2)}`);

  const nativeRate = settings.sampleRate || 48000;
  log(`native sample rate: ${nativeRate} Hz`);
  if (nativeRate !== 48000) {
    log(`(note: ${nativeRate} ≠ 48000; OfflineAudioContext will resample)`);
  }

  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();

  const chunks = []; // Array<Float32Array> at nativeRate
  let totalFrames = 0;
  let chunkCount = 0;
  let startMs = performance.now();

  state = { stream, track, reader, chunks, nativeRate, stopping: false };

  startBtn.disabled = true;
  stopBtn.disabled = false;

  log('recording…');

  pumpLoop(state, (audioData) => {
    const frames = audioData.numberOfFrames;
    const ch0 = new Float32Array(frames);
    try {
      audioData.copyTo(ch0, { planeIndex: 0, format: 'f32-planar' });
    } catch {
      // some runtimes expose 'f32' interleaved only; for mono that's
      // identical shape, fall back without specifying format.
      audioData.copyTo(ch0, { planeIndex: 0 });
    }
    chunks.push(ch0);
    totalFrames += frames;
    chunkCount += 1;

    // Peak level for the UI meter.
    let peak = 0;
    for (let i = 0; i < ch0.length; i += 4) {
      const v = ch0[i] < 0 ? -ch0[i] : ch0[i];
      if (v > peak) peak = v;
    }
    levelBar.style.width = `${Math.min(100, peak * 140)}%`;

    // Periodic progress log (~every 1s).
    if (chunkCount % 50 === 0) {
      const elapsedMs = performance.now() - startMs;
      log(
        `…${(elapsedMs / 1000).toFixed(1)}s, ${chunkCount} chunks, ` +
        `${totalFrames} frames (avg ${(frames).toFixed(0)} per chunk)`
      );
    }
  }).catch(reportError);
}

async function pumpLoop(s, onChunk) {
  while (!s.stopping) {
    const { value, done } = await s.reader.read();
    if (done) break;
    try {
      onChunk(value);
    } finally {
      try { value.close(); } catch {}
    }
  }
  log('pump loop exited');
}

async function stop() {
  if (!state) return;
  const s = state;
  state = null;
  s.stopping = true;
  stopBtn.disabled = true;

  try { await s.reader.cancel(); } catch {}
  s.track.stop();
  for (const t of s.stream.getTracks()) t.stop();

  levelBar.style.width = '0%';
  log(`captured ${s.chunks.length} chunks at ${s.nativeRate} Hz`);

  if (s.chunks.length === 0) {
    log('no audio captured — nothing to write');
    startBtn.disabled = false;
    return;
  }

  log('concatenating…');
  const total = s.chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Float32Array(total);
  let off = 0;
  for (const c of s.chunks) {
    joined.set(c, off);
    off += c.length;
  }
  log(`joined: ${total} frames at ${s.nativeRate} Hz ` +
      `= ${(total / s.nativeRate).toFixed(2)} s`);

  log(`resampling ${s.nativeRate} → ${TARGET_RATE}…`);
  const resampled = await resampleTo16k(joined, s.nativeRate);
  log(`resampled: ${resampled.length} frames`);

  log('encoding WAV…');
  const wav = encodeWavPcm16(resampled, TARGET_RATE);
  log(`wav size: ${wav.byteLength} bytes`);

  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `spike0a-${ts}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log(`download triggered: ${a.download}`);

  startBtn.disabled = false;
}

async function resampleTo16k(float32, srcRate) {
  if (srcRate === TARGET_RATE) return float32;
  const outLen = Math.floor(float32.length * TARGET_RATE / srcRate);
  const offline = new OfflineAudioContext(1, outLen, TARGET_RATE);
  const buf = offline.createBuffer(1, float32.length, srcRate);
  buf.copyToChannel(float32, 0);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

function encodeWavPcm16(float32, sampleRate) {
  const numSamples = float32.length;
  const byteRate = sampleRate * 2; // mono, 16-bit
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);

  writeAscii(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeAscii(dv, 8, 'WAVE');
  writeAscii(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);       // fmt chunk size
  dv.setUint16(20, 1, true);        // PCM
  dv.setUint16(22, 1, true);        // channels
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, 2, true);        // block align
  dv.setUint16(34, 16, true);       // bits per sample
  writeAscii(dv, 36, 'data');
  dv.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = float32[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    dv.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buf;
}

function writeAscii(dv, offset, str) {
  for (let i = 0; i < str.length; i++) {
    dv.setUint8(offset + i, str.charCodeAt(i));
  }
}
