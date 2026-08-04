use tauri::State;

use super::CommandError;
use crate::AppState;

/// 模拟串口仅在调试构建可用（issue #2-9）。
/// release 安装包（`tauri build`，`debug_assertions` 关闭）下命令直接报错；
/// 前端 UI 入口同样按 `import.meta.env.DEV` 隐藏，双层门控。
#[cfg(not(debug_assertions))]
const SIM_UNAVAILABLE: &str = "Simulation is only available in debug builds";

/// 启用模拟模式（在串口列表中添加 SIM:Loopback）
#[tauri::command]
pub fn enable_simulation(state: State<AppState>) -> Result<(), CommandError> {
    #[cfg(not(debug_assertions))]
    {
        let _ = state;
        return Err(CommandError::Serial(SIM_UNAVAILABLE.to_string()));
    }
    #[cfg(debug_assertions)]
    {
        let mut manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.set_simulate(true);
        log::info!("Simulation mode enabled");
        Ok(())
    }
}

/// 禁用模拟模式（关闭所有模拟串口并从列表中移除）
#[tauri::command]
pub fn disable_simulation(state: State<AppState>) -> Result<(), CommandError> {
    #[cfg(not(debug_assertions))]
    {
        let _ = state;
        return Err(CommandError::Serial(SIM_UNAVAILABLE.to_string()));
    }
    #[cfg(debug_assertions)]
    {
        let sim_ids: Vec<String> = {
            let manager = state
                .serial_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            manager.sim_ports.keys().cloned().collect()
        };
        for id in &sim_ids {
            // 持锁期间只停止读取线程并取出 JoinHandle，立即释放锁
            let join_handle = {
                let mut manager = state
                    .serial_manager
                    .lock()
                    .map_err(|e| CommandError::Lock(e.to_string()))?;
                manager
                    .close_port(id)
                    .map_err(|e| CommandError::Serial(e.to_string()))?
            };
            // 在锁外 join，避免阻塞其他串口命令
            if let Some(thread) = join_handle {
                let _ = thread.join();
            }
        }
        let mut manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.set_simulate(false);
        log::info!("Simulation mode disabled");
        Ok(())
    }
}
