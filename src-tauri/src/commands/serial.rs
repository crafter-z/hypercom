use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use super::CommandError;
use crate::{serial, AppState};

use tokio::io::{AsyncBufReadExt, BufReader};

/// 获取系统可用串口列表
/// 前端调用: invoke('list_available_ports')
#[tauri::command]
pub fn list_available_ports(state: State<AppState>) -> Result<Vec<serial::PortInfo>, CommandError> {
    let manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .list_ports()
        .map_err(|e| CommandError::Serial(e.to_string()))
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
    /// TTY 模拟终端（GIT:BASH）初始尺寸（issue #11）：前端 xterm fit() 后把当前
    /// cols/rows 随打开请求带来，pty 以正确尺寸 spawn——否则 pty 固定 80×24，
    /// vim/top 全屏应用按 80×24 渲染而 xterm 按自身尺寸显示，画面错乱。
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

#[tauri::command]
pub fn open_serial_port(args: OpenPortArgs, state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.open_port(args.clone()).map_err(|e| {
        log::warn!("Failed to open port {}: {}", args.port_id, e);
        CommandError::Serial(e.to_string())
    })
}

/// 关闭指定串口
#[tauri::command]
pub fn close_serial_port(port_id: String, state: State<AppState>) -> Result<(), CommandError> {
    // 持锁期间只停止读取线程并取出 JoinHandle，立即释放锁
    let join_handle = {
        let mut manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.close_port(&port_id).map_err(|e| {
            log::warn!("Failed to close port {}: {}", port_id, e);
            CommandError::Serial(e.to_string())
        })?
    };
    // 在锁外 join：读取线程退出最长约 100ms，不能阻塞其他串口命令
    if let Some(thread) = join_handle {
        let _ = thread.join();
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

/// 向串口发送数据（异步非阻塞，issue #6-1）。
///
/// 旧实现是同步命令（pub fn）：Tauri 的同步命令在事件循环主线程上同步执行，
/// 内部每次调用都无条件执行「拿 serial_manager 锁 → write_all+flush 写串口 →
/// 拿 log_manager 锁 → BufWriter 写日志」。这些阻塞 IO 跑完前主线程无法处理
/// 重绘/点击/RX 刷新——每次发送都无条件卡顿，长期占用主线程还会错过 tao 的
/// RedrawEventsCleared 窗口，触发 NewEvents/RedrawEventsCleared 警告与白屏
/// （与 RX 数据量无关，纯发送路径自身阻塞）。
///
/// 修法：改 async fn（命令移到 tokio 运行时，不再占主线程），再经
/// `spawn_blocking` 把串口 IO 与日志写放到独立线程池——主线程发完命令立即返回。
/// `send_file` 本就是 async fn（tokio::fs::read + 分块间 yield），无同类主线程
/// 阻塞点；其分块写入的阻塞上限是单块大小，可接受。
#[tauri::command]
pub async fn send_serial_data(
    args: SendDataArgs,
    state: State<'_, AppState>,
) -> Result<usize, CommandError> {
    // 从 State 克隆出 'static 的 Arc 句柄供 spawn_blocking 闭包使用
    // （AppState 的 serial_manager / log_manager 是 Arc<Mutex<..>>）。
    let serial_manager = state.serial_manager.clone();
    let log_manager = state.log_manager.clone();
    let port_id = args.port_id.clone();
    let data = args.data.clone();
    let is_hex = args.is_hex;
    let append_line_ending = args.append_line_ending.clone();

    tokio::task::spawn_blocking(move || {
        let n = {
            let manager = serial_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            if port_id.starts_with("SIM:") || port_id.starts_with("GIT:") {
                // SIM / GIT 虚拟端口：channel / pty writer 写非阻塞，锁内完成即可
                // （GIT: 模拟终端 pty stdin 写，issue #11）。
                manager
                    .send_data(&port_id, &data, is_hex, &append_line_ending)
                    .map_err(|e| {
                        log::warn!("Failed to send data to {}: {}", port_id, e);
                        CommandError::Serial(e.to_string())
                    })?
            } else {
                // 真实串口（issue #6-10 方案2）：**两段式**——全局锁内只做
                // HashMap 查找 + Arc 克隆写句柄，立即释放全局锁，再只持
                // per-port 写锁执行带总期限的写入。不再持全局 serial_manager
                // 锁执行写：端口列表轮询 / 其它端口命令不被慢发送拖死。
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
                serial::write_all_with_deadline(&mut **port, &bytes, serial::WRITE_TOTAL_DEADLINE)
                    .map_err(|e| {
                        log::warn!("Failed to send data to {}: {}", port_id, e);
                        CommandError::Serial(e.to_string())
                    })?;
                bytes.len()
            }
        };
        // Write TX data to log if a writer exists
        let timestamp = chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string();
        // 用与发送路径完全相同的 build_tx_bytes 还原写入串口的字节序列，
        // 使日志 TX 字节 == 实际发送字节（消除 SIM / 文本带行结束符的三处字节数不一致）。
        // 解析失败时仅记录文本字节；HEX 解析在前面 send_data 已成功，理论上不会失败。
        let log_data = serial::build_tx_bytes(&data, is_hex, &append_line_ending)
            .unwrap_or_else(|_| data.as_bytes().to_vec());
        if let Ok(mut log_mgr) = log_manager.lock() {
            let _ = log_mgr.write(&port_id, &timestamp, "TX", &log_data);
        }
        Ok(n)
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
    {
        let mut m = state
            .file_send_cancel
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        m.insert(args.port_id.clone(), cancel.clone());
    }

    // 异步读取文件，避免在异步命令中阻塞运行时线程。
    let data = tokio::fs::read(&args.path)
        .await
        .map_err(|e| CommandError::Io(format!("Failed to read file '{}': {}", args.path, e)))?;
    let total = data.len();
    let chunk_size = args.chunk_size.max(1);
    let mut sent = 0usize;
    let mut send_err: Option<CommandError> = None;

    if total > 0 {
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
                if args.port_id.starts_with("SIM:") || args.port_id.starts_with("GIT:") {
                    // SIM / GIT 虚拟端口：channel / pty writer 写非阻塞，锁内完成
                    // （GIT: 模拟终端 pty stdin 写，issue #11）。
                    manager
                        .write_raw(&args.port_id, chunk)
                        .map_err(|e| CommandError::Serial(e.to_string()))
                } else {
                    // 真实串口（issue #6-10 方案2）：两段式——全局锁内只取写句柄
                    // 克隆，释放全局锁后锁外写（不持全局锁执行写）。
                    let write_port = manager.get_write_handle(&args.port_id).map_err(|e| {
                        CommandError::Serial(e.to_string())
                    })?;
                    drop(manager);
                    let mut port = write_port
                        .lock()
                        .map_err(|e| CommandError::Lock(e.to_string()))?;
                    serial::write_all_with_deadline(
                        &mut **port,
                        chunk,
                        serial::WRITE_TOTAL_DEADLINE,
                    )
                    .map(|_| chunk.len())
                    .map_err(|e| CommandError::Serial(e.to_string()))
                }
            } {
                Ok(_) => {}
                Err(e) => {
                    send_err = Some(e);
                    break;
                }
            }
            // 记录 TX 元信息（仅 chunk 序号与长度，不记录二进制内容本身）。
            // log_manager 锁在下方 await 之前释放，不跨 await 持有 MutexGuard。
            if let Ok(mut log_mgr) = state.log_manager.lock() {
                let timestamp = chrono::Local::now()
                    .format("%Y-%m-%d %H:%M:%S%.3f")
                    .to_string();
                let log_data = format!("[FILE] chunk {} ({} bytes)", chunk_index, chunk.len());
                let _ = log_mgr.write(&args.port_id, &timestamp, "TX", log_data.as_bytes());
            }
            sent += chunk.len();
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
    }

    // 无条件清理取消令牌并发出终结事件——正常完成 / 取消 / 写错误 / 空文件
    // 四条路径都保证 done:true 触发，前端进度条不会卡住。
    if let Ok(mut m) = state.file_send_cancel.lock() {
        m.remove(&args.port_id);
    }
    let _ = app.emit(
        "serial:file_progress",
        FileProgressPayload {
            port_id: args.port_id.clone(),
            sent_bytes: sent,
            total_bytes: total,
            done: true,
        },
    );
    match send_err {
        Some(e) => {
            log::warn!(
                "File send failed for {} (sent {} of {} bytes): {}",
                args.port_id,
                sent,
                total,
                e
            );
            Err(e)
        }
        None => Ok(sent),
    }
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
#[tauri::command]
pub fn attempt_reconnect(port_id: String, state: State<AppState>) -> Result<(), CommandError> {
    // 阶段 1：持锁关闭残留句柄，取出读取线程 JoinHandle 后释放锁
    let join_handle = {
        let mut manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .close_port(&port_id)
            .map_err(|e| CommandError::Serial(e.to_string()))?
    };
    // 阶段 2：在锁外 join，避免阻塞其他串口命令；
    // 也确保旧端口句柄已释放，后续 open_port 不会因端口被占用而失败
    if let Some(thread) = join_handle {
        let _ = thread.join();
    }
    // 阶段 3：重新持锁，校验端口并以上次参数打开
    let mut manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.attempt_reconnect(&port_id).map_err(|e| {
        log::warn!("Auto-reconnect failed for {}: {}", port_id, e);
        CommandError::Serial(e.to_string())
    })
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
    // 在锁外 join：读线程最长约 100ms 退出，不能在全局串口锁内阻塞（与 close_serial_port 一致）。
    if let Some(t) = join_handle {
        let _ = t.join();
    }

    // 2. 替换命令模板中的 {port} 占位符
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
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(ref dir) = args.workdir {
        command.current_dir(dir);
    }

    let mut child = command
        .spawn()
        .map_err(|e| CommandError::Io(format!("Failed to spawn tool process: {}", e)))?;

    // 4. 取出 stdout/stderr 句柄后将 Child 存入 AppState（供 kill_port_tool 使用）
    let stdout = child.stdout.take().ok_or_else(|| CommandError::Io("Failed to capture stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| CommandError::Io("Failed to capture stderr".into()))?;
    {
        let mut procs = state
            .tool_processes
            .lock()
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

    // 7. 推送退出事件
    let _ = app.emit(
        "tool:exit",
        ToolExitPayload {
            port_id: args.port_id.clone(),
            code: exit_code,
        },
    );

    // 8. 立即重开串口（零延迟抢回 COM 口）
    if let Some(params) = last_params {
        let mut mgr = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        if let Err(e) = mgr.open_port(params) {
            log::warn!("Failed to reopen port {} after tool exit: {}", args.port_id, e);
            // 重开失败不视为命令错误——工具已成功执行；但需通知 UI 反映重开失败状态。
            let _ = app.emit(
                "serial:status",
                serial::SerialStatusEvent {
                    port_id: args.port_id.clone(),
                    status: "error".to_string(),
                },
            );
        }
    }

    Ok(exit_code)
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
