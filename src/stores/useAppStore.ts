/**
 * HyperCom 全局状态管理 (Zustand)
 * 管理串口、标签页、配置、UI状态等所有全局数据
 * 
 * TODO: 安装依赖后启用
 * npm install zustand
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  SerialPort,
  PortGroup,
  TabItem,
  SplitPane,
  TerminalState,
  HighlightRuleSet,
  SendCommandSet,
  AppConfig,
  SystemStatus,
  TrafficStats,
  UIState,
  DisplayFormat,
  Encoding,
  LineEnding,
  DataBits,
  Parity,
  StopBits,
  Handshake,
} from '../types';

// ==================== 默认配置 ====================

const defaultConfig: AppConfig = {
  closeBehavior: 'minimize',
  memoryLimitMB: 1024,
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
  logSplitSizeMB: 100,
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

// ==================== Store 状态定义 ====================

interface AppState {
  // --- 串口数据 ---
  ports: SerialPort[];
  groups: PortGroup[];
  
  // --- 标签页与分屏 ---
  tabs: TabItem[];
  panes: SplitPane[];
  activeTabId: string | null;
  
  // --- 终端内容 (按串口ID索引) ---
  terminals: Record<string, TerminalState>;
  
  // --- 规则集 ---
  highlightRuleSets: HighlightRuleSet[];
  activeHighlightSetId: string | null;
  sendCommandSets: SendCommandSet[];
  activeSendCommandSetId: string | null;
  
  // --- 配置 ---
  config: AppConfig;
  
  // --- 系统状态 ---
  systemStatus: SystemStatus;
  trafficStats: Record<string, TrafficStats>;
  
  // --- UI状态 ---
  ui: UIState;
  
  // --- 操作区状态 (当前激活串口) ---
  opBaudRate: number;
  opDataBits: DataBits;
  opParity: Parity;
  opStopBits: StopBits;
  opHandshake: Handshake;
  opDtr: boolean;
  opRts: boolean;
  opIgnoreEmptyChars: boolean;
  opScrollLocked: boolean;
  opShowTimestamp: boolean;
  opDisplayFormat: DisplayFormat;
  opEncoding: Encoding;
  opSendIsHex: boolean;
  opSendAppendLineEnding: LineEnding;
  opSendInput: string;
  opIsLoopSending: boolean;
  
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
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  
  // 终端内容
  appendTerminalLine: (portId: string, line: TerminalState['lines'][number]) => void;
  clearTerminal: (portId: string) => void;
  setTerminalConfig: (portId: string, patch: Partial<TerminalState>) => void;
  
  // 配置
  setConfig: (patch: Partial<AppConfig>) => void;
  resetConfig: () => void;
  
  // UI
  setUIState: (patch: Partial<UIState>) => void;
  toggleConfigModal: (open?: boolean) => void;
  setConfigActiveTab: (tab: string) => void;
  
  // 操作区
  setOpState: (patch: Partial<Pick<AppState, 
    'opBaudRate' | 'opDataBits' | 'opParity' | 'opStopBits' | 'opHandshake' |
    'opDtr' | 'opRts' | 'opIgnoreEmptyChars' | 'opScrollLocked' | 'opShowTimestamp' |
    'opDisplayFormat' | 'opEncoding' | 'opSendIsHex' | 'opSendAppendLineEnding' |
    'opSendInput' | 'opIsLoopSending'
  >>) => void;
  
  // 系统状态
  setSystemStatus: (status: Partial<SystemStatus>) => void;
  setTrafficStats: (portId: string, stats: Partial<TrafficStats>) => void;
}

// ==================== Store 实现 ====================

export const useAppStore = create<AppState>()(
  immer((set) => ({
    // --- 初始状态 ---
    ports: [],
    groups: [],
    tabs: [],
    panes: [{ id: 'main', direction: 'horizontal', tabIds: [], size: 1 }],
    activeTabId: null,
    terminals: {},
    highlightRuleSets: [],
    activeHighlightSetId: null,
    sendCommandSets: [],
    activeSendCommandSetId: null,
    config: { ...defaultConfig },
    systemStatus: {
      status: '运行正常',
      memoryUsedMB: 0,
      memoryLimitMB: 1024,
      cpuUsage: 0,
    },
    trafficStats: {},
    ui: { ...defaultUIState },
    opBaudRate: 115200,
    opDataBits: 8,
    opParity: 'None',
    opStopBits: 'One',
    opHandshake: 'None',
    opDtr: false,
    opRts: false,
    opIgnoreEmptyChars: false,
    opScrollLocked: true,
    opShowTimestamp: true,
    opDisplayFormat: 'string',
    opEncoding: 'ASCII',
    opSendIsHex: false,
    opSendAppendLineEnding: '\\r\\n',
    opSendInput: '',
    opIsLoopSending: false,

    // --- Actions ---
    
    setPorts: (ports) => set((state) => { state.ports = ports; }),
    
    updatePort: (portId, patch) => set((state) => {
      const port = state.ports.find(p => p.id === portId);
      if (port) Object.assign(port, patch);
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
      if (port) port.groupId = groupId;
    }),
    
    openTab: (portId) => set((state) => {
      const existing = state.tabs.find(t => t.id === portId);
      if (!existing) {
        const port = state.ports.find(p => p.id === portId);
        const tab: TabItem = {
          id: portId,
          title: port ? `${port.id} ${port.alias || ''}`.trim() : portId,
          isPinned: false,
          isActive: true,
          splitPaneId: state.panes[0]?.id || 'main',
        };
        state.tabs.forEach(t => t.isActive = false);
        state.tabs.push(tab);
        state.activeTabId = portId;
        // 确保终端状态存在
        if (!state.terminals[portId]) {
          state.terminals[portId] = {
            lines: [],
            maxLines: 10000,
            scrollLocked: true,
            showTimestamp: true,
            displayFormat: 'string',
            encoding: 'ASCII',
          };
        }
      } else {
        state.tabs.forEach(t => t.isActive = false);
        existing.isActive = true;
        state.activeTabId = portId;
      }
    }),
    
    closeTab: (tabId) => set((state) => {
      state.tabs = state.tabs.filter(t => t.id !== tabId);
      if (state.activeTabId === tabId) {
        state.activeTabId = state.tabs[state.tabs.length - 1]?.id || null;
      }
    }),
    
    closeTabsToRight: (tabId) => set((state) => {
      const idx = state.tabs.findIndex(t => t.id === tabId);
      if (idx >= 0) {
        const removed = state.tabs.splice(idx + 1);
        if (state.activeTabId && removed.some(r => r.id === state.activeTabId)) {
          state.activeTabId = tabId;
        }
      }
    }),
    
    closeTabsToLeft: (tabId) => set((state) => {
      const idx = state.tabs.findIndex(t => t.id === tabId);
      if (idx > 0) {
        const removed = state.tabs.splice(0, idx);
        if (state.activeTabId && removed.some(r => r.id === state.activeTabId)) {
          state.activeTabId = tabId;
        }
      }
    }),
    
    closeOtherTabs: (tabId) => set((state) => {
      const target = state.tabs.find(t => t.id === tabId);
      if (target) {
        state.tabs = [target];
        state.activeTabId = tabId;
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
      }
    }),
    
    moveTabToPane: (tabId, paneId) => set((state) => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (tab) tab.splitPaneId = paneId;
    }),
    
    splitPane: (_paneId, direction) => set((state) => {
      // TODO: 实现分屏逻辑 - 创建新pane并移动当前激活tab
      const newPaneId = `pane-${Date.now()}`;
      state.panes.push({
        id: newPaneId,
        direction,
        tabIds: state.activeTabId ? [state.activeTabId] : [],
        size: 0.5,
      });
      const activeTab = state.tabs.find(t => t.id === state.activeTabId);
      if (activeTab) activeTab.splitPaneId = newPaneId;
    }),
    
    appendTerminalLine: (portId, line) => set((state) => {
      const term = state.terminals[portId];
      if (term) {
        term.lines.push(line);
        if (term.lines.length > term.maxLines) {
          term.lines.shift();
        }
      }
    }),
    
    clearTerminal: (portId) => set((state) => {
      const term = state.terminals[portId];
      if (term) term.lines = [];
    }),
    
    setTerminalConfig: (portId, patch) => set((state) => {
      const term = state.terminals[portId];
      if (term) Object.assign(term, patch);
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
    
    setOpState: (patch) => set((state) => {
      Object.assign(state, patch);
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
  }))
);

// ==================== 选择器 (性能优化) ====================

export const selectActivePort = (state: AppState): SerialPort | undefined => {
  if (!state.activeTabId) return undefined;
  return state.ports.find(p => p.id === state.activeTabId);
};

export const selectActiveTerminal = (state: AppState): TerminalState | undefined => {
  if (!state.activeTabId) return undefined;
  return state.terminals[state.activeTabId];
};
