use tauri::{AppHandle, Runtime, State};
use crate::models::*;
use crate::serial::{SerialManager, parse_hex_string};

/// 列出可用串口
#[tauri::command]
pub fn list_ports() -> Result<Vec<PortInfo>, String> {
    SerialManager::list_ports()
}

/// 打开串口
#[tauri::command]
pub fn open_port<R: Runtime>(
    app_handle: AppHandle<R>,
    manager: State<'_, SerialManager>,
    config: SerialConfig,
) -> Result<(), String> {
    manager.open(config.clone())?;
    
    // 启动读取任务
    manager.start_read_task(app_handle);
    
    // 发送状态变化事件
    let _ = app_handle.emit("serial:status-changed", &SerialStatus::Open);
    
    Ok(())
}

/// 关闭串口
#[tauri::command]
pub fn close_port<R: Runtime>(
    app_handle: AppHandle<R>,
    manager: State<'_, SerialManager>,
) -> Result<(), String> {
    manager.close()?;
    
    // 发送状态变化事件
    let _ = app_handle.emit("serial:status-changed", &SerialStatus::Closed);
    
    Ok(())
}

/// 发送数据
#[tauri::command]
pub fn send_data(
    manager: State<'_, SerialManager>,
    data: String,
    format: String,
) -> Result<(), String> {
    let bytes = match format.as_str() {
        "hex" => parse_hex_string(&data)?,
        "ascii" => data.into_bytes(),
        _ => return Err("不支持的格式".to_string()),
    };

    manager.send(&bytes)
}

/// 获取串口状态
#[tauri::command]
pub fn get_status(
    manager: State<'_, SerialManager>,
) -> Result<SerialStatus, String> {
    Ok(manager.status())
}
