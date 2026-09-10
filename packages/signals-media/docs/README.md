# signals-media docs

Index of the design record for this package. The spec and the WebKitGTK
media-probe findings are copied in at Task 7 of the extraction plan; until
then they live in the Presence repository at the paths below.

| Document | Location today | What it holds |
|---|---|---|
| Extraction design spec | `docs/superpowers/specs/2026-09-08-signals-media-extraction-design.md` (Presence) | The host seam, the substitution table, the decisions (including 5b codec seam and 13 self-containment), declared limitations, scope |
| Implementation plan | `docs/superpowers/plans/2026-09-08-signals-media-extraction.md` (Presence) | The task briefs, in order |
| WebKitGTK media probe | `spikes/webkitgtk-media-probe/` (Presence) | Why there is no WebRTC on WebKitGTK 2.52 and what the signals carrier needs at runtime (GStreamer plugins base/good/bad, pipewire) |

Package-local reference that is already here:

- `../src/types.ts` — the host interfaces. Types are the authority; this
  index is prose and rots. Read the file.
