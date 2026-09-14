# Direct-signals prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land everything the direct-signal carrier needs on the UI side — adapter, envelope, path policy, probe, carrier partition — so that when holochain PR #5974 and JS-client support land, the remaining work is a zome grant and a version bump, not an implementation.

**Architecture:** One port interface (`DirectSignalPort`) hides whether direct signals reach the conductor through today's raw-websocket escape hatch or tomorrow's native client method; one pure codec owns the envelope; one pure policy owns the per-peer path choice; the carrier switch is gated on a *declared capability plus an observed direct round trip*, which is what makes a missing #5974 capability grant degrade to the zome path instead of silently dropping traffic. The store's body, `_processSignal`, and every signal handler are untouched — only the `bus` binding changes.

**Tech Stack:** TypeScript (ui workspace), `@msgpack/msgpack` 2.8.0 (already a ui dependency), `@holochain/client` ^0.21.0, vitest (node environment), `nix develop -c npm run verify` as the gate.

**Spec:** `docs/DIRECT_SIGNALS_PLAN.md` (§1.1 upstream state, §4 phases 1/2/2.5). Read it first; this plan implements phases 1 and 2 and deliberately stops short of phase 2.5.

## Global Constraints

- **`nix develop -c npm run verify` must be green at the end of every task.** It runs both workspaces' unit suites plus `tsc --noEmit` at `strict` + `noUnusedLocals`/`noUnusedParameters`.
- **No zome, DNA, or happ change in this branch.** Phase 2.5's `Capability::DirectSignal` grant needs hdi `0.9.0-dev.x`/hdk `0.9.0-dev.x` (the 0.8 conductor line) while this repo is on hdk 0.7.0 / hdi 0.8.0 against a holonix `main-0.7` devshell. It cannot compile here; do not attempt it, and do not add speculative zome code.
- **The conductor this runs against today is holochain 0.7.0** (`flake.lock` pins `84cdce7d4d`): direct signals exist, no capability grant is enforced, and the effective payload ceiling is ~8 KiB (lair frame). Therefore `DIRECT_SIGNAL_MAX_PAYLOAD_BYTES = 7 * 1024` and oversized payloads route to the zome path. The constant's docblock must say it rises to ~1 MiB once the holonix pin reaches a 0.7.1 build (§1.1 item 1).
- **Working agreement 1 (replace or declare):** the zome path stays as the declared cap-gated fallback. Say so in each new module's header.
- **Working agreement 2 (no new threshold without a named predicate):** every new constant here serves the named predicate `direct-path-usable`, owned by `ui/src/transport/direct-signal-policy.ts`, and must be documented as **NOT a liveness predicate** — presence liveness stays with `presence-policy.ts`.
- **Working agreement 4:** decisions are pure functions — snapshot in, tagged union out, carrying a `reason`; table-driven tests, no mocks. `ui/src/transport/media-event-policy.ts` is the template.
- **One authority per concept, one exported name.** The envelope codec, the path decision, and the port are each exactly one module.
- **Release framing:** the next release from this line is **0.17.0** and is a declared happ change (`HAPP_CHANGE=1`) because the stable-tile-order coordinator zome change rides it (`feat/stable-tile-order`, not yet merged into `main-0.7`), and eventually phase 2.5's grant. Everything in *this* plan is UI-only and changes no happ bytes — it needs no version bump of its own and must not add one.
- **Commits:** no `Co-Authored-By` or generated-with trailers (user CLAUDE.md). Commit after every task.
- Work on branch `wip/direct-signals` (already rebased onto `main-0.7`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `ui/src/transport/direct-envelope.ts` (create) | The msgpack envelope: `{ v: 1, from, msgType, payload }` ⇄ bytes. Pure. Mirrors `RoomSignal`'s `Message` shape so `_processSignal` is unchanged. |
| `ui/src/transport/__tests__/direct-envelope.test.ts` (create) | Table tests for the codec, including malformed input and version mismatch. |
| `ui/src/direct-signal.ts` (create) | `DirectSignalPort` — the one interface the rest of the app uses — plus the two production constructors (`rawDirectSignalPort`, `nativeDirectSignalPort`) and the runtime pick (`directSignalPortFor`). Owns ALL raw-wire knowledge; deletable down to the native constructor when the client ships support. |
| `ui/src/__tests__/direct-signal.test.ts` (create) | Port tests against a fake transport and a fake socket. |
| `ui/src/transport/direct-signal-policy.ts` (create) | The `direct-path-usable` predicate: `decideSignalPath`, `decideDirectProbeAction`, `applyDirectProbeResult`, and the named constants. Pure. |
| `ui/src/transport/__tests__/direct-signal-policy.test.ts` (create) | Table tests for both decisions and the reducer. |
| `ui/src/transport/wire-contract.ts` (modify) | Add `CAP_DIRECT_SIGNAL` to `WireCap`/`WIRE_CAPS`. |
| `ui/fixtures/wire-contract.json` (modify) | The declared-wire-surface fixture ceremony for that cap. |
| `ui/src/store-deps.ts` (modify) | `SignalBus` gains nothing; `StreamsStoreDeps` gains `directSignalPort: DirectSignalPort \| null` as a declared new seam element. |
| `ui/src/store-deps.testing.ts` (modify) | A scriptable fake port for the wiring suite. |
| `ui/src/streams-store.ts` (modify) | `static connect` builds the port and the partitioning `bus`; `start()` subscribes the port; `disconnect()` unsubscribes; the probe is driven from the presence tick. |
| `ui/src/__tests__/streams-store-wiring.test.ts` (modify) | Wiring assertions: partition by path, direct inbound reaching `handleSignal`, probe drive, oversize route, teardown symmetry. |
| `docs/DIRECT_SIGNALS_PLAN.md` (modify) | Mark phases 1/2 landed; record what is still phase 2.5. |
| `CLAUDE.md` (modify) | One fact bullet for the round, per the "True today" contract. |

---

### Task 1: The envelope codec

**Files:**
- Create: `ui/src/transport/direct-envelope.ts`
- Test: `ui/src/transport/__tests__/direct-envelope.test.ts`

**Interfaces:**
- Consumes: `SignalMsgType`, `isSignalMsgType` from `ui/src/transport/wire-contract.ts`.
- Produces:
  - `DIRECT_ENVELOPE_VERSION: 1`
  - `type DirectEnvelope = { from: Uint8Array; msgType: SignalMsgType; payload: string }`
  - `encodeDirectEnvelope(e: DirectEnvelope): Uint8Array`
  - `decodeDirectEnvelope(bytes: Uint8Array): { ok: true; value: DirectEnvelope } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/transport/__tests__/direct-envelope.test.ts
import { describe, expect, it } from 'vitest';
import { encode } from '@msgpack/msgpack';
import {
  DIRECT_ENVELOPE_VERSION,
  decodeDirectEnvelope,
  encodeDirectEnvelope,
} from '../direct-envelope';

const FROM = new Uint8Array(39).fill(7);

describe('direct envelope', () => {
  it('round-trips a message', () => {
    const bytes = encodeDirectEnvelope({
      from: FROM,
      msgType: 'ModuleData',
      payload: '{"moduleId":"voice"}',
    });
    const decoded = decodeDirectEnvelope(bytes);
    expect(decoded).toEqual({
      ok: true,
      value: { from: FROM, msgType: 'ModuleData', payload: '{"moduleId":"voice"}' },
    });
  });

  it('encodes the payload as msgpack bin, not an int array', () => {
    // A bin-encoded 39-byte key costs 41 bytes; an int array would cost ~78.
    const bytes = encodeDirectEnvelope({ from: FROM, msgType: 'PingUi', payload: '' });
    expect(bytes.byteLength).toBeLessThan(80);
  });

  it.each([
    ['not msgpack at all', new Uint8Array([0xc1])],
    ['a msgpack scalar', encode(4)],
    ['an array', encode([1, 2, 3])],
    ['a map missing msgType', encode({ v: 1, from: FROM, payload: '' })],
    ['a map with a non-string payload', encode({ v: 1, from: FROM, msgType: 'PingUi', payload: 3 })],
    ['a map with an unknown msgType', encode({ v: 1, from: FROM, msgType: 'Nope', payload: '' })],
    ['a map with a non-bytes from', encode({ v: 1, from: 'me', msgType: 'PingUi', payload: '' })],
    ['a future envelope version', encode({ v: 2, from: FROM, msgType: 'PingUi', payload: '' })],
  ])('rejects %s without throwing', (_label, bytes) => {
    const decoded = decodeDirectEnvelope(bytes as Uint8Array);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toBeTruthy();
  });

  it('declares version 1', () => {
    expect(DIRECT_ENVELOPE_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ui && npx vitest run src/transport/__tests__/direct-envelope.test.ts`
Expected: FAIL — cannot resolve `../direct-envelope`.

- [ ] **Step 3: Implement**

```ts
// ui/src/transport/direct-envelope.ts
/**
 * The direct-signal envelope, declared once.
 *
 * `AppRequest::SendDirectSignal` carries opaque bytes, so the app supplies
 * its own framing. This envelope mirrors the zome path's
 * `RoomSignal { type: 'Message', from_agent, msg_type, payload }`
 * (`ui/src/types.ts`) field for field, which is the whole point: the
 * carrier can change under `StreamsStore` without `_processSignal` or any
 * handler changing. The zome path REMAINS the source of truth for peers
 * without the `direct-signal` capability — declared fallback, working
 * agreement 1.
 *
 * `from` keeps exactly its zome-path trust level: self-declared. On a 0.8
 * conductor `Signal::AppDirect` also carries a conductor-verified
 * `from_agent` (DIRECT_SIGNALS_PLAN.md §1.1 item 2) which makes this field
 * checkable; that check is a separate, later change.
 *
 * Pure by construction — bytes in, tagged union out — so it is table
 * tested without a conductor, a client, or a `StreamsStore`.
 */
import { decode, encode } from '@msgpack/msgpack';

import { isSignalMsgType, type SignalMsgType } from './wire-contract';

/** Bumped only for a breaking envelope change; a peer that reads a version
 *  it does not know drops the signal (never the session). */
export const DIRECT_ENVELOPE_VERSION = 1;

export type DirectEnvelope = {
  /** The sender's `AgentPubKey` bytes — self-declared, see the header. */
  from: Uint8Array;
  msgType: SignalMsgType;
  /** The same JSON string the zome path carries in `RoomSignal.payload`. */
  payload: string;
};

export type DecodedDirectEnvelope =
  | { ok: true; value: DirectEnvelope }
  | { ok: false; error: string };

export function encodeDirectEnvelope(envelope: DirectEnvelope): Uint8Array {
  return encode({
    v: DIRECT_ENVELOPE_VERSION,
    from: envelope.from,
    msgType: envelope.msgType,
    payload: envelope.payload,
  });
}

/**
 * Decode without throwing. Same rule as `parseSignalPayload`
 * (`ui/src/signal-payload.ts`): a bad payload drops one signal, never the
 * session.
 */
export function decodeDirectEnvelope(bytes: Uint8Array): DecodedDirectEnvelope {
  let raw: unknown;
  try {
    raw = decode(bytes);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'envelope is not a msgpack map' };
  }

  const { v, from, msgType, payload } = raw as Record<string, unknown>;

  if (v !== DIRECT_ENVELOPE_VERSION) {
    return { ok: false, error: `unsupported envelope version ${String(v)}` };
  }
  if (!(from instanceof Uint8Array)) {
    return { ok: false, error: 'from is not bytes' };
  }
  if (typeof msgType !== 'string' || !isSignalMsgType(msgType)) {
    return { ok: false, error: `unknown msgType ${String(msgType)}` };
  }
  if (typeof payload !== 'string') {
    return { ok: false, error: `payload is ${typeof payload}, expected string` };
  }

  return { ok: true, value: { from, msgType, payload } };
}
```

- [ ] **Step 4: Run the test and the gate**

Run: `cd ui && npx vitest run src/transport/__tests__/direct-envelope.test.ts` → PASS
Run: `nix develop -c npm run verify` → green

- [ ] **Step 5: Commit**

```bash
git add ui/src/transport/direct-envelope.ts ui/src/transport/__tests__/direct-envelope.test.ts
git commit -m "feat(direct-signals): the envelope codec, declared once"
```

---

### Task 2: The port and its two constructors

**Files:**
- Create: `ui/src/direct-signal.ts`
- Test: `ui/src/__tests__/direct-signal.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (the port moves bytes, not envelopes).
- Produces:
  - `type DirectSignalCellId = [Uint8Array, Uint8Array]` (dna hash, agent key — the client's `CellId` shape)
  - `type IncomingDirectSignal = { fromAgent: Uint8Array | null; bytes: Uint8Array }`
  - `type DirectSignalPort = { send(agents: Uint8Array[], bytes: Uint8Array): Promise<void>; subscribe(handler: (s: IncomingDirectSignal) => void): () => void }`
  - `rawDirectSignalPort(deps: RawPortDeps): DirectSignalPort`
  - `nativeDirectSignalPort(deps: NativePortDeps): DirectSignalPort`
  - `directSignalPortFor(client: unknown, cellId: DirectSignalCellId): DirectSignalPort | null`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/__tests__/direct-signal.test.ts
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

/** A fake `WsClient`-shaped socket that records listeners and can deliver frames. */
function fakeSocket() {
  const listeners = new Set<(ev: { data: unknown }) => void>();
  return {
    addEventListener: (type: string, cb: (ev: { data: unknown }) => void) => {
      if (type === 'message') listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (ev: { data: unknown }) => void) => {
      listeners.delete(cb);
    },
    deliver: async (frame: unknown) => {
      const data = Buffer.from(encode(frame));
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

  it('delivers app_direct signals for this cell, with the conductor-verified sender when present', async () => {
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
      signalFrame({ type: 'app_direct', value: { cell_id: [DNA, ME], signal: new Uint8Array([5]) } })
    );

    expect(seen).toEqual([{ fromAgent: null, bytes: new Uint8Array([5]) }]);
  });

  it.each([
    ['another cell', signalFrame({ type: 'app_direct', value: { cell_id: [DNA, PEER], signal: new Uint8Array([1]) } })],
    ['an app signal', signalFrame({ type: 'app', value: { cell_id: [DNA, ME], zome_name: 'room', signal: [] } })],
    ['a response frame', { type: 'response', id: 1, data: encode({}) }],
    ['a malformed frame', { type: 'signal', data: new Uint8Array([0xc1]) }],
  ])('drops %s without throwing', async (_label, frame) => {
    const socket = fakeSocket();
    const port = rawDirectSignalPort({ request: vi.fn(), socket, cellId: CELL });
    const seen: unknown[] = [];
    port.subscribe(s => seen.push(s));

    await socket.deliver(frame);

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
});

describe('directSignalPortFor', () => {
  it('prefers the native port when the client has the method', () => {
    const client = { sendDirectSignal: vi.fn(), on: vi.fn(() => () => {}) };
    expect(directSignalPortFor(client, CELL)).not.toBeNull();
  });

  it('falls back to the raw port when only a socket is reachable', () => {
    const client = { client: { request: vi.fn(), socket: fakeSocket() } };
    expect(directSignalPortFor(client, CELL)).not.toBeNull();
  });

  it('returns null when neither is available (e.g. a Tauri transport)', () => {
    expect(directSignalPortFor({ client: { request: () => {} } }, CELL)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ui && npx vitest run src/__tests__/direct-signal.test.ts`
Expected: FAIL — cannot resolve `../direct-signal`.

- [ ] **Step 3: Implement**

Write `ui/src/direct-signal.ts` with:

- A header documenting: this module owns ALL raw-wire knowledge; the wire shapes are `{ type: 'send_direct_signal', value: { dna_hash, agents, signal, cap_secret } }` (serde `tag = "type"`, `content = "value"`, snake_case — `holochain_conductor_api/src/app_interface.rs:334-355` @ `60a2297c0e`) and inbound `{ type: 'signal', data: msgpack({ type: 'app_direct', value: { cell_id, from_agent?, signal } }) }` (`@holochain/client` `lib/api/client.js:160-182`, which decodes the outer frame then the inner signal); `cap_secret` is always `null` here because presence's grant is unrestricted (DIRECT_SIGNALS_PLAN.md §1.1 item 3) and a serde-omitted `Option` reads as `None`; the raw constructor is deleted, not edited, when a released client exposes the feature — `nativeDirectSignalPort` is what survives.
- The types from the Interfaces block above. `RawPortDeps = { request: (req: unknown) => Promise<unknown>; socket: DirectSignalSocket; cellId: DirectSignalCellId }`, `NativePortDeps = { sendDirectSignal: (req: NativeSendRequest) => Promise<unknown>; onSignal: (h: (signal: unknown) => void) => () => void; cellId: DirectSignalCellId }`, and `DirectSignalSocket = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>`-shaped structural type accepting `{ data: unknown }` events.
- `send` returns early on an empty agent set (the conductor rejects it), and both constructors pass `cap_secret: null` explicitly.
- Inbound decoding in one private helper shared by both constructors:
  `interpretDirectSignal(inner: unknown, cellId: DirectSignalCellId): IncomingDirectSignal | null` — requires `type === 'app_direct'`, a `value.cell_id` whose two hashes byte-equal `cellId`, and `value.signal instanceof Uint8Array` (accept `number[]` too and convert, since msgpack from a future client may deliver either); `from_agent` is optional (absent on the 0.7 line) and becomes `null`.
- Frame decoding for the raw port: read `ev.data`, normalise `Blob`/`ArrayBuffer`/`Buffer`/`Uint8Array` to `Uint8Array` (mirror `client.js:160-174`), `decode` the outer frame, require `type === 'signal'` and non-null `data`, `decode` that, then `interpretDirectSignal`. Every failure path returns without throwing — the listener must never reject, because an unhandled rejection in a socket listener is exactly the failure mode `signal-payload.ts` exists to prevent.
- `directSignalPortFor(client, cellId)`: if `typeof (client as { sendDirectSignal?: unknown }).sendDirectSignal === 'function'` and `typeof (client as { on?: unknown }).on === 'function'`, build the native port (the ONE place a cast is allowed, with a comment naming the client version that will make it unnecessary); else if `(client as { client?: { request?: unknown; socket?: unknown } }).client?.request` and `.socket` are present, build the raw port; else return `null` (Tauri transport, Moss shim without a socket — the app then stays on the zome path, which is the declared fallback, not an error).

- [ ] **Step 4: Run the test and the gate**

Run: `cd ui && npx vitest run src/__tests__/direct-signal.test.ts` → PASS
Run: `nix develop -c npm run verify` → green

- [ ] **Step 5: Commit**

```bash
git add ui/src/direct-signal.ts ui/src/__tests__/direct-signal.test.ts
git commit -m "feat(direct-signals): one port over the raw wire, native-ready"
```

---

### Task 3: The `direct-path-usable` predicate

**Files:**
- Create: `ui/src/transport/direct-signal-policy.ts`
- Test: `ui/src/transport/__tests__/direct-signal-policy.test.ts`

**Interfaces:**
- Consumes: `CAP_DIRECT_SIGNAL` is added in Task 4; this task takes capability as a boolean input so the two tasks do not serialise.
- Produces:
  - `DIRECT_SIGNAL_MAX_PAYLOAD_BYTES = 7 * 1024`
  - `DIRECT_PROBE_TIMEOUT_MS = 4000`
  - `DIRECT_PROBE_RETRY_MS = 30000`
  - `type DirectPathState = 'unknown' | 'probing' | 'usable' | 'unusable'`
  - `type DirectPathRecord = { state: DirectPathState; probeSentAt: number | null; lastResultAt: number | null; attempts: number }`
  - `initialDirectPathRecord(): DirectPathRecord`
  - `decideSignalPath(input: { capDeclared: boolean; record: DirectPathRecord; payloadBytes: number; portAvailable: boolean }): { path: 'direct' | 'zome'; reason: string }`
  - `decideDirectProbeAction(input: { now: number; capDeclared: boolean; portAvailable: boolean; record: DirectPathRecord }): { action: 'send-probe' | 'expire-probe' | 'idle'; reason: string }`
  - `applyDirectProbeResult(record: DirectPathRecord, r: { now: number; outcome: 'answered' | 'timeout' }): DirectPathRecord`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/transport/__tests__/direct-signal-policy.test.ts
import { describe, expect, it } from 'vitest';
import {
  DIRECT_PROBE_RETRY_MS,
  DIRECT_PROBE_TIMEOUT_MS,
  DIRECT_SIGNAL_MAX_PAYLOAD_BYTES,
  applyDirectProbeResult,
  decideDirectProbeAction,
  decideSignalPath,
  initialDirectPathRecord,
  type DirectPathRecord,
} from '../direct-signal-policy';

const usable: DirectPathRecord = { state: 'usable', probeSentAt: null, lastResultAt: 1000, attempts: 1 };

describe('decideSignalPath', () => {
  it.each([
    ['no port', { capDeclared: true, record: usable, payloadBytes: 10, portAvailable: false }, 'zome'],
    ['no cap', { capDeclared: false, record: usable, payloadBytes: 10, portAvailable: true }, 'zome'],
    ['unproven path', { capDeclared: true, record: initialDirectPathRecord(), payloadBytes: 10, portAvailable: true }, 'zome'],
    ['proven path', { capDeclared: true, record: usable, payloadBytes: 10, portAvailable: true }, 'direct'],
    [
      'oversize payload on a proven path',
      { capDeclared: true, record: usable, payloadBytes: DIRECT_SIGNAL_MAX_PAYLOAD_BYTES + 1, portAvailable: true },
      'zome',
    ],
    [
      'payload exactly at the ceiling',
      { capDeclared: true, record: usable, payloadBytes: DIRECT_SIGNAL_MAX_PAYLOAD_BYTES, portAvailable: true },
      'direct',
    ],
  ])('%s → %s', (_label, input, path) => {
    const decision = decideSignalPath(input as Parameters<typeof decideSignalPath>[0]);
    expect(decision.path).toBe(path);
    expect(decision.reason).toBeTruthy();
  });

  it('keeps a peer on the zome path once the path is proven unusable', () => {
    const unusable: DirectPathRecord = { state: 'unusable', probeSentAt: null, lastResultAt: 5, attempts: 3 };
    expect(decideSignalPath({ capDeclared: true, record: unusable, payloadBytes: 1, portAvailable: true }).path).toBe('zome');
  });
});

describe('decideDirectProbeAction', () => {
  it('probes an unknown path once the peer declares the cap', () => {
    expect(
      decideDirectProbeAction({ now: 100, capDeclared: true, portAvailable: true, record: initialDirectPathRecord() })
    ).toMatchObject({ action: 'send-probe' });
  });

  it('does nothing without a cap or a port', () => {
    expect(
      decideDirectProbeAction({ now: 100, capDeclared: false, portAvailable: true, record: initialDirectPathRecord() })
    ).toMatchObject({ action: 'idle' });
    expect(
      decideDirectProbeAction({ now: 100, capDeclared: true, portAvailable: false, record: initialDirectPathRecord() })
    ).toMatchObject({ action: 'idle' });
  });

  it('waits out an in-flight probe, then expires it', () => {
    const probing: DirectPathRecord = { state: 'probing', probeSentAt: 1000, lastResultAt: null, attempts: 1 };
    expect(
      decideDirectProbeAction({ now: 1000 + DIRECT_PROBE_TIMEOUT_MS - 1, capDeclared: true, portAvailable: true, record: probing })
    ).toMatchObject({ action: 'idle' });
    expect(
      decideDirectProbeAction({ now: 1000 + DIRECT_PROBE_TIMEOUT_MS, capDeclared: true, portAvailable: true, record: probing })
    ).toMatchObject({ action: 'expire-probe' });
  });

  it('re-probes an unusable path after the retry window, so a peer that commits its grant recovers', () => {
    const unusable: DirectPathRecord = { state: 'unusable', probeSentAt: null, lastResultAt: 1000, attempts: 1 };
    expect(
      decideDirectProbeAction({ now: 1000 + DIRECT_PROBE_RETRY_MS - 1, capDeclared: true, portAvailable: true, record: unusable })
    ).toMatchObject({ action: 'idle' });
    expect(
      decideDirectProbeAction({ now: 1000 + DIRECT_PROBE_RETRY_MS, capDeclared: true, portAvailable: true, record: unusable })
    ).toMatchObject({ action: 'send-probe' });
  });

  it('leaves a usable path alone', () => {
    expect(
      decideDirectProbeAction({ now: 10_000_000, capDeclared: true, portAvailable: true, record: usable })
    ).toMatchObject({ action: 'idle' });
  });
});

describe('applyDirectProbeResult', () => {
  it('marks answered probes usable and timeouts unusable', () => {
    const probing: DirectPathRecord = { state: 'probing', probeSentAt: 1000, lastResultAt: null, attempts: 1 };
    expect(applyDirectProbeResult(probing, { now: 1200, outcome: 'answered' })).toEqual({
      state: 'usable',
      probeSentAt: null,
      lastResultAt: 1200,
      attempts: 1,
    });
    expect(applyDirectProbeResult(probing, { now: 1200, outcome: 'timeout' })).toEqual({
      state: 'unusable',
      probeSentAt: null,
      lastResultAt: 1200,
      attempts: 1,
    });
  });

  it('is idempotent for a late answer on an already-usable path', () => {
    expect(applyDirectProbeResult(usable, { now: 2000, outcome: 'answered' })).toEqual({
      state: 'usable',
      probeSentAt: null,
      lastResultAt: 2000,
      attempts: 1,
    });
  });

  it('ignores a timeout that arrives after the path was proven', () => {
    expect(applyDirectProbeResult(usable, { now: 2000, outcome: 'timeout' })).toEqual(usable);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ui && npx vitest run src/transport/__tests__/direct-signal-policy.test.ts`
Expected: FAIL — cannot resolve `../direct-signal-policy`.

- [ ] **Step 3: Implement**

Write `ui/src/transport/direct-signal-policy.ts`, header first:

- It owns the named predicate **`direct-path-usable`** and its three constants (working agreement 2). State explicitly: **NOT a liveness predicate** — presence liveness is `presence-policy.ts`; this decides only which carrier a message takes.
- Why the probe exists, in one paragraph: a peer's *declared* capability says its build speaks the protocol; it cannot say whether the conductor will deliver. On a #5974 conductor a receiver with no `Capability::DirectSignal` grant drops the signal and **the sender is never told** (DIRECT_SIGNALS_PLAN.md §1.1 item 3), so declaration alone would route traffic into a black hole. Requiring one observed direct round trip (`PingUi` out, `PongUi` back over the direct path) converts that silent drop — and any other one-way carrier failure — into a path that simply stays on the zome fallback. `DIRECT_PROBE_RETRY_MS` is what lets a peer that later commits its grant recover without a reload.
- `DIRECT_SIGNAL_MAX_PAYLOAD_BYTES = 7 * 1024` with the docblock the Global Constraints require (0.7.0 lair frame; rises to ~1 MiB once the holonix pin reaches 0.7.1 — §1.1 item 1; the check is `nix develop -c holochain --version`).
- Implement the three functions as pure `switch`/comparison logic returning `{ …, reason }` strings that name the arm (`'no-port'`, `'peer-lacks-direct-signal-cap'`, `'path-unproven'`, `'path-proven'`, `'payload-over-direct-ceiling'`, `'path-unusable'`, `'probe-in-flight'`, `'probe-timed-out'`, `'retry-window-open'`, `'path-usable'`). Keep `attempts` monotonic per probe send (incremented by the caller when it sends, or by a small `markDirectProbeSent(record, now)` helper — add it to the exports if the wiring task needs it, with its own test).

- [ ] **Step 4: Run the test and the gate**

Run: `cd ui && npx vitest run src/transport/__tests__/direct-signal-policy.test.ts` → PASS
Run: `nix develop -c npm run verify` → green

- [ ] **Step 5: Commit**

```bash
git add ui/src/transport/direct-signal-policy.ts ui/src/transport/__tests__/direct-signal-policy.test.ts
git commit -m "feat(direct-signals): the direct-path-usable predicate, probe-gated"
```

---

### Task 4: Declare the capability (wire ceremony)

**Files:**
- Modify: `ui/src/transport/wire-contract.ts` (the `WireCap` union, `WIRE_CAPS`)
- Modify: `ui/fixtures/wire-contract.json` (regenerated, reviewed as a diff)
- Test: `ui/src/transport/__tests__/wire-contract.test.ts` (existing — must go red, then green on the regenerated fixture), `ui/src/transport/__tests__/compat-corpus.test.ts` (existing — must stay green)

**Interfaces:**
- Produces: `CAP_DIRECT_SIGNAL = 'direct-signal'`, added to `WireCap` and `WIRE_CAPS`.

- [ ] **Step 1: Add the cap and watch the fixture test fail**

Add to `wire-contract.ts`, beside `CAP_VOICE_BATCH`:

```ts
/** The peer's build can send and receive room signals over the conductor's
 *  `SendDirectSignal` app request instead of the `send_message` zome call
 *  (DIRECT_SIGNALS_PLAN.md §4 phases 1-2). NOT a signal-type gate: every
 *  `SignalMsgType` keeps its own row and its own cap; this declares only
 *  that the CARRIER is understood. Declaring it is necessary but not
 *  sufficient — `decideSignalPath` also requires an observed direct round
 *  trip (`transport/direct-signal-policy.ts`), because a conductor that
 *  enforces holochain PR #5974's capability grant drops undelivered
 *  signals without telling the sender. */
export const CAP_DIRECT_SIGNAL = 'direct-signal';
```

…extend `WireCap` with `| typeof CAP_DIRECT_SIGNAL` and append `CAP_DIRECT_SIGNAL` to `WIRE_CAPS`.

Run: `cd ui && npx vitest run src/transport/__tests__/wire-contract.test.ts`
Expected: FAIL — the declared surface no longer matches `fixtures/wire-contract.json`. **This failure is the point of the ceremony; read the diff it prints before regenerating.**

- [ ] **Step 2: Regenerate the fixture and diff it**

Run (from `ui/`): the update command the test's own failure message names (`UPDATE_WIRE_FIXTURE=1 npx vitest run src/transport/__tests__/wire-contract.test.ts` — use whatever env var the test declares; read the file, do not guess).
Then: `git diff ui/fixtures/wire-contract.json` — the ONLY delta may be the new cap in the caps list. Any other delta is an undeclared wire change: stop and investigate.

- [ ] **Step 3: Confirm the compat corpus still passes**

Run: `cd ui && npx vitest run src/transport/__tests__/compat-corpus.test.ts`
Expected: PASS — adding a cap to our own declaration must not change how any released wire shape is interpreted. (No new `fixtures/compat/*.json` entry belongs here: that file is created by the release ceremony, `docs/RELEASING.md` step 2, at 0.17.0.)

- [ ] **Step 4: Run the gate**

Run: `nix develop -c npm run verify` → green

- [ ] **Step 5: Commit**

```bash
git add ui/src/transport/wire-contract.ts ui/fixtures/wire-contract.json
git commit -m "feat(direct-signals): declare the direct-signal carrier capability"
```

---

### Task 5: Wire the carrier (partition, merge, probe, teardown)

**Files:**
- Modify: `ui/src/store-deps.ts` (add `directSignalPort: DirectSignalPort | null` to `StreamsStoreDeps`)
- Modify: `ui/src/store-deps.testing.ts` (a scriptable fake port)
- Modify: `ui/src/streams-store.ts` (`static connect` builds the port and the partitioning bus; `start()` subscribes; the presence tick drives probes; `disconnect()` unsubscribes)
- Test: `ui/src/__tests__/streams-store-wiring.test.ts`, `ui/src/__tests__/streams-store-construction.test.ts` (the constructor guard must stay green)

**Interfaces:**
- Consumes: Task 1's `encodeDirectEnvelope`/`decodeDirectEnvelope`, Task 2's `DirectSignalPort`/`directSignalPortFor`, Task 3's `decideSignalPath`/`decideDirectProbeAction`/`applyDirectProbeResult`/`initialDirectPathRecord`, Task 4's `CAP_DIRECT_SIGNAL`.
- Produces: no new public store surface. The per-peer `DirectPathRecord` lives on `PeerRecord` (`ui/src/peer-record.ts`) as `directPath`, reached through `_peerRecord`/`_ensurePeerRecord` like every other per-peer field — **not** a new map (the PeerRecord consolidation round's invariant).

- [ ] **Step 1: Write the failing wiring tests**

Add to `streams-store-wiring.test.ts`, following the suite's existing fake-deps setup exactly (read the file first; do not invent a new harness). Five tests, each mutation-checked:

1. **Partition.** Peer A declares `CAP_DIRECT_SIGNAL` with a proven direct path; peer B declares nothing. One `bus.sendMessage([A, B], 'ModuleData', payload)` produces exactly one direct `port.send([A], bytes)` and exactly one zome `sendMessage([B], 'ModuleData', payload)`. Mutation check: force `decideSignalPath` to return `'zome'` and the direct assertion must fail.
2. **Inbound merge.** A direct signal carrying `encodeDirectEnvelope({ from: peerA, msgType: 'PingUi', payload: '{}' })` reaches `handleSignal` and produces the same store effects as the zome-carried `PingUi` (assert on an observable the existing suite already uses for PingUi, e.g. the outgoing pong).
3. **Probe drive.** A peer that declares the cap with an `unknown` path gets exactly one direct `PingUi` on the next presence tick and no `ModuleData` until a direct `PongUi` arrives; after it arrives, `ModuleData` goes direct.
4. **Oversize route.** With a proven path, a `ModuleData` payload longer than `DIRECT_SIGNAL_MAX_PAYLOAD_BYTES` goes zome, not direct.
5. **Teardown symmetry.** `disconnect()` calls the port's unsubscribe exactly once, and a signal delivered after `disconnect()` reaches no handler. (The suite's start/disconnect symmetry test is the template.)

- [ ] **Step 2: Run them and watch them fail**

Run: `cd ui && npx vitest run src/__tests__/streams-store-wiring.test.ts`
Expected: FAIL on all five.

- [ ] **Step 3: Implement the wiring**

- `store-deps.ts`: add `directSignalPort: DirectSignalPort | null` with a docblock saying it is `null` when the client exposes no usable path (Tauri transport, Moss shim without a socket) and that `null` means "zome path only" — the declared fallback, not an error.
- `store-deps.testing.ts`: add the fake port (records `send` calls, lets a test deliver bytes, counts unsubscribes) beside the existing fakes.
- `streams-store.ts` `static connect`: build the port with `directSignalPortFor(roomClient.client, cellId)` — take the `cellId` from the same place the store already resolves its cell/role (read the surrounding code; do not add a second cell-resolution path) — and pass it in the deps record. The `bus` literal's `sendMessage` becomes the partition: for each target read `conversationPayloadCaps(...)` for `CAP_DIRECT_SIGNAL`, the peer's `directPath` record, the encoded envelope's byte length, and `port !== null`, then `decideSignalPath`; direct targets get one `port.send(directTargets, bytes)` per distinct envelope, zome targets one `roomClient.sendMessage(...)` exactly as today. A direct `send` rejection logs (`SimpleEventType` taxonomy — add no new event type in this task) and does **not** fall back mid-flight: the probe owns path state, not the send path.
- `start()`: subscribe the port, decode each inbound envelope, and hand `{ type: 'Message', from_agent, msg_type, payload }` to the **existing** `handleSignal` so the queue/latch semantics are shared. A decode failure drops one signal with a warn.
- Presence tick (`PresenceLoop`, via a binding — do not add a second timer): for each known peer, `decideDirectProbeAction`; `send-probe` sends a direct `PingUi` and marks the record sent; `expire-probe` applies `applyDirectProbeResult(..., 'timeout')`. A direct-carried `PongUi` applies `'answered'` — the natural home is where the inbound direct path already knows the carrier, i.e. in the port subscription before `handleSignal`, so the pong keeps its normal handling too.
- `disconnect()`: unsubscribe the port in the existing `_teardownSubscriptions` phase.
- `peer-record.ts`: add `directPath: DirectPathRecord` (initialised by `initialDirectPathRecord()`), and decide its teardown arms in `resetPeerRecord` — a peer-leave clears it (a rejoining agent re-probes), a media close does not (the carrier is not the media link). Update `peer-record.test.ts`'s full-object `toEqual` expectations accordingly; that suite is the authority for every arm.

- [ ] **Step 4: Run the suites and the gate**

Run: `cd ui && npx vitest run src/__tests__/streams-store-wiring.test.ts src/__tests__/streams-store-construction.test.ts src/__tests__/peer-record.test.ts` → PASS
Run: `nix develop -c npm run verify` → green
Then run each mutation check from Step 1 and confirm the named test goes red.

- [ ] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(direct-signals): partition the carrier behind cap + observed round trip"
```

---

### Task 6: Documentation sync

**Files:**
- Modify: `docs/DIRECT_SIGNALS_PLAN.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Mark the plan's phases**

In `docs/DIRECT_SIGNALS_PLAN.md`, mark phase 1 and phase 2 landed (working agreement 3: a design doc marks each item landed or not-landed once it ships), naming the files that now own each piece, and add one line under phase 2.5 recording that the probe gate is what makes a missing grant degrade instead of black-hole.

- [ ] **Step 2: Add the CLAUDE.md fact bullet**

One bullet in "True today", following the contract in that section: anchored to this branch and date, present-tense claims only where they name the file or test that enforces them. It must state: `ui/src/direct-signal.ts` is the one direct-signal port and the one home of raw-wire knowledge; `ui/src/transport/direct-envelope.ts` is the one envelope codec; `ui/src/transport/direct-signal-policy.ts` owns the `direct-path-usable` predicate and its three constants (declared NOT liveness); the carrier is chosen per peer per message by `decideSignalPath` and requires `CAP_DIRECT_SIGNAL` **plus** an observed direct round trip; the zome path remains the declared fallback and `ping`/backend-`pong` plus all `post_commit` signals stay on it permanently; no zome/DNA/happ change rides this work; and the 0.8-line capability grant (holochain #5974) is NOT done — it needs hdk 0.9-dev and is tracked as phase 2.5.

- [ ] **Step 3: Run the drift test and the gate**

Run: `cd ui && npx vitest run src/__tests__/claude-md-drift.test.ts` → PASS (it rejects test counts and other derivable claims in `CLAUDE.md`)
Run: `nix develop -c npm run verify` → green

- [ ] **Step 4: Commit**

```bash
git add docs/DIRECT_SIGNALS_PLAN.md CLAUDE.md
git commit -m "docs: sync the direct-signals plan and CLAUDE.md with the landed carrier"
```

---

## Execution record (2026-09-14)

Tasks 1-6 executed inline on `wip/direct-signals`; `nix develop -c npm run verify`
green after each. Commits: `b93dc04` (envelope), `78ef1fa` (port), `9f7be0e`
(predicate), `a558daf` (capability + fixture), `72841c5` (wiring), plus this
doc-sync.

Three amendments the execution forced, recorded here rather than silently:

1. **The carrier tag on inbound signals (Task 5).** The plan claimed `handleSignal`
   and `_processSignal` would be untouched. They are not: queue items are now
   `{ signal, via }` and `handlePingUi` answers on `via`. #5974 grants the
   RECEIVER's permission, so each side can only learn that its OWN sends are
   delivered by getting an answer back over the direct carrier; a direct ping
   answered over the zome path would leave both probes unresolved forever and pin
   both sides to the fallback. Every other handler is untouched, as planned.
2. **`cellIdForRole` (Task 2).** `SendDirectSignal` needs a `dna_hash` and inbound
   filtering needs a full `cell_id`, while the client ships only the inverse
   lookup (`roleNameForCellId`). Added as a pure, tested function in
   `direct-signal.ts` rather than an ad-hoc lookup in `static connect`.
3. **Byte normalisation in the port (Task 2).** msgpack decodes `bin` to a `Buffer`
   under node and a `Uint8Array` in a browser; `asBytes` returns a zero-copy
   `Uint8Array` view either way, so the port's output type does not depend on the
   environment. Found by a test comparing against `new Uint8Array(...)`.

Two test files outside the plan's list changed, neither weakened:
`signal-drain.test.ts`'s queue pin moves to the tagged item shape (same
assertion), and `peer-record.test.ts`'s fixture gains `directPath` so the
leave-arm clear is actually pinned — its own mutation check confirms it bites.

## What this plan deliberately does NOT do

- **The `Capability::DirectSignal` grant (phase 2.5).** Blocked on presence moving to hdk 0.9-dev / the 0.8 conductor line; it cannot compile, run, or be DNA-gated in this devshell. When it unblocks, the work is: the grant in the room coordinator's `init`, an idempotent `grant_direct_signal` extern for agents whose `init` already ran, and a DNA-gate row. Nothing in this plan needs to change for it to land — the probe already reads a missing grant as "not usable".
- **The JS client's own support.** The local `holochain-client-js` branch `feat/send-direct-signal` (`1eaf66f`, unpushed) needs `cap_secret` on the request, `from_agent` on `AppDirectSignal`, and its stale ~8 KB caveats removed before it goes upstream. `nativeDirectSignalPort` is what consumes it; `directSignalPortFor` picks it up at runtime with no further change here.
- **Raising `DIRECT_SIGNAL_MAX_PAYLOAD_BYTES`.** Gated on lifting the holonix pin to a 0.7.1 build and re-measuring (`tests/src/signal-latency/direct-signal-latency.test.ts`).
- **Phase 3's spends** (binary frames, voice re-tuning, real video, envelope-sender authentication) — each its own branch, after field numbers.
