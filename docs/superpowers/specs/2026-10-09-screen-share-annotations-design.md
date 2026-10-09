# Share annotations: design spec

Written 2026-10-09. Built on `main-0.7` at `cf7084f` (the v0.16.0 release), branch `feat/screen-share-annotations`. The plan is `docs/superpowers/plans/2026-10-09-screen-share-annotations.md`.

Status: design approved in conversation. Not landed.

## Problem

A participant who watches a share cannot point at anything on it. The only way to say "this button" is to describe it in words. Reactions (`ui/src/room/modules/reactions.ts`) let a participant place an emoji on their own tile. Nothing lets anyone draw on a share tile, and nothing a participant draws reaches the other screens.

## Goals

- Any participant, the sharer included, can draw freehand strokes on a share tile in a chosen color.
- This works on every share-type module: the screen share and the shared asset (`wal`), and any share module added later.
- Every participant, the sharer included, sees every author's strokes on that tile, at the same place on the shared content.
- A stroke stays until its author removes it, the sharer clears the board, or the share stops. A participant who joins late sees the strokes that exist.
- The feature uses the signals path and adds no WebRTC traffic.

## Decisions

The decisions below were made in conversation on 2026-10-09.

1. Authors and audience: everyone draws, everyone sees all strokes.
2. Lifetime: until cleared. No fade.
3. Tools: a freehand pen and a color palette of eight. No shapes, no text, no eraser.
4. Delivery: when the pen lifts, the stroke is sent once. Nothing is streamed while the pen moves.
5. State ownership (approach A below): each author owns their strokes and broadcasts them as their own module state. The sharer owns only a clear epoch.
6. Scope: the overlay mounts on every share tile. A share module declares only how to find its drawing surface.

### Approaches considered

Approach A, author-owned state. Each author's strokes travel in that author's `ModuleState` envelope for a new module, `annotations`. This is how a participant's reactions travel today. The share tile reads every author's envelope and draws the union. Every pong carries the envelope again (`PongMetaDataV1.moduleStates`). A lost signal is therefore repaired within `PING_INTERVAL`, and a late joiner gets the board from the first pong. No author writes another author's state, so the last-writer-wins merge in `ui/src/module-state-policy.ts` has no conflicts. The cost is that every author's payload rides every pong, so the payload must be bounded. Chosen.

Approach B, sharer-owned state. Authors send strokes to the sharer as `ModuleData`. The sharer folds them into its share payload and rebroadcasts. One authority and a trivial clear-all. But every stroke takes two hops, and a lost `ModuleData` signal loses the stroke with no repair. The sharer's pong also grows with every author's strokes. Rejected.

Approach C, `ModuleData` only. Strokes stream and nobody keeps state. A late joiner sees nothing and a lost signal loses a stroke. Rejected by decision 2.

## Wire format

No new signal type and no new capability. The module rides `ModuleState` (`ui/src/transport/wire-contract.ts`, `requiresCap: null`), so the wire-contract snapshot does not change. The module id is `annotations`.

The `annotations` payload:

```ts
/** The author's boards, keyed by sharer and then by share module id. */
interface AnnotationsPayload {
  v: 1;
  boards: Record<AgentPubKeyB64, Record<string, AnnotationBoard>>;
}

interface AnnotationBoard {
  strokes: AnnotationStroke[];
}

interface AnnotationStroke {
  /** Unique within this author's board. */
  id: string;
  /** The share's `annotationsEpoch` the stroke was drawn under. */
  epoch: number;
  /** Index into ANNOTATION_PALETTE. */
  color: number;
  /** Flat [x0, y0, x1, y1, ...], integers on the 0..ANNOTATION_GRID grid. */
  pts: number[];
}
```

A board belongs to one share tile. The tile is identified by the sharer's public key and the share module id, for example `screen-share` or `wal`. A sharer can run two share modules at once, and each tile keeps its own board.

Every share-type module payload gains one field:

```ts
interface ShareAnnotationsEpoch {
  /** Clock stamp on the sharer's clock. A new value empties the board everywhere. */
  annotationsEpoch?: number;
}
```

### The drawing surface

A share module declares where its strokes land:

```ts
/** Where annotation strokes land on this module's share tile. Default 'tile'. */
annotationSurface?: 'tile' | 'contained-video';
```

With `'tile'`, the surface is the tile's content box. The shared asset uses this default. With `'contained-video'`, the surface is the rectangle the video image occupies inside the tile under `object-fit: contain` (`room-view.ts`, `.video-container.screen-share .video-el`). The screen share declares this. Every screen letterboxes the same share differently. A tile fraction therefore lands a mark on different pixels on each screen, and the video surface does not.

An asset tile reflows its embedded content to its own size on each screen. A mark over an asset lands at the same fraction of the tile on every screen, which can be a different part of the content. This is a declared limit of the `'tile'` surface. A later round can add a surface kind for an embed that reports its own content box.

### Coordinates

A stroke point is a pair of integers on a square grid of `ANNOTATION_GRID` (10000) units across the surface. The grid is square, so `x` and `y` are independent fractions of the surface width and height.

### Bounds

Three named constants in `ui/src/room/annotation-policy.ts` bound the payload. They serve the pong payload size, which is a wire cost, and are declared NOT-liveness (working agreement 2). Starting values:

- `MAX_STROKE_POINTS` (200): a stroke longer than this is cut at its tail.
- `MAX_BOARD_STROKES` (50): an author's board drops its oldest stroke to make room.
- `MAX_ANNOTATIONS_PAYLOAD_BYTES` (12288): the serialized payload drops the oldest stroke of the largest board until it fits.

On pen-up, the author thins the stroke. A point closer than `MIN_POINT_SPACING` (40 grid units) to the previous kept point is dropped. The last point is always kept. A circle or an underline then costs about 30 to 60 points, or 300 to 600 bytes.

Every pong carries the full payload to every peer. At the byte cap and five peers, that is about 30 kbps of upstream pong traffic. This is the recorded cost of approach A. The trigger for a digest-and-fetch design is a field export that shows pong size as a cause of signal delay.

### Validation on receive

A remote stroke is input from another machine. `parseAnnotationsPayload` (`annotation-policy.ts`) drops a stroke that breaks any of these rules:

- `pts` is an even-length array of integers in `0..ANNOTATION_GRID`.
- `pts` holds at most `MAX_STROKE_POINTS` points.
- `color` is a palette index.
- `epoch` is a finite number.

A board with no valid strokes is dropped. If `v` is not 1, the whole payload is dropped. This follows the clip-geometry rule R20 in `docs/superpowers/specs/2026-09-08-signals-media-extraction-design.md`.

## Clearing

An author's undo-last and clear-mine are state writes of the author's own board through `StreamsStore.updateModuleState('annotations', ...)`.

The sharer's clear-all is an epoch. When `StreamsStore.activateModule` activates a share-type module whose payload is a JSON object, it stamps `annotationsEpoch` into that payload. The stamp comes from the store's injected clock. This is one generic site. The shared asset's `parseSharedWalPayload` reads only its own fields and tolerates the extra one. A new store method, `clearShareAnnotations(shareModuleId)`, merges a new stamp into that module's current payload and broadcasts it.

A stroke carries the epoch it was drawn under. The overlay renders only strokes whose epoch equals the share's current epoch. `readShareAnnotationsEpoch` (`annotation-policy.ts`) reads it from the sharer's share envelope. One signal from the sharer therefore empties the board on every screen. A share restart does the same, because activation mints a new epoch.

Authors prune at their next write. `pruneBoards` (`annotation-policy.ts`) drops strokes whose epoch is behind the share's current epoch. It also drops boards whose share is not active. A stale board is bounded by the byte cap until then.

A sharer on a build before this round sends no `annotationsEpoch`. The overlay reads a missing epoch as 0. Authors on new builds then draw with epoch 0 and see each other's strokes. That sharer cannot clear them, and a restart of that share does not empty the board. This is the declared interop. A peer on a build before this round registers no `annotations` module, so `getModule` finds nothing, and the envelope is stored and ignored. This matches the transcription module's interop case.

## Rendering

### Two new module aspects

`ModuleDefinition` (`ui/src/room/modules/types.ts`) gains:

```ts
/**
 * An element mounted into every share tile, on top of the share content.
 * It receives `.sharerPubKeyB64`, `.shareModuleId` and `.context` as
 * properties.
 */
shareOverlayElement?: string;

/** Where annotation strokes land on this module's share tile. Default 'tile'. */
annotationSurface?: 'tile' | 'contained-video';
```

`renderSharedPanel` (`room-view.ts`) mounts every registered module's `shareOverlayElement` into each share tile. The overlay goes after the share content and the diagnostics overlay and before the maximize icon, so the icon stays on top. The existing `overlayElement` aspect is unchanged and keeps rendering on agent tiles only. The `annotations` module declares no `overlayElement`. Agent tiles therefore do not change, and the receiver-switch dropdown in `room-view.ts`, which keys on `overlayElement`, does not see the new module.

### The overlay element

`module-annotations-share-overlay` (`ui/src/room/modules/annotations.ts`) is a Lit element. It subscribes to `_myModuleStates` and `_peerModuleStates` on the store. It aggregates every author's board for its tile through `visibleStrokes` (`annotation-policy.ts`), which applies the epoch filter. It draws the strokes as SVG polylines in an `<svg viewBox="0 0 10000 10000" preserveAspectRatio="none">` positioned over the surface.

The surface comes from `surfaceBox` (`ui/src/room/annotation-geometry.ts`), a pure function. For `'tile'`, the surface is the element's own box. For `'contained-video'`, it is `containedVideoBox(tileWidth, tileHeight, videoWidth, videoHeight)`, also pure. The element finds the one `<video>` in its share frame (`this.parentElement`) and reads `videoWidth` and `videoHeight`. It re-runs the function on the video's `loadedmetadata` and `resize` events and on a `ResizeObserver` on itself. Until a video surface has metadata, the pen is disabled and nothing is drawn. A tile surface is always ready.

Pointer input uses pointer events, so mouse, touch and pen all work. The element converts a pointer position to grid units with `toGrid` (`annotation-geometry.ts`) and keeps the in-progress points locally. On `pointerup`, it thins the points and builds the stroke with the share's current epoch and the chosen color. It then writes the board through `applyStroke` and `updateModuleState`. A stroke of fewer than two points is dropped.

The stroke id is the author's clock stamp and a per-element counter. It needs to be unique only within the author's own board.

### The tool strip

A small strip in the bottom-left corner of the tile, rendered by the overlay element:

- Pen on or off.
- The palette of eight colors, `ANNOTATION_PALETTE` (`annotation-policy.ts`). The default is `defaultColorFor(myPubKeyB64)`, a palette index from the pubkey, so two authors usually differ.
- Undo my last stroke.
- Clear mine.
- Clear all. When `context.isMe` is true, the tile is the sharer's own, and only then is this control rendered.

Pen state and color are local element state. The tile `repeat()` key keeps the element alive across re-renders, so the state survives a re-render. When the tile is recreated, the state resets.

With the pen off, the host is `pointer-events: none` and the strip is `pointer-events: auto`. Double-click to maximize, the reconnect button and the asset embed's own controls keep working. With the pen on, the host captures pointer events and sets `touch-action: none`. It also stops `dblclick`, so a fast double stroke does not maximize the tile. An asset tile holds an iframe. With the pen on, the overlay sits above the iframe and receives the events instead.

### Activation

`room-view.ts` activates the module at join beside `reactions`. The module has no toolbar button, no state icons and no agent-tile overlay.

## Signals and the back-pressure spec

A stroke write is one `ModuleState` broadcast. `docs/superpowers/specs/2026-09-28-signals-backpressure-design.md` classes module state as control traffic that never goes through the media budget, and this spec keeps that. Stroke writes are bounded by hand speed, one per pen-up. Nothing is sent while the pen moves.

## Files

New:

- `ui/src/room/annotation-policy.ts`: the payload types and the constants. Its functions are `parseAnnotationsPayload`, `readShareAnnotationsEpoch`, `applyStroke`, `undoLastStroke`, `clearMyBoard` and `pruneBoards`. It also holds `visibleStrokes`, `thinPoints`, `enforceBounds`, `defaultColorFor` and `ANNOTATION_PALETTE`.
- `ui/src/room/annotation-geometry.ts`: `ANNOTATION_GRID`, `surfaceBox`, `containedVideoBox`, `toGrid`.
- `ui/src/room/modules/annotations.ts`: the module definition and the overlay element.

Changed:

- `ui/src/room/modules/types.ts`: the `shareOverlayElement` and `annotationSurface` aspects.
- `ui/src/room/modules/screen-share.ts`: `annotationSurface: 'contained-video'`.
- `ui/src/room/modules/index.ts`: the registration import.
- `ui/src/streams-store.ts`: `activateModule` stamps the epoch on share-type modules, and `clearShareAnnotations`.
- `ui/src/room/room-view.ts`: `renderSharedPanel` mounts share overlays, and the join-time activation.

`ui/src/room/modules/wal.ts` does not change. It takes the default surface and the generic epoch stamp.

## Testing and enforcement

Pure policy tests, table-driven, no mocks:

- `ui/src/__tests__/annotation-geometry.test.ts`: a wide video in a tall tile, a tall video in a wide tile, an exact fit and a zero-size video. Also the tile surface, and the round trip from a pointer position to grid units and back.
- `ui/src/__tests__/annotation-policy.test.ts`: thinning keeps the first and last points and drops close ones. Each bound cuts what it names and nothing else. `applyStroke`, `undoLastStroke` and `clearMyBoard` are checked on full board objects with `toEqual`. `pruneBoards` drops stale epochs and inactive shares and keeps the rest, across two share modules of one sharer. `visibleStrokes` applies the epoch filter and reads a missing epoch as 0. `parseAnnotationsPayload` has one rejection row per rule and one acceptance row.

Render tests in jsdom, in the style of `ui/src/__tests__/intent-diff-surfaces.test.ts`:

- The strip renders clear-all only for the sharer.
- The host is `pointer-events: none` with the pen off and captures with the pen on.
- Strokes from two authors render as two polylines with their palette colors, and a stroke under a stale epoch does not render.
- The overlay mounts on a `wal` tile with the tile surface and on a `screen-share` tile with the video surface.

Wiring tests in `ui/src/__tests__/streams-store-wiring.test.ts`, driving real stores over the fake bus:

- A board write leaves the author as one `ModuleState` signal and lands in the peer's `_peerModuleStates`.
- A store that joins after the write gets the board from a pong.
- Activating a share-type module stamps `annotationsEpoch`, and activating an agent-type module does not.
- `clearShareAnnotations('screen-share')` writes the share payload with a newer epoch, and `visibleStrokes` over the resulting peer state is empty.

Teardown: `ui/src/__tests__/view-teardown-symmetry.test.ts` pins that the overlay element releases both store subscriptions, the `ResizeObserver` and the video listeners on disconnect.

The gate is `nix develop -c npm run verify`. No change to the wire-contract snapshot, the event taxonomy or the compat corpus.

A real drawing across two machines is a manual check, as conductor-level validation already is by declaration. It covers a letterboxed screen share on one machine and a shared asset.

## Declared behavior changes

- Share tiles gain a tool strip and can carry strokes.
- Every share-type module payload carries `annotationsEpoch`. A screen sharer's `ModuleState` envelope is no longer `{}`, and the asset share's payload gains a field.
- A participant's pong grows by the size of their annotations payload, up to `MAX_ANNOTATIONS_PAYLOAD_BYTES`.

## Out of scope

- Live preview of a stroke while the pen moves.
- Shapes, text, an eraser and per-stroke removal by clicking.
- Line width.
- Annotations over agent tiles.
- A surface kind for an embed that reports its own content box.
- A digest-and-fetch design to take strokes out of the pong. Trigger above.
- Persisting strokes past the share.

## Definition of done

- Every item in "Files" is landed and every test in "Testing and enforcement" is green under `verify`.
- The three bound constants and the thinning spacing are named in `annotation-policy.ts` with the NOT-liveness declaration.
- CLAUDE.md gets one fact bullet in the closing doc-sync commit, and `claude-md-drift.test.ts` stays green.
- When the branch closes, each numbered decision above carries a landed or not-landed marker.
