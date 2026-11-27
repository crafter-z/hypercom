//! Tauri commands for HyperCom collaboration control plane, remote TLS host,
//! and remote client profiles.

use tauri::{AppHandle, State};

use hypercom_protocol::{
    HostError, LoanInfoDto, PortRef, RemoteClientDto, RemoteInvite, RemoteRole, RemoteStatusDto,
};

use super::CommandError;
use crate::{control, remote_client, serial, AppState};

fn map_host_error(err: HostError) -> CommandError {
    match err.code.as_str() {
        "invalid_request" | "invalid_invite" | "pin_mismatch" | "unauthorized" | "revoked"
        | "forbidden" => CommandError::Other(err.to_string()),
        "profile_io" => CommandError::Io(err.to_string()),
        _ => CommandError::Serial(err.to_string()),
    }
}

#[tauri::command]
pub async fn get_collaboration_status(
    state: State<'_, AppState>,
) -> Result<control::CollaborationStatusDto, CommandError> {
    Ok(state.control_hub.collaboration_status(None).await)
}

#[tauri::command]
pub async fn reclaim_port_loan(
    port_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serial::LeaseRecovery, CommandError> {
    match PortRef::parse(&port_id).map_err(map_host_error)? {
        PortRef::Remote {
            profile_id,
            port_id,
        } => {
            state
                .remote_clients
                .reclaim_loan(profile_id, port_id, Some(&app))
                .await
        }
        PortRef::Local(local_port) => state
            .control_hub
            .reclaim_loan_local(local_port)
            .await
            .map_err(map_host_error),
    }
}

#[tauri::command]
pub fn list_port_leases(state: State<'_, AppState>) -> Result<Vec<LoanInfoDto>, CommandError> {
    Ok(state.control_hub.list_loans_for_actor(None))
}

#[tauri::command]
pub async fn remote_host_start(
    listen: String,
    advertise: Option<String>,
    state: State<'_, AppState>,
) -> Result<RemoteStatusDto, CommandError> {
    state
        .control_hub
        .start_remote(listen, advertise)
        .await
        .map_err(map_host_error)
}

#[tauri::command]
pub async fn remote_host_stop(state: State<'_, AppState>) -> Result<(), CommandError> {
    state.control_hub.stop_remote().await.map_err(map_host_error)
}

#[tauri::command]
pub async fn remote_host_create_invite(
    label: String,
    ports: Vec<String>,
    role: String,
    allow_loan: bool,
    ttl_secs: Option<u64>,
    state: State<'_, AppState>,
) -> Result<RemoteInvite, CommandError> {
    let parsed_role = role.parse::<RemoteRole>().map_err(map_host_error)?;
    let ttl_ms = ttl_secs.map(|s| s.saturating_mul(1000));
    state
        .control_hub
        .create_invite(label, ports, parsed_role, allow_loan, ttl_ms)
        .await
        .map_err(map_host_error)
}

#[tauri::command]
pub async fn remote_host_list_clients(
    state: State<'_, AppState>,
) -> Result<Vec<RemoteClientDto>, CommandError> {
    state
        .control_hub
        .list_clients()
        .await
        .map_err(map_host_error)
}

#[tauri::command]
pub async fn remote_host_revoke_client(
    client_id: String,
    state: State<'_, AppState>,
) -> Result<RemoteClientDto, CommandError> {
    state
        .control_hub
        .revoke_client(&client_id)
        .await
        .map_err(map_host_error)
}

#[tauri::command]
pub fn remote_client_inspect_invite(
    invite_json: String,
) -> Result<remote_client::InvitePreviewDto, CommandError> {
    remote_client::RemoteClientManager::inspect_invite(&invite_json)
}

#[tauri::command]
pub async fn remote_client_pair(
    profile_id: String,
    label_override: Option<String>,
    invite_json: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<remote_client::RemoteProfileSummaryDto, CommandError> {
    state
        .remote_clients
        .pair_profile(profile_id, label_override, invite_json, Some(&app))
        .await
}

#[tauri::command]
pub async fn remote_client_list_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<remote_client::RemoteProfileSummaryDto>, CommandError> {
    state.remote_clients.list_profiles().await
}

#[tauri::command]
pub async fn remote_client_connect(
    profile_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<remote_client::RemoteProfileSummaryDto, CommandError> {
    state.remote_clients.connect_profile(profile_id, app).await
}

#[tauri::command]
pub async fn remote_client_disconnect(
    profile_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state
        .remote_clients
        .disconnect_profile(&profile_id, Some(&app))
        .await
}

#[tauri::command]
pub async fn remote_client_remove_profile(
    profile_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state
        .remote_clients
        .remove_profile(&profile_id, Some(&app))
        .await
}
