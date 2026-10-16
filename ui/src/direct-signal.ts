/**
 * Direct-signal wire body.
 *
 * Since 0.17.0 (Holochain 0.7.1) every `Message` signal — PingUi, the
 * InitRequest/InitAccept handshake, SDP, module state and media frames —
 * rides `AppWebsocket.sendDirectSignal`, an app-interface request with no
 * zome call on either side and a 1 MiB payload ceiling. Only the zome's own
 * Ping/Pong stays on remote signals, because the pong is answered inside the
 * zome even when no UI is open (decision D1, 2026-10-16).
 *
 * The conductor carries an opaque byte string plus the sender's key
 * (`from_agent` on the `AppDirect` envelope, stamped by the conductor — a
 * peer cannot forge it). This module owns what goes inside the bytes:
 * msgpack `{ msg_type, payload }`, the two fields the zome's retired
 * `SignalPayload::Message` carried besides `from_agent`. `RoomClient`
 * re-assembles the old `RoomSignal` shape on receipt, so nothing above it
 * changed.
 *
 * Same rule as `signal-payload.ts`: the bytes come from a remote peer and are
 * untrusted. The decoder never throws — a bad body drops one signal, never
 * the session.
 *
 * Pure by construction: bytes in, tagged union out, table-tested without a
 * conductor. The tryorama suite (`tests/src/room/room.test.ts`) pins the
 * same layout from the other side of the wire with a hand-built msgpack map.
 */
import { decode, encode } from '@msgpack/msgpack';
import type { ParsedPayload } from './signal-payload';

export type DirectSignalBody = {
  /** The `SignalMsgType` string (`transport/wire-contract.ts`); narrowed by
   *  the consumer, not here — an unknown type is a drop-with-warn, and the
   *  decoder must not reject a newer peer's traffic outright. */
  msg_type: string;
  /** Opaque, frontend-defined; usually JSON. */
  payload: string;
};

export function encodeDirectSignal(msgType: string, payload: string): Uint8Array {
  return encode({ msg_type: msgType, payload });
}

export function decodeDirectSignal(bytes: Uint8Array): ParsedPayload<DirectSignalBody> {
  let parsed: unknown;
  try {
    parsed = decode(bytes);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `direct signal decoded to ${
        Array.isArray(parsed) ? 'array' : String(parsed === null ? 'null' : typeof parsed)
      }, expected object`,
    };
  }
  // A msgpack map decodes to a plain object only when its keys are strings;
  // @msgpack/msgpack yields a Map for non-string keys, which is not a body.
  if (parsed instanceof Map) {
    return { ok: false, error: 'direct signal decoded to a Map, expected object' };
  }

  const { msg_type, payload } = parsed as Record<string, unknown>;
  if (typeof msg_type !== 'string') {
    return { ok: false, error: `msg_type is ${typeof msg_type}, expected string` };
  }
  if (typeof payload !== 'string') {
    return { ok: false, error: `payload is ${typeof payload}, expected string` };
  }
  return { ok: true, value: { msg_type, payload } };
}
