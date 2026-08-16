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
use std::path::Path;

use base64::Engine as _;

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

/// 背景图文件大小上限（20MB），超过即视为不可用。
const MAX_BACKGROUND_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 根据文件扩展名推断 MIME 类型（小写匹配）。
/// 不支持的扩展名返回 `None`；匹配 update.rs 的"不可用时静默返回空"风格。
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
/// 返回 `data:image/<mime>;base64,<...>`；路径为空/文件不存在/扩展名不支持/
/// 超过 `MAX_BACKGROUND_IMAGE_BYTES` 上限时返回空字符串（前端静默视为无背景图），
/// 仅记录 warn 日志。匹配 update.rs 的"不可用时静默返回空"风格。
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
    use crate::commands::file::{image_mime_from_ext, read_image_data_url};

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
}
