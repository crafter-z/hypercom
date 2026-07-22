#[cfg(target_os = "windows")]
mod win32_power {
    use std::sync::Mutex;

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

    pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
        apply_state(|state| state.1 = enable)
    }

    pub fn prevent_sleep(enable: bool) -> Result<(), String> {
        apply_state(|state| state.0 = enable)
    }

    /// 更新期望状态的一半，再按完整状态合并标志调用 Win32 API。
    fn apply_state(update: impl FnOnce(&mut (bool, bool))) -> Result<(), String> {
        let flags = {
            let mut desired = DESIRED_STATE
                .lock()
                .map_err(|e| format!("Failed to lock power state: {}", e))?;
            update(&mut desired);
            let (sleep, screen) = *desired;
            ES_CONTINUOUS
                | (if sleep { ES_SYSTEM_REQUIRED } else { 0 })
                | (if screen { ES_DISPLAY_REQUIRED } else { 0 })
        };
        set_thread_execution_state_checked(flags)
    }

    fn set_thread_execution_state_checked(flags: u32) -> Result<(), String> {
        // SAFETY: [Category 8 — FFI Boundary UB]
        // The call passes a plain u32 bitmask documented by Win32; no Rust references,
        // pointers, or ownership cross the FFI boundary, and the extern signature uses
        // the documented system ABI and return type for SetThreadExecutionState.
        let previous_state = unsafe { set_thread_execution_state(flags) };
        if previous_state == 0 {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(())
        }
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
