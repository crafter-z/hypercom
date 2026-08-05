/**
 * 诊断日志模块 (Diagnostic Logger)
 *
 * 收集应用自身的运行时日志（后端 `log::*` 宏 与 前端 `console.*` 转发而来），
 * 统一写入数据目录下的诊断日志文件，并支持按大小轮转、读取、清空与追加。
 *
 * 与 `logger/mod.rs`（串口通信日志）职责分离：本模块只服务「应用自身维测」，
 * 不涉及串口字节流。
 *
 * 设计要点:
 * - 实现 `log::Log`，在 `run()` 中作为全局 logger 安装，替换原 `env_logger`。
 * - 单行结构化格式：`2026-08-05 20:00:00.123 [INFO] [模块] 消息`，
 *   前端解析该格式做级别着色。
 * - 按大小轮转：当前文件超过 `MAX_FILE_SIZE` 时滚动为 `.1/.2/...`，保留 `MAX_BACKUPS` 份。
 * - `enabled` 原子开关：随配置 `diagnostic_log_enabled` 同步，关闭时不落盘。
 * - 线程安全：单文件句柄 + Mutex，写后立即 flush，保证 `read` 能读到最新内容。
 */
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use log::{Level, LevelFilter, Log, Metadata, Record};

/// 单文件大小上限（字节）。超过即轮转。
const MAX_FILE_SIZE: u64 = 512 * 1024;
/// 保留的轮转备份文件数（`.log.1` ~ `.log.N`）。
const MAX_BACKUPS: usize = 3;
/// 诊断日志文件名（当前活跃文件）。
const ACTIVE_FILENAME: &str = "hypercom-debug.log";

/// 诊断日志器。写入运行日志到旋转文件，是 `log::Log` 的实际实现。
pub struct DiagLogger {
    /// 活跃日志文件路径（`<data_dir>/hypercom/diag/hypercom-debug.log`）。
    path: PathBuf,
    /// 惰性打开的文件句柄；Mutex 保证并发写安全。
    file: Mutex<Option<fs::File>>,
    /// 是否启用（随配置 `diagnostic_log_enabled` 同步）。
    enabled: AtomicBool,
}

impl DiagLogger {
    /// 在 `dir` 目录下创建诊断日志器（目录不存在则创建）。
    pub fn new(dir: PathBuf) -> anyhow::Result<Self> {
        fs::create_dir_all(&dir)?;
        let path = dir.join(ACTIVE_FILENAME);
        Ok(Self {
            path,
            file: Mutex::new(None),
            enabled: AtomicBool::new(true),
        })
    }

    /// 当前活跃日志文件路径。
    pub fn file_path(&self) -> PathBuf {
        self.path.clone()
    }

    /// 是否启用。
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// 设置启用开关（随配置同步）。
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    /// 按轮转序号解析备份文件路径（1..=MAX_BACKUPS）。
    fn backup_path(&self, n: usize) -> PathBuf {
        let mut p = self.path.clone();
        p.set_file_name(format!("{ACTIVE_FILENAME}.{}", n));
        p
    }

    /// 写入一条日志。层外层负责格式化时间戳；此处拼接统一行格式并落盘。
    fn write(
        &self,
        timestamp: &str,
        level: &str,
        target: &str,
        msg: &str,
    ) {
        if !self.is_enabled() {
            return;
        }
        let mut file = match self.file.lock() {
            Ok(f) => f,
            Err(_) => return,
        };
        if file.is_none() {
            *file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .ok();
        }
        // 写入前检查大小：当前文件已满则先轮转拿到新活跃文件，再写入新行，
        // 保证新日志始终落在活跃文件（而非刚被轮转走的备份）里。
        if let Some(f) = file.as_ref() {
            let full = f.metadata().map(|m| m.len() >= MAX_FILE_SIZE).unwrap_or(false);
            if full {
                if file.take().is_some() {
                    self.rotate();
                }
                *file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)
                    .ok();
            }
        }
        let Some(f) = file.as_mut() else {
            return;
        };
        let line = format!("{timestamp} [{level}] [{target}] {msg}\n");
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }

    /// 轮转：`.N-1 → .N` 依次后移，活跃文件 → `.1`，最旧备份删除。
    fn rotate(&self) {
        for i in (1..MAX_BACKUPS).rev() {
            let from = self.backup_path(i);
            let to = self.backup_path(i + 1);
            if from.exists() {
                let _ = fs::rename(&from, &to);
            }
        }
        let _ = fs::rename(&self.path, self.backup_path(1));
    }

    /// 追加一条来自前端的日志（`console.*` 转发而来）。
    pub fn append_external(&self, timestamp: &str, level: &str, msg: &str) {
        self.write(timestamp, level, "frontend", msg);
    }

    /// 读取最近 `limit` 行。按时间顺序（最旧备份 → 最新活跃）拼接后取末尾。
    pub fn read(&self, limit: usize) -> String {
        let mut parts = Vec::new();
        for i in (1..=MAX_BACKUPS).rev() {
            let p = self.backup_path(i);
            if let Ok(text) = fs::read_to_string(&p) {
                parts.push(text);
            }
        }
        if let Ok(text) = fs::read_to_string(&self.path) {
            parts.push(text);
        }
        let all = parts.join("");
        let lines: Vec<&str> = all.lines().collect();
        if lines.len() <= limit {
            return all;
        }
        lines[lines.len() - limit..].join("\n") + "\n"
    }

    /// 清空全部诊断日志（活跃文件 + 所有备份）。
    pub fn clear(&self) {
        {
            let mut file = match self.file.lock() {
                Ok(f) => f,
                Err(_) => return,
            };
            if file.take().is_some() {
                // 关闭句柄后再删，Windows 下避免占用。
            }
        }
        for i in 1..=MAX_BACKUPS {
            let p = self.backup_path(i);
            if p.exists() {
                let _ = fs::remove_file(&p);
            }
        }
        let _ = fs::write(&self.path, "");
    }
}

impl Log for DiagLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Debug
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let ts = chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string();
        self.write(
            &ts,
            &record.level().to_string(),
            record.target(),
            &record.args().to_string(),
        );
    }

    fn flush(&self) {
        if let Ok(mut file) = self.file.lock() {
            if let Some(f) = file.as_mut() {
                let _ = f.flush();
            }
        }
    }
}

/// 全局 logger 适配器：让 `log::set_boxed_logger` 持有一个 `Arc<DiagLogger>`，
/// 同时 AppState 保留同一 Arc 供命令（读/清/追加）访问。
pub struct GlobalLogger(pub Arc<DiagLogger>);

impl Log for GlobalLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        self.0.enabled(metadata)
    }

    fn log(&self, record: &Record) {
        self.0.log(record);
    }

    fn flush(&self) {
        self.0.flush();
    }
}

/// 安装全局日志器并设置最大级别。返回 `DiagLogger`（供 AppState 持有）。
/// `set_boxed_logger` 只能成功一次；失败说明已有 logger（如测试环境），
/// 此时返回的 logger 仍可用（命令路径），只是不再作全局 logger。
pub fn install(dir: PathBuf) -> anyhow::Result<Arc<DiagLogger>> {
    let logger = Arc::new(DiagLogger::new(dir)?);
    let global = GlobalLogger(logger.clone());
    if log::set_boxed_logger(Box::new(global)).is_ok() {
        log::set_max_level(LevelFilter::Debug);
    }
    Ok(logger)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hypercom_diag_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_read_clear_roundtrip() {
        let dir = temp_dir("roundtrip");
        let logger = DiagLogger::new(dir.clone()).unwrap();
        logger.write("2026-08-05 20:00:00.000", "INFO", "test", "hello");
        logger.write("2026-08-05 20:00:01.000", "ERROR", "test", "boom");
        let text = logger.read(100);
        assert!(text.contains("[INFO] [test] hello"));
        assert!(text.contains("[ERROR] [test] boom"));
        assert_eq!(text.lines().count(), 2);
        logger.clear();
        assert_eq!(logger.read(100), "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_limits_to_recent_lines() {
        let dir = temp_dir("limit");
        let logger = DiagLogger::new(dir.clone()).unwrap();
        for i in 0..10 {
            logger.write("ts", "INFO", "t", &format!("line{i}"));
        }
        let text = logger.read(3);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "ts [INFO] [t] line7");
        assert_eq!(lines[2], "ts [INFO] [t] line9");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn disabled_logger_writes_nothing() {
        let dir = temp_dir("disabled");
        let logger = DiagLogger::new(dir.clone()).unwrap();
        logger.set_enabled(false);
        logger.write("ts", "WARN", "t", "should not appear");
        assert_eq!(logger.is_enabled(), false);
        assert_eq!(logger.read(100), "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_keeps_backups_and_drops_oldest() {
        let dir = temp_dir("rotate");
        let logger = DiagLogger::new(dir.clone()).unwrap();
        // 直接往活跃文件塞满，触发轮转。
        let big = "x".repeat(MAX_FILE_SIZE as usize);
        fs::write(logger.file_path(), &big).unwrap();
        logger.write("ts", "INFO", "t", "after-rotate");
        // 活跃文件应已新建且包含新行。
        let active = fs::read_to_string(logger.file_path()).unwrap();
        assert!(active.contains("after-rotate"));
        // 备份 .1 应为旧的大文件。
        assert!(logger.backup_path(1).exists());
        // 写满三次，验证最旧备份被清除。
        for _ in 0..MAX_BACKUPS {
            fs::write(logger.file_path(), &big).unwrap();
            logger.write("ts", "INFO", "t", "more");
        }
        assert!(!logger.backup_path(MAX_BACKUPS + 1).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn external_append_uses_frontend_target() {
        let dir = temp_dir("external");
        let logger = DiagLogger::new(dir.clone()).unwrap();
        logger.append_external("2026-08-05 20:00:00.000", "INFO", "console.log msg");
        let text = logger.read(100);
        assert!(text.contains("[frontend] console.log msg"));
        let _ = fs::remove_dir_all(&dir);
    }
}