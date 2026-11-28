//! Unified local IPC and remote TLS 1.3 control plane for HyperCom.
//!
//! Hosts a same-user local IPC listener (`LocalListener`), an optional pinned
//! TLS 1.3 remote host (`Authority` + `build_tls_acceptor`), and a 1-second TTL
//! lease reaper over `PortLeaseRegistry` and `SerialEventHub`.

pub mod artifacts;
mod dispatch;
pub mod plugin_bridge;
mod server;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::watch;
use uuid::Uuid;

use hypercom_protocol::{
    validate_endpoint_name, Access, Authority, HostError, LoanInfoDto, Peer, RemoteClientDto,
    RemoteInvite, RemotePermissions, RemoteRole, RemoteStatusDto, DEFAULT_ENDPOINT,
    PROTOCOL_VERSION,
};

use crate::{logger, serial};

pub(crate) use dispatch::loan_meta_to_dto;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationStatusDto {
    pub host_id: String,
    pub protocol: u32,
    pub local_endpoint: String,
    pub local_running: bool,
    pub local_clients: usize,
    pub remote: RemoteStatusDto,
    pub remote_clients: usize,
    pub active_loans: Vec<LoanInfoDto>,
}

#[derive(Clone)]
pub(crate) enum Actor {
    Local {
        conn_owner: String,
    },
    Remote {
        peer: Arc<Peer>,
        conn_owner: String,
    },
}

impl Actor {
    pub(crate) fn is_local(&self) -> bool {
        matches!(self, Self::Local { .. })
    }

    pub(crate) fn conn_owner(&self) -> &str {
        match self {
            Self::Local { conn_owner } | Self::Remote { conn_owner, .. } => conn_owner,
        }
    }

    pub(crate) fn check_access(&self, access: Access, port_id: Option<&str>) -> Result<(), HostError> {
        match self {
            Self::Local { .. } => Ok(()),
            Self::Remote { peer, .. } => peer.check(access, port_id),
        }
    }

    pub(crate) fn default_source(&self) -> String {
        match self {
            Self::Local { .. } => "local".to_string(),
            Self::Remote { peer, .. } => format!("remote:{}", peer.label()),
        }
    }
}

struct RemoteServerHandle {
    listen_addr: String,
    advertise_addr: String,
    authority: Arc<Authority>,
    remote_clients: Arc<AtomicUsize>,
    stop_tx: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteLeaseTrack {
    pub(crate) profile_id: String,
    pub(crate) namespaced_port_id: String,
    pub(crate) conn_owner: String,
    pub(crate) connection_bound: bool,
}

pub struct ControlHub {
    host_id: String,
    endpoint_name: String,
    state_dir: PathBuf,
    serial_manager: Arc<Mutex<serial::SerialManager>>,
    event_hub: Arc<serial::SerialEventHub>,
    lease_registry: Arc<serial::PortLeaseRegistry>,
    log_manager: Arc<logger::LogManager>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    remote_clients: Mutex<Option<Arc<crate::remote_client::RemoteClientManager>>>,
    remote_leases: Mutex<HashMap<String, RemoteLeaseTrack>>,
    artifact_store: Arc<artifacts::ArtifactStore>,
    plugin_bridge: Arc<plugin_bridge::PluginControlBridge>,
    local_running: AtomicBool,
    local_clients: AtomicUsize,
    remote_state: tokio::sync::Mutex<Option<RemoteServerHandle>>,
    authority_io: tokio::sync::Mutex<()>,
    authority_cache: Mutex<Option<Arc<Authority>>>,
    shutdown_tx: watch::Sender<bool>,
}

impl ControlHub {
    pub fn new(
        serial_manager: Arc<Mutex<serial::SerialManager>>,
        event_hub: Arc<serial::SerialEventHub>,
        lease_registry: Arc<serial::PortLeaseRegistry>,
        log_manager: Arc<logger::LogManager>,
        state_dir: PathBuf,
    ) -> Self {
        let endpoint_name = resolve_endpoint_name();
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        let artifact_store = Arc::new(artifacts::ArtifactStore::new(state_dir.join("artifacts")));
        let plugin_bridge = Arc::new(plugin_bridge::PluginControlBridge::new());
        Self {
            host_id: Uuid::new_v4().to_string(),
            endpoint_name,
            state_dir,
            serial_manager,
            event_hub,
            lease_registry,
            log_manager,
            app_handle: Mutex::new(None),
            remote_clients: Mutex::new(None),
            remote_leases: Mutex::new(HashMap::new()),
            artifact_store,
            plugin_bridge,
            local_running: AtomicBool::new(false),
            local_clients: AtomicUsize::new(0),
            remote_state: tokio::sync::Mutex::new(None),
            authority_io: tokio::sync::Mutex::new(()),
            authority_cache: Mutex::new(None),
            shutdown_tx,
        }
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn endpoint_name(&self) -> &str {
        &self.endpoint_name
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        if let Ok(mut guard) = self.app_handle.lock() {
            *guard = Some(handle);
        }
    }

    pub(crate) fn app_handle(&self) -> Option<tauri::AppHandle> {
        self.app_handle
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub fn artifact_store(&self) -> &Arc<artifacts::ArtifactStore> {
        &self.artifact_store
    }

    pub fn plugin_bridge(&self) -> &Arc<plugin_bridge::PluginControlBridge> {
        &self.plugin_bridge
    }

    pub fn set_remote_clients(&self, clients: Arc<crate::remote_client::RemoteClientManager>) {
        if let Ok(mut guard) = self.remote_clients.lock() {
            *guard = Some(clients);
        }
    }

    pub(crate) fn remote_clients(&self) -> Option<Arc<crate::remote_client::RemoteClientManager>> {
        self.remote_clients
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(Arc::clone))
    }

    /// Start background control services (local IPC listener + TTL lease reaper).
    pub fn start(self: &Arc<Self>) {
        self.start_local_server();
        self.start_lease_reaper();
    }

    fn start_lease_reaper(self: &Arc<Self>) {
        let hub = Arc::clone(self);
        let mut shutdown_rx = self.shutdown_tx.subscribe();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut ticks: u64 = 0;
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        let reaped = hub.lease_registry.reap_expired(Some(&hub.event_hub)).await;
                        if reaped > 0 {
                            log::info!("Reaped {reaped} expired port lease(s)");
                        }
                        ticks = ticks.wrapping_add(1);
                        if ticks.is_multiple_of(30) {
                            let store = Arc::clone(&hub.artifact_store);
                            if let Ok(removed) = tokio::task::spawn_blocking(move || store.reap_expired()).await {
                                if removed > 0 {
                                    log::info!("Reaped {removed} expired staged artifact(s)");
                                }
                            }
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }

    pub async fn shutdown(&self) {
        self.shutdown_tx.send_replace(true);
        self.local_running.store(false, Ordering::Release);
        let _ = self.stop_remote().await;
        if let Ok(mut guard) = self.remote_clients.lock() {
            *guard = None;
        }
        if let Ok(mut leases) = self.remote_leases.lock() {
            leases.clear();
        }
        self.artifact_store.cleanup_all();
    }

    pub(crate) fn emit_note(
        &self,
        port_id: &str,
        text: &str,
        source: Option<&str>,
        timestamp: i64,
        generation: u64,
    ) {
        let app = self
            .app_handle
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        if let Some(app) = app {
            let _ = app.emit(
                "serial:note",
                serial::SerialNoteEvent {
                    port_id: port_id.to_string(),
                    text: text.to_string(),
                    source: source.map(str::to_string),
                    timestamp,
                    generation,
                },
            );
        }
    }

    pub(crate) fn emit_external_tx(
        &self,
        port_id: &str,
        timestamp: i64,
        generation: u64,
        data: &[u8],
        source: Option<&str>,
    ) {
        let app = self
            .app_handle
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        if let Some(app) = app {
            let _ = app.emit(
                "serial:external-tx",
                serial::SerialExternalTxEvent {
                    port_id: port_id.to_string(),
                    timestamp,
                    generation,
                    data: data.to_vec(),
                    source: source.map(str::to_string),
                },
            );
        }
    }

    async fn get_or_open_authority(
        &self,
        desired_endpoint: Option<String>,
    ) -> Result<Arc<Authority>, HostError> {
        let _io_guard = self.authority_io.lock().await;
        {
            let guard = self
                .authority_cache
                .lock()
                .map_err(|_| HostError::new("host_unavailable", "authority cache poisoned"))?;
            if let Some(auth) = guard.as_ref() {
                match &desired_endpoint {
                    None => return Ok(Arc::clone(auth)),
                    Some(ep) if auth.endpoint() == ep => return Ok(Arc::clone(auth)),
                    Some(_) => {}
                }
            }
        }
        if desired_endpoint.is_some() {
            let mut guard = self
                .authority_cache
                .lock()
                .map_err(|_| HostError::new("host_unavailable", "authority cache poisoned"))?;
            *guard = None;
        }
        let state_dir = self.state_dir.clone();
        let endpoint = desired_endpoint.unwrap_or_default();
        let opened = tokio::task::spawn_blocking(move || Authority::open(&state_dir, endpoint))
            .await
            .map_err(|err| {
                HostError::new("host_unavailable", format!("authority open panicked: {err}"))
            })?
            .map_err(|err| {
                HostError::new(
                    "host_unavailable",
                    format!("failed to open host authority: {err}"),
                )
            })?;
        let arc = Arc::new(opened);
        let mut guard = self
            .authority_cache
            .lock()
            .map_err(|_| HostError::new("host_unavailable", "authority cache poisoned"))?;
        *guard = Some(Arc::clone(&arc));
        Ok(arc)
    }

    pub async fn remote_status(&self) -> Result<RemoteStatusDto, HostError> {
        {
            let guard = self.remote_state.lock().await;
            if let Some(handle) = guard.as_ref() {
                return Ok(RemoteStatusDto {
                    enabled: true,
                    endpoint: handle.advertise_addr.clone(),
                    server_id: handle.authority.server_id().to_string(),
                    certificate_sha256: handle.authority.certificate_sha256().to_string(),
                });
            }
        }
        let auth = self.get_or_open_authority(None).await?;
        Ok(RemoteStatusDto {
            enabled: false,
            endpoint: auth.endpoint().to_string(),
            server_id: auth.server_id().to_string(),
            certificate_sha256: auth.certificate_sha256().to_string(),
        })
    }

    pub(crate) async fn collaboration_status(&self, actor: Option<&Actor>) -> CollaborationStatusDto {
        let (remote, remote_clients) = {
            let guard = self.remote_state.lock().await;
            if let Some(handle) = guard.as_ref() {
                (
                    RemoteStatusDto {
                        enabled: true,
                        endpoint: handle.advertise_addr.clone(),
                        server_id: handle.authority.server_id().to_string(),
                        certificate_sha256: handle.authority.certificate_sha256().to_string(),
                    },
                    handle.remote_clients.load(Ordering::Acquire),
                )
            } else {
                let cached = self
                    .authority_cache
                    .lock()
                    .ok()
                    .and_then(|c| c.as_ref().cloned());
                let dto = match cached {
                    Some(auth) => RemoteStatusDto {
                        enabled: false,
                        endpoint: auth.endpoint().to_string(),
                        server_id: auth.server_id().to_string(),
                        certificate_sha256: auth.certificate_sha256().to_string(),
                    },
                    None => RemoteStatusDto {
                        enabled: false,
                        endpoint: String::new(),
                        server_id: String::new(),
                        certificate_sha256: String::new(),
                    },
                };
                (dto, 0)
            }
        };

        CollaborationStatusDto {
            host_id: self.host_id.clone(),
            protocol: PROTOCOL_VERSION,
            local_endpoint: self.endpoint_name.clone(),
            local_running: self.local_running.load(Ordering::Acquire),
            local_clients: self.local_clients.load(Ordering::Acquire),
            remote,
            remote_clients,
            active_loans: self.list_loans_for_actor(actor),
        }
    }

    pub(crate) fn list_loans_for_actor(&self, actor: Option<&Actor>) -> Vec<LoanInfoDto> {
        self.lease_registry
            .list_entries()
            .into_iter()
            .filter(|(port_id, _, _)| {
                actor.is_none_or(|a| a.check_access(Access::Observe, Some(port_id)).is_ok())
            })
            .map(|(port_id, generation, meta)| loan_meta_to_dto(&port_id, generation, meta))
            .collect()
    }

    pub async fn create_invite(
        &self,
        label: String,
        ports: Vec<String>,
        role: RemoteRole,
        allow_loan: bool,
        device_plugins: bool,
        ttl_ms: Option<u64>,
    ) -> Result<RemoteInvite, HostError> {
        let authority = {
            let guard = self.remote_state.lock().await;
            let handle = guard.as_ref().ok_or_else(|| {
                HostError::new(
                    "host_unavailable",
                    "start the remote TLS host before creating an invitation",
                )
            })?;
            Arc::clone(&handle.authority)
        };
        authority.invite(
            label,
            RemotePermissions {
                role,
                ports,
                allow_loan,
                automation: false,
                device_plugins,
                device_tools: false,
            },
            ttl_ms,
        )
    }

    pub async fn list_clients(&self) -> Result<Vec<RemoteClientDto>, HostError> {
        let authority = self.get_or_open_authority(None).await?;
        Ok(authority.list())
    }

    pub async fn revoke_client(&self, client_id: &str) -> Result<RemoteClientDto, HostError> {
        let authority = self.get_or_open_authority(None).await?;
        let dto = authority.revoke(client_id)?;
        // Also eagerly release any connection-bound leases belonging to this peer
        // in case the socket teardown is still draining.
        self.lease_registry
            .release_by_owner_prefix(Some(&self.event_hub), &format!("remote:{client_id}:"))
            .await;
        Ok(dto)
    }

    pub async fn reclaim_loan_local(&self, port_id: &str) -> Result<serial::LeaseRecovery, HostError> {
        let recovery = self
            .lease_registry
            .reclaim_port(Some(&self.event_hub), port_id)
            .await
            .map_err(|err| HostError::new("serial_error", err))?;
        match recovery {
            Some(rec) => {
                let note = format!("[协作] 已强制回收 {port_id} ({})", rec.state);
                let generation = self
                    .serial_manager
                    .lock()
                    .ok()
                    .and_then(|m| m.status_generation(port_id))
                    .unwrap_or(0);
                self.emit_note(
                    port_id,
                    &note,
                    Some("local"),
                    chrono::Utc::now().timestamp_millis(),
                    generation,
                );
                Ok(rec)
            }
            None => Ok(serial::LeaseRecovery {
                state: "not-loaned".to_string(),
                error: None,
            }),
        }
    }
}

fn resolve_endpoint_name() -> String {
    match std::env::var("HYPERCOM_HOST_ENDPOINT") {
        Ok(val) if !val.trim().is_empty() => {
            let trimmed = val.trim().to_string();
            if let Err(err) = validate_endpoint_name(&trimmed) {
                log::warn!(
                    "Invalid HYPERCOM_HOST_ENDPOINT '{}': {}; falling back to '{}'",
                    trimmed,
                    err.message,
                    DEFAULT_ENDPOINT
                );
                DEFAULT_ENDPOINT.to_string()
            } else {
                trimmed
            }
        }
        _ => DEFAULT_ENDPOINT.to_string(),
    }
}
