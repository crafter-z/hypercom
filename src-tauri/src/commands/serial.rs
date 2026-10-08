use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use super::CommandError;
use crate::{serial, AppState};

use tokio::io::{AsyncBufReadExt, BufReader};

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
        serial::list_ports_blocking(&serial_manager).map_err(|e| CommandError::Serial(e.to_string()))
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
        let _ = tokio::task::spawn_blocking(move || {
            let _ = thread.join();
        })
        .await
        .map_err(|e| CommandError::Other(format!("close port join task failed: {e}")))?;
    }
    Ok(())
}

/// 向串口发送数据
#[derive(Debug, Clone, Deserialize)]
pub struct SendDataArgs {
    pub port_id: String,
    pub data: String,
    pub is_hex: bool,
    pub append_line_ending: String,
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
    // 从 State 克隆出 'static 的 Arc 句柄供 spawn_blocking 闭包使用
    // （AppState 的 serial_manager / log_manager 是 Arc）。
    let serial_manager = state.serial_manager.clone();
    let log_manager = state.log_manager.clone();
    let SendDataArgs {
        port_id,
        data,
        is_hex,
        append_line_ending,
    } = args;

    tokio::task::spawn_blocking(move || {
        let tx = {
            let manager = serial_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            match serial::PortKind::of(&port_id) {
                // 真实串口：**两段式**——全局锁内只做 HashMap 查找 + Arc 克隆写
                // 句柄，立即释放全局锁，再只持 per-port 写锁执行带总期限的写入。
                // 不再持全局 serial_manager 锁执行写：端口列表轮询 / 其它端口命令
                // 不被慢发送拖死。
                serial::PortKind::Real => {
                    let write_port = manager.get_write_handle(&port_id).map_err(|e| {
                        log::warn!("Failed to send data to {}: {}", port_id, e);
                        CommandError::Serial(e.to_string())
                    })?;
                    let bytes = serial::build_tx_bytes(&data, is_hex, &append_line_ending)
                        .map_err(|e| CommandError::Serial(e.to_string()))?;
                    drop(manager); // 释放全局锁，写操作在锁外执行
                    let mut port = write_port
                        .lock()
                        .map_err(|e| CommandError::Lock(e.to_string()))?;
                    serial::write_all_with_deadline(
                        &port_id,
                        &mut **port,
                        &bytes,
                        serial::WRITE_TOTAL_DEADLINE,
                    )
                    .map_err(|e| {
                        log::warn!("Failed to send data to {}: {}", port_id, e);
                        CommandError::Serial(e.to_string())
                    })?;
                    serial::TxOutcome::sent(bytes)
                }
                // SIM / GIT 虚拟端口：channel / pty writer 写非阻塞，锁内完成即可。
                _ => manager
                    .send_data(&port_id, &data, is_hex, &append_line_ending)
                    .map_err(|e| {
                        log::warn!("Failed to send data to {}: {}", port_id, e);
                        CommandError::Serial(e.to_string())
                    })?,
            }
        };

        // TX 日志只写 `tx.bytes`（实际送达端口的字节）：TTY 的行结束符归一、SIM
        // 频率命令被控制通道吞掉、行结束符追加都只在这里体现一次。按入参重算日志
        // 会让日志与线上字节不一致（记下发出去的字节数与线上不符）。
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
pub struct FileProgressPayload {
    pub port_id: String,
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
}

// Register atomically: a second send must not replace the first send's cancellation token.
fn register_file_send(
    sends: &std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
    port_id: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<(), CommandError> {
    let mut m = sends.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
    if m.contains_key(port_id) {
        return Err(CommandError::Serial(format!("File send already in progress for {port_id}")));
    }
    m.insert(port_id.to_owned(), Arc::clone(cancel));
    Ok(())
}

fn unregister_file_send(
    sends: &std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
    port_id: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<(), CommandError> {
    let mut m = sends.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
    if m.get(port_id).is_some_and(|registered| Arc::ptr_eq(registered, cancel)) {
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
    // 文件大小上限 100 MB：串口发送速率有限（115200 baud ≈ 11.5 KB/s），
    // 超大文件发送不切实际，且 std::fs::read 会一次性加载到内存。
    const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;
    let metadata = std::fs::metadata(&args.path)
        .map_err(|e| CommandError::Io(format!("Failed to stat file '{}': {}", args.path, e)))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(CommandError::Io(format!(
            "File too large ({} bytes, max {} bytes)",
            metadata.len(),
            MAX_FILE_SIZE
        )));
    }
    // 注册取消令牌：前端调用 cancel_file_send 置位后，发送循环在下一块退出。
    let cancel = Arc::new(AtomicBool::new(false));
    register_file_send(&state.file_send_cancel, &args.port_id, &cancel)?;

    let mut sent = 0usize;
    let mut total = 0usize;
    let result = async {
        // Async read and every later fallible operation share the terminal cleanup below.
        let data = tokio::fs::read(&args.path)
            .await
            .map_err(|e| CommandError::Io(format!("Failed to read file '{}': {}", args.path, e)))?;
        total = data.len();
        let chunk_size = args.chunk_size.max(1);
        let is_real_port = serial::PortKind::of(&args.port_id) == serial::PortKind::Real;

        for (chunk_index, chunk) in data.chunks(chunk_size).enumerate() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            // 锁作用域仅限写入本身：内层块返回 Result 后即释放 MutexGuard，
            // 保证下方 await（sleep/yield）之前不持锁。
            match {
                let manager = state
                    .serial_manager
                    .lock()
                    .map_err(|e| CommandError::Lock(e.to_string()))?;
                if is_real_port {
                    // 真实串口两段式：全局锁内只取写句柄克隆，释放全局锁后锁外写
                    let write_port = manager
                        .get_write_handle(&args.port_id)
                        .map_err(|e| CommandError::Serial(e.to_string()))?;
                    drop(manager);
                    let mut port = write_port
                        .lock()
                        .map_err(|e| CommandError::Lock(e.to_string()))?;
                    let mut written = 0;
                    let result = serial::write_with_deadline_progress(
                        &args.port_id,
                        &mut **port,
                        chunk,
                        serial::WRITE_TOTAL_DEADLINE,
                        &mut written,
                    );
                    sent += written;
                    result.map(|_| 0).map_err(|e| CommandError::Serial(e.to_string()))
                } else {
                    // SIM / GIT 虚拟端口：channel / pty writer 写非阻塞，锁内完成
                    manager
                        .write_raw(&args.port_id, chunk)
                        .map_err(|e| CommandError::Serial(e.to_string()))
                }
            } {
                Ok(n) => sent += n,
                Err(e) => return Err(e),
            }
            // 记录 TX 元信息（仅 chunk 序号与长度，不记录二进制内容本身）。
            // log_manager 锁在下方 await 之前释放，不跨 await 持有 MutexGuard。
            let timestamp = chrono::Local::now()
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string();
            let log_data = format!("[FILE] chunk {} ({} bytes)", chunk_index, chunk.len());
            if let Err(e) = state
                .log_manager
                .write(&args.port_id, &timestamp, "TX", log_data.as_bytes())
            {
                log::warn!("Failed to write file-send log for {}: {}", args.port_id, e);
            }
            // `sent` counts only bytes confirmed written by this chunk.
            let _ = app.emit(
                "serial:file_progress",
                FileProgressPayload {
                    port_id: args.port_id.clone(),
                    sent_bytes: sent,
                    total_bytes: total,
                    done: false,
                },
            );
            if args.delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(args.delay_ms)).await;
            } else {
                // 即使无延时也让出一点，避免长文件发送饿死其它异步任务。
                tokio::task::yield_now().await;
            }
        }
        Ok(sent)
    }
    .await;

    // All post-registration failures, including failed async reads and lock errors,
    // pass through this path. Never erase another invocation's token.
    let cleanup = unregister_file_send(&state.file_send_cancel, &args.port_id, &cancel);
    let _ = app.emit(
        "serial:file_progress",
        FileProgressPayload {
            port_id: args.port_id.clone(),
            sent_bytes: sent,
            total_bytes: total,
            done: true,
        },
    );
    if let Err(e) = &result {
        log::warn!("File send failed for {} (sent {} of {} bytes): {}", args.port_id, sent, total, e);
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
}

#[tauri::command]
pub fn set_serial_params(
    args: SetSerialParamsArgs,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
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
    tokio::task::spawn_blocking(move || {
        serial::reconnect_blocking(&serial_manager, &port_id).map_err(|e| {
            log::warn!("Auto-reconnect failed for {}: {}", port_id, e);
            CommandError::Serial(e.to_string())
        })
    })
    .await
    .map_err(|e| CommandError::Other(format!("Reconnect task panicked: {e}")))?
}

/// 设置流控（DTR/RTS/握手协议）
#[tauri::command]
pub fn set_flow_control(
    port_id: String,
    dtr: bool,
    rts: bool,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .set_flow_control(&port_id, dtr, rts)
        .map_err(|e| {
            log::warn!("Failed to set flow control for {}: {}", port_id, e);
            CommandError::Serial(e.to_string())
        })
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
        (Err(e), Err(recovery)) => Err(CommandError::Other(format!("{e}; port recovery failed: {recovery}"))),
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
    // 1. 获取上次连接参数 + 关闭串口（一次锁完成），取出 JoinHandle 后释放锁
    let (last_params, join_handle) = {
        let mut mgr = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let params = mgr.get_last_params(&args.port_id);
        let jh = mgr
            .close_port(&args.port_id)
            .map_err(|e| CommandError::Serial(e.to_string()))?;
        (params, jh)
    };
    // 在锁外 join：读线程最长约 100ms 退出，不能在全局串口锁内阻塞。
    if let Some(t) = join_handle {
        let _ = t.join();
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
    let stdout = child.stdout.take().ok_or_else(|| CommandError::Io("Failed to capture stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| CommandError::Io("Failed to capture stderr".into()))?;
    {
        let mut procs = state.tool_processes.lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        procs.insert(args.port_id.clone(), child);
    }

    // 5. 并发读取 stdout/stderr，逐行推送 tool:output 事件
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(String, String)>(256);

    // 按字节读到 '\n' 为止，再用 from_utf8_lossy 转字符串：
    // lines()/next_line() 遇到非法 UTF-8 会静默停止，截断二进制烧录器输出。
    let tx_out = tx.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf)
                        .trim_end_matches(|c| c == '\n' || c == '\r')
                        .to_string();
                    if tx_out.send(("stdout".to_string(), line)).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let tx_err = tx.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf)
                        .trim_end_matches(|c| c == '\n' || c == '\r')
                        .to_string();
                    if tx_err.send(("stderr".to_string(), line)).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    drop(tx); // 两个 reader 任务结束后 channel 关闭，rx.recv() 返回 None

    while let Some((stream, line)) = rx.recv().await {
        let _ = app.emit(
            "tool:output",
            ToolOutputPayload {
                port_id: args.port_id.clone(),
                line,
                stream,
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

    // Notify the UI before reclaiming the port on normal tool completion.
    let _ = app.emit(
        "tool:exit",
        ToolExitPayload {
            port_id: args.port_id.clone(),
            code: exit_code,
        },
    );
    Ok(exit_code)
    }
    .await;

    // Reopen on every post-close exit (invalid workdir/spawn/capture/wait included).
    // open_blocking performs its blocking work outside the manager lock.
    let (result, reopen_failed) = finish_port_tool(outcome, last_params, |params| {
        serial::open_blocking(&state.serial_manager, params)
    });
    if reopen_failed {
        serial::emit_status(&app, &args.port_id, serial::PortStatus::Error);
    }
    result
}

/// 终止正在运行的外部工具进程。
/// 进程被 kill 后 run_port_tool 的 wait() 会返回，自动触发串口重开。
#[tauri::command]
pub fn kill_port_tool(port_id: String, state: State<AppState>) -> Result<(), CommandError> {
    let mut procs = state
        .tool_processes
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    if let Some(child) = procs.get_mut(&port_id) {
        child
            .start_kill()
            .map_err(|e| CommandError::Io(format!("Failed to kill tool process: {}", e)))?;
    }
    Ok(())
}

/// 取消正在进行的文件发送。
/// 置位取消令牌后 send_file 的发送循环在下一块退出，并发出 done:true 终结事件。
/// 前端调用: invoke('cancel_file_send', { portId })
#[tauri::command]
pub fn cancel_file_send(port_id: String, state: State<AppState>) -> Result<(), CommandError> {
    let m = state
        .file_send_cancel
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    if let Some(flag) = m.get(&port_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{finish_port_tool, register_file_send, unregister_file_send, CommandError};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    #[test]
    fn concurrent_file_send_cannot_replace_or_remove_first_cancel_token() {
        let sends = Mutex::new(HashMap::new());
        let first = Arc::new(AtomicBool::new(false));
        let second = Arc::new(AtomicBool::new(false));
        register_file_send(&sends, "COM3", &first).unwrap();
        assert!(register_file_send(&sends, "COM3", &second).is_err());
        unregister_file_send(&sends, "COM3", &second).unwrap();
        let token = sends.lock().unwrap().get("COM3").unwrap().clone();
        token.store(true, Ordering::Relaxed);
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
        unregister_file_send(&sends, "COM3", &first).unwrap();
        assert!(sends.lock().unwrap().is_empty());
    }

    #[test]
    fn tool_failure_preserves_original_error_and_recovery_failure() {
        let params = super::OpenPortArgs {
            port_id: "COM3".into(), baud_rate: 9600, data_bits: 8,
            parity: "None".into(), stop_bits: "One".into(), handshake: "None".into(),
            dtr: true, rts: true, cols: 80, rows: 24,
        };
        let (result, failed) = finish_port_tool(Err(CommandError::Io("invalid workdir".into())), Some(params), |_| {
            Err(anyhow::anyhow!("device unavailable"))
        });
        assert!(failed);
        let error = result.unwrap_err().to_string();
        assert!(error.contains("invalid workdir"), "{error}");
        assert!(error.contains("device unavailable"), "{error}");
    }
}
