use serde::Deserialize;
use tauri::State;

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
#[derive(Debug, Deserialize)]
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
    let mut manager = state
        .serial_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .close_port(&port_id)
        .map_err(|e| CommandError::Serial(e.to_string()))
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
    let manager = state
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
