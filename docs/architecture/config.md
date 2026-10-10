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
- 读取：先 `strip_legacy_memory_budget_keys`，再反序列化。失败则 `log::warn` 并回退 `.json.bak`（同样先剥离旧 key）；`.bak` 也不可用才用默认值——corrupt JSON 自动恢复。
- 在插件 Worker 启动前恢复 `plugin-transaction.json` 所属磁盘事务；旧插件条目缺少 `installGeneration` 时分配 UUID、保存并同步安全 `.bak`。这是安装身份迁移，不是配置版本分派。
- `save()`：计算下一 revision → 序列化并同步临时文件 → 单操作替换配置文件 → 同步父目录；失败不保留推进的内存 revision。普通保存先尽力复制旧配置到 `.json.bak`；插件安装清权、身份迁移及事务恢复另用 `save_safe_backup` 同步安全恢复副本，避免旧授权借配置损坏恢复。
- `set_config()` = `validate_and_clamp()` → 替换内存 → `save()`；`get_config_mut()` 供 CRUD 命令直接改实体数组（同样落盘）。

### 数值边界：`CONFIG_BOUNDS` 是唯一来源

- **Rust**：`pub const CONFIG_BOUNDS: &[(&str, i64, i64)]`（`src-tauri/src/config/mod.rs`）是数值范围的唯一来源。`validate_and_clamp` 经 `clamp_bound(name, value)` 查表收敛，**调用点不写 clamp 字面量**；名字缺失直接 panic（静默不收敛正是「非法值落盘」的来源）。其中 `uiScalePercent` 的边界为 **80–200**。
- **前端**：镜像表在 `src/utils/bounds.ts`（导出 `CONFIG_BOUNDS` 与 `BoundedNumericSetting` 类型）。
- **跨语言契约测试**：`src/utils/bounds.test.ts` 用 `?raw` 导入 Rust 源文本、正则逐项解析 `CONFIG_BOUNDS`，断言**两侧键集合相同且每个键的 min/max 相等**——任一侧改了未同步另一侧立即红（曾出现前端允许 8..96 而后端收敛到 8..48，用户输入被静默丢弃；备份间隔 1..8760 vs 1..720 同款）。
- **枚举字段**走 `restrict(field, &[...], fallback)`：`closeBehavior` / `theme` / `language` / `logFormat` / `timestampMode` / `timestampFormat` / `logEncoding` / `logSubdirMode`（非法值回 `date`）/ `updateCheckMode`（非法值含旧版残留回 `stable`）/ `defaultLineEnding`，以及 `entities.port_meta[*].mode`（非 `trx`/`tty` 收敛回 `trx`，issue #11）。

### 会话快照

- `update_session_snapshot` / `get_session_snapshot` 读写**独立**的 `session.json`（格式 `{"snapshot": "..."}`），与 config.json 分开——高频快照写入**不触发** config 的 `.bak` churn。
- `ui.configReady`（`useSystemStore`，`loadConfig` 完成后置位；加载失败保留默认值也置位）供主窗/弹出窗按加载后的配置应用 WebView 缩放，也供自动更新等待配置就绪，替代旧的固定超时启发式（config 加载超过阈值会按默认 stable 误判用户设置的 none/preview）。它**不进**会话快照。

### 前端 WebView 缩放

- `uiScalePercent` 是持久化的 UI 缩放百分比，默认 **100%**，由 `CONFIG_BOUNDS` 约束为 **80–200%**；它使用原生 WebView 缩放，不是 CSS transform，也不等同于 `terminalFontSize` / `uiFontSize`（后两者仍是字体设置）。
- `src/utils/uiScale.ts` 的 `applyUiScale` 调用 Tauri `getCurrentWebview().setZoom(percent / 100)`；缩放按 WebView 实例分别应用。主窗在 `configReady` 后应用已加载值，弹出窗（Popout）启动时读同一 config.json 后应用；独立窗口互不共享运行态。
- `ConfigModal` 只有在 `saveConfig()` 成功后才调用 `applyUiScale(current.uiScalePercent)` 并通过 `ui-scale:changed` 通知已打开的弹出窗；取消或保存失败不会把未落盘的缩放应用到 WebView。

## 命令

- `commands/config.rs`（**5 个**）：`get_config` / `set_config` / `update_session_snapshot` / `get_session_snapshot` / `get_config_path`。「恢复默认」**没有**后端命令：内存态由 `useAppStore.resetConfig()` 重置（当前无 UI 调用点），落盘仍走同一条安全快照 `saveConfig`——多一条后端命令只会多一个写路径。
- `commands/storage.rs`（**20 个**）：6 类带 `id` 实体 × save/load/delete = 18，加整体替换的 `save_port_groups` / `save_port_meta`。这 20 个命令共享 `read_config` / `save_entity` / `delete_entity` 三个助手 + `entity_accessors!` / `impl_entity_id!` 宏生成的访问器（不再是 20 份手抄的「加锁 → 找同 id → 替换/追加 → save」）。命令名 / 参数名 / 返回类型保持不变——前端 `storageService` 编译期依赖它们。
- CRUD 语义：`save_entity` 按 id upsert，**空 id = 新建**（后端生成 UUID），返回最终 id；`delete_entity` 按 id 删除，**不存在的 id 是无操作**（不报错、不动其它条目、不打乱剩余顺序）；`save_port_groups` / `save_port_meta` 是**整组替换**，且**没有**对应 load 命令——读走 `get_config`（`port_groups` / `port_meta` 随 `AppConfig` 一并返回）。
- **注册漂移守卫**：`config/mod.rs` 的 `test_generate_handler_matches_tauri_command_attribute` 对比 `lib.rs` 的 `generate_handler!` 与命令定义，漏注册/多注册即失败。当前注册 **74** 个命令；配置域 5 个、规则存储域 20 个，插件域另有 9 个（含安装、启停、权限及 IO），契约见[插件模块](plugins.md#宿主命令与状态快照)。

## 6 个 Zustand Store

| Store | 职责 | 纪律 |
|---|---|---|
| `useAppStore` | tabs / ports / `paneTree` / config / groups | 规则实体数组是启动快照，普通设置是草稿；`pluginConfigs` 由后端 revision 排序快照刷新；树算法在 `src/utils/paneTree.ts` |
| `useSystemStore` | `systemStatus` / `trafficStats` / `simulationMode` / `ui.*`（含 `configReady`）+ `clearTrafficStats` | 高频写点集中地（5s 系统轮询 / 每端口 1s 流量 flush / 拖拽 resize），故必须与 `useAppStore` 分开 |
| `useOperationStore` | serial params + send（**无 `op` 前缀**、无显示态字段）+ `cyclicLoops: Record<portId, boolean>` | 显示态不在此 |
| `useTerminalStore` | 纯显示态（scrollLocked/showTimestamp/displayFormat/encoding/connectedAt） | 行缓冲在 viewportManager 环形缓冲区；无行数组、无 Immer、不随数据更新 |
| `useRuleStore` | highlightRuleSets / sendCommandSets / protocolTemplates / triggerRules / portToolConfigs + CRUD | 规则编辑**实时态**（活实体，全量保存的权威来源） |
| `useToastStore` | 通知队列（toasts / stashed） | 宿主走 `push` 保留通知；插件走 `pushPlugin`，身份由宿主赋值并应用速率/文本/积压限额，见[通知模块](workspace.md#通知中心--toast) |

`useSystemStore` 由 `useAppStore` **拆出**（`systemStatus` / `trafficStats` / `simulationMode` / `ui`）：这些字段与端口/标签页的订阅者无关，混在一起会让每次流量 flush 都唤醒 Pane / OperationPanel / Sidebar 重跑选择器。另有 `releaseTerminalState.ts`（统一回收某端口的 terminals / trafficStats / TX 历史）与 `resetStores.ts`（测试用整份复位）。

**选择器纪律（Critical）**：调用 store 不带 selector 订阅整 store——每个串口数据事件都会重渲染该组件（输入失焦/卡顿）。hook 内写不订阅用 `getState()`。

## 配置持久化：安全快照（issue #5-2）

后端 `set_config` 是**整体替换**，所以调用方不能把 `useAppStore.config` 直接交出去：那是启动时读入的快照，而各实体数组有各自的权威来源（规则页单条保存只写 `useRuleStore` / `storageService`，从不回写 `store.config`）。直接整体替换会把用户刚保存的规则、分组、预设静默回滚成启动时的样子（**曾清空用户编辑**）。

现方案：`useConfigPersistence.saveConfig(patch?)` **内部始终构造安全快照**，调用方不自行合并实体数组；`patch` 仅覆盖本次关心的普通字段。每轮先读取后端配置的 `revision` 与预设，再从实时 store 取标量草稿、5 类规则实体和分组；规则按 id 对比启动快照与后端状态，保留尚未保存的本地编辑，同时让更新较晚的独立 CRUD 写入获胜。`portMeta` 由当前端口实时态与后端已有的离线端口条目合并；最后以 `setConfig(candidate, false, revision)` 做 CAS，冲突则重新读取并组装。

- `portPresets` **没有** store 镜像（唯一写路径是 `storageService.savePortPresets`），保存前 `loadPortPresets()` 读回；读不到就不写——宁可不保存，也不能用陈旧快照覆盖磁盘。
- `collectPortMeta(ports)` 仅投影本次枚举到的端口；`mergePortMeta(ports, persisted.portMeta)` 用实时端口条目覆盖当前端口、保留后端已有的离线端口备注/隐藏/TTY 模式；当前端口显式清空全部元数据时移除其条目，不会被旧配置复活。`saveConfig` 与 `useAppInit` 自动保存共用该投影口径；自动保存读取最新后端配置并以 revision CAS 重试，且与本窗全量保存串行化，防延迟提交覆盖较新的编辑。
- 已接线处：`ConfigModal.handleSave`、`DiagnosticLogDialog` 的诊断开关（改 store 后 `saveConfig()`）。**新增全量保存点照抄此模式**——调 `saveConfig`，不要自己拼实体数组。
- 实体页的**单条**保存（✓）不走全量保存：`src/components/ConfigModal/hooks/useEntityPage.ts` 是 5 个实体页共用的「load / dirty-track / save / delete」契约。要点：挂载即全量加载并替换 store（**除非**加载期间用户已改动；后端返回空列表也替换——跳过它正是「用户删过的实体在下次打开弹窗时复活并再次写回 config.json」的成因）；删除 = store 掉 + 后端删，失败必 toast；`savedSnapshotRef` 记录最后已知持久化态，只在写成功后推进，写失败保持 dirty 并由下次编辑重试。
- 插件不是五类规则页的实体：启停与权限动作立即独立持久化，取消设置仅回滚普通草稿，保留当前插件状态及 revision。备份导入只覆盖同安装身份的授权；导入中同 ID 不同身份清权禁用、未提及的当前插件保留，且不安装代码或迁移 KV。

## 配置读取/保存数据流

```
应用启动 → useAppInit → useConfigPersistence.loadConfig → invoke get_config
  → ConfigManager.get_config() → 剥离旧 key + 反序列化 → useAppStore.setConfig(config)
    → useRuleStore 灌入 5 组活实体（setGroups 须在分组自动保存订阅注册之前执行）
    → useSystemStore.setUIState({ configReady: true })
    → 主窗（或弹出窗）`applyUiScale(config.uiScalePercent)`，缩放当前 WebView

用户保存 → ConfigModal.handleSave → saveConfig()（内部构造安全快照）
  → invoke set_config → ConfigManager.set_config()（validate_and_clamp → 原子写 + .bak）
    → AppState::apply_runtime_config(cfg)（日志设置 + 诊断开关 → 后端运行期镜像）
  → 保存成功后当前 WebView `applyUiScale(current.uiScalePercent)`，并广播 `ui-scale:changed` 给已打开的弹出窗；失败则不应用未落盘值

分组变更 → `useAppInit` 500ms 防抖 → `save_port_groups`；端口元数据变更 → 500ms 防抖 → `saveCurrentPortMeta`（取最新配置 + 保留离线端口元数据 + revision CAS 保存）。
```

## 规则实体激活语义

- `useRuleStore.setSendCommandSets` / `addSendCommandSet` 建立不变量「有命令集时 `activeSendCommandSetId` 必指向有效集」：保留仍有效的激活集、否则回退首个；`removeSendCommandSet` 对称回退（曾因启动加载/新建集从不设置激活集，导致配置了命令集但操作面板快捷区/循环发送无反应）。
- 高亮引擎按各集 `isEnabled` 过滤（不读激活集 id——操作面板的规则分区已移除，该字段随之删除）。
- 弹窗（Popout）修改命令集后经 `popout:command-set-updated` 把**整集**回传主窗，写回 `useRuleStore` 的活实体，从而进入下一条全量保存的安全快照。

## AppState 运行期状态（配置的镜像）

`lib.rs::AppState` 持有全部运行期句柄：

| 字段 | 类型 | 说明 |
|---|---|---|
| `serial_manager` | `Arc<Mutex<SerialManager>>` | 异步命令经 `spawn_blocking` 时需从 State 克隆出 `'static` 句柄 |
| `config_manager` | `Mutex<ConfigManager>` | 配置读写（含全部实体） |
| `plugin_io` | `tokio::sync::Mutex<()>` | 串行化安装、卸载、授权、启停和一致列表扫描；普通资产 IO 以 FIFO 最多等待 2 秒，授权后再访问磁盘 |
| `log_manager` | **`Arc<LogManager>`（无外层 `Mutex`）** | 写路径是 `&self` + 内部细粒度锁；再套一层 Mutex 会让 `save_log_as` 的文件拷贝、`list_files` 的递归遍历与数据写入争同一把锁（高波特率下 RX 写入被拖住） |
| `diag_logger` | `Arc<DiagLogger>` | 应用自身诊断日志（512KB 轮转、保留 3 份），开关取 `config.diagLogEnabled` |
| `system_info` | `Arc<Mutex<sysinfo::System>>` | 增量刷新，避免 `new_all` 的每次高开销 |
| `tool_processes` / `file_send_cancel` / `popouts` | `Mutex<HashMap<..>>` | 外部工具子进程 / 文件发送取消令牌 / 弹窗注册表 |

配置 → 运行期的同步只有 **`AppState::apply_runtime_config(&AppConfig)`** 一个入口：内部 `LogSettings::from_config(cfg)` + `LogManager::apply_settings(...)` 同步日志设置，`DiagLogger::set_enabled(cfg.diag_log_enabled)` 同步诊断开关。调用点只有两处——`AppState::new`（启动）与 `set_config` 命令，因此 **`set_config` 是运行期变更的唯一同步点**。旧的逐字段日志 setter 命令、前端镜像同步函数、以及「启动与命令各手抄一份 setter」（新增字段必漏一处）均已删除。
