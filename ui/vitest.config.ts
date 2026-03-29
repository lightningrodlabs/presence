import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
  define: {
    '__APP_VERSION__': JSON.stringify('test'),
  },
});
