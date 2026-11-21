//! Bounded TX steps for plugin-owned byte and selected-file tasks. Each step
//! dispatches at most once to a writer captured from the original connection.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WebviewWindow};
use uuid::Uuid;

use crate::commands::plugin_file_handles::{borrow_plugin_file_read_source, PluginFileReadSource};
use crate::commands::{require_main_window, CommandError};
use crate::{serial, AppState};

const CHUNK_BYTES: usize = 64 * 1024;
const MAX_JS_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PluginSerialTaskSource {
    Bytes {
        total_bytes: u64,
    },
    File {
        session_id: String,
        handle_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSerialTaskBegun {
    total_bytes: u64,
    connected: bool,
    window_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum StepOutcome {
    Written,
    Cancelled,
    Disconnected,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSerialTaskStep {
    outcome: StepOutcome,
    bytes_written: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl PluginSerialTaskStep {
    fn stopped(outcome: StepOutcome, message: impl ToString) -> Self {
        Self {
            outcome,
            bytes_written: 0,
            message: Some(message.to_string()),
        }
    }
}

struct Task {
    id: Uuid,
    plugin_id: String,
    install_generation: String,
    port_id: String,
    connection_generation: u64,
    source: Option<PluginFileReadSource>,
    total_bytes: u64,
    window_bytes: usize,
    cancelled: AtomicBool,
}

impl Task {
    fn owned_by(&self, plugin_id: &str, generation: &str, id: Uuid) -> bool {
        self.id == id && self.plugin_id == plugin_id && self.install_generation == generation
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn connection_matches(&self, generation: Option<u64>, live: bool) -> bool {
        live && generation == Some(self.connection_generation)
    }
}

struct Entry {
    task: Arc<Task>,
    offset: u64,
    in_flight: bool,
}

#[derive(Default)]
struct PortTx {
    legacy: usize,
    task: Option<Entry>,
}

/// Short, per-port reservations only. No registry lock spans a file or serial
/// operation. Legacy callers retain their old concurrency with one another.
#[derive(Default)]
pub(crate) struct TxReservations(Mutex<HashMap<String, PortTx>>);

impl TxReservations {
    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, PortTx>>, CommandError> {
        self.0
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))
    }

    pub(crate) fn legacy(self: &Arc<Self>, port_id: &str) -> Result<LegacyTx, CommandError> {
        let mut ports = self.lock()?;
        let port = ports.entry(port_id.into()).or_default();
        if port.task.is_some() {
            return Err(CommandError::Serial(
                "Port is occupied by a plugin send task".into(),
            ));
        }
        port.legacy += 1;
        Ok(LegacyTx {
            registry: self.clone(),
            port_id: port_id.into(),
        })
    }

    fn begin(&self, task: Task) -> Result<(), CommandError> {
        let mut ports = self.lock()?;
        let port = ports.entry(task.port_id.clone()).or_default();
        if port.legacy != 0 || port.task.is_some() {
            return Err(CommandError::Serial(
                "Port has an active send or parameter change".into(),
            ));
        }
        port.task = Some(Entry {
            task: Arc::new(task),
            offset: 0,
            in_flight: false,
        });
        Ok(())
    }

    fn step(
        self: &Arc<Self>,
        plugin_id: &str,
        generation: &str,
        port_id: &str,
        id: Uuid,
        offset: u64,
    ) -> Result<Option<StepLease>, CommandError> {
        let mut ports = self.lock()?;
        let Some(entry) = ports.get_mut(port_id).and_then(|port| port.task.as_mut()) else {
            return Ok(None);
        };
        if !entry.task.owned_by(plugin_id, generation, id) || entry.task.cancelled() {
            return Ok(None);
        }
        if entry.in_flight || entry.offset != offset || offset >= entry.task.total_bytes {
            return Err(CommandError::Serial(
                "Serial send task step is stale or out of order".into(),
            ));
        }
        entry.in_flight = true;
        Ok(Some(StepLease {
            registry: self.clone(),
            task: entry.task.clone(),
            offset,
            next: None,
        }))
    }

    fn retire(&self, matches: impl Fn(&Task) -> bool) -> Result<(), CommandError> {
        self.lock()?.retain(|_, port| {
            if let Some(entry) = &port.task {
                if matches(&entry.task) {
                    entry.task.cancelled.store(true, Ordering::Release);
                    if !entry.in_flight {
                        port.task = None;
                    }
                }
            }
            port.task.is_some() || port.legacy != 0
        });
        Ok(())
    }
}

pub(crate) struct LegacyTx {
    registry: Arc<TxReservations>,
    port_id: String,
}
impl Drop for LegacyTx {
    fn drop(&mut self) {
        if let Ok(mut ports) = self.registry.lock() {
            if let Some(port) = ports.get_mut(&self.port_id) {
                port.legacy -= 1;
                if port.legacy == 0 && port.task.is_none() {
                    ports.remove(&self.port_id);
                }
            }
        }
    }
}

struct StepLease {
    registry: Arc<TxReservations>,
    task: Arc<Task>,
    offset: u64,
    next: Option<u64>,
}
impl StepLease {
    fn commit(&mut self, result: &PluginSerialTaskStep) {
        if result.outcome == StepOutcome::Written {
            self.next = Some(self.offset + result.bytes_written as u64);
        }
    }
}
impl Drop for StepLease {
    fn drop(&mut self) {
        if let Ok(mut ports) = self.registry.lock() {
            let Some(port) = ports.get_mut(&self.task.port_id) else {
                return;
            };
            let Some(entry) = port
                .task
                .as_mut()
                .filter(|e| Arc::ptr_eq(&e.task, &self.task))
            else {
                return;
            };
            if let Some(next) = self
                .next
                .filter(|next| !self.task.cancelled() && *next < self.task.total_bytes)
            {
                entry.offset = next;
                entry.in_flight = false;
            } else {
                port.task = None;
                if port.legacy == 0 {
                    ports.remove(&self.task.port_id);
                }
            }
        }
    }
}

/// Native lifecycle transitions can revoke tasks even before the renderer sees
/// the new configuration. An already dispatched write retains its reservation.
pub(crate) fn retire_plugin_serial_tasks(state: &AppState, plugin_id: Option<&str>) {
    retire_matching_tasks(state, |task| {
        plugin_id.is_none_or(|id| task.plugin_id == id)
    });
}

/// Revoking fs:open must not touch a task fed with the plugin's own bytes.
pub(crate) fn retire_plugin_serial_file_tasks(state: &AppState, plugin_id: &str) {
    retire_matching_tasks(state, |task| {
        task.plugin_id == plugin_id && task.source.is_some()
    });
}

fn retire_matching_tasks(state: &AppState, matches: impl Fn(&Task) -> bool) {
    if let Err(error) = state.serial_work.tx.retire(matches) {
        log::warn!("Could not retire plugin serial tasks: {error}");
    }
}

fn task_id(value: &str) -> Result<Uuid, CommandError> {
    Uuid::parse_str(value).map_err(|_| CommandError::Other("Invalid plugin serial task ID".into()))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plugin_serial_task_begin(
    plugin_id: String,
    expected_generation: String,
    port_id: String,
    connection_generation: u64,
    task_id: String,
    source: PluginSerialTaskSource,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginSerialTaskBegun, CommandError> {
    require_main_window(&window)?;
    super::validate_target(&plugin_id, &port_id)?;
    let id = self::task_id(&task_id)?;
    let work = state
        .serial_work
        .admit()
        .ok_or_else(|| CommandError::Serial("Serial work is shutting down".into()))?;
    let app = window.app_handle().clone();
    tokio::task::spawn_blocking(move || {
        let _work = work;
        let state = app.state::<AppState>();
        let _authority = super::scoped_serial_authority(
            &state,
            &plugin_id,
            &expected_generation,
            None,
            Some(&port_id),
        )?;
        let (source, total_bytes) = match source {
            PluginSerialTaskSource::Bytes { total_bytes } => (None, total_bytes),
            PluginSerialTaskSource::File {
                session_id,
                handle_id,
            } => {
                let source = borrow_plugin_file_read_source(
                    &state,
                    &plugin_id,
                    &expected_generation,
                    &session_id,
                    &handle_id,
                )?;
                let total = source.len();
                (Some(source), total)
            }
        };
        if total_bytes > MAX_JS_INTEGER || connection_generation > MAX_JS_INTEGER {
            return Err(CommandError::Other(
                "Serial task length or connection identity is not a safe integer".into(),
            ));
        }
        let window_bytes = {
            let manager = state
                .serial_manager
                .lock()
                .map_err(|error| CommandError::Lock(error.to_string()))?;
            if !manager.connection_matches(&port_id, connection_generation)
                || !manager.connection_is_live(&port_id)
            {
                return Ok(PluginSerialTaskBegun {
                    total_bytes,
                    connected: false,
                    window_bytes: CHUNK_BYTES,
                });
            }
            match serial::PortKind::of(&port_id) {
                // Keep several physical blocks per IPC window, but publish a
                // checkpoint early on slow links instead of waiting for 64 KiB.
                serial::PortKind::Real => {
                    real_block_bytes(
                        manager
                            .get_last_params(&port_id)
                            .map(|params| params.baud_rate),
                    ) * 4
                }
                serial::PortKind::Tty => 4 * 1024,
                serial::PortKind::Sim => CHUNK_BYTES,
            }
        };
        let task = Task {
            id,
            plugin_id,
            install_generation: expected_generation,
            port_id,
            connection_generation,
            source,
            total_bytes,
            window_bytes,
            cancelled: AtomicBool::new(false),
        };
        if state.serial_work.shutting_down.load(Ordering::Acquire) {
            return Err(CommandError::Serial("Serial work is shutting down".into()));
        }
        state.serial_work.tx.begin(task)?;
        Ok(PluginSerialTaskBegun {
            total_bytes,
            connected: true,
            window_bytes,
        })
    })
    .await
    .map_err(|error| CommandError::Other(format!("Serial task begin failed: {error}")))?
}

/// Does not undo a submitted write. The reservation remains held until real IO
/// settles, even if the step's IPC caller disappears or cancels its wait.
#[tauri::command]
pub fn plugin_serial_task_close(
    plugin_id: String,
    expected_generation: String,
    port_id: String,
    task_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    let id = self::task_id(&task_id)?;
    state.serial_work.tx.retire(|task| {
        task.port_id == port_id && task.owned_by(&plugin_id, &expected_generation, id)
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plugin_serial_task_step(
    plugin_id: String,
    expected_generation: String,
    port_id: String,
    task_id: String,
    offset: u64,
    bytes: Option<Vec<u8>>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginSerialTaskStep, CommandError> {
    require_main_window(&window)?;
    let id = self::task_id(&task_id)?;
    if bytes
        .as_ref()
        .is_some_and(|bytes| bytes.len() > CHUNK_BYTES)
    {
        return Err(CommandError::Other(
            "Serial task window exceeds 64 KiB".into(),
        ));
    }
    let work = state
        .serial_work
        .admit()
        .ok_or_else(|| CommandError::Serial("Serial work is shutting down".into()))?;
    let Some(mut lease) =
        state
            .serial_work
            .tx
            .step(&plugin_id, &expected_generation, &port_id, id, offset)?
    else {
        return Ok(PluginSerialTaskStep::stopped(
            StepOutcome::Cancelled,
            "Serial task is no longer active",
        ));
    };
    let app = window.app_handle().clone();
    tokio::task::spawn_blocking(move || {
        let _work = work;
        let state = app.state::<AppState>();
        let result = dispatch_step(&state, &lease, bytes);
        lease.commit(&result);
        result
    })
    .await
    .map_err(|error| CommandError::Other(format!("Serial task step lost its result: {error}")))
}

fn dispatch_step(
    state: &AppState,
    lease: &StepLease,
    bytes: Option<Vec<u8>>,
) -> PluginSerialTaskStep {
    use StepOutcome::{Cancelled, Failed};
    let task = &lease.task;
    let stopped = PluginSerialTaskStep::stopped;
    if task.cancelled() {
        return stopped(Cancelled, "Serial task cancelled".to_string());
    }
    let expected = (task.total_bytes - lease.offset).min(task.window_bytes as u64) as usize;
    let bytes = match (&task.source, bytes) {
        (Some(source), None) => {
            if let Err(error) = source.check(state) {
                return stopped(Failed, error.to_string());
            }
            match source.read_window(lease.offset, expected) {
                Ok(bytes) => bytes,
                Err(error) => return stopped(Failed, error.to_string()),
            }
        }
        (None, Some(bytes)) => bytes,
        _ => return stopped(Failed, "Serial task input does not match its source".into()),
    };
    if bytes.len() != expected {
        return stopped(
            Failed,
            "Serial task source length changed or window is invalid".into(),
        );
    }

    let result = drive_window(&bytes, |remaining| dispatch_block(state, task, remaining));
    if result.bytes_written > 0 {
        let timestamp = chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string();
        if let Err(error) = state.log_manager.write(
            &task.port_id,
            &timestamp,
            "TX",
            &bytes[..result.bytes_written],
        ) {
            log::warn!("Could not write plugin serial task TX log: {error}");
        }
    }
    result
}

fn drive_window(
    bytes: &[u8],
    mut submit: impl FnMut(&[u8]) -> PluginSerialTaskStep,
) -> PluginSerialTaskStep {
    let mut written = 0;
    while written < bytes.len() {
        let mut result = submit(&bytes[written..]);
        if result.outcome == StepOutcome::Written && result.bytes_written == 0 {
            result =
                PluginSerialTaskStep::stopped(StepOutcome::Failed, "Serial write made no progress");
        }
        written += result.bytes_written;
        if result.outcome != StepOutcome::Written {
            result.bytes_written = written;
            return result;
        }
    }
    PluginSerialTaskStep {
        outcome: StepOutcome::Written,
        bytes_written: written,
        message: None,
    }
}

/// Real serial writes retain the old per-write guard and deadline. Give each
/// block nominal line time of no more than roughly half a second at the
/// configured speed (using conservatively 12 bits/byte), capped at 1 KiB.
/// This is a transport hint, not a measured driver/device timing guarantee.
fn real_block_bytes(baud_rate: Option<u32>) -> usize {
    baud_rate.map_or(256, |baud| ((baud as usize) / 24).clamp(1, 1024))
}

fn dispatch_block(state: &AppState, task: &Task, remaining: &[u8]) -> PluginSerialTaskStep {
    use StepOutcome::{Cancelled, Disconnected, Failed, Written};
    let stopped = PluginSerialTaskStep::stopped;
    if task.cancelled() {
        return stopped(Cancelled, "Serial task cancelled".to_string());
    }
    // Revalidate after the file read and between physical writes. The gate only
    // covers authorization and capture of the old writer, not the device write.
    let authority = match super::scoped_serial_authority(
        state,
        &task.plugin_id,
        &task.install_generation,
        None,
        Some(&task.port_id),
    ) {
        Ok(authority) => authority,
        Err(error) => return stopped(Failed, error.to_string()),
    };
    if let Some(source) = &task.source {
        if let Err(error) = source.check(state) {
            return stopped(Failed, error.to_string());
        }
    }
    let manager = match state.serial_manager.lock() {
        Ok(manager) => manager,
        Err(error) => return stopped(Failed, error.to_string()),
    };
    if !task.connection_matches(
        manager.connection_generation(&task.port_id),
        manager.connection_is_live(&task.port_id),
    ) {
        return stopped(
            Disconnected,
            "Port disconnected or connection changed during serial task".into(),
        );
    }
    if task.cancelled() {
        return stopped(Cancelled, "Serial task cancelled".into());
    }
    // Once authorized and captured, this block can only touch the old writer.
    let kind = serial::PortKind::of(&task.port_id);
    let block_bytes = match kind {
        serial::PortKind::Real => real_block_bytes(
            manager
                .get_last_params(&task.port_id)
                .map(|params| params.baud_rate),
        ),
        serial::PortKind::Tty => 1024,
        serial::PortKind::Sim => remaining.len(),
    };
    let bytes = &remaining[..remaining.len().min(block_bytes)];
    let mut written = 0;
    let result = match kind {
        serial::PortKind::Real => {
            let port = manager.get_write_handle(&task.port_id);
            drop(manager);
            drop(authority);
            port.and_then(|port| {
                let mut writer = port
                    .lock()
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                serial::write_with_deadline_progress(
                    &task.port_id,
                    &mut **writer,
                    bytes,
                    serial::WRITE_TOTAL_DEADLINE,
                    &mut written,
                )
            })
        }
        serial::PortKind::Tty => {
            let port = manager.get_tty_write_handle(&task.port_id);
            drop(manager);
            drop(authority);
            port.and_then(|port| port.write_progress(bytes, &mut written))
        }
        serial::PortKind::Sim => {
            let result = manager
                .write_raw(&task.port_id, bytes)
                .map(|count| written = count);
            drop(manager);
            drop(authority);
            result
        }
    };
    let message = result.err().map(|error| error.to_string()).or_else(|| {
        (written != bytes.len()).then(|| "Serial task wrote only part of its physical block".into())
    });
    let outcome = if message.is_none() {
        Written
    } else {
        let still_connected = state.serial_manager.lock().is_ok_and(|manager| {
            task.connection_matches(
                manager.connection_generation(&task.port_id),
                manager.connection_is_live(&task.port_id),
            )
        });
        if still_connected {
            Failed
        } else {
            Disconnected
        }
    };
    PluginSerialTaskStep {
        outcome,
        bytes_written: written,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(generation: u64) -> Task {
        Task {
            id: Uuid::new_v4(),
            plugin_id: "com.example.test".into(),
            install_generation: "install".into(),
            port_id: "COM1".into(),
            connection_generation: generation,
            source: None,
            total_bytes: CHUNK_BYTES as u64 + 2,
            window_bytes: CHUNK_BYTES,
            cancelled: AtomicBool::new(false),
        }
    }

    #[test]
    fn real_step_reservation_excludes_legacy_and_cannot_dispatch_twice() {
        let tx = Arc::new(TxReservations::default());
        let legacy = tx.legacy("COM1").unwrap();
        assert!(tx.begin(task(1)).is_err());
        drop(legacy);
        let active = task(7);
        let id = active.id;
        tx.begin(active).unwrap();
        assert!(tx.legacy("COM1").is_err());
        let mut first = tx
            .step("com.example.test", "install", "COM1", id, 0)
            .unwrap()
            .unwrap();
        assert!(tx
            .step("com.example.test", "install", "COM1", id, 0)
            .is_err());
        first.commit(&PluginSerialTaskStep {
            outcome: StepOutcome::Written,
            bytes_written: CHUNK_BYTES,
            message: None,
        });
        drop(first);
        assert!(tx
            .step("com.example.test", "install", "COM1", id, 0)
            .is_err());
        let next = tx
            .step(
                "com.example.test",
                "install",
                "COM1",
                id,
                CHUNK_BYTES as u64,
            )
            .unwrap()
            .unwrap();
        assert!(!next.task.connection_matches(Some(8), true));
        assert!(!next.task.connection_matches(Some(7), false));
        drop(next);
        assert!(tx.legacy("COM1").is_ok());
    }

    #[test]
    fn native_window_preserves_partial_write_and_stops_at_next_cancel_boundary() {
        use std::io::{self, Write};

        struct ShortWrite(bool);
        impl Write for ShortWrite {
            fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
                if self.0 {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "driver stopped"));
                }
                self.0 = true;
                Ok(2)
            }
            fn flush(&mut self) -> io::Result<()> {
                panic!("must not flush")
            }
        }

        let mut writer = ShortWrite(false);
        let partial = drive_window(&[10, 11, 12, 13], |bytes| {
            let mut written = 0;
            let error = serial::write_with_deadline_progress(
                "COM1",
                &mut writer,
                bytes,
                serial::WRITE_TOTAL_DEADLINE,
                &mut written,
            )
            .unwrap_err();
            PluginSerialTaskStep {
                outcome: StepOutcome::Failed,
                bytes_written: written,
                message: Some(error.to_string()),
            }
        });
        assert_eq!(partial.outcome, StepOutcome::Failed);
        assert_eq!(partial.bytes_written, 2);

        let task = task(3);
        let mut submitted = Vec::new();
        let result = drive_window(&[1, 2, 3, 4, 5], |bytes| {
            if task.cancelled() {
                return PluginSerialTaskStep::stopped(StepOutcome::Cancelled, "cancelled");
            }
            submitted.extend_from_slice(&bytes[..2]);
            task.cancelled.store(true, Ordering::Release);
            PluginSerialTaskStep {
                outcome: StepOutcome::Written,
                bytes_written: 2,
                message: None,
            }
        });
        assert_eq!(submitted, [1, 2]);
        assert_eq!(result.outcome, StepOutcome::Cancelled);
        assert_eq!(result.bytes_written, 2);
        assert_eq!(real_block_bytes(Some(9_600)), 400);
        assert_eq!(real_block_bytes(Some(115_200)), 1024);
    }

    #[test]
    fn retiring_an_in_flight_step_does_not_release_a_new_tasks_lease() {
        let tx = Arc::new(TxReservations::default());
        let active = task(7);
        let old = active.id;
        tx.begin(active).unwrap();
        let in_flight = tx
            .step("com.example.test", "install", "COM1", old, 0)
            .unwrap()
            .unwrap();
        tx.retire(|task| task.id == old).unwrap();
        assert!(in_flight.task.cancelled());
        assert!(tx.begin(task(8)).is_err());
        drop(in_flight);
        let replacement = task(8);
        let new = replacement.id;
        tx.begin(replacement).unwrap();
        tx.retire(|task| task.id == old).unwrap();
        assert!(tx
            .step("com.example.test", "install", "COM1", new, 0)
            .unwrap()
            .is_some());
    }
}
