//! 模拟终端（git bash pty，`GIT:BASH` 虚拟端口）控制命令。
//!
//! 与模拟串口同城：能力只应存在于 debug 构建，门控收敛为入口处的 `dev_only`
//! 守卫（唯一门控点，见 `system_cmds::dev_only`）——命令体只有一份实现，
//! release 下由守卫拒绝；前端 UI 入口另有 `import.meta.env.DEV` 隐藏。
//!
//! 端口可用性还有第二道门：即使命令被调用，`SerialManager::open_port` 也会按
//! `PortKind::of(port_id)` 分派并校验 `gitbash_sim` 能力开关，未启用时返回错误
//! 而不 spawn 任何进程（实现在 `serial/mod.rs`）。
use tauri::State;

use super::system_cmds::dev_only;
use super::CommandError;
use crate::AppState;

/// 启用模拟终端模式（在串口列表中添加 GIT:BASH 虚拟端口）
#[tauri::command]
pub fn enable_gitbash_sim(state: State<AppState>) -> Result<String, CommandError> {
    dev_only("Git Bash sim terminal")?;

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

/// 禁用模拟终端模式（关闭所有模拟终端端口并从列表中移除）
#[tauri::command]
pub async fn disable_gitbash_sim(state: State<'_, AppState>) -> Result<(), CommandError> {
    dev_only("Git Bash sim terminal")?;

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
    // 在锁外、阻塞线程池里 join（与 close_serial_port 同款）：即使某个 GIT:
    // 读线程异常不退，同步 join 也不会冻结应用 UI/事件循环。
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

/// 调整模拟终端（git bash pty）尺寸（前端 xterm fit() 后调用）
#[tauri::command]
pub fn resize_gitbash_sim(
    state: State<AppState>,
    port_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    dev_only("Git Bash sim terminal")?;

    let manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .resize_tty_sim(&port_id, cols, rows)
        .map_err(|e| CommandError::Serial(e.to_string()))
}
