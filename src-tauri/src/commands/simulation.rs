//! 模拟串口（`SIM:Loopback`）控制命令。
//!
//! 模拟能力只应存在于 debug 构建：release 安装包里伪造端口没有意义，只是额外
//! 攻击面。门控收敛为入口处的 `dev_only` 守卫（唯一门控点，见
//! `system_cmds::dev_only`）——命令体只有一份实现，release 下由守卫拒绝；
//! 前端 UI 入口另有 `import.meta.env.DEV` 隐藏。
use tauri::State;

use super::system_cmds::dev_only;
use super::CommandError;
use crate::{serial::SIM_PORT_IDS, AppState};

/// 启用模拟模式（在串口列表中添加 SIM:Loopback 与 SIM:Loopback2）
#[tauri::command]
pub fn enable_simulation(state: State<AppState>) -> Result<(), CommandError> {
    dev_only("Simulation")?;
    let _native = state.admit_native_ports(SIM_PORT_IDS)?;

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
pub async fn disable_simulation(state: State<'_, AppState>) -> Result<(), CommandError> {
    dev_only("Simulation")?;

    // CLI 只支持枚举出的两个模拟端口，一次性准入且不先持有 manager 锁。
    let native = state.admit_native_ports(SIM_PORT_IDS)?;
    let serial_manager = state.serial_manager.clone();
    tokio::task::spawn_blocking(move || {
        // 即使调用方取消等待，也要在实际关闭和 join 完成后才放行 CLI。
        let _native = native;
        let sim_ids: Vec<String> = {
            let mut manager = serial_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            manager.set_simulate(false);
            manager.sim_ports.keys().cloned().collect()
        };
        for id in &sim_ids {
            let join_handle = {
                let mut manager = serial_manager
                    .lock()
                    .map_err(|e| CommandError::Lock(e.to_string()))?;
                manager
                    .close_port(id)
                    .map_err(|e| CommandError::Serial(e.to_string()))?
            };
            if let Some(thread) = join_handle {
                let _ = thread.join();
            }
        }
        log::info!("Simulation mode disabled");
        Ok(())
    })
    .await
    .map_err(|e| CommandError::Other(format!("simulation close task failed: {e}")))?
}
