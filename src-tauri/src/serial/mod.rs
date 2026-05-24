/**
 * 串口管理模块 (Serial Manager)
 * 负责串口的枚举、打开/关闭、参数配置、数据收发
 * 使用 serialport-rs 库实现跨平台串口通信
 * 
 * 架构设计:
 * - SerialManager: 管理所有已打开串口的集合（真实 + 模拟）
 * - SerialPortHandle: 真实串口句柄，包含读取线程
 * - SimPortHandle: 模拟串口句柄，支持回显 + 心跳
 * - 数据接收通过 AppHandle.emit() 推送给前端
 * - 模拟模式: 用于无硬件时的测试，提供 LOOP:Loopback 虚拟串口
 */

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::OpenPortArgs;

// ==================== 公共类型 ====================

/// 串口信息（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub id: String,
    pub name: String,
    pub port_type: String, // "real" | "virtual"
}

/// 串口数据事件（推送给前端）
#[derive(Debug, Clone, Serialize)]
pub struct SerialDataEvent {
    pub port_id: String,
    pub timestamp: i64,
    pub direction: String, // "RX" | "TX"
    pub data: Vec<u8>,
    pub is_hex: bool,
}

/// 串口状态变化事件（推送给前端）
#[derive(Debug, Clone, Serialize)]
pub struct SerialStatusEvent {
    pub port_id: String,
    pub status: String,
}

// ==================== 真实串口 ====================

/// 单个串口连接句柄
pub struct SerialPortHandle {
    #[allow(dead_code)]
    pub port_name: String,
    #[allow(dead_code)]
    pub baud_rate: u32,
    pub port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    pub running: Arc<AtomicBool>,
    pub read_thread: Option<thread::JoinHandle<()>>,
}

// ==================== 模拟串口 ====================

/// 模拟串口内部消息
enum SimMessage {
    Echo { data: String, is_hex: bool },
    Stop,
}

/// 模拟串口连接句柄
pub struct SimPortHandle {
    #[allow(dead_code)]
    pub port_name: String,
    pub running: Arc<AtomicBool>,
    tx: mpsc::Sender<SimMessage>,
    read_thread: Option<thread::JoinHandle<()>>,
}

// ==================== 参数解析 ====================

/// 解析 HEX 字符串为字节数组。支持空格分隔（"48 65 6C"）或紧凑形式（"48656C"）。
/// 暴露为 pub 以便日志层在写入 TX 字节时复用。
pub fn parse_hex_string(data: &str) -> anyhow::Result<Vec<u8>> {
    let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.len() % 2 != 0 {
        return Err(anyhow::anyhow!("HEX string has odd length: {} chars", cleaned.len()));
    }
    let mut result = Vec::with_capacity(cleaned.len() / 2);
    let chars: Vec<char> = cleaned.chars().collect();
    let mut i = 0;
    while i + 1 < chars.len() {
        let hex_pair: String = chars[i..i + 2].iter().collect();
        match u8::from_str_radix(&hex_pair, 16) {
            Ok(byte) => result.push(byte),
            Err(_) => return Err(anyhow::anyhow!("Invalid HEX byte at position {}: \"{}\"", i, hex_pair)),
        }
        i += 2;
    }
    Ok(result)
}

fn parse_data_bits(bits: u8) -> serialport::DataBits {
    match bits {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    }
}

fn parse_parity(parity: &str) -> serialport::Parity {
    match parity {
        "Even" => serialport::Parity::Even,
        "Odd" => serialport::Parity::Odd,
        _ => serialport::Parity::None,
    }
}

fn parse_stop_bits(bits: &str) -> serialport::StopBits {
    match bits {
        "Two" => serialport::StopBits::Two,
        _ => serialport::StopBits::One,
    }
}

fn parse_flow_control(flow: &str) -> serialport::FlowControl {
    match flow {
        "XonXoff" => serialport::FlowControl::Software,
        "RequestToSend" | "RequestToSendXonXoff" => serialport::FlowControl::Hardware,
        _ => serialport::FlowControl::None,
    }
}

// ==================== 串口管理器 ====================

/// 串口管理器
pub struct SerialManager {
    /// 真实串口集合
    ports: HashMap<String, SerialPortHandle>,
    /// 模拟串口集合
    pub sim_ports: HashMap<String, SimPortHandle>,
    /// 是否启用模拟模式
    simulate: bool,
    /// Tauri AppHandle，用于事件推送
    app_handle: Option<AppHandle>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            ports: HashMap::new(),
            sim_ports: HashMap::new(),
            simulate: false,
            app_handle: None,
        }
    }

    /// 设置 AppHandle（在 Tauri setup 钩子中调用）
    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    /// 启用/禁用模拟模式
    pub fn set_simulate(&mut self, on: bool) {
        self.simulate = on;
    }

    /// 枚举系统可用串口
    pub fn list_ports(&self) -> anyhow::Result<Vec<PortInfo>> {
        let mut result: Vec<PortInfo> = serialport::available_ports()?
            .into_iter()
            .map(|p| PortInfo {
                id: p.port_name.clone(),
                name: p.port_name,
                port_type: match p.port_type {
                    serialport::SerialPortType::UsbPort(_) => "real".to_string(),
                    serialport::SerialPortType::PciPort => "real".to_string(),
                    serialport::SerialPortType::BluetoothPort => "real".to_string(),
                    serialport::SerialPortType::Unknown => "real".to_string(),
                },
            })
            .collect();

        if self.simulate {
            result.push(PortInfo {
                id: "SIM:Loopback".to_string(),
                name: "SIM:Loopback (模拟串口)".to_string(),
                port_type: "sim".to_string(),
            });
        }

        Ok(result)
    }

    /// 打开串口（自动判断真实/模拟）
    pub fn open_port(&mut self, args: OpenPortArgs) -> anyhow::Result<()> {
        if args.port_id.starts_with("SIM:") {
            self.open_sim_port(args)
        } else {
            self.open_real_port(args)
        }
    }

    /// 打开真实串口
    fn open_real_port(&mut self, args: OpenPortArgs) -> anyhow::Result<()> {
        let app_handle = self.app_handle.as_ref()
            .ok_or_else(|| anyhow::anyhow!("AppHandle not initialized"))?
            .clone();

        let port = serialport::new(&args.port_id, args.baud_rate)
            .data_bits(parse_data_bits(args.data_bits))
            .parity(parse_parity(&args.parity))
            .stop_bits(parse_stop_bits(&args.stop_bits))
            .flow_control(parse_flow_control(&args.handshake))
            .timeout(Duration::from_millis(100))
            .open()?;

        // 设置 DTR/RTS
        // Note: 需要在 Arc<Mutex> 包装之前设置，因为 write_data_terminal_ready 需要可变引用
        // 但 open() 返回的是 Box<dyn SerialPort>，我们无法直接设置
        // 这里先打开再设置

        let port_arc = Arc::new(Mutex::new(port));
        let running = Arc::new(AtomicBool::new(true));

        // 设置 DTR/RTS
        {
            let mut p = port_arc.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
            p.write_data_terminal_ready(args.dtr)
                .map_err(|e| anyhow::anyhow!("Failed to set DTR: {}", e))?;
            p.write_request_to_send(args.rts)
                .map_err(|e| anyhow::anyhow!("Failed to set RTS: {}", e))?;
        }

        let port_clone = Arc::clone(&port_arc);
        let running_clone = Arc::clone(&running);
        let port_id = args.port_id.clone();
        let app_handle_clone = app_handle.clone();

        let read_thread = thread::spawn(move || {
            let mut buffer = [0u8; 1024];
            while running_clone.load(Ordering::Relaxed) {
                match port_clone.lock() {
                    Ok(mut p) => match p.read(&mut buffer) {
                        Ok(n) if n > 0 => {
                            let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
                            let event = SerialDataEvent {
                                port_id: port_id.clone(),
                                timestamp: chrono::Local::now().timestamp_millis(),
                                direction: "RX".to_string(),
                                data: buffer[..n].to_vec(),
                                is_hex: false,
                            };
                            let _ = app_handle_clone.emit("serial:data", event);
                            // Write to log if a writer exists
                            if let Some(state) = app_handle_clone.try_state::<crate::AppState>() {
                                if let Ok(mut log_mgr) = state.log_manager.lock() {
                                    let _ = log_mgr.write(&port_id, &timestamp, "RX", &buffer[..n]);
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                            // Serial timeout - normal for read loop, continue
                            continue;
                        }
                        Err(e) => {
                            log::warn!("Serial read error on {}: {}", port_id, e);
                            let status_event = SerialStatusEvent {
                                port_id: port_id.clone(),
                                status: "error".to_string(),
                            };
                            let _ = app_handle_clone.emit("serial:status", status_event);
                            break;
                        }
                    },
                    Err(e) => {
                        log::error!("Serial port lock error: {}", e);
                        break;
                    }
                }
            }
            // 读取线程退出时发送断开事件
            let status_event = SerialStatusEvent {
                port_id,
                status: "disconnected".to_string(),
            };
            let _ = app_handle_clone.emit("serial:status", status_event);
        });

        let handle = SerialPortHandle {
            port_name: args.port_id.clone(),
            baud_rate: args.baud_rate,
            port: port_arc,
            running,
            read_thread: Some(read_thread),
        };

        // 发送连接成功事件
        let status_event = SerialStatusEvent {
            port_id: args.port_id.clone(),
            status: "connected".to_string(),
        };
        let _ = app_handle.emit("serial:status", status_event);

        let port_id = args.port_id.clone();
        self.ports.insert(args.port_id, handle);
        log::info!("Serial port opened: {}", port_id);
        Ok(())
    }

    /// 打开模拟串口
    fn open_sim_port(&mut self, args: OpenPortArgs) -> anyhow::Result<()> {
        let app_handle = self.app_handle.as_ref()
            .ok_or_else(|| anyhow::anyhow!("AppHandle not initialized"))?
            .clone();

        let (tx, rx) = mpsc::channel::<SimMessage>();
        let running = Arc::new(AtomicBool::new(true));
        let running_clone = Arc::clone(&running);
        let port_id = args.port_id.clone();
        let app_handle_clone = app_handle.clone();

        let read_thread = thread::spawn(move || {
            let mut last_heartbeat = std::time::Instant::now();
            loop {
                if !running_clone.load(Ordering::Relaxed) {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(SimMessage::Echo { data, is_hex }) => {
                        let echo_data = if is_hex {
                            format!("[HEX] Received: {}\r\n", data)
                        } else {
                            format!("Received: {}\r\n", data)
                        };
                        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
                        let event = SerialDataEvent {
                            port_id: port_id.clone(),
                            timestamp: chrono::Local::now().timestamp_millis(),
                            direction: "RX".to_string(),
                            data: echo_data.clone().into_bytes(),
                            is_hex: false,
                        };
                        let _ = app_handle_clone.emit("serial:data", event);
                        // Write to log if a writer exists
                        if let Some(state) = app_handle_clone.try_state::<crate::AppState>() {
                            if let Ok(mut log_mgr) = state.log_manager.lock() {
                                let _ = log_mgr.write(&port_id, &timestamp, "RX", echo_data.as_bytes());
                            }
                        }
                    }
                    Ok(SimMessage::Stop) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // 每 500ms 发送一次心跳
                        if last_heartbeat.elapsed() >= Duration::from_millis(500) {
                            let heartbeat = format!(
                                "[SIM] Heartbeat @ {}\r\n",
                                chrono::Local::now().format("%H:%M:%S")
                            );
                            let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
                            let event = SerialDataEvent {
                                port_id: port_id.clone(),
                                timestamp: chrono::Local::now().timestamp_millis(),
                                direction: "RX".to_string(),
                                data: heartbeat.clone().into_bytes(),
                                is_hex: false,
                            };
                            let _ = app_handle_clone.emit("serial:data", event);
                            // Write heartbeat to log if a writer exists
                            if let Some(state) = app_handle_clone.try_state::<crate::AppState>() {
                                if let Ok(mut log_mgr) = state.log_manager.lock() {
                                    let _ = log_mgr.write(&port_id, &timestamp, "RX", heartbeat.as_bytes());
                                }
                            }
                            last_heartbeat = std::time::Instant::now();
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        let handle = SimPortHandle {
            port_name: args.port_id.clone(),
            running,
            tx,
            read_thread: Some(read_thread),
        };

        // 发送连接成功事件
        let status_event = SerialStatusEvent {
            port_id: args.port_id.clone(),
            status: "connected".to_string(),
        };
        let _ = app_handle.emit("serial:status", status_event);

        self.sim_ports.insert(args.port_id, handle);
        log::info!("Sim port opened: SIM:Loopback");
        Ok(())
    }

    /// 关闭串口（真实或模拟）
    pub fn close_port(&mut self, port_id: &str) -> anyhow::Result<()> {
        if port_id.starts_with("SIM:") {
            if let Some(mut handle) = self.sim_ports.remove(port_id) {
                handle.running.store(false, Ordering::Relaxed);
                let _ = handle.tx.send(SimMessage::Stop);
                if let Some(thread) = handle.read_thread.take() {
                    let _ = thread.join();
                }
                log::info!("Sim port closed: {}", port_id);
            }
        } else {
            if let Some(mut handle) = self.ports.remove(port_id) {
                handle.running.store(false, Ordering::Relaxed);
                if let Some(thread) = handle.read_thread.take() {
                    let _ = thread.join();
                }
                log::info!("Serial port closed: {}", port_id);
            }
        }
        Ok(())
    }

    /// 向串口发送数据
    pub fn send_data(&self, port_id: &str, data: &str, is_hex: bool, append_line_ending: &str) -> anyhow::Result<usize> {
        // 模拟串口：通过 channel 发送，由读取线程回显
        if port_id.starts_with("SIM:") {
            let handle = self.sim_ports.get(port_id)
                .ok_or_else(|| anyhow::anyhow!("Sim port not found: {}", port_id))?;
            handle.tx.send(SimMessage::Echo {
                data: data.to_string(),
                is_hex,
            }).map_err(|e| anyhow::anyhow!("Failed to send to sim port: {}", e))?;
            return Ok(data.len());
        }

        // 真实串口：写入串口
        let handle = self.ports.get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;

        let bytes = if is_hex {
            parse_hex_string(data)?
        } else {
            let mut text = data.to_string();
            match append_line_ending {
                "\\r\\n" => text.push_str("\r\n"),
                "\\r" => text.push('\r'),
                "\\n" => text.push('\n'),
                _ => {}
            }
            text.into_bytes()
        };

        let mut port = handle.port.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        let n = port.write(&bytes)?;
        port.flush()?;

        log::debug!("Sent {} bytes to {}", n, port_id);
        Ok(n)
    }

    /// 修改串口参数（完整）
    pub fn set_params(&self, port_id: &str, baud_rate: u32, data_bits: &str, parity: &str, stop_bits: &str, handshake: &str) -> anyhow::Result<()> {
        let handle = self.ports.get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
        let mut port = handle.port.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        port.set_baud_rate(baud_rate)?;
        if data_bits != "8" || parity != "None" || stop_bits != "One" {
            port.set_data_bits(parse_data_bits(data_bits.parse().unwrap_or(8)))?;
            port.set_parity(parse_parity(parity))?;
            port.set_stop_bits(parse_stop_bits(stop_bits))?;
        }
        if handshake != "None" {
            port.set_flow_control(parse_flow_control(handshake))?;
        }
        log::info!("Params set for {}: baud={}, data_bits={}, parity={}, stop_bits={}, handshake={}", port_id, baud_rate, data_bits, parity, stop_bits, handshake);
        Ok(())
    }

    /// 修改波特率（保留兼容）
    pub fn set_baud_rate(&self, port_id: &str, baud_rate: u32) -> anyhow::Result<()> {
        let handle = self.ports.get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
        let mut port = handle.port.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        port.set_baud_rate(baud_rate)?;
        log::info!("Baud rate set to {} for {}", baud_rate, port_id);
        Ok(())
    }

    /// 设置流控（DTR/RTS）
    pub fn set_flow_control(&self, port_id: &str, dtr: bool, rts: bool) -> anyhow::Result<()> {
        let handle = self.ports.get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
        let mut port = handle.port.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        port.write_data_terminal_ready(dtr)?;
        port.write_request_to_send(rts)?;
        Ok(())
    }

    /// 获取已连接串口的流量统计
    pub fn get_traffic_stats(&self, _port_id: &str) -> anyhow::Result<(u64, u64)> {
        // TODO: 实现 TX/RX 字节统计
        Ok((0, 0))
    }
}