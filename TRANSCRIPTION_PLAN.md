# Transcription module — implementation plan

Working notes for adding local-first speech-to-text to Presence as a
module. Written 2026-04-17, revised same day. Branch:
`feature/transcription` (cut from `feature/voice-over-signals` because
MicSource lives there). Intended to parallel STREAM_NEXT_STEPS.md in
tone: decisions pinned, open questions named, no code yet.

Sibling document: MOSS_LOCAL_MODELS_PLAN.md — the upstream Moss-side
work. The living copy has moved to the Moss repo
(`moss-ai-transcription/MOSS_LOCAL_MODELS_PLAN.md`, branch
`ai-transcription`). Our local copy is now a handoff snapshot.

Moss M0 findings (2026-04-17): `smart-whisper` runtime picked,
tiny.en runs at 2.6× realtime batch / slower-than-realtime per chunk
in fixed-window streaming — confirms our "batch on silence"
approach. `latencyTier: 'fast' | 'ok' | 'slow'` added to the API;
Phase 1 module reads this. Full details in
`moss-ai-transcription/spikes/asr-m0/RESULTS.md`.

## Design guidelines (from the ask)

1. **Self-transcription by default.** Each agent transcribes their own
   microphone stream and publishes the text. Fallback path for agents
   who can't or won't transcribe locally (low-power, opted-out):
   another peer volunteers to transcribe on their behalf.
2. **Local-model access via the Moss API.** The transcription module
   does not embed an ASR runtime or bundle weights. It calls into a
   Moss/Weave-provided pipeline service (proposed upstream) so any
   Moss tool — Presence, Vines chat, a future notes tool — can reuse
   the same local model investment.

These two guidelines together rule out the "everyone transcribes
everyone" mesh that a generic analysis would suggest. They buy:

- **O(N) CPU across a mesh, not O(N²).** Each speaker transcribes once.
- **Cleanest possible audio source.** Pre-encoding, pre-packet-loss,
  pre-jitter, pre-AEC-artifacts — the same `MediaStreamTrack` that
  MicSource hands to WebRTC and voice, before anything touches it.
- **Natural speaker attribution.** The author of the transcript IS the
  speaker; no diarization needed, and the text is signed (via
  Holochain signals) by the same agent whose voice it represents.
- **No model-bundling in Presence.** Model size, format, runtime,
  updates are Moss's problem.

Tradeoffs accepted:

- **One-shot, no redundancy.** If a speaker's transcription drops a
  chunk (OOM, backpressure), nobody else has a copy of the audio to
  re-run ASR on. The fallback/volunteer path below is the mitigation
  for speakers who never transcribe at all, not for transient drops.
- **Trust the speaker to not doctor their own transcript.** In a
  call context this is fine (same trust model as the audio
  itself — a speaker can also lie verbally). For higher-stakes
  minute-taking a future redundant-transcriber mode could be added,
  but it is not the default.

## Where this hooks into the codebase

The relevant surfaces already exist; no new framework primitives
required for v1.

### Capture: MicSource consumer #3

Refcounted mic acquisition is already in place. The transcription
controller calls:

```
streamsStore.micSource.acquire({
  id: 'transcription',
  onTrackChanged: (newTrack) => rebuildAsrPipeline(newTrack),
});
```

`track.enabled = false` (mute) is already the unified mute signal
across WebRTC, voice, and anything else — the transcription pipeline
reads `track.enabled` in its pump loop exactly the way voice does at
[voice.ts:304-307](ui/src/room/modules/voice.ts#L304-L307) and skips
encoding while muted.

Device changes fire `onTrackChanged`; the ASR pipeline rebuilds its
`MediaStreamTrackProcessor` the same way voice does at
[voice.ts:242-263](ui/src/room/modules/voice.ts#L242-L263).

### Transport: reuse `sendModuleData` / `onData`

Text chunks are small (tens to hundreds of bytes per utterance). They
ship over the same module-data channel voice uses, broadcast to
`_signalsTargets`. No new zome call, no new signal type, no new
broadcast plumbing. See
[streams-store.ts:1346-1367](ui/src/streams-store.ts#L1346-L1367).

### State: `ModuleStateEnvelope` for opt-in and volunteer lists

The `transcription` module's payload mirrors the `signalsOnlyWith`
pattern established for the mic/conversation module:

```
{
  enabled: boolean,             // is this agent producing transcripts
  requested: boolean,           // did this agent request call
                                // transcription (broadcasts the prompt
                                // to other participants)
  maxCommittedSeq?: number,     // highest seq this agent has broadcast
                                // (updated periodically, used for
                                // exit-time gap detection)
  finalSeq?: number,            // set on deactivate; highest seq that
                                // will ever be broadcast (nothing after
                                // this is pending)
  transcribingFor: AgentPubKeyB64[],  // peers I am volunteering to
                                      // transcribe (Phase 2)
  canTranscribeFor: boolean,    // I'm eligible to volunteer (Phase 2)
  declineTranscriptionFrom: AgentPubKeyB64[], // I don't want my audio
                                              // transcribed by these peers
}
```

Symmetric-union style consent: a peer Y transcribes speaker X iff
- X's `enabled` is false AND Y's `transcribingFor` includes X AND
- X's `declineTranscriptionFrom` does NOT include Y.

`enabled=true` + self-transcription takes precedence over all
volunteers for that speaker. Resolution is synchronous from the
module-state stores, same pattern as `webrtcDisabled()` at
[streams-store.ts:1377-1398](ui/src/streams-store.ts#L1377-L1398).

### Lifecycle

`onActivate` → acquire MicSource handle, open ASR pipeline, subscribe
to peer module-state changes (to detect when I should start
volunteering for a peer). `onDeactivate` → release handle, close
pipeline. `onModulePayloadChange` → react to a peer adding/removing
themselves from my `transcribingFor` target set, or to a peer
declining.

## Moss API extension (guideline 2)

### What Presence needs from Moss

A local speech-to-text pipeline exposed on `WeaveClient`. Sketch:

```typescript
interface WeaveClient {
  // ... existing ...
  localModels?: {
    capabilities(): Promise<{
      asr: { available: boolean; languages: string[]; streaming: boolean };
      // room for summarize, translate, embed, etc.
    }>;

    asr: {
      /**
       * Open a streaming transcription session. Implementation chooses
       * the model/runtime (Whisper, Gemma-ASR, Apple Speech, whatever
       * the Moss runtime has wired up). Caller feeds PCM16 mono 16kHz
       * chunks and receives partial + final transcript events.
       */
      openSession(opts: {
        language?: string;
        hints?: string[];        // bias terms (names, jargon)
      }): Promise<AsrSession>;
    };
  };
}

interface AsrSession {
  pushAudio(pcm16: Int16Array, endOfUtterance?: boolean): Promise<void>;
  onPartial(cb: (text: string, tStart: number, tEnd: number) => void): Unsubscriber;
  onFinal(cb: (text: string, tStart: number, tEnd: number, confidence?: number) => void): Unsubscriber;
  close(): Promise<void>;
}
```

Why streaming rather than one-shot buffer-in / text-out:

- Captions need partial results during long utterances. Batch-mode
  creates a perceptible delay proportional to utterance length.
- Moss can implement streaming as a thin wrapper over a batch model
  (VAD-chunked inside Moss) on runtimes that don't support true
  streaming. Presence doesn't care which.

Why Moss-owned instead of Presence-embedded:

- **Composability across tools.** A notes tool, a call-summary tool,
  and a chat-translation tool all want ASR. Each embedding its own
  model doubles or triples disk usage and RAM residency.
- **Model/runtime lifecycle is not Presence's problem.** Model updates,
  quantization choices, GPU/NPU selection, cold-start latency are
  Moss-platform concerns. Presence stays small.
- **Permissions / consent UX.** "Do you want to enable local
  transcription?" is a once-per-install decision that belongs to the
  Moss shell, not to each tool.

### No in-tool fallback

Presence has no standalone build — it runs inside `hc-spin` (dev) or
Moss (prod), neither of which exposes a way for the tool to spawn an
ASR binary itself. The Moss `localModels.asr` API is the only
transport. If it's absent, the transcription module is unavailable:
the room-menu entry is disabled with a tooltip explaining why.

This means Phase 1 ships when the Moss API ships; there is no
earlier-landable shim path. Since both sides are our own code on
adjacent branches, the coordination cost is small.

**If Moss `localModels` can't be landed at all** (upstream blocker,
timeline slip past acceptable) the plan B is to stand up a
Kangaroo-packaged or Tauri-packaged build of Presence that bundles
whisper.cpp directly. Kangaroo is Lightningrod Labs' own standalone-
hApp packager and the more natural fit. This is not something to
design for now — mentioned only so that the absence of an HTTP-
endpoint fallback here is a deliberate choice, not an oversight.

## Merge / conflict resolution — the "send-log" pattern

Each transcript frame carries:

```
{
  speaker: AgentPubKeyB64,      // whose voice
  transcriber: AgentPubKeyB64,  // who produced this text
  seq: number,                  // monotonic per transcriber per speaker
  tStart: number,               // ms since session start (speaker-local)
  tEnd: number,
  text: string,
  lang?: string,
  confidence?: number,
}
```

The transcriber field matters: for self-transcription it equals
speaker; for fallback/volunteer it differs. Receivers store an
append-indexed map keyed by `speaker` and merge streams from all
contributing transcribers, with these rules:

1. **Self beats volunteer.** If a frame from `transcriber === speaker`
   exists for an overlapping `[tStart, tEnd]` window, it supersedes
   any volunteer frame for the same window.
2. **Within a transcriber, seq is monotonic.** Out-of-order frames
   (rare, signals-level reordering) are slotted by `tStart`.
3. **Between volunteers for the same speaker** (the >1 volunteer case,
   a post-v1 concern): pick the highest `confidence` if reported, else
   first-to-arrive. Non-goal for v1 — volunteer fallback is designed
   1-at-a-time.

Partial / streaming ASR results are discarded; only committed finals
are broadcast (see "Broadcast timing" in the UX section).

The in-memory accumulator lives on the transcription controller (like
voice's `peers` map). No zome entry for live transcripts — they are
ephemeral signals, same shape as voice frames.

### Persistence — exit-time save only (v1)

No zome entries, no DHT writes, no source-chain commits for conversation
logs. The in-memory merged view at session end is offered to the user
as a file download when they leave the room. Mechanics described in
"Exit-time persistence" under the UX section above.

A future pass could add optional committed transcripts if a concrete
user ask emerges — but that is explicitly not on the roadmap, to keep
the DHT write volume low and avoid call-log governance questions
we don't need to answer yet.

## Fallback / low-power path

Volunteer election is the simplest mechanism that meets the guideline:

- Each agent advertises `enabled: boolean` and `canTranscribeFor:
  boolean` in their module payload.
- When an agent with `enabled: false` enters the room, one of the
  `canTranscribeFor: true` peers volunteers by adding the
  non-transcriber's pubkey to their `transcribingFor` list.
- Election rule for "which volunteer picks them up":
  - Deterministic lexicographic pick by pubkey among peers with
    `canTranscribeFor: true` — everyone can compute the same result
    without an explicit round.
  - On volunteer leave / drop, the remaining set re-picks.
  - An explicit "I'm volunteering for X" flag in the payload prevents
    two volunteers both activating; the election picks a winner but
    each peer waits until they see only themselves as the elected
    volunteer before actually committing CPU.

Open question — the peer who declines self-transcription cannot
enforce that *no one* transcribes them (their audio is flowing over
WebRTC/signals either way). `declineTranscriptionFrom` is a social
contract honored by compliant clients. Worth stating explicitly in
the UI that declining blocks transcript publication by compliant
peers, not transcription itself. A stricter model (don't publish
without a cryptographic consent token from the speaker) is possible
but disproportionate for v1.

### When to engage the fallback

Trigger for a volunteer to start transcribing for speaker X:

- X has been in the room for ≥ N seconds (don't flap on join).
- X's `transcription` module is inactive or `enabled: false`.
- I'm the elected volunteer for X (lex winner among eligible peers).
- X has not added me to `declineTranscriptionFrom`.

Volunteer cost is non-trivial (running ASR on a remote stream, which
requires taking an audio tap off the WebRTC peer connection). So the
fallback path requires a separate MicSource equivalent for *remote*
streams — call it `PeerAudioTap` — to get a `MediaStreamTrack` from
`_openConnections[X].audio` that can feed into the ASR session. This
is a new abstraction but a small one. It slots next to
[streams-store.ts:1317-1419](ui/src/streams-store.ts#L1317-L1419)
where `peer.on('stream', …)` fires.

## UX: minimal, async, opportunistic

Revised 2026-04-17 — real-time captions are explicitly not a goal.
Transcription runs in the background at whatever pace the local ASR
runtime manages, and finished chunks are broadcast opportunistically
during the speaker's own silences. This simplifies a lot of things at
once:

- **No partial-transcript flicker concern.** We only publish final
  chunks, not in-progress ones. `isPartial` field drops from the
  frame schema; the first version carries finals only.
- **Caption overlay is deferred.** No live caption UI in v1. Peers
  see a transcript panel (scrollback) that fills in behind the
  conversation — seconds to tens of seconds behind real-time is
  fine.
- **Broadcast timing follows the speaker, not the ASR.** Producer
  queues finished chunks and flushes when the speaker's VAD reports
  silence for ≥ N seconds (tunable, start at ~1.5s). Avoids piling
  signal traffic on top of live voice frames.
- **Low request-to-join friction.** See "opt-in flow" below.

### Opt-in flow

Default: everyone's transcription module is **off**. A request to
transcribe the call is a room-wide broadcast; other participants
get a small notification and a yes/no choice. First-time yes offers
to remember the choice.

```
   [Participant A clicks "Transcribe call"]
                    │
                    ▼
   [A broadcasts transcription.requested = true]
                    │
                    ▼
   [Each other participant sees a notification:]
     "Alice wants to transcribe this call.
      Ok to activate local transcription of what you say to share?"
                 [ Yes ]  [ No ]
                    │
                    ▼
   [Yes: activate own transcription module (enabled = true)]
   [No : ignore; their audio is not transcribed unless a
         volunteer picks them up under the Phase-2 fallback rules]

   [First-time Yes also offers:]
     "Always accept transcription requests in the future?"
                 [ Yes ]  [ Not now ]
```

Settings expose a single persistent toggle: **"Automatically accept
transcription requests"** (stored in localStorage via the existing
`writeLocalStorage` helper in `utils.ts`). When set, incoming
requests activate the module silently without a notification.

No toolbar button for self-activation during the call. No per-peer
configuration UI. No indicators on peer panes.

The only visible controls:
- "Transcribe call" entry in the room-level menu (room-view's
  kebab or similar) — sends the request.
- A small top-of-room indicator when transcription is active for the
  call, so participants know it's happening (listing who has
  opted in is optional; a count is enough for v1).

### Exit-time persistence

No zome entries for live transcripts. When a participant leaves the
room:

- If any transcripts were received during the session, prompt:
  **"Save this transcript?"** [Save] [Discard]
- If the local merged view has gaps — specifically, if any peer's
  transcription was active but some of their chunks never arrived
  (missing sequence numbers, or they left while they still had
  opportunistic chunks queued for broadcast) — show a warning:
  **"The transcript is incomplete. Chunks from Bob and Carol were
  still pending when they left."**

Save produces a plain text (or Markdown) file via the browser's
download mechanism, or via the Weave asset system if running as a
Moss tool. Format is speaker-grouped chronological, one utterance
per paragraph. No commitment to a structured schema yet — the file
is for the human, not for re-import.

Gap detection mechanics:

- Each transcriber advertises their highest committed `seq` in their
  periodic module-state payload (infrequent, since transcription is
  slow). Receivers compare their local max-received `seq` to the
  advertised max-committed `seq` per transcriber.
- When a transcriber's module deactivates (explicit off, leave, or
  room exit), its final `seq` is included in the deactivation
  envelope so receivers can distinguish "this transcriber is done,
  everything in [0, final] should arrive" from "this transcriber
  might still send more."
- If a transcriber drops out ungracefully (crash, network loss) with
  no final seq advertised, receivers treat that as "unknown
  completeness" and warn on save.

### Out of scope for v1 UX

- Live captions on video tiles
- Per-speaker mute of transcription
- Editing / correcting transcripts
- Speaker name display other than the existing profile nickname
- Commitment of transcripts to any kind of chain or DHT entry

### Deferred for a later pass

- Word-level timestamps / caption sync with video
- Translate-on-the-fly (would be a second Moss API call,
  `localModels.translate`)
- Call summary / action items (requires a text LLM, separate Moss
  API surface)

## Phased rollout

Moss-side work (the `localModels.asr` API) runs in parallel in its own
branch/session — we're the Moss devs too. See
MOSS_LOCAL_MODELS_PLAN.md for that scope. The phases below are the
Presence-side work only, structured so nothing is blocked waiting on
the other side.

### Phase 0 — Spikes in this repo (exploratory)

Purpose: validate the assumptions underlying the plan before
committing to the module architecture. Lives under
`spikes/transcription/` — not part of the main build. Results in
`spikes/transcription/results.md`.

- **Spike 0a — Capture pipeline.** DONE. WebCodecs
  `MediaStreamTrackProcessor` path works; produces valid PCM16/16kHz
  mono WAV.
- **Spike 0b — ASR round-trip.** DONE. whisper.cpp base.en at
  RTF 0.062 (16× real-time) on 4-thread CPU, no GPU. Quality good,
  punctuation clean. Confirms Moss runtime choice and "seconds
  behind realtime" viability.
- **Spike 0c — Opportunistic broadcast timing.** DEFERRED. Not a
  blocker for Phase 1; the soft-deadline fallback is already
  named. Will run with real Presence-call audio before wiring the
  producer-queue flush.

### Phase 1 — Self-transcription, Moss API only, no live UI

**Gated on Moss `localModels.asr` landing.** No Presence-side landable
path before then; the upstream dependency is real and we accept it.

- New `transcription` module at `ui/src/room/modules/transcription.ts`
  following voice.ts shape.
- `TranscriptionController` class, bound/unbound by the module,
  acquires a MicSource consumer handle.
- Runtime calls `weaveClient.localModels.asr.openSession(...)` and
  feeds PCM with `endOfUtterance: true` at silence boundaries (per
  the Moss M0 finding that batch-on-silence beats fixed-window
  streaming).
- Module is unavailable — room-menu entry disabled — when
  `weaveClient.localModels?.asr` is absent or
  `capabilities().asr.available` is false.
- Producer queue with silence-gated flush. No partials on the wire.
- Receiver accumulator with merge rules from the schema section.
- Room-menu "Transcribe call" entry; incoming-request
  notification; auto-accept setting.
- No caption overlays, no per-pane indicators, no transcript panel.
- Exit-time "Save transcript?" prompt with gap warning.

Feature-flag OFF by default. Opt-in at settings level before the
room-menu option appears.

### Phase 2 — Volunteer / fallback path

- `PeerAudioTap` abstraction for taking a MediaStreamTrack off a
  remote peer's `_openConnections[X].audio`.
- Payload fields `transcribingFor`, `canTranscribeFor`,
  `declineTranscriptionFrom`.
- Lex-winner election logic, reacting to `onModulePayloadChange` and
  peer join/leave.
- Minimal UI: a passive indicator in the transcript panel that a
  given speaker's text is from a volunteer rather than the speaker
  themselves. No per-pane badges.

### Phase 3 — Polish and transcript panel

Only once the async flow has settled in use:

- Scrollback transcript panel (dedicated slot or reuse shared-panel
  infra).
- Nicer save formatting (markdown with speaker headings, timestamps).
- A small top-of-room indicator that transcription is active.

## Risks and open questions

- **PCM chunk size / cadence.** Streaming ASR models have different
  ideal chunk sizes. The Moss API sketch leaves this to the
  implementation, but Phase 0 Spike B needs to verify the Moss
  runtime's chunk size doesn't constrain frontend code into awkward
  buffering. If Moss wants e.g. 960-sample frames, the pump loop
  structure differs slightly.
- **Who "owns" the remote audio tap.** Volunteer path needs to pull a
  `MediaStreamTrack` from the WebRTC `RTCPeerConnection`, but that
  track's lifetime is already managed by streams-store for WebRTC
  playback. Non-trivial to add a second consumer that won't be
  confused with the existing track-change reconciliation paths at
  [streams-store.ts:2245](ui/src/streams-store.ts#L2245) /
  [streams-store.ts:915-919](ui/src/streams-store.ts#L915).
  Needs design work in Phase 2 specifically.
- **Signals carrier bandwidth.** Transcript frames are small (~200B
  per utterance), but they still ride the same signal pipe as voice.
  Needs back-pressure consideration if signals are already near
  saturation on voice traffic.
- **Concurrent signals-only + transcription.** If signals-only is
  already tunneling Opus to this peer, adding transcript frames on
  the same pipe doubles the per-utterance signal count. Measure
  before worrying — but keep in mind that a Starlink user with both
  signals-only and transcription might be the canonical bad case.
- **Opportunistic broadcast cadence.** If a speaker never pauses long
  enough to trigger a flush (sustained monologue), chunks pile up
  locally. Phase 0 spike 0c is the measurement; if the tail is bad,
  add a soft deadline (e.g., flush anyway after 30s even during
  speech, accepting the small signal-traffic cost during the rare
  long-talk case).
- **Privacy of volunteer transcripts.** A volunteer transcribing a
  silent peer can publish fabricated text. `declineTranscriptionFrom`
  is social; a cryptographic "speaker must sign transcript body"
  protocol would prevent this but is disproportionate for v1.
- **Language detection.** Auto-detect vs user-set. Moss-owned detail;
  Presence just passes `language?` through.

## Out of scope

- Summarization, action-item extraction, Q&A over call history.
  Those are LLM-not-ASR work and belong in a separate module (or a
  separate Moss API surface).
- Translation. Same reasoning; separate Moss API method.
- Word-level timestamp alignment for karaoke-style caption rendering.
  Deferred until there's a concrete UX asking for it.
- Speaker diarization. Mesh topology already provides per-speaker
  track separation, so diarization is not needed.
- Redundant-transcriber mode (multiple transcribers per speaker for
  cross-verification). Viable if we ever need tamper-resistant
  transcripts; out of scope for the default "call captions" case.
