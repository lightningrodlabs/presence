import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Task 1's invariant, pinned mechanically following the
 * `no-ambient-clock.test.ts` grep-pin pattern: `LocalIntent` (intent.ts)
 * is written from exactly one place, `StreamsStore._applyIntent`, and
 * that method is called only from the enumerated user-gesture entry
 * points below — never from an event handler, timer, transport callback,
 * or reconciler. Declared (working agreement 1): this record is a
 * parallel authority added by Task 1; nothing reads it yet, and this
 * pin is what stops the parallel period from growing a second writer.
 *
 * Method-slicing technique borrowed from no-ambient-clock.test.ts: the
 * source is sliced between successive method-header markers so each
 * gesture method's body can be checked in isolation for the `_applyIntent`
 * call, and the whole-file scan can exclude `_applyIntent`'s own body
 * when checking for stray `_localIntent.update`/`.set` writes.
 *
 * If this test failed for you: either a write to `_localIntent` crept in
 * outside `_applyIntent`, or a call to `_applyIntent` crept in outside
 * the enumerated gesture methods below. Route the write through
 * `_applyIntent`, or add the new gesture method to ALLOWED_CALL_SITES —
 * the list is the authority, so widening it is a reviewable, visible act.
 */

const SOURCE_PATH = fileURLToPath(new URL('../streams-store.ts', import.meta.url));
const source = readFileSync(SOURCE_PATH, 'utf8');
const lines = source.split('\n');

// The one writer. Its own method header, used to carve its body out of
// the whole-file scan for stray `_localIntent.update`/`.set` calls.
const APPLY_INTENT_HEADER = /private _applyIntent\(gesture: IntentGesture\): void \{/;

// The enumerated user-gesture entry points (brief, Task 1). Each is a
// method-header regex; the pin locates the header line and the method's
// closing brace at column 0 (methods in this class are never indented
// past one level, matching the no-ambient-clock file-slicing technique).
const ALLOWED_CALL_SITES: Array<[name: string, header: RegExp]> = [
  ['disconnect', /^  disconnect\(reason: string = 'unknown'\) \{/],
  ['videoOn', /^  async videoOn\(\) \{/],
  ['videoOff', /^  videoOff\(\) \{/],
  ['audioOn', /^  async audioOn\(enabled: boolean\) \{/],
  ['audioOff', /^  async audioOff\(\) \{/],
  ['screenShareOn', /^  async screenShareOn\(\) \{/],
  ['screenShareOff', /^  screenShareOff\(\) \{/],
  ['setCarrierMode', /^  async setCarrierMode\(mode: 'webrtc' \| 'signals'\): Promise<void> \{/],
  ['setPeerCarrier', /^  async setPeerCarrier\(/],
];

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

describe('_applyIntent is the ONE writer of _localIntent', () => {
  it('_applyIntent exists as a private method', () => {
    expect(source).toMatch(APPLY_INTENT_HEADER);
  });

  it('no _localIntent.update/.set call exists outside _applyIntent', () => {
    const applyIntentBody = sliceMethod(APPLY_INTENT_HEADER);
    const rest = source.replace(applyIntentBody, '');
    const stray = rest
      .split('\n')
      .flatMap((line, i) =>
        /_localIntent\.(update|set)\s*\(/.test(line) ? [`${i + 1}: ${line.trim()}`] : []
      );
    expect(stray).toEqual([]);
  });

  it('_applyIntent itself writes _localIntent', () => {
    const applyIntentBody = sliceMethod(APPLY_INTENT_HEADER);
    expect(applyIntentBody).toMatch(/_localIntent\.update\s*\(/);
  });
});

describe('this._applyIntent( is called only from the enumerated gesture methods', () => {
  it('every call site is inside an allowed method', () => {
    const allowedBodies = ALLOWED_CALL_SITES.map(([, header]) => sliceMethod(header));

    let rest = source;
    for (const body of allowedBodies) {
      rest = rest.replace(body, '');
    }

    const stray = rest
      .split('\n')
      .flatMap((line, i) =>
        /this\._applyIntent\(/.test(line) ? [`${i + 1}: ${line.trim()}`] : []
      );
    expect(stray).toEqual([]);
  });

  it.each(ALLOWED_CALL_SITES)('%s calls this._applyIntent(', (_name, header) => {
    const body = sliceMethod(header);
    expect(body).toMatch(/this\._applyIntent\(/);
  });
});
