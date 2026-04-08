# Plan: Generalized Module System for Agent Panes

## Status: In Progress

Core module system is implemented. Screen share and WAL modules are not yet extracted.

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

### Future Architectural Change: Decouple Pane Existence from WebRTC

**Current state**: Agent panes render from `_openConnections` (WebRTC connection map). No WebRTC = no pane. This means:
- You can't see an agent without a WebRTC connection to them
- Modules that work purely over holochain signals (raise-hand, clock) still require WebRTC
- "Full reconnect" destroys the pane temporarily
- Can't connect/disconnect WebRTC independently of pane existence

**Target state**: Panes should render from `_knownAgents` (holochain presence via ping/pong), not `_openConnections`. This would mean:
- An agent is "present" as soon as they appear in pongs
- The video module manages its own WebRTC lifecycle within the pane
- Signal-only modules work without WebRTC
- WebRTC disconnect doesn't remove the pane -- it just affects the video module
- Full reconnect becomes "WebRTC reconnect" in the video module; holochain presence is always-on

This is a significant refactor touching the connection lifecycle, pane rendering loop, and how `_openConnections` vs `_knownAgents` drive the UI. It should be done as a separate effort.

### Pre-existing Bug: Video Toggle Freeze on Remote Peers

`videoOff()` calls `track.stop()` + `removeTrack()`, then `videoOn()` calls `getUserMedia()` + `addTrack()` with a new track. Remote peers see frozen/distorted frames because SimplePeer doesn't handle this add-after-remove cleanly. This bug exists on `main` (pre-module-system) and is not caused by the module changes. Options:
- Change `videoOff()` to `track.enabled = false` (like audio does) -- avoids `getUserMedia` re-prompt and track replacement issues, but keeps camera LED on
- Fix the track replacement to use `replaceTrack()` instead of remove+add
- Investigate the runtime permission persistence (browser vs Moss/Weave container)
