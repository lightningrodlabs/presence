import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * `API.md` vs `src/index.ts` — the doc-vs-code check, in the shape of
 * `wire-fixture.test.ts`: read only files inside this package (no path
 * outside it, design spec decision 13), compare the two halves both ways,
 * and carry a negative control for each direction so a parser that silently
 * returns nothing cannot make either check pass vacuously.
 *
 * What it pins:
 *  - every name `src/index.ts` exports has a `### \`name\`` (or
 *    `#### \`name\``) section in `API.md`. Adding an export without
 *    documenting it fails here.
 *  - every bare-identifier heading in `API.md` names something `index.ts`
 *    exports, or is on the `./opus-wasm` allow-list below. Deleting or
 *    renaming an export while its section survives fails here.
 *
 * Member sections (`#### \`VoiceCarrier.startCapture()\``) are deliberately
 * NOT bare identifiers, so the reverse check skips them: the barrel is the
 * authority on the top-level surface only.
 */

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8');

const indexSource = read('../index.ts');
const apiDoc = read('../../API.md');

/**
 * The `./opus-wasm` subpath is a second entry point, deliberately absent
 * from the barrel so a host that never targets pre-Safari-26 WebKit never
 * pulls `libopus-wasm` (design spec decision 5b). `API.md` documents it as
 * part of the package's surface, so these two names have headings with no
 * `index.ts` export behind them.
 */
const SUBPATH_EXPORTS = ['wasmOpus', 'WASM_PENDING_MAX'];

/** `export { a, b as c } from '…'` and `export type { … } from '…'`. */
const RE_REEXPORT_LIST = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*['"]/g;

/** `export const X`, `export function X`, `export class X`, `export type X`… */
const RE_DIRECT_DECL =
  /^export\s+(?:declare\s+)?(?:const|let|var|async\s+function|function|class|abstract\s+class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

/** `### \`name\`` / `#### \`name\`` — a heading whose whole text is one identifier. */
const RE_IDENT_HEADING = /^#{3,4}\s+`([A-Za-z_$][\w$]*)`\s*$/gm;

function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(RE_REEXPORT_LIST)) {
    for (const raw of m[1].split(',')) {
      const spec = raw.trim().replace(/^type\s+/, '');
      if (spec === '') continue;
      // `a as b` publishes `b`.
      const renamed = /\sas\s+([A-Za-z_$][\w$]*)$/.exec(spec);
      names.add(renamed ? renamed[1] : spec);
    }
  }
  for (const m of source.matchAll(RE_DIRECT_DECL)) names.add(m[1]);
  return [...names].sort();
}

function identHeadings(md: string): string[] {
  return [...md.matchAll(RE_IDENT_HEADING)].map(m => m[1]);
}

/** Exports with no section. */
function undocumented(md: string, exports: readonly string[]): string[] {
  const headings = new Set(identHeadings(md));
  return exports.filter(name => !headings.has(name));
}

/** Sections naming nothing the package exports. */
function unbacked(md: string, exports: readonly string[]): string[] {
  const known = new Set([...exports, ...SUBPATH_EXPORTS]);
  return identHeadings(md).filter(name => !known.has(name));
}

const exports = exportedNames(indexSource);

describe('API.md documents the public barrel', () => {
  it('parses a plausible export list out of index.ts', () => {
    // Sentinels across every export form the barrel uses: a class, a value
    // re-export, a const, a type-only re-export. Without this, a parser
    // returning [] would make the forward check pass on an empty API.md.
    expect(exports).toEqual(
      expect.arrayContaining([
        'VoiceCarrier',
        'FilmstripCarrier',
        'decideSignalsMediaCadence',
        'VOICE_BATCH_FRAMES',
        'PeerId',
        'FilmstripPlaybackSinks',
      ])
    );
  });

  it('every exported name has a section in API.md', () => {
    expect(undocumented(apiDoc, exports)).toEqual([]);
  });

  it('negative control: a deleted section is reported as undocumented', () => {
    const withoutOne = apiDoc.replace('### `VoiceCarrier`', '### VoiceCarrier');
    expect(withoutOne).not.toBe(apiDoc);
    expect(undocumented(withoutOne, exports)).toEqual(['VoiceCarrier']);
  });

  it('every documented symbol is exported (or is a ./opus-wasm export)', () => {
    expect(unbacked(apiDoc, exports)).toEqual([]);
  });

  it('negative control: a section for a non-export is reported', () => {
    const withBogus = `${apiDoc}\n### \`notExportedAnywhere\`\n`;
    expect(unbacked(withBogus, exports)).toEqual(['notExportedAnywhere']);
  });
});
