# 日志模块

两类日志：**落盘日志**（串口 RX/TX 数据，用户可配，`logger/` + `commands/log.rs`）与**应用自身诊断日志**（diaglog，`diaglog.rs` + `commands/diag.rs`）。

## 落盘日志（LogManager）

`logger/` 按职责拆成 6 个模块（原先是一个职责互相纠缠的单文件门面）：

| 模块 | 职责 |
|---|---|
| `logger/mod.rs` | `LogManager` 门面导出 + `LogFileInfo`（`get_log_files` 的线格式）+ 忽略 poison 的取锁助手 |
| `logger/settings.rs` | `LogSettings` 与 `LogSettings::from_config(&AppConfig)`——配置表 → 写入行为的唯一转换点 |
| `logger/naming.rs` | 文件名模板 / 子目录策略 / 目标文件分配（`create_new` 唯一化、路径遍历防御） |
| `logger/assembler.rs` | `LogLineAssembler`——字节级 RX 行聚合 |
| `logger/writer.rs` | `PortLogWriter`——单端口写入器（编码 / 格式 / 前缀 / 分片滚动 / 尾部冲刷） |
| `logger/manager.rs` | `LogManager`——`apply_settings` / `write` / `write_rx` / `maybe_split` / `periodic_flush` / `list_files` / `retire_path` |

`LogManager` 在 `AppState::new()` 经 `AppState::apply_runtime_config` 从 ConfigManager 初始化。`AppState.log_manager` 是 **`Arc<LogManager>`（无外层 Mutex）**：写路径全是 `&self` + 内部细粒度锁——`save_log_as` 的拷贝、`list_files` 的递归遍历与数据写入**不争同一把锁**（旧实现是单一全局 `Mutex`，一个大目录或一个正在落盘的端口就能把列表与其它端口写路径一起卡住）。

### 日志设置的唯一入口

`LogSettings::from_config(&AppConfig)` + `LogManager::apply_settings(&LogSettings)` 是日志设置的**唯一**入口，两者经 `AppState::apply_runtime_config` 串联（`AppState::new` 与 `set_config` 命令共用）。因此 **`set_config` 是唯一同步点**，前端不再手动同步。

- 旧的逐字段 `set_log_*` 命令（`set_log_split_size` / `set_log_split_enabled` / `set_log_filename_format` / `set_log_auto_save` / `set_log_encoding` 等 6 个）、`sync_log_manager_from_config` 与前端 `syncLogSettingsToBackend` **全部已删除**；命令总数 71 → **64**。
- `log_format`（string/hex/binary）**不属于** `LogSettings`——同一时刻不同端口可用不同格式，由 `start_logging` 命令按端口逐次传入。
- `apply_settings` 对空 `log_directory` 有守卫：空串不覆盖当前根（首次启动 config.json 的 `logDirectory` 可能为空）；换目录会显式收尾活动 writer 并在新根下重开，失败则把快照目录回滚，绝不留下「UI 列 A、实际写 B」的撕裂状态。

### RX 日志行组装（issue #5-9/10）

- `LogLineAssembler`（`assembler.rs`）：字节级 CR/LF/CRLF 合并（跨两次 feed 的 CRLF 对识别为**一个**分隔符）、`pending_cr` 标记、4096 字节无分隔符**强制 flush**（防无换行二进制流撑爆缓冲）、`take_tail`；强制发射后**紧跟**的分隔符经 `just_forced` 只终结已发射的行、不再凭空多出幻影空行。**镜像前端 `rxAssembler`**。
- `LogManager::write_rx`：RX 方向组行落盘（不再按读取块一行）；TX 保持直写 `write`。RX 尾部滞留 ≥250ms（`RX_TAIL_SILENCE_FLUSH`）时，下一个事件先经 `flush_stale_rx_tail` 把尾部冲刷成行，长停顿的半行不会无限滞留。
- 空行不落盘守卫：`PortLogWriter::write_line` 顶部 `data.is_empty()` 直接返 `Ok`；string 格式 decode 后 `trim_end_matches(['\r','\n'])` 为空（只含行结束符的内容）同样跳过（issue #12：日志空行不落盘）。`close_writer` 收尾时 0 字节文件经 `retire_path` **删除**（有内容的文件登记进会话反查表）。
- 新增日志写入路径不要绕过这两个守卫（组装器仍会产出空块，这是刻意的行边界语义）。

### 分片 / 子目录 / 编码 / 每会话新文件

- `log_split_enabled` / `log_split_size_mb`：`LogManager::maybe_split` → `PortLogWriter::needs_split`（阈值判定 `should_split` + 分片失败 5s 退避）超阈值自动分片；**split 续片经 `PortLogWriter::rotate(force_new_file=true)` 强制唯一化（与 `logNewFilePerSession` 开关无关）**——粗粒度模板（`[com]`/`[com]-[date]`）下 append 重开刚关闭的超阈值文件会令 `current_size` 从超阈值初始化、每写必分片（死循环）。`rotate` 先把新文件开好再替换，失败时旧 writer 原封不动继续可用。
- `log_subdir_mode: 'none'|'date'|'port'`（默认 `date`，非法值 clamp 回 `date`，与配置端校验口径一致）：`naming::allocate_file` 按策略 join 子目录（`create_dir_all`）；`list_files` 经 `collect_log_files` 递归下钻（`MAX_LIST_DEPTH=16`，防目录联接成环）。
- `log_include_timestamp` / `log_include_direction`（缺省 true）：控制 `PortLogWriter::write_line` 是否 emit `[timestamp] ` / `RX|TX ` 前缀；两者都关 → 裸数据行。它们与 `format` / `encoding` 一样锁于 `create_writer` 时（`WriterSpec`），后续重开沿用创建时锁定的值。
- `log_encoding`：`create_writer_with_encoding` 按编码解码（GBK 等，`decode_bytes`）。
- `log_new_file_per_session`（默认关，保持续写）：每次 `create_writer`（打开串口/重连）用 `FileMode::Unique` 经 `naming::open_unique` 以 `create_new(true)` 原子分配**不存在**的文件（同名冲突依次 `name-1.log`/`name-2.log`…，数字插扩展名前），绝不续写。
- `list_files` 的 `created_at` 经 `file_timestamp`：`created()` 缺失时回退 `modified()`，避免 UI 按时间排序时全部落到 1970。
- **日志文件 → port_id 的解析口径与已知边界**：会话内建 `path → port_id` 登记表（创建/分片/换目录/关闭时登记），`list_files` 优先查表；查不到时回退文件名启发式（stem 按 `-` 切首段）。默认模板 `[com]-[datetime]` 下首段就是 port_id，因此**默认配置**在重启后仍能正确归属；但模板把 `[com]` 放在非首位（如 `log_[com]_[date]`）时，重启后（登记表为空）归属会失败或误判，`save_log_as` 的按端口回退选文件也受同一限制。这是既有边界（启发式自始存在），未引入持久化索引以免改变用户日志目录契约；如需彻底解决，应在 writer 创建时追加一个日志目录外的持久化索引并以旧文件启发式兜底。
- TX 日志经 `build_tx_bytes`（与实际发送字节同源，见 serial.md / transmission.md）。

### 命令（commands/log.rs）

`start_logging` / `stop_logging` / `save_log_as` / `export_terminal_log` / `get_log_files` / `open_path` / `open_log_directory` / `migrate_log_directory`（**无 `set_log_*`**）。跨 `.await` 锁纪律：提取 + clone + drop `MutexGuard` 再 await（`commands/log.rs` 是示范模式）。

## 应用诊断日志（diaglog，issue #5-2）

- 后端 `diaglog.rs` 的 `DiagLogger`：后端 `log::*` + 前端 `console.*`（`utils/diagLog.ts` 的 `setupDiagLogCapture` 拦截转发）统一落盘 `%APPDATA%/hypercom/diag/hypercom-debug.log`（512KB 轮转，保留 3 份）。
- 开关 `config.diagLogEnabled`（Rust 序列化名，`AppState::apply_runtime_config` 里经 `DiagLogger::set_enabled` 同步）；查看入口「关于 → 诊断日志」（`shared/DiagnosticLogDialog.tsx`）。
- 命令（`commands/diag.rs`，4 个）：`get_diag_log_path` / `read_diag_log` / `clear_diag_log` / `append_diag_log`。
- 自动更新失败/静默降级等诊断路径写入这里。

## 数据流速查

| 流 | 路径 |
|---|---|
| RX 落盘 | serial:data → LogManager.write_rx → LogLineAssembler 组行 → 分片/子目录/编码写入 |
| TX 落盘 | send_data → build_tx_bytes → LogManager.write（直写） |
| 诊断日志 | log::* / console.* → setupDiagLogCapture → diag/hypercom-debug.log（轮转 3×512KB） |
| 日志设置同步 | set_config → AppState::apply_runtime_config → LogSettings::from_config + LogManager::apply_settings |
