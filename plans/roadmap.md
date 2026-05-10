# HyperCom 功能实现路线图

## 项目状态概览

| 模块 | 状态 | 说明 |
|------|------|------|
| 前端 UI 框架 | ✅ 已完成 | 标题栏、侧边栏、主显示区、操作面板、状态栏、配置弹窗 |
| 前端样式系统 | ✅ 已完成 | CSS 变量、暗色/亮色主题、组件 class 体系 |
| 前端状态管理 | ✅ 已完成 | Zustand + Immer，约 40 个 Actions |
| 前端类型定义 | ✅ 已完成 | 全局 TypeScript 类型 |
| 共享组件 | ✅ 已完成 | ContextMenu + useContextMenu |
| Tauri 服务层 | ✅ 已完成 | 类型化 invoke 包装器 + 事件监听 |
| React Hooks 层 | ✅ 已完成 | useSerialPorts, useSerialConnection, useSerialData, useConfigPersistence, useSystemStatus, useAppInit |
| 前端-后端对接 | ✅ 已完成 | 串口列表、连接/断开、发送数据、配置读写、系统状态 |
| Tauri 权限配置 | ✅ 已完成 | capabilities/default.json |
| 后端命令层 | ✅ 已完成 | 全部 16 个命令注册 |
| 串口管理 | 🔄 75% | 读取线程未接入 emit，参数解析不完整 |
| 配置管理 | ✅ 已完成 | JSON 读写持久化 |
| 日志管理 | 🔄 80% | 基础写入完成，分片续写未完成 |
| 存储管理 | 🔄 60% | 结构定义完成，CRUD 未实现 |
| Tauri 事件推送 | ⏳ 未开始 | 读取线程数据未通过 emit 推送 |
| 系统资源监控 | ⏳ 未开始 | get_system_status 返回硬编码值 |
| 拖拽排序 | ⏳ 未开始 | 需引入 @dnd-kit |
| 语法高亮 | ⏳ 未开始 | 规则集编辑器未实现 |
| 循环发送 | ⏳ 未开始 | 逻辑未实现 |

---

## 阶段一：核心对接（已完成 ✅）

### 1.1 前端 UI 框架搭建

**已完成：**
- [x] React + Vite + Tauri v2 项目初始化
- [x] 全局样式系统（CSS 变量 + 暗色/亮色主题）
- [x] 标题栏（TitleBar）
- [x] 串口管理边栏（Sidebar）— 含右键菜单、搜索框、AliasDialog
- [x] 主显示区（MainDisplay）— 含多分屏、标签页、终端视图
- [x] 操作面板（OperationPanel）— 含发送区、循环发送、参数区
- [x] 状态栏（StatusBar）
- [x] 配置弹窗（ConfigModal）— 含 6 个设置页
- [x] 共享右键菜单组件（ContextMenu + useContextMenu）
- [x] lucide-react 图标系统统一替换

### 1.2 状态管理与类型定义

**已完成：**
- [x] Zustand + Immer Store（约 40 个 Actions）
- [x] 全局 TypeScript 类型定义
- [x] 默认配置初始化

### 1.3 前端-后端对接

**已完成：**
- [x] `src/services/tauri.ts` — 类型化 Tauri 服务层
- [x] `src/hooks/useTauri.ts` — React Hooks 层
- [x] Sidebar 接入 useSerialPorts + useSerialConnection
- [x] StatusBar 接入 useSystemStatus
- [x] OperationPanel 接入 useSerialData + useSerialConnection + clearTerminal
- [x] ConfigModal 接入 useConfigPersistence
- [x] App.tsx 调用 useAppInit 初始化

---

## 阶段二：后端功能完善（进行中 🔄）

### 2.1 Tauri 事件推送

**待完成：**
- [ ] 在 `open_serial_port` 中传入 `AppHandle`
- [ ] 读取线程通过 `app.emit("serial:data", SerialDataEvent)` 推送数据
- [ ] 串口状态变化通过 `app.emit("serial:status", SerialStatusEvent)` 推送
- [ ] 系统状态轮询通过 `app.emit("system:status", SystemStatusResult)` 推送

### 2.2 串口参数完善

**待完成：**
- [ ] open_serial_port 传递完整的 data_bits/parity/stop_bits/handshake 参数给 serialport
- [ ] send_data 实现 HEX 格式解析（当前 HEX 模式直接当文本发送）
- [ ] 实现串口断线检测和自动重连

### 2.3 系统资源监控

**待完成：**
- [ ] 引入 `sysinfo` crate
- [ ] get_system_status 返回真实内存/CPU 数据
- [ ] prevent_screen_off / prevent_sleep 调用系统 API
- [ ] 实现 TX/RX 流量统计

---

## 阶段三：数据持久化（进行中 🔄）

### 3.1 数据库初始化

**待完成：**
- [ ] 在 Tauri setup 钩子中调用 storage_manager.init()
- [ ] 创建 port_groups 表
- [ ] 创建 send_command_sets + send_commands 表
- [ ] 创建 highlight_rule_sets + highlight_rules 表

### 3.2 CRUD 接口

**待完成：**
- [ ] 规则集的增删改查 API
- [ ] 命令集的增删改查 API
- [ ] 分组布局的保存/加载

### 3.3 日志功能完善

**待完成：**
- [ ] 自动分片续写逻辑
- [ ] 文件名格式变量解析（[com], [datetime], [date], [time]）
- [ ] 日志自动保存开关完整实现

---

## 阶段四：前端功能完善（待开始 ⏳）

### 4.1 拖拽排序

**待完成：**
- [ ] 引入 @dnd-kit 依赖
- [ ] 串口列表拖拽排序
- [ ] 标签页拖拽排序
- [ ] 标签页在不同 pane 间拖动

### 4.2 语法高亮

**待完成：**
- [ ] 终端内容语法高亮渲染
- [ ] 高亮规则集编辑器 UI
- [ ] 规则集后端存储对接

### 4.3 配置弹窗完善

**待完成：**
- [ ] 高亮规则集编辑器完整实现
- [ ] 发送命令规则集编辑器完整实现
- [ ] 浏览按钮调用 Tauri 文件对话框 API
- [ ] 背景图片预览与应用

### 4.4 其他前端功能

**待完成：**
- [ ] 循环发送逻辑实现
- [ ] 日志操作按钮功能（另存为、打开文件、打开目录）
- [ ] 串口参数变更实时下发给后端
- [ ] 窗口控制按钮绑定 Tauri API
- [ ] 响应式布局适配
- [ ] 虚拟滚动优化

---

## 阶段五：高级功能（待开始 ⏳）

### 5.1 数据导出

**待完成：**
- [ ] 实现 export_data 后端命令
- [ ] 支持 TXT/CSV/JSON 格式导出
- [ ] 选择保存路径（文件对话框）

### 5.2 协议解析器

**待完成：**
- [ ] 后端协议定义和解析器
- [ ] 前端协议解析器配置 UI

### 5.3 多语言支持

**待完成：**
- [ ] 引入 i18next 依赖
- [ ] 创建中/英语言文件
- [ ] 更新所有组件使用 i18n

---

## 开发优先级建议

```
优先级 1（核心功能）:
  ├── Tauri 事件推送（串口数据实时显示）
  ├── 串口参数完善（完整数据位/校验位支持）
  └── 系统资源监控（真实 CPU/内存数据）

优先级 2（数据持久化）:
  ├── 数据库初始化与 CRUD
  ├── 日志功能完善
  └── 规则集存储

优先级 3（前端增强）:
  ├── 拖拽排序
  ├── 语法高亮
  └── 配置弹窗完善

优先级 4（锦上添花）:
  ├── 数据导出
  ├── 协议解析器
  └── 多语言支持
```

---

## 验收标准

### 阶段一验收标准 ✅
- [x] UI 完整渲染（标题栏、侧边栏、主显示区、操作面板、状态栏、配置弹窗）
- [x] 右键菜单正常工作（侧边栏、标签页、终端视图）
- [x] 暗色/亮色主题切换
- [x] 串口列表自动刷新
- [x] 串口连接/断开
- [x] 数据发送
- [x] 配置读写

### 阶段二验收标准
- [ ] 串口数据实时显示在终端视图中
- [ ] 串口断线自动检测
- [ ] 系统状态栏显示真实数据

### 阶段三验收标准
- [ ] SQLite 数据库正常初始化
- [ ] 规则集 CRUD 操作正常
- [ ] 日志文件自动分片功能正常
- [ ] 配置弹窗浏览按钮可打开文件对话框

### 阶段四验收标准
- [ ] 串口列表可拖拽排序
- [ ] 标签页可拖拽排序
- [ ] 高亮规则集可配置并正常渲染
- [ ] 命令循环发送正常工作

### 阶段五验收标准
- [ ] 数据可导出为 TXT/CSV/JSON
- [ ] 自定义协议可配置和解析
- [ ] 中英文界面切换正常