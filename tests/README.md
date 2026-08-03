# tests/ — conductor-level (tryorama) workspace

**Status: PRESERVED, NOT A GATE.** Nothing in CI runs this workspace, and it
cannot currently build: its `@holochain/client` (^0.15) and `@holochain/tryorama`
(^0.15.0-rc.1) predate the ui workspace's client (^0.20.x) by five minors.
Version alignment is scheduled with the deferred Rust-validation phase
(`MAINTAINABILITY_ASSESSMENT.md` "Not audited" — decision 2026-07-31: runs as
part of the 0.7 upgrade). Until then, root `npm test` reaching this workspace
is a recorded intention, not a check (working agreement 5).

Contents:

- `src/signal-latency/signal-latency.test.ts` — a signal latency/throughput
  measurement rig (two agents, one conductor, RTT and sustained-throughput
  stats with p95/p99). Written 2026-04, sat untracked until the 2026-08 retro
  (§7.5 item 4). It is a measurement instrument, not a regression gate — its
  assertions are delivery sanity checks, not thresholds. Requires
  `workdir/presence.happ` (root `npm run build:happ`) and aligned tryorama
  versions to run.

What belongs here eventually: zome tests exercising each
`ValidateCallbackResult::Invalid` branch of the integrity zomes — the
highest-consequence untested code in the repo (assessment §3.12).
