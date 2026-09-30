/**
 * usePluginPanel — 插件输出面板订阅 hook（issue #17 能力补强）
 *
 * 宿主组件（PluginPanel）订阅插件面板快照，把 worker 经
 * `plugin.api.ui.panel.append/clear` 写入的输出渲染出来。
 * 纯展示订阅（useSyncExternalStore），无副作用。
 */
import { useSyncExternalStore } from 'react';
import {
  subscribePluginPanel,
  getPluginPanelSnapshot,
} from '../utils/pluginPanelRegistry';

/** 订阅插件面板快照（React 重渲染驱动）。 */
export function usePluginPanel() {
  return useSyncExternalStore(subscribePluginPanel, getPluginPanelSnapshot);
}
