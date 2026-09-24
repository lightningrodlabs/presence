import { test, expect } from '@playwright/test';

/**
 * Real-Chromium tier of the system-audio mixin (spec Section 4). Drives the
 * PRODUCTION `MicSource` against Chromium's fake microphone with an
 * oscillator standing in for the host seam's capture track, and reads the
 * OUTPUT track back through a real MediaStreamTrackProcessor and an
 * AudioEncoder configured as `voice.ts` configures its own. This is the
 * path `mic-source-mixin.test.ts`'s fake context cannot see: the whole-
 * branch review's Critical (a stereo destination into a mono encoder) lived
 * exactly here, and the negative control below reproduces it.
 *
 * Requires WebCodecs Opus + Web Audio + fake media devices (Chromium; see
 * playwright.config.ts launch args). Run with:
 *   npm run test:harness -w ui
 */

type Reading = { frames: number; channels: number; sampleRate: number; rms: number; tone: number };
type RunResult = {
  ok: boolean;
  error?: string;
  deviceOnly: Reading;
  mixed: Reading;
  mixedEncoder: { chunks: number; errors: string[] };
  torn: Reading;
  stereoControl: { channels: number; encoder: { chunks: number; errors: string[] } };
};

test.beforeEach(async ({ page }) => {
  await page.goto('/harness/system-audio-mix-harness.html');
  await page.waitForFunction(() => typeof (window as any).runSystemAudioMix === 'function');
});

test('the mixed output is mono 48 kHz, carries the mixin, feeds the voice encoder, and tears back clean', async ({ page }) => {
  const r: RunResult = await page.evaluate(() => (window as any).runSystemAudioMix({ frames: 50 }));
  expect(r.error).toBeUndefined();
  expect(r.ok).toBe(true);

  // What the voice encoder is configured for (voice.ts): one channel at 48 kHz.
  expect(r.mixed.channels).toBe(1);
  expect(r.mixed.sampleRate).toBe(48000);
  expect(r.mixed.frames).toBe(50);

  // The mixin is audible in the output: energy at the oscillator's
  // frequency well above the fake microphone alone, and gone again after
  // the tear. (Relative, so the fake device's own content does not matter.)
  expect(r.mixed.rms).toBeGreaterThan(0);
  expect(r.mixed.tone).toBeGreaterThan(r.deviceOnly.tone * 20 + 1e-9);
  expect(r.torn.tone).toBeLessThan(r.mixed.tone / 20);

  // The signals carrier: the voice module's own encoder config accepts the
  // output and produces Opus, with no encoder error.
  expect(r.mixedEncoder.errors).toEqual([]);
  expect(r.mixedEncoder.chunks).toBeGreaterThan(0);
});

test('negative control: a destination at the stereo default is what the mono encoder rejects (the bug as shipped)', async ({ page }) => {
  const r: RunResult = await page.evaluate(() => (window as any).runSystemAudioMix({ frames: 50 }));
  expect(r.error).toBeUndefined();
  // Web Audio's default: two channels on the destination's track.
  expect(r.stereoControl.channels).toBe(2);
  // …and the voice encoder config does not take it: an error, and no
  // usable Opus stream. If this ever passes stereo through, the Critical's
  // premise is gone and the mono pin becomes hygiene, not a fix.
  expect(r.stereoControl.encoder.errors.length).toBeGreaterThan(0);
});
