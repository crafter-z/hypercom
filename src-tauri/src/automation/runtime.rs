//! Explicitly opt-in loopback host adapter and experimental control slice.
//!
//! `HYPERCOM_AUTOMATION_LOOPBACK=1` remains read-only. Control additionally needs
//! `HYPERCOM_AUTOMATION_UNSAFE_CONTROL=1`. This grants all local processes the same
//! TEST principal, not authenticated production authority. Native GUI/plugin/file
//! writers have NOT migrated to this arbiter; status advertises that limitation.
//! Never expose this adapter through a public listener, tunnel or proxy.
//!
//! Each connection has its own lease-holder session. The endpoint shares one
//! PortArbiter per port and one bounded, non-evicting operation ledger. Acceptance
//! is not execution: the native pre-write callback performs the core's atomic
//! execution check at the writer boundary. Accepted work owns its completion task
//! independently of the response future. Disconnect releases only that session's
//! leases; in-flight physical work drains before another holder is admitted.

use super::core::{
    self, AcceptOutcome, ByteCertainty, ByteCount, ClientSession, ClientSessionId,
    ConnectionGeneration, ControlLease, ExecutionPermit, HostId, LeaseOptions, OperationRecord,
    OperationRegistry, OperationStatus, PayloadHash, Permission, PortArbiter, PortRef, PortScope,
    Principal, PrincipalId, PrincipalKind, QueuedRequest, RequestId, RequestKey, ServerEpoch,
    SideEffect, WriterState,
};
use super::transport::{
    ConnectionContext, ErrorCode, HandlerFuture, ListenerConfig, LoopbackListener, Request,
    RequestHandler, WireError,
};
use crate::commands::{self, CommandError, PreparedSerialSend, SerialPreWriteGuard};
use crate::serial::events::SerialTxContext;
use crate::{serial, AppState};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use tauri::{AppHandle, Manager};

pub const DEFAULT_LOOPBACK_PORT: u16 = 39_071;
pub const ENABLE_ENV: &str = "HYPERCOM_AUTOMATION_LOOPBACK";
pub const PORT_ENV: &str = "HYPERCOM_AUTOMATION_PORT";
pub const UNSAFE_CONTROL_ENV: &str = "HYPERCOM_AUTOMATION_UNSAFE_CONTROL";
const READ_METHODS: &[&str] = &["host.status", "ports.list"];
const CONTROL_METHODS: &[&str] = &[
    "control.acquire",
    "control.release",
    "serial.send",
    "operations.get",
];
const MAX_OPERATIONS: usize = 4096;
const MAX_PORTS: usize = 256;
const MAX_SESSIONS: usize = 128;
const MAX_LEASE_MS: u64 = 60_000;
const TEST_PRINCIPAL: &str = "unauthenticated-loopback-test";

type BackendFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Backend methods never grant authority. `send` must call the provided guard
/// immediately before physical I/O and return only when that I/O has finished.
/// A fake backend can implement this contract without AppHandle or serial hardware.
trait RuntimeBackend: Send + Sync + 'static {
    fn list_ports(&self) -> BackendFuture<'_, Result<Vec<Value>, WireError>>;
    fn generation(&self, port_id: &str) -> Result<u64, WireError>;
    fn send(
        &self,
        prepared: PreparedSerialSend,
        context: SerialTxContext,
        guard: SerialPreWriteGuard,
    ) -> BackendFuture<'_, SendReport>;
}

#[derive(Clone, Copy)]
struct NativeFact {
    generation: u64,
    timestamp: Option<i64>,
}

struct SendReport {
    bytes: ByteCount,
    failure: Option<WireError>,
    native_fact: Option<NativeFact>,
}

struct NativeBackend {
    app: AppHandle,
    host_id: String,
    server_epoch: String,
}

impl RuntimeBackend for NativeBackend {
    fn list_ports(&self) -> BackendFuture<'_, Result<Vec<Value>, WireError>> {
        Box::pin(async move {
            let manager = self.app.state::<AppState>().serial_manager.clone();
            let listing_manager = manager.clone();
            let ports =
                tokio::task::spawn_blocking(move || serial::list_ports_blocking(&listing_manager))
                    .await
                    .map_err(|_| {
                        runtime_error(ErrorCode::Internal, "port enumeration task failed")
                    })?
                    .map_err(|error| runtime_error(ErrorCode::IoError, error.to_string()))?;
            let connected = manager
                .lock()
                .map_err(|_| runtime_error(ErrorCode::Internal, "serial state unavailable"))?;
            Ok(ports
                .into_iter()
                .map(|port| {
                    let generation = connected.status_generation(&port.id).unwrap_or(0);
                    let is_connected = connected.connection_generation(&port.id).is_some();
                    json!({
                        "target": {"hostId": self.host_id, "nativePortId": port.id},
                        "serverEpoch": self.server_epoch,
                        "name": port.name, "portType": port.port_type,
                        "state": if is_connected { "open" } else { "closed" },
                        "connectionGeneration": generation.to_string(),
                        "manufacturer": port.manufacturer, "product": port.product,
                    })
                })
                .collect())
        })
    }

    fn generation(&self, port_id: &str) -> Result<u64, WireError> {
        self.app
            .state::<AppState>()
            .serial_manager
            .lock()
            .map_err(|_| runtime_error(ErrorCode::Internal, "serial state unavailable"))?
            .connection_generation(port_id)
            .ok_or_else(|| runtime_error(ErrorCode::PortNotFound, "port has no active connection"))
    }

    fn send(
        &self,
        prepared: PreparedSerialSend,
        context: SerialTxContext,
        guard: SerialPreWriteGuard,
    ) -> BackendFuture<'_, SendReport> {
        let state = self.app.state::<AppState>();
        let manager = state.serial_manager.clone();
        let logger = state.log_manager.clone();
        let work = state.serial_work.clone();
        let app = self.app.clone();
        Box::pin(async move {
            match commands::send_serial_data_internal(
                prepared,
                manager,
                logger,
                work,
                Some(app),
                context,
                Some(guard),
            )
            .await
            {
                Ok(result) => SendReport {
                    bytes: ByteCount::exact(result.tx.written as u64),
                    failure: None,
                    native_fact: Some(NativeFact {
                        generation: result.generation,
                        timestamp: Some(result.timestamp),
                    }),
                },
                Err(failure) => {
                    let code = if !failure.bytes_exact {
                        ErrorCode::OutcomeUnknown
                    } else {
                        match failure.stage {
                            commands::SerialSendStage::Generation => ErrorCode::StaleSession,
                            commands::SerialSendStage::Prepare => ErrorCode::InvalidArgument,
                            commands::SerialSendStage::Admission => match &failure.error {
                                CommandError::Lock(_) => ErrorCode::Internal,
                                _ => ErrorCode::ShuttingDown,
                            },
                            commands::SerialSendStage::Guard => ErrorCode::UnsupportedCapability,
                            commands::SerialSendStage::Driver => ErrorCode::IoError,
                            commands::SerialSendStage::Join => ErrorCode::OutcomeUnknown,
                        }
                    };
                    let mut error = runtime_error(code, failure.error.to_string());
                    error.stage = Some(format!("native.{:?}", failure.stage));
                    SendReport {
                        bytes: if failure.bytes_exact {
                            ByteCount::exact(failure.known_bytes.len() as u64)
                        } else {
                            ByteCount::at_least(failure.known_bytes.len() as u64)
                        },
                        failure: Some(error),
                        native_fact: failure.generation.map(|generation| NativeFact {
                            generation,
                            timestamp: None,
                        }),
                    }
                }
            }
        })
    }
}

fn runtime_error(code: ErrorCode, message: impl Into<String>) -> WireError {
    let mut error = WireError::new(code, message);
    error.stage = Some("runtime".into());
    error
}

fn core_error(error: core::AutomationError) -> WireError {
    use core::ErrorCode as C;
    let code = match error.code {
        C::InvalidArgument => ErrorCode::InvalidArgument,
        C::WrongHost => ErrorCode::HostUnavailable,
        C::EpochMismatch | C::GenerationMismatch => ErrorCode::StaleSession,
        C::PermissionDenied | C::PortOutOfScope => ErrorCode::PermissionDenied,
        C::LeaseBusy | C::Draining | C::DrainPending => ErrorCode::PortBusy,
        C::LeaseMissing
        | C::LeaseExpired
        | C::FenceMismatch
        | C::HolderMismatch
        | C::TakeoverMissing => ErrorCode::ControlLost,
        C::RequestConflict => ErrorCode::RequestIdConflict,
        C::OperationMissing => ErrorCode::OutcomeUnknown,
        C::CursorAhead => ErrorCode::CursorExpired,
        C::IoError => ErrorCode::IoError,
        C::OutcomeUnknown => ErrorCode::OutcomeUnknown,
        C::DeadlineExceeded => ErrorCode::DeadlineExceeded,
        C::Cancelled => ErrorCode::Cancelled,
        C::InvalidTransition | C::CounterExhausted | C::ClockRegression => ErrorCode::Internal,
    };
    let mut wire = runtime_error(code, error.message.clone());
    wire.stage = Some(format!("core.{:?}", error.stage));
    wire.retryable = error.retryable && error.side_effect == SideEffect::None;
    wire.details = Some(json!({"domainCode": error.code, "sideEffect": error.side_effect}));
    wire
}

struct OperationMetadata {
    target: PortRef,
    generation: ConnectionGeneration,
    permit: Option<ExecutionPermit>,
    guard_error: Option<WireError>,
    failure: Option<WireError>,
    native_fact: Option<NativeFact>,
}

struct RuntimeState {
    sessions: BTreeMap<u64, ClientSession>,
    arbiters: BTreeMap<PortRef, PortArbiter>,
    operations: OperationRegistry,
    metadata: BTreeMap<RequestKey, OperationMetadata>,
}

struct RuntimeShared {
    state: Mutex<RuntimeState>,
    backend: Arc<dyn RuntimeBackend>,
    host_id: HostId,
    epoch: ServerEpoch,
    unsafe_control: bool,
    started: Instant,
    max_operations: usize,
}

impl RuntimeShared {
    fn lock(&self) -> Result<MutexGuard<'_, RuntimeState>, WireError> {
        self.state
            .lock()
            .map_err(|_| runtime_error(ErrorCode::Internal, "automation state unavailable"))
    }

    fn now(&self) -> u64 {
        self.started
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    fn session(
        &self,
        state: &mut RuntimeState,
        connection: ConnectionContext,
    ) -> Result<ClientSession, WireError> {
        if !connection.peer_addr.ip().is_loopback() {
            return Err(runtime_error(
                ErrorCode::PermissionDenied,
                "only local test connections are permitted",
            ));
        }
        if let Some(session) = state.sessions.get(&connection.connection_id) {
            return Ok(session.clone());
        }
        if state.sessions.len() >= MAX_SESSIONS {
            return Err(runtime_error(
                ErrorCode::PortBusy,
                "local session limit reached",
            ));
        }
        let permissions = if self.unsafe_control {
            BTreeSet::from([Permission::Observe, Permission::Write, Permission::Control])
        } else {
            BTreeSet::from([Permission::Observe])
        };
        let session = ClientSession {
            id: ClientSessionId(format!(
                "{}:connection:{}",
                self.epoch.0, connection.connection_id
            )),
            principal: Principal {
                id: PrincipalId(TEST_PRINCIPAL.into()),
                kind: PrincipalKind::Cli,
            },
            server_epoch: self.epoch.clone(),
            permissions,
            port_scope: PortScope::All,
        };
        state
            .sessions
            .insert(connection.connection_id, session.clone());
        Ok(session)
    }

    fn require_control(&self) -> Result<(), WireError> {
        if !self.unsafe_control {
            return Err(runtime_error(
                ErrorCode::PermissionDenied,
                "experimental control requires HYPERCOM_AUTOMATION_UNSAFE_CONTROL=1",
            ));
        }
        Ok(())
    }

    fn check_epoch(&self, request: &Request, required: bool) -> Result<(), WireError> {
        match request
            .precondition
            .as_ref()
            .and_then(|precondition| precondition.server_epoch.as_deref())
        {
            Some(epoch) if epoch == self.epoch.0 => Ok(()),
            Some(_) => Err(runtime_error(
                ErrorCode::StaleSession,
                "server epoch does not match",
            )),
            None if required => Err(runtime_error(
                ErrorCode::InvalidArgument,
                "precondition.serverEpoch is required",
            )),
            None => Ok(()),
        }
    }

    fn target(&self, request: &Request) -> Result<(PortRef, ConnectionGeneration), WireError> {
        self.check_epoch(request, true)?;
        let target = request
            .target
            .as_ref()
            .ok_or_else(|| runtime_error(ErrorCode::InvalidArgument, "target is required"))?;
        if target.host_id != self.host_id.0 {
            return Err(runtime_error(
                ErrorCode::HostUnavailable,
                "target host does not match this host",
            ));
        }
        if target.native_port_id.is_empty() {
            return Err(runtime_error(
                ErrorCode::InvalidArgument,
                "native port id is required",
            ));
        }
        let generation = request
            .precondition
            .as_ref()
            .and_then(|precondition| precondition.connection_generation)
            .ok_or_else(|| {
                runtime_error(
                    ErrorCode::InvalidArgument,
                    "precondition.connectionGeneration is required",
                )
            })?;
        Ok((
            PortRef {
                host_id: self.host_id.clone(),
                native_port_id: target.native_port_id.clone(),
            },
            ConnectionGeneration(generation),
        ))
    }

    fn current_arbiter<'a>(
        &self,
        state: &'a mut RuntimeState,
        target: &PortRef,
        expected: ConnectionGeneration,
        native_generation: u64,
    ) -> Result<&'a mut PortArbiter, WireError> {
        // Obtain the native snapshot before the runtime mutex: never create the
        // lock cycle runtime -> SerialManager -> writer -> pre-write runtime.
        // The native helper rechecks generation at the actual write boundary.
        let current = ConnectionGeneration(native_generation);
        if current != expected {
            return Err(runtime_error(
                ErrorCode::StaleSession,
                "port connection generation changed",
            ));
        }
        if !state.arbiters.contains_key(target) && state.arbiters.len() >= MAX_PORTS {
            return Err(runtime_error(
                ErrorCode::PortBusy,
                "port arbitration capacity reached",
            ));
        }
        let arbiter = state
            .arbiters
            .entry(target.clone())
            .or_insert_with(|| PortArbiter::new(target.clone(), self.epoch.clone(), current));
        if arbiter.generation() != current {
            arbiter
                .change_generation(current, self.now())
                .map_err(core_error)?;
        }
        arbiter.expire(self.now()).map_err(core_error)?;
        Ok(arbiter)
    }

    fn lease(
        arbiter: &PortArbiter,
        session: &ClientSession,
        request: &Request,
        now: u64,
    ) -> Result<ControlLease, WireError> {
        let control = request.control.as_ref().ok_or_else(|| {
            runtime_error(
                ErrorCode::ControlLost,
                "control lease and fence are required",
            )
        })?;
        let lease = arbiter
            .effective_writer(now)
            .ok_or_else(|| runtime_error(ErrorCode::ControlLost, "no active control lease"))?;
        if lease.lease_id.0 != control.lease_id
            || lease.fence.fencing_token.0 != control.fence
            || lease.fence.holder != session.holder()
        {
            return Err(runtime_error(
                ErrorCode::ControlLost,
                "lease, fence or holder does not match",
            ));
        }
        Ok(lease.clone())
    }

    fn disconnect(&self, connection: ConnectionContext) {
        let Ok(mut state) = self.lock() else {
            return;
        };
        let Some(session) = state.sessions.remove(&connection.connection_id) else {
            return;
        };
        let now = self.now();
        for arbiter in state.arbiters.values_mut() {
            let _ = arbiter.expire(now);
            if let WriterState::Active { lease } = arbiter.state() {
                if lease.fence.holder == session.holder() {
                    let fence = lease.fence.clone();
                    let _ = arbiter.release(&session, &fence, now);
                }
            }
            if matches!(arbiter.state(), WriterState::Draining { .. })
                && arbiter.in_flight().is_none()
            {
                let _ = arbiter.drain();
            }
        }
        // Deliberately no serial close, signal change or global cancellation.
    }

    fn begin_write(
        &self,
        connection: ConnectionContext,
        session: &ClientSession,
        queued: &QueuedRequest,
        received: Instant,
        timeout_ms: Option<u64>,
    ) -> Result<(), WireError> {
        let mut state = self.lock()?;
        let validation = (|| {
            if state.sessions.get(&connection.connection_id) != Some(session) {
                return Err(runtime_error(
                    ErrorCode::ControlLost,
                    "client session ended before execution",
                ));
            }
            if timeout_ms.is_some_and(|budget| received.elapsed().as_millis() >= u128::from(budget))
            {
                return Err(runtime_error(
                    ErrorCode::DeadlineExceeded,
                    "request deadline expired before execution",
                ));
            }
            let RuntimeState {
                arbiters,
                operations,
                ..
            } = &mut *state;
            let arbiter = arbiters.get_mut(&queued.fence.port).ok_or_else(|| {
                runtime_error(ErrorCode::ControlLost, "port arbitration state missing")
            })?;
            operations
                .begin_execution(arbiter, session, queued, self.now())
                .map_err(core_error)
        })();
        match validation {
            Ok(permit) => {
                state
                    .metadata
                    .get_mut(&queued.key)
                    .ok_or_else(|| {
                        runtime_error(ErrorCode::Internal, "operation metadata missing")
                    })?
                    .permit = Some(permit);
                Ok(())
            }
            Err(error) => {
                if let Some(metadata) = state.metadata.get_mut(&queued.key) {
                    metadata.guard_error = Some(error.clone());
                }
                Err(error)
            }
        }
    }

    fn complete_write(&self, key: &RequestKey, mut report: SendReport) -> Result<Value, WireError> {
        let mut state = self.lock()?;
        let requested = state
            .operations
            .get(key)
            .ok_or_else(|| runtime_error(ErrorCode::Internal, "operation record missing"))?
            .requested_bytes;
        let metadata = state
            .metadata
            .get_mut(key)
            .ok_or_else(|| runtime_error(ErrorCode::Internal, "operation metadata missing"))?;
        if let Some(error) = metadata.guard_error.take() {
            report.failure = Some(error);
            report.bytes = ByteCount::exact(0);
        }
        let started = metadata.permit.is_some();
        if !started && report.bytes.certainty == ByteCertainty::AtLeast {
            // No execution permit means the mandatory writer guard never passed.
            report.bytes = ByteCount::exact(0);
        }
        // A backend violating the guard/count contract must not fabricate success.
        if report.bytes.known > requested || (!started && report.failure.is_none()) {
            report.bytes = if started {
                ByteCount::at_least(0)
            } else {
                ByteCount::exact(0)
            };
            report.failure = Some(runtime_error(
                ErrorCode::OutcomeUnknown,
                "native writer returned an inconsistent outcome",
            ));
        }
        if started
            && report
                .native_fact
                .is_some_and(|fact| fact.generation != metadata.generation.0)
        {
            report.bytes = ByteCount::at_least(report.bytes.known);
            report.failure = Some(runtime_error(
                ErrorCode::OutcomeUnknown,
                "native completion generation does not match the admitted operation",
            ));
        }
        metadata.native_fact = report.native_fact;
        if report.failure.is_none() && report.bytes != ByteCount::exact(requested) {
            report.failure = Some(runtime_error(
                ErrorCode::IoError,
                "native writer did not confirm the complete payload",
            ));
        }
        let status = if report.bytes.certainty == ByteCertainty::AtLeast && started {
            OperationStatus::Unknown
        } else if report.failure.is_some() {
            OperationStatus::Failed
        } else {
            OperationStatus::Succeeded
        };
        let domain_failure = report.failure.as_ref().map(|failure| {
            core::AutomationError::new(
                match failure.code {
                    ErrorCode::DeadlineExceeded => core::ErrorCode::DeadlineExceeded,
                    ErrorCode::ControlLost => core::ErrorCode::HolderMismatch,
                    ErrorCode::StaleSession => core::ErrorCode::GenerationMismatch,
                    ErrorCode::OutcomeUnknown => core::ErrorCode::OutcomeUnknown,
                    _ => core::ErrorCode::IoError,
                },
                core::ErrorStage::Complete,
                false,
                report.bytes.side_effect(requested),
                failure.message.clone(),
            )
        });
        metadata.failure = report.failure;
        let permit = metadata.permit.clone();
        let target = metadata.target.clone();
        state
            .operations
            .finish(key, status, report.bytes, domain_failure, self.now())
            .map_err(core_error)?;
        // Only the physically completed native helper may retire an execution.
        if let Some(permit) = permit {
            let arbiter = state.arbiters.get_mut(&target).ok_or_else(|| {
                runtime_error(ErrorCode::Internal, "port arbitration state missing")
            })?;
            arbiter.complete_execution(&permit).map_err(core_error)?;
            arbiter.expire(self.now()).map_err(core_error)?;
            if matches!(arbiter.state(), WriterState::Draining { .. }) {
                arbiter.drain().map_err(core_error)?;
            }
            state
                .metadata
                .get_mut(key)
                .expect("metadata checked above")
                .permit = None;
        }
        operation_value(&state, key)
    }
}

pub struct LocalAutomationHandler {
    shared: Arc<RuntimeShared>,
}

impl LocalAutomationHandler {
    pub fn new(
        app: AppHandle,
        host_id: impl Into<String>,
        server_epoch: impl Into<String>,
    ) -> Self {
        let host_id = host_id.into();
        let server_epoch = server_epoch.into();
        let backend = Arc::new(NativeBackend {
            app,
            host_id: host_id.clone(),
            server_epoch: server_epoch.clone(),
        });
        Self::with_backend(
            backend,
            host_id,
            server_epoch,
            std::env::var(UNSAFE_CONTROL_ENV).ok().as_deref() == Some("1"),
        )
    }

    fn with_backend(
        backend: Arc<dyn RuntimeBackend>,
        host_id: String,
        server_epoch: String,
        unsafe_control: bool,
    ) -> Self {
        let epoch = ServerEpoch(server_epoch);
        Self {
            shared: Arc::new(RuntimeShared {
                state: Mutex::new(RuntimeState {
                    sessions: BTreeMap::new(),
                    arbiters: BTreeMap::new(),
                    operations: OperationRegistry::new(epoch.clone()),
                    metadata: BTreeMap::new(),
                }),
                backend,
                host_id: HostId(host_id),
                epoch,
                unsafe_control,
                started: Instant::now(),
                max_operations: MAX_OPERATIONS,
            }),
        }
    }

    pub fn capabilities(&self) -> Vec<String> {
        READ_METHODS
            .iter()
            .chain(if self.shared.unsafe_control {
                CONTROL_METHODS.iter()
            } else {
                [].iter()
            })
            .map(|method| (*method).to_owned())
            .collect()
    }

    fn acquire(
        &self,
        connection: ConnectionContext,
        request: &Request,
    ) -> Result<Value, WireError> {
        self.shared.require_control()?;
        let (target, generation) = self.shared.target(request)?;
        let params: AcquireParams = parse_params(&request.params)?;
        if params.ttl_ms == 0 || params.ttl_ms > MAX_LEASE_MS {
            return Err(runtime_error(
                ErrorCode::InvalidArgument,
                "ttlMs must be between 1 and 60000",
            ));
        }
        if params.wait_ms.unwrap_or(0) != 0 {
            return Err(runtime_error(
                ErrorCode::UnsupportedCapability,
                "waiting for control is not supported by this test slice",
            ));
        }
        let native_generation = self.shared.backend.generation(&target.native_port_id)?;
        let mut state = self.shared.lock()?;
        let session = self.shared.session(&mut state, connection)?;
        let arbiter =
            self.shared
                .current_arbiter(&mut state, &target, generation, native_generation)?;
        let lease = arbiter
            .acquire(
                &session,
                LeaseOptions {
                    ttl_ms: params.ttl_ms,
                    permissions: BTreeSet::from([Permission::Control, Permission::Write]),
                },
                self.shared.now(),
            )
            .map_err(core_error)?;
        Ok(lease_value(&lease))
    }

    fn release(
        &self,
        connection: ConnectionContext,
        request: &Request,
    ) -> Result<Value, WireError> {
        self.shared.require_control()?;
        let _: EmptyParams = parse_params(&request.params)?;
        let (target, generation) = self.shared.target(request)?;
        let native_generation = self.shared.backend.generation(&target.native_port_id)?;
        let mut state = self.shared.lock()?;
        let session = self.shared.session(&mut state, connection)?;
        let arbiter =
            self.shared
                .current_arbiter(&mut state, &target, generation, native_generation)?;
        let lease = RuntimeShared::lease(arbiter, &session, request, self.shared.now())?;
        arbiter
            .release(&session, &lease.fence, self.shared.now())
            .map_err(core_error)?;
        Ok(Value::Null)
    }

    fn get_operation(
        &self,
        connection: ConnectionContext,
        request: &Request,
    ) -> Result<Value, WireError> {
        self.shared.require_control()?;
        self.shared.check_epoch(request, true)?;
        let params: GetOperationParams = parse_params(&request.params)?;
        let mut state = self.shared.lock()?;
        let session = self.shared.session(&mut state, connection)?;
        let key = match (&params.request_id, &params.operation_id) {
            (Some(id), None) if !id.is_empty() => RequestKey {
                principal_id: session.principal.id,
                request_id: RequestId(id.clone()),
            },
            (None, Some(id)) if !id.is_empty() => state
                .metadata
                .keys()
                .find(|key| {
                    key.principal_id == session.principal.id
                        && state
                            .operations
                            .get(key)
                            .is_some_and(|record| record.operation_id.0 == *id)
                })
                .cloned()
                .ok_or_else(|| {
                    runtime_error(
                        ErrorCode::OutcomeUnknown,
                        "operation is not retained in this server epoch",
                    )
                })?,
            _ => {
                return Err(runtime_error(
                    ErrorCode::InvalidArgument,
                    "specify exactly one operationId or requestId",
                ))
            }
        };
        operation_value(&state, &key)
    }

    async fn send(
        &self,
        connection: ConnectionContext,
        request: Request,
    ) -> Result<Value, WireError> {
        self.shared.require_control()?;
        let received = Instant::now();
        let (target, generation) = self.shared.target(&request)?;
        let prepared = prepare_payload(&target.native_port_id, generation.0, &request.params)?;
        let requested_bytes = prepared.requested_bytes() as u64;
        let canonical = canonical_json(
            serde_json::to_value(&request)
                .map_err(|_| runtime_error(ErrorCode::InvalidArgument, "invalid request"))?,
        );
        let payload_hash = PayloadHash::of(
            &serde_json::to_vec(&canonical)
                .map_err(|_| runtime_error(ErrorCode::InvalidArgument, "invalid request"))?,
        );
        // Preserve duplicate reconciliation even if the port is now offline:
        // observe outside the runtime lock, but apply a snapshot error only for
        // a newly admitted request after checking the retained operation key.
        let native_generation = self.shared.backend.generation(&target.native_port_id);
        let (session, queued, context) = {
            let mut state = self.shared.lock()?;
            let session = self.shared.session(&mut state, connection)?;
            let key = RequestKey {
                principal_id: session.principal.id.clone(),
                request_id: RequestId(request.request_id.clone()),
            };
            if state.operations.get(&key).is_some() {
                state
                    .operations
                    .accept(
                        &session,
                        key.request_id.clone(),
                        payload_hash,
                        requested_bytes,
                        self.shared.now(),
                    )
                    .map_err(core_error)?;
                return operation_value(&state, &key);
            }
            if state.metadata.len() >= self.shared.max_operations {
                return Err(runtime_error(
                    ErrorCode::PortBusy,
                    "operation retention capacity reached; no records are evicted for replay",
                ));
            }
            let arbiter =
                self.shared
                    .current_arbiter(&mut state, &target, generation, native_generation?)?;
            let lease = RuntimeShared::lease(arbiter, &session, &request, self.shared.now())?;
            let queued = arbiter
                .queue_request(
                    &session,
                    QueuedRequest {
                        key: key.clone(),
                        payload_hash,
                        fence: lease.fence,
                        required_permission: Permission::Write,
                        requested_bytes,
                    },
                    self.shared.now(),
                )
                .map_err(core_error)?;
            let record = match state
                .operations
                .accept(
                    &session,
                    key.request_id.clone(),
                    payload_hash,
                    requested_bytes,
                    self.shared.now(),
                )
                .map_err(core_error)?
            {
                AcceptOutcome::Accepted(record) => record,
                AcceptOutcome::Duplicate(_) => return operation_value(&state, &key),
            };
            state
                .operations
                .mark_queued(&key, self.shared.now())
                .map_err(core_error)?;
            state.metadata.insert(
                key,
                OperationMetadata {
                    target,
                    generation,
                    permit: None,
                    guard_error: None,
                    failure: None,
                    native_fact: None,
                },
            );
            let context = SerialTxContext {
                source: Some("unsafe-loopback-test".into()),
                operation_id: Some(record.operation_id.0),
                request_id: Some(request.request_id.clone()),
                principal_id: Some(session.principal.id.0.clone()),
                client_session_id: Some(session.id.0.clone()),
            };
            (session, queued, context)
        };
        let shared = self.shared.clone();
        let guard_shared = shared.clone();
        let guard_request = queued.clone();
        let guard: SerialPreWriteGuard = Box::new(move || {
            guard_shared
                .begin_write(
                    connection,
                    &session,
                    &guard_request,
                    received,
                    request.timeout_ms,
                )
                .map_err(|_| {
                    CommandError::Serial("automation execution guard rejected request".into())
                })
        });
        // Dropping the caller's JoinHandle does not abort this owned completion.
        // SerialWorkState separately keeps application shutdown behind native I/O.
        tokio::spawn(async move {
            let report = shared.backend.send(prepared, context, guard).await;
            shared.complete_write(&queued.key, report)
        })
        .await
        .map_err(|_| {
            runtime_error(
                ErrorCode::OutcomeUnknown,
                "operation task failed; do not replay the request; query its original operation",
            )
        })?
    }
}

impl RequestHandler for LocalAutomationHandler {
    fn handle(&self, connection: ConnectionContext, request: Request) -> HandlerFuture<'_> {
        Box::pin(async move {
            if let Some(target) = &request.target {
                if target.host_id != self.shared.host_id.0 {
                    return Err(runtime_error(
                        ErrorCode::HostUnavailable,
                        "target host does not match this host",
                    ));
                }
            }
            self.shared.check_epoch(&request, false)?;
            match request.method.as_str() {
                "host.status" => {
                    let mut state = self.shared.lock()?;
                    let session = self.shared.session(&mut state, connection)?;
                    Ok(
                        json!({"hostId": self.shared.host_id.0, "serverEpoch": self.shared.epoch.0,
                            "mode": "desktop-attached", "capabilities": self.capabilities(),
                            "clientSessionId": session.id.0,
                            "serialControl": if self.shared.unsafe_control { "unsafe-local-test-only" } else { "not-enabled" },
                            "security": "unauthenticated-local-test-only", "nativeGuiArbitration": false,
                            "operationRetention": {"maxRecords": self.shared.max_operations, "automaticEviction": false},
                        }),
                    )
                }
                "ports.list" => Ok(
                    json!({"hostId": self.shared.host_id.0, "serverEpoch": self.shared.epoch.0,
                    "ports": self.shared.backend.list_ports().await?, "readOnly": !self.shared.unsafe_control}),
                ),
                "control.acquire" => self.acquire(connection, &request),
                "control.release" => self.release(connection, &request),
                "serial.send" => self.send(connection, request).await,
                "operations.get" => self.get_operation(connection, &request),
                _ => Err(runtime_error(
                    ErrorCode::UnsupportedCapability,
                    "method is not enabled by this adapter",
                )),
            }
        })
    }

    fn disconnected(&self, connection: ConnectionContext, _reason: Option<WireError>) {
        self.shared.disconnect(connection);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcquireParams {
    ttl_ms: u64,
    #[serde(default)]
    wait_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetOperationParams {
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawParams {
    data_base64: String,
}
#[derive(Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ModeParams {
    Text {
        text: String,
        #[serde(default)]
        encoding: Option<String>,
        #[serde(default)]
        line_ending: Option<String>,
    },
    Hex {
        hex: String,
        #[serde(default)]
        line_ending: Option<String>,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyParams {
    data: String,
    #[serde(default)]
    is_hex: bool,
    #[serde(default)]
    append_line_ending: Option<String>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum SendParams {
    Raw(RawParams),
    Mode(ModeParams),
    Legacy(LegacyParams),
}

fn parse_params<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, WireError> {
    serde_json::from_value(value.clone())
        .map_err(|_| runtime_error(ErrorCode::InvalidArgument, "invalid method parameters"))
}

fn line_ending(value: Option<&str>) -> Result<&'static str, WireError> {
    match value.unwrap_or("None") {
        "None" | "none" | "" => Ok("None"),
        "\\n" | "lf" => Ok("\\n"),
        "\\r" | "cr" => Ok("\\r"),
        "\\r\\n" | "crlf" => Ok("\\r\\n"),
        _ => Err(runtime_error(
            ErrorCode::InvalidArgument,
            "unsupported line ending",
        )),
    }
}

fn prepare_payload(
    port_id: &str,
    generation: u64,
    params: &Value,
) -> Result<PreparedSerialSend, WireError> {
    let params: SendParams = parse_params(params)?;
    let (data, is_hex, ending) = match params {
        SendParams::Raw(raw) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(raw.data_base64)
                .map_err(|_| runtime_error(ErrorCode::InvalidArgument, "invalid base64 payload"))?;
            return Ok(commands::prepare_serial_send_raw(
                port_id.into(),
                bytes,
                generation,
            ));
        }
        SendParams::Mode(ModeParams::Text {
            text,
            encoding,
            line_ending: ending,
        }) => {
            if encoding.as_deref().is_some_and(|encoding| {
                !encoding.eq_ignore_ascii_case("utf-8") && !encoding.eq_ignore_ascii_case("utf8")
            }) {
                return Err(runtime_error(
                    ErrorCode::UnsupportedCapability,
                    "this slice supports UTF-8 text only",
                ));
            }
            (text, false, line_ending(ending.as_deref())?)
        }
        SendParams::Mode(ModeParams::Hex {
            hex,
            line_ending: ending,
        }) => {
            if line_ending(ending.as_deref())? != "None" {
                return Err(runtime_error(
                    ErrorCode::InvalidArgument,
                    "HEX mode does not append line endings",
                ));
            }
            (hex, true, "None")
        }
        SendParams::Legacy(params) => (
            params.data,
            params.is_hex,
            line_ending(params.append_line_ending.as_deref())?,
        ),
    };
    let prepared = commands::prepare_serial_send(commands::SendDataArgs {
        port_id: port_id.into(),
        data,
        is_hex,
        append_line_ending: ending.into(),
        expected_generation: Some(generation),
    })
    .map_err(|failure| runtime_error(ErrorCode::InvalidArgument, failure.error.to_string()))?;
    // The wire API sends bytes, not the legacy SIM numeric-frequency control
    // side channel. Reuse the native codec, then preserve those exact bytes.
    Ok(commands::prepare_serial_send_raw(
        port_id.into(),
        prepared.bytes().to_vec(),
        generation,
    ))
}

fn canonical_json(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(canonical_json).collect()),
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .map(|(key, value)| (key, canonical_json(value)))
                .collect(),
        ),
        other => other,
    }
}

fn lease_value(lease: &ControlLease) -> Value {
    json!({"target": lease.fence.port, "serverEpoch": lease.fence.server_epoch.0,
        "connectionGeneration": lease.fence.connection_generation.0.to_string(),
        "leaseId": lease.lease_id.0, "fence": lease.fence.fencing_token.0.to_string(),
        "state": "granted", "expiresAtMs": lease.expires_at_ms, "ttlMs": lease.ttl_ms,
        "clock": "server-monotonic", "clientSessionId": lease.fence.holder.session_id.0})
}

fn operation_value(state: &RuntimeState, key: &RequestKey) -> Result<Value, WireError> {
    let record: &OperationRecord = state.operations.get(key).ok_or_else(|| {
        runtime_error(
            ErrorCode::OutcomeUnknown,
            "operation is not retained in this server epoch",
        )
    })?;
    let metadata = state
        .metadata
        .get(key)
        .ok_or_else(|| runtime_error(ErrorCode::Internal, "operation metadata missing"))?;
    let certainty = if record.status == OperationStatus::Executing {
        "unknown"
    } else {
        match record.bytes.side_effect(record.requested_bytes) {
            SideEffect::Unknown => "unknown",
            SideEffect::Partial => "partial",
            _ => "known",
        }
    };
    let state_name = match record.status {
        OperationStatus::Accepted => "accepted",
        OperationStatus::Queued => "queued",
        OperationStatus::Executing => "executing",
        OperationStatus::Succeeded => "succeeded",
        OperationStatus::Cancelled => "cancelled",
        OperationStatus::Failed | OperationStatus::Unknown => "failed",
    };
    let outcome = json!({"certainty": certainty, "bytesWritten": record.bytes.known.to_string()});
    let failure = metadata.failure.as_ref().map(|error| {
        let mut value = serde_json::to_value(error).expect("WireError is serializable");
        value["operationId"] = json!(record.operation_id.0);
        value["sideEffects"] = outcome.clone();
        value
    });
    Ok(
        json!({"operationId": record.operation_id.0, "requestId": record.key.request_id.0,
            "target": metadata.target, "serverEpoch": record.server_epoch.0,
            "connectionGeneration": metadata.generation.0.to_string(), "state": state_name,
            "status": record.status, "outcome": outcome, "requestedBytes": record.requested_bytes.to_string(),
            "error": failure,
            "nativeGeneration": metadata.native_fact.map(|fact| fact.generation.to_string()),
            "completedAtMs": metadata.native_fact.and_then(|fact| fact.timestamp),
        }),
    )
}

/// Start only from the opt-in application setup path. The second, explicitly
/// unsafe flag controls advertised write capabilities; no remote auth is implied.
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
    let capabilities = handler.capabilities();
    let listener = LoopbackListener::bind(
        port,
        ListenerConfig::new(server_epoch, capabilities),
        handler,
    )
    .await
    .map_err(|error| error.to_string())?;
    let bound_port = listener.local_addr().port();
    let mut slot = slot
        .lock()
        .map_err(|_| "automation listener state unavailable".to_owned())?;
    if slot.is_some() {
        return Err("automation listener is already running".into());
    }
    *slot = Some(listener);
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

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
