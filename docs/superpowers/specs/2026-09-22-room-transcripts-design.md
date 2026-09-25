# Room transcripts: stored per call visit, browsed from the room

Every decision below landed on branch `ai-transcription-0.7` (plan:
`docs/superpowers/plans/2026-09-22-room-transcripts.md`). This is the active
design record for room transcripts: correct it in place when the code changes.

## Problem

Today a transcript exists only as a Markdown download offered when you leave the
call. It covers whatever the local accumulator holds at that moment, the prompt
appears whether or not anything useful was captured, and nothing relates one
person's transcription to another's. There is no way to look at a past
transcript, and no way to see the current one growing.

## Decisions

- **One transcript per call visit.** It starts when the local agent joins the
  room and ends when they leave. It holds every frame received during the
  visit, from every speaker, regardless of when the local agent's own
  transcription was on. Starting and stopping local transcription only changes
  what this agent contributes.
- **Stored in IndexedDB** behind a `TranscriptStore` interface, with an
  in-memory implementation for tests. No retention rule; the user deletes.
- **Structured, not rendered.** Frames are stored as they arrive; Markdown is
  produced on demand by a pure export module.
- **Browsed from the room's card, not from the call.** A transcripts button on
  the lobby room card and on the enter pane opens an overlay listing this
  room's stored transcripts with View, Download, and Delete. Inside an open
  room the visit in progress is watched in the connection-details pane. The
  exit-time save prompt is removed.

## Data model

```ts
interface StoredTranscript {
  id: string;            // `${roomKey}:${startedAt}`
  roomKey: string;       // `${dnaHashB64}#${roleName}`
  roomName: string;      // display name at the time of the visit
  startedAt: number;     // ms epoch, local join
  endedAt?: number;      // ms epoch, local leave; absent while live
  frames: TranscriptFrame[];   // existing wire shape from transcription.ts
  labels: Record<AgentPubKeyB64, string>; // speaker nicknames frozen at end
}
```

`TranscriptFrame` is unchanged: `{ speaker, transcriber, seq, tStart, tEnd,
committedAtMs, text, confidence?, lang? }`. Frames are kept in ingestion order;
ordering for display is by `committedAtMs`, as the current export does.

## Store

```ts
interface TranscriptStore {
  readonly degraded: boolean; // true when nothing is persisted (no IndexedDB, or it failed)
  listForRoom(roomKey: string): Promise<StoredTranscript[]>; // newest first
  get(id: string): Promise<StoredTranscript | undefined>;
  put(t: StoredTranscript): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- `IndexedDbTranscriptStore`: database `presence-transcripts`, version 1, one
  object store `transcripts` keyed by `id`, index `byRoom` on `roomKey`. Opened
  lazily on first use. Any failure to open (private mode, quota) makes the
  store report itself unavailable; the transcripts button then shows a tooltip
  saying transcripts cannot be stored, and capture continues unaffected.
- `MemoryTranscriptStore`: a `Map`, same contract, used by tests and as the
  fallback when IndexedDB is unavailable, so visits from the current page stay
  listed until it closes.
- The page-wide store is the `getTranscriptStore()` singleton in `ui/src/room/transcripts/store.ts`;
  `StreamsStore.connect` (in `ui/src/streams-store.ts`) builds the dep as `StreamsStoreDeps.transcripts?: { store: TranscriptStore; roomKey: string }`
  (declared in `ui/src/store-deps.ts`) from the `roomKey` that `ui/src/room/room-container.ts` computes from the cell.
  `roomTranscriptKey(dnaHashB64, roleName)` (`store.ts`, returning `${dnaHashB64}#${roleName}`) is the one
  authority for that key; the room container, the lobby room card, and the enter pane all build it with it.
  The controller reaches the store through `StreamsStore.transcripts`; the transcripts button reads
  `getTranscriptStore()` directly, since it lives outside any room.

## Accumulation

- `TranscriptionController.bind(store)` also opens the visit: it reads `store.transcripts`
  (the store and room key from the dep) and creates the `StoredTranscript` with
  `startedAt`. The visit is first written when it receives a frame, then
  coalesced as below; the store only holds visits with content.
- `ingestFrame` keeps appending to the in-memory `_transcriptLog` (the live
  view) and additionally appends the frame to the visit transcript. Writes to
  the store are coalesced: at most one `put` every 2 s, plus an immediate `put`
  when the visit ends.
- `unbind()` sets `endedAt`, freezes `labels` for every speaker present, and
  writes once more. `room-view` looks nicknames up from the profiles store as
  speakers appear during the call, through one `SpeakerLabels` cache
  (`ui/src/room/transcripts/speaker-labels.ts`); a lookup that throws is not
  repeated during the call, and leave re-asks every speaker whose lookup
  failed (`refresh(pks, { retryFailed: true })`); the controller
  freezes them into the record at the visit's end, using the resolver that was
  set when `unbind()` was called. Because the closing commit is
  delivered before `stopCapture()` resolves (Moss contract), the leave path
  awaits capture teardown before the final write, as `stopAndAnnounce` does now.
- A visit with zero frames is never written, and is deleted at `unbind()` in
  case a record of it exists, so the list only shows visits with content.

## UI

- **Button.** `<transcripts-button>` (`ui/src/room/transcripts/transcripts-button.ts`),
  an icon button (mdi `text-box-multiple-outline`) with tooltip "Transcripts",
  styled as the twin of `wal-to-pocket-btn`. It takes `roomKey` and `roomName`,
  mounts the dialog, and keeps its own `SpeakerLabels` over the profiles store
  from context; the dialog's label lookups re-ask failed keys. It appears in
  three places, each only once the room's cell exists:
  - the lobby room card (`ui/src/lobby/shared-room-card.ts`), right before the
    Enter button; the "add to pocket" button moves to sit beside the room name;
  - the private room card (`ui/src/lobby/private-room-card.ts`), right before
    its Enter button;
  - the enter pane (`PageView.EnterRoom` in `ui/src/presence-app.ts`), beside
    Enter. That pane is what an asset view shows before entering, and what a
    room already open in another pane shows.
  The open room has no transcripts button.
- **`transcripts-dialog`** (under `room/transcripts/`), an overlay in the style
  of `transcription-request-dialog`, listing stored visits only:
  - List mode: rows newest first; a visit is listed only once it holds a frame.
    Each row: date and time of `startedAt`, duration (`endedAt - startedAt` for
    a closed visit; for a record left open by a killed page or still being
    recorded, the last frame's offset from `startedAt`), speaker count, word
    count, and three actions: View, Download, Delete. Delete asks once inline
    ("Delete this transcript?" Yes / No). A visit still being recorded in
    another pane is already stored, so it appears here as an open entry with
    Delete; the recording pane's next write restores it.
  - View mode: a back button, the Download action, and the transcript body.
  - Download: builds Markdown with `ui/src/room/transcripts/export.ts` and triggers a
    browser download named `transcript-<roomName>-<startedAt ISO>.md`.
- **`transcript-view`** (`ui/src/room/transcripts/transcript-view.ts`) is the one
  rendering of a transcript body: speaker-labelled paragraphs with offsets from
  the first line, same coalescing as the export (consecutive same-speaker lines
  within 3 s join). The dialog's view mode mounts it, and so does the room's
  connection-details pane.
- **Live visit in the room.** With connection details on, `room-view`'s
  transcription pane renders `transcriptionController.liveVisit` (a
  `Writable<StoredTranscript | null>`, republished on every frame) through
  `transcript-view`, so it shows every speaker as frames arrive; its title
  counts the lines.
- Labels: stored `labels` when present, else a nickname looked up from the
  profiles store through `SpeakerLabels`, else a 10-character pubkey prefix.
- **Who is transcribing.** With connection details on, the transcription
  pane's title line lists who currently has transcription `enabled` (self
  first, as "you", then peers by name or pubkey prefix), or "nobody
  transcribing"; each tile's connection-details block (self tile and peer
  tiles alike) shows a subtitles icon when that agent's transcription is
  enabled. Both read the transcription module state through the one
  pair of predicates in `ui/src/room/transcripts/transcribing-policy.ts`
  — `transcribingAgents` and `isTranscribing` — over `_myModuleStates`/
  `_peerModuleStates`, not a re-parse of their own.

## Removals

- `save-transcript-dialog.ts`, `_promptSaveTranscript`, `_resumeQuit`,
  `_saveTranscriptSpeakers`, `_saveTranscriptMarkdown`, and
  `_handleSaveTranscript*` leave `room-view.ts`. `quitRoom` no longer awaits a
  prompt.
- `_buildTranscriptMarkdown` and `_formatOffset` move into `ui/src/room/transcripts/export.ts` as pure functions taking a
  `StoredTranscript` and returning Markdown. Per-speaker completeness is not carried over; its only consumer was the removed dialog, and computing it for a stored transcript would need peer `finalSeq` values frozen at leave. It can be added without changing the stored shape.
- The transcription pane behind "connection details" stays, rendered through
  `transcript-view`.

## Testing

- `ui/src/room/transcripts/__tests__/store.test.ts`: the contract as a table run against
  `MemoryTranscriptStore`, and against `IndexedDbTranscriptStore` when an
  `indexedDB` global exists (jsdom does not ship one; the suite skips with a
  message otherwise, and the app run is the check for that implementation).
- `ui/src/room/transcripts/__tests__/export.test.ts`: ordering, coalescing with the stitch glyph,
  label fallback, participants section.
- `ui/src/room/transcripts/__tests__/visit.test.ts`: bind opens a visit; frames from two speakers
  land in it; nothing is stored before the first frame; writes are coalesced;
  unbind sets `endedAt` and labels through the resolver set at unbind time; an
  empty visit is never stored. Runs against the in-memory store under vitest fake
  timers (the controller reads `Date.now()` and `setTimeout` directly; see the
  timing block in `ui/src/room/modules/transcription.ts`'s header).
- `ui/src/room/transcripts/__tests__/store.test.ts` also tables `roomTranscriptKey`.
- `ui/src/room/transcripts/__tests__/dialog-policy.test.ts`: which rows are listed
  (`selectTranscriptRows`) and each duration case (`describeDuration`).
- `ui/src/room/transcripts/__tests__/speaker-labels.test.ts`: `SpeakerLabels` over an
  in-memory fetcher: in-flight and answered keys are not refetched, a failure
  leaves the cache untouched, a failed key is skipped on a plain refresh and
  re-asked only with `retryFailed`.
- `ui/src/room/transcripts/__tests__/transcribing-policy.test.ts`: table tests
  for `isTranscribing` and `transcribingAgents` — self on, peer on, both,
  module inactive, requested but not enabled, malformed payload JSON,
  undefined maps.
- The dialog, `transcript-view`, the button on the room card and enter pane,
  the transcription pane's transcribing-name list, the per-tile transcribing
  icon, and the connection-details pane are verified in the running app.

## Out of scope

- Sharing or syncing transcripts between peers; the DHT holds nothing.
- Retention limits or storage quotas.
- Editing transcripts.
- Any change to Moss.
