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
}

#[tauri::command]
pub fn open_serial_port(args: OpenPortArgs, state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .open_port(args)
        .map_err(|e| CommandError::Serial(e.to_string()))
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
        manager
            .close_port(&port_id)
            .map_err(|e| CommandError::Serial(e.to_string()))?
    };
    // 在锁外 join：读取线程退出最长约 100ms，不能阻塞其他串口命令
    if let Some(thread) = join_handle {
        let _ = thread.join();
    }
    Ok(())
}

/// 向串口发送数据
#[derive(Debug, Deserialize)]
pub struct SendDataArgs {
    pub port_id: String,
    pub data: String,
    pub is_hex: bool,
    pub append_line_ending: String,
}

#[tauri::command]
pub fn send_serial_data(args: SendDataArgs, state: State<AppState>) -> Result<usize, CommandError> {
    let n = {
        let manager = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .send_data(
                &args.port_id,
                &args.data,
                args.is_hex,
                &args.append_line_ending,
            )
            .map_err(|e| CommandError::Serial(e.to_string()))?
    };
    // Write TX data to log if a writer exists
    let timestamp = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
    // 用与 send_data() 相同的解析逻辑还原写入串口的字节序列：
    // - HEX 模式：解析 "48 65 6C" 形式
    // - 文本模式：附加 line ending（与 send_data 内部行为一致）
    // 解析失败时仅记录文本字节，避免写入与实际不一致；HEX 解析在前面的 send_data 已成功，理论上不会失败。
    let log_data: Vec<u8> = if args.is_hex {
        serial::parse_hex_string(&args.data).unwrap_or_else(|_| args.data.as_bytes().to_vec())
    } else {
        let mut text = args.data.clone();
        match args.append_line_ending.as_str() {
            "\\r\\n" => text.push_str("\r\n"),
            "\\r" => text.push('\r'),
            "\\n" => text.push('\n'),
            _ => {}
        }
        text.into_bytes()
    };
    if let Ok(mut log_mgr) = state.log_manager.lock() {
        let _ = log_mgr.write(&args.port_id, &timestamp, "TX", &log_data);
    }
    Ok(n)
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
    let data = std::fs::read(&args.path)
        .map_err(|e| CommandError::Io(format!("Failed to read file '{}': {}", args.path, e)))?;
    let total = data.len();
    if total == 0 {
        return Ok(0);
    }
    let chunk_size = args.chunk_size.max(1);
    let mut sent = 0usize;
    for (chunk_index, chunk) in data.chunks(chunk_size).enumerate() {
        // 锁作用域仅限写入本身，释放后再 await（sleep）
        {
            let manager = state
                .serial_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            manager
                .write_raw(&args.port_id, chunk)
                .map_err(|e| CommandError::Serial(e.to_string()))?;
        }
        // 记录 TX 元信息（仅 chunk 序号与长度，不记录二进制内容本身）。
        // log_manager 锁在下方 await（sleep）之前释放，不跨 await 持有 MutexGuard。
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
        }
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
    Ok(sent)
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
            &args.data_bits.to_string(),
            &args.parity,
            &args.stop_bits,
            &args.handshake,
        )
        .map_err(|e| CommandError::Serial(e.to_string()))
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
    manager
        .attempt_reconnect(&port_id)
        .map_err(|e| CommandError::Serial(e.to_string()))
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
        .map_err(|e| CommandError::Serial(e.to_string()))
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
    // 1. 获取上次连接参数 + 关闭串口（一次锁完成）
    let last_params = {
        let mut mgr = state
            .serial_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let params = mgr.get_last_params(&args.port_id);
        let join_handle = mgr
            .close_port(&args.port_id)
            .map_err(|e| CommandError::Serial(e.to_string()))?;
        // 在锁内 join：close_port 已取出 JoinHandle，读线程最长 100ms 退出。
        // 此处持锁 join 可接受——工具执行期间不会有其他串口命令并发。
        if let Some(t) = join_handle {
            let _ = t.join();
        }
        params
    };

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

    let tx_out = tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx_out.send(("stdout".to_string(), line)).await.is_err() {
                break;
            }
        }
    });

    let tx_err = tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx_err.send(("stderr".to_string(), line)).await.is_err() {
                break;
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
            // 重开失败不视为命令错误——工具已成功执行，端口状态由前端处理
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
