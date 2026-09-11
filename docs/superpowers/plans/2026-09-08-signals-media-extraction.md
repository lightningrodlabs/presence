# Signals-media extraction Implementation Plan

**Status: LANDED on `signals-media`.** Tasks 1 through 8 executed and committed to that branch (`58bb355`..`f36462a`, through the final fix wave, plus this doc-sync commit; the code commits are confined to `packages/signals-media/`, with the root-glue commits — workspace registration, the nightly-harness step and its guard, the R13 plan correction, the drift alarm and `verify` wiring, and this doc-sync — separate, per spec decision 13). Task 8, the extraction rehearsal, is complete: three passes, the first of which found a real testbed resolution defect (rulings R18/R19), the second and third fully standalone and green; the record is `packages/signals-media/docs/README.md`'s "Extraction rehearsal" section. Merging `signals-media` into `main-0.7` is a pending human step; this document describes the branch, not `main-0.7`, until that merge lands. The corresponding `CLAUDE.md` "True today" bullet was added by the Task 7 doc-sync ("Signals-media extraction round facts"). Rulings R1–R20 are recorded in the SDD ledger and the ones that changed the spec are folded into it as landed-with-amendment markers (R20, the filmstrip clip-geometry validation, is folded into decision 8 as a declared receive-side divergence).

**Pending, by declaration:** the Android on-device selftest and the Linux↔Android room run (ruling R14 — no device was attached; the debug APK is built and its permissions verified), which is what the Presence adoption round's trigger waits on; the macOS, iOS and Windows testbed runs (Volla's hardware, procedures written in `packages/signals-media/testbed/README.md`); and publishing (registry state is checked with `npm view @lightningrodlabs/signals-media version`, never trusted from prose).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `@lightningrodlabs/signals-media` — Presence's Opus-voice and JPEG-filmstrip carrier as a transport-agnostic library with a portable (WebKitGTK-capable) capture path — and prove it with a standalone Tauri testbed — Linux and Android run here, Chromium under Playwright as the CI gate, macOS/iOS/Windows configured here and run by Volla — without touching Presence.

**Architecture:** New workspace package `packages/signals-media` on the `packages/webrtc-peer` scaffold. `VoiceCarrier`/`FilmstripCarrier` are COPIES of Presence's two controllers adapted under the spec's substitution table, with the `MediaStreamTrackProcessor` capture replaced by AudioWorklet capture (voice) and `<video>` + `createImageBitmap` sampling (filmstrip). A `testbed/` Tauri app with a WebSocket relay exercises the library on real platforms; the same page runs under Playwright Chromium in CI. Presence is untouched (declared parallel copy; adoption is a later round).

**Tech Stack:** TypeScript strict, tsc build, vitest 1.6 (node), npm workspaces, Tauri 2.x at the newest release whose wry is ≥ 0.56 (cross-platform permission API; `webkit2gtk` crate `v2_38` on Linux), `libopus-wasm` (optional dependency, WASM Opus for pre-Safari-26 WKWebView), node `ws`, Playwright, nix devshell (node 22) for the package; the `android-service-runtime` `main-0.7` devshell (@ `81193a9`) for the Linux and Android Tauri builds (WebKitGTK 2.52.5, Android SDK/NDK). macOS/iOS/Windows builds are configured here and run by Volla.

**Spec:** `docs/superpowers/specs/2026-09-08-signals-media-extraction-design.md` (revised post-spike). Probe evidence: `packages/signals-media/docs/webkitgtk-probe/FINDINGS.md` and its `main.rs`/`probe.js` (moved there with the package at Task 7), which Task 5 reuses.

## Global Constraints

- Branch `signals-media` off `main-0.7` @ `ab90584`. Landing target `main-0.7` (`--no-ff`). Use a worktree.
- **Extractable (spec decision 13).** Nothing under `packages/signals-media/` references a path outside it. Every commit touching `packages/signals-media/` touches NOTHING else; root glue (workspace registration, lockfile, root scripts, root workflows, the drift-alarm script) goes in separate commits. Task 8 rehearses `git subtree split`. Reviewers check `git log --stat` for mixed commits.
- **`ui/` is untouched**: `git diff --stat main-0.7 -- ui/` empty at every commit. Copied Presence files are read at `ab90584`; cite that hash in file headers as the copy's origin.
- Gate before EVERY commit: `nix develop -c npm run verify` (root scripts include the package from Task 1). Focused: `nix develop -c npm run test -w packages/signals-media`. Tauri builds run in the `android-service-runtime-0.7-spike` worktree's devshell: `nix develop /home/eric/code/metacurrency/holochain/android-service-runtime-0.7-spike -c <cmd>`.
- Bodies copied VERBATIM except the spec's substitution table and the two capture replacements it names. Any `this.store.X` not in the table = STOP.
- Wire stamps `Date.now()`; presence-relevant stamps `host.clock.now()`; display timers `globalThis.setTimeout`. Wire bytes identical to Presence 0.15.6 (Task 7's fixture pins it).
- Package: `@lightningrodlabs/signals-media` 0.1.0, MIT, `sideEffects: false`, ES2022 + DOM + DOM.Iterable, `verbatimModuleSyntax` (relative imports end in `.js`). `files` excludes `testbed/`. `libopus-wasm` is an `optionalDependencies` entry consumed only by the `./opus-wasm` subpath.
- Disk: the machine had ~6 GB free on 2026-09-08. Task 5's Linux build needs ~2 GB; Task 6's Android build needs more. Check `df -h /` before each and stop if under 4 GB — freeing space is the user's call.
- No `Co-Authored-By`/generated-with trailers. No emotional phrasing. Stage explicit paths.
- Per task: adversarial review by a session that did not write it; the substitution table is the checklist for Tasks 2–3.

---

### Task 1: Package scaffold, copied pure modules, host types

**Files:**
- Create: `packages/signals-media/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,LICENSE,.gitignore,flake.nix,flake.lock,rust-toolchain.toml}`, `.github/workflows/verify.yaml` (inert in the monorepo), `scripts/gen-inline-sources.mjs` (stub; real in Task 3), `src/index.ts`, `src/types.ts`, `src/base64.ts`, `src/__tests__/manual-clock.ts`, `src/__tests__/fake-host.ts`, `docs/README.md` (index of the design docs; the spec and findings are copied in at Task 7)
- Copy (cp, not mv): `ui/src/room/modules/voice-playout.ts`, `voice-admission.ts`, `av-sync.ts`, `ui/src/transport/signals-cadence-policy.ts` → `packages/signals-media/src/`; their tests `ui/src/room/modules/__tests__/{voice-playout,av-sync}.test.ts`, `ui/src/__tests__/voice-admission.test.ts`, `ui/src/transport/__tests__/signals-cadence-policy.test.ts` → `src/__tests__/`
- Modify: root `package.json` (workspaces + scripts), `package-lock.json` (via `npm install`)

**Interfaces:**
- Produces: `src/types.ts` exactly as the spec's "Host interfaces" block plus `VoiceRxStats`; `ManualClock { now(); advance(ms); set(ms) }`; `makeFakeHost(opts)` returning `{ host, sent, logs, clock, setTargets, setCadence, setBatchEligible }` where `host` satisfies `VoiceHost & FilmstripHost` and `sent: Array<{ kind, payload, targets: PeerId[] }>`; `bytesToBase64`/`base64ToBytes`.

- [ ] **Step 1: Scaffold.** `package.json`:
```json
{
  "name": "@lightningrodlabs/signals-media",
  "version": "0.1.0",
  "description": "Opus voice and low-fps JPEG video between peers over any message channel (Holochain remote signals) — no WebRTC, works on WebKitGTK. Bring your own transport.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./filmstrip-worker": { "import": "./dist/filmstrip-worker.js" },
    "./voice-capture-worklet": { "import": "./dist/voice-capture-worklet.js" },
    "./opus-wasm": { "types": "./dist/opus-wasm.d.ts", "import": "./dist/opus-wasm.js" }
  },
  "files": ["dist", "README.md", "CHANGELOG.md", "LICENSE"],
  "sideEffects": false,
  "scripts": {
    "build": "tsc -p tsconfig.build.json && node scripts/gen-inline-sources.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:browser": "playwright test -c testbed/playwright.config.ts",
    "prepublishOnly": "npm run typecheck && npm run test && npm run build"
  },
  "keywords": ["holochain", "opus", "webcodecs", "voice", "p2p", "signals", "filmstrip", "webkitgtk", "tauri"],
  "repository": { "type": "git", "url": "https://github.com/lightningrodlabs/signals-media" },
  "publishConfig": { "access": "public" },
  "optionalDependencies": { "libopus-wasm": "<pin the current release after reading its README and LICENSE; STOP if the license is not MIT/BSD-compatible>" },
  "devDependencies": { "typescript": "^5.4.0", "vitest": "^1.6.0" }
}
```
`tsconfig.json`: copy `packages/webrtc-peer/tsconfig.json` (it has no `extends`), set `"lib": ["ES2022", "DOM", "DOM.Iterable"]`, `"include": ["src"]`. `tsconfig.build.json`, `vitest.config.ts`, `LICENSE`: copy from webrtc-peer verbatim. `.gitignore`: `dist/`, `node_modules/`, `testbed/node_modules/`, `testbed/src-tauri/target/`, `testbed/test-results/`, `result`. `scripts/gen-inline-sources.mjs`: `// generated sources are produced in Task 3` (no-op so `build` runs).

`flake.nix` — the package's own devshell, so the directory builds standalone: start from `/home/eric/code/metacurrency/holochain/android-service-runtime-0.7-spike/flake.nix` (@ `81193a9`), keep its `tauriDeps`, rust toolchain (a `rust-toolchain.toml` with `stable` + the `aarch64-linux-android`/`armv7-linux-androideabi` targets), Android SDK/NDK composition, node 22, and the EGL/`GIO_EXTRA_MODULES`/schemas `shellHook`; DROP the holonix input entirely (no Holochain here) — pin `nixpkgs` to the rev the android-service-runtime flake resolves (`2f5a153c…`, so WebKitGTK 2.52.5 matches the probe) plus `rust-overlay`; ADD to `packages`: `gst_all_1.gstreamer gst_all_1.gst-plugins-base gst_all_1.gst-plugins-good gst_all_1.gst-plugins-bad gst_all_1.gst-libav libnice pipewire` (their setup hook exports `GST_PLUGIN_SYSTEM_PATH_1_0`, which the probe had to hand-build), and `playwright-driver.browsers` if present at that rev (else the README documents `npx playwright install chromium`). `cd packages/signals-media && nix develop -c npm run test` must work with NO root involvement — that is the extraction test in miniature; the root `verify` keeps calling the package scripts through the workspace as before.

`.github/workflows/verify.yaml` — `on: [push, pull_request]`, one job: `cachix/install-nix-action`, `nix develop -c npm ci`, `nix develop -c npm run typecheck`, `nix develop -c npm run test`, `nix develop -c npm run build`. Inert here (only root workflows run); it is the standalone repo's CI after extraction.

- [ ] **Step 2: Root scripts.** In root `package.json`: add `"packages/signals-media"` to `workspaces`; `"build:packages": "npm run build -w packages/webrtc-peer && npm run build -w packages/signals-media"`; `"test:unit": "npm run test -w packages/webrtc-peer && npm run test -w packages/signals-media && npm run build:packages && npm run test -w ui"`; `"typecheck"` and `"verify"` each gain `&& npm run typecheck -w packages/signals-media` after the webrtc-peer typecheck. `nix develop -c npm install`; commit the lockfile.

- [ ] **Step 3: `src/types.ts`** — the spec block verbatim, plus `export interface VoiceRxStats { jitterMs: number | null; lossPercent: number | null }`, with `SignalsMediaCadence` re-exported from `./signals-cadence-policy.js` (one authority, not redeclared), plus the codec seam (spec decision 5b):
```ts
export interface OpusPacket { type: 'key' | 'delta'; timestampUs: number; data: Uint8Array }
export interface OpusEncoder { encode(pcm: Float32Array, timestampUs: number): void; flush(): Promise<void>; close(): void }
export interface OpusDecoder { decode(packet: OpusPacket): void; close(): void }
export interface OpusCodec {
  name: 'webcodecs' | 'wasm' | string;
  createEncoder(onPacket: (p: OpusPacket) => void, onError: (e: unknown) => void): Promise<OpusEncoder>;
  createDecoder(onPcm: (pcm: Float32Array, timestampUs: number) => void, onError: (e: unknown) => void): Promise<OpusDecoder>;
}
```
and `VoiceHost` gains `codec?(): OpusCodec` (48 kHz mono, 20 ms frames, 24 kbps target on the encoder side — the constants live in `voice-capture.ts`).

- [ ] **Step 4: Copy the four pure modules and their tests**; fix relative imports to `.js` suffixes. Add to each copied file's header: `// Copied from presence ui/src/... at ab90584 (signals-media extraction). Presence keeps its own copy until the adoption round.`

- [ ] **Step 5: `src/base64.ts`** — the two functions from `voice.ts:962-980` region (`bytesToBase64` with the 0x8000 chunking, `base64ToBytes`), exported.

- [ ] **Step 6: test helpers.** `manual-clock.ts`:
```ts
export class ManualClock {
  constructor(private _now = 0) {}
  now(): number { return this._now; }
  advance(ms: number): void { this._now += ms; }
  set(ms: number): void { this._now = ms; }
}
```
`fake-host.ts`:
```ts
import type { VoiceHost, FilmstripHost, PeerId, MediaKind, TrackHandle } from '../types.js';
import { ManualClock } from './manual-clock.js';
export interface SentPayload { kind: MediaKind; payload: string; targets: PeerId[] }
export function makeFakeHost(opts: { targets?: PeerId[]; cadence?: 'full' | 'voice-only' | 'paused'; batchEligible?: boolean; clock?: ManualClock } = {}) {
  const clock = opts.clock ?? new ManualClock(1_000_000);
  const sent: SentPayload[] = []; const logs: string[] = [];
  let targets = new Set<PeerId>(opts.targets ?? []); let cadence = opts.cadence ?? 'full'; let batchEligible = opts.batchEligible ?? false;
  const track = { readyState: 'live', enabled: true, kind: 'audio', stop() {} } as unknown as MediaStreamTrack;
  const host: VoiceHost & FilmstripHost = {
    targets: () => targets, cadence: () => cadence,
    send: async (kind, payload, t) => { sent.push({ kind, payload, targets: [...t] }); },
    clock, log: line => { logs.push(line); },
    acquireMic: async () => ({ track, release: () => {} } satisfies TrackHandle),
    acquireCamera: async () => ({ track, release: () => {} } satisfies TrackHandle),
    audioContext: () => ({ currentTime: 0, sampleRate: 48000 } as unknown as AudioContext),
    batchEligible: () => batchEligible,
  };
  return { host, sent, logs, clock, setTargets: (t: PeerId[]) => { targets = new Set(t); }, setCadence: (c: typeof cadence) => { cadence = c; }, setBatchEligible: (b: boolean) => { batchEligible = b; } };
}
```

- [ ] **Step 7: `src/index.ts`** — export types from `./types.js`; `decidePlayout`, `decidePlayoutLegacy`, types `PlayoutDecision`, `PlayoutReason`; `decideVoiceAdmission`, `nextVoiceEpoch`, `VOICE_SESSION_ADOPT_GAP_MS`, types; `estimatePlayoutSenderTimeMs`, `framePaceMs`, type `PlayoutAnchor`; `decideSignalsMediaCadence`, `SIGNALS_RTT_DEGRADED_MS`, `SIGNALS_RTT_COLLAPSED_MS`, type `SignalsMediaCadence`; `bytesToBase64`, `base64ToBytes`.

- [ ] **Step 8: Gate + TWO commits** (confined-commit rule). `nix develop -c npm run verify` green (the four copied suites run in the package; ui unchanged). Also `cd packages/signals-media && nix develop -c npm run test` green under the package's own flake.
```bash
git add packages/signals-media
git commit -m "feat(signals-media): scaffold the package; copy the pure voice/cadence helpers and host types"
git add package.json package-lock.json
git commit -m "build: register packages/signals-media in the workspace and the verify gate"
```

---

### Task 2: `VoiceCarrier` with AudioWorklet capture

**Files:**
- Create: `src/voice-carrier.ts` (from `ui/src/room/modules/voice.ts` @ `ab90584`), `src/voice-capture.ts`, `src/voice-capture-worklet.ts`, `src/__tests__/voice-capture.test.ts`, `src/__tests__/voice-carrier-lifecycle.test.ts`
- Copy + re-target: `ui/src/room/modules/__tests__/voice-batch.test.ts`, `ui/src/__tests__/voice-session-epoch.test.ts` → `src/__tests__/`

**Interfaces:**
- Consumes: Task 1 types/helpers.
- Produces: `export class VoiceCarrier` — `bind(host: VoiceHost)`, `unbind()`, `get isBound()`, `startCapture(): Promise<boolean>`, `stopCapture(): Promise<void>`, `receiveFrame(peer, payload)`, `playSquelch(dir)`, `getPlayoutSenderTimeMs(peer)`, maps `peerAudioLevels`, `peerLastSentMs`, `peerLastRecvMs`, `voiceRxStats`; exports `VOICE_BATCH_FRAMES`, `packVoiceFrames`, `unpackVoicePayload`, `VOICE_SAMPLE_RATE = 48000`, `VOICE_FRAME_SAMPLES = 960`, types `VoiceFrame`, `VoiceFramePayload`. `export class VoiceCapture` (`voice-capture.ts`): `start(ctx: AudioContext, track: MediaStreamTrack, onFrame: (pcm: Float32Array, timestampUs: number) => void, moduleUrl: string): Promise<boolean>`, `replaceTrack(track)`, `stop()`. Pure `export function assembleFrames(state, block: Float32Array): Float32Array[]` (the 128→960 accumulator, testable in node). Task 3 mirrors this shape; Task 5's testbed drives `startCapture`.

- [ ] **Step 1: Worklet** `src/voice-capture-worklet.ts` (no imports; compiled to `dist/voice-capture-worklet.js`):
```ts
/// <reference lib="webworker" />
// AudioWorkletProcessor: accumulates 128-frame render quanta into 960-sample
// (20 ms @ 48 kHz) mono blocks and posts each block (transferred) to the main
// thread, where VoiceCarrier wraps it in an AudioData for the Opus encoder.
declare const AudioWorkletProcessor: any; declare function registerProcessor(n: string, c: any): void;
const FRAME = 960;
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(FRAME); private n = 0;
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]; if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(FRAME - this.n, ch.length - i);
      this.buf.set(ch.subarray(i, i + take), this.n); this.n += take; i += take;
      if (this.n === FRAME) { const out = this.buf; (this as any).port.postMessage(out, [out.buffer]); this.buf = new Float32Array(FRAME); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('signals-media-voice-capture', VoiceCaptureProcessor);
export {};
```
(If `tsc` rejects the worklet globals under `lib: DOM`, keep the two `declare` lines; do not add `@types/audioworklet`.)

- [ ] **Step 2: Main-thread pump** `src/voice-capture.ts`:
```ts
export const VOICE_SAMPLE_RATE = 48000; export const VOICE_FRAME_SAMPLES = 960;
export class VoiceCapture {
  private src: MediaStreamAudioSourceNode | null = null; private node: AudioWorkletNode | null = null; private sink: GainNode | null = null;
  private frames = 0; private moduleLoaded = new WeakSet<AudioContext>();
  async start(ctx: AudioContext, track: MediaStreamTrack, onFrame: (pcm: Float32Array, timestampUs: number) => void, moduleUrl: string): Promise<boolean> {
    if (ctx.sampleRate !== VOICE_SAMPLE_RATE) { console.error(`voice: AudioContext must run at ${VOICE_SAMPLE_RATE} Hz, got ${ctx.sampleRate}`); return false; }
    try { if (!this.moduleLoaded.has(ctx)) { await ctx.audioWorklet.addModule(moduleUrl); this.moduleLoaded.add(ctx); } } catch (e) { console.error('voice: addModule failed', e); return false; }
    this.stop();
    this.src = ctx.createMediaStreamSource(new MediaStream([track]));
    this.node = new AudioWorkletNode(ctx, 'signals-media-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    // A zero-gain sink keeps the graph pulled on engines that only process connected nodes (WebKit).
    this.sink = ctx.createGain(); this.sink.gain.value = 0;
    this.src.connect(this.node); this.node.connect(this.sink); this.sink.connect(ctx.destination);
    this.frames = 0;
    this.node.port.onmessage = e => { const pcm = e.data as Float32Array; onFrame(pcm, this.frames++ * 20_000); };
    return true;
  }
  replaceTrack(ctx: AudioContext, track: MediaStreamTrack): void { if (!this.node) return; this.src?.disconnect(); this.src = ctx.createMediaStreamSource(new MediaStream([track])); this.src.connect(this.node); }
  stop(): void { try { this.src?.disconnect(); this.node?.disconnect(); this.sink?.disconnect(); } catch {} if (this.node) this.node.port.onmessage = null; this.src = null; this.node = null; this.sink = null; }
}
```
Plus the pure accumulator used by the worklet's logic, exported for the node test: `export function assembleFrames(state: { buf: Float32Array; n: number }, block: Float32Array): Float32Array[]` — same loop as the worklet's `process`, returning completed frames. The worklet file cannot import it (no imports), so the test pins the algorithm and a comment in both files says they must stay identical (declared duplicate, 12 lines).

- [ ] **Step 3: Test** `voice-capture.test.ts` — `assembleFrames`: 8 blocks of 128 → 1 frame of 960 with 64 samples carried; sample order preserved (fill blocks with an incrementing ramp, assert the frame equals `0..959`); a 960-block yields exactly one frame.

- [ ] **Step 3b: WebCodecs backend** `src/opus-webcodecs.ts` — `export function webCodecsOpus(): OpusCodec | null` (null when `AudioEncoder`/`AudioDecoder`/`EncodedAudioChunk`/`AudioData` are absent). Encoder: the `AudioEncoder({ output, error })` + `configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 })` block from `voice.ts:startCapture`, `encode(pcm, ts)` wrapping the PCM in an `AudioData` (as Task 2 step 4's `encodePcm` did) and emitting `{ type: chunk.type, timestampUs: chunk.timestamp, data }`. Decoder: the `AudioDecoder` block from `openPeer` plus the `EncodedAudioChunk` construction from `decodeVoiceFrame`, emitting Float32 PCM copied out of the `AudioData` (the `copyTo(f32-planar)` with the fallback from `playAudioData`). Test `opus-webcodecs.test.ts` with stub constructors: packets flow encode→onPacket with the chunk's type/timestamp; decode→onPcm with the copied samples.

- [ ] **Step 4: `voice-carrier.ts`** — copy `voice.ts` @ `ab90584`, apply the substitution table (imports, `store`→`host`, `_clock` default `{ now: () => Date.now() }`, `bind`/`unbind`/`isBound`, `micHandle: TrackHandle`, `acquireMic`, `targets()/cadence()/batchEligible()/send('voice', …)`, `voiceRxStats` map replacing the `signalsStats` write, `host.log`, `host.audioContext()`, delete module/registry/singleton, import `./base64.js`). Then the capture replacement:
  - delete `encoderReader`, `buildTrackReader`, `pumpEncoder`, `pipelineGeneration`; add `private capture = new VoiceCapture();`
  - `startCapture()`: keep the WebCodecs presence check but for `AudioEncoder` and `AudioWorkletNode` (not `MediaStreamTrackProcessor`); after the encoder is configured: `const ctx = this.host.audioContext(); if (!ctx) { …stopCapture(); return false; } const ok = await this.capture.start(ctx, handle.track, (pcm, ts) => this.encodePcm(pcm, ts), this.host.workletModuleUrl?.() ?? defaultWorkletUrl());` where `defaultWorkletUrl = () => new URL('./voice-capture-worklet.js', import.meta.url).href`.
  - `encodePcm(pcm, timestampUs)`: the mute gate from `pumpEncoder` verbatim (`if (track.enabled === false) { this.batchBuffer = []; return; }`), then `const ad = new AudioData({ format: 'f32-planar', sampleRate: VOICE_SAMPLE_RATE, numberOfFrames: VOICE_FRAME_SAMPLES, numberOfChannels: 1, timestamp: timestampUs, data: pcm }); try { if (this.encoder?.state === 'configured') this.encoder.encode(ad); } catch (e) { console.error('voice: encode failed', e); } finally { ad.close(); }`.
  - `onMicTrackChanged`: `this.capture.replaceTrack(ctx, newTrack)`.
  - `stopCapture()`: `this.capture.stop()` replaces the reader cancel.
  - Codec seam: `startCapture()` resolves `this.codec = this.host.codec?.() ?? webCodecsOpus()`; if null, log `voice: no Opus codec available (pass VoiceHost.codec, e.g. wasmOpus())` and return false. The encoder is `await this.codec.createEncoder(p => this.handleEncodedPacket(p), e => …)` — `handleEncodedChunk` becomes `handleEncodedPacket(p: OpusPacket)` with `chunk.copyTo(buf)` replaced by `p.data`, `chunk.timestamp` by `p.timestampUs`, `chunk.type` by `p.type`; everything after that line verbatim. `openPeer` uses `this.codec.createDecoder((pcm, ts) => this.playPcm(state, peer, pcm, ts), …)` and `playPcm` is `playAudioData` with the `AudioData`→Float32 copy removed (it receives Float32 already; `numberOfFrames = pcm.length`, `sampleRate = 48000`); the peak-level, `decidePlayout`, anchor, and `source.start` logic verbatim. `decodeVoiceFrame` calls `state.decoder.decode({ type, timestampUs: frame.ts, data: base64ToBytes(frame.data) })`. Receiving while no codec is available: `openPeer` returns null (frame dropped, one log line per peer).
  - The rest of the receive/playout side: verbatim under the table.
  - `grep -n "this.store\|StreamsStore\|registerModule\|mdi\|MediaStreamTrackProcessor" src/voice-carrier.ts` → no hits.

- [ ] **Step 5: Copy + re-target `voice-batch.test.ts` and `voice-session-epoch.test.ts`**: `makeFakeHost` instead of the fake store; `new VoiceCarrier()` per file; assert on `f.sent` instead of a `sendModuleData` spy; the `(voiceController as any).audioContext = { currentTime: 0 }` lines stay. The epoch test's `startCapture` case stubs `AudioEncoder` + `AudioWorkletNode` + `MediaStream`/`MediaStreamAudioSourceNode`-free path: stub `capture.start` via `(v as any).capture = { start: async () => true, stop() {}, replaceTrack() {} }` — that test pins epoch assignment, not capture.

- [ ] **Step 6: `voice-carrier-lifecycle.test.ts`** — bind/unbind symmetry: after `receiveFrame` of one epoch-bearing frame, `unbind()` leaves `isBound === false` and `peerLastRecvMs`, `peerAudioLevels`, `peerLastSentMs`, `voiceRxStats` empty; a frame received while unbound opens no decoder (assert on the `AudioDecoder` stub's instance count). Stubs as in the epoch test.

- [ ] **Step 7: index exports, gate, commit.**
```bash
git add packages/signals-media
git commit -m "feat(signals-media): VoiceCarrier over a VoiceHost seam, AudioWorklet capture, OpusCodec seam with the WebCodecs backend"
```

---

### Task 2b: WASM Opus backend (`./opus-wasm` subpath)

**Files:** Create `src/opus-wasm.ts`, `src/__tests__/opus-wasm.test.ts`; modify `tsconfig.build.json` (nothing if `src/` is the root), `package.json` (`optionalDependencies`, already declared in Task 1).

**Interfaces:**
- Consumes: `OpusCodec`/`OpusEncoder`/`OpusDecoder` (Task 1), `libopus-wasm`'s API (read its README first; the executor records the exact function names used in the file header).
- Produces: `export async function wasmOpus(): Promise<OpusCodec>` (async because the WASM module instantiates asynchronously; hosts call it once at startup and pass the result via `VoiceHost.codec`). Encoder settings identical to the WebCodecs backend: 48 kHz, mono, 20 ms (960 samples), ~24 kbps, `OPUS_APPLICATION_VOIP`. Packet `type` is `'key'` for every packet (Opus has no delta frames; the field exists for wire compatibility). Decoder: `decode` → 960 Float32 samples per packet via `onPcm`.

- [ ] **Step 1: Read `libopus-wasm`'s README and LICENSE** (`npm view libopus-wasm license repository`); STOP if not permissive. Pin the version in `optionalDependencies`.
- [ ] **Step 2: Test first** `opus-wasm.test.ts` (node — the module is single-file ESM and runs in node per its README): encode 20 frames of a 440 Hz tone → 20 packets of 40–120 bytes; decode them back → 19200 samples with peak > 0.1; round-trip through the WebCodecs backend is NOT testable in node (no WebCodecs) — that is the Chromium gate's cross-backend case (Task 5).
- [ ] **Step 3: Implement** `src/opus-wasm.ts` as a thin adapter; no other file imports it (subpath only), so `tsc` must not pull it into `index.ts`.
- [ ] **Step 4: Gate + commit** — `feat(signals-media): WASM Opus backend for WebKit without WebCodecs audio (pre-Safari-26 WKWebView)`.

---

### Task 3: `FilmstripCarrier` with `<video>` sampling; worker; inline sources

**Files:**
- Create: `src/filmstrip-carrier.ts` (from `ui/src/room/modules/video-filmstrip.ts` @ `ab90584`), `src/filmstrip-sampler.ts`, `src/filmstrip-worker.ts` (from `ui/src/room/modules/filmstrip-worker.ts`, rewritten around bitmaps), `src/inline-sources.ts`, `scripts/gen-inline-sources.mjs` (real), `src/__tests__/filmstrip-sampler.test.ts`, `src/__tests__/filmstrip-carrier-lifecycle.test.ts`
- Copy + re-target: `ui/src/room/modules/__tests__/filmstrip-rx-logging.test.ts` → `src/__tests__/`

**Interfaces:**
- Produces: `export class FilmstripCarrier` — `bind(host: FilmstripHost)`, `unbind()`, `isBound`, `startCapture()`, `stopCapture()`, `receiveFrame(peer, payload)`, `subscribe(peer, cb)`, `getLatest(peer)`, `setFps/getFps`, `setCaptureSide/getCaptureSide`, `setBufferDepth`, `setAvSkew`, maps `peerLastSentMs`, `peerLastRecvMs`, `signalsVideoStats`; exports `FILMSTRIP_FPS_OPTIONS`, `FilmstripFps`, `FILMSTRIP_CAPTURE_SIZES`, `FilmstripCaptureSize`, `FILMSTRIP_RX_LOG_INTERVAL_MS`, types `FilmstripFrame`, `VideoSignalsStats`. `export class FilmstripSampler` — `start(track, periodMs, onSample: (bitmap: ImageBitmap, t0: number) => void, timers = globalThis): Promise<boolean>`, `setPeriod(ms)`, `replaceTrack(track)`, `stop()`. `createInlineFilmstripWorker(): Worker`, `voiceWorkletModuleUrl(): string` from `inline-sources.ts`. Worker protocol (main→worker): `{ type: 'frame', bitmap: ImageBitmap, t0: number, capturePeriodMs: number, captureSide: number }` (transfer `[bitmap]`), `{ type: 'stop' }`; worker→main unchanged: `{ type: 'clip', bytes, w, h, n: 1, p, t0, capturedAt }`, `{ type: 'stats', … }`, `{ type: 'error', message }`.

- [ ] **Step 1: Sampler** `src/filmstrip-sampler.ts`:
```ts
export class FilmstripSampler {
  private video: HTMLVideoElement | null = null; private timer: number | null = null; private periodMs = 167; private busy = false;
  async start(track: MediaStreamTrack, periodMs: number, onSample: (bitmap: ImageBitmap, t0: number) => void, timers: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } = globalThis): Promise<boolean> {
    if (typeof document === 'undefined' || !globalThis.createImageBitmap) { console.error('filmstrip: needs a document and createImageBitmap'); return false; }
    this.stop(timers);
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = new MediaStream([track]);
    try { await v.play(); } catch (e) { console.error('filmstrip: video.play failed', e); return false; }
    this.video = v; this.periodMs = periodMs;
    this.timer = timers.setInterval(() => {
      if (this.busy || !this.video || this.video.videoWidth === 0) return;
      this.busy = true; const t0 = Date.now();
      createImageBitmap(this.video).then(b => { this.busy = false; onSample(b, t0); }, () => { this.busy = false; });
    }, this.periodMs) as unknown as number;
    return true;
  }
  setPeriod(ms: number, timers = globalThis): void { /* re-arm the interval with the new period; body mirrors start()'s timer arm */ }
  replaceTrack(track: MediaStreamTrack): void { if (this.video) { this.video.srcObject = new MediaStream([track]); this.video.play().catch(() => {}); } }
  stop(timers = globalThis): void { if (this.timer !== null) { timers.clearInterval(this.timer); this.timer = null; } if (this.video) { this.video.pause(); this.video.srcObject = null; this.video = null; } this.busy = false; }
}
```
(`setPeriod` body: `if (this.timer !== null) { timers.clearInterval(this.timer); this.timer = timers.setInterval(<same callback>, ms) }` — extract the callback into a private method so it is written once. If `createImageBitmap(video)` rejects on a platform in Task 5/6, the documented fallback is drawing the video onto a main-thread canvas and passing `createImageBitmap(canvas)`; add it only when observed.)

- [ ] **Step 2: Test** `filmstrip-sampler.test.ts` (node, fake timers, fake `document`/`createImageBitmap` on `globalThis`): samples at the period (3 ticks → 3 `onSample` calls with increasing `t0`), skips a tick while a bitmap is pending (`busy`), `setPeriod` re-arms, `stop` clears the timer (`vi.getTimerCount() === 0`) and nulls `srcObject`.

- [ ] **Step 3: Worker** — copy `filmstrip-worker.ts`; replace the `start`/readable pump with a `frame` handler: on `{ type: 'frame' }`, lazily create the `OffscreenCanvas(captureSide)`, `drawImage(bitmap, cropped square → 0,0,side,side)`, `bitmap.close()`, `convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })`, post `{ type: 'clip', bytes, w, h, n: 1, p: capturePeriodMs, t0, capturedAt: Date.now() }` with the same once-per-second `stats` message (clips/s, kbps, encode ms; drop the read-gap fields, they measured the deleted reader). Keep `stop` (clears the canvas). No imports.

- [ ] **Step 4: `filmstrip-carrier.ts`** — copy `video-filmstrip.ts`, apply the table; replace `_sendTrackToWorker` with `private sampler = new FilmstripSampler()` driven from `startCapture()`: `const ok = await this.sampler.start(handle.track, this._capturePeriodMs, (bitmap, t0) => this.worker?.postMessage({ type: 'frame', bitmap, t0, capturePeriodMs: this._capturePeriodMs, captureSide: this._captureSide }, [bitmap]))`; `setFps` also calls `this.sampler.setPeriod(...)`; `onTrackChanged` → `this.sampler.replaceTrack(t)`; `stopCapture` → `this.sampler.stop()` before terminating the worker. `_spawnWorker` uses `this.host?.createWorker?.() ?? new Worker(new URL('./filmstrip-worker.js', import.meta.url), { type: 'module' })`. `window.` timers → `globalThis.`. Receive side verbatim.

- [ ] **Step 5: Inline sources.** `scripts/gen-inline-sources.mjs` reads `dist/filmstrip-worker.js` and `dist/voice-capture-worklet.js` and writes `dist/inline-sources.generated.js` + `.d.ts` exporting `FILMSTRIP_WORKER_SOURCE` and `VOICE_CAPTURE_WORKLET_SOURCE` (JSON-stringified). `src/inline-sources.ts`:
```ts
// @ts-ignore generated at build (scripts/gen-inline-sources.mjs); absent in a source checkout
import { FILMSTRIP_WORKER_SOURCE, VOICE_CAPTURE_WORKLET_SOURCE } from './inline-sources.generated.js';
const blobUrl = (src: string) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
export function createInlineFilmstripWorker(): Worker { const u = blobUrl(FILMSTRIP_WORKER_SOURCE); try { return new Worker(u, { type: 'module' }); } finally { URL.revokeObjectURL(u); } }
/** For `VoiceHost.workletModuleUrl`. Not revoked: addModule may fetch it later. */
export function voiceWorkletModuleUrl(): string { return blobUrl(VOICE_CAPTURE_WORKLET_SOURCE); }
```
If `tsc --noEmit` rejects the missing generated module in a clean checkout, check in `src/inline-sources.generated.ts` exporting empty strings and let the build script overwrite the `dist/` copy; record which in the commit message.

- [ ] **Step 6: Copy + re-target `filmstrip-rx-logging.test.ts`** (drop the jsdom pragma; `makeFakeHost`; assert `f.logs`); write `filmstrip-carrier-lifecycle.test.ts`: subscribe replays latest; stop payload → `null` + seq reset; unbind clears maps/timers; send site (`_handleClipFromWorker`) gates on targets and `'full'` cadence and sends `kind: 'filmstrip'`.

- [ ] **Step 7: index exports; `npm run build -w packages/signals-media`** produces `dist/filmstrip-worker.js`, `dist/voice-capture-worklet.js`, `dist/inline-sources.generated.js`. Gate + commit:
```bash
git add packages/signals-media
git commit -m "feat(signals-media): FilmstripCarrier over a FilmstripHost seam, video-element sampling, worker + worklet inline sources"
```

---

### Task 4: `FilmstripPlayback`

**Files:** Create `src/filmstrip-playback.ts`, `src/__tests__/filmstrip-playback.test.ts`. Source of the logic: `ui/src/room/elements/peer-filmstrip.ts` @ `ab90584` (read only).

**Interfaces:**
```ts
export interface QueuedFrame { url: string; index: number; count: number; periodMs: number; width: number; captureTimeMs: number }
export interface FilmstripPlaybackSinks { paint(frame: QueuedFrame): void; depth(frames: number): void; timers?: { setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number): void } }
export const BUFFER_CLIPS = 1; export const MAX_BUFFER_CLIPS = 4;
export class FilmstripPlayback { constructor(sinks: FilmstripPlaybackSinks); push(frame: FilmstripFrame): void; clear(): void; get depth(): number }
```

- [ ] **Step 1: Table test first** (fake timers): starts on the first clip and paints one frame per period; underrun freezes and resumes immediately on the next clip (no re-buffer); queue capped at `MAX_BUFFER_CLIPS` clips dropping oldest; plays 25% fast while more than ~1.5 clips are queued (`framePaceMs`); `clear()` drains, stops the timer, reports depth 0. (Test code as in the pre-revision plan's Task 4 — five `it` blocks; keep them.)
- [ ] **Step 2: Implement** by moving the element's queue logic (`_queue`, `_started`, `_animTimer`, the "Push N entries" loop with `captureTimeMs = captureT0Ms + i * periodMs`, the cap `while`, `_popAndSchedule` with `framePaceMs`) into the class, `paint`/`depth` sinks replacing `_applyFrame`/`_reportAvSkew`/`setBufferDepth`, `this.sinks.timers ?? globalThis` for the timer. Keep the doc comments on `BUFFER_CLIPS`/`MAX_BUFFER_CLIPS`.
- [ ] **Step 3: index export, gate, commit** — `feat(signals-media): FilmstripPlayback — receive-side pacing, framework-free`.

---

### Task 5: Tauri testbed — relay, page, Linux app, Chromium gate

**Files:**
- Create: `testbed/relay.mjs`, `testbed/package.json`, `testbed/ui/{index.html,testbed.js,vite.config.js}`, `testbed/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json,icons/icon.png,src/main.rs}`, `testbed/playwright.config.ts`, `testbed/testbed.spec.ts`, `testbed/README.md`
- Reuse: `packages/signals-media/docs/webkitgtk-probe/main.rs` (the WebKit settings + permission handler + `report`/exit plumbing) — copy the relevant functions, cite the spike.

**Interfaces:**
- Consumes: the package's `dist/` (the testbed's Vite config aliases `@lightningrodlabs/signals-media` → `../../src/index.ts` for dev, and the real `dist` for the Tauri build).
- Produces: `window.__testbed.stats()` → `{ voiceSent, voiceRecvPeers: string[], audioLevel: Record<peer, number>, clipsSent, framesPainted: Record<peer, number>, fpsIn: Record<peer, number>, epochAdopts: number }`, read by Playwright and printed on `SUMMARY`; relay protocol `{ from, to: string[] | null, kind: 'hello' | 'voice' | 'filmstrip', payload }` as JSON text frames, broadcast to every other socket.

- [ ] **Step 1: Relay** `testbed/relay.mjs` (dep `ws`):
```js
import { WebSocketServer } from 'ws';
const port = Number(process.env.PORT ?? 8765);
const wss = new WebSocketServer({ port });
wss.on('connection', ws => { ws.on('message', data => { for (const c of wss.clients) if (c !== ws && c.readyState === 1) c.send(data.toString()); }); });
console.log(`relay on ws://0.0.0.0:${port}`);
```
`testbed/package.json`: `{ "private": true, "type": "module", "scripts": { "relay": "node relay.mjs", "dev": "vite ui", "build": "vite build ui" }, "devDependencies": { "vite": "^6", "ws": "^8", "@playwright/test": "^1.60", "@tauri-apps/cli": "^2.5" } }`.

- [ ] **Step 2: Page** `testbed/ui/testbed.js` — imports `VoiceCarrier`, `FilmstripCarrier`, `FilmstripPlayback`, `voiceWorkletModuleUrl`, `createInlineFilmstripWorker` from the package. Reads `mode` (`selftest` | `room`), `relay`, `peer`, `inline` (use inline worker/worklet), and `codec` (`webcodecs` default | `wasm` → `codec: () => codecInstance` after `await wasmOpus()`) from the URL. Builds ONE host record for both carriers:
```js
const me = params.get('peer') ?? `peer-${Math.random().toString(36).slice(2, 7)}`;
const seen = new Map();                       // peer -> last hello ms
const targets = () => new Set([...seen].filter(([, t]) => Date.now() - t < 5000).map(([p]) => p));
const ctx = new AudioContext({ sampleRate: 48000 });   // resumed on the Start button click
const host = {
  targets, cadence: () => 'full', batchEligible: () => true, clock: { now: () => Date.now() }, log: line => logLine(line),
  send: async (kind, payload, to) => { if (mode === 'selftest') queueMicrotask(() => deliver({ from: 'self-echo', kind, payload })); else ws.send(JSON.stringify({ from: me, to: [...to], kind, payload })); },
  acquireMic: async onTrackChanged => { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); const track = s.getAudioTracks()[0]; return { track, release: () => track.stop() }; },
  acquireCamera: async () => { const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }); const track = s.getVideoTracks()[0]; return { track, release: () => track.stop() }; },
  audioContext: () => ctx,
  ...(inline ? { workletModuleUrl: voiceWorkletModuleUrl, createWorker: createInlineFilmstripWorker } : {}),
};
function deliver({ from, kind, payload }) { if (kind === 'voice') voice.receiveFrame(from, payload); else if (kind === 'filmstrip') filmstrip.receiveFrame(from, payload); else if (kind === 'hello') seen.set(from, Date.now()); }
```
In `selftest`, `seen.set('self-echo', Date.now())` every second so `targets()` is `{self-echo}`. In `room`, `ws.onmessage` parses and calls `deliver` when `to === null || to.includes(me)`; a 1 s `hello` broadcast. A per-peer `<img>` tile subscribes `filmstrip.subscribe(peer, f => playback.push(f))` with `paint: fr => { img.src = fr.url; framesPainted[peer]++ }`. A Start button (user gesture: `ctx.resume()`, `voice.bind(host)`, `filmstrip.bind(host)`, `startCapture()` on both) — auto-clicked after 500 ms when `?auto=1` (Tauri and Playwright pass it; WebKitGTK and Chromium fake-UI both allow this without a gesture). After `duration` seconds (default 8) in `selftest`, evaluate:
  - `voice.peerLastSentMs.size > 0` and `voice.peerLastRecvMs.has('self-echo')` (encode → wire → admission);
  - `voice.voiceRxStats.get('self-echo')?.lossPercent < 5`;
  - `framesPainted['self-echo'] >= 5 * (duration - 2)` (≥ 5 fps painted);
  - `voice.peerAudioLevels.get('self-echo')` reported (value logged; asserted `> 0.01` only when `?tone=1`, which routes an oscillator into a `MediaStreamAudioDestinationNode` as the "mic" — the deterministic path Playwright uses; real mics may be silent).
  Report each as a `report(step, ok, detail)` line and finish with `SUMMARY`; expose `window.__testbed.stats()`.

- [ ] **Step 3: Tauri app** `testbed/src-tauri/` — `Cargo.toml` standalone (`[workspace]`), deps `tauri = "2.5"`, `webkit2gtk = { version = "2.0", features = ["v2_38"] }` (Linux-only via `[target.'cfg(target_os = "linux")'.dependencies]`), `tauri-plugin-log` optional; `tauri.conf.json` with `frontendDist: "../ui/dist"`, `beforeBuildCommand: "npm --prefix ../ run build"`, `withGlobalTauri: true`, `csp: null`, bundle inactive with `icons/icon.png` (32×32, generate as the spike did); `capabilities/default.json` `core:default`. `main.rs` = the spike's: `report` command printing `[testbed] OK/FAIL step: detail` and `app.exit(0)` on `SUMMARY` when `TESTBED_EXIT_ON_SUMMARY=1`; on Linux, `with_webview` → `set_enable_media_stream(true)`, `set_enable_media_capabilities(true)`, `connect_permission_request(|_, r| { r.allow(); true })`, then reload (do NOT set `enable_webrtc`: it is inert and the spike proved it). Window URL: `index.html?mode=selftest&auto=1` by default; `TESTBED_URL_QUERY` env overrides (e.g. `mode=room&relay=ws://10.0.0.5:8765&peer=linux`).

- [ ] **Step 4: Build + selftest on Linux** (in the android-service-runtime devshell, with the nix GStreamer plugin path — `testbed/README.md` records the exact `GST_PLUGIN_SYSTEM_PATH_1_0` recipe from the spike): `df -h /` first; `npm --prefix packages/signals-media/testbed install`; `cargo build` in `src-tauri`; `TESTBED_EXIT_ON_SUMMARY=1 ./target/debug/signals-media-testbed` → every `[testbed] OK` line; then again with `TESTBED_URL_QUERY='mode=selftest&auto=1&inline=1'` (inline worker/worklet). Record both results with date, WebKitGTK version, and GStreamer version in `testbed/README.md`. Two-instance room: run the relay, then two app instances with `peer=a` / `peer=b`; confirm each hears the other (audio level rising on the remote tile) and sees video ≥5 fps; record.

- [ ] **Step 5: Playwright gate** `testbed/playwright.config.ts` (chromium, `launchOptions.args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']`, `webServer` = `vite ui --port 5710`), `testbed.spec.ts`:
  - starts `relay.mjs` on a free port in `beforeAll`;
  - `selftest` page with `?auto=1&tone=1&duration=6` → all `report` steps OK (read `window.__testbed.results`);
  - two pages in `room` mode (`peer=a`, `peer=b`, `tone=1`) → after 8 s, on page b: `voice.peerLastRecvMs.has('a')`, `audioLevel.a > 0.01`, `fpsIn.a >= 5`; symmetric on a;
  - stop/restart admission: on page a call `window.__testbed.restartVoice()` (stop + start capture → new epoch); on b `epochAdopts` increments and frames keep arriving; measure and print the restart cost (ms from `restartVoice()` to the first packet sent) — the spec's carrier-switch claim.
  - carrier switch: on page a call `window.__testbed.setTargets([])` then `setTargets(['b'])` after 3 s (the host-side set change that models WebRTC taking over and handing back); b's `voice.peerLastRecvMs.get('a')` stops advancing within one frame and resumes ~~with an adopted epoch, no decoder error~~ — corrected per ruling R13: a target-set change does NOT restart capture, so the sender keeps the same capture-session epoch and b records NO adoption; it simply resumes receiving the running session. Only `stopCapture()`/`startCapture()` makes a new epoch (the restart-admission step above).
  - cross-backend Opus: page a with `codec=wasm`, page b with `codec=webcodecs` → `audioLevel.a > 0.01` on b; and the reverse pair.
  Run: `nix develop -c npm run test:browser -w packages/signals-media` (Playwright's chromium via `npx playwright install chromium` — document). Add the spec to `.github/workflows/nightly-harness.yaml` as a fourth gated step.

- [ ] **Step 6: README** `testbed/README.md`: what it is, the three run modes, the Linux recipe (the package's own `nix develop`, which exports the GStreamer plugin path; the `webkit2gtk` settings/permission plumbing with a pointer to `main.rs`; the distro dependency list: `gstreamer1.0-plugins-base`, `-good`, `-bad`, `-pipewire`; `-libav` for avc1/av1), the Chromium gate, and the results table (dated). Two commits (confined rule):
```bash
git add packages/signals-media/testbed
git commit -m "feat(signals-media): Tauri testbed with WebSocket relay — Linux selftest/room runs, Chromium Playwright gate"
git add .github/workflows/nightly-harness.yaml
git commit -m "ci: run the signals-media Chromium testbed in the nightly harness"
```

---

### Task 6: Android target

**Files:** Create `testbed/src-tauri/gen/android/` (via `npm --prefix packages/signals-media/testbed exec tauri android init` in the android-service-runtime devshell), then modify `gen/android/app/src/main/AndroidManifest.xml` and `.../MainActivity.kt`; update `testbed/README.md`.

- [ ] **Step 1: Verify wry's Android permission handling before writing any Kotlin.** `grep -rn "onPermissionRequest" ~/.cargo/registry/src/*/wry-0.5*/src/android/kotlin/` — if `RustWebChromeClient.kt` grants `request.resources` when the app holds the OS permissions, only the manifest and a runtime OS-permission request are needed; if absent, override `onPermissionRequest` in a `WebChromeClient` subclass wired in `MainActivity`. Record which case applied in the README.
- [ ] **Step 2: Manifest**: add `<uses-permission android:name="android.permission.RECORD_AUDIO" />`, `CAMERA`, `MODIFY_AUDIO_SETTINGS`, `INTERNET`; `<uses-feature android:name="android.hardware.camera" android:required="false" />`.
- [ ] **Step 3: Runtime permission** in `MainActivity.kt` `onCreate`: `ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA), 1)` before `super.onCreate` returns control to the webview; the page's Start button waits until `?auto=1` fires, which is after the dialog in practice — if the selftest starts before the grant, add a `Promise` in `testbed.js` that retries `getUserMedia` every second for 30 s.
- [ ] **Step 4: Build + run on a device** (`df -h /` first): `npm --prefix packages/signals-media/testbed exec tauri android build --debug`, `adb install`, launch with the selftest URL baked in (Tauri Android uses the `frontendDist` index; pass query via `tauri.conf.json` `windows[0].url` = `index.html?mode=selftest&auto=1`); capture `adb logcat | grep testbed` → all OK. Then the Linux↔Android room: relay on the laptop, Android app built with `mode=room&relay=ws://<laptop-ip>:8765&peer=android`, Linux instance `peer=linux`; confirm audio both ways and video ≥5 fps both ways; record versions (device, Android WebView version from `adb shell dumpsys package com.google.android.webview | grep versionName`).
- [ ] **Step 5: README results + commit** — `feat(signals-media): Android testbed target — permissions plumbing, selftest and Linux↔Android room results`.

---

### Task 6b: macOS, iOS, and Windows builds — configured here, run by Volla

**Files:** Modify `testbed/src-tauri/tauri.conf.json` (macOS `bundle.macOS.entitlements`, `Info.plist` merge), create `testbed/src-tauri/Info.plist`, `testbed/src-tauri/Entitlements.plist`, `testbed/src-tauri/gen/apple/` (via `tauri ios init` if the toolchain allows on Linux — it does not; commit the two plists and document `tauri ios init` as Volla's first step), `testbed/README.md` per-platform procedures.

- [ ] **Step 1: Pin the Tauri version** to the newest 2.x whose `tauri-runtime-wry` pulls wry ≥ 0.56 (`cargo tree -p tauri-runtime-wry -i wry` after `cargo update`); read wry 0.56's permission API in its docs (`docs.rs/wry` → search `PermissionRequest`) and note whether Tauri exposes it on `WebviewWindowBuilder`. If it does, replace the Linux-only `connect_permission_request` in `main.rs` with the cross-platform handler (allow camera + microphone, deny the rest) and keep the Linux WebKit settings call; if it does not, keep the Linux path and document the platform-specific gaps.
- [ ] **Step 2: Apple config.** `Info.plist` with `NSMicrophoneUsageDescription` and `NSCameraUsageDescription`; `Entitlements.plist` with `com.apple.security.device.audio-input` and `com.apple.security.device.camera` (hardened runtime); reference both from `tauri.conf.json` (`bundle.macOS.entitlements`, `bundle.iOS` frameworks none). Document the macOS 14 double-prompt (wry #1195, open) as expected behavior, not a failure.
- [ ] **Step 3: Windows config.** Nothing in `tauri.conf.json` beyond defaults; document that WebView2 prompts natively when no handler is installed and that a "block" answer is sticky (Tauri issue #5042) — the README tells the tester how to reset the site permission.
- [ ] **Step 4: Procedure** in `testbed/README.md`, one section per platform, each ending with the exact command and the expected `[testbed] OK …` / `SUMMARY` transcript to paste back. For Apple, the `codec=wasm` selftest is REQUIRED (pre-26 OS) and the `codec=webcodecs` selftest is run only on macOS 26 / iOS 26+, recording `navigator.userAgent`.
- [ ] **Step 5: Commit** — `feat(signals-media): macOS/iOS/Windows testbed configuration and hand-off procedure`. Results are recorded in a later docs commit when Volla reports them.

---

### Task 7: Wire fixture, README, CHANGELOG, pack dry-run, doc-sync

**Files:** Create `src/__tests__/fixtures/wire.json`, `src/__tests__/wire-fixture.test.ts`, `packages/signals-media/README.md`, `CHANGELOG.md`; modify `CLAUDE.md`, the spec (landed markers), this plan (status line).

- [ ] **Step 1: Fixture + test** — the four payload shapes derived from Presence @ `ab90584` (voice v1 frame with `red`, voice v2 batch, filmstrip clip, filmstrip stop) and a package test asserting the exact key sets, `packVoiceFrames` byte-equality, and `unpackVoicePayload` round-trips. The package test reads ONLY its own fixture (extractability). The **drift alarm** is a ROOT script, `scripts/check-signals-media-drift.mjs`: it loads `packages/signals-media/src/__tests__/fixtures/wire.json` and greps `ui/src/room/modules/voice.ts` and `video-filmstrip.ts` for every fixture field name (`seq`, `ts`, `wts`, `ep`, `red`, `type`, `data`, `v`, `frames`, `w`, `h`, `n`, `p`, `t0`, `kind`), exiting non-zero with the missing name if Presence's copy no longer mentions one. Root `verify` gains `&& node scripts/check-signals-media-drift.mjs` (its own commit). It is dropped on extraction.
- [ ] **Step 2: README** — pitch; **Browser support** first screen (the spec's platform matrix: Chromium full; WebKitGTK 2.52+ signals-only with the GStreamer plugin list and the permission handler, WebRTC compiled out of stock builds — link the findings; WKWebView with `wasmOpus()` before Safari 26 and WebCodecs from 26; WebView2 full); **Carrier switching** (the spec's contract, with the measured restart cost from Task 5 and a 20-line host ping/pong sketch that feeds `decideSignalsMediaCadence`); **Integration** (Holochain zome pair reference, host record, `receiveFrame` wiring, 48 kHz AudioContext unlocked on a gesture, `startCapture` on unmute, batch capability gate, `targets()` semantics, signal-size expectations); **Wire format**; **Receiving video** (`subscribe` + `FilmstripPlayback`); **Stats and forensics**; **Worker/worklet delivery** (default vs inline); **Testbed** pointer; **Design notes** pointers. No counts, no registry claims.
- [ ] **Step 3: CHANGELOG** `## 0.1.0 — <date>` — initial release; copied from Presence `ab90584`; capture path change (AudioWorklet / video-element sampling) declared; wire-compatible with Presence 0.15.6.
- [ ] **Step 4: `npm pack --dry-run`** in the package: `dist/` (index, worker, worklet, inline sources, `.d.ts`), README, CHANGELOG, LICENSE; no `src/`, no `testbed/`.
- [ ] **Step 5: CLAUDE.md** "True today" bullet **Signals-media extraction round facts**: package/version/dir; the host seam names; that `ui/src/room/modules/{voice,video-filmstrip}.ts` and the four pure modules now have a DECLARED PARALLEL COPY in the package (working agreement 1), what retires it (the Presence adoption round, triggered by the testbed being green on Linux, Android, and Chromium — record the dates the three went green), and the drift alarm (the package's wire-fixture test reads Presence's sources); the capture-path difference (package: AudioWorklet + video-element sampling; Presence: `MediaStreamTrackProcessor`) as a declared divergence the adoption round resolves; the probe's facts with the file citation; registry state checked with `npm view @lightningrodlabs/signals-media version`. Mark the spec's decisions landed/not-landed; set this plan's status.
- [ ] **Step 5b: Docs travel with the package.** ~~`git mv spikes/webkitgtk-media-probe packages/signals-media/docs/webkitgtk-probe`~~ — superseded by ruling R16: a `git mv` across the two trees would be a mixed commit, so the package-only commit COPIES `FINDINGS.md`/`main.rs`/`probe.js` into `packages/signals-media/docs/webkitgtk-probe/` and the root-glue commit deletes `spikes/webkitgtk-media-probe/`. Copy this spec to `packages/signals-media/docs/design.md` with a header line naming the monorepo original as the authoritative copy until extraction; `docs/README.md` indexes both plus `testbed/README.md`.
- [ ] **Step 6: Gate + commits** (confined rule): package docs/fixture/README/CHANGELOG in one commit — `docs(signals-media): 0.1.0 README/CHANGELOG, wire fixture, design docs travel with the package`; root drift script + `verify` wiring + CLAUDE.md + spec/plan markers in a second — `build: signals-media drift alarm in verify; doc-sync for the extraction round`.

---

### Task 8: Extraction rehearsal

**Files:** none committed (scratch only); `packages/signals-media/docs/README.md` gains a dated "Extraction rehearsal" line.

_Executed 2026-09-10 over three passes (commits `cc20128`, `35c712a`, `2f35860`, `9ca4bfa`). Pass 1 found a real defect — `testbed/` resolved the package only through the monorepo's hoisted root `node_modules`, and its Vite config reached up to the monorepo root for `server.fs.allow`, so standalone the browser gate could not typecheck. Ruling R19 fixed it package-only (a `file:..` dependency; `fs.allow` derived from resolution); ruling R18 governs the scratch-tree-and-delete procedure. Passes 2 and 3 ran with no monorepo access: install, typecheck, unit suites, build, `npm pack --dry-run` and the Playwright gate all green, with the pack shasum byte-identical across passes. Consequence recorded for the real extraction: the extracted repo's first commit must add the lockfile `npm install` generates, because the package's own `.github/workflows/verify.yaml` runs `npm ci`._

- [x] **Step 1:** `git log --stat --oneline main-0.7..HEAD -- packages/signals-media | grep -v "packages/signals-media"` shows only commit headers (no file outside the directory in any commit that touches it). A mixed commit is a finding; fix by splitting before proceeding.
- [x] **Step 2:** `git subtree split --prefix=packages/signals-media -b signals-media-standalone`; `git worktree add <scratchpad>/signals-media-standalone signals-media-standalone`.
- [x] **Step 3:** In the scratch worktree, with NO access to the monorepo: `nix develop -c npm ci && nix develop -c npm run typecheck && nix develop -c npm run test && nix develop -c npm run build && nix develop -c npm pack --dry-run`; then `npm run test:browser` (Playwright) if a display is available. Every step green.
- [x] **Step 4:** Record the date and the split commit hash in `packages/signals-media/docs/README.md`; delete the scratch branch and worktree. Commit (package-only) — `docs(signals-media): extraction rehearsal passed`.

---

## Self-review

- **Spec coverage:** decision 13 (branch, extractable) → Global Constraints, Task 1 (flake, inert workflow, `repository`), Task 7 (drift alarm outside the package, docs inside), Task 8 (rehearsal); decisions 1, 3 → Tasks 2–3; 2 (copy + trigger + drift alarm) → Task 1 headers, Task 7 steps 1 and 5; 4 → Tasks 1, 4; 5 (portable capture) → Task 2 steps 1–4, Task 3 steps 1–4; 6, 7 → the table rows; 8 → Task 7 step 1; 9 (testbed, targets, Chromium gate) → Tasks 5–6; 10 (inline sources, overrides) → Task 3 step 5, Task 5 step 4 inline run; 11 → Task 1; 12 (`ui/` untouched) → Global Constraints. Declared limitations → README (Task 7 step 2). Testing section → Tasks 2–6.
- **Names across tasks:** `OpusCodec`/`OpusPacket`/`VoiceHost.codec` (Task 1) ← Tasks 2, 2b, 5; `webCodecsOpus()` (Task 2) and `wasmOpus()` (Task 2b) ← Task 5's `codec` param and Task 6b's procedure; `VoiceHost.workletModuleUrl`/`FilmstripHost.createWorker` (spec, Task 1) ← Tasks 2, 3, 5; `voiceWorkletModuleUrl`/`createInlineFilmstripWorker` (Task 3) ← Task 5; `FilmstripFrame` (Task 3) ← Task 4; `window.__testbed.stats()`/`results`/`restartVoice()` (Task 5) ← Playwright spec; `VOICE_SAMPLE_RATE` (Task 2) ← testbed's `AudioContext({ sampleRate: 48000 })`.
- **Judgment calls named for the executor:** generated-import `@ts-ignore` vs checked-in stub (Task 3 step 5); `createImageBitmap(video)` fallback only when observed (Task 3 step 1); wry Android permission handling verified before writing Kotlin (Task 6 step 1); disk checks before Tauri builds.
