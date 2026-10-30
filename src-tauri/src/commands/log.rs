use std::path::{Path, PathBuf};

use tauri::State;

use super::CommandError;
use crate::{logger, AppState};

/// 手动另存当前日志：路径由宿主原生 save 对话框选择，前端不传路径。
#[tauri::command]
pub async fn pick_and_save_log(
    port_id: String,
    options: super::file::TextFileDialogOptions,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let dialog_window = window.clone();
    let path = tokio::task::spawn_blocking(move || {
        super::file::pick_text_file_path(&dialog_window, &options, true)
    })
    .await
    .map_err(|e| CommandError::Other(format!("Save log dialog task panicked: {e}")))?;
    let Some(path) = path else { return Ok(false) };
    let target = path.to_string_lossy().into_owned();
    let log_manager = state.log_manager.clone();
    tokio::task::spawn_blocking(move || {
        log_manager
            .save_log_as(&port_id, &target)
            .map_err(|e| CommandError::Log(e.to_string()))
    })
    .await
    .map_err(|e| CommandError::Other(format!("Save log task panicked: {e}")))??;
    Ok(true)
}

/// 获取日志文件列表
#[tauri::command]
pub async fn get_log_files(
    state: State<'_, AppState>,
) -> Result<Vec<logger::LogFileInfo>, CommandError> {
    let log_manager = state.log_manager.clone();
    tokio::task::spawn_blocking(move || {
        log_manager
            .list_files()
            .map_err(|e| CommandError::Log(e.to_string()))
    })
    .await
    .map_err(|e| CommandError::Other(format!("List log files task panicked: {e}")))?
}

/// 开始记录日志
#[tauri::command]
pub async fn start_logging(port_id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    // 从配置读取 log_format 和 log_encoding，确保 writer 使用用户配置的格式与编码，
    // 而非依赖配置同步的时序窗口（LogManager 的编码只影响新建 writer）。
    let (format, encoding) = {
        let config_mgr = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let cfg = config_mgr.get_config();
        (cfg.log_format.clone(), cfg.log_encoding.clone())
    };
    tokio::task::block_in_place(|| {
        state
            .log_manager
            .create_writer_with_encoding(&port_id, &format, &encoding)
            .map_err(|e| CommandError::Log(e.to_string()))
    })
}

/// 停止记录日志
#[tauri::command]
pub async fn stop_logging(port_id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    tokio::task::block_in_place(|| {
        state
            .log_manager
            .close_writer(&port_id)
            .map_err(|e| CommandError::Log(e.to_string()))
    })
}

/// Resolve the path once and return the checked target, not the untrusted alias.
fn scoped_log_path(path: &Path, log_dir: &Path) -> Result<PathBuf, CommandError> {
    let target = path.canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize path: {e}")))?;
    let root = log_dir.canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize log root: {e}")))?;
    if !target.starts_with(&root) {
        return Err(CommandError::Log("Path is outside log directory scope".into()));
    }
    Ok(target)
}

/// Explorer does not consistently accept verbatim filesystem prefixes. Only
/// simplify a path *after* canonicalization and the log-root scope check.
#[cfg(any(windows, test))]
fn explorer_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
    }
}

/// 通过系统默认程序打开任意路径（文件或目录）。
/// 用于"打开日志文件"和"打开日志目录"按钮。
#[tauri::command]
pub fn open_path(path: String, state: State<AppState>) -> Result<(), CommandError> {
    // 作用域校验 (defects #54): 仅允许打开 LogManager 的 log_directory 子树下的路径。
    // 防止前端任意 invoke 让后端打开 C:\Windows\System32 等敏感路径。
    let log_dir = state.log_manager.get_directory();
    let canonical_target = scoped_log_path(Path::new(&path), &log_dir)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        // 路径中含 ',' 时 explorer 会把它当多参数分隔符。raw_arg 跳过 Rust 的 quote 处理，
        // 我们自己用 " 包裹整个路径让 explorer 把它当单一参数 (defects #55)。
        let quoted = format!("\"{}\"", explorer_path(&canonical_target));
        std::process::Command::new("explorer")
            .raw_arg(&quoted)
            .spawn()
            .map_err(|e| CommandError::Io(e.to_string()))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&canonical_target)
            .spawn()
            .map_err(|e| CommandError::Io(e.to_string()))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&canonical_target)
            .spawn()
            .map_err(|e| CommandError::Io(e.to_string()))?;
    }
    Ok(())
}

/// 打开当前的日志目录（按当前 LogManager 配置）。
#[tauri::command]
pub fn open_log_directory(state: State<AppState>) -> Result<(), CommandError> {
    let dir = state
        .log_manager
        .get_directory()
        .to_string_lossy()
        .to_string();
    open_path(dir, state)
}

fn require_migration_source(old_path: &Path, active_root: &Path) -> Result<(), CommandError> {
    if !old_path.is_dir() {
        return Err(CommandError::Log("Old log directory does not exist".into()));
    }
    match (old_path.canonicalize(), active_root.canonicalize()) {
        (Ok(old), Ok(active)) if old == active => Ok(()),
        _ => Err(CommandError::Log("Old log directory is not the active log root".into())),
    }
}

/// 将旧日志目录中的 .log 文件迁移到新目录。
/// 返回成功迁移的文件数。跳过已存在的同名文件（不覆盖）。
#[tauri::command]
pub async fn migrate_log_directory(
    old_dir: String,
    new_dir: String,
    state: State<'_, AppState>,
) -> Result<u32, CommandError> {
    let log_manager = state.log_manager.clone();
    tokio::task::spawn_blocking(move || {
        let old_path = std::path::Path::new(&old_dir);
        let new_path = std::path::Path::new(&new_dir);

        // Only the active log root may be migrated: an arbitrary path would let a
        // compromised renderer move/delete unrelated *.log files.
        require_migration_source(old_path, &log_manager.get_directory())?;
        std::fs::create_dir_all(new_path)
            .map_err(|e| CommandError::Io(format!("Cannot create new log directory: {e}")))?;

        let mut migrated = 0u32;
        let entries = std::fs::read_dir(old_path)
            .map_err(|e| CommandError::Io(format!("Cannot read old log directory: {e}")))?;
        for entry in entries {
            let entry = entry.map_err(|e| CommandError::Io(e.to_string()))?;
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext == "log" {
                        let Some(file_name) = path.file_name() else {
                            continue;
                        };
                        let dest = new_path.join(file_name);
                        if !dest.exists() {
                            // 优先 rename（同卷零拷贝），跨卷回退到 copy + delete
                            if std::fs::rename(&path, &dest).is_err() {
                                std::fs::copy(&path, &dest)
                                    .map_err(|e| CommandError::Io(format!("Copy failed: {e}")))?;
                                let _ = std::fs::remove_file(&path);
                            }
                            migrated += 1;
                        }
                    }
                }
            }
        }

        // 更新 LogManager 的目录指向
        log_manager
            .set_directory(new_dir.clone())
            .map_err(|e| CommandError::Log(e.to_string()))?;

        log::info!(
            "Migrated {} log files from {} to {}",
            migrated,
            old_dir,
            new_dir
        );
        Ok(migrated)
    })
    .await
    .map_err(|e| CommandError::Other(format!("Migrate log task panicked: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::{explorer_path, require_migration_source, scoped_log_path};
    use std::{fs, path::{Path, PathBuf}};

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hypercom_log_command_{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn checked_log_path_accepts_the_root_and_nested_files() {
        let temp = TestRoot::new();
        let root = temp.0.join("logs");
        let nested = root.join("device, with spaces");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("session.log");
        fs::write(&file, b"RX tail").unwrap();
        assert_eq!(scoped_log_path(&file, &root).unwrap(), file.canonicalize().unwrap());
        assert_eq!(scoped_log_path(&root, &root).unwrap(), root.canonicalize().unwrap());
    }

    #[test]
    fn log_scope_rejects_sibling_prefixes_and_parent_traversal() {
        let temp = TestRoot::new();
        let root = temp.0.join("logs");
        let sibling = temp.0.join("logs-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        let outside = sibling.join("secret.log");
        fs::write(&outside, b"not in root").unwrap();
        assert!(scoped_log_path(&outside, &root).is_err());
        assert!(scoped_log_path(&root.join("../logs-outside/secret.log"), &root).is_err());
    }

    #[test]
    fn missing_log_target_and_root_fail_closed() {
        let temp = TestRoot::new();
        let file = temp.0.join("present.log");
        fs::write(&file, b"present").unwrap();
        assert!(scoped_log_path(&temp.0.join("missing.log"), &temp.0).is_err());
        assert!(scoped_log_path(&file, &temp.0.join("missing-root")).is_err());
    }

    #[test]
    fn only_the_active_existing_log_directory_can_be_migrated() {
        let temp = TestRoot::new();
        let active = temp.0.join("active");
        let unrelated = temp.0.join("unrelated");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(active.join("file.log"), b"data").unwrap();
        assert!(require_migration_source(&active, &active).is_ok());
        assert!(require_migration_source(&active.join("."), &active).is_ok());
        assert!(require_migration_source(&unrelated, &active).is_err());
        assert!(require_migration_source(&active.join("file.log"), &active).is_err());
        assert!(require_migration_source(&active.join("missing"), &active).is_err());
    }

    #[test]
    fn explorer_receives_the_checked_path_without_verbatim_prefixes() {
        assert_eq!(explorer_path(Path::new(r"\\?\C:\logs\device, one.log")), r"C:\logs\device, one.log");
        assert_eq!(explorer_path(Path::new(r"\\?\UNC\server\share\logs")), r"\\server\share\logs");
        assert_eq!(explorer_path(Path::new(r"C:\logs\normal.log")), r"C:\logs\normal.log");
    }

    #[cfg(unix)]
    #[test]
    fn a_log_symlink_cannot_escape_the_checked_root() {
        let temp = TestRoot::new();
        let root = temp.0.join("logs");
        fs::create_dir_all(&root).unwrap();
        let outside = temp.0.join("outside.log");
        fs::write(&outside, b"private").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("alias.log")).unwrap();
        assert!(scoped_log_path(&root.join("alias.log"), &root).is_err());
    }
}
