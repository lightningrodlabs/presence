# Intent Record & Reconciliation Implementation Plan (2026-09-01)

**Status: LANDED on `docs/2026-09-01-intent-reconciliation`.** All seven tasks executed; each merged `--no-ff` into that integration branch (`11ae105`..`3f3928c`, plus this doc-sync commit for Task 7). Merging that branch into `main-0.6` is a pending human step — this document describes the integration branch, not `main-0.6`, until that merge lands. The corresponding `CLAUDE.md` "True today" bullet was added by the Task 7 doc-sync (see the "Intent-reconciliation round facts" bullet).

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the system a durable record of what the user asked for (`LocalIntent`), reconcile observed reality against it on the existing presence tick, and surface every unfulfilled intent in the UI — so a class of field failures ("user wants X, system silently doesn't deliver X, nothing detects it") becomes structurally impossible instead of guard-by-guard patched.

**Architecture:** A small stored intent record written ONLY by user gestures (enforced by a grep-pin test), explicit lifecycle unions for local capture (mic/camera), a pure capture-reconcile policy driven by the presence tick, a third `caps-unknown` state in WebRTC eligibility, and a pure intent-diff policy whose output renders as button badges, tile status copy, and a room banner. Every decision is a pure function with table-driven tests, per repo convention (`ui/src/transport/media-event-policy.ts` is the template).

**Tech Stack:** TypeScript, Lit, Svelte stores, vitest (node env; wiring suite + fakes in `ui/src/store-deps.testing.ts`; per-file jsdom for view tests), npm workspaces, `nix develop -c npm run verify` as the gate.

**Spec:** The design argument is the "Context: why this architecture" section below — this plan is its own spec. Companion diagnosis: `docs/superpowers/plans/2026-09-01-field-incident-fixes.md` (the field-incident plan; see "Relationship" below).

---

## Context: why this architecture (read before executing)

Every defect family in the 2026-09-01 field incidents has one shape: **a piece of state whose truth is defined by reality (a device, the network, the presence set) but represented as a latch updated by an enumerated list of events — and the enumeration is incomplete.** Guards try to complete the enumeration; the event alphabet grows with every feature, so the enumeration never completes.

The structural fix has three parts:

1. **Intent is recorded, not consumed.** Today `audioOn(true)` is consumed into resource acquisition (`this._webrtcMicHandle = handle`, `streams-store.ts:3111`) and the intent is gone — no field says "the user wants their mic on." When the OS kills the track, the handle stays non-null, `_reconcileSignalsAudio`'s `micHeld = !!this._webrtcMicHandle` (`streams-store.ts:2066`) still reads true, and "wants audio and has it" is indistinguishable from "wants audio and lost it." There is nothing to recover *toward*. The `LocalIntent` record fixes this. Its integrity rests on one syntactic invariant: **intent fields have no system writers** — only user-gesture handlers write them (plus one documented gesture-equivalent, below). That invariant is greppable and pinned by a test, which is what keeps this layer from rotting the way observation-state does.

2. **Reality is reconciled against intent on a tick, not chased by event handlers.** A guard says "on event E, if C, do A" and requires enumerating every E. A reconciler says "invariant I must hold; one loop compares and repairs every tick" — a missed event heals on the next tick. The codebase already does this in three places: `_reconcileSignalsAudio`/`_reconcileSignalsVideo` fired per presence tick by the `_signalsTargets` subscription (`streams-store.ts:730`, pinned load-bearing by the encoder-retry wiring tests), and the per-pong `decideInitRetry` drive (`streams-store.ts:6364`). The gap is local capture: nothing reconciles the mic/camera device state, which is why Incident B's dead mic was unrecoverable without quitting the room. Edge handlers (like `track.onended`) remain as *latency accelerators* — with the tick as backstop, a missed edge costs one `PING_INTERVAL`, not four minutes.

3. **Unfulfilled intent is visible.** When the reconciler cannot achieve intent, that is a computable, persistent condition — and it must reach the user, the way "establishing WebRTC carrier..." (`room-view.ts:3186`) and the connection-status dot (`room/elements/agent-connection-status-icon.ts`) already do for links. A user who can see *that* the system knows, *why*, and *since when* can tolerate the gap; a user who can't presses buttons that make it worse (Incident C's manual reconnects). The failure mode inverts from silent divergence to displayed, logged, unfulfilled intent.

**Deliberately out of scope (YAGNI, verified against current code):**
- A policy-override layer (`effectiveIntent = applyPolicyOverrides(...)`). `setCarrierMode` is gesture-only today (`room-view.ts:1043` is its sole UI caller; no watchdog writes it), so there is no automatic writer to model yet. The extension point is documented in `intent.ts`'s header comment (Task 1); build the layer when the first automatic override actually arrives.
- Collapsing the store's ~22 per-peer collections into one `PeerLink` record. Valuable, but a separate round — it is a refactor of observation-state, not of intent, and this plan must not carry it as a rider.
- Splitting `streams-store.ts` (6.9k lines, ~193 methods). Decided 2026-09-01, before execution: NOT this plan. The coupling is the per-peer state, not the code — the concern clusters (screen share, presence loop, diagnostics, signals media) all share slices of the ~22 per-peer collections, so a file split before the `PeerLink` consolidation yields files passing a god-object around. Sequence for a later round: `PeerLink` record first (the enabler), then owner-object extraction per concern following the `MicSource`/`RoomOwnership` bindings pattern. What THIS plan owes that future: no new glue lands in `streams-store.ts` where an owner object is natural — Task 3's reconciler is built as one (`ui/src/capture-reconciler.ts`), and the round is net-negative lines in the store (the inline acquire blocks die).
- Device-id selection (`_audioInputId` etc.). Already storage-backed with live-read semantics via `MicSource` bindings; folding it into `LocalIntent` changes nothing observable. Declared exclusion.

## Relationship to the field-incident plan (2026-09-01-field-incident-fixes.md)

That plan's Tasks 3, 4, 5, 7 are independent of this plan and remain as written (never-started verdict, maximize guard, carrier-gated escalation, two-person outage detection). This plan **supersedes or absorbs**:

| Field-plan task | Disposition here |
|---|---|
| Task 1 (capture recovery) | Absorbed by Tasks 2–3 below (lifecycle union + reconciler replace the `onended`-plus-predicate design; the `readyState === 'live'` predicate and the negative control survive verbatim) |
| Task 2 (`refreshTracksForPeer` refuses dead track) | Absorbed by Task 3 Step 7 below |
| Task 8 (caps race) | Superseded by Task 4 below — the existing per-pong drive makes parking machinery unnecessary; the plan's option debate is resolved |
| Task 9 (carrier banner) | Absorbed by Task 6 below (it is one arm of the intent-diff surface) |
| Task 6, UI half (tile shows recovery under way) | Absorbed by Task 6 below; the *behavior* half (the button must not tear down an in-flight attempt) stays in the field plan |

When executing both plans, update the field plan's task statuses to point here (working agreement 3). Execution order if both run: field-plan Task 3 first (cheapest, highest information), then this plan Tasks 1→6, then remaining field-plan tasks in its stated order.

## Global Constraints

- Target branch: `main-0.6`; one intent per branch (working agreement 6); merge `--no-ff`; each branch gets an adversarial review by a session that did not write it (working agreement 9).
- Decisions are pure functions: snapshot in, tagged union out, carrying a `reason` (`ui/src/transport/media-event-policy.ts` is the template). Policy tests are table-driven, no mocks.
- No new threshold without a named predicate (working agreement 2). New constants in this plan: `CAPTURE_REOPEN_MIN_INTERVAL_MS` / `CAPTURE_REOPEN_MAX_ATTEMPTS` (capture retry pacing, NOT liveness), `INTENT_DIFF_GRACE_MS` (UI feedback pacing, NOT liveness).
- Replace or declare (working agreement 1): every task states what it replaces. Task 1 introduces the record as a declared parallel authority whose consumers arrive in Tasks 3–6; the closing doc-sync confirms no consumer was left reading the replaced source.
- All store timing through `this.clock`; policy functions take `now` as input. Before touching any file, check whether it is enumerated in `ui/src/__tests__/no-ambient-clock.test.ts` (the test is the authority).
- Every important mock/fake needs a negative control — a test that fails if the fake cannot reproduce the bug it exists to catch.
- Gate: `nix develop -c npm run verify` green before every commit claim. No Claude co-authored footer. A fix names the symptom's previous fixes ("supersedes `<hash>`", working agreement 8).
- `CLAUDE.md` "True today" bullets change only in the closing doc-sync task.

---

### Task 1: the `LocalIntent` record and its one writer

**Landed:** merge `11ae105` into `docs/2026-09-01-intent-reconciliation`.

**Branch:** `feat/local-intent-record`

**Files:**
- Create: `ui/src/intent.ts`
- Create: `ui/src/__tests__/intent.test.ts`
- Create: `ui/src/__tests__/intent-write-sites.test.ts`
- Modify: `ui/src/streams-store.ts` (field + `_applyIntent` + calls in `audioOn` ~:3093, `audioOff` ~:3159, `videoOn` ~:2903, `videoOff` (find beside `videoOn`), `screenShareOn` ~:3230, `screenShareOff` ~:3283, `setCarrierMode` ~:4194, the per-peer webrtc-disable setter ~:4252–4291, `disconnect()`)

**Interfaces:**
- Produces: `LocalIntent`, `IntentGesture`, `applyIntentGesture(intent, gesture): LocalIntent`, `initialLocalIntent(storage): LocalIntent` (all from `ui/src/intent.ts`); `StreamsStore._localIntent: Writable<LocalIntent>` and `StreamsStore.localIntent: Readable<LocalIntent>`; private `StreamsStore._applyIntent(gesture: IntentGesture): void`. Tasks 3–6 consume these exact names.

**Design.** `ui/src/intent.ts`:

```ts
import type { AgentPubKeyB64 } from '@holochain/client';

/**
 * LocalIntent — the durable record of what the user last asked for.
 *
 * INVARIANT (pinned by __tests__/intent-write-sites.test.ts): intent is
 * written only by StreamsStore._applyIntent, and _applyIntent is called
 * only from user-gesture entry points — never from event handlers,
 * timers, transport callbacks, or reconcilers. One documented
 * gesture-equivalent exception exists: the `ended` event on a local
 * display-capture track ('screen-share-track-ended'), because stopping a
 * share from outside the app UI is a user action the platform delivers
 * as a track event.
 *
 * EXTENSION POINT (not built — YAGNI, no automatic writer exists today):
 * if a future feature must override intent automatically (a flap
 * watchdog, an auto-mute policy), do NOT add a writer here. Add a
 * separate named-override layer (effectiveIntent = applyPolicyOverrides
 * (intent, overrides, now)) so the user's record survives to be
 * restored when the condition clears.
 *
 * Device-id selection is deliberately NOT here: it is storage-backed
 * with live-read semantics via MicSource/CameraSource bindings and
 * moving it changes nothing observable.
 */
export type LocalIntent = {
  /** wanted: the device should be held with a live track (mute keeps the
   *  device — audioOff mutes, it does not release; see streams-store
   *  audioOff's comment). muted: track.enabled state. */
  mic: { wanted: boolean; muted: boolean };
  camera: { wanted: boolean };
  screenShare: { wanted: boolean };
  webrtc: { enabled: boolean; disabledWith: ReadonlySet<AgentPubKeyB64> };
};

export type IntentGesture =
  | { type: 'audio-on' }                 // audioOn(true)
  | { type: 'audio-mute' }               // audioOn(false) or audioOff
  | { type: 'video-on' }
  | { type: 'video-off' }
  | { type: 'screen-share-on' }          // fires only after the picker succeeds
  | { type: 'screen-share-off' }         // toolbar button / stop overlay
  | { type: 'screen-share-track-ended' } // gesture-equivalent (see header)
  | { type: 'carrier-mode'; mode: 'webrtc' | 'signals' }
  | { type: 'peer-webrtc'; peer: AgentPubKeyB64; disabled: boolean }
  | { type: 'session-end' };             // disconnect(): all wants drop

export function applyIntentGesture(
  intent: LocalIntent,
  gesture: IntentGesture,
): LocalIntent {
  switch (gesture.type) {
    case 'audio-on':
      return { ...intent, mic: { wanted: true, muted: false } };
    case 'audio-mute':
      // audioOn(false) acquires-then-mutes; audioOff mutes an already
      // wanted mic. Either way the device stays wanted once it has been
      // wanted (fast re-enable, no renegotiation) — matching audioOff's
      // do-not-release semantics. A never-wanted mic stays unwanted.
      return {
        ...intent,
        mic: { wanted: intent.mic.wanted, muted: true },
      };
    case 'video-on':
      return { ...intent, camera: { wanted: true } };
    case 'video-off':
      return { ...intent, camera: { wanted: false } };
    case 'screen-share-on':
      return { ...intent, screenShare: { wanted: true } };
    case 'screen-share-off':
    case 'screen-share-track-ended':
      return { ...intent, screenShare: { wanted: false } };
    case 'carrier-mode':
      return {
        ...intent,
        webrtc: { ...intent.webrtc, enabled: gesture.mode === 'webrtc' },
      };
    case 'peer-webrtc': {
      const next = new Set(intent.webrtc.disabledWith);
      if (gesture.disabled) next.add(gesture.peer);
      else next.delete(gesture.peer);
      return { ...intent, webrtc: { ...intent.webrtc, disabledWith: next } };
    }
    case 'session-end':
      return {
        ...intent,
        mic: { wanted: false, muted: intent.mic.muted },
        camera: { wanted: false },
        screenShare: { wanted: false },
        // carrier selection survives the session — it is persisted intent
      };
    default: {
      const exhaustive: never = gesture;
      void exhaustive;
      return intent;
    }
  }
}

/** Initial intent at store construction. Carrier selection is persisted
 *  ('disableAllWebrtc' in local storage — the same key the store's
 *  webrtcGloballyDisabled init reads today; keep them side by side until
 *  Task 4 makes intent the authority). Media wants start false. */
export function initialLocalIntent(local: {
  getItem(key: string): string | null;
}): LocalIntent {
  return {
    mic: { wanted: false, muted: true },
    camera: { wanted: false },
    screenShare: { wanted: false },
    webrtc: {
      enabled: local.getItem('disableAllWebrtc') !== 'true',
      disabledWith: new Set(),
    },
  };
}
```

Store side: one field, one writer, forensics for free.

```ts
// streams-store.ts — field beside the other stores:
_localIntent: Writable<LocalIntent>; // constructed in the constructor from
                                     // initialLocalIntent(this.deps.storage.local)
get localIntent(): Readable<LocalIntent> { return this._localIntent; }

/** The ONE intent writer (pinned by intent-write-sites.test.ts). */
private _applyIntent(gesture: IntentGesture): void {
  this._localIntent.update(prev => {
    const next = applyIntentGesture(prev, gesture);
    this.logger.logCustomMessage(`IntentChange: ${gesture.type}`);
    return next;
  });
}
```

Each gesture method gains a `this._applyIntent(...)` call as its FIRST statement (intent is recorded even if the action then fails — that is the point): `audioOn(enabled)` → `{type: enabled ? 'audio-on' : 'audio-mute'}`; `audioOff` → `'audio-mute'`; `videoOn`/`videoOff`; `screenShareOn` applies `'screen-share-on'` **after** the picker succeeds (a canceled picker expressed no intent — place it right before `activateModule('screen-share')`, `streams-store.ts:3274`); `screenShareOff` → `'screen-share-off'`; `setCarrierMode(mode)` → `{type:'carrier-mode', mode}`; the per-peer disable setter → `'peer-webrtc'`; `disconnect()` → `'session-end'`.

**Declared (working agreement 1):** this task adds the record as a parallel authority. Nothing reads it yet; existing behavior is unchanged. Tasks 3, 4, and 6 move consumers onto it and each names what it replaces. The write-sites pin prevents the parallel period from growing new writers.

The write-sites pin (`intent-write-sites.test.ts`) follows the `no-ambient-clock.test.ts` grep-pin pattern: read `streams-store.ts` as text and assert (a) `_localIntent.update` / `_localIntent.set` appear only inside `_applyIntent`, and (b) `this._applyIntent(` appears only inside the enumerated gesture methods. Enumerate by slicing the source between method-header markers (the same technique no-ambient-clock uses); keep the allowed-method list in the test as the authority.

- [x] **Step 1: Write the failing reducer tests** (`ui/src/__tests__/intent.test.ts`) — table-driven, no mocks. Rows: each gesture from the initial state; `audio-mute` on a never-wanted mic keeps `wanted: false`; `audio-mute` after `audio-on` keeps `wanted: true`; `session-end` drops all wants but preserves `webrtc.enabled`; `peer-webrtc` add/remove round-trip; `initialLocalIntent` with `disableAllWebrtc = 'true'` yields `enabled: false`, with `null` yields `true`.
- [x] **Step 2: Run to verify failure.** `nix develop -c npm run test --workspace ui -- intent.test` — expect module-not-found.
- [x] **Step 3: Implement `ui/src/intent.ts`** as specified above. Run the reducer tests; expect green.
- [x] **Step 4: Write the failing write-sites pin** (`intent-write-sites.test.ts`) as specified. It must fail now (no `_applyIntent` exists yet — assert the method exists as part of the pin, so the test is red before Step 5).
- [x] **Step 5: Wire the store**: field, getter, `_applyIntent`, and the gesture-method calls listed above. Run the pin; expect green.
- [x] **Step 6: Negative control for the pin** — temporarily add `this._localIntent.set(...)` inside a non-gesture method (e.g. `handlePongUi`), confirm the pin goes red, revert. Record the check in the commit message.
- [x] **Step 7:** `nix develop -c npm run verify`; commit (`feat: LocalIntent record with gesture-only writers`).

### Task 2: capture lifecycle unions in `MicSource`/`CameraSource`

**Landed:** merge `2620e80` into `docs/2026-09-01-intent-reconciliation`.

**Branch:** `feat/capture-lifecycle-state`

**Files:**
- Modify: `ui/src/mic-source.ts` (`acquire` ~:133, `_ensureOpen` ~:280, `changeDevice` ~:190, `_closeDevice`, bindings type ~:56)
- Modify: `ui/src/camera-source.ts` (symmetric)
- Modify: `ui/src/streams-store.ts` (`screenShareOn` ~:3230 — display-track ended watch; MicSource/CameraSource construction sites — add `now` binding)
- Create: `ui/src/__tests__/capture-lifecycle.test.ts`

**Interfaces:**
- Consumes: `StreamsStore._applyIntent` (Task 1) for the screen-share gesture-equivalent.
- Produces: `CaptureLifecycle` (exported from `mic-source.ts`), `MicSource.lifecycle: CaptureLifecycle` getter, `CameraSource.lifecycle: CaptureLifecycle` getter, and a new binding `onLifecycleChange(l: CaptureLifecycle): void` + `now(): number` in `MicSourceBindings`/the camera equivalent. Task 3's reconciler and Task 5's diff policy consume `lifecycle`.

**Design.** The two-state model (`_track` null/non-null) becomes an explicit union, so `ended` exists in the model (this is the state Incident B proved missing):

```ts
export type CaptureLifecycle =
  | { state: 'idle' }
  | { state: 'acquiring'; since: number }
  | { state: 'live'; track: MediaStreamTrack }
  | { state: 'ended'; endedAt: number }
  | { state: 'failed'; error: string; failedAt: number };
```

Changes in `MicSource` (CameraSource mirrors):

1. Private `_lifecycle: CaptureLifecycle = { state: 'idle' }`, public `get lifecycle()`. Every transition goes through one private `_setLifecycle(next)` that also fires `bindings.onLifecycleChange(next)` (wrapped in try/catch like `onMutedChange`).
2. `_ensureOpen()` treats a non-live track as absent: `if (this._track && this._track.readyState === 'live') return true;` and, when the stale track exists, stops `_rawStream`'s tracks before re-opening (no leak). Transitions: → `acquiring` before `getUserMedia`, → `live` on success, → `failed` on catch. *(This predicate is the field plan Task 1 fix, absorbed.)*
3. `acquire()` uses the same predicate instead of `!this._track` (`mic-source.ts:139`).
4. Every code path that installs a new `_track` (in `_ensureOpen` and `changeDevice`) attaches `track.onended = () => this._onTrackEnded(track)`. `_onTrackEnded` checks the ending track is still current, then `_setLifecycle({ state: 'ended', endedAt: this.bindings.now() })`. **It does not reopen** — recovery belongs to Task 3's reconciler; this is an observation writer, and the tick is the correctness backstop if the edge is missed.
5. `_closeDevice()` → `idle`.
6. Bindings gain `now: () => number`, wired from `this.clock.now` at the store's construction sites (check `no-ambient-clock.test.ts`'s enumerated list before editing; add `mic-source.ts`/`camera-source.ts` to it in this task, since after this change they have no excuse for ambient time).

Screen share (no source class; acquired inline): in `screenShareOn`, after acquisition succeeds, attach to the display track: `track.onended = () => { this._applyIntent({ type: 'screen-share-track-ended' }); this.stopScreenShare(); }`. This is the documented gesture-equivalent — a display capture cannot be re-acquired without a user picker, so `ended` here *is* the user (or platform) ending the share, and writing intent is correct where for mic/camera it would be the banned system-write.

**Declared:** replaces the null-check track model inside both source classes; no store-visible behavior changes yet beyond the screen-share ended handling, which today does not exist at all (the pane currently stays open on an externally-stopped share — this task closes that as a declared change).

- [x] **Step 1: Write the failing tests** (`capture-lifecycle.test.ts`) with a fake `getUserMedia` (inject via a constructor seam or module the sources already use — follow how existing tests fake media; the wiring fakes in `store-deps.testing.ts` show the house style). Cases: (a) acquire → `live`; (b) fake track fires `ended` → lifecycle `ended`, `onLifecycleChange` observed; (c) acquire after `ended` returns a NEW live track, not the corpse; (d) `getUserMedia` rejection → `failed` with the error text; (e) `changeDevice` attaches the ended-watch to the new track (end the *new* track, observe `ended`).
- [x] **Step 2: Negative control** — a test that fails unless the fake track can transition to `ended` and fire its handler (the `MockRTCPeerConnection`-cannot-throw lesson; field plan Task 1 required the same control — absorbed here).
- [x] **Step 3: Run to verify failure.**
- [x] **Step 4: Implement in `mic-source.ts`** (items 1–6 above). Run; expect the mic rows green.
- [x] **Step 5: Mirror in `camera-source.ts`.** If the shapes are close enough to share, extract a common helper; if not, state why in the commit message rather than leaving two silent copies.
- [x] **Step 6: Screen-share ended watch** in `screenShareOn` + a wiring test in `streams-store-wiring.test.ts`: end the display track, assert the share tears down (module deactivated, `my-screen-share-off` event) and `localIntent.screenShare.wanted` is false.
- [x] **Step 7: Mutation-verify** — invert the `readyState === 'live'` predicate, confirm red; restore.
- [x] **Step 8:** `nix develop -c npm run verify`; commit.

### Task 3: the capture reconciler

**Landed:** merge `102ed1c` into `docs/2026-09-01-intent-reconciliation`.

**Branch:** `feat/capture-reconciler`

**Files:**
- Create: `ui/src/capture-reconcile-policy.ts` (pure decision)
- Create: `ui/src/capture-reconciler.ts` (owner object — the impure glue; `MicSource`/`RoomOwnership` are the bindings-pattern precedents)
- Create: `ui/src/__tests__/capture-reconcile-policy.test.ts`
- Modify: `ui/src/streams-store.ts` (`audioOn` ~:3093, `videoOn` ~:2903, the `_signalsTargets` subscription in `start()` ~:730, `_reconcileSignalsAudio` ~:2066, `refreshTracksForPeer` ~:5109, `disconnect()` handle cleanup ~:2449) — this task must be NET-NEGATIVE lines in this file (the split decision in "Deliberately out of scope": no new glue in the store where an owner object is natural)
- Modify: `ui/src/__tests__/streams-store-wiring.test.ts`

**Interfaces:**
- Consumes: `LocalIntent` / `localIntent` (Task 1), `CaptureLifecycle` / `lifecycle` getters and `onLifecycleChange` (Task 2).
- Produces: `decideCaptureAction(input: CaptureReconcileInput): CaptureReconcileDecision`, constants `CAPTURE_REOPEN_MIN_INTERVAL_MS`, `CAPTURE_REOPEN_MAX_ATTEMPTS` (from `capture-reconcile-policy.ts`); `CaptureReconciler` class (from `capture-reconciler.ts`) with `tick(): Promise<void>`, `micAttemptState`/`cameraAttemptState` getters (`{ attemptsSinceGesture: number }`, consumed by Task 5's diff inputs), and `releaseAll(): void` (disconnect cleanup). Task 5 consumes the constants for diff severity.

**Owner object.** `CaptureReconciler` owns what would otherwise be new store fields: the `'webrtc'` acquire handles for mic and camera (moving `_webrtcMicHandle`/`_webrtcCameraHandle` ownership out of the store), `lastAttemptAt` and `attemptsSinceGesture` per device. Constructed with bindings:

```ts
export type CaptureReconcilerBindings = {
  clock: { now(): number };
  getIntent: () => LocalIntent;
  mic: MicSource;
  camera: CameraSource;
  /** store error-event emitter, for the report-failure arm */
  onError: (message: string) => void;
  log: (message: string) => void;
};
```

`tick()` runs the decision table for both devices and executes the actions; gesture methods call `captureReconciler.noteGesture('mic' | 'camera')` (resets the attempt count) then `tick()`. The store keeps only: the field, construction in the deps wiring, the tick-subscription call, the `noteGesture` calls, and `releaseAll()` in `disconnect()`. The `replaceTrack` fanout stays where it already lives — `MicSource`/`CameraSource` bindings (`onTrackChange`) — the reconciler triggers reopen, it does not own fanout.

**Design.** Pure policy (`capture-reconcile-policy.ts`):

```ts
/** Capture-device retry pacing. NOT a liveness predicate — it bounds how
 *  fast the reconciler may re-open a device that keeps dying, so a
 *  device that ends immediately on open cannot spin. */
export const CAPTURE_REOPEN_MIN_INTERVAL_MS = 3000;
/** Attempts after the last gesture before the reconciler stops retrying
 *  and reports failure once. A new gesture resets the count. */
export const CAPTURE_REOPEN_MAX_ATTEMPTS = 5;

export type CaptureReconcileInput = {
  wanted: boolean;
  lifecycle: CaptureLifecycle;
  /** clock stamp of the last open/reopen attempt; undefined = none yet */
  lastAttemptAt: number | undefined;
  /** attempts since the last gesture touching this device */
  attemptsSinceGesture: number;
  now: number;
};

export type CaptureReconcileDecision =
  | { action: 'open'; reason: 'wanted-idle' | 'wanted-ended' | 'retry-after-failure' }
  | { action: 'close'; reason: 'unwanted-live' }
  | { action: 'report-failure'; reason: 'attempts-exhausted' }
  | { action: 'hold'; reason: 'attempt-in-flight' | 'reopen-paced' }
  | { action: 'none'; reason: 'satisfied' | 'unwanted-idle' | 'already-reported' };
```

Decision table (exhaustive over `wanted × lifecycle.state`):

| wanted | lifecycle | decision |
|---|---|---|
| true | idle | `open / wanted-idle` |
| true | acquiring | `hold / attempt-in-flight` |
| true | live | `none / satisfied` |
| true | ended | paced? `open / wanted-ended` : `hold / reopen-paced`; attempts ≥ max → `report-failure` once, then `none / already-reported` |
| true | failed | same pacing/ceiling arms, reason `retry-after-failure` |
| false | live | `close / unwanted-live` |
| false | acquiring | `hold / attempt-in-flight` (let it land, next tick closes) |
| false | idle/ended/failed | `none / unwanted-idle` |

Paced = `lastAttemptAt === undefined || now - lastAttemptAt >= CAPTURE_REOPEN_MIN_INTERVAL_MS`.

Action execution inside `CaptureReconciler.tick()` — the table runs for mic (`wanted = intent.mic.wanted`, source = `mic`, handle owned by the reconciler) and camera (`intent.camera.wanted` / `camera`):

- `open`: for a held-but-dead handle, drive the source's `_ensureOpen` path via a new public `reopen()` on the sources (Task 2's `_ensureOpen` already handles the stale-track swap; `reopen()` is `_ensureOpen` + the store-level `onTrackChange` fanout that `changeDevice` already performs — reuse `changeDevice`'s fanout block, do not duplicate it). For no handle at all, `acquire` as `audioOn` does today, then apply the current mute (`micSource.setMuted(intent.mic.muted)`).
- `close`: release the store's handle (today only `disconnect()` does this; the arm exists for `video-off`, whose handler already releases — after this task the handler *delegates* to the reconciler instead of releasing inline).
- `report-failure`: emit the store `error` event once ("Microphone unavailable" / "Camera unavailable") — the user is told instead of the system looping.

Trigger sites: (1) the `_signalsTargets` subscription in `start()` (the per-tick firing beside `_reconcileSignalsAudio()`/`_reconcileSignalsVideo()` at `streams-store.ts:730` — same load-bearing cadence, pinned the same way) calls `captureReconciler.tick()`; (2) each media gesture method (`audioOn`/`audioOff`/`videoOn`/`videoOff`) calls `noteGesture` + `tick()` for latency, matching how those methods already call the signals reconcilers.

**Replacements (working agreement 1), each named:**
1. `audioOn`'s inline acquire block (`streams-store.ts:3103-3115`) is **replaced** by `_applyIntent` + `captureReconciler.noteGesture('mic')` + `tick()` — acquisition has one home, and it is not the store.
2. `videoOn`'s inline acquire (and `videoOff`'s inline release) likewise.
3. `_reconcileSignalsAudio`'s gate `micHeld = !!this._webrtcMicHandle || this.micSource.consumerCount > 0` (`streams-store.ts:2066`) is **replaced** by `get(this._localIntent).mic.wanted` — the observation-standing-in-for-intent conflation this plan exists to kill. `_reconcileSignalsVideo`'s `cameraHeld` (~:2112) likewise becomes `camera.wanted` (its comment about the consumer-count cycle becomes moot and is deleted).
4. `refreshTracksForPeer` (~:5109): when the source lifecycle is not `live`, do **not** call `refreshMediaForPeer` and do not log `replaceTrack` — log `Track refresh [x]: source dead, deferring to capture reconciler` and return false so `_cloneStreamRecovery` stays available. *(Field plan Task 2, absorbed; the dishonest success log is the line that hid Incident B for a minute.)*
5. The de-facto "quit the room and rejoin" recovery path for a dead device is **replaced** by this reconciler.

- [x] **Step 1: Failing policy tests** — the full table above as rows, plus: pacing boundary (`now - lastAttemptAt` exactly at the constant), attempts at the ceiling → `report-failure` exactly once then `already-reported`, gesture reset (attempts back to 0 → `open` again).
- [x] **Step 2: Implement the policy.** Table green.
- [x] **Step 3: Failing wiring tests** (extend `streams-store-wiring.test.ts`, fakes per Task 2): (a) `audioOn(true)` → mic acquired via reconciler, mute applied; (b) kill the track → next tick reopens → `onTrackChange` fanout reaches `mediaTransport.refreshMediaForPeer`/`replaceTrack` for an open connection (assert on the fake transport); (c) reopen failure × `CAPTURE_REOPEN_MAX_ATTEMPTS` → exactly one store `error` event, no further `getUserMedia` calls; (d) `audioOn` → track dies → `audioOn(true)` again (gesture) → immediate reopen attempt (pacing reset); (e) inbound `request-track-refresh` with a dead source → no `refreshMediaForPeer`, the deferring log line. (e) is Incident B's exact wedge.
- [x] **Step 4: Implement the wiring** and the five named replacements.
- [x] **Step 5: Mutation checks** — (i) make `_reconcileSignalsAudio` read the old handle observation again instead of intent: wiring test (b') "track dead but wanted → voice encoder still gated on" must catch the difference (add b' if it does not); (ii) remove the tick-site `captureReconciler.tick()` call: test (b) must go red (the tick is load-bearing, same pin philosophy as the encoder-retry tests).
- [x] **Step 6:** `nix develop -c npm run verify`; commit (message: closes field-plan D3; supersedes the quit/rejoin recovery; absorbs field-plan Tasks 1–2).

### Task 4: `caps-unknown` is not `lacks-cap`, and eligibility reads intent

**Landed:** merge `332489c` into `docs/2026-09-01-intent-reconciliation`.

**Branch:** `fix/eligibility-caps-unknown-and-intent`

**Files:**
- Modify: `ui/src/transport/carrier-coverage.ts` (`decideWebrtcEligibility`)
- Modify: `ui/src/streams-store.ts` (both call ends: initiator ~:6354 in `handlePongUi`, acceptor in `handleInitRequest` ~:6463; `webrtcGloballyDisabled` reads; `_peerCaps` ~:3186)
- Test: `ui/src/transport/__tests__/carrier-coverage.test.ts`, `ui/src/__tests__/streams-store-wiring.test.ts`

**Interfaces:**
- Consumes: `localIntent` (Task 1).
- Produces: `decideWebrtcEligibility` input gains `peerCapsKnown: boolean`; a new ineligible reason `'peer-caps-unknown'` distinct from `'peer-lacks-sdp-fsm-cap'`. Task 6's diff copy may cite the reason strings.

**Design.** Two changes, one branch, because both make eligibility read the right layer:

1. **The caps race (field-plan D2/Task 8, superseding its option debate).** `decideWebrtcEligibility` gains `peerCapsKnown` (call sites compute it as: the peer's `conversation` module payload has been received — `get(this._peerModuleStates)[peerB64]?.['conversation'] !== undefined`). Unknown caps → `{ eligible: false, reason: 'peer-caps-unknown' }`. **No parking machinery is needed**: the initiator drive is already level-triggered per pong (`decideInitRetry`, `streams-store.ts:6364`), so the pong after the payload arrives drives the init — the field plan's option 1 (park + re-drive trigger + TTL) was solving a problem the existing reconciler already absorbs; state this in the commit message. On the acceptor arm (`handleInitRequest`), a `peer-caps-unknown` drop logs `Dropped video InitRequest from X: peer caps not yet received` — distinct from the `peer lacks sdp-fsm capability` line, so field logs can tell a race from an old build (the field plan's option 2, kept because it costs one string). Do NOT answer an InitRequest on unknown caps (the lure warning at `streams-store.ts:6523-6527` stands).
2. **Eligibility inputs come from intent.** `webrtcGloballyDisabled` becomes a getter over the record: `get webrtcGloballyDisabled() { return !get(this._localIntent).webrtc.enabled; }` (the storage write stays in `setCarrierMode`; `initialLocalIntent` already reads it back — delete the now-shadowed field initialization). The per-peer `peerWebrtcDisabled` conjunct reads `webrtc.disabledWith`. **Replaced mechanism:** the standalone `webrtcGloballyDisabled` boolean field and wherever the per-peer disable list is read from today (find it beside the setter at ~:4252–4291) — one authority, the record.

- [x] **Step 1: Failing table rows** in `carrier-coverage.test.ts` — `peerCapsKnown: false` → ineligible/`peer-caps-unknown` for both roles; `peerCapsKnown: true, peerHasSdpFsmCap: false` → `peer-lacks-sdp-fsm-cap` (unchanged); all existing rows get `peerCapsKnown: true` (regression guard).
- [x] **Step 2: Implement the predicate.**
- [x] **Step 3: Failing wiring test** — peer ponged but no conversation payload yet: InitRequest arrives → dropped with the caps-not-yet-received log; payload lands; next pong → init drives (assert `InitRequest` on the fake bus). This is the D2 join sequence end-to-end.
- [x] **Step 4: Implement both call ends + the intent-backed getter;** delete the replaced field/reads.
- [x] **Step 5:** confirm the carrier-icon/eligibility view tests still pass (`decideWebrtcEligibility` is read at both video handshake ends and by room-view's payload parse — the Round 3 facts bullet lists the surfaces).
- [x] **Step 6:** `nix develop -c npm run verify`; commit (supersedes field-plan Task 8; closes D2).

### Task 5: the intent-diff policy

**Landed:** merge `423a8fc` into `docs/2026-09-01-intent-reconciliation`.

**Branch:** `feat/intent-diff-policy`

**Files:**
- Create: `ui/src/intent-diff-policy.ts`
- Create: `ui/src/__tests__/intent-diff-policy.test.ts`

**Interfaces:**
- Consumes: `LocalIntent` (Task 1), `CaptureLifecycle` (Task 2), `CAPTURE_REOPEN_MAX_ATTEMPTS` (Task 3).
- Produces: `describeIntentDiffs(input: IntentDiffInput): IntentDiff[]`, `describeLinkEstablishment(input): { copy: string } | null`, `INTENT_DIFF_GRACE_MS`. Task 6 renders exactly these.

**Design.** The user-feedback layer is a pure function so its copy and thresholds are table-pinned, per the repo's copy-pinning precedent (`settings-path.test.ts`, the reconnect-tile pins).

```ts
/** How long an intent may go unfulfilled before the UI says so. UI
 *  feedback pacing, NOT liveness — it exists so normal sub-second
 *  device acquisition and SDP exchange never flash a warning. */
export const INTENT_DIFF_GRACE_MS = 2000;

export type IntentDiff = {
  scope: 'mic' | 'camera' | 'carrier';
  severity: 'pending' | 'failed'; // pending = reconciler still trying
  since: number;                  // clock stamp the diff opened
  reason: string;                 // machine-readable, for logs
  copy: string;                   // exact user-facing string, pinned
};

export type IntentDiffInput = {
  intent: LocalIntent;
  micLifecycle: CaptureLifecycle;
  micAttempts: number;            // captureReconciler.micAttemptState (Task 3)
  cameraLifecycle: CaptureLifecycle;
  cameraAttempts: number;         // captureReconciler.cameraAttemptState
  carrierDownSince: number | undefined; // _signalCarrierDownSince
  now: number;
};
```

Arms (each a table row; copy is exact and lives only here):

| condition | diff |
|---|---|
| `mic.wanted` && lifecycle `ended`/`failed`/(`acquiring` past grace), attempts < max | `mic / pending / "Microphone unavailable — retrying…"` |
| same, attempts ≥ `CAPTURE_REOPEN_MAX_ATTEMPTS` | `mic / failed / "Microphone unavailable"` |
| camera symmetric | `camera / …` ("Camera unavailable — retrying…" / "Camera unavailable") |
| `carrierDownSince` set and past grace | `carrier / pending / "Your connection dropped — reconnecting…"` |
| everything else | no diff |

`since` is the lifecycle's `endedAt`/`failedAt`/`since` (or `carrierDownSince`) so the UI can show duration honestly.

`describeLinkEstablishment` centralizes the per-peer tile copy that today is the inline literal at `room-view.ts:3186`:

```ts
export function describeLinkEstablishment(input: {
  connected: boolean;
  /** the peer had a previous connected session this room-session
   *  (store's _lastDisconnectTime[peer] !== undefined) */
  reconnecting: boolean;
}): { copy: string } | null {
  if (input.connected) return null;
  return input.reconnecting
    ? { copy: 'connection lost — reconnecting…' }
    : { copy: 'establishing WebRTC carrier…' };
}
```

The distinction gives the user the reason not to press the reconnect button during recovery (Incident C, D8's UI half; the field plan's Task 6 behavior half — the button guard — stays in that plan and cites this copy).

**Declared:** `describeIntentDiffs` is a new surface. `describeLinkEstablishment` **replaces** the inline tile literal (Task 6 moves the render site onto it; leaving both would be the parallel-copy drift this repo bans).

- [x] **Step 1: Failing table tests** — every arm above; grace boundary exact; a satisfied intent (wanted + live) yields `[]`; `carrier` + `mic` diffs coexist (Incident B vs C were confusable precisely because only one of these had any surface — assert both appear when both hold); copy strings asserted verbatim.
- [x] **Step 2: Implement.** Green.
- [x] **Step 3:** `nix develop -c npm run verify`; commit.

### Task 6: render the diffs — buttons, tiles, banner

**Landed:** merge `3f3928c` into `docs/2026-09-01-intent-reconciliation`.

**Branch:** `feat/intent-diff-surfaces`

**Files:**
- Modify: `ui/src/streams-store.ts` (expose `intentDiffs: Readable<IntentDiff[]>`, recomputed in the presence-tick callback beside the reconcilers)
- Modify: `ui/src/room/room-view.ts` (mic/camera toggle render ~:1569-1600 and the camera equivalent; the event-mirror fields `_microphone`/`_camera` ~:287-290 and their updates ~:450-466; the tile status arm ~:3186; the room chrome for the banner)
- Test: create `ui/src/__tests__/intent-diff-surfaces.test.ts` (per-file jsdom, per the view-suite convention in `view-teardown-symmetry.test.ts`)

**Interfaces:**
- Consumes: `describeIntentDiffs`, `describeLinkEstablishment`, `IntentDiff` (Task 5); `localIntent` (Task 1).
- Produces: `StreamsStore.intentDiffs: Readable<IntentDiff[]>`.

**Design.** Three surfaces, one source. The store recomputes `_intentDiffs` (a `Writable<IntentDiff[]>`, exposed read-only) inside the presence-tick subscription — the same place the reconcilers fire, so the UI can never show a diff the reconciler isn't acting on.

1. **Toggle buttons render intent, badged by diff.** The mic button's on/off visual (`this._microphone`, `room-view.ts:1575`) now derives from `localIntent.mic` (`wanted && !muted`), and when an `intentDiffs` entry with scope `mic` exists the button gets a warning badge class (`pending` = pulsing amber, `failed` = static red slash) with `title` = the diff's `copy`. Camera symmetric. **Replaced mechanism (declared):** the `_microphone`/`_camera` event-mirror fields and their `my-audio-on`/`my-audio-off`/`my-video-*` update arms (~:450-466) are deleted — the button shows what the user asked for (which is what makes a wrong record self-correcting: a wrong button state is in front of the user and their click is the corrective write), while the badge shows that reality lags. Follow the existing store-subscription pattern room-view uses for other store reads (StoreSubscriber / `subscribe` in `connectedCallback` with teardown — check `view-teardown-symmetry.test.ts`'s pinned shapes and add the new subscription to its coverage).
2. **Tile establishment copy** routes through `describeLinkEstablishment` — the render arm at ~:3186 passes `reconnecting: store._lastDisconnectTime has the peer` (expose the minimal read the view needs; do not hand the view the raw record). The inline literal is deleted.
3. **The carrier banner** (absorbs field-plan Task 9): a room-level banner rendered when a `carrier` diff exists, text = the diff's `copy`, plus elapsed time from `since` ("… 45s"). Purely local, no wire change. This is the surface that would have ended Incident C's guessing, and — combined with the mic badge — would have let Incident B's users distinguish "my mic is dead" from "my network is gone" in one glance.

- [x] **Step 1: Store plumbing + failing wiring test** — drive the fake clock past the grace with a dead-but-wanted mic; assert `intentDiffs` contains the mic `pending` diff; let attempts exhaust; assert `failed`.
- [x] **Step 2: Failing view tests** (jsdom): (a) mic diff present → button carries the badge class and `title` equals the pinned copy; (b) no diff → no badge; (c) carrier diff → banner rendered with copy + elapsed seconds, absent otherwise; (d) tile shows `connection lost — reconnecting…` when `reconnecting`, `establishing WebRTC carrier…` on first establishment (copy via the Task 5 authority — assert the view imports it rather than duplicating strings, by asserting the literal appears in exactly one source file, grep-pin style).
- [x] **Step 3: Implement all three surfaces + the mirror-field deletion.**
- [x] **Step 4:** run the full view suite — `view-teardown-symmetry`, `screen-share-maximize-key`, `settings-path`, `agent-avatar-registration` pins must stay green; add the new subscription to the teardown-symmetry coverage.
- [x] **Step 5:** `nix develop -c npm run verify`; commit (absorbs field-plan Task 9 and Task 6's UI half — name both in the message).

### Task 7: doc-sync

**Landed:** this commit, on `docs/2026-09-01-intent-reconciliation`.

**Branch:** `docs/2026-09-01-intent-reconciliation`

- [x] **Step 1:** Mark each task in THIS document landed / not-landed (working agreement 3); update the Status header.
- [x] **Step 2:** Update `2026-09-01-field-incident-fixes.md`: its Tasks 1, 2, 8, 9 and Task 6's UI half get pointers to the superseding tasks here (or, if that plan has meanwhile landed some of them, record the actual sequence — whichever plan lands second reconciles the statuses).
- [x] **Step 3:** Add a `CLAUDE.md` "True today" bullet for the round: records of landed changes anchored to the merges; present-tense claims only where they name the enforcing file or test (`intent-write-sites.test.ts` is the load-bearing one to name); no test counts, no repo-state snapshots, no unanchored negations.
- [x] **Step 4:** `nix develop -c npm run verify` (includes `claude-md-drift.test.ts`); commit.

---

## Notes for reviewers

- **The write-sites pin is the keystone.** The intent layer's whole value rests on "no system writers"; if a reviewer finds `_applyIntent` called from an event handler, timer, or transport callback (other than the one documented screen-share gesture-equivalent), the task is wrong regardless of green tests.
- **Task 3's replacement list is the risk center.** Five named mechanisms die; the mutation checks in its Step 5 are what prove the replacements are load-bearing rather than parallel. Reviewer should re-run both mutations.
- **Task 4 deliberately does less than the field plan's Task 8 proposed.** The park-and-re-drive machinery is not built because the per-pong drive already re-evaluates; if the reviewer believes a case exists where no further pong arrives while the peer is present, that is a finding against this plan's claim — check `pingAgents`' cadence before filing it.
- **Copy is pinned on purpose.** The diff strings are product surface (they tell a user why their intent is unfulfilled); a silent copy change is a behavior change. Any copy edit goes through `intent-diff-policy.ts` and its table.
- **What this plan does NOT do:** no wire-surface change anywhere; no observation-state consolidation (the `PeerLink` record round is separate); no policy-override layer (extension point documented in `intent.ts`).
