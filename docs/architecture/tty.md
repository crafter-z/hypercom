# TTY 终端模块

完整交互式终端模式（issue #11）。TRX=行级终端（terminal.md）；TTY=xterm.js 渲染完整终端流（真实 ANSI/VT100、光标、备用屏幕 vim/top、onData 尺寸协商，**无本地回显**由对端 echo）。场景：下位机是 Linux 设备，串口链路实际是 TTY（serial console / getty shell）。

## 核心设计原则

- **后端字节透明（最大解耦点）**：串口是字节管道，「终端语义」完全由前端 xterm.js 承担——RX 后端 `serial:data` 已按读取块吐原始字节流，TX `send_serial_data` 已支持任意字节写。**后端核心 I/O 零模式分支**。
- **xterm.js = 终端模拟器**（VS Code 同款）：自带屏幕缓冲/滚动区/备用屏幕/全部 ANSI 序列/尺寸协商/自有 canvas 渲染器——完全不依赖现有行缓冲渲染架构。
- **前端两条并行管线**：TRX 走 `RxLineAssembler`→viewportManager→TerminalView（不动）；TTY 走 `ttyService`（持有 xterm 实例）→`TtyView`。两者经每端口 `mode` 在**三个薄接缝**处分流。

## 模式状态与切换

- `PortMode = 'trx' | 'tty'`，放 `useAppStore` 的 `Port.mode`，经 `port_meta`（config.json）持久化——Rust `PortMetaEntry` 必须带 `#[serde(default)] mode: Option<String>`（曾因缺字段被 serde 静默丢弃、重启全回退 TRX），`validate_and_clamp` 钳制非 trx/tty 值回 trx。
- 切换控件：OperationPanel→ParamsSection 分段控件（`.segmented` 复刻 TerminalFilterBar），i18n `params.mode.*`。
- **切换副作用**：清 TerminalStore + `getRxPipeline().flushAndReset` + `ttyService.clear`——避免旧模式 buffered 数据混入新模式首屏。

## ttyService（模块单例，镜像 getRxPipeline 纪律）

`src/utils/ttyService.ts`，每 webview 一个，每端口运行时状态：

```
serial:data（TTY 端口，useSerialReceive 分流）
  → 流式 UTF-8 解码（TextDecoder('utf-8',{stream:true}) 缓冲跨事件多字节字符；仅 UTF-8，TRX 的多编码切换不适用 TTY）
  → 每端口队列（上限 MAX_TTY_QUEUE 10000，丢最旧）
  → visibility-aware 批写 term.write（页面可见 rAF、隐藏 setTimeout(16ms) 兜底）
```

API：`attach`/`detach`/`feed`/`clear`/`disconnect`（断线 flush 保留 term 跨重连）/`send`（onData→send_serial_data，失败仅 console.error 不弹 toast）/`resize`（仅 GIT: 走后端 pty resize）。

- `disconnect` **重建 decoder**（断线残留的半截多字节字符会在重连后与首字节拼错）；`detach` **保留 lastCols/lastRows**（切走标签再重开不再回退 80×24）。
- `feed` 对「无标签页且未 attach」丢弃（挂载前首帧窗口仍入队等 attach replay）。
- 生命周期纪律：`dispose()`/`reset()` 仅测试用，应用生命周期不得调用。

## TtyView（xterm 宿主）

- Terminal + FitAddon fit（ResizeObserver + rAF 防抖）；onData→`ttyService.send`、onResize→`ttyService.resize`。
- **字体/字号经 `term.options` 活更新不重建 Terminal**（挂载 effect 依赖仅 `[portId]`；曾依赖含 terminalFont/Size 导致改动即 dispose 清空缓冲）。
- Ctrl+滚轮缩放（8–48px，镜像 TerminalView）。
- **会话跨标签保留**：Pane 对当前 Pane 内**所有 TTY 标签常驻挂载**（`key={tab.id}` 稳定），非活动标签传 `hidden` → `.tty-view-hidden`（display:none），恢复可见显式 rAF re-fit——xterm 缓冲在实例内，切标签销毁实例即丢会话。
- **销毁时机（仍然销毁实例）**：模式切换、关闭标签、跨 Pane 拖拽（xterm `open()` 只能调用一次）。
- TTY 端口阻止弹出窗（`Pane.handlePopOut` 提示 `tty.popoutUnsupported`——弹出窗是独立 webview 不共享 ttyService/xterm 实例）。

## TX 路径

- 手动输入：`term.onData` → 字节发送（UTF-8；xterm 已按标准映射 Ctrl+C 等特殊字节）。**无本地回显**——对端 shell echo，本地再插 TX 行既重复又破坏终端流。
- 快捷发送/命令面板/循环在 TTY 下可复用：`sendToPort` TTY 分支跳过 TX 回显与 `flushNow`（仍走后端发送/流量统计/历史）；命令 `appendLineEnding` 由命令集配置，但**后端做回车归一**（见下）。

## 回车归一（GIT:BASH 快捷发送多执行一行空命令）

pty 行规程（ICRNL）把 `\r` 转成 `\n`，`\r\n` 会变成两个换行——bash 执行完命令还多收到一个空行。`SerialManager::send_data` GIT: 分支 `normalize_tty_line_ending`：`\r\n` → `\r`（真实终端 Enter，ICRNL 转回单个 `\n`），`\r`/`\n`/`None` 原样保留；覆盖快捷发送/循环/触发自动回复/弹出窗全部 TX 路径（均经 send_data）；`build_tx_bytes` 与日志字节同步归一。

## 与 TRX 的解耦边界

| 层 | 处理 | 耦合度 |
|----|------|--------|
| 后端 | 不引入 I/O 模式分支（字节透明；GIT: 虚拟端口有归一） | 零耦合 |
| RX 管线 | TTY 走 `ttyService`，不触碰 RxLineAssembler/rxPipeline | 零耦合 |
| 渲染 | `TtyView` 独立组件，与 TerminalView 不共享状态 | 零耦合 |
| 存储 | 模式在 `Port`（useAppStore）；xterm 实例在 ttyService 单例 | 低 |
| **接缝（唯一耦合点）** | ① `useSerialReceive.onSerialData` 按 `port.mode` 分流到 rxPipeline 或 ttyService；② `sendToPort` 按模式回显/时序；③ Pane 渲染按模式渲染 TerminalView 或 TtyView | 薄适配层 |

## 模拟终端（GIT:BASH，仅 debug）

- 调试专用虚拟串口（issue #11）：`portable-pty` 0.9（Windows = ConPTY）spawn 本地 git bash pty，pty stdout→`serial:data`（RX）、`send_serial_data`→pty stdin（TX）。
- **必须用 pty 而非普通管道**：仅 `std::process` 管道会让 bash 进入非交互模式（无提示符/方向键编辑/自动上色/不能跑 vim）——验证不了 TTY 目标。
- `TtySimPortHandle`（writer/master/child/读线程）；`find_bash` 查 PATH + 常见 Git 安装路径。
- **打开时携带前端 xterm 尺寸**（`OpenPortArgs.cols/rows`，spawn 即正确尺寸，否则 pty 固定 80×24 致 vim/top 全屏错乱）+ 连接后 `ttyService.resync` 保险；**读线程应答 DSR**（`\x1b[6n`→`\x1b[1;1R`，`scan_dsr` 跨 chunk 检测）——bash/readline 启动时阻塞等终端应答，TRX 模式无终端模拟器，后端不应答则命令全部不执行；应答 **`\x1b[1;1R`（新建会话真实光标位置）而非终端尺寸**——按尺寸应答会把提示符画到右下角「命令行未正确显示」；TTY 模式由 xterm 自动应答，前端 TtyView 对 GIT: 端口过滤 xterm 应答防双响应。
- 断线关闭 drop master（ClosePseudoConsole → 读线程解除阻塞）+ `close_serial_port` 异步 join；`disable_gitbash_sim` 同样 async + `spawn_blocking` join（曾同步 join 阻塞主线程）。
- **双层门控**：前端 `import.meta.env.DEV` 隐藏（`useGitBashSim` 镜像 useSimulation）+ 后端 `cfg(not(debug_assertions))` 命令拒绝；release 天然不带功能及相关代码。

## 已知边界（文档化而非缺陷）

- RX 解码仅 UTF-8（TRX 的 GBK 等多编码切换不适用于 TTY 字节流）。
- 残余销毁场景：模式切换/关闭标签/跨 Pane 拖拽仍销毁 xterm 实例（open() 一次性）。
- 日志：TTY 端口 RX 若沿用 LogLineAssembler（CR 当换行）会剁碎终端序列——当前按既有日志管线落盘，原始字节保真回放未实施（M4 选做）。
