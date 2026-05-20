import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests run headless in Node — RTCPeerConnection is injected as a mock
    // via the `createPeerConnection` factory, so no DOM environment is needed.
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
