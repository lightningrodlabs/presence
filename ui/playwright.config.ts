import { defineConfig, devices } from '@playwright/test';

// Layout harness only. Spins up the Vite dev server on a fixed port and drives
// /harness/layout-harness.html at controlled viewport sizes.
const PORT = 5599;

export default defineConfig({
  testDir: './harness',
  testMatch: '**/*.spec.ts',
  outputDir: './harness/__results__',
  fullyParallel: false,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 800, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Force classic, space-stealing scrollbars (like Linux hc-spin) so the
        // forceScroll probe can reproduce the width-steal that broke flex-wrap.
        launchOptions: { args: ['--disable-features=OverlayScrollbar'] },
      },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --clearScreen false`,
    url: `http://localhost:${PORT}/harness/layout-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
