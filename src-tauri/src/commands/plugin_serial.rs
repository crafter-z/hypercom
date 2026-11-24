//! Plugin serial lifecycle control. The driver, routing and close barriers remain
//! owned by SerialManager; this module only supplies plugin authority and wire DTOs.

use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WebviewWindow};

use super::{CommandError, OpenPortArgs};
use crate::config::PluginConfigEntry;
use crate::plugin::{self, PluginManifest};
use crate::{serial, AppState};

#[path = "plugin_serial_tasks.rs"]
pub mod plugin_serial_tasks;
pub use plugin_serial_tasks::*;

/// Partial camelCase plugin options. The host normally resolves its UI defaults
/// before invoking; omitted native fields reuse the last connection or 9600/8N1.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSerialParams {
    pub baud_rate: Option<u32>,
    pub data_bits: Option<u8>,
    pub parity: Option<String>,
    pub stop_bits: Option<String>,
    pub handshake: Option<String>,
    pub dtr: Option<bool>,
    pub rts: Option<bool>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

impl PluginSerialParams {
    fn resolve(self, port_id: &str, previous: Option<OpenPortArgs>) -> OpenPortArgs {
        let mut args = previous.unwrap_or_else(|| OpenPortArgs {
            port_id: port_id.into(),
            baud_rate: 9600,
            data_bits: 8,
            parity: "None".into(),
            stop_bits: "One".into(),
            handshake: "None".into(),
            dtr: false,
            rts: false,
            cols: 80,
            rows: 24,
        });
        args.port_id = port_id.into();
        if let Some(value) = self.baud_rate {
            args.baud_rate = value;
        }
        if let Some(value) = self.data_bits {
            args.data_bits = value;
        }
        if let Some(value) = self.parity {
            args.parity = value;
        }
        if let Some(value) = self.stop_bits {
            args.stop_bits = value;
        }
        if let Some(value) = self.handshake {
            args.handshake = value;
        }
        if let Some(value) = self.dtr {
            args.dtr = value;
        }
        if let Some(value) = self.rts {
            args.rts = value;
        }
        if let Some(value) = self.cols {
            args.cols = value;
        }
        if let Some(value) = self.rows {
            args.rows = value;
        }
        args
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSerialPort {
    pub id: String,
    pub name: String,
    pub status: &'static str,
    #[serde(rename = "type")]
    pub port_type: &'static str,
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baud_rate: Option<u32>,
    /// Last successful backend generation, retained after close (initially zero).
    pub connection_generation: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSerialOpenResult {
    pub port: PluginSerialPort,
    pub result: &'static str,
    pub connection_generation: u64,
}

#[derive(Debug, Serialize)]
pub struct PluginSerialCloseResult {
    pub port: PluginSerialPort,
    pub result: &'static str,
}

pub(super) fn validate_target(plugin_id: &str, port_id: &str) -> Result<(), CommandError> {
    plugin::validate_plugin_id(plugin_id).map_err(CommandError::Other)?;
    if port_id.is_empty() || port_id.contains('\0') {
        return Err(CommandError::Serial(
            "Port ID must be nonempty and must not contain NUL".into(),
        ));
    }
    Ok(())
}

fn validate_entry(
    entry: &PluginConfigEntry,
    plugin_id: &str,
    expected_generation: &str,
) -> Result<(), CommandError> {
    if entry.id != plugin_id
        || expected_generation.is_empty()
        || entry.install_generation != expected_generation
    {
        return Err(CommandError::Other(
            "插件安装版本已变化，请重新检查插件后操作".into(),
        ));
    }
    if !entry.enabled {
        return Err(CommandError::Other(format!("插件未启用: {plugin_id}")));
    }
    Ok(())
}

fn require_current_entry(
    state: &AppState,
    plugin_id: &str,
    expected_generation: &str,
) -> Result<(), CommandError> {
    let config = state
        .config_manager
        .lock()
        .map_err(|error| CommandError::Lock(error.to_string()))?;
    let entry = config
        .get_config()
        .entities
        .plugin_configs
        .iter()
        .find(|entry| entry.id == plugin_id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
    validate_entry(entry, plugin_id, expected_generation)
}

fn validate_access(
    entry: &PluginConfigEntry,
    manifest: &PluginManifest,
    plugin_id: &str,
    expected_generation: &str,
    control_port: Option<&str>,
) -> Result<(), CommandError> {
    validate_entry(entry, plugin_id, expected_generation)?;
    if manifest.id != plugin_id {
        return Err(CommandError::Other("插件 manifest 身份不匹配".into()));
    }
    if let Some(port_id) = control_port {
        validate_port_permission(entry, manifest, port_id, "serial:control")?;
    }
    Ok(())
}

fn validate_port_permission(
    entry: &PluginConfigEntry,
    manifest: &PluginManifest,
    port_id: &str,
    permission: &str,
) -> Result<(), CommandError> {
    if !entry.granted_permissions.iter().any(|item| item == permission)
        || !manifest.permissions.iter().any(|item| item == permission)
    {
        return Err(CommandError::Other(format!(
            "插件未授予 {permission} 权限: {}", entry.id
        )));
    }
    if manifest.serial.as_ref().is_some_and(|scope| {
        !scope.port_whitelist.iter().any(|allowed| allowed == port_id)
    }) {
        return Err(CommandError::Other(format!(
            "串口不在插件白名单内: {port_id}"
        )));
    }
    Ok(())
}

fn blocking_authority<'a>(
    admission: impl std::future::Future<Output = Result<tokio::sync::MutexGuard<'a, ()>, CommandError>>,
    validate: impl FnOnce() -> Result<(), CommandError>,
) -> Result<tokio::sync::MutexGuard<'a, ()>, CommandError> {
    let gate = tokio::runtime::Handle::current().block_on(admission)?;
    validate()?;
    Ok(gate)
}

/// Blocking-pool only: acquire the existing timed plugin lifecycle gate and
/// return it to the synchronous manager mutation. Do not hold config_manager:
/// connected status emission reads logging settings through that same mutex.
/// The gate is never held across enumeration, reader joins or close barriers,
/// and is owned by actual blocking work even if its invoke awaiter is dropped.
fn serial_authority<'a>(
    state: &'a AppState,
    plugin_id: &str,
    expected_generation: &str,
    control_port: Option<&str>,
) -> Result<tokio::sync::MutexGuard<'a, ()>, CommandError> {
    scoped_serial_authority(state, plugin_id, expected_generation, control_port, None)
}

fn scoped_serial_authority<'a>(
    state: &'a AppState,
    plugin_id: &str,
    expected_generation: &str,
    control_port: Option<&str>,
    send_port: Option<&str>,
) -> Result<tokio::sync::MutexGuard<'a, ()>, CommandError> {
    blocking_authority(super::plugin::acquire_plugin_io(state), || {
        require_scoped_serial_access(state, plugin_id, expected_generation, control_port, send_port).map(|_| ())
    })
}

/// Caller owns the plugin lifecycle gate; no config mutex is held across serial operations.
pub(super) fn require_scoped_serial_access(
    state: &AppState,
    plugin_id: &str,
    expected_generation: &str,
    control_port: Option<&str>,
    send_port: Option<&str>,
) -> Result<PluginManifest, CommandError> {
    let directory = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))?;
        let entry = manager
            .get_config()
            .entities
            .plugin_configs
            .iter()
            .find(|entry| entry.id == plugin_id)
            .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
        validate_entry(entry, plugin_id, expected_generation)?;
        manager.plugins_dir().join(plugin_id)
    };
    // Resource-heavy full manifest validation stays on install/enable/reload paths.
    let manifest = plugin::load_manifest_lite(&directory).map_err(CommandError::Io)?;
    let manager = state
        .config_manager
        .lock()
        .map_err(|error| CommandError::Lock(error.to_string()))?;
    let entry = manager
        .get_config()
        .entities
        .plugin_configs
        .iter()
        .find(|entry| entry.id == plugin_id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
    validate_access(
        entry,
        &manifest,
        plugin_id,
        expected_generation,
        control_port,
    )?;
    if let Some(port_id) = send_port {
        validate_port_permission(entry, &manifest, port_id, "serial:send")?;
    }
    Ok(manifest)
}

fn serial_error(error: anyhow::Error) -> CommandError {
    // Preserve authorization/lock/I/O domains from the shared opener's callback.
    match error.downcast::<CommandError>() {
        Ok(error) => error,
        Err(error) => CommandError::Serial(error.to_string()),
    }
}

fn port_snapshot(
    manager: &serial::SerialManager,
    port_id: &str,
    name: Option<&str>,
) -> PluginSerialPort {
    let kind = serial::PortKind::of(port_id);
    PluginSerialPort {
        id: port_id.into(),
        name: name.unwrap_or(port_id).into(),
        status: if manager.connection_is_live(port_id) {
            "connected"
        } else {
            "disconnected"
        },
        port_type: if kind == serial::PortKind::Real {
            "real"
        } else {
            "sim"
        },
        mode: if kind == serial::PortKind::Tty {
            "tty"
        } else {
            "trx"
        },
        baud_rate: manager
            .get_last_params(port_id)
            .map(|params| params.baud_rate),
        connection_generation: manager.status_generation(port_id).unwrap_or(0),
    }
}

#[tauri::command]
pub async fn plugin_serial_open(
    plugin_id: String,
    expected_generation: String,
    port_id: String,
    params: Option<PluginSerialParams>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginSerialOpenResult, CommandError> {
    super::plugin::require_main_window(&window)?;
    validate_target(&plugin_id, &port_id)?;
    // Entry validation must also happen before registering a port intent. Keep
    // disk I/O on the blocking pool below; this config-only check is inexpensive.
    require_current_entry(&state, &plugin_id, &expected_generation)?;
    let app = window.app_handle().clone();
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let authority = serial_authority(&state, &plugin_id, &expected_generation, Some(&port_id))?;
        let (args, expected, cancel) = {
            let mut manager = state
                .serial_manager
                .lock()
                .map_err(|error| CommandError::Lock(error.to_string()))?;
            let expected = manager.status_generation(&port_id).unwrap_or(0);
            let args = params
                .unwrap_or_default()
                .resolve(&port_id, manager.get_last_params(&port_id));
            let cancel = manager.begin_reconnect(&port_id);
            (args, expected, cancel)
        };
        drop(authority);
        let outcome = serial::open_blocking_authorized(
            &state.serial_manager,
            args,
            expected,
            &cancel,
            || {
                serial_authority(&state, &plugin_id, &expected_generation, Some(&port_id))
                    .map_err(anyhow::Error::new)
            },
        );
        // Remove only our intent; a newer user's operation may already own it.
        state
            .serial_manager
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))?
            .finish_reconnect(&port_id, &cancel);
        let (opened, generation) = outcome.map_err(serial_error)?;
        let _authority =
            serial_authority(&state, &plugin_id, &expected_generation, Some(&port_id))?;
        let manager = state
            .serial_manager
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))?;
        manager
            .check_control_generation(&port_id, generation)
            .map_err(serial_error)?;
        let port = port_snapshot(&manager, &port_id, None);
        Ok(PluginSerialOpenResult {
            port,
            result: if opened { "opened" } else { "already-open" },
            connection_generation: generation,
        })
    })
    .await
    .map_err(|error| CommandError::Other(format!("Plugin open port task failed: {error}")))?
}

#[tauri::command]
pub async fn plugin_serial_close(
    plugin_id: String,
    expected_generation: String,
    port_id: String,
    expected_connection_generation: u64,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginSerialCloseResult, CommandError> {
    super::plugin::require_main_window(&window)?;
    validate_target(&plugin_id, &port_id)?;
    let app = window.app_handle().clone();
    // A CAS mismatch is not an idempotent close: even when disconnected, it
    // identifies a stale control request and must not cancel a newer intent.
    require_current_entry(&state, &plugin_id, &expected_generation)?;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let authority = serial_authority(&state, &plugin_id, &expected_generation, Some(&port_id))?;
        let (close, port) = {
            let mut manager = state
                .serial_manager
                .lock()
                .map_err(|error| CommandError::Lock(error.to_string()))?;
            let close = manager
                .close_port_cas(&port_id, expected_connection_generation)
                .map_err(serial_error)?;
            (close, port_snapshot(&manager, &port_id, None))
        };
        drop(authority);
        let closed = close.is_some();
        if let Some(close) = close {
            let _ = close.join();
        }
        state
            .serial_manager
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))?
            .cleanup_real_close(&port_id);
        // Never compensate for a late authority failure by closing whatever is
        // connected now: it could be an unrelated replacement session.
        drop(serial_authority(
            &state,
            &plugin_id,
            &expected_generation,
            Some(&port_id),
        )?);
        Ok(PluginSerialCloseResult {
            port,
            result: if closed { "closed" } else { "already-closed" },
        })
    })
    .await
    .map_err(|error| CommandError::Other(format!("Plugin close port task failed: {error}")))?
}

#[tauri::command]
pub async fn plugin_serial_list(
    plugin_id: String,
    expected_generation: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<PluginSerialPort>, CommandError> {
    super::plugin::require_main_window(&window)?;
    plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    let app = window.app_handle().clone();
    require_current_entry(&state, &plugin_id, &expected_generation)?;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        drop(serial_authority(
            &state,
            &plugin_id,
            &expected_generation,
            None,
        )?);
        let mut ports = serial::list_ports_blocking(&state.serial_manager).map_err(serial_error)?;
        let _authority = serial_authority(&state, &plugin_id, &expected_generation, None)?;
        let manager = state
            .serial_manager
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))?;
        for id in manager.active_port_ids() {
            if !ports.iter().any(|port| port.id == id) {
                ports.push(serial::PortInfo {
                    name: id.clone(),
                    id,
                    port_type: String::new(),
                    manufacturer: None,
                    product: None,
                });
            }
        }
        Ok(ports
            .iter()
            .map(|port| port_snapshot(&manager, &port.id, Some(&port.name)))
            .collect())
    })
    .await
    .map_err(|error| CommandError::Other(format!("Plugin list ports task failed: {error}")))?
}

#[tauri::command]
pub async fn plugin_serial_status(
    plugin_id: String,
    expected_generation: String,
    port_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<PluginSerialPort>, CommandError> {
    super::plugin::require_main_window(&window)?;
    validate_target(&plugin_id, &port_id)?;
    let app = window.app_handle().clone();
    require_current_entry(&state, &plugin_id, &expected_generation)?;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        drop(serial_authority(
            &state,
            &plugin_id,
            &expected_generation,
            None,
        )?);
        let ports = serial::list_ports_blocking(&state.serial_manager).map_err(serial_error)?;
        let _authority = serial_authority(&state, &plugin_id, &expected_generation, None)?;
        let manager = state
            .serial_manager
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))?;
        let found = ports.iter().find(|port| port.id == port_id);
        Ok(
            if found.is_some() || manager.status_generation(&port_id).is_some() {
                Some(port_snapshot(
                    &manager,
                    &port_id,
                    found.map(|port| port.name.as_str()),
                ))
            } else {
                None
            },
        )
    })
    .await
    .map_err(|error| CommandError::Other(format!("Plugin port status task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    // Explicit imports keep serialport FFI out of the Windows test binary.
    use super::{
        blocking_authority, serial_error, validate_access, validate_target,
        PluginSerialCloseResult, PluginSerialOpenResult, PluginSerialParams, PluginSerialPort,
    };
    use crate::commands::CommandError;
    use crate::config::PluginConfigEntry;
    use crate::plugin::{parse_manifest, PluginManifest, SerialScope};

    const ID: &str = "com.example.serial";
    const GENERATION: &str = "c55d5af5-20e4-4844-aa5c-692006363883";

    fn entry() -> PluginConfigEntry {
        serde_json::from_value(serde_json::json!({
            "id": ID, "installGeneration": GENERATION, "enabled": true,
            "grantedPermissions": ["serial:control"]
        }))
        .unwrap()
    }

    fn manifest() -> PluginManifest {
        parse_manifest(
            &serde_json::json!({
                "id": ID, "name": "Serial", "version": "1.0.0", "apiVersion": "1.0",
                "entry": "main.js", "permissions": ["serial:control"]
            })
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn control_requires_current_enabled_install_and_declared_granted_permission() {
        let mut state = entry();
        let mut declared = manifest();
        assert!(validate_access(&state, &declared, ID, GENERATION, Some("COM9")).is_ok());
        for generation in ["", "old-install"] {
            assert!(validate_access(&state, &declared, ID, generation, Some("COM9")).is_err());
        }
        state.enabled = false;
        assert!(validate_access(&state, &declared, ID, GENERATION, Some("COM9")).is_err());
        state.enabled = true;
        state.granted_permissions.clear();
        assert!(validate_access(&state, &declared, ID, GENERATION, Some("COM9")).is_err());
        // Queries remain enabled/installation-gated but do not require control.
        assert!(validate_access(&state, &declared, ID, GENERATION, None).is_ok());
        state = entry();
        declared.permissions.clear();
        assert!(validate_access(&state, &declared, ID, GENERATION, Some("COM9")).is_err());
        declared = manifest();
        declared.id = "com.example.other".into();
        assert!(validate_access(&state, &declared, ID, GENERATION, None).is_err());
    }

    #[test]
    fn whitelist_is_exact_absent_unrestricted_and_empty_denies_all_control() {
        let state = entry();
        let mut declared = manifest();
        assert!(validate_access(&state, &declared, ID, GENERATION, Some("COM9")).is_ok());
        declared.serial = Some(SerialScope {
            port_whitelist: vec![],
        });
        assert!(validate_access(&state, &declared, ID, GENERATION, Some("COM9")).is_err());
        declared
            .serial
            .as_mut()
            .unwrap()
            .port_whitelist
            .push("COM9".into());
        assert!(validate_access(&state, &declared, ID, GENERATION, Some("COM9")).is_ok());
        for port in ["com9", "COM90", "COM9 ", "SIM:Loopback", "GIT:BASH"] {
            assert!(
                validate_access(&state, &declared, ID, GENERATION, Some(port)).is_err(),
                "{port}"
            );
        }
        // The scope governs control, not harmless discovery.
        assert!(validate_access(&state, &declared, ID, GENERATION, None).is_ok());
    }

    #[test]
    fn native_params_wire_defaults_and_identity_are_strict() {
        let params: PluginSerialParams = serde_json::from_value(serde_json::json!({
            "baudRate": 115200, "dataBits": 7, "parity": "Even", "stopBits": "Two",
            "handshake": "None", "dtr": true, "rts": false, "cols": 120, "rows": 40
        }))
        .unwrap();
        let args = params.resolve("COM9", None);
        assert_eq!(
            (args.baud_rate, args.data_bits, args.cols, args.rows),
            (115200, 7, 120, 40)
        );
        assert_eq!(args.port_id, "COM9");
        let args = PluginSerialParams::default().resolve("COM10", Some(args));
        assert_eq!(args.port_id, "COM10");
        assert_eq!(args.baud_rate, 115200);
        let defaults = PluginSerialParams::default().resolve("SIM:Loopback", None);
        assert_eq!(
            (
                defaults.baud_rate,
                defaults.data_bits,
                defaults.cols,
                defaults.rows
            ),
            (9600, 8, 80, 24)
        );
        for invalid in [
            serde_json::json!({"portId": "COM10"}),
            serde_json::json!({"baud_rate": 1}),
        ] {
            assert!(serde_json::from_value::<PluginSerialParams>(invalid).is_err());
        }
        assert!(validate_target(ID, "").is_err());
        assert!(validate_target(ID, "COM9\0").is_err());
        assert!(validate_target("../invalid", "COM9").is_err());
    }

    #[test]
    fn control_responses_use_camel_case_and_preserve_error_domains() {
        let port = PluginSerialPort {
            id: "COM9".into(),
            name: "COM9".into(),
            status: "connected",
            port_type: "real",
            mode: "trx",
            baud_rate: Some(115200),
            connection_generation: 7,
        };
        let open = PluginSerialOpenResult {
            port: port.clone(),
            result: "opened",
            connection_generation: 7,
        };
        let wire = serde_json::to_value(open).unwrap();
        assert_eq!(wire["connectionGeneration"], 7);
        assert_eq!(wire["port"]["connectionGeneration"], 7);
        assert_eq!(wire["port"]["baudRate"], 115200);
        assert_eq!(wire["port"]["type"], "real");
        assert!(wire["port"].get("connection_generation").is_none());
        let close = PluginSerialCloseResult {
            port,
            result: "already-closed",
        };
        assert_eq!(
            serde_json::to_value(close).unwrap()["result"],
            "already-closed"
        );
        assert!(matches!(
            serial_error(anyhow::Error::new(CommandError::Other("denied".into()))),
            CommandError::Other(_)
        ));
        assert!(matches!(
            serial_error(anyhow::Error::new(CommandError::Io("manifest".into()))),
            CommandError::Io(_)
        ));
        assert!(matches!(
            serial_error(anyhow::anyhow!("driver")),
            CommandError::Serial(_)
        ));
    }

    #[tokio::test]
    async fn lifecycle_guard_releases_config_before_connected_emission_and_serializes_revoke() {
        use std::sync::{Arc, Mutex};
        use std::time::Duration;
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let config = Arc::new(Mutex::new(entry()));
        let (admitted_tx, admitted_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let worker_gate = Arc::clone(&gate);
        let worker_config = Arc::clone(&config);
        let worker = tokio::task::spawn_blocking(move || {
            let _authority = blocking_authority(
                crate::commands::plugin::acquire_plugin_gate(&worker_gate, Duration::from_secs(1)),
                || {
                    validate_access(
                        &worker_config.lock().unwrap(),
                        &manifest(),
                        ID,
                        GENERATION,
                        Some("COM9"),
                    )
                },
            )
            .unwrap();
            // emit_status(Connected) locks config again while opening. This must
            // succeed while the lifecycle guard is still held, not deadlock.
            assert!(worker_config.try_lock().is_ok());
            assert!(worker_gate.try_lock().is_err());
            admitted_tx.send(()).unwrap();
            release_rx.blocking_recv().unwrap();
            assert!(worker_config.lock().unwrap().enabled);
        });
        admitted_rx.await.unwrap();
        let revoke_gate = Arc::clone(&gate);
        let revoke_config = Arc::clone(&config);
        let revoke = tokio::spawn(async move {
            let _gate = revoke_gate.lock().await;
            revoke_config.lock().unwrap().enabled = false;
        });
        assert!(gate.try_lock().is_err());
        assert!(config.lock().unwrap().enabled);
        release_tx.send(()).unwrap();
        worker.await.unwrap();
        revoke.await.unwrap();
        let result = tokio::task::spawn_blocking(move || {
            blocking_authority(
                crate::commands::plugin::acquire_plugin_gate(&gate, Duration::from_secs(1)),
                || {
                    validate_access(
                        &config.lock().unwrap(),
                        &manifest(),
                        ID,
                        GENERATION,
                        Some("COM9"),
                    )
                },
            )
            .map(|_| ())
        })
        .await
        .unwrap();
        assert!(matches!(result, Err(CommandError::Other(_))));
    }
}
