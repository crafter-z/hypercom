use crate::storage::{LogConfig, LogStatus, LogState};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, State};

/// 验证路径是否安全（防止路径遍历攻击）
fn validate_path(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    
    // 规范化路径，解析 . 和 ..
    let canonical_path = path.canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    
    // 检查路径是否包含可疑组件
    let path_str = canonical_path.to_string_lossy();
    
    // 禁止访问系统关键目录（Windows 和 Unix）
    let forbidden_prefixes = [
        "/etc", "/root", "/boot", "/sys", "/proc",
        "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)",
        "C:\\Users\\Public", "C:\\$Recycle.Bin",
    ];
    
    for prefix in forbidden_prefixes {
        if path_str.starts_with(prefix) {
            return Err("Access to system directory is not allowed".to_string());
        }
    }
    
    Ok(canonical_path)
}

/// 验证日志文件路径（确保是 .log 文件）
fn validate_log_file_path(path: &str) -> Result<PathBuf, String> {
    let canonical_path = validate_path(path)?;
    
    // 检查扩展名
    match canonical_path.extension() {
        Some(ext) if ext == "log" => Ok(canonical_path),
        _ => Err("Only .log files are allowed".to_string()),
    }
}

/// 开始记录日志
#[tauri::command]
pub async fn start_logging<R: Runtime>(
    app_handle: AppHandle<R>,
    log_state: State<'_, LogState>,
    log_dir: Option<String>,
) -> Result<(), String> {
    let mut manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    // 如果没有指定目录，使用默认目录
    let dir = log_dir.or_else(|| {
        let app_data_dir = app_handle.path().app_data_dir().ok()?;
        Some(app_data_dir.to_string_lossy().to_string())
    });

    manager.start_logging(dir.as_deref())?;

    // 保存日志配置
    if let Some(dir) = dir {
        let mut config = manager.get_config().clone();
        config.log_dir = dir;
        config.enabled = true;
        manager.update_config(config);
    }

    Ok(())
}

/// 停止记录日志
#[tauri::command]
pub async fn stop_logging(
    log_state: State<'_, LogState>,
) -> Result<(), String> {
    let mut manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    manager.stop_logging()
}

/// 暂停记录日志
#[tauri::command]
pub async fn pause_logging(
    log_state: State<'_, LogState>,
) -> Result<(), String> {
    let mut manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    manager.pause_logging()
}

/// 恢复记录日志
#[tauri::command]
pub async fn resume_logging(
    log_state: State<'_, LogState>,
) -> Result<(), String> {
    let mut manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    manager.resume_logging()
}

/// 获取日志状态
#[tauri::command]
pub async fn get_log_status(
    log_state: State<'_, LogState>,
) -> Result<LogStatus, String> {
    let manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    Ok(manager.get_status())
}

/// 获取日志配置
#[tauri::command]
pub async fn get_log_config(
    log_state: State<'_, LogState>,
) -> Result<LogConfig, String> {
    let manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    Ok(manager.get_config().clone())
}

/// 更新日志配置
#[tauri::command]
pub async fn update_log_config(
    log_state: State<'_, LogState>,
    config: LogConfig,
) -> Result<(), String> {
    let mut manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    manager.update_config(config);
    Ok(())
}

/// 获取当前日志文件路径
#[tauri::command]
pub async fn get_current_log_file(
    log_state: State<'_, LogState>,
) -> Result<Option<String>, String> {
    let manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    Ok(manager.get_current_file().map(|p| p.to_string_lossy().to_string()))
}

/// 获取日志文件大小
#[tauri::command]
pub async fn get_log_file_size(
    log_state: State<'_, LogState>,
) -> Result<u64, String> {
    let manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    Ok(manager.get_current_size())
}

/// 导出日志文件
#[tauri::command]
pub async fn export_log(
    source: String,
    target: String,
) -> Result<(), String> {
    // 验证源文件路径
    let source_path = validate_log_file_path(&source)?;
    // 验证目标路径（确保目标文件扩展名合理）
    let target_path = validate_path(&target)?;
    
    crate::storage::export_log(
        source_path.to_str().ok_or("Invalid source path encoding")?,
        target_path.to_str().ok_or("Invalid target path encoding")?,
    )
}

/// 清空日志文件
#[tauri::command]
pub async fn clear_log(
    path: String,
) -> Result<(), String> {
    // 验证路径
    let validated_path = validate_log_file_path(&path)?;
    
    crate::storage::clear_log(validated_path.to_str().ok_or("Invalid path encoding")?)
}

/// 列出日志文件
#[tauri::command]
pub async fn list_log_files(
    dir: String,
) -> Result<Vec<String>, String> {
    // 验证目录路径
    let validated_dir = validate_path(&dir)?;
    
    crate::storage::list_log_files(validated_dir.to_str().ok_or("Invalid path encoding")?)
}

/// 刷新日志缓冲区
#[tauri::command]
pub async fn flush_log(
    log_state: State<'_, LogState>,
) -> Result<(), String> {
    let mut manager = log_state.manager.lock()
        .map_err(|e| format!("Failed to lock log manager: {}", e))?;

    manager.flush()
}
