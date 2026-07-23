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

use encoding_rs::GBK;
use serde::{Deserialize, Serialize};

/// 文件名模板默认值，与前端 defaultConfig.logFilenameFormat 保持一致。
const DEFAULT_FILENAME_FORMAT: &str = "[com]-[datetime]";

/// 日志文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub path: String,
    pub port_id: String,
    pub created_at: i64,
    pub size: u64,
}

/// 单个串口的日志写入器
pub struct PortLogWriter {
    pub file_path: PathBuf,
    pub writer: BufWriter<fs::File>,
    pub current_size: u64,
    pub format: String, // "string" | "hex" | "binary"
    /// 解码标签：UTF-8 / GBK / ISO-8859-1 / ASCII，用于 string 模式下解码字节流。
    pub encoding: String,
}

impl PortLogWriter {
    /// 写入一行数据。`format` 决定写入形式：
    /// - "hex": 每字节以 "XX " 形式写入并附时间戳/方向。
    /// - "binary": 原始字节直写，不附元信息。
    /// - 其他（默认 string）: 按 `encoding` 解码为文本后写入。
    ///   GBK/ISO-8859-1 走显式映射，UTF-8/ASCII/未知值回退到 `from_utf8_lossy`。
    pub fn write_line(
        &mut self,
        timestamp: &str,
        direction: &str,
        data: &[u8],
    ) -> anyhow::Result<()> {
        match self.format.as_str() {
            "hex" => {
                let hex_str = data
                    .iter()
                    .map(|b| format!("{:02X} ", b))
                    .collect::<String>();
                writeln!(
                    self.writer,
                    "[{}] {} {}",
                    timestamp,
                    direction,
                    hex_str.trim()
                )?;
            }
            "binary" => {
                self.writer.write_all(data)?;
            }
            _ => {
                let text = decode_bytes(data, &self.encoding);
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

/// 按 encoding 解码字节为字符串。仅在 string 模式下调用。
/// - "GBK": 走 GBK → UTF-8 转换；解码失败的字节回退为 U+FFFD。
/// - "ISO-8859-1": 一对一映射到 U+0000-U+00FF。
/// - 其他（UTF-8 / ASCII / 未知）: `String::from_utf8_lossy`。
fn decode_bytes(bytes: &[u8], encoding: &str) -> String {
    match encoding.to_ascii_uppercase().as_str() {
        "GBK" | "GB2312" | "GB18030" => decode_gbk_lossy(bytes),
        "ISO-8859-1" | "LATIN1" => bytes.iter().map(|&b| b as char).collect(),
        // ASCII 是 UTF-8 子集，UTF-8 直接走 lossy。
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// GBK 解码：有效 GBK 字节转换为 Unicode；非法序列替换为 U+FFFD。
fn decode_gbk_lossy(bytes: &[u8]) -> String {
    GBK.decode(bytes).0.into_owned()
}

/// 净化要替换进文件名模板的 port_id（路径遍历防御，defects #54 同类）：
/// port_id 来自前端，若含路径分隔符或 ".."，拼出的日志文件会逃逸出日志目录，
/// 造成任意文件追加。把 Windows 非法字符 \/:*?"<>| 与 ".." 统一替换为 '_'。
fn sanitize_filename_component(input: &str) -> String {
    input
        .replace(&['/', '\\', ':', '*', '?', '"', '<', '>', '|'][..], "_")
        .replace("..", "_")
}

pub struct LogManager {
    /// 日志根目录
    log_directory: PathBuf,
    /// 活跃写入器（按串口ID索引）
    writers: HashMap<String, PortLogWriter>,
    /// 是否自动保存：false 时 write() 直接短路，避免与前端状态不同步导致的"幽灵写入"。
    auto_save: bool,
    /// 分片大小 (MB)
    split_size_mb: u32,
    /// 文件名格式 (e.g. "[com]-[datetime]")
    filename_format: String,
    /// 默认 encoding（创建 writer 时使用，前端可在 start_logging 时覆盖）
    default_encoding: String,
    /// 是否启用按大小自动分片（前端可运行时开关）
    split_enabled: bool,
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
            filename_format: DEFAULT_FILENAME_FORMAT.to_string(),
            default_encoding: "UTF-8".to_string(),
            split_enabled: true,
        }
    }

    /// 获取当前日志目录
    pub fn get_directory(&self) -> &PathBuf {
        &self.log_directory
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

    /// 设置 auto_save 开关。前端在 set_config 时同步调用，让后端在 write() 中
    /// 自检短路，避免出现配置已关但写入仍持续的幽灵状态（defects #53）。
    pub fn set_auto_save(&mut self, on: bool) {
        self.auto_save = on;
    }

    /// 设置默认 encoding（GBK / UTF-8 / ASCII / ISO-8859-1）。
    /// 已存在的 writer 不受影响 — encoding 在 create_writer 时锁定。
    pub fn set_default_encoding(&mut self, encoding: &str) {
        self.default_encoding = encoding.to_string();
    }

    /// 设置是否启用按大小自动分片。前端在 set_config 时同步调用。
    pub fn set_split_enabled(&mut self, enabled: bool) {
        self.split_enabled = enabled;
    }

    /// 解析文件名模板: [com] → port_id, [datetime] → 20260101_120000, [date] → 2026-01-01, [time] → 12:00:00
    fn format_filename(&self, port_id: &str) -> String {
        let now = chrono::Local::now();
        self.filename_format
            .replace("[com]", &sanitize_filename_component(port_id))
            .replace("[datetime]", &now.format("%Y%m%d_%H%M%S").to_string())
            .replace("[date]", &now.format("%Y-%m-%d").to_string())
            .replace("[time]", &now.format("%H-%M-%S").to_string())
    }

    /// 为指定串口创建日志写入器（使用默认 encoding）
    pub fn create_writer(&mut self, port_id: &str, format: &str) -> anyhow::Result<()> {
        let encoding = self.default_encoding.clone();
        self.create_writer_with_encoding(port_id, format, &encoding)
    }

    /// 为指定串口创建带显式 encoding 的写入器
    pub fn create_writer_with_encoding(
        &mut self,
        port_id: &str,
        format: &str,
        encoding: &str,
    ) -> anyhow::Result<()> {
        let filename = self.format_filename(port_id);
        let file_path = self.log_directory.join(format!("{}.log", filename));

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)?;

        let writer = PortLogWriter {
            file_path: file_path.clone(),
            writer: BufWriter::new(file),
            current_size: 0,
            format: format.to_string(),
            encoding: encoding.to_string(),
        };

        self.writers.insert(port_id.to_string(), writer);
        log::info!(
            "Log writer created for {} at {:?} (encoding={})",
            port_id,
            file_path,
            encoding
        );
        Ok(())
    }

    /// 写入日志。自动短路：auto_save=false 或 port_id 无 writer 时直接返回 Ok。
    /// 单字段同步：避免前端 / 后端状态漂移导致的写入泄漏（defects #53）。
    pub fn write(
        &mut self,
        port_id: &str,
        timestamp: &str,
        direction: &str,
        data: &[u8],
    ) -> anyhow::Result<()> {
        if !self.auto_save {
            return Ok(());
        }
        if let Some(writer) = self.writers.get_mut(port_id) {
            writer.write_line(timestamp, direction, data)?;

            if self.split_enabled && writer.should_split(self.split_size_mb) {
                let format = writer.format.clone();
                let encoding = writer.encoding.clone();
                let old_path = writer.file_path.clone();
                // 显式 flush + 取出 inner File + sync_all，确保 OS 把缓冲落盘后再丢弃
                // (defects #56：避免依赖 BufWriter::Drop 的 flush 把错误吞掉)
                let Some(removed) = self.writers.remove(port_id) else {
                    return Ok(());
                };
                match removed.writer.into_inner() {
                    Ok(file) => {
                        if let Err(e) = file.sync_all() {
                            log::warn!("Log split sync_all failed for {}: {}", port_id, e);
                        }
                    }
                    Err(e) => log::warn!("Log split into_inner failed for {}: {}", port_id, e),
                }
                log::info!(
                    "Log split: {} closed at {} bytes",
                    port_id,
                    old_path.display()
                );
                self.create_writer_with_encoding(port_id, &format, &encoding)?;
                log::info!("Log split: new file created for {}", port_id);
            }
        }
        Ok(())
    }

    /// 关闭串口日志
    pub fn close_writer(&mut self, port_id: &str) -> anyhow::Result<()> {
        if let Some(mut writer) = self.writers.remove(port_id) {
            writer.writer.flush()?;
            // flush 后再 sync_all，确保 OS 把缓冲落盘（defects #56 同类）
            if let Ok(file) = writer.writer.get_ref().try_clone() {
                if let Err(e) = file.sync_all() {
                    log::warn!("Log close sync_all failed for {}: {}", port_id, e);
                }
            }
            log::info!("Log writer closed for {}", port_id);
        }
        Ok(())
    }

    /// 强制刷新所有活跃日志写入器到磁盘。
    /// 在 panic hook 中调用，避免崩溃前丢失最后一批日志。
    pub fn flush_all(&mut self) -> anyhow::Result<()> {
        for (port_id, writer) in self.writers.iter_mut() {
            if let Err(e) = writer.writer.flush() {
                log::warn!("Failed to flush log writer for {}: {}", port_id, e);
            }
            if let Ok(file) = writer.writer.get_ref().try_clone() {
                if let Err(e) = file.sync_all() {
                    log::warn!("Failed to sync log file for {}: {}", port_id, e);
                }
            }
        }
        Ok(())
    }

    /// 手动另存日志
    pub fn save_log_as(&self, port_id: &str, target_path: &str) -> anyhow::Result<()> {
        if let Some(writer) = self.writers.get(port_id) {
            fs::copy(&writer.file_path, target_path)?;
            log::info!("Log saved from {:?} to {}", writer.file_path, target_path);
        } else {
            anyhow::bail!(
                "No log writer exists for port '{}'. Start logging first.",
                port_id
            );
        }
        Ok(())
    }

    /// 列出所有日志文件。port_id 解析优先级：
    /// 1. 活跃 writer 的 file_path 反查（精确，独立于 filename_format）
    /// 2. 文件名按"-"切分取首段（向后兼容默认模板，但不可靠）
    pub fn list_files(&self) -> anyhow::Result<Vec<LogFileInfo>> {
        // 反向索引：file_path → port_id（活跃 writer）
        let active_index: HashMap<PathBuf, String> = self
            .writers
            .iter()
            .map(|(pid, w)| (w.file_path.clone(), pid.clone()))
            .collect();

        let mut files = Vec::new();
        if self.log_directory.exists() {
            for entry in fs::read_dir(&self.log_directory)? {
                let entry = entry?;
                let metadata = entry.metadata()?;
                if metadata.is_file() {
                    let path = entry.path();
                    let port_id = active_index.get(&path).cloned().unwrap_or_else(|| {
                        // fallback：按"-"切分文件名首段
                        path.file_stem()
                            .and_then(|s| s.to_str())
                            .and_then(|stem| stem.split('-').next())
                            .unwrap_or("unknown")
                            .to_string()
                    });
                    files.push(LogFileInfo {
                        path: path.to_string_lossy().to_string(),
                        port_id,
                        created_at: metadata
                            .created()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hypercom_test_logs_{}", name));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn test_manager(dir: &PathBuf) -> LogManager {
        // 测试中默认开启 auto_save，否则 write() 会被短路
        LogManager {
            log_directory: dir.clone(),
            writers: HashMap::new(),
            auto_save: true,
            split_size_mb: 100,
            filename_format: "[com]-[datetime]".to_string(),
            default_encoding: "UTF-8".to_string(),
            split_enabled: true,
        }
    }

    #[test]
    fn test_create_writer() {
        let dir = test_dir("create");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM3", "string").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].path.contains("COM3"));
        assert!(files[0].path.ends_with(".log"));
        mgr.close_writer("COM3").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_string_format() {
        let dir = test_dir("string");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:00", "RX", b"Hello").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("Hello"));
        assert!(content.contains("10:00:00"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_hex_format() {
        let dir = test_dir("hex");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "hex").unwrap();
        mgr.write("COM1", "10:00:01", "TX", &[0x48, 0x65, 0x6C, 0x6C, 0x6F])
            .unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("48 65 6C 6C 6F"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_should_split() {
        let dir = test_dir("split");
        let file_path = dir.join("split_test.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .unwrap();
        let mut writer = PortLogWriter {
            file_path: file_path.clone(),
            writer: BufWriter::new(file),
            current_size: 0,
            format: "string".into(),
            encoding: "UTF-8".into(),
        };
        assert!(!writer.should_split(1));
        writer.current_size = 1024 * 1024;
        assert!(writer.should_split(1));
        writer.current_size = 2 * 1024 * 1024;
        assert!(writer.should_split(1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_filename_format_variables() {
        let dir = test_dir("fmt");
        let mut mgr = test_manager(&dir);
        mgr.set_filename_format("[com]-[date]");
        mgr.create_writer("COM5", "string").unwrap();
        let files = mgr.list_files().unwrap();
        let name = &files[0].path;
        assert!(name.contains("COM5"), "Expected COM5 in: {}", name);
        let date_part = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert!(
            name.contains(&date_part),
            "Expected {} in: {}",
            date_part,
            name
        );
        mgr.close_writer("COM5").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_save_log_as() {
        let dir = test_dir("save");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM9", "string").unwrap();
        mgr.write("COM9", "10:00:00", "RX", b"test data").unwrap();
        let _files = mgr.list_files().unwrap();
        let target = dir.join("saved.log");
        mgr.save_log_as("COM9", &target.to_string_lossy()).unwrap();
        assert!(target.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_save_log_as_no_writer() {
        let dir = test_dir("nowriter");
        let mgr = test_manager(&dir);
        let result = mgr.save_log_as("NONEXIST", "/tmp/test.log");
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_accumulates_to_file() {
        let dir = test_dir("accum");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00", "RX", b"line1\n").unwrap();
        mgr.write("COM1", "10:01", "RX", b"line2\n").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("line1"));
        assert!(content.contains("line2"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_auto_save_off_short_circuits_write() {
        // defects #53：auto_save=false 时 write() 必须直接返回，不写文件
        let dir = test_dir("autosave_off");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.set_auto_save(false);
        mgr.write("COM1", "10:00", "RX", b"should_not_appear\n")
            .unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(
            !content.contains("should_not_appear"),
            "auto_save=false should short-circuit write, but file contains: {:?}",
            content
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_list_files_uses_writer_registry_for_port_id() {
        // defects #52：自定义文件名模板下，port_id 必须从活跃 writer 反查，
        // 而不是简单地按 "-" 切分文件名首段
        let dir = test_dir("custom_fmt");
        let mut mgr = test_manager(&dir);
        mgr.set_filename_format("log_[com]_[date]");
        mgr.create_writer("COM7", "string").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].port_id, "COM7",
            "port_id should resolve to COM7 via writer registry, not 'log_log'. Got: {}",
            files[0].port_id
        );
        mgr.close_writer("COM7").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_iso_8859_1_encoding_decodes_high_bytes() {
        // defects #49：ISO-8859-1 字节 0xE9 应解码为 'é'，而不是 U+FFFD
        let dir = test_dir("latin1");
        let mut mgr = test_manager(&dir);
        mgr.set_default_encoding("ISO-8859-1");
        mgr.create_writer("COM2", "string").unwrap();
        mgr.write("COM2", "10:00", "RX", &[b'h', b'i', 0xE9])
            .unwrap();
        mgr.close_writer("COM2").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("hi"), "expected 'hi' in: {}", content);
        assert!(
            content.contains('é') || content.contains("\u{00E9}"),
            "expected 'é' (U+00E9) in ISO-8859-1 decoded output, got: {}",
            content
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_gbk_decoding_decodes_chinese_characters() {
        // Given: common Chinese text encoded as GBK bytes.
        let (bytes, _, _) = GBK.encode("你好");

        // When: logger decodes the byte stream in GBK mode.
        let decoded = decode_gbk_lossy(&bytes);

        // Then: the readable Chinese text is preserved, not replaced by U+FFFD.
        assert_eq!(decoded, "你好");
        assert!(!decoded.contains('\u{FFFD}'));
    }
}
