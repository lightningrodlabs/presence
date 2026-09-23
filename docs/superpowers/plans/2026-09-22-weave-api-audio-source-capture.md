# `@theweave/api` Audio Source Capture Implementation Plan (Plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tool calls `weaveClient.captureAudioSources()` and gets back a live `MediaStreamTrack` of the audio the user chose in Moss's picker, ending when the host ends the grant or the Tool calls `stop()`.

**Architecture:** The applet iframe (Moss-injected) sends the Weave message `request-audio-sources` with a port-aware reply path and hands the transferred `MessagePort` to `createAudioSourceCapture` in `@theweave/api`. That helper pumps the host's 20 ms `Int16Array` frames into an `AudioWorkletNode` whose processor keeps a 200 ms ring (`PcmRing`, one pure class whose source is embedded verbatim into the worklet module), feeding a `MediaStreamAudioDestinationNode`; the track is the deliverable. A pure `CaptureSession` state machine owns the port protocol (frames, `ended`, `close`, a frame-gap watchdog), so everything but the Web Audio glue is table-tested in node.

**Tech Stack:** TypeScript 5.8 (`libs/api`, ES2018, `lib: dom`), Web Audio API (`AudioWorklet`, `MediaStreamAudioDestinationNode`), Vitest (root `yarn test:unit`), api-extractor/api-documenter for the reference docs, npm publish (owner-executed).

**Spec:** `docs/superpowers/specs/2026-09-22-audio-source-capture-design.md` (Presence repo) — Section 3, Section 2's "Landed" paragraph (the reply shape Moss produces), "Error handling". Plan 2's landed facts: the reply is `{ type:'success', result:{ label, canExcludeSelf } }` with the grant port in `ports[0]`, or `result: null`; main posts `{ type:'ended', reason }` then closes the port; the Tool ends a grant by posting `{ type:'close' }`; frames are mono 48 kHz `Int16Array` of 960 samples, one per 20 ms, silence frames included.

> **Status (2026-09-22): EXECUTED.** Moss branch `feat/api-audio-source-capture` off `main-0.7` @ `8a25037e`, commits `c350686a`..`cbfc4cb7` (11 commits: 5 task commits, 1 helper fix round, 2 host-pump fixes from live measurement, a 3-commit final-review fix wave); merge pending the owner's decision at branch finish (recorded here when done). Subagent-driven with an adversarial review per task (Task 3 needed one fix round on the helper and two measurement-driven rounds on the Moss host pump; Tasks 1, 2, 4, 5 clean) plus a whole-branch review. Gate at HEAD: `yarn test:unit` 35 files / 375 tests, `yarn typecheck` green. Live (Task 4 + the measurement record `task-3-fix2-report.md`): round trip from the example applet green; host pump 50.1 frames/s, Tool ring overflow 0 over 20 s (was 4–6% drops). Publish is the owner's step: `cd libs/api && nix develop -c npm publish --tag latest` (current `latest` = `0.7.0-dev.3`); Plan 4 verifies `npm view @theweave/api@0.7.0-dev.4 version` before pinning. Deviations and Plan 4 carry-overs are in the spec's Section 3 "Landed" paragraph; every controller ruling is in the run's ledger (copy in the session scratchpad) and the session's final message.

## Global Constraints

- Work happens in `/home/eric/code/metacurrency/holochain/moss` on branch `feat/api-audio-source-capture` off `main-0.7` (which now carries Plan 2 as `8a25037e`). Confirm with `git branch --show-current`.
- Every yarn command runs through the Moss nix shell: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn <script>`. Baseline at plan time: `yarn test:unit` 32 files / 327 tests, `yarn typecheck` green.
- Gate for every task: `nix develop -c yarn test:unit` and `nix develop -c yarn typecheck` green; after editing `libs/api` run `nix develop -c yarn build:api` first (typecheck resolves `@theweave/api` from `dist`); after editing the iframe run `nix develop -c yarn build:applet-iframe`.
- `libs/api/tsconfig.json` compiles `src/**/*.ts` into `dist` with declarations — test files must be excluded from that build (Task 1 adds `exclude`) and included in the root `vitest.config.ts`.
- The worklet module is an inline string registered from a Blob URL (spec Section 3: the package ships no extra asset). The `applet://` and `cross-group://` schemes are registered `standard: true, secure: true, supportFetchAPI: true` with no CSP (checked `src/main/index.ts` and `customSchemes.ts` at plan time), so Blob module URLs load in Tool iframes.
- ONE ring implementation: `PcmRing` is written self-contained (no imports, no `tslib` helpers, no class fields — ES2018 output) so its compiled source can be embedded into the worklet string via `PcmRing.toString()`; Task 1 pins that with a test.
- Sample rate: frames are 48 kHz. `opts.audioContext` is used when its `sampleRate === 48000`; otherwise a private `new AudioContext({ sampleRate: 48000 })` is created (declared; a `MediaStreamTrack` is consumable from any context, and Presence's shared context is 48 kHz — `ui/src/mic-source.ts`).
- Port close is NOT observable as an event in Electron 32's Chromium (the `MessagePort` `close` event shipped later), so the host's `{type:'ended'}` message is the primary end signal and a frame-gap watchdog (`FRAME_GAP_TIMEOUT_MS = 5000`; the host sends silence frames continuously, so a gap means the port is dead) is the fallback — declared.
- `captureAudioSources` is OPTIONAL on `WeaveServices` and on `WeaveClient`: the client method exists only when the host's `__WEAVE_API__` offers it, so a Tool feature-detects with `client.captureAudioSources?.` exactly as the spec says; `buildHeadlessWeaveClient` in Moss leaves it undefined (no change needed there).
- Version: `libs/api/package.json` → `0.7.0-dev.4`. Publishing to npm is an outward side effect the owner performs (needs OTP); the plan prepares everything and records the exact command. Presence (Plan 4) pins `0.7.0-dev.4`.
- Moss CLAUDE.md binds all of this: TDD (rule 1), strong typing (rule 4), comments explain intent never prior behaviour (rule 6), keep files small (rule 8), no co-author trailers (rule 3), no exclamation marks in reports (rule 0).

## Review Focus

Five inputs the spec implies but no task's tests exercise — each pinned in the owning task:

1. **The host's first frame arrives before the worklet module has finished loading** (`addModule` is async): frames must be buffered or the first ~100 ms dropped knowingly, never thrown at an unconstructed node — Task 3, the pre-ready queue test in `capture-session` (frames before `ready()` are held, then flushed in order).
2. **The Tool calls `stop()` twice, or `stop()` after the host already ended** — no second `close` message, no throw, `onended` never fires from `stop()` — Task 2, idempotence rows.
3. **A frame of the wrong length or type** (a non-`Int16Array` message that is not a control message): ignored and counted, never forwarded — Task 2, "unknown message" row; Task 1, `writeInt16` with a length that is not 960 still works (ring is length-agnostic).
4. **The host goes silent without `ended`** (renderer crash mid-grant): the watchdog ends the capture with reason `'host-silent'` and `onended` fires once — Task 2, watchdog row with fake timers.
5. **`opts.audioContext` at 44.1 kHz** (a Tool's default context): the helper must not feed 48 kHz samples into a 44.1 kHz graph — Task 3, the context-selection test (`selectContext` is a pure function).

---

## File structure

| Path (in `../moss`) | Responsibility |
|---|---|
| `libs/api/src/pcm-ring.ts` (new) | `PcmRing`: fixed-capacity float ring, `writeInt16` (drop-oldest, counted), `readInto` (zero-fill, counted), `stats()`; self-contained for worklet embedding |
| `libs/api/src/pcm-ring.test.ts` (new) | table tests + the embedding negative control |
| `libs/api/src/capture-session.ts` (new) | `CaptureSession`: port protocol state machine over injected bindings (frames, `ended`, `stop`, watchdog, pre-ready queue, stats) |
| `libs/api/src/capture-session.test.ts` (new) | table tests with fake timers |
| `libs/api/src/audio-source-capture.ts` (new) | `AudioSourceCapture` interface, `AudioSourceDelivery`, `selectContext`, `WORKLET_SOURCE`, `createAudioSourceCapture` (Web Audio glue) |
| `libs/api/src/audio-source-capture.test.ts` (new) | `selectContext` table; `WORKLET_SOURCE` assembly assertions |
| `libs/api/src/api.ts` | `WeaveServices.captureAudioSources?`, `WeaveClient.captureAudioSources?` wired in `connect()` |
| `libs/api/src/index.ts` | export the new modules |
| `libs/api/tsconfig.json` | `exclude` test files from the build |
| `vitest.config.ts` (root) | include `libs/api/src/**/*.test.ts` |
| `iframes/applet-iframe/src/index.ts` | `postMessageWithPorts`, `postMessage` delegating to it, `weaveApi.captureAudioSources` |
| `libs/api/package.json` | version `0.7.0-dev.4` |
| `libs/api/README.md` | "Capturing system audio" section |
| `docs/api-reference/api/*.md` (generated) | regenerated by `yarn build:api-docs` |

---

### Task 1: `PcmRing` and the api test harness

**Files:**
- Create: `libs/api/src/pcm-ring.ts`, `libs/api/src/pcm-ring.test.ts`
- Modify: `libs/api/tsconfig.json` (add `exclude`), `vitest.config.ts` (root, add include)

**Interfaces:**
- Produces: `class PcmRing { constructor(capacity: number); writeInt16(frame: Int16Array): void; readInto(out: Float32Array): void; available(): number; stats(): PcmRingStats }`, `interface PcmRingStats { written: number; overflowDropped: number; underrunSamples: number }`, `RING_CAPACITY_SAMPLES = 9600` (200 ms at 48 kHz). Tasks 2 and 3 import these.

- [ ] **Step 1: Create the branch**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git checkout main-0.7 && git pull --ff-only
git checkout -b feat/api-audio-source-capture
```

- [ ] **Step 2: Wire the test harness (red on a missing module first)**

Root `vitest.config.ts` — add `'libs/api/src/**/*.test.ts',` to the `include` array (after the `shared/**` line). `libs/api/tsconfig.json` — add after `"include": ["src/**/*.ts"]`:
```json
  ,
  "exclude": ["src/**/*.test.ts"]
```
(keep the JSON valid: `"include": ["src/**/*.ts"], "exclude": ["src/**/*.test.ts"]`).

- [ ] **Step 3: Write the failing test**

`libs/api/src/pcm-ring.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PcmRing, RING_CAPACITY_SAMPLES } from './pcm-ring.js';

const int16 = (values: number[]) => Int16Array.from(values);
const floats = (n: number) => new Float32Array(n);

describe('PcmRing', () => {
  it('RING_CAPACITY_SAMPLES is 200 ms at 48 kHz', () => {
    expect(RING_CAPACITY_SAMPLES).toBe(9600);
  });

  it('reads back what was written, converted to float by 1/32768', () => {
    const ring = new PcmRing(8);
    ring.writeInt16(int16([16384, -32768, 0]));
    const out = floats(3);
    ring.readInto(out);
    expect(Array.from(out)).toEqual([0.5, -1, 0]);
    expect(ring.available()).toBe(0);
  });

  it('zero-fills on underrun and counts the missing samples', () => {
    const ring = new PcmRing(8);
    ring.writeInt16(int16([32767]));
    const out = floats(4);
    out.fill(9);
    ring.readInto(out);
    expect(out[0]).toBeCloseTo(32767 / 32768, 6);
    expect(Array.from(out.subarray(1))).toEqual([0, 0, 0]);
    expect(ring.stats().underrunSamples).toBe(3);
  });

  it('drops the oldest samples on overflow and counts them', () => {
    const ring = new PcmRing(4);
    ring.writeInt16(int16([1, 2, 3]));
    ring.writeInt16(int16([4, 5, 6]));
    expect(ring.available()).toBe(4);
    expect(ring.stats().overflowDropped).toBe(2);
    const out = floats(4);
    ring.readInto(out);
    expect(Array.from(out).map((v) => Math.round(v * 32768))).toEqual([3, 4, 5, 6]);
  });

  it('wraps around the end of the buffer', () => {
    const ring = new PcmRing(5);
    ring.writeInt16(int16([1, 2, 3, 4]));
    ring.readInto(floats(3));
    ring.writeInt16(int16([5, 6, 7]));
    const out = floats(4);
    ring.readInto(out);
    expect(Array.from(out).map((v) => Math.round(v * 32768))).toEqual([4, 5, 6, 7]);
  });

  it('a frame longer than the capacity keeps only its newest samples', () => {
    const ring = new PcmRing(3);
    ring.writeInt16(int16([1, 2, 3, 4, 5]));
    expect(ring.available()).toBe(3);
    expect(ring.stats().overflowDropped).toBe(2);
    const out = floats(3);
    ring.readInto(out);
    expect(Array.from(out).map((v) => Math.round(v * 32768))).toEqual([3, 4, 5]);
  });

  it('is length-agnostic: 960-sample frames and 128-sample reads interleave (Review Focus 3)', () => {
    const ring = new PcmRing(RING_CAPACITY_SAMPLES);
    ring.writeInt16(new Int16Array(960).fill(100));
    let read = 0;
    const out = floats(128);
    while (ring.available() > 0) {
      ring.readInto(out);
      read += 128;
    }
    expect(read).toBe(1024);
    expect(ring.stats()).toEqual({ written: 960, overflowDropped: 0, underrunSamples: 64 });
  });

  it('stats() counts written samples', () => {
    const ring = new PcmRing(8);
    ring.writeInt16(int16([1, 2]));
    ring.writeInt16(int16([3]));
    expect(ring.stats().written).toBe(3);
  });
});

describe('PcmRing is embeddable in a worklet module string', () => {
  // The worklet processor runs on the audio thread from a Blob module that
  // cannot import anything, so the class source is spliced in verbatim.
  const source = PcmRing.toString();

  it('compiles to a self-contained class expression', () => {
    expect(source.startsWith('class ')).toBe(true);
    expect(source).not.toMatch(/\bimport\b|\brequire\(|\bexport\b|tslib|__(?:extends|assign|spreadArray|classPrivate)/);
  });

  it('re-evaluates from its own source with identical behaviour', () => {
    const Rebuilt = new Function(`return (${source});`)() as typeof PcmRing;
    const ring = new Rebuilt(4);
    ring.writeInt16(int16([1, 2, 3, 4, 5]));
    const out = floats(4);
    ring.readInto(out);
    expect(Array.from(out).map((v) => Math.round(v * 32768))).toEqual([2, 3, 4, 5]);
    expect(ring.stats().overflowDropped).toBe(1);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit libs/api/src/pcm-ring.test.ts`
Expected: FAIL — `Cannot find module './pcm-ring.js'` (confirms the root include now picks up `libs/api`).

- [ ] **Step 5: Write the implementation**

`libs/api/src/pcm-ring.ts`:
```ts
/**
 * Fixed-capacity mono PCM ring shared by the host-frame path and the audio
 * thread. The audio-source worklet processor is registered from an inline
 * module (a Blob URL) that cannot import anything, so this class is spliced
 * into that module's source with `PcmRing.toString()`. It therefore uses no
 * imports, no module-level helpers and no class fields — only what the ES2018
 * build leaves inside the class body. `pcm-ring.test.ts` pins that.
 */

/** 200 ms of mono audio at the fixed 48 kHz frame rate. */
export const RING_CAPACITY_SAMPLES = 9600;

export interface PcmRingStats {
  /** Samples accepted from the host (after overflow trimming). */
  written: number;
  /** Samples discarded because the reader fell behind by more than the capacity. */
  overflowDropped: number;
  /** Samples the reader asked for that were not there (zero-filled). */
  underrunSamples: number;
}

export class PcmRing {
  private buffer: Float32Array;
  private capacity: number;
  private head: number;
  private length: number;
  private written: number;
  private overflowDropped: number;
  private underrunSamples: number;

  constructor(capacity: number) {
    this.buffer = new Float32Array(capacity);
    this.capacity = capacity;
    this.head = 0;
    this.length = 0;
    this.written = 0;
    this.overflowDropped = 0;
    this.underrunSamples = 0;
  }

  available(): number {
    return this.length;
  }

  /** Appends a frame of 16-bit samples, discarding the oldest audio when full. */
  writeInt16(frame: Int16Array): void {
    let start = 0;
    if (frame.length > this.capacity) {
      this.overflowDropped += frame.length - this.capacity;
      start = frame.length - this.capacity;
    }
    const incoming = frame.length - start;
    const overflow = this.length + incoming - this.capacity;
    if (overflow > 0) {
      this.head = (this.head + overflow) % this.capacity;
      this.length -= overflow;
      this.overflowDropped += overflow;
    }
    let tail = (this.head + this.length) % this.capacity;
    for (let i = start; i < frame.length; i++) {
      this.buffer[tail] = frame[i] / 32768;
      tail = (tail + 1) % this.capacity;
    }
    this.length += incoming;
    this.written += incoming;
  }

  /** Fills `out` with the oldest samples, zero-filling whatever is missing. */
  readInto(out: Float32Array): void {
    const n = Math.min(out.length, this.length);
    for (let i = 0; i < n; i++) {
      out[i] = this.buffer[this.head];
      this.head = (this.head + 1) % this.capacity;
    }
    this.length -= n;
    for (let i = n; i < out.length; i++) out[i] = 0;
    this.underrunSamples += out.length - n;
  }

  stats(): PcmRingStats {
    return {
      written: this.written,
      overflowDropped: this.overflowDropped,
      underrunSamples: this.underrunSamples,
    };
  }
}
```

- [ ] **Step 6: Run the test to verify it passes; build and typecheck**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn test:unit libs/api/src/pcm-ring.test.ts
nix develop -c yarn build:api && ls libs/api/dist | grep -c "pcm-ring.test" ; nix develop -c yarn typecheck
```
Expected: 10 tests pass; the `grep -c` prints `0` (test files are not built into `dist`); typecheck green. If the "self-contained" test fails on `__` helper tokens, the TS build injected a helper — the class must be rewritten to avoid the construct (the test is the authority).

- [ ] **Step 7: Commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git add libs/api/src/pcm-ring.ts libs/api/src/pcm-ring.test.ts libs/api/tsconfig.json vitest.config.ts
git commit -m "feat(api): PcmRing, the audio-source ring buffer, and the libs/api unit-test harness"
```

---

### Task 2: `CaptureSession` — the port protocol as a pure state machine

**Files:**
- Create: `libs/api/src/capture-session.ts`, `libs/api/src/capture-session.test.ts`

**Interfaces:**
- Produces:
```ts
export const FRAME_GAP_TIMEOUT_MS = 5000;
export type CaptureState = 'starting' | 'live' | 'ended' | 'stopped';
export interface CaptureSessionBindings {
  forwardFrame: (frame: Int16Array) => void;   // to the worklet
  teardown: () => void;                         // disconnect nodes, stop the track
  postToHost: (message: { type: 'close' }) => void;
  closePort: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}
export interface CaptureSessionStats { framesReceived: number; framesQueuedBeforeReady: number; unknownMessages: number }
export class CaptureSession {
  constructor(b: CaptureSessionBindings);
  readonly state: CaptureState; readonly endedReason: string | undefined;
  onended?: () => void;
  ready(): void;                       // worklet module loaded: flush the queue, arm the watchdog
  handlePortMessage(data: unknown): void;
  stop(): void;                        // Tool-initiated; never fires onended
  stats(): CaptureSessionStats;
}
```

- [ ] **Step 1: Write the failing test**

`libs/api/src/capture-session.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { CaptureSession, CaptureSessionBindings, FRAME_GAP_TIMEOUT_MS } from './capture-session.js';

class FakeTimers {
  private timers = new Map<number, { fn: () => void; at: number }>();
  private next = 1;
  now = 0;
  setTimeout = (fn: () => void, ms: number) => {
    const h = this.next++;
    this.timers.set(h, { fn, at: this.now + ms });
    return h;
  };
  clearTimeout = (h: unknown) => {
    this.timers.delete(h as number);
  };
  advance(ms: number) {
    this.now += ms;
    for (const [h, t] of [...this.timers]) {
      if (t.at <= this.now) {
        this.timers.delete(h);
        t.fn();
      }
    }
  }
  get pending() {
    return this.timers.size;
  }
}

function rig() {
  const timers = new FakeTimers();
  const forwarded: Int16Array[] = [];
  const b: CaptureSessionBindings = {
    forwardFrame: vi.fn((f: Int16Array) => void forwarded.push(f)),
    teardown: vi.fn(),
    postToHost: vi.fn(),
    closePort: vi.fn(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  const session = new CaptureSession(b);
  const onended = vi.fn();
  session.onended = onended;
  return { session, b, timers, forwarded, onended };
}

const frame = (v: number) => new Int16Array(960).fill(v);

describe('CaptureSession before ready', () => {
  it('starts in starting, holds frames, and forwards them in order on ready() (Review Focus 1)', () => {
    const r = rig();
    expect(r.session.state).toBe('starting');
    r.session.handlePortMessage(frame(1));
    r.session.handlePortMessage(frame(2));
    expect(r.b.forwardFrame).not.toHaveBeenCalled();
    r.session.ready();
    expect(r.session.state).toBe('live');
    expect(r.forwarded.map((f) => f[0])).toEqual([1, 2]);
    expect(r.session.stats()).toEqual({ framesReceived: 2, framesQueuedBeforeReady: 2, unknownMessages: 0 });
  });

  it('an ended message before ready still ends the session and fires onended once', () => {
    const r = rig();
    r.session.handlePortMessage({ type: 'ended', reason: 'user-stopped' });
    expect(r.session.state).toBe('ended');
    expect(r.session.endedReason).toBe('user-stopped');
    expect(r.onended).toHaveBeenCalledTimes(1);
    r.session.ready();
    expect(r.session.state).toBe('ended');
    expect(r.b.forwardFrame).not.toHaveBeenCalled();
  });
});

describe('CaptureSession live', () => {
  it('forwards frames and counts them', () => {
    const r = rig();
    r.session.ready();
    r.session.handlePortMessage(frame(7));
    expect(r.b.forwardFrame).toHaveBeenCalledTimes(1);
    expect(r.session.stats().framesReceived).toBe(1);
  });

  it('ignores and counts messages that are neither frames nor known controls (Review Focus 3)', () => {
    const r = rig();
    r.session.ready();
    r.session.handlePortMessage('garbage');
    r.session.handlePortMessage({ type: 'unknown' });
    r.session.handlePortMessage(new Float32Array(4));
    expect(r.b.forwardFrame).not.toHaveBeenCalled();
    expect(r.session.stats().unknownMessages).toBe(3);
    expect(r.session.state).toBe('live');
  });

  it('host ended → teardown, port closed, onended once, no close message to the host', () => {
    const r = rig();
    r.session.ready();
    r.session.handlePortMessage({ type: 'ended', reason: 'stream-lost' });
    expect(r.session.state).toBe('ended');
    expect(r.session.endedReason).toBe('stream-lost');
    expect(r.b.teardown).toHaveBeenCalledTimes(1);
    expect(r.b.closePort).toHaveBeenCalledTimes(1);
    expect(r.b.postToHost).not.toHaveBeenCalled();
    expect(r.onended).toHaveBeenCalledTimes(1);
    expect(r.timers.pending).toBe(0);
  });

  it('frames after ended are dropped', () => {
    const r = rig();
    r.session.ready();
    r.session.handlePortMessage({ type: 'ended', reason: 'user-stopped' });
    r.session.handlePortMessage(frame(1));
    expect(r.b.forwardFrame).not.toHaveBeenCalled();
  });
});

describe('CaptureSession.stop (Tool-initiated)', () => {
  it('posts close, closes the port, tears down, never fires onended (Review Focus 2)', () => {
    const r = rig();
    r.session.ready();
    r.session.stop();
    expect(r.session.state).toBe('stopped');
    expect(r.b.postToHost).toHaveBeenCalledWith({ type: 'close' });
    expect(r.b.closePort).toHaveBeenCalledTimes(1);
    expect(r.b.teardown).toHaveBeenCalledTimes(1);
    expect(r.onended).not.toHaveBeenCalled();
    expect(r.timers.pending).toBe(0);
  });

  it('stop twice is a no-op the second time', () => {
    const r = rig();
    r.session.ready();
    r.session.stop();
    r.session.stop();
    expect(r.b.postToHost).toHaveBeenCalledTimes(1);
    expect(r.b.teardown).toHaveBeenCalledTimes(1);
  });

  it('stop after the host ended is a no-op', () => {
    const r = rig();
    r.session.ready();
    r.session.handlePortMessage({ type: 'ended', reason: 'user-stopped' });
    r.session.stop();
    expect(r.b.postToHost).not.toHaveBeenCalled();
    expect(r.b.teardown).toHaveBeenCalledTimes(1);
    expect(r.session.state).toBe('ended');
  });

  it('stop before ready works and later ready() is a no-op', () => {
    const r = rig();
    r.session.stop();
    r.session.ready();
    expect(r.session.state).toBe('stopped');
    expect(r.b.postToHost).toHaveBeenCalledTimes(1);
  });
});

describe('frame-gap watchdog (Review Focus 4)', () => {
  it('is armed on ready and re-armed by every frame', () => {
    const r = rig();
    r.session.ready();
    r.timers.advance(FRAME_GAP_TIMEOUT_MS - 1);
    r.session.handlePortMessage(frame(1));
    r.timers.advance(FRAME_GAP_TIMEOUT_MS - 1);
    expect(r.session.state).toBe('live');
    r.timers.advance(1);
    expect(r.session.state).toBe('ended');
    expect(r.session.endedReason).toBe('host-silent');
    expect(r.onended).toHaveBeenCalledTimes(1);
    expect(r.b.teardown).toHaveBeenCalledTimes(1);
    expect(r.b.closePort).toHaveBeenCalledTimes(1);
  });

  it('is not armed before ready (the host may legitimately be slow to start)', () => {
    const r = rig();
    r.timers.advance(FRAME_GAP_TIMEOUT_MS * 3);
    expect(r.session.state).toBe('starting');
  });

  it('is disarmed by stop', () => {
    const r = rig();
    r.session.ready();
    r.session.stop();
    r.timers.advance(FRAME_GAP_TIMEOUT_MS + 1);
    expect(r.onended).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit libs/api/src/capture-session.test.ts`
Expected: FAIL — `Cannot find module './capture-session.js'`.

- [ ] **Step 3: Write the implementation**

`libs/api/src/capture-session.ts`:
```ts
/**
 * The Tool-side half of an audio-source grant's port protocol, kept free of
 * Web Audio so it can be table-tested: the host streams Int16 frames and
 * finally posts `{type:'ended', reason}`; the Tool may post `{type:'close'}`.
 * Frames that arrive before the worklet module has loaded are queued and
 * flushed in order. Because the host sends silence frames continuously, a
 * gap longer than FRAME_GAP_TIMEOUT_MS means the port is dead (the host
 * renderer crashed or the port was closed without a message — a bare port
 * close is not observable as an event in the Chromium this ships on).
 */

export const FRAME_GAP_TIMEOUT_MS = 5000;

export type CaptureState = 'starting' | 'live' | 'ended' | 'stopped';

export interface CaptureSessionBindings {
  forwardFrame: (frame: Int16Array) => void;
  teardown: () => void;
  postToHost: (message: { type: 'close' }) => void;
  closePort: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface CaptureSessionStats {
  framesReceived: number;
  framesQueuedBeforeReady: number;
  unknownMessages: number;
}

export class CaptureSession {
  state: CaptureState = 'starting';
  endedReason: string | undefined;
  onended?: () => void;

  private queue: Int16Array[] = [];
  private watchdog: unknown;
  private framesReceived = 0;
  private framesQueuedBeforeReady = 0;
  private unknownMessages = 0;

  constructor(private readonly b: CaptureSessionBindings) {}

  stats(): CaptureSessionStats {
    return {
      framesReceived: this.framesReceived,
      framesQueuedBeforeReady: this.framesQueuedBeforeReady,
      unknownMessages: this.unknownMessages,
    };
  }

  ready(): void {
    if (this.state !== 'starting') return;
    this.state = 'live';
    for (const frame of this.queue) this.b.forwardFrame(frame);
    this.queue = [];
    this.armWatchdog();
  }

  handlePortMessage(data: unknown): void {
    if (this.state === 'ended' || this.state === 'stopped') return;
    if (data instanceof Int16Array) {
      this.framesReceived += 1;
      if (this.state === 'starting') {
        this.framesQueuedBeforeReady += 1;
        this.queue.push(data);
        return;
      }
      this.b.forwardFrame(data);
      this.armWatchdog();
      return;
    }
    const control = data as { type?: unknown; reason?: unknown } | null;
    if (control && typeof control === 'object' && control.type === 'ended') {
      this.finish('ended', typeof control.reason === 'string' ? control.reason : 'ended');
      return;
    }
    this.unknownMessages += 1;
  }

  stop(): void {
    if (this.state === 'ended' || this.state === 'stopped') return;
    this.b.postToHost({ type: 'close' });
    this.finish('stopped', undefined);
  }

  private armWatchdog(): void {
    this.b.clearTimeout(this.watchdog);
    this.watchdog = this.b.setTimeout(() => this.finish('ended', 'host-silent'), FRAME_GAP_TIMEOUT_MS);
  }

  private finish(state: 'ended' | 'stopped', reason: string | undefined): void {
    this.b.clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.queue = [];
    this.state = state;
    this.endedReason = reason;
    this.b.closePort();
    this.b.teardown();
    if (state === 'ended') this.onended?.();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes; build; typecheck**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn test:unit libs/api/src/capture-session.test.ts
nix develop -c yarn build:api && nix develop -c yarn typecheck
```
Expected: 13 tests pass; green.

- [ ] **Step 5: Commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git add libs/api/src/capture-session.ts libs/api/src/capture-session.test.ts
git commit -m "feat(api): CaptureSession, the Tool-side port protocol of an audio-source grant"
```

---

### Task 3: `createAudioSourceCapture` and the `WeaveServices`/`WeaveClient` surface

**Files:**
- Create: `libs/api/src/audio-source-capture.ts`, `libs/api/src/audio-source-capture.test.ts`
- Modify: `libs/api/src/api.ts`, `libs/api/src/index.ts`

**Interfaces:**
- Consumes: `PcmRing`, `RING_CAPACITY_SAMPLES` (Task 1); `CaptureSession` (Task 2).
- Produces:
```ts
export interface AudioSourceCapture {
  readonly track: MediaStreamTrack;
  readonly label: string;
  readonly canExcludeSelf: boolean;
  stop(): void;
  onended?: () => void;
  readonly stats: AudioSourceCaptureStats;   // live-updated snapshot
}
export interface AudioSourceCaptureStats { framesReceived: number; overflowDropped: number; underrunSamples: number; unknownMessages: number }
export interface AudioSourceDelivery { label: string; canExcludeSelf: boolean; port: MessagePort }
export interface CaptureAudioSourcesOptions { audioContext?: AudioContext }
export const AUDIO_SOURCE_SAMPLE_RATE = 48000;
export function selectContext(preferred: AudioContext | undefined, create: (rate: number) => AudioContext): { context: AudioContext; owned: boolean }
export const WORKLET_PROCESSOR_NAME = 'moss-audio-source';
export const WORKLET_SOURCE: string;
export async function createAudioSourceCapture(delivery: AudioSourceDelivery, opts?: CaptureAudioSourcesOptions): Promise<AudioSourceCapture>
```
  and on `WeaveServices`: `captureAudioSources?: (opts?: CaptureAudioSourcesOptions) => Promise<AudioSourceCapture | null>`; on `WeaveClient`: the same optional property, assigned in `connect()` only when the host offers it.

- [ ] **Step 1: Write the failing test**

`libs/api/src/audio-source-capture.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import {
  AUDIO_SOURCE_SAMPLE_RATE,
  WORKLET_PROCESSOR_NAME,
  WORKLET_SOURCE,
  selectContext,
} from './audio-source-capture.js';
import { PcmRing, RING_CAPACITY_SAMPLES } from './pcm-ring.js';

const ctx = (sampleRate: number) => ({ sampleRate }) as unknown as AudioContext;

describe('selectContext (Review Focus 5)', () => {
  it('uses the preferred context when it runs at 48 kHz', () => {
    const create = vi.fn();
    const preferred = ctx(48000);
    expect(selectContext(preferred, create)).toEqual({ context: preferred, owned: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a private 48 kHz context when the preferred one runs at another rate', () => {
    const created = ctx(48000);
    const create = vi.fn(() => created);
    expect(selectContext(ctx(44100), create)).toEqual({ context: created, owned: true });
    expect(create).toHaveBeenCalledWith(AUDIO_SOURCE_SAMPLE_RATE);
  });

  it('creates a private context when none is preferred', () => {
    const created = ctx(48000);
    expect(selectContext(undefined, () => created)).toEqual({ context: created, owned: true });
  });
});

describe('WORKLET_SOURCE', () => {
  it('embeds PcmRing verbatim and registers the processor under the shared name', () => {
    expect(WORKLET_SOURCE).toContain(PcmRing.toString());
    expect(WORKLET_SOURCE).toContain(`registerProcessor(${JSON.stringify(WORKLET_PROCESSOR_NAME)}`);
    expect(WORKLET_SOURCE).toContain(`new ${PcmRing.name}(${RING_CAPACITY_SAMPLES})`);
  });

  it('is self-contained module code (no imports, no helpers)', () => {
    expect(WORKLET_SOURCE).not.toMatch(/\bimport\b|\brequire\(|\bexport\b|tslib/);
  });

  it('defines a processor that pulls from the ring and stops when told to close', () => {
    // Evaluate the module with a stub AudioWorkletProcessor/registerProcessor to
    // exercise the processor class without an audio thread.
    const registered: Record<string, new () => { process: (i: unknown, o: Float32Array[][]) => boolean; port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void } }> = {};
    class AudioWorkletProcessor {
      port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: vi.fn() };
    }
    const registerProcessor = (name: string, cls: (typeof registered)[string]) => {
      registered[name] = cls;
    };
    new Function('AudioWorkletProcessor', 'registerProcessor', WORKLET_SOURCE)(AudioWorkletProcessor, registerProcessor);
    const Processor = registered[WORKLET_PROCESSOR_NAME];
    expect(Processor).toBeDefined();
    const p = new Processor();
    p.port.onmessage!({ data: new Int16Array(256).fill(16384) });
    const out = [[new Float32Array(128)]];
    expect(p.process([], out)).toBe(true);
    expect(out[0][0][0]).toBe(0.5);
    p.port.onmessage!({ data: { type: 'stats' } });
    expect(p.port.postMessage).toHaveBeenCalledWith({
      type: 'stats',
      written: 256,
      overflowDropped: 0,
      underrunSamples: 0,
    });
    p.port.onmessage!({ data: { type: 'close' } });
    expect(p.process([], out)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/eric/code/metacurrency/holochain/moss && nix develop -c yarn test:unit libs/api/src/audio-source-capture.test.ts`
Expected: FAIL — `Cannot find module './audio-source-capture.js'`.

- [ ] **Step 3: Write the implementation**

`libs/api/src/audio-source-capture.ts`:
```ts
import { CaptureSession } from './capture-session.js';
import { PcmRing, RING_CAPACITY_SAMPLES } from './pcm-ring.js';

/**
 * A capture of audio playing on the user's machine, granted by the host after
 * the user chose the sources in the host's own picker. `track` is a live mono
 * audio track that ends when the grant ends.
 * @public
 */
export interface AudioSourceCapture {
  /** Ends when the grant ends, for whatever reason. */
  readonly track: MediaStreamTrack;
  /** Human-readable summary of the chosen sources, e.g. "System audio". */
  readonly label: string;
  /** false → the host could not exclude its own playback; tell the user echo is possible. */
  readonly canExcludeSelf: boolean;
  /** Ends the grant from the Tool's side. Does not fire `onended`. */
  stop(): void;
  /** Set by the Tool; fires once when the host or the platform ends the grant. */
  onended?: () => void;
  /** Diagnostics, refreshed roughly once per second while live. */
  readonly stats: AudioSourceCaptureStats;
}

/** @public */
export interface AudioSourceCaptureStats {
  framesReceived: number;
  overflowDropped: number;
  underrunSamples: number;
  unknownMessages: number;
}

/** What the host hands over on a successful `request-audio-sources`. @public */
export interface AudioSourceDelivery {
  label: string;
  canExcludeSelf: boolean;
  port: MessagePort;
}

/** @public */
export interface CaptureAudioSourcesOptions {
  /** Build the track in this context when it runs at 48 kHz; otherwise a private one is used. */
  audioContext?: AudioContext;
}

/** The host's frame format is fixed at mono 48 kHz. @public */
export const AUDIO_SOURCE_SAMPLE_RATE = 48000;

/** @public */
export const WORKLET_PROCESSOR_NAME = 'moss-audio-source';

/** How often the worklet is asked for its ring counters while live. */
const STATS_INTERVAL_MS = 1000;

/**
 * Picks the context the audio graph lives in. Host frames are 48 kHz samples,
 * so a context at any other rate would play them at the wrong pitch; a track
 * built in a private 48 kHz context is still consumable from the Tool's own
 * context.
 * @public
 */
export function selectContext(
  preferred: AudioContext | undefined,
  create: (sampleRate: number) => AudioContext,
): { context: AudioContext; owned: boolean } {
  if (preferred && preferred.sampleRate === AUDIO_SOURCE_SAMPLE_RATE) {
    return { context: preferred, owned: false };
  }
  return { context: create(AUDIO_SOURCE_SAMPLE_RATE), owned: true };
}

/**
 * The worklet module, assembled from the ring's own source so there is one
 * ring implementation. It runs on the audio thread: host frames arrive on the
 * node port, each render quantum pulls from the ring, `{type:'stats'}` asks
 * for the counters and `{type:'close'}` retires the processor.
 * @public
 */
export const WORKLET_SOURCE = `
${PcmRing.toString()}
class MossAudioSourceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new ${PcmRing.name}(${RING_CAPACITY_SAMPLES});
    this.closed = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof Int16Array) {
        this.ring.writeInt16(d);
      } else if (d && d.type === 'stats') {
        const s = this.ring.stats();
        this.port.postMessage({ type: 'stats', written: s.written, overflowDropped: s.overflowDropped, underrunSamples: s.underrunSamples });
      } else if (d && d.type === 'close') {
        this.closed = true;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    if (out && out[0]) this.ring.readInto(out[0]);
    return !this.closed;
  }
}
registerProcessor(${JSON.stringify(WORKLET_PROCESSOR_NAME)}, MossAudioSourceProcessor);
`;

/** One module registration per context; `addModule` twice would throw. */
const registeredContexts = new WeakSet<AudioContext>();

async function ensureWorkletModule(context: AudioContext): Promise<void> {
  if (registeredContexts.has(context)) return;
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  registeredContexts.add(context);
}

/**
 * Turns a host-delivered grant port into a live `MediaStreamTrack`.
 * @public
 */
export async function createAudioSourceCapture(
  delivery: AudioSourceDelivery,
  opts: CaptureAudioSourcesOptions = {},
): Promise<AudioSourceCapture> {
  const { context, owned } = selectContext(opts.audioContext, (rate) => new AudioContext({ sampleRate: rate }));
  const destination = context.createMediaStreamDestination();
  const track = destination.stream.getAudioTracks()[0];
  const stats: AudioSourceCaptureStats = { framesReceived: 0, overflowDropped: 0, underrunSamples: 0, unknownMessages: 0 };

  let node: AudioWorkletNode | undefined;
  let statsTimer: ReturnType<typeof setInterval> | undefined;

  const session = new CaptureSession({
    forwardFrame: (frame) => node?.port.postMessage(frame, [frame.buffer]),
    teardown: () => {
      if (statsTimer !== undefined) clearInterval(statsTimer);
      statsTimer = undefined;
      node?.port.postMessage({ type: 'close' });
      node?.disconnect();
      node = undefined;
      track.stop();
      if (owned) void context.close();
    },
    postToHost: (message) => delivery.port.postMessage(message),
    closePort: () => delivery.port.close(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  const capture: AudioSourceCapture = {
    track,
    label: delivery.label,
    canExcludeSelf: delivery.canExcludeSelf,
    stats,
    stop: () => session.stop(),
  };
  session.onended = () => capture.onended?.();

  // Frames may arrive while the module loads; the session queues them.
  delivery.port.onmessage = (e) => session.handlePortMessage(e.data);
  delivery.port.start();

  await ensureWorkletModule(context);
  if (session.state !== 'starting') return capture;

  node = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  node.port.onmessage = (e) => {
    const d = e.data as { type?: unknown; written?: number; overflowDropped?: number; underrunSamples?: number };
    if (d && d.type === 'stats') {
      stats.overflowDropped = d.overflowDropped ?? 0;
      stats.underrunSamples = d.underrunSamples ?? 0;
    }
  };
  node.connect(destination);
  statsTimer = setInterval(() => {
    const s = session.stats();
    stats.framesReceived = s.framesReceived;
    stats.unknownMessages = s.unknownMessages;
    node?.port.postMessage({ type: 'stats' });
  }, STATS_INTERVAL_MS);
  session.ready();
  return capture;
}
```

In `libs/api/src/api.ts`:
- add `import type { AudioSourceCapture, CaptureAudioSourcesOptions } from './audio-source-capture.js';`
- in `WeaveServices`, directly after `userSelectScreen`:
```ts
  /**
   * Asks the host for audio playing on the user's machine. The host shows its
   * own picker. Resolves `null` when the user declines or the host cannot
   * capture. Absent on hosts without the feature — feature-detect with
   * `client.captureAudioSources?.`.
   */
  captureAudioSources?: (opts?: CaptureAudioSourcesOptions) => Promise<AudioSourceCapture | null>;
```
- in `class WeaveClient`, directly after the `userSelectScreen = …` line:
```ts
  /** Present only when the host offers audio-source capture. */
  captureAudioSources?: (opts?: CaptureAudioSourcesOptions) => Promise<AudioSourceCapture | null>;
```
- in `static async connect(...)`, after the client instance is constructed and before it is returned (read the method: find where `new WeaveClient(...)` is assigned), add:
```ts
    const hostCapture = window.__WEAVE_API__.captureAudioSources;
    if (hostCapture) client.captureAudioSources = (opts) => hostCapture(opts);
```
  (use the actual variable name the method uses for the instance).

`libs/api/src/index.ts`: add `export * from './audio-source-capture.js';`, `export * from './capture-session.js';`, `export * from './pcm-ring.js';`.

- [ ] **Step 4: Run the tests, build, typecheck**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn test:unit libs/api/src
nix develop -c yarn build:api && nix develop -c yarn typecheck && nix develop -c yarn test:unit
```
Expected: all green. If `new Function(...)(WORKLET_SOURCE)` fails because `PcmRing.toString()` under vitest's transform differs from the `tsc` build (vitest uses esbuild), the assertions still hold on the transformed source — both are class expressions; report what the string looked like if not.

- [ ] **Step 5: Commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git add libs/api/src/audio-source-capture.ts libs/api/src/audio-source-capture.test.ts libs/api/src/api.ts libs/api/src/index.ts
git commit -m "feat(api): captureAudioSources — a host-granted MediaStreamTrack over an AudioWorklet ring

createAudioSourceCapture turns the host's grant port into a live track: a
worklet module assembled from PcmRing's own source, a CaptureSession owning
the port protocol, and a MediaStreamAudioDestinationNode. WeaveServices and
WeaveClient gain the optional captureAudioSources so Tools feature-detect."
```

---

### Task 4: The applet iframe — port-aware reply and `captureAudioSources`

**Files:**
- Modify: `iframes/applet-iframe/src/index.ts`

**Interfaces:**
- Consumes: `createAudioSourceCapture`, `CaptureAudioSourcesOptions`, `AudioSourceCapture` from `@theweave/api` (Task 3; the iframe workspace resolves the package from `libs/api/dist`).
- Produces: `postMessageWithPorts(request): Promise<{ result: any; ports: readonly MessagePort[] }>`; `postMessage(request)` delegates to it; `weaveApi.captureAudioSources`.

- [ ] **Step 1: Refactor the reply path to keep the ports (one implementation)**

In `iframes/applet-iframe/src/index.ts`, replace the `postMessage` function with:
```ts
/**
 * Sends a request to the host and resolves with the reply and any ports the
 * host transferred alongside it. Every request goes through here; only
 * `request-audio-sources` carries a port today.
 */
async function postMessageWithPorts(
  request: AppletToParentRequest,
): Promise<{ result: any; ports: readonly MessagePort[] }> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();

    const message: AppletToParentMessage = {
      request,
      source: window.__WEAVE_IFRAME_KIND__,
    };

    // eslint-disable-next-line no-restricted-globals
    try {
      top!.postMessage(message, '*', [channel.port2]);
    } catch (e: any) {
      if (e.toString) {
        console.error(
          'Invalid iframe message format. Please check the format of the payload of your request. Your request:',
          request,
          '\n\nError:\n',
          e,
        );
      } else {
        console.error('Failed to send postMessage to Moss: ', e);
      }
    }

    channel.port1.onmessage = (m) => {
      if (m.data.type === 'success') {
        resolve({ result: m.data.result, ports: m.ports });
      } else if (m.data.type === 'error') {
        reject(m.data.error);
      }
    };
  });
}

/** Send a message to Parent */
async function postMessage(request: AppletToParentRequest): Promise<any> {
  return (await postMessageWithPorts(request)).result;
}
```
(keep the existing comment lines that were in the original body if the diff tool prefers; the observable behaviour of `postMessage` is unchanged.)

- [ ] **Step 2: Implement `captureAudioSources` on the iframe's `weaveApi`**

Add to the imports from `@theweave/api`: `createAudioSourceCapture`, `CaptureAudioSourcesOptions`, `AudioSourceCapture`. In the `weaveApi: WeaveServices` object, directly after `userSelectScreen`:
```ts
  captureAudioSources: async (opts?: CaptureAudioSourcesOptions): Promise<AudioSourceCapture | null> => {
    const { result, ports } = await postMessageWithPorts({ type: 'request-audio-sources' });
    if (!result) return null;
    const port = ports[0];
    if (!port) throw new Error('The host granted audio sources but transferred no port.');
    return createAudioSourceCapture(
      { label: result.label, canExcludeSelf: result.canExcludeSelf, port },
      opts,
    );
  },
```

- [ ] **Step 3: Build, typecheck, unit suite**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn build:api && nix develop -c yarn build:applet-iframe && nix develop -c yarn typecheck && nix develop -c yarn test:unit
```
Expected: green.

- [ ] **Step 4: Live round trip from a Tool**

Run `nix develop -c yarn applet-dev-example-1` (with the environment recipe recorded in Plan 2's Task 6 report: `env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE`, the `holochain-v0.7.0` exec bit, `--remote-debugging-port=9222` and CDP; kill by PID afterwards). In the example applet's iframe context:
```js
const client = await (await import('@theweave/api')).WeaveClient.connect(); // or use the already-connected client the example exposes
typeof client.captureAudioSources                                  // 'function'
const c = await client.captureAudioSources();                      // picker opens; Share the system row
c.track.readyState; c.label; c.canExcludeSelf;                     // 'live', 'System audio', true
const ac = new AudioContext({ sampleRate: 48000 });
const an = ac.createAnalyser(); ac.createMediaStreamSource(new MediaStream([c.track])).connect(an);
const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf); Math.max(...buf)  // > 0.01 while a tone plays (start `speaker-test -t sine -f 1000` as a separate process)
c.stats                                                            // framesReceived climbing, overflowDropped 0, underrunSamples small
c.onended = () => console.log('ended');
```
Then press Stop on the Moss chip → the iframe logs `ended` and `c.track.readyState === 'ended'`. Request again and call `c.stop()` → `readyState 'ended'`, no `ended` log, the chip disappears. Cancel the picker → `null`. If `client.captureAudioSources` is not a function, the connect-time feature detection is wrong — fix before proceeding. Record every observed value.

- [ ] **Step 5: Commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
git add iframes/applet-iframe/src/index.ts
git commit -m "feat(applet-iframe): captureAudioSources over a port-aware host reply"
```

---

### Task 5: Version, docs, and the publish hand-off

**Files:**
- Modify: `libs/api/package.json` (version), `libs/api/README.md`, `docs/api-reference/api/*.md` (regenerated)

- [ ] **Step 1: Bump and document**

`libs/api/package.json`: `"version": "0.7.0-dev.4"`. In `libs/api/README.md`, add a section after the existing feature list:
```markdown
### Capturing system audio (Moss 0.16+)

A Tool can ask the host for audio playing on the user's machine — music, a
video, another app. The host shows its own picker; the Tool never sees the
list of applications.

```ts
const capture = await weaveClient.captureAudioSources?.({ audioContext: myContext });
if (!capture) return; // host lacks the feature, or the user declined
myMixer.connect(capture.track); // a live mono 48 kHz MediaStreamTrack
capture.onended = () => myMixer.disconnect(); // the host or the user ended it
// later:
capture.stop();
```

`captureAudioSources` is absent on hosts without the feature — feature-detect
it. `capture.canExcludeSelf` is `false` when the host could not exclude its
own playback; tell the user echo is possible. `capture.stats` carries frame
and buffer counters for diagnostics.
```

- [ ] **Step 2: Regenerate the API reference**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn build:api && nix develop -c yarn build:api-docs
git status --short docs/api-reference | head
ls docs/api-reference/api | grep -i "captureaudiosources\|audiosourcecapture"
```
Expected: new pages for `WeaveServices.captureAudioSources`, `WeaveClient.captureAudioSources`, `AudioSourceCapture`, `createAudioSourceCapture`, `selectContext`, `PcmRing`, `CaptureSession`. If api-extractor reports a warning about an undocumented export, add the missing `@public` doc comment rather than suppressing.

- [ ] **Step 3: Pack dry-run and the owner's publish command**

```bash
cd /home/eric/code/metacurrency/holochain/moss/libs/api
nix develop -c npm pack --dry-run 2>&1 | tail -15
npm view @theweave/api dist-tags --json
```
Expected: the tarball lists `dist/index.js`, `dist/audio-source-capture.js`, `dist/capture-session.js`, `dist/pcm-ring.js` and their `.d.ts`, and NO `*.test.*` files. Record the current dist-tags. The publish itself is the owner's step (npm OTP); the command is:
```bash
cd /home/eric/code/metacurrency/holochain/moss/libs/api && nix develop -c npm publish --tag <the tag 0.7.0-dev.3 carries>
```
Do NOT run it from the plan. Plan 4's first task verifies `npm view @theweave/api@0.7.0-dev.4 version` before pinning.

- [ ] **Step 4: Gate and commit**

```bash
cd /home/eric/code/metacurrency/holochain/moss
nix develop -c yarn typecheck && nix develop -c yarn test:unit
git add libs/api/package.json libs/api/README.md docs/api-reference
git commit -m "chore(api): bump @theweave/api to 0.7.0-dev.4; document captureAudioSources; regenerate the API reference"
```

---

## Self-review

**Spec coverage (Section 3):** `AudioSourceCapture { track, label, canExcludeSelf, stop(), onended? }` → Task 3 ✔; optional `captureAudioSources?` on `WeaveServices`, headless leaves it undefined → Task 3 (no Moss change needed; `buildHeadlessWeaveClient` returns `WeaveServices` and simply omits the optional member) ✔; implementation in `libs/api/src/audio-source-capture.ts`: sends the request (via the iframe, Task 4 — the api package itself cannot post to the host; the split is declared in the plan header), `null` → `null`, worklet from a Blob URL inline string, 200 ms ring drop-oldest/zero-fill with counters exposed → Tasks 1 and 3 ✔; context = `opts.audioContext` else private 48 kHz → Task 3 `selectContext` (with the 48 kHz-only refinement declared in Global Constraints) ✔; `ended`/close → stop worklet, `track.stop()`, fire `onended`; `stop()` posts `{type:'close'}` and closes the port → Task 2 ✔; pure ring module table-tested in node, worklet glue covered by Presence's harness (Plan 4) ✔. Error handling: worklet under/overrun counters only, no teardown ✔. Publishing as `0.7.0-dev.4` → Task 5 (owner executes the publish) ✔.

**Placeholder scan:** none; Task 3 Step 3's "use the actual variable name the method uses for the instance" is a lookup in `connect()`, not a placeholder.

**Type consistency:** `PcmRing.writeInt16/readInto/stats/available` (Task 1) match the worklet string (Task 3) and the embedding test; `CaptureSession` bindings (Task 2) match the object built in `createAudioSourceCapture` (Task 3); `AudioSourceDelivery { label, canExcludeSelf, port }` (Task 3) is what the iframe builds from the reply (Task 4); `CaptureAudioSourcesOptions` is the one options type across `WeaveServices`, `WeaveClient`, the iframe and the helper.

**Review Focus:** all five pinned (Task 3/2 pre-ready queue; Task 2 stop idempotence; Task 2 unknown-message row + Task 1 length-agnostic ring; Task 2 watchdog; Task 3 `selectContext` table).
