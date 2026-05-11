/**
 * HyperCom 后端主入口
 * 注册所有 Tauri 命令、初始化各模块、管理应用生命周期
 */

mod commands;
mod config;
mod logger;
mod serial;
mod storage;

use tauri::Manager;

/// 应用状态结构体
/// 通过 Tauri State 在各命令间共享
pub struct AppState {
    /// 串口管理器：负责串口的打开/关闭/数据收发
    pub serial_manager: std::sync::Mutex<serial::SerialManager>,
    /// 配置管理器：负责读写应用配置
    pub config_manager: std::sync::Mutex<config::ConfigManager>,
    /// 日志管理器：负责日志文件的写入与管理
    pub log_manager: std::sync::Mutex<logger::LogManager>,
    /// 存储管理器：负责 SQLite 数据库操作
    pub storage_manager: std::sync::Mutex<storage::StorageManager>,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            serial_manager: std::sync::Mutex::new(serial::SerialManager::new()),
            config_manager: std::sync::Mutex::new(config::ConfigManager::new()?),
            log_manager: std::sync::Mutex::new(logger::LogManager::new()),
            storage_manager: std::sync::Mutex::new(storage::StorageManager::new()?),
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化日志
    env_logger::init();
    log::info!("HyperCom starting...");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new().expect("Failed to initialize app state"))
        .invoke_handler(tauri::generate_handler![
            // ===== 串口相关命令 =====
            commands::list_available_ports,
            commands::open_serial_port,
            commands::close_serial_port,
            commands::send_serial_data,
            commands::set_serial_params,
            commands::set_flow_control,
            // ===== 模拟模式命令 =====
            commands::enable_simulation,
            commands::disable_simulation,
            // ===== 配置相关命令 =====
            commands::get_config,
            commands::set_config,
            commands::reset_config,
            // ===== 日志相关命令 =====
            commands::set_log_directory,
            commands::save_log_as,
            commands::get_log_files,
            commands::start_logging,
            commands::stop_logging,
            // ===== 系统相关命令 =====
            commands::get_system_status,
            commands::prevent_screen_off,
            commands::prevent_sleep,
        ])
        .setup(|_app| {
            // 设置 AppHandle，用于串口数据事件推送
            let app_handle = _app.handle().clone();
            let state = _app.state::<AppState>();
            let mut serial_mgr = state.serial_manager.lock().unwrap();
            serial_mgr.set_app_handle(app_handle);
            drop(serial_mgr);

            log::info!("HyperCom setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}