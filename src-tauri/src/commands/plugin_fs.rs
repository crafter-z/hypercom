//! Plugin filesystem sessions and raw bounded range/page transport.
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Request, Response};
use tokio::sync::watch;

use super::{file, CommandError};
use crate::plugin::fs_access::{self, DirectoryCursor};
use crate::plugin::io_scheduler::{IoLimits, IoOwner, IoPermit, IoPriority, IoScheduler};
use crate::{plugin, AppState};

#[path = "plugin_file_handles.rs"]
pub mod plugin_file_handles;

const MAX_RANGES: usize = 64;
const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_BATCH_BYTES: u64 = 8 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 512 * 1024;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
const RETENTION: Duration = Duration::from_secs(60);
const MAX_PRE_CANCELLED: usize = 64;
const MIN_RANGE_IO_COST_BYTES: usize = 4096;
const MAX_LIVE_REQUESTS: usize = 128;
const MAX_LIVE_CURSORS: usize = 64;
const SESSION_INVALID: &str = "PLUGIN_FS_SESSION_INVALID";
const RANGE_READ_PERMISSIONS: [&str; 3] = ["fs:assets", "fs:storage", "fs:open-dir"];
const FILE_SESSION_PERMISSIONS: [&str; 5] = ["fs:assets", "fs:storage", "fs:open-dir", "fs:open", "fs:save"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginFsRange {
    pub rel: String,
    pub offset: u64,
    pub length: u64,
    #[serde(default)]
    pub grant_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct RawRangeResult {
    rel: String,
    offset: u64,
    length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct RawMetadata {
    results: Vec<RawRangeResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFsPage {
    entries: Vec<file::PluginDirectoryEntry>,
    next_cursor: Option<String>,
}

struct SessionEntry {
    plugin_id: String,
    generation: String,
    cancel_tx: watch::Sender<bool>,
}

struct RequestEntry {
    key: String,
    plugin_id: String,
    session_id: String,
    permissions: Vec<&'static str>,
    cancel_tx: watch::Sender<bool>,
    state: Mutex<RequestState>,
}

struct RequestState {
    running: bool,
    released: bool,
    completed_at: Option<Instant>,
    permit: Option<IoPermit>,
}

struct CursorEntry {
    plugin_id: String,
    session_id: String,
    grant_id: String,
    rel: String,
    recursive: bool,
    walker: Mutex<DirectoryCursor>,
    last_used: Mutex<Instant>,
}

#[derive(Default)]
struct RegistryState {
    sessions: HashMap<String, Arc<SessionEntry>>,
    requests: HashMap<String, Arc<RequestEntry>>,
    cursors: HashMap<String, Arc<CursorEntry>>,
    pre_cancelled: VecDeque<(String, String, String)>,
}

/// `AppState.plugin_fs: Arc<PluginFsRegistry>`. Invalidation never takes the
/// config lock and may safely be called from the config commit critical section.
pub struct PluginFsRegistry {
    scheduler: Arc<IoScheduler>,
    state: Mutex<RegistryState>,
    reaper_started: AtomicBool,
    file_handles: plugin_file_handles::FileHandleTable,
}

impl Default for PluginFsRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginFsRegistry {
    pub fn new() -> Self {
        Self {
            scheduler: Arc::new(IoScheduler::new(IoLimits::default())),
            state: Mutex::new(RegistryState::default()),
            reaper_started: AtomicBool::new(false),
            file_handles: plugin_file_handles::FileHandleTable::new(),
        }
    }

    pub fn scheduler(&self) -> Arc<IoScheduler> {
        Arc::clone(&self.scheduler)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, RegistryState>, CommandError> {
        self.state
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))
    }

    fn key(plugin_id: &str, session_id: &str, request_id: &str) -> String {
        format!("{plugin_id}\0{session_id}\0{request_id}")
    }

    fn ensure_reaper(self: &Arc<Self>) {
        if self
            .reaper_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let Some(registry) = weak.upgrade() else {
                    break;
                };
                registry.sweep();
            }
        });
    }

    fn sweep(&self) {
        let now = Instant::now();
        if let Ok(mut state) = self.lock() {
            let stale_requests: Vec<String> = state
                .requests
                .iter()
                .filter_map(|(key, entry)| {
                    let request = entry.state.lock().ok()?;
                    (!request.running
                        && request
                            .completed_at
                            .is_some_and(|at| now.saturating_duration_since(at) >= RETENTION))
                    .then_some(key.clone())
                })
                .collect();
            for key in stale_requests {
                if let Some(entry) = state.requests.remove(&key) {
                    if let Ok(mut request) = entry.state.lock() {
                        request.released = true;
                        request.permit.take();
                    }
                }
            }
            let stale_cursors: Vec<String> = state
                .cursors
                .iter()
                .filter_map(|(id, entry)| {
                    let last = entry.last_used.lock().ok()?;
                    (now.saturating_duration_since(*last) >= RETENTION).then_some(id.clone())
                })
                .collect();
            for id in stale_cursors {
                state.cursors.remove(&id);
            }
        }
    }

    fn session(
        &self,
        plugin_id: &str,
        session_id: &str,
        generation: &str,
    ) -> Result<Arc<SessionEntry>, CommandError> {
        let state = self.lock()?;
        let session = state
            .sessions
            .get(session_id)
            .filter(|entry| {
                entry.plugin_id == plugin_id
                    && entry.generation == generation
                    && !*entry.cancel_tx.borrow()
            })
            .ok_or_else(|| CommandError::Other(SESSION_INVALID.into()))?;
        Ok(Arc::clone(session))
    }

    fn open_session(
        self: &Arc<Self>,
        plugin_id: &str,
        generation: &str,
    ) -> Result<String, CommandError> {
        self.ensure_reaper();
        self.invalidate_plugin(plugin_id);
        let id = uuid::Uuid::new_v4().to_string();
        let (cancel_tx, _) = watch::channel(false);
        self.lock()?.sessions.insert(
            id.clone(),
            Arc::new(SessionEntry {
                plugin_id: plugin_id.to_string(),
                generation: generation.to_string(),
                cancel_tx,
            }),
        );
        Ok(id)
    }

    fn close_session(&self, plugin_id: &str, session_id: &str) {
        if let Ok(mut state) = self.lock() {
            if state
                .sessions
                .get(session_id)
                .is_some_and(|entry| entry.plugin_id == plugin_id)
            {
                if let Some(session) = state.sessions.remove(session_id) {
                    session.cancel_tx.send_replace(true);
                }
            }
            for entry in state.requests.values() {
                if entry.plugin_id == plugin_id && entry.session_id == session_id {
                    Self::retire(entry);
                }
            }
            state.requests.retain(|_, entry| {
                !(entry.plugin_id == plugin_id && entry.session_id == session_id)
            });
            state.cursors.retain(|_, entry| {
                !(entry.plugin_id == plugin_id && entry.session_id == session_id)
            });
            state
                .pre_cancelled
                .retain(|item| !(item.0 == plugin_id && item.1 == session_id));
            self.file_handles.retire(|handle| handle.belongs_to_session(plugin_id, session_id));
        }
    }

    fn retire(entry: &RequestEntry) {
        entry.cancel_tx.send_replace(true);
        if let Ok(mut request) = entry.state.lock() {
            request.released = true;
            // A running blocking task owns its permit, never this slot. Removing
            // the registry entry cannot release active I/O capacity early.
            request.permit.take();
        }
    }

    fn cancel_entry(entry: &RequestEntry) {
        // Cancellation stops admission/read work but does not acknowledge a
        // completed response lease. The caller's release (or the shared
        // 60s-abandon registry reaper) drops retained memory bytes.
        entry.cancel_tx.send_replace(true);
    }

    pub fn invalidate_plugin(&self, plugin_id: &str) {
        if let Ok(mut state) = self.lock() {
            state.sessions.retain(|_, session| {
                if session.plugin_id == plugin_id {
                    session.cancel_tx.send_replace(true);
                    false
                } else {
                    true
                }
            });
            state.requests.retain(|_, entry| {
                if entry.plugin_id == plugin_id {
                    Self::retire(entry);
                    false
                } else {
                    true
                }
            });
            state
                .cursors
                .retain(|_, entry| entry.plugin_id != plugin_id);
            state.pre_cancelled.retain(|item| item.0 != plugin_id);
            self.file_handles.retire(|handle| handle.belongs_to_plugin(plugin_id));
        }
    }

    pub(crate) fn revoke_read_permissions(&self, plugin_id: &str, previous: &[String], granted: &[String]) {
        let revoked = |permission: &str| {
            previous.iter().any(|item| item == permission)
                && !granted.iter().any(|item| item == permission)
        };
        if !FILE_SESSION_PERMISSIONS.into_iter().any(revoked) {
            return;
        }
        if !granted.iter().any(|item| FILE_SESSION_PERMISSIONS.contains(&item.as_str())) {
            self.invalidate_plugin(plugin_id);
            return;
        }
        if let Ok(mut state) = self.lock() {
            for entry in state.requests.values().filter(|entry| entry.plugin_id == plugin_id) {
                if entry.permissions.iter().any(|permission| revoked(permission)) {
                    Self::cancel_entry(entry);
                }
            }
            if revoked("fs:open-dir") {
                state.cursors.retain(|_, entry| entry.plugin_id != plugin_id);
            }
            self.file_handles.retire(|handle| handle.belongs_to_plugin(plugin_id) && revoked(handle.permission()));
        }
    }

    pub fn invalidate_all(&self) {
        if let Ok(mut state) = self.lock() {
            for session in state.sessions.values() {
                session.cancel_tx.send_replace(true);
            }
            for entry in state.requests.values() {
                Self::retire(entry);
            }
            state.sessions.clear();
            state.requests.clear();
            state.cursors.clear();
            state.pre_cancelled.clear();
            self.file_handles.retire(|_| true);
        }
    }

    fn admit(
        self: &Arc<Self>,
        plugin_id: &str,
        session_id: &str,
        generation: &str,
        request_id: &str,
        permissions: Vec<&'static str>,
    ) -> Result<Arc<RequestEntry>, CommandError> {
        self.ensure_reaper();
        let key = Self::key(plugin_id, session_id, request_id);
        let mut state = self.lock()?;
        if !state.sessions.get(session_id).is_some_and(|session| {
            session.plugin_id == plugin_id
                && session.generation == generation
                && !*session.cancel_tx.borrow()
        }) {
            return Err(CommandError::Other(SESSION_INVALID.into()));
        }
        if state.requests.len() >= MAX_LIVE_REQUESTS {
            return Err(CommandError::Other("插件 FS 请求已达上限".into()));
        }
        if state.requests.contains_key(&key) {
            return Err(CommandError::Other("插件 FS requestId 重复".into()));
        }
        if let Some(index) = state
            .pre_cancelled
            .iter()
            .position(|item| item.0 == plugin_id && item.1 == session_id && item.2 == request_id)
        {
            state.pre_cancelled.remove(index);
            return Err(cancelled());
        }
        let (cancel_tx, _) = watch::channel(false);
        let entry = Arc::new(RequestEntry {
            key: key.clone(),
            plugin_id: plugin_id.to_string(),
            session_id: session_id.to_string(),
            permissions,
            cancel_tx,
            state: Mutex::new(RequestState {
                running: false,
                released: false,
                completed_at: None,
                permit: None,
            }),
        });
        state.requests.insert(key, Arc::clone(&entry));
        Ok(entry)
    }

    fn start(entry: &RequestEntry) -> Result<(), CommandError> {
        let mut state = entry
            .state
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))?;
        if state.released || *entry.cancel_tx.borrow() {
            return Err(cancelled());
        }
        state.running = true;
        Ok(())
    }

    fn finish(&self, entry: &Arc<RequestEntry>, mut permit: IoPermit) {
        permit.finish_io();
        if let Ok(mut state) = entry.state.lock() {
            state.running = false;
            state.completed_at = Some(Instant::now());
            if !state.released {
                state.permit = Some(permit);
            }
        }
    }

    fn release(&self, plugin_id: &str, session_id: &str, request_id: &str, is_key: bool) {
        let key = if is_key {
            request_id.to_string()
        } else {
            Self::key(plugin_id, session_id, request_id)
        };
        if let Ok(mut state) = self.lock() {
            if let Some(entry) = state.requests.get(&key) {
                if entry.plugin_id != plugin_id || entry.session_id != session_id {
                    return;
                }
                entry.cancel_tx.send_replace(true);
                if let Ok(mut request) = entry.state.lock() {
                    request.released = true;
                    request.permit.take();
                }
            }
            state.requests.remove(&key);
        }
    }

    fn cancel(&self, plugin_id: &str, session_id: &str, request_id: &str) {
        if let Ok(mut state) = self.lock() {
            self.file_handles.retire(|handle| handle.was_picked_by(plugin_id, session_id, request_id));
            let key = Self::key(plugin_id, session_id, request_id);
            if let Some(entry) = state.requests.get(&key) {
                Self::cancel_entry(entry);
                return;
            }
            // Cancel before read is a bounded tombstone scoped to an extant session.
            if !state
                .sessions
                .get(session_id)
                .is_some_and(|entry| entry.plugin_id == plugin_id)
            {
                return;
            }
            if !state
                .pre_cancelled
                .iter()
                .any(|item| item.0 == plugin_id && item.1 == session_id && item.2 == request_id)
            {
                if state.pre_cancelled.len() >= MAX_PRE_CANCELLED {
                    state.pre_cancelled.pop_front();
                }
                state.pre_cancelled.push_back((
                    plugin_id.to_string(),
                    session_id.to_string(),
                    request_id.to_string(),
                ));
            }
        }
    }

    fn cursor(
        &self,
        id: &str,
        plugin_id: &str,
        session_id: &str,
        grant_id: &str,
        rel: Option<&str>,
        recursive: Option<bool>,
    ) -> Result<Arc<CursorEntry>, CommandError> {
        if id.is_empty() || id.len() > 4096 {
            return Err(CommandError::Other("插件 FS 游标无效".into()));
        }
        let mut state = self.lock()?;
        let Some(entry) = state.cursors.get(id).cloned() else {
            return Err(CommandError::Other("插件 FS 游标已失效".into()));
        };
        if entry.plugin_id != plugin_id
            || entry.session_id != session_id
            || entry.grant_id != grant_id
            || rel.is_some_and(|value| value != entry.rel)
            || recursive.is_some_and(|value| value != entry.recursive)
        {
            return Err(CommandError::Other("插件 FS 游标不属于本次目录请求".into()));
        }
        let mut last = entry
            .last_used
            .lock()
            .map_err(|error| CommandError::Lock(error.to_string()))?;
        if last.elapsed() >= RETENTION {
            state.cursors.remove(id);
            return Err(CommandError::Other("插件 FS 游标已过期".into()));
        }
        *last = Instant::now();
        drop(last);
        Ok(entry)
    }

    fn retire_cursor(&self, cursor_id: &str) {
        if let Ok(mut state) = self.lock() {
            state.cursors.remove(cursor_id);
        }
    }

    fn insert_cursor(
        self: &Arc<Self>,
        entry: CursorEntry,
        plugin_id: &str,
        session_id: &str,
    ) -> Result<String, CommandError> {
        self.ensure_reaper();
        let id = uuid::Uuid::new_v4().to_string();
        let mut state = self.lock()?;
        if !state
            .sessions
            .get(session_id)
            .is_some_and(|session| session.plugin_id == plugin_id && !*session.cancel_tx.borrow())
        {
            return Err(CommandError::Other(SESSION_INVALID.into()));
        }
        if state.cursors.len() >= MAX_LIVE_CURSORS {
            return Err(CommandError::Other("插件 FS 游标已达上限".into()));
        }
        state.cursors.insert(id.clone(), Arc::new(entry));
        Ok(id)
    }
}

struct Admission {
    registry: Arc<PluginFsRegistry>,
    entry: Arc<RequestEntry>,
    delivered: bool,
    cursor_id: Option<String>,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if !self.delivered {
            self.entry.cancel_tx.send_replace(true);
            self.registry.release(
                &self.entry.plugin_id,
                &self.entry.session_id,
                &self.entry.key,
                true,
            );
            if let Some(cursor_id) = self.cursor_id.as_deref() {
                self.registry.retire_cursor(cursor_id);
            }
        }
    }
}

pub(crate) async fn blocking_open<T, F>(
    permit: IoPermit,
    work: F,
) -> Result<(T, IoPermit), CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    // Keep admission with the actual OS task, not with its cancellable waiter.
    tokio::task::spawn_blocking(move || work().map(|result| (result, permit)))
        .await
        .map_err(|error| CommandError::Other(format!("插件 FS 打开任务失败: {error}")))?
}

fn cancelled() -> CommandError {
    CommandError::Other("插件 FS 请求已取消".into())
}
fn check_cancel(entry: &RequestEntry) -> Result<(), CommandError> {
    if *entry.cancel_tx.borrow() {
        Err(cancelled())
    } else {
        Ok(())
    }
}

/// Tauri 2.12.5 `ipc/protocol.rs::parse_invoke_request` preserves these automatic
/// fetch/custom-protocol headers. `post_message` supplies only options.headers;
/// therefore accepting its raw response would cause Tauri to serialize via eval.
/// Neither our frontend nor the Worker supplies these transport evidence headers.
pub(crate) fn require_raw_transport(request: &Request<'_>) -> Result<(), CommandError> {
    require_raw_headers(request.headers())
}

pub(crate) fn require_raw_transport_for_legacy(request: &Request<'_>) -> Result<(), CommandError> {
    require_raw_transport(request)
}
fn require_raw_headers(headers: &http::HeaderMap) -> Result<(), CommandError> {
    if ["tauri-invoke-key", "origin"].iter().any(|name| {
        headers
            .get(*name)
            .is_none_or(|value| value.as_bytes().is_empty())
    }) {
        return Err(CommandError::Other(
            "PLUGIN_FS_RAW_UNSUPPORTED: 仅支持 Tauri custom protocol raw transport".into(),
        ));
    }
    Ok(())
}

fn validate_request_ids(
    plugin_id: &str,
    session_id: &str,
    request_id: &str,
) -> Result<(), CommandError> {
    plugin::validate_plugin_id(plugin_id).map_err(CommandError::Other)?;
    uuid::Uuid::parse_str(session_id).map_err(|_| CommandError::Other(SESSION_INVALID.into()))?;
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(CommandError::Other("插件 FS requestId 无效".into()));
    }
    Ok(())
}

fn snapshot(
    state: &AppState,
    plugin_id: &str,
    generation: &str,
) -> Result<FsSnapshot, CommandError> {
    plugin::validate_plugin_id(plugin_id).map_err(CommandError::Other)?;
    let (root, granted) = {
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
            .ok_or_else(|| CommandError::Other(SESSION_INVALID.into()))?;
        if generation.is_empty() || !entry.enabled || entry.install_generation != generation {
            return Err(CommandError::Other(SESSION_INVALID.into()));
        }
        (
            super::plugin::plugin_dir(manager.plugins_dir(), plugin_id)?,
            entry.granted_permissions.clone(),
        )
    };
    // The host may have been launched with --config ../profile/config.json.
    // Resolve that host-owned root, never a plugin-supplied relative path.
    let root = if root
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        root.canonicalize()
            .map_err(|error| CommandError::Io(error.to_string()))?
    } else {
        root
    };
    let manifest = plugin::load_manifest_lite(&root).map_err(CommandError::Other)?;
    if manifest.id != plugin_id {
        return Err(CommandError::Other("manifest id 与插件目录不一致".into()));
    }
    Ok(FsSnapshot {
        root,
        granted,
        manifest,
    })
}
struct FsSnapshot {
    root: PathBuf,
    granted: Vec<String>,
    manifest: plugin::PluginManifest,
}

fn authorize_snapshot(
    snapshot: &FsSnapshot,
    plugin_id: &str,
    generation: &str,
    permission: &str,
    grant_id: Option<&str>,
) -> Result<PathBuf, CommandError> {
    if !snapshot.granted.iter().any(|item| item == permission)
        || !snapshot
            .manifest
            .permissions
            .iter()
            .any(|item| item == permission)
    {
        return Err(CommandError::Other(format!(
            "插件未授予或未声明 {permission}: {plugin_id}"
        )));
    }
    match grant_id {
        Some(id) => file::directory_grant_root(plugin_id, id, generation),
        None => Ok(snapshot.root.clone()),
    }
}

fn authorize(
    state: &AppState,
    plugin_id: &str,
    generation: &str,
    permission: &str,
    grant_id: Option<&str>,
) -> Result<PathBuf, CommandError> {
    let snapshot = snapshot(state, plugin_id, generation)?;
    authorize_snapshot(&snapshot, plugin_id, generation, permission, grant_id)
}
fn admit_read(
    state: &AppState,
    plugin_id: &str,
    session_id: &str,
    generation: &str,
    request_id: &str,
    permissions: Vec<&'static str>,
) -> Result<Arc<RequestEntry>, CommandError> {
    // The caller has already checked manifest declarations and directory grants.
    // Serialize the current grant check + request registration with config commit
    // so a revocation cannot miss a newly admitted request using an old snapshot.
    let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
    let entry = super::plugin::state_of(manager.get_config(), plugin_id)
        .filter(|entry| entry.enabled && entry.install_generation == generation)
        .ok_or_else(|| CommandError::Other(SESSION_INVALID.into()))?;
    for permission in &permissions {
        if !entry.granted_permissions.iter().any(|granted| granted == permission) {
            return Err(CommandError::Other(format!("插件未授予或未声明 {permission}: {plugin_id}")));
        }
    }
    state.plugin_fs.admit(plugin_id, session_id, generation, request_id, permissions)
}

fn normalized_rel(rel: &str) -> Result<String, CommandError> {
    if rel.len() > 4096 || rel.encode_utf16().count() > 4096 {
        return Err(CommandError::Other("插件 FS 相对路径超长".into()));
    }
    let path = plugin::sanitize_plugin_rel_path(rel).map_err(CommandError::Other)?;
    let mut parts: Vec<String> = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts
        .first()
        .is_some_and(|part| part.eq_ignore_ascii_case("data"))
    {
        parts[0] = "data".into();
    }
    Ok(parts.join("/"))
}
fn permission_for(rel: &str, grant_id: Option<&str>) -> &'static str {
    if grant_id.is_some() {
        "fs:open-dir"
    } else if rel.split('/').next() == Some("data") {
        "fs:storage"
    } else {
        "fs:assets"
    }
}
fn validate_ranges(ranges: &[PluginFsRange]) -> Result<(Vec<String>, usize), CommandError> {
    if ranges.is_empty() || ranges.len() > MAX_RANGES {
        return Err(CommandError::Other("插件 FS ranges 数量必须为 1–64".into()));
    }
    let mut total = 0u64;
    let mut paths = Vec::with_capacity(ranges.len());
    for range in ranges {
        let path = if range.grant_id.is_some() {
            file::sanitize_directory_rel(&range.rel)?.1
        } else {
            normalized_rel(&range.rel)?
        };
        if path.is_empty() {
            return Err(CommandError::Other("插件 FS 文件相对路径不能为空".into()));
        }
        paths.push(path);
        if range.offset > MAX_SAFE_JS_INTEGER
            || range.length > MAX_RANGE_BYTES
            || range
                .offset
                .checked_add(range.length)
                .is_none_or(|end| end > MAX_SAFE_JS_INTEGER)
        {
            return Err(CommandError::Other(
                "插件 FS 范围无效或单范围超过 4 MiB".into(),
            ));
        }
        total = total
            .checked_add(range.length)
            .ok_or_else(|| CommandError::Other("插件 FS 批量范围溢出".into()))?;
        if total > MAX_BATCH_BYTES {
            return Err(CommandError::Other("插件 FS 批量范围超过 8 MiB".into()));
        }
        if range
            .grant_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err(CommandError::Other("目录授权标识无效".into()));
        }
    }
    Ok((paths, total as usize))
}
fn encode_frame(results: Vec<RawRangeResult>, payload: Vec<u8>) -> Result<Response, CommandError> {
    let metadata = serde_json::to_vec(&RawMetadata { results })
        .map_err(|error| CommandError::Other(error.to_string()))?;
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(CommandError::Other("插件 FS 元数据超过 512 KiB".into()));
    }
    let mut frame = Vec::with_capacity(8 + metadata.len() + payload.len());
    frame.extend_from_slice(b"HCFR");
    frame.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    frame.extend_from_slice(&metadata);
    frame.extend_from_slice(&payload);
    Ok(Response::new(frame))
}

#[tauri::command]
pub async fn plugin_fs_open_session(
    plugin_id: String,
    expected_generation: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<String, CommandError> {
    super::plugin::require_main_window(&window)?;
    let _gate = super::plugin::acquire_plugin_io(&state).await?;
    let snapshot = snapshot(&state, &plugin_id, &expected_generation)?;
    if !FILE_SESSION_PERMISSIONS.iter()
        .any(|permission| {
            snapshot.granted.iter().any(|item| item == permission)
                && snapshot
                    .manifest
                    .permissions
                    .iter()
                    .any(|item| item == permission)
        })
    {
        return Err(CommandError::Other("插件未授予可用文件系统权限".into()));
    }
    state
        .plugin_fs
        .open_session(&plugin_id, &expected_generation)
}
#[tauri::command]
pub async fn plugin_fs_close_session(
    plugin_id: String,
    session_id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), CommandError> {
    super::plugin::require_main_window(&window)?;
    plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    state.plugin_fs.close_session(&plugin_id, &session_id);
    Ok(())
}
#[tauri::command]
pub async fn plugin_fs_cancel(
    plugin_id: String,
    session_id: String,
    request_id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), CommandError> {
    super::plugin::require_main_window(&window)?;
    validate_request_ids(&plugin_id, &session_id, &request_id)?;
    state.plugin_fs.cancel(&plugin_id, &session_id, &request_id);
    Ok(())
}
#[tauri::command]
pub async fn plugin_fs_release(
    plugin_id: String,
    session_id: String,
    request_id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), CommandError> {
    super::plugin::require_main_window(&window)?;
    validate_request_ids(&plugin_id, &session_id, &request_id)?;
    state
        .plugin_fs
        .release(&plugin_id, &session_id, &request_id, false);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plugin_fs_read_ranges(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    request_id: String,
    ranges: Vec<PluginFsRange>,
    priority: Option<IoPriority>,
    request: Request<'_>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Response, CommandError> {
    super::plugin::require_main_window(&window)?;
    require_raw_transport(&request)?;
    validate_request_ids(&plugin_id, &session_id, &request_id)?;
    state
        .plugin_fs
        .session(&plugin_id, &session_id, &expected_generation)?;
    let (paths, total) = validate_ranges(&ranges)?;
    // Entire batch authorization precedes any I/O or scheduler admission;
    // one manifest/config snapshot serves every range in this batch.
    let fs_snapshot = snapshot(&state, &plugin_id, &expected_generation)?;
    let mut permissions = Vec::with_capacity(RANGE_READ_PERMISSIONS.len());
    for (range, path) in ranges.iter().zip(&paths) {
        let permission = permission_for(path, range.grant_id.as_deref());
        authorize_snapshot(
            &fs_snapshot,
            &plugin_id,
            &expected_generation,
            permission,
            range.grant_id.as_deref(),
        )?;
        if !permissions.contains(&permission) {
            permissions.push(permission);
        }
    }
    let registry = Arc::clone(&state.plugin_fs);
    let entry = admit_read(&state, &plugin_id, &session_id, &expected_generation, &request_id, permissions)?;
    let mut admission = Admission {
        registry: Arc::clone(&registry),
        entry: Arc::clone(&entry),
        delivered: false,
        cursor_id: None,
    };
    let memory_bytes = total.saturating_mul(2).saturating_add(MAX_METADATA_BYTES);
    let io_cost = total.max(ranges.len().saturating_mul(MIN_RANGE_IO_COST_BYTES));
    let permit = registry
        .scheduler
        .acquire_with_cost(
            IoOwner {
                plugin_id: plugin_id.clone(),
                session_id: session_id.clone(),
            },
            memory_bytes,
            io_cost,
            priority.unwrap_or_default(),
            entry.cancel_tx.subscribe(),
        )
        .await
        .map_err(CommandError::Other)?;
    // Range reads do not take the global lifecycle gate: invalidation is
    // represented by the session watch and the native authority rechecks below.
    registry.session(&plugin_id, &session_id, &expected_generation)?;
    check_cancel(&entry)?;
    let fs_snapshot = snapshot(&state, &plugin_id, &expected_generation)?;
    let mut open_inputs = Vec::with_capacity(ranges.len());
    for (range, path) in ranges.iter().zip(&paths) {
        let root = authorize_snapshot(
            &fs_snapshot,
            &plugin_id,
            &expected_generation,
            permission_for(path, range.grant_id.as_deref()),
            range.grant_id.as_deref(),
        )?;
        open_inputs.push((root, path.clone(), range.grant_id.is_some()));
    }
    // Potentially blocking handle opens retain their permit even if the command
    // waiter is abandoned, and can stop between components/files on cancellation.
    let open_entry = Arc::clone(&entry);
    let (opened, permit) = blocking_open(permit, move || {
        let mut opened = Vec::with_capacity(open_inputs.len());
        for (root, path, directory_grant) in open_inputs {
            check_cancel(&open_entry)?;
            opened.push(if directory_grant {
                fs_access::open_directory_range_file(&root, &path)
            } else {
                fs_access::open_regular_file(&root, &path)
            });
        }
        Ok(opened)
    })
    .await?;
    registry.session(&plugin_id, &session_id, &expected_generation)?;
    let opened_snapshot = snapshot(&state, &plugin_id, &expected_generation)?;
    for (range, path) in ranges.iter().zip(&paths) {
        authorize_snapshot(
            &opened_snapshot,
            &plugin_id,
            &expected_generation,
            permission_for(path, range.grant_id.as_deref()),
            range.grant_id.as_deref(),
        )?;
    }
    check_cancel(&entry)?;
    PluginFsRegistry::start(&entry)?;
    let worker_entry = Arc::clone(&entry);
    let worker_registry = Arc::clone(&registry);
    let worker_ranges = ranges.clone();
    let (results, payload) = tokio::task::spawn_blocking(move || {
        let outcome = (|| {
            let mut payload = Vec::with_capacity(total);
            let mut results = Vec::with_capacity(worker_ranges.len());
            for (range, opened) in worker_ranges.into_iter().zip(opened) {
                check_cancel(&worker_entry)?;
                let offset = payload.len() as u64;
                match opened.and_then(|file| {
                    fs_access::read_open_range(file, range.offset, range.length as usize)
                }) {
                    Ok(bytes) => {
                        let length = bytes.len() as u64;
                        payload.extend_from_slice(&bytes);
                        results.push(RawRangeResult {
                            rel: range.rel,
                            offset,
                            length,
                            error: None,
                        });
                    }
                    Err(error) => results.push(RawRangeResult {
                        rel: range.rel,
                        offset,
                        length: 0,
                        error: Some(error),
                    }),
                }
            }
            check_cancel(&worker_entry)?;
            Ok((results, payload))
        })();
        worker_registry.finish(&worker_entry, permit);
        outcome
    })
    .await
    .map_err(|error| CommandError::Other(format!("插件 FS 读取任务失败: {error}")))??;
    registry.session(&plugin_id, &session_id, &expected_generation)?;
    let delivered_snapshot = snapshot(&state, &plugin_id, &expected_generation)?;
    for (range, path) in ranges.iter().zip(&paths) {
        authorize_snapshot(
            &delivered_snapshot,
            &plugin_id,
            &expected_generation,
            permission_for(path, range.grant_id.as_deref()),
            range.grant_id.as_deref(),
        )?;
    }
    let response = encode_frame(results, payload)?;
    check_cancel(&entry)?;
    admission.delivered = true;
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plugin_fs_list_directory_page(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    request_id: String,
    grant_id: String,
    rel_path: Option<String>,
    recursive: Option<bool>,
    cursor: Option<String>,
    limit: Option<usize>,
    priority: Option<IoPriority>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<PluginFsPage, CommandError> {
    super::plugin::require_main_window(&window)?;
    validate_request_ids(&plugin_id, &session_id, &request_id)?;
    let registry = Arc::clone(&state.plugin_fs);
    registry.session(&plugin_id, &session_id, &expected_generation)?;
    let limit = limit.unwrap_or(256);
    if !(1..=1000).contains(&limit) {
        return Err(CommandError::Other("插件 FS limit 必须为 1–1000".into()));
    }
    let requested_rel = if let Some(value) = rel_path.as_deref() {
        if value.len() > 4096 || value.encode_utf16().count() > 4096 {
            return Err(CommandError::Other("插件 FS 相对路径超长".into()));
        }
        Some(file::sanitize_directory_rel(value)?.1)
    } else {
        None
    };
    let requested_recursive = recursive;
    authorize(
        &state,
        &plugin_id,
        &expected_generation,
        "fs:open-dir",
        Some(&grant_id),
    )?;
    let existing_cursor = cursor
        .as_deref()
        .map(|id| {
            registry.cursor(
                id,
                &plugin_id,
                &session_id,
                &grant_id,
                requested_rel.as_deref(),
                requested_recursive,
            )
        })
        .transpose()?;
    let (rel, recursive) = existing_cursor
        .as_ref()
        .map(|entry| (entry.rel.clone(), entry.recursive))
        .unwrap_or_else(|| {
            (
                requested_rel.clone().unwrap_or_default(),
                requested_recursive.unwrap_or(false),
            )
        });
    let entry = admit_read(&state, &plugin_id, &session_id, &expected_generation, &request_id, vec!["fs:open-dir"])?;
    let mut admission = Admission {
        registry: Arc::clone(&registry),
        entry: Arc::clone(&entry),
        delivered: false,
        cursor_id: None,
    };
    // Reserve a bounded metadata/result lease until host acknowledgement. The
    // walker itself remains incremental; this is not a content-size cap.
    let permit = registry
        .scheduler
        .acquire_with_cost(
            IoOwner {
                plugin_id: plugin_id.clone(),
                session_id: session_id.clone(),
            },
            2 * 1024 * 1024,
            1024 * 1024,
            priority.unwrap_or_default(),
            entry.cancel_tx.subscribe(),
        )
        .await
        .map_err(CommandError::Other)?;
    registry.session(&plugin_id, &session_id, &expected_generation)?;
    check_cancel(&entry)?;
    let root = authorize(
        &state,
        &plugin_id,
        &expected_generation,
        "fs:open-dir",
        Some(&grant_id),
    )?;
    let (cursor_id, permit) = match cursor {
        Some(id) => {
            registry.cursor(
                &id,
                &plugin_id,
                &session_id,
                &grant_id,
                Some(&rel),
                Some(recursive),
            )?;
            (id, permit)
        }
        None => {
            let open_root = root.clone();
            let open_rel = rel.clone();
            let open_entry = Arc::clone(&entry);
            let (walker, permit) = blocking_open(permit, move || {
                check_cancel(&open_entry)?;
                DirectoryCursor::open(&open_root, &open_rel, recursive).map_err(CommandError::Other)
            })
            .await?;
            let id = registry.insert_cursor(
                CursorEntry {
                    plugin_id: plugin_id.clone(),
                    session_id: session_id.clone(),
                    grant_id: grant_id.clone(),
                    rel: rel.clone(),
                    recursive,
                    walker: Mutex::new(walker),
                    last_used: Mutex::new(Instant::now()),
                },
                &plugin_id,
                &session_id,
            )?;
            (id, permit)
        }
    };
    admission.cursor_id = Some(cursor_id.clone());
    let cursor_entry = registry.cursor(
        &cursor_id,
        &plugin_id,
        &session_id,
        &grant_id,
        Some(&rel),
        Some(recursive),
    )?;
    registry.session(&plugin_id, &session_id, &expected_generation)?;
    check_cancel(&entry)?;
    PluginFsRegistry::start(&entry)?;
    let worker_entry = Arc::clone(&entry);
    let worker_registry = Arc::clone(&registry);
    let (entries, more) = tokio::task::spawn_blocking(move || {
        let result = (|| {
            check_cancel(&worker_entry)?;
            let mut walker = cursor_entry
                .walker
                .lock()
                .map_err(|error| CommandError::Lock(error.to_string()))?;
            let (entries, more) = walker.next_page(limit).map_err(CommandError::Other)?;
            check_cancel(&worker_entry)?;
            Ok((entries, more))
        })();
        worker_registry.finish(&worker_entry, permit);
        result
    })
    .await
    .map_err(|error| CommandError::Other(format!("插件 FS 目录任务失败: {error}")))??;
    registry.session(&plugin_id, &session_id, &expected_generation)?;
    authorize(
        &state,
        &plugin_id,
        &expected_generation,
        "fs:open-dir",
        Some(&grant_id),
    )?;
    check_cancel(&entry)?;
    if !more {
        registry.lock()?.cursors.remove(&cursor_id);
    }
    let entries = entries
        .into_iter()
        .map(|entry| {
            if entry.size > MAX_SAFE_JS_INTEGER || entry.modified_ms > MAX_SAFE_JS_INTEGER {
                return Err(CommandError::Other("PLUGIN_FS_ENTRY_UNSAFE_INTEGER".into()));
            }
            Ok(file::PluginDirectoryEntry {
                name: entry.name,
                rel: entry.rel,
                kind: entry.kind.to_string(),
                size: entry.size,
                modified_ms: entry.modified_ms,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    admission.delivered = true;
    Ok(PluginFsPage {
        entries,
        next_cursor: more.then_some(cursor_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::IpcResponse;

    #[test]
    fn only_removed_read_authority_cancels_registered_file_requests() {
        let id = "com.test.scoped";
        let registry = Arc::new(PluginFsRegistry::new());
        let session = registry.open_session(id, "g").unwrap();
        let assets = registry.admit(id, &session, "g", "asset", vec!["fs:assets"]).unwrap();
        let directory = registry.admit(id, &session, "g", "dir", vec!["fs:open-dir"]).unwrap();
        let mixed = registry.admit(id, &session, "g", "mixed", vec!["fs:assets", "fs:open-dir"]).unwrap();
        let permissions = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let original = permissions(&["fs:assets", "fs:open-dir", "fs:write-dir", "notify"]);
        let unrelated_change = permissions(&["fs:assets", "fs:open-dir", "fs:storage"]);
        registry.revoke_read_permissions(id, &original, &unrelated_change);
        assert!(check_cancel(&assets).is_ok());
        assert!(check_cancel(&directory).is_ok());
        assert!(check_cancel(&mixed).is_ok());
        assert!(registry.session(id, &session, "g").is_ok());

        let without_directory = permissions(&["fs:assets", "fs:storage"]);
        registry.revoke_read_permissions(id, &unrelated_change, &without_directory);
        assert!(check_cancel(&assets).is_ok());
        assert!(check_cancel(&directory).is_err());
        assert!(check_cancel(&mixed).is_err());
        assert!(registry.session(id, &session, "g").is_ok());

        registry.revoke_read_permissions(id, &without_directory, &unrelated_change);
        assert!(check_cancel(&directory).is_err(), "regrant cannot revive an old request");
        assert!(check_cancel(&assets).is_ok());
        registry.revoke_read_permissions(id, &unrelated_change, &[]);
        assert!(check_cancel(&assets).is_err());
        assert!(registry.session(id, &session, "g").is_err());
    }

    #[test]
    fn range_bounds_and_safe_integer_validation() {
        let range = PluginFsRange {
            rel: "data/x".into(),
            offset: 0,
            length: 0,
            grant_id: None,
        };
        assert_eq!(validate_ranges(std::slice::from_ref(&range)).unwrap().1, 0);
        assert!(validate_ranges(&[]).is_err());
        assert!(validate_ranges(&[PluginFsRange {
            length: MAX_RANGE_BYTES + 1,
            ..range.clone()
        }])
        .is_err());
        assert!(validate_ranges(&[PluginFsRange {
            offset: MAX_SAFE_JS_INTEGER,
            length: 1,
            ..range.clone()
        }])
        .is_err());
        assert!(validate_ranges(&[PluginFsRange {
            rel: "../secret".into(),
            ..range
        }])
        .is_err());
    }
    #[test]
    fn directory_ranges_preserve_native_case_and_package_rules_stay_separate() {
        let directory = PluginFsRange {
            rel: "DATA/file.bin".into(),
            offset: 0,
            length: 1,
            grant_id: Some("grant".into()),
        };
        assert_eq!(
            validate_ranges(std::slice::from_ref(&directory)).unwrap().0,
            ["DATA/file.bin"]
        );
        let package = PluginFsRange {
            grant_id: None,
            ..directory
        };
        assert_eq!(validate_ranges(&[package]).unwrap().0, ["data/file.bin"]);
        #[cfg(unix)]
        for name in ["a~b", "a:b", "a.", "a "] {
            let range = PluginFsRange {
                rel: name.into(),
                offset: 0,
                length: 1,
                grant_id: Some("grant".into()),
            };
            assert_eq!(validate_ranges(&[range]).unwrap().0, [name]);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn abandoned_open_waiter_keeps_real_io_admission_until_work_exits() {
        let scheduler = Arc::new(IoScheduler::new(IoLimits {
            global_concurrency: 1,
            ..Default::default()
        }));
        let (_cancel, cancellation) = watch::channel(false);
        let permit = scheduler
            .acquire(
                IoOwner {
                    plugin_id: "first".into(),
                    session_id: "first".into(),
                },
                1,
                IoPriority::Interactive,
                cancellation.clone(),
            )
            .await
            .unwrap();
        let (started, startup) = tokio::sync::oneshot::channel();
        let (unblock, blocked) = std::sync::mpsc::channel();
        let command = tokio::spawn(async move {
            blocking_open(permit, move || {
                let _ = started.send(());
                blocked
                    .recv()
                    .map_err(|error| CommandError::Other(error.to_string()))?;
                Ok(())
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), startup)
            .await
            .unwrap()
            .unwrap();
        command.abort();
        let _ = command.await;
        let waiting = tokio::spawn(async move {
            scheduler
                .acquire(
                    IoOwner {
                        plugin_id: "next".into(),
                        session_id: "next".into(),
                    },
                    1,
                    IoPriority::Interactive,
                    cancellation,
                )
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !waiting.is_finished(),
            "the still-running OS task must retain its permit"
        );
        unblock.send(()).unwrap();
        let permit = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        drop(permit);
    }

    #[test]
    fn frame_has_binary_payload_and_omits_null_error() {
        let response = encode_frame(
            vec![RawRangeResult {
                rel: "x".into(),
                offset: 0,
                length: 2,
                error: None,
            }],
            vec![0, 255],
        )
        .unwrap();
        let tauri::ipc::InvokeResponseBody::Raw(bytes) = response.body().unwrap() else {
            panic!("not raw")
        };
        assert_eq!(&bytes[..4], b"HCFR");
        let len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let metadata: serde_json::Value = serde_json::from_slice(&bytes[8..8 + len]).unwrap();
        assert!(metadata["results"][0].get("error").is_none());
        assert_eq!(&bytes[8 + len..], &[0, 255]);
    }
    #[test]
    fn fallback_headers_are_rejected() {
        let mut headers = http::HeaderMap::new();
        assert!(require_raw_headers(&headers)
            .unwrap_err()
            .to_string()
            .contains("PLUGIN_FS_RAW_UNSUPPORTED"));
        headers.insert("tauri-invoke-key", "key".parse().unwrap());
        assert!(require_raw_headers(&headers).is_err());
        headers.insert("origin", "http://tauri.localhost".parse().unwrap());
        assert!(require_raw_headers(&headers).is_ok());
    }
    #[tokio::test]
    async fn session_replacement_cancels_old_requests_and_precancel_is_bounded() {
        let registry = Arc::new(PluginFsRegistry::new());
        let first = registry.open_session("com.test.fs", "generation").unwrap();
        let request = registry
            .admit("com.test.fs", &first, "generation", "r", vec!["fs:assets"])
            .unwrap();
        let second = registry.open_session("com.test.fs", "generation").unwrap();
        assert!(registry
            .session("com.test.fs", &first, "generation")
            .is_err());
        assert!(*request.cancel_tx.borrow());
        assert!(registry
            .session("com.test.fs", &second, "generation")
            .is_ok());
        for n in 0..100 {
            registry.cancel("com.test.fs", &second, &format!("r{n}"));
        }
        assert_eq!(
            registry.lock().unwrap().pre_cancelled.len(),
            MAX_PRE_CANCELLED
        );
        assert!(registry
            .admit("com.test.fs", &second, "generation", "r99", vec!["fs:assets"])
            .is_err());
        registry.invalidate_all();
        assert!(registry
            .session("com.test.fs", &second, "generation")
            .is_err());
    }
    #[test]
    fn failed_page_admission_retires_cursor() {
        // macOS commonly exposes the temporary directory through a symlink
        // (`/var` -> `/private/var`).  The handle-based opener rejects symlink
        // path components, so anchor this fixture at the canonical temp root.
        let root = std::env::temp_dir()
            .join(format!("hypercom-plugin-fs-page-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let registry = Arc::new(PluginFsRegistry::new());
        let session = registry.open_session("com.test.fs", "g").unwrap();
        let walker = DirectoryCursor::open(&root, "", false).unwrap();
        let cursor_id = registry
            .insert_cursor(
                CursorEntry {
                    plugin_id: "com.test.fs".into(),
                    session_id: session.clone(),
                    grant_id: "grant".into(),
                    rel: String::new(),
                    recursive: false,
                    walker: Mutex::new(walker),
                    last_used: Mutex::new(Instant::now()),
                },
                "com.test.fs",
                &session,
            )
            .unwrap();
        let entry = registry.admit("com.test.fs", &session, "g", "r", vec!["fs:assets"]).unwrap();
        let admission = Admission {
            registry: Arc::clone(&registry),
            entry,
            delivered: false,
            cursor_id: Some(cursor_id.clone()),
        };
        drop(admission);
        assert!(!registry.lock().unwrap().cursors.contains_key(&cursor_id));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancel_retains_completed_lease_until_release() {
        let registry = Arc::new(PluginFsRegistry::new());
        let session = registry.open_session("com.test.fs", "g").unwrap();
        let entry = registry.admit("com.test.fs", &session, "g", "r", vec!["fs:assets"]).unwrap();
        let permit = registry
            .scheduler
            .acquire(
                IoOwner {
                    plugin_id: "com.test.fs".into(),
                    session_id: session.clone(),
                },
                1,
                IoPriority::Interactive,
                entry.cancel_tx.subscribe(),
            )
            .await
            .unwrap();
        PluginFsRegistry::start(&entry).unwrap();
        registry.cancel("com.test.fs", &session, "r");
        registry.finish(&entry, permit);
        assert!(entry.state.lock().unwrap().permit.is_some());
        registry.release("com.test.fs", &session, "r", false);
        assert!(entry.state.lock().unwrap().permit.is_none());
    }

    #[tokio::test]
    async fn shared_reaper_reclaims_expired_completed_lease() {
        let registry = Arc::new(PluginFsRegistry::new());
        let session = registry.open_session("com.test.fs", "g").unwrap();
        let entry = registry.admit("com.test.fs", &session, "g", "r", vec!["fs:assets"]).unwrap();
        let permit = registry
            .scheduler
            .acquire(
                IoOwner {
                    plugin_id: "com.test.fs".into(),
                    session_id: session.clone(),
                },
                1,
                IoPriority::Interactive,
                entry.cancel_tx.subscribe(),
            )
            .await
            .unwrap();
        PluginFsRegistry::start(&entry).unwrap();
        registry.finish(&entry, permit);
        entry.state.lock().unwrap().completed_at =
            Some(Instant::now() - RETENTION - Duration::from_secs(1));
        registry.sweep();
        assert!(!registry.lock().unwrap().requests.contains_key(&entry.key));
    }

    #[tokio::test]
    async fn release_does_not_erase_cursors_and_running_permit_is_not_early_released() {
        let registry = Arc::new(PluginFsRegistry::new());
        let session = registry.open_session("com.test.fs", "g").unwrap();
        let entry = registry.admit("com.test.fs", &session, "g", "r", vec!["fs:assets"]).unwrap();
        let permit = registry
            .scheduler
            .acquire(
                IoOwner {
                    plugin_id: "com.test.fs".into(),
                    session_id: session.clone(),
                },
                1,
                IoPriority::Interactive,
                entry.cancel_tx.subscribe(),
            )
            .await
            .unwrap();
        PluginFsRegistry::start(&entry).unwrap();
        registry.release("com.test.fs", &session, "r", false);
        registry.finish(&entry, permit);
        assert!(entry.state.lock().unwrap().permit.is_none());
    }
}
