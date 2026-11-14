/**
 * 通用文件读写命令
 * 用于配置 bundle 的导出 / 导入。
 *
 * 路径来自用户通过系统 save/open 对话框的显式选择（@tauri-apps/plugin-dialog），
 * 原生对话框本身即安全边界，因此不再限制在配置目录子树内——与 commands/log.rs 的
 * save_log_as / export_terminal_log 同一模式（defects #54 同类修复）。导出/导入的
 * 核心用途就是把配置搬到任意位置（桌面、U 盘、另一台机器），子树限制会使其失效。
 * 仅做基本有效性校验：写入确认父目录存在，读取确认文件可 canonicalize。
 */
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};

use base64::Engine as _;
use tauri::Manager;
use tokio::sync::Semaphore;

use crate::commands::CommandError;
use crate::AppState;

// Weak values preserve the per-plugin cap while a picker/permit is alive, but
// allow the entry to retire once the plugin has no in-flight dialog. A strong
// map here would leak one semaphore for every plugin id ever opened.
static PLUGIN_DIALOG_BUDGETS: LazyLock<Mutex<HashMap<String, Weak<Semaphore>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_LIVE_PLUGIN_DIALOGS: usize = 8;

fn plugin_dialog_budget(plugin_id: &str) -> Result<Arc<Semaphore>, CommandError> {
    let mut budgets = PLUGIN_DIALOG_BUDGETS
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    // Weak values alone would still retain every historical id/control block.
    // Prune expired entries on admission so metadata follows live concurrency.
    budgets.retain(|_, budget| budget.strong_count() > 0);
    if let Some(semaphore) = budgets.get(plugin_id).and_then(Weak::upgrade) {
        return Ok(semaphore);
    }
    let semaphore = Arc::new(Semaphore::new(MAX_LIVE_PLUGIN_DIALOGS));
    budgets.insert(plugin_id.to_string(), Arc::downgrade(&semaphore));
    Ok(semaphore)
}

/// Authoritative check used by every plugin file/directory command: the plugin
/// must still be installed, enabled, granted at least one of the permissions,
/// and the installed manifest must still declare one of them. Returns the
/// install generation the caller reviewed, so a later replacement cannot reuse
/// an older picker result.
fn plugin_any_permission_generation(
    state: &crate::AppState,
    plugin_id: &str,
    permissions: &[&str],
) -> Result<String, CommandError> {
    crate::plugin::validate_plugin_id(plugin_id).map_err(CommandError::Other)?;
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let entry = manager
        .get_config()
        .entities
        .plugin_configs
        .iter()
        .find(|item| item.id == plugin_id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
    if !entry.enabled
        || !permissions
            .iter()
            .any(|perm| entry.granted_permissions.iter().any(|granted| granted == perm))
    {
        return Err(CommandError::Other(format!(
            "插件未启用或未授予 {}",
            permissions.join(" 或 ")
        )));
    }
    let manifest = crate::plugin::load_manifest_lite(&manager.plugins_dir().join(plugin_id))
        .map_err(CommandError::Other)?;
    if manifest.id != plugin_id
        || !permissions
            .iter()
            .any(|perm| manifest.permissions.iter().any(|declared| declared == perm))
    {
        return Err(CommandError::Other(format!(
            "插件未声明 {}",
            permissions.join(" 或 ")
        )));
    }
    Ok(entry.install_generation.clone())
}

fn plugin_permission_generation(
    state: &crate::AppState,
    plugin_id: &str,
    permission: &str,
) -> Result<String, CommandError> {
    plugin_any_permission_generation(state, plugin_id, &[permission])
}

/// Host-owned text-file dialogs. The renderer never supplies a path: it only
/// supplies presentation options, so a compromised renderer cannot turn these
/// commands into arbitrary file read/write primitives.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileDialogOptions {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_file_name: Option<String>,
    #[serde(default)]
    pub filters: Option<Vec<PluginFileFilter>>,
}

const MAX_TEXT_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Show a file dialog on the calling window and return the chosen path.
/// Blocking; call from `spawn_blocking`.
pub(crate) fn pick_text_file_path(
    window: &tauri::WebviewWindow,
    options: &TextFileDialogOptions,
    save: bool,
) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = window.dialog().file();
    if let Some(title) = options.title.as_ref() {
        dialog = dialog.set_title(title);
    }
    if let Some(name) = options.default_file_name.as_ref() {
        dialog = dialog.set_file_name(name);
    }
    if let Some(filters) = options.filters.as_ref() {
        for filter in filters {
            let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(filter.name.clone(), &exts);
        }
    }
    let picked = if save {
        dialog.blocking_save_file()
    } else {
        dialog.blocking_pick_file()
    };
    picked.and_then(|path| path.into_path().ok())
}

fn read_text_file_limited(path: &Path) -> Result<String, CommandError> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| CommandError::Io(format!("Failed to stat file: {e}")))?;
    if !metadata.is_file() || metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(CommandError::Other(
            "File is not a regular file or exceeds the 64MB limit".into(),
        ));
    }
    let file = std::fs::File::open(path)
        .map_err(|e| CommandError::Io(format!("Failed to open file: {e}")))?;
    use std::io::Read;
    let mut bytes = Vec::with_capacity(metadata.len().min(MAX_TEXT_FILE_BYTES) as usize);
    file.take(MAX_TEXT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| CommandError::Io(format!("Failed to read file: {e}")))?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(CommandError::Other("File exceeds the 64MB limit".into()));
    }
    String::from_utf8(bytes).map_err(|e| CommandError::Io(format!("File is not UTF-8: {e}")))
}

fn write_text_file_limited(path: &Path, content: &str) -> Result<(), CommandError> {
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(CommandError::Other("Content exceeds the 64MB limit".into()));
    }
    path.parent()
        .ok_or_else(|| CommandError::Other(format!("Path has no parent directory: {path:?}")))?
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize parent directory: {e}")))?;
    std::fs::write(path, content.as_bytes())
        .map_err(|e| CommandError::Io(format!("Failed to write file: {e}")))
}

/// Replay an application log file. The renderer may choose the path, but it
/// must stay inside the configured log root (canonical containment).
#[tauri::command]
pub async fn read_text_file(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, CommandError> {
    let root = state.log_manager.get_directory();
    tokio::task::spawn_blocking(move || {
        let target = Path::new(&path)
            .canonicalize()
            .map_err(|e| CommandError::Io(format!("Cannot canonicalize path: {e}")))?;
        let root = root
            .canonicalize()
            .map_err(|e| CommandError::Io(format!("Cannot canonicalize log root: {e}")))?;
        if !target.starts_with(&root) {
            return Err(CommandError::Other(
                "Log replay is restricted to the configured log directory".into(),
            ));
        }
        read_text_file_limited(&target)
    })
    .await
    .map_err(|e| CommandError::Other(format!("File read task failed: {e}")))?
}

#[tauri::command]
pub async fn pick_text_file_and_read(
    options: TextFileDialogOptions,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, CommandError> {
    let dialog_window = window.clone();
    let path = tokio::task::spawn_blocking(move || {
        pick_text_file_path(&dialog_window, &options, false)
    })
    .await
    .map_err(|e| CommandError::Other(format!("File dialog task failed: {e}")))?;
    let Some(path) = path else { return Ok(None) };
    tokio::task::spawn_blocking(move || read_text_file_limited(&path))
        .await
        .map_err(|e| CommandError::Other(format!("File read task failed: {e}")))?
        .map(Some)
}

#[tauri::command]
pub async fn pick_text_file_and_write(
    content: String,
    options: TextFileDialogOptions,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, CommandError> {
    let dialog_window = window.clone();
    let path = tokio::task::spawn_blocking(move || {
        pick_text_file_path(&dialog_window, &options, true)
    })
    .await
    .map_err(|e| CommandError::Other(format!("File dialog task failed: {e}")))?;
    let Some(path) = path else { return Ok(None) };
    let display = path.display().to_string();
    tokio::task::spawn_blocking(move || write_text_file_limited(&path, &content))
        .await
        .map_err(|e| CommandError::Other(format!("File write task failed: {e}")))??;
    Ok(Some(display))
}

/// 插件只能读取宿主原生对话框选中的文件；路径从不由 Worker/前端传入。
/// 此命令在阻塞线程中弹出文件选择器并读取用户选择的原始字节，避免 JS
/// `open()` → `read_file_bytes(path)` 之间出现可伪造的任意路径读取入口。

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPickOptions {
    multiple: bool,
    filters: Option<Vec<PluginFileFilter>>,
    title: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPickedFile {
    path: String,
    base64: String,
}

#[derive(serde::Serialize)]
pub struct PluginPickedFiles {
    files: Vec<PluginPickedFile>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDirectoryPickOptions {
    title: Option<String>,
    multiple: Option<bool>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPickedDirectory {
    grant_id: String,
    name: String,
    path: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDirectoryEntry {
    name: String,
    rel: String,
    kind: String,
    size: u64,
    modified_ms: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDirectoryWriteResult {
    path: String,
    bytes_written: u64,
}

fn read_picked_file(path: PathBuf) -> Result<PluginPickedFile, CommandError> {
    // A native picker can still return a device, FIFO, socket, or a link. Do not
    // let an apparently selected path turn into an unbounded/hanging read.
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|e| CommandError::Io(format!("Cannot stat selected file: {e}")))?;
    if !metadata.is_file() || crate::plugin::is_link_or_reparse(&metadata) {
        return Err(CommandError::Other(
            "Selected path is not an ordinary file".into(),
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(
            windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| CommandError::Io(format!("Cannot open selected file: {e}")))?;
    let opened = file
        .metadata()
        .map_err(|e| CommandError::Io(format!("Cannot stat selected file: {e}")))?;
    if !opened.is_file() || crate::plugin::is_link_or_reparse(&opened) {
        return Err(CommandError::Other(
            "Selected path changed into a non-ordinary file".into(),
        ));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| CommandError::Io(format!("Cannot read selected file: {e}")))?;
    Ok(PluginPickedFile {
        path: path.display().to_string(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub async fn plugin_pick_files(
    plugin_id: String,
    options: PluginPickOptions,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<PluginPickedFiles, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件文件选择仅允许主窗口调用".into()));
    }
    let install_generation = plugin_permission_generation(&state, &plugin_id, "fs:open")?;
    let dialog_permit = plugin_dialog_budget(&plugin_id)?
        .try_acquire_owned()
        .map_err(|_| CommandError::Other("插件文件选择资源已达上限".into()))?;
    tokio::task::spawn_blocking(move || {
        let _dialog_permit = dialog_permit;
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file();
        if let Some(title) = options.title {
            dialog = dialog.set_title(title);
        }
        if let Some(filters) = options.filters {
            for filter in filters {
                let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
                dialog = dialog.add_filter(filter.name, &exts);
            }
        }
        // Filters are only chooser conveniences, never a restriction on readable formats.
        dialog = dialog.add_filter("All files", &["*"]);
        let paths = if options.multiple {
            dialog.blocking_pick_files().unwrap_or_default()
        } else {
            dialog.blocking_pick_file().into_iter().collect()
        };
        // The dialog may have been open while the user revoked the permission.
        let state = app.state::<crate::AppState>();
        let current_generation =
            plugin_permission_generation(&state, &plugin_id, "fs:open")?;
        if current_generation != install_generation {
            return Err(CommandError::Other("插件文件读取权限已撤销".into()));
        }
        let mut files = Vec::with_capacity(paths.len());
        for path in paths {
            let file_path = path
                .into_path()
                .map_err(|e| CommandError::Other(format!("选择的文件路径不可用: {e}")))?;
            let picked = read_picked_file(file_path)?;
            files.push(picked);
        }
        // Reading can be arbitrarily long (there is deliberately no business
        // size limit). Recheck after the final byte is read so a revoke or
        // install replacement that races the blocking read cannot deliver the
        // selected contents to the old worker.
        let current_generation = plugin_permission_generation(&state, &plugin_id, "fs:open")?;
        if current_generation != install_generation {
            return Err(CommandError::Other("插件文件读取权限已撤销".into()));
        }
        Ok(PluginPickedFiles { files })
    })
    .await
    .map_err(|e| CommandError::Other(format!("文件选择任务失败: {e}")))?
}

// ==================== 插件目录授权（fs:open-dir） ====================

// A directory root is selected only by the native picker. The renderer/Worker
// never supplies a root path: it receives an opaque grant bound to the plugin
// and install generation. Every operation revalidates the current permission and
// that the canonical target remains inside the canonical root. The grant is a
// full read/write capability inside the user-selected tree; no artificial TTL or
// grant-count cap is applied. Structural path fences (no links/escapes) remain.

struct PluginDirectoryGrant {
    plugin_id: String,
    install_generation: String,
    root: PathBuf,
}

static PLUGIN_DIRECTORY_GRANTS: LazyLock<Mutex<HashMap<String, PluginDirectoryGrant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const MAX_PLUGIN_DIRECTORY_GRANT_ID_CHARS: usize = 128;
const MAX_PLUGIN_DIRECTORY_REL_CHARS: usize = 4096;

/// Native pickers may return a symlink/junction path. Canonicalizing first would
/// silently turn that into a grant for the link target, contrary to the directory
/// capability's no-reparse policy. Check the selected path and every existing
/// ancestor before canonicalization.
fn reject_linked_directory_source(path: &Path) -> Result<(), CommandError> {
    let mut current = path.to_path_buf();
    loop {
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if crate::plugin::is_link_or_reparse(&metadata) => {
                return Err(CommandError::Other(
                    "选择的目录路径含链接或重解析点".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(CommandError::Io(format!("目录不可达: {error}")));
            }
            Err(error) => return Err(CommandError::Io(format!("目录不可达: {error}"))),
        }
        if !current.pop() {
            break;
        }
    }
    Ok(())
}

fn create_directory_grant(
    plugin_id: &str,
    install_generation: &str,
    root: PathBuf,
) -> Result<String, CommandError> {
    let mut grants = PLUGIN_DIRECTORY_GRANTS
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let grant_id = uuid::Uuid::new_v4().to_string();
    grants.insert(
        grant_id.clone(),
        PluginDirectoryGrant {
            plugin_id: plugin_id.to_string(),
            install_generation: install_generation.to_string(),
            root,
        },
    );
    Ok(grant_id)
}

fn directory_grant_root(
    plugin_id: &str,
    grant_id: &str,
    install_generation: &str,
) -> Result<PathBuf, CommandError> {
    if grant_id.is_empty() || grant_id.chars().count() > MAX_PLUGIN_DIRECTORY_GRANT_ID_CHARS {
        return Err(CommandError::Other("目录授权标识无效".into()));
    }
    let grants = PLUGIN_DIRECTORY_GRANTS
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let grant = grants
        .get(grant_id)
        .ok_or_else(|| CommandError::Other("目录授权已失效，请重新选择目录".into()))?;
    if grant.plugin_id != plugin_id || grant.install_generation != install_generation {
        return Err(CommandError::Other(
            "目录授权不属于当前插件安装版本".into(),
        ));
    }
    Ok(grant.root.clone())
}

/// Called by plugin state transitions (disable / permission removal / uninstall /
/// replacement / reload) so a grant cannot silently survive an authorization change.
pub(super) fn revoke_plugin_directory_grants(plugin_id: &str) {
    if let Ok(mut grants) = PLUGIN_DIRECTORY_GRANTS.lock() {
        grants.retain(|_, grant| grant.plugin_id != plugin_id);
    }
}

/// Normalize a plugin-supplied path relative to the picked root. Rejects
/// absolute/drive/UNC input, `..`, control characters and (on Windows) aliases
/// that could resolve to a device or ADS. `.` and empty segments are ignored.
fn sanitize_directory_rel(raw: &str) -> Result<(PathBuf, String), CommandError> {
    if raw.len() > MAX_PLUGIN_DIRECTORY_REL_CHARS {
        return Err(CommandError::Other("目录相对路径超过长度上限".into()));
    }
    if raw.is_empty() {
        return Ok((PathBuf::new(), String::new()));
    }
    let normalized = raw.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(CommandError::Other("目录相对路径不能是绝对路径".into()));
    }
    let mut out = PathBuf::new();
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(CommandError::Other("目录相对路径不允许 ..".into()));
        }
        if part.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
            return Err(CommandError::Other("目录相对路径含控制字符".into()));
        }
        if parts.is_empty() && part.len() == 2 && part.ends_with(':') {
            return Err(CommandError::Other("Windows 盘符路径不允许".into()));
        }
        #[cfg(windows)]
        {
            if part.ends_with(['.', ' '])
                || part.contains(':')
                || crate::plugin::is_reserved_windows_name(part)
            {
                return Err(CommandError::Other(format!(
                    "目录相对路径含 Windows 路径别名: {part}"
                )));
            }
        }
        out.push(part);
        parts.push(part.to_string());
    }
    Ok((out, parts.join("/")))
}

fn resolve_directory_target(root: &Path, rel: &Path) -> Result<PathBuf, CommandError> {
    let components: Vec<_> = rel.components().collect();
    let mut current = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(CommandError::Other("目录相对路径含非普通路径段".into()));
        };
        current.push(name);
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|e| CommandError::Io(format!("目录条目不可达: {e}")))?;
        if crate::plugin::is_link_or_reparse(&metadata) {
            return Err(CommandError::Other("目录路径含链接或重解析点".into()));
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Err(CommandError::Other("目录路径中间组件不是目录".into()));
        }
    }
    let canonical = current
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("目录条目不可达: {e}")))?;
    if !canonical.starts_with(root) {
        return Err(CommandError::Other("目录路径越界".into()));
    }
    Ok(canonical)
}

fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn entry_kind(metadata: &std::fs::Metadata) -> &'static str {
    if crate::plugin::is_link_or_reparse(metadata) {
        "other"
    } else if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    }
}

fn make_entry(name: String, rel: String, metadata: &std::fs::Metadata) -> PluginDirectoryEntry {
    let kind = entry_kind(metadata);
    PluginDirectoryEntry {
        name,
        rel,
        kind: kind.to_string(),
        size: if kind == "file" { metadata.len() } else { 0 },
        modified_ms: modified_ms(metadata),
    }
}

/// Resolve the parent directory of a not-yet-existing target. Missing parents
/// are created one component at a time when `create_parents` is true; existing
/// components must be ordinary directories and never links/reparse points.
fn resolve_directory_parent(
    root: &Path,
    rel: &Path,
    create_parents: bool,
) -> Result<(PathBuf, PathBuf), CommandError> {
    let components: Vec<_> = rel.components().collect();
    let Some((last, parents)) = components.split_last() else {
        return Err(CommandError::Other(
            "必须指定目录内的相对路径".into(),
        ));
    };
    let Component::Normal(file_name) = last else {
        return Err(CommandError::Other("目录相对路径含非普通路径段".into()));
    };
    let mut current = root.to_path_buf();
    for component in parents {
        let Component::Normal(name) = component else {
            return Err(CommandError::Other("目录相对路径含非普通路径段".into()));
        };
        current.push(name);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if crate::plugin::is_link_or_reparse(&metadata) {
                    return Err(CommandError::Other("目录路径含链接或重解析点".into()));
                }
                if !metadata.is_dir() {
                    return Err(CommandError::Other("目录路径中间组件不是目录".into()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create_parents {
                    return Err(CommandError::Io(format!("父目录不存在: {error}")));
                }
                std::fs::create_dir(&current)
                    .map_err(|e| CommandError::Io(format!("创建父目录失败: {e}")))?;
            }
            Err(error) => {
                return Err(CommandError::Io(format!("目录条目不可达: {error}")))
            }
        }
    }
    let parent = current
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("目录不可达: {e}")))?;
    if !parent.starts_with(root) {
        return Err(CommandError::Other("目录路径越界".into()));
    }
    Ok((parent.clone(), parent.join(file_name)))
}

fn existing_target_metadata(
    target: &Path,
) -> Result<Option<std::fs::Metadata>, CommandError> {
    match std::fs::symlink_metadata(target) {
        Ok(metadata) => {
            if crate::plugin::is_link_or_reparse(&metadata) {
                return Err(CommandError::Other("目标路径含链接或重解析点".into()));
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CommandError::Io(format!("目标不可达: {error}"))),
    }
}

fn read_directory_entries(
    dir: &Path,
    rel_text: &str,
    out: &mut Vec<PluginDirectoryEntry>,
) -> Result<(), CommandError> {
    for entry in std::fs::read_dir(dir)
        .map_err(|e| CommandError::Io(format!("目录不可读: {e}")))?
    {
        let entry = entry.map_err(|e| CommandError::Io(format!("目录条目不可读: {e}")))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            log::warn!("Skipping non-UTF-8 directory entry under {}", dir.display());
            continue;
        };
        let path = entry.path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(CommandError::Io(format!(
                    "目录条目不可达: {error}"
                )))
            }
        };
        let rel = if rel_text.is_empty() {
            name.clone()
        } else {
            format!("{rel_text}/{name}")
        };
        out.push(make_entry(name, rel, &metadata));
    }
    Ok(())
}

fn list_plugin_directory(
    root: &Path,
    rel: &Path,
    rel_text: &str,
    recursive: bool,
) -> Result<Vec<PluginDirectoryEntry>, CommandError> {
    let dir = resolve_directory_target(root, rel)?;
    let metadata = std::fs::metadata(&dir)
        .map_err(|e| CommandError::Io(format!("目录不可达: {e}")))?;
    if !metadata.is_dir() {
        return Err(CommandError::Other("目标不是目录".into()));
    }
    if !recursive {
        let mut entries = Vec::new();
        read_directory_entries(&dir, rel_text, &mut entries)?;
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        return Ok(entries);
    }
    let mut entries = Vec::new();
    let mut stack = vec![(dir, rel_text.to_string())];
    while let Some((dir, prefix)) = stack.pop() {
        let mut local = Vec::new();
        read_directory_entries(&dir, &prefix, &mut local)?;
        for entry in &local {
            if entry.kind == "directory" {
                // Revalidate each child directory before descending: a directory
                // swapped for a symlink between readdir and the next read must not
                // redirect the walk outside the selected root.
                let child_dir = resolve_directory_target(root, Path::new(&entry.rel))?;
                stack.push((child_dir, entry.rel.clone()));
            }
        }
        entries.extend(local);
    }
    entries.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(entries)
}

fn stat_plugin_directory_entry(
    root: &Path,
    rel: &Path,
    rel_text: &str,
) -> Result<PluginDirectoryEntry, CommandError> {
    let target = resolve_directory_target(root, rel)?;
    let metadata = std::fs::symlink_metadata(&target)
        .map_err(|e| CommandError::Io(format!("目录条目不可达: {e}")))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| target.display().to_string());
    Ok(make_entry(name, rel_text.to_string(), &metadata))
}

fn write_plugin_directory_file(
    root: &Path,
    rel: &Path,
    bytes: &[u8],
    mode: &str,
    create_parents: bool,
) -> Result<PluginDirectoryWriteResult, CommandError> {
    let (parent, target) = resolve_directory_parent(root, rel, create_parents)?;
    if let Some(metadata) = existing_target_metadata(&target)? {
        if !metadata.is_file() {
            return Err(CommandError::Other("目标不是普通文件".into()));
        }
    }
    let bytes_written = bytes.len() as u64;
    match mode {
        "overwrite" => {
            let temporary = parent.join(format!(
                ".hypercom-plugin-write-{}.tmp",
                uuid::Uuid::new_v4()
            ));
            let result = (|| -> std::io::Result<()> {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                file.write_all(bytes)?;
                file.flush()?;
                file.sync_all()?;
                drop(file);
                crate::plugin::transaction::replace_file(&temporary, &target)?;
                crate::plugin::transaction::sync_dir(&parent)
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temporary);
            }
            result.map_err(|e| CommandError::Io(format!("写入目录文件失败: {e}")))?;
        }
        "append" => {
            use std::io::Write;
            let mut open = std::fs::OpenOptions::new();
            open.append(true).create(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                open.custom_flags(
                    windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
                );
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                open.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let mut file = open
                .open(&target)
                .map_err(|e| CommandError::Io(format!("打开目录文件失败: {e}")))?;
            let metadata = file
                .metadata()
                .map_err(|e| CommandError::Io(format!("目录文件不可达: {e}")))?;
            if !metadata.is_file() || crate::plugin::is_link_or_reparse(&metadata) {
                return Err(CommandError::Other("目标不是普通文件".into()));
            }
            file.write_all(bytes)
                .map_err(|e| CommandError::Io(format!("写入目录文件失败: {e}")))?;
            file.flush()
                .map_err(|e| CommandError::Io(format!("刷新目录文件失败: {e}")))?;
            file.sync_all()
                .map_err(|e| CommandError::Io(format!("同步目录文件失败: {e}")))?;
        }
        _ => return Err(CommandError::Other("mode 必须为 overwrite 或 append".into())),
    }
    Ok(PluginDirectoryWriteResult {
        path: target.display().to_string(),
        bytes_written,
    })
}

fn create_plugin_directory(root: &Path, rel: &Path, recursive: bool) -> Result<(), CommandError> {
    let components: Vec<_> = rel.components().collect();
    if components.is_empty() {
        return Err(CommandError::Other("必须指定目录相对路径".into()));
    }
    let mut current = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(CommandError::Other("目录相对路径含非普通路径段".into()));
        };
        current.push(name);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if crate::plugin::is_link_or_reparse(&metadata) {
                    return Err(CommandError::Other("目录路径含链接或重解析点".into()));
                }
                if !metadata.is_dir() {
                    return Err(CommandError::Other("目标路径不是目录".into()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !recursive && index + 1 != components.len() {
                    return Err(CommandError::Io(format!("父目录不存在: {error}")));
                }
                std::fs::create_dir(&current)
                    .map_err(|e| CommandError::Io(format!("创建目录失败: {e}")))?;
            }
            Err(error) => {
                return Err(CommandError::Io(format!("目录条目不可达: {error}")))
            }
        }
    }
    Ok(())
}

fn remove_plugin_directory_entry(
    root: &Path,
    rel: &Path,
    recursive: bool,
) -> Result<(), CommandError> {
    if rel.as_os_str().is_empty() {
        return Err(CommandError::Other("不能移除目录授权根".into()));
    }
    let target = resolve_directory_target(root, rel)?;
    let metadata = std::fs::symlink_metadata(&target)
        .map_err(|e| CommandError::Io(format!("目录条目不可达: {e}")))?;
    if metadata.is_file() {
        std::fs::remove_file(&target)
            .map_err(|e| CommandError::Io(format!("删除文件失败: {e}")))?;
    } else if metadata.is_dir() {
        let result = if recursive {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_dir(&target)
        };
        result.map_err(|e| CommandError::Io(format!("删除目录失败: {e}")))?;
    } else {
        return Err(CommandError::Other("特殊文件不可移除".into()));
    }
    Ok(())
}

fn rename_plugin_directory_entry(
    root: &Path,
    from: &Path,
    to: &Path,
) -> Result<(), CommandError> {
    if from.as_os_str().is_empty() || to.as_os_str().is_empty() {
        return Err(CommandError::Other("源路径和目标路径都不能为空".into()));
    }
    let source = resolve_directory_target(root, from)?;
    let (_, target) = resolve_directory_parent(root, to, false)?;
    if existing_target_metadata(&target)?.is_some() {
        return Err(CommandError::Other("目标路径已存在".into()));
    }
    std::fs::rename(&source, &target)
        .map_err(|e| CommandError::Io(format!("重命名失败: {e}")))?;
    Ok(())
}

fn read_plugin_directory_file(root: &Path, rel: &Path) -> Result<PluginPickedFile, CommandError> {
    if rel.as_os_str().is_empty() {
        return Err(CommandError::Other("必须指定目录内的文件相对路径".into()));
    }
    let target = resolve_directory_target(root, rel)?;
    read_picked_file(target)
}

#[tauri::command]
pub async fn plugin_pick_directory(
    plugin_id: String,
    options: PluginDirectoryPickOptions,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<PluginPickedDirectory>, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件目录选择仅允许主窗口调用".into()));
    }
    let install_generation = plugin_any_permission_generation(
        &state,
        &plugin_id,
        &["fs:open-dir", "fs:write-dir"],
    )?;
    let dialog_permit = plugin_dialog_budget(&plugin_id)?
        .try_acquire_owned()
        .map_err(|_| CommandError::Other("插件目录选择资源已达上限".into()))?;
    let picked = tokio::task::spawn_blocking(move || {
        let _dialog_permit = dialog_permit;
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file();
        if let Some(title) = options.title {
            dialog = dialog.set_title(title);
        }
        let folders = if options.multiple == Some(true) {
            dialog.blocking_pick_folders().unwrap_or_default()
        } else {
            dialog.blocking_pick_folder().into_iter().collect()
        };
        if folders.is_empty() {
            return Ok(Vec::new());
        }
        // Validate every selected root before creating any grant, so a partial
        // selection failure cannot leave a half-created batch behind.
        let mut roots = Vec::with_capacity(folders.len());
        for folder in folders {
            let path = folder
                .into_path()
                .map_err(|e| CommandError::Other(format!("选择的目录路径不可用: {e}")))?;
            reject_linked_directory_source(&path)?;
            let display_path = path.display().to_string();
            let canonical = path
                .canonicalize()
                .map_err(|e| CommandError::Io(format!("目录不可达: {e}")))?;
            let metadata = std::fs::metadata(&canonical)
                .map_err(|e| CommandError::Io(format!("目录不可达: {e}")))?;
            if !metadata.is_dir() || crate::plugin::is_link_or_reparse(&metadata) {
                return Err(CommandError::Other("选择的路径不是普通目录".into()));
            }
            roots.push((canonical, display_path));
        }
        // The picker may have been open while the user revoked the permission.
        let state = app.state::<crate::AppState>();
        let current_generation = plugin_any_permission_generation(
            &state,
            &plugin_id,
            &["fs:open-dir", "fs:write-dir"],
        )?;
        if current_generation != install_generation {
            return Err(CommandError::Other("插件目录权限已撤销".into()));
        }
        let mut picked = Vec::with_capacity(roots.len());
        for (canonical, display_path) in roots {
            let grant_id =
                create_directory_grant(&plugin_id, &install_generation, canonical.clone())?;
            let name = canonical
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| canonical.display().to_string());
            picked.push(PluginPickedDirectory {
                grant_id,
                name,
                path: display_path,
            });
        }
        Ok(picked)
    })
    .await
    .map_err(|e| CommandError::Other(format!("目录选择任务失败: {e}")))??;
    Ok(picked)
}

#[tauri::command]
pub async fn plugin_list_directory(
    plugin_id: String,
    grant_id: String,
    rel_path: Option<String>,
    recursive: Option<bool>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<PluginDirectoryEntry>, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件目录读取仅允许主窗口调用".into()));
    }
    let install_generation = plugin_permission_generation(&state, &plugin_id, "fs:open-dir")?;
    let (rel, rel_text) = sanitize_directory_rel(rel_path.as_deref().unwrap_or(""))?;
    let recursive = recursive.unwrap_or(false);
    let root = directory_grant_root(&plugin_id, &grant_id, &install_generation)?;
    tokio::task::spawn_blocking(move || {
        list_plugin_directory(&root, &rel, &rel_text, recursive)
    })
    .await
    .map_err(|e| CommandError::Other(format!("目录读取任务失败: {e}")))?
}

#[tauri::command]
pub async fn plugin_read_directory_file(
    plugin_id: String,
    grant_id: String,
    rel_path: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<PluginPickedFile, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件目录读取仅允许主窗口调用".into()));
    }
    let install_generation = plugin_permission_generation(&state, &plugin_id, "fs:open-dir")?;
    let (rel, _) = sanitize_directory_rel(&rel_path)?;
    if rel.as_os_str().is_empty() {
        return Err(CommandError::Other("必须指定目录内的文件相对路径".into()));
    }
    let root = directory_grant_root(&plugin_id, &grant_id, &install_generation)?;
    tokio::task::spawn_blocking(move || read_plugin_directory_file(&root, &rel))
        .await
        .map_err(|e| CommandError::Other(format!("目录文件读取任务失败: {e}")))?
}

#[tauri::command]
pub async fn plugin_stat_directory_entry(
    plugin_id: String,
    grant_id: String,
    rel_path: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<PluginDirectoryEntry, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件目录读取仅允许主窗口调用".into()));
    }
    let install_generation = plugin_permission_generation(&state, &plugin_id, "fs:open-dir")?;
    let (rel, rel_text) = sanitize_directory_rel(&rel_path)?;
    if rel.as_os_str().is_empty() {
        return Err(CommandError::Other("必须指定目录内的相对路径".into()));
    }
    let root = directory_grant_root(&plugin_id, &grant_id, &install_generation)?;
    tokio::task::spawn_blocking(move || {
        stat_plugin_directory_entry(&root, &rel, &rel_text)
    })
    .await
    .map_err(|e| CommandError::Other(format!("目录条目读取任务失败: {e}")))?
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plugin_write_directory_file(
    plugin_id: String,
    grant_id: String,
    rel_path: String,
    content: Option<String>,
    base64: Option<String>,
    mode: Option<String>,
    create_parents: Option<bool>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<PluginDirectoryWriteResult, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件目录写入仅允许主窗口调用".into()));
    }
    let install_generation = plugin_permission_generation(&state, &plugin_id, "fs:write-dir")?;
    let (rel, _) = sanitize_directory_rel(&rel_path)?;
    if rel.as_os_str().is_empty() {
        return Err(CommandError::Other("必须指定目录内的文件相对路径".into()));
    }
    let bytes = match (content, base64) {
        (Some(content), None) => content.into_bytes(),
        (None, Some(base64)) => base64::engine::general_purpose::STANDARD
            .decode(base64)
            .map_err(|e| CommandError::Other(format!("base64 无效: {e}")))?,
        (Some(_), Some(_)) => {
            return Err(CommandError::Other(
                "content 与 base64 不能同时提供".into(),
            ))
        }
        (None, None) => {
            return Err(CommandError::Other(
                "必须提供 content 或 base64 之一".into(),
            ))
        }
    };
    let mode = mode.unwrap_or_else(|| "overwrite".to_string());
    if mode != "overwrite" && mode != "append" {
        return Err(CommandError::Other(
            "mode 必须为 overwrite 或 append".into(),
        ));
    }
    let create_parents = create_parents.unwrap_or(true);
    let root = directory_grant_root(&plugin_id, &grant_id, &install_generation)?;
    tokio::task::spawn_blocking(move || {
        write_plugin_directory_file(&root, &rel, &bytes, &mode, create_parents)
    })
    .await
    .map_err(|e| CommandError::Other(format!("目录文件写入任务失败: {e}")))?
}

#[tauri::command]
pub async fn plugin_create_directory(
    plugin_id: String,
    grant_id: String,
    rel_path: String,
    recursive: Option<bool>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件目录写入仅允许主窗口调用".into()));
    }
    let install_generation = plugin_permission_generation(&state, &plugin_id, "fs:write-dir")?;
    let (rel, _) = sanitize_directory_rel(&rel_path)?;
    if rel.as_os_str().is_empty() {
        return Err(CommandError::Other("必须指定目录相对路径".into()));
    }
    let recursive = recursive.unwrap_or(true);
    let root = directory_grant_root(&plugin_id, &grant_id, &install_generation)?;
    tokio::task::spawn_blocking(move || create_plugin_directory(&root, &rel, recursive))
        .await
        .map_err(|e| CommandError::Other(format!("创建目录任务失败: {e}")))?
}

#[tauri::command]
pub async fn plugin_remove_directory_entry(
    plugin_id: String,
    grant_id: String,
    rel_path: String,
    recursive: Option<bool>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件目录写入仅允许主窗口调用".into()));
    }
    let install_generation = plugin_permission_generation(&state, &plugin_id, "fs:write-dir")?;
    let (rel, _) = sanitize_directory_rel(&rel_path)?;
    if rel.as_os_str().is_empty() {
        return Err(CommandError::Other("不能移除目录授权根".into()));
    }
    let recursive = recursive.unwrap_or(false);
    let root = directory_grant_root(&plugin_id, &grant_id, &install_generation)?;
    tokio::task::spawn_blocking(move || remove_plugin_directory_entry(&root, &rel, recursive))
        .await
        .map_err(|e| CommandError::Other(format!("删除目录条目任务失败: {e}")))?
}

#[tauri::command]
pub async fn plugin_rename_directory_entry(
    plugin_id: String,
    grant_id: String,
    from_rel: String,
    to_rel: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件目录写入仅允许主窗口调用".into()));
    }
    let install_generation = plugin_permission_generation(&state, &plugin_id, "fs:write-dir")?;
    let (from, _) = sanitize_directory_rel(&from_rel)?;
    let (to, _) = sanitize_directory_rel(&to_rel)?;
    if from.as_os_str().is_empty() || to.as_os_str().is_empty() {
        return Err(CommandError::Other("源路径和目标路径都不能为空".into()));
    }
    let root = directory_grant_root(&plugin_id, &grant_id, &install_generation)?;
    tokio::task::spawn_blocking(move || rename_plugin_directory_entry(&root, &from, &to))
        .await
        .map_err(|e| CommandError::Other(format!("重命名任务失败: {e}")))?
}

#[tauri::command]
pub fn plugin_release_directory(
    plugin_id: String,
    grant_id: String,
    window: tauri::WebviewWindow,
) -> Result<(), CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件目录授权仅允许主窗口调用".into()));
    }
    crate::plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    if grant_id.chars().count() > MAX_PLUGIN_DIRECTORY_GRANT_ID_CHARS {
        return Ok(());
    }
    let mut grants = PLUGIN_DIRECTORY_GRANTS
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    if grants
        .get(&grant_id)
        .is_some_and(|grant| grant.plugin_id == plugin_id)
    {
        grants.remove(&grant_id);
    }
    Ok(())
}

// Replay authorization is a short-lived native-selected read-only handle, never a renderer path.
const REPLAY_FILE_BYTES: u64 = 32 * 1024 * 1024;
const REPLAY_SESSION_BYTES: u64 = 64 * 1024 * 1024;
const REPLAY_CHUNK_BYTES: usize = 64 * 1024;
const REPLAY_MAX_FILES: usize = 16;
struct ReplayFile {
    file: std::fs::File,
    path: PathBuf,
    metadata: std::fs::Metadata,
    fingerprint: String,
    stream_hash: sha2::Sha256,
    next_offset: u64,
}
struct ReplayGrant { files: HashMap<String, Arc<Mutex<ReplayFile>>>, created: std::time::Instant }
static REPLAY_GRANTS: LazyLock<Mutex<HashMap<String, ReplayGrant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static REPLAY_PICKER: Semaphore = Semaphore::const_new(1);
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySourceDescriptor { source_id: String, name: String, path: String, size: u64, fingerprint: String }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPickedSources { grant_id: String, sources: Vec<ReplaySourceDescriptor> }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySourceChunk { base64: String, next_offset: u64, done: bool }
fn replay_main(window: &tauri::WebviewWindow) -> Result<(), CommandError> {
    if window.label() != "main" { return Err(CommandError::Other("Replay import requires the main window".into())); }
    Ok(())
}
fn replay_fingerprint(file: &mut std::fs::File) -> Result<String, CommandError> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).map_err(|e| CommandError::Io(e.to_string()))?;
    let mut hash = Sha256::new();
    let mut bytes = [0u8; REPLAY_CHUNK_BYTES];
    let mut total = 0u64;
    let mut utf8_tail = Vec::new();
    loop {
        let count = file.read(&mut bytes).map_err(|e| CommandError::Io(e.to_string()))?;
        if count == 0 { break; }
        total += count as u64;
        if total > REPLAY_FILE_BYTES { return Err(CommandError::Other("Replay file exceeds 32 MiB".into())); }
        if bytes[..count].contains(&0) { return Err(CommandError::Other("Raw binary replay is unsupported; select UTF-8 text or HEX text".into())); }
        utf8_tail.extend_from_slice(&bytes[..count]);
        match std::str::from_utf8(&utf8_tail) {
            Ok(_) => utf8_tail.clear(),
            Err(error) if error.error_len().is_none() => { let tail = utf8_tail.split_off(error.valid_up_to()); utf8_tail = tail; }
            Err(_) => return Err(CommandError::Other("Replay source is not valid UTF-8".into())),
        }
        hash.update(&bytes[..count]);
    }
    if !utf8_tail.is_empty() { return Err(CommandError::Other("Replay source ends in incomplete UTF-8".into())); }
    Ok(format!("{:x}", hash.finalize()))
}
fn open_replay_file(path: PathBuf) -> Result<ReplayFile, CommandError> {
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| CommandError::Io(e.to_string()))?;
    if !metadata.is_file() || crate::plugin::is_link_or_reparse(&metadata) || metadata.len() > REPLAY_FILE_BYTES {
        return Err(CommandError::Other("Replay source must be an ordinary file of at most 32 MiB".into()));
    }
    let mut options = std::fs::OpenOptions::new(); options.read(true);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT); }
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK); }
    let mut file = options.open(&path).map_err(|e| CommandError::Io(e.to_string()))?;
    let opened = file.metadata().map_err(|e| CommandError::Io(e.to_string()))?;
    if !opened.is_file() || crate::plugin::is_link_or_reparse(&opened) || opened.len() != metadata.len() || opened.modified().ok() != metadata.modified().ok() {
        return Err(CommandError::Other("Replay source changed during selection".into()));
    }
    let fingerprint = replay_fingerprint(&mut file)?;
    use sha2::Digest;
    Ok(ReplayFile { file, path, metadata: opened, fingerprint, stream_hash: sha2::Sha256::new(), next_offset: 0 })
}
fn read_replay_chunk(source: &mut ReplayFile, offset: u64) -> Result<ReplaySourceChunk, CommandError> {
    use sha2::Digest;
    use std::io::{Read, Seek, SeekFrom};
    let metadata = std::fs::symlink_metadata(&source.path).map_err(|e| CommandError::Io(e.to_string()))?;
    let opened = source.file.metadata().map_err(|e| CommandError::Io(e.to_string()))?;
    if !metadata.is_file() || crate::plugin::is_link_or_reparse(&metadata) || metadata.len() != source.metadata.len() || metadata.modified().ok() != source.metadata.modified().ok() || opened.len() != source.metadata.len() || opened.modified().ok() != source.metadata.modified().ok() {
        return Err(CommandError::Other("Replay source changed or disappeared; select it again".into()));
    }
    if offset > metadata.len() || offset != source.next_offset { return Err(CommandError::Other("Replay offsets must advance sequentially".into())); }
    source.file.seek(SeekFrom::Start(offset)).map_err(|e| CommandError::Io(e.to_string()))?;
    let mut bytes = vec![0; REPLAY_CHUNK_BYTES.min((metadata.len() - offset) as usize)];
    source.file.read_exact(&mut bytes).map_err(|e| CommandError::Io(e.to_string()))?;
    let next_offset = offset + bytes.len() as u64; let done = next_offset == metadata.len();
    source.stream_hash.update(&bytes);
    if done && (format!("{:x}", source.stream_hash.clone().finalize()) != source.fingerprint || replay_fingerprint(&mut source.file)? != source.fingerprint) {
        return Err(CommandError::Other("Replay source content changed; select it again".into()));
    }
    source.next_offset = next_offset;
    Ok(ReplaySourceChunk { base64: base64::engine::general_purpose::STANDARD.encode(bytes), next_offset, done })
}
#[tauri::command]
pub async fn pick_replay_sources(window: tauri::WebviewWindow) -> Result<Option<ReplayPickedSources>, CommandError> {
    replay_main(&window)?;
    let permit = REPLAY_PICKER.try_acquire().map_err(|_| CommandError::Other("Replay picker is already open".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        use tauri_plugin_dialog::DialogExt;
        let paths = window.dialog().file().add_filter("UTF-8 text logs", &["log", "txt"]).blocking_pick_files();
        let Some(paths) = paths else { return Ok(None) };
        if paths.is_empty() { return Ok(None); }
        if paths.len() > REPLAY_MAX_FILES { return Err(CommandError::Other("Replay supports at most 16 files per import".into())); }
        let mut files = HashMap::new(); let mut sources = Vec::new(); let mut total = 0;
        for path in paths {
            let file = open_replay_file(path.into_path().map_err(|e| CommandError::Other(e.to_string()))?)?;
            total += file.metadata.len();
            if total > REPLAY_SESSION_BYTES { return Err(CommandError::Other("Replay import exceeds 64 MiB total".into())); }
            let source_id = uuid::Uuid::new_v4().to_string();
            sources.push(ReplaySourceDescriptor { source_id: source_id.clone(), name: file.path.file_name().unwrap_or_default().to_string_lossy().into_owned(), path: file.path.to_string_lossy().into_owned(), size: file.metadata.len(), fingerprint: file.fingerprint.clone() });
            files.insert(source_id, Arc::new(Mutex::new(file)));
        }
        let grant_id = uuid::Uuid::new_v4().to_string();
        let mut grants = REPLAY_GRANTS.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        grants.retain(|_, grant| grant.created.elapsed().as_secs() < 600);
        if grants.len() >= 2 { return Err(CommandError::Other("Too many pending replay imports".into())); }
        grants.insert(grant_id.clone(), ReplayGrant { files, created: std::time::Instant::now() });
        Ok(Some(ReplayPickedSources { grant_id, sources }))
    }).await.map_err(|e| CommandError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn read_replay_source_chunk(grant_id: String, source_id: String, offset: u64, window: tauri::WebviewWindow) -> Result<ReplaySourceChunk, CommandError> {
    replay_main(&window)?;
    let source = {
        let grants = REPLAY_GRANTS.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        let grant = grants.get(&grant_id).filter(|grant| grant.created.elapsed().as_secs() < 600).ok_or_else(|| CommandError::Other("Replay authorization expired".into()))?;
        grant.files.get(&source_id).cloned().ok_or_else(|| CommandError::Other("Unknown replay source".into()))?
    };
    tokio::task::spawn_blocking(move || {
        let mut source = source.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        read_replay_chunk(&mut source, offset)
    }).await.map_err(|e| CommandError::Other(e.to_string()))?
}
#[tauri::command]
pub fn release_replay_sources(grant_id: String, window: tauri::WebviewWindow) -> Result<(), CommandError> {
    replay_main(&window)?;
    REPLAY_GRANTS.lock().map_err(|e| CommandError::Lock(e.to_string()))?.remove(&grant_id);
    Ok(())
}

/// 背景图文件大小上限（20MB），超过即视为不可用。
const MAX_BACKGROUND_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 根据文件扩展名推断 MIME 类型（小写匹配）。
/// 不支持的扩展名返回 `None`（调用方据此走软失败路径，见 `read_image_data_url`）。
pub fn image_mime_from_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "bmp" => Some("image/bmp"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// 读取图片文件为 data URL（自定义背景图，issue #13）。
/// 返回 `data:image/<mime>;base64,<...>`。
///
/// **软失败契约**：路径为空 / 文件不存在 / 扩展名不支持 / 超过
/// `MAX_BACKGROUND_IMAGE_BYTES` 上限 / 读取失败，一律返回**空字符串**并记 warn。
/// 背景图是纯装饰：它的缺失不该让设置页弹错误、也不该中断启动流程，前端按「空串
/// = 无背景图」判定，因此这些分支不得改成 `Err`。单测钉住的就是这条契约。
#[tauri::command]
pub fn read_image_data_url(path: String) -> Result<String, CommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let target = match Path::new(trimmed).canonicalize() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("read_image_data_url: cannot canonicalize path '{trimmed}': {e}");
            return Ok(String::new());
        }
    };
    if !target.is_file() {
        log::warn!("read_image_data_url: not a file: '{}'", target.display());
        return Ok(String::new());
    }
    let Some(ext) = target.extension().and_then(|e| e.to_str()) else {
        log::warn!(
            "read_image_data_url: no file extension: '{}'",
            target.display()
        );
        return Ok(String::new());
    };
    let Some(mime) = image_mime_from_ext(ext) else {
        log::warn!(
            "read_image_data_url: unsupported extension '{ext}': '{}'",
            target.display()
        );
        return Ok(String::new());
    };
    let meta = match std::fs::metadata(&target) {
        Ok(m) => m,
        Err(e) => {
            log::warn!(
                "read_image_data_url: failed to stat '{}': {e}",
                target.display()
            );
            return Ok(String::new());
        }
    };
    if meta.len() > MAX_BACKGROUND_IMAGE_BYTES {
        log::warn!(
            "read_image_data_url: file too large ({} bytes, limit {}): '{}'",
            meta.len(),
            MAX_BACKGROUND_IMAGE_BYTES,
            target.display()
        );
        return Ok(String::new());
    }
    // Bounded read: the file may be replaced after `metadata()`, so enforce
    // the cap on the bytes actually read, not only the pre-read length.
    let mut bytes = Vec::with_capacity(meta.len().min(MAX_BACKGROUND_IMAGE_BYTES) as usize);
    let read_result = std::fs::File::open(&target).and_then(|file| {
        use std::io::Read as _;
        file.take(MAX_BACKGROUND_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| ())
    });
    if let Err(e) = read_result {
        log::warn!(
            "read_image_data_url: failed to read '{}': {e}",
            target.display()
        );
        return Ok(String::new());
    }
    if bytes.len() as u64 > MAX_BACKGROUND_IMAGE_BYTES {
        log::warn!(
            "read_image_data_url: file grew while reading (limit {}): '{}'",
            MAX_BACKGROUND_IMAGE_BYTES,
            target.display()
        );
        return Ok(String::new());
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use std::sync::atomic::{AtomicU32, Ordering};

    // 显式导入（镜像 serial/mod.rs 的测试约定，不用 `use super::*;`，
    // 避免 glob 把无关符号拖进测试二进制）。
    use crate::commands::file::{
        create_directory_grant, create_plugin_directory, directory_grant_root,
        image_mime_from_ext, list_plugin_directory, read_image_data_url, read_picked_file,
        read_plugin_directory_file, remove_plugin_directory_entry, rename_plugin_directory_entry,
        revoke_plugin_directory_grants, sanitize_directory_rel, stat_plugin_directory_entry,
        write_plugin_directory_file, plugin_dialog_budget, PLUGIN_DIALOG_BUDGETS,
    };
    #[cfg(unix)]
    use crate::commands::file::{reject_linked_directory_source, resolve_directory_target};

    #[test]
    fn dialog_budget_lives_with_owned_permits_and_retires_expired_plugin_ids() {
        let id = format!("com.example.budget-{}", uuid::Uuid::new_v4());
        let first = plugin_dialog_budget(&id).unwrap();
        let second = plugin_dialog_budget(&id).unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &second));
        let permit = first.clone().try_acquire_owned().unwrap();
        drop(first);
        drop(second);
        let active = plugin_dialog_budget(&id).unwrap();
        assert_eq!(active.available_permits(), 7);
        drop(active);
        drop(permit);
        let next_id = format!("com.example.budget-next-{}", uuid::Uuid::new_v4());
        let _next = plugin_dialog_budget(&next_id).unwrap();
        assert!(!PLUGIN_DIALOG_BUDGETS.lock().unwrap().contains_key(&id));
    }

    /// 1x1 PNG 头部字节。函数不做 PNG 解析，仅验证 base64 往返一致。
    const TINY_PNG: &[u8] =
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89";

    static NEXT_TEMP_ID: AtomicU32 = AtomicU32::new(0);

    /// 生成唯一的临时文件路径（进程号 + 自增计数），避免测试并行互相覆盖。
    fn unique_temp_path(ext: &str) -> std::path::PathBuf {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "hypercom_img_test_{}_{}.{ext}",
            std::process::id(),
            id
        ))
    }

    struct ReplayTempDir(std::path::PathBuf);
    impl ReplayTempDir {
        fn new() -> Self { let path = unique_temp_path("replaydir"); std::fs::create_dir(&path).unwrap(); Self(path) }
        fn path(&self) -> &std::path::Path { &self.0 }
    }
    impl Drop for ReplayTempDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn replay_native_source_has_content_identity_and_read_only_handle() {
        let dir = ReplayTempDir::new();
        let path = dir.path().join("history.log");
        std::fs::write(&path, b"RX hello\n").unwrap();
        let mut source = super::open_replay_file(path.clone()).unwrap();
        assert_eq!(source.metadata.len(), 9);
        assert_eq!(source.fingerprint.len(), 64);
        assert_eq!(super::replay_fingerprint(&mut source.file).unwrap(), source.fingerprint);
        use std::io::Write;
        assert!(source.file.write_all(b"forbidden").is_err());
    }

    #[test]
    fn replay_rejects_binary_invalid_utf8_and_oversize_without_truncation() {
        let dir = ReplayTempDir::new();
        let path = dir.path().join("bad.log");
        for bytes in [b"binary\0data".as_slice(), b"invalid\xff".as_slice(), b"partial\xe4\xb8".as_slice()] {
            std::fs::write(&path, bytes).unwrap();
            assert!(super::open_replay_file(path.clone()).is_err());
        }
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(super::REPLAY_FILE_BYTES + 1).unwrap(); drop(file);
        assert!(super::open_replay_file(path).is_err());
        assert!(super::open_replay_file(dir.path().to_path_buf()).is_err());
    }

    #[test]
    fn replay_utf8_validation_spans_chunks_and_detects_same_length_content_changes() {
        let dir = ReplayTempDir::new();
        let path = dir.path().join("utf8.log");
        let text = format!("{}中", "a".repeat(super::REPLAY_CHUNK_BYTES - 1));
        std::fs::write(&path, text.as_bytes()).unwrap();
        let mut source = super::open_replay_file(path.clone()).unwrap();
        let original = source.fingerprint.clone();
        std::fs::write(&path, text.replace('a', "b").as_bytes()).unwrap();
        assert_ne!(super::replay_fingerprint(&mut source.file).unwrap(), original);
    }

    #[test]
    fn replay_chunk_stream_is_bounded_sequential_and_content_verified() {
        let dir = ReplayTempDir::new(); let path = dir.path().join("chunks.log");
        let bytes = vec![b'x'; super::REPLAY_CHUNK_BYTES + 13]; std::fs::write(&path, &bytes).unwrap();
        let mut source = super::open_replay_file(path.clone()).unwrap();
        assert!(super::read_replay_chunk(&mut source, 1).is_err());
        let first = super::read_replay_chunk(&mut source, 0).unwrap();
        assert_eq!(first.next_offset, super::REPLAY_CHUNK_BYTES as u64); assert!(!first.done);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(first.base64).unwrap().len(), super::REPLAY_CHUNK_BYTES);
        assert!(super::read_replay_chunk(&mut source, 0).is_err());
        let last = super::read_replay_chunk(&mut source, first.next_offset).unwrap(); assert!(last.done);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(last.base64).unwrap().len(), 13);
        let mut corrupt = super::open_replay_file(path).unwrap();
        use sha2::Digest; corrupt.stream_hash.update(b"transient altered delivered content");
        let first = super::read_replay_chunk(&mut corrupt, 0).unwrap();
        assert!(super::read_replay_chunk(&mut corrupt, first.next_offset).is_err());
    }

    #[test]
    fn replay_chunk_refuses_changed_or_disappeared_files() {
        let dir = ReplayTempDir::new(); let path = dir.path().join("changing.log");
        std::fs::write(&path, b"original").unwrap();
        let mut source = super::open_replay_file(path.clone()).unwrap();
        std::fs::write(&path, b"larger replacement").unwrap();
        assert!(super::read_replay_chunk(&mut source, 0).is_err()); drop(source);
        let mut source = super::open_replay_file(path.clone()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(super::read_replay_chunk(&mut source, 0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replay_rejects_selected_symlinks() {
        let dir = ReplayTempDir::new();
        let target = dir.path().join("target.log"); let link = dir.path().join("link.log");
        std::fs::write(&target, b"secret").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(super::open_replay_file(link).is_err());
    }

    #[test]
    fn image_mime_maps_supported_extensions() {
        assert_eq!(image_mime_from_ext("png"), Some("image/png"));
        assert_eq!(image_mime_from_ext("jpg"), Some("image/jpeg"));
        assert_eq!(image_mime_from_ext("jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime_from_ext("bmp"), Some("image/bmp"));
        assert_eq!(image_mime_from_ext("webp"), Some("image/webp"));
        assert_eq!(image_mime_from_ext("gif"), Some("image/gif"));
        assert_eq!(image_mime_from_ext("svg"), Some("image/svg+xml"));
    }

    #[test]
    fn image_mime_is_case_insensitive() {
        assert_eq!(image_mime_from_ext("PNG"), Some("image/png"));
        assert_eq!(image_mime_from_ext("JpEg"), Some("image/jpeg"));
    }

    #[test]
    fn image_mime_rejects_unknown_and_empty() {
        assert_eq!(image_mime_from_ext("txt"), None);
        assert_eq!(image_mime_from_ext(""), None);
        assert_eq!(image_mime_from_ext("png2"), None);
    }

    #[test]
    fn read_image_empty_path_is_empty_string() {
        assert_eq!(read_image_data_url(String::new()).unwrap(), "");
        assert_eq!(read_image_data_url("   ".to_string()).unwrap(), "");
    }

    #[test]
    fn read_image_missing_file_is_empty_string() {
        let path = unique_temp_path("png");
        let result = read_image_data_url(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn read_image_unsupported_extension_is_empty_string() {
        let path = unique_temp_path("txt");
        std::fs::write(&path, b"not an image").unwrap();
        let result = read_image_data_url(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(result, "");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_image_returns_base64_data_url_roundtrip() {
        let path = unique_temp_path("png");
        std::fs::write(&path, TINY_PNG).unwrap();
        let result = read_image_data_url(path.to_string_lossy().into_owned()).unwrap();
        assert!(result.starts_with("data:image/png;base64,"));
        let encoded = result.split(',').nth(1).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(decoded, TINY_PNG);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn picked_file_roundtrips_non_utf8_content() {
        let path = unique_temp_path("map");
        let content: &[u8] = b"\x81\x40\x81\x41abc\x0d\x0a";
        std::fs::write(&path, content).unwrap();
        let picked = read_picked_file(path.clone()).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(picked.base64)
            .unwrap();
        assert_eq!(decoded, content);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn picked_file_reads_past_old_limit_without_truncation() {
        use std::io::{Seek, SeekFrom, Write};
        let path = unique_temp_path("bin");
        let size = 64 * 1024 * 1024 + 1;
        let mut file = std::fs::File::create(&path).unwrap();
        file.set_len(size).unwrap();
        file.seek(SeekFrom::End(-1)).unwrap();
        file.write_all(&[255]).unwrap();
        drop(file);
        let picked = read_picked_file(path.clone()).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(picked.base64).unwrap();
        assert_eq!(bytes.len(), size as usize);
        assert_eq!(bytes[0], 0);
        assert_eq!(bytes[bytes.len() - 1], 255);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn picked_file_missing_path_is_error() {
        let path = unique_temp_path("map");
        let err = read_picked_file(path).err().unwrap();
        assert!(err.to_string().contains("selected file"));
    }

    #[cfg(unix)]
    #[test]
    fn picked_file_rejects_symbolic_links_before_reading() {
        let target = unique_temp_path("target");
        let link = unique_temp_path("link");
        std::fs::write(&target, b"secret").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = read_picked_file(link.clone()).unwrap_err();
        assert!(err.to_string().contains("ordinary file"));
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_file(&target);
    }

    #[cfg(unix)]
    #[test]
    fn directory_picker_rejects_symlinked_root_before_canonicalizing() {
        let dir = ReplayTempDir::new();
        let target = dir.path().join("real");
        let link = dir.path().join("linked");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(reject_linked_directory_source(&link).is_err());
        assert!(reject_linked_directory_source(&target).is_ok());
    }

    #[test]
    fn directory_rel_normalizes_and_rejects_escapes() {
        assert_eq!(
            sanitize_directory_rel("").unwrap(),
            (std::path::PathBuf::new(), String::new())
        );
        assert_eq!(
            sanitize_directory_rel("logs//2026/./today").unwrap().1,
            "logs/2026/today"
        );
        assert!(sanitize_directory_rel("../secret").is_err());
        assert!(sanitize_directory_rel("logs/../../secret").is_err());
        assert!(sanitize_directory_rel("/etc").is_err());
        assert!(sanitize_directory_rel("C:\\Windows").is_err());
        assert!(sanitize_directory_rel("logs/\u{0}.txt").is_err());
        assert!(sanitize_directory_rel("logs/\u{7f}.txt").is_err());
    }

    #[test]
    fn directory_listing_reports_sorted_entries_and_relative_paths() {
        let dir = ReplayTempDir::new();
        std::fs::write(dir.path().join("b.log"), b"hello").unwrap();
        std::fs::write(dir.path().join("a.txt"), b"x").unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        std::fs::write(dir.path().join("nested/c.log"), b"world").unwrap();
        let root = dir.path().canonicalize().unwrap();

        let entries = list_plugin_directory(&root, std::path::Path::new(""), "", false).unwrap();
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["a.txt", "b.log", "nested"]);
        let b = entries.iter().find(|entry| entry.name == "b.log").unwrap();
        assert_eq!((b.rel.as_str(), b.kind.as_str(), b.size), ("b.log", "file", 5));
        assert!(b.modified_ms > 0);
        let nested = entries.iter().find(|entry| entry.name == "nested").unwrap();
        assert_eq!((nested.rel.as_str(), nested.kind.as_str(), nested.size), ("nested", "directory", 0));

        let children = list_plugin_directory(&root, std::path::Path::new("nested"), "nested", false).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].rel, "nested/c.log");
        assert_eq!(children[0].kind, "file");
    }

    #[test]
    fn directory_listing_recursive_returns_the_whole_tree() {
        let dir = ReplayTempDir::new();
        std::fs::write(dir.path().join("top.txt"), b"top").unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/one.log"), b"1").unwrap();
        std::fs::write(dir.path().join("a/b/two.log"), b"2").unwrap();
        let root = dir.path().canonicalize().unwrap();

        let entries = list_plugin_directory(&root, std::path::Path::new(""), "", true).unwrap();
        let rels: Vec<_> = entries.iter().map(|entry| entry.rel.as_str()).collect();
        assert_eq!(rels, ["a", "a/b", "a/b/two.log", "a/one.log", "top.txt"]);
        let two = entries.iter().find(|entry| entry.rel == "a/b/two.log").unwrap();
        assert_eq!((two.kind.as_str(), two.size), ("file", 1));
    }

    #[test]
    fn directory_write_overwrite_append_and_parent_creation() {
        let dir = ReplayTempDir::new();
        let root = dir.path().canonicalize().unwrap();

        let written = write_plugin_directory_file(
            &root,
            std::path::Path::new("new/dir/a.txt"),
            b"hello",
            "overwrite",
            true,
        )
        .unwrap();
        assert_eq!(written.bytes_written, 5);
        assert_eq!(std::fs::read(dir.path().join("new/dir/a.txt")).unwrap(), b"hello");

        write_plugin_directory_file(
            &root,
            std::path::Path::new("new/dir/a.txt"),
            b"!",
            "append",
            true,
        )
        .unwrap();
        assert_eq!(std::fs::read(dir.path().join("new/dir/a.txt")).unwrap(), b"hello!");

        write_plugin_directory_file(
            &root,
            std::path::Path::new("new/dir/a.txt"),
            b"hi",
            "overwrite",
            true,
        )
        .unwrap();
        assert_eq!(std::fs::read(dir.path().join("new/dir/a.txt")).unwrap(), b"hi");

        assert!(write_plugin_directory_file(
            &root,
            std::path::Path::new("missing/a.txt"),
            b"x",
            "overwrite",
            false,
        )
        .is_err());
        assert!(write_plugin_directory_file(
            &root,
            std::path::Path::new("new/dir"),
            b"x",
            "overwrite",
            true,
        )
        .is_err());
        assert!(write_plugin_directory_file(
            &root,
            std::path::Path::new("../outside.txt"),
            b"x",
            "overwrite",
            true,
        )
        .is_err());
    }

    #[test]
    fn directory_create_remove_and_stat_entries() {
        let dir = ReplayTempDir::new();
        let root = dir.path().canonicalize().unwrap();

        create_plugin_directory(&root, std::path::Path::new("a/b/c"), true).unwrap();
        assert!(dir.path().join("a/b/c").is_dir());
        assert!(create_plugin_directory(&root, std::path::Path::new("a"), true).is_ok());
        assert!(create_plugin_directory(&root, std::path::Path::new("x/y"), false).is_err());

        write_plugin_directory_file(
            &root,
            std::path::Path::new("a/b/c/data.txt"),
            b"content",
            "overwrite",
            true,
        )
        .unwrap();
        let stat = stat_plugin_directory_entry(
            &root,
            std::path::Path::new("a/b/c/data.txt"),
            "a/b/c/data.txt",
        )
        .unwrap();
        assert_eq!((stat.rel.as_str(), stat.kind.as_str(), stat.size), ("a/b/c/data.txt", "file", 7));
        assert!(stat.modified_ms > 0);
        assert!(stat_plugin_directory_entry(&root, std::path::Path::new("missing"), "missing").is_err());

        assert!(remove_plugin_directory_entry(&root, std::path::Path::new("a/b"), false).is_err());
        remove_plugin_directory_entry(&root, std::path::Path::new("a/b"), true).unwrap();
        assert!(!dir.path().join("a/b").exists());
        remove_plugin_directory_entry(&root, std::path::Path::new("a"), false).unwrap();
        assert!(!dir.path().join("a").exists());
        assert!(remove_plugin_directory_entry(&root, std::path::Path::new(""), true).is_err());
    }

    #[test]
    fn directory_rename_moves_files_and_directories() {
        let dir = ReplayTempDir::new();
        let root = dir.path().canonicalize().unwrap();
        write_plugin_directory_file(
            &root,
            std::path::Path::new("old.txt"),
            b"data",
            "overwrite",
            true,
        )
        .unwrap();
        rename_plugin_directory_entry(
            &root,
            std::path::Path::new("old.txt"),
            std::path::Path::new("nested/new.txt"),
        )
        .unwrap_err();
        create_plugin_directory(&root, std::path::Path::new("nested"), true).unwrap();
        rename_plugin_directory_entry(
            &root,
            std::path::Path::new("old.txt"),
            std::path::Path::new("nested/new.txt"),
        )
        .unwrap();
        assert_eq!(std::fs::read(dir.path().join("nested/new.txt")).unwrap(), b"data");
        assert!(!dir.path().join("old.txt").exists());

        create_plugin_directory(&root, std::path::Path::new("dir-a/sub"), true).unwrap();
        rename_plugin_directory_entry(
            &root,
            std::path::Path::new("dir-a"),
            std::path::Path::new("dir-b"),
        )
        .unwrap();
        assert!(dir.path().join("dir-b/sub").is_dir());
        assert!(rename_plugin_directory_entry(
            &root,
            std::path::Path::new("dir-b"),
            std::path::Path::new("nested"),
        )
        .is_err());
    }

    #[test]
    fn directory_read_returns_bytes_and_rejects_directories() {
        let dir = ReplayTempDir::new();
        std::fs::write(dir.path().join("data.bin"), b"\x00\xff\x80").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let root = dir.path().canonicalize().unwrap();

        let picked = read_plugin_directory_file(&root, std::path::Path::new("data.bin")).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(picked.base64)
            .unwrap();
        assert_eq!(bytes, b"\x00\xff\x80");
        assert!(read_plugin_directory_file(&root, std::path::Path::new("sub")).is_err());
        assert!(read_plugin_directory_file(&root, std::path::Path::new("")).is_err());
        assert!(read_plugin_directory_file(&root, std::path::Path::new("../data.bin")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn directory_target_rejects_symlink_entries() {
        let dir = ReplayTempDir::new();
        let outside = unique_temp_path("outside");
        std::fs::write(&outside, b"secret").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        std::fs::create_dir(dir.path().join("inside")).unwrap();
        std::fs::write(dir.path().join("inside/data.txt"), b"inside").unwrap();
        let inside_link = dir.path().join("inside-link");
        std::os::unix::fs::symlink(dir.path().join("inside"), &inside_link).unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert!(resolve_directory_target(&root, std::path::Path::new("link")).is_err());
        // Intermediate links are rejected even when their canonical target stays
        // inside the selected root.
        assert!(resolve_directory_target(&root, std::path::Path::new("inside-link/data.txt")).is_err());
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn directory_grant_is_bound_to_plugin_and_install_generation() {
        let dir = ReplayTempDir::new();
        let root = dir.path().canonicalize().unwrap();
        let grant = create_directory_grant("com.example.dirgrant", "gen-a", root.clone()).unwrap();
        assert_eq!(
            directory_grant_root("com.example.dirgrant", &grant, "gen-a").unwrap(),
            root
        );
        assert!(directory_grant_root("com.example.other", &grant, "gen-a").is_err());
        assert!(directory_grant_root("com.example.dirgrant", &grant, "gen-b").is_err());
        assert!(directory_grant_root("com.example.dirgrant", "not-a-grant", "gen-a").is_err());

        revoke_plugin_directory_grants("com.example.dirgrant");
        assert!(directory_grant_root("com.example.dirgrant", &grant, "gen-a").is_err());
    }
}
