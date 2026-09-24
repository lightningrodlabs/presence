// SPIKE (throwaway): WebKitGTK media-capability probe for the Presence
// signals-media carrier and its WebRTC carrier. Feature-tests the APIs the
// carriers depend on, then exercises each one for real (Opus encode/decode,
// AudioWorklet PCM tap, JPEG sampling on main thread and in a worker, a
// loopback RTCPeerConnection pair with an audio track). Results go to the
// page and to stdout via the example's `report` command.

const results = {};
const out = document.getElementById('probe');
const log = (step, ok, detail) => {
  results[step] = { ok, detail };
  const line = `${ok ? 'OK  ' : 'FAIL'} ${step}: ${detail}`;
  out.textContent += line + '\n';
  try { window.__TAURI__?.core?.invoke('report', { step, ok, detail: String(detail) }); } catch (_) {}
};
const done = () => {
  const summary = JSON.stringify(results);
  out.textContent += '\nSUMMARY ' + summary + '\n';
  try { window.__TAURI__?.core?.invoke('report', { step: 'SUMMARY', ok: true, detail: summary }); } catch (_) {}
};
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);

// ---------------------------------------------------------------------------
// 0. Environment + feature presence
// ---------------------------------------------------------------------------
log('ua', true, navigator.userAgent);
const G = globalThis;
const present = {
  AudioEncoder: !!G.AudioEncoder,
  AudioDecoder: !!G.AudioDecoder,
  EncodedAudioChunk: !!G.EncodedAudioChunk,
  AudioData: !!G.AudioData,
  VideoEncoder: !!G.VideoEncoder,
  VideoDecoder: !!G.VideoDecoder,
  MediaStreamTrackProcessor: !!G.MediaStreamTrackProcessor,
  MediaStreamTrackGenerator: !!G.MediaStreamTrackGenerator,
  OffscreenCanvas: !!G.OffscreenCanvas,
  AudioWorkletNode: !!G.AudioWorkletNode,
  RTCPeerConnection: !!G.RTCPeerConnection,
  RTCDataChannel: !!G.RTCDataChannel,
  mediaDevices: !!navigator.mediaDevices,
  getUserMedia: !!navigator.mediaDevices?.getUserMedia,
  getDisplayMedia: !!navigator.mediaDevices?.getDisplayMedia,
  Worker: !!G.Worker,
  SharedArrayBuffer: !!G.SharedArrayBuffer,
  WebAssembly: !!G.WebAssembly,
  createImageBitmap: !!G.createImageBitmap,
};
for (const [k, v] of Object.entries(present)) log(`has.${k}`, v, v ? 'present' : 'absent');

// ---------------------------------------------------------------------------
// 1. AudioContext + AudioWorklet PCM tap (no mic needed: oscillator source)
// ---------------------------------------------------------------------------
let ctx = null;
try {
  ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  log('audioContext', true, `state=${ctx.state} sampleRate=${ctx.sampleRate}`);
} catch (e) {
  log('audioContext', false, e?.message ?? e);
}

async function probeWorklet() {
  if (!ctx || !G.AudioWorkletNode) return log('audioWorklet', false, 'no AudioContext or no AudioWorkletNode');
  const src = `
    class Tap extends AudioWorkletProcessor {
      constructor() { super(); this.n = 0; this.peak = 0; }
      process(inputs) {
        const ch = inputs[0]?.[0];
        if (ch) { this.n += ch.length; for (let i = 0; i < ch.length; i += 8) { const v = Math.abs(ch[i]); if (v > this.peak) this.peak = v; } }
        if (this.n >= 48000) { this.port.postMessage({ n: this.n, peak: this.peak }); this.n = 0; this.peak = 0; }
        return true;
      }
    }
    registerProcessor('tap', Tap);`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    await withTimeout(ctx.audioWorklet.addModule(url), 5000, 'addModule');
    const osc = ctx.createOscillator(); osc.frequency.value = 440;
    const node = new AudioWorkletNode(ctx, 'tap');
    const gain = ctx.createGain(); gain.gain.value = 0;
    osc.connect(node); node.connect(gain); gain.connect(ctx.destination);
    osc.start();
    const msg = await withTimeout(new Promise(r => { node.port.onmessage = e => r(e.data); }), 5000, 'worklet frames');
    osc.stop(); node.disconnect();
    log('audioWorklet', msg.peak > 0.1, `1s of PCM tapped: n=${msg.n} peak=${msg.peak.toFixed(3)}`);
  } catch (e) {
    log('audioWorklet', false, e?.message ?? e);
  } finally {
    URL.revokeObjectURL(url);
  }
}
await probeWorklet();

// ---------------------------------------------------------------------------
// 2. WebCodecs Opus: encode 20 synthesized frames, decode them back
// ---------------------------------------------------------------------------
async function probeOpus() {
  if (!G.AudioEncoder || !G.AudioData) return log('opus.encode', false, 'AudioEncoder/AudioData absent');
  let support = null;
  try { support = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 }); } catch (e) { support = { error: e?.message ?? e }; }
  log('opus.isConfigSupported', !!support?.supported, JSON.stringify(support));
  const chunks = [];
  try {
    const enc = new AudioEncoder({ output: c => { const b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push({ type: c.type, timestamp: c.timestamp, data: b }); }, error: e => log('opus.encoderError', false, e?.message ?? e) });
    enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 });
    for (let i = 0; i < 20; i++) {
      const pcm = new Float32Array(960);
      for (let n = 0; n < 960; n++) pcm[n] = Math.sin(2 * Math.PI * 440 * ((i * 960 + n) / 48000)) * 0.25;
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: i * 20000, data: pcm });
      enc.encode(ad); ad.close();
    }
    await withTimeout(enc.flush(), 5000, 'encoder flush');
    enc.close();
    const bytes = chunks.reduce((a, c) => a + c.data.byteLength, 0);
    log('opus.encode', chunks.length >= 15, `${chunks.length} chunks, ${bytes} bytes (${(bytes / chunks.length).toFixed(0)} B/frame)`);
  } catch (e) {
    return log('opus.encode', false, e?.message ?? e);
  }
  if (!G.AudioDecoder || !G.EncodedAudioChunk) return log('opus.decode', false, 'AudioDecoder/EncodedAudioChunk absent');
  try {
    let frames = 0, samples = 0, peak = 0;
    const dec = new AudioDecoder({ output: d => { frames++; samples += d.numberOfFrames; const f = new Float32Array(d.numberOfFrames); try { d.copyTo(f, { planeIndex: 0, format: 'f32-planar' }); } catch { d.copyTo(f, { planeIndex: 0 }); } for (let i = 0; i < f.length; i += 8) peak = Math.max(peak, Math.abs(f[i])); d.close(); }, error: e => log('opus.decoderError', false, e?.message ?? e) });
    dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    for (const c of chunks) dec.decode(new EncodedAudioChunk({ type: c.type, timestamp: c.timestamp, data: c.data }));
    await withTimeout(dec.flush(), 5000, 'decoder flush');
    dec.close();
    log('opus.decode', frames > 0 && peak > 0.1, `${frames} frames, ${samples} samples, peak=${peak.toFixed(3)}`);
  } catch (e) {
    log('opus.decode', false, e?.message ?? e);
  }
}
await probeOpus();

// ---------------------------------------------------------------------------
// 3. Video sampling: main-thread canvas JPEG, and OffscreenCanvas in a Worker
// ---------------------------------------------------------------------------
async function probeJpegMain() {
  try {
    const c = document.createElement('canvas'); c.width = 192; c.height = 192;
    const g = c.getContext('2d'); g.fillStyle = '#48f'; g.fillRect(0, 0, 192, 192); g.fillStyle = '#fff'; g.fillText('probe', 60, 96);
    const t0 = performance.now();
    const blob = await withTimeout(new Promise(r => c.toBlob(r, 'image/jpeg', 0.6)), 5000, 'toBlob');
    log('jpeg.mainThread', !!blob && blob.size > 0, `${blob?.size} bytes in ${(performance.now() - t0).toFixed(1)}ms`);
  } catch (e) { log('jpeg.mainThread', false, e?.message ?? e); }
}
async function probeJpegWorker() {
  if (!G.Worker) return log('jpeg.worker', false, 'no Worker');
  const src = `
    self.onmessage = async () => {
      try {
        if (!self.OffscreenCanvas) throw new Error('no OffscreenCanvas in worker');
        const c = new OffscreenCanvas(192, 192); const g = c.getContext('2d');
        g.fillStyle = '#4f8'; g.fillRect(0, 0, 192, 192);
        const t0 = performance.now();
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
        const buf = await blob.arrayBuffer();
        self.postMessage({ ok: true, bytes: buf.byteLength, ms: performance.now() - t0 });
      } catch (e) { self.postMessage({ ok: false, error: e?.message ?? String(e) }); }
    };`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    const w = new Worker(url, { type: 'module' });
    const r = await withTimeout(new Promise((res, rej) => { w.onmessage = e => res(e.data); w.onerror = e => rej(new Error(e.message)); w.postMessage(1); }), 5000, 'worker');
    w.terminate();
    log('jpeg.worker', r.ok, r.ok ? `${r.bytes} bytes in ${r.ms.toFixed(1)}ms` : r.error);
  } catch (e) { log('jpeg.worker', false, e?.message ?? e); } finally { URL.revokeObjectURL(url); }
}
await probeJpegMain();
await probeJpegWorker();

// ---------------------------------------------------------------------------
// 4. getUserMedia (audio, then video). No device on a headless box is an
//    expected failure — the detail records which error.
// ---------------------------------------------------------------------------
async function probeGum(kind) {
  if (!navigator.mediaDevices?.getUserMedia) return log(`gum.${kind}`, false, 'getUserMedia absent');
  try {
    const s = await withTimeout(navigator.mediaDevices.getUserMedia({ [kind]: true }), 10000, 'getUserMedia');
    const t = s.getTracks()[0];
    log(`gum.${kind}`, !!t, `${t?.kind} readyState=${t?.readyState} label="${t?.label}" settings=${JSON.stringify(t?.getSettings?.() ?? {})}`);
    // MediaStreamTrackProcessor on a real track, if present.
    if (kind === 'audio' && G.MediaStreamTrackProcessor && t) {
      try {
        const p = new MediaStreamTrackProcessor({ track: t });
        const reader = p.readable.getReader();
        const r = await withTimeout(reader.read(), 3000, 'MSTP read');
        log('mstp.audio', !r.done, `read ${r.value?.numberOfFrames} frames @ ${r.value?.sampleRate}`);
        r.value?.close?.(); reader.cancel();
      } catch (e) { log('mstp.audio', false, e?.message ?? e); }
    }
    s.getTracks().forEach(x => x.stop());
    return s;
  } catch (e) { log(`gum.${kind}`, false, `${e?.name}: ${e?.message ?? e}`); return null; }
}
await probeGum('audio');
await probeGum('video');

// ---------------------------------------------------------------------------
// 4b. The capture path that exists without MediaStreamTrackProcessor: live
//     camera -> <video> -> canvas.drawImage -> JPEG at 6 fps; and whether
//     VideoEncoder could carry real video later (vp8 / avc / av1 support).
// ---------------------------------------------------------------------------
async function probeVideoSampling() {
  if (!navigator.mediaDevices?.getUserMedia) return log('video.sample', false, 'getUserMedia absent');
  try {
    const s = await withTimeout(navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }), 10000, 'getUserMedia video');
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = s;
    document.body.appendChild(v);
    await withTimeout(v.play(), 5000, 'video.play');
    await withTimeout(new Promise(r => { if (v.videoWidth) r(); else v.onloadedmetadata = () => r(); }), 5000, 'loadedmetadata');
    const c = document.createElement('canvas'); c.width = 192; c.height = 192; const g = c.getContext('2d');
    let frames = 0, bytes = 0, nonBlank = 0; const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      const side = Math.min(v.videoWidth, v.videoHeight);
      g.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, 192, 192);
      const px = g.getImageData(96, 96, 1, 1).data; if (px[0] + px[1] + px[2] > 0) nonBlank++;
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.6));
      frames++; bytes += blob?.size ?? 0;
      await new Promise(r => setTimeout(r, 167));
    }
    s.getTracks().forEach(t => t.stop()); v.remove();
    log('video.sample', frames >= 8 && nonBlank > 0, `${frames} JPEG frames in 2s from ${v.videoWidth}x${v.videoHeight} (${(bytes / frames).toFixed(0)} B/frame, ${nonBlank} non-blank center pixels)`);
  } catch (e) { log('video.sample', false, `${e?.name}: ${e?.message ?? e}`); }
}
await probeVideoSampling();

async function probeVideoEncoder() {
  if (!G.VideoEncoder) return log('videoEncoder.support', false, 'VideoEncoder absent');
  const codecs = ['vp8', 'vp09.00.10.08', 'avc1.42E01E', 'av01.0.04M.08'];
  const r = {};
  for (const codec of codecs) {
    try { r[codec] = (await VideoEncoder.isConfigSupported({ codec, width: 320, height: 240, bitrate: 200_000, framerate: 15 })).supported; } catch (e) { r[codec] = `err:${e?.message ?? e}`; }
  }
  log('videoEncoder.support', Object.values(r).some(x => x === true), JSON.stringify(r));
  if (r.vp8 !== true) return;
  try {
    const c = new OffscreenCanvas(320, 240); const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 320, 240);
    let chunks = 0, bytes = 0;
    const enc = new VideoEncoder({ output: ch => { chunks++; bytes += ch.byteLength; }, error: e => log('videoEncoder.error', false, e?.message ?? e) });
    enc.configure({ codec: 'vp8', width: 320, height: 240, bitrate: 200_000, framerate: 15 });
    for (let i = 0; i < 10; i++) { const f = new VideoFrame(c, { timestamp: i * 66_666 }); enc.encode(f, { keyFrame: i === 0 }); f.close(); }
    await withTimeout(enc.flush(), 5000, 'video flush'); enc.close();
    log('videoEncoder.vp8', chunks > 0, `${chunks} chunks, ${bytes} bytes`);
  } catch (e) { log('videoEncoder.vp8', false, e?.message ?? e); }
}
await probeVideoEncoder();
try {
  const devs = await navigator.mediaDevices?.enumerateDevices?.();
  log('enumerateDevices', !!devs, (devs ?? []).map(d => `${d.kind}:${d.label || '(no label)'}`).join(', ') || 'none');
} catch (e) { log('enumerateDevices', false, e?.message ?? e); }

// ---------------------------------------------------------------------------
// 5. Loopback RTCPeerConnection pair: data channel + Opus audio track from
//    an oscillator (MediaStreamAudioDestinationNode — no mic needed).
// ---------------------------------------------------------------------------
async function probeRtc() {
  if (!G.RTCPeerConnection) return log('rtc.loopback', false, 'RTCPeerConnection absent');
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  const trail = [];
  const note = (s) => { trail.push(`${(performance.now() / 1000).toFixed(1)}s ${s}`); };
  a.onicecandidate = e => { if (e.candidate) b.addIceCandidate(e.candidate).catch(err => note(`b.addIce err ${err.message}`)); };
  b.onicecandidate = e => { if (e.candidate) a.addIceCandidate(e.candidate).catch(err => note(`a.addIce err ${err.message}`)); };
  a.oniceconnectionstatechange = () => note(`a.ice=${a.iceConnectionState}`);
  b.oniceconnectionstatechange = () => note(`b.ice=${b.iceConnectionState}`);
  a.onconnectionstatechange = () => note(`a.conn=${a.connectionState}`);
  b.onconnectionstatechange = () => note(`b.conn=${b.connectionState}`);

  const dc = a.createDataChannel('probe');
  const dcOpen = new Promise(r => { dc.onopen = () => r(true); });
  const dcEcho = new Promise(r => { b.ondatachannel = e => { e.channel.onmessage = m => r(m.data); }; });

  let audioTrackAdded = false;
  try {
    if (ctx) {
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator(); osc.frequency.value = 330; osc.connect(dest); osc.start();
      const track = dest.stream.getAudioTracks()[0];
      a.addTrack(track, dest.stream);
      audioTrackAdded = true;
    }
  } catch (e) { note(`addTrack err ${e.message}`); }
  const remoteTrack = new Promise(r => { b.ontrack = e => r(e.track); });

  try {
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    note('sdp exchanged');
    log('rtc.sdp', true, `offer has opus=${/opus/i.test(offer.sdp)} audioMLine=${/m=audio/.test(offer.sdp)} ice-ufrag=${/ice-ufrag/.test(offer.sdp)}`);
  } catch (e) {
    return log('rtc.loopback', false, `SDP failed: ${e?.message ?? e} | ${trail.join(' ')}`);
  }

  try {
    await withTimeout(dcOpen, 15000, 'datachannel open');
    dc.send('ping');
    const echoed = await withTimeout(dcEcho, 5000, 'datachannel message');
    log('rtc.dataChannel', echoed === 'ping', `open + message delivered (${echoed}) | ${trail.join(' ')}`);
  } catch (e) {
    log('rtc.dataChannel', false, `${e?.message ?? e} | ${trail.join(' ')}`);
  }

  if (audioTrackAdded) {
    try {
      const t = await withTimeout(remoteTrack, 10000, 'remote track');
      // Give RTP a moment, then check inbound bytes.
      await new Promise(r => setTimeout(r, 2500));
      let bytes = 0, packets = 0, codec = '';
      const stats = await b.getStats();
      stats.forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') { bytes = s.bytesReceived ?? 0; packets = s.packetsReceived ?? 0; } if (s.type === 'codec') codec += (s.mimeType ?? '') + ' '; });
      log('rtc.audioFlow', bytes > 0, `remote ${t.kind} track ${t.readyState}; inbound-rtp bytes=${bytes} packets=${packets}; codecs=${codec.trim() || '(no codec stats)'}`);
    } catch (e) {
      log('rtc.audioFlow', false, e?.message ?? e);
    }
  } else {
    log('rtc.audioFlow', false, 'no audio track added (no AudioContext)');
  }
  log('rtc.loopback', a.connectionState === 'connected' || a.iceConnectionState === 'connected' || a.iceConnectionState === 'completed', `a=${a.connectionState}/${a.iceConnectionState} b=${b.connectionState}/${b.iceConnectionState} | ${trail.join(' ')}`);
  a.close(); b.close();
}
await probeRtc();

done();
