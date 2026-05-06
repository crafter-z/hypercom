/**
 * 串口管理模块 (Serial Manager)
 * 负责串口的枚举、打开/关闭、参数配置、数据收发
 * 使用 serialport-rs 库实现跨平台串口通信
 * 
 * 架构设计:
 * - SerialManager: 管理所有已打开串口的集合
 * - SerialPortHandle: 单个串口的句柄，包含读写线程
 * - 数据接收通过 MPSC channel 异步推送给前端
 */

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};

use crate::commands::OpenPortArgs;

/// 串口信息（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub id: String,
    pub name: String,
    pub port_type: String, // "real" | "virtual"
}

/// 单个串口连接句柄
pub struct SerialPortHandle {
    /// 串口名称
    pub port_name: String,
    /// 波特率
    pub baud_rate: u32,
    /// 底层串口对象（通过 Mutex 保证线程安全）
    pub port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    /// 数据接收通道发送端（用于向前端推送数据）
    pub tx_channel: mpsc::Sender<SerialDataEvent>,
    /// 读取线程句柄
    pub read_thread: Option<thread::JoinHandle<()>>,
    /// 连接状态
    pub is_connected: bool,
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

/// 串口管理器
pub struct SerialManager {
    /// 已打开的串口集合
    ports: HashMap<String, SerialPortHandle>,
    /// 全局数据接收通道（前端通过事件监听）
    pub event_sender: Option<mpsc::Sender<SerialDataEvent>>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            ports: HashMap::new(),
            event_sender: None,
        }
    }

    /// 枚举系统可用串口
    /// TODO: 区分虚拟串口与真实串口
    pub fn list_ports(&self) -> anyhow::Result<Vec<PortInfo>> {
        let ports = serialport::available_ports()?;
        let result = ports.into_iter().map(|p| PortInfo {
            id: p.port_name.clone(),
            name: p.port_name,
            port_type: match p.port_type {
                serialport::SerialPortType::UsbPort(_) => "real".to_string(),
                serialport::SerialPortType::PciPort => "real".to_string(),
                serialport::SerialPortType::BluetoothPort => "real".to_string(),
                serialport::SerialPortType::Unknown => "virtual".to_string(),
            },
        }).collect();
        Ok(result)
    }

    /// 打开指定串口
    /// TODO: 解析参数中的 data_bits/parity/stop_bits/handshake
    pub fn open_port(&mut self, args: OpenPortArgs) -> anyhow::Result<()> {
        let port = serialport::new(&args.port_id, args.baud_rate)
            .timeout(std::time::Duration::from_millis(100))
            .open()?;

        let (tx, _rx) = mpsc::channel::<SerialDataEvent>();
        let port_arc = Arc::new(Mutex::new(port));

        // 启动读取线程
        let port_clone = Arc::clone(&port_arc);
        let port_id = args.port_id.clone();
        let tx_clone = tx.clone();

        let read_thread = thread::spawn(move || {
            let mut buffer = [0u8; 1024];
            loop {
                match port_clone.lock() {
                    Ok(mut p) => match p.read(&mut buffer) {
                        Ok(n) if n > 0 => {
                            let event = SerialDataEvent {
                                port_id: port_id.clone(),
                                timestamp: chrono::Local::now().timestamp_millis(),
                                direction: "RX".to_string(),
                                data: buffer[..n].to_vec(),
                                is_hex: false,
                            };
                            let _ = tx_clone.send(event);
                        }
                        Ok(_) => {}
                        Err(e) => {
                            log::warn!("Serial read error: {}", e);
                            break;
                        }
                    },
                    Err(e) => {
                        log::error!("Serial port lock error: {}", e);
                        break;
                    }
                }
                // 50ms 节流，避免CPU占用过高
                thread::sleep(std::time::Duration::from_millis(50));
            }
        });

        let handle = SerialPortHandle {
            port_name: args.port_id.clone(),
            baud_rate: args.baud_rate,
            port: port_arc,
            tx_channel: tx,
            read_thread: Some(read_thread),
            is_connected: true,
        };

        let port_id_clone = args.port_id.clone();
        self.ports.insert(args.port_id, handle);
        log::info!("Serial port opened: {}", port_id_clone);
        Ok(())
    }

    /// 关闭指定串口
    pub fn close_port(&mut self, port_id: &str) -> anyhow::Result<()> {
        if let Some(mut handle) = self.ports.remove(port_id) {
            handle.is_connected = false;
            // 等待读取线程结束
            if let Some(thread) = handle.read_thread.take() {
                let _ = thread.join();
            }
            log::info!("Serial port closed: {}", port_id);
        }
        Ok(())
    }

    /// 向串口发送数据
    /// TODO: 支持 HEX 格式解析、追加换行符
    pub fn send_data(&self, port_id: &str, data: &str, is_hex: bool, append_line_ending: &str) -> anyhow::Result<usize> {
        let handle = self.ports.get(port_id)
            .ok_or_else(|| anyhow::anyhow!("Port not found: {}", port_id))?;

        let bytes = if is_hex {
            // TODO: 解析 HEX 字符串为字节数组
            data.as_bytes().to_vec()
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

    /// 修改波特率
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
