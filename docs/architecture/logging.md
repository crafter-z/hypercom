# 日志模块

两类日志：**落盘日志**（串口 RX/TX 数据，用户可配，`logger/mod.rs` + `commands/log.rs`）与**应用自身诊断日志**（diaglog，`diaglog.rs` + `commands/diag.rs`）。

## 落盘日志（LogManager）

`src-tauri/src/logger/mod.rs`（501 行）：BufWriter + 轮转 + 路径模板。`LogManager` 在 `AppState::new()` 从 ConfigManager 初始化；`set_config`/`reset_config` 经 `sync_log_manager_from_config` 自动同步（前端不再手动同步——`syncLogSettingsToBackend` 已删）。

### RX 日志行组装（issue #5-9/10）

- `LogLineAssembler`：字节级 CR/LF/CRLF 合并/pendingCR/4096 强制 flush/take_tail，**镜像前端 rxAssembler**。
- `LogManager::write_rx`：RX 方向组行落盘（不再按读取块一行）；TX 保持直写 `write`。
- `LogLineAssembler` 对连续分隔符/行首行尾分隔符产出**空块**——`write_line` 顶部空 data 直接返 `Ok` + string 格式 decode 后 `trim_end_matches(['\r','\n'])` 为空（只含行结束符的 TX）同样跳过（issue #12：日志空行不落盘）。`close_writer` 时 `current_size==0` 且磁盘 0 字节 → **删除空文件**。
- 新增日志写入路径不要绕过这两个守卫（组装器仍会产出空块，这是刻意的行边界语义）。

### 分片 / 子目录 / 编码 / 每会话新文件

- `log_split_enabled` / `log_split_size`：超阈值自动分片；**split 续片经 `create_split_writer` 强制唯一化（与 `logNewFilePerSession` 开关无关）**——粗粒度模板（`[com]`/`[com]-[date]`）下 append 重开刚关闭的超阈值文件会令 current_size 从超阈值初始化、每写必分片（死循环）。
- `log_subdir_mode: 'none'|'date'|'port'`（默认 `date`，非法值 clamp 回 date）：`create_writer_with_encoding` 路径 join（create_dir_all）+ `collect_log_files` 递归 list_files（MAX_LIST_DEPTH=16）。
- `log_include_timestamp` / `log_include_direction`（`#[serde(default = "default_true")]`——旧 config.json 缺省读回 true）：控制 `PortLogWriter::write_line` 是否 emit `[timestamp] ` / `RX|TX ` 前缀；两者都关 → 裸数据行。锁于 `create_writer` 时（同 encoding），经 `sync_log_manager_from_config` 同步。
- `log_encoding`：`create_writer_with_encoding`（GBK 等）。
- `log_new_file_per_session`（默认关，保持续写）：每次 `create_writer`（打开串口/重连）经 `open_new_log_file` 用 `create_new(true)` 原子分配**不存在**的文件（同名冲突 `name-1.log`/`name-2.log`… 后缀，数字插扩展名前），绝不续写。
- TX 日志经 `build_tx_bytes`（与实际发送字节同源，见 serial.md/transmission.md）。

### 命令（commands/log.rs）

`start_logging` / `stop_logging` / `save_log_as` / `export_terminal_log` / `get_log_files` / `set_log_split_size` / `set_log_split_enabled` / `set_log_filename_format` / `set_log_auto_save` / `set_log_encoding` / `open_path` / `open_log_directory` / `migrate_log_directory`。跨 `.await` 锁纪律：提取 + clone + drop `MutexGuard` 再 await（`commands/log.rs` 是示范模式）。

## 应用诊断日志（diaglog，issue #5-2）

- 后端 `log::*` + 前端 `console.*`（`setupDiagLogCapture` 拦截转发）统一落盘 `%APPDATA%/hypercom/diag/hypercom-debug.log`（512KB 轮转保留 3 份）。
- 开关 `config.diagLogEnabled`（Rust 序列化名，前端线名已对齐）；查看入口「关于 → 诊断日志」（`DiagnosticLogDialog.tsx`）。
- 命令：`get_diag_log_path` / `read_diag_log` / `clear_diag_log` / `append_diag_log`（`commands/diag.rs`）。
- 自动更新失败/静默降级等诊断路径写入这里。

## 数据流速查

| 流 | 路径 |
|---|---|
| RX 落盘 | serial:data → LogManager.write_rx → LogLineAssembler 组行 → 分片/子目录/编码写入 |
| TX 落盘 | send_data → build_tx_bytes → LogManager.write（直写） |
| 诊断日志 | log::* / console.* → setupDiagLogCapture → diag/hypercom-debug.log（轮转 3×512KB） |
| 日志设置同步 | set_config/reset_config → sync_log_manager_from_config |
