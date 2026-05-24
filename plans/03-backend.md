# 后端架构详解

## AppState

```rust
// lib.rs
pub struct AppState {
    pub serial_manager:  Mutex<SerialManager>,   // 串口操作 (真实 + 模拟)
    pub config_manager:  Mutex<ConfigManager>,    // JSON 配置持久化
    pub log_manager:     Mutex<LogManager>,       // BufWriter 日志
    pub storage_manager: Mutex<StorageManager>,   // SQLite CRUD (延迟初始化)
}
```

所有 Manager 用 `std::sync::Mutex` 包装。`setup` 钩子中设置 AppHandle 给 SerialManager，异步初始化数据库。

## 命令层 (32 个命令)

### 串口命令 (6)

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `list_available_ports` | — | `Vec<PortInfo>` | 枚举系统串口 + SIM:Loopback(如启用) |
| `open_serial_port` | `OpenPortArgs` (port_id, baud_rate, data_bits, parity, stop_bits, handshake, dtr, rts) | `()` | 打开串口，自动判断真实/模拟 |
| `close_serial_port` | `port_id: String` | `()` | 关闭串口，清理读线程 |
| `send_serial_data` | `SendDataArgs` (port_id, data, is_hex, append_line_ending) | `usize` | 发送数据；HEX 模式经 `parse_hex_string` 解析后写入；返回写入字节数 |
| `set_serial_params` | `SetSerialParamsArgs` (port_id, baud_rate, data_bits, parity, stop_bits, handshake) | `()` | 完整在线参数修改（注：当前后端仍仅消费 baud_rate，其余字段为占位） |
| `set_flow_control` | `port_id: String, dtr: bool, rts: bool` | `()` | 设置 DTR/RTS |

### 模拟模式命令 (2)

| `enable_simulation` | — | `()` | 端口列表添加 SIM:Loopback |
| `disable_simulation` | — | `()` | 关闭所有模拟端口，从列表移除 |

### 配置命令 (3)

| `get_config` | — | `AppConfig` | 从 JSON 文件读取 |
| `set_config` | `new_config: AppConfig` | `()` | 写入 JSON 文件 |
| `reset_config` | — | `AppConfig` | 恢复默认值 |

### 日志命令 (12)

| `start_logging` | `port_id: String, format: String` | `()` | 为端口创建日志写入器（按 config.log_format） |
| `stop_logging` | `port_id: String` | `()` | 关闭写入器并 `sync_all` 落盘 |
| `save_log_as` | `port_id: String, path: String` | `()` | 拷贝活跃日志到指定路径（需要 dialog:allow-save 权限） |
| `export_terminal_log` | `path: String, content: String` | `()` | 通用文件写入：`std::fs::write`，被终端右键导出 TXT/CSV 调用 |
| `set_log_directory` | `path: String` | `()` | 修改日志根目录 |
| `set_log_filename_format` | `format: String` | `()` | 文件名模板 (`[com]/[datetime]/[date]/[time]`) |
| `set_log_split_size` | `size_mb: u64` | `()` | 单文件分片大小阈值 |
| `set_log_auto_save` | `enabled: bool` | `()` | auto_save 开关；`write()` 首行短路 |
| `set_log_encoding` | `encoding: String` | `()` | 默认编码 (UTF-8/GBK/ISO-8859-1/ASCII) |
| `get_log_files` | — | `Vec<LogFileInfo>` | 列出所有日志文件，port_id 优先用 writer 反向索引 |
| `open_path` | `path: String, state: State<AppState>` | `()` | 用 OS 打开文件，路径必须 canonicalize 后位于 LogManager.get_directory() 子树内 |
| `open_log_directory` | — | `()` | 打开日志根目录 |

### 系统命令 (3) + 存储命令 (6)

| `get_system_status` | — | `SystemStatus` | 进程 CPU/内存（sysinfo 增量刷新；setup 已预热 250ms） |
| `prevent_screen_off` | `enable: bool` | `()` | Win32 SetThreadExecutionState 实现（其他平台占位日志） |
| `prevent_sleep` | `enable: bool` | `()` | 同上 |
| `save_command_set` | `SaveCommandSetArgs` | `String` (id) | 保存命令集到 SQLite |
| `load_command_sets` | — | `Vec<CommandSetInfo>` | 加载全部命令集 |
| `delete_command_set` | `set_id: String` | `()` | 删除命令集及子命令 |
| `save_highlight_set` | `SaveHighlightSetArgs` | `String` (id) | 保存高亮规则集 |
| `load_highlight_sets` | — | `Vec<HighlightSetInfo>` | 加载全部规则集 |
| `delete_highlight_set` | `set_id: String` | `()` | 删除规则集及子规则 |

## 事件系统

后端通过 `app_handle.emit(event_name, payload)` 推送事件：

| 事件 | Payload | 触发时机 |
|------|---------|---------|
| `serial:data` | `{ port_id, timestamp, direction, data: Vec<u8>, is_hex }` | 串口每收到数据 (50ms 节流) |
| `serial:status` | `{ port_id, status: "connected"\|"disconnected"\|"error" }` | 连接成功、读线程退出、读错误 |
| `storage:ready` | `()` | 数据库初始化完成 |

## 串口管理器 (`serial/mod.rs`)

### 真实串口 (`SerialPortHandle`)

```
open_real_port(args)
  ├─ serialport::new(id, baud)
  │   .data_bits(parse_data_bits(args.data_bits))
  │   .parity(parse_parity(&args.parity))
  │   .stop_bits(parse_stop_bits(&args.stop_bits))
  │   .flow_control(parse_flow_control(&args.handshake))
  │   .timeout(100ms)
  │   .open()
  ├─ 用 Arc<Mutex<Box<dyn SerialPort>>> 包装
  ├─ spawn 读线程:
  │   ├─ loop { port.read(&mut buffer) }
  │   ├─ Ok(n > 0) → emit serial:data
  │   ├─ Ok(0) → 继续 (超时)
  │   ├─ Err → emit serial:status("error") → break
  │   └─ thread::sleep(50ms)
  ├─ 读线程退出 → emit serial:status("disconnected")
  └─ AtomicBool running 标志控制优雅停止
```

### 模拟串口 (`SimPortHandle`)

```
open_sim_port(args)
  ├─ 创建 mpsc::channel()
  ├─ spawn 处理线程:
  │   ├─ SimMessage::Echo(data, is_hex) → emit "Received: {data}" 作为 serial:data
  │   ├─ SimMessage::Stop → break
  │   └─ 每 500ms 发送心跳 "[SIM] Heartbeat @ HH:MM:SS"
  └─ send_data 通过 channel 发送 Echo 消息
```

参数解析：`parse_data_bits(5..8)` → `DataBits::Five..Eight`，`parse_parity("Even"/"Odd")` → `Parity::Even/Odd`，`parse_stop_bits("Two")` → `StopBits::Two`，`parse_flow_control("XonXoff"/"RequestToSend")` → `FlowControl::Software/Hardware`。

## 配置管理器 (`config/mod.rs`)

- `AppConfig`：36 个字段，`#[serde(rename_all = "camelCase")]`
- 存储路径：`{dirs::config_dir()}/hypercom/config.json`
- `ConfigManager::new()` 自动创建目录、加载已有配置或使用默认值
- 通过 `serde_json::to_string_pretty` 写入

## 日志管理器 (`logger/mod.rs`)

- `LogManager`：管理 `HashMap<String, PortLogWriter>`
- `PortLogWriter`：每个端口独立 `BufWriter<File>`
- 支持三种格式写入 `write_line(ts, dir, data)`：
  - `"hex"` → `[ts] DIR AA BB CC ...`
  - `"binary"` → 原始字节
  - default → `[ts] DIR <utf8文本>`
- `should_split(split_size_mb)` 检测是否超限（实际续写逻辑未实现）
- 默认目录：`{dirs::data_dir()}/hypercom/logs/`

## 存储管理器 (`storage/mod.rs`)

### 数据库初始化

```
run() → setup 钩子
  └─ tauri::async_runtime::spawn(async {
       pool = storage::create_pool().await     // 创建连接池 (不持有锁)
       storage::init_schema_on_pool(&pool).await  // 建表 (不持有锁)
       state.storage_manager.lock().set_pool(pool) // 存入 Manager
       emit("storage:ready", ())
     })
```

通过分离 `create_pool()` 和 `init_schema_on_pool()` 为独立异步函数，避免 `MutexGuard` 跨 `.await` 导致的 `!Send` 编译错误。

### 表结构 (6 张表)

```sql
-- 串口分组
CREATE TABLE port_groups (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    order_idx INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE port_group_members (
    group_id TEXT NOT NULL, port_id TEXT NOT NULL,
    PRIMARY KEY (group_id, port_id)
);

-- 发送命令集
CREATE TABLE send_command_sets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    is_loop INTEGER DEFAULT 0, loop_delay_ms INTEGER DEFAULT 1000
);
CREATE TABLE send_commands (
    id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES send_command_sets(id),
    name TEXT, order_idx INTEGER, delay_ms INTEGER, cmd_type TEXT,
    content TEXT, append_line_ending TEXT
);

-- 高亮规则集
CREATE TABLE highlight_rule_sets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, is_enabled INTEGER DEFAULT 1
);
CREATE TABLE highlight_rules (
    id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES highlight_rule_sets(id),
    name TEXT, pattern TEXT NOT NULL, is_regex INTEGER DEFAULT 0,
    color TEXT, bold INTEGER DEFAULT 0, italic INTEGER DEFAULT 0
);
```

### CRUD 架构

所有 CRUD 方法有两套实现：

1. **`StorageManager` 实例方法** (`save_command_set(&self, ...)` 等) — 内部调用 `get_pool()` 后转发到独立函数
2. **独立异步函数** (`save_command_set_to_db(pool, ...)` 等) — 接收 `&Pool<Sqlite>`，由 commands 在 lock → clone pool → drop lock 后调用，避免 `MutexGuard` 跨 await

## 系统监控 (`commands/mod.rs`)

```rust
fn get_system_status(state: State<AppState>) -> SystemStatus {
    let mut system = System::new_all();  // sysinfo v0.33
    system.refresh_all();

    let pid = std::process::id();
    let used_memory = system.process(Pid::from(pid as usize))
        .map(|p| p.memory() / (1024 * 1024))
        .unwrap_or_else(|| system.used_memory() / (1024 * 1024));

    let cpu_usage = system.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>()
        / system.cpus().len() as f32;

    SystemStatus { status, memory_used_mb: used_memory, memory_limit_mb, cpu_usage }
}
```
