# 缺陷追踪

> 仅记录当前存在的未修复缺陷。已修复项移入变更历史。

## 未修复

### P2 — 待优化

| # | 文件 | 问题 | 说明 |
|---|------|------|------|
| 29 | `StatusBar.tsx:38` | **memoryLimitMb=0 防御已添加但极端值未测** | 已添加三元保护，但 0 值场景未实际验证。 |
| 44 | `OperationPanel.tsx` | **缺少编码选择 UI 控件** | Store 有 opEncoding 但面板无控件。编码选择已移至 TerminalView 工具栏。 |

### P3 — 小问题

| # | 文件 | 问题 | 说明 |
|---|------|------|------|
| 40 | `Sidebar.tsx:237` | **useSensors 在 JSX 表达式中调用** | 非惯用写法，应移至组件顶层。 |

## 已修复 (2026-05-24 批量)

### P1

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 48 | `OperationPanel.tsx:222` | 打开日志文件匹配错误（COM1 命中 COM10-*.log） | 改为 `files.filter(f => f.port_id === activeTabId)` 精确匹配后用 `reduce` 按 `created_at` 取最新一条 |
| 49 | `logger/mod.rs:41-60` + `useTauri.ts:157` | 日志写入硬编码 UTF-8 lossy，忽略终端编码 | `PortLogWriter` 新增 `encoding` 字段；`LogManager` 新增 `set_default_encoding` + Tauri 命令 `set_log_encoding`；`decode_bytes` 支持 GBK/ISO-8859-1/UTF-8/ASCII；前端 `useSerialData` 用 `terminal.encoding` 创建 `TextDecoder`，失败回退 UTF-8 |
| 50 | `commands/mod.rs:262-285` | 首次 `get_system_status` CPU=0 | `lib.rs::setup` 中预热：两次 `refresh_cpu_all` + 250ms sleep 建立 CPU 采样基线 |

### P2

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 33 | `OperationPanel.tsx:472-474` | 波特率下拉只能选预设值 | 新增 "其他..." 选项 + 联动数字输入框；`isCustomBaud` 状态根据 `opBaudRate` 是否在 `defaultBaudRates` 中自动切换 |
| 34 | `Sidebar.tsx:387-388` | 一键连接/断开并行触发无速率限制 | `forEach` 改为 `for...of` + 100ms `setTimeout` 节流 |
| 51 | `Sidebar.tsx:389-411` | 跨组拖入"未分组"区域不调整全局顺序 | `handleDragEnd` 中 `overGroupId === undefined` 分支补调 `reorderPorts(oldGlobalIdx, newGlobalIdx)` |
| 52 | `logger/mod.rs:191-217` | `list_files` port_id 解析依赖固定分隔符 | 优先用活跃 writer 的 `file_path → port_id` 反向索引；文件名 split('-') 仅作 fallback |
| 53 | `logger/mod.rs:68-76` | `LogManager.auto_save` 字段僵尸状态 | 删除 `#[allow(dead_code)]`；`write()` 首行检查 `if !self.auto_save { return Ok(()) }`；新增 `set_auto_save` 方法与 Tauri 命令 `set_log_auto_save`；前端 `saveConfig` + `useAppInit` 自动同步 |
| 54 | `commands/mod.rs:211-238` | `open_path` 无路径作用域校验 | 接受 `State<AppState>`；用 `canonicalize().starts_with(log_root)` 校验目标必须在 `LogManager.get_directory()` 子树下 |

### P3

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 41 | `serial/mod.rs:163` | Unknown 端口类型映射为 virtual | 改为映射为 `real`，避免把真实 USB-CDC/PCI 标成虚拟 |
| 42 | `Sidebar.tsx:157` + `styles.css` | CSS 变量 `--accent-color` 未定义 | 在 `:root`（暗色 #4fc3f7）与 `:root[data-theme="light"]`（亮色 #0288d1）补充定义 |
| 43 | `useTauri.ts:219-220` | TX 统计两次 `getState()` | `sendData` 内一次 `useAppStore.getState()` 缓存到 `state`，所有 mutation 共用同一快照 |
| 47 | `OperationPanel.tsx:106-160` | 循环发送切换命令集时索引不重置 | 顶层派生 `activeCmdCount`，加入 effect 依赖数组；命令集长度变化触发 effect 重跑并把 `ref.currentCmdIdx` 复位为 0 |
| 55 | `commands/mod.rs:218-222` | Windows `explorer` 路径含逗号被截断 | Windows 分支改用 `std::os::windows::process::CommandExt::raw_arg` + 手动 `"…"` 引号包裹，规避 explorer 把 `,` 当多参数分隔 |
| 56 | `logger/mod.rs:159-164` | 分片后旧 BufWriter 仅 flush 不主动 drop | 分片时 `writers.remove()` 取出 writer，再 `into_inner()` 拿回 `File`，显式 `sync_all()` 后丢弃，确保 OS 落盘 |

### Misc

| 文件 | 问题 | 修复 |
|------|------|------|
| `logger/mod.rs:40,48` | 陈旧 TODO 注释 | 删除（功能已实现） |
| `commands/mod.rs:66-70` | `send_serial_data` HEX 模式日志写入未解析字节 | 抽取 `serial::parse_hex_string` 公共函数；TX 日志按实际写入串口的字节序列记录（HEX 解析 / 文本+line ending） |
| `MainDisplay.tsx:110` | `as any` 类型逃逸 | 改为 `as Encoding` 并补充类型 import |

### 测试

| 文件 | 新增测试 |
|------|----------|
| `logger/mod.rs` | `test_auto_save_off_short_circuits_write` — 验证 #53 短路 |
| `logger/mod.rs` | `test_list_files_uses_writer_registry_for_port_id` — 验证 #52 反向索引 |
| `logger/mod.rs` | `test_iso_8859_1_encoding_decodes_high_bytes` — 验证 #49 编码解码 |

### 验证

- `cargo check --manifest-path src-tauri/Cargo.toml`：0 errors, 0 warnings
- `npx tsc --noEmit`：0 errors
- `cargo test --lib logger::`：11/11 passing
- `ast-grep "$X as any"` in `src/`：0 matches

## 已修复 (2026-05-23 批量)

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 16 | P2 | Sidebar 嵌套 DndContext，跨组拖拽不工作 | 重构为 Sidebar 顶层单一 `DndContext`，每个分组及未分组各持 `SortableContext`；`handleDragEnd` 统一处理同组重排与跨组移动（含调用 `movePortToGroup` + 调整 `portIds` 顺序） |
| 20 | P2 | `get_system_status` 每次 `System::new_all()` + `refresh_all()` | `AppState` 新增缓存的 `system_info: Mutex<sysinfo::System>`；命令改为增量刷新（仅本进程 + `refresh_cpu_all`） |
| 24 | P2 | Pane 订阅整个 `terminals` 对象 | 计算 `displayTabId` 后改用按需选择器 `useAppStore(s => s.terminals[displayTabId])`，单 Pane 只在自己的终端数据变化时重渲染 |
| -- | -- | 日志"打开文件 / 打开目录"命令未暴露 | 新增 `open_path`、`open_log_directory` 两个 Tauri 命令；`LogManager` 增加 `get_directory()`；前端 `logService` 改用新命令，绕开 shell 插件作用域限制 |

## 已修复 (2026-05-21 批量)

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 01 | P0 | Config serde camelCase `memoryLimitMb` vs TS `memoryLimitMB` 不同步 | TS 改为 `memoryLimitMb` / `logSplitSizeMb` 匹配 serde 输出 |
| 02 | P0 | 日志写入断路 — LogManager.write() 从未被调用 | serial read thread 和 sim thread 中通过 app_handle.state 写入 LogManager |
| 03 | P1 | movePortToGroup 不更新 group.portIds | 同时更新旧组移除、新组添加 |
| 04 | P1 | useSerialData 清理竞争 — setup() 异步 | 使用 cancelled flag + cleanups 数组，setup 完成后若已取消则立即清理 |
| 05 | P1 | openPort 乐观更新 — 连接前设 connected | 改为先设 connecting，成功后设 connected，失败设 error |
| 06 | P1 | save 高亮/命令集每次新 UUID 产生重复 | 支持前端传入 id，更新时先删旧再插新 |
| 07 | P1 | ConfigModal 取消不回滚 | 添加 configSnapshotRef，打开时快照，取消时恢复 |
| 08 | P1 | splitPane 方向反转 | 移除 `direction === 'horizontal' ? 'vertical' : 'horizontal'` 反转 |
| 09 | P1 | set_params 忽略 data_bits/parity/stop_bits/handshake | 实现完整参数设置 |
| 10 | P1 | prevent_screen_off/sleep 空壳 | 实现 Win32 SetThreadExecutionState FFI |
| 11 | P1 | MainDisplay useAppStore() 无选择器 | 拆分为独立选择器 |
| 12 | P1 | TerminalView 空数据时显示 mock | 移除 mock 数据，显示空终端 |
| 13 | P2 | handleContextMenu 引用过期 lines | 使用 useAppStore.getState() 获取最新数据 |
| 14 | P2 | 编码选择 <select> 无 value/onChange | 绑定 terminal.encoding + setTerminalConfig |
| 15 | P2 | TextDecoder 硬编码 UTF-8 | 编码选择器已连接，待 useSerialData 中使用 encoding 参数 |
| 17 | P2 | closeTab 不关闭串口 | closeTab 包装器先断开串口再关闭标签 |
| 18 | P2 | 新标签 maxLines 硬编码 10000 | 改为 memoryLimitMb * 500 |
| 19 | P2 | 标签标题不跟别名更新 | updatePort 检测 alias/name 变化时更新 tab.title |
| 21 | P2 | .config-page-title display:none | 移除 display:none，保留字体样式规则 |
| 22 | P2 | CSS quoted padding '2px 12px' | 移除无效引号 |
| 25 | P2 | highlightEngine color 注入未校验 | 添加 hex/rgb/named color 正则校验 |
| 26 | P2 | ReDoS 正则攻击 | 限制 pattern 长度 <= 200 |
| 28 | P2 | `get_traffic_stats` 返回 (0,0) 占位 | 仍未处理 — 见 P2 列表 |
| 30 | P2 | 串口超时错误导致读线程退出 | 添加 TimedOut 错误处理 continue |
| 31 | P2 | close_port 持锁 thread.join() | 此项暂不修复（影响较小，100ms 超时） |
| 36 | P2 | system status 硬编码中文 | 改为 "normal"/"high_load" 状态码，前端本地化 |
| 37 | P2 | closeTabsToRight/Left/Others 不跳过 pinned | 过滤 isPinned 标签 |
| 39 | P3 | formatTimestamp 组件内重建 | 移至模块级函数 |
