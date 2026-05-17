# 自主迭代工作日志

> 开始: 2026-05-17 10:49 | 预计结束: 2026-05-17 12:49
> 模式: 无监督自主迭代 | 目标: 完善未完成功能 + 缺陷发掘修复

## 执行计划

### Phase 1 — 标题栏窗口控制 (预计 20min)
- `TitleBar.tsx`: 绑定最小化/最大化/关闭按钮到 `@tauri-apps/api/window`
- `tauri.conf.json`: 确认 `decorations: false` 配置
- 影响: 所有用户直接使用的基础功能

### Phase 2 — 日志操作按钮 (预计 25min)
- `OperationPanel.tsx`: "另存为" → 文件保存对话框 + `logService.saveLogAs()`
- "打开文件" → `@tauri-apps/plugin-shell` 打开日志文件
- "打开目录" → 打开日志所在目录

### Phase 3 — HEX 发送格式解析 (预计 20min)
- `serial/mod.rs`: 解析 `"48 65 6C 6C 6F"` → `[0x48, 0x65, ...]` 字节数组
- 支持空格分隔和无分隔两种 HEX 格式

### Phase 4 — 日志分片续写 (预计 20min)
- `logger/mod.rs`: `write()` 实际调用 `should_split()` 后关闭旧写入器创建新写入器
- 文件名变量解析 `[com]` → 端口号, `[datetime]` → 时间戳

### Phase 5 — 串口参数在线修改扩展 (预计 15min)
- 扩展 `set_serial_params` 命令支持 data_bits/parity/stop_bits/handshake
- 前端 OperationPanel 参数变更时调用完整参数

### Phase 6 — 缺陷发掘与修复 (预计 20min)
- 审查代码发现隐藏 bug
- 修复发现的问题

---

## 执行记录

### 10:49 — Phase 1: 标题栏窗口控制
**结果: 已存在，跳过。** `TitleBar.tsx` 已导入 `getCurrentWindow`，三按钮均已绑定 `minimize()` / `toggleMaximize()` / `close()`，并监听 `onResized` 跟踪最大化状态。

### 10:55 — Phase 2 完成: 日志操作按钮
- "另存为"：调用 `@tauri-apps/plugin-dialog` 的 `save()` 对话框 → `logService.saveLogAs()`
- "打开文件"：`logService.getLogFiles()` 查找匹配文件 → `@tauri-apps/plugin-shell` `open()`
- "打开目录"：读取 `config.logDirectory` → shell `open()`

### 11:04 — Phase 6: 缺陷发掘
**发现 2 个真实 bug:**
- **Bug B1** (来自 agent 审查): HEX 解析对奇数长度字符串静默截断、非法字符静默跳过 → 已修复：添加明确的错误返回
- **Bug B2** (来自 agent 审查): `reorderPorts` 使用全数组索引 — 经核实无误，现有代码始终从 `useAppStore.getState().ports` 计算全数组索引
- **Bug B3**: `save_log_as` 在无日志写入器时静默失败 — 需 UI 反馈（已记录，未修改核心逻辑）

### 11:07 — Phase 5 补充: 串口参数扩展后端编译
- `SetSerialParamsArgs` 新参数结构体
- 前端 `setSerialParams` 传参格式更新
- `logger/mod.rs`: list_files 端口 ID 文件名解析修复 (lifetime issue)

### 11:11 — Phase 7: 自动日志记录
- `start_logging` 命令改为读取 `config.log_format` 而非硬编码 `"string"`
- `useSerialConnection`: `openPort` 在连接成功后若 `config.autoSaveLog=true` 自动调用 `logService.startLogging()`
- `closePort` 停止日志

### 11:13 — 完成总结

## 成果汇总

| 领域 | 完成项 | 文件 |
|------|--------|------|
| 日志操作 | 另存为/打开文件/打开目录 三个按钮实现 | `OperationPanel.tsx`, `services/tauri.ts` |
| HEX 解析 | 空格分隔+无分隔+错误检测 | `serial/mod.rs` |
| 日志分片 | 超限自动关闭旧文件创建新文件续写 | `logger/mod.rs` |
| 文件名变量 | `[com]`, `[datetime]`, `[date]`, `[time]` 变量替换 | `logger/mod.rs` |
| 文件名解析 | `list_files()` 从文件名提取 port_id | `logger/mod.rs` |
| 日志配置推送 | 分片大小/文件名格式后端命令 | `commands/mod.rs`, `lib.rs` |
| 串口参数扩展 | 波特率在线修改 (完整参数结构体) | `commands/mod.rs`, `serial/mod.rs`, `tauri.ts` |
| 自动日志记录 | 端口连接时若 `autoSaveLog=true` 自动启停日志 | `useTauri.ts`, `commands/mod.rs` |
| HEX 边界修复 | 奇数长度/非法字符返回明确错误 | `serial/mod.rs` |
| 跨平台路径 | 移除 `%APPDATA%` Windows-only 路径 | `OperationPanel.tsx` |
| 文档更新 | 状态/路线图/缺陷记录更新 | `plans/` |

## 未覆盖项
- 滚动锁定同步 (上次 commit 已修复)
- 标题栏窗口控制 (已存在，被误列为未完成)
- 虚拟滚动 / 协议解析器 / i18n / 数据导出 (阶段 5，低优先级)

