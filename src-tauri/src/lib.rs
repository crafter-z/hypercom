/**
 * HyperCom 后端主入口
 * 注册所有 Tauri 命令、初始化各模块、管理应用生命周期
 */
mod commands;
mod config;
mod diaglog;
mod logger;
mod plugin;
mod serial;
mod system;
mod update_network;

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
    let timestamp = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
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
    /// Exclusive per-config-directory lock; dropped on process exit.
    _instance_lock: std::fs::File,
    /// 串口管理器：负责串口的打开/关闭/数据收发。
    /// `Arc<Mutex<..>>`（issue #6-1）：异步命令经 spawn_blocking 把阻塞写
    /// 挪到独立线程时，需要从 State 克隆出 'static 句柄——Arc 允许克隆，
    /// `Deref<Target=Mutex<..>>` 使既有 `.lock()` 调用点零改动。
    pub serial_manager: std::sync::Arc<std::sync::Mutex<serial::SerialManager>>,
    /// 配置管理器：负责读写应用配置（含全部设置实体）
    pub config_manager: std::sync::Mutex<config::ConfigManager>,
    /// 插件安装、卸载及私有资产写入共享的异步闸门；覆盖 fs 与状态提交整个事务。
    pub plugin_io: tokio::sync::Mutex<()>,
    /// 日志管理器：负责日志文件的写入与管理。
    /// `Arc<LogManager>`（无外层 Mutex）：写路径已是 `&self` + 内部细粒度锁，
    /// 再套一层 Mutex 会让 `save_log_as` 的文件拷贝、`list_files` 的递归遍历与
    /// 数据写入争同一把锁（高波特率下 RX 写入被拖住）。
    pub log_manager: std::sync::Arc<logger::LogManager>,
    /// 诊断日志器：应用自身维测日志（后端 `log::*` + 前端 `console.*` 转发，统一落盘+轮转）
    pub diag_logger: std::sync::Arc<diaglog::DiagLogger>,
    /// 缓存的 sysinfo::System 实例（增量刷新，避免每次 new_all 的高开销）。
    /// `Arc<Mutex<..>>`（issue #6-1 同款）：`get_system_status` 改 async +
    /// spawn_blocking 后，需要从 State 克隆出 'static 句柄供阻塞线程使用；
    /// `Deref<Target=Mutex<..>>` 使既有 `.lock()` 调用点（lib.rs CPU 预热）零改动。
    pub system_info: std::sync::Arc<std::sync::Mutex<sysinfo::System>>,
    /// Prevent duplicate asynchronous shutdown coordinators from racing exit.
    pub shutdown_started: std::sync::atomic::AtomicBool,
    /// Active serial/file/tool admission and coordinated shutdown gate.
    pub serial_work: std::sync::Arc<commands::SerialWorkState>,
    /// Active external-tool ownership tokens, keyed by port.
    pub tool_reservations: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// 正在运行的外部工具子进程（按 port_id 索引），供 kill_port_tool 终止
    pub tool_processes: std::sync::Mutex<std::collections::HashMap<String, tokio::process::Child>>,
    /// File-send ownership and cancellation state, keyed by port.
    pub file_send_cancel:
        std::sync::Mutex<std::collections::HashMap<String, commands::FileSendRegistration>>,
    /// 弹出窗注册表：key 为窗口 label，value 记录 {kind, target_id}（Phase 1 柔性工作区）
    pub popouts: std::sync::Mutex<std::collections::HashMap<String, commands::PopoutMeta>>,
}

/// Try to take an exclusive lock next to config.json. Returns Err when another
/// process already owns it (the caller exits rather than corrupting config).
fn acquire_instance_lock(config_path: &std::path::Path) -> anyhow::Result<std::fs::File> {
    let lock_path = config_path.with_extension("lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // No sharing: a second instance fails to open the same lock file.
        options.share_mode(0);
    }
    let mut file = options
        .open(&lock_path)
        .map_err(|e| anyhow::anyhow!(
            "Another HyperCom instance is using {} ({e})",
            config_path.display()
        ))?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            return Err(anyhow::anyhow!(
                "Another HyperCom instance is using {} ({})",
                config_path.display(),
                std::io::Error::last_os_error()
            ));
        }
    }
    use std::io::Write;
    let _ = file.set_len(0);
    let _ = writeln!(file, "{}", std::process::id());
    let _ = file.flush();
    Ok(file)
}

impl AppState {
    pub fn new(diag_logger: std::sync::Arc<diaglog::DiagLogger>) -> anyhow::Result<Self> {
        // 解析 CLI `--config <path>` 参数，允许自定义配置文件路径
        let config_arg = std::env::args()
            .skip(1)
            .position(|a| a == "--config")
            .and_then(|i| std::env::args().nth(i + 2))
            .map(std::path::PathBuf::from);

        // 先建 ConfigManager，再用其配置初始化运行期镜像（消除双数据源）
        let config_manager = config::ConfigManager::new(config_arg)?;
        let cfg = config_manager.get_config().clone();
        // One writer per config directory: concurrent instances otherwise race
        // config.json/session.json (fixed temp names + per-process revision CAS).
        let instance_lock = acquire_instance_lock(config_manager.config_path())?;

        let state = Self {
            _instance_lock: instance_lock,
            serial_manager: std::sync::Arc::new(
                std::sync::Mutex::new(serial::SerialManager::new()),
            ),
            config_manager: std::sync::Mutex::new(config_manager),
            plugin_io: tokio::sync::Mutex::new(()),
            log_manager: std::sync::Arc::new(logger::LogManager::new()),
            diag_logger,
            system_info: std::sync::Arc::new(std::sync::Mutex::new(sysinfo::System::new())),
            serial_work: std::sync::Arc::new(commands::SerialWorkState::new()),
            tool_reservations: std::sync::Mutex::new(std::collections::HashMap::new()),
            tool_processes: std::sync::Mutex::new(std::collections::HashMap::new()),
            file_send_cancel: std::sync::Mutex::new(std::collections::HashMap::new()),
            shutdown_started: std::sync::atomic::AtomicBool::new(false),
            popouts: std::sync::Mutex::new(std::collections::HashMap::new()),
        };
        // 启动时把配置里的日志设置同步到 LogManager（与 set_config 命令同一入口）。
        state.apply_runtime_config(&cfg);
        Ok(state)
    }

    /// 把配置中属于「运行期镜像」的设置应用到各管理器：日志设置 → `LogManager`，
    /// 诊断日志开关 → `DiagLogger`。
    ///
    /// 这是**唯一**的同步入口（`AppState::new` 启动同步 与 `set_config` 命令两处共用）。
    /// 此前两份逐字段手抄的 setter 列表（启动一份、set_config 一份）在新增设置项时
    /// 必然漏掉一处，导致「配置改了但日志行为没变」。
    pub fn apply_runtime_config(&self, cfg: &config::AppConfig) {
        self.log_manager
            .apply_settings(&logger::LogSettings::from_config(cfg));
        self.diag_logger.set_enabled(cfg.diag_log_enabled);
    }
}

/// Start one asynchronous shutdown drain. The UI remains alive until serial
/// readers/work, RX log tails, power inhibitors, and diagnostic logs are finalized.
fn request_shutdown(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state
        .shutdown_started
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if let Err(error) = commands::shutdown_serial_work(app.clone(), &state).await {
            log::error!("Serial shutdown failed: {error}");
        }
        let logs = std::sync::Arc::clone(&state.log_manager);
        let diag = std::sync::Arc::clone(&state.diag_logger);
        let result = tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = logs.close_all() {
                log::error!("Log shutdown failed: {error}");
            }
            if let Err(error) = system::shutdown_power_inhibitor() {
                log::error!("Power inhibitor shutdown failed: {error}");
            }
            if let Err(error) = diag.flush() {
                log::error!("Diagnostic log flush failed: {error}");
            }
        })
        .await;
        if let Err(error) = result {
            log::error!("Shutdown finalizer failed: {error}");
        }
        app.exit(0);
    });
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

    let state = match AppState::new(diag_logger) {
        Ok(state) => state,
        Err(error) => {
            log::error!("Failed to initialize app state: {error}");
            eprintln!("Failed to initialize HyperCom: {error}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
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
            commands::update_session_snapshot,
            commands::get_session_snapshot,
            commands::get_config_path,
            // ===== 日志相关命令 =====
            commands::pick_and_save_log,
            commands::get_log_files,
            commands::start_logging,
            commands::stop_logging,
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
            commands::pick_text_file_and_write,
            commands::pick_text_file_and_read,
            commands::read_text_file,
            commands::plugin_pick_files,
            commands::read_image_data_url,
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
            // ===== 插件命令（issue #17）=====
            commands::list_plugins,
            commands::install_plugin,
            commands::uninstall_plugin,
            commands::set_plugin_enabled,
            commands::set_plugin_permissions,
            commands::read_plugin_asset,
            commands::write_plugin_asset,
            commands::plugin_http,
            commands::plugin_open_external,
            commands::create_plugin_view,
            commands::update_plugin_view,
            commands::send_plugin_view_message,
            commands::destroy_plugin_view,
        ])
        .setup(|_app| {
            let app_handle = _app.handle().clone();

            // 设置 AppHandle，用于串口数据事件推送
            let state = _app.state::<AppState>();
            if let Ok(mut serial_mgr) = state.serial_manager.lock() {
                serial_mgr.set_app_handle(app_handle.clone());
            } else {
                log::error!(
                    "serial_manager mutex poisoned during setup; serial events will not be emitted"
                );
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
                // LogManager 自身的写锁是内部细粒度锁（非 &self 上的 Mutex），
                // 这里直接调用；即使与某次写入并发，flush_all 也只做 best-effort。
                let state = panic_app_handle.state::<AppState>();
                // Never block: the panicking thread may hold one of these locks.
                state.log_manager.flush_all_best_effort();

                let report = format_crash_report(message, location, &backtrace);
                let crash_dir = dirs::data_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("hypercom")
                    .join("crash");
                let _ = std::fs::create_dir_all(&crash_dir);
                let filename = chrono::Local::now()
                    .format("crash-%Y%m%d-%H%M%S.txt")
                    .to_string();
                let crash_path = crash_dir.join(filename);
                if let Err(e) = std::fs::write(&crash_path, &report) {
                    eprintln!("Failed to write crash report to {:?}: {}", crash_path, e);
                }

                eprintln!("{}\n", report);
                std::process::abort();
            }));

            // ===== 系统托盘（最小化到托盘）=====
            // 菜单：显示窗口 / 退出；单击托盘图标亦显示窗口。
            let show_item =
                MenuItem::with_id(_app, "tray.show", "Show HyperCom", true, None::<&str>)?;
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
                        // Keep the main UI alive while the asynchronous shutdown
                        // coordinator drains serial readers and log ownership.
                        request_shutdown(app.clone());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Only react to LEFT click. On Windows a right-click also
                    // fires TrayIconEvent::Click; calling set_focus() there
                    // steals focus from the native tray menu and dismisses it.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
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
                    let state = window.state::<AppState>();
                    let closing = state
                        .shutdown_started
                        .load(std::sync::atomic::Ordering::Acquire);
                    let close_to_tray = state
                        .config_manager
                        .lock()
                        .map(|mgr| mgr.get_config().close_behavior == "minimize")
                        .unwrap_or(false);
                    if closing {
                        api.prevent_close();
                    } else if close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        api.prevent_close();
                        request_shutdown(window.app_handle().clone());
                    }
                }
                if let tauri::WindowEvent::Destroyed = event {
                    plugin::view_runtime::clear_all();
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
                        let _ = window
                            .app_handle()
                            .emit("popout:terminal:closed", TerminalClosedPayload { port_id });
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                if !state
                    .shutdown_started
                    .load(std::sync::atomic::Ordering::Acquire)
                {
                    api.prevent_exit();
                    request_shutdown(app.clone());
                }
            }
        });
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_crash_report_contains_timestamp_message_location_and_backtrace() {
        let backtrace = Backtrace::force_capture();
        let report = format_crash_report(
            "test panic message",
            Some(std::panic::Location::caller()),
            &backtrace,
        );
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
