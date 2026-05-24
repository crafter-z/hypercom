# 缺陷追踪

> 仅记录当前存在的未修复缺陷。已修复项移入变更历史。

## 未修复

### P1 — 重要

| # | 文件 | 问题 | 说明 |
|---|------|------|------|
| 48 | `OperationPanel.tsx:222` | **打开日志文件匹配错误** | `files.find(f => f.port_id === activeTabId \|\| f.path.includes(activeTabId))`：`COM1` 会命中 `COM10-*.log`，并且没有按时间取最新分片，可能打开旧文件。应改为精确匹配 `f.port_id === activeTabId` 后按 `created_at` 取最大值；如果还要兼容自定义文件名模板（见 #52），需先解出 `port_id`。 |
| 49 | `logger/mod.rs:41-60` + `useTauri.ts` | **日志写入硬编码 UTF-8 lossy，忽略终端编码选择** | `Write_line` 的 `string` 分支用 `String::from_utf8_lossy`，GBK/ISO-8859-1 数据会写成 U+FFFD 乱码。前端 TerminalView 已有 encoding 选择器但 `serial:data` 事件直发原始字节，写日志时未传 encoding。应在 `LogManager.Write` 增加 encoding 参数（或保留原始字节让前端二次导出时再解码）。 |
| 50 | `commands/mod.rs:262-285` | **首次 `get_system_status` CPU=0** | 改为缓存 `System` 增量刷新后，首次 `refresh_cpu_all` 没有基线，返回 0。需在 `lib.rs::setup` 中预热（先 `refresh_cpu_all` + 等 `MINIMUM_CPU_UPDATE_INTERVAL` ≈ 200ms + 再次刷新）或在命令内首次连续调用两次并间隔 sleep。 |

### P2 — 待优化

| # | 文件 | 问题 | 说明 |
|---|------|------|------|
| 29 | `StatusBar.tsx:38` | **memoryLimitMb=0 防御已添加但极端值未测** | 已添加三元保护，但 0 值场景未实际验证。 |
| 33 | `OperationPanel.tsx:472-474` | **波特率下拉只能选预设值 — 无自定义输入** | 需要添加 "其他..." 选项配合数字输入框。 |
| 34 | `Sidebar.tsx:387-388` | **一键连接/断开并行触发 — 无速率限制** | 多端口同时连接可能压垮后端。 |
| 44 | `OperationPanel.tsx` | **缺少编码选择 UI 控件** | Store 有 opEncoding 但面板无控件。编码选择已移至 TerminalView 工具栏。 |
| 51 | `Sidebar.tsx:389-411` | **跨组拖入"未分组"区域不调整全局顺序** | `handleDragEnd` 中当 `overGroupId === undefined`，只调用 `movePortToGroup(active, undefined)`，没有把 active 调到 `over` 旁边。结果端口被丢到未分组列表的当前位置（实际是不动），用户体验割裂。应在 `overGroupId` 为 `undefined` 时按全局 `ports` 数组对 active/over 做 `reorderPorts`。 |
| 52 | `logger/mod.rs:191-217` | **`list_files` 的 port_id 解析依赖固定分隔符** | `stem.split('-').next()` 只在文件名模板形如 `[com]-[datetime]` 时有效。用户若把 `filename_format` 改为 `log_[com]_[date]`，所有文件的 `port_id` 都会被解析成 `log_log`。建议存储一份 sidecar JSON 或在 `PortLogWriter` 内记录 port_id 并在 list 时直接读 active writers，文件名解析仅作 fallback。 |
| 53 | `logger/mod.rs:68-76` | **`LogManager.auto_save` 字段僵尸状态** | 字段标注 `#[allow(dead_code)]`，后端从不读取。前端基于 `config.autoSaveLog` 决定是否调用 `start_logging`，若两边状态不同步（如配置改后前端未重新触发），日志依旧会写。应让 `LogManager::Write()` 自身检查 `auto_save` 短路返回，或彻底删除该字段以避免歧义。 |
| 54 | `commands/mod.rs:211-238` | **`open_path` 无路径作用域校验** | 前端任何 invoke 都可让后端用系统资源管理器打开任意路径（包括 `C:\Windows\System32`）。虽然能力相当于"系统已装的文件管理器"，但违反最小权限。建议改为只允许路径前缀为 `LogManager.log_directory`，或拆分为 `open_log_directory` + `open_log_file(port_id)` 两个专用命令并删除通用 `open_path`。 |

### P3 — 小问题

| # | 文件 | 问题 | 说明 |
|---|------|------|------|
| 40 | `Sidebar.tsx:237` | **useSensors 在 JSX 表达式中调用** | 非惯用写法，应移至组件顶层。 |
| 41 | `serial/mod.rs:163` | **Unknown 端口类型映射为 virtual** | 可能误标真实硬件。 |
| 42 | `Sidebar.tsx:157` | **CSS 变量 --accent-color 未定义** | 使用 fallback 值 #4fc3f7，功能无影响。 |
| 43 | `useTauri.ts:219-220` | **TX 统计两次 getState()** | 应一次读取，理论可能在中间改变。 |
| 47 | `OperationPanel.tsx:106-160` | **循环发送切换命令集时索引不重置** | `% commands.length` 防越界但位置随机。 |
| 55 | `commands/mod.rs:218-222` | **Windows `explorer` 路径含逗号会被截断** | `explorer.exe` 对路径中含 `,` 的处理是把它当作多参数分隔符。日志目录默认在 `%AppData%` 一般没问题，但用户若把日志目录设到含逗号的路径，"打开目录"会失败。可加 `/select,` + 引号包裹规避（仅 Windows 分支）。 |
| 56 | `logger/mod.rs:159-164` | **分片后旧 BufWriter 仅 flush 不主动 drop** | `self.Writers.remove(port_id)` 会触发 Drop，已隐式 flush；但显式 `Writer.flush()?` 之后立刻 `remove` 是冗余，且 Drop 中的 flush 错误会被吞掉。建议显式 `into_inner()` 拿回 File 并 `sync_all()` 后再丢，确保 OS 落盘。 |

## 已修复 (2026-05-23 批量)

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| 16 | P2 | Sidebar 嵌套 DndContext，跨组拖拽不工作 | 重构为 Sidebar 顶层单一 `DndContext`，每个分组及未分组各持 `SortableContext`；`handleDragEnd` 统一处理同组重排与跨组移动（含调用 `movePortToGroup` + 调整 `portIds` 顺序） |
| 20 | P2 | `get_system_status` 每次 `System::new_all()` + `refresh_all()` | `AppState` 新增缓存的 `system_info: Mutex<sysinfo::System>`；命令改为增量刷新（仅本进程 + `refresh_cpu_all`） |
| 24 | P2 | Pane 订阅整个 `terminals` 对象 | 计算 `displayTabId` 后改用按需选择器 `useAppStore(s => s.terminals[displayTabId])`，单 Pane 只在自己的终端数据变化时重渲染 |
| 28 | P2 | `get_traffic_stats` 返回 (0,0) 占位 | 仍未处理 — 见 P2 列表 |
| -- | -- | 日志"打开文件 / 打开目录"命令未暴露 | 新增 `open_path`、`open_log_directory` 两个 Tauri 命令；`LogManager` 增加 `get_directory()`；前端 `logService` 改用新命令，绕开 shell 插件作用域限制 |

## 已修复 (2026-05-21 批量)

| # | 级别 | 问题 | 修复 |
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
| 30 | P2 | 串口超时错误导致读线程退出 | 添加 TimedOut 错误处理 continue |
| 31 | P2 | close_port 持锁 thread.join() | 此项暂不修复（影响较小，100ms 超时） |
| 36 | P2 | system status 硬编码中文 | 改为 "normal"/"high_load" 状态码，前端本地化 |
| 37 | P2 | closeTabsToRight/Left/Others 不跳过 pinned | 过滤 isPinned 标签 |
| 39 | P3 | formatTimestamp 组件内重建 | 移至模块级函数 |