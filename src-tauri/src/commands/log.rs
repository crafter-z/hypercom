use std::path::Path;

use tauri::State;

use super::CommandError;
use crate::{logger, AppState};

/// 设置日志存储目录
#[tauri::command]
pub fn set_log_directory(path: String, state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .set_directory(path)
        .map_err(|e| CommandError::Log(e.to_string()))
}

/// 手动另存当前日志
#[tauri::command]
pub fn save_log_as(
    port_id: String,
    path: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    // 作用域校验 (与 export_terminal_log 同级): 仅允许写入 LogManager 的 log_directory
    // 子树下的路径，防止前端借另存为覆盖任意文件 (defects #54 同类)。
    let log_dir = {
        let mgr = state
            .log_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        mgr.get_directory().clone()
    };
    let target = Path::new(&path);
    // 目标文件可能尚不存在（save 对话框返回的新文件路径），因此对父目录 canonicalize
    let canonical_parent = target
        .parent()
        .ok_or_else(|| CommandError::Other(format!("Path has no parent directory: {path}")))?
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize parent directory: {e}")))?;
    let canonical_root = log_dir
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize log root: {e}")))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(CommandError::Log(format!(
            "Path outside allowed directory: {path}"
        )));
    }
    let manager = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .save_log_as(&port_id, &path)
        .map_err(|e| CommandError::Log(e.to_string()))
}

/// 导出终端日志到指定路径（由前端文件对话框选择）
#[tauri::command]
pub fn export_terminal_log(
    path: String,
    content: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    // 作用域校验 (defense-in-depth): 仅允许写入 LogManager 的 log_directory 子树下的路径。
    // 前端 save() 对话框已限制路径，但后端必须独立校验防止越权写入 (defects #54 同类)。
    let log_dir = {
        let mgr = state
            .log_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        mgr.get_directory().clone()
    };
    let target = Path::new(&path);
    // 导出文件可能尚不存在（save 对话框返回的新文件路径），因此对父目录 canonicalize
    let canonical_parent = target
        .parent()
        .ok_or_else(|| CommandError::Other(format!("Path has no parent directory: {path}")))?
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize parent directory: {e}")))?;
    let canonical_root = log_dir
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("Cannot canonicalize log root: {e}")))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(CommandError::Log(format!(
            "Path outside allowed directory: {path}"
        )));
    }
    std::fs::write(&path, content.as_bytes())
        .map_err(|e| CommandError::Io(format!("Failed to write export file '{path}': {e}")))
}

/// 获取日志文件列表
#[tauri::command]
pub fn get_log_files(state: State<AppState>) -> Result<Vec<logger::LogFileInfo>, CommandError> {
    let manager = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .list_files()
        .map_err(|e| CommandError::Log(e.to_string()))
}

/// 设置日志分片大小 (MB)
#[tauri::command]
pub fn set_log_split_size(mb: u32, state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.set_split_size(mb);
    Ok(())
}

/// 设置日志文件名格式
#[tauri::command]
pub fn set_log_filename_format(format: String, state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.set_filename_format(&format);
    Ok(())
}

/// 设置日志自动保存开关。前端在 set_config 时调用以同步状态。
#[tauri::command]
pub fn set_log_auto_save(enabled: bool, state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.set_auto_save(enabled);
    Ok(())
}

/// 设置日志默认编码 (UTF-8 / GBK / ISO-8859-1 / ASCII)。
/// 已存在的 writer 不受影响 — encoding 在 create_writer 时锁定。
#[tauri::command]
pub fn set_log_encoding(encoding: String, state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.set_default_encoding(&encoding);
    Ok(())
}

/// 开始记录日志
#[tauri::command]
pub fn start_logging(port_id: String, state: State<AppState>) -> Result<(), CommandError> {
    let config_mgr = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let format = config_mgr.get_config().log_format.clone();
    drop(config_mgr);
    let mut manager = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .create_writer(&port_id, &format)
        .map_err(|e| CommandError::Log(e.to_string()))
}

/// 停止记录日志
#[tauri::command]
pub fn stop_logging(port_id: String, state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .log_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .close_writer(&port_id)
        .map_err(|e| CommandError::Log(e.to_string()))
}

/// 通过系统默认程序打开任意路径（文件或目录）。
/// 用于"打开日志文件"和"打开日志目录"按钮。
#[tauri::command]
pub fn open_path(path: String, state: State<AppState>) -> Result<(), CommandError> {
    // 作用域校验 (defects #54): 仅允许打开 LogManager 的 log_directory 子树下的路径。
    // 防止前端任意 invoke 让后端打开 C:\Windows\System32 等敏感路径。
    let log_dir = {
        let mgr = state
            .log_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        mgr.get_directory().clone()
    };
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
    let dir = {
        let mgr = state
            .log_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        mgr.get_directory().to_string_lossy().to_string()
    };
    open_path(dir, state)
}
