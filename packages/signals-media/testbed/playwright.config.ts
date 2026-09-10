/**
 * Chromium gate for @lightningrodlabs/signals-media.
 *
 * What it is for: the vitest suites run against fakes — a manual clock, a
 * fake host, no real encoder. This runs the SAME carriers against a real
 * WebCodecs Opus encoder/decoder, a real AudioWorklet, a real OffscreenCanvas
 * JPEG encode in a real Worker, and a real WebSocket relay between two pages.
 * Working agreement 7: passing unit tests bound what the suite can see, never
 * what an engine can do.
 *
 * The devices are Chromium's fakes (`--use-fake-device-for-media-stream`
 * gives a synthetic moving camera and a silent mic), so voice level assertions
 * ride the page's `?tone=1` oscillator path instead of the mic.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.TESTBED_UI_PORT ?? 5710);

export default defineConfig({
  testDir: '.',
  testMatch: /testbed\.spec\.ts/,
  // Real media pipelines: generous per-test time, but no parallelism —
  // the pages compete for CPU and the fps assertions are rate assertions.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: {
    // `npm run dev` fires `predev`, which builds the package — the testbed
    // consumes `dist/`, never `src/` (controller ruling R11).
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
