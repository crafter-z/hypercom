# `src/components/ConfigModal/`

设置模态框按页面和编辑器拆分。配置页面修改会话草稿，只有统一保存链路接受后才更新持久化基线和运行态。

## 导航

| 路径 | 责任 |
|---|---|
| `ConfigModal.tsx` | 页面切换、全量保存和共享关闭守卫 |
| `hooks/useEntityPage.ts` | 规则实体的统一草稿 API |
| `RuleSetAccordion.tsx` | 可排序实体行、行/集合保存与脏状态 |
| `pages/GeneralSettings.tsx` | 通用显示、语言、主题、电源、重连、Enter 行为、字体和更新设置 |
| `pages/LogSettings.tsx` | 日志路径、分片、目录、格式、编码和会话文件设置 |
| `pages/BackupSettings.tsx` | 配置备份导入导出；不导入插件代码或私有数据 |
| `pages/DisplaySettings.tsx` | 默认波特率、行尾、时间戳、端口类型和背景图 |
| `pages/HighlightSettings.tsx` / `pages/CommandSettings.tsx` | 高亮规则、命令集和命令步骤 |
| `pages/ProtocolSettings.tsx` / `pages/ToolSettings.tsx` / `pages/TriggerSettings.tsx` | 协议模板、外部工具、触发规则 |
| `pages/PluginSettings.tsx` | 插件安装、升级、卸载、权限、信任和代理 |
| `editors/HighlightRuleEditor.tsx` | 高亮规则编辑和安全颜色预览 |
| `editors/SendCmdEditor.tsx` | 发送/参数步骤编辑和等待字段 |
| `editors/ProtocolTemplateEditor.tsx` | 协议模板字段和配置摘要 |

## 实体页面契约

- 五类运行规则页面使用 `src/components/ConfigModal/hooks/useEntityPage.ts` 的 `useEntityPage({ kind })`；不要直接编辑 `src/stores/useRuleStore.ts` 或 `src/stores/useAppStore.ts` 的 `config` 基线数组。
- 草稿、展开行和脏状态跨页面卸载保留；挂载不能用基线覆盖未保存草稿。
- 创建、更新、删除、启用和排序先进入草稿。`save(id)` 只提交实体，`save()` 提交集合；页脚保存提交所有类别。
- 丢弃只影响请求范围。取消、X、Escape 和原生关闭都经过共享 Save/Discard/Continue 守卫；保存失败、冲突或产生新编辑时不能关闭。
- 行排序使用 `src/components/shared/SortableEditorList.tsx` 的 `SortableEditorList`，命令顺序使用 `src/utils/commandOrder.ts` 的 `orderedCommands` / `normalizeCommandOrder`；数组顺序是管理列表的权威，不能把对象属性顺序当成编辑。

## 必守规则

- 所有普通配置、实体、预设和备份写入经过 `src/utils/configWriteQueue.ts` 的 `enqueueConfigWrite`、revision CAS 和 ACK；成功后才发布 `src/stores/useRuleStore.ts` 的运行态。失败或迟到响应保留草稿，不能回退更高 revision。插件动作遵循后端权威快照。
- 数字输入范围来自 `src/utils/bounds.ts` 的 `CONFIG_BOUNDS`；Rust 镜像由 `src/utils/bounds.test.ts` 守卫。页面私有范围定义一次，同时用于 `clampNumber` 与输入属性。
- HEX 命令不追加文本行尾；发送区、弹窗和命令编辑器共享 `src/utils/hexUtils.ts` / `src/utils/hexFormat.ts`，非法 HEX 保留输入并显示错误，不补零。
- 编辑器组件必须在模块级定义；页面文字通过 `useTranslation().t()`，协议词、编码名和单位保持原文。
- 备份导入先确认破坏性替换，读取后端权威状态并通过同一写入队列；只为相同 `installGeneration` 恢复插件授权。
- 插件设置操作绑定用户审阅的 `installGeneration`，列表和变更按后端 revision；关闭/卸载等长操作必须先呈现状态，再等待后端结果。

## 常用检查

```bash
npx vitest run src/components/ConfigModal
npx tsc --noEmit
```

## 反模式

- 订阅整个 `useRuleStore`，直接改运行态或持久化基线。
- 页面自建 CRUD、自动保存、卸载保存或额外脏状态。
- 在页面函数体内声明编辑器组件，或硬编码未翻译文本。
- 绕过 CAS/关闭守卫，或把旧插件快照、旧 revision 写回当前状态。
