import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Phase 2's invariant, pinned mechanically: `streams-store.ts` reads time
 * only through `this.clock` — never `Date.now()`, `new Date()`, or a bare
 * `setTimeout`/`setInterval`. The store's testability rests on this; every
 * timing-dependent decision became assertable the day the last ambient
 * call left the file.
 *
 * Why a source-grep test and not prose: the invariant nearly regressed on
 * the first branch that raced it. The Phase 2b branch was cut one commit
 * before Phase 2 merged, and its two conflict hunks carried three
 * `Date.now()` calls back into the file — caught only because the
 * adversarial review ran the trial merge (working agreement 9). CLAUDE.md
 * already said what this test says; prose demonstrably does not hold the
 * line, a failing gate does (working agreement 5).
 *
 * If this test failed for you: route the new call through `this.clock`.
 * If you are writing a comment that mentions a bare timer call, write
 * `clock.setTimeout` instead of `setTimeout(` — the pin scans the whole
 * source, deliberately, so it cannot be fooled by code moving into or out
 * of comments.
 */

const STREAMS_STORE_PATH = fileURLToPath(
  new URL('../streams-store.ts', import.meta.url),
);

const AMBIENT_CLOCK_PATTERNS: Array<[name: string, re: RegExp]> = [
  // No /g flag: RegExp.test with /g is stateful across calls.
  ['Date.now()', /\bDate\.now\s*\(/],
  ['new Date()', /\bnew\s+Date\s*\(/],
  // A leading dot or word char means it's a method on something
  // (this.clock.setTimeout). window.setTimeout would still be ambient but
  // does not occur; add a pattern here if it ever does.
  ['bare setTimeout()', /(?<![.\w])setTimeout\s*\(/],
  ['bare setInterval()', /(?<![.\w])setInterval\s*\(/],
];

describe('streams-store.ts reads time only through this.clock', () => {
  const source = readFileSync(STREAMS_STORE_PATH, 'utf8');

  it.each(AMBIENT_CLOCK_PATTERNS)('contains no %s', (_name, re) => {
    const lines = source
      .split('\n')
      .flatMap((line, i) => (re.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
    expect(lines).toEqual([]);
  });
});
