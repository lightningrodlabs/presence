/**
 * The testbed page. One host record drives BOTH carriers, exactly as a real
 * embedder would (`VoiceHost` and `FilmstripHost` are one object here), over
 * one of two message channels:
 *
 *   ?mode=selftest  — `host.send` loops the payload straight back in as if it
 *                     came from a peer called `self-echo`. Encode → wire →
 *                     admission → decode → paint, in one process, with no
 *                     relay and no second machine. This is the smoke test the
 *                     Tauri shell runs.
 *   ?mode=room      — `host.send` addresses a WebSocket relay (`relay.mjs`),
 *                     which broadcasts to every other socket. Two pages (or
 *                     two Tauri windows) form a room.
 *
 * URL parameters (all optional):
 *   mode=selftest|room   default selftest
 *   peer=<id>            our peer id; default a random one
 *   relay=ws://host:port default ws://127.0.0.1:8765
 *   duration=<seconds>   how long to run before evaluating; default 8
 *   auto=1               click Start automatically after 500 ms
 *   inline=1             use the package's inline worker/worklet sources
 *                        (`createInlineFilmstripWorker` / `voiceWorkletModuleUrl`)
 *                        instead of the default `new URL(…, import.meta.url)`
 *   tone=1               feed voice from an oscillator instead of the real mic
 *                        (deterministic: a real mic may be silent)
 *   codec=webcodecs|wasm which Opus backend; wasm pulls the ./opus-wasm subpath
 *
 * Under Tauri the query arrives as `window.__TESTBED_QUERY` (set from
 * TESTBED_URL_QUERY by src-tauri/src/main.rs) because the asset protocol URL
 * carries no search string.
 */
import {
  VoiceCarrier,
  FilmstripCarrier,
  FilmstripPlayback,
  createInlineFilmstripWorker,
  voiceWorkletModuleUrl,
  unpackVoicePayload,
} from '@lightningrodlabs/signals-media';

/**
 * Earliest possible signal that the module graph loaded and executed. Before
 * this line the only failure channel under the Tauri shell is a webview
 * console nobody is reading, so a boot failure looks identical to a shell
 * that never opened the page. Deliberately the FIRST statement after the
 * imports.
 */
/**
 * @param {string} step
 * @param {boolean} ok
 * @param {unknown} detail
 */
const invokeReport = (step, ok, detail) => {
  try {
    globalThis.__TAURI__?.core?.invoke('report', { step, ok, detail: String(detail) });
  } catch {
    /* not under Tauri */
  }
};
invokeReport('boot', true, 'module entered');
globalThis.addEventListener('error', e =>
  invokeReport('boot.error', false, `${e.message} @ ${e.filename}:${e.lineno}`)
);
globalThis.addEventListener('unhandledrejection', e =>
  invokeReport('boot.rejection', false, String(e.reason?.message ?? e.reason))
);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
const rawQuery =
  location.search && location.search.length > 1
    ? location.search
    : globalThis.__TESTBED_QUERY ?? '';
const params = new URLSearchParams(rawQuery);

const mode = params.get('mode') ?? 'selftest';
const inline = params.get('inline') === '1';
const tone = params.get('tone') === '1';
const auto = params.get('auto') === '1';
const codecName = params.get('codec') ?? 'webcodecs';
const durationS = Number(params.get('duration') ?? 8);
const relayUrl = params.get('relay') ?? 'ws://127.0.0.1:8765';
const me = params.get('peer') ?? `peer-${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------
// Page furniture + reporting
// ---------------------------------------------------------------------------
/**
 * `getElementById` with the null arm turned into a throw. These ids are in
 * `index.html` by construction; a null is a broken build, not a runtime
 * condition worth branching on at every call site.
 *
 * @param {string} id
 * @returns {HTMLElement}
 */
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`testbed: #${id} is missing from index.html`);
  return node;
}

/**
 * Message of a thrown value, whatever it is.
 * @param {unknown} e
 * @returns {string}
 */
const errText = e => (e instanceof Error ? e.message : String(e));

const logEl = el('log');
const tilesEl = el('tiles');
const statsEl = el('stats');
const startBtn = /** @type {HTMLButtonElement} */ (el('start'));
el('who').textContent =
  `${me} · mode=${mode} codec=${codecName}${inline ? ' inline' : ''}${tone ? ' tone' : ''} · ${durationS}s`;

/**
 * Everything `host.log` and the carriers' console noise produced, in order.
 * @type {string[]}
 */
const logLines = [];
/**
 * console.error text only — the "no decoder error" assertion reads this.
 * @type {string[]}
 */
const consoleErrors = [];

/** @param {string} line */
function logLine(line) {
  logLines.push(line);
  if (logLines.length > 800) logLines.shift();
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

const nativeError = console.error.bind(console);
console.error = (...args) => {
  const text = args
    .map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
    .join(' ');
  consoleErrors.push(text);
  logLine(`ERR ${text}`);
  nativeError(...args);
};
window.addEventListener('error', e => {
  consoleErrors.push(`window.onerror: ${e.message}`);
  logLine(`ERR window.onerror: ${e.message}`);
});

/**
 * step -> { ok, detail }; Playwright reads this as `__testbed.results`.
 * @type {import('./testbed-globals.js').TestbedResults}
 */
const results = {};

/**
 * @param {string} step
 * @param {boolean} ok
 * @param {unknown} detail
 */
function report(step, ok, detail) {
  results[step] = { ok, detail: String(detail) };
  logLine(`${ok ? 'OK  ' : 'FAIL'} ${step}: ${detail}`);
  try {
    globalThis.__TAURI__?.core?.invoke('report', {
      step,
      ok,
      detail: String(detail),
    });
  } catch {
    /* not under Tauri */
  }
}

// ---------------------------------------------------------------------------
// Peers seen, and the host's target set
// ---------------------------------------------------------------------------
/**
 * peer -> wall-clock ms of its last `hello`.
 * @type {Map<string, number>}
 */
const seen = new Map();
/**
 * Set by `__testbed.setTargets`; null = derive from `seen`.
 * @type {string[] | null}
 */
let targetsOverride = null;

const targets = () =>
  targetsOverride !== null
    ? new Set(targetsOverride)
    : new Set(
        [...seen]
          .filter(([, t]) => Date.now() - t < 5000)
          .map(([p]) => p)
      );

// ---------------------------------------------------------------------------
// Carriers
// ---------------------------------------------------------------------------
const voice = new VoiceCarrier();
const filmstrip = new FilmstripCarrier();

/**
 * The one shared AudioContext (capture AND playout use it, per `VoiceHost`).
 * Constructed lazily and defensively: on a WebKitGTK build with no usable
 * GStreamer audio sink the constructor itself throws, and a throw at module
 * scope would take the whole page down with no diagnostic (the spike's
 * `FINDINGS.md` recorded exactly that failure on a devshell without the
 * plugin path).
 *
 * @type {AudioContext | null}
 */
let ctx = null;
/** @type {string | null} */
let ctxError = null;

/** @returns {AudioContext | null} */
function audioContext() {
  if (ctx || ctxError) return ctx;
  try {
    ctx = new AudioContext({ sampleRate: 48000 });
  } catch (e) {
    ctxError = errText(e);
    invokeReport('audioContext.create', false, ctxError);
  }
  return ctx;
}

/**
 * Resolved before `bind` when ?codec=wasm; see `resolveCodec()`.
 * @type {import('@lightningrodlabs/signals-media').OpusCodec | null}
 */
let wasmCodec = null;

let voiceSent = 0;
let clipsSent = 0;
let epochAdopts = 0;
/**
 * peer -> highest voice session epoch seen from it.
 * @type {Map<string, number>}
 */
const lastEpoch = new Map();
/**
 * performance.now() at `restartVoice()`, cleared by the first voice send.
 * @type {number | null}
 */
let restartT0 = null;
/** @type {number | null} */
let restartCostMs = null;
/**
 * performance.now() when capture was started; reported, not asserted on.
 * @type {number | null}
 */
let captureStartedMs = null;
let started = false;

/**
 * The embedder seam, in one object: this record satisfies BOTH host
 * interfaces, exactly as a real embedder's would. The annotation is what
 * makes a drift in the library's seam a compile error here (`npm run
 * typecheck` in `pretest`) instead of a mystery failure in the nightly gate.
 *
 * @type {import('@lightningrodlabs/signals-media').VoiceHost &
 *       import('@lightningrodlabs/signals-media').FilmstripHost}
 */
const host = {
  targets,
  cadence: () => 'full',
  batchEligible: () => true,
  clock: { now: () => Date.now() },
  log: line => logLine(line),
  audioContext: () => audioContext(),

  async send(kind, payload, to) {
    if (kind === 'voice') {
      voiceSent++;
      if (restartT0 !== null) {
        restartCostMs = Math.round(performance.now() - restartT0);
        restartT0 = null;
      }
    } else if (kind === 'filmstrip') {
      clipsSent++;
    }
    if (mode === 'selftest') {
      // Loop back as a peer. A microtask, not a synchronous call: the real
      // channel is never re-entrant with the encoder callback.
      queueMicrotask(() => deliver({ from: 'self-echo', kind, payload }));
      return;
    }
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ from: me, to: [...to], kind, payload }));
    }
  },

  async acquireMic() {
    if (tone) {
      const c = audioContext();
      if (!c) throw new Error(`no AudioContext: ${ctxError}`);
      const dest = c.createMediaStreamDestination();
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.4;
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      const track = dest.stream.getAudioTracks()[0];
      return {
        track,
        release: () => {
          try {
            osc.stop();
          } catch {
            /* already stopped */
          }
          track.stop();
        },
      };
    }
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = s.getAudioTracks()[0];
    return { track, release: () => track.stop() };
  },

  async acquireCamera() {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
    });
    const track = s.getVideoTracks()[0];
    return { track, release: () => track.stop() };
  },
};

// The bundler-proof fallbacks, assigned rather than conditionally spread so
// that the annotation on `host` actually constrains them: `workletModuleUrl`
// is a FUNCTION returning a URL, not a URL.
if (inline) {
  host.workletModuleUrl = voiceWorkletModuleUrl;
  host.createWorker = createInlineFilmstripWorker;
}

// The Opus backend seam: only defined when ?codec=wasm, so the default path
// never touches the WASM subpath (and never loads libopus-wasm). The seam is
// synchronous and non-null by contract (`OpusCodec`), hence the throw.
if (codecName === 'wasm') {
  host.codec = () => {
    if (!wasmCodec) throw new Error('testbed: the WASM Opus backend never resolved');
    return wasmCodec;
  };
}

async function resolveCodec() {
  if (codecName !== 'wasm') return;
  const { wasmOpus } = await import('@lightningrodlabs/signals-media/opus-wasm');
  wasmCodec = await wasmOpus();
  report('codec.wasm', !!wasmCodec, `backend=${wasmCodec?.name}`);
}

// ---------------------------------------------------------------------------
// Tiles: one <img> per remote peer, painted by FilmstripPlayback
// ---------------------------------------------------------------------------
/**
 * @typedef {object} Tile
 * @property {string} peer
 * @property {HTMLImageElement} img
 * @property {HTMLDivElement} meta
 * @property {HTMLElement} levelBar
 * @property {number} painted
 * @property {number | null} firstPaintMs
 * @property {number | null} lastPaintMs
 * @property {number[]} paintTimes
 * @property {number} depth
 * @property {import('@lightningrodlabs/signals-media').FilmstripPlayback} playback
 * @property {() => void} unsub
 */

/**
 * peer -> tile record.
 * @type {Map<string, Tile>}
 */
const tiles = new Map();

/**
 * @param {string} peer
 * @returns {Tile}
 */
function ensureTile(peer) {
  const existing = tiles.get(peer);
  if (existing) return existing;

  const wrap = document.createElement('div');
  wrap.className = 'tile';
  const img = document.createElement('img');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const level = document.createElement('div');
  level.className = 'level';
  const levelBar = document.createElement('i');
  level.appendChild(levelBar);
  wrap.append(img, level, meta);
  tilesEl.appendChild(wrap);

  // Construction order matters twice over. The playback sinks close over
  // `tile`, so `tile` is declared first and assigned before anything can call
  // them; and `subscribe` fires its callback SYNCHRONOUSLY with the latest
  // frame, so it must come after that assignment or the first paint would hit
  // an unassigned `tile`. The subscriber closes over `playback`, never `tile`.
  /** @type {Tile} */
  let tile;
  const playback = new FilmstripPlayback({
    paint: frame => {
      img.src = frame.url;
      const now = performance.now();
      tile.painted++;
      if (tile.firstPaintMs === null) tile.firstPaintMs = now;
      tile.lastPaintMs = now;
      tile.paintTimes.push(now);
    },
    depth: d => {
      tile.depth = d;
      filmstrip.setBufferDepth(peer, d);
    },
  });
  tile = {
    peer,
    img,
    meta,
    levelBar,
    painted: 0,
    firstPaintMs: null,
    lastPaintMs: null,
    paintTimes: [],
    depth: 0,
    playback,
    // Replaced on the next line; `subscribe` cannot run before `tile` exists.
    unsub: () => {},
  };
  tile.unsub = filmstrip.subscribe(peer, frame => {
    if (frame) playback.push(frame);
    else playback.clear();
  });
  tiles.set(peer, tile);
  return tile;
}

/**
 * Painted frames per second across the whole run: (frames - 1) over the span
 * between the first and last paint. This is what the >= 5 fps assertions read.
 * Deliberately NOT a trailing window — a 5 s window on a 6 fps stream swings
 * between 4 and 7 depending on where the sample lands, which made the room
 * assertion flap (observed 2026-09-10: 105 frames over 19 s read as
 * `fpsIn=4`).
 *
 * @param {Tile} tile
 */
function fpsOf(tile) {
  if (tile.painted < 2 || tile.firstPaintMs === null || tile.lastPaintMs === null) {
    return 0;
  }
  const spanMs = tile.lastPaintMs - tile.firstPaintMs;
  if (spanMs <= 0) return 0;
  return Number((((tile.painted - 1) * 1000) / spanMs).toFixed(2));
}

/**
 * Trailing-5 s paint rate. Display only — see `fpsOf` for why.
 * @param {Tile} tile
 */
function fpsRecent(tile) {
  const now = performance.now();
  while (tile.paintTimes.length && now - tile.paintTimes[0] > 5000) {
    tile.paintTimes.shift();
  }
  return Number((tile.paintTimes.length / 5).toFixed(2));
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------
/**
 * @param {string} peer
 * @param {string} payload
 */
function noteEpoch(peer, payload) {
  /** @type {import('@lightningrodlabs/signals-media').VoiceFramePayload[]} */
  let frames;
  try {
    frames = unpackVoicePayload(payload);
  } catch {
    return;
  }
  for (const f of frames) {
    if (typeof f.ep !== 'number') continue;
    const prev = lastEpoch.get(peer);
    // Strictly-newer only: redundancy copies and reordered packets carry old
    // epochs and must not read as an adoption.
    if (prev === undefined) {
      lastEpoch.set(peer, f.ep);
    } else if (f.ep > prev) {
      epochAdopts++;
      lastEpoch.set(peer, f.ep);
    }
  }
}

/**
 * One frame off the channel, in the relay's wire shape.
 *
 * @typedef {object} RelayFrame
 * @property {string} from
 * @property {string[] | null} [to]
 * @property {'hello' | 'voice' | 'filmstrip'} kind
 * @property {string} payload
 */

/** @param {RelayFrame} frame */
function deliver({ from, kind, payload }) {
  if (kind === 'hello') {
    seen.set(from, Date.now());
    ensureTile(from);
    return;
  }
  ensureTile(from);
  if (kind === 'voice') {
    noteEpoch(from, payload);
    voice.receiveFrame(from, payload);
  } else if (kind === 'filmstrip') {
    filmstrip.receiveFrame(from, payload);
  }
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------
/** @type {WebSocket | null} */
let ws = null;

/** @returns {Promise<boolean>} */
function openChannel() {
  if (mode === 'selftest') {
    // One synthetic peer, kept fresh so `targets()` never empties.
    seen.set('self-echo', Date.now());
    setInterval(() => seen.set('self-echo', Date.now()), 1000);
    report('channel', true, 'selftest loopback (peer=self-echo)');
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    // A local binding, not the module-level `ws`, so the closures below do not
    // have to re-prove it is non-null on every tick.
    const sock = new WebSocket(relayUrl);
    ws = sock;
    sock.onopen = () => {
      report('channel', true, `relay ${relayUrl} open`);
      const hello = () =>
        sock.readyState === 1 &&
        sock.send(JSON.stringify({ from: me, to: null, kind: 'hello', payload: '' }));
      hello();
      setInterval(hello, 1000);
      resolve(true);
    };
    sock.onerror = () => {
      report('channel', false, `relay ${relayUrl} error`);
      resolve(false);
    };
    sock.onmessage = ev => {
      /** @type {RelayFrame} */
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.from === me) return;
      if (msg.to !== null && !(msg.to ?? []).includes(me)) return;
      deliver(msg);
    };
  });
}

// ---------------------------------------------------------------------------
// Stats surface
// ---------------------------------------------------------------------------
/**
 * @template V, R
 * @param {Map<string, V>} m
 * @param {(v: V) => R} f
 * @returns {Record<string, R>}
 */
function mapObj(m, f) {
  return Object.fromEntries([...m].map(([k, v]) => [k, f(v)]));
}

/** @type {<T>(v: T) => T} */
const identity = v => v;

/** @returns {import('./testbed-globals.js').TestbedStats} */
function stats() {
  return {
    me,
    mode,
    started,
    uptimeMs: captureStartedMs === null ? 0 : Math.round(performance.now() - captureStartedMs),
    voiceSent,
    clipsSent,
    voiceRecvPeers: [...voice.peerLastRecvMs.keys()],
    voiceSentPeers: [...voice.peerLastSentMs.keys()],
    recvMs: mapObj(voice.peerLastRecvMs, identity),
    sentMs: mapObj(voice.peerLastSentMs, identity),
    audioLevel: mapObj(voice.peerAudioLevels, identity),
    framesPainted: Object.fromEntries([...tiles].map(([p, t]) => [p, t.painted])),
    fpsIn: Object.fromEntries([...tiles].map(([p, t]) => [p, fpsOf(t)])),
    fpsRecent: Object.fromEntries([...tiles].map(([p, t]) => [p, fpsRecent(t)])),
    bufferDepth: Object.fromEntries([...tiles].map(([p, t]) => [p, t.depth])),
    voiceRx: mapObj(voice.voiceRxStats, s => ({
      jitterMs: s.jitterMs,
      lossPercent: s.lossPercent,
    })),
    videoRx: mapObj(filmstrip.signalsVideoStats, s => ({
      fpsActual: s.fpsActual,
      kbps: s.kbps,
      lossPercent: s.lossPercent,
      transitMs: s.transitMs,
    })),
    epochAdopts,
    epochs: mapObj(lastEpoch, identity),
    restartCostMs,
    targets: [...targets()],
    consoleErrors: consoleErrors.slice(-20),
  };
}

function renderStats() {
  const s = stats();
  statsEl.textContent =
    `voiceSent=${s.voiceSent} clipsSent=${s.clipsSent} epochAdopts=${s.epochAdopts}` +
    (s.restartCostMs !== null ? ` restartCostMs=${s.restartCostMs}` : '') +
    `\ntargets=[${s.targets.join(', ')}]`;
  for (const [peer, tile] of tiles) {
    const lvl = voice.peerAudioLevels.get(peer) ?? 0;
    tile.levelBar.style.width = `${Math.min(100, lvl * 100).toFixed(0)}%`;
    const rx = voice.voiceRxStats.get(peer);
    tile.meta.textContent =
      `${peer}\nfps=${fpsOf(tile)} (5s ${fpsRecent(tile)}) painted=${tile.painted} depth=${tile.depth}` +
      `\nlevel=${lvl.toFixed(3)} loss=${rx?.lossPercent ?? '—'}% jitter=${rx?.jitterMs?.toFixed?.(1) ?? '—'}ms`;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
function evaluateSelftest() {
  const s = stats();
  report(
    'voice.roundTrip',
    voice.peerLastSentMs.size > 0 && voice.peerLastRecvMs.has('self-echo'),
    `sentTo=${s.voiceSentPeers.join(',') || 'none'} recvFrom=${s.voiceRecvPeers.join(',') || 'none'} sends=${s.voiceSent}`
  );

  const loss = voice.voiceRxStats.get('self-echo')?.lossPercent;
  report(
    'voice.loss',
    typeof loss === 'number' && loss < 5,
    `lossPercent=${loss ?? 'null'} jitterMs=${voice.voiceRxStats.get('self-echo')?.jitterMs ?? 'null'}`
  );

  const painted = tiles.get('self-echo')?.painted ?? 0;
  const need = 5 * (durationS - 2);
  report(
    'filmstrip.painted',
    painted >= need,
    `painted=${painted} need>=${need} fps=${s.fpsIn['self-echo'] ?? 0} clipsSent=${s.clipsSent}`
  );

  const level = voice.peerAudioLevels.get('self-echo');
  report(
    'voice.level',
    tone ? typeof level === 'number' && level > 0.01 : typeof level === 'number',
    `peerAudioLevel=${level ?? 'absent'}${tone ? ' (tone=1: must exceed 0.01)' : ' (real mic may be silent; value only reported)'}`
  );
}

function evaluateRoom() {
  const s = stats();
  const remotes = [...seen.keys()].filter(p => p !== me);
  report('room.peers', remotes.length > 0, `remotes=[${remotes.join(', ')}]`);
  for (const p of remotes) {
    const lvl = voice.peerAudioLevels.get(p);
    // Same rule as the selftest: a real mic in a quiet room is legitimately
    // near-silent, so the level is only a PASS CONDITION under ?tone=1.
    report(
      `room.${p}.voice`,
      voice.peerLastRecvMs.has(p) && (!tone || (lvl ?? 0) > 0.01),
      `recv=${voice.peerLastRecvMs.has(p)} level=${lvl ?? 'absent'}${tone ? ' (tone=1: must exceed 0.01)' : ''} loss=${s.voiceRx[p]?.lossPercent ?? 'null'}%`
    );
    report(
      `room.${p}.video`,
      (s.fpsIn[p] ?? 0) >= 5,
      `fpsIn=${s.fpsIn[p] ?? 0} painted=${s.framesPainted[p] ?? 0}`
    );
  }
}

function finish() {
  if (mode === 'selftest') evaluateSelftest();
  else evaluateRoom();
  const ok = Object.values(results).every(r => r.ok);
  window.__testbed.done = true;
  report('SUMMARY', ok, JSON.stringify({ results, stats: stats() }));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  if (started) return;
  started = true;
  startBtn.disabled = true;

  // `nav=reload` identifies the post-settings load under the Tauri shell,
  // which reloads the page after flipping WebKit's media settings.
  const navEntry = /** @type {PerformanceNavigationTiming | undefined} */ (
    performance.getEntriesByType?.('navigation')?.[0]
  );
  const nav = navEntry?.type ?? 'unknown';
  report('env', true, `nav=${nav} ${navigator.userAgent}`);
  report(
    'env.features',
    true,
    `AudioEncoder=${!!globalThis.AudioEncoder} AudioWorkletNode=${!!globalThis.AudioWorkletNode} ` +
      `OffscreenCanvas=${!!globalThis.OffscreenCanvas} createImageBitmap=${!!globalThis.createImageBitmap} ` +
      `Worker=${!!globalThis.Worker} RTCPeerConnection=${!!globalThis.RTCPeerConnection}`
  );

  try {
    const c = audioContext();
    if (!c) throw new Error(ctxError ?? 'AudioContext unavailable');
    await c.resume();
    report('audioContext', c.state === 'running', `state=${c.state} rate=${c.sampleRate}`);
  } catch (e) {
    report('audioContext', false, errText(e));
  }

  try {
    await resolveCodec();
  } catch (e) {
    report('codec.wasm', false, errText(e));
  }

  await openChannel();

  voice.bind(host);
  filmstrip.bind(host);

  captureStartedMs = performance.now();
  const vOk = await voice.startCapture();
  report('voice.startCapture', vOk, `bound=${voice.isBound}`);
  const fOk = await filmstrip.startCapture();
  report('filmstrip.startCapture', fOk, `fps=${filmstrip.getFps()} side=${filmstrip.getCaptureSide()}`);

  setTimeout(finish, durationS * 1000);
}

startBtn.addEventListener('click', () => {
  start().catch(e => report('start', false, errText(e)));
});
setInterval(renderStats, 250);

// ---------------------------------------------------------------------------
// Automation surface
// ---------------------------------------------------------------------------
/** @type {import('./testbed-globals.js').TestbedApi} */
const testbedApi = {
  me,
  mode,
  results,
  done: false,
  stats,
  logLines: () => logLines.slice(),
  consoleErrors: () => consoleErrors.slice(),
  start,

  /**
   * Stop and restart voice capture: a new capture session, hence a new
   * `ep` on the wire (`nextVoiceEpoch`) and `seq` back to 1. Returns the
   * measured cost in ms — from this call to the first voice frame handed to
   * `host.send`.
   */
  async restartVoice() {
    restartCostMs = null;
    restartT0 = performance.now();
    await voice.stopCapture();
    await voice.startCapture();
    const deadline = performance.now() + 5000;
    while (restartCostMs === null && performance.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    return restartCostMs;
  },

  /**
   * Override the host's target set. `setTargets([])` models the host taking
   * this peer off the signals carrier (WebRTC took over); `setTargets(null)`
   * hands control back to the `hello` roster.
   */
  /** @param {string[] | null} list */
  setTargets(list) {
    targetsOverride = list === null ? null : [...list];
    return [...targets()];
  },

  carriers: { voice, filmstrip },
};

window.__testbed = testbedApi;

if (auto) setTimeout(() => startBtn.click(), 500);
