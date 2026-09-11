# signals-media docs

The design record for this package. Everything here travels with the directory,
so a `git subtree split` carries the reasoning along with the code (design spec
decision 13).

| Document | What it holds |
|---|---|
| [`design.md`](design.md) | The extraction design spec: the host seam, the substitution table against Presence's two controllers, every decision with its landed / landed-with-amendment / not-landed marker, the declared limitations and what is out of scope. A copy — the Presence monorepo holds the authoritative original until extraction (see its header). |
| [`webkitgtk-probe/FINDINGS.md`](webkitgtk-probe/FINDINGS.md) | Why there is no WebRTC on WebKitGTK 2.52 (compiled out, in both nixpkgs and Ubuntu 24.04), and what the capture path needs at runtime: GStreamer plugins base/good/**bad**/pipewire, the `permission-request` handler, the media-stream settings. `main.rs` and `probe.js` beside it are the probe that produced it. |
| [`../testbed/README.md`](../testbed/README.md) | The operational document: how to run the testbed on Linux, Android, Chromium, macOS, iOS and Windows, the platform plumbing each one needs, and the measured results with dates and versions. |
| [`../CHANGELOG.md`](../CHANGELOG.md) | What shipped in each version, what was copied from Presence, and what changed from it. |

Package-local reference that is not prose:

- `../src/types.ts` — the host interfaces. Types are the authority; this index
  and everything beside it is prose and rots. Read the file.
- `../src/__tests__/fixtures/wire.json` — the wire format, recorded
  byte-for-byte. `wire-fixture.test.ts` is what keeps it honest.

## Extraction rehearsal

**2026-09-10.** Rehearsed splitting this directory out of the Presence
monorepo into its own repo, twice.

First pass (`git subtree split` tip `28f3e1b4`, 16-commit standalone
history) found a real defect: `testbed/` resolved
`@lightningrodlabs/signals-media` only through the monorepo's hoisted root
`node_modules` symlink — `testbed/package.json` declared no dependency on
the package, and `testbed/ui/vite.config.js` computed
`repoRoot = path.resolve(here, '../../../..')` ("monorepo root") for
`server.fs.allow`. Standalone, `npm run test:browser`'s `pretest` typecheck
failed with `TS2307: Cannot find module '@lightningrodlabs/signals-media'`
before Playwright ever launched — install, typecheck, unit tests (146/146),
build, and `npm pack --dry-run` all passed standalone regardless (see
below), only the testbed/browser leg was broken.

Fix (R19, commit `35c712a`, package-only): `testbed/package.json` gained
`"dependencies": { "@lightningrodlabs/signals-media": "file:.." }` (npm
links `testbed/node_modules/@lightningrodlabs/signals-media` to the package
root in either layout, so `tsc` resolves it via `types`/`exports` without
relying on hoisting); `testbed/ui/vite.config.js`'s `server.fs.allow` no
longer assumes a fixed monorepo depth — it derives the package root, the
testbed root, and wherever `libopus-wasm` (an optionalDependency of the
package) actually resolved from, via `createRequire(...).resolve(...)`.
The Vite aliases to `../../dist/*.js` (R11 — the testbed always consumes the
built `dist/`, never `../src`) were left unchanged; the `file:` dependency
is for type resolution and any bare import, not the runtime path. Verified
as a regression check in the monorepo layout before re-rehearsing: `npm run
test:browser` (all 6 Playwright specs) and `npm run verify` (924 unit tests
+ three typechecks + the drift alarm) both green.

Second pass, from the new HEAD (`git subtree split` tip `7f521b6d`,
17-commit standalone history — mixed-commit scan re-run clean at 23
commits, `mixed=0`). Ran fully standalone, in the scratch tree's own flake,
with no monorepo access:

- `npm install` (no lockfile existed for the package inside the monorepo —
  R18 — so this generated one; resolves exactly `typescript` 5.9.3,
  `vitest` 1.6.1, `libopus-wasm` 0.3.0, 126 lockfile entries, nothing
  unexpected) — **passed**
- `npm --prefix testbed install` (testbed already carries its own
  committed lockfile; this creates the `file:..` symlink) — **passed**
- `npm run typecheck` — **passed**
- `npm run test` (146/146 tests, 15 files) — **passed**
- `npm run build` — **passed**
- `npm pack --dry-run` (76 files, 81.1 kB packed, byte-identical shasum to
  the first pass) — **passed**
- `npm run test:browser` (Playwright, Chromium, `DISPLAY=:1`) — **passed**,
  all 6 specs green, including the two cross-backend (wasm ⇄ WebCodecs)
  Opus tests — this is the leg the first pass's defect broke.

The split-history leak check (paths outside the package leaking into a
split commit) had one false positive on the first pass from an
over-broad pattern: `scripts/gen-inline-sources.mjs` matched the
`^ scripts/` alternative, but that is the package's own
`scripts/` subdirectory (post-split, its paths are package-relative), not a
leaked monorepo-root `scripts/`. The check is now:
```
git log --stat --oneline <split-branch> \
  | grep -v '^[0-9a-f]\{7\} ' \
  | grep -vE '^ [0-9]+ files? changed' \
  | grep -E '^ (\.\./|ui/|docs/superpowers|\.github/workflows/nightly)'
```
(dropped the `scripts/` alternative) — clean (no output) on both passes.

Cleanup: the scratch tree and the local `signals-media-standalone` branch
were deleted after each pass.

**2026-09-10 (re-run after a review finding).** An adversarial review of the
R19 fix above (fix round 1 of 5) raised one Important finding against
`testbed/ui/vite.config.js:231-239`: the `libopusWasmDir` derivation was
dead code. `require.resolve('libopus-wasm/package.json', { paths: [pkgRoot]
})` unconditionally threw `ERR_PACKAGE_PATH_NOT_EXPORTED` — the installed
`libopus-wasm@0.3.0`'s `exports` map declares only `"."` and `"./discordjs"`,
no `"./package.json"` — so the try/catch's "present" branch could never be
taken, on any platform, and the `✨ new dependencies optimized: libopus-wasm`
Vite log line cited as evidence in the prior write-up was esbuild
pre-bundling, unrelated to `server.fs.allow`.

Fix (commit `2f35860`, package-only). The review's suggested literal
replacement — `require.resolve('libopus-wasm', { paths: [pkgRoot] })`, i.e.
the `"."` export — was tried first and **also throws**, with a different
message (`No "exports" main defined…`, still `ERR_PACKAGE_PATH_NOT_EXPORTED`),
verified directly against the same installed copy. The package's `"."`
export lists only the `types`/`browser`/`import` conditions; `require.resolve()`
(and `createRequire().resolve()`, which inherits it) always resolves under
the `require`/`node`/`default` condition set, and Node's public API has no
way to add `import` to that set for a plain `require.resolve()` call — an
ESM-only export map can never satisfy it, independent of this repo. The
committed fix instead walks `node_modules` directories directly (the phase
of Node's own resolution algorithm that runs *before* a package's `exports`
map is ever consulted): starting at `pkgRoot`, check
`<dir>/node_modules/libopus-wasm/package.json`; if absent, go to the parent
directory; repeat, bounded by the filesystem root. This answers exactly the
question the file needs ("where is the libopus-wasm directory"), not "what
file would importing it load", so it is unaffected by whatever the package's
`exports` map says. The config now `console.log`s the resolved directory
once at load (or `console.warn`s once if not found) — verified live in both
layouts:

- **Monorepo layout:** `[signals-media testbed] libopus-wasm resolved at
  <worktree>/node_modules/libopus-wasm` — the repo-root, hoisted location,
  confirmed both by direct `node --input-type=module -e "import(...)"` of
  the config file and by the line appearing in `npm run test:browser`'s
  Vite dev-server output.
- **Standalone layout (rehearsal, below):** `[signals-media testbed]
  libopus-wasm resolved at <scratch-tree>/node_modules/libopus-wasm` — one
  level up from the package root, since in this layout the package root
  *is* the repo root.

Monorepo regression check before re-rehearsing: `nix develop -c npm run
test:browser` (package devshell, all 6 Playwright specs green) and `nix
develop -c npm run verify` from the worktree root (924 unit tests + three
clean typechecks + the drift alarm) — both green.

Third pass, from the new HEAD (`git subtree split` tip `f5676ed4`,
19-commit standalone history — mixed-commit scan re-run clean at 25
commits, `mixed=0`; the tightened leak-grep from the second pass, unchanged,
still clean). Ran fully standalone, no monorepo access: `npm install`
(same resolution as before: `typescript` 5.9.3, `vitest` 1.6.1,
`libopus-wasm` 0.3.0, 126 lockfile entries) — **passed**; `npm --prefix
testbed install` — **passed**; `npm run typecheck` — **passed**; `npm run
test` (146/146) — **passed**; `npm run build` — **passed**; `npm pack
--dry-run` (76 files, 81.1 kB, shasum byte-identical to both prior passes —
the fix touches only `testbed/`, which isn't packed) — **passed**; `npm run
test:browser` (Playwright, Chromium, `DISPLAY=:1`) — **passed**, all 6
specs green, with the `libopus-wasm resolved at
<scratch>/node_modules/libopus-wasm` line present in the Vite dev-server
log, confirming the fix resolves correctly standalone too, not just in the
monorepo.

Cleanup: the scratch tree and the local `signals-media-standalone` branch
were deleted after this pass as well.

**Consequence for the real extraction:** no lockfile exists for this package
inside the monorepo (the root workspace lockfile covers it), so each rehearsal
pass generated one with `npm install` and threw it away with the scratch tree.
The extracted repository's first commit must add the lockfile that `npm
install` generates — the package's own `.github/workflows/verify.yaml` runs
`npm ci`, which fails outright without one.
