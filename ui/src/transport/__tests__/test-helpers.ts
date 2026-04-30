/**
 * Test helpers for transport tests.
 *
 * - MockSimplePeer: a SimplePeerLike implementation that records method calls
 *   and exposes test-only emit() to simulate SimplePeer's events.
 * - FakeSignalingChannel: in-memory routing of OutgoingSignals between two
 *   transports so they can talk to each other without a network stack.
 */

import type { AgentPubKeyB64 } from '@holochain/client';
import type { OutgoingSignal, SimplePeerLike } from '../types';
import type SimplePeer from 'simple-peer';

export class MockSimplePeer implements SimplePeerLike {
  public readonly options: SimplePeer.Options;
  public destroyed = false;
  public sentDataChannelMessages: Array<string | ArrayBuffer | Uint8Array> = [];
  public addedTracks: Array<{ track: MediaStreamTrack; stream: MediaStream }> = [];
  public removedTracks: Array<{ track: MediaStreamTrack; stream: MediaStream }> = [];
  public replacedTracks: Array<{
    oldTrack: MediaStreamTrack | null;
    newTrack: MediaStreamTrack | null;
    stream: MediaStream;
  }> = [];
  public addedStreams: MediaStream[] = [];
  public signaledIn: unknown[] = [];

  private _listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(options: SimplePeer.Options) {
    this.options = options;
  }

  on(event: string, listener: (...args: any[]) => void): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener);
  }

  signal(data: unknown): void {
    this.signaledIn.push(data);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.destroyed) throw new Error('peer destroyed');
    this.sentDataChannelMessages.push(data);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.addedTracks.push({ track, stream });
  }

  removeTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.removedTracks.push({ track, stream });
  }

  replaceTrack(
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    stream: MediaStream
  ): void {
    this.replacedTracks.push({ oldTrack, newTrack, stream });
  }

  addStream(stream: MediaStream): void {
    this.addedStreams.push(stream);
  }

  /** Test-only: simulate a SimplePeer event firing. */
  emit(event: string, ...args: any[]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const l of Array.from(set)) {
      l(...args);
    }
  }
}

/** Track every MockSimplePeer created by a factory so tests can inspect them. */
export function createMockFactory() {
  const peers: MockSimplePeer[] = [];
  const factory = (options: SimplePeer.Options): SimplePeerLike => {
    const p = new MockSimplePeer(options);
    peers.push(p);
    return p;
  };
  return { factory, peers };
}

/** Minimal MediaStream-shaped object for test purposes. */
export function createFakeStream(id = 'stream-1'): MediaStream {
  const tracks: MediaStreamTrack[] = [];
  const stream = {
    id,
    active: true,
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
  return stream;
}

/** Minimal MediaStreamTrack-shaped object. */
export function createFakeTrack(kind: 'audio' | 'video', id = `track-${kind}-1`): MediaStreamTrack {
  return {
    id,
    kind,
    enabled: true,
    muted: false,
    readyState: 'live',
  } as unknown as MediaStreamTrack;
}

/**
 * In-memory bidirectional channel between two transports. Each side ships
 * outgoing signals to a sink; the channel routes them to the other side's
 * processIncomingSignal.
 */
export class FakeSignalingChannel {
  private _routes = new Map<
    AgentPubKeyB64,
    (signal: { from: AgentPubKeyB64; connectionId: string; data: unknown }) => void
  >();

  /** Returns an onOutgoingSignal callback for a transport at `from`. */
  attachSender(from: AgentPubKeyB64): (signal: OutgoingSignal) => void {
    return (signal: OutgoingSignal) => {
      const route = this._routes.get(signal.to);
      if (!route) return; // peer not attached yet — drop
      // Schedule async to mimic transport-level delivery latency. Using
      // queueMicrotask keeps tests deterministic.
      queueMicrotask(() => {
        route({
          from,
          connectionId: signal.connectionId,
          data: signal.data,
        });
      });
    };
  }

  /** Register the receiver for a transport at `to`. */
  attachReceiver(
    to: AgentPubKeyB64,
    receiver: (signal: { from: AgentPubKeyB64; connectionId: string; data: unknown }) => void
  ): void {
    this._routes.set(to, receiver);
  }
}
