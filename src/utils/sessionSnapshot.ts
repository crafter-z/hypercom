import { useAppStore, type AppStoreState } from '../stores/useAppStore';
import { configService } from '../services/tauri';
import type { PaneNode, SerialPort, TabItem } from '../types';
import { collectLeaves, pruneTree } from './paneTree';
import { getPluginViews } from './pluginConfigSnapshot';

export interface WorkspaceSessionSnapshot {
  paneTree: PaneNode;
  tabs: TabItem[];
  portConfigs: Record<string, Partial<SerialPort>>;
}

/** Parse untrusted persisted descriptors only; restoring never grants execution. */
export function parseSessionSnapshot(value: unknown, availablePortIds: ReadonlySet<string>, newId: () => string = () => crypto.randomUUID()): WorkspaceSessionSnapshot {
  const snapshot = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const tabs: TabItem[] = [];
  const remap = new Map<string, string>();
  const ids = new Set<string>();
  const serialPorts = new Set<string>();
  const pluginKeys = new Set<string>();
  const pluginCounts = new Map<string, number>();
  let pluginCount = 0;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const raw of Array.isArray(snapshot.tabs) ? snapshot.tabs : []) {
    if (!raw || typeof raw !== 'object') continue;
    const tab = raw as Record<string, unknown>;
    if (typeof tab.id !== 'string' || !tab.id || typeof tab.title !== 'string' || typeof tab.splitPaneId !== 'string' || typeof tab.isPinned !== 'boolean' || remap.has(tab.id)) continue;
    const legacy = tab.kind === undefined;
    const id = legacy ? newId() : tab.id;
    if (!uuid.test(id) || ids.has(id)) continue;
    const common = { id, title: tab.title, splitPaneId: tab.splitPaneId, isPinned: tab.isPinned };
    if (legacy || tab.kind === 'serial') {
      const portId = legacy ? tab.id : tab.portId;
      if (typeof portId !== 'string' || !availablePortIds.has(portId) || serialPorts.has(portId)) continue;
      tabs.push({ ...common, kind: 'serial', portId });
      serialPorts.add(portId);
    } else if (tab.kind === 'plugin') {
      if (typeof tab.pluginId !== 'string' || !tab.pluginId || typeof tab.installGeneration !== 'string' || !tab.installGeneration || typeof tab.viewId !== 'string' || !tab.viewId || typeof tab.instanceKey !== 'string' || tab.restoreOnStartup !== true || !(tab.boundPortId === null || (typeof tab.boundPortId === 'string' && tab.boundPortId.length > 0))) continue;
      const key = JSON.stringify([tab.pluginId, tab.installGeneration, tab.viewId, tab.boundPortId, tab.instanceKey]);
      const count = pluginCounts.get(tab.pluginId) ?? 0;
      if (pluginKeys.has(key) || count >= 8 || pluginCount >= 16) continue;
      tabs.push({ ...common, kind: 'plugin', pluginId: tab.pluginId, installGeneration: tab.installGeneration, viewId: tab.viewId, boundPortId: tab.boundPortId, instanceKey: tab.instanceKey, restoreOnStartup: true });
      pluginKeys.add(key);
      pluginCounts.set(tab.pluginId, count + 1);
      pluginCount++;
    } else continue;
    ids.add(id);
    remap.set(tab.id, id);
  }
  const paneIds = new Set<string>();
  const assigned = new Set<string>();
  const parseTree = (raw: unknown, depth: number): PaneNode | null => {
    if (!raw || typeof raw !== 'object' || depth > 32) return null;
    const node = raw as Record<string, unknown>;
    if (typeof node.id !== 'string' || !node.id || paneIds.has(node.id) || typeof node.size !== 'number' || !Number.isFinite(node.size) || node.size <= 0) return null;
    paneIds.add(node.id);
    if (node.type === 'leaf' && Array.isArray(node.tabIds) && node.tabIds.every((id) => typeof id === 'string')) {
      const tabIds: string[] = [];
      for (const oldId of node.tabIds) {
        const id = remap.get(oldId);
        if (id && !assigned.has(id)) { assigned.add(id); tabIds.push(id); }
      }
      return { id: node.id, type: 'leaf', size: node.size, tabIds };
    }
    if (node.type === 'branch' && (node.direction === 'horizontal' || node.direction === 'vertical') && Array.isArray(node.children) && node.children.length >= 2) {
      const children = node.children.map((child) => parseTree(child, depth + 1));
      if (children.every((child): child is PaneNode => child !== null)) return { id: node.id, type: 'branch', direction: node.direction, size: node.size, children };
    }
    return null;
  };
  let paneTree = parseTree(snapshot.paneTree, 0);
  if (!paneTree) paneTree = { id: 'main', type: 'leaf', size: 1, tabIds: tabs.map((tab) => tab.id) };
  const leaves = collectLeaves(paneTree);
  for (const tab of tabs) {
    const leaf = leaves.find((node) => node.tabIds.includes(tab.id)) ?? leaves.find((node) => node.id === tab.splitPaneId) ?? leaves[0];
    if (!leaf.tabIds.includes(tab.id)) leaf.tabIds.push(tab.id);
    tab.splitPaneId = leaf.id;
  }
  paneTree = pruneTree(paneTree);
  const portConfigs: Record<string, Partial<SerialPort>> = {};
  const configs = snapshot.portConfigs && typeof snapshot.portConfigs === 'object' ? snapshot.portConfigs as Record<string, unknown> : {};
  for (const portId of serialPorts) {
    const raw = configs[portId];
    if (!raw || typeof raw !== 'object') continue;
    const pc = raw as Record<string, unknown>;
    const patch: Partial<SerialPort> = {};
    if (typeof pc.baudRate === 'number' && Number.isSafeInteger(pc.baudRate) && pc.baudRate > 0) patch.baudRate = pc.baudRate;
    if (pc.dataBits === 5 || pc.dataBits === 6 || pc.dataBits === 7 || pc.dataBits === 8) patch.dataBits = pc.dataBits;
    if (pc.parity === 'None' || pc.parity === 'Even' || pc.parity === 'Odd') patch.parity = pc.parity;
    if (pc.stopBits === 'One' || pc.stopBits === 'Two') patch.stopBits = pc.stopBits;
    if (pc.handshake === 'None' || pc.handshake === 'XonXoff' || pc.handshake === 'RequestToSend' || pc.handshake === 'RequestToSendXonXoff') patch.handshake = pc.handshake;
    portConfigs[portId] = patch;
  }
  return { paneTree, tabs, portConfigs };
}

/** Persist descriptors, not sessions, models, parameters, tokens or native handles. */
export function buildSessionSnapshot(state: AppStoreState): string | null {
  if (!state.config.restoreSession) return null;
  const plugins = getPluginViews();
  const tabs = state.tabs.filter((tab) => {
    if (tab.kind === 'serial') return true;
    const plugin = plugins.find((item) => item.id === tab.pluginId && item.installGeneration === tab.installGeneration);
    const declaration = plugin?.manifest?.ui?.views?.find((item) => item.id === tab.viewId);
    return tab.restoreOnStartup && (!plugin?.manifest || (declaration?.restoreOnStartup === true && declaration.placements.includes('workspace-tab')));
  }).map((tab): TabItem => tab.kind === 'serial'
    ? { kind: 'serial', id: tab.id, portId: tab.portId, title: tab.title, splitPaneId: tab.splitPaneId, isPinned: tab.isPinned }
    : { kind: 'plugin', id: tab.id, title: tab.title, splitPaneId: tab.splitPaneId, isPinned: tab.isPinned, pluginId: tab.pluginId, installGeneration: tab.installGeneration, viewId: tab.viewId, boundPortId: tab.boundPortId, instanceKey: tab.instanceKey, restoreOnStartup: true });
  const savedIds = new Set(tabs.map((tab) => tab.id));
  const prune = (node: PaneNode): PaneNode => node.type === 'leaf'
    ? { ...node, tabIds: node.tabIds.filter((id) => savedIds.has(id)) }
    : { ...node, children: node.children.map(prune) };
  const portConfigs = Object.fromEntries(tabs.flatMap((tab) => {
    if (tab.kind !== 'serial') return [];
    const port = state.ports.find((item) => item.id === tab.portId);
    return [[tab.portId, { baudRate: port?.baudRate ?? 115200, dataBits: port?.dataBits ?? 8, parity: port?.parity ?? 'None', stopBits: port?.stopBits ?? 'One', handshake: port?.handshake ?? 'None' }]];
  }));
  return JSON.stringify({ version: 2, paneTree: pruneTree(prune(state.paneTree)), tabs, portConfigs });
}

/** Best-effort dedicated write avoids racing full configuration saves. */
export function saveSessionSnapshot(): void {
  try {
    const snapshot = buildSessionSnapshot(useAppStore.getState());
    if (snapshot === null) return;
    configService.updateSessionSnapshot(snapshot).catch((e) => console.debug('[App] Failed to save session snapshot:', e));
  } catch (e) {
    console.debug('[App] Failed to build session snapshot:', e);
  }
}
