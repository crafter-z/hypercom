//! Remote client manager for connecting the local HyperCom workbench to
//! paired remote HyperCom hosts over pinned TLS 1.3.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use hypercom_protocol::{
    decode_sha256_pin, validate_remote_endpoint, ArtifactInfoDto, AsyncControlClient,
    ControlCommand, HostError, LoanInfoDto, PluginToolDescriptorDto, PortRef, PortSnapshotDto,
    ProfileStore, RemoteInvite, RemotePluginViewEntryDto, RemoteProfile, RemoteViewEventPageDto,
    RemoteViewSessionDto, SerialParamsDto, SerialRecoveryDto, StreamEventDto,
    MAX_ARTIFACT_CHUNK_BYTES, MAX_POLL_MS,
};

use crate::commands::{CommandError, OpenPortArgs, SendDataArgs, SetSerialParamsArgs};
use crate::serial::{
    self, LoanMetadata, PortInfo, SerialExternalTxEvent, SerialNoteEvent, ToolLoanEvent,
};
use crate::serial::events::{SerialDataEvent, SerialStatusEvent};

const PORTS_REFRESH_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreviewDto {
    pub endpoint: String,
    pub server_id: String,
    pub certificate_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    pub expired: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub ports: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub allow_loan: bool,
    pub device_plugins: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProfileSummaryDto {
    pub id: String,
    pub label: String,
    pub endpoint: String,
    pub server_id: String,
    pub certificate_sha256: String,
    pub client_id: String,
    pub role: String,
    pub ports: Vec<String>,
    pub allow_loan: bool,
    pub device_plugins: bool,
    pub status: String, // "disconnected" | "connecting" | "connected" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub port_count: usize,
}

#[derive(Debug, Clone)]
struct RemoteHostView {
    label: String,
    role: String,
    allow_loan: bool,
    device_plugins: bool,
    status: String,
    error: Option<String>,
    ports: Vec<PortSnapshotDto>,
}

struct LiveHostEntry {
    rpc_client: Arc<tokio::sync::Mutex<AsyncControlClient>>,
    stop_tx: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

pub struct RemoteClientManager {
    store: ProfileStore,
    labels_path: PathBuf,
    labels: Mutex<HashMap<String, String>>,
    views: Mutex<HashMap<String, RemoteHostView>>,
    live: tokio::sync::Mutex<HashMap<String, LiveHostEntry>>,
}

impl RemoteClientManager {
    pub fn new(store_dir: PathBuf, labels_path: PathBuf) -> Self {
        let labels = load_labels(&labels_path);
        Self {
            store: ProfileStore::new(store_dir),
            labels_path,
            labels: Mutex::new(labels),
            views: Mutex::new(HashMap::new()),
            live: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn inspect_invite(invite_json: &str) -> Result<InvitePreviewDto, CommandError> {
        let invite = RemoteInvite::parse(invite_json).map_err(map_host_error)?;
        validate_remote_endpoint(&invite.endpoint).map_err(map_host_error)?;
        decode_sha256_pin(&invite.certificate_sha256).map_err(map_host_error)?;
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        Ok(InvitePreviewDto {
            endpoint: invite.endpoint.clone(),
            server_id: invite.server_id.clone(),
            certificate_sha256: invite.certificate_sha256.clone(),
            expires_at: invite.expires_at,
            expired: invite.is_expired_at(now_ms),
            label: invite.label.clone(),
            ports: invite.ports.clone(),
            role: invite.role.map(|r| r.to_string()),
            allow_loan: invite.allow_loan,
            device_plugins: invite.device_plugins,
        })
    }

    pub async fn pair_profile(
        &self,
        profile_id: String,
        label_override: Option<String>,
        invite_json: String,
        app: Option<&AppHandle>,
    ) -> Result<RemoteProfileSummaryDto, CommandError> {
        ProfileStore::validate_profile_id(&profile_id).map_err(map_host_error)?;
        let invite = RemoteInvite::parse(&invite_json).map_err(map_host_error)?;
        validate_remote_endpoint(&invite.endpoint).map_err(map_host_error)?;
        decode_sha256_pin(&invite.certificate_sha256).map_err(map_host_error)?;

        let store = self.store.clone();
        let pid = profile_id.clone();
        let reservation = tokio::task::spawn_blocking(move || -> Result<_, HostError> {
            store.preflight(&pid)?;
            let reservation = store.reserve(&pid)?;
            reservation.prepare_create()?;
            Ok(reservation)
        })
        .await
        .map_err(|err| CommandError::Other(format!("Profile preflight panicked: {err}")))?
        .map_err(map_host_error)?;

        let profile = AsyncControlClient::pair_remote(&invite)
            .await
            .map_err(map_host_error)?;

        let profile_for_save = profile.clone();
        tokio::task::spawn_blocking(move || reservation.create(&profile_for_save))
            .await
            .map_err(|err| CommandError::Other(format!("Profile save panicked: {err}")))?
            .map_err(map_host_error)?;

        let label = label_override
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| invite.label.clone().filter(|s| !s.trim().is_empty()))
            .unwrap_or_else(|| profile_id.clone());

        self.set_label(&profile_id, &label);
        if let Some(app) = app {
            emit_hosts_changed(app);
        }

        Ok(build_summary(
            profile_id,
            label,
            &profile,
            "disconnected".to_string(),
            None,
            0,
        ))
    }

    pub async fn list_profiles(&self) -> Result<Vec<RemoteProfileSummaryDto>, CommandError> {
        let store = self.store.clone();
        let stored = tokio::task::spawn_blocking(move || store.list())
            .await
            .map_err(|err| CommandError::Other(format!("List profiles panicked: {err}")))?
            .map_err(map_host_error)?;

        let labels = self
            .labels
            .lock()
            .map_err(|err| CommandError::Lock(err.to_string()))?
            .clone();
        let views = self
            .views
            .lock()
            .map_err(|err| CommandError::Lock(err.to_string()))?
            .clone();

        Ok(stored
            .into_iter()
            .map(|item| {
                let label = labels
                    .get(&item.id)
                    .cloned()
                    .unwrap_or_else(|| item.id.clone());
                let (status, error, port_count) = match views.get(&item.id) {
                    Some(view) => (view.status.clone(), view.error.clone(), view.ports.len()),
                    None => ("disconnected".to_string(), None, 0),
                };
                build_summary(item.id, label, &item.profile, status, error, port_count)
            })
            .collect())
    }

    pub async fn connect_profile(
        self: &Arc<Self>,
        profile_id: String,
        app: AppHandle,
    ) -> Result<RemoteProfileSummaryDto, CommandError> {
        ProfileStore::validate_profile_id(&profile_id).map_err(map_host_error)?;
        {
            let guard = self.live.lock().await;
            if guard.contains_key(&profile_id) {
                return self.summary_for_profile(&profile_id).await;
            }
        }

        let store = self.store.clone();
        let pid = profile_id.clone();
        let profile = tokio::task::spawn_blocking(move || store.load(&pid))
            .await
            .map_err(|err| CommandError::Other(format!("Load profile panicked: {err}")))?
            .map_err(map_host_error)?;

        let label = self.label_for(&profile_id);
        {
            let mut views = self
                .views
                .lock()
                .map_err(|err| CommandError::Lock(err.to_string()))?;
            views.insert(
                profile_id.clone(),
                RemoteHostView {
                    label: label.clone(),
                    role: profile.permissions.role.to_string(),
                    allow_loan: profile.permissions.allow_loan,
                    device_plugins: profile.permissions.device_plugins,
                    status: "connecting".to_string(),
                    error: None,
                    ports: Vec::new(),
                },
            );
        }
        emit_hosts_changed(&app);

        let connect_res = async {
            let rpc_client = AsyncControlClient::connect_remote(&profile).await?;
            let mut poll_client = AsyncControlClient::connect_remote(&profile).await?;
            let ports: Vec<PortSnapshotDto> = poll_client.call_typed(ControlCommand::Ports).await?;
            Ok::<_, HostError>((rpc_client, poll_client, ports))
        }
        .await;

        let (rpc_client, poll_client, initial_ports) = match connect_res {
            Ok(ok) => ok,
            Err(err) => {
                if let Ok(mut views) = self.views.lock() {
                    if let Some(view) = views.get_mut(&profile_id) {
                        view.status = "error".to_string();
                        view.error = Some(err.to_string());
                        view.ports.clear();
                    }
                }
                emit_hosts_changed(&app);
                return Err(map_host_error(err));
            }
        };

        {
            let mut views = self
                .views
                .lock()
                .map_err(|err| CommandError::Lock(err.to_string()))?;
            views.insert(
                profile_id.clone(),
                RemoteHostView {
                    label: label.clone(),
                    role: profile.permissions.role.to_string(),
                    allow_loan: profile.permissions.allow_loan,
                    device_plugins: profile.permissions.device_plugins,
                    status: "connected".to_string(),
                    error: None,
                    ports: initial_ports.clone(),
                },
            );
        }

        for port in &initial_ports {
            if port.status == "connected" {
                if let Ok(namespaced) = PortRef::format_remote(&profile_id, &port.id) {
                    let _ = app.emit(
                        "serial:status",
                        SerialStatusEvent {
                            port_id: namespaced,
                            status: "connected".to_string(),
                            generation: Some(port.generation),
                        },
                    );
                }
            }
        }
        emit_hosts_changed(&app);

        let (stop_tx, stop_rx) = watch::channel(false);
        let rpc_client = Arc::new(tokio::sync::Mutex::new(rpc_client));
        let mgr = Arc::clone(self);
        let pid_task = profile_id.clone();
        let app_task = app.clone();
        let task = tokio::spawn(async move {
            mgr.run_sync_loop(pid_task, poll_client, initial_ports, app_task, stop_rx)
                .await;
        });

        let mut live = self.live.lock().await;
        if live.contains_key(&profile_id) {
            stop_tx.send_replace(true);
            task.abort();
            return self.summary_for_profile(&profile_id).await;
        }
        live.insert(
            profile_id.clone(),
            LiveHostEntry {
                rpc_client,
                stop_tx,
                task,
            },
        );
        drop(live);

        self.summary_for_profile(&profile_id).await
    }

    pub async fn disconnect_profile(
        &self,
        profile_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(), CommandError> {
        ProfileStore::validate_profile_id(profile_id).map_err(map_host_error)?;
        let entry = {
            let mut live = self.live.lock().await;
            live.remove(profile_id)
        };
        if let Some(entry) = entry {
            entry.stop_tx.send_replace(true);
            let _ = entry.task.await;
        }

        let prev_ports = {
            let mut views = self
                .views
                .lock()
                .map_err(|err| CommandError::Lock(err.to_string()))?;
            if let Some(view) = views.get_mut(profile_id) {
                view.status = "disconnected".to_string();
                view.error = None;
                std::mem::take(&mut view.ports)
            } else {
                Vec::new()
            }
        };

        if let Some(app) = app {
            emit_disconnected_ports(app, profile_id, &prev_ports);
            emit_hosts_changed(app);
        }
        Ok(())
    }

    pub async fn remove_profile(
        &self,
        profile_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(), CommandError> {
        self.disconnect_profile(profile_id, app).await?;
        let store = self.store.clone();
        let pid = profile_id.to_string();
        tokio::task::spawn_blocking(move || store.remove(&pid))
            .await
            .map_err(|err| CommandError::Other(format!("Remove profile panicked: {err}")))?
            .map_err(map_host_error)?;

        if let Ok(mut views) = self.views.lock() {
            views.remove(profile_id);
        }
        self.remove_label(profile_id);
        if let Some(app) = app {
            emit_hosts_changed(app);
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        let entries: Vec<(String, LiveHostEntry)> = {
            let mut live = self.live.lock().await;
            live.drain().collect()
        };
        for (_, entry) in entries {
            entry.stop_tx.send_replace(true);
            let _ = tokio::time::timeout(Duration::from_millis(500), entry.task).await;
        }
    }

    pub fn list_available_remote_ports(&self) -> Vec<PortInfo> {
        let Ok(views) = self.views.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut profile_ids: Vec<&String> = views.keys().collect();
        profile_ids.sort();
        for profile_id in profile_ids {
            let Some(view) = views.get(profile_id) else {
                continue;
            };
            if view.status != "connected" {
                continue;
            }
            for port in &view.ports {
                let Ok(namespaced_id) = PortRef::format_remote(profile_id, &port.id) else {
                    continue;
                };
                out.push(PortInfo {
                    id: namespaced_id,
                    name: format!("{} ({})", port.name, view.label),
                    port_type: "remote".to_string(),
                    manufacturer: port.manufacturer.clone(),
                    product: port.product.clone(),
                    host_id: Some(profile_id.clone()),
                    host_label: Some(view.label.clone()),
                    remote_port_id: Some(port.id.clone()),
                    remote_role: Some(view.role.clone()),
                    remote_allow_loan: Some(view.allow_loan),
                    remote_status: Some(port.status.clone()),
                    remote_generation: Some(port.generation),
                    remote_baud_rate: port.baud_rate,
                    loan: port.loan.as_ref().map(loan_dto_to_meta),
                });
            }
        }
        out
    }

    pub fn list_connected_remote_snapshots(&self) -> Vec<PortSnapshotDto> {
        let Ok(views) = self.views.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut profile_ids: Vec<&String> = views.keys().collect();
        profile_ids.sort();
        for profile_id in profile_ids {
            let Some(view) = views.get(profile_id) else {
                continue;
            };
            if view.status != "connected" {
                continue;
            }
            for port in &view.ports {
                let Ok(namespaced_id) = PortRef::format_remote(profile_id, &port.id) else {
                    continue;
                };
                out.push(PortSnapshotDto {
                    id: namespaced_id.clone(),
                    name: format!("{} / {}", view.label, port.id),
                    port_type: "remote".to_string(),
                    status: port.status.clone(),
                    generation: port.generation,
                    baud_rate: port.baud_rate,
                    manufacturer: port.manufacturer.clone(),
                    product: port.product.clone(),
                    loan: port.loan.as_ref().map(|loan| {
                        let mut rewritten = loan.clone();
                        rewritten.port_id = namespaced_id.clone();
                        rewritten
                    }),
                });
            }
        }
        out
    }

    pub fn list_connected_remote_loans(&self) -> Vec<LoanInfoDto> {
        let Ok(views) = self.views.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut profile_ids: Vec<&String> = views.keys().collect();
        profile_ids.sort();
        for profile_id in profile_ids {
            let Some(view) = views.get(profile_id) else {
                continue;
            };
            if view.status != "connected" {
                continue;
            }
            for port in &view.ports {
                let Some(loan) = &port.loan else {
                    continue;
                };
                let Ok(namespaced_id) = PortRef::format_remote(profile_id, &port.id) else {
                    continue;
                };
                let mut rewritten = loan.clone();
                rewritten.port_id = namespaced_id;
                out.push(rewritten);
            }
        }
        out
    }

    pub async fn forward_command(
        &self,
        profile_id: &str,
        cmd: ControlCommand,
    ) -> Result<serde_json::Value, HostError> {
        let rpc = {
            let live = self.live.lock().await;
            live.get(profile_id)
                .map(|entry| Arc::clone(&entry.rpc_client))
                .ok_or_else(|| {
                    HostError::new(
                        "remote_not_connected",
                        format!("remote host '{profile_id}' is not connected"),
                    )
                })?
        };
        let mut client = rpc.lock().await;
        client.call(cmd).await
    }

    pub async fn open_port(
        &self,
        profile_id: &str,
        args: OpenPortArgs,
        app: Option<&AppHandle>,
    ) -> Result<(), CommandError> {
        let remote_port_id = args.port_id.clone();
        let params = SerialParamsDto {
            baud_rate: args.baud_rate,
            data_bits: args.data_bits,
            parity: args.parity,
            stop_bits: args.stop_bits,
            handshake: args.handshake,
            dtr: args.dtr,
            rts: args.rts,
        };
        let snapshot: PortSnapshotDto = self
            .call_typed(
                profile_id,
                ControlCommand::Open {
                    port_id: remote_port_id,
                    params: Some(params),
                    host_id: None,
                    expected_generation: None,
                },
            )
            .await?;
        self.apply_port_snapshot(profile_id, snapshot, app);
        Ok(())
    }

    pub async fn close_port(
        &self,
        profile_id: &str,
        port_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(), CommandError> {
        let snapshot: PortSnapshotDto = self
            .call_typed(
                profile_id,
                ControlCommand::Close {
                    port_id: port_id.to_string(),
                    host_id: None,
                    expected_generation: None,
                },
            )
            .await?;
        self.apply_port_snapshot(profile_id, snapshot, app);
        Ok(())
    }

    pub async fn send_data(
        &self,
        profile_id: &str,
        args: SendDataArgs,
    ) -> Result<usize, CommandError> {
        let bytes = serial::build_tx_bytes(&args.data, args.is_hex, &args.append_line_ending)
            .map_err(|err| CommandError::Serial(err.to_string()))?;
        if bytes.is_empty() {
            return Ok(0);
        }
        let val = self
            .call_value(
                profile_id,
                ControlCommand::Send {
                    port_id: args.port_id,
                    data_base64: STANDARD.encode(&bytes),
                    source: Some("gui".to_string()),
                    expected_generation: args.expected_generation,
                },
            )
            .await?;
        let written = val
            .get("bytesWritten")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(bytes.len());
        Ok(written)
    }

    pub async fn set_params(
        &self,
        profile_id: &str,
        args: SetSerialParamsArgs,
    ) -> Result<(), CommandError> {
        let (prev_dtr, prev_rts) = (false, false);
        let snapshot: PortSnapshotDto = self
            .call_typed(
                profile_id,
                ControlCommand::SetParams {
                    port_id: args.port_id,
                    params: SerialParamsDto {
                        baud_rate: args.baud_rate,
                        data_bits: args.data_bits,
                        parity: args.parity,
                        stop_bits: args.stop_bits,
                        handshake: args.handshake,
                        dtr: prev_dtr,
                        rts: prev_rts,
                    },
                    expected_generation: args.expected_generation,
                },
            )
            .await?;
        self.apply_port_snapshot(profile_id, snapshot, None);
        Ok(())
    }

    pub async fn set_flow_control(
        &self,
        profile_id: &str,
        port_id: &str,
        dtr: bool,
        rts: bool,
        expected_generation: Option<u64>,
    ) -> Result<(), CommandError> {
        let snapshot: PortSnapshotDto = self
            .call_typed(
                profile_id,
                ControlCommand::SetFlowControl {
                    port_id: port_id.to_string(),
                    dtr,
                    rts,
                    expected_generation,
                },
            )
            .await?;
        self.apply_port_snapshot(profile_id, snapshot, None);
        Ok(())
    }

    pub async fn attempt_reconnect(
        &self,
        profile_id: &str,
        port_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<(), CommandError> {
        let snapshot: PortSnapshotDto = self
            .call_typed(
                profile_id,
                ControlCommand::Open {
                    port_id: port_id.to_string(),
                    params: None,
                    host_id: None,
                    expected_generation: None,
                },
            )
            .await?;
        self.apply_port_snapshot(profile_id, snapshot, app);
        Ok(())
    }

    pub async fn reclaim_loan(
        &self,
        profile_id: &str,
        port_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<serial::LeaseRecovery, CommandError> {
        let dto: SerialRecoveryDto = self
            .call_typed(
                profile_id,
                ControlCommand::ReclaimLoan {
                    port_id: port_id.to_string(),
                },
            )
            .await?;
        if let Ok(ports) = self
            .call_typed::<Vec<PortSnapshotDto>>(profile_id, ControlCommand::Ports)
            .await
        {
            if let Ok(mut views) = self.views.lock() {
                if let Some(view) = views.get_mut(profile_id) {
                    view.ports = ports;
                }
            }
            if let Some(app) = app {
                emit_hosts_changed(app);
            }
        }
        Ok(serial::LeaseRecovery {
            state: dto.state,
            error: dto.error,
        })
    }

    pub async fn add_note(
        &self,
        profile_id: &str,
        port_id: &str,
        text: String,
        source: Option<String>,
    ) -> Result<(), CommandError> {
        let _ = self
            .call_value(
                profile_id,
                ControlCommand::AddNote {
                    port_id: port_id.to_string(),
                    text,
                    source,
                },
            )
            .await?;
        Ok(())
    }

    pub async fn list_connected_remote_plugin_tools(&self) -> Vec<PluginToolDescriptorDto> {
        let targets: Vec<(String, String)> = {
            let Ok(views) = self.views.lock() else {
                return Vec::new();
            };
            let mut list: Vec<(String, String)> = views
                .iter()
                .filter(|(_, view)| view.status == "connected" && view.device_plugins)
                .map(|(id, view)| (id.clone(), view.label.clone()))
                .collect();
            list.sort_by(|a, b| a.0.cmp(&b.0));
            list
        };
        let mut out = Vec::new();
        for (profile_id, label) in targets {
            match self
                .call_typed::<Vec<PluginToolDescriptorDto>>(
                    &profile_id,
                    ControlCommand::ListPluginTools,
                )
                .await
            {
                Ok(tools) => {
                    for mut tool in tools {
                        tool.host = format!("remote::{profile_id}");
                        tool.host_label = Some(label.clone());
                        out.push(tool);
                    }
                }
                Err(err) => {
                    log::debug!(
                        "Failed to list remote plugin tools from '{}': {}",
                        profile_id,
                        err
                    );
                }
            }
        }
        out
    }

    pub async fn list_remote_plugin_views(
        &self,
        profile_id: &str,
    ) -> Result<Vec<RemotePluginViewEntryDto>, CommandError> {
        self.call_typed(profile_id, ControlCommand::ListRemotePluginViews)
            .await
    }

    pub async fn open_remote_plugin_view(
        &self,
        profile_id: &str,
        plugin_id: String,
        view_id: String,
        bound_port_id: Option<String>,
        params: Option<serde_json::Value>,
    ) -> Result<RemoteViewSessionDto, CommandError> {
        let normalized_port = match bound_port_id {
            Some(raw) => match PortRef::parse(&raw).map_err(map_host_error)? {
                PortRef::Remote {
                    profile_id: ref_profile,
                    port_id: remote_port_id,
                } => {
                    if ref_profile != profile_id {
                        return Err(CommandError::Other(format!(
                            "Bound port '{raw}' does not belong to remote host '{profile_id}'"
                        )));
                    }
                    Some(remote_port_id.to_string())
                }
                PortRef::Local(local) => Some(local.to_string()),
            },
            None => None,
        };
        self.call_typed(
            profile_id,
            ControlCommand::OpenRemotePluginView {
                plugin_id,
                view_id,
                bound_port_id: normalized_port,
                params,
            },
        )
        .await
    }

    pub async fn send_remote_plugin_view_input(
        &self,
        profile_id: &str,
        remote_instance_id: String,
        kind: String,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, CommandError> {
        self.call_value(
            profile_id,
            ControlCommand::SendRemotePluginViewInput {
                remote_instance_id,
                kind,
                payload,
            },
        )
        .await
    }

    pub async fn poll_remote_plugin_view_events(
        &self,
        profile_id: &str,
        remote_instance_id: String,
        after_seq: Option<u64>,
        wait_ms: u64,
    ) -> Result<RemoteViewEventPageDto, CommandError> {
        self.call_typed(
            profile_id,
            ControlCommand::PollRemotePluginViewEvents {
                remote_instance_id,
                after_seq,
                wait_ms,
            },
        )
        .await
    }

    pub async fn close_remote_plugin_view(
        &self,
        profile_id: &str,
        remote_instance_id: String,
    ) -> Result<(), CommandError> {
        let _ = self
            .call_value(
                profile_id,
                ControlCommand::CloseRemotePluginView { remote_instance_id },
            )
            .await?;
        Ok(())
    }

    pub async fn upload_artifact_file(
        &self,
        profile_id: &str,
        file_path: &Path,
    ) -> Result<ArtifactInfoDto, CommandError> {
        let mut file = tokio::fs::File::open(file_path)
            .await
            .map_err(|err| CommandError::Io(format!("Failed to open artifact file: {err}")))?;
        let meta = file
            .metadata()
            .await
            .map_err(|err| CommandError::Io(format!("Failed to stat artifact file: {err}")))?;
        if !meta.is_file() {
            return Err(CommandError::Other(
                "Selected artifact path is not a regular file".into(),
            ));
        }
        let total_bytes = meta.len();
        let name = file_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("artifact.bin")
            .to_string();

        let begin_val = self
            .call_value(
                profile_id,
                ControlCommand::ArtifactBegin {
                    target: None,
                    name,
                    total_bytes: Some(total_bytes),
                    ttl_ms: None,
                },
            )
            .await?;
        let upload_id = begin_val
            .get("uploadId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CommandError::Other("Remote host returned invalid uploadId".into()))?
            .to_string();

        let mut buf = vec![0u8; MAX_ARTIFACT_CHUNK_BYTES];
        let mut offset: u64 = 0;
        let mut hasher = Sha256::new();

        loop {
            let n = match tokio::io::AsyncReadExt::read(&mut file, &mut buf).await {
                Ok(n) => n,
                Err(err) => {
                    let _ = self
                        .call_value(
                            profile_id,
                            ControlCommand::ArtifactAbort {
                                target: None,
                                upload_id,
                            },
                        )
                        .await;
                    return Err(CommandError::Io(format!(
                        "Failed to read artifact file: {err}"
                    )));
                }
            };
            if n == 0 {
                break;
            }
            let chunk = &buf[..n];
            hasher.update(chunk);
            if let Err(err) = self
                .call_value(
                    profile_id,
                    ControlCommand::ArtifactChunk {
                        target: None,
                        upload_id: upload_id.clone(),
                        offset,
                        data_base64: STANDARD.encode(chunk),
                    },
                )
                .await
            {
                let _ = self
                    .call_value(
                        profile_id,
                        ControlCommand::ArtifactAbort {
                            target: None,
                            upload_id,
                        },
                    )
                    .await;
                return Err(err);
            }
            offset = offset.saturating_add(n as u64);
        }

        let sha256: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        self.call_typed(
            profile_id,
            ControlCommand::ArtifactCommit {
                target: None,
                upload_id,
                expected_sha256: Some(sha256),
            },
        )
        .await
    }

    async fn call_value(
        &self,
        profile_id: &str,
        cmd: ControlCommand,
    ) -> Result<serde_json::Value, CommandError> {
        let rpc = {
            let live = self.live.lock().await;
            live.get(profile_id)
                .map(|entry| Arc::clone(&entry.rpc_client))
                .ok_or_else(|| {
                    CommandError::Serial(format!("Remote host '{profile_id}' is not connected"))
                })?
        };
        let mut client = rpc.lock().await;
        client.call(cmd).await.map_err(map_host_error)
    }

    async fn call_typed<T: serde::de::DeserializeOwned>(
        &self,
        profile_id: &str,
        cmd: ControlCommand,
    ) -> Result<T, CommandError> {
        let rpc = {
            let live = self.live.lock().await;
            live.get(profile_id)
                .map(|entry| Arc::clone(&entry.rpc_client))
                .ok_or_else(|| {
                    CommandError::Serial(format!("Remote host '{profile_id}' is not connected"))
                })?
        };
        let mut client = rpc.lock().await;
        client.call_typed(cmd).await.map_err(map_host_error)
    }

    async fn summary_for_profile(
        &self,
        profile_id: &str,
    ) -> Result<RemoteProfileSummaryDto, CommandError> {
        let store = self.store.clone();
        let pid = profile_id.to_string();
        let profile = tokio::task::spawn_blocking(move || store.load(&pid))
            .await
            .map_err(|err| CommandError::Other(format!("Load profile panicked: {err}")))?
            .map_err(map_host_error)?;
        let label = self.label_for(profile_id);
        let (status, error, port_count) = self
            .views
            .lock()
            .ok()
            .and_then(|views| {
                views
                    .get(profile_id)
                    .map(|v| (v.status.clone(), v.error.clone(), v.ports.len()))
            })
            .unwrap_or_else(|| ("disconnected".to_string(), None, 0));
        Ok(build_summary(
            profile_id.to_string(),
            label,
            &profile,
            status,
            error,
            port_count,
        ))
    }

    fn apply_port_snapshot(
        &self,
        profile_id: &str,
        snapshot: PortSnapshotDto,
        app: Option<&AppHandle>,
    ) {
        let mut changed = false;
        if let Ok(mut views) = self.views.lock() {
            if let Some(view) = views.get_mut(profile_id) {
                if let Some(existing) = view.ports.iter_mut().find(|p| p.id == snapshot.id) {
                    if existing.status != snapshot.status
                        || existing.generation != snapshot.generation
                        || existing.loan != snapshot.loan
                    {
                        changed = true;
                    }
                    *existing = snapshot.clone();
                } else {
                    view.ports.push(snapshot.clone());
                    changed = true;
                }
            }
        }
        if let Some(app) = app {
            if let Ok(namespaced) = PortRef::format_remote(profile_id, &snapshot.id) {
                let _ = app.emit(
                    "serial:status",
                    SerialStatusEvent {
                        port_id: namespaced,
                        status: snapshot.status,
                        generation: Some(snapshot.generation),
                    },
                );
            }
            if changed {
                emit_hosts_changed(app);
            }
        }
    }

    async fn run_sync_loop(
        self: Arc<Self>,
        profile_id: String,
        mut poll_client: AsyncControlClient,
        mut cached_ports: Vec<PortSnapshotDto>,
        app: AppHandle,
        mut stop_rx: watch::Receiver<bool>,
    ) {
        let mut last_seqs: HashMap<String, u64> = HashMap::new();
        let mut last_ports_refresh = Instant::now();
        let mut exit_error: Option<String> = None;

        'sync: loop {
            if *stop_rx.borrow() {
                break;
            }

            if last_ports_refresh.elapsed() >= PORTS_REFRESH_INTERVAL {
                let ports_res: Result<Vec<PortSnapshotDto>, HostError> = tokio::select! {
                    res = poll_client.call_typed(ControlCommand::Ports) => res,
                    _ = stop_rx.changed() => break 'sync,
                };
                match ports_res {
                    Ok(fresh) => {
                        let changed = diff_and_emit_ports(&app, &profile_id, &cached_ports, &fresh);
                        cached_ports = fresh.clone();
                        if let Ok(mut views) = self.views.lock() {
                            if let Some(view) = views.get_mut(&profile_id) {
                                view.ports = fresh;
                            }
                        }
                        if changed {
                            emit_hosts_changed(&app);
                        }
                        last_ports_refresh = Instant::now();
                    }
                    Err(err) => {
                        exit_error = Some(err.to_string());
                        break 'sync;
                    }
                }
            }

            let active_ports: Vec<String> = cached_ports
                .iter()
                .filter(|p| p.status == "connected" || p.loan.is_some())
                .map(|p| p.id.clone())
                .collect();

            if active_ports.is_empty() {
                let remaining = PORTS_REFRESH_INTERVAL.saturating_sub(last_ports_refresh.elapsed());
                tokio::select! {
                    _ = tokio::time::sleep(remaining.min(Duration::from_millis(500))) => {}
                    _ = stop_rx.changed() => break 'sync,
                }
                continue;
            }

            let per_port_wait = (MAX_POLL_MS / (active_ports.len() as u64)).clamp(50, MAX_POLL_MS);
            for remote_port_id in active_ports {
                if *stop_rx.borrow() {
                    break 'sync;
                }
                let cmd = if let Some(&after_seq) = last_seqs.get(&remote_port_id) {
                    ControlCommand::PollEvents {
                        port_id: remote_port_id.clone(),
                        after_seq: Some(after_seq),
                        recent: None,
                        wait_ms: per_port_wait,
                        limit: Some(256),
                    }
                } else {
                    ControlCommand::PollEvents {
                        port_id: remote_port_id.clone(),
                        after_seq: None,
                        recent: Some(0),
                        wait_ms: 0,
                        limit: Some(1),
                    }
                };

                let page_res: Result<hypercom_protocol::EventPageDto, HostError> = tokio::select! {
                    res = poll_client.call_typed(cmd) => res,
                    _ = stop_rx.changed() => break 'sync,
                };

                match page_res {
                    Ok(page) => {
                        let first_attach = !last_seqs.contains_key(&remote_port_id);
                        last_seqs.insert(remote_port_id.clone(), page.next_seq);
                        if !first_attach {
                            for ev in page.events {
                                translate_and_emit_event(&app, &profile_id, ev);
                            }
                        }
                    }
                    Err(err) => {
                        exit_error = Some(err.to_string());
                        break 'sync;
                    }
                }
            }
        }

        if let Some(err_msg) = exit_error {
            log::warn!("Remote host '{}' sync disconnected: {}", profile_id, err_msg);
            {
                let mut live = self.live.lock().await;
                live.remove(&profile_id);
            }
            let prev_ports = {
                let mut views = self.views.lock().ok();
                views
                    .as_mut()
                    .and_then(|v| v.get_mut(&profile_id))
                    .map(|view| {
                        view.status = "error".to_string();
                        view.error = Some(err_msg);
                        std::mem::take(&mut view.ports)
                    })
                    .unwrap_or_default()
            };
            emit_disconnected_ports(&app, &profile_id, &prev_ports);
            emit_hosts_changed(&app);
        }
    }

    fn label_for(&self, profile_id: &str) -> String {
        self.labels
            .lock()
            .ok()
            .and_then(|labels| labels.get(profile_id).cloned())
            .unwrap_or_else(|| profile_id.to_string())
    }

    fn set_label(&self, profile_id: &str, label: &str) {
        if let Ok(mut labels) = self.labels.lock() {
            labels.insert(profile_id.to_string(), label.to_string());
            save_labels(&self.labels_path, &labels);
        }
    }

    fn remove_label(&self, profile_id: &str) {
        if let Ok(mut labels) = self.labels.lock() {
            if labels.remove(profile_id).is_some() {
                save_labels(&self.labels_path, &labels);
            }
        }
    }
}

fn translate_and_emit_event(app: &AppHandle, profile_id: &str, ev: StreamEventDto) {
    let Ok(namespaced_port) = PortRef::format_remote(profile_id, &ev.port_id) else {
        return;
    };
    match ev.kind.as_str() {
        "rx" => {
            if let Some(b64) = ev.data_base64 {
                if let Ok(bytes) = STANDARD.decode(b64) {
                    let _ = app.emit(
                        "serial:data",
                        SerialDataEvent {
                            port_id: &namespaced_port,
                            timestamp: ev.timestamp_ms,
                            generation: ev.generation,
                            direction: "RX",
                            data: &bytes,
                            is_hex: false,
                        },
                    );
                }
            }
        }
        "tx" => {
            if let Some(b64) = ev.data_base64 {
                if let Ok(bytes) = STANDARD.decode(b64) {
                    let _ = app.emit(
                        "serial:external-tx",
                        SerialExternalTxEvent {
                            port_id: namespaced_port,
                            timestamp: ev.timestamp_ms,
                            generation: ev.generation,
                            data: bytes,
                            source: ev.source,
                        },
                    );
                }
            }
        }
        "status" => {
            if let Some(status) = ev.status {
                let _ = app.emit(
                    "serial:status",
                    SerialStatusEvent {
                        port_id: namespaced_port,
                        status,
                        generation: Some(ev.generation),
                    },
                );
            }
        }
        "loan" => {
            let active = ev.status.as_deref() == Some("active");
            let loan_ref = ev.loan.as_ref();
            let _ = app.emit(
                "serial:tool-loan",
                ToolLoanEvent {
                    port_id: &namespaced_port,
                    active,
                    lease_id: loan_ref.map(|l| l.lease_id.as_str()),
                    holder: loan_ref.map(|l| l.holder.as_str()),
                    reason: loan_ref.and_then(|l| l.reason.as_deref()),
                    expires_at_ms: loan_ref.and_then(|l| l.expires_at_ms),
                },
            );
        }
        "note" => {
            if let Some(text) = ev.text {
                let _ = app.emit(
                    "serial:note",
                    SerialNoteEvent {
                        port_id: namespaced_port,
                        text,
                        source: ev.source,
                        timestamp: ev.timestamp_ms,
                        generation: ev.generation,
                    },
                );
            }
        }
        _ => {}
    }
}

fn diff_and_emit_ports(
    app: &AppHandle,
    profile_id: &str,
    previous: &[PortSnapshotDto],
    current: &[PortSnapshotDto],
) -> bool {
    if previous == current {
        return false;
    }
    for port in current {
        let prev = previous.iter().find(|p| p.id == port.id);
        let status_changed = prev.is_none_or(|p| p.status != port.status || p.generation != port.generation);
        if status_changed {
            if let Ok(namespaced) = PortRef::format_remote(profile_id, &port.id) {
                let _ = app.emit(
                    "serial:status",
                    SerialStatusEvent {
                        port_id: namespaced,
                        status: port.status.clone(),
                        generation: Some(port.generation),
                    },
                );
            }
        }
    }
    true
}

fn emit_disconnected_ports(app: &AppHandle, profile_id: &str, ports: &[PortSnapshotDto]) {
    for port in ports {
        if port.status == "connected" {
            if let Ok(namespaced) = PortRef::format_remote(profile_id, &port.id) {
                let _ = app.emit(
                    "serial:status",
                    SerialStatusEvent {
                        port_id: namespaced,
                        status: "disconnected".to_string(),
                        generation: Some(port.generation),
                    },
                );
            }
        }
    }
}

fn emit_hosts_changed(app: &AppHandle) {
    let _ = app.emit("remote:hosts-changed", ());
}

fn loan_dto_to_meta(dto: &LoanInfoDto) -> LoanMetadata {
    LoanMetadata {
        lease_id: dto.lease_id.clone(),
        holder: dto.holder.clone(),
        reason: dto.reason.clone(),
        acquired_at_ms: dto.acquired_at_ms,
        expires_at_ms: dto.expires_at_ms,
        auto_reopen: dto.auto_reopen,
        connection_bound: dto.connection_bound,
    }
}

fn build_summary(
    id: String,
    label: String,
    profile: &RemoteProfile,
    status: String,
    error: Option<String>,
    port_count: usize,
) -> RemoteProfileSummaryDto {
    RemoteProfileSummaryDto {
        id,
        label,
        endpoint: profile.endpoint.clone(),
        server_id: profile.server_id.clone(),
        certificate_sha256: profile.certificate_sha256.clone(),
        client_id: profile.client_id.clone(),
        role: profile.permissions.role.to_string(),
        ports: profile.permissions.ports.clone(),
        allow_loan: profile.permissions.allow_loan,
        device_plugins: profile.permissions.device_plugins,
        status,
        error,
        port_count,
    }
}

fn map_host_error(err: HostError) -> CommandError {
    match err.code.as_str() {
        "invalid_request" | "invalid_invite" | "pin_mismatch" | "unauthorized" | "revoked"
        | "forbidden" => CommandError::Other(err.to_string()),
        "profile_io" => CommandError::Io(err.to_string()),
        _ => CommandError::Serial(err.to_string()),
    }
}

#[derive(Default, Serialize, Deserialize)]
struct PersistedLabels {
    labels: HashMap<String, String>,
}

fn load_labels(path: &PathBuf) -> HashMap<String, String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<PersistedLabels>(&raw).ok())
        .map(|p| p.labels)
        .unwrap_or_default()
}

fn save_labels(path: &PathBuf, labels: &HashMap<String, String>) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&PersistedLabels {
        labels: labels.clone(),
    }) {
        let _ = fs::write(path, json);
    }
}
