//! Tauri commands for HyperCom collaboration control plane, remote TLS host,
//! and remote client profiles.

use tauri::{AppHandle, State, WebviewWindow};

use hypercom_protocol::{
    ArtifactInfoDto, ControlCommand, HostError, LoanInfoDto, PluginJobStatusDto,
    PluginToolDescriptorDto, PluginToolInvokeResultDto, PortRef, RemoteClientDto, RemoteInvite,
    RemotePluginViewEntryDto, RemoteRole, RemoteStatusDto, RemoteViewEventPageDto,
    RemoteViewSessionDto,
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
    device_plugins: Option<bool>,
    ttl_secs: Option<u64>,
    state: State<'_, AppState>,
) -> Result<RemoteInvite, CommandError> {
    let parsed_role = role.parse::<RemoteRole>().map_err(map_host_error)?;
    let ttl_ms = ttl_secs.map(|s| s.saturating_mul(1000));
    state
        .control_hub
        .create_invite(
            label,
            ports,
            parsed_role,
            allow_loan,
            device_plugins.unwrap_or(false),
            ttl_ms,
        )
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

#[tauri::command]
pub fn control_sync_plugin_tools(
    tools: Vec<PluginToolDescriptorDto>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    super::plugin::require_main_window(&window)?;
    state.control_hub.plugin_bridge().sync_plugin_tools(tools);
    Ok(())
}

#[tauri::command]
pub fn control_plugin_reply(
    request_id: String,
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    super::plugin::require_main_window(&window)?;
    let _ = state
        .control_hub
        .plugin_bridge()
        .complete_invoke(&request_id, ok, result, error);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn control_plugin_job_event(
    job_id: String,
    kind: String,
    message: Option<String>,
    stream: Option<String>,
    progress: Option<f64>,
    data: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    error: Option<String>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    super::plugin::require_main_window(&window)?;
    state
        .control_hub
        .plugin_bridge()
        .push_job_event(&job_id, &kind, message, stream, progress, data, result, error)
        .map_err(map_host_error)
}

#[tauri::command]
pub fn control_remote_view_event(
    remote_instance_id: String,
    kind: String,
    payload: Option<serde_json::Value>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    super::plugin::require_main_window(&window)?;
    state
        .control_hub
        .plugin_bridge()
        .push_remote_view_event(
            &remote_instance_id,
            &kind,
            payload.unwrap_or(serde_json::Value::Null),
        )
        .map_err(map_host_error)
}

#[tauri::command]
pub async fn remote_list_plugin_views(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<RemotePluginViewEntryDto>, CommandError> {
    state
        .remote_clients
        .list_remote_plugin_views(&profile_id)
        .await
}

#[tauri::command]
pub async fn remote_open_plugin_view(
    profile_id: String,
    plugin_id: String,
    view_id: String,
    bound_port_id: Option<String>,
    params: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<RemoteViewSessionDto, CommandError> {
    state
        .remote_clients
        .open_remote_plugin_view(&profile_id, plugin_id, view_id, bound_port_id, params)
        .await
}

#[tauri::command]
pub async fn remote_send_plugin_view_input(
    profile_id: String,
    remote_instance_id: String,
    kind: String,
    payload: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, CommandError> {
    state
        .remote_clients
        .send_remote_plugin_view_input(
            &profile_id,
            remote_instance_id,
            kind,
            payload.unwrap_or(serde_json::Value::Null),
        )
        .await
}

#[tauri::command]
pub async fn remote_poll_plugin_view_events(
    profile_id: String,
    remote_instance_id: String,
    after_seq: Option<u64>,
    wait_ms: Option<u64>,
    state: State<'_, AppState>,
) -> Result<RemoteViewEventPageDto, CommandError> {
    state
        .remote_clients
        .poll_remote_plugin_view_events(
            &profile_id,
            remote_instance_id,
            after_seq,
            wait_ms.unwrap_or(0),
        )
        .await
}

#[tauri::command]
pub async fn remote_close_plugin_view(
    profile_id: String,
    remote_instance_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state
        .remote_clients
        .close_remote_plugin_view(&profile_id, remote_instance_id)
        .await
}

#[tauri::command]
pub async fn remote_pick_and_upload_artifact(
    profile_id: String,
    title: Option<String>,
    filters: Option<Vec<super::file::PluginFileFilter>>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<ArtifactInfoDto>, CommandError> {
    super::plugin::require_main_window(&window)?;
    let options = super::file::TextFileDialogOptions {
        title,
        default_file_name: None,
        filters,
    };
    let win = window.clone();
    let picked = tokio::task::spawn_blocking(move || {
        super::file::pick_text_file_path(&win, &options, false)
    })
    .await
    .map_err(|err| CommandError::Other(format!("Artifact file picker failed: {err}")))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let info = state
        .remote_clients
        .upload_artifact_file(&profile_id, &path)
        .await?;
    Ok(Some(info))
}

#[tauri::command]
pub async fn create_projected_plugin_view(
    source: tauri::Webview,
    binding: crate::plugin::view_runtime::Binding,
    session: RemoteViewSessionDto,
) -> Result<(), CommandError> {
    crate::plugin::view_runtime::create_projected(source, binding, session).await
}

#[tauri::command]
pub async fn remote_invoke_plugin_tool(
    profile_id: String,
    plugin_id: String,
    tool: String,
    args: Option<serde_json::Value>,
    artifacts: Option<Vec<String>>,
    timeout_ms: Option<u64>,
    state: State<'_, AppState>,
) -> Result<PluginToolInvokeResultDto, CommandError> {
    let val = state
        .remote_clients
        .forward_command(
            &profile_id,
            ControlCommand::InvokePluginTool {
                target: None,
                plugin_id,
                tool,
                args: args.unwrap_or(serde_json::Value::Null),
                artifacts,
                timeout_ms,
            },
        )
        .await
        .map_err(map_host_error)?;
    serde_json::from_value(val)
        .map_err(|err| CommandError::Other(format!("Unexpected plugin tool invoke reply: {err}")))
}

#[tauri::command]
pub async fn remote_poll_plugin_job(
    profile_id: String,
    job_id: String,
    after_seq: Option<u64>,
    wait_ms: Option<u64>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<PluginJobStatusDto, CommandError> {
    let val = state
        .remote_clients
        .forward_command(
            &profile_id,
            ControlCommand::PollPluginJob {
                target: None,
                job_id,
                after_seq,
                wait_ms: wait_ms.unwrap_or(0),
                limit,
            },
        )
        .await
        .map_err(map_host_error)?;
    serde_json::from_value(val)
        .map_err(|err| CommandError::Other(format!("Unexpected plugin job status reply: {err}")))
}

#[tauri::command]
pub async fn remote_cancel_plugin_job(
    profile_id: String,
    job_id: String,
    state: State<'_, AppState>,
) -> Result<PluginJobStatusDto, CommandError> {
    let val = state
        .remote_clients
        .forward_command(
            &profile_id,
            ControlCommand::CancelPluginJob {
                target: None,
                job_id,
            },
        )
        .await
        .map_err(map_host_error)?;
    serde_json::from_value(val)
        .map_err(|err| CommandError::Other(format!("Unexpected plugin job cancel reply: {err}")))
}
