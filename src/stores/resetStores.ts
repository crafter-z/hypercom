/**
 * resetStoresForTests — 六个全局 store 的统一重置入口。**仅供测试**引用。
 *
 * 各测试原先各自手抄「这个 store 的哪些字段该回到默认值」（useAppStore.test.ts 里
 * 抄了 13 个字段 + 另外三个 store 的 12 个字段）。那种写法漏一个字段就会让上一个
 * 用例的残留污染下一个用例，症状还出现在无关的用例里；新增字段时更是必然漏。
 *
 * 这里在模块加载时抓一份**初始状态快照**（含 action），重置时整体替换：
 * 字段增删自动跟随。六个 store 的写入都是不可变更新（immer 或显式展开），所以
 * 快照对象不会被用例写坏。
 */
import { useAppStore } from './useAppStore';
import { useOperationStore } from './useOperationStore';
import { useRuleStore } from './useRuleStore';
import { useSystemStore } from './useSystemStore';
import { useTerminalStore } from './useTerminalStore';
import { useToastStore } from './useToastStore';

const INITIAL_STATE = {
  app: useAppStore.getState(),
  system: useSystemStore.getState(),
  terminal: useTerminalStore.getState(),
  rule: useRuleStore.getState(),
  operation: useOperationStore.getState(),
  toast: useToastStore.getState(),
};

export function resetStoresForTests(): void {
  // replace = true：整份替换（而非浅合并），这样「用例删掉过的字段」也会长回来。
  useAppStore.setState(INITIAL_STATE.app, true);
  useSystemStore.setState(INITIAL_STATE.system, true);
  useTerminalStore.setState(INITIAL_STATE.terminal, true);
  useRuleStore.setState(INITIAL_STATE.rule, true);
  useOperationStore.setState(INITIAL_STATE.operation, true);
  useToastStore.setState(INITIAL_STATE.toast, true);
}
