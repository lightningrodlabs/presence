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
import fs from 'node:fs';
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
//
// Review round 2 finding: the round-1 fix (`require.resolve('libopus-wasm',
// { paths: [pkgRoot] })`, i.e. the "." export) still throws
// ERR_PACKAGE_PATH_NOT_EXPORTED ("No 'exports' main defined…") — verified
// directly against the installed libopus-wasm@0.3.0. Its "." export lists
// only the `types`/`browser`/`import` conditions; `require.resolve()` (which
// `createRequire()` inherits) always resolves under the `require`/`node`/
// `default` condition set and Node's public API gives no way to override
// that, so an ESM-only export map can never satisfy it — not a bug in the
// package, just a condition mismatch this file's resolver can't cross.
// Fix: don't ask Node to resolve an entry FILE through `exports` at all —
// walk `node_modules` directories directly, which is how Node locates a
// package's directory in the first place, before it ever consults that
// package's own `exports` map. This is exports-map-agnostic (works
// regardless of what libopus-wasm exports, or whether it exports anything),
// and answers exactly the question this file needs ("where is the
// libopus-wasm directory on disk"), not "what file does importing it load".
function findPackageDir(pkgName, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkgName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // bounded: stop at the filesystem root
    dir = parent;
  }
}

const libopusWasmDir = findPackageDir('libopus-wasm', pkgRoot);
if (libopusWasmDir) {
  // eslint-disable-next-line no-console -- visible at config load, not a runtime path
  console.log(`[signals-media testbed] libopus-wasm resolved at ${libopusWasmDir}`);
} else {
  // Optional dependency not installed on this platform (e.g. the wasm
  // backend's postinstall was skipped) — nothing extra to allow. Visible,
  // not silent (review round 1).
  // eslint-disable-next-line no-console -- visible at config load, not a runtime path
  console.warn(
    '[signals-media testbed] libopus-wasm not found under any ancestor node_modules; omitting from server.fs.allow',
  );
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
