/**
 * 通用文件读写命令
 * 用于配置 bundle 的导出 / 导入。路径均来自前端原生 save()/open() 对话框，
 * 由用户显式选择，因此不做日志目录作用域限制（区别于 export_terminal_log）。
 */
use crate::commands::CommandError;

/// 将文本内容写入指定路径（配置导出）
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), CommandError> {
    std::fs::write(&path, content.as_bytes())
        .map_err(|e| CommandError::Io(format!("Failed to write file '{path}': {e}")))
}

/// 读取文本文件内容（配置导入）
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, CommandError> {
    std::fs::read_to_string(&path)
        .map_err(|e| CommandError::Io(format!("Failed to read file '{path}': {e}")))
}
