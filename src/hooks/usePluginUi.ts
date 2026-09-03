/**
 * usePluginUi — 插件声明式 UI 扩展点订阅 hook（issue #17，评审 v2 D2）
 *
 * 供 Sidebar 工具栏 / 端口右键菜单读取插件注册的按钮/菜单项，并把点击
 * 分发成 worker 事件 `ui.buttonClick`（worker 侧 `plugin.on('ui.buttonClick')`）。
 *
 * 仅主窗渲染（评审 v2 P14）——弹窗 webview 不加载插件 UI。
 */
import { useSyncExternalStore } from 'react';
import { pluginHost } from '../utils/pluginHost';
import {
  subscribePluginUi,
  getPluginUiSnapshot,
  type RegisteredPluginUi,
} from '../utils/pluginUiRegistry';

/** 订阅注册表快照（React 重渲染驱动）。 */
export function usePluginUi() {
  return useSyncExternalStore(subscribePluginUi, getPluginUiSnapshot);
}

/** 向插件 worker 分发 UI 点击（工具栏按钮 / 菜单项）。 */
export function dispatchPluginUiClick(
  reg: RegisteredPluginUi,
  buttonId: string,
  context?: { portId?: string },
): void {
  const session = pluginHost.get(reg.pluginId);
  if (!session) {
    console.warn(`[usePluginUi] plugin ${reg.pluginId} 未启用，无法分发点击`);
    return;
  }
  session.post({
    type: 'ui.buttonClick',
    payload: { buttonId, context },
  });
}

/** 便捷：Sidebar 工具栏按钮渲染源（已 enabled 插件的 sidebar 按钮平铺）。 */
export function useToolbarPluginButtons() {
  const ui = usePluginUi();
  const out: Array<RegisteredPluginUi & { buttonIndex: number }> = [];
  for (const reg of ui.toolbarButtons) {
    for (let i = 0; i < reg.buttons.length; i++) {
      out.push({ ...reg, buttonIndex: i });
    }
  }
  return out;
}

/** 便捷：端口右键菜单插件项渲染源（已 enabled 插件的 port-context 菜单项平铺）。 */
export function usePortPluginMenuItems() {
  const ui = usePluginUi();
  const out: Array<RegisteredPluginUi & { itemIndex: number }> = [];
  for (const reg of ui.portMenuItems) {
    for (let i = 0; i < reg.menuItems.length; i++) {
      out.push({ ...reg, itemIndex: i });
    }
  }
  return out;
}
