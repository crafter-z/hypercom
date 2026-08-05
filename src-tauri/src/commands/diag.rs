use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use super::CommandError;
use crate::{AppState, diaglog::DiagLogger};

/// 前端 `console.*` 转发来的日志条目（由前端诊断日志捕获器批量上报）。
#[derive(Debug, Deserialize)]
pub struct DiagLogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

/// 返回诊断日志文件路径（活跃文件）。
#[tauri::command]
pub fn get_diag_log_path(state: State<AppState>) -> Result<String, CommandError> {
    Ok(state
        .diag_logger
        .file_path()
        .display()
        .to_string())
}

/// 读取最近 `limit` 行诊断日志（缺省 2000）。
#[tauri::command]
pub fn read_diag_log(
    state: State<AppState>,
    limit: Option<usize>,
) -> Result<String, CommandError> {
    let limit = limit.unwrap_or(2000).clamp(100, 20000);
    Ok(state.diag_logger.read(limit))
}

/// 清空全部诊断日志（活跃文件 + 轮转备份 + 前端待刷缓冲由前端一并清空）。
#[tauri::command]
pub fn clear_diag_log(state: State<AppState>) -> Result<(), CommandError> {
    state.diag_logger.clear();
    Ok(())
}

/// 追加一批前端 `console.*` 日志到诊断日志文件（与后端日志同一文件）。
#[tauri::command]
pub fn append_diag_log(
    state: State<AppState>,
    entries: Vec<DiagLogEntry>,
) -> Result<(), CommandError> {
    let logger: Arc<DiagLogger> = state.diag_logger.clone();
    for entry in entries {
        logger.append_external(&entry.timestamp, &entry.level, &entry.message);
    }
    Ok(())
}