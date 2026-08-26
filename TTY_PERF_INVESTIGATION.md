# TTY 模式交互卡顿 — 性能诊断报告（只读探查，未改任何代码）

> 日期：2026-08-26 · 范围：`src/utils/ttyService.ts`、`src/components/MainDisplay/TtyView.tsx`、`src/hooks/useSerialReceive.ts`、`src/hooks/useSerialSend.ts`、`src/services/tauri.ts`、`src-tauri/src/commands/serial.rs`、`src-tauri/src/serial/mod.rs`、`src-tauri/src/serial/tty_sim.rs`、`src-tauri/src/commands/system_cmds.rs`、`@xterm/xterm@6.0.0`（node_modules 源码）、`tauri@2.11.1`/`wry@0.55.1`（cargo registry 源码）、运行诊断日志 `%APPDATA%/hypercom/diag/hypercom-debug.log`。

## 1. 症状与复现路径

- 症状：TTY 模式下，输入回车后**过几秒钟才有响应**；输入 `ls`，几秒钟后 `ls` 及输出才出现在终端（TTY 无本地回显，显示的是对端 echo）。
- 复现环境推测（据 diag 日志）：GIT:BASH 模拟终端（2026-08-08/09 会话）或真实串口（设备为 shell/getty）；近期（08-22）另有 SIM:Loopback 周期输出 100–200/s 的压测会话。
- 触发条件未知，未能在本机复现（未运行应用，仅静态分析 + xterm 运行时微测）。

## 2. 数据流梳理

### TX 链路（按键 → 对端 shell）

```
按键 → xterm onData（TtyView.tsx:76-82，每按键一次，无节流/合并）
  → ttyService.send（ttyService.ts:225-250）→ invoke send_serial_data（每按键 1 次 IPC 往返）
  → async 命令 + spawn_blocking（commands/serial.rs:118-188）
  → 全局 serial_manager 锁（仅取写句柄克隆）→ 锁外 per-port 写锁
  → write_all_with_deadline（serial/mod.rs:257-287，单次 WriteFile ≤100ms，总期限 2s）
  → 驱动 TX 缓冲 → 设备
```

开销点：每次按键 1 次 IPC 往返（~1-5ms 空闲时）；**后端写阻塞时单次按键可卡 100ms–2s**；**后端主线程被其它同步命令占用时，invoke 排队等待**。

### RX 链路（对端 echo → xterm 显示）

```
设备 → OS 接收缓冲 → 读线程（serial/mod.rs:544-608，1024B 缓冲，读即返回）
  → emit_data_event（:327-358）：JSON 序列化（data: number[]，每字节一个数字）+ app.emit + 日志写
  → Tauri 事件注入（tauri event/mod.rs emit_js_script：payload 内联进 JS 代码串）
  → wry ExecuteScript（wry webview2/mod.rs:1321-1338）→ 页面主线程执行回调
  → useSerialReceive（useSerialReceive.ts:67-75）：每事件 setTrafficStats（React store 更新）+ ttyService.feed
  → TextDecoder 流式解码 → 每端口队列 push（ttyService.ts:186-208）
  → rAF 批写（scheduleFlushFor :113-125）→ flushState（:99-105）→ term.write(queue.join(''))
  → xterm v6 WriteBuffer：**异步分片解析**（空缓冲 setTimeout 启动；每片 12ms 预算、setTimeout 续片；node_modules lib/xterm.mjs WriteBuffer，常量 El=12 / bc=50）
  → xterm 渲染（自身 rAF）→ 屏幕
```

开销点：每事件一次 JSON.parse + 一次 React store 更新（StatusBar 重渲染）；rAF 批写 ≥1 次 macrotask 延迟；**页面主线程繁忙时 ExecuteScript 排队等待，RX 事件无法投递**。

## 3. 逐环节嫌疑分析（文件+行号证据）

### 3.1 后端事件循环主线程被两个「同步轮询命令」周期阻塞 ★

`#[tauri::command]` **同步命令在事件循环主线程执行**——这是项目自己的教训（AGENTS.md issue #6-1 原文：`send_serial_data` 旧实现"同步命令在事件循环主线程上同步执行…每次发送都无条件卡顿"，故改 async + spawn_blocking）。但以下两个周期轮询仍是同步命令：

| 命令 | 频率 | 主线程内做了什么 |
|---|---|---|
| `get_system_status`（system_cmds.rs:57，同步 `pub fn`） | **每 5s**（useSystemStatus.ts `setInterval(5000)`） | `system.refresh_processes_specifics(ProcessesToUpdate::All, true, with_memory().with_cpu())`（:74-77）——**枚举刷新全系统进程表**（数百进程）+ 每进程内存/CPU 采样；再加 `collect_app_pids` 全表扫描（:38-53） |
| `list_available_ports`（commands/serial.rs:15，同步 `pub fn`） | **每 3s**（useSerialPorts.ts 默认 3000） | `serialport::available_ports()`（serial/mod.rs:411）——Windows 上枚举注册表/SetupAPI 串口 |

阻塞期间：所有 invoke（含**每次按键的 send_serial_data**）排队；用户按键无响应；阻塞结束积压请求一次性处理。「几秒钟没反应、随后突然全出来」与此机制吻合（慢机/进程多时单次可数百 ms；若两命令叠加或负载高可更久）。**该问题与模式无关**，但 TTY 交互（逐键 invoke）比 TRX（整行发送）暴露更明显。

### 3.2 TX 写阻塞：WRITE_TOTAL_DEADLINE=2s 兜底在流控/驱动卡住时把每次按键拖到秒级

`write_all_with_deadline`（serial/mod.rs:257-287）：Windows 每次 `WriteFile` 受 `WriteTotalTimeoutConstant=100ms` 约束（serialport crate com.rs:272-281 实测 `set_timeout` 配置，`WriteTotalTimeoutConstant=timeout_constant`）；写不进（CTS 拉低/驱动 FIFO 满/XOFF）时 100ms 超时重试直到 2s 总期限（`WRITE_TOTAL_DEADLINE`，serial/mod.rs:257-260），`Ok(0)` 立即报错。命令层在 spawn_blocking 里执行（commands/serial.rs:132-171），**不占主线程但按键 invoke 的 Promise 要等到写完成才 resolve**。TTY 交互：粘贴大文本、快捷键序列、低波特率（9600 下 1KB≈1s 物理传输）时，单次/连续按键累计秒级延迟；且 shell 收到全部字节后才 echo → 「过几秒 ls 才显示」。**反证**：diag 日志 08-09 GIT:BASH 会话无 "Failed to send data" 记录（写未触 2s 限）；该机制同样影响 TRX（非 TTY 独有）。

### 3.3 前端主线程过载：每事件 React 更新 + xterm v6 异步分片解析

- `useSerialReceive` 对**每个** `serial:data` 事件调用 `setTrafficStats`（useSerialReceive.ts:67-69）→ Zustand 更新 → StatusBar（订阅 `trafficStats`，StatusBar.tsx:51）**每事件重渲染**。高事件率（SIM 周期输出 200/s、突发数据）下形成持续主线程负载。
- `term.write` 在 xterm v6 **不是同步解析**：空缓冲时 `setTimeout(() => _innerWrite())` 启动，每片 12ms 预算、超时 `setTimeout` 续片（实测：1MB 文本 ~21ms 解析完，吞吐 ~50MB/s——**小数据无感，积压几十 MB 才会秒级**；真正的代价是每批多 1–2 个 macrotask，交互态端到端多 ~16–50ms）。
- **放大链**：主线程忙（3.1 的后端阻塞不占页面线程；但 3.3 的每事件 React 渲染 + xterm 渲染 + 大背景图合成可以占）→ `ExecuteScript` 事件排队（wry execute_script 走 `ICoreWebView2::ExecuteScript`，页面忙时脚本延迟执行）→ ttyService 队列积压（上限 10000 条）→ rAF 一次 `queue.join` 大字符串 → xterm 分片解析 + 渲染 → 更忙。交互级数据量下不成立，**突发/高频下成立**。

### 3.4 事件 payload 形态：JSON 数字数组

`SerialDataEvent.data: Vec<u8>` 序列化为 JSON 数字数组（tauri.ts:240-246 `data: number[]`；serial/mod.rs SerialDataEvent + `data.to_vec()` :327-345），读线程每 chunk 一次 JSON 序列化（约 3–4 字节/字节数据），页面每事件一次 JSON.parse。高频率（>1k 事件/s）时开销可观；交互级无感。非 TTY 独有（TRX 同路径）。

### 3.5 模拟终端侧（GIT:BASH ConPTY）

- 读循环（tty_sim.rs:131-190）：`reader.read(&mut buf)`（4096B）→ **每 chunk 一次 emit_data_event**。ConPTY 输出天然小 chunk（每转义序列/每行一段），交互/滚动时事件频率高于真实串口；量级仍为百级/s，非秒级瓶颈。超时读返回 TimedOut 时仅 continue，无忙循环。
- 写（tty_sim.rs:44-63）：`writer.write` 锁内循环写，**无总期限兜底**——ConPTY 输入缓冲满（子进程不消费输入）时可无限阻塞 spawn_blocking 线程（不占主线程；按键 invoke 挂起）。低概率。

### 3.6 已排除/低嫌疑

- ttyService 队列/批写逻辑本身无死锁（rAF 与 setTimeout 双路取消无 bug；visibilitychange 重排正确）。
- 日志写路径：BufWriter 缓冲 + 每 5s 周期 flush（logger/mod.rs:665-670），非每事件磁盘 IO。
- 全店订阅：全仓库无 `useAppStore()` 无选择器订阅（grep 零命中），无每事件整树重渲染。
- `mergePorts`/端口轮询数据量小；背景图毛玻璃无 `backdrop-filter`（background.css 仅静态 blur + 半透明合成）。

## 4. 根因结论（按可能性从高到低）

| # | 根因 | 机制 | 置信度 | 证据链 | 反证/待验证 |
|---|---|---|---|---|---|
| 1 | **后端主线程周期阻塞**：`get_system_status`（每 5s 全进程表刷新）+ `list_available_ports`（每 3s 串口枚举）两个**同步命令**在事件循环主线程执行 | 阻塞期所有 invoke 排队 → 逐键 TX 挂起；结束瞬间积压涌出 | **中-高** | 同步命令=主线程（AGENTS.md issue #6-1 明示）；两命令仍为同步 `pub fn`（system_cmds.rs:57 / commands/serial.rs:15）；sysinfo `refresh_processes_specifics(All, memory+cpu)` 全表枚举 | 秒级需实测阻塞时长；慢机/多进程才可能数百 ms+ |
| 2 | **TX 写阻塞**：`write_all_with_deadline` 2s 总期限在设备流控/低波特率/大 payload 时被逐键触发 | 单键卡 100ms–2s；shell 收到全部字节才 echo | 中 | serial/mod.rs:257-287；commands/serial.rs:161；serialport com.rs:272-281（Write 100ms 超时） | diag 无 "Failed to send"；TRX 同受影响；需实测写耗时 |
| 3 | **前端主线程过载**：每事件 `setTrafficStats` React 重渲染 + xterm v6 12ms 分片解析 + ExecuteScript 排队，突发/高频时形成积压-滞后放大环 | 队列积压 → 大批 term.write → 分片解析 → 主线程更忙 | 中 | useSerialReceive.ts:67-69；StatusBar.tsx:51；xterm WriteBuffer（El=12/bc=50）；wry execute_script | 交互级数据量实测小写 ~20ms 解析完（本报告实测 1MB≈21ms）；秒级需数十 MB 积压 |
| 4 | xterm v6 `write()` 异步化固有延迟（每批 ≥1 macrotask + 渲染 rAF） | 每批 ~16–50ms 感知延迟 | 低-中（贡献因素） | node_modules lib/xterm.mjs WriteBuffer（空缓冲 setTimeout 启动） | 远不到秒级 |

**诚实声明**：未能确定唯一根因——多秒延迟需要「主线程/写路径被阻塞秒级」或「数十 MB 积压」，而静态证据只确认了「周期性数十-数百 ms 阻塞 × 3 处」与「逐键 invoke + 每事件 React 更新」的叠加放大结构。三者叠加在慢机/高负载/突发数据下可解释秒级；在干净环境下可能只是数百 ms 卡顿。最可疑且最易验证的是 **#1**。

## 5. 验证方法（如何确认根因）

1. **定位后端主线程阻塞**（验证 #1）：临时把 `get_system_status` 与 `list_available_ports` 改 async + `spawn_blocking`（或注释轮询 hook），对比交互延迟。改动极小、可逆。或后端在命令入口/出口打 `Instant::now()` 耗时 diag 日志。
2. **定位 TX 写阻塞**（验证 #2）：`send_serial_data` 内 `write_all_with_deadline` 前后记墙钟；查看是否接近 2s 期限；同时观察 diag 是否出现 "Failed to send data to ... timed out"。
3. **定位 RX 段延迟**（验证 #3/#4）：前端 `performance.now()` 打点——`onSerialData` 事件到达时刻 vs `ttyService.feed` 入队 vs `flushState` 调 `term.write` vs xterm `onWriteParsed`；以及 `ttyService.get(portId).queue.length` 峰值。
4. **浏览器侧长任务**：`npm run tauri dev` 打开 DevTools（debug 构建）→ Performance 录制按 Enter 前后 10s，看主线程 >50ms 长任务归属（React/GC/xterm/canvas）。
5. **SIM:Loopback 高频复现**：TTY 模式 + 周期输出命令（`100`~`10000`/s）观察卡顿与队列长度，验证 #3 放大环。

## 6. 修复建议（只建议，未实施）

| 优先级 | 建议 | 预估工作量 | 说明 |
|---|---|---|---|
| P0 | `get_system_status` / `list_available_ports` 改 async + `spawn_blocking`（复用 issue #6-1 同款模式） | 小（各 ~10 行） | 消除每 3s/5s 的主线程阻塞；sysinfo 可降频至 10s 或只刷本进程树 |
| P0 | TX 按键合并：xterm onData 加 ~10ms 合并窗口（rAF 内合批 invoke），保留顺序 | 中 | 逐键 invoke → 每 ~10ms 一批；显著降低 IPC 次数与排队窗口 |
| P1 | 每事件 `setTrafficStats` 降频：1s 窗口聚合（StatusBar 本就 1s 算速率，可只读 store） | 小 | 消除每事件 React 重渲染 |
| P1 | `write_all_with_deadline` 加耗时打点 diag 日志（`log::warn!` 超 100ms 时） | 小 | 数据驱动确认 #2 |
| P2 | ttyService 批写改小批次（单次 ≤4KB 或按 250ms 静默）并显式 `flushState` 时序打点 | 中 | 降单批延迟与积压峰值 |
| P2 | RX 事件 payload 改二进制（`Uint8Array`/ArrayBuffer 通道）避免 JSON 数字数组 | 中-大 | 高频率时显著；涉及 Tauri 事件序列化契约 |

## 附：关键证据位置速查

- 同步命令主线程阻塞：`src-tauri/src/commands/system_cmds.rs:57,74-77`、`src-tauri/src/commands/serial.rs:15`、`src-tauri/src/serial/mod.rs:411`（available_ports）、AGENTS.md「发送异步化（issue #6-1）」段
- TX 写期限：`src-tauri/src/serial/mod.rs:257-287`（`write_all_with_deadline`）、`src-tauri/src/commands/serial.rs:132-171`
- 逐键 invoke：`src/components/MainDisplay/TtyView.tsx:76-82` → `src/utils/ttyService.ts:225-250`
- 每事件 React 更新：`src/hooks/useSerialReceive.ts:67-69` + `src/components/StatusBar/StatusBar.tsx:51`
- ttyService 批写：`src/utils/ttyService.ts:99-125,186-208`
- xterm v6 异步分片解析：`node_modules/@xterm/xterm/lib/xterm.mjs`（WriteBuffer，El=12ms 预算 / bc=50 / setTimeout 续片；实测 1MB≈21ms）
- 事件注入经 ExecuteScript：`tauri-2.11.1/src/event/mod.rs`（emit_js_script）、`wry-0.55.1/src/webview2/mod.rs:1321-1338`
- 运行日志：`%APPDATA%/hypercom/diag/hypercom-debug.log`（08-08 有 GIT:BASH 发送失败记录；08-09 GIT:BASH 会话无发送失败；08-22 SIM 压测 100–200/s）

---

## 更新（2026-08-26，提交 4af76bf / 5803552 之后）

本报告提出的异步化 / TX 合批 / 流量统计降频等建议已被 4af76bf 落地（后端轮询命令异步化 + TX 合批 + 流量统计降频），后续 5803552/89cd2cc 又修复了输出区抖动与 insertBefore 崩溃。本文档作为性能诊断历史记录保留，**建议清单已过时**——当前行为以代码与 AGENTS.md 版本章节为准。
