/**
 * HyperCom 后端主入口
 * 注册所有 Tauri 命令、初始化各模块、管理应用生命周期
 */
mod commands;
mod config;
mod logger;
mod serial;
mod storage;
mod system;

use tauri::{Emitter, Manager};

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
    /// 缓存的 sysinfo::System 实例（增量刷新，避免每次 new_all 的高开销）
    pub system_info: std::sync::Mutex<sysinfo::System>,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            serial_manager: std::sync::Mutex::new(serial::SerialManager::new()),
            config_manager: std::sync::Mutex::new(config::ConfigManager::new()?),
            log_manager: std::sync::Mutex::new(logger::LogManager::new()),
            storage_manager: std::sync::Mutex::new(storage::StorageManager::new()?),
            system_info: std::sync::Mutex::new(sysinfo::System::new()),
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
            commands::export_terminal_log,
            commands::get_log_files,
            commands::start_logging,
            commands::stop_logging,
            commands::set_log_split_size,
            commands::set_log_filename_format,
            commands::set_log_auto_save,
            commands::set_log_encoding,
            commands::open_path,
            commands::open_log_directory,
            // ===== 系统相关命令 =====
            commands::get_system_status,
            commands::prevent_screen_off,
            commands::prevent_sleep,
            // ===== 存储相关命令 =====
            commands::save_command_set,
            commands::load_command_sets,
            commands::delete_command_set,
            commands::save_highlight_set,
            commands::load_highlight_sets,
            commands::delete_highlight_set,
        ])
        .setup(|_app| {
            let app_handle = _app.handle().clone();

            // 设置 AppHandle，用于串口数据事件推送
            let state = _app.state::<AppState>();
            if let Ok(mut serial_mgr) = state.serial_manager.lock() {
                serial_mgr.set_app_handle(app_handle.clone());
            } else {
                log::error!("serial_manager mutex poisoned during setup; serial events will not be emitted");
            }
            drop(state);

            // 预热 sysinfo CPU 采样：first refresh_cpu_all 没有基线会返回 0，
            // 等待 MINIMUM_CPU_UPDATE_INTERVAL (~200ms) 后再次刷新建立基线
            // (defects #50). 阻塞 main 仅 ~250ms 在 setup 里可接受。
            {
                let state = _app.state::<AppState>();
                if let Ok(mut sys) = state.system_info.lock() {
                    sys.refresh_cpu_all();
                } else {
                    log::warn!("system_info mutex poisoned during CPU warmup (first refresh)");
                }
                drop(state);
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
            {
                let state = _app.state::<AppState>();
                if let Ok(mut sys) = state.system_info.lock() {
                    sys.refresh_cpu_all();
                } else {
                    log::warn!("system_info mutex poisoned during CPU warmup (second refresh)");
                }
                drop(state);
            }

            // 异步初始化数据库（不持有 MutexGuard 跨 await）
            let app_handle2 = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                match storage::create_pool().await {
                    Ok(pool) => {
                        if let Err(e) = storage::init_schema_on_pool(&pool).await {
                            log::warn!("Schema init failed: {}", e);
                        }
                        // 使用 AppHandle 获取 state，因为 AppHandle 是 'static
                        let state2 = app_handle2.state::<AppState>();
                        let stored = state2.storage_manager.lock()
                            .map(|mut mgr| mgr.set_pool(pool))
                            .is_ok();
                        if stored {
                            log::info!("Storage initialized successfully");
                            let _ = app_handle2.emit("storage:ready", ());
                        } else {
                            log::error!("storage_manager mutex poisoned; DB pool not stored. DB unavailable.");
                        }
                    }
                    Err(e) => log::warn!("DB connection failed (non-critical): {}", e),
                }
            });

            log::info!("HyperCom setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
