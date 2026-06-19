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
