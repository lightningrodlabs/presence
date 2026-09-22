# Audio source capture — design

Date: 2026-09-22. Approved in brainstorming (this session) by the room
owner; cross-repo. Companion plan: `docs/superpowers/plans/2026-09-22-audio-source-capture.md`
(written after this spec is reviewed).

## Goal

A Presence user can include audio that is playing on their machine
(music, a video, another app) in what peers hear, chosen from the
microphone button's menu. The user picks *which* audio in a Moss-owned
picker; Moss never hands a tool the list of running applications, and
Moss's own playback (the other participants' voices) is excluded from
the capture so nobody hears themselves back.

## Non-goals (v1)

- Tauri/WebKitGTK, browser, Android, iOS hosts. No web API exists for
  system audio there; each would need its own native shell work.
- Sharing system audio without the microphone held. The system audio
  rides the mic track (Section 4); a mic-less share needs a new
  consumer model and is deferred.
- Persisting grants across sessions. Every share is a fresh picker.
- Mixing multiple *input devices* (a second mic, line-in).
- Per-source volume controls.

## Platform matrix

As implemented by flexaudio (Section 1); the Linux row was verified
live 2026-09-22, the other two are upstream's documented behaviour
until the smoke test in Section 1 runs there:

| OS | Backend (flexaudio crate) | Per-app | Excludes Moss | Floor |
|---|---|---|---|---|
| Linux, PipeWire | `flexaudio-os-linux`: capture stream fan-in linked from every `Stream/Output/Audio` node whose pid is not excluded | yes | yes, after Fix 1 + Fix 2 | a reachable PipeWire session (default on current Fedora/Ubuntu/Debian) |
| Linux, PulseAudio-only | none | — | — | unsupported (declared) |
| macOS | `flexaudio-os-macos`: CoreAudio process taps (`CATapDescription`, exclude list) | yes | yes, after Fix 2 | 14.4 + TCC audio-capture consent |
| Windows | `flexaudio-os-windows`: WASAPI process loopback, INCLUDE per app / EXCLUDE tree for system | yes | yes (tree) | build 20348 (Windows 11 / Server 2022) |

Below the floor Moss derives `supported: false` and the feature is
absent (the Presence menu row does not render).

## Components

Four deliverables in four repos, built in this order because each is
the next one's dependency:

1. `@lightningrodlabs/flexaudio` — fork of flexaudio with two fixes
   (checked out at `../flexaudio`).
2. Moss — settings section, picker, grant/port plumbing, Weave message.
3. `@theweave/api` — `captureAudioSources()` and the port→track helper.
4. Presence — mic-menu row and the `MicSource` mixin.

### Data flow

```
OS audio (chosen apps / system, minus Moss's process tree)
  → flexaudio addon (Rust, per-OS backend): one `system` stream + one `process` stream per chosen app
  → onChunk callbacks in Moss main: Float32Array mono 48 kHz 20 ms, summed across streams, quantised to Int16Array (960 samples)
  → MessageChannelMain port → webContents.postMessage → Moss renderer
  → forwarded (transfer) to the applet iframe as the `success` reply of `request-audio-sources`
  → @theweave/api: port → AudioWorklet → MediaStreamAudioDestinationNode → MediaStreamTrack
  → Presence MicSource mixin: mic + mixin → destination → the ONE output track
  → WebRTC (replaceTrack fanout) and the signals voice encoder, unchanged
```

No wire-contract change in Presence: peers receive one audio track /
one Opus stream exactly as today.

## Section 1 — `@lightningrodlabs/flexaudio` (fork of flexaudio)

**Decision (2026-09-22, after evaluation)**: do not write the backends.
[Studio-Sadola/flexaudio](https://github.com/Studio-Sadola/flexaudio)
(MIT, Rust workspace + napi-rs binding `crates/flexaudio-napi`) already
implements every backend this design needs — PipeWire fan-in capture
with include/exclude by pid, CoreAudio process taps with an exclude
list, WASAPI process loopback in both tree modes — plus
`processes()` enumeration on all three OSes. The evaluation (built on
the owner's machine, live PipeWire exclusion matrix; findings in the
session memory `project_flexaudio_evaluation.md`) found it sound for
native PipeWire clients and found two defects that block *our* use,
both small and localised. Writing our own would reproduce ~3k lines of
backend code to arrive at the same mechanism.

**Home**: fork to `lightningrodlabs/flexaudio`, checked out at
`../flexaudio` with `upstream` = Studio-Sadola. The npm package is
published under our scope, `@lightningrodlabs/flexaudio` (+ the
per-platform `optionalDependencies` packages the napi CLI generates),
because upstream's own npm publication is blocked (their
`RELEASING.md`: npm 2FA-token bug; crates.io has 0.2.0, 0.3.0 is
unreleased). Both fixes below go upstream as PRs; if upstream publishes
and merges them, Moss switches back to the upstream package and the
fork is archived.

**Fix 1 — pid resolution for pipewire-pulse clients (Linux).**
`crates/flexaudio-os-linux` resolves a stream's pid from the owning
Client's `pipewire.sec.pid`. For any libpulse client — Electron/Moss,
Chrome, Zoom, most desktop apps — that is `pipewire-pulse`'s own pid,
so `processes()` lists every such app under one pid with executable
"pipewire", excluding an app's real pid excludes nothing, and excluding
`pipewire-pulse`'s pid excludes every pulse client at once (all three
measured). The real pid is on both the Node and the Client as
`application.process.id` (set by libpulse from the client's
`PA_PROP_APPLICATION_PROCESS_ID`; self-declared, which is acceptable
for echo prevention). Change: `NodeEntry.app_pid` and the client table
read `application.process.id` first and fall back to
`pipewire.sec.pid`; `processes()` follows. Unit tests in that crate's
`resolve_node_pid_*` family gain the pulse-client row.

**Fix 2 — pid *set* exclusion on Linux and macOS.** `PidSelect::Exclude(u32)`
(Linux) and `TapKind::ExcludeProcesses(vec![one])` (macOS) exclude one
pid; Windows already excludes the target's process tree. Electron
emits audio from the Chromium audio-service helper, not the main pid,
so exclusion must take a set. Change: `ProcessMode::Exclude` carries
`Vec<u32>` through core → the three backends → the napi option
`excludePids: number[]` (kept alongside `processId` for `include`).
WASAPI takes exactly one process tree per EXCLUDE client, so the
Windows backend passes the set's root pid (the one whose descendants
cover the rest — Moss main) and relies on tree semantics; documented in
the option's doc comment.

**Consumed API** (upstream's, unchanged apart from Fix 2):

```ts
processes(): Promise<{ pid; name; executable?; bundleId?; isOutputActive? }[]>
devices(): DeviceInfo[]                       // capability probe: rejects → unsupported
openStream(
  { kind: 'system', excludePids, outputRate: 48000, outputChannels: 1, chunkMs: 20 }
  | { kind: 'process', processId, outputRate: 48000, outputChannels: 1, chunkMs: 20 },
  onChunk: (chunk: { data: Float32Array; frames; peak; rms; seq; droppedBefore }) => void,
  onEvent: (ev: { type: 'chunkDropped'|'stalled'|'recovered'|'permissionDenied'|'deviceLost'|'error' }) => void,
): FlexStream  // .stop(): Promise<void>
```

`kind:'system'` + `excludePids` is the "All system output (except
Moss)" row; each chosen app is its own `kind:'process'` stream and
Moss sums the chunks (float add, clamp) before quantising to the
`Int16Array` frames Section 2 sends over the port. Output is requested
mono/48 kHz/20 ms so the port format stays the one fixed format.

**Capabilities** are derived in Moss, not in the addon: `require` of
the addon fails → `supported:false` (the `.node` NEEDs
`libpipewire-0.3.so.0` and `libasound.so.2` at load time — a host
without PipeWire cannot load it, so Moss `require`s lazily inside
try/catch); `processes()` rejects → `perApp:false`; `canExcludeSelf` is
true on every backend the addon supports (there is no PulseAudio-only
backend in flexaudio — a PulseAudio-only host is `supported:false`,
which drops the spec's earlier "sink monitor without exclusion"
fallback; declared change, no user on the team runs one). The
`canExcludeSelf` field stays in the Weave API (Section 3) so a future
backend that cannot exclude can say so without an API change; today
Moss always sends `true`.

**Smoke test** (the property nothing else proves; kept from the
original design): in the fork's `__test__/`, start a
`kind:'system'` capture with `excludePids=[child A]`, where child A
plays a 1 kHz tone through *libpulse* (`paplay`, the Electron path)
and child B plays 3 kHz natively (`pw-play`); Goertzel over 3 s must
find 3 kHz and not 1 kHz (bin index `round(N·f/rate)` — the evaluation
rig's off-by-one read a pure tone as silence). Linux CI installs
`pipewire`/`wireplumber`/`pipewire-pulse` headless with a null sink;
Windows CI plays via two child `powershell` processes; macOS CI cannot
grant the TCC audio-capture permission, so the macOS run is manual by
the room owner and recorded in the fork's README with the OS version.

**Floors** (from upstream's docs, superseding the research table):
macOS 14.4 (`NSAudioCaptureUsageDescription` in Moss's `Info.plist`,
TCC prompt on first capture), Windows build 20348 (Windows 11 / Server
2022) for per-process and exclusion, Linux = a reachable PipeWire
session. Below the floor the picker is not offered.

**Build/publish**: upstream's `release-npm.yml` matrix (linux x64/arm64,
win x64/arm64, darwin arm64) retargeted to our scope; darwin x64 added
because Moss ships `build:mac-x64`. Moss pins an exact version.

**Landed (2026-09-22; plan `docs/superpowers/plans/2026-09-22-flexaudio-fork.md`).**
`@lightningrodlabs/flexaudio@0.3.0-lrl.1` is on the npm registry (root + six
platform packages, `dist-tags.latest`; verify with
`npm view @lightningrodlabs/flexaudio version`, never from this line), built
from fork commit `27e2d19` (tag `v0.3.0-lrl.1`), published manually with OTP
because trusted publishing cannot bootstrap a new package. Fix 1 and Fix 2
are upstream PRs Studio-Sadola/flexaudio#3 and #4. Two things the evaluation
did not predict and this section's text above does not describe: (a) the
registry `global` event omits `application.process.id`, so Fix 1 binds each
stream node and reads it from the bound `info` props, gating Exclude-mode
linking on that info having arrived; (b) the smoke test exposed a pre-existing
upstream fan-in defect (a node latched after pairing whatever ports had
arrived → one channel silent), fixed with a channel-aware completeness
predicate over the bound node's `n_output_ports`. Consumers must pin the
version exactly (`"0.3.0-lrl.1"`; a `^0.3.0` range does not match a
prerelease). Field limits Moss must design around: macOS resolves pids to
Core Audio objects once at `start` (a helper with no audio object yet is not
excluded — start the capture while already playing, or reopen); Windows
honours one process tree (`excludeSelf` = the addon host's tree); the `.node`
NEEDs `libpipewire-0.3.so.0` at load; a declared PipeWire output port that
never surfaces as a registry global leaves that node unlinked (no timeout).

## Section 2 — Moss

Branch `feat/audio-source-capture` off `main-0.7`.

**Weave message**: `request-audio-sources` added to
`AppletToParentRequest` (`libs/api/src/types.ts`), to
`validationSchemas.ts`, and to the `applet-host.ts` dispatcher; the
existing `ipc-contract-drift.test.ts` covers the new IPC pair. Applet
identity comes from `source` as with every other message, so the grant
is attributed to the requesting applet.

**Reply with a transferable**: `applet-host.ts` posts replies as
`message.ports[0].postMessage({type:'success', result})`. The handler
for this message returns `{ result, transfer: [port] }` and the reply
site gains a transfer list when present — the only change to the reply
path, and the only message that uses it. `result` is
`{ label: string; canExcludeSelf: boolean } | null`.

**Main-process flow** (`src/main/audioSources.ts`, new file — `index.ts`
is already the file CLAUDE.md rule 8 warns about):

1. IPC `request-audio-sources` from the Moss renderer (preload
   `admin.ts` + `walwindow.ts`, mirroring `selectScreenOrWindow`).
2. If the persisted "Audio sources" switch is off → resolve `null`.
3. `audioCapture.capabilities()` (`src/main/audioCapture.ts`, the lazy
   `require` wrapper from Section 1) reports `supported:false` →
   resolve `null`.
4. Open the picker window (`selectaudiosources.html`, a Lit element
   modelled on `selectmediasource.ts`): checkbox list — "All system
   output (except Moss)" first, then `processes()` entries (pids never
   leave main; the picker gets `{ id, name, isOutputActive }`) **sorted
   with currently-playing apps first** (`isOutputActive` true → false →
   unknown, then by name) and each row marked playing / silent (decided
   2026-09-22); when `perApp` is false only the first row shows. Confirm → the
   chosen ids; cancel/close → `null`. One picker at a time, like
   `SELECT_SCREEN_OR_WINDOW_WINDOW`.
5. Open the streams: `kind:'system'` with `excludePids = mossProcessTree()`
   if that row was chosen, plus `kind:'process', processId` per chosen
   app. The exclude set is the whole Electron process tree (main +
   every helper — the Chromium audio service is the process that emits
   sound, not `process.pid`), computed from `process.pid` via
   `app.getAppMetrics()` (which lists every child with its pid). A
   `mixer` (pure, table-tested: sum, clamp, f32→s16) folds the streams'
   chunks into one `Int16Array` frame per 20 ms.
6. `new MessageChannelMain()`; each mixed frame → `port1.postMessage(frame)`
   (`MessagePortMain.postMessage` structured-clones the `Int16Array`;
   its transfer list accepts only ports — 96 KB/s of copying is
   immaterial). `port2` → `webContents.postMessage('audio-source-port', { grantId, label, canExcludeSelf }, [port2])`
   to the requesting window; the preload receives it via
   `ipcRenderer.on` (`event.ports[0]`) and re-posts it into the page
   with `window.postMessage(..., '*', [port])` — the documented Electron
   pattern for handing a main-process port to page script.
7. The renderer's `applet-host` resolves the pending request with the
   port as the transfer.

**Teardown** — a grant ends on any of: the applet iframe unloading
(`applet-host` tracks grants per iframe and calls `stop-audio-sources`
on teardown), the user pressing Stop on the chip or in Settings,
a stream `onEvent` of `deviceLost`/`permissionDenied`/`error` (a
`process` stream ending because its app quit ends only that stream —
the grant continues on the remaining ones and ends when none remain),
the tool closing the port (detected via a
`{type:'close'}` message the api helper sends from `stop()`). Every
path calls one `endGrant(grantId, reason)` that stops the capture,
closes `port1`, and notifies the renderer; `endGrant` is idempotent.

**Chip**: while ≥1 grant is active the Moss top bar shows
"<tool name> is using system audio" with a stop button (one chip per grant).

**Settings**: a new top-level tab **Capabilities** (decided 2026-09-22
over "Tool Affordances"/"Tool Permissions": short, and it stretches to
non-grant items such as storage access or model downloads; the one cost
is that "capability" already names Holochain cap-grants and the Weave
API's applet capability flags for developers, so the element and enum
names below say what kind) in `moss-settings.ts`
(`TabsState.Capabilities`), rendering `<moss-capabilities-settings>` which
owns a sub-tab bar. First sub-tab **Audio Sources**
(`self/settings/capabilities/audio-sources-settings.ts`):

- persisted enable switch (`persistedStore.audioSourcesEnabled`,
  default **on** — the picker is itself an explicit per-request
  consent, so the switch is a kill switch, not the consent), labelled
  "Allow tools to request audio sources";
- capability readout from `capabilities()` (backend, per-app,
  excludes-Moss, reason);
- active grants: tool name, label, started-at, Stop.

The `ai-transcription` branch's Local AI tab is not on `main-0.7`
today; when that branch lands it becomes the second sub-tab here (noted
for that merge, not done by this work).

**Tests**: `audioSources.test.ts` (grant table: request → picker
outcome × capability × switch → result/null; `endGrant` idempotence;
process-tree computation from a fake `getAppMetrics`),
`validationSchemas` round-trip for the new message,
`ipc-contract-drift`.

## Section 3 — `@theweave/api`

In `libs/api` (published as `@theweave/api 0.7.0-dev.4` or later;
Presence pins the release):

```ts
export interface AudioSourceCapture {
  track: MediaStreamTrack;     // ends when the grant ends
  label: string;               // e.g. "System audio", "Spotify, Firefox"
  canExcludeSelf: boolean;     // false → tell the user echo is possible
  stop(): void;                // ends the grant from the tool side
  onended?: () => void;        // set by the tool; fires once, not after stop()
}
interface WeaveServices {
  captureAudioSources?(opts?: { audioContext?: AudioContext }): Promise<AudioSourceCapture | null>;
}
```

Optional on `WeaveServices` (`?`) so a tool can feature-detect the host
the same way it does `userSelectScreen`; headless `buildHeadlessWeaveClient`
leaves it undefined.

Implementation (`libs/api/src/audio-source-capture.ts`): send
`request-audio-sources`; on a `null` result resolve `null`; otherwise
build the track: an `AudioWorkletNode` whose processor is registered
from a Blob URL (the worklet source is an inline string so the package
ships no extra asset), fed by the port's `Int16Array` frames through a
ring buffer sized 200 ms (drop-oldest on overflow, zero-fill on
underrun — both counted and exposed on the object for diagnostics),
into a `MediaStreamAudioDestinationNode`; `track = destination.stream.getAudioTracks()[0]`.
The context is `opts.audioContext` if given, else a private 48 kHz
context. Port `close`/`{type:'ended'}` → stop the worklet, `track.stop()`,
fire `onended`. `stop()` posts `{type:'close'}` and closes the port.

Tests: the ring-buffer/framing logic is a pure module
(`pcm-ring.ts`) table-tested in node; the worklet glue is covered by
Presence's harness (Section 4).

## Section 4 — Presence

Branch `feat/include-system-audio` off `main-0.7`.

**Host seam**: `StreamsStore.connect` already takes
`screenSourceSelection`; it gains `captureAudioSources?: () => Promise<AudioSourceCapture | null>`
from `room-container.ts` (`this.weaveClient.captureAudioSources?.bind(...)`),
passed with `micSource.ensureAudioContext()` as the context so the
mixin lives in the one shared context.

**Intent** (`intent.ts`): `mic: { wanted; muted; includeSystemAudio: boolean }`;
gestures `system-audio-on` (after the picker succeeds, like
`screen-share-on`), `system-audio-off` (menu row), `system-audio-ended`
(gesture-equivalent: Moss or the OS ending the grant is a user/platform
action delivered as a track end, same header rationale as
`screen-share-track-ended`). `session-end` clears it. `audio-mute` does
NOT clear it. Table-tested in `intent.test.ts`. New store gesture
methods `systemAudioOn()`/`systemAudioOff()` are added to
`intent-write-sites.test.ts`'s `ALLOWED_CALL_SITES`, and the
track-ended arm is called from the capture's `onended` handler inside
`systemAudioOn` (same shape as the display-capture `ended` listener).

**Declared behaviour**: mute silences the *whole* outgoing audio track,
system audio included — there is one output track and `muted` is its
`enabled` flag. The row is disabled with title "Turn your microphone on
first" while `!localIntent.mic.wanted`.

**`MicSource` mixin** (`mic-source.ts`): `setMixin(track: MediaStreamTrack | null)`.
State: `_deviceTrack` (today's `_track`, the raw device track, whose
`CaptureLifecycle` and reconciler handling are unchanged) and a derived
`_outputTrack` handed to consumers. Pure decision `decideMicOutput`
(`mic-output-policy.ts`, `media-event-policy.ts` shape):

```
input:  { device: MediaStreamTrack|null, mixin: MediaStreamTrack|null, current: 'device'|'mixed'|null }
output: { kind:'use-device' } | { kind:'build-mix' } | { kind:'tear-mix' } | { kind:'none' }, reason
```

`build-mix`: `MediaStreamSource(device)` + `MediaStreamSource(mixin)` →
`MediaStreamAudioDestinationNode`; output = destination track. The
output swap goes through the existing `_openAndSwap` fanout body
(refactored into `_installOutputTrack(newTrack, old)` so device
change, reopen, and mixin change share ONE swap path: store-level
`onTrackChange` → per-consumer `onTrackChanged` → stop old). Device
change or reopen while mixed rebuilds the mix (the device source node
is replaced) without touching consumers' view of the output. `tear-mix`
on `setMixin(null)` or mixin `ended` swaps back to the raw device
track. `_closeDevice` disconnects the graph. Mute writes `enabled` on
the output track (and on the device track, so an unmixed swap keeps
today's behaviour).

**Menu row** (`room-view.ts`, under the device list, after a divider):
"Include audio from…" → `systemAudioOn()`; when active "✓ Including:
<label>" → `systemAudioOff()`; when `canExcludeSelf` is false the label
carries "(may echo)". Rendered only when the store reports the host
capability (`streamsStore.canCaptureAudioSources`, true iff the seam
was injected).

**Tests**: `mic-output-policy.test.ts` (table); `mic-source-mixin.test.ts`
in node with a fake `AudioContext`/`MediaStreamAudioDestinationNode`
(the fake must be able to end a mixin track — negative control for the
`ended` arm); a `streams-store-wiring.test.ts` case that a mixin swap
reaches every media transport via `replaceTrack` exactly once and that
`systemAudioOff` swaps back; `intent.test.ts` rows; the
`intent-write-sites` allow-list; `view-teardown-symmetry` for any new
subscription; `no-ambient-clock` pin on `mic-output-policy.ts`. Real
audio-graph behaviour (mixin audible to a peer, exclusion of Moss's own
playback) is harness/manual territory, recorded in the harness header
as such.

## Error handling

- Picker cancelled / switch off / unsupported host → `null` everywhere;
  Presence does nothing (no error event, like the cancelled screen
  picker).
- Backend `deviceLost`/`permissionDenied`/`error` (or the last stream's
  app quitting) → grant ends,
  Presence intent `system-audio-ended`, row returns to idle; the reason
  is logged to the PresenceLogger pipeline as a new `SystemAudioEnded`
  emitted event (added to `SIMPLE_EVENT_TAXONOMY`).
- Worklet under/overrun → counters only; no teardown.
- `getAppMetrics` missing a helper (exclusion imperfect) is not
  detectable at runtime; the smoke test in Section 1 is the guard.
- Stream `chunkDropped`/`stalled`/`recovered` → counters on the grant,
  shown in the Settings sub-tab; no teardown.

## Sequencing

1. Fork flexaudio → `../flexaudio`; Fix 1 and Fix 2 with the
   smoke test as their acceptance test (Linux on the owner's machine
   and in CI; Windows in CI; macOS manual); retarget the release
   workflow to `@lightningrodlabs/flexaudio` and publish. Open the two
   upstream PRs. **Gate**: the self-exclusion smoke test passes on
   Linux and Windows before Section 2 starts.
2. Moss: settings section, picker, plumbing, chip; depends on 1.
3. `@theweave/api` dev release; depends on 2's message type.
4. Presence; depends on 3's published version and a Moss build carrying 2.

Each step is one branch, one intent, adversarially reviewed
(Presence working agreement 9; Moss CLAUDE.md rule 1 — TDD).

## Decisions (approved 2026-09-22)

- Picker offers per-app sources plus "all system output (except Moss)".
- Native capture is a fork of flexaudio at `../flexaudio` (revised
  2026-09-22 after the evaluation; supersedes the original "new napi-rs
  repo modelled on we-rust-utils" decision), published as
  `@lightningrodlabs/flexaudio` until upstream publishes.
- PulseAudio-only Linux hosts are unsupported (declared; consequence of
  adopting flexaudio, which has no PulseAudio backend).
- Settings: new "Capabilities" tab (decided 2026-09-22; "Tool
  Affordances" and "Tool Permissions" were considered) with sub-tabs;
  "Audio Sources" is the first sub-tab.
- Picker shows `isOutputActive` per app and sorts playing apps first
  (decided 2026-09-22).
- Grants session-scoped, not persisted.
- v1 requires the mic to be held; system audio rides the mic track.
- Mute silences the mixed track as a whole (declared here, not asked).
- Enable switch defaults on (declared here, not asked).

## Definition of done

- Linux and Windows smoke tests green in CI; macOS result recorded.
- Moss: picker → chip → stop round-trip works in `yarn applet-dev`
  with the example applet requesting audio sources.
- Presence: a peer hears the sharer's system audio over WebRTC and over
  the signals voice carrier; the sharer does not hear an echo of the
  peer's voice (manual, two machines, recorded in the plan's final
  task).
- `nix develop -c npm run verify` green in Presence; Moss `yarn test`
  and `yarn typecheck` green; the fork's CI (upstream's `ci.yml` plus
  the smoke test) green.
- The two upstream PRs are open with links recorded in the fork's
  README.
- Presence `CLAUDE.md` "True today" gains one bullet for this round.
