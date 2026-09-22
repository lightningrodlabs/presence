# Moss Audio Sources Implementation Plan (Plan 2 of 4: the Moss side)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tool running inside Moss can ask for the user's system audio; Moss opens a picker, captures the chosen sources through `@lightningrodlabs/flexaudio` with Moss's own playback excluded, and hands the Tool a `MessagePort` carrying 20 ms mono 48 kHz `Int16Array` frames until any party ends the grant.

**Architecture:** The main process owns grants (`AudioSourceGrants`, a class over injected bindings so it is table-tested without Electron): capability probe → picker window → one flexaudio stream per chosen source → a 20 ms mixer pump → `MessageChannelMain` port delivered to the requesting window via `webContents.postMessage`. The preload relays the port into page script with `window.postMessage`; the renderer's `applet-host` resolves the Tool's `request-audio-sources` message with the port as a transferable. A renderer mirror of the grant list drives a top-of-window chip and a new Settings → Capabilities → Audio Sources sub-tab.

**Tech Stack:** Electron 32 (`MessageChannelMain`, `webContents.postMessage`, `app.getAppMetrics`), Lit 3 + Shoelace, TypeBox validation, Vitest (`yarn test:unit`), `@lightningrodlabs/flexaudio` 0.3.0-lrl.1 (napi, prebuilt per platform).

**Spec:** `docs/superpowers/specs/2026-09-22-audio-source-capture-design.md` (Presence repo) — Section 1 "Landed", Section 2, "Error handling", "Decisions". This plan lives in the Presence repo; the code lives in `../moss`.

## Global Constraints

- Work happens in `/home/eric/code/metacurrency/holochain/moss` on branch `feat/audio-source-capture` off `main-0.7` (spec Section 2). Confirm with `git branch --show-current` before every task; `main` is the wrong lineage.
- Run every yarn command through the Moss nix shell: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn <script>`. Baseline at plan time (2026-09-22): `yarn test:unit` = 25 files / 227 tests green, `yarn typecheck:node` and `yarn typecheck:web` green.
- Gate for every task: `nix develop -c yarn test:unit` and `nix develop -c yarn typecheck` (node + web + wdocker) green before commit. The web typecheck resolves `@theweave/*` from their built `dist`, so after editing `shared/types` run `nix develop -c yarn build:mt`, and after editing `libs/api` run `nix develop -c yarn build:api`, before typechecking.
- The native package is pinned EXACTLY: `"@lightningrodlabs/flexaudio": "0.3.0-lrl.1"` (a `^0.3.0` range does not match a prerelease — spec Section 1 "Landed").
- Wire format on the grant port is fixed: mono, 48 000 Hz, 20 ms frames, `Int16Array` of 960 samples, one `postMessage` per frame (spec "Data flow"). Streams are opened with `outputRate: 48000, outputChannels: 1, chunkMs: 20`.
- Pids never leave the main process: the picker receives opaque row ids (spec Section 2 step 4).
- The exclude set is the whole Electron process tree, `app.getAppMetrics().map(m => m.pid)`, passed as `excludePids`, plus `excludeSelf: true` (Windows honours one tree — `excludeSelf` is the addon host's tree; spec Section 1 "Landed").
- Moss CLAUDE.md binds all of this: TDD per step (rule 1); strong typing (rule 4); comments explain intent, never prior behaviour (rule 6); keep files small — nothing new goes into `src/main/index.ts` beyond the one construction + registration block (rule 8); no co-author trailers in commits (rule 3); no exclamation marks in reports (rule 0).
- `tsconfig.node.json` includes only `src/main/*` and `src/preload/*` (no subdirectories): every new main-process file is flat in `src/main/`.
- Localised strings use `msg()` and get translations in all eight XLIFF files (`de fr es tr it pt ja nl`) plus a `lit-localize build` — see Task 7 for the table. The picker window page follows its sibling `selectmediasource.ts` and is not localised (declared).
- Declared deviation from spec Section 2 step 2: the persisted "Allow tools to request audio sources" switch is renderer-owned (`PersistedStore`, localStorage, like every other Moss preference); the renderer resolves `null` before invoking main when it is off. Main has no persisted-preference store, so the gate cannot live there. Outcome is identical (`null`).
- Declared interpretation of "the Moss top bar": the main window has no global top bar (group view has its own 66 px bar; personal view has none), so the chip renders as a fixed overlay at the top centre of the main window from `main-dashboard.ts`, visible in both views.

## Review Focus

Five inputs the spec implies but no task's tests exercise — each got its pin added to the owning task:

1. **A chunk shorter or longer than 960 samples** (backend jitter or a stereo misconfiguration): the mixer must still emit exactly 960 samples, padding or truncating, never throwing — Task 2, `mixToInt16` length rows.
2. **The picker resolving after the requesting window was closed**: the grant must not leak streams — Task 3, "deliverPort returns false → grant ended, streams stopped, request resolves null".
3. **A process stream that fails to open** (an app quit between enumeration and open): the other chosen sources must still be captured; only if nothing opens does the request throw — Task 3, "openStream throws for one of two apps".
4. **A self-posted page message** (the preload's port relay) reaching the applet message handler: it must be ignored, never answered on the audio port — Task 6, the `message.source === window` guard is source-pinned by the receiver test's fake and by the applet-host early return.
5. **The tool's `{type:'close'}` arriving after the grant already ended** (e.g. the user pressed Stop first): `endGrant` must be idempotent and the second reason must not overwrite the first notification — Task 3, "endGrant twice".

---

## File structure

| Path (in `../moss`) | Responsibility |
|---|---|
| `package.json` | pin `@lightningrodlabs/flexaudio` |
| `electron-builder.yml` | `NSAudioCaptureUsageDescription` for the macOS TCC prompt |
| `shared/types/src/audio-sources.ts` (new) + `index.ts` | types shared by main, preload, renderer: `AudioCapabilities`, `AudioSourceRow`, `AudioSourceRequestResult`, `AudioSourceGrantInfo`, `AudioSourceEndReason`, `AudioSourcePortControl` |
| `src/main/audioCapture.ts` (new) | lazy `require` of the addon; `AudioCaptureBackend` (the consumed subset); `probeAudioCapabilities` |
| `src/main/audioMixer.ts` (new) | pure: `takeFrameInputs`, `mixToInt16` |
| `src/main/audioSourceGrants.ts` (new) | `AudioSourceGrants` over injected bindings; `buildAudioSourceRows`; `describeSelection` |
| `src/main/audioSourcePicker.ts` (new) | the picker `BrowserWindow` (one at a time), `pickerRows`, `pickerSelected` |
| `src/main/audioSourcesIpc.ts` (new) | the six `ipcMain.handle` registrations (literal channel names — the drift test scans them) |
| `src/main/index.ts` | one block: construct `AudioSourceGrants` with production bindings, call `registerAudioSourceIpc` |
| `src/preload/admin.ts`, `src/preload/walwindow.ts` | `requestAudioSources`/`stopAudioSources`/(admin only) `listAudioSourceGrants`/`getAudioCapabilities`/`onAudioSourceGrantsChanged`; the `audio-source-port` relay into the page |
| `src/preload/selectaudiosources.ts` (new) | picker bridge: `getAudioSourceRows`, `audioSourcesSelected` |
| `src/renderer/selectaudiosources.html`, `src/renderer/src/selectaudiosources.ts` (new) | the picker page (`<select-audio-sources>`) |
| `electron.vite.config.ts` | preload + renderer entries for the picker |
| `libs/api/src/types.ts` | `{ type: 'request-audio-sources' }` in `AppletToParentRequest` |
| `src/renderer/src/validationSchemas.ts` + `validationSchemas.test.ts` (new) | schema for the new message, round-trip test |
| `src/renderer/src/iframe-store.ts` + `.test.ts` | `findIframeIdBySource` |
| `src/renderer/src/audio-sources/port-receiver.ts` (new) + test | `AudioSourcePortReceiver`, `matchAudioSourcePortMessage` |
| `src/renderer/src/audio-sources/grants-client.ts` (new) + test | `AudioSourceGrantsClient`: switch gate, request correlation, per-iframe teardown |
| `src/renderer/src/audio-sources/grants-store.ts` (new) | renderer mirror of main's grant list (`Writable<AudioSourceGrantInfo[]>`) |
| `src/renderer/src/audio-sources/grant-summary.ts` (new) + test | `formatGrantSummary` (chip + settings copy) |
| `src/renderer/src/audio-sources/audio-source-chips.ts` (new) | `<moss-audio-source-chips>` |
| `src/renderer/src/self/settings/capabilities/capabilities-settings.ts` (new) | `<moss-capabilities-settings>` sub-tab bar |
| `src/renderer/src/self/settings/capabilities/audio-sources-settings.ts` (new) | `<moss-audio-sources-settings>` |
| `src/renderer/src/self/settings/moss-settings.ts` | `TabsState.Capabilities` |
| `src/renderer/src/persisted-store.ts` | `audioSourcesEnabled` (default on) |
| `src/renderer/src/electron-api.ts` | interface + wrappers |
| `src/renderer/src/applets/applet-host.ts` | `request-audio-sources` case, `TransferableReply`, reply transfer, unregister teardown, self-post guard |
| `src/renderer/src/walwindow.ts` | local handling in WAL windows (same shape as `user-select-screen`) |
| `src/renderer/src/app/main-dashboard.ts` | mount `<moss-audio-source-chips>`, init the grants store |
| `src/renderer/xliff/*.xlf`, `src/renderer/src/locales/generated/*.ts` | translations |

---

### Task 1: Dependency, macOS usage string, capability probe

**Files:**
- Modify: `package.json` (dependencies), `electron-builder.yml` (`mac.extendInfo`)
- Create: `shared/types/src/audio-sources.ts`; modify `shared/types/src/index.ts`
- Create: `src/main/audioCapture.ts`
- Test: `src/main/audioCapture.test.ts`

**Interfaces:**
- Produces: `AudioCaptureBackend` (the addon subset: `devices()`, `processes()`, `openStream()`), `loadAudioCapture(requireFn?)`, `backendNameFor(platform)`, `probeAudioCapabilities(backend, platform): Promise<AudioCapabilities>`; the shared types module.

- [ ] **Step 1: Create the branch**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git checkout main-0.7 && git pull --ff-only
git checkout -b feat/audio-source-capture
```

- [ ] **Step 2: Add the dependency and the usage string**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn add -W --exact @lightningrodlabs/flexaudio@0.3.0-lrl.1
grep -n '"@lightningrodlabs/flexaudio": "0.3.0-lrl.1"' package.json
ls node_modules/@lightningrodlabs/ | grep flexaudio
```
Expected: the grep prints the pinned line (no caret); the listing shows `flexaudio` and `flexaudio-linux-x64-gnu` (the platform package for this machine). Do not judge loadability with nix's `node` — its loader does not search the system library path where `libpipewire-0.3.so.0` lives; the runtime that matters is Electron, checked live in Task 4 Step 7.

In `electron-builder.yml`, under `mac.extendInfo`, add after the `NSMicrophoneUsageDescription` line:
```yaml
    - NSAudioCaptureUsageDescription: Application requests permission to capture audio playing on this computer when a tool asks to share it.
```

- [ ] **Step 3: Write the shared types**

`shared/types/src/audio-sources.ts`:
```ts
/**
 * Types shared by the main process, the preloads and the renderer for the
 * audio-source capture feature: a Tool asks Moss for audio that is playing on
 * this machine, the user picks the sources, and the Tool receives a
 * MessagePort of PCM frames until the grant ends.
 */

export type AudioBackendName = 'pipewire' | 'coreaudio' | 'wasapi' | 'none';

export interface AudioCapabilities {
  /** The native addon loaded and its device probe answered. */
  supported: boolean;
  /** Per-application sources can be enumerated and captured. */
  perApp: boolean;
  /** The backend can exclude Moss's own playback from the capture. */
  canExcludeSelf: boolean;
  backend: AudioBackendName;
  /** Set when `supported` or `perApp` is false: the probe outcome that made it so. */
  reason?: string;
}

export interface AudioSourceRow {
  /** Opaque id valid for one picker; `'system'` for the all-output row. Never a pid. */
  id: string;
  kind: 'system' | 'app';
  name: string;
  /** true = playing now, false = silent, null = the OS does not say. */
  playing: boolean | null;
}

export interface AudioSourceRequestResult {
  grantId: string;
  /** Human-readable summary of the chosen sources, e.g. "System audio" or "Spotify, Firefox". */
  label: string;
  canExcludeSelf: boolean;
}

export type AudioSourceEndReason =
  | 'user-stopped'
  | 'tool-closed'
  | 'iframe-unloaded'
  | 'window-closed'
  | 'stream-lost'
  | 'permission-denied'
  | 'stream-error'
  | 'app-quit';

export interface AudioSourceGrantCounters {
  /** Chunks the backend reported dropping (`chunkDropped` events). */
  chunksDropped: number;
  /** Chunks the mixer discarded because a stream's queue exceeded its backlog cap. */
  backlogDropped: number;
  stalls: number;
  recoveries: number;
  framesSent: number;
}

export interface AudioSourceGrantInfo {
  grantId: string;
  toolName: string;
  label: string;
  canExcludeSelf: boolean;
  /** Wall-clock ms at grant start. */
  startedAt: number;
  counters: AudioSourceGrantCounters;
}

/** Control messages on the grant port. Main sends `ended` before closing; the Tool sends `close`. */
export type AudioSourcePortControl =
  | { type: 'ended'; reason: AudioSourceEndReason }
  | { type: 'close' };

/** Payload of the `audio-source-port` IPC message (the port rides in `ports[0]`). */
export interface AudioSourcePortDelivery {
  requestId: string;
  grantId: string;
}
```

Append to `shared/types/src/index.ts`:
```ts
export * from './audio-sources.js';
```

- [ ] **Step 4: Write the failing test**

`src/main/audioCapture.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  AudioCaptureBackend,
  backendNameFor,
  loadAudioCapture,
  probeAudioCapabilities,
} from './audioCapture';

const okBackend = (): AudioCaptureBackend => ({
  devices: () => [],
  processes: async () => [],
  openStream: () => {
    throw new Error('not opened in this test');
  },
});

describe('backendNameFor', () => {
  it.each([
    ['linux', 'pipewire'],
    ['darwin', 'coreaudio'],
    ['win32', 'wasapi'],
    ['freebsd', 'none'],
  ] as const)('%s → %s', (platform, expected) => {
    expect(backendNameFor(platform)).toBe(expected);
  });
});

describe('loadAudioCapture', () => {
  it('returns undefined when the addon cannot be required', () => {
    const failing = () => {
      throw new Error('libpipewire-0.3.so.0: cannot open shared object file');
    };
    expect(loadAudioCapture(failing)).toBeUndefined();
  });

  it('returns the module when require succeeds', () => {
    const mod = okBackend();
    expect(loadAudioCapture(() => mod)).toBe(mod);
  });
});

describe('probeAudioCapabilities', () => {
  it('no addon → unsupported with reason', async () => {
    expect(await probeAudioCapabilities(undefined, 'linux')).toEqual({
      supported: false,
      perApp: false,
      canExcludeSelf: false,
      backend: 'pipewire',
      reason: 'addon-unavailable',
    });
  });

  it('devices() throwing → unsupported with the error text', async () => {
    const backend = {
      ...okBackend(),
      devices: () => {
        throw new Error('no pipewire session');
      },
    };
    const caps = await probeAudioCapabilities(backend, 'linux');
    expect(caps.supported).toBe(false);
    expect(caps.reason).toBe('no pipewire session');
  });

  it('processes() rejecting → supported but not perApp', async () => {
    const backend = {
      ...okBackend(),
      processes: async () => {
        throw new Error('unsupported OS version');
      },
    };
    expect(await probeAudioCapabilities(backend, 'win32')).toEqual({
      supported: true,
      perApp: false,
      canExcludeSelf: true,
      backend: 'wasapi',
      reason: 'unsupported OS version',
    });
  });

  it('everything answering → fully capable, no reason', async () => {
    expect(await probeAudioCapabilities(okBackend(), 'darwin')).toEqual({
      supported: true,
      perApp: true,
      canExcludeSelf: true,
      backend: 'coreaudio',
    });
  });

  it('an empty processes() list is still perApp (nothing is playing, not unsupported)', async () => {
    const caps = await probeAudioCapabilities(okBackend(), 'linux');
    expect(caps.perApp).toBe(true);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit src/main/audioCapture.test.ts`
Expected: FAIL — `Cannot find module './audioCapture'`.

- [ ] **Step 6: Write the implementation**

`src/main/audioCapture.ts`:
```ts
/* eslint-disable @typescript-eslint/no-var-requires */
import type {
  FlexStream,
  JsAudioChunk,
  JsDeviceInfo,
  JsProcessInfo,
  JsStreamEvent,
  OpenOptions,
} from '@lightningrodlabs/flexaudio';
import type { AudioBackendName, AudioCapabilities } from '@theweave/moss-types';

/**
 * The subset of `@lightningrodlabs/flexaudio` this app consumes. Narrowing the
 * surface keeps the grant engine testable with a hand-written fake.
 */
export interface AudioCaptureBackend {
  devices(): JsDeviceInfo[];
  processes(): Promise<JsProcessInfo[]>;
  openStream(
    options: OpenOptions,
    onChunk: (chunk: JsAudioChunk) => void,
    onEvent?: (event: JsStreamEvent) => void,
  ): FlexStream;
}

const ADDON_ID = '@lightningrodlabs/flexaudio';

/**
 * Loads the native addon lazily. The `.node` binary links `libpipewire-0.3.so.0`
 * at load time, so on a host without PipeWire the require itself throws; that is
 * the `supported: false` signal, not an error to surface.
 */
export function loadAudioCapture(
  requireFn: (id: string) => unknown = require,
): AudioCaptureBackend | undefined {
  try {
    return requireFn(ADDON_ID) as AudioCaptureBackend;
  } catch (e) {
    console.warn(`[audio-sources] native capture addon unavailable: ${(e as Error).message}`);
    return undefined;
  }
}

export function backendNameFor(platform: NodeJS.Platform): AudioBackendName {
  switch (platform) {
    case 'linux':
      return 'pipewire';
    case 'darwin':
      return 'coreaudio';
    case 'win32':
      return 'wasapi';
    default:
      return 'none';
  }
}

/**
 * Derives what this host can do from the addon's own probes: `devices()` throwing
 * means no usable audio session at all; `processes()` rejecting means per-app
 * capture is unavailable (OS below the floor) while system capture still works.
 * Every backend the addon ships can exclude the host's own playback.
 */
export async function probeAudioCapabilities(
  backend: AudioCaptureBackend | undefined,
  platform: NodeJS.Platform,
): Promise<AudioCapabilities> {
  const name = backendNameFor(platform);
  if (!backend) {
    return {
      supported: false,
      perApp: false,
      canExcludeSelf: false,
      backend: name,
      reason: 'addon-unavailable',
    };
  }
  try {
    backend.devices();
  } catch (e) {
    return {
      supported: false,
      perApp: false,
      canExcludeSelf: false,
      backend: name,
      reason: (e as Error).message,
    };
  }
  try {
    await backend.processes();
  } catch (e) {
    return {
      supported: true,
      perApp: false,
      canExcludeSelf: true,
      backend: name,
      reason: (e as Error).message,
    };
  }
  return { supported: true, perApp: true, canExcludeSelf: true, backend: name };
}
```

- [ ] **Step 7: Build the shared types, run the test and the typechecks**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn build:mt
nix develop -c yarn test:unit src/main/audioCapture.test.ts
nix develop -c yarn typecheck
```
Expected: 8 tests pass; typecheck green.

- [ ] **Step 8: Commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git add package.json yarn.lock electron-builder.yml shared/types/src/audio-sources.ts shared/types/src/index.ts src/main/audioCapture.ts src/main/audioCapture.test.ts
git commit -m "feat(main): pin @lightningrodlabs/flexaudio and probe audio-capture capabilities

Adds the native capture addon (exact prerelease pin), the macOS audio-capture
usage string, the shared audio-source types, and a lazy loader plus a pure
capability probe over the addon's own devices()/processes() answers."
```

---

### Task 2: Frame mixer

**Files:**
- Create: `src/main/audioMixer.ts`
- Test: `src/main/audioMixer.test.ts`

**Interfaces:**
- Produces: `FRAME_SAMPLES = 960`, `FRAME_MS = 20`, `MAX_BACKLOG_CHUNKS = 5`, `takeFrameInputs(queues, maxBacklog?): { inputs: Float32Array[]; dropped: number }` (mutates the queues), `mixToInt16(inputs, frames?): Int16Array`.

- [ ] **Step 1: Write the failing test**

`src/main/audioMixer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { FRAME_SAMPLES, MAX_BACKLOG_CHUNKS, mixToInt16, takeFrameInputs } from './audioMixer';

const filled = (value: number, length = FRAME_SAMPLES) => new Float32Array(length).fill(value);

describe('mixToInt16', () => {
  it('no inputs → a silent frame of FRAME_SAMPLES', () => {
    const out = mixToInt16([]);
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(FRAME_SAMPLES);
    expect(out.every((s) => s === 0)).toBe(true);
  });

  it('quantises one input: 0.5 → 16384 (round half up), -0.5 → -16384', () => {
    const input = filled(0.5);
    input[1] = -0.5;
    const out = mixToInt16([input]);
    expect(out[0]).toBe(16384);
    expect(out[1]).toBe(-16384);
  });

  it('sums two inputs', () => {
    const out = mixToInt16([filled(0.25), filled(0.25)]);
    expect(out[0]).toBe(16384);
  });

  it('clamps the sum to full scale in both directions', () => {
    const pos = mixToInt16([filled(0.8), filled(0.8)]);
    const neg = mixToInt16([filled(-0.8), filled(-0.8)]);
    expect(pos[0]).toBe(32767);
    expect(neg[0]).toBe(-32768);
  });

  it('a short input is zero-padded, a long input is truncated (Review Focus 1)', () => {
    const short = mixToInt16([filled(0.5, 10)]);
    expect(short.length).toBe(FRAME_SAMPLES);
    expect(short[9]).toBe(16384);
    expect(short[10]).toBe(0);
    const long = mixToInt16([filled(0.5, FRAME_SAMPLES + 100)]);
    expect(long.length).toBe(FRAME_SAMPLES);
  });

  it('NaN samples contribute silence rather than poisoning the frame', () => {
    const input = filled(0.5);
    input[0] = NaN;
    expect(mixToInt16([input])[0]).toBe(0);
  });
});

describe('takeFrameInputs', () => {
  it('pops one chunk from each non-empty queue, leaving empty queues out', () => {
    const a = [filled(1), filled(2)];
    const b: Float32Array[] = [];
    const c = [filled(3)];
    const { inputs, dropped } = takeFrameInputs([a, b, c]);
    expect(inputs.map((x) => x[0])).toEqual([1, 3]);
    expect(dropped).toBe(0);
    expect(a.length).toBe(1);
    expect(c.length).toBe(0);
  });

  it('drops the oldest chunks beyond the backlog cap and counts them', () => {
    const q = Array.from({ length: MAX_BACKLOG_CHUNKS + 3 }, (_, i) => filled(i));
    const { inputs, dropped } = takeFrameInputs([q]);
    expect(dropped).toBe(3);
    expect(inputs[0][0]).toBe(3);
    expect(q.length).toBe(MAX_BACKLOG_CHUNKS - 1);
  });

  it('all queues empty → no inputs, no drops', () => {
    expect(takeFrameInputs([[], []])).toEqual({ inputs: [], dropped: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit src/main/audioMixer.test.ts`
Expected: FAIL — `Cannot find module './audioMixer'`.

- [ ] **Step 3: Write the implementation**

`src/main/audioMixer.ts`:
```ts
/**
 * Pure mixing for the audio-source grant port. Every 20 ms the grant takes at
 * most one chunk from each open stream, sums them, and quantises the result to
 * the fixed wire format (mono, 48 kHz, 960 samples, Int16). Queues are bounded
 * so a stalled consumer costs latency, not memory.
 */

export const FRAME_MS = 20;
/** 48 000 Hz × 20 ms, mono. */
export const FRAME_SAMPLES = 960;
/** At most 100 ms of audio may wait per stream before the oldest is discarded. */
export const MAX_BACKLOG_CHUNKS = 5;

/**
 * Removes one chunk from the head of every non-empty queue and returns them.
 * Queues longer than `maxBacklog` first lose their oldest entries (counted in
 * `dropped`) so a stream that outpaces the pump cannot accumulate unbounded delay.
 */
export function takeFrameInputs(
  queues: Float32Array[][],
  maxBacklog: number = MAX_BACKLOG_CHUNKS,
): { inputs: Float32Array[]; dropped: number } {
  const inputs: Float32Array[] = [];
  let dropped = 0;
  for (const queue of queues) {
    while (queue.length > maxBacklog) {
      queue.shift();
      dropped += 1;
    }
    const head = queue.shift();
    if (head) inputs.push(head);
  }
  return { inputs, dropped };
}

/** Sums float inputs sample-wise, clamps to [-1, 1] and quantises to Int16. */
export function mixToInt16(
  inputs: readonly Float32Array[],
  frames: number = FRAME_SAMPLES,
): Int16Array {
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (const input of inputs) {
      const s = i < input.length ? input[i] : 0;
      if (Number.isFinite(s)) sum += s;
    }
    if (sum > 1) sum = 1;
    else if (sum < -1) sum = -1;
    out[i] = sum < 0 ? Math.round(sum * 32768) : Math.round(sum * 32767);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit src/main/audioMixer.test.ts`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git add src/main/audioMixer.ts src/main/audioMixer.test.ts
git commit -m "feat(main): pure frame mixer for audio-source grants

takeFrameInputs bounds each stream's backlog and pops one chunk per stream;
mixToInt16 sums, clamps and quantises to the fixed 960-sample Int16 frame."
```

---

### Task 3: Grant engine

**Files:**
- Create: `src/main/audioSourceGrants.ts`
- Test: `src/main/audioSourceGrants.test.ts`

**Interfaces:**
- Consumes: `AudioCaptureBackend`, `probeAudioCapabilities` (Task 1); `takeFrameInputs`, `mixToInt16`, `FRAME_MS` (Task 2); shared types.
- Produces: `AudioSourceGrants` with `request(req): Promise<AudioSourceRequestResult | null>`, `endGrant(grantId, reason): Promise<void>`, `endGrantsForTarget(targetId, reason): Promise<void>`, `list(): AudioSourceGrantInfo[]`; `AudioSourceGrantsBindings`, `GrantPort`; pure `buildAudioSourceRows(processes, excludePids)` and `describeSelection(system, appNames)`.

- [ ] **Step 1: Write the failing test**

`src/main/audioSourceGrants.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import type { JsAudioChunk, JsProcessInfo, JsStreamEvent, OpenOptions } from '@lightningrodlabs/flexaudio';
import type { AudioSourceRow } from '@theweave/moss-types';
import type { AudioCaptureBackend } from './audioCapture';
import {
  AudioSourceGrants,
  AudioSourceGrantsBindings,
  GrantPort,
  buildAudioSourceRows,
  describeSelection,
} from './audioSourceGrants';
import { FRAME_SAMPLES } from './audioMixer';

// ---------- fakes ----------

type OpenedStream = {
  options: OpenOptions;
  onChunk: (c: JsAudioChunk) => void;
  onEvent?: (e: JsStreamEvent) => void;
  stop: ReturnType<typeof vi.fn>;
};

class FakeBackend implements AudioCaptureBackend {
  opened: OpenedStream[] = [];
  processList: JsProcessInfo[] = [];
  devicesThrows = false;
  processesRejects = false;
  /** When set, openStream throws for options matching the predicate. */
  failOpen: (o: OpenOptions) => boolean = () => false;

  devices() {
    if (this.devicesThrows) throw new Error('no session');
    return [];
  }
  async processes() {
    if (this.processesRejects) throw new Error('unsupported');
    return this.processList;
  }
  openStream(options: OpenOptions, onChunk: (c: JsAudioChunk) => void, onEvent?: (e: JsStreamEvent) => void) {
    if (this.failOpen(options)) throw new Error(`cannot open ${options.kind}`);
    const stop = vi.fn(async () => {});
    const s: OpenedStream = { options, onChunk, onEvent, stop };
    this.opened.push(s);
    return { stop } as unknown as ReturnType<AudioCaptureBackend['openStream']>;
  }
  chunk(i: number, value: number, frames = FRAME_SAMPLES) {
    this.opened[i].onChunk({
      data: new Float32Array(frames).fill(value),
      frames,
      ptsNs: 0,
      seq: 0n,
      flags: 0,
      droppedBefore: 0,
      peak: value,
      rms: value,
    });
  }
  event(i: number, ev: JsStreamEvent) {
    this.opened[i].onEvent?.(ev);
  }
}

class FakePort implements GrantPort {
  sent: unknown[] = [];
  closed = false;
  started = false;
  private listeners: Array<(e: { data: unknown }) => void> = [];
  postMessage(data: unknown) {
    if (this.closed) throw new Error('port closed');
    this.sent.push(data);
  }
  on(_event: 'message', l: (e: { data: unknown }) => void) {
    this.listeners.push(l);
  }
  start() {
    this.started = true;
  }
  close() {
    this.closed = true;
  }
  /** The Tool's end of the channel speaking. */
  receive(data: unknown) {
    this.listeners.forEach((l) => l({ data }));
  }
}

class FakeScheduler {
  private fns = new Map<number, () => void>();
  private next = 1;
  setInterval(fn: () => void, _ms: number) {
    const h = this.next++;
    this.fns.set(h, fn);
    return h;
  }
  clearInterval(h: unknown) {
    this.fns.delete(h as number);
  }
  tick() {
    for (const fn of this.fns.values()) fn();
  }
  get active() {
    return this.fns.size;
  }
}

function rig(overrides: Partial<AudioSourceGrantsBindings> = {}) {
  const backend = new FakeBackend();
  const scheduler = new FakeScheduler();
  const ports: FakePort[] = [];
  const delivered: Array<{ targetId: number; requestId: string; grantId: string }> = [];
  const changes: number[] = [];
  let ids = 0;
  const picker = vi.fn(async (_rows: AudioSourceRow[]): Promise<string[] | null> => ['system']);
  const bindings: AudioSourceGrantsBindings = {
    backend: () => backend,
    platform: 'linux',
    picker,
    excludePids: () => [100, 101],
    openChannel: () => {
      const port1 = new FakePort();
      ports.push(port1);
      return { port1, port2: { tag: 'port2' } };
    },
    deliverPort: (targetId, payload, _port2) => {
      delivered.push({ targetId, ...payload });
      return true;
    },
    scheduler,
    now: () => 1_000,
    newId: () => `g${++ids}`,
    onGrantsChanged: (list) => changes.push(list.length),
    ...overrides,
  };
  const grants = new AudioSourceGrants(bindings);
  return { grants, backend, scheduler, ports, delivered, changes, picker };
}

const REQ = { requestId: 'r1', toolName: 'Presence', targetId: 7 };
/** Lets every pending microtask and the stop()/endGrant chains settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------- pure helpers ----------

describe('buildAudioSourceRows', () => {
  const procs: JsProcessInfo[] = [
    { pid: 5, name: 'Zoom', isOutputActive: false },
    { pid: 3, name: 'Firefox', isOutputActive: true },
    { pid: 100, name: 'moss', isOutputActive: true },
    { pid: 9, name: 'Alpha' },
    { pid: 4, name: 'Spotify', isOutputActive: true },
  ];

  it('system row first, then playing → silent → unknown, each by name; Moss tree filtered', () => {
    const { rows, pidById } = buildAudioSourceRows(procs, [100, 101]);
    expect(rows.map((r) => r.name)).toEqual([
      'All system output (except Moss)',
      'Firefox',
      'Spotify',
      'Zoom',
      'Alpha',
    ]);
    expect(rows[0]).toEqual({ id: 'system', kind: 'system', name: 'All system output (except Moss)', playing: null });
    expect(rows[1].playing).toBe(true);
    expect(rows[3].playing).toBe(false);
    expect(rows[4].playing).toBeNull();
    expect(pidById.get(rows[1].id)).toBe(3);
    expect([...pidById.values()]).not.toContain(100);
  });

  it('row ids are opaque, never the pid', () => {
    const { rows } = buildAudioSourceRows(procs, []);
    for (const r of rows.filter((r) => r.kind === 'app')) expect(r.id).not.toMatch(/^\d+$/);
  });
});

describe('describeSelection', () => {
  it.each([
    [true, [], 'System audio'],
    [false, ['Spotify'], 'Spotify'],
    [false, ['Spotify', 'Firefox'], 'Spotify, Firefox'],
    [true, ['Spotify'], 'System audio, Spotify'],
  ])('system=%s apps=%j → %s', (system, apps, expected) => {
    expect(describeSelection(system, apps)).toBe(expected);
  });
});

// ---------- request table ----------

describe('AudioSourceGrants.request', () => {
  it('no addon → null, picker never opened', async () => {
    const r = rig({ backend: () => undefined });
    expect(await r.grants.request(REQ)).toBeNull();
    expect(r.picker).not.toHaveBeenCalled();
  });

  it('devices() throws → null', async () => {
    const r = rig();
    r.backend.devicesThrows = true;
    expect(await r.grants.request(REQ)).toBeNull();
    expect(r.picker).not.toHaveBeenCalled();
  });

  it('picker cancelled → null, nothing opened', async () => {
    const r = rig();
    r.picker.mockResolvedValueOnce(null);
    expect(await r.grants.request(REQ)).toBeNull();
    expect(r.backend.opened).toEqual([]);
    expect(r.grants.list()).toEqual([]);
  });

  it('picker confirms nothing → null', async () => {
    const r = rig();
    r.picker.mockResolvedValueOnce([]);
    expect(await r.grants.request(REQ)).toBeNull();
  });

  it('processes() rejects → picker gets only the system row', async () => {
    const r = rig();
    r.backend.processesRejects = true;
    await r.grants.request(REQ);
    const rows = r.picker.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('system');
  });

  it('system row chosen → one system stream with excludeSelf + the process tree, fixed format', async () => {
    const r = rig();
    const result = await r.grants.request(REQ);
    expect(result).toEqual({ grantId: 'g1', label: 'System audio', canExcludeSelf: true });
    expect(r.backend.opened).toHaveLength(1);
    expect(r.backend.opened[0].options).toEqual({
      kind: 'system',
      excludeSelf: true,
      excludePids: [100, 101],
      outputRate: 48000,
      outputChannels: 1,
      chunkMs: 20,
    });
    expect(r.delivered).toEqual([{ targetId: 7, requestId: 'r1', grantId: 'g1' }]);
    expect(r.ports[0].started).toBe(true);
    expect(r.grants.list()).toMatchObject([{ grantId: 'g1', toolName: 'Presence', label: 'System audio', startedAt: 1_000 }]);
    expect(r.changes).toEqual([1]);
  });

  it('two apps chosen → one process stream each, label from names', async () => {
    const r = rig();
    r.backend.processList = [
      { pid: 3, name: 'Firefox', isOutputActive: true },
      { pid: 4, name: 'Spotify', isOutputActive: true },
    ];
    r.picker.mockImplementationOnce(async (rows) => rows.filter((x) => x.kind === 'app').map((x) => x.id));
    const result = await r.grants.request(REQ);
    expect(result?.label).toBe('Firefox, Spotify');
    expect(r.backend.opened.map((s) => s.options)).toEqual([
      { kind: 'process', processId: 3, outputRate: 48000, outputChannels: 1, chunkMs: 20 },
      { kind: 'process', processId: 4, outputRate: 48000, outputChannels: 1, chunkMs: 20 },
    ]);
  });

  it('one of two apps fails to open → the other is captured (Review Focus 3)', async () => {
    const r = rig();
    r.backend.processList = [
      { pid: 3, name: 'Firefox', isOutputActive: true },
      { pid: 4, name: 'Spotify', isOutputActive: true },
    ];
    r.backend.failOpen = (o) => o.processId === 3;
    r.picker.mockImplementationOnce(async (rows) => rows.filter((x) => x.kind === 'app').map((x) => x.id));
    const result = await r.grants.request(REQ);
    expect(result?.label).toBe('Spotify');
    expect(r.backend.opened).toHaveLength(1);
  });

  it('nothing opens → rejects and leaves no grant', async () => {
    const r = rig();
    r.backend.failOpen = () => true;
    await expect(r.grants.request(REQ)).rejects.toThrow(/Failed to open audio capture/);
    expect(r.grants.list()).toEqual([]);
    expect(r.ports[0]?.closed ?? true).toBe(true);
  });

  it('a second request while the picker is open rejects', async () => {
    const r = rig();
    let release!: (v: string[] | null) => void;
    r.picker.mockImplementationOnce(() => new Promise((res) => (release = res)));
    const first = r.grants.request(REQ);
    await flush();
    await expect(r.grants.request({ ...REQ, requestId: 'r2' })).rejects.toThrow(/one audio source picker/);
    release(null);
    expect(await first).toBeNull();
  });

  it('requesting window gone at delivery → grant ended, streams stopped, null (Review Focus 2)', async () => {
    const r = rig({ deliverPort: () => false });
    expect(await r.grants.request(REQ)).toBeNull();
    expect(r.backend.opened[0].stop).toHaveBeenCalledTimes(1);
    expect(r.ports[0].closed).toBe(true);
    expect(r.grants.list()).toEqual([]);
  });
});

// ---------- the pump ----------

describe('frame pump', () => {
  it('each tick posts one 960-sample Int16 frame mixing one chunk per stream', async () => {
    const r = rig();
    r.backend.processList = [{ pid: 3, name: 'Firefox', isOutputActive: true }];
    r.picker.mockImplementationOnce(async (rows) => rows.map((x) => x.id));
    await r.grants.request(REQ);
    r.backend.chunk(0, 0.25);
    r.backend.chunk(1, 0.25);
    r.scheduler.tick();
    const frame = r.ports[0].sent[0] as Int16Array;
    expect(frame).toBeInstanceOf(Int16Array);
    expect(frame.length).toBe(FRAME_SAMPLES);
    expect(frame[0]).toBe(16384);
    expect(r.grants.list()[0].counters.framesSent).toBe(1);
  });

  it('no chunks queued → a silent frame still goes out', async () => {
    const r = rig();
    await r.grants.request(REQ);
    r.scheduler.tick();
    const frame = r.ports[0].sent[0] as Int16Array;
    expect(frame.every((s) => s === 0)).toBe(true);
  });

  it('the stop terminator (frames: 0) is not queued', async () => {
    const r = rig();
    await r.grants.request(REQ);
    r.backend.chunk(0, 0.5, 0);
    r.scheduler.tick();
    expect((r.ports[0].sent[0] as Int16Array)[0]).toBe(0);
  });

  it('backlog drops are counted', async () => {
    const r = rig();
    await r.grants.request(REQ);
    for (let i = 0; i < 8; i++) r.backend.chunk(0, 0.1);
    r.scheduler.tick();
    expect(r.grants.list()[0].counters.backlogDropped).toBe(3);
  });
});

// ---------- ending ----------

describe('ending a grant', () => {
  it('endGrant stops streams, posts ended, closes the port, clears the timer, notifies', async () => {
    const r = rig();
    await r.grants.request(REQ);
    await r.grants.endGrant('g1', 'user-stopped');
    expect(r.backend.opened[0].stop).toHaveBeenCalledTimes(1);
    expect(r.ports[0].sent.at(-1)).toEqual({ type: 'ended', reason: 'user-stopped' });
    expect(r.ports[0].closed).toBe(true);
    expect(r.scheduler.active).toBe(0);
    expect(r.grants.list()).toEqual([]);
    expect(r.changes).toEqual([1, 0]);
  });

  it('endGrant twice: second call is a no-op and keeps the first reason (Review Focus 5)', async () => {
    const r = rig();
    await r.grants.request(REQ);
    await r.grants.endGrant('g1', 'user-stopped');
    await r.grants.endGrant('g1', 'tool-closed');
    expect(r.ports[0].sent.filter((m) => (m as { type?: string }).type === 'ended')).toEqual([
      { type: 'ended', reason: 'user-stopped' },
    ]);
    expect(r.backend.opened[0].stop).toHaveBeenCalledTimes(1);
    expect(r.changes).toEqual([1, 0]);
  });

  it('endGrant for an unknown id resolves without notifying', async () => {
    const r = rig();
    await r.grants.endGrant('nope', 'user-stopped');
    expect(r.changes).toEqual([]);
  });

  it("the Tool's {type:'close'} on the port ends the grant as tool-closed", async () => {
    const r = rig();
    await r.grants.request(REQ);
    r.ports[0].receive({ type: 'close' });
    await flush();
    expect(r.grants.list()).toEqual([]);
    expect(r.ports[0].sent.at(-1)).toEqual({ type: 'ended', reason: 'tool-closed' });
  });

  it('an unrelated port message is ignored', async () => {
    const r = rig();
    await r.grants.request(REQ);
    r.ports[0].receive({ type: 'hello' });
    r.ports[0].receive('garbage');
    await flush();
    expect(r.grants.list()).toHaveLength(1);
  });

  it('endGrantsForTarget ends only that window\'s grants', async () => {
    const r = rig();
    await r.grants.request(REQ);
    await r.grants.request({ requestId: 'r2', toolName: 'Other', targetId: 8 });
    await r.grants.endGrantsForTarget(7, 'window-closed');
    expect(r.grants.list().map((g) => g.grantId)).toEqual(['g2']);
  });
});

// ---------- stream events ----------

describe('stream events', () => {
  async function twoStreams() {
    const r = rig();
    r.backend.processList = [{ pid: 3, name: 'Firefox', isOutputActive: true }];
    r.picker.mockImplementationOnce(async (rows) => rows.map((x) => x.id));
    await r.grants.request(REQ);
    return r;
  }

  it('chunkDropped / stalled / recovered only count', async () => {
    const r = await twoStreams();
    r.backend.event(0, { type: 'chunkDropped', count: 4 });
    r.backend.event(0, { type: 'stalled' });
    r.backend.event(0, { type: 'recovered' });
    expect(r.grants.list()[0].counters).toMatchObject({ chunksDropped: 4, stalls: 1, recoveries: 1 });
    expect(r.grants.list()).toHaveLength(1);
  });

  it('deviceLost on one of two streams ends that stream only', async () => {
    const r = await twoStreams();
    r.backend.event(1, { type: 'deviceLost' });
    await flush();
    expect(r.backend.opened[1].stop).toHaveBeenCalledTimes(1);
    expect(r.backend.opened[0].stop).not.toHaveBeenCalled();
    expect(r.grants.list()).toHaveLength(1);
  });

  it('the last stream failing ends the grant with the mapped reason', async () => {
    const r = await twoStreams();
    r.backend.event(1, { type: 'deviceLost' });
    r.backend.event(0, { type: 'error', message: 'boom' });
    await flush();
    expect(r.grants.list()).toEqual([]);
    expect(r.ports[0].sent.at(-1)).toEqual({ type: 'ended', reason: 'stream-error' });
  });

  it.each([
    ['deviceLost', 'process', 'app-quit'],
    ['deviceLost', 'system', 'stream-lost'],
    ['permissionDenied', 'system', 'permission-denied'],
    ['error', 'system', 'stream-error'],
  ] as const)('%s on a %s stream → %s', async (type, kind, reason) => {
    const r = rig();
    if (kind === 'process') {
      r.backend.processList = [{ pid: 3, name: 'Firefox' }];
      r.picker.mockImplementationOnce(async (rows) => rows.filter((x) => x.kind === 'app').map((x) => x.id));
    }
    await r.grants.request(REQ);
    r.backend.event(0, { type });
    await flush();
    expect(r.ports[0].sent.at(-1)).toEqual({ type: 'ended', reason });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit src/main/audioSourceGrants.test.ts`
Expected: FAIL — `Cannot find module './audioSourceGrants'`.

- [ ] **Step 3: Write the implementation**

`src/main/audioSourceGrants.ts`:
```ts
import type { JsAudioChunk, JsProcessInfo, JsStreamEvent, OpenOptions } from '@lightningrodlabs/flexaudio';
import type {
  AudioSourceEndReason,
  AudioSourceGrantCounters,
  AudioSourceGrantInfo,
  AudioSourcePortDelivery,
  AudioSourceRequestResult,
  AudioSourceRow,
} from '@theweave/moss-types';
import { AudioCaptureBackend, probeAudioCapabilities } from './audioCapture';
import { FRAME_MS, mixToInt16, takeFrameInputs } from './audioMixer';

export const SYSTEM_ROW_ID = 'system';
export const SYSTEM_ROW_NAME = 'All system output (except Moss)';

/** The main-process end of a grant's MessageChannel (structurally `MessagePortMain`). */
export interface GrantPort {
  postMessage(data: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
  close(): void;
}

export interface AudioSourceGrantsBindings {
  backend: () => AudioCaptureBackend | undefined;
  platform: NodeJS.Platform;
  /** Shows the picker; resolves the chosen row ids, or null on cancel/close. */
  picker: (rows: AudioSourceRow[]) => Promise<string[] | null>;
  /** Every pid in this app's process tree — the Chromium audio service, not `process.pid`, emits sound. */
  excludePids: () => number[];
  openChannel: () => { port1: GrantPort; port2: unknown };
  /** Hands `port2` to the requesting window; false when that window is gone. */
  deliverPort: (targetId: number, payload: AudioSourcePortDelivery, port2: unknown) => boolean;
  scheduler: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  now: () => number;
  newId: () => string;
  onGrantsChanged: (grants: AudioSourceGrantInfo[]) => void;
}

export interface AudioSourceRequest {
  /** Renderer-chosen correlation id, echoed in the port delivery. */
  requestId: string;
  toolName: string;
  /** `webContents.id` of the requesting window. */
  targetId: number;
}

interface OpenStream {
  id: string;
  kind: 'system' | 'app';
  handle: { stop(): Promise<void> };
  queue: Float32Array[];
}

interface Grant {
  info: AudioSourceGrantInfo;
  targetId: number;
  port1: GrantPort;
  streams: Map<string, OpenStream>;
  timer: unknown;
}

const STREAM_FORMAT = { outputRate: 48000, outputChannels: 1, chunkMs: FRAME_MS } as const;

/**
 * Picker rows from the addon's process list: the all-output row first, then
 * apps with currently-playing ones ahead, silent next, unknown last, each group
 * by name. Processes in this app's own tree are not offered (they are excluded
 * from capture anyway). Row ids are positional and opaque; `pidById` is the
 * only place a pid is associated with a row and it never leaves main.
 */
export function buildAudioSourceRows(
  processes: JsProcessInfo[],
  excludePids: number[],
): { rows: AudioSourceRow[]; pidById: Map<string, number> } {
  const rank = (p: JsProcessInfo) => (p.isOutputActive === true ? 0 : p.isOutputActive === false ? 1 : 2);
  const excluded = new Set(excludePids);
  const apps = processes
    .filter((p) => !excluded.has(p.pid))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const pidById = new Map<string, number>();
  const rows: AudioSourceRow[] = [
    { id: SYSTEM_ROW_ID, kind: 'system', name: SYSTEM_ROW_NAME, playing: null },
  ];
  apps.forEach((p, i) => {
    const id = `app-${i}`;
    pidById.set(id, p.pid);
    rows.push({ id, kind: 'app', name: p.name, playing: p.isOutputActive ?? null });
  });
  return { rows, pidById };
}

export function describeSelection(system: boolean, appNames: string[]): string {
  const parts = system ? ['System audio', ...appNames] : appNames;
  return parts.join(', ');
}

function reasonForEvent(type: string, kind: 'system' | 'app'): AudioSourceEndReason | null {
  switch (type) {
    case 'deviceLost':
      return kind === 'app' ? 'app-quit' : 'stream-lost';
    case 'permissionDenied':
      return 'permission-denied';
    case 'error':
      return 'stream-error';
    default:
      return null;
  }
}

/**
 * Owns every active audio-source grant: the capture streams, the 20 ms mixer
 * pump and the main end of the port. Every way a grant can end funnels through
 * `endGrant`, which is idempotent.
 */
export class AudioSourceGrants {
  private grants = new Map<string, Grant>();
  private pickerOpen = false;

  constructor(private readonly b: AudioSourceGrantsBindings) {}

  list(): AudioSourceGrantInfo[] {
    return [...this.grants.values()].map((g) => ({
      ...g.info,
      counters: { ...g.info.counters },
    }));
  }

  async request(req: AudioSourceRequest): Promise<AudioSourceRequestResult | null> {
    const backend = this.b.backend();
    const caps = await probeAudioCapabilities(backend, this.b.platform);
    if (!backend || !caps.supported) return null;

    const excludePids = this.b.excludePids();
    const processes = caps.perApp ? await backend.processes().catch(() => [] as JsProcessInfo[]) : [];
    const { rows, pidById } = buildAudioSourceRows(processes, excludePids);

    if (this.pickerOpen) throw new Error('Only one audio source picker may be open at a time.');
    this.pickerOpen = true;
    let chosen: string[] | null;
    try {
      chosen = await this.b.picker(rows);
    } finally {
      this.pickerOpen = false;
    }
    if (!chosen || chosen.length === 0) return null;

    const chosenSet = new Set(chosen);
    const wantSystem = chosenSet.has(SYSTEM_ROW_ID);
    const wantApps = rows.filter((r) => r.kind === 'app' && chosenSet.has(r.id));
    if (!wantSystem && wantApps.length === 0) return null;

    const grantId = this.b.newId();
    const { port1, port2 } = this.b.openChannel();
    const grant: Grant = {
      info: {
        grantId,
        toolName: req.toolName,
        label: '',
        canExcludeSelf: caps.canExcludeSelf,
        startedAt: this.b.now(),
        counters: { chunksDropped: 0, backlogDropped: 0, stalls: 0, recoveries: 0, framesSent: 0 },
      },
      targetId: req.targetId,
      port1,
      streams: new Map(),
      timer: undefined,
    };
    this.grants.set(grantId, grant);

    const openedNames: string[] = [];
    let openedSystem = false;
    if (wantSystem) {
      openedSystem = this.openStream(grant, backend, 'system', {
        kind: 'system',
        excludeSelf: true,
        excludePids,
        ...STREAM_FORMAT,
      });
    }
    for (const row of wantApps) {
      const pid = pidById.get(row.id);
      if (pid === undefined) continue;
      if (this.openStream(grant, backend, 'app', { kind: 'process', processId: pid, ...STREAM_FORMAT })) {
        openedNames.push(row.name);
      }
    }
    if (grant.streams.size === 0) {
      this.grants.delete(grantId);
      port1.close();
      throw new Error('Failed to open audio capture for the chosen sources.');
    }
    grant.info.label = describeSelection(openedSystem, openedNames);

    port1.on('message', (e) => {
      const data = e.data as { type?: unknown } | null | undefined;
      if (data && typeof data === 'object' && data.type === 'close') void this.endGrant(grantId, 'tool-closed');
    });
    port1.start();
    grant.timer = this.b.scheduler.setInterval(() => this.pump(grant), FRAME_MS);

    if (!this.b.deliverPort(req.targetId, { requestId: req.requestId, grantId }, port2)) {
      await this.endGrant(grantId, 'window-closed');
      return null;
    }
    this.notify();
    return { grantId, label: grant.info.label, canExcludeSelf: caps.canExcludeSelf };
  }

  async endGrant(grantId: string, reason: AudioSourceEndReason): Promise<void> {
    const grant = this.grants.get(grantId);
    if (!grant) return;
    this.grants.delete(grantId);
    this.b.scheduler.clearInterval(grant.timer);
    const stops = [...grant.streams.values()].map((s) => s.handle.stop().catch(() => undefined));
    grant.streams.clear();
    try {
      grant.port1.postMessage({ type: 'ended', reason });
    } catch {
      // The port may already be closed by the other side; the grant still ends.
    }
    grant.port1.close();
    this.notify();
    await Promise.all(stops);
  }

  async endGrantsForTarget(targetId: number, reason: AudioSourceEndReason): Promise<void> {
    const ids = [...this.grants.values()].filter((g) => g.targetId === targetId).map((g) => g.info.grantId);
    await Promise.all(ids.map((id) => this.endGrant(id, reason)));
  }

  private openStream(
    grant: Grant,
    backend: AudioCaptureBackend,
    kind: 'system' | 'app',
    options: OpenOptions,
  ): boolean {
    const id = `${kind}-${grant.streams.size}`;
    const stream: OpenStream = { id, kind, handle: { stop: async () => {} }, queue: [] };
    const onChunk = (chunk: JsAudioChunk) => {
      if (chunk.frames === 0) return;
      stream.queue.push(chunk.data);
    };
    const onEvent = (ev: JsStreamEvent) => this.onStreamEvent(grant, stream, ev);
    try {
      stream.handle = backend.openStream(options, onChunk, onEvent);
    } catch (e) {
      console.warn(`[audio-sources] could not open ${kind} stream: ${(e as Error).message}`);
      return false;
    }
    grant.streams.set(id, stream);
    return true;
  }

  private onStreamEvent(grant: Grant, stream: OpenStream, ev: JsStreamEvent): void {
    const c: AudioSourceGrantCounters = grant.info.counters;
    switch (ev.type) {
      case 'chunkDropped':
        c.chunksDropped += ev.count ?? 1;
        return;
      case 'stalled':
        c.stalls += 1;
        return;
      case 'recovered':
        c.recoveries += 1;
        return;
      default: {
        const reason = reasonForEvent(ev.type, stream.kind);
        if (reason) void this.closeStream(grant, stream, reason);
      }
    }
  }

  private async closeStream(grant: Grant, stream: OpenStream, reason: AudioSourceEndReason): Promise<void> {
    if (!grant.streams.delete(stream.id)) return;
    await stream.handle.stop().catch(() => undefined);
    if (grant.streams.size === 0) await this.endGrant(grant.info.grantId, reason);
  }

  private pump(grant: Grant): void {
    const { inputs, dropped } = takeFrameInputs([...grant.streams.values()].map((s) => s.queue));
    grant.info.counters.backlogDropped += dropped;
    try {
      grant.port1.postMessage(mixToInt16(inputs));
      grant.info.counters.framesSent += 1;
    } catch {
      void this.endGrant(grant.info.grantId, 'tool-closed');
    }
  }

  private notify(): void {
    this.b.onGrantsChanged(this.list());
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit src/main/audioSourceGrants.test.ts`
Expected: all tests pass. The tests settle async chains with a macrotask `flush()`; do not replace it with microtask counting.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn typecheck:node
git add src/main/audioSourceGrants.ts src/main/audioSourceGrants.test.ts
git commit -m "feat(main): audio-source grant engine over injected bindings

Capability probe, picker rows (Moss tree filtered, playing apps first), one
flexaudio stream per chosen source with the process tree excluded, a 20 ms
mixer pump onto the grant port, and one idempotent endGrant for every
teardown path: user stop, tool close, window gone, backend loss."
```

---

### Task 4: Picker window, IPC registration, main wiring

**Files:**
- Create: `src/main/audioSourcePicker.ts`, `src/main/audioSourcesIpc.ts`
- Create: `src/preload/selectaudiosources.ts`, `src/renderer/selectaudiosources.html`, `src/renderer/src/selectaudiosources.ts`
- Modify: `src/preload/admin.ts`, `src/preload/walwindow.ts`, `electron.vite.config.ts`, `src/main/index.ts`
- Test: `src/main/ipc-contract-drift.test.ts` (existing — it is the gate for this task)

**Interfaces:**
- Consumes: `AudioSourceGrants`, `probeAudioCapabilities`, `loadAudioCapture`.
- Produces IPC channels (invoke): `request-audio-sources` `(req: { requestId; toolName }) → AudioSourceRequestResult | null`; `stop-audio-sources` `(grantId, reason: 'user-stopped' | 'iframe-unloaded') → void`; `list-audio-source-grants` `() → AudioSourceGrantInfo[]`; `get-audio-capabilities` `() → AudioCapabilities`; `get-audio-source-rows` `() → AudioSourceRow[]`; `audio-sources-selected` `(ids: string[] | null) → void`. Pushed channels: `audio-source-port` (`AudioSourcePortDelivery` + `ports[0]`, to the requesting window), `audio-source-grants-changed` (`AudioSourceGrantInfo[]`, to the main window). Page-level message posted by the preload relay: `{ type: 'audio-source-port', requestId, grantId }` with the port transferred.

- [ ] **Step 1: Watch the drift test go red by adding the preload bridges first**

In `src/preload/admin.ts`, inside the `electronAPI` object after the `selectScreenOrWindow` line, add:
```ts
  requestAudioSources: (req: { requestId: string; toolName: string }) =>
    ipcRenderer.invoke('request-audio-sources', req),
  stopAudioSources: (grantId: string, reason: 'user-stopped' | 'iframe-unloaded') =>
    ipcRenderer.invoke('stop-audio-sources', grantId, reason),
  listAudioSourceGrants: () => ipcRenderer.invoke('list-audio-source-grants'),
  getAudioCapabilities: () => ipcRenderer.invoke('get-audio-capabilities'),
  onAudioSourceGrantsChanged: (
    callback: (e: Electron.IpcRendererEvent, grants: AudioSourceGrantInfo[]) => any,
  ) => ipcRenderer.on('audio-source-grants-changed', callback),
```
and add `AudioSourceGrantInfo` to the existing `@theweave/moss-types` import. At the END of the file (top level, outside `exposeInMainWorld` — `MessagePort` objects cannot cross the context bridge, so the relay hands the port to page script the documented way, `window.postMessage`), add:
```ts
// A grant's MessagePort arrives from main on this channel; it cannot be
// proxied through the context bridge, so it is re-posted into the page where
// the applet host forwards it to the requesting Tool.
ipcRenderer.on('audio-source-port', (event, payload: AudioSourcePortDelivery) => {
  window.postMessage({ type: 'audio-source-port', ...payload }, '*', event.ports);
});
```
(import `AudioSourcePortDelivery` from `@theweave/moss-types`).

In `src/preload/walwindow.ts`, inside the object after `selectScreenOrWindow`:
```ts
  requestAudioSources: (req: { requestId: string; toolName: string }) =>
    ipcRenderer.invoke('request-audio-sources', req),
  stopAudioSources: (grantId: string, reason: 'user-stopped' | 'iframe-unloaded') =>
    ipcRenderer.invoke('stop-audio-sources', grantId, reason),
```
and the same `ipcRenderer.on('audio-source-port', …)` relay at the end of the file, importing `AudioSourcePortDelivery` from `@theweave/moss-types`.

Create `src/preload/selectaudiosources.ts`:
```ts
// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getAudioSourceRows: () => ipcRenderer.invoke('get-audio-source-rows'),
  audioSourcesSelected: (ids: string[] | null) => ipcRenderer.invoke('audio-sources-selected', ids),
});
```

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit src/main/ipc-contract-drift.test.ts`
Expected: FAIL — "preload channels with no ipcMain.handle: audio-sources-selected, get-audio-capabilities, get-audio-source-rows, list-audio-source-grants, request-audio-sources, stop-audio-sources".

- [ ] **Step 2: Write the picker window module**

`src/main/audioSourcePicker.ts`:
```ts
import { BrowserWindow } from 'electron';
import { is } from '@electron-toolkit/utils';
import path from 'path';
import type { AudioSourceRow } from '@theweave/moss-types';

type PickerState = {
  window: BrowserWindow;
  rows: AudioSourceRow[];
  resolve: (ids: string[] | null) => void;
};

let PICKER: PickerState | null = null;

/** Rows for the open picker page (empty when none is open). */
export function pickerRows(): AudioSourceRow[] {
  return PICKER?.rows ?? [];
}

/** The picker page confirmed (`ids`) or cancelled (`null`). */
export function pickerSelected(ids: string[] | null): void {
  if (!PICKER) return;
  const picker = PICKER;
  PICKER = null;
  picker.resolve(ids);
  picker.window.close();
}

/**
 * Opens the audio-source picker and resolves the chosen row ids, or null when
 * the user cancels or closes the window. One picker at a time, like the
 * screen/window picker.
 */
export function openAudioSourcePicker(rows: AudioSourceRow[]): Promise<string[] | null> {
  if (PICKER) return Promise.reject(new Error('Only one audio source picker may be open at a time.'));
  const window = new BrowserWindow({
    height: 620,
    width: 520,
    minimizable: false,
    autoHideMenuBar: true,
    title: 'Share audio from',
    webPreferences: {
      preload: path.resolve(__dirname, '../preload/selectaudiosources.js'),
      safeDialogs: true,
    },
  });
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/selectaudiosources.html`);
  } else {
    window.loadFile(path.join(__dirname, '../renderer/selectaudiosources.html'));
  }
  return new Promise((resolve) => {
    PICKER = { window, rows, resolve };
    window.on('closed', () => {
      if (PICKER && PICKER.window === window) {
        PICKER = null;
        resolve(null);
      }
    });
  });
}
```

- [ ] **Step 3: Write the IPC registration module**

`src/main/audioSourcesIpc.ts`:
```ts
import { ipcMain } from 'electron';
import type { AudioCapabilities } from '@theweave/moss-types';
import { AudioSourceGrants } from './audioSourceGrants';
import { pickerRows, pickerSelected } from './audioSourcePicker';

/**
 * The renderer↔main surface of the audio-source feature. Channel names are
 * string literals here and in the preloads so `ipc-contract-drift.test.ts` can
 * pair them. A window that ever requested a grant has its grants ended when its
 * webContents is destroyed (WAL window closed, main window reloaded).
 */
export function registerAudioSourceIpc(
  grants: AudioSourceGrants,
  capabilities: () => Promise<AudioCapabilities>,
): void {
  const watched = new Set<number>();

  ipcMain.handle(
    'request-audio-sources',
    async (event, req: { requestId: string; toolName: string }) => {
      const sender = event.sender;
      const targetId = sender.id;
      if (!watched.has(targetId)) {
        watched.add(targetId);
        sender.once('destroyed', () => {
          watched.delete(targetId);
          void grants.endGrantsForTarget(targetId, 'window-closed');
        });
      }
      return grants.request({ requestId: req.requestId, toolName: req.toolName, targetId });
    },
  );
  ipcMain.handle(
    'stop-audio-sources',
    (_e, grantId: string, reason: 'user-stopped' | 'iframe-unloaded') =>
      grants.endGrant(grantId, reason),
  );
  ipcMain.handle('list-audio-source-grants', () => grants.list());
  ipcMain.handle('get-audio-capabilities', () => capabilities());
  ipcMain.handle('get-audio-source-rows', () => pickerRows());
  ipcMain.handle('audio-sources-selected', (_e, ids: string[] | null) => pickerSelected(ids));
}
```

- [ ] **Step 4: Wire main**

In `src/main/index.ts`:
- add to the `electron` import list: `MessageChannelMain, MessagePortMain, webContents`;
- add imports:
```ts
import { loadAudioCapture, probeAudioCapabilities } from './audioCapture';
import { AudioSourceGrants } from './audioSourceGrants';
import { openAudioSourcePicker } from './audioSourcePicker';
import { registerAudioSourceIpc } from './audioSourcesIpc';
```
(`emitToWindow` and `nanoid` are already imported — verify with grep; add if not.)
- inside `app.whenReady().then(...)`, directly before the existing `ipcMain.handle('select-screen-or-window', …)` registration, add the one block:
```ts
    const audioBackend = loadAudioCapture();
    const audioSourceGrants = new AudioSourceGrants({
      backend: () => audioBackend,
      platform: process.platform,
      picker: openAudioSourcePicker,
      excludePids: () => app.getAppMetrics().map((m) => m.pid),
      openChannel: () => new MessageChannelMain(),
      deliverPort: (targetId, payload, port2) => {
        const target = webContents.fromId(targetId);
        if (!target || target.isDestroyed()) return false;
        target.postMessage('audio-source-port', payload, [port2 as MessagePortMain]);
        return true;
      },
      scheduler: {
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
      },
      now: () => Date.now(),
      newId: () => nanoid(8),
      onGrantsChanged: (list) => {
        if (MAIN_WINDOW && !MAIN_WINDOW.isDestroyed())
          emitToWindow(MAIN_WINDOW, 'audio-source-grants-changed', list);
      },
    });
    registerAudioSourceIpc(audioSourceGrants, () =>
      probeAudioCapabilities(audioBackend, process.platform),
    );
```

- [ ] **Step 5: Add the picker page and its build entries**

`electron.vite.config.ts`: add `selectaudiosources: resolve(__dirname, 'src/preload/selectaudiosources.ts'),` to `preload.build.rollupOptions.input` and `selectaudiosources: resolve(__dirname, 'src/renderer/selectaudiosources.html'),` to `renderer.build.rollupOptions.input`.

`src/renderer/selectaudiosources.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Share audio from</title>
    <style>
      body {
        font-family: Arial, Helvetica, sans-serif;
        margin: 0;
        padding: 0;
        background: rgb(200, 208, 224);
      }
    </style>
  </head>
  <body>
    <script type="module" src="/src/selectaudiosources.ts"></script>
    <select-audio-sources></select-audio-sources>
  </body>
</html>
```

`src/renderer/src/selectaudiosources.ts`:
```ts
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { AudioSourceRow } from '@theweave/moss-types';
import { mossStyles } from './shared-styles';
import '@shoelace-style/shoelace/dist/components/checkbox/checkbox.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';

type PickerApi = {
  getAudioSourceRows: () => Promise<AudioSourceRow[]>;
  audioSourcesSelected: (ids: string[] | null) => Promise<void>;
};

const api = () => (window as unknown as { electronAPI: PickerApi }).electronAPI;

/**
 * The audio-source picker: the user ticks "All system output" and/or
 * individual applications. Rows arrive already ordered (playing apps first).
 */
@customElement('select-audio-sources')
export class SelectAudioSources extends LitElement {
  @state() _rows: AudioSourceRow[] = [];
  @state() _chosen = new Set<string>();

  async firstUpdated() {
    this._rows = await api().getAudioSourceRows();
  }

  private toggle(id: string, checked: boolean) {
    const next = new Set(this._chosen);
    if (checked) next.add(id);
    else next.delete(id);
    this._chosen = next;
  }

  private renderRow(row: AudioSourceRow) {
    const status =
      row.kind === 'system' ? '' : row.playing === true ? 'playing' : row.playing === false ? 'silent' : '';
    return html`
      <label class="row source-row">
        <sl-checkbox
          .checked=${this._chosen.has(row.id)}
          @sl-change=${(e: Event) => this.toggle(row.id, (e.target as HTMLInputElement).checked)}
        ></sl-checkbox>
        <span class="name">${row.name}</span>
        <span class="status ${status}">${status}</span>
      </label>
    `;
  }

  render() {
    const apps = this._rows.filter((r) => r.kind === 'app');
    return html`
      <div class="column" style="padding: 20px; gap: 12px;">
        <h2 style="margin: 0;">Share audio from</h2>
        ${this._rows.filter((r) => r.kind === 'system').map((r) => this.renderRow(r))}
        <div class="divider"></div>
        ${apps.length === 0
          ? html`<div class="empty">No applications with audio output were found.</div>`
          : apps.map((r) => this.renderRow(r))}
        <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 12px;">
          <sl-button @click=${() => api().audioSourcesSelected(null)}>Cancel</sl-button>
          <sl-button
            variant="primary"
            ?disabled=${this._chosen.size === 0}
            @click=${() => api().audioSourcesSelected([...this._chosen])}
            >Share</sl-button
          >
        </div>
      </div>
    `;
  }

  static get styles() {
    return [
      mossStyles,
      css`
        .source-row {
          align-items: center;
          gap: 10px;
          padding: 6px 8px;
          border-radius: 6px;
          cursor: pointer;
        }
        .source-row:hover {
          background: rgba(255, 255, 255, 0.4);
        }
        .name {
          flex: 1;
        }
        .status {
          font-size: 12px;
          opacity: 0.7;
        }
        .status.playing {
          color: #1a7f37;
          opacity: 1;
        }
        .divider {
          height: 1px;
          background: rgba(0, 0, 0, 0.2);
        }
        .empty {
          opacity: 0.7;
          font-size: 14px;
        }
      `,
    ];
  }
}
```

- [ ] **Step 6: Run the drift test, the whole unit suite, and the typechecks**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn test:unit
nix develop -c yarn typecheck
```
Expected: drift test green (six new channels paired in both directions), all suites green, typecheck green. If `typecheck:web` cannot see `AudioSourceRow` from `@theweave/moss-types`, rerun `nix develop -c yarn build:mt`.

- [ ] **Step 7: Smoke the picker in the running app**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn applet-dev-example-1
```
In the Moss window's devtools console (main renderer): the bridge exists — `await window.electronAPI.getAudioCapabilities()` prints `{ supported: true, perApp: true, canExcludeSelf: true, backend: 'pipewire' }` on the owner's machine. Then `await window.electronAPI.requestAudioSources({ requestId: 'x', toolName: 'console' })` opens the picker; tick a row and press Share → the promise resolves `{ grantId, label, canExcludeSelf }`; `await window.electronAPI.listAudioSourceGrants()` lists it; `await window.electronAPI.stopAudioSources(grantId, 'user-stopped')` empties the list. Cancel → `null`. Record the observed values in the commit message body.

- [ ] **Step 8: Commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git add src/main/audioSourcePicker.ts src/main/audioSourcesIpc.ts src/main/index.ts src/preload/admin.ts src/preload/walwindow.ts src/preload/selectaudiosources.ts src/renderer/selectaudiosources.html src/renderer/src/selectaudiosources.ts electron.vite.config.ts
git commit -m "feat(main): audio-source picker window and IPC surface

Six invoke channels paired by the drift test, the picker page (system row
then apps, playing first), the grant port relayed into page script by the
preloads, and the one construction block in index.ts."
```

---

### Task 5: Renderer modules — port receiver, grants client, persisted switch, iframe lookup, grant summary

**Files:**
- Create: `src/renderer/src/audio-sources/port-receiver.ts` + `port-receiver.test.ts`
- Create: `src/renderer/src/audio-sources/grants-client.ts` + `grants-client.test.ts`
- Create: `src/renderer/src/audio-sources/grant-summary.ts` + `grant-summary.test.ts`
- Modify: `src/renderer/src/iframe-store.ts` + `iframe-store.test.ts`
- Modify: `src/renderer/src/persisted-store.ts`

**Interfaces:**
- Produces: `matchAudioSourcePortMessage(data): AudioSourcePortDelivery | null`; `AudioSourcePortReceiver` with `install(target: { addEventListener })`, `expect(requestId, timeoutMs?): Promise<MessagePort>`, `handleMessage(event)`; `AudioSourceGrantsClient` with `request({ iframeKey, toolName }): Promise<{ result: AudioSourceRequestResult; port: MessagePort } | null>`, `endForIframe(iframeKey): Promise<void>`, `AudioSourceGrantsClientBindings`; `IframeStore.findIframeIdBySource(source): string | undefined`; `PersistedStore.audioSourcesEnabled`; `formatGrantSummary(grant, nowMs): { title: string; elapsed: string }`.

- [ ] **Step 1: Write the failing tests**

`src/renderer/src/audio-sources/port-receiver.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { AudioSourcePortReceiver, matchAudioSourcePortMessage } from './port-receiver';

const fakeWindow = {} as unknown as Window;

function portEvent(data: unknown, opts: { source?: unknown; ports?: MessagePort[] } = {}) {
  return { data, source: opts.source ?? fakeWindow, ports: opts.ports ?? [] } as unknown as MessageEvent;
}

describe('matchAudioSourcePortMessage', () => {
  it.each([
    [{ type: 'audio-source-port', requestId: 'r1', grantId: 'g1' }, { requestId: 'r1', grantId: 'g1' }],
    [{ type: 'audio-source-port', requestId: 'r1' }, null],
    [{ type: 'other', requestId: 'r1', grantId: 'g1' }, null],
    [null, null],
    ['string', null],
    [{ request: { type: 'ready' }, source: {} }, null],
  ])('%j → %j', (data, expected) => {
    expect(matchAudioSourcePortMessage(data)).toEqual(expected);
  });
});

describe('AudioSourcePortReceiver', () => {
  it('resolves an expected request with the transferred port', async () => {
    const r = new AudioSourcePortReceiver(fakeWindow);
    const { port1 } = new MessageChannel();
    const pending = r.expect('r1', 1000);
    r.handleMessage(portEvent({ type: 'audio-source-port', requestId: 'r1', grantId: 'g1' }, { ports: [port1] }));
    expect(await pending).toBe(port1);
  });

  it('ignores a message whose source is not this window (an iframe could forge the shape)', async () => {
    const r = new AudioSourcePortReceiver(fakeWindow);
    const { port1 } = new MessageChannel();
    const pending = r.expect('r1', 20);
    r.handleMessage(
      portEvent({ type: 'audio-source-port', requestId: 'r1', grantId: 'g1' }, { source: {}, ports: [port1] }),
    );
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it('a delivery nobody expects is dropped and its port closed', () => {
    const r = new AudioSourcePortReceiver(fakeWindow);
    const { port1 } = new MessageChannel();
    let closed = false;
    port1.close = () => {
      closed = true;
    };
    r.handleMessage(portEvent({ type: 'audio-source-port', requestId: 'zz', grantId: 'g1' }, { ports: [port1] }));
    expect(closed).toBe(true);
  });

  it('a delivery with no port rejects the expectation', async () => {
    const r = new AudioSourcePortReceiver(fakeWindow);
    const pending = r.expect('r1', 1000);
    r.handleMessage(portEvent({ type: 'audio-source-port', requestId: 'r1', grantId: 'g1' }));
    await expect(pending).rejects.toThrow(/without a port/);
  });

  it('times out when nothing arrives', async () => {
    const r = new AudioSourcePortReceiver(fakeWindow);
    await expect(r.expect('r1', 10)).rejects.toThrow(/timed out/);
  });

  it('install subscribes to message events on the target', () => {
    const r = new AudioSourcePortReceiver(fakeWindow);
    const listeners: string[] = [];
    r.install({ addEventListener: (type: string) => listeners.push(type) });
    expect(listeners).toEqual(['message']);
  });
});
```

`src/renderer/src/audio-sources/grants-client.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { AudioSourceGrantsClient, AudioSourceGrantsClientBindings } from './grants-client';

function rig(overrides: Partial<AudioSourceGrantsClientBindings> = {}) {
  const port = { close: vi.fn() } as unknown as MessagePort;
  const requestAudioSources = vi.fn(async () => ({ grantId: 'g1', label: 'System audio', canExcludeSelf: true }));
  const stopAudioSources = vi.fn(async () => {});
  const expectPort = vi.fn(async (_requestId: string) => port);
  const b: AudioSourceGrantsClientBindings = {
    isEnabled: () => true,
    newRequestId: () => 'r1',
    requestAudioSources,
    stopAudioSources,
    expectPort,
    ...overrides,
  };
  return { client: new AudioSourceGrantsClient(b), port, requestAudioSources, stopAudioSources, expectPort };
}

describe('AudioSourceGrantsClient.request', () => {
  it('switch off → null without touching main', async () => {
    const r = rig({ isEnabled: () => false });
    expect(await r.client.request({ iframeKey: 'i1', toolName: 'Presence' })).toBeNull();
    expect(r.requestAudioSources).not.toHaveBeenCalled();
    expect(r.expectPort).not.toHaveBeenCalled();
  });

  it('arms the port expectation BEFORE invoking main, then returns result + port', async () => {
    const order: string[] = [];
    const r = rig({
      expectPort: vi.fn(async () => {
        order.push('expect');
        return { close: vi.fn() } as unknown as MessagePort;
      }),
      requestAudioSources: vi.fn(async () => {
        order.push('invoke');
        return { grantId: 'g1', label: 'System audio', canExcludeSelf: true };
      }),
    });
    const out = await r.client.request({ iframeKey: 'i1', toolName: 'Presence' });
    expect(order).toEqual(['expect', 'invoke']);
    expect(out?.result.grantId).toBe('g1');
    expect(r.requestAudioSources).toHaveBeenCalledWith({ requestId: 'r1', toolName: 'Presence' });
  });

  it('main returns null (cancelled/unsupported) → null, expectation discarded', async () => {
    const r = rig({ requestAudioSources: vi.fn(async () => null) });
    expect(await r.client.request({ iframeKey: 'i1', toolName: 'Presence' })).toBeNull();
    expect(r.client.grantIdsFor('i1')).toEqual([]);
  });

  it('port never arrives → stops the grant in main and rethrows', async () => {
    const r = rig({ expectPort: vi.fn(async () => { throw new Error('timed out'); }) });
    await expect(r.client.request({ iframeKey: 'i1', toolName: 'Presence' })).rejects.toThrow(/timed out/);
    expect(r.stopAudioSources).toHaveBeenCalledWith('g1', 'iframe-unloaded');
  });

  it('records the grant under its iframe key', async () => {
    const r = rig();
    await r.client.request({ iframeKey: 'i1', toolName: 'Presence' });
    expect(r.client.grantIdsFor('i1')).toEqual(['g1']);
  });
});

describe('AudioSourceGrantsClient.endForIframe', () => {
  it("stops every grant of that iframe with reason iframe-unloaded and forgets them", async () => {
    let n = 0;
    const r = rig({
      newRequestId: () => `r${++n}`,
      requestAudioSources: vi.fn(async ({ requestId }) => ({ grantId: `g-${requestId}`, label: 'x', canExcludeSelf: true })),
    });
    await r.client.request({ iframeKey: 'i1', toolName: 'A' });
    await r.client.request({ iframeKey: 'i1', toolName: 'A' });
    await r.client.request({ iframeKey: 'i2', toolName: 'B' });
    await r.client.endForIframe('i1');
    expect(r.stopAudioSources.mock.calls).toEqual([
      ['g-r1', 'iframe-unloaded'],
      ['g-r2', 'iframe-unloaded'],
    ]);
    expect(r.client.grantIdsFor('i1')).toEqual([]);
    expect(r.client.grantIdsFor('i2')).toEqual(['g-r3']);
  });

  it('is a no-op for an unknown iframe', async () => {
    const r = rig();
    await r.client.endForIframe('nope');
    expect(r.stopAudioSources).not.toHaveBeenCalled();
  });
});
```

`src/renderer/src/audio-sources/grant-summary.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatGrantSummary } from './grant-summary';
import type { AudioSourceGrantInfo } from '@theweave/moss-types';

const grant = (startedAt: number): AudioSourceGrantInfo => ({
  grantId: 'g1',
  toolName: 'Presence',
  label: 'System audio',
  canExcludeSelf: true,
  startedAt,
  counters: { chunksDropped: 0, backlogDropped: 0, stalls: 0, recoveries: 0, framesSent: 0 },
});

describe('formatGrantSummary', () => {
  it.each([
    [0, '0:00'],
    [59_000, '0:59'],
    [61_000, '1:01'],
    [3_600_000, '60:00'],
  ])('elapsed %d ms → %s', (elapsed, expected) => {
    expect(formatGrantSummary(grant(10_000), 10_000 + elapsed).elapsed).toBe(expected);
  });

  it('never shows a negative elapsed time when clocks disagree', () => {
    expect(formatGrantSummary(grant(20_000), 10_000).elapsed).toBe('0:00');
  });

  it('title is "<tool>: <label>"', () => {
    expect(formatGrantSummary(grant(0), 0).title).toBe('Presence: System audio');
  });
});
```

Append to `src/renderer/src/iframe-store.test.ts`:
```ts
describe('IframeStore.findIframeIdBySource', () => {
  it('finds an applet iframe by its window identity', () => {
    const store = new IframeStore();
    const src = fakeSource('a');
    store.registerAppletIframe('applet1', { id: 'i1', subType: 'main', source: src });
    store.registerCrossGroupIframe('tool1', { id: 'c1', subType: 'main', source: fakeSource('c') });
    expect(store.findIframeIdBySource(src)).toBe('i1');
  });

  it('finds a cross-group iframe too', () => {
    const store = new IframeStore();
    const src = fakeSource('c');
    store.registerCrossGroupIframe('tool1', { id: 'c1', subType: 'main', source: src });
    expect(store.findIframeIdBySource(src)).toBe('c1');
  });

  it('returns undefined for an unknown or null source', () => {
    const store = new IframeStore();
    store.registerAppletIframe('applet1', { id: 'i1', subType: 'main', source: fakeSource('a') });
    expect(store.findIframeIdBySource(fakeSource('zzz'))).toBeUndefined();
    expect(store.findIframeIdBySource(null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit src/renderer/src/audio-sources src/renderer/src/iframe-store.test.ts`
Expected: three "Cannot find module" failures and one `findIframeIdBySource is not a function`.

- [ ] **Step 3: Write the implementations**

`src/renderer/src/audio-sources/port-receiver.ts`:
```ts
import type { AudioSourcePortDelivery } from '@theweave/moss-types';

/** The page-level message the preload posts when main delivers a grant port. */
export function matchAudioSourcePortMessage(data: unknown): AudioSourcePortDelivery | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { type?: unknown; requestId?: unknown; grantId?: unknown };
  if (d.type !== 'audio-source-port') return null;
  if (typeof d.requestId !== 'string' || typeof d.grantId !== 'string') return null;
  return { requestId: d.requestId, grantId: d.grantId };
}

type Pending = { resolve: (port: MessagePort) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export const PORT_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Correlates grant ports posted into the page by the preload relay with the
 * request that asked for them. Only messages whose `source` is this window are
 * honoured: the relay runs in this window, while an iframe could post the same
 * shape and must not be able to substitute a port.
 */
export class AudioSourcePortReceiver {
  private pending = new Map<string, Pending>();

  constructor(private readonly self: Window) {}

  install(target: { addEventListener(type: 'message', listener: (e: MessageEvent) => void): void }): void {
    target.addEventListener('message', (e) => this.handleMessage(e));
  }

  expect(requestId: string, timeoutMs: number = PORT_DELIVERY_TIMEOUT_MS): Promise<MessagePort> {
    return new Promise<MessagePort>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`audio-source port delivery for ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  handleMessage(event: MessageEvent): void {
    if (event.source !== this.self) return;
    const delivery = matchAudioSourcePortMessage(event.data);
    if (!delivery) return;
    const port = event.ports?.[0];
    const waiter = this.pending.get(delivery.requestId);
    if (!waiter) {
      port?.close();
      return;
    }
    this.pending.delete(delivery.requestId);
    clearTimeout(waiter.timer);
    if (!port) {
      waiter.reject(new Error(`audio-source port delivery for ${delivery.requestId} arrived without a port`));
      return;
    }
    waiter.resolve(port);
  }
}
```

`src/renderer/src/audio-sources/grants-client.ts`:
```ts
import type { AudioSourceRequestResult } from '@theweave/moss-types';

export interface AudioSourceGrantsClientBindings {
  /** The persisted "Allow tools to request audio sources" switch. */
  isEnabled: () => boolean;
  newRequestId: () => string;
  requestAudioSources: (req: { requestId: string; toolName: string }) => Promise<AudioSourceRequestResult | null>;
  stopAudioSources: (grantId: string, reason: 'user-stopped' | 'iframe-unloaded') => Promise<void>;
  /** Resolves the port main delivers for `requestId`; rejects on timeout. */
  expectPort: (requestId: string) => Promise<MessagePort>;
}

export interface AudioSourceGrantHandle {
  result: AudioSourceRequestResult;
  port: MessagePort;
}

/**
 * The renderer side of a Tool's audio-source request: gates on the user's
 * switch, correlates the invoke with the port delivery, and remembers which
 * iframe holds which grant so an unloading iframe releases its capture.
 */
export class AudioSourceGrantsClient {
  private byIframe = new Map<string, string[]>();

  constructor(private readonly b: AudioSourceGrantsClientBindings) {}

  grantIdsFor(iframeKey: string): string[] {
    return [...(this.byIframe.get(iframeKey) ?? [])];
  }

  async request(req: { iframeKey: string; toolName: string }): Promise<AudioSourceGrantHandle | null> {
    if (!this.b.isEnabled()) return null;
    const requestId = this.b.newRequestId();
    // Armed before the invoke: the port message and the invoke reply are
    // separate IPC deliveries with no ordering guarantee between them.
    const portPromise = this.b.expectPort(requestId);
    portPromise.catch(() => undefined);
    const result = await this.b.requestAudioSources({ requestId, toolName: req.toolName });
    if (!result) return null;
    let port: MessagePort;
    try {
      port = await portPromise;
    } catch (e) {
      await this.b.stopAudioSources(result.grantId, 'iframe-unloaded');
      throw e;
    }
    this.byIframe.set(req.iframeKey, [...(this.byIframe.get(req.iframeKey) ?? []), result.grantId]);
    return { result, port };
  }

  async endForIframe(iframeKey: string): Promise<void> {
    const ids = this.byIframe.get(iframeKey);
    if (!ids) return;
    this.byIframe.delete(iframeKey);
    for (const id of ids) await this.b.stopAudioSources(id, 'iframe-unloaded');
  }
}
```

`src/renderer/src/audio-sources/grant-summary.ts`:
```ts
import type { AudioSourceGrantInfo } from '@theweave/moss-types';

/** Copy shared by the chip and the settings list. */
export function formatGrantSummary(
  grant: AudioSourceGrantInfo,
  nowMs: number,
): { title: string; elapsed: string } {
  const totalSeconds = Math.max(0, Math.floor((nowMs - grant.startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    title: `${grant.toolName}: ${grant.label}`,
    elapsed: `${minutes}:${seconds.toString().padStart(2, '0')}`,
  };
}
```

In `src/renderer/src/iframe-store.ts`, add to the `IframeStore` class after `unregisterCrossGroupIframe`:
```ts
  /** The registered id of the iframe whose window is `source`, across applet and cross-group iframes. */
  findIframeIdBySource(source: MessageEventSource | null | 'wal-window'): string | undefined {
    if (!source) return undefined;
    for (const iframes of [...Object.values(this.appletIframes), ...Object.values(this.crossGroupIframes)]) {
      const hit = iframes.find((i) => i.source === source);
      if (hit) return hit.id;
    }
    return undefined;
  }
```

In `src/renderer/src/persisted-store.ts`, after `designFeedbackMode`:
```ts
  /**
   * Whether Tools may ask for audio playing on this machine. A kill switch: each
   * request still opens the picker, which is the actual consent.
   */
  audioSourcesEnabled: SubStore<boolean, boolean, []> = {
    value: () => {
      const enabled = this.store.getItem<boolean>('audioSourcesEnabled');
      return enabled === null || enabled === undefined ? true : enabled;
    },
    set: (value) => {
      this.store.setItem<boolean>('audioSourcesEnabled', value);
    },
  };
```
Check `KeyValueStore.getItem`'s miss value (`grep -n "getItem" src/renderer/src/persisted-store.ts`) and compare against exactly that value so a stored `false` is honoured.

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn test:unit src/renderer/src/audio-sources src/renderer/src/iframe-store.test.ts
nix develop -c yarn typecheck:web
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git add src/renderer/src/audio-sources/port-receiver.ts src/renderer/src/audio-sources/port-receiver.test.ts src/renderer/src/audio-sources/grants-client.ts src/renderer/src/audio-sources/grants-client.test.ts src/renderer/src/audio-sources/grant-summary.ts src/renderer/src/audio-sources/grant-summary.test.ts src/renderer/src/iframe-store.ts src/renderer/src/iframe-store.test.ts src/renderer/src/persisted-store.ts
git commit -m "feat(renderer): audio-source port receiver, grants client and persisted switch

The receiver correlates the preload's port relay with the request that asked
for it (self-window source only); the client gates on the switch, arms the
port expectation before invoking main, and releases grants per iframe."
```

---

### Task 6: Weave message and the request path in both windows

**Files:**
- Modify: `libs/api/src/types.ts` (`AppletToParentRequest`)
- Modify: `src/renderer/src/validationSchemas.ts`; Create: `src/renderer/src/validationSchemas.test.ts`
- Modify: `src/renderer/src/electron-api.ts`, `src/renderer/src/applets/applet-host.ts`, `src/renderer/src/walwindow.ts`, `src/renderer/src/app/main-dashboard.ts`

**Interfaces:**
- Consumes: `AudioSourceGrantsClient`, `AudioSourcePortReceiver`, `IframeStore.findIframeIdBySource`, `PersistedStore.audioSourcesEnabled` (Task 5); the preload bridges (Task 4).
- Produces: the Weave message `{ type: 'request-audio-sources' }` whose success reply is `{ label, canExcludeSelf } | null` with the grant port as `ports[0]` when non-null (spec Section 2 "Reply with a transferable"); `TransferableReply` in `applet-host.ts`; `audioSourceGrantsClient`/`audioSourcePortReceiver` singletons in `src/renderer/src/audio-sources/singletons.ts` — Plan 3's `@theweave/api` helper consumes exactly this reply shape.

- [ ] **Step 1: Add the message variant and watch the exhaustiveness guard go red**

In `libs/api/src/types.ts`, in `AppletToParentRequest` directly after the `user-select-screen` member:
```ts
  | {
      /**
       * Ask the host for audio playing on the user's machine. The host shows its
       * own picker. Reply: `{ label, canExcludeSelf }` with a MessagePort of
       * 20 ms mono 48 kHz Int16 frames transferred alongside, or `null` when the
       * user declined or the host cannot capture.
       */
      type: 'request-audio-sources';
    }
```
```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn build:api
nix develop -c yarn typecheck:web
```
Expected: FAIL in `applet-host.ts` at `assertNever(message)` — `Argument of type '{ type: "request-audio-sources"; }' is not assignable to parameter of type 'never'`. This is the red step for the host change.

- [ ] **Step 2: Write the failing schema test**

`src/renderer/src/validationSchemas.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AppletToParentRequest } from './validationSchemas';

describe('AppletToParentRequest schema: request-audio-sources', () => {
  it('accepts the bare request', () => {
    expect(Value.Check(AppletToParentRequest, { type: 'request-audio-sources' })).toBe(true);
  });

  it('rejects extra properties (the request carries nothing; identity comes from the iframe origin)', () => {
    expect(Value.Check(AppletToParentRequest, { type: 'request-audio-sources', pid: 5 })).toBe(false);
  });

  it('still accepts a neighbouring variant', () => {
    expect(Value.Check(AppletToParentRequest, { type: 'user-select-screen' })).toBe(true);
  });
});
```
Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit src/renderer/src/validationSchemas.test.ts`
Expected: the first test FAILS (`false`), the third passes.

- [ ] **Step 3: Schema**

In `src/renderer/src/validationSchemas.ts`, directly after the `user-select-screen` object in the union:
```ts
  Type.Object(
    {
      type: Type.Literal('request-audio-sources'),
    },
    { additionalProperties: false },
  ),
```
Rerun the schema test — 3 pass.

- [ ] **Step 4: electron-api wrappers**

In `src/renderer/src/electron-api.ts`, add to the `Window.electronAPI` interface (after `selectScreenOrWindow`):
```ts
      requestAudioSources: (req: {
        requestId: string;
        toolName: string;
      }) => Promise<AudioSourceRequestResult | null>;
      stopAudioSources: (grantId: string, reason: 'user-stopped' | 'iframe-unloaded') => Promise<void>;
      listAudioSourceGrants: () => Promise<AudioSourceGrantInfo[]>;
      getAudioCapabilities: () => Promise<AudioCapabilities>;
      onAudioSourceGrantsChanged: (callback: (e: any, grants: AudioSourceGrantInfo[]) => any) => void;
```
and exported wrappers after `selectScreenOrWindow()`:
```ts
export async function requestAudioSources(req: { requestId: string; toolName: string }) {
  return window.electronAPI.requestAudioSources(req);
}
export async function stopAudioSources(grantId: string, reason: 'user-stopped' | 'iframe-unloaded') {
  return window.electronAPI.stopAudioSources(grantId, reason);
}
export async function listAudioSourceGrants() {
  return window.electronAPI.listAudioSourceGrants();
}
export async function getAudioCapabilities() {
  return window.electronAPI.getAudioCapabilities();
}
export function onAudioSourceGrantsChanged(callback: (grants: AudioSourceGrantInfo[]) => void) {
  window.electronAPI.onAudioSourceGrantsChanged((_e, grants) => callback(grants));
}
```
Import `AudioCapabilities, AudioSourceGrantInfo, AudioSourceRequestResult` from `@theweave/moss-types`.

- [ ] **Step 5: Singletons shared by both windows**

Create `src/renderer/src/audio-sources/singletons.ts`:
```ts
import { nanoid } from 'nanoid';
import { PersistedStore } from '../persisted-store.js';
import { AudioSourceGrantsClient } from './grants-client.js';
import { AudioSourcePortReceiver } from './port-receiver.js';

/**
 * One receiver and one client per window (the main window and each WAL
 * window run this module separately). The receiver is installed on `window`
 * at first import so a port delivery can never precede the listener.
 */
export const audioSourcePortReceiver = new AudioSourcePortReceiver(window);
audioSourcePortReceiver.install(window);

export const audioSourceGrantsClient = new AudioSourceGrantsClient({
  isEnabled: () => new PersistedStore().audioSourcesEnabled.value(),
  newRequestId: () => nanoid(8),
  requestAudioSources: (req) => window.electronAPI.requestAudioSources(req),
  stopAudioSources: (grantId, reason) => window.electronAPI.stopAudioSources(grantId, reason),
  expectPort: (requestId) => audioSourcePortReceiver.expect(requestId),
});
```
Verify `nanoid` resolves from `src/renderer` (`grep -rn "from 'nanoid'" src/renderer/src | head -1`); if it is not already imported anywhere there, add `"nanoid": "5.0.4"` to `src/renderer/package.json` dependencies and run `nix develop -c yarn install`.

For the WAL window, `window.electronAPI` is typed `unknown` in `walwindow.ts`'s own declaration; the singletons module imports the main-window typing from `electron-api.ts` via the global `Window` augmentation — check that `walwindow.ts` compiles; if its local `walWindow.electronAPI` typing conflicts, call through `(window as any).electronAPI` inside `singletons.ts` with a one-line comment naming both preloads as the providers.

- [ ] **Step 6: applet-host — the case, the transferable reply, teardown, and the self-post guard**

In `src/renderer/src/applets/applet-host.ts`:

(a) Imports:
```ts
import { audioSourceGrantsClient } from '../audio-sources/singletons.js';
```

(b) Above `appletMessageHandler`, the reply wrapper:
```ts
/**
 * A handler result that must be posted with a transfer list. Only
 * `request-audio-sources` produces one; every other reply stays a plain value.
 */
export class TransferableReply<T = unknown> {
  constructor(
    public readonly result: T,
    public readonly transfer: Transferable[],
  ) {}
}
```

(c) In `appletMessageHandler`'s returned function, first statement inside the `try`:
```ts
      // The preload relays grant ports into this page with window.postMessage;
      // those are this window's own messages, never an applet's.
      if (message.source === window) return;
```
and replace the success line with:
```ts
      if (result instanceof TransferableReply) {
        message.ports[0].postMessage({ type: 'success', result: result.result }, result.transfer);
      } else {
        message.ports[0].postMessage({ type: 'success', result });
      }
```

(d) The case, directly after `case 'user-select-screen': return selectScreenOrWindow();`:
```ts
    case 'request-audio-sources': {
      const iframeKey = mossStore.iframeStore.findIframeIdBySource(eventSource) ?? 'unregistered';
      let toolName: string;
      if (source.type === 'applet') {
        const appletStore = await toPromise(mossStore.appletStores.get(source.appletHash)!);
        toolName = appletStore?.applet.custom_name ?? encodeHashToBase64(source.appletHash);
      } else {
        toolName = source.toolCompatibilityId;
      }
      const grant = await audioSourceGrantsClient.request({ iframeKey, toolName });
      if (!grant) return null;
      return new TransferableReply(
        { label: grant.result.label, canExcludeSelf: grant.result.canExcludeSelf },
        [grant.port],
      );
    }
```

(e) In the existing `case 'unregister-iframe':`, before each of the two `break`s (cross-group and applet arms), add:
```ts
        await audioSourceGrantsClient.endForIframe(message.id);
```

- [ ] **Step 7: walwindow — handle locally, like `user-select-screen`**

In `src/renderer/src/walwindow.ts`:
- import `{ audioSourceGrantsClient } from './audio-sources/singletons.js'`;
- in the request `switch`, after `case 'user-select-screen': return window.electronAPI.selectScreenOrWindow();`:
```ts
            case 'request-audio-sources': {
              const iframeKey = this.iframeStore.findIframeIdBySource(message.source) ?? 'unregistered';
              const toolName = iframeKind.type === 'applet' ? this.appletName ?? encodeHashToBase64(iframeKind.appletHash) : iframeKind.toolCompatibilityId;
              const grant = await audioSourceGrantsClient.request({ iframeKey, toolName });
              if (!grant) return null;
              return { __transfer: [grant.port], result: { label: grant.result.label, canExcludeSelf: grant.result.canExcludeSelf } };
            }
```
  Look at how the WAL window stores the applet name after its `get-applet-info` call (`grep -n "appletInfo\b\|appletName\|custom_name" src/renderer/src/walwindow.ts`): use the field that holds it, or add `@state() appletName: string | undefined` set from `appletInfo.appletName` in that `try` block.
- in the `unregister-iframe` case, before the forward, add `await audioSourceGrantsClient.endForIframe(request.request.id);`
- at the reply site, replace the success post with:
```ts
        const result = await handleRequest(request);
        if (result && typeof result === 'object' && '__transfer' in result) {
          const r = result as { __transfer: Transferable[]; result: unknown };
          message.ports[0].postMessage({ type: 'success', result: r.result }, r.__transfer);
        } else {
          message.ports[0].postMessage({ type: 'success', result });
        }
```
  (The WAL window does not import `applet-host.ts`; a local marker keeps it that way.)
- the WAL window's message listener already survives self-posted messages (`getIframeKind` throws → caught → warn → return). Silence that specific warn: at the top of the listener, before `if (this.isAppletDev === undefined) return;`, add `if (message.source === window) return;` with the same intent comment as in applet-host.

- [ ] **Step 8: Typecheck, full suite, then a live round-trip from the example applet**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn build:api
nix develop -c yarn typecheck
nix develop -c yarn test:unit
```
Expected: green (the exhaustiveness error from Step 1 is gone).

Live: `nix develop -c yarn applet-dev-example-1`, open the example applet, open ITS iframe's devtools console, and run:
```js
const ch = new MessageChannel();
ch.port1.onmessage = (m) => {
  console.log('reply', m.data, 'ports', m.ports.length);
  const port = m.ports[0];
  if (!port) return;
  let n = 0;
  port.onmessage = (f) => { if (f.data instanceof Int16Array) { if (++n % 50 === 0) console.log('frames', n, 'peak', Math.max(...f.data)); } else console.log('control', f.data); };
  window.__audioPort = port;
};
top.postMessage({ request: { type: 'request-audio-sources' }, source: window.__WEAVE_IFRAME_KIND__ }, '*', [ch.port2]);
```
Expected: the picker opens; after Share, `reply {label, canExcludeSelf: true} ports 1`, then `frames 50 …` every second with a non-zero peak while something plays; `__audioPort.postMessage({type:'close'})` logs `control {type:'ended', reason:'tool-closed'}` and frames stop. Cancel in the picker → `reply null ports 0`. Reload the example applet while a grant is live → `listAudioSourceGrants()` in the main renderer console is empty afterwards (the `unregister-iframe` path).

- [ ] **Step 9: Commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git add libs/api/src/types.ts src/renderer/src/validationSchemas.ts src/renderer/src/validationSchemas.test.ts src/renderer/src/electron-api.ts src/renderer/src/audio-sources/singletons.ts src/renderer/src/applets/applet-host.ts src/renderer/src/walwindow.ts
git commit -m "feat(api,renderer): request-audio-sources Weave message with a transferred grant port

Tools ask with { type: 'request-audio-sources' }; the host resolves the tool
name from the iframe origin, opens the picker via main, and replies with
{ label, canExcludeSelf } plus the MessagePort as a transferable, or null.
Both the main window and WAL windows serve it; an unloading iframe releases
its grants."
```

---

### Task 7: Chip, Settings → Capabilities → Audio Sources, translations

**Files:**
- Create: `src/renderer/src/audio-sources/grants-store.ts`, `src/renderer/src/audio-sources/audio-source-chips.ts`
- Create: `src/renderer/src/self/settings/capabilities/capabilities-settings.ts`, `src/renderer/src/self/settings/capabilities/audio-sources-settings.ts`
- Modify: `src/renderer/src/self/settings/moss-settings.ts`, `src/renderer/src/app/main-dashboard.ts`
- Modify: `src/renderer/xliff/*.xlf`, `src/renderer/src/locales/generated/*.ts` (generated)

**Interfaces:**
- Consumes: `formatGrantSummary`, `PersistedStore.audioSourcesEnabled` (Task 5); `listAudioSourceGrants`, `onAudioSourceGrantsChanged`, `stopAudioSources`, `getAudioCapabilities` (Task 6).
- Produces: `audioSourceGrants: Writable<AudioSourceGrantInfo[]>` + `initAudioSourceGrantsStore()`; elements `<moss-audio-source-chips>`, `<moss-capabilities-settings>`, `<moss-audio-sources-settings>`.

- [ ] **Step 1: The grants mirror**

`src/renderer/src/audio-sources/grants-store.ts`:
```ts
import { writable, Writable } from '@holochain-open-dev/stores';
import type { AudioSourceGrantInfo } from '@theweave/moss-types';
import { listAudioSourceGrants, onAudioSourceGrantsChanged } from '../electron-api.js';

/**
 * Renderer mirror of the main process's grant list. Main is the authority;
 * this store only re-renders the chip and the settings list when main says the
 * list changed.
 */
export const audioSourceGrants: Writable<AudioSourceGrantInfo[]> = writable([]);

let initialised = false;
export async function initAudioSourceGrantsStore(): Promise<void> {
  if (initialised) return;
  initialised = true;
  onAudioSourceGrantsChanged((grants) => audioSourceGrants.set(grants));
  audioSourceGrants.set(await listAudioSourceGrants());
}
```

- [ ] **Step 2: The chip**

`src/renderer/src/audio-sources/audio-source-chips.ts`:
```ts
import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { localized, msg, str } from '@lit/localize';
import { StoreSubscriber } from '@holochain-open-dev/stores';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { mdiVolumeHigh } from '@mdi/js';

import { mossStyles } from '../shared-styles.js';
import { stopAudioSources } from '../electron-api.js';
import { audioSourceGrants } from './grants-store.js';
import { formatGrantSummary } from './grant-summary.js';

/**
 * One chip per active audio-source grant, fixed at the top centre of the main
 * window so the user always sees which Tool is hearing their system audio and
 * can stop it in one click.
 */
@localized()
@customElement('moss-audio-source-chips')
export class MossAudioSourceChips extends LitElement {
  _grants = new StoreSubscriber(this, () => audioSourceGrants, () => []);

  @state() _now = Date.now();
  private _ticker: ReturnType<typeof setInterval> | undefined;

  connectedCallback() {
    super.connectedCallback();
    this._ticker = setInterval(() => (this._now = Date.now()), 1000);
  }

  disconnectedCallback() {
    if (this._ticker) clearInterval(this._ticker);
    super.disconnectedCallback();
  }

  render() {
    const grants = this._grants.value;
    if (grants.length === 0) return html``;
    return html`
      <div class="row chips">
        ${grants.map((g) => {
          const summary = formatGrantSummary(g, this._now);
          return html`
            <div class="chip row items-center" title=${summary.title}>
              <sl-icon .src=${wrapPathInSvg(mdiVolumeHigh)}></sl-icon>
              <span class="text">${msg(str`${g.toolName} is using system audio`)} · ${summary.elapsed}</span>
              <sl-button size="small" variant="danger" outline @click=${() => stopAudioSources(g.grantId, 'user-stopped')}
                >${msg('Stop')}</sl-button
              >
            </div>
          `;
        })}
      </div>
    `;
  }

  static styles = [
    mossStyles,
    css`
      :host {
        position: fixed;
        top: 6px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1000;
        pointer-events: none;
      }
      .chips {
        gap: 8px;
      }
      .chip {
        pointer-events: auto;
        gap: 8px;
        padding: 4px 8px 4px 12px;
        border-radius: 999px;
        background: #b23a3a;
        color: white;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        font-size: 14px;
      }
    `,
  ];
}
```

- [ ] **Step 3: Settings elements**

`src/renderer/src/self/settings/capabilities/audio-sources-settings.ts`:
```ts
import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';
import { StoreSubscriber } from '@holochain-open-dev/stores';
import type { AudioCapabilities } from '@theweave/moss-types';
import '@shoelace-style/shoelace/dist/components/switch/switch.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';

import { mossStyles } from '../../../shared-styles.js';
import { PersistedStore } from '../../../persisted-store.js';
import { getAudioCapabilities, stopAudioSources } from '../../../electron-api.js';
import { audioSourceGrants } from '../../../audio-sources/grants-store.js';
import { formatGrantSummary } from '../../../audio-sources/grant-summary.js';

/** The Audio Sources capability: kill switch, what this host can do, and who is capturing right now. */
@localized()
@customElement('moss-audio-sources-settings')
export class MossAudioSourcesSettings extends LitElement {
  private _persistedStore = new PersistedStore();
  _grants = new StoreSubscriber(this, () => audioSourceGrants, () => []);

  @state() _enabled = true;
  @state() _capabilities: AudioCapabilities | undefined;

  async firstUpdated() {
    this._enabled = this._persistedStore.audioSourcesEnabled.value();
    this._capabilities = await getAudioCapabilities();
  }

  private toggle(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    this._persistedStore.audioSourcesEnabled.set(checked);
    this._enabled = checked;
  }

  private yesNo(v: boolean) {
    return v ? msg('yes') : msg('no');
  }

  renderCapabilities() {
    const c = this._capabilities;
    if (!c) return html``;
    if (!c.supported)
      return html`<p class="muted">${msg('Audio capture is not available on this system.')}${c.reason ? html` (${c.reason})` : ''}</p>`;
    return html`
      <table class="caps">
        <tr><td>${msg('Backend')}</td><td>${c.backend}</td></tr>
        <tr><td>${msg('Per-app capture')}</td><td>${this.yesNo(c.perApp)}${c.reason ? html` (${c.reason})` : ''}</td></tr>
        <tr><td>${msg('Excludes Moss playback')}</td><td>${this.yesNo(c.canExcludeSelf)}</td></tr>
      </table>
    `;
  }

  renderGrants() {
    const grants = this._grants.value;
    if (grants.length === 0) return html`<p class="muted">${msg('No tool is using audio sources.')}</p>`;
    const now = Date.now();
    return grants.map((g) => {
      const s = formatGrantSummary(g, now);
      return html`
        <div class="row items-center grant">
          <div class="column" style="flex: 1;">
            <span>${s.title}</span>
            <span class="muted small">${msg('Started')} ${new Date(g.startedAt).toLocaleTimeString()} · ${s.elapsed} · drops ${g.counters.chunksDropped + g.counters.backlogDropped} · stalls ${g.counters.stalls}</span>
          </div>
          <sl-button size="small" variant="danger" outline @click=${() => stopAudioSources(g.grantId, 'user-stopped')}>${msg('Stop')}</sl-button>
        </div>
      `;
    });
  }

  render() {
    return html`
      <div class="column" style="gap: 16px;">
        <sl-switch .checked=${this._enabled} @sl-change=${(e: Event) => this.toggle(e)}>${msg('Allow tools to request audio sources')}</sl-switch>
        ${this.renderCapabilities()}
        <h4 style="margin: 0;">${msg('Active grants')}</h4>
        ${this.renderGrants()}
      </div>
    `;
  }

  static styles = [
    mossStyles,
    css`
      .muted { opacity: 0.7; }
      .small { font-size: 12px; }
      .caps td { padding: 2px 12px 2px 0; }
      .grant { padding: 8px 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.05); gap: 8px; }
    `,
  ];
}
```

`src/renderer/src/self/settings/capabilities/capabilities-settings.ts`:
```ts
import { css, html, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';
import { mossStyles } from '../../../shared-styles.js';
import './audio-sources-settings.js';

enum CapabilityTab {
  AudioSources,
}

/**
 * Host capabilities Tools can be granted, one sub-tab each. Audio Sources is
 * the first; the Local AI tab joins here when that branch lands.
 */
@localized()
@customElement('moss-capabilities-settings')
export class MossCapabilitiesSettings extends LitElement {
  @state() tab: CapabilityTab = CapabilityTab.AudioSources;

  renderContent() {
    switch (this.tab) {
      case CapabilityTab.AudioSources:
        return html`<moss-audio-sources-settings></moss-audio-sources-settings>`;
    }
  }

  render() {
    return html`
      <div class="row items-center sub-tab-bar">
        <button class="tab ${this.tab === CapabilityTab.AudioSources ? 'tab-selected' : ''}" @click=${() => (this.tab = CapabilityTab.AudioSources)}>
          ${msg('Audio Sources')}
        </button>
      </div>
      <div class="column" style="margin-top: 16px;">${this.renderContent()}</div>
    `;
  }

  static styles = [
    mossStyles,
    css`
      .sub-tab-bar { gap: 4px; }
    `,
  ];
}
```

In `src/renderer/src/self/settings/moss-settings.ts`: import `'./capabilities/capabilities-settings.js'`; add `Capabilities,` to `TabsState` between `Notifications` and `Feedback`; add `renderCapabilities() { return html`<moss-capabilities-settings></moss-capabilities-settings>`; }`; add the `case TabsState.Capabilities: return this.renderCapabilities();` arm; add the tab button after the Notifications button:
```ts
        <button
          class="tab ${this.tabsState === TabsState.Capabilities ? 'tab-selected' : ''}"
          @click=${() => {
            this.tabsState = TabsState.Capabilities;
          }}
        >
          ${msg('Capabilities')}
        </button>
```

In `src/renderer/src/app/main-dashboard.ts`: import `'../audio-sources/audio-source-chips.js'` and `{ initAudioSourceGrantsStore } from '../audio-sources/grants-store.js'`; in `firstUpdated()` after the `onAppletToParentMessage` registration add `void initAudioSourceGrantsStore();`; in `render()` add `<moss-audio-source-chips></moss-audio-source-chips>` directly after the `<design-feedback-controller>` line.

- [ ] **Step 4: Typecheck, then extract and translate**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn typecheck:web
nix develop -c yarn i18n:extract
git diff --stat src/renderer/xliff
```
Each of the eight files gains the new `<trans-unit>`s with empty `<target>`. Fill them from this table (the `${toolName}` string's source contains an `<x equiv-text="${toolName}" id="0"/>` placeholder — copy that element verbatim into the target at the position the language needs):

| Source | de | fr | es | tr | it | pt | ja | nl |
|---|---|---|---|---|---|---|---|---|
| Capabilities | Fähigkeiten | Capacités | Capacidades | Yetenekler | Funzionalità | Capacidades | 機能 | Mogelijkheden |
| Audio Sources | Audioquellen | Sources audio | Fuentes de audio | Ses kaynakları | Sorgenti audio | Fontes de áudio | 音声ソース | Audiobronnen |
| Allow tools to request audio sources | Tools dürfen Audioquellen anfordern | Autoriser les outils à demander des sources audio | Permitir que las herramientas soliciten fuentes de audio | Araçların ses kaynağı istemesine izin ver | Consenti agli strumenti di richiedere sorgenti audio | Permitir que ferramentas solicitem fontes de áudio | ツールによる音声ソースの要求を許可する | Tools toestaan audiobronnen aan te vragen |
| Audio capture is not available on this system. | Audioaufnahme ist auf diesem System nicht verfügbar. | La capture audio n'est pas disponible sur ce système. | La captura de audio no está disponible en este sistema. | Bu sistemde ses yakalama kullanılamıyor. | L'acquisizione audio non è disponibile su questo sistema. | A captura de áudio não está disponível neste sistema. | このシステムでは音声キャプチャを利用できません。 | Audio-opname is niet beschikbaar op dit systeem. |
| Backend | Backend | Moteur | Motor | Arka uç | Backend | Backend | バックエンド | Backend |
| Per-app capture | Aufnahme pro App | Capture par application | Captura por aplicación | Uygulama başına yakalama | Acquisizione per app | Captura por aplicação | アプリごとのキャプチャ | Opname per app |
| Excludes Moss playback | Schließt Moss-Wiedergabe aus | Exclut la lecture de Moss | Excluye la reproducción de Moss | Moss oynatmasını hariç tutar | Esclude la riproduzione di Moss | Exclui a reprodução do Moss | Mossの再生を除外 | Sluit Moss-weergave uit |
| yes | ja | oui | sí | evet | sì | sim | はい | ja |
| no | nein | non | no | hayır | no | não | いいえ | nee |
| Active grants | Aktive Freigaben | Autorisations actives | Permisos activos | Etkin izinler | Autorizzazioni attive | Permissões ativas | 有効な許可 | Actieve toestemmingen |
| No tool is using audio sources. | Kein Tool verwendet Audioquellen. | Aucun outil n'utilise de sources audio. | Ninguna herramienta está usando fuentes de audio. | Hiçbir araç ses kaynağı kullanmıyor. | Nessuno strumento sta usando sorgenti audio. | Nenhuma ferramenta está a usar fontes de áudio. | 音声ソースを使用しているツールはありません。 | Geen enkele tool gebruikt audiobronnen. |
| Started | Gestartet | Démarré | Iniciado | Başladı | Avviato | Iniciado | 開始 | Gestart |
| Stop | Stopp | Arrêter | Detener | Durdur | Interrompi | Parar | 停止 | Stoppen |
| `${toolName}` is using system audio | `${toolName}` verwendet Systemaudio | `${toolName}` utilise l'audio du système | `${toolName}` está usando el audio del sistema | `${toolName}` sistem sesini kullanıyor | `${toolName}` sta usando l'audio di sistema | `${toolName}` está a usar o áudio do sistema | `${toolName}` がシステム音声を使用しています | `${toolName}` gebruikt systeemaudio |

If a string in the table already exists in the XLIFF (e.g. `Stop`, `yes`, `no`), lit-localize reuses its id — do not add a duplicate. Then:
```bash
nix develop -c yarn i18n:build
nix develop -c yarn typecheck:web
grep -c "<target></target>" src/renderer/xliff/*.xlf
```
Expected: the last command prints 0 for every file (no untranslated units remain).

- [ ] **Step 5: Live check**

`nix develop -c yarn applet-dev-example-1`: Settings → Capabilities → Audio Sources shows the switch on, the capability table, and "No tool is using audio sources." Run the Step-8 console snippet from Task 6 in the example applet: the red chip appears at the top centre with "example applet is using system audio · 0:03" counting up, and the settings list shows the same grant with counters. Press Stop on the chip → chip disappears, the applet console logs `control {type:'ended', reason:'user-stopped'}`. Turn the switch off → the snippet resolves `reply null` without a picker. Record the observations in the commit body.

- [ ] **Step 6: Full gate and commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn test:unit
nix develop -c yarn typecheck
git add src/renderer/src/audio-sources/grants-store.ts src/renderer/src/audio-sources/audio-source-chips.ts src/renderer/src/self/settings/capabilities src/renderer/src/self/settings/moss-settings.ts src/renderer/src/app/main-dashboard.ts src/renderer/xliff src/renderer/src/locales/generated
git commit -m "feat(renderer): audio-source chip and Settings > Capabilities > Audio Sources

One chip per live grant with a Stop button; a Capabilities tab holding the
Audio Sources sub-tab: the allow switch (default on), the host's capability
readout, and the active-grant list. Strings extracted and translated into all
eight locales."
```

---

### Task 8: Docs sync, round-trip record, branch finish

**Files:**
- Modify (Presence repo): `docs/superpowers/specs/2026-09-22-audio-source-capture-design.md` (Section 2 "Landed" paragraph), this plan's status header
- Modify (Moss): `CLAUDE.md` is NOT touched — Moss's CLAUDE.md records repository facts, and this feature adds none that a reader must know before reading source; the message list lives in `libs/api/src/types.ts`.

- [ ] **Step 1: Two-machine-free round trip record**

Run the full Definition-of-done check for Moss (spec "Definition of done", second bullet) on the owner's machine with `yarn applet-dev-example` (two agents): request from agent 1's example applet, share "All system output", play a tone in Firefox, confirm frames with non-zero peak arrive; confirm agent 2 (a second Moss process, itself a pulse client) is NOT in agent 1's picker rows when both are the same binary (both are in `getAppMetrics`? — no: agent 2 is a separate Electron process tree, so it IS listed; that is correct and worth recording); Stop from the chip; close the WAL window path: open the example applet in a WAL window, request from there, close the window → `listAudioSourceGrants()` empty. Write the observed results into the plan's status header (Step 3).

- [ ] **Step 2: Spec sync (Presence repo)**

Append to spec Section 2, after the "Tests" paragraph:
```markdown
**Landed (2026-09-22; plan `docs/superpowers/plans/2026-09-22-moss-audio-sources.md`).**
Branch `feat/audio-source-capture` in Moss (merge commit recorded in the plan
header). Deviations from the text above: the enable switch is renderer-owned
(`PersistedStore.audioSourcesEnabled`), gated in `AudioSourceGrantsClient`
before main is invoked — main has no preference store; the chip is a fixed
overlay at the top centre of the main window (there is no global top bar);
the picker page is not localised (as its sibling); the mixer is
clock-driven (a 20 ms interval pops at most one chunk per stream, backlog
capped at 5 chunks) so one silent stream cannot stall the others; the request
message carries no payload — the host derives the tool name from the iframe
origin. The reply shape Plan 3 consumes: `{ label, canExcludeSelf }` with the
grant port in `ports[0]`, or `null`.
```

- [ ] **Step 3: Plan status header (this file)**

Insert under the `**Spec:**` line:
```markdown
> **Status (YYYY-MM-DD): EXECUTED.** Moss branch `feat/audio-source-capture`, commits `<first>`..`<last>`, merged `--no-ff` as `<hash>` (or: PR #N open). Round trip observed: <one line per Step-1 check with the observed value>. Deviations recorded in the spec's Section 2 "Landed" paragraph.
```

- [ ] **Step 4: Commit both repos, finish the branch**

```bash
cd /home/eric/code/metacurrency/holochain/presence
git add docs/superpowers/specs/2026-09-22-audio-source-capture-design.md docs/superpowers/plans/2026-09-22-moss-audio-sources.md
git commit -m "docs: record plan 2 (Moss audio sources) as executed; spec Section 2 landed paragraph"
```
Then, in Moss, use `superpowers:finishing-a-development-branch` — the whole-branch adversarial review happens before the merge/PR decision.

---

## Self-review

**Spec coverage (Section 2 + Error handling + Decisions):**
- Weave message in types/schemas/dispatcher, identity from `source` → Task 6. ✔
- Reply with a transferable, `TransferableReply`, the one reply-site change → Task 6 (main window) + the WAL-window local marker. ✔
- Main flow steps 1–7 → Tasks 3, 4, 6 (step 2's switch relocated to the renderer — declared in Global Constraints). ✔
- Picker: checkbox list, system row first, playing-first sort, playing/silent marks, perApp false → system row only, cancel → null, one at a time → Tasks 3 (rows, gating), 4 (window/page). ✔
- Streams: system + per-app, exclude set from `getAppMetrics`, mixer table-tested → Tasks 2, 3, 4. ✔
- `MessageChannelMain`/`webContents.postMessage`/preload relay/`window.postMessage`/applet-host resolves with the port → Tasks 4, 5, 6. ✔
- Teardown: iframe unload, Stop (chip/settings), backend events (per-stream rule), tool close, one idempotent `endGrant` → Tasks 3, 6, 7; plus the window-destroyed path (Task 4) which the spec does not name — declared additive. ✔
- Chip, Settings Capabilities tab with Audio Sources sub-tab (switch default on, capability readout, active grants with Stop) → Task 7. ✔
- Tests named by the spec: grant table, endGrant idempotence, process-tree computation (the tree is `getAppMetrics().map(pid)` in the binding — exercised as `excludePids` passthrough in Task 3; no separate computation exists to test), schema round-trip, drift → Tasks 3, 4, 6. ✔
- Counters shown in settings, no teardown on chunkDropped/stalled/recovered → Tasks 3, 7. ✔
- `NSAudioCaptureUsageDescription` (Section 1 floors) → Task 1. ✔
- Definition of done: `yarn test` (tryorama) is untouched by this work; `yarn test:unit` + `yarn typecheck` are the gates; the applet-dev round trip → Task 8. ✔

**Placeholder scan:** none of the banned phrases remain; every code step carries its code. Task 6 Step 7 asks the implementer to locate the WAL window's applet-name field with a grep and names the fallback — that is a lookup, not a placeholder.

**Type consistency:** `AudioSourceRequestResult { grantId, label, canExcludeSelf }` (Task 1) is what Task 3 returns, Task 4's bridge types, Task 5's client consumes, Task 6 strips to `{ label, canExcludeSelf }` for the Tool. `stopAudioSources(grantId, reason)` has the same two-arg signature in preload (4), electron-api (6), client bindings (5), chip/settings (7). `GrantPort` (3) is satisfied by `MessagePortMain` (4). `AudioSourcePortDelivery { requestId, grantId }` is the IPC payload (4), the page message minus `type` (4's relay adds `type`), and what `matchAudioSourcePortMessage` returns (5).

**Review Focus:** all five pinned (Task 2 length rows; Task 3 deliverPort-false, one-of-two-open-fails, endGrant-twice; Task 5/6 self-window source check in the receiver test and the early return in the handler).
