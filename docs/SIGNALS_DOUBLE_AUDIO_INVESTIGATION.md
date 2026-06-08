# Symptom B investigation — signals carrier plays voice "on top of itself"

Branch: `investigate/signals-double-audio`. Scope: the **signals** voice carrier
(`ui/src/room/modules/voice.ts`), *not* WebRTC. Separate from the connection-plan
work.

**Status: HYPOTHESIS, not yet confirmed.** The diagnosis below is reasoned from
static code reading; it has **not** been reproduced or measured. The candidate
fix and the diagnostic on this branch exist to confirm-or-kill it. Two load-
bearing assumptions are explicitly untested (see "What's unverified").

## Symptom (human report)

On a 0.14.8 call, after manually flipping to the **signals** carrier:
- Sender (PR) heard clean; the receiver (NY) reported **0% loss and good quality**, but
- NY heard PR's voice **played on top of itself in ~0.5s bursts every ~20s**.

## The transport (corrected)

The signals carrier sends each Opus frame via `roomClient.sendMessage` → the
`send_message` zome fn → **`send_remote_signal`**
([remote_signals.rs:85](../dnas/presence/zomes/coordinator/room/src/remote_signals.rs#L85)),
addressed to each peer. That is Holochain's **remote-signal** path: ephemeral,
fire-and-forget, agent-to-agent messages over the conductor's P2P networking
(Kitsune2), which may go directly or be **relayed via a signal/relay server**
when peers can't connect directly.

This is **not gossip** (the DHT-op sync mechanism for persisted data). An earlier
draft of this doc called it a "gossip relay" — wrong. The relevant property is
only that remote-signal delivery is best-effort, unordered, and can be
delayed/bursty/reordered. Crucially, **there is no gossip round**, so nothing in
the transport predicts a clean ~20s period — the observed cadence is currently
**unexplained**.

## What the logs do / don't show

- The merged capture (`Presence_merged_0.14.8_2026-6-8-16_18_22.json`) shows the
  signals carrier at `loss=0%` with bursty RTT/jitter. "0% loss" is
  **post-RED-recovery** (`voice.ts` counts only seqs carried by no packet), so
  bursty-but-complete delivery reads as 0% loss while still being bursty.
- There is **no per-frame playout trace** in the capture, so the doubling itself
  is not visible — hence the diagnostic added on this branch.

## Hypotheses ruled out (from code facts)

- **Duplicate decode via RED**: in 0% loss, every redundant frame carries
  `seq <= lastSeq` and is skipped ([voice.ts:404,441](../ui/src/room/modules/voice.ts#L404)).
- **Sender seq reset**: `this.seq = 0` happens only in `stopCapture()`
  ([voice.ts:385](../ui/src/room/modules/voice.ts#L385)) — not on a ~20s cycle.
- **Two concurrent decoders for one peer**: per-peer state is created once in
  `openPeer` and only cleared in `unbind()` — never recreated mid-session, so
  there is only ever one decoder per peer.

## Hypothesized root cause — playout re-anchor overlaps scheduled audio

`playAudioData` schedules each decoded 20ms frame on a fresh
`AudioBufferSourceNode` at `state.nextPlaybackTime`, then advances it by the
frame duration ([voice.ts](../ui/src/room/modules/voice.ts) `playAudioData`).
Pre-fix the head guard was:

```js
const now = ctx.currentTime;
if (nextPlaybackTime < now || nextPlaybackTime > now + jitterSec + driftSec) {
  nextPlaybackTime = now + jitterSec;   // re-anchor
}
source.start(nextPlaybackTime);
nextPlaybackTime += frameDuration;
```

`JITTER_BUFFER_MS = 80`, `PLAYBACK_RESET_DRIFT_MS = 400`, so the upper bound is
`now + 480ms`.

The **upper-bound branch is the suspect**. *If* the remote-signal transport
delivers a backlog and *if* the decoder then emits that backlog faster than real
time, `nextPlaybackTime` races ahead of `now`:

1. Frames 1..~20 are `source.start()`-scheduled at `now+80 … now+480ms` (already
   committed to the audio clock).
2. Once `nextPlaybackTime` exceeds `now + 480ms`, the guard **snaps it back to
   `now + 80ms`**.
3. The remaining burst frames are then scheduled starting at `now+80ms` again —
   **overlapping** the still-pending sources from step 1.

The overlap region (up to `driftSec` = ~400ms ≈ the reported ~0.5s) would play
twice. The backward snap is only safe for the `nextPlaybackTime < now` case (we
fell behind; nothing is scheduled in `[now, nextPlaybackTime)`).

## What's unverified

1. **Decoder pacing** — that `AudioDecoder` emits output for a backlog *faster
   than real time*. If it instead paces output ~real-time, `nextPlaybackTime`
   never races ahead and this mechanism does not occur. Browser-implementation-
   dependent; not measured. (This is what the browser harness below targets.)
2. **The causal link** to the audible symptom and the **~20s cadence** — no
   transport-level mechanism is known for the period; it must be measured.

## Candidate fix (applied on this branch)

Split the guard. The backward re-anchor is kept only for `nextPlaybackTime < now`
(fell behind — cannot overlap). For `nextPlaybackTime > now + jitter + drift`
(buffer too deep), **drop the frame** instead of snapping backward — shedding a
20ms frame mid-burst is inaudible; overlapping ~400ms is not. The scheduling
decision is now a pure function (`decidePlayout`,
`ui/src/room/modules/voice-playout.ts`) so it is unit-testable in isolation.

Removing the cap entirely would be wrong — `nextPlaybackTime` would ride ahead
forever and inflate latency permanently. Bounding by *shedding* (drop) rather
than *re-anchoring* (overlap) is the trade.

## Test harness (this branch)

Two tiers, because the unknowns live at two layers:

1. **Deterministic unit harness** (`voice-playout.test.ts`, vitest): drives the
   pure `decidePlayout` through arrival patterns — steady real-time, first
   frame, stall+resume, and a faster-than-real-time burst — and asserts the
   resulting scheduled intervals never overlap and frames are shed (not snapped
   back). Includes `decidePlayoutLegacy` (the pre-fix snap-back) as a reference
   to *demonstrate the overlap it produced*, so the test both proves the bug and
   guards the fix. Exercises the **scheduling-logic** possibilities.

2. **Browser harness** (`ui/harness/voice-playout-harness.html` + Playwright
   `voice-playout.spec.ts`): runs a **real** AudioEncoder→AudioDecoder→
   AudioContext with an instrumented `createBufferSource` recorder, fed at
   controlled arrival rates (real-time vs burst), and asserts on the recorded
   intervals. Exercises the **real-WebCodecs** assumptions the unit tier can't —
   in particular whether a real decoder races ahead on a burst (untested #1).

## How to verify in the field

1. Two-peer call forcing the **signals** carrier on a path that makes
   remote-signal delivery bursty (the PR↔NY setup, or throttle the signal relay).
2. Grep the receiver log for `VoicePlayoutReset`; correlate `overcap-drop`
   timestamps against `SignalCarrierDown/Up` to find what actually drives the
   cadence. Pre-fix builds would also exhibit audible doubling; on this branch
   the over-cap branch drops and the doubling should be gone.

## Open questions

- What drives the ~20s recurrence? (No gossip round exists on this path.)
- Should the jitter buffer be adaptive (grow under sustained burstiness) instead
  of a fixed 80ms + 400ms drift cap? Out of scope for this fix; note for later.
