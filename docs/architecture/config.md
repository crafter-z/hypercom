# 配置与状态模块

config.json 实体模型、会话快照、4 个 Zustand store 划分、规则实体 CRUD、持久化审计（mergeLiveRuleEntities）、分组/端口元数据。

## config.json（单一事实来源，2026-08 迁移）

SQLite 层已整体移除——**config.json 是 ALL settings 实体的唯一事实来源**。8 类实体以 8 个 `Vec` 字段挂在 `AppConfig` 上（全部 `#[serde(rename_all = "camelCase")]`）：

| 实体 | 字段 | 前端对应 |
|---|---|---|
| SendCommandSet | `send_command_sets` | 命令集（快捷发送/循环） |
| HighlightRuleSet | `highlight_rule_sets` | 高亮规则集 |
| ProtocolTemplate | `protocol_templates` | 协议解析模板 |
| TriggerRule | `trigger_rules` | 触发规则 |
| PortPreset | `port_presets` | 串口参数预设 |
| PortToolConfig | `port_tool_configs` | 外部工具配置 |
| PortGroup | `port_groups` | 串口分组（issue #2-3，整体替换） |
| PortMeta | `port_meta` | 端口元数据：备注名/隐藏/mode（issue #4-9，整体替换） |

标量字段（`memoryLimitMb`、`updateCheckMode`、`backgroundImage*`、`quickSendInlineCount` 等）走 `...config` 展开随全量保存流过——**不需要**进 `mergeLiveRuleEntities`。

### 生命周期

- 首启 `ConfigManager::new` 创建默认 AppConfig（空实体数组）；无数据库。
- `migrate()` + `config_version = 1`：fresh schema、forward-compatible、additive。
- `validate_and_clamp()`：`set_config` 时强制边界（`memory_limit_mb` clamp [64,8192]、`memory_per_port_budget_mb` [16,2048]、`update_check_mode` 三态、`log_subdir_mode` 非法值 clamp 回 date、`port_meta.mode` 非 trx/tty 钳回 trx…）。
- `save()` 原子写（tmp + rename + `.bak`）；`new()` 损坏时回退 `.bak`——corrupt JSON 自动恢复。
- 路径自定义：CLI `--config` / `HYPERCOM_CONFIG` env / portable 模式（`ConfigManager::new` 解析顺序）。

### 会话快照

- `update_session_snapshot` / `get_session_snapshot` 独立命令读写 `session.json`（**不触发** config.json 的 `.bak` churn）。
- `UIState.configReady` 信号（loadConfig 完成置位，不进会话快照）供自动更新等消费。

### 命令

`commands/config.rs`：`get_config` / `set_config` / `reset_config` / `update_session_snapshot` / `get_session_snapshot` / `get_config_path`。
`commands/storage.rs`：8 类实体 CRUD + `save_port_groups` + `save_port_meta`——同步 ConfigManager 操作（lock → `get_config_mut()` 改 Vec → `save()` 原子写）。`port_groups`/`port_meta` 是**整体替换**（save_port_groups / save_port_meta）。

## 4 个 Zustand Store

| Store | 职责 | 纪律 |
|---|---|---|
| `useAppStore` | tabs / ports / `paneTree` / config / groups + 树辅助 | config 实体数组是**启动快照**，不跟随 useRuleStore |
| `useOperationStore` | serial params + send（**无 `op` 前缀**、无显示态字段）+ `cyclicLoops: Record<portId, boolean>` | 显示态不在此 |
| `useTerminalStore` | 纯显示态（scrollLocked/showTimestamp/displayFormat/encoding/connectedAt）；行缓冲在 viewportManager 环形缓冲区 | 无行数组、无 Immer、不随数据更新 |
| `useRuleStore` | highlightRuleSets / sendCommandSets / triggerRules + CRUD | 规则编辑实时态 |

**选择器纪律（Critical）**：调用 store 不带 selector 订阅整 store——每个串口数据事件都会重渲染该组件（输入失焦/卡顿）。hook 内写不订阅用 `getState()`。

## 配置持久化审计（issue #5-2）

- `store.config` 实体数组是**启动快照**、从不跟随 `useRuleStore`——全量 `set_config` 前必须 `mergeLiveRuleEntities(config, useRuleStore.getState())` 合并 5 个活实体（sendCommandSets/highlightRuleSets/protocolTemplates/triggerRules/portToolConfigs），否则用陈旧数据整体覆盖 config.json（**曾清空用户编辑**）。
- `portPresets` 无 store 镜像（仅 store.config + 设置页本地态）；`portGroups`/`portMeta` 已由 useAppInit 同步（#4-10 模式：500ms 防抖自动保存，无手动「保存布局」按钮）。
- ConfigModal / DiagnosticLogDialog 已接线；**新增全量保存点照抄此模式**。

## 配置读取/保存数据流

```
应用启动 → useAppInit → useConfigPersistence.loadConfig → invoke get_config
  → ConfigManager.get_config() → JSON 读取 → useAppStore.setConfig(config)
用户保存 → ConfigModal.handleSave → mergeLiveRuleEntities(config, useRuleStore.getState())
  → saveConfig → invoke set_config → ConfigManager.set_config() → JSON 原子写
    → sync_log_manager_from_config()（set_config/reset_config 内部同步日志设置到 LogManager）
```

## 规则实体激活语义

- `useRuleStore.setSendCommandSets` / `addSendCommandSet` 建立不变量「有命令集时 `activeSendCommandSetId` 必指向有效集」：保留仍有效的激活集、否则回退首个；`removeSendCommandSet` 对称回退（曾启动加载/新建集从不设置激活集，操作面板循环无反应）。
- 高亮引擎按各集 `isEnabled` 过滤（从不读 `activeHighlightSetId`——RulesSection 移除后该字段已删）。

## 配置实体快照陷阱（issue #5-2 完整版）

任何绕过 `mergeLiveRuleEntities` 的全量保存都会用启动快照覆盖 config.json——`portPresets` 无 store 镜像（仅 store.config + 设置页本地态）；`portGroups`/`portMeta` 由 useAppInit 防抖同步（#4-10 模式）。ConfigModal/DiagnosticLogDialog 已接线。
