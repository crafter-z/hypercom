import { describe, it, expect } from 'vitest';
import { filterLostTabIds } from './DisconnectBanner';
import type { TabItem } from '../../types';

const makeTab = (id: string): TabItem => ({
  kind: 'serial',
  portId: id,
  id,
  title: id,
  isPinned: false,
  splitPaneId: 'main',
});

describe('filterLostTabIds', () => {
  it('returns empty array for empty tabs', () => {
    expect(filterLostTabIds([], () => true)).toEqual([]);
  });

  it('returns empty array when no tab is lost', () => {
    const tabs = [makeTab('COM3'), makeTab('COM4')];
    expect(filterLostTabIds(tabs, () => false)).toEqual([]);
  });

  it('returns only the tabs whose id the predicate marks lost', () => {
    const tabs = [makeTab('COM3'), makeTab('COM4'), makeTab('COM5')];
    const lost = new Set(['COM3', 'COM5']);
    expect(filterLostTabIds(tabs, (id) => lost.has(id))).toEqual(['COM3', 'COM5']);
  });

  it('preserves tab order', () => {
    const tabs = [makeTab('COM9'), makeTab('COM1'), makeTab('COM7')];
    expect(filterLostTabIds(tabs, () => true)).toEqual(['COM9', 'COM1', 'COM7']);
  });

  it('returns all ids when every tab is lost', () => {
    const tabs = [makeTab('COM3'), makeTab('COM4')];
    expect(filterLostTabIds(tabs, () => true)).toEqual(['COM3', 'COM4']);
  });

  it('uses explicit bindings, counts a shared lost port once and excludes unbound tools', () => {
    const plugin = { kind: 'plugin' as const, pluginId: 'sensor', installGeneration: 'g1', viewId: 'table', instanceKey: '', restoreOnStartup: true, title: 'table', isPinned: false, splitPaneId: 'main' };
    const tabs: TabItem[] = [
      { ...makeTab('COM3'), id: 'serial-workspace' },
      { ...plugin, id: 'bound-workspace', boundPortId: 'COM3' },
      { ...plugin, id: 'other-workspace', boundPortId: 'COM5' },
      { ...plugin, id: 'tool-workspace', boundPortId: null },
    ];
    expect(filterLostTabIds(tabs, (portId) => portId === 'COM3' || portId === 'COM5')).toEqual(['serial-workspace', 'other-workspace']);
  });
});
