import { describe, it, expect, beforeEach } from 'vitest';
import { useSystemStore } from './useSystemStore';
import { resetStoresForTests } from './resetStores';

// 运行期系统态：UI 标志 / 流量统计 / 模拟模式（S-E1 从 useAppStore 拆出）。
beforeEach(() => {
  resetStoresForTests();
});

describe('UI state', () => {
  it('setUIState patches only the given flags', () => {
    useSystemStore.getState().setUIState({ sidebarWidth: 300 });
    const { ui } = useSystemStore.getState();
    expect(ui.sidebarWidth).toBe(300);
    expect(ui.isConfigOpen).toBe(false); // sibling flags survive the patch
    expect(ui.sidebarCollapsed).toBe(false);
  });

  it('toggleConfigModal toggles when called without an argument', () => {
    const { toggleConfigModal } = useSystemStore.getState();
    toggleConfigModal();
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(true);
    toggleConfigModal();
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(false);
    // 显式传参是幂等设置而非取反（Escape / 关窗路径依赖这一点）。
    toggleConfigModal(false);
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(false);
    toggleConfigModal(true);
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(true);
  });
});

describe('trafficStats', () => {
  it('auto-initializes a new port entry and merges later updates', () => {
    const { setTrafficStats } = useSystemStore.getState();
    setTrafficStats('COM1', { txTotal: 100 });
    setTrafficStats('COM1', { rxTotal: 30 });
    const stats = useSystemStore.getState().trafficStats['COM1'];
    expect(stats).toEqual({ portId: 'COM1', txTotal: 100, rxTotal: 30 });
  });

  it('clearTrafficStats releases only the given port', () => {
    const { setTrafficStats, clearTrafficStats } = useSystemStore.getState();
    setTrafficStats('COM1', { txTotal: 1 });
    setTrafficStats('COM2', { txTotal: 2 });
    clearTrafficStats('COM1');
    const { trafficStats } = useSystemStore.getState();
    expect(trafficStats['COM1']).toBeUndefined();
    expect(trafficStats['COM2'].txTotal).toBe(2);
  });
});
