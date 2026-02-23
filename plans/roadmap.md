# HyperCom 功能实现路线图

## 项目状态概览

| 模块 | 状态 | 说明 |
|------|------|------|
| 串口核心功能 | ✅ 已完成 | 串口连接、数据收发 |
| 数据节流机制 | ✅ 已完成 | 避免高频数据导致 UI 卡顿 |
| 基础 UI 框架 | ✅ 已完成 | Header, SerialConfig, DataDisplay, SendInput |
| 命令组后端 API | ✅ 已完成 | CRUD 操作 |
| 日志存储功能 | ✅ 已完成 | 后端 log.rs + 存储层 |
| 命令组前端 UI | ✅ 已完成 | Sidebar, CommandList, CommandEditor |
| 设置 UI 组件 | ✅ 已完成 | FontSettings, ThemeSettings, LogSettings |
| 数据导出功能 | ✅ 已完成 | 导出接收数据为 TXT/CSV/JSON |
| 协议解析器 | ✅ 已完成 | 自定义协议解析 |
| 多语言支持 | ✅ 已完成 | i18n 国际化 (中/英) |

---

## 阶段一：后端存储层与日志功能

### 1.1 创建存储层模块

**文件结构：**
```
src-tauri/src/storage/
├── mod.rs           # 模块导出
├── database.rs      # SQLite 数据库操作
└── logfile.rs       # 日志文件操作
```

**任务清单：**
- [ ] 创建 `src-tauri/src/storage/mod.rs`
- [ ] 创建 `src-tauri/src/storage/database.rs` - SQLite 初始化与操作
- [ ] 创建 `src-tauri/src/storage/logfile.rs` - 日志文件写入与管理
- [ ] 更新 `src-tauri/src/lib.rs` - 导入存储模块

### 1.2 实现日志命令

**文件：** `src-tauri/src/commands/log.rs`

**API 设计：**
| 命令名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `start_logging` | `path: String` | `Result<(), String>` | 开始记录日志 |
| `stop_logging` | 无 | `Result<(), String>` | 停止记录日志 |
| `get_log_status` | 无 | `Result<LogStatus, String>` | 获取日志状态 |
| `export_log` | `source: String, target: String` | `Result<(), String>` | 导出日志文件 |
| `clear_log` | `path: String` | `Result<(), String>` | 清空日志文件 |

**任务清单：**
- [ ] 创建 `src-tauri/src/commands/log.rs`
- [ ] 更新 `src-tauri/src/commands/mod.rs` - 导出日志命令
- [ ] 更新 `src-tauri/src/lib.rs` - 注册日志命令

### 1.3 添加依赖

**文件：** `src-tauri/Cargo.toml`

需要添加的依赖：
```toml
sqlx = { version = "0.7", features = ["runtime-tokio", "sqlite"] }
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4"] }
```

**任务清单：**
- [ ] 更新 `Cargo.toml` 添加必要依赖

---

## 阶段二：前端命令组管理 UI

### 2.1 创建命令组组件

**文件结构：**
```
src/components/commands/
├── index.ts           # 模块导出
├── CommandSidebar.tsx # 命令组侧边栏
├── CommandList.tsx    # 命令列表
├── CommandEditor.tsx  # 命令编辑器
└── CommandItem.tsx    # 单条命令组件
```

**任务清单：**
- [ ] 创建 `src/components/commands/index.ts`
- [ ] 创建 `src/components/commands/CommandSidebar.tsx`
- [ ] 创建 `src/components/commands/CommandList.tsx`
- [ ] 创建 `src/components/commands/CommandEditor.tsx`
- [ ] 创建 `src/components/commands/CommandItem.tsx`

### 2.2 更新主应用布局

**文件：** `src/App.tsx`

- 添加侧边栏到主布局
- 实现侧边栏折叠功能

**任务清单：**
- [ ] 更新 `src/App.tsx` 集成命令组侧边栏

### 2.3 更新状态管理

**文件：** `src/stores/commandStore.ts`

- 添加命令组 UI 状态管理
- 添加拖拽排序状态

**任务清单：**
- [ ] 更新 `src/stores/commandStore.ts`

---

## 阶段三：设置 UI 组件

### 3.1 创建设置组件

**文件结构：**
```
src/components/settings/
├── index.ts            # 模块导出
├── SettingsModal.tsx   # 设置弹窗
├── FontSettings.tsx    # 字体设置
├── ThemeSettings.tsx   # 主题设置
├── LogSettings.tsx     # 日志设置
└── DisplaySettings.tsx # 显示设置
```

**任务清单：**
- [ ] 创建 `src/components/settings/index.ts`
- [ ] 创建 `src/components/settings/SettingsModal.tsx`
- [ ] 创建 `src/components/settings/FontSettings.tsx`
- [ ] 创建 `src/components/settings/ThemeSettings.tsx`
- [ ] 创建 `src/components/settings/LogSettings.tsx`
- [ ] 创建 `src/components/settings/DisplaySettings.tsx`

### 3.2 集成设置入口

**文件：** `src/components/layout/Header.tsx`

- 添加设置按钮
- 打开设置弹窗

**任务清单：**
- [ ] 更新 `src/components/layout/Header.tsx` 添加设置入口

---

## 阶段四：数据导出功能

### 4.1 后端导出命令

**文件：** `src-tauri/src/commands/export.rs`

**API 设计：**
| 命令名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `export_data` | `data: String, format: String, path: String` | `Result<(), String>` | 导出数据 |
| `select_save_path` | `default_name: String` | `Result<String, String>` | 选择保存路径 |

**任务清单：**
- [ ] 创建 `src-tauri/src/commands/export.rs`
- [ ] 更新 `src-tauri/src/commands/mod.rs`
- [ ] 更新 `src-tauri/src/lib.rs`

### 4.2 前端导出 UI

**文件：** `src/components/serial/DataDisplay.tsx`

- 添加导出按钮
- 支持多种格式导出 (TXT, CSV, JSON)

**任务清单：**
- [ ] 更新 `src/components/serial/DataDisplay.tsx` 添加导出功能

---

## 阶段五：协议解析器

### 5.1 后端解析器

**文件结构：**
```
src-tauri/src/parser/
├── mod.rs           # 模块导出
├── protocol.rs      # 协议定义
└── parser.rs        # 解析器实现
```

**任务清单：**
- [ ] 创建 `src-tauri/src/parser/mod.rs`
- [ ] 创建 `src-tauri/src/parser/protocol.rs`
- [ ] 创建 `src-tauri/src/parser/parser.rs`

### 5.2 前端解析器配置 UI

**文件：** `src/components/parser/`

**任务清单：**
- [ ] 创建协议解析器配置组件

---

## 阶段六：多语言支持

### 6.1 配置 i18n

**文件结构：**
```
src/locales/
├── zh-CN.json       # 中文
├── en-US.json       # 英文
└── index.ts         # i18n 配置
```

**任务清单：**
- [ ] 安装 i18next 依赖
- [ ] 创建语言文件
- [ ] 配置 i18n
- [ ] 更新所有组件使用 i18n

---

## 开发顺序建议

```
Week 1: 阶段一 (后端存储层与日志功能)
  ├── Day 1-2: 创建存储层模块
  ├── Day 3-4: 实现日志命令
  └── Day 5: 测试与调试

Week 2: 阶段二 (命令组管理 UI)
  ├── Day 1-2: 创建命令组组件
  ├── Day 3-4: 集成到主布局
  └── Day 5: 测试与调试

Week 3: 阶段三 (设置 UI 组件)
  ├── Day 1-2: 创建设置组件
  ├── Day 3-4: 集成设置入口
  └── Day 5: 测试与调试

Week 4: 阶段四-六 (高级功能)
  ├── Day 1-2: 数据导出功能
  ├── Day 3-4: 协议解析器
  └── Day 5: 多语言支持
```

---

## 技术要点

### 日志存储实现要点

```rust
// 使用 BufWriter 异步写入
use std::fs::{File, OpenOptions};
use std::io::BufWriter;

pub struct LogManager {
    writer: Option<BufWriter<File>>,
    log_path: PathBuf,
    max_size: u64,
}

impl LogManager {
    pub fn write(&mut self, data: &str) -> Result<(), String> {
        // 检查文件大小，必要时分片
        // 写入数据
    }
}
```

### 命令组拖拽实现要点

```typescript
// 使用 @dnd-kit/core 实现拖拽
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

// 拖拽排序逻辑
const handleDragEnd = (event: DragEndEvent) => {
  const { active, over } = event;
  if (over && active.id !== over.id) {
    // 重新排序
  }
};
```

### 虚拟滚动优化要点

```typescript
// 使用 @tanstack/react-virtual
import { useVirtualizer } from '@tanstack/react-virtual';

const virtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 24, // 每行高度
  overscan: 10, // 预渲染数量
});
```

---

## 验收标准

### 阶段一验收标准
- [ ] SQLite 数据库正常初始化
- [ ] 日志文件能正常写入
- [ ] 日志文件自动分片功能正常
- [ ] 所有日志命令可通过 Tauri 调用

### 阶段二验收标准
- [ ] 命令组侧边栏正常显示
- [ ] 命令组 CRUD 操作正常
- [ ] 命令拖拽排序正常
- [ ] 点击命令可发送数据

### 阶段三验收标准
- [ ] 设置弹窗正常打开/关闭
- [ ] 字体大小调整实时生效
- [ ] 主题切换正常
- [ ] 设置持久化保存

### 阶段四验收标准
- [ ] 数据可导出为 TXT 格式
- [ ] 数据可导出为 CSV 格式
- [ ] 数据可导出为 JSON 格式
- [ ] 文件保存对话框正常

### 阶段五验收标准
- [ ] 自定义协议可配置
- [ ] 数据按协议解析显示
- [ ] 解析结果正确显示

### 阶段六验收标准
- [ ] 中文界面正常
- [ ] 英文界面正常
- [ ] 语言切换无需重启
