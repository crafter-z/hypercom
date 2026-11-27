//! The reservation outlives both the old serial handles and the tool process.
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{lock_error, OpenPortArgs, PortClose, PortKind, PortStatus, SerialManager};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanMetadata {
    pub lease_id: String,
    pub holder: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub acquired_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    pub auto_reopen: bool,
    pub connection_bound: bool,
}

pub(super) struct ToolReservation {
    pub owner: Uuid,
    pub restore_allowed: bool,
    pub meta: Option<LoanMetadata>,
}

struct BeginOptions {
    expected_generation: Option<u64>,
    require_live_for_reopen: bool,
    emit_loan_event: bool,
    default_auto_reopen: bool,
    meta: Option<LoanMetadata>,
    allow_tty: bool,
}

pub(crate) struct ManagedPortLoan {
    manager: Arc<Mutex<SerialManager>>,
    port_id: String,
    owner: Uuid,
    generation: u64,
    params: Option<OpenPortArgs>,
    close: Option<PortClose>,
    emit_loan_event: bool,
    default_auto_reopen: bool,
    begin_hub_addr: Option<usize>,
    finished: bool,
}

impl ManagedPortLoan {
    pub(crate) fn reserve(
        manager: Arc<Mutex<SerialManager>>,
        port_id: String,
        generation: u64,
    ) -> anyhow::Result<Self> {
        Self::begin(
            manager,
            port_id,
            BeginOptions {
                expected_generation: Some(generation),
                require_live_for_reopen: true,
                emit_loan_event: true,
                default_auto_reopen: true,
                meta: None,
                allow_tty: true,
            },
        )
    }

    /// Legacy tools intentionally reopen using the last successful parameters,
    /// even if the port was already disconnected. Do not change that contract.
    pub(crate) fn reserve_legacy(
        manager: Arc<Mutex<SerialManager>>,
        port_id: String,
    ) -> anyhow::Result<Self> {
        Self::begin(
            manager,
            port_id,
            BeginOptions {
                expected_generation: None,
                require_live_for_reopen: false,
                emit_loan_event: false,
                default_auto_reopen: true,
                meta: None,
                allow_tty: true,
            },
        )
    }

    #[allow(dead_code)] // Used by PortLeaseRegistry (wired into commands in Step 2).
    pub(crate) fn reserve_lease(
        manager: Arc<Mutex<SerialManager>>,
        port_id: String,
        expected_generation: Option<u64>,
        auto_reopen: bool,
        metadata: LoanMetadata,
    ) -> anyhow::Result<Self> {
        Self::begin(
            manager,
            port_id,
            BeginOptions {
                expected_generation,
                require_live_for_reopen: true,
                emit_loan_event: true,
                default_auto_reopen: auto_reopen,
                meta: Some(metadata),
                allow_tty: false,
            },
        )
    }

    fn begin(
        manager: Arc<Mutex<SerialManager>>,
        port_id: String,
        opts: BeginOptions,
    ) -> anyhow::Result<Self> {
        if !opts.allow_tty && PortKind::of(&port_id) == PortKind::Tty {
            anyhow::bail!("TTY port {port_id} cannot be leased");
        }
        let owner = Uuid::new_v4();
        let mut guard = manager.lock().map_err(lock_error)?;
        anyhow::ensure!(!guard.is_shutting_down(), "Serial manager is shutting down");
        if let Some(expected) = opts.expected_generation {
            guard.check_control_generation(&port_id, expected)?;
        }
        guard.ensure_port_available(&port_id)?;
        let generation = guard.status_generation(&port_id).unwrap_or(0);
        let params = if !opts.require_live_for_reopen || guard.connection_is_live(&port_id) {
            guard.get_last_params(&port_id)
        } else {
            None
        };
        guard.cancel_reconnect(&port_id);
        let meta_for_event = opts.meta.clone();
        guard.tool_loans.insert(
            port_id.clone(),
            ToolReservation {
                owner,
                restore_allowed: true,
                meta: opts.meta,
            },
        );
        let begin_hub_addr = if opts.emit_loan_event {
            guard.emit_tool_loan_detail(&port_id, true, meta_for_event.as_ref());
            guard.event_hub_addr()
        } else {
            None
        };
        let close = match guard.close_port_inner(&port_id) {
            Ok(close) => close,
            Err(error) => {
                let removed_meta = guard.tool_loans.remove(&port_id).and_then(|e| e.meta);
                if opts.emit_loan_event {
                    guard.emit_tool_loan_detail(&port_id, false, removed_meta.as_ref());
                }
                return Err(error);
            }
        };
        drop(guard);
        Ok(Self {
            manager,
            port_id,
            owner,
            generation,
            params,
            close,
            emit_loan_event: opts.emit_loan_event,
            default_auto_reopen: opts.default_auto_reopen,
            begin_hub_addr,
            finished: false,
        })
    }

    #[allow(dead_code)] // Used by PortLeaseRegistry.
    pub(crate) fn owner(&self) -> Uuid {
        self.owner
    }

    #[allow(dead_code)] // Used by PortLeaseRegistry.
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    #[allow(dead_code)] // Used by PortLeaseRegistry to avoid duplicate hub events.
    pub(crate) fn begin_hub_addr(&self) -> Option<usize> {
        self.begin_hub_addr
    }

    /// Joining the reader also waits for pending writes and releases the OS handle.
    /// Never call this with the manager or the plugin authority gate locked.
    pub(crate) fn wait_ready(&mut self) -> anyhow::Result<()> {
        if let Some(close) = self.close.take() {
            close
                .join()
                .map_err(|_| anyhow::anyhow!("Serial reader join panicked"))?;
        }
        Ok(())
    }

    pub(crate) fn finish(mut self) -> anyhow::Result<&'static str> {
        self.finish_inner(None).0
    }

    #[allow(dead_code)] // Used by PortLeaseRegistry.
    pub(crate) fn finish_with_reopen(
        mut self,
        reopen_override: Option<bool>,
    ) -> anyhow::Result<&'static str> {
        self.finish_inner(reopen_override).0
    }

    #[allow(dead_code)] // Used by PortLeaseRegistry to track hub publication.
    pub(crate) fn finish_with_reopen_report(
        mut self,
        reopen_override: Option<bool>,
    ) -> (anyhow::Result<&'static str>, Option<usize>) {
        self.finish_inner(reopen_override)
    }

    fn finish_inner(
        &mut self,
        reopen_override: Option<bool>,
    ) -> (anyhow::Result<&'static str>, Option<usize>) {
        let joined = self.wait_ready();
        let mut guard = match self.manager.lock().map_err(lock_error) {
            Ok(guard) => guard,
            Err(err) => return (Err(err), None),
        };
        self.finished = true;
        let Some(entry) = guard.tool_loans.get(&self.port_id) else {
            return (Ok("superseded"), None);
        };
        if entry.owner != self.owner {
            return (Ok("superseded"), None);
        }
        let want_reopen = reopen_override.unwrap_or(self.default_auto_reopen);
        let can_restore = entry.restore_allowed
            && !guard.is_shutting_down()
            && guard.status_generation(&self.port_id).unwrap_or(0) == self.generation;
        guard.cleanup_real_close(&self.port_id);
        // Removal and reopen are atomic with respect to all manager callers. No
        // enumeration/stale recycling is needed: we detached this session, waited
        // for the close barrier, and excluded all other openers until now.
        let removed_meta = guard.tool_loans.remove(&self.port_id).and_then(|e| e.meta);
        let recovery = if !can_restore {
            Ok("superseded")
        } else if !want_reopen {
            if self.params.is_some() {
                Ok("released")
            } else {
                Ok("not-connected")
            }
        } else if let Some(params) = self.params.take() {
            guard.open_port(params).map(|()| "restored")
        } else {
            Ok("not-connected")
        };
        if recovery.is_err() {
            if let Some(app) = &guard.app_handle {
                super::emit_status(app, &self.port_id, PortStatus::Error, Some(self.generation));
            }
        }
        let published_hub_addr = if self.emit_loan_event {
            guard.emit_tool_loan_detail(&self.port_id, false, removed_meta.as_ref());
            guard.event_hub_addr()
        } else {
            None
        };
        if let Err(err) = joined {
            return (Err(err), published_hub_addr);
        }
        (recovery, published_hub_addr)
    }
}

impl Drop for ManagedPortLoan {
    fn drop(&mut self) {
        if !self.finished {
            if let (Err(e), _) = self.finish_inner(None) {
                log::warn!(
                    "Abandoned tool loan cleanup failed for {}: {e}",
                    self.port_id
                );
            }
        }
    }
}

#[cfg(test)]
mod pure_tests {
    use super::LoanMetadata;

    #[test]
    fn loan_metadata_roundtrips_camel_case_json() {
        let meta = LoanMetadata {
            lease_id: "lease-123".into(),
            holder: "hypercomctl".into(),
            reason: Some("firmware flash".into()),
            acquired_at_ms: 1_700_000_000_000,
            expires_at_ms: Some(1_700_000_060_000),
            auto_reopen: true,
            connection_bound: false,
        };
        let value = serde_json::to_value(&meta).unwrap();
        assert_eq!(value["leaseId"], "lease-123");
        assert_eq!(value["acquiredAtMs"], 1_700_000_000_000i64);
        assert_eq!(value["expiresAtMs"], 1_700_000_060_000i64);
        assert_eq!(value["autoReopen"], true);
        assert_eq!(value["connectionBound"], false);
        let decoded: LoanMetadata = serde_json::from_value(value).unwrap();
        assert_eq!(decoded, meta);
    }
}

#[cfg(all(test, not(windows)))] // Native serial-driver linkage requires the packaged Windows manifest.
mod tests {
    use super::{LoanMetadata, ManagedPortLoan};
    use crate::serial::SerialManager;
    use std::sync::{atomic::Ordering, Arc, Mutex};

    fn sample_meta(lease_id: &str, auto_reopen: bool) -> LoanMetadata {
        LoanMetadata {
            lease_id: lease_id.into(),
            holder: "cli".into(),
            reason: Some("test".into()),
            acquired_at_ms: 1000,
            expires_at_ms: Some(5000),
            auto_reopen,
            connection_bound: false,
        }
    }

    #[test]
    fn managed_loan_serializes_with_legacy_and_preserves_manual_close() {
        let manager = Arc::new(Mutex::new(SerialManager::new()));
        let port = "COM-LOAN-FIXTURE";
        let previous = manager.lock().unwrap().begin_reconnect(port);
        let loan = ManagedPortLoan::reserve(manager.clone(), port.into(), 0).unwrap();
        assert!(previous.load(Ordering::Acquire));
        assert!(ManagedPortLoan::reserve_legacy(manager.clone(), port.into()).is_err());
        {
            let mut guard = manager.lock().unwrap();
            assert!(guard.begin_reconnect(port).load(Ordering::Acquire));
            assert!(guard.close_port_cas(port, 7).is_err());
            assert!(guard.close_port_cas(port, 0).unwrap().is_none());
        }
        assert_eq!(loan.finish().unwrap(), "superseded");
        let legacy = ManagedPortLoan::reserve_legacy(manager.clone(), port.into()).unwrap();
        assert!(ManagedPortLoan::reserve(manager.clone(), port.into(), 0).is_err());
        drop(legacy);
        assert!(ManagedPortLoan::reserve(manager.clone(), port.into(), 1).is_err());
        let loan = ManagedPortLoan::reserve(manager.clone(), port.into(), 0).unwrap();
        manager.lock().unwrap().begin_shutdown();
        assert_eq!(loan.finish().unwrap(), "superseded");
        assert!(ManagedPortLoan::reserve(manager, port.into(), 0).is_err());
    }

    #[test]
    fn reserve_lease_stores_metadata_supports_cas_and_rejects_tty() {
        let manager = Arc::new(Mutex::new(SerialManager::new()));
        let tty_err = ManagedPortLoan::reserve_lease(
            manager.clone(),
            "GIT:BASH".into(),
            None,
            false,
            sample_meta("l-tty", false),
        );
        assert!(tty_err.is_err());

        assert!(ManagedPortLoan::reserve_lease(
            manager.clone(),
            "COM9".into(),
            Some(99),
            true,
            sample_meta("l-bad-gen", true),
        )
        .is_err());

        let meta = sample_meta("l-1", false);
        let loan = ManagedPortLoan::reserve_lease(
            manager.clone(),
            "COM9".into(),
            None,
            false,
            meta.clone(),
        )
        .unwrap();
        assert_eq!(manager.lock().unwrap().active_loan_meta("COM9"), Some(meta));
        let owner = loan.owner();
        manager
            .lock()
            .unwrap()
            .update_loan_expiry("COM9", owner, Some(9999));
        assert_eq!(
            manager
                .lock()
                .unwrap()
                .active_loan_meta("COM9")
                .and_then(|m| m.expires_at_ms),
            Some(9999)
        );
        assert_eq!(loan.finish_with_reopen(None).unwrap(), "not-connected");
        assert!(manager.lock().unwrap().active_loan_meta("COM9").is_none());
    }
}
