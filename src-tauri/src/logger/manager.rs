/**
 * LogManager —— 日志子系统的对外门面。
 *
 * 锁设计（S-B5 的根因修复）：
 * - 设置是 `RwLock<Arc<LogSettings>>` 快照：写路径读设置只付一次引用计数，
 *   不克隆字符串；改设置整体换一份新快照，读写不会撕裂。
 * - 每端口一把 writer 锁（`Mutex<PortLogWriter>`）：写 / RX 路径只持目标端口的锁，
 *   高波特率端口的落盘不会阻塞其它端口。
 * - 目录遍历（`list_files` 递归 `read_dir`）与文件拷贝（`save_log_as` 的 `fs::copy`）
 *   都不在任何 writer 锁内执行——旧实现把它们放在单一全局 Mutex 里，另存一个大文件
 *   会把整个日志子系统（含所有端口的写入）堵住。为此 `list_files` 的端口反查只读
 *   会话登记表（writer 每次分配/滚动文件时登记），一个 writer 锁都不碰。
 * - 锁顺序：先 writers 表锁（只做快照/插入，随即释放）→ 再端口锁。任何路径都不在
 *   持有端口锁时去抢表锁（`writer_snapshot` 先复制 Arc 再逐个加锁），因此不会死锁。
 * - 全部取锁走 mod 级 `lock_mutex` / `read_lock` / `write_lock`：日志子系统的职责是
 *   「尽力落盘」，因为别的线程 panic 而让后续写入连锁 panic（std 的 poison 传染）
 *   正好与这个职责相反。
 */

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use super::settings::LogSettings;
use super::writer::{PortLogWriter, WriterSpec};
use super::{lock_mutex, read_lock, write_lock, LogFileInfo};

/// 周期刷盘间隔：崩溃时最多丢 5 秒数据（只 flush 不做 sync_all，性能优先）
const FLUSH_INTERVAL: Duration = Duration::from_secs(5);

/// list_files 递归下钻深度上限：防御目录联接成环导致无限递归
const MAX_LIST_DEPTH: usize = 16;

pub struct LogManager {
    /// 当前设置快照（K3：日志设置的唯一来源）
    settings: RwLock<Arc<LogSettings>>,
    /// 活跃 writer，按端口索引；每端口一把独立的锁
    writers: Mutex<HashMap<String, Arc<Mutex<PortLogWriter>>>>,
    /// 会话内登记表 `path → port_id`：writer 每次分配新文件（创建 / 分片 / 换目录）时
    /// 登记，关闭、被替换、滚动后旧文件也留在表里。
    /// 没有它，list_files 只能靠「文件名按 '-' 切首段」猜端口，自定义模板下必错；
    /// 有了它，列举日志文件完全不需要碰 writer 锁。
    session_paths: Mutex<HashMap<PathBuf, String>>,
    /// 上次周期刷盘时刻
    last_flush: Mutex<Instant>,
}

impl LogManager {
    pub fn new() -> Self {
        let settings = LogSettings::default();
        // 目录创建失败不致命：写路径会在每次分配文件时重试 create_dir_all 并上报错误
        if let Err(e) = fs::create_dir_all(&settings.directory) {
            log::error!(
                "Failed to create log directory {}: {e}. 写路径会自行重试创建。",
                settings.directory
            );
        }
        Self::with_settings(settings)
    }

    fn with_settings(settings: LogSettings) -> Self {
        Self {
            settings: RwLock::new(Arc::new(settings)),
            writers: Mutex::new(HashMap::new()),
            session_paths: Mutex::new(HashMap::new()),
            last_flush: Mutex::new(Instant::now()),
        }
    }

    /// 当前设置快照
    fn settings(&self) -> Arc<LogSettings> {
        read_lock(&self.settings).clone()
    }

    /// 应用一份完整设置——配置侧（AppState 构造 / set_config）唯一入口（K3）。
    ///
    /// - `directory` 为空表示「沿用当前目录」：首次启动 config.json 未填时，不得把
    ///   默认目录覆盖成空路径；
    /// - `encoding` / 前缀开关 / `new_file_per_session` 只影响**新建**的 writer，
    ///   已打开的文件不换编码——否则同一个文件里会混入两种编码的字节；
    /// - 换目录会显式收尾活动 writer 并在新根下重解析重开（见 set_directory）。
    pub fn apply_settings(&self, settings: &LogSettings) {
        let previous = self.settings();
        let mut next = settings.clone();
        if next.directory.is_empty() {
            next.directory = previous.directory.clone();
        }
        let directory_changed = next.directory != previous.directory;
        // 先落快照（含新的命名参数 / new_file_per_session），换目录时按新命名重开
        *write_lock(&self.settings) = Arc::new(next.clone());

        if directory_changed {
            if let Err(e) = self.set_directory(next.directory.clone()) {
                // 目标根不可用：把快照目录回滚，让 UI 与实际写入位置保持一致
                // （否则又是「UI 列 A、实际写 B」）。
                let mut reverted = (*self.settings()).clone();
                reverted.directory = previous.directory.clone();
                *write_lock(&self.settings) = Arc::new(reverted);
                log::error!(
                    "Failed to switch log directory to {}: {e}; 保持 {}",
                    next.directory,
                    previous.directory
                );
            }
        }
    }

    /// 当前日志根目录
    pub fn get_directory(&self) -> PathBuf {
        PathBuf::from(&self.settings().directory)
    }

    /// 切换日志根目录。活动 writer 先显式 flush + sync 旧文件，再在新根下按同一策略
    /// 重新解析并重开文件（S-B4）——否则 UI 列的是新目录、实际却继续写旧目录的文件。
    /// 幂等：已经在新根下的 writer 不动，重复调用无副作用。
    ///
    /// 为什么不是「拒绝在活动 writer 存在时切换」：前端换目录的流程是
    /// migrate_log_directory（先把 .log 搬到新目录）→ set_config（再切目录）。
    /// 若这里拒绝，用户会看到「文件已经搬走了但目录没换」的撕裂状态，比重开文件更糟。
    pub fn set_directory(&self, path: String) -> anyhow::Result<()> {
        let new_root = PathBuf::from(path);
        // 根不可用就整个失败（调用方 apply_settings 会把快照目录回滚），
        // 绝不留下「快照指向新目录、写入还在旧目录」的半迁移状态。
        fs::create_dir_all(&new_root)?;
        let mut next = (*self.settings()).clone();
        next.directory = new_root.to_string_lossy().into_owned();
        *write_lock(&self.settings) = Arc::new(next);
        self.reopen_writers_under(&new_root);
        Ok(())
    }

    /// 把活动 writer 迁到新根：逐个端口 flush 旧文件 → 在新根下重开 → 登记新旧路径。
    /// 单个端口重开失败只记录错误并保留旧 writer（端口继续落盘，不会静默）。
    fn reopen_writers_under(&self, root: &Path) {
        let settings = self.settings();
        for (port_id, handle) in self.writer_snapshot() {
            let mut writer = lock_mutex(&handle);
            let old_path = writer.file_path().to_path_buf();
            // 已经在新根下的 writer 不动（幂等）：注意切到**父目录**（如
            // C:/logs/2026 → C:/logs）时旧文件本来就在新根内，继续写它即可，
            // list_files 扫新根仍能列出，不需要制造新的文件。
            if old_path.starts_with(root) {
                continue;
            }
            let spec = writer.spec().with_current_naming(&settings);
            let force_new_file = spec.new_file_per_session;
            match writer.rotate(&spec, root, &port_id, force_new_file) {
                Ok(()) => {
                    let new_path = writer.file_path().to_path_buf();
                    drop(writer);
                    log::info!("Log directory switched for {old_path:?} → {new_path:?}");
                    self.register_path(new_path, &port_id);
                    self.register_path(old_path, &port_id);
                }
                Err(e) => log::error!(
                    "Log directory switch failed for {port_id}: {e}; 继续写入 {old_path:?}"
                ),
            }
        }
    }

    /// 为指定串口创建日志写入器（格式/编码由调用方按端口传入，见 start_logging）
    pub fn create_writer_with_encoding(
        &self,
        port_id: &str,
        format: &str,
        encoding: &str,
    ) -> anyhow::Result<()> {
        self.create_writer_inner(port_id, format, encoding, false)
    }

    fn create_writer_inner(
        &self,
        port_id: &str,
        format: &str,
        encoding: &str,
        force_new_file: bool,
    ) -> anyhow::Result<()> {
        let settings = self.settings();
        let spec = WriterSpec::from_settings(&settings, format, encoding);
        let writer = PortLogWriter::open(&spec, Path::new(&settings.directory), port_id, force_new_file)?;
        let path = writer.file_path().to_path_buf();
        self.register_path(path.clone(), port_id);
        let replaced = lock_mutex(&self.writers).insert(port_id.to_string(), Arc::new(Mutex::new(writer)));
        log::info!("Log writer created for {port_id} at {path:?} (encoding={encoding})");

        // 覆盖已有 writer：显式 flush + sync 旧文件后收尾（S-B2）。不能依赖
        // BufWriter::Drop 的隐式 flush——Drop 里的错误只能被丢弃，而且旧文件在被替换
        // 的那一刻是否完整是调用方（另存/列举）能观察到的。
        if let Some(old) = replaced {
            let (old_path, old_size) = {
                let mut old = lock_mutex(&old);
                let old_path = old.file_path().to_path_buf();
                let old_size = old.current_size();
                if let Err(e) = old.flush_and_sync() {
                    log::warn!("Log final flush failed on writer replacement ({port_id}): {e}");
                }
                (old_path, old_size)
            };
            self.retire_path(old_path, port_id, old_size);
        }
        Ok(())
    }

    /// 写入一行（TX / 直接写入）：每次调用自成一行，不参与行聚合。
    /// auto_save=false 或该端口无 writer 时直接返回 Ok——日志未开不该让发送失败。
    pub fn write(
        &self,
        port_id: &str,
        timestamp: &str,
        direction: &str,
        data: &[u8],
    ) -> anyhow::Result<()> {
        if !self.settings().auto_save {
            return Ok(());
        }
        if let Some(handle) = self.writer_handle(port_id) {
            let mut writer = lock_mutex(&handle);
            writer.write_line(timestamp, direction, data)?;
            // 分片检查与滚动（write / write_rx 共用）
            self.maybe_split(&mut writer, port_id)?;
        }
        self.periodic_flush();
        Ok(())
    }

    /// 写入 RX 日志——字节级行聚合。
    ///
    /// 串口读事件按 ≤1024B/次切分、与行边界无关：一次设备响应可能横跨多个
    /// serial:data 事件，一个事件里也可能有多行。「一事件一行」会把跨事件的响应
    /// 切成碎片行（首字符独占一行）。这里把事件字节喂进该端口的 LogLineAssembler，
    /// 只有聚合完成的完整行才经 write_line（方向固定 "RX"）落盘。
    ///
    /// 尾部滞留超过 250ms（自其首字节驻留起算）时，下一个事件到来先把它冲刷成行，
    /// 保证长时间停顿的半行不会无限滞留。
    pub fn write_rx(&self, port_id: &str, timestamp: &str, data: &[u8]) -> anyhow::Result<()> {
        if !self.settings().auto_save {
            return Ok(());
        }
        if let Some(handle) = self.writer_handle(port_id) {
            let mut writer = lock_mutex(&handle);
            // 1. 机会性静默冲刷：尾部滞留 ≥250ms → 先成行落盘
            writer.flush_stale_rx_tail(timestamp)?;
            // 2. 聚合新字节：完整行逐行落盘（方向固定 RX）
            for line in writer.feed_rx(data) {
                writer.write_line(timestamp, "RX", &line)?;
            }
            // 3. 维护尾部驻留计时（pending 空→非空置位；清空复位）
            writer.update_rx_pending_since();
            self.maybe_split(&mut writer, port_id)?;
        }
        self.periodic_flush();
        Ok(())
    }

    /// 分片检查与就地滚动。失败向上传播（S-B3）：writer 内部的 rotate 已保证旧文件
    /// 原封不动，端口继续写旧文件；这里只是不再把失败当成功。
    fn maybe_split(&self, writer: &mut PortLogWriter, port_id: &str) -> anyhow::Result<()> {
        let settings = self.settings();
        if !settings.split_enabled || !writer.needs_split(settings.split_size_mb) {
            return Ok(());
        }
        let old_path = writer.file_path().to_path_buf();
        // 续片强制分配新文件：同名续写会让 current_size 从超阈值大小初始化，
        // 之后每次写入都触发分片（无限分片循环）
        let spec = writer.spec().with_current_naming(&settings);
        writer
            .rotate(&spec, Path::new(&settings.directory), port_id, true)
            .map_err(|e| {
                log::error!("Log split failed for {port_id}: {e}; 继续写入旧文件");
                e
            })?;
        log::info!("Log split for {port_id}: {old_path:?} → {:?}", writer.file_path());
        self.register_path(writer.file_path().to_path_buf(), port_id);
        self.register_path(old_path, port_id);
        Ok(())
    }

    /// 周期刷盘：每 5 秒把所有活跃 writer 的缓冲推给 OS，防止崩溃丢失最后一批数据。
    /// 先拍快照再逐个加锁——flush 是 IO，持 writers 表锁做 IO 会挡住其它端口的写路径。
    fn periodic_flush(&self) {
        {
            let mut last = lock_mutex(&self.last_flush);
            if last.elapsed() < FLUSH_INTERVAL {
                return;
            }
            *last = Instant::now();
        }
        for (port_id, handle) in self.writer_snapshot() {
            let mut writer = lock_mutex(&handle);
            if let Err(e) = writer.flush() {
                log::warn!("Periodic flush failed for {port_id}: {e}");
            }
        }
    }

    /// 强制刷新所有活跃 writer 到磁盘（flush + sync_all）。panic hook 与关闭流程调用；
    /// 任何单个端口的失败只告警，不影响其它端口。
    pub fn flush_all(&self) -> anyhow::Result<()> {
        for (port_id, handle) in self.writer_snapshot() {
            let mut writer = lock_mutex(&handle);
            if let Err(e) = writer.flush_and_sync() {
                log::warn!("Failed to sync log writer for {port_id}: {e}");
            }
        }
        Ok(())
    }

    /// 关闭串口日志
    pub fn close_writer(&self, port_id: &str) -> anyhow::Result<()> {
        let Some(handle) = lock_mutex(&self.writers).remove(port_id) else {
            return Ok(());
        };
        let mut writer = lock_mutex(&handle);
        // 关闭前先把未终结的 RX 尾部作为最后一行冲刷落盘，避免半行在关闭瞬间被丢弃
        // （时间戳取当前时间，此时没有事件时间可用）。
        let now = chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string();
        if let Err(e) = writer.flush_rx_tail(&now) {
            log::warn!("Log RX tail flush failed for {port_id}: {e}");
        }
        writer.flush_and_sync()?;
        let path = writer.file_path().to_path_buf();
        let written = writer.current_size();
        drop(writer); // 文件系统操作（删除 / 登记）在端口锁外做
        self.retire_path(path, port_id, written);
        Ok(())
    }

    /// writer 退场后的收尾：0 字节文件直接删除（不给磁盘留空日志），
    /// 有内容的文件登记进会话反查表（S-B6）。
    fn retire_path(&self, path: PathBuf, port_id: &str, written_size: u64) {
        if written_size == 0 {
            if let Ok(meta) = fs::metadata(&path) {
                if meta.len() == 0 {
                    match fs::remove_file(&path) {
                        Ok(()) => {
                            log::info!("Log writer closed for {port_id} (empty, file removed)");
                            return;
                        }
                        Err(e) => {
                            log::warn!("Failed to remove empty log file for {port_id}: {e}")
                        }
                    }
                }
            }
        }
        self.register_path(path, port_id);
        log::info!("Log writer closed for {port_id}");
    }

    /// 登记「日志文件 → 端口」的映射，供 list_files 精确反查（S-B6）。
    /// 每次分配/滚动文件时（含关闭后）登记；会话内有效——这是给 UI 列文件用的，
    /// 进程重启后本就无法知道历史文件属于哪个端口。
    fn register_path(&self, path: PathBuf, port_id: &str) {
        lock_mutex(&self.session_paths).insert(path, port_id.to_string());
    }

    /// 手动另存日志：优先用活跃 writer 的文件路径（精确）；无活跃 writer 时回退到
    /// 日志目录里该端口最新的日志文件。
    ///
    /// flush 在端口锁内（必须读缓冲），`fs::copy` 在锁外——另存一个几百 MB 的日志
    /// 不能把该端口的写路径堵住（S-B5）。代价是拷贝期间可能有新数据追加到源文件
    /// 尾部（拷贝的是「flush 那一刻之后 + 拷贝期间新增」的近似快照），这是可接受的：
    /// 阻塞落盘比多几行尾部数据严重得多。
    pub fn save_log_as(&self, port_id: &str, target_path: &str) -> anyhow::Result<()> {
        if let Some(handle) = self.writer_handle(port_id) {
            let source = {
                let mut writer = lock_mutex(&handle);
                writer.flush_and_sync()?;
                writer.file_path().to_path_buf()
            };
            fs::copy(&source, target_path)?;
            log::info!("Log saved from {source:?} to {target_path}");
            return Ok(());
        }

        // 无活跃 writer → 回退：在日志目录中查找该端口最新的日志文件
        let files = self.list_files()?;
        let best = files
            .iter()
            .filter(|f| f.port_id == port_id)
            .max_by_key(|f| f.created_at);
        let Some(file_info) = best else {
            anyhow::bail!(
                "No log file found for port '{port_id}'. Connect the port with auto-save logging enabled first."
            );
        };
        fs::copy(&file_info.path, target_path)?;
        log::info!(
            "Log saved (fallback, no active writer) from {} to {target_path}",
            file_info.path
        );
        Ok(())
    }

    /// 列出日志根目录（递归子目录）下的日志文件。port_id 解析优先级：
    /// 1) 会话登记表（writer 创建 / 分片 / 换目录时登记，关闭后仍有效，S-B6）
    /// 2) 文件名按 '-' 切首段（只对默认模板 [com]-[datetime] 可靠）
    ///
    /// 全程不碰任何 writer 锁：旧实现要在单一全局 Mutex 里递归 `read_dir`，
    /// 一个大目录或一个正在落盘的端口就能把整个列表卡住（S-B5）。
    pub fn list_files(&self) -> anyhow::Result<Vec<LogFileInfo>> {
        // 先复制一份登记表再遍历：遍历是 IO，不持锁做
        let known: HashMap<PathBuf, String> = lock_mutex(&self.session_paths).clone();
        let root = PathBuf::from(&self.settings().directory);

        let mut files = Vec::new();
        if root.exists() {
            collect_log_files(&root, 0, &known, &mut files)?;
        }
        Ok(files)
    }

    fn writer_handle(&self, port_id: &str) -> Option<Arc<Mutex<PortLogWriter>>> {
        lock_mutex(&self.writers).get(port_id).cloned()
    }

    /// 先复制 Arc 再返回：调用方拿到快照后逐个加端口锁，绝不在持表锁时做 IO
    fn writer_snapshot(&self) -> Vec<(String, Arc<Mutex<PortLogWriter>>)> {
        lock_mutex(&self.writers)
            .iter()
            .map(|(port_id, handle)| (port_id.clone(), Arc::clone(handle)))
            .collect()
    }
}

/// 递归收集日志文件。子目录 `read_dir` 失败只告警跳过（防御性），根目录失败仍上抛。
fn collect_log_files(
    dir: &Path,
    depth: usize,
    known: &HashMap<PathBuf, String>,
    files: &mut Vec<LogFileInfo>,
) -> anyhow::Result<()> {
    if depth > MAX_LIST_DEPTH {
        log::warn!("Log subdirectory walk exceeded depth {MAX_LIST_DEPTH} at {dir:?}");
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            if depth > 0 {
                log::warn!("Failed to read log subdirectory {dir:?}: {e}");
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
            collect_log_files(&path, depth + 1, known, files)?;
        } else if metadata.is_file() {
            let port_id = known
                .get(&path)
                .cloned()
                .unwrap_or_else(|| fallback_port_id(&path));
            files.push(LogFileInfo {
                path: path.to_string_lossy().to_string(),
                port_id,
                created_at: file_timestamp(&metadata),
                size: metadata.len(),
            });
        }
    }
    Ok(())
}

/// 兜底：文件名按 '-' 切分取首段。只对默认模板 `[com]-[datetime]` 正确
/// （例如 "log_[com]_[date]" 会得到 "log"），因此仅在会话登记表里查不到时使用。
fn fallback_port_id(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|stem| stem.split('-').next())
        .unwrap_or("unknown")
        .to_string()
}

/// 文件创建时间（秒）。Linux 上 `created()` 恒为 Unix epoch（0），此时退回
/// `modified()`——否则 UI 按时间排序时所有日志都会落到 1970 年。
fn file_timestamp(metadata: &fs::Metadata) -> i64 {
    let unix_secs = |t: std::time::SystemTime| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    };
    let created = metadata.created().map(unix_secs).unwrap_or(0);
    if created > 0 {
        return created;
    }
    metadata.modified().map(unix_secs).unwrap_or(0)
}

/// 测试构造：临时目录 + auto_save 开启（否则写路径全被短路），
/// 其余字段与 LogSettings::default() 一致。
#[cfg(test)]
impl LogManager {
    pub(super) fn for_test(dir: &Path) -> Self {
        let mut settings = LogSettings::default();
        settings.auto_save = true;
        settings.directory = dir.to_string_lossy().into_owned();
        Self::with_settings(settings)
    }

    /// 按需改设置：走真实 apply_settings 通道（directory 未变，不会触发端口重开）
    pub(super) fn test_settings(&self, f: impl FnOnce(&mut LogSettings)) {
        let mut settings = (*self.settings()).clone();
        f(&mut settings);
        self.apply_settings(&settings);
    }

    pub(super) fn has_writer(&self, port_id: &str) -> bool {
        self.writer_handle(port_id).is_some()
    }

    pub(super) fn writer_path(&self, port_id: &str) -> Option<PathBuf> {
        self.writer_handle(port_id)
            .map(|handle| lock_mutex(&handle).file_path().to_path_buf())
    }

    /// 暴露端口锁，供「list_files 不得抢 writer 锁」这类并发断言持有
    pub(super) fn writer_lock(&self, port_id: &str) -> Option<Arc<Mutex<PortLogWriter>>> {
        self.writer_handle(port_id)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{lock_mutex, LogManager};

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hypercom_test_logs_{}", name));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        dir
    }

    /// 建 writer：格式由调用方给出、编码沿用当前设置（等价于命令层 start_logging）
    fn open_writer(mgr: &LogManager, port_id: &str, format: &str) {
        let encoding = mgr.settings().encoding.clone();
        mgr.create_writer_with_encoding(port_id, format, &encoding)
            .unwrap();
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

    // ---------- 创建 / 基本写入 ----------

    #[test]
    fn test_create_writer() {
        let dir = test_dir("create");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM3", "string");
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].path.contains("COM3"));
        assert!(files[0].path.ends_with(".log"));
        assert!(files[0].created_at > 0, "created_at 不得是 Unix epoch");
        mgr.close_writer("COM3").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_string_format() {
        let dir = test_dir("string");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00:00", "RX", b"Hello").unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        assert!(content.contains("Hello"));
        assert!(content.contains("10:00:00"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_prefix_toggles() {
        // 日志行前缀按 include_timestamp / include_direction 开关拼接

        // 仅时间戳（无方向）
        let dir = test_dir("prefix_ts");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| s.include_direction = false);
        open_writer(&mgr, "C1", "string");
        mgr.write("C1", "10:00:00", "RX", b"alpha").unwrap();
        mgr.close_writer("C1").unwrap();
        let content = read_log(&mgr, "C1");
        assert!(content.contains("[10:00:00] alpha"), "got: {content}");
        assert!(!content.contains("RX"), "direction must be omitted: {content}");
        let _ = fs::remove_dir_all(&dir);

        // 仅方向（无时间戳）
        let dir = test_dir("prefix_dir");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| s.include_timestamp = false);
        open_writer(&mgr, "C2", "string");
        mgr.write("C2", "10:00:00", "TX", b"beta").unwrap();
        mgr.close_writer("C2").unwrap();
        let content = read_log(&mgr, "C2");
        assert!(content.contains("TX beta"), "got: {content}");
        assert!(!content.contains("["), "timestamp must be omitted: {content}");
        let _ = fs::remove_dir_all(&dir);

        // 两者都关：纯数据行
        let dir = test_dir("prefix_none");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| {
            s.include_timestamp = false;
            s.include_direction = false;
        });
        open_writer(&mgr, "C3", "string");
        mgr.write("C3", "10:00:00", "RX", b"gamma").unwrap();
        mgr.close_writer("C3").unwrap();
        let content = read_log(&mgr, "C3");
        assert_eq!(content, "gamma\n", "expected bare data line: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_hex_format() {
        let dir = test_dir("hex");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "hex");
        mgr.write("COM1", "10:00:01", "TX", &[0x48, 0x65, 0x6C, 0x6C, 0x6F])
            .unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        assert!(content.contains("48 65 6C 6C 6F"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_write_accumulates_to_file() {
        let dir = test_dir("accum");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00", "RX", b"line1\n").unwrap();
        mgr.write("COM1", "10:01", "RX", b"line2\n").unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        assert!(content.contains("line1"));
        assert!(content.contains("line2"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_auto_save_off_short_circuits_write() {
        // auto_save=false 时 write() 必须直接返回，不写文件（配置关了就不能还有幽灵写入）
        let dir = test_dir("autosave_off");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
        mgr.test_settings(|s| s.auto_save = false);
        mgr.write("COM1", "10:00", "RX", b"should_not_appear\n")
            .unwrap();
        mgr.close_writer("COM1").unwrap();
        // 空日志不落盘：没有任何数据写入（0 字节文件）在关闭时被删除
        let files = mgr.list_files().unwrap();
        assert!(
            files.is_empty(),
            "empty log file must be removed on close, got: {files:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_settings_with_empty_directory_keeps_the_current_root() {
        // 首次启动 config.json 的 logDirectory 为空：不得把默认目录覆盖成空路径
        let dir = test_dir("empty_dir");
        let mgr = LogManager::for_test(&dir);
        let mut settings = (*mgr.settings()).clone();
        settings.directory = String::new();
        settings.auto_save = false;
        mgr.apply_settings(&settings);

        assert_eq!(mgr.get_directory(), dir);
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00:00", "TX", b"ignored").unwrap();
        mgr.close_writer("COM1").unwrap();
        assert!(mgr.list_files().unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_settings_switches_directory_for_active_writers() {
        // 配置侧只走 apply_settings（K3）：换目录必须真的把活动 writer 迁到新根，
        // 只改快照就会重新引入 S-B4 的「UI 列 A、实际写 B」。
        let old_root = test_dir("apply_dir_old");
        let new_root = test_dir("apply_dir_new");
        let mgr = LogManager::for_test(&old_root);
        mgr.test_settings(|s| {
            s.subdir_mode = "none".to_string();
            s.filename_format = "[com]".to_string();
        });
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00:00", "TX", b"before").unwrap();

        let mut settings = (*mgr.settings()).clone();
        settings.directory = new_root.to_string_lossy().into_owned();
        mgr.apply_settings(&settings);

        assert_eq!(mgr.get_directory(), new_root);
        assert_eq!(mgr.writer_path("COM1").unwrap(), new_root.join("COM1.log"));
        mgr.write("COM1", "10:00:01", "TX", b"after").unwrap();
        mgr.close_writer("COM1").unwrap();
        assert!(fs::read_to_string(old_root.join("COM1.log"))
            .unwrap()
            .contains("before"));
        assert!(fs::read_to_string(new_root.join("COM1.log"))
            .unwrap()
            .contains("after"));
        let _ = fs::remove_dir_all(&old_root);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn apply_settings_rolls_the_directory_back_when_it_cannot_be_created() {
        // 目标根不可用时，快照目录必须回滚到仍在生效的旧根，
        // 否则 UI 会按新目录列文件、而写入继续落在旧目录
        let root = test_dir("apply_bad_dir");
        let mgr = LogManager::for_test(&root);
        mgr.test_settings(|s| {
            s.subdir_mode = "none".to_string();
            s.filename_format = "[com]".to_string();
        });
        open_writer(&mgr, "COM1", "string");
        let blocker = root.join("blocker");
        fs::write(&blocker, b"x").unwrap();

        let mut settings = (*mgr.settings()).clone();
        settings.directory = blocker.join("sub").to_string_lossy().into_owned();
        mgr.apply_settings(&settings);

        assert_eq!(mgr.get_directory(), root);
        assert_eq!(mgr.writer_path("COM1").unwrap(), root.join("COM1.log"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn flush_all_pushes_buffered_data_to_disk() {
        // panic hook 走 flush_all：必须把 BufWriter 缓冲落到磁盘，否则崩溃前最后一批日志丢失
        let dir = test_dir("flush_all");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00:00", "TX", b"buffered").unwrap();
        let path = mgr.writer_path("COM1").unwrap();
        mgr.flush_all().unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("buffered"));
        mgr.close_writer("COM1").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 覆盖已有 writer / 目录切换 / 并发 ----------

    #[test]
    fn create_writer_flushes_the_previous_file_before_replacing_it() {
        // S-B2：再次 start_logging 时旧 writer 必须显式 flush 收尾，旧文件里的缓冲
        // 数据不能在替换瞬间丢失（旧实现只靠 BufWriter::Drop，错误被丢弃）。
        let dir = test_dir("replace_writer");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| {
            s.subdir_mode = "none".to_string();
            s.filename_format = "[com]".to_string();
            s.new_file_per_session = true;
        });
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00:00", "TX", b"first session").unwrap();
        let first = mgr.writer_path("COM1").unwrap();

        open_writer(&mgr, "COM1", "string");
        let second = mgr.writer_path("COM1").unwrap();
        assert_ne!(first, second, "每次会话必须换文件");
        assert!(
            fs::read_to_string(&first).unwrap().contains("first session"),
            "被替换的旧文件必须已收尾落盘"
        );

        mgr.write("COM1", "10:00:01", "TX", b"second session").unwrap();
        mgr.close_writer("COM1").unwrap();
        let second_content = fs::read_to_string(&second).unwrap();
        assert!(second_content.contains("second session"));
        assert!(!second_content.contains("first session"));

        // 旧文件在会话内仍能精确反查端口
        let files = mgr.list_files().unwrap();
        let entry = files
            .iter()
            .find(|f| PathBuf::from(&f.path) == first)
            .expect("旧文件仍应被列出");
        assert_eq!(entry.port_id, "COM1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_directory_moves_active_writers_to_the_new_root() {
        // S-B4：换根目录后活动 writer 必须在新根下重开，否则 UI 列 A 目录、实际写 B 目录
        let old_root = test_dir("dir_switch_old");
        let new_root = test_dir("dir_switch_new");
        let mgr = LogManager::for_test(&old_root);
        mgr.test_settings(|s| {
            s.subdir_mode = "none".to_string();
            s.filename_format = "[com]".to_string();
        });
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00:00", "TX", b"before").unwrap();
        assert_eq!(mgr.writer_path("COM1").unwrap(), old_root.join("COM1.log"));

        mgr.set_directory(new_root.to_string_lossy().into_owned())
            .unwrap();
        assert_eq!(mgr.writer_path("COM1").unwrap(), new_root.join("COM1.log"));

        mgr.write("COM1", "10:00:01", "TX", b"after").unwrap();
        mgr.close_writer("COM1").unwrap();

        assert!(fs::read_to_string(old_root.join("COM1.log"))
            .unwrap()
            .contains("before"));
        assert!(fs::read_to_string(new_root.join("COM1.log"))
            .unwrap()
            .contains("after"));
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(PathBuf::from(&files[0].path), new_root.join("COM1.log"));
        let _ = fs::remove_dir_all(&old_root);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn list_files_does_not_block_on_a_held_writer_lock() {
        // S-B5：目录遍历必须在 writer 锁外。主线程故意持有该端口的 writer 锁，
        // 若 list_files 需要它（旧实现的单一全局 Mutex 就是要），这个用例会超时。
        let dir = test_dir("list_no_lock");
        let mgr = std::sync::Arc::new(LogManager::for_test(&dir));
        open_writer(&mgr, "COM1", "string");

        let handle = mgr.writer_lock("COM1").unwrap();
        let held = lock_mutex(&handle);

        let probe = std::sync::Arc::clone(&mgr);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(probe.list_files());
        });
        let files = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("list_files must not wait for the writer lock")
            .unwrap();
        assert_eq!(files.len(), 1);

        drop(held);
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 分片 ----------

    #[test]
    fn split_continuation_never_reopens_same_file() {
        // 回归：粗粒度模板（[com] 恒同名）+ 小分片——split 续片若 append 重开刚关闭的
        // 超阈值文件，current_size 会从超阈值大小初始化，之后每次写入都触发分片。
        // 修复：续片强制唯一化，得到带 -1 后缀的新文件，后续写入不再触发分片。
        let dir = test_dir("split_new");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| {
            s.subdir_mode = "none".to_string();
            s.filename_format = "[com]".to_string();
            s.split_size_mb = 1; // 1MB 阈值
        });
        open_writer(&mgr, "COM1", "string");
        let big = vec![b'x'; 1024 * 1024 + 1]; // 超过阈值，触发第一次 split
        mgr.write("COM1", "10:00:00", "TX", &big).unwrap();
        mgr.write("COM1", "10:00:01", "TX", b"more").unwrap();
        mgr.write("COM1", "10:00:02", "TX", b"even more").unwrap();
        mgr.close_writer("COM1").unwrap();

        let files = mgr.list_files().unwrap();
        assert_eq!(
            files.len(),
            2,
            "split must produce exactly 2 files (no split loop), got {files:?}"
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
        // 分片产生的两个文件都要能反查端口（旧文件走会话登记表）
        assert!(files.iter().all(|f| f.port_id == "COM1"), "got {files:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 另存 ----------

    #[test]
    fn test_save_log_as() {
        let dir = test_dir("save");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM9", "string");
        mgr.write("COM9", "10:00:00", "RX", b"test data").unwrap();
        let target = dir.join("saved.log");
        mgr.save_log_as("COM9", &target.to_string_lossy()).unwrap();
        assert!(target.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_save_log_as_no_writer_no_files() {
        let dir = test_dir("nowriter");
        let mgr = LogManager::for_test(&dir);
        assert!(mgr.save_log_as("NONEXIST", "/tmp/hypercom-nonexistent.log").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_save_log_as_fallback_after_writer_closed() {
        // writer 已关闭（端口断开）后，save_log_as 应回退到日志目录中该端口最新文件
        let dir = test_dir("fallback");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM4", "string");
        mgr.write("COM4", "10:00:00", "RX", b"fallback data").unwrap();
        mgr.close_writer("COM4").unwrap();
        assert!(!mgr.has_writer("COM4"));
        let target = dir.join("fallback_saved.log");
        mgr.save_log_as("COM4", &target.to_string_lossy()).unwrap();
        let content = fs::read_to_string(&target).unwrap();
        assert!(content.contains("fallback data"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_log_as_fallback_finds_file_in_date_subdir() {
        // writer 关闭后，save_log_as 的回退路径必须能通过递归 list_files 找到子目录中的日志
        let dir = test_dir("save_subdir");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM4", "string");
        mgr.write("COM4", "10:00:00", "RX", b"fallback data").unwrap();
        mgr.close_writer("COM4").unwrap();
        let target = dir.join("saved.log");
        mgr.save_log_as("COM4", &target.to_string_lossy()).unwrap();
        assert!(fs::read_to_string(&target).unwrap().contains("fallback data"));
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 端口反查登记表 ----------

    #[test]
    fn test_list_files_uses_writer_registry_for_port_id() {
        // 自定义文件名模板下，port_id 必须从会话登记表反查，而不是按 "-" 切分文件名
        let dir = test_dir("custom_fmt");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| s.filename_format = "log_[com]_[date]".to_string());
        open_writer(&mgr, "COM7", "string");
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].port_id, "COM7",
            "port_id should resolve via writer registry, not 'log_log'. Got: {}",
            files[0].port_id
        );
        mgr.close_writer("COM7").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_files_resolves_closed_writer_via_session_registry() {
        // S-B6：模板里根本没有 [com]（启发式只能得到 "session"），关闭后必须靠会话
        // 登记表拿到真实端口
        let dir = test_dir("registry");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| {
            s.subdir_mode = "none".to_string();
            s.filename_format = "session".to_string();
        });
        open_writer(&mgr, "COM9", "string");
        mgr.write("COM9", "10:00:00", "TX", b"data").unwrap();
        mgr.close_writer("COM9").unwrap();

        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].port_id, "COM9",
            "session registry must win over the split('-') heuristic"
        );
        assert!(
            files[0].created_at > 0,
            "created_at must fall back to modified() instead of the Unix epoch"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 编码 ----------

    #[test]
    fn test_iso_8859_1_encoding_decodes_high_bytes() {
        // ISO-8859-1 字节 0xE9 应解码为 'é'，而不是 U+FFFD
        let dir = test_dir("latin1");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| s.encoding = "ISO-8859-1".to_string());
        open_writer(&mgr, "COM2", "string");
        mgr.write("COM2", "10:00", "RX", &[b'h', b'i', 0xE9])
            .unwrap();
        mgr.close_writer("COM2").unwrap();
        let content = read_log(&mgr, "COM2");
        assert!(content.contains("hi"), "expected 'hi' in: {content}");
        assert!(
            content.contains('é') || content.contains("\u{00E9}"),
            "expected 'é' (U+00E9) in ISO-8859-1 decoded output, got: {content}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- RX 行聚合集成 ----------

    #[test]
    fn write_rx_assembles_fragmented_response_into_single_line() {
        // 跨事件的 "H" + "ello\r\n" 必须写成一行 "Hello"，而不是首字符独占一行
        let dir = test_dir("fragmented");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
        mgr.write_rx("COM1", "10:00:00.000", b"H").unwrap();
        mgr.write_rx("COM1", "10:00:00.001", b"ello\r\n").unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        assert_eq!(content, "[10:00:00.001] RX Hello\n", "got: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_rx_splits_multi_line_event_into_separate_lines() {
        // 一个事件里包含多行 → 每行独立落盘（字节级切行）
        let dir = test_dir("multiline");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
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
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
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
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
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
        // 前缀开关对 write_rx 生效（与 write_line 同规则）
        let dir = test_dir("rx_prefix");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| {
            s.include_timestamp = false;
            s.include_direction = false;
        });
        open_writer(&mgr, "C1", "string");
        mgr.write_rx("C1", "10:00:00.000", b"bare\n").unwrap();
        mgr.close_writer("C1").unwrap();
        let content = read_log(&mgr, "C1");
        assert_eq!(content, "bare\n", "expected bare data line: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 空日志不落盘 ----------

    #[test]
    fn write_rx_skips_empty_chunks_from_consecutive_separators() {
        // 连续分隔符 / 行首行尾分隔符会产生**空块**，旧实现把它们写成空日志行
        // （"[ts] RX "）。修复后空块不落盘——日志只含真实内容行。
        let dir = test_dir("empty_lines");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
        mgr.write_rx("COM1", "10:00:00.000", b"\r\nhello\n\nworld\r\n")
            .unwrap();
        mgr.close_writer("COM1").unwrap();
        let content = read_log(&mgr, "COM1");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(
            lines.len(),
            2,
            "expected only non-empty lines, got: {content:?}"
        );
        assert!(lines[0].ends_with("hello"), "got: {content}");
        assert!(lines[1].ends_with("world"), "got: {content}");
        for line in &lines {
            let without_prefix = line
                .trim_end()
                .strip_prefix('[')
                .and_then(|s| s.split_once("] RX"))
                .map(|(_, rest)| rest);
            assert!(
                !without_prefix.map(str::is_empty).unwrap_or(false),
                "empty log line written: {line:?}"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_skips_empty_data_for_all_formats() {
        // 直写路径（TX 等）：空 data / 只含行结束符的 data 都不落盘
        let dir = test_dir("empty_write");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
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
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "hex");
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
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        assert!(
            files.is_empty(),
            "empty log file should be removed on close, got: {files:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn close_writer_keeps_file_that_has_data() {
        let dir = test_dir("keep_data");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00:00.000", "TX", b"data").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1, "file with data must be kept, got: {files:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 子目录模式 ----------

    /// 断言日志文件位于 `root/<expected_sub>/` 直接子目录下，且端口名能正确反查
    fn assert_in_subdir(mgr: &LogManager, root: &PathBuf, expected_sub: &str, port_id: &str) {
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1, "expected exactly 1 log file, got {files:?}");
        let p = PathBuf::from(&files[0].path);
        let parent = p.parent().expect("log file must have a parent dir");
        assert_eq!(
            parent,
            root.join(expected_sub),
            "log file must live in subdir '{expected_sub}', got parent {parent:?}"
        );
        assert!(root.join(expected_sub).is_dir(), "subdir must exist on disk");
        assert_eq!(
            files[0].port_id, port_id,
            "port_id must resolve via the writer registry"
        );
    }

    #[test]
    fn date_mode_writes_into_dated_subdir() {
        let dir = test_dir("subdir_date");
        let mgr = LogManager::for_test(&dir);
        open_writer(&mgr, "COM3", "string");
        let expected = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_in_subdir(&mgr, &dir, &expected, "COM3");
        mgr.close_writer("COM3").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn port_mode_writes_into_sanitized_port_subdir() {
        let dir = test_dir("subdir_port");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| s.subdir_mode = "port".to_string());
        open_writer(&mgr, "COM7", "string");
        assert_in_subdir(&mgr, &dir, "COM7", "COM7");
        mgr.close_writer("COM7").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn port_mode_sanitizes_hostile_port_id() {
        // 恶意 port_id 不能逃逸日志目录：路径分隔符与 ".." 被替换为 '_'
        let dir = test_dir("subdir_hostile");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| s.subdir_mode = "port".to_string());
        open_writer(&mgr, "COM9\\..\\evil", "string");
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1, "got: {files:?}");
        let p = PathBuf::from(&files[0].path);
        assert!(
            p.starts_with(&dir),
            "log file must stay inside log dir, got: {}",
            p.display()
        );
        let parent = p.parent().unwrap();
        assert_eq!(parent.parent().unwrap(), dir.as_path());
        assert!(
            !parent
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .contains(['\\', '/']),
            "subdir name must not contain path separators: {parent:?}"
        );
        let root_entries = fs::read_dir(&dir).unwrap().collect::<Vec<_>>();
        assert_eq!(
            root_entries.len(),
            1,
            "root must contain only the subdir, got {root_entries:?}"
        );
        mgr.close_writer("COM9\\..\\evil").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn none_mode_writes_flat_into_log_dir() {
        let dir = test_dir("subdir_none");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| s.subdir_mode = "none".to_string());
        open_writer(&mgr, "COM2", "string");
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1);
        let p = PathBuf::from(&files[0].path);
        assert_eq!(p.parent().unwrap(), dir.as_path(), "must be flat in log dir");
        mgr.close_writer("COM2").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_mode_falls_back_to_date_subdir() {
        // 未知模式按默认 date 收敛（与配置端校验一致）
        let dir = test_dir("subdir_invalid");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| s.subdir_mode = "monthly".to_string());
        open_writer(&mgr, "COM5", "string");
        let expected = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_in_subdir(&mgr, &dir, &expected, "COM5");
        mgr.close_writer("COM5").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_files_recurses_into_nested_subdirs() {
        // list_files 必须递归：根目录 + 一层子目录 + 二层嵌套的文件都要列出
        let dir = test_dir("subdir_recursive");
        let mgr = LogManager::for_test(&dir);
        fs::create_dir_all(dir.join("2026-08-01")).unwrap();
        fs::create_dir_all(dir.join("2026-08-01").join("nested")).unwrap();
        fs::write(dir.join("root.log"), b"root").unwrap();
        fs::write(dir.join("2026-08-01").join("a.log"), b"a").unwrap();
        fs::write(dir.join("2026-08-01").join("nested").join("b.log"), b"b").unwrap();

        let files = mgr.list_files().unwrap();
        assert_eq!(
            files.len(),
            3,
            "all files in subdirs must be listed, got: {files:?}"
        );
        assert!(files.iter().any(|f| f.path.ends_with("root.log")));
        assert!(files.iter().any(|f| f.path.ends_with("a.log")));
        assert!(files.iter().any(|f| f.path.ends_with("b.log")));
        // 无活跃 writer、无会话登记时，port_id 走文件名反查启发式
        let a = files.iter().find(|f| f.path.ends_with("a.log")).unwrap();
        assert_eq!(
            a.port_id, "a",
            "fallback heuristic should split on '-', got: {}",
            a.port_id
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 每次打开新建文件 ----------

    #[test]
    fn default_appends_existing_file_on_reopen() {
        // 默认行为（配置项关闭）：同名冲突续写同一文件——重开端口不丢历史
        let dir = test_dir("session_append");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| {
            s.subdir_mode = "none".to_string();
            s.filename_format = "[com]".to_string();
        });
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00:00", "TX", b"first").unwrap();
        mgr.close_writer("COM1").unwrap();
        open_writer(&mgr, "COM1", "string");
        mgr.write("COM1", "10:00:01", "TX", b"second").unwrap();
        mgr.close_writer("COM1").unwrap();
        let files = mgr.list_files().unwrap();
        assert_eq!(files.len(), 1, "default must append, got {files:?}");
        let content = fs::read_to_string(&files[0].path).unwrap();
        assert!(content.contains("first") && content.contains("second"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_file_per_session_never_appends() {
        // 开启后：每次 create_writer 都分配新文件（同名冲突 → -1/-2… 后缀），
        // 每次连接都从空文件开始，内容互不混入
        let dir = test_dir("session_new_each");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| {
            s.subdir_mode = "none".to_string();
            s.filename_format = "[com]".to_string();
            s.new_file_per_session = true;
        });
        for (ts, payload) in [
            ("10:00:00", "first"),
            ("10:00:01", "second"),
            ("10:00:02", "third"),
        ] {
            open_writer(&mgr, "COM1", "string");
            mgr.write("COM1", ts, "TX", payload.as_bytes()).unwrap();
            mgr.close_writer("COM1").unwrap();
        }
        let files = mgr.list_files().unwrap();
        assert_eq!(
            files.len(),
            3,
            "each open must get its own file, got {files:?}"
        );
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
        // 文件名后缀语义：首个用原名，之后 -1、-2…（数字插在扩展名前）
        let dir = test_dir("session_suffix");
        let mgr = LogManager::for_test(&dir);
        mgr.test_settings(|s| {
            s.subdir_mode = "none".to_string();
            s.filename_format = "[com]".to_string();
            s.new_file_per_session = true;
        });
        let mut paths = Vec::new();
        for (ts, payload) in [("10:00:00", "one"), ("10:00:01", "two"), ("10:00:02", "three")] {
            open_writer(&mgr, "COM1", "string");
            mgr.write("COM1", ts, "TX", payload.as_bytes()).unwrap();
            paths.push(mgr.writer_path("COM1").unwrap());
            mgr.close_writer("COM1").unwrap();
        }
        let names: Vec<String> = paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["COM1.log", "COM1-1.log", "COM1-2.log"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
