/**
 * 日志设置快照——日志子系统的**唯一设置来源**（K3）。
 *
 * 为什么单独有这个类型：拆分前 LogManager 有 10 个逐字段 setter，配置同步散落在
 * `lib.rs` / `commands/config.rs` / `commands/log.rs` 三处，任何一处漏调都会让后端
 * 写入行为与配置表（以及前端 UI）永久漂移——auto_save 已经关掉但仍在写盘、
 * 文件名模板换了但后端还在用旧的，都是这么来的。现在配置侧只认识
 * `LogSettings::from_config` + `LogManager::apply_settings` 两个符号，不可能漏字段。
 *
 * 注意 `log_format`（string/hex/binary）**不在**这里：它由 start_logging 命令按端口
 * 逐次传入（同一时刻不同端口可以用不同格式），不属于全局设置。
 */

use std::path::PathBuf;

use crate::config::AppConfig;

/// 文件名模板默认值，与前端 defaultConfig.logFilenameFormat 保持一致。
pub(super) const DEFAULT_FILENAME_FORMAT: &str = "[com]-[datetime]";

/// 日志子目录策略默认值：按日期分文件夹，与前端 defaultConfig 保持一致。
pub(super) const DEFAULT_SUBDIR_MODE: &str = "date";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogSettings {
    /// 自动保存总开关：false 时写路径直接短路，不做任何磁盘 IO
    pub auto_save: bool,
    /// string 模式下解码字节流用的编码（UTF-8 / GBK / ISO-8859-1 / ASCII）
    pub encoding: String,
    /// 文件名模板，支持 [com] / [datetime] / [date] / [time]
    pub filename_format: String,
    /// 分片阈值（MB）
    pub split_size_mb: u32,
    /// 是否启用按大小自动分片
    pub split_enabled: bool,
    /// 日志行前缀是否包含时间戳
    pub include_timestamp: bool,
    /// 日志行前缀是否包含 RX/TX 方向标记
    pub include_direction: bool,
    /// 子目录策略："none" | "date" | "port"
    pub subdir_mode: String,
    /// 日志根目录（绝对路径）。空串表示「沿用当前目录」——config.json 首次启动时
    /// 该字段可能为空，那种情况下不能把 LogManager 的默认目录覆盖成空路径。
    pub directory: String,
    /// 每次打开串口分配新日志文件（true）vs 同名文件续写（false）
    pub new_file_per_session: bool,
}

impl LogSettings {
    /// 从应用配置派生日志设置。这是配置表 → 日志写入行为的**唯一**转换点。
    pub fn from_config(cfg: &AppConfig) -> Self {
        Self {
            auto_save: cfg.auto_save_log,
            encoding: cfg.log_encoding.clone(),
            filename_format: cfg.log_filename_format.clone(),
            split_size_mb: cfg.log_split_size_mb,
            split_enabled: cfg.log_split_enabled,
            include_timestamp: cfg.log_include_timestamp,
            include_direction: cfg.log_include_direction,
            subdir_mode: cfg.log_subdir_mode.clone(),
            directory: cfg.log_directory.clone(),
            new_file_per_session: cfg.log_new_file_per_session,
        }
    }
}

impl Default for LogSettings {
    fn default() -> Self {
        Self {
            // 未被配置覆盖前的保守默认：不写盘（AppState 构造时会立刻 apply_settings）
            auto_save: false,
            encoding: "UTF-8".to_string(),
            filename_format: DEFAULT_FILENAME_FORMAT.to_string(),
            split_size_mb: 100,
            split_enabled: true,
            include_timestamp: true,
            include_direction: true,
            subdir_mode: DEFAULT_SUBDIR_MODE.to_string(),
            directory: default_directory(),
            new_file_per_session: false,
        }
    }
}

/// 默认日志目录（`<data_dir>/hypercom/logs`）；定位不到 data_dir 时退回当前目录。
fn default_directory() -> String {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hypercom")
        .join("logs")
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_config_maps_every_settings_field() {
        // 10 项各取一个与默认值不同的值：任何字段被漏掉或张冠李戴都会在这里变红。
        // 这条断言守的是 C1 的根因——配置表与日志写入行为之间的漂移。
        let cfg = AppConfig {
            auto_save_log: false,
            log_encoding: "GBK".to_string(),
            log_filename_format: "[date]-[com]".to_string(),
            log_split_size_mb: 7,
            log_split_enabled: false,
            log_include_timestamp: false,
            log_include_direction: false,
            log_subdir_mode: "port".to_string(),
            log_directory: "/tmp/hypercom-logs".to_string(),
            log_new_file_per_session: true,
            ..AppConfig::default()
        };

        assert_eq!(
            LogSettings::from_config(&cfg),
            LogSettings {
                auto_save: false,
                encoding: "GBK".to_string(),
                filename_format: "[date]-[com]".to_string(),
                split_size_mb: 7,
                split_enabled: false,
                include_timestamp: false,
                include_direction: false,
                subdir_mode: "port".to_string(),
                directory: "/tmp/hypercom-logs".to_string(),
                new_file_per_session: true,
            }
        );
    }

    #[test]
    fn default_directory_is_never_empty() {
        // 空目录会让所有写路径落到进程当前目录（甚至失败），因此默认快照必须是绝对路径
        let settings = LogSettings::default();
        assert!(!settings.directory.is_empty());
        assert!(settings.directory.ends_with("logs"), "{}", settings.directory);
    }
}
