/**
 * HyperCom 全局状态管理 (Zustand)
 * 管理串口、标签页、配置、UI状态等所有全局数据
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
  SystemStatus,
  TrafficStats,
  UIState,
  PortMode,
} from '../types';
import { useTerminalStore } from './useTerminalStore';
import { naturalCompare, sortPortsByNatural } from '../utils/portSort';

// ==================== 分屏树辅助函数 ====================

/** 查找指定 ID 的叶子节点 */
export function findLeafById(node: PaneNode, id: string): LeafPane | undefined {
  if (node.type === 'leaf') {
    return node.id === id ? node : undefined;
  }
  for (const child of node.children) {
    const found = findLeafById(child, id);
    if (found) return found;
  }
  return undefined;
}

/** 查找包含指定标签页 ID 的叶子节点 */
export function findLeafByTabId(node: PaneNode, tabId: string): LeafPane | undefined {
  if (node.type === 'leaf') {
    return node.tabIds.includes(tabId) ? node : undefined;
  }
  for (const child of node.children) {
    const found = findLeafByTabId(child, tabId);
    if (found) return found;
  }
  return undefined;
}

/** 查找指定 ID 的分支节点 */
export function findBranchById(node: PaneNode, id: string): BranchPane | undefined {
  if (node.type === 'leaf') return undefined;
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findBranchById(child, id);
    if (found) return found;
  }
  return undefined;
}

/** 查找指定叶子节点的父分支节点 */
export function findParentBranch(node: PaneNode, leafId: string): BranchPane | undefined {
  if (node.type === 'leaf') return undefined;
  if (node.children.some(c => c.type === 'leaf' && c.id === leafId)) {
    return node;
  }
  for (const child of node.children) {
    if (child.type === 'branch') {
      const found = findParentBranch(child, leafId);
      if (found) return found;
    }
  }
  return undefined;
}

/** 收集树中所有叶子节点 */
export function collectLeaves(node: PaneNode): LeafPane[] {
  if (node.type === 'leaf') return [node];
  return node.children.flatMap(c => collectLeaves(c));
}

/** 统计树中叶子节点数量 */
export function countLeaves(node: PaneNode): number {
  if (node.type === 'leaf') return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

/**
 * 递归修剪分屏树：
 * - 移除空叶子节点（非根）
 * - 移除空分支节点
 * - 将只有 1 个子节点的分支折叠为该子节点（继承父分支的 size）
 * - 根节点若为空分支则替换为空叶子
 */
function pruneChildrenArray(children: PaneNode[]): PaneNode[] {
  const result: PaneNode[] = [];
  for (const child of children) {
    if (child.type === 'branch') {
      child.children = pruneChildrenArray(child.children);
      if (child.children.length === 0) {
        continue; // 丢弃空分支
      } else if (child.children.length === 1) {
        // 折叠：用唯一子节点替换此分支，继承 size
        const sole = child.children[0];
        sole.size = child.size;
        result.push(sole);
      } else {
        result.push(child);
      }
    } else {
      // 叶子节点 — 空则丢弃
      if (child.tabIds.length === 0) {
        continue;
      }
      result.push(child);
    }
  }
  return result;
}

function pruneTree(tree: PaneNode): PaneNode {
  if (tree.type === 'leaf') {
    return tree; // 根叶子保留（即使为空）
  }
  tree.children = pruneChildrenArray(tree.children);
  if (tree.children.length === 0) {
    return { id: 'main', type: 'leaf', tabIds: [], size: 1 };
  }
  if (tree.children.length === 1) {
    const sole = tree.children[0];
    sole.size = 1;
    return sole;
  }
  return tree;
}

// ==================== 默认配置 ====================

const defaultConfig: AppConfig = {
  closeBehavior: 'exit',
  // issue #6-2：总预算默认 2048MB（含 webview 占用），每端口默认 200MB
  memoryLimitMb: 2048,
  memoryPerPortBudgetMb: 200,
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
  defaultBaudRates: [9600, 19200, 38400, 57600, 115200, 921600],
  defaultLineEnding: '\\r\\n',
  // issue #7-3：终端已有 TX/RX 方向标识，发送提示前缀默认留空（功能保留，设置页可配）。
  sendPrefix: '',
  showPortType: true,
  sendOnEnter: true,
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

const defaultUIState: UIState = {
  isConfigOpen: false,
  configActiveTab: 'general',
  sidebarWidth: 260,
  // 200px 无法完整展示「发送区 + 参数区」两行控件（issue #2-6），
  // 提高到 280px 保证首次启动即完整可见（可拖拽范围仍为 [160, 600]）。
  operationPanelHeight: 280,
  isOperationPanelCollapsed: false,
  isHotkeyHelpOpen: false,
  isAboutOpen: false,
  sidebarCollapsed: false,
  // issue #12：更新弹窗初始关闭、无候选更新。
  isUpdateOpen: false,
  updateCandidate: null,
  // issue #12 复审：启动时 config 未就绪，loadConfig 完成后置 true。
  configReady: false,
};

// ==================== Store 状态定义 ====================

interface AppState {
  // --- 串口数据 ---
  ports: SerialPort[];
  groups: PortGroup[];
  
  // --- 标签页与分屏 ---
  tabs: TabItem[];
  paneTree: PaneNode;
  activeTabId: string | null;
  focusedPaneId: string;
  
  // --- 配置 ---
  config: AppConfig;
  
  // --- 系统状态 ---
  systemStatus: SystemStatus;
  trafficStats: Record<string, TrafficStats>;
  
  // --- 模拟模式 ---
  simulationMode: boolean;
  
  // --- UI状态 ---
  ui: UIState;
  
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
  
  // UI
  setUIState: (patch: Partial<UIState>) => void;
  toggleConfigModal: (open?: boolean) => void;
  setConfigActiveTab: (tab: string) => void;
  
  // 系统状态
  setSystemStatus: (status: Partial<SystemStatus>) => void;
  setTrafficStats: (portId: string, stats: Partial<TrafficStats>) => void;
  
  // 模拟模式
  setSimulationMode: (on: boolean) => void;
  
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

// ==================== Store 实现 ====================

export const useAppStore = create<AppState>()(
  immer((set) => ({
    // --- 初始状态 ---
    ports: [],
    groups: [],
    tabs: [],
    paneTree: { id: 'main', type: 'leaf', tabIds: [], size: 1 },
    activeTabId: null,
    focusedPaneId: 'main',
    config: { ...defaultConfig },
    systemStatus: {
      status: '运行正常',
      memoryUsedMb: 0,
      memoryLimitMb: 2048,
      cpuUsage: 0,
    },
    trafficStats: {},
    ui: { ...defaultUIState },
    simulationMode: false,
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
      const existing = state.tabs.find(t => t.id === portId);
      // Harden against a dangling focusedPaneId: verify it still exists in the
      // tree, otherwise fall back to the first leaf. Trusting a stale id would
      // push the tab to state.tabs without adding it to any leaf → orphan tab.
      const focusedLeaf = findLeafById(state.paneTree, state.focusedPaneId);
      const targetPaneId = focusedLeaf?.id || collectLeaves(state.paneTree)[0]?.id || 'main';
      if (!existing) {
        const port = state.ports.find(p => p.id === portId);
        const tab: TabItem = {
          id: portId,
          title: port ? `${port.id} ${port.alias || ''}`.trim() : portId,
          isPinned: false,
          isActive: true,
          splitPaneId: targetPaneId,
        };
        state.tabs.forEach(t => t.isActive = false);
        state.tabs.push(tab);
        state.activeTabId = portId;
        const leaf = findLeafById(state.paneTree, targetPaneId);
        if (leaf) leaf.tabIds.push(portId);
      } else {
        state.tabs.forEach(t => t.isActive = false);
        existing.isActive = true;
        state.activeTabId = portId;
        state.focusedPaneId = existing.splitPaneId;
      }
      });
    },
    
    closeTab: (tabId) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      const paneId = tab?.splitPaneId;
      state.tabs = state.tabs.filter(t => t.id !== tabId);
      if (paneId) {
        const leaf = findLeafById(state.paneTree, paneId);
        if (leaf) leaf.tabIds = leaf.tabIds.filter(id => id !== tabId);
      }
      state.paneTree = pruneTree(state.paneTree);
      if (state.activeTabId === tabId) {
        const remaining = state.tabs.length > 0 ? state.tabs[state.tabs.length - 1] : null;
        state.activeTabId = remaining?.id || null;
        if (remaining) state.focusedPaneId = remaining.splitPaneId;
      }
      const leaves = collectLeaves(state.paneTree);
      if (!leaves.find(l => l.id === state.focusedPaneId)) {
        state.focusedPaneId = leaves[0]?.id || 'main';
      }
    }),
    
    closeTabsToRight: (tabId) => set((state) => {
      // Pane-scoped: "right" is defined by the containing leaf's tabIds order
      // (the displayed order), NOT the global state.tabs index. Never touches
      // tabs in other panes.
      const leaf = findLeafByTabId(state.paneTree, tabId);
      if (!leaf) return;
      const idx = leaf.tabIds.indexOf(tabId);
      if (idx < 0) return;
      const removeIds = leaf.tabIds.slice(idx + 1).filter(id => {
        const tab = state.tabs.find(t => t.id === id);
        return tab !== undefined && !tab.isPinned;
      });
      if (removeIds.length === 0) return;
      const removeSet = new Set(removeIds);
      leaf.tabIds = leaf.tabIds.filter(id => !removeSet.has(id));
      state.tabs = state.tabs.filter(t => !removeSet.has(t.id));
      state.paneTree = pruneTree(state.paneTree);
      if (state.activeTabId && removeSet.has(state.activeTabId)) {
        state.activeTabId = tabId;
        state.focusedPaneId = state.tabs.find(t => t.id === tabId)?.splitPaneId || collectLeaves(state.paneTree)[0]?.id || 'main';
      }
      // Ensure focusedPaneId is valid after pruning
      const leaves = collectLeaves(state.paneTree);
      if (!leaves.find(l => l.id === state.focusedPaneId)) {
        state.focusedPaneId = leaves[0]?.id || 'main';
      }
    }),
    
    closeTabsToLeft: (tabId) => set((state) => {
      // Pane-scoped: "left" is defined by the containing leaf's tabIds order
      // (the displayed order), NOT the global state.tabs index. Never touches
      // tabs in other panes.
      const leaf = findLeafByTabId(state.paneTree, tabId);
      if (!leaf) return;
      const idx = leaf.tabIds.indexOf(tabId);
      if (idx <= 0) return;
      const removeIds = leaf.tabIds.slice(0, idx).filter(id => {
        const tab = state.tabs.find(t => t.id === id);
        return tab !== undefined && !tab.isPinned;
      });
      if (removeIds.length === 0) return;
      const removeSet = new Set(removeIds);
      leaf.tabIds = leaf.tabIds.filter(id => !removeSet.has(id));
      state.tabs = state.tabs.filter(t => !removeSet.has(t.id));
      state.paneTree = pruneTree(state.paneTree);
      if (state.activeTabId && removeSet.has(state.activeTabId)) {
        state.activeTabId = tabId;
        state.focusedPaneId = state.tabs.find(t => t.id === tabId)?.splitPaneId || collectLeaves(state.paneTree)[0]?.id || 'main';
      }
      // Ensure focusedPaneId is valid after pruning
      const leaves = collectLeaves(state.paneTree);
      if (!leaves.find(l => l.id === state.focusedPaneId)) {
        state.focusedPaneId = leaves[0]?.id || 'main';
      }
    }),
    
closeOtherTabs: (tabId) => set((state) => {
      const target = state.tabs.find(t => t.id === tabId);
      if (target) {
        const toRemove = state.tabs.filter(t => t.id !== tabId && !t.isPinned);
        for (const r of toRemove) {
          const leaf = findLeafById(state.paneTree, r.splitPaneId);
          if (leaf) leaf.tabIds = leaf.tabIds.filter(id => id !== r.id);
        }
        state.paneTree = pruneTree(state.paneTree);
        state.tabs = state.tabs.filter(t => t.id === tabId || t.isPinned);
        state.activeTabId = tabId;
        state.focusedPaneId = target.splitPaneId;
        // Ensure focusedPaneId is valid after pruning (target.splitPaneId may
        // reference a leaf that no longer exists in a degraded/inconsistent tree)
        const leaves = collectLeaves(state.paneTree);
        if (!leaves.find(l => l.id === state.focusedPaneId)) {
          state.focusedPaneId = leaves[0]?.id || 'main';
        }
      }
    }),
    
    pinTab: (tabId) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (tab) tab.isPinned = !tab.isPinned;
    }),
    
    setActiveTab: (tabId) => set((state) => {
      state.tabs.forEach(t => t.isActive = false);
      const tab = state.tabs.find(t => t.id === tabId);
      if (tab) {
        tab.isActive = true;
        state.activeTabId = tabId;
        state.focusedPaneId = tab.splitPaneId;
      }
    }),

    // detach 语义：标记标签已弹出到独立窗（主窗占位）/ 关窗回贴时清除。
    // 幂等——弹出窗关闭事件与主窗"收回"按钮都会调用，重复设置无副作用。
    setTabPoppedOut: (tabId, poppedOut) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (tab) tab.poppedOut = poppedOut;
    }),
    
    moveTabToPane: (tabId, paneId) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab) return;
      const oldPaneId = tab.splitPaneId;
      if (oldPaneId === paneId) return;
      // Remove from old leaf
      const oldLeaf = findLeafById(state.paneTree, oldPaneId);
      if (oldLeaf) oldLeaf.tabIds = oldLeaf.tabIds.filter(id => id !== tabId);
      // Add to new leaf
      const newLeaf = findLeafById(state.paneTree, paneId);
      if (newLeaf) {
        newLeaf.tabIds.push(tabId);
        tab.splitPaneId = paneId;
        state.focusedPaneId = paneId;
        state.activeTabId = tabId;
        state.tabs.forEach(t => t.isActive = false);
        tab.isActive = true;
      }
      // Prune tree (source leaf may have become empty)
      state.paneTree = pruneTree(state.paneTree);
      // Ensure focusedPaneId is valid after pruning
      const leaves = collectLeaves(state.paneTree);
      if (!leaves.find(l => l.id === state.focusedPaneId)) {
        state.focusedPaneId = leaves[0]?.id || 'main';
      }
    }),
    
    splitPane: (direction) => set((state) => {
      const activeTab = state.tabs.find(t => t.id === state.activeTabId);
      const sourceLeafId = activeTab?.splitPaneId || state.focusedPaneId;
      const sourceLeaf = findLeafById(state.paneTree, sourceLeafId);
      if (!sourceLeaf) return;

      const originalSize = sourceLeaf.size;
      const newLeafId = `pane-${Date.now()}`;

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
        id: `branch-${Date.now()}`,
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

      // Update focusedPaneId
      const leaves = collectLeaves(state.paneTree);
      if (!leaves.find(l => l.id === state.focusedPaneId)) {
        state.focusedPaneId = leaves[0]?.id || 'main';
      }
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
    
    setUIState: (patch) => set((state) => {
      Object.assign(state.ui, patch);
    }),
    
    toggleConfigModal: (open) => set((state) => {
      state.ui.isConfigOpen = open !== undefined ? open : !state.ui.isConfigOpen;
    }),
    
    setConfigActiveTab: (tab) => set((state) => {
      state.ui.configActiveTab = tab;
    }),
    
    setSystemStatus: (status) => set((state) => {
      Object.assign(state.systemStatus, status);
    }),
    
    setTrafficStats: (portId, stats) => set((state) => {
      if (!state.trafficStats[portId]) {
        state.trafficStats[portId] = { portId, txTotal: 0, rxTotal: 0 };
      }
      Object.assign(state.trafficStats[portId], stats);
    }),
    
    setSimulationMode: (on) => set((state) => {
      state.simulationMode = on;
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
        state.tabs = snapshot.tabs.map((t, i) => ({
          id: t.id,
          title: t.title,
          splitPaneId: t.splitPaneId,
          isPinned: t.isPinned,
          isActive: i === 0,
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
