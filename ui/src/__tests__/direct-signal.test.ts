import { describe, expect, it, vi } from 'vitest';
import { encode } from '@msgpack/msgpack';

import {
  type DirectSignalCellId,
  directSignalPortFor,
  nativeDirectSignalPort,
  rawDirectSignalPort,
} from '../direct-signal';

const DNA = new Uint8Array(39).fill(1);
const ME = new Uint8Array(39).fill(2);
const PEER = new Uint8Array(39).fill(3);
const CELL: DirectSignalCellId = [DNA, ME];

/** A `WsClient.socket`-shaped fake: the stock client installs `onmessage`,
 *  so the port must coexist via `addEventListener`. */
function fakeSocket() {
  const listeners = new Set<(ev: { data: unknown }) => unknown>();
  return {
    addEventListener: (type: string, cb: (ev: { data: unknown }) => unknown) => {
      if (type === 'message') listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (ev: { data: unknown }) => unknown) => {
      listeners.delete(cb);
    },
    deliver: async (frame: unknown) => {
      const data = Buffer.from(encode(frame));
      for (const cb of [...listeners]) await cb({ data });
    },
    deliverRaw: async (data: unknown) => {
      for (const cb of [...listeners]) await cb({ data });
    },
    listenerCount: () => listeners.size,
  };
}

const signalFrame = (inner: unknown) => ({ type: 'signal', data: encode(inner) });

describe('rawDirectSignalPort', () => {
  it('sends the wire request shape the conductor expects', async () => {
    const request = vi.fn().mockResolvedValue(null);
    const port = rawDirectSignalPort({ request, socket: fakeSocket(), cellId: CELL });

    await port.send([PEER], new Uint8Array([9, 9]));

    expect(request).toHaveBeenCalledWith({
      type: 'send_direct_signal',
      value: {
        dna_hash: DNA,
        agents: [PEER],
        signal: new Uint8Array([9, 9]),
        cap_secret: null,
      },
    });
  });

  it('never sends an empty agent set (the conductor errors on it)', async () => {
    const request = vi.fn().mockResolvedValue(null);
    const port = rawDirectSignalPort({ request, socket: fakeSocket(), cellId: CELL });

    await port.send([], new Uint8Array([1]));

    expect(request).not.toHaveBeenCalled();
  });

  it('delivers app_direct signals for this cell with the verified sender', async () => {
    const socket = fakeSocket();
    const port = rawDirectSignalPort({ request: vi.fn(), socket, cellId: CELL });
    const seen: unknown[] = [];
    port.subscribe(s => seen.push(s));

    await socket.deliver(
      signalFrame({
        type: 'app_direct',
        value: { cell_id: [DNA, ME], from_agent: PEER, signal: new Uint8Array([4]) },
      })
    );

    expect(seen).toEqual([{ fromAgent: PEER, bytes: new Uint8Array([4]) }]);
  });

  it('tolerates a 0.7-line signal with no from_agent', async () => {
    const socket = fakeSocket();
    const port = rawDirectSignalPort({ request: vi.fn(), socket, cellId: CELL });
    const seen: unknown[] = [];
    port.subscribe(s => seen.push(s));

    await socket.deliver(
      signalFrame({
        type: 'app_direct',
        value: { cell_id: [DNA, ME], signal: new Uint8Array([5]) },
      })
    );

    expect(seen).toEqual([{ fromAgent: null, bytes: new Uint8Array([5]) }]);
  });

  it('accepts a signal delivered as an int array rather than msgpack bin', async () => {
    const socket = fakeSocket();
    const port = rawDirectSignalPort({ request: vi.fn(), socket, cellId: CELL });
    const seen: unknown[] = [];
    port.subscribe(s => seen.push(s));

    await socket.deliver(
      signalFrame({ type: 'app_direct', value: { cell_id: [DNA, ME], signal: [6, 7] } })
    );

    expect(seen).toEqual([{ fromAgent: null, bytes: new Uint8Array([6, 7]) }]);
  });

  it.each([
    [
      'another cell',
      signalFrame({
        type: 'app_direct',
        value: { cell_id: [DNA, PEER], signal: new Uint8Array([1]) },
      }),
    ],
    [
      'an app signal',
      signalFrame({
        type: 'app',
        value: { cell_id: [DNA, ME], zome_name: 'room', signal: [] },
      }),
    ],
    ['a response frame', { type: 'response', id: 1, data: encode({}) }],
    ['a signal frame with no data', { type: 'signal', data: null }],
    ['a malformed inner signal', { type: 'signal', data: new Uint8Array([0xc1]) }],
    [
      'an app_direct with no signal bytes',
      signalFrame({ type: 'app_direct', value: { cell_id: [DNA, ME] } }),
    ],
  ])('drops %s without throwing', async (_label, frame) => {
    const socket = fakeSocket();
    const port = rawDirectSignalPort({ request: vi.fn(), socket, cellId: CELL });
    const seen: unknown[] = [];
    port.subscribe(s => seen.push(s));

    await socket.deliver(frame);

    expect(seen).toEqual([]);
  });

  it.each([
    ['a payload that is not bytes at all', 'not-a-buffer'],
    ['undecodable bytes', new Uint8Array([0xc1])],
  ])('drops %s without throwing', async (_label, data) => {
    const socket = fakeSocket();
    const port = rawDirectSignalPort({ request: vi.fn(), socket, cellId: CELL });
    const seen: unknown[] = [];
    port.subscribe(s => seen.push(s));

    await socket.deliverRaw(data);

    expect(seen).toEqual([]);
  });

  it('unsubscribes its listener', () => {
    const socket = fakeSocket();
    const port = rawDirectSignalPort({ request: vi.fn(), socket, cellId: CELL });
    const off = port.subscribe(() => {});
    expect(socket.listenerCount()).toBe(1);
    off();
    expect(socket.listenerCount()).toBe(0);
  });
});

describe('nativeDirectSignalPort', () => {
  it('uses the client method and its signal subscription', async () => {
    const sendDirectSignal = vi.fn().mockResolvedValue(undefined);
    const handlers: Array<(s: unknown) => void> = [];
    const port = nativeDirectSignalPort({
      sendDirectSignal,
      onSignal: h => {
        handlers.push(h);
        return () => {
          handlers.length = 0;
        };
      },
      cellId: CELL,
    });

    const seen: unknown[] = [];
    const off = port.subscribe(s => seen.push(s));
    await port.send([PEER], new Uint8Array([1]));

    expect(sendDirectSignal).toHaveBeenCalledWith({
      dna_hash: DNA,
      agents: [PEER],
      signal: new Uint8Array([1]),
      cap_secret: null,
    });

    handlers[0]({
      type: 'app_direct',
      value: { cell_id: [DNA, ME], from_agent: PEER, signal: new Uint8Array([2]) },
    });
    expect(seen).toEqual([{ fromAgent: PEER, bytes: new Uint8Array([2]) }]);

    off();
    expect(handlers).toHaveLength(0);
  });

  it('ignores signals for other cells and other signal types', () => {
    const handlers: Array<(s: unknown) => void> = [];
    const port = nativeDirectSignalPort({
      sendDirectSignal: vi.fn(),
      onSignal: h => {
        handlers.push(h);
        return () => {};
      },
      cellId: CELL,
    });
    const seen: unknown[] = [];
    port.subscribe(s => seen.push(s));

    handlers[0]({
      type: 'app_direct',
      value: { cell_id: [DNA, PEER], signal: new Uint8Array([1]) },
    });
    handlers[0]({ type: 'app', value: { cell_id: [DNA, ME], signal: new Uint8Array([1]) } });

    expect(seen).toEqual([]);
  });
});

describe('directSignalPortFor', () => {
  it('prefers the native port when the client exposes the method', () => {
    const client = { sendDirectSignal: vi.fn(), on: vi.fn(() => () => {}) };
    expect(directSignalPortFor(client, CELL)).not.toBeNull();
  });

  it('falls back to the raw port when only a socket is reachable', () => {
    const client = { client: { request: vi.fn(), socket: fakeSocket() } };
    expect(directSignalPortFor(client, CELL)).not.toBeNull();
  });

  it.each([
    ['a transport with no socket (Tauri)', { client: { request: () => {} } }],
    ['no transport at all', {}],
    ['a non-object client', null],
  ])('returns null for %s', (_label, client) => {
    expect(directSignalPortFor(client, CELL)).toBeNull();
  });
});
