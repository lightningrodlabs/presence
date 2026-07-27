/**
 * Signal-payload parsing.
 *
 * Holochain signal payloads are JSON strings produced by a *remote* peer. They
 * are therefore untrusted input in the ordinary sense: a peer on a different
 * version, a truncated relay delivery, or a bug on the far side can all put a
 * string on the wire that `JSON.parse` rejects.
 *
 * The failure this exists to prevent is not the parse error itself but its
 * blast radius. `StreamsStore.handleSignal` drains its queue behind a
 * `_processingSignal` latch; before this, an unguarded `JSON.parse` in any
 * handler threw past the latch reset and left it stranded `true`, which turned
 * every subsequent signal — pings, pongs, presence, SDP, module data — into
 * push-and-return for the rest of the session. One malformed payload from one
 * peer silenced the room until reload.
 *
 * The rule this encodes: **a bad payload drops one signal, never the session.**
 * Callers must handle the `ok: false` arm by returning; the latch reset in
 * `handleSignal` is the backstop, not the primary defence.
 *
 * Pure by construction — plain string in, tagged union out — so it is table
 * tested without mocks or a `StreamsStore` instance (which cannot be built
 * under vitest; see CLAUDE.md).
 */

export type ParsedPayload<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Parse a signal payload without throwing.
 *
 * Returns `ok: false` for malformed JSON *and* for JSON that parses to
 * something a destructuring caller cannot use — `null`, or a primitive.
 * Every caller in `streams-store.ts` immediately destructures named fields, so
 * `JSON.parse('4')` succeeding would only move the `TypeError` one line down.
 * Arrays are also rejected: no signal payload in this protocol is an array, and
 * destructuring named fields off one silently yields `undefined`.
 */
export function parseSignalPayload<T>(raw: unknown): ParsedPayload<T> {
  if (typeof raw !== 'string') {
    return { ok: false, error: `payload is ${typeof raw}, expected string` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `payload parsed to ${
        Array.isArray(parsed) ? 'array' : String(parsed === null ? 'null' : typeof parsed)
      }, expected object`,
    };
  }

  return { ok: true, value: parsed as T };
}
