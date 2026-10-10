# 架构文档索引

HyperCom 架构文档按**功能模块**组织。每个模块文档聚合该模块的架构设计、前端/后端实现、数据流、关键不变量、缺陷修复记录与已知边界。

## 模块划分

```
┌─────────────────────────────────────────────────────────────┐
│                    应用壳（Tauri v2）                        │
│   main.tsx / App.tsx / lib.rs / AppState / 命令注册          │
└──────────┬──────────────────────────────┬──────────────────┘
           │ invoke 命令 / 事件            │
┌──────────▼──────────┐        ┌──────────▼──────────┐
│    前端（React）      │        │    后端（Rust）      │
│  6 Zustand stores    │        │  SerialManager      │
│  18 hook files       │◄──────►│  ConfigManager      │
│  方案B 终端引擎       │  IPC   │  logger/LogManager  │
│  rxPipeline/ttySvc   │        │  diaglog/DiagLogger │
└──────────────────────┘        └─────────────────────┘
```

> 前端计数口径：`src/stores/` 6 个 store；`src/services/` 14 个生产文件 = tauri.ts barrel + 13 域（含 plugin / pluginView）；`src/hooks/` 18 个 hook 文件，不含测试/barrel/辅助模块，native遮挡 hook 在 shared。后端78命令、12域；插件校验在 plugin/mod.rs，磁盘事务在 transaction.rs，隔离原生承载在 view_runtime/，状态仍为ConfigManager第9类实体。

## 文档清单

插件作者的入口是独立的[插件开发指南](../plugin-development.md)（创建、manifest、Worker API、调试、打包）；下表的插件架构文档面向维护宿主实现，两者职责分开。

| 文档 | 功能模块 | 核心内容 |
|------|---------|---------|
| [`serial.md`](serial.md) | 串口管理 | 端口枚举/热插拔/连接生命周期/参数流控/读写句柄分离与发送期限/`PortKind::of` 类别分派 + 虚拟端口门控（SIM:Loopback）/外部工具（flasher）/端口排序与分组 |
| [`terminal.md`](terminal.md) | 终端显示（TRX） | 方案B 渲染引擎（TerminalBuffer/Renderer/viewportManager）/单一 `maxDisplayLines` 逐行覆盖滚动窗口/TerminalRenderer 渲染契约 R1–R15/滚动锁定/搜索/多编码/高亮/协议字段着色 |
| [`tty.md`](tty.md) | TTY 终端 | xterm.js 完整交互终端/ttyService 管线/TRX↔TTY 切换/模拟终端（git bash pty）/会话跨标签保留 |
| [`transmission.md`](transmission.md) | 数据收发 | RX 管线（字节组装/rAF 批写/visibility）/TX 发送（回显/时序/守卫）/循环发送（状态机合一 `useSequentialSend`）/快捷发送/命令面板/文件发送/触发引擎 |
| [`logging.md`](logging.md) | 日志 | RX 落盘日志（行组装/分片/子目录/编码/每会话新文件）/日志设置单一入口（`LogSettings::from_config` + `LogManager::apply_settings`，经 `AppState::apply_runtime_config` 由启动与 `set_config` 共用；无逐字段 `set_log_*` 命令）/应用诊断日志（diaglog） |
| [`config.md`](config.md) | 配置与状态 | config.json 实体（`Entities` 9 个 `Vec` 数组，含插件状态）/会话快照/6 个 store 划分/规则实体 CRUD/安全保存快照（`saveConfig(patch?)`）/`CONFIG_BOUNDS` 跨语言契约/分组与端口元数据 |
| [`workspace.md`](workspace.md) | 工作区与通知 | paneTree 分屏（树算法在 `utils/paneTree.ts`）/标签页/弹出体系（popout）/操作面板布局/侧边栏/通知中心/状态栏/自定义文本右键菜单 |
| [`update.md`](update.md) | 自动更新 | preview/stable 双通道/检查链路（GitHub API + endpoint 解析）/6h 重评估与 7 天 snooze/UpdateDialog/失败分类 |
| [`plugins.md`](plugins.md) | 插件宿主内部架构 | 安装身份/revision 授权一致性、原生 IPC、Worker 派发、RX 旁路及磁盘中断恢复；作者 API 见[开发指南](../plugin-development.md) |
| [`plugin-views.md`](plugin-views.md) | 插件隔离 UI 与工作区标签 | 原生隔离子 WebView、终端替换/额外插件标签、动作打开；安全、输入消费者与生命周期契约，Windows 已实现/其他平台门控 |
| [`release.md`](release.md) | 发版与构建 | CI/CD 工作流/签名/密钥轮换/坏版本召回/RELEASE_NOTES 机制/故障排查 |
| [`errors.md`](errors.md) | 错误处理 | `CommandError` 7 个变体定义与映射表（触发条件 = 命令/文件归属）/无按变体的 `toast.error.*` key（i18n 只有 `toast.severity.*` 与 `toast.fallback.operationFailed`）/消费路径（`extractErrorMessage` + `notifyError`） |

## 通用约定（贯穿所有模块）

- **两编译器项目**：前端 React 18 + TypeScript（`src/`），后端 Rust + Tauri v2（`src-tauri/`）；Tauri 核心与 npm 包同 minor 版本（当前 2.11.x）。
- **Zustand 选择器纪律**：`src/stores/` 共 6 个 store 模块（`useAppStore` / `useOperationStore` / `useTerminalStore` / `useRuleStore` / `useSystemStore` / `useToastStore`），任何 store 调用必须带 selector，禁止无选择器订阅整 store（串口数据事件会触发重渲染 → 输入失焦/卡顿）。其中 `useSystemStore`（`systemStatus` / `trafficStats` / `simulationMode` / `ui`）从 `useAppStore` 独立——高频轮询与 UI 开关不牵动标签页/端口等低频 state。
- **跨 `.await` 锁纪律**：`MutexGuard` 是 `!Send`，async 命令必须「提取 + clone + drop 锁」后再 `.await`。反证见 `AppState.log_manager`——它是 `Arc<LogManager>`（无外层 Mutex，写路径 `&self` + 内部细粒度锁），因此日志写入不需要持锁跨 `.await`，`save_log_as` 的拷贝 / `list_files` 递归 / 数据写入不争同一把锁。
- **命令返回**：一律 `Result<T, CommandError>`，不得返回 `String`。
- **DEV 门控**：模拟串口/模拟终端/自动更新等调试能力的后端门控**只有一处实现**——`commands/system_cmds.rs` 的 `dev_only(capability)` / `is_debug_build()`（命令体不得再自带 `#[cfg(debug_assertions)]` 双主体）；前端以 `import.meta.env.DEV`（`utils/devMode.ts` 的 `DEV_FEATURES_ENABLED`）隐藏 UI。两层都要有：release 构建下后端函数直接返回错误，前端同时不渲染入口。
- **配置持久化审计**：普通全量 `set_config` 经 `saveConfig(patch?)` 组装安全快照并以 revision CAS 保存，绝不用启动实体快照覆盖后端。备份导入是显式恢复边界，但插件授权只能恢复到同一 `installGeneration`；`BackupSettings.handleImport` 读回后端权威配置与插件列表后重载，不发布导入文件中的旧权限。
- **插件运行与发布证据**：安装身份、权限和 IO 契约见 [`plugins.md`](plugins.md)；最终安装包的原生 Worker/CSP、文件选择器与跨平台验收见 [`release.md`](release.md#插件发版验收门)。用户安装、授权、升级和卸载步骤见[使用手册](../userwiki/设置.md#插件)。
