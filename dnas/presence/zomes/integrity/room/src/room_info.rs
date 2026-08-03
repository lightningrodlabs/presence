use hdi::prelude::*;

pub const ROOM_INFO: &str = "ROOM_INFO";

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct RoomInfo {
    pub name: String,
    pub icon_src: Option<String>,
    pub meta_data: Option<String>,
}
pub fn validate_create_room_info(
    _action: Action,
    _room_info: RoomInfo,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_update_room_info(
    _action: Action,
    _room_info: RoomInfo,
    _original_action: Action,
    _original_room_info: RoomInfo,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "Updating a RoomInfo entry is not allowed.".into(),
    ))
}
pub fn validate_delete_room_info(
    _action: Action,
    _original_action: Action,
    _original_room_info: RoomInfo,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(String::from(
        "Room Infos cannot be deleted",
    )))
}
pub fn validate_create_link_room_info_updates(
    _action: Action,
    base_address: AnyLinkableHash,
    target_address: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    let path = Path::from(ROOM_INFO);
    let path_entry_hash = path.path_entry_hash()?;
    let base_entry_hash = match EntryHash::try_from(base_address) {
        Ok(eh) => eh,
        Err(_) => {
            return Ok(ValidateCallbackResult::Invalid(
                "Base address of a RoomInfoUpdates link must be an entry hash.".into(),
            ))
        }
    };
    if base_entry_hash != path_entry_hash {
        return Ok(ValidateCallbackResult::Invalid(
            "RoomInfoUpdates links must have the RoomInfo anchor as their base.".into(),
        ));
    }

    let room_info_action_hash =
        target_address
            .into_action_hash()
            .ok_or(wasm_error!(WasmErrorInner::Guest(String::from(
                "Link to RoomInfo entry is not an action hash"
            ))))?;
    let record = must_get_valid_record(room_info_action_hash)?;
    let _room_info: crate::RoomInfo = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(String::from(
            "Linked action must point to a RoomInfo entry"
        ))))?;
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_delete_link_room_info_updates(
    _action: Action,
    _original_action: Action,
    _base: AnyLinkableHash,
    _target: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(String::from(
        "RoomInfoUpdates links cannot be deleted",
    )))
}
