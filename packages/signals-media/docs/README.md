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
