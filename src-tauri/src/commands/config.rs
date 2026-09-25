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
///
/// 落盘后把配置中属于「运行期镜像」的部分（日志设置 + 诊断日志开关）应用到
/// `AppState::apply_runtime_config`——唯一同步入口。此前这里是逐字段手抄的
/// setter 列表，与 `AppState::new` 的第二份列表并存，新增字段时必然漏同步一处。
#[tauri::command]
pub fn set_config(
    new_config: config::AppConfig,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let cfg = {
        let mut manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .set_config(new_config)
            .map_err(|e| CommandError::Config(e.to_string()))?;
        manager.get_config().clone()
    };
    state.apply_runtime_config(&cfg);
    Ok(())
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
