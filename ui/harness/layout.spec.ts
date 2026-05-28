import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRID_MIN_TILE_WIDTH } from '../src/room/layout';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Layout invariants, checked against the real room CSS + column math via the
 * standalone harness. Produces three artifacts for a tight feedback loop:
 *   1. stdout table of every (scenario × invariant) pass/fail  -> the LLM signal
 *   2. harness/__results__/summary.md                          -> same, persisted
 *   3. harness/__screenshots__/*.png                           -> the human signal
 * The test fails iff any invariant is violated, and the failure message names
 * the scenario, invariant, and the offending measurement.
 */

type Mode = 'grid' | 'split';

interface Viewport {
  name: string;
  width: number;
  height: number;
}

const VIEWPORTS: Viewport[] = [
  { name: 'square', width: 720, height: 720 },
  { name: 'wide-short', width: 1400, height: 460 },
  { name: 'narrow-tall', width: 460, height: 1040 },
];

const SHAPES = ['circle', 'rect'] as const;
const COUNTS = [2, 3, 5];

interface Scenario {
  mode: Mode;
  shape: (typeof SHAPES)[number];
  n: number;
  vp: Viewport;
}

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const mode of ['grid', 'split'] as Mode[]) {
    for (const shape of SHAPES) {
      for (const n of COUNTS) {
        for (const vp of VIEWPORTS) {
          out.push({ mode, shape, n, vp });
        }
      }
    }
  }
  return out;
}

function id(s: Scenario): string {
  return `${s.mode}_${s.shape}_n${s.n}_${s.vp.name}`;
}

// Geometry shapes mirror layout-harness.ts.
interface PaneReport {
  role: string;
  clientW: number;
  clientH: number;
  scrollW: number;
  scrollH: number;
  scrollbar: boolean;
}
interface TileReport {
  index: number;
  pane: string;
  role: string;
  expectAspect: number;
  width: number;
  height: number;
  aspect: number;
  overflow: number;
  windowOverflow: number;
}
interface HarnessReport {
  mode: Mode;
  shape: string;
  n: number;
  shares: number;
  cols: number;
  rows: number;
  measuredW: number;
  measuredH: number;
  panes: PaneReport[];
  tiles: TileReport[];
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const OVERFLOW_TOL = 1.5; // px
const ASPECT_TOL = 0.1; // relative
const FLOOR_TOL = 2; // px

function evaluate(r: HarnessReport): Check[] {
  const checks: Check[] = [];

  // 1. No tile overflows its immediate pane.
  const worstOverflow = Math.max(0, ...r.tiles.map((t) => t.overflow));
  checks.push({
    name: 'no-overflow',
    ok: worstOverflow <= OVERFLOW_TOL,
    detail: `worst tile overflow ${worstOverflow.toFixed(1)}px`,
  });

  // 1b. No tile spills past the visible WINDOW. This is the real invariant #1:
  //     tiles stay inside the window if they could be shrunk to fit. Catches
  //     the embedding bug where the pane itself grows with the tiles (so the
  //     per-pane check passes but the window still scrolls/clips).
  const worstWindow = Math.max(0, ...r.tiles.map((t) => t.windowOverflow));
  checks.push({
    name: 'within-window',
    ok: worstWindow <= OVERFLOW_TOL,
    detail: `worst window overflow ${worstWindow.toFixed(1)}px`,
  });

  // 2. Aspect ratio preserved per tile. Only people tiles have a fixed shape;
  //    screen-share tiles letterbox (aspect-ratio:auto) so are excluded.
  const people = r.tiles.filter((t) => t.role === 'person');
  const worstAspect = people.reduce((m, t) => {
    const rel = Math.abs(t.aspect - t.expectAspect) / t.expectAspect;
    return Math.max(m, rel);
  }, 0);
  checks.push({
    name: 'aspect-kept',
    ok: worstAspect <= ASPECT_TOL,
    detail: `worst people-aspect dev ${(worstAspect * 100).toFixed(0)}%`,
  });

  // 3. No scrollbar unless tiles are already at the min-size floor (i.e. they
  //    genuinely cannot shrink further to fit).
  const minTileW = Math.min(...r.tiles.map((t) => t.width));
  const atFloor = minTileW <= GRID_MIN_TILE_WIDTH + FLOOR_TOL;
  const scrollingPanes = r.panes.filter((p) => p.scrollbar).map((p) => p.role);
  checks.push({
    name: 'no-needless-scroll',
    ok: scrollingPanes.length === 0 || atFloor,
    detail: scrollingPanes.length
      ? `scroll in [${scrollingPanes.join(',')}], min tile ${minTileW.toFixed(0)}px (floor ${GRID_MIN_TILE_WIDTH})`
      : 'no scroll',
  });

  // 4. Tiles never rendered below the min-size floor.
  checks.push({
    name: 'above-floor',
    ok: minTileW >= GRID_MIN_TILE_WIDTH - FLOOR_TOL,
    detail: `min tile ${minTileW.toFixed(0)}px (floor ${GRID_MIN_TILE_WIDTH})`,
  });

  return checks;
}

interface Row {
  id: string;
  cols: number;
  rows: number;
  measured: string;
  checks: Check[];
}

const rows: Row[] = [];
const SHOTS = join(HERE, '__screenshots__');
const RESULTS = join(HERE, '__results__');

test('layout invariants across viewport / shape / count / mode', async ({
  page,
}) => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(RESULTS, { recursive: true });

  for (const s of scenarios()) {
    await page.setViewportSize({ width: s.vp.width, height: s.vp.height });
    const url = `/harness/layout-harness.html?mode=${s.mode}&shape=${s.shape}&n=${s.n}`;
    await page.goto(url);
    await page.waitForFunction(() => !!(window as any).harness);

    const report = await page.evaluate(() => {
      const h = (window as any).harness;
      h.relayout();
      return h.measure();
    });

    const checks = evaluate(report as HarnessReport);
    rows.push({
      id: id(s),
      cols: report.cols,
      rows: report.rows,
      measured: `${Math.round(report.measuredW)}x${Math.round(report.measuredH)}`,
      checks,
    });

    await page.screenshot({ path: join(SHOTS, `${id(s)}.png`) });
  }

  // ---- Emit the table (stdout + markdown) ----
  const invariantNames = rows[0].checks.map((c) => c.name);
  const header = ['scenario', 'grid', 'measured(WxH)', ...invariantNames];
  const lines: string[] = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  let failures = 0;
  for (const r of rows) {
    const cells = [
      r.id,
      `${r.cols}x${r.rows}`,
      r.measured,
      ...r.checks.map((c) => {
        if (!c.ok) failures += 1;
        return c.ok ? 'pass' : `FAIL (${c.detail})`;
      }),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  const md = lines.join('\n');
  // eslint-disable-next-line no-console
  console.log('\n' + md + '\n');
  writeFileSync(join(RESULTS, 'summary.md'), md + '\n');
  writeFileSync(
    join(RESULTS, 'summary.json'),
    JSON.stringify(rows, null, 2) + '\n'
  );

  // Surface every violation in the assertion message so one run tells the whole
  // story without re-reading screenshots.
  const violations = rows.flatMap((r) =>
    r.checks
      .filter((c) => !c.ok)
      .map((c) => `${r.id} (${r.cols}x${r.rows}) ${c.name}: ${c.detail}`)
  );
  expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  void failures;
});
