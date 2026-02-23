use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Mutex;

/// 日志状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LogStatus {
    /// 未记录
    Stopped,
    /// 正在记录
    Recording,
    /// 暂停
    Paused,
}

/// 日志配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogConfig {
    /// 是否启用日志
    pub enabled: bool,
    /// 日志目录
    pub log_dir: String,
    /// 最大文件大小 (MB)
    pub max_file_size: u64,
    /// 自动分片
    pub auto_split: bool,
    /// 包含时间戳
    pub include_timestamp: bool,
    /// 包含数据方向
    pub include_direction: bool,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            log_dir: String::new(),
            max_file_size: 10, // 10MB
            auto_split: true,
            include_timestamp: true,
            include_direction: true,
        }
    }
}

/// 日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct LogEntry {
    /// 时间戳
    pub timestamp: i64,
    /// 数据方向 (RX/TX)
    pub direction: String,
    /// 数据内容
    pub data: String,
    /// 数据格式 (hex/ascii)
    pub format: String,
}

#[allow(dead_code)]
impl LogEntry {
    /// 创建新的日志条目
    pub fn new(direction: &str, data: &str, format: &str) -> Self {
        Self {
            timestamp: Utc::now().timestamp_millis(),
            direction: direction.to_string(),
            data: data.to_string(),
            format: format.to_string(),
        }
    }

    /// 格式化为字符串
    pub fn format(&self, include_timestamp: bool, include_direction: bool) -> String {
        let mut parts = Vec::new();

        if include_timestamp {
            let dt = DateTime::from_timestamp_millis(self.timestamp)
                .unwrap_or_else(|| Utc::now())
                .with_timezone(&Local);
            parts.push(format!("[{}]", dt.format("%Y-%m-%d %H:%M:%S%.3f")));
        }

        if include_direction {
            parts.push(format!("[{}]", self.direction));
        }

        parts.push(self.data.clone());

        parts.join(" ") + "\n"
    }
}

/// 日志文件管理器
#[allow(dead_code)]
pub struct LogManager {
    /// 当前日志文件路径
    current_file: Option<PathBuf>,
    /// 缓冲写入器
    writer: Option<BufWriter<File>>,
    /// 日志配置
    config: LogConfig,
    /// 当前状态
    status: LogStatus,
    /// 当前文件大小
    current_size: u64,
    /// 文件计数器
    file_counter: u32,
}

#[allow(dead_code)]
impl LogManager {
    /// 创建新的日志管理器
    pub fn new(config: LogConfig) -> Self {
        Self {
            current_file: None,
            writer: None,
            config,
            status: LogStatus::Stopped,
            current_size: 0,
            file_counter: 0,
        }
    }

    /// 开始记录日志
    pub fn start_logging(&mut self, log_dir: Option<&str>) -> Result<(), String> {
        if self.status == LogStatus::Recording {
            return Ok(());
        }

        // 确定日志目录
        let dir = log_dir
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.config.log_dir.clone());

        // 确保目录存在
        let dir_path = PathBuf::from(&dir);
        if !dir_path.exists() {
            std::fs::create_dir_all(&dir_path)
                .map_err(|e| format!("Failed to create log directory: {}", e))?;
        }

        // 生成日志文件名
        let now: DateTime<Local> = Local::now();
        let filename = format!("hypercom_{}.log", now.format("%Y%m%d_%H%M%S"));
        let file_path = dir_path.join(&filename);

        // 打开文件
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&file_path)
            .map_err(|e| format!("Failed to open log file: {}", e))?;

        self.current_file = Some(file_path);
        self.writer = Some(BufWriter::new(file));
        self.status = LogStatus::Recording;
        self.current_size = 0;
        self.file_counter = 0;

        Ok(())
    }

    /// 停止记录日志
    pub fn stop_logging(&mut self) -> Result<(), String> {
        if let Some(mut writer) = self.writer.take() {
            writer.flush()
                .map_err(|e| format!("Failed to flush log file: {}", e))?;
        }

        self.current_file = None;
        self.status = LogStatus::Stopped;
        self.current_size = 0;

        Ok(())
    }

    /// 暂停记录
    pub fn pause_logging(&mut self) -> Result<(), String> {
        if self.status == LogStatus::Recording {
            self.status = LogStatus::Paused;
        }
        Ok(())
    }

    /// 恢复记录
    pub fn resume_logging(&mut self) -> Result<(), String> {
        if self.status == LogStatus::Paused {
            self.status = LogStatus::Recording;
        }
        Ok(())
    }

    /// 写入日志条目
    pub fn write_entry(&mut self, entry: &LogEntry) -> Result<(), String> {
        if self.status != LogStatus::Recording {
            return Ok(());
        }

        // 格式化日志条目
        let formatted = entry.format(self.config.include_timestamp, self.config.include_direction);
        let bytes = formatted.as_bytes();

        // 检查文件大小
        if self.config.auto_split {
            let new_size = self.current_size + bytes.len() as u64;
            let max_size = self.config.max_file_size * 1024 * 1024;

            if new_size > max_size {
                self.rotate_file()?;
            }
        }

        let writer = self.writer.as_mut()
            .ok_or("Log writer not initialized")?;

        // 写入数据
        writer.write_all(bytes)
            .map_err(|e| format!("Failed to write log entry: {}", e))?;

        self.current_size += bytes.len() as u64;

        // 定期刷新
        if self.current_size % 4096 == 0 {
            writer.flush()
                .map_err(|e| format!("Failed to flush log file: {}", e))?;
        }

        Ok(())
    }

    /// 写入原始数据
    pub fn write_data(&mut self, direction: &str, data: &str, format: &str) -> Result<(), String> {
        let entry = LogEntry::new(direction, data, format);
        self.write_entry(&entry)
    }

    /// 轮转日志文件
    fn rotate_file(&mut self) -> Result<(), String> {
        // 刷新并关闭当前文件
        if let Some(mut writer) = self.writer.take() {
            writer.flush()
                .map_err(|e| format!("Failed to flush log file: {}", e))?;
        }

        // 创建新文件
        if let Some(current_path) = &self.current_file {
            let dir = current_path.parent()
                .ok_or("Invalid log file path")?;

            self.file_counter += 1;
            let now: DateTime<Local> = Local::now();
            let filename = format!("hypercom_{}_{:03}.log", 
                now.format("%Y%m%d_%H%M%S"), self.file_counter);
            let file_path = dir.join(&filename);

            let file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&file_path)
                .map_err(|e| format!("Failed to open new log file: {}", e))?;

            self.current_file = Some(file_path);
            self.writer = Some(BufWriter::new(file));
            self.current_size = 0;
        }

        Ok(())
    }

    /// 刷新缓冲区
    pub fn flush(&mut self) -> Result<(), String> {
        if let Some(writer) = self.writer.as_mut() {
            writer.flush()
                .map_err(|e| format!("Failed to flush log file: {}", e))?;
        }
        Ok(())
    }

    /// 获取当前状态
    pub fn get_status(&self) -> LogStatus {
        self.status.clone()
    }

    /// 获取当前日志文件路径
    pub fn get_current_file(&self) -> Option<&PathBuf> {
        self.current_file.as_ref()
    }

    /// 获取配置
    pub fn get_config(&self) -> &LogConfig {
        &self.config
    }

    /// 更新配置
    pub fn update_config(&mut self, config: LogConfig) {
        self.config = config;
    }

    /// 获取当前文件大小
    pub fn get_current_size(&self) -> u64 {
        self.current_size
    }
}

/// 应用状态中的日志管理器
pub struct LogState {
    pub manager: Mutex<LogManager>,
}

impl LogState {
    pub fn new(manager: LogManager) -> Self {
        Self {
            manager: Mutex::new(manager),
        }
    }
}

/// 导出日志文件
pub fn export_log(source: &str, target: &str) -> Result<(), String> {
    std::fs::copy(source, target)
        .map_err(|e| format!("Failed to export log: {}", e))?;
    Ok(())
}

/// 清空日志文件
pub fn clear_log(path: &str) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("Failed to clear log file: {}", e))?;
    Ok(())
}

/// 获取日志目录下的所有日志文件
pub fn list_log_files(dir: &str) -> Result<Vec<String>, String> {
    let dir_path = PathBuf::from(dir);
    
    if !dir_path.exists() {
        return Ok(Vec::new());
    }

    let entries = std::fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read log directory: {}", e))?;

    let mut files = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.extension().map(|e| e == "log").unwrap_or(false) {
                if let Some(path_str) = path.to_str() {
                    files.push(path_str.to_string());
                }
            }
        }
    }

    // 按时间排序（最新的在前）
    files.sort_by(|a, b| b.cmp(a));

    Ok(files)
}
