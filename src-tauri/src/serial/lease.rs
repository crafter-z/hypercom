//! Thread-safe registry of explicit port leases built on top of `ManagedPortLoan`.
//!
//! Leases support CLI, MCP, plugin, and remote workflows without breaking existing
//! `run_port_tool` or `plugin_shell_tasks` reservations.

#![allow(dead_code)] // Prepared for Step 2 wiring into AppState / commands.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::event_hub::SerialEventHub;
use super::managed_loan::{LoanMetadata, ManagedPortLoan};
use super::{lock_error, SerialManager};

fn default_auto_reopen() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireLeaseRequest {
    pub port_id: String,
    pub holder: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub expected_generation: Option<u64>,
    #[serde(default)]
    pub ttl_ms: Option<u64>,
    #[serde(default = "default_auto_reopen")]
    pub auto_reopen: bool,
    #[serde(default)]
    pub owner_tag: String,
    #[serde(default)]
    pub connection_bound: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseRecovery {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct ActiveLease {
    port_id: String,
    loan: Option<ManagedPortLoan>,
    meta: LoanMetadata,
    owner_tag: String,
    reopen_default: bool,
}

#[derive(Default)]
struct LeaseState {
    leases: HashMap<String, ActiveLease>,
    by_port: HashMap<String, String>,
    shutting_down: bool,
}

pub struct PortLeaseRegistry {
    state: Mutex<LeaseState>,
}

impl Default for PortLeaseRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn compute_expiry(now: i64, ttl_ms: Option<u64>) -> Option<i64> {
    ttl_ms.map(|ms| {
        let delta = i64::try_from(ms).unwrap_or(i64::MAX);
        now.saturating_add(delta)
    })
}

impl PortLeaseRegistry {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(LeaseState::default()),
        }
    }

    pub async fn acquire(
        &self,
        manager: &Arc<Mutex<SerialManager>>,
        event_hub: Option<&SerialEventHub>,
        req: AcquireLeaseRequest,
    ) -> Result<LoanMetadata, String> {
        {
            let guard = self.state.lock().map_err(|e| lock_error(e).to_string())?;
            if guard.shutting_down {
                return Err("Port lease registry is shutting down".to_string());
            }
            if guard.by_port.contains_key(&req.port_id) {
                return Err(format!("Port {} already has an active lease", req.port_id));
            }
        }

        let lease_id = Uuid::new_v4().to_string();
        let acquired_at_ms = now_ms();
        let expires_at_ms = compute_expiry(acquired_at_ms, req.ttl_ms);
        let metadata = LoanMetadata {
            lease_id: lease_id.clone(),
            holder: req.holder,
            reason: req.reason,
            acquired_at_ms,
            expires_at_ms,
            auto_reopen: req.auto_reopen,
            connection_bound: req.connection_bound,
        };

        let mut loan = ManagedPortLoan::reserve_lease(
            Arc::clone(manager),
            req.port_id.clone(),
            req.expected_generation,
            req.auto_reopen,
            metadata.clone(),
        )
        .map_err(|e| e.to_string())?;

        let loan = tokio::task::spawn_blocking(move || -> anyhow::Result<ManagedPortLoan> {
            if let Err(err) = loan.wait_ready() {
                let _ = loan.finish_with_reopen(Some(false));
                return Err(err);
            }
            Ok(loan)
        })
        .await
        .map_err(|e| format!("Lease acquire task failed: {e}"))?
        .map_err(|e| e.to_string())?;

        let generation = loan.generation();
        let begin_hub_addr = loan.begin_hub_addr();

        let insert_res = {
            let mut guard = self.state.lock().map_err(|e| lock_error(e).to_string())?;
            if guard.shutting_down {
                Err((loan, "Port lease registry is shutting down".to_string()))
            } else if guard.by_port.contains_key(&req.port_id) {
                Err((
                    loan,
                    format!("Port {} already has an active lease", req.port_id),
                ))
            } else {
                guard.by_port.insert(req.port_id.clone(), lease_id.clone());
                guard.leases.insert(
                    lease_id,
                    ActiveLease {
                        port_id: req.port_id.clone(),
                        loan: Some(loan),
                        meta: metadata.clone(),
                        owner_tag: req.owner_tag,
                        reopen_default: req.auto_reopen,
                    },
                );
                Ok(())
            }
        };

        if let Err((loan, msg)) = insert_res {
            let _ = tokio::task::spawn_blocking(move || loan.finish_with_reopen(Some(false))).await;
            return Err(msg);
        }

        if let Some(hub) = event_hub {
            let hub_addr = hub as *const SerialEventHub as usize;
            if begin_hub_addr != Some(hub_addr) {
                hub.publish_loan(
                    &req.port_id,
                    generation,
                    acquired_at_ms,
                    true,
                    Some(metadata.clone()),
                    None,
                );
            }
        }

        Ok(metadata)
    }

    pub fn heartbeat(
        &self,
        manager: &Arc<Mutex<SerialManager>>,
        lease_id: &str,
        extend_ttl_ms: Option<u64>,
    ) -> Result<LoanMetadata, String> {
        let now = now_ms();
        let (port_id, owner, meta) = {
            let mut guard = self.state.lock().map_err(|e| lock_error(e).to_string())?;
            let lease = guard
                .leases
                .get_mut(lease_id)
                .ok_or_else(|| format!("Lease not found: {lease_id}"))?;
            if let Some(ttl_ms) = extend_ttl_ms {
                lease.meta.expires_at_ms = compute_expiry(now, Some(ttl_ms));
            }
            let owner = lease
                .loan
                .as_ref()
                .map(ManagedPortLoan::owner)
                .ok_or_else(|| format!("Lease {lease_id} is already releasing"))?;
            (lease.port_id.clone(), owner, lease.meta.clone())
        };

        let mut mgr_guard = manager.lock().map_err(|e| lock_error(e).to_string())?;
        mgr_guard.update_loan_expiry(&port_id, owner, meta.expires_at_ms);
        Ok(meta)
    }

    pub async fn release(
        &self,
        event_hub: Option<&SerialEventHub>,
        lease_id: &str,
        reopen_override: Option<bool>,
    ) -> Result<LeaseRecovery, String> {
        let active = {
            let mut guard = self.state.lock().map_err(|e| lock_error(e).to_string())?;
            let active = guard
                .leases
                .remove(lease_id)
                .ok_or_else(|| format!("Lease not found: {lease_id}"))?;
            if guard.by_port.get(&active.port_id).map(String::as_str) == Some(lease_id) {
                guard.by_port.remove(&active.port_id);
            }
            active
        };

        Ok(self
            .finish_active_lease(event_hub, active, reopen_override)
            .await)
    }

    pub async fn reclaim_port(
        &self,
        event_hub: Option<&SerialEventHub>,
        port_id: &str,
    ) -> Result<Option<LeaseRecovery>, String> {
        let active = {
            let mut guard = self.state.lock().map_err(|e| lock_error(e).to_string())?;
            let Some(lease_id) = guard.by_port.remove(port_id) else {
                return Ok(None);
            };
            guard.leases.remove(&lease_id)
        };

        let Some(active) = active else {
            return Ok(None);
        };
        let recovery = self
            .finish_active_lease(event_hub, active, Some(true))
            .await;
        Ok(Some(recovery))
    }

    pub async fn release_by_owner(
        &self,
        event_hub: Option<&SerialEventHub>,
        owner_tag: &str,
    ) -> Vec<(String, LeaseRecovery)> {
        if owner_tag.is_empty() {
            return Vec::new();
        }
        let matching: Vec<(String, ActiveLease)> = {
            let Ok(mut guard) = self.state.lock() else {
                return Vec::new();
            };
            let ids: Vec<String> = guard
                .leases
                .iter()
                .filter(|(_, entry)| entry.owner_tag == owner_tag)
                .map(|(id, _)| id.clone())
                .collect();
            let mut removed = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(entry) = guard.leases.remove(&id) {
                    if guard.by_port.get(&entry.port_id).map(String::as_str) == Some(id.as_str())
                    {
                        guard.by_port.remove(&entry.port_id);
                    }
                    removed.push((id, entry));
                }
            }
            removed
        };

        let mut results = Vec::with_capacity(matching.len());
        for (lease_id, active) in matching {
            let recovery = self.finish_active_lease(event_hub, active, None).await;
            results.push((lease_id, recovery));
        }
        results
    }

    pub async fn release_by_owner_prefix(
        &self,
        event_hub: Option<&SerialEventHub>,
        owner_prefix: &str,
    ) -> Vec<(String, LeaseRecovery)> {
        if owner_prefix.is_empty() {
            return Vec::new();
        }
        let matching: Vec<(String, ActiveLease)> = {
            let Ok(mut guard) = self.state.lock() else {
                return Vec::new();
            };
            let ids: Vec<String> = guard
                .leases
                .iter()
                .filter(|(_, entry)| entry.owner_tag.starts_with(owner_prefix))
                .map(|(id, _)| id.clone())
                .collect();
            let mut removed = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(entry) = guard.leases.remove(&id) {
                    if guard.by_port.get(&entry.port_id).map(String::as_str) == Some(id.as_str())
                    {
                        guard.by_port.remove(&entry.port_id);
                    }
                    removed.push((id, entry));
                }
            }
            removed
        };

        let mut results = Vec::with_capacity(matching.len());
        for (lease_id, active) in matching {
            let recovery = self.finish_active_lease(event_hub, active, None).await;
            results.push((lease_id, recovery));
        }
        results
    }

    pub async fn reap_expired(&self, event_hub: Option<&SerialEventHub>) -> usize {
        let now = now_ms();
        let expired: Vec<ActiveLease> = {
            let Ok(mut guard) = self.state.lock() else {
                return 0;
            };
            let ids: Vec<String> = guard
                .leases
                .iter()
                .filter(|(_, entry)| entry.meta.expires_at_ms.is_some_and(|exp| exp <= now))
                .map(|(id, _)| id.clone())
                .collect();
            let mut removed = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(entry) = guard.leases.remove(&id) {
                    if guard.by_port.get(&entry.port_id).map(String::as_str) == Some(id.as_str())
                    {
                        guard.by_port.remove(&entry.port_id);
                    }
                    removed.push(entry);
                }
            }
            removed
        };

        let count = expired.len();
        for active in expired {
            let _ = self.finish_active_lease(event_hub, active, None).await;
        }
        count
    }

    pub fn list(&self) -> Vec<LoanMetadata> {
        let Ok(guard) = self.state.lock() else {
            return Vec::new();
        };
        guard.leases.values().map(|e| e.meta.clone()).collect()
    }

    pub fn list_entries(&self) -> Vec<(String, u64, LoanMetadata)> {
        let Ok(guard) = self.state.lock() else {
            return Vec::new();
        };
        guard
            .leases
            .values()
            .map(|e| {
                (
                    e.port_id.clone(),
                    e.loan.as_ref().map_or(0, ManagedPortLoan::generation),
                    e.meta.clone(),
                )
            })
            .collect()
    }

    pub fn get_entry(&self, lease_id: &str) -> Option<(String, u64, LoanMetadata, String)> {
        let Ok(guard) = self.state.lock() else {
            return None;
        };
        let entry = guard.leases.get(lease_id)?;
        Some((
            entry.port_id.clone(),
            entry.loan.as_ref().map_or(0, ManagedPortLoan::generation),
            entry.meta.clone(),
            entry.owner_tag.clone(),
        ))
    }

    pub fn get_for_port(&self, port_id: &str) -> Option<LoanMetadata> {
        let Ok(guard) = self.state.lock() else {
            return None;
        };
        let lease_id = guard.by_port.get(port_id)?;
        guard.leases.get(lease_id).map(|e| e.meta.clone())
    }

    pub async fn release_all_on_shutdown(&self, event_hub: Option<&SerialEventHub>) {
        let all: Vec<ActiveLease> = {
            let Ok(mut guard) = self.state.lock() else {
                return;
            };
            guard.shutting_down = true;
            guard.by_port.clear();
            guard.leases.drain().map(|(_, entry)| entry).collect()
        };

        for active in all {
            let _ = self
                .finish_active_lease(event_hub, active, Some(false))
                .await;
        }
    }

    async fn finish_active_lease(
        &self,
        event_hub: Option<&SerialEventHub>,
        mut active: ActiveLease,
        reopen_override: Option<bool>,
    ) -> LeaseRecovery {
        let Some(loan) = active.loan.take() else {
            return LeaseRecovery {
                state: "superseded".to_string(),
                error: None,
            };
        };
        let generation = loan.generation();
        let effective_reopen = reopen_override.or(Some(active.reopen_default));

        let joined = tokio::task::spawn_blocking(move || {
            loan.finish_with_reopen_report(effective_reopen)
        })
        .await;

        let (recovery, published_hub_addr) = match joined {
            Ok((Ok(state), hub_addr)) => (
                LeaseRecovery {
                    state: state.to_string(),
                    error: None,
                },
                hub_addr,
            ),
            Ok((Err(err), hub_addr)) => (
                LeaseRecovery {
                    state: "failed".to_string(),
                    error: Some(err.to_string()),
                },
                hub_addr,
            ),
            Err(join_err) => (
                LeaseRecovery {
                    state: "failed".to_string(),
                    error: Some(join_err.to_string()),
                },
                None,
            ),
        };

        if let Some(hub) = event_hub {
            let hub_addr = hub as *const SerialEventHub as usize;
            if published_hub_addr != Some(hub_addr) {
                hub.publish_loan(
                    &active.port_id,
                    generation,
                    now_ms(),
                    false,
                    Some(active.meta),
                    recovery.error.clone(),
                );
            }
        }

        recovery
    }
}

#[cfg(test)]
mod pure_tests {
    use super::{AcquireLeaseRequest, LeaseRecovery};

    #[test]
    fn acquire_lease_request_deserializes_with_defaults() {
        let req: AcquireLeaseRequest = serde_json::from_value(serde_json::json!({
            "portId": "COM9",
            "holder": "hypercomctl"
        }))
        .unwrap();
        assert_eq!(req.port_id, "COM9");
        assert_eq!(req.holder, "hypercomctl");
        assert!(req.auto_reopen);
        assert!(!req.connection_bound);
        assert_eq!(req.owner_tag, "");
        assert_eq!(req.ttl_ms, None);
        assert_eq!(req.expected_generation, None);
    }

    #[test]
    fn lease_recovery_omits_none_error_on_serialize() {
        let ok = LeaseRecovery {
            state: "restored".into(),
            error: None,
        };
        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json, serde_json::json!({ "state": "restored" }));
    }
}

#[cfg(all(test, not(windows)))] // Native serial-driver linkage requires the packaged Windows manifest.
mod manager_tests {
    use super::{AcquireLeaseRequest, PortLeaseRegistry};
    use crate::serial::event_hub::{HubEventKind, SerialEventHub};
    use crate::serial::SerialManager;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn empty_registry_operations_behave_cleanly() {
        let registry = PortLeaseRegistry::new();
        assert!(registry.list().is_empty());
        assert!(registry.get_for_port("COM1").is_none());
        assert!(registry.release(None, "missing", None).await.is_err());
        assert_eq!(registry.reclaim_port(None, "COM1").await.unwrap(), None);
        assert!(registry.release_by_owner(None, "").await.is_empty());
        assert!(registry.release_by_owner(None, "owner-1").await.is_empty());
        assert_eq!(registry.reap_expired(None).await, 0);
    }

    fn make_req(port_id: &str, owner_tag: &str, ttl_ms: Option<u64>) -> AcquireLeaseRequest {
        AcquireLeaseRequest {
            port_id: port_id.to_string(),
            holder: "test-agent".to_string(),
            reason: Some("integration".to_string()),
            expected_generation: None,
            ttl_ms,
            auto_reopen: false,
            owner_tag: owner_tag.to_string(),
            connection_bound: !owner_tag.is_empty(),
        }
    }

    #[tokio::test]
    async fn acquire_heartbeat_release_and_hub_events_avoid_duplicates() {
        let hub = Arc::new(SerialEventHub::new());
        let mut mgr = SerialManager::new();
        mgr.set_event_hub(Arc::clone(&hub));
        let manager = Arc::new(Mutex::new(mgr));
        let registry = PortLeaseRegistry::new();

        let meta = registry
            .acquire(&manager, Some(hub.as_ref()), make_req("COM10", "conn-1", Some(5000)))
            .await
            .unwrap();
        assert_eq!(registry.list().len(), 1);
        assert_eq!(registry.get_for_port("COM10"), Some(meta.clone()));
        assert_eq!(manager.lock().unwrap().active_loan_meta("COM10"), Some(meta.clone()));

        // Duplicate acquire on the same port fails cleanly.
        assert!(registry
            .acquire(&manager, Some(hub.as_ref()), make_req("COM10", "conn-2", None))
            .await
            .is_err());

        let updated = registry
            .heartbeat(&manager, &meta.lease_id, Some(60_000))
            .unwrap();
        assert!(updated.expires_at_ms.unwrap() >= meta.expires_at_ms.unwrap());

        let recovery = registry
            .release(Some(hub.as_ref()), &meta.lease_id, None)
            .await
            .unwrap();
        assert_eq!(recovery.state, "not-connected");
        assert!(registry.list().is_empty());
        assert!(manager.lock().unwrap().active_loan_meta("COM10").is_none());

        let page = hub.poll("COM10", Some(0), None, 20);
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.events[0].kind, HubEventKind::Loan);
        assert_eq!(page.events[0].status.as_deref(), Some("active"));
        assert_eq!(page.events[1].kind, HubEventKind::Loan);
        assert_eq!(page.events[1].status.as_deref(), Some("released"));
    }

    #[tokio::test]
    async fn release_by_owner_reclaim_reap_and_shutdown_work() {
        let hub = SerialEventHub::new();
        let manager = Arc::new(Mutex::new(SerialManager::new()));
        let registry = PortLeaseRegistry::new();

        let m1 = registry
            .acquire(&manager, Some(&hub), make_req("COM11", "pipe-A", None))
            .await
            .unwrap();
        let _m2 = registry
            .acquire(&manager, Some(&hub), make_req("COM12", "pipe-A", None))
            .await
            .unwrap();
        let m3 = registry
            .acquire(&manager, Some(&hub), make_req("COM13", "pipe-B", Some(0)))
            .await
            .unwrap();

        let released = registry.release_by_owner(Some(&hub), "pipe-A").await;
        assert_eq!(released.len(), 2);
        assert!(registry.get_for_port("COM11").is_none());
        assert!(registry.get_for_port("COM12").is_none());
        assert!(registry.get_for_port("COM13").is_some());

        // TTL 0 is already expired (or expires immediately).
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let reaped = registry.reap_expired(Some(&hub)).await;
        assert_eq!(reaped, 1);
        assert!(registry.get_for_port(&m3.lease_id).is_none());
        assert!(registry.list().is_empty());

        let _m4 = registry
            .acquire(&manager, Some(&hub), make_req("COM14", "", None))
            .await
            .unwrap();
        let reclaimed = registry.reclaim_port(Some(&hub), "COM14").await.unwrap();
        assert!(reclaimed.is_some());
        assert!(registry.list().is_empty());

        let _m5 = registry
            .acquire(&manager, Some(&hub), make_req("COM15", "", None))
            .await
            .unwrap();
        registry.release_all_on_shutdown(Some(&hub)).await;
        assert!(registry.list().is_empty());
        assert!(registry
            .acquire(&manager, Some(&hub), make_req("COM16", "", None))
            .await
            .is_err());
        let _ = m1;
    }
}
