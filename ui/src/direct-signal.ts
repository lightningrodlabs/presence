/**
 * The direct-signal port — the ONE home of raw-wire knowledge for
 * holochain's `AppRequest::SendDirectSignal` (`docs/DIRECT_SIGNALS_PLAN.md`).
 *
 * Everything above this file talks to `DirectSignalPort` (bytes out to a set
 * of agents, bytes in from one agent) and knows nothing about websocket
 * frames, msgpack, or which client version is installed. Two constructors
 * implement it:
 *
 *  - `nativeDirectSignalPort` — for a `@holochain/client` that exposes the
 *    feature. This is the one that survives.
 *  - `rawDirectSignalPort` — the escape hatch for clients that do not
 *    (0.21.0 has no `sendDirectSignal`, and its `assertHolochainSignal`
 *    THROWS on an incoming `app_direct`, so its own subscription cannot be
 *    used). Deleted, not edited, once a released client carries support.
 *
 * `directSignalPortFor` picks between them at runtime, so the day the client
 * ships the feature no call site changes. `null` means this environment has
 * no usable direct path (a Tauri transport, a Moss applet shim with no
 * reachable socket): callers then stay on the zome carrier, which is the
 * declared fallback (working agreement 1), not an error.
 *
 * Wire shapes, pinned to `../holochain` PR #5974 head `60a2297c0e` and
 * `@holochain/client` 0.21.0:
 *
 *  - Outbound: `{ type: 'send_direct_signal', value: { dna_hash, agents,
 *    signal, cap_secret } }` — serde `tag = "type"`, `content = "value"`,
 *    snake_case (`holochain_conductor_api/src/app_interface.rs:334-355`).
 *    `signal` goes as msgpack `bin` (a `Uint8Array`), settled empirically by
 *    the phase-0 rig. `cap_secret` is always `null` here: presence's grant
 *    is unrestricted, and offering a secret would NARROW matching to
 *    secret-bearing grants (DIRECT_SIGNALS_PLAN.md §1.1 item 3). A conductor
 *    that predates the field reads the null as an absent `Option`.
 *  - Inbound: the socket frame is msgpack `{ type: 'signal', data }` whose
 *    `data` is itself msgpack `{ type: 'app_direct', value: { cell_id,
 *    from_agent, signal } }` — the same two-step decode the stock client does
 *    in `lib/api/client.js:160-182`. `from_agent` is absent on the 0.7 line
 *    (#5945 added it on 0.8) and surfaces as `null`.
 *
 * The stock client installs its handler by assigning `socket.onmessage`, so
 * the raw port's `addEventListener('message', …)` coexists with it rather
 * than replacing it. Every inbound path swallows its own failures: this
 * listener runs outside `StreamsStore.handleSignal`'s queue latch, so a
 * throw here would be an unhandled rejection in a socket callback — the
 * blast radius `ui/src/signal-payload.ts` exists to prevent.
 */
import { decode } from '@msgpack/msgpack';

/** `[DnaHash, AgentPubKey]` — the client's `CellId` shape, as raw bytes. */
export type DirectSignalCellId = [Uint8Array, Uint8Array];

export type IncomingDirectSignal = {
  /** The conductor-verified sender, or `null` on a conductor that does not
   *  deliver it (the 0.7 line). Never trusted for identity by callers today:
   *  the envelope carries its own self-declared `from`. */
  fromAgent: Uint8Array | null;
  bytes: Uint8Array;
};

export type DirectSignalPort = {
  /** Fire-and-forget by conductor semantics: the promise resolving means the
   *  conductor accepted the request, never that any peer received it. */
  send(agents: Uint8Array[], bytes: Uint8Array): Promise<void>;
  subscribe(handler: (signal: IncomingDirectSignal) => void): () => void;
};

/** The request body both constructors build. Replaced by the client's own
 *  `SendDirectSignalRequest` when it ships one. */
type SendDirectSignalRequestBody = {
  dna_hash: Uint8Array;
  agents: Uint8Array[];
  signal: Uint8Array;
  cap_secret: Uint8Array | null;
};

/** What the raw port needs off a `WsClient`: the generic request method and
 *  the socket, both public API in 0.21.0. */
export type RawPortDeps = {
  request: (request: unknown) => Promise<unknown>;
  socket: {
    addEventListener: (type: string, cb: (ev: { data: unknown }) => unknown) => void;
    removeEventListener: (type: string, cb: (ev: { data: unknown }) => unknown) => void;
  };
  cellId: DirectSignalCellId;
};

/** What the native port needs off a client that supports the feature. */
export type NativePortDeps = {
  sendDirectSignal: (request: SendDirectSignalRequestBody) => Promise<unknown>;
  onSignal: (handler: (signal: unknown) => void) => () => void;
  cellId: DirectSignalCellId;
};

function requestBody(
  cellId: DirectSignalCellId,
  agents: Uint8Array[],
  bytes: Uint8Array
): SendDirectSignalRequestBody {
  return {
    dna_hash: cellId[0],
    agents,
    signal: bytes,
    cap_secret: null,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Coerce a decoded field to bytes, or `null` if it is not byte-shaped.
 *
 * Two normalisations, both load-bearing. msgpack `bin` decodes to a `Buffer`
 * under node and a `Uint8Array` in a browser, so a raw return would hand
 * callers a different constructor per environment — this returns a
 * zero-copy `Uint8Array` view either way. And a future client may deliver
 * `Vec<u8>` as an array of ints rather than `bin`, which is accepted here
 * rather than dropped.
 */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value.constructor === Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every(n => typeof n === 'number')) {
    return new Uint8Array(value as number[]);
  }
  return null;
}

/**
 * Interpret one decoded `RawSignal`. Returns `null` for anything that is not
 * an `app_direct` for this exact cell — another cell's traffic, an ordinary
 * app signal, a system signal, or a malformed value.
 */
function interpretDirectSignal(
  inner: unknown,
  cellId: DirectSignalCellId
): IncomingDirectSignal | null {
  if (inner === null || typeof inner !== 'object') return null;
  const { type, value } = inner as Record<string, unknown>;
  if (type !== 'app_direct') return null;
  if (value === null || typeof value !== 'object') return null;

  const { cell_id: cell, from_agent: fromAgent, signal } = value as Record<string, unknown>;
  if (!Array.isArray(cell) || cell.length !== 2) return null;
  const dna = asBytes(cell[0]);
  const agent = asBytes(cell[1]);
  if (!dna || !agent) return null;
  if (!bytesEqual(dna, cellId[0]) || !bytesEqual(agent, cellId[1])) return null;

  const bytes = asBytes(signal);
  if (!bytes) return null;

  return { fromAgent: asBytes(fromAgent), bytes };
}

/** Normalise whatever the socket hands us to bytes — `Blob` in a browser,
 *  `Buffer` under node, `ArrayBuffer`/`Uint8Array` defensively. Mirrors the
 *  stock client's own normalisation (`lib/api/client.js:160-174`). */
async function frameBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const blobCtor = (globalThis as { Blob?: typeof Blob }).Blob;
  if (blobCtor && data instanceof blobCtor) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return null;
}

export function rawDirectSignalPort(deps: RawPortDeps): DirectSignalPort {
  return {
    async send(agents, bytes) {
      // An empty agent set is an error conductor-side ("No agents to signal"),
      // and an empty fan-out is a no-op anyway.
      if (agents.length === 0) return;
      await deps.request({
        type: 'send_direct_signal',
        value: requestBody(deps.cellId, agents, bytes),
      });
    },

    subscribe(handler) {
      const listener = async (ev: { data: unknown }) => {
        try {
          const bytes = await frameBytes(ev.data);
          if (!bytes) return;
          const frame = decode(bytes);
          if (frame === null || typeof frame !== 'object') return;
          const { type, data } = frame as Record<string, unknown>;
          if (type !== 'signal' || data === null || data === undefined) return;
          const innerBytes = asBytes(data);
          if (!innerBytes) return;
          const signal = interpretDirectSignal(decode(innerBytes), deps.cellId);
          if (signal) handler(signal);
        } catch {
          // A malformed frame drops one signal, never the session — and this
          // listener must never reject (see the header).
        }
      };
      deps.socket.addEventListener('message', listener);
      return () => deps.socket.removeEventListener('message', listener);
    },
  };
}

export function nativeDirectSignalPort(deps: NativePortDeps): DirectSignalPort {
  return {
    async send(agents, bytes) {
      if (agents.length === 0) return;
      await deps.sendDirectSignal(requestBody(deps.cellId, agents, bytes));
    },

    subscribe(handler) {
      return deps.onSignal(signal => {
        const direct = interpretDirectSignal(signal, deps.cellId);
        if (direct) handler(direct);
      });
    },
  };
}

/**
 * Pick the port this environment can actually use.
 *
 * The casts here are the ONE place the app reaches past the client's declared
 * types, and they exist because 0.21.0 declares neither the method nor the
 * `app_direct` signal variant. When a released client does, the native branch
 * becomes a typed call and the raw branch is deleted.
 */
export function directSignalPortFor(
  client: unknown,
  cellId: DirectSignalCellId
): DirectSignalPort | null {
  if (client === null || typeof client !== 'object') return null;

  const native = client as {
    sendDirectSignal?: unknown;
    on?: unknown;
  };
  if (typeof native.sendDirectSignal === 'function' && typeof native.on === 'function') {
    return nativeDirectSignalPort({
      sendDirectSignal: req =>
        (native.sendDirectSignal as (r: SendDirectSignalRequestBody) => Promise<unknown>)(req),
      onSignal: handler =>
        (native.on as (event: 'signal', cb: (signal: unknown) => void) => () => void)(
          'signal',
          handler
        ),
      cellId,
    });
  }

  const transport = (client as { client?: unknown }).client as
    | { request?: unknown; socket?: unknown }
    | undefined;
  const socket = transport?.socket as RawPortDeps['socket'] | undefined;
  if (
    transport &&
    typeof transport.request === 'function' &&
    socket &&
    typeof socket.addEventListener === 'function' &&
    typeof socket.removeEventListener === 'function'
  ) {
    return rawDirectSignalPort({
      request: req => (transport.request as (r: unknown) => Promise<unknown>)(req),
      socket,
      cellId,
    });
  }

  return null;
}
