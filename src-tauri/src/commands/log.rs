use std::path::Path;

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

/// 通过系统默认程序打开任意路径（文件或目录）。
/// 用于"打开日志文件"和"打开日志目录"按钮。
#[tauri::command]
pub fn open_path(path: String, state: State<AppState>) -> Result<(), CommandError> {
    // 作用域校验 (defects #54): 仅允许打开 LogManager 的 log_directory 子树下的路径。
    // 防止前端任意 invoke 让后端打开 C:\Windows\System32 等敏感路径。
    let log_dir = state.log_manager.get_directory();
    let canonical_target = Path::new(&path)
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize path: {e}")))?;
    let canonical_root = log_dir
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize log root: {e}")))?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(CommandError::Log(format!(
            "Path is outside log directory scope: {path}"
        )));
    }

    let p = Path::new(&path);
    if !p.exists() {
        return Err(CommandError::Log(format!("Path does not exist: {path}")));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        // 路径中含 ',' 时 explorer 会把它当多参数分隔符。raw_arg 跳过 Rust 的 quote 处理，
        // 我们自己用 " 包裹整个路径让 explorer 把它当单一参数 (defects #55)。
        let quoted = format!("\"{path}\"");
        std::process::Command::new("explorer")
            .raw_arg(&quoted)
            .spawn()
            .map_err(|e| CommandError::Io(e.to_string()))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| CommandError::Io(e.to_string()))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
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

        if !old_path.exists() || !old_path.is_dir() {
            return Err(CommandError::Log(format!(
                "Old log directory does not exist: {old_dir}"
            )));
        }
        // Only the active log root may be migrated: an arbitrary path would let a
        // compromised renderer move/delete unrelated *.log files.
        let active_root = log_manager.get_directory();
        let same_root = match (old_path.canonicalize(), active_root.canonicalize()) {
            (Ok(old), Ok(active)) => old == active,
            _ => false,
        };
        if !same_root {
            return Err(CommandError::Log(format!(
                "Old log directory is not the active log root: {old_dir}"
            )));
        }
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
