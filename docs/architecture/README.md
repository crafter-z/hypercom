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
│  4 Zustand stores    │        │  SerialManager      │
│  15 hooks + 服务层   │◄──────►│  ConfigManager      │
│  方案B 终端引擎       │  IPC   │  LogManager         │
│  rxPipeline/tty      │        │  diaglog            │
└──────────────────────┘        └─────────────────────┘
```

## 文档清单

| 文档 | 功能模块 | 核心内容 |
|------|---------|---------|
| [`serial.md`](serial.md) | 串口管理 | 端口枚举/热插拔/连接生命周期/参数流控/读写句柄分离/虚拟端口（SIM:Loopback）/外部工具（flasher）/端口排序 |
| [`terminal.md`](terminal.md) | 终端显示（TRX） | 方案B 渲染引擎（TerminalBuffer/Renderer/viewportManager）/滚动锁定/搜索/多编码/高亮/协议字段着色/双层内存预算 |
| [`tty.md`](tty.md) | TTY 终端 | xterm.js 完整交互终端/ttyService 管线/TRX↔TTY 切换/模拟终端（git bash pty）/会话跨标签保留 |
| [`transmission.md`](transmission.md) | 数据收发 | RX 管线（字节组装/rAF 批写/visibility）/TX 发送（回显/时序/守卫）/循环发送/快捷发送/命令面板/文件发送/触发引擎 |
| [`logging.md`](logging.md) | 日志 | RX 落盘日志（行组装/分片/子目录/编码/每会话新文件）/应用诊断日志（diaglog） |
| [`config.md`](config.md) | 配置与状态 | config.json 实体/会话快照/4 stores 划分/规则实体 CRUD/持久化审计（mergeLiveRuleEntities）/分组/端口元数据 |
| [`workspace.md`](workspace.md) | 工作区与通知 | paneTree 分屏/标签页/弹出体系（popout）/操作面板布局/侧边栏/通知中心/状态栏/自定义文本右键菜单 |
| [`update.md`](update.md) | 自动更新 | preview/stable 双通道/检查周期/snooze/UpdateDialog/发版护栏 |
| [`release.md`](release.md) | 发版与构建 | CI/CD 工作流/签名/密钥轮换/坏版本召回/RELEASE_NOTES 机制/故障排查 |
| [`errors.md`](errors.md) | 错误处理 | CommandError 变体映射/触发条件/i18n key/错误处理约定 |

## 通用约定（贯穿所有模块）

- **两编译器项目**：前端 React 18 + TypeScript（`src/`），后端 Rust + Tauri v2（`src-tauri/`）；Tauri 核心与 npm 包同 minor 版本（当前 2.11.x）。
- **Zustand 选择器纪律**：任何 store 调用必须带 selector，禁止无选择器订阅整 store（串口数据事件会触发重渲染 → 输入失焦/卡顿）。
- **跨 `.await` 锁纪律**：`MutexGuard` 是 `!Send`，async 命令必须「提取 + clone + drop 锁」后再 `.await`。
- **命令返回**：一律 `Result<T, CommandError>`，不得返回 `String`。
- **DEV 门控**：模拟串口/模拟终端/自动更新等调试能力双层门控——前端 `import.meta.env.DEV` 隐藏 UI + 后端 `cfg(not(debug_assertions))` 命令拒绝。
- **配置持久化审计**：任何全量 `set_config` 前必须 `mergeLiveRuleEntities(config, useRuleStore.getState())` 合并活实体，否则用陈旧快照覆盖 config.json（曾清空用户编辑）。
