# WebRTC connection lifecycle: situations, measured data, code gaps, and plan

Scope: the WebRTC media transport for Presence — the
`@lightningrodlabs/webrtc-peer` FSM package, its `FsmTransport` adapter, and the
`StreamsStore` carrier orchestration. Audio/video correctness on lossy and
NAT‑constrained paths.

This document maps (1) the full range of situations a WebRTC connection passes
through, against (2) what our diagnostic captures measured in May–June 2026,
against (3) how the code behaves today, and (4) what remains to be built.

§1 is a reference model and does not go stale. §2 is a dated measurement and is
labelled as such. §3 describes the code as it is; §5 describes behavior that is
in force. §6 is the only forward‑looking section.

Anchors are file\:line, re‑verified against `main-0.6` on 2026‑07‑27.

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
- In force today (§5): in‑place data‑channel recovery + on‑demand
  `restartIce`/`recreateDataChannel`; signals‑carrier RED redundancy; audio
  priority + video cap; 12s DTLS‑stall default; **tiered readiness** (media
  promotes on ICE+DTLS, the data channel is not a gate); **Cloudflare TURN
  auto‑provisioning**; `iceCandidatePoolSize: 1`; the **establishment‑timeline**
  record; a pure carrier‑switch decision function.
- Still to build (§6): **app‑side join‑time batching** to cut renegotiations, and
  the **data‑channel control‑message fallback** so mute/input indicators don't
  desync while the channel is down. Package‑core reneg coalescing is a known dead
  end — implemented and reverted as unsafe (§6.5).

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

## 2. Measured data — captures from 2026‑05/06, mapped to §1

These are the observations the §5 behavior was built to answer. They predate the
TURN work, so every capture shows `relay=false`; re‑measure before drawing new
conclusions from them.

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
- **ICE config (§1.2).** The static `DEFAULT_ICE_SERVERS` list is **STUN‑only**
  (Twilio, Cloudflare, Google). Note there are **two independent copies** of this
  array — [ui/src/transport/types.ts](../ui/src/transport/types.ts) and
  [packages/webrtc-peer/src/types.ts](../packages/webrtc-peer/src/types.ts) — and
  the package's `DEFAULT_CONFIG` falls back to its own. They are currently
  byte‑identical, so a change to one alone would drift silently.
  **TURN is provisioned automatically from Cloudflare**
  ([cloudflare-turn.ts](../ui/src/cloudflare-turn.ts)); the manual
  `localStorage('turnCredential')` field remains as an override
  ([streams-store.ts:142](../ui/src/streams-store.ts)). The 2026‑05/06 captures
  in §2 predate this and all show `relay=false`.
- **Composite readiness (§1.3–1.5).** `connected` requires **ICE + DTLS only** —
  the data channel is *not* a gate
  ([peer-connection-fsm.ts:1172‑1174](../packages/webrtc-peer/src/peer-connection-fsm.ts)).
  Media can flow the instant those two are up, which is the state the transition
  trigger names: `'media readiness achieved (ICE + DTLS)'`. A data channel that
  has not opened yet is handed to the watchdog
  ([:1030](../packages/webrtc-peer/src/peer-connection-fsm.ts)) rather than
  blocking the call. DTLS‑connected is **inferred** from
  `pc.connectionState === 'connected'` (the `connect` event), not a DTLS‑specific
  signal (§1.3).
- **Trickle ICE.** On by default (`trickleICE: true`,
  [types.ts](../packages/webrtc-peer/src/types.ts)); candidates are sent
  incrementally and end‑of‑candidates is signaled — confirmed in captures.
  `iceCandidatePoolSize` defaults to **1**
  ([types.ts:398](../packages/webrtc-peer/src/types.ts)), so one candidate set is
  pre‑gathered before the offer is built.
- **Timers.** `connection-timeout` 7s (connecting); FSM `sdp-exchange-timeout`
  15s (signaling); **DTLS watchdog** (`dtlsStallTimeoutMs`, now 12s default,
  localStorage‑overridable); **data‑channel watchdog** (`dataChannelStallTimeoutMs`
  4s, recreate‑in‑place, bounded); `iceDisconnectedGraceMs` 15s; **app‑level 15s
  SDP timeout** in StreamsStore
  ([streams-store.ts:6214‑6230](../ui/src/streams-store.ts)). That timer only
  destroys a connection that is still in `SdpExchange` **and** whose entry reads
  `!conn.connected`, so a transport that has reached ICE+DTLS is spared — the
  composite‑readiness rule above is what makes that guard effective.
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
| G2 | DC slow but media flowing (§1.5) | **Now**: `connected` on ICE+DTLS; DC handled by its watchdog | Residual: mute/input indicators desync while the DC is down (§6.1) | partly done |
| G3 | Establishment on a degraded signaling path (§1.1) | **Now**: the 15s app SDP timeout skips any entry reading `conn.connected` | Was: destroyed live transports. **Landed** via G2. | done |
| G4 | Startup renegotiation flurry (§1.6) | Many real offers at join (browser already coalesces same‑tick events); serialize over slow relay | Blows establishment budget; fix app‑side (fewer mutations) — **not** package‑core coalescing (reverted once) | Medium |
| G5 | Symmetric/CGNAT, srflx fails (§1.2) | **Now**: Cloudflare TURN auto‑provisioned, manual override retained | Confirm TURN/TLS‑TCP 443 and prove the relay path forms (§6.3) | mostly done |
| G6 | Bad carrier flapping (§1.1 vs §1.5) | Pure `decideCarrierSwitch`; caller biases toward staying on webrtc while ICE+DTLS are up | Dwell is enforced in `decideAutoFlip`'s cooldown, not here — two places, one rule | mostly done |
| G7 | Last‑mile uplink loss (§1.9) | FEC (platform) + priority + cap | Irreducible; current mitigations are the right ones | Maintain |
| G8 | DTLS stall too eager (§1.3) | **Now** 12s, configurable | Was 5s. **Landed.** | done |
| G9 | Observability | Per‑connection establishment timeline emitted on first `connected` | Residual: no explicit "left webrtc because X" on carrier downgrade (§6.6) | mostly done |

---

## 5. Behavior in force today

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
- **D. Tiered readiness (G2, G3).** `connected` means ICE+DTLS; the data channel
  is a separate concern handled by its watchdog
  ([peer-connection-fsm.ts:1172‑1174](../packages/webrtc-peer/src/peer-connection-fsm.ts)).
  This also disarms G3: the app's 15s SDP timer skips any entry reading
  `conn.connected`. **The one thing this trades away is still outstanding** — the
  UI mute/input‑state messages ride the data channel with no fallback, so peer
  mute indicators can desync while the channel is down. See §6.1.
- **E. TURN (G5).** Credentials are provisioned from Cloudflare at runtime
  ([cloudflare-turn.ts](../ui/src/cloudflare-turn.ts), tested in
  [cloudflare-turn.test.ts](../ui/src/__tests__/cloudflare-turn.test.ts)); the
  manual `localStorage` fields remain as an override. Symmetric/CGNAT peers now
  have a relay path rather than being stuck on signals.
- **F. Establishment timeline (G9).** The FSM emits one structured per‑stage
  record when a connection first reaches `connected`
  (`_emitEstablishmentTimeline`,
  [peer-connection-fsm.ts:1180](../packages/webrtc-peer/src/peer-connection-fsm.ts)),
  so "why were we off webrtc" is answerable without hand‑reading interleaved
  transition logs.
- **G. `iceCandidatePoolSize: 1`** ([types.ts:398](../packages/webrtc-peer/src/types.ts)) —
  one candidate set is pre‑gathered before the offer is built.
- **H. Carrier‑switch damping (G6), partially.** `decideCarrierSwitch`
  ([auto-flip-policy.ts](../ui/src/transport/auto-flip-policy.ts)) is a pure,
  table‑tested decision function with dwell, sustained‑bad and transport‑up rules.
  **At its only call site only the transport‑up rule can fire**: `minDwellMs: 0`
  and `consecutiveBad: 1` are passed deliberately, because the outage scan has
  already waited out the sustained window and dwell is enforced by
  `decideAutoFlip`'s cooldown instead
  ([streams-store.ts:3890‑3903](../ui/src/streams-store.ts)). The net effect is a
  bias toward staying on webrtc while ICE+DTLS are up. If you change either
  caller, check that dwell is still enforced *somewhere* — it is currently the
  cooldown, not this function.

These addressed the largest share of churn (the DC‑gated teardown) and the worst
signals‑carrier loss. §6 is what remains.

---

## 6. What remains to be built

Subsection numbers are stable anchors — other documents cite `§6.1`. Items whose
work is done point at the §5 entry describing the resulting behavior instead of
repeating the proposal.

### 6.1 Data‑channel control‑message fallback (G2)

The tiered‑readiness half of this item is **in force** — see §5.D. What was
traded away to get it is still owed.

- **The gap.** UI mute/input‑state sync — `video-on/off`, `audio-on/off`,
  `change-{audio,video}-input`, `request-track-refresh`
  ([streams-store.ts:1226‑1299, 2152‑2479](../ui/src/streams-store.ts)) — is sent
  **only** over `transport.send()`, i.e. the data channel. `roomClient.sendMessage`
  carries only `Sdp`/`SdpFsm`/`LeaveUi`/`DiagnosticRequest`, so there is no
  fallback path. With media flowing but the channel down, **peer mute and input
  indicators desync** until the watchdog reopens it.
- **What to build.** Either route those messages over a presence‑signal path when
  the channel isn't open, or reconcile explicitly on `data-channel-ready` and
  accept a bounded lag. Also audit `transport.send()` call sites so DC‑dependent
  sends queue rather than silently drop.
- **Check while you are there.** `_computeStatusText`
  ([peer-connection-fsm.ts](../packages/webrtc-peer/src/peer-connection-fsm.ts))
  encodes the older DC‑gated model — it can report `'Opening data channel...'` for
  a state that is now `connected` with media flowing. The string should say
  `Connected`, with the channel state as a sub‑state at most.

### 6.2 Establishment‑timeout hardening (G3) — no work outstanding

6.1's readiness change removed the trigger, and the guard is in the code: the
app's 15s SDP timer destroys a connection only when the entry reads
`!conn.connected` (§3, Timers). A transport that has reached ICE+DTLS is spared.
Reopen this only if a capture shows a live transport being torn down anyway.

### 6.3 TURN (G5) — landed; the rest is ops

Auto‑provisioning is in force (§5.E). Two things are worth confirming against the
Cloudflare configuration rather than assuming: that a **TURN/TLS over TCP 443**
(`turns:…:443?transport=tcp`) candidate is offered — it is what survives lossy‑UDP
paths and 443‑only firewalls — and that the relay path actually forms, which is
best proven with a forced `iceTransportPolicy: 'relay'` build. TURN does **not**
address the PR uplink loss in §2; that is physical.

### 6.4 Carrier‑switch hysteresis (G6) — landed as a decision function

See §5.H. The pure function has dwell, sustained‑bad and transport‑up rules; the
single caller currently exercises only transport‑up, with dwell delegated to
`decideAutoFlip`'s cooldown. The remaining judgement call is whether dwell belongs
in one place rather than two.

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

### 6.6 Observability (G9) — landed

The per‑connection establishment‑timeline record is emitted on first `connected`
(§5.F). The piece not yet built is the matching explicit "left webrtc because X"
reason on every `CarrierSwitch fsm→signals`.

### 6.7 Cheap ICE establishment knobs (G4, supporting) — landed

`iceCandidatePoolSize` ships as 1 (§5.G) and trickle ICE is on with
end‑of‑candidates signaled (§3). Both are covered by
[rtc-peer.test.ts:103‑112](../packages/webrtc-peer/src/__tests__/rtc-peer.test.ts).

---

## 7. Sequencing & acceptance

Remaining work, in order:

1. **6.1 DC control‑message fallback** — the outstanding half of tiered readiness,
   and the only item with a user‑visible symptom today (mute indicators desync).
2. **6.5 app‑side join‑time batching** — reduce real renegotiations at join.
3. **6.3 TURN/TLS‑TCP confirmation** — prove the relay path forms on a forced
   `iceTransportPolicy: 'relay'` build.
4. **6.6 carrier‑downgrade reason** — the "left webrtc because X" half of the
   observability item.
5. **Package‑core reneg coalescing** — only if 6.5 app‑side proves insufficient,
   and only behind the integration‑test gate (§6.5).

**Acceptance, measured from the establishment timeline (§5.F):**
time‑to‑first‑clean‑webrtc at join < a few seconds on a healthy relay; **zero**
teardowns of connections with ICE+DTLS up; no carrier oscillation on a stable
link; relay path proven to form on a forced‑`relay` build. Steady‑state ~2–3% PR
uplink loss is expected to remain (physical) and should be inaudible under FEC.

---

## 8. Open questions

1. **DC fallback shape (6.1):** route the UI mute/input‑state messages over a
   presence‑signal path when the channel is down, or reconcile on
   `data-channel-ready` and accept a bounded desync window?
2. **Signals carrier role:** keep it as a degraded *media* fallback, or demote it
   to control‑only now that TURN exists (so media is always webrtc‑or‑relayed)?
   This is the same question `MAINTAINABILITY_ASSESSMENT.md` §5 Phase 4 asks.
3. **Reneg‑coalescing locus (6.5):** app‑side batching of join‑time media
   operations is the chosen path; the package negotiation core stays untouched
   unless batching proves insufficient.
4. **Multi‑channel:** any near‑term need for additional data channels (would make
   readiness/recovery multi‑channel‑aware), or keep single‑channel?
5. **Dwell location (6.4):** dwell lives in `decideAutoFlip`'s cooldown while
   `decideCarrierSwitch` also has a dwell rule its caller disables. One of the two
   should own it.

---

## 9. Implementation notes for a fresh context

Operational facts a new agent needs:

- **The gate:** `nix develop -c npm run verify` from the repo root runs the
  package tests, builds `packages/webrtc-peer`, runs the ui tests, then
  typechecks both workspaces. **315 tests, all green, under 2 seconds.** Keep it
  green — it is what CI runs on push and PR
  ([.github/workflows/test.yaml](../.github/workflows/test.yaml)).
- **Toolchain:** prefix commands with `nix develop -c`. Individual pieces are
  `npm run test:unit` and `npm run typecheck`.
- **Package ↔ UI wiring:** `packages/webrtc-peer` is symlinked into
  `node_modules/@lightningrodlabs/webrtc-peer`; the UI imports the built `dist/`
  (no vite alias to `src`). **This ordering is load‑bearing** — after editing
  package `src` you must rebuild (`npm run build:packages`) or the ui tests and
  the ui typecheck resolve stale types. `verify` does this for you. `dist/` is
  gitignored.
- **Test harnesses (real, reusable — don't write tautological mocks):**
  `MockRTCPeerConnection` + `MockRTCDataChannel.simulateOpen()` and
  `FakeSignalingChannel` in `packages/webrtc-peer/src/__tests__/test-helpers.ts`.
  That is the **single** copy — the ui FSM tests import it across the workspace
  boundary. `createFSM`/`getConnectedFSM` patterns live in
  `peer-connection-fsm.test.ts`; the data‑channel recovery tests in
  `data-channel-recovery.test.ts` are the template for FSM‑level work. Package
  tests use **global fake timers** (`beforeEach(vi.useFakeTimers)`).
- **Landmines:**
  - The **two‑peer integration suite is timing‑sensitive** — the reverted
    coalescing OOM'd it. Any change to negotiation/timer behavior must run the
    full package suite, not just unit tests.
  - **`MockRTCPeerConnection` cannot throw.** `setRemoteDescription` accepts
    anything in any state, so no package test reproduces the duplicate‑answer
    `InvalidStateError` that is the top documented production failure. A green
    suite is not evidence against a field log.
  - **`StreamsStore` cannot be instantiated under vitest** — `environment: 'node'`
    and the constructor reads `window.sessionStorage`. Don't try to wrap it in
    characterization tests; extract the decision as a pure function instead, the
    way `auto-flip-policy.ts` does.
  - DTLS‑connected is inferred from `connectionState` (§1.3); there is no DTLS
    event to hook.
- **Method:** failing‑test‑first, then implement, then green — and for anything
  touching negotiation/timers, write the **two‑peer integration** test before the
  unit test.
