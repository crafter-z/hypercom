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

/// 更新应用配置。
/// 写入 config.json 后自动同步日志设置到 LogManager、诊断日志开关到 DiagLogger
///（消除双数据源）。
#[tauri::command]
pub fn set_config(
    new_config: config::AppConfig,
    state: State<AppState>,
) -> Result<(), CommandError> {
    // 先写配置
    {
        let mut manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .set_config(new_config.clone())
            .map_err(|e| CommandError::Config(e.to_string()))?;
    }
    // 再同步 LogManager（锁顺序：config → log，与 start_logging 一致）
    sync_log_manager_from_config(&state)?;
    // 同步诊断日志开关（原子开关，无需锁）
    state.diag_logger.set_enabled(new_config.diag_log_enabled);
    Ok(())
}

/// 重置配置为默认值
#[tauri::command]
pub fn reset_config(state: State<AppState>) -> Result<config::AppConfig, CommandError> {
    let cfg = {
        let mut manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .reset_to_default()
            .map_err(|e| CommandError::Config(e.to_string()))?
    };
    sync_log_manager_from_config(&state)?;
    state.diag_logger.set_enabled(cfg.diag_log_enabled);
    Ok(cfg)
}

/// 保存会话快照到独立 session.json（不触发 config .bak 备份）
#[tauri::command]
pub fn update_session_snapshot(
    snapshot: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .save_session_snapshot(&snapshot)
        .map_err(|e| CommandError::Config(e.to_string()))
}

/// 读取会话快照
#[tauri::command]
pub fn get_session_snapshot(state: State<AppState>) -> Result<String, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.load_session_snapshot())
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

/// 从 ConfigManager 当前配置同步全部日志设置到 LogManager。
/// 锁顺序：先 config（只读）→ 再 log（写），与 start_logging 一致，不会死锁。
fn sync_log_manager_from_config(state: &State<AppState>) -> Result<(), CommandError> {
    let cfg = {
        let mgr = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        mgr.get_config().clone()
    };
    let mut log_mgr = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    log_mgr.set_auto_save(cfg.auto_save_log);
    log_mgr.set_default_encoding(&cfg.log_encoding);
    log_mgr.set_filename_format(&cfg.log_filename_format);
    log_mgr.set_split_size(cfg.log_split_size_mb);
    log_mgr.set_split_enabled(cfg.log_split_enabled);
    log_mgr.set_include_timestamp(cfg.log_include_timestamp);
    log_mgr.set_include_direction(cfg.log_include_direction);
    log_mgr.set_subdir_mode(&cfg.log_subdir_mode);
    if !cfg.log_directory.is_empty() {
        if let Err(e) = log_mgr.set_directory(cfg.log_directory.clone()) {
            log::warn!("Failed to set log directory '{}': {}", cfg.log_directory, e);
        }
    }
    Ok(())
}
