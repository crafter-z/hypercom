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
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

use serialport::SerialPort;
use tauri::AppHandle;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};

use super::codec::{build_tx_bytes, write_all_with_deadline, TxOutcome, WRITE_TOTAL_DEADLINE};
use super::{
    emit_reconnect_hint, emit_rx_event, emit_status, emit_status_if_current, lock_error, PortInfo,
    PortKind, PortStatus, SerialManager,
};
use crate::commands::OpenPortArgs;

/// A write lease is acquired while the manager still owns the port. Closing waits for
/// every lease (including a sender waiting for the per-port write lock) to finish.
pub(super) struct CloseBarrier {
    done: Mutex<bool>,
    ready: Condvar,
}

impl CloseBarrier {
    pub(super) fn new() -> Self {
        Self {
            done: Mutex::new(false),
            ready: Condvar::new(),
        }
    }

    pub(super) fn completed(&self) -> bool {
        *self.done.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn wait(&self) {
        let mut done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        while !*done {
            done = self.ready.wait(done).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn finish(&self) {
        *self.done.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.ready.notify_all();
    }
}

struct WriterLeases {
    count: Mutex<usize>,
    empty: Condvar,
}

pub struct RealWriteHandle {
    port: Option<Arc<Mutex<Box<dyn serialport::SerialPort>>>>,
    leases: Arc<WriterLeases>,
}

impl std::ops::Deref for RealWriteHandle {
    type Target = Mutex<Box<dyn serialport::SerialPort>>;

    fn deref(&self) -> &Self::Target {
        self.port
            .as_deref()
            .expect("write lease port must remain present while borrowed")
    }
}

impl Drop for RealWriteHandle {
    fn drop(&mut self) {
        // Release the actual OS-handle reference before advertising that the
        // lease is gone. Otherwise close can observe zero leases and reopen
        // the COM port while this Arc is still alive until drop glue runs.
        drop(self.port.take());
        let mut count = self.leases.count.lock().unwrap_or_else(|e| e.into_inner());
        *count -= 1;
        if *count == 0 {
            self.leases.empty.notify_all();
        }
    }
}

/// The close operation owns both OS handles until the read thread and all TX leases
/// are finished. Call `join` only after releasing the global manager lock.
pub struct PortClose {
    read_thread: Option<thread::JoinHandle<()>>,
    write_port: Option<Arc<Mutex<Box<dyn serialport::SerialPort>>>>,
    leases: Option<Arc<WriterLeases>>,
    completion: Option<Arc<CloseBarrier>>,
    waiting: Option<Arc<CloseBarrier>>,
}

impl PortClose {
    pub(super) fn thread(read_thread: thread::JoinHandle<()>) -> Self {
        Self {
            read_thread: Some(read_thread),
            write_port: None,
            leases: None,
            completion: None,
            waiting: None,
        }
    }

    pub(super) fn waiting(barrier: Arc<CloseBarrier>) -> Self {
        Self {
            read_thread: None,
            write_port: None,
            leases: None,
            completion: None,
            waiting: Some(barrier),
        }
    }

    pub fn join(mut self) -> thread::Result<()> {
        if let Some(pending) = self.waiting.take() {
            pending.wait();
        }
        let result = match self.read_thread.take() {
            Some(thread) => thread.join(),
            None => Ok(()),
        };
        if let Some(leases) = self.leases.take() {
            let mut count = leases.count.lock().unwrap_or_else(|e| e.into_inner());
            while *count != 0 {
                count = leases.empty.wait(count).unwrap_or_else(|e| e.into_inner());
            }
        }
        // The last write handle is released only after the writers have finished.
        drop(self.write_port.take());
        if let Some(completion) = self.completion.take() {
            completion.finish();
        }
        result
    }
}

impl PortClose {
    pub(super) fn with_completion(mut self, barrier: Arc<CloseBarrier>) -> Self {
        self.completion = Some(barrier);
        self
    }
}

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
    leases: Arc<WriterLeases>,
    running: Arc<AtomicBool>,
    read_thread: Option<thread::JoinHandle<()>>,
}

impl SerialPortHandle {
    /// 请求读线程退出（应用退出时；不 join，进程退出会回收线程）。
    pub(super) fn request_stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

/// Enumerate system serial ports (blocking IO; call outside the manager lock).
pub(super) fn enumerate_system_ports() -> anyhow::Result<Vec<PortInfo>> {
    #[cfg(windows)]
    {
        return super::ports_windows::enumerate();
    }
    #[cfg(not(windows))]
    {
        Ok(serialport::available_ports()?
            .into_iter()
            .map(|p| {
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
}

/// 端口是否仍在系统端口列表中（阻塞枚举；必须在锁外调用）。
fn system_port_present(port_id: &str) -> anyhow::Result<bool> {
    Ok(serialport::available_ports()?
        .iter()
        .any(|p| p.port_name == port_id))
}

#[cfg(windows)]
fn make_handle_non_inheritable(port: &serialport::COMPort) -> anyhow::Result<()> {
    let handle = port.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    let result = unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
    if result == 0 {
        return Err(anyhow::anyhow!(
            "Failed to disable inheritance for serial port handle: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
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
        let pending = manager
            .lock()
            .map_err(lock_error)?
            .pending_real_closes
            .get(&args.port_id)
            .cloned();
        if let Some(pending) = pending {
            pending.wait();
        }
        let (live, observed_generation) = {
            let guard = manager.lock().map_err(lock_error)?;
            (
                guard
                    .ports
                    .get(&args.port_id)
                    .map(|h| h.running.load(Ordering::Acquire))
                    .unwrap_or(false),
                guard.connection_generations.get(&args.port_id).copied(),
            )
        };
        let present = system_port_present(&args.port_id)?;
        if !live || !present {
            let close = {
                let mut guard = manager.lock().map_err(lock_error)?;
                // Do not let a stale enumeration remove a newer session.
                if guard.connection_generations.get(&args.port_id).copied() != observed_generation {
                    None
                } else {
                    if live {
                        log::warn!("Port {} stale handle detected; recycling", args.port_id);
                    }
                    guard.close_port_inner(&args.port_id)?
                }
            };
            if let Some(close) = close {
                let _ = close.join();
            }
        }
    }
    // Connected status is emitted by each port opener after registration. The
    // opener uses the non-reentrant emitter because this function still owns the
    // manager lock at that point.
    loop {
        let mut guard = manager.lock().map_err(lock_error)?;
        if let Some(pending) = guard.pending_real_closes.get(&args.port_id).cloned() {
            if !pending.completed() {
                drop(guard);
                pending.wait();
                continue;
            }
            guard.pending_real_closes.remove(&args.port_id);
        }
        return guard.open_port(args.clone());
    }
}

/// 自动重连：关闭残留句柄 → 锁外 join → 锁外确认设备仍在 → 重新打开。
///
/// 与 `open_blocking` 同因：join 旧读线程与端口枚举都是阻塞操作，不能在持有
/// 全局串口锁时执行（调用方命令层因此在锁外 join 后再重新持锁打开）。
pub fn reconnect_blocking(
    manager: &Mutex<SerialManager>,
    port_id: &str,
    cancel: &AtomicBool,
) -> anyhow::Result<()> {
    reconnect_with_probe(manager, port_id, cancel, system_port_present)
}

fn reconnect_with_probe(
    manager: &Mutex<SerialManager>,
    port_id: &str,
    cancel: &AtomicBool,
    present: impl FnOnce(&str) -> anyhow::Result<bool>,
) -> anyhow::Result<()> {
    if PortKind::of(port_id) != PortKind::Real {
        return Err(anyhow::anyhow!("Cannot reconnect simulation port"));
    }

    // Check and detach atomically: a cancelled queued attempt cannot close a newer session.
    let join_handle = {
        let mut guard = manager.lock().map_err(lock_error)?;
        check_reconnect(cancel)?;
        guard.close_port_inner(port_id)?
    };
    // 阶段 2（锁外）：join 确保旧 COM 句柄已释放，否则 open 会因端口被旧线程占用而失败
    if let Some(thread) = join_handle {
        let _ = thread.join();
    }
    // 阶段 3（锁外）：确认端口重新出现在系统列表中（阻塞枚举）
    if !present(port_id)? {
        return Err(anyhow::anyhow!("Port {} is not available", port_id));
    }
    let mut guard = manager.lock().map_err(lock_error)?;
    check_reconnect(cancel)?;
    let params = guard
        .get_last_params(port_id)
        .ok_or_else(|| anyhow::anyhow!("No previous connection params for {}", port_id))?;
    guard.open_port(params)
}

fn check_reconnect(cancel: &AtomicBool) -> anyhow::Result<()> {
    if cancel.load(Ordering::Relaxed) {
        anyhow::bail!("Reconnect cancelled by a newer port operation");
    }
    Ok(())
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

    // Any residual handle (even one whose reader exited) must be closed and joined
    // through `open_blocking`, not dropped while the manager lock is held.
    if manager.ports.contains_key(&args.port_id) {
        return Err(anyhow::anyhow!("Port {} is already open", args.port_id));
    }

    let builder = serialport::new(&args.port_id, args.baud_rate)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .flow_control(flow_control)
        .timeout(Duration::from_millis(100));
    #[cfg(windows)]
    let mut port = builder.open_native()?;
    #[cfg(not(windows))]
    let mut port = builder.open()?;

    // The serialport Windows backend duplicates the write handle with
    // bInheritHandle=TRUE. Clear inheritance on both handles before any tool
    // process can be spawned; otherwise a sibling tool can keep this COM port
    // exclusively owned after HyperCom closes its own references.
    #[cfg(windows)]
    make_handle_non_inheritable(&port)?;

    // 设置 DTR/RTS：两个句柄共享设备级状态，只设置一次即可。
    port.write_data_terminal_ready(args.dtr)?;
    port.write_request_to_send(args.rts)?;

    // 原句柄作为读句柄，clone 出的作为写句柄（见 SerialPortHandle 文档）。
    #[cfg(windows)]
    let write_port = {
        let cloned = port.try_clone_native()?;
        make_handle_non_inheritable(&cloned)?;
        Box::new(cloned) as Box<dyn serialport::SerialPort>
    };
    #[cfg(not(windows))]
    let write_port = port.try_clone()?;
    #[cfg(windows)]
    let read_port = Box::new(port) as Box<dyn serialport::SerialPort>;
    #[cfg(not(windows))]
    let read_port = port;

    let read_port_arc = Arc::new(Mutex::new(read_port));
    let write_port_arc = Arc::new(Mutex::new(write_port));
    let leases = Arc::new(WriterLeases {
        count: Mutex::new(0),
        empty: Condvar::new(),
    });
    let running = Arc::new(AtomicBool::new(true));
    let ready = Arc::new(AtomicBool::new(false));
    let generation = manager
        .connection_generations
        .get(&args.port_id)
        .copied()
        .unwrap_or_default();
    let thread_port_id = args.port_id.clone();
    let read_thread = thread::spawn({
        let read_port = Arc::clone(&read_port_arc);
        let running = Arc::clone(&running);
        let ready = Arc::clone(&ready);
        let app_handle = app_handle.clone();
        move || {
            read_loop(
                thread_port_id,
                read_port,
                running,
                ready,
                generation,
                app_handle,
            )
        }
    });
    let port_id = args.port_id.clone();
    manager.ports.insert(
        args.port_id.clone(),
        SerialPortHandle {
            read_port: read_port_arc,
            write_port: write_port_arc,
            leases,
            running,
            read_thread: Some(read_thread),
        },
    );
    manager
        .last_params
        .insert(args.port_id.clone(), args.clone());
    emit_status(&app_handle, &args.port_id, PortStatus::Connected, Some(generation));
    ready.store(true, Ordering::Release);
    log::info!("Serial port opened: {}", port_id);
    Ok(())
}

/// 关闭真实串口：读线程和写句柄的所有借用都由锁外 `join()` 等待并释放。
pub(super) fn close(manager: &mut SerialManager, port_id: &str) -> Option<PortClose> {
    let mut handle = manager.ports.remove(port_id)?;
    handle.request_stop();
    log::info!("Serial port closed: {}", port_id);
    Some(PortClose {
        read_thread: handle.read_thread.take(),
        write_port: Some(handle.write_port),
        leases: Some(handle.leases),
        completion: None,
        waiting: None,
    })
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
pub(super) fn write_raw(
    manager: &SerialManager,
    port_id: &str,
    bytes: &[u8],
) -> anyhow::Result<usize> {
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
) -> anyhow::Result<RealWriteHandle> {
    let handle = manager
        .ports
        .get(port_id)
        .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
    let mut count = handle.leases.count.lock().map_err(lock_error)?;
    *count += 1;
    Ok(RealWriteHandle {
        port: Some(Arc::clone(&handle.write_port)),
        leases: Arc::clone(&handle.leases),
    })
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
        // DCB/COMMTIMEOUTS 是设备级状态、两个句柄共享。先拿写句柄（可能等一次
        // 在途 TX，最多 ~2s），再拿读句柄（读线程单次 read 最长 ~100ms）——
        // 顺序不能反：先持读锁等写锁会把 RX 一起停住整个等待期。
        let mut port = handle
            .write_port
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        let _read_guard = handle
            .read_port
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
    // Write lock first: waiting for an in-flight TX must not park the reader.
    let mut port = handle
        .write_port
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    let _read_guard = handle
        .read_port
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
    ready: Arc<AtomicBool>,
    generation: u64,
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
    while running.load(Ordering::Acquire) && !ready.load(Ordering::Acquire) {
        thread::yield_now();
    }
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
            // Stop may have been signalled while read() was blocked; bytes read
            // from a session being retired must not leak into the log/UI.
            ReadOutcome::Data(n) if n > 0 && running.load(Ordering::Acquire) => {
                emit_rx_event(&app_handle, &port_id, &buffer[..n])
            }
            ReadOutcome::Data(_) | ReadOutcome::Timeout => {}
            ReadOutcome::Error(e) => {
                log::warn!("Serial read error on {}: {}", port_id, e);
                emit_status_if_current(&app_handle, &port_id, PortStatus::Error, generation);
                abnormal = true;
                break;
            }
        }
    }
    running.store(false, Ordering::Relaxed);

    // 读取线程退出时发送断开事件
    emit_status_if_current(&app_handle, &port_id, PortStatus::Disconnected, generation);
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
    fn close_during_reconnect_probe_prevents_reopening() {
        let manager = std::sync::Mutex::new(super::SerialManager::new());
        let token = manager.lock().unwrap().begin_reconnect("COM3");
        let result = super::reconnect_with_probe(&manager, "COM3", &token, |_| {
            // The real command can close while the blocking system enumeration runs.
            manager.lock().unwrap().close_port("COM3")?;
            Ok(true)
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Reconnect cancelled"));
        // Without the final intent check this reaches the missing-param/open path.
        assert!(manager.lock().unwrap().ports.is_empty());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn superseded_reconnect_never_recycles_or_probes() {
        let manager = std::sync::Mutex::new(super::SerialManager::new());
        let old = manager.lock().unwrap().begin_reconnect("COM3");
        let current = manager.lock().unwrap().begin_reconnect("COM3");
        let result = super::reconnect_with_probe(&manager, "COM3", &old, |_| {
            panic!("cancelled queued reconnect must not enumerate devices")
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Reconnect cancelled"));
        manager.lock().unwrap().finish_reconnect("COM3", &old);
        assert!(!current.load(std::sync::atomic::Ordering::Relaxed));
        manager.lock().unwrap().close_port("COM3").unwrap();
        assert!(current.load(std::sync::atomic::Ordering::Relaxed));
    }
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn parse_data_bits_accepts_supported_widths_only() {
        assert!(matches!(parse_data_bits(5), Ok(serialport::DataBits::Five)));
        assert!(matches!(parse_data_bits(6), Ok(serialport::DataBits::Six)));
        assert!(matches!(
            parse_data_bits(7),
            Ok(serialport::DataBits::Seven)
        ));
        assert!(matches!(
            parse_data_bits(8),
            Ok(serialport::DataBits::Eight)
        ));
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
        assert!(matches!(
            parse_stop_bits("One"),
            Ok(serialport::StopBits::One)
        ));
        assert!(matches!(
            parse_stop_bits("Two"),
            Ok(serialport::StopBits::Two)
        ));
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
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn duplicate_close_waits_for_first_completion() {
        let completion = std::sync::Arc::new(super::CloseBarrier::new());
        let duplicate = super::PortClose::waiting(std::sync::Arc::clone(&completion));
        let (ready, rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            duplicate.join().unwrap();
            ready.send(()).unwrap();
        });
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(20))
            .is_err());
        completion.finish();
        rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        thread.join().unwrap();
    }
}
