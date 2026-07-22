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
use std::time::{Duration, Instant};

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

/// 串口自动重连提示事件（推送给前端）
#[derive(Debug, Clone, Serialize)]
pub struct SerialReconnectHintEvent {
    pub port_name: String,
}

/// 串口引脚状态事件（推送给前端）
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct SerialPinStatesEvent {
    pub port_id: String,
    pub dtr: bool,
    pub rts: bool,
    pub cts: bool,
    pub dsr: bool,
    pub rlsd: bool,
    pub ri: bool,
}

// ==================== 真实串口 ====================

/// 单个串口连接句柄
pub struct SerialPortHandle {
    pub port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    pub running: Arc<AtomicBool>,
    pub read_thread: Option<thread::JoinHandle<()>>,
    /// 当前 DTR 引脚状态。与读取线程共享；set_flow_control 写入端口后同步更新，
    /// 避免 pin_states 事件报告连接时的快照值。
    pub dtr_state: Arc<AtomicBool>,
    /// 当前 RTS 引脚状态。与读取线程共享；set_flow_control 写入端口后同步更新。
    pub rts_state: Arc<AtomicBool>,
}

// ==================== 模拟串口 ====================

/// 模拟串口内部消息
enum SimMessage {
    Echo { data: String, is_hex: bool },
    Stop,
}

/// 模拟串口连接句柄
pub struct SimPortHandle {
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
        return Err(anyhow::anyhow!(
            "HEX string has odd length: {} chars",
            cleaned.len()
        ));
    }
    let mut result = Vec::with_capacity(cleaned.len() / 2);
    let chars: Vec<char> = cleaned.chars().collect();
    let mut i = 0;
    while i + 1 < chars.len() {
        let hex_pair: String = chars[i..i + 2].iter().collect();
        match u8::from_str_radix(&hex_pair, 16) {
            Ok(byte) => result.push(byte),
            Err(_) => {
                return Err(anyhow::anyhow!(
                    "Invalid HEX byte at position {}: \"{}\"",
                    i,
                    hex_pair
                ))
            }
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

// ==================== 数据事件辅助函数 ====================

/// Emit a serial data event to the frontend and write to the log file.
/// Called from spawned threads (real port reader, sim port echo, sim port heartbeat).
fn emit_data_event(
    app_handle: &tauri::AppHandle,
    port_id: &str,
    direction: &str,
    data: &[u8],
    is_hex: bool,
) {
    let timestamp_str = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
    let event = SerialDataEvent {
        port_id: port_id.to_string(),
        timestamp: chrono::Local::now().timestamp_millis(),
        direction: direction.to_string(),
        data: data.to_vec(),
        is_hex,
    };
    let _ = app_handle.emit("serial:data", event);
    // Write to log if a writer exists
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        if let Ok(mut log_mgr) = state.log_manager.lock() {
            let _ = log_mgr.write(port_id, &timestamp_str, direction, data);
        }
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
    /// 上次成功连接的参数，用于自动重连
    last_params: HashMap<String, OpenPortArgs>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            ports: HashMap::new(),
            sim_ports: HashMap::new(),
            simulate: false,
            app_handle: None,
            last_params: HashMap::new(),
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
        let app_handle = self
            .app_handle
            .as_ref()
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
        // DTR/RTS 当前状态：从打开参数初始化，后续由 set_flow_control 更新
        let dtr_state = Arc::new(AtomicBool::new(args.dtr));
        let rts_state = Arc::new(AtomicBool::new(args.rts));

        // 设置 DTR/RTS
        {
            let mut p = port_arc
                .lock()
                .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
            p.write_data_terminal_ready(args.dtr)
                .map_err(|e| anyhow::anyhow!("Failed to set DTR: {}", e))?;
            p.write_request_to_send(args.rts)
                .map_err(|e| anyhow::anyhow!("Failed to set RTS: {}", e))?;
        }

        let port_clone = Arc::clone(&port_arc);
        let running_clone = Arc::clone(&running);
        let thread_port_id = args.port_id.clone();
        let thread_dtr = Arc::clone(&dtr_state);
        let thread_rts = Arc::clone(&rts_state);
        let app_handle_clone = app_handle.clone();

        let read_thread = thread::spawn(move || {
            // 读取循环单次读取的结果分类：把"读到数据" / "读超时" / "真实错误"分离，
            // 以便在释放端口锁之后再派发事件，且超时路径不再跳过引脚轮询。
            enum ReadOutcome {
                Data(usize),
                Timeout,
                Error(std::io::Error),
            }

            let port_id = thread_port_id;
            let mut buffer = [0u8; 1024];
            let mut abnormal = false;
            let mut last_pin_check = Instant::now();
            let mut last_pin_states: Option<SerialPinStatesEvent> = None;

            while running_clone.load(Ordering::Relaxed) {
                // 仅在 read() 调用期间持有端口锁，读完立即释放。
                // emit_data_event 会派发 Tauri 事件并同步写日志落盘，不能在持锁期间执行，
                // 否则会阻塞 send_data / 引脚读取 / 流控设置，高波特率下还可能撑爆 OS 接收缓冲区。
                let outcome = match port_clone.lock() {
                    Ok(mut p) => match p.read(&mut buffer) {
                        Ok(n) => ReadOutcome::Data(n),
                        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => ReadOutcome::Timeout,
                        Err(e) => ReadOutcome::Error(e),
                    },
                    Err(e) => {
                        log::error!("Serial port lock error: {}", e);
                        abnormal = true;
                        break;
                    }
                };
                // 端口 MutexGuard 在此处已释放

                match outcome {
                    ReadOutcome::Data(n) if n > 0 => {
                        emit_data_event(&app_handle_clone, &port_id, "RX", &buffer[..n], false);
                    }
                    // 无数据或读超时（100ms 超时下的正常空闲态）：不 continue，
                    // 落到下方引脚状态轮询，保证空闲连接上 pin 事件持续触发。
                    ReadOutcome::Data(_) | ReadOutcome::Timeout => {}
                    ReadOutcome::Error(e) => {
                        log::warn!("Serial read error on {}: {}", port_id, e);
                        let status_event = SerialStatusEvent {
                            port_id: port_id.clone(),
                            status: "error".to_string(),
                        };
                        let _ = app_handle_clone.emit("serial:status", status_event);
                        abnormal = true;
                        break;
                    }
                }

                // 每 200ms 轮询一次引脚状态，仅在状态变化时推送。
                // DTR/RTS 是输出引脚，serialport-rs 未暴露读回 API，因此读取
                // 与句柄共享的 AtomicBool（set_flow_control 写端口时会同步更新），
                // 而非连接时的参数快照。
                if last_pin_check.elapsed() >= Duration::from_millis(200) {
                    if let Ok(mut p) = port_clone.lock() {
                        let current = SerialPinStatesEvent {
                            port_id: port_id.clone(),
                            dtr: thread_dtr.load(Ordering::Relaxed),
                            rts: thread_rts.load(Ordering::Relaxed),
                            cts: p.read_clear_to_send().unwrap_or(false),
                            dsr: p.read_data_set_ready().unwrap_or(false),
                            rlsd: p.read_carrier_detect().unwrap_or(false),
                            ri: p.read_ring_indicator().unwrap_or(false),
                        };
                        if last_pin_states.as_ref() != Some(&current) {
                            let _ = app_handle_clone.emit("serial:pin_states", current.clone());
                            last_pin_states = Some(current);
                        }
                    }
                    last_pin_check = Instant::now();
                }
            }

            // 读取线程退出时发送断开事件
            let status_event = SerialStatusEvent {
                port_id: port_id.clone(),
                status: "disconnected".to_string(),
            };
            let _ = app_handle_clone.emit("serial:status", status_event);

            // 异常退出时发送一次重连提示，避免每次轮询都产生噪音
            if abnormal {
                let hint = SerialReconnectHintEvent {
                    port_name: port_id,
                };
                let _ = app_handle_clone.emit("serial:reconnect_hint", hint);
            }
        });

        let handle = SerialPortHandle {
            port: port_arc,
            running,
            read_thread: Some(read_thread),
            dtr_state,
            rts_state,
        };

        // 记录连接参数，用于自动重连
        self.last_params.insert(args.port_id.clone(), args.clone());

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
        let app_handle = self
            .app_handle
            .as_ref()
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
                        emit_data_event(
                            &app_handle_clone,
                            &port_id,
                            "RX",
                            echo_data.as_bytes(),
                            false,
                        );
                    }
                    Ok(SimMessage::Stop) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // 每 500ms 发送一次心跳
                        if last_heartbeat.elapsed() >= Duration::from_millis(500) {
                            let heartbeat = format!(
                                "[SIM] Heartbeat @ {}\r\n",
                                chrono::Local::now().format("%H:%M:%S")
                            );
                            emit_data_event(
                                &app_handle_clone,
                                &port_id,
                                "RX",
                                heartbeat.as_bytes(),
                                false,
                            );
                            last_heartbeat = std::time::Instant::now();
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        let handle = SimPortHandle {
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

    /// 关闭串口（真实或模拟）。
    /// 停止读取线程并返回其 JoinHandle（若有），由调用方在释放 serial_manager
    /// 锁之后 join——join 最长可阻塞约 100ms（读取超时），不能在持锁期间进行，
    /// 否则会卡住所有其他串口命令。
    pub fn close_port(&mut self, port_id: &str) -> anyhow::Result<Option<thread::JoinHandle<()>>> {
        let join_handle = if port_id.starts_with("SIM:") {
            if let Some(mut handle) = self.sim_ports.remove(port_id) {
                handle.running.store(false, Ordering::Relaxed);
                let _ = handle.tx.send(SimMessage::Stop);
                log::info!("Sim port closed: {}", port_id);
                handle.read_thread.take()
            } else {
                None
            }
        } else if let Some(mut handle) = self.ports.remove(port_id) {
            handle.running.store(false, Ordering::Relaxed);
            log::info!("Serial port closed: {}", port_id);
            handle.read_thread.take()
        } else {
            None
        };
        Ok(join_handle)
    }

    /// 尝试重新连接指定串口。
    /// 先关闭残留句柄，再校验系统端口列表中存在该端口，最后用上次成功的参数打开。
    pub fn attempt_reconnect(&mut self, port_id: &str) -> anyhow::Result<()> {
        if port_id.starts_with("SIM:") {
            return Err(anyhow::anyhow!("Cannot reconnect simulation port"));
        }

        // 关闭残留句柄（如果异常断线后仍被保留）
        if self.ports.contains_key(port_id) {
            self.close_port(port_id)?;
        }

        // 确认端口重新出现在系统列表中
        let available = self.list_ports()?;
        if !available.iter().any(|p| p.id == port_id) {
            return Err(anyhow::anyhow!("Port {} is not available", port_id));
        }

        let params = self
            .last_params
            .get(port_id)
            .ok_or_else(|| anyhow::anyhow!("No previous connection params for {}", port_id))?
            .clone();

        self.open_port(params)
    }

    /// 向串口发送数据
    pub fn send_data(
        &self,
        port_id: &str,
        data: &str,
        is_hex: bool,
        append_line_ending: &str,
    ) -> anyhow::Result<usize> {
        // 模拟串口：通过 channel 发送，由读取线程回显
        if port_id.starts_with("SIM:") {
            let handle = self
                .sim_ports
                .get(port_id)
                .ok_or_else(|| anyhow::anyhow!("Sim port not found: {}", port_id))?;
            handle
                .tx
                .send(SimMessage::Echo {
                    data: data.to_string(),
                    is_hex,
                })
                .map_err(|e| anyhow::anyhow!("Failed to send to sim port: {}", e))?;
            return Ok(data.len());
        }

        // 真实串口：写入串口
        let handle = self
            .ports
            .get(port_id)
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

        let mut port = handle
            .port
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        // write_all 循环写入直到全部发送，避免 write() 部分写入时静默丢失剩余字节
        port.write_all(&bytes)?;
        port.flush()?;

        log::debug!("Sent {} bytes to {}", bytes.len(), port_id);
        Ok(bytes.len())
    }

    /// 向串口写入原始字节（不做 HEX 解析、不附加行结束符）。用于文件发送。
    /// SIM 端口将字节序列转为 HEX 字符串回显，便于无硬件测试。
    pub fn write_raw(&self, port_id: &str, bytes: &[u8]) -> anyhow::Result<usize> {
        if port_id.starts_with("SIM:") {
            let handle = self
                .sim_ports
                .get(port_id)
                .ok_or_else(|| anyhow::anyhow!("Sim port not found: {}", port_id))?;
            let hex_str = bytes
                .iter()
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(" ");
            handle
                .tx
                .send(SimMessage::Echo {
                    data: hex_str,
                    is_hex: true,
                })
                .map_err(|e| anyhow::anyhow!("Failed to send to sim port: {}", e))?;
            return Ok(bytes.len());
        }

        let handle = self
            .ports
            .get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
        let mut port = handle
            .port
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        // write_all 循环写入直到全部发送，避免 write() 部分写入时静默丢失剩余字节
        port.write_all(bytes)?;
        port.flush()?;
        Ok(bytes.len())
    }

    /// 修改串口参数（完整）
    pub fn set_params(
        &mut self,
        port_id: &str,
        baud_rate: u32,
        data_bits: &str,
        parity: &str,
        stop_bits: &str,
        handshake: &str,
    ) -> anyhow::Result<()> {
        let handle = self
            .ports
            .get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
        let mut port = handle
            .port
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        port.set_baud_rate(baud_rate)?;
        // 无条件应用帧格式与流控：仅在非默认值时才设置会导致无法从
        // 7E1 / 硬件流控等配置改回 8N1 / None 默认值。
        port.set_data_bits(parse_data_bits(data_bits.parse().unwrap_or(8)))?;
        port.set_parity(parse_parity(parity))?;
        port.set_stop_bits(parse_stop_bits(stop_bits))?;
        port.set_flow_control(parse_flow_control(handshake))?;
        drop(port);

        // 同步更新重连参数缓存
        if let Some(params) = self.last_params.get_mut(port_id) {
            params.baud_rate = baud_rate;
            params.data_bits = data_bits.parse().unwrap_or(8);
            params.parity = parity.to_string();
            params.stop_bits = stop_bits.to_string();
            params.handshake = handshake.to_string();
        }

        log::info!(
            "Params set for {}: baud={}, data_bits={}, parity={}, stop_bits={}, handshake={}",
            port_id,
            baud_rate,
            data_bits,
            parity,
            stop_bits,
            handshake
        );
        Ok(())
    }

    /// 修改波特率（保留兼容）
    pub fn set_baud_rate(&self, port_id: &str, baud_rate: u32) -> anyhow::Result<()> {
        let handle = self
            .ports
            .get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
        let mut port = handle
            .port
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        port.set_baud_rate(baud_rate)?;
        log::info!("Baud rate set to {} for {}", baud_rate, port_id);
        Ok(())
    }

    /// 设置流控（DTR/RTS）
    pub fn set_flow_control(&self, port_id: &str, dtr: bool, rts: bool) -> anyhow::Result<()> {
        let handle = self
            .ports
            .get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;
        let mut port = handle
            .port
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        port.write_data_terminal_ready(dtr)?;
        port.write_request_to_send(rts)?;
        drop(port);
        // 同步更新共享状态，读取线程下一次 pin 轮询即报告新值
        handle.dtr_state.store(dtr, Ordering::Relaxed);
        handle.rts_state.store(rts, Ordering::Relaxed);
        Ok(())
    }
}
