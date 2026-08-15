/**
 * HyperCom 后端主入口
 * 注册所有 Tauri 命令、初始化各模块、管理应用生命周期
 */
mod commands;
mod config;
mod diaglog;
mod logger;
mod serial;
mod system;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

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
    /// 串口管理器：负责串口的打开/关闭/数据收发。
    /// `Arc<Mutex<..>>`（issue #6-1）：异步命令经 spawn_blocking 把阻塞写
    /// 挪到独立线程时，需要从 State 克隆出 'static 句柄——Arc 允许克隆，
    /// `Deref<Target=Mutex<..>>` 使既有 `.lock()` 调用点零改动。
    pub serial_manager: std::sync::Arc<std::sync::Mutex<serial::SerialManager>>,
    /// 配置管理器：负责读写应用配置（含全部设置实体）
    pub config_manager: std::sync::Mutex<config::ConfigManager>,
    /// 日志管理器：负责日志文件的写入与管理（同 serial_manager 的 Arc 理由）
    pub log_manager: std::sync::Arc<std::sync::Mutex<logger::LogManager>>,
    /// 诊断日志器：应用自身维测日志（后端 `log::*` + 前端 `console.*` 转发，统一落盘+轮转）
    pub diag_logger: std::sync::Arc<diaglog::DiagLogger>,
    /// 缓存的 sysinfo::System 实例（增量刷新，避免每次 new_all 的高开销）
    pub system_info: std::sync::Mutex<sysinfo::System>,
    /// 正在运行的外部工具子进程（按 port_id 索引），供 kill_port_tool 终止
    pub tool_processes: std::sync::Mutex<std::collections::HashMap<String, tokio::process::Child>>,
    /// 文件发送取消令牌（按 port_id 索引），供 cancel_file_send 置位
    pub file_send_cancel:
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    /// 弹出窗注册表：key 为窗口 label，value 记录 {kind, target_id}（Phase 1 柔性工作区）
    pub popouts: std::sync::Mutex<std::collections::HashMap<String, commands::PopoutMeta>>,
}

impl AppState {
    pub fn new(diag_logger: std::sync::Arc<diaglog::DiagLogger>) -> anyhow::Result<Self> {
        // 解析 CLI `--config <path>` 参数，允许自定义配置文件路径
        let config_arg = std::env::args()
            .skip(1)
            .position(|a| a == "--config")
            .and_then(|i| std::env::args().nth(i + 2))
            .map(std::path::PathBuf::from);

        // 先建 ConfigManager，再用其配置初始化 LogManager（消除双数据源）
        let config_manager = config::ConfigManager::new(config_arg)?;
        let cfg = config_manager.get_config();
        let mut log_manager = logger::LogManager::new();
        log_manager.set_auto_save(cfg.auto_save_log);
        log_manager.set_default_encoding(&cfg.log_encoding);
        log_manager.set_filename_format(&cfg.log_filename_format);
        log_manager.set_split_size(cfg.log_split_size_mb);
        log_manager.set_split_enabled(cfg.log_split_enabled);
        log_manager.set_subdir_mode(&cfg.log_subdir_mode);
        if !cfg.log_directory.is_empty() {
            if let Err(e) = log_manager.set_directory(cfg.log_directory.clone()) {
                log::warn!("Failed to set log directory from config: {}", e);
            }
        }

        // 用配置同步诊断日志开关。
        diag_logger.set_enabled(cfg.diag_log_enabled);

        Ok(Self {
            serial_manager: std::sync::Arc::new(std::sync::Mutex::new(serial::SerialManager::new())),
            config_manager: std::sync::Mutex::new(config_manager),
            log_manager: std::sync::Arc::new(std::sync::Mutex::new(log_manager)),
            diag_logger,
            system_info: std::sync::Mutex::new(sysinfo::System::new()),
            tool_processes: std::sync::Mutex::new(std::collections::HashMap::new()),
            file_send_cancel: std::sync::Mutex::new(std::collections::HashMap::new()),
            popouts: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
    }
}

/// 终端弹出窗关闭事件载荷（Rust → 主窗前端，触发 detach 标签回贴）。
/// `#[serde(rename_all = "camelCase")]` 使 `port_id` 在 wire 上为 `portId`，
/// 与前端 `PopoutTerminalClosedPayload` 一致。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalClosedPayload {
    port_id: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化诊断日志器（替换原 env_logger）：后端 log::* 统一落盘 + 轮转。
    // 目录取数据目录 `hypercom/diag`（与串口日志 `hypercom/logs` 同级）。
    let diag_dir = dirs::data_dir()
        .map(|d| d.join("hypercom").join("diag"))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let diag_logger = match diaglog::install(diag_dir) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[diaglog] init failed ({}), file logging disabled", e);
            // 兜底：命令路径需要一个可用的 DiagLogger 实例。
            std::sync::Arc::new(
                diaglog::DiagLogger::new(std::env::temp_dir().join("hypercom-diag"))
                    .expect("diag logger fallback"),
            )
        }
    };
    log::info!("HyperCom starting...");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new(diag_logger).expect("Failed to initialize app state"))
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
            commands::cancel_file_send,
            // ===== 模拟模式命令 =====
            commands::enable_simulation,
            commands::disable_simulation,
            // ===== 模拟终端命令（git bash，仅 debug，issue #11）=====
            commands::enable_gitbash_sim,
            commands::disable_gitbash_sim,
            commands::resize_gitbash_sim,
            // ===== 配置相关命令 =====
            commands::get_config,
            commands::set_config,
            commands::reset_config,
            commands::update_session_snapshot,
            commands::get_session_snapshot,
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
            commands::migrate_log_directory,
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
            // ===== 串口分组命令 =====
            commands::save_port_groups,
            // ===== 串口元数据命令（备注名/隐藏，issue #4-9）=====
            commands::save_port_meta,
            // ===== 条件触发规则命令 =====
            commands::save_trigger_rule,
            commands::load_trigger_rules,
            commands::delete_trigger_rule,
            // ===== 通用文件命令 =====
            commands::write_text_file,
            commands::read_text_file,
            // ===== 诊断日志命令 =====
            commands::get_diag_log_path,
            commands::read_diag_log,
            commands::clear_diag_log,
            commands::append_diag_log,
            // ===== 弹出窗命令（柔性工作区 Phase 1）=====
            commands::open_popout,
            commands::close_popout,
            commands::set_popout_always_on_top,
            // ===== 自动更新命令（issue #12）=====
            commands::check_for_update,
            commands::download_and_install_update,
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
            let label = window.label();

            // 主窗关闭行为：config.closeBehavior == "minimize" 时拦截关闭、隐藏到托盘。
            // 仅限主窗——弹出窗（quick-send / terminal-*）必须正常关闭，不能被托盘逻辑吞掉
            // （旧实现未区分 label，closeBehavior=minimize 时弹窗会被 hide 而非关闭）。
            if label == "main" {
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
            }

            // 终端弹出窗销毁 → 通知主窗回贴标签（detach 的"关窗回贴"）。
            // 选 Destroyed 而非 CloseRequested：`close_popout`（"收回"按钮）走 destroy()
            // 会绕过 CloseRequested，而 Destroyed 对 X 按钮 / destroy() 两条路径都恰好触发
            // 一次。先从注册表移除再 emit，使任何重复触发幂等（移除后 target_id 为 None）。
            if label.starts_with("terminal-") {
                if let tauri::WindowEvent::Destroyed = event {
                    let target = window
                        .state::<AppState>()
                        .popouts
                        .lock()
                        .ok()
                        .and_then(|mut popouts| popouts.remove(label))
                        .and_then(|meta| meta.target_id);
                    if let Some(port_id) = target {
                        let _ = window.app_handle().emit(
                            "popout:terminal:closed",
                            TerminalClosedPayload { port_id },
                        );
                    }
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
