use tauri::State;

use super::CommandError;
use crate::{config, AppState};

/// 获取当前应用配置
#[tauri::command]
pub fn get_config(state: State<AppState>) -> Result<config::AppConfig, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.get_config().clone())
}

/// 更新应用配置
#[tauri::command]
pub fn set_config(
    new_config: config::AppConfig,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .set_config(new_config)
        .map_err(|e| CommandError::Config(e.to_string()))
}

/// 重置配置为默认值
#[tauri::command]
pub fn reset_config(state: State<AppState>) -> Result<config::AppConfig, CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .reset_to_default()
        .map_err(|e| CommandError::Config(e.to_string()))
}

/// 仅更新会话快照字段（避免全量配置保存引发的竞态覆盖）
#[tauri::command]
pub fn update_session_snapshot(
    snapshot: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .update_session_snapshot(&snapshot)
        .map_err(|e| CommandError::Config(e.to_string()))
}

/// 返回当前生效的配置文件绝对路径
#[tauri::command]
pub fn get_config_path(state: State<AppState>) -> Result<String, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.config_path().display().to_string())
}
