/**
 * 串口事件 (Serial Events)
 * 推送给前端的事件载荷与派发助手，另附 RX 数据落盘（日志管理器）。
 *
 * 事件名与字段名是前后端线上契约（`serial:data` / `serial:status` /
 * `serial:reconnect_hint`），改动必须同步前端。
 */
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 串口数据事件（推送给前端）
#[derive(Debug, Clone, Serialize)]
pub struct SerialDataEvent {
    pub port_id: String,
    pub timestamp: i64,
    /// 恒为 "RX"：后端只在接收侧派发数据事件，发送回显由前端按自己的发送记录合成。
    pub direction: String,
    pub data: Vec<u8>,
    /// 恒为 false：后端一律派发原始字节，HEX 展示由前端决定。
    pub is_hex: bool,
}

/// 串口状态变化事件（推送给前端）
#[derive(Debug, Clone, Serialize)]
pub struct SerialStatusEvent {
    pub port_id: String,
    pub status: String,
}

/// 串口自动重连提示事件（推送给前端）
#[derive(Debug, Clone, Serialize)]
pub struct SerialReconnectHintEvent {
    pub port_name: String,
}

/// `SerialStatusEvent.status` 的取值集合——用枚举收口，避免同一状态字符串
/// 在「开/关/读线程异常退出」多条路径里各写一遍而拼错（拼错只会表现为前端
/// 状态不更新，没有任何报错）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PortStatus {
    Connected,
    Disconnected,
    Error,
}

impl PortStatus {
    fn as_str(self) -> &'static str {
        match self {
            PortStatus::Connected => "connected",
            PortStatus::Disconnected => "disconnected",
            PortStatus::Error => "error",
        }
    }
}

/// 派发串口状态事件（前端据此更新端口状态）。
pub(crate) fn emit_status(app_handle: &AppHandle, port_id: &str, status: PortStatus) {
    let _ = app_handle.emit(
        "serial:status",
        SerialStatusEvent {
            port_id: port_id.to_string(),
            status: status.as_str().to_string(),
        },
    );
}

/// 派发 RX 数据事件：推送给前端 + 写接收日志。
///
/// 方向恒为 RX、字节恒为原始字节——这两点由「接收路径」本身决定，因此不再作为
/// 参数传入（旧签名里的 `direction` / `is_hex` 在所有调用点都是常量，等于把常量
/// 抄了四遍，还让人以为存在 TX 事件通道）。TX 字节由发送命令在写入成功后记录
/// （`TxOutcome::bytes` 是唯一来源）。
pub(crate) fn emit_rx_event(app_handle: &AppHandle, port_id: &str, data: &[u8]) {
    // 只取一次当前时间：格式化字符串与毫秒时间戳同源，避免两次 now() 跨毫秒不一致。
    let now = chrono::Local::now();
    let timestamp_str = now.format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    let timestamp_ms = now.timestamp_millis();
    let _ = app_handle.emit(
        "serial:data",
        SerialDataEvent {
            port_id: port_id.to_string(),
            timestamp: timestamp_ms,
            direction: "RX".to_string(),
            data: data.to_vec(),
            is_hex: false,
        },
    );
    // 日志落盘走 write_rx：字节级行聚合，完整行才落盘，跨事件的响应不再被切成碎片行。
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        if let Err(e) = state.log_manager.write_rx(port_id, &timestamp_str, data) {
            log::warn!("Failed to write RX log for {}: {}", port_id, e);
        }
    }
}

/// 派发自动重连提示（读线程**异常**退出时一次；正常关闭不发，避免噪音）。
pub(crate) fn emit_reconnect_hint(app_handle: &AppHandle, port_id: &str) {
    let _ = app_handle.emit(
        "serial:reconnect_hint",
        SerialReconnectHintEvent {
            port_name: port_id.to_string(),
        },
    );
}
