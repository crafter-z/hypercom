/**
 * useAppStore — 串口列表 / 分组 / 标签页与分屏树 / 配置快照。
 *
 * 运行期系统态（`systemStatus` / `trafficStats` / `simulationMode` / `ui.*`）已拆到
 * `useSystemStore`：它们由 5s 探针、每端口每秒的流量 flush 与拖拽 mousemove 写入，
 * 与本 store 的订阅者（每个 Pane、OperationPanel、Sidebar）无关，混在一起会让
 * 每次流量 flush 都唤醒全部订阅者重跑选择器。
 *
 * `config` 是**启动时读入的只读快照**：实体数组（规则/命令集/预设/分组/元数据）的
 * 权威分别是 `useRuleStore`、后端 config.json 与 `groups` / `ports`，写路径统一走
 * `useConfigPersistence.saveConfig`（它负责拼装安全快照），不要在这里补实体回写。
 *
 * 分屏树算法在 `src/utils/paneTree.ts`，此处只做状态编排。
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  SerialPort,
  PortGroup,
  TabItem,
  PaneNode,
  LeafPane,
  BranchPane,
  AppConfig,
  PortMode,
} from '../types';
import { useTerminalStore } from './useTerminalStore';
import { naturalCompare, sortPortsByNatural } from '../utils/portSort';
import {
  collectLeaves,
  findBranchById,
  findLeafById,
  findLeafByTabId,
  findParentBranch,
  newPaneId,
  pruneTree,
} from '../utils/paneTree';

// ==================== 默认配置 ====================

const defaultConfig: AppConfig = {
  closeBehavior: 'exit',
  // issue #16：每端口终端最大显示行数（超限逐行覆盖最旧），默认 100000
  maxDisplayLines: 100000,
  language: 'zh-CN',
  theme: 'dark',
  preventScreenOff: false,
  preventSleep: false,
  autoReconnect: false,
  maxRetries: 3,
  terminalFont: 'Consolas, monospace',
  terminalFontSize: 14,
  uiFont: 'Inter, sans-serif',
  uiFontSize: 14,
  // 背景图（issue #13）：默认关闭；启用后全窗毛玻璃（透明度 50%，模糊 0px 起步）。
  backgroundImage: '',
  backgroundImageEnabled: false,
  backgroundImageOpacity: 50,
  backgroundImageBlur: 0,
  defaultBaudRates: [9600, 19200, 38400, 57600, 115200, 921600],
  defaultLineEnding: '\\r\\n',
  // issue #7-3：终端已有 TX/RX 方向标识，发送提示前缀默认留空（功能保留，设置页可配）。
  sendPrefix: '',
  showPortType: true,
  sendOnEnter: true,
  // issue #13：默认发送后保留输入框内容（用户决策）。
  clearSendInputAfterSend: false,
  quickSendInlineCount: 6,
  timestampMode: 'perLine',
  timestampFormat: 'absolute',
  autoSaveLog: true,
  logDirectory: '',
  logFilenameFormat: '[com]-[datetime]',
  logFormat: 'string',
  logEncoding: 'UTF-8',
  logSplitEnabled: true,
  logSplitSizeMb: 100,
  logIncludeTimestamp: true,
  logIncludeDirection: true,
  logSubdirMode: 'date',
  logNewFilePerSession: false,
  backupEnabled: false,
  backupInterval: 24,
  backupDirectory: '',
  restoreSession: true,
  diagLogEnabled: true,
  // issue #12：默认「定期检查到正式版」（用户决策，2026-08-15）。
  updateCheckMode: 'stable',
  sendCommandSets: [],
  highlightRuleSets: [],
  protocolTemplates: [],
  triggerRules: [],
  portPresets: [],
  portToolConfigs: [],
  portGroups: [],
  portMeta: [],
};

// ==================== Store 状态定义 ====================

/** store 状态形状（`sessionSnapshot` 等非 React 消费者按名字引用它，
 *  不要再写 `ReturnType<typeof useAppStore.getState>`——那个类型无法挂文档，
 *  且把调用方绑死在 action 的实现名上）。 */
export interface AppStoreState {
  // --- 串口数据 ---
  ports: SerialPort[];
  groups: PortGroup[];

  // --- 标签页与分屏 ---
  tabs: TabItem[];
  paneTree: PaneNode;
  /** 「活动标签」的**唯一**来源：渲染侧按 `tab.id === activeTabId` 派生，
   *  标签自身不再冗余存 isActive（双表示会漂移，且每次切换要遍历整个数组）。 */
  activeTabId: string | null;
  focusedPaneId: string;

  // --- 配置（只读快照）---
  config: AppConfig;

  // ==================== Actions ====================

  // 串口管理
  setPorts: (ports: SerialPort[]) => void;
  updatePort: (portId: string, patch: Partial<SerialPort>) => void;
  /** issue #11：设置端口工作模式（trx=传统收发 | tty=终端模式）。 */
  setPortMode: (portId: string, mode: PortMode) => void;
  /** 一次性载入持久化的分组列表（启动时从 config.portGroups 恢复）。 */
  setGroups: (groups: PortGroup[]) => void;
  addGroup: (group: PortGroup) => void;
  updateGroup: (groupId: string, patch: Partial<PortGroup>) => void;
  removeGroup: (groupId: string) => void;
  movePortToGroup: (portId: string, groupId: string | undefined) => void;

  // 标签页管理
  openTab: (portId: string) => void;
  closeTab: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  closeTabsToLeft: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  pinTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setTabPoppedOut: (tabId: string, poppedOut: boolean) => void;
  moveTabToPane: (tabId: string, paneId: string) => void;
  splitPane: (direction: 'horizontal' | 'vertical') => void;
  removePane: (paneId: string) => void;
  setFocusedPane: (paneId: string) => void;
  reorderPaneTabIds: (paneId: string, tabIds: string[]) => void;
  resizeChildren: (branchId: string, childIndex: number, deltaFraction: number) => void;

  // 配置
  setConfig: (patch: Partial<AppConfig>) => void;
  resetConfig: () => void;

  // 拖拽排序
  reorderPorts: (fromIndex: number, toIndex: number) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  /** issue #6-4：按端口号自然序一次性重排（非持久模式）。排序后仍可拖拽调整、
   *  操作分组；组内顺序随 save_port_groups 持久化，未分组顺序只影响本次会话。 */
  sortPortsByNumber: () => void;

  // 会话恢复
  restoreSessionSnapshot: (snapshot: {
    paneTree: PaneNode;
    tabs: Array<{ id: string; title: string; splitPaneId: string; isPinned: boolean }>;
  }) => void;
}

// ==================== 标签页关闭 / 焦点修复 ====================

/**
 * 关闭范围。`self` = 仅该标签（固定标签也允许显式关闭自己）；
 * `toLeft` / `toRight` = 所在叶子内左/右侧；`others` = 除该标签与固定标签外全部。
 */
export type CloseScope = 'self' | 'toLeft' | 'toRight' | 'others';

/**
 * 焦点必须指向树里真实存在的叶子。悬空 id 会让 `openTab` 把新标签推入 `state.tabs`
 * 却挂不到任何叶子（孤儿标签：存在但不显示、关不掉）。所有会改动 paneTree 的动作
 * 收尾都要调用它。
 */
function revalidateFocus(state: AppStoreState): void {
  const leaves = collectLeaves(state.paneTree);
  if (!leaves.some((l) => l.id === state.focusedPaneId)) {
    state.focusedPaneId = leaves[0]?.id ?? 'main';
  }
}

/** 按范围选出待关闭的标签 id（固定标签只被 `self` 显式关闭）。 */
function selectClosingTabIds(state: AppStoreState, tabId: string, scope: CloseScope): Set<string> {
  if (!state.tabs.some((t) => t.id === tabId)) return new Set();
  if (scope === 'self') return new Set([tabId]);

  const pinned = new Set(state.tabs.filter((t) => t.isPinned).map((t) => t.id));
  if (scope === 'others') {
    return new Set(state.tabs.filter((t) => t.id !== tabId && !pinned.has(t.id)).map((t) => t.id));
  }

  // toLeft / toRight 以**所属叶子的 tabIds 顺序**（即屏幕显示顺序）为准，
  // 绝不波及其它分屏里的标签。
  const leaf = findLeafByTabId(state.paneTree, tabId);
  if (!leaf) return new Set();
  const idx = leaf.tabIds.indexOf(tabId);
  if (idx < 0) return new Set();
  const side = scope === 'toRight' ? leaf.tabIds.slice(idx + 1) : leaf.tabIds.slice(0, idx);
  return new Set(side.filter((id) => !pinned.has(id)));
}

/**
 * 4 个关闭动作的唯一实现：从各叶子与全局列表移除 → 剪枝空叶子 → 修复
 * activeTabId / focusedPaneId。
 *
 * 活动标签被关掉时的接替者：`self` 取剩余列表的最后一个（关掉当前标签后落到
 * 最右侧标签），其余范围取被点击的那个标签（用户操作的中心）。
 */
function closeTabsImpl(state: AppStoreState, tabId: string, scope: CloseScope): void {
  const closing = selectClosingTabIds(state, tabId, scope);
  if (closing.size === 0) return;

  for (const leaf of collectLeaves(state.paneTree)) {
    if (leaf.tabIds.some((id) => closing.has(id))) {
      leaf.tabIds = leaf.tabIds.filter((id) => !closing.has(id));
    }
  }
  state.tabs = state.tabs.filter((t) => !closing.has(t.id));
  state.paneTree = pruneTree(state.paneTree);

  if (scope === 'others') {
    // 语义：被保留的标签成为唯一活动标签（固定标签不参与活动态），焦点跟随它，
    // 即使用户此前把焦点停在别的分屏的空输出区。
    state.activeTabId = tabId;
    const kept = state.tabs.find((t) => t.id === tabId);
    if (kept) state.focusedPaneId = kept.splitPaneId;
  } else if (state.activeTabId !== null && closing.has(state.activeTabId)) {
    const nextId = scope === 'self' ? (state.tabs[state.tabs.length - 1]?.id ?? null) : tabId;
    state.activeTabId = nextId;
    if (nextId !== null) {
      const nextTab = state.tabs.find((t) => t.id === nextId);
      if (nextTab) state.focusedPaneId = nextTab.splitPaneId;
    }
  }

  revalidateFocus(state);
}

/**
 * 纯查询：某个关闭动作会关掉哪些标签 id。与下面 4 个关闭动作**共用同一实现**
 * （`selectClosingTabIds`），调用方不必自己重推「叶子内顺序 + 固定标签」规则——
 * 推错一次就会漏回收被关标签的资源。
 *
 * 读的是调用瞬间的 store 状态：结果只对紧跟其后的那次关闭有效。
 */
export function getClosingTabIds(tabId: string, scope: CloseScope): string[] {
  return [...selectClosingTabIds(useAppStore.getState(), tabId, scope)];
}

// ==================== Store 实现 ====================

export const useAppStore = create<AppStoreState>()(
  immer((set) => ({
    // --- 初始状态 ---
    ports: [],
    groups: [],
    tabs: [],
    paneTree: { id: 'main', type: 'leaf', tabIds: [], size: 1 },
    activeTabId: null,
    focusedPaneId: 'main',
    config: { ...defaultConfig },

    // --- Actions ---

    setPorts: (ports) => set((state) => { state.ports = ports; }),

    updatePort: (portId, patch) => set((state) => {
      const port = state.ports.find(p => p.id === portId);
      if (port) {
        Object.assign(port, patch);
        // Update tab title when alias changes
        if ('alias' in patch || 'name' in patch) {
          const tab = state.tabs.find(t => t.id === portId);
          if (tab) {
            tab.title = `${port.id} ${port.alias || ''}`.trim();
          }
        }
      }
    }),

    // issue #11：直接写 port.mode，端口缺失时 no-op。
    setPortMode: (portId, mode) => set((state) => {
      const port = state.ports.find(p => p.id === portId);
      if (port) {
        Object.assign(port, { mode });
      }
    }),

    addGroup: (group) => set((state) => { state.groups.push(group); }),

    setGroups: (groups) => set((state) => { state.groups = groups; }),

    updateGroup: (groupId, patch) => set((state) => {
      const group = state.groups.find(g => g.id === groupId);
      if (group) Object.assign(group, patch);
    }),

    removeGroup: (groupId) => set((state) => {
      state.groups = state.groups.filter(g => g.id !== groupId);
      state.ports.forEach(p => { if (p.groupId === groupId) p.groupId = undefined; });
    }),

    movePortToGroup: (portId, groupId) => set((state) => {
      const port = state.ports.find(p => p.id === portId);
      if (!port) return;
      // Remove from old group
      if (port.groupId) {
        const oldGroup = state.groups.find(g => g.id === port.groupId);
        if (oldGroup) oldGroup.portIds = oldGroup.portIds.filter(id => id !== portId);
      }
      // Add to new group
      if (groupId) {
        const newGroup = state.groups.find(g => g.id === groupId);
        if (newGroup && !newGroup.portIds.includes(portId)) {
          newGroup.portIds.push(portId);
        }
      }
      port.groupId = groupId;
    }),

    openTab: (portId) => {
      useTerminalStore.getState().ensureTerminal(portId);
      set((state) => {
        // Harden against a dangling focusedPaneId: verify it still exists in the
        // tree, otherwise fall back to the first leaf. Trusting a stale id would
        // push the tab to state.tabs without adding it to any leaf → orphan tab.
        const focusedLeaf = findLeafById(state.paneTree, state.focusedPaneId);
        const targetPaneId = focusedLeaf?.id ?? collectLeaves(state.paneTree)[0]?.id ?? 'main';
        const existing = state.tabs.find(t => t.id === portId);
        if (existing) {
          state.activeTabId = portId;
          state.focusedPaneId = existing.splitPaneId;
          revalidateFocus(state);
          return;
        }
        const port = state.ports.find(p => p.id === portId);
        const tab: TabItem = {
          id: portId,
          title: port ? `${port.id} ${port.alias || ''}`.trim() : portId,
          isPinned: false,
          splitPaneId: targetPaneId,
        };
        state.tabs.push(tab);
        state.activeTabId = portId;
        findLeafById(state.paneTree, targetPaneId)?.tabIds.push(portId);
      });
    },

    closeTab: (tabId) => set((state) => closeTabsImpl(state, tabId, 'self')),

    closeTabsToRight: (tabId) => set((state) => closeTabsImpl(state, tabId, 'toRight')),

    closeTabsToLeft: (tabId) => set((state) => closeTabsImpl(state, tabId, 'toLeft')),

    closeOtherTabs: (tabId) => set((state) => closeTabsImpl(state, tabId, 'others')),

    pinTab: (tabId) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (tab) tab.isPinned = !tab.isPinned;
    }),

    setActiveTab: (tabId) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab) return;
      state.activeTabId = tabId;
      state.focusedPaneId = tab.splitPaneId;
    }),

    // detach 语义：标记标签已弹出到独立窗（主窗占位）/ 关窗回贴时清除。
    // 幂等——弹出窗关闭事件与主窗"收回"按钮都会调用，重复设置无副作用。
    setTabPoppedOut: (tabId, poppedOut) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (tab) tab.poppedOut = poppedOut;
    }),

    moveTabToPane: (tabId, paneId) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab || tab.splitPaneId === paneId) return;
      const newLeaf = findLeafById(state.paneTree, paneId);
      // 目标叶子不存在时直接放弃：先摘后挂的写法会在这一步把标签从源叶子摘掉
      // 却挂不回去（标签留在 state.tabs、树里没有它 → 孤儿）。
      if (!newLeaf) return;
      const oldLeaf = findLeafById(state.paneTree, tab.splitPaneId);
      if (oldLeaf) oldLeaf.tabIds = oldLeaf.tabIds.filter(id => id !== tabId);
      newLeaf.tabIds.push(tabId);
      tab.splitPaneId = paneId;
      state.focusedPaneId = paneId;
      state.activeTabId = tabId;
      // Prune tree (source leaf may have become empty)
      state.paneTree = pruneTree(state.paneTree);
      revalidateFocus(state);
    }),

    splitPane: (direction) => set((state) => {
      const activeTab = state.tabs.find(t => t.id === state.activeTabId);
      const sourceLeafId = activeTab?.splitPaneId || state.focusedPaneId;
      const sourceLeaf = findLeafById(state.paneTree, sourceLeafId);
      if (!sourceLeaf) return;

      const originalSize = sourceLeaf.size;
      const newLeafId = newPaneId('pane');

      // Move active tab from source leaf to new leaf
      if (activeTab) {
        sourceLeaf.tabIds = sourceLeaf.tabIds.filter(id => id !== activeTab.id);
        activeTab.splitPaneId = newLeafId;
      }
      sourceLeaf.size = 0.5;

      const newLeaf: LeafPane = {
        id: newLeafId,
        type: 'leaf',
        tabIds: activeTab ? [activeTab.id] : [],
        size: 0.5,
      };

      const newBranch: BranchPane = {
        id: newPaneId('branch'),
        type: 'branch',
        direction,
        children: [sourceLeaf, newLeaf],
        size: originalSize,
      };

      // Find parent branch and replace source leaf with new branch
      const parentBranch = findParentBranch(state.paneTree, sourceLeafId);
      if (parentBranch) {
        const idx = parentBranch.children.findIndex(c => c.id === sourceLeafId);
        if (idx >= 0) {
          parentBranch.children[idx] = newBranch;
        }
      } else {
        // Source leaf is the root — wrap it in a new branch
        newBranch.size = 1;
        state.paneTree = newBranch;
      }

      state.focusedPaneId = newLeafId;
    }),

    removePane: (paneId) => set((state) => {
      // Find the parent branch of this leaf
      const parentBranch = findParentBranch(state.paneTree, paneId);
      if (!parentBranch) return; // root leaf — cannot remove

      const removedLeaf = parentBranch.children.find(c => c.id === paneId);
      if (!removedLeaf || removedLeaf.type !== 'leaf') return;

      const removedSize = removedLeaf.size;

      // Move tabs from removed leaf to the first remaining leaf in the tree
      const allLeavesBefore = collectLeaves(state.paneTree);
      const targetLeaf = allLeavesBefore.find(l => l.id !== paneId);
      if (targetLeaf && removedLeaf.tabIds.length > 0) {
        for (const tabId of removedLeaf.tabIds) {
          const tab = state.tabs.find(t => t.id === tabId);
          if (tab) {
            tab.splitPaneId = targetLeaf.id;
            targetLeaf.tabIds.push(tabId);
          }
        }
      }

      // Remove leaf from parent's children
      parentBranch.children = parentBranch.children.filter(c => c.id !== paneId);

      // Redistribute removed size equally among remaining siblings
      const remaining = parentBranch.children;
      if (remaining.length > 0) {
        const addSize = removedSize / remaining.length;
        remaining.forEach(c => { c.size += addSize; });
      }

      // Prune tree (collapse branches with ≤1 child)
      state.paneTree = pruneTree(state.paneTree);
      revalidateFocus(state);
    }),

    setFocusedPane: (paneId) => set((state) => {
      state.focusedPaneId = paneId;
    }),

    reorderPaneTabIds: (paneId, tabIds) => set((state) => {
      const leaf = findLeafById(state.paneTree, paneId);
      if (leaf) leaf.tabIds = tabIds;
    }),

    resizeChildren: (branchId, childIndex, deltaFraction) => set((state) => {
      const branch = findBranchById(state.paneTree, branchId);
      if (!branch || childIndex < 0 || childIndex >= branch.children.length - 1) return;
      const a = branch.children[childIndex];
      const b = branch.children[childIndex + 1];
      let newA = a.size + deltaFraction;
      let newB = b.size - deltaFraction;
      // Clamp 0.15–0.85
      if (newA < 0.15) { newB -= (0.15 - newA); newA = 0.15; }
      if (newA > 0.85) { newB += (newA - 0.85); newA = 0.85; }
      if (newB < 0.15) { newA -= (0.15 - newB); newB = 0.15; }
      if (newB > 0.85) { newA += (newB - 0.85); newB = 0.85; }
      a.size = newA;
      b.size = newB;
    }),

    setConfig: (patch) => set((state) => {
      Object.assign(state.config, patch);
    }),

    resetConfig: () => set((state) => {
      state.config = { ...defaultConfig };
    }),

    reorderPorts: (fromIndex, toIndex) => set((state) => {
      if (
        fromIndex < 0 || fromIndex >= state.ports.length ||
        toIndex < 0 || toIndex >= state.ports.length
      ) return;
      const [moved] = state.ports.splice(fromIndex, 1);
      state.ports.splice(toIndex, 0, moved);
    }),

    // issue #6-4：排序是一次性动作而非持久开关——直接重排 ports 数组并同步重排
    // 各分组 portIds（组内顺序随 save_port_groups 自动持久化）。排序后拖拽/分组
    // 操作照常可用（不再有 sortMode 禁用拖拽的窗口期）。
    sortPortsByNumber: () => set((state) => {
      state.ports = sortPortsByNatural(state.ports);
      for (const group of state.groups) {
        group.portIds = [...group.portIds].sort(naturalCompare);
      }
    }),

    reorderTabs: (fromIndex, toIndex) => set((state) => {
      if (
        fromIndex < 0 || fromIndex >= state.tabs.length ||
        toIndex < 0 || toIndex >= state.tabs.length
      ) return;
      const [moved] = state.tabs.splice(fromIndex, 1);
      state.tabs.splice(toIndex, 0, moved);
    }),

    restoreSessionSnapshot: (snapshot) => {
      for (const tab of snapshot.tabs) {
        useTerminalStore.getState().ensureTerminal(tab.id);
      }
      set((state) => {
        state.tabs = snapshot.tabs.map((t) => ({
          id: t.id,
          title: t.title,
          splitPaneId: t.splitPaneId,
          isPinned: t.isPinned,
        }));

        // Sanitize restored tree: each leaf's tabIds must only reference
        // tabs present in the restored array. pruneTree then drops any
        // leaves that became empty and validates the structure.
        const validTabIds = new Set(state.tabs.map(t => t.id));
        const sanitize = (node: PaneNode): PaneNode => {
          if (node.type === 'leaf') {
            return { ...node, tabIds: node.tabIds.filter(id => validTabIds.has(id)) };
          }
          return { ...node, children: node.children.map(sanitize) };
        };
        state.paneTree = pruneTree(sanitize(snapshot.paneTree));

        if (snapshot.tabs.length > 0) {
          state.activeTabId = snapshot.tabs[0].id;
          const targetPaneId = snapshot.tabs[0].splitPaneId;
          state.focusedPaneId = findLeafById(state.paneTree, targetPaneId)
            ? targetPaneId
            : collectLeaves(state.paneTree)[0]?.id ?? 'main';
        } else {
          state.activeTabId = null;
          state.focusedPaneId = 'main';
        }
      });
    },

  }))
);
