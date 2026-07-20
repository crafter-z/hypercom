# 缺陷追踪

> 仅记录当前存在的未修复缺陷。已修复项移入变更历史。

## 未修复

当前无未修复缺陷。

## 已修复 (2026-07-21 缺陷审计轮)

> 5 路并行探索 agent 审计（Zustand 选择器 / 内存泄漏 / 错误处理 / 类型安全 / Rust 后端），发现并修复 26 项缺陷。验证: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告, `npm run test:run` 158/158, `cargo test --lib` 31/31。Zustand 选择器审计 0 违规。

### Rust 后端

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| CRITICAL | `lib.rs` | panic hook 在持有 `log_manager` 锁时 panic 会死锁（Mutex 非可重入），`abort()` 永不执行 | `.lock()` 改 `.try_lock()`，拿不到锁则跳过 flush |
| HIGH | `storage/mod.rs` | send_history 50 行上限查询按 `created_at` 排序非确定性，时间戳重复时可能删掉刚插入的行 | 改用 `rowid` 作 tiebreaker + 新增 `(port_id, created_at)` 索引 |
| HIGH | `commands/storage.rs` | `save_command_set`/`save_highlight_set` 更新路径 `let _ =` 吞掉删除失败 → 子行重复 | 改为 `?` 传播错误 |
| HIGH | `serial/mod.rs` | 引脚事件上报 DTR/RTS 用连接时的快照，`set_flow_control` 后过期 | 新增 `dtr_state`/`rts_state` `Arc<AtomicBool>`，读线程实时读取 |
| MEDIUM | `storage/mod.rs` | send_history `created_at` 用 UTC，其余代码用 Local | 改 `chrono::Local::now()` |
| MEDIUM | `serial/mod.rs` | `close_port` 持 `serial_manager` 锁期间 `thread.join()` 阻塞所有命令 ~100ms | `close_port` 返回 `JoinHandle`，调用方 drop 锁后再 join |

### 前端生命周期 & 竞态

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| CRITICAL | `App.tsx` | `beforeunload` 异步保存会话快照，WebView 可能提前终止 → 快照丢失 | 改为订阅 store 增量防抖保存（1s），beforeunload 降为兜底 |
| HIGH | `useTauri.ts` | 重连提示监听器注册是异步，快速挂载/卸载时 cleanup 跑在 promise resolve 前 → 监听器永久泄漏 | 保存 pending promise，cleanup 时若未 resolve 则 `.then(u => u())` |
| HIGH | `TitleBar.tsx` | `onResized` 异步注册同类竞态泄漏 | 加 `cancelled` 标志，resolve 后检查 |
| MEDIUM | `useTauri.ts` | 协议重组器仅按 port_id 缓存，切换模板后仍用旧模板解析 | 缓存 key 改 `portId:templateId` |
| LOW | `useTauri.ts` | 重连循环首次尝试前也 sleep 500ms | 仅 `attempt > 0` 时 sleep |
| LOW | `useTauri.ts` | 发送历史去重只看 content，hex "AA" 与 string "AA" 互相覆盖 | 去重 key 加 format |
| LOW | `GeneralSettings.tsx` | maxRetries 允许 0 → 自动重连空转 | 下限改 1 |

### 前端逻辑 & 健壮性

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| MEDIUM | `useAppStore.ts` | `reorderPorts`/`reorderTabs` 无边界检查，越界 splice 插入 undefined 损坏数组 | 加边界守卫提前返回 |
| MEDIUM | `useAppStore.ts` | 会话恢复不校验 tree 叶子 tabIds 与有效 tab 对应，可能渲染幽灵标签 | 恢复时按有效 tab 过滤 tabIds + pruneTree + focusedPaneId 兜底 |
| LOW | `TerminalView.tsx` | 过滤器隐藏全部匹配时 jumpToMatch 指向不可见行 | 无可见匹配时不更新 currentMatch |
| LOW | `timeFormat.ts` | 相对时间戳负 delta 输出 "+-5ms" | `Math.max(0, delta)` |
| LOW | `sendUtils.ts` | HEX 奇数长度静默丢弃末字符 | 末字符补前导 0 |

### 错误处理（24 处用户可见操作静默失败 → 补 Toast）

| 文件 | 修复 |
|------|------|
| `useTauri.ts` | closePort / resetConfig / useSimulation / startLogging 失败补 `notifyError`；pinStates setup 补 catch |
| `App.tsx` | preventScreenOff / preventSleep 失败补 `notifyError` |
| `ViewStrip.tsx` | 日志另存/打开文件/打开目录 3 处补 `notifyError` |
| `HighlightSettings/CommandSettings/ProtocolSettings` | 各 2 处（删除+保存）补 `notifyError` |
| `OperationPanel.tsx` | setSerialParams / setFlowControl 补 `notifyError` |
| `Pane.tsx` | closePort 补 `notifyError` |
| `useCyclicSend.ts` | 循环发送失败补 `notifyError`（用 ref 防重复 toast） |
| `TerminalView.tsx` | 导出 TXT/CSV 失败补 `notifyError` |

## 已修复 (2026-06 重构批次)

> 12 个重构提交, 修复 20 项缺陷。所有验证通过: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告, `npm run test:run` 71/71, `cargo test --lib` 24/24。

### 后端

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 58 | `ccfd867` | `serial/mod.rs` | GBK 解码返回 U+FFFD 占位符, 非 ASCII 字节丢失 | 引入 `encoding_rs::GBK`, 后端输出正确 UTF-8, 前端 `TextDecoder` 处理其他编码 |
| 59 | `6d805b3` | `serial/mod.rs` | serial 模块存在死代码 (未使用的函数和字段) | 移除死代码, 抽取 `emit_data_event` helper 统一事件推送 |
| 60 | `6d805b3` | `serial/mod.rs` | `get_traffic_stats` 返回 (0,0) TODO 占位 | 移除 TODO stub, 实现真实 TX/RX 字节累加 |
| 61 | `8bf661d` | `storage/mod.rs` | 6 处 `.lock().unwrap()` 存在 panic 风险 | 全部改为 `.lock().map_err(\|e\| ...)` 返回 `CommandError` |
| 62 | `8bf661d` | `storage/mod.rs` | 双重 CRUD 实现 (dead code 与活跃实现并存) | 移除死 CRUD, 保留单一实现 |
| 63 | `8bf661d` | `storage/mod.rs` | 重复 schema SQL (两份建表语句) | 合并为单一 schema 定义 |
| 64 | `8bf661d` | `storage/mod.rs` + `commands/` | 4 对重复类型定义 | 合并为单一类型, 消除冗余 |
| 65 | `686b7be` | `commands/mod.rs` | commands 单体文件 400+ 行, 所有命令挤在一起 | 拆分为 6 个领域文件: `serial.rs`, `storage.rs`, `config.rs`, `log.rs`, `system_cmds.rs`, `simulation.rs` |
| 66 | `686b7be` | `commands/mod.rs` | 所有命令返回 `Result<T, String>`, 无类型安全 | 新增 `CommandError` 枚举 (thiserror), 9 个变体覆盖所有错误域 |
| 67 | `686b7be` | `commands/mod.rs` | Win32 电源管理代码内嵌在 commands 中 | 抽取为独立 `system.rs` 模块 (`win32_power`) |
| 68 | `686b7be` | `commands/log.rs` | `export_terminal_log` 无路径校验 | 添加 `canonicalize().starts_with()` 作用域校验 |

### 前端工具

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 69 | `5224457` | `utils/hexUtils.ts` | HEX 解析逻辑分散, 3 个死导出 | 抽取 `hexUtils.ts` (`hexToString` / `stringToHex`), 移除死导出 |

### 前端 Store

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 70 | `cec426c` | `stores/useAppStore.ts` | god store 608 行, 55+ Actions 混在一起 | 拆分为 4 个 store: `useAppStore` (437 行), `useOperationStore` (55 行), `useTerminalStore` (49 行), `useRuleStore` (47 行) |
| 71 | `cec426c` | `stores/useAppStore.ts` | `removeEmptyPanes` 逻辑内联, 难以复用 | 抽取为独立 helper 函数 |

### 前端 Hooks

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 72 | `8944418` | `hooks/useTauri.ts` | `useSerialData` 同时管理收发, 生命周期混乱 | 拆分为 `useSerialReceive` (事件监听, App.tsx 调用一次) + `useSerialSend` (发送动作, OperationPanel 调用) |
| 73 | `8944418` | `hooks/useTauri.ts` | 13 处 `.catch(() => {})` 静默吞错 | 改为 `.catch(e => console.debug(...))` 保留可观测性 |

### 前端 UI

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 74 | `a724c05` | `components/ConfigModal/` | ConfigModal god component 450 行 | 拆分为 10 个文件: `ConfigModal.tsx` (109 行) + `RuleSetAccordion.tsx` (78 行) + 6 个 pages + 2 个 editors |
| 75 | `3ed0bab` | `components/OperationPanel/` | OperationPanel god component 410 行 | 拆分为 4 个文件: `OperationPanel.tsx` (138 行) + `SendSection.tsx` (136 行) + `ParamsSection.tsx` (137 行) + `RulesSection.tsx` (108 行) + `useCyclicSend` hook (119 行) |
| 76 | `e33bd30` | `components/Sidebar/` | Sidebar 435 行, 拖拽逻辑和别名对话框内联 | 抽取 `usePortDragEnd` hook (80 行) + `AliasDialog` 组件 (37 行) |
| 77 | `bbd4540` | `components/MainDisplay/` | MainDisplay 226 行, closeTab 绕过连接生命周期 | 拆分为 `MainDisplay.tsx` (132 行) + `Pane.tsx` (160 行) + `ResizeHandle.tsx` (34 行) + `useTabDragEnd` hook (73 行); closeTab 路由通过 `useSerialConnection.closePort()` |
| 78 | `bbd4540` | `components/MainDisplay/` | `setTimeout(0)` hack 绕过 Zustand 同步更新 | 移除, Zustand 是同步的, 直接更新即可 |
| 79 | `ef32ce0` | `styles.css` | styles.css 单体 1427 行, 20 个死 CSS class | 拆分为 11 个文件 (base/titlebar/sidebar/main-display/tabbar/terminal-view/operation-panel/status-bar/config-modal/context-menu), 移除 20 个死 class |

### 早期未修复项 (本次清零)

| # | Commit | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 29 | `cec426c` | `StatusBar.tsx:38` | memoryLimitMb=0 防御已添加但极端值未测 | store 拆分后操作字段隔离, 三元保护已验证 |
| 40 | `e33bd30` | `Sidebar.tsx:237` | `useSensors` 在 JSX 表达式中调用 | 抽取 `usePortDragEnd` hook 时移至组件顶层 |
| 44 | `a724c05` | `OperationPanel.tsx` | 缺少编码选择 UI 控件 | 编码选择已移至 TerminalView 工具栏, OperationPanel 拆分后不再需要 |

### 验证

- `npx tsc --noEmit`：0 errors
- `cargo check --manifest-path src-tauri/Cargo.toml`：0 errors, 0 warnings
- `npm run test:run`：71/71 passing (2 test files, 210ms)
- `cargo test --lib`：24/24 passing

## 已修复 (2026-05-24 批次二：虚拟滚动 / 导出 / 测试基线)

### 功能落地

| Commit | 范围 | 说明 |
|--------|------|------|
| `e0ec7ce` | `feat(ui)` | 终端虚拟滚动：`@tanstack/react-virtual@^3.13.15` 替换 naive `{lines.map}` 渲染。DOM 节点从 O(N) 降到 ~30–50（视口 + overscan 12）。保留智能跟随、scrollLocked 同步、HEX 模式、语法高亮、Ctrl+滚轮缩放、右键导出（直接读 store）。已注释说明：全选/复制仅覆盖视口可见行，完整导出走右键菜单。 |
| `4f1693e` | `feat(export)` | 终端导出从剪贴板改为真实文件保存对话框：新增 Rust 命令 `export_terminal_log(path, content)`（`std::fs::write`），前端 `logService.exportTerminalLog` + `@tauri-apps/plugin-dialog` `save()`。默认文件名 `<portId>-YYYYMMDD-HHMMSS.{txt,csv}`，取消静默返回，写入失败 `console.error`。复制/复制为 HEX/HEX 转文本仍走剪贴板。 |
| `35169aa` | `test(store)` | 前端测试基线：vitest 4.x（`environment: 'node'`，无 jsdom 依赖）。`src/stores/useAppStore.test.ts` 共 15 个测试覆盖 Port & Group（2）、Tabs & Panes（7）、Terminal lines（3）、Misc（3）。`npm run test:run` 156ms 通过。 |

### 顺手修的隐藏缺陷

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 57 | `src-tauri/capabilities/default.json` | OperationPanel.tsx:217 已经调用 `save()`，但 capabilities 仅声明 `dialog:allow-open`，缺 `dialog:allow-save`。dev 模式可能通过（开发权限放宽），production build 必被 ACL 拦截。 | 新增 `dialog:allow-save` 权限项。Tauri 自动 regen `src-tauri/gen/schemas/capabilities.json`。 |

### 验证

- `npm run test:run`：15/15 passing（156ms）
- `npx tsc --noEmit`：0 errors
- `npm run build`：✅ ~1.36s, 323KB（gzip 98.4KB）
- `cargo check`：0 errors, 0 warnings
- `ast-grep "$X as any"` in `src/`：0 matches
- `ast-grep "useAppStore()"` (无选择器调用)：0 matches

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
