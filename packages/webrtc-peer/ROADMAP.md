# Roadmap

## SFU / selective forwarding (planned)

The mesh topology (every peer connects to every other, each sending its media to
all) is O(n²) in connections and uplink — it caps practical room size. The plan
is to let high-bandwidth nodes **volunteer** as a selective-forwarding unit
(SFU): a relay receives each source's media once and forwards a chosen subset to
subscribers, breaking the n² limit toward larger rooms with full video.

### What exists today

`ConnectionRole` (`'mesh' | 'sfu-upstream' | 'sfu-downstream' | 'sfu-relay'`) is a
**reserved marker only**. Only `'mesh'` is functional; the `sfu-*` values carry
no behavior and are **unstable** — do not depend on them (see the type's JSDoc).
The field is threaded to `PeerConnectionFSM` and `PeerCreatedContext`, which is
where forwarding behavior will attach, so adopting SFU later is an additive,
opt-in upgrade for consumers.

### What SFU support will require (and where it lives)

1. **Per-connection media direction** — relay↔source is `recvonly`, relay↔subscriber
   is `sendonly`; a participant's uplink is `sendonly`, downlink `recvonly`. This
   is the atomic primitive (and is the same as the general "send audio/video
   only" direction control). It belongs in this library. Today it can be done
   manually via `onPeerCreated` + `pc.addTransceiver(kind, { direction })`.
2. **Cross-connection track forwarding** — take a track received on one
   connection and `addTrack`/`replaceTrack` it onto others. The SFU core; lives
   at the `ConnectionManager` level. Not yet designed.
3. **Topology / loop-prevention** — who relays for whom, subscription chains,
   loop refusal. Application-level (e.g. presence/room membership), not this
   library.

### Design note — the role model will likely change

The flat 4-value enum is mis-sized for the relay: a relay holds many connections
with *different* directions each (recvonly to sources, sendonly to subscribers),
so a single per-FSM `'sfu-relay'` can't express it. The intended shape is
**per-connection media direction + a node-level relay capability**, not the flat
enum. The `sfu-*` values are reserved against that and may be reshaped before
SFU ships; the change will be guarded by semver and a changelog note.

### Sequencing

The implementation (layers 2–3, plus wiring layer 1 into roles) will land on a
dedicated branch when scheduled, tracked against the Presence transport plan
(`TRANSPORT_REFACTOR_PLAN.md`, phases 4–6). Nothing in this list blocks the
current release; the marker keeps the door open at near-zero cost.
