# Room Transcripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store one transcript per call visit in IndexedDB and let the user browse, view, download, and delete this room's transcripts from a dialog in the room header, replacing the exit-time save prompt.

**Architecture:** A `TranscriptStore` interface (IndexedDB in production, in-memory in tests and as fallback) is handed to `StreamsStore` through its deps record with the room key. The transcription controller opens a visit on `bind`, appends every ingested frame to it with coalesced writes, and closes it on `unbind`. A pure export module turns a stored transcript into ordered lines and Markdown. A new `transcripts-dialog` element, opened from a header button in `room-view`, lists and shows transcripts; the old save dialog and its room-view plumbing are deleted.

**Tech Stack:** TypeScript, Lit 3, `@holochain-open-dev/stores` writables, browser IndexedDB, vitest (node environment; no DOM, no IndexedDB in tests).

**Spec:** `docs/superpowers/specs/2026-09-22-room-transcripts-design.md`

## Global Constraints

- Presence repo rules (`CLAUDE.md`): no exclamation marks in prose; no Claude attribution in commits; decisions as pure functions with table-driven tests and no mocks; `nix develop -c npm run verify` is the gate (`tsc --noEmit` at `strict` plus `noUnusedLocals`/`noUnusedParameters`, so every removed feature must leave no dead members behind).
- Run every command from the `ui/` workspace unless stated; tests run with `npx vitest run <file>` from `ui/`.
- Comments explain intent, never prior behavior.
- No new npm dependencies (the sandbox cannot install them; IndexedDB is used through the browser API).
- Deviation from the spec, agreed here: per-speaker completeness (gap detection) is dropped with the old dialog. The only consumer was that dialog, and computing it for a stored transcript would require freezing peer `finalSeq` values at leave. It can be added later without changing the stored shape.

## File Structure

- Create `ui/src/room/transcripts/store.ts`: `StoredTranscript` type, `TranscriptStore` interface, `MemoryTranscriptStore`, `IndexedDbTranscriptStore`, `FallbackTranscriptStore`, `getTranscriptStore()` singleton.
- Create `ui/src/room/transcripts/export.ts`: pure functions from a `StoredTranscript` to ordered lines, Markdown, counts, and a file name.
- Create `ui/src/room/transcripts/transcripts-dialog.ts`: the overlay element (list and view modes).
- Create tests under `ui/src/room/transcripts/__tests__/`.
- Modify `ui/src/store-deps.ts`: add `transcripts?: { store: TranscriptStore; roomKey: string }`.
- Modify `ui/src/streams-store.ts`: expose `transcripts`, accept `roomKey` in `static connect`.
- Modify `ui/src/room/room-container.ts`: compute the room key from the cell and pass it to `connect`.
- Modify `ui/src/room/modules/transcription.ts`: visit lifecycle in the controller.
- Modify `ui/src/room/room-view.ts`: header button, dialog mount, label resolver, and removal of the save flow.
- Delete `ui/src/room/elements/save-transcript-dialog.ts`.

---

### Task 1: Transcript store

**Files:**
- Create: `ui/src/room/transcripts/store.ts`
- Test: `ui/src/room/transcripts/__tests__/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StoredTranscript {
    id: string; roomKey: string; roomName: string; startedAt: number; endedAt?: number;
    frames: TranscriptFrame[]; labels: Record<AgentPubKeyB64, string>;
  }
  export interface TranscriptStore {
    readonly degraded: boolean;
    listForRoom(roomKey: string): Promise<StoredTranscript[]>; // newest first
    get(id: string): Promise<StoredTranscript | undefined>;
    put(t: StoredTranscript): Promise<void>;
    delete(id: string): Promise<void>;
  }
  export class MemoryTranscriptStore implements TranscriptStore
  export class IndexedDbTranscriptStore implements TranscriptStore
  export class FallbackTranscriptStore implements TranscriptStore
  export function transcriptId(roomKey: string, startedAt: number): string
  export function getTranscriptStore(): TranscriptStore
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// ui/src/room/transcripts/__tests__/store.test.ts
import { describe, expect, it } from 'vitest';
import {
  FallbackTranscriptStore,
  MemoryTranscriptStore,
  transcriptId,
  type StoredTranscript,
  type TranscriptStore,
} from '../store';

function transcript(roomKey: string, startedAt: number, text = 'hi'): StoredTranscript {
  return {
    id: transcriptId(roomKey, startedAt),
    roomKey,
    roomName: 'Main Room',
    startedAt,
    frames: [
      {
        speaker: 'a', transcriber: 'a', seq: 0, tStart: 0, tEnd: 1000,
        committedAtMs: startedAt + 1000, text,
      },
    ],
    labels: {},
  };
}

/** Contract every implementation must satisfy. */
function contract(name: string, make: () => TranscriptStore) {
  describe(`${name} contract`, () => {
    it('lists a room newest first and keeps rooms apart', async () => {
      const s = make();
      await s.put(transcript('room-a', 1000));
      await s.put(transcript('room-a', 3000));
      await s.put(transcript('room-b', 2000));
      const a = await s.listForRoom('room-a');
      expect(a.map((t) => t.startedAt)).toEqual([3000, 1000]);
      expect((await s.listForRoom('room-b')).map((t) => t.startedAt)).toEqual([2000]);
      expect(await s.listForRoom('room-c')).toEqual([]);
    });

    it('put replaces by id and get returns the latest', async () => {
      const s = make();
      await s.put(transcript('room-a', 1000, 'first'));
      await s.put(transcript('room-a', 1000, 'second'));
      const got = await s.get(transcriptId('room-a', 1000));
      expect(got?.frames[0].text).toBe('second');
      expect(await s.listForRoom('room-a')).toHaveLength(1);
    });

    it('delete removes and is idempotent', async () => {
      const s = make();
      await s.put(transcript('room-a', 1000));
      await s.delete(transcriptId('room-a', 1000));
      await s.delete(transcriptId('room-a', 1000));
      expect(await s.get(transcriptId('room-a', 1000))).toBeUndefined();
    });

    it('returns copies, so mutating a result does not change the store', async () => {
      const s = make();
      await s.put(transcript('room-a', 1000));
      const got = (await s.get(transcriptId('room-a', 1000)))!;
      got.frames.push({ ...got.frames[0], seq: 1, text: 'leak' });
      expect((await s.get(transcriptId('room-a', 1000)))!.frames).toHaveLength(1);
    });
  });
}

contract('MemoryTranscriptStore', () => new MemoryTranscriptStore());

describe('FallbackTranscriptStore', () => {
  class Broken implements TranscriptStore {
    readonly degraded = false;
    async listForRoom(): Promise<StoredTranscript[]> { throw new Error('idb down'); }
    async get(): Promise<StoredTranscript | undefined> { throw new Error('idb down'); }
    async put(): Promise<void> { throw new Error('idb down'); }
    async delete(): Promise<void> { throw new Error('idb down'); }
  }

  it('switches to the fallback after the first failure and reports degraded', async () => {
    const s = new FallbackTranscriptStore(new Broken(), new MemoryTranscriptStore());
    expect(s.degraded).toBe(false);
    await s.put(transcript('room-a', 1000));
    expect(s.degraded).toBe(true);
    expect((await s.listForRoom('room-a')).map((t) => t.startedAt)).toEqual([1000]);
  });

  contract('FallbackTranscriptStore over memory', () =>
    new FallbackTranscriptStore(new MemoryTranscriptStore(), new MemoryTranscriptStore()),
  );
});

describe('transcriptId', () => {
  it('joins room key and start time', () => {
    expect(transcriptId('uhC#presence', 1700000000000)).toBe('uhC#presence:1700000000000');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/room/transcripts/__tests__/store.test.ts`
Expected: FAIL, cannot resolve `../store`.

- [ ] **Step 3: Write the store**

```ts
// ui/src/room/transcripts/store.ts
import type { AgentPubKeyB64 } from '@holochain/client';
import type { TranscriptFrame } from '../modules/transcription';

/**
 * One call visit's transcript: every frame received while the local
 * agent was in the room, from every speaker, plus the speaker labels
 * frozen at leave so old entries never depend on the profiles store.
 */
export interface StoredTranscript {
  /** `${roomKey}:${startedAt}` */
  id: string;
  /** `${dnaHashB64}#${roleName}` */
  roomKey: string;
  roomName: string;
  startedAt: number;
  /** Absent while the visit is live. */
  endedAt?: number;
  frames: TranscriptFrame[];
  labels: Record<AgentPubKeyB64, string>;
}

export interface TranscriptStore {
  /** True once persistence has failed and entries live only in memory. */
  readonly degraded: boolean;
  /** Newest `startedAt` first. */
  listForRoom(roomKey: string): Promise<StoredTranscript[]>;
  get(id: string): Promise<StoredTranscript | undefined>;
  put(t: StoredTranscript): Promise<void>;
  delete(id: string): Promise<void>;
}

export function transcriptId(roomKey: string, startedAt: number): string {
  return `${roomKey}:${startedAt}`;
}

function clone(t: StoredTranscript): StoredTranscript {
  return {
    ...t,
    frames: t.frames.map((f) => ({ ...f })),
    labels: { ...t.labels },
  };
}

function newestFirst(list: StoredTranscript[]): StoredTranscript[] {
  return [...list].sort((a, b) => b.startedAt - a.startedAt);
}

export class MemoryTranscriptStore implements TranscriptStore {
  readonly degraded = false;
  private readonly entries = new Map<string, StoredTranscript>();

  async listForRoom(roomKey: string): Promise<StoredTranscript[]> {
    return newestFirst(
      [...this.entries.values()].filter((t) => t.roomKey === roomKey).map(clone),
    );
  }

  async get(id: string): Promise<StoredTranscript | undefined> {
    const t = this.entries.get(id);
    return t ? clone(t) : undefined;
  }

  async put(t: StoredTranscript): Promise<void> {
    this.entries.set(t.id, clone(t));
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

const DB_NAME = 'presence-transcripts';
const DB_VERSION = 1;
const OBJECT_STORE = 'transcripts';
const ROOM_INDEX = 'byRoom';

export class IndexedDbTranscriptStore implements TranscriptStore {
  readonly degraded = false;
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const req = this.factory.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(OBJECT_STORE)) {
            const os = db.createObjectStore(OBJECT_STORE, { keyPath: 'id' });
            os.createIndex(ROOM_INDEX, 'roomKey', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
        req.onblocked = () => reject(new Error('indexedDB open blocked'));
      });
    }
    return this.db;
  }

  private async run<T>(
    mode: IDBTransactionMode,
    op: (os: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const req = op(db.transaction(OBJECT_STORE, mode).objectStore(OBJECT_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  }

  async listForRoom(roomKey: string): Promise<StoredTranscript[]> {
    const all = await this.run<StoredTranscript[]>('readonly', (os) =>
      os.index(ROOM_INDEX).getAll(roomKey),
    );
    return newestFirst(all);
  }

  async get(id: string): Promise<StoredTranscript | undefined> {
    return this.run<StoredTranscript | undefined>('readonly', (os) => os.get(id));
  }

  async put(t: StoredTranscript): Promise<void> {
    await this.run('readwrite', (os) => os.put(t));
  }

  async delete(id: string): Promise<void> {
    await this.run('readwrite', (os) => os.delete(id));
  }
}

/**
 * Uses `primary` until it fails once, then serves everything from
 * `fallback` for the rest of the page's life. Persistence problems
 * (private mode, quota, a blocked upgrade) must never interrupt a call;
 * the room button reads `degraded` to tell the user nothing is kept.
 */
export class FallbackTranscriptStore implements TranscriptStore {
  private failed = false;

  constructor(
    private readonly primary: TranscriptStore,
    private readonly fallback: TranscriptStore,
  ) {}

  get degraded(): boolean {
    return this.failed || this.primary.degraded;
  }

  private async via<T>(op: (s: TranscriptStore) => Promise<T>): Promise<T> {
    if (!this.failed) {
      try {
        return await op(this.primary);
      } catch (e) {
        console.warn('transcripts: persistent store failed, keeping transcripts in memory', e);
        this.failed = true;
      }
    }
    return op(this.fallback);
  }

  listForRoom(roomKey: string): Promise<StoredTranscript[]> {
    return this.via((s) => s.listForRoom(roomKey));
  }
  get(id: string): Promise<StoredTranscript | undefined> {
    return this.via((s) => s.get(id));
  }
  put(t: StoredTranscript): Promise<void> {
    return this.via((s) => s.put(t));
  }
  delete(id: string): Promise<void> {
    return this.via((s) => s.delete(id));
  }
}

let singleton: TranscriptStore | null = null;

/** The page-wide store: IndexedDB when the browser offers it, memory otherwise. */
export function getTranscriptStore(): TranscriptStore {
  if (!singleton) {
    const factory = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
    singleton = factory
      ? new FallbackTranscriptStore(new IndexedDbTranscriptStore(factory), new MemoryTranscriptStore())
      : new MemoryTranscriptStore();
  }
  return singleton;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/room/transcripts/__tests__/store.test.ts`
Expected: PASS (9 tests). Then `npm run typecheck -w ui` from the repo root: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/room/transcripts/store.ts ui/src/room/transcripts/__tests__/store.test.ts
git commit -m "feat(transcripts): TranscriptStore with IndexedDB, memory, and fallback implementations"
```

---

### Task 2: Export module

**Files:**
- Create: `ui/src/room/transcripts/export.ts`
- Test: `ui/src/room/transcripts/__tests__/export.test.ts`

**Interfaces:**
- Consumes: `StoredTranscript` from Task 1.
- Produces:
  ```ts
  export type LabelFor = (pk: AgentPubKeyB64) => string | undefined;
  export interface TranscriptLine { ts: number; speaker: AgentPubKeyB64; label: string; text: string }
  export function speakerLabel(t: StoredTranscript, pk: AgentPubKeyB64, live?: LabelFor): string
  export function transcriptLines(t: StoredTranscript, live?: LabelFor): TranscriptLine[]
  export function renderTranscriptMarkdown(t: StoredTranscript, live?: LabelFor): string
  export function formatOffset(ms: number): string
  export function wordCount(t: StoredTranscript): number
  export function speakerCount(t: StoredTranscript): number
  export function transcriptFileName(t: StoredTranscript): string
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// ui/src/room/transcripts/__tests__/export.test.ts
import { describe, expect, it } from 'vitest';
import type { StoredTranscript } from '../store';
import {
  formatOffset,
  renderTranscriptMarkdown,
  speakerCount,
  speakerLabel,
  transcriptFileName,
  transcriptLines,
  wordCount,
} from '../export';

function frame(speaker: string, seq: number, committedAtMs: number, text: string) {
  return { speaker, transcriber: speaker, seq, tStart: 0, tEnd: 1000, committedAtMs, text };
}

const base: StoredTranscript = {
  id: 'r:1000',
  roomKey: 'r',
  roomName: 'Main Room',
  startedAt: 1000,
  endedAt: 90_000,
  frames: [
    frame('bob', 0, 20_000, 'second speaker'),
    frame('alice', 0, 10_000, 'hello'),
    frame('alice', 1, 11_000, 'there'),
    frame('alice', 2, 16_000, 'after a pause'),
    frame('alice', 3, 17_000, '[BLANK_AUDIO]'),
    frame('alice', 4, 18_000, '  '),
  ],
  labels: { alice: 'Alice' },
};

describe('speakerLabel', () => {
  it('prefers the frozen label, then the live resolver, then a pubkey prefix', () => {
    expect(speakerLabel(base, 'alice', () => 'Live Alice')).toBe('Alice');
    expect(speakerLabel(base, 'bob', () => 'Bob')).toBe('Bob');
    expect(speakerLabel(base, 'uhCAk0123456789abcdef')).toBe('uhCAk01234…');
  });
});

describe('transcriptLines', () => {
  it('orders by commit time, drops blank and marker frames, and coalesces same-speaker runs within 3 s', () => {
    const lines = transcriptLines(base, (pk) => (pk === 'bob' ? 'Bob' : undefined));
    expect(lines.map((l) => `${l.label}: ${l.text}`)).toEqual([
      'Alice: hello there ⋯ after a pause',
      'Bob: second speaker',
    ]);
    expect(lines[0].ts).toBe(10_000);
  });

  it('starts a new line when the speaker changes even within 3 s', () => {
    const t: StoredTranscript = {
      ...base,
      frames: [frame('alice', 0, 1000, 'a'), frame('bob', 0, 1500, 'b'), frame('alice', 1, 2000, 'c')],
    };
    expect(transcriptLines(t).map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('renderTranscriptMarkdown', () => {
  it('writes a header, offset-stamped lines, and a participants key', () => {
    const md = renderTranscriptMarkdown(base, (pk) => (pk === 'bob' ? 'Bob' : undefined));
    expect(md.startsWith('# Transcript — Main Room\n')).toBe(true);
    expect(md).toContain('**[00:00]** **Alice:** hello there ⋯ after a pause');
    expect(md).toContain('**[00:10]** **Bob:** second speaker');
    expect(md).toContain('## Participants');
    expect(md).toContain('- **Alice** — `alice`');
    expect(md).toContain('- **Bob** — `bob`');
  });
});

describe('counts and names', () => {
  it('counts words of kept frames and distinct speakers', () => {
    expect(wordCount(base)).toBe(7);
    expect(speakerCount(base)).toBe(2);
  });

  it('formats offsets as MM:SS or HH:MM:SS', () => {
    expect(formatOffset(0)).toBe('00:00');
    expect(formatOffset(65_000)).toBe('01:05');
    expect(formatOffset(3_725_000)).toBe('01:02:05');
  });

  it('builds a file name from the room and start time', () => {
    expect(transcriptFileName(base)).toBe('transcript-Main-Room-1970-01-01T00-00-01-000Z.md');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/room/transcripts/__tests__/export.test.ts`
Expected: FAIL, cannot resolve `../export`.

- [ ] **Step 3: Write the export module**

```ts
// ui/src/room/transcripts/export.ts
import type { AgentPubKeyB64 } from '@holochain/client';
import type { StoredTranscript } from './store';

export type LabelFor = (pk: AgentPubKeyB64) => string | undefined;

export interface TranscriptLine {
  /** Commit time of the first frame in the line (sender wall clock). */
  ts: number;
  speaker: AgentPubKeyB64;
  label: string;
  text: string;
}

/** Sub-3 s gaps are phrase breaks; wider gaps get a visible stitch. */
const COALESCE_MS = 3000;
const STITCH_GLYPH = '⋯';
/** Whisper's non-speech markers, e.g. [BLANK_AUDIO], [NOISE]. */
const MARKER = /^\[[^\]]*\]\.?$/;

export function speakerLabel(
  t: StoredTranscript,
  pk: AgentPubKeyB64,
  live?: LabelFor,
): string {
  return t.labels[pk] ?? live?.(pk) ?? pk.slice(0, 10) + '…';
}

function keptFrames(t: StoredTranscript) {
  return t.frames
    .map((f) => ({ ...f, text: f.text.trim() }))
    .filter((f) => f.text && !MARKER.test(f.text))
    .sort((a, b) => a.committedAtMs - b.committedAtMs);
}

export function transcriptLines(t: StoredTranscript, live?: LabelFor): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const f of keptFrames(t)) {
    const prev = lines[lines.length - 1];
    if (prev && prev.speaker === f.speaker) {
      const joiner = f.committedAtMs - prev.ts < COALESCE_MS ? ' ' : ` ${STITCH_GLYPH} `;
      prev.text = `${prev.text}${joiner}${f.text}`;
    } else {
      lines.push({
        ts: f.committedAtMs,
        speaker: f.speaker,
        label: speakerLabel(t, f.speaker, live),
        text: f.text,
      });
    }
  }
  return lines;
}

export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function renderTranscriptMarkdown(t: StoredTranscript, live?: LabelFor): string {
  const lines = transcriptLines(t, live);
  const t0 = lines.length > 0 ? lines[0].ts : t.startedAt;
  const header =
    `# Transcript — ${t.roomName}\n` +
    `_Started ${new Date(t.startedAt).toISOString()}_\n\n`;
  const body = lines
    .map((l) => `**[${formatOffset(l.ts - t0)}]** **${l.label}:** ${l.text}`)
    .join('\n\n');
  const speakers = [...new Set(lines.map((l) => l.speaker))];
  const key = speakers.map((pk) => `- **${speakerLabel(t, pk, live)}** — \`${pk}\``).join('\n');
  const keySection = speakers.length > 0 ? `\n\n---\n\n## Participants\n\n${key}\n` : '';
  return header + body + keySection;
}

export function wordCount(t: StoredTranscript): number {
  return keptFrames(t).reduce((n, f) => n + f.text.split(/\s+/).filter(Boolean).length, 0);
}

export function speakerCount(t: StoredTranscript): number {
  return new Set(keptFrames(t).map((f) => f.speaker)).size;
}

export function transcriptFileName(t: StoredTranscript): string {
  const room = t.roomName.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'room';
  const stamp = new Date(t.startedAt).toISOString().replace(/[:.]/g, '-');
  return `transcript-${room}-${stamp}.md`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/room/transcripts/__tests__/export.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/room/transcripts/export.ts ui/src/room/transcripts/__tests__/export.test.ts
git commit -m "feat(transcripts): pure export of a stored transcript to lines and Markdown"
```

---

### Task 3: Visit lifecycle in the controller and store deps

**Files:**
- Modify: `ui/src/store-deps.ts` (the `StreamsStoreDeps` type at the end of the file)
- Modify: `ui/src/streams-store.ts` (field next to `localModels` ~line 539, constructor ~line 550, `static connect` ~lines 1360-1390)
- Modify: `ui/src/room/room-container.ts` (~lines 68-88)
- Modify: `ui/src/room/modules/transcription.ts` (imports, class fields ~line 205-235, `bind`/`unbind` ~line 236-243, `ingestFrame` ~line 954)
- Test: `ui/src/room/transcripts/__tests__/visit.test.ts`

**Interfaces:**
- Consumes: `TranscriptStore`, `StoredTranscript`, `transcriptId` from Task 1.
- Produces on `StreamsStoreDeps` and `StreamsStore`: `transcripts?: { store: TranscriptStore; roomKey: string }`.
- Produces on `transcriptionController`: `readonly liveVisit: Writable<StoredTranscript | null>`, `setVisitRoomName(name: string): void`, `setSpeakerLabelResolver(fn: LabelFor | null): void`, `endVisit(): Promise<void>`.
- `StreamsStore.connect(roomStore, screenSourceSelection, logger, weaveClient?, roomKey?)`.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/room/transcripts/__tests__/visit.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from '@holochain-open-dev/stores';
import type { StreamsStore } from '../../../streams-store';
import { transcriptionController, type TranscriptEntry, type TranscriptFrame } from '../../modules/transcription';
import { MemoryTranscriptStore } from '../store';

function frame(speaker: string, seq: number, text: string, committedAtMs: number): TranscriptFrame {
  return { speaker, transcriber: speaker, seq, tStart: 0, tEnd: 1000, committedAtMs, text };
}

function fakeStore(store: MemoryTranscriptStore, roomKey: string) {
  return {
    myPubKeyB64: 'me',
    _myModuleStates: writable({}),
    _transcriptLog: writable(new Map<string, TranscriptEntry[]>()),
    sendModuleData: async () => {},
    transcripts: { store, roomKey },
  } as unknown as StreamsStore;
}

/** The controller's ingestion entry point for a peer frame, as the module's onData calls it. */
function ingest(fromAgent: string, f: TranscriptFrame) {
  transcriptionController.receiveFrame(fromAgent, JSON.stringify(f));
}

describe('transcript visit lifecycle', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => {
    transcriptionController.unbind();
    vi.useRealTimers();
  });

  it('opens a visit on bind, writes frames from every speaker, and closes it on endVisit', async () => {
    const store = new MemoryTranscriptStore();
    transcriptionController.bind(fakeStore(store, 'room-a'));
    transcriptionController.setVisitRoomName('Main Room');
    transcriptionController.setSpeakerLabelResolver((pk) => (pk === 'alice' ? 'Alice' : undefined));
    await vi.runOnlyPendingTimersAsync();

    let list = await store.listForRoom('room-a');
    expect(list).toHaveLength(1);
    expect(list[0].startedAt).toBe(1_000_000);
    expect(list[0].endedAt).toBeUndefined();
    expect(get(transcriptionController.liveVisit)?.id).toBe(list[0].id);

    ingest('alice', frame('alice', 0, 'hello', 1_001_000));
    ingest('bob', frame('bob', 0, 'hi', 1_002_000));
    ingest('alice', frame('alice', 0, 'hello again', 1_001_000)); // duplicate (transcriber, seq)
    list = await store.listForRoom('room-a');
    expect(list[0].frames).toHaveLength(0); // not written yet: writes are coalesced
    await vi.advanceTimersByTimeAsync(2_000);
    list = await store.listForRoom('room-a');
    expect(list[0].frames.map((f) => f.text)).toEqual(['hello', 'hi']);
    expect(list[0].roomName).toBe('Main Room');

    await transcriptionController.endVisit();
    list = await store.listForRoom('room-a');
    expect(typeof list[0].endedAt).toBe('number');
    expect(list[0].endedAt).toBeGreaterThanOrEqual(list[0].startedAt);
    expect(list[0].labels).toEqual({ alice: 'Alice' });
    expect(get(transcriptionController.liveVisit)).toBeNull();
  });

  it('deletes a visit that received no frames', async () => {
    const store = new MemoryTranscriptStore();
    transcriptionController.bind(fakeStore(store, 'room-a'));
    await vi.runOnlyPendingTimersAsync();
    expect(await store.listForRoom('room-a')).toHaveLength(1);
    await transcriptionController.endVisit();
    expect(await store.listForRoom('room-a')).toHaveLength(0);
  });

  it('does nothing without a transcripts dep', async () => {
    const s = fakeStore(new MemoryTranscriptStore(), 'room-a');
    delete (s as any).transcripts;
    transcriptionController.bind(s);
    ingest('alice', frame('alice', 0, 'hello', 1_001_000));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(get(transcriptionController.liveVisit)).toBeNull();
    await transcriptionController.endVisit();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/room/transcripts/__tests__/visit.test.ts`
Expected: FAIL: `transcriptionController.setVisitRoomName is not a function`.

- [ ] **Step 3: Add the dep to the store record**

In `ui/src/store-deps.ts` add the import at the top and the field at the end of `StreamsStoreDeps`:

```ts
import type { TranscriptStore } from './room/transcripts/store';

export type StreamsStoreDeps = {
  clock: Clock;
  storage: StorageDep;
  bus: SignalBus;
  transportFactory: TransportFactory;
  mediaDevices: MediaDevicesDep;
  /** The host's local-model surface (`WeaveClient.localModels`), when the
   *  host provides one. Consumed only by the transcription controller. */
  localModels?: LocalModelsApi;
  /** Where this room's transcripts are kept and the key they are filed
   *  under. Absent in tests that do not exercise transcripts. */
  transcripts?: { store: TranscriptStore; roomKey: string };
};
```

In `ui/src/streams-store.ts`, next to the `localModels` field (~line 539):

```ts
  readonly localModels: LocalModelsApi | undefined;
  /** Transcript persistence for this room; undefined when not wired. */
  readonly transcripts: StreamsStoreDeps['transcripts'];
```

In the constructor after `this.localModels = deps.localModels;`:

```ts
    this.transcripts = deps.transcripts;
```

In `static async connect`, add a fifth parameter and pass it into deps. Add the import `import { getTranscriptStore } from './room/transcripts/store';` near the other imports.

```ts
  static async connect(
    roomStore: RoomStore,
    screenSourceSelection: () => Promise<string>,
    logger: PresenceLogger,
    weaveClient?: Pick<WeaveClient, 'localModels'>,
    roomKey?: string
  ): Promise<StreamsStore> {
    ...
    const deps: StreamsStoreDeps = {
      clock: systemClock,
      storage: { local: window.localStorage, session: window.sessionStorage },
      bus: { ... unchanged ... },
      transportFactory: (_purpose, options) => new FsmTransport(options),
      mediaDevices: navigator.mediaDevices,
      localModels: weaveClient?.localModels,
      transcripts: roomKey ? { store: getTranscriptStore(), roomKey } : undefined,
    };
```

- [ ] **Step 4: Compute the room key in room-container**

In `ui/src/room/room-container.ts`, inside `firstUpdated` after `const cellTypes = getCellTypes(appInfo);` and the `myCell` lookup, and change the `connect` call:

```ts
    // Transcripts are filed per cell so a re-created room with a reused
    // clone id never inherits another room's history.
    const cell = myCell ?? cellTypes.provisioned;
    const roomKey = `${encodeHashToBase64(cell.cell_id[0])}#${this.roleName}`;
    ...
    this.streamsStore = await StreamsStore.connect(
      this.roomStore,
      () => this.weaveClient.userSelectScreen(),
      this._presenceLogger,
      this.weaveClient,
      roomKey
    );
```

Add `import { encodeHashToBase64 } from '@holochain/client';` to the imports of `room-container.ts` (it does not import it today).

- [ ] **Step 5: Add the visit lifecycle to the controller**

In `ui/src/room/modules/transcription.ts`, add imports:

```ts
import { transcriptId, type StoredTranscript, type TranscriptStore } from '../transcripts/store';
import type { LabelFor } from '../transcripts/export';
```

Add fields to `TranscriptionController` next to `private seq = 0;`:

```ts
  /**
   * The call visit being recorded: one StoredTranscript from bind to
   * endVisit, holding every frame from every speaker. Written to the
   * store at most once per VISIT_WRITE_INTERVAL_MS while frames arrive,
   * and once more when the visit ends.
   */
  private visit: StoredTranscript | null = null;
  private visitStore: TranscriptStore | null = null;
  private visitDirty = false;
  private visitWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private labelFor: LabelFor | null = null;
  private static readonly VISIT_WRITE_INTERVAL_MS = 2000;
  /** The live visit for the transcripts dialog; null outside a room. */
  readonly liveVisit: Writable<StoredTranscript | null> = writable(null);
```

Replace `bind` and `unbind`:

```ts
  bind(store: StreamsStore) {
    this.store = store;
    // Frame numbering is per speaker per room: receivers drop a repeated
    // (transcriber, seq), so every capture session in this room must
    // continue the count, and only a new room starts over.
    this.seq = 0;
    this.openVisit(store);
  }

  unbind() {
    // The closing commit's final is delivered during stopCapture, so the
    // visit ends only after capture has fully stopped.
    const stopped = this.stopCapture().catch(() => {});
    this.pendingRequests.set(new Set());
    this.store = null;
    void stopped.then(() => this.endVisit());
  }

  /** Display name for the visit, learned by room-view once room info loads. */
  setVisitRoomName(name: string): void {
    if (this.visit && this.visit.roomName !== name) {
      this.visit.roomName = name;
      this.markVisitDirty();
    }
  }

  /** Nickname lookup used to freeze speaker labels when the visit ends. */
  setSpeakerLabelResolver(fn: LabelFor | null): void {
    this.labelFor = fn;
  }

  private openVisit(store: StreamsStore): void {
    const t = store.transcripts;
    if (!t) return;
    const startedAt = Date.now();
    this.visitStore = t.store;
    this.visit = {
      id: transcriptId(t.roomKey, startedAt),
      roomKey: t.roomKey,
      roomName: '',
      startedAt,
      frames: [],
      labels: {},
    };
    this.liveVisit.set(this.visit);
    this.markVisitDirty();
  }

  private appendToVisit(frame: TranscriptFrame): void {
    const v = this.visit;
    if (!v) return;
    if (v.frames.some(f => f.transcriber === frame.transcriber && f.seq === frame.seq)) return;
    v.frames.push({ ...frame });
    // A fresh object reference so subscribers re-render on every frame.
    this.liveVisit.set({ ...v });
    this.markVisitDirty();
  }

  private markVisitDirty(): void {
    this.visitDirty = true;
    if (this.visitWriteTimer !== null) return;
    this.visitWriteTimer = setTimeout(() => {
      this.visitWriteTimer = null;
      void this.writeVisit();
    }, TranscriptionController.VISIT_WRITE_INTERVAL_MS);
  }

  private async writeVisit(): Promise<void> {
    if (!this.visit || !this.visitStore || !this.visitDirty) return;
    this.visitDirty = false;
    try {
      await this.visitStore.put(this.visit);
    } catch (e) {
      console.error('transcription: visit write failed', e);
    }
  }

  /**
   * Close the visit: freeze speaker labels, stamp the end, and write it.
   * A visit that never received a frame is removed instead, so the
   * transcripts list only shows calls with content.
   */
  async endVisit(): Promise<void> {
    const v = this.visit;
    const s = this.visitStore;
    this.visit = null;
    this.visitStore = null;
    this.liveVisit.set(null);
    if (this.visitWriteTimer !== null) {
      clearTimeout(this.visitWriteTimer);
      this.visitWriteTimer = null;
    }
    this.visitDirty = false;
    if (!v || !s) return;
    try {
      if (v.frames.length === 0) {
        await s.delete(v.id);
        return;
      }
      v.endedAt = Date.now();
      for (const pk of new Set(v.frames.map(f => f.speaker))) {
        const label = this.labelFor?.(pk);
        if (label) v.labels[pk] = label;
      }
      await s.put(v);
    } catch (e) {
      console.error('transcription: visit close failed', e);
    }
  }
```

At the end of `ingestFrame`, after the `_transcriptLog.update(...)` call, add:

```ts
    this.appendToVisit(frame);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/room/transcripts/__tests__/visit.test.ts src/room/modules/__tests__/transcription-seq.test.ts`
Expected: PASS. Then from the repo root `npm run typecheck -w ui`: 0 errors. If `Writable` is not yet imported in transcription.ts, it is (`import { get, writable, Writable } from '@holochain-open-dev/stores'`).

- [ ] **Step 7: Commit**

```bash
git add ui/src/store-deps.ts ui/src/streams-store.ts ui/src/room/room-container.ts ui/src/room/modules/transcription.ts ui/src/room/transcripts/__tests__/visit.test.ts
git commit -m "feat(transcripts): record one transcript per call visit in the transcript store"
```

---

### Task 4: Transcripts dialog and header button

**Files:**
- Create: `ui/src/room/transcripts/transcripts-dialog.ts`
- Modify: `ui/src/room/room-view.ts` (imports ~lines 28-35 and 79-112; fields ~line 300-330; `firstUpdated` ~line 1262; header ~line 2727; overlay render ~line 3647)

**Interfaces:**
- Consumes: `TranscriptStore`, `StoredTranscript` (Task 1); `transcriptLines`, `renderTranscriptMarkdown`, `wordCount`, `speakerCount`, `transcriptFileName`, `formatOffset`, `LabelFor` (Task 2); `transcriptionController.liveVisit`, `setVisitRoomName`, `setSpeakerLabelResolver` (Task 3).
- Produces: `<transcripts-dialog .store .roomKey .live .labelFor @transcripts-close>`.

- [ ] **Step 1: Write the dialog element**

```ts
// ui/src/room/transcripts/transcripts-dialog.ts
import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { localized, msg } from '@lit/localize';
import { mdiArrowLeft, mdiDeleteOutline, mdiDownloadOutline, mdiEyeOutline } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';

import type { StoredTranscript, TranscriptStore } from './store';
import {
  formatOffset,
  renderTranscriptMarkdown,
  speakerCount,
  transcriptFileName,
  transcriptLines,
  wordCount,
  type LabelFor,
} from './export';

/**
 * Overlay listing this room's stored transcripts with view, download and
 * delete, plus the live visit at the top while a call is in progress.
 *
 * Events: `transcripts-close`.
 */
@localized()
@customElement('transcripts-dialog')
export class TranscriptsDialog extends LitElement {
  @property({ attribute: false }) store!: TranscriptStore;
  @property({ type: String }) roomKey = '';
  /** The visit in progress, or null. Rendered first and marked live. */
  @property({ attribute: false }) live: StoredTranscript | null = null;
  @property({ attribute: false }) labelFor: LabelFor = () => undefined;

  @state() private _entries: StoredTranscript[] = [];
  @state() private _loading = true;
  @state() private _viewing: StoredTranscript | null = null;
  @state() private _confirmDelete: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this._reload();
  }

  private async _reload() {
    this._loading = true;
    try {
      this._entries = await this.store.listForRoom(this.roomKey);
    } catch (e) {
      console.error('transcripts: list failed', e);
      this._entries = [];
    } finally {
      this._loading = false;
    }
  }

  /** Stored entries with the live visit substituted for its own stored copy. */
  private _rows(): StoredTranscript[] {
    const live = this.live;
    const stored = this._entries.filter((t) => !live || t.id !== live.id);
    return live ? [live, ...stored] : stored;
  }

  private _close() {
    this.dispatchEvent(new CustomEvent('transcripts-close', { bubbles: true, composed: true }));
  }

  private _download(t: StoredTranscript) {
    const blob = new Blob([renderTranscriptMarkdown(t, this.labelFor)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = transcriptFileName(t);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async _delete(id: string) {
    this._confirmDelete = null;
    try {
      await this.store.delete(id);
    } catch (e) {
      console.error('transcripts: delete failed', e);
    }
    if (this._viewing?.id === id) this._viewing = null;
    await this._reload();
  }

  private _duration(t: StoredTranscript): string {
    if (!t.endedAt) return msg('live');
    return formatOffset(t.endedAt - t.startedAt);
  }

  private _renderRow(t: StoredTranscript) {
    const isLive = this.live?.id === t.id;
    const confirming = this._confirmDelete === t.id;
    return html`
      <div class="row entry ${isLive ? 'live' : ''}">
        <div class="column meta">
          <div class="when">${new Date(t.startedAt).toLocaleString()}</div>
          <div class="facts">
            ${this._duration(t)} · ${speakerCount(t)} ${msg('speakers')} · ${wordCount(t)} ${msg('words')}
          </div>
        </div>
        <div class="row actions">
          ${confirming
            ? html`
                <span class="confirm">${msg('Delete this transcript?')}</span>
                <button class="danger" @click=${() => this._delete(t.id)}>${msg('Yes')}</button>
                <button class="secondary" @click=${() => (this._confirmDelete = null)}>${msg('No')}</button>
              `
            : html`
                <button class="icon" title=${msg('View')} @click=${() => (this._viewing = t)}>
                  <sl-icon .src=${wrapPathInSvg(mdiEyeOutline)}></sl-icon>
                </button>
                <button class="icon" title=${msg('Download')} @click=${() => this._download(t)}>
                  <sl-icon .src=${wrapPathInSvg(mdiDownloadOutline)}></sl-icon>
                </button>
                ${isLive
                  ? nothing
                  : html`<button class="icon" title=${msg('Delete')} @click=${() => (this._confirmDelete = t.id)}>
                      <sl-icon .src=${wrapPathInSvg(mdiDeleteOutline)}></sl-icon>
                    </button>`}
              `}
        </div>
      </div>
    `;
  }

  private _renderList() {
    const rows = this._rows();
    return html`
      <div class="headline">${msg('Transcripts')}</div>
      ${this.store.degraded
        ? html`<div class="warning">${msg('Transcripts cannot be stored in this browser; only the current call is available.')}</div>`
        : nothing}
      ${this._loading
        ? html`<div class="body">${msg('Loading…')}</div>`
        : rows.length === 0
          ? html`<div class="body">${msg('No transcripts yet. Start transcription during a call and it will appear here.')}</div>`
          : rows.map((t) => this._renderRow(t))}
      <div class="row actions end">
        <button class="secondary" @click=${() => this._close()}>${msg('Close')}</button>
      </div>
    `;
  }

  private _renderView(t: StoredTranscript) {
    // The live visit is re-read from `live` so the view grows with the call.
    const current = this.live?.id === t.id ? this.live : t;
    const lines = transcriptLines(current, this.labelFor);
    const t0 = lines.length > 0 ? lines[0].ts : current.startedAt;
    return html`
      <div class="row center-content" style="gap: 8px;">
        <button class="icon" title=${msg('Back')} @click=${() => (this._viewing = null)}>
          <sl-icon .src=${wrapPathInSvg(mdiArrowLeft)}></sl-icon>
        </button>
        <div class="headline">${new Date(current.startedAt).toLocaleString()} · ${this._duration(current)}</div>
        <span style="flex: 1;"></span>
        <button class="icon" title=${msg('Download')} @click=${() => this._download(current)}>
          <sl-icon .src=${wrapPathInSvg(mdiDownloadOutline)}></sl-icon>
        </button>
      </div>
      <div class="transcript">
        ${lines.length === 0
          ? html`<div class="body">${msg('No utterances yet.')}</div>`
          : lines.map(
              (l) => html`
                <p>
                  <span class="offset">[${formatOffset(l.ts - t0)}]</span>
                  <b>${l.label}:</b> ${l.text}
                </p>
              `,
            )}
      </div>
    `;
  }

  render() {
    return html`
      <div class="dialog" @click=${() => this._close()}>
        <div class="panel" @click=${(e: Event) => e.stopPropagation()} @keypress=${() => undefined}>
          <div class="column" style="gap: 12px;">
            ${this._viewing ? this._renderView(this._viewing) : this._renderList()}
          </div>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host { display: contents; }
    .dialog {
      position: fixed; inset: 0; z-index: 25;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.35);
    }
    .panel {
      background: white; color: #222; border-radius: 12px;
      padding: 18px 20px; width: min(720px, 92vw); max-height: 85vh;
      overflow: auto; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
      font-family: 'Ubuntu', sans-serif;
    }
    .row { display: flex; flex-direction: row; align-items: center; }
    .column { display: flex; flex-direction: column; }
    .center-content { align-items: center; }
    .headline { font-size: 18px; font-weight: 600; }
    .body { font-size: 14px; color: #444; }
    .warning { font-size: 13px; color: #8a5a00; background: #fff4d6; padding: 6px 10px; border-radius: 6px; }
    .entry { justify-content: space-between; padding: 8px 4px; border-bottom: 1px solid #eee; gap: 12px; }
    .entry.live .when::after { content: ' · live'; color: #09b500; font-weight: 600; }
    .when { font-size: 14px; font-weight: 500; }
    .facts { font-size: 12px; color: #666; }
    .actions { gap: 6px; }
    .actions.end { justify-content: flex-end; margin-top: 6px; }
    .confirm { font-size: 13px; margin-right: 4px; }
    .transcript { max-height: 60vh; overflow: auto; font-size: 14px; line-height: 1.45; }
    .transcript p { margin: 0 0 10px; }
    .offset { color: #888; font-family: monospace; font-size: 12px; margin-right: 6px; }
    button { border: none; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
    button.icon { background: transparent; padding: 4px; font-size: 18px; color: #333; }
    button.icon:hover { background: #eee; }
    button.secondary { background: #eee; }
    button.secondary:hover { background: #ddd; }
    button.danger { background: #d23030; color: white; }
    button.danger:hover { background: #b02020; }
  `;
}
```

- [ ] **Step 2: Mount it from room-view**

In `ui/src/room/room-view.ts`:

Add `mdiTextBoxMultipleOutline` to the `@mdi/js` import list (~line 28-35). Add after the `'./elements/transcription-request-dialog'` import (~line 78):

```ts
import './transcripts/transcripts-dialog';
```

Add fields next to `_transcriptLog` (~line 300):

```ts
  /** The visit being recorded, for the live row of the transcripts dialog. */
  _liveVisit = new StoreSubscriber(
    this,
    () => transcriptionController.liveVisit,
    () => [this.streamsStore],
  );

  @state()
  private _transcriptsOpen = false;
```

In `firstUpdated`, right after `this._roomInfo = await this.roomStore.client.getRoomInfo();` (~line 1262):

```ts
    transcriptionController.setVisitRoomName(this.roomName());
    transcriptionController.setSpeakerLabelResolver(pk => this._speakerLabels.get(pk));
```

Add a render helper next to `_renderTranscriptionToolbarButton` (~line 954):

```ts
  private _renderTranscriptsButton() {
    const transcripts = this.streamsStore.transcripts;
    if (!transcripts) return html``;
    const tooltip = transcripts.store.degraded
      ? msg('Transcripts (not stored in this browser)')
      : msg('Transcripts');
    return html`
      <sl-tooltip content=${tooltip} hoist>
        <div
          class="toggle-btn"
          tabindex="0"
          @click=${() => (this._transcriptsOpen = true)}
          @keypress=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') this._transcriptsOpen = true;
          }}
        >
          <sl-icon class="toggle-btn-icon" .src=${wrapPathInSvg(mdiTextBoxMultipleOutline)}></sl-icon>
        </div>
      </sl-tooltip>
    `;
  }

  private _renderTranscriptsDialog() {
    const transcripts = this.streamsStore.transcripts;
    if (!this._transcriptsOpen || !transcripts) return html``;
    // Freeze labels for peers whose profiles are loaded, so the dialog
    // shows nicknames without waiting on the lazy profiles store.
    void this._refreshSpeakerLabels(Array.from(this._transcriptLog.value?.keys() ?? []));
    return html`
      <transcripts-dialog
        .store=${transcripts.store}
        .roomKey=${transcripts.roomKey}
        .live=${this._liveVisit.value ?? null}
        .labelFor=${(pk: AgentPubKeyB64) => this._speakerLabels.get(pk)}
        @transcripts-close=${() => (this._transcriptsOpen = false)}
      ></transcripts-dialog>
    `;
  }
```

In the header, directly after `${this._renderTranscriptionToolbarButton()}` (~line 2727):

```ts
        ${this._renderTranscriptsButton()}
```

In the main render, directly after `${this._renderTranscriptionRequestPrompt()}` (~line 3647):

```ts
      ${this._renderTranscriptsDialog()}
```

- [ ] **Step 3: Typecheck and check in the app**

Run from the repo root: `npm run typecheck -w ui`. Expected: 0 errors.

Then launch as in the moss worktree (`PRESENCE_DIR=/home/eric/code/metacurrency/holochain/presence-ai-transcription yarn applet-dev-presence` from `moss-ai-transcription`), join the room, and confirm: the new header button opens the dialog; the live row appears once transcription has produced a frame; View shows lines growing; Download saves a `.md`; after leaving and rejoining, the previous visit is listed; Delete asks once and removes it; the same list is visible when the room is opened as an asset.

- [ ] **Step 4: Commit**

```bash
git add ui/src/room/transcripts/transcripts-dialog.ts ui/src/room/room-view.ts
git commit -m "feat(transcripts): transcripts dialog and header button in the room"
```

---

### Task 5: Remove the exit-time save flow

**Files:**
- Modify: `ui/src/room/room-view.ts` (`quitRoom` ~line 518; save members ~lines 309-321, 555-626, 678-693, 749-865, 1043-1051; `_transcriptionWasActive` uses ~lines 893, 919; render ~line 3648; imports lines 79, 108)
- Delete: `ui/src/room/elements/save-transcript-dialog.ts`

**Interfaces:**
- Consumes: nothing new. `_speakerLabels`, `_refreshSpeakerLabels`, `_speakerLabel`, `_renderTranscriptionPane`, `_formatClockShort` stay (used by the live pane and the dialog).

- [ ] **Step 1: Remove the members**

In `ui/src/room/room-view.ts` delete, in this order (line numbers shift as you go; locate by name):

1. The imports `import './elements/save-transcript-dialog';` and `import type { SpeakerCompleteness } from './elements/save-transcript-dialog';`.
2. The fields `_saveTranscriptSpeakers`, `_saveTranscriptMarkdown`, `_resumeQuit`, and `_transcriptionWasActive`, with their doc comments.
3. The methods `_promptSaveTranscript`, `_formatOffset`, `_buildTranscriptMarkdown`, `_handleSaveTranscriptConfirm`, `_handleSaveTranscriptDiscard`, `_closeSaveTranscriptDialog`, and `_renderSaveTranscriptDialog`, with their doc comments.
4. The two statements `this._transcriptionWasActive = true;` in `_toggleTranscriptionRequest` and `_handleTranscriptionAccept`.
5. The line `${this._renderSaveTranscriptDialog()}` in the main render.

Replace `quitRoom` with:

```ts
  async quitRoom() {
    // Announce completion so peers can tell our transcript is whole
    // before our signals stop; the visit itself is closed by the
    // controller when the store unbinds.
    const myTx = parseTranscriptionPayload(
      (this._myModuleStates.value || {})['transcription'] ?? null,
    );
    if (myTx?.enabled || myTx?.requested) {
      try {
        await transcriptionController.stopAndAnnounce();
      } catch (e) {
        console.error('transcription: stopAndAnnounce on quit failed', e);
      }
    }
    this.streamsStore.disconnect('quitRoom-button');
    this.streamsStore.logger.endSession();
    this.dispatchEvent(
      new CustomEvent('quit-room', { bubbles: true, composed: true })
    );
  }
```

Delete the file:

```bash
git rm ui/src/room/elements/save-transcript-dialog.ts
```

- [ ] **Step 2: Typecheck**

Run from the repo root: `npm run typecheck -w ui`. Expected: 0 errors. `noUnusedLocals` will name anything left behind (for example `TranscriptEntry` or `decodeHashFromBase64` imports that only the removed code used); remove those too.

- [ ] **Step 3: Run the gate**

Run from the repo root: `npm run verify`. Expected: both workspaces green.

- [ ] **Step 4: Commit**

```bash
git add -A ui/src/room
git commit -m "refactor(transcription): drop the exit-time save prompt; transcripts live in the room dialog"
```

---

### Task 6: Documentation

**Files:**
- Modify: `TRANSCRIPTION_PLAN.md` (section "Exit-time persistence", ~line 253)
- Modify: `docs/superpowers/specs/2026-09-22-room-transcripts-design.md` (Status line and the completeness sentences)

- [ ] **Step 1: Mark the superseded section**

In `TRANSCRIPTION_PLAN.md`, insert directly under the `### Exit-time persistence` heading:

```markdown
Status: SUPERSEDED (see `docs/superpowers/specs/2026-09-22-room-transcripts-design.md`): transcripts are stored per call visit in IndexedDB and browsed from a dialog in the room; there is no exit-time prompt.
```

- [ ] **Step 2: Record the deviation in the spec**

In the spec, change the Status line to `Status: IMPLEMENTED 2026-09-22 (see docs/superpowers/plans/2026-09-22-room-transcripts.md)` and replace the sentence in "Removals" that moves "the completeness computation" into the export module with: "Per-speaker completeness is not carried over; its only consumer was the removed dialog, and computing it for a stored transcript would need peer `finalSeq` values frozen at leave. It can be added without changing the stored shape." Remove "completeness verdicts" from the export test bullet in "Testing".

- [ ] **Step 3: Commit**

```bash
git add TRANSCRIPTION_PLAN.md docs/superpowers/specs/2026-09-22-room-transcripts-design.md
git commit -m "docs: mark exit-time transcript saving superseded by room transcripts"
```
