/**
 * 串口编解码原语 (Serial Codec)
 * HEX 解析、TX 字节构造、带总期限的写入。
 *
 * 本模块只依赖 `std::io::Write`，**不引用 serialport 类型**：Windows 上
 * `cargo test` 的 harness 没有应用清单，测试二进制一旦链接到 serialport FFI 的
 * 入口点就会以 0xc0000139（STATUS_ENTRYPOINT_NOT_FOUND）加载失败。把纯逻辑放在
 * 这里并显式导入，其测试才能在**所有平台**（含 Windows）编译运行。
 */
use std::time::Duration;

/// 解析 HEX 字符串为字节数组。支持空格分隔（"48 65 6C"）或紧凑形式（"48656C"）。
/// 奇数位与非法十六进制字符一律报错（调用方必须把错误显示给用户，而不是自行补零）。
pub fn parse_hex_string(data: &str) -> anyhow::Result<Vec<u8>> {
    // 收集 (原始索引, 字节) 并跳过空白；保留原始索引使错误定位指向输入原文，
    // 而非去空白后的字符串（"AA ZZ" 的坏对应报位置 3，而非 2）。
    let hex_bytes: Vec<(usize, u8)> = data
        .as_bytes()
        .iter()
        .enumerate()
        .filter(|(_, b)| !b.is_ascii_whitespace())
        .map(|(i, b)| (i, *b))
        .collect();
    if !hex_bytes.len().is_multiple_of(2) {
        return Err(anyhow::anyhow!(
            "HEX string has odd length: {} hex chars",
            hex_bytes.len()
        ));
    }
    // 将单个 ASCII 十六进制字符解码为数值 0-15，非法字符返回 None。
    let nibble = |b: u8| -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    };
    let mut result = Vec::with_capacity(hex_bytes.len() / 2);
    for pair in hex_bytes.chunks(2) {
        let (hi_index, hi_byte) = pair[0];
        let (_, lo_byte) = pair[1];
        match (nibble(hi_byte), nibble(lo_byte)) {
            (Some(hi), Some(lo)) => result.push((hi << 4) | lo),
            _ => {
                let hex_pair = String::from_utf8_lossy(&[hi_byte, lo_byte]).into_owned();
                return Err(anyhow::anyhow!(
                    "Invalid HEX byte at position {}: \"{}\"",
                    hi_index,
                    hex_pair
                ));
            }
        }
    }
    Ok(result)
}

/// 模拟终端（git bash pty）发送时的行结束符归一。
///
/// pty 行规程（ICRNL）会把输入里的 `\r` 转成 `\n`——因此对 TTY 类端口发送
/// `\r\n` 会变成**两个**换行：bash 执行完命令后还多收到一个空行，表现为
/// 「快捷发送后额外多执行一行空命令」。TTY 语义下回车统一为单个 `\r`
/// （真实终端 Enter 发出的就是 `\r`）；`\r`/`\n`/`None` 原样保留。
pub(super) fn normalize_tty_line_ending(append_line_ending: &str) -> &str {
    if append_line_ending == "\\r\\n" {
        "\\r"
    } else {
        append_line_ending
    }
}

/// 计算"应当写入端口"的字节序列。HEX 模式解析十六进制字符串（忽略行结束符）；
/// 文本模式附加行结束符。真实/模拟/TTY 三类端口的发送路径共用本函数，保证
/// 「入参 → 字节」的映射只有一份实现。
pub fn build_tx_bytes(
    data: &str,
    is_hex: bool,
    append_line_ending: &str,
) -> anyhow::Result<Vec<u8>> {
    if is_hex {
        return parse_hex_string(data);
    }
    let mut bytes = data.as_bytes().to_vec();
    match append_line_ending {
        "\\r\\n" => bytes.extend_from_slice(b"\r\n"),
        "\\r" => bytes.push(b'\r'),
        "\\n" => bytes.push(b'\n'),
        _ => {}
    }
    Ok(bytes)
}

/// 一次发送的**实际结果**——TX 日志与返回给前端的字节数的唯一来源。
///
/// 为什么不各自按入参重算：入参重算出的字节可能 ≠ 真正送达端口的字节——
/// TTY 会把 `\r\n` 归一成 `\r`（行规程会再把它变成单个换行）、SIM 频率命令被
/// 控制通道吞掉（没有任何数据上线）、真实串口写入中途失败只送出一部分。
/// 任何第二次独立计算都会让 TX 日志与线上字节不一致（用户看到「发了 6 字节」
/// 而日志记着 7 字节）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxOutcome {
    /// 实际送达端口的字节（TX 日志只写这个）
    pub bytes: Vec<u8>,
    /// 实际写出的字节数（返回给前端）
    pub written: usize,
}

impl TxOutcome {
    /// 全部字节成功送达端口。
    pub fn sent(bytes: Vec<u8>) -> Self {
        let written = bytes.len();
        Self { bytes, written }
    }

    /// 没有任何字节上线：SIM 频率命令走控制通道，只切换周期输出速率。
    pub(super) fn consumed() -> Self {
        Self {
            bytes: Vec::new(),
            written: 0,
        }
    }
}

/// 发送写操作的总写入期限。
///
/// Windows 上每次 `write()`（WriteFile）受 `COMMTIMEOUTS` 约束
/// （`.timeout(100ms)` → `WriteTotalTimeoutConstant: 100`，每次最多 ~100ms），
/// 但超时不是错误——返回部分/零字节计数，`write_all` 以 ~100ms/次循环重试。
/// 对端长时间不取走数据（流控卡住 / USB-UART FIFO 满）时，长 payload 的
/// `write_all` 会无限循环；本常量作为总期限兜底，超时即报错而非无限等待。
pub const WRITE_TOTAL_DEADLINE: Duration = Duration::from_millis(2000);

/// 单次 WriteFile 慢阈值：超过即 `log::warn!`（性能打点）。
/// Windows 上每次 WriteFile 受 `WriteTotalTimeoutConstant=100ms` 约束，驱动缓冲
/// 满/流控卡死时单次写可被拖满——>100ms 即可视为异常。
const SINGLE_WRITE_WARN: Duration = Duration::from_millis(100);
/// 整批写入总耗时慢阈值：正常批次远低于此值，超过即 `log::warn!`。
const TOTAL_WRITE_WARN: Duration = Duration::from_millis(500);

/// 带总写入期限的 `write_all`。
///
/// 替代 `std::io::Write::write_all`：
/// - **不调用 `flush()`**——Windows 上 `flush()` = `FlushFileBuffers`，无超时、
///   受流控约束，对端忙/CTS 拉低/XOFF 时**无界阻塞**（"TX 后长时间收不到
///   响应"的根因；`write_all` 已把字节交给驱动，等物理发完对调试工具几乎
///   无收益）。
/// - `Ok(0)` 立即报错（`WriteZero` 语义：流控卡死时驱动缓冲不空，WriteFile
///   超时返回零字节计数）。
/// - `TimedOut`（WriteTotalTimeoutConstant 到期）重试到总期限；`Interrupted`
///   直接继续。
/// - 超过 `deadline` 仍未写完时报错，避免长 payload 以 ~100ms/次无限循环。
///
/// 性能打点：记录单次写与整批总耗时——单次 WriteFile 超 100ms 或整批总耗时超
/// 500ms 时 `log::warn!`（带端口标识/字节数/耗时）；正常路径不打点，避免高频刷屏。
///
/// 接受 `&mut dyn std::io::Write`（`serialport::SerialPort: io::Read + io::Write`），
/// 测试可用纯 std mock writer，不触碰 serialport FFI。
pub fn write_all_with_deadline(
    port_id: &str,
    port: &mut dyn std::io::Write,
    bytes: &[u8],
    deadline: Duration,
) -> anyhow::Result<()> {
    let start = std::time::Instant::now();
    let mut written = 0usize;
    while written < bytes.len() {
        let write_start = std::time::Instant::now();
        let before = written;
        match port.write(&bytes[written..]) {
            Ok(0) => {
                return Err(anyhow::anyhow!(
                    "Serial write returned 0 bytes (flow control stalled?)"
                ));
            }
            Ok(n) => written += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // 写超时（WriteTotalTimeoutConstant 到期，驱动缓冲未空）：重试，
            // 由总期限兜底防止无限循环。
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(anyhow::anyhow!("Serial write error: {e}")),
        }
        // 单次 WriteFile 慢阈值打点：>100ms 视为流控/驱动异常。
        let single_elapsed = write_start.elapsed();
        if single_elapsed > SINGLE_WRITE_WARN {
            log::warn!(
                "Slow serial write to {}: {} bytes written in {}ms (batch {}/{} bytes)",
                port_id,
                written - before,
                single_elapsed.as_millis(),
                written,
                bytes.len()
            );
        }
        if written < bytes.len() && start.elapsed() >= deadline {
            return Err(anyhow::anyhow!(
                "Serial write timed out after {}ms ({} of {} bytes written)",
                deadline.as_millis(),
                written,
                bytes.len()
            ));
        }
    }
    // 整批总耗时打点：>500ms 视为异常（正常批次微秒级）。
    let total_elapsed = start.elapsed();
    if total_elapsed > TOTAL_WRITE_WARN {
        log::warn!(
            "Slow serial batch write to {}: {} bytes in {}ms",
            port_id,
            bytes.len(),
            total_elapsed.as_millis()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // 显式导入而非 `use super::*`：通配导入会把整个串口模块（含 serialport FFI
    // 路径）拉进 *测试* 二进制的链接闭包，Windows harness 因缺少应用清单加载失败。
    // 本模块只用 std，故这些测试在所有平台都能跑。
    use super::{
        build_tx_bytes, normalize_tty_line_ending, parse_hex_string, write_all_with_deadline,
    };
    use std::time::Duration;

    // ---------- parse_hex_string ----------

    #[test]
    fn parse_hex_accepts_space_separated_compact_and_mixed() {
        assert_eq!(parse_hex_string("48 65 6C").unwrap(), vec![0x48, 0x65, 0x6C]);
        assert_eq!(parse_hex_string("48656c").unwrap(), vec![0x48, 0x65, 0x6C]);
        assert_eq!(parse_hex_string("48 656C").unwrap(), vec![0x48, 0x65, 0x6C]);
    }

    #[test]
    fn parse_hex_accepts_lowercase_and_boundary_values() {
        assert_eq!(parse_hex_string("aF").unwrap(), vec![0xAF]);
        assert_eq!(parse_hex_string("FF 00").unwrap(), vec![255, 0]);
    }

    #[test]
    fn parse_hex_empty_and_whitespace_only_yield_empty() {
        assert_eq!(parse_hex_string("").unwrap(), Vec::<u8>::new());
        assert_eq!(parse_hex_string("  ").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn parse_hex_rejects_odd_length() {
        assert!(parse_hex_string("486").is_err());
    }

    #[test]
    fn parse_hex_rejects_invalid_nibbles() {
        assert!(parse_hex_string("4Z").is_err());
    }

    #[test]
    fn parse_hex_error_reports_original_index_of_bad_pair() {
        // "AA ZZ": 空格在原始索引 2，坏对 "ZZ" 从原始索引 3 开始（证明位置修复）。
        let err = parse_hex_string("AA ZZ").unwrap_err().to_string();
        assert!(err.contains('3'), "error should contain original index 3: {err}");
    }

    // ---------- build_tx_bytes ----------

    #[test]
    fn build_tx_bytes_text_appends_line_endings() {
        assert_eq!(build_tx_bytes("hi", false, "\\r\\n").unwrap(), b"hi\r\n");
        assert_eq!(build_tx_bytes("hi", false, "\\r").unwrap(), b"hi\r");
        assert_eq!(build_tx_bytes("hi", false, "\\n").unwrap(), b"hi\n");
        assert_eq!(build_tx_bytes("hi", false, "None").unwrap(), b"hi");
        assert_eq!(build_tx_bytes("", false, "None").unwrap(), b"");
    }

    #[test]
    fn build_tx_bytes_hex_ignores_line_ending_and_validates() {
        assert_eq!(build_tx_bytes("48 65", true, "\\r\\n").unwrap(), vec![0x48, 0x65]);
        assert!(build_tx_bytes("4", true, "None").is_err());
    }

    // ---------- normalize_tty_line_ending（快捷发送后多执行一行空命令的根因）----------

    #[test]
    fn tty_line_ending_crlf_normalizes_to_single_cr() {
        // pty 行规程（ICRNL）把 \r 转成 \n：`\r\n` 会变成两个换行 → bash 多执行
        // 一行空命令。TTY 发送 `\r\n` 必须归一为单个 `\r`（真实终端 Enter）。
        assert_eq!(normalize_tty_line_ending("\\r\\n"), "\\r");
        assert_eq!(normalize_tty_line_ending("\\r"), "\\r");
        assert_eq!(normalize_tty_line_ending("\\n"), "\\n");
        assert_eq!(normalize_tty_line_ending("None"), "None");
    }

    #[test]
    fn tty_send_bytes_after_normalization_are_single_terminated() {
        // 归一后的实际写入字节：`echo hi\r\n` → `echo hi\r`（一个回车，不再双换行）。
        let bytes = build_tx_bytes("echo hi", false, normalize_tty_line_ending("\\r\\n")).unwrap();
        assert_eq!(bytes, b"echo hi\r");
        // `\n` 与 `None` 不受归一影响。
        assert_eq!(
            build_tx_bytes("echo hi", false, normalize_tty_line_ending("\\n")).unwrap(),
            b"echo hi\n"
        );
        assert_eq!(
            build_tx_bytes("echo hi", false, normalize_tty_line_ending("None")).unwrap(),
            b"echo hi"
        );
    }

    // ---------- write_all_with_deadline（纯 std mock，Windows 亦可运行）----------

    struct ZeroWriter;
    impl std::io::Write for ZeroWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Ok(0)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 模拟 WriteTotalTimeoutConstant 到期：WriteFile 超时返回 TimedOut。
    struct AlwaysTimeoutWriter;
    impl std::io::Write for AlwaysTimeoutWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timeout"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 每次调用至多写 max 字节的部分写 writer：模拟驱动缓冲不空时
    /// WriteFile 返回部分字节计数的场景。
    struct PartialWriter {
        max: usize,
        buf: Vec<u8>,
    }
    impl std::io::Write for PartialWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let n = buf.len().min(self.max);
            self.buf.extend_from_slice(&buf[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 第一次 write 返回 Interrupted，之后正常写入。
    struct InterruptedOnceWriter {
        buf: Vec<u8>,
        interrupted: bool,
    }
    impl std::io::Write for InterruptedOnceWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if !self.interrupted {
                self.interrupted = true;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "interrupted",
                ));
            }
            self.buf.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn write_all_with_deadline_writes_all_bytes_to_a_normal_writer() {
        let mut buf = Vec::new();
        write_all_with_deadline("test", &mut buf, b"hello", Duration::from_secs(1)).unwrap();
        assert_eq!(buf, b"hello");
    }

    #[test]
    fn write_all_with_deadline_handles_partial_writes() {
        let mut w = PartialWriter {
            max: 2,
            buf: Vec::new(),
        };
        write_all_with_deadline("test", &mut w, b"abcdef", Duration::from_secs(1)).unwrap();
        assert_eq!(w.buf, b"abcdef");
    }

    #[test]
    fn write_all_with_deadline_errors_on_zero_byte_write() {
        let mut w = ZeroWriter;
        let err = write_all_with_deadline("test", &mut w, b"x", Duration::from_secs(1))
            .unwrap_err()
            .to_string();
        assert!(err.contains("returned 0 bytes"), "{err}");
    }

    #[test]
    fn write_all_with_deadline_times_out_when_writes_never_progress() {
        let mut w = AlwaysTimeoutWriter;
        let err = write_all_with_deadline("test", &mut w, b"payload", Duration::from_millis(1))
            .unwrap_err()
            .to_string();
        assert!(err.contains("timed out"), "{err}");
    }

    #[test]
    fn write_all_with_deadline_retries_interrupted_writes() {
        let mut w = InterruptedOnceWriter {
            buf: Vec::new(),
            interrupted: false,
        };
        write_all_with_deadline("test", &mut w, b"abc", Duration::from_secs(1)).unwrap();
        assert_eq!(w.buf, b"abc");
    }

    #[test]
    fn write_all_with_deadline_empty_payload_is_a_noop() {
        let mut w = ZeroWriter; // 即使 writer 恒返回 0，空 payload 也不该报错
        write_all_with_deadline("test", &mut w, b"", Duration::from_secs(1)).unwrap();
    }
}
