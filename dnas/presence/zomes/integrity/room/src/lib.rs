use hdi::prelude::*;
pub mod attachment;
pub use attachment::*;
pub mod room_info;
pub use room_info::*;
pub mod descendent_room;
pub use descendent_room::*;
pub mod anchors;
pub use anchors::*;
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    RoomInfo(RoomInfo),
    Attachment(Attachment),
    DescendentRoom(DescendentRoom),
}
#[derive(Serialize, Deserialize)]
#[hdk_link_types]
pub enum LinkTypes {
    RoomInfoUpdates,
    AllAgents,
    AllDescendentRooms,
    AttachmentUpdates,
    AllAttachments,
}
#[hdk_extern]
pub fn genesis_self_check(_data: GenesisSelfCheckData) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_agent_joining(
    _agent_pub_key: AgentPubKey,
    _membrane_proof: &Option<MembraneProof>,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(store_entry) => match store_entry {
            OpEntry::CreateEntry { app_entry, action } => match app_entry {
                EntryTypes::RoomInfo(room_info) => {
                    validate_create_room_info(action.into(), room_info)
                }
                EntryTypes::Attachment(attachment) => {
                    validate_create_attachment(action.into(), attachment)
                }
                EntryTypes::DescendentRoom(descendent_room) => {
                    validate_create_descendent_room(action.into(), descendent_room)
                }
            },
            OpEntry::UpdateEntry {
                app_entry, action, ..
            } => match app_entry {
                EntryTypes::RoomInfo(room_info) => {
                    validate_create_room_info(action.into(), room_info)
                }
                EntryTypes::Attachment(attachment) => {
                    validate_create_attachment(action.into(), attachment)
                }
                EntryTypes::DescendentRoom(descendent_room) => {
                    validate_create_descendent_room(action.into(), descendent_room)
                }
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::Update(update_entry) => match update_entry {
            OpUpdate::Entry { app_entry, action } => {
                let original_action = must_get_action(action.data.original_action_address.clone())?
                    .action()
                    .to_owned();
                if !matches!(
                    original_action.data,
                    ActionData::Create(_) | ActionData::Update(_)
                ) {
                    return Ok(ValidateCallbackResult::Invalid(
                        "Original action for an update must be a Create or Update action"
                            .to_string(),
                    ));
                }
                match app_entry {
                    EntryTypes::Attachment(attachment) => {
                        let original_app_entry =
                            must_get_valid_record(action.data.original_action_address.clone())?;
                        let original_attachment = match Attachment::try_from(original_app_entry) {
                            Ok(entry) => entry,
                            Err(e) => {
                                return Ok(ValidateCallbackResult::Invalid(format!(
                                    "Expected to get Attachment from Record: {e:?}"
                                )));
                            }
                        };
                        validate_update_attachment(
                            action.into(),
                            attachment,
                            original_action,
                            original_attachment,
                        )
                    }
                    EntryTypes::RoomInfo(room_info) => {
                        let original_app_entry =
                            must_get_valid_record(action.data.original_action_address.clone())?;
                        let original_room_info = match RoomInfo::try_from(original_app_entry) {
                            Ok(entry) => entry,
                            Err(e) => {
                                return Ok(ValidateCallbackResult::Invalid(format!(
                                    "Expected to get RoomInfo from Record: {e:?}"
                                )));
                            }
                        };
                        validate_update_room_info(
                            action.into(),
                            room_info,
                            original_action,
                            original_room_info,
                        )
                    }
                    EntryTypes::DescendentRoom(descendent_room) => {
                        let original_app_entry =
                            must_get_valid_record(action.data.original_action_address.clone())?;
                        let original_descendent_room =
                            match DescendentRoom::try_from(original_app_entry) {
                                Ok(entry) => entry,
                                Err(e) => {
                                    return Ok(ValidateCallbackResult::Invalid(format!(
                                        "Expected to get DescendentRoom from Record: {e:?}"
                                    )));
                                }
                            };
                        validate_update_descendent_room(
                            action.into(),
                            descendent_room,
                            original_action,
                            original_descendent_room,
                        )
                    }
                }
            }
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::Delete(delete_entry) => {
            let original_action_hash = delete_entry.action.data.deletes_address.clone();
            let original_record = must_get_valid_record(original_action_hash)?;
            let original_action = original_record.action().clone();
            if !matches!(
                original_action.data,
                ActionData::Create(_) | ActionData::Update(_)
            ) {
                return Ok(ValidateCallbackResult::Invalid(
                    "Original action for a delete must be a Create or Update action".to_string(),
                ));
            }
            let app_entry_type = match original_action.entry_type() {
                Some(EntryType::App(app_entry_type)) => app_entry_type.clone(),
                _ => {
                    return Ok(ValidateCallbackResult::Valid);
                }
            };
            let entry = match original_record.entry().as_option() {
                Some(entry) => entry,
                None => {
                    return Ok(ValidateCallbackResult::Invalid(
                        "Original record for a delete must contain an entry".to_string(),
                    ));
                }
            };
            let original_app_entry = match EntryTypes::deserialize_from_type(
                app_entry_type.zome_index,
                app_entry_type.entry_index,
                entry,
            )? {
                Some(app_entry) => app_entry,
                None => {
                    return Ok(ValidateCallbackResult::Invalid(
                        "Original app entry must be one of the defined entry types for this zome"
                            .to_string(),
                    ));
                }
            };
            match original_app_entry {
                EntryTypes::RoomInfo(room_info) => validate_delete_room_info(
                    delete_entry.action.into(),
                    original_action,
                    room_info,
                ),
                EntryTypes::Attachment(attachment) => validate_delete_attachment(
                    delete_entry.action.into(),
                    original_action,
                    attachment,
                ),
                EntryTypes::DescendentRoom(descendent_room) => validate_delete_descendent_room(
                    delete_entry.action.into(),
                    original_action,
                    descendent_room,
                ),
            }
        }
        FlatOp::Link(OpLink::CreateLink { link_type, action }) => {
            let base_address = action.data.base_address.clone();
            let target_address = action.data.target_address.clone();
            let tag = action.data.tag.clone();
            match link_type {
                LinkTypes::RoomInfoUpdates => validate_create_link_room_info_updates(
                    action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllAgents => validate_create_link_all_agents(
                    action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllDescendentRooms => validate_create_link_all_descendent_rooms(
                    action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AttachmentUpdates => validate_create_link_attachment_updates(
                    action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllAttachments => validate_create_link_all_attachments(
                    action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
            }
        }
        FlatOp::Link(OpLink::DeleteLink {
            link_type,
            original_action,
            action,
        }) => {
            let base_address = action.data.base_address.clone();
            let target_address = original_action.data.target_address.clone();
            let tag = original_action.data.tag.clone();
            match link_type {
                LinkTypes::RoomInfoUpdates => validate_delete_link_room_info_updates(
                    action.into(),
                    original_action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllAgents => validate_delete_link_all_agents(
                    action.into(),
                    original_action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllDescendentRooms => validate_delete_link_all_descendent_rooms(
                    action.into(),
                    original_action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AttachmentUpdates => validate_delete_link_attachment_updates(
                    action.into(),
                    original_action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllAttachments => validate_delete_link_all_attachments(
                    action.into(),
                    original_action.into(),
                    base_address,
                    target_address,
                    tag,
                ),
            }
        }
        FlatOp::CreateRecord(store_record) => match store_record {
            OpRecord::CreateEntry { app_entry, action } => match app_entry {
                EntryTypes::RoomInfo(room_info) => {
                    validate_create_room_info(action.into(), room_info)
                }
                EntryTypes::Attachment(attachment) => {
                    validate_create_attachment(action.into(), attachment)
                }
                EntryTypes::DescendentRoom(descendent_room) => {
                    validate_create_descendent_room(action.into(), descendent_room)
                }
            },
            OpRecord::UpdateEntry { app_entry, action } => {
                let original_record =
                    must_get_valid_record(action.data.original_action_address.clone())?;
                let original_action = original_record.action().clone();
                if !matches!(
                    original_action.data,
                    ActionData::Create(_) | ActionData::Update(_)
                ) {
                    return Ok(ValidateCallbackResult::Invalid(
                        "Original action for an update must be a Create or Update action"
                            .to_string(),
                    ));
                }
                match app_entry {
                    EntryTypes::RoomInfo(room_info) => {
                        let result =
                            validate_create_room_info(action.clone().into(), room_info.clone())?;
                        if let ValidateCallbackResult::Valid = result {
                            let original_room_info: Option<RoomInfo> = original_record
                                .entry()
                                .to_app_option()
                                .map_err(|e| wasm_error!(e))?;
                            let original_room_info = match original_room_info {
                                Some(room_info) => room_info,
                                None => {
                                    return Ok(
                                            ValidateCallbackResult::Invalid(
                                                "The updated entry type must be the same as the original entry type"
                                                    .to_string(),
                                            ),
                                        );
                                }
                            };
                            validate_update_room_info(
                                action.into(),
                                room_info,
                                original_action,
                                original_room_info,
                            )
                        } else {
                            Ok(result)
                        }
                    }
                    EntryTypes::Attachment(attachment) => {
                        let result =
                            validate_create_attachment(action.clone().into(), attachment.clone())?;
                        if let ValidateCallbackResult::Valid = result {
                            let original_attachment: Option<Attachment> = original_record
                                .entry()
                                .to_app_option()
                                .map_err(|e| wasm_error!(e))?;
                            let original_attachment = match original_attachment {
                                Some(attachment) => attachment,
                                None => {
                                    return Ok(
                                            ValidateCallbackResult::Invalid(
                                                "The updated entry type must be the same as the original entry type"
                                                    .to_string(),
                                            ),
                                        );
                                }
                            };
                            validate_update_attachment(
                                action.into(),
                                attachment,
                                original_action,
                                original_attachment,
                            )
                        } else {
                            Ok(result)
                        }
                    }
                    EntryTypes::DescendentRoom(descendent_room) => {
                        let result = validate_create_descendent_room(
                            action.clone().into(),
                            descendent_room.clone(),
                        )?;
                        if let ValidateCallbackResult::Valid = result {
                            let original_descendent_room: Option<DescendentRoom> = original_record
                                .entry()
                                .to_app_option()
                                .map_err(|e| wasm_error!(e))?;
                            let original_descendent_room = match original_descendent_room {
                                Some(descendent_room) => descendent_room,
                                None => {
                                    return Ok(
                                            ValidateCallbackResult::Invalid(
                                                "The updated entry type must be the same as the original entry type"
                                                    .to_string(),
                                            ),
                                        );
                                }
                            };
                            validate_update_descendent_room(
                                action.into(),
                                descendent_room,
                                original_action,
                                original_descendent_room,
                            )
                        } else {
                            Ok(result)
                        }
                    }
                }
            }
            OpRecord::DeleteEntry { action } => {
                let original_record = must_get_valid_record(action.data.deletes_address.clone())?;
                let original_action = original_record.action().clone();
                if !matches!(
                    original_action.data,
                    ActionData::Create(_) | ActionData::Update(_)
                ) {
                    return Ok(ValidateCallbackResult::Invalid(
                        "Original action for a delete must be a Create or Update action"
                            .to_string(),
                    ));
                }
                let app_entry_type = match original_action.entry_type() {
                    Some(EntryType::App(app_entry_type)) => app_entry_type.clone(),
                    _ => {
                        return Ok(ValidateCallbackResult::Valid);
                    }
                };
                let entry = match original_record.entry().as_option() {
                    Some(entry) => entry,
                    None => {
                        if app_entry_type.visibility.is_public() {
                            return Ok(
                                    ValidateCallbackResult::Invalid(
                                        "Original record for a delete of a public entry must contain an entry"
                                            .to_string(),
                                    ),
                                );
                        } else {
                            return Ok(ValidateCallbackResult::Valid);
                        }
                    }
                };
                let original_app_entry = match EntryTypes::deserialize_from_type(
                    app_entry_type.zome_index,
                    app_entry_type.entry_index,
                    &entry,
                )? {
                    Some(app_entry) => app_entry,
                    None => {
                        return Ok(
                                ValidateCallbackResult::Invalid(
                                    "Original app entry must be one of the defined entry types for this zome"
                                        .to_string(),
                                ),
                            );
                    }
                };
                match original_app_entry {
                    EntryTypes::RoomInfo(original_room_info) => validate_delete_room_info(
                        action.into(),
                        original_action,
                        original_room_info,
                    ),
                    EntryTypes::Attachment(original_attachment) => validate_delete_attachment(
                        action.into(),
                        original_action,
                        original_attachment,
                    ),
                    EntryTypes::DescendentRoom(original_descendent_room) => {
                        validate_delete_descendent_room(
                            action.into(),
                            original_action,
                            original_descendent_room,
                        )
                    }
                }
            }
            OpRecord::CreateLink { link_type, action } => {
                let base_address = action.data.base_address.clone();
                let target_address = action.data.target_address.clone();
                let tag = action.data.tag.clone();
                match link_type {
                    LinkTypes::RoomInfoUpdates => validate_create_link_room_info_updates(
                        action.into(),
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::AllAgents => validate_create_link_all_agents(
                        action.into(),
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::AllDescendentRooms => validate_create_link_all_descendent_rooms(
                        action.into(),
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::AttachmentUpdates => validate_create_link_attachment_updates(
                        action.into(),
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::AllAttachments => validate_create_link_all_attachments(
                        action.into(),
                        base_address,
                        target_address,
                        tag,
                    ),
                }
            }
            OpRecord::DeleteLink { action } => {
                let base_address = action.data.base_address.clone();
                let record = must_get_valid_record(action.data.link_add_address.clone())?;
                let original_action = record.action().clone();
                let create_link = match &original_action.data {
                    ActionData::CreateLink(create_link) => create_link.clone(),
                    _ => {
                        return Ok(ValidateCallbackResult::Invalid(
                            "The action that a DeleteLink deletes must be a CreateLink".to_string(),
                        ));
                    }
                };
                let link_type =
                    match LinkTypes::from_type(create_link.zome_index, create_link.link_type)? {
                        Some(lt) => lt,
                        None => {
                            return Ok(ValidateCallbackResult::Valid);
                        }
                    };
                match link_type {
                    LinkTypes::RoomInfoUpdates => validate_delete_link_room_info_updates(
                        action.into(),
                        original_action,
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                    LinkTypes::AllAgents => validate_delete_link_all_agents(
                        action.into(),
                        original_action,
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                    LinkTypes::AllDescendentRooms => validate_delete_link_all_descendent_rooms(
                        action.into(),
                        original_action,
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                    LinkTypes::AttachmentUpdates => validate_delete_link_attachment_updates(
                        action.into(),
                        original_action,
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                    LinkTypes::AllAttachments => validate_delete_link_all_attachments(
                        action.into(),
                        original_action,
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                }
            }
            OpRecord::CreatePrivateEntry { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::UpdatePrivateEntry { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::CreateCapClaim { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::CreateCapGrant { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::UpdateCapClaim { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::UpdateCapGrant { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::Dna { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::OpenChain { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::CloseChain { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::InitZomesComplete { .. } => Ok(ValidateCallbackResult::Valid),
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::AgentActivity(agent_activity) => match agent_activity {
            OpActivity::CreateAgent { action, agent } => {
                let prev_action_hash = action.prev_action().cloned().ok_or(wasm_error!(
                    WasmErrorInner::Guest(
                        "CreateAgent action must have a previous action".to_string()
                    )
                ))?;
                let previous_action = must_get_action(prev_action_hash)?;
                match &previous_action.action().data {
                        ActionData::AgentValidationPkg(
                            AgentValidationPkgData { membrane_proof },
                        ) => validate_agent_joining(agent, membrane_proof),
                        _ => {
                            Ok(
                                ValidateCallbackResult::Invalid(
                                    "The previous action for a `CreateAgent` action must be an `AgentValidationPkg`"
                                        .to_string(),
                                ),
                            )
                        }
                    }
            }
            _ => Ok(ValidateCallbackResult::Valid),
        },
    }
}
