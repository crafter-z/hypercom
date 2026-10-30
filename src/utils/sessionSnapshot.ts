import { useAppStore, type AppStoreState } from '../stores/useAppStore';
import { configService } from '../services/tauri';
import type { PaneNode, SerialPort, TabItem } from '../types';
import { collectLeaves, pruneTree } from './paneTree';
import { getPluginViews } from './pluginConfigSnapshot';
import { exportReplayDescriptions, restoreReplayDescriptions, subscribeReplay, type ReplaySessionDescription } from './replay/replayRuntime';
import { timelineCoordinator } from './timeline/coordinator';

/** Calls only on descriptor changes, never on per-frame cursor/ACK/owner state. */
export function subscribeSessionDescriptors(listener: () => void): () => void {
  const signature = () => JSON.stringify([timelineCoordinator.exportState(), exportReplayDescriptions()]);
  let previous = signature();
  const changed = () => { const next = signature(); if (next !== previous) { previous = next; listener(); } };
  const stopTimeline = timelineCoordinator.subscribe(changed), stopReplay = subscribeReplay(changed);
  return () => { stopTimeline(); stopReplay(); };
}

export function parseReplayDescriptions(value: unknown): ReplaySessionDescription[] {
  const results: ReplaySessionDescription[] = [], ids = new Set<string>();
  if (!Array.isArray(value)) return results;
  for (const raw of value.slice(0, 16)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id) || typeof item.name !== 'string' || !Array.isArray(item.tracks) || !item.tracks.length || item.tracks.length > 16) continue;
    const tracks: ReplaySessionDescription['tracks'] = [], trackIds = new Set<string>();
    for (const candidate of item.tracks) {
      if (!candidate || typeof candidate !== 'object') continue;
      const track = candidate as Record<string, unknown>, options = track.options as Record<string, unknown> | undefined;
      if (typeof track.id !== 'string' || !track.id || track.id.length > 128 || trackIds.has(track.id) || typeof track.title !== 'string' || !Array.isArray(track.files) || !track.files.length || track.files.length > 16 || !options || options.encoding !== 'UTF-8' || (options.format !== 'text' && options.format !== 'hex')) continue;
      const offset = options.timezoneOffsetMinutes;
      if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || Math.abs(offset) > 840)) continue;
      const files = track.files.flatMap(file => {
        if (!file || typeof file !== 'object') return [];
        const f = file as Record<string, unknown>;
        return typeof f.name === 'string' && typeof f.path === 'string' && f.path.length <= 32768 && typeof f.size === 'number' && Number.isSafeInteger(f.size) && f.size >= 0 && f.size <= 32 * 1024 * 1024 && typeof f.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(f.fingerprint)
          ? [{ name: f.name.slice(0, 1024), path: f.path, size: f.size, fingerprint: f.fingerprint }] : [];
      });
      if (files.length !== track.files.length || (track.selectedSegment !== undefined && (typeof track.selectedSegment !== 'number' || !Number.isSafeInteger(track.selectedSegment) || track.selectedSegment < 0 || track.selectedSegment >= 500_000))) continue;
      tracks.push({ id: track.id, title: track.title.slice(0, 1024), files, options: { encoding: 'UTF-8', format: options.format, timezoneOffsetMinutes: offset as number | undefined }, ...(track.selectedSegment === undefined ? {} : { selectedSegment: track.selectedSegment as number }) }); trackIds.add(track.id);
    }
    if (tracks.length === item.tracks.length && tracks.flatMap(t => t.files).length <= 16 && tracks.flatMap(t => t.files).reduce((n, f) => n + f.size, 0) <= 64 * 1024 * 1024) { results.push({ id: item.id, name: item.name.slice(0, 1024), tracks }); ids.add(item.id); }
  }
  return results;
}

export function restoreSessionSources(snapshot: WorkspaceSessionSnapshot): void {
  restoreReplayDescriptions(snapshot.replaySessions);
  timelineCoordinator.restoreState(snapshot.timeline, new Set(snapshot.tabs.map(tab => tab.id)));
}

export interface WorkspaceSessionSnapshot {
  paneTree: PaneNode;
  tabs: TabItem[];
  portConfigs: Record<string, Partial<SerialPort>>;
  replaySessions: ReplaySessionDescription[];
  timeline: unknown;
}

/** Parse untrusted persisted descriptors only; restoring never grants execution. */
export function parseSessionSnapshot(value: unknown, availablePortIds: ReadonlySet<string>, newId: () => string = () => crypto.randomUUID()): WorkspaceSessionSnapshot {
  const snapshot = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const tabs: TabItem[] = [];
  const replaySessions = parseReplayDescriptions(snapshot.replaySessions);
  const replayKeys = new Set<string>();
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
    } else if (tab.kind === 'replay') {
      const session = replaySessions.find(item => item.id === tab.sessionId);
      if (!session || typeof tab.trackId !== 'string' || !session.tracks.some(track => track.id === tab.trackId)) continue;
      const key = JSON.stringify([session.id, tab.trackId]);
      if (replayKeys.has(key)) continue;
      replayKeys.add(key);
      tabs.push({ ...common, kind: 'replay', sessionId: session.id, trackId: tab.trackId });
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
  return { paneTree, tabs, portConfigs, replaySessions: replaySessions.filter(session => tabs.some(tab => tab.kind === 'replay' && tab.sessionId === session.id)), timeline: snapshot.timeline };
}

/** Persist descriptors, not sessions, models, parameters, tokens or native handles. */
export function buildSessionSnapshot(state: AppStoreState): string | null {
  if (!state.config.restoreSession) return null;
  const plugins = getPluginViews();
  const tabs = state.tabs.filter((tab) => {
    if (tab.kind === 'serial' || tab.kind === 'replay') return true;
    const plugin = plugins.find((item) => item.id === tab.pluginId && item.installGeneration === tab.installGeneration);
    const declaration = plugin?.manifest?.ui?.views?.find((item) => item.id === tab.viewId);
    return tab.restoreOnStartup && (!plugin?.manifest || (declaration?.restoreOnStartup === true && declaration.placements.includes('workspace-tab')));
  }).map((tab): TabItem => {
    const common = { id: tab.id, title: tab.title, splitPaneId: tab.splitPaneId, isPinned: tab.isPinned };
    if (tab.kind === 'serial') return { ...common, kind: 'serial', portId: tab.portId };
    if (tab.kind === 'replay') return { ...common, kind: 'replay', sessionId: tab.sessionId, trackId: tab.trackId };
    return { ...common, kind: 'plugin', pluginId: tab.pluginId, installGeneration: tab.installGeneration, viewId: tab.viewId, boundPortId: tab.boundPortId, instanceKey: tab.instanceKey, restoreOnStartup: true };
  });
  const savedIds = new Set(tabs.map((tab) => tab.id));
  const prune = (node: PaneNode): PaneNode => node.type === 'leaf'
    ? { ...node, tabIds: node.tabIds.filter((id) => savedIds.has(id)) }
    : { ...node, children: node.children.map(prune) };
  const portConfigs = Object.fromEntries(tabs.flatMap((tab) => {
    if (tab.kind !== 'serial') return [];
    const port = state.ports.find((item) => item.id === tab.portId);
    return [[tab.portId, { baudRate: port?.baudRate ?? 115200, dataBits: port?.dataBits ?? 8, parity: port?.parity ?? 'None', stopBits: port?.stopBits ?? 'One', handshake: port?.handshake ?? 'None' }]];
  }));
  const replaySessions = exportReplayDescriptions().filter(session => tabs.some(tab => tab.kind === 'replay' && tab.sessionId === session.id));
  const timeline = timelineCoordinator.exportState();
  timeline.groups = timeline.groups.map(group => ({ ...group, memberSlots: group.memberSlots.filter(id => savedIds.has(id)) })).filter(group => group.memberSlots.length);
  return JSON.stringify({ version: 3, paneTree: pruneTree(prune(state.paneTree)), tabs, portConfigs, replaySessions, timeline });
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
