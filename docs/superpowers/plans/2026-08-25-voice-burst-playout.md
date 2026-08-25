# Voice Burst Playout (skip-to-newest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the signals voice path delivers a burst of backlogged frames, play the newest ~jitter-buffer's worth instead of the oldest, without reintroducing the double-audio overlap bug.

**Architecture:** One decision-arm change in the pure `decidePlayout` (`overcap-drop` → `cancel-restart`/`skip-to-newest`) plus one small, unit-testable `ScheduledSourceLedger` that lets `voice.ts` cancel already-scheduled `AudioBufferSourceNode`s before re-anchoring. No queue, no adaptive state, no new timers, no config.

**Tech Stack:** TypeScript, vitest (pure tables), existing Playwright browser harness (`ui/harness/voice-playout-harness.html` / `voice-playout.spec.ts`, real WebCodecs + AudioContext).

**Spec:** The 2026-08-25 field diagnosis (memory: `presence-signals-audio-diagnosis`; logs `~/Downloads/Presence_merged_0.15.1_2026-8-25-*.json`, `Presence.json`) plus `docs/SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md` (the prior fix this supersedes in part).

## Decision first: is this worth doing?

**What the current policy does under a burst.** `decidePlayout` (`ui/src/room/modules/voice-playout.ts`) schedules the first ~480 ms (`JITTER_BUFFER_MS` 80 + `PLAYBACK_RESET_DRIFT_MS` 400) of a delivered backlog and drops every later frame (`overcap-drop`). Two consequences: (1) each burst plays its **oldest** fragment — under sustained bursty delivery the listener hears stale fragments then silence, never current speech; (2) after a burst with no following gap, playout parks at ~+480 ms latency until the next `behind` reset.

**Field magnitudes (2026-08-25).** SPd's client discarded 306 frames of lMp's voice (68 gap-resets alongside); lMp's client discarded 418 frames of Ek5's and 214 of Gb0's; local discarded 243 of lMp's. Critically, a large share of those drops occurred at **moderate** signal RTTs (SPd↔lMp bucket lines around 270–380 ms) — the regime where delivery is bursty but the pair is otherwise usable, i.e. exactly where a better burst policy would be audible. On the **collapsed** pairs (8–13 s RTT, 95 % loss) no playout policy makes speech usable.

**Options considered.**

| | Behavior under a burst | Complexity | Risk |
|---|---|---|---|
| A. Status quo | oldest ~480 ms plays, rest dropped, +480 ms latency parking | none | none |
| B. Skip-to-newest (this plan) | newest ~480 ms plays, latency stays ~jitter | +1 decision arm, +1 ~30-line ledger, ~15 lines in voice.ts | overlap-bug regression — bounded by the two existing harness tiers |
| C. Adaptive jitter depth | most of the speech plays at +1–2 s latency | burst detector, adaptive depth state, drain policy | new latency/liveness interactions; the complexity the 3-option framing exists to avoid |

C is **rejected** for now (YAGNI — and the pathology is being attacked at its sources: webrtc-peer 0.5.0 actually shipping removes the candidate-storm load, TURN removes the biggest signals-only pair class).

**Recommendation: hold B until one field session on 0.15.2, then decide by the gate below.** 0.15.2's other changes alter both the load (0.5.0 dedupe/backoff) and the measurement (FilmstripRx lines + 5× snapshot caps), so a post-0.15.2 session answers the worth-it question with data instead of extrapolation.

**Decision gate (objective, from a 0.15.2 merged log):** implement B if any peer pair shows `VoicePlayoutReset … overcap-drop` totals **> 50 per 10 minutes** while that pair's `QualityBucketChange signals:` lines stay in the `ok`/`poor` RTT bands (< 400 ms) and `FilmstripRx` shows video flowing — i.e. the moderate-burst regime persists after the load fixes. If drops concentrate only on collapsed pairs (`bad` band, multi-second RTT), hold — B would buy little there.

The tasks below are complete and ready to execute if the gate fires (or if the decision is to ship it in 0.15.2 anyway).

## Global Constraints

- All test/build commands run under `nix develop -c` (repo instruction).
- Working agreements apply: replace-don't-parallel (the `overcap-drop` arm is **replaced**, not joined), pure decision functions with reason tags, no new threshold constants (`JITTER_BUFFER_MS` and `PLAYBACK_RESET_DRIFT_MS` keep their roles).
- `decidePlayoutLegacy` stays — it exists to demonstrate the overlap bug in tests.
- Field log vocabulary changes: the `VoicePlayoutReset` branch name `overcap-drop` becomes `skip`; declare in the commit message (log consumers are humans and the demoted `logs-graph.ts`, which renders unknown kinds in its default arm by design).
- Base branch: stack on `chore/diagnostic-snapshot-caps` (or `main-0.7` after that stack merges).

---

### Task 1: New decision arm in `decidePlayout`

**Files:**
- Modify: `ui/src/room/modules/voice-playout.ts`
- Test: `ui/src/room/modules/__tests__/voice-playout.test.ts`

**Interfaces:**
- Produces: `PlayoutDecision` gains `action: 'cancel-restart'` and reason `'skip-to-newest'`; the `'overcap-drop'` reason and `action: 'drop'` are deleted. Task 3 consumes this exact union.

- [ ] **Step 1: Write the failing table rows**

Append to `voice-playout.test.ts` (adjust imports to the file's existing style):

```typescript
describe('skip-to-newest (burst) arm', () => {
  const frame = 0.02, jitter = 0.08, drift = 0.4;

  it('a head deeper than jitter+drift cancels and re-anchors at now+jitter', () => {
    const d = decidePlayout(10.0 + jitter + drift + 0.001, 10.0, frame, jitter, drift);
    expect(d).toEqual({
      action: 'cancel-restart',
      at: 10.0 + jitter,
      nextPlaybackTime: 10.0 + jitter + frame,
      reason: 'skip-to-newest',
    });
  });

  it('a head exactly at the cap still plays steady (boundary unchanged)', () => {
    const d = decidePlayout(10.0 + jitter + drift, 10.0, frame, jitter, drift);
    expect(d.action).toBe('play');
    expect(d.reason).toBe('steady');
  });

  it('an instantaneous burst ends with only the newest tail surviving, no overlap', () => {
    // Model: frames 0..149 (3 s of audio) all arrive at now=10.0.
    // Track (at, cancelled) per frame; a cancel-restart cancels every
    // pending prior frame. Assert: surviving intervals are contiguous,
    // non-overlapping, and are a SUFFIX of the burst (the newest tail).
    let head = 10.0 - 0.5; // stale head from before the gap
    const scheduled: { i: number; at: number; cancelled: boolean }[] = [];
    for (let i = 0; i < 150; i++) {
      const d = decidePlayout(head, 10.0, frame, jitter, drift);
      if (d.action === 'cancel-restart') {
        for (const s of scheduled) if (s.at > 10.0) s.cancelled = true;
      }
      scheduled.push({ i, at: d.at, cancelled: false });
      head = d.nextPlaybackTime;
    }
    const survivors = scheduled.filter(s => !s.cancelled);
    // Suffix: survivor indices are exactly the last N frames.
    const first = survivors[0].i;
    expect(survivors.map(s => s.i)).toEqual(
      Array.from({ length: 150 - first }, (_, k) => first + k),
    );
    // Newest tail is bounded by the buffer depth (~cap/frame + 1).
    expect(survivors.length).toBeLessThanOrEqual(Math.ceil((jitter + drift) / frame) + 1);
    // No overlap among survivors.
    for (let k = 1; k < survivors.length; k++) {
      expect(survivors[k].at).toBeGreaterThanOrEqual(survivors[k - 1].at + frame - 1e-9);
    }
  });
});
```

Delete/rewrite the existing rows that assert `action: 'drop'` / `reason: 'overcap-drop'` for the production function (keep every `decidePlayoutLegacy` row untouched).

- [ ] **Step 2: Run and verify the new rows fail** — `cd ui && nix develop ../. -c npx vitest run src/room/modules/__tests__/voice-playout.test.ts` — expect failures on the three new rows (current code returns `action: 'drop'`).

- [ ] **Step 3: Implement**

In `voice-playout.ts`:

```typescript
export type PlayoutReason = 'first' | 'behind' | 'steady' | 'skip-to-newest';

export interface PlayoutDecision {
  /** `play`: schedule at `at`. `cancel-restart`: stop everything still
   *  scheduled, then schedule this frame at `at` — the burst-shedding
   *  branch, which keeps the NEWEST audio instead of the oldest. */
  action: 'play' | 'cancel-restart';
  at: number;
  nextPlaybackTime: number;
  reason: PlayoutReason;
}
```

Replace the over-cap branch:

```typescript
  if (head > now + jitterSec + driftSec) {
    // Buffer deeper than the drift cap — frames arrived faster than real
    // time. The pre-2026-08 policy dropped THIS frame and kept the head,
    // which played the OLDEST ~480 ms of every burst and parked latency
    // at the cap. Cancel what is still scheduled and re-anchor instead:
    // the executor stops the pending sources (so this cannot overlap —
    // the hazard decidePlayoutLegacy demonstrates) and the newest audio
    // plays at ~jitter latency.
    const at = now + jitterSec;
    return {
      action: 'cancel-restart',
      at,
      nextPlaybackTime: at + frameDurationSec,
      reason: 'skip-to-newest',
    };
  }
```

Update the file-header comment (it currently documents drop-based shedding as the trade) and the `decidePlayout` doc comment.

- [ ] **Step 4: Run the file's suite; all green.**
- [ ] **Step 5: Commit** — `git add ui/src/room/modules/voice-playout.ts ui/src/room/modules/__tests__/voice-playout.test.ts && git commit` — message notes: supersedes the drop arm of the double-audio fix (name the `SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md` doc), keeps its overlap invariant by cancellation.

### Task 2: `ScheduledSourceLedger`

**Files:**
- Create: `ui/src/room/modules/scheduled-source-ledger.ts`
- Test: `ui/src/room/modules/__tests__/scheduled-source-ledger.test.ts`

**Interfaces:**
- Produces: `class ScheduledSourceLedger { add(source: Stoppable, endsAt: number): void; prune(now: number): void; cancelPending(now: number): void; size(): number }` with `type Stoppable = { stop(): void }`. Task 3 consumes exactly these names.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { ScheduledSourceLedger } from '../scheduled-source-ledger';

const src = () => ({ stop: vi.fn() });

describe('ScheduledSourceLedger', () => {
  it('prune drops entries that have finished playing', () => {
    const l = new ScheduledSourceLedger();
    l.add(src(), 1.0);
    l.add(src(), 2.0);
    l.prune(1.5);
    expect(l.size()).toBe(1);
  });

  it('cancelPending stops only sources still scheduled or playing, and empties', () => {
    const l = new ScheduledSourceLedger();
    const done = src(), pending = src();
    l.add(done, 1.0);
    l.add(pending, 9.0);
    l.cancelPending(1.5);
    expect(done.stop).not.toHaveBeenCalled();
    expect(pending.stop).toHaveBeenCalledOnce();
    expect(l.size()).toBe(0);
  });

  it('negative control: a stop() that throws does not wedge the cancel', () => {
    const l = new ScheduledSourceLedger();
    const bad = { stop: vi.fn(() => { throw new Error('InvalidStateError'); }) };
    const good = src();
    l.add(bad, 9.0);
    l.add(good, 9.0);
    l.cancelPending(0);
    expect(good.stop).toHaveBeenCalledOnce();
    expect(l.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL (module not found).**
- [ ] **Step 3: Implement**

```typescript
/**
 * Tracks the AudioBufferSourceNodes voice playout has scheduled but that
 * may not have finished, so the skip-to-newest branch
 * (`decidePlayout` action `cancel-restart`) can stop them before
 * re-anchoring. Without this cancellation, re-anchoring backward is the
 * double-audio overlap bug (docs/SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md);
 * with it, the newest audio replaces the stale backlog. Bounded: at
 * most ~(JITTER_BUFFER_MS + PLAYBACK_RESET_DRIFT_MS)/frame entries live
 * at once, and `prune` is called on every frame.
 */
export type Stoppable = { stop(): void };

export class ScheduledSourceLedger {
  private entries: { source: Stoppable; endsAt: number }[] = [];

  add(source: Stoppable, endsAt: number): void {
    this.entries.push({ source, endsAt });
  }

  /** Forget entries whose playback has already ended. */
  prune(now: number): void {
    this.entries = this.entries.filter(e => e.endsAt > now);
  }

  /** Stop everything still scheduled or playing; clear the ledger. */
  cancelPending(now: number): void {
    for (const e of this.entries) {
      if (e.endsAt > now) {
        try { e.source.stop(); } catch { /* already stopped/ended */ }
      }
    }
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }
}
```

- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.**

### Task 3: Wire the executor in `voice.ts`

**Files:**
- Modify: `ui/src/room/modules/voice.ts` (the playout site around the `decidePlayout` call, ~line 800–830, and `_logPlayoutReset`)

**Interfaces:**
- Consumes: Task 1's `PlayoutDecision` union; Task 2's `ScheduledSourceLedger`.

- [ ] **Step 1: Find the exact call site** — `decidePlayout(prevHead, now, frameDurationSec, jitterSec, driftSec)` and the `source.start(decision.at)` that follows; per-peer state lives in the peer-state record.

- [ ] **Step 2: Add a per-peer ledger** — one `ScheduledSourceLedger` per peer state (created with the state, dropped when the peer state is dropped/reset, `cancelPending` also called wherever the peer's playback is torn down).

- [ ] **Step 3: Execute the decision**

```typescript
      const decision = decidePlayout(prevHead, now, frameDurationSec, jitterSec, driftSec);
      ledger.prune(now);
      if (decision.reason === 'behind') {
        this._logPlayoutReset(agentPubKeyB64, 'behind', prevHead - now);
      } else if (decision.reason === 'skip-to-newest') {
        ledger.cancelPending(now);
        this._logPlayoutReset(agentPubKeyB64, 'skip', prevHead - now);
      }
      source.start(decision.at);
      ledger.add(source, decision.at + frameDurationSec);
      state.nextPlaybackTime = decision.nextPlaybackTime;
```

(Adapt names to the real surrounding code; the invariant is the ORDER — cancel before start — and that every started source enters the ledger.)

- [ ] **Step 4: Update `_logPlayoutReset`** — branch union `'behind' | 'skip'`; totals line `totals: behind=N skip=M`; counter field rename (`overcapDrop` → `skip`).

- [ ] **Step 5: Run the module suites + full `nix develop -c npm run verify`; green.**
- [ ] **Step 6: Commit** — declare the log-vocabulary change (`overcap-drop` → `skip`).

### Task 4: Browser-harness validation (real WebCodecs)

**Files:**
- Modify: `ui/harness/voice-playout-harness.ts` / `voice-playout.spec.ts`

- [ ] **Step 1: Update the burst spec** — the existing "burst → `overcap-drop` fires and no overlap" assertion becomes: burst → `skip-to-newest` fires, the recorded schedule has **no overlapping intervals**, and the frames that remain scheduled at burst end are the **suffix** (newest) of the burst input. Keep the legacy spec (burst+legacy → overlaps) untouched — it is the negative control proving the harness can still see the bug.
- [ ] **Step 2: Run** — `npx playwright test voice-playout.spec.ts` (specs self-skip without WebCodecs; run in the environment the nightly uses). Expected: all green, legacy spec still demonstrates overlap.
- [ ] **Step 3: Commit.**

### Task 5: Doc sync

**Files:**
- Modify: `docs/SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md` (its "Removing the cap entirely would be wrong… drop rather than re-anchor is the trade" paragraph is superseded: the trade is now cancel-then-re-anchor; add a dated correction in place — the doc is active, not HISTORICAL)
- Modify: `CLAUDE.md` fact bullet (one line in the relevant round's entry, per the "True today" contract) — done in the closing doc-sync commit of whichever release lands this.

- [ ] **Step 1: Apply both edits; commit as `docs:`.**

## Self-review notes

- Spec coverage: burst-plays-oldest (Task 1 arm + Task 3 executor), latency parking (re-anchor at `now+jitter` clears it), overlap hazard (Task 2 ledger + Task 1 suffix test + Task 4 harness negative control), field vocabulary (Task 3 step 4, declared).
- Types consistent across tasks: `PlayoutDecision.action: 'play' | 'cancel-restart'`, `reason: 'skip-to-newest'`, `ScheduledSourceLedger.{add,prune,cancelPending,size}`, `Stoppable`.
- Deliberately out of scope: adaptive buffer depth (Option C), any change to `behind`/`steady`/`first` arms, any new constants.
