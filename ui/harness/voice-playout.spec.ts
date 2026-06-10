import { test, expect } from '@playwright/test';

/**
 * Browser tier of the Symptom B harness
 * (docs/SIGNALS_DOUBLE_AUDIO_INVESTIGATION.md). Drives a REAL
 * AudioEncoder→AudioDecoder→AudioContext through the production `decidePlayout`
 * and asserts on the recorded playback schedule. This is what confirms (or
 * kills) the assumption the unit harness can't: that a real decoder racing
 * through a backlog drives the head past the drift cap.
 *
 * Requires WebCodecs Opus + AudioContext (Chromium). Run with:
 *   npm run test:layout   (Playwright; serves the harness via Vite on :5599)
 */

type RunResult = {
  mode: string;
  ok: boolean;
  error?: string;
  intervals: [number, number][];
  reasons: string[];
  drops: number;
  played: number;
  hasOverlap: boolean;
};

async function runMode(page: import('@playwright/test').Page, mode: string, frames = 60): Promise<RunResult> {
  return page.evaluate(
    ([m, f]) => (window as any).runVoicePlayout({ mode: m, frames: f }),
    [mode, frames] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/harness/voice-playout-harness.html');
  await page.waitForFunction(() => typeof (window as any).runVoicePlayout === 'function');
});

test('real decoder, real-time arrival: no drops, no overlap', async ({ page }) => {
  const r = await runMode(page, 'realtime', 40);
  test.skip(!r.ok, `harness unavailable: ${r.error}`);
  expect(r.played).toBeGreaterThan(0);
  expect(r.drops).toBe(0);
  expect(r.hasOverlap).toBe(false);
});

test('real decoder, burst arrival: trips overcap-drop and never overlaps (fix holds)', async ({ page }) => {
  const r = await runMode(page, 'burst', 80);
  test.skip(!r.ok, `harness unavailable: ${r.error}`);
  // The load-bearing assumption: a real decoder handed a backlog races ahead of
  // the audio clock, so the head passes the drift cap and frames are shed.
  expect(r.drops).toBeGreaterThan(0);
  // …and the production scheduler never schedules overlapping audio.
  expect(r.hasOverlap).toBe(false);
});

test('real decoder, burst arrival, LEGACY scheduler: overlaps (reproduces the bug)', async ({ page }) => {
  const r = await runMode(page, 'burst-legacy', 80);
  test.skip(!r.ok, `harness unavailable: ${r.error}`);
  // The pre-fix snap-back, against the same real decoder, schedules audio on top
  // of itself. If this does NOT overlap, the burst assumption failed to
  // reproduce (decoder paced output) — investigate before trusting the fix.
  expect(r.hasOverlap).toBe(true);
});
