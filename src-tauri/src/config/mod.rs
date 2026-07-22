/**
 * 配置管理模块 (Config Manager)
 * 负责应用配置的持久化存储与读取
 * 使用 JSON 文件存储在应用数据目录中
 *
 * 配置项涵盖：通用设置、日志设置、备份设置、显示设置等
 */
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 应用全局配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    // --- 通用设置 ---
    pub close_behavior: String, // "minimize" | "exit"
    pub memory_limit_mb: u32,
    pub language: String, // "zh-CN" | "en-US"
    pub theme: String,    // "light" | "dark" | "system"
    pub prevent_screen_off: bool,
    pub prevent_sleep: bool,

    // --- 自动重连设置 ---
    pub auto_reconnect: bool,
    pub max_retries: u8,

    // --- 字体设置 ---
    pub terminal_font: String,
    pub terminal_font_size: u32,
    pub ui_font: String,
    pub ui_font_size: u32,
    pub background_image: Option<String>,

    // --- 串口默认设置 ---
    pub default_baud_rates: Vec<u32>,
    pub default_line_ending: String, // "\\r\\n" | "\\r" | "\\n"
    pub send_prefix: String,
    pub show_port_type: bool,

    // --- 时间戳设置 ---
    pub timestamp_mode: String, // "perLine" | "perRound"

    // --- 日志设置 ---
    pub auto_save_log: bool,
    pub log_directory: String,
    pub log_filename_format: String,
    pub log_format: String,   // "string" | "hex" | "binary"
    pub log_encoding: String, // "ASCII" | "UTF-8"
    pub log_split_enabled: bool,
    pub log_split_size_mb: u32,

    // --- 备份设置 ---
    pub backup_enabled: bool,
    pub backup_interval: u32, // 小时
    pub backup_directory: String,

    // --- 引导设置 ---
    // #[serde(default)]：旧版本 config.json 缺少此字段时回退为 false，
    // 避免整个配置反序列化失败而被重置为默认值
    #[serde(default)]
    pub has_seen_tour: bool,

    // --- 会话恢复 ---
    #[serde(default = "default_restore_session")]
    pub restore_session: bool,
    #[serde(default)]
    pub session_snapshot: String,
}

fn default_restore_session() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            close_behavior: "minimize".to_string(),
            memory_limit_mb: 1024,
            language: "zh-CN".to_string(),
            theme: "dark".to_string(),
            prevent_screen_off: false,
            prevent_sleep: false,
            auto_reconnect: false,
            max_retries: 3,
            terminal_font: "Consolas, monospace".to_string(),
            terminal_font_size: 14,
            ui_font: "Inter, sans-serif".to_string(),
            ui_font_size: 14,
            background_image: None,
            default_baud_rates: vec![9600, 19200, 38400, 57600, 115200, 921600],
            default_line_ending: "\\r\\n".to_string(),
            send_prefix: ">>>>>>SEND>>>>>>>>".to_string(),
            show_port_type: true,
            timestamp_mode: "perLine".to_string(),
            auto_save_log: false,
            log_directory: String::new(),
            log_filename_format: "[com]-[datetime]".to_string(),
            log_format: "string".to_string(),
            log_encoding: "UTF-8".to_string(),
            log_split_enabled: false,
            log_split_size_mb: 100,
            backup_enabled: false,
            backup_interval: 24,
            backup_directory: String::new(),
            has_seen_tour: false,
            restore_session: true,
            session_snapshot: String::new(),
        }
    }
}

pub struct ConfigManager {
    config: AppConfig,
    config_path: PathBuf,
}

impl ConfigManager {
    pub fn new() -> anyhow::Result<Self> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("Failed to get config directory"))?
            .join("hypercom");

        fs::create_dir_all(&config_dir)?;
        let config_path = config_dir.join("config.json");

        let config = if config_path.exists() {
            let content = fs::read_to_string(&config_path)?;
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            AppConfig::default()
        };

        Ok(Self {
            config,
            config_path,
        })
    }

    /// 获取当前配置
    pub fn get_config(&self) -> &AppConfig {
        &self.config
    }

    /// 更新配置并持久化
    pub fn set_config(&mut self, new_config: AppConfig) -> anyhow::Result<()> {
        self.config = new_config;
        self.save()
    }

    /// 重置为默认配置
    pub fn reset_to_default(&mut self) -> anyhow::Result<AppConfig> {
        self.config = AppConfig::default();
        self.save()?;
        Ok(self.config.clone())
    }

    /// 保存到文件（原子写入）
    fn save(&self) -> anyhow::Result<()> {
        let content = serde_json::to_string_pretty(&self.config)?;
        // 先写入同目录临时文件并 sync_all 落盘，再 rename 覆盖正式文件
        // （同卷 rename 是原子的）。避免掉电 / 崩溃在写入途中留下被截断的
        // config.json，导致下次启动反序列化失败、全部配置被重置为默认值。
        let tmp_path = self.config_path.with_extension("json.tmp");
        {
            let mut file = fs::File::create(&tmp_path)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
        }
        fs::rename(&tmp_path, &self.config_path)?;
        log::info!("Config saved to {:?}", self.config_path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_config_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("hypercom_test_config");
        let _ = fs::create_dir_all(&dir);
        dir.join(format!("{}.json", name))
    }

    #[test]
    fn test_default_values() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.close_behavior, "minimize");
        assert_eq!(cfg.memory_limit_mb, 1024);
        assert_eq!(cfg.language, "zh-CN");
        assert_eq!(cfg.theme, "dark");
        assert!(!cfg.prevent_screen_off);
        assert!(!cfg.prevent_sleep);
        assert!(!cfg.auto_reconnect);
        assert_eq!(cfg.max_retries, 3);
        assert_eq!(cfg.terminal_font_size, 14);
        assert_eq!(
            cfg.default_baud_rates,
            vec![9600, 19200, 38400, 57600, 115200, 921600]
        );
        assert_eq!(cfg.send_prefix, ">>>>>>SEND>>>>>>>>");
        assert_eq!(cfg.timestamp_mode, "perLine");
        assert!(!cfg.auto_save_log);
        assert_eq!(cfg.log_format, "string");
        assert_eq!(cfg.log_split_size_mb, 100);
        assert!(!cfg.backup_enabled);
        assert!(!cfg.has_seen_tour);
        assert!(cfg.restore_session);
        assert!(cfg.session_snapshot.is_empty());
    }

    #[test]
    fn test_legacy_json_without_has_seen_tour() {
        // 旧版本 config.json 不含 hasSeenTour 字段，
        // 反序列化必须成功并回退为 false（#[serde(default)]），
        // 否则整个配置会被 unwrap_or_default 重置
        let mut cfg = AppConfig::default();
        cfg.has_seen_tour = true;
        let mut json: serde_json::Value = serde_json::to_value(&cfg).unwrap();
        json.as_object_mut().unwrap().remove("hasSeenTour");
        let parsed: AppConfig = serde_json::from_value(json).unwrap();
        assert!(!parsed.has_seen_tour);
        assert_eq!(parsed.memory_limit_mb, 1024);
    }

    #[test]
    fn test_legacy_json_without_session_fields() {
        // 旧版本 config.json 不含 restoreSession / sessionSnapshot 字段，
        // 反序列化必须成功并回退为默认值（true / ""）
        let mut cfg = AppConfig::default();
        cfg.restore_session = false;
        cfg.session_snapshot = "some-data".to_string();
        let mut json: serde_json::Value = serde_json::to_value(&cfg).unwrap();
        {
            let obj = json.as_object_mut().unwrap();
            obj.remove("restoreSession");
            obj.remove("sessionSnapshot");
        }
        let parsed: AppConfig = serde_json::from_value(json).unwrap();
        assert!(parsed.restore_session); // default = true
        assert!(parsed.session_snapshot.is_empty());
    }

    #[test]
    fn test_json_roundtrip() {
        let cfg = AppConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.close_behavior, cfg.close_behavior);
        assert_eq!(parsed.memory_limit_mb, cfg.memory_limit_mb);
        assert_eq!(parsed.language, cfg.language);
        assert_eq!(parsed.auto_save_log, cfg.auto_save_log);
    }

    #[test]
    fn test_json_camel_case() {
        let cfg = AppConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(
            json.contains("closeBehavior"),
            "missing closeBehavior in: {}",
            json
        );
        assert!(
            json.contains("memoryLimitMb"),
            "missing memoryLimitMb in: {}",
            json
        );
        assert!(
            json.contains("autoSaveLog"),
            "missing autoSaveLog in: {}",
            json
        );
        assert!(json.contains("logFormat"), "missing logFormat in: {}", json);
        assert!(
            json.contains("terminalFontSize"),
            "missing terminalFontSize in: {}",
            json
        );
        assert!(
            json.contains("autoReconnect"),
            "missing autoReconnect in: {}",
            json
        );
        assert!(json.contains("maxRetries"), "missing maxRetries in: {}", json);
        assert!(
            json.contains("hasSeenTour"),
            "missing hasSeenTour in: {}",
            json
        );
        assert!(
            json.contains("restoreSession"),
            "missing restoreSession in: {}",
            json
        );
        assert!(
            json.contains("sessionSnapshot"),
            "missing sessionSnapshot in: {}",
            json
        );
    }

    #[test]
    fn test_set_config_persists() {
        let path = temp_config_path("test_set");
        let _ = fs::remove_file(&path);
        let mut cfg = AppConfig::default();
        cfg.memory_limit_mb = 512;
        cfg.theme = "light".to_string();
        let content = serde_json::to_string_pretty(&cfg).unwrap();
        fs::write(&path, &content).unwrap();

        let loaded: AppConfig = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.memory_limit_mb, 512);
        assert_eq!(loaded.theme, "light");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn test_reset_to_default() {
        let path = temp_config_path("test_reset");
        let _ = fs::remove_file(&path);
        let changed = AppConfig {
            memory_limit_mb: 999,
            theme: "light".to_string(),
            ..AppConfig::default()
        };
        let content = serde_json::to_string_pretty(&changed).unwrap();
        fs::write(&path, &content).unwrap();

        let loaded: AppConfig = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.memory_limit_mb, 999);
        let default = AppConfig::default();
        assert_eq!(default.memory_limit_mb, 1024);
        let _ = fs::remove_file(&path);
    }
}
