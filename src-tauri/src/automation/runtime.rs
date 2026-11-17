//! Explicitly opt-in loopback host adapter.
//!
//! This is deliberately a small, read-mostly first slice. It exposes the
//! authoritative host identity and native port snapshot through the bounded
//! transport. It does not expose arbitrary Tauri invoke and does not grant
//! write authority; serial control is added only after the native arbiter is
//! wired into every local write path.

use super::transport::{
    ConnectionContext, ErrorCode, HandlerFuture, ListenerConfig, LoopbackListener, Request,
    RequestHandler, WireError,
};
use crate::{serial, AppState};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub const DEFAULT_LOOPBACK_PORT: u16 = 39_071;
pub const ENABLE_ENV: &str = "HYPERCOM_AUTOMATION_LOOPBACK";
pub const PORT_ENV: &str = "HYPERCOM_AUTOMATION_PORT";

pub struct LocalAutomationHandler {
    app: AppHandle,
    host_id: String,
    server_epoch: String,
}

impl LocalAutomationHandler {
    pub fn new(
        app: AppHandle,
        host_id: impl Into<String>,
        server_epoch: impl Into<String>,
    ) -> Self {
        Self {
            app,
            host_id: host_id.into(),
            server_epoch: server_epoch.into(),
        }
    }

    fn error(code: ErrorCode, message: impl Into<String>) -> WireError {
        WireError::new(code, message)
    }

    fn check_target(&self, request: &Request) -> Result<(), WireError> {
        if let Some(target) = &request.target {
            if target.host_id != self.host_id {
                return Err(Self::error(
                    ErrorCode::HostUnavailable,
                    "target host does not match this host",
                ));
            }
        }
        Ok(())
    }

    async fn list_ports(&self) -> Result<Value, WireError> {
        let manager = self.app.state::<AppState>().serial_manager.clone();
        let listing_manager = manager.clone();
        let ports =
            tokio::task::spawn_blocking(move || serial::list_ports_blocking(&listing_manager))
                .await
                .map_err(|error| {
                    Self::error(
                        ErrorCode::Internal,
                        format!("port enumeration task failed: {error}"),
                    )
                })?
                .map_err(|error| Self::error(ErrorCode::IoError, error.to_string()))?;
        let connected = manager.lock().map_err(|error| {
            Self::error(
                ErrorCode::Internal,
                format!("serial state unavailable: {error}"),
            )
        })?;
        let items = ports
            .into_iter()
            .map(|port| {
                let generation = connected.status_generation(&port.id).unwrap_or(0);
                let is_connected = connected.connection_generation(&port.id).is_some();
                json!({
                    "target": { "hostId": self.host_id, "nativePortId": port.id },
                    "name": port.name,
                    "portType": port.port_type,
                    "state": if is_connected { "open" } else { "closed" },
                    "connectionGeneration": generation.to_string(),
                    "manufacturer": port.manufacturer,
                    "product": port.product,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "hostId": self.host_id,
            "serverEpoch": self.server_epoch,
            "ports": items,
            "readOnly": true,
        }))
    }
}

impl RequestHandler for LocalAutomationHandler {
    fn handle(&self, _connection: ConnectionContext, request: Request) -> HandlerFuture<'_> {
        Box::pin(async move {
            self.check_target(&request)?;
            match request.method.as_str() {
                "host.status" => Ok(json!({
                    "hostId": self.host_id,
                    "serverEpoch": self.server_epoch,
                    "mode": "desktop-attached",
                    "capabilities": ["host.status", "ports.list"],
                    "serialControl": "not-enabled",
                })),
                "ports.list" => self.list_ports().await,
                _ => Err(Self::error(
                    ErrorCode::UnsupportedCapability,
                    "method is not enabled by this adapter",
                )),
            }
        })
    }
}

/// Start the explicitly opt-in loopback adapter and retain its lifecycle in the
/// application state. By default HyperCom does not open a listener.
pub async fn start_loopback(
    app: AppHandle,
    slot: Arc<Mutex<Option<LoopbackListener>>>,
    host_id: String,
    server_epoch: String,
    port: u16,
) -> Result<u16, String> {
    let handler = Arc::new(LocalAutomationHandler::new(
        app,
        host_id,
        server_epoch.clone(),
    ));
    let listener = LoopbackListener::bind(
        port,
        ListenerConfig::new(
            server_epoch,
            vec!["host.status".into(), "ports.list".into()],
        ),
        handler,
    )
    .await
    .map_err(|error| error.to_string())?;
    let bound_port = listener.local_addr().port();
    *slot
        .lock()
        .map_err(|error| format!("automation listener state unavailable: {error}"))? =
        Some(listener);
    Ok(bound_port)
}

pub fn parse_opt_in_port() -> Option<u16> {
    if std::env::var(ENABLE_ENV).ok().as_deref() != Some("1") {
        return None;
    }
    match std::env::var(PORT_ENV) {
        Ok(value) => value.parse::<u16>().ok().filter(|port| *port != 0),
        Err(_) => Some(DEFAULT_LOOPBACK_PORT),
    }
}
