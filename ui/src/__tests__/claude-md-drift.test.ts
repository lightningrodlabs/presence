import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CLAUDE.md drift gate (decided 2026-08-03; see the "True today" contract in
 * CLAUDE.md itself). Every CLAUDE.md falsehood found by the 2026-07 and
 * 2026-08 audits fell into three classes: derivable counters, repo-state
 * snapshots, and unanchored negations. This test mechanizes the two
 * greppable ones:
 *
 *   1. No numeric test-count claims. A test count is the run's own output;
 *      a copy of it in prose was stale twice in one week. If this fails,
 *      delete the number — do not update it.
 *   2. Every file CLAUDE.md cites in backticks must exist somewhere in the
 *      repo, or be explicitly allow-listed as a declared historical
 *      citation. If this fails because a cited file was deleted, either
 *      update the prose or add the basename to KNOWN_DELETED with a reason.
 *
 * The third class (negations like "nothing writes X") is not greppable and
 * stays with the reviewer checklist.
 *
 * Per the repo's negative-control rule, each check is exercised against a
 * specimen it must catch — a gate that cannot fail is a recorded intention.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLAUDE_MD = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');

// -- 1. counter ban ---------------------------------------------------------

const COUNT_PATTERNS: Array<[name: string, re: RegExp]> = [
  // "649 unit tests", "16 wiring tests", "13 passive-presence tests"
  ['N tests', /\b\d[\d,]*(?:\s+[\w-]+)?\s+tests?\b/i],
  // "the 11-test TransitionRecorder suite"
  ['N-test', /\b\d+-test\b/i],
  // "the reviewer re-ran verify 614"
  ['verify N', /\bverify\s+\d/i],
];

describe('CLAUDE.md carries no test-count claims', () => {
  for (const [name, re] of COUNT_PATTERNS) {
    it(`no "${name}" pattern`, () => {
      const lines = CLAUDE_MD.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => re.test(line));
      expect(
        lines.map(({ n, line }) => `line ${n}: ${line.slice(0, 120)}`),
      ).toEqual([]);
    });
  }

  it('negative control: each pattern catches its specimen', () => {
    const specimens: Array<[string, string]> = [
      ['N tests', '649 unit tests'],
      ['N tests', 'Phase 6 added 16 wiring tests'],
      ['N tests', '13 passive-presence tests'],
      ['N-test', 'the 11-test TransitionRecorder suite'],
      ['verify N', 'the reviewer re-ran verify 614'],
    ];
    for (const [name, specimen] of specimens) {
      const re = COUNT_PATTERNS.find(([n]) => n === name)![1];
      expect(re.test(specimen), `"${name}" must catch "${specimen}"`).toBe(
        true,
      );
    }
  });
});

// -- 2. cited files exist ---------------------------------------------------

// Files CLAUDE.md deliberately cites as deleted/historical. An entry here is
// a declared citation of something that no longer exists — add one only with
// the prose that marks it deleted.
const KNOWN_DELETED = new Set([
  'auto-flip-policy.ts', // deleted with SimplePeer in Phase 3; cited as the former template
]);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'target',
  '.vite',
  'workdir',
  'coverage',
  'test-results',
  'playwright-report',
]);

function collectFiles(root: string): { basenames: Set<string>; relPaths: Set<string> } {
  const basenames = new Set<string>();
  const relPaths = new Set<string>();
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), `${rel}${entry.name}/`);
      } else {
        basenames.add(entry.name);
        relPaths.add(`${rel}${entry.name}`);
      }
    }
  };
  walk(root, '');
  return { basenames, relPaths };
}

// Backticked tokens that look like source/doc files.
const CITED_FILE_RE = /`([A-Za-z0-9_./-]+\.(?:ts|md|json|html|rs))`/g;

function findMissingCitations(
  text: string,
  files: { basenames: Set<string>; relPaths: Set<string> },
): string[] {
  const missing: string[] = [];
  for (const match of text.matchAll(CITED_FILE_RE)) {
    const token = match[1];
    const basename = token.split('/').pop()!;
    if (KNOWN_DELETED.has(basename)) continue;
    if (files.relPaths.has(token)) continue;
    if (files.basenames.has(basename)) continue;
    missing.push(token);
  }
  return [...new Set(missing)];
}

describe('every file CLAUDE.md cites exists (or is a declared deletion)', () => {
  const files = collectFiles(REPO_ROOT);

  it('no dangling citations', () => {
    expect(findMissingCitations(CLAUDE_MD, files)).toEqual([]);
  });

  it('negative control: the checker reports a fabricated citation', () => {
    expect(
      findMissingCitations('see `no-such-file-drift-control.ts` for details', files),
    ).toEqual(['no-such-file-drift-control.ts']);
  });
});
