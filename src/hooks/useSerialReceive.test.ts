/**
 * useSerialReceive — 连接成功自动打开标签页（v0.6.1）测试。
 *
 * 需求：连接（打开）串口成功 → 自动创建并激活该端口对应标签页；已有标签页则
 * 仅激活不新建；关闭串口不关闭标签页。
 *
 * 实现：`useSerialReceive` 的 `serial:status` handler 在 connected 分支调用
 * 模块级函数 `openTabForConnectedPort(portId)`（后端对 open 与自动重连统一发
 * connected，是「真正连接成功」的权威信号）。本文件按项目惯例直接测该纯函数
 * 及其依赖的 store 语义（tab id === portId，复用 `openTab` 手动建标签页动作）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppStore, findLeafByTabId, findLeafById, collectLeaves } from '../stores/useAppStore';
import type { SerialPort, BranchPane } from '../types';
import { openTabForConnectedPort } from './useSerialReceive';

// useSerialReceive 的模块链会拉入 services/tauri（Tauri IPC）——按 ttyService.test
// 同款做法 mock 掉，避免 node 环境加载真实 @tauri-apps 绑定。
vi.mock('../services/tauri', () => ({
  eventService: {
    onSerialData: vi.fn(),
    onSerialStatus: vi.fn(),
  },
  serialService: {},
}));

const makePort = (id: string, overrides?: Partial<SerialPort>): SerialPort => ({
  id,
  name: id,
  status: 'connected',
  type: 'real',
  isHidden: false,
  ...overrides,
});

describe('openTabForConnectedPort — 连接成功自动打开/激活标签页', () => {
  beforeEach(() => {
    useAppStore.setState({
      ports: [makePort('COM1'), makePort('COM2')],
      tabs: [],
      paneTree: { id: 'main', type: 'leaf', tabIds: [], size: 1 },
      activeTabId: null,
      focusedPaneId: 'main',
    });
  });

  it('open 成功（connected 事件）→ 为该端口创建并激活标签页', () => {
    openTabForConnectedPort('COM1');
    const s = useAppStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['COM1']);
    expect(s.tabs[0].isActive).toBe(true);
    expect(s.activeTabId).toBe('COM1');
    // 标签页必须落在真实叶子（paneTree），不是仅挂在 state.tabs 的孤儿。
    const leaf = findLeafByTabId(s.paneTree, 'COM1');
    expect(leaf).toBeDefined();
    expect(leaf!.tabIds).toContain('COM1');
  });

  it('该端口已有标签页 → 仅激活，不重复创建', () => {
    const { openTab } = useAppStore.getState();
    openTab('COM1');
    openTab('COM2'); // COM2 当前激活
    openTabForConnectedPort('COM1'); // COM1 重连/再次连接
    const s = useAppStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe('COM1');
    expect(s.tabs.find((t) => t.id === 'COM1')!.isActive).toBe(true);
    expect(s.tabs.find((t) => t.id === 'COM2')!.isActive).toBe(false);
  });

  it('多 Pane（递归 paneTree）下新标签页落在聚焦叶子，与手动建标签页一致', () => {
    const { openTab, splitPane } = useAppStore.getState();
    openTab('COM1');
    splitPane('vertical'); // COM1 移入新叶子，focusedPaneId = 新叶子
    const s1 = useAppStore.getState();
    expect((s1.paneTree as BranchPane).type).toBe('branch');
    expect(collectLeaves(s1.paneTree)).toHaveLength(2);

    openTabForConnectedPort('COM2');
    const s2 = useAppStore.getState();
    expect(s2.tabs).toHaveLength(2);
    expect(s2.tabs.find((t) => t.id === 'COM2')!.splitPaneId).toBe(s2.focusedPaneId);
    expect(findLeafById(s2.paneTree, s2.focusedPaneId)!.tabIds).toContain('COM2');
  });

  it('关闭串口（disconnected）不影响标签页——标签页保留可回看/重连', () => {
    useAppStore.getState().openTab('COM1');
    // closePort 的 store 侧效果只有状态更新；标签页必须原样保留。
    useAppStore.getState().updatePort('COM1', { status: 'disconnected' });
    const s = useAppStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['COM1']);
    expect(s.activeTabId).toBe('COM1');
    expect(findLeafByTabId(s.paneTree, 'COM1')).toBeDefined();
  });
});
