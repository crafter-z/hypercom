/**
 * 模拟串口 (Simulated Port, SIM:Loopback)
 * 无硬件时提供回显 + 周期输出的虚拟串口。
 *
 * 回显：TX 文本 → RX `Received: <data>`；TX HEX → RX `[HEX] Received: <hex>`。
 * 周期输出：默认 2 行/s，发送纯数字可改速率（0 = 停）。
 *
 * 能力门控在 `SerialManager::open_port`（`simulate` 开关）：release 构建下
 * `enable_simulation` 直接报错，开关恒为 false，因此这里绝不会被调用。
 */
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::codec::{build_tx_bytes, TxOutcome};
use super::{emit_rx_event, emit_status, PortInfo, PortStatus, SerialManager};
use crate::commands::OpenPortArgs;

/// 模拟串口的端口 id
pub(super) const SIM_PORT_ID: &str = "SIM:Loopback";

/// 周期输出频率上限（次/秒）：10000/s 已远超真实串口吞吐（921600 baud ≈
/// 92KB/s ≈ 数千行/s），防止 interval 截断为 0 导致忙循环。
const MAX_SIM_RATE: u32 = 10_000;
/// 单个 100ms 循环内最多补发行数：rate=10000 时每循环应发 1000，留 10× 余量
/// 防极端追赶风暴把主线程打爆（emit + 日志在循环内同步执行）。
const MAX_SIM_BURST: u32 = 10_000;

/// 模拟串口内部消息
enum SimMessage {
    Echo {
        data: String,
        is_hex: bool,
    },
    /// 设置周期输出频率（次/秒）；0 = 停止周期输出
    SetRate {
        per_sec: u32,
    },
    Stop,
}

/// 模拟串口连接句柄
pub struct SimPortHandle {
    running: Arc<AtomicBool>,
    tx: mpsc::Sender<SimMessage>,
    read_thread: Option<thread::JoinHandle<()>>,
}

impl SimPortHandle {
    /// 请求读线程退出（发 Stop 后线程在下一次 100ms 循环退出）。
    pub(super) fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        let _ = self.tx.send(SimMessage::Stop);
    }
}

/// 列表条目（仅当 `simulate` 启用时由 `SerialManager` 追加到系统端口列表之后）。
pub(super) fn virtual_port_info() -> PortInfo {
    PortInfo {
        id: SIM_PORT_ID.to_string(),
        name: "SIM:Loopback (模拟串口)".to_string(),
        port_type: "sim".to_string(),
        manufacturer: None,
        product: None,
    }
}

/// 打开模拟串口（锁内；能力门控已由 `SerialManager::open_port` 校验）。
pub(super) fn open(manager: &mut SerialManager, args: OpenPortArgs) -> anyhow::Result<()> {
    let app_handle = manager
        .app_handle
        .clone()
        .ok_or_else(|| anyhow::anyhow!("AppHandle not initialized"))?;

    // 陈旧句柄守卫：存活句柄报错，死线程句柄移除（避免 insert 覆盖后泄漏读线程）。
    if let Some(handle) = manager.sim_ports.get(&args.port_id) {
        if handle.running.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("Port {} is already open", args.port_id));
        }
    }
    manager.sim_ports.remove(&args.port_id);

    let (tx, rx) = mpsc::channel::<SimMessage>();
    let running = Arc::new(AtomicBool::new(true));
    let port_id = args.port_id.clone();

    let read_thread = thread::spawn({
        let running = Arc::clone(&running);
        let app_handle = app_handle.clone();
        move || read_loop(port_id, rx, running, app_handle)
    });

    emit_status(&app_handle, &args.port_id, PortStatus::Connected);

    let port_id = args.port_id.clone();
    manager.sim_ports.insert(
        args.port_id,
        SimPortHandle {
            running,
            tx,
            read_thread: Some(read_thread),
        },
    );
    log::info!("Sim port opened: {}", port_id);
    Ok(())
}

/// 关闭模拟串口：请求读线程退出并返回其 JoinHandle，由调用方在锁外 join。
pub(super) fn close(manager: &mut SerialManager, port_id: &str) -> Option<thread::JoinHandle<()>> {
    let mut handle = manager.sim_ports.remove(port_id)?;
    handle.stop();
    log::info!("Sim port closed: {}", port_id);
    handle.read_thread.take()
}

/// 向模拟串口发送数据。
///
/// 返回的 `TxOutcome` 只包含**真正上线**的字节：文本模式且 trim 后为纯数字的 TX
/// 被当作频率命令，由控制通道吞掉、不回显，因此记为「0 字节」——TX 日志随之不
/// 记录，日志与线上字节保持一致（旧实现按入参重算日志，会记下并未发送的字节）。
pub(super) fn send(
    manager: &SerialManager,
    port_id: &str,
    data: &str,
    is_hex: bool,
    append_line_ending: &str,
) -> anyhow::Result<TxOutcome> {
    let handle = manager
        .sim_ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("Sim port not found: {}", port_id))?;
    let bytes = build_tx_bytes(data, is_hex, append_line_ending)?;
    let message = match parse_sim_rate_command(data, is_hex) {
        Some(rate) => SimMessage::SetRate { per_sec: rate },
        None => SimMessage::Echo {
            data: data.to_string(),
            is_hex,
        },
    };
    let swallowed = matches!(&message, SimMessage::SetRate { .. });
    handle
        .tx
        .send(message)
        .map_err(|e| anyhow::anyhow!("Failed to send to sim port: {}", e))?;
    Ok(if swallowed {
        TxOutcome::consumed()
    } else {
        TxOutcome::sent(bytes)
    })
}

/// 向模拟串口写入原始字节（文件发送）：字节序列转为 HEX 字符串回显，便于无硬件测试。
pub(super) fn write_raw(manager: &SerialManager, port_id: &str, bytes: &[u8]) -> anyhow::Result<usize> {
    let handle = manager
        .sim_ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("Sim port not found: {}", port_id))?;
    let hex_str = bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ");
    handle
        .tx
        .send(SimMessage::Echo {
            data: hex_str,
            is_hex: true,
        })
        .map_err(|e| anyhow::anyhow!("Failed to send to sim port: {}", e))?;
    Ok(bytes.len())
}

/// 读线程主体：处理回显/频率命令，并在 100ms 节拍上按当前频率补发周期输出。
fn read_loop(
    port_id: String,
    rx: mpsc::Receiver<SimMessage>,
    running: Arc<AtomicBool>,
    app_handle: AppHandle,
) {
    // 周期输出状态：默认 2/s（500ms，与旧心跳行为一致）；TX 纯数字可改。
    let mut rate_per_sec: u32 = 2;
    let mut next_send_at = Instant::now();
    let mut line_seq: u64 = 0;

    loop {
        if !running.load(Ordering::Relaxed) {
            break;
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(SimMessage::Echo { data, is_hex }) => {
                let echo_data = if is_hex {
                    format!("[HEX] Received: {}\r\n", data)
                } else {
                    format!("Received: {}\r\n", data)
                };
                emit_rx_event(&app_handle, &port_id, echo_data.as_bytes());
            }
            Ok(SimMessage::SetRate { per_sec }) => {
                // 频率命令：切换周期输出速率并重置节拍（首行立即发出，便于观察生效）。
                rate_per_sec = per_sec.min(MAX_SIM_RATE);
                next_send_at = Instant::now();
                log::debug!("{} periodic rate set to {}/s", port_id, rate_per_sec);
            }
            Ok(SimMessage::Stop) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // 周期输出：按 rate_per_sec 用积分器补发。100ms 循环节拍下高频率
                // （如 10000/s）每循环应发 1000 行，积分器保证平均频率精确且不被
                // 节拍粒度限制。
                if rate_per_sec > 0 {
                    let interval = Duration::from_micros(1_000_000 / rate_per_sec as u64);
                    let now = Instant::now();
                    let (due, next) = sim_due_lines(now, next_send_at, interval, MAX_SIM_BURST);
                    next_send_at = next;
                    for _ in 0..due {
                        line_seq += 1;
                        let heartbeat = format!("[SIM] Heartbeat #{}\r\n", line_seq);
                        emit_rx_event(&app_handle, &port_id, heartbeat.as_bytes());
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // 读取线程退出时发送断开事件（与真实串口读线程对齐）
    emit_status(&app_handle, &port_id, PortStatus::Disconnected);
}

/// 解析 SIM 频率命令：**文本模式**且 trim 后为纯数字 → `Some(rate)`（clamp 到
/// `MAX_SIM_RATE`）；其它（HEX 模式 / 非数字 / 空）→ `None`（走回显路径）。
/// 纯逻辑、不触碰 serialport FFI，Windows 测试可用。
fn parse_sim_rate_command(data: &str, is_hex: bool) -> Option<u32> {
    if is_hex {
        return None;
    }
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<u32>().ok().map(|r| r.min(MAX_SIM_RATE))
}

/// 周期输出积分器：计算「应发而未发」的完整间隔数。返回 `(应发行数, 推进后的
/// 下次发送时刻)`。`max` 限制单次补发上限（追赶风暴防护）；若因上限提前退出
/// 仍落后（如长时间隐藏窗口积压），把 next 重置到 now，避免无限补发。
fn sim_due_lines(
    now: Instant,
    mut next: Instant,
    interval: Duration,
    max: u32,
) -> (u32, Instant) {
    let mut due = 0u32;
    while now >= next && due < max {
        next += interval;
        due += 1;
    }
    if now > next {
        next = now;
    }
    (due, next)
}

#[cfg(test)]
mod tests {
    // 显式导入而非 `use super::*`（Windows 测试二进制不能链接 serialport FFI）。
    // 两个函数都是纯逻辑，测试在所有平台可跑。
    use super::{parse_sim_rate_command, sim_due_lines, MAX_SIM_RATE};
    use std::time::{Duration, Instant};

    #[test]
    fn parse_sim_rate_command_accepts_pure_numbers() {
        assert_eq!(parse_sim_rate_command("100", false), Some(100));
        assert_eq!(parse_sim_rate_command("0", false), Some(0));
        assert_eq!(parse_sim_rate_command("2", false), Some(2));
    }

    #[test]
    fn parse_sim_rate_command_trims_whitespace_and_line_endings() {
        assert_eq!(parse_sim_rate_command(" 100 ", false), Some(100));
        assert_eq!(parse_sim_rate_command("100\r\n", false), Some(100));
        assert_eq!(parse_sim_rate_command("\t500\t", false), Some(500));
    }

    #[test]
    fn parse_sim_rate_command_rejects_non_numeric() {
        assert_eq!(parse_sim_rate_command("", false), None);
        assert_eq!(parse_sim_rate_command("   ", false), None);
        assert_eq!(parse_sim_rate_command("abc", false), None);
        assert_eq!(parse_sim_rate_command("100x", false), None);
        assert_eq!(parse_sim_rate_command("-5", false), None);
        assert_eq!(parse_sim_rate_command("3.5", false), None);
        // u32 溢出
        assert_eq!(parse_sim_rate_command("99999999999999", false), None);
    }

    #[test]
    fn parse_sim_rate_command_rejects_hex_mode() {
        // HEX 模式发"100"是字节 31 30 30，不是频率命令
        assert_eq!(parse_sim_rate_command("100", true), None);
    }

    #[test]
    fn parse_sim_rate_command_clamps_to_max_rate() {
        assert_eq!(parse_sim_rate_command("50000", false), Some(MAX_SIM_RATE));
        assert_eq!(parse_sim_rate_command("4294967295", false), Some(MAX_SIM_RATE));
    }

    #[test]
    fn sim_due_lines_counts_full_intervals() {
        let t0 = Instant::now();
        let interval = Duration::from_millis(10);
        // 尚未到期
        assert_eq!(sim_due_lines(t0, t0 + Duration::from_millis(5), interval, 100).0, 0);
        // now == next：到期边界立即发一行（SetRate 重置后首行马上发出）
        assert_eq!(
            sim_due_lines(t0, t0, interval, 100),
            (1, t0 + Duration::from_millis(10))
        );
        // now 恰好在某边界上：该边界也到期（>= 语义）→ 2 行
        assert_eq!(
            sim_due_lines(t0 + Duration::from_millis(10), t0, interval, 100),
            (2, t0 + Duration::from_millis(20))
        );
        // 2 个完整间隔 + 0.5 残差 → 3 行（t0/+10/+20），next 推进到 30ms
        assert_eq!(
            sim_due_lines(t0 + Duration::from_millis(25), t0, interval, 100),
            (3, t0 + Duration::from_millis(30))
        );
        // 恰好一个完整间隔（now 落在区间内）→ 1 行
        assert_eq!(
            sim_due_lines(t0 + Duration::from_millis(5), t0, interval, 100),
            (1, t0 + Duration::from_millis(10))
        );
    }

    #[test]
    fn sim_due_lines_caps_burst_and_resets_when_lagging() {
        let t0 = Instant::now();
        let interval = Duration::from_millis(1);
        // 积压远超 max → 只发 max 个，next 落后时重置到 now（防无限补发）
        let (due, next) = sim_due_lines(t0 + Duration::from_millis(50_000), t0, interval, 100);
        assert_eq!(due, 100);
        assert_eq!(next, t0 + Duration::from_millis(50_000));
    }
}
