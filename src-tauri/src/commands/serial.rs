use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

/// Shared admission/drain state for serial file and tool operations.
/// Shutdown flips the gate once, then waits for the active count to reach zero.
pub struct SerialWorkState {
    pub(crate) shutting_down: AtomicBool,
    pub(crate) active: AtomicUsize,
    pub(crate) drained: Notify,
}

impl SerialWorkState {
    pub fn new() -> Self {
        Self {
            shutting_down: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            drained: Notify::new(),
        }
    }

    fn admit(self: &Arc<Self>) -> Option<SerialWorkGuard> {
        if self.shutting_down.load(Ordering::Acquire) {
            return None;
        }
        self.active.fetch_add(1, Ordering::AcqRel);
        if self.shutting_down.load(Ordering::Acquire) {
            self.active.fetch_sub(1, Ordering::AcqRel);
            self.drained.notify_one();
            return None;
        }
        Some(SerialWorkGuard {
            state: Arc::clone(self),
        })
    }

    fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        // `notify_one` stores a permit when no waiter is registered yet; the
        // shutdown loop can then observe it after checking `active`.
        self.drained.notify_one();
    }
}

pub struct SerialWorkGuard {
    state: Arc<SerialWorkState>,
}

impl Drop for SerialWorkGuard {
    fn drop(&mut self) {
        if self.state.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.state.drained.notify_one();
        }
    }
}

use serde::Deserialize;

/// Owner-aware file transfer cancellation entry. The transfer UUID prevents a
/// delayed cancel from affecting a later transfer on the same port.
pub struct FileSendRegistration {
    pub transfer_id: String,
    pub cancel: Arc<AtomicBool>,
}

struct FileSendGuard<'a> {
    sends: &'a std::sync::Mutex<std::collections::HashMap<String, FileSendRegistration>>,
    port_id: String,
    transfer_id: String,
    cancel: Arc<AtomicBool>,
}

impl Drop for FileSendGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut sends) = self.sends.lock() {
            if sends.get(&self.port_id).is_some_and(|entry| {
                entry.transfer_id == self.transfer_id && Arc::ptr_eq(&entry.cancel, &self.cancel)
            }) {
                sends.remove(&self.port_id);
            }
        }
    }
}

use tauri::{AppHandle, Emitter, State};

/// Removes a tool reservation on every exit path (including the early `?`
/// returns between insertion and the final cleanup). Previously those paths
/// left the port permanently marked as "Tool already running".
struct ToolReservation<'a> {
    reservations: &'a std::sync::Mutex<std::collections::HashMap<String, String>>,
    port_id: String,
    owner: String,
}

impl Drop for ToolReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut reservations) = self.reservations.lock() {
            if reservations
                .get(&self.port_id)
                .is_some_and(|current| current == &self.owner)
            {
                reservations.remove(&self.port_id);
            }
        }
    }
}

use super::CommandError;
use crate::{serial, AppState};

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};

/// Fill one bounded transfer chunk. The opened-file length is the transfer
/// boundary: a shrink/growth is reported, never sent beyond the declared total.
async fn read_file_send_chunk(
    reader: &mut (impl AsyncRead + Unpin),
    buffer: &mut [u8],
    remaining: usize,
) -> std::io::Result<usize> {
    if remaining == 0 {
        let mut extra = [0u8; 1];
        return if reader.read(&mut extra).await? == 0 {
            Ok(0)
        } else {
            Err(std::io::Error::other("File changed during file send"))
        };
    }
    let len = buffer.len().min(remaining);
    if len == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Empty file-send buffer",
        ));
    }
    reader.read_exact(&mut buffer[..len]).await?;
    if len == remaining {
        // Verify the boundary before sending the final chunk: a detected growth
        // must not publish a misleading full-size successful terminal progress.
        let mut extra = [0u8; 1];
        if reader.read(&mut extra).await? != 0 {
            return Err(std::io::Error::other("File changed during file send"));
        }
    }
    Ok(len)
}

/// A channel entry is bounded by bytes, not merely by number of lines: tools
/// may print arbitrarily long progress/binary output without any newline.
const TOOL_OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
/// Cancellation polling interval for inter-chunk file-send delays. A raw
/// `sleep(delay_ms)` would make shutdown wait an unbounded user-provided delay.
const FILE_SEND_DELAY_SLICE_MS: u64 = 50;

async fn wait_file_send_delay(cancel: &AtomicBool, delay_ms: u64) {
    let mut remaining = delay_ms;
    while remaining > 0 {
        if cancel.load(Ordering::Acquire) {
            return;
        }
        let slice = remaining.min(FILE_SEND_DELAY_SLICE_MS);
        tokio::time::sleep(std::time::Duration::from_millis(slice)).await;
        remaining -= slice;
    }
}

fn tool_output_split(bytes: &[u8]) -> usize {
    // Keep a possible UTF-8 suffix (at most three bytes) for the next event,
    // even when earlier bytes were malformed. Keep CR for a following LF too.
    if bytes.last() == Some(&b'\r') {
        return bytes.len() - 1;
    }
    let start = bytes.len().saturating_sub(4);
    if let Some(offset) = bytes[start..].iter().rposition(|byte| byte & 0xc0 != 0x80) {
        let tail = start + offset;
        if std::str::from_utf8(&bytes[tail..])
            .err()
            .is_some_and(|error| error.error_len().is_none())
        {
            return tail;
        }
    }
    bytes.len()
}

async fn stream_tool_output(
    mut reader: impl AsyncBufRead + Unpin,
    stream: &'static str,
    tx: tokio::sync::mpsc::Sender<(&'static str, String)>,
) {
    let mut pending = Vec::with_capacity(TOOL_OUTPUT_CHUNK_BYTES);
    let mut split_line = false;
    while let Ok(available) = reader.fill_buf().await {
        let eof = available.is_empty();
        if !eof {
            let available_len = available
                .iter()
                .position(|&byte| byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            let len = available_len.min(TOOL_OUTPUT_CHUNK_BYTES - pending.len());
            pending.extend_from_slice(&available[..len]);
            reader.consume(len);
        }
        let complete = eof || pending.last() == Some(&b'\n');
        if complete {
            let decoded = String::from_utf8_lossy(&pending);
            let line = decoded.trim_end_matches(['\n', '\r']);
            // A delimiter immediately after an emitted chunk only ends that
            // line; it must not introduce a phantom extra empty output event.
            if (!eof || !pending.is_empty())
                && (!split_line || !line.is_empty())
                && tx.send((stream, line.to_string())).await.is_err()
            {
                break;
            }
            pending.clear();
            split_line = false;
            if eof {
                break;
            }
        } else if pending.len() == TOOL_OUTPUT_CHUNK_BYTES {
            let split = tool_output_split(&pending);
            let line = String::from_utf8_lossy(&pending[..split]).into_owned();
            if tx.send((stream, line)).await.is_err() {
                break;
            }
            pending.copy_within(split.., 0);
            pending.truncate(pending.len() - split);
            split_line = true;
        }
    }
}

/// 获取系统可用串口列表
/// 前端调用: invoke('list_available_ports')
///
/// 同步命令在事件循环主线程执行——内部 `serialport::available_ports()` 是阻塞式
/// 串口枚举，前端每 3s 轮询一次，高频数据会话下周期性阻塞主线程会拖慢 RX 分发
/// 与重绘（TTY 卡顿根因 #1）。改 async + spawn_blocking：克隆 Arc 句柄，枚举挪到
/// 独立线程池，主线程立即返回。`list_ports_blocking` 自身把枚举放在全局串口锁
/// **之外**执行，轮询也不会阻塞发送/关闭命令。行为（返回结构/字段/调用频率）不变。
#[tauri::command]
pub async fn list_available_ports(
    state: State<'_, AppState>,
) -> Result<Vec<serial::PortInfo>, CommandError> {
    let serial_manager = state.serial_manager.clone();
    tokio::task::spawn_blocking(move || {
        serial::list_ports_blocking(&serial_manager)
            .map_err(|e| CommandError::Serial(e.to_string()))
    })
    .await
    .map_err(|e| CommandError::Other(format!("List ports task panicked: {e}")))?
}

/// 打开指定串口
#[derive(Debug, Clone, Deserialize)]
pub struct OpenPortArgs {
    pub port_id: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: String,
    pub handshake: String,
    pub dtr: bool,
    pub rts: bool,
    /// TTY 模拟终端（GIT:BASH）初始尺寸：前端 xterm fit() 后把当前 cols/rows 随
    /// 打开请求带来，pty 以正确尺寸 spawn——否则 pty 固定 80×24，vim/top 全屏
    /// 应用按 80×24 渲染而 xterm 按自身尺寸显示，画面错乱。
    /// 真实串口忽略；缺省时 serde 回退默认值。
    #[serde(default = "default_tty_cols")]
    pub cols: u16,
    #[serde(default = "default_tty_rows")]
    pub rows: u16,
}

fn default_tty_cols() -> u16 {
    80
}

fn default_tty_rows() -> u16 {
    24
}

/// 打开串口（真实 / SIM:Loopback / GIT:BASH 由 port_id 前缀决定）。
///
/// async + spawn_blocking：打开要做系统调用（CreateFile），热插拔幽灵句柄回收时
/// 还要枚举端口并 join 旧读线程——全是阻塞操作，同步命令会在事件循环主线程执行
/// 而卡住 UI。`serial::open_blocking` 自持/自放全局串口锁，阻塞阶段不挡其它串口
/// 命令。
///
/// 帧格式/流控取值（parity / stop_bits / data_bits / handshake）在打开路径解析时
/// 校验，未知取值直接报错——不再静默回落到默认帧格式。虚拟端口的能力门控也在
/// `SerialManager::open_port` 内先于任何副作用执行。
#[tauri::command]
pub async fn open_serial_port(
    args: OpenPortArgs,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let serial_manager = state.serial_manager.clone();
    let port_id = args.port_id.clone();
    serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?
        .cancel_reconnect(&port_id);
    tokio::task::spawn_blocking(move || {
        serial::open_blocking(&serial_manager, args).map_err(|e| {
            log::warn!("Failed to open port {}: {}", port_id, e);
            CommandError::Serial(e.to_string())
        })
    })
    .await
    .map_err(|e| CommandError::Other(format!("Open port task panicked: {e}")))?
}

/// 关闭指定串口
#[tauri::command]
pub async fn close_serial_port(
    port_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let serial_manager = state.serial_manager.clone();
    // 持锁期间只停止读取线程并取出 JoinHandle，立即释放锁
    let join_handle = {
        let mut manager = serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.close_port(&port_id).map_err(|e| {
            log::warn!("Failed to close port {}: {}", port_id, e);
            CommandError::Serial(e.to_string())
        })?
    };
    // join 移到阻塞线程池执行，不占主线程——GIT:BASH 读线程需等 ConPTY 关闭
    // （close_port 已 drop master）后才退出；即使读线程异常不退，同步 join 也不会
    // 再冻结整个应用 UI。
    if let Some(thread) = join_handle {
        tokio::task::spawn_blocking(move || {
            let _ = thread.join();
        })
        .await
        .map_err(|e| CommandError::Other(format!("close port join task failed: {e}")))?;
    }
    serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?
        .cleanup_real_close(&port_id);
    Ok(())
}

/// 向串口发送数据
#[derive(Debug, Clone, Deserialize)]
pub struct SendDataArgs {
    pub port_id: String,
    pub data: String,
    pub is_hex: bool,
    pub append_line_ending: String,
    /// Connection identity observed by the renderer; a send queued across a
    /// reconnect is rejected instead of being written into the new session.
    #[serde(default)]
    pub expected_generation: Option<u64>,
}

/// 向串口发送数据（异步非阻塞）。返回实际写入端口的字节数。
///
/// 旧实现是同步命令：Tauri 的同步命令在事件循环主线程上同步执行，内部每次调用都
/// 无条件执行「拿 serial_manager 锁 → 写串口 → 拿 log_manager 锁 → 写日志」。
/// 这些阻塞 IO 跑完前主线程无法处理重绘/点击/RX 刷新——每次发送都无条件卡顿，
/// 长期占用主线程还会错过 tao 的 RedrawEventsCleared 窗口，触发
/// NewEvents/RedrawEventsCleared 警告与白屏（与 RX 数据量无关，纯发送路径自身阻塞）。
///
/// 修法：改 async fn（命令移到 tokio 运行时，不再占主线程），再经
/// `spawn_blocking` 把串口 IO 与日志写放到独立线程池——主线程发完命令立即返回。
#[tauri::command]
pub async fn send_serial_data(
    args: SendDataArgs,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let _work = state
        .serial_work
        .admit()
        .ok_or_else(|| CommandError::Serial("Serial work is shutting down".into()))?;
    // 从 State 克隆出 'static 的 Arc 句柄供 spawn_blocking 闭包使用
    // （AppState 的 serial_manager / log_manager 是 Arc）。
    let serial_manager = state.serial_manager.clone();
    let log_manager = state.log_manager.clone();
    let SendDataArgs {
        port_id,
        data,
        is_hex,
        append_line_ending,
        expected_generation,
    } = args;
    tokio::task::spawn_blocking(move || {
        let tx = {
            let manager = serial_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            if let Some(expected) = expected_generation {
                if !manager.connection_matches(&port_id, expected) {
                    return Err(CommandError::Serial(
                        "Port connection changed before send".into(),
                    ));
                }
            }
            let kind = serial::PortKind::of(&port_id);
            match kind {
                serial::PortKind::Real => {
                    let write_port = manager
                        .get_write_handle(&port_id)
                        .map_err(|e| CommandError::Serial(e.to_string()))?;
                    let bytes = serial::build_tx_bytes(&data, is_hex, &append_line_ending)
                        .map_err(|e| CommandError::Serial(e.to_string()))?;
                    drop(manager);
                    let mut port = write_port
                        .lock()
                        .map_err(|e| CommandError::Lock(e.to_string()))?;
                    serial::write_all_with_deadline(
                        &port_id,
                        &mut **port,
                        &bytes,
                        serial::WRITE_TOTAL_DEADLINE,
                    )
                    .map_err(|e| CommandError::Serial(e.to_string()))?;
                    serial::TxOutcome::sent(bytes)
                }
                serial::PortKind::Tty => {
                    let writer = manager
                        .get_tty_write_handle(&port_id)
                        .map_err(|e| CommandError::Serial(e.to_string()))?;
                    let bytes = serial::build_tx_bytes(
                        &data,
                        is_hex,
                        serial::codec::normalize_tty_line_ending(&append_line_ending),
                    )
                    .map_err(|e| CommandError::Serial(e.to_string()))?;
                    drop(manager);
                    let written = writer
                        .write(&bytes)
                        .map_err(|e| CommandError::Serial(e.to_string()))?;
                    serial::TxOutcome::sent(bytes[..written].to_vec())
                }
                serial::PortKind::Sim => manager
                    .send_data(&port_id, &data, is_hex, &append_line_ending)
                    .map_err(|e| CommandError::Serial(e.to_string()))?,
            }
        };
        if !tx.bytes.is_empty() {
            let timestamp = chrono::Local::now()
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string();
            if let Err(e) = log_manager.write(&port_id, &timestamp, "TX", &tx.bytes) {
                log::warn!("Failed to write TX log for {}: {}", port_id, e);
            }
        }
        Ok(tx.written)
    })
    .await
    .map_err(|e| CommandError::Other(format!("Send task panicked: {e}")))?
}

/// 文件发送进度事件 payload
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProgressPayload {
    pub port_id: String,
    pub transfer_id: String,
    pub sent_bytes: usize,
    pub total_bytes: usize,
    pub done: bool,
}

/// 发送文件参数
#[derive(Debug, Deserialize)]
pub struct SendFileArgs {
    pub port_id: String,
    pub path: String,
    pub chunk_size: usize,
    pub delay_ms: u64,
    pub transfer_id: String,
    #[serde(default)]
    pub expected_generation: Option<u64>,
}

// Register atomically: a second send must not replace the first send's cancellation token.
fn register_file_send(
    sends: &std::sync::Mutex<std::collections::HashMap<String, FileSendRegistration>>,
    port_id: &str,
    transfer_id: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<(), CommandError> {
    let mut m = sends
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    if m.contains_key(port_id) {
        return Err(CommandError::Serial(format!(
            "File send already in progress for {port_id}"
        )));
    }
    m.insert(
        port_id.to_owned(),
        FileSendRegistration {
            transfer_id: transfer_id.to_owned(),
            cancel: Arc::clone(cancel),
        },
    );
    Ok(())
}

fn unregister_file_send(
    sends: &std::sync::Mutex<std::collections::HashMap<String, FileSendRegistration>>,
    port_id: &str,
    transfer_id: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<(), CommandError> {
    let mut m = sends
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    if m.get(port_id).is_some_and(|registered| {
        registered.transfer_id == transfer_id && Arc::ptr_eq(&registered.cancel, cancel)
    }) {
        m.remove(port_id);
    }
    Ok(())
}

/// 发送文件内容到串口（分块发送 + 进度事件 + 间隔延时）
#[tauri::command]
pub async fn send_file(
    args: SendFileArgs,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    let _work = state
        .serial_work
        .admit()
        .ok_or_else(|| CommandError::Serial("Serial work is shutting down".into()))?;
    let cancel = Arc::new(AtomicBool::new(false));
    register_file_send(
        &state.file_send_cancel,
        &args.port_id,
        &args.transfer_id,
        &cancel,
    )?;
    let _registration = FileSendGuard {
        sends: &state.file_send_cancel,
        port_id: args.port_id.clone(),
        transfer_id: args.transfer_id.clone(),
        cancel: Arc::clone(&cancel),
    };
    const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;
    let mut sent = 0usize;
    let mut total = 0usize;
    // Keep all validation inside the transfer future so every exit path reaches
    // the common cleanup/final-progress section below. In particular, a missing,
    // non-regular, or oversized file must not leave the UI's progress indicator
    // waiting forever for the terminal `done` event.
    let result = async {
        let metadata = tokio::fs::metadata(&args.path)
            .await
            .map_err(|e| CommandError::Io(format!("Failed to stat file '{}': {}", args.path, e)))?;
        if !metadata.is_file() {
            return Err(CommandError::Io(format!(
                "Not a regular file: '{}'",
                args.path
            )));
        }
        if metadata.len() > MAX_FILE_SIZE {
            return Err(CommandError::Io(format!(
                "File too large ({} bytes, max {} bytes)",
                metadata.len(),
                MAX_FILE_SIZE
            )));
        }
        let generation = {
            let manager = state
                .serial_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            let generation = manager
                .connection_generation(&args.port_id)
                .ok_or_else(|| CommandError::Serial(format!("Port not found: {}", args.port_id)))?;
            if args
                .expected_generation
                .is_some_and(|expected| generation != expected)
            {
                return Err(CommandError::Serial(
                    "Port connection changed before file send".into(),
                ));
            }
            generation
        };
        let mut file = tokio::fs::File::open(&args.path)
            .await
            .map_err(|e| CommandError::Io(format!("Failed to open file '{}': {}", args.path, e)))?;
        // Recheck the actual opened handle, not just the earlier path lookup.
        let metadata = file
            .metadata()
            .await
            .map_err(|e| CommandError::Io(e.to_string()))?;
        if !metadata.is_file() || metadata.len() > MAX_FILE_SIZE {
            return Err(CommandError::Io(format!(
                "File must remain regular and within the {} byte limit: '{}'",
                MAX_FILE_SIZE, args.path
            )));
        }
        total = metadata.len() as usize;
        let chunk_size = args.chunk_size.clamp(1, 1024 * 1024);
        // Only the current chunk remains resident during slow writes/delays,
        // rather than retaining the entire (up to 100 MiB) file for the transfer.
        let mut buffer = vec![0u8; chunk_size.min(total)];
        let mut read = 0usize;
        let mut chunk_index = 0usize;
        let is_real_port = serial::PortKind::of(&args.port_id) == serial::PortKind::Real;
        loop {
            if cancel.load(Ordering::Acquire) {
                break;
            }
            let len = read_file_send_chunk(&mut file, &mut buffer, total - read)
                .await
                .map_err(|e| {
                    CommandError::Io(format!("Failed to read file '{}': {}", args.path, e))
                })?;
            if len == 0 {
                break;
            }
            read += len;
            if cancel.load(Ordering::Acquire) {
                break;
            }
            let chunk = &buffer[..len];
            let write_result = {
                let manager = state
                    .serial_manager
                    .lock()
                    .map_err(|e| CommandError::Lock(e.to_string()))?;
                if !manager.connection_matches(&args.port_id, generation) {
                    return Err(CommandError::Serial(
                        "Port connection changed during file send".into(),
                    ));
                }
                if is_real_port {
                    let write_port = manager
                        .get_write_handle(&args.port_id)
                        .map_err(|e| CommandError::Serial(e.to_string()))?;
                    drop(manager);
                    let mut port = write_port
                        .lock()
                        .map_err(|e| CommandError::Lock(e.to_string()))?;
                    let mut written = 0;
                    let outcome = serial::write_with_deadline_progress(
                        &args.port_id,
                        &mut **port,
                        chunk,
                        serial::WRITE_TOTAL_DEADLINE,
                        &mut written,
                    );
                    sent += written;
                    outcome
                        .map(|_| 0)
                        .map_err(|e| CommandError::Serial(e.to_string()))
                } else if serial::PortKind::of(&args.port_id) == serial::PortKind::Tty {
                    let writer = manager
                        .get_tty_write_handle(&args.port_id)
                        .map_err(|e| CommandError::Serial(e.to_string()))?;
                    drop(manager);
                    writer
                        .write(chunk)
                        .map_err(|e| CommandError::Serial(e.to_string()))
                } else {
                    manager
                        .write_raw(&args.port_id, chunk)
                        .map_err(|e| CommandError::Serial(e.to_string()))
                }
            };
            sent += write_result?;
            let timestamp = chrono::Local::now()
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string();
            let log_data = format!("[FILE] chunk {} ({} bytes)", chunk_index, chunk.len());
            chunk_index += 1;
            if let Err(e) =
                state
                    .log_manager
                    .write(&args.port_id, &timestamp, "TX", log_data.as_bytes())
            {
                log::warn!("Failed to write file-send log for {}: {}", args.port_id, e);
            }
            let _ = app.emit(
                "serial:file_progress",
                FileProgressPayload {
                    port_id: args.port_id.clone(),
                    transfer_id: args.transfer_id.clone(),
                    sent_bytes: sent,
                    total_bytes: total,
                    done: false,
                },
            );
            if args.delay_ms > 0 {
                wait_file_send_delay(&cancel, args.delay_ms).await;
            } else {
                tokio::task::yield_now().await;
            }
            if read == total {
                break;
            }
        }
        Ok(sent)
    }
    .await;
    let cleanup = unregister_file_send(
        &state.file_send_cancel,
        &args.port_id,
        &args.transfer_id,
        &cancel,
    );
    let _ = app.emit(
        "serial:file_progress",
        FileProgressPayload {
            port_id: args.port_id.clone(),
            transfer_id: args.transfer_id.clone(),
            sent_bytes: sent,
            total_bytes: total,
            done: true,
        },
    );
    if let Err(e) = &result {
        log::warn!(
            "File send failed for {} (sent {} of {} bytes): {}",
            args.port_id,
            sent,
            total,
            e
        );
    }
    result.and(cleanup.map(|_| sent))
}

/// 设置串口参数（波特率、数据位等）
#[derive(Debug, Deserialize)]
pub struct SetSerialParamsArgs {
    pub port_id: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: String,
    pub handshake: String,
    /// Reject a parameter action queued for a connection that was replaced.
    #[serde(default)]
    pub expected_generation: Option<u64>,
}

#[tauri::command]
pub async fn set_serial_params(
    args: SetSerialParamsArgs,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let serial_manager = state.serial_manager.clone();
    tokio::task::spawn_blocking(move || {
        let mut manager = serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        if let Some(expected) = args.expected_generation {
            if !manager.connection_matches(&args.port_id, expected) {
                return Err(CommandError::Serial(
                    "Port connection changed before applying parameters".into(),
                ));
            }
        }
        manager
            .set_params(
                &args.port_id,
                args.baud_rate,
                args.data_bits,
                &args.parity,
                &args.stop_bits,
                &args.handshake,
            )
            .map_err(|e| {
                log::warn!("Failed to set params for {}: {}", args.port_id, e);
                CommandError::Serial(e.to_string())
            })
    })
    .await
    .map_err(|e| CommandError::Other(format!("Set params task panicked: {e}")))?
}

/// 尝试重新连接指定串口（异常断线后的自动恢复）
///
/// 关闭残留句柄 → join 旧读线程 → 校验端口仍在系统中 → 以上次参数重开。
/// 整个流程（含 join 与端口枚举）在 `serial::reconnect_blocking` 内分阶段完成：
/// 阻塞操作全在全局串口锁之外，且整体跑在阻塞线程池上，不占事件循环主线程。
#[tauri::command]
pub async fn attempt_reconnect(
    port_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let serial_manager = state.serial_manager.clone();
    // Capture intent before queuing blocking work; a close can cancel a queued attempt too.
    let cancel = serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?
        .begin_reconnect(&port_id);
    let cleanup_token = Arc::clone(&cancel);
    let cleanup_port = port_id.clone();
    let worker_manager = serial_manager.clone();
    let result = tokio::task::spawn_blocking(move || {
        serial::reconnect_blocking(&worker_manager, &port_id, &cancel).map_err(|e| {
            log::warn!("Auto-reconnect failed for {}: {}", port_id, e);
            CommandError::Serial(e.to_string())
        })
    })
    .await
    .map_err(|e| CommandError::Other(format!("Reconnect task panicked: {e}")))?;
    serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?
        .finish_reconnect(&cleanup_port, &cleanup_token);
    result
}

/// 设置流控（DTR/RTS/握手协议）
#[tauri::command]
pub async fn set_flow_control(
    port_id: String,
    dtr: bool,
    rts: bool,
    expected_generation: Option<u64>,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let serial_manager = state.serial_manager.clone();
    tokio::task::spawn_blocking(move || {
        let mut manager = serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .set_flow_control(&port_id, dtr, rts, expected_generation)
            .map_err(|e| {
                log::warn!("Failed to set flow control for {}: {}", port_id, e);
                CommandError::Serial(e.to_string())
            })
    })
    .await
    .map_err(|e| CommandError::Other(format!("Set flow control task panicked: {e}")))?
}

// ==================== 外部工具执行 ====================

/// 工具输出事件 payload（逐行推送到前端终端）
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolOutputPayload {
    pub port_id: String,
    pub line: String,
    pub stream: String, // "stdout" | "stderr"
}

/// 工具退出事件 payload
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolExitPayload {
    pub port_id: String,
    pub code: i32,
}

/// 执行外部工具参数
#[derive(Debug, Deserialize)]
pub struct RunPortToolArgs {
    pub port_id: String,
    /// 命令模板，`{port}` 在运行时替换为实际端口名
    pub command: String,
    /// 可选工作目录
    pub workdir: Option<String>,
}

/// Preserve tool outcome on normal exits, but never hide a failure that occurred
/// after closing the port (and include any failed recovery in that error).
fn finish_port_tool<F>(
    outcome: Result<i32, CommandError>,
    params: Option<OpenPortArgs>,
    reopen: F,
) -> (Result<i32, CommandError>, bool)
where
    F: FnOnce(OpenPortArgs) -> anyhow::Result<()>,
{
    let recovery = params.map(reopen).unwrap_or(Ok(()));
    let reopen_failed = recovery.is_err();
    let result = match (outcome, recovery) {
        (Ok(code), Ok(())) => Ok(code),
        (Ok(code), Err(e)) => {
            log::warn!("Failed to reopen port after tool exit (code {code}): {e}");
            Ok(code)
        }
        (Err(e), Ok(())) => Err(e),
        (Err(e), Err(recovery)) => Err(CommandError::Other(format!(
            "{e}; port recovery failed: {recovery}"
        ))),
    };
    (result, reopen_failed)
}

/// 执行外部工具：关闭串口 → 运行命令 → 流式输出 → 命令退出 → 立即重开串口。
///
/// 整个 close→run→reopen 闭环在后端一次完成，步骤 5→6（进程退出→串口重开）
/// 之间没有 await 让出点，确保 MCU reset 后第一帧调试输出能被立即捕获。
#[tauri::command]
pub async fn run_port_tool(
    args: RunPortToolArgs,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<i32, CommandError> {
    let _work = state
        .serial_work
        .admit()
        .ok_or_else(|| CommandError::Serial("Serial work is shutting down".into()))?;
    // Only a persisted tool configuration may be executed. Without this an
    // XSS/compromised renderer could use this command as an arbitrary shell.
    let configured = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let requested_workdir = args.workdir.as_deref().unwrap_or("").trim();
        manager
            .get_config()
            .entities
            .port_tool_configs
            .iter()
            .any(|entry| {
                entry.port_id == args.port_id
                    && entry.command.trim() == args.command.trim()
                    && entry.workdir.trim() == requested_workdir
            })
    };
    if !configured {
        return Err(CommandError::Other(format!(
            "No persisted external-tool configuration matches port {}",
            args.port_id
        )));
    }
    let owner = uuid::Uuid::new_v4().to_string();
    {
        let mut reservations = state
            .tool_reservations
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        if reservations.contains_key(&args.port_id) {
            return Err(CommandError::Serial(format!(
                "Tool already running for {}",
                args.port_id
            )));
        }
        reservations.insert(args.port_id.clone(), owner.clone());
    }
    let _reservation = ToolReservation {
        reservations: &state.tool_reservations,
        port_id: args.port_id.clone(),
        owner: owner.clone(),
    };
    let (last_params, join_handle, tool_generation) = {
        let mut mgr = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let params = mgr.get_last_params(&args.port_id);
        let generation = mgr.status_generation(&args.port_id).unwrap_or_default();
        let jh = mgr
            .close_port(&args.port_id)
            .map_err(|e| CommandError::Serial(e.to_string()))?;
        (params, jh, generation)
    };
    // Join outside the manager lock and off the async runtime worker. TTY
    // teardown may wait for a bounded child/reader cleanup, so a direct join
    // here would starve unrelated async serial commands.
    if let Some(t) = join_handle {
        tokio::task::spawn_blocking(move || {
            let _ = t.join();
        })
        .await
        .map_err(|e| CommandError::Other(format!("tool close join task failed: {e}")))?;
    }

    let outcome = async {
        let cmd = args.command.replace("{port}", &args.port_id);

        // 3. 构建子进程
        #[cfg(target_os = "windows")]
        let mut command = tokio::process::Command::new("cmd");
        #[cfg(target_os = "windows")]
        command.args(["/C", &cmd]);

        #[cfg(not(target_os = "windows"))]
        let mut command = tokio::process::Command::new("sh");
        #[cfg(not(target_os = "windows"))]
        command.args(["-c", &cmd]);
        #[cfg(not(target_os = "windows"))]
        command.process_group(0);

        command
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(dir) = &args.workdir {
            command.current_dir(dir);
        }

        let mut child = command
            .spawn()
            .map_err(|e| CommandError::Io(format!("Failed to spawn tool process: {}", e)))?;

        // kill_on_drop reaps a child abandoned by an output capture or lock failure.
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CommandError::Io("Failed to capture stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| CommandError::Io("Failed to capture stderr".into()))?;
        {
            let mut procs = state
                .tool_processes
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            procs.insert(args.port_id.clone(), child);
        }

        // 5. 并发读 stdout/stderr；短行保持逐行，长行按有界块推送。
        // Invalid UTF-8 remains lossy (never stops capture); UTF-8/CRLF tails
        // spanning chunk boundaries are carried into the following event.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<(&'static str, String)>(256);
        tokio::spawn(stream_tool_output(
            BufReader::new(stdout),
            "stdout",
            tx.clone(),
        ));
        tokio::spawn(stream_tool_output(
            BufReader::new(stderr),
            "stderr",
            tx.clone(),
        ));

        drop(tx); // 两个 reader 任务结束后 channel 关闭，rx.recv() 返回 None

        while let Some((stream, line)) = rx.recv().await {
            let _ = app.emit(
                "tool:output",
                ToolOutputPayload {
                    port_id: args.port_id.clone(),
                    line,
                    stream: stream.to_string(),
                },
            );
        }

        // 6. 等待进程退出（先取出 Child 再 drop 锁，MutexGuard 不跨 await）
        let child = {
            let mut procs = state
                .tool_processes
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            procs.remove(&args.port_id)
        };
        let exit_code = match child {
            Some(mut c) => c
                .wait()
                .await
                .map(|s| s.code().unwrap_or(-1))
                .map_err(|e| CommandError::Io(format!("Failed to wait for tool process: {}", e)))?,
            // 进程已被 kill_port_tool 移除并 wait，此处无法再 wait
            None => -1,
        };

        Ok(exit_code)
    }
    .await;

    // Reopen on every post-close exit (invalid workdir/spawn/capture/wait included).
    // open_blocking performs its blocking work outside the manager lock.
    let recovery_params = if state
        .serial_manager
        .lock()
        .map(|m| m.is_shutting_down())
        .unwrap_or(true)
    {
        None
    } else {
        last_params
    };
    let (result, reopen_failed) = finish_port_tool(outcome, recovery_params, |params| {
        serial::open_blocking(&state.serial_manager, params)
    });
    if reopen_failed {
        serial::emit_status_if_current(
            &app,
            &args.port_id,
            serial::PortStatus::Error,
            tool_generation,
        );
    }
    let code = result.as_ref().copied().unwrap_or(-1);
    let _ = app.emit(
        "tool:exit",
        ToolExitPayload {
            port_id: args.port_id.clone(),
            code,
        },
    );
    result
}

/// Kill a tool process and its descendants where the platform supports process trees.
fn kill_tool_process_tree(pid: u32) -> std::io::Result<bool> {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()?;
        Ok(status.success())
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGTERM) };
        Ok(result == 0)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        Ok(false)
    }
}

/// 终止正在运行的外部工具进程。
/// 进程被 kill 后 run_port_tool 的 wait() 会返回，自动触发串口重开。
#[tauri::command]
pub async fn kill_port_tool(
    port_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    // Read the pid, release the map lock, then run the blocking process-tree
    // kill on the blocking pool (this command previously blocked the event
    // loop on `taskkill` while holding `tool_processes`).
    let pid = {
        let procs = state
            .tool_processes
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        procs.get(&port_id).and_then(|child| child.id())
    };
    if let Some(pid) = pid {
        let killed = tokio::task::spawn_blocking(move || kill_tool_process_tree(pid))
        .await
        .map_err(|e| CommandError::Other(format!("Kill tool task failed: {e}")))?
        .map_err(|e| CommandError::Io(format!("Failed to kill tool process tree: {e}")))?;
        if killed {
            return Ok(());
        }
    }
    let mut procs = state
        .tool_processes
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    if let Some(child) = procs.get_mut(&port_id) {
        child
            .start_kill()
            .map_err(|e| CommandError::Io(format!("Failed to kill tool process: {e}")))?;
    }
    Ok(())
}

/// 取消正在进行的文件发送；只允许同一 transfer UUID 取消其拥有的 entry。
#[tauri::command]
pub fn cancel_file_send(
    port_id: String,
    transfer_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let m = state
        .file_send_cancel
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    if let Some(entry) = m.get(&port_id) {
        if entry.transfer_id == transfer_id {
            entry.cancel.store(true, Ordering::Release);
        }
    }
    Ok(())
}

/// Idempotent backend serial shutdown. Admission closes first; blocking
/// session teardown runs only after the manager lock is released.
pub async fn shutdown_serial_work(
    _app: AppHandle,
    state: &crate::AppState,
) -> Result<(), CommandError> {
    state.serial_work.begin_shutdown();
    {
        let mut manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.begin_shutdown();
    }
    {
        let map = state
            .file_send_cancel
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        for entry in map.values() {
            entry.cancel.store(true, Ordering::Release);
        }
    }
    let children = {
        let mut map = state
            .tool_processes
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        map.drain()
            .map(|(_, mut child)| async move {
                // Tools run in a process group/tree and may leave stdout/stderr
                // descendants alive after the leader is killed. Force-kill the
                // whole tree during shutdown so stream_tool_output tasks can
                // close and serial_work can drain deterministically.
                if let Some(pid) = child.id() {
                    let _ = tokio::task::spawn_blocking(move || {
                        #[cfg(windows)]
                        {
                            let _ = std::process::Command::new("taskkill")
                                .args(["/PID", &pid.to_string(), "/T", "/F"])
                                .status();
                        }
                        #[cfg(unix)]
                        {
                            unsafe {
                                let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
                            }
                        }
                    })
                    .await;
                }
                let _ = child.start_kill();
                let _ = child.wait().await;
            })
            .collect::<Vec<_>>()
    };
    for child in children {
        child.await;
    }
    let closes = {
        let mut manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let ids = manager.active_port_ids();
        ids.into_iter()
            .filter_map(|id| manager.close_port(&id).ok().flatten())
            .collect::<Vec<_>>()
    };
    for close in closes {
        tokio::task::spawn_blocking(move || {
            let _ = close.join();
        })
        .await
        .map_err(|e| CommandError::Other(format!("serial shutdown join failed: {e}")))?;
    }
    loop {
        if state.serial_work.active.load(Ordering::Acquire) == 0 {
            break;
        }
        state.serial_work.drained.notified().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{finish_port_tool, register_file_send, unregister_file_send, CommandError};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn cancelled_file_send_delay_returns_without_waiting_full_delay() {
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let worker = tokio::spawn(async move {
            super::wait_file_send_delay(&worker_cancel, 5_000).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        cancel.store(true, Ordering::Release);
        tokio::time::timeout(std::time::Duration::from_secs(1), worker)
            .await
            .expect("cancellation must interrupt a long delay")
            .unwrap();
    }

    #[tokio::test]
    async fn file_send_streams_large_input_in_one_reused_bounded_buffer() {
        use tokio::io::AsyncReadExt;
        const TOTAL: usize = 100 * 1024 * 1024;
        let mut reader = tokio::io::repeat(0x5a).take(TOTAL as u64);
        let mut buffer = vec![0; 64 * 1024];
        let pointer = buffer.as_ptr();
        let mut read = 0;
        loop {
            let len = super::read_file_send_chunk(&mut reader, &mut buffer, TOTAL - read)
                .await
                .unwrap();
            if len == 0 {
                break;
            }
            assert!(len <= 64 * 1024);
            assert!(buffer[..len].iter().all(|&byte| byte == 0x5a));
            assert_eq!(pointer, buffer.as_ptr());
            read += len;
        }
        assert_eq!(read, TOTAL);
        assert_eq!(buffer.len(), 64 * 1024);
    }

    #[tokio::test]
    async fn file_send_detects_growth_shrink_and_preserves_final_short_chunk() {
        let mut reader = &b"abcdefg"[..];
        let mut buffer = [0; 4];
        assert_eq!(
            super::read_file_send_chunk(&mut reader, &mut buffer, 7)
                .await
                .unwrap(),
            4
        );
        assert_eq!(&buffer, b"abcd");
        assert_eq!(
            super::read_file_send_chunk(&mut reader, &mut buffer, 3)
                .await
                .unwrap(),
            3
        );
        assert_eq!(&buffer[..3], b"efg");
        assert_eq!(
            super::read_file_send_chunk(&mut reader, &mut buffer, 0)
                .await
                .unwrap(),
            0
        );
        let mut short = &b"ab"[..];
        assert_eq!(
            super::read_file_send_chunk(&mut short, &mut buffer, 4)
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::UnexpectedEof
        );
        let mut grown = &b"extra"[..];
        assert!(super::read_file_send_chunk(&mut grown, &mut buffer, 0)
            .await
            .is_err());
        let mut grown_before_final_chunk = &b"abcde"[..];
        assert!(
            super::read_file_send_chunk(&mut grown_before_final_chunk, &mut buffer, 4)
                .await
                .is_err()
        );
        let mut empty = &b""[..];
        assert_eq!(
            super::read_file_send_chunk(&mut empty, &mut [], 0)
                .await
                .unwrap(),
            0
        );
    }

    async fn captured_tool_output(input: Vec<u8>) -> Vec<String> {
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let task = tokio::spawn(async move {
            // A small reader buffer forces delimiters/characters across reads.
            super::stream_tool_output(
                tokio::io::BufReader::with_capacity(7, input.as_slice()),
                "stdout",
                tx,
            )
            .await;
        });
        let mut output = Vec::new();
        while let Some((stream, line)) = rx.recv().await {
            assert_eq!(stream, "stdout");
            output.push(line);
        }
        task.await.unwrap();
        output
    }

    #[tokio::test]
    async fn tool_output_without_newlines_is_chunked_without_truncation() {
        let input = vec![b'x'; 2 * 1024 * 1024 + 17];
        let chunks = captured_tool_output(input.clone()).await;
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= super::TOOL_OUTPUT_CHUNK_BYTES));
        assert_eq!(chunks.concat().as_bytes(), input);
    }

    #[tokio::test]
    async fn tool_output_preserves_utf8_and_crlf_at_chunk_boundaries() {
        let mut input = vec![0xff];
        input.extend(vec![b'a'; super::TOOL_OUTPUT_CHUNK_BYTES - 2]);
        input.extend_from_slice("世界🌍".as_bytes());
        let expected = String::from_utf8_lossy(&input).into_owned();
        input.extend_from_slice(b"\r\n");
        assert_eq!(captured_tool_output(input).await.concat(), expected);

        let mut input = vec![b'a'; super::TOOL_OUTPUT_CHUNK_BYTES - 1];
        input.extend_from_slice(b"\r\n\n");
        assert_eq!(
            captured_tool_output(input).await,
            vec![
                "a".repeat(super::TOOL_OUTPUT_CHUNK_BYTES - 1),
                String::new()
            ]
        );
        assert_eq!(
            captured_tool_output(b"\nhello\r\ninvalid\xff\nlast".to_vec()).await,
            vec!["", "hello", "invalid\u{fffd}", "last"]
        );
        assert!(captured_tool_output(Vec::new()).await.is_empty());
    }

    #[test]
    fn concurrent_file_send_cannot_replace_or_remove_first_cancel_token() {
        let sends = Mutex::new(HashMap::new());
        let first = Arc::new(AtomicBool::new(false));
        let second = Arc::new(AtomicBool::new(false));
        register_file_send(&sends, "COM3", "first", &first).unwrap();
        assert!(register_file_send(&sends, "COM3", "second", &second).is_err());
        unregister_file_send(&sends, "COM3", "second", &second).unwrap();
        let token = sends.lock().unwrap().get("COM3").unwrap().cancel.clone();
        token.store(true, Ordering::Relaxed);
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
        unregister_file_send(&sends, "COM3", "first", &first).unwrap();
        assert!(sends.lock().unwrap().is_empty());
    }

    #[test]
    fn tool_failure_preserves_original_error_and_recovery_failure() {
        let params = super::OpenPortArgs {
            port_id: "COM3".into(),
            baud_rate: 9600,
            data_bits: 8,
            parity: "None".into(),
            stop_bits: "One".into(),
            handshake: "None".into(),
            dtr: true,
            rts: true,
            cols: 80,
            rows: 24,
        };
        let (result, failed) = finish_port_tool(
            Err(CommandError::Io("invalid workdir".into())),
            Some(params),
            |_| Err(anyhow::anyhow!("device unavailable")),
        );
        assert!(failed);
        let error = result.unwrap_err().to_string();
        assert!(error.contains("invalid workdir"), "{error}");
        assert!(error.contains("device unavailable"), "{error}");
    }
}
