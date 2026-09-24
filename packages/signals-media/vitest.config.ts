import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests run headless in Node — the browser surfaces (AudioWorklet,
    // WebCodecs, canvas) are reached through the injected host seam, so no
    // DOM environment is needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclude test fixtures and the public-export barrel from the report —
      // index.ts is `export ... from` lines that test files don't import
      // through, so v8 always marks it 0%.
      exclude: ['src/__tests__/**', 'src/index.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
