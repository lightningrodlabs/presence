# Room transcripts: stored per call visit, browsed from the room

Status: IMPLEMENTED 2026-09-22 (see docs/superpowers/plans/2026-09-22-room-transcripts.md)

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
- **Browsed from the room.** A header button opens an overlay listing this
  room's transcripts with View, Download, and Delete. The exit-time save prompt
  is removed.

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
  store report itself unavailable; the room button then shows a tooltip saying
  transcripts cannot be stored, and capture continues unaffected.
- `MemoryTranscriptStore`: a `Map`, same contract, used by tests and as the
  fallback when IndexedDB is unavailable so the live view still works for the
  duration of the visit.
- The page-wide store is the `getTranscriptStore()` singleton in `ui/src/room/transcripts/store.ts`;
  `StreamsStore.connect` (in `ui/src/streams-store.ts`) builds the dep as `StreamsStoreDeps.transcripts?: { store: TranscriptStore; roomKey: string }`
  (declared in `ui/src/store-deps.ts`) from the `roomKey` that `ui/src/room/room-container.ts` computes from the cell
  (`${dnaHashB64}#${roleName}`); the controller and the dialog reach the store through `StreamsStore.transcripts`.

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
  speakers appear during the call and once more at leave; the controller
  freezes them into the record at the visit's end, using the resolver that was
  set when `unbind()` was called. Because the closing commit is
  delivered before `stopCapture()` resolves (Moss contract), the leave path
  awaits capture teardown before the final write, as `stopAndAnnounce` does now.
- A visit with zero frames is never written, and is deleted at `unbind()` in
  case a record of it exists, so the list only shows visits with content.

## UI

- **Button.** In the room header, next to the transcribe button, an icon
  button (mdi `text-box-multiple-outline`) with tooltip "Transcripts". Present
  wherever `room-view` renders, which covers the app view and the asset view.
- **`transcripts-dialog`** (new element under `room/transcripts/`), an overlay in
  the style of `transcription-request-dialog`:
  - List mode: rows newest first; a visit is listed only once it holds a frame.
    Each row: date and time of `startedAt`, duration ("live" for the current
    visit; `endedAt - startedAt` for a closed one; for a record left open by a
    killed page, the last frame's offset from `startedAt`), speaker count, word
    count, and three actions: View, Download, Delete. Delete asks
    once inline ("Delete this transcript?" Yes / No).
  - View mode: the transcript rendered as speaker-labelled paragraphs, same
    coalescing as the export (consecutive same-speaker lines within 3 s join),
    a back button, and the Download action. For the live visit the dialog receives
    `transcriptionController.liveVisit` (a `Writable<StoredTranscript | null>`, republished on every frame)
    as its `live` property from `room-view`, so the view re-renders as frames arrive.
  - Download: builds Markdown with `ui/src/room/transcripts/export.ts` and triggers a
    browser download named `transcript-<roomName>-<startedAt ISO>.md`.
- Labels: stored `labels` when present, else a nickname the dialog looks up
  from the profiles store for any listed speaker that has no stored label, else
  a 10-character pubkey prefix.

## Removals

- `save-transcript-dialog.ts`, `_promptSaveTranscript`, `_resumeQuit`,
  `_saveTranscriptSpeakers`, `_saveTranscriptMarkdown`, and
  `_handleSaveTranscript*` leave `room-view.ts`. `quitRoom` no longer awaits a
  prompt.
- `_buildTranscriptMarkdown` and `_formatOffset` move into `ui/src/room/transcripts/export.ts` as pure functions taking a
  `StoredTranscript` and returning Markdown. Per-speaker completeness is not carried over; its only consumer was the removed dialog, and computing it for a stored transcript would need peer `finalSeq` values frozen at leave. It can be added without changing the stored shape.
- The live diagnostic pane behind "connection details" stays.

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
  empty visit is never stored. Runs against the in-memory store with a manual clock.
- `ui/src/room/transcripts/__tests__/dialog-policy.test.ts`: which rows are listed
  (`selectTranscriptRows`) and each duration case (`describeDuration`).
- The dialog and button are verified in the running app.

## Out of scope

- Sharing or syncing transcripts between peers; the DHT holds nothing.
- Retention limits or storage quotas.
- Editing transcripts.
- Any change to Moss.
