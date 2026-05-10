/**
 * Tauri 命令层 (Command Layer)
 * 所有前端通过 invoke 调用的 Rust 函数均定义于此
 * 每个命令函数负责参数校验、调用对应 Manager、返回结果
 */

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

// ==================== 串口相关命令 ====================

/// 获取系统可用串口列表
/// 前端调用: invoke('list_available_ports')
#[tauri::command]
pub fn list_available_ports(state: State<AppState>) -> Result<Vec<serial::PortInfo>, String> {
    let manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.list_ports().map_err(|e| e.to_string())
}

/// 打开指定串口
/// 前端调用: invoke('open_serial_port', { portId, baudRate, dataBits, parity, stopBits, ... })
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
pub fn open_serial_port(args: OpenPortArgs, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.open_port(args).map_err(|e| e.to_string())
}

/// 关闭指定串口
#[tauri::command]
pub fn close_serial_port(port_id: String, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.close_port(&port_id).map_err(|e| e.to_string())
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
pub fn send_serial_data(args: SendDataArgs, state: State<AppState>) -> Result<usize, String> {
    let manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.send_data(&args.port_id, &args.data, args.is_hex, &args.append_line_ending)
        .map_err(|e| e.to_string())
}

/// 设置串口参数（波特率、数据位等）
#[tauri::command]
pub fn set_serial_params(port_id: String, baud_rate: u32, state: State<AppState>) -> Result<(), String> {
    let manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.set_baud_rate(&port_id, baud_rate).map_err(|e| e.to_string())
}

/// 设置流控（DTR/RTS/握手协议）
#[tauri::command]
pub fn set_flow_control(port_id: String, dtr: bool, rts: bool, state: State<AppState>) -> Result<(), String> {
    let manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.set_flow_control(&port_id, dtr, rts).map_err(|e| e.to_string())
}

// ==================== 配置相关命令 ====================

/// 获取当前应用配置
#[tauri::command]
pub fn get_config(state: State<AppState>) -> Result<config::AppConfig, String> {
    let manager = state.config_manager.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_config().clone())
}

/// 更新应用配置
#[tauri::command]
pub fn set_config(new_config: config::AppConfig, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.config_manager.lock().map_err(|e| e.to_string())?;
    manager.set_config(new_config).map_err(|e| e.to_string())
}

/// 重置配置为默认值
#[tauri::command]
pub fn reset_config(state: State<AppState>) -> Result<config::AppConfig, String> {
    let mut manager = state.config_manager.lock().map_err(|e| e.to_string())?;
    manager.reset_to_default().map_err(|e| e.to_string())
}

// ==================== 日志相关命令 ====================

/// 设置日志存储目录
#[tauri::command]
pub fn set_log_directory(path: String, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.set_directory(path).map_err(|e| e.to_string())
}

/// 手动另存当前日志
#[tauri::command]
pub fn save_log_as(port_id: String, path: String, state: State<AppState>) -> Result<(), String> {
    let manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.save_log_as(&port_id, &path).map_err(|e| e.to_string())
}

/// 获取日志文件列表
#[tauri::command]
pub fn get_log_files(state: State<AppState>) -> Result<Vec<logger::LogFileInfo>, String> {
    let manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.list_files().map_err(|e| e.to_string())
}

/// 开始记录日志
#[tauri::command]
pub fn start_logging(port_id: String, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.create_writer(&port_id, "string").map_err(|e| e.to_string())
}

/// 停止记录日志
#[tauri::command]
pub fn stop_logging(port_id: String, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.close_writer(&port_id).map_err(|e| e.to_string())
}

// ==================== 系统相关命令 ====================

/// 获取系统状态（内存、CPU）
#[derive(Debug, Serialize)]
pub struct SystemStatus {
    pub status: String,
    pub memory_used_mb: u64,
    pub memory_limit_mb: u64,
    pub cpu_usage: f32,
}

#[tauri::command]
pub fn get_system_status() -> SystemStatus {
    // TODO: 实现系统资源监控
    SystemStatus {
        status: "运行正常".to_string(),
        memory_used_mb: 0,
        memory_limit_mb: 1024,
        cpu_usage: 0.0,
    }
}

/// 设置防止系统息屏
#[tauri::command]
pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
    // TODO: 调用系统API实现
    log::info!("Prevent screen off: {}", enable);
    Ok(())
}

/// 设置防止系统休眠
#[tauri::command]
pub fn prevent_sleep(enable: bool) -> Result<(), String> {
    // TODO: 调用系统API实现
    log::info!("Prevent sleep: {}", enable);
    Ok(())
}

// ==================== 模块引用 ====================

use crate::{config, logger, serial};
