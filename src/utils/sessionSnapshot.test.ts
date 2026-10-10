import { beforeEach, describe, expect, it } from 'vitest';
import { buildSessionSnapshot, parseSessionSnapshot } from './sessionSnapshot';
import { getActivePortId, useAppStore } from '../stores/useAppStore';
import { resetStoresForTests } from '../stores/resetStores';
import { collectLeaves } from './paneTree';
import { resetPluginSnapshotForTest } from './pluginConfigSnapshot';
import type { PluginTabItem } from '../types';

const serialId = '00000000-0000-4000-8000-000000000001';
const toolId = '00000000-0000-4000-8000-000000000002';
const pluginTab: PluginTabItem = { id: toolId, kind: 'plugin', title: 'Settings', splitPaneId: 'tools', isPinned: true, pluginId: 'sensor', installGeneration: 'old-install', viewId: 'settings', boundPortId: null, instanceKey: 'settings', restoreOnStartup: true };

beforeEach(() => {
  resetStoresForTests();
  resetPluginSnapshotForTest();
});

describe('typed workspace session persistence', () => {
  it('migrates legacy raw-port identity and rewrites tree references without auto-connect', () => {
    const snapshot = parseSessionSnapshot({
      paneTree: { id: 'root', type: 'branch', direction: 'vertical', size: 1, children: [
        { id: 'main', type: 'leaf', size: 0.5, tabIds: ['COM1', 'missing'] },
        { id: 'other', type: 'leaf', size: 0.5, tabIds: ['COM1'] },
      ] },
      tabs: [
        { id: 'COM1', title: 'COM1', splitPaneId: 'main', isPinned: true },
        { id: 'missing', title: 'missing', splitPaneId: 'main', isPinned: false },
      ],
      portConfigs: { COM1: { baudRate: 9600, dataBits: 7, parity: 'Even', stopBits: 'One', handshake: 'None', status: 'connected' }, missing: { baudRate: 1 } },
    }, new Set(['COM1']), () => serialId);
    expect(snapshot.tabs).toEqual([{ kind: 'serial', id: serialId, portId: 'COM1', title: 'COM1', splitPaneId: 'main', isPinned: true }]);
    expect(collectLeaves(snapshot.paneTree).flatMap((leaf) => leaf.tabIds)).toEqual([serialId]);
    expect(snapshot.portConfigs).toEqual({ COM1: { baudRate: 9600, dataBits: 7, parity: 'Even', stopBits: 'One', handshake: 'None' } });
    useAppStore.getState().restoreSessionSnapshot(snapshot);
    expect(getActivePortId(useAppStore.getState())).toBe('COM1');
    expect(useAppStore.getState().ports).toEqual([]);
  });

  it('retains unavailable restorable descriptors without manufacturing tool port configs', () => {
    const snapshot = parseSessionSnapshot({ tabs: [pluginTab], portConfigs: { [toolId]: { baudRate: 115200 } }, paneTree: { id: 'tools', type: 'leaf', size: 1, tabIds: [toolId] } }, new Set());
    expect(snapshot.tabs).toEqual([pluginTab]);
    expect(snapshot.portConfigs).toEqual({});
    useAppStore.getState().restoreSessionSnapshot(snapshot);
    expect(getActivePortId(useAppStore.getState())).toBeNull();
    useAppStore.getState().setConfig({ restoreSession: true });
    const saved = JSON.parse(buildSessionSnapshot(useAppStore.getState())!);
    expect(saved.tabs).toEqual([pluginTab]);
    expect(saved.portConfigs).toEqual({});
  });

  it('rejects malformed, duplicate and non-restorable descriptors and repairs corrupt layouts', () => {
    const serial = { kind: 'serial', id: serialId, portId: 'COM1', title: 'COM1', splitPaneId: 'missing', isPinned: false };
    const snapshot = parseSessionSnapshot({ tabs: [serial, { ...serial, id: toolId }, { ...pluginTab, id: 'not-uuid' }, { ...pluginTab, restoreOnStartup: false }, { ...pluginTab, boundPortId: 3 }, { ...pluginTab, id: '00000000-0000-4000-8000-000000000003' }], paneTree: { id: 'bad', type: 'leaf', size: 1, tabIds: [3] } }, new Set(['COM1']));
    expect(snapshot.tabs).toHaveLength(2);
    expect(snapshot.tabs[0]).toMatchObject({ kind: 'serial', portId: 'COM1', splitPaneId: 'main' });
    expect(collectLeaves(snapshot.paneTree).flatMap((leaf) => leaf.tabIds)).toEqual(snapshot.tabs.map((tab) => tab.id));
  });

  it('prunes transient plugin tabs and saves serial parameters only under explicit port identity', () => {
    const store = useAppStore.getState();
    store.setConfig({ restoreSession: true });
    store.setPorts([{ id: 'COM1', name: 'COM1', status: 'disconnected', type: 'real', isHidden: false, baudRate: 9600 }]);
    const id = store.openTab('COM1');
    const transientId = store.addPluginTab({ kind: 'plugin', pluginId: 'sensor', installGeneration: 'g1', viewId: 'temp', boundPortId: 'COM2', instanceKey: '', restoreOnStartup: false, title: 'temp' });
    const saved = JSON.parse(buildSessionSnapshot(useAppStore.getState())!);
    expect(saved.tabs).toEqual([{ kind: 'serial', id, portId: 'COM1', title: 'COM1', splitPaneId: 'main', isPinned: false }]);
    expect(Object.keys(saved.portConfigs)).toEqual(['COM1']);
    expect(saved.portConfigs.COM1.baudRate).toBe(9600);
    expect(collectLeaves(saved.paneTree).flatMap((leaf) => leaf.tabIds)).not.toContain(transientId);
  });
});
