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
use std::path::{Path, PathBuf};

use base64::Engine as _;
use tauri::Manager;

use crate::commands::CommandError;

/// 将文本内容写入指定路径（配置导出）。
/// 目标路径由用户通过系统 save 对话框显式选择，仅校验父目录有效。
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), CommandError> {
    let target = Path::new(&path);
    target
        .parent()
        .ok_or_else(|| CommandError::Other(format!("Path has no parent directory: {path}")))?
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize parent directory: {e}")))?;
    std::fs::write(target, content.as_bytes())
        .map_err(|e| CommandError::Io(format!("Failed to write file '{path}': {e}")))
}

/// 读取文本文件内容（配置导入）。
/// 目标路径由用户通过系统 open 对话框显式选择，仅校验文件存在且可 canonicalize。
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, CommandError> {
    let target = Path::new(&path);
    target
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize path: {e}")))?;
    std::fs::read_to_string(target)
        .map_err(|e| CommandError::Io(format!("Failed to read file '{path}': {e}")))
}

/// 插件只能读取宿主原生对话框选中的文件；路径从不由 Worker/前端传入。
/// 此命令在阻塞线程中弹出文件选择器并读取有大小限制的内容，避免 JS
/// `open()` → `read_file_bytes(path)` 之间出现可伪造的任意路径读取入口。
const MAX_PLUGIN_OPEN_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PLUGIN_PICK_FILES: usize = 8;
const MAX_PLUGIN_PICK_TOTAL_BYTES: u64 = MAX_PLUGIN_OPEN_FILE_BYTES;

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
    let file = std::fs::File::open(&path)
        .map_err(|e| CommandError::Io(format!("Cannot open selected file: {e}")))?;
    let metadata = file.metadata()
        .map_err(|e| CommandError::Io(format!("Cannot stat selected file: {e}")))?;
    if !metadata.is_file() || metadata.len() > MAX_PLUGIN_OPEN_FILE_BYTES {
        return Err(CommandError::Other("选择的文件不是普通文件或超过 64MB".into()));
    }
    use std::io::Read;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PLUGIN_OPEN_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| CommandError::Io(format!("Cannot read selected file: {e}")))?;
    if bytes.len() as u64 > MAX_PLUGIN_OPEN_FILE_BYTES {
        return Err(CommandError::Other("选择的文件超过 64MB".into()));
    }
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
        let manager = state.config_manager.lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let entry = manager.get_config().entities.plugin_configs.iter()
            .find(|item| item.id == plugin_id)
            .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
        if !entry.enabled || !entry.granted_permissions.iter().any(|perm| perm == "fs:open") {
            return Err(CommandError::Other("插件未启用或未授予 fs:open".into()));
        }
        let manifest = crate::plugin::load_manifest_from_dir(&manager.plugins_dir().join(&plugin_id))
            .map_err(CommandError::Other)?;
        if manifest.id != plugin_id || !manifest.permissions.iter().any(|perm| perm == "fs:open") {
            return Err(CommandError::Other("插件未声明 fs:open".into()));
        }
        entry.install_generation.clone()
    };
    tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file();
        if let Some(title) = options.title { dialog = dialog.set_title(title); }
        if let Some(filters) = options.filters {
            for filter in filters {
                let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
                dialog = dialog.add_filter(filter.name, &exts);
            }
        }
        let paths = if options.multiple {
            dialog.blocking_pick_files().unwrap_or_default()
        } else {
            dialog.blocking_pick_file().into_iter().collect()
        };
        // The dialog may have been open while the user revoked the permission.
        let manager = app.state::<crate::AppState>();
        let manager = manager.config_manager.lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let permitted = manager.get_config().entities.plugin_configs.iter().any(|entry| {
            entry.id == plugin_id && entry.install_generation == install_generation && entry.enabled
                && entry.granted_permissions.iter().any(|perm| perm == "fs:open")
        });
        if !permitted {
            return Err(CommandError::Other("插件文件读取权限已撤销".into()));
        }
        drop(manager);
        if paths.len() > MAX_PLUGIN_PICK_FILES {
            return Err(CommandError::Other("单次最多选择 8 个文件".into()));
        }
        let mut total_bytes = 0u64;
        let mut files = Vec::with_capacity(paths.len());
        for path in paths {
            let file_path = path.into_path()
                .map_err(|e| CommandError::Other(format!("选择的文件路径不可用: {e}")))?;
            let size = std::fs::metadata(&file_path)
                .map_err(|e| CommandError::Io(format!("Cannot stat selected file: {e}")))?.len();
            total_bytes = total_bytes.saturating_add(size);
            if total_bytes > MAX_PLUGIN_PICK_TOTAL_BYTES {
                return Err(CommandError::Other("本次选择的文件总量超过 64MB".into()));
            }
            files.push(read_picked_file(file_path)?);
        }
        Ok(PluginPickedFiles { files })
    }).await.map_err(|e| CommandError::Other(format!("文件选择任务失败: {e}")))?
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
        log::warn!(
            "read_image_data_url: not a file: '{}'",
            target.display()
        );
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
    let bytes = match std::fs::read(&target) {
        Ok(b) => b,
        Err(e) => {
            log::warn!(
                "read_image_data_url: failed to read '{}': {e}",
                target.display()
            );
            return Ok(String::new());
        }
    };
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
    use crate::commands::file::{image_mime_from_ext, read_image_data_url, read_picked_file, MAX_PLUGIN_OPEN_FILE_BYTES};

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
        let decoded = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        assert_eq!(decoded, TINY_PNG);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn picked_file_roundtrips_non_utf8_content() {
        let path = unique_temp_path("map");
        let content: &[u8] = b"\x81\x40\x81\x41abc\x0d\x0a";
        std::fs::write(&path, content).unwrap();
        let picked = read_picked_file(path.clone()).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(picked.base64).unwrap();
        assert_eq!(decoded, content);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn picked_file_rejects_over_64mb() {
        let path = unique_temp_path("map");
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_PLUGIN_OPEN_FILE_BYTES + 1).unwrap();
        drop(f);
        let err = read_picked_file(path.clone()).err().unwrap();
        assert!(err.to_string().contains("超过 64MB"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn picked_file_missing_path_is_error() {
        let path = unique_temp_path("map");
        let err = read_picked_file(path).err().unwrap();
        assert!(err.to_string().contains("Cannot open selected file"));
    }
}
