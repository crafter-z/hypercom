/**
 * 通用文件读写命令
 * 用于配置 bundle 的导出 / 导入。
 *
 * 作用域校验 (defects #54 同类): 仅允许读写应用配置目录
 * (dirs::config_dir()/hypercom) 子树下的路径，防止前端借读写命令
 * 越权访问任意文件。canonicalize 解析符号链接与 ".." 后再比对前缀。
 */
use std::path::PathBuf;

use crate::commands::CommandError;

/// 校验目标路径位于应用配置目录子树内，返回原始 PathBuf。
/// 写入场景下文件可能尚不存在，因此回退到对父目录 canonicalize。
fn validate_config_path(path: &str) -> Result<PathBuf, CommandError> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| CommandError::Io("Cannot resolve config directory".into()))?
        .join("hypercom");
    let target = PathBuf::from(path);
    let canonical = target
        .canonicalize()
        .or_else(|_| {
            // File might not exist yet (for write), check parent
            target
                .parent()
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "No parent")
                })
                .and_then(|p| p.canonicalize())
        })
        .map_err(|e| CommandError::Io(e.to_string()))?;
    let canonical_root = config_dir
        .canonicalize()
        .map_err(|e| CommandError::Io(e.to_string()))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(CommandError::Io(format!(
            "Path outside config directory: {}",
            path
        )));
    }
    Ok(target)
}

/// 将文本内容写入指定路径（配置导出）
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), CommandError> {
    let target = validate_config_path(&path)?;
    std::fs::write(&target, content.as_bytes())
        .map_err(|e| CommandError::Io(format!("Failed to write file '{path}': {e}")))
}

/// 读取文本文件内容（配置导入）
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, CommandError> {
    let target = validate_config_path(&path)?;
    std::fs::read_to_string(&target)
        .map_err(|e| CommandError::Io(format!("Failed to read file '{path}': {e}")))
}
