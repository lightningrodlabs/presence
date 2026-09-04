# Owner Extraction Implementation Plan

**Status: LANDED on `owner-extraction`.** All seven tasks executed and committed to that branch (`818e5cd`..`ac62385` for the six code tasks, plus the Task 7 doc-sync commits and this fixup). Merging `owner-extraction` into `main-0.7` is a pending human step — this document describes the `owner-extraction` branch, not `main-0.7`, until that merge lands. The corresponding `CLAUDE.md` "True today" bullet was added by the Task 7 doc-sync (see the "Owner-extraction round facts" bullet).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift five concern clusters out of `ui/src/streams-store.ts` into owner objects (`PeerAudioLevels`, `MediaSettings`, `DiagnosticsHub`, `TrackHealthMonitor`, `ScreenShareLinks`), plus a narrow dead-code deletion — with zero behavior change.

**Architecture:** Each owner is a class over a bindings record (the `capture-reconciler.ts`/`room-ownership.ts` shape). Owners construct and own their concern's `Writable`s and non-record state; the store exposes same-named delegating members so views and tests keep their read paths. `PeerRecord` stays the one per-peer home, reached via injected accessors. Inbound edges become `this.<owner>.<method>()` at unchanged call sites; outbound edges become named binding callbacks.

**Tech Stack:** TypeScript strict, Svelte stores, vitest 1.6.1 (ui workspace), nix devshell (node 22).

**Spec:** `docs/superpowers/specs/2026-09-03-owner-extraction-design.md` — read it first. The identity rules, edge-resolution rules, and the screen-share gesture amendment come from there.

## Global Constraints

- Branch `owner-extraction` off `main-0.7` @ `d33834a`, worktree `.claude/worktrees/owner-extraction`. Landing target `main-0.7`.
- Gate before EVERY commit: `nix develop -c npm run verify` (run with the Bash sandbox disabled — sandboxed `nix develop` fails on `.gitmodules` yet exits 0; output must show real test summaries). Focused runs: `nix develop -c npm run test -w ui -- <path relative to ui/>`; never `npx vitest`.
- **Zero behavior change.** Moved method bodies are VERBATIM except the mechanical substitutions each task tables. Any `this.X` reference in a moved body not covered by that task's substitution table: STOP and report — do not improvise a binding.
- **Delegating members are bare forwards** — same name, same signature, single return/call statement. No reordering, no wrapping, no added guards.
- **Late-bound bindings**: every binding closure reads store fields at call time (`() => this.mediaTransport`, arrow functions), never captures a value at construction — this preserves the live-read semantics CLAUDE.md pins (storage-backed getters, transports created in `start()`).
- **Intent pin** (`ui/src/__tests__/intent-write-sites.test.ts`): the gesture methods it enumerates keep their exact header signatures in `streams-store.ts` and their `_applyIntent` calls; no `_applyIntent` call may move to an owner file.
- Each owner file joins `no-ambient-clock.test.ts` `PINNED_FILES` with `FULL_PATTERNS` in the task that creates it.
- Moved `logger.logAgentEvent` calls keep `event:` literals on their own lines (event-taxonomy grep walks the whole tree).
- Every task ends with a repo-wide grep (given per task) proving the moved member names have zero stale references — `ui/harness` is not typechecked, so `tsc` cannot catch a miss there.
- Stage explicit paths only — never `git add -A`. Commits: no co-authored footer, no emotional phrasing.
- Line numbers below were verified at `d33834a`; earlier tasks shift later numbers — re-locate by the quoted names, not the numbers.
- Construction stays assignment-only (`streams-store-construction.test.ts`): owners are constructed with `new X({...})` field initializers or constructor assignments; subscriptions stay in `start()`.

---

### Task 1: PeerAudioLevels

**Files:**
- Create: `ui/src/peer-audio-levels.ts`
- Create: `ui/src/__tests__/peer-audio-levels.test.ts`
- Modify: `ui/src/streams-store.ts` (moves: `setupPeerAudioAnalyser` 4457–4485, `getWebrtcAudioLevel` 4492–4504; call sites 1733, 1761; view surface consumer: `room/elements/audio-level-meter.ts:86` calls `streamsStore.getWebrtcAudioLevel` — unchanged, served by a delegate)
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts` (add pinned file)

**Interfaces:**
- Consumes: `PeerRecord` (`ui/src/peer-record.ts`), `_peerRecords`/`_ensurePeerRecord` (store).
- Produces: `PeerAudioLevels` with `setupPeerAudioAnalyser(pubKeyB64: string, stream: MediaStream): void` and `getWebrtcAudioLevel(pubKeyB64: string): number`; store field `peerAudioLevels: PeerAudioLevels`; store delegate `getWebrtcAudioLevel` (view surface).

- [x] **Step 1: Create `ui/src/peer-audio-levels.ts`**

```ts
/**
 * PeerAudioLevels — owner of the per-peer WebRTC AnalyserNode surface
 * (store-decomposition round two;
 * docs/superpowers/specs/2026-09-03-owner-extraction-design.md).
 * State lives on PeerRecord.analyser; this object owns the behavior.
 */
import type { AgentPubKeyB64 } from '@holochain/client';
import type { PeerRecord } from './peer-record';

export type PeerAudioLevelsBindings = {
  /** micSource.ensureAudioContext, late-bound. */
  ensureAudioContext: () => AudioContext | null;
  peerRecord: (k: AgentPubKeyB64) => PeerRecord | undefined;
  ensurePeerRecord: (k: AgentPubKeyB64) => PeerRecord;
};

export class PeerAudioLevels {
  constructor(private readonly b: PeerAudioLevelsBindings) {}

  // Bodies moved VERBATIM from streams-store.ts (d33834a:4457–4504) with
  // exactly these substitutions:
  //   this.micSource.ensureAudioContext()  -> this.b.ensureAudioContext()
  //   this._peerRecords.get(pubKeyB64)     -> this.b.peerRecord(pubKeyB64)
  //   this._ensurePeerRecord(pubKeyB64)    -> this.b.ensurePeerRecord(pubKeyB64)
  setupPeerAudioAnalyser(pubKeyB64: string, stream: MediaStream): void { /* moved body */ }
  getWebrtcAudioLevel(pubKeyB64: string): number { /* moved body */ }
}
```

(Move the two methods' full bodies and their doc comments; the comment blocks travel with them.)

- [x] **Step 2: Write `ui/src/__tests__/peer-audio-levels.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { PeerAudioLevels } from '../peer-audio-levels';
import { initialPeerRecord, type PeerRecord } from '../peer-record';

describe('PeerAudioLevels', () => {
  it('returns 0 with no record and no analyser', () => {
    const records = new Map<string, PeerRecord>();
    const levels = new PeerAudioLevels({
      ensureAudioContext: () => null,
      peerRecord: k => records.get(k),
      ensurePeerRecord: k => {
        let r = records.get(k);
        if (!r) { r = initialPeerRecord(); records.set(k, r); }
        return r;
      },
    });
    expect(levels.getWebrtcAudioLevel('peer')).toBe(0);
    expect(records.size).toBe(0); // a read never creates a row
  });

  it('setup is a no-op when the stream has no audio tracks', () => {
    const records = new Map<string, PeerRecord>();
    const levels = new PeerAudioLevels({
      ensureAudioContext: () => null,
      peerRecord: k => records.get(k),
      ensurePeerRecord: k => {
        let r = records.get(k);
        if (!r) { r = initialPeerRecord(); records.set(k, r); }
        return r;
      },
    });
    levels.setupPeerAudioAnalyser('peer', { getAudioTracks: () => [] } as unknown as MediaStream);
    expect(records.get('peer')?.analyser).toBeUndefined();
  });
});
```

- [x] **Step 3: Run it — FAIL (module absent) before Step 1 lands, PASS after.**

Run: `nix develop -c npm run test -w ui -- src/__tests__/peer-audio-levels.test.ts`

- [x] **Step 4: Wire the store**

In `streams-store.ts`: delete the two moved methods; add the field (near the other owner constructions — `captureReconciler` is the pattern):

```ts
peerAudioLevels: PeerAudioLevels = new PeerAudioLevels({
  ensureAudioContext: () => this.micSource.ensureAudioContext(),
  peerRecord: k => this._peerRecords.get(k),
  ensurePeerRecord: k => this._ensurePeerRecord(k),
});
```

(If field-initializer order puts this before `micSource`'s declaration, that is fine — the closure is late-bound — but if `tsc` complains about use-before-assign, move the construction into the constructor body as an assignment.)

Re-point the two internal call sites (1733, 1761): `this.setupPeerAudioAnalyser(...)` → `this.peerAudioLevels.setupPeerAudioAnalyser(...)`.
Add the view-surface delegate (bare forward):

```ts
getWebrtcAudioLevel(pubKeyB64: string): number {
  return this.peerAudioLevels.getWebrtcAudioLevel(pubKeyB64);
}
```

- [x] **Step 5: Add `'../peer-audio-levels.ts'` to `no-ambient-clock.test.ts` `PINNED_FILES` with `FULL_PATTERNS`.**

- [x] **Step 6: Reference grep**

Run: `grep -rn 'setupPeerAudioAnalyser\|getWebrtcAudioLevel' ui/ packages/ --include='*.ts' | grep -v peer-audio-levels`
Expected: only the store's delegate + two re-pointed call sites + `audio-level-meter.ts:86` + doc mentions.

- [x] **Step 7: Focused + full gate** — wiring suite + new test, then `nix develop -c npm run verify`. Green.

- [x] **Step 8: Commit**

```bash
git add ui/src/peer-audio-levels.ts ui/src/__tests__/peer-audio-levels.test.ts ui/src/streams-store.ts ui/src/__tests__/no-ambient-clock.test.ts
git commit -m "refactor: extract PeerAudioLevels owner from streams-store

Task 1 of docs/superpowers/plans/2026-09-03-owner-extraction.md. Verbatim
move; no behavior change."
```

---

### Task 2: MediaSettings

**Files:**
- Create: `ui/src/media-settings.ts`
- Modify: `ui/src/streams-store.ts` (moves, at d33834a: getters `trickleICE`/`turnUrl`/`turnUsername`/`turnCredential`/`cfTurnUrl`/`cfTurnUsername`/`cfTurnCredential` 291–322; `enableTrickleICE`/`disableTrickleICE` 2527–2533; `iceConfig` 2535–2561; `changeVideoInput` 2949–2961; `changeAudioInput` 3132–3146; `updateMediaDevices` 3436–3439; `audioInputDevices`/`videoInputDevices`/`audioOutputDevices` 3441–3457; `audioInputId`/`audioOutputId`/`videoInputId` 3459–3475; `Writable` fields `mediaDevices` 3434, `_audioInputId`/`_audioOutputId`/`_videoInputId` ~3459-region declarations)
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts`

**Interfaces:**
- Consumes: Task 1's pattern only.
- Produces: `MediaSettings` owning the four `Writable`s and all listed members; store delegates with IDENTICAL names/signatures for every member listed (external consumers: `room-view.ts` device pickers, `presence-app.ts`, transport option closures wired in `start()`/`store-deps`, `mic-source.ts`, `cloudflare-turn.ts`, wiring tests).

- [x] **Step 1: Create `ui/src/media-settings.ts`**

```ts
/**
 * MediaSettings — owner of device enumeration/selection and the
 * storage-backed ICE/TURN configuration (round two; see the design
 * spec). Storage reads stay LIVE (per-call), matching the Phase 6
 * live-closure pin in the wiring suite.
 */
import { writable, type Writable } from 'svelte/store';
import type { StreamsStoreDeps } from './store-deps';

export type MediaSettingsBindings = {
  /** deps.storage.local — live handle. */
  storage: StreamsStoreDeps['storage']['local'];
  /** deps.mediaDevices — enumerateDevices source. */
  mediaDevices: StreamsStoreDeps['mediaDevices'];
  /** micSource.changeDevice / cameraSource.changeDevice, late-bound. */
  changeMicDevice: (deviceId: string) => Promise<void>;
  changeCameraDevice: (deviceId: string) => Promise<void>;
  /** StreamsStore._broadcastRtcAction, late-bound. */
  broadcastRtcAction: (action: 'change-audio-input' | 'change-video-input') => void;
  logAgentEvent: (e: { agent: string; timestamp: number; event: string }) => void;
  now: () => number;
  myPubKeyB64: () => string;
};

export class MediaSettings {
  mediaDevices: Writable<MediaDeviceInfo[]> = writable([]);
  _audioInputId: Writable<string | undefined> = writable(undefined);
  _audioOutputId: Writable<string | undefined> = writable(undefined);
  _videoInputId: Writable<string | undefined> = writable(undefined);

  constructor(private readonly b: MediaSettingsBindings) {}
  // ...moved members, verbatim, with the substitution table below...
}
```

Substitution table for the moved bodies (complete — anything else: STOP):

| In the moved body | Becomes |
|---|---|
| `this.deps.storage.local` | `this.b.storage` |
| `this.deps.mediaDevices` | `this.b.mediaDevices` |
| `this.micSource.changeDevice(deviceId)` | `this.b.changeMicDevice(deviceId)` |
| `this.cameraSource.changeDevice(deviceId)` | `this.b.changeCameraDevice(deviceId)` |
| `this._broadcastRtcAction('…')` | `this.b.broadcastRtcAction('…')` |
| `this.logger.logAgentEvent({...})` | `this.b.logAgentEvent({...})` (keep the `event:` literal line verbatim) |
| `this.clock.now()` | `this.b.now()` |
| `this.myPubKeyB64` | `this.b.myPubKeyB64()` |
| `this.mediaDevices` / `this._audioInputId` / `this._audioOutputId` / `this._videoInputId` | `this.mediaDevices` / same (now the owner's own fields) |

Move `DEFAULT_ICE_SERVERS` usage: `iceConfig` references the module-level `DEFAULT_ICE_SERVERS` constant — move the constant to `media-settings.ts` if streams-store has no other reader (grep first; if it has another reader, import it in media-settings from where it lives).

- [x] **Step 2: Wire the store**

Construct (assignment style as Task 1):

```ts
mediaSettings: MediaSettings = new MediaSettings({
  storage: this.deps.storage.local,
  mediaDevices: this.deps.mediaDevices,
  changeMicDevice: id => this.micSource.changeDevice(id),
  changeCameraDevice: id => this.cameraSource.changeDevice(id),
  broadcastRtcAction: a => this._broadcastRtcAction(a),
  logAgentEvent: e => this.logger.logAgentEvent(e as never),
  now: () => this.clock.now(),
  myPubKeyB64: () => this.myPubKeyB64,
});
```

CAUTION: `this.deps` must be assigned before this field initializer runs — if it is a constructor parameter property, field initializers run after parameter assignment, which is fine; verify with `tsc` and, if ordering bites, construct in the constructor body after `this.deps` is set. If `logAgentEvent`'s type needs the real `SimpleEvent` type, import and use it instead of the inline shape — no `as never` hacks that loosen typing beyond what exists today.

Delete every moved member from the store; add bare-forward delegates with identical names for ALL of them, e.g.:

```ts
get trickleICE(): boolean { return this.mediaSettings.trickleICE; }
get iceConfig(): RTCIceServer[] { return this.mediaSettings.iceConfig; }
async changeAudioInput(deviceId: string) { return this.mediaSettings.changeAudioInput(deviceId); }
audioInputDevices() { return this.mediaSettings.audioInputDevices(); }
get _audioInputId() { return this.mediaSettings._audioInputId; }
// …and likewise for every member in the Files list.
```

(Check each original's getter-vs-method shape and mirror it exactly — `trickleICE` and `iceConfig` are getters today; the device lists are methods; the `Writable`s become delegating getters returning the owner's instances.)

- [x] **Step 3: Add `'../media-settings.ts'` to `no-ambient-clock.test.ts` `PINNED_FILES` with `FULL_PATTERNS`.** (The owner takes `now` injected; it must contain no `Date.now`/`new Date`/bare `setTimeout` — the moved bodies already comply.)

- [x] **Step 4: Reference grep**

Run: `grep -rn 'trickleICE\|turnUrl\|turnUsername\|turnCredential\|cfTurnUrl\|iceConfig\|updateMediaDevices\|InputDevices\|OutputDevices\|audioInputId\|audioOutputId\|videoInputId\|changeVideoInput\|changeAudioInput' ui/ --include='*.ts' | grep -v media-settings | grep -v '\.md'`
Expected: store delegates + external consumers unchanged (room-view, presence-app, store-deps, mic-source, cloudflare-turn, wiring tests) — zero references that would now dangle.

- [x] **Step 5: Focused + full gate** — `settings-path.test.ts`, wiring suite, then full verify. The wiring suite's live-closure pins (iceServers/trickleICE live-read) MUST stay green unmodified — if one fails, a binding captured a value; fix the binding, never the test.

- [x] **Step 6: Commit**

```bash
git add ui/src/media-settings.ts ui/src/streams-store.ts ui/src/__tests__/no-ambient-clock.test.ts
git commit -m "refactor: extract MediaSettings owner from streams-store

Task 2. Verbatim moves behind live-read bindings; store keeps same-named
delegates. No behavior change."
```

---

### Task 3: DiagnosticsHub

**Files:**
- Create: `ui/src/diagnostics-hub.ts`
- Modify: `ui/src/streams-store.ts` (moves, at d33834a: `clearReceivedDiagnostics` 3751–3764; `requestDiagnosticLogs` 5094–5117; `_computeDiagnosticAttemptTimeout` 5128–5140; `_startDiagnosticAttempt` 5148–5184; `exportMergedLogs` 5189–5259; `exportMergedLogsAll` 5267–5336; `handleDiagnosticRequest` 6795–6814; `handleDiagnosticResponse` 6819–6852; `Writable` fields `_receivedDiagnosticLogs`/`_pendingDiagnosticRequests`/`_failedDiagnosticRequests` ~3720–3740 region; `_conversationParticipants` 3744)
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts`

**Interfaces:**
- Consumes: owner pattern.
- Produces: `DiagnosticsHub` owning the three `Writable`s + participants set, with the moved methods plus `noteConversationParticipant(k: AgentPubKeyB64): void` (replacing the store's direct `_conversationParticipants.add` in `_handleMediaConnected`). Store delegates: the three `Writable` getters, `clearReceivedDiagnostics`, `requestDiagnosticLogs`, `exportMergedLogs`, `exportMergedLogsAll` (view surface: `room-view.ts:204–218, 1402–1433`; wiring tests `streams-store-wiring.test.ts:1922–1942`); `_processSignal`'s two cases re-point to `this.diagnosticsHub.handleDiagnosticRequest/Response`.

Bindings record:

```ts
export type DiagnosticsHubBindings = {
  sendMessage: (agents: AgentPubKey[], payload: unknown) => Promise<void>; // mirror bus.sendMessage's REAL signature — copy it from store-deps.ts
  logger: PresenceLogger;              // the hub reads getRecentAgentEvents/getRecentCustomLogs/sessionId and logs
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => number;   // clock.setTimeout
  clearTimeout: (h: number) => void;                     // clock.clearTimeout
  myPubKeyB64: () => string;
  /** StreamsStore.globalPresenceSet(), late-bound (recipient list). */
  globalPresenceSet: () => Set<AgentPubKeyB64>;
  /** peer record's signalsRttEwma, read-only (RTT-scaled timeout). */
  peerRttEwma: (k: AgentPubKeyB64) => number | undefined;
};
```

(Verify each field against the moved bodies' actual uses — the bodies are the authority for the exact signature; extend the record if a body reads something not listed, and STOP if that something is another cluster's mutable state.)

- [x] **Step 1: Create the hub with the moved members (verbatim + substitution table analogous to Task 2 — `this.deps.bus.sendMessage`→`this.b.sendMessage`, `this.clock.now()`→`this.b.now()`, `this.clock.setTimeout/clearTimeout`→bindings, `this._peerRecords.get(k)?.signalsRttEwma`→`this.b.peerRttEwma(k)`, `this.globalPresenceSet()`→`this.b.globalPresenceSet()`, writables/set→own fields).**
- [x] **Step 2: Wire the store: construct `diagnosticsHub`, delete moved members, add the delegating getters/methods, re-point `_processSignal`'s `DiagnosticRequest`/`DiagnosticResponse` cases and `_handleMediaConnected`'s participant add (`this.diagnosticsHub.noteConversationParticipant(pubKeyB64)`).**
- [x] **Step 3: Add `'../diagnostics-hub.ts'` to the no-ambient-clock pin (FULL_PATTERNS).**
- [x] **Step 4: Reference grep:** `grep -rn 'DiagnosticLogs\|DiagnosticRequest\|DiagnosticResponse\|exportMergedLogs\|_conversationParticipants\|DiagnosticAttempt' ui/ --include='*.ts' | grep -v diagnostics-hub | grep -v '\.md'` — no dangles.
- [x] **Step 5: Focused + full gate** — the wiring suite's diagnostic retry tests (1922–1942) must pass UNMODIFIED (they drive `store.requestDiagnosticLogs` + `store._pendingDiagnosticRequests`, both delegated).
- [x] **Step 6: Commit** (explicit paths; message: `refactor: extract DiagnosticsHub owner from streams-store` + Task 3 trailer as in Task 1).

---

### Task 4: TrackHealthMonitor

**Files:**
- Create: `ui/src/track-health.ts`
- Modify: `ui/src/streams-store.ts` (moves, at d33834a: `_checkTrackHealth` 5645–5711; `reconcileVideoStreamState` 4857–4961; `_tryReplaceTrackRecovery` 4976–4994; `_cloneStreamRecovery` 5006–5016; `refreshTracksForPeer` 5022–5057. NOT moving: `_applyStaleTeardown` — it is the shared teardown bridge into `_applyCloseCleanup` and stays on the store, reached via a binding.)
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts`

**Interfaces:**
- Consumes: owner pattern; `decideTrackHealth`/track-health-policy imports move with the bodies.
- Produces: `TrackHealthMonitor` with `checkTrackHealth(): Promise<void>`, `reconcileVideoStreamState(pubkey: AgentPubKeyB64, ...): ...`, `refreshTracksForPeer(pubKeyB64: AgentPubKeyB64): ...` (copy exact signatures from the moved bodies). Inbound re-points: `pingAgents` (2719) → `this.trackHealth.checkTrackHealth()`; `handlePongUi` (6337) → `this.trackHealth.reconcileVideoStreamState(...)`; `_handleMediaRemoteTrack` (1838) → `this.trackHealth.refreshTracksForPeer(...)`. No view surface — no store delegates needed; delete the store methods outright.

Bindings record (verify against bodies; STOP on uncovered `this.X`):

```ts
export type TrackHealthBindings = {
  mediaTransport: () => PeerTransport;       // late-bound: getStats, refreshMediaForPeer, hasConnection
  openConnections: () => Record<AgentPubKeyB64, OpenConnectionInfo>;  // () => get(this._openConnections)
  applyStaleTeardown: (target: CloseCleanupTarget, peer: AgentPubKeyB64, iceState: string) => void;
  sendRtcAction: (peer: AgentPubKeyB64, action: string) => void;      // mirror _sendRtcAction's real signature
  maybeEmitQualityChange: (...) => void;                               // mirror _maybeEmitQualityChange's real signature
  peerRecord: (k: AgentPubKeyB64) => PeerRecord | undefined;
  ensurePeerRecord: (k: AgentPubKeyB64) => PeerRecord;
  micLifecycle: () => CaptureLifecycle;
  cameraLifecycle: () => CaptureLifecycle;
  localIntent: () => LocalIntent;            // if the bodies read it (verify)
  logger: PresenceLogger;
  now: () => number;
  myPubKeyB64: () => string;
};
```

- [x] **Step 1: Create the owner with verbatim bodies + the substitution table (same style as Tasks 2–3; the table rows come 1:1 from the bindings above).**
- [x] **Step 2: Wire the store: construct `trackHealth`, delete the five moved methods, re-point the three inbound call sites.**
- [x] **Step 3: no-ambient-clock pin (`'../track-health.ts'`, FULL_PATTERNS).**
- [x] **Step 4: Reference grep:** `grep -rn '_checkTrackHealth\|reconcileVideoStreamState\|refreshTracksForPeer\|ReplaceTrackRecovery\|CloneStreamRecovery' ui/ --include='*.ts' | grep -v track-health | grep -v '\.md'` — remaining hits only the three re-pointed call sites and policy-file prose (update `transport/track-health-policy.ts`'s constraining comment to cite `ui/src/track-health.ts`, working agreement 3).
- [x] **Step 5: Focused + full gate** — wiring suite (its track-health/encoder tests drive `pingAgents`, which now delegates) unmodified and green.
- [x] **Step 6: Commit** (`refactor: extract TrackHealthMonitor owner from streams-store`, Task 4 trailer).

---

### Task 5: ScreenShareLinks

**Files:**
- Create: `ui/src/screen-share-links.ts`
- Modify: `ui/src/streams-store.ts` (moves, at d33834a: `_screenShareStore` 1908–1912; `_subscribeScreenShareTransport` 1013–1097; `_handleScreenShareIceDiagnostic` 1279–1289; `_handleScreenShareConnected` 1914–1963; `_handleScreenShareClosed` 1965–1990; `_handleScreenShareRemoteStream` 1992–2020; `_handleScreenShareRemoteTrack` 2022–2044; `_handleScreenShareError` 2046–2083; `_ensureOutgoingScreenShare` 3251–3272; `disconnectFromPeerScreen` 3378–3382; `updateScreenShareConnectionStatus` 4802–4847; `handleSdpFsmScreen` 6746–6790; `Writable` fields `_screenShareConnectionsOutgoing`/`_screenShareConnectionsIncoming` ~3600-region and `_screenShareConnectionStatuses` ~3690-region. NOT moving, per the spec amendment: `screenShareOn` 3274–3337, `screenShareOff` 3342–3358, `stopScreenShare` 3367–3370 — gesture methods pinned by `intent-write-sites.test.ts`; their bodies keep acquisition, intent writes, `onended` wiring, module activation, and direct transport track calls, and read the connections `Writable` through the store's delegating getter.)
- Modify: `ui/src/__tests__/no-ambient-clock.test.ts`

**Interfaces:**
- Consumes: owner pattern; `decideScreenSignalRoute`, `decideSlotWrite`, `attributeSlotEvent`, `closeCleanupPlan` imports move with the bodies as needed.
- Produces: `ScreenShareLinks` owning the three `Writable`s, with `subscribe(transport: PeerTransport, initiator: boolean)` (the moved `_subscribeScreenShareTransport`), `ensureOutgoingScreenShare(k)`, `disconnectFromPeerScreen(k)`, `updateScreenShareConnectionStatus(...)`, `handleSdpFsmScreen(...)`. Store delegates: the three `Writable` getters (wiring tests + views read `store._screenShareConnectionsOutgoing` etc.), `disconnectFromPeerScreen` (view surface). Inbound re-points: `start()`'s two `_subscribeScreenShareTransport` calls → `this.screenShareLinks.subscribe(...)`; `handlePingUi` (5957) and `handlePongUi` (6390) → `this.screenShareLinks.ensureOutgoingScreenShare(...)`; `_processSignal`'s `SdpFsmScreen` case → owner; `handleLeaveUi`/`updateConnectionStatus` sites that call `updateScreenShareConnectionStatus` → owner.

Bindings record (verify against bodies; STOP on uncovered `this.X`):

```ts
export type ScreenShareLinksBindings = {
  outTransport: () => PeerTransport;   // late-bound; created in start()
  inTransport: () => PeerTransport;
  applyCloseCleanup: (/* mirror _applyCloseCleanup's exact signature */) => void;
  computeSdpTimeout: () => number;
  nextConnectionEpoch: (peer: AgentPubKeyB64) => number;
  peerCaps: (peer: AgentPubKeyB64) => ReadonlySet<string>;
  peerRecord: (k: AgentPubKeyB64) => PeerRecord | undefined;
  ensurePeerRecord: (k: AgentPubKeyB64) => PeerRecord;
  eventCallback: (e: /* StreamsStore event union */) => void;
  logger: PresenceLogger;
  now: () => number;
  myPubKeyB64: () => string;
  screenShareStream: () => MediaStream | null | undefined;  // the local share, read by connected-handler track attach
};
```

- [x] **Step 1: Create the owner with verbatim bodies + substitution table (rows 1:1 from bindings; `this._screenShareConnectionsOutgoing` etc. become own fields).**
- [x] **Step 2: Wire the store: construct `screenShareLinks`; delete moved members; add the three `Writable` delegating getters + `disconnectFromPeerScreen` delegate; re-point every inbound site listed above; `screenShareOff`'s loop keeps reading `get(this._screenShareConnectionsOutgoing)` (now the delegate) and calling `this.screenShareOutTransport.closeConnection(...)` directly — unchanged.**
- [x] **Step 3: no-ambient-clock pin (`'../screen-share-links.ts'`, FULL_PATTERNS).**
- [x] **Step 4: Reference grep:** `grep -rn '_subscribeScreenShareTransport\|_handleScreenShare\|_ensureOutgoingScreenShare\|handleSdpFsmScreen\|updateScreenShareConnectionStatus\|_screenShareStore' ui/ --include='*.ts' | grep -v screen-share-links | grep -v '\.md'` — remaining hits only re-pointed call sites, delegates, and prose (update `transport/screen-signal-policy.ts` + `wire-contract.ts` + `media-event-policy.ts` + `init-retry-policy.ts` constraining comments to cite `ui/src/screen-share-links.ts`; `ui/harness/screen-share*.ts` headers likewise).
- [x] **Step 5: Run the intent pin + wiring suite + full gate** — `intent-write-sites.test.ts` green UNMODIFIED (the gesture methods did not move); the wiring suite's screen-share lifecycle tests (377–462, 619–692) green UNMODIFIED (they read the delegating getters and call `store.screenShareOn()`).
- [x] **Step 6: Commit** (`refactor: extract ScreenShareLinks owner from streams-store`, Task 5 trailer; note the gesture-methods-stay amendment in the body).

---

### Task 6: Janitorial — verified-dead deletions

**Files:**
- Modify: `ui/src/streams-store.ts`

- [x] **Step 1: Verify `mainStreamClones` is dead**

Run: `grep -rn 'mainStreamClones' ui/ --include='*.ts'`
Expected: the field declaration (~3491), the `start()` loop (~740), comment mentions (~2214, ~3212), and nothing that ever pushes to it. If ANY `.push(` or assignment other than the `= []` initializer appears: STOP and report — it is not dead.

- [x] **Step 2: Delete** the field, the no-op loop in `start()`'s `onMutedChange` callback, and rewrite the two comments that cite it (keep each comment's surviving claim; drop only the clone-fanout clause).

Do NOT touch: the `SdpData` drop arm, the screen-typed Init log-and-drop branches (declared diagnostic arms), or any commentary block that is itself the declaration of a prior deletion.

- [x] **Step 3: Full gate; commit** (`chore: delete dead mainStreamClones fan-out`, notes the verification grep in the body).

---

### Task 7: Doc-sync

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-09-03-owner-extraction-design.md`, this plan file.

- [x] **Step 1: CLAUDE.md "True today" bullet** — follow the existing round bullets' contract exactly (anchored to date + branch + commit range; present tense only naming the enforcing file/test; no counters/snapshots/unanchored negations — `claude-md-drift.test.ts` is the guard). Record: the five owner files as the one home of each concern's behavior (each in `no-ambient-clock.test.ts`'s pin list); store keeps same-named delegating members (bare forwards); gesture entry points stayed on the store (`intent-write-sites.test.ts` unchanged); `PeerRecord` unchanged as the per-peer state home; `mainStreamClones` deleted as verified-dead; zero declared behavior changes.
- [x] **Step 2: Spec landed-markers** on each task; the round-three list stays open (pong/ping fragment splits, transport-glue kernel, composition root, reactive unification, forensic fold).
- [x] **Step 3: Drift guard + full gate; commit** (`docs: sync CLAUDE.md and round docs for owner extraction`).

---

## Deliberately out of scope (from the spec)

`handlePongUi`/`pingAgents` fragment splits; the transport-glue/close-cleanup kernel (`_applyCloseCleanup` stays store-owned; owners reach it via bindings); `start()`/`disconnect()`; reactive-`Writable` unification; `_iceTimings`/`_sdpDataAggregates`.

## Notes for reviewers

- The review question is "prove this is identity": every moved body diffed against its origin at `d33834a` must show ONLY the substitution-table rewrites; every delegate must be a bare forward; every binding must be late-bound (an arrow reading store state at call time). A binding that snapshots at construction is a behavior change (the live-read pins in the wiring suite are the canary for storage/transport bindings, but not every binding has a pin — check by reading).
- Tasks must not modify the wiring suite's assertions, `intent-write-sites.test.ts`, or `settings-path.test.ts` — those staying green unmodified IS the evidence. Mechanical additions (no-ambient-clock pin entries) are the only expected test edits besides the two new owner test files.
- Per-task reference greps are load-bearing: `ui/harness` is outside the typecheck.
