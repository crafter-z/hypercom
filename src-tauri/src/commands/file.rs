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
    let bytes = std::fs::read(&path)
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
            crate::plugin::load_manifest_from_dir(&manager.plugins_dir().join(&plugin_id))
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
        assert!(err.to_string().contains("Cannot read selected file"));
    }
}
