/**
 * 日志管理模块 (Log Manager)
 * 负责串口通信日志的写入、分片、另存等操作
 *
 * 模块划分（原先是一个 2000 行的单文件，职责互相纠缠）：
 * - `settings`：`LogSettings` —— 日志设置的**唯一来源**（配置侧只需 from_config/apply_settings）
 * - `naming`：文件名模板、子目录策略、目标文件分配（含路径遍历防御）
 * - `assembler`：字节级 RX 行聚合（与前端 `src/utils/rxAssembler.ts` 同语义）
 * - `writer`：单端口写入器（编码、格式、分片滚动、尾部冲刷）
 * - `manager`：`LogManager` —— 细粒度锁的对外门面（设置、创建/关闭、写路径、列举、另存）
 *
 * 锁与并发口径统一在 `manager` 的文件头注释里；本文件只提供全模块共用的
 * 「忽略 poison 的取锁」助手——std 的 Mutex/RwLock 在其它线程 panic 后会永久
 * 进入 poison 状态，而日志子系统的职责恰恰是「尽力落盘」，因此取锁失败不能让
 * 写路径连锁 panic。
 */

mod assembler;
mod manager;
mod naming;
mod settings;
mod writer;

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

use serde::{Deserialize, Serialize};

pub use manager::LogManager;
pub use settings::LogSettings;

/// 日志文件信息（`get_log_files` 的线格式，camelCase 与前端对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub path: String,
    pub port_id: String,
    pub created_at: i64,
    pub size: u64,
}

/// 取 Mutex 并忽略 poison（见文件头说明）
pub(crate) fn lock_mutex<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|e| e.into_inner())
}
