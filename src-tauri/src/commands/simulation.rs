use tauri::State;

use super::CommandError;
use crate::AppState;

/// 启用模拟模式（在串口列表中添加 SIM:Loopback）
#[tauri::command]
pub fn enable_simulation(state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.set_simulate(true);
    log::info!("Simulation mode enabled");
    Ok(())
}

/// 禁用模拟模式（关闭所有模拟串口并从列表中移除）
#[tauri::command]
pub fn disable_simulation(state: State<AppState>) -> Result<(), CommandError> {
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
