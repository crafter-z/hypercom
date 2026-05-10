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
        }
    }

    /// 设置日志目录
    pub fn set_directory(&mut self, path: String) -> anyhow::Result<()> {
        let new_path = PathBuf::from(path);
        fs::create_dir_all(&new_path)?;
        self.log_directory = new_path;
        Ok(())
    }

    /// 为指定串口创建日志写入器
    /// TODO: 根据配置生成文件名（支持 [com]-[datetime] 格式）
    pub fn create_writer(&mut self, port_id: &str, format: &str) -> anyhow::Result<()> {
        let filename = format!("{}-{}", port_id, chrono::Local::now().format("%Y%m%d_%H%M%S"));
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
            
            // 检查分片
            if writer.should_split(self.split_size_mb) {
                // TODO: 关闭当前文件，创建新文件继续写入
                log::info!("Log split triggered for {}", port_id);
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
                    files.push(LogFileInfo {
                        path: entry.path().to_string_lossy().to_string(),
                        port_id: "unknown".to_string(), // TODO: 从文件名解析
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
