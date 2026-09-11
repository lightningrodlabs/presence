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
import { createRequire } from 'node:module';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)); // …/testbed/ui
const pkgRoot = path.resolve(here, '../..'); // …/packages/signals-media (or the standalone repo root)
const testbedRoot = path.resolve(here, '..'); // …/testbed

// R19: no path here may assume a parent monorepo — `server.fs.allow` used to
// hard-code four `..` segments up to "the monorepo root", which broke a
// standalone checkout (the extraction rehearsal caught it: nothing four
// levels above a standalone repo is meaningful). Derive the allow-list from
// actual module resolution instead, so it is correct in both layouts.
// `libopus-wasm` is the `./opus-wasm` backend's optionalDependency and may be
// hoisted to a monorepo root's node_modules OR installed directly under this
// package — resolve wherever it actually landed rather than assuming either.
const require = createRequire(import.meta.url);
let libopusWasmDir;
try {
  libopusWasmDir = path.dirname(
    require.resolve('libopus-wasm/package.json', { paths: [pkgRoot] }),
  );
} catch {
  // Optional dependency not installed on this platform (e.g. the wasm
  // backend's postinstall was skipped) — nothing extra to allow.
  libopusWasmDir = undefined;
}
const fsAllow = [pkgRoot, testbedRoot, ...(libopusWasmDir ? [libopusWasmDir] : [])];

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
    // dist/ lives outside the Vite root, and libopus-wasm's install location
    // varies by layout (monorepo-hoisted vs. package-local) — both have to
    // be servable in dev. See the fsAllow derivation above (R19).
    fs: { allow: fsAllow },
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
