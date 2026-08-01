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

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use std::backtrace::Backtrace;

/// 构建崩溃报告文本，用于 panic hook 写入文件并在测试中断言。
fn format_crash_report(
    message: &str,
    location: Option<&std::panic::Location>,
    backtrace: &Backtrace,
) -> String {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    let loc = location
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "unknown location".to_string());
    format!(
        "HyperCom Crash Report\n=====================\n\nTimestamp: {}\nLocation: {}\n\nPanic message:\n{}\n\nBacktrace:\n{}\n",
        timestamp,
        loc,
        message,
        backtrace
    )
}

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
    /// 正在运行的外部工具子进程（按 port_id 索引），供 kill_port_tool 终止
    pub tool_processes: std::sync::Mutex<std::collections::HashMap<String, tokio::process::Child>>,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        // 解析 CLI `--config <path>` 参数，允许自定义配置文件路径
        let config_arg = std::env::args()
            .skip(1)
            .position(|a| a == "--config")
            .and_then(|i| std::env::args().nth(i + 2))
            .map(std::path::PathBuf::from);
        Ok(Self {
            serial_manager: std::sync::Mutex::new(serial::SerialManager::new()),
            config_manager: std::sync::Mutex::new(config::ConfigManager::new(config_arg)?),
            log_manager: std::sync::Mutex::new(logger::LogManager::new()),
            storage_manager: std::sync::Mutex::new(storage::StorageManager::new()?),
            system_info: std::sync::Mutex::new(sysinfo::System::new()),
            tool_processes: std::sync::Mutex::new(std::collections::HashMap::new()),
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new().expect("Failed to initialize app state"))
        .invoke_handler(tauri::generate_handler![
            // ===== 串口相关命令 =====
            commands::list_available_ports,
            commands::open_serial_port,
            commands::close_serial_port,
            commands::send_serial_data,
            commands::send_file,
            commands::set_serial_params,
            commands::set_flow_control,
            commands::attempt_reconnect,
            commands::run_port_tool,
            commands::kill_port_tool,
            // ===== 模拟模式命令 =====
            commands::enable_simulation,
            commands::disable_simulation,
            // ===== 配置相关命令 =====
            commands::get_config,
            commands::set_config,
            commands::reset_config,
            commands::update_session_snapshot,
            commands::get_config_path,
            // ===== 日志相关命令 =====
            commands::set_log_directory,
            commands::save_log_as,
            commands::export_terminal_log,
            commands::get_log_files,
            commands::start_logging,
            commands::stop_logging,
            commands::set_log_split_size,
            commands::set_log_split_enabled,
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
            commands::save_protocol_template,
            commands::load_protocol_templates,
            commands::delete_protocol_template,
            // ===== 端口参数预设命令 =====
            commands::save_port_preset,
            commands::load_port_presets,
            commands::delete_port_preset,
            commands::save_port_tool_config,
            commands::load_port_tool_configs,
            commands::delete_port_tool_config,
            // ===== 条件触发规则命令 =====
            commands::save_trigger_rule,
            commands::load_trigger_rules,
            commands::delete_trigger_rule,
            // ===== 通用文件命令 =====
            commands::write_text_file,
            commands::read_text_file,
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
            // drop(state) 对 borrow checker 有意义：State<'_, T> 是引用包装，
            // 显式 drop 确保 MutexGuard 临时值在 state 之前析构。
            #[allow(clippy::drop_non_drop)]
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
                #[allow(clippy::drop_non_drop)]
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
                #[allow(clippy::drop_non_drop)]
                drop(state);
            }

            // 同步初始化数据库：在 setup 内 block_on 完成建池 + 建表，保证前端
            // 任何存储命令都不会与建池竞态。旧实现用 spawn 异步建池，而前端
            // useAppInit 一挂载就并发加载命令集/规则集、ParamsSection 一挂载就
            // 加载端口预设——这些调用常常跑在建池完成之前，命中 "Database not
            // initialized"，且预设加载失败后不再重试，导致下拉菜单永远为空。
            // 阻塞 main 线程数十毫秒可接受（上方 CPU 预热已阻塞 ~250ms）。
            // block_on 内部不持有 MutexGuard；set_pool 在 block_on 返回后执行。
            let db_result = tauri::async_runtime::block_on(async {
                let pool = storage::create_pool().await?;
                storage::init_schema_on_pool(&pool).await?;
                anyhow::Ok(pool)
            });
            match db_result {
                Ok(pool) => {
                    let stored = _app.state::<AppState>().storage_manager.lock()
                        .map(|mut mgr| mgr.set_pool(pool))
                        .is_ok();
                    if stored {
                        log::info!("Storage initialized successfully");
                    } else {
                        log::error!("storage_manager mutex poisoned; DB pool not stored. DB unavailable.");
                    }
                }
                Err(e) => log::error!("DB initialization failed: {}. Storage commands will be unavailable.", e),
            }

            // 安装 panic hook：先 flush 日志，再写崩溃报告，最后 abort 终止进程
            let panic_app_handle = app_handle.clone();
            std::panic::set_hook(Box::new(move |info| {
                let message = info
                    .payload()
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
                    .unwrap_or("panic occurred");
                let location = info.location();
                let backtrace = Backtrace::force_capture();

                // 尽最大努力 flush 日志，flush 失败不遮蔽原 panic。
                // 用 try_lock 而非 lock：std::sync::Mutex 不可重入，若 panic 发生在
                // 已持有 log_manager 锁的线程（如日志写入途中），lock() 会永久阻塞，
                // 导致 process::abort() 永远无法到达。拿不到锁就跳过 flush——
                // 崩溃报告比最后一批日志更重要。
                if let Ok(mut log_mgr) = panic_app_handle.state::<AppState>().log_manager.try_lock() {
                    let _ = log_mgr.flush_all();
                }

                let report = format_crash_report(message, location, &backtrace);
                let crash_dir = dirs::data_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("hypercom")
                    .join("crash");
                let _ = std::fs::create_dir_all(&crash_dir);
                let filename = chrono::Local::now().format("crash-%Y%m%d-%H%M%S.txt").to_string();
                let crash_path = crash_dir.join(filename);
                if let Err(e) = std::fs::write(&crash_path, &report) {
                    eprintln!("Failed to write crash report to {:?}: {}", crash_path, e);
                }

                eprintln!("{}\n", report);
                std::process::abort();
            }));

            // ===== 系统托盘（最小化到托盘）=====
            // 菜单：显示窗口 / 退出；单击托盘图标亦显示窗口。
            let show_item = MenuItem::with_id(_app, "tray.show", "Show HyperCom", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(_app, "tray.quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(_app, &[&show_item, &quit_item])?;
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("HyperCom")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray.show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "tray.quit" => {
                        // Destroy the (possibly tray-hidden) window BEFORE exit.
                        // Otherwise its handle still exists during teardown and
                        // WebView2/Chromium logs "Failed to unregister class
                        // Chrome_WidgetWin_0 (Error 1411)". destroy() bypasses
                        // CloseRequested, so the minimize-to-tray guard won't
                        // re-hide it.
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.destroy();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Only react to LEFT click. On Windows a right-click also
                    // fires TrayIconEvent::Click; calling set_focus() there
                    // steals focus from the native tray menu and dismisses it.
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = _app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(_app)?;

            log::info!("HyperCom setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭行为：config.closeBehavior == "minimize" 时拦截关闭、隐藏到托盘
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = window
                    .state::<AppState>()
                    .config_manager
                    .lock()
                    .map(|mgr| mgr.get_config().close_behavior == "minimize")
                    .unwrap_or(false);
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_crash_report_contains_timestamp_message_location_and_backtrace() {
        let backtrace = Backtrace::force_capture();
        let report = format_crash_report("test panic message", Some(std::panic::Location::caller()), &backtrace);
        assert!(report.contains("HyperCom Crash Report"));
        assert!(report.contains("test panic message"));
        assert!(report.contains("lib.rs"));
        assert!(report.contains("Backtrace"));
        assert!(report.contains("Timestamp:"));
    }

    #[test]
    fn test_format_crash_report_falls_back_when_location_missing() {
        let backtrace = Backtrace::force_capture();
        let report = format_crash_report("no location", None, &backtrace);
        assert!(report.contains("unknown location"));
        assert!(report.contains("no location"));
    }
}
