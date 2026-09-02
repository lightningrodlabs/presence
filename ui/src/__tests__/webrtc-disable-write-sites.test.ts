import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Final-review pin (2026-09-01, closing the `toggleDisableWebrtc` finding):
 * exactly two methods may write the per-peer WebRTC disable state —
 * `setPeerCarrier` (our own per-peer `disableWebrtcWith`, mirrored into
 * `localIntent.webrtc.disabledWith` via `_applyIntent`) and `setCarrierMode`
 * (the global `disableAllWebrtc` kill switch, mirrored into
 * `localIntent.webrtc.enabled`).
 *
 * `toggleDisableWebrtc` used to be a second, orphaned writer of
 * `disableWebrtcWith`: it broadcast the payload change without calling
 * `_applyIntent`, so `webrtcDisabled(peer)`'s intent-sourced half (Task 4)
 * would disagree with what the peer actually saw on the wire — the peer
 * tears down (it saw our broadcast) while our own eligibility check still
 * reads "not disabled" and keeps re-sending InitRequest every pong cycle.
 * It was dead code (no caller), which is exactly why it survived
 * unnoticed; this pin makes a second writer reappearing a compile-time-
 * adjacent test failure instead of a silent parallel authority.
 *
 * Method-slicing technique borrowed from `no-ambient-clock.test.ts` /
 * `intent-write-sites.test.ts`: allowed method bodies are carved out of
 * the source, and the remainder is scanned for the WRITE forms of the two
 * tokens. Reads (`.disableWebrtcWith.includes(...)`, comments mentioning
 * either name) are deliberately not what these patterns match — this pin
 * is about writers, not the read-side observations `webrtcDisabled` and
 * `myPeerCarrier` legitimately perform outside these two methods.
 *
 * If this test failed for you: a write to `disableWebrtcWith` (an
 * assignment, not a `.includes` read) or to the `disableAllWebrtc`
 * storage key crept in outside `setPeerCarrier`/`setCarrierMode`. Route it
 * through one of those two methods (and `_applyIntent`, so intent stays
 * the one authority for our own side), or, if a new gesture genuinely
 * needs its own writer, add it here deliberately — the list is the
 * authority, so widening it is a reviewable, visible act.
 */

const SOURCE_PATH = fileURLToPath(new URL('../streams-store.ts', import.meta.url));
const source = readFileSync(SOURCE_PATH, 'utf8');
const lines = source.split('\n');

/** Slice from a method's header line to the next line that closes it at
 *  column 0 (`  }`) — the same one-indent-level assumption
 *  no-ambient-clock.test.ts relies on for this file's class body. */
function sliceMethod(headerRe: RegExp): string {
  const startIdx = lines.findIndex(l => headerRe.test(l));
  if (startIdx === -1) {
    throw new Error(`method header not found: ${headerRe}`);
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^  \}/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

const SET_CARRIER_MODE_HEADER =
  /^  async setCarrierMode\(mode: 'webrtc' \| 'signals'\): Promise<void> \{/;
const SET_PEER_CARRIER_HEADER = /^  async setPeerCarrier\(/;

const ALLOWED_WRITE_SITES: Array<[name: string, header: RegExp]> = [
  ['setCarrierMode', SET_CARRIER_MODE_HEADER],
  ['setPeerCarrier', SET_PEER_CARRIER_HEADER],
];

// Assignment to the payload field — a write. Deliberately excludes
// `.disableWebrtcWith.includes(...)`, which is a read (webrtcDisabled,
// myPeerCarrier both read this way, from outside these two methods).
const DISABLE_WEBRTC_WITH_WRITE = /\.disableWebrtcWith\s*=/;

// The persisted global kill switch. Deliberately matches only the
// storage write calls, not the key name appearing in a comment.
const DISABLE_ALL_WEBRTC_WRITE =
  /storage\.local\.(setItem|removeItem)\(\s*'disableAllWebrtc'/;

describe('disableWebrtcWith / disableAllWebrtc are written from exactly two methods', () => {
  it('no write to disableWebrtcWith or disableAllWebrtc exists outside setPeerCarrier/setCarrierMode', () => {
    const allowedBodies = ALLOWED_WRITE_SITES.map(([, header]) => sliceMethod(header));

    let rest = source;
    for (const body of allowedBodies) {
      rest = rest.replace(body, '');
    }

    const stray = rest
      .split('\n')
      .flatMap((line, i) =>
        DISABLE_WEBRTC_WITH_WRITE.test(line) || DISABLE_ALL_WEBRTC_WRITE.test(line)
          ? [`${i + 1}: ${line.trim()}`]
          : []
      );
    expect(stray).toEqual([]);
  });

  it('setPeerCarrier writes disableWebrtcWith', () => {
    const body = sliceMethod(SET_PEER_CARRIER_HEADER);
    expect(body).toMatch(DISABLE_WEBRTC_WITH_WRITE);
  });

  it('setCarrierMode writes disableAllWebrtc', () => {
    const body = sliceMethod(SET_CARRIER_MODE_HEADER);
    expect(body).toMatch(DISABLE_ALL_WEBRTC_WRITE);
  });
});
