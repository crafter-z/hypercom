mod models;
mod serial;
mod commands;

use serial::SerialManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 初始化串口管理器
            let serial_manager = SerialManager::new();
            app.manage(serial_manager);
            
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
