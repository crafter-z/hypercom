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
        let mut manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .close_port(id)
            .map_err(|e| CommandError::Serial(e.to_string()))?;
    }
    let mut manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.set_simulate(false);
    log::info!("Simulation mode disabled");
    Ok(())
}
