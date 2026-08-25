#!/usr/bin/env node
/**
 * Release-artifact gate. Enforces the invariant that broke v0.15.2's
 * auto-update (2026-08-25): Moss offers a curated version as an
 * IN-PLACE update only when its happ bundle bytes are unchanged from
 * the installed version — a point release must therefore package the
 * byte-identical previous happ (build with `npm run package:ui`, never
 * a full `npm run package`, which recompiles the zomes and changes the
 * happ bytes even when dnas/ source is untouched). The invariant held
 * from 0.14.8 through 0.15.1 by convention only; v0.15.2's first asset
 * violated it and shipped as a "separate install" in Moss until
 * replaced. This script is the convention made a gate.
 *
 * Modes (keyed on whether fixtures/releases.json has an entry for the
 * CURRENT ui version):
 *  - entry exists  -> verify workdir artifacts match the recorded
 *                     hashes (post-release / reproducibility check).
 *  - entry missing -> preparing a release: the built happ must equal
 *                     the newest recorded happSha256, unless
 *                     HAPP_CHANGE=1 declares a deliberate happ/DNA
 *                     change (which forfeits Moss in-place updates and,
 *                     if integrity zomes changed, splits the network —
 *                     say so in the release notes).
 *
 * Run: node scripts/check-release-artifacts.mjs   (or npm run release:check)
 * Ceremony: docs/RELEASING.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const fail = (msg) => { console.error(`release:check FAIL — ${msg}`); process.exit(1); };
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const releases = JSON.parse(readFileSync('fixtures/releases.json', 'utf8'));
const uiVersion = JSON.parse(readFileSync('ui/package.json', 'utf8')).version;

if (!existsSync('workdir/presence.happ')) {
  fail('workdir/presence.happ missing — build first (npm run package:ui for a point release)');
}
const happ = sha256('workdir/presence.happ');
const entry = releases.find((r) => r.version === uiVersion);

if (entry) {
  if (happ !== entry.hashes.happSha256) {
    fail(`workdir/presence.happ (${happ.slice(0, 12)}…) does not match the recorded ` +
      `happSha256 for released ${uiVersion} (${entry.hashes.happSha256.slice(0, 12)}…)`);
  }
  if (existsSync('workdir/presence.webhapp')) {
    const webhapp = sha256('workdir/presence.webhapp');
    if (webhapp !== entry.hashes.webhappSha256) {
      fail(`workdir/presence.webhapp (${webhapp.slice(0, 12)}…) does not match the recorded ` +
        `webhappSha256 for released ${uiVersion} (${entry.hashes.webhappSha256.slice(0, 12)}…)`);
    }
  }
  console.log(`release:check OK — workdir artifacts match the recorded ${uiVersion} release`);
} else {
  const prev = releases[releases.length - 1];
  if (happ === prev.hashes.happSha256) {
    console.log(`release:check OK — happ bytes identical to ${prev.version}; ` +
      `Moss will offer ${uiVersion} as an in-place update`);
  } else if (process.env.HAPP_CHANGE === '1') {
    console.log(`release:check OK (HAPP_CHANGE declared) — happ differs from ${prev.version}; ` +
      'NO in-place update in Moss; declare the consequence in the release notes ' +
      '(and check `hc dna hash` if integrity zomes changed — a changed DNA hash splits the network)');
  } else {
    fail(`built happ (${happ.slice(0, 12)}…) differs from ${prev.version}'s ` +
      `(${prev.hashes.happSha256.slice(0, 12)}…). A point release must reuse the previous happ ` +
      'bytes or Moss shows it as a separate install. Rebuild with `npm run package:ui` against ' +
      'the released .dna/.happ (recover them from the previous release asset if needed), ' +
      'or set HAPP_CHANGE=1 to declare a deliberate happ change.');
  }
}
