/**
 * 模拟终端端口 (git bash pty, GIT:BASH)
 * 把 pty 包装成「虚拟串口」：TX 走 pty stdin，RX 由 `serial/tty_sim.rs` 的读线程
 * 派发。pty 的 spawn / 读线程 / DSR 应答等实现细节都在 `tty_sim` 模块内。
 *
 * 能力门控在 `SerialManager::open_port`（`gitbash_sim` 开关）：release 构建下
 * `enable_gitbash_sim` 直接报错，开关恒为 false，因此这里绝不会 spawn 出 bash。
 */
use std::sync::atomic::Ordering;
use std::thread;

use super::codec::{build_tx_bytes, normalize_tty_line_ending, TxOutcome};
use super::{emit_status, PortInfo, PortStatus, SerialManager};
use crate::commands::OpenPortArgs;

/// 模拟终端的端口 id
pub(super) const TTY_PORT_ID: &str = "GIT:BASH";

/// 列表条目（仅当 `gitbash_sim` 启用时由 `SerialManager` 追加到系统端口列表之后）。
pub(super) fn virtual_port_info() -> PortInfo {
    PortInfo {
        id: TTY_PORT_ID.to_string(),
        name: "GIT:BASH (git bash 模拟终端)".to_string(),
        port_type: "sim".to_string(),
        manufacturer: None,
        product: None,
    }
}

/// 打开模拟终端端口（锁内；能力门控已由 `SerialManager::open_port` 校验）。
///
/// `spawn_bash` 失败（git bash 未安装等）时干净报错，不在 `tty_sim_ports` 留下
/// 游离句柄。
pub(super) fn open(manager: &mut SerialManager, args: OpenPortArgs) -> anyhow::Result<()> {
    let app_handle = manager
        .app_handle
        .clone()
        .ok_or_else(|| anyhow::anyhow!("AppHandle not initialized"))?;

    if let Some(mut handle) = manager.tty_sim_ports.remove(&args.port_id) {
        let exited = handle
            .child
            .as_mut()
            .map(|child| child.try_wait())
            .transpose()?
            .flatten()
            .is_some();
        if handle.running.load(Ordering::Relaxed) && !exited {
            manager.tty_sim_ports.insert(args.port_id.clone(), handle);
            return Err(anyhow::anyhow!("Port {} is already open", args.port_id));
        }
        // Reader/master/child teardown is never performed under SerialManager.
        thread::spawn(move || handle.shutdown());
    }

    let generation = manager
        .connection_generations
        .get(&args.port_id)
        .copied()
        .unwrap_or_default();
    let handle =
        super::tty_sim::spawn_bash(&app_handle, &args.port_id, args.cols, args.rows, generation)?;

    let port_id = args.port_id.clone();
    let ready = handle.ready.clone();
    manager.tty_sim_ports.insert(args.port_id, handle);
    emit_status(&app_handle, &port_id, PortStatus::Connected, Some(generation));
    ready.store(true, Ordering::Release);
    log::info!("TTY sim port opened: {}", port_id);
    Ok(())
}

/// 关闭模拟终端：只从注册表 detach；kill/master drop/join/reap 在锁外 cleanup 线程执行。
pub(super) fn close(manager: &mut SerialManager, port_id: &str) -> Option<thread::JoinHandle<()>> {
    let handle = manager.tty_sim_ports.remove(port_id)?;
    let thread = thread::spawn(move || handle.shutdown());
    log::info!("TTY sim port closed: {}", port_id);
    Some(thread)
}

/// 向 pty 发送数据（TX）。
///
/// 行结束符必须先归一（见 `normalize_tty_line_ending`）：`\r\n` 在行规程
/// （ICRNL）下会变成两个换行，bash 会多执行一行空命令。返回的 `TxOutcome`
/// 携带归一后**实际写入 pty** 的字节，TX 日志据此记录。
pub(super) fn send(
    manager: &SerialManager,
    port_id: &str,
    data: &str,
    is_hex: bool,
    append_line_ending: &str,
) -> anyhow::Result<TxOutcome> {
    let handle = manager
        .tty_sim_ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("TTY sim port not found: {}", port_id))?;
    let bytes = build_tx_bytes(data, is_hex, normalize_tty_line_ending(append_line_ending))?;
    handle.write(&bytes)?;
    Ok(TxOutcome::sent(bytes))
}

/// 向 pty 写入原始字节（不做 HEX 解析、不附加/归一化行结束符）。用于文件发送。
pub(super) fn write_raw(
    manager: &SerialManager,
    port_id: &str,
    bytes: &[u8],
) -> anyhow::Result<usize> {
    let handle = manager
        .tty_sim_ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("TTY sim port not found: {}", port_id))?;
    handle.write(bytes)
}

/// 调整 pty 尺寸：前端 TTY 视图（xterm.js）随容器 fit() 后调用，全屏应用据此重绘。
pub(super) fn resize(
    manager: &SerialManager,
    port_id: &str,
    cols: u16,
    rows: u16,
) -> anyhow::Result<()> {
    let handle = manager
        .tty_sim_ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("TTY sim port not found: {}", port_id))?;
    handle.resize(cols, rows)
}

pub(super) fn write_handle(
    manager: &SerialManager,
    port_id: &str,
) -> anyhow::Result<super::tty_sim::TtyWriteHandle> {
    manager
        .tty_sim_ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("TTY sim port not found: {}", port_id))?
        .write_handle()
}
