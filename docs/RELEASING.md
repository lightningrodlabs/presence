# Releasing

The ceremony, previously carried only in release commit messages ("Ceremony
per 0c47477"), written down after the v0.15.2 asset incident (2026-08-25).
The gate is `scripts/check-release-artifacts.mjs` (`npm run release:check`);
this document explains when to run it and why it exists — when this prose
and that script disagree, the script wins.

## The invariant that has teeth

**A point release packages the byte-identical previous happ.** Moss offers a
curated version as an *in-place update* only when its happ bundle bytes are
unchanged from the installed version; a changed happ shows up as a separate
install. The happ bytes were stable from 0.14.8 through 0.15.1 by convention;
v0.15.2's first asset broke it (a full `npm run package` recompiled the zomes —
different coordinator wasm, same DNA hash, different happ bytes) and appeared
in Moss as a new app until the asset was replaced. Consequence: a point
release must ship the previous happ bytes — and **`npm run package:ui` does
not guarantee that by itself**: its `hc web-app pack workdir --recursive`
re-packs the dna and happ from the on-disk wasm, so its happ matches the
shipped one only while the wasm does. The shipped happ has lagged source
since 0.15.1, so today it never does — the v0.15.3 build reproduced the
incident with a byte-correct happ already on disk (the gate caught it).
Recovery when `release:check` fails on a point release: recover the shipped
happ from the previous release asset (`hc web-app unpack`), copy it over
`workdir/presence.happ` (and its dna over
`dnas/presence/workdir/presence.dna` via `hc app unpack`), then re-pack with
`hc web-app pack workdir` — no `--recursive` — so the happ bytes are reused
as-is with the freshly built UI zip.

A deliberate happ/DNA release sets `HAPP_CHANGE=1` for the gate, forfeits
in-place updates, and — if integrity zomes changed — splits the network
(`hc dna hash` on old vs new is the check); both consequences go in the
release notes.

## Ceremony

1. Branch `release/X.Y.Z` off the trunk. Bump `ui/package.json` version;
   `npm install` to sync the lockfile.
2. Generate the wire-surface fixture:
   `UPDATE_COMPAT_FIXTURE=1 npx vitest run src/transport/__tests__/compat-corpus.test.ts`
   (from `ui/`). Diff the new `fixtures/compat/X.Y.Z.json` against the
   previous release's — any delta beyond version/provenance must be a
   declared wire change.
3. `nix develop -c npm run verify` — green, then commit the ceremony
   (version + lockfile + fixture), merge `--no-ff` into the trunk, tag
   `vX.Y.Z`.
4. Build: `npm run package:ui` (point release) or
   `HAPP_CHANGE=1` + `npm run package` (declared happ change).
5. **`npm run release:check`** — the artifact gate (see above). It compares
   `workdir/presence.happ` against `fixtures/releases.json`.
6. The hash triple. `npm run hash` (needs `ELECTRON_RUN_AS_NODE` unset —
   the weave CLI is Electron and that variable makes it run as plain node;
   if Electron aborts on `chrome-sandbox is not configured correctly`,
   `ELECTRON_DISABLE_SANDBOX=1` gets past it — a local sandbox-permission
   condition, not a property of the artifact) prints one, but **do not copy
   its `happSha256` blindly: the value is weave-CLI-version-dependent.**
   Observed on the v0.14.11 build: CLI 0.15.21 reported `a06213aa…` for the
   *shipped, unmodified* v0.14.10 asset, whose recorded (and curated)
   `happSha256` is `ae12f592…`; CLI 0.16.0-dev.5 on the 0.15.x line agrees
   with the recorded values (re-confirmed at v0.15.6). The `webhappSha256`
   and `uiSha256` agree across both CLIs.

   The line's records use **raw sha256 of the artifact and of the members
   extracted from it** — verify (and, on a disagreement, derive) that way:

       sha256sum workdir/presence.webhapp            # webhappSha256
       hc web-app unpack workdir/presence.webhapp -o /tmp/wh
       sha256sum /tmp/wh/presence.happ               # happSha256
       sha256sum /tmp/wh/dist.zip                    # uiSha256

   Consistency of basis WITHIN a line is what preserves in-place updates:
   Moss compares the candidate entry's `happSha256` against the installed
   version's entry, so recording a same-bytes happ under a different
   hashing basis fabricates a mismatch and splits the install exactly as a
   real happ change would.
7. Push trunk + tag. `gh release create vX.Y.Z workdir/presence.webhapp`
   with notes (Compatibility section first — DNA/network and interop
   claims, each backed by a check actually run). Re-download the asset and
   `sha256sum` it against `webhappSha256`.
8. Append the release's entry (version, url, hash triple, releasedAt from
   the `npm run hash` output) to `fixtures/releases.json` and commit — this
   is what arms the gate for the next release.
9. Curation: in `weave-tool-curation`, add the version entry (same hash
   triple, user-facing changelog) to the line's lists — for the 0.15.x /
   Holochain 0.7 line that is `0.16/lists/tool-list-0.16.json` AND
   `0.16/modify/tool-list-0.16.ts` — on a branch, as a PR.

## Interop claims checklist for the notes

- Same network: `hc dna hash` equal on old vs new (not "the dnas/ diff was
  empty" — the wasm is a build artifact).
- In-place update: `happSha256` equal to the previous entry (the gate),
  on the same hashing basis — see step 6. The gate compares the standalone
  `workdir/presence.happ`; what Moss sees is the happ INSIDE the webhapp,
  so on any doubt extract and compare that (`hc web-app unpack` on the new
  artifact and on the previous release asset).
- Wire surface: the compat fixture diff from step 2.
