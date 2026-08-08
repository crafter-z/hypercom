# TTY 模式（串口终端化）设计 · v2

> 状态：**已实现（M1–M3）** · 2026-08-08
> 实现进度：M1 模式状态+开关 ✅ · M2 xterm 视图+管线+git bash 模拟终端 ✅ · M3 快捷发送接入 ✅ · M4 可选打磨（未做）
> 场景：下位机是 Linux 设备，与上位机串口链路实际是 TTY（serial console / getty shell）。
> v2 变更：范围从「显示级 ANSI 上色」升级为**完整交互式终端**（vim/top 全屏应用、光标寻址、滚动区、备用屏幕），技术选型改为 **xterm.js**。TX 默认行为与真实 Linux Shell 一致（无本地回显，由对端 echo）。

---

## 0. 目标与非目标

### 目标
- 每个串口可在 **TRX**（现有逻辑，完全不变）与 **TTY**（全新逻辑）间手动切换，开关放控制面板。
- TTY 模式提供**完整交互式终端体验**：ANSI/VT100 全语义（颜色、加粗/下划线/反显、光标寻址、滚动区、备用屏幕、256/真彩色）、全屏应用（vim/top/htop）、行编辑、粘贴、尺寸协商。
- 默认行为与真实 Linux Shell 一致：**无本地 TX 回显**，命令由对端 echo 回来。
- 现有快捷发送（快捷发送条、命令面板、循环发送、批量发送）在 TTY 模式下继续可用。
- TTY 与 TRX 在**后端保持字节透明**、前端代码路径**低耦合**。

### 非目标（本阶段）
- 不做 TTY 自动检测——已确认手动开关。
- 不做远程 shell 的完整 PTY 进程管理（那是对端 getty 的事，本应用只搬字节）。
- 不做串口层的线路规程/调制解调器控制扩展（超出 TTY 终端语义）。

---

## 1. 核心设计原则

### 1.1 后端字节透明（最大解耦点）
串口本质是字节管道，TTY 的「终端语义」完全由前端 **xterm.js** 承担：
- RX：后端 `serial:data` 已按读取块吐原始字节流（`data: number[]`）→ 前端喂给 xterm。
- TX：`send_serial_data` 已支持任意字节写 → xterm 的 `onData` 输出 + 快捷发送复用。

**后端核心 I/O 零改动**。这是 TRX 与 TTY 解耦的根基：后端不分模式，只搬字节。

### 1.2 xterm.js = 终端模拟器
不再自研 ANSI 解析器（完整交互语义是多年级天坑）。xterm.js（VS Code 同款）是经检验的完整终端模拟器，自带：
- 屏幕缓冲 + 滚动区 + 备用屏幕（alternate screen，vim/top 所需）
- 全部 ANSI/VT100 序列、256/truecolor、样式
- 尺寸协商（对端 `\x1b[18t` 查询，xterm 经 `onData` 自动回尺寸）
- 自己的渲染器（canvas）与滚动——**完全不依赖**现有 `@tanstack/react-virtual` 行缓冲 → 天然满足解耦

### 1.3 前端两条并行管线
- TRX：现有 `RxLineAssembler` → `useTerminalStore` → `TerminalView`（**不动**）。
- TTY：新 `ttyService`/`ttyPipeline`（持有 xterm 实例）→ `TtyView`（xterm 宿主）。
- 两者各自独立，通过每端口 `mode` 在三个薄接缝处分流。

---

## 2. 依赖引入

```bash
npm install @xterm/xterm @xterm/addon-fit
# 可选：@xterm/addon-web-links（可点击链接）、@xterm/addon-search（终端内查找）
```

- `@xterm/xterm`：核心终端模拟器（`Terminal.write(data: string | Uint8Array)` 二进制安全，可直接喂原始字节）。
- `@xterm/addon-fit`：自动适配容器尺寸，全屏应用（vim/top）需要正确 cols/rows 才会触发对端清屏重绘。
- 版本与 `package.json` 同步；xterm 纯前端，无原生依赖，不影响 Rust 侧。

---

## 3. 模式状态（每端口）

- 新增类型 `PortMode = 'trx' | 'tty'`。
- 放 `useAppStore` 的 `Port` 上（`Port.mode`）：模式是端口级配置，随端口持久化。
- 持久化：进 `port_meta`（issue #4-9 现有机制）→ config.json，重启恢复。
- 动作：`useAppStore.setPortMode(portId, mode)`。
- 切换副作用（M1）：清空对应 TTY/RX 缓冲、flush 管线、detach/dispose xterm 实例，避免模式混合残留。

---

## 4. UI：开关位置（控制面板）

- 在 **OperationPanel 参数区（`ParamsSection.tsx`）** 加模式分段控件：`TRX` / `TTY`。
- 语义：模式是端口属性，放参数区与「连接参数」一致。
- i18n 新增 key：`params.mode` / `params.mode.trx` / `params.mode.tty`（zh-CN + en-US 双侧）。

---

## 5. TTY 前端管线（全新，与 TRX 解耦）

### 5.1 模块单例 `ttyService`（`src/services/tty.ts` 或 `src/utils/ttyPipeline.ts`）

镜像现有 `getRxPipeline()` 单例模式，每 webview 一个，持有 per-port 运行时状态：

```
interface TtyPort {
  term: Terminal;            // xterm 实例
  decoder: TextDecoder;      // 流式解码器（UTF-8/GBK/…，按端口 encoding）
  view?: TtyViewHandle;      // 挂载的视图句柄（attach/detach）
}
const ttyService = {
  get(portId): TtyPort | undefined,
  attach(portId, term),       // TtyView 挂载时注册
  detach(portId),             // TtyView 卸载时注销
  feed(portId, bytes, ts),    // RX 字节 → 解码 → xterm.write（rAF/visibility-aware 批写）
  clear(portId),              // term.clear() / reset
  disconnect(portId),         // flush + detach + dispose
};
```

**feed 流程**：
1. 校验端口处于 TTY 模式且已 attach。
2. 流式解码：`decoder.decode(bytes)`（`{stream:true}` 缓存，跨 chunk 保多字节字符完整；切换 encoding 时 reset decoder）。
3. 写 xterm：`term.write(decodedString)`，经 rAF 批写 + visibility-aware 调度（页面隐藏时 setTimeout 兜底，复用 rxPipeline 的调度机制）。
4. 队列上限：TTY 高频下队列设上限，防隐藏窗口无界积压。

### 5.2 TTY 视图 `src/components/MainDisplay/TtyView.tsx`（独立组件）

xterm 宿主组件，每端口一个：
- 创建 `Terminal`（配置：`fontFamily` monospace、`theme` 取自应用 CSS 变量、`scrollback` 适量、`convertEol` 等），`term.open(containerRef)`。
- 加载 `FitAddon`，用 ResizeObserver 随容器尺寸 `fit()`（保证 vim/top 拿到正确 cols/rows）。
- 挂载时 `ttyService.attach(portId, term)`；卸载时 `ttyService.detach(portId)`。
- **TX 接通**：`term.onData(str => 发送到端口)`——用户键入/粘贴 → 编码为端口 TX 字节 → `send_serial_data`。**这同时完成尺寸协商**（对端 `\x1b[18t` 查询，xterm 经 onData 自动回尺寸）。
- 与 `TerminalView` 不共享状态，独立组件。

### 5.3 TX：TTY 发字符

- 手动输入：`term.onData` → 字节发送（UTF-8 编码，与真实 shell 一致；端口 TX 编码 GBK 需求另议）。
- **无本地回显**：xterm 默认不做本地 echo，命令由对端 shell echo 回来 → 默认行为 == 真实 Linux Shell。无需回显开关。
- 特殊字节（Ctrl+C …）：xterm 已按标准映射，`onData` 输出即字节。

### 5.4 编码

- RX：按端口 `encoding`（UTF-8/GBK/…）流式解码后写 xterm（保持 app 多编码能力）。
- TX：默认 UTF-8（Linux shell 惯例）；GBK TX 为后续可选。

---

## 6. 快捷发送在 TTY 模式下可用

- 现有快捷发送条 / 命令面板 / 循环发送 / 批量发送都经 `sendToPort`（`useSerialSend`）→ `send_serial_data`。这条 TX 路径**模式无关**（字节直发）→ 天然复用，UI 零改动。
- `sendToPort` 增加**模式感知分支**（一个函数内，薄适配）：
  - TTY 模式：**跳过 TX 回显**（远端 echo，避免重复）→ 只发字节 + 更新流量统计/发送历史。
  - TRX 模式：现有逻辑不变。
- 命令 `appendLineEnding` 默认 `\r`（shell 回车）由命令集配置决定，不改代码。
- 时序：TTY 模式无 TX 回显行，无需像 TRX 那样 `flushNow` 排 RX 队列；命令发出后由对端 echo 进 xterm，天然有序。

---

## 7. 与 TRX 模式的解耦边界

| 层 | 处理 | 耦合度 |
|----|------|--------|
| 后端 | 不引入 I/O 模式分支（字节透明） | 零耦合 |
| RX 管线 | TTY 走 `ttyService`，不触碰 `RxLineAssembler`/`rxPipeline` | 零耦合 |
| 渲染 | `TtyView`（xterm）独立组件，与 `TerminalView` 不共享状态 | 零耦合 |
| 存储 | 模式在 `Port`（useAppStore）；xterm 实例在 `ttyService` 单例；无需新增 store | 低 |
| **接缝（唯一耦合点）** | ① `useSerialReceive.onSerialData` 按 `port.mode` 分流到 rxPipeline 或 ttyService；② `sendToPort` 按模式回显/时序；③ Pane 渲染按 `port.mode` 渲染 TerminalView 或 TtyView | 薄适配层 |

三处接缝是薄适配层，其余完全独立。任何新增 TTY 逻辑**不得**触碰 TRX 的 store/管线/视图。

---

## 8. 后端改动（最小）

核心 I/O 零改动，仅一处可选小改：
- **日志**：TTY 模式 RX 日志若沿用 `LogLineAssembler`（CR 当换行）会剁碎终端序列。建议新增 `set_port_mode(port_id, mode)` 命令，AppState 记 per-port 模式；RX 日志线程据此对 TTY 端口**原始字节落盘**（保真、可回放），TRX 端口维持行组装。
- 若日志不需要区分，可整个省去。

建议本阶段仅做日志适配（若需要），其余不动。

---

## 9. 调试验证：模拟终端（git bash，仅 debug）

> 目的：无硬件环境下验证 TTY 前端正确性。**复用现有 SIM 调试门控模式**——前端 `import.meta.env.DEV` 隐藏 UI（`src/utils/devMode.ts`）+ 后端 `cfg(not(debug_assertions))` 命令报错，仅 `npm run tauri dev` 可用，release 天然不带功能及相关代码。

### 9.1 核心判断：必须用伪终端（pty），不是普通管道
- 要验证 TTY 模式的**交互式渲染**（readline 行编辑、颜色、vim、任务控制），git bash 必须跑在真实 TTY 上。
- 仅 `std::process` 管道（stdin/stdout 接 pipe）会让 bash 进入**非交互模式**：无提示符、无方向键编辑、不自动上色、不能跑 vim → 验证不了目标。
- 正确做法：后端用 **ConPTY**（Windows 伪终端）spawn `bash.exe`。Rust 库 `portable-pty`（wezterm/alacritty 同款：Windows 走 ConPTY、Unix 走 forkpty），即 Windows Terminal/VS Code 跑 bash 的方式。
- 依赖：新增 `portable-pty`（Rust，可做可选依赖 / `#[cfg(debug_assertions)]` 门控，release 剔除）。

### 9.2 架构（复用现有 SIM 虚拟端口机制）
```
[git bash.exe] ←pty→ [Rust ConPTY] ←→ 虚拟串口 serial:data / send_serial_data ←→ 前端 TTY 管线
```

- **后端**（debug-only，仿 `commands/simulation.rs`）：新增 `enable_gitbash_sim` / `disable_gitbash_sim` 命令，`portable-pty` spawn `bash.exe`，作为「虚拟串口」——pty 读线程吐字节 → `serial:data`（RX）；`send_serial_data` → pty stdin（TX）。**复用现有 SIM 虚拟端口的读线程 + 通道架构**，把 loopback 换成 pty；release（`cfg(not(debug_assertions))`）命令直接报错。
- **前端**（`DEV_FEATURES_ENABLED` 门控）：sidebar 工具栏加「模拟终端」按钮（类似现有 flask SIM 按钮），一键添加 `GIT-BASH` 虚拟端口；用户切到 TTY 模式即可交互。
- **release 排除**：pyt/pty 模块 `#[cfg(debug_assertions)]` 门控；前端 `import.meta.env.DEV` 不渲染 UI；`portable-pty` 可选依赖剔除。

### 9.3 验证覆盖
- 真实 shell 的：颜色/加粗/反显、光标寻址、滚动区、备用屏幕（vim/top/htop）、readline 编辑与粘贴、尺寸协商（`\x1b[18t` 查询）、快捷发送（命令 + `\r`）注入 shell。
- 与 TRX 模式对比：同一虚拟端口切 TRX 走现有管线，验证分流正确。

---

## 10. 里程碑

- **M1：模式状态 + UI 开关**。`Port.mode`、`setPortMode`、`ParamsSection` 开关、i18n、持久化（port_meta）、TRX/TTY 分流占位。
- **M2：TTY 视图 + 管线**。引入 `@xterm/xterm` + `@xterm/addon-fit`；`ttyService`（attach/feed/clear/disconnect）；`TtyView` 挂载 + FitAddon 自适应；`useSerialReceive` 分流接线；手动输入（`onData`→发送）打通。**并行实现 §9 模拟终端（git bash pty）作为验证工具**，验证 vim/top 全屏 + 配色 + 尺寸协商。
- **M3：快捷发送接入**。`sendToPort` 模式感知分支（TTY 无回显）；快捷发送条/命令面板/循环/批量在 TTY 模式（用 §9 模拟终端）验证。
- **M4（可选）**：备份屏幕/滚屏区高级交互打磨、GBK TX、`@xterm/addon-search`、链接识别、日志原始字节回放。

---

## 11. 风险与决策点

- **xterm 与现有渲染架构关系**：xterm 自带渲染器与滚动，**取代** TTY 端口的 TerminalView——这是特性而非缺陷（最大化解耦）。TRX 端口完全不受影响。
- **性能**：高速 TTY 下逐字节解码 + xterm 渲染；复用 rAF 批写 / visibility-aware 调度 + 队列上限，防隐藏窗口积压。
- **编码边界**：xterm 内建 UTF-8。GBK RX 需流式转码（已设计）；GBK TX 为 M4 选做。
- **模式切换残留**：切换时清空缓冲 + flush + detach/dispose xterm，避免 TRX 行与 TTY 行混染。
- **尺寸协商**：依赖 FitAddon 随容器尺寸 `fit()`；容器尺寸变化时 xterm 经 onData 通知对端，全屏应用据此重绘。分屏拖拽/面板缩放时需触发 refit。
- **依赖成本**：xterm.js 纯前端、无原生依赖，体积适中，不影响 Rust 侧与打包。