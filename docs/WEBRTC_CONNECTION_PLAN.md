# WebRTC connection lifecycle: situations, measured data, code gaps, and plan

Status: **for review**. Scope: the WebRTC media transport for Presence — the
`@lightningrodlabs/webrtc-peer` FSM package, its `FsmTransport` adapter, and the
`StreamsStore` carrier orchestration. Audio/video correctness on lossy and
NAT‑constrained paths.

This document maps (1) the full range of situations a WebRTC connection passes
through, against (2) what our diagnostic captures actually measured, against (3)
what the current code does, and proposes (4) what to change, why, and how —
separating what has already landed from what is proposed.

Anchors are file\:line into the repo at the time of writing.

---

## 0. TL;DR for reviewers

- The dominant, repeated failure in production is **not** steady‑state media
  loss — it is **time spent off a clean WebRTC path**: a slow/failed
  establishment or a recovery that throws the transport away, dropping audio
  onto the high‑latency, lossy Holochain signals relay.
- Three classes of root cause, in priority order:
  1. **Recovery that discards good transport.** A stalled data channel (or a
     too‑aggressive timeout) tore down a connection whose ICE+DTLS were up and
     media was flowing. **(Largely fixed — see §5.A.)**
  2. **The fallback carrier is genuinely bad for media** (RTT 400–1800ms, bursty
     loss) and we spend real wall‑clock on it. **(Partially mitigated — §5.B.)**
  3. **Last‑mile uplink loss at one peer** (Puerto Rico / Liberty), asymmetric
     and physical — not fixable in code, only maskable (FEC, priority, rate).
     **(Platform FEC + priority in place — §5.C.)**
- Already landed (committed this cycle): in‑place data‑channel recovery + on‑demand
  `restartIce`/`recreateDataChannel`; signals‑carrier RED redundancy; audio
  priority + video cap; 12s DTLS‑stall default.
- Proposed next, in this doc: **readiness tiering** (incl. building the DC
  control‑message fallback that does **not** exist today — §6.1), **TURN** +
  cheap ICE knobs, **carrier‑switch hysteresis**, and **app‑side join‑time
  batching** to cut renegotiations — **not** package‑core reneg coalescing, which
  was implemented and reverted this cycle as unsafe (§6.5).

---

## 1. The range of situations (WebRTC reference model)

A peer connection is a stack of independent sub‑transports, each with its own
state machine and failure modes. "The connection" is only as good as the
weakest layer, and each layer can fail, stall, or recover independently.

### 1.1 Signaling transport (out‑of‑band)
Carries SDP offers/answers and ICE candidates. WebRTC is agnostic to it. **In
Presence it is the Holochain remote‑signal relay** — a gossip path, not a
reliable channel. Situations:
- Healthy: sub‑100ms, reliable.
- Degraded: high RTT, packet loss, reordering → SDP/candidates lost, exchange
  slow or never completes.
- Down: no delivery (our logs: `pong path recovered after 39974ms`).
Consequence: establishment latency and success are bounded by the *worst* of
signaling and media paths. A perfectly good media path can fail to form because
the offer/answer didn't arrive.

### 1.2 ICE (connectivity)
Candidate types: **host** (LAN), **srflx** (server‑reflexive via STUN, public
mapping), **relay** (TURN). Gathering → checking → connected → (disconnected) →
(failed). Situations:
- Direct host (same LAN) — fast, lossless.
- srflx↔srflx hole‑punch through cone NATs — works without TURN.
- Symmetric NAT / CGNAT / firewall — srflx fails; **needs TURN relay**.
- `disconnected`: transient path loss; ICE keeps probing and may self‑heal.
- `failed`: checklist exhausted; needs **ICE restart** (new ufrag/candidates,
  same DTLS) or full reconnect.
- Asymmetric reachability: A→B pair works, B→A doesn't (NAT mapping/timing).

### 1.3 DTLS (security)
Handshake over the selected ICE pair once it's writable. **There is no standard
browser signal for DTLS handshake progress** — code can only *infer* DTLS state
from `pc.connectionState`/`iceConnectionState` (and, where exposed,
`sctp.transport.state`). Any "DTLS stall" detection is therefore a heuristic on a
derived signal, which is why its timeout is a tuning knob (see §5.A). Situations:
- Completes in 1–2 RTT on a clean path.
- **Stalls** (inferred): ICE is connected (STUN binding works) but
  `connectionState` doesn't reach `connected` within N ms — the path can't
  sustain DTLS handshake datagrams (MTU blackhole, aggressive NAT, loss). Classic
  on Starlink/CGNAT. Recovery = fresh handshake (full reconnect).
- `failed`: needs full reconnect.

### 1.4 SCTP + data channel (DCEP)
The data channel runs SCTP over DTLS. The first channel negotiates the SCTP
association; each channel opens via a DCEP open handshake. Situations:
- Opens within ~1 RTT of DTLS.
- **In‑band DCEP open packet lost** on a lossy path; SCTP normally retransmits,
  but a stuck/late open leaves `readyState='connecting'`.
- Association never forms despite DTLS connected (rare; MTU/loss).
- A `negotiated` channel (fixed id) skips DCEP entirely — opens with SCTP.

### 1.5 Media (RTP/RTCP)
Audio/video tracks flow as soon as ICE+DTLS are up — **independent of the data
channel.** What the WebRTC RTP path gives you *for free* vs. what must be added:
- **On by default in Chromium:** **Opus in‑band FEC** (`useinbandfec=1`, recovers
  from redundancy) + **PLC** (conceals); adaptive jitter buffer; bandwidth
  estimation + bitrate adaptation; video NACK/RTX retransmission. `networkPriority`
  biases allocation/DSCP across senders.
- **NOT on by default:** **audio RED (RFC 2198)** on the RTP path — libwebrtc does
  not enable it the way it enables `useinbandfec=1`. (Presence's RED redundancy is
  on the **signals carrier**, not the WebRTC RTP path — see §5.B. Do not assume
  RTP‑path RED is active.)
- `packetsLost` in stats counts RTP sequence gaps **regardless of FEC recovery**
  — so a non‑zero loss number can still be inaudible.

### 1.6 Renegotiation (perfect negotiation)
Adding/removing/replacing tracks or creating the first data channel fires
`negotiationneeded` → a new offer/answer round. **The browser already coalesces
`negotiationneeded`** — it fires only from `stable` signaling state and only when
work is actually needed, so a burst of synchronous mutations yields one event.
This is why re‑implementing coalescing in the negotiation core is the wrong layer
(see §6.5). Situations:
- Steady state: occasional, well‑spaced.
- **Startup flurry**: audio‑on, video‑on, reconcile, replaceTrack happen over a
  window (each from `stable`, so each legitimately needs its own offer) → several
  real offers. On a slow signaling path these serialize and can blow the
  establishment budget. The fix is to *do fewer mutations at join* (app‑side
  batching), not to fold distinct negotiations together.
- **Glare**: both sides offer at once → polite/impolite rollback resolves it.
- `replaceTrack` does **not** renegotiate (same kind) — the cheap path.

### 1.7 Recovery strategies (escalating cost)
1. `replaceTrack` — no negotiation.
2. **Recreate data channel** — reuses ICE/DTLS/SCTP; no SDP. *(cheapest transport recovery)*
3. **ICE restart** — new candidates, **keeps DTLS**.
4. **Full reconnect** — fresh peer, new DTLS/SCTP. *(most expensive; what we want to avoid)*

### 1.8 Topology
- **P2P mesh** (Presence): N×N, each peer's uplink carries all its outbound;
  last‑mile uplink loss hits every receiver. No server to absorb/repair.
- **SFU** (Zoom et al.): client→server; nearby edge absorbs loss, runs FEC/NACK,
  adapts rate; never falls back to a worse‑than‑direct gossip path.

### 1.9 Network pathologies (the environment)
Asymmetric one‑way loss (last‑mile upload), bufferbloat (latency under load),
NAT type, MTU/fragmentation blackholes, transient roaming, and **the
application's own fallback path quality**.

---

## 2. Measured data (our captures, mapped to §1)

Two peers throughout: **local/NY** `uhCAkCNT` (FairPoint/Consolidated,
216.227.63.114) and **remote/PR** `uhCAkctV` (Liberty Communications of Puerto
Rico, 24.138.197.51, Hatillo PR). Loss is receiver‑measured from
`inbound-rtp.packetsLost`, audio preferred ([streams-store.ts:4973‑5014](../ui/src/streams-store.ts)).

### 2.1 Capture A — `…11_01_10` (pre‑changes)
- Direct srflx↔srflx, `relay=false`, RTT ~80ms (§1.2 cone‑NAT hole‑punch). No TURN.
- **Asymmetric media loss (§1.5/§1.9):** NY←PR sustained ~2% (peak 4.7%); PR←NY
  0%. → PR **uplink** egress loss, one‑directional.
- **DTLS stall (§1.3):** `connecting→disconnected "DTLS stall after 5000ms"` →
  full reconnect → churn.
- **Signals carrier (§1.1):** during WebRTC‑off / reconnect windows, loss
  10–57%, RTT 400–790ms — media on the gossip relay is unusable.

### 2.2 Capture B — `…12_18_13` (after redundancy/priority/stall‑config)
- **Establishment failure dominates (§1.1/§1.4):** signal relay down at join
  (`pong recovered after 39974ms`); a **renegotiation storm** on a **single
  `connectionId`** (`fsm-offer x16 over 6.3s`, `fsm-answer x15 over 5.6s`, §1.6 —
  one peer connection, so repeated offers, not mesh fan‑out; ambiguous between
  many real renegotiations and signaling‑layer resends over the down relay)
  couldn't complete;
  the connection reached `ice=connected dtls=connected` but **`dc=closed`** and
  was destroyed at the app's 15s SDP timeout (§1.4 stuck DCEP). A retry hit ICE
  `disconnected` on the srflx pair + 7s connection‑timeout. **~26s on the signals
  carrier before a clean path.**
- **Steady‑state webrtc:** PR←NY ~3% (unchanged — physical uplink); NY←PR ~0%.
- **Signals carrier after redundancy:** mostly `loss=0%` with spikes (9–27%),
  but RTT 400–1800ms, jitter 30–60ms — latency/jitter still bad regardless of loss.

### 2.3 What the data proves
- The **expensive, repeated cost is establishment + recovery churn**, not the
  ~2–3% steady media loss (FEC‑concealed, edge‑audible at worst).
- Tearing down a connection that has ICE+DTLS+flowing‑media because the **data
  channel** or a **timer** isn't satisfied is a self‑inflicted outage.
- The fallback carrier is a real media path in our system and it is *bad*; time
  spent there is the audible damage.
- One peer has irreducible **uplink loss**; only maskable.

---

## 3. Current architecture (where each §1 stage lives)

- **Carriers.** Two media transports exist per peer: WebRTC (`FsmTransport` →
  `ConnectionManager` → `PeerConnectionFSM` → `RTCPeer`) and the **signals
  carrier** = Opus‑over‑Holochain‑signals in [voice.ts](../ui/src/room/modules/voice.ts).
  `StreamsStore` switches between them (`CarrierSwitch signals↔fsm`,
  [streams-store.ts:836,965](../ui/src/streams-store.ts)) and chooses impl
  (`simplepeer` vs `fsm`) via the auto‑flip policy
  ([streams-store.ts:496](../ui/src/streams-store.ts)).
- **ICE config (§1.2).** `DEFAULT_ICE_SERVERS` is **STUN‑only** (Twilio,
  Cloudflare, Google) ([types.ts:15](../packages/webrtc-peer/src/types.ts)).
  TURN is a manual `localStorage('turnCredential')` field
  ([presence-app.ts:970](../ui/src/presence-app.ts)) — empty in all captures
  (`relay=false`).
- **Composite readiness (§1.3–1.5).** `connected` requires **ICE + DTLS + data
  channel open** ([peer-connection-fsm.ts:1117](../packages/webrtc-peer/src/peer-connection-fsm.ts)).
  DTLS‑connected is **inferred** from `pc.connectionState === 'connected'` (the
  `connect` event), not a DTLS‑specific signal (§1.3).
- **Trickle ICE.** On by default (`trickleICE: true`,
  [types.ts:327](../packages/webrtc-peer/src/types.ts)); candidates are sent
  incrementally and end‑of‑candidates is signaled — confirmed in captures.
  `iceCandidatePoolSize` is **unset** (see §6.7).
- **Timers.** `connection-timeout` 7s (connecting); FSM `sdp-exchange-timeout`
  15s (signaling); **DTLS watchdog** (`dtlsStallTimeoutMs`, now 12s default,
  localStorage‑overridable); **data‑channel watchdog** (`dataChannelStallTimeoutMs`
  4s, recreate‑in‑place, bounded); `iceDisconnectedGraceMs` 15s; **app‑level 15s
  SDP timeout** in StreamsStore ([streams-store.ts:5985](../ui/src/streams-store.ts)).
- **Recovery (§1.7).** `reconnect-policy.ts`: first N attempts ICE‑restart, then
  full‑reconnect; `dtls-failed`/`data-channel-stall` force full‑reconnect.
  `RTCPeer.restartIce()` and `RTCPeer.recreateDataChannel()` exist; on‑demand
  pass‑throughs exposed on FSM/Manager/Transport.
- **Media tuning (§1.5).** On connect, audio sender → high `networkPriority`,
  video → low + bitrate cap ([streams-store.ts `_applySenderParams`](../ui/src/streams-store.ts)).
  Signals carrier carries RED redundancy ([voice.ts](../ui/src/room/modules/voice.ts)).
- **Renegotiation (§1.6).** `RTCPeer` perfect‑negotiation with a serial task
  queue; **no coalescing** — one offer per `negotiationneeded`
  ([rtc-peer.ts:408](../packages/webrtc-peer/src/rtc-peer.ts)).

---

## 4. Gap analysis (situation → current behavior → desired)

| # | Situation (§1) | Current behavior | Gap / risk | Priority |
|---|---|---|---|---|
| G1 | DC stalls, ICE+DTLS up (§1.4) | **Now**: recreate in place, bounded, then escalate | Was: full teardown. **Landed.** | done |
| G2 | DC slow but media flowing (§1.5) | `connected` still gated on DC | App/UX treat a usable call as "not connected"; 15s app timer can still fire | **High** |
| G3 | Establishment on a degraded signaling path (§1.1) | 15s app SDP timeout **destroys** even when ICE+DTLS are up | Discards a forming/good transport; forces 26s rebuild | **High** |
| G4 | Startup renegotiation flurry (§1.6) | Many real offers at join (browser already coalesces same‑tick events); serialize over slow relay | Blows establishment budget; fix app‑side (fewer mutations) + cheap ICE knobs — **not** package‑core coalescing (reverted once) | Medium |
| G5 | Symmetric/CGNAT, srflx fails (§1.2) | STUN‑only; TURN manual & unused | No relay fallback ⇒ no connection (or stuck on signals) | **High (ops)** |
| G6 | Bad carrier flapping (§1.1 vs §1.5) | Switch on quality buckets | Risk of thrash between webrtc/signals on borderline links | Medium |
| G7 | Last‑mile uplink loss (§1.9) | FEC (platform) + priority + cap | Irreducible; current mitigations are the right ones | Maintain |
| G8 | DTLS stall too eager (§1.3) | **Now** 12s, configurable | Was 5s. **Landed.** | done |
| G9 | Observability | Rich FSM transition snapshots; per‑carrier quality | Hard to attribute "why off webrtc"; no single establishment timeline metric | Medium |

---

## 5. What already landed (this cycle) — for completeness

- **A. In‑place data‑channel recovery (G1, G8).** `RTCPeer.recreateDataChannel()`
  + FSM data‑channel watchdog (recreate, bounded, escalate); DTLS‑stall default
  5s→12s, configurable. On‑demand `restartIce`/`recreateDataChannel` on FSM,
  Manager, Transport. Tests: `data-channel-recovery.test.ts`,
  additions to `connection-manager.test.ts`, `fsm-transport.test.ts`.
- **B. Signals‑carrier RED redundancy (mitigates §1.1 loss).** RED‑style
  redundancy on the **Opus‑over‑Holochain‑signals fallback carrier only** — *not*
  the WebRTC RTP path (which relies on Opus in‑band FEC, §1.5). Each signals packet
  carries the previous N frames; receiver recovers and counts loss post‑recovery.
  Wire‑compatible both directions.
- **C. Media tuning (G7).** Audio high / video low `networkPriority` + video
  bitrate cap on connect.

These addressed the largest share of churn (the DC‑gated teardown) and the worst
signals‑carrier loss. The proposals below address the **remaining** gaps.

---

## 6. Proposed changes (what / why / how) — for review

Ordered by value‑to‑risk. Each is independently shippable and test‑first.

### 6.1 Tiered readiness — decouple media from the data channel (G2) — **recommended first**
- **What.** Promote the FSM to `connected` on **ICE + DTLS** (media can flow);
  expose data‑channel‑open as a separate signal/flag, not a gate. The DC
  watchdog (already present) keeps recovering the channel in the background.
- **Why.** Media is usable the instant ICE+DTLS are up — and **media/track
  availability is driven by WebRTC `track` events** (`_setTrackReady`,
  [streams-store.ts:1176‑1217](../ui/src/streams-store.ts)), **not** by the data
  channel. That is the real, solid justification for decoupling. Gating the whole
  call on the DC is what let a stuck channel read as "not connected" and invite
  teardown. This also **subsumes G3's worst case**: once `conn.connected` is true
  on media‑readiness, the app's 15s SDP timer's `!conn.connected` guard spares it.
- **What the DC actually carries (corrected).** UI mute/input‑state sync —
  `video-on/off`, `audio-on/off`, `change-{audio,video}-input`,
  `request-track-refresh` ([streams-store.ts:1226‑1299, 2152‑2479](../ui/src/streams-store.ts)),
  sent **only** over `transport.send()` (the DC). **There is no presence‑signal
  fallback for these today** — `roomClient.sendMessage` only carries
  `Sdp`/`SdpFsm`/`LeaveUi`/`DiagnosticRequest`. So with the DC down, **media flows
  but peer mute/input indicators can desync** until the watchdog reopens the
  channel.
- **How (scope includes new work).**
  1. In `_checkCompositeReadiness`, transition to `connected` on
     `iceConnected && dtlsConnected`; emit a separate `data-channel-ready` when the
     channel opens; keep `recreateDataChannel`/watchdog as the path to that.
  2. **Build the missing fallback (or accept transient desync):** either route the
     UI mute/input‑state messages over a presence‑signal path when the DC isn't
     open, or explicitly accept that mute indicators may lag until DC recovery and
     reconcile on `data-channel-ready`. This does not exist yet and is part of 6.1,
     not an assumption.
  3. Audit `transport.send()` call sites so DC‑dependent sends queue until
     `data-channel-ready` rather than silently drop.
  4. **Fix the status strings.** `_computeStatusText`
     ([peer-connection-fsm.ts:1438‑1440](../packages/webrtc-peer/src/peer-connection-fsm.ts))
     still encodes the DC‑gated model — `'Opening data channel...'` for the
     ICE+DTLS‑up/DC‑pending state. Once that state is `connected` with media
     flowing, that string reads wrong; update it (e.g. `Connected`, with an
     optional subtle "restoring data channel" sub‑state) so the UI doesn't show
     "opening data channel" over a live call.
- **Risk.** Changes the meaning of `connected` (package contract); other consumers
  must tolerate media‑ready‑without‑DC. Until the fallback (2) lands, expect
  transient mute‑state desync windows during DC recovery — acceptable, but call it
  out in the PR.
- **Tests (first).** FSM reaches `connected` on ICE+DTLS with DC closed; a
  `data-channel-ready` event fires only on DC open; `recreateDataChannel`
  interplay unchanged. Two‑peer integration: media‑ready both sides without DC,
  then DC opens.

### 6.2 Establishment‑timeout hardening (G3) — **contingent, do not pre‑build**
> Only implement if a fresh capture **after 6.1** still shows a connection with
> ICE+DTLS up being torn down. 6.1 removes the trigger (the timer's
> `!conn.connected` guard passes once media‑readiness promotes), so this is most
> likely dead code. Listed for completeness and as a fallback.

- **What.** The app‑level 15s SDP timeout
  ([streams-store.ts:5985](../ui/src/streams-store.ts)) must **not** destroy a
  connection whose ICE+DTLS are connected; only abort genuinely stuck signaling
  (still in `signaling`/no transport progress).
- **Why.** Capture B destroyed a connection at `ice=connected dtls=connected`.
  Even with 6.1, defense‑in‑depth: never discard a live transport on a signaling
  timer.
- **How.** Before `closeConnection`, consult the transport snapshot
  (`getRTCPeerConnection(peer)` → `iceConnectionState`/DTLS, or the FSM phase);
  if media transport is up, convert the timeout into "promote/keep + let DC
  watchdog run" rather than destroy.
- **Risk.** `StreamsStore` has **no unit‑test harness** today → limited TDD
  surface; would rely on integration/manual validation or a new (non‑trivial)
  harness. Lower priority if 6.1 lands, since 6.1 removes the trigger.

### 6.3 ICE candidate & TURN policy (G5) — **ops + small code**
- **What.** Ship a working **TURN** server as a default ICE server, regionally
  near PR (e.g. Miami/SJU), with short‑lived credentials. Provide **both** UDP
  (`turn:…:3478`) and **TURN/TLS over TCP 443** (`turns:…:443?transport=tcp`) —
  the latter survives lossy‑UDP paths and restrictive firewalls that only permit
  443. Keep the manual override.
- **Why.** Every capture is `relay=false`. Cone‑NAT peers hole‑punch today, but
  symmetric/CGNAT peers have **no** media path and get stuck on signals. TURN is
  also the only way to route around a lossy‑UDP path (TURN/TLS‑TCP) and gives a
  real fallback far better than the gossip relay. TURN does **not** fix PR's
  uplink loss (out of scope for TURN).
- **How.** Credential provisioning service or static time‑boxed creds; inject via
  the existing `iceServers` getter ([fsm-transport.ts:86‑94](../ui/src/transport/fsm/fsm-transport.ts)).
  Add a diagnostic that logs selected‑pair `candidateType` (already partly
  present: `ICE pair … relay=` in `_handleMediaConnected`).
- **Risk.** Infra/cost/ops, not code stability. Validate relay path with a forced
  `iceTransportPolicy: 'relay'` test build.

### 6.4 Carrier‑switch hysteresis (G6)
- **What.** Add damping to the webrtc↔signals (and impl auto‑flip) decision:
  require sustained quality (N consecutive buckets / a dwell time) before
  switching; bias toward **staying on webrtc** while ICE/DTLS are up even if
  quality dips; treat signals as control/degraded‑audio, not a co‑equal media
  carrier.
- **Why.** Borderline links can oscillate; each switch is an audio seam plus a
  reconnect. The data shows webrtc at 80ms+3% is far better than signals at
  600ms; we should be reluctant to leave webrtc.
- **How.** Hysteresis state in the carrier‑selection path; unit‑test the
  decision function (pure) with bucket sequences.
- **Risk.** Low if the decision is isolated into a pure, tested function.

### 6.5 Reduce join‑time renegotiations (G4) — **app‑side batching is the primary path**
- **What.** Cut the number of *distinct* renegotiations at join. The browser
  already coalesces same‑tick `negotiationneeded` (§1.6), so the win is **not**
  folding events in the package — it is **doing fewer transceiver mutations at
  join, app‑side**: stage audio+video tracks before `connect()` where possible,
  and collapse the audio‑on/video‑on/reconcile/replaceTrack sequence so the first
  offer already carries the intended media.
- **Why.** Capture B's `fsm-offer x16` storm was on one connection over a down
  relay; fewer real offer/answer round‑trips shrink the establishment window.
  **Second‑order** — first‑order fixes (6.1/6.3) matter more.
- **Primary approach (low blast radius): app‑side.** Batch join‑time media setup
  in `StreamsStore`/room modules so fewer `negotiationneeded`s fire. Does not
  touch the package's perfect‑negotiation core.
- **Rejected approach: package‑core coalescing.** Implemented and **reverted**
  this cycle — see below. Only revisit if app‑side batching proves insufficient
  *and* the integration‑test gate is built first.
- **Why it's hard (measured).** A naive "flag + synchronous enqueue" snapshots
  SDP during the *first* change and drops later tracks (correctness bug). A
  microtask‑deferred enqueue fixes the snapshot but shifts the multi‑peer
  offer→answer→candidate chain and, in our integration suite, drove a
  non‑settling loop / OOM. Coalescing interacts with perfect‑negotiation glare
  and reconnect timers, not just the single‑peer offer count. **This was
  implemented and reverted** in this cycle for exactly that reason.
- **If package‑core coalescing is ever revisited (last resort only).** Required
  safeguards, learned from the revert:
  - **Phase‑gate**: only coalesce during pre‑`connected` setup; leave steady‑state
    renegotiation untouched.
  - **Snapshot‑correct**: ensure `setLocalDescription` runs after the tick settles
    so the single offer includes all accumulated transceivers (the naive flag drops
    later tracks).
  - **Integration‑first tests**: two‑peer offer/answer convergence, glare,
    post‑connected track add, and reconnect tests **before** touching the handler —
    a single‑peer unit test is insufficient (it passed while the integration suite
    OOM'd).
- **Risk.** App‑side batching: low. Package‑core coalescing: high — the perfect‑
  negotiation timing is load‑bearing; gate strictly behind the integration tests
  above.

### 6.6 Observability (G9)
- **What.** A single per‑connection "establishment timeline" event (signaling
  start → ICE connected → DTLS connected → DC open → connected, with per‑stage
  ms and the selected candidate types) and an explicit "left webrtc because X"
  reason on every `CarrierSwitch fsm→signals`.
- **Why.** Today attribution requires hand‑reading interleaved transitions across
  two logs. A timeline makes regressions/wins measurable and is the acceptance
  signal for 6.1–6.5.
- **How.** Aggregate existing `FsmTransition`/`IceEstablishment`/`CarrierSwitch`
  into one structured record; emit on connect and on every carrier downgrade.
- **Risk.** Low (additive logging).

### 6.7 Cheap ICE establishment knobs (G4, supporting) — **near‑zero risk**
- **What.** Two standard knobs that directly serve "shrink the establishment
  window," independent of the riskier 6.5:
  1. **`iceCandidatePoolSize`** (currently unset): pre‑gather candidates so they're
     ready at offer time, shaving gathering latency off establishment.
  2. **Confirm trickle ICE** stays on (it is, §3) and end‑of‑candidates is handled —
     i.e. we never accidentally block on full gathering, which would inflate
     latency on a slow signaling path. The captures show trickle behavior; this is
     a guard/regression‑test, not a change.
- **How.** Set `iceCandidatePoolSize` in the `RTCConfiguration` built in
  [rtc-peer.ts:84‑89](../packages/webrtc-peer/src/rtc-peer.ts); add a test asserting
  trickle (incremental candidate signals) and end‑of‑candidates.
- **Risk.** Minimal; `iceCandidatePoolSize` only affects gathering eagerness.

---

## 7. Sequencing & acceptance

1. **6.6 Observability** first — so every later change is measurable.
2. **6.1 Tiered readiness** (incl. the DC‑control‑message fallback, which does not
   exist yet) — highest value, removes G2 and the trigger for G3.
3. **6.3 TURN** + **6.7 cheap ICE knobs** — parallel ops/low‑risk track; unblocks
   NAT‑stuck peers (G5) and trims establishment latency.
4. **6.4 Carrier hysteresis** — reduce flapping once readiness is correct.
5. **6.5 app‑side join‑time batching** — reduce real renegotiations at join.
6. **6.2 Establishment hardening** — only if a fresh capture still shows a live
   transport torn down after 6.1.
7. **Package‑core reneg coalescing** — only if 6.5 app‑side proves insufficient,
   and only behind the integration‑test gate (§6.5).

**Acceptance (from real captures, via 6.6):** time‑to‑first‑clean‑webrtc at join
< a few seconds on a healthy relay; **zero** teardowns of connections with
ICE+DTLS up; no carrier oscillation on a stable link; relay path proven to form
on a forced‑`relay` build. Steady‑state ~2–3% PR uplink loss is expected to
remain (physical) and should be inaudible under FEC.

---

## 8. Open questions for review

1. **`connected` contract + DC fallback (6.1):** OK to redefine package‑level
   `connected` as media‑ready (ICE+DTLS), or gate behind a `requireDataChannel`
   config flag for other consumers? **And** for the UI mute/input‑state messages
   that today ride the DC with no fallback — build a presence‑signal fallback, or
   accept transient mute‑indicator desync during DC recovery (reconciled on
   `data-channel-ready`)? This is net‑new work, not an existing safety net.
2. **TURN (6.3):** provisioning model — static time‑boxed creds vs a credential
   service? Region(s)? Budget for relayed minutes?
3. **Signals carrier role:** keep it as a degraded *media* fallback, or demote to
   control‑only once TURN exists (so media is always webrtc‑or‑relayed)?
4. **Reneg‑coalescing locus (6.5):** package negotiation core vs app‑side
   batching of join‑time media operations — which blast radius is acceptable?
5. **Multi‑channel:** any near‑term need for additional data channels (would make
   readiness/recovery multi‑channel‑aware), or keep single‑channel?

---

## 9. Implementation notes for a fresh context

Operational facts a new agent needs (learned this cycle):

- **Toolchain:** prefix every command with `nix develop -c` (e.g.
  `nix develop -c npx vitest run`). UI typecheck: `nix develop -c npx tsc --noEmit -p ui/tsconfig.json`.
- **Package ↔ UI wiring:** `packages/webrtc-peer` is symlinked into
  `ui/node_modules/@lightningrodlabs/webrtc-peer`; the UI imports the built
  `dist/` (no vite alias to `src`). After editing package `src`, rebuild:
  `nix develop -c npm run build -w packages/webrtc-peer` (now also run
  automatically by `npm run package` via `build:packages`). `dist/` is gitignored.
- **Test harnesses (real, reusable — don't write tautological mocks):**
  `MockRTCPeerConnection` + `MockRTCDataChannel.simulateOpen()` and
  `FakeSignalingChannel` in `packages/webrtc-peer/src/__tests__/test-helpers.ts`;
  `createFSM`/`getConnectedFSM` patterns in `peer-connection-fsm.test.ts`;
  the data‑channel recovery tests in `data-channel-recovery.test.ts` are the
  template for FSM‑level work. Package tests use **global fake timers**
  (`beforeEach(vi.useFakeTimers)`).
- **Landmines:**
  - The **two‑peer integration suite is timing‑sensitive** — the reverted
    coalescing OOM'd it. Any change to negotiation/timer behavior must run the
    full package suite, not just unit tests.
  - **`StreamsStore` has no unit‑test harness.** App‑side changes (6.1 fallback,
    6.4 hysteresis, 6.5 batching) need either a new harness or integration/manual
    validation; isolate logic into pure functions where possible (e.g. the
    hysteresis decision) so it *can* be unit‑tested.
  - DTLS‑connected is inferred from `connectionState` (§1.3); there is no DTLS
    event to hook.
- **Baseline:** package suite is **191 green** at the start of this work; keep it
  green. Landed work is commits `bae088b` (webrtc‑peer) and `bc3063f` (ui).
- **Method:** failing‑test‑first, then implement, then green — and for anything
  touching negotiation/timers, write the **two‑peer integration** test before the
  unit test.
