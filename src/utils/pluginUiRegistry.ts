/**
 * pluginUiRegistry — 插件声明式 UI 扩展点注册表（issue #17，评审 v2 D2/P14）
 *
 * 宿主在固定扩展点渲染插件 UI（Sidebar 工具栏按钮 / 端口右键菜单项），
 * 点击 → 给该插件 worker 发 `ui.buttonClick` 事件（worker 侧经
 * `plugin.on('ui.buttonClick', cb)` 处理）。
 *
 * 数据源：插件 manifest `ui: {buttons, menuItems}`。由 usePluginHost 在
 * 插件列表刷新时填充本注册表（list_plugins 返回完整 PluginView 含 manifest.ui），
 * Sidebar 订阅读取。**仅主窗渲染**（评审 v2 P14：弹窗 webview 不加载插件 UI）。
 *
 * 模块单例 + 订阅通知（无 store 依赖——纯展示注册表）。
 */

export interface PluginUiButton {
  id: string;
  label: string;
  icon?: string; // lucide-react 图标名
  target?: string; // 'sidebar'
}

export interface PluginUiMenuItem {
  id: string;
  label: string;
  target?: string; // 'port-context'
}

export interface PluginUiDecl {
  buttons: PluginUiButton[];
  menuItems: PluginUiMenuItem[];
}

/** 一个插件的 UI 声明（含插件 id 供点击路由）。 */
export interface RegisteredPluginUi {
  pluginId: string;
  pluginName: string;
  buttons: PluginUiButton[];
  menuItems: PluginUiMenuItem[];
}

/** 注册表内容快照。 */
export interface PluginUiSnapshot {
  /** Sidebar 工具栏按钮（target=sidebar 或未标）。 */
  toolbarButtons: RegisteredPluginUi[];
  /** 端口右键菜单项（target=port-context 或未标）。 */
  portMenuItems: RegisteredPluginUi[];
}

let snapshot: PluginUiSnapshot = { toolbarButtons: [], portMenuItems: [] };
const listeners = new Set<() => void>();

/** 从 PluginView 列表重建注册表（usePluginHost 刷新时调用）。 */
export function rebuildPluginUi(
  views: Array<{
    id: string;
    enabled: boolean;
    manifest: { name?: string; ui?: PluginUiDecl } | null;
  }>,
): void {
  const next: PluginUiSnapshot = { toolbarButtons: [], portMenuItems: [] };
  for (const v of views) {
    if (!v.enabled || !v.manifest?.ui) continue;
    const ui = v.manifest.ui;
    const reg: RegisteredPluginUi = {
      pluginId: v.id,
      pluginName: v.manifest.name ?? v.id,
      buttons: ui.buttons ?? [],
      menuItems: ui.menuItems ?? [],
    };
    if (reg.buttons.length > 0) next.toolbarButtons.push(reg);
    if (reg.menuItems.length > 0) next.portMenuItems.push(reg);
  }
  snapshot = next;
  for (const l of listeners) l();
}

/** 订阅注册表变化。返回注销。 */
export function subscribePluginUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 读取当前快照（React 订阅用：配合 useSyncExternalStore）。 */
export function getPluginUiSnapshot(): PluginUiSnapshot {
  return snapshot;
}

/** 测试用：清空。 */
export function resetPluginUiForTest(): void {
  snapshot = { toolbarButtons: [], portMenuItems: [] };
  listeners.clear();
}
