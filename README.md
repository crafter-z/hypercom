# HyperCom

一款现代化的串口调试工具，基于 **Tauri v2 + React 18 + Rust** 构建。面向嵌入式开发场景，目标是替代 SSCOM / SuperCom 等传统工具。

> 核心理念：**Rust 处理底层性能，React 负责 UI 交互**。

![HyperCom UI](plans/UI.png)

---

## 功能特性

### 串口与连接
- 🔌 **自动枚举** — 每 3 秒刷新系统串口列表，`mergePorts` 保留连接态、别名、分组等本地状态
- 🧪 **模拟串口** — 内置 `SIM:Loopback` 虚拟端口（回显 + 心跳），无硬件即可调试
- ⚙️ **完整参数** — 波特率（含自定义）、数据位、停止位、校验位、流控、DTR/RTS
- 🗂️ **分组管理** — 自定义分组、备注名、隐藏开关、搜索过滤、跨组拖拽排序

### 终端与显示
- 📑 **多标签 + 灵活分屏** — 支持上下/左右分屏、跨 Pane 拖拽标签、`@dnd-kit` 水平排序
- ⚡ **虚拟滚动** — `@tanstack/react-virtual`，DOM 节点从 O(N) 降到约 30–50（视口 + overscan）
- 🎨 **语法高亮** — 正则 / 关键词规则集，可配置颜色、加粗、斜体，通过 `dangerouslySetInnerHTML` 注入（已 `escapeHtml`）
- 📅 **时间戳 / TX·RX 着色** — 多种时间戳格式、字符串/HEX/二进制显示切换
- 🌗 **暗色 / 亮色 / 跟随系统** — 基于 CSS 变量的主题体系

### 收发与命令
- ✉️ **手动发送** — 字符串 / HEX 解析（含边界检查）/ 自定义行结束符
- 🔁 **循环发送** — 命令集顺序执行、单条延时、整体循环间隔
- 📦 **命令集编辑器** — SQLite 持久化，可配置每条命令的类型、内容、行结束符、延时

### 日志与导出
- 📝 **自动日志** — 每端口独立 `BufWriter`，连接即写、断开即 `sync_all` 落盘
- 🪓 **分片续写** — 按大小阈值自动切片，文件名模板支持 `[com]/[datetime]/[date]/[time]` 变量
- 🌐 **多编码** — UTF-8 / GBK / ISO-8859-1 / ASCII，前端 `TextDecoder` 同步切换
- 💾 **数据导出** — 右键菜单导出 TXT/CSV 真实文件（`save()` 对话框 + Rust `std::fs::write`）
- 📂 **另存 / 打开文件 / 打开目录** — 路径已 `canonicalize` 作用域校验，禁止越权访问

### 系统与配置
- 📊 **资源监控** — `sysinfo` 进程级 CPU / 内存采样（启动时 250ms 预热建立 CPU 基线）
- 📈 **流量统计** — 每端口 TX/RX 字节累加
- 🛠️ **6 页配置弹窗** — 通用、日志、备份、显示、高亮规则、命令规则
- 🔋 **防休眠** — Win32 `SetThreadExecutionState` 实现 `ES_CONTINUOUS | ES_DISPLAY_REQUIRED`

---

## 技术栈

### 前端

| 包 | 版本 | 用途 |
|----|------|------|
| `react` / `react-dom` | ^18.3.1 | UI 框架 |
| `typescript` | ^5.6.3 | 类型系统 |
| `vite` | ^5.4.10 | 构建工具 |
| `zustand` + `immer` | ^5.0.13 / ^11.1.6 | 全局状态管理（4 个 store，按领域拆分） |
| `@dnd-kit/core` + `sortable` + `utilities` | ^6.3.1 / ^10.0.0 / ^3.2.2 | 拖拽与排序（侧边栏、标签页） |
| `@tanstack/react-virtual` | ^3.13.15 | 终端虚拟滚动 |
| `@tauri-apps/api` | ^2.0.0 | Tauri 前端桥接 |
| `@tauri-apps/plugin-dialog` | ^2.7.1 | 文件对话框 |
| `@tauri-apps/plugin-shell` | ^2.0.0 | 打开外部文件 / URL |
| `lucide-react` | ^1.14.0 | 矢量图标 |
| `vitest` | ^4.1.7 | 单元测试（`environment: 'node'`） |

> 样式采用全局 CSS Variables，按组件拆分到 `src/styles/` 目录（10 个组件 CSS + `base.css`），`src/styles.css` 仅作 `@import` 入口，无 CSS-in-JS。

### 后端

| Crate | 版本 | 用途 |
|-------|------|------|
| `tauri` | 2.11 | 跨平台桌面框架 |
| `tauri-plugin-shell` / `tauri-plugin-dialog` | 2 | Shell / 文件对话框插件 |
| `serialport` | 4 | 跨平台串口 I/O |
| `tokio` | 1 (full) | 异步运行时 |
| `sqlx` | 0.7 (`runtime-tokio`, `sqlite`) | SQLite CRUD（命令集 / 规则集 / 分组） |
| `sysinfo` | 0.33 | 进程级 CPU / 内存采样 |
| `serde` / `serde_json` | 1 | 序列化 |
| `encoding_rs` | 0.8 | GBK 等多编码解码（替代旧 U+FFFD 占位符方案） |
| `chrono` | 0.4 | 时间处理 |
| `dirs` | 5 | 系统目录解析 |
| `uuid` | 1 (v4) | ID 生成 |
| `anyhow` / `thiserror` | 1 | 错误处理（`CommandError` 基于 `thiserror` 枚举） |
| `log` / `env_logger` | 0.4 / 0.11 | 日志 |
| `once_cell` | 1 | 静态初始化 |

> **版本约束**：`@tauri-apps/api`（npm）与 `tauri`（Cargo）的次版本必须一致，当前均为 **2.11.x**。

---

## 项目结构

```
hypercom/
├── src/                              # React 前端
│   ├── App.tsx                       # 根组件：布局编排 + useAppInit + useSerialReceive + 全局右键禁用
│   ├── main.tsx                      # ReactDOM.createRoot
│   ├── styles.css                    # @import 入口（指向 styles/ 目录）
│   ├── types/index.ts                # 全局 TS 类型
│   ├── services/tauri.ts             # invoke 包装层（6 个服务模块）
│   ├── hooks/useTauri.ts             # React Hooks 桥接（8 个 Hooks）
│   ├── stores/                       # Zustand + Immer，按领域拆分为 4 个 store
│   │   ├── useAppStore.ts            # 标签 / 端口 / 分屏 / 配置 / 分组
│   │   ├── useAppStore.test.ts       # vitest 单测
│   │   ├── useOperationStore.ts      # 串口参数 + 发送设置（baudRate / dataBits / parity / ...）
│   │   ├── useTerminalStore.ts       # 终端行缓冲 + appendTerminalLine / clearTerminal
│   │   └── useRuleStore.ts           # 高亮规则集 + 命令集 CRUD
│   ├── utils/
│   │   ├── highlightEngine.ts        # 语法高亮引擎
│   │   ├── highlightEngine.test.ts   # 高亮引擎单测
│   │   └── hexUtils.ts               # hexToString / stringToHex
│   ├── styles/                       # 按组件拆分的 CSS（10 个组件文件 + base.css）
│   │   ├── base.css                  # CSS 变量 / 主题 / 重置
│   │   ├── sidebar.css
│   │   ├── main-display.css
│   │   ├── tabbar.css
│   │   ├── terminal-view.css
│   │   ├── operation-panel.css
│   │   ├── config-modal.css
│   │   ├── status-bar.css
│   │   ├── titlebar.css
│   │   └── context-menu.css
│   └── components/
│       ├── shared/ContextMenu.tsx    # 通用右键菜单
│       ├── TitleBar/TitleBar.tsx     # 标题栏 + 窗口控制
│       ├── Sidebar/                  # 串口列表 + 分组 + 拖拽（Sidebar.tsx + AliasDialog.tsx）
│       ├── MainDisplay/              # 多分屏容器（5 个文件）
│       │   ├── MainDisplay.tsx       # Pane 编排 + ResizeHandle
│       │   ├── Pane.tsx              # 单个分屏容器
│       │   ├── TabBar.tsx            # 标签页 + 水平拖拽
│       │   ├── TerminalView.tsx      # 终端 + 虚拟滚动 + 高亮 + 导出
│       │   └── ResizeHandle.tsx      # 分屏拖拽手柄
│       ├── OperationPanel/           # 发送区 + 循环发送 + 参数（4 个 section 组件）
│       │   ├── OperationPanel.tsx    # 容器编排
│       │   ├── SendSection.tsx       # 手动 / 循环发送
│       │   ├── ParamsSection.tsx     # 串口参数配置
│       │   └── RulesSection.tsx      # 高亮 / 命令规则快捷
│       ├── StatusBar/StatusBar.tsx   # 系统状态 + 流量 + 时钟
│       └── ConfigModal/              # 6 页配置弹窗 + 规则编辑器（10 个文件）
│           ├── ConfigModal.tsx       # 弹窗容器 + 标签页切换
│           ├── RuleSetAccordion.tsx  # 规则集折叠列表
│           ├── pages/                # 6 个设置页
│           │   ├── GeneralSettings.tsx
│           │   ├── LogSettings.tsx
│           │   ├── BackupSettings.tsx
│           │   ├── DisplaySettings.tsx
│           │   ├── HighlightSettings.tsx
│           │   └── CommandSettings.tsx
│           └── editors/              # 规则 / 命令编辑器
│               ├── HighlightRuleEditor.tsx
│               └── SendCmdEditor.tsx
│
├── src-tauri/                        # Rust 后端
│   ├── src/
│   │   ├── main.rs                   # 程序入口
│   │   ├── lib.rs                    # AppState + 命令注册 + setup
│   │   ├── system.rs                 # win32_power 模块（SetThreadExecutionState FFI）
│   │   ├── commands/                 # Tauri 命令层，按领域拆分
│   │   │   ├── mod.rs                # CommandError 枚举（thiserror）+ re-export
│   │   │   ├── serial.rs             # open_port / close_port / send_data / get_port_status
│   │   │   ├── simulation.rs         # enable_simulation / disable_simulation
│   │   │   ├── config.rs             # get_config / save_config / reset_config
│   │   │   ├── log.rs                # start_logging / stop_logging / save_as / open_file
│   │   │   ├── storage.rs            # 高亮规则集 + 命令集 CRUD
│   │   │   └── system_cmds.rs        # get_system_status / prevent_sleep / prevent_screen_off
│   │   ├── serial/mod.rs             # 串口管理器（真实 + 模拟）
│   │   ├── config/mod.rs             # JSON 配置
│   │   ├── logger/mod.rs             # BufWriter 日志（分片 / 多编码）
│   │   └── storage/mod.rs            # SQLite CRUD（6 张表）
│   ├── capabilities/default.json     # Tauri ACL 权限声明
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── plans/                            # 完整设计文档
│   ├── 01-overview.md                # 项目概览
│   ├── 02-architecture.md            # 技术架构（含 Flexbox 链）
│   ├── 03-backend.md                 # Rust 模块 / 命令 / DB schema
│   ├── 04-data-flow.md               # 8 个关键数据流序列
│   ├── 05-components.md              # 组件树 / Props / 类型速查
│   ├── 06-status.md                  # 文件级完成度
│   ├── 07-roadmap.md                 # 优先级路线图
│   ├── 08-defects.md                 # 缺陷追踪与修复记录
│   └── 09-reference.md               # 文件索引 / 依赖 / 命名规范
│
├── AGENTS.md                         # 开发约束与陷阱速查
└── package.json
```

---

## 快速开始

### 环境要求

| 项 | 版本 | 说明 |
|----|------|------|
| **Node.js** | ≥ 18 | 前端构建 |
| **Rust** | stable | 推荐 [rustup](https://rustup.rs/) 安装 |
| **Visual Studio Build Tools**（Windows） | 2019+ | 需勾选「使用 C++ 的桌面开发」工作负载 |
| **WebView2 Runtime**（Windows） | — | Windows 11 自带；Windows 10 需 [手动安装](https://developer.microsoft.com/microsoft-edge/webview2/) |

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run tauri dev
```

> **PowerShell 执行策略阻塞 npm 时**：使用 `cmd /c "npm run tauri dev"`。

该命令会：
1. 启动 Vite 开发服务器（前端 HMR）
2. 编译 Rust 后端
3. 打开应用窗口

### 生产构建

```bash
npm run tauri build
```

构建产物位于：

```
src-tauri/target/release/bundle/
├── msi/      # Windows MSI 安装包
└── nsis/     # Windows NSIS 安装包 (.exe)
```

### 类型 / 编译检查

```bash
npx tsc --noEmit                                       # TypeScript 类型检查
cargo check --manifest-path src-tauri/Cargo.toml       # Rust 快速检查
```

### 测试

```bash
npm run test                                           # vitest 监听模式
npm run test:run                                       # vitest 一次跑（71 cases）
cargo test --lib --manifest-path src-tauri/Cargo.toml  # Rust 单元测试（24 cases）
```

---

## 使用说明

### 1. 连接串口
1. 在左侧栏选择串口（或启用「模拟模式」获取 `SIM:Loopback`）
2. 在 OperationPanel 右栏配置波特率、数据位、停止位、校验位、流控、DTR/RTS
3. 点击列表项右侧的连接按钮；连接成功状态点变绿，并自动开启该端口的日志文件

### 2. 收发数据
- **发送**：在 OperationPanel 左栏输入字符串或 HEX（如 `AA BB CC`），选择行结束符后回车 / 点击发送
- **循环发送**：切换到「循环发送」栏，选择命令集后启动；每条命令可单独配置延时；循环模式下整体重放
- **接收**：终端自动按时间戳显示 TX/RX，可右键切换显示格式或导出

### 3. 多标签与分屏
- 点击串口或双击标签 → 在当前 Pane 打开标签
- TabBar 工具栏「分屏」按钮 → 上下/左右创建新 Pane
- 拖拽标签到目标 Pane 即可移动；拖拽到 ResizeHandle 处可触发新分屏

### 4. 高亮规则与命令集
1. 工具栏配置按钮 → 「高亮规则」/「命令规则」标签页
2. 新建规则集，添加规则（正则或关键词、颜色、加粗、斜体）
3. 启用规则集后，终端实时按规则染色
4. 命令集同理，建好的命令集可在 OperationPanel 循环发送栏直接选用
5. 规则集 / 命令集落库到 SQLite，重启自动加载

### 5. 日志与导出
- **自动落盘**：连接即写；按文件名模板分文件夹组织（`[com]` / `[datetime]` 等变量）
- **分片**：超过阈值自动切片续写，旧文件 `sync_all` 后释放
- **另存为 / 打开文件 / 打开目录**：OperationPanel 工具栏按钮，路径限定在日志根目录内
- **终端导出**：终端右键菜单 → 导出 TXT/CSV 真实文件（不是剪贴板）

详细数据流见 [`plans/04-data-flow.md`](plans/04-data-flow.md)。

---

## 文档导航

| 文档 | 内容 |
|------|------|
| [`plans/01-overview.md`](plans/01-overview.md) | 项目定位、技术栈表、完成度总览 |
| [`plans/02-architecture.md`](plans/02-architecture.md) | 前后端分层、Flexbox 约束链、Hooks 频率表 |
| [`plans/03-backend.md`](plans/03-backend.md) | Rust 模块、Tauri 命令、DB schema、事件 |
| [`plans/04-data-flow.md`](plans/04-data-flow.md) | 8 条关键数据流（连接 / 收发 / 循环 / 配置 / 高亮…） |
| [`plans/05-components.md`](plans/05-components.md) | 组件树、Props、类型定义、CSS 变量 |
| [`plans/06-status.md`](plans/06-status.md) | 每个文件、每项功能的完成度 |
| [`plans/07-roadmap.md`](plans/07-roadmap.md) | 优先级路线图 |
| [`plans/08-defects.md`](plans/08-defects.md) | 缺陷追踪与修复历史 |
| [`plans/09-reference.md`](plans/09-reference.md) | 文件索引、依赖速查、命名规范 |
| [`AGENTS.md`](AGENTS.md) | 开发约束与高频陷阱（必读） |

> 注意：部分 plan 文件早于 store / hook / component 拆分重构。当文档与源码不一致时，以 `src/stores/`、`src/hooks/useTauri.ts`、`src/components/` 中的实际代码为准。

---

## 架构概览

### Store 拆分（4 个 Zustand store）

原单一 god store 已按领域拆分为 4 个独立 store，避免跨领域订阅导致的 re-render：

| Store | 职责 | 关键字段 / Actions |
|-------|------|-------------------|
| `useAppStore` | 标签、端口、分屏、配置、分组 | `ports`、`tabs`、`panes`、`config`、`groups`、`openTab`、`closeTab` |
| `useOperationStore` | 串口参数 + 发送设置（**无 `op` 前缀**） | `baudRate`、`dataBits`、`parity`、`stopBits`、`handshake`、`dtr`、`rts`、`sendInput`、`displayFormat`、`encoding`、`setOpState` |
| `useTerminalStore` | 终端行缓冲 | `terminals`、`appendTerminalLine`、`clearTerminal`、`setTerminalConfig`、`ensureTerminal` |
| `useRuleStore` | 高亮规则集 + 命令集 | `highlightRuleSets`、`activeHighlightSetId`、`sendCommandSets`、`activeSendCommandSetId` + CRUD |

### Hook 拆分（8 个 Hooks）

原 `useSerialData` 拆为两个生命周期不同的 Hook：

| Hook | 职责 | 调用位置 |
|------|------|---------|
| `useSerialPorts` | 每 3s 轮询端口列表 | Sidebar |
| `useSerialConnection` | 打开 / 关闭端口，经 `closePort()` 路由 | Sidebar / TabBar |
| `useSerialReceive` | `serial_data` 事件监听（**仅调用一次**） | App.tsx |
| `useSerialSend` | 发送动作 | OperationPanel |
| `useConfigPersistence` | 加载 / 保存配置到后端 | App.tsx |
| `useSystemStatus` | 每 5s 轮询 CPU / 内存 | StatusBar |
| `useAppInit` | 一次性应用初始化 | App.tsx |
| `useSimulation` | 切换 SIM:Loopback 虚拟端口 | Sidebar 工具栏 |

`useSerialReceive` 和 `useSerialSend` 都通过 `useTerminalStore.getState().appendTerminalLine()` 写入终端，避免每次行写入触发 Hook 拥有者 re-render。

### 后端命令拆分（6 个领域文件 + CommandError）

所有 Tauri 命令返回 `Result<T, CommandError>` 而非 `Result<T, String>`。`CommandError` 是 `commands/mod.rs` 中基于 `thiserror` 的枚举，按领域分变体（Serial / Config / Log / Storage / System / Lock / Io / Other），手动实现 `serde::Serialize` 让前端通过 `invoke` 收到错误字符串。

命令按领域拆分到 `src-tauri/src/commands/` 下的 6 个文件，`mod.rs` 统一 re-export。`src-tauri/src/system.rs` 包含 `win32_power` 模块（Win32 `SetThreadExecutionState` FFI），供 `system_cmds.rs` 调用。

### 组件拆分

| 目录 | 拆分前 | 拆分后 | 文件 |
|------|--------|--------|------|
| `ConfigModal/` | 724 行单文件 | 10 个文件 | `ConfigModal.tsx` + `RuleSetAccordion.tsx` + `pages/`（6 页）+ `editors/`（2 个编辑器） |
| `OperationPanel/` | 526 行单文件 | 4 个 section 组件 | `OperationPanel.tsx` + `SendSection` + `ParamsSection` + `RulesSection` |
| `MainDisplay/` | 359 行单文件 | 5 个文件 | `MainDisplay` + `Pane` + `TabBar` + `TerminalView` + `ResizeHandle` |
| `Sidebar/` | 626 行单文件 | 2 个文件 | `Sidebar.tsx` + `AliasDialog.tsx` |

### CSS 拆分

原 `styles.css`（约 1470 行）拆分到 `src/styles/` 目录：10 个按组件命名的 CSS 文件 + `base.css`（CSS 变量 / 主题 / 重置）。`src/styles.css` 仅保留 `@import` 入口。

---

## 关键开发约束（高频陷阱）

> 完整说明见 [`AGENTS.md`](AGENTS.md)。

### 1. Zustand 必须用选择器

状态分布在 4 个 store 中，每个 store 都必须用选择器按字段订阅：

```tsx
// ❌ 错误：订阅整个 store，每次串口事件都会触发 re-render，输入框失焦
const { ports, openTab } = useAppStore();

// ✅ 正确：按字段订阅
const ports = useAppStore(s => s.ports);
const baudRate = useOperationStore(s => s.baudRate);  // 注意：无 op 前缀
const terminals = useTerminalStore(s => s.terminals);
const highlightRuleSets = useRuleStore(s => s.highlightRuleSets);

// 在回调/effect 中需要最新值时用 getState()
useTerminalStore.getState().appendTerminalLine(portId, line);
const latest = useAppStore.getState().xxx;
```

### 2. React 组件必须定义在模块顶层

组件函数定义在父组件内部会在每次渲染时产生新引用，导致 DOM 销毁重建（输入框失焦）。

### 3. Flexbox 滚动链 — `min-height: 0`

终端能滚动的前提：**列方向所有 flex 祖先**都必须设置 `min-height: 0`。否则 flex 子元素的 `min-height: auto` 会撑爆容器。

### 4. Rust：禁止跨 `.await` 持有 `MutexGuard`

`std::sync::MutexGuard` 是 `!Send`，Tauri 异步命令的 Future 必须 `Send`。释放锁后再 `.await`：

```rust
// ✅ 先提取并 clone，再 drop 锁
let pool = {
    let mgr = state.storage_manager.lock().unwrap();
    mgr.pool().unwrap().clone()
};
some_async_fn(&pool).await;
```

### 5. 端口列表轮询 — `mergePorts` 保态

`useSerialPorts(3000)` 每 3 秒拉一次。`mapPortInfo()` 一律返回 `status: 'disconnected'`，必须用 `mergePorts()` 合并旧状态，否则连接态会被刷掉。

### 6. closeTab 必须经 `closePort()` 路由

关闭标签时必须走 `useSerialConnection.closePort()`，它会调用 `stopLogging` 并更新端口状态。直接从 store 移除标签会导致日志文件句柄泄漏、端口状态残留 "connected"。

### 7. TypeScript 严格模式

`tsconfig.json` 开启 `noUnusedLocals` 与 `noUnusedParameters` — 未使用变量是**编译错误**。

### 8. 后端命令返回 `CommandError`

所有 Tauri 命令返回 `Result<T, CommandError>`，不再返回 `Result<T, String>`。新增命令时在 `commands/mod.rs` 的 `CommandError` 枚举中选择合适的变体，或新增变体。

---

## 提交规范

```
type(scope): description

type:  feat | fix | docs | style | refactor | perf | test | chore
scope: ui | backend | store | hooks | plans
```

示例：

- `feat(backend): add sysinfo crate for process CPU/memory monitoring`
- `fix(ui): prevent port status overwrite on periodic poll`
- `refactor(store): split god store into 4 domain stores`
- `docs(plans): reorganize documentation into 9 files`

---

## 路线图

**已完成（参见 [`plans/06-status.md`](plans/06-status.md)）**：串口完整收发、分组拖拽、多分屏多标签、循环发送、语法高亮、6 页配置、SQLite 持久化、日志分片/多编码、虚拟滚动、文件导出、防休眠、暗/亮主题、vitest 测试基线。

**重构已完成**：

- ✅ **Store 拆分** — 单一 god store 拆为 4 个领域 store（useAppStore / useOperationStore / useTerminalStore / useRuleStore）
- ✅ **Hook 拆分** — `useSerialData` 拆为 `useSerialReceive` + `useSerialSend`，8 个 Hook 各司其职
- ✅ **组件拆分** — ConfigModal（724→10 文件）、OperationPanel（526→4 文件）、MainDisplay（359→5 文件）、Sidebar（626→2 文件）
- ✅ **后端命令拆分** — `commands/mod.rs` 拆为 6 个领域文件 + `CommandError` 枚举（thiserror）
- ✅ **CSS 拆分** — `styles.css`（1470 行）拆为 `styles/` 目录 11 个文件
- ✅ **GBK 解码修复** — 采用 `encoding_rs::GBK`，替代旧 U+FFFD 占位符方案
- ✅ **closeTab 生命周期** — 经 `closePort()` 路由，修复日志句柄泄漏

**进行中 / 计划中**：

- ⏳ **协议解析器** — 帧头/长度/校验/帧尾模板，自动字段着色
- ⏳ **多语言（i18n）** — `i18next` + `zh-CN` / `en-US`
- ⏳ **字体缩放** — 终端字号绑定 CSS 变量，支持 Ctrl+滚轮
- ⏳ **背景图片** — ConfigModal 已有路径选择，待应用到主窗口
- ⏳ **分屏嵌套（VS Code 风格）** — 当前 Pane 为平铺模型

完整待办见 [`plans/07-roadmap.md`](plans/07-roadmap.md)。

---

## 许可证

MIT License

## 贡献

欢迎 Issue 与 Pull Request。提交前请确保：

- `npx tsc --noEmit` 0 错误
- `cargo check --manifest-path src-tauri/Cargo.toml` 0 错误 0 警告
- `npm run test:run` 全部通过（71 cases）
- `cargo test --lib --manifest-path src-tauri/Cargo.toml` 全部通过（24 cases）
- 遵循 [`AGENTS.md`](AGENTS.md) 的开发约束
