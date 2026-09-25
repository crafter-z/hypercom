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

    // 陈旧句柄守卫：存活句柄报错，死线程句柄移除（避免 insert 覆盖后泄漏读线程）。
    if let Some(handle) = manager.tty_sim_ports.get(&args.port_id) {
        if handle.running.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("Port {} is already open", args.port_id));
        }
    }
    manager.tty_sim_ports.remove(&args.port_id);

    // 把前端 xterm 当前尺寸传给 pty（否则 pty 固定 80×24，vim/top 等全屏应用
    // 按 80×24 渲染而 xterm 按自身尺寸显示，画面错乱）。
    let handle = super::tty_sim::spawn_bash(&app_handle, &args.port_id, args.cols, args.rows)?;

    emit_status(&app_handle, &args.port_id, PortStatus::Connected);

    let port_id = args.port_id.clone();
    manager.tty_sim_ports.insert(args.port_id, handle);
    log::info!("TTY sim port opened: {}", port_id);
    Ok(())
}

/// 关闭模拟终端：kill bash 子进程并关闭 ConPTY，返回读线程由调用方在锁外 join。
pub(super) fn close(manager: &mut SerialManager, port_id: &str) -> Option<thread::JoinHandle<()>> {
    let mut handle = manager.tty_sim_ports.remove(port_id)?;
    handle.running.store(false, Ordering::Relaxed);
    handle.kill();
    // drop master → 关闭 ConPTY（ClosePseudoConsole）→ 输出管道写端关闭 →
    // 读线程 read() 解除阻塞退出。否则读线程永久阻塞在 ConPTY 读上，
    // close_serial_port 的 join 永不返回（命令在主线程执行 → 应用卡死）。
    handle.master = None;
    log::info!("TTY sim port closed: {}", port_id);
    handle.read_thread.take()
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
