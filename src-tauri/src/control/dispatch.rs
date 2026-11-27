//! Command dispatch for `ControlHub` across local IPC and remote TLS actors.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use uuid::Uuid;

use hypercom_protocol::{
    Access, ControlCommand, EventPageDto, ExpectMatcher, ExpectSpec, HostError, LoanInfoDto,
    PortRef, PortSnapshotDto, RemoteRole, RequestOutcomeDto, SerialParamsDto, SerialRecoveryDto,
    StreamEventDto, MAX_EXPECT_MS, MAX_POLL_MS, MAX_WRITE_BYTES, PROTOCOL_VERSION,
};

use crate::commands::OpenPortArgs;
use crate::serial::{
    self, AcquireLeaseRequest, HubEvent, HubEventKind, LoanMetadata, SerialManager,
};

use super::{Actor, ControlHub, RemoteLeaseTrack};

const MAX_NOTE_BYTES: usize = 4096;

pub(crate) fn loan_meta_to_dto(
    port_id: &str,
    generation: u64,
    meta: LoanMetadata,
) -> LoanInfoDto {
    LoanInfoDto {
        lease_id: meta.lease_id,
        port_id: port_id.to_string(),
        holder: meta.holder,
        reason: meta.reason,
        acquired_at_ms: meta.acquired_at_ms,
        expires_at_ms: meta.expires_at_ms,
        generation,
        auto_reopen: meta.auto_reopen,
        connection_bound: meta.connection_bound,
    }
}

impl ControlHub {
    pub(crate) async fn dispatch_command(
        self: &Arc<Self>,
        cmd: ControlCommand,
        actor: Actor,
    ) -> Result<Value, HostError> {
        match cmd {
            ControlCommand::RemoteStatus => {
                require_local(&actor)?;
                to_json(self.remote_status().await?)
            }
            ControlCommand::RemoteStart { listen, advertise } => {
                require_local(&actor)?;
                to_json(self.start_remote(listen, advertise).await?)
            }
            ControlCommand::RemoteStop => {
                require_local(&actor)?;
                self.stop_remote().await?;
                Ok(json!({ "stopped": true }))
            }
            ControlCommand::RemoteCreateInvite {
                label,
                ports,
                role,
                allow_loan,
                ttl_secs,
            } => {
                require_local(&actor)?;
                let parsed_role = role.parse::<RemoteRole>()?;
                let ttl_ms = ttl_secs.map(|s| s.saturating_mul(1000));
                to_json(
                    self.create_invite(label, ports, parsed_role, allow_loan, ttl_ms)
                        .await?,
                )
            }
            ControlCommand::RemoteListClients => {
                require_local(&actor)?;
                to_json(self.list_clients().await?)
            }
            ControlCommand::RemoteRevokeClient { client_id } => {
                require_local(&actor)?;
                to_json(self.revoke_client(&client_id).await?)
            }
            other => self.dispatch_shared_command(other, actor).await,
        }
    }

    pub(crate) async fn dispatch_remote_command(
        self: &Arc<Self>,
        cmd: ControlCommand,
        actor: Actor,
    ) -> Result<Value, HostError> {
        match cmd {
            ControlCommand::RemoteStatus
            | ControlCommand::RemoteStart { .. }
            | ControlCommand::RemoteStop
            | ControlCommand::RemoteCreateInvite { .. }
            | ControlCommand::RemoteListClients
            | ControlCommand::RemoteRevokeClient { .. } => Err(HostError::new(
                "forbidden",
                "remote management commands are only allowed over local IPC",
            )),
            other => self.dispatch_shared_command(other, actor).await,
        }
    }

    async fn dispatch_shared_command(
        self: &Arc<Self>,
        cmd: ControlCommand,
        actor: Actor,
    ) -> Result<Value, HostError> {
        match cmd {
            ControlCommand::Hello => Ok(json!({
                "protocol": PROTOCOL_VERSION,
                "hostId": self.host_id,
                "localEndpoint": self.endpoint_name,
                "features": {
                    "portLease": true,
                    "remoteTls": true,
                    "notes": true,
                }
            })),
            ControlCommand::HostInfo => {
                let status = self.collaboration_status(Some(&actor)).await;
                to_json(status)
            }
            ControlCommand::Ports => {
                let ports = self.snapshot_ports(&actor).await?;
                to_json(ports)
            }
            ControlCommand::Status { port_id } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    actor.check_access(Access::Observe, Some(local_id))?;
                    let port = self.snapshot_single_port(local_id).await?;
                    to_json(port)
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    namespaced_port_id,
                } => {
                    let val = self
                        .forward_to_remote(
                            profile_id,
                            ControlCommand::Status {
                                port_id: remote_port_id.to_string(),
                            },
                        )
                        .await?;
                    let snapshot: PortSnapshotDto = from_json(val)?;
                    to_json(rewrite_namespaced_snapshot(snapshot, &namespaced_port_id))
                }
            },
            ControlCommand::Open {
                port_id,
                params,
                host_id,
                expected_generation,
            } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    self.check_host_id(host_id.as_deref())?;
                    actor.check_access(Access::Control, Some(local_id))?;
                    self.handle_open(local_id, params, expected_generation).await
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    namespaced_port_id,
                } => {
                    let val = self
                        .forward_to_remote(
                            profile_id,
                            ControlCommand::Open {
                                port_id: remote_port_id.to_string(),
                                params,
                                host_id,
                                expected_generation,
                            },
                        )
                        .await?;
                    let snapshot: PortSnapshotDto = from_json(val)?;
                    to_json(rewrite_namespaced_snapshot(snapshot, &namespaced_port_id))
                }
            },
            ControlCommand::Close {
                port_id,
                host_id,
                expected_generation,
            } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    self.check_host_id(host_id.as_deref())?;
                    actor.check_access(Access::Control, Some(local_id))?;
                    self.handle_close(local_id, expected_generation).await
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    namespaced_port_id,
                } => {
                    let val = self
                        .forward_to_remote(
                            profile_id,
                            ControlCommand::Close {
                                port_id: remote_port_id.to_string(),
                                host_id,
                                expected_generation,
                            },
                        )
                        .await?;
                    let snapshot: PortSnapshotDto = from_json(val)?;
                    to_json(rewrite_namespaced_snapshot(snapshot, &namespaced_port_id))
                }
            },
            ControlCommand::SetParams {
                port_id,
                params,
                expected_generation,
            } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    actor.check_access(Access::Control, Some(local_id))?;
                    self.handle_set_params(local_id, params, expected_generation)
                        .await
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    namespaced_port_id,
                } => {
                    let val = self
                        .forward_to_remote(
                            profile_id,
                            ControlCommand::SetParams {
                                port_id: remote_port_id.to_string(),
                                params,
                                expected_generation,
                            },
                        )
                        .await?;
                    let snapshot: PortSnapshotDto = from_json(val)?;
                    to_json(rewrite_namespaced_snapshot(snapshot, &namespaced_port_id))
                }
            },
            ControlCommand::SetFlowControl {
                port_id,
                dtr,
                rts,
                expected_generation,
            } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    actor.check_access(Access::Control, Some(local_id))?;
                    self.handle_set_flow_control(local_id, dtr, rts, expected_generation)
                        .await
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    namespaced_port_id,
                } => {
                    let val = self
                        .forward_to_remote(
                            profile_id,
                            ControlCommand::SetFlowControl {
                                port_id: remote_port_id.to_string(),
                                dtr,
                                rts,
                                expected_generation,
                            },
                        )
                        .await?;
                    let snapshot: PortSnapshotDto = from_json(val)?;
                    to_json(rewrite_namespaced_snapshot(snapshot, &namespaced_port_id))
                }
            },
            ControlCommand::Send {
                port_id,
                data_base64,
                source,
                expected_generation,
            } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    actor.check_access(Access::Write, Some(local_id))?;
                    self.handle_send(local_id, &data_base64, source, expected_generation, &actor)
                        .await
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    ..
                } => {
                    self.forward_to_remote(
                        profile_id,
                        ControlCommand::Send {
                            port_id: remote_port_id.to_string(),
                            data_base64,
                            source,
                            expected_generation,
                        },
                    )
                    .await
                }
            },
            ControlCommand::Request {
                port_id,
                data_base64,
                expect,
                timeout_ms,
                source,
                expected_generation,
            } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    actor.check_access(Access::Write, Some(local_id))?;
                    self.handle_request(
                        local_id,
                        &data_base64,
                        expect,
                        timeout_ms,
                        source,
                        expected_generation,
                        &actor,
                    )
                    .await
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    ..
                } => {
                    self.forward_to_remote(
                        profile_id,
                        ControlCommand::Request {
                            port_id: remote_port_id.to_string(),
                            data_base64,
                            expect,
                            timeout_ms,
                            source,
                            expected_generation,
                        },
                    )
                    .await
                }
            },
            ControlCommand::PollEvents {
                port_id,
                after_seq,
                recent,
                wait_ms,
                limit,
            } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    actor.check_access(Access::Observe, Some(local_id))?;
                    self.handle_poll_events(local_id, after_seq, recent, wait_ms, limit)
                        .await
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    namespaced_port_id,
                } => {
                    let val = self
                        .forward_to_remote(
                            profile_id,
                            ControlCommand::PollEvents {
                                port_id: remote_port_id.to_string(),
                                after_seq,
                                recent,
                                wait_ms,
                                limit,
                            },
                        )
                        .await?;
                    let page: EventPageDto = from_json(val)?;
                    to_json(rewrite_namespaced_event_page(page, &namespaced_port_id))
                }
            },
            ControlCommand::AddNote {
                port_id,
                text,
                source,
            } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    actor.check_access(Access::Write, Some(local_id))?;
                    self.handle_add_note(local_id, text, source, &actor)
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    namespaced_port_id,
                } => {
                    let val = self
                        .forward_to_remote(
                            profile_id,
                            ControlCommand::AddNote {
                                port_id: remote_port_id.to_string(),
                                text,
                                source,
                            },
                        )
                        .await?;
                    let ev: StreamEventDto = from_json(val)?;
                    to_json(rewrite_namespaced_stream_event(ev, &namespaced_port_id))
                }
            },
            ControlCommand::AcquireLoan {
                port_id,
                holder,
                reason,
                ttl_ms,
                auto_reopen,
                connection_bound,
                expected_generation,
            } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    actor.check_access(Access::Loan, Some(local_id))?;
                    self.handle_acquire_loan(
                        local_id,
                        holder,
                        reason,
                        ttl_ms,
                        auto_reopen,
                        connection_bound,
                        expected_generation,
                        &actor,
                    )
                    .await
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    namespaced_port_id,
                } => {
                    let val = self
                        .forward_to_remote(
                            profile_id,
                            ControlCommand::AcquireLoan {
                                port_id: remote_port_id.to_string(),
                                holder,
                                reason,
                                ttl_ms,
                                auto_reopen,
                                connection_bound,
                                expected_generation,
                            },
                        )
                        .await?;
                    let loan: LoanInfoDto = from_json(val)?;
                    if let Ok(mut leases) = self.remote_leases.lock() {
                        leases.insert(
                            loan.lease_id.clone(),
                            RemoteLeaseTrack {
                                profile_id: profile_id.to_string(),
                                namespaced_port_id: namespaced_port_id.clone(),
                                conn_owner: actor.conn_owner().to_string(),
                                connection_bound: loan.connection_bound,
                            },
                        );
                    }
                    to_json(rewrite_namespaced_loan(loan, &namespaced_port_id))
                }
            },
            ControlCommand::HeartbeatLoan {
                lease_id,
                extend_ttl_ms,
            } => {
                self.handle_heartbeat_loan(&lease_id, extend_ttl_ms, &actor)
                    .await
            }
            ControlCommand::ReleaseLoan {
                lease_id,
                reopen_override,
            } => {
                self.handle_release_loan(&lease_id, reopen_override, &actor)
                    .await
            }
            ControlCommand::ReclaimLoan { port_id } => match resolve_target_port(&port_id, &actor)? {
                TargetPort::Local(local_id) => {
                    actor.check_access(Access::Control, Some(local_id))?;
                    let recovery = self.reclaim_loan_local(local_id).await?;
                    to_json(SerialRecoveryDto {
                        state: recovery.state,
                        error: recovery.error,
                    })
                }
                TargetPort::Remote {
                    profile_id,
                    port_id: remote_port_id,
                    ..
                } => {
                    self.forward_to_remote(
                        profile_id,
                        ControlCommand::ReclaimLoan {
                            port_id: remote_port_id.to_string(),
                        },
                    )
                    .await
                }
            },
            ControlCommand::ListLoans => {
                actor.check_access(Access::Observe, None)?;
                let mut loans = self.list_loans_for_actor(Some(&actor));
                if actor.is_local() {
                    if let Some(clients) = self.remote_clients() {
                        loans.extend(clients.list_connected_remote_loans());
                    }
                }
                to_json(loans)
            }
            ControlCommand::RemoteStatus
            | ControlCommand::RemoteStart { .. }
            | ControlCommand::RemoteStop
            | ControlCommand::RemoteCreateInvite { .. }
            | ControlCommand::RemoteListClients
            | ControlCommand::RemoteRevokeClient { .. } => Err(HostError::new(
                "forbidden",
                "remote management commands are only allowed over local IPC",
            )),
            ControlCommand::Pair { .. } | ControlCommand::Authenticate { .. } => Err(
                HostError::new("invalid_request", "unexpected authentication command"),
            ),
        }
    }

    fn check_host_id(&self, host_id: Option<&str>) -> Result<(), HostError> {
        if let Some(requested) = host_id {
            if requested != self.host_id {
                return Err(HostError::new(
                    "host_mismatch",
                    "hostId does not match this HyperCom instance",
                ));
            }
        }
        Ok(())
    }

    async fn snapshot_ports(&self, actor: &Actor) -> Result<Vec<PortSnapshotDto>, HostError> {
        let manager = Arc::clone(&self.serial_manager);
        let mut ports = tokio::task::spawn_blocking(move || serial::list_ports_blocking(&manager))
            .await
            .map_err(|err| HostError::new("host_unavailable", format!("list ports panicked: {err}")))?
            .map_err(|err| HostError::new("serial_error", err))?;

        let mgr = self
            .serial_manager
            .lock()
            .map_err(|err| HostError::new("host_unavailable", err))?;
        for active_id in mgr.active_port_ids() {
            if !ports.iter().any(|p| p.id == active_id) {
                let kind = serial::PortKind::of(&active_id);
                ports.push(serial::PortInfo::local(
                    active_id.clone(),
                    active_id,
                    if kind == serial::PortKind::Real {
                        "real".to_string()
                    } else {
                        "sim".to_string()
                    },
                    None,
                    None,
                ));
            }
        }
        let mut snapshots = Vec::new();
        for port in ports {
            if actor.check_access(Access::Observe, Some(&port.id)).is_err() {
                continue;
            }
            snapshots.push(self.build_snapshot(&mgr, &port));
        }
        drop(mgr);
        if actor.is_local() {
            if let Some(clients) = self.remote_clients() {
                snapshots.extend(clients.list_connected_remote_snapshots());
            }
        }
        Ok(snapshots)
    }

    async fn snapshot_single_port(&self, port_id: &str) -> Result<PortSnapshotDto, HostError> {
        let manager = Arc::clone(&self.serial_manager);
        let ports = tokio::task::spawn_blocking(move || serial::list_ports_blocking(&manager))
            .await
            .map_err(|err| HostError::new("host_unavailable", format!("list ports panicked: {err}")))?
            .map_err(|err| HostError::new("serial_error", err))?;

        let mgr = self
            .serial_manager
            .lock()
            .map_err(|err| HostError::new("host_unavailable", err))?;
        if let Some(found) = ports.iter().find(|p| p.id == port_id) {
            return Ok(self.build_snapshot(&mgr, found));
        }
        if mgr.status_generation(port_id).is_some()
            || mgr.get_last_params(port_id).is_some()
            || self.lease_registry.get_for_port(port_id).is_some()
        {
            let kind = serial::PortKind::of(port_id);
            let synthetic = serial::PortInfo::local(
                port_id.to_string(),
                port_id.to_string(),
                if kind == serial::PortKind::Real {
                    "real".to_string()
                } else {
                    "sim".to_string()
                },
                None,
                None,
            );
            return Ok(self.build_snapshot(&mgr, &synthetic));
        }
        Err(HostError::new("not_found", format!("port '{port_id}' not found")))
    }

    fn build_snapshot(&self, mgr: &SerialManager, port: &serial::PortInfo) -> PortSnapshotDto {
        let generation = mgr.status_generation(&port.id).unwrap_or(0);
        let loan_meta = self
            .lease_registry
            .get_for_port(&port.id)
            .or_else(|| mgr.active_loan_meta(&port.id));
        PortSnapshotDto {
            id: port.id.clone(),
            name: port.name.clone(),
            port_type: port.port_type.clone(),
            status: if mgr.connection_is_live(&port.id) {
                "connected".to_string()
            } else {
                "disconnected".to_string()
            },
            generation,
            baud_rate: mgr.get_last_params(&port.id).map(|p| p.baud_rate),
            manufacturer: port.manufacturer.clone(),
            product: port.product.clone(),
            loan: loan_meta.map(|m| loan_meta_to_dto(&port.id, generation, m)),
        }
    }

    async fn handle_open(
        &self,
        port_id: &str,
        params: Option<SerialParamsDto>,
        expected_generation: Option<u64>,
    ) -> Result<Value, HostError> {
        let manager = Arc::clone(&self.serial_manager);
        let pid = port_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), HostError> {
            let (args, expected, cancel) = {
                let mut mgr = manager
                    .lock()
                    .map_err(|err| HostError::new("host_unavailable", err))?;
                if let Some(expected) = expected_generation {
                    mgr.check_control_generation(&pid, expected)
                        .map_err(|err| HostError::new("generation_changed", err))?;
                }
                if mgr.connection_is_live(&pid) {
                    return Ok(());
                }
                let args = resolve_open_args(&pid, params, mgr.get_last_params(&pid))?;
                let expected = expected_generation.unwrap_or_else(|| mgr.status_generation(&pid).unwrap_or(0));
                let cancel = mgr.begin_reconnect(&pid);
                (args, expected, cancel)
            };

            let outcome = if expected_generation.is_some() {
                serial::open_blocking_authorized(&manager, args, expected, &cancel, || Ok(()))
                    .map(|_| ())
            } else {
                serial::open_blocking(&manager, args)
            };

            if let Ok(mut mgr) = manager.lock() {
                mgr.finish_reconnect(&pid, &cancel);
            }
            outcome.map_err(|err| {
                let msg = err.to_string();
                if msg.contains("generation changed") {
                    HostError::new("generation_changed", msg)
                } else if msg.contains("occupied by a tool") {
                    HostError::new("port_loaned", msg)
                } else {
                    HostError::new("serial_error", msg)
                }
            })
        })
        .await
        .map_err(|err| HostError::new("host_unavailable", format!("open task panicked: {err}")))??;

        let snapshot = self.snapshot_single_port(port_id).await?;
        to_json(snapshot)
    }

    async fn handle_close(
        &self,
        port_id: &str,
        expected_generation: Option<u64>,
    ) -> Result<Value, HostError> {
        let close = {
            let mut mgr = self
                .serial_manager
                .lock()
                .map_err(|err| HostError::new("host_unavailable", err))?;
            match expected_generation {
                Some(expected) => mgr
                    .close_port_cas(port_id, expected)
                    .map_err(|err| HostError::new("generation_changed", err))?,
                None => mgr
                    .close_port(port_id)
                    .map_err(|err| HostError::new("serial_error", err))?,
            }
        };
        if let Some(close) = close {
            tokio::task::spawn_blocking(move || {
                let _ = close.join();
            })
            .await
            .map_err(|err| {
                HostError::new("host_unavailable", format!("close join panicked: {err}"))
            })?;
        }
        if let Ok(mut mgr) = self.serial_manager.lock() {
            mgr.cleanup_real_close(port_id);
        }
        let snapshot = self.snapshot_single_port(port_id).await?;
        to_json(snapshot)
    }

    async fn handle_set_params(
        &self,
        port_id: &str,
        params: SerialParamsDto,
        expected_generation: Option<u64>,
    ) -> Result<Value, HostError> {
        let args = resolve_open_args(port_id, Some(params), None)?;
        let manager = Arc::clone(&self.serial_manager);
        let pid = port_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), HostError> {
            let mut mgr = manager
                .lock()
                .map_err(|err| HostError::new("host_unavailable", err))?;
            if let Some(expected) = expected_generation {
                mgr.check_control_generation(&pid, expected)
                    .map_err(|err| HostError::new("generation_changed", err))?;
            }
            mgr.set_params(
                &pid,
                args.baud_rate,
                args.data_bits,
                &args.parity,
                &args.stop_bits,
                &args.handshake,
            )
            .map_err(|err| HostError::new("serial_error", err))
        })
        .await
        .map_err(|err| {
            HostError::new("host_unavailable", format!("set_params task panicked: {err}"))
        })??;

        let snapshot = self.snapshot_single_port(port_id).await?;
        to_json(snapshot)
    }

    async fn handle_set_flow_control(
        &self,
        port_id: &str,
        dtr: bool,
        rts: bool,
        expected_generation: Option<u64>,
    ) -> Result<Value, HostError> {
        let manager = Arc::clone(&self.serial_manager);
        let pid = port_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), HostError> {
            let mut mgr = manager
                .lock()
                .map_err(|err| HostError::new("host_unavailable", err))?;
            mgr.set_flow_control(&pid, dtr, rts, expected_generation)
                .map_err(|err| {
                    let msg = err.to_string();
                    if msg.contains("generation") || msg.contains("changed") {
                        HostError::new("generation_changed", msg)
                    } else {
                        HostError::new("serial_error", msg)
                    }
                })
        })
        .await
        .map_err(|err| {
            HostError::new(
                "host_unavailable",
                format!("set_flow_control task panicked: {err}"),
            )
        })??;

        let snapshot = self.snapshot_single_port(port_id).await?;
        to_json(snapshot)
    }

    async fn handle_send(
        &self,
        port_id: &str,
        data_base64: &str,
        source: Option<String>,
        expected_generation: Option<u64>,
        actor: &Actor,
    ) -> Result<Value, HostError> {
        let bytes = decode_tx_bytes(data_base64)?;
        let effective_source = normalize_source(source, actor);
        let (written, generation, seq) = self
            .write_and_record_tx(port_id, bytes, Some(effective_source), expected_generation)
            .await?;
        Ok(json!({
            "bytesWritten": written,
            "generation": generation,
            "seq": seq,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn handle_request(
        &self,
        port_id: &str,
        data_base64: &str,
        expect: ExpectSpec,
        timeout_ms: u64,
        source: Option<String>,
        expected_generation: Option<u64>,
        actor: &Actor,
    ) -> Result<Value, HostError> {
        if timeout_ms == 0 || timeout_ms > MAX_EXPECT_MS {
            return Err(HostError::new(
                "invalid_request",
                format!("timeoutMs must be 1–{MAX_EXPECT_MS}"),
            ));
        }
        let bytes = decode_tx_bytes(data_base64)?;
        let mut matcher = ExpectMatcher::from_spec(&expect, true)?;

        // Pre-register before writing so fast responses can never race ahead of the listener.
        let mut sub = self.event_hub.subscribe();
        let mut last_seq = self.event_hub.latest_seq(port_id);

        let effective_source = normalize_source(source, actor);
        let (bytes_written, generation, _) = self
            .write_and_record_tx(port_id, bytes, Some(effective_source), expected_generation)
            .await?;

        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let page = self.event_hub.poll(port_id, Some(last_seq), None, 256);
            for ev in page.events {
                if ev.seq > last_seq {
                    last_seq = ev.seq;
                }
                if let Some(outcome) = feed_rx_event(&mut matcher, &ev, generation, bytes_written) {
                    return to_json(outcome);
                }
            }

            if tokio::time::Instant::now() >= deadline {
                return to_json(RequestOutcomeDto {
                    bytes_written,
                    matched: false,
                    matched_base64: None,
                    matched_text: None,
                    seq: None,
                });
            }

            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    return to_json(RequestOutcomeDto {
                        bytes_written,
                        matched: false,
                        matched_base64: None,
                        matched_text: None,
                        seq: None,
                    });
                }
                recv = sub.recv() => {
                    match recv {
                        Ok(ev) => {
                            if ev.port_id == port_id && ev.seq > last_seq {
                                last_seq = ev.seq;
                                if let Some(outcome) = feed_rx_event(&mut matcher, &ev, generation, bytes_written) {
                                    return to_json(outcome);
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Top of loop catches up via `event_hub.poll`.
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            return to_json(RequestOutcomeDto {
                                bytes_written,
                                matched: false,
                                matched_base64: None,
                                matched_text: None,
                                seq: None,
                            });
                        }
                    }
                }
            }
        }
    }

    async fn write_and_record_tx(
        &self,
        port_id: &str,
        bytes: Vec<u8>,
        source: Option<String>,
        expected_generation: Option<u64>,
    ) -> Result<(usize, u64, Option<u64>), HostError> {
        let (written, generation) =
            write_raw_to_port(&self.serial_manager, port_id, &bytes, expected_generation).await?;

        if written == 0 {
            return Ok((0, generation, None));
        }

        let sent_slice = &bytes[..written];
        let local_ts = chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string();
        if let Err(err) = self.log_manager.write(port_id, &local_ts, "TX", sent_slice) {
            log::warn!("Failed to write control TX log for {}: {}", port_id, err);
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        let ev = self
            .event_hub
            .publish_tx(port_id, generation, now_ms, sent_slice, source.clone());
        self.emit_external_tx(port_id, now_ms, generation, sent_slice, source.as_deref());
        Ok((written, generation, Some(ev.seq)))
    }

    async fn handle_poll_events(
        &self,
        port_id: &str,
        after_seq: Option<u64>,
        recent: Option<usize>,
        wait_ms: u64,
        limit: Option<usize>,
    ) -> Result<Value, HostError> {
        let clamped_limit = limit.unwrap_or(256).clamp(1, 1024);
        let page = if after_seq.is_none() && recent.is_some() {
            self.event_hub.poll(port_id, None, recent, clamped_limit)
        } else {
            self.event_hub
                .wait_for_events(port_id, after_seq, wait_ms.min(MAX_POLL_MS), clamped_limit)
                .await
        };
        let generation = self
            .serial_manager
            .lock()
            .ok()
            .and_then(|mgr| mgr.status_generation(port_id))
            .unwrap_or(0);
        let dto = EventPageDto {
            host_id: self.host_id.clone(),
            port_id: page.port_id,
            generation,
            latest_seq: page.latest_seq,
            next_seq: page.next_seq,
            gap: page.gap,
            events: page.events.into_iter().map(hub_event_to_dto).collect(),
        };
        to_json(dto)
    }

    fn handle_add_note(
        &self,
        port_id: &str,
        text: String,
        source: Option<String>,
        actor: &Actor,
    ) -> Result<Value, HostError> {
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed.len() > MAX_NOTE_BYTES {
            return Err(HostError::new(
                "invalid_request",
                format!("note text must be 1–{MAX_NOTE_BYTES} bytes"),
            ));
        }
        let generation = self
            .serial_manager
            .lock()
            .ok()
            .and_then(|mgr| mgr.status_generation(port_id))
            .unwrap_or(0);
        let now_ms = chrono::Utc::now().timestamp_millis();
        let effective_source = normalize_source(source, actor);
        let ev = self.event_hub.publish_note(
            port_id,
            generation,
            now_ms,
            trimmed.to_string(),
            Some(effective_source.clone()),
        );
        self.emit_note(port_id, trimmed, Some(&effective_source), now_ms, generation);
        to_json(hub_event_to_dto((*ev).clone()))
    }

    #[allow(clippy::too_many_arguments)]
    async fn handle_acquire_loan(
        &self,
        port_id: &str,
        holder: String,
        reason: Option<String>,
        ttl_ms: Option<u64>,
        auto_reopen: Option<bool>,
        connection_bound: Option<bool>,
        expected_generation: Option<u64>,
        actor: &Actor,
    ) -> Result<Value, HostError> {
        let holder_trimmed = holder.trim().to_string();
        if holder_trimmed.is_empty() || holder_trimmed.len() > 128 {
            return Err(HostError::new(
                "invalid_request",
                "loan holder must be 1–128 characters",
            ));
        }
        let connection_bound = connection_bound.unwrap_or(false);
        let auto_reopen = auto_reopen.unwrap_or(true);
        let owner_tag = if connection_bound {
            actor.conn_owner().to_string()
        } else {
            format!("detached:{}", Uuid::new_v4())
        };

        let meta = self
            .lease_registry
            .acquire(
                &self.serial_manager,
                Some(&self.event_hub),
                AcquireLeaseRequest {
                    port_id: port_id.to_string(),
                    holder: holder_trimmed,
                    reason,
                    expected_generation,
                    ttl_ms,
                    auto_reopen,
                    owner_tag,
                    connection_bound,
                },
            )
            .await
            .map_err(map_lease_error)?;

        let generation = self
            .serial_manager
            .lock()
            .ok()
            .and_then(|mgr| mgr.status_generation(port_id))
            .unwrap_or(0);
        let note_text = match &meta.reason {
            Some(reason) if !reason.trim().is_empty() => {
                format!("[协作] {} 已借用 {}（{}）", meta.holder, port_id, reason.trim())
            }
            _ => format!("[协作] {} 已借用 {}", meta.holder, port_id),
        };
        self.emit_note(
            port_id,
            &note_text,
            Some(&meta.holder),
            meta.acquired_at_ms,
            generation,
        );
        to_json(loan_meta_to_dto(port_id, generation, meta))
    }

    async fn handle_heartbeat_loan(
        &self,
        lease_id: &str,
        extend_ttl_ms: Option<u64>,
        actor: &Actor,
    ) -> Result<Value, HostError> {
        if let Some((port_id, generation, _, _)) = self.lease_registry.get_entry(lease_id) {
            actor.check_access(Access::Loan, Some(&port_id))?;
            let meta = self
                .lease_registry
                .heartbeat(&self.serial_manager, lease_id, extend_ttl_ms)
                .map_err(map_lease_error)?;
            return to_json(loan_meta_to_dto(&port_id, generation, meta));
        }

        if actor.is_local() {
            let track = self
                .remote_leases
                .lock()
                .ok()
                .and_then(|map| map.get(lease_id).cloned());
            if let Some(track) = track {
                match self
                    .forward_to_remote(
                        &track.profile_id,
                        ControlCommand::HeartbeatLoan {
                            lease_id: lease_id.to_string(),
                            extend_ttl_ms,
                        },
                    )
                    .await
                {
                    Ok(val) => {
                        let loan: LoanInfoDto = from_json(val)?;
                        return to_json(rewrite_namespaced_loan(loan, &track.namespaced_port_id));
                    }
                    Err(err) => {
                        if err.code == "not_found" {
                            if let Ok(mut leases) = self.remote_leases.lock() {
                                leases.remove(lease_id);
                            }
                        }
                        return Err(err);
                    }
                }
            }
        }

        actor.check_access(Access::Loan, None)?;
        Err(HostError::new(
            "not_found",
            format!("lease not found: {lease_id}"),
        ))
    }

    async fn handle_release_loan(
        &self,
        lease_id: &str,
        reopen_override: Option<bool>,
        actor: &Actor,
    ) -> Result<Value, HostError> {
        if let Some((port_id, generation, meta, _)) = self.lease_registry.get_entry(lease_id) {
            actor.check_access(Access::Loan, Some(&port_id))?;
            let recovery = self
                .lease_registry
                .release(Some(&self.event_hub), lease_id, reopen_override)
                .await
                .map_err(map_lease_error)?;
            let note_text = format!("[协作] 已归还 {} ({})", port_id, recovery.state);
            self.emit_note(
                &port_id,
                &note_text,
                Some(&meta.holder),
                chrono::Utc::now().timestamp_millis(),
                generation,
            );
            return to_json(SerialRecoveryDto {
                state: recovery.state,
                error: recovery.error,
            });
        }

        if actor.is_local() {
            let track = self
                .remote_leases
                .lock()
                .ok()
                .and_then(|mut map| map.remove(lease_id));
            if let Some(track) = track {
                return self
                    .forward_to_remote(
                        &track.profile_id,
                        ControlCommand::ReleaseLoan {
                            lease_id: lease_id.to_string(),
                            reopen_override,
                        },
                    )
                    .await;
            }
        }

        actor.check_access(Access::Loan, None)?;
        Err(HostError::new(
            "not_found",
            format!("lease not found: {lease_id}"),
        ))
    }

    async fn forward_to_remote(
        &self,
        profile_id: &str,
        cmd: ControlCommand,
    ) -> Result<Value, HostError> {
        let clients = self.remote_clients().ok_or_else(|| {
            HostError::new(
                "remote_not_connected",
                format!("remote host '{profile_id}' is not connected"),
            )
        })?;
        clients.forward_command(profile_id, cmd).await
    }

    pub(crate) async fn release_remote_leases_by_owner(&self, conn_owner: &str) {
        let to_release: Vec<(String, String)> = {
            let Ok(mut leases) = self.remote_leases.lock() else {
                return;
            };
            let ids: Vec<String> = leases
                .iter()
                .filter(|(_, track)| track.connection_bound && track.conn_owner == conn_owner)
                .map(|(lease_id, _)| lease_id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| leases.remove(&id).map(|track| (id, track.profile_id)))
                .collect()
        };
        if to_release.is_empty() {
            return;
        }
        let Some(clients) = self.remote_clients() else {
            return;
        };
        for (lease_id, profile_id) in to_release {
            if let Err(err) = clients
                .forward_command(
                    &profile_id,
                    ControlCommand::ReleaseLoan {
                        lease_id: lease_id.clone(),
                        reopen_override: None,
                    },
                )
                .await
            {
                log::warn!(
                    "Failed to release connection-bound remote lease '{}' on '{}': {}",
                    lease_id,
                    profile_id,
                    err
                );
            }
        }
    }
}

enum TargetPort<'a> {
    Local(&'a str),
    Remote {
        profile_id: &'a str,
        port_id: &'a str,
        namespaced_port_id: String,
    },
}

fn resolve_target_port<'a>(port_id: &'a str, actor: &Actor) -> Result<TargetPort<'a>, HostError> {
    validate_port_id(port_id)?;
    match PortRef::parse(port_id)? {
        PortRef::Local(local_id) => Ok(TargetPort::Local(local_id)),
        PortRef::Remote {
            profile_id,
            port_id: remote_port_id,
        } => {
            if !actor.is_local() {
                return Err(HostError::new(
                    "forbidden",
                    "remote clients cannot proxy to other remote hosts",
                ));
            }
            let namespaced_port_id = PortRef::format_remote(profile_id, remote_port_id)?;
            Ok(TargetPort::Remote {
                profile_id,
                port_id: remote_port_id,
                namespaced_port_id,
            })
        }
    }
}

pub(crate) fn rewrite_namespaced_loan(
    mut loan: LoanInfoDto,
    namespaced_port_id: &str,
) -> LoanInfoDto {
    loan.port_id = namespaced_port_id.to_string();
    loan
}

pub(crate) fn rewrite_namespaced_snapshot(
    mut snapshot: PortSnapshotDto,
    namespaced_port_id: &str,
) -> PortSnapshotDto {
    snapshot.id = namespaced_port_id.to_string();
    if let Some(loan) = snapshot.loan {
        snapshot.loan = Some(rewrite_namespaced_loan(loan, namespaced_port_id));
    }
    snapshot
}

pub(crate) fn rewrite_namespaced_stream_event(
    mut event: StreamEventDto,
    namespaced_port_id: &str,
) -> StreamEventDto {
    event.port_id = namespaced_port_id.to_string();
    if let Some(loan) = event.loan {
        event.loan = Some(rewrite_namespaced_loan(loan, namespaced_port_id));
    }
    event
}

pub(crate) fn rewrite_namespaced_event_page(
    mut page: EventPageDto,
    namespaced_port_id: &str,
) -> EventPageDto {
    page.port_id = namespaced_port_id.to_string();
    page.events = page
        .events
        .into_iter()
        .map(|ev| rewrite_namespaced_stream_event(ev, namespaced_port_id))
        .collect();
    page
}

fn require_local(actor: &Actor) -> Result<(), HostError> {
    if actor.is_local() {
        Ok(())
    } else {
        Err(HostError::new(
            "forbidden",
            "remote management commands are only allowed over local IPC",
        ))
    }
}

fn validate_port_id(port_id: &str) -> Result<(), HostError> {
    if port_id.is_empty() || port_id.contains('\0') {
        return Err(HostError::new(
            "invalid_request",
            "portId must be non-empty and cannot contain NUL",
        ));
    }
    Ok(())
}

fn normalize_source(source: Option<String>, actor: &Actor) -> String {
    source
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| actor.default_source())
}

fn decode_tx_bytes(data_base64: &str) -> Result<Vec<u8>, HostError> {
    let bytes = STANDARD.decode(data_base64).map_err(|_| {
        HostError::new("invalid_request", "dataBase64 is not valid base64")
    })?;
    if bytes.is_empty() || bytes.len() > MAX_WRITE_BYTES {
        return Err(HostError::new(
            "invalid_request",
            format!("TX payload must be 1–{MAX_WRITE_BYTES} bytes"),
        ));
    }
    Ok(bytes)
}

fn feed_rx_event(
    matcher: &mut ExpectMatcher,
    ev: &HubEvent,
    expected_generation: u64,
    bytes_written: usize,
) -> Option<RequestOutcomeDto> {
    if ev.generation != expected_generation || ev.kind != HubEventKind::Rx {
        return None;
    }
    matcher.feed(&ev.data);
    matcher.matched().map(|matched| RequestOutcomeDto {
        bytes_written,
        matched: true,
        matched_base64: Some(STANDARD.encode(matched)),
        matched_text: Some(String::from_utf8_lossy(matched).into_owned()),
        seq: Some(ev.seq),
    })
}

fn hub_event_to_dto(ev: HubEvent) -> StreamEventDto {
    let port_id = ev.port_id;
    let generation = ev.generation;
    let kind = match ev.kind {
        HubEventKind::Rx => "rx",
        HubEventKind::Tx => "tx",
        HubEventKind::Status => "status",
        HubEventKind::Loan => "loan",
        HubEventKind::Note => "note",
    }
    .to_string();
    StreamEventDto {
        seq: ev.seq,
        port_id: port_id.clone(),
        generation,
        timestamp_ms: ev.timestamp_ms,
        kind,
        data_base64: (!ev.data.is_empty()).then(|| STANDARD.encode(&ev.data)),
        text: ev.text,
        status: ev.status,
        source: ev.source,
        loan: ev.loan.map(|m| loan_meta_to_dto(&port_id, generation, m)),
    }
}

pub(crate) fn resolve_open_args(
    port_id: &str,
    params: Option<SerialParamsDto>,
    previous: Option<OpenPortArgs>,
) -> Result<OpenPortArgs, HostError> {
    let Some(dto) = params else {
        if let Some(mut prev) = previous {
            prev.port_id = port_id.to_string();
            return Ok(prev);
        }
        return resolve_open_args(port_id, Some(SerialParamsDto::default()), None);
    };

    if dto.baud_rate == 0 {
        return Err(HostError::new(
            "invalid_request",
            "baudRate must be greater than zero",
        ));
    }
    if !(5..=8).contains(&dto.data_bits) {
        return Err(HostError::new(
            "invalid_request",
            "dataBits must be 5, 6, 7, or 8",
        ));
    }
    let parity = match dto.parity.trim().to_ascii_lowercase().as_str() {
        "none" => "None",
        "even" => "Even",
        "odd" => "Odd",
        _ => {
            return Err(HostError::new(
                "invalid_request",
                "parity must be none, even, or odd",
            ))
        }
    };
    let stop_bits = match dto.stop_bits.trim().to_ascii_lowercase().as_str() {
        "one" | "1" => "One",
        "two" | "2" => "Two",
        _ => {
            return Err(HostError::new(
                "invalid_request",
                "stopBits must be one or two",
            ))
        }
    };
    let handshake = match dto.handshake.trim().to_ascii_lowercase().as_str() {
        "none" => "None",
        "xonxoff" | "xon_xoff" | "software" => "XonXoff",
        "requesttosend" | "request_to_send" | "rts" | "rtscts" | "hardware" => "RequestToSend",
        "requesttosendxonxoff" | "request_to_send_xon_xoff" => "RequestToSendXonXoff",
        _ => {
            return Err(HostError::new(
                "invalid_request",
                "handshake must be none, xonxoff, requestToSend, or requestToSendXonXoff",
            ))
        }
    };

    Ok(OpenPortArgs {
        port_id: port_id.to_string(),
        baud_rate: dto.baud_rate,
        data_bits: dto.data_bits,
        parity: parity.to_string(),
        stop_bits: stop_bits.to_string(),
        handshake: handshake.to_string(),
        dtr: dto.dtr,
        rts: dto.rts,
        cols: previous.as_ref().map_or(80, |p| p.cols),
        rows: previous.as_ref().map_or(24, |p| p.rows),
    })
}

async fn write_raw_to_port(
    serial_manager: &Arc<Mutex<SerialManager>>,
    port_id: &str,
    bytes: &[u8],
    expected_generation: Option<u64>,
) -> Result<(usize, u64), HostError> {
    let manager = Arc::clone(serial_manager);
    let pid = port_id.to_string();
    let payload = bytes.to_vec();
    tokio::task::spawn_blocking(move || {
        let mgr = manager
            .lock()
            .map_err(|err| HostError::new("host_unavailable", err))?;
        if let Some(expected) = expected_generation {
            mgr.check_control_generation(&pid, expected)
                .map_err(|err| HostError::new("generation_changed", err))?;
        }
        if !mgr.connection_is_live(&pid) {
            return Err(HostError::new(
                "not_connected",
                format!("port '{pid}' is not connected"),
            ));
        }
        let generation = mgr.status_generation(&pid).unwrap_or(0);
        let written = match serial::PortKind::of(&pid) {
            serial::PortKind::Real => {
                let write_port = mgr
                    .get_write_handle(&pid)
                    .map_err(|err| HostError::new("serial_error", err))?;
                drop(mgr);
                let mut port = write_port
                    .lock()
                    .map_err(|err| HostError::new("host_unavailable", err))?;
                serial::write_all_with_deadline(
                    &pid,
                    &mut **port,
                    &payload,
                    serial::WRITE_TOTAL_DEADLINE,
                )
                .map_err(|err| HostError::new("serial_error", err))?;
                payload.len()
            }
            serial::PortKind::Tty => {
                let writer = mgr
                    .get_tty_write_handle(&pid)
                    .map_err(|err| HostError::new("serial_error", err))?;
                drop(mgr);
                writer
                    .write(&payload)
                    .map_err(|err| HostError::new("serial_error", err))?
            }
            serial::PortKind::Sim => mgr
                .write_raw(&pid, &payload)
                .map_err(|err| HostError::new("serial_error", err))?,
        };
        Ok((written, generation))
    })
    .await
    .map_err(|err| HostError::new("host_unavailable", format!("write task panicked: {err}")))?
}

fn map_lease_error(err: String) -> HostError {
    if err.contains("not found") || err.contains("Not found") {
        HostError::new("not_found", err)
    } else if err.contains("generation changed") {
        HostError::new("generation_changed", err)
    } else if err.contains("already has an active lease") || err.contains("occupied by a tool") {
        HostError::new("port_loaned", err)
    } else if err.contains("cannot be leased") {
        HostError::new("invalid_request", err)
    } else {
        HostError::new("serial_error", err)
    }
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, HostError> {
    serde_json::to_value(value).map_err(|err| HostError::new("host_unavailable", err))
}

fn from_json<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, HostError> {
    serde_json::from_value(value).map_err(|err| {
        HostError::new(
            "host_unavailable",
            format!("unexpected remote response shape: {err}"),
        )
    })
}

#[cfg(test)]
mod pure_tests {
    use super::*;

    #[test]
    fn resolve_open_args_normalizes_protocol_case_and_rejects_invalid() {
        let args = resolve_open_args("COM3", Some(SerialParamsDto::default()), None).unwrap();
        assert_eq!(args.baud_rate, 115_200);
        assert_eq!(args.parity, "None");
        assert_eq!(args.stop_bits, "One");
        assert_eq!(args.handshake, "None");

        let mixed = SerialParamsDto {
            baud_rate: 9600,
            data_bits: 7,
            parity: "EVEN".into(),
            stop_bits: "2".into(),
            handshake: "hardware".into(),
            dtr: true,
            rts: false,
        };
        let resolved = resolve_open_args("COM4", Some(mixed), None).unwrap();
        assert_eq!(resolved.parity, "Even");
        assert_eq!(resolved.stop_bits, "Two");
        assert_eq!(resolved.handshake, "RequestToSend");

        let reused = resolve_open_args("COM4", None, Some(resolved.clone())).unwrap();
        assert_eq!(reused.baud_rate, 9600);

        let bad = SerialParamsDto {
            parity: "mark".into(),
            ..SerialParamsDto::default()
        };
        assert_eq!(
            resolve_open_args("COM3", Some(bad), None).unwrap_err().code,
            "invalid_request"
        );
    }

    #[test]
    fn local_actor_and_port_validation_work() {
        let local_actor = Actor::Local {
            conn_owner: "ipc:1".into(),
        };
        assert!(require_local(&local_actor).is_ok());
        assert!(local_actor.check_access(Access::Loan, Some("COM9")).is_ok());
        assert_eq!(local_actor.default_source(), "local");
        assert_eq!(local_actor.conn_owner(), "ipc:1");

        assert!(validate_port_id("COM3").is_ok());
        assert!(validate_port_id("").is_err());
        assert!(validate_port_id("COM3\0").is_err());
    }

    #[test]
    fn tx_decoding_expect_matching_and_event_dto_mapping_work() {
        assert_eq!(decode_tx_bytes("SGVsbG8=").unwrap(), b"Hello");
        assert!(decode_tx_bytes("").is_err());
        assert!(decode_tx_bytes("!!!not-base64!!!").is_err());

        let mut matcher =
            ExpectMatcher::from_spec(&ExpectSpec::Line { text: "OK".into() }, true).unwrap();
        let stale = HubEvent {
            seq: 1,
            port_id: "COM3".into(),
            generation: 1,
            timestamp_ms: 100,
            kind: HubEventKind::Rx,
            data: b"OK\r\n".to_vec(),
            text: None,
            status: None,
            source: None,
            loan: None,
        };
        assert!(feed_rx_event(&mut matcher, &stale, 2, 4).is_none());

        let live = HubEvent {
            seq: 2,
            generation: 2,
            ..stale
        };
        let outcome = feed_rx_event(&mut matcher, &live, 2, 4).unwrap();
        assert!(outcome.matched);
        assert_eq!(outcome.matched_text.as_deref(), Some("OK"));
        assert_eq!(outcome.seq, Some(2));

        let dto = hub_event_to_dto(HubEvent {
            seq: 5,
            port_id: "COM3".into(),
            generation: 2,
            timestamp_ms: 200,
            kind: HubEventKind::Note,
            data: Vec::new(),
            text: Some("flash done".into()),
            status: None,
            source: Some("cli".into()),
            loan: None,
        });
        assert_eq!(dto.kind, "note");
        assert_eq!(dto.text.as_deref(), Some("flash done"));
    }

    #[test]
    fn rewrite_namespaced_helpers_update_port_ids() {
        let namespaced = "remote::bench::COM7";
        let loan = LoanInfoDto {
            lease_id: "lease-1".into(),
            port_id: "COM7".into(),
            holder: "cli".into(),
            reason: Some("flash".into()),
            acquired_at_ms: 100,
            expires_at_ms: Some(200),
            generation: 4,
            auto_reopen: true,
            connection_bound: false,
        };
        let rewritten_loan = rewrite_namespaced_loan(loan.clone(), namespaced);
        assert_eq!(rewritten_loan.port_id, namespaced);
        assert_eq!(rewritten_loan.lease_id, "lease-1");

        let snapshot = PortSnapshotDto {
            id: "COM7".into(),
            name: "COM7".into(),
            port_type: "real".into(),
            status: "connected".into(),
            generation: 4,
            baud_rate: Some(115_200),
            manufacturer: None,
            product: None,
            loan: Some(loan.clone()),
        };
        let rewritten_snapshot = rewrite_namespaced_snapshot(snapshot, namespaced);
        assert_eq!(rewritten_snapshot.id, namespaced);
        assert_eq!(
            rewritten_snapshot.loan.as_ref().unwrap().port_id,
            namespaced
        );

        let page = EventPageDto {
            host_id: "host-remote".into(),
            port_id: "COM7".into(),
            generation: 4,
            latest_seq: 10,
            next_seq: 11,
            gap: false,
            events: vec![
                StreamEventDto {
                    seq: 9,
                    port_id: "COM7".into(),
                    generation: 4,
                    timestamp_ms: 1000,
                    kind: "rx".into(),
                    data_base64: Some("T0s=".into()),
                    text: None,
                    status: None,
                    source: None,
                    loan: None,
                },
                StreamEventDto {
                    seq: 10,
                    port_id: "COM7".into(),
                    generation: 4,
                    timestamp_ms: 1001,
                    kind: "loan".into(),
                    data_base64: None,
                    text: None,
                    status: Some("active".into()),
                    source: None,
                    loan: Some(loan),
                },
            ],
        };
        let rewritten_page = rewrite_namespaced_event_page(page, namespaced);
        assert_eq!(rewritten_page.port_id, namespaced);
        assert_eq!(rewritten_page.events[0].port_id, namespaced);
        assert_eq!(rewritten_page.events[1].port_id, namespaced);
        assert_eq!(
            rewritten_page.events[1].loan.as_ref().unwrap().port_id,
            namespaced
        );
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use crate::logger::LogManager;
    use crate::serial::{PortLeaseRegistry, SerialEventHub, SerialManager};
    use hypercom_protocol::{Authority, RemotePermissions};

    #[tokio::test]
    async fn remote_actor_is_forbidden_from_proxying_to_remote_ports() {
        let dir = std::env::temp_dir().join(format!("hc-proxy-deny-{}", Uuid::new_v4()));
        let auth = Authority::open(&dir, "127.0.0.1:8443".into()).unwrap();
        let invite = auth
            .invite(
                "remote-caller".into(),
                RemotePermissions {
                    role: RemoteRole::Control,
                    ports: vec!["*".into()],
                    allow_loan: true,
                    automation: false,
                    device_plugins: false,
                    device_tools: false,
                },
                None,
            )
            .unwrap();
        let profile = auth.pair(&invite.code).unwrap();
        let peer = auth.authenticate(&profile.client_id, &profile.token).unwrap();
        let actor = Actor::Remote {
            peer,
            conn_owner: format!("remote:{}:test", profile.client_id),
        };

        let hub = Arc::new(ControlHub::new(
            Arc::new(Mutex::new(SerialManager::new())),
            Arc::new(SerialEventHub::new()),
            Arc::new(PortLeaseRegistry::new()),
            Arc::new(LogManager::new()),
            dir.join("hub"),
        ));

        let cmds = [
            ControlCommand::Status {
                port_id: "remote::bench::COM3".into(),
            },
            ControlCommand::Open {
                port_id: "remote::bench::COM3".into(),
                params: None,
                host_id: None,
                expected_generation: None,
            },
            ControlCommand::Send {
                port_id: "remote::bench::COM3".into(),
                data_base64: "QQ==".into(),
                source: None,
                expected_generation: None,
            },
            ControlCommand::PollEvents {
                port_id: "remote::bench::COM3".into(),
                after_seq: None,
                recent: Some(10),
                wait_ms: 0,
                limit: None,
            },
            ControlCommand::AddNote {
                port_id: "remote::bench::COM3".into(),
                text: "hi".into(),
                source: None,
            },
            ControlCommand::AcquireLoan {
                port_id: "remote::bench::COM3".into(),
                holder: "attacker".into(),
                reason: None,
                ttl_ms: None,
                auto_reopen: None,
                connection_bound: None,
                expected_generation: None,
            },
            ControlCommand::ReclaimLoan {
                port_id: "remote::bench::COM3".into(),
            },
        ];

        for cmd in cmds {
            let err = hub
                .dispatch_remote_command(cmd, actor.clone())
                .await
                .unwrap_err();
            assert_eq!(err.code, "forbidden");
            assert!(err.message.contains("proxy"));
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn actor_enforces_local_vs_remote_role_and_port_scope() {
        let dir = std::env::temp_dir().join(format!("hc-actor-test-{}", Uuid::new_v4()));
        let auth = Authority::open(&dir, "127.0.0.1:8443".into()).unwrap();
        let invite = auth
            .invite(
                "observer".into(),
                RemotePermissions {
                    role: RemoteRole::Write,
                    ports: vec!["COM3".into()],
                    allow_loan: false,
                    automation: false,
                    device_plugins: false,
                    device_tools: false,
                },
                None,
            )
            .unwrap();
        let profile = auth.pair(&invite.code).unwrap();
        let peer = auth.authenticate(&profile.client_id, &profile.token).unwrap();

        let remote_actor = Actor::Remote {
            peer: Arc::clone(&peer),
            conn_owner: "remote:1".into(),
        };
        assert!(require_local(&remote_actor).is_err());
        assert!(remote_actor.check_access(Access::Observe, Some("COM3")).is_ok());
        assert!(remote_actor.check_access(Access::Write, Some("COM3")).is_ok());
        assert!(remote_actor.check_access(Access::Write, Some("COM9")).is_err());
        assert!(remote_actor.check_access(Access::Control, Some("COM3")).is_err());
        assert!(remote_actor.check_access(Access::Loan, Some("COM3")).is_err());
        assert_eq!(remote_actor.default_source(), "remote:observer");

        auth.revoke(&profile.client_id).unwrap();
        assert_eq!(
            remote_actor
                .check_access(Access::Observe, Some("COM3"))
                .unwrap_err()
                .code,
            "revoked"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn test_hub() -> Arc<ControlHub> {
        let dir = std::env::temp_dir().join(format!("hc-ctrl-test-{}", Uuid::new_v4()));
        Arc::new(ControlHub::new(
            Arc::new(Mutex::new(SerialManager::new())),
            Arc::new(SerialEventHub::new()),
            Arc::new(PortLeaseRegistry::new()),
            Arc::new(LogManager::new()),
            dir,
        ))
    }

    #[tokio::test]
    async fn hello_and_host_info_match_protocol_contract() {
        let hub = test_hub();
        let actor = Actor::Local {
            conn_owner: "ipc:test".to_string(),
        };
        let hello = hub.dispatch_command(ControlCommand::Hello, actor.clone()).await.unwrap();
        assert_eq!(hello["protocol"], PROTOCOL_VERSION);
        assert_eq!(hello["hostId"], hub.host_id());
        assert_eq!(hello["features"]["portLease"], true);
        assert_eq!(hello["features"]["remoteTls"], true);
        assert_eq!(hello["features"]["notes"], true);

        let info = hub.dispatch_command(ControlCommand::HostInfo, actor).await.unwrap();
        assert_eq!(info["hostId"], hub.host_id());
        assert_eq!(info["localRunning"], false);
        assert_eq!(info["remote"]["enabled"], false);
    }

    #[tokio::test]
    async fn remote_actor_cannot_invoke_remote_management_commands() {
        let hub = test_hub();
        let dir = std::env::temp_dir().join(format!("hc-auth-test-{}", Uuid::new_v4()));
        let auth = Authority::open(&dir, "127.0.0.1:8443".into()).unwrap();
        let invite = auth
            .invite(
                "remote-tester".into(),
                hypercom_protocol::RemotePermissions {
                    role: RemoteRole::Control,
                    ports: vec!["COM3".into()],
                    allow_loan: true,
                    automation: false,
                    device_plugins: false,
                    device_tools: false,
                },
                None,
            )
            .unwrap();
        let profile = auth.pair(&invite.code).unwrap();
        let peer = auth.authenticate(&profile.client_id, &profile.token).unwrap();
        let actor = Actor::Remote {
            peer,
            conn_owner: format!("remote:{}:test", profile.client_id),
        };

        for cmd in [
            ControlCommand::RemoteStatus,
            ControlCommand::RemoteStop,
            ControlCommand::RemoteListClients,
            ControlCommand::RemoteRevokeClient {
                client_id: profile.client_id.clone(),
            },
        ] {
            let err = hub.dispatch_command(cmd, actor.clone()).await.unwrap_err();
            assert_eq!(err.code, "forbidden");
        }

        // Scope check: COM9 is outside peer's permitted ["COM3"]
        let err = hub
            .dispatch_command(
                ControlCommand::AddNote {
                    port_id: "COM9".into(),
                    text: "hello".into(),
                    source: None,
                },
                actor.clone(),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code, "forbidden");

        // COM3 is permitted
        let note = hub
            .dispatch_command(
                ControlCommand::AddNote {
                    port_id: "COM3".into(),
                    text: "flash ok".into(),
                    source: None,
                },
                actor,
            )
            .await
            .unwrap();
        assert_eq!(note["kind"], "note");
        assert_eq!(note["text"], "flash ok");
        assert_eq!(note["source"], "remote:remote-tester");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn poll_events_and_expect_matching_work_against_event_hub() {
        let hub = test_hub();
        let actor = Actor::Local {
            conn_owner: "ipc:test".to_string(),
        };

        hub.event_hub.publish_rx("COM3", 2, 1000, b"READY\r\n");
        let page = hub
            .dispatch_command(
                ControlCommand::PollEvents {
                    port_id: "COM3".into(),
                    after_seq: Some(0),
                    recent: None,
                    wait_ms: 0,
                    limit: Some(10),
                },
                actor,
            )
            .await
            .unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 1);
        assert_eq!(page["events"][0]["kind"], "rx");
        assert_eq!(
            STANDARD
                .decode(page["events"][0]["dataBase64"].as_str().unwrap())
                .unwrap(),
            b"READY\r\n"
        );
    }
}
