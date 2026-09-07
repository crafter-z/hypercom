/**
 * pluginPanelRegistry — 插件输出面板注册表（issue #17 能力补强）
 *
 * 插件经 `plugin.api.ui.panel.append(text)` / `ui.panel.clear()` 把结构化输出
 * 写入一个**主机渲染的专属面板**（worker 零 DOM——面板是宿主 React 组件）。
 * 本模块是纯状态注册表（镜像 pluginUiRegistry）：模块单例 + 订阅快照，
 * 宿主组件（PluginPanel）订阅渲染。
 *
 * v1 语义：每插件一个面板，尾部追加 + 可清空 + 可导出。面板内容只是
 * 插件的输出区，零权限（权限模型核心是「零 DOM」，面板写不越权）。
 */

/** 面板 buffer 上限（字节）：超过即截断尾部（丢最旧），防失控插件把面板字符串
 *  撑到 GB 级卡死宿主——对齐 rxPipeline maxQueuedLines 纪律。 */
export const PLUGIN_PANEL_MAX_BUFFER = 512 * 1024;

/** 一个插件的面板状态。 */
export interface PluginPanelState {
  /** 追加文本（尾部聚合，宿主按需分行渲染）。 */
  buffer: string;
  /** 累计导出次数（宿主 UI 显示用）。 */
  exportCount: number;
  /** 因超限截断而丢弃的字符数（宿主 UI 可显示「已截断」）。 */
  droppedChars: number;
}

/** 面板状态快照（宿主 React 订阅）。 */
export type PluginPanelSnapshot = Record<string, PluginPanelState>;

let snapshot: PluginPanelSnapshot = {};
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** 追加文本到插件面板（超限截断丢最旧）。 */
export function appendPluginPanel(pluginId: string, text: string): void {
  let buffer: string;
  let droppedChars = 0;
  const cur = snapshot[pluginId];
  if (!cur) {
    buffer = text;
    droppedChars = 0;
  } else {
    buffer = cur.buffer + text;
    droppedChars = cur.droppedChars;
  }
  if (buffer.length > PLUGIN_PANEL_MAX_BUFFER) {
    // 丢最旧：截掉超出部分的前缀。保留尾部（最新输出）。
    const overflow = buffer.length - PLUGIN_PANEL_MAX_BUFFER;
    buffer = buffer.slice(overflow);
    droppedChars += overflow;
  }
  snapshot = {
    ...snapshot,
    [pluginId]: { buffer, exportCount: cur?.exportCount ?? 0, droppedChars },
  };
  notify();
}

/** 清空插件面板（保留 droppedChars 累计——清空是「重新开始输出」，不掩盖已截断史）。 */
export function clearPluginPanel(pluginId: string): void {
  const cur = snapshot[pluginId];
  if (!cur) return;
  snapshot = { ...snapshot, [pluginId]: { buffer: '', exportCount: cur.exportCount, droppedChars: cur.droppedChars } };
  notify();
}

/** 移除插件面板（插件卸载/禁用时清理，防幽灵面板残留）。 */
export function removePluginPanel(pluginId: string): void {
  if (!snapshot[pluginId]) return;
  const next = { ...snapshot };
  delete next[pluginId];
  snapshot = next;
  notify();
}

/** 订阅面板变化。返回注销。 */
export function subscribePluginPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 读取当前面板快照（React 订阅用：配合 useSyncExternalStore）。 */
export function getPluginPanelSnapshot(): PluginPanelSnapshot {
  return snapshot;
}

/** 测试用：清空。 */
export function resetPluginPanelForTest(): void {
  snapshot = {};
  listeners.clear();
}
