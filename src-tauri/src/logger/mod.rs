/**
 * 日志管理模块 (Log Manager)
 * 负责串口通信日志的写入、分片、另存等操作
 *
 * 设计要点:
 * - 使用 BufWriter 异步写入，减少磁盘IO阻塞
 * - 支持按日期或大小自动分片
 * - 支持字符串/HEX/二进制三种格式
 * - 每个串口对应独立的日志文件
 */
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use encoding_rs::GBK;
use serde::{Deserialize, Serialize};

/// 文件名模板默认值，与前端 defaultConfig.logFilenameFormat 保持一致。
const DEFAULT_FILENAME_FORMAT: &str = "[com]-[datetime]";

/// 日志子目录策略默认值（issue #5-10）：按日期分文件夹，与前端 defaultConfig 保持一致。
const DEFAULT_SUBDIR_MODE: &str = "date";

/// 日志文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub path: String,
    pub port_id: String,
    pub created_at: i64,
    pub size: u64,
}

/// 单个串口的日志写入器
pub struct PortLogWriter {
    pub file_path: PathBuf,
    pub writer: BufWriter<fs::File>,
    pub current_size: u64,
    pub format: String, // "string" | "hex" | "binary"
    /// 解码标签：UTF-8 / GBK / ISO-8859-1 / ASCII，用于 string 模式下解码字节流。
    pub encoding: String,
    /// 行前缀是否包含时间戳（issue #3-4）
    pub include_timestamp: bool,
    /// 行前缀是否包含 RX/TX 方向标记（issue #3-4）
    pub include_direction: bool,
    /// RX 行聚合器（issue #5-9）：事件字节先进这里按行边界聚合，
    /// 只有完整行才落盘——跨事件的响应不再被切成碎片行。
    pub assembler: LogLineAssembler,
    /// RX 尾部开始驻留的时刻（pending 空→非空时置位，清空时复位）：
    /// 供 250ms 静默冲刷判定，长停顿的未终结尾部不能无限滞留。
    pub rx_pending_since: Option<std::time::Instant>,
}

impl PortLogWriter {
    /// 写入一行数据。`format` 决定写入形式：
    /// - "hex": 每字节以 "XX " 形式写入并附时间戳/方向。
    /// - "binary": 原始字节直写，不附元信息。
    /// - 其他（默认 string）: 按 `encoding` 解码为文本后写入。
    ///   GBK/ISO-8859-1 走显式映射，UTF-8/ASCII/未知值回退到 `from_utf8_lossy`。
    ///
    /// 行前缀（时间戳 / RX·TX 方向）按 `include_timestamp` / `include_direction`
    /// 开关拼接（issue #3-4）：两开关都关时前缀为空。
    ///
    /// 不在此处 flush——BufWriter 的缓冲在 close_writer / split / flush_all 时
    /// 统一落盘。高波特率下逐行 flush 会导致每条数据都触发一次磁盘 IO，
    /// 完全丧失 BufWriter 的缓冲收益。
    pub fn write_line(
        &mut self,
        timestamp: &str,
        direction: &str,
        data: &[u8],
    ) -> anyhow::Result<()> {
        // 空数据不落盘（issue：日志文件大量空日志）——空行在日志里是纯噪音：
        // - RX：连续分隔符 / 行首行尾分隔符经 LogLineAssembler 产出**空块**，
        //   直接跳过（否则每行都是 "[ts] RX \n"）；
        // - TX 空内容：空内容发送 / 只带行结束符的内容（decode 后 trim 为空的
        //   `\r\n`）同样属于空日志。
        if data.is_empty() {
            return Ok(());
        }
        let prefix = match (self.include_timestamp, self.include_direction) {
            (true, true) => format!("[{}] {} ", timestamp, direction),
            (true, false) => format!("[{}] ", timestamp),
            (false, true) => format!("{} ", direction),
            (false, false) => String::new(),
        };
        let written = match self.format.as_str() {
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
                // Frame: [timestamp] direction <raw data>\n — keeps raw bytes intact
                // while adding a parseable header line.
                self.writer.write_all(prefix.as_bytes())?;
                self.writer.write_all(data)?;
                self.writer.write_all(b"\n")?;
                prefix.len() + data.len() + 1
            }
            _ => {
                let text = decode_bytes(data, &self.encoding)
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                // 纯行结束符（如 TX 空内容 + `\r\n`）解码后为空 → 不落盘
                if text.is_empty() {
                    return Ok(());
                }
                let line = format!("{}{}\n", prefix, text);
                self.writer.write_all(line.as_bytes())?;
                line.len()
            }
        };
        // 累加实际写入字节数（含时间戳/方向前缀/换行），使分片阈值准确反映文件真实大小。
        self.current_size += written as u64;
        Ok(())
    }

    /// 检查是否需要分片
    pub fn should_split(&self, split_size_mb: u32) -> bool {
        self.current_size >= (split_size_mb as u64) * 1024 * 1024
    }

    /// RX 尾部滞留超时（250ms）时把尾部作为一行冲刷落盘（issue #5-9）。
    /// 由 write_rx 在每个事件到来时机会性调用——日志路径没有后台定时器，
    /// 长停顿的半行会在下一次事件时成行，避免无限滞留（对齐前端 250ms
    /// 静默 flush 的意图；时间戳沿用当前事件时间）。
    pub fn flush_stale_rx_tail(&mut self, timestamp: &str) -> anyhow::Result<()> {
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
    pub fn update_rx_pending_since(&mut self) {
        if self.assembler.has_pending() {
            if self.rx_pending_since.is_none() {
                self.rx_pending_since = Some(std::time::Instant::now());
            }
        } else {
            self.rx_pending_since = None;
        }
    }

    /// 关闭前冲刷未终结的 RX 尾部（作为该端口的最后一行），并复位计时。
    pub fn flush_rx_tail(&mut self, timestamp: &str) -> anyhow::Result<()> {
        self.rx_pending_since = None;
        if let Some(tail) = self.assembler.take_tail() {
            self.write_line(timestamp, "RX", &tail)?;
        }
        Ok(())
    }
}

/// 字节级 RX 行聚合器（issue #5-9）——日志路径的 LogLineAssembler。
///
/// 与前端 `src/utils/rxAssembler.ts` 的 RxLineAssembler 语义逐字节对齐：
/// 串口读事件按 ≤1024B/次切分、与行边界无关，一次设备响应可能横跨多个
/// 事件；按 0x0A (LF) / 0x0D (CR) 在**字节级**把流切成「已完成行的字节块」：
///
/// - CR、LF 均为分隔符；跨两次 feed 的 CRLF 对识别为**一个**分隔符——
///   CR 处发射当前行并置 pending_cr 标记，下一字节是 LF 则静默吞掉，
///   是其它字节则照常处理（标记随之清除）。
/// - 单独的 CR 也是分隔符（classic Mac 风格 / 部分设备）。
/// - 连续分隔符发射空块（空行）。
/// - pending 达到 max_pending_bytes 时无分隔符强制发射——防止无换行的
///   二进制流让缓冲无限增长。
///
/// 0x0A/0x0D 不可能出现在 UTF-8 / GBK 的多字节序列内部（ISO-8859-1 与
/// ASCII 本就是单字节），因此字节级切分对全部四种受支持编码都安全。
///
/// 纯逻辑：无 IO 依赖，可独立单测（FFI-free，Windows cargo test 可跑）。
pub struct LogLineAssembler {
    /// 尚未终结的行字节（不含分隔符）
    pending: Vec<u8>,
    /// 上一个发射的分隔符是 CR：下一字节若是 LF 则视为 CRLF 对的后半，静默吞掉
    pending_cr: bool,
    /// 强制发射阈值（字节）：pending 达到该长度即无分隔符发射。默认 4096
    max_pending_bytes: usize,
}

/// 无分隔符强制发射阈值（与前端 RxLineAssembler 默认一致）
const RX_LINE_MAX_PENDING_BYTES: usize = 4096;
/// 静默冲刷超时：RX 尾部滞留超过该时长即作为一行落盘（与前端默认一致）
const RX_TAIL_SILENCE_FLUSH: std::time::Duration = std::time::Duration::from_millis(250);
/// list_files 递归下钻深度上限（issue #5-10）：防御目录联接成环导致无限递归
const MAX_LIST_DEPTH: usize = 16;

impl LogLineAssembler {
    pub fn new() -> Self {
        Self::with_max_pending(RX_LINE_MAX_PENDING_BYTES)
    }

    /// 自定义强制发射阈值（测试注入用）
    pub fn with_max_pending(max_pending_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            pending_cr: false,
            max_pending_bytes,
        }
    }

    /// 喂入一段字节，返回按流顺序完成的行字节块（块内容不含分隔符）。
    /// 输入不会被修改；返回块是独立分配。
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut lines: Vec<Vec<u8>> = Vec::new();
        for &b in bytes {
            if self.pending_cr {
                self.pending_cr = false;
                if b == b'\n' {
                    // CRLF 对的后半：行已在 CR 处发射，静默消费
                    continue;
                }
                // 非 LF：标记已清除，按普通字节继续处理
            }
            if b == b'\r' || b == b'\n' {
                // 分隔符：发射当前行（pending 为空时即空块 = 空行），重置 pending。
                // CR 额外置 pending_cr，用于识别跨 feed 的 CRLF 对。
                lines.push(std::mem::take(&mut self.pending));
                if b == b'\r' {
                    self.pending_cr = true;
                }
            } else {
                self.pending.push(b);
                if self.pending.len() >= self.max_pending_bytes {
                    // 强制发射：防止无换行二进制流无界增长。发射后继续扫描本段剩余字节
                    lines.push(std::mem::take(&mut self.pending));
                }
            }
        }
        lines
    }

    /// 取出未终结的尾部字节并重置状态（静默冲刷 / 关闭时用）。
    /// 无 pending 字节时返回 None。
    pub fn take_tail(&mut self) -> Option<Vec<u8>> {
        self.pending_cr = false;
        let tail = std::mem::take(&mut self.pending);
        if tail.is_empty() {
            None
        } else {
            Some(tail)
        }
    }

    /// 是否存在未终结的尾部字节
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// 丢弃所有缓冲字节与分隔符标记（重连 / 关闭后从干净状态开始）。
    /// 与前端 RxLineAssembler.reset() API 对齐；当前生产路径在 close_writer
    /// 时整体丢弃 assembler，此方法保留供重连/编码切换类场景与测试使用。
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.pending.clear();
        self.pending_cr = false;
    }
}

/// 按 encoding 解码字节为字符串。仅在 string 模式下调用。
/// - "GBK": 走 GBK → UTF-8 转换；解码失败的字节回退为 U+FFFD。
/// - "ISO-8859-1": 一对一映射到 U+0000-U+00FF。
/// - 其他（UTF-8 / ASCII / 未知）: `String::from_utf8_lossy`。
fn decode_bytes(bytes: &[u8], encoding: &str) -> String {
    match encoding.to_ascii_uppercase().as_str() {
        "GBK" | "GB2312" | "GB18030" => decode_gbk_lossy(bytes),
        "ISO-8859-1" | "LATIN1" => bytes.iter().map(|&b| b as char).collect(),
        // ASCII 是 UTF-8 子集，UTF-8 直接走 lossy。
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// GBK 解码：有效 GBK 字节转换为 Unicode；非法序列替换为 U+FFFD。
fn decode_gbk_lossy(bytes: &[u8]) -> String {
    GBK.decode(bytes).0.into_owned()
}

/// 净化要替换进文件名模板的 port_id（路径遍历防御，defects #54 同类）：
/// port_id 来自前端，若含路径分隔符或 ".."，拼出的日志文件会逃逸出日志目录，
/// 造成任意文件追加。把 Windows 非法字符 \/:*?"<>| 与 ".." 统一替换为 '_'。
fn sanitize_filename_component(input: &str) -> String {
    input
        .replace(&['/', '\\', ':', '*', '?', '"', '<', '>', '|'][..], "_")
        .replace("..", "_")
}

pub struct LogManager {
    /// 日志根目录
    log_directory: PathBuf,
    /// 活跃写入器（按串口ID索引）
    writers: HashMap<String, PortLogWriter>,
    /// 是否自动保存：false 时 write() 直接短路，避免与前端状态不同步导致的"幽灵写入"。
    auto_save: bool,
    /// 分片大小 (MB)
    split_size_mb: u32,
    /// 文件名格式 (e.g. "[com]-[datetime]")
    filename_format: String,
    /// 日志子目录策略（issue #5-10）："none" | "date" | "port"
    subdir_mode: String,
    /// 每次打开串口新建日志文件（不续写已有文件）：true 时 create_writer 用
    /// create_new 原子分配唯一文件名（同名冲突追加 -1/-2… 后缀），每次连接
    /// 都从空文件开始；false（默认）沿用旧行为——文件名冲突时续写。
    new_file_per_session: bool,
    /// 默认 encoding（创建 writer 时使用，前端可在 start_logging 时覆盖）
    default_encoding: String,
    /// 是否启用按大小自动分片（前端可运行时开关）
    split_enabled: bool,
    /// 行前缀是否包含时间戳（issue #3-4）：create_writer 时锁定
    include_timestamp: bool,
    /// 行前缀是否包含 RX/TX 方向标记（issue #3-4）：create_writer 时锁定
    include_direction: bool,
    /// 上次 flush 时间戳，用于周期性刷盘（每 5 秒）
    last_flush: std::time::Instant,
}

impl LogManager {
    pub fn new() -> Self {
        let log_directory = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("hypercom")
            .join("logs");

        if let Err(e) = fs::create_dir_all(&log_directory) {
            log::error!(
                "Failed to create log directory {:?}: {}. Logging will fail.",
                log_directory,
                e
            );
        }

        Self {
            log_directory,
            writers: HashMap::new(),
            auto_save: false,
            split_size_mb: 100,
            filename_format: DEFAULT_FILENAME_FORMAT.to_string(),
            subdir_mode: DEFAULT_SUBDIR_MODE.to_string(),
            new_file_per_session: false,
            default_encoding: "UTF-8".to_string(),
            split_enabled: true,
            include_timestamp: true,
            include_direction: true,
            last_flush: std::time::Instant::now(),
        }
    }

    /// 获取当前日志目录
    pub fn get_directory(&self) -> &PathBuf {
        &self.log_directory
    }

    /// 设置日志目录
    pub fn set_directory(&mut self, path: String) -> anyhow::Result<()> {
        let new_path = PathBuf::from(path);
        fs::create_dir_all(&new_path)?;
        self.log_directory = new_path;
        Ok(())
    }

    /// 设置分片大小
    pub fn set_split_size(&mut self, mb: u32) {
        self.split_size_mb = mb;
    }

    /// 设置文件名格式
    pub fn set_filename_format(&mut self, format: &str) {
        self.filename_format = format.to_string();
    }

    /// 设置日志子目录策略（issue #5-10）："none" / "date" / "port"。
    /// 前端在 set_config 时同步调用；create_writer 时按当前值决定子目录。
    pub fn set_subdir_mode(&mut self, mode: &str) {
        self.subdir_mode = mode.to_string();
    }

    /// 设置「每次打开串口新建日志文件」开关。前端在 set_config 时同步调用；
    /// create_writer 时按当前值决定文件分配策略（续写 vs create_new 唯一化）。
    pub fn set_new_file_per_session(&mut self, on: bool) {
        self.new_file_per_session = on;
    }

    /// 设置 auto_save 开关。前端在 set_config 时同步调用，让后端在 write() 中
    /// 自检短路，避免出现配置已关但写入仍持续的幽灵状态（defects #53）。
    pub fn set_auto_save(&mut self, on: bool) {
        self.auto_save = on;
    }

    /// 设置默认 encoding（GBK / UTF-8 / ASCII / ISO-8859-1）。
    /// 已存在的 writer 不受影响 — encoding 在 create_writer 时锁定。
    pub fn set_default_encoding(&mut self, encoding: &str) {
        self.default_encoding = encoding.to_string();
    }

    /// 设置是否启用按大小自动分片。前端在 set_config 时同步调用。
    pub fn set_split_enabled(&mut self, enabled: bool) {
        self.split_enabled = enabled;
    }

    /// 设置日志行前缀是否包含时间戳（issue #3-4）。前端在 set_config 时同步调用。
    pub fn set_include_timestamp(&mut self, on: bool) {
        self.include_timestamp = on;
    }

    /// 设置日志行前缀是否包含 RX/TX 方向标记（issue #3-4）。前端在 set_config 时同步调用。
    pub fn set_include_direction(&mut self, on: bool) {
        self.include_direction = on;
    }

    /// 解析文件名模板: [com] → port_id, [datetime] → 20260101_120000, [date] → 2026-01-01, [time] → 12:00:00
    fn format_filename(&self, port_id: &str) -> String {
        let now = chrono::Local::now();
        self.filename_format
            .replace("[com]", &sanitize_filename_component(port_id))
            .replace("[datetime]", &now.format("%Y%m%d_%H%M%S").to_string())
            .replace("[date]", &now.format("%Y-%m-%d").to_string())
            .replace("[time]", &now.format("%H-%M-%S").to_string())
    }

    /// 计算子目录名（issue #5-10）：
    /// - "none" → None（直接存入日志目录）
    /// - "port" → 净化后的 port_id（复用 sanitize_filename_component，防路径遍历）
    /// - "date" 与未知模式 → 当前日期 YYYY-MM-DD（未知模式按默认 date 收敛，与配置端 clamp 一致）
    fn subdir_component(&self, port_id: &str) -> Option<String> {
        match self.subdir_mode.as_str() {
            "none" => None,
            "port" => Some(sanitize_filename_component(port_id)),
            _ => Some(chrono::Local::now().format("%Y-%m-%d").to_string()),
        }
    }

    /// 分配一个**不存在的**日志文件（new_file_per_session 模式）：
    /// 目标路径已存在时依次尝试 `name-1.log`、`name-2.log`…（数字后缀插在
    /// 扩展名前）。`create_new(true)` 原子保证并发/重入下也不会续写已有文件。
    fn open_new_log_file(&self, base: &std::path::Path) -> anyhow::Result<(PathBuf, fs::File)> {
        for n in 0.. {
            let candidate = if n == 0 {
                base.to_path_buf()
            } else {
                let stem = base
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("log");
                let ext = base
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("log");
                base.with_file_name(format!("{stem}-{n}.{ext}"))
            };
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&candidate)
            {
                Ok(file) => return Ok((candidate, file)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        unreachable!("suffix loop is unbounded")
    }

    /// 为指定串口创建日志写入器（使用默认 encoding）
    pub fn create_writer(&mut self, port_id: &str, format: &str) -> anyhow::Result<()> {
        let encoding = self.default_encoding.clone();
        self.create_writer_with_encoding(port_id, format, &encoding)
    }

    /// 为指定串口创建带显式 encoding 的写入器
    pub fn create_writer_with_encoding(
        &mut self,
        port_id: &str,
        format: &str,
        encoding: &str,
    ) -> anyhow::Result<()> {
        self.create_writer_inner(port_id, format, encoding, false)
    }

    /// 分片续片专用：**总是**分配新文件（唯一化），与 new_file_per_session 开关
    /// 无关——分片的语义就是新文件。若沿用 append 重开刚关闭的同名文件（粗粒度
    /// 模板如 `[com]`/`[com]-[date]` 时 format_filename 恒同名），current_size 会从
    /// 已超阈值的大小初始化，之后每次写入都触发 split，形成无限分片循环。
    fn create_split_writer(
        &mut self,
        port_id: &str,
        format: &str,
        encoding: &str,
    ) -> anyhow::Result<()> {
        self.create_writer_inner(port_id, format, encoding, true)
    }

    /// create_writer 内部实现。`force_new_file`：分片续片强制唯一化；
    /// 否则按 new_file_per_session 开关决定（续写 vs create_new 唯一化）。
    fn create_writer_inner(
        &mut self,
        port_id: &str,
        format: &str,
        encoding: &str,
        force_new_file: bool,
    ) -> anyhow::Result<()> {
        let filename = self.format_filename(port_id);
        // issue #5-10：按子目录策略解析目标目录（none → 根目录；date/port → 子目录）
        let file_path = match self.subdir_component(port_id) {
            Some(sub) => {
                let sub_dir = self.log_directory.join(&sub);
                fs::create_dir_all(&sub_dir)?;
                sub_dir.join(format!("{}.log", filename))
            }
            None => self.log_directory.join(format!("{}.log", filename)),
        };

        // 文件分配策略：默认（续写）append 打开、current_size 从已有文件大小
        // 初始化（分片阈值对续写文件准确）；new_file_per_session 开启时每次
        // create_writer 都分配一个**不存在**的新文件（同名冲突追加 -1/-2… 后缀，
        // create_new 原子保证绝不续写）——「每次打开串口日志存入新文件」。
        let (file_path, file, existing_size) = if force_new_file || self.new_file_per_session {
            let (path, file) = self.open_new_log_file(&file_path)?;
            (path, file, 0)
        } else {
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file_path)?;
            // 追加模式下从已有文件大小初始化 current_size，使分片阈值对续写文件准确。
            let existing_size = file.metadata()?.len();
            (file_path, file, existing_size)
        };

        let writer = PortLogWriter {
            file_path: file_path.clone(),
            writer: BufWriter::new(file),
            current_size: existing_size,
            format: format.to_string(),
            encoding: encoding.to_string(),
            include_timestamp: self.include_timestamp,
            include_direction: self.include_direction,
            assembler: LogLineAssembler::new(),
            rx_pending_since: None,
        };

        self.writers.insert(port_id.to_string(), writer);
        log::info!(
            "Log writer created for {} at {:?} (encoding={})",
            port_id,
            file_path,
            encoding
        );
        Ok(())
    }

    /// 写入日志。自动短路：auto_save=false 或 port_id 无 writer 时直接返回 Ok。
    /// 单字段同步：避免前端 / 后端状态漂移导致的写入泄漏（defects #53）。
    /// TX / 直接写入走这里——每次调用自成一行，不参与行聚合。
    pub fn write(
        &mut self,
        port_id: &str,
        timestamp: &str,
        direction: &str,
        data: &[u8],
    ) -> anyhow::Result<()> {
        if !self.auto_save {
            return Ok(());
        }
        if let Some(writer) = self.writers.get_mut(port_id) {
            writer.write_line(timestamp, direction, data)?;
        }
        // 分片检查与滚动（write / write_rx 共用，issue #5-9 提取）
        self.maybe_split_writer(port_id)?;

        // 周期性刷盘：每 5 秒 flush 所有活跃 writer，防止崩溃丢失最后一批数据。
        // 仅 flush BufWriter，不做 sync_all（性能考量）。
        self.periodic_flush();

        Ok(())
    }

    /// 写入 RX 日志（issue #5-9）——字节级行聚合。
    ///
    /// 串口读事件按 ≤1024B/次切分、与行边界无关：一次设备响应可能横跨多个
    /// serial:data 事件，一个事件里也可能有多行。旧路径「一事件一行」会把
    /// 跨事件的响应切成碎片行（首字符独占一行）。本方法把事件字节喂进该端口
    /// 的 LogLineAssembler，只有聚合完成的完整行才经 write_line（方向固定
    /// "RX"）落盘，与终端侧 rxAssembler 语义逐字节对齐。
    ///
    /// 若尾部滞留超过 250ms（自其首字节驻留起算），下一个事件到来时先把
    /// 尾部冲刷为一行，保证长时间停顿的半行不会无限滞留（对齐前端 250ms
    /// 静默 flush 的意图；时间戳沿用当前事件时间）。
    pub fn write_rx(
        &mut self,
        port_id: &str,
        timestamp: &str,
        data: &[u8],
    ) -> anyhow::Result<()> {
        if !self.auto_save {
            return Ok(());
        }
        if let Some(writer) = self.writers.get_mut(port_id) {
            // 1. 机会性静默冲刷：尾部滞留 ≥250ms → 先成行落盘
            writer.flush_stale_rx_tail(timestamp)?;
            // 2. 聚合新字节：完整行逐行落盘（方向固定 RX）
            let lines = writer.assembler.feed(data);
            for line in lines {
                writer.write_line(timestamp, "RX", &line)?;
            }
            // 3. 维护尾部驻留计时（pending 空→非空置位；清空复位）
            writer.update_rx_pending_since();
        }
        self.maybe_split_writer(port_id)?;
        self.periodic_flush();
        Ok(())
    }

    /// 分片检查与滚动（write / write_rx 共用）：当前 writer 达阈值时
    /// 显式 flush + sync_all 后重建新文件 writer，保证续写分片准确
    /// (defects #56：避免依赖 BufWriter::Drop 的 flush 把错误吞掉)。
    fn maybe_split_writer(&mut self, port_id: &str) -> anyhow::Result<()> {
        let needs_split = self
            .writers
            .get(port_id)
            .map(|w| self.split_enabled && w.should_split(self.split_size_mb))
            .unwrap_or(false);
        if !needs_split {
            return Ok(());
        }
        let (format, encoding, old_path) = match self.writers.get(port_id) {
            Some(w) => (w.format.clone(), w.encoding.clone(), w.file_path.clone()),
            None => return Ok(()),
        };
        let Some(removed) = self.writers.remove(port_id) else {
            return Ok(());
        };
        match removed.writer.into_inner() {
            Ok(file) => {
                if let Err(e) = file.sync_all() {
                    log::warn!("Log split sync_all failed for {}: {}", port_id, e);
                }
            }
            Err(e) => log::warn!("Log split into_inner failed for {}: {}", port_id, e),
        }
        log::info!(
            "Log split: {} closed at {} bytes",
            port_id,
            old_path.display()
        );
        self.create_split_writer(port_id, &format, &encoding)?;
        log::info!("Log split: new file created for {}", port_id);
        Ok(())
    }

    /// 周期性刷盘：每 5 秒 flush 所有活跃 writer，防止崩溃丢失最后一批数据。
    /// 仅 flush BufWriter，不做 sync_all（性能考量）。
    fn periodic_flush(&mut self) {
        if self.last_flush.elapsed() >= std::time::Duration::from_secs(5) {
            let _ = self.flush_all_internal();
            self.last_flush = std::time::Instant::now();
        }
    }

    /// 关闭串口日志
    pub fn close_writer(&mut self, port_id: &str) -> anyhow::Result<()> {
        if let Some(mut writer) = self.writers.remove(port_id) {
            // issue #5-9：关闭前先把未终结的 RX 尾部作为最后一行冲刷落盘，
            // 避免半行数据在关闭瞬间被丢弃（时间戳取当前时间，无事件可参考）。
            let now = chrono::Local::now()
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string();
            if let Err(e) = writer.flush_rx_tail(&now) {
                log::warn!("Log RX tail flush failed for {}: {}", port_id, e);
            }
            writer.writer.flush()?;
            // flush 后再 sync_all，确保 OS 把缓冲落盘（defects #56 同类）
            if let Ok(file) = writer.writer.get_ref().try_clone() {
                if let Err(e) = file.sync_all() {
                    log::warn!("Log close sync_all failed for {}: {}", port_id, e);
                }
            }
            // 空日志不落盘（issue：日志文件大量空日志）——连接后没有任何数据
            // 写入会话（0 字节文件）直接把文件删掉，不给磁盘留空文件。
            if writer.current_size == 0 {
                if let Ok(meta) = std::fs::metadata(&writer.file_path) {
                    if meta.len() == 0 {
                        match std::fs::remove_file(&writer.file_path) {
                            Ok(()) => log::info!(
                                "Log writer closed for {} (empty, file removed)",
                                port_id
                            ),
                            Err(e) => log::warn!(
                                "Failed to remove empty log file for {}: {}",
                                port_id,
                                e
                            ),
                        }
                        return Ok(());
                    }
                }
            }
            log::info!("Log writer closed for {}", port_id);
        }
        Ok(())
    }

    /// 强制刷新所有活跃日志写入器到磁盘。
    /// 在 panic hook 中调用，避免崩溃前丢失最后一批日志。
    pub fn flush_all(&mut self) -> anyhow::Result<()> {
        for (port_id, writer) in self.writers.iter_mut() {
            if let Err(e) = writer.writer.flush() {
                log::warn!("Failed to flush log writer for {}: {}", port_id, e);
            }
            if let Ok(file) = writer.writer.get_ref().try_clone() {
                if let Err(e) = file.sync_all() {
                    log::warn!("Failed to sync log file for {}: {}", port_id, e);
                }
            }
        }
        Ok(())
    }

    /// 内部周期刷盘：仅 flush BufWriter 缓冲，不做 sync_all（性能优先）。
    /// 由 write() 每 5 秒自动调用。
    fn flush_all_internal(&mut self) -> anyhow::Result<()> {
        for (port_id, writer) in self.writers.iter_mut() {
            if let Err(e) = writer.writer.flush() {
                log::warn!("Periodic flush failed for {}: {}", port_id, e);
            }
        }
        Ok(())
    }

    /// 手动另存日志。
    /// 优先使用活跃 writer 的文件路径（精确）；无活跃 writer 时回退到
    /// 日志目录中该端口最新的日志文件（通过 list_files 的 port_id 反查）。
    pub fn save_log_as(&mut self, port_id: &str, target_path: &str) -> anyhow::Result<()> {
        // 1. 活跃 writer → flush + sync 后拷贝（确保缓冲数据落盘，拷贝完整）
        if let Some(writer) = self.writers.get_mut(port_id) {
            writer.writer.flush()?;
            if let Ok(file) = writer.writer.get_ref().try_clone() {
                let _ = file.sync_all();
            }
            fs::copy(&writer.file_path, target_path)?;
            log::info!("Log saved from {:?} to {}", writer.file_path, target_path);
            return Ok(());
        }

        // 2. 无活跃 writer → 回退：在日志目录中查找该端口最新的日志文件
        let files = self.list_files()?;
        let best = files
            .iter()
            .filter(|f| f.port_id == port_id)
            .max_by_key(|f| f.created_at);

        if let Some(file_info) = best {
            fs::copy(&file_info.path, target_path)?;
            log::info!(
                "Log saved (fallback, no active writer) from {} to {}",
                file_info.path,
                target_path
            );
            return Ok(());
        }

        anyhow::bail!(
            "No log file found for port '{}'. Connect the port with auto-save logging enabled first.",
            port_id
        )
    }

    /// 递归收集日志根目录下的日志文件（issue #5-10：date/port 子目录模式的文件
    /// 也要出现在 UI 日志列表中）。子目录 read_dir 失败只告警跳过（防御性），
    /// 根目录 read_dir 失败仍上抛保持旧行为。
    fn collect_log_files(
        &self,
        dir: &std::path::Path,
        depth: usize,
        active_index: &HashMap<PathBuf, String>,
        files: &mut Vec<LogFileInfo>,
    ) -> anyhow::Result<()> {
        // 深度上限防御：异常深/成环的嵌套（如目录联接）不会无限递归
        if depth > MAX_LIST_DEPTH {
            log::warn!("Log subdirectory walk exceeded depth {} at {:?}", MAX_LIST_DEPTH, dir);
            return Ok(());
        }
        let entries = match fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(e) => {
                if depth > 0 {
                    log::warn!("Failed to read log subdirectory {:?}: {}", dir, e);
                    return Ok(());
                }
                return Err(e.into());
            }
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                self.collect_log_files(&path, depth + 1, active_index, files)?;
            } else if metadata.is_file() {
                let port_id = active_index.get(&path).cloned().unwrap_or_else(|| {
                    // Fallback heuristic: split filename stem on '-' and take the first segment.
                    // LIMITATION: This is unreliable for custom filename formats (e.g. "log_[com]_[date]"
                    // yields "log" instead of the port id). It only works correctly with the default
                    // "[com]-[datetime]" template. For closed writers, there is no reliable way to
                    // recover the port_id without a persistent registry (out of scope).
                    // Active writers always resolve correctly via active_index above.
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .and_then(|stem| stem.split('-').next())
                        .unwrap_or("unknown")
                        .to_string()
                });
                files.push(LogFileInfo {
                    path: path.to_string_lossy().to_string(),
                    port_id,
                    created_at: metadata
                        .created()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0),
                    size: metadata.len(),
                });
            }
        }
        Ok(())
    }

    /// 列出所有日志文件（递归遍历子目录，issue #5-10）。port_id 解析优先级：
    /// 1. 活跃 writer 的 file_path 反查（精确，独立于 filename_format）
    /// 2. 文件名按"-"切分取首段（向后兼容默认模板，但不可靠）
    pub fn list_files(&self) -> anyhow::Result<Vec<LogFileInfo>> {
        // 反向索引：file_path → port_id（活跃 writer）
        let active_index: HashMap<PathBuf, String> = self
            .writers
            .iter()
            .map(|(pid, w)| (w.file_path.clone(), pid.clone()))
            .collect();

        let mut files = Vec::new();
        if self.log_directory.exists() {
            self.collect_log_files(&self.log_directory, 0, &active_index, &mut files)?;
        }
        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hypercom_test_logs_{}", name));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn test_manager(dir: &PathBuf) -> LogManager {
        // 测试中默认开启 auto_save，否则 write() 会被短路
        LogManager {
            log_directory: dir.clone(),
            writers: HashMap::new(),
            auto_save: true,
            split_size_mb: 100,
            filename_format: "[com]-[datetime]".to_string(),
            subdir_mode: "date".to_string(),
            new_file_per_session: false,
            default_encoding: "UTF-8".to_string(),
            split_enabled: true,
            include_timestamp: true,
            include_direction: true,
            last_flush: std::time::Instant::now(),
        }
    }

    #[test]
    fn test_create_writer() {
        let dir = test_dir("create");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM3", "string").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].path.contains("COM3"));
        assert!(files[0].path.ends_with(".log"));
        mgr.close_writer("COM3").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_string_format() {
        let dir = test_dir("string");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:00", "RX", b"Hello").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("Hello"));
        assert!(content.contains("10:00:00"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_prefix_toggles() {
        // issue #3-4：日志行前缀按 include_timestamp / include_direction 开关拼接

        // 仅时间戳（无方向）
        let dir = test_dir("prefix_ts");
        let mut mgr = test_manager(&dir);
        mgr.set_include_timestamp(true);
        mgr.set_include_direction(false);
        mgr.create_writer("C1", "string").unwrap();
        mgr.write("C1", "10:00:00", "RX", b"alpha").unwrap();
        mgr.close_writer("C1").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("[10:00:00] alpha"), "got: {content}");
        assert!(!content.contains("RX"), "direction must be omitted: {content}");
        let _ = fs::remove_dir_all(&dir);

        // 仅方向（无时间戳）
        let dir = test_dir("prefix_dir");
        let mut mgr = test_manager(&dir);
        mgr.set_include_timestamp(false);
        mgr.set_include_direction(true);
        mgr.create_writer("C2", "string").unwrap();
        mgr.write("C2", "10:00:00", "TX", b"beta").unwrap();
        mgr.close_writer("C2").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("TX beta"), "got: {content}");
        assert!(!content.contains("["), "timestamp must be omitted: {content}");
        let _ = fs::remove_dir_all(&dir);

        // 两者都关：纯数据行
        let dir = test_dir("prefix_none");
        let mut mgr = test_manager(&dir);
        mgr.set_include_timestamp(false);
        mgr.set_include_direction(false);
        mgr.create_writer("C3", "string").unwrap();
        mgr.write("C3", "10:00:00", "RX", b"gamma").unwrap();
        mgr.close_writer("C3").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert_eq!(content, "gamma\n", "expected bare data line: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_hex_format() {
        let dir = test_dir("hex");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "hex").unwrap();
        mgr.write("COM1", "10:00:01", "TX", &[0x48, 0x65, 0x6C, 0x6C, 0x6F])
            .unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("48 65 6C 6C 6F"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_should_split() {
        let dir = test_dir("split");
        let file_path = dir.join("split_test.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .unwrap();
        let mut writer = PortLogWriter {
            file_path: file_path.clone(),
            writer: BufWriter::new(file),
            current_size: 0,
            format: "string".into(),
            encoding: "UTF-8".into(),
            include_timestamp: true,
            include_direction: true,
            assembler: LogLineAssembler::new(),
            rx_pending_since: None,
        };
        assert!(!writer.should_split(1));
        writer.current_size = 1024 * 1024;
        assert!(writer.should_split(1));
        writer.current_size = 2 * 1024 * 1024;
        assert!(writer.should_split(1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn split_continuation_never_reopens_same_file() {
        // 回归：粗粒度模板（[com] 恒同名）+ 小分片——split 续片若 append 重开
        // 刚关闭的超阈值文件，current_size 从超阈值大小初始化，之后每次写入都
        // 触发 split（同文件无限 append + 每写必分片）。修复：续片强制唯一化，
        // 得到带 -1 后缀的新文件，后续写入不再触发 split。
        let dir = test_dir("split_new");
        let mut mgr = test_manager(&dir);
        mgr.set_filename_format("[com]");
        mgr.set_split_size(1); // 1MB 阈值
        mgr.create_writer("COM1", "string").unwrap();
        let big = vec![b'x'; 1024 * 1024 + 1]; // 超过阈值，触发第一次 split
        mgr.write("COM1", "10:00:00", "TX", &big).unwrap();
        // 循环 bug 下这两次写会各再 split 一次（文件数仍是 1，但每写必分片）
        mgr.write("COM1", "10:00:01", "TX", b"more").unwrap();
        mgr.write("COM1", "10:00:02", "TX", b"even more").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(
            files.len(),
            2,
            "split must produce exactly 2 files (no split loop), got {:?}",
            files
        );
        let names: Vec<String> = files
            .iter()
            .map(|f| {
                PathBuf::from(&f.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert!(names.contains(&"COM1.log".to_string()), "got {names:?}");
        assert!(names.contains(&"COM1-1.log".to_string()), "got {names:?}");
        // 续片文件内容独立（首个文件只含超阈值大块，续片只含后续小写）。
        // list_files 顺序不保证创建序 → 按文件名定位再读内容。
        let read_by_name = |name: &str| -> String {
            let p = files
                .iter()
                .find(|f| PathBuf::from(&f.path).file_name().unwrap() == name)
                .expect(name);
            fs::read_to_string(&p.path).unwrap()
        };
        let first = read_by_name("COM1.log");
        let second = read_by_name("COM1-1.log");
        assert!(first.contains('x'), "first file must hold the bulk data");
        assert!(
            !first.contains("more"),
            "continuation data must not leak into first file: {first}"
        );
        assert!(second.contains("more") && second.contains("even more"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_filename_format_variables() {
        let dir = test_dir("fmt");
        let mut mgr = test_manager(&dir);
        mgr.set_filename_format("[com]-[date]");
        mgr.create_writer("COM5", "string").unwrap();
        let files = mgr.list_files().unwrap();
        let name = &files[0].path;
        assert!(name.contains("COM5"), "Expected COM5 in: {}", name);
        let date_part = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert!(
            name.contains(&date_part),
            "Expected {} in: {}",
            date_part,
            name
        );
        mgr.close_writer("COM5").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_save_log_as() {
        let dir = test_dir("save");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM9", "string").unwrap();
        mgr.write("COM9", "10:00:00", "RX", b"test data").unwrap();
        let _files = mgr.list_files().unwrap();
        let target = dir.join("saved.log");
        mgr.save_log_as("COM9", &target.to_string_lossy()).unwrap();
        assert!(target.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_save_log_as_no_writer_no_files() {
        let dir = test_dir("nowriter");
        let mut mgr = test_manager(&dir);
        let result = mgr.save_log_as("NONEXIST", "/tmp/test.log");
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_save_log_as_fallback_after_writer_closed() {
        // writer 已关闭（端口断开）后，save_log_as 应回退到日志目录中查找该端口最新文件
        let dir = test_dir("fallback");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM4", "string").unwrap();
        mgr.write("COM4", "10:00:00", "RX", b"fallback data").unwrap();
        mgr.close_writer("COM4").unwrap();
        // writer 已不存在，但文件仍在日志目录中
        assert!(mgr.writers.get("COM4").is_none());
        let target = dir.join("fallback_saved.log");
        mgr.save_log_as("COM4", &target.to_string_lossy()).unwrap();
        assert!(target.exists());
        let content = fs::read_to_string(&target).unwrap();
        assert!(content.contains("fallback data"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_accumulates_to_file() {
        let dir = test_dir("accum");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00", "RX", b"line1\n").unwrap();
        mgr.write("COM1", "10:01", "RX", b"line2\n").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("line1"));
        assert!(content.contains("line2"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_auto_save_off_short_circuits_write() {
        // defects #53：auto_save=false 时 write() 必须直接返回，不写文件
        let dir = test_dir("autosave_off");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.set_auto_save(false);
        mgr.write("COM1", "10:00", "RX", b"should_not_appear\n")
            .unwrap();
        mgr.close_writer("COM1").unwrap();
        // issue：空日志不落盘 —— 没有任何数据写入（0 字节文件）在关闭时被删除，
        // 不应再出现在日志列表里（也不含被短路的数据）。
        let files = mgr.list_files().unwrap();
        assert!(
            files.is_empty(),
            "empty log file must be removed on close (auto-save off -> nothing written), got: {:?}",
            files
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_list_files_uses_writer_registry_for_port_id() {
        // defects #52：自定义文件名模板下，port_id 必须从活跃 writer 反查，
        // 而不是简单地按 "-" 切分文件名首段
        let dir = test_dir("custom_fmt");
        let mut mgr = test_manager(&dir);
        mgr.set_filename_format("log_[com]_[date]");
        mgr.create_writer("COM7", "string").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].port_id, "COM7",
            "port_id should resolve to COM7 via writer registry, not 'log_log'. Got: {}",
            files[0].port_id
        );
        mgr.close_writer("COM7").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_iso_8859_1_encoding_decodes_high_bytes() {
        // defects #49：ISO-8859-1 字节 0xE9 应解码为 'é'，而不是 U+FFFD
        let dir = test_dir("latin1");
        let mut mgr = test_manager(&dir);
        mgr.set_default_encoding("ISO-8859-1");
        mgr.create_writer("COM2", "string").unwrap();
        mgr.write("COM2", "10:00", "RX", &[b'h', b'i', 0xE9])
            .unwrap();
        mgr.close_writer("COM2").unwrap();
        let files = mgr.list_files().unwrap();
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("hi"), "expected 'hi' in: {}", content);
        assert!(
            content.contains('é') || content.contains("\u{00E9}"),
            "expected 'é' (U+00E9) in ISO-8859-1 decoded output, got: {}",
            content
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_gbk_decoding_decodes_chinese_characters() {
        // Given: common Chinese text encoded as GBK bytes.
        let (bytes, _, _) = GBK.encode("你好");

        // When: logger decodes the byte stream in GBK mode.
        let decoded = decode_gbk_lossy(&bytes);

        // Then: the readable Chinese text is preserved, not replaced by U+FFFD.
        assert_eq!(decoded, "你好");
        assert!(!decoded.contains('\u{FFFD}'));
    }
}

/// issue #5-9：RX 日志行聚合测试（LogLineAssembler + LogManager::write_rx）。
///
/// 与 serial/mod.rs 的测试约定一致：**显式导入**而非 `use super::*`——通配
/// 导入会把整个 logger 模块（及 encoding_rs 等依赖链）拖进测试二进制的链接
/// 闭包，仅按需导入被测符号，保证 Windows `cargo test` harness 可直接运行。
#[cfg(test)]
mod rx_log_tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;

    use super::{LogLineAssembler, LogManager};

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hypercom_test_rx_{}", name));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn test_manager(dir: &PathBuf) -> LogManager {
        // 测试中默认开启 auto_save，否则 write_rx() 会被短路
        LogManager {
            log_directory: dir.clone(),
            writers: HashMap::new(),
            auto_save: true,
            split_size_mb: 100,
            filename_format: "[com]-[datetime]".to_string(),
            subdir_mode: "date".to_string(),
            new_file_per_session: false,
            default_encoding: "UTF-8".to_string(),
            split_enabled: true,
            include_timestamp: true,
            include_direction: true,
            last_flush: std::time::Instant::now(),
        }
    }

    /// 读回指定端口最近日志文件的完整内容
    fn read_log(mgr: &LogManager, port_id: &str) -> String {
        let files = mgr.list_files().unwrap();
        let f = files
            .iter()
            .find(|f| f.port_id == port_id)
            .expect("log file must exist");
        fs::read_to_string(&f.path).unwrap()
    }

    fn bytes(s: &str) -> Vec<u8> {
        s.as_bytes().to_vec()
    }

    /// 显式类型的空行字节块（`vec![]` 嵌套推断在 PartialEq 上会有歧义）
    fn empty_line() -> Vec<u8> {
        Vec::new()
    }

    // ---------- LogLineAssembler：基础分隔符 ----------

    #[test]
    fn feed_empty_returns_nothing() {
        let mut asm = LogLineAssembler::new();
        assert!(asm.feed(b"").is_empty());
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_lf_terminated_line() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"hello\n"), vec![bytes("hello")]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_cr_terminated_line() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"hello\r"), vec![bytes("hello")]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_keeps_line_free_of_separator_bytes() {
        let mut asm = LogLineAssembler::new();
        let lines = asm.feed(&[0x41, 0x0a, 0x42, 0x0d]);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], vec![0x41]);
        assert!(!lines[0].contains(&0x0a));
        assert_eq!(lines[1], vec![0x42]);
    }

    #[test]
    fn feed_handles_full_binary_byte_range() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(
            asm.feed(&[0x00, 0x7f, 0x80, 0xff, 0x0a]),
            vec![vec![0x00, 0x7f, 0x80, 0xff]]
        );
    }

    // ---------- LogLineAssembler：CRLF 对处理 ----------

    #[test]
    fn feed_crlf_pair_within_one_feed_is_one_separator() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"AB\r\nCD\n"), vec![bytes("AB"), bytes("CD")]);
    }

    #[test]
    fn feed_crlf_pair_split_across_two_feeds_is_one_separator() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"AB\r"), vec![bytes("AB")]);
        // LF 是上一 feed CR 的后半：必须被静默吞掉，不能产生空行
        assert_eq!(asm.feed(b"\nCD\n"), vec![bytes("CD")]);
    }

    #[test]
    fn feed_crlf_pair_straddling_two_feeds_then_more_data() {
        // 任务要求用例：b"hel" + b"lo\r\nX" → 完成行 ["hello"]，尾部 "X"
        let mut asm = LogLineAssembler::new();
        assert!(asm.feed(b"hel").is_empty());
        assert_eq!(asm.feed(b"lo\r\nX"), vec![bytes("hello")]);
        assert!(asm.has_pending());
        assert_eq!(asm.take_tail(), Some(bytes("X")));
    }

    #[test]
    fn feed_does_not_swallow_non_lf_after_cr_across_feeds() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"X\r"), vec![bytes("X")]);
        // 下一段以 'Y' 开头：pending_cr 被清除，Y 正常进入下一行
        assert_eq!(asm.feed(b"YZ\n"), vec![bytes("YZ")]);
    }

    #[test]
    fn feed_emits_empty_line_for_bare_crlf_between_text_lines() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(
            asm.feed(b"a\r\n\r\nb\n"),
            vec![bytes("a"), empty_line(), bytes("b")]
        );
    }

    #[test]
    fn feed_clears_pending_cr_after_normal_byte() {
        let mut asm = LogLineAssembler::new();
        asm.feed(b"a\r");
        asm.feed(b"b");
        // CR 后的字节已正常处理；此时到来的 LF 是**新的**分隔符
        assert_eq!(asm.feed(b"\n"), vec![bytes("b")]);
    }

    // ---------- LogLineAssembler：连续分隔符 / 空行 ----------

    #[test]
    fn feed_emits_one_empty_chunk_per_consecutive_lf() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(
            asm.feed(b"\n\n\n"),
            vec![empty_line(), empty_line(), empty_line()]
        );
    }

    #[test]
    fn feed_emits_one_empty_chunk_per_consecutive_cr() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"\r\r"), vec![empty_line(), empty_line()]);
    }

    #[test]
    fn feed_emits_one_empty_chunk_per_crlf_pair_in_separator_only_feed() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"\r\n\r\n"), vec![empty_line(), empty_line()]);
    }

    #[test]
    fn feed_handles_interleaved_cr_lf_crlf_separators() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(
            asm.feed(b"a\rb\nc\r\nd\n"),
            vec![bytes("a"), bytes("b"), bytes("c"), bytes("d")]
        );
    }

    // ---------- LogLineAssembler：feed 边界 ----------

    #[test]
    fn feed_keeps_unterminated_tail_pending_until_next_separator() {
        let mut asm = LogLineAssembler::new();
        assert!(asm.feed(b"hel").is_empty());
        assert!(asm.has_pending());
        assert_eq!(asm.feed(b"lo\n"), vec![bytes("hello")]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_fragmented_response_matches_single_feed() {
        // issue #5-9 核心复现：跨事件的 "H" + "ello\r\n" 必须聚合成一行 "Hello"
        let mut asm = LogLineAssembler::new();
        assert!(asm.feed(b"H").is_empty());
        assert_eq!(asm.feed(b"ello\r\n"), vec![bytes("Hello")]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_byte_by_byte_matches_whole_feed() {
        let stream = b"hello\r\nworld\rend\nlast\n";
        let mut whole = LogLineAssembler::new();
        let expected = whole.feed(stream);

        let mut stepwise = LogLineAssembler::new();
        let mut collected: Vec<Vec<u8>> = Vec::new();
        for &c in stream {
            collected.extend(stepwise.feed(&[c]));
        }

        assert_eq!(collected, expected);
        assert_eq!(
            collected,
            vec![bytes("hello"), bytes("world"), bytes("end"), bytes("last")]
        );
    }

    #[test]
    fn feed_handles_split_at_every_byte_of_lf_stream() {
        let stream = b"ab\ncd\n";
        for split_at in 0..=stream.len() {
            let mut asm = LogLineAssembler::new();
            let mut out: Vec<Vec<u8>> = Vec::new();
            out.extend(asm.feed(&stream[..split_at]));
            out.extend(asm.feed(&stream[split_at..]));
            assert_eq!(out, vec![bytes("ab"), bytes("cd")], "split at {split_at}");
        }
    }

    #[test]
    fn feed_handles_split_at_every_byte_of_crlf_stream() {
        let stream = b"ab\r\ncd\r\n";
        for split_at in 0..=stream.len() {
            let mut asm = LogLineAssembler::new();
            let mut out: Vec<Vec<u8>> = Vec::new();
            out.extend(asm.feed(&stream[..split_at]));
            out.extend(asm.feed(&stream[split_at..]));
            assert_eq!(out, vec![bytes("ab"), bytes("cd")], "split at {split_at}");
        }
    }

    #[test]
    fn feed_returns_independent_line_buffers() {
        let mut asm = LogLineAssembler::new();
        let input = bytes("ab\ncd\n");
        let lines = asm.feed(&input);
        assert_eq!(lines, vec![bytes("ab"), bytes("cd")]);
        // 输入未被修改；返回块是独立分配
        assert_eq!(input, bytes("ab\ncd\n"));
    }

    // ---------- LogLineAssembler：强制发射 ----------

    #[test]
    fn feed_force_flushes_at_custom_threshold_without_separator() {
        let mut asm = LogLineAssembler::with_max_pending(4);
        assert_eq!(asm.feed(&[1, 2, 3, 4]), vec![vec![1, 2, 3, 4]]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_emits_multiple_force_flush_chunks_on_long_separator_less_stream() {
        let mut asm = LogLineAssembler::with_max_pending(4);
        // 注意避开 10 (0x0A=LF) / 13 (0x0D=CR)——它们是分隔符
        assert_eq!(
            asm.feed(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 11]),
            vec![vec![1, 2, 3, 4], vec![5, 6, 7, 8]]
        );
        assert_eq!(asm.take_tail(), Some(vec![9, 11]));
    }

    #[test]
    fn feed_continues_scanning_after_mid_feed_force_flush() {
        let mut asm = LogLineAssembler::with_max_pending(4);
        // 4 字节强制发射，随后 5|LF、6 7|CRLF 正常按行切
        assert_eq!(
            asm.feed(&[1, 2, 3, 4, 5, 0x0a, 6, 7, 0x0d, 0x0a]),
            vec![vec![1, 2, 3, 4], vec![5], vec![6, 7]]
        );
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_resumes_normal_accumulation_after_force_flush() {
        let mut asm = LogLineAssembler::with_max_pending(3);
        assert_eq!(asm.feed(&[1, 2, 3, 4, 0x0a]), vec![vec![1, 2, 3], vec![4]]);
    }

    #[test]
    fn feed_uses_default_4096_threshold() {
        let mut asm = LogLineAssembler::new();
        let bulk = vec![0x61u8; 4096];
        assert_eq!(asm.feed(&bulk), vec![vec![0x61u8; 4096]]);
        // 再多 1 字节不会触发第二次发射（未达阈值），留在 pending
        assert!(asm.feed(&[0x62]).is_empty());
        assert_eq!(asm.take_tail(), Some(vec![0x62]));
    }

    // ---------- LogLineAssembler：take_tail / reset ----------

    #[test]
    fn take_tail_returns_pending_bytes() {
        let mut asm = LogLineAssembler::new();
        asm.feed(b"partial");
        assert_eq!(asm.take_tail(), Some(bytes("partial")));
        assert!(!asm.has_pending());
    }

    #[test]
    fn take_tail_returns_none_when_nothing_pending() {
        let mut asm = LogLineAssembler::new();
        asm.feed(b"done\n");
        assert_eq!(asm.take_tail(), None);
    }

    #[test]
    fn take_tail_resets_state_so_next_feed_starts_fresh_line() {
        let mut asm = LogLineAssembler::new();
        asm.feed(b"old");
        assert!(asm.take_tail().is_some());
        assert_eq!(asm.feed(b"new\n"), vec![bytes("new")]);
    }

    #[test]
    fn take_tail_clears_pending_cr_so_following_lf_is_real_separator() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"a\r"), vec![bytes("a")]);
        asm.take_tail(); // 清除 pending_cr
        // LF 不再是「CRLF 后半」，而是新行的分隔符 → 发射空行
        assert_eq!(asm.feed(b"\n"), vec![empty_line()]);
    }

    #[test]
    fn has_pending_reflects_buffer_state_across_feeds() {
        let mut asm = LogLineAssembler::new();
        assert!(!asm.has_pending());
        asm.feed(b"x");
        assert!(asm.has_pending());
        asm.feed(b"\n");
        assert!(!asm.has_pending());
    }

    #[test]
    fn reset_discards_pending_bytes_and_pending_cr_flag() {
        let mut asm = LogLineAssembler::new();
        asm.feed(b"junk\r");
        asm.reset();
        assert!(!asm.has_pending());
        assert_eq!(asm.take_tail(), None);
        // reset 后到来的 LF 是真正的分隔符（pending_cr 已清）
        assert_eq!(asm.feed(b"\nfirst\n"), vec![empty_line(), bytes("first")]);
    }

    // ---------- LogManager::write_rx 集成 ----------

    #[test]
    fn write_rx_assembles_fragmented_response_into_single_line() {
        // issue #5-9 核心复现：跨事件的 "H" + "ello\r\n" 必须写成一行 "Hello"，
        // 而不是首字符独占一行。
        let dir = test_dir("fragmented");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write_rx("COM1", "10:00:00.000", b"H").unwrap();
        mgr.write_rx("COM1", "10:00:00.001", b"ello\r\n").unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        assert_eq!(content, "[10:00:00.001] RX Hello\n", "got: {content}");
        assert_eq!(content.lines().count(), 1, "got: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_rx_splits_multi_line_event_into_separate_lines() {
        // 一个事件里包含多行 → 每行独立落盘（字节级切行）
        let dir = test_dir("multiline");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write_rx("COM1", "10:00:00.000", b"line1\nline2\r\nline3\n")
            .unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3, "got: {content}");
        assert!(lines[0].ends_with("line1"), "got: {content}");
        assert!(lines[1].ends_with("line2"), "got: {content}");
        assert!(lines[2].ends_with("line3"), "got: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_rx_close_writer_flushes_unterminated_tail() {
        // 未终结尾部在 close_writer 时作为最后一行落盘
        let dir = test_dir("tail_close");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write_rx("COM1", "10:00:00.000", b"partial").unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        assert!(content.contains("partial"), "got: {content}");
        assert_eq!(content.lines().count(), 1, "got: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_rx_flushes_stale_tail_after_silence() {
        // 250ms 静默冲刷：尾部滞留超时后，下一个事件先把它冲刷成行
        let dir = test_dir("stale");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write_rx("COM1", "10:00:00.000", b"par").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        mgr.write_rx("COM1", "10:00:00.300", b"tial\n").unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        assert!(content.contains("par"), "got: {content}");
        assert!(content.contains("tial"), "got: {content}");
        assert!(!content.contains("partial"), "got: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_rx_respects_prefix_toggles() {
        // 前缀开关对 write_rx 生效（与 write_line 同规则，issue #3-4）
        let dir = test_dir("prefix");
        let mut mgr = test_manager(&dir);
        mgr.set_include_timestamp(false);
        mgr.set_include_direction(false);
        mgr.create_writer("C1", "string").unwrap();
        mgr.write_rx("C1", "10:00:00.000", b"bare\n").unwrap();
        mgr.close_writer("C1").unwrap();
        let content = read_log(&mgr, "C1");
        assert_eq!(content, "bare\n", "expected bare data line: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- issue：日志文件大量空日志（空行不落盘） ----------

    #[test]
    fn write_rx_skips_empty_chunks_from_consecutive_separators() {
        // 连续分隔符 / 行首行尾分隔符会产生**空块**，旧实现把它们写成空日志行
        // （"[ts] RX \n"）。修复后空块不落盘——日志只含真实内容行。
        let dir = test_dir("empty_lines");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        // 前导 \r\n（空行）+ hello + 双回车（空行）+ world + 结尾 \r\n（空行）
        mgr.write_rx("COM1", "10:00:00.000", b"\r\nhello\n\nworld\r\n").unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2, "expected only non-empty lines, got: {content:?}");
        assert!(lines[0].ends_with("hello"), "got: {content}");
        assert!(lines[1].ends_with("world"), "got: {content}");
        // 逐字节检查：无任何"只有前缀"的空白行
        for line in &lines {
            let stripped = line.trim_end();
            let without_prefix = stripped
                .strip_prefix('[')
                .and_then(|s| s.split_once("] RX"))
                .map(|(_, rest)| rest);
            assert!(
                !without_prefix.map(str::is_empty).unwrap_or(false),
                "empty log line written: {:?}",
                line
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_skips_empty_data_for_all_formats() {
        // 直写路径（TX 等）：空 data / 只含行结束符的 data 都不落盘
        let dir = test_dir("empty_write");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:00.000", "TX", b"").unwrap();
        mgr.write("COM1", "10:00:00.001", "TX", b"\r\n").unwrap();
        mgr.write("COM1", "10:00:00.002", "TX", b"real").unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        assert_eq!(content.lines().count(), 1, "got: {content}");
        assert!(content.contains("real"), "got: {content}");
        assert!(!content.contains("TX \n"), "empty TX line written: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_skips_empty_hex_data() {
        let dir = test_dir("empty_hex");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "hex").unwrap();
        mgr.write("COM1", "10:00:00.000", "TX", b"").unwrap();
        mgr.write("COM1", "10:00:00.001", "TX", &[0x48, 0x49]).unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        assert_eq!(content.lines().count(), 1, "got: {content}");
        assert!(content.contains("48 49"), "got: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn close_writer_removes_zero_byte_log_file() {
        // 连接后无任何数据（0 字节文件）→ 关闭时删除，不给磁盘留空日志文件
        let dir = test_dir("remove_empty");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        assert!(
            files.is_empty(),
            "empty log file should be removed on close, got: {:?}",
            files
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn close_writer_keeps_file_that_has_data() {
        let dir = test_dir("keep_data");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:00.000", "TX", b"data").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1, "file with data must be kept, got: {:?}", files);
        let _ = fs::remove_dir_all(&dir);
    }
}

/// issue #5-10：日志子目录模式测试（none/date/port 路径构建 + list_files 递归）。
///
/// 显式导入（与 rx_log_tests 同约定，不用 `use super::*`），保证 FFI-free、
/// Windows `cargo test` 可运行。
#[cfg(test)]
mod subdir_tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;

    use super::LogManager;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hypercom_test_subdir_{}", name));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn test_manager(dir: &PathBuf) -> LogManager {
        LogManager {
            log_directory: dir.clone(),
            writers: HashMap::new(),
            auto_save: true,
            split_size_mb: 100,
            filename_format: "[com]-[datetime]".to_string(),
            subdir_mode: "date".to_string(),
            new_file_per_session: false,
            default_encoding: "UTF-8".to_string(),
            split_enabled: true,
            include_timestamp: true,
            include_direction: true,
            last_flush: std::time::Instant::now(),
        }
    }

    /// 断言日志文件位于 `root/<expected_sub>/` 直接子目录下，且端口名能正确反查
    fn assert_in_subdir(mgr: &LogManager, root: &PathBuf, expected_sub: &str, port_id: &str) {
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1, "expected exactly 1 log file, got {:?}", files);
        let p = PathBuf::from(&files[0].path);
        let parent = p.parent().expect("log file must have a parent dir");
        assert_eq!(
            parent,
            root.join(expected_sub),
            "log file must live in subdir '{}', got parent {:?}",
            expected_sub,
            parent
        );
        assert!(root.join(expected_sub).is_dir(), "subdir must exist on disk");
        assert_eq!(files[0].port_id, port_id, "port_id must resolve via active writer");
    }

    #[test]
    fn date_mode_writes_into_dated_subdir() {
        // date 模式：子目录 = 当前日期 %Y-%m-%d
        let dir = test_dir("date");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM3", "string").unwrap();
        let expected = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_in_subdir(&mgr, &dir, &expected, "COM3");
        mgr.close_writer("COM3").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn port_mode_writes_into_sanitized_port_subdir() {
        // port 模式：子目录 = 净化后的 port_id
        let dir = test_dir("port");
        let mut mgr = test_manager(&dir);
        mgr.set_subdir_mode("port");
        mgr.create_writer("COM7", "string").unwrap();
        assert_in_subdir(&mgr, &dir, "COM7", "COM7");
        mgr.close_writer("COM7").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn port_mode_sanitizes_hostile_port_id() {
        // 恶意 port_id 不能逃逸日志目录：路径分隔符与 ".." 被替换为 '_'
        let dir = test_dir("port_hostile");
        let mut mgr = test_manager(&dir);
        mgr.set_subdir_mode("port");
        mgr.create_writer("COM9\\..\\evil", "string").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1, "got: {:?}", files);
        let p = PathBuf::from(&files[0].path);
        assert!(
            p.starts_with(&dir),
            "log file must stay inside log dir, got: {}",
            p.display()
        );
        let parent = p.parent().unwrap();
        // 净化后子目录是根目录的直接子级，不含路径分隔符
        assert_eq!(parent.parent().unwrap(), dir.as_path());
        assert!(
            !parent.file_name().unwrap().to_str().unwrap().contains(['\\', '/']),
            "subdir name must not contain path separators: {:?}",
            parent
        );
        // 根目录下不应出现逃逸文件
        let root_entries = fs::read_dir(&dir).unwrap().collect::<Vec<_>>();
        assert_eq!(root_entries.len(), 1, "root must contain only the subdir, got {:?}", root_entries);
        mgr.close_writer("COM9\\..\\evil").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn none_mode_writes_flat_into_log_dir() {
        // none 模式：文件直接写入日志根目录
        let dir = test_dir("none");
        let mut mgr = test_manager(&dir);
        mgr.set_subdir_mode("none");
        mgr.create_writer("COM2", "string").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        let p = PathBuf::from(&files[0].path);
        assert_eq!(p.parent().unwrap(), dir.as_path(), "must be flat in log dir");
        mgr.close_writer("COM2").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_mode_falls_back_to_date_subdir() {
        // 未知模式按默认 date 收敛（与配置端 validate_and_clamp 一致）
        let dir = test_dir("invalid");
        let mut mgr = test_manager(&dir);
        mgr.set_subdir_mode("monthly");
        mgr.create_writer("COM5", "string").unwrap();
        let expected = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_in_subdir(&mgr, &dir, &expected, "COM5");
        mgr.close_writer("COM5").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_files_recurses_into_nested_subdirs() {
        // list_files 必须递归：根目录 + 一层子目录 + 二层嵌套的文件都要列出
        let dir = test_dir("recursive");
        let mgr = test_manager(&dir);
        fs::create_dir_all(dir.join("2026-08-01")).unwrap();
        fs::create_dir_all(dir.join("2026-08-01").join("nested")).unwrap();
        fs::write(dir.join("root.log"), b"root").unwrap();
        fs::write(dir.join("2026-08-01").join("a.log"), b"a").unwrap();
        fs::write(dir.join("2026-08-01").join("nested").join("b.log"), b"b").unwrap();

        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 3, "all files in subdirs must be listed, got: {:?}", files);
        assert!(files.iter().any(|f| f.path.ends_with("root.log")), "got: {:?}", files);
        assert!(files.iter().any(|f| f.path.ends_with("a.log")), "got: {:?}", files);
        assert!(files.iter().any(|f| f.path.ends_with("b.log")), "got: {:?}", files);
        // 无活跃 writer 时 port_id 走文件名反查启发式
        let a = files.iter().find(|f| f.path.ends_with("a.log")).unwrap();
        assert_eq!(a.port_id, "a", "fallback heuristic should split on '-', got: {}", a.port_id);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_log_as_fallback_finds_file_in_date_subdir() {
        // writer 关闭后，save_log_as 的回退路径必须能通过递归 list_files
        // 找到子目录中的日志（date 模式，默认模板 [com]-[datetime]）
        let dir = test_dir("save_subdir");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM4", "string").unwrap();
        mgr.write("COM4", "10:00:00", "RX", b"fallback data").unwrap();
        mgr.close_writer("COM4").unwrap();
        assert!(mgr.writers.get("COM4").is_none());
        let target = dir.join("saved.log");
        mgr.save_log_as("COM4", &target.to_string_lossy()).unwrap();
        assert!(target.exists());
        let content = fs::read_to_string(&target).unwrap();
        assert!(content.contains("fallback data"));
        let _ = fs::remove_dir_all(&dir);
    }
}

/// issue：每次打开串口新建日志文件（不续写已有文件）测试。
///
/// 显式导入（与 rx_log_tests / subdir_tests 同约定），FFI-free，Windows cargo test 可运行。
#[cfg(test)]
mod session_file_tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;

    use super::LogManager;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hypercom_test_session_file_{}", name));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn test_manager(dir: &PathBuf) -> LogManager {
        // 固定文件名模板 [com]：同一端口每次 create_writer 同名，冲突路径确定。
        LogManager {
            log_directory: dir.clone(),
            writers: HashMap::new(),
            auto_save: true,
            split_size_mb: 100,
            filename_format: "[com]".to_string(),
            subdir_mode: "none".to_string(),
            new_file_per_session: false,
            default_encoding: "UTF-8".to_string(),
            split_enabled: true,
            include_timestamp: true,
            include_direction: true,
            last_flush: std::time::Instant::now(),
        }
    }

    #[test]
    fn default_appends_existing_file_on_reopen() {
        // 默认行为（配置项关闭）：同名冲突续写同一文件——重开端口不丢历史。
        let dir = test_dir("append");
        let mut mgr = test_manager(&dir);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:00", "TX", b"first").unwrap();
        mgr.close_writer("COM1").unwrap();
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:01", "TX", b"second").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1, "default must append, got {:?}", files);
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("first") && content.contains("second"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_file_per_session_never_appends() {
        // 开启后：每次 create_writer 都分配新文件（同名冲突 → -1/-2… 后缀），
        // 每次连接都从空文件开始，内容互不混入。
        let dir = test_dir("new_each");
        let mut mgr = test_manager(&dir);
        mgr.set_new_file_per_session(true);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:00", "TX", b"first").unwrap();
        mgr.close_writer("COM1").unwrap();
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:01", "TX", b"second").unwrap();
        mgr.close_writer("COM1").unwrap();
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:02", "TX", b"third").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 3, "each open must get its own file, got {:?}", files);
        let mut contents: Vec<String> = files
            .iter()
            .map(|f| fs::read_to_string(&f.path).unwrap())
            .collect();
        contents.sort();
        assert_eq!(
            contents,
            vec![
                "[10:00:00] TX first\n".to_string(),
                "[10:00:01] TX second\n".to_string(),
                "[10:00:02] TX third\n".to_string(),
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_file_mode_file_names_get_suffix() {
        // 文件名后缀语义：首个用原名，之后 -1、-2…（数字插在扩展名前）。
        // 每会话写数据后再关闭——close_writer 会删除空文件，不写数据文件
        // 不落盘（空日志不落盘设计），同名冲突就永远不会发生。
        let dir = test_dir("suffix");
        let mut mgr = test_manager(&dir);
        mgr.set_new_file_per_session(true);
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:00", "TX", b"one").unwrap();
        let first = mgr.writers.get("COM1").unwrap().file_path.clone();
        mgr.close_writer("COM1").unwrap();
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:01", "TX", b"two").unwrap();
        let second = mgr.writers.get("COM1").unwrap().file_path.clone();
        mgr.close_writer("COM1").unwrap();
        mgr.create_writer("COM1", "string").unwrap();
        mgr.write("COM1", "10:00:02", "TX", b"three").unwrap();
        let third = mgr.writers.get("COM1").unwrap().file_path.clone();
        mgr.close_writer("COM1").unwrap();
        assert_eq!(first.file_name().unwrap(), "COM1.log");
        assert_eq!(second.file_name().unwrap(), "COM1-1.log");
        assert_eq!(third.file_name().unwrap(), "COM1-2.log");
        let _ = fs::remove_dir_all(&dir);
    }
}
