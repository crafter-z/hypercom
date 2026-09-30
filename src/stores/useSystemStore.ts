/**
 * useSystemStore — 运行期系统态：OS 资源探针、流量统计、模拟模式、UI 布局与弹窗标志。
 *
 * 从 `useAppStore` 拆出（S-E1）。这四类字段的写点与串口/标签页数据完全无关，却都
 * 是高频来源：`useSystemStatus` 5s 轮询一次、流量聚合器每个端口每秒 flush 一次、
 * 拖拽 resize 每个 mousemove 一次。混在同一个 store 里时，任何一次流量 flush 都会
 * 唤醒所有 `useAppStore(...)` 订阅者（StatusBar、每个 Pane、OperationPanel…）重跑
 * 选择器——这正是 TTY 卡顿根因链上的一环。拆开后订阅面互不干扰。
 *
 * 纯不可变更新（不用 immer）：这里的状态都是浅对象，展开比代理更省。
 */
import { create } from 'zustand';
import type { SystemStatus, TrafficStats, UIState } from '../types';

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

const defaultSystemStatus: SystemStatus = {
  status: '',
  memoryUsedMb: 0,
  cpuUsage: 0,
};

export interface SystemStoreState {
  systemStatus: SystemStatus;
  trafficStats: Record<string, TrafficStats>;
  simulationMode: boolean;
  ui: UIState;

  setSystemStatus: (status: Partial<SystemStatus>) => void;
  setTrafficStats: (portId: string, stats: Partial<TrafficStats>) => void;
  /** 端口关闭后回收其流量条目（`releaseTerminalState` 调用）。 */
  clearTrafficStats: (portId: string) => void;
  setSimulationMode: (on: boolean) => void;

  setUIState: (patch: Partial<UIState>) => void;
  toggleConfigModal: (open?: boolean) => void;
  setConfigActiveTab: (tab: string) => void;
}

export const useSystemStore = create<SystemStoreState>((set) => ({
  systemStatus: defaultSystemStatus,
  trafficStats: {},
  simulationMode: false,
  ui: defaultUIState,

  setSystemStatus: (status) =>
    set((s) => ({ systemStatus: { ...s.systemStatus, ...status } })),

  setTrafficStats: (portId, stats) =>
    set((s) => {
      // 首个字节到达时自动建条目——调用方（流量聚合器）只关心增量。
      const prev = s.trafficStats[portId] ?? { portId, txTotal: 0, rxTotal: 0 };
      return { trafficStats: { ...s.trafficStats, [portId]: { ...prev, ...stats } } };
    }),

  clearTrafficStats: (portId) =>
    set((s) => {
      if (s.trafficStats[portId] === undefined) return {};
      const { [portId]: _released, ...rest } = s.trafficStats;
      return { trafficStats: rest };
    }),

  setSimulationMode: (on) => set({ simulationMode: on }),

  setUIState: (patch) =>
    set((s) => ({ ui: { ...s.ui, ...patch } })),

  toggleConfigModal: (open) =>
    set((s) => ({ ui: { ...s.ui, isConfigOpen: open ?? !s.ui.isConfigOpen } })),

  setConfigActiveTab: (tab) =>
    set((s) => ({ ui: { ...s.ui, configActiveTab: tab } })),
}));
