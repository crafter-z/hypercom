# 配置与状态模块

config.json 实体模型与向前兼容口径、会话快照、6 个 Zustand store 划分、规则实体 CRUD、安全快照持久化、分组/端口元数据、前后端数值边界契约。

## config.json（单一事实来源，2026-08 迁移）

SQLite 层已整体移除——**config.json 是应用设置（标量 + 实体）的持久化事实来源**。会话快照独立保存在 `session.json`，插件私有 KV 独立保存在 `plugins/<id>/data/state.json`，二者不属于配置导出 bundle。

`AppConfig` 共 **47 个字段 = 46 个普通配置字段 + `#[serde(flatten)] entities: Entities`**（整体 `#[serde(rename_all = "camelCase")]`）。`Entities` 是 **9 个 `Vec` 实体数组**；`#[serde(flatten)]` 使这些实体作为 config.json 的**顶层 key**，而非嵌套在 `entities` 对象中。普通字段包含数值、字符串、布尔值和预设波特率数组。

| 实体 | `Entities` 字段 | config.json 顶层 key | 前端对应 |
|---|---|---|---|
| SendCommandSetEntry | `send_command_sets` | `sendCommandSets` | 命令集（快捷发送/循环） |
| HighlightRuleSetEntry | `highlight_rule_sets` | `highlightRuleSets` | 高亮规则集 |
| ProtocolTemplateEntry | `protocol_templates` | `protocolTemplates` | 协议解析模板 |
| TriggerRuleEntry | `trigger_rules` | `triggerRules` | 触发规则 |
| PortPresetEntry | `port_presets` | `portPresets` | 串口参数预设 |
| PortToolConfigEntry | `port_tool_configs` | `portToolConfigs` | 外部工具配置 |
| PortGroupEntry | `port_groups` | `portGroups` | 串口分组（issue #2-3，整体替换） |
| PortMetaEntry | `port_meta` | `portMeta` | 端口元数据：备注名/隐藏/mode；当前枚举端口的编辑覆盖其条目，未插入设备的条目保留 |
| PluginConfigEntry | `plugin_configs` | `pluginConfigs` | 插件安装身份 `installGeneration` / 启用态 / 授权（插件私有 KV 独立存放） |

46 个普通配置字段与实体数组同层。默认值和范围收敛位于 `config/mod.rs`；规则实体 CRUD 位于 `commands/storage.rs`，插件安装、启停和授权另由 `commands/plugin.rs` 管理，不能按普通规则实体写入插件状态。

### 向前兼容与 schema：没有版本字段

**没有 `configVersion` 字段，也没有版本分派**。兼容旧配置分三类处理：

1. **缺字段**：`AppConfig` / `Entities` 的容器级 `#[serde(default)]` 和实体字段缺省提供默认值，不需要配置版本号。
2. **废弃字段**：解析前由 `strip_legacy_memory_budget_keys` 物理剥离旧内存预算 key；非法 JSON 走 `.bak` 恢复。
3. **插件安装身份**：`ConfigManager::new` 在磁盘事务恢复后，为缺失的 `installGeneration` 分配 UUID，保存配置并同步安全 `.bak`；这项一次性身份迁移会推进 revision，与缺字段取默认值不是同一种处理。

### 生命周期

- 首启 `ConfigManager::new` 构造默认 `AppConfig`（空实体数组）；无数据库。
- **配置文件路径解析顺序**（`ConfigManager::new`）：CLI `--config <path>` → `HYPERCOM_CONFIG` 环境变量 → 便携模式（可执行文件同目录下**已存在**的 `config.json`）→ 默认 `%APPDATA%/hypercom/config.json`（`dirs::config_dir`）。会话快照路径恒为配置文件同目录的 `session.json`。
- 实例锁：`lib.rs` 的 `acquire_instance_lock` 在配置旁打开 `config.lock`；Windows 用不共享的文件句柄，Unix 用非阻塞 `flock`，句柄随进程退出释放。遗留锁文件本身不会阻止重启，不应靠删除锁文件绕过活跃实例。只有 Windows sharing violation / Unix 锁竞争才报告另一个实例；打开锁文件的权限或其他 I/O 错误会显示锁文件路径及系统错误，需检查文件/目录写权限和启动进程的限制，而不是认定已有实例。
- 读取：先 `strip_legacy_memory_budget_keys`，再反序列化。失败则 `log::warn` 并回退 `.json.bak`（同样先剥离旧 key）；`.bak` 也不可用才用默认值——corrupt JSON 自动恢复。
- 在插件 Worker 启动前恢复 `plugin-transaction.json` 所属磁盘事务；旧插件条目缺少 `installGeneration` 时分配 UUID、保存并同步安全 `.bak`。这是安装身份迁移，不是配置版本分派。
- `save()`：计算下一 revision → 序列化并同步临时文件 → 单操作替换配置文件 → 同步父目录；失败不保留推进的内存 revision。普通备份只复制加载时已确认有效的主档；从 `.bak` 恢复期间不以坏主档覆盖有效备份，成功替换后主档才标为有效。插件清权/身份迁移/事务恢复仍独立调用 `save_safe_backup`。
- `set_config()` 与规则 CRUD 都在写入失败时恢复完整旧 `AppConfig`（包括实体与 revision），失败修改不会夹带进下一次无关保存。

### Windows 开发启动：低完整性构建目录

若工作区带有可继承的 `Low Mandatory Level` 标签，其下生成的可执行文件也会继承低完整性标签。即使从开始菜单打开普通 Terminal，运行这些产物时进程仍可能降至低完整性，无法写入普通完整性的 `%APPDATA%/hypercom`；表现为诊断日志及实例锁同时报 `os error 5`。用户的 DACL FullControl 不会绕过完整性级别限制，单独查看 `TokenHasRestrictions` 也不能区分普通 UAC 过滤与此问题。

先用 `icacls` 检查工作区、构建输出目录与可执行文件的完整性标签。确认这一原因后，可在普通 Terminal 中将 Cargo 产物放到工作区之外的正常完整性目录；不需要修改 AppData 权限、删除配置或移除工作区的沙箱权限项。例如 PowerShell（环境变量只在当前终端及其子进程有效）：

```powershell
$env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'HyperComBuild\target'
npm.cmd run tauri dev
```

若需要保持原来的 `npm run tauri dev` 命令，可在项目根目录的 `.cargo/config.toml` 中设置 `[build]` 的 `target-dir` 为上述外部目录的**绝对路径**（TOML 不展开 `%LOCALAPPDATA%`）。这种含本机路径的配置应加入 `.git/info/exclude`，不提交到仓库；Cargo 从 `src-tauri` 启动时也会向上发现此配置。已有 `CARGO_TARGET_DIR` 环境变量会优先于该设置。

切换目录后首次启动会重新编译。应使用新目录的产物，不能复制回低完整性目录再运行。

### 数值边界：`CONFIG_BOUNDS` 是唯一来源

- **Rust**：`pub const CONFIG_BOUNDS: &[(&str, i64, i64)]`（`src-tauri/src/config/mod.rs`）是数值范围的唯一来源。`validate_and_clamp` 经 `clamp_bound(name, value)` 查表收敛，**调用点不写 clamp 字面量**；名字缺失直接 panic（静默不收敛正是「非法值落盘」的来源）。其中 `uiScalePercent` 的边界为 **80–200**。
- **前端**：镜像表在 `src/utils/bounds.ts`（导出 `CONFIG_BOUNDS` 与 `BoundedNumericSetting` 类型）。
- **跨语言契约测试**：`src/utils/bounds.test.ts` 用 `?raw` 导入 Rust 源文本、正则逐项解析 `CONFIG_BOUNDS`，断言**两侧键集合相同且每个键的 min/max 相等**——任一侧改了未同步另一侧立即红（曾出现前端允许 8..96 而后端收敛到 8..48，用户输入被静默丢弃；备份间隔 1..8760 vs 1..720 同款）。
- **枚举字段**走 `restrict(field, &[...], fallback)`：`closeBehavior` / `theme` / `language` / `logFormat` / `timestampMode` / `timestampFormat` / `logEncoding` / `logSubdirMode`（非法值回 `date`）/ `updateCheckMode`（非法值含旧版残留回 `stable`）/ `defaultLineEnding`，以及 `entities.port_meta[*].mode`（非 `trx`/`tty` 收敛回 `trx`，issue #11）。
- 默认行尾设置复用 `sendUtils.LINE_ENDING_VALUES` 与 `lineEndingLabelKey`，保存的是反斜杠域值（`'\\r\\n'` / `'\\r'` / `'\\n'` / `'None'`），不是实际换行控制字符。

### 会话快照

- `update_session_snapshot` / `get_session_snapshot` 读写**独立**的 `session.json`（格式 `{"snapshot": "..."}`），与 config.json 分开——高频快照写入**不触发** config 的 `.bak` churn。
- `ui.configReady`（`useSystemStore`，`loadConfig` 完成后置位；加载失败保留默认值也置位）供主窗/弹出窗按加载后的配置应用 WebView 缩放，也供自动更新等待配置就绪，替代旧的固定超时启发式（config 加载超过阈值会按默认 stable 误判用户设置的 none/preview）。它**不进**会话快照。

### 前端 WebView 缩放

- `uiScalePercent`（Rust `AppConfig.ui_scale_percent`）是持久化的 UI 缩放百分比，默认 **100%**，由 `CONFIG_BOUNDS` 约束为 **80–200%**；它使用原生 WebView 缩放，不是 CSS transform，也不等同于 `terminalFontSize` / `uiFontSize`（后两者仍是字体设置）。
- `src/utils/uiScale.ts` 的 `applyUiScale` 调用 Tauri `getCurrentWebview().setZoom(percent / 100)`；缩放按 WebView 实例分别应用。主窗在 `configReady` 后应用已加载值，弹出窗（Popout）启动时读同一 config.json 后应用；独立窗口互不共享运行态。
- `ConfigModal` 只有在 `saveConfig()` 成功、且保存后没有残留草稿后才调用 `applyUiScale(current.uiScalePercent)` 并通过 `ui-scale:changed` 通知已打开的弹出窗；取消、保存失败或保存期间又产生新编辑都不会把未落盘的缩放应用到 WebView。

## 命令

- `commands/config.rs`（**5 个**）：`get_config` / `set_config` / `update_session_snapshot` / `get_session_snapshot` / `get_config_path`。「恢复默认」**没有**后端命令：内存态由 `useAppStore.resetConfig()` 重置（当前无 UI 调用点），落盘仍走同一条安全快照 `saveConfig`——多一条后端命令只会多一个写路径。
- `commands/storage.rs`（**20 个**）：6 类带 `id` 实体 × save/load/delete = 18，加整体替换的 `save_port_groups` / `save_port_meta`。这 20 个命令共享 `read_config` / `save_entity` / `delete_entity` 三个助手 + `entity_accessors!` / `impl_entity_id!` 宏生成的访问器（不再是 20 份手抄的「加锁 → 找同 id → 替换/追加 → save」）。命令名 / 参数名 / 返回类型保持不变——前端 `storageService` 编译期依赖它们。
- CRUD 语义：`save_entity` 按 id upsert，**空 id = 新建**（后端生成 UUID），返回最终 id；`delete_entity` 按 id 删除，**不存在的 id 是无操作**（不报错、不动其它条目、不打乱剩余顺序）；`save_port_groups` / `save_port_meta` 是**整组替换**，且**没有**对应 load 命令——读走 `get_config`（`port_groups` / `port_meta` 随 `AppConfig` 一并返回）。
- **注册漂移守卫**：`config/mod.rs` 的 `test_generate_handler_matches_tauri_command_attribute` 对比 `lib.rs` 注册与命令定义。当前 **89** 个命令、**13** 个命令域文件（完整清单与每域职责见 [`src-tauri/src/commands/AGENTS.md`](../../src-tauri/src/commands/AGENTS.md)）；系统域 `complete_editor_close` 在主窗确认编辑处理后执行隐藏/退出。

## 时间工作区会话描述

`sessionSnapshot` 保存三类标签、Pane 布局、时间组描述（成员标签引用、源映射、参考来源与拖动策略）和回放来源/解析选项。组运行态只有 `timelineCoordinator` 一份权威来源，不新增 Zustand store 或 AppConfig 高频字段；保存时读取轻量描述，不保存每帧 preview、owner、实例/document、原始授权、ACK 队列或完整日志模型。

恢复重新校验并重建槽位引用，默认 BROWSE/暂停，不连接串口、不播放。回放来源以占位描述恢复，重新原生选取并验证文件指纹后才载入；插件仍需核对安装代次/能力。缺失来源不绑定到同名其他来源。旧快照缺少时间组字段按空处理。详见[时间联动与只读回放](timeline.md)。

## 6 个 Zustand Store

| Store | 职责 | 纪律 |
|---|---|---|
| `useAppStore` | tabs / ports / `paneTree` / config / groups | 五类规则数组是最后确认的持久化基线，普通设置是草稿；插件镜像由后端 revision 排序刷新，树算法在 `utils/paneTree.ts` |
| `useSystemStore` | `systemStatus` / `trafficStats` / `simulationMode` / `ui.*`（含 `configReady`）+ `clearTrafficStats` | 高频写点集中地（5s 系统轮询 / 每端口 1s 流量 flush / 拖拽 resize），故必须与 `useAppStore` 分开 |
| `useOperationStore` | serial params + send（**无 `op` 前缀**、无显示态字段）+ `cyclicLoops: Record<portId, boolean>` | 显示态不在此 |
| `useTerminalStore` | 纯显示态（scrollLocked/showTimestamp/displayFormat/encoding/connectedAt） | 行缓冲在 viewportManager 环形缓冲区；无行数组、无 Immer、不随数据更新 |
| `useRuleStore` | highlightRuleSets / sendCommandSets / protocolTemplates / triggerRules / portToolConfigs + CRUD | **已提交运行态**；编辑草稿由 `utils/entityEditor.ts` 管理，不新增 Zustand store |
| `useToastStore` | 通知队列（toasts / stashed） | 宿主走 `push` 保留通知；插件走 `pushPlugin`，身份由宿主赋值并应用速率/文本/积压限额，见[通知模块](workspace.md#通知中心--toast) |

`useSystemStore` 由 `useAppStore` **拆出**（`systemStatus` / `trafficStats` / `simulationMode` / `ui`）：这些字段与端口/标签页的订阅者无关，混在一起会让每次流量 flush 都唤醒 Pane / OperationPanel / Sidebar 重跑选择器。另有 `releaseTerminalState.ts`（统一回收某端口的 terminals / trafficStats / TX 历史）与 `resetStores.ts`（测试用整份复位）。

**选择器纪律（Critical）**：调用 store 不带 selector 订阅整 store——每个串口数据事件都会重渲染该组件（输入失焦/卡顿）。hook 内写不订阅用 `getState()`。

## 配置持久化：安全快照（issue #5-2）

后端 `set_config` 是**整体替换**。`useAppStore.config` 的五类实体数组是最后确认的持久化基线，`useRuleStore` 是已保存运行态，`utils/entityEditor.ts` 单独拥有会话草稿；普通设置、分组、端口和预设仍各有原来的权威来源。

`useConfigPersistence.saveConfig(patch?)` 从五类草稿和普通设置构造安全快照，与最新后端 revision、实体基线协调后 CAS。未修改实体采用后端版本；同一实体两边均被修改时保留草稿并报告冲突，不静默选赢家。`utils/jsonEqual.ts` 忽略 JSON 对象属性顺序，避免 Rust 序列化顺序造成假脏状态或假冲突。

- `portPresets` **没有** store 镜像（唯一写路径是 `storageService.savePortPresets`），保存前 `loadPortPresets()` 读回；读不到就不写——宁可不保存，也不能用陈旧快照覆盖磁盘。
- `collectPortMeta(ports)` 仅投影本次枚举到的端口；`mergePortMeta(ports, persisted.portMeta)` 用实时端口条目覆盖当前端口、保留后端已有的离线端口备注/隐藏/TTY 模式；当前端口显式清空全部元数据时移除其条目，不会被旧配置复活。`saveConfig` 与 `useAppInit` 自动保存共用该投影口径；自动保存读取最新后端配置并以 revision CAS 重试，且与本窗全量保存串行化，防延迟提交覆盖较新的编辑。元数据保存最多尝试 5 次 CAS，失败由 `useAppInit` 记日志并延迟重试（不弹 toast）。
- 已接线处：`ConfigModal.handleSave`、`DiagnosticLogDialog` 的诊断开关（改 store 后 `saveConfig()`）、`UpdateDialog` 的「不再提醒」（`saveConfig({ updateCheckMode: 'none' }, true)` 只 CAS 该普通字段，不提交任何草稿）。**新增全量保存点照抄此模式**——调 `saveConfig`，不要自己拼实体数组。
- **会话草稿模型**（`utils/entityEditor.ts`）：五类实体各一份模块级状态（`baseline` / `draft` / `version` / `committed` / `conflicts` / `orderDirty`），由 `useSyncExternalStore` 暴露快照；草稿跨切页、关闭设置和组件卸载存活，保存成功与显式放弃分别推进/回退它，外部配置变化只会按下面的合并规则进入。`useAppStore.config` 与 `useRuleStore` 的外部变化经 store 订阅合并进草稿：本地未改的记录采用远端版本、远端新增追加、远端删除消失、本地新增保留；同一 id 两边都改则记入 `conflicts`（`editor.conflict`），在放弃该记录前保存继续报冲突、集合保存整体不放行。`version` 随每次草稿变更递增，跨窗命令草稿用它做乐观并发校验。
- **保存作用域**：单条保存（`saveEntityDraft(kind, id)`）只把该实体合入最新后端快照，不影响同一集合里的其他改动、删除和顺序；集合保存（不带 id）提交整个数组与顺序；设置底部保存（`useConfigPersistence.saveConfig`）一次覆盖五类实体与普通设置（另按各自权威来源附带分组、端口元数据和预设）。三者都经 `configWriteQueue` 串行 + revision CAS，提交前重新读取后端快照；全量保存最多重试 5 轮、单实体保存单次 CAS 失败即报冲突；失败都保留草稿（全量保存另 `notifyError`）。保存成功才推进基线、`useRuleStore` 运行态和 `useAppStore.config`，保存期间产生的新编辑按 `expectedVersion` 保留为未保存（`commitEntityEditorDraft` 重组草稿），不会被这次成功抹掉。同一个 kind 已有在飞保存时再次保存复用同一 promise。
- **提交前校验与放弃**：集合内 id 必须唯一、`id` 与 `name` 必须非空、正则必须可编译且长度 ≤ 200、HEX 字段必须是完整偶数半字节、协议偏移必须是非负整数；不合法只标错误，不写盘也不清草稿。放弃按作用域生效：单条放弃只把该行恢复为基线内容（新插入的行则移除）并清该 id 的冲突；集合放弃整体回到基线。重排在 id 集合不一致（重复、缺失）时静默忽略、不丢行。
- 五类实体页统一使用 `useEntityPage({kind})`：挂载只读现有草稿、不重新加载覆盖；展开/选中项按 kind 记忆，切页或卸载后回来保持。新增默认追加末尾，「在上方插入 / 在下方插入」按相邻 id 插入并展开、聚焦新行名称。`shared/SortableEditorList` 只暴露专用手柄：指针需 6px 位移才激活，键盘 Space 拾起、方向键移动、Space 放下；保存中拖拽、增删和行内按钮禁用。命令集保存时按数组位置回写连续 `order`，快捷发送条、命令设置页、循环启动与命令面板共用 `utils/commandOrder.ts`，不再手写 order 排序。协议/工具管理列表的数组顺序只是管理顺序，不增加执行优先级。
- **离开审批**（`utils/editorLeave.ts` + `shared/EditorLeaveDialog.tsx`）：参与者注册 `isDirty` / `save` / `discard` / `label`（设置普通草稿、五类实体草稿、主窗侧的命令面板未同步内容、独立窗口各自的草稿），决策只有保存并关闭 / 放弃并关闭 / 继续编辑。保存或放弃后再次复查脏状态：保存失败、或保存期间又产生编辑都不放行关闭，对话框保留并显示错误供重试；Escape 等价于继续编辑。对话框与设置/更新弹窗一样等原生插件视图让位后才显示（`usePluginViewOverlay`，见[插件视图](plugin-views.md)）。设置取消 / X / 遮罩 / Escape 只请求设置侧参与者（不处理独立命令面板的未同步内容），应用退出请求全部参与者；审批未决时收到范围更大的新请求（如设置关闭未决时托盘退出）会合并参与者复用同一决策，不叠加第二个对话框。
- **原生关闭路径**：主窗 Rust `request_editor_close` 先 show/unminimize/focus 主窗再发 `editor:close-requested`（camelCase 载荷 `{requestId, forceExit}`）；主窗 CloseRequested、托盘 Quit 与 `RunEvent::ExitRequested` 都先 `prevent_close` / `prevent_exit`，等前端审批。审批通过后前端调 `complete_editor_close`：非强制关闭且 `closeBehavior = minimize` 时只隐藏窗口，托盘 Quit / ExitRequested（`force_exit`）直接走 `request_shutdown`；该命令只接受主窗及匹配的在飞 `requestId`，其他窗口/伪造或过期 token 返回错误；`cancel_editor_close` 撤销同一 token。主窗每 3 秒以 `acknowledge_editor_close` 续报审批存活，React 关闭监听卸载立即停心跳。15 秒无心跳由独立原生确认提供退出不保存/继续编辑选择，迟到原生回调不能作用新 token。批准真正退出后先禁用并隐藏全部托管窗口，再执行有界收尾。独立窗口在 `PopoutShell` 里 `onCloseRequested` → `preventDefault` → 审批通过才 `destroy`；审批进行中重复的关闭请求不叠加。
- **保存完成后的边界**：设置底部保存成功后才关闭弹窗并应用 UI 缩放；保存期间正文 `inert`、点击/输入被拦截且关闭按钮禁用；若弹窗已被外部关闭/重开，或保存后又出现新草稿，迟到的结果既不关闭弹窗也不应用未落盘缩放。
- 备份导入在确认替换后走 `requestEditorLeave()`，导入成功后立即 reload（草稿随新基线丢弃）；更新安装在下载前走 `requestEditorLeave()`。
- 插件不是五类规则页的实体：启停与权限动作立即独立持久化，取消设置仅回滚普通草稿，保留当前插件状态及 revision。备份导入只覆盖同安装身份的授权；导入中同 ID 不同身份清权禁用、未提及的当前插件保留，且不安装代码或迁移 KV。
- **备份管理页只提供配置导出/导入**：此前未实现消费者的自动日志备份开关及 `backupEnabled` / `backupInterval` / `backupDirectory` 已从模型、数值边界和 UI 移除，不再展示无效功能；旧配置中的这些未知字段由 serde 忽略。自动日志备份仍不是已交付能力，日志备份应手动复制日志目录（见[日志](logging.md)）。

## 草稿恢复与不可避免的退出

`entityEditorRecovery` 以 schema envelope 记录五类实体的 baseline/draft、普通设置 baseline/draft 和面板未 ACK 文本；读取严格检查键白名单、形状和 schema，损坏/旧版/未知字段或 Storage 不可用时 fail-safe。恢复按新磁盘基线三方合并为会话草稿，冲突可见，不自动保存或发布实体 runtime，也不恢复 pluginConfigs、权限、分组、元数据、预设或 revision。普通字段保留既有主题/字体/电源预览语义，committed update mode 只取磁盘值。成功保存/显式放弃清对应记录；晚编辑、失败保持待恢复。面板恢复文本必须明确 overwrite 或 reload，不自动覆盖主窗。

Windows 的不可避免 `RunEvent::Exit`（含 tao `WM_ENDSESSION` 路径）不能可靠等 JS 审批；此处用后台收尾和单一 3 秒总等待预算尽力处理 serial/log/power/diag，不等待已销毁 UI 线程。恢复记录是在编辑时写入而非等关机通知；localStorage 是 best-effort，不保证强断电零丢失。真正关机/注销、renderer 卡死后的独立原生确认仍列入实机验收，源码/单元测试不能代替。

## 配置读取/保存数据流

```
应用启动 → useAppInit → useConfigPersistence.loadConfig → invoke get_config
  → ConfigManager.get_config() → 剥离旧 key + 反序列化 → useAppStore.setConfig(config)
    → useRuleStore 灌入 5 组已保存运行实体（setGroups 须在分组自动保存订阅注册之前执行）
    → useSystemStore.setUIState({ configReady: true })
    → 主窗（或弹出窗）`applyUiScale(config.uiScalePercent)`，缩放当前 WebView

用户保存 → ConfigModal.handleSave → saveConfig()（内部构造安全快照）
  → invoke set_config → ConfigManager.set_config()（validate_and_clamp → 原子写 + .bak）
    → AppState::apply_runtime_config(cfg)（日志设置 + 诊断开关 → 后端运行期镜像）
  → 保存成功后当前 WebView `applyUiScale(current.uiScalePercent)`，并广播 `ui-scale:changed` 给已打开的弹出窗；失败则不应用未落盘值

分组变更 → `useAppInit` 500ms 防抖 → `saveCurrentPortGroups`（共享写队列 + 最新配置 + revision CAS）；端口元数据变更 → 500ms 防抖 → `saveCurrentPortMeta`（取最新配置 + 保留离线端口元数据 + revision CAS 保存）。
```

## 规则实体激活语义

- `useRuleStore.setSendCommandSets` / `addSendCommandSet` 建立不变量「有命令集时 `activeSendCommandSetId` 必指向有效集」：保留仍有效的激活集、否则回退首个；`removeSendCommandSet` 对称回退（曾因启动加载/新建集从不设置激活集，导致配置了命令集但操作面板快捷区/循环发送无反应）。
- 高亮引擎按各集 `isEnabled` 过滤（不读激活集 id——操作面板的规则分区已移除，该字段随之删除）。
- 命令面板通过 `popout:command-editor-request` 提交 sessionId/version 标识的草稿操作；请求方先注册结果监听再发送，只认匹配 requestId 的 ACK，15s（`COMMAND_EDITOR_TIMEOUT_MS`）无 ACK 按 `editor.saveFailed` 处理并退休迟到监听（协议细节见[工作区](workspace.md)）。宿主重载换会话，面板接纳新会话并拒绝退役会话迟到响应；未确认输入遇冲突仍保留。`command-sets:changed` 只广播已提交运行态，保存 ACK 后才清除未保存状态。运行中的命令循环固定启动快照。

## AppState 运行期状态（配置的镜像）

`lib.rs::AppState` 持有全部运行期句柄：

| 字段 | 类型 | 说明 |
|---|---|---|
| `serial_manager` | `Arc<Mutex<SerialManager>>` | 异步命令经 `spawn_blocking` 时需从 State 克隆出 `'static` 句柄 |
| `config_manager` | `Mutex<ConfigManager>` | 配置读写（含全部实体） |
| `plugin_io` | `tokio::sync::Mutex<()>` | 插件磁盘/授权一致性串行闸门：安装、卸载、重载、启停、权限与网页信任变更、网页数据清理、一致列表扫描、资产读写、原生视图创建以及 `set_config`（含备份导入的整份替换）都 `lock().await` 排队；**等待没有固定期限**（旧 `lock_asset_io` 的 2 秒超时已移除），获得闸门后才读 manifest 与当前授权再访问磁盘 |
| `log_manager` | **`Arc<LogManager>`（无外层 `Mutex`）** | 写路径是 `&self` + 内部细粒度锁；再套一层 Mutex 会让 `save_log_as` 的文件拷贝、`list_files` 的递归遍历与数据写入争同一把锁（高波特率下 RX 写入被拖住） |
| `diag_logger` | `Arc<DiagLogger>` | 应用自身诊断日志（512KB 轮转、保留 3 份），开关取 `config.diagLogEnabled` |
| `system_info` | `Arc<Mutex<sysinfo::System>>` | 增量刷新，避免 `new_all` 的每次高开销 |
| `tool_processes` / `file_send_cancel` / `popouts` | `Mutex<HashMap<..>>` | 外部工具子进程 / 文件发送取消令牌 / 弹窗注册表 |

配置 → 运行期的同步只有 **`AppState::apply_runtime_config(&AppConfig)`** 一个入口：内部 `LogSettings::from_config(cfg)` + `LogManager::apply_settings(...)` 同步日志设置，`DiagLogger::set_enabled(cfg.diag_log_enabled)` 同步诊断开关。调用点只有两处——`AppState::new`（启动）与 `set_config` 命令，因此 **`set_config` 是运行期变更的唯一同步点**。旧的逐字段日志 setter 命令、前端镜像同步函数、以及「启动与命令各手抄一份 setter」（新增字段必漏一处）均已删除。
