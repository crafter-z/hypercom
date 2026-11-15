# `src/stores/`

Zustand 状态按领域拆分；组件和 hook 必须用 selector 订阅，回调或 effect 需要实时值时使用 `useXxxStore.getState()`。

## 导航

| 文件 | 负责 |
|---|---|
| `useAppStore.ts` | 端口、分组、标签、`paneTree`、配置基线与普通设置草稿；`getTabPortId` / `getActivePortId` 解析发送端口，`getClosingTabIds` 统一关闭范围 |
| `useSystemStore.ts` | `systemStatus`、`trafficStats`、`simulationMode`、`ui` 等高频运行态 |
| `useOperationStore.ts` | 串口参数、发送输入和按端口的循环运行态；不放显示字段或全局循环间隔 |
| `useTerminalStore.ts` | 按端口的显示设置：滚动锁、时间戳、格式、编码、ASCII 噪声可见性、软换行、连接时间；行缓冲在 `src/utils/terminal/viewportManager.ts` |
| `useRuleStore.ts` | 已提交的高亮、命令、协议、触发器、工具运行态和活动命令集；编辑草稿在 `src/utils/entityEditor.ts` |
| `useToastStore.ts` | 宿主通知与插件通知；插件必须通过 `pushPlugin` |
| `src/stores/releaseTerminalState.ts` / `src/stores/resetStores.ts` | 关闭标签后的端口显示资源回收；测试用 `resetStoresForTests` 整组 store 快照重置 |

## 必守规则

- `activeTabId` 是活动标签唯一来源；`TabItem` 不重复保存活动标记。
- `paneTree` 的算法在 `src/utils/paneTree.ts`。状态变更使用 `splitPane`、`closeTab`、`resizeChildren` 等 action；每次树变更都保持 `focusedPaneId` 指向真实叶子。
- 关闭标签的范围必须来自 `src/stores/useAppStore.ts` 的 `getClosingTabIds(tabId, scope)`，范围按所属叶子顺序计算，不要在组件中重新筛选。关闭标签而非断开端口时，清理走 `src/stores/releaseTerminalState.ts` 的 `releaseTerminalState(portId)`；断开仍走 `src/hooks/useSerialConnection.ts` 的 `useSerialConnection.closePort()`。
- `src/utils/terminal/viewportManager.ts` 的 `appendTerminalLines` 是批量入口，不把行数组放回 Zustand，也不实现逐行 `shift`、字节预算或额外内存闸门。
- 显示字段只属于 `src/stores/useTerminalStore.ts` 的 `useTerminalStore`；`sendOnEnter`、`quickSendInlineCount` 等普通设置只属于 `src/stores/useAppStore.ts` 的 `config`；不要在 `useOperationStore` 复制这些字段。
- 配置、实体、分组、端口元数据和预设保存统一经过 `src/utils/configWriteQueue.ts` 与 revision CAS；保存成功后才推进基线和 `useRuleStore`，失败或迟到响应保留草稿。
- 插件状态只接受 `src/utils/pluginConfigSnapshot.ts` 的后端带 revision 快照；安装身份变化会使旧授权和缓存失效，不得从规则实体基线恢复插件权限。
- 测试使用 `resetStoresForTests()`，不要手抄默认状态；高频 hook 不得无 selector 订阅整个 store。

## 常用检查

```bash
npx vitest run src/stores
npx tsc --noEmit
```

## 反模式

- 订阅整 store。
- 手动写 `paneTree` 或访问已不存在的 `state.panes`。
- 把显示设置、系统高频态或 `op` 前缀字段重新放进错误的 store。
- 绕过统一配置保存边界，直接在页面执行 CRUD、自动保存或卸载保存。
