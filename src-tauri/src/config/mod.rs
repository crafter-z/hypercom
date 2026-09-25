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
 *
 * schema 迁移口径：没有 `configVersion` 字段，也没有版本分派。向前兼容只靠三件事——
 * 1) serde：`AppConfig` 容器级 `#[serde(default)]`（缺字段取 `impl Default` 的值），
 *    实体子结构再各自带字段级 `#[serde(default)]`；
 * 2) 解析前的 `strip_legacy_memory_budget_keys`：在 Value 层物理删除已被取代的旧 key；
 * 3) 解析后的 `normalize_legacy_serial_enums`：把持久化实体里已收窄的自由字符串枚举
 *    （端口预设的帧格式）一次性收敛到合法取值，下次 save 落盘即已归一。
 * 曾有的 `configVersion` 是「每次 set_config 无条件重写为 1」的装饰品——既不参与分派
 * 也不影响解析（旧值只是被 serde 当未知字段丢弃），故删除。
 */
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 数值设置边界（唯一来源）。必须与前端 `src/utils/bounds.ts` 的 `CONFIG_BOUNDS` 逐项相等，
/// 由 `src/utils/bounds.test.ts` 解析本常量断言——两侧漂移会让用户输入被静默丢弃
/// （曾出现前端允许 8..96 而后端 clamp 到 8..48）。
///
/// 元组格式固定为 `("name", min, max)`：前端测试用正则按此解析，故数值不写下划线分隔符。
pub const CONFIG_BOUNDS: &[(&str, i64, i64)] = &[
    ("terminalFontSize", 8, 48),
    ("uiFontSize", 8, 48),
    ("maxDisplayLines", 1000, 1000000),
    ("maxRetries", 1, 10),
    ("logSplitSizeMb", 1, 10240),
    ("backupInterval", 1, 720),
    ("quickSendInlineCount", 0, 20),
    ("backgroundImageOpacity", 0, 100),
    ("backgroundImageBlur", 0, 64),
];

/// 按名字查 `CONFIG_BOUNDS` 收敛数值。
/// 名字缺失是编程错误（调用点与本表一一对应），直接 panic 而非静默不收敛——
/// 静默不收敛正是「非法值落盘」这类缺陷的来源。
fn clamp_bound(name: &str, value: i64) -> i64 {
    let (_, min, max) = CONFIG_BOUNDS
        .iter()
        .find(|(n, _, _)| *n == name)
        .unwrap_or_else(|| panic!("CONFIG_BOUNDS is missing an entry for '{name}'"));
    value.clamp(*min, *max)
}

/// 枚举字段收敛：值不在 `allowed` 内时替换为 `fallback`（该字段的默认值）。
fn restrict(value: &mut String, allowed: &[&str], fallback: &str) {
    if !allowed.contains(&value.as_str()) {
        *value = fallback.to_string();
    }
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

/// 串口元数据（备注名 / 隐藏状态 / 工作模式，issue #4-9；模式字段 issue #11）。
/// 备注名与隐藏状态是端口级 UI 状态，此前仅存内存、重启即丢；
/// 现在随 config.json 持久化，启动时按 `port_id` 回填到端口列表。
/// `#[serde(default)]` 保证旧版 config.json（无此字段）反序列化为空 Vec。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortMetaEntry {
    pub port_id: String,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub is_hidden: bool,
    /// 端口工作模式（issue #11）：`"trx"`（传统收发）| `"tty"`（终端模式）。
    /// `None` 或缺省 = trx。前端持久化 mode 时经此字段往返——缺失该字段会导致
    /// serde 静默丢弃未知字段，TTY 模式重启即丢（曾为此缺陷）。
    #[serde(default)]
    pub mode: Option<String>,
}

// ==================== 设置实体集合 ====================

/// 设置界面管理的实体集合。
///
/// `#[serde(flatten)]` 让这些数组在 config.json 里仍是**顶层 key**（线格式零变化），
/// 同时把「实体列表」与「标量设置」分成两层：实体只有 CRUD 语义（`commands/storage.rs`），
/// 标量只有收敛与默认值语义（`validate_and_clamp` / `impl Default`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entities {
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
    /// 串口分组布局（issue #2-3）：旧版 config.json（无此字段）反序列化为空列表。
    #[serde(default)]
    pub port_groups: Vec<PortGroupEntry>,
    /// 串口备注名 / 隐藏状态（issue #4-9）：随 config.json 持久化。
    #[serde(default)]
    pub port_meta: Vec<PortMetaEntry>,
}

// ==================== AppConfig ====================

/// 应用全局配置。
///
/// 容器级 `#[serde(default)]`：任何缺失字段都取 `impl Default` 的值。这既是「旧
/// config.json 缺新字段」的唯一迁移机制，也让默认值只有一个来源——字段级
/// `#[serde(default = "...")]` 与 `impl Default` 两份手抄曾出现不一致而无任何编译错误。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    // --- 通用设置 ---
    /// "minimize"（最小化到托盘）| "exit"
    pub close_behavior: String,
    /// 终端缓冲区最大显示行数（超限时逐行覆盖最旧行）。
    /// 取代旧版内存预算字段（memoryLimitMb / memoryPerPortBudgetMb）。
    pub max_display_lines: u32,
    /// "zh-CN" | "en-US"
    pub language: String,
    /// "light" | "dark" | "system"
    pub theme: String,
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

    // --- 背景图设置（自定义背景图片，issue #13）---
    pub background_image: String,
    pub background_image_enabled: bool,
    pub background_image_opacity: u32,
    pub background_image_blur: u32,

    // --- 串口默认设置 ---
    pub default_baud_rates: Vec<u32>,
    /// "\\r\\n" | "\\r" | "\\n" | "None"
    pub default_line_ending: String,
    pub send_prefix: String,
    pub show_port_type: bool,
    pub send_on_enter: bool,
    /// 点击发送后是否清空发送输入框（issue #13，默认保留）。
    pub clear_send_input_after_send: bool,
    pub quick_send_inline_count: u32,
    pub timestamp_format: String,

    // --- 时间戳设置 ---
    /// "perLine" | "perRound"
    pub timestamp_mode: String,

    // --- 日志设置 ---
    pub auto_save_log: bool,
    pub log_directory: String,
    pub log_filename_format: String,
    /// "string" | "hex" | "binary"
    pub log_format: String,
    /// "ASCII" | "UTF-8" | "GBK" | "ISO-8859-1"
    pub log_encoding: String,
    pub log_split_enabled: bool,
    pub log_split_size_mb: u32,
    /// 日志行前缀是否包含时间戳（issue #3-4）
    pub log_include_timestamp: bool,
    /// 日志行前缀是否包含 RX/TX 方向标记（issue #3-4）
    pub log_include_direction: bool,
    /// 日志子目录策略（issue #5-10）："none"（直接存入日志目录）| "date"（按日期分文件夹）| "port"（按串口号分文件夹）
    pub log_subdir_mode: String,
    /// 每次打开串口新建日志文件（不续写已有文件）：true 时每次连接都从空文件开始
    pub log_new_file_per_session: bool,

    // --- 备份设置 ---
    pub backup_enabled: bool,
    /// 小时
    pub backup_interval: u32,
    pub backup_directory: String,

    // --- 会话恢复 ---
    pub restore_session: bool,

    // --- 诊断日志 ---
    /// 是否启用应用自身维测日志（前后端统一落盘到诊断日志文件）。
    pub diag_log_enabled: bool,

    // --- 自动更新（issue #12）---
    /// 自动检查更新模式：`"none"`（不检查）| `"stable"`（定期到正式版）| `"preview"`（定期到 preview）。
    /// 检查周期统一 7 天（前端 localStorage 记账 lastCheckAt/snoozeUntil）。
    pub update_check_mode: String,

    // --- 设置实体（config.json 顶层 key，见 Entities）---
    #[serde(flatten)]
    pub entities: Entities,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            close_behavior: "exit".to_string(),
            // 终端缓冲区最大显示行数默认 100000 行。
            max_display_lines: 100000,
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
            background_image: String::new(),
            background_image_enabled: false,
            background_image_opacity: 50,
            background_image_blur: 0,
            default_baud_rates: vec![9600, 19200, 38400, 57600, 115200, 921600],
            default_line_ending: "\\r\\n".to_string(),
            // issue #7-3：终端已有 TX/RX 方向标识，发送提示前缀默认留空。
            send_prefix: String::new(),
            show_port_type: true,
            send_on_enter: true,
            // issue #13：默认发送后保留输入框内容。
            clear_send_input_after_send: false,
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
            // issue #5-10：日志子目录策略默认按日期分文件夹。
            log_subdir_mode: "date".to_string(),
            log_new_file_per_session: false,
            backup_enabled: false,
            backup_interval: 24,
            backup_directory: String::new(),
            restore_session: true,
            diag_log_enabled: true,
            // issue #12：自动更新默认「定期检查到正式版」（用户决策，2026-08-15）。
            update_check_mode: "stable".to_string(),
            entities: Entities::default(),
        }
    }
}

/// 升级剥离：旧 config.json 的 memoryLimitMb / memoryPerPortBudgetMb 已由
/// maxDisplayLines 取代。serde 对未知字段会静默丢弃，但为让下次 save 落盘
/// 即物理移除旧 key，这里在解析前于 Value 层显式删除。非合法 JSON 返回 None。
fn strip_legacy_memory_budget_keys(raw: &str) -> Option<serde_json::Value> {
    let mut value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    if let Some(obj) = value.as_object_mut() {
        let removed = obj.remove("memoryLimitMb").is_some()
            || obj.remove("memoryPerPortBudgetMb").is_some();
        if removed {
            log::info!("Migrated config: removed legacy memoryLimitMb/memoryPerPortBudgetMb");
        }
    }
    Some(value)
}

/// 加载期归一化：把旧 config.json 里已收窄的串口帧格式自由字符串收敛到合法取值。
///
/// `PortPresetEntry` 的 parity / stop_bits / handshake 是自由字符串，旧版 UI 允许
/// serialport 无法表达的取值（校验位 Mark/Space、停止位 OnePointFive）。本轮把这些
/// 枚举收窄后 `serial::ports_real` 的 `parse_parity` / `parse_stop_bits` 对未知值返回
/// Err——旧预设会在开串口时报 "Unsupported parity"，而 UI select 也显示不出来。
/// 加载期一次性收敛，下次 save 落盘即已归一（与 `strip_legacy_memory_budget_keys`
/// 同款口径）。**只处理持久化实体**（会话快照由前端恢复，不经过这里）。
///
/// 规则（左 = 非法，右 = 归一值）：
/// - `parity`    不在 {None, Even, Odd} → None
/// - `stop_bits` 不在 {One, Two} → One
/// - `data_bits` 不在 {5, 6, 7, 8} → 8
/// - `handshake` 不在 {None, XonXoff, RequestToSend, RequestToSendXonXoff} → None
///
/// 下面的集合必须与 `serial/ports_real.rs` 的 `parse_*` 接受集合逐项相等：归一化集合
/// 比解析集合**窄**会把合法值误改成默认值（用户静默丢配置），比它**宽**则会放过非法值。
/// 新增帧格式取值时两处一起改（parse_* 旁边有对应提示）。
fn normalize_legacy_serial_enums(config: &mut AppConfig) {
    // 与 `parse_parity` 接受集合逐项相等。
    const PARITIES: &[&str] = &["None", "Even", "Odd"];
    // 与 `parse_stop_bits` 接受集合逐项相等。
    const STOP_BITS: &[&str] = &["One", "Two"];
    // 与 `parse_flow_control` 接受集合逐项相等。
    const HANDSHAKES: &[&str] = &["None", "XonXoff", "RequestToSend", "RequestToSendXonXoff"];

    for preset in &mut config.entities.port_presets {
        if !PARITIES.contains(&preset.parity.as_str()) {
            log::info!(
                "Migrated port preset {} parity '{}' -> None",
                preset.id,
                preset.parity
            );
            preset.parity = "None".to_string();
        }
        if !STOP_BITS.contains(&preset.stop_bits.as_str()) {
            log::info!(
                "Migrated port preset {} stop bits '{}' -> One",
                preset.id,
                preset.stop_bits
            );
            preset.stop_bits = "One".to_string();
        }
        if !matches!(preset.data_bits, 5 | 6 | 7 | 8) {
            log::info!(
                "Migrated port preset {} data bits {} -> 8",
                preset.id,
                preset.data_bits
            );
            preset.data_bits = 8;
        }
        if !HANDSHAKES.contains(&preset.handshake.as_str()) {
            log::info!(
                "Migrated port preset {} handshake '{}' -> None",
                preset.id,
                preset.handshake
            );
            preset.handshake = "None".to_string();
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
            // 升级兼容：旧 config.json 的 memoryLimitMb / memoryPerPortBudgetMb 已由
            // maxDisplayLines 取代——解析前在 Value 层显式剥离，下次 save 落盘即无旧 key。
            let stripped = strip_legacy_memory_budget_keys(&content);
            let result = stripped
                .ok_or_else(|| anyhow::anyhow!("config.json is not valid JSON"))
                .and_then(|v| serde_json::from_value::<AppConfig>(v).map_err(anyhow::Error::from));
            match result {
                Ok(cfg) => cfg,
                Err(e) => {
                    log::warn!("Config file corrupt ({}), attempting .bak recovery", e);
                    let bak_path = config_path.with_extension("json.bak");
                    if bak_path.exists() {
                        let bak_content = fs::read_to_string(&bak_path)?;
                        strip_legacy_memory_budget_keys(&bak_content)
                            .and_then(|v| serde_json::from_value::<AppConfig>(v).ok())
                            .unwrap_or_default()
                    } else {
                        log::warn!("No .bak available, using defaults");
                        AppConfig::default()
                    }
                }
            }
        } else {
            AppConfig::default()
        };

        // 升级归一化：旧预设里的自由字符串帧格式（Mark / OnePointFive 等）收敛到
        // 合法取值。放在 load 之后、任何返回之前，三条路径（正常解析 / .bak 恢复 /
        // 默认）都覆盖；幂等，无旧值时不改动任何字段。
        normalize_legacy_serial_enums(&mut config);

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
    /// 数值边界来自 `CONFIG_BOUNDS`（与前端 bounds.ts 同一张表），此处不写字面量。
    fn validate_and_clamp(config: &mut AppConfig) {
        config.terminal_font_size =
            clamp_bound("terminalFontSize", config.terminal_font_size as i64) as u32;
        config.ui_font_size = clamp_bound("uiFontSize", config.ui_font_size as i64) as u32;
        config.max_display_lines =
            clamp_bound("maxDisplayLines", config.max_display_lines as i64) as u32;
        config.max_retries = clamp_bound("maxRetries", config.max_retries as i64) as u8;
        config.log_split_size_mb =
            clamp_bound("logSplitSizeMb", config.log_split_size_mb as i64) as u32;
        config.backup_interval = clamp_bound("backupInterval", config.backup_interval as i64) as u32;
        config.quick_send_inline_count =
            clamp_bound("quickSendInlineCount", config.quick_send_inline_count as i64) as u32;
        config.background_image_opacity =
            clamp_bound("backgroundImageOpacity", config.background_image_opacity as i64) as u32;
        config.background_image_blur =
            clamp_bound("backgroundImageBlur", config.background_image_blur as i64) as u32;

        restrict(&mut config.close_behavior, &["minimize", "exit"], "exit");
        restrict(&mut config.theme, &["light", "dark", "system"], "dark");
        restrict(&mut config.language, &["zh-CN", "en-US"], "zh-CN");
        restrict(&mut config.log_format, &["string", "hex", "binary"], "string");
        restrict(
            &mut config.timestamp_mode,
            &["perLine", "perRound"],
            "perLine",
        );
        restrict(
            &mut config.timestamp_format,
            &["absolute", "relative", "uptime"],
            "absolute",
        );
        restrict(
            &mut config.log_encoding,
            &["ASCII", "UTF-8", "GBK", "ISO-8859-1"],
            "UTF-8",
        );
        restrict(&mut config.log_subdir_mode, &["none", "date", "port"], "date");
        // issue #12：自动更新模式钳制——非法值（含旧版残留）收敛回 stable。
        restrict(
            &mut config.update_check_mode,
            &["none", "stable", "preview"],
            "stable",
        );
        restrict(
            &mut config.default_line_ending,
            &["\\r\\n", "\\r", "\\n", "None"],
            "\\r\\n",
        );
        // issue #11：端口工作模式钳制——非法值（含旧版残留的任意字符串）收敛回 trx。
        for meta in &mut config.entities.port_meta {
            if let Some(mode) = &mut meta.mode {
                if mode != "trx" && mode != "tty" {
                    *mode = "trx".to_string();
                }
            }
        }
    }

    /// 更新配置并持久化（写入前校验 + 收敛）
    pub fn set_config(&mut self, mut new_config: AppConfig) -> anyhow::Result<()> {
        Self::validate_and_clamp(&mut new_config);
        self.config = new_config;
        self.save()
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

    /// 保存配置到文件（原子写入 + .bak 备份）。
    /// 失败时记录错误日志（诊断日志排查需要落盘根因，而非仅返回 Result）。
    pub fn save(&self) -> anyhow::Result<()> {
        let result = (|| -> anyhow::Result<()> {
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
        })();
        if let Err(e) = &result {
            log::error!("Failed to save config to {:?}: {}", self.config_path, e);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// 0.3.1 真实 schema 的 config.json 夹具（全仓唯一一份手抄）。
    ///
    /// 有意保留此后被删除/取代的遗留 key：`configVersion`、`memoryLimitMb`、
    /// `memoryPerPortBudgetMb`、`hasSeenTour`；有意不含此后新增的字段
    /// （logIncludeTimestamp / logIncludeDirection / logSubdirMode /
    /// logNewFilePerSession / diagLogEnabled / portMeta / maxDisplayLines …）。
    /// 因此每个「旧 JSON 仍能反序列化」用例都从它出发，只用自己的补丁表达差异。
    const LEGACY_V0_CONFIG: &str = r#"{
        "configVersion": 1, "closeBehavior": "exit", "memoryLimitMb": 1024,
        "memoryPerPortBudgetMb": 200,
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

    /// 在 `LEGACY_V0_CONFIG` 上做顶层浅合并补丁（`serde_json::json!` 增量）。
    fn legacy_json(patch: serde_json::Value) -> serde_json::Value {
        let mut base: serde_json::Value = serde_json::from_str(LEGACY_V0_CONFIG).unwrap();
        let base_obj = base.as_object_mut().unwrap();
        for (key, value) in patch.as_object().unwrap() {
            base_obj.insert(key.clone(), value.clone());
        }
        base
    }

    /// 旧 JSON（+ 可选补丁）→ AppConfig。
    fn legacy_config(patch: serde_json::Value) -> AppConfig {
        serde_json::from_value(legacy_json(patch)).unwrap()
    }

    fn bound(name: &str) -> (i64, i64) {
        let (_, min, max) = CONFIG_BOUNDS
            .iter()
            .find(|(n, _, _)| *n == name)
            .unwrap_or_else(|| panic!("missing bound {name}"));
        (*min, *max)
    }

    #[test]
    fn test_default_values() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.quick_send_inline_count, 6);
        assert_eq!(cfg.close_behavior, "exit");
        // 终端缓冲区最大显示行数默认 100000 行，取代旧内存预算字段。
        assert_eq!(cfg.max_display_lines, 100000);
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
        // issue #7-3：发送提示前缀默认留空（终端已有 TX/RX 方向标识）
        assert_eq!(cfg.send_prefix, "");
        assert_eq!(cfg.timestamp_mode, "perLine");
        assert!(cfg.auto_save_log);
        assert_eq!(cfg.log_format, "string");
        assert_eq!(cfg.log_encoding, "UTF-8");
        assert!(cfg.log_split_enabled);
        assert_eq!(cfg.log_split_size_mb, 100);
        // issue #5-10：日志子目录策略默认按日期分文件夹
        assert_eq!(cfg.log_subdir_mode, "date");
        assert!(!cfg.backup_enabled);
        assert!(cfg.restore_session);
        assert!(cfg.diag_log_enabled);
    }

    #[test]
    fn test_default_entities_are_empty() {
        let cfg = AppConfig::default();
        assert!(cfg.entities.send_command_sets.is_empty());
        assert!(cfg.entities.highlight_rule_sets.is_empty());
        assert!(cfg.entities.protocol_templates.is_empty());
        assert!(cfg.entities.trigger_rules.is_empty());
        assert!(cfg.entities.port_presets.is_empty());
        assert!(cfg.entities.port_tool_configs.is_empty());
        assert!(cfg.entities.port_groups.is_empty());
        assert!(cfg.entities.port_meta.is_empty());
    }

    #[test]
    fn test_json_roundtrip() {
        let cfg = AppConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.close_behavior, cfg.close_behavior);
        assert_eq!(parsed.max_display_lines, cfg.max_display_lines);
        assert_eq!(parsed.language, cfg.language);
        assert_eq!(parsed.auto_save_log, cfg.auto_save_log);
        assert_eq!(parsed.log_encoding, cfg.log_encoding);
    }

    #[test]
    fn test_json_camel_case_and_flat_entities() {
        let cfg = AppConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        for key in [
            "closeBehavior",
            "maxDisplayLines",
            "autoSaveLog",
            "logFormat",
            "logEncoding",
            "terminalFontSize",
            "autoReconnect",
            "maxRetries",
            "restoreSession",
            "quickSendInlineCount",
            "diagLogEnabled",
            "logIncludeTimestamp",
            "logIncludeDirection",
            "logSubdirMode",
        ] {
            assert!(json.contains(key), "missing {} in JSON", key);
        }
        // 实体数组必须仍是顶层 key（#[serde(flatten)]）——嵌套会破坏 config.json 线格式。
        for key in [
            "sendCommandSets",
            "highlightRuleSets",
            "protocolTemplates",
            "triggerRules",
            "portPresets",
            "portToolConfigs",
            "portGroups",
            "portMeta",
        ] {
            assert!(json.contains(key), "missing flattened entity key {} in JSON", key);
        }
        assert!(!json.contains("\"entities\""), "entities must be flattened: {json}");
        // 实体数组形态（非嵌套对象）时值也是数组字面量。
        assert!(json.contains("\"portGroups\":[]"), "got: {json}");
        // session_snapshot 不应出现在 config JSON 中
        assert!(!json.contains("sessionSnapshot"), "sessionSnapshot must not be in config.json");
        // configVersion 已删除（迁移只靠 serde default + strip_legacy_*）
        assert!(!json.contains("configVersion"), "configVersion must be gone: {json}");
    }

    #[test]
    fn test_legacy_json_deserializes_with_defaults_for_new_fields() {
        // 0.3.1 的真实 config.json（无本轮之后新增的任何字段）必须能完整反序列化，
        // 且每个新字段回退到 impl Default 的值（容器级 #[serde(default)]）。
        let cfg = legacy_config(serde_json::json!({}));
        assert!(cfg.log_include_timestamp);
        assert!(cfg.log_include_direction);
        assert_eq!(cfg.log_subdir_mode, "date");
        assert!(!cfg.log_new_file_per_session);
        assert!(cfg.diag_log_enabled);
        assert_eq!(cfg.update_check_mode, "stable");
        // 旧 memoryLimitMb 被 maxDisplayLines 取代 → 取默认 100000
        assert_eq!(cfg.max_display_lines, 100000);
        // issue #13 背景图字段
        assert!(!cfg.background_image_enabled);
        assert_eq!(cfg.background_image_opacity, 50);
        assert_eq!(cfg.background_image_blur, 0);
        assert!(!cfg.clear_send_input_after_send);
        // 旧 JSON 无 portMeta → 空列表
        assert!(cfg.entities.port_meta.is_empty());
        // 旧 JSON 的实体数组仍按顶层 key 反序列化（flatten 读路径）
        assert!(cfg.entities.send_command_sets.is_empty());
        assert!(cfg.entities.port_groups.is_empty());
    }

    #[test]
    fn test_legacy_json_with_patched_entities_roundtrips() {
        // 补丁式增量：旧 JSON + 新增字段/新增实体，反序列化后逐项可用并在序列化时回到顶层。
        let cfg = legacy_config(serde_json::json!({
            "logSubdirMode": "port",
            "logIncludeTimestamp": false,
            "portMeta": [{"portId": "COM3", "alias": "温度计", "isHidden": true, "mode": "tty"}],
            "portGroups": [{"id": "g1", "name": "开发板", "isExpanded": true,
                            "portIds": ["COM1", "COM12"], "order": 0}],
        }));
        assert_eq!(cfg.log_subdir_mode, "port");
        assert!(!cfg.log_include_timestamp);
        assert_eq!(cfg.entities.port_meta[0].alias.as_deref(), Some("温度计"));
        assert_eq!(cfg.entities.port_meta[0].mode.as_deref(), Some("tty"));
        assert_eq!(cfg.entities.port_groups[0].port_ids.len(), 2);
        let serialized = serde_json::to_value(&cfg).unwrap();
        assert!(serialized.get("portMeta").is_some(), "got: {serialized}");
        assert!(serialized.get("portGroups").is_some(), "got: {serialized}");
        assert!(serialized.get("entities").is_none(), "got: {serialized}");
    }

    #[test]
    fn test_legacy_memory_budget_keys_are_stripped() {
        // 升级兼容：含 memoryLimitMb / memoryPerPortBudgetMb 的旧 config.json
        // 走剥离逻辑后，AppConfig 不再携带这两个字段，maxDisplayLines 回退默认。
        let value = strip_legacy_memory_budget_keys(LEGACY_V0_CONFIG)
            .expect("legacy JSON must parse as Value");
        let parsed: AppConfig = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.max_display_lines, 100000);
        // 序列化结果不含旧 key（剥离后物理移除，下次 save 落盘即无）
        let serialized = serde_json::to_string(&parsed).unwrap();
        assert!(!serialized.contains("memoryLimitMb"), "got: {serialized}");
        assert!(!serialized.contains("memoryPerPortBudgetMb"), "got: {serialized}");
        // 剥离逻辑对非 JSON 输入返回 None（调用方据此走 .bak 恢复）
        assert!(strip_legacy_memory_budget_keys("not json").is_none());
    }

    #[test]
    fn test_legacy_serial_enums_are_normalized_on_load() {
        // 升级归一化：旧版 UI 允许 serialport 无法表达的帧格式（校验位 Mark/Space、
        // 停止位 OnePointFive），本轮收窄枚举后这些值会让开串口直接报
        // "Unsupported parity"。走真实加载路径（ConfigManager::new）断言：非法字段被
        // 收敛到合法集合，而**同一实体与同一配置的其它字段一个都不许被改**。
        let dir = std::env::temp_dir().join(format!(
            "hypercom_test_legacy_serial_enums_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config_path = dir.join("config.json");
        let legacy = legacy_json(serde_json::json!({
            "closeBehavior": "minimize",
            "portPresets": [
                {"id": "p1", "name": "厂商默认", "baudRate": 9600, "dataBits": 9,
                 "parity": "Mark", "stopBits": "OnePointFive", "handshake": "RTS",
                 "dtr": true, "rts": false},
                {"id": "p2", "name": "合法值不动", "baudRate": 115200, "dataBits": 7,
                 "parity": "Even", "stopBits": "Two", "handshake": "XonXoff",
                 "dtr": false, "rts": true}
            ]
        }));
        fs::write(&config_path, serde_json::to_string(&legacy).unwrap()).unwrap();

        let mgr = ConfigManager::new(Some(config_path.clone())).unwrap();
        let cfg = mgr.get_config();

        let migrated = &cfg.entities.port_presets[0];
        assert_eq!(migrated.parity, "None");
        assert_eq!(migrated.stop_bits, "One");
        assert_eq!(migrated.data_bits, 8);
        assert_eq!(migrated.handshake, "None");
        // 归一化只碰非法字段，其余原样保留
        assert_eq!(migrated.id, "p1");
        assert_eq!(migrated.name, "厂商默认");
        assert_eq!(migrated.baud_rate, 9600);
        assert!(migrated.dtr);
        assert!(!migrated.rts);
        // 标量设置不受影响
        assert_eq!(cfg.close_behavior, "minimize");

        // 已合法的一条逐字段原样（归一化幂等、不误伤合法取值，含非 8 的合法数据位）
        let intact = &cfg.entities.port_presets[1];
        assert_eq!(intact.parity, "Even");
        assert_eq!(intact.stop_bits, "Two");
        assert_eq!(intact.data_bits, 7);
        assert_eq!(intact.handshake, "XonXoff");
        assert_eq!(intact.baud_rate, 115200);

        let _ = fs::remove_dir_all(&dir);
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
            log_subdir_mode: "monthly".to_string(),
            close_behavior: "explode".to_string(),
            // issue #12：非法自动更新模式收敛回 stable
            update_check_mode: "beta".to_string(),
            ..AppConfig::default()
        };
        ConfigManager::validate_and_clamp(&mut cfg);
        assert_eq!(cfg.log_encoding, "UTF-8");
        assert_eq!(cfg.default_line_ending, "\\r\\n");
        assert_eq!(cfg.log_format, "string");
        assert_eq!(cfg.log_subdir_mode, "date");
        assert_eq!(cfg.update_check_mode, "stable");
        assert_eq!(cfg.close_behavior, "exit");
    }

    #[test]
    fn test_validate_and_clamp_uses_config_bounds_table() {
        // 收敛结果必须等于 CONFIG_BOUNDS 里写的边界值本身——即边界只有一张表，
        // 散落的 clamp 字面量被删除。越界输入（含 i64::MAX 级别的溢出边界）全部收敛。
        let mut cfg = AppConfig {
            terminal_font_size: u32::MAX,
            ui_font_size: 0,
            max_display_lines: 1,
            max_retries: u8::MAX,
            log_split_size_mb: 0,
            backup_interval: u32::MAX,
            quick_send_inline_count: u32::MAX,
            background_image_opacity: u32::MAX,
            background_image_blur: u32::MAX,
            ..AppConfig::default()
        };
        ConfigManager::validate_and_clamp(&mut cfg);
        assert_eq!(cfg.terminal_font_size as i64, bound("terminalFontSize").1);
        assert_eq!(cfg.ui_font_size as i64, bound("uiFontSize").0);
        assert_eq!(cfg.max_display_lines as i64, bound("maxDisplayLines").0);
        assert_eq!(cfg.max_retries as i64, bound("maxRetries").1);
        assert_eq!(cfg.log_split_size_mb as i64, bound("logSplitSizeMb").0);
        assert_eq!(cfg.backup_interval as i64, bound("backupInterval").1);
        assert_eq!(cfg.quick_send_inline_count as i64, bound("quickSendInlineCount").1);
        assert_eq!(cfg.background_image_opacity as i64, bound("backgroundImageOpacity").1);
        assert_eq!(cfg.background_image_blur as i64, bound("backgroundImageBlur").1);
    }

    #[test]
    fn test_config_bounds_shape() {
        // 表形状：9 项、名字唯一、min <= max。前端 bounds.test.ts 按同一顺序逐项断言数值。
        let names: Vec<&str> = CONFIG_BOUNDS.iter().map(|(n, _, _)| *n).collect();
        assert_eq!(
            names,
            vec![
                "terminalFontSize",
                "uiFontSize",
                "maxDisplayLines",
                "maxRetries",
                "logSplitSizeMb",
                "backupInterval",
                "quickSendInlineCount",
                "backgroundImageOpacity",
                "backgroundImageBlur",
            ]
        );
        let unique: BTreeSet<&str> = names.iter().copied().collect();
        assert_eq!(unique.len(), names.len(), "duplicate bound name");
        for (name, min, max) in CONFIG_BOUNDS {
            assert!(min <= max, "inverted bound for {name}");
        }
    }

    #[test]
    fn test_validate_and_clamp_port_meta_mode() {
        // issue #11：合法模式保留，非法/残留值收敛回 trx。
        let mut cfg = AppConfig {
            entities: Entities {
                port_meta: vec![
                    PortMetaEntry {
                        port_id: "COM1".into(),
                        alias: None,
                        is_hidden: false,
                        mode: Some("tty".into()),
                    },
                    PortMetaEntry {
                        port_id: "COM2".into(),
                        alias: None,
                        is_hidden: false,
                        mode: Some("bogus".into()),
                    },
                    PortMetaEntry {
                        port_id: "COM3".into(),
                        alias: None,
                        is_hidden: false,
                        mode: None,
                    },
                ],
                ..Entities::default()
            },
            ..AppConfig::default()
        };
        ConfigManager::validate_and_clamp(&mut cfg);
        assert_eq!(cfg.entities.port_meta[0].mode.as_deref(), Some("tty"));
        assert_eq!(cfg.entities.port_meta[1].mode.as_deref(), Some("trx"));
        assert_eq!(cfg.entities.port_meta[2].mode, None);
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
    fn test_port_meta_entry_roundtrip_and_defaults() {
        // 带备注名 + 隐藏 + 工作模式的完整往返（camelCase，issue #11 mode 字段）。
        let meta = PortMetaEntry {
            port_id: "COM3".into(),
            alias: Some("温度计".into()),
            is_hidden: true,
            mode: Some("tty".into()),
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"portId\":\"COM3\""), "got: {}", json);
        assert!(json.contains("\"alias\":\"温度计\""), "got: {}", json);
        assert!(json.contains("\"isHidden\":true"), "got: {}", json);
        assert!(json.contains("\"mode\":\"tty\""), "got: {}", json);
        let parsed: PortMetaEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.port_id, "COM3");
        assert_eq!(parsed.alias.as_deref(), Some("温度计"));
        assert!(parsed.is_hidden);
        assert_eq!(parsed.mode.as_deref(), Some("tty"));

        // 旧版 config.json 缺 mode 字段 → 反序列化回退 None（= trx）。
        let legacy_json = r#"{"portId":"COM3","alias":"温度计","isHidden":true}"#;
        let legacy: PortMetaEntry = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(legacy.mode, None);

        // 前端发送的 mode 携带来回往返不丢（修复前 serde 静默丢弃未知字段）。
        let frontend_json = r#"{"portId":"GIT:BASH","isHidden":false,"mode":"tty"}"#;
        let from_frontend: PortMetaEntry = serde_json::from_str(frontend_json).unwrap();
        assert_eq!(from_frontend.mode.as_deref(), Some("tty"));
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

    /// 从 `lib.rs` 的 `generate_handler![...]` 列表解析已注册的命令名。
    fn parse_registered_commands(lib_src: &str) -> BTreeSet<String> {
        let start = lib_src
            .find("generate_handler![")
            .expect("lib.rs must contain generate_handler![")
            + "generate_handler![".len();
        let end = lib_src[start..]
            .find("])")
            .expect("generate_handler![ must be closed with ])")
            + start;
        lib_src[start..end]
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .filter_map(|line| line.trim_end_matches(',').rsplit("::").next())
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// 从 `commands/*.rs` 解析带 `#[tauri::command]` 的函数名。
    fn parse_declared_commands(commands_dir: &std::path::Path) -> BTreeSet<String> {
        let mut declared = BTreeSet::new();
        for entry in fs::read_dir(commands_dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let source = fs::read_to_string(&path).unwrap();
            let mut lines = source.lines().peekable();
            while let Some(line) = lines.next() {
                if line.trim() != "#[tauri::command]" {
                    continue;
                }
                // 属性与 fn 之间可能还有别的属性行，跳过空行与属性行。
                let fn_line = loop {
                    let Some(candidate) = lines.next() else { break "" };
                    let trimmed = candidate.trim();
                    if trimmed.is_empty() || trimmed.starts_with("#[") || trimmed.starts_with("///") {
                        continue;
                    }
                    break trimmed;
                };
                let after_fn = fn_line
                    .split_once("fn ")
                    .map(|(_, rest)| rest)
                    .unwrap_or_else(|| panic!("expected `fn` after #[tauri::command] in {:?}", path));
                declared.insert(
                    after_fn
                        .split('(')
                        .next()
                        .unwrap()
                        .trim()
                        .to_string(),
                );
            }
        }
        declared
    }

    #[test]
    fn test_generate_handler_matches_tauri_command_attribute() {
        // 注册漂移守卫：新增 #[tauri::command] 却忘了在 lib.rs 注册时，前端 invoke 会
        // 报 "command not found"，而编译器不会提醒。这里解析两侧源文本强制相等。
        let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let lib_src = fs::read_to_string(src_dir.join("lib.rs")).unwrap();
        let registered = parse_registered_commands(&lib_src);
        let declared = parse_declared_commands(&src_dir.join("commands"));

        let missing_registration: Vec<_> = declared.difference(&registered).cloned().collect();
        let dangling_registration: Vec<_> = registered.difference(&declared).cloned().collect();
        assert!(
            missing_registration.is_empty() && dangling_registration.is_empty(),
            "command registry drift:\n  declared but not registered: {missing_registration:?}\n  registered but not declared: {dangling_registration:?}"
        );
        assert!(!registered.is_empty(), "generate_handler! parsed to an empty set");
    }
}
