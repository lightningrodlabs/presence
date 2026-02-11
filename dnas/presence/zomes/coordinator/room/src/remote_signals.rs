use hdk::prelude::*;

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
    /// Generic UI message — all frontend signal types go through this variant.
    /// msg_type and payload are opaque to the backend; semantics are defined
    /// entirely in the frontend.
    Message {
        from_agent: AgentPubKey,
        msg_type: String,
        payload: String,
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
        SignalPayload::Message { .. } => emit_signal(signal_payload),
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

#[derive(Serialize, Deserialize, Debug)]
pub struct SendMessageInput {
    pub to_agents: Vec<AgentPubKey>,
    pub msg_type: String,
    pub payload: String,
}

/// Send a generic message to the given agents. The msg_type and payload are
/// opaque to the backend — all semantics are defined in the frontend.
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
