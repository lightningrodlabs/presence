// The coordinator-zome half of `holochain-host.ts`.
//
// Copied from Presence (`lightningrodlabs/presence`),
// `dnas/presence/zomes/coordinator/room/src/remote_signals.rs`, written
// against `hdk` 0.7.0 (Holochain 0.7). Trimmed to the media path: the
// original also carries `Ping`/`Pong` variants that the backend
// auto-answers for passive presence, independent of whether any UI is
// running. This example's ping/pong is an application-level exchange over
// the `Message` variant instead, so those two are omitted here.
//
// REFERENCE ONLY. No gate in this package compiles Rust — `npm run
// typecheck`, `npm run test` and `npm run test:browser` never see this file.
// Drop it into your own coordinator zome and build it there.
//
// The contract that matters to the library: `msg_type` and `payload` are
// opaque strings the backend never inspects. The TypeScript side puts the
// `MediaKind` ('voice' | 'filmstrip') in `msg_type` and the carrier's payload
// string in `payload`, verbatim.

use hdk::prelude::*;

#[derive(Serialize, Deserialize, SerializedBytes, Debug, Clone)]
#[serde(tag = "type")]
pub enum SignalPayload {
    /// Generic UI message — every frontend signal type goes through this
    /// variant. `msg_type` and `payload` are opaque to the backend;
    /// semantics are defined entirely in the frontend.
    Message {
        from_agent: AgentPubKey,
        msg_type: String,
        payload: String,
    },
}

/// Send a generic message to the given agents. The `msg_type` and `payload`
/// are opaque to the backend — all semantics are defined in the frontend.
#[hdk_extern]
pub fn send_message(input: SendMessageInput) -> ExternResult<()> {
    let signal_payload = SignalPayload::Message {
        from_agent: agent_info()?.agent_initial_pubkey,
        msg_type: input.msg_type,
        payload: input.payload,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    send_remote_signal(encoded_signal, input.to_agents)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SendMessageInput {
    pub to_agents: Vec<AgentPubKey>,
    pub msg_type: String,
    pub payload: String,
}

/// Receives what `send_message` sent and re-emits it locally, which is what
/// reaches the RECEIVING agent's UI as a signal.
#[hdk_extern]
pub fn recv_remote_signal(signal: ExternIO) -> ExternResult<()> {
    let signal_payload: SignalPayload = signal
        .decode()
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    match signal_payload.clone() {
        SignalPayload::Message { .. } => emit_signal(signal_payload),
    }
}
