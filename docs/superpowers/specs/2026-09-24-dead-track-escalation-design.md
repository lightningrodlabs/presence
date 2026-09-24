# Dead-track escalation and reconnect forensics: design spec

Written 2026-09-24 from the field incident of the same morning. Built on
`main-0.7` (@ `6f9d0a4`). The plan is
`docs/superpowers/plans/2026-09-24-dead-track-escalation.md`.

## The incident, from the log

Source: `~/Downloads/Presence_merged_0.15.6_2026-9-24-10_17_19.json`, a
merged diagnostic export taken on Eric's node at 10:17:19 local time
(America/New_York, UTC-4). The 10:13:23 export in the same folder is a
strict prefix of it. Entries are `{timestamp, source, sourceLabel, type,
detail}`. Every timestamp is the reporting node's own wall clock
(CLAUDE.md, Post-Phase 5 facts). Cross-node offsets in this capture are
under one second. Compare each leave/close pair below to see this. The
timelines can be read together, but do not compute sub-second latencies
across nodes from it.

Flatten it with:

```sh
python3 - <<'EOF'
import json, datetime
d = json.load(open('/home/eric/Downloads/Presence_merged_0.15.6_2026-9-24-10_17_19.json'))
for x in sorted(d['entries'], key=lambda e: e['timestamp']):
    t = datetime.datetime.fromtimestamp(x['timestamp'] / 1000).strftime('%H:%M:%S.%f')[:-3]
    print(t, x['timestamp'], x['source'][4:10], x['detail'].replace('\n', ' '))
EOF
```

Agents (the `source` column, and the `[uhCAk..]` prefix inside `detail`):

| short | pubkey prefix | who | notes |
|---|---|---|---|
| `k1VOFk` | `uhCAk1VO` | Eric, the exporting node (`localAgent`) | Lowest pubkey of the three, so never the initiator. Public address 68.237.140.202. TURN configured (`turn=cloudflare`). |
| `kSPd2S` | `uhCAkSPd` | Uruguay | Highest pubkey, so the initiator toward both. Addresses 148.227.105.39 and 2803:9810:…. No TURN (`turn=none`). |
| `kEk5cU` | `uhCAkEk5` | third participant | Addresses 2a02:6b6f:… and 45.159.89.108. No TURN. |

Tie-break reminder: the higher pubkey sends `InitRequest` and calls
`connect()` after the `InitAccept` (`decideInitRetry`,
`ui/src/transport/init-retry-policy.ts`, and the acceptor guard in
`MediaLinks.handleInitRequest`). An `InitRequest` *event* in the log is
logged by the receiver.

### Timeline

Each row gives local time, epoch ms, source, and a grep string for the
`detail` field.

1. 10:05:23 to 10:05:25. Eric↔Uruguay comes up on TURN.
   `1790258725680 k1VOFk "Connection [uhCAkSPd]: relayed via TURN"` and
   `1790258725425 kSPd2S "Connection [uhCAk1VO]: relayed via TURN"`.
   The selected pair was `local=relay 104.30.145.14:21260 remote=srflx
   148.227.105.39:49436`.
2. 10:12:31 to 10:12:34. Uruguay loses its whole network, not just one
   link. `1790259154374 kSPd2S "SignalCarrierDown: no pong from any of
   10 known peer(s)"`. ICE goes `disconnected` on both of Uruguay's
   links. The failed pair on Eric↔Uruguay is now **direct srflx↔srflx**,
   not the relay: `1790259153685 kSPd2S "ICE failed pair [uhCAk1VO]:
   local=148.227.105.39:49436 (srflx) remote=68.237.140.202:42293
   (srflx)"`, and the mirror on Eric at `1790259153950`. The relay icon
   still said TURN. The pair is sampled once, 2 s after `connected`
   (`ui/src/media-links.ts`, the `setTimeout` at the end of
   `_handleMediaConnected`).
3. 10:12:41 to 10:12:44. All four FSMs move `connected->reconnecting`
   with `trigger="transport failure: ice-failed"` and start ICE
   restarts. This is correct.
4. 10:13:02. Uruguay's signals return: `1790259182372 kSPd2S
   "SignalCarrierUp: pong path recovered after 27998ms"`.
5. 10:13:04. All four FSMs log `reconnecting->connected
   trigger="reconnection succeeded (ICE + DTLS)"` (`1790259184191`,
   `1790259184433`, `1790259184511`, `1790259184512`). Negotiation
   worked. Both sides sent restart offers at once and the
   polite/impolite rule settled it.
6. 10:13:04 to 10:14:14. **The defect window.** Uruguay↔third-peer is
   healthy: both log `TrackUnmuted` at 10:13:05, and the third peer logs
   a selected pair at 10:13:06.515. Eric↔Uruguay reports `connected`,
   but Uruguay receives none of Eric's media:
   - `kSPd2S "Dead track [uhCAk1VO]: audio=2 video=2 cycles stale"`.
     There are 18 such lines in this window, one every 4 s.
   - `k1VOFk "request-track-refresh received from [uhCAkSPd]"`. There
     are 20 such lines in this window. Each one ran `replaceTrack` and
     logged `"Manual track refresh [uhCAkSPd]: replaceTrack"`. None
     changed anything.
   - Uruguay's pongs kept reporting Eric's video as muted. That is why
     Eric logged `[uhCAkSPd] ReconcileVideo` at `1790259201372` and
     `1790259243355` (the 10 s, 20 s, 40 s backoff of
     `reconcileVideoStreamState`).
   - `k1VOFk "Dead track [uhCAkSPd]"`: 0 lines in this window. Uruguay
     to Eric bytes were moving. The failure was one-way.
   - Neither Eric nor Uruguay logs `TrackUnmuted` for the other in this
     window. Neither logs an `ICE pair [..]` line after 10:13:04. The
     2 s sampler found no `candidate-pair` with `state=succeeded` on
     either side, while `iceConnectionState` said `connected`.
7. 10:14:14. Eric clicks Reconnect once: `1790259254586 k1VOFk
   "[uhCAkSPd] FsmTransition connected->closed
   trigger=\"disconnectFromPeerVideo\""`. This closes the local FSM and
   sends a `leave` over signals.
8. 10:14:23. The leave reaches Uruguay nine seconds later:
   `1790259263664 kSPd2S "trigger=\"remote peer left\""`. Uruguay's
   next pong-driven `InitRequest` never happens, because
   `1790259266370 kSPd2S "SignalCarrierDown"` (down until
   `1790259278369`).
9. 10:14:29. The Uruguay user gives up and switches to signals-only:
   `1790259269490 kSPd2S "[uhCAkSPd] MyWebrtcDisable global"`. Voice
   over signals to Uruguay then ran at pong RTTs of 9 to 18 s
   (`QualityBucketChange signals:bad`). A third carrier-down period
   followed at 10:15:48 to 10:16:02.
10. 10:16:20. The user re-enables WebRTC. Both fresh links establish in
    2.4 s (`Retry gap` lines at `1790259380638`, `1790259380723`,
    `1790259380969`, `1790259381066`, then `Connected` at 10:16:22 to
    10:16:23). Eric↔Uruguay comes up on `local=relay` again.

### What the log cannot tell us

The root cause of the one-way media after the ICE restart cannot be
found in this capture. Missing evidence:

- No selected candidate pair after the restart. The sampler logs only
  `succeeded` pairs. When there are none, it logs nothing.
- No sender-side counters. `summarizeRtcStats` reads `inbound-rtp`
  only. Eric's log cannot show whether his `outbound-rtp.bytesSent`
  toward Uruguay was advancing.
- No `TrackMuted` events. `_handleMediaRemoteTrack` installs
  `track.onunmute` only for tracks that arrived muted, and never
  installs `onmute`. A mute/unmute cycle on a healthy-looking link is
  invisible.
- Every `disconnectFromPeerVideo` caller passes the same close reason.
  The Reconnect button, a carrier flip, a block, and a peer payload
  change cannot be told apart in `FsmTransition` triggers.

## Findings against our code

F1. **Dead-track recovery has one rung and no escalation.**
`TrackHealthMonitor.checkTrackHealth` (`ui/src/track-health.ts`)
requests a refresh after `STALE_CYCLES_REFRESH_THRESHOLD` frozen polls,
resets the counters, and repeats forever. The sender's
`refreshTracksForPeer` runs `replaceTrack` on the same senders. That
cannot repair a transport-level fault. The heavier rung is
`_cloneStreamRecovery`, a close. Only `reconcileVideoStreamState` calls
it, and only after `refreshMediaForPeer` returned false. At that point
the FSM is already gone. A connected link with frozen bytes therefore
stays that way until a human acts.

F2. **While F1 persists, the peer gets nothing over either carrier.**
`carrier-coverage.ts` keys signals coverage on `connected`. The slot was
`connected: true`, so Uruguay was excluded from Eric's
`_signalsTargets` for the whole 70 s. This is the bounded exception
recorded in CLAUDE.md (Post-Phase 1 carrier facts), and here it became
unbounded. Escalation (F1's fix) bounds it again by closing the slot. A
separate "connected but stalled" coverage rule is not planned (see
below).

F3. **The Reconnect button did what it is designed to do.** From the
lower peer it can only close and send a `leave`. Re-initiation is the
higher peer's pong drive. Here the leave took 9 s to arrive. The higher
peer's signals then went down for 12 s. The user switched modes at
+15 s. No code change is proposed for the button beyond naming its close
reason (F4). The fix that matters is F1: an automatic close at +16 s
instead of a manual one at +70 s.

F4. **Forensic gaps**, listed above.

## Design

### Part 1: escalation, receiver side

`decideTrackRefresh` (`ui/src/transport/track-health-policy.ts`) gains a
refresh budget and a third arm:

- New inputs: `refreshRequestsSent` (requests already sent on this
  connection without bytes resuming) and `refreshBudget`.
- New arm: `{ action: 'escalate', reason: 'refresh-budget-exhausted' }`.
  If a counter crosses the stale threshold and `refreshRequestsSent >=
  refreshBudget`, this arm fires instead of `request-refresh`.
- If both stale counters are zero (bytes resumed), the `none` arm
  carries `resetRefreshBudget: true`. A recovered link earns a fresh
  budget.

`deadTrackRefreshBudget(priorEscalations)` = `DEAD_TRACK_REFRESH_BUDGET
<< min(priorEscalations, DEAD_TRACK_ESCALATION_BACKOFF_CAP)`, with
`DEAD_TRACK_REFRESH_BUDGET = 3` and `DEAD_TRACK_ESCALATION_BACKOFF_CAP =
3`. Budgets per successive connection to the same peer: 3, 6, 12, 24,
24, and so on. This bounds a pathological loop (fresh connection also
dead) to a doubling cadence instead of a fixed 16 s thrash. Both
constants serve the media-flowing predicate. They run on the
track-health poll's clock (`PING_INTERVAL`). They are NOT liveness
constants (working agreement 2).

The executor in `checkTrackHealth`:

- `request-refresh`: unchanged, plus `refreshRequestsSent += 1` per
  attempt. The budget counts attempts, not deliveries: `FsmTransport.send`
  swallows every failure, so delivery is unobservable, and a data channel
  that cannot carry the request is itself evidence of a dead link. The
  stale reset keeps its pre-existing sent>0 rule.
- `none` with `resetRefreshBudget`: `refreshRequestsSent = 0`.
- `escalate`: log `DeadTrackEscalation` (new `SimpleEventType`,
  `emitted`), then `deadTrackEscalations += 1`, then
  `mediaTransport().closeConnection(peer, 'dead-track-escalation')`.

The decision holds while the media transport's phase for the peer is
not `connected` (`transportPhase` input): during
`reconnecting`/`disconnected` the slot keeps `connected: true` and the
FSM owns recovery, so no refresh is requested, nothing escalates, and
the counters and budget are frozen until the phase returns to
`connected`. On the incident timeline this defers the first escalation
to about 16 s after `reconnection succeeded` at 10:13:04, which is the
state the incident was stuck in.

Nothing else is new. `closeConnection` emits `closed` synchronously and
sends the `leave` signal (`ConnectionManager.closeConnection`).
`_handleMediaClosed` runs the existing `closeCleanupPlan` row
(`close-event`/`live`). That row applies `media-close-full`, stamps
`lastDisconnectTime`, and logs `CarrierSwitch webrtc->signals
reason="dead-track-escalation"` from `webrtcExitReason`.
Re-establishment is the existing pong drive. The reset clears the higher
peer's `pendingInits`, so its next pong sends a fresh `InitRequest`.
When the escalating node is the lower peer, the higher peer reaches the
same state through `remote peer left`. Timeline on a stall: bytes freeze
at t=0, refresh requests at t≈4, 8, 12 s, escalation at t≈16 s, fresh
link about 3 s later. In the incident that replaces 70 s and a manual
click.

Why close instead of an ICE restart: the transport's `restartIce` was
deleted as zero-caller (Post-Phase 4 facts). Re-adding it is a new
surface. The ICE restart the FSM ran at 10:12:41 is what produced the
dead state. The fresh connection at 10:16:20 worked. A close reuses
machinery that is already field-validated.

`PeerRecord` (`ui/src/peer-record.ts`) gains two fields:

- `refreshRequestsSent?: number`. Media-session bookkeeping. Wiped by
  `media-close-full`, like `staleCycles`.
- `deadTrackEscalations?: number`. A close survivor. Wiped only by
  `media-leave-residue`. It must survive the close it triggers.

Both arms are pinned by the full-object `toEqual` tests in
`peer-record.test.ts`.

### Part 2: forensics

- `TrackMuted` (new `SimpleEventType`). `_handleMediaRemoteTrack`
  installs `track.onmute` on every remote track, and `onunmute` on
  tracks that arrived unmuted. The new handlers only log. The existing
  arrived-muted `onunmute` keeps calling `_setTrackReady`.
- If the 2 s pair sampler in `_handleMediaConnected` finds no
  `succeeded` pair, it logs a histogram of `candidate-pair` states plus
  `getIceConnectionState`.
- `summarizeRtcStats` gains `audioBytesSent` and `videoBytesSent` from
  `outbound-rtp`. `refreshTracksForPeer` logs them (fire-and-forget)
  when a `request-track-refresh` arrives. The sender's view of a
  reported-dead link is then in the export.
- `disconnectFromPeerVideo(pubKey, reason)`: `reason` becomes required.
  Each of the five callers names itself: `reconnect-button`,
  `carrier-mode-signals`, `peer-carrier-change`, `peer-disabled-webrtc`,
  `block`. The string reaches `FsmTransition ... trigger=` and
  `CarrierSwitch ... reason=` through the existing `webrtcExitReason`.

### Declared behavior changes

1. A connected media link whose inbound bytes stay frozen through the
   refresh budget is closed and re-established (Part 1); never while the
   transport phase is not `connected`. Previously it stayed open
   indefinitely.
2. Log-only additions (Part 2). The close-reason strings change. The
   one wiring test that pins `'disconnectFromPeerVideo'` for
   `setCarrierMode('signals')` is updated to `'carrier-mode-signals'`.
3. `summarizeRtcStats` returns two more fields. Its table tests are
   updated to include them.

### Considered and not planned

- **Signals coverage for a connected-but-stalled slot** (F2 directly).
  This needs a stall flag on `OpenConnectionInfo`, a sender-side
  detector (refresh-request receipt or pong `streamInfo`), a clear rule,
  and a receive-side playout gate. Escalation bounds the exposure to
  about 16 s. Trigger to revisit: field logs that show
  `DeadTrackEscalation` loops where the fresh link is also dead.
- **A data-channel "please re-init" hint from the lower peer.** This
  hint travels faster than the `leave` signal on a live data channel,
  and the data channel was live here. But it is a parallel path to the
  signal-carried leave, and a new wire action. Trigger: field evidence
  that leave delivery, not carrier-down, is what makes escalation slow.
- **Re-adding transport `restartIce`.** See "why close".
- **Re-sampling the selected pair every poll**, so the relay icon tracks
  pair changes. `checkTrackHealth` already holds the report. It needs a
  `setRelayed` binding into `MediaLinks`' `_openConnections`. Cosmetic.
  Trigger: the icon misleads a diagnosis again.

## Testing and enforcement

- Policy: table tests in `track-health-policy.test.ts` for the new arm,
  the budget helper, and the outbound-bytes summary.
- Record: `peer-record.test.ts` full-object arm tests extended.
- Wiring: `streams-store-wiring.test.ts` drives the real started store
  with scripted `getStats`. Pinned there: escalation closes with the
  named reason and logs the event. A second connection gets the doubled
  budget. Bytes resuming resets the budget. The no-succeeded-pair line
  appears. The outbound line appears on refresh receipt. `TrackMuted`
  is logged from a remote track's `onmute`.
- Taxonomy: the `event-taxonomy.test.ts` inline snapshot gains
  `DeadTrackEscalation` and `TrackMuted`.
- Gate: `nix develop -c npm run verify` before every commit.

## Definition of done

All five plan tasks are landed on branch `dead-track-escalation`. The
gate is green. The doc-sync task added the CLAUDE.md "True today"
bullet. This spec's parts are marked landed.
