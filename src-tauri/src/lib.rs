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
use tauri::{Emitter, EventTarget, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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

/// How long the frontend may sit on an editor close request before its token expires.
pub const EDITOR_CLOSE_REQUEST_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(60);

/// One outstanding main-window close approval. The token is what the frontend
/// passes back to `complete_editor_close` / `cancel_editor_close`, so a forged or
/// stale call can never approve a close the backend did not request.
#[derive(Debug, Clone)]
pub struct PendingClose {
    pub id: String,
    pub force_exit: bool,
    pub issued_at: std::time::Instant,
    pub last_seen: Option<std::time::Instant>,
}

impl PendingClose {
    fn is_expired(&self) -> bool {
        self.last_seen.unwrap_or(self.issued_at).elapsed() > EDITOR_CLOSE_REQUEST_TIMEOUT
    }
}

/// Payload of the `editor:close-requested` event (camelCase on the wire).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorCloseRequested {
    request_id: String,
    force_exit: bool,
}

/// Create or promote the pending close request.
///
/// A newer forced exit upgrades an existing request in place (same id, force
/// latched to `true`); a non-forced repeat reuses the id and the already-upgraded
/// force flag. Repeated native close requests therefore coalesce into one dialog.
pub(crate) fn promote_pending_close(
    pending: &mut Option<PendingClose>,
    force_exit: bool,
    now: std::time::Instant,
) -> PendingClose {
    if pending.as_ref().is_some_and(PendingClose::is_expired) {
        *pending = None;
    }
    match pending.as_mut() {
        Some(close) => {
            if force_exit {
                close.force_exit = true;
            }
            close.clone()
        }
        None => {
            let close = PendingClose {
                id: uuid::Uuid::new_v4().to_string(),
                force_exit,
                issued_at: now,
                last_seen: None,
            };
            *pending = Some(close.clone());
            close
        }
    }
}

/// Consume the pending close request only when `request_id` matches and the token
/// has not expired. Unknown/stale tokens yield `None`; expired state is dropped.
pub(crate) fn take_matching_pending_close(
    pending: &mut Option<PendingClose>,
    request_id: &str,
) -> Option<PendingClose> {
    if pending.as_ref().is_some_and(PendingClose::is_expired) {
        *pending = None;
        return None;
    }
    if pending.as_ref().is_some_and(|close| close.id == request_id) {
        pending.take()
    } else {
        None
    }
}

const EDITOR_RENDERER_HEARTBEAT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub(crate) fn acknowledge_pending_close(pending: &mut Option<PendingClose>, request_id: &str, now: std::time::Instant) -> bool {
    if let Some(request) = pending.as_mut().filter(|request| request.id == request_id) {
        request.last_seen = Some(now);
        true
    } else { false }
}

fn renderer_close_stalled(pending: &Option<PendingClose>, request_id: &str, now: std::time::Instant) -> bool {
    pending.as_ref().is_some_and(|request| request.id == request_id &&
        now.saturating_duration_since(request.last_seen.unwrap_or(request.issued_at)) >= EDITOR_RENDERER_HEARTBEAT_TIMEOUT)
}

fn take_native_close(pending: &mut Option<PendingClose>, request_id: &str) -> Option<PendingClose> {
    // The native dialog is itself an explicit user approval; its token may be old,
    // but it may never consume a different, newer request.
    if pending.as_ref().is_some_and(|request| request.id == request_id) { pending.take() } else { None }
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
    /// 插件 HTTP 流式请求注册表（按 requestId 绑定插件/安装版本，可取消）。
    pub plugin_http: commands::PluginHttpRegistry,
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
    pub shutdown_complete: std::sync::atomic::AtomicBool,
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
    /// 关闭审批的待决请求：主窗确认保存/放弃前，原生关闭、托盘退出与 ExitRequested
    /// 共用同一个 token；只有带回匹配 requestId 的 complete/cancel 才能推进或清除它。
    pub pending_close: std::sync::Mutex<Option<PendingClose>>,
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
            plugin_http: commands::PluginHttpRegistry::new(),
            log_manager: std::sync::Arc::new(logger::LogManager::new()),
            diag_logger,
            system_info: std::sync::Arc::new(std::sync::Mutex::new(sysinfo::System::new())),
            serial_work: std::sync::Arc::new(commands::SerialWorkState::new()),
            tool_reservations: std::sync::Mutex::new(std::collections::HashMap::new()),
            tool_processes: std::sync::Mutex::new(std::collections::HashMap::new()),
            file_send_cancel: std::sync::Mutex::new(std::collections::HashMap::new()),
            shutdown_started: std::sync::atomic::AtomicBool::new(false),
            shutdown_complete: std::sync::atomic::AtomicBool::new(false),
            popouts: std::sync::Mutex::new(std::collections::HashMap::new()),
            pending_close: std::sync::Mutex::new(None),
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

/// Upper bound for the serial drain; a wedged port must not block exit forever.
const SHUTDOWN_SERIAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Upper bound for the blocking log/power/diagnostic finalizer.
const SHUTDOWN_FINALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Native escape remains available even when the WebView cannot run a timer,
/// render the approval UI, or acknowledge the initial close event.
fn watch_editor_close(app: tauri::AppHandle, request_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let stalled = {
                let state = app.state::<AppState>();
                if state.shutdown_started.load(std::sync::atomic::Ordering::Acquire) { return; }
                let Ok(pending) = state.pending_close.lock() else { return; };
                if !pending.as_ref().is_some_and(|request| request.id == request_id) { return; }
                renderer_close_stalled(&pending, &request_id, std::time::Instant::now())
            };
            if stalled { break; }
        }
        let Some(window) = app.get_webview_window("main") else { request_shutdown(app); return; };
        let chinese = app.state::<AppState>().config_manager.try_lock().ok()
            .is_some_and(|config| config.get_config().language == "zh-CN");
        let (message, exit, cancel) = if chinese {
            ("编辑器未响应关闭请求。是否退出？尚未保存的编辑可能丢失；下次启动会尽力恢复已记录的草稿。", "退出且不保存", "取消关闭")
        } else {
            ("The editor is not responding to the close request. Exit anyway? Unsaved edits may be lost; recorded drafts will be offered for recovery on the next launch.", "Exit without saving", "Cancel close")
        };
        let callback_app = app.clone();
        app.dialog().message(message).title("HyperCom").parent(&window)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(exit.into(), cancel.into()))
            .show(move |approved| {
                let consumed = {
                    let state = callback_app.state::<AppState>();
                    let consumed = state.pending_close.lock().ok().and_then(|mut pending| take_native_close(&mut pending, &request_id)).is_some();
                    consumed
                };
                if approved && consumed { request_shutdown(callback_app); }
            });
    });
}

/// Route every destructive exit through the main editor's save/discard guard.
///
/// Requests are token based: repeated native close requests reuse (or upgrade) the
/// pending token instead of stacking approvals, and the frontend must echo the same
/// id back through `complete_editor_close`/`cancel_editor_close`. Requests older than
/// `EDITOR_CLOSE_REQUEST_TIMEOUT` are lazily dropped before reuse.
fn request_editor_close(app: &tauri::AppHandle, force_exit: bool) {
    let Some(window) = app.get_webview_window("main") else {
        // Tray quit can arrive without a main window (for example after an
        // unexpected renderer teardown), so it cannot rely on a later
        // ExitRequested event to start the drain.
        log::warn!("Main window is unavailable; starting shutdown directly");
        request_shutdown(app.clone());
        return;
    };
    let (request, start_watchdog) = {
        let state = app.state::<AppState>();
        let mut pending = match state.pending_close.lock() {
            Ok(pending) => pending,
            Err(error) => {
                log::error!("Editor close request state is poisoned: {error}");
                return;
            }
        };
        let previous = pending.as_ref().map(|request| request.id.clone());
        let request = promote_pending_close(&mut pending, force_exit, std::time::Instant::now());
        let start_watchdog = previous.as_deref() != Some(request.id.as_str());
        (request, start_watchdog)
    };
    if start_watchdog { watch_editor_close(app.clone(), request.id.clone()); }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    if let Err(error) = app.emit_to(
        EventTarget::webview_window("main"),
        "editor:close-requested",
        EditorCloseRequested {
            request_id: request.id,
            force_exit: request.force_exit,
        },
    ) {
        log::error!("Could not request editor close approval: {error}");
    }
}

/// Hide and disable every managed WebView before any bounded shutdown drain.
///
/// This is intentionally synchronous: after approval the renderer must not remain
/// editable while serial/log/power finalizers can still take up to 15 seconds.
/// Errors are best effort because a window may disappear concurrently with exit.
fn lock_windows_for_shutdown(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if let Err(error) = window.set_enabled(false) {
            log::warn!("Could not disable window {label} during shutdown: {error}");
        }
        if let Err(error) = window.hide() {
            log::warn!("Could not hide window {label} during shutdown: {error}");
        }
    }
}

/// Start one asynchronous shutdown drain. The UI remains alive until serial
/// readers/work, RX log tails, power inhibitors, and diagnostic logs are finalized.
///
/// Every stage is bounded so a stuck serial reader, log sink or power inhibitor can
/// never leave a windowless process that refuses to exit.
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
    // Close approval has been consumed; freeze every renderer before any drain
    // work starts so no main/popout WebView can continue editing during shutdown.
    lock_windows_for_shutdown(&app);
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        match tokio::time::timeout(
            SHUTDOWN_SERIAL_TIMEOUT,
            commands::shutdown_serial_work(app.clone(), &state),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::error!("Serial shutdown failed: {error}"),
            Err(_) => log::error!(
                "Serial shutdown timed out after {SHUTDOWN_SERIAL_TIMEOUT:?}; continuing to exit"
            ),
        }
        let logs = std::sync::Arc::clone(&state.log_manager);
        let diag = std::sync::Arc::clone(&state.diag_logger);
        let finalize = tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = logs.close_all() {
                log::error!("Log shutdown failed: {error}");
            }
            if let Err(error) = system::shutdown_power_inhibitor() {
                log::error!("Power inhibitor shutdown failed: {error}");
            }
            if let Err(error) = diag.flush() {
                log::error!("Diagnostic log flush failed: {error}");
            }
        });
        match tokio::time::timeout(SHUTDOWN_FINALIZE_TIMEOUT, finalize).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::error!("Shutdown finalizer failed: {error}"),
            Err(_) => log::error!(
                "Shutdown finalizer timed out after {SHUTDOWN_FINALIZE_TIMEOUT:?}; forcing exit"
            ),
        }
        state.shutdown_complete.store(true, std::sync::atomic::Ordering::Release);
        app.exit(0);
    });
}

/// tao 0.35.2 handles Windows WM_ENDSESSION(TRUE) by dispatching LoopDestroyed;
/// tauri-runtime-wry 2.11.1 translates that directly to RunEvent::Exit, NOT
/// ExitRequested. At this point Windows may terminate us as soon as we return.
/// There is no reliable async editor approval left: recovery is recorded while
/// editing, and only bounded backend best-effort finalization is possible here.
const UNAVOIDABLE_EXIT_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

fn wait_for_exit_cleanup(done: std::sync::mpsc::Receiver<()>, budget: std::time::Duration) -> bool {
    done.recv_timeout(budget).is_ok()
}

fn cleanup_unavoidable_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.shutdown_complete.load(std::sync::atomic::Ordering::Acquire) { return; }
    state.shutdown_started.store(true, std::sync::atomic::Ordering::Release);
    let handle = app.clone();
    let (finished, done) = std::sync::mpsc::channel();
    // The event-loop/UI thread must never await a task that queues UI work. This
    // worker uses only backend serial/log/power APIs; the receiver enforces ONE
    // total wall-clock budget, including any poisoned/wedged mutex or finalizer.
    let spawned = std::thread::Builder::new().name("hypercom-exit-finalizer".into()).spawn(move || {
        tauri::async_runtime::block_on(async move {
            let state = handle.state::<AppState>();
            let deadline = tokio::time::Instant::now() + UNAVOIDABLE_EXIT_BUDGET;
            let _ = tokio::time::timeout(UNAVOIDABLE_EXIT_BUDGET / 2, commands::shutdown_serial_work(handle.clone(), &state)).await;
            let logs = state.log_manager.clone();
            let diag = state.diag_logger.clone();
            let finalizer = tauri::async_runtime::spawn_blocking(move || {
                logs.flush_all_best_effort();
                let _ = system::shutdown_power_inhibitor();
                let _ = logs.close_all();
                let _ = diag.flush();
            });
            let _ = tokio::time::timeout_at(deadline, finalizer).await;
            state.shutdown_complete.store(true, std::sync::atomic::Ordering::Release);
            let _ = finished.send(());
        });
    });
    if spawned.is_ok() { let _ = wait_for_exit_cleanup(done, UNAVOIDABLE_EXIT_BUDGET); }
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
            commands::complete_editor_close,
            commands::cancel_editor_close,
            commands::acknowledge_editor_close,
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
            commands::set_plugin_trusted_web,
            commands::clear_plugin_web_data,
            commands::read_plugin_asset,
            commands::write_plugin_asset,
            commands::reload_plugin,
            commands::plugin_http_open,
            commands::plugin_http_read,
            commands::plugin_http_cancel,
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
                    "tray.quit" => request_editor_close(app, true),
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

            // The frontend must approve save/discard before hiding or exiting.
            // Popout windows use their own close-requested editor guard.
            if label == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if !window.state::<AppState>().shutdown_started.load(
                        std::sync::atomic::Ordering::Acquire,
                    ) {
                        request_editor_close(window.app_handle(), false);
                    }
                }
                if let tauri::WindowEvent::Destroyed = event {
                    plugin::view_runtime::clear_all();
                    // A destroyed main window has no renderer left to answer the close
                    // approval; drain and exit instead of leaving a windowless process.
                    if !window.state::<AppState>().shutdown_started.load(
                        std::sync::atomic::Ordering::Acquire,
                    ) {
                        log::warn!("Main window destroyed without shutdown; starting shutdown");
                        request_shutdown(window.app_handle().clone());
                    }
                }
            }

            if label == "quick-send" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut popouts) = window.state::<AppState>().popouts.lock() {
                    popouts.remove(label);
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
                        // Target the main webview explicitly; the app-wide broadcast
                        // would leak the payload into every pop-out webview.
                        let _ = window.app_handle().emit_to(
                            EventTarget::webview_window("main"),
                            "popout:terminal:closed",
                            TerminalClosedPayload { port_id },
                        );
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(&event, tauri::RunEvent::Exit) {
                cleanup_unavoidable_exit(app);
                return;
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                if state
                    .shutdown_started
                    .load(std::sync::atomic::Ordering::Acquire)
                {
                    return;
                }
                // Keep the event loop alive so the shutdown drain below can finish
                // (an allowed exit would tear the process down before `app.exit`).
                api.prevent_exit();
                if app.get_webview_window("main").is_none() {
                    // No renderer left to ask for save/discard: drain and exit so a
                    // destroyed main window can never leave a windowless process.
                    log::warn!("Exit requested without a main window; starting shutdown");
                    request_shutdown(app.clone());
                } else {
                    request_editor_close(app, true);
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

    #[test]
    fn close_heartbeat_keeps_live_approval_valid_and_stalled_renderer_triggers_escape() {
        let now = std::time::Instant::now();
        let mut pending = None;
        let request = promote_pending_close(&mut pending, false, now);
        assert!(!renderer_close_stalled(&pending, &request.id, now + std::time::Duration::from_secs(14)));
        assert!(renderer_close_stalled(&pending, &request.id, now + EDITOR_RENDERER_HEARTBEAT_TIMEOUT));
        assert!(!acknowledge_pending_close(&mut pending, "unknown", now));
        assert!(acknowledge_pending_close(&mut pending, &request.id, now + std::time::Duration::from_secs(14)));
        assert!(!renderer_close_stalled(&pending, &request.id, now + std::time::Duration::from_secs(28)));
        assert!(renderer_close_stalled(&pending, &request.id, now + std::time::Duration::from_secs(29)));
        pending.as_mut().unwrap().issued_at = now.checked_sub(EDITOR_CLOSE_REQUEST_TIMEOUT * 2).unwrap();
        acknowledge_pending_close(&mut pending, &request.id, now);
        assert!(take_matching_pending_close(&mut pending, &request.id).is_some(), "active heartbeat must outlive an old issue time");
    }

    #[test]
    fn delayed_native_escape_never_consumes_a_newer_approval() {
        let now = std::time::Instant::now();
        let mut pending = None;
        let old = promote_pending_close(&mut pending, true, now);
        pending = None;
        let new = promote_pending_close(&mut pending, false, now);
        assert!(take_native_close(&mut pending, &old.id).is_none());
        assert_eq!(pending.as_ref().unwrap().id, new.id);
        assert!(!pending.as_ref().unwrap().force_exit);
        assert!(take_native_close(&mut pending, &new.id).is_some());
    }

    #[test]
    fn unavoidable_exit_wait_has_one_total_budget_and_accepts_completed_work() {
        let (_keep_sender_alive, receiver) = std::sync::mpsc::channel();
        assert!(!wait_for_exit_cleanup(receiver, std::time::Duration::ZERO));
        let (sender, receiver) = std::sync::mpsc::channel();
        sender.send(()).unwrap();
        assert!(wait_for_exit_cleanup(receiver, std::time::Duration::ZERO));
        let source = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs")).unwrap();
        let start = source.find("fn cleanup_unavoidable_exit(app:").unwrap();
        let end = source[start..].find("/// 终端弹出窗关闭事件载荷").unwrap() + start;
        let body = &source[start..end];
        assert!(body.contains("wait_for_exit_cleanup(done, UNAVOIDABLE_EXIT_BUDGET)"));
        assert!(!body.contains("run_on_main_thread"), "Exit finalizer must not wait for a dead UI loop");
        assert!(!body.contains("app.exit("), "unavoidable Exit cannot enqueue another exit request");
        assert!(source.contains("if matches!(&event, tauri::RunEvent::Exit)"));
        assert!(source.contains("cleanup_unavoidable_exit(app)"));
    }

    // ===== issue #19：关闭审批 token 状态机 =====

    #[test]
    fn pending_close_reuses_the_token_and_latches_forced_exit() {
        let mut pending = None;
        let now = std::time::Instant::now();
        let first = promote_pending_close(&mut pending, false, now);
        assert!(!first.force_exit);
        assert!(!first.id.is_empty());

        let repeated = promote_pending_close(&mut pending, false, now);
        assert_eq!(repeated.id, first.id, "repeat close must reuse the token");
        assert!(!repeated.force_exit);

        let upgraded = promote_pending_close(&mut pending, true, now);
        assert_eq!(upgraded.id, first.id, "forced exit upgrades in place");
        assert!(upgraded.force_exit);

        // A later non-forced request must not downgrade an in-flight forced exit.
        let still_forced = promote_pending_close(&mut pending, false, now);
        assert_eq!(still_forced.id, first.id);
        assert!(still_forced.force_exit);
    }

    #[test]
    fn pending_close_expires_and_unknown_tokens_are_rejected() {
        let now = std::time::Instant::now();
        let mut pending = None;
        let live = promote_pending_close(&mut pending, false, now);

        // Unknown id neither matches nor consumes the live request.
        assert!(take_matching_pending_close(&mut pending, "unknown").is_none());
        assert!(pending.is_some());
        // Matching id consumes it exactly once.
        let taken = take_matching_pending_close(&mut pending, &live.id).expect("live token");
        assert_eq!(taken.id, live.id);
        assert!(pending.is_none());
        assert!(take_matching_pending_close(&mut pending, &live.id).is_none());

        // Expired tokens are lazily dropped and never consumed.
        let stale_issued = now
            .checked_sub(EDITOR_CLOSE_REQUEST_TIMEOUT + std::time::Duration::from_millis(1))
            .expect("instant far enough in the past");
        pending = Some(PendingClose {
            id: "stale".to_string(),
            force_exit: true,
            issued_at: stale_issued,
            last_seen: None,
        });
        assert!(take_matching_pending_close(&mut pending, "stale").is_none());
        assert!(pending.is_none());

        // An expired request is replaced (new id) instead of being promoted.
        pending = Some(PendingClose {
            id: "stale".to_string(),
            force_exit: false,
            issued_at: stale_issued,
            last_seen: None,
        });
        let fresh = promote_pending_close(&mut pending, false, now);
        assert_ne!(fresh.id, "stale");
        assert!(!fresh.is_expired());
    }

    #[test]
    fn shutdown_freezes_windows_before_starting_the_drain() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
        )
        .unwrap();
        let shutdown = source
            .find("fn request_shutdown(app: tauri::AppHandle)")
            .expect("request_shutdown must remain source-visible");
        let body = &source[shutdown..];
        let freeze = body
            .find("lock_windows_for_shutdown(&app)")
            .expect("shutdown must freeze all windows");
        let spawn = body
            .find("tauri::async_runtime::spawn(async move")
            .expect("shutdown must remain asynchronous after freezing windows");
        assert!(freeze < spawn, "windows must be frozen before the drain spawn");
        assert!(source.contains("app.webview_windows()"));
        assert!(source.contains("window.set_enabled(false)"));
        assert!(source.contains("window.hide()"));
    }

    #[test]
    fn missing_main_close_request_starts_shutdown_directly() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
        )
        .unwrap();
        let start = source
            .find("fn request_editor_close(app: &tauri::AppHandle")
            .expect("request_editor_close must remain source-visible");
        let end = source
            .find("fn lock_windows_for_shutdown")
            .expect("shutdown helper must remain after close request");
        let body = &source[start..end];
        assert!(body.contains("request_shutdown(app.clone())"));
        assert!(!body.contains("Dropped editor close request"));
    }
}
