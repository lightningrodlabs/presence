# Plan: Generalized Module System for Agent Panes

## Status: In Progress

Core module system is implemented. Panes decoupled from WebRTC (driven by `_activeAgents`). Video is a proper activated module. Share-type modules implemented: WAL, screen-share, and countdown timer. Sharing panel is generalized.

## What's Built

### Module Infrastructure
- `ModuleDefinition` interface with aspects: overlay, replace, state icons, state data, stream
- Module registry with self-registration
- `ModuleState`/`ModuleData` signal handling in streams-store
- Pong metadata reconciliation for module states (compares payload content, not just timestamps)
- Module elements: optional Lit custom elements (`overlayElement`/`replaceElement`) for modules needing local state or independent re-render boundaries
- Module-switcher dropdown on peer panes for receiver-controlled view selection

### Modules
- **video**: State icons (mute indicator, relay indicator, reset media). Replace view (existing video/avatar/status).
- **raise-hand**: Overlay (hand icon with MDI numeric circle queue position). Replace (note view). Sender-activated. Toolbar button.
- **clock**: Lit custom element (`<module-clock-replace>`). Receiver-activated. Renders sender's timezone locally with 1-second tick. Auto-activated on room join.

### Pane Chrome Hierarchy
- **Universal chrome** (always present, module-independent):
  - Avatar/nickname
  - Maximize/minimize button
  - Module-switcher dropdown
  - Full reconnect button (tears down WebRTC, auto-recovers via ping/pong)
- **Module icon strip** (bottom of pane, above avatar):
  - Multi-state icons from all active modules
  - Icons support: indicator-only, onClick, menuItems (dropdown)
- **Module overlays** (positioned within pane)
- **Module replace content** (fills pane, clipped to shape via `.module-replace-content`)

### Reconnect Hierarchy
- **Full reconnect** (universal chrome, next to avatar): `disconnectFromPeerVideo()` -- destroys WebRTC peer, auto-recovers via next ping/pong cycle. Always visible when connected.
- **Reset media** (video module icon strip): `refreshTracksForPeer()` -- refreshes tracks without tearing down WebRTC. Visible when video is degraded.

## Remaining Work

### Plan: Share-type Module Abstraction

**Goal**: extract screen-share, WAL-embed, and a new countdown-timer share into share-type modules. Generalize the "shared panel" rendering so future shares require no room-view changes.

**Why now**: Screen-share alone is pure code rearrangement (~875 lines moved, ~150 lines of new abstraction, no LOC win). The abstraction earns its keep with **two or more consumers**. WAL is already a hand-coded second consumer in the same panel. Adding a simple timer share validates the design with a non-WebRTC, lifecycle-driven case. Together, the three justify the abstraction; future share types become a few-line module.

#### Three target consumers and their needs

| Concern | Screen Share | WAL Embed | Countdown Timer |
|---|---|---|---|
| Transport | WebRTC stream | Module state only | Module state only |
| State payload | `{ active: true }` (stream is local) | `{ weaveUrl, assetName, assetIconSrc }` | `{ endTimestamp }` |
| onActivate | `getUserMedia()` + InitRequest cycle | WAL picker | Prompt for duration |
| onDeactivate | `screenShareOff()` | Clear state | Clear state |
| Render | `<video>` with srcObject lookup | `<shared-wal-embed>` | Custom element with 1s tick + chime |
| Multiplicity | One per agent | One per agent | One per agent |

The common abstraction: a share is `(moduleId, agent, state)` rendered as a tile in a shared panel, plus optional lifecycle hooks for activation. Screen share's WebRTC stream lives outside module state — the module's `renderShare` resolves it from `streamsStore._screenShareStreams[agent]` at render time.

#### Module system extensions

New `ModuleDefinition` fields:
- `renderShare?(agentPubKeyB64, state, context)` — produces one tile, called for each `(active share-module, agent)` pair
- `shareElement?: string` — custom element variant (analogous to `overlayElement`/`replaceElement`), used for modules needing local state like the timer's tick loop

Reused (no changes needed):
- `defaultState`, `onActivate`, `onDeactivate` (already on ModuleDefinition)
- `renderToolbarButton` (already on ModuleDefinition)
- Module state propagation via signals + pong metadata (already wired)
- `_myModuleStates` / `_peerModuleStates` (already keyed correctly)

New room-view machinery:
- `_getActiveShares()`: returns `Array<{ moduleId, agentPubKeyB64, state, isMe }>` by enumerating share-type modules across all module states
- `renderSharedPanel()`: maps active shares to tiles via each module's `renderShare`/`shareElement`
- `splitMode = activeShares.length > 0 && !maximized` (replaces `hasScreenShares`)
- Maximize keying for shares: `share-${moduleId}-${pubkey}` (extends current `_maximizedVideo` string scheme)

#### Implementation phases

**Phase 1 — Share infrastructure (additive, no behavior change)**
- Add `renderShare`/`shareElement` to `ui/src/room/modules/types.ts`
- Add `_getActiveShares()` and `renderSharedPanel()` in `ui/src/room/room-view.ts`
- Compute `splitMode` from active shares (in addition to existing screen-share check, to keep current behavior during transition)
- Render the new shared panel container alongside the existing one — empty until phase 2

**Phase 2 — WAL share module (smallest, validates the abstraction)**
- New file `ui/src/room/modules/wal.ts` with type `'share'`
- `onActivate`: WAL picker logic moved from room-view
- `renderShare`: `<shared-wal-embed>` with payload from module state
- Migrate WAL state from `_mySharedWal`/`_peerSharedWals` → module state
- Late-joiner propagation already works via existing `moduleStates` field in pong metadata
- Remove inline WAL rendering from room-view's screen-share-panel
- Remove `ShareWal`/`StopShareWal` signals + handlers (replaced by module state broadcasts)
- Remove `sharedWal` from `PongMetaDataV1`

**Phase 3 — Timer share module (validates lifecycle + custom element)**
- New file `ui/src/room/modules/timer.ts`
- Custom element `<module-timer-share>` (uses `shareElement` field):
  - 1s `setInterval` in `connectedCallback`, cleared in `disconnectedCallback`
  - Renders `MM:SS` remaining
  - Plays chime locally when `Date.now() >= endTimestamp` (each peer plays independently — no global coordination needed, drift is bounded by ping latency)
- `onActivate` prompts for duration (start with default 5min, optional simple modal)
- `renderToolbarButton` for start/stop
- Add `ui/public/sounds/chime.mp3` (or generate via WebAudio to avoid asset)

**Phase 4 — Screen share module (largest, validates WebRTC integration)**
- New file `ui/src/room/modules/screen-share.ts`
- `onActivate` calls existing `streamsStore.screenShareOn()` (which still does `getUserMedia` + drives the InitRequest cycle)
- `onDeactivate` calls existing `streamsStore.screenShareOff()`
- `renderShare` looks up `streamsStore._screenShareStreams[agent]`, renders `<video>` with stable id `share-screen-${pubkey}` for srcObject reapply
- Module state is just `{ active: true }` — actual stream coordination stays in the existing `_screenShareConnectionsOutgoing`/`Incoming` infrastructure (this is the part that **cannot** be deduplicated)
- `renderToolbarButton` for the screen share start/stop
- Audio mute icon for incoming screen shares becomes a screen-share state icon (via `getStateIcons`)
- Remove screen share toolbar button from room-view
- Remove screen share inline pane templates from room-view's screen-share-panel
- Edge case: state says active but stream hasn't arrived yet → show "connecting…" placeholder

**Phase 5 — Cleanup**
- Delete the legacy `screen-share-panel` rendering path; only the generalized `shared-panel` remains
- Remove `hasScreenShares` and related branches in `idToLayout`
- Update this doc to mark the abstraction complete

#### Risks & open decisions

1. **Late-joiner propagation for WAL**: relies on existing pong `moduleStates` reconciliation. Verify it still works after removing the dedicated `sharedWal` field.
2. **Screen share stream lifecycle vs module state**: state activates first, stream arrives via WebRTC seconds later. Module render must handle both phases.
3. **Maximize keying scheme**: extending `_maximizedVideo` string with `share-` prefix is the minimal change. Cleaner would be a tagged union, but defer.
4. **Toolbar button ordering**: with multiple modules contributing buttons, order matters. Add `toolbarOrder?: number` on ModuleDefinition if needed.
5. **Multiple shares per agent**: current model is one-per-`(module, agent)`. If "agent X is sharing 2 screens" ever matters, redesign needed. Punt.
6. **Timer chime asset vs WebAudio**: WebAudio avoids a binary asset and works offline. Slight preference for WebAudio.

#### Files to modify

| Phase | File | Change |
|---|---|---|
| 1 | `ui/src/room/modules/types.ts` | Add `renderShare`, `shareElement` |
| 1 | `ui/src/room/room-view.ts` | Add `_getActiveShares`, `renderSharedPanel`, splitMode update |
| 2 | `ui/src/room/modules/wal.ts` | New |
| 2 | `ui/src/streams-store.ts` | Remove `_mySharedWal`/`_peerSharedWals`, ShareWal signals, sharedWal pong field |
| 2 | `ui/src/room/room-view.ts` | Remove inline WAL render + WAL picker glue |
| 3 | `ui/src/room/modules/timer.ts` | New (custom element + module def) |
| 4 | `ui/src/room/modules/screen-share.ts` | New |
| 4 | `ui/src/room/room-view.ts` | Remove screen share button + inline rendering |
| 5 | `ui/src/room/room-view.ts` | Delete legacy `screen-share-panel`, `hasScreenShares` |
| 5 | `MODULAR_AGENT_PANE.md` | Mark complete |

#### Verification per phase

- **Phase 1**: build passes; no visual change
- **Phase 2**: WAL share works end-to-end including a late-joiner seeing an existing share via pong reconciliation
- **Phase 3**: two agents see synchronized countdown; both hear chime within ping latency; restart works
- **Phase 4**: full screen share flow — start, peers see, audio toggle, late-joiner, stop, peers stop
- **Phase 5**: room-view.ts shrinks meaningfully; no regressions in any of the three share types

### Completed: Pane Existence Decoupled from WebRTC

Panes now render from `_activeAgents` (derived from `_knownAgents`, filtered by pong recency within `3 * PING_INTERVAL`). Key changes:
- Pane identity is `pubkeyB64` (not `connectionId`) -- Lit reuses DOM nodes across WebRTC reconnects
- Video is a proper activated module with `renderReplace` handling all connection states (no conn, connecting, connected)
- WebRTC initiation gated on video module being active in `_myModuleStates`
- `peer-leave` event (agent left room) vs `peer-disconnected` (WebRTC only) -- leave audio/maximize-clear only on leave
- Video special-casing removed: no force-fetch of video icons, no `moduleId === 'video'` guards
- `renderMyModuleIconStrip`/`renderMyModuleOverlays` collapsed into unified methods using `context.isMe`
- "Reconnect video" button (was "Full reconnect") only shown when WebRTC connection exists

### Performance: Unnecessary Re-renders from Pong Cycle

`handlePongUi` unconditionally calls `.update()` on `_othersConnectionStatuses` (sets `lastUpdated: Date.now()`) and `_knownAgents` (sets `lastSeen: Date.now()`) every 2 seconds per peer. These stores are subscribed via `StoreSubscriber` in room-view, triggering a full Lit render cycle each time -- even though the data they carry (`lastUpdated`, `lastSeen`) is only consumed when connection details are toggled on or the "people" tab is active. Module rendering (including the clock) gets re-rendered as a side effect. Should be guarded to skip `.update()` when only timestamps changed and no structural data differs.

### Pre-existing Bug: Video Toggle Freeze on Remote Peers

`videoOff()` calls `track.stop()` + `removeTrack()`, then `videoOn()` calls `getUserMedia()` + `addTrack()` with a new track. Remote peers see frozen/distorted frames because SimplePeer doesn't handle this add-after-remove cleanly. This bug exists on `main` (pre-module-system) and is not caused by the module changes. Options:
- Change `videoOff()` to `track.enabled = false` (like audio does) -- avoids `getUserMedia` re-prompt and track replacement issues, but keeps camera LED on
- Fix the track replacement to use `replaceTrack()` instead of remove+add
- Investigate the runtime permission persistence (browser vs Moss/Weave container)
