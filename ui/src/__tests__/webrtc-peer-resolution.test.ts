/**
 * Guard against the webrtc-peer dependency skew found in the 2026-08-25
 * field logs: `ui/package.json` pinned `^0.4.0` after the workspace
 * package had been bumped to 0.5.0, so npm installed registry 0.4.0
 * nested under `ui/node_modules/` — and every app build bundled that
 * copy instead of the workspace one. The connection-thrash library
 * fixes (session scoping, legal disconnected→failed, candidate dedupe,
 * retry backoff) shipped in source but never reached the field; the
 * 0.15.1 logs show all four missing behaviors, including a
 * `BLOCKED: disconnected retry limit reached` record that is impossible
 * under 0.5.0's transition table.
 *
 * `verify` typechecks against the built workspace package but nothing
 * asserted what the ui bundle actually RESOLVES (working agreement 5: a
 * gate that doesn't run isn't a gate). This test resolves the package
 * with real Node resolution from ui/src — the same algorithm Vite uses
 * for the build — and pins it to the workspace source of truth.
 */
import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);

/**
 * The package.json Node resolution finds for a bare specifier from this
 * file. `resolve.paths` returns the node_modules candidate directories in
 * Node's lookup order (nearest first — `ui/node_modules` before the repo
 * root's), so the first existing candidate is the copy every import from
 * ui/src gets. This deliberately sidesteps the package's `exports` map:
 * we want the winning package directory, not an entry point.
 */
function resolvedPackageJson(specifier: string): string {
  const candidates = nodeRequire.resolve.paths(specifier) ?? [];
  for (const dir of candidates) {
    const candidate = path.join(dir, specifier, 'package.json');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${specifier} not found from ${here}`);
}

describe('webrtc-peer resolution', () => {
  test('ui resolves the workspace @lightningrodlabs/webrtc-peer, same version as packages/webrtc-peer', () => {
    const workspacePkgPath = path.resolve(
      here,
      '../../../packages/webrtc-peer/package.json',
    );
    const workspaceVersion = JSON.parse(
      readFileSync(workspacePkgPath, 'utf8'),
    ).version as string;

    const resolvedPkgPath = resolvedPackageJson(
      '@lightningrodlabs/webrtc-peer',
    );
    const resolvedVersion = JSON.parse(
      readFileSync(resolvedPkgPath, 'utf8'),
    ).version as string;

    // The invariant: what ui resolves IS the workspace version. A semver
    // range in ui/package.json that excludes the workspace version makes
    // npm nest a registry copy under ui/node_modules, which wins
    // resolution — that is the skew this test exists to catch.
    expect(resolvedVersion).toBe(workspaceVersion);

    // Pin the mechanism too: the resolved copy is the workspace link,
    // not a registry tarball that happens to match.
    expect(realpathSync(path.dirname(resolvedPkgPath))).toBe(
      realpathSync(path.dirname(workspacePkgPath)),
    );
  });
});
