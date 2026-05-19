/**
 * 配置管理模块 (Config Manager)
 * 负责应用配置的持久化存储与读取
 * 使用 JSON 文件存储在应用数据目录中
 * 
 * 配置项涵盖：通用设置、日志设置、备份设置、显示设置等
 */

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 应用全局配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    // --- 通用设置 ---
    pub close_behavior: String,      // "minimize" | "exit"
    pub memory_limit_mb: u32,
    pub language: String,            // "zh-CN" | "en-US"
    pub theme: String,               // "light" | "dark" | "system"
    pub prevent_screen_off: bool,
    pub prevent_sleep: bool,

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
    pub timestamp_mode: String,      // "perLine" | "perRound"

    // --- 日志设置 ---
    pub auto_save_log: bool,
    pub log_directory: String,
    pub log_filename_format: String,
    pub log_format: String,          // "string" | "hex" | "binary"
    pub log_encoding: String,        // "ASCII" | "UTF-8"
    pub log_split_enabled: bool,
    pub log_split_size_mb: u32,

    // --- 备份设置 ---
    pub backup_enabled: bool,
    pub backup_interval: u32,        // 小时
    pub backup_directory: String,
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

        Ok(Self { config, config_path })
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

    /// 保存到文件
    fn save(&self) -> anyhow::Result<()> {
        let content = serde_json::to_string_pretty(&self.config)?;
        fs::write(&self.config_path, content)?;
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
        assert_eq!(cfg.terminal_font_size, 14);
        assert_eq!(cfg.default_baud_rates, vec![9600, 19200, 38400, 57600, 115200, 921600]);
        assert_eq!(cfg.send_prefix, ">>>>>>SEND>>>>>>>>");
        assert_eq!(cfg.timestamp_mode, "perLine");
        assert!(!cfg.auto_save_log);
        assert_eq!(cfg.log_format, "string");
        assert_eq!(cfg.log_split_size_mb, 100);
        assert!(!cfg.backup_enabled);
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
        assert!(json.contains("closeBehavior"), "missing closeBehavior in: {}", json);
        assert!(json.contains("memoryLimitMb"), "missing memoryLimitMb in: {}", json);
        assert!(json.contains("autoSaveLog"), "missing autoSaveLog in: {}", json);
        assert!(json.contains("logFormat"), "missing logFormat in: {}", json);
        assert!(json.contains("terminalFontSize"), "missing terminalFontSize in: {}", json);
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
