/**
 * 日志文件名 / 目录名的解析与分配。
 *
 * 与 LogManager 的设置状态解耦（纯函数 + spec 参数），这样"文件名怎么来的"，
 * 以及"为什么必须净化 port_id"，都能在不构造 LogManager 的前提下单测。
 */

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

/// 目标文件的分配策略。
pub(super) enum FileMode {
    /// 同名冲突时续写已有文件，`current_size` 从已有文件大小初始化
    Append,
    /// 每次分配一个**不存在**的文件（同名冲突追加 -1/-2… 后缀，`create_new` 原子保证）
    Unique,
}

/// 净化要替换进文件/目录名的 port_id（路径遍历防御）：
/// port_id 来自前端，若含路径分隔符或 ".."，拼出的日志文件会逃逸出日志目录，
/// 造成任意位置的文件创建/追加。把 Windows 非法字符 \/:*?"<>| 与 ".." 统一替换为 '_'。
pub(super) fn sanitize_filename_component(input: &str) -> String {
    input
        .replace(&['/', '\\', ':', '*', '?', '"', '<', '>', '|'][..], "_")
        .replace("..", "_")
}

/// 解析文件名模板（不含扩展名）：
/// [com] → port_id, [datetime] → 20260101_120000, [date] → 2026-01-01, [time] → 12-00-00
pub(super) fn format_filename(template: &str, port_id: &str) -> String {
    let now = chrono::Local::now();
    template
        .replace("[com]", &sanitize_filename_component(port_id))
        .replace("[datetime]", &now.format("%Y%m%d_%H%M%S").to_string())
        .replace("[date]", &now.format("%Y-%m-%d").to_string())
        .replace("[time]", &now.format("%H-%M-%S").to_string())
}

/// 计算子目录名：
/// - "none" → None（直接存入日志根目录）
/// - "port" → 净化后的 port_id（复用 sanitize_filename_component，防路径遍历）
/// - "date" 与未知模式 → 当前日期 YYYY-MM-DD（未知模式按默认 date 收敛，与配置端校验一致）
pub(super) fn subdir_component(mode: &str, port_id: &str) -> Option<String> {
    match mode {
        "none" => None,
        "port" => Some(sanitize_filename_component(port_id)),
        _ => Some(chrono::Local::now().format("%Y-%m-%d").to_string()),
    }
}

/// 按根目录/子目录策略/模板解析并打开目标文件，返回
/// `(绝对文件路径, 文件句柄, 已有字节数)`。目录不存在时创建（配置换目录或用户手动
/// 删掉日志目录后，写路径必须能自愈，否则端口会永久静默不落盘）。
pub(super) fn allocate_file(
    root: &Path,
    subdir_mode: &str,
    template: &str,
    port_id: &str,
    mode: FileMode,
) -> anyhow::Result<(PathBuf, File, u64)> {
    let dir = match subdir_component(subdir_mode, port_id) {
        Some(sub) => root.join(sub),
        None => root.to_path_buf(),
    };
    fs::create_dir_all(&dir)?;
    let file_path = dir.join(format!("{}.log", format_filename(template, port_id)));

    match mode {
        FileMode::Unique => {
            let (path, file) = open_unique(&file_path)?;
            Ok((path, file, 0))
        }
        FileMode::Append => {
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file_path)?;
            // 追加模式下按已有文件大小初始化，分片阈值对续写文件才准确
            let existing_size = file.metadata()?.len();
            Ok((file_path, file, existing_size))
        }
    }
}

/// 分配一个**不存在的**文件：目标已存在时依次尝试 `name-1.log`、`name-2.log`…
/// （数字后缀插在扩展名前）。`create_new(true)` 原子保证并发/重入下也不会续写已有文件。
fn open_unique(base: &Path) -> anyhow::Result<(PathBuf, File)> {
    for n in 0.. {
        let candidate = if n == 0 {
            base.to_path_buf()
        } else {
            let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("log");
            let ext = base.extension().and_then(|e| e.to_str()).unwrap_or("log");
            base.with_file_name(format!("{stem}-{n}.{ext}"))
        };
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    unreachable!("suffix loop is unbounded")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hypercom_test_naming_{}", name));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn format_filename_substitutes_every_placeholder() {
        let now = chrono::Local::now();
        let name = format_filename("[com]-[date]-[time]", "COM5");
        assert!(name.starts_with("COM5-"), "{name}");
        assert!(name.contains(&now.format("%Y-%m-%d").to_string()), "{name}");
        assert!(name.contains(&now.format("%H-%M-%S").to_string()), "{name}");
    }

    #[test]
    fn sanitize_replaces_path_separators_and_parent_refs() {
        assert_eq!(sanitize_filename_component("COM9\\..\\evil"), "COM9___evil");
        assert_eq!(sanitize_filename_component("a/b:c*d"), "a_b_c_d");
        // 净化的结果不可能再含路径分隔符 → 拼出的路径必然留在日志目录内
        let cleaned = sanitize_filename_component("..\\..\\Windows\\System32");
        assert!(!cleaned.contains(['\\', '/']));
    }

    #[test]
    fn subdir_component_follows_mode() {
        assert_eq!(subdir_component("none", "COM1"), None);
        assert_eq!(subdir_component("port", "COM1"), Some("COM1".to_string()));
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(subdir_component("date", "COM1"), Some(today.clone()));
        // 未知模式收敛到 date（与配置端校验口径一致）
        assert_eq!(subdir_component("monthly", "COM1"), Some(today));
    }

    #[test]
    fn unique_mode_never_reopens_an_existing_file() {
        let dir = test_dir("unique");
        let (first, _f1, size1) = allocate_file(&dir, "none", "[com]", "COM1", FileMode::Unique).unwrap();
        let (second, _f2, size2) = allocate_file(&dir, "none", "[com]", "COM1", FileMode::Unique).unwrap();
        assert_eq!(first.file_name().unwrap(), "COM1.log");
        assert_eq!(second.file_name().unwrap(), "COM1-1.log");
        assert_eq!((size1, size2), (0, 0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_mode_reports_existing_size_and_creates_missing_root() {
        let dir = test_dir("append");
        let nested = dir.join("does").join("not").join("exist");
        let (path, _f, size) = allocate_file(&nested, "none", "[com]", "COM1", FileMode::Append).unwrap();
        assert_eq!(size, 0);
        assert!(nested.is_dir(), "root must be created on demand");
        drop(_f);
        fs::write(&path, b"12345").unwrap();
        let (_path2, _f2, size2) = allocate_file(&nested, "none", "[com]", "COM1", FileMode::Append).unwrap();
        assert_eq!(size2, 5, "append must report existing size for the split threshold");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn allocate_file_puts_files_in_the_subdir_for_the_mode() {
        let dir = test_dir("subdir");
        let (path, _f, _) = allocate_file(&dir, "port", "[com]", "COM7", FileMode::Append).unwrap();
        assert_eq!(path.parent().unwrap(), dir.join("COM7"));
        let _ = fs::remove_dir_all(&dir);
    }
}
