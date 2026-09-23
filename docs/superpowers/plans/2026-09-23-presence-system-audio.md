# Presence System-Audio Mixin Implementation Plan (Plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Presence user chooses "Include audio from…" in the microphone menu, picks sources in Moss's picker, and peers hear that audio mixed into the one outgoing microphone track over both carriers, until the user, the host, or the platform ends it.

**Architecture:** `StreamsStore` gains one injected host seam, `captureAudioSources` (from `WeaveClient.captureAudioSources`, optional — absent on hosts without the feature). Intent gains `mic.includeSystemAudio` with three gestures. `MicSource` learns a mixin: the raw device track and the mixin track feed two `MediaStreamAudioSourceNode`s into one `MediaStreamAudioDestinationNode` in the shared 48 kHz context, and the destination's track becomes the ONE output track every consumer holds; a pure `decideMicOutput` policy says when to build, rebuild, or tear the mix. Swaps go through the existing store-level `onTrackChange` fanout (`replaceTrack` on every peer) and the per-consumer `onTrackChanged` (the voice encoder rebuilds), so the wire contract is unchanged: one audio track, one Opus stream.

**Tech Stack:** TypeScript strict + `noUnusedLocals`/`noUnusedParameters`, Lit, Web Audio, `@theweave/api` `0.7.0-dev.4` (`captureAudioSources` → `AudioSourceCapture { track, label, canExcludeSelf, stop(), onended?, endedReason? }`), Vitest in node with the repo's fakes (`store-deps.testing.ts`, the wiring suite's `FakeTrack`/`FakeStream`/`installNavigator`).

**Spec:** `docs/superpowers/specs/2026-09-22-audio-source-capture-design.md` — Section 4, plus Section 3's "Landed" paragraph (the capture object's real semantics: `stop()` never fires `onended`; `onended` fires once for a host/platform end; a capture may resolve already ended; `track.stop()` fires no `ended` on the local track, so the tear-mix arm is driven from `capture.onended`, never `track.onended`; the context is used only if it runs at 48 kHz — Presence's shared context does).

## Global Constraints

- Work happens in `/home/eric/code/metacurrency/holochain/presence` on the existing branch `feat/include-system-audio` (off `main-0.7`; it carries this feature's docs commits already). Confirm with `git branch --show-current`.
- Every command runs through nix: `cd /home/eric/code/metacurrency/holochain/presence && nix develop -c <command>`. The gate is `nix develop -c npm run verify` (both workspaces' unit suites plus both typechecks at `strict` + `noUnusedLocals`/`noUnusedParameters`); it must be green before every commit. The suite count is never written into `CLAUDE.md` (`claude-md-drift.test.ts` rejects it).
- `@theweave/api` is pinned exactly at `"0.7.0-dev.4"` in `ui/package.json` (`npm view @theweave/api@0.7.0-dev.4 version` verifies it exists on npm — it does, as of 2026-09-23).
- **Intent is written only by `StreamsStore._applyIntent` from user-gesture entry points** (`ui/src/__tests__/intent-write-sites.test.ts` is the authority; it slices the store by method header regexes). The new gesture methods `systemAudioOn`/`systemAudioOff` are added to `ALLOWED_CALL_SITES`; the `system-audio-ended` write lives inside `systemAudioOn`'s method body (the capture's `onended` closure), exactly as `screen-share-track-ended` lives inside `screenShareOn` — one more documented gesture-equivalent, and the reason is written in `intent.ts`'s header.
- **One authority per concept**: `decideMicOutput` (`ui/src/mic-output-policy.ts`) is the only place that decides the output track's shape; `MicSource._installOutputTrack` is the only place that swaps the output; the store's `_onMicTrackChange` remains the only peer fanout. No parallel path.
- **No ambient clock**: `mic-output-policy.ts` joins `no-ambient-clock.test.ts`'s pinned list with `FULL_PATTERNS`; it takes no time at all.
- Declared behaviour (spec Section 4): mute silences the whole output track (one `enabled` flag); the menu row is disabled with title "Turn your microphone on first" while `!localIntent.mic.wanted`; a device change or reopen while mixed rebuilds only the device source node — consumers never see the output track change for that; the host ending the grant is delivered as intent `system-audio-ended`.
- Declared out of scope (spec non-goals): sharing without the mic held, persisting grants, per-source volume.
- Logging: one new taxonomy member `SystemAudioEnded: 'emitted'` (`ui/src/logging.ts`; `event-taxonomy.test.ts` greps for the literal `event: 'SystemAudioEnded'`, so the emission site keeps the literal on the `event:` line). Gesture writes are already logged as `IntentChange: <type>` by `_applyIntent`.
- Presence CLAUDE.md working agreements bind: replace-or-declare, no new threshold without a named predicate (this plan adds none), prose cites code, exhaustive `switch` over unions, every important fake gets a negative control, adversarial review per task (agreement 9), no co-author trailers, no exclamation marks in reports.
- Real audio-graph behaviour (the mixin audible to a peer over WebRTC and over the signals voice carrier; no echo of the peer's voice) is harness/manual territory by the spec: Task 6 records the manual checklist and the `mic-source.ts` header says so.

## Review Focus

Five inputs the spec implies but no task's tests exercise — each pinned in the owning task:

1. **The host ends the grant while the mic device is being reopened** (a device died, the reconciler is mid-`_openAndSwap`): the tear must not race the rebuild into a dangling source node — Task 3, the "tear while a swap is pending" row (setMixin(null) during an in-flight `_openAndSwap`; the swap completes on the device path).
2. **`captureAudioSources` resolves already ended** (spec Section 3 "Landed"): `track.readyState === 'ended'` on arrival must not be installed as a mixin — Task 4, the "already-ended capture" wiring row (no mix built, intent not set, capture ignored).
3. **The user turns the mic off while system audio is included** (`audioOff` = mute, device stays wanted): the mix must stay built and muted, and turning the mic back on must un-mute the mixed output — Task 3 mute rows; Task 4 wiring row.
4. **A second `systemAudioOn()` while one is active** (double click): no second picker, no second capture — Task 4, the guard row.
5. **`ensureAudioContext()` returns null** (no Web Audio): the mixin is refused and the device track keeps flowing — Task 3, the "no context" row.

---

## File structure

| Path | Responsibility |
|---|---|
| `ui/package.json` | `@theweave/api` → `0.7.0-dev.4` |
| `ui/src/intent.ts` | `mic.includeSystemAudio`; gestures `system-audio-on/off/ended`; `session-end` clears it |
| `ui/src/__tests__/intent.test.ts` (+ literal updates in `intent-diff-policy.test.ts`, `intent-diff-surfaces.test.ts`, `streams-store-wiring.test.ts`) | rows for the three gestures; the `mic` shape everywhere |
| `ui/src/mic-output-policy.ts` (new) + `ui/src/__tests__/mic-output-policy.test.ts` | `decideMicOutput` — pure, table-tested |
| `ui/src/__tests__/no-ambient-clock.test.ts` | pin `mic-output-policy.ts` |
| `ui/src/mic-source.ts` | `_deviceTrack`/`_outputTrack`, the mix graph, `setMixin`, `_installOutputTrack`, mute over both, device-swap-while-mixed |
| `ui/src/__tests__/mic-source-mixin.test.ts` (new) | node tests with fake navigator/`MediaStream`/`AudioContext` |
| `ui/src/streams-store.ts` | seam + `canCaptureAudioSources`, `systemAudioOn/Off`, `systemAudio` readable, `SystemAudioEnded` emission, teardown |
| `ui/src/logging.ts` | `SystemAudioEnded` in the union and the taxonomy |
| `ui/src/__tests__/intent-write-sites.test.ts` | allow-list entries |
| `ui/src/__tests__/streams-store-wiring.test.ts` | the system-audio wiring block |
| `ui/src/room/room-container.ts` | injects `weaveClient.captureAudioSources` |
| `ui/src/room/room-view.ts` | the menu row, `_systemAudio` subscriber |
| `ui/src/__tests__/view-teardown-symmetry.test.ts` | the `_systemAudio` subscriber pin |
| `CLAUDE.md` ("True today"), spec Section 4 "Landed" | docs sync |

---

### Task 1: `@theweave/api` 0.7.0-dev.4 and the intent extension

**Files:**
- Modify: `ui/package.json`, `package-lock.json` (via install)
- Modify: `ui/src/intent.ts`
- Modify: `ui/src/__tests__/intent.test.ts`, `ui/src/__tests__/intent-diff-policy.test.ts`, `ui/src/__tests__/intent-diff-surfaces.test.ts`, `ui/src/__tests__/streams-store-wiring.test.ts` (only the `LocalIntent` literals, `mic: { wanted, muted }` → `mic: { wanted, muted, includeSystemAudio: false }`)

**Interfaces:**
- Produces: `LocalIntent.mic: { wanted: boolean; muted: boolean; includeSystemAudio: boolean }`; gestures `{ type: 'system-audio-on' } | { type: 'system-audio-off' } | { type: 'system-audio-ended' }`; the api types `AudioSourceCapture`, `CaptureAudioSourcesOptions` importable from `@theweave/api`.

- [ ] **Step 1: Bump the api and confirm the surface**

```bash
cd /home/eric/code/metacurrency/holochain/presence
npm view @theweave/api@0.7.0-dev.4 version
sed -i 's/"@theweave\/api": "0.7.0-dev.1"/"@theweave\/api": "0.7.0-dev.4"/' ui/package.json
nix develop -c npm install
grep -n "captureAudioSources" ui/node_modules/@theweave/api/dist/api.d.ts | head -3
nix develop -c npm run typecheck
```
Expected: `0.7.0-dev.4`; the grep shows the optional member on `WeaveServices` and `WeaveClient`; typecheck green (dev.2 removed the unimplemented block-view surface — Presence does not use it; if typecheck reports a removed api symbol, report BLOCKED with the errors rather than patching around it).

- [ ] **Step 2: Write the failing intent tests**

In `ui/src/__tests__/intent.test.ts`, change `INITIAL` to
```ts
const INITIAL: LocalIntent = {
  mic: { wanted: false, muted: true, includeSystemAudio: false },
  camera: { wanted: false },
  screenShare: { wanted: false },
  webrtc: { enabled: true, disabledWith: new Set() },
};
```
update the existing `audio-on`/`audio-mute` rows' expected `mic` objects to carry `includeSystemAudio: false`, and add rows to the initial-state table:
```ts
    ['system-audio-on', { type: 'system-audio-on' }, { mic: { wanted: false, muted: true, includeSystemAudio: true } }],
    ['system-audio-off', { type: 'system-audio-off' }, { mic: { wanted: false, muted: true, includeSystemAudio: false } }],
    ['system-audio-ended', { type: 'system-audio-ended' }, { mic: { wanted: false, muted: true, includeSystemAudio: false } }],
```
and a new describe:
```ts
describe('system audio rides the mic: what clears it and what does not', () => {
  const included: LocalIntent = {
    ...INITIAL,
    mic: { wanted: true, muted: false, includeSystemAudio: true },
  };

  it('audio-mute keeps includeSystemAudio (mute silences the mixed track, it does not end the share)', () => {
    expect(applyIntentGesture(included, { type: 'audio-mute' }).mic).toEqual({
      wanted: true,
      muted: true,
      includeSystemAudio: true,
    });
  });

  it('audio-on keeps includeSystemAudio', () => {
    expect(applyIntentGesture(included, { type: 'audio-on' }).mic.includeSystemAudio).toBe(true);
  });

  it('system-audio-off and system-audio-ended both clear it and touch nothing else', () => {
    for (const type of ['system-audio-off', 'system-audio-ended'] as const) {
      expect(applyIntentGesture(included, { type }).mic).toEqual({
        wanted: true,
        muted: false,
        includeSystemAudio: false,
      });
    }
  });

  it('session-end clears it along with the other wants', () => {
    const next = applyIntentGesture(included, { type: 'session-end' });
    expect(next.mic).toEqual({ wanted: false, muted: false, includeSystemAudio: false });
  });

  it('initialLocalIntent starts with includeSystemAudio false', () => {
    expect(initialLocalIntent({ getItem: () => null }).mic.includeSystemAudio).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /home/eric/code/metacurrency/holochain/presence && nix develop -c npx vitest run ui/src/__tests__/intent.test.ts`
Expected: typecheck-level failures inside vitest are not reported (esbuild strips types) — the rows FAIL on `toEqual` (`includeSystemAudio` undefined vs false/true) and the gesture rows fail on the `default` arm returning the input unchanged.

- [ ] **Step 4: Extend `intent.ts`**

In `ui/src/intent.ts`:
- header: after the sentence about `screen-share-track-ended`, add: `A second gesture-equivalent exists for the same reason: 'system-audio-ended' — the host (Moss) or the platform ending a system-audio grant is delivered to the store as the capture's onended callback, which is the user's or the OS's action, not ours; the store writes that intent from inside systemAudioOn's method body, where the callback is installed.`
- `LocalIntent`: `mic: { wanted: boolean; muted: boolean; includeSystemAudio: boolean };` with the field comment: `includeSystemAudio: the user asked for audio playing on the machine to ride the mic track (spec Section 4); mute does not clear it, session-end does.`
- `IntentGesture`: add
```ts
  | { type: 'system-audio-on' }          // fires only after the host's picker succeeds
  | { type: 'system-audio-off' }         // menu row
  | { type: 'system-audio-ended' }       // gesture-equivalent (see header): host/platform ended the grant
```
- `applyIntentGesture`: `audio-on` → `{ ...intent, mic: { ...intent.mic, wanted: true, muted: false } }`; `audio-mute` → `{ ...intent, mic: { ...intent.mic, muted: true } }` (keeps `wanted` and `includeSystemAudio` — update the existing comment: it already says the device stays wanted; add "and an included system-audio share stays included: mute silences the mixed track as a whole"); new arms:
```ts
    case 'system-audio-on':
      return { ...intent, mic: { ...intent.mic, includeSystemAudio: true } };
    case 'system-audio-off':
    case 'system-audio-ended':
      return { ...intent, mic: { ...intent.mic, includeSystemAudio: false } };
```
  `session-end` → `mic: { wanted: false, muted: intent.mic.muted, includeSystemAudio: false }`.
- `initialLocalIntent`: `mic: { wanted: false, muted: true, includeSystemAudio: false }`.

Then fix every `LocalIntent` literal the typecheck reports (the four test files listed above) by adding `includeSystemAudio: false`.

- [ ] **Step 5: Verify and commit**

```bash
cd /home/eric/code/metacurrency/holochain/presence
nix develop -c npm run verify
git add ui/package.json package-lock.json ui/src/intent.ts ui/src/__tests__/intent.test.ts ui/src/__tests__/intent-diff-policy.test.ts ui/src/__tests__/intent-diff-surfaces.test.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "feat(intent): includeSystemAudio on the mic intent; pin @theweave/api 0.7.0-dev.4

Three gestures: system-audio-on (after the host picker), system-audio-off
(menu row), system-audio-ended (the host or platform ending the grant,
delivered as the capture's onended — the second documented
gesture-equivalent). Mute keeps the share included; session-end clears it."
```

---

### Task 2: `decideMicOutput` — the one decision about the output track

**Files:**
- Create: `ui/src/mic-output-policy.ts`, `ui/src/__tests__/mic-output-policy.test.ts`
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts` (pin)

**Interfaces:**
- Produces:
```ts
export type MicOutputMode = 'device' | 'mixed';
export type MicOutputInput = {
  /** The raw device track, or null when no device is open. */
  device: MediaStreamTrack | null;
  /** The mixin track the user asked to include, or null. */
  mixin: MediaStreamTrack | null;
  /** What the output currently is, and (when mixed) which two tracks the graph was built from. */
  current: { mode: 'device' } | { mode: 'mixed'; device: MediaStreamTrack; mixin: MediaStreamTrack } | null;
};
export type MicOutputDecision =
  | { kind: 'use-device'; reason: 'device-only' }
  | { kind: 'build-mix'; reason: 'mixin-added' | 'device-changed' | 'mixin-changed' }
  | { kind: 'tear-mix'; reason: 'mixin-removed' | 'mixin-ended' | 'device-closed' }
  | { kind: 'none'; reason: 'no-device' | 'already-device' | 'already-mixed' };
export function decideMicOutput(input: MicOutputInput): MicOutputDecision;
export function isUsableMixin(track: MediaStreamTrack | null): track is MediaStreamTrack; // non-null and readyState === 'live'
```

- [ ] **Step 1: Write the failing test**

`ui/src/__tests__/mic-output-policy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { decideMicOutput, isUsableMixin, type MicOutputInput } from '../mic-output-policy';

/** Identity is all the policy reads; readyState only for the mixin. */
const track = (readyState: 'live' | 'ended' = 'live') =>
  ({ readyState } as unknown as MediaStreamTrack);

describe('decideMicOutput', () => {
  const dev = track();
  const dev2 = track();
  const mix = track();
  const mix2 = track();

  const rows: Array<[string, MicOutputInput, ReturnType<typeof decideMicOutput>]> = [
    ['no device, nothing current', { device: null, mixin: null, current: null }, { kind: 'none', reason: 'no-device' }],
    ['no device but a mixin: v1 needs the mic held', { device: null, mixin: mix, current: null }, { kind: 'none', reason: 'no-device' }],
    ['device closed while mixed', { device: null, mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'tear-mix', reason: 'device-closed' }],
    ['device opened, no mixin', { device: dev, mixin: null, current: null }, { kind: 'use-device', reason: 'device-only' }],
    ['device only, already on device', { device: dev, mixin: null, current: { mode: 'device' } }, { kind: 'none', reason: 'already-device' }],
    ['mixin arrives on a device-only output', { device: dev, mixin: mix, current: { mode: 'device' } }, { kind: 'build-mix', reason: 'mixin-added' }],
    ['mixin arrives before any output exists', { device: dev, mixin: mix, current: null }, { kind: 'build-mix', reason: 'mixin-added' }],
    ['same device, same mixin, already mixed', { device: dev, mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'none', reason: 'already-mixed' }],
    ['device changed under a mix', { device: dev2, mixin: mix, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'build-mix', reason: 'device-changed' }],
    ['mixin changed under a mix', { device: dev, mixin: mix2, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'build-mix', reason: 'mixin-changed' }],
    ['mixin removed', { device: dev, mixin: null, current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'tear-mix', reason: 'mixin-removed' }],
    ['mixin ended (the host or platform stopped it)', { device: dev, mixin: track('ended'), current: { mode: 'mixed', device: dev, mixin: mix } }, { kind: 'tear-mix', reason: 'mixin-ended' }],
    ['an ended mixin offered to a device-only output is ignored', { device: dev, mixin: track('ended'), current: { mode: 'device' } }, { kind: 'none', reason: 'already-device' }],
  ];

  it.each(rows)('%s', (_name, input, expected) => {
    expect(decideMicOutput(input)).toEqual(expected);
  });
});

describe('isUsableMixin', () => {
  it('null → false, ended → false, live → true', () => {
    expect(isUsableMixin(null)).toBe(false);
    expect(isUsableMixin(track('ended'))).toBe(false);
    expect(isUsableMixin(track('live'))).toBe(true);
  });
});
```

Add to `no-ambient-clock.test.ts`'s pinned list, after the `capture-reconciler.ts` entry:
```ts
  // System-audio mixin (spec Section 4): the output-track decision takes
  // no time at all — identity and readyState only.
  { relPath: '../mic-output-policy.ts', patterns: FULL_PATTERNS },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/eric/code/metacurrency/holochain/presence && nix develop -c npx vitest run ui/src/__tests__/mic-output-policy.test.ts ui/src/__tests__/no-ambient-clock.test.ts`
Expected: the policy test fails to import; the clock pin fails on the missing file.

- [ ] **Step 3: Write the policy**

`ui/src/mic-output-policy.ts`:
```ts
/**
 * decideMicOutput — the ONE decision about what MicSource's output track
 * is (spec Section 4). Plain object in, tagged union out, `reason` on every
 * arm; `media-event-policy.ts` shape. MicSource applies it; nothing else
 * decides.
 *
 * The output is either the raw device track ('device') or the track of a
 * MediaStreamAudioDestinationNode fed by the device and a mixin ('mixed').
 * v1 requires the mic to be held: a mixin with no device is 'none'.
 */

export type MicOutputMode = 'device' | 'mixed';

export type MicOutputInput = {
  /** The raw device track, or null when no device is open. */
  device: MediaStreamTrack | null;
  /** The mixin track the user asked to include, or null. */
  mixin: MediaStreamTrack | null;
  /** What the output currently is; when mixed, which two tracks the graph was built from. */
  current:
    | { mode: 'device' }
    | { mode: 'mixed'; device: MediaStreamTrack; mixin: MediaStreamTrack }
    | null;
};

export type MicOutputDecision =
  | { kind: 'use-device'; reason: 'device-only' }
  | { kind: 'build-mix'; reason: 'mixin-added' | 'device-changed' | 'mixin-changed' }
  | { kind: 'tear-mix'; reason: 'mixin-removed' | 'mixin-ended' | 'device-closed' }
  | { kind: 'none'; reason: 'no-device' | 'already-device' | 'already-mixed' };

/** A mixin is usable only while live: an ended track would feed silence forever. */
export function isUsableMixin(track: MediaStreamTrack | null): track is MediaStreamTrack {
  return !!track && track.readyState === 'live';
}

export function decideMicOutput(input: MicOutputInput): MicOutputDecision {
  const { device, current } = input;
  const mixinUsable = isUsableMixin(input.mixin);
  const mixinEnded = !!input.mixin && !mixinUsable;

  if (!device) {
    if (current?.mode === 'mixed') return { kind: 'tear-mix', reason: 'device-closed' };
    return { kind: 'none', reason: 'no-device' };
  }

  if (!mixinUsable) {
    if (current?.mode === 'mixed') {
      return { kind: 'tear-mix', reason: mixinEnded ? 'mixin-ended' : 'mixin-removed' };
    }
    if (current?.mode === 'device') return { kind: 'none', reason: 'already-device' };
    return { kind: 'use-device', reason: 'device-only' };
  }

  const mixin = input.mixin as MediaStreamTrack;
  if (current?.mode !== 'mixed') return { kind: 'build-mix', reason: 'mixin-added' };
  if (current.device !== device) return { kind: 'build-mix', reason: 'device-changed' };
  if (current.mixin !== mixin) return { kind: 'build-mix', reason: 'mixin-changed' };
  return { kind: 'none', reason: 'already-mixed' };
}
```

- [ ] **Step 4: Run the tests to verify they pass; commit**

```bash
cd /home/eric/code/metacurrency/holochain/presence
nix develop -c npx vitest run ui/src/__tests__/mic-output-policy.test.ts ui/src/__tests__/no-ambient-clock.test.ts
nix develop -c npm run verify
git add ui/src/mic-output-policy.ts ui/src/__tests__/mic-output-policy.test.ts ui/src/__tests__/no-ambient-clock.test.ts
git commit -m "feat(mic): decideMicOutput, the one decision about the microphone output track"
```

---

### Task 3: The `MicSource` mixin

**Files:**
- Modify: `ui/src/mic-source.ts`
- Create: `ui/src/__tests__/mic-source-mixin.test.ts`

**Interfaces:**
- Consumes: `decideMicOutput`, `isUsableMixin` (Task 2).
- Produces on `MicSource`: `setMixin(track: MediaStreamTrack | null): boolean` (true iff the output now includes the mixin); `get track(): MediaStreamTrack | null` now returns the OUTPUT track (device or mixed — what consumers hold); `get deviceTrack(): MediaStreamTrack | null` (the raw device track; the reconciler and the lifecycle are about this one); `get outputMode(): MicOutputMode | null`. `acquire()` hands out the output track. Existing bindings unchanged.

- [ ] **Step 1: Write the failing tests**

`ui/src/__tests__/mic-source-mixin.test.ts` (the fakes mirror `capture-lifecycle.test.ts`'s `FakeTrack`/`FakeStream` and the wiring suite's `installNavigator`; read both before writing):
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MicSource } from '../mic-source';
import type { MicSourceBindings } from '../mic-source';
import { ManualClock } from '../clock.testing';

class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  onended: (() => void) | null = null;
  constructor(public kind: 'audio' | 'video', public label = '') {}
  stop(): void {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.onended?.();
  }
}
class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}
/** `new MediaStream([track])` as the mix graph builds its source streams. */
class FakeMediaStream extends FakeStream {
  constructor(tracks: FakeTrack[] = []) { super(tracks); }
}

/** Counts graph operations; a source node remembers the stream it wraps. */
class FakeAudioContext {
  readonly sampleRate = 48000;
  state = 'running';
  sources: Array<{ stream: FakeStream; connected: boolean }> = [];
  destinations: Array<{ track: FakeTrack }> = [];
  createMediaStreamSource(stream: FakeStream) {
    const node = { stream, connected: false, connect: () => { node.connected = true; }, disconnect: () => { node.connected = false; } };
    this.sources.push(node);
    return node;
  }
  createMediaStreamDestination() {
    const track = new FakeTrack('audio', 'mixed');
    this.destinations.push({ track });
    return { stream: new FakeStream([track]) };
  }
  resume = async () => {};
  close = async () => {};
}

function installGlobals(respond: () => Promise<FakeStream>) {
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async (c: unknown) => { calls.push(c); return respond(); } } },
    configurable: true,
    writable: true,
  });
  (globalThis as any).MediaStream = FakeMediaStream;
  (globalThis as any).AudioContext = FakeAudioContext;
  return { calls };
}

function rig() {
  const clock = new ManualClock(1_000);
  const fanout: Array<{ newTrack: unknown; oldTrack: unknown }> = [];
  let deviceId: string | undefined;
  const bindings: MicSourceBindings = {
    getDeviceId: () => deviceId,
    setDeviceId: id => { deviceId = id; },
    onTrackChange: (n, o) => void fanout.push({ newTrack: n, oldTrack: o }),
    onMutedChange: () => {},
    onLifecycleChange: () => {},
    now: () => clock.now(),
  };
  const mic = new MicSource(bindings);
  return { mic, fanout, clock };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).navigator;
  delete (globalThis as any).MediaStream;
  delete (globalThis as any).AudioContext;
});

describe('MicSource mixin: build, tear, and what consumers see', () => {
  let device: FakeTrack;
  beforeEach(() => {
    device = new FakeTrack('audio', 'device');
    installGlobals(async () => new FakeStream([device]));
  });

  it('setMixin builds the mix: the output is the destination track, consumers and the store fanout see ONE swap', async () => {
    const r = rig();
    const consumerSwaps: unknown[] = [];
    const handle = await r.mic.acquire({ id: 'c', onTrackChanged: t => void consumerSwaps.push(t) });
    expect(handle!.track).toBe(device as unknown as MediaStreamTrack);
    r.fanout.length = 0;

    const mixin = new FakeTrack('audio', 'system');
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(true);

    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    expect(ctx.sources.map(s => s.stream.getAudioTracks()[0])).toEqual([device, mixin]);
    expect(ctx.sources.every(s => s.connected)).toBe(true);
    const mixed = ctx.destinations[0].track;
    expect(r.mic.track).toBe(mixed as unknown as MediaStreamTrack);
    expect(r.mic.deviceTrack).toBe(device as unknown as MediaStreamTrack);
    expect(r.mic.outputMode).toBe('mixed');
    expect(r.fanout).toEqual([{ newTrack: mixed, oldTrack: device }]);
    expect(consumerSwaps).toEqual([mixed]);
    expect(device.readyState).toBe('live'); // the device keeps feeding the graph
  });

  it('setMixin(null) tears the mix back to the device track with one swap; the destination track is stopped', async () => {
    const r = rig();
    const consumerSwaps: unknown[] = [];
    await r.mic.acquire({ id: 'c', onTrackChanged: t => void consumerSwaps.push(t) });
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const mixed = ctx.destinations[0].track;
    r.fanout.length = 0; consumerSwaps.length = 0;

    expect(r.mic.setMixin(null)).toBe(false);
    expect(r.mic.track).toBe(device as unknown as MediaStreamTrack);
    expect(r.mic.outputMode).toBe('device');
    expect(r.fanout).toEqual([{ newTrack: device, oldTrack: mixed }]);
    expect(consumerSwaps).toEqual([device]);
    expect(ctx.sources.every(s => !s.connected)).toBe(true);
    expect(mixed.readyState).toBe('ended');
    expect(mixin.readyState).toBe('live'); // the mixin belongs to the caller (the capture object stops it)
  });

  it('an ended mixin is refused (negative control for the ended arm)', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    const mixin = new FakeTrack('audio', 'system');
    mixin.stop();
    r.fanout.length = 0;
    expect(r.mic.setMixin(mixin as unknown as MediaStreamTrack)).toBe(false);
    expect(r.mic.outputMode).toBe('device');
    expect(r.fanout).toEqual([]);
  });

  it('no AudioContext → the mixin is refused and the device track keeps flowing (Review Focus 5)', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    delete (globalThis as any).AudioContext;
    r.fanout.length = 0;
    expect(r.mic.setMixin(new FakeTrack('audio') as unknown as MediaStreamTrack)).toBe(false);
    expect(r.mic.track).toBe(device as unknown as MediaStreamTrack);
    expect(r.fanout).toEqual([]);
  });

  it('mute writes enabled on the output AND the device; unmute restores both (Review Focus 3)', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    const mixin = new FakeTrack('audio', 'system');
    r.mic.setMixin(mixin as unknown as MediaStreamTrack);
    const mixed = ((r.mic.ensureAudioContext() as unknown) as FakeAudioContext).destinations[0].track;
    r.mic.setMuted(true);
    expect(mixed.enabled).toBe(false);
    expect(device.enabled).toBe(false);
    r.mic.setMuted(false);
    expect(mixed.enabled).toBe(true);
    expect(device.enabled).toBe(true);
  });

  it('a mixin installed while muted starts muted', async () => {
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    r.mic.setMuted(true);
    r.mic.setMixin(new FakeTrack('audio') as unknown as MediaStreamTrack);
    const mixed = ((r.mic.ensureAudioContext() as unknown) as FakeAudioContext).destinations[0].track;
    expect(mixed.enabled).toBe(false);
  });
});

describe('MicSource mixin: device swaps and close', () => {
  it('a device change while mixed rebuilds only the device source; the output track and consumers are untouched', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let n = 0;
    installGlobals(async () => new FakeStream([[device1, device2][n++]!]));
    const r = rig();
    const consumerSwaps: unknown[] = [];
    await r.mic.acquire({ id: 'c', onTrackChanged: t => void consumerSwaps.push(t) });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const mixed = ctx.destinations[0].track;
    r.fanout.length = 0; consumerSwaps.length = 0;

    await r.mic.changeDevice('other');

    expect(r.mic.deviceTrack).toBe(device2 as unknown as MediaStreamTrack);
    expect(r.mic.track).toBe(mixed as unknown as MediaStreamTrack);
    expect(ctx.destinations).toHaveLength(1); // same destination, same output track
    expect(ctx.sources.filter(s => s.connected).map(s => s.stream.getAudioTracks()[0])).toEqual(expect.arrayContaining([device2]));
    expect(ctx.sources.find(s => s.stream.getAudioTracks()[0] === device1)!.connected).toBe(false);
    expect(device1.readyState).toBe('ended');
    expect(r.fanout).toEqual([]);
    expect(consumerSwaps).toEqual([]);
  });

  it('a reopen after the device died while mixed also keeps the output (the reconciler path)', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let n = 0;
    installGlobals(async () => new FakeStream([[device1, device2][n++]!]));
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const mixed = ((r.mic.ensureAudioContext() as unknown) as FakeAudioContext).destinations[0].track;
    device1.stop();
    expect(r.mic.lifecycle.state).toBe('ended');
    r.fanout.length = 0;
    expect(await r.mic.reopen()).toBe(true);
    expect(r.mic.deviceTrack).toBe(device2 as unknown as MediaStreamTrack);
    expect(r.mic.track).toBe(mixed as unknown as MediaStreamTrack);
    expect(r.fanout).toEqual([]);
  });

  it('tear while a swap is pending: the swap completes on the device path (Review Focus 1)', async () => {
    const device1 = new FakeTrack('audio', 'd1');
    const device2 = new FakeTrack('audio', 'd2');
    let release!: () => void;
    let n = 0;
    installGlobals(() => {
      n += 1;
      if (n === 1) return Promise.resolve(new FakeStream([device1]));
      return new Promise(res => { release = () => res(new FakeStream([device2])); });
    });
    const r = rig();
    await r.mic.acquire({ id: 'c' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const pending = r.mic.changeDevice('other');
    r.mic.setMixin(null); // the host ended the grant mid-swap
    release();
    await pending;
    expect(r.mic.outputMode).toBe('device');
    expect(r.mic.track).toBe(device2 as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    expect(ctx.sources.every(s => !s.connected)).toBe(true);
  });

  it('closing the device while mixed disconnects the graph and fans out the close with the output track', async () => {
    const device = new FakeTrack('audio', 'd');
    installGlobals(async () => new FakeStream([device]));
    const r = rig();
    const h = await r.mic.acquire({ id: 'c' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const ctx = (r.mic.ensureAudioContext() as unknown) as FakeAudioContext;
    const mixed = ctx.destinations[0].track;
    r.fanout.length = 0;
    h!.release();
    expect(r.fanout).toEqual([{ newTrack: null, oldTrack: mixed }]);
    expect(ctx.sources.every(s => !s.connected)).toBe(true);
    expect(mixed.readyState).toBe('ended');
    expect(device.readyState).toBe('ended');
    expect(r.mic.outputMode).toBeNull();
    expect(r.mic.track).toBeNull();
  });

  it('acquire after a mixin was set hands out the mixed output', async () => {
    const device = new FakeTrack('audio', 'd');
    installGlobals(async () => new FakeStream([device]));
    const r = rig();
    await r.mic.acquire({ id: 'a' });
    r.mic.setMixin(new FakeTrack('audio', 'system') as unknown as MediaStreamTrack);
    const mixed = ((r.mic.ensureAudioContext() as unknown) as FakeAudioContext).destinations[0].track;
    const h = await r.mic.acquire({ id: 'b' });
    expect(h!.track).toBe(mixed as unknown as MediaStreamTrack);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/eric/code/metacurrency/holochain/presence && nix develop -c npx vitest run ui/src/__tests__/mic-source-mixin.test.ts`
Expected: FAIL — `setMixin is not a function`, `deviceTrack` undefined.

- [ ] **Step 3: Implement the mixin in `mic-source.ts`**

Changes, in order (keep every existing behaviour; the existing suites `capture-lifecycle.test.ts` and the wiring suite must stay green unmodified):

1. Imports: `import { decideMicOutput, isUsableMixin, type MicOutputMode } from './mic-output-policy';`
2. Header doc: add a paragraph "Mixin (spec Section 4): `setMixin(track)` includes a second audio track (system audio the host granted) in the ONE output track consumers hold: device + mixin → two `MediaStreamAudioSourceNode`s → one `MediaStreamAudioDestinationNode` in the shared 48 kHz context; the destination's track is the output. `decideMicOutput` (mic-output-policy.ts) is the only decision; `_installOutputTrack` the only swap; the store's `onTrackChange` device-change branch carries it to peers. A device change or reopen while mixed replaces only the device source node — the output track, and every consumer's view of it, is untouched. Real audio-graph behaviour (the mixin audible to a peer, no echo) is validated manually — see the plan's final task; node tests cover the decision and the swap plumbing with fakes."
3. Rename the field `_track` → `_deviceTrack` throughout the file (every read/write). Add:
```ts
  private _mixin: MediaStreamTrack | null = null;
  /** The output consumers hold: the device track, or the mix destination's track. */
  private _outputTrack: MediaStreamTrack | null = null;
  private _mix: {
    device: MediaStreamTrack;
    mixin: MediaStreamTrack;
    deviceNode: MediaStreamAudioSourceNode;
    mixinNode: MediaStreamAudioSourceNode;
    destination: MediaStreamAudioDestinationNode;
  } | null = null;
```
4. Getters: `get track()` returns `this._outputTrack`; add `get deviceTrack(): MediaStreamTrack | null { return this._deviceTrack; }` and `get outputMode(): MicOutputMode | null { return this._outputTrack ? (this._mix ? 'mixed' : 'device') : null; }`.
5. `acquire()`: after `_ensureOpen`, `const track = this._outputTrack; if (!track) return null;` — hand out the output.
6. `setMuted`: apply `enabled = !muted` to `_outputTrack` AND `_deviceTrack` (when they differ).
7. The one reconcile step, called after every device/mixin change:
```ts
  /** Apply decideMicOutput to the current device/mixin state. Returns true iff the output includes the mixin. */
  private _reconcileOutput(): boolean {
    const current = this._mix
      ? { mode: 'mixed' as const, device: this._mix.device, mixin: this._mix.mixin }
      : this._outputTrack ? { mode: 'device' as const } : null;
    const decision = decideMicOutput({ device: this._deviceTrack, mixin: this._mixin, current });
    switch (decision.kind) {
      case 'none':
        return this._mix !== null;
      case 'use-device':
        this._installOutputTrack(this._deviceTrack, this._outputTrack);
        return false;
      case 'tear-mix': {
        const old = this._outputTrack;
        this._disconnectMix();
        if (decision.reason === 'mixin-ended') this._mixin = null;
        this._installOutputTrack(this._deviceTrack, old);
        return false;
      }
      case 'build-mix': {
        if (this._mix && decision.reason === 'device-changed') {
          // Same destination, same output track: only the device source node changes.
          this._replaceMixDeviceNode();
          return true;
        }
        const old = this._outputTrack;
        if (!this._buildMix()) {
          // No Web Audio: keep the device path and drop the request.
          this._mixin = null;
          if (old !== this._deviceTrack) this._installOutputTrack(this._deviceTrack, old);
          return false;
        }
        this._installOutputTrack(this._mix!.destination.stream.getAudioTracks()[0], old);
        return true;
      }
      default: {
        const exhaustive: never = decision;
        void exhaustive;
        return false;
      }
    }
  }
```
   with the helpers:
```ts
  private _buildMix(): boolean {
    const ctx = this.ensureAudioContext();
    const device = this._deviceTrack;
    const mixin = this._mixin;
    if (!ctx || !device || !mixin) return false;
    this._disconnectMix();
    try {
      const deviceNode = ctx.createMediaStreamSource(new MediaStream([device]));
      const mixinNode = ctx.createMediaStreamSource(new MediaStream([mixin]));
      const destination = ctx.createMediaStreamDestination();
      deviceNode.connect(destination);
      mixinNode.connect(destination);
      this._mix = { device, mixin, deviceNode, mixinNode, destination };
      return true;
    } catch (e) {
      console.error('MicSource: building the mix graph failed', e);
      this._mix = null;
      return false;
    }
  }

  private _replaceMixDeviceNode(): void {
    const mix = this._mix;
    const device = this._deviceTrack;
    if (!mix || !device) return;
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    try { mix.deviceNode.disconnect(); } catch {}
    const deviceNode = ctx.createMediaStreamSource(new MediaStream([device]));
    deviceNode.connect(mix.destination);
    this._mix = { ...mix, device, deviceNode };
  }

  /** Disconnect the graph and end the destination track (nobody holds it after the swap). */
  private _disconnectMix(): void {
    const mix = this._mix;
    if (!mix) return;
    this._mix = null;
    try { mix.deviceNode.disconnect(); } catch {}
    try { mix.mixinNode.disconnect(); } catch {}
    try { mix.destination.stream.getAudioTracks().forEach(t => t.stop()); } catch {}
  }

  /**
   * The ONE output swap: mute state applied, store fanout first
   * (replaceTrack on peers), then per-consumer rebuilds. `null` new is the
   * close case (fanout with the old output).
   */
  private _installOutputTrack(newTrack: MediaStreamTrack | null, oldTrack: MediaStreamTrack | null): void {
    if (newTrack === oldTrack) return;
    if (newTrack) newTrack.enabled = !this._muted;
    this._outputTrack = newTrack;
    try {
      this.bindings.onTrackChange(newTrack, oldTrack);
    } catch (e) {
      console.warn('MicSource: onTrackChange threw on output swap', e);
    }
    if (newTrack) {
      for (const c of this.consumers.values()) {
        try { c.onTrackChanged?.(newTrack); } catch (e) {
          console.warn(`MicSource: consumer "${c.id}" onTrackChanged threw`, e);
        }
      }
    }
  }

  /** Include (or remove, with null) a second audio track in the output. Returns true iff the output now includes it. */
  setMixin(track: MediaStreamTrack | null): boolean {
    this._mixin = isUsableMixin(track) ? track : null;
    return this._reconcileOutput();
  }
```
8. `_ensureOpen` open success: after `this._deviceTrack = track; this._setLifecycle(live)`, replace the direct `onTrackChange(track, null)` call with `this._reconcileOutput();` (which installs the device output via `use-device`, or builds the mix if a mixin was set before the device opened — fanout `(output, null)` is the open case the store expects).
9. `_openAndSwap` success: set `_deviceTrack`/`_rawStream`/lifecycle as today, then: if `this._mix` → `this._reconcileOutput()` (device-changed → node replaced, no fanout, no consumer callbacks); else → the existing fanout (`onTrackChange(newTrack, old)` + consumer callbacks) becomes `this._installOutputTrack(newTrack, old)`. Stop the old stream last, as today. (`old` here is the previous DEVICE track; when not mixed that is also the previous output.)
10. `_closeDevice`: capture `const oldOutput = this._outputTrack;` first; `this._disconnectMix(); this._mixin = null;` then null the device fields, lifecycle idle, stop the device stream, and fan out `onTrackChange(null, oldOutput)` (replacing the `old`-based call), setting `this._outputTrack = null`.
11. `dispose()`: unchanged (calls `_closeDevice`).

- [ ] **Step 4: Run the mixin test, the existing mic suites, then the gate; commit**

```bash
cd /home/eric/code/metacurrency/holochain/presence
nix develop -c npx vitest run ui/src/__tests__/mic-source-mixin.test.ts ui/src/__tests__/capture-lifecycle.test.ts ui/src/__tests__/streams-store-wiring.test.ts
nix develop -c npm run verify
git add ui/src/mic-source.ts ui/src/__tests__/mic-source-mixin.test.ts
git commit -m "feat(mic): MicSource mixin — one output track, built from the device and a host-granted mixin

decideMicOutput decides; _installOutputTrack is the one swap; a device
change or reopen while mixed replaces only the device source node, so
consumers and peers never see the output change for that."
```

---

### Task 4: The store — seam, gestures, teardown, logging, wiring tests

**Files:**
- Modify: `ui/src/streams-store.ts`, `ui/src/logging.ts`, `ui/src/room/room-container.ts`
- Modify: `ui/src/__tests__/intent-write-sites.test.ts`, `ui/src/__tests__/streams-store-wiring.test.ts`

**Interfaces:**
- Consumes: `MicSource.setMixin` (Task 3); intent gestures (Task 1); `AudioSourceCapture`, `CaptureAudioSourcesOptions` from `@theweave/api`.
- Produces on `StreamsStore`: constructor 4th param `captureAudioSources?: CaptureAudioSourcesFn`; `static connect(roomStore, screenSourceSelection, logger, captureAudioSources?)`; `get canCaptureAudioSources(): boolean`; `get systemAudio(): Readable<SystemAudioState | null>` with `export type SystemAudioState = { label: string; canExcludeSelf: boolean }`; `async systemAudioOn(): Promise<void>`; `systemAudioOff(): void`; `export type CaptureAudioSourcesFn = (opts: CaptureAudioSourcesOptions) => Promise<AudioSourceCapture | null>`.

- [ ] **Step 1: Taxonomy and the allow-list (red first)**

`ui/src/logging.ts`: add `| 'SystemAudioEnded'      // the host or platform ended an included system-audio grant` to `SimpleEventType` (next to the `My*` events) and `SystemAudioEnded: 'emitted',` to `SIMPLE_EVENT_TAXONOMY`. Run `nix develop -c npx vitest run ui/src/__tests__/event-taxonomy.test.ts` → FAIL: declared `emitted` with no emission site (this is the red).

`ui/src/__tests__/intent-write-sites.test.ts`: add to `ALLOWED_CALL_SITES`:
```ts
  ['systemAudioOn', /^  async systemAudioOn\(\): Promise<void> \{/],
  ['systemAudioOff', /^  systemAudioOff\(\): void \{/],
```
Run it → FAIL: `method header not found`.

- [ ] **Step 2: Write the failing wiring tests**

Append to `ui/src/__tests__/streams-store-wiring.test.ts`, as a new top-level `describe` that builds its own started store with the seam (the existing `makeStarted` passes three constructor args; this block passes four). Reuse the file's `FakeLogger`, `makeFakeDeps`, `ManualClock`, `myPubKey`, `live`, and define locally the same `FakeTrack`/`FakeStream`/`FakeMediaStream`/`installNavigator` the capture-reconciler block defines (copy them into this block; they are block-scoped) plus a `FakeAudioContext` identical to Task 3's test:
```ts
describe('system audio (spec Section 4): the capture seam, the mixin swap, and every way it ends', () => {
  // …the local fakes (FakeTrack, FakeStream, FakeMediaStream, FakeAudioContext, installNavigator, flush)…

  type FakeCapture = {
    track: FakeTrack; label: string; canExcludeSelf: boolean; endedReason?: string;
    stop: ReturnType<typeof vi.fn>; onended?: () => void;
  };
  function fakeCapture(over: Partial<FakeCapture> = {}): FakeCapture {
    const c: FakeCapture = {
      track: new FakeTrack('audio', 'system'), label: 'System audio', canExcludeSelf: true,
      stop: vi.fn(), ...over,
    };
    return c;
  }

  function makeStartedWithCapture(capture: () => Promise<FakeCapture | null>) {
    const clock = new ManualClock(1_000_000);
    const fakes = makeFakeDeps({ clock, myPubKey });
    const logger = new FakeLogger();
    const calls: unknown[] = [];
    const store = new StreamsStore(
      fakes.deps,
      async () => '',
      logger.asPresenceLogger(),
      async opts => { calls.push(opts); return (await capture()) as unknown as AudioSourceCapture | null; },
    );
    store.start();
    live.push(store);
    return { ...fakes, clock, store, logger, calls };
  }

  beforeEach(() => {
    (globalThis as any).MediaStream = FakeMediaStream;
    (globalThis as any).AudioContext = FakeAudioContext;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).navigator;
    delete (globalThis as any).MediaStream;
    delete (globalThis as any).AudioContext;
  });

  it('without the seam, canCaptureAudioSources is false and systemAudioOn is a no-op', async () => {
    const started = makeStarted();
    expect(started.store.canCaptureAudioSources).toBe(false);
    await started.store.systemAudioOn();
    expect(get(started.store.localIntent).mic.includeSystemAudio).toBe(false);
  });

  it('systemAudioOn: picker → mixed output reaches every media transport via replaceTrack exactly once; intent and the readable follow', async () => {
    const device = new FakeTrack('audio', 'device');
    installNavigator(async () => new FakeStream([device]));
    const capture = fakeCapture();
    const started = makeStartedWithCapture(async () => capture);
    await started.store.audioOn(true);
    await flush();
    const media = started.transports.media!;
    media.replaceCalls.length = 0;

    await started.store.systemAudioOn();
    await flush();

    expect(started.calls).toHaveLength(1);
    expect((started.calls[0] as { audioContext?: unknown }).audioContext).toBeDefined();
    expect(get(started.store.localIntent).mic.includeSystemAudio).toBe(true);
    expect(get(started.store.systemAudio)).toEqual({ label: 'System audio', canExcludeSelf: true });
    expect(started.store.micSource.outputMode).toBe('mixed');
    expect(media.replaceCalls).toHaveLength(1);
    expect(media.replaceCalls[0].oldTrack).toBe(device as unknown as MediaStreamTrack);
    expect(media.replaceCalls[0].newTrack).toBe(started.store.micSource.track);
    expect(typeof capture.onended).toBe('function');
  });

  it('systemAudioOff: swaps back to the device track once, stops the capture, clears intent and the readable; onended is NOT fired', async () => {
    const device = new FakeTrack('audio', 'device');
    installNavigator(async () => new FakeStream([device]));
    const capture = fakeCapture();
    const started = makeStartedWithCapture(async () => capture);
    await started.store.audioOn(true);
    await started.store.systemAudioOn();
    await flush();
    const media = started.transports.media!;
    media.replaceCalls.length = 0;

    started.store.systemAudioOff();
    await flush();

    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(media.replaceCalls).toHaveLength(1);
    expect(media.replaceCalls[0].newTrack).toBe(device as unknown as MediaStreamTrack);
    expect(started.store.micSource.outputMode).toBe('device');
    expect(get(started.store.localIntent).mic.includeSystemAudio).toBe(false);
    expect(get(started.store.systemAudio)).toBeNull();
    expect(started.logger.events.some(e => e.event === 'SystemAudioEnded')).toBe(false);
  });

  it('the host ending the grant (capture.onended) → intent system-audio-ended, mix torn, SystemAudioEnded logged with the reason', async () => {
    const device = new FakeTrack('audio', 'device');
    installNavigator(async () => new FakeStream([device]));
    const capture = fakeCapture({ endedReason: 'user-stopped' });
    const started = makeStartedWithCapture(async () => capture);
    await started.store.audioOn(true);
    await started.store.systemAudioOn();
    await flush();
    const media = started.transports.media!;
    media.replaceCalls.length = 0;

    capture.track.stop();          // what the host's end does to the track (fires no intent by itself)
    capture.onended!();            // the api's single end notification
    await flush();

    expect(get(started.store.localIntent).mic.includeSystemAudio).toBe(false);
    expect(get(started.store.systemAudio)).toBeNull();
    expect(started.store.micSource.outputMode).toBe('device');
    expect(media.replaceCalls).toHaveLength(1);
    expect(capture.stop).not.toHaveBeenCalled();
    const logged = started.logger.events.find(e => e.event === 'SystemAudioEnded');
    expect(logged?.detail).toContain('user-stopped');
  });

  it('a stale onended (from a capture that was already replaced or stopped) is ignored', async () => {
    const device = new FakeTrack('audio', 'device');
    installNavigator(async () => new FakeStream([device]));
    const first = fakeCapture();
    const started = makeStartedWithCapture(async () => first);
    await started.store.audioOn(true);
    await started.store.systemAudioOn();
    started.store.systemAudioOff();
    await flush();
    first.onended!();
    await flush();
    expect(started.logger.events.some(e => e.event === 'SystemAudioEnded')).toBe(false);
  });

  it('picker cancelled (null) → nothing changes and no intent is written', async () => {
    const device = new FakeTrack('audio', 'device');
    installNavigator(async () => new FakeStream([device]));
    const started = makeStartedWithCapture(async () => null);
    await started.store.audioOn(true);
    const intentBefore = get(started.store.localIntent);
    await started.store.systemAudioOn();
    expect(get(started.store.localIntent)).toEqual(intentBefore);
    expect(started.store.micSource.outputMode).toBe('device');
    expect(get(started.store.systemAudio)).toBeNull();
  });

  it('mic not wanted → the picker is never opened', async () => {
    const started = makeStartedWithCapture(async () => fakeCapture());
    await started.store.systemAudioOn();
    expect(started.calls).toHaveLength(0);
  });

  it('a second systemAudioOn while one is active opens no second picker (Review Focus 4)', async () => {
    const device = new FakeTrack('audio', 'device');
    installNavigator(async () => new FakeStream([device]));
    const started = makeStartedWithCapture(async () => fakeCapture());
    await started.store.audioOn(true);
    await started.store.systemAudioOn();
    await started.store.systemAudioOn();
    expect(started.calls).toHaveLength(1);
  });

  it('a capture that resolves already ended is not installed (Review Focus 2)', async () => {
    const device = new FakeTrack('audio', 'device');
    installNavigator(async () => new FakeStream([device]));
    const capture = fakeCapture({ endedReason: 'stream-lost' });
    capture.track.stop();
    const started = makeStartedWithCapture(async () => capture);
    await started.store.audioOn(true);
    await started.store.systemAudioOn();
    await flush();
    expect(get(started.store.localIntent).mic.includeSystemAudio).toBe(false);
    expect(started.store.micSource.outputMode).toBe('device');
    expect(get(started.store.systemAudio)).toBeNull();
  });

  it('mute while included keeps the mix and silences the output; audioOn(true) un-mutes it (Review Focus 3)', async () => {
    const device = new FakeTrack('audio', 'device');
    installNavigator(async () => new FakeStream([device]));
    const started = makeStartedWithCapture(async () => fakeCapture());
    await started.store.audioOn(true);
    await started.store.systemAudioOn();
    await flush();
    await started.store.audioOff();
    expect(started.store.micSource.outputMode).toBe('mixed');
    expect((started.store.micSource.track as unknown as FakeTrack).enabled).toBe(false);
    expect(get(started.store.localIntent).mic.includeSystemAudio).toBe(true);
    await started.store.audioOn(true);
    expect((started.store.micSource.track as unknown as FakeTrack).enabled).toBe(true);
  });

  it('disconnect stops an active capture without a gesture write beyond session-end', async () => {
    const device = new FakeTrack('audio', 'device');
    installNavigator(async () => new FakeStream([device]));
    const capture = fakeCapture();
    const started = makeStartedWithCapture(async () => capture);
    await started.store.audioOn(true);
    await started.store.systemAudioOn();
    await flush();
    started.store.disconnect('test');
    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(get(started.store.systemAudio)).toBeNull();
    expect(get(started.store.localIntent).mic.includeSystemAudio).toBe(false);
  });
});
```
(`FakeLogger.events` — check its actual field name for logged agent events in `store-deps.testing.ts` and use that; `AudioSourceCapture` is imported as a type from `@theweave/api`.)

Run: `cd /home/eric/code/metacurrency/holochain/presence && nix develop -c npx vitest run ui/src/__tests__/streams-store-wiring.test.ts -t "system audio"`
Expected: FAIL (no `canCaptureAudioSources`, no `systemAudioOn`).

- [ ] **Step 3: Implement the store side**

In `ui/src/streams-store.ts`:
- imports: `import type { AudioSourceCapture, CaptureAudioSourcesOptions } from '@theweave/api';` and `import { isUsableMixin } from './mic-output-policy';`
- exports near the top:
```ts
/** The host seam for system audio (spec Section 4): `WeaveClient.captureAudioSources`, absent on hosts without the feature. */
export type CaptureAudioSourcesFn = (
  opts: CaptureAudioSourcesOptions,
) => Promise<AudioSourceCapture | null>;
export type SystemAudioState = { label: string; canExcludeSelf: boolean };
```
- fields: `private captureAudioSources: CaptureAudioSourcesFn | undefined;`, `private _systemAudioCapture: AudioSourceCapture | null = null;`, `private _systemAudio: Writable<SystemAudioState | null> = writable(null);`
- constructor: fourth parameter `captureAudioSources?: CaptureAudioSourcesFn`, stored. `static connect(roomStore, screenSourceSelection, logger, captureAudioSources?: CaptureAudioSourcesFn)` passes it through.
- getters:
```ts
  /** True iff the host offered `captureAudioSources` — the menu row renders only then. */
  get canCaptureAudioSources(): boolean {
    return this.captureAudioSources !== undefined;
  }

  /** The active system-audio share (label + echo warning), or null. */
  get systemAudio(): Readable<SystemAudioState | null> {
    return this._systemAudio;
  }
```
- gesture methods, placed after `stopScreenShare` (headers must match the allow-list regexes exactly):
```ts
  /**
   * Include audio playing on this machine in the outgoing mic track (spec
   * Section 4). The host owns the picker; a null capture is a cancel and
   * writes no intent. Intent is written only after the picker succeeded,
   * as `screenShareOn` does. The capture's `onended` — the host (Stop on
   * Moss's chip, iframe unload) or the platform ending the grant — is the
   * documented gesture-equivalent 'system-audio-ended' (intent.ts header);
   * `stop()` never fires it, so `systemAudioOff` is the only other exit.
   */
  async systemAudioOn(): Promise<void> {
    const seam = this.captureAudioSources;
    if (!seam) return;
    if (!get(this._localIntent).mic.wanted) return;
    if (this._systemAudioCapture) return;
    const audioContext = this.micSource.ensureAudioContext() ?? undefined;
    let capture: AudioSourceCapture | null;
    try {
      capture = await seam({ audioContext });
    } catch (e: any) {
      const error = `Failed to capture audio sources: ${e?.toString?.() ?? e}`;
      console.error(error);
      this.eventCallback({ type: 'error', error });
      return;
    }
    if (!capture) return;
    if (!isUsableMixin(capture.track)) {
      // Resolved already ended (spec Section 3): nothing to include.
      return;
    }
    if (this._systemAudioCapture) {
      capture.stop();
      return;
    }
    this._systemAudioCapture = capture;
    capture.onended = () => {
      if (this._systemAudioCapture !== capture) return;
      this._applyIntent({ type: 'system-audio-ended' });
      this._systemAudioCapture = null;
      this._systemAudio.set(null);
      this.micSource.setMixin(null);
      this.logger.logAgentEvent({
        agent: this.myPubKeyB64,
        timestamp: this.clock.now(),
        event: 'SystemAudioEnded',
        detail: `reason=${capture.endedReason ?? 'unknown'}; label=${capture.label}`,
      });
    };
    this._applyIntent({ type: 'system-audio-on' });
    this.micSource.setMixin(capture.track);
    this._systemAudio.set({ label: capture.label, canExcludeSelf: capture.canExcludeSelf });
  }

  /** The menu row's off gesture: stop the host grant and swap back to the device track. */
  systemAudioOff(): void {
    this._applyIntent({ type: 'system-audio-off' });
    this._releaseSystemAudio();
  }

  /** Stop and forget the capture (no intent write — callers own that). */
  private _releaseSystemAudio(): void {
    const capture = this._systemAudioCapture;
    this._systemAudioCapture = null;
    this._systemAudio.set(null);
    this.micSource.setMixin(null);
    if (capture) {
      try { capture.stop(); } catch (e) { console.warn('systemAudio: stop threw', e); }
    }
  }
```
- `_teardownCaptureAndSignals`: call `this._releaseSystemAudio();` before `this.captureReconciler.releaseAll();` (session-end intent was already applied by `disconnect()`'s first statement).
- `ui/src/room/room-container.ts`: the `StreamsStore.connect(...)` call gains a fourth argument:
```ts
      this.weaveClient.captureAudioSources
        ? opts => this.weaveClient.captureAudioSources!(opts)
        : undefined,
```

- [ ] **Step 4: Run the suites, the gate; commit**

```bash
cd /home/eric/code/metacurrency/holochain/presence
nix develop -c npx vitest run ui/src/__tests__/streams-store-wiring.test.ts ui/src/__tests__/intent-write-sites.test.ts ui/src/__tests__/event-taxonomy.test.ts
nix develop -c npm run verify
git add ui/src/streams-store.ts ui/src/logging.ts ui/src/room/room-container.ts ui/src/__tests__/intent-write-sites.test.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "feat(store): systemAudioOn/Off over the host's captureAudioSources seam

The capture's track becomes the mic mixin; every media transport sees one
replaceTrack per swap. The host ending the grant arrives as the capture's
onended and is written as the system-audio-ended gesture-equivalent, logged
as SystemAudioEnded; stop() from our side never fires it. disconnect()
releases an active capture."
```

---

### Task 5: The menu row

**Files:**
- Modify: `ui/src/room/room-view.ts`, `ui/src/__tests__/view-teardown-symmetry.test.ts`

**Interfaces:**
- Consumes: `streamsStore.canCaptureAudioSources`, `streamsStore.systemAudio`, `systemAudioOn()`, `systemAudioOff()`, `localIntent.mic.wanted` (Task 4).

- [ ] **Step 1: The teardown pin (red first)**

Append to `ui/src/__tests__/view-teardown-symmetry.test.ts`, mirroring the `intentDiffs` case exactly:
```ts
describe('RoomView system-audio subscription (spec Section 4)', () => {
  it('the systemAudio StoreSubscriber is released on disconnect', () => {
    const el = makeRoomView();
    let active = 0;
    (el.streamsStore as any).systemAudio = {
      subscribe(cb: (v: unknown) => void) {
        active += 1;
        cb(null);
        return () => { active -= 1; };
      },
    };
    el._systemAudio.hostUpdate();
    expect(active).toBe(1);
    el.disconnectedCallback();
    expect(active).toBe(0);
  });
});
```
Run: `nix develop -c npx vitest run ui/src/__tests__/view-teardown-symmetry.test.ts` → FAIL (`_systemAudio` undefined).

- [ ] **Step 2: The subscriber and the row**

In `ui/src/room/room-view.ts`:
- after `_localIntent`'s `StoreSubscriber`:
```ts
  /** The active system-audio share for the mic menu's "Including: …" row. */
  _systemAudio = new StoreSubscriber(
    this,
    () => this.streamsStore.systemAudio,
    () => [this.streamsStore]
  );
```
- inside the `audio-input-sources` column, directly after the `${this._audioInputDevices.value.map(...)}` block and before the closing `</div>`:
```ts
                    ${this.streamsStore.canCaptureAudioSources
                      ? this._renderSystemAudioRow()
                      : html``}
```
- the render helper, next to `_micOn`:
```ts
  /**
   * The "Include audio from…" row (spec Section 4). Rendered only when the
   * host offers the seam; disabled while the mic is not wanted (v1 rides
   * the mic track). The active state comes from the store's `systemAudio`
   * readable, the gestures are the store's `systemAudioOn/Off`.
   */
  private _renderSystemAudioRow() {
    const active = this._systemAudio.value;
    const micWanted = !!this._localIntent.value?.mic.wanted;
    const disabled = !active && !micWanted;
    const label = active
      ? `✓ ${msg('Including')}: ${active.label}${active.canExcludeSelf ? '' : ` ${msg('(may echo)')}`}`
      : msg('Include audio from…');
    const act = async () => {
      if (disabled) return;
      this.closeClosables();
      if (active) this.streamsStore.systemAudioOff();
      else await this.streamsStore.systemAudioOn();
    };
    return html`
      <div class="system-audio-divider"></div>
      <div
        class="audio-source column ${disabled ? 'disabled' : ''}"
        tabindex="0"
        title=${disabled ? msg('Turn your microphone on first') : ''}
        @click=${act}
        @keypress=${async (e: KeyboardEvent) => {
          if (e.key === 'Enter') await act();
        }}
      >
        <div class="row">${label}</div>
      </div>
    `;
  }
```
  and in the element's styles, next to `.audio-source`:
```css
      .system-audio-divider {
        height: 1px;
        margin: 6px 0;
        background: rgba(255, 255, 255, 0.25);
      }
      .audio-source.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
```
  (Presence's strings: check whether room-view wraps copy in `msg()` from `@lit/localize`; if the file does not use it, plain strings — match the file's existing `msg('Audio Input Source')` convention.)

- [ ] **Step 3: Gate and commit**

```bash
cd /home/eric/code/metacurrency/holochain/presence
nix develop -c npx vitest run ui/src/__tests__/view-teardown-symmetry.test.ts ui/src/__tests__/intent-diff-surfaces.test.ts
nix develop -c npm run verify
git add ui/src/room/room-view.ts ui/src/__tests__/view-teardown-symmetry.test.ts
git commit -m "feat(room-view): Include audio from… row in the microphone menu"
```

---

### Task 6: Manual validation record and docs sync

**Files:**
- Modify: `CLAUDE.md` ("True today"), `docs/superpowers/specs/2026-09-22-audio-source-capture-design.md` (Section 4 "Landed"), this plan's status header

- [ ] **Step 1: Manual checklist (the owner runs it; the executor records what was and was not observed)**

Definition of done (spec): a peer hears the sharer's system audio over WebRTC and over the signals voice carrier; the sharer hears no echo of the peer's voice. Requires two machines running a Moss build carrying lightningrodlabs/moss#248 (`main-0.7` @ `916ee18b` or later) with this Presence build installed as a Tool:
1. Both join a room, mics on, WebRTC connected (stats panel: carrier `webrtc`).
2. Sharer: mic menu → "Include audio from…" → Moss picker → "All system output" → Share. The row reads "✓ Including: System audio"; Moss shows the chip.
3. Sharer plays music. Peer hears the music mixed with the sharer's voice. Record: yes/no.
4. Sharer mutes (mic button): peer hears neither voice nor music; the row still reads "Including". Unmute: both return.
5. Peer speaks: sharer hears no echo of the peer's voice in what the peer receives (the peer listens for their own voice coming back). Record: yes/no.
6. Force the signals carrier (settings: carrier mode `signals`): peer still hears the music over the voice encoder. Record: yes/no.
7. Sharer changes mic device from the menu while including: music continues uninterrupted for the peer.
8. Stop from Moss's chip: the row returns to "Include audio from…", the peer hears only voice, the exported logs contain `SystemAudioEnded` with `reason=user-stopped`.
9. Stop from the menu row: the chip disappears in Moss; no `SystemAudioEnded` (stop from our side fires no ended).
What an agent can verify alone on one machine: steps 2, 4, 7, 8, 9 with the Presence harness or a single Moss with two agents (`yarn applet-dev-example` in Moss with this Presence build), if available; otherwise these are recorded as owner-run.

- [ ] **Step 2: CLAUDE.md "True today" bullet**

Insert before the `` `nix develop -c npm run verify` is the gate `` bullet:
```markdown
- **System-audio round facts** (landed <date> on branch `feat/include-system-audio` off `main-0.7`; plan `docs/superpowers/plans/2026-09-23-presence-system-audio.md`, spec Section 4; adversarially reviewed per task). A Presence user includes audio playing on the machine in the ONE outgoing mic track via the host seam `captureAudioSources` (`@theweave/api` `0.7.0-dev.4`, `WeaveClient.captureAudioSources`, optional — absent on hosts without it; injected into `StreamsStore.connect` by `room-container.ts`; `StreamsStore.canCaptureAudioSources` is true iff injected). Intent: `mic.includeSystemAudio` with gestures `system-audio-on` (after the host picker), `system-audio-off` (menu row) and the second documented gesture-equivalent `system-audio-ended` (the capture's `onended`, written from inside `systemAudioOn`'s body — `intent-write-sites.test.ts` lists `systemAudioOn`/`systemAudioOff`); mute keeps the share, `session-end` clears it. `decideMicOutput` (`ui/src/mic-output-policy.ts`, no-ambient-clock pinned) is the ONE decision about the mic output track; `MicSource._installOutputTrack` the ONE swap; `MicSource.track` is the OUTPUT (device or the mix destination's track), `MicSource.deviceTrack` the raw device; a device change or reopen while mixed replaces only the device source node (`mic-source-mixin.test.ts`); the store's `_onMicTrackChange` device-change branch carries every swap to peers as one `replaceTrack` (`streams-store-wiring.test.ts`, "system audio" block). `SystemAudioEnded` is an emitted taxonomy event. No wire-contract change. Declared: mute silences the mixed track as a whole; v1 requires the mic held; a capture that resolves already ended is ignored; audio-graph behaviour is manual territory (plan Task 6 checklist).
```

- [ ] **Step 3: Spec Section 4 "Landed" paragraph and the plan status header**

Add to the spec after Section 4's "Tests" paragraph a `**Landed (<date>; plan …)**` paragraph: commits, deviations (the output-mode policy carries a `current` snapshot rather than the sketch's `'device'|'mixed'|null` string; a device change while mixed swaps the source node instead of rebuilding the destination; the row copy; the `SystemAudioEnded` detail format), what the manual checklist observed and what it did not. Insert a `> **Status …: EXECUTED.**` line under this plan's `**Spec:**` line with commits, gate, and the manual-check record.

- [ ] **Step 4: Gate and commit**

```bash
cd /home/eric/code/metacurrency/holochain/presence
nix develop -c npm run verify
git add CLAUDE.md docs/superpowers/specs/2026-09-22-audio-source-capture-design.md docs/superpowers/plans/2026-09-23-presence-system-audio.md
git commit -m "docs: system-audio round — True today bullet, spec Section 4 landed, plan status"
```

---

## Self-review

**Spec coverage (Section 4):** host seam on `connect` from `room-container` with the shared context → Task 4 ✔; intent shape, three gestures, `session-end` clears, `audio-mute` does not, `intent.test.ts` rows, allow-list entries, the track-ended arm from `onended` inside `systemAudioOn` → Tasks 1, 4 ✔; declared mute behaviour and the disabled row copy → Tasks 3, 5 ✔; `MicSource` mixin with `decideMicOutput` in `media-event-policy.ts` shape, `_installOutputTrack` as the one swap path, device change/reopen while mixed not touching consumers, `tear-mix` on `setMixin(null)`/ended, `_closeDevice` disconnecting the graph, mute on output and device → Tasks 2, 3 ✔; menu row (rendered only when the host offers the seam; "✓ Including: <label>", "(may echo)") → Task 5 ✔; tests named by the spec: policy table, mixin test with an ending-mixin negative control, wiring `replaceTrack` exactly once and swap-back, intent rows, allow-list, teardown-symmetry, no-ambient-clock pin → Tasks 2–5 ✔; `SystemAudioEnded` in the taxonomy → Task 4 ✔; error handling (cancel → nothing; host end → intent + log; no throw paths) → Task 4 ✔; CLAUDE.md bullet and the manual record → Task 6 ✔.

**Placeholder scan:** Task 5's `msg()` note and Task 4's `FakeLogger.events` note are lookups against the file's existing convention, not placeholders.

**Type consistency:** `decideMicOutput`'s `current` shape (Task 2) is what `_reconcileOutput` builds (Task 3); `setMixin(track): boolean`, `track`/`deviceTrack`/`outputMode` (Task 3) are what the store and the wiring tests read (Task 4); `CaptureAudioSourcesFn` (Task 4) is what `room-container` supplies and the wiring block's fourth constructor argument; `SystemAudioState` is what the view's `_systemAudio` subscriber reads (Task 5).

**Review Focus:** all five pinned (Task 3 tear-while-pending row; Task 4 already-ended row; Task 3 mute rows + Task 4 mute wiring row; Task 4 double-on row; Task 3 no-context row).
