//! The reservation outlives both the old serial handles and the tool process.
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use super::{lock_error, OpenPortArgs, PortClose, PortStatus, SerialManager};

pub(super) struct ToolReservation {
    pub owner: Uuid,
    pub restore_allowed: bool,
}

pub(crate) struct ManagedPortLoan {
    manager: Arc<Mutex<SerialManager>>,
    port_id: String,
    owner: Uuid,
    generation: u64,
    params: Option<OpenPortArgs>,
    close: Option<PortClose>,
    plugin: bool,
    finished: bool,
}

impl ManagedPortLoan {
    pub(crate) fn reserve(
        manager: Arc<Mutex<SerialManager>>,
        port_id: String,
        generation: u64,
    ) -> anyhow::Result<Self> {
        Self::begin(manager, port_id, Some(generation))
    }

    /// Legacy tools intentionally reopen using the last successful parameters,
    /// even if the port was already disconnected. Do not change that contract.
    pub(crate) fn reserve_legacy(
        manager: Arc<Mutex<SerialManager>>,
        port_id: String,
    ) -> anyhow::Result<Self> {
        Self::begin(manager, port_id, None)
    }

    fn begin(
        manager: Arc<Mutex<SerialManager>>,
        port_id: String,
        expected: Option<u64>,
    ) -> anyhow::Result<Self> {
        let owner = Uuid::new_v4();
        let plugin = expected.is_some();
        let mut guard = manager.lock().map_err(lock_error)?;
        anyhow::ensure!(!guard.is_shutting_down(), "Serial manager is shutting down");
        if let Some(expected) = expected {
            guard.check_control_generation(&port_id, expected)?;
        }
        guard.ensure_port_available(&port_id)?;
        let generation = guard.status_generation(&port_id).unwrap_or(0);
        let params = if !plugin || guard.connection_is_live(&port_id) {
            guard.get_last_params(&port_id)
        } else {
            None
        };
        guard.cancel_reconnect(&port_id);
        guard.tool_loans.insert(
            port_id.clone(),
            ToolReservation {
                owner,
                restore_allowed: true,
            },
        );
        if plugin {
            guard.emit_tool_loan(&port_id, true);
        }
        let close = match guard.close_port_inner(&port_id) {
            Ok(close) => close,
            Err(error) => {
                guard.tool_loans.remove(&port_id);
                if plugin {
                    guard.emit_tool_loan(&port_id, false);
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
            plugin,
            finished: false,
        })
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
        self.finish_inner()
    }

    fn finish_inner(&mut self) -> anyhow::Result<&'static str> {
        let joined = self.wait_ready();
        let mut guard = self.manager.lock().map_err(lock_error)?;
        self.finished = true;
        let Some(entry) = guard.tool_loans.get(&self.port_id) else {
            return Ok("superseded");
        };
        if entry.owner != self.owner {
            return Ok("superseded");
        }
        let restore = entry.restore_allowed
            && !guard.is_shutting_down()
            && guard.status_generation(&self.port_id).unwrap_or(0) == self.generation;
        guard.cleanup_real_close(&self.port_id);
        // Removal and reopen are atomic with respect to all manager callers. No
        // enumeration/stale recycling is needed: we detached this session, waited
        // for the close barrier, and excluded all other openers until now.
        guard.tool_loans.remove(&self.port_id);
        let recovery = if !restore {
            Ok("superseded")
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
        if self.plugin {
            guard.emit_tool_loan(&self.port_id, false);
        }
        joined?;
        recovery
    }
}

impl Drop for ManagedPortLoan {
    fn drop(&mut self) {
        if !self.finished {
            if let Err(e) = self.finish_inner() {
                log::warn!(
                    "Abandoned tool loan cleanup failed for {}: {e}",
                    self.port_id
                );
            }
        }
    }
}

#[cfg(all(test, not(windows)))] // Native serial-driver linkage requires the packaged Windows manifest.
mod tests {
    use super::ManagedPortLoan;
    use crate::serial::SerialManager;
    use std::sync::{atomic::Ordering, Arc, Mutex};

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
}
