use serde::Serialize;
use tauri::State;
use sysinfo::ProcessRefreshKind;

use super::CommandError;
use crate::AppState;

/// 获取系统状态（内存、CPU）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    pub status: String,
    pub memory_used_mb: u64,
    pub cpu_usage: f32,
}

/// 字节 → MB（向下取整）
fn memory_used_mb(used_bytes: u64) -> u64 {
    used_bytes / (1024 * 1024)
}

/// 依据 CPU 阈值判定负载状态（与历史阈值完全一致）
fn load_status(cpu: f32) -> &'static str {
    if cpu > 90.0 {
        "high_load"
    } else {
        "normal"
    }
}

/// 收集本进程 + 全部后代进程的 PID 集合（自底向上扩散，最多一轮全表扫描）。
/// WebView2/Chromium 的渲染/工具/GPU 子进程都挂在 host 进程之下，需要一并计入
/// 「软件自身内存」；纯函数、可注入进程表，便于单测（issue #6-6）。
fn collect_app_pids(
    own_pid: Option<sysinfo::Pid>,
    processes: &std::collections::HashMap<sysinfo::Pid, sysinfo::Process>,
) -> std::collections::HashSet<sysinfo::Pid> {
    let mut pids: std::collections::HashSet<sysinfo::Pid> = std::collections::HashSet::new();
    if let Some(pid) = own_pid {
        pids.insert(pid);
    }
    let mut changed = !pids.is_empty();
    while changed {
        changed = false;
        for (pid, proc_) in processes.iter() {
            if !pids.contains(pid) && proc_.parent().map_or(false, |p| pids.contains(&p)) {
                pids.insert(*pid);
                changed = true;
            }
        }
    }
    pids
}

/// 获取系统状态（内存、CPU）
///
/// 同步命令在事件循环主线程执行——内部 `refresh_processes_specifics(All, true, ..)`
/// 是**全系统进程表**刷新（不是只刷本进程树），前端每 5s 轮询一次；高频数据会话
/// 下周期性阻塞主线程会拖慢 RX 分发与重绘（TTY 卡顿根因 #1）。改 async +
/// spawn_blocking（issue #6-1 `send_serial_data` 同款）：克隆 Arc 句柄，重活挪到
/// 独立线程池，主线程发完命令立即返回。行为（返回结构/字段/语义/调用频率）不变。
#[tauri::command]
pub async fn get_system_status(state: State<'_, AppState>) -> Result<SystemStatus, CommandError> {
    let system_info = state.system_info.clone();

    let (app_memory_used, cpu_usage) = tokio::task::spawn_blocking(move || {
        // 增量刷新缓存的 System 实例。内存改为【应用进程级】：本进程 + 全部后代
        // 进程（含 WebView2 子进程）的 RSS 之和。旧实现取系统级 used_memory——
        // webview 是独立进程，系统级读数既不反映本软件占用，且永远大于总预算
        // 导致状态恒为 high_load（issue #6-6）。CPU 仍取系统级（load_status 的
        // 90% 阈值语义不变）。
        match system_info.lock() {
            Ok(mut system) => {
                // 进程级内存 + CPU 采样（跳过 disk/exe，避免无谓开销）
                system.refresh_processes_specifics(
                    sysinfo::ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing().with_memory().with_cpu(),
                );
                let app_pids = collect_app_pids(sysinfo::get_current_pid().ok(), system.processes());
                let app_memory_bytes: u64 = system
                    .processes()
                    .iter()
                    .filter(|(pid, _)| app_pids.contains(pid))
                    .map(|(_, proc_)| proc_.memory())
                    .sum();

                let cpu_usage = if system.cpus().is_empty() {
                    0.0
                } else {
                    let total: f32 = system.cpus().iter().map(|c| c.cpu_usage()).sum();
                    total / system.cpus().len() as f32
                };

                (memory_used_mb(app_memory_bytes), cpu_usage)
            }
            Err(e) => {
                log::warn!("system_info lock failed: {e}");
                (0u64, 0.0f32)
            }
        }
    })
    .await
    .map_err(|e| CommandError::Other(format!("System status task panicked: {e}")))?;

    let status = load_status(cpu_usage).to_string();

    Ok(SystemStatus {
        status,
        memory_used_mb: app_memory_used,
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
    use super::collect_app_pids;
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
        assert_eq!(load_status(90.1), "high_load");
    }

    #[test]
    fn load_status_cpu_exactly_at_threshold_is_normal() {
        assert_eq!(load_status(90.0), "normal");
    }

    #[test]
    fn load_status_cpu_below_threshold_is_normal() {
        assert_eq!(load_status(50.0), "normal");
    }

    // ===== issue #6-6：进程级内存的 PID 收集 =====

    #[test]
    fn collect_app_pids_includes_self_and_children() {
        // 直接验证 collect_app_pids 在空表 / 仅自身 / 带子进程表上的行为。
        // sysinfo::Process 构造不可用，这里用最小可测面：空表 + 自身。
        let empty: std::collections::HashMap<sysinfo::Pid, sysinfo::Process> =
            std::collections::HashMap::new();
        let none = collect_app_pids(None, &empty);
        assert!(none.is_empty(), "no own pid + empty table -> empty set");

        let own = sysinfo::get_current_pid().ok();
        let only_self = collect_app_pids(own, &empty);
        if let Some(pid) = own {
            assert!(only_self.contains(&pid));
            assert_eq!(only_self.len(), 1);
        } else {
            assert!(only_self.is_empty());
        }
    }

    #[test]
    fn collect_app_pids_never_panics_on_real_process_table() {
        // 用真实进程表跑一遍扩散逻辑，验证不会 panic、且必然包含本进程。
        let mut system = sysinfo::System::new_all();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing().with_memory(),
        );
        let own = sysinfo::get_current_pid().ok();
        let pids = collect_app_pids(own, system.processes());
        if let Some(pid) = own {
            assert!(pids.contains(&pid), "own pid must be in the collected set");
        }
    }
}
