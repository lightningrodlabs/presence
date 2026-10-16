use hdk::prelude::*;

/// The zome's remote-signal vocabulary: passive presence only. Since 0.17.0
/// (Holochain 0.7.1) every frontend message rides a direct signal from the
/// UI to the peer's app interface (`AppWebsocket.sendDirectSignal`, granted
/// in `init`); the zome never sees it. Ping/Pong stays here on purpose: the
/// pong is answered inside the zome, so an agent whose UI is closed still
/// answers.
#[derive(Serialize, Deserialize, SerializedBytes, Debug, Clone)]
#[serde(tag = "type")]
pub enum SignalPayload {
    /// Backend auto-response: automatically replies with Pong, no UI involvement
    Ping {
        from_agent: AgentPubKey,
    },
    /// Backend auto-response to Ping
    Pong {
        from_agent: AgentPubKey,
    },
}

#[hdk_extern]
pub fn recv_remote_signal(signal: ExternIO) -> ExternResult<()> {
    let signal_payload: SignalPayload = signal
        .decode()
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    debug!("### GOT REMOTE SIGNAL ###");
    match signal_payload.clone() {
        SignalPayload::Ping { from_agent } => pong(from_agent),
        SignalPayload::Pong { .. } => emit_signal(signal_payload),
    }
}

/// Send a remote signal to the given users to check whether they are online
/// After this ping is sent, a pong is expected as soon as the agents receive the signal
/// NOTE: The pong to this ping is automatically emitted in the backend, independent
/// of whether the UI for that cell is currently running
#[hdk_extern]
pub fn ping(agents_pub_keys: Vec<AgentPubKey>) -> ExternResult<()> {
    let signal_payload = SignalPayload::Ping {
        from_agent: agent_info()?.agent_initial_pubkey,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    send_remote_signal(encoded_signal, agents_pub_keys)
}

fn pong(from_agent: AgentPubKey) -> ExternResult<()> {
    let signal_payload = SignalPayload::Pong {
        from_agent: agent_info()?.agent_initial_pubkey,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    send_remote_signal(encoded_signal, vec![from_agent])
}
