// The coordinator-zome half of `holochain-host.ts`.
//
// Copied from Presence (`lightningrodlabs/presence`),
// `dnas/presence/zomes/coordinator/room/src/lib.rs`, written against `hdk`
// 0.7.1 (Holochain 0.7.1). This is ALL of it: the media messages ride
// `AppWebsocket.sendDirectSignal`, which runs no zome code on either side,
// so the zome's only job is to let other agents deliver direct signals to
// this cell. Before 0.7.1 the same example carried a `send_message` extern
// and a `recv_remote_signal` relay; both are gone.
//
// REFERENCE ONLY. No gate in this package compiles Rust — `npm run
// typecheck`, `npm run test` and `npm run test:browser` never see this file.
// Drop it into your own coordinator zome and build it there.
//
// The contract that matters to the library: the bytes are msgpack
// `{ msg_type, payload }`, opaque to the conductor. The TypeScript side puts
// the `MediaKind` ('voice' | 'filmstrip') in `msg_type` and the carrier's
// payload string in `payload`, verbatim.

use hdk::prelude::*;

/// Runs on the first zome call to the cell. Commits the grant that lets any
/// agent on this DNA send direct signals to this cell. Without it the
/// conductor drops incoming direct signals silently.
#[hdk_extern]
pub fn init(_: ()) -> ExternResult<InitCallbackResult> {
    create_cap_grant(CapGrant::new_direct_signal_grant(
        "direct signals".into(),
        GrantConstraint::Unrestricted,
    ))?;
    Ok(InitCallbackResult::Pass)
}
