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
