import { describe, it, expect } from 'vitest';
import { filterLostTabIds } from './DisconnectBanner';
import type { TabItem } from '../../types';

const makeTab = (id: string): TabItem => ({
  id,
  title: id,
  isPinned: false,
  isActive: false,
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
});
