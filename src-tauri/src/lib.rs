mod models;
mod serial;
mod commands;
mod storage;
mod parser;

use serial::SerialManager;
use storage::{DatabaseManager, DbState, LogManager, LogState, LogConfig};
use parser::ParserState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 初始化串口管理器
            let serial_manager = SerialManager::new();
            app.manage(serial_manager);
            
            // 初始化数据库管理器
            let db_path = DatabaseManager::default_path(app.handle());
            let mut db_manager = DatabaseManager::new(db_path);
            if let Err(e) = db_manager.initialize() {
                eprintln!("Warning: Failed to initialize database: {}. Some features may not work.", e);
                // 继续运行，但数据库功能可能不可用
            }
            app.manage(DbState::new(db_manager));
            
            // 初始化日志管理器
            let log_config = LogConfig::default();
            let log_manager = LogManager::new(log_config);
            app.manage(LogState::new(log_manager));
            
            // 初始化协议解析器
            app.manage(ParserState::new());
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 串口命令
            commands::list_ports,
            commands::open_port,
            commands::close_port,
            commands::send_data,
            commands::get_status,
            // 配置命令
            commands::get_settings,
            commands::save_settings,
            commands::list_command_groups,
            commands::save_command_group,
            commands::delete_command_group,
            commands::import_commands,
            commands::export_commands,
            // 日志命令
            commands::start_logging,
            commands::stop_logging,
            commands::pause_logging,
            commands::resume_logging,
            commands::get_log_status,
            commands::get_log_config,
            commands::update_log_config,
            commands::get_current_log_file,
            commands::get_log_file_size,
            commands::export_log,
            commands::clear_log,
            commands::list_log_files,
            commands::flush_log,
            // 导出命令
            commands::export_data,
            // 解析器命令
            commands::list_protocols,
            commands::save_protocol,
            commands::delete_protocol,
            commands::set_active_protocol,
            commands::parse_data,
            commands::parse_data_with_protocol,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
