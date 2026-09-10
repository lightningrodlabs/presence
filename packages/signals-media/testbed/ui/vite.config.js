// Vite config for the testbed page.
//
// Controller ruling R11: the testbed consumes the package's BUILT `dist/`,
// never `../src`. That is the whole point of this file — `dist/` is what a
// consumer installs, it is where `scripts/gen-inline-sources.mjs` has written
// the REAL inline worker/worklet sources (a source checkout only has the
// stub), and it is the tree whose `new URL('./voice-capture-worklet.js',
// import.meta.url)` / `new Worker(new URL('./filmstrip-worker.js', …))`
// resolution we are actually trying to falsify under a bundler. The
// `predev`/`prebuild`/`pretest` hooks in ../package.json run the package
// build first, so the alias target always exists and is current.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)); // …/testbed/ui
const pkgRoot = path.resolve(here, '../..'); // …/packages/signals-media
const repoRoot = path.resolve(here, '../../../..'); // monorepo root

export default defineConfig({
  resolve: {
    alias: [
      // Order matters: the subpath alias must be tried before the bare one.
      {
        find: /^@lightningrodlabs\/signals-media\/opus-wasm$/,
        replacement: path.join(pkgRoot, 'dist/opus-wasm.js'),
      },
      {
        find: /^@lightningrodlabs\/signals-media$/,
        replacement: path.join(pkgRoot, 'dist/index.js'),
      },
    ],
  },
  server: {
    // dist/ lives outside the Vite root, and `libopus-wasm` (the ./opus-wasm
    // backend's dependency) is hoisted to the monorepo's root node_modules.
    // Both have to be servable in dev.
    fs: { allow: [repoRoot] },
  },
  optimizeDeps: {
    // The package's own dist is source we want Vite to transform in place
    // (so the `new URL(…, import.meta.url)` asset references are rewritten),
    // not prebundled behind an opaque chunk.
    exclude: ['@lightningrodlabs/signals-media'],
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
