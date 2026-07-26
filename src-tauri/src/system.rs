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

#[cfg(target_os = "windows")]
pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
    win32_power::prevent_screen_off(enable)
}

#[cfg(not(target_os = "windows"))]
pub fn prevent_screen_off(_enable: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn prevent_sleep(enable: bool) -> Result<(), String> {
    win32_power::prevent_sleep(enable)
}

#[cfg(not(target_os = "windows"))]
pub fn prevent_sleep(_enable: bool) -> Result<(), String> {
    Ok(())
}
