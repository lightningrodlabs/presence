import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    server: {
      deps: {
        // These ship ESM with extensionless relative imports that node's
        // resolver rejects; inlining lets vite resolve them. Only the
        // jsdom component suites import them — the node suites never hit
        // this list.
        inline: [
          /@holochain-open-dev\//,
          /@shoelace-style\//,
          /@theweave\//,
          /@holochain-syn\//,
        ],
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
});
