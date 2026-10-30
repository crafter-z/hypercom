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
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine as _;
use tauri::Manager;
use tokio::sync::Semaphore;

use crate::commands::CommandError;
use crate::AppState;

static PLUGIN_DIALOG_BUDGETS: LazyLock<Mutex<HashMap<String, Arc<Semaphore>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_LIVE_PLUGIN_DIALOGS: usize = 8;

fn plugin_dialog_budget(plugin_id: &str) -> Result<Arc<Semaphore>, CommandError> {
    let mut budgets = PLUGIN_DIALOG_BUDGETS
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(budgets
        .entry(plugin_id.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(MAX_LIVE_PLUGIN_DIALOGS)))
        .clone())
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPickedFile {
    path: String,
    base64: String,
}

#[derive(serde::Serialize)]
pub struct PluginPickedFiles {
    files: Vec<PluginPickedFile>,
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
    crate::plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    let install_generation = {
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
            || !entry
                .granted_permissions
                .iter()
                .any(|perm| perm == "fs:open")
        {
            return Err(CommandError::Other("插件未启用或未授予 fs:open".into()));
        }
        let manifest =
            crate::plugin::load_manifest_lite(&manager.plugins_dir().join(&plugin_id))
                .map_err(CommandError::Other)?;
        if manifest.id != plugin_id || !manifest.permissions.iter().any(|perm| perm == "fs:open") {
            return Err(CommandError::Other("插件未声明 fs:open".into()));
        }
        entry.install_generation.clone()
    };
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
        let manager = app.state::<crate::AppState>();
        let manager = manager
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let permitted = manager
            .get_config()
            .entities
            .plugin_configs
            .iter()
            .any(|entry| {
                entry.id == plugin_id
                    && entry.install_generation == install_generation
                    && entry.enabled
                    && entry
                        .granted_permissions
                        .iter()
                        .any(|perm| perm == "fs:open")
            });
        if !permitted {
            return Err(CommandError::Other("插件文件读取权限已撤销".into()));
        }
        drop(manager);
        let mut files = Vec::with_capacity(paths.len());
        for path in paths {
            let file_path = path
                .into_path()
                .map_err(|e| CommandError::Other(format!("选择的文件路径不可用: {e}")))?;
            let picked = read_picked_file(file_path)?;
            files.push(picked);
        }
        Ok(PluginPickedFiles { files })
    })
    .await
    .map_err(|e| CommandError::Other(format!("文件选择任务失败: {e}")))?
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
        image_mime_from_ext, read_image_data_url, read_picked_file,
    };

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
}
