//! Plugin control bridge: advertised tool registry, sync/job tool invocation,
//! and host-side remote view projection proxy.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, EventTarget};
use tokio::sync::{oneshot, Notify};
use uuid::Uuid;

use hypercom_protocol::{
    HostError, PluginJobEventDto, PluginJobStatusDto, PluginToolDescriptorDto,
    PluginToolInvokeResultDto, RemoteViewEventDto, RemoteViewEventPageDto, RemoteViewSessionDto,
    MAX_POLL_MS,
};

use crate::config::PluginConfigEntry;
use crate::plugin::view_runtime::resources;
use crate::plugin::PluginManifest;

const MAX_JOB_EVENTS: usize = 4096;
const MAX_REMOTE_VIEW_EVENTS: usize = 4096;
const DEFAULT_INVOKE_TIMEOUT_MS: u64 = 30_000;
const MIN_INVOKE_TIMEOUT_MS: u64 = 100;
const MAX_INVOKE_TIMEOUT_MS: u64 = 300_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedArtifactDto {
    pub artifact_id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

struct PendingSyncCall {
    plugin_id: String,
    tx: oneshot::Sender<Result<Value, HostError>>,
}

struct PluginJobEntry {
    job_id: String,
    plugin_id: String,
    tool: String,
    state: String,
    result: Option<Value>,
    error: Option<HostError>,
    next_seq: u64,
    events: VecDeque<PluginJobEventDto>,
    notify: Arc<Notify>,
}

impl PluginJobEntry {
    fn latest_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    fn push_event(
        &mut self,
        kind: &str,
        message: Option<String>,
        stream: Option<String>,
        progress: Option<f64>,
        data: Option<Value>,
    ) {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        while self.events.len() >= MAX_JOB_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(PluginJobEventDto {
            seq,
            timestamp_ms: now_ms(),
            kind: kind.to_string(),
            message,
            stream,
            progress,
            data,
        });
    }

    fn snapshot(&self, after_seq: Option<u64>, limit: usize) -> PluginJobStatusDto {
        let latest_seq = self.latest_seq();
        let after = after_seq.unwrap_or(0);
        let events: Vec<PluginJobEventDto> = self
            .events
            .iter()
            .filter(|ev| ev.seq > after)
            .take(limit)
            .cloned()
            .collect();
        let next_seq = events
            .last()
            .map(|ev| ev.seq)
            .unwrap_or_else(|| match after_seq {
                Some(a) => a.min(latest_seq),
                None => latest_seq,
            });
        PluginJobStatusDto {
            job_id: self.job_id.clone(),
            host: "local".to_string(),
            plugin_id: self.plugin_id.clone(),
            tool: self.tool.clone(),
            state: self.state.clone(),
            result: self.result.clone(),
            error: self.error.clone(),
            latest_seq,
            next_seq,
            events,
        }
    }
}

struct RemoteViewProxyEntry {
    remote_instance_id: String,
    plugin_id: String,
    owner_tag: String,
    closed: bool,
    next_seq: u64,
    events: VecDeque<RemoteViewEventDto>,
    notify: Arc<Notify>,
}

impl RemoteViewProxyEntry {
    fn latest_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    fn push_event(&mut self, kind: &str, payload: Value) {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        while self.events.len() >= MAX_REMOTE_VIEW_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(RemoteViewEventDto {
            seq,
            kind: kind.to_string(),
            payload,
        });
    }

    fn page(&self, after_seq: Option<u64>) -> RemoteViewEventPageDto {
        let latest_seq = self.latest_seq();
        let after = after_seq.unwrap_or(0);
        let events: Vec<RemoteViewEventDto> = self
            .events
            .iter()
            .filter(|ev| ev.seq > after)
            .cloned()
            .collect();
        let next_seq = events
            .last()
            .map(|ev| ev.seq)
            .unwrap_or_else(|| match after_seq {
                Some(a) => a.min(latest_seq),
                None => latest_seq,
            });
        RemoteViewEventPageDto {
            remote_instance_id: self.remote_instance_id.clone(),
            latest_seq,
            next_seq,
            closed: self.closed,
            events,
        }
    }
}

pub struct PluginControlBridge {
    tools: Mutex<Vec<PluginToolDescriptorDto>>,
    pending_sync: Mutex<HashMap<String, PendingSyncCall>>,
    jobs: Mutex<HashMap<String, PluginJobEntry>>,
    remote_views: Mutex<HashMap<String, RemoteViewProxyEntry>>,
}

impl Default for PluginControlBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginControlBridge {
    pub fn new() -> Self {
        Self {
            tools: Mutex::new(Vec::new()),
            pending_sync: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            remote_views: Mutex::new(HashMap::new()),
        }
    }

    pub fn sync_plugin_tools(&self, mut tools: Vec<PluginToolDescriptorDto>) {
        for tool in &mut tools {
            tool.host = "local".to_string();
            tool.host_label = None;
        }
        if let Ok(mut guard) = self.tools.lock() {
            *guard = tools;
        }
    }

    pub fn list_local_tools(&self) -> Vec<PluginToolDescriptorDto> {
        self.tools
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn find_local_tool(
        &self,
        plugin_id: &str,
        tool: &str,
    ) -> Option<PluginToolDescriptorDto> {
        self.tools.lock().ok().and_then(|guard| {
            guard
                .iter()
                .find(|entry| entry.plugin_id == plugin_id && entry.tool == tool)
                .cloned()
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn invoke_sync(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        install_generation: &str,
        tool: &str,
        args: Value,
        artifacts: Vec<ResolvedArtifactDto>,
        timeout_ms: Option<u64>,
    ) -> Result<PluginToolInvokeResultDto, HostError> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.pending_sync.lock().map_err(|_| {
                HostError::new("host_unavailable", "plugin invoke registry poisoned")
            })?;
            guard.insert(
                request_id.clone(),
                PendingSyncCall {
                    plugin_id: plugin_id.to_string(),
                    tx,
                },
            );
        }

        let emit_res = app.emit_to(
            EventTarget::webview_window("main"),
            "control:plugin-invoke",
            json!({
                "requestId": request_id,
                "pluginId": plugin_id,
                "installGeneration": install_generation,
                "tool": tool,
                "args": args,
                "artifacts": artifacts,
                "mode": "sync",
                "jobId": Value::Null,
            }),
        );
        if let Err(err) = emit_res {
            if let Ok(mut guard) = self.pending_sync.lock() {
                guard.remove(&request_id);
            }
            return Err(HostError::new(
                "host_unavailable",
                format!("failed to dispatch plugin tool invocation: {err}"),
            ));
        }

        let wait = Duration::from_millis(
            timeout_ms
                .unwrap_or(DEFAULT_INVOKE_TIMEOUT_MS)
                .clamp(MIN_INVOKE_TIMEOUT_MS, MAX_INVOKE_TIMEOUT_MS),
        );
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(Ok(result))) => Ok(PluginToolInvokeResultDto {
                mode: "sync".to_string(),
                result: Some(result),
                job_id: None,
                status: None,
            }),
            Ok(Ok(Err(err))) => Err(err),
            Ok(Err(_)) => Err(HostError::new(
                "host_unavailable",
                "plugin invocation reply channel dropped",
            )),
            Err(_) => {
                if let Ok(mut guard) = self.pending_sync.lock() {
                    guard.remove(&request_id);
                }
                Err(HostError::new(
                    "timeout",
                    format!("plugin tool '{plugin_id}.{tool}' timed out after {}ms", wait.as_millis()),
                ))
            }
        }
    }

    pub fn complete_invoke(
        &self,
        request_id: &str,
        ok: bool,
        result: Option<Value>,
        error: Option<String>,
    ) -> bool {
        let pending = self
            .pending_sync
            .lock()
            .ok()
            .and_then(|mut guard| guard.remove(request_id));
        let Some(call) = pending else {
            return false;
        };
        let outcome = if ok {
            Ok(result.unwrap_or(Value::Null))
        } else {
            Err(HostError::new(
                "plugin_error",
                error.unwrap_or_else(|| "plugin tool execution failed".to_string()),
            ))
        };
        let _ = call.tx.send(outcome);
        true
    }

    pub fn start_job(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        install_generation: &str,
        tool: &str,
        args: Value,
        artifacts: Vec<ResolvedArtifactDto>,
    ) -> Result<PluginToolInvokeResultDto, HostError> {
        let job_id = Uuid::new_v4().to_string();
        let request_id = Uuid::new_v4().to_string();
        let status = self.create_job_entry(&job_id, plugin_id, tool)?;

        if let Err(err) = app.emit_to(
            EventTarget::webview_window("main"),
            "control:plugin-invoke",
            json!({
                "requestId": request_id,
                "pluginId": plugin_id,
                "installGeneration": install_generation,
                "tool": tool,
                "args": args,
                "artifacts": artifacts,
                "mode": "job",
                "jobId": job_id,
            }),
        ) {
            if let Ok(mut guard) = self.jobs.lock() {
                guard.remove(&job_id);
            }
            return Err(HostError::new(
                "host_unavailable",
                format!("failed to dispatch plugin job invocation: {err}"),
            ));
        }

        Ok(PluginToolInvokeResultDto {
            mode: "job".to_string(),
            result: None,
            job_id: Some(job_id),
            status: Some(status),
        })
    }

    pub(crate) fn create_job_entry(
        &self,
        job_id: &str,
        plugin_id: &str,
        tool: &str,
    ) -> Result<PluginJobStatusDto, HostError> {
        let mut guard = self.jobs.lock().map_err(|_| {
            HostError::new("host_unavailable", "plugin job registry poisoned")
        })?;
        let entry = PluginJobEntry {
            job_id: job_id.to_string(),
            plugin_id: plugin_id.to_string(),
            tool: tool.to_string(),
            state: "running".to_string(),
            result: None,
            error: None,
            next_seq: 1,
            events: VecDeque::new(),
            notify: Arc::new(Notify::new()),
        };
        let status = entry.snapshot(None, 256);
        guard.insert(job_id.to_string(), entry);
        Ok(status)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn push_job_event(
        &self,
        job_id: &str,
        kind: &str,
        message: Option<String>,
        stream: Option<String>,
        progress: Option<f64>,
        data: Option<Value>,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<(), HostError> {
        let notify = {
            let mut guard = self.jobs.lock().map_err(|_| {
                HostError::new("host_unavailable", "plugin job registry poisoned")
            })?;
            let entry = guard.get_mut(job_id).ok_or_else(|| {
                HostError::new("not_found", format!("plugin job '{job_id}' not found"))
            })?;
            if entry.state != "running" {
                return Ok(());
            }
            entry.push_event(kind, message, stream, progress, data);
            match kind {
                "done" => {
                    entry.state = "completed".to_string();
                    entry.result = result;
                }
                "error" => {
                    entry.state = "failed".to_string();
                    entry.error = Some(HostError::new(
                        "plugin_error",
                        error.unwrap_or_else(|| "plugin job failed".to_string()),
                    ));
                }
                "cancelled" => {
                    entry.state = "cancelled".to_string();
                    if let Some(msg) = error {
                        entry.error = Some(HostError::new("cancelled", msg));
                    }
                }
                _ => {}
            }
            Arc::clone(&entry.notify)
        };
        notify.notify_waiters();
        Ok(())
    }

    pub async fn poll_job(
        &self,
        job_id: &str,
        after_seq: Option<u64>,
        wait_ms: u64,
        limit: Option<usize>,
    ) -> Result<PluginJobStatusDto, HostError> {
        let clamped_limit = limit.unwrap_or(256).clamp(1, 1024);
        let clamped_wait = wait_ms.min(MAX_POLL_MS);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(clamped_wait);

        loop {
            let (status, notify) = {
                let guard = self.jobs.lock().map_err(|_| {
                    HostError::new("host_unavailable", "plugin job registry poisoned")
                })?;
                let entry = guard.get(job_id).ok_or_else(|| {
                    HostError::new("not_found", format!("plugin job '{job_id}' not found"))
                })?;
                let status = entry.snapshot(after_seq, clamped_limit);
                (status, Arc::clone(&entry.notify))
            };

            if !status.events.is_empty()
                || status.state != "running"
                || clamped_wait == 0
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(status);
            }

            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            {
                let guard = self.jobs.lock().map_err(|_| {
                    HostError::new("host_unavailable", "plugin job registry poisoned")
                })?;
                let entry = guard.get(job_id).ok_or_else(|| {
                    HostError::new("not_found", format!("plugin job '{job_id}' not found"))
                })?;
                let recheck = entry.snapshot(after_seq, clamped_limit);
                if !recheck.events.is_empty() || recheck.state != "running" {
                    return Ok(recheck);
                }
            }

            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep_until(deadline) => {
                    let guard = self.jobs.lock().map_err(|_| {
                        HostError::new("host_unavailable", "plugin job registry poisoned")
                    })?;
                    let entry = guard.get(job_id).ok_or_else(|| {
                        HostError::new("not_found", format!("plugin job '{job_id}' not found"))
                    })?;
                    return Ok(entry.snapshot(after_seq, clamped_limit));
                }
            }
        }
    }

    pub fn cancel_job(
        &self,
        app: Option<&AppHandle>,
        job_id: &str,
    ) -> Result<PluginJobStatusDto, HostError> {
        let (status, notify, should_emit) = {
            let mut guard = self.jobs.lock().map_err(|_| {
                HostError::new("host_unavailable", "plugin job registry poisoned")
            })?;
            let entry = guard.get_mut(job_id).ok_or_else(|| {
                HostError::new("not_found", format!("plugin job '{job_id}' not found"))
            })?;
            let was_running = entry.state == "running";
            if was_running {
                entry.state = "cancelled".to_string();
                entry.error = Some(HostError::new("cancelled", "plugin job cancelled"));
                entry.push_event("cancelled", Some("cancelled".to_string()), None, None, None);
            }
            (
                entry.snapshot(None, 256),
                Arc::clone(&entry.notify),
                was_running,
            )
        };
        if should_emit {
            notify.notify_waiters();
            if let Some(app) = app {
                let _ = app.emit_to(
                    EventTarget::webview_window("main"),
                    "control:plugin-job-cancel",
                    json!({ "jobId": job_id }),
                );
            }
        }
        Ok(status)
    }

    pub fn job_plugin_and_tool(&self, job_id: &str) -> Option<(String, String)> {
        self.jobs.lock().ok().and_then(|guard| {
            guard
                .get(job_id)
                .map(|entry| (entry.plugin_id.clone(), entry.tool.clone()))
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open_remote_view(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        view_id: &str,
        bound_port_id: Option<String>,
        params: Option<Value>,
        plugins_dir: &Path,
        config_entry: &PluginConfigEntry,
        manifest: &PluginManifest,
        owner_tag: &str,
    ) -> Result<RemoteViewSessionDto, HostError> {
        if !config_entry.enabled
            || manifest.id != plugin_id
            || !manifest.permissions.iter().any(|p| p == "ui:view")
            || !config_entry.granted_permissions.iter().any(|p| p == "ui:view")
        {
            return Err(HostError::new(
                "forbidden",
                format!("plugin '{plugin_id}' is not enabled or lacks ui:view permission"),
            ));
        }
        let view = manifest
            .ui
            .as_ref()
            .and_then(|ui| ui.views.iter().find(|v| v.id == view_id))
            .ok_or_else(|| {
                HostError::new(
                    "not_found",
                    format!("plugin view '{plugin_id}.{view_id}' not found"),
                )
            })?;
        if view.is_trusted_web() {
            return Err(HostError::new(
                "forbidden",
                "trusted-web views cannot be projected remotely",
            ));
        }

        let assets = resources::read_view_assets_for_projection(&plugins_dir.join(plugin_id), view)
            .map_err(|err| HostError::new("host_unavailable", err))?;

        let remote_instance_id = Uuid::new_v4().to_string();
        let document_id = Uuid::new_v4().to_string();

        {
            let mut guard = self.remote_views.lock().map_err(|_| {
                HostError::new("host_unavailable", "remote view registry poisoned")
            })?;
            guard.insert(
                remote_instance_id.clone(),
                RemoteViewProxyEntry {
                    remote_instance_id: remote_instance_id.clone(),
                    plugin_id: plugin_id.to_string(),
                    owner_tag: owner_tag.to_string(),
                    closed: false,
                    next_seq: 1,
                    events: VecDeque::new(),
                    notify: Arc::new(Notify::new()),
                },
            );
        }

        if let Err(err) = app.emit_to(
            EventTarget::webview_window("main"),
            "control:remote-view-open",
            json!({
                "remoteInstanceId": remote_instance_id,
                "documentId": document_id,
                "pluginId": plugin_id,
                "installGeneration": config_entry.install_generation,
                "viewId": view_id,
                "boundPortId": bound_port_id,
                "params": params,
            }),
        ) {
            if let Ok(mut guard) = self.remote_views.lock() {
                guard.remove(&remote_instance_id);
            }
            return Err(HostError::new(
                "host_unavailable",
                format!("failed to start remote view proxy: {err}"),
            ));
        }

        Ok(RemoteViewSessionDto {
            remote_instance_id,
            document_id,
            plugin_id: plugin_id.to_string(),
            plugin_name: manifest.name.clone(),
            install_generation: config_entry.install_generation.clone(),
            view_id: view.id.clone(),
            label: view.label.clone(),
            entry: view.entry.clone(),
            styles: view.styles.clone(),
            assets,
        })
    }

    pub fn send_remote_view_input(
        &self,
        app: &AppHandle,
        remote_instance_id: &str,
        kind: &str,
        payload: Value,
    ) -> Result<Value, HostError> {
        {
            let guard = self.remote_views.lock().map_err(|_| {
                HostError::new("host_unavailable", "remote view registry poisoned")
            })?;
            let entry = guard.get(remote_instance_id).ok_or_else(|| {
                HostError::new(
                    "not_found",
                    format!("remote view session '{remote_instance_id}' not found"),
                )
            })?;
            if entry.closed {
                return Err(HostError::new(
                    "invalid_request",
                    format!("remote view session '{remote_instance_id}' is closed"),
                ));
            }
        }
        app.emit_to(
            EventTarget::webview_window("main"),
            "control:remote-view-input",
            json!({
                "remoteInstanceId": remote_instance_id,
                "kind": kind,
                "payload": payload,
            }),
        )
        .map_err(|err| {
            HostError::new(
                "host_unavailable",
                format!("failed to send remote view input: {err}"),
            )
        })?;
        Ok(json!({ "ok": true }))
    }

    pub fn push_remote_view_event(
        &self,
        remote_instance_id: &str,
        kind: &str,
        payload: Value,
    ) -> Result<(), HostError> {
        let notify = {
            let mut guard = self.remote_views.lock().map_err(|_| {
                HostError::new("host_unavailable", "remote view registry poisoned")
            })?;
            let entry = guard.get_mut(remote_instance_id).ok_or_else(|| {
                HostError::new(
                    "not_found",
                    format!("remote view session '{remote_instance_id}' not found"),
                )
            })?;
            entry.push_event(kind, payload);
            if kind == "closed" {
                entry.closed = true;
            }
            Arc::clone(&entry.notify)
        };
        notify.notify_waiters();
        Ok(())
    }

    pub async fn poll_remote_view_events(
        &self,
        remote_instance_id: &str,
        after_seq: Option<u64>,
        wait_ms: u64,
    ) -> Result<RemoteViewEventPageDto, HostError> {
        let clamped_wait = wait_ms.min(MAX_POLL_MS);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(clamped_wait);

        loop {
            let (page, notify) = {
                let guard = self.remote_views.lock().map_err(|_| {
                    HostError::new("host_unavailable", "remote view registry poisoned")
                })?;
                let entry = guard.get(remote_instance_id).ok_or_else(|| {
                    HostError::new(
                        "not_found",
                        format!("remote view session '{remote_instance_id}' not found"),
                    )
                })?;
                (entry.page(after_seq), Arc::clone(&entry.notify))
            };

            if !page.events.is_empty()
                || page.closed
                || clamped_wait == 0
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(page);
            }

            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            {
                let guard = self.remote_views.lock().map_err(|_| {
                    HostError::new("host_unavailable", "remote view registry poisoned")
                })?;
                let entry = guard.get(remote_instance_id).ok_or_else(|| {
                    HostError::new(
                        "not_found",
                        format!("remote view session '{remote_instance_id}' not found"),
                    )
                })?;
                let recheck = entry.page(after_seq);
                if !recheck.events.is_empty() || recheck.closed {
                    return Ok(recheck);
                }
            }

            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep_until(deadline) => {
                    let guard = self.remote_views.lock().map_err(|_| {
                        HostError::new("host_unavailable", "remote view registry poisoned")
                    })?;
                    let entry = guard.get(remote_instance_id).ok_or_else(|| {
                        HostError::new(
                            "not_found",
                            format!("remote view session '{remote_instance_id}' not found"),
                        )
                    })?;
                    return Ok(entry.page(after_seq));
                }
            }
        }
    }

    pub fn close_remote_view(
        &self,
        app: Option<&AppHandle>,
        remote_instance_id: &str,
    ) -> Result<(), HostError> {
        let removed = {
            let mut guard = self.remote_views.lock().map_err(|_| {
                HostError::new("host_unavailable", "remote view registry poisoned")
            })?;
            guard.remove(remote_instance_id)
        };
        if let Some(mut entry) = removed {
            entry.closed = true;
            entry.notify.notify_waiters();
            if let Some(app) = app {
                let _ = app.emit_to(
                    EventTarget::webview_window("main"),
                    "control:remote-view-close",
                    json!({ "remoteInstanceId": remote_instance_id }),
                );
            }
        }
        Ok(())
    }

    pub fn close_remote_views_by_owner(&self, app: Option<&AppHandle>, owner_tag: &str) {
        let removed: Vec<String> = {
            let Ok(mut guard) = self.remote_views.lock() else {
                return;
            };
            let ids: Vec<String> = guard
                .iter()
                .filter(|(_, entry)| entry.owner_tag == owner_tag)
                .map(|(id, _)| id.clone())
                .collect();
            for id in &ids {
                if let Some(mut entry) = guard.remove(id) {
                    entry.closed = true;
                    entry.notify.notify_waiters();
                }
            }
            ids
        };
        if let Some(app) = app {
            for id in removed {
                let _ = app.emit_to(
                    EventTarget::webview_window("main"),
                    "control:remote-view-close",
                    json!({ "remoteInstanceId": id }),
                );
            }
        }
    }

    pub fn retire_plugin(&self, app: Option<&AppHandle>, plugin_id: &str) {
        if let Ok(mut guard) = self.tools.lock() {
            guard.retain(|t| t.plugin_id != plugin_id);
        }
        if let Ok(mut guard) = self.pending_sync.lock() {
            let keys: Vec<String> = guard
                .iter()
                .filter(|(_, call)| call.plugin_id == plugin_id)
                .map(|(k, _)| k.clone())
                .collect();
            for key in keys {
                if let Some(call) = guard.remove(&key) {
                    let _ = call.tx.send(Err(HostError::new(
                        "host_unavailable",
                        format!("plugin '{plugin_id}' was retired"),
                    )));
                }
            }
        }
        let mut notify_jobs = Vec::new();
        if let Ok(mut guard) = self.jobs.lock() {
            for entry in guard.values_mut() {
                if entry.plugin_id == plugin_id && entry.state == "running" {
                    entry.state = "cancelled".to_string();
                    entry.error = Some(HostError::new(
                        "cancelled",
                        format!("plugin '{plugin_id}' was retired"),
                    ));
                    entry.push_event(
                        "cancelled",
                        Some("plugin retired".to_string()),
                        None,
                        None,
                        None,
                    );
                    notify_jobs.push(Arc::clone(&entry.notify));
                }
            }
        }
        for notify in notify_jobs {
            notify.notify_waiters();
        }
        let closed_views: Vec<String> = {
            if let Ok(mut guard) = self.remote_views.lock() {
                let ids: Vec<String> = guard
                    .iter()
                    .filter(|(_, entry)| entry.plugin_id == plugin_id)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in &ids {
                    if let Some(mut entry) = guard.remove(id) {
                        entry.closed = true;
                        entry.notify.notify_waiters();
                    }
                }
                ids
            } else {
                Vec::new()
            }
        };
        if let Some(app) = app {
            for id in closed_views {
                let _ = app.emit_to(
                    EventTarget::webview_window("main"),
                    "control:remote-view-close",
                    json!({ "remoteInstanceId": id }),
                );
            }
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn job_ring_buffer_polls_and_cancels_cleanly() {
        let bridge = Arc::new(PluginControlBridge::new());
        let initial = bridge
            .create_job_entry("job-1", "com.example.flasher", "flash")
            .unwrap();
        assert_eq!(initial.state, "running");
        assert_eq!(initial.latest_seq, 0);

        for i in 0..(MAX_JOB_EVENTS + 10) {
            bridge
                .push_job_event(
                    "job-1",
                    "log",
                    Some(format!("line {i}")),
                    Some("stdout".into()),
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap();
        }
        let page = bridge.poll_job("job-1", Some(0), 0, Some(1024)).await.unwrap();
        assert_eq!(page.events.len(), 1024);
        assert_eq!(page.events.first().unwrap().seq, 11);
        assert_eq!(page.latest_seq, (MAX_JOB_EVENTS + 10) as u64);
        assert_eq!(page.next_seq, page.events.last().unwrap().seq);

        // Long-poll wakes up when an event is pushed
        let bridge_clone = Arc::clone(&bridge);
        let waiter = tokio::spawn(async move {
            bridge_clone
                .poll_job("job-1", Some((MAX_JOB_EVENTS + 10) as u64), 500, None)
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        bridge
            .push_job_event(
                "job-1",
                "done",
                Some("ok".into()),
                None,
                Some(1.0),
                None,
                Some(json!({ "ok": true })),
                None,
            )
            .unwrap();
        let woke = waiter.await.unwrap().unwrap();
        assert_eq!(woke.state, "completed");
        assert_eq!(woke.result, Some(json!({ "ok": true })));
        assert_eq!(woke.events.last().unwrap().kind, "done");

        // Cancel a running job
        bridge
            .create_job_entry("job-2", "com.example.flasher", "verify")
            .unwrap();
        let cancelled = bridge.cancel_job(None, "job-2").unwrap();
        assert_eq!(cancelled.state, "cancelled");
        assert_eq!(cancelled.events.last().unwrap().kind, "cancelled");
    }

    #[tokio::test]
    async fn retire_plugin_cancels_jobs_and_fails_sync_calls() {
        let bridge = PluginControlBridge::new();
        bridge.sync_plugin_tools(vec![PluginToolDescriptorDto {
            host: "ignored".into(),
            host_label: Some("ignored".into()),
            plugin_id: "com.example.a".into(),
            plugin_name: "A".into(),
            install_generation: "gen-1".into(),
            tool: "ping".into(),
            description: "Ping".into(),
            access: "observe".into(),
            mode: "sync".into(),
            port_scoped: false,
            accepts_artifacts: false,
            input_schema: json!({"type": "object"}),
        }]);
        assert_eq!(bridge.list_local_tools()[0].host, "local");
        assert!(bridge.list_local_tools()[0].host_label.is_none());

        let (tx, rx) = oneshot::channel();
        bridge.pending_sync.lock().unwrap().insert(
            "req-1".into(),
            PendingSyncCall {
                plugin_id: "com.example.a".into(),
                tx,
            },
        );
        bridge
            .create_job_entry("job-a", "com.example.a", "flash")
            .unwrap();

        bridge.retire_plugin(None, "com.example.a");
        assert!(bridge.list_local_tools().is_empty());
        assert_eq!(rx.await.unwrap().unwrap_err().code, "host_unavailable");
        let status = bridge.poll_job("job-a", None, 0, None).await.unwrap();
        assert_eq!(status.state, "cancelled");
    }
}
