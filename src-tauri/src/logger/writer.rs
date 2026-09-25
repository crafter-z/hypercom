/**
 * 单端口日志写入器。
 *
 * 一个 `PortLogWriter` 只服务一个串口，独占自己的文件句柄与缓冲；它的所有状态
 * 都由 `LogManager` 装在一把**每端口**的锁里（见 manager.rs），因此这里的
 * `&mut self` 方法都是短临界区，不会与其它端口或目录遍历互相阻塞。
 */

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use encoding_rs::GBK;

use super::assembler::LogLineAssembler;
use super::naming::{self, FileMode};
use super::settings::LogSettings;

/// RX 尾部滞留多久后作为一行冲刷（与前端 250ms 静默 flush 的意图一致）
const RX_TAIL_SILENCE_FLUSH: Duration = Duration::from_millis(250);

/// 分片失败后的重试退避。失败立刻重试会在磁盘满这类持续故障下，让每个 RX 事件
/// 都去创建文件并刷一条错误日志（高波特率下每秒数千条）。退避期间照旧写旧文件：
/// 数据不丢，只是暂不滚动。
const SPLIT_RETRY_BACKOFF: Duration = Duration::from_secs(5);

/// 创建一个 writer 所需的全部参数。create 与「分片续片 / 换目录重开」共用，
/// 保证同一端口前后两片文件的编码、前缀开关、命名规则完全一致——重开时不沿用
/// 创建时锁定的编码，会导致日志文件里混入两种编码的字节。
#[derive(Clone)]
pub(super) struct WriterSpec {
    pub format: String,
    pub encoding: String,
    pub include_timestamp: bool,
    pub include_direction: bool,
    pub filename_format: String,
    pub subdir_mode: String,
    pub new_file_per_session: bool,
}

impl WriterSpec {
    /// 新建 writer 用：格式/编码由 start_logging 逐次传入，其余取当前设置
    pub(super) fn from_settings(settings: &LogSettings, format: &str, encoding: &str) -> Self {
        Self {
            format: format.to_string(),
            encoding: encoding.to_string(),
            include_timestamp: settings.include_timestamp,
            include_direction: settings.include_direction,
            filename_format: settings.filename_format.clone(),
            subdir_mode: settings.subdir_mode.clone(),
            new_file_per_session: settings.new_file_per_session,
        }
    }

    /// 已有 writer 重开用：命名参数跟随当前设置，而格式/编码/前缀开关沿用创建时锁定的值
    pub(super) fn with_current_naming(&self, settings: &LogSettings) -> Self {
        Self {
            filename_format: settings.filename_format.clone(),
            subdir_mode: settings.subdir_mode.clone(),
            new_file_per_session: settings.new_file_per_session,
            ..self.clone()
        }
    }
}

pub(super) struct PortLogWriter {
    file_path: PathBuf,
    writer: BufWriter<File>,
    /// 已写入字节数（含前缀与换行），用于分片阈值判定
    current_size: u64,
    spec: WriterSpec,
    /// RX 行聚合器：事件字节先进这里按行边界聚合，只有完整行才落盘
    assembler: LogLineAssembler,
    /// RX 尾部开始驻留的时刻（pending 空→非空时置位，清空时复位）：
    /// 供 250ms 静默冲刷判定，长停顿的未终结尾部不能无限滞留。
    rx_pending_since: Option<Instant>,
    /// 分片失败的退避截止时刻（见 SPLIT_RETRY_BACKOFF）
    split_backoff_until: Option<Instant>,
}

impl PortLogWriter {
    /// 打开（或按策略分配）目标文件并建 writer。
    /// `force_new_file` 用于分片续片——分片的语义就是新文件，与
    /// `new_file_per_session` 开关无关；若沿用 append 重开刚关闭的同名文件，
    /// `current_size` 会从已超阈值的大小初始化，之后每次写入都触发分片（无限分片循环）。
    pub(super) fn open(
        spec: &WriterSpec,
        root: &Path,
        port_id: &str,
        force_new_file: bool,
    ) -> anyhow::Result<Self> {
        let mode = if force_new_file || spec.new_file_per_session {
            FileMode::Unique
        } else {
            FileMode::Append
        };
        let (file_path, file, existing_size) = naming::allocate_file(
            root,
            &spec.subdir_mode,
            &spec.filename_format,
            port_id,
            mode,
        )?;
        Ok(Self {
            file_path,
            writer: BufWriter::new(file),
            current_size: existing_size,
            spec: spec.clone(),
            assembler: LogLineAssembler::new(),
            rx_pending_since: None,
            split_backoff_until: None,
        })
    }

    /// 分片续片 / 换目录重开：**先把新文件开好**，成功后才替换当前文件。
    /// 开文件失败时返回 Err 且旧 writer 原封不动——端口继续写旧文件，绝不出现
    /// 「分片失败即永久静默不落盘」；调用方负责把 Err 向上传播（S-B3）。
    pub(super) fn rotate(
        &mut self,
        spec: &WriterSpec,
        root: &Path,
        port_id: &str,
        force_new_file: bool,
    ) -> anyhow::Result<()> {
        let mode = if force_new_file || spec.new_file_per_session {
            FileMode::Unique
        } else {
            FileMode::Append
        };
        let (file_path, file, existing_size) = match naming::allocate_file(
            root,
            &spec.subdir_mode,
            &spec.filename_format,
            port_id,
            mode,
        ) {
            Ok(opened) => opened,
            Err(e) => {
                self.split_backoff_until = Some(Instant::now() + SPLIT_RETRY_BACKOFF);
                return Err(e);
            }
        };
        // 旧文件的缓冲显式落盘，不依赖 BufWriter::Drop（Drop 里的错误只能被丢弃）：
        // 新文件已就绪，此处失败只告警——不把写路径卡在旧文件上，端口才更快恢复落盘。
        if let Err(e) = self.flush_and_sync() {
            log::warn!("Log file final flush failed before rotate ({port_id}): {e}");
        }
        self.writer = BufWriter::new(file);
        self.file_path = file_path;
        self.current_size = existing_size;
        self.spec = spec.clone();
        self.split_backoff_until = None;
        Ok(())
    }

    pub(super) fn file_path(&self) -> &Path {
        &self.file_path
    }

    pub(super) fn current_size(&self) -> u64 {
        self.current_size
    }

    pub(super) fn spec(&self) -> &WriterSpec {
        &self.spec
    }

    /// 写入一行数据。`spec.format` 决定写入形式：
    /// - "hex": 每字节以 "XX " 形式写入并附时间戳/方向。
    /// - "binary": 原始字节直写，不附元信息。
    /// - 其他（默认 string）: 按 `spec.encoding` 解码为文本后写入。
    ///
    /// 行前缀（时间戳 / RX·TX 方向）按 `include_timestamp` / `include_direction`
    /// 开关拼接：两开关都关时前缀为空。
    ///
    /// 不在此处 flush——BufWriter 的缓冲在 close_writer / rotate / flush_all 时统一
    /// 落盘。高波特率下逐行 flush 会让每条数据都触发一次磁盘 IO，完全丧失缓冲收益。
    pub(super) fn write_line(
        &mut self,
        timestamp: &str,
        direction: &str,
        data: &[u8],
    ) -> anyhow::Result<()> {
        // 空数据不落盘——空行在日志里是纯噪音：
        // - RX：连续分隔符 / 行首行尾分隔符经 LogLineAssembler 产出**空块**，直接跳过；
        // - TX 空内容：空内容发送 / 只带行结束符的内容（decode 后 trim 为空的 `\r\n`）。
        if data.is_empty() {
            return Ok(());
        }
        let prefix = match (self.spec.include_timestamp, self.spec.include_direction) {
            (true, true) => format!("[{}] {} ", timestamp, direction),
            (true, false) => format!("[{}] ", timestamp),
            (false, true) => format!("{} ", direction),
            (false, false) => String::new(),
        };
        let written = match self.spec.format.as_str() {
            "hex" => {
                let hex_str = data
                    .iter()
                    .map(|b| format!("{:02X} ", b))
                    .collect::<String>();
                let line = format!("{}{}\n", prefix, hex_str.trim());
                self.writer.write_all(line.as_bytes())?;
                line.len()
            }
            "binary" => {
                // Frame: [timestamp] direction <raw data>\n — 保留原始字节，
                // 同时留一条可解析的头行。
                self.writer.write_all(prefix.as_bytes())?;
                self.writer.write_all(data)?;
                self.writer.write_all(b"\n")?;
                prefix.len() + data.len() + 1
            }
            _ => {
                let text = decode_bytes(data, &self.spec.encoding)
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                if text.is_empty() {
                    return Ok(());
                }
                let line = format!("{}{}\n", prefix, text);
                self.writer.write_all(line.as_bytes())?;
                line.len()
            }
        };
        // 累加实际写入字节数（含时间戳/方向前缀/换行），使分片阈值反映文件真实大小
        self.current_size += written as u64;
        Ok(())
    }

    /// 是否达到分片阈值
    pub(super) fn should_split(&self, split_size_mb: u32) -> bool {
        self.current_size >= (split_size_mb as u64) * 1024 * 1024
    }

    /// 达到阈值且不在失败退避窗口内
    pub(super) fn needs_split(&self, split_size_mb: u32) -> bool {
        self.should_split(split_size_mb)
            && self
                .split_backoff_until
                .is_none_or(|until| Instant::now() >= until)
    }

    /// RX 尾部滞留超时（250ms）时把尾部作为一行冲刷落盘。由写路径在每个事件到来
    /// 时机会性调用——日志路径没有后台定时器，长停顿的半行会在下一次事件时成行，
    /// 避免无限滞留（对齐前端 250ms 静默 flush 的意图；时间戳沿用当前事件时间）。
    pub(super) fn flush_stale_rx_tail(&mut self, timestamp: &str) -> anyhow::Result<()> {
        let stale = self
            .rx_pending_since
            .map(|since| since.elapsed() >= RX_TAIL_SILENCE_FLUSH)
            .unwrap_or(false);
        if stale {
            self.rx_pending_since = None;
            if let Some(tail) = self.assembler.take_tail() {
                self.write_line(timestamp, "RX", &tail)?;
            }
        }
        Ok(())
    }

    /// feed 后维护尾部驻留计时：pending 空→非空置位（记首字节时刻）；清空则复位。
    pub(super) fn update_rx_pending_since(&mut self) {
        if self.assembler.has_pending() {
            if self.rx_pending_since.is_none() {
                self.rx_pending_since = Some(Instant::now());
            }
        } else {
            self.rx_pending_since = None;
        }
    }

    /// 关闭前冲刷未终结的 RX 尾部（作为该端口的最后一行），并复位计时。
    pub(super) fn flush_rx_tail(&mut self, timestamp: &str) -> anyhow::Result<()> {
        self.rx_pending_since = None;
        if let Some(tail) = self.assembler.take_tail() {
            self.write_line(timestamp, "RX", &tail)?;
        }
        Ok(())
    }

    /// 喂入 RX 事件字节，返回聚合完成的整行（含空块，由 write_line 决定是否落盘）
    pub(super) fn feed_rx(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        self.assembler.feed(data)
    }

    /// 仅 flush 缓冲（周期刷盘用，不做 sync_all：性能优先）
    pub(super) fn flush(&mut self) -> anyhow::Result<()> {
        self.writer.flush()?;
        Ok(())
    }

    /// flush 后再 sync_all，确保 OS 把缓冲落盘（关闭 / 另存 / 换文件前的关键路径）
    pub(super) fn flush_and_sync(&mut self) -> anyhow::Result<()> {
        self.writer.flush()?;
        // try_clone 失败（句柄不可克隆）不是致命问题：数据至少已进入 OS 页缓存
        if let Ok(file) = self.writer.get_ref().try_clone() {
            file.sync_all()?;
        }
        Ok(())
    }
}

/// 按 encoding 解码字节为字符串。仅在 string 模式下调用。
/// - "GBK": 走 GBK → UTF-8 转换；解码失败的字节回退为 U+FFFD。
/// - "ISO-8859-1": 一对一映射到 U+0000-U+00FF。
/// - 其他（UTF-8 / ASCII / 未知）: `String::from_utf8_lossy`。
pub(super) fn decode_bytes(bytes: &[u8], encoding: &str) -> String {
    match encoding.to_ascii_uppercase().as_str() {
        "GBK" | "GB2312" | "GB18030" => GBK.decode(bytes).0.into_owned(),
        "ISO-8859-1" | "LATIN1" => bytes.iter().map(|&b| b as char).collect(),
        // ASCII 是 UTF-8 子集，UTF-8 直接走 lossy。
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hypercom_test_writer_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn spec() -> WriterSpec {
        WriterSpec {
            format: "string".to_string(),
            encoding: "UTF-8".to_string(),
            include_timestamp: true,
            include_direction: true,
            filename_format: "[com]".to_string(),
            subdir_mode: "none".to_string(),
            new_file_per_session: false,
        }
    }

    #[test]
    fn should_split_uses_megabyte_threshold() {
        let dir = test_dir("split");
        let mut writer = PortLogWriter::open(&spec(), &dir, "COM1", false).unwrap();
        assert!(!writer.should_split(1));
        writer.write_line("10:00:00", "TX", &vec![b'x'; 1024 * 1024]).unwrap();
        assert!(writer.should_split(1));
        assert!(writer.needs_split(1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_failure_keeps_the_old_writer_writable() {
        // S-B3 回归：分片/换目录重开失败时，旧 writer 必须原封不动继续可用——
        // 旧实现把失败的 writer 从表里摘掉，端口从此永久静默不落盘。
        let dir = test_dir("rotate_fail");
        let mut writer = PortLogWriter::open(&spec(), &dir, "COM1", false).unwrap();
        writer.write_line("10:00:00", "TX", b"before").unwrap();

        // 构造必然失败的根目录：把一个普通文件当成目录的父级
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let bad_root = blocker.join("sub");
        assert!(
            writer.rotate(&spec(), &bad_root, "COM1", true).is_err(),
            "rotate into an impossible root must fail"
        );

        // 旧 writer 仍指向旧文件，继续写仍然落盘
        assert_eq!(writer.file_path().parent().unwrap(), dir.as_path());
        writer.write_line("10:00:01", "TX", b"after").unwrap();
        writer.flush_and_sync().unwrap();
        let content = std::fs::read_to_string(writer.file_path()).unwrap();
        assert!(content.contains("before") && content.contains("after"), "{content}");

        // 失败进入退避窗口，避免持续故障下每个事件都重试
        assert!(!writer.needs_split(0), "backoff must suppress immediate retries");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_success_switches_file_and_resets_size() {
        let dir = test_dir("rotate_ok");
        let mut writer = PortLogWriter::open(&spec(), &dir, "COM1", false).unwrap();
        writer.write_line("10:00:00", "TX", b"first").unwrap();
        let old_path = writer.file_path().to_path_buf();
        writer.rotate(&spec(), &dir, "COM1", true).unwrap();
        assert_ne!(writer.file_path(), old_path.as_path());
        assert_eq!(writer.current_size(), 0);
        writer.write_line("10:00:01", "TX", b"second").unwrap();
        writer.flush_and_sync().unwrap();
        assert!(std::fs::read_to_string(&old_path).unwrap().contains("first"));
        assert!(std::fs::read_to_string(writer.file_path()).unwrap().contains("second"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn gbk_decoding_decodes_chinese_characters() {
        let (bytes, _, _) = GBK.encode("你好");
        let decoded = decode_bytes(&bytes, "GBK");
        assert_eq!(decoded, "你好");
        assert!(!decoded.contains('\u{FFFD}'));
    }

    #[test]
    fn writer_spec_keeps_locked_format_and_encoding_when_naming_changes() {
        // 换目录/分片重开只更新命名参数；格式与编码保持创建时锁定的值，否则同一
        // 端口前后两片文件会混入两种编码
        let mut settings = LogSettings::default();
        settings.filename_format = "[date]-[com]".to_string();
        settings.subdir_mode = "port".to_string();
        let updated = spec().with_current_naming(&settings);
        assert_eq!(updated.filename_format, "[date]-[com]");
        assert_eq!(updated.subdir_mode, "port");
        assert_eq!(updated.format, "string");
        assert_eq!(updated.encoding, "UTF-8");
    }
}
