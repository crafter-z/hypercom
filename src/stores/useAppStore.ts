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
  SplitPane,
  AppConfig,
  SystemStatus,
  TrafficStats,
  UIState,
} from '../types';
import { useTerminalStore } from './useTerminalStore';

// ==================== 默认配置 ====================

const defaultConfig: AppConfig = {
  closeBehavior: 'minimize',
  memoryLimitMb: 1024,
  language: 'zh-CN',
  theme: 'dark',
  preventScreenOff: false,
  preventSleep: false,
  terminalFont: 'Consolas, monospace',
  terminalFontSize: 14,
  uiFont: 'Inter, sans-serif',
  uiFontSize: 14,
  defaultBaudRates: [9600, 19200, 38400, 57600, 115200, 921600],
  defaultLineEnding: '\\r\\n',
  sendPrefix: '>>>>>>SEND>>>>>>>>',
  showPortType: true,
  timestampMode: 'perLine',
  autoSaveLog: false,
  logDirectory: '',
  logFilenameFormat: '[com]-[datetime]',
  logFormat: 'string',
  logEncoding: 'UTF-8',
  logSplitEnabled: false,
  logSplitSizeMb: 100,
  backupEnabled: false,
  backupInterval: 24,
  backupDirectory: '',
};

const defaultUIState: UIState = {
  isConfigOpen: false,
  configActiveTab: 'general',
  sidebarWidth: 260,
  operationPanelHeight: 280,
  isOperationPanelCollapsed: false,
};

function removeEmptyPanes(panes: SplitPane[]): SplitPane[] {
  if (panes.length <= 1) return panes;
  const nonEmptyPanes = panes.filter((pane) => pane.tabIds.length > 0);
  return nonEmptyPanes.length > 0 ? nonEmptyPanes : [panes[0]];
}

// ==================== Store 状态定义 ====================

interface AppState {
  // --- 串口数据 ---
  ports: SerialPort[];
  groups: PortGroup[];
  
  // --- 标签页与分屏 ---
  tabs: TabItem[];
  panes: SplitPane[];
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
  moveTabToPane: (tabId: string, paneId: string) => void;
  splitPane: (direction: 'horizontal' | 'vertical') => void;
  removePane: (paneId: string) => void;
  setFocusedPane: (paneId: string) => void;
  reorderPaneTabIds: (paneId: string, tabIds: string[]) => void;
  
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
  
}

// ==================== Store 实现 ====================

export const useAppStore = create<AppState>()(
  immer((set) => ({
    // --- 初始状态 ---
    ports: [],
    groups: [],
    tabs: [],
    panes: [{ id: 'main', direction: 'vertical', tabIds: [], size: 1 }],
    activeTabId: null,
    focusedPaneId: 'main',
    config: { ...defaultConfig },
    systemStatus: {
      status: '运行正常',
      memoryUsedMB: 0,
      memoryLimitMb: 1024,
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
    
    addGroup: (group) => set((state) => { state.groups.push(group); }),
    
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
      const targetPaneId = state.focusedPaneId || state.panes[0]?.id || 'main';
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
        const pane = state.panes.find(p => p.id === targetPaneId);
        if (pane) pane.tabIds.push(portId);
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
        const pane = state.panes.find(p => p.id === paneId);
        if (pane) pane.tabIds = pane.tabIds.filter(id => id !== tabId);
        if (pane && pane.tabIds.length === 0 && state.panes.length > 1) {
          state.panes = state.panes.filter(p => p.id !== paneId);
          if (state.focusedPaneId === paneId) {
            state.focusedPaneId = state.panes[0]?.id || 'main';
          }
        }
      }
      if (state.activeTabId === tabId) {
        const remaining = state.tabs.length > 0 ? state.tabs[state.tabs.length - 1] : null;
        state.activeTabId = remaining?.id || null;
        if (remaining) state.focusedPaneId = remaining.splitPaneId;
      }
    }),
    
    closeTabsToRight: (tabId) => set((state) => {
      const idx = state.tabs.findIndex(t => t.id === tabId);
      if (idx >= 0) {
        const toRemove = state.tabs.slice(idx + 1).filter(t => !t.isPinned);
        state.tabs = state.tabs.filter((t, i) => i <= idx || t.isPinned);
        for (const r of toRemove) {
          const pane = state.panes.find(p => p.id === r.splitPaneId);
          if (pane) pane.tabIds = pane.tabIds.filter(id => id !== r.id);
        }
        state.panes = removeEmptyPanes(state.panes);
        if (state.activeTabId && toRemove.some(r => r.id === state.activeTabId)) {
          state.activeTabId = tabId;
          state.focusedPaneId = state.tabs.find(t => t.id === tabId)?.splitPaneId || 'main';
        }
      }
    }),
    
    closeTabsToLeft: (tabId) => set((state) => {
      const idx = state.tabs.findIndex(t => t.id === tabId);
      if (idx > 0) {
        const toRemove = state.tabs.slice(0, idx).filter(t => !t.isPinned);
        state.tabs = state.tabs.filter((t, i) => i >= idx || t.isPinned);
        for (const r of toRemove) {
          const pane = state.panes.find(p => p.id === r.splitPaneId);
          if (pane) pane.tabIds = pane.tabIds.filter(id => id !== r.id);
        }
        state.panes = removeEmptyPanes(state.panes);
        if (state.activeTabId && toRemove.some(r => r.id === state.activeTabId)) {
          state.activeTabId = tabId;
          state.focusedPaneId = state.tabs.find(t => t.id === tabId)?.splitPaneId || 'main';
        }
      }
    }),
    
    closeOtherTabs: (tabId) => set((state) => {
      const target = state.tabs.find(t => t.id === tabId);
      if (target) {
        const toRemove = state.tabs.filter(t => t.id !== tabId && !t.isPinned);
        for (const r of toRemove) {
          const pane = state.panes.find(p => p.id === r.splitPaneId);
          if (pane) pane.tabIds = pane.tabIds.filter(id => id !== r.id);
        }
        state.panes = removeEmptyPanes(state.panes);
        state.tabs = state.tabs.filter(t => t.id === tabId || t.isPinned);
        state.activeTabId = tabId;
        state.focusedPaneId = target.splitPaneId;
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
    
    moveTabToPane: (tabId, paneId) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab) return;
      const oldPaneId = tab.splitPaneId;
      if (oldPaneId === paneId) return;
      // Remove from old pane
      const oldPane = state.panes.find(p => p.id === oldPaneId);
      if (oldPane) oldPane.tabIds = oldPane.tabIds.filter(id => id !== tabId);
      // Add to new pane
      const newPane = state.panes.find(p => p.id === paneId);
      if (newPane) {
        newPane.tabIds.push(tabId);
        tab.splitPaneId = paneId;
        state.focusedPaneId = paneId;
        state.activeTabId = tabId;
        state.tabs.forEach(t => t.isActive = false);
        tab.isActive = true;
      }
      // Remove empty old pane
      if (oldPane && oldPane.tabIds.length === 0 && state.panes.length > 1) {
        state.panes = state.panes.filter(p => p.id !== oldPaneId);
        if (state.focusedPaneId === oldPaneId) {
          state.focusedPaneId = paneId;
        }
      }
    }),
    
    splitPane: (direction) => set((state) => {
      const activeTab = state.tabs.find(t => t.id === state.activeTabId);
      const sourcePaneId = activeTab?.splitPaneId || state.focusedPaneId;
      const newPaneId = `pane-${Date.now()}`;
      const sourcePane = state.panes.find(p => p.id === sourcePaneId);
      
      // Reduce size of source pane and sync direction
      if (sourcePane) {
        sourcePane.size = 0.5;
        sourcePane.direction = direction;
      }
      
      // Create new pane
      const newPane: SplitPane = {
        id: newPaneId,
        direction,
        tabIds: activeTab ? [activeTab.id] : [],
        size: 0.5,
      };
      state.panes.push(newPane);
      
      // Move active tab to new pane
      if (activeTab && sourcePane) {
        sourcePane.tabIds = sourcePane.tabIds.filter(id => id !== activeTab.id);
        activeTab.splitPaneId = newPaneId;
        state.focusedPaneId = newPaneId;
      }
    }),
    
    removePane: (paneId) => set((state) => {
      if (state.panes.length <= 1) return;
      const pane = state.panes.find(p => p.id === paneId);
      if (pane) {
        // Move tabs to main pane
        const mainPane = state.panes.find(p => p.id !== paneId);
        if (mainPane) {
          for (const tabId of pane.tabIds) {
            const tab = state.tabs.find(t => t.id === tabId);
            if (tab) {
              tab.splitPaneId = mainPane.id;
              mainPane.tabIds.push(tabId);
            }
          }
          mainPane.size = 1;
        }
        state.panes = state.panes.filter(p => p.id !== paneId);
        state.focusedPaneId = state.panes[0]?.id || 'main';
      }
    }),
    
    setFocusedPane: (paneId) => set((state) => {
      state.focusedPaneId = paneId;
    }),

    reorderPaneTabIds: (paneId, tabIds) => set((state) => {
      const pane = state.panes.find(p => p.id === paneId);
      if (pane) pane.tabIds = tabIds;
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
      const [moved] = state.ports.splice(fromIndex, 1);
      state.ports.splice(toIndex, 0, moved);
    }),

    reorderTabs: (fromIndex, toIndex) => set((state) => {
      const [moved] = state.tabs.splice(fromIndex, 1);
      state.tabs.splice(toIndex, 0, moved);
    }),

  }))
);
