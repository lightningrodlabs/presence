#!/usr/bin/env node
/**
 * Presence ↔ signals-media wire-drift alarm (monorepo glue).
 *
 * `packages/signals-media` is a DECLARED PARALLEL COPY of Presence's signals
 * media carrier (design spec decision 2): `ui/src/room/modules/voice.ts` and
 * `video-filmstrip.ts` keep their implementation until the Presence adoption
 * round, and the package must speak the same wire. The package pins its own
 * side with a golden fixture (`src/__tests__/fixtures/wire.json`), but that
 * test deliberately reads nothing outside the package — self-containment is
 * decision 13, and the package has to keep verifying after it is extracted.
 *
 * The cross-tree half therefore lives HERE, outside the package directory,
 * and is dropped rather than ported on extraction: for every field name the
 * fixture records, assert that Presence's own module still mentions it in a
 * field position. That is a cheap alarm, not a proof — it catches a rename or
 * a removal on the Presence side while the two copies coexist. It does not
 * catch a semantic change that keeps the names.
 *
 * Run: node scripts/check-signals-media-drift.mjs [uiModulesDir]
 *   `uiModulesDir` overrides where the Presence modules are read from; it
 *   exists so the alarm can be demonstrated against a modified copy without
 *   editing `ui/`. Default: `ui/src/room/modules`.
 *
 * Wired into the root `verify`.
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(
  REPO_ROOT,
  'packages/signals-media/src/__tests__/fixtures/wire.json'
);
const DEFAULT_MODULES_DIR = join(REPO_ROOT, 'ui/src/room/modules');

/**
 * Does `source` use `name` in a field position — an interface member, an
 * object-literal key, or a typed parameter? Deliberately syntactic: the
 * question is whether Presence's copy still speaks this name at all.
 */
function mentionsField(source, name) {
  const re = new RegExp(`(?:^|[^A-Za-z0-9_$])${name}\\s*\\??\\s*:`, 'm');
  return re.test(source);
}

/** Every field name a fixture case records, top level and nested. */
function fieldNamesOf(fixtureCase) {
  const names = new Set(fixtureCase.fields);
  for (const nested of Object.values(fixtureCase.nested ?? {})) {
    for (const n of nested) names.add(n);
  }
  return names;
}

/**
 * Negative control (repo rule: a gate that cannot fail is a recorded
 * intention). The matcher is run against a synthetic module that is missing
 * one field; if it reports nothing, the checker below proves nothing either.
 */
function selfTest() {
  const present = 'interface F { seq: number; wts?: number }';
  if (!mentionsField(present, 'wts')) {
    throw new Error('drift self-test: matcher failed to see a present field');
  }
  const removed = 'interface F { seq: number }';
  if (mentionsField(removed, 'wts')) {
    throw new Error('drift self-test: matcher saw a field that was removed');
  }
  // A name that only appears as a substring of another identifier must not
  // count as a mention.
  if (mentionsField('interface F { redundancy: number }', 'red')) {
    throw new Error('drift self-test: matcher matched a substring');
  }
}

function main() {
  selfTest();

  const modulesDir = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : DEFAULT_MODULES_DIR;

  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const sources = new Map();
  const missing = [];

  for (const [caseName, c] of Object.entries(fixture.cases)) {
    const file = c.origin.split('/').pop();
    if (!sources.has(file)) {
      sources.set(file, readFileSync(join(modulesDir, file), 'utf8'));
    }
    const source = sources.get(file);
    for (const name of fieldNamesOf(c)) {
      if (!mentionsField(source, name)) {
        missing.push({ caseName, file, name });
      }
    }
  }

  if (missing.length > 0) {
    console.error(
      'signals-media wire drift: Presence no longer mentions field(s) the ' +
        'package fixture records.\n'
    );
    for (const m of missing) {
      console.error(
        `  ${m.file}: no field \`${m.name}\` (fixture case ${m.caseName})`
      );
    }
    console.error(
      '\nEither Presence changed the wire — in which case the package must ' +
        'change with it, and\n' +
        `${FIXTURE.replace(REPO_ROOT + '/', '')} is the record to update — or ` +
        'the name moved and this\nalarm needs re-pointing. Do not delete the ' +
        'check to make it pass.'
    );
    process.exit(1);
  }

  const checked = [...sources.keys()].join(', ');
  console.log(`signals-media wire fixture agrees with Presence (${checked})`);
}

main();
