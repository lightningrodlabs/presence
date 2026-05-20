/**
 * TransitionRecorder — a fixed-capacity ring buffer of FSM transitions.
 *
 * The `onTransition` callback on `ConnectionManager` / `PeerConnectionFSM`
 * emits one structured `FSMTransitionEntry` per transition, each carrying a
 * full `TransportSnapshot`. That stream is the forensic record; this class is
 * a convenience that retains the last N entries so they can be dumped on
 * failure (bug report, error handler, support tooling) without the consumer
 * writing their own buffer.
 *
 * Usage:
 *   const recorder = new TransitionRecorder({ capacity: 500 });
 *   new ConnectionManager({ ..., onTransition: (e) => recorder.record(e) });
 *   // later, on failure:
 *   console.log(recorder.toJSON());
 */

import type { FSMTransitionEntry } from './types';

export type TransitionRecorderOptions = {
  /** Maximum number of entries retained. Oldest are dropped first. Default 1000. */
  capacity?: number;
};

const DEFAULT_CAPACITY = 1000;

export class TransitionRecorder {
  private _capacity: number;
  private _entries: FSMTransitionEntry[] = [];

  constructor(options?: TransitionRecorderOptions) {
    const capacity = options?.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`TransitionRecorder: capacity must be a positive integer, got ${capacity}`);
    }
    this._capacity = capacity;
  }

  /** Append a transition. Wire this directly to the `onTransition` callback. */
  record(entry: FSMTransitionEntry): void {
    this._entries.push(entry);
    if (this._entries.length > this._capacity) {
      this._entries.splice(0, this._entries.length - this._capacity);
    }
  }

  /** Number of entries currently retained. */
  get size(): number {
    return this._entries.length;
  }

  /** Configured maximum number of retained entries. */
  get capacity(): number {
    return this._capacity;
  }

  /** All retained entries, oldest first. Returns a copy. */
  dump(): FSMTransitionEntry[] {
    return this._entries.slice();
  }

  /** Retained entries for a single connection, oldest first. */
  dumpForConnection(connectionId: string): FSMTransitionEntry[] {
    return this._entries.filter(e => e.connectionId === connectionId);
  }

  /** Retained entries for a single remote agent, oldest first. */
  dumpForAgent(remoteAgent: string): FSMTransitionEntry[] {
    return this._entries.filter(e => e.remoteAgent === remoteAgent);
  }

  /** Drop all retained entries. */
  clear(): void {
    this._entries = [];
  }

  /** A portable JSON string of the full buffer, suitable for a bug report. */
  toJSON(): string {
    return JSON.stringify(
      {
        capacity: this._capacity,
        size: this._entries.length,
        entries: this._entries,
      },
      null,
      2,
    );
  }
}
