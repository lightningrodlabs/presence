# Plan: Generalized Module System for Agent Panes

## Status: In Progress

Core module system is implemented. Panes decoupled from WebRTC (driven by `_activeAgents`). Video is a proper activated module. Screen share and WAL modules are not yet extracted.

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

### Next Steps
1. Extract screen-share as a `share`-type module
2. Extract WAL-embed as a `share`-type module
3. Generalize sharing panel to render from share-type modules
4. `splitMode` calculation becomes "any share-type module active"

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
