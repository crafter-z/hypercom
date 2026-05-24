# 待办事项

## 🔴 高优先级

### 日志功能完善 (`logger/mod.rs`)
- 自动分片：`should_split()` 检测超限后关闭当前文件并创建新文件续写
- 文件名变量解析：替换 `[com]` → 端口号, `[datetime]` → YYYYMMDD_HHMMSS
- 自动保存开关：根据 `config.auto_save_log` 决定收到数据时是否写入

### HEX 发送格式解析 (`serial/mod.rs`)
- 前端选中 HEX 发送时，后端 `send_data` 应解析 `48 65 6C 6C 6F` → `[0x48, 0x65, 0x6C, 0x6C, 0x6F]` 字节数组再写入
- 当前是直接 `data.as_bytes().to_vec()`

### 标题栏窗口控制 (`TitleBar.tsx`)
- 最小化：调用 Tauri API `appWindow.minimize()`
- 最大化/还原：`appWindow.toggleMaximize()`
- 关闭：`appWindow.close()`

## 🟡 中优先级

### 日志操作按钮 (`OperationPanel.tsx`)
- "另存为"：✅ 已实现（`logService.saveLogAs` + 文件对话框）
- "打开文件"：✅ 已实现（`logService.openPath`，后端 `open_path` 命令）
- "打开目录"：✅ 已实现（`logService.openLogDirectory`，后端 `open_log_directory` 命令）

### 串口参数完善 (`set_serial_params`)
- 当前仅支持波特率切换，需扩展为支持 data_bits/parity/stop_bits/handshake 在线修改
- 前端 `serialService.setSerialParams` 已传递完整参数但后端未使用

### 滚动锁定同步
- OperationPanel 的 `opScrollLocked` 与 `TerminalState.scrollLocked` 未双向同步
- 应在切换 `opScrollLocked` 时调用 `setTerminalConfig(portId, { scrollLocked })`

### 窗口防休眠 API
- `prevent_screen_off` / `prevent_sleep` 当前仅日志记录
- Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED)`

### 分屏嵌套
- 当前 Pane 为平铺模型，不支持树状嵌套分屏 (VS Code 式)
- Pane 内再分屏需重构 `SplitPane` 为树结构

## 🟢 低优先级

### 虚拟滚动
- 终端数据量较大时 (万行级)，全部渲染 DOM 节点会导致卡顿
- 方案：`react-window` 或 `@tanstack/react-virtual`

### 协议解析器
- 后端定义协议模板 (帧头/长度/校验/帧尾)，自动解析并高亮各字段
- 前端提供协议模板编辑器

### 多语言 i18n
- 引入 `i18next` + `react-i18next`
- 创建 `zh-CN.json` / `en-US.json`
- 所有组件文本替换为 `t('key')`

### 数据导出
- `export_data` 命令：将终端内容导出为 TXT/CSV/JSON
- 文件保存对话框选择路径

### 字体缩放
- 终端字体大小绑定 `--font-size-terminal` CSS 变量
- 添加 Ctrl+滚轮 或滑块调整

### 背景图片
- ConfigModal 已有路径选择，需实现在主窗口 CSS `background-image` 应用

### 侧边栏 mock 分组清理
- `Sidebar.tsx` 初始化时创建 mock 分组 (COM3/COM4/...)，应改为仅在有真实端口时可选分组
