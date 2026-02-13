use serde::{Deserialize, Serialize};
use super::{SerialConfig, DataBits, StopBits, Parity, FlowControl};

/// 应用设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// 显示设置
    pub display: DisplaySettings,
    /// 串口默认配置
    pub serial_defaults: SerialConfig,
    /// 日志设置
    pub log: LogSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            display: DisplaySettings::default(),
            serial_defaults: SerialConfig::default(),
            log: LogSettings::default(),
        }
    }
}

/// 显示设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplaySettings {
    /// 字体大小
    pub font_size: u32,
    /// 字体家族
    pub font_family: String,
    /// 主题
    pub theme: String,
    /// 显示格式
    pub display_format: String,
    /// 显示时间戳
    pub show_timestamp: bool,
    /// 显示方向
    pub show_direction: bool,
}

impl Default for DisplaySettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            font_family: "JetBrains Mono".to_string(),
            theme: "system".to_string(),
            display_format: "hex".to_string(),
            show_timestamp: true,
            show_direction: true,
        }
    }
}

/// 日志设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogSettings {
    /// 是否启用日志
    pub enabled: bool,
    /// 日志目录
    pub log_dir: String,
    /// 最大文件大小（MB）
    pub max_file_size: u64,
    /// 自动分片
    pub auto_split: bool,
    /// 包含时间戳
    pub include_timestamp: bool,
}

impl Default for LogSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            log_dir: String::new(),
            max_file_size: 10,
            auto_split: true,
            include_timestamp: true,
        }
    }
}
