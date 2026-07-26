use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use super::CommandError;
use crate::{serial, AppState};

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
