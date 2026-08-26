# 串口管理模块

串口枚举、连接生命周期、参数/流控、读写句柄、虚拟端口（SIM:Loopback）、外部工具（flasher）。后端 `serial/mod.rs` + `commands/serial.rs` + `commands/simulation.rs`；前端 `useSerialPorts` / `useSerialConnection` / `useSimulation` / `usePortToolActions`。

## 架构总览

```
Sidebar 端口列表 ◄── 3s 轮询 useSerialPorts ──► list_available_ports（后端枚举）
Sidebar/TabBar 连接按钮 ──► useSerialConnection ──► open_serial_port / close_serial_port
                                                        │
                                              SerialManager（全局，Arc<Mutex>）
                                              ┌──────────────────────────────┐
                                              │ ports: HashMap<portId,       │
                                              │   SerialPortHandle>          │
                                              │   read_port / write_port 双句柄│
                                              │ sim_ports / gitbash_sim      │
                                              └──────────────────────────────┘
```

## 端口枚举与热插拔

### 轮询与合并（`useSerialPorts` + `mergePorts`）

- `useSerialPorts(3000)` 每 3s 轮询 `list_available_ports`；`mapPortInfo()` 恒置 `status:'disconnected'`。
- `mergePorts(incoming, existing)` 按 **existing 顺序**合并（新端口追加），保留既有端口状态（status/alias/group/baudRate），手动排序/拖拽顺序不被轮询冲掉。

### 热插拔语义（issue #12）

- fresh 枚举命中的端口保留 `connected`/`connecting`（真实会话），**不保留 `error`**——重置为 `disconnected`，否则本次 open 失败的状态被每次轮询永久重建，刷新按钮（与轮询同一条 `refreshPorts`→`mergePorts` 链）永远救不回。
- 从枚举消失的 `connected`/`connecting` 端口经 union-back 保留**最多 `MAX_MISSING_POLLS=3` 轮**（模块级 `ghostMissingPolls`），超限放弃——拔出后读线程可能永不发 `disconnected`（空闲），无上限保留会产生幽灵端口。
- 后端 `open_real_port` stale 守卫交叉核对系统枚举：设备已消失 → 回收幽灵句柄（停线程 + join ≤100ms）允许重插后直开；设备仍存在 → 才报 `already open`。

## 连接生命周期

### 打开（`open_serial_port`）

```
openPort(portId, baud)
  → useAppStore.updatePort(portId, { status: 'connected' })      // 乐观更新
  → serialService.openSerialPort({ port_id, baud_rate, data_bits, parity, stop_bits, handshake, dtr, rts })
    → invoke('open_serial_port')
      → SerialManager.open_real_port() 或 open_sim_port()
        → serialport::new().open() 或创建 mpsc channel
        → spawn 读线程（50ms 轮询，见 transmission.md）
        → emit serial:status("connected")
```

- 打开时在 `open_real_port` 内设置 DTR/RTS（clone 前，设备级共享），随后 `port.try_clone()`（Windows = DuplicateHandle）得写句柄、原句柄作读句柄——**不能对同一 COM 口二次 CreateFile**（crate 以 dwShareMode=0 打开）。
- `SerialPortHandle`：`read_port`（读线程独占，只锁读）/ `write_port`（发送路径独占，只锁写）双 `Arc<Mutex<Box<dyn SerialPort>>>`；`set_params`/`set_flow_control` 改在写句柄上（DCB/COMMTIMEOUTS 设备级、两句柄共享）。
- **发送异步化（issue #6-1）**：`send_serial_data` 是 async fn + `tokio::task::spawn_blocking`——原同步命令在事件循环主线程执行 write_all+flush+日志写，每次 TX 无条件卡顿 + tao `NewEvents`/`RedrawEventsCleared` 警告白屏。`AppState.serial_manager`/`log_manager` 改 `Arc<Mutex<..>>`（Deref 使 `.lock()` 调用点零改动）。
- `openPort`/`closePort` 有 per-port in-flight 守卫，同一事件循环连点不再并发 open 同一句柄。
- **陈旧句柄守卫**：异常断线后陈旧句柄留在 `ports`，`open_port` 无守卫会报 OS「access denied」且 `insert` 可能丢弃存活句柄、泄漏游离读线程——守卫存活 → 干净报错「already open」；死线程 → 移除并释放 OS 端口。SIM 读线程退出补发 `serial:status disconnected`。

### 关闭

- `closePort(portId)` 路由经 `useSerialConnection`：调 `stopLogging` 更新端口状态 → `close_serial_port`。
- `close_serial_port` 是 async + `spawn_blocking` join（读线程永久阻塞时也不冻结 UI）。
- **标签页关闭 ≠ 端口关闭（issue #11）**：关闭标签只销毁前端显示目标（`getRxPipeline().disconnect` + `ttyService.detach` + `releaseViewportManager`），串口连接与后端日志保持。重开标签页从零开始新一轮输出。

## 参数与流控

- `set_serial_params` / `set_flow_control`：更新 DCB（波特率/数据位/校验/停止位）与流控（handshake/DTR/RTS）。
- `set_params` 的 `data_bits` 走 `u8` 直传（命令层去掉 `to_string()` 往返）。
- 参数预设（`portPresets`）是 config 实体，由设置页管理、ParamsSection 下拉使用（见 config.md）。

## 读写句柄分离与发送期限（issue #6-10）

此前「TX 后等一分钟才收到响应」根因有二：

1. 读写共用同一把 per-port 锁——TX 的 write_all+flush 阻塞时读线程拿不到锁，响应到了 OS 接收缓冲也读不走；
2. 热路径 `flush()`（Windows = FlushFileBuffers）无超时、受流控约束（对端 CTS 拉低/XOFF 时无界阻塞）。

修复：`SerialPortHandle` try_clone 拆 read/write 双句柄；读线程只锁读、发送只锁写；热路径去 flush + `write_all_with_deadline` 总写期限（`WRITE_TOTAL_DEADLINE` 2s，Ok(0) 立即报错、TimedOut 重试到总期限、Interrupted 继续）。发送改**两段式**：全局锁内 `get_write_handle` 只做 HashMap 查找 + Arc 克隆（SIM 走 channel 发送）→ 释放全局锁 → 锁外只持 per-port 写锁写——不再持全局 serial_manager 锁执行写，端口列表轮询/其它端口命令不被 TX 阻塞拖死。每次 WriteFile 受 `.timeout(100ms)` 约束 ≈100ms，per-port 写锁单次持有上限 = 总期限 2s（极端场景），RX 最坏延迟从分钟级降为百毫秒级（读写锁分离后 RX 根本不再被 TX 锁饿死）。

## 虚拟端口（SIM:Loopback）

- `enable_simulation` / `disable_simulation`（`commands/simulation.rs`）创建虚拟串口，flask 图标在侧边栏工具栏（`useSimulation` hook）。
- **双层门控**：前端 `DEV_FEATURES_ENABLED = import.meta.env.DEV` 隐藏全部 SIM UI；后端 release（`cfg(not(debug_assertions))`）命令直接报错；仅 `npm run tauri dev` 可用。
- **周期输出频率命令**：向 SIM:Loopback 发送**文本模式纯数字**（trim 后为数字，如 `100`）即把周期输出频率切到每秒 N 次（0 = 停止；上限 `MAX_SIM_RATE = 10000`，超限 clamp），命令本身不回显——输出为 `[SIM] Heartbeat #<seq>` 序号行，积分器补发保证平均频率精确（`sim_due_lines` 纯函数，100ms 循环节拍不限制高频）。HEX 模式/非数字 TX 保持原回显。默认 2/s。

## 外部工具（flasher）

- `run_port_tool` / `kill_port_tool`（`commands/serial.rs`）+ `useToolOutput` hook + ToolSettings 页。
- close→spawn→stream→reopen 闭环；`{port}` 模板替换；配置在设置弹窗「外部工具」页；触发在侧边栏右键菜单。
- `run_port_tool` 在**全局串口锁外** join 读线程；stdout/stderr 按字节读（`read_until(b'\n')` + `from_utf8_lossy`）；重开端口失败补发 `serial:status error`。
- 分组整组执行（issue #5-7）：`usePortToolActions.runToolForGroup` + `GroupToolDialog`——严格配置判定=配置存在+portId 匹配+`command.trim() !== ''`；`utils/groupTool.ts` `partitionGroupPorts` 纯函数；**`Promise.all` 并行**运行已配置端口（跳过运行中端口，单端口失败不中断整组）。
- 标签页菜单与侧边栏同源（`usePortToolActions`），文案复用 `sidebar.port.contextMenu.*` key。

## 端口排序与分组

- **排序一次性动作（issue #6-4）**：`sortPortsByNumber()`（重排 ports + 各分组 portIds，自然序）；Sidebar **无持久 sortMode 开关**，拖拽/分组始终可用。`naturalCompare` 数字段按数值比较（COM1<COM2<COM12）。组内顺序随 `save_port_groups` 持久化、未分组顺序不保存。
- **分组控制（issue #6-5）**：按端口分组态动态渲染右键菜单项——未分组且有组→逐组「移入分组『{{name}}』」；未分组无组→「新建分组并移入」；已在组里→「移出分组」。i18n keys `sidebar.port.contextMenu.{removeFromGroup,addToGroup,createGroupWithPort}`。
- 分组是第 7 类 config 实体（`PortGroupEntry`），启动经 `get_config` 恢复并回填 `ports.groupId`；变更 500ms 防抖自动保存（无手动「保存布局」按钮）。

## 单元测试纪律（serial/mod.rs）

- 测试用**显式导入**，绝不 `use super::*`：glob 会把 `serialport` FFI 拖进测试二进制，Windows `cargo test` harness 因缺应用清单而 `0xc0000139` 加载失败。
- 纯函数测试（hex 解析、`build_tx_bytes` 各分支）在 Windows 运行；引用 `serialport` 类型 / `SerialManager` 的测试 `#[cfg(not(target_os = "windows"))]`，在 Linux/macOS CI 运行。
- `build_tx_bytes` 是「实际写入字节」唯一事实来源，`send_data` 与 TX 日志共用；`emit_data_event` 只取一次 `now()`，格式化串与毫秒同源（SIM/文本带行结束符时发送字节数、TX 日志、回显三处曾不一致）。

## 数据流

连接 / 端口列表刷新两条数据流见 [`transmission.md`](transmission.md) 的连接与端口轮询章节；字节收发完整链路亦在 transmission.md。
