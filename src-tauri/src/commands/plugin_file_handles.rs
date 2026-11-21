//! User-selected, single-file capabilities. The worker receives only opaque IDs.
use std::collections::HashMap;
use std::path::Path;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};

use base64::Engine as _;
use serde::Serialize;
use tauri::{
    ipc::{Request, Response},
    Manager, State, WebviewWindow,
};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};

use super::super::{file, plugin::require_main_window};
use super::{
    admit_read, check_cancel, require_raw_transport, validate_request_ids, Admission, CommandError,
    PluginFsRegistry, RequestEntry,
};
use crate::{
    config::ConfigManager,
    plugin::{
        fs_access,
        io_scheduler::{IoOwner, IoPermit, IoPriority},
    },
    AppState,
};

pub const PLUGIN_FILE_WINDOW_BYTES: usize = fs_access::SELECTED_FILE_WINDOW_BYTES;
const GLOBAL_FILES: usize = 32;
const FILES_PER_PLUGIN: usize = 4;
const JS_MAX_INTEGER: u64 = (1 << 53) - 1;
const LIVE: u8 = 0;
const RETIRED: u8 = 1;
const PUBLISHING: u8 = 2;
const B64_MAX: usize = PLUGIN_FILE_WINDOW_BYTES.div_ceil(3) * 4;

fn cancelled() -> CommandError {
    CommandError::Other(fs_access::SELECTED_FILE_CANCELLED.into())
}
fn invalid_handle() -> CommandError {
    CommandError::Other("PLUGIN_FILE_HANDLE_INVALID".into())
}
fn busy() -> CommandError {
    CommandError::Other("PLUGIN_FILE_RESOURCES_BUSY".into())
}
fn window_error() -> CommandError {
    CommandError::Other("PLUGIN_FILE_WINDOW_INVALID".into())
}
fn file_io(error: String) -> CommandError {
    if error == fs_access::SELECTED_FILE_CANCELLED {
        cancelled()
    } else {
        CommandError::Io(error)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum FileMode {
    Read,
    Write,
}

impl FileMode {
    fn permission(self) -> &'static str {
        match self {
            Self::Read => "fs:open",
            Self::Write => "fs:save",
        }
    }
}

#[derive(Clone)]
struct Owner {
    plugin_id: String,
    generation: String,
    session_id: String,
}

impl Owner {
    fn new(plugin_id: &str, generation: &str, session_id: &str) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            generation: generation.into(),
            session_id: session_id.into(),
        }
    }
    fn authorize_locked(
        &self,
        manager: &ConfigManager,
        mode: FileMode,
    ) -> Result<(), CommandError> {
        if file::plugin_permission_generation_locked(
            manager,
            &self.plugin_id,
            &[mode.permission()],
        )? != self.generation
        {
            return Err(invalid_handle());
        }
        Ok(())
    }
    fn authorize(&self, state: &AppState, mode: FileMode) -> Result<(), CommandError> {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        self.authorize_locked(&manager, mode)?;
        state
            .plugin_fs
            .session(&self.plugin_id, &self.session_id, &self.generation)?;
        Ok(())
    }
}

enum Resource {
    Read(Mutex<fs_access::OpenedFile>),
    Write(Mutex<fs_access::SelectedFileWrite>),
}

pub(super) struct FileEntry {
    owner: Owner,
    pick_request: String,
    mode: FileMode,
    name: String,
    size: u64,
    resource: Resource,
    phase: AtomicU8,
    stopped: watch::Sender<bool>,
    // Includes detached I/O and serial borrows; removing a table slot cannot
    // release a resource permit until the actual OS handles have closed.
    _permit: OwnedSemaphorePermit,
}

impl FileEntry {
    pub(super) fn belongs_to_plugin(&self, id: &str) -> bool {
        self.owner.plugin_id == id
    }
    pub(super) fn belongs_to_session(&self, id: &str, session: &str) -> bool {
        self.belongs_to_plugin(id) && self.owner.session_id == session
    }
    pub(super) fn was_picked_by(&self, id: &str, session: &str, request: &str) -> bool {
        self.belongs_to_session(id, session) && self.pick_request == request
    }
    pub(super) fn permission(&self) -> &'static str {
        self.mode.permission()
    }
    fn is_live(&self) -> bool {
        self.phase.load(Ordering::Acquire) == LIVE
    }
    fn live(&self) -> Result<(), CommandError> {
        if self.is_live() {
            Ok(())
        } else {
            Err(cancelled())
        }
    }
    fn retire(&self) {
        if self
            .phase
            .compare_exchange(LIVE, RETIRED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.stopped.send_replace(true);
        }
    }
    fn check(&self, state: &AppState) -> Result<(), CommandError> {
        self.live()?;
        self.owner.authorize(state, self.mode)?;
        self.live()
    }
    fn new(
        owner: Owner,
        pick_request: String,
        mode: FileMode,
        path: &Path,
        permit: OwnedSemaphorePermit,
    ) -> Result<Self, CommandError> {
        let name = path
            .file_name()
            .ok_or_else(invalid_handle)?
            .to_string_lossy()
            .into_owned();
        let (resource, size) = match mode {
            FileMode::Read => {
                let file = fs_access::open_selected_file(path).map_err(file_io)?;
                let size = file.len;
                if size > JS_MAX_INTEGER {
                    return Err(CommandError::Other("PLUGIN_FILE_UNSAFE_SIZE".into()));
                }
                (Resource::Read(Mutex::new(file)), size)
            }
            FileMode::Write => (
                Resource::Write(Mutex::new(
                    fs_access::SelectedFileWrite::new(path).map_err(file_io)?,
                )),
                0,
            ),
        };
        let (stopped, _) = watch::channel(false);
        Ok(Self {
            owner,
            pick_request,
            mode,
            name,
            size,
            resource,
            phase: AtomicU8::new(LIVE),
            stopped,
            _permit: permit,
        })
    }
}

pub(super) struct FileHandleTable {
    items: Mutex<HashMap<String, Arc<FileEntry>>>,
    actual_handles: Arc<Semaphore>,
}

impl FileHandleTable {
    pub(super) fn new() -> Self {
        Self {
            items: Mutex::new(HashMap::new()),
            actual_handles: Arc::new(Semaphore::new(GLOBAL_FILES)),
        }
    }
    fn reserve(&self) -> Result<OwnedSemaphorePermit, CommandError> {
        self.actual_handles
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())
    }
    fn insert(&self, entry: FileEntry) -> Result<PluginFileSelection, CommandError> {
        let mut items = self
            .items
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        if items
            .values()
            .filter(|item| item.belongs_to_plugin(&entry.owner.plugin_id))
            .count()
            >= FILES_PER_PLUGIN
        {
            return Err(busy());
        }
        let handle_id = uuid::Uuid::new_v4().to_string();
        let mut active_handles = items
            .iter()
            .filter(|(_, item)| {
                item.belongs_to_session(&entry.owner.plugin_id, &entry.owner.session_id)
                    && item.owner.generation == entry.owner.generation
                    && item.is_live()
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        active_handles.push(handle_id.clone());
        let result = PluginFileSelection {
            handle_id: handle_id.clone(),
            name: entry.name.clone(),
            size: entry.size,
            mode: entry.mode,
            active_handles,
        };
        items.insert(handle_id, Arc::new(entry));
        Ok(result)
    }
    fn get(&self, owner: &Owner, id: &str, mode: FileMode) -> Result<Arc<FileEntry>, CommandError> {
        uuid::Uuid::parse_str(id).map_err(|_| invalid_handle())?;
        let items = self
            .items
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        items
            .get(id)
            .filter(|item| {
                item.belongs_to_session(&owner.plugin_id, &owner.session_id)
                    && item.owner.generation == owner.generation
                    && item.mode == mode
                    && item.is_live()
            })
            .cloned()
            .ok_or_else(invalid_handle)
    }
    fn remove(&self, owner: &Owner, id: &str) {
        if let Ok(mut items) = self.items.lock() {
            if items.get(id).is_some_and(|item| {
                item.belongs_to_session(&owner.plugin_id, &owner.session_id)
                    && item.owner.generation == owner.generation
            }) {
                if let Some(item) = items.remove(id) {
                    item.retire();
                    drop_outside_control(vec![item]);
                }
            }
        }
    }
    pub(super) fn retire(&self, matches: impl Fn(&FileEntry) -> bool) {
        if let Ok(mut items) = self.items.lock() {
            let mut retired = Vec::new();
            items.retain(|_, item| {
                if !matches(item) {
                    return true;
                }
                item.retire();
                retired.push(item.clone());
                false
            });
            drop_outside_control(retired);
        }
    }
}

fn drop_outside_control(retired: Vec<Arc<FileEntry>>) {
    // Native close and temporary-file cleanup may block on the filesystem.
    if !retired.is_empty() {
        tauri::async_runtime::spawn_blocking(move || drop(retired));
    }
}

/// A pinned, read-only file borrowed by another authorized native consumer
/// such as serial transmission. Closing the originating capability also
/// invalidates all borrowed sources; none carries a filesystem pathname.
#[derive(Clone)]
pub struct PluginFileReadSource(Arc<FileEntry>);

impl PluginFileReadSource {
    pub fn len(&self) -> u64 {
        self.0.size
    }
    pub fn check(&self, state: &AppState) -> Result<(), CommandError> {
        self.0.check(state)
    }
    pub fn read_window(&self, offset: u64, length: usize) -> Result<Vec<u8>, CommandError> {
        self.read_cancellable(offset, length, || false)
    }
    fn read_cancellable(
        &self,
        offset: u64,
        length: usize,
        abort: impl Fn() -> bool,
    ) -> Result<Vec<u8>, CommandError> {
        self.0.live()?;
        if length > PLUGIN_FILE_WINDOW_BYTES || offset > JS_MAX_INTEGER {
            return Err(window_error());
        }
        let Resource::Read(file) = &self.0.resource else {
            return Err(invalid_handle());
        };
        let mut file = file.try_lock().map_err(|_| busy())?;
        fs_access::read_selected_window(&mut file, offset, length, || abort() || !self.0.is_live())
            .map_err(file_io)
    }
}

pub fn borrow_plugin_file_read_source(
    state: &AppState,
    plugin_id: &str,
    generation: &str,
    fs_session_id: &str,
    handle_id: &str,
) -> Result<PluginFileReadSource, CommandError> {
    let owner = Owner::new(plugin_id, generation, fs_session_id);
    owner.authorize(state, FileMode::Read)?;
    let source = PluginFileReadSource(state.plugin_fs.file_handles.get(
        &owner,
        handle_id,
        FileMode::Read,
    )?);
    source.0.live()?;
    Ok(source)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileSelection {
    handle_id: String,
    name: String,
    size: u64,
    mode: FileMode,
    // The facade reconciles stale metadata after partial revocations. It does
    // not expose these other IDs to the Worker as part of a picker response.
    active_handles: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileCommit {
    bytes_written: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    durability_warning: Option<String>,
}

fn admit(
    state: &AppState,
    owner: &Owner,
    mode: FileMode,
    request_id: &str,
) -> Result<Admission, CommandError> {
    validate_request_ids(&owner.plugin_id, &owner.session_id, request_id)?;
    owner.authorize(state, mode)?;
    let entry = admit_read(
        state,
        &owner.plugin_id,
        &owner.session_id,
        &owner.generation,
        request_id,
        vec![mode.permission()],
    )?;
    Ok(Admission {
        registry: state.plugin_fs.clone(),
        entry,
        delivered: false,
        cursor_id: None,
    })
}

async fn pick_file(
    state: &AppState,
    window: &WebviewWindow,
    owner: Owner,
    mode: FileMode,
    request_id: String,
    options: Option<file::PluginSaveFileOptions>,
) -> Result<Option<PluginFileSelection>, CommandError> {
    require_main_window(window)?;
    let options = options.unwrap_or_default();
    file::validate_save_file_options(&options)?;
    let admission = admit(state, &owner, mode, &request_id)?;
    let dialog = file::plugin_dialog_budget(&owner.plugin_id)?
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let permit = state.plugin_fs.file_handles.reserve()?;
    let app = window.app_handle().clone();
    let request = admission.entry.clone();
    let resource = tokio::task::spawn_blocking(move || {
        let _dialog = dialog;
        check_cancel(&request)?;
        let state = app.state::<AppState>();
        owner.authorize(&state, mode)?;
        let picked = file::pick_plugin_single_file(&app, options, mode == FileMode::Write)?;
        check_cancel(&request)?;
        let Some(path) = picked else {
            return Ok(None);
        };
        owner.authorize(&state, mode)?;
        FileEntry::new(owner, request_id, mode, &path, permit).map(Some)
    })
    .await
    .map_err(|e| CommandError::Other(format!("文件选择任务失败: {e}")))??;
    let Some(resource) = resource else {
        return Ok(None);
    };
    // Only the still-live command can publish a capability. A detached picker
    // returns an owned OS resource, never a registered handle that can leak.
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    resource.owner.authorize_locked(&manager, mode)?;
    let registry = state.plugin_fs.lock()?;
    if !registry
        .sessions
        .get(&resource.owner.session_id)
        .is_some_and(|session| {
            session.plugin_id == resource.owner.plugin_id
                && session.generation == resource.owner.generation
                && !*session.cancel_tx.borrow()
        })
    {
        return Err(CommandError::Other(super::SESSION_INVALID.into()));
    }
    check_cancel(&admission.entry)?;
    state.plugin_fs.file_handles.insert(resource).map(Some)
}

async fn permit_for(
    admission: &Admission,
    handle: &FileEntry,
    memory: usize,
) -> Result<IoPermit, CommandError> {
    handle.live()?;
    let mut stopped = handle.stopped.subscribe();
    let scheduler = admission.registry.scheduler();
    tokio::select! {
        biased;
        _ = stopped.wait_for(|ended| *ended) => Err(cancelled()),
        permit = scheduler.acquire_with_cost(
            IoOwner { plugin_id: handle.owner.plugin_id.clone(), session_id: handle.owner.session_id.clone() },
            memory, memory, IoPriority::Interactive, admission.entry.cancel_tx.subscribe(),
        ) => permit.map_err(CommandError::Other),
    }
}

fn stopped(entry: &RequestEntry, handle: &FileEntry) -> bool {
    *entry.cancel_tx.borrow() || !handle.is_live()
}

#[tauri::command]
pub async fn plugin_file_pick_read(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    request_id: String,
    options: Option<file::PluginSaveFileOptions>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<PluginFileSelection>, CommandError> {
    pick_file(
        &state,
        &window,
        Owner::new(&plugin_id, &expected_generation, &session_id),
        FileMode::Read,
        request_id,
        options,
    )
    .await
}

#[tauri::command]
pub async fn plugin_file_pick_write(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    request_id: String,
    options: Option<file::PluginSaveFileOptions>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<PluginFileSelection>, CommandError> {
    pick_file(
        &state,
        &window,
        Owner::new(&plugin_id, &expected_generation, &session_id),
        FileMode::Write,
        request_id,
        options,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plugin_file_read(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    request_id: String,
    handle_id: String,
    offset: u64,
    length: usize,
    request: Request<'_>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Response, CommandError> {
    require_main_window(&window)?;
    require_raw_transport(&request)?;
    if length > PLUGIN_FILE_WINDOW_BYTES || offset > JS_MAX_INTEGER {
        return Err(window_error());
    }
    let owner = Owner::new(&plugin_id, &expected_generation, &session_id);
    let source = borrow_plugin_file_read_source(
        &state,
        &plugin_id,
        &expected_generation,
        &session_id,
        &handle_id,
    )?;
    let mut admission = admit(&state, &owner, FileMode::Read, &request_id)?;
    let permit = permit_for(&admission, &source.0, 2 * length + 4096).await?;
    source.check(&state)?;
    PluginFsRegistry::start(&admission.entry)?;
    let task_source = source.clone();
    let entry = admission.entry.clone();
    let registry = admission.registry.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let data = task_source.read_cancellable(offset, length, || *entry.cancel_tx.borrow());
        registry.finish(&entry, permit);
        data
    })
    .await
    .map_err(|e| CommandError::Other(format!("文件窗口任务失败: {e}")))??;
    source.check(&state)?;
    check_cancel(&admission.entry)?;
    admission.delivered = true; // host releases the byte lease after transfer
    Ok(Response::new(bytes))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plugin_file_write(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    request_id: String,
    handle_id: String,
    offset: u64,
    base64: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<u64, CommandError> {
    require_main_window(&window)?;
    if base64.len() > B64_MAX || offset > JS_MAX_INTEGER {
        return Err(window_error());
    }
    let owner = Owner::new(&plugin_id, &expected_generation, &session_id);
    let admission = admit(&state, &owner, FileMode::Write, &request_id)?;
    let handle = state
        .plugin_fs
        .file_handles
        .get(&owner, &handle_id, FileMode::Write)?;
    let permit = permit_for(&admission, &handle, 2 * base64.len() + 4096).await?;
    handle.check(&state)?;
    let entry = admission.entry.clone();
    let task = handle.clone();
    let registry = admission.registry.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64)
            .map_err(|_| window_error())?;
        if bytes.is_empty()
            || bytes.len() > PLUGIN_FILE_WINDOW_BYTES
            || offset + bytes.len() as u64 > JS_MAX_INTEGER
        {
            return Err(window_error());
        }
        let Resource::Write(writer) = &task.resource else {
            return Err(invalid_handle());
        };
        let mut writer = writer.try_lock().map_err(|_| busy())?;
        if writer.bytes_written() != offset {
            return Err(CommandError::Other(
                "PLUGIN_FILE_WRITE_OFFSET_MISMATCH".into(),
            ));
        }
        let write = writer
            .append(&bytes, || stopped(&entry, &task))
            .map_err(file_io);
        if write.is_err() {
            registry.file_handles.remove(&owner, &handle_id);
        }
        write
    })
    .await
    .map_err(|e| CommandError::Other(format!("文件分块暂存失败: {e}")))??;
    handle.check(&state)?;
    check_cancel(&admission.entry)?;
    Ok(result)
}

#[tauri::command]
pub async fn plugin_file_commit(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    request_id: String,
    handle_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginFileCommit, CommandError> {
    require_main_window(&window)?;
    let owner = Owner::new(&plugin_id, &expected_generation, &session_id);
    let admission = admit(&state, &owner, FileMode::Write, &request_id)?;
    let handle = state
        .plugin_fs
        .file_handles
        .get(&owner, &handle_id, FileMode::Write)?;
    let permit = permit_for(&admission, &handle, 4096).await?;
    handle.check(&state)?;
    let request = admission.entry.clone();
    let app = window.app_handle().clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let state = app.state::<AppState>();
        let Resource::Write(writer) = &handle.resource else {
            return Err(invalid_handle());
        };
        let mut writer = writer.try_lock().map_err(|_| busy())?;
        let result = (|| {
            check_cancel(&request)?;
            handle.live()?;
            writer.prepare_publish().map_err(file_io)?;
            {
                let manager = state
                    .config_manager
                    .lock()
                    .map_err(|e| CommandError::Lock(e.to_string()))?;
                owner.authorize_locked(&manager, FileMode::Write)?;
                // The registry lock serializes with request cancel/session
                // retirement; the CAS serializes with an explicit close.
                let _registry = state.plugin_fs.lock()?;
                check_cancel(&request)?;
                handle
                    .phase
                    .compare_exchange(LIVE, PUBLISHING, Ordering::AcqRel, Ordering::Acquire)
                    .map_err(|_| cancelled())?;
                writer.publish().map_err(file_io)?;
            }
            // A successful rename is irreversible even if parent sync fails.
            Ok(PluginFileCommit {
                bytes_written: writer.bytes_written(),
                durability_warning: writer.sync_parent().err(),
            })
        })();
        state.plugin_fs.file_handles.remove(&owner, &handle_id);
        result
    })
    .await
    .map_err(|e| CommandError::Other(format!("文件提交结果未知: {e}")))?
}

#[tauri::command]
pub async fn plugin_file_close(
    plugin_id: String,
    expected_generation: String,
    session_id: String,
    handle_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    // Cleanup is idempotent and can run after ordinary authority was withdrawn.
    state.plugin_fs.file_handles.remove(
        &Owner::new(&plugin_id, &expected_generation, &session_id),
        &handle_id,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, fs, io::Write as _, path::PathBuf, time::Instant};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("plugin-file-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn add(
        table: &FileHandleTable,
        owner: Owner,
        path: &Path,
        mode: FileMode,
    ) -> PluginFileSelection {
        table
            .insert(
                FileEntry::new(owner, "pick".into(), mode, path, table.reserve().unwrap()).unwrap(),
            )
            .unwrap()
    }

    #[test]
    fn private_file_source_is_read_only_and_can_never_follow_a_new_path() {
        let temp = Temp::new();
        let path = temp.0.join("selected.txt");
        fs::write(&path, b"original").unwrap();
        let mut file = fs_access::open_selected_file(&path).unwrap();
        assert!(file.file.write_all(b"forbidden").is_err());
        fs::rename(&path, temp.0.join("original.txt")).unwrap();
        fs::write(&path, b"different").unwrap();
        assert_eq!(
            fs_access::read_selected_window(&mut file, 0, 32, || false).unwrap(),
            b"original"
        );
        assert_eq!(
            fs_access::read_selected_window(&mut file, 8, 32, || false).unwrap(),
            b""
        );
    }

    #[test]
    fn selected_read_is_scoped_to_the_worker_and_revocation_never_resurrects_it() {
        let temp = Temp::new();
        let path = temp.0.join("selected.txt");
        fs::write(&path, b"user selected").unwrap();
        let registry = Arc::new(PluginFsRegistry::new());
        let session_id = registry
            .open_session("com.test.selected", "generation")
            .unwrap();
        let owner = Owner::new("com.test.selected", "generation", &session_id);
        let selected = add(&registry.file_handles, owner.clone(), &path, FileMode::Read);
        let writer_selection = add(
            &registry.file_handles,
            owner.clone(),
            &temp.0.join("save.txt"),
            FileMode::Write,
        );
        let source = PluginFileReadSource(
            registry
                .file_handles
                .get(&owner, &selected.handle_id, FileMode::Read)
                .unwrap(),
        );
        let cancelled = source.0.stopped.subscribe();
        assert!(registry
            .file_handles
            .get(&owner, &selected.handle_id, FileMode::Write)
            .is_err());
        assert!(registry
            .file_handles
            .get(
                &Owner::new("com.test.selected", "generation", "other"),
                &selected.handle_id,
                FileMode::Read
            )
            .is_err());
        assert!(registry
            .file_handles
            .get(
                &Owner::new("com.test.selected", "other", &session_id),
                &selected.handle_id,
                FileMode::Read
            )
            .is_err());
        assert_eq!(source.read_window(5, 8).unwrap(), b"selected");
        assert!(source.read_window(0, PLUGIN_FILE_WINDOW_BYTES + 1).is_err());
        registry.revoke_read_permissions(
            "com.test.selected",
            &["fs:open".into(), "fs:save".into(), "notify".into()],
            &["fs:open".into(), "fs:save".into()],
        );
        assert!(!*cancelled.borrow());
        registry.revoke_read_permissions(
            "com.test.selected",
            &["fs:open".into(), "fs:save".into()],
            &["fs:save".into()],
        );
        assert!(*cancelled.borrow());
        assert!(source.read_window(0, 1).is_err());
        assert!(registry
            .session("com.test.selected", &session_id, "generation")
            .is_ok());
        assert!(registry
            .file_handles
            .get(&owner, &writer_selection.handle_id, FileMode::Write)
            .is_ok());
        registry.revoke_read_permissions(
            "com.test.selected",
            &["fs:save".into()],
            &["fs:save".into(), "fs:open".into()],
        );
        assert!(registry
            .file_handles
            .get(&owner, &selected.handle_id, FileMode::Read)
            .is_err());
        registry.close_session("com.test.selected", &session_id);
        assert!(registry
            .file_handles
            .get(&owner, &writer_selection.handle_id, FileMode::Write)
            .is_err());
    }

    #[test]
    fn staged_writes_never_change_selected_target_until_explicit_publish() {
        let temp = Temp::new();
        let target = temp.0.join("save.txt");
        fs::write(&target, b"original").unwrap();
        {
            let mut staged = fs_access::SelectedFileWrite::new(&target).unwrap();
            assert_eq!(staged.append(b"unused", || false).unwrap(), 6);
            assert_eq!(fs::read(&target).unwrap(), b"original");
            assert!(staged.append(b"cancelled", || true).is_err());
        }
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
        {
            let mut staged = fs_access::SelectedFileWrite::new(&target).unwrap();
            assert_eq!(staged.append(b"first", || false).unwrap(), 5);
            assert_eq!(staged.append(b"+second", || false).unwrap(), 12);
            staged.prepare_publish().unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"original");
            staged.publish().unwrap();
            staged.sync_parent().unwrap();
        }
        assert_eq!(fs::read(&target).unwrap(), b"first+second");
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn staged_new_file_conflict_keeps_competing_contents_and_cleans_only_staging() {
        let temp = Temp::new();
        let target = temp.0.join("new.txt");
        let mut staged = fs_access::SelectedFileWrite::new(&target).unwrap();
        assert!(!target.exists());
        staged.append(b"not yours", || false).unwrap();
        staged.prepare_publish().unwrap();
        {
            let mut competing = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .unwrap();
            competing.write_all(b"new independent contents").unwrap();
        }
        assert_eq!(
            staged.publish().unwrap_err(),
            fs_access::SELECTED_FILE_TARGET_CONFLICT
        );
        drop(staged);
        assert_eq!(fs::read(&target).unwrap(), b"new independent contents");
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn staged_new_file_claims_name_once_and_drop_preserves_publication() {
        let temp = Temp::new();
        let target = temp.0.join("new.txt");
        let mut first = fs_access::SelectedFileWrite::new(&target).unwrap();
        let mut second = fs_access::SelectedFileWrite::new(&target).unwrap();
        first.append(b"first publication", || false).unwrap();
        second.append(b"second publication", || false).unwrap();
        first.prepare_publish().unwrap();
        second.prepare_publish().unwrap();
        first.publish().unwrap();
        drop(first); // publication happened; only its temporary name may be cleaned
        assert_eq!(
            second.publish().unwrap_err(),
            fs_access::SELECTED_FILE_TARGET_CONFLICT
        );
        drop(second);
        assert_eq!(fs::read(&target).unwrap(), b"first publication");
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn staged_confirmed_existing_target_rejects_replacement_and_disappearance() {
        for replaced in [true, false] {
            let temp = Temp::new();
            let target = temp.0.join("existing.txt");
            let old = temp.0.join("moved-original.txt");
            fs::write(&target, b"original").unwrap();
            let mut staged = fs_access::SelectedFileWrite::new(&target).unwrap();
            staged.append(b"staged output", || false).unwrap();
            fs::rename(&target, &old).unwrap();
            if replaced {
                fs::write(&target, b"new same-named object").unwrap();
            }
            staged.prepare_publish().unwrap();
            assert_eq!(
                staged.publish().unwrap_err(),
                fs_access::SELECTED_FILE_TARGET_CONFLICT
            );
            drop(staged);
            assert_eq!(fs::read(&old).unwrap(), b"original");
            if replaced {
                assert_eq!(fs::read(&target).unwrap(), b"new same-named object");
            } else {
                assert!(!target.exists());
            }
            assert_eq!(
                fs::read_dir(&temp.0).unwrap().count(),
                if replaced { 2 } else { 1 }
            );
        }
    }

    fn resident_bytes(system: &mut sysinfo::System, pid: sysinfo::Pid) -> u64 {
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[pid]),
            false,
            sysinfo::ProcessRefreshKind::nothing().with_memory(),
        );
        system
            .process(pid)
            .expect("self process resident memory")
            .memory()
    }

    #[test]
    #[ignore = "writes and reads a full 1 GiB fixture; run separately with --ignored --nocapture"]
    fn selected_file_one_gib_window_evidence() {
        const WINDOWS: usize = 1024;
        let temp = Temp::new();
        let file_path = temp.0.join("full-one-gib.log");
        let mut expected = vec![0; PLUGIN_FILE_WINDOW_BYTES];
        let pattern = |bytes: &mut [u8], window: usize| {
            bytes.fill((window % 251) as u8);
            bytes[..8].copy_from_slice(&(window as u64).to_le_bytes());
        };
        {
            let mut fixture = fs::File::create(&file_path).unwrap();
            for index in 0..WINDOWS {
                pattern(&mut expected, index);
                fixture.write_all(&expected).unwrap();
            }
            fixture.sync_all().unwrap();
        }
        let mut system = sysinfo::System::new().expect("initialize process metrics");
        let pid = sysinfo::get_current_pid().expect("self process ID");
        let baseline = resident_bytes(&mut system, pid);
        let mut rss_peak = baseline;
        let mut sampled = 0;
        let mut window_peak = 0;
        let mut first_chunk = None;
        let started = Instant::now();
        let table = FileHandleTable::new();
        let owner = Owner::new("com.test.gib", "g", "s");
        let selection = add(&table, owner.clone(), &file_path, FileMode::Read);
        let source = PluginFileReadSource(
            table
                .get(&owner, &selection.handle_id, FileMode::Read)
                .unwrap(),
        );
        assert_eq!(source.len(), (1_u64 << 30));
        for index in 0..WINDOWS {
            let bytes = source
                .read_window(
                    (index * PLUGIN_FILE_WINDOW_BYTES) as u64,
                    PLUGIN_FILE_WINDOW_BYTES,
                )
                .unwrap();
            if first_chunk.is_none() {
                first_chunk = Some(started.elapsed());
            }
            window_peak = window_peak.max(bytes.capacity());
            pattern(&mut expected, index);
            assert_eq!(bytes, expected, "window {index}");
            if index % 32 == 0 || index + 1 == WINDOWS {
                rss_peak = rss_peak.max(resident_bytes(&mut system, pid));
                sampled += 1;
            }
        }
        assert!(source.read_window(source.len(), 32).unwrap().is_empty());
        assert_eq!(window_peak, PLUGIN_FILE_WINDOW_BYTES);
        let elapsed = started.elapsed();
        let checkpoints = Cell::new(0);
        let cancelled_at = Cell::new(None);
        let cancellation = source.read_cancellable(0, PLUGIN_FILE_WINDOW_BYTES, || {
            checkpoints.set(checkpoints.get() + 1);
            if checkpoints.get() == 3 {
                // First 64 KiB slice has completed; invalidate before the next.
                cancelled_at.set(Some(Instant::now()));
                source.0.retire();
                return true;
            }
            false
        });
        let cancel_elapsed = cancelled_at.get().unwrap().elapsed();
        assert!(
            matches!(cancellation, Err(CommandError::Other(message)) if message == "PLUGIN_FILE_CANCELLED")
        );
        assert!(source.read_window(0, 1).is_err());
        println!("selected-file native 1 GiB: first_chunk_us={} verified_bytes={} windows={} stream_ms={} window_peak_bytes={} sampled_rss_baseline_bytes={} sampled_rss_peak_bytes={} rss_samples={} cancel_at_slice_boundary_us={} late_bytes=0",
            first_chunk.unwrap().as_micros(), source.len(), WINDOWS, elapsed.as_millis(), window_peak, baseline, rss_peak, sampled, cancel_elapsed.as_micros());
    }
}
