/**
 * 真实串口 (Real Ports)
 * `serialport::SerialPort` 的打开/关闭/参数设置/收发，以及真实端口专有的
 * 帧格式映射与热插拔幽灵句柄回收。
 *
 * 本模块的测试引用 serialport 类型，因此只在非 Windows 运行：Windows 上
 * `cargo test` 的 harness 没有应用清单，测试二进制链接到 serialport FFI 的
 * 入口点会以 0xc0000139（STATUS_ENTRYPOINT_NOT_FOUND）加载失败。
 */
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

use super::codec::{build_tx_bytes, write_all_with_deadline, TxOutcome, WRITE_TOTAL_DEADLINE};
use super::{emit_reconnect_hint, emit_rx_event, emit_status, lock_error, PortInfo, PortKind, PortStatus, SerialManager};
use crate::commands::OpenPortArgs;

/// 单个真实串口连接句柄。
///
/// 读写句柄经 `try_clone()` 拆分（Windows 上 = `DuplicateHandle`），读线程独占
/// `read_port`、发送路径独占 `write_port`。拆分前读线程与 TX 写路径共享同一把
/// per-port `Mutex<Box<dyn SerialPort>>`：TX 的 write_all 阻塞期间端口锁被 TX
/// 独占，RX 读线程被饿死——设备响应早已到达 OS 接收缓冲区，却直到 TX 释放锁才
/// 被读出来（"TX 后等一分钟才收到响应"的根因）。拆分后 TX 再阻塞也影响不到 RX。
///
/// 注意：不能对同一 COM 口二次 `CreateFile`（serialport crate 以
/// `dwShareMode=0` 打开），`try_clone()` 是唯一拆分途径；DCB/COMMTIMEOUTS
/// 是设备级状态、两个句柄共享，改参（set_params/set_flow_control）只在
/// 写句柄上进行。
pub(super) struct SerialPortHandle {
    /// 读句柄：读线程独占（只锁读）
    read_port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    /// 写句柄：发送路径独占（只锁写）
    write_port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    running: Arc<AtomicBool>,
    read_thread: Option<thread::JoinHandle<()>>,
}

impl SerialPortHandle {
    /// 请求读线程退出（应用退出时；不 join，进程退出会回收线程）。
    pub(super) fn request_stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

/// 枚举系统串口（阻塞 IO：必须在**锁外**调用，见 `list_ports_blocking` 的说明）。
pub(super) fn enumerate_system_ports() -> anyhow::Result<Vec<PortInfo>> {
    Ok(serialport::available_ports()?
        .into_iter()
        .map(|p| {
            // USB 口从 UsbPortInfo 提取厂商/产品名；PCI/蓝牙/未知类型无此信息。
            let (manufacturer, product) = match p.port_type {
                serialport::SerialPortType::UsbPort(info) => (info.manufacturer, info.product),
                _ => (None, None),
            };
            PortInfo {
                id: p.port_name.clone(),
                name: p.port_name,
                port_type: "real".to_string(),
                manufacturer,
                product,
            }
        })
        .collect())
}

/// 端口是否仍在系统端口列表中（阻塞枚举；必须在锁外调用）。
fn system_port_present(port_id: &str) -> anyhow::Result<bool> {
    Ok(serialport::available_ports()?
        .iter()
        .any(|p| p.port_name == port_id))
}

/// 打开端口的完整流程（含真实串口的热插拔幽灵句柄回收），自持/自放全局串口锁。
///
/// 为什么锁内不做探测与 join：判定幽灵句柄要枚举系统端口、回收幽灵句柄要 join
/// 旧读线程（读线程最长 ~100ms 才退出），两者都是阻塞操作；持有全局串口锁执行
/// 会卡住端口轮询与其它端口的发送/关闭命令。因此这里把「锁内注册表操作」与
/// 「锁外阻塞 IO」分成三段，锁内只做内存查询。
///
/// 阻塞点：端口枚举、一次 open 系统调用、可能的读线程 join——必须从阻塞线程池
/// 调用，不得在异步运行时线程或事件循环主线程上直接调用。
pub fn open_blocking(manager: &Mutex<SerialManager>, args: OpenPortArgs) -> anyhow::Result<()> {
    if PortKind::of(&args.port_id) == PortKind::Real {
        let live = manager
            .lock()
            .map_err(lock_error)?
            .ports
            .get(&args.port_id)
            .map(|h| h.running.load(Ordering::Relaxed))
            .unwrap_or(false);
        // 存活句柄 + 设备已从系统枚举消失 = USB 拔出留下的幽灵句柄：读线程可能因
        // 空闲而永不报错（read 一直 timeout），running 停在 true，继续报
        // "already open" 会让用户重插后永远开不了（只能重启应用）。
        if live && !system_port_present(&args.port_id)? {
            log::warn!(
                "Port {} stale handle detected (device vanished from enumeration); recycling",
                args.port_id
            );
            let stale = manager
                .lock()
                .map_err(lock_error)?
                .ports
                .remove(&args.port_id);
            if let Some(mut handle) = stale {
                handle.request_stop();
                // 必须在重新 open 之前 join：旧读线程持有的 COM 句柄要等它退出并
                // 释放 Arc 后才归还系统，否则紧接的 open 会撞 "access denied"
                // （串口以 dwShareMode=0 打开，同一 COM 不能二次打开）。线程受
                // read 超时（≤100ms）上界约束，且仅在这条罕见的热插拔路径发生。
                if let Some(t) = handle.read_thread.take() {
                    let _ = t.join();
                }
            }
        }
    }
    manager.lock().map_err(lock_error)?.open_port(args)
}

/// 自动重连：关闭残留句柄 → 锁外 join → 锁外确认设备仍在 → 重新打开。
///
/// 与 `open_blocking` 同因：join 旧读线程与端口枚举都是阻塞操作，不能在持有
/// 全局串口锁时执行（调用方命令层因此在锁外 join 后再重新持锁打开）。
pub fn reconnect_blocking(manager: &Mutex<SerialManager>, port_id: &str) -> anyhow::Result<()> {
    if PortKind::of(port_id) != PortKind::Real {
        return Err(anyhow::anyhow!("Cannot reconnect simulation port"));
    }

    // 阶段 1（锁内、仅内存）：摘除残留句柄并取出读线程
    let join_handle = manager
        .lock()
        .map_err(lock_error)?
        .close_port(port_id)?;
    // 阶段 2（锁外）：join 确保旧 COM 句柄已释放，否则 open 会因端口被旧线程占用而失败
    if let Some(thread) = join_handle {
        let _ = thread.join();
    }
    // 阶段 3（锁外）：确认端口重新出现在系统列表中（阻塞枚举）
    if !system_port_present(port_id)? {
        return Err(anyhow::anyhow!("Port {} is not available", port_id));
    }
    // 阶段 4（锁内）：以上次成功的参数打开（此时必无残留句柄）
    let mut guard = manager.lock().map_err(lock_error)?;
    let params = guard
        .get_last_params(port_id)
        .ok_or_else(|| anyhow::anyhow!("No previous connection params for {}", port_id))?;
    guard.open_port(params)
}

/// 打开真实串口（锁内、不枚举端口、不 join 读线程）。
///
/// 幽灵句柄的探测与回收由 `open_blocking` 在锁外完成；走到这里时同端口不应存在
/// 存活句柄。
pub(super) fn open(manager: &mut SerialManager, args: OpenPortArgs) -> anyhow::Result<()> {
    let app_handle = manager
        .app_handle
        .clone()
        .ok_or_else(|| anyhow::anyhow!("AppHandle not initialized"))?;

    // 帧格式/流控**先解析**：未知取值必须在这里报错，不能回落到默认值——
    // serialport 只有 None/Odd/Even 校验与 One/Two 停止位，把 Mark/Space 静默
    // 当 None、1.5 停止位静默当 1 会配置出与用户选择不符的帧格式且毫无提示。
    // 解析发生在 open() 之前，非法值不会碰到设备。
    let data_bits = parse_data_bits(args.data_bits)?;
    let parity = parse_parity(&args.parity)?;
    let stop_bits = parse_stop_bits(&args.stop_bits)?;
    let flow_control = parse_flow_control(&args.handshake)?;

    // 同端口残留句柄：存活句柄意味着 COM 口仍被本进程占用（二次 CreateFile 必
    // 失败），报错而不是覆盖——覆盖会让旧读线程游离在外继续持有句柄。已死线程的
    // 句柄直接摘除，避免 insert 覆盖后泄漏读线程。
    if let Some(handle) = manager.ports.get(&args.port_id) {
        if handle.running.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("Port {} is already open", args.port_id));
        }
        manager.ports.remove(&args.port_id);
    }

    let mut port = serialport::new(&args.port_id, args.baud_rate)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .flow_control(flow_control)
        .timeout(Duration::from_millis(100))
        .open()?;

    // 设置 DTR/RTS：必须在 try_clone 之前、在 Arc<Mutex> 包装之前设置
    // （open() 返回的是 Box<dyn SerialPort>，需可变引用）。DTR/RTS 是设备级状态、
    // 两个句柄共享，设一次即可。
    port.write_data_terminal_ready(args.dtr)?;
    port.write_request_to_send(args.rts)?;

    // 原句柄作为读句柄，clone 出的作为写句柄（见 SerialPortHandle 文档）。
    let write_port = port.try_clone()?;
    let read_port = port;

    let read_port_arc = Arc::new(Mutex::new(read_port));
    let write_port_arc = Arc::new(Mutex::new(write_port));
    let running = Arc::new(AtomicBool::new(true));

    let thread_port_id = args.port_id.clone();
    let read_thread = thread::spawn({
        let read_port = Arc::clone(&read_port_arc);
        let running = Arc::clone(&running);
        let app_handle = app_handle.clone();
        move || read_loop(thread_port_id, read_port, running, app_handle)
    });

    // 记录连接参数，用于自动重连
    manager.last_params.insert(args.port_id.clone(), args.clone());

    emit_status(&app_handle, &args.port_id, PortStatus::Connected);

    let port_id = args.port_id.clone();
    manager.ports.insert(
        args.port_id,
        SerialPortHandle {
            read_port: read_port_arc,
            write_port: write_port_arc,
            running,
            read_thread: Some(read_thread),
        },
    );
    log::info!("Serial port opened: {}", port_id);
    Ok(())
}

/// 关闭真实串口：停止读线程并返回其 JoinHandle，由调用方在释放全局锁之后 join。
pub(super) fn close(manager: &mut SerialManager, port_id: &str) -> Option<thread::JoinHandle<()>> {
    let mut handle = manager.ports.remove(port_id)?;
    handle.request_stop();
    log::info!("Serial port closed: {}", port_id);
    handle.read_thread.take()
}

/// 向真实串口发送数据：只锁写句柄，写入带总期限，日志与返回字节数取自
/// `TxOutcome`（实际写入的字节）。
pub(super) fn send(
    manager: &SerialManager,
    port_id: &str,
    data: &str,
    is_hex: bool,
    append_line_ending: &str,
) -> anyhow::Result<TxOutcome> {
    let handle = manager
        .ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
    let bytes = build_tx_bytes(data, is_hex, append_line_ending)?;
    let mut port = handle
        .write_port
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    write_all_with_deadline(port_id, &mut **port, &bytes, WRITE_TOTAL_DEADLINE)?;
    log::debug!("Sent {} bytes to {}", bytes.len(), port_id);
    Ok(TxOutcome::sent(bytes))
}

/// 向真实串口写入原始字节（不做 HEX 解析、不附加行结束符）。用于文件发送。
pub(super) fn write_raw(manager: &SerialManager, port_id: &str, bytes: &[u8]) -> anyhow::Result<usize> {
    let handle = manager
        .ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
    let mut port = handle
        .write_port
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    write_all_with_deadline(port_id, &mut **port, bytes, WRITE_TOTAL_DEADLINE)?;
    Ok(bytes.len())
}

/// 取写句柄克隆（两段式发送的第一段）：必须在持有全局串口锁时调用，返回后调用方
/// 应立即释放全局锁，再只持 per-port 写锁完成写入——写串口不占用全局锁，端口列表
/// 轮询与其它端口命令不被慢发送拖死。
pub(super) fn write_handle(
    manager: &SerialManager,
    port_id: &str,
) -> anyhow::Result<Arc<Mutex<Box<dyn serialport::SerialPort>>>> {
    manager
        .ports
        .get(port_id)
        .map(|h| Arc::clone(&h.write_port))
        .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))
}

/// 修改串口参数（完整）。
pub(super) fn set_params(
    manager: &mut SerialManager,
    port_id: &str,
    baud_rate: u32,
    data_bits: u8,
    parity: &str,
    stop_bits: &str,
    handshake: &str,
) -> anyhow::Result<()> {
    // 先解析全部参数：非法值必须在触碰设备之前报错——否则波特率已生效、校验位才
    // 失败，设备会停在半套参数上。
    let data_bits_value = parse_data_bits(data_bits)?;
    let parity_value = parse_parity(parity)?;
    let stop_bits_value = parse_stop_bits(stop_bits)?;
    let flow_control_value = parse_flow_control(handshake)?;

    {
        let handle = manager
            .ports
            .get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
        // DCB/COMMTIMEOUTS 是设备级状态、两个句柄共享。改参是设备级操作：同时锁住
        // 读写句柄，避免改参瞬间另一句柄正在 I/O（读线程单次 read 最长 ~100ms，
        // 此锁最长阻塞 ~100ms，可接受）；参数只在写句柄上应用（读句柄从不调用
        // set_*，其缓存的陈旧设置不会推给驱动）。
        let _read_guard = handle
            .read_port
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        let mut port = handle
            .write_port
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        port.set_baud_rate(baud_rate)?;
        // 无条件应用帧格式与流控：仅在非默认值时才设置会导致无法从
        // 7E1 / 硬件流控等配置改回 8N1 / None 默认值。
        port.set_data_bits(data_bits_value)?;
        port.set_parity(parity_value)?;
        port.set_stop_bits(stop_bits_value)?;
        port.set_flow_control(flow_control_value)?;
    }

    // 同步更新重连参数缓存
    if let Some(params) = manager.last_params.get_mut(port_id) {
        params.baud_rate = baud_rate;
        params.data_bits = data_bits;
        params.parity = parity.to_string();
        params.stop_bits = stop_bits.to_string();
        params.handshake = handshake.to_string();
    }

    log::info!(
        "Params set for {}: baud={}, data_bits={}, parity={}, stop_bits={}, handshake={}",
        port_id,
        baud_rate,
        data_bits,
        parity,
        stop_bits,
        handshake
    );
    Ok(())
}

/// 设置流控（DTR/RTS）：两句柄都是设备级状态，同时锁读写句柄避免改参瞬间另一
/// 句柄正在 I/O；DTR/RTS 在写句柄上应用。
pub(super) fn set_flow_control(
    manager: &SerialManager,
    port_id: &str,
    dtr: bool,
    rts: bool,
) -> anyhow::Result<()> {
    let handle = manager
        .ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
    let _read_guard = handle
        .read_port
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    let mut port = handle
        .write_port
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    port.write_data_terminal_ready(dtr)?;
    port.write_request_to_send(rts)?;
    Ok(())
}

/// 读线程主体：独占读句柄，读到的字节派发为 RX 事件，退出时派发状态与重连提示。
fn read_loop(
    port_id: String,
    read_port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    running: Arc<AtomicBool>,
    app_handle: AppHandle,
) {
    // 单次读取的结果分类：把「读到数据」/「读超时」/「真实错误」分离，以便在
    // 释放端口锁之后再派发事件。
    enum ReadOutcome {
        Data(usize),
        Timeout,
        Error(std::io::Error),
    }

    let mut buffer = [0u8; 1024];
    let mut abnormal = false;

    while running.load(Ordering::Relaxed) {
        // 仅在 read() 调用期间持有端口锁，读完立即释放。emit_rx_event 会派发 Tauri
        // 事件并同步写日志落盘，不能在持锁期间执行，否则会阻塞发送与改参，高波特率
        // 下还可能撑爆 OS 接收缓冲区。
        let outcome = match read_port.lock() {
            Ok(mut p) => match p.read(&mut buffer) {
                Ok(n) => ReadOutcome::Data(n),
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => ReadOutcome::Timeout,
                Err(e) => ReadOutcome::Error(e),
            },
            Err(e) => {
                log::error!("Serial port lock error: {}", e);
                abnormal = true;
                break;
            }
        };
        // 端口 MutexGuard 在此处已释放

        match outcome {
            ReadOutcome::Data(n) if n > 0 => emit_rx_event(&app_handle, &port_id, &buffer[..n]),
            ReadOutcome::Data(_) | ReadOutcome::Timeout => {}
            ReadOutcome::Error(e) => {
                log::warn!("Serial read error on {}: {}", port_id, e);
                emit_status(&app_handle, &port_id, PortStatus::Error);
                abnormal = true;
                break;
            }
        }
    }

    // 读取线程退出时发送断开事件
    emit_status(&app_handle, &port_id, PortStatus::Disconnected);
    // 异常退出时发送一次重连提示，避免每次轮询都产生噪音
    if abnormal {
        log::warn!(
            "Serial port {} read thread exited abnormally (unplanned disconnect)",
            port_id
        );
        emit_reconnect_hint(&app_handle, &port_id);
    }
}

// ==================== 帧格式 / 流控映射 ====================
//
// 未知取值一律报错。前端 UI 目前还提供 serialport 无法表达的选项（校验位的
// Mark/Space、停止位的 1.5），这些取值会在这里被明确拒绝，而不是静默降级成
// 另一种帧格式——静默降级会让「设置显示 8E2、实际 8N1」这类问题无法被用户发现。
//
// 本表同时是配置加载期归一化的集合来源：`config::normalize_legacy_serial_enums`
// 的回退集合必须与这里的接受集合**逐项相等**（它把旧 config.json 里已被本模块拒绝
// 的取值改成默认值）。新增取值时两处一起改。

fn parse_data_bits(bits: u8) -> anyhow::Result<serialport::DataBits> {
    match bits {
        5 => Ok(serialport::DataBits::Five),
        6 => Ok(serialport::DataBits::Six),
        7 => Ok(serialport::DataBits::Seven),
        8 => Ok(serialport::DataBits::Eight),
        other => Err(anyhow::anyhow!(
            "Unsupported data bits: {} (expected 5, 6, 7 or 8)",
            other
        )),
    }
}

fn parse_parity(parity: &str) -> anyhow::Result<serialport::Parity> {
    match parity {
        "None" => Ok(serialport::Parity::None),
        "Even" => Ok(serialport::Parity::Even),
        "Odd" => Ok(serialport::Parity::Odd),
        other => Err(anyhow::anyhow!(
            "Unsupported parity: {} (expected None, Even or Odd)",
            other
        )),
    }
}

fn parse_stop_bits(bits: &str) -> anyhow::Result<serialport::StopBits> {
    match bits {
        "One" => Ok(serialport::StopBits::One),
        "Two" => Ok(serialport::StopBits::Two),
        other => Err(anyhow::anyhow!(
            "Unsupported stop bits: {} (expected One or Two)",
            other
        )),
    }
}

fn parse_flow_control(flow: &str) -> anyhow::Result<serialport::FlowControl> {
    match flow {
        "None" => Ok(serialport::FlowControl::None),
        "XonXoff" => Ok(serialport::FlowControl::Software),
        "RequestToSend" | "RequestToSendXonXoff" => Ok(serialport::FlowControl::Hardware),
        other => Err(anyhow::anyhow!(
            "Unsupported flow control: {} (expected None, XonXoff, RequestToSend or RequestToSendXonXoff)",
            other
        )),
    }
}

#[cfg(test)]
mod tests {
    // 显式导入而非 `use super::*`：见模块头注释（Windows 测试二进制不能链接
    // serialport FFI）。这些断言引用 serialport 枚举类型，故仅在非 Windows 运行；
    // CI（Linux/macOS）覆盖。
    #[cfg(not(target_os = "windows"))]
    use super::{parse_data_bits, parse_flow_control, parse_parity, parse_stop_bits};

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn parse_data_bits_accepts_supported_widths_only() {
        assert!(matches!(parse_data_bits(5), Ok(serialport::DataBits::Five)));
        assert!(matches!(parse_data_bits(6), Ok(serialport::DataBits::Six)));
        assert!(matches!(parse_data_bits(7), Ok(serialport::DataBits::Seven)));
        assert!(matches!(parse_data_bits(8), Ok(serialport::DataBits::Eight)));
        assert!(parse_data_bits(9).is_err());
        assert!(parse_data_bits(0).is_err());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn parse_parity_accepts_serialport_values_only() {
        assert!(matches!(parse_parity("None"), Ok(serialport::Parity::None)));
        assert!(matches!(parse_parity("Even"), Ok(serialport::Parity::Even)));
        assert!(matches!(parse_parity("Odd"), Ok(serialport::Parity::Odd)));
        // UI 里存在但 serialport 无法表达的取值绝不能静默降级成 None
        assert!(parse_parity("Mark").is_err());
        assert!(parse_parity("Space").is_err());
        assert!(parse_parity("bogus").is_err());
        assert!(parse_parity("none").is_err());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn parse_stop_bits_accepts_serialport_values_only() {
        assert!(matches!(parse_stop_bits("One"), Ok(serialport::StopBits::One)));
        assert!(matches!(parse_stop_bits("Two"), Ok(serialport::StopBits::Two)));
        // UI 里存在但 serialport 无法表达的 1.5 停止位不能静默降级成 One
        assert!(parse_stop_bits("OnePointFive").is_err());
        assert!(parse_stop_bits("bogus").is_err());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn parse_flow_control_maps_all_supported_values() {
        assert!(matches!(
            parse_flow_control("None"),
            Ok(serialport::FlowControl::None)
        ));
        assert!(matches!(
            parse_flow_control("XonXoff"),
            Ok(serialport::FlowControl::Software)
        ));
        assert!(matches!(
            parse_flow_control("RequestToSend"),
            Ok(serialport::FlowControl::Hardware)
        ));
        assert!(matches!(
            parse_flow_control("RequestToSendXonXoff"),
            Ok(serialport::FlowControl::Hardware)
        ));
        assert!(parse_flow_control("bogus").is_err());
    }
}
