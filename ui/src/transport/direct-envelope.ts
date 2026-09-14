/**
 * The direct-signal envelope, declared once.
 *
 * `AppRequest::SendDirectSignal` carries opaque bytes, so the app supplies its
 * own framing. This envelope mirrors the zome path's
 * `RoomSignal { type: 'Message', from_agent, msg_type, payload }`
 * (`ui/src/types.ts`) field for field, which is the whole point: the carrier
 * can change under `StreamsStore` without `_processSignal` or any signal
 * handler changing. The zome path REMAINS the source of truth for peers that
 * do not declare `CAP_DIRECT_SIGNAL` — a declared fallback, not a second
 * authority (working agreement 1).
 *
 * `from` keeps exactly its zome-path trust level: self-declared. The zome
 * path never carried provenance either (`recv_remote_signal` does not read
 * it), so this is not a downgrade. On a 0.8-line conductor
 * `Signal::AppDirect` additionally carries a conductor-verified `from_agent`
 * (`docs/DIRECT_SIGNALS_PLAN.md` §1.1 item 2), which makes this field
 * checkable for the first time; that check is a separate, later change and
 * deliberately not done here.
 *
 * Pure by construction — bytes in, tagged union out — so it is table tested
 * without a conductor, a client, or a `StreamsStore`.
 */
import { decode, encode } from '@msgpack/msgpack';

import { isSignalMsgType, type SignalMsgType } from './wire-contract';

/** Bumped only for a breaking envelope change. A peer that reads a version it
 *  does not know drops that one signal, never the session. */
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
 * session — the inbound direct listener runs outside the store's
 * `_processingSignal` latch, so a throw there would surface as an unhandled
 * rejection in a socket callback.
 */
export function decodeDirectEnvelope(bytes: Uint8Array): DecodedDirectEnvelope {
  let raw: unknown;
  try {
    raw = decode(bytes);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: `envelope decoded to ${
        Array.isArray(raw) ? 'array' : String(raw === null ? 'null' : typeof raw)
      }, expected a msgpack map`,
    };
  }

  const { v, from, msgType, payload } = raw as Record<string, unknown>;

  if (v !== DIRECT_ENVELOPE_VERSION) {
    return { ok: false, error: `unsupported envelope version ${String(v)}` };
  }
  if (!(from instanceof Uint8Array)) {
    return { ok: false, error: `from is ${typeof from}, expected bytes` };
  }
  if (typeof msgType !== 'string' || !isSignalMsgType(msgType)) {
    return { ok: false, error: `unknown msgType ${String(msgType)}` };
  }
  if (typeof payload !== 'string') {
    return { ok: false, error: `payload is ${typeof payload}, expected string` };
  }

  return { ok: true, value: { from, msgType, payload } };
}
