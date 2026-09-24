# Dead-Track Escalation and Reconnect Forensics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A connected WebRTC media link whose inbound bytes stay frozen through a bounded refresh budget is closed and re-established automatically, and the next incident export carries the evidence this one lacked.

**Architecture:** One new arm on the existing pure decision (`decideTrackRefresh`), executed by the existing owner (`TrackHealthMonitor`), tearing down through the existing close path (`closeConnection` → `closeCleanupPlan`) and re-establishing through the existing pong drive. Two new `PeerRecord` fields with reset arms. Log-only forensic additions in `MediaLinks` and `TrackHealthMonitor`. No new wire surface.

**Tech Stack:** TypeScript strict, `@holochain-open-dev/stores`, vitest (ui workspace), nix devshell (node 22).

**Spec:** `docs/superpowers/specs/2026-09-24-dead-track-escalation-design.md`. Read its "The incident, from the log" section first. Every task below cites the log lines that justify it, in the form `epoch-ms source "grep string"`. The log is `~/Downloads/Presence_merged_0.15.6_2026-9-24-10_17_19.json`. The spec's "Flatten it with" script prints it sorted with both local time and epoch ms.

## Global Constraints

- Branch `dead-track-escalation` off `main-0.7` @ `6f9d0a4`. Landing target `main-0.7`.
- Gate before EVERY commit: `nix develop -c npm run verify`. Run it with the sandbox disabled. A sandboxed `nix develop` fails on `.gitmodules` yet exits 0, so require the real vitest summaries in the output. Focused runs: `nix develop -c npm run test -w ui -- <path>`. Never `npx vitest`.
- Decisions stay pure: the escalation decision lives in `ui/src/transport/track-health-policy.ts` and is table-tested with no mocks. The executor in `ui/src/track-health.ts` performs I/O only.
- Every new constant names the predicate it serves in its doc comment (working agreement 2). Both new constants serve the media-flowing predicate and run on the track-health poll's clock.
- Every new `event:` literal sits on its own line as a quoted literal, so `event-taxonomy.test.ts`'s emission grep finds it. Each new event type is added to `SimpleEventType`, to `SIMPLE_EVENT_TAXONOMY` as `'emitted'`, and to the inline snapshot in `ui/src/__tests__/event-taxonomy.test.ts` in alphabetical position.
- `ui/harness` is not typechecked. After any signature change, grep it by name.
- Stage explicit paths. No co-authored footer. No emotional phrasing in messages.
- Line anchors were verified at `6f9d0a4`. If they shifted, re-locate by the quoted names.
- Zero changes to `packages/webrtc-peer`.

## Review Focus

Inputs the spec implies but that no existing test exercises. Each line names the task whose tests pin it.

1. A track that never started (bytes stay 0) must never escalate. It is the establishment path's problem, not a dead track. Task 3, policy test "never-started kinds do not move counters or escalate".
2. A refresh request whose data-channel send fails must still consume the budget: a dead data channel must not prevent escalation. Task 4, wiring test (d).
3. Escalation on a slot whose transport already vanished with no event (the §3.1(c) shape, phase `idle`) must not fire or loop: the transport-phase hold covers it. Task 4, wiring test (e).
4. If `getStats` rejects, the outbound-stats log on `request-track-refresh` receipt must not break the refresh. Task 2, wiring test "outbound log survives a rejecting getStats".
5. Installing `onmute` and the log-only `onunmute` must not change the arrived-muted branch, whose `onunmute` still calls `_setTrackReady`. Task 1, wiring test "TrackMuted/TrackUnmuted forensics on remote tracks".

---

### Task 1: Named close reasons and remote-track mute forensics

**Why (log):** every close in the capture reads `trigger="disconnectFromPeerVideo"`, so the Reconnect click at `1790259254586 k1VOFk "[uhCAkSPd] FsmTransition connected->closed trigger=\"disconnectFromPeerVideo\""` and Uruguay's carrier flip at `1790259269490 kSPd2S "[uhCAkEk5] FsmTransition connected->closed trigger=\"disconnectFromPeerVideo\""` are indistinguishable without the neighbouring `MyWebrtcDisable` line. And in the defect window (10:13:04 to 10:14:14) neither Eric nor Uruguay logs `TrackUnmuted` for the other, while the third peer does (`kEk5cU "[uhCAkSPd] TrackUnmuted"` at 10:13:05.411). Whether Eric's tracks at Uruguay went muted and stayed muted, or never muted, cannot be read: no `onmute` handler exists, and `onunmute` is installed only on tracks that arrived muted (`ui/src/media-links.ts:1034-1101`).

**Files:**
- Modify: `ui/src/streams-store.ts:2027-2031` (`disconnectFromPeerVideo`), `:2053` (`blockAgent`), `:2819` (`setCarrierMode`), `:2898` (per-peer carrier setter)
- Modify: `ui/src/room/modules/conversation.ts:282` (Reconnect icon), `:320` (`onModulePayloadChange`)
- Modify: `ui/src/media-links.ts:1034-1101` (`_handleMediaRemoteTrack`)
- Modify: `ui/src/logging.ts:121` (type union) and `:260` (taxonomy)
- Modify: `ui/src/peer-record.ts:43` (the `webrtcExitReason` doc-comment example)
- Test: `ui/src/__tests__/event-taxonomy.test.ts` (inline snapshot), `ui/src/__tests__/streams-store-wiring.test.ts:959` (reason pin) plus one new test

**Interfaces:**
- Produces: `StreamsStore.disconnectFromPeerVideo(pubKeyB64: AgentPubKeyB64, reason: string): void` (reason now required). New `SimpleEventType` member `'TrackMuted'`.
- Consumed by later tasks: none directly. Task 4's escalation uses `mediaTransport().closeConnection`, not this method.

- [ ] **Step 1: Update the existing reason pin and add the failing TrackMuted test**

In `ui/src/__tests__/streams-store-wiring.test.ts:959` change the pinned string:

```ts
        c => c.peer === peerA && c.reason === 'carrier-mode-signals'
```

Append a new `describe` at the end of the file:

```ts
describe('TrackMuted/TrackUnmuted forensics on remote tracks (2026-09-24 incident)', () => {
  type FakeRemoteTrack = {
    kind: 'audio' | 'video';
    muted: boolean;
    readyState: 'live' | 'ended';
    enabled: boolean;
    onmute: (() => void) | null;
    onunmute: (() => void) | null;
  };
  const remoteTrack = (kind: 'audio' | 'video', muted: boolean): FakeRemoteTrack => ({
    kind, muted, readyState: 'live', enabled: true, onmute: null, onunmute: null,
  });
  const streamOf = (tracks: FakeRemoteTrack[]) => ({
    id: 'remote-stream',
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
  });

  it('logs TrackMuted from onmute, and a log-only TrackUnmuted for a track that arrived unmuted', () => {
    const { store, transports, logger } = makeStarted();
    const media = transports.media!;
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    // Video, not audio: an audio track would route into the analyser
    // setup, which needs an AudioContext this node environment lacks.
    const track = remoteTrack('video', false);
    media.emit({
      type: 'remote-track',
      peer: peerA,
      connectionId: 'conn-1',
      track: track as unknown as MediaStreamTrack,
      stream: streamOf([track]) as unknown as MediaStream,
    });
    expect(get(store._openConnections)[peerA]?.video).toBe(true);
    expect(track.onmute).not.toBeNull();
    expect(track.onunmute).not.toBeNull();

    track.muted = true;
    track.onmute!();
    const muted = logger.eventsNamed('TrackMuted');
    expect(muted).toHaveLength(1);
    expect(muted[0].agent).toBe(peerA);
    expect(muted[0].connectionId).toBe('conn-1');
    expect(muted[0].detail).toBe('video');

    track.muted = false;
    track.onunmute!();
    const unmuted = logger.eventsNamed('TrackUnmuted');
    expect(unmuted).toHaveLength(1);
    expect(unmuted[0].detail).toContain('re-unmute');
  });

  it('keeps the arrived-muted branch intact: onunmute still marks the track ready (Review Focus 5)', () => {
    const { store, transports, logger } = makeStarted();
    const media = transports.media!;
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    const track = remoteTrack('video', true);
    media.emit({
      type: 'remote-track',
      peer: peerA,
      connectionId: 'conn-1',
      track: track as unknown as MediaStreamTrack,
      stream: streamOf([track]) as unknown as MediaStream,
    });
    expect(logger.eventsNamed('TrackArrivedMuted')).toHaveLength(1);
    expect(get(store._openConnections)[peerA]?.video).toBeUndefined();
    expect(get(store._openConnections)[peerA]?.videoMuted).toBe(true);

    track.muted = false;
    track.onunmute!();
    expect(logger.eventsNamed('TrackUnmuted')).toHaveLength(1);
    expect(get(store._openConnections)[peerA]?.video).toBe(true);

    track.muted = true;
    track.onmute!();
    expect(logger.eventsNamed('TrackMuted')).toHaveLength(1);
  });
});
```

Add `"TrackMuted": "emitted",` to the inline snapshot in `ui/src/__tests__/event-taxonomy.test.ts` between the `"TrackArrivedMuted"` and `"TrackUnmuteTimeout"` lines.

- [ ] **Step 2: Run the tests to see them fail**

Run: `nix develop -c npm run test -w ui -- ui/src/__tests__/streams-store-wiring.test.ts ui/src/__tests__/event-taxonomy.test.ts`
Expected: FAIL. The reason pin fails (still `'disconnectFromPeerVideo'`), the new describe fails on `track.onmute` being null, the taxonomy snapshot fails (no `TrackMuted` key).

- [ ] **Step 3: Add the event type**

`ui/src/logging.ts`. After line 121 (`| 'TrackUnmuted'`) add:

```ts
  // Forensics (2026-09-24 incident): a remote track's onmute. Paired
  // with TrackUnmuted so a mute/unmute cycle on a link that stays
  // `connected` is visible in the export. Log-only.
  | 'TrackMuted'
```

After line 260 (`TrackUnmuted: 'emitted',`) add:

```ts
  TrackMuted: 'emitted',
```

- [ ] **Step 4: Install the handlers in `_handleMediaRemoteTrack`**

In `ui/src/media-links.ts`, replace the block starting at `if (!track.muted) {` (line 1055) through its closing `}` (line 1058) with:

```ts
    // Forensics (2026-09-24 incident, spec Part 2): a remote track's
    // mute/unmute cycle on a link that stays `connected` was invisible.
    // onmute was never installed, and onunmute only on tracks that
    // arrived muted. Both handlers here are log-only. The arrived-muted
    // branch below keeps its own onunmute, which also calls
    // _setTrackReady.
    track.onmute = () => {
      this.bindings.logger.logAgentEvent({
        agent: pubKeyB64,
        timestamp: this.bindings.now(),
        event: 'TrackMuted',
        connectionId,
        detail: track.kind,
      });
    };

    if (!track.muted) {
      track.onunmute = () => {
        this.bindings.logger.logAgentEvent({
          agent: pubKeyB64,
          timestamp: this.bindings.now(),
          event: 'TrackUnmuted',
          connectionId,
          detail: `${track.kind} re-unmute (log-only)`,
        });
      };
      this._setTrackReady(pubKeyB64, connectionId, track);
      return;
    }
```

Leave the arrived-muted branch (the `TrackArrivedMuted` event, the `videoMuted` slot write, the 5 s timeout, and its `track.onunmute`) exactly as it is.

- [ ] **Step 5: Make the close reason required and name every caller**

`ui/src/streams-store.ts:2027`:

```ts
  /**
   * Close the media link to one peer. `reason` is REQUIRED and names the
   * caller: it reaches `FsmTransition ... trigger=` and `CarrierSwitch
   * webrtc->signals reason=` through `webrtcExitReason`, so an export
   * can tell a Reconnect click from a carrier flip (2026-09-24 incident,
   * spec Part 2). Current reasons: 'reconnect-button',
   * 'carrier-mode-signals', 'peer-carrier-change',
   * 'peer-disabled-webrtc', 'block'. Escalation closes through the
   * transport directly with 'dead-track-escalation'.
   */
  disconnectFromPeerVideo(pubKeyB64: AgentPubKeyB64, reason: string) {
    if (get(this._openConnections)[pubKeyB64]) {
      this.mediaTransport.closeConnection(pubKeyB64, reason);
    }
  }
```

Callers:
- `streams-store.ts:2053` (`blockAgent`): `this.disconnectFromPeerVideo(pubKey64, 'block');`
- `streams-store.ts:2819` (`setCarrierMode`, the `mode === 'signals'` loop): `this.disconnectFromPeerVideo(pubKeyB64, 'carrier-mode-signals');`
- `streams-store.ts:2898` (per-peer carrier setter): `this.disconnectFromPeerVideo(peerB64, 'peer-carrier-change');`
- `ui/src/room/modules/conversation.ts:282`: `onSelect: () => context.streamsStore.disconnectFromPeerVideo(agentPubKeyB64, 'reconnect-button'),`
- `ui/src/room/modules/conversation.ts:320`: `streamsStore.disconnectFromPeerVideo(agentPubKeyB64, 'peer-disabled-webrtc');`

In `ui/src/peer-record.ts:43` change the example list in the `webrtcExitReason` comment from `"disconnectFromPeerVideo", "peer left", ...` to `"reconnect-button", "carrier-mode-signals", "peer left", ...`.

- [ ] **Step 6: Grep for callers the typechecker cannot see**

Run: `grep -rn "disconnectFromPeerVideo(" ui/harness ui/src`
Expected: every hit in `ui/src` passes two arguments. If `ui/harness` has a hit, add a reason string `'harness'` there.

- [ ] **Step 7: Run the focused tests, then the gate**

Run: `nix develop -c npm run test -w ui -- ui/src/__tests__/streams-store-wiring.test.ts ui/src/__tests__/event-taxonomy.test.ts`
Expected: PASS.
Run: `nix develop -c npm run verify`
Expected: both workspaces' suites green, both `tsc --noEmit` clean.

- [ ] **Step 8: Commit**

```bash
git add ui/src/streams-store.ts ui/src/room/modules/conversation.ts ui/src/media-links.ts ui/src/logging.ts ui/src/peer-record.ts ui/src/__tests__/event-taxonomy.test.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "forensics: name every disconnectFromPeerVideo reason, log TrackMuted and re-unmute

From the 2026-09-24 field export: every close read
trigger=\"disconnectFromPeerVideo\", so the Reconnect click at 10:14:14
and the carrier flip at 10:14:29 were indistinguishable, and no
TrackMuted event exists so a mute/unmute cycle on a connected link was
invisible. Log-only; the one wiring pin on the old reason string is
updated. Spec: docs/superpowers/specs/2026-09-24-dead-track-escalation-design.md"
```

---

### Task 2: Stats forensics: outbound bytes on refresh receipt, pair-state histogram when no pair succeeded

**Why (log):** in the defect window Eric received 20 `request-track-refresh` frames from Uruguay (`k1VOFk "request-track-refresh received from [uhCAkSPd]"`) and answered each with `"Manual track refresh [uhCAkSPd]: replaceTrack"`. Nothing in Eric's log says whether his encoder was producing bytes toward Uruguay, because `summarizeRtcStats` reads `inbound-rtp` only (`ui/src/transport/track-health-policy.ts:63-116`). And after the four `reconnection succeeded` transitions at 10:13:04 the only `ICE pair` line is `kEk5cU` at 10:13:06.515 for the third-peer link. On the Eric↔Uruguay link neither side logged one. The sampler in `_handleMediaConnected` (`ui/src/media-links.ts:750-796`) logs only pairs with `state === 'succeeded'`. If there are none, it is silent.

**Files:**
- Modify: `ui/src/transport/track-health-policy.ts:25-116` (`RtcStatsReportLike`, `RtcStatsSummary`, `summarizeRtcStats`)
- Modify: `ui/src/track-health.ts:314-352` (`refreshTracksForPeer`) plus one new private method
- Modify: `ui/src/media-links.ts:750-796` (the relay sampler)
- Test: `ui/src/transport/__tests__/track-health-policy.test.ts`, `ui/src/__tests__/streams-store-wiring.test.ts`

**Interfaces:**
- Produces: `RtcStatsReportLike.bytesSent?: number`; `RtcStatsSummary.audioBytesSent: number` and `.videoBytesSent: number`.
- Consumes: `PeerTransport.getStats(peer): Promise<TransportStats | null>` where `raw.forEach(report => …)` yields each report (a `Map` works as a test double); `PeerTransport.getIceConnectionState(peer)`.

- [ ] **Step 1: Write the failing policy tests**

In `ui/src/transport/__tests__/track-health-policy.test.ts`, add an outbound fixture next to `videoInbound`:

```ts
const audioOutbound = (over: Partial<RtcStatsReportLike> = {}): RtcStatsReportLike => ({
  type: 'outbound-rtp',
  kind: 'audio',
  bytesSent: 7000,
  ...over,
});

const videoOutbound = (over: Partial<RtcStatsReportLike> = {}): RtcStatsReportLike => ({
  type: 'outbound-rtp',
  kind: 'video',
  bytesSent: 90_000,
  ...over,
});
```

Inside `describe('summarizeRtcStats', …)` add:

```ts
  it('reads outbound-rtp bytesSent per kind (sender-side forensics)', () => {
    const s = summarizeRtcStats([audioOutbound(), videoOutbound()]);
    expect(s.audioBytesSent).toBe(7000);
    expect(s.videoBytesSent).toBe(90_000);
    // Outbound reports contribute nothing to the inbound-derived fields.
    expect(s.audioBytes).toBe(0);
    expect(s.videoBytes).toBe(0);
    expect(s.jitterMs).toBeNull();
    expect(s.lossPercent).toBeNull();
  });

  it('accepts mediaType in place of kind on outbound-rtp too', () => {
    const s = summarizeRtcStats([audioOutbound({ kind: undefined, mediaType: 'audio' })]);
    expect(s.audioBytesSent).toBe(7000);
  });
```

Then update every existing full-object `toEqual` on a summary (grep `audioBytes:` in this file, 7 hits at `6f9d0a4`) to include `audioBytesSent: 0, videoBytesSent: 0` next to `audioBytes`/`videoBytes`.

- [ ] **Step 2: Run the policy tests to see them fail**

Run: `nix develop -c npm run test -w ui -- ui/src/transport/__tests__/track-health-policy.test.ts`
Expected: FAIL. The new tests fail on `undefined`; the updated `toEqual`s fail on the missing keys.

- [ ] **Step 3: Extend the summary**

`ui/src/transport/track-health-policy.ts`. In `RtcStatsReportLike` after `bytesReceived?: number;` add:

```ts
  /** outbound-rtp: our sender's counter. Forensics only (spec Part 2). */
  bytesSent?: number;
```

In `RtcStatsSummary` after `videoBytes: number;` add:

```ts
  /** outbound-rtp bytesSent per kind; 0 when the kind is absent. Read by
   *  the request-track-refresh receipt log only, never by a decision. */
  audioBytesSent: number;
  videoBytesSent: number;
```

In `summarizeRtcStats`, add two locals after `let videoBytes = 0;`:

```ts
  let audioBytesSent = 0;
  let videoBytesSent = 0;
```

Inside the `for` loop, after the `inbound-rtp` block, add:

```ts
    if (report.type === 'outbound-rtp') {
      const kind = report.kind || report.mediaType;
      if (kind === 'audio') {
        audioBytesSent = report.bytesSent || 0;
      } else if (kind === 'video') {
        videoBytesSent = report.bytesSent || 0;
      }
    }
```

Change the return to `return { audioBytes, videoBytes, audioBytesSent, videoBytesSent, rttMs, jitterMs, lossPercent };`.

- [ ] **Step 4: Run the policy tests**

Run: `nix develop -c npm run test -w ui -- ui/src/transport/__tests__/track-health-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing wiring tests for the two log lines**

Append to `ui/src/__tests__/streams-store-wiring.test.ts`:

```ts
describe('stats forensics (2026-09-24 incident, spec Part 2)', () => {
  const flush = () => new Promise<void>(r => setTimeout(r, 0));
  const statsOf = (reports: Record<string, unknown>[]) => ({
    raw: new Map(reports.map((r, i) => [`r${i}`, r])) as unknown as RTCStatsReport,
  });

  it('logs our outbound bytes when a peer asks for a track refresh', async () => {
    const { transports, logger } = makeStarted();
    const media = transports.media!;
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    media.getStats = async () =>
      statsOf([
        { type: 'outbound-rtp', kind: 'audio', bytesSent: 1000 },
        { type: 'outbound-rtp', kind: 'video', bytesSent: 50_000 },
      ]);

    media.emit({
      type: 'data-channel-message',
      peer: peerA,
      connectionId: 'conn-1',
      data: encodeRtcAction('request-track-refresh'),
    });
    await flush();

    expect(
      logger.customMessages.some(m =>
        m.startsWith(`Track refresh outbound [${peerA.slice(0, 8)}]: audioSent=1000 videoSent=50000`)
      )
    ).toBe(true);
  });

  it('outbound log survives a rejecting getStats (Review Focus 4)', async () => {
    const { transports, logger } = makeStarted();
    const media = transports.media!;
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    media.getStats = async () => {
      throw new Error('pc closed');
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      media.emit({
        type: 'data-channel-message',
        peer: peerA,
        connectionId: 'conn-1',
        data: encodeRtcAction('request-track-refresh'),
      });
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toHaveLength(0);
    // The refresh receipt itself is still logged; only the stats line is absent.
    expect(
      logger.customMessages.some(m => m.includes('request-track-refresh received from'))
    ).toBe(true);
    expect(logger.customMessages.some(m => m.includes('Track refresh outbound'))).toBe(false);
  });

  it('logs a candidate-pair state histogram when no pair succeeded 2s after connected', async () => {
    const { transports, logger, clock } = makeStarted();
    const media = transports.media!;
    media.setIceConnectionState(peerA, 'connected');
    media.getStats = async () =>
      statsOf([
        { type: 'candidate-pair', state: 'in-progress' },
        { type: 'candidate-pair', state: 'failed' },
        { type: 'candidate-pair', state: 'failed' },
        { type: 'inbound-rtp', kind: 'audio', bytesReceived: 1 },
      ]);
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');

    clock.advance(2000);
    await flush();

    const line = logger.customMessages.find(m =>
      m.startsWith(`ICE pair [${peerA.slice(0, 8)}]: no succeeded pair`)
    );
    expect(line).toBeDefined();
    expect(line).toContain('states=in-progress=1,failed=2');
    expect(line).toContain('ice=connected');
    // Negative control: the succeeded-pair line is NOT logged.
    expect(logger.customMessages.some(m => /ICE pair \[.*\]: local=/.test(m))).toBe(false);
  });

  it('stays silent about states when a pair did succeed (existing line only)', async () => {
    const { transports, logger, clock } = makeStarted();
    const media = transports.media!;
    media.getStats = async () =>
      statsOf([
        { id: 'p', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' },
        { id: 'l', type: 'local-candidate', candidateType: 'srflx', address: '1.2.3.4', port: 1, protocol: 'udp' },
        { id: 'r', type: 'remote-candidate', candidateType: 'relay', address: '5.6.7.8', port: 2 },
      ]);
    media.emitPhase(peerA, 'conn-1', 'signaling');
    media.emitPhase(peerA, 'conn-1', 'connected', 'connecting');
    clock.advance(2000);
    await flush();
    expect(logger.customMessages.some(m => m.includes('no succeeded pair'))).toBe(false);
    expect(logger.customMessages.some(m => m.includes(`ICE pair [${peerA.slice(0, 8)}]: local=srflx`))).toBe(true);
  });
});
```

Note on the succeeded-pair test: the sampler indexes reports by `report.id` (`reportsById[report.id]`), so those reports carry explicit `id` fields. The `Map` keys are irrelevant to it.

- [ ] **Step 6: Run the wiring tests to see them fail**

Run: `nix develop -c npm run test -w ui -- ui/src/__tests__/streams-store-wiring.test.ts -t "stats forensics"`
Expected: the first and third tests FAIL (no such log lines). The second and fourth can pass already. Make sure that the first and third are red.

- [ ] **Step 7: Log outbound bytes on refresh receipt**

`ui/src/track-health.ts`, in `refreshTracksForPeer`, immediately after the line `const connInfo = this.bindings.openConnections()[pubKeyB64];` and BEFORE the `if (!mainStream || !connInfo)` guard, add:

```ts
    // Forensics (2026-09-24 incident, spec Part 2): the peer says our
    // media is dead. Record what our sender thinks it sent, so an export
    // shows whether the encoder or the path is at fault. Fire-and-forget;
    // this method stays synchronous for its data-channel caller.
    if (connInfo) void this._logOutboundForRefresh(pubKeyB64);
```

Add the private method after `refreshTracksForPeer`:

```ts
  private async _logOutboundForRefresh(pubKeyB64: AgentPubKeyB64): Promise<void> {
    try {
      const stats = await this.bindings.mediaTransport().getStats(pubKeyB64);
      if (!stats) return;
      const reports: RtcStatsReportLike[] = [];
      stats.raw.forEach((report: RtcStatsReportLike) => reports.push(report));
      const s = summarizeRtcStats(reports);
      this.bindings.logger.logCustomMessage(
        `Track refresh outbound [${pubKeyB64.slice(0, 8)}]: audioSent=${s.audioBytesSent} videoSent=${s.videoBytesSent} rtt=${s.rttMs ?? 'n/a'}ms`
      );
    } catch (_e) {
      // getStats may fail if the connection was already closed
    }
  }
```

- [ ] **Step 8: Log the pair-state histogram in the sampler**

`ui/src/media-links.ts`, inside the `setTimeout` callback at the end of `_handleMediaConnected`. Add `let sawSucceededPair = false;` next to `let isRelayed = false;`. Inside the `forEach` over `Object.values(reportsById)`, at the top of the `if (report.type === 'candidate-pair' && report.state === 'succeeded')` block, add `sawSucceededPair = true;`. After that `forEach` and before `this._openConnections.update(…)`, add:

```ts
        if (!sawSucceededPair) {
          // Forensics (2026-09-24 incident, spec Part 2): the FSM said
          // `connected` but no candidate pair had succeeded 2s later on
          // either side of the dead link, and this sampler said nothing.
          const states: Record<string, number> = {};
          Object.values(reportsById).forEach((report: any) => {
            if (report.type !== 'candidate-pair') return;
            const state = report.state ?? 'unknown';
            states[state] = (states[state] ?? 0) + 1;
          });
          const histogram =
            Object.entries(states).map(([k, v]) => `${k}=${v}`).join(',') || 'none';
          this.bindings.logger.logCustomMessage(
            `ICE pair [${pubKeyB64.slice(0, 8)}]: no succeeded pair 2s after connected; states=${histogram} ice=${transport.getIceConnectionState(pubKeyB64) ?? 'unknown'}`
          );
        }
```

`transport` is the local already declared at the top of `_handleMediaConnected`.

- [ ] **Step 9: Run the focused tests, then the gate**

Run: `nix develop -c npm run test -w ui -- ui/src/__tests__/streams-store-wiring.test.ts ui/src/transport/__tests__/track-health-policy.test.ts`
Expected: PASS.
Run: `nix develop -c npm run verify`
Expected: green.

- [ ] **Step 10: Commit**

```bash
git add ui/src/transport/track-health-policy.ts ui/src/transport/__tests__/track-health-policy.test.ts ui/src/track-health.ts ui/src/media-links.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "forensics: outbound bytes on request-track-refresh receipt, pair-state histogram when no pair succeeded

The 2026-09-24 export shows 20 refresh requests answered with
replaceTrack and no way to tell whether the sender was producing bytes,
and no ICE pair line at all on the dead link after the ICE restart
because the sampler logs only succeeded pairs. summarizeRtcStats gains
audioBytesSent/videoBytesSent (table-tested); both additions are
log-only. Spec: docs/superpowers/specs/2026-09-24-dead-track-escalation-design.md"
```

---

### Task 3: The escalation decision (pure) and the two PeerRecord fields

**Why (log):** `kSPd2S "Dead track [uhCAk1VO]: audio=2 video=2 cycles stale"` appears 18 times between 10:13:04 and 10:14:14, one every 4 s, each followed on Eric's side by a `replaceTrack` that changed nothing. `decideTrackRefresh` (`ui/src/transport/track-health-policy.ts:170-197`) has two arms, `request-refresh` and `none`, and the caller resets the counters after every send, so the loop has no end.

**Files:**
- Modify: `ui/src/transport/track-health-policy.ts:118-197`
- Modify: `ui/src/peer-record.ts` (two fields, two arms)
- Test: `ui/src/transport/__tests__/track-health-policy.test.ts`, `ui/src/__tests__/peer-record.test.ts`

**Interfaces:**
- Produces:
  - `export const DEAD_TRACK_REFRESH_BUDGET = 3;`
  - `export const DEAD_TRACK_ESCALATION_BACKOFF_CAP = 3;`
  - `export function deadTrackRefreshBudget(priorEscalations: number): number`
  - `TrackRefreshInputs` gains `refreshRequestsSent: number; refreshBudget: number;`
  - `TrackRefreshDecision` gains `{ action: 'escalate'; nextStale: StaleCycleCounts; reason: 'refresh-budget-exhausted' }`, and the `none` arm gains `resetRefreshBudget: boolean`.
  - `PeerRecord.refreshRequestsSent?: number` (wiped by `media-close-full`) and `PeerRecord.deadTrackEscalations?: number` (wiped by `media-leave-residue` only).
- Consumed by Task 4.

- [ ] **Step 1: Write the failing policy tests**

In `ui/src/transport/__tests__/track-health-policy.test.ts`, extend the import to include `DEAD_TRACK_REFRESH_BUDGET`, `DEAD_TRACK_ESCALATION_BACKOFF_CAP`, `deadTrackRefreshBudget`. Extend `base`:

```ts
const base: TrackRefreshInputs = {
  videoExpected: true,
  audioExpected: true,
  audioBytes: 2000,
  videoBytes: 60_000,
  lastBytes: { audio: 1000, video: 50_000 },
  staleCycles: { audio: 0, video: 0 },
  staleThresholdCycles: STALE_CYCLES_REFRESH_THRESHOLD,
  refreshRequestsSent: 0,
  refreshBudget: DEAD_TRACK_REFRESH_BUDGET,
};
```

Update every existing `action: 'none'` expectation in this describe to carry `resetRefreshBudget`: `true` when the expected `nextStale` is `{ audio: 0, video: 0 }`, `false` otherwise. (At `6f9d0a4` the first test expects `true`, the second `false`; check the rest the same way.)

Add these tests inside `describe('decideTrackRefresh', …)`:

```ts
  it('escalates instead of requesting once the refresh budget is spent', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 1000,
      staleCycles: { audio: 1, video: 0 },
      refreshRequestsSent: DEAD_TRACK_REFRESH_BUDGET,
    });
    expect(d).toEqual({
      action: 'escalate',
      nextStale: { audio: 2, video: 0 },
      reason: 'refresh-budget-exhausted',
    });
  });

  it('still requests while the budget has room', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 1000,
      staleCycles: { audio: 1, video: 0 },
      refreshRequestsSent: DEAD_TRACK_REFRESH_BUDGET - 1,
    });
    expect(d.action).toBe('request-refresh');
  });

  it('a larger budget (prior escalations) delays escalation', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 1000,
      staleCycles: { audio: 1, video: 0 },
      refreshRequestsSent: DEAD_TRACK_REFRESH_BUDGET,
      refreshBudget: deadTrackRefreshBudget(1),
    });
    expect(d.action).toBe('request-refresh');
  });

  it('never-started kinds do not move counters or escalate (Review Focus 1)', () => {
    const d = decideTrackRefresh({
      ...base,
      audioBytes: 0,
      videoBytes: 0,
      lastBytes: { audio: 0, video: 0 },
      refreshRequestsSent: 99,
      refreshBudget: 1,
    });
    expect(d).toEqual({
      action: 'none',
      nextStale: { audio: 0, video: 0 },
      reason: 'flowing',
      resetRefreshBudget: true,
    });
  });

  it('a partially frozen link does not reset the budget', () => {
    const d = decideTrackRefresh({
      ...base,
      videoBytes: 50_000, // frozen
      staleCycles: { audio: 0, video: 0 },
    });
    expect(d).toEqual({
      action: 'none',
      nextStale: { audio: 0, video: 1 },
      reason: 'flowing',
      resetRefreshBudget: false,
    });
  });
});

describe('deadTrackRefreshBudget', () => {
  it.each([
    [0, 3],
    [1, 6],
    [2, 12],
    [3, 24],
    [4, 24],
    [10, 24],
  ])('prior escalations %i → budget %i', (prior, budget) => {
    expect(deadTrackRefreshBudget(prior)).toBe(budget);
  });

  it('is derived from the two named constants', () => {
    expect(deadTrackRefreshBudget(0)).toBe(DEAD_TRACK_REFRESH_BUDGET);
    expect(deadTrackRefreshBudget(DEAD_TRACK_ESCALATION_BACKOFF_CAP + 5)).toBe(
      DEAD_TRACK_REFRESH_BUDGET << DEAD_TRACK_ESCALATION_BACKOFF_CAP
    );
  });
```

(The last `});` above closes the new `describe('deadTrackRefreshBudget')`; keep the file's brace balance.)

- [ ] **Step 2: Write the failing record tests**

`ui/src/__tests__/peer-record.test.ts`. In `fullRecord()` add, after `reconcileAttemptCount: 6,`: `refreshRequestsSent: 15,` and after `signalsRttEwma: 13,`: `deadTrackEscalations: 16,`.

In the `media-close-full` expectation add `refreshRequestsSent: undefined,` after `staleCycles: undefined, reconcileAttemptCount: undefined,`.

In the `media-leave-residue` expectation add `deadTrackEscalations: undefined,` after `lastReconcileTime: undefined, signalsRttEwma: undefined,`.

Add one test to `describe('resetPeerRecord', …)`:

```ts
  it('deadTrackEscalations survives the media close it triggers and dies only on leave', () => {
    const afterClose = resetPeerRecord(fullRecord(), 'media-close-full');
    expect(afterClose.deadTrackEscalations).toBe(16);
    expect(afterClose.refreshRequestsSent).toBeUndefined();
    const afterLeave = resetPeerRecord(afterClose, 'media-leave-residue');
    expect(afterLeave.deadTrackEscalations).toBeUndefined();
  });
```

- [ ] **Step 3: Run both suites to see them fail**

Run: `nix develop -c npm run test -w ui -- ui/src/transport/__tests__/track-health-policy.test.ts ui/src/__tests__/peer-record.test.ts`
Expected: FAIL. Type errors on the new fields and imports, and the new expectations.

- [ ] **Step 4: Implement the policy**

`ui/src/transport/track-health-policy.ts`. After the `STALE_CYCLES_REFRESH_THRESHOLD` export add:

```ts
/**
 * Refresh requests a connection may spend on a frozen track before the
 * receiver escalates to a close + re-establish. Serves the media-flowing
 * predicate on the track-health poll's clock (`PING_INTERVAL`): with
 * STALE_CYCLES_REFRESH_THRESHOLD = 2 and a 2s poll, requests go out at
 * t≈4/8/12s and escalation fires at t≈16s. NOT a liveness constant.
 * 2026-09-24 incident: 18 dead-track cycles over 70s with no exit.
 */
export const DEAD_TRACK_REFRESH_BUDGET = 3;

/**
 * Cap on the doubling of the budget across successive escalations to
 * the same peer (3, 6, 12, 24, 24, …). Bounds a pathological loop where
 * the fresh connection is also dead, without ever giving up.
 */
export const DEAD_TRACK_ESCALATION_BACKOFF_CAP = 3;

/** The refresh budget for a connection, given how many times this peer
 *  has already been escalated since it last left. */
export function deadTrackRefreshBudget(priorEscalations: number): number {
  const exp = Math.max(0, Math.min(priorEscalations, DEAD_TRACK_ESCALATION_BACKOFF_CAP));
  return DEAD_TRACK_REFRESH_BUDGET << exp;
}
```

Extend `TrackRefreshInputs`:

```ts
  /** Refresh requests already sent on this connection without bytes
   *  resuming (the peer record's `refreshRequestsSent`). */
  refreshRequestsSent: number;
  /** Requests allowed before escalation: `deadTrackRefreshBudget(...)`. */
  refreshBudget: number;
```

Replace `TrackRefreshDecision`:

```ts
export type TrackRefreshDecision =
  | {
      action: 'request-refresh';
      nextStale: StaleCycleCounts;
      reason: 'stale-cycles-exceeded';
    }
  | {
      /** The budget is spent: close the connection and let the pong
       *  drive re-establish it. */
      action: 'escalate';
      nextStale: StaleCycleCounts;
      reason: 'refresh-budget-exhausted';
    }
  | {
      action: 'none';
      nextStale: StaleCycleCounts;
      reason: 'flowing';
      /** True when both counters are zero (bytes resumed on every
       *  expected kind): the caller zeroes `refreshRequestsSent`. */
      resetRefreshBudget: boolean;
    };
```

Replace the tail of `decideTrackRefresh` (from the threshold check to the end):

```ts
  const crossed =
    nextStale.video >= input.staleThresholdCycles ||
    nextStale.audio >= input.staleThresholdCycles;
  if (crossed) {
    if (input.refreshRequestsSent >= input.refreshBudget) {
      return { action: 'escalate', nextStale, reason: 'refresh-budget-exhausted' };
    }
    return { action: 'request-refresh', nextStale, reason: 'stale-cycles-exceeded' };
  }
  return {
    action: 'none',
    nextStale,
    reason: 'flowing',
    resetRefreshBudget: nextStale.audio === 0 && nextStale.video === 0,
  };
}
```

Update the function's doc comment: after the sentence about the caller resetting counters, add "The caller increments `refreshRequestsSent` on the same condition. `escalate` replaces `request-refresh` once that count reaches `refreshBudget`; a `none` with `resetRefreshBudget` zeroes it."

- [ ] **Step 5: Add the record fields and arms**

`ui/src/peer-record.ts`. In the "media-session bookkeeping" group, after `reconcileAttemptCount?: number;`:

```ts
  /**
   * Refresh requests sent on the current connection without inbound
   * bytes resuming. Input to `decideTrackRefresh`'s escalation arm.
   * Zeroed when bytes resume; wiped on media close.
   */
  refreshRequestsSent?: number;
```

In the "close survivors" group, after `signalsRttEwma?: number;`:

```ts
  /**
   * How many times the dead-track escalation closed this peer's media
   * link since the peer last left. Doubles the next connection's refresh
   * budget (`deadTrackRefreshBudget`). A close survivor by necessity:
   * it must outlive the close it triggers. Reset on peer-leave only.
   */
  deadTrackEscalations?: number;
```

In `resetPeerRecord`, the `media-close-full` arm adds `refreshRequestsSent: undefined,` after `staleCycles: undefined, reconcileAttemptCount: undefined,`. The `media-leave-residue` arm adds `deadTrackEscalations: undefined,` after `signalsRttEwma: undefined,`.

- [ ] **Step 6: Run both suites, then the gate**

Run: `nix develop -c npm run test -w ui -- ui/src/transport/__tests__/track-health-policy.test.ts ui/src/__tests__/peer-record.test.ts`
Expected: PASS.
Run: `nix develop -c npm run verify`
Expected: `tsc` FAILS in `ui/src/track-health.ts` because `decideTrackRefresh` is called without the two new inputs. That is expected between Task 3 and Task 4. To keep the branch green at every commit, add the minimal caller change now: in `ui/src/track-health.ts` `checkTrackHealth`, pass `refreshRequestsSent: this.bindings.peerRecord(pubKeyB64)?.refreshRequestsSent ?? 0,` and `refreshBudget: deadTrackRefreshBudget(this.bindings.peerRecord(pubKeyB64)?.deadTrackEscalations ?? 0),` (import `deadTrackRefreshBudget`), and leave the `if (decision.action === 'request-refresh')` block as it is. With this, `escalate` is decided but not yet acted on. Task 4 replaces that block. Re-run the gate.
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add ui/src/transport/track-health-policy.ts ui/src/transport/__tests__/track-health-policy.test.ts ui/src/peer-record.ts ui/src/__tests__/peer-record.test.ts ui/src/track-health.ts
git commit -m "policy: decideTrackRefresh gains a refresh budget and an escalate arm; PeerRecord gains the two counters

Pure decision + record fields only; the executor lands next. Budget
3 << min(priorEscalations, 3) per connection, serving the media-flowing
predicate on the track-health poll clock. From the 2026-09-24 export:
18 dead-track cycles in 70s with no exit. Spec:
docs/superpowers/specs/2026-09-24-dead-track-escalation-design.md"
```

---

### Task 4: The escalation executor and its wiring tests

**Why (log):** the human exit from the loop was the Reconnect click at `1790259254586 k1VOFk` at +70 s. The fresh links at 10:16:20 established in 2.4 s (`Connected` at `1790259382241`, `1790259382565`, `1790259383360`, `1790259383647`), so a close + re-establish is the recovery that is known to work on this pair. The close must go through the transport so the peer receives the `leave` (`ConnectionManager.closeConnection`, `packages/webrtc-peer/src/connection-manager.ts:283-292`) and the existing `closeCleanupPlan` row runs.

**Files:**
- Modify: `ui/src/track-health.ts:73-140` (`checkTrackHealth`)
- Modify: `ui/src/logging.ts` (type union and taxonomy)
- Test: `ui/src/__tests__/event-taxonomy.test.ts` (snapshot), `ui/src/__tests__/streams-store-wiring.test.ts` (new describe)

**Interfaces:**
- Consumes (Task 3): `deadTrackRefreshBudget`, `TrackRefreshDecision`'s `escalate` arm and `resetRefreshBudget`, `PeerRecord.refreshRequestsSent` / `.deadTrackEscalations`.
- Consumes (existing): `TrackHealthBindings.mediaTransport().closeConnection(peer, reason)`, `TrackHealthBindings.sendRtcAction` (returns the send count), `PeerTransport` close contract (emits `closed` synchronously).
- Produces: `SimpleEventType` member `'DeadTrackEscalation'`; the close reason string `'dead-track-escalation'`.

- [ ] **Step 1: Write the failing wiring tests**

Append to `ui/src/__tests__/streams-store-wiring.test.ts`:

```ts
describe('dead-track escalation (2026-09-24 incident, spec Part 1)', () => {
  const inbound = (audioBytes: number) => ({
    raw: new Map([
      ['a', { type: 'inbound-rtp', kind: 'audio', bytesReceived: audioBytes, packetsReceived: 1 }],
    ]) as unknown as RTCStatsReport,
  });

  /** Open a connected media slot to peerA that expects audio, with
   *  getStats scripted from a mutable byte counter. The slot's `audio`
   *  flag is set directly: the remote-stream glue would route an audio
   *  track into the analyser, which needs an AudioContext node lacks. */
  function openStalledLink(connectionId = 'conn-1') {
    const started = makeStarted();
    const media = started.transports.media!;
    const counter = { bytes: 1000 };
    media.getStats = async () => inbound(counter.bytes);
    media.emitPhase(peerA, connectionId, 'signaling');
    media.emitPhase(peerA, connectionId, 'connected', 'connecting');
    get(started.store._openConnections)[peerA].audio = true;
    return { ...started, media, counter };
  }

  const refreshFramesTo = (media: FakeTransport, peer: string) =>
    media.sentData.filter(d => d.peer === peer && d.data === encodeRtcAction('request-track-refresh')).length;

  const poll = async (store: StreamsStore, n: number) => {
    for (let i = 0; i < n; i += 1) await store.trackHealth.checkTrackHealth();
  };

  it('(a) requests DEAD_TRACK_REFRESH_BUDGET refreshes, then closes with the named reason', async () => {
    const { store, media, logger } = openStalledLink();
    // Bytes frozen at 1000 from the first poll on. Crossings happen on
    // polls 3, 5, 7 (requests) and 9 (escalation).
    await poll(store, 8);
    expect(refreshFramesTo(media, peerA)).toBe(DEAD_TRACK_REFRESH_BUDGET);
    expect(media.closeCalls.some(c => c.peer === peerA)).toBe(false);
    expect(store._peerRecord(peerA)?.refreshRequestsSent).toBe(DEAD_TRACK_REFRESH_BUDGET);

    await poll(store, 1);
    expect(media.closeCalls).toContainEqual({ peer: peerA, reason: 'dead-track-escalation' });
    expect(get(store._openConnections)[peerA]).toBeUndefined();
    const ev = logger.eventsNamed('DeadTrackEscalation');
    expect(ev).toHaveLength(1);
    expect(ev[0].agent).toBe(peerA);
    expect(ev[0].connectionId).toBe('conn-1');
    expect(ev[0].detail).toContain(`refreshes=${DEAD_TRACK_REFRESH_BUDGET} budget=${DEAD_TRACK_REFRESH_BUDGET}`);
    // The close ran the existing cleanup row: session bookkeeping wiped,
    // the escalation count survived, lastDisconnectTime stamped.
    expect(store._peerRecord(peerA)?.refreshRequestsSent).toBeUndefined();
    expect(store._peerRecord(peerA)?.staleCycles).toBeUndefined();
    expect(store._peerRecord(peerA)?.deadTrackEscalations).toBe(1);
    expect(store._peerRecord(peerA)?.lastDisconnectTime).toBeDefined();
    expect(logger.eventsNamed('CarrierSwitch').some(e => e.detail?.includes('webrtc->signals'))).toBe(true);
  });

  it('(b) the next connection to the same peer gets the doubled budget', async () => {
    const { store, media } = openStalledLink();
    await poll(store, 2 * DEAD_TRACK_REFRESH_BUDGET + 3); // through the first escalation
    expect(store._peerRecord(peerA)?.deadTrackEscalations).toBe(1);
    media.sentData.length = 0;
    media.closeCalls.length = 0;

    media.emitPhase(peerA, 'conn-2', 'signaling');
    media.emitPhase(peerA, 'conn-2', 'connected', 'connecting');
    get(store._openConnections)[peerA].audio = true;
    const budget = deadTrackRefreshBudget(1);
    expect(budget).toBe(2 * DEAD_TRACK_REFRESH_BUDGET);
    await poll(store, 2 * budget + 2);
    expect(refreshFramesTo(media, peerA)).toBe(budget);
    expect(media.closeCalls).toHaveLength(0);
    await poll(store, 1);
    expect(media.closeCalls).toContainEqual({ peer: peerA, reason: 'dead-track-escalation' });
    expect(store._peerRecord(peerA)?.deadTrackEscalations).toBe(2);
  });

  it('(c) bytes resuming resets the refresh budget', async () => {
    const { store, media, counter } = openStalledLink();
    await poll(store, 3); // one request
    expect(refreshFramesTo(media, peerA)).toBe(1);
    expect(store._peerRecord(peerA)?.refreshRequestsSent).toBe(1);

    counter.bytes = 2000; // flow resumes
    await poll(store, 1);
    expect(store._peerRecord(peerA)?.refreshRequestsSent).toBe(0);

    // Freeze again: a full budget is available before escalation.
    await poll(store, 2 * DEAD_TRACK_REFRESH_BUDGET + 1);
    expect(refreshFramesTo(media, peerA)).toBe(1 + DEAD_TRACK_REFRESH_BUDGET);
    expect(media.closeCalls.some(c => c.peer === peerA)).toBe(false);
    await poll(store, 1);
    expect(media.closeCalls).toContainEqual({ peer: peerA, reason: 'dead-track-escalation' });
  });

  it('(d) a failed refresh send does not consume the budget (Review Focus 2)', async () => {
    const { store, media } = openStalledLink();
    media.send = () => {
      throw new Error('data channel closed');
    };
    await poll(store, 3); // first crossing: send throws, count 0
    expect(store._peerRecord(peerA)?.refreshRequestsSent ?? 0).toBe(0);
    // Stale counters were NOT reset (the existing rule), so the next
    // poll crosses again and retries the send.
    expect(store._peerRecord(peerA)?.staleCycles?.audio).toBeGreaterThanOrEqual(2);
    await poll(store, 1);
    expect(store._peerRecord(peerA)?.refreshRequestsSent ?? 0).toBe(0);
    expect(media.closeCalls.some(c => c.peer === peerA)).toBe(false);
  });

  it('(e) escalation on a vanished transport resets the counters and does not repeat next poll (Review Focus 3)', async () => {
    const { store, media, logger } = openStalledLink();
    media.vanish(peerA); // the §3.1(c) shape: no closed event will ever come
    await poll(store, 2 * DEAD_TRACK_REFRESH_BUDGET + 3);
    expect(media.closeCalls).toContainEqual({ peer: peerA, reason: 'dead-track-escalation' });
    // Bounded exception: the slot outlives the transport. The executor
    // must have zeroed its own counters so the cycle restarts with the
    // doubled budget instead of escalating every poll.
    expect(get(store._openConnections)[peerA]).toBeDefined();
    expect(store._peerRecord(peerA)?.staleCycles).toEqual({ audio: 0, video: 0 });
    expect(store._peerRecord(peerA)?.refreshRequestsSent).toBe(0);
    expect(store._peerRecord(peerA)?.deadTrackEscalations).toBe(1);
    await poll(store, 2);
    expect(logger.eventsNamed('DeadTrackEscalation')).toHaveLength(1);
    expect(media.closeCalls.filter(c => c.reason === 'dead-track-escalation')).toHaveLength(1);
  });
});
```

Add to the file's imports: `DEAD_TRACK_REFRESH_BUDGET, deadTrackRefreshBudget` from `'../transport/track-health-policy'`.

Add `"DeadTrackEscalation": "emitted",` to the inline snapshot in `ui/src/__tests__/event-taxonomy.test.ts` between the `"ConnectionAborted"` and `"FsmClose"` lines.

- [ ] **Step 2: Run to see them fail**

Run: `nix develop -c npm run test -w ui -- ui/src/__tests__/streams-store-wiring.test.ts -t "dead-track escalation" ui/src/__tests__/event-taxonomy.test.ts`
Expected: FAIL. (a) fails at the `closeCalls` assertion (no escalation executor yet), the snapshot fails on the missing key.

- [ ] **Step 3: Add the event type**

`ui/src/logging.ts`. In `SimpleEventType`, after `| 'StaleCleanup'`:

```ts
  // Receiver-side dead-track escalation: inbound bytes stayed frozen
  // through the refresh budget, so the media link was closed for the
  // pong drive to re-establish (track-health-policy.ts,
  // DEAD_TRACK_REFRESH_BUDGET). detail: refreshes=N budget=B prior=P
  // audioStale=A videoStale=V.
  | 'DeadTrackEscalation'
```

In `SIMPLE_EVENT_TAXONOMY`, after `StaleCleanup: 'emitted',`: `DeadTrackEscalation: 'emitted',`.

- [ ] **Step 4: Implement the executor**

`ui/src/track-health.ts`, in `checkTrackHealth`. Replace everything from `const decision = decideTrackRefresh({` through the end of the `if (decision.action === 'request-refresh') { … }` block with:

```ts
        const record = this.bindings.peerRecord(pubKeyB64);
        const priorEscalations = record?.deadTrackEscalations ?? 0;
        const refreshBudget = deadTrackRefreshBudget(priorEscalations);
        const decision = decideTrackRefresh({
          videoExpected: connInfo.video,
          audioExpected: connInfo.audio,
          audioBytes: summary.audioBytes,
          videoBytes: summary.videoBytes,
          lastBytes: record?.lastBytesReceived || { audio: 0, video: 0 },
          staleCycles: record?.staleCycles || { audio: 0, video: 0 },
          staleThresholdCycles: STALE_CYCLES_REFRESH_THRESHOLD,
          refreshRequestsSent: record?.refreshRequestsSent ?? 0,
          refreshBudget,
        });

        this.bindings.ensurePeerRecord(pubKeyB64).lastBytesReceived = {
          audio: summary.audioBytes,
          video: summary.videoBytes,
        };
        this.bindings.ensurePeerRecord(pubKeyB64).staleCycles = decision.nextStale;

        switch (decision.action) {
          case 'none':
            if (decision.resetRefreshBudget) {
              this.bindings.ensurePeerRecord(pubKeyB64).refreshRequestsSent = 0;
            }
            break;
          case 'request-refresh': {
            const stale = decision.nextStale;
            console.warn(
              `Dead track detected for ${pubKeyB64.slice(0, 8)}: audio stale=${stale.audio}, video stale=${stale.video}`
            );
            this.bindings.logger.logCustomMessage(
              `Dead track [${pubKeyB64.slice(0, 8)}]: audio=${stale.audio} video=${stale.video} cycles stale`
            );
            if (this.bindings.sendRtcAction('request-track-refresh', [pubKeyB64]) > 0) {
              // Reset stale count to avoid spamming; the budget counts
              // only requests that actually went out (Review Focus 2).
              const r = this.bindings.ensurePeerRecord(pubKeyB64);
              r.staleCycles = { audio: 0, video: 0 };
              r.refreshRequestsSent = (r.refreshRequestsSent ?? 0) + 1;
            }
            break;
          }
          case 'escalate': {
            // Spec Part 1 (2026-09-24 incident): replaceTrack cannot
            // repair a transport-level fault, and the link was left
            // `connected` for 70s with no exit. Close through the
            // transport so the peer gets the `leave`; the existing
            // close-event cleanup row and the pong drive do the rest.
            const stale = decision.nextStale;
            const spent = record?.refreshRequestsSent ?? 0;
            this.bindings.logger.logAgentEvent({
              agent: pubKeyB64,
              timestamp: this.bindings.now(),
              event: 'DeadTrackEscalation',
              connectionId: connInfo.connectionId,
              detail: `refreshes=${spent} budget=${refreshBudget} prior=${priorEscalations} audioStale=${stale.audio} videoStale=${stale.video}`,
            });
            // Bump the survivor BEFORE the close: media-close-full keeps
            // it, and the next connection reads it for its budget. Zero
            // the session counters too: when the close clears the slot
            // this is redundant, and when it cannot (transport vanished
            // with no event, the §3.1(c) shape) it stops the escalation
            // from re-firing every poll (Review Focus 3).
            const r = this.bindings.ensurePeerRecord(pubKeyB64);
            r.deadTrackEscalations = priorEscalations + 1;
            r.staleCycles = { audio: 0, video: 0 };
            r.refreshRequestsSent = 0;
            this.bindings.mediaTransport().closeConnection(pubKeyB64, 'dead-track-escalation');
            break;
          }
          default: {
            const exhaustive: never = decision;
            void exhaustive;
          }
        }
```

Update the import from `./transport/track-health-policy` to include `deadTrackRefreshBudget` (already added in Task 3 step 6 if that interim change was made; keep one import). Update the class doc comment's phrase "the two-tier (replaceTrack, then full reconnect) recovery ladder" to "the three-rung recovery ladder: replaceTrack via request-track-refresh, escalation to a close once the refresh budget is spent (`DEAD_TRACK_REFRESH_BUDGET`), and the reconcile path's reconnect fallback".

- [ ] **Step 5: Run the focused tests**

Run: `nix develop -c npm run test -w ui -- ui/src/__tests__/streams-store-wiring.test.ts -t "dead-track escalation" ui/src/__tests__/event-taxonomy.test.ts`
Expected: PASS, all five plus the snapshot.

If (e) fails on `closeCalls`: `FakeTransport.closeConnection` records the call even without a connection id, so that assertion holds against the fake as written at `6f9d0a4`. If (e) fails on the slot being undefined instead, the fake emitted `closed`, which means `vanish` did not run before the poll. Look at the call order in the test.

- [ ] **Step 6: Run the gate**

Run: `nix develop -c npm run verify`
Expected: green. Pay attention to `event-taxonomy.test.ts`'s emission grep: the `event: 'DeadTrackEscalation',` literal must be on its own line.

- [ ] **Step 7: Commit**

```bash
git add ui/src/track-health.ts ui/src/logging.ts ui/src/__tests__/event-taxonomy.test.ts ui/src/__tests__/streams-store-wiring.test.ts
git commit -m "track-health: escalate a dead track to a close once the refresh budget is spent

Declared behavior change: a connected media link whose inbound bytes
stay frozen through DEAD_TRACK_REFRESH_BUDGET refresh requests is
closed with reason 'dead-track-escalation' and re-established by the
existing pong drive (about 16s after the freeze, instead of never). The
2026-09-24 export shows the link Eric<->Uruguay held 'connected' with
Uruguay receiving nothing for 70s until a manual Reconnect. Escalations
per peer double the next budget (3, 6, 12, 24) and reset on peer-leave.
Spec: docs/superpowers/specs/2026-09-24-dead-track-escalation-design.md"
```

---

### Task 5: Doc-sync

**Files:**
- Modify: `CLAUDE.md` ("True today" section, one new bullet)
- Modify: `docs/superpowers/specs/2026-09-24-dead-track-escalation-design.md` (landed markers)
- Modify: `ui/src/__tests__/claude-md-drift.test.ts` only if it rejects the new bullet (it rejects numeric test-count claims; the bullet below has none)

- [ ] **Step 1: Add the CLAUDE.md bullet**

Insert after the "Presence-loop round facts" bullet, before the `nix develop -c npm run verify` bullet:

```markdown
- **Dead-track escalation round facts** (landed 2026-09-24 on branch `dead-track-escalation` off `main-0.7` @ `6f9d0a4`; root-caused from the 2026-09-24 `Presence_merged_0.15.6` field export, analysis in `docs/superpowers/specs/2026-09-24-dead-track-escalation-design.md`; per-task detail in `docs/superpowers/plans/2026-09-24-dead-track-escalation.md`; whether the merge has reached a given line is checked with `git merge-base --is-ancestor <merge hash> <branch>`, never trusted from this line). `decideTrackRefresh` (`ui/src/transport/track-health-policy.ts`) has a third arm, `escalate`, reached once `refreshRequestsSent` meets `deadTrackRefreshBudget(priorEscalations)` (`DEAD_TRACK_REFRESH_BUDGET` = 3, doubled per prior escalation up to `DEAD_TRACK_ESCALATION_BACKOFF_CAP` = 3; both serve the media-flowing predicate on the track-health poll clock, declared NOT-liveness). `TrackHealthMonitor.checkTrackHealth` executes it by logging `DeadTrackEscalation` and calling `mediaTransport().closeConnection(peer, 'dead-track-escalation')`; teardown and re-establishment are the unchanged `closeCleanupPlan` close-event row and the pong drive. Declared behavior change: a `connected` media slot with frozen inbound bytes is closed about 16 s after the freeze instead of staying open indefinitely (the bounded exception in the Post-Phase 1 carrier facts is bounded again). `PeerRecord` gained `refreshRequestsSent` (media-session, wiped by `media-close-full`) and `deadTrackEscalations` (close survivor, wiped by `media-leave-residue`), both pinned in `peer-record.test.ts`; the executor also zeroes its own counters on escalation so a vanished-transport slot cannot re-escalate every poll (wiring test (e)). Forensics, log-only: `TrackMuted` event plus a log-only `onunmute` on tracks that arrived unmuted (`_handleMediaRemoteTrack`); the 2 s pair sampler logs a `candidate-pair` state histogram when no pair succeeded; `summarizeRtcStats` reports `audioBytesSent`/`videoBytesSent` and `refreshTracksForPeer` logs them on `request-track-refresh` receipt; `StreamsStore.disconnectFromPeerVideo(peer, reason)` requires a reason and its five callers name themselves (`reconnect-button`, `carrier-mode-signals`, `peer-carrier-change`, `peer-disabled-webrtc`, `block`). Not planned, with triggers recorded in the spec's "Considered and not planned": signals coverage for a connected-but-stalled slot, a data-channel re-init hint from the lower peer, re-adding transport `restartIce`, per-poll relay re-sampling.
```

- [ ] **Step 2: Mark the spec's parts landed**

In the spec, under "## Design", change the two part headings to `### Part 1: escalation, receiver side (LANDED, Tasks 3 and 4)` and `### Part 2: forensics (LANDED, Tasks 1 and 2)`. In "## Definition of done", replace the paragraph with "Met on branch `dead-track-escalation` at `<final commit hash>`; merge into `main-0.7` is a pending human step."

- [ ] **Step 3: Run the gate**

Run: `nix develop -c npm run verify`
Expected: green, including `claude-md-drift.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-24-dead-track-escalation-design.md docs/superpowers/plans/2026-09-24-dead-track-escalation.md
git commit -m "docs: sync CLAUDE.md and the spec for the dead-track escalation round"
```

---

## Self-review notes (plan author, 2026-09-24)

- Spec coverage: Part 1 → Tasks 3 and 4. Part 2's four items → Task 1 (reasons, TrackMuted) and Task 2 (outbound bytes, pair histogram). Declared behavior changes 1 to 3 → Tasks 4, 1, 2. "Considered and not planned" → no task, recorded in Task 5's bullet.
- Type consistency: `refreshRequestsSent` / `refreshBudget` / `resetRefreshBudget` / `deadTrackEscalations` / `deadTrackRefreshBudget` are spelled the same in Tasks 3, 4 and 5. The close reason string is `'dead-track-escalation'` everywhere. The event names are `'TrackMuted'` and `'DeadTrackEscalation'`.
- Review Focus 1 to 5 each have a named test in Tasks 3, 4, 4, 2, 1.
- Task ordering keeps the gate green at every commit; Task 3 step 6 carries the interim caller change so `tsc` passes before Task 4 replaces the block.
