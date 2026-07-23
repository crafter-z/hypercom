use serde::Serialize;
use tauri::State;

use super::CommandError;
use crate::AppState;

/// 获取系统状态（内存、CPU）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    pub status: String,
    pub memory_used_mb: u64,
    pub memory_limit_mb: u64,
    pub cpu_usage: f32,
}

#[tauri::command]
pub fn get_system_status(state: State<AppState>) -> Result<SystemStatus, CommandError> {
    let memory_limit_mb = match state.config_manager.lock() {
        Ok(config_mgr) => config_mgr.get_config().memory_limit_mb as u64,
        Err(e) => {
            log::warn!("config_manager lock failed: {e}");
            0
        }
    };

    // 增量刷新缓存的 System 实例 — 仅刷新本进程与全部 CPU，避免每次 new_all() + refresh_all() 的高开销
    let pid = sysinfo::Pid::from(std::process::id() as usize);
    let (used_memory, cpu_usage) = match state.system_info.lock() {
        Ok(mut system) => {
            system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), false);
            system.refresh_cpu_all();

            let used_memory = system
                .process(pid)
                .map_or(0, |p| p.memory() / (1024 * 1024));

            let cpu_usage = if system.cpus().is_empty() {
                0.0
            } else {
                let total: f32 = system.cpus().iter().map(|c| c.cpu_usage()).sum();
                total / system.cpus().len() as f32
            };

            (used_memory, cpu_usage)
        }
        Err(e) => {
            log::warn!("system_info lock failed: {e}");
            (0u64, 0.0f32)
        }
    };

    let status = if cpu_usage > 90.0 || used_memory > memory_limit_mb {
        "high_load".to_string()
    } else {
        "normal".to_string()
    };

    Ok(SystemStatus {
        status,
        memory_used_mb: used_memory,
        memory_limit_mb,
        cpu_usage: (cpu_usage * 10.0).round() / 10.0,
    })
}

/// 设置防止系统息屏
#[tauri::command]
pub fn prevent_screen_off(enable: bool) -> Result<(), CommandError> {
    crate::system::prevent_screen_off(enable).map_err(CommandError::System)?;
    log::info!("Prevent screen off: {enable}");
    Ok(())
}

#[tauri::command]
pub fn prevent_sleep(enable: bool) -> Result<(), CommandError> {
    crate::system::prevent_sleep(enable).map_err(CommandError::System)?;
    log::info!("Prevent sleep: {enable}");
    Ok(())
}
