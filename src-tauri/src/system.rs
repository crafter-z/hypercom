//! 电源管理（防息屏 / 防休眠）平台适配。
//!
//! 期望状态是 `(prevent_sleep, prevent_screen_off)` 这一对标志，两半都必须
//! **合并应用**：三个平台的底层 API 都按「整体状态」语义生效（Windows
//! `SetThreadExecutionState` 每次调用替换线程执行状态；`caffeinate` /
//! `systemd-inhibit` 的参数描述完整的抑制集合）。若把两半分别应用，后调用的
//! 那个会清掉先设置的标志，防休眠与防息屏互相抵消（最后一次调用生效）。
//!
//! 因此状态机（期望状态 + 半更新 + 整体应用）只有一份，放在本文件顶层；平台
//! 差异被收进后端模块，只负责「把完整状态交给操作系统」：
//!   - `win32_backend`：专用线程调用 `SetThreadExecutionState`；
//!   - `child_process_backend`：重启持有抑制的子进程（macOS / Linux）。

use std::sync::Mutex;

/// 期望的 `(prevent_sleep, prevent_screen_off)` 状态。
static DESIRED_STATE: Mutex<(bool, bool)> = Mutex::new((false, false));

/// 开关防息屏。
pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
    apply_state(|state| state.1 = enable)
}

/// 开关防休眠。
pub fn prevent_sleep(enable: bool) -> Result<(), String> {
    apply_state(|state| state.0 = enable)
}

/// 更新期望状态的一半，再把**完整**状态交给当前平台后端应用。
fn apply_state(update: impl FnOnce(&mut (bool, bool))) -> Result<(), String> {
    let desired = {
        let mut guard = DESIRED_STATE
            .lock()
            .map_err(|e| format!("Failed to lock power state: {}", e))?;
        update(&mut guard);
        *guard
    };

    #[cfg(target_os = "windows")]
    {
        win32_backend::apply(desired.0, desired.1)
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        child_process_backend::apply(desired.0, desired.1)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        // 其它平台没有电源管理 API：返回 Ok 让前端开关流程不因环境报错。
        let _ = desired;
        Ok(())
    }
}

/// Windows 后端：`SetThreadExecutionState`。
#[cfg(target_os = "windows")]
mod win32_backend {
    use std::sync::mpsc;
    use std::sync::LazyLock;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "SetThreadExecutionState"]
        fn set_thread_execution_state(es_flags: u32) -> u32;
    }

    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

    /// 专用电源管理线程的发送端。
    /// `SetThreadExecutionState` 是 **per-thread** 的：在 Tauri 命令线程池中，
    /// 每次调用可能落在不同线程上，导致 prevent_sleep(false) 清的是另一个线程
    /// 的状态，而原线程的 ES_SYSTEM_REQUIRED 永远残留、系统永不休眠。
    /// 解决方案：所有 `SetThreadExecutionState` 调用固定到一个专用线程，
    /// 命令线程仅通过 channel 发送期望状态。
    static POWER_TX: LazyLock<mpsc::Sender<(bool, bool)>> = LazyLock::new(|| {
        let (tx, rx) = mpsc::channel::<(bool, bool)>();
        std::thread::Builder::new()
            .name("hypercom-power".into())
            .spawn(move || {
                // 循环接收期望状态，在同一线程上调用 SetThreadExecutionState。
                // channel 断开（所有 Sender drop）时线程自然退出。
                while let Ok((sleep, screen)) = rx.recv() {
                    let flags = ES_CONTINUOUS
                        | (if sleep { ES_SYSTEM_REQUIRED } else { 0 })
                        | (if screen { ES_DISPLAY_REQUIRED } else { 0 });
                    // SAFETY: [Category 8 — FFI Boundary UB]
                    // The call passes a plain u32 bitmask documented by Win32; no Rust
                    // references, pointers, or ownership cross the FFI boundary, and the
                    // extern signature uses the documented system ABI and return type.
                    let prev = unsafe { set_thread_execution_state(flags) };
                    if prev == 0 {
                        log::warn!(
                            "SetThreadExecutionState failed: {}",
                            std::io::Error::last_os_error()
                        );
                    }
                }
                // 线程退出前清除状态（所有 Sender 已 drop = 应用关闭）
                unsafe { set_thread_execution_state(ES_CONTINUOUS) };
            })
            .expect("failed to spawn power management thread");
        tx
    });

    /// 把完整期望状态交给专用电源线程。
    pub(super) fn apply(sleep: bool, screen: bool) -> Result<(), String> {
        POWER_TX
            .send((sleep, screen))
            .map_err(|e| format!("Power thread channel closed: {}", e))
    }
}

/// macOS / Linux 后端：由一个子进程持有抑制（kill 即释放）。
///
/// 两平台语义相同——期望状态变化时 kill 旧子进程、按新状态 spawn 新子进程，
/// 无抑制时只 kill；状态机与注册表因此只有一份。差异仅 `spawn_inhibitor`
/// 一处（启动命令 + spawn 失败是否算错误），见该函数。
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod child_process_backend {
    use std::process::{Child, Command};
    use std::sync::Mutex;

    /// 当前持有的抑制子进程；`None` = 无抑制。
    static INHIBIT_CHILD: Mutex<Option<Child>> = Mutex::new(None);

    /// 把完整期望状态落到子进程上。
    pub(super) fn apply(sleep: bool, screen: bool) -> Result<(), String> {
        let mut child_guard = INHIBIT_CHILD
            .lock()
            .map_err(|e| format!("Failed to lock power inhibitor: {}", e))?;

        // 先释放旧抑制（kill + wait，不留僵尸进程），再按新状态决定是否重建。
        if let Some(child) = child_guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *child_guard = None;

        if !sleep && !screen {
            return Ok(());
        }

        *child_guard = spawn_inhibitor(sleep, screen)?;
        Ok(())
    }

    /// 启动持有抑制的子进程；`Ok(None)` = 本平台无法抑制，降级为无抑制。
    #[cfg(target_os = "macos")]
    fn spawn_inhibitor(sleep: bool, screen: bool) -> Result<Option<Child>, String> {
        let mut cmd = Command::new("caffeinate");
        cmd.args(caffeinate_args(sleep, screen));
        // caffeinate 是 macOS 自带工具，spawn 失败说明环境异常（不是「系统不支持」），
        // 上报给前端而不是静默无抑制。
        cmd.spawn().map(Some).map_err(|e| {
            log::warn!("Failed to spawn caffeinate: {}", e);
            format!("Failed to spawn caffeinate: {}", e)
        })
    }

    /// 启动持有抑制的子进程；`Ok(None)` = 本平台无法抑制，降级为无抑制。
    #[cfg(target_os = "linux")]
    fn spawn_inhibitor(sleep: bool, screen: bool) -> Result<Option<Child>, String> {
        let what = inhibit_what(sleep, screen);
        let mut cmd = Command::new("systemd-inhibit");
        cmd.args([
            format!("--what={}", what),
            "--who=HyperCom".to_string(),
            "--why=Serial-debug-session".to_string(),
            "--mode=block".to_string(),
            "sleep".to_string(),
            "infinity".to_string(),
        ]);
        // 非 systemd 系统（容器、Alpine 等）没有 systemd-inhibit：属预期情况，
        // 降级为「无抑制」而不是让前端开关报错。
        match cmd.spawn() {
            Ok(child) => Ok(Some(child)),
            Err(e) => {
                log::warn!("Failed to spawn systemd-inhibit (non-systemd system?): {}", e);
                Ok(None)
            }
        }
    }

    /// 由期望状态生成 `caffeinate` 参数。
    /// `-d` = 防息屏，`-i` = 防空闲休眠，`-s` = 防系统休眠（AC）。
    #[cfg(target_os = "macos")]
    pub(crate) fn caffeinate_args(sleep: bool, screen: bool) -> Vec<&'static str> {
        let mut args = Vec::new();
        if screen {
            args.push("-d");
        }
        if sleep {
            args.push("-i");
            args.push("-s");
        }
        args
    }

    /// 由期望状态生成 `systemd-inhibit --what` 值。
    /// `idle` 抑制息屏，`sleep` 抑制挂起/休眠。
    #[cfg(target_os = "linux")]
    pub(crate) fn inhibit_what(sleep: bool, screen: bool) -> &'static str {
        match (sleep, screen) {
            (true, true) => "idle:sleep",
            (true, false) => "sleep",
            (false, true) => "idle",
            (false, false) => "",
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prevent_screen_off_roundtrip() {
        assert!(prevent_screen_off(true).is_ok());
        assert!(prevent_screen_off(false).is_ok());
    }

    #[test]
    fn prevent_sleep_roundtrip() {
        assert!(prevent_sleep(true).is_ok());
        assert!(prevent_sleep(false).is_ok());
    }

    #[cfg(target_os = "macos")]
    mod macos_tests {
        use crate::system::child_process_backend;

        #[test]
        fn caffeinate_args_screen_only() {
            assert_eq!(child_process_backend::caffeinate_args(false, true), vec!["-d"]);
        }

        #[test]
        fn caffeinate_args_sleep_only() {
            assert_eq!(
                child_process_backend::caffeinate_args(true, false),
                vec!["-i", "-s"]
            );
        }

        #[test]
        fn caffeinate_args_both() {
            assert_eq!(
                child_process_backend::caffeinate_args(true, true),
                vec!["-d", "-i", "-s"]
            );
        }

        #[test]
        fn caffeinate_args_neither() {
            assert!(child_process_backend::caffeinate_args(false, false).is_empty());
        }
    }

    #[cfg(target_os = "linux")]
    mod linux_tests {
        use crate::system::child_process_backend;

        #[test]
        fn inhibit_what_screen_only() {
            assert_eq!(child_process_backend::inhibit_what(false, true), "idle");
        }

        #[test]
        fn inhibit_what_sleep_only() {
            assert_eq!(child_process_backend::inhibit_what(true, false), "sleep");
        }

        #[test]
        fn inhibit_what_both() {
            assert_eq!(child_process_backend::inhibit_what(true, true), "idle:sleep");
        }

        #[test]
        fn inhibit_what_neither() {
            assert_eq!(child_process_backend::inhibit_what(false, false), "");
        }
    }
}
