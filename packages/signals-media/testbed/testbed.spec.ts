/**
 * The Chromium gate. See playwright.config.ts for what it is for.
 *
 * Every assertion here reads the page's own `window.__testbed` surface
 * (`ui/testbed.js`), which is a thin projection of the carriers' public maps
 * — `peerLastRecvMs`, `peerAudioLevels`, `voiceRxStats`, and the paint counts
 * of the `FilmstripPlayback` sinks. Nothing reaches into carrier internals.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// The automation surface has ONE declaration, shared with the page that
// writes it (`ui/testbed.js`). This import also pulls in that file's
// `declare global`, which is what types `window.__testbed` below. A local
// re-declaration here would be a second copy of the same contract, checked
// against nothing on the writing side.
import type { TestbedStats } from './ui/testbed-globals.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------
let relay: ChildProcess;
let relayPort: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

test.beforeAll(async () => {
  relayPort = await freePort();
  relay = spawn(process.execPath, [path.join(here, 'relay.mjs')], {
    cwd: here,
    env: { ...process.env, PORT: String(relayPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error('relay did not start')), 10_000);
    relay.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('relay on ws://')) {
        clearTimeout(fail);
        resolve();
      }
    });
    relay.once('exit', code => {
      clearTimeout(fail);
      reject(new Error(`relay exited with ${code}`));
    });
  });
});

test.afterAll(async () => {
  relay?.kill();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const stats = (p: Page) => p.evaluate(() => window.__testbed.stats());

async function open(
  page: Page,
  query: Record<string, string | number>
): Promise<void> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))
  ).toString();
  await page.goto(`/?${qs}`);
  await page.waitForFunction(() => !!window.__testbed?.stats, null, { timeout: 20_000 });
  // ?auto=1 clicks Start after 500 ms; `started` flips inside that handler.
  await page.waitForFunction(() => window.__testbed.stats().started, null, {
    timeout: 20_000,
  });
}

function roomQuery(peer: string, extra: Record<string, string | number> = {}) {
  return {
    mode: 'room',
    auto: 1,
    tone: 1,
    peer,
    relay: `ws://127.0.0.1:${relayPort}`,
    // Long enough that the page's own end-of-run evaluation never fires
    // mid-test; these tests do their own asserting.
    duration: 600,
    ...extra,
  };
}

/** Wait until `f(stats)` holds, polling the page. */
async function until(
  page: Page,
  f: (s: TestbedStats) => boolean,
  timeoutMs: number,
  what: string
): Promise<TestbedStats> {
  const deadline = Date.now() + timeoutMs;
  let last = await stats(page);
  while (Date.now() < deadline) {
    last = await stats(page);
    if (f(last)) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}; last stats: ${JSON.stringify(last)}`);
}

const decoderErrors = (s: TestbedStats) =>
  s.consoleErrors.filter(e => /decod/i.test(e));

// ---------------------------------------------------------------------------
// 1. Selftest: encode → wire → admission → decode → paint, in one page
// ---------------------------------------------------------------------------
test('selftest: voice round-trips and the filmstrip paints', async ({ page }) => {
  await open(page, { mode: 'selftest', auto: 1, tone: 1, duration: 6 });
  await page.waitForFunction(() => window.__testbed.done, null, { timeout: 60_000 });

  const results = await page.evaluate(() => window.__testbed.results);
  const failed = Object.entries(results).filter(([, r]) => !r.ok);
  expect(
    failed.map(([step, r]) => `${step}: ${r.detail}`).join('\n')
  ).toBe('');
  // Guard against a page that reported nothing and "passed" vacuously.
  expect(Object.keys(results)).toEqual(
    expect.arrayContaining([
      'voice.roundTrip',
      'voice.loss',
      'filmstrip.painted',
      'voice.level',
    ])
  );
});

// ---------------------------------------------------------------------------
// 2. Two pages in a room: both directions, then restart and carrier switch
// ---------------------------------------------------------------------------
test.describe.serial('room', () => {
  let a: Page;
  let b: Page;

  test.beforeAll(async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    a = await ctxA.newPage();
    b = await ctxB.newPage();
    await open(a, roomQuery('a'));
    await open(b, roomQuery('b'));
  });

  test.afterAll(async () => {
    await a?.context().close();
    await b?.context().close();
  });

  test('voice and video flow in both directions', async () => {
    // Assert on a fixed 8 s of running, NOT on "poll until it passes": an
    // fps figure taken the moment it first crosses the bar is a two-sample
    // rate, and a poll-until-true loop cannot fail for the right reason.
    const ran = (s: TestbedStats) => s.uptimeMs >= 8000;
    await until(b, ran, 30_000, 'b to run for 8 s');
    await until(a, ran, 30_000, 'a to run for 8 s');
    const sb = await stats(b);
    const sa = await stats(a);

    expect(sb.voiceRecvPeers).toContain('a');
    expect(sa.voiceRecvPeers).toContain('b');
    // ~6 fps over 8 s: a rate measured across dozens of frames, not two.
    expect(sb.framesPainted.a ?? 0).toBeGreaterThanOrEqual(30);
    expect(sa.framesPainted.b ?? 0).toBeGreaterThanOrEqual(30);
    expect(sb.audioLevel.a).toBeGreaterThan(0.01);
    expect(sb.fpsIn.a).toBeGreaterThanOrEqual(5);
    expect(sa.audioLevel.b).toBeGreaterThan(0.01);
    expect(sa.fpsIn.b).toBeGreaterThanOrEqual(5);
    expect(decoderErrors(sb)).toEqual([]);
    expect(decoderErrors(sa)).toEqual([]);
  });

  test('a voice restart is admitted as a new session, and costs little', async () => {
    const before = await stats(b);
    const paintedBefore = before.framesPainted.a ?? 0;

    const cost = await a.evaluate(() => window.__testbed.restartVoice());
    expect(cost, 'restartVoice never sent a frame').not.toBeNull();
    test.info().annotations.push({
      type: 'restart-cost-ms',
      description: String(cost),
    });
    // eslint-disable-next-line no-console
    console.log(`[testbed] voice restart cost: ${cost} ms (stop+start to first packet sent)`);
    expect(cost!).toBeLessThan(2000);

    // The receiver must ADOPT the new session (`ep` bumped, `seq` back to 1)
    // rather than drop it against the old high-water mark.
    const after = await until(
      b,
      s => s.epochAdopts > before.epochAdopts,
      20_000,
      'b to adopt a new voice epoch from a'
    );
    expect(after.epochAdopts).toBeGreaterThan(before.epochAdopts);

    // Audio keeps arriving after the restart …
    await until(
      b,
      s => s.recvMs.a > after.recvMs.a,
      15_000,
      'b to keep receiving voice from a after the restart'
    );
    // … and video never stopped (filmstrip capture was untouched).
    const painting = await until(
      b,
      s => (s.framesPainted.a ?? 0) > paintedBefore + 5,
      15_000,
      'b to keep painting a'
    );
    expect(decoderErrors(painting)).toEqual([]);
  });

  test('dropping a from the target set stops voice, and re-adding resumes it', async () => {
    // Models the host handing this link to WebRTC and taking it back: the
    // carrier reads `host.targets()` at every encode, so an empty set is the
    // whole mechanism.
    expect(await a.evaluate(() => window.__testbed.setTargets([]))).toEqual([]);

    // Within one jitter-buffer's worth, b's receive stamp must stop moving.
    await new Promise(r => setTimeout(r, 500));
    const s1 = await stats(b);
    await new Promise(r => setTimeout(r, 400));
    const s2 = await stats(b);
    expect(
      s2.recvMs.a,
      'b kept receiving voice from a after a dropped it from targets'
    ).toBe(s1.recvMs.a);

    await new Promise(r => setTimeout(r, 3000));
    const stalled = await stats(b);
    expect(stalled.recvMs.a).toBe(s1.recvMs.a);

    expect(await a.evaluate(() => window.__testbed.setTargets(['b']))).toEqual(['b']);
    const resumed = await until(
      b,
      s => s.recvMs.a > s1.recvMs.a,
      20_000,
      'b to resume receiving voice from a'
    );
    // Controller ruling R13: the task brief's "resumes with an adopted epoch"
    // was mis-specified — a target-set change never stops capture, so
    // `VoiceCarrier`'s epoch is unchanged and the resumed frames carry the SAME
    // `ep` with a continuing `seq`; admission takes them with no session
    // adoption and no decoder reset, and an adoption here would be a bug.
    expect(resumed.epochAdopts).toBe(stalled.epochAdopts);
    expect(decoderErrors(resumed)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-backend Opus: the WASM encoder must be decodable by WebCodecs and
//    the other way round. Same wire format, two implementations.
// ---------------------------------------------------------------------------
for (const [senderCodec, receiverCodec] of [
  ['wasm', 'webcodecs'],
  ['webcodecs', 'wasm'],
] as const) {
  test(`cross-backend Opus: ${senderCodec} sender → ${receiverCodec} receiver`, async ({
    browser,
  }) => {
    const tag = `${senderCodec}-${receiverCodec}`;
    const ctxS = await browser.newContext();
    const ctxR = await browser.newContext();
    const sender = await ctxS.newPage();
    const receiver = await ctxR.newPage();
    try {
      await open(sender, roomQuery(`s-${tag}`, { codec: senderCodec }));
      await open(receiver, roomQuery(`r-${tag}`, { codec: receiverCodec }));

      const s = await until(
        receiver,
        st => (st.audioLevel[`s-${tag}`] ?? 0) > 0.01,
        45_000,
        `${receiverCodec} receiver to hear the ${senderCodec} sender`
      );
      expect(s.audioLevel[`s-${tag}`]).toBeGreaterThan(0.01);
      expect(decoderErrors(s)).toEqual([]);
    } finally {
      await ctxS.close();
      await ctxR.close();
    }
  });
}
