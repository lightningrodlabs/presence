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
