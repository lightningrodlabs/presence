# tests/ — conductor-level (tryorama) workspace

Runs against the Holochain 0.7 stack: `@holochain/client` ^0.21.0 and
`@holochain-open-dev/tryorama` ^0.20.0. Requires `workdir/presence.happ`
(root `npm run build:happ`); root `npm test` builds the happ and then runs
`npm t -w tests`, which executes the `src/room` suite only.

Framework decision (2026-08-03, the 0.7 upgrade): **tryorama, not sweettest.**

- Upstream `@holochain/tryorama` tops out at 0.19.2 (client ^0.20.4, i.e.
  Holochain 0.6); the `@holochain-open-dev` fork is the only 0.7-compatible
  release and is what moss runs its 0.7.0 suites on — a proven model.
- Sweettest would mean compiling the `holochain` crate as a Rust
  dev-dependency (a cold build measured in tens of minutes) against a repo
  gate that runs in seconds; tryorama uses the prebuilt holonix conductor.
- Tryorama exercises the conductor + client wire format the UI will use in
  the second (UI) step of the upgrade; sweettest bypasses that surface.
- The cost of tryorama is JS version drift — exactly what made this
  workspace unbuildable from 2026-04 to 2026-08. Mitigation is running it,
  not choosing a different framework (working agreement 5).

Contents:

- `src/room/room.test.ts` — DNA integration suite (the gate content): every
  coordinator extern reachable without a UI, across two conductors — room
  info, the ALL_AGENTS anchor, attachment CRUD, descendent rooms, and the
  ping/pong + `send_message` remote-signal path.
- `src/signal-latency/signal-latency.test.ts` — a signal latency/throughput
  measurement rig (two agents, one conductor, RTT and sustained-throughput
  stats with p95/p99). Written 2026-04, sat untracked until the 2026-08 retro
  (§7.5 item 4). It is a measurement instrument, not a regression gate — its
  assertions are delivery sanity checks, not thresholds. Run it with
  `npm run test:latency -w tests`; it is deliberately excluded from `test`.

What belongs here eventually: zome tests exercising each
`ValidateCallbackResult::Invalid` branch of the integrity zomes — the
highest-consequence untested code in the repo (assessment §3.12). They are
not in `src/room` because no coordinator extern can author the offending
actions (there is no update-RoomInfo or delete-RoomInfo extern to call);
reaching those branches needs either test-only externs or raw-commit
machinery.
