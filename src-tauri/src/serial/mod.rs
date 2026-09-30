/**
 * 串口管理模块 (Serial Manager)
 * 负责串口的枚举、打开/关闭、参数配置、数据收发（serialport-rs，跨平台）。
 *
 * 结构（本文件只保留「注册表 + 策略」，每类端口的 I/O 各在自己的模块里）：
 * - `codec`      ：HEX 解析 / TX 字节构造 / 带期限写入（纯逻辑，不碰 serialport）
 * - `events`     ：前端事件载荷与派发助手
 * - `ports_real` ：真实串口（句柄拆分、帧格式映射、热插拔幽灵句柄回收）
 * - `ports_sim`  ：模拟串口 SIM:Loopback（回显 + 周期输出）
 * - `ports_tty`  ：模拟终端 GIT:BASH（pty 包装；pty 细节在 `tty_sim`）
 *
 * 全局串口锁的纪律：`SerialManager` 的每个方法在**持有全局锁**时执行，因此它们
 * 只做注册表操作与（打开/发送时的）单次系统调用，绝不做端口枚举与读线程 join。
 * 需要这两者的完整流程见 `ports_real::open_blocking` / `reconnect_blocking` /
 * `list_ports_blocking`：它们自持自放全局锁，把阻塞 IO 放在锁外的锁段之间。
 */
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::OpenPortArgs;

pub(crate) mod codec;
pub(crate) mod events;
mod ports_real;
mod ports_sim;
mod ports_tty;
pub(crate) mod tty_sim;

pub use codec::{build_tx_bytes, write_all_with_deadline, TxOutcome, WRITE_TOTAL_DEADLINE};
pub(crate) use events::{emit_reconnect_hint, emit_rx_event, emit_status, PortStatus};
pub use ports_real::{open_blocking, reconnect_blocking};

/// 模拟串口 id 前缀（`PortKind` 的判定依据）
pub(crate) const SIM_PORT_PREFIX: &str = "SIM:";
/// 模拟终端（git bash pty）id 前缀（`PortKind` 的判定依据）
pub(crate) const TTY_PORT_PREFIX: &str = "GIT:";

/// 串口信息（返回给前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub id: String,
    pub name: String,
    pub port_type: String, // "real" | "sim"
    /// USB 厂商名（仅 USB 串口有值；PCI/蓝牙/模拟口为空，序列化时省略）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    /// USB 产品名（仅 USB 串口有值；PCI/蓝牙/模拟口为空，序列化时省略）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
}

/// 端口类别：由 port_id 前缀决定（`GIT:` → Tty，`SIM:` → Sim，其余 → Real）。
///
/// 用户可见的 port_id 前缀是类别的唯一来源。历史上这三类在 8 处分派点各写一遍
/// `starts_with`，漏改任何一处就会把虚拟端口当真实串口打开——在 release 构建下
/// 等于绕过能力门控去 spawn 进程。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortKind {
    Real,
    Sim,
    Tty,
}

impl PortKind {
    /// 由 port_id 判定类别（前缀必须从头匹配，`XSIM:x` 属于真实端口）。
    pub fn of(port_id: &str) -> Self {
        if port_id.starts_with(TTY_PORT_PREFIX) {
            PortKind::Tty
        } else if port_id.starts_with(SIM_PORT_PREFIX) {
            PortKind::Sim
        } else {
            PortKind::Real
        }
    }
}

/// 虚拟端口的能力门控：开关未启用时打开必须报错。
///
/// 这是「release 构建下 `open_serial_port {portId:'GIT:BASH'}` 不会 spawn 任何
/// 进程」的唯一保证——命令层的 open 命令不区分端口类别，release 下
/// `enable_simulation` / `enable_gitbash_sim` 又直接报错，两个开关恒为 false。
/// 纯函数（不含状态），门控表在所有平台都可测试。
fn check_virtual_enabled(
    kind: PortKind,
    simulate: bool,
    gitbash_sim: bool,
) -> anyhow::Result<()> {
    match kind {
        PortKind::Real => Ok(()),
        PortKind::Sim if simulate => Ok(()),
        PortKind::Sim => Err(anyhow::anyhow!(
            "Simulation mode is not enabled (port ids must start with {})",
            SIM_PORT_PREFIX
        )),
        PortKind::Tty if gitbash_sim => Ok(()),
        PortKind::Tty => Err(anyhow::anyhow!(
            "Git Bash simulation is not enabled (port ids must start with {})",
            TTY_PORT_PREFIX
        )),
    }
}

/// 全局串口锁中毒（持锁线程 panic）时的统一错误文案。
pub(super) fn lock_error<T>(e: PoisonError<T>) -> anyhow::Error {
    anyhow::anyhow!("Lock error: {}", e)
}

/// 串口管理器：三类端口的注册表 + 能力开关 + 上次连接参数。
///
/// 句柄类型与读写拆分见 `ports_real::SerialPortHandle`、`ports_sim::SimPortHandle`、
/// `tty_sim::TtySimPortHandle`。
pub struct SerialManager {
    /// 真实串口句柄
    ports: HashMap<String, ports_real::SerialPortHandle>,
    /// 模拟串口句柄。`pub`：`commands::simulation` 需要遍历 key 批量关闭。
    pub sim_ports: HashMap<String, ports_sim::SimPortHandle>,
    /// 模拟终端（git bash pty）句柄。`pub`：`commands::tty_sim` 需要遍历 key 批量关闭。
    pub tty_sim_ports: HashMap<String, tty_sim::TtySimPortHandle>,
    /// 是否启用模拟模式（SIM:Loopback）
    simulate: bool,
    /// 是否启用模拟终端（git bash pty）
    pub gitbash_sim: bool,
    /// Tauri AppHandle：事件推送与日志落盘的唯一入口
    app_handle: Option<AppHandle>,
    /// 上次成功连接的参数，用于自动重连
    last_params: HashMap<String, OpenPortArgs>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            ports: HashMap::new(),
            sim_ports: HashMap::new(),
            tty_sim_ports: HashMap::new(),
            simulate: false,
            gitbash_sim: false,
            app_handle: None,
            last_params: HashMap::new(),
        }
    }

    /// 设置 AppHandle（在 Tauri setup 钩子中调用）
    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    /// 启用/禁用模拟模式
    pub fn set_simulate(&mut self, on: bool) {
        self.simulate = on;
    }

    /// 启用/禁用模拟终端（git bash pty）。
    /// 仅 debug 构建可用——命令层（commands/tty_sim.rs）已在 release 拒绝。
    pub fn set_gitbash_sim(&mut self, on: bool) {
        self.gitbash_sim = on;
    }

    /// 打开串口（按 `PortKind` 分派；虚拟端口先过能力门控）。
    ///
    /// 锁内执行：不枚举端口、不 join 读线程（两者都是阻塞操作）。需要这两种操作的
    /// 完整打开流程见 `open_blocking`。
    pub fn open_port(&mut self, args: OpenPortArgs) -> anyhow::Result<()> {
        let kind = PortKind::of(&args.port_id);
        check_virtual_enabled(kind, self.simulate, self.gitbash_sim)?;
        match kind {
            PortKind::Real => ports_real::open(self, args),
            PortKind::Sim => ports_sim::open(self, args),
            PortKind::Tty => ports_tty::open(self, args),
        }
    }

    /// 关闭串口（真实/模拟/模拟终端）。
    ///
    /// 锁内只停止读取线程并取出 JoinHandle；调用方必须在释放全局锁之后再 join
    /// （真实串口读线程最长约 100ms 退出，模拟终端的 pty 读线程要等 ConPTY 关闭，
    /// 持锁 join 会卡住所有其他串口命令）。
    pub fn close_port(&mut self, port_id: &str) -> anyhow::Result<Option<thread::JoinHandle<()>>> {
        Ok(match PortKind::of(port_id) {
            PortKind::Real => ports_real::close(self, port_id),
            PortKind::Sim => ports_sim::close(self, port_id),
            PortKind::Tty => ports_tty::close(self, port_id),
        })
    }

    /// 向串口发送数据，返回**实际送达端口**的字节。
    ///
    /// 返回值 `TxOutcome` 是 TX 日志与前端字节数的唯一来源：TTY 的行结束符归一、
    /// SIM 频率命令被吞、行结束符追加都只发生一次，日志不再按入参重算（否则
    /// 会出现「日志记 7 字节、线上 6 字节」这类不一致）。
    ///
    /// 注意：本方法在**调用方持有的全局锁**内执行真实写。`commands/serial.rs` 的
    /// `send_serial_data` 对真实串口改用 `get_write_handle` + `write_all_with_deadline`
    /// 的两段式（锁内取句柄 → 锁外写），以免慢发送拖死端口轮询与其它端口命令。
    pub fn send_data(
        &self,
        port_id: &str,
        data: &str,
        is_hex: bool,
        append_line_ending: &str,
    ) -> anyhow::Result<TxOutcome> {
        match PortKind::of(port_id) {
            PortKind::Real => ports_real::send(self, port_id, data, is_hex, append_line_ending),
            PortKind::Sim => ports_sim::send(self, port_id, data, is_hex, append_line_ending),
            PortKind::Tty => ports_tty::send(self, port_id, data, is_hex, append_line_ending),
        }
    }

    /// 向串口写入原始字节（不做 HEX 解析、不附加行结束符）。用于文件发送。
    /// 真实串口路径与 `send_data` 同款：只用写句柄 + 去 flush + 总写入期限。
    pub fn write_raw(&self, port_id: &str, bytes: &[u8]) -> anyhow::Result<usize> {
        match PortKind::of(port_id) {
            PortKind::Real => ports_real::write_raw(self, port_id, bytes),
            PortKind::Sim => ports_sim::write_raw(self, port_id, bytes),
            PortKind::Tty => ports_tty::write_raw(self, port_id, bytes),
        }
    }

    /// 取指定端口的**写句柄**克隆（两段式发送的第一段）。
    ///
    /// 必须在持有全局锁时调用；返回后调用方应**立即释放全局锁**，再只持 per-port
    /// 写锁完成 `write_all_with_deadline`。
    pub fn get_write_handle(
        &self,
        port_id: &str,
    ) -> anyhow::Result<Arc<Mutex<Box<dyn serialport::SerialPort>>>> {
        ports_real::write_handle(self, port_id)
    }

    /// 修改串口参数（完整）
    pub fn set_params(
        &mut self,
        port_id: &str,
        baud_rate: u32,
        data_bits: u8,
        parity: &str,
        stop_bits: &str,
        handshake: &str,
    ) -> anyhow::Result<()> {
        ports_real::set_params(
            self, port_id, baud_rate, data_bits, parity, stop_bits, handshake,
        )
    }

    /// 设置流控（DTR/RTS）
    pub fn set_flow_control(&self, port_id: &str, dtr: bool, rts: bool) -> anyhow::Result<()> {
        ports_real::set_flow_control(self, port_id, dtr, rts)
    }

    /// 获取指定端口上次成功连接的参数（用于外部工具执行后重开端口）。
    pub fn get_last_params(&self, port_id: &str) -> Option<OpenPortArgs> {
        self.last_params.get(port_id).cloned()
    }

    /// 调整模拟终端（git bash pty）的尺寸。
    pub fn resize_tty_sim(&self, port_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        ports_tty::resize(self, port_id, cols, rows)
    }

    /// 把已启用的虚拟端口条目追加到系统端口列表之后。
    fn append_virtual_ports(&self, out: &mut Vec<PortInfo>) {
        if self.simulate {
            out.push(ports_sim::virtual_port_info());
        }
        if self.gitbash_sim {
            out.push(ports_tty::virtual_port_info());
        }
    }
}

/// 枚举可用端口（真实 + 已启用的虚拟端口），供命令层调用。
///
/// 系统枚举是阻塞 IO：在**锁外**执行，锁内只读能力开关并拼接虚拟条目——否则
/// 前端每 3s 一次的轮询会在持有全局串口锁期间阻塞发送/关闭命令。调用方必须从
/// 阻塞线程池调用（同步命令会在事件循环主线程上执行，把 UI 卡住）。
pub fn list_ports_blocking(manager: &Mutex<SerialManager>) -> anyhow::Result<Vec<PortInfo>> {
    let mut ports = ports_real::enumerate_system_ports()?;
    manager
        .lock()
        .map_err(lock_error)?
        .append_virtual_ports(&mut ports);
    Ok(ports)
}

impl Drop for SerialManager {
    fn drop(&mut self) {
        // 尽最大努力通知所有读取线程退出（应用退出时）。
        // 只发信号、不 join——进程退出会回收线程，join 可能阻塞约 100ms。
        for h in self.ports.values() {
            h.request_stop();
        }
        for h in self.sim_ports.values() {
            h.stop();
        }
        // 模拟终端：kill bash 子进程，让读线程在 pty 关闭后退出（进程退出回收线程）
        for h in self.tty_sim_ports.values_mut() {
            h.running.store(false, std::sync::atomic::Ordering::Relaxed);
            h.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    // 显式导入而非 `use super::*`：通配导入会把整个串口模块（含 serialport FFI
    // 路径）拉进 *测试* 二进制的链接闭包，Windows 上 harness 因缺少应用清单而以
    // 0xc0000139 加载失败。引用 serialport 类型 / `SerialManager` 的测试因此只在
    // 非 Windows 运行（CI 的 Linux/macOS 覆盖）；纯函数测试在所有平台运行。
    use super::{check_virtual_enabled, PortKind};

    // ---------- PortKind（纯函数，所有平台）----------

    #[test]
    fn port_kind_is_decided_by_id_prefix() {
        assert_eq!(PortKind::of("COM3"), PortKind::Real);
        assert_eq!(PortKind::of("/dev/ttyUSB0"), PortKind::Real);
        assert_eq!(PortKind::of("SIM:Loopback"), PortKind::Sim);
        assert_eq!(PortKind::of("GIT:BASH"), PortKind::Tty);
        // 前缀必须从头匹配：包含 "SIM:" 的真实端口名不算虚拟端口
        assert_eq!(PortKind::of("XSIM:Loopback"), PortKind::Real);
    }

    // ---------- 虚拟端口能力门控（纯函数，所有平台）----------

    #[test]
    fn virtual_port_gate_requires_capability_flag() {
        // 真实串口不受开关影响
        assert!(check_virtual_enabled(PortKind::Real, false, false).is_ok());
        // 开关开启才放行
        assert!(check_virtual_enabled(PortKind::Sim, true, false).is_ok());
        assert!(check_virtual_enabled(PortKind::Tty, false, true).is_ok());
        // 开关关闭一律报错（release 构建下两个开关恒为 false）
        let sim_err = check_virtual_enabled(PortKind::Sim, false, true)
            .unwrap_err()
            .to_string();
        assert!(sim_err.contains("Simulation"), "{sim_err}");
        let tty_err = check_virtual_enabled(PortKind::Tty, true, false)
            .unwrap_err()
            .to_string();
        assert!(tty_err.contains("Git Bash"), "{tty_err}");
    }

    // ---------- 管理器（引用 serialport 类型，仅非 Windows）----------

    #[cfg(not(target_os = "windows"))]
    use super::{list_ports_blocking, SerialManager};
    #[cfg(not(target_os = "windows"))]
    use crate::commands::OpenPortArgs;
    #[cfg(not(target_os = "windows"))]
    use std::sync::Mutex;

    #[cfg(not(target_os = "windows"))]
    fn open_args(port_id: &str) -> OpenPortArgs {
        OpenPortArgs {
            port_id: port_id.to_string(),
            baud_rate: 9600,
            data_bits: 8,
            parity: "None".to_string(),
            stop_bits: "One".to_string(),
            handshake: "None".to_string(),
            dtr: false,
            rts: false,
            cols: 80,
            rows: 24,
        }
    }

    // ---------- 打开路径：门控与缺失 AppHandle 的错误 ----------

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn open_port_rejects_virtual_ports_until_capability_enabled() {
        let mut m = SerialManager::new();
        let sim_err = m.open_port(open_args("SIM:Loopback")).unwrap_err().to_string();
        assert!(sim_err.contains("Simulation"), "{sim_err}");
        let tty_err = m.open_port(open_args("GIT:BASH")).unwrap_err().to_string();
        assert!(tty_err.contains("Git Bash"), "{tty_err}");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn open_port_requires_app_handle_when_capability_enabled() {
        let mut m = SerialManager::new();
        m.set_simulate(true);
        m.set_gitbash_sim(true);
        for port_id in ["COM1", "SIM:Loopback", "GIT:BASH"] {
            let err = m.open_port(open_args(port_id)).unwrap_err().to_string();
            assert!(err.contains("AppHandle not initialized"), "{port_id}: {err}");
        }
    }

    // ---------- 收发路径的缺失端口错误 ----------

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn send_data_errors_on_missing_ports() {
        let m = SerialManager::new();
        let real_err = m.send_data("COM1", "x", false, "None").unwrap_err().to_string();
        assert!(real_err.contains("Port not found"), "{real_err}");
        let sim_err = m.send_data("SIM:x", "x", false, "None").unwrap_err().to_string();
        assert!(sim_err.contains("Sim port not found"), "{sim_err}");
        let tty_err = m.send_data("GIT:BASH", "x", false, "None").unwrap_err().to_string();
        assert!(tty_err.contains("TTY sim port not found"), "{tty_err}");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn write_raw_errors_on_missing_ports() {
        let m = SerialManager::new();
        let real_err = m.write_raw("COM1", b"x").unwrap_err().to_string();
        assert!(real_err.contains("Port not found"), "{real_err}");
        let sim_err = m.write_raw("SIM:x", b"x").unwrap_err().to_string();
        assert!(sim_err.contains("Sim port not found"), "{sim_err}");
        let tty_err = m.write_raw("GIT:BASH", b"x").unwrap_err().to_string();
        assert!(tty_err.contains("TTY sim port not found"), "{tty_err}");
    }

    // ---------- 关闭 / 改参 / 句柄的错误路径 ----------

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn close_port_is_idempotent_on_missing_ports() {
        let mut m = SerialManager::new();
        for port_id in ["COM1", "SIM:Loopback", "GIT:BASH"] {
            assert!(m.close_port(port_id).unwrap().is_none(), "{port_id}");
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn port_mutating_commands_error_on_missing_ports() {
        let mut m = SerialManager::new();
        assert!(m.get_write_handle("COM1").is_err());
        assert!(m.set_flow_control("COM1", true, true).is_err());
        assert!(m.set_params("COM1", 9600, 8, "None", "One", "None").is_err());
        assert!(m.resize_tty_sim("GIT:BASH", 80, 24).is_err());
        assert!(m.get_last_params("COM1").is_none());
    }

    // ---------- 自动重连 ----------

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn reconnect_rejects_simulation_ports() {
        let m = Mutex::new(SerialManager::new());
        for port_id in ["SIM:Loopback", "GIT:BASH"] {
            let err = super::reconnect_blocking(&m, port_id).unwrap_err().to_string();
            assert!(err.contains("Cannot reconnect"), "{port_id}: {err}");
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn reconnect_reports_missing_params_for_unknown_real_port() {
        // 系统里不存在该端口 → 走到「不可用」，不进入打开路径（无硬件依赖）
        let mut inner = SerialManager::new();
        inner.last_params.insert("COM_NOT_PRESENT".to_string(), open_args("COM_NOT_PRESENT"));
        let m = Mutex::new(inner);
        let err = super::reconnect_blocking(&m, "COM_NOT_PRESENT")
            .unwrap_err()
            .to_string();
        assert!(err.contains("is not available"), "{err}");
    }

    // ---------- 端口列表的虚拟条目 ----------

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn list_ports_exposes_virtual_entries_only_when_enabled() {
        let m = Mutex::new(SerialManager::new());
        // 只断言虚拟条目，不对真实端口列表长度做任何假设。
        let ids = |m: &Mutex<SerialManager>| -> Vec<String> {
            list_ports_blocking(m)
                .unwrap()
                .into_iter()
                .map(|p| p.id)
                .collect()
        };
        assert!(!ids(&m).iter().any(|id| id == "SIM:Loopback"));
        assert!(!ids(&m).iter().any(|id| id == "GIT:BASH"));

        {
            let mut guard = m.lock().unwrap();
            guard.set_simulate(true);
            guard.set_gitbash_sim(true);
        }
        let ids = ids(&m);
        assert!(ids.iter().any(|id| id == "SIM:Loopback"), "{ids:?}");
        assert!(ids.iter().any(|id| id == "GIT:BASH"), "{ids:?}");

        // 虚拟条目必须标记为 sim 类（前端据此启用模拟相关 UI）
        let port_type = list_ports_blocking(&m)
            .unwrap()
            .into_iter()
            .find(|p| p.id == "SIM:Loopback")
            .map(|p| p.port_type)
            .expect("SIM:Loopback entry should exist when simulate is enabled");
        assert_eq!(port_type, "sim");
    }
}
