//! 模拟终端（git bash pty，`GIT:BASH` 虚拟端口）控制命令。
//!
//! 与模拟串口同城：能力只应存在于 debug 构建，门控收敛为入口处的 `dev_only`
//! 守卫（唯一门控点，见 `system_cmds::dev_only`）——命令体只有一份实现，
//! release 下由守卫拒绝；前端 UI 入口另有 `import.meta.env.DEV` 隐藏。
//!
//! 端口可用性还有第二道门：即使命令被调用，`SerialManager::open_port` 也会按
//! `PortKind::of(port_id)` 分派并校验 `gitbash_sim` 能力开关，未启用时返回错误
//! 而不 spawn 任何进程（实现在 `serial/mod.rs`）。
//!
//! CLI 暂不支持 TTY 租约；这里仍使用共享设备准入，保持 TTY 修改路径与其他端口一致。
use tauri::{AppHandle, Manager, State};

use super::system_cmds::dev_only;
use super::CommandError;
use crate::{
    serial::{PortKind, TTY_PORT_ID},
    AppState,
};

/// 启用模拟终端模式（在串口列表中添加 GIT:BASH 虚拟端口）
#[tauri::command]
pub async fn enable_gitbash_sim(app: AppHandle) -> Result<String, CommandError> {
    dev_only("Git Bash sim terminal")?;

    tokio::task::spawn_blocking(move || {
        // 校验 git bash 存在（spawn 前快速失败，避免打开后才发现）。
        if crate::serial::tty_sim::find_bash().is_none() {
            return Err(CommandError::Other(
                "git bash not found — install Git for Windows".to_string(),
            ));
        }
        let state = app.state::<AppState>();
        let _native = state.admit_native_port(TTY_PORT_ID)?;
        let mut manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.set_gitbash_sim(true);
        log::info!("Git Bash sim terminal enabled");
        Ok(TTY_PORT_ID.to_string())
    })
    .await
    .map_err(|e| CommandError::Other(format!("enable git bash sim task failed: {e}")))?
}

/// 禁用模拟终端模式（关闭所有模拟终端端口并从列表中移除）
#[tauri::command]
pub async fn disable_gitbash_sim(state: State<'_, AppState>) -> Result<(), CommandError> {
    dev_only("Git Bash sim terminal")?;
    let native = state.admit_native_port(TTY_PORT_ID)?;
    let serial_manager = state.serial_manager.clone();

    tokio::task::spawn_blocking(move || {
        // 阻塞任务持有准入直到所有会话清理完成，不依赖 IPC future。
        let _native = native;
        let join_handles = {
            let mut manager = serial_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            manager.set_gitbash_sim(false);
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
        // 在 manager 锁外 join，避免阻塞其他串口命令。
        for thread in join_handles {
            let _ = thread.join();
        }
        log::info!("Git Bash sim terminal disabled");
        Ok(())
    })
    .await
    .map_err(|e| CommandError::Other(format!("disable git bash sim task failed: {e}")))?
}

/// 调整模拟终端（git bash pty）尺寸（前端 xterm fit() 后调用）
#[tauri::command]
pub async fn resize_gitbash_sim(
    state: State<'_, AppState>,
    port_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    dev_only("Git Bash sim terminal")?;
    if PortKind::of(&port_id) != PortKind::Tty {
        return Err(CommandError::Serial(format!(
            "TTY sim port not found: {port_id}"
        )));
    }
    let native = state.admit_native_port(&port_id)?;
    let serial_manager = state.serial_manager.clone();

    tokio::task::spawn_blocking(move || {
        let _native = native;
        let manager = serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .resize_tty_sim(&port_id, cols, rows)
            .map_err(|e| CommandError::Serial(e.to_string()))
    })
    .await
    .map_err(|e| CommandError::Other(format!("resize git bash sim task failed: {e}")))?
}
