# Harnesses

Browser-real test rigs for the parts of the app the vitest mocks cannot
reproduce. The rigs living here:

- **Carrier handover** (`carrier-handover-harness.*`, `carrier-handover.spec.ts`)
  — Phase 1.5's field harness. Two pages, each an agent running the
  production `FsmTransport`/`ConnectionManager` over a **real
  RTCPeerConnection** (loopback ICE + DTLS), signaling relayed over a
  `BroadcastChannel` with Holochain's fire-and-forget semantics. The spec
  establishes a link, silently kills one side (page close — no goodbye on
  the wire; CDP network emulation does not touch WebRTC's UDP sockets, so
  this is the honest flap), and asserts the carrier-coverage invariant in
  both directions plus the declared recovery-window exception. The slot
  rules are shared code (`decideSlotWrite`, executed by store and harness
  alike); the fidelity statement and the one modeled seam (the dispatch
  glue) are in the harness file header. Runs nightly
  (`.github/workflows/nightly-harness.yaml`) via `npm run test:harness`.
- **Voice playout** (`voice-playout-harness.*`, `voice-playout.spec.ts`) —
  real-WebCodecs tier of the Symptom B investigation; see its header.
  Also in the nightly gate.
- **Screen share** (`screen-share-harness.*`, `screen-share.spec.ts`) —
  Phase 3.5, filing the Phase 3 review's F4 gap. Each page runs BOTH
  production screen-share FSM transports (sharer + viewer roles) over
  real RTCPeerConnections, signaling in the production `SdpFsmScreen`
  envelope (dir-tagged) over a `BroadcastChannel`; the share source is a
  real `canvas.captureStream` video track. Asserts lazy viewer-side
  establishment (no reservation handshake), role-routing under mutual
  share with zero drops, the malformed-`dir` drop path
  (`decideScreenSignalRoute`, executed not mirrored), and slot + the peer
  record's `screenShareStream` teardown on a silent peer drop through the
  production recovery phases. Also in the nightly gate.
- **Layout** (below) — NOT in any gate yet: its split-mode baseline is red
  by design; it joins the nightly gate when split-mode is unified onto the
  grid model.

# Layout harness

A tight feedback loop for the video-tile layout, runnable outside the
Holochain/Weave iframe so changes can be *seen* and *measured* directly instead
of relayed by hand.

## Why it exists

The room view has two tile-layout paths (see `src/room/room-view.ts`):

- **grid** (`.auto-grid`, no screen share): JS `bestColumns()` picks a column
  count; CSS sizes tiles in `cqw/cqh`. Principled — aspect kept, min-size floor,
  no overflow.
- **split** (`.split-mode`, screen share active): per-count classes
  (`single`/`double`/…/`unlimited`) drive sizing. Count-driven, not
  aspect-driven — the source of the squash/overflow bugs.

The harness renders both with the **real** styles and the **real** column math,
nested in the **real ancestor chain** so the height constraint is faithful:

    <presence-app host>          PresenceApp.styles  (:host height:100vh; column)
      <div.room-container host>  RoomContainer.styles (.room-container flex:1)
        <room-view host>         RoomView.styles      (:host flex:1; column)
          .videos-container ...

Each layer is a real shadow host with the component's actual adopted
stylesheets, so a broken height chain breaks here too. The only fakes are leaf
tiles and the absence of Holochain. `bestColumns` and the `document`-based
measurement match the live `_updateGrid` exactly (the `measured(WxH)` column in
the report shows the dimensions fed to the math).

## Run

```sh
nix develop -c npm run test:layout   -w ui     # headless, writes table + screenshots
```

Or browse a single scenario interactively:

```sh
nix develop -c npm run harness -w ui
# then open http://localhost:5599/harness/layout-harness.html?mode=grid&shape=circle&n=5
```

### URL params

| param  | values               | default  | meaning                          |
|--------|----------------------|----------|----------------------------------|
| mode   | `grid` \| `split`    | grid     | split = screen share present     |
| shape  | `circle` \| `rect`   | circle   | rect = 16:9 (`square-view`)      |
| n      | integer              | 2        | people-tile count                |
| shares | integer              | 1        | screen-share count (split only)  |
| split  | 0–100                | 50       | split ratio %  (split only)      |
| bound  | `viewport`\|`content`| viewport | `content` drops the 100vh bound (host height becomes content-driven) |
| vh     | px                   | —        | force host height to N px (simulate an embedder reporting 100vh ≠ visible pane) |

`bound`/`vh` reproduce the **embedding** failure modes (see below); leave them
unset for normal layout testing.

In the console: `harness.measure()` returns the geometry report;
`harness.relayout()` re-runs the column math after a resize.

## Outputs (the feedback)

- **stdout + `__results__/summary.md`** — one row per scenario, pass/FAIL per
  invariant with the offending measurement. This is the primary signal: an
  agent edits the layout, re-runs, and reads exactly what broke.
- **`__screenshots__/*.png`** — one per scenario, for eyeballing.
- The test fails iff any invariant is violated; the assertion message lists
  every violation.

## Invariants checked

1. `no-overflow` — no tile extends past its immediate pane.
2. `within-window` — no tile spills past the visible window. This is the real
   invariant #1: in the live overflow the pane grows *with* the tiles, so the
   per-pane check (#1) passes while the window still scrolls. #2 is what catches
   that.
3. `aspect-kept` — people tiles hold their shape (1:1 circle, 16:9 rect).
   Screen-share tiles letterbox, so they are excluded.
4. `no-needless-scroll` — a pane only scrolls if tiles are already at the
   `GRID_MIN_TILE_WIDTH` floor (can't shrink further).
5. `above-floor` — tiles never render below the floor.

## Known baseline (current code)

`grid` passes every scenario in a correctly-bounded window; `split` fails
across the board (the target for unifying the two paths onto the grid model).

### The live grid overflow is an embedding bug, not a layout-math bug

The grid math and tile CSS are correct: for any bounded, accurately-measured
window — including the tall, 1-column-stacked case from the bug screenshot —
tiles scale to `50cqh` and fit. The live overflow needs the container's `cqh`
basis to exceed the visible window. The harness reproduces both ways that
happens in the nested iframe (run `npx playwright test _probe` to see the dump):

- `vh=1400` (window 880): host height > visible window → tiles 645px →
  **425px window overflow** = the live screenshot (oversized circle, clipped
  second tile, scrollbar). The per-pane check sees nothing; `within-window`
  catches it.
- `bound=content`: with no height bound, `container-type: size` *collapses* the
  grid to the toolbar strip and tiles drop to the 60px floor (a different,
  also-bad mode).

Fix direction: ensure `.videos-container`'s height tracks the *visible* pane
(don't let the embedder's `100vh`/`clientHeight` over-report drive `cqh`), e.g.
size tiles against a measured visible height or clamp the grid to the window.
One real measurement from the live app (log `documentElement.clientHeight`,
`.videos-container` client/scrollHeight, chosen cols, tile px in `_updateGrid`)
will confirm which over-report is happening.
