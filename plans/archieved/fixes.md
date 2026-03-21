# HyperCom 代码问题分析与修复计划

## ✅ 修复完成

所有问题已修复，前后端构建成功！

---

## 分析总结

经过全面代码审查，发现以下关键问题需要修复：

---

## 问题 1: 前后端字段命名不一致（严重）✅ 已修复

### 问题描述
前端使用驼峰命名（camelCase），后端使用蛇形命名（snake_case），导致数据序列化/反序列化失败。

### 影响文件
- `src-tauri/src/models/serial.rs`
- `src-tauri/src/models/command.rs`
- `src-tauri/src/models/settings.rs`

### 修复方案
在所有结构体上添加 `#[serde(rename_all = "camelCase")]` 属性：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub port_name: String,
    pub baud_rate: u32,
    // ...
}
```

---

## 问题 2: SerialManager 线程安全问题（严重）

### 问题描述
`src-tauri/src/serial/manager.rs` 中的 `start_read_task` 方法尝试将 `SerialPort` 跨线程使用，但 `SerialPort` trait 不是 `Send`。

### 当前问题代码
```rust
pub fn start_read_task<R: Runtime>(&self, app_handle: AppHandle<R>) {
    let port = Arc::clone(&self.port);  // 问题：SerialPort 不能跨线程
    let handle = tokio::spawn(async move {  // 编译错误
        // ...
    });
}
```

### 修复方案
使用 `std::thread` 替代 `tokio::spawn`，因为串口读取是阻塞操作：

```rust
use std::thread;

pub fn start_read_task<R: Runtime>(&self, app_handle: AppHandle<R>) {
    let port = Arc::clone(&self.port);
    let config = Arc::clone(&self.config);
    
    let handle = thread::spawn(move {
        let mut throttler = DataThrottler::new(50);
        let mut buffer = [0u8; 4096];
        
        loop {
            // 读取数据...
            thread::sleep(Duration::from_millis(10));
        }
    });
    
    *self.read_task.lock() = Some(handle);
}
```

同时需要修改 `read_task` 类型为 `Option<thread::JoinHandle<()>>`。

---

## 问题 3: 前端状态更新问题（中等）

### 问题描述
`src/stores/serialStore.ts` 中直接修改数组不会触发 React 重新渲染：

```typescript
// 错误：直接 push 不会触发更新
useSerialStore.getState().receivedData.push(packet);
```

### 修复方案
使用 Zustand 的 `set` 方法正确更新状态：

```typescript
await listen<DataPacket>('serial:data-received', (event) => {
  const packet = event.payload;
  const store = useSerialStore.getState();
  store.setState({
    receivedData: [...store.receivedData, packet]
  });
});
```

---

## 问题 4: 缺少日志功能实现

### 问题描述
设计文档中定义了日志相关命令，但 `src-tauri/src/commands/` 目录缺少 `log.rs` 文件。

### 需要添加的命令
- `start_logging`
- `stop_logging`
- `export_log`

---

## 问题 5: 前端类型字段名不匹配

### 问题描述
前端 `PortInfo` 使用 `portType`，后端使用 `port_type`，需要统一。

### 修复方案
后端添加 `#[serde(rename_all = "camelCase")]` 后，前端无需修改。

---

## 修复步骤清单

1. [ ] 修复 `src-tauri/src/models/serial.rs` - 添加 camelCase 序列化
2. [ ] 修复 `src-tauri/src/models/command.rs` - 添加 camelCase 序列化
3. [ ] 修复 `src-tauri/src/models/settings.rs` - 添加 camelCase 序列化
4. [ ] 修复 `src-tauri/src/serial/manager.rs` - 使用 std::thread 替代 tokio
5. [ ] 修复 `src/stores/serialStore.ts` - 修复状态更新逻辑
6. [ ] 创建 `src-tauri/src/commands/log.rs` - 实现日志功能
7. [ ] 更新 `src-tauri/src/commands/mod.rs` - 导出日志命令
8. [ ] 更新 `src-tauri/src/lib.rs` - 注册日志命令
9. [ ] 验证构建 - 运行 `cargo check` 和 `npm run build`

---

## 建议的后续开发

1. **添加命令组 UI 组件** - 目前只有后端实现，缺少前端界面
2. **实现日志查看器** - 添加日志文件浏览功能
3. **添加数据导出功能** - 支持将接收到的数据导出为文件
4. **添加协议解析器** - 支持自定义协议解析