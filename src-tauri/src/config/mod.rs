/**
 * 配置管理模块 (Config Manager)
 * 负责应用配置的持久化存储与读取
 * 使用 JSON 文件存储在应用数据目录中
 *
 * 配置项涵盖：通用设置、日志设置、备份设置、显示设置、
 * 以及所有设置界面管理的实体（命令集/高亮规则/协议模板/触发规则/端口预设/工具配置）。
 *
 * 会话快照（session_snapshot）独立存储在 session.json，不进入 config.json，
 * 避免高频快照写入破坏 .bak 备份语义。
 */
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 当前配置 schema 版本号。
const CURRENT_CONFIG_VERSION: u32 = 1;

fn current_config_version() -> u32 {
    CURRENT_CONFIG_VERSION
}

// ==================== 设置实体类型（全部存入 config.json，camelCase 与前端 store 对齐）====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendCommandEntry {
    pub id: String,
    pub name: String,
    pub order: i32,
    pub delay: i32,
    /// "string" | "hex" — serde rename 使 JSON key 为 "type"（与前端 SendCommand.type 对齐）
    #[serde(rename = "type")]
    pub cmd_type: String,
    pub content: String,
    pub append_line_ending: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendCommandSetEntry {
    pub id: String,
    pub name: String,
    pub is_loop: bool,
    pub loop_delay: i32,
    /// 重复轮数: 0 = 跟随 is_loop, >0 = 发送 N 轮后停止。
    /// `#[serde(default)]` 保证旧版 config.json（无此字段）反序列化为 0。
    #[serde(default)]
    pub repeat_count: i32,
    pub commands: Vec<SendCommandEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRuleEntry {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub is_regex: bool,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRuleSetEntry {
    pub id: String,
    pub name: String,
    pub is_enabled: bool,
    pub rules: Vec<HighlightRuleEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolTemplateEntry {
    pub id: String,
    pub name: String,
    pub is_enabled: bool,
    pub header_bytes: String,
    pub length_field_offset: i32,
    pub length_field_size: i32,
    pub length_endian: String,
    pub length_adjust: i32,
    pub checksum_algorithm: String,
    pub checksum_offset: i32,
    pub footer_bytes: String,
    pub color_header: String,
    pub color_length: String,
    pub color_payload: String,
    pub color_checksum: String,
    pub color_footer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerRuleEntry {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub is_regex: bool,
    pub match_type: String,
    pub action_type: String,
    pub action_content: String,
    pub action_is_hex: bool,
    pub is_enabled: bool,
    /// 仅对该串口生效；None/空 = 全部端口（issue #3-1）
    #[serde(default)]
    pub port_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortPresetEntry {
    pub id: String,
    pub name: String,
    pub baud_rate: i32,
    pub data_bits: i32,
    pub parity: String,
    pub stop_bits: String,
    pub handshake: String,
    pub dtr: bool,
    pub rts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortToolConfigEntry {
    pub id: String,
    pub name: String,
    pub port_id: String,
    pub command: String,
    pub workdir: String,
}

/// 串口分组（issue #2-3 起持久化到 config.json）。
/// `port_ids` 记录组内成员及顺序；端口的 `groupId` 由前端在启动时
/// 根据成员关系回填到内存态端口列表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortGroupEntry {
    pub id: String,
    pub name: String,
    pub is_expanded: bool,
    pub port_ids: Vec<String>,
    pub order: i32,
}

// ==================== AppConfig ====================

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

    // --- 串口默认设置 ---
    pub default_baud_rates: Vec<u32>,
    pub default_line_ending: String, // "\\r\\n" | "\\r" | "\\n" | "None"
    pub send_prefix: String,
    pub show_port_type: bool,
    #[serde(default = "default_send_on_enter")]
    pub send_on_enter: bool,
    #[serde(default = "default_quick_send_inline_count")]
    pub quick_send_inline_count: u32,
    #[serde(default = "default_timestamp_format")]
    pub timestamp_format: String,

    // --- 时间戳设置 ---
    pub timestamp_mode: String, // "perLine" | "perRound"

    // --- 日志设置 ---
    pub auto_save_log: bool,
    pub log_directory: String,
    pub log_filename_format: String,
    pub log_format: String,   // "string" | "hex" | "binary"
    pub log_encoding: String, // "ASCII" | "UTF-8" | "GBK" | "ISO-8859-1"
    pub log_split_enabled: bool,
    pub log_split_size_mb: u32,
    /// 日志行前缀是否包含时间戳（issue #3-4）
    #[serde(default = "default_true")]
    pub log_include_timestamp: bool,
    /// 日志行前缀是否包含 RX/TX 方向标记（issue #3-4）
    #[serde(default = "default_true")]
    pub log_include_direction: bool,

    // --- 备份设置 ---
    pub backup_enabled: bool,
    pub backup_interval: u32, // 小时
    pub backup_directory: String,

    // --- 引导设置 ---
    #[serde(default)]
    pub has_seen_tour: bool,

    // --- 会话恢复 ---
    #[serde(default = "default_restore_session")]
    pub restore_session: bool,

    // --- 设置实体（全部存入 config.json，单文件即可完整迁移）---
    #[serde(default)]
    pub send_command_sets: Vec<SendCommandSetEntry>,
    #[serde(default)]
    pub highlight_rule_sets: Vec<HighlightRuleSetEntry>,
    #[serde(default)]
    pub protocol_templates: Vec<ProtocolTemplateEntry>,
    #[serde(default)]
    pub trigger_rules: Vec<TriggerRuleEntry>,
    #[serde(default)]
    pub port_presets: Vec<PortPresetEntry>,
    #[serde(default)]
    pub port_tool_configs: Vec<PortToolConfigEntry>,
    /// 串口分组布局（issue #2-3）：`#[serde(default)]` 使旧版 config.json
    /// （无此字段）反序列化为空列表。
    #[serde(default)]
    pub port_groups: Vec<PortGroupEntry>,
}

fn default_restore_session() -> bool {
    true
}

fn default_true() -> bool {
    true
}

fn default_send_on_enter() -> bool {
    true
}

fn default_quick_send_inline_count() -> u32 {
    6
}

fn default_timestamp_format() -> String {
    "absolute".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            config_version: CURRENT_CONFIG_VERSION,
            close_behavior: "exit".to_string(),
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
            default_baud_rates: vec![9600, 19200, 38400, 57600, 115200, 921600],
            default_line_ending: "\\r\\n".to_string(),
            send_prefix: ">>>>>>SEND>>>>>>>>".to_string(),
            show_port_type: true,
            send_on_enter: true,
            quick_send_inline_count: 6,
            timestamp_format: "absolute".to_string(),
            timestamp_mode: "perLine".to_string(),
            auto_save_log: true,
            log_directory: String::new(),
            log_filename_format: "[com]-[datetime]".to_string(),
            log_format: "string".to_string(),
            log_encoding: "UTF-8".to_string(),
            log_split_enabled: true,
            log_split_size_mb: 100,
            log_include_timestamp: true,
            log_include_direction: true,
            backup_enabled: false,
            backup_interval: 24,
            backup_directory: String::new(),
            has_seen_tour: false,
            restore_session: true,
            send_command_sets: Vec::new(),
            highlight_rule_sets: Vec::new(),
            protocol_templates: Vec::new(),
            trigger_rules: Vec::new(),
            port_presets: Vec::new(),
            port_tool_configs: Vec::new(),
            port_groups: Vec::new(),
        }
    }
}

// ==================== ConfigManager ====================

pub struct ConfigManager {
    config: AppConfig,
    config_path: PathBuf,
    /// 会话快照独立存储路径（config.json 同目录下 session.json）
    session_path: PathBuf,
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
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)?;
            }
            p
        } else if let Ok(env_path) = std::env::var("HYPERCOM_CONFIG") {
            let p = PathBuf::from(env_path);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)?;
            }
            p
        } else {
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

        let session_path = config_path.with_file_name("session.json");

        let mut config = if config_path.exists() {
            let content = fs::read_to_string(&config_path)?;
            match serde_json::from_str::<AppConfig>(&content) {
                Ok(cfg) => cfg,
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

        // 空 log_directory 解析为默认路径，确保前端和 LogManager 拿到真实目录。
        if config.log_directory.is_empty() {
            if let Some(data_dir) = dirs::data_dir() {
                config.log_directory =
                    data_dir.join("hypercom").join("logs").display().to_string();
            }
        }

        Ok(Self {
            config,
            config_path,
            session_path,
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

    /// 当前配置文件路径
    pub fn config_path(&self) -> &std::path::Path {
        &self.config_path
    }

    /// 获取当前配置
    pub fn get_config(&self) -> &AppConfig {
        &self.config
    }

    /// 获取可变配置引用（供 CRUD 命令直接操作实体数组）
    pub fn get_config_mut(&mut self) -> &mut AppConfig {
        &mut self.config
    }

    /// 将配置值收敛到合法范围。每次 set_config 时调用。
    fn validate_and_clamp(config: &mut AppConfig) {
        config.terminal_font_size = config.terminal_font_size.clamp(8, 48);
        config.ui_font_size = config.ui_font_size.clamp(8, 48);
        config.memory_limit_mb = config.memory_limit_mb.clamp(64, 8192);
        config.max_retries = config.max_retries.clamp(1, 10);
        config.log_split_size_mb = config.log_split_size_mb.clamp(1, 10240);
        config.backup_interval = config.backup_interval.clamp(1, 720);
        config.quick_send_inline_count = config.quick_send_inline_count.clamp(0, 20);
        if !["minimize", "exit"].contains(&config.close_behavior.as_str()) {
            config.close_behavior = "exit".to_string();
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
        if !["ASCII", "UTF-8", "GBK", "ISO-8859-1"].contains(&config.log_encoding.as_str()) {
            config.log_encoding = "UTF-8".to_string();
        }
        if !["\\r\\n", "\\r", "\\n", "None"].contains(&config.default_line_ending.as_str()) {
            config.default_line_ending = "\\r\\n".to_string();
        }
    }

    /// 更新配置并持久化（写入前校验 + 收敛）
    pub fn set_config(&mut self, mut new_config: AppConfig) -> anyhow::Result<()> {
        Self::validate_and_clamp(&mut new_config);
        new_config.config_version = CURRENT_CONFIG_VERSION;
        self.config = new_config;
        self.save()
    }

    /// 重置为默认配置
    pub fn reset_to_default(&mut self) -> anyhow::Result<AppConfig> {
        self.config = AppConfig::default();
        self.save()?;
        Ok(self.config.clone())
    }

    // ==================== 会话快照（独立 session.json）====================

    /// 读取会话快照。文件不存在或损坏时返回空字符串。
    pub fn load_session_snapshot(&self) -> String {
        if self.session_path.exists() {
            match fs::read_to_string(&self.session_path) {
                Ok(content) => {
                    // session.json 格式: {"snapshot": "..."}
                    serde_json::from_str::<serde_json::Value>(&content)
                        .ok()
                        .and_then(|v| v.get("snapshot").and_then(|s| s.as_str()).map(String::from))
                        .unwrap_or_default()
                }
                Err(_) => String::new(),
            }
        } else {
            String::new()
        }
    }

    /// 写入会话快照到独立 session.json（不触发 config .bak 备份）。
    pub fn save_session_snapshot(&self, snapshot: &str) -> anyhow::Result<()> {
        let wrapper = serde_json::json!({ "snapshot": snapshot });
        let content = serde_json::to_string(&wrapper)?;
        let tmp_path = self.session_path.with_extension("json.tmp");
        {
            let mut file = fs::File::create(&tmp_path)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
        }
        fs::rename(&tmp_path, &self.session_path)?;
        Ok(())
    }

    // ==================== 持久化 ====================

    /// 保存配置到文件（原子写入 + .bak 备份）
    pub fn save(&self) -> anyhow::Result<()> {
        let content = serde_json::to_string_pretty(&self.config)?;
        if self.config_path.exists() {
            let bak_path = self.config_path.with_extension("json.bak");
            let _ = fs::copy(&self.config_path, &bak_path);
        }
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

    #[test]
    fn test_default_values() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.config_version, 1);
        assert_eq!(cfg.quick_send_inline_count, 6);
        assert_eq!(cfg.close_behavior, "exit");
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
        assert_eq!(cfg.log_encoding, "UTF-8");
        assert!(cfg.log_split_enabled);
        assert_eq!(cfg.log_split_size_mb, 100);
        // issue #3-4：日志行前缀开关默认开启（向后兼容旧行为）
        assert!(cfg.log_include_timestamp);
        assert!(cfg.log_include_direction);
        assert!(!cfg.backup_enabled);
        assert!(!cfg.has_seen_tour);
        assert!(cfg.restore_session);
        assert!(cfg.send_command_sets.is_empty());
        assert!(cfg.highlight_rule_sets.is_empty());
        assert!(cfg.protocol_templates.is_empty());
        assert!(cfg.trigger_rules.is_empty());
        assert!(cfg.port_presets.is_empty());
        assert!(cfg.port_tool_configs.is_empty());
        assert!(cfg.port_groups.is_empty());
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
        assert_eq!(parsed.log_encoding, cfg.log_encoding);
    }

    #[test]
    fn test_json_camel_case() {
        let cfg = AppConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        for key in [
            "closeBehavior", "memoryLimitMb", "autoSaveLog", "logFormat",
            "logEncoding", "terminalFontSize", "autoReconnect", "maxRetries",
            "hasSeenTour", "restoreSession", "quickSendInlineCount",
            "sendCommandSets", "highlightRuleSets", "protocolTemplates",
            "triggerRules", "portPresets", "portToolConfigs", "portGroups",
            "logIncludeTimestamp", "logIncludeDirection", // issue #3-4
        ] {
            assert!(json.contains(key), "missing {} in JSON", key);
        }
        // session_snapshot 不应出现在 config JSON 中
        assert!(!json.contains("sessionSnapshot"), "sessionSnapshot must not be in config.json");
    }

    #[test]
    fn test_log_prefix_fields_default_when_absent() {
        // issue #3-4：旧 config.json 没有 logIncludeTimestamp / logIncludeDirection，
        // 反序列化必须回退到默认 true（serde(default = "default_true")）。
        // 使用 0.3.1 真实 schema 的完整 JSON，仅省略这两个新字段。
        let old_json = r#"{
            "configVersion": 1, "closeBehavior": "exit", "memoryLimitMb": 1024,
            "language": "zh-CN", "theme": "dark", "preventScreenOff": false,
            "preventSleep": false, "autoReconnect": false, "maxRetries": 3,
            "terminalFont": "Consolas, monospace", "terminalFontSize": 14,
            "uiFont": "Inter, sans-serif", "uiFontSize": 14,
            "defaultBaudRates": [9600, 19200, 38400, 57600, 115200, 921600],
            "defaultLineEnding": "\\r\\n", "sendPrefix": "SEND", "showPortType": true,
            "sendOnEnter": true, "quickSendInlineCount": 6, "timestampFormat": "absolute",
            "timestampMode": "perLine", "autoSaveLog": true, "logDirectory": "",
            "logFilenameFormat": "[com]-[datetime]", "logFormat": "string",
            "logEncoding": "UTF-8", "logSplitEnabled": true, "logSplitSizeMb": 100,
            "backupEnabled": false, "backupInterval": 24, "backupDirectory": "",
            "hasSeenTour": false, "restoreSession": true,
            "sendCommandSets": [], "highlightRuleSets": [], "protocolTemplates": [],
            "triggerRules": [], "portPresets": [], "portToolConfigs": [], "portGroups": []
        }"#;
        let cfg: AppConfig = serde_json::from_str(old_json).unwrap();
        assert!(cfg.log_include_timestamp);
        assert!(cfg.log_include_direction);
    }

    #[test]
    fn test_trigger_rule_port_id_optional() {
        // issue #3-1：旧 config.json 的 trigger 规则没有 portId，反序列化回退 None；
        // 新规则带 portId 时 camelCase 序列化往返一致。
        let old_rule: TriggerRuleEntry = serde_json::from_str(
            r#"{"id":"r1","name":"n","pattern":"p","isRegex":false,
                "matchType":"contains","actionType":"alert",
                "actionContent":"","actionIsHex":false,"isEnabled":true}"#,
        )
        .unwrap();
        assert!(old_rule.port_id.is_none());

        let rule = TriggerRuleEntry {
            port_id: Some("COM3".to_string()),
            ..old_rule
        };
        let json = serde_json::to_string(&rule).unwrap();
        assert!(json.contains(r#""portId":"COM3""#), "got: {json}");
    }

    #[test]
    fn test_validate_and_clamp_enums() {
        let mut cfg = AppConfig {
            log_encoding: "INVALID".to_string(),
            default_line_ending: "BAD".to_string(),
            log_format: "xml".to_string(),
            ..AppConfig::default()
        };
        ConfigManager::validate_and_clamp(&mut cfg);
        assert_eq!(cfg.log_encoding, "UTF-8");
        assert_eq!(cfg.default_line_ending, "\\r\\n");
        assert_eq!(cfg.log_format, "string");
    }

    #[test]
    fn test_validate_and_clamp_ranges() {
        let mut cfg = AppConfig {
            quick_send_inline_count: 99,
            terminal_font_size: 200,
            memory_limit_mb: 0,
            max_retries: 0,
            ..AppConfig::default()
        };
        ConfigManager::validate_and_clamp(&mut cfg);
        assert_eq!(cfg.quick_send_inline_count, 20);
        assert_eq!(cfg.terminal_font_size, 48);
        assert_eq!(cfg.memory_limit_mb, 64);
        assert_eq!(cfg.max_retries, 1);
    }

    #[test]
    fn test_entity_types_camel_case_serialization() {
        let cmd = SendCommandEntry {
            id: "c1".into(),
            name: "Ping".into(),
            order: 0,
            delay: 100,
            cmd_type: "string".into(),
            content: "AT".into(),
            append_line_ending: "\\r\\n".into(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"string\""), "cmd_type should serialize as 'type': {}", json);
        assert!(json.contains("\"appendLineEnding\""), "should be camelCase: {}", json);
        assert!(!json.contains("cmd_type"), "should not contain snake_case key: {}", json);

        let preset = PortPresetEntry {
            id: "p1".into(),
            name: "Modbus".into(),
            baud_rate: 19200,
            data_bits: 8,
            parity: "Even".into(),
            stop_bits: "One".into(),
            handshake: "None".into(),
            dtr: true,
            rts: false,
        };
        let json = serde_json::to_string(&preset).unwrap();
        assert!(json.contains("\"baudRate\""), "should be camelCase: {}", json);
        assert!(json.contains("\"dtr\":true"), "dtr should be bool: {}", json);
    }

    #[test]
    fn test_missing_entity_fields_default_to_empty() {
        // 模拟一个不含实体数组的 JSON（如全新安装）
        let json = r#"{"configVersion":1,"closeBehavior":"exit","memoryLimitMb":1024,
            "language":"zh-CN","theme":"dark","preventScreenOff":false,"preventSleep":false,
            "autoReconnect":false,"maxRetries":3,"terminalFont":"mono","terminalFontSize":14,
            "uiFont":"sans","uiFontSize":14,"backgroundImage":null,
            "defaultBaudRates":[9600],"defaultLineEnding":"\\r\\n","sendPrefix":">>",
            "showPortType":true,"sendOnEnter":true,"quickSendInlineCount":6,
            "timestampFormat":"absolute","timestampMode":"perLine",
            "autoSaveLog":true,"logDirectory":"","logFilenameFormat":"[com]",
            "logFormat":"string","logEncoding":"UTF-8","logSplitEnabled":true,
            "logSplitSizeMb":100,"backupEnabled":false,"backupInterval":24,
            "backupDirectory":"","hasSeenTour":false,"restoreSession":true}"#;
        let parsed: AppConfig = serde_json::from_str(json).unwrap();
        assert!(parsed.send_command_sets.is_empty());
        assert!(parsed.highlight_rule_sets.is_empty());
        assert!(parsed.port_presets.is_empty());
        assert!(parsed.port_groups.is_empty());
    }

    #[test]
    fn test_port_group_entry_camel_case_serialization() {
        let group = PortGroupEntry {
            id: "group-1".into(),
            name: "开发板".into(),
            is_expanded: true,
            port_ids: vec!["COM1".into(), "COM12".into()],
            order: 0,
        };
        let json = serde_json::to_string(&group).unwrap();
        assert!(json.contains("\"isExpanded\":true"), "should be camelCase: {}", json);
        assert!(json.contains("\"portIds\""), "should be camelCase: {}", json);
        assert!(!json.contains("port_ids"), "should not contain snake_case key: {}", json);
        // 完整往返
        let parsed: PortGroupEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.port_ids, vec!["COM1".to_string(), "COM12".to_string()]);
    }

    #[test]
    fn test_session_snapshot_roundtrip() {
        let dir = std::env::temp_dir().join("hypercom_test_session");
        let _ = fs::create_dir_all(&dir);
        let config_path = dir.join("config.json");
        let session_path = dir.join("session.json");
        let _ = fs::remove_file(&config_path);
        let _ = fs::remove_file(&session_path);

        let mgr = ConfigManager {
            config: AppConfig::default(),
            config_path: config_path.clone(),
            session_path: session_path.clone(),
        };

        // 初始为空
        assert_eq!(mgr.load_session_snapshot(), "");

        // 写入后读回
        mgr.save_session_snapshot(r#"{"tabs":[]}"#).unwrap();
        assert_eq!(mgr.load_session_snapshot(), r#"{"tabs":[]}"#);

        // session.json 存在但 config.json 不受影响
        assert!(session_path.exists());
        assert!(!config_path.exists()); // save_session_snapshot 不写 config

        let _ = fs::remove_dir_all(&dir);
    }
}
