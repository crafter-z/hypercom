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
