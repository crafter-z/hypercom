#[cfg(target_os = "windows")]
mod win32_power {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "SetThreadExecutionState"]
        fn set_thread_execution_state(es_flags: u32) -> u32;
    }

    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

    pub fn prevent_screen_off(enable: bool) -> Result<(), String> {
        let flags = if enable {
            ES_CONTINUOUS | ES_DISPLAY_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        set_thread_execution_state_checked(flags)
    }

    pub fn prevent_sleep(enable: bool) -> Result<(), String> {
        let flags = if enable {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
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
