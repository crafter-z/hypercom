use tauri::State;

use super::CommandError;
use crate::AppState;

/// 模拟终端（git bash pty）仅在调试构建可用（issue #11）。
/// release 安装包（`tauri build`，`debug_assertions` 关闭）下命令直接报错；
/// 前端 UI 入口同样按 `import.meta.env.DEV` 隐藏，双层门控。
#[cfg(not(debug_assertions))]
const TTY_SIM_UNAVAILABLE: &str = "Git Bash sim terminal is only available in debug builds";

/// 启用模拟终端模式（在串口列表中添加 GIT:BASH 虚拟端口）
#[tauri::command]
pub fn enable_gitbash_sim(state: State<AppState>) -> Result<String, CommandError> {
    #[cfg(not(debug_assertions))]
    {
        let _ = state;
        return Err(CommandError::Serial(TTY_SIM_UNAVAILABLE.to_string()));
    }
    #[cfg(debug_assertions)]
    {
        let mut manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        // 校验 git bash 存在（spawn 前快速失败，避免打开后才发现）
        if crate::serial::tty_sim::find_bash().is_none() {
            return Err(CommandError::Other(
                "git bash not found — install Git for Windows".to_string(),
            ));
        }
        manager.set_gitbash_sim(true);
        log::info!("Git Bash sim terminal enabled");
        Ok("GIT:BASH".to_string())
    }
}

/// 禁用模拟终端模式（关闭所有模拟终端端口并从列表中移除）
#[tauri::command]
pub async fn disable_gitbash_sim(state: State<'_, AppState>) -> Result<(), CommandError> {
    #[cfg(not(debug_assertions))]
    {
        let _ = state;
        return Err(CommandError::Serial(TTY_SIM_UNAVAILABLE.to_string()));
    }
    #[cfg(debug_assertions)]
    {
        let serial_manager = state.serial_manager.clone();
        // 持锁期间遍历全部 GIT: 端口逐个 close_port（kill + drop master → ConPTY
        // 关闭 → 读线程 read() 解除阻塞退出），取出 JoinHandle 后立即释放锁。
        let join_handles = {
            let mut manager = serial_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            let git_ids: Vec<String> = manager.tty_sim_ports.keys().cloned().collect();
            let mut handles = Vec::with_capacity(git_ids.len());
            for id in &git_ids {
                if let Some(thread) = manager
                    .close_port(id)
                    .map_err(|e| CommandError::Serial(e.to_string()))?
                {
                    handles.push(thread);
                }
            }
            handles
        };
        // 在锁外、阻塞线程池里 join（与 close_serial_port 同款，issue #11）：即使
        // 某个 GIT: 读线程异常不退，同步 join 也不会冻结应用 UI/事件循环。
        for thread in join_handles {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = thread.join();
            })
            .await
            .map_err(|e| {
                CommandError::Other(format!("disable git bash sim join task failed: {e}"))
            })?;
        }
        let mut manager = serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.set_gitbash_sim(false);
        log::info!("Git Bash sim terminal disabled");
        Ok(())
    }
}

/// 调整模拟终端（git bash pty）尺寸（前端 xterm fit() 后调用）
#[tauri::command]
pub fn resize_gitbash_sim(
    state: State<AppState>,
    port_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    #[cfg(not(debug_assertions))]
    {
        let _ = state;
        let _ = (port_id, cols, rows);
        return Err(CommandError::Serial(TTY_SIM_UNAVAILABLE.to_string()));
    }
    #[cfg(debug_assertions)]
    {
        let manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .resize_tty_sim(&port_id, cols, rows)
            .map_err(|e| CommandError::Serial(e.to_string()))
    }
}