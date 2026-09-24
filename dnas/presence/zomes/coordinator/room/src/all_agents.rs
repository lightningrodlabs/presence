use hdk::prelude::*;
use room_integrity::*;
use std::collections::BTreeMap;
use crate::helper::ZomeFnInput;
pub const ALL_AGENTS: &str = "ALL_AGENTS";

/// One agent registered on the ALL_AGENTS anchor, with the commit timestamp
/// of its anchor link. `init` creates that link once per cell, so `joined_at`
/// is "when this agent first joined this room, ever" — a stored value every
/// participant reads identically, which the UI sorts grid tiles on
/// (ui/src/room/tile-order-policy.ts).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AgentJoin {
    pub agent: AgentPubKey,
    pub joined_at: Timestamp,
}

#[hdk_extern]
pub fn get_all_agents(input: ZomeFnInput<()>) -> ExternResult<Vec<AgentJoin>> {
    let path = Path::from(ALL_AGENTS);
    let links = get_links(
        LinkQuery::try_new(path.path_entry_hash()?, LinkTypes::AllAgents)?,
        input.get_strategy(),
    )?;
    // One row per agent; if an agent somehow holds several anchor links,
    // the earliest is the join.
    let mut earliest: BTreeMap<AgentPubKey, Timestamp> = BTreeMap::new();
    for link in links {
        if let Ok(agent) = AgentPubKey::try_from(link.target) {
            let ts = link.timestamp;
            earliest
                .entry(agent)
                .and_modify(|t| {
                    if ts < *t {
                        *t = ts
                    }
                })
                .or_insert(ts);
        }
    }
    Ok(earliest
        .into_iter()
        .map(|(agent, joined_at)| AgentJoin { agent, joined_at })
        .collect())
}
#[hdk_extern]
pub fn add_agent_to_anchor(_: ()) -> ExternResult<ActionHash> {
    let path = Path::from(ALL_AGENTS);
    create_link(
        path.path_entry_hash()?,
        agent_info()?.agent_initial_pubkey,
        LinkTypes::AllAgents,
        (),
    )
}
