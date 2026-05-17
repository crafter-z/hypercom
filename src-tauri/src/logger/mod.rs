/**
 * 日志管理模块 (Log Manager)
 * 负责串口通信日志的写入、分片、另存等操作
 * 
 * 设计要点:
 * - 使用 BufWriter 异步写入，减少磁盘IO阻塞
 * - 支持按日期或大小自动分片
 * - 支持字符串/HEX/二进制三种格式
 * - 每个串口对应独立的日志文件
 */

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 日志文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogFileInfo {
    pub path: String,
    pub port_id: String,
    pub created_at: i64,
    pub size: u64,
}

/// 单个串口的日志写入器
pub struct PortLogWriter {
    #[allow(dead_code)]
    pub port_id: String,
    pub file_path: PathBuf,
    pub writer: BufWriter<fs::File>,
    pub current_size: u64,
    pub format: String, // "string" | "hex" | "binary"
}

impl PortLogWriter {
    /// 写入一行数据
    /// TODO: 根据 format 决定写入格式（字符串/HEX/二进制）
    pub fn write_line(&mut self, timestamp: &str, direction: &str, data: &[u8]) -> anyhow::Result<()> {
        match self.format.as_str() {
            "hex" => {
                let hex_str = data.iter().map(|b| format!("{:02X} ", b)).collect::<String>();
                writeln!(self.writer, "[{}] {} {}", timestamp, direction, hex_str.trim())?;
            }
            "binary" => {
                // TODO: 二进制格式写入
                self.writer.write_all(data)?;
            }
            _ => {
                // 默认字符串格式
                let text = String::from_utf8_lossy(data);
                writeln!(self.writer, "[{}] {} {}", timestamp, direction, text)?;
            }
        }
        self.writer.flush()?;
        self.current_size += data.len() as u64;
        Ok(())
    }

    /// 检查是否需要分片
    pub fn should_split(&self, split_size_mb: u32) -> bool {
        self.current_size >= (split_size_mb as u64) * 1024 * 1024
    }
}

pub struct LogManager {
    /// 日志根目录
    log_directory: PathBuf,
    /// 活跃写入器（按串口ID索引）
    writers: HashMap<String, PortLogWriter>,
    /// 是否自动保存
    #[allow(dead_code)]
    auto_save: bool,
    /// 分片大小 (MB)
    split_size_mb: u32,
    /// 文件名格式 (e.g. "[com]-[datetime]")
    filename_format: String,
}

impl LogManager {
    pub fn new() -> Self {
        let log_directory = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("hypercom")
            .join("logs");
        
        let _ = fs::create_dir_all(&log_directory);

        Self {
            log_directory,
            writers: HashMap::new(),
            auto_save: false,
            split_size_mb: 100,
            filename_format: "[com]-[datetime]".to_string(),
        }
    }

    /// 设置日志目录
    pub fn set_directory(&mut self, path: String) -> anyhow::Result<()> {
        let new_path = PathBuf::from(path);
        fs::create_dir_all(&new_path)?;
        self.log_directory = new_path;
        Ok(())
    }

    /// 设置分片大小
    pub fn set_split_size(&mut self, mb: u32) {
        self.split_size_mb = mb;
    }

    /// 设置文件名格式
    pub fn set_filename_format(&mut self, format: &str) {
        self.filename_format = format.to_string();
    }

    /// 解析文件名模板: [com] → port_id, [datetime] → 20260101_120000, [date] → 2026-01-01, [time] → 12:00:00
    fn format_filename(&self, port_id: &str) -> String {
        let now = chrono::Local::now();
        self.filename_format
            .replace("[com]", port_id)
            .replace("[datetime]", &now.format("%Y%m%d_%H%M%S").to_string())
            .replace("[date]", &now.format("%Y-%m-%d").to_string())
            .replace("[time]", &now.format("%H-%M-%S").to_string())
    }

    /// 为指定串口创建日志写入器
    pub fn create_writer(&mut self, port_id: &str, format: &str) -> anyhow::Result<()> {
        let filename = self.format_filename(port_id);
        let file_path = self.log_directory.join(format!("{}.log", filename));
        
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)?;
        
        let writer = PortLogWriter {
            port_id: port_id.to_string(),
            file_path: file_path.clone(),
            writer: BufWriter::new(file),
            current_size: 0,
            format: format.to_string(),
        };
        
        self.writers.insert(port_id.to_string(), writer);
        log::info!("Log writer created for {} at {:?}", port_id, file_path);
        Ok(())
    }

    /// 写入日志
    pub fn write(&mut self, port_id: &str, timestamp: &str, direction: &str, data: &[u8]) -> anyhow::Result<()> {
        if let Some(writer) = self.writers.get_mut(port_id) {
            writer.write_line(timestamp, direction, data)?;
            
            if writer.should_split(self.split_size_mb) {
                let format = writer.format.clone();
                writer.writer.flush()?;
                let old_path = writer.file_path.clone();
                // Close old writer by removing and creating a new one
                self.writers.remove(port_id);
                log::info!("Log split: {} closed at {} bytes", port_id, old_path.display());
                self.create_writer(port_id, &format)?;
                log::info!("Log split: new file created for {}", port_id);
            }
        }
        Ok(())
    }

    /// 关闭串口日志
    pub fn close_writer(&mut self, port_id: &str) -> anyhow::Result<()> {
        if let Some(mut writer) = self.writers.remove(port_id) {
            writer.writer.flush()?;
            log::info!("Log writer closed for {}", port_id);
        }
        Ok(())
    }

    /// 手动另存日志
    pub fn save_log_as(&self, port_id: &str, target_path: &str) -> anyhow::Result<()> {
        if let Some(writer) = self.writers.get(port_id) {
            fs::copy(&writer.file_path, target_path)?;
            log::info!("Log saved from {:?} to {}", writer.file_path, target_path);
        }
        Ok(())
    }

    /// 列出所有日志文件
    pub fn list_files(&self) -> anyhow::Result<Vec<LogFileInfo>> {
        let mut files = Vec::new();
        if self.log_directory.exists() {
            for entry in fs::read_dir(&self.log_directory)? {
                let entry = entry?;
                let metadata = entry.metadata()?;
                if metadata.is_file() {
                    let path = entry.path();
                    let stem = path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    let port_id = stem.split('-').next().unwrap_or("unknown").to_string();
                    files.push(LogFileInfo {
                        path: entry.path().to_string_lossy().to_string(),
                        port_id,
                        created_at: metadata.created()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0),
                        size: metadata.len(),
                    });
                }
            }
        }
        Ok(files)
    }
}
