/**
 * Tauri 命令层 (Command Layer)
 * 所有前端通过 invoke 调用的 Rust 函数均定义于此
 * 每个命令函数负责参数校验、调用对应 Manager、返回结果
 */

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

// ==================== 串口相关命令 ====================

/// 获取系统可用串口列表
/// 前端调用: invoke('list_available_ports')
#[tauri::command]
pub fn list_available_ports(state: State<AppState>) -> Result<Vec<serial::PortInfo>, String> {
    let manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.list_ports().map_err(|e| e.to_string())
}

/// 打开指定串口
#[derive(Debug, Deserialize)]
pub struct OpenPortArgs {
    pub port_id: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: String,
    pub handshake: String,
    pub dtr: bool,
    pub rts: bool,
}

#[tauri::command]
pub fn open_serial_port(args: OpenPortArgs, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.open_port(args).map_err(|e| e.to_string())
}

/// 关闭指定串口
#[tauri::command]
pub fn close_serial_port(port_id: String, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.close_port(&port_id).map_err(|e| e.to_string())
}

/// 向串口发送数据
#[derive(Debug, Deserialize)]
pub struct SendDataArgs {
    pub port_id: String,
    pub data: String,
    pub is_hex: bool,
    pub append_line_ending: String,
}

#[tauri::command]
pub fn send_serial_data(args: SendDataArgs, state: State<AppState>) -> Result<usize, String> {
    let n = {
        let manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
        manager.send_data(&args.port_id, &args.data, args.is_hex, &args.append_line_ending)
            .map_err(|e| e.to_string())?
    };
    // Write TX data to log if a writer exists
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    // 用与 send_data() 相同的解析逻辑还原写入串口的字节序列：
    // - HEX 模式：解析 "48 65 6C" 形式
    // - 文本模式：附加 line ending（与 send_data 内部行为一致）
    // 解析失败时仅记录文本字节，避免写入与实际不一致；HEX 解析在前面的 send_data 已成功，理论上不会失败。
    let log_data: Vec<u8> = if args.is_hex {
        serial::parse_hex_string(&args.data).unwrap_or_else(|_| args.data.as_bytes().to_vec())
    } else {
        let mut text = args.data.clone();
        match args.append_line_ending.as_str() {
            "\\r\\n" => text.push_str("\r\n"),
            "\\r" => text.push('\r'),
            "\\n" => text.push('\n'),
            _ => {}
        }
        text.into_bytes()
    };
    if let Ok(mut log_mgr) = state.log_manager.lock() {
        let _ = log_mgr.write(&args.port_id, &timestamp, "TX", &log_data);
    }
    Ok(n)
}

/// 设置串口参数（波特率、数据位等）
#[derive(Debug, Deserialize)]
pub struct SetSerialParamsArgs {
    pub port_id: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: String,
    pub handshake: String,
}

#[tauri::command]
pub fn set_serial_params(args: SetSerialParamsArgs, state: State<AppState>) -> Result<(), String> {
    let manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.set_params(&args.port_id, args.baud_rate, &args.data_bits.to_string(), &args.parity, &args.stop_bits, &args.handshake)
        .map_err(|e| e.to_string())
}

/// 设置流控（DTR/RTS/握手协议）
#[tauri::command]
pub fn set_flow_control(port_id: String, dtr: bool, rts: bool, state: State<AppState>) -> Result<(), String> {
    let manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.set_flow_control(&port_id, dtr, rts).map_err(|e| e.to_string())
}

// ==================== 模拟模式命令 ====================

/// 启用模拟模式（在串口列表中添加 SIM:Loopback）
#[tauri::command]
pub fn enable_simulation(state: State<AppState>) -> Result<(), String> {
    let mut manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.set_simulate(true);
    log::info!("Simulation mode enabled");
    Ok(())
}

/// 禁用模拟模式（关闭所有模拟串口并从列表中移除）
#[tauri::command]
pub fn disable_simulation(state: State<AppState>) -> Result<(), String> {
    let sim_ids: Vec<String> = {
        let manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
        manager.sim_ports.keys().cloned().collect()
    };
    for id in &sim_ids {
        let mut manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
        manager.close_port(id).map_err(|e| e.to_string())?;
    }
    let mut manager = state.serial_manager.lock().map_err(|e| e.to_string())?;
    manager.set_simulate(false);
    log::info!("Simulation mode disabled");
    Ok(())
}

// ==================== 配置相关命令 ====================

/// 获取当前应用配置
#[tauri::command]
pub fn get_config(state: State<AppState>) -> Result<config::AppConfig, String> {
    let manager = state.config_manager.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_config().clone())
}

/// 更新应用配置
#[tauri::command]
pub fn set_config(new_config: config::AppConfig, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.config_manager.lock().map_err(|e| e.to_string())?;
    manager.set_config(new_config).map_err(|e| e.to_string())
}

/// 重置配置为默认值
#[tauri::command]
pub fn reset_config(state: State<AppState>) -> Result<config::AppConfig, String> {
    let mut manager = state.config_manager.lock().map_err(|e| e.to_string())?;
    manager.reset_to_default().map_err(|e| e.to_string())
}

// ==================== 日志相关命令 ====================

/// 设置日志存储目录
#[tauri::command]
pub fn set_log_directory(path: String, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.set_directory(path).map_err(|e| e.to_string())
}

/// 手动另存当前日志
#[tauri::command]
pub fn save_log_as(port_id: String, path: String, state: State<AppState>) -> Result<(), String> {
    let manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.save_log_as(&port_id, &path).map_err(|e| e.to_string())
}

/// 获取日志文件列表
#[tauri::command]
pub fn get_log_files(state: State<AppState>) -> Result<Vec<logger::LogFileInfo>, String> {
    let manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.list_files().map_err(|e| e.to_string())
}

/// 设置日志分片大小 (MB)
#[tauri::command]
pub fn set_log_split_size(mb: u32, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.set_split_size(mb);
    Ok(())
}

/// 设置日志文件名格式
#[tauri::command]
pub fn set_log_filename_format(format: String, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.set_filename_format(&format);
    Ok(())
}

/// 设置日志自动保存开关。前端在 set_config 时调用以同步状态。
#[tauri::command]
pub fn set_log_auto_save(enabled: bool, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.set_auto_save(enabled);
    Ok(())
}

/// 设置日志默认编码 (UTF-8 / GBK / ISO-8859-1 / ASCII)。
/// 已存在的 writer 不受影响 — encoding 在 create_writer 时锁定。
#[tauri::command]
pub fn set_log_encoding(encoding: String, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.set_default_encoding(&encoding);
    Ok(())
}

/// 开始记录日志
#[tauri::command]
pub fn start_logging(port_id: String, state: State<AppState>) -> Result<(), String> {
    let config_mgr = state.config_manager.lock().map_err(|e| e.to_string())?;
    let format = config_mgr.get_config().log_format.clone();
    drop(config_mgr);
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.create_writer(&port_id, &format).map_err(|e| e.to_string())
}

/// 停止记录日志
#[tauri::command]
pub fn stop_logging(port_id: String, state: State<AppState>) -> Result<(), String> {
    let mut manager = state.log_manager.lock().map_err(|e| e.to_string())?;
    manager.close_writer(&port_id).map_err(|e| e.to_string())
}

/// 通过系统默认程序打开任意路径（文件或目录）。
/// 用于"打开日志文件"和"打开日志目录"按钮。
#[tauri::command]
pub fn open_path(path: String, state: State<AppState>) -> Result<(), String> {
    // 作用域校验 (defects #54): 仅允许打开 LogManager 的 log_directory 子树下的路径。
    // 防止前端任意 invoke 让后端打开 C:\Windows\System32 等敏感路径。
    let log_dir = {
        let mgr = state.log_manager.lock().map_err(|e| e.to_string())?;
        mgr.get_directory().clone()
    };
    let canonical_target = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize path: {}", e))?;
    let canonical_root = log_dir
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize log root: {}", e))?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(format!("Path is outside log directory scope: {}", path));
    }

    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 路径中含 ',' 时 explorer 会把它当多参数分隔符。raw_arg 跳过 Rust 的 quote 处理，
        // 我们自己用 " 包裹整个路径让 explorer 把它当单一参数 (defects #55)。
        let quoted = format!("\"{}\"", path);
        std::process::Command::new("explorer")
            .raw_arg(&quoted)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 打开当前的日志目录（按当前 LogManager 配置）。
#[tauri::command]
pub fn open_log_directory(state: State<AppState>) -> Result<(), String> {
    let dir = {
        let mgr = state.log_manager.lock().map_err(|e| e.to_string())?;
        mgr.get_directory().to_string_lossy().to_string()
    };
    open_path(dir, state)
}

// ==================== 系统相关命令 ====================

/// 获取系统状态（内存、CPU）
#[derive(Debug, Serialize)]
pub struct SystemStatus {
    pub status: String,
    pub memory_used_mb: u64,
    pub memory_limit_mb: u64,
    pub cpu_usage: f32,
}

#[tauri::command]
pub fn get_system_status(state: State<AppState>) -> SystemStatus {
    let memory_limit_mb = {
        let config_mgr = state.config_manager.lock().unwrap();
        config_mgr.get_config().memory_limit_mb as u64
    };

    // 增量刷新缓存的 System 实例 — 仅刷新本进程与全部 CPU，避免每次 new_all() + refresh_all() 的高开销
    let pid = sysinfo::Pid::from(std::process::id() as usize);
    let mut system = state.system_info.lock().unwrap();
    system.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        false,
    );
    system.refresh_cpu_all();

    let used_memory = system
        .process(pid)
        .map(|p| p.memory() / (1024 * 1024))
        .unwrap_or(0);

    let cpu_usage = if system.cpus().is_empty() {
        0.0
    } else {
        let total: f32 = system.cpus().iter().map(|c| c.cpu_usage()).sum();
        total / system.cpus().len() as f32
    };

    let status = if cpu_usage > 90.0 || used_memory > memory_limit_mb {
        "high_load".to_string()
    } else {
        "normal".to_string()
    };

    SystemStatus {
        status,
        memory_used_mb: used_memory,
        memory_limit_mb,
        cpu_usage: (cpu_usage * 10.0).round() / 10.0,
    }
}

/// 设置防止系统息屏
#[cfg(target_os = "windows")]
mod win32_power {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(esFlags: u32) -> u32;
    }
    const ES_CONTINUOUS: u32 = 0x80000000;
    const ES_SYSTEM_REQUIRED: u32 = 0x00000001;
    const ES_DISPLAY_REQUIRED: u32 = 0x00000002;

    pub fn prevent_screen_off(enable: bool) {
        unsafe {
            if enable {
                SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED);
            } else {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        }
    }

    pub fn prevent_sleep(enable: bool) {
        unsafe {
            if enable {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            } else {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        }
    }
}

#[tauri::command]
pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    win32_power::prevent_screen_off(enable);
    log::info!("Prevent screen off: {}", enable);
    Ok(())
}

#[tauri::command]
pub fn prevent_sleep(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    win32_power::prevent_sleep(enable);
    log::info!("Prevent sleep: {}", enable);
    Ok(())
}

// ==================== 存储相关命令 ====================

/// 保存命令集
#[derive(Debug, Deserialize)]
pub struct SaveCommandSetArgs {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub is_loop: bool,
    pub loop_delay_ms: i32,
    pub commands: Vec<SaveCommandArgs>,
}

#[derive(Debug, Deserialize)]
pub struct SaveCommandArgs {
    pub id: String,
    pub name: String,
    pub order_idx: i32,
    pub delay_ms: i32,
    pub cmd_type: String,
    pub content: String,
    pub append_line_ending: String,
}

#[tauri::command]
pub async fn save_command_set(args: SaveCommandSetArgs, state: State<'_, AppState>) -> Result<String, String> {
    let pool = {
        let storage_mgr = state.storage_manager.lock().map_err(|e| e.to_string())?;
        let db_pool = storage_mgr.pool().map_err(|e| e.to_string())?;
        db_pool.clone()
    };
    let is_update = args.id.is_some();
    let set_id = args.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // If updating existing set, delete old one first to avoid duplicates
    if is_update {
        let _ = storage::delete_command_set_from_db(&pool, &set_id).await;
    }
    let set = storage::SendCommandSet {
        id: set_id.clone(),
        name: args.name,
        is_loop: args.is_loop,
        loop_delay_ms: args.loop_delay_ms,
        commands: args.commands.into_iter().map(|c| storage::SendCommandRow {
            id: c.id,
            set_id: set_id.clone(),
            name: c.name,
            order_idx: c.order_idx,
            delay_ms: c.delay_ms,
            cmd_type: c.cmd_type,
            content: c.content,
            append_line_ending: c.append_line_ending,
        }).collect(),
    };
    storage::save_command_set_to_db(&pool, &set).await.map_err(|e| e.to_string())?;
    Ok(set_id)
}

#[tauri::command]
pub async fn load_command_sets(state: State<'_, AppState>) -> Result<Vec<storage::CommandSetInfo>, String> {
    let pool = {
        let storage_mgr = state.storage_manager.lock().map_err(|e| e.to_string())?;
        let db_pool = storage_mgr.pool().map_err(|e| e.to_string())?;
        db_pool.clone()
    };
    let sets = storage::load_command_sets_from_db(&pool).await.map_err(|e| e.to_string())?;
    Ok(sets.into_iter().map(|s| storage::CommandSetInfo {
        id: s.id,
        name: s.name,
        is_loop: s.is_loop,
        loop_delay_ms: s.loop_delay_ms,
        commands: s.commands.into_iter().map(|c| storage::CommandInfo {
            id: c.id,
            set_id: c.set_id,
            name: c.name,
            order_idx: c.order_idx,
            delay_ms: c.delay_ms,
            cmd_type: c.cmd_type,
            content: c.content,
            append_line_ending: c.append_line_ending,
        }).collect(),
    }).collect())
}

#[tauri::command]
pub async fn delete_command_set(set_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let pool = {
        let storage_mgr = state.storage_manager.lock().map_err(|e| e.to_string())?;
        let db_pool = storage_mgr.pool().map_err(|e| e.to_string())?;
        db_pool.clone()
    };
    storage::delete_command_set_from_db(&pool, &set_id).await.map_err(|e| e.to_string())
}

/// 保存高亮规则集
#[derive(Debug, Deserialize)]
pub struct SaveHighlightSetArgs {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub is_enabled: bool,
    pub rules: Vec<SaveHighlightRuleArgs>,
}

#[derive(Debug, Deserialize)]
pub struct SaveHighlightRuleArgs {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub is_regex: bool,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
}

#[tauri::command]
pub async fn save_highlight_set(args: SaveHighlightSetArgs, state: State<'_, AppState>) -> Result<String, String> {
    let pool = {
        let storage_mgr = state.storage_manager.lock().map_err(|e| e.to_string())?;
        let db_pool = storage_mgr.pool().map_err(|e| e.to_string())?;
        db_pool.clone()
    };
    let is_update = args.id.is_some();
    let set_id = args.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // If updating existing set, delete old one first to avoid duplicates
    if is_update {
        let _ = storage::delete_highlight_set_from_db(&pool, &set_id).await;
    }
    let set = storage::HighlightRuleSet {
        id: set_id.clone(),
        name: args.name,
        is_enabled: args.is_enabled,
        rules: args.rules.into_iter().map(|r| storage::HighlightRuleRow {
            id: r.id,
            set_id: set_id.clone(),
            name: r.name,
            pattern: r.pattern,
            is_regex: r.is_regex,
            color: r.color,
            bold: r.bold,
            italic: r.italic,
        }).collect(),
    };
    storage::save_highlight_set_to_db(&pool, &set).await.map_err(|e| e.to_string())?;
    Ok(set_id)
}

#[tauri::command]
pub async fn load_highlight_sets(state: State<'_, AppState>) -> Result<Vec<storage::HighlightSetInfo>, String> {
    let pool = {
        let storage_mgr = state.storage_manager.lock().map_err(|e| e.to_string())?;
        let db_pool = storage_mgr.pool().map_err(|e| e.to_string())?;
        db_pool.clone()
    };
    let sets = storage::load_highlight_sets_from_db(&pool).await.map_err(|e| e.to_string())?;
    Ok(sets.into_iter().map(|s| storage::HighlightSetInfo {
        id: s.id,
        name: s.name,
        is_enabled: s.is_enabled,
        rules: s.rules.into_iter().map(|r| storage::HighlightRuleInfo {
            id: r.id,
            set_id: r.set_id,
            name: r.name,
            pattern: r.pattern,
            is_regex: r.is_regex,
            color: r.color,
            bold: r.bold,
            italic: r.italic,
        }).collect(),
    }).collect())
}

#[tauri::command]
pub async fn delete_highlight_set(set_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let pool = {
        let storage_mgr = state.storage_manager.lock().map_err(|e| e.to_string())?;
        let db_pool = storage_mgr.pool().map_err(|e| e.to_string())?;
        db_pool.clone()
    };
    storage::delete_highlight_set_from_db(&pool, &set_id).await.map_err(|e| e.to_string())
}

// ==================== 模块引用 ====================

use crate::{config, logger, serial, storage};