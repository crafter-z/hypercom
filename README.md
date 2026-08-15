# HyperCom

一款现代化的串口调试工具，基于 **Tauri v2 + React 18 + Rust** 构建，面向嵌入式开发场景。

> 核心理念：**Rust 处理底层性能，React 负责 UI 交互**。

![HyperCom UI](plans/UI.png)

> **Developer reference**: see [`AGENTS.md`](AGENTS.md) for architecture, code map, and gotchas.

---

## 功能特性

### 串口与连接
- 🔌 **自动枚举** — 每 3 秒刷新，`mergePorts` 保留连接态、别名、分组
- 🧪 **模拟串口** — `SIM:Loopback` 虚拟端口，无硬件调试；另有调试专用 **GIT:BASH 模拟终端**（git bash pty，仅 `npm run tauri dev` 可用，用于无硬件验证 TTY 模式）
- ⚙️ **完整参数** — 波特率（含自定义）、数据位、停止位、校验位、流控、DTR/RTS
- 🗂️ **分组管理** — 自定义分组、备注名、搜索过滤、跨组拖拽排序；串口右键一键移入/移出分组或新建分组并移入，按端口号一次性排序

### 终端与显示
- 📑 **多标签 + 分屏** — 上下/左右分屏、跨 Pane 拖拽、`@dnd-kit` 排序
- 🖥️ **TTY 终端模式** — 端口可切到 xterm.js 完整交互终端（真实 ANSI/VT100、光标、备用屏幕 vim/top、尺寸协商），无本地回显由对端 echo；模式经 `port_meta` 持久化（`OperationPanel → 参数` 分段控件切换）；**会话跨标签保留**（切标签不丢终端缓冲，非活动标签隐藏常驻，恢复自动重排尺寸）
- ⏪ **日志回放** — 按原始时间戳写回终端，倍速可选（1/4/16/最快）
- ⚡ **虚拟滚动** — `@tanstack/react-virtual`，DOM 约 30–50 节点
- 🧩 **RX 行聚合** — 字节级 CR/LF/CRLF 切行 + rAF 批写，跨事件响应不再碎成多行；写量限制（每帧每端口 2000 行封顶）与内存预算裁剪（超限自动清掉最早一半）防长时间运行内存暴涨；窗口最小化/隐藏时以 setTimeout 兜底排空（不依赖 rAF），每端口队列设上限防隐藏期间无界积压
- 📌 **滚动锁定 + 快捷跳转** — 显式意图锁定（不再被输出顶开），滚动条两端一键到顶/到底；跟随路径双 rAF 测量钉底，高频输出不掉位
- 🎨 **语法高亮** — 正则 / 关键词规则集，可配置颜色、加粗、斜体
- 📅 **时间戳 / TX·RX 着色** — 多种格式、字符串/HEX/二进制切换（per-tab）
- 🌐 **编码实时切换** — UTF-8 / GBK / ISO-8859-1 / ASCII，切换时自动重解码
- 🌗 **暗色 / 亮色 / 跟随系统** — CSS 变量主题

### 收发与命令
- ✉️ **手动发送** — 字符串 / HEX（双向转换、输入净化）/ 自定义行结束符
- 🔀 **读写句柄独立** — 发送与接收各占独立句柄（try_clone），发送阻塞不再影响接收读取，设备响应即时上屏；热路径不再等待物理发完（移除无界 flush），写入带总期限保护
- ⚡ **快捷发送条** — 宽度自适应，pill 两行显示名称（含 HEX 徽标）与内容，首槽「打开命令面板」为按压按钮样式，溢出收进 `⋯ +N`
- 🪟 **命令面板** — 列表 / 文本双模式：列表模式支持行内编辑（名称/内容/行结束符/STR·HEX 直接落盘），文本模式大文本域逐行发送（当前行 / 全部顺序 / 从光标 / 循环至停止 / **执行当前行并移至下一行**）；目标串口下拉只显示串口号，底栏「发送到」提示灯跟随真实连接状态（绿=连接 / 灰=断开）
- 🚫 **未连接提醒** — 发送目标端口未打开时弹警告 toast；循环发送 / 触发自动回复静默跳过，不打断流程
- 📝 **发送历史** — 会话内存态（每端口 50 条），↑/↓ 键回溯
- 🔁 **循环发送** — 命令集顺序执行、单条延时、整体 `loopDelay`；**每端口独立**（issue #12）——在哪个端口启动就一直发给它，切换聚焦/标签不中断，多端口可并行灌数据，目标端口断开自动跳过等重连
- 📦 **命令集编辑器** — config.json 持久化，可配类型、内容、行结束符、延时
- 📤 **文件发送** — 分块发送 + 实时进度条
- 🔢 **批量发送** — 指定重复轮数（0=无限），逐条延时

### 日志与导出
- 📝 **自动日志** — 每端口独立 `BufWriter`，连接即写、断开 `sync_all`
- 📁 **子目录组织** — 按日期 / 按端口自动归档子目录（`none/date/port`），多端口日志不再平铺
- 🪓 **分片续写** — 按大小阈值切片，文件名模板支持变量
- 🌐 **多编码** — UTF-8 / GBK / ISO-8859-1 / ASCII
- 💾 **数据导出** — 右键导出 TXT/CSV 真实文件
- 📂 **另存 / 打开文件 / 打开目录** — `canonicalize` 作用域校验

### 系统与配置
- 📊 **资源监控** — `sysinfo` CPU + **软件自身进程级**内存采样（本进程 + 含 WebView2/Chromium 的后代进程 RSS 之和），配合应用级内存总预算软兜底
- 🧩 **分组整组执行工具** — 分组右键对组内端口跑外部工具（**并行启动**所有已配置端口），未配置端口可一键跳转补齐
- 🛠️ **9 页配置弹窗** — 通用、日志、备份、显示、高亮规则、命令规则、协议模板、外部工具、条件触发
- 🔄 **配置版本化** — `config_version` + `migrate()`，前向兼容
- 🎯 **配置路径** — CLI `--config` / `HYPERCOM_CONFIG` env / portable 模式
- ✅ **字段校验** — `validate_and_clamp()` 强制边界
- 💾 **备份/恢复** — `.bak` 自动备份，损坏时回退恢复
- 🔋 **防休眠** — 跨平台（Win32 / macOS `caffeinate` / Linux `systemd-inhibit`）
- ⚡ **条件触发器** — 接收匹配（包含/精确/正则/HEX）→ 自动回复 / 弹窗告警；告警展示规则内容，编辑 300ms 自动落盘
- 🔔 **通知中心** — 触发告警为粘滞通知（不自动消失），超出屏幕数量的通知进溢出队列不丢失；串口来源消息携带**串口号**与**时间戳**，铃铛一键查看/清空
- 🖱️ **自定义右键菜单** — 输入框/文本域右键显示应用自定义菜单（撤销/重做/剪切/复制/粘贴/全选），主窗与独立窗口一致
- 🐛 **诊断日志** — 前后端 `log`/`console` 统一落盘（512KB 轮转），「关于 → 诊断日志」查看/过滤/导出/清空，可配置开关
- 🔄 **自动更新** — 通道运行时用户选择：设置项「不检查 / 定期到正式版 / 定期到 preview」（7 天周期）；发现更新弹窗三动作（立即更新带进度 / 7 天后提醒 / 永不提醒同步设置）；About 手动检查可选正式版/preview；stable 直连 GitHub 最新正式版、preview 经 GitHub API 解析最新 preview tag（唯一 tag，互不污染）
- 📌 **窗口置顶** / ℹ️ **关于** / 📤 **配置导出导入** / ⭐ **端口预设** / 🧰 **系统托盘**

---

## 技术栈

### 前端

| 包 | 版本 | 用途 |
|----|------|------|
| `react` / `react-dom` | ^18.3.1 | UI 框架 |
| `typescript` | ^5.6.3 | 类型系统 |
| `vite` | ^5.4.10 | 构建工具 |
| `zustand` + `immer` | ^5.0.13 / ^11.1.6 | 状态管理（4 store） |
| `@dnd-kit` | ^6.3.1 | 拖拽（侧边栏、标签页） |
| `@tanstack/react-virtual` | ^3.13.15 | 终端虚拟滚动 |
| `@xterm/xterm` / `@xterm/addon-fit` | — | TTY 模式完整终端（ANSI/VT100、备用屏幕、尺寸协商） |
| `@tauri-apps/api` | ^2.0.0 | Tauri 桥接 |
| `@tauri-apps/plugin-dialog` / `shell` | ^2.7.1 / ^2.0.0 | 文件对话框 / 外部链接 |
| `@tauri-apps/plugin-process` / `plugin-updater` | ^2.x / ^2.10 | 自动更新 relaunch / 更新器（issue #12） |
| `lucide-react` | ^1.14.0 | 图标 |
| `vitest` | ^4.1.7 | 单元测试 |

> 全局 CSS Variables，按组件拆分到 `src/styles/`（10 组件 CSS + `base.css`），无 CSS-in-JS。

### 后端

| Crate | 版本 | 用途 |
|-------|------|------|
| `tauri` | 2.11 | 桌面框架 |
| `serialport` | 4 | 串口 I/O |
| `tokio` | 1 (full) | 异步运行时 |
| `sysinfo` | 0.33 | CPU / 内存采样 |
| `serde` / `serde_json` | 1 | 序列化 |
| `encoding_rs` | 0.8 | GBK 等多编码解码 |
| `portable-pty` | 0.9 | 调试专用 GIT:BASH 模拟终端（Windows = ConPTY） |
| `tauri-plugin-updater` / `process` | 2.10 / 2 | 自动更新（issue #12）：运行时通道选择 + relaunch |
| `reqwest` | 0.13 (rustls) | 自动更新 preview 通道 GitHub API 解析（issue #12） |
| `chrono` / `dirs` / `uuid` | — | 时间 / 目录 / ID |
| `thiserror` | 1 | `CommandError` 枚举 |

> `@tauri-apps/api`（npm）与 `tauri`（Cargo）次版本必须一致，当前均为 **2.11.x**。

---

## 快速开始

### 环境要求

| 项 | 版本 | 说明 |
|----|------|------|
| **Node.js** | ≥ 18 | 前端构建 |
| **Rust** | stable | [rustup](https://rustup.rs/) |
| **VS Build Tools** | 2019+ | 「使用 C++ 的桌面开发」 |
| **WebView2** | — | Win11 自带；Win10 [手动安装](https://developer.microsoft.com/microsoft-edge/webview2/) |

### 安装与开发

```bash
npm install
npm run tauri dev
```

> PowerShell 执行策略阻塞时：`cmd /c "npm run tauri dev"`

### 生产构建

```bash
npm run tauri build
```

产物：`src-tauri/target/release/bundle/` (MSI + NSIS)

### 检查与测试

```bash
npx tsc --noEmit                                       # TypeScript
cargo check --manifest-path src-tauri/Cargo.toml       # Rust
npm run test:run                                       # vitest (530 cases / 27 files)
cargo test --lib --manifest-path src-tauri/Cargo.toml  # Rust 单元测试 (112 cases)
npx playwright test                                    # E2E 冒烟 (14 tests)
```

---

## 使用说明

1. **连接**：侧边栏选串口（或启用 `SIM:Loopback`）→ OperationPanel 配参数 → 点连接
2. **收发**：发送区输入字符串/HEX → Enter 发送（设置可改为 Enter 插入换行）；Shift/Ctrl+Enter 始终换行；↑/↓ 回溯历史
3. **循环发送**：选命令集 → 启动；每条可配 `delay`，整体 `loopDelay`；循环按端口独立运行（切换聚焦不影响，多端口可并行）
4. **分屏**：TabBar 右端分屏按钮 → 拖拽标签移动
5. **规则**：配置弹窗 → 高亮/命令规则标签页 → config.json 持久化
6. **日志**：连接即自动写日志；回放/另存/导出在 OperationPanel 顶栏

详细数据流见 [`plans/04-data-flow.md`](plans/04-data-flow.md)。

---

## 许可证

MIT License

本项目依赖的第三方开源项目及其许可证见 [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)（或应用「关于」界面「开源许可证」按钮）。

## 贡献

欢迎 Issue 与 Pull Request。提交前请确保：

- `npx tsc --noEmit` 0 错误
- `cargo check --manifest-path src-tauri/Cargo.toml` 0 错误 0 警告
- `npm run test:run` 全部通过
- `cargo test --lib --manifest-path src-tauri/Cargo.toml` 全部通过
- 遵循 [`AGENTS.md`](AGENTS.md) 的开发约束
