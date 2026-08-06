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

/// 字节 → MB（向下取整）
fn memory_used_mb(used_bytes: u64) -> u64 {
    used_bytes / (1024 * 1024)
}

/// 依据 CPU / 内存阈值判定负载状态（与历史阈值完全一致）
fn load_status(cpu: f32, used_mb: u64, limit_mb: u64) -> &'static str {
    if cpu > 90.0 || used_mb > limit_mb {
        "high_load"
    } else {
        "normal"
    }
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

    // 增量刷新缓存的 System 实例 — 仅刷新内存与全部 CPU，避免每次 new_all() + refresh_all() 的高开销
    let (used_memory, cpu_usage) = match state.system_info.lock() {
        Ok(mut system) => {
            system.refresh_memory();
            system.refresh_cpu_all();

            let used_memory = memory_used_mb(system.used_memory());

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

    let status = load_status(cpu_usage, used_memory, memory_limit_mb).to_string();

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

#[cfg(test)]
mod tests {
    use super::load_status;
    use super::memory_used_mb;

    const MB: u64 = 1024 * 1024;

    #[test]
    fn memory_used_mb_zero_bytes() {
        assert_eq!(memory_used_mb(0), 0);
    }

    #[test]
    fn memory_used_mb_just_below_one_mb_floors_to_zero() {
        assert_eq!(memory_used_mb(MB - 1), 0);
    }

    #[test]
    fn memory_used_mb_exactly_one_mb() {
        assert_eq!(memory_used_mb(MB), 1);
    }

    #[test]
    fn memory_used_mb_two_and_a_half_mb_floors_to_two() {
        assert_eq!(memory_used_mb(MB * 2 + MB / 2), 2);
    }

    #[test]
    fn load_status_cpu_above_threshold_is_high_load() {
        assert_eq!(load_status(90.1, 0, 1024), "high_load");
    }

    #[test]
    fn load_status_cpu_exactly_at_threshold_is_normal() {
        assert_eq!(load_status(90.0, 0, 1024), "normal");
    }

    #[test]
    fn load_status_memory_above_limit_is_high_load() {
        assert_eq!(load_status(0.0, 1025, 1024), "high_load");
    }

    #[test]
    fn load_status_memory_exactly_at_limit_is_normal() {
        assert_eq!(load_status(0.0, 1024, 1024), "normal");
    }

    #[test]
    fn load_status_memory_over_zero_limit_is_high_load() {
        assert_eq!(load_status(0.0, 1, 0), "high_load");
    }

    #[test]
    fn load_status_both_below_thresholds_is_normal() {
        assert_eq!(load_status(50.0, 512, 1024), "normal");
    }
}
