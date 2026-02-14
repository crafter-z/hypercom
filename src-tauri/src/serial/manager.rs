use std::io::{Read, Write};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use parking_lot::Mutex;
use serialport::{SerialPort, SerialPortType};
use tauri::{AppHandle, Emitter, Runtime};

use crate::models::*;
use super::DataThrottler;

/// 串口管理器
pub struct SerialManager {
    /// 当前打开的串口
    port: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    /// 当前配置
    config: Arc<Mutex<Option<SerialConfig>>>,
    /// 接收任务句柄
    read_task: Arc<Mutex<Option<JoinHandle<()>>>>,
    /// 运行标志
    running: Arc<Mutex<bool>>,
}

impl SerialManager {
    /// 创建新的串口管理器
    pub fn new() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            config: Arc::new(Mutex::new(None)),
            read_task: Arc::new(Mutex::new(None)),
            running: Arc::new(Mutex::new(false)),
        }
    }

    /// 列出可用串口
    pub fn list_ports() -> Result<Vec<PortInfo>, String> {
        let ports = serialport::available_ports()
            .map_err(|e| format!("无法获取串口列表: {}", e))?;

        let port_infos: Vec<PortInfo> = ports
            .into_iter()
            .map(|p| {
                let (port_type, manufacturer, product) = match &p.port_type {
                    SerialPortType::UsbPort(info) => {
                        let manufacturer = info.manufacturer.clone();
                        let product = info.product.clone();
                        ("USB".to_string(), manufacturer, product)
                    }
                    SerialPortType::BluetoothPort => {
                        ("Bluetooth".to_string(), None, None)
                    }
                    SerialPortType::PciPort => {
                        ("PCI".to_string(), None, None)
                    }
                    SerialPortType::Unknown => {
                        ("Unknown".to_string(), None, None)
                    }
                };

                PortInfo {
                    name: p.port_name,
                    port_type,
                    manufacturer,
                    product,
                }
            })
            .collect();

        Ok(port_infos)
    }

    /// 打开串口
    pub fn open(&self, config: SerialConfig) -> Result<(), String> {
        let mut port_guard = self.port.lock();
        
        if port_guard.is_some() {
            return Err("串口已打开，请先关闭".to_string());
        }

        let port = serialport::new(&config.port_name, config.baud_rate)
            .data_bits(config.data_bits.clone().into())
            .stop_bits(config.stop_bits.clone().into())
            .parity(config.parity.clone().into())
            .flow_control(config.flow_control.clone().into())
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| format!("无法打开串口 {}: {}", config.port_name, e))?;

        *port_guard = Some(port);
        *self.config.lock() = Some(config);

        Ok(())
    }

    /// 关闭串口
    pub fn close(&self) -> Result<(), String> {
        // 设置停止标志
        *self.running.lock() = false;

        // 等待读取线程结束
        if let Some(handle) = self.read_task.lock().take() {
            let _ = handle.join();
        }

        // 关闭串口
        let mut port_guard = self.port.lock();
        if port_guard.is_none() {
            return Err("串口未打开".to_string());
        }

        *port_guard = None;
        *self.config.lock() = None;

        Ok(())
    }

    /// 发送数据
    pub fn send(&self, data: &[u8]) -> Result<(), String> {
        let mut port_guard = self.port.lock();
        
        let port = port_guard
            .as_mut()
            .ok_or("串口未打开")?;

        port.write_all(data)
            .map_err(|e| format!("发送数据失败: {}", e))?;

        port.flush()
            .map_err(|e| format!("刷新缓冲区失败: {}", e))?;

        Ok(())
    }

    /// 获取状态
    pub fn status(&self) -> SerialStatus {
        let port_guard = self.port.lock();
        if port_guard.is_some() {
            SerialStatus::Open
        } else {
            SerialStatus::Closed
        }
    }

    /// 启动读取任务
    pub fn start_read_task<R: Runtime>(&self, app_handle: AppHandle<R>) {
        // 设置运行标志
        *self.running.lock() = true;
        
        let port = Arc::clone(&self.port);
        let running = Arc::clone(&self.running);

        let handle = thread::spawn(move || {
            let mut throttler = DataThrottler::new(50);
            let mut buffer = [0u8; 4096];

            loop {
                // 检查是否应该停止
                if !*running.lock() {
                    break;
                }

                let mut port_guard = port.lock();
                if let Some(ref mut port) = *port_guard {
                    // 尝试读取数据
                    match port.read(&mut buffer) {
                        Ok(n) if n > 0 => {
                            let data = &buffer[..n];
                            
                            // 使用节流器处理数据
                            if let Some(throttled_data) = throttler.push(data) {
                                // 转换为十六进制字符串
                                let hex_string = throttled_data
                                    .iter()
                                    .map(|b| format!("{:02X}", b))
                                    .collect::<Vec<_>>()
                                    .join(" ");

                                let packet = DataPacket {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    data: hex_string,
                                    timestamp: chrono::Utc::now().timestamp_millis(),
                                    direction: DataDirection::Rx,
                                    format: DataFormat::Hex,
                                };

                                // 发送事件到前端
                                let _ = app_handle.emit("serial:data-received", &packet);
                            }
                        }
                        _ => {
                            // 超时或无数据，继续
                        }
                    }
                } else {
                    // 串口已关闭，退出任务
                    break;
                }
                
                // 释放锁后短暂休眠
                drop(port_guard);
                thread::sleep(Duration::from_millis(10));
            }
        });

        *self.read_task.lock() = Some(handle);
    }
}

impl Default for SerialManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 解析十六进制字符串为字节数组
pub fn parse_hex_string(hex: &str) -> Result<Vec<u8>, String> {
    let clean_hex: String = hex.chars()
        .filter(|c| !c.is_whitespace())
        .collect();

    if clean_hex.len() % 2 != 0 {
        return Err("十六进制字符串长度必须为偶数".to_string());
    }

    (0..clean_hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&clean_hex[i..i + 2], 16)
                .map_err(|e| format!("无效的十六进制字符: {}", e))
        })
        .collect()
}
