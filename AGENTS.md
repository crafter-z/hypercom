# PROJECT KNOWLEDGE BASE — HyperCom

**Generated:** 2026-08-06 · **Aligned to code:** 2026-09-25（重构后全量复核）· **Stack:** Tauri v2 (2.11.x) + React 18 + Rust (tokio + serialport)

> **引用纪律**：本文只写「文件 + 符号名」，**不写行号**。行号随每次重构必然腐化，是上一轮审计整片漂移的根因。
> **数字断言**（命令数 / 配置字段数 / i18n 键数 / hook 数 / store 数 / services 文件数）以代码为准；改动后需同步本文件。
> **两类内容**：`## 当前架构` 描述**现状**；`## 版本历史记忆` 是**历史叙事**（记录各版本发布时的状态）。两者冲突时**一律以「当前架构」为准**。

## OVERVIEW

HyperCom — 现代串口调试工具。Rust 管 I/O，React 管 UI。**6 个 Zustand store**（`useAppStore` / `useOperationStore` / `useTerminalStore` / `useRuleStore` / `useSystemStore` / `useToastStore`）；**15 个 hook** 各自成文件于 `src/hooks/`（另有 barrel `index.ts` 与 `disconnectTracking.ts`）承载 Tauri 桥。后端 **11 个命令域文件 + `CommandError`**，`lib.rs` 注册 **64 个命令**。`paneTree: PaneNode`（递归树）自 2026-07 取代平铺 `panes`；**树算法在 `src/utils/paneTree.ts`**，不在 store 里。每标签显示态（scrollLocked/displayFormat/encoding/showTimestamp）在 `useTerminalStore`，**不在** `useOperationStore`。窗口装饰关闭——自定义 TitleBar 驱动窗口控件。条件触发引擎（pattern → alert/auto-respond，按 `portId` 限定端口，在 `useSerialReceive` 接线）。

## 当前架构

### Rust 后端

**模块布局**（重构后按职责拆文件；`mod.rs` 只留门面与注册表）：

```
src-tauri/src/
├── main.rs / lib.rs      # entrypoint；lib.rs = AppState + generate_handler!（64 命令）+ setup
├── system.rs             # 跨平台电源管理：共享状态机骨架 + win32_backend / child_process_backend
├── diaglog.rs            # 应用自身诊断日志（512KB 轮转 × 3 份）
├── serial/               # mod.rs（SerialManager 注册表 + 策略）/ codec.rs（TX 编码 + build_tx_bytes）
│                         # events.rs / ports_real.rs / ports_sim.rs（SIM:Loopback）/ ports_tty.rs（GIT: 路由）
│                         # tty_sim.rs（portable-pty，Windows = ConPTY）
├── logger/               # mod.rs（门面 + LogFileInfo）/ settings.rs（LogSettings::from_config）
│                         # naming.rs（路径模板/子目录/唯一化 allocate_file）/ assembler.rs（LogLineAssembler）
│                         # writer.rs（PortLogWriter + 分片 decode_bytes）/ manager.rs（LogManager::apply_settings）
├── config/               # mod.rs（AppConfig + Entities + CONFIG_BOUNDS + 校验/路径/备份/会话快照）
└── commands/             # mod.rs（CommandError）+ 11 个域文件
```

- **端口类别分派只有一个入口**：`serial::PortKind::of(port_id)`（`Real` / `Sim` / `Tty`）——Rust 侧**没有** `starts_with("GIT:")` 字符串分派（前端仅两处按 `portId.startsWith('GIT:')` 判定是否走 pty 路径：`ttyService.resize`/`resync` 推 pty 尺寸、`TtyView` 过滤 xterm 的 DSR 应答）。
- **虚拟端口门控在分派之前执行**：`check_virtual_enabled(kind, simulate, gitbash_sim)`——`Real` 恒通过、`Sim` 需 `simulate`、`Tty` 需 `gitbash_sim`；类型与开关不匹配直接报错（有单测）。
- **日志设置唯一入口**：`LogSettings::from_config(&AppConfig)` + `LogManager::apply_settings(&LogSettings)`，由 `AppState::apply_runtime_config(&AppConfig)` 统一调用（`AppState::new` 与 `set_config` 共用，另含 `DiagLogger::set_enabled`）——配置 → 运行期状态只有这一条路径。旧的逐字段 `set_log_*` 命令（6 个）、`sync_log_manager_from_config`、前端 `syncLogSettingsToBackend` **全部已删**；`set_config` 是唯一同步点。
- **`AppState`**（`lib.rs`）：`serial_manager: Arc<Mutex<SerialManager>>`、`config_manager: Mutex<ConfigManager>`、**`log_manager: Arc<LogManager>`（无外层 Mutex——写路径是 `&self` + 内部细粒度锁，`save_log_as` 拷贝 / `list_files` 递归 / RX 写入不争同一把锁）**、`diag_logger: Arc<DiagLogger>`、`system_info: Arc<Mutex<System>>`、`tool_processes` / `file_send_cancel` / `popouts`（`Mutex<HashMap<..>>`）。
- **调试能力门控的唯一实现**：`commands/system_cmds.rs` 的 `dev_only(capability)` / `is_debug_build()`。命令体不得再写 `#[cfg(debug_assertions)]` 双主体。
- **命令注册漂移守卫**：`config/mod.rs` 的 `test_generate_handler_matches_tauri_command_attribute` 解析 `lib.rs` 的 `generate_handler![...]`，与全仓 `#[tauri::command]` 函数名比对——漏注册/多注册即红。
- **popout 命令按业务语义传参**：`open_popout(kind, target_id)` / `close_popout(kind, target_id)` / `set_popout_always_on_top(kind, target_id, on)`；**label 只在 Rust 计算**（`commands/popout.rs` 的 `sanitize` / `compute_label`），前端不再有 label 副本（`Popout/popoutLabel.ts` 已删）。

### 前端

```
src/
├── main.tsx / App.tsx        # entrypoints（App.tsx = AppInit + SerialReceive + 全局自定义文本右键菜单）
├── i18n.ts                   # i18next + react-i18next，扁平 dotted key（keySeparator:false），537 键 × zh-CN/en-US
├── services/                 # 12 文件：tauri.ts（barrel）+ 11 域（serial/config/log/storage/popout/update/system/diag/file/tool/event）
├── hooks/                    # 15 个 hook 文件 + barrel index.ts + disconnectTracking.ts
├── stores/                   # 6 个 store 模块 + releaseTerminalState.ts + resetStores.ts
├── utils/                    # 纯函数与引擎（highlightEngine / protocolParser / triggerEngine / rxAssembler / rxPipeline /
│                             # lineText / hexFormat / hexUtils / sendUtils / sendStrip / textSend / sendGuard / followLogic /
│                             # lineFilter / terminalSearch / paneTree / bounds / sequential / clampNumber / jsHeap / portSort /
│                             # groupTool / trafficStats / logReplay / sessionSnapshot / diagLog / devMode / updateService / channel / changelog）
│   └── terminal/             # 方案B 引擎：TerminalBuffer / TerminalRenderer / viewportManager（见子目录 AGENTS.md）
├── types/index.ts
└── components/               # MainDisplay / ConfigModal / OperationPanel / Sidebar / TitleBar / StatusBar / Popout / shared
```

**新增/迁移的前端模块**（新代码优先复用；勿再造第二份实现）：

| 模块 | 职责 |
|---|---|
| `utils/paneTree.ts` | `PaneNode` 树算法：`newPaneId` / `findLeafById` / `findLeafByTabId` / `findBranchById` / `findParentBranch` / `collectLeaves` / `countLeaves` / `pruneTree`。store 只留 action；`useAppStore` 另导出 `getClosingTabIds(tabId, scope)` 供批量关闭取与 store 关闭动作同一集合 |
| `utils/hexFormat.ts` | `hexByte` / `bytesToSpacedHex`——**bytes→HEX 的唯一实现**（terminalSearch / protocolRenderer / sendUtils / triggerEngine / TerminalRenderer 共用） |
| `utils/bounds.ts` | `CONFIG_BOUNDS` / `BoundedNumericSetting`——数值边界的前端镜像 |
| `utils/sequential.ts` | `runSequential<T>`——串行发送/循环的通用次序原语 |
| `stores/useSystemStore.ts` | `systemStatus` / `trafficStats` / `simulationMode` / `ui` + `setSystemStatus` / `setTrafficStats` / `clearTrafficStats` / `setSimulationMode` / `setUIState` / `toggleConfigModal` / `setConfigActiveTab`——**从 `useAppStore` 拆出** |
| `stores/releaseTerminalState.ts` | `releaseTerminalState(portId)`：统一回收该端口的 terminals / trafficStats / TX 历史（`useTerminalStore.releaseTerminal` 只应由它调用） |
| `ConfigModal/hooks/useEntityPage.ts` | 5 个实体页（高亮/命令集/协议模板/工具配置/触发规则）共用的 load / dirty-track / save / delete 契约（挂载全量加载并替换 store，除非加载期间用户已改动；`savedSnapshotRef` 为最后已知持久化态） |
| `OperationPanel/hooks/useSequentialSend.ts` | **循环发送两套状态机合一**（原弹窗侧与面板侧的分叉已消除） |
| `OperationPanel/hooks/{useHexCompose,useFileSend,useQuickStripLayout,useSendHistoryRecall}.ts` | HEX 组包 / 文件发送（守卫 + TX 统计）/ 快捷条宽度自适应（`utils/sendStrip.ts` `computeFitCount`）/ 发送历史回溯 |
| `shared/{useOutsideDismiss,useDragResize,menuPlacement}.ts` | 三个共享交互原语：外点关闭 / 拖拽调整尺寸 / 菜单定位（勿在各组件内手写第五份） |
| `Popout/{usePopoutSync,usePanelTextConfig,usePortSerialFeed}.ts` | 弹窗↔主窗同步（命令集/活动标签/端口状态事件总线）/ 面板文本配置 / 终端弹窗 RX 喂入（快照交接 + 时间戳闸门防重复） |

### 单一来源（single source of truth）

| 对象 | 唯一来源 | 守卫 |
|---|---|---|
| 数值边界（字号/行数上限/分片大小/图片不透明度…） | Rust `config/mod.rs` 的 `pub const CONFIG_BOUNDS: &[(&str, i64, i64)]`；`validate_and_clamp` 经 `clamp_bound(name, …)` 查表（散落的 clamp 字面量已删） | 前端 `src/utils/bounds.ts` 镜像；`src/utils/bounds.test.ts` 用 `?raw` 解析 Rust 源文本，断言两侧键集合与数值逐项相等 |
| 全量配置保存 | `useConfigPersistence.saveConfig(patch?)`——内部**始终**现场拼装安全快照（见「config 实体快照陷阱」） | 无第二个全量保存实现 |
| 日志设置 | `LogSettings::from_config` + `LogManager::apply_settings` | 无第二条同步路径 |
| 解码（bytes→文本） | `src/utils/lineText.ts` 的 `createDecoder` / `decodeBytes`（唯一 TextDecoder 工厂 + 模块级按 label 缓存，`ignoreBOM: false`） | `ttyService` 的流式解码器由同一工厂构建（持残字节故 per-port 独占） |
| bytes→HEX | `src/utils/hexFormat.ts` | 全仓唯一实现 |
| 端口类别 / 调试能力 | `PortKind::of` / `dev_only()` + `is_debug_build()` | 见上「Rust 后端」 |

### 行为口径（近期变更，易踩）

1. **HEX 输入奇数位是错误态**：`sendUtils` 的 `sanitizeHexInput` / `parseHexBytes` 为严格模式——奇数位 nibble 与非 HEX 字符一律产出空（**不再补零**），与后端拒绝口径一致。
2. **解码统一 `ignoreBOM: false`**：行首 BOM 被剥离（它是编码标记，不是内容），不进入行文本/搜索/复制。
3. **文件发送走 `isSendablePort` 守卫**（不可发送连文件框都不弹）且**按增量计入 `trafficStats` TX**；成功 toast 只在 `done` 事件 `sent >= total > 0` 时弹，取消/空文件静默清条。
4. **弹窗改命令集经 `popout:command-set-updated` 整集回传主窗**，写回 `useRuleStore` 活实体。
5. **全量保存走安全快照**：`saveConfig(patch?)` 从 `useAppStore`（标量 + groups）+ `useRuleStore`（5 个活实体）+ `collectPortMeta(ports)` + 后端读回的 `portPresets` 现场拼装；旧 `mergeLiveRuleEntities` / `utils/configMerge.ts` 已删（职责内化，调用点不再需要手动合并）。
6. **TTY 无本地回显**：`sendToPort` 的 TTY 分支跳过 TX 回显与 `flushNow`（仍走后端发送/流量统计/历史）；pty 写做回车归一（`\r\n` → 单个 `\r`）。
7. **关闭标签页保留串口连接**：`Pane.cleanupClosedTab` → `getRxPipeline().disconnect(tabId)` + `ttyService.detach(tabId)` + `releaseViewportManager` + `releaseTerminalState(portId)`；批量关闭先用 `getClosingTabIds(tabId, scope)` 取同一集合，两处不会漂移。

## STRUCTURE

```
hypercom/
├── src/                          # React frontend
│   ├── main.tsx, App.tsx         # entrypoints (App.tsx owns AppInit + SerialReceive + global custom text-edit context menu)
│   ├── i18n.ts                   # i18next + react-i18next, 537 keys × zh-CN/en-US
│   ├── services/                 # invoke wrapper layer: tauri.ts barrel + 11 domain files
│   ├── hooks/                    # 15 hooks in individual files + barrel index.ts + disconnectTracking.ts
│   ├── stores/                   # 6 store modules (no god store; useTerminalStore 已去 Immer)
│   │   ├── useAppStore.ts        # tabs / ports / paneTree / config / groups + actions（无树算法、无 system/ui 状态）
│   │   ├── useOperationStore.ts  # serial params + send (NO `op` prefix; NO display state fields)
│   │   ├── useTerminalStore.ts   # 纯显示态（scrollLocked/showTimestamp/displayFormat/encoding/connectedAt）
│   │   ├── useRuleStore.ts       # highlight + send-command + protocol + tool + trigger rule sets + CRUD
│   │   ├── useSystemStore.ts     # systemStatus / trafficStats / simulationMode / ui
│   │   ├── useToastStore.ts      # 通知队列（sticky / stashed）
│   │   ├── releaseTerminalState.ts  # 关闭端口/标签时统一回收显示与统计状态
│   │   └── resetStores.ts        # 测试/生命周期用整仓重置
│   ├── utils/                    # 纯函数引擎 + tests（含 hexFormat / bounds / paneTree / sequential / lineText）
│   │   └── terminal/             # 方案B 终端引擎：TerminalBuffer / TerminalRenderer / viewportManager
│   ├── types/index.ts            # shared TS types
│   └── components/               # MainDisplay / ConfigModal / OperationPanel / Sidebar / TitleBar / StatusBar / Popout / shared
├── src-tauri/src/                # Rust backend
│   ├── main.rs, lib.rs           # entrypoint + AppState + command registration + setup
│   ├── system.rs                 # 电源管理共享骨架 + win32_backend / child_process_backend
│   ├── diaglog.rs                # 应用自身诊断日志（全局 log::Log，落盘 + 轮转 + 读/清/追加）
│   ├── commands/                 # 11 domain files + mod.rs (CommandError enum + re-exports)
│   ├── serial/                   # mod / codec / events / ports_real / ports_sim / ports_tty / tty_sim
│   ├── logger/                   # mod / settings / naming / assembler / writer / manager
│   └── config/mod.rs             # config.json + Entities(8 数组) + CONFIG_BOUNDS + session.json + 校验/路径/备份
├── docs/                         # design & architecture docs (see "Key design reference" below)
│   ├── architecture/             # README 索引 + serial/terminal/tty/transmission/logging/config/workspace/update/release/errors
│   └── userwiki/                 # 面向普通用户的说明文件（暂空）
└── .github/workflows/            # ci.yml（push/PR 质量门）+ publish.yml + publish-preview.yml
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add frontend state field | `src/stores/use{App,Operation,Terminal,Rule,System}Store.ts` | pick correct store only; god store is deprecated |
| Add Tauri command | `src-tauri/src/commands/<domain>.rs` + register in `lib.rs` `generate_handler!` | return `Result<T, CommandError>`, NOT `String`；漂移守卫测试会核对注册 |
| Cross `.await` lock | extract + clone + drop the `MutexGuard` first | see pattern in `commands/log.rs`；`log_manager` 是 `Arc<LogManager>`，不需要锁 |
| Add serial hook | `src/hooks/<hookName>.ts` + export from `index.ts` | 15-hook 家族 + 各自的清理生命周期；do not revive `useSerialData`-style |
| 应用自身诊断日志 | `src-tauri/src/diaglog.rs` + `commands/diag.rs` + `src/utils/diagLog.ts` + `shared/DiagnosticLogDialog.tsx` | 后端 `log::*` + 前端 `console.*`（`setupDiagLogCapture` 拦截转发）统一落盘 `%APPDATA%/hypercom/diag/hypercom-debug.log`（512KB 轮转保留 3 份）；查看入口在「关于 → 诊断日志」，开关 `config.diagLogEnabled` |
| Split pane recursively | `useAppStore.splitPane` action | NO flat `state.panes` anywhere |
| Pane tree traversal | `src/utils/paneTree.ts`（`findLeafById` … `countLeaves`；批量关闭集合 `useAppStore.getClosingTabIds`） | do not hand-roll tree walks |
| Highlight engine | `src/utils/highlightEngine.ts` + tests | state in `useRuleStore`, persisted via `storageService` |
| ConfigModal page edit | `src/components/ConfigModal/pages/*.tsx` + `hooks/useEntityPage.ts` | rule state in `useRuleStore`; persisted via config.json (`storageService` wraps config-backed commands) |
| Cyclic send | `src/components/OperationPanel/hooks/{useCyclicSend,useSequentialSend}.ts` | reads `useRuleStore.sendCommandSets` via `getState`；每端口运行开关 `useOperationStore.cyclicLoops` + `setCyclicLoop`; timing via per-command `delay` + set `loopDelay` only |
| 命令发送区 / 快捷发送条 / 命令面板 | `OperationPanel/SendSection.tsx` + `Popout/QuickSendPanel.tsx` + `hooks/useSerialSend.ts` | 快捷条 pill 两行显示（`.op-quick-cmd-name-row` 在上、`.op-quick-cmd-content` 在下）、宽度自适应（`utils/sendStrip.ts` `computeFitCount`）、首槽固定「打开命令面板」按钮（accent 填充按压按钮 + `quickSend.openPanelShort`）；`quickSendInlineCount` 仅 0=隐藏条；QuickSendPanel 双模式（列表+行内编辑 / 文本逐行发送，运行方式由 `useSequentialSend` 统一驱动）；目标串口下拉只显示串口号；底栏「发送到」灯订阅 `serial:status` + `port-statuses:sync` 对表；`sendToPort` 经 `utils/sendGuard.ts` 守卫未打开端口 |
| Cross-platform power | `src-tauri/src/system.rs` | 共享状态机 + `win32_backend`（`SetThreadExecutionState` FFI）/ `child_process_backend`（`caffeinate` / `systemd-inhibit` 抑制子进程） |
| 自定义背景图（issue #13） | `ThemeProvider.tsx`（CSS var + `data-app-bg` 门控）/ `styles/background.css`（毛玻璃 token 覆盖）/ `commands/file.rs` `read_image_data_url`（data URL） | 配置四字段存 config.json；路径经后端读为 base64 data URL（不走 asset protocol）；`html[data-app-bg="on"]` 时 `--bg-*` token 换半透明 rgba 实现全窗毛玻璃；xterm 背景在 TtyView 内按 config 活更新 |
| Multi-encoding | backend `encoding_rs::GBK`（**仅日志文件写出编码**）, frontend `src/utils/lineText.ts` + `setTerminalEncoding` | `serial:data` 载**原始字节**（`Vec<u8>`），前端按 encoding label 惰性解码：RX 行只存 `rawData`，渲染/搜索/过滤/复制在读取该行时才解码（`ignoreBOM: false`）。切换编码只改 label，无存量行遍历、无需清解码器缓存 |
| RX 高频接收管线 | `src/utils/rxAssembler.ts` + `rxPipeline.ts` | 字节级行聚合（CR/LF/跨事件 CRLF/4KB 强制发射）+ rAF 批写 + 250ms 静默 flush（时间戳=最后事件时间）+ **写量限制** `maxLinesPerTick`（默认 2000：每端口每帧最多写 N 行超出顺延；`flushNow` 同步最多排空 N 行其余 rAF 续写）+ **visibility-aware 排空**：document.hidden 时 rAF 停摆 → setTimeout 兜底 + visibilitychange 重排；每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧）；`getRxPipeline()` 每 webview 一个单例，cleanup 不得 dispose |
| TTY 模式管线 | `src/utils/ttyService.ts` + `TtyView.tsx` | 每端口 `mode:'tty'` 的 RX/TX 服务单例（镜像 `getRxPipeline()` 模块单例）：`serial:data` 字节经同一 `createDecoder` 工厂的流式 UTF-8 解码（缓冲跨事件多字节字符）→ 每端口队列 → visibility-aware 批写 `term.write`（页面可见 rAF、隐藏 setTimeout 兜底）+ 队列上限 `MAX_TTY_QUEUE`（10000 丢最旧）；`attach`/`detach`/`feed`/`clear`/`disconnect`（断线 flush 保留 term 跨重连）/`send`（onData→send_serial_data，失败仅 console.error 不弹 toast）/`resize`（仅 GIT: 走后端 pty resize）；TX 刻意不经过 `sendToPort`（无本地回显） |
| TTY 视图 / 渲染分流 | `TtyView.tsx` + `Pane.tsx` | `Pane` 对当前 Pane 内**所有 TTY 标签常驻挂载** TtyView（xterm + FitAddon，ResizeObserver + rAF 防抖 fit，onData→`ttyService.send`、onResize→`ttyService.resize`），非活动标签传 `hidden` → `.tty-view-hidden`（display:none），恢复可见显式 re-fit——**会话跨标签切换保留**；TRX 标签照旧只在展示时挂载 TerminalView；`displayPort?.mode !== 'tty'` 才渲染 TerminalView；TTY 端口阻止弹出窗（`Pane.handlePopOut` 提示 `tty.popoutUnsupported`，弹出窗是独立 webview 不共享 ttyService/xterm 实例） |
| 模式开关（TRX/TTY） | `OperationPanel/ParamsSection.tsx` + `useAppStore.setPortMode` | 分段控件写 `port.mode`（经 `port_meta` 持久化）；切换副作用=清 TerminalStore + `getRxPipeline().flushAndReset` + `ttyService.clear`，避免旧模式 buffered 数据混入新模式首屏 |
| 内存上限 / 终端缓冲裁剪 | `utils/terminal/TerminalBuffer.ts` + `viewportManager.ts` + `config.maxDisplayLines` + `rxPipeline.ts` | `maxDisplayLines`=每端口终端最大显示行数（默认 100000，由 `CONFIG_BOUNDS` clamp [1000,1000000]）；缓冲超限**逐行覆盖最旧**（滚动窗口）；无字节预算/软兜底/内存裁剪 toast。前端 `defaultConfig.maxDisplayLines` 与 Rust `AppConfig::default` 两侧同步 |
|日志保存子目录 / RX 日志行组装|`logger/manager.rs` + `logger/assembler.rs` + `logger/naming.rs` `subdir_component` + `config/mod.rs` `log_subdir_mode` + `LogSettings.tsx`|`logSubdirMode: 'none'|'date'|'port'`（默认 `date`，非法值 clamp 回 date）→ 路径 join（create_dir_all）+ `LogManager::list_files` 递归（`MAX_LIST_DEPTH`）；RX 日志经 `LogManager::write_rx` + `LogLineAssembler` 字节级组行（镜像前端 rxAssembler，250ms 陈旧尾 flush），不再按读取块一行 |
|每次打开串口新建日志文件|`logger/manager.rs` `create_writer_with_encoding` + `logger/naming.rs` `allocate_file` + `config/mod.rs` `log_new_file_per_session` + `LogSettings.tsx`|`logNewFilePerSession`（默认关，保持续写行为）开启后：每次建 writer（打开串口/重连）用 `create_new(true)` 原子分配**不存在**的文件（同名冲突 `name-1.log`/`name-2.log`… 后缀，数字插扩展名前），绝不续写；**split 续片强制唯一化（与开关无关）**——粗粒度模板（`[com]`/`[com]-[date]`）下 append 重开刚关闭的超阈值文件会令 current_size 从超阈值初始化、每写必分片（死循环）。同步点唯一：`set_config` → `AppState::apply_runtime_config` → `LogManager::apply_settings`|
| 滚动锁定 / 快捷跳转 | `TerminalView.tsx` + `utils/followLogic.ts` + `.terminal-jump-btn` | `scrollLocked` 仅由图钉按钮/跳转按钮/手势 settle 写入，**无 onScroll 隐式解锁**；跟随路径由 `TerminalRenderer` **同帧钉底**（render() 内写 scrollTop，无 React effect、无双 rAF 链；搜索栏打开时 followEnabled=false 抑制）；settle/抑制/锁定迁移逻辑下沉纯函数 `isAtBottom` / `shouldFollow`（钉底目标值在 renderer 内联计算，无第二份纯函数拷贝）；到顶/搜索跳转走 manager 的 `scrollToSeq(seq, align)` / `scrollToBottom()`（方案B 已无第三方虚拟化）；跳转按钮钉在滚动条两端（到顶解锁、到底锁定跟随） |
| DisconnectBanner | `src/components/StatusBar/DisconnectBanner.tsx` + `hooks/disconnectTracking.ts` `isPortLost`/`filterLostTabIds` | suppresses startup false alarm for session-restored tabs |
| Conditional triggers | `src/utils/triggerEngine.ts` + `useRuleStore.triggerRules` + `ConfigModal/pages/TriggerSettings.tsx` + `StatusBar/NotificationCenter.tsx` | pattern match (contains/exact/regex/hex) → alert/auto-respond; per-port via `portId` (empty=all); **wired in `useSerialReceive`**; alert 是 sticky toast 显示 `rule.actionContent`（`durationMs:0` 不自动关闭，标题带端口/规则上下文）；规则 300ms 防抖逐条自动落盘 |
| 通知中心 / toast | `src/stores/useToastStore.ts` + `src/components/StatusBar/NotificationCenter.tsx` | `durationMs === 0` = 粘滞（Toast.tsx 跳过自动关闭计时）；超过 `MAX_VISIBLE=5` 进 `stashed` 溢出队列不丢弃；`clearAll()` / `setCenterOpen` + `centerOpen`；铃铛+badge 挂 StatusBar `.statusbar-right`，外点/Escape 关闭，样式 `notification-center.css`；`ToastItem.portId?`——串口来源消息（触发告警/断线/发送目标关闭/重连失败）携带串口号，通知行显示 `.notify-row-port` chip + `.notify-row-time` HH:MM:SS 时间戳 |
| Add translation | `src/i18n.ts` | add key under `zh-CN` and `en-US`; don't translate protocol acronyms (None/Even/Xon/RTS/GBK/...)；`src/i18n.test.ts` 断言双侧键集合相等、顺序镜像、无重复、非空、占位符一致 |
| Loopback virtual port | `useSimulation` hook + `commands/simulation.rs` | flask icon in sidebar toolbar |
| 自动更新（issue #12） | `commands/update.rs` + `hooks/useAutoUpdate.ts` + `utils/updateService.ts` + `utils/channel.ts` + `shared/UpdateDialog.tsx` | **通道是运行时用户选择**：`updateCheckMode: none/stable/preview`（config.json，默认 stable；About 手动检查可选通道且不过 DEV 门控）。JS `check()` 无运行时 endpoint → 命令走 Rust `updater_builder().endpoints(vec![..])`：stable 直连 `releases/latest/download/latest.json`（GitHub「最新非 prerelease」指针，永不泄漏 preview）；preview 先 `api.github.com/releases?per_page=100` 解析**版本号最大**的 `vX.Y.Z-preview.N` tag（纯函数 `find_latest_preview_tag`，数值四元组比较；未认证限流 60/h/IP 超限静默降级）再 tag-pinned，并取 max(preview, stable)。自动检查：`useAutoUpdate` 等 `ui.configReady` 信号（`useConfigPersistence.loadConfig` 完成置位，15s 兜底）后评估——替代旧 3s 启发式窗口；7 天周期 + `shouldAutoCheck` 纯函数（首启立即/snooze 暂停/成功才记 lastCheckAt（完成时刻），localStorage 记账）；会话内每 6h 重评估；`UpdateDialog` 三动作（立即更新进度+relaunch/7 天后写 snooze/永不提醒同步 mode=none 全量保存；下载中遮罩/X/按钮均不可关闭）。`commands/update.rs` 在 debug 构建经 `is_debug_build()` 返回 `Ok(None)`（自动检查前端另有 `import.meta.env.DEV` 短路；**手动检查不过 DEV 门控**——显式意图）。详 `docs/architecture/update.md` |
| External tool (flasher) | `commands/serial.rs` `run_port_tool`/`kill_port_tool` + `useToolOutput` hook + `ToolSettings` page | close→spawn→stream→reopen 闭环；`{port}` 模板替换；配置在设置弹窗「外部工具」页；触发在侧边栏右键菜单 |
| 分组整组执行外部工具 | `Sidebar.tsx` 分组右键菜单 + `shared/GroupToolDialog.tsx` + `usePortToolActions.runToolForGroup` | 分组菜单 `sidebar.group.contextMenu.runTool` → 对话框列出配置/未配置端口（Cancel / Configure Missing / Run Configured Only）；严格配置判定=配置存在+portId 匹配+`command.trim() !== ''`；`utils/groupTool.ts` `partitionGroupPorts` 纯函数；**`Promise.all` 并行**运行已配置端口（跳过运行中端口，单端口失败不中断整组）。`usePortToolActions` 返回 `runTool` / `killTool` / `configTool` / `runToolForGroup` / `toolDialog` / `closeToolDialog` / `runToolDialogConfigured` / `configureToolFromDialog`（不返回组件） |
| Resize operation panel | `src/components/shared/OperationPanelResizeHandle.tsx` + `useSystemStore` `ui.operationPanelHeight` | vertical drag handle between MainDisplay and OperationPanel; default 280px, clamp [160,600] |
| 标签页批量开关串口 / 标签外部工具菜单 | `TabBar.tsx` 右键菜单 + `Pane.tsx` 接线 + `usePortToolActions` | 「打开/断开所有标签页」遍历全局 tabs 逐个 open/close（`utils/sequential.ts` `runSequential`）；工具三入口与侧边栏同源（`usePortToolActions`），文案复用 `sidebar.port.contextMenu.*` key |
| 串口分组持久化 | `config/mod.rs` `entities.port_groups` + `commands/storage.rs` `save_port_groups` + `useAppInit` | 分组是 config 实体之一；启动经 `get_config` 恢复并回填 `ports.groupId`；groups 变更 500ms 防抖自动保存（无手动「保存布局」按钮） |
| 端口自然排序 | `src/utils/portSort.ts` + `useAppStore.sortPortsByNumber` | `naturalCompare` 数字段按数值比较（COM1<COM2<COM12）；排序是**一次性动作** `sortPortsByNumber()`（重排 ports + 各分组 portIds，幂等、不重置 groupId），Sidebar 无持久 sortMode 开关，拖拽/分组始终可用；组内顺序随 `save_port_groups` 持久化、未分组顺序不保存；`mergePorts` 按 existing 顺序合并，轮询不冲掉顺序 |
| 串口右键菜单分组控制 | `Sidebar.tsx` + `useAppStore.ts` | 按端口分组态动态渲染菜单项：未分组且有组→逐组「移入分组『{{name}}』」；未分组无组→「新建分组并移入」；已在组里→「移出分组」；i18n keys `sidebar.port.contextMenu.{removeFromGroup,addToGroup,createGroupWithPort}` |
| 发送异步化 | `commands/serial.rs` `send_serial_data` + `lib.rs` `AppState` | `send_serial_data` 是 async fn + `tokio::task::spawn_blocking`（原同步命令在事件循环主线程执行 write_all+日志写→每次 TX 卡顿 + tao `NewEvents`/`RedrawEventsCleared` 警告白屏）；`AppState.serial_manager` 为 `Arc<Mutex<..>>`（Deref 使 `.lock()` 调用点零改动）；`send_file` 本就是 async（tokio::fs::read + 分块 yield）；**写路径读写句柄分离 + 无界 flush 摘除**：`SerialPortHandle` try_clone（Windows = DuplicateHandle）拆 read_port/write_port；热路径不再 `flush()`（FlushFileBuffers 无超时受流控约束）+ `write_all_with_deadline` 总写期限（2s）；两段式发送（全局锁内只取写句柄克隆，锁外只持 per-port 写锁写） |
| 模拟串口仅调试模式 | `src/utils/devMode.ts` + `commands/simulation.rs` | 前端 `DEV_FEATURES_ENABLED = import.meta.env.DEV` 隐藏全部 SIM UI；后端经 `dev_only()` / `is_debug_build()` 拒绝（release）；仅 `npm run tauri dev` 可用 |
| 模拟终端 git bash | `src-tauri/src/serial/tty_sim.rs` + `serial/ports_tty.rs` + `commands/tty_sim.rs` + `hooks/useGitBashSim.ts` | 调试专用 GIT:BASH 虚拟串口——portable-pty（Windows = ConPTY）spawn 本地 git bash pty，pty stdout→`serial:data`（RX）、`send_serial_data`→pty stdin（TX）；`find_bash`/`spawn_bash`/`TtySimPortHandle`（writer/master/child/读线程）；`SerialManager` `gitbash_sim`/`tty_sim_ports` 字段 + `PortKind::Tty` 路由（open/send/write_raw/close/resize）；**打开时携带前端 xterm 尺寸**（`OpenPortArgs.cols/rows`，spawn 即正确尺寸，否则 pty 固定 80×24 致 vim/top 全屏错乱）+ 连接后 `ttyService.resync` 保险；**读线程应答 DSR**（`\x1b[6n`→`\x1b[1;1R`，`scan_dsr` 跨 chunk 检测）——bash/readline 启动时阻塞等终端应答，TRX 模式无终端模拟器，后端不应答则命令全部不执行；应答 **`\x1b[1;1R`（新建会话真实光标位置）而非终端尺寸**——按尺寸应答会把提示符画到右下角「命令行未正确显示」；TTY 模式由 xterm 自动应答，前端 TtyView 对 GIT: 端口过滤 xterm 应答防双响应；**断线关闭 drop master**（ClosePseudoConsole → 读线程解除阻塞）+ `close_serial_port` 异步 join（读线程永久阻塞时也不冻结 UI）；门控走 `dev_only()` / `is_debug_build()` + 前端 `import.meta.env.DEV` |
| 终端搜索字符级高亮 | `terminalSearch.ts` `markSearchMatchesInHtml` | HTML tag/实体感知的 `<mark>` 叠加层，只在命中行应用；匹配计算**仅搜索栏打开时进行**，唯一实现在 `viewportManager.recomputeSearch`（新行 append 时匹配一次并入列，查询/编码变化才整缓冲重扫；头部裁剪只 bump offset）——无增量前缀缓存 |
| First-run config creation | `config/mod.rs` `ConfigManager::new` | config.json created on first run with default `AppConfig` (empty entity arrays); no database |
| Config schema & migration | `config/mod.rs`（容器级 `#[serde(default)]` + `strip_legacy_memory_budget_keys`） | **无 `configVersion` 字段、无版本分派**；旧 config.json 缺新字段 → 取 `impl Default`；已废的内存预算 key 在解析前物理删除 |
| Config path customization | CLI `--config` / `HYPERCOM_CONFIG` env / portable mode | resolution order in `ConfigManager::new` |
| Config validation | `config/mod.rs` `validate_and_clamp()` + `CONFIG_BOUNDS` | runs on `set_config` to enforce bounds（边界只有一张表） |
| Config backup / recovery | `config/mod.rs` `save()` writes `.bak` / `new()` falls back to `.bak` | corrupt JSON auto-recovered |
| Session snapshot update | `update_session_snapshot` dedicated command | writes separate `session.json` (not config.json); avoids full config save + `.bak` churn |
| 状态栏内存显示 | `commands/system_cmds.rs` `get_system_status` | **应用进程树级内存**：本进程+全部后代进程（含 WebView2/Chromium 子进程）RSS 之和（`collect_app_pids` 纯函数 + `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`）；CPU 仍系统级；`memory_used_mb`/`load_status` 纯函数（`load_status` 只按 CPU>90 判 high_load——内存总预算已删）；状态栏显示「JS堆 XMB · 进程 YMB」（无总预算分母） |
| ConfigModal 框选不关闭 | `ConfigModal.tsx` | overlay pointerdown 记录起点是否在弹窗内，click 时起点在弹窗内则忽略关闭（框选文字松手界外不再误关） |
| 通知中心面板 / 快捷发送 pill 样式 | `notification-center.css` + `operation-panel.css` | `.notify-panel` 加宽加高；`.op-quick-cmd` flex column：`.op-quick-cmd-name-row`（HEX 徽标+名称）在上、`.op-quick-cmd-content` 在下；`.notify-row-port`/`.notify-row-time`；`.op-quick-panel-btn` accent 填充按压按钮 + `.op-quick-panel-btn-label` |
| 自定义文本右键菜单 | `src/components/shared/TextEditContextMenu.tsx` + `App.tsx` / `PopoutShell.tsx` | 输入框/文本域/可编辑区右键显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选，`contextMenu.*` i18n）；`useTextEditContextMenu()` document 级拦截——可编辑目标 `preventDefault` + 弹自定义菜单（右键时快照选区，点击项先恢复焦点+选区再 `document.execCommand`），非可编辑目标一律 `preventDefault`；App 根 + PopoutShell 各挂一次；组件级 `onContextMenu`（stopPropagation 的终端行/侧边栏/标签页）不受影响 |
| 配置持久化审计（全量保存不丢实体） | `hooks/useConfigPersistence.ts` `saveConfig(patch?)` + `collectPortMeta` | `useAppStore.config` 的实体数组是**启动快照**、从不跟随 `useRuleStore`——全量保存**必须**走 `saveConfig()`：它内部现场拼装安全快照（标量 + `useRuleStore` 5 个活实体 + `state.groups` + `collectPortMeta(state.ports)` + 后端读回的 `portPresets`；读不到就不写，宁可不保存也不用陈旧快照覆盖磁盘）。`portPresets` 无 store 镜像（唯一写路径 `storageService.savePortPresets`）；`portGroups`/`portMeta` 已由 useAppInit 同步。**不要**再手写「先合并再 set_config」的调用点。唯一例外：「备份设置 → 导入配置」（`BackupSettings.handleImport`）按备份 bundle 整体写回 `set_config` 后 reload——那是恢复语义，不是编辑保存 |
| CI / 质量门 | `.github/workflows/ci.yml` | `push`（所有分支）/ `pull_request` / `workflow_dispatch`；job `frontend`（`npm ci` → `npx tsc --noEmit` → `npm run test:run`）+ job `rust`（装 webkit2gtk/appindicator 依赖 → `cargo test --lib --manifest-path src-tauri/Cargo.toml`，Linux 上会跑 Windows 本地跑不到的 `#[cfg(not(target_os = "windows"))]` 串口/TTY 测试）+ e2e。口径与发版流逐条对应，提前到每次 push/PR |

## CODE MAP

Frontend (manual review; TypeScript LSP unavailable in this environment):

| Symbol | File | Type | Role |
|--------|------|------|------|
| `useAppStore` | `src/stores/useAppStore.ts` | Zustand store | tabs / ports / `paneTree` / config / groups + `sortPortsByNumber`；**不持有** systemStatus/trafficStats/simulationMode/ui（见 `useSystemStore`），无树算法（见 `utils/paneTree.ts`） |
| `getClosingTabIds` | `src/stores/useAppStore.ts` | pure fn | 批量关闭（toLeft/toRight/others）的标签集合，供 `Pane` 的 cleanup 与 store 关闭动作取同一集合 |
| `useOperationStore` | `src/stores/useOperationStore.ts` | Zustand store | serial params + send (NO `op` prefix; NO display state); `cyclicLoops: Record<portId, boolean>` 每端口循环发送开关（`setCyclicLoop` 逐端口启停，替代旧全局 `isLoopSending`） |
| `useTerminalStore` | `src/stores/useTerminalStore.ts` | Zustand store | 纯显示态（scrollLocked/showTimestamp/displayFormat/encoding/connectedAt）；`ensureTerminal` / `setTerminalConfig` / `setTerminalEncoding` / `setTerminalConnectedAt` / `releaseTerminal`；**无行数组、无 Immer**（行缓冲在 viewportManager 环形缓冲区） |
| `useRuleStore` | `src/stores/useRuleStore.ts` | Zustand store | `highlightRuleSets` / `protocolTemplates` / `sendCommandSets` + `activeSendCommandSetId` / `portToolConfigs` / `triggerRules` + CRUD（`activeHighlightSetId` / `activeProtocolTemplateId` 及其 setter 已删——零生产消费） |
| `useSystemStore` | `src/stores/useSystemStore.ts` | Zustand store | systemStatus / trafficStats / simulationMode / ui（+ `clearTrafficStats`） |
| `releaseTerminalState` | `src/stores/releaseTerminalState.ts` | pure fn | 关闭端口/标签时统一回收 terminals + trafficStats + TX 历史 |
| `paneTree` helpers | `src/utils/paneTree.ts` | pure fns | recursive `PaneNode` tree traversal（`findLeafById` / `findLeafByTabId` / `findParentBranch` / `findBranchById` / `collectLeaves` / `countLeaves` / `pruneTree` / `newPaneId`） |
| 15 hooks: `useSerialPorts` / `useSerialConnection` / `useSerialReceive` / `useSerialSend` / `useConfigPersistence` / `useSystemStatus` / `useAppInit` / `useSimulation` / `useGitBashSim` / `useToolOutput` / `useAutoUpdate` / `usePopoutBridge` / `usePortToolActions` / `useHotkeys` / `usePowerManagement` | `src/hooks/*.ts` + barrel `index.ts` | hooks | Tauri bridge — see `src/hooks/AGENTS.md`; RX → `RxPipeline` 批写（TTY 端口走 `ttyService.feed`），TX 回显前 `flushNow` 排空队列保时序；`useAppInit` 还负责分组/端口元数据（备注名/隐藏/mode）恢复 + 防抖自动保存；`useGitBashSim` 是调试专用 GIT:BASH 模拟终端开关；`useAutoUpdate` 是启动自动更新评估；`usePortToolActions` 是侧边栏/标签页外部工具菜单的共享动作源（含 `runToolForGroup`）；`useHotkeys` 全局快捷键、`usePowerManagement` 电源抑制 |
| `RxLineAssembler` / `RxPipeline` / `getRxPipeline` | `src/utils/rxAssembler.ts`, `src/utils/rxPipeline.ts` | RX 管线 | 字节级行聚合 + rAF 批写（目标=viewportManager 环形缓冲区）+ 静默/断线/编码切换 flush + `maxLinesPerTick` 写量限制 + visibility-aware 调度 + 每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧）；主窗与弹出窗各自模块单例（裁剪是常态滚动，不弹通知） |
| `ttyService` | `src/utils/ttyService.ts` | module singleton | TTY 模式 RX/TX 服务：流式 UTF-8 解码（`lineText.createDecoder`）+ 每端口队列 + visibility-aware 批写 `term.write`；`attach`/`detach`/`feed`/`clear`/`disconnect`/`send`/`resize`；队列上限 `MAX_TTY_QUEUE`；TX 刻意不走 `sendToPort`（无本地回显） |
| `TtyView` | `src/components/MainDisplay/TtyView.tsx` | component | TTY 端口 xterm 宿主：Terminal + FitAddon fit（ResizeObserver + rAF 防抖）、onData→`ttyService.send`、onResize→`ttyService.resize`；`hidden` prop = 非活动标签（`.tty-view-hidden` display:none，恢复可见显式 re-fit，**会话跨标签保留**）；字体/字号经 `term.options` 活更新不重建；Ctrl+滚轮缩放；Terminal 实例由本组件拥有，卸载时 dispose（`ttyService.detach` 不清实例） |
| `ReassemblerSegment` | `src/utils/protocolParser.ts` | type | `ProtocolFrameReassembler.feed()` 返回有序段数组（frame/raw 按流顺序），不再是 `{frames, flushedBytes}` |
| Pop-out intent bridge | `src/hooks/usePopoutBridge.ts` + `services/popout.ts` | pop-outs are separate webviews: exchange intents (`popout:send-command` / `popout:open-config` / `popout:request-sync` / `popout:command-set-updated`) + refresh signals (`command-sets:changed` / `active-tab:changed`), never shared mutable state; sends route through module-level `sendToPort` so TX echo/traffic/history work |
| `evaluateTriggers` | `src/utils/triggerEngine.ts` | pure fn | conditional trigger matching engine (contains/exact/regex/hex) |
| `hexFormat` | `src/utils/hexFormat.ts` | pure fns | `hexByte` / `bytesToSpacedHex`——bytes→HEX 唯一实现 |
| `lineText` | `src/utils/lineText.ts` | pure fns | 全仓唯一 TextDecoder 工厂（`createDecoder` 缓存 / `decodeBytes` / `getLineText`，`ignoreBOM: false`） |
| `CONFIG_BOUNDS` | `src/utils/bounds.ts` | const | 数值边界（镜像 Rust；由 `bounds.test.ts` 断言） |
| `runSequential` | `src/utils/sequential.ts` | pure fn | 串行执行原语（循环发送/批量开关） |
| `tauri` service modules | `src/services/tauri.ts` (barrel) + `src/services/*.ts` | service | wrapped `invoke` calls（11 域 + barrel） |

Backend:

| Symbol | File | Type | Role |
|--------|------|------|------|
| `CommandError` | `src-tauri/src/commands/mod.rs` | enum (thiserror) | Serial/Config/Log/System/Lock/Io/Other; manual `serde::Serialize` |
| All Tauri commands (11 domain files, 64 registered) | `src-tauri/src/commands/*.rs` | Tauri cmd | see `src-tauri/src/commands/AGENTS.md` |
| `ConfigManager` + `AppConfig` + `Entities` | `src-tauri/src/config/mod.rs` | struct | `AppConfig` = 42 标量 + `#[serde(flatten)] entities`；`Entities` = 8 个实体 `Vec`（线格式仍是 config.json 顶层 key）+ session.json + 校验 + 路径解析 + 备份/恢复 + `CONFIG_BOUNDS` |
| `AppState` | `src-tauri/src/lib.rs` | struct | `serial_manager: Arc<Mutex<..>>`、`config_manager: Mutex<..>`、**`log_manager: Arc<LogManager>`（无外层 Mutex）**、`diag_logger: Arc<..>`、`system_info: Arc<Mutex<..>>`、`tool_processes`/`file_send_cancel`/`popouts` |
| `SerialPortHandle` | `src-tauri/src/serial/ports_real.rs` | struct | `read_port`（读线程独占，只锁读）/ `write_port`（发送路径独占，只锁写）双 `Arc<Mutex<Box<dyn SerialPort>>>` 句柄；`open_real_port` 内 DTR/RTS 设置（clone 前，设备级共享）后 `port.try_clone()`（Windows = DuplicateHandle）得写句柄、原句柄作读句柄——**不能对同一 COM 口二次 CreateFile**（crate 以 dwShareMode=0 打开）；`set_params`/`set_flow_control` 改在写句柄上（DCB/COMMTIMEOUTS 设备级、两句柄共享） |
| `PortKind` / `check_virtual_enabled` | `src-tauri/src/serial/mod.rs` | enum / fn | 端口类别唯一分派 + 虚拟端口分派前门控 |
| `win32_backend` / `child_process_backend` | `src-tauri/src/system.rs` | mod | 电源管理的两个平台后端（共享状态机骨架）；**没有** `win32_power`/`macos_power`/`linux_power` 模块名 |
| `dev_only` / `is_debug_build` | `src-tauri/src/commands/system_cmds.rs` | fn | **调试能力门控唯一实现**；命令体不得再写 `#[cfg(debug_assertions)]` 双主体 |
| `collect_app_pids` / `get_system_status` | `src-tauri/src/commands/system_cmds.rs` | fn / cmd | 应用进程树内存：本进程+后代进程（含 WebView2/Chromium 子进程）RSS 之和；CPU 仍系统级；纯函数可注入进程表便于单测 |
| `LogSettings::from_config` | `src-tauri/src/logger/settings.rs` | fn | 日志设置的唯一构造入口 |
| `LogManager::apply_settings` | `src-tauri/src/logger/manager.rs` | fn | 日志设置的唯一应用入口（旧逐字段 setter / `sync_log_manager_from_config` 已删） |
| `LogLineAssembler` | `src-tauri/src/logger/assembler.rs` | struct | 字节级 CR/LF/CRLF 组行 + pendingCR + 4096 强制 flush + 250ms 陈旧尾 flush（`just_forced` 语义与前端 `rxAssembler` 一致） |
| `TtySimPortHandle` / `find_bash` / `spawn_bash` | `src-tauri/src/serial/tty_sim.rs` | mod | git bash pty 模拟终端（portable-pty 0.9，Windows = ConPTY）：writer（TX）/`master`（resize）/child（kill）/读线程（stdout→`serial:data`，退出发 disconnected）；`find_bash` 查 PATH + 常见 Git 安装路径 |
| `enable_gitbash_sim` / `disable_gitbash_sim` / `resize_gitbash_sim` | `src-tauri/src/commands/tty_sim.rs` | Tauri cmd | 调试专用（`dev_only()` / `is_debug_build()` 门控）——启用/停用 GIT:BASH 虚拟端口、前端 xterm fit 后同步 pty 尺寸 |

Subdir guides: [`src/stores/AGENTS.md`](src/stores/AGENTS.md) · [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md) · [`src/utils/terminal/AGENTS.md`](src/utils/terminal/AGENTS.md) · [`src-tauri/src/commands/AGENTS.md`](src-tauri/src/commands/AGENTS.md) · [`src/components/MainDisplay/AGENTS.md`](src/components/MainDisplay/AGENTS.md) · [`src/components/ConfigModal/AGENTS.md`](src/components/ConfigModal/AGENTS.md) · [`src/components/OperationPanel/AGENTS.md`](src/components/OperationPanel/AGENTS.md)

---

## Detailed gotchas

## Build & verify

```bash
# Run the full app (frontend + backend)
npm run tauri dev

# TypeScript check only (fast, no Rust)
npx tsc --noEmit

# Rust check only (fast, skips codegen)
cargo check
# or full build:
cargo build

# Both must pass before committing.
# Run cargo commands inside src-tauri/:
cargo check --manifest-path src-tauri/Cargo.toml
```

日常质量门（`.github/workflows/ci.yml`，每次 push/PR）：`npx tsc --noEmit` → `npm run test:run`（vitest）→ `cargo test --lib --manifest-path src-tauri/Cargo.toml` → playwright e2e。

On Windows PowerShell, `npm` may be blocked by execution policy — use:
```powershell
cmd /c "npm run tauri dev"
```

## Two-compiler project

- Frontend: React 18 + TypeScript + Vite (`src/`)
- Backend: Rust + Tauri v2 (`src-tauri/`)
- Tauri v2 uses `invoke` for frontend→backend calls and `app.emit` for backend→frontend events
- `@tauri-apps/api` (npm) and `tauri` (Cargo) must be same minor version. Currently both **2.11.x**.

## Zustand: always use selectors

**Critical**: Calling any store without a selector subscribes to the ENTIRE store. Every serial data event will re-render that component, causing input focus loss and jank.

State is split across **6 store modules**. Always pick the right store and subscribe with a selector.

### useAppStore — tabs, ports, paneTree, config, groups

```tsx
// WRONG — re-renders on every port/tab change
const { ports, openTab } = useAppStore();

// CORRECT — only subscribes to specific fields
const ports = useAppStore(s => s.ports);
const openTab = useAppStore(s => s.openTab);
```

`useAppStore` 不再持有 `systemStatus` / `trafficStats` / `simulationMode` / `ui.*`（在 `useSystemStore`），也不再导出树辅助函数（在 `src/utils/paneTree.ts`）。

### useOperationStore — baudRate, dataBits, parity, stopBits, handshake, dtr, rts, sendInput, sendIsHex, sendAppendLineEnding, ...

Operation fields have **NO `op` prefix**. They were renamed from `opBaudRate` to `baudRate`, `opDataBits` to `dataBits`, etc.

**Note**: `sendOnEnter` and `quickSendInlineCount` do NOT live here. They are in `useAppStore.config` only. SendSection reads them via `useAppStore(s => s.config.sendOnEnter)` / `useAppStore(s => s.config.quickSendInlineCount)`。`quickSendInlineCount` 仅语义为 0=隐藏快捷条，>0 时可见条数宽度自适应（`computeFitCount`）。Display state (`scrollLocked`, `displayFormat`, `encoding`, `showTimestamp`) and `loopInterval` are also NOT here — they live in `useTerminalStore`. The cyclic-send repeat count is NOT here — it moved to per-command-set `SendCommandSet.repeatCount` (config.json), read by `useCyclicSend` from the active set. **循环发送运行标志**：每端口 `cyclicLoops: Record<portId, boolean>`（`setCyclicLoop(portId, running)` 逐端口启停）——循环目标绑定启动它的端口、聚焦无关，多端口可并行。

```tsx
const baudRate = useOperationStore(s => s.baudRate);
const sendInput = useOperationStore(s => s.sendInput);
const setOpState = useOperationStore(s => s.setOpState);
```

### useTerminalStore — 纯显示态（无行数据）

```tsx
// Create/patch display state for a port
useTerminalStore.getState().ensureTerminal(portId);
useTerminalStore.getState().setTerminalConfig(portId, { scrollLocked: true });

// Component that needs a port's display state
const displayFormat = useTerminalStore(s => s.terminals[portId]?.displayFormat);
```

**行数据不在这里**：追加/替换/清空行一律走 `viewportManager` 的模块级函数（`appendTerminalLine(s)` / `replaceTerminalLines` / `clearTerminal` / `snapshotTerminalLines`），终端行渲染由 `TerminalRenderer` 直接操作 DOM。`releaseTerminal(portId)` 只应由 `releaseTerminalState(portId)` 调用。

### useSystemStore — systemStatus / trafficStats / simulationMode / ui

```tsx
const systemStatus = useSystemStore(s => s.systemStatus);
const ui = useSystemStore(s => s.ui);            // 含 configReady / operationPanelHeight 等
const setUIState = useSystemStore(s => s.setUIState);
```

### useRuleStore — highlightRuleSets, protocolTemplates, sendCommandSets, portToolConfigs, triggerRules + CRUD

```tsx
const highlightRuleSets = useRuleStore(s => s.highlightRuleSets);
const sendCommandSets = useRuleStore(s => s.sendCommandSets);
const addHighlightRuleSet = useRuleStore(s => s.addHighlightRuleSet);
```

### useToastStore — 通知队列

```tsx
useToastStore.getState().push({ message, durationMs: 0 });   // 0 = sticky
const centerOpen = useToastStore(s => s.centerOpen);
```

Use `useAppStore.getState()`, `useOperationStore.getState()`, `useTerminalStore.getState()`, `useRuleStore.getState()`, or `useSystemStore.getState()` inside callbacks/effects when you need the latest value without subscribing.

## Components: define at module level

React components defined inside parent functions cause DOM destruction on every re-render because the function identity changes:

```tsx
// WRONG — input loses focus on every keystroke
const Parent = () => {
  const Child = (props) => <input ... />;  // new function every render
  return <Child />;
};

// CORRECT
const Child = (props) => <input ... />;
const Parent = () => <Child />;
```

## Flexbox scrolling: min-height:0 chain

For terminal scrolling to work, every flex ancestor in the column chain must have `min-height: 0`:

```
.pane-container-inner       (flex:1, flex column, min-height:0)
  └─ .terminal-view-container (flex:1, flex column, min-height:0)
       └─ .terminal-view       (flex:1, min-height:0, overflow-y:auto) ← scrolls
```

Without `min-height: 0`, flex children default to `min-height: auto` and won't shrink below content size.

## Rust: no MutexGuard across .await

`std::sync::MutexGuard` is `!Send`. Tauri async commands require the future to be `Send`. Always drop the lock before `.await`:

```rust
// WRONG
let mgr = state.serial_manager.lock().unwrap();
mgr.some_async_method().await;  // MutexGuard held across await

// CORRECT
let cfg = {
    let mgr = state.config_manager.lock().unwrap();
    mgr.get_config().clone()  // extract & clone, then drop MutexGuard
};
some_async_fn(&cfg).await;
```

`log_manager` 是 `Arc<LogManager>`（无外层 Mutex）——写路径 `&self` + 内部细粒度锁，克隆 `Arc` 即为 'static 句柄，不需要也不该再包一层锁。

## Port list polling: preserve state with mergePorts

`useSerialPorts(3000)` polls every 3s. `mapPortInfo()` always sets `status: 'disconnected'`. Use `mergePorts()` to preserve existing port state (status, alias, group, baud rate, etc.) when refreshing the list.

**Hot-plug 语义**：
- fresh 枚举命中的端口保留 `connected`/`connecting`（真实会话），**但不保留 `error`**——重置为 `disconnected`，否则本次 open 失败的状态被每次轮询永久重建，刷新按钮（与轮询同一条 `refreshPorts`→`mergePorts` 链）永远救不回。
- 从枚举消失的 `connected`/`connecting` 端口经 union-back 保留**最多 `MAX_MISSING_POLLS=3` 轮**（模块级 `ghostMissingPolls`），超限放弃——拔出后读线程可能永不发 `disconnected`（空闲），无上限保留会产生幽灵端口。
- 后端 `open_real_port` stale 守卫交叉核对系统枚举：设备已消失 → 回收幽灵句柄（停线程 + join ≤100ms）允许重插后直开；设备仍存在 → 才报 `already open`。

## Hooks: useSerialReceive vs useSerialSend

The old `useSerialData` hook was split into two hooks with different lifecycles:

- **`useSerialReceive()`** — Owns the serial data event listener lifecycle. Called **once** in `App.tsx`. Listens to `serial:data` events and feeds them into the **RX pipeline** (`getRxPipeline()`: byte-level line aggregation + rAF-batched append → viewportManager 环形缓冲区); TTY 端口（`mode==='tty'`）字节**直喂 `ttyService.feed`**（跳过触发引擎/协议解析/行组装）；on `disconnected` it calls `pipeline.disconnect(portId)` (flush tail + drop per-port state) + `ttyService.disconnect(portId)` (flush queue but keep the xterm instance across reconnect). Holds NO store selector subscriptions. Never call this more than once.
- **`useSerialSend()`** — Returns a send action. Called in `OperationPanel`. Writes to the serial port and appends the sent line to the terminal via `appendTerminalLine` (viewportManager). The actual work lives in the **module-level exported `sendToPort(portId, data, isHex, lineEnding, silent?)`** (TX echo + traffic stats + in-memory history) so non-hook callers — the pop-out intent bridge — reuse the exact same pipeline instead of calling the backend directly. It drains the RX pipeline queue (`flushNow`) BEFORE the TX echo so batched RX can't overtake the send order. **TTY 分支**（`port.mode==='tty'`）跳过 TX 回显与 `flushNow`——无本地回显（对端 echo），仍走后端发送/流量统计/历史。

Both hooks write to the terminal store through `getState()` to avoid re-rendering the hook owner on every line.

The full hook set in `src/hooks/` (15 hooks, individual files):

| Hook | Purpose | Called in |
|------|---------|-----------|
| `useSerialPorts` | Polls port list every 3s | Sidebar |
| `useSerialConnection` | open/close port, routes through `closePort()` (stops logging) | Sidebar / TabBar |
| `useSerialReceive` | `serial:data` event listener → `RxPipeline` (byte-level line aggregation + rAF batch → viewportManager; TTY 端口字节直喂 `ttyService.feed`，跳过触发/协议/行组装) + status handler (`lostPortIds` for DisconnectBanner; 断线走 `pipeline.disconnect` + `ttyService.disconnect`) | App.tsx (once) |
| `useSerialSend` | Send action; `sendToPort` TTY 分支跳过 TX 回显 + `flushNow`（保留后端发送/流量统计/历史）；TX 回显经 viewportManager `appendTerminalLine` | OperationPanel |
| `useConfigPersistence` | `loadConfig` / `saveConfig(patch?)`（安全快照的唯一实现；`loadConfig` 完成时置位 `ui.configReady`） | App.tsx |
| `useSystemStatus` | Polls CPU/memory every 5s → `useSystemStore` | StatusBar |
| `useAppInit` | One-shot app bootstrap（含分组/端口元数据恢复 + 防抖自动保存） | App.tsx |
| `useSimulation` | Toggle SIM:Loopback virtual port | Sidebar toolbar |
| `useGitBashSim` | Debug-only GIT:BASH 模拟终端 toggle (mirrors `useSimulation` dev gating) | Sidebar toolbar |
| `useToolOutput` | `tool:output` / `tool:exit` event listeners | App.tsx (once) |
| `useAutoUpdate` | 启动自动更新评估：等 `ui.configReady` 后 `shouldAutoCheck`（7 天周期/snooze/首启立即）→ `runAutoCheck` → 有更新开 UpdateDialog；成功记 lastCheckAt，失败静默；会话内每 6h 重评估；DEV 构建短路 | App.tsx (once) |
| `usePopoutBridge` | pop-out intent bus: `popout:send-command` → `sendToPort(activeTabId)`, `popout:open-config` → ConfigModal page, `popout:request-sync` → replay `active-tab:changed`, `popout:command-set-updated` → 写回 `useRuleStore`；broadcasts `command-sets:changed` / `active-tab:changed` | App.tsx (once) |
| `usePortToolActions` | 侧边栏/标签页外部工具菜单共享动作（`runTool`/`killTool`/`configTool`/`runToolForGroup` + 对话框状态与动作） | Sidebar / TabBar / Pane |
| `useHotkeys` | 全局快捷键 | App.tsx |
| `usePowerManagement` | 电源抑制（防休眠/防关屏）随 config 生效 | App.tsx |

## Rust backend: CommandError and commands/ split

All Tauri commands return `Result<T, CommandError>` instead of `Result<T, String>`. `CommandError` is a `thiserror` enum defined in `commands/mod.rs` with variants per domain:

```rust
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("Serial error: {0}")]
    Serial(String),
    #[error("Config error: {0}")]
    Config(String),
    #[error("Log error: {0}")]
    Log(String),
    #[error("System error: {0}")]
    System(String),
    #[error("Lock error: {0}")]
    Lock(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}
```

It implements `serde::Serialize` manually so the frontend receives the error string via `invoke`.

Commands are split into 11 domain files under `src-tauri/src/commands/`; `lib.rs` 的 `generate_handler!` 注册 **64** 个命令（`config/mod.rs` 的 `test_generate_handler_matches_tauri_command_attribute` 守卫注册漂移）：

| File | Domain |
|------|--------|
| `serial.rs`（11） | list_available_ports, open_serial_port, close_serial_port, send_serial_data, send_file, set_serial_params, set_flow_control, attempt_reconnect, run_port_tool, kill_port_tool, cancel_file_send（GIT: 路由走 send_data/write_raw） |
| `simulation.rs`（2） | enable_simulation, disable_simulation |
| `tty_sim.rs`（3） | enable_gitbash_sim, disable_gitbash_sim, resize_gitbash_sim（模拟终端 git bash pty，调试专用） |
| `config.rs`（5） | get_config, set_config, update_session_snapshot, get_session_snapshot, get_config_path（**无 reset_config**） |
| `diag.rs`（4） | get_diag_log_path, read_diag_log, clear_diag_log, append_diag_log（应用自身诊断日志） |
| `log.rs`（8） | save_log_as, export_terminal_log, get_log_files, start_logging, stop_logging, open_path, open_log_directory, migrate_log_directory（**逐字段 `set_log_*` 已全部删除**——日志设置改走 `set_config`） |
| `storage.rs`（20） | 6 类实体 CRUD（command sets / highlight sets / protocol templates / trigger rules / port presets / tool configs，各 save/load/delete）+ save_port_groups + save_port_meta — synchronous ConfigManager operations on config.json；内部共享 `read_config` / `save_entity` / `delete_entity` + `entity_accessors!` / `impl_entity_id!` 宏访问器 |
| `file.rs`（3） | write_text_file, read_text_file（配置导入导出）, read_image_data_url（背景图 data URL） |
| `popout.rs`（3） | open_popout(kind, target_id), close_popout(kind, target_id), set_popout_always_on_top(kind, target_id, on)（label 只在 Rust 计算） |
| `system_cmds.rs`（3） | get_system_status, prevent_sleep, prevent_screen_off（+ 门控助手 `dev_only` / `is_debug_build`） |
| `update.rs`（2） | check_for_update, download_and_install_update（自动更新；debug 构建返回 Ok(None)） |

`mod.rs` re-exports all commands (`pub use <domain>::*;`) and defines `CommandError`.

`src-tauri/src/system.rs` 是电源管理适配层：共享「期望状态 → 整体应用」骨架，平台差异只在 `win32_backend`（Win32 `SetThreadExecutionState` FFI）/ `child_process_backend`（抑制子进程）两个后端模块。仅 `system_cmds.rs` 调用——不要另写 FFI 或第二份状态机。

## GBK / 多编码

- `serial:data` 事件载**原始字节**（`data: Vec<u8>`）；前端用 `src/utils/lineText.ts` 的 **唯一解码器工厂**按编码 label 解码（模块级缓存，`ignoreBOM: false`——行首 BOM 被剥离）。
- RX 行只存 `rawData`（`Uint8Array`），渲染/搜索/过滤/复制在读取该行时**惰性解码**（`getLineText(line, encoding)`）；`setTerminalEncoding` 只更新 label，不遍历存量行。
- `encoding_rs::GBK` 在 Rust 侧**只用于日志文件写出编码**（`logger/writer.rs`）；数据通道的编码完全由前端负责。
- ttyService 的流式解码器由同一个 `createDecoder` 工厂构建，但因需保留跨事件残字节而 **per-port 独占**。

## 标签页关闭生命周期

- **关闭标签页 ≠ 关闭串口**：`Pane.cleanupClosedTab` 只销毁前端显示目标——`getRxPipeline().disconnect(tabId)` + `ttyService.detach(tabId)` + `releaseViewportManager` + `releaseTerminalState(portId)`；端口保持连接、后端日志由 `LogManager` 独立落盘，重开标签页从零开始新一轮输出。
- 批量关闭（左/右/其它）先用 `getClosingTabIds(tabId, scope)` 取 store 关闭动作的同一集合，再对每个 id 跑同一套 cleanup。
- **真正断开**才走 `useSerialConnection.closePort()`（停日志 + 更新端口状态 + 回收)；不要绕过它直接改 store，否则日志句柄泄漏、端口状态停在 "connected"。

## Commit conventions

```
type(scope): description

type: feat | fix | docs | style | refactor | perf | test | chore
scope: ui | backend | store | hooks | docs
```

## Key design reference

架构文档按**功能模块**划分，索引见 `docs/architecture/README.md`：
- `docs/architecture/serial.md` — 串口管理（枚举/热插拔/连接/读写句柄/虚拟端口/外部工具）
- `docs/architecture/terminal.md` — TRX 终端显示（方案B 引擎/滚动/搜索/编码/渲染契约 R1–R15）
- `docs/architecture/transmission.md` — 数据收发（RX 管线/TX/循环/快捷/触发）
- `docs/architecture/tty.md` — TTY 终端（xterm/ttyService/模拟终端）
- `docs/architecture/logging.md` / `config.md` / `workspace.md` / `update.md` / `release.md` / `errors.md`

## Other gotchas

- `tauri.conf.json` has `"decorations": false` — custom TitleBar handles window controls via `@tauri-apps/api/window`
- `tsconfig.json` enforces `noUnusedLocals` and `noUnusedParameters` — unused vars are compile errors
- Serial data events carry `data: number[]` on the wire (bytes). `TerminalLine.rawData` is a **`Uint8Array`** (8× memory cut + no temp copy on decode) — `terminalSearch`/`protocolRenderer` must use `Array.from` instead of `.map` (Uint8Array has no `.map`); 解码走 `lineText`，不要在别处再建 TextDecoder。
- **RX 管线**：`serial:data` 事件不再「一事件一行」，而是进 `getRxPipeline()`（每 webview 一个模块单例）：`RxLineAssembler` 字节级切行（CR/LF/跨事件 CRLF/4KB 强制发射）→ 每端口队列 → rAF tick 每端口一次 append（目标=viewportManager 环形缓冲区）→ 250ms 静默 flush 未终结尾部（时间戳取最后事件时间）。`sendToPort` 在 TX 回显前 `flushNow` 排空队列保收发时序；断线走 `pipeline.disconnect`；编码切换前必须 `flushAndReset`（旧编码冲刷尾部，`TerminalFilterBar` 已接线）。**不得**在 hook/弹窗 cleanup 里 `dispose()` 单例。**visibility-aware 排空**：页面隐藏时 rAF 停摆——调度器在 rAF 可用且页面可见时走 rAF，否则走 setTimeout(cb, 16) 兜底；构造函数注册 `visibilitychange` 监听，变 hidden → 取消未触发的 rAF tick 并按当前调度器重排，变 visible → 重排回 rAF，dispose() 移除监听；入队后 enforceQueueCap：队列超过 `maxQueuedLines`（默认 10000）splice 丢**最旧**，防隐藏窗口长时间积压无界。
- **滚动锁定**：`scrollLocked` 只由显式意图写入——图钉按钮、`.terminal-jump-btn` 跳转按钮（滚动条两端：到顶解锁、到底锁定并点亮）、手势 settle（滚轮/滚动键/滚动条拖拽/中键，120ms 静默后按 atBottom 50px 容差判定）。`TerminalRenderer` 的 scroll 监听只驱动可见窗口重算（不碰锁定状态）；搜索栏打开时抑制跟随，关闭时若锁定则滚回最新。
- ConfigModal's rule/command editors save to config.json via `storageService` (which wraps config-backed commands). Load on mount via `useEntityPage`. Rule state lives in `useRuleStore`.
- **config.json is the single source of truth for ALL settings entities** (2026-08 migration: the SQLite layer was removed entirely). The 8 entity types (`SendCommandSetEntry`, `HighlightRuleSetEntry`, `ProtocolTemplateEntry`, `TriggerRuleEntry`, `PortPresetEntry`, `PortToolConfigEntry`, `PortGroupEntry`, `PortMetaEntry`, all `#[serde(rename_all = "camelCase")]`) live in the `Entities` sub-struct as 8 `Vec` fields, `#[serde(flatten)]`-ed onto `AppConfig` so they stay **top-level keys in config.json**（线格式零变化）。`commands/storage.rs` CRUD is synchronous: lock `config_manager` → mutate via the macro-generated accessor → `save()` writes config.json atomically (tmp + rename + `.bak`). `port_groups` is a whole-list replace (`save_port_groups`) — groups auto-save via a 500ms-debounced store subscription in `useAppInit`; there is no manual «save layout» button. `port_meta`（备注名/隐藏/mode）同款整体替换（`save_port_meta`）。The session snapshot lives in a separate `session.json` via `load_session_snapshot()`/`save_session_snapshot()`; `update_session_snapshot` writes session.json and does NOT trigger a config `.bak`. Log settings are applied only through `set_config` → `LogSettings::from_config` → `LogManager::apply_settings`. Log line prefix format is configurable: `log_include_timestamp` / `log_include_direction` control whether `PortLogWriter::write_line` emits `[timestamp] ` / `RX|TX ` prefixes; both off → bare data line. They lock at writer-creation time (like encoding). 背景图四个字段（`background_image*`）是普通标量字段，走 `...config` 展开随全量保存流过。
- ConfigModal pages use **per-field selectors** instead of subscribing to the whole config — this prevents unnecessary re-renders when unrelated config fields change.
- SIM:Loopback virtual port is available when `enable_simulation` is called (flask icon in sidebar toolbar)。**周期输出频率命令**：向 SIM:Loopback 发送**文本模式纯数字**（trim 后为数字，如 `100`）即把周期输出频率切到每秒 N 次（0 = 停止；上限 `MAX_SIM_RATE = 10000`，超限 clamp），命令本身不回显——输出为 `[SIM] Heartbeat #<seq>` 序号行，积分器补发保证平均频率精确（`sim_due_lines` 纯函数，100ms 循环节拍不限制高频）。HEX 模式/非数字 TX 保持原回显。默认 2/s。
- CSS is split across `src/styles/` (`base.css` + 16 component CSS files; UpdateDialog styles live in `update-dialog.css`). `src/styles.css` is just an `@import` entry point, not the main stylesheet.
- `src/utils/hexUtils.ts` provides `hexToString` and `stringToHex` for HEX send/parse; `src/utils/hexFormat.ts` 是 bytes→HEX 的唯一格式化实现。
- ConfigModal split into: `ConfigModal.tsx`, `RuleSetAccordion.tsx`, `pages/` (9 settings pages), `editors/` (HighlightRuleEditor, ProtocolTemplateEditor, SendCmdEditor), `hooks/useEntityPage.ts`.
- OperationPanel split into section components: `OperationPanel.tsx`, `SendSection.tsx`, `ParamsSection.tsx` (the old `RulesSection.tsx` was removed — its command-set select + loop toggle merged into `SendSection`'s compact header, its highlight dropdown was a dead control). The compose-row file button doubles as a **cancel** button while a transfer is in progress (`serialService.cancelFileSend` → backend `cancel_file_send`); the success toast is driven by the `serial:file_progress` `done` event (`sent>=total>0`), so cancel / empty clear the bar silently.
- Serial backend hardening (see `src-tauri/src/commands/AGENTS.md`): `send_file` is cancellable via `cancel_file_send` (per-port token in `AppState.file_send_cancel`) and always emits a terminal `done:true`; `run_port_tool` joins the read thread **outside** the global serial lock and reads tool streams by bytes (`read_until` + `from_utf8_lossy`); `serial/codec.rs` exposes `build_tx_bytes` as the single source of truth for transmitted bytes (used by `send_data` and the TX log); `open_serial_port` guards stale handles and the SIM read thread emits `disconnected` on exit.
- Serial unit tests use **explicit** imports — never `use super::*;`: the glob drags the `serialport` FFI into the test binary and the Windows `cargo test` harness then fails to load with `0xc0000139` (no embedded app manifest, unlike the app binary). Tests that touch `serialport` types / `SerialManager` are `#[cfg(not(target_os = "windows"))]` and run on Linux/macOS CI; the FFI-free hex-parser / `build_tx_bytes` tests run everywhere.
- MainDisplay split into: `MainDisplay.tsx`, `Pane.tsx`, `TabBar.tsx`, `TerminalView.tsx`, `TerminalFilterBar.tsx`, `TerminalSearchBar.tsx`, `ResizeHandle.tsx`, `TtyView.tsx` + `terminalContextMenu.ts` / `useTerminalDisplay.ts` / `useTerminalSearch.ts` / `hooks/{useLogReplay,useTabDragEnd}.ts`.
- Sidebar split into: `Sidebar.tsx`, `AliasDialog.tsx`, `GroupItem.tsx`, `GuideCard.tsx`, `SearchBox.tsx`, `SidebarActions.tsx`, `SidebarToolbar.tsx`, `SortablePortItem.tsx`, `groupActions.ts`, `hooks/usePortDragEnd.ts`.
- Per-tab display state (`scrollLocked`, `displayFormat`, `encoding`, `showTimestamp`) lives in `useTerminalStore`, NOT in `useOperationStore`. Display controls (TerminalFilterBar, encoding select) must write via `useTerminalStore.getState().setTerminalConfig(portId, ...)` or `setTerminalEncoding(portId, encoding)`. Never reintroduce global display fields in `useOperationStore`.
- `src/utils/sendUtils.ts` provides `textToHexPreview` / `hexToTextPreview` / `sanitizeHexInput` / `computeByteCount` / `parseHexBytes` / `getLineEndingBytes` / `LINE_ENDING_VALUES` / `lineEndingLabelKey` for HEX send/parse (pure, unit-tested)。行结束符下拉统一从 `LINE_ENDING_VALUES` 取（见下条）。
- **JSX 属性字符串不转义**：`<option value="\r\n">` 里 `\r\n` 不会按转义处理，运行时值是 6 字符字面量 `\\r\\n`，与域值 4 字符 `\r\n` 不等 → `formatLineEndingHex`/`getLineEndingBytes` 落到默认分支，行尾提示/字节数/发送字节全错。行结束符选项必须用表达式字面量 `value={'\r\n'}`，label 走 `lineEndingLabelKey(v, ns)`。
- **发送守卫**：`sendToPort` 非静默发送前检查 `utils/sendGuard.ts` `isSendablePort`——端口缺失/断开/连接中/错误时推 `sendSection.portClosedWarning` toast 并返回 0；循环发送与触发自动回复的静默发送（`silent=true`）静默返回 0 不打扰用户。**文件发送同样过守卫**（`useFileSend`：不可发送连文件框都不弹）并把每轮字节增量计入 `trafficStats` TX。新增发送逻辑若绕过 `sendToPort` 直连后端，会失去该守卫与 TX 回显/历史管线。
- **config 实体快照陷阱**：`useAppStore.config` 的实体数组（sendCommandSets/highlightRuleSets/protocolTemplates/triggerRules/portToolConfigs/portPresets）是**启动快照**，不会自动跟随 `useRuleStore`。任何全量保存**必须**走 `useConfigPersistence.saveConfig(patch?)`——它内部现场拼装安全快照（标量 + `useRuleStore` 活实体 + `state.groups` + `collectPortMeta(state.ports)` + 后端读回的 `portPresets`；`portPresets` 读不到就不写，宁可不保存也不用陈旧快照覆盖磁盘）。旧 `utils/configMerge.ts` / `mergeLiveRuleEntities` 已删——**不要**再手写「合并后 set_config」的调用点。
- **跟随钉底**：跟随路径由 `TerminalRenderer.render` 内联计算目标值并同帧写 scrollTop（padding 感知、无 React effect、无双 rAF 链、无第三方虚拟化）。`utils/followLogic.ts` 只剩 `isAtBottom` / `shouldFollow` 两个纯函数；到顶/搜索跳转走 `viewportManager.scrollToSeq` / `scrollToBottom`。
- **通知中心**：`durationMs === 0` 的 toast 是粘滞的（Toast.tsx 不启动自动关闭计时）；超过 `MAX_VISIBLE=5` 的 toast 进 `stashed` 队列（不是丢弃），可经 NotificationCenter 查看/逐条关闭/清空。串口来源的 toast 必须带 `portId`（触发告警/断线/发送目标关闭/重连失败已接），时间戳取 `createdAt`。
- **触发规则自动持久化**：TriggerSettings 编辑触发规则 300ms 防抖逐条保存（`savedSnapshotRef` 与当前 rules diff），关闭弹窗时 flush 窗口内未保存编辑；新增/修改规则应走 `storageService.saveTriggerRule`，勿绕过。
- **日志 RX 组装与子目录**：`logger/assembler.rs` 的 `LogLineAssembler`（字节级 CR/LF/CRLF 合并 / pendingCR / 4096 强制 flush / take_tail / `just_forced`，镜像前端 rxAssembler）+ `LogManager::write_rx`（RX 方向组行落盘，TX 保持直写 `write`）+ `subdir_component`（`none`/`date`/`port`，默认 `date`，非法值 clamp 回 date，路径 join 处 create_dir_all，`LogManager::list_files` 递归 `MAX_LIST_DEPTH`）。改日志路径/分片/子目录相关代码要同时看这里。
- **日志空行不落盘**：`write_line` 顶部 `data.is_empty()` 直接返回 Ok；string 格式 decode 后 `trim_end_matches(['\r','\n'])` 为空（只含行结束符的 TX）同样跳过——`write_rx` 对连续分隔符/行首行尾分隔符产出的**空块**因此天然不落盘。`close_writer` 关闭时 `current_size==0` 且磁盘 0 字节 → 删除空文件。新增日志写入路径时不要绕过这两个守卫（组装器仍会产出空块，这是刻意的行边界语义）。
- **状态栏内存**：`get_system_status` 的内存是**应用进程树级**——本进程+全部后代进程（含 WebView2/Chromium 子进程）RSS 之和（`collect_app_pids` + `refresh_processes_specifics(All, true, ProcessRefreshKind::nothing().with_memory().with_cpu())`）。CPU 仍系统级；`load_status` 只按 CPU>90 判 high_load；状态栏显示「JS堆 XMB · 进程 YMB」（无总预算分母）。
- **rawData / 惰性解码**：`TerminalLine.rawData` 是 `Uint8Array`；`terminalSearch`/`protocolRenderer` 用 `Array.from` 逐字节（Uint8Array 无 `.map`）。TX 行 `txRawData` 同样存 Uint8Array。RX 行不存 content 字符串（`content?` 可选），渲染/搜索/过滤经 `getLineText(line, encoding)` 惰性解码。
- **内存上限**：单一 `maxDisplayLines`（每端口终端最大显示行数，默认 100000，由 `CONFIG_BOUNDS` clamp [1000,1000000]）。Rust `AppConfig.max_display_lines` 缺省由 `impl Default` 提供；升级兼容：`ConfigManager::new` 加载时 `strip_legacy_memory_budget_keys` 显式剥离旧 config.json 里已废的内存预算 key（下次 save 落盘即物理删除）。**没有**字节预算/软兜底/half-trim。
- **裁剪触发**：`TerminalBuffer` 固定行容量（`maxLines = maxDisplayLines`），溢出时 head 前进 O(1) **逐行覆盖最旧一条**（滚动窗口，firstSeq 每 append +1）；`appendLines`/`appendTerminalLines` 返回 boolean（是否发生覆盖）；**无「因内存限制清屏」toast**（逐行覆盖是常态滚动，不是异常事件）。存活行 seq 稳定，渲染引擎不重画。
- **RX 写量限制**：`maxLinesPerTick`（默认 2000）每端口每帧最多写 N 行，超出顺延下一帧；`flushNow` 同步最多排空 N 行，其余 rAF 续写。
- **发送异步化**：`send_serial_data` 是 async fn + `tokio::task::spawn_blocking`——原同步命令在事件循环主线程执行 write_all+日志写，每次 TX 无条件卡顿 + tao `NewEvents`/`RedrawEventsCleared` 警告白屏。`AppState.serial_manager` 为 `Arc<Mutex<..>>`（Deref 使 `.lock()` 调用点零改动）。`send_file` 本就是 async（tokio::fs::read + 分块 yield），无同类主线程阻塞。
- **TX/RX 读写句柄拆分 + 无界 flush 摘除**：此前「TX 后等一分钟才收到响应」的根因有二——① 读写共用同一把 per-port 锁，TX 的 write_all+flush 阻塞时读线程拿不到锁；② 热路径 `flush()`（Windows = FlushFileBuffers）无超时、受流控约束。修复：`SerialPortHandle` try_clone（Windows = DuplicateHandle）拆 read_port/write_port 双句柄——**不能对同一 COM 口二次 CreateFile**（crate 以 dwShareMode=0 打开），try_clone 是唯一途径；读线程只锁读、发送只锁写，DCB/COMMTIMEOUTS 设备级、两句柄共享。热路径去 flush + `write_all_with_deadline` 总写期限（`WRITE_TOTAL_DEADLINE` 2s，Ok(0) 立即报错、TimedOut 重试到总期限、Interrupted 继续）。发送改**两段式**：全局锁内只做 HashMap 查找 + Arc 克隆 → 释放全局锁 → 锁外只持 per-port 写锁调用 write_all_with_deadline。
- **端口排序一次性动作**：`useAppStore.sortPortsByNumber()`（重排 ports + 各分组 portIds，自然序，幂等、不重置 groupId）；Sidebar 无持久 sortMode 开关，拖拽/分组始终可用。组内顺序随 `save_port_groups` 持久化、未分组顺序不保存。
- **串口右键菜单分组控制**：按端口分组态动态渲染——未分组且有组→逐组「移入分组『{{name}}』」；未分组无组→「新建分组并移入」；已在组里→「移出分组」。i18n keys `sidebar.port.contextMenu.{removeFromGroup,addToGroup,createGroupWithPort}`。
- **ConfigModal 框选不关闭**：overlay pointerdown 记录起点是否在弹窗内，click 时起点在弹窗内则忽略关闭——只响应按下+松开都在遮罩上的点击。
- **快捷发送 pill 两行**：`.op-quick-cmd` 为 flex column：`.op-quick-cmd-name-row`（HEX 徽标+名称同行）在上、`.op-quick-cmd-content` 内容在下。
- **自定义文本右键菜单**：`useTextEditContextMenu()` 是全局拦截（App 根 + PopoutShell 各挂一次）——可编辑目标右键 → 自定义菜单（`document.execCommand` 执行，右键时快照选区、点击项先 `focus({preventScroll:true})` + 恢复选区再执行）；非可编辑目标一律 `preventDefault`；组件级 `onContextMenu` 且 stopPropagation 的区域（终端行/侧边栏/标签页）不受影响。
- **发送提示前缀默认空**：`sendPrefix` 默认 `''`（TS `defaultConfig` + Rust `AppConfig::default` 两侧同步）；终端 TX 行已有方向标识，前缀只是可选的附加提示。
- **TTY 模式**：TTY 端口（`mode:'tty'`）由 xterm.js 渲染完整终端流——**无本地 TX 回显**（对端 shell 会 echo），`sendToPort` TTY 分支跳过 TX 回显 + `flushNow`；**TTY 写 pty 做过回车归一**（`normalize_tty_line_ending`）：pty 行规程（ICRNL）把 `\r` 转成 `\n`，`\r\n` 会变成两个换行——故 `\r\n` 统一归一为单个 `\r`，`\r`/`\n`/`None` 原样保留；`useSerialReceive` 对 TTY 端口**跳过触发引擎/协议解析/RxPipeline 行组装**直喂 `ttyService.feed`；RX 解码**仅 UTF-8**（流式，无 GBK）——TRX 的多编码切换不适用于 TTY；**弹出窗不支持 TTY**；**标签切换保留会话**（TTY 标签在 Pane 内常驻挂载、非活动 `display:none` 隐藏 `.tty-view-hidden`，恢复可见 re-fit）；**切换模式清空缓冲区**（`ParamsSection` 清 TerminalStore + `flushAndReset` + `ttyService.clear`）；`ttyService`/`getRxPipeline` 的 `dispose()`/`reset()` 仅测试用，应用生命周期不得调用（模块单例纪律）。

## 方案B 终端显示引擎（issue #14 v0.6.0；issue #18 流式布局 + 选区钉住重构）

TRX 终端的行缓冲与渲染**脱离 React 调度**。数据路径：`serial:data` → `RxPipeline`（字节级行聚合 + rAF 批写）→ `viewportManager.appendTerminalLines` → `TerminalBuffer`（环形缓冲区）→ 同一 rAF 内 `TerminalRenderer.render`（直接 DOM）。

|模块|文件|职责|
|---|---|---|
|`TerminalBuffer`|`src/utils/terminal/TerminalBuffer.ts`|环形缓冲区：O(1) 追加/裁剪、稳定 seq（裁剪只移动 [firstSeq,lastSeq] 窗口，存活行 seq 不变）、`maxLines` 行容量（超限**逐行覆盖最旧**，滚动窗口；`append` 返回 `{seq, trimmed}`）、`snapshot`/`replaceAll`/`clear`/`setLimits`|
|`TerminalRenderer`|`src/utils/terminal/TerminalRenderer.ts`|直接 DOM 引擎（流式布局）：contentLayer = `[headSpacer][行…][tailSpacer]`，行是**普通文档流**子元素（固定行高），spacer 承载屏外空间——**DOM 顺序 == 视觉顺序由结构保证**（旧的 absolute+translateY 格子、插入排序修复、每帧排序修复、脱链防御整套机制已结构性删除）；新行经 `findFlowAnchor` 只相对 spacer 或更大 visIdx 的行插入（**停车行也是锚点候选**，只跳过已被裁出缓冲的行）；**选区钉住**：活选区触及的行永不回收/不重写/不换父——窗内=文档流行、窗外=**原地停车**（`display:none` 同父；Chromium 探针证实换父即丢 Range），`selectionchange` 清选区后自动回收，`MAX_PINNED_ROWS=600` 超限优雅放弃；同帧钉底、大 trim 锚点恢复（`LARGE_TRIM_ROWS`，`setLimits` 收缩触发）、`seqToVisIdx`/`visIdxToSeq` 支持过滤列表、frozen null 归一化（`Number.MAX_SAFE_INTEGER` 防 `seq > null` 误判）。**文件头有渲染契约清单 R1–R15**（`TerminalRenderer.soak.test.ts` 按编号引用）|
|`TerminalViewportManager`|`src/utils/terminal/viewportManager.ts`|每端口枢纽：`TerminalBuffer` + renderer 生命周期（attach/detach/dispose）+ **增量过滤/搜索**（`recomputeSearch`：新行 append 时匹配一次并入列，不整缓冲重扫）+ 暂停（frozenSeq）+ 选区/锁定/手势透传 + rAF 调度 + `subscribe`（渲染 pass 通知 React 壳刷新读数）+ `scrollToSeq`/`scrollToBottom` + matchSet 按 (offset,length,currentMatch) 缓存（免每帧 new Set）|
|适配面|`viewportManager.ts` 模块级函数|`appendTerminalLine(s)`/`clearTerminal`/`replaceTerminalLines`/`snapshotTerminalLines`/`releaseViewportManager`/`getViewportManager`——非 React 调用方（TX 回显/工具输出/回放/弹窗/热键）一律走这里，**不再碰 useTerminalStore 的行 API**。`appendTerminalLine(s)`/`replaceTerminalLines` 是「manager 存在才写入」——标签关闭（`releaseViewportManager`）后端口仍连接、RX 继续到达时**静默丢弃**（不复活 manager、不积压），重开标签页从零开始|

**渲染契约 R1–R15**（`TerminalRenderer.ts` 文件头注释的权威摘要；soak 测试逐条对应）：

|#|契约|
|---|---|
|R1|流序：layer 子元素为 `[headSpacer][行 in visIdx 顺序][tailSpacer]`；DOM 顺序 == 视觉顺序（浏览器按 DOM 序拼接跨行选区）|
|R2|DOM 有界：至多「窗口 + OVERSCAN + 停车钉住行（+ POOL_CAP 池）」；逐帧不累积|
|R3|每行 `data-seq` 都在活缓冲窗口内，或该行已停车（`display:none`）|
|R4|spacer 承载屏外空间：两者 ≥0、行高对齐、空缓冲时为 0；layer 不写 inline 高度|
|R5|`data-seq` 存在、为数值、每层唯一；空缓冲 ⇒ 零行|
|R6|过滤列表激活时，每个**可见** seq 都是该列表成员（停车钉住行豁免）|
|R7|stale 判定用**实时** `seqToVisIdx`，从不信任缓存的 visIdx 字段|
|R8|`frozenSeq === null` 先归一化为 `Number.MAX_SAFE_INTEGER` 再比较|
|R9|阅读位置锚定：head 前进且非跟随/非手势/无选区时，按 `anchorSeq` 还原 scrollTop（锚点被裁则 clamp/就近）|
|R10|跟随钉底在 `render()` 内**同帧**完成（padding 感知，浏览器绘制前）|
|R11|暂停（`frozenSeq !== null`）抑制跟随钉底，即使 `locked` 仍为 true|
|R12|选区钉住：活 Range 触及的行永不换父；`findFlowAnchor` **必须**把停车行当锚点候选|
|R13|钉住行跳过内容重写（innerHTML 重写会重建锚点文本节点）；结构性变更（`bumpFilterVersion`/`invalidate`/`clear`/`detach`）清 pins；超出 `MAX_PINNED_ROWS` 自弃而非无界钉住|
|R14|固定行高、零测量：几何只来自 `config.rowHeight`（配置变更活更新）；行内容永不换行（行盒纵向裁剪，宽行横向滚动）|
|R15|行 DOM 结构镜像 `TerminalRow`：`.terminal-line` + 可选 `.terminal-timestamp` / `.terminal-direction` + `.terminal-content`（搜索/选区/导出路径也按这些类名选择）|

关键不变式：
- **React 不渲染行**：contentLayer 是命令式 DOM，TerminalView 壳重渲染不会触碰它（React 不管理非 JSX 子节点）。
- **标签切换保留缓冲**：Pane 对 TRX 标签常驻挂载（hidden prop → display:none），viewportManager 模块注册表持有实例；关闭标签/TRX→TTY 切换才 `releaseViewportManager`。
- **关闭标签页 = 前端显示目标销毁、串口连接保留**：`Pane.cleanupClosedTab` 走 `getRxPipeline().disconnect(tabId)` + `ttyService.detach(tabId)` + `releaseViewportManager` + `releaseTerminalState`——重开标签页从零开始新一轮输出；`ttyService.feed` 对「无标签页且未 attach」丢弃（挂载前首帧窗口仍入队等 attach replay）。
- **惰性解码**：RX 行只存 `rawData`，`getLineText(line, encoding)`（`src/utils/lineText.ts`，唯一解码器工厂 + 模块级缓存，`ignoreBOM:false`）按当前编码解码；编码切换 = 重渲染，无 store 遍历。
- **内存上限**：`computeBufferLimits()`（从 `config.maxDisplayLines` 派生 `{ maxLines }`，缺省 100000、下限 1000）在 manager 创建时读取；配置变更由 App.tsx effect 经 `applyLimits({maxLines})` 同步到现存实例。**裁剪语义**：满 `maxLines` 后每 append **逐行覆盖最旧一条**（滚动窗口）——无字节预算、无 half-trim、无应用级软兜底、无内存裁剪 toast。
- **渲染正确性陷阱**：frozen 参数为 null 时必须归一化为 `Number.MAX_SAFE_INTEGER`（原始 `seq > null` 会把所有行判为隐藏）；`visibleSeqsOffset` 是过滤列表的惰性裁剪头（append O(1) 摊还）。
- **stale 判定用实时列表位置**：head trim 前进 firstSeq（及 filtered.offset）后，active 行缓存的 visIdx 字段整体过期——stale 检查若按字段判定，被裁行/幸存行永不回收 → DOM 行数无限增长、每帧 O(n) 渲染 → 输出区抖动。`seqToVisIdx`（identity O(1)、过滤模式二分）是每帧 stale 检查的唯一判定来源，越界即回收。
- **选区钉住替代全局冻结**：全局冻结协议（旧的 `isSelecting` + setter）已删。活选区触及的行（`captureSelectionSeqSpans` 映射 Range 端点到 seq 区间）永不回收/不重写/不换父；窗外停车 `display:none`（同父）；`selectionchange` 清选区后下一帧回收；**停车行占真实文档流槽位**——`findFlowAnchor` 必须把停车行当插入锚点候选（曾漏 → 可见 DOM 乱序 [30..35, 8..29, 36..44]），只跳过 `seqToVisIdx` 为 null（已被裁出缓冲）的行；**`Selection.toString()` 按布局可见性序列化**（Chromium）——停车行文本从中消失，复制路径用 `selectionText()`（`Range.cloneContents`，`terminalContextMenu.ts`）。

## Pane tree (2026-07 refactor)

`panes: SplitPane[]` 平铺数组已替换为 `paneTree: PaneNode`（单根递归树）。
```ts
type PaneNode = LeafPane | BranchPane;
interface LeafPane   { id: string; type: 'leaf';   tabIds: string[];    size: number; }
interface BranchPane { id: string; type: 'branch'; direction: SplitDirection; children: PaneNode[]; size: number; }
```

- `focusedPaneId` 引用树中的**叶子 id**（不再是扁平数组索引）
- 树辅助函数全部在 **`src/utils/paneTree.ts`** 导出：`findLeafById`、`findLeafByTabId`、`findParentBranch`、`findBranchById`、`collectLeaves`、`countLeaves`、`newPaneId`、`pruneTree`
- `pruneTree` 会自动：① 删除非根空叶子 → ② 折叠只有 1 个子节点的分支为该子节点（继承 size）→ ③ 根分支为空时退化为空叶 `'main'`
- `MainDisplay.tsx` 用 `renderNode(node, parentBranch)` 递归渲染；分支 flex 容器内 ResizeHandle 调用 `resizeChildren(branchId, childIndex, deltaFraction)` action
- `useTabDragEnd` 用 `findLeafByTabId` / `findLeafById` 树遍历，不要再用 `state.panes.find(...)`
- 批量关闭标签（左/右/其它）用 `getClosingTabIds(tabId, scope)`（`useAppStore`）取集合，勿手写遍历
- 新 splitPane：找焦点叶子 → 在父分支子数组里替换为含 [源叶(0.5), 新叶(0.5)] 的新分支；焦点叶是根时整树替换
- 测试断言：`state.paneTree.type === 'branch'` 后 `as BranchPane` 再断 `children` — 严禁再用 `state.panes[0]` / `state.panes.length`

## i18n (2026-07 基础设施)

- `src/i18n.ts` — i18next + react-i18next，扁平 dotted key（`keySeparator: false`），**537 keys × zh-CN/en-US**（`src/i18n.test.ts` 断言：解析的键与 i18next 运行时资源包一致、两侧键集合相等、书写顺序镜像、同语言无重复键、文案非空、同名键插值占位符一致）
- `main.tsx` 顶层 `import './i18n'` 副作用初始化
- `useAppStore.subscribe((state) => ...)` 监听 `config.language` 变化 → `i18n.changeLanguage`
- 组件用：`import { useTranslation } from 'react-i18next'` + `const { t } = useTranslation()` + `{t('namespace.key')}` / `t('namespace.key', { var: value })`
- **类组件**（如 `App.tsx` 的 `AppErrorBoundary`）不能使用 hook，直接 `import i18n from './i18n'` 后 `i18n.t('key')` —— 但不会随语言切换重渲染（仅在错误边界这种边缘场景可接受）
- 不翻译的字符串：协议词汇 `None/Even/Odd/Mark/Space`、`Xon/Xoff`、`RTS/CTS`；编码名 `ASCII/UTF-8/GBK/ISO-8859-1`；单位 `ms/px/MB`；首字母缩写 `SIM/VCP/HEX/DTR/RTS` —— 这些在 i18n.ts 中也无对应 key
- 新增组件文本必须先查 `src/i18n.ts` 现有 key，不够用则在 zh-CN 和 en-US 两侧**同时**新增（保持两侧顺序镜像，否则 `i18n.test.ts` 红）
- 切换语言时全部界面实时切换，无硬编码中文残留

## 版本历史记忆

> 以下为**历史叙事**：记录各版本发布时的状态与当时的决策。**可能已被后续版本推翻**（例如 v0.4.1 引入的双层内存预算在 issue #16 已整体删除）。与「当前架构」冲突时一律以「当前架构」为准。保留它们是为了记住「为什么长成这样」。

v0.4.1 (issue #6): 双层内存预算（`memoryLimitMb` 整个应用含 webview 总预算软兜底，默认 2048MB；`memoryPerPortBudgetMb` 每端口硬约束，默认 200MB，超限一次性裁到 50%）；`TerminalLine.rawData` 由 number[] 改 `Uint8Array`（内存 8 倍削减 + 免解码临时拷贝）；RX 管线写量限制（`maxLinesPerTick` 默认 2000）；`send_serial_data` 改 async + `tokio::task::spawn_blocking`（消除每次 TX 主线程卡顿与 tao 警告白屏），`AppState` 字段改 `Arc<Mutex<..>>`；状态栏内存为应用进程树 RSS（本进程 + 含 WebView2/Chromium 的后代进程）；端口排序改一次性动作 `sortPortsByNumber()`（移除持久 sortMode 开关）；串口右键菜单分组控制；QuickSendPanel 文本模式「执行当前行并移至下一行」按钮；ConfigModal 框选文字松手界外不再关闭；通知中心面板加大；快捷发送 pill 两行显示。

v0.4.2 (issue #6-10)：TX 读写句柄 try_clone 拆分（`SerialPortHandle` 拆为 read_port/write_port 双 `Arc<Mutex<..>>`，读线程独占读句柄、发送独占写句柄，TX 阻塞不再饿死 RX）；热路径摘除无界 `flush()`（Windows = FlushFileBuffers，无超时、受流控约束）+ `write_all_with_deadline` 总写期限（`WRITE_TOTAL_DEADLINE` 2s）；发送两段式（全局锁内只取写句柄克隆，锁外只持 per-port 写锁写，不再持全局 serial_manager 锁执行写）；前端 RX 管线 visibility-aware 排空（document.hidden 时 rAF 停摆 → setTimeout 兜底，visibilitychange 重排）+ 每端口队列上限 `maxQueuedLines`（默认 10000，超限丢最旧）。

v0.4.3 (issue #7 UI 缺陷修复十项)：通知中心——`ToastItem` 新增可选 `portId`（触发告警/断线/发送目标关闭/重连失败均携带），通知行显示串口 chip + HH:MM:SS 时间戳；快捷发送条「打开命令面板」按钮改**按压按钮样式**（accent 填充 + 文字标签 `quickSend.openPanelShort`，min-height 34px 与两行药丸对齐）；发送提示前缀 `sendPrefix` 默认留空（功能保留，DisplaySettings 可配）；快捷发送面板目标串口下拉去掉 `· REAL/VIRTUAL` 后缀，底栏「发送到」提示灯跟随真实状态（订阅 `serial:status` + 新 `port-statuses:sync` 对表事件：绿=连接呼吸/灰=断开）；发送区命令集选择/循环/编辑三控件紧跟「发送命令」标题（去 `margin-left:auto`）；设置界面移除「串口参数预设」（操作面板参数区已有完整管理）；去「一键」文案；分组整组执行外部工具改 **Promise.all 并行**；新 `TextEditContextMenu`/`useTextEditContextMenu`——输入框/文本域/可编辑区右键显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选，`document.execCommand` + 选区快照恢复），App 根 + PopoutShell 各挂一次，取代 App.tsx 旧 contextmenu effect。

v0.5.0 (issue #11 TTY 模式)：每端口新增 `mode: 'trx' | 'tty'`——TRX=既有行级终端（不变）；TTY=xterm.js（`@xterm/xterm` + `@xterm/addon-fit`）渲染的完整交互终端（真实 ANSI/VT100、光标、备用屏幕 vim/top、onData 尺寸协商，**无本地回显**由对端 echo），取代该端口的 TerminalView。切换在 OperationPanel→ParamsSection 分段控件（i18n `params.mode.*`），经 `port_meta`（config.json）持久化；`useSerialReceive` 按 `mode==='tty'` 分流字节直喂 `ttyService`（跳过触发引擎/协议解析/RxPipeline），断线走 `ttyService.disconnect`；`sendToPort` TTY 分支跳过 TX 回显与 flushNow（保留后端发送/流量统计/发送历史）。**TTY 标签在 Pane 内常驻挂载**（非活动标签 `.tty-view-hidden` display:none 隐藏，恢复可见自动 re-fit），**会话跨标签切换保留**——仅模式切换/关闭标签/跨 Pane 拖拽销毁实例（xterm `open()` 只能调用一次）。字体/字号经 `term.options` 活更新不重建 Terminal。新增调试专用「模拟终端」GIT:BASH 虚拟串口（Cargo `portable-pty` 0.9，Windows = ConPTY，spawn 本地 git bash pty），门控与 SIM:Loopback 一致（前端 `import.meta.env.DEV`、后端 `cfg(not(debug_assertions))` 命令拒绝），侧边栏工具栏按钮（Terminal 图标，i18n `sidebar.toolbar.enableGitBashSim`/`disableGitBashSim`）。

v0.5.3+ (issue #12 自动更新)：**通道是运行时用户选择**（设置项 `updateCheckMode: 'none'|'stable'|'preview'`，config.json 持久化，默认 stable；About 手动检查可选正式版/preview，不过 DEV 门控）。由于 JS `check()` 无法运行时指定 endpoint，更新链路由新 `commands/update.rs` 承载（`check_for_update`/`download_and_install_update` + `update:progress` 事件，`cfg(not(debug_assertions))` 门控返回 Ok(None)）——stable 直连 `releases/latest/download/latest.json`（GitHub 原生「最新非 prerelease」指针，永不泄漏 preview）；preview 先经 GitHub API（`api.github.com/releases?per_page=100`，含 prerelease）解析**版本号最大**的 `vX.Y.Z-preview.N` tag（纯函数 `find_latest_preview_tag`；复审：API 按创建时间序，取数值四元组最大而非第一个命中）再指向 `releases/download/<tag>/latest.json`（唯一 tag、preview→preview 自升级；未认证 API 限流 60/h/IP 超限静默降级）。前端 `useAutoUpdate`（等 `ui.configReady` 信号后评估——复审替代旧 3s 启发式窗口，config 加载慢于 3s 会按默认模式误判）：7 天周期 + `shouldAutoCheck` 纯函数（首启立即、snooze 暂停、成功检查才记 lastCheckAt（完成时刻）—— localStorage 记账）；发现更新 → `UpdateDialog` 三动作（立即更新带进度/7 天后提醒写 snooze/永不提醒同步 `updateCheckMode=none`）。版本号约定：稳定 `0.x.y`、preview `0.x.y-preview.N`（属于下一核心，同核心 preview<stable 晋升自洽）。发布：`.github/workflows/publish-preview.yml`（tag `v*-preview*`，唯一 tag + `prerelease:true` + `releaseDraft:false`）与 publish.yml（同过滤器 `!v*-preview*` 否定排除）双流，两流均显式 `updaterJsonPreferNsis: true`（latest.json Windows 块指向 NSIS——tauri-action 默认 false 会指 MSI，偏离验收路径，复审修复）；capabilities 加 `process:default`（relaunch 必需；首轮曾加 `updater:default`，复审移除——更新链路全走 Rust 命令，JS updater IPC 零使用，npm 包 `@tauri-apps/plugin-updater` 一并卸载）；新增 `@tauri-apps/plugin-process`/`tauri-plugin-process`/`reqwest 0.13(rustls)+url` 依赖。评估/周期/snooze 纯逻辑注入测试用 `enabledOverride` 参数（vitest 中 import.meta.env.DEV 被静态替换为 true，无法 stubEnv）。复审加固：安装命令带 `expectedVersion` 安装前重检查版本比对（防「展示 X 装 Y」TOCTOU）；未知 channel 报错（不静默回退 stable）；GitHub API 15s 超时；模式变更清账副作用（clearSnooze+clearLastCheck——lastCheckAt 不分通道，旧通道周期会推迟新通道首检）挪到 ConfigModal 保存边界（旧在 radio onChange，取消时副作用泄漏）；下载中遮罩点击不可关闭弹窗；`channel.ts` 死代码 `detectChannel`/`isPreviewVersion` 删除（仅存 `channelLabelKey`）。二轮增强（2026-08-16，方案级补漏）：preview 通道语义改 **max(preview, stable)**——`check_for_update("preview")` 双检查取 semver 大者（纯函数 `newer_channel`/`version_key`；preview 解析失败降级 stable），preview 用户收尾后自动晋升 stable、热修不缺，`payload.channel` 反映更新实际来源；会话内 6h 周期重评估（常驻挂机覆盖）；改通道保存后立即首检（`runAutoCheck`）+ 设置页显示「上次自动检查」；changelog 轻量 Markdown 渲染（`utils/changelog.ts`，非 dangerouslySetInnerHTML）；弹窗「查看发布页」链接（`releaseUrl`，tag 约定 `v<version>`）；`shouldAutoCheck` 时钟回拨防护；发版 CI 三重护栏（tsc+vitest+cargo test 质量门、RELEASE_NOTES 章节↔版本校验、`verify-release` latest.json 四平台键 gate）；macOS 自动更新声明暂不支持（未签名/公证，产物可手动安装）；密钥轮换/坏版本召回 SOP 见 `docs/architecture/release.md`。详 `docs/architecture/update.md`。

v0.5.2 (issue #13 自定义背景图·全应用毛玻璃)：**四个新配置项**（`backgroundImage` 路径/'未设置'、`backgroundImageEnabled` 默认关、`backgroundImageOpacity` 0–100% 默认 50、`backgroundImageBlur` 0–64px 默认 0；Rust `AppConfig` serde 缺省回退 + `validate_and_clamp` 夹取 + TS 接口/`defaultConfig`/configMerge.test fixture 四侧同步）。**图片加载不走 asset protocol**（老 v1 实现裸 `url("C:\...")` 在硬化 webview 载不动，issue #3-5 因而删除）——新命令 `read_image_data_url`（`commands/file.rs`，`base64` crate）读文件为 `data:image/<mime>;base64,` data URL（dev/prod 一致），20MB 上限 + 扩展名白名单（png/jpg/jpeg/bmp/webp/gif/svg，纯函数 `image_mime_from_ext`）+ 文件缺失/超限静默 `Ok("")` + `log::warn!` 降级。**呈现**：`App.tsx` 首子元素 `<div class="app-background">`（fixed + `z-index:-1` 垫底）经 `ThemeProvider` 映射 CSS 变量（`--app-bg-image/-opacity/-blur` + `html[data-app-bg="on"]` 门控，异步读图带 cancelled 防竞态）；`styles/background.css` 在启用时把**全部 `--bg-*` 表面 token 换半透明 rgba**（终端区最深 0.72、浮层 0.90 保可读）实现全窗毛玻璃，并摘除 `.app-root` 自身底色防双重着色；亮/暗主题两套 alpha 值。**xterm 主题背景创建时快照**（TtyView 初始 `cssVar('--bg-primary')`）——切玻璃开关需活更新：TtyView 新 effect 按 config + `data-theme` 构造 rgba 写入 `term.options.theme`（不读 CSS 变量，避免与 ThemeProvider 父 effect 时序竞态）。设置 UI 在「显示与交互」页新增「背景图」区段（启用勾选 → 只读路径 + 浏览按钮（dialog 插件 png/jpg/jpeg/bmp/webp/gif 过滤器）→ 不透明度/模糊度 number input + `clampNumber`），i18n `displaySettings.background.*` 7 键双语。已知边界：弹出窗（独立 webview）不共享背景层。

v0.6.3 (issue #10/#11/#12)：**① 缓冲裁剪 DOM 泄漏修复**（#10 输出区上下抖动根因）——head trim 前进 firstSeq 后 active 行 visIdx 字段停留在旧窗口值，stale 检查按字段判定永不回收 → DOM 行数无限增长（e2e 实测 6669 vs 正常 27）→ 每帧 O(n) 渲染 → 帧率暴跌抖动。修复：stale 判定改用**实时列表位置** `seqToVisIdx`（identity O(1)、过滤模式二分），越界即回收，DOM 恒 ≤ 窗口+overscan。**② 关闭标签页不再关闭串口**（#11）——`Pane.cleanupClosedTab` 移除 `closePort`（端口/日志保持连接），改 `getRxPipeline().disconnect(tabId)` + `ttyService.detach(tabId)` 清前端管线；`appendTerminalLines/appendTerminalLine/replaceTerminalLines` 语义改「manager 存在才写入」、无标签页时静默丢弃（重开标签页从零开始新一轮输出，后端 RX 日志独立落盘不受影响）；`ttyService.feed` 对「无标签页且未 attach」丢弃（挂载前首帧仍入队等 attach replay）。**③ 拖选滚动黑块修复**（#12）——拖选冻结期间允许物化**新**行（acquire+归位+写内容，新行不在活选区 Range 内安全），仅冻结已有行保护选区锚点。e2e 新增 3 例（#11 关标签 keep 连接+重开从零、#10 trim 期 DOM ≤40+scrollTop 单调、#12 拖选滚动视口行有内容）。

前端整理（2026-08-26，全仓审计后的一次性清理，无版本号变更）：**死代码删除**——`useRuleStore.activeHighlightSetId`/`activeProtocolTemplateId` 及 setter（全仓零生产消费，RulesSection 移除后遗留）+ `useConfigPersistence.resetAndReload`（零消费）+ `logService.setLogDirectory`（零消费，后端命令保留）+ `useSerialReceive.setupPromiseRef`（死 ref）+ `hasViewportManager` 导出 + i18n 12 个零引用 key（550 键/侧）；**重复实现合并**——`clampNumber` 5 份页内拷贝 → `utils/clampNumber.ts` 单一实现；`performance.memory` 读取两份 → `utils/jsHeap.ts`（readJsHeapBytes/Mb）；`usePanelCyclicSend.onProgress` 回调删除（消费者传空函数，本身是死参数）；**异步时序修复**——① 重连循环每轮开头检查 `userClosingPortIds`，用户主动关闭后不再悄悄重开（P0；**不能**看 port.status——后端先发 disconnected 再发 reconnect_hint，attempt=0 时 store 已是 disconnected，会误杀整个循环）；② `runAutoCheck` 模块级 in-flight 锁，改通道首检与 6h 周期并发不再双弹窗/双记账；③ `usePopoutBridge` 全部 fire-and-forget emit 补 `.catch`（弹窗销毁时 rejection 不再 unhandled）；④ `TerminalPopout` 快照 replaceAll 竞态——缓冲已有实时行时改为「快照历史 + 现有行」合并，不丢新行；⑤ `rxPipeline.feedBytes` 不加 tab 存在性门控——弹出窗 store 从不填充 `tabs`（TerminalPopout 只 setConfig），门控会丢光弹窗实时流；对已 release 的 manager 喂数据本就是静默 no-op（有界）；⑥ `openPort`/`closePort` 加 per-port in-flight 守卫，同一事件循环连点不再并发 open 同一句柄；⑦ ThemeProvider 背景图 effect 拆分——opacity/blur 只改 CSS 变量，不再反复读盘；⑧ 触发 respond 失败补 debug 日志；**性能**——OperationPanel/ParamsSection/SendSection 的 `ports.find(...)`/整包 `config` 新引用选择器拆为原语选择器（3s 轮询不再整树重渲染）；**文档**——AGENTS.md/hooks/ConfigModal/MainDisplay 计数断言全部对齐实际（15 hooks / 11 域文件 / 16 CSS / 9 pages / 550 i18n 键），MainDisplay AGENTS.md 移除已删的 TerminalRow.tsx 幽灵条目与 react-virtual 描述。
