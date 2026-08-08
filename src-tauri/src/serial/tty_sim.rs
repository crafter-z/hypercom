//! 模拟终端（git bash pty，仅调试构建，issue #11）。
//! 用 portable-pty（Windows = ConPTY）spawn 本地 git bash，作为「虚拟串口」：
//! pty stdout → serial:data（RX）；send_serial_data → pty stdin（TX）。
//!
//! 为什么用 pty 而不是普通管道：仅 `std::process` 管道会让 bash 进入**非交互
//! 模式**（无提示符、无 readline 行编辑、不自动上色、不能跑 vim），验证不了
//! TTY 前端（xterm.js）的交互式渲染。ConPTY 是 Windows Terminal / VS Code
//! 跑 bash 的方式，portable-pty 是 wezterm/alacritty 同款封装。
//!
//! 门控方式与 SIM:Loopback 完全一致：命令层 `cfg(not(debug_assertions))` 报错 +
//! 前端 `import.meta.env.DEV` 隐藏 UI，双层门控；本模块本身不 gate（release
//! 编译但不暴露入口，命令层已拒绝）。

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::Emitter;

/// 模拟终端（git bash pty）端口句柄。
///
/// 与真实串口 `SerialPortHandle` 的读写拆分同构：pty master 的 writer 供
/// TX 独占（`take_writer()` 只能调用一次，必须在此处取好存起来）；master
/// 自身另存一份供 `resize()` 使用（resize 方法在 MasterPty 上，writer 上没有）。
/// 读线程持有 reader（`try_clone_reader()` 的克隆），独占 master 的读端。
pub struct TtySimPortHandle {
    /// 读线程运行标志（false 时线程在下一次循环退出）
    pub running: Arc<AtomicBool>,
    /// 写句柄（pty master 的 writer，TX 路径独占；锁内 write）
    pub writer: Option<Arc<Mutex<Box<dyn std::io::Write + Send>>>>,
    /// pty master 自身（writer 已 take 走，master 只用 resize；锁内 resize）
    pub master: Option<Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>>,
    /// bash 子进程（kill 时 drop 并终止）
    pub child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    /// 读线程（pty stdout → serial:data，退出时发 disconnected）
    pub read_thread: Option<thread::JoinHandle<()>>,
}

impl TtySimPortHandle {
    /// 向 pty stdin 写入字节（TX）。锁 writer 后循环 write，处理 Interrupted。
    pub fn write(&self, bytes: &[u8]) -> anyhow::Result<usize> {
        let writer = self
            .writer
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("TTY sim port not open"))?;
        let mut w = writer
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        let mut written = 0usize;
        while written < bytes.len() {
            match w.write(&bytes[written..]) {
                Ok(0) => return Err(anyhow::anyhow!("TTY sim write returned 0 bytes")),
                Ok(n) => written += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(anyhow::anyhow!("TTY sim write error: {}", e)),
            }
        }
        Ok(written)
    }

    /// 调整 pty 尺寸（全屏应用 vim/top 需要正确 cols/rows 才会触发对端重绘）。
    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        let master = self
            .master
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("TTY sim port not open"))?;
        let m = master
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        m.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    }

    /// 终止 bash 子进程（child 被 drop，pty 关闭 → 读线程读到 EOF 退出）。
    pub fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            if let Err(e) = child.kill() {
                log::warn!("Failed to kill TTY sim child: {}", e);
            }
        }
    }
}

/// 定位 git bash 可执行文件。
///
/// 依次检查：PATH 上的 `bash`/`bash.exe`，再查常见 Git for Windows 安装路径。
/// 返回第一个 `Path::new(p).exists()` 的路径；找不到返回 None。
pub(crate) fn find_bash() -> Option<std::path::PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for name in ["bash.exe", "bash"] {
                let p = dir.join(name);
                if std::path::Path::new(&p).exists() {
                    return Some(p);
                }
            }
        }
    }
    const CANDIDATES: [&str; 4] = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
    ];
    for c in CANDIDATES {
        let p = std::path::PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// spawn 一个本地 git bash，跑在 pty 上，作为「虚拟串口」。
/// 返回的句柄持有：writer（TX）、master（resize）、child（kill）、读线程。
/// `cols`/`rows` 是前端 xterm 的当前尺寸（issue #11）：pty 以正确尺寸初始化，
/// 全屏应用（vim/top）才按真实显示尺寸渲染。
pub(crate) fn spawn_bash(
    app_handle: &tauri::AppHandle,
    port_id: &str,
    cols: u16,
    rows: u16,
) -> anyhow::Result<TtySimPortHandle> {
    let bash = find_bash()
        .ok_or_else(|| anyhow::anyhow!("git bash not found — install Git for Windows"))?;
    let pty_system = portable_pty::native_pty_system();
    // 防御：上游传入非法尺寸（0/NaN 序列化失败等）时回退 80×24，避免 ConPTY 异常。
    let cols = if cols > 0 { cols } else { 80 };
    let rows = if rows > 0 { rows } else { 24 };
    let pair = pty_system.openpty(portable_pty::PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let cmd = portable_pty::CommandBuilder::new(bash);
    let child = pair.slave.spawn_command(cmd)?;

    // take_writer 只能调用一次：先 clone reader（读线程用），再 take writer（TX 用），
    // master 本身保留给 resize。
    let master = pair.master;
    let mut reader = master.try_clone_reader()?;
    let writer = master.take_writer()?;

    let master_arc = Arc::new(Mutex::new(master));
    let writer_arc = Arc::new(Mutex::new(writer));

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = Arc::clone(&running);
    let thread_port_id = port_id.to_string();
    let app_handle_clone = app_handle.clone();

    let read_thread = thread::spawn(move || {
        let port_id = thread_port_id;
        let mut buf = [0u8; 4096];
        loop {
            if !running_clone.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF（bash 退出 / pty 关闭）
                Ok(n) => {
                    crate::serial::emit_data_event(&app_handle_clone, &port_id, "RX", &buf[..n], false);
                }
                // 超时是正常现象（pty 无数据可读），继续等待；其它错误退出。
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(e) => {
                    log::warn!("TTY sim read error on {}: {}", port_id, e);
                    break;
                }
            }
        }

        // 读取线程退出时发送断开事件（前端依赖此事件，与真实/模拟串口线程对齐）
        let _ = app_handle_clone.emit(
            "serial:status",
            crate::serial::SerialStatusEvent {
                port_id: port_id.clone(),
                status: "disconnected".to_string(),
            },
        );
    });

    Ok(TtySimPortHandle {
        running,
        writer: Some(writer_arc),
        master: Some(master_arc),
        child: Some(child),
        read_thread: Some(read_thread),
    })
}

#[cfg(test)]
mod tests {
    // 显式导入而非 `use super::*`：与 serial/mod.rs 测试约定一致，避免把
    // portable-pty FFI 拉进 *测试* 二进制。构造空句柄（None 字段）不触碰 FFI，
    // 因此这些错误路径测试在 Windows 上也能运行。
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    use super::TtySimPortHandle;

    fn empty_handle() -> TtySimPortHandle {
        TtySimPortHandle {
            running: Arc::new(AtomicBool::new(true)),
            writer: None,
            master: None,
            child: None,
            read_thread: None,
        }
    }

    #[test]
    fn find_bash_does_not_panic() {
        // 环境相关：装了 Git for Windows 返回 Some，否则 None；两种都应正常返回。
        let _ = super::find_bash();
    }

    #[test]
    fn tty_sim_write_errors_without_writer() {
        let handle = empty_handle();
        let err = handle.write(b"x").unwrap_err().to_string();
        assert!(err.contains("not open"), "{err}");
    }

    #[test]
    fn tty_sim_resize_errors_without_master() {
        let handle = empty_handle();
        assert!(handle.resize(80, 24).is_err());
    }
}