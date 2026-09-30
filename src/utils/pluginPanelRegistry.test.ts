/**
 * pluginPanelRegistry 测试（issue #17 能力补强）
 *
 * 覆盖：append 聚合、超限截断丢最旧（droppedChars 计数）、clear 保留 droppedChars、
 * remove 移除、订阅通知。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  appendPluginPanel,
  clearPluginPanel,
  removePluginPanel,
  resetPluginPanelForTest,
  getPluginPanelSnapshot,
  subscribePluginPanel,
  PLUGIN_PANEL_MAX_BUFFER,
} from './pluginPanelRegistry';

describe('pluginPanelRegistry', () => {
  it('append 聚合 + 订阅通知', () => {
    resetPluginPanelForTest();
    const listener = vi.fn();
    const unsub = subscribePluginPanel(listener);

    appendPluginPanel('com.example', 'hello');
    appendPluginPanel('com.example', ' world');

    expect(getPluginPanelSnapshot()['com.example'].buffer).toBe('hello world');
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('超限截断丢最旧（保留最新尾部）', () => {
    resetPluginPanelForTest();
    // 构造超过上限的两次 append。
    const a = 'A'.repeat(Math.floor(PLUGIN_PANEL_MAX_BUFFER * 0.6));
    const b = 'B'.repeat(Math.floor(PLUGIN_PANEL_MAX_BUFFER * 0.6));
    appendPluginPanel('com.example', a);
    appendPluginPanel('com.example', b);

    const state = getPluginPanelSnapshot()['com.example'];
    expect(state.buffer.length).toBeLessThanOrEqual(PLUGIN_PANEL_MAX_BUFFER);
    expect(state.droppedChars).toBeGreaterThan(0);
    // 尾部（最新输出 B）保留。
    expect(state.buffer.endsWith(b)).toBe(true);
  });

  it('clear 清空 buffer 但保留 droppedChars 累计', () => {
    resetPluginPanelForTest();
    appendPluginPanel('com.example', 'x'.repeat(PLUGIN_PANEL_MAX_BUFFER + 10));
    const before = getPluginPanelSnapshot()['com.example'].droppedChars;
    clearPluginPanel('com.example');

    const after = getPluginPanelSnapshot()['com.example'];
    expect(after.buffer).toBe('');
    expect(after.droppedChars).toBe(before);
  });

  it('remove 移除插件面板', () => {
    resetPluginPanelForTest();
    appendPluginPanel('com.example', 'hello');
    expect(getPluginPanelSnapshot()['com.example']).toBeDefined();
    removePluginPanel('com.example');
    expect(getPluginPanelSnapshot()['com.example']).toBeUndefined();
  });
});
