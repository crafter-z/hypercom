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

/// 当前配置 schema 版本号。每次破坏性变更配置结构时递增，
/// 并在 `ConfigManager::migrate` 中追加对应的迁移分支。
const CURRENT_CONFIG_VERSION: u32 = 1;

fn current_config_version() -> u32 {
    CURRENT_CONFIG_VERSION
}

/// 应用全局配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    // --- schema 版本 ---
    #[serde(default = "current_config_version")]
    pub config_version: u32,

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
    #[serde(default = "default_send_on_enter")]
    pub send_on_enter: bool,
    #[serde(default)]
    pub quick_send_slots: Vec<Option<String>>,
    #[serde(default = "default_timestamp_format")]
    pub timestamp_format: String,

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

fn default_send_on_enter() -> bool {
    true
}

fn default_timestamp_format() -> String {
    "absolute".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            config_version: CURRENT_CONFIG_VERSION,
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
            send_on_enter: true,
            quick_send_slots: vec![None, None, None, None, None],
            timestamp_format: "absolute".to_string(),
            timestamp_mode: "perLine".to_string(),
            auto_save_log: true,
            log_directory: String::new(),
            log_filename_format: "[com]-[datetime]".to_string(),
            log_format: "string".to_string(),
            log_encoding: "UTF-8".to_string(),
            log_split_enabled: true,
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
    /// 创建配置管理器。
    ///
    /// 配置文件路径按优先级解析：
    /// 1. `custom_path`（CLI `--config` 参数显式指定）
    /// 2. `HYPERCOM_CONFIG` 环境变量
    /// 3. 便携模式：可执行文件同目录下已存在的 `config.json`
    /// 4. 默认：%APPDATA%/hypercom/config.json（`dirs::config_dir`）
    pub fn new(custom_path: Option<PathBuf>) -> anyhow::Result<Self> {
        let config_path = if let Some(p) = custom_path {
            // CLI --config 显式指定
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)?;
            }
            p
        } else if let Ok(env_path) = std::env::var("HYPERCOM_CONFIG") {
            // 环境变量指定
            let p = PathBuf::from(env_path);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)?;
            }
            p
        } else {
            // 便携模式：可执行文件同目录下已存在 config.json 时优先使用
            let portable = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.join("config.json")));
            if let Some(ref p) = portable {
                if p.exists() {
                    p.clone()
                } else {
                    Self::default_config_path()?
                }
            } else {
                Self::default_config_path()?
            }
        };

        let mut config = if config_path.exists() {
            let content = fs::read_to_string(&config_path)?;
            // 先解析为 Value 做版本检测 + 迁移，再反序列化为 AppConfig。
            // 解析失败时尝试 .bak 恢复，避免损坏的 config.json 导致全部配置丢失。
            match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(mut json) => {
                    let version = json
                        .get("configVersion")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    if version < CURRENT_CONFIG_VERSION {
                        Self::migrate(&mut json, version);
                    }
                    serde_json::from_value(json).unwrap_or_default()
                }
                Err(e) => {
                    log::warn!("Config file corrupt ({}), attempting .bak recovery", e);
                    let bak_path = config_path.with_extension("json.bak");
                    if bak_path.exists() {
                        let bak_content = fs::read_to_string(&bak_path)?;
                        serde_json::from_str(&bak_content).unwrap_or_default()
                    } else {
                        log::warn!("No .bak available, using defaults");
                        AppConfig::default()
                    }
                }
            }
        } else {
            AppConfig::default()
        };

        // Resolve empty log_directory to the actual default path so the
        // frontend always sees a real directory and syncLogSettingsToBackend
        // passes a valid path to set_log_directory.
        if config.log_directory.is_empty() {
            if let Some(data_dir) = dirs::data_dir() {
                config.log_directory =
                    data_dir.join("hypercom").join("logs").display().to_string();
            }
        }

        Ok(Self {
            config,
            config_path,
        })
    }

    /// 默认配置路径：%APPDATA%/hypercom/config.json
    fn default_config_path() -> anyhow::Result<PathBuf> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("Failed to get config directory"))?
            .join("hypercom");
        fs::create_dir_all(&config_dir)?;
        Ok(config_dir.join("config.json"))
    }

    /// 从 `from_version` 顺序迁移到 CURRENT_CONFIG_VERSION。
    /// 每次版本升级对应一个 match 分支。当前为空（v0→v1 为基线）。
    fn migrate(json: &mut serde_json::Value, from_version: u32) {
        let obj = match json.as_object_mut() {
            Some(o) => o,
            None => return,
        };
        // 未来迁移示例：
        // if from_version < 2 {
        //     // v1→v2: 重命名旧字段、为新字段补默认值等
        // }
        obj.insert(
            "configVersion".to_string(),
            serde_json::json!(CURRENT_CONFIG_VERSION),
        );
        log::info!(
            "Config migrated from v{} to v{}",
            from_version,
            CURRENT_CONFIG_VERSION
        );
    }

    /// 当前配置文件路径
    pub fn config_path(&self) -> &std::path::Path {
        &self.config_path
    }

    /// 获取当前配置
    pub fn get_config(&self) -> &AppConfig {
        &self.config
    }

    /// 将配置值收敛到合法范围。每次 set_config 时调用。
    fn validate_and_clamp(config: &mut AppConfig) {
        config.terminal_font_size = config.terminal_font_size.clamp(8, 48);
        config.ui_font_size = config.ui_font_size.clamp(8, 48);
        config.memory_limit_mb = config.memory_limit_mb.clamp(64, 8192);
        config.max_retries = config.max_retries.clamp(1, 10);
        config.log_split_size_mb = config.log_split_size_mb.clamp(1, 10240);
        config.backup_interval = config.backup_interval.clamp(1, 720);
        // quick_send_slots 固定为 5 个槽位
        config.quick_send_slots.resize(5, None);
        // 校验枚举型字符串
        if !["minimize", "exit"].contains(&config.close_behavior.as_str()) {
            config.close_behavior = "minimize".to_string();
        }
        if !["light", "dark", "system"].contains(&config.theme.as_str()) {
            config.theme = "dark".to_string();
        }
        if !["zh-CN", "en-US"].contains(&config.language.as_str()) {
            config.language = "zh-CN".to_string();
        }
        if !["string", "hex", "binary"].contains(&config.log_format.as_str()) {
            config.log_format = "string".to_string();
        }
        if !["perLine", "perRound"].contains(&config.timestamp_mode.as_str()) {
            config.timestamp_mode = "perLine".to_string();
        }
        if !["absolute", "relative", "uptime"].contains(&config.timestamp_format.as_str()) {
            config.timestamp_format = "absolute".to_string();
        }
    }

    /// 更新配置并持久化（写入前校验 + 收敛，并刷新 schema 版本）
    pub fn set_config(&mut self, mut new_config: AppConfig) -> anyhow::Result<()> {
        Self::validate_and_clamp(&mut new_config);
        new_config.config_version = CURRENT_CONFIG_VERSION;
        self.config = new_config;
        self.save()
    }

    /// 仅更新 session_snapshot 字段并保存，不触碰其他配置值。
    /// 避免会话快照做全量配置保存时覆盖 ConfigModal 的并发修改（竞态）。
    pub fn update_session_snapshot(&mut self, snapshot: &str) -> anyhow::Result<()> {
        self.config.session_snapshot = snapshot.to_string();
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
        // Backup existing config before overwriting (best-effort).
        if self.config_path.exists() {
            let bak_path = self.config_path.with_extension("json.bak");
            let _ = fs::copy(&self.config_path, &bak_path);
        }
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
        assert_eq!(cfg.config_version, 1);
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
        assert!(cfg.auto_save_log);
        assert_eq!(cfg.log_format, "string");
        assert!(cfg.log_split_enabled);
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
