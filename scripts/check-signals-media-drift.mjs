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
 * and is dropped rather than ported on extraction.
 *
 * What it checks: for each fixture case, the member names of the Presence
 * declaration that types that payload (`WIRE_DECLARATIONS` below) must EQUAL
 * the fixture's field set, top level and nested, in both directions. A
 * field renamed or removed on either side, or added on either side, fails.
 * The declarations are the `interface` blocks (`VoiceFramePayload`, with its
 * `extends VoiceFrame` resolved; `FilmstripClipPayload`;
 * `FilmstripStopPayload`) and, for the batch envelope, which has no
 * interface, the object literal `packVoiceFrames` passes to
 * `JSON.stringify`. Nested sets come from the member's own type annotation
 * (`red?: VoiceFrame[]`), so a retyped member is followed, not assumed.
 * Only text inside those declarations is read — a name used elsewhere in
 * the file (a parameter, an unrelated literal) does not count.
 *
 * What it relies on rather than checks: every Presence sender literal is
 * annotated with its payload interface (`const payload: VoiceFramePayload =
 * …`), so `tsc` (also in `verify`) holds the senders to the interface for
 * required members and excess keys. It does NOT catch a sender that stops
 * emitting an OPTIONAL member the interface still declares, nor a semantic
 * change that keeps the names. It is an alarm, not a proof.
 *
 * Run: node scripts/check-signals-media-drift.mjs [uiModulesDir]
 *   `uiModulesDir` overrides where the Presence modules are read from; it
 *   exists so the alarm can be demonstrated against a modified copy without
 *   editing `ui/`. Default: `ui/src/room/modules`.
 *
 * Wired into the root `verify`. Its self-test (negative controls) runs
 * first on every invocation.
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
 * Where Presence declares each fixture case. `interface` names the typing
 * interface; `literalIn` names the function whose `JSON.stringify({...})`
 * literal is the declaration, with `nestedTypes` naming the element
 * interface of each of its members (the literal carries no annotation).
 * `omittedBySender` lists interface members the fixture deliberately does
 * not record, each with the fixture's own reason.
 */
const WIRE_DECLARATIONS = {
  voiceFrameV1: { interface: 'VoiceFramePayload' },
  voiceBatchV2: {
    literalIn: 'packVoiceFrames',
    nestedTypes: { frames: 'VoiceFramePayload' },
  },
  filmstripClip: {
    interface: 'FilmstripClipPayload',
    // Fixture case description: "`kind` is omitted by the sender (clip is
    // the default); a receiver also accepts an explicit 'clip'."
    omittedBySender: ['kind'],
  },
  filmstripStop: { interface: 'FilmstripStopPayload' },
};

// ---------------------------------------------------------------------------
// Lexing helpers: skip comments and string literals so braces or names inside
// them are never read as structure.

/** Index just past the comment or string starting at `i`, or -1 if none. */
function skipNonCode(src, i) {
  const c = src[i];
  const d = src[i + 1];
  if (c === '/' && d === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }
  if (c === '/' && d === '*') {
    const end = src.indexOf('*/', i + 2);
    if (end === -1) throw new Error('drift: unterminated block comment');
    return end + 2;
  }
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  return -1;
}

/** Source with comments removed and string contents blanked. */
function codeOnly(src) {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const j = skipNonCode(src, i);
    if (j === -1) {
      out += src[i];
      i += 1;
    } else {
      const isString = src[i] === "'" || src[i] === '"' || src[i] === '`';
      out += isString ? src[i] + ' '.repeat(Math.max(0, j - i - 2)) + src[i] : ' ';
      i = j;
    }
  }
  return out;
}

/** Text strictly between the `{` at `open` and its matching `}` (code-only input). */
function braceBody(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error('drift: unbalanced braces');
}

/** Split `text` at depth-0 occurrences of any char in `seps`. */
function splitTopLevel(text, seps) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    if (depth === 0 && seps.includes(ch)) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Declaration readers.

/**
 * Members of `interface name` in `code` (code-only source), with `extends`
 * resolved within the same file: Map<memberName, typeText>.
 */
function interfaceMembers(code, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`drift: interface cycle at ${name}`);
  seen.add(name);
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_$])interface\\s+${name}\\s*(?:extends\\s+([^{]+))?\\{`,
    'm'
  );
  const m = re.exec(code);
  if (!m) throw new Error(`drift: no \`interface ${name}\` found`);
  const members = new Map();
  if (m[1]) {
    for (const base of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      for (const [k, v] of interfaceMembers(code, base, seen)) members.set(k, v);
    }
  }
  const body = braceBody(code, m.index + m[0].length - 1);
  for (const part of splitTopLevel(body, ';\n')) {
    const mm = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:\s*([\s\S]*)$/.exec(part);
    if (!mm) throw new Error(`drift: unreadable member in ${name}: ${part}`);
    members.set(mm[1], mm[2].trim());
  }
  return members;
}

/** Keys of the object literal passed to `JSON.stringify` inside `function fnName`. */
function literalKeysIn(code, fnName) {
  const fn = new RegExp(`function\\s+${fnName}\\s*\\(`).exec(code);
  if (!fn) throw new Error(`drift: no \`function ${fnName}\` found`);
  const bodyOpen = code.indexOf('{', code.indexOf(')', fn.index));
  const body = braceBody(code, bodyOpen);
  const call = /JSON\.stringify\s*\(\s*\{/.exec(body);
  if (!call) throw new Error(`drift: no JSON.stringify({...}) in ${fnName}`);
  const lit = braceBody(body, call.index + call[0].length - 1);
  const keys = [];
  for (const part of splitTopLevel(lit, ',')) {
    const km = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part);
    if (!km) throw new Error(`drift: unreadable literal entry in ${fnName}: ${part}`);
    keys.push(km[1]);
  }
  return keys;
}

/** Interface name a member's type refers to (`VoiceFrame[]` → `VoiceFrame`), if any. */
function elementInterface(typeText) {
  const m = /^([A-Za-z_$][\w$]*)(?:\[\])?$/.exec(typeText.replace(/\s+/g, ''));
  return m ? m[1] : null;
}

/**
 * The declared field sets for one case: { top: string[], nested: {k: string[]} },
 * following nested members through their type annotations.
 */
function declaredShape(code, decl) {
  const nested = {};
  const walk = (ifaceName) => {
    const members = interfaceMembers(code, ifaceName);
    for (const [k, t] of members) {
      const el = elementInterface(t);
      if (el && new RegExp(`interface\\s+${el}\\b`).test(code) && !(k in nested)) {
        nested[k] = [...interfaceMembers(code, el).keys()];
        walk(el);
      }
    }
    return [...members.keys()];
  };
  let top;
  if (decl.interface) {
    top = walk(decl.interface);
  } else {
    top = literalKeysIn(code, decl.literalIn);
    for (const [k, iface] of Object.entries(decl.nestedTypes ?? {})) {
      nested[k] = walk(iface);
    }
  }
  const omit = new Set(decl.omittedBySender ?? []);
  return { top: top.filter((n) => !omit.has(n)), nested };
}

/** Symmetric difference, as human-readable lines. */
function diffSets(where, fixtureNames, declaredNames) {
  const f = new Set(fixtureNames);
  const d = new Set(declaredNames);
  const out = [];
  for (const n of f) if (!d.has(n)) out.push(`${where}: fixture has \`${n}\`, Presence does not`);
  for (const n of d) if (!f.has(n)) out.push(`${where}: Presence has \`${n}\`, fixture does not`);
  return out;
}

/** All mismatches between one fixture case and the Presence source. */
function compareCase(caseName, fixtureCase, decl, source) {
  const code = codeOnly(source);
  const shape = declaredShape(code, decl);
  const problems = diffSets(`${caseName} (top level)`, fixtureCase.fields, shape.top);
  const fNested = fixtureCase.nested ?? {};
  const keys = new Set([...Object.keys(fNested), ...Object.keys(shape.nested)]);
  for (const k of keys) {
    if (!(k in fNested)) {
      problems.push(`${caseName}.${k}: Presence declares nested fields, fixture records none`);
    } else if (!(k in shape.nested)) {
      problems.push(`${caseName}.${k}: fixture records nested fields, Presence declares none`);
    } else {
      problems.push(...diffSets(`${caseName}.${k}`, fNested[k], shape.nested[k]));
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

/**
 * Negative controls (repo rule: a gate that cannot fail is a recorded
 * intention). Each case runs the real comparison over a synthetic module.
 */
function selfTest() {
  const fixtureCase = {
    fields: ['seq', 'data', 'red'],
    nested: { red: ['seq', 'data'] },
  };
  const decl = { interface: 'P' };
  const good = `
    interface F { seq: number; data: string } // data: not a member
    interface P extends F { red?: F[] }
    function unrelated(data: string, type: 'agent') { return { data }; }
  `;
  const check = (label, src, wantOk) => {
    const problems = compareCase('self', fixtureCase, decl, src);
    if ((problems.length === 0) !== wantOk) {
      throw new Error(
        `drift self-test (${label}): expected ${wantOk ? 'agreement' : 'a mismatch'}, got ${JSON.stringify(problems)}`
      );
    }
  };
  check('unmodified', good, true);
  // The review's scenario: `data` renamed in the declaration while `data:`
  // survives as a parameter name and in comments elsewhere in the file.
  check('data rename', good.replace('data: string }', 'bytes: string }'), false);
  check('field removed', good.replace('; data: string', ''), false);
  check('field added in Presence', good.replace('red?: F[]', 'red?: F[]; extra?: number'), false);
  check('extends dropped', good.replace('extends F ', ''), false);
  check('nested retyped', good.replace('red?: F[]', 'red?: string[]'), false);

  const batchCase = { fields: ['v', 'frames'], nested: { frames: ['seq'] } };
  const batchDecl = { literalIn: 'pack', nestedTypes: { frames: 'Q' } };
  const batchSrc = `
    interface Q { seq: number }
    /** Wire: \`{ v: 2, frames }\` — braces in a comment are not structure. */
    function pack(frames: Q[]): string { return JSON.stringify({ v: 2, frames }); }
  `;
  const b = (label, src, wantOk) => {
    const problems = compareCase('self', batchCase, batchDecl, src);
    if ((problems.length === 0) !== wantOk) {
      throw new Error(`drift self-test (${label}): got ${JSON.stringify(problems)}`);
    }
  };
  b('batch unmodified', batchSrc, true);
  b('batch key renamed', batchSrc.replace('{ v: 2, frames })', '{ v: 2, items: frames })'), false);
}

function main() {
  selfTest();

  const modulesDir = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : DEFAULT_MODULES_DIR;

  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const sources = new Map();
  const problems = [];

  for (const caseName of Object.keys(WIRE_DECLARATIONS)) {
    if (!(caseName in fixture.cases)) {
      problems.push(`${caseName}: declared here but absent from the fixture`);
    }
  }
  for (const [caseName, c] of Object.entries(fixture.cases)) {
    const decl = WIRE_DECLARATIONS[caseName];
    if (!decl) {
      problems.push(`${caseName}: fixture case has no Presence declaration mapped in this script`);
      continue;
    }
    const file = c.origin.split('/').pop();
    if (!sources.has(file)) {
      sources.set(file, readFileSync(join(modulesDir, file), 'utf8'));
    }
    try {
      problems.push(...compareCase(caseName, c, decl, sources.get(file)).map((p) => `${file}: ${p}`));
    } catch (e) {
      problems.push(`${file}: ${caseName}: ${e.message}`);
    }
  }

  if (problems.length > 0) {
    console.error(
      'signals-media wire drift: Presence\'s wire declarations and the package ' +
        'fixture disagree.\n'
    );
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      '\nEither the wire changed — in which case both copies must change ' +
        'together, and\n' +
        `${FIXTURE.replace(REPO_ROOT + '/', '')} is the record to update — or ` +
        'the declaration moved and this\nalarm needs re-pointing. Do not ' +
        'delete the check to make it pass.'
    );
    process.exit(1);
  }

  const checked = [...sources.keys()].join(', ');
  console.log(`signals-media wire fixture agrees with Presence (${checked})`);
}

main();
