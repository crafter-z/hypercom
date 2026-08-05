# 缺陷追踪

> 仅记录当前存在的未修复缺陷。已修复项移入变更历史。

## 未修复

当前无未修复缺陷。

## 已修复 (2026-08-05 日志审计完善：错误路径补日志 + 分级合理化 + 去噪音/刷屏)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 415/415 (20 files), `cargo check` 0 错 0 警告, `cargo test --lib` 48/48。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `commands/serial.rs` / `config/mod.rs` | 后端错误路径只抛 `CommandError`、不落后端日志：开/关/发/设参数/设流控/发文件/重连/存配置失败时，诊断日志文件（后端 `log::*`）缺失根因，只能依赖前端转发 | 各命令错误分支补 `log::warn!`（开/关/发/参数/流控/发文件/自动重连），`ConfigManager::save()` 失败补 `log::error!` |
| MEDIUM | `serial/mod.rs` | 读线程异常退出（意外断线）无后端日志，只有前端事件 | 异常退出时补 `log::warn!("...read thread exited abnormally")` |
| LOW | `usePopoutBridge.ts` | 两处正常控制流分支（无活动标签/无缓冲区）当错误打 debug，属噪音 | 删除（正常分支非错误） |
| LOW | `useSerialPorts.ts` / `highlightEngine.ts` / `useSerialReceive.ts` | 潜在刷屏：端口枚举失败每 3s 一条 warn；非法正则随每批 RX；触发引擎异常随每次 RX | 端口枚举连续失败仅首次 warn、后续降 debug；非法正则以 pattern 去重只告警一次；触发异常限流每 2s 一条 |
| MEDIUM | ConfigModal 各设置页 / OperationPanel | 设置实体加载失败仅 `console.debug` 且无用户提示，用户无感知 | 提升为 `console.warn`；命令集/高亮/协议模板加载失败补 `notifyError` toast（用户持久化数据）；顺带修正 `ToolSettings` 过时的 "SQLite" 注释与 `delete ... from DB` 文案 |

测试新增：`diagLog` 解析已在上一轮补充；本次主要改日志语句，无新增测试（`cargo test` 48、vitest 415 均保持）。

## 已修复 (2026-08-05 issue #4 十项：高频滚动钉底 · 参数实时生效 · 状态栏去 LED · 去「替代」文案 · 移除帮助 demo · About 链接/版本/许可证 · 备注名与分组持久化)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 410/410 (19 files), `cargo check` 0 错 0 警告, `cargo test --lib` 42/42。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `TerminalView.tsx` | 快速大量输出时滚动锁定跟踪不及时：`scrollToIndex(count-1, align:'end')` 用未测量尾行的 estimateSize，单帧 rAF 钉底在虚拟器测得新行、totalSize 增长后仍会偏上，持续高频输出下每帧漂移数像素（issue #4-1） | `scrollToBottom` 改为**双帧 rAF 钉底**：第一帧钉到当前底部，第二帧（虚拟器已重新测量新行并增长 totalSize）再钉到真实底部；只碰 scrollTop，不碰 scrollLocked/followRef |
| HIGH | `OperationPanel.tsx` / `useSerialConnection.ts` | 串口参数不实时生效、重连回退 115200、侧边栏/标题栏不跟随（issue #4-2）：① 参数同步 effect 依赖数组缺 `baudRate`，改波特率不触发后端重配；② openPort 用 `port?.baudRate ?? opStore.baudRate`，而端口存储的 baudRate 不随操作面板更新，重连读回旧值；③ 参数变更不回写端口字段，串口管理面板/标题栏显示旧参数 | ① 订阅 `baudRate`（自定义输入走 ParamsSection 本地 draft，仅失焦提交，逐键不重渲染）并加入同步 effect 依赖；② effect 改为按「端口+参数签名」区分切换标签与参数变更：切换标签把该端口已存参数载入操作面板，参数变更时 `updatePort` 回写端口字段（侧边栏/标题栏/重连同步）+ 后端防抖实时应用（已连接时 `setSerialParams`+`setFlowControl`） |
| HIGH | `StatusBar.tsx` / `usePinStatesSubscriber` / `usePinStatesStore` / `serial/mod.rs` | 状态栏每连接串口显示 6 个引脚状态灯，USB-TTL 两针串口无意义且多端口时底栏混乱（issue #4-3） | 移除状态栏引脚 LED 显示，并端到端清理引脚状态死代码：前端 `usePinStatesSubscriber`/`usePinStatesStore`/`eventService.onSerialPinStates`/`pin.*` i18n/`pin-led` CSS；后端 `SerialPinStatesEvent` + 读线程 200ms 引脚轮询 + `dtr_state`/`rts_state` 共享字段（DTR/RTS 控制仍保留在操作面板） |
| LOW | `i18n.ts` / `README.md` / `AGENTS.md` | 「为替代 SSCOM / SuperCom 而生」等对比文案散落各处（issue #4-4） | 全部改为中性描述（`about.description` 中/英、README 首段、AGENTS 概述）；release note 不再含此类对比信息 |
| MEDIUM | `TitleBar.tsx` / `FirstRunTour.tsx`(删除) / `useHotkeys.ts` / `config/mod.rs` | 「帮助」按钮只是 demo 引导（首次运行 Tour），无用（issue #4-5） | 删除帮助按钮 + `FirstRunTour` 组件 + `tour.css` + `tour.*` i18n + `config.hasSeenTour`（后端 `#[serde(default)]` 兼容旧 config.json）+ `ui.configLoaded` + useHotkeys 中 Escape 关闭引导分支；快捷键帮助弹窗（真实功能）保留 |
| MEDIUM | `AboutDialog.tsx` | 关于界面无 GitHub 链接（issue #4-6） | 新增「GitHub 仓库」按钮，`@tauri-apps/plugin-shell` `open()` 打开 `https://github.com/crafter-z/hypercom`（capabilities 已有 `shell:allow-open`） |
| MEDIUM | `AboutDialog.tsx` / `TitleBar.tsx` / `i18n.ts` | 关于界面版本号显示 `v0.1.0 (0.3.2)`（issue #4-7）：硬编码 `titleBar.version`('v0.1.0') 叠加真实版本 | 删除硬编码版本；About 只显示 `getVersion()` 真实版本（`v0.3.2`）；删除标题栏静态版本号与 `titleBar.version` key |
| MEDIUM | `THIRD_PARTY_LICENSES.md`(新增) / `AboutDialog.tsx` / `LicensesDialog.tsx`(新增) | 技术栈依赖许可证未成文，About 无浏览入口（issue #4-8） | 新建 `THIRD_PARTY_LICENSES.md` 列全部前后端依赖与 SPDX 许可证（含双许可说明）；About 新增「开源许可证」按钮打开 `LicensesDialog`（前端/后端依赖→许可证表格，含备注指向完整文档） |
| HIGH | `config/mod.rs` / `commands/storage.rs` / `useAppInit.ts` / `services/tauri.ts` | 串口「备注名」仅存内存，重启丢失，只显示串口号（issue #4-9） | 新增 `PortMetaEntry{portId, alias?, isHidden}` + `AppConfig.port_meta`（`#[serde(default)]`）+ `save_port_meta`（整体替换落盘）+ `storageService.savePortMeta`；`useAppInit` 启动回填 alias/isHidden 到端口列表，并新增按「alias/isHidden 签名」比较的 500ms 防抖自动保存（3s 轮询重建数组但值不变不会误触发） |
| HIGH | `useAppInit.ts` | 分组重启丢失（issue #4-10）：分组走 `save_port_groups` 单独落盘，但 ConfigModal/主题切换等**全量 `set_config`** 会用 store 中陈旧的 `config.portGroups` 覆盖掉已保存的分组 | 分组自动保存落盘前同步 `setConfig({ portGroups })`（元数据保存同理），确保任何全量保存都携带最新分组；启动恢复顺序不变 |

架构变化：`AppConfig` 新增第 8 类实体 `port_meta`（备注名/隐藏）；移除 `hasSeenTour` 配置字段与引脚状态全链路；`useOperationStore` 现订阅 `baudRate`（提交时，非逐键）；新增 `LicensesDialog`。测试新增：config `port_meta` 往返/缺省回退 1 例。

已知边界（记录而非缺陷）：① 端口参数（baudRate 等）仍走会话快照持久化（`restoreSession` 开启时）；仅备注名/隐藏状态随 `port_meta` 无条件持久化。② 参数「切换标签载入端口已存值」意味着操作面板随标签切换更新参数——这是 per-port 参数的预期行为，旧版「全局参数」不再适用。

## 已修复 (2026-08-04 issue #3 六项：条件触发接线+指定串口 · 波特率自定义输入卡顿 · 滚动锁定脱节 · 日志格式设定 · 背景图删除 · 漏斗图标删除)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 410/410 (19 files), `cargo check` 0 错 0 警告, `cargo test --lib` 41/41。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `useSerialReceive.ts` / `triggerEngine.ts` | 条件触发完全不生效（issue #3-1）：`evaluateTriggers` 规则链（定义/持久化/加载/CRUD）完整但**生产代码零调用**——没有任何代码把 RX 数据喂给引擎 | 在 `serial:data` 回调（流量统计后、protocol 分支前）接入 `evaluateTriggers`：用 `useRuleStore.getState().triggerRules` 实时读取（回调内禁订阅）、`pipeline.decodeText` 解码文本供 contains/exact/regex、原始字节供 hex；`alert` → `useToastStore.push`（i18n `trigger.alertMessage`，同规则 1s 节流防刷屏）、`respond` → `sendToPort(portId, content, isHex, 'None', silent=true)`（失败静默不打断 RX 循环）；try/catch 兜底 |
| HIGH | `types/index.ts` / `config/mod.rs` / `TriggerSettings.tsx` | 触发规则无法指定串口（issue #3-1）：`TriggerRule` 无 portId 字段，规则对所有端口生效 | `TriggerRule.portId?: string`（前端）+ `TriggerRuleEntry.port_id: Option<String>`（后端 `#[serde(default)]` 兼容旧配置）+ `evaluateTriggers` 第 4 参 `portId` 过滤（规则声明了 portId 且与当前端口不符时跳过，空=全部端口）；TriggerSettings 展开区新增「指定串口」下拉（`useAppStore.ports`，`trigger.portId`/`trigger.portId.all` i18n key） |
| HIGH | `types/index.ts` / `i18n.ts` / `TriggerSettings.tsx` / `useAppInit.ts` | 「添加书签」触发动作是死功能（issue #3-1）：项目无书签系统，`bookmark` 仅存在于类型联合/i18n key/UI 选项，零实现 | 从 `TriggerActionType` 联合、`trigger.actionType.bookmark` i18n key、TriggerSettings 动作下拉三处移除；`useAppInit` 启动加载时把旧 config.json 残留的 `actionType==='bookmark'` 规则归一为 `alert`（String 比较规避类型不重叠）；TriggerSettings 修复加载 bug（删除全部规则后重启残留旧规则——`rows.length>0` 才 set 改为无条件 set） |
| HIGH | `ParamsSection.tsx` / `OperationPanel.tsx` / `SendSection.tsx` | 波特率选「其他...」后 UI 特别卡且无法手动输入（issue #3-2）：① `isCustomBaud` 由 useEffect 从 `defaultBaudRates.includes(baudRate)` 派生，键入到预设值（如 9600/115200）瞬间翻转 → 输入框卸载、焦点丢失；② `Number(v) \|\| 9600` 清空/输 0 回弹；③ 每键 setOpState → OperationPanel 订阅 baudRate 全面板重渲染 + 连接时每键 2 次后端重配（setSerialParams+setFlowControl） | ① `isCustomBaud` 改**显式用户意图**：仅 select onChange 写入，删除自动派生 effect（挂载时按初始 store 值恢复一次）；② 自定义输入改**本地 draft state**：键入只改字符串、blur 才解析提交（有效 >0≤4000000 提交、无效还原），无回弹；③ OperationPanel 删除 baudRate 订阅（effect 内 `getState()` 读实时值），参数同步 effect 下沉 300ms 防抖（连续键入合并为一次后端调用）+ unmount 清理 timer；SendSection `React.memo`（props 全稳定） |
| HIGH | `TerminalView.tsx` | 大量数据输出时滚动锁定显示锁定但实际不在底部（issue #3-2→#3-3）：① maxLines 满后 `appendTerminalLines` 头部 splice → `lines.length` 恒定 → auto-follow effect（依赖 `renderedCount`）永不重触发，但 getItemKey 全量平移重挂载重测量导致 scrollTop 过期；② `scrollToIndex(count-1, align:'end')` 用未测量尾行的 estimateSize，ResizeObserver 实测后 totalSize 增长、tanstack retry 窗口（10 rAF）耗尽后无校正 | ① auto-follow effect 追加**首尾行 id 依赖**（`lastLineId`/`firstLineId`，O(1) 派生）：新行到达与头部裁剪都触发重钉底；② `scrollToBottom` 在 scrollToIndex 后追加一帧 rAF 的 DOM 钉底（`el.scrollTop = el.scrollHeight`，只碰 scrollTop 不碰 scrollLocked/followRef）兜底测量滞后 |
| MEDIUM | `config/mod.rs` / `logger/mod.rs` / `commands/config.rs` / `LogSettings.tsx` / `types/index.ts` / `useAppStore.ts` | 日志格式不可配置（issue #3-4）：`[timestamp] direction data` 硬编码在 `PortLogWriter::write_line`，无时间戳/RX·TX 前缀开关 | 新增 `AppConfig.log_include_timestamp` / `log_include_direction`（`#[serde(default = "default_true")]` 兼容旧 config.json）+ `LogManager` 同名字段与 setter + `PortLogWriter` 创建时锁定 + `write_line` 前缀按开关拼接（四组合：全开/仅时间戳/仅方向/全关）+ `sync_log_manager_from_config` 同步两行；LogSettings 新增两个 checkbox（`logSettings.includeTimestamp`/`includeDirection` i18n key） |
| MEDIUM | `GeneralSettings.tsx` / `ThemeProvider.tsx` / `base.css` / `types/index.ts` / `useAppStore.ts` / `config/mod.rs` / `i18n.ts` | 背景图片功能未实现，设置界面不应展示该选项（issue #3-5） | 从设置界面删除背景图 config-row（selector + 浏览按钮 + `open` import），删除 `AppConfig.backgroundImage`（TS + Rust）、`defaultConfig.backgroundImage`、ThemeProvider 的 `--bg-image` effect、base.css 的 `--bg-image` 变量与 body background-image 规则、4 个 i18n key |
| LOW | `TerminalFilterBar.tsx` / `terminal-view.css` | 「全部/仅TX/仅RX」前有无意义的漏斗图标（issue #3-6） | 删除 `<Filter>` 图标（lucide import + JSX 行，纯装饰 aria-hidden 无交互）与 `.terminal-filter-icon` CSS 规则 |

架构变化：`TriggerRule`/`TriggerRuleEntry` 新增可选 `portId`（空=全部端口）；`TriggerActionType` 移除死成员 `bookmark`；AppConfig 日志实体新增 2 个布尔格式开关；`background_image` 配置字段全链路删除。测试新增：triggerEngine portId 过滤 3 例、useRuleStore TriggerRule CRUD 7 例、logger 前缀开关 1 例、config 兼容性 2 例（日志字段缺省回退 + port_id 可选）。

已知边界（记录而非缺陷）：① 触发匹配按**事件**粒度（serial:data 每事件解码文本），跨事件拆行的 contains 匹配依赖 RX 管线成行后才有完整文本——字节级 HEX 匹配不受影响；② alert 节流为模块级 Map（规则 id → 最后时间戳），应用生命周期内有效。

## 已修复 (2026-08-04 issue #2 九项：标签菜单批量开关/外部工具 · 分组持久化 · 自然排序 · 面板尺寸 · 搜索高亮 · SIM 仅调试)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 400/400 (19 files), `cargo check` 0 错 0 警告, `cargo test --lib` 38/38。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `config/mod.rs` / `commands/storage.rs` / `useAppInit.ts` / `Sidebar.tsx` | 分组设置无法保存，关窗即丢失；「保存布局」手动按钮不直观（issue #2-3） | 新增实体 `PortGroupEntry` + `AppConfig.port_groups`（`#[serde(default)]` 兼容旧 config.json）+ 命令 `save_port_groups`（整体替换落盘）；前端启动经 `get_config` 恢复分组并按成员关系回填 `ports.groupId`，`useAppInit` 订阅 `groups` 变更 500ms 防抖自动保存；移除「保存布局」按钮与 `sidebar.toolbar.saveLayout` key |
| HIGH | `useSerialPorts.ts` / `portSort.ts` / `Sidebar.tsx` | ① 排序结果为字典序 COM1-COM12-COM2（issue #2-4）；② 点击排序后 3s 轮询用枚举顺序覆盖 store，排序瞬间丢失（issue #2-5） | ① 新纯函数 `naturalCompare`/`sortPortsByNatural`：数字段按数值比较（COM1<COM2<COM12），其余逐位不区分大小写；② 根因修复：`mergePorts` 改为按 **existing 顺序**合并（新端口追加），手动排序/拖拽顺序不再被轮询冲掉；侧边栏排序改为**持久开关**——激活时渲染派生自然序（新端口自动落位），排序中禁用拖拽，菜单项带 active 态 |
| HIGH | `TabBar.tsx` / `Pane.tsx` | 标签页右键菜单缺批量开关串口入口（issue #2-1） | 新增「打开所有标签页 / 断开所有标签页」：遍历**全局** tabs，逐个 openPort/closePort（100ms 节流，与侧边栏一键开/关同款），无可连/可断端口时禁用；复用 Pane 的 `useSerialConnection` |
| MEDIUM | `usePortToolActions.ts` / `TabBar.tsx` / `Sidebar.tsx` | 标签页右键菜单缺外部工具入口（issue #2-2） | 抽出共享 hook `usePortToolActions`（runTool 未配置→跳配置页 / killTool / configTool），侧边栏与标签页菜单同源复用，文案复用 `sidebar.port.contextMenu.*` key 保证两处完全一致；运行中显示「终止外部工具」（danger） |
| MEDIUM | `useAppStore.ts` | 操作面板默认高度 200px 无法完整显示发送区+参数区（issue #2-6） | `defaultUIState.operationPanelHeight` 200→280（可拖拽范围不变 [160, 600]）；会话快照本就不持久化 UI 态，新默认对全体用户生效 |
| MEDIUM | `operation-panel.css` | 宽窗口下参数栏 flex:1 拉到 350px+，挤占发送区（issue #2-7） | `.op-section-params` 加 `max-width: 300px` 封顶，多余宽度还给发送区 |
| MEDIUM | `terminalSearch.ts` / `useTerminalSearch.ts` / `TerminalRow.tsx` / `terminal-view.css` | Ctrl+F 搜索仅整行底色，无字符级高亮；且关闭搜索栏后残留 query 仍随每批 RX 全缓冲重扫（issue #2-8 性能隐患） | ① `markSearchMatchesInHtml`：HTML tag/实体感知的 `<mark>` 叠加层，只在命中行（每屏 ~50 行）上包 query 出现处，兼容用户高亮 span 与协议着色（跨界匹配自动拆段），当前匹配行用 current 加强样式；② 匹配计算**仅在搜索栏打开时**进行；③ `findMatchesIncremental` 前缀收窄——继续输入时只重扫「旧匹配 ∪ 新增行」 |
| LOW | `devMode.ts` / `vite-env.d.ts` / `Sidebar.tsx` / `GuideCard.tsx` / `useSimulation.ts` / `simulation.rs` | release 安装包不应含模拟串口（issue #2-9） | 双层门控：前端 `DEV_FEATURES_ENABLED = import.meta.env.DEV` 隐藏烧瓶按钮 / GuideCard SIM 按钮，`useSimulation` 兜底 no-op；后端 `enable/disable_simulation` 在 `cfg(not(debug_assertions))` 下返回错误。`tauri dev`（dev profile + Vite dev server）照常可用 |

架构变化：`ContextMenuEntry` 新增可选 `active` 布尔（开关态菜单项，accent 着色）；hooks 增至 12 个（`usePortToolActions`）；config.json 实体类型增至 7 个（`port_groups`）。

已知边界（记录而非缺陷）：搜索栏关闭期间按 F3 重新打开时，首次导航需再按一次（匹配在打开后才计算——这是「不后台全缓冲扫描」的代价，主路径 Ctrl+F/Enter 不受影响）。

## 已修复 (2026-08-04 RX 管线重构 + 滚动锁重设计 + 快捷跳转，关闭 GitHub issue #1)

> 验证: `npx tsc --noEmit` 0 错, `npm run test:run` 364/364 (17 files), `cargo check` 0 错 0 警告（后端未改动）。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `useSerialReceive.ts` / 新 `utils/rxAssembler.ts` / `utils/rxPipeline.ts` / `useTerminalStore.ts` | RX 输出碎片化（issue #1-1）：「一事件一行」模型下，跨多个 serial:data 事件到达的设备响应被撕成碎片行，首字符经常独占一行 | 新 RX 管线：`RxLineAssembler` 字节级切行（CR/LF/跨事件 CRLF 对/空行/4KB 无分隔强制发射——0x0A/0x0D 在全部四种受支持编码中都不可能出现在多字节序列内部）+ `RxPipeline` rAF 批写（每帧每端口最多 1 次 `appendTerminalLines`）+ 250ms 静默 flush（尾行时间戳沿用最后事件时间而非 flush 时刻）+ 每端口缓存解码器（`ignoreBOM:true`，非流式 decode 默认剥行首 UTF-8 BOM）。`StreamingDecoderCache` 整体删除（被取代） |
| HIGH | `TerminalView.tsx` | 滚动锁几乎不可用（issue #1-2/3）：`onScroll` 按 atBottom 隐式写 `scrollLocked`——挂载时虚拟滚动器在顶部、测量滞后、80ms 守卫过期后的内容增长都会误解锁；点锁定按钮不滚底 | 显式意图状态机：`scrollLocked` 仅由图钉按钮 / 跳转按钮 / 手势 settle（滚轮、滚动键、滚动条拖拽 `target===currentTarget`、中键自动滚动 `button===1`，120ms 静默后按最终位置 50px 容差判定）写入；**彻底删除 onScroll 隐式解锁**；锁定（false→true 或挂载即锁定）立即滚底；搜索栏打开时抑制跟随、关闭时若锁定则回到最新 |
| MEDIUM | `useSerialSend.ts` | 批写引入的时序隐患：零延时循环发送会渲染成 TX1,TX2,RX1（RX1 响应还在队列等 rAF）；发送前到达的 RX 显示在 TX 行之后 | `sendToPort` TX 回显前 `getRxPipeline().flushNow(portId)` 同步排空该端口 RX 队列，双重恢复「发送前的 RX 先于 TX、TX 先于其响应」时序 |
| MEDIUM | `protocolParser.ts` | `feed()` 返回 `{frames, flushedBytes}`：帧**之前**的裸字节被排在所有帧之后渲染，字节流顺序错乱（既有缺陷，批写会放大紊乱窗口） | 改返回有序段数组 `ReassemblerSegment[]`（`{kind:'frame'|'raw'}`，相邻 raw 合并）；`useSerialReceive` 按段顺序入队（帧走 `enqueueLines`、raw 走 `feedBytes`，共享队列天然保序） |
| MEDIUM | `TerminalView.tsx` / `TerminalRow.tsx` / `useTerminalDisplay.ts` / `lineFilter.ts` / `timeFormat.ts` | 高频输出渲染热点：恒等过滤映射每帧分配全缓冲索引数组；`firstInRound` / `originalToFiltered` 每帧 O(n) 全缓冲重算；`TerminalRow` 每帧全量重渲染（`terminal`/`lines` prop 身份每帧变化） | `filterLines` 无过滤返回 `null` 哨兵 + `limit` 参数替代暂停前缀 slice；`originalToFiltered` 惰性构建；firstInRound 每可见行 O(1)；`TerminalRow` `React.memo` + 原语 props（`prevLine`/`displayFormat`/`showTimestamp`/`connectedAt`）+ `formatTerminalTimestampAdj`；`estimateSize` 读 store 字号（去掉逐次 getComputedStyle） |
| LOW | `TerminalFilterBar.tsx` | 编码切换时 RX 管线未终结尾部字节被新 label 直接解码，缝合处乱码（如 GBK 尾字节被当 UTF-8 首字节） | 切换前 `getRxPipeline().flushAndReset(portId)`：旧编码冲刷尾部落盘 + 重置组装器/解码器 |

新功能：终端滚动条上下两端快捷跳转按钮（`ArrowUpToLine`/`ArrowDownToLine`）——到顶自动解除滚动锁定、到底锁定并跟随最新（按钮在锁定态点亮）；Ctrl+Home/Ctrl+End 等价键盘路径。i18n 新增 `terminal.jumpToTop` / `terminal.jumpToBottom`。

架构变化：弹出窗 RX 与主窗共用 `RxPipeline`（独立 webview 各自的模块单例）；`useSerialReceive` 不再持有任何 store 选择器订阅（effect deps `[]`）；流量统计在事件处理器顶部统一计一次。已知平台降级：Linux WebKitGTK 原生滚动条可能不派发 pointerdown——滚动条拖拽解锁在该平台静默失效，滚轮/键盘/图钉不受影响。

## 已修复 (2026-08-03 后端串口加固 + 串口测试 + 文件发送取消)

> 验证: `cargo check` 0 错 0 警告, `cargo test --lib` 37/37（Windows；非 Windows 另含参数映射 / 管理器错误路径 / 端口枚举测试）, `npx tsc --noEmit` 0 错, `npm run test:run` 290/290。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `commands/serial.rs` `send_file` | 文件发送无法取消；写错误 / 取消 / 空文件时不发终结事件 → 前端进度条永久卡住；`delay_ms==0` 时整循环无 `.await` 让出点，饿死其它异步任务；`std::fs::read` 在异步命令里阻塞运行时线程 | 注册 per-port 取消令牌（`AppState.file_send_cancel`）+ 新命令 `cancel_file_send`；循环每块前检查令牌、写错误捕获后 break；`delay_ms==0` 改 `yield_now().await`；读文件改 `tokio::fs::read`；循环后**无条件**清理令牌并发 `serial:file_progress{done:true}`（正常 / 取消 / 写错 / 空文件四路径都触发） |
| HIGH | `serial/mod.rs` | 异常断线后陈旧句柄留在 `ports`，`open_port` 无守卫 → 手动重开报 OS「access denied」，且 `insert` 可能丢弃存活句柄、泄漏游离读线程；SIM 端口读线程退出从不发 `disconnected`（与真实端口不一致） | `open_real_port` / `open_sim_port` 加陈旧句柄守卫（存活 → 干净报错「already open」；死线程 → 移除并释放 OS 端口）；SIM 读线程退出补发 `serial:status disconnected` |
| MEDIUM | `commands/serial.rs` `run_port_tool` | 在全局串口锁内 `thread.join()`（阻塞其它串口命令）；`BufReader::lines()` 遇非法 UTF-8 静默截断烧录器二进制输出；重开端口失败仅 `log::warn`，UI 不反映 | join 移到锁外；stdout/stderr 改 `read_until(b'\n')` + `from_utf8_lossy`；重开失败补发 `serial:status error` |
| MEDIUM | `serial/mod.rs` / `commands/serial.rs` | SIM / 文本带行结束符时，发送字节数、TX 日志字节数、回显三处不一致（SIM `send_data` 忽略行结束符；TX 日志另抄一份解析逻辑） | 抽出 `build_tx_bytes` 作为「实际写入字节」唯一事实来源，`send_data` 与 TX 日志共用；`emit_data_event` 只取一次 `now()`，格式化串与毫秒同源 |
| MEDIUM | `serial/mod.rs` 测试 | 整个串口模块零测试；且 `use super::*` 通配导入会把 `serialport` FFI 拉进 *测试* 二进制，Windows 上 `cargo test` harness 因缺应用清单而 `0xc0000139`（STATUS_ENTRYPOINT_NOT_FOUND）加载失败 | 新增 `#[cfg(test)] mod tests`，用**显式导入**（非通配）：纯函数测试（hex 解析含原始索引定位、`build_tx_bytes` 各分支）在 Windows 运行；引用 `serialport` 类型 / `SerialManager` 的测试 `#[cfg(not(target_os = "windows"))]`，在 Linux/macOS CI 运行 |
| LOW | `serial/mod.rs` | `parse_hex_string` 每字节分配 `String`、错误位置指向去空白串；`set_params` 的 `data_bits` 走 `&str` 往返解析 | hex 解析改字节切片、错误位置指向输入原文；`set_params` 的 `data_bits` 改 `u8` 直传（命令层同步去掉 `to_string()` 往返） |

## 已修复 (2026-08-03 操作面板缺陷 + 布局整合)

> 验证: `npx tsc --noEmit` 0 错误, `npm run test:run` 290/290 (16 files), `cargo check` 0 错误 0 警告。前端为主，另在 `config/mod.rs` 给 `SendCommandSetEntry` 加 `repeat_count`（`#[serde(default)]` 兼容旧 config.json）。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `useCyclicSend.ts` | 循环发送第一轮按 per-command `delay`（如 100ms），第二轮起每条命令都变成 `loopDelay`（如 1000ms），且重复轮数>0 时半路提前停发：轮次边界用 `nextIdx >= commands.length` 判定，而 `currentCmdIdx` 持续自增从不归零 → 第一轮后该式恒真，每条命令都误用 `loopDelay`、`completedRounds` 按「条」而非「轮」累加 | 改用「是否本轮最后一条」（`currentCmdIdx === length-1`）判定轮次边界；末条触发 `completedRounds += 1`、`loopDelay` 作轮间间隔、索引归零进入下一轮；轮内命令始终用 per-command `delay`。重复轮数改读命令集自有字段 `repeatCount`（见下），按完整轮数精确停止 |
| HIGH | `usePopoutBridge.ts` / `QuickSendPanel.tsx` / `services/tauri.ts` | 配置弹窗里编辑命令集后若不点「✓ 保存」，主窗快捷发送区能显示新命令，但独立浮窗的发送区不显示：`command-sets:changed` 是不带载荷的信号，弹窗收到后回 config.json 重读，而未保存的编辑只在主窗 `useRuleStore` 内存态、尚未落盘 | 信号改为携带完整 `SendCommandSet[]` 载荷（主窗 store 是唯一真相）：`emitCommandSetsChanged(sets)` / `onCommandSetsChanged(cb:(sets)=>void)`；桥接订阅传 `state.sendCommandSets`，并在 `request-sync` 时回放当前命令集；弹窗抽出 `applySets()` 直接 `setSets(载荷)`，mount 仍读 config.json 取基线、随后载荷纠正为含未保存编辑的实时态 |
| MEDIUM | `useSerialSend.ts` | 发送时 RX 先于 TX 显示（模拟串口尤甚）：`sendToPort` 在 `await sendSerialData` 之后才追加 TX 行，而模拟端口读线程在 await 期间已 emit 回显 RX，RX 抢先入终端 | TX 行改为在调用后端**之前**同步追加（先算 `displayText`/`txRawData` 再 `appendTerminalLine`），保证发送行恒先于其响应；流量统计 / 发送历史仍在 await 成功后记录 |
| MEDIUM | `SendSection.tsx` | 快捷发送区按钮显示命令**内容**而非命令**名称**（独立浮窗早已是 `name \|\| content`，内联条不一致） | 按钮文本改为 `cmd.name \|\| cmd.content`，与浮窗一致；tooltip 保留「名称 — 内容」 |
| MEDIUM | `types/index.ts` / `config/mod.rs` / `CommandSettings.tsx` / `useOperationStore.ts`(+测试) / `useCyclicSend.ts` | 循环「重复轮数」放在全局操作态 `loopRepeatCount`，与命令集脱钩——同一轮数套用到所有命令集，且占操作面板空间 | 重复轮数下沉为命令集自有字段 `SendCommandSet.repeatCount`（Rust `SendCommandSetEntry.repeat_count`，`#[serde(default)]` 兼容旧配置）；从 `useOperationStore` 删除 `loopRepeatCount`；`useCyclicSend` 改读 `currentSet.repeatCount`；编辑入口在 CommandSettings 命令集头部（与"循环"开关、轮间间隔同行） |
| MEDIUM | `operation-panel.css` | 操作面板拖矮时发送区按键叠到上方快捷发送区：`.op-send-row` 是分区 flex 列的子项且 `min-height:0`，面板变矮时被压塌成 0 高，其内发送键/文件键/HEX 选项保持自身尺寸溢出叠压 | 新增 `.op-section > * { flex-shrink: 0 }`：分区子元素保持自然高度，超出由分区自身滚动，杜绝叠压 |
| LOW | `SendSection.tsx` / `OperationPanel.tsx` / `RulesSection.tsx`(删除) / `operation-panel.css` / `i18n.ts` | ① 命令集选择与快捷发送被拆在两个分区，不符合直觉；② 上一版把命令集选择 + 循环做成两条整宽行，喧宾夺主；③ 高亮规则下拉实为死控件（高亮引擎按各集 `isEnabled` 过滤，从不读 `activeHighlightSetId`） | 命令集选择 + 循环开关 + 编辑按钮收进发送区**标题同一行**的紧凑头部（`.op-send-header`：标题左、控件右），循环开关为图标按钮、运行时错误色呼吸脉动，不再各占整行；删除独立 `RulesSection`；高亮规则管理保留在设置弹窗 HighlightSettings（按集启用）；移除失效 i18n key 与 `.op-section-rules`/`.op-rule-row`/`.op-loop-row` 等死样式 |

## 已修复 (2026-08-01 命令集激活缺陷)

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `useRuleStore.ts` | 配置了发送命令集后操作面板快捷区/循环发送无反应：`activeSendCommandSetId` 是会话态（每次启动归零），而 `setSendCommandSets`（启动加载 / 设置页加载）与 `addSendCommandSet`（新建集）都从不设置它，用户必须手动在 RulesSection 下拉里选中才生效 | 两个 action 建立不变量「有命令集时 `activeSendCommandSetId` 必指向有效集」：`setSendCommandSets` 保留仍有效的激活集、否则回退首个；`addSendCommandSet` 无激活时激活新集。与既有 `removeSendCommandSet` 回退逻辑对称。补 6 个单测 |

## 已修复 (2026-08-01 三处 Bug 修复)

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `lib.rs` | 托盘右键菜单瞬间消失：`on_tray_icon_event` 匹配所有 `TrayIconEvent::Click`（含右键），Windows 右键同时弹出原生菜单并触发 Click 事件，`set_focus()` 抢走焦点导致菜单关闭 | 模式匹配限定 `button: MouseButton::Left`，仅左键触发显示窗口 |
| HIGH | `TerminalView.tsx` | 高速输出时滚动锁定抖动后失效：`scrollToIndex` 触发的 scroll 事件中 virtualizer 布局滞后，`atBottom` 误判为 false 并永久关闭 autoScroll | 新增 `isAutoScrollingRef` 守卫（scrollToIndex 前置位、80ms 后清除），`handleScroll` 跳过程序化滚动；atBottom 容差从 2px 增至 30px；wheel 事件清除守卫以保留用户意图 |
| HIGH | `ParamsSection.tsx` | 参数预设下拉永远为空：预设仅在 ConfigModal→GeneralSettings 中管理，ParamsSection 挂载后不再刷新，用户无法发现/创建预设 | 下拉旁新增保存（💾 自动生成 "9600-8N1" 式名称）和删除（🗑）按钮，操作后立即刷新列表；新增 4 条 i18n key |

## 已修复 (2026-07-25 UI/UX 大修)

> UI/UX 大修轮。验证: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告, `npm run test:run` 179/179 (11 files), `cargo test --lib` 33/33。

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `DisconnectBanner.tsx` / `useTauri.ts` | 会话恢复的标签启动即触发"端口已断开"横幅误报 | `useTauri.ts` 模块级 `lostPortIds: Set<string>` 仅记录本次会话 connected→disconnected 的端口 + `isPortLost`；横幅改由新纯函数 `filterLostTabIds(tabs, isLost)` 驱动 (单测 5 cases) |
| HIGH | `OperationPanel.tsx` / `useOperationStore.ts` | `scrollLocked` / `showTimestamp` / `displayFormat` / `encoding` / `loopInterval` 5 字段全局态每次切标签覆盖 per-tab 终端状态（编码选择"不生效"根因） | 4 字段移出 opStore，显示控制下沉 `TerminalFilterBar` 直写 `useTerminalStore` |
| MEDIUM | `useTerminalStore.ts` | 切换编码只影响新数据，存量行不重解码，用户感知无效 | `setTerminalEncoding` 更新 encoding + 从 `rawData` 重解码全部存量行 |
| MEDIUM | `useHotkeys.ts` | 全局 Ctrl+Enter 发送与"Ctrl+Enter 永远换行"的交互决策冲突 | 移除全局热键及帮助弹窗对应行 |
| LOW | `RulesSection.tsx` / `useCyclicSend.ts` | `loopInterval` 与命令集 per-command delay 双数据源语义重叠 | 移除间隔字段，时机由命令集延时唯一决定（同时消除窄窗口下间隔控件被裁切） |
| LOW | `SendSection.tsx` | HEX/字符串切换无内容转换、HEX 模式不限制输入 | `sendUtils.ts` 新增 `textToHexPreview` / `hexToTextPreview` / `sanitizeHexInput` 提供双向转换 + 输入过滤 |

## 已修复 (2026-07 缺陷审计 + 架构迭代)

> Bug 修复（30+ 项）+ 4 阶段架构迭代。验证: `npx tsc --noEmit` 0 错误, `cargo check` 0 错误 0 警告。

### 日志 & 配置契约

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `logger/mod.rs` | `close_writer` 仅 flush 不 `sync_all`，断电丢数据 | 关闭前调用 `sync_all()` 确保 OS 层落盘 |
| HIGH | `logger/mod.rs` | 分片开关缺失，始终按大小切片 | 新增 `split_enabled` 字段 + 守卫生成切片 |
| HIGH | `commands/log.rs` | `save_log_as` 作用域限制过严（`canonicalize().starts_with`），用户 save 对话框选择的路径被拒 | 移除子树限制，仅保留父目录 canonicalize 校验 |
| HIGH | `commands/log.rs` | `export_terminal_log` 同上作用域限制问题 | 同上移除限制 |
| HIGH | `services/tauri.ts` | 缺少 `setLogFilenameFormat`、`setLogSplitSize`、`setLogSplitEnabled` 包装 | 新增三个 service wrapper |
| MEDIUM | `hooks/useTauri.ts` | `syncLogSettingsToBackend` 只同步部分日志设置 | 同步全部 6 项日志设置（directory/filenameFormat/splitSize/splitEnabled/autoSave/encoding） |
| MEDIUM | `logger/mod.rs` | `LogFileInfo` 字段名 snake_case 与前端 camelCase 不匹配 | 增加 `#[serde(rename_all = "camelCase")]` |
| LOW | `services/tauri.ts` | `onSystemStatus` 事件监听废弃代码残留 | 移除死代码 |

### 配置 & Store 架构

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `config/mod.rs` | 配置无版本号，加字段只能靠 `Option` 兜底 | 新增 `config_version: u32` + `migrate()` 迁移框架 |
| HIGH | `config/mod.rs` | 配置文件路径硬编码，无法自定义 | `ConfigManager::new(Option<PathBuf>)` 三级解析（CLI > env > portable > 默认） |
| HIGH | `config/mod.rs` | `set_config` 不校验字段边界，任意值透传 | 新增 `validate_and_clamp()` 在写入时校验裁剪 |
| HIGH | `config/mod.rs` | 会话快照通过全量 `set_config` 更新，竞态覆盖其余字段 | 新增 `update_session_snapshot()` 单字段方法 |
| HIGH | `useOperationStore.ts` | `sendOnEnter` / `quickSendSlots` 存在于两个 store（opStore + appStore.config），源不唯一 | 从 opStore 移除，仅在 `useAppStore.config` 中保留 |
| HIGH | `sessionSnapshot.ts` | `configSaveInProgress` 标志 + 超时轮询，逻辑复杂且仍有竞态窗口 | 改用 `configService.updateSessionSnapshot()` 专用命令，移除全部锁逻辑 |
| MEDIUM | `config/mod.rs` | 配置损坏时整个应用启动失败 | `save()` 写前生成 `.bak`；`new()` 读取失败时回退到 `.bak` |
| MEDIUM | `config/mod.rs` | 空 `log_directory` 不解析为默认路径，前端拿到空串 | 在 `migrate()` 中将空值解析为 `dirs::data_dir()/hypercom/logs` |
| MEDIUM | `config/mod.rs` | `auto_save_log` 默认 `false` 违背用户预期 | 改为 `true` |
| MEDIUM | `config/mod.rs` | `log_split_enabled` 默认 `false` 违背用户预期 | 改为 `true` |
| LOW | `hooks/useTauri.ts` | `resetAndReload` 漏同步 opStore | 补充 opStore 同步 |
| LOW | `hooks/useTauri.ts` | `useAppInit` 残留 sendOnEnter/quickSendSlots 同步代码 | 移除，同步逻辑已无意义 |

### 后端存储 & 数据

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| HIGH | `storage/mod.rs` | 未开启 WAL 和 FK，并发写可能锁库 + FK 约束不生效 | 新增 `PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON` |
| HIGH | `storage/mod.rs` | `save_command_set_to_db` / `save_highlight_set_to_db` 非事务，子行残留 | 改为事务包裹（DELETE old + INSERT new 原子化） |
| MEDIUM | `storage/mod.rs` | `save_port_preset_to_db` 覆盖时丢失 `created_at` | 使用 `ON CONFLICT` 保留 `created_at` |
| MEDIUM | `storage/mod.rs` | `port_groups` + `port_group_members` 表废弃但仍在 schema 中 | 删除两张表 + `PortGroupRow` 结构体 + 相关死代码 |
| LOW | `storage/mod.rs` | `set_baud_rate` 函数从未被调用 | 移除死代码 |

### 前端 UI & 类型

| 严重度 | 文件 | 问题 | 修复 |
|--------|------|------|------|
| MEDIUM | `types/index.ts` | `SystemStatus.memoryUsedMB` 大小写与 serde camelCase 输出不匹配 | 改为 `memoryUsedMb` |
| MEDIUM | `StatusBar.tsx` / `ViewStrip.tsx` | 同上字段名不对齐 | 全面对齐 camelCase |
| MEDIUM | `hooks/useTauri.ts` | `useSystemStatus` 字段名与后端 snake/camelCase 不一致 | 对齐至 camelCase |
| MEDIUM | `hooks/useTauri.ts` | `mapProtocolTemplateInfo` 未转换可选字段 | 增加 `Boolean()` 转换确保布尔类型 |
| MEDIUM | ConfigModal 页面 | 四个设置页订阅整 config，无关字段变更触发重渲染 | 改为逐字段选择器 |
| LOW | `stores/useAppStore.ts` | `defaultConfig.backgroundImage: ''` 空串被 CSS 当路径处理 | 改为 `undefined` |
| LOW | `system_cmds.rs` | `SystemStatus` 字段名与前端 camelCase 不一致 | 增加 `#[serde(rename_all = "camelCase")]` |
| LOW | CSS | AboutDialog / HotkeyHelpDialog / AliasDialog 弹窗样式未复用 | 新增 `.modal-dialog-compact` 公共类 |
| LOW | `commands/serial.rs` | `send_file` 不记录 TX 元数据日志 | 新增 TX metadata 日志记录 |
| LOW | `commands/file.rs` | 配置导入不校验路径，可读取任意位置 | 新增 `validate_config_path()` 限制在配置目录 |

### 架构改进补充

- `lib.rs` 新增 CLI `--config` 参数解析
- `commands/config.rs` 新增 `update_session_snapshot`、`get_config_path` 命令；`save_config` 改名为 `set_config`
- `GeneralSettings.tsx` 通过 `getConfigPath()` 显示配置文件路径
- `i18n.ts` 新增 `general.configPath` key
- `SendSection.tsx` 从 `useAppStore(s => s.config.sendOnEnter)` 读取

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
