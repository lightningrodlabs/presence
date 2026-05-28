import { test } from '@playwright/test';

// Throwaway diagnostic: is the live grid overflow caused by the room-view CSS
// chain itself, or by the embedding (unbounded host height in an iframe)?
// Compares a clean tab vs the harness inside iframes sized like an embedder.

const HARNESS_URL = '/harness/layout-harness.html?mode=grid&shape=circle&n=2';

async function dump(label: string, evalChain: () => Promise<any>) {
  const c = await evalChain();
  // eslint-disable-next-line no-console
  console.log(`\n[${label}]`, JSON.stringify(c, null, 2));
}

async function snapshot(page: any) {
  return page.evaluate(() => {
    const h = (window as any).harness;
    h.relayout();
    const r = h.measure();
    return {
      cols: r.cols,
      rows: r.rows,
      measuredW: r.measuredW,
      measuredH: r.measuredH,
      chain: r.chain,
      worstPaneOverflow: Math.max(0, ...r.tiles.map((t: any) => t.overflow)),
      worstWindowOverflow: Math.max(
        0,
        ...r.tiles.map((t: any) => t.windowOverflow)
      ),
      tile0: r.tiles[0] && {
        w: Math.round(r.tiles[0].width),
        h: Math.round(r.tiles[0].height),
      },
    };
  });
}

test('probe: bound vs unbound, and iframe embedding', async ({
  page,
  context,
}) => {
  // 0) Reproduce the live window exactly (1015x802, 2 circles) and report
  //    each tile's row position to see whether flex-wrap stacks them.
  await page.setViewportSize({ width: 1015, height: 802 });
  await page.goto(`${HARNESS_URL}&bound=viewport`);
  await page.waitForFunction(() => !!(window as any).harness);
  await dump('LIVE-REPRO 1015x802', async () =>
    page.evaluate(() => {
      const h = (window as any).harness;
      h.relayout();
      const r = h.measure();
      return {
        cols: r.cols,
        rows: r.rows,
        containerClientH: r.chain.containerClientH,
        containerScrollH: r.chain.containerScrollH,
        wrappedToRows: new Set(r.tiles.map((t: any) => Math.round(t.top))).size,
        tiles: r.tiles.map((t: any) => ({
          top: Math.round(t.top),
          left: Math.round(t.left),
          w: Math.round(t.width),
          h: Math.round(t.height),
        })),
      };
    })
  );

  // 0c) Centering: at n=3, cols=2, the third tile (alone in last row) should
  //     be centered between the columns above, not left-anchored.
  await page.setViewportSize({ width: 960, height: 1046 });
  await page.goto(HARNESS_URL.replace('n=2', 'n=3'));
  await page.waitForFunction(() => !!(window as any).harness);
  await dump('LAST-ROW-CENTERING n=3 960x1046', async () =>
    page.evaluate(() => {
      const h = (window as any).harness;
      h.relayout();
      const r = h.measure();
      const vpW = document.documentElement.clientWidth;
      const last = r.tiles[r.tiles.length - 1];
      return {
        cols: r.cols,
        rows: r.rows,
        // distance from last tile's left edge to vp left vs from its right
        // edge to vp right; centered means roughly equal.
        lastLeftGap: Math.round(last.left + 0), // pane-relative
        tiles: r.tiles.map((t: any) => ({
          top: Math.round(t.top),
          left: Math.round(t.left),
          w: Math.round(t.width),
          centerX: Math.round(t.left + t.width / 2),
        })),
        vpCenterX: Math.round(vpW / 2),
      };
    })
  );

  // 0d) Rectangle gap: tall window with 2 rect tiles. The row should hug the
  //     tile (max-content), not 1fr, so the inter-tile gap is small.
  await page.setViewportSize({ width: 495, height: 1006 });
  await page.goto(`${HARNESS_URL.replace('shape=circle', 'shape=rect')}`);
  await page.waitForFunction(() => !!(window as any).harness);
  await dump('RECT-GAP n=2 rect tall', async () =>
    page.evaluate(() => {
      const h = (window as any).harness;
      h.relayout();
      const r = h.measure();
      const t0 = r.tiles[0];
      const t1 = r.tiles[1];
      return {
        cols: r.cols,
        rows: r.rows,
        tile0: { top: Math.round(t0.top), h: Math.round(t0.height) },
        tile1: { top: Math.round(t1.top), h: Math.round(t1.height) },
        gapBetween: Math.round(t1.top - (t0.top + t0.height)),
      };
    })
  );

  // 0b) Same live window, but pin the scrollbar (live "stuck" state). If the
  //     tiles wrap here, the scrollbar-vs-container-query-width loop is shown.
  await page.setViewportSize({ width: 1015, height: 802 });
  await page.goto(`${HARNESS_URL}&forceScroll=1`);
  await page.waitForFunction(() => !!(window as any).harness);
  await dump('LIVE-REPRO forceScroll 1015x802', async () =>
    page.evaluate(() => {
      const h = (window as any).harness;
      h.relayout();
      const r = h.measure();
      return {
        cols: r.cols,
        rows: r.rows,
        containerClientH: r.chain.containerClientH,
        containerScrollH: r.chain.containerScrollH,
        wrappedToRows: new Set(r.tiles.map((t: any) => Math.round(t.top))).size,
        tiles: r.tiles.map((t: any) => ({
          top: Math.round(t.top),
          left: Math.round(t.left),
          w: Math.round(t.width),
        })),
      };
    })
  );

  await page.setViewportSize({ width: 780, height: 880 });

  // 1a) Bounded (top-level document): the control.
  await page.goto(`${HARNESS_URL}&bound=viewport`);
  await page.waitForFunction(() => !!(window as any).harness);
  await dump('bound=viewport 780x880', () => snapshot(page));

  // 1b) Unbounded height chain (contain:size collapses to the floor).
  await page.goto(`${HARNESS_URL}&bound=content`);
  await page.waitForFunction(() => !!(window as any).harness);
  await dump('bound=content 780x880', () => snapshot(page));

  // 1c) Host taller than the visible window (iframe over-reports 100vh) — the
  //     live overflow mode: cqh too big -> tiles too big -> window scrolls.
  await page.goto(`${HARNESS_URL}&vh=1400`);
  await page.waitForFunction(() => !!(window as any).harness);
  await dump('vh=1400 (window 880)', () => snapshot(page));

  // 2) Harness inside a *content-resizing* iframe (same-origin embed page) —
  //    the shape a seamless embedder (Weave/launcher) produces: host sets the
  //    iframe height to the inner scrollHeight, so 100vh/cqh feed back.
  const outer = await context.newPage();
  await outer.setViewportSize({ width: 780, height: 880 });
  await outer.goto('/harness/iframe-embed.html?inner=mode=grid%26shape=circle%26n=2');
  await outer.waitForFunction(() => {
    const f = document.getElementById('f') as HTMLIFrameElement;
    return !!(f?.contentWindow as any)?.harness;
  });
  // let the resize feedback loop settle
  await outer.waitForTimeout(1000);
  await dump('iframe(auto-resize) 780x880', async () =>
    outer.evaluate(() => {
      const f = document.getElementById('f') as HTMLIFrameElement;
      const w = f.contentWindow as any;
      w.harness.relayout();
      const r = w.harness.measure();
      return {
        iframeRectH: Math.round(f.getBoundingClientRect().height),
        outerViewportH: document.documentElement.clientHeight,
        cols: r.cols,
        rows: r.rows,
        measuredH: r.measuredH,
        chain: r.chain,
        worstOverflow: Math.max(0, ...r.tiles.map((t: any) => t.overflow)),
        tile0: r.tiles[0] && {
          w: Math.round(r.tiles[0].width),
          h: Math.round(r.tiles[0].height),
        },
      };
    })
  );
  void context;
});
