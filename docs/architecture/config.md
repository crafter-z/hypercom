# 配置与状态模块

config.json 实体模型与向前兼容口径、会话快照、6 个 Zustand store 划分、规则实体 CRUD、安全快照持久化、分组/端口元数据、前后端数值边界契约。

## config.json（单一事实来源，2026-08 迁移）

SQLite 层已整体移除——**config.json 是全部设置（标量 + 实体）的唯一事实来源**。

`AppConfig` 共 **43 个字段 = 42 个标量 + `#[serde(flatten)] entities: Entities`**（整体 `#[serde(rename_all = "camelCase")]`）。`Entities` 是 **8 个 `Vec` 实体数组**；`#[serde(flatten)]` 保证 **config.json 线格式零变化**：8 个实体仍是 config.json 的**顶层 key**。

| 实体 | `Entities` 字段 | config.json 顶层 key | 前端对应 |
|---|---|---|---|
| SendCommandSetEntry | `send_command_sets` | `sendCommandSets` | 命令集（快捷发送/循环） |
| HighlightRuleSetEntry | `highlight_rule_sets` | `highlightRuleSets` | 高亮规则集 |
| ProtocolTemplateEntry | `protocol_templates` | `protocolTemplates` | 协议解析模板 |
| TriggerRuleEntry | `trigger_rules` | `triggerRules` | 触发规则 |
| PortPresetEntry | `port_presets` | `portPresets` | 串口参数预设 |
| PortToolConfigEntry | `port_tool_configs` | `portToolConfigs` | 外部工具配置 |
| PortGroupEntry | `port_groups` | `portGroups` | 串口分组（issue #2-3，整体替换） |
| PortMetaEntry | `port_meta` | `portMeta` | 端口元数据：备注名/隐藏/mode（issue #4-9，整体替换） |

42 个标量（`updateCheckMode`、`diagLogEnabled`、`language`、`theme`、`backgroundImage*`、`quickSendInlineCount` 等）与 `entities` 同层，随 `...config` 展开流过全量保存。两层各自只有一种语义：实体只有 CRUD（`commands/storage.rs`），标量只有默认值 + 收敛（`impl Default` / `validate_and_clamp`）。

### 向前兼容与 schema：没有版本字段

**没有版本字段，也没有版本分派**。曾有一个「每次保存都无条件重写为 1」的版本字段，它既不参与分派也不影响解析（旧值被 serde 当未知字段丢弃），已删除。向前兼容只靠两件事：

1. **serde 容器级 `#[serde(default)]`**：`AppConfig` 与 `Entities` 都带（缺字段取 `impl Default` 的值），实体子结构再各自带字段级 `#[serde(default)]`——这是「旧文件缺新字段」的唯一迁移机制，也让默认值只有一个来源（字段级 `#[serde(default = "...")]` 与 `impl Default` 两份手抄曾不一致且无任何编译错误）。
2. **解析前 `strip_legacy_memory_budget_keys`**：在 `serde_json::Value` 层**物理删除**已被取代的旧内存预算 key（`memoryLimitMb` / `memoryPerPortBudgetMb`）——纯粹的**升级兼容**，首次保存落盘后旧 key 即消失。输入非合法 JSON 时返回 `None`，调用方据此走 `.bak` 恢复。

### 生命周期

- 首启 `ConfigManager::new` 构造默认 `AppConfig`（空实体数组）；无数据库。
- **配置文件路径解析顺序**（`ConfigManager::new`）：CLI `--config <path>` → `HYPERCOM_CONFIG` 环境变量 → 便携模式（可执行文件同目录下**已存在**的 `config.json`）→ 默认 `%APPDATA%/hypercom/config.json`（`dirs::config_dir`）。会话快照路径恒为配置文件同目录的 `session.json`。
- 读取：先 `strip_legacy_memory_budget_keys`，再反序列化。失败则 `log::warn` 并回退 `.json.bak`（同样先剥离旧 key）；`.bak` 也不可用才用默认值——corrupt JSON 自动恢复。
- `save()` **原子写**：tmp + rename；写前若目标文件已存在，先复制出 `.json.bak`。
- `set_config()` = `validate_and_clamp()` → 替换内存 → `save()`；`get_config_mut()` 供 CRUD 命令直接改实体数组（同样落盘）。

### 数值边界：`CONFIG_BOUNDS` 是唯一来源

- **Rust**：`pub const CONFIG_BOUNDS: &[(&str, i64, i64)]`（`src-tauri/src/config/mod.rs`）是数值范围的唯一来源。`validate_and_clamp` 经 `clamp_bound(name, value)` 查表收敛，**调用点不写 clamp 字面量**；名字缺失直接 panic（静默不收敛正是「非法值落盘」的来源）。
- **前端**：镜像表在 `src/utils/bounds.ts`（导出 `CONFIG_BOUNDS` 与 `BoundedNumericSetting` 类型）。
- **跨语言契约测试**：`src/utils/bounds.test.ts` 用 `?raw` 导入 Rust 源文本、正则逐项解析 `CONFIG_BOUNDS`，断言**两侧键集合相同且每个键的 min/max 相等**——任一侧改了未同步另一侧立即红（曾出现前端允许 8..96 而后端收敛到 8..48，用户输入被静默丢弃；备份间隔 1..8760 vs 1..720 同款）。
- **枚举字段**走 `restrict(field, &[...], fallback)`：`closeBehavior` / `theme` / `language` / `logFormat` / `timestampMode` / `timestampFormat` / `logEncoding` / `logSubdirMode`（非法值回 `date`）/ `updateCheckMode`（非法值含旧版残留回 `stable`）/ `defaultLineEnding`，以及 `entities.port_meta[*].mode`（非 `trx`/`tty` 收敛回 `trx`，issue #11）。

### 会话快照

- `update_session_snapshot` / `get_session_snapshot` 读写**独立**的 `session.json`（格式 `{"snapshot": "..."}`），与 config.json 分开——高频快照写入**不触发** config 的 `.bak` churn。
- `ui.configReady`（`useSystemStore`，`loadConfig` 完成后置位；加载失败保留默认值也置位）供自动更新等待配置就绪，替代旧的固定超时启发式（config 加载超过阈值会按默认 stable 误判用户设置的 none/preview）。它**不进**会话快照。

### 命令

- `commands/config.rs`（**5 个**）：`get_config` / `set_config` / `update_session_snapshot` / `get_session_snapshot` / `get_config_path`。「恢复默认」**没有**后端命令：内存态由 `useAppStore.resetConfig()` 重置（当前无 UI 调用点），落盘仍走同一条安全快照 `saveConfig`——多一条后端命令只会多一个写路径。
- `commands/storage.rs`（**20 个**）：6 类带 `id` 实体 × save/load/delete = 18，加整体替换的 `save_port_groups` / `save_port_meta`。这 20 个命令共享 `read_config` / `save_entity` / `delete_entity` 三个助手 + `entity_accessors!` / `impl_entity_id!` 宏生成的访问器（不再是 20 份手抄的「加锁 → 找同 id → 替换/追加 → save」）。命令名 / 参数名 / 返回类型保持不变——前端 `storageService` 编译期依赖它们。
- CRUD 语义：`save_entity` 按 id upsert，**空 id = 新建**（后端生成 UUID），返回最终 id；`delete_entity` 按 id 删除，**不存在的 id 是无操作**（不报错、不动其它条目、不打乱剩余顺序）；`save_port_groups` / `save_port_meta` 是**整组替换**，且**没有**对应 load 命令——读走 `get_config`（`port_groups` / `port_meta` 随 `AppConfig` 一并返回）。
- **注册漂移守卫**：`src-tauri/src/config/mod.rs` 的 `test_generate_handler_matches_tauri_command_attribute` 解析 `lib.rs` 的 `generate_handler![...]` 命令名集合与全仓所有 `#[tauri::command]` 函数名比对，漏注册/多注册即失败。当前 `generate_handler!` 注册 **64** 个命令（本模块占 `config.rs` 5 + `storage.rs` 20）。

## 6 个 Zustand Store

| Store | 职责 | 纪律 |
|---|---|---|
| `useAppStore` | tabs / ports / `paneTree` / config / groups | config 实体数组是**启动快照**；树算法不在 store 内（已移到 `src/utils/paneTree.ts`，store 只留 action） |
| `useSystemStore` | `systemStatus` / `trafficStats` / `simulationMode` / `ui.*`（含 `configReady`）+ `clearTrafficStats` | 高频写点集中地（5s 系统轮询 / 每端口 1s 流量 flush / 拖拽 resize），故必须与 `useAppStore` 分开 |
| `useOperationStore` | serial params + send（**无 `op` 前缀**、无显示态字段）+ `cyclicLoops: Record<portId, boolean>` | 显示态不在此 |
| `useTerminalStore` | 纯显示态（scrollLocked/showTimestamp/displayFormat/encoding/connectedAt） | 行缓冲在 viewportManager 环形缓冲区；无行数组、无 Immer、不随数据更新 |
| `useRuleStore` | highlightRuleSets / sendCommandSets / protocolTemplates / triggerRules / portToolConfigs + CRUD | 规则编辑**实时态**（活实体，全量保存的权威来源） |
| `useToastStore` | 通知队列（toasts / stashed + `notifyError` / `notifySuccess` / `notifyInfo`） | 全局通知出口，持久化失败经此上报 |

`useSystemStore` 由 `useAppStore` **拆出**（`systemStatus` / `trafficStats` / `simulationMode` / `ui`）：这些字段与端口/标签页的订阅者无关，混在一起会让每次流量 flush 都唤醒 Pane / OperationPanel / Sidebar 重跑选择器。另有 `releaseTerminalState.ts`（统一回收某端口的 terminals / trafficStats / TX 历史）与 `resetStores.ts`（测试用整份复位）。

**选择器纪律（Critical）**：调用 store 不带 selector 订阅整 store——每个串口数据事件都会重渲染该组件（输入失焦/卡顿）。hook 内写不订阅用 `getState()`。

## 配置持久化：安全快照（issue #5-2）

后端 `set_config` 是**整体替换**，所以调用方不能把 `useAppStore.config` 直接交出去：那是启动时读入的快照，而各实体数组有各自的权威来源（规则页单条保存只写 `useRuleStore` / `storageService`，从不回写 `store.config`）。直接整体替换会把用户刚保存的规则、分组、预设静默回滚成启动时的样子（**曾清空用户编辑**）。

现方案：`useConfigPersistence.saveConfig(patch?)` **内部始终构造安全快照**——调用方不必也无法自己合并实体数组，`patch` 只用来覆盖本次调用关心的普通字段（如更新模式）：

```ts
await configService.setConfig({
  ...state.config,                          // 标量：store 草稿
  ...patch,                                 // 本次调用关心的普通字段
  sendCommandSets:   rules.sendCommandSets, // ↓ useRuleStore 的 5 组活实体
  highlightRuleSets: rules.highlightRuleSets,
  protocolTemplates: rules.protocolTemplates,
  triggerRules:      rules.triggerRules,
  portToolConfigs:   rules.portToolConfigs,
  portGroups: state.groups,                 // 分组实时态
  portMeta:   collectPortMeta(state.ports), // 从端口列表现推，不回写 store.config
  portPresets,                              // 无活镜像：保存前从后端读回
});
```

- `portPresets` **没有** store 镜像（唯一写路径是 `storageService.savePortPresets`），保存前 `loadPortPresets()` 读回；读不到就不写——宁可不保存，也不能用陈旧快照覆盖磁盘。
- `collectPortMeta(ports)` 从端口列表现推 `portMeta`（备注名 / 隐藏 / `tty` 模式只存在于端口列表，枚举产生的端口项不携带它们）；`saveConfig` 与 `useAppInit` 的自动保存**共用**它，避免两处各写一遍过滤条件后悄悄漂移（漏一项就会被全量保存静默抹掉）。
- 已接线处：`ConfigModal.handleSave`、`DiagnosticLogDialog` 的诊断开关（改 store 后 `saveConfig()`）。**新增全量保存点照抄此模式**——调 `saveConfig`，不要自己拼实体数组。
- 实体页的**单条**保存（✓）不走全量保存：`src/components/ConfigModal/hooks/useEntityPage.ts` 是 5 个实体页共用的「load / dirty-track / save / delete」契约。要点：挂载即全量加载并替换 store（**除非**加载期间用户已改动；后端返回空列表也替换——跳过它正是「用户删过的实体在下次打开弹窗时复活并再次写回 config.json」的成因）；删除 = store 掉 + 后端删，失败必 toast；`savedSnapshotRef` 记录最后已知持久化态，只在写成功后推进，写失败保持 dirty 并由下次编辑重试。

## 配置读取/保存数据流

```
应用启动 → useAppInit → useConfigPersistence.loadConfig → invoke get_config
  → ConfigManager.get_config() → 剥离旧 key + 反序列化 → useAppStore.setConfig(config)
    → useRuleStore 灌入 5 组活实体（setGroups 须在分组自动保存订阅注册之前执行）
    → useSystemStore.setUIState({ configReady: true })

用户保存 → ConfigModal.handleSave → saveConfig()（内部构造安全快照）
  → invoke set_config → ConfigManager.set_config()（validate_and_clamp → 原子写 + .bak）
  → AppState::apply_runtime_config(cfg)（日志设置 + 诊断开关 → 运行期镜像）

分组 / 端口元数据变更 → useAppInit 500ms 防抖 → save_port_groups / save_port_meta（整组替换）
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
| `log_manager` | **`Arc<LogManager>`（无外层 `Mutex`）** | 写路径是 `&self` + 内部细粒度锁；再套一层 Mutex 会让 `save_log_as` 的文件拷贝、`list_files` 的递归遍历与数据写入争同一把锁（高波特率下 RX 写入被拖住） |
| `diag_logger` | `Arc<DiagLogger>` | 应用自身诊断日志（512KB 轮转、保留 3 份），开关取 `config.diagLogEnabled` |
| `system_info` | `Arc<Mutex<sysinfo::System>>` | 增量刷新，避免 `new_all` 的每次高开销 |
| `tool_processes` / `file_send_cancel` / `popouts` | `Mutex<HashMap<..>>` | 外部工具子进程 / 文件发送取消令牌 / 弹窗注册表 |

配置 → 运行期的同步只有 **`AppState::apply_runtime_config(&AppConfig)`** 一个入口：内部 `LogSettings::from_config(cfg)` + `LogManager::apply_settings(...)` 同步日志设置，`DiagLogger::set_enabled(cfg.diag_log_enabled)` 同步诊断开关。调用点只有两处——`AppState::new`（启动）与 `set_config` 命令，因此 **`set_config` 是运行期变更的唯一同步点**。旧的逐字段日志 setter 命令、前端镜像同步函数、以及「启动与命令各手抄一份 setter」（新增字段必漏一处）均已删除。
