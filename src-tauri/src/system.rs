#[cfg(target_os = "windows")]
mod win32_power {
    use std::sync::mpsc;
    use std::sync::{Mutex, OnceLock};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "SetThreadExecutionState"]
        fn set_thread_execution_state(es_flags: u32) -> u32;
    }

    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

    /// 期望的 (prevent_sleep, prevent_screen_off) 状态。
    /// SetThreadExecutionState 每次调用都会整体替换线程执行状态，因此两个功能
    /// 必须合并成一组标志统一应用——否则后调用的那个会清掉先设置的标志，
    /// 导致防休眠与防息屏互相抵消（最后一次调用生效）。
    static DESIRED_STATE: Mutex<(bool, bool)> = Mutex::new((false, false));

    /// 专用电源管理线程的发送端。
    /// SetThreadExecutionState 是 **per-thread** 的：在 Tauri 命令线程池中，
    /// 每次调用可能落在不同线程上，导致 prevent_sleep(false) 清的是另一个线程
    /// 的状态，而原线程的 ES_SYSTEM_REQUIRED 永远残留、系统永不休眠。
    /// 解决方案：所有 SetThreadExecutionState 调用固定到一个专用线程，
    /// 命令线程仅通过 channel 发送期望状态。
    static POWER_TX: OnceLock<mpsc::Sender<(bool, bool)>> = OnceLock::new();

    /// 获取（或首次创建）专用电源线程的发送端。
    fn power_sender() -> &'static mpsc::Sender<(bool, bool)> {
        POWER_TX.get_or_init(|| {
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
        })
    }

    pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
        apply_state(|state| state.1 = enable)
    }

    pub fn prevent_sleep(enable: bool) -> Result<(), String> {
        apply_state(|state| state.0 = enable)
    }

    /// 更新期望状态的一半，再通过专用线程应用完整状态。
    fn apply_state(update: impl FnOnce(&mut (bool, bool))) -> Result<(), String> {
        let desired = {
            let mut guard = DESIRED_STATE
                .lock()
                .map_err(|e| format!("Failed to lock power state: {}", e))?;
            update(&mut guard);
            *guard
        };
        power_sender()
            .send(desired)
            .map_err(|e| format!("Power thread channel closed: {}", e))
    }
}

/// macOS power management via `caffeinate`.
///
/// Manages a single `caffeinate` child process whose flags reflect the combined
/// desired state (same pattern as Windows `DESIRED_STATE`). The process is
/// restarted whenever either half of the state changes.
///
/// Flags: `-d` = prevent display sleep, `-i` = prevent idle sleep,
/// `-s` = prevent system sleep (AC).
#[cfg(target_os = "macos")]
mod macos_power {
    use std::process::{Child, Command};
    use std::sync::Mutex;

    /// Desired `(prevent_sleep, prevent_screen_off)` state.
    static DESIRED_STATE: Mutex<(bool, bool)> = Mutex::new((false, false));

    /// Handle to the spawned `caffeinate` child process.
    static CAFFEINATE_CHILD: Mutex<Option<Child>> = Mutex::new(None);

    pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
        apply_state(|state| state.1 = enable)
    }

    pub fn prevent_sleep(enable: bool) -> Result<(), String> {
        apply_state(|state| state.0 = enable)
    }

    /// Update one half of the desired state, then restart `caffeinate` with
    /// flags matching the combined state.
    fn apply_state(update: impl FnOnce(&mut (bool, bool))) -> Result<(), String> {
        let desired = {
            let mut guard = DESIRED_STATE
                .lock()
                .map_err(|e| format!("Failed to lock power state: {}", e))?;
            update(&mut guard);
            *guard
        };
        restart_caffeinate(desired.0, desired.1)
    }

    /// Kill any running `caffeinate` and spawn a new one if either flag is set.
    fn restart_caffeinate(sleep: bool, screen: bool) -> Result<(), String> {
        let mut child_guard = CAFFEINATE_CHILD
            .lock()
            .map_err(|e| format!("Failed to lock caffeinate child: {}", e))?;

        // Kill existing process and reap it.
        if let Some(ref mut child) = *child_guard {
            let _ = child.kill();
            let _ = child.wait();
        }
        *child_guard = None;

        if !sleep && !screen {
            return Ok(());
        }

        let args = caffeinate_args(sleep, screen);

        match Command::new("caffeinate").args(&args).spawn() {
            Ok(child) => {
                *child_guard = Some(child);
                Ok(())
            }
            Err(e) => {
                log::warn!("Failed to spawn caffeinate: {}", e);
                Err(format!("Failed to spawn caffeinate: {}", e))
            }
        }
    }

    /// Build the `caffeinate` flag list from the desired state.
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
}

/// Linux power management via `systemd-inhibit`.
///
/// Spawns `systemd-inhibit --what=<what> --who=HyperCom --why=Serial-debug-session
/// --mode=block sleep infinity` as a child process. The inhibitor is released by
/// killing the child. On non-systemd systems the spawn fails gracefully
/// (`Ok(())` + `log::warn!`).
#[cfg(target_os = "linux")]
mod linux_power {
    use std::process::{Child, Command};
    use std::sync::Mutex;

    /// Desired `(prevent_sleep, prevent_screen_off)` state.
    static DESIRED_STATE: Mutex<(bool, bool)> = Mutex::new((false, false));

    /// Handle to the spawned `systemd-inhibit` child process.
    static INHIBIT_CHILD: Mutex<Option<Child>> = Mutex::new(None);

    pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
        apply_state(|state| state.1 = enable)
    }

    pub fn prevent_sleep(enable: bool) -> Result<(), String> {
        apply_state(|state| state.0 = enable)
    }

    /// Update one half of the desired state, then restart `systemd-inhibit`
    /// with the appropriate `--what` value.
    fn apply_state(update: impl FnOnce(&mut (bool, bool))) -> Result<(), String> {
        let desired = {
            let mut guard = DESIRED_STATE
                .lock()
                .map_err(|e| format!("Failed to lock power state: {}", e))?;
            update(&mut guard);
            *guard
        };
        restart_inhibit(desired.0, desired.1)
    }

    /// Kill any running inhibitor and spawn a new one if either flag is set.
    fn restart_inhibit(sleep: bool, screen: bool) -> Result<(), String> {
        let mut child_guard = INHIBIT_CHILD
            .lock()
            .map_err(|e| format!("Failed to lock inhibit child: {}", e))?;

        // Kill existing process and reap it.
        if let Some(ref mut child) = *child_guard {
            let _ = child.kill();
            let _ = child.wait();
        }
        *child_guard = None;

        if !sleep && !screen {
            return Ok(());
        }

        let what = inhibit_what(sleep, screen);

        match Command::new("systemd-inhibit")
            .args([
                format!("--what={}", what),
                "--who=HyperCom".to_string(),
                "--why=Serial-debug-session".to_string(),
                "--mode=block".to_string(),
                "sleep".to_string(),
                "infinity".to_string(),
            ])
            .spawn()
        {
            Ok(child) => {
                *child_guard = Some(child);
                Ok(())
            }
            Err(e) => {
                log::warn!(
                    "Failed to spawn systemd-inhibit (non-systemd system?): {}",
                    e
                );
                // Graceful fallback — don't error on non-systemd systems.
                Ok(())
            }
        }
    }

    /// Map desired state to the `systemd-inhibit --what` value.
    ///
    /// `idle` inhibits screen blanking; `sleep` inhibits suspend/hibernate.
    pub(crate) fn inhibit_what(sleep: bool, screen: bool) -> &'static str {
        match (sleep, screen) {
            (true, true) => "idle:sleep",
            (true, false) => "sleep",
            (false, true) => "idle",
            (false, false) => "",
        }
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
    win32_power::prevent_screen_off(enable)
}

#[cfg(target_os = "macos")]
pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
    macos_power::prevent_screen_off(enable)
}

#[cfg(target_os = "linux")]
pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
    linux_power::prevent_screen_off(enable)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn prevent_screen_off(_enable: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn prevent_sleep(enable: bool) -> Result<(), String> {
    win32_power::prevent_sleep(enable)
}

#[cfg(target_os = "macos")]
pub fn prevent_sleep(enable: bool) -> Result<(), String> {
    macos_power::prevent_sleep(enable)
}

#[cfg(target_os = "linux")]
pub fn prevent_sleep(enable: bool) -> Result<(), String> {
    linux_power::prevent_sleep(enable)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn prevent_sleep(_enable: bool) -> Result<(), String> {
    Ok(())
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
        use crate::system::macos_power;

        #[test]
        fn caffeinate_args_screen_only() {
            assert_eq!(macos_power::caffeinate_args(false, true), vec!["-d"]);
        }

        #[test]
        fn caffeinate_args_sleep_only() {
            assert_eq!(macos_power::caffeinate_args(true, false), vec!["-i", "-s"]);
        }

        #[test]
        fn caffeinate_args_both() {
            assert_eq!(
                macos_power::caffeinate_args(true, true),
                vec!["-d", "-i", "-s"]
            );
        }

        #[test]
        fn caffeinate_args_neither() {
            assert!(macos_power::caffeinate_args(false, false).is_empty());
        }
    }

    #[cfg(target_os = "linux")]
    mod linux_tests {
        use crate::system::linux_power;

        #[test]
        fn inhibit_what_screen_only() {
            assert_eq!(linux_power::inhibit_what(false, true), "idle");
        }

        #[test]
        fn inhibit_what_sleep_only() {
            assert_eq!(linux_power::inhibit_what(true, false), "sleep");
        }

        #[test]
        fn inhibit_what_both() {
            assert_eq!(linux_power::inhibit_what(true, true), "idle:sleep");
        }

        #[test]
        fn inhibit_what_neither() {
            assert_eq!(linux_power::inhibit_what(false, false), "");
        }
    }
}
