import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executePluginViewApi, issuePluginActionToken, openPluginTabForUser, dismissPluginTab, getAvailablePluginViews, startPluginViewRuntime, selectSerialPluginView, getTabViewPreference, isRawSerialDisplay } from './pluginViewRuntime';
import { useAppStore, getActivePortId } from '../stores/useAppStore';
import { resetStoresForTests } from '../stores/resetStores';
import { resetPluginSnapshotForTest, syncPluginListSnapshot } from './pluginConfigSnapshot';
import type { PluginView } from '../types';

vi.mock('../services/pluginView', () => ({ pluginViewService: { create: vi.fn(), destroy: vi.fn(), send: vi.fn(), update: vi.fn(), onMessage: vi.fn(async () => () => {}) } }));
vi.mock('../hooks/useSerialSend', () => ({ sendToPort: vi.fn() }));
const declaration = {
  id: 'table', label: 'Table', entry: 'ui.js', styles: [], assets: [],
  modes: ['trx'] as Array<'trx' | 'tty'>, input: 'bytes' as const,
  placements: ['serial-content', 'workspace-tab'] as Array<'serial-content' | 'workspace-tab'>,
  portBinding: 'required' as const, restoreOnStartup: true,
};
const plugin: PluginView = {
  id: 'com.example.views', installGeneration: 'install-a', enabled: true, dir: '',
  grantedPermissions: ['ui:view', 'ui:tabs', 'rx:bytes'], declaredPermissions: ['ui:view', 'ui:tabs', 'rx:bytes'], knownPermissions: ['ui:view', 'ui:tabs', 'rx:bytes'],
  manifestError: null, installedAt: null,
  manifest: { id: 'com.example.views', name: 'Views', version: '1.0.0', description: '', apiVersion: '1.0', entry: 'main.js', permissions: ['ui:view', 'ui:tabs', 'rx:bytes'], ui: { buttons: [], menuItems: [], views: [declaration, { ...declaration, id: 'tool', label: 'Tool', input: 'none', portBinding: 'none' }] } },
};

let clock = Date.UTC(2060, 0, 1);
beforeEach(() => {
  startPluginViewRuntime()();
  clock += 10000;
  vi.useFakeTimers(); vi.setSystemTime(clock);
  resetStoresForTests(); resetPluginSnapshotForTest();
  useAppStore.getState().setPorts([{ id: 'COM3', name: 'COM3', status: 'connected', type: 'real', isHidden: false, mode: 'trx' }, { id: 'COM4', name: 'COM4', status: 'connected', type: 'real', isHidden: false, mode: 'trx' }]);
  syncPluginListSnapshot({ revision: 0, plugins: [plugin], pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: plugin.grantedPermissions }] });
});
afterEach(() => { vi.useRealTimers(); });

async function open(options: object) { return await executePluginViewApi(plugin.id, 'tabs.open', options, plugin.manifest) as { tabId: string; created: boolean }; }

describe('plugin workspace tab authority', () => {
  it('coalesces concurrent same-key requests but keeps separate bound ports and no serial side effects', async () => {
    const [a, b] = await Promise.all([open({ viewId: 'table', portId: 'COM3', instanceKey: 'live' }), open({ viewId: 'table', portId: 'COM3', instanceKey: 'live' })]);
    expect(a.tabId).toBe(b.tabId); expect([a.created, b.created]).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    const other = await open({ viewId: 'table', portId: 'COM4', instanceKey: 'live' });
    expect(other.tabId).not.toBe(a.tabId);
    expect(useAppStore.getState().tabs.map(tab => tab.kind)).toEqual(['plugin', 'plugin']);
    expect(useAppStore.getState().activeTabId).toBeNull();
  });

  it('requires a scoped single-use action for foreground and rejects a replay', async () => {
    const serial = useAppStore.getState().openTab('COM4');
    const token = issuePluginActionToken(plugin.id, 'COM3', 'main');
    const opened = await open({ viewId: 'table', portId: 'COM3', activation: 'foreground', actionToken: token });
    expect(useAppStore.getState().activeTabId).toBe(opened.tabId);
    await expect(open({ viewId: 'table', portId: 'COM4', activation: 'foreground', actionToken: token })).rejects.toThrow('expired or scope');
    expect(useAppStore.getState().activeTabId).not.toBe(serial);
  });

  it('respects user dismissal until an explicit host open and leaves unbound tools without a send target', async () => {
    const opened = await open({ viewId: 'table', portId: 'COM3', instanceKey: 'dismiss-me' });
    dismissPluginTab(opened.tabId); useAppStore.getState().closeTab(opened.tabId);
    await expect(open({ viewId: 'table', portId: 'COM3', instanceKey: 'dismiss-me' })).rejects.toThrow('dismissed');
    vi.advanceTimersByTime(1000);
    const replacement = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'table' }, 'COM3', 'dismiss-me');
    expect(replacement).not.toBe(opened.tabId);
    vi.advanceTimersByTime(1000);
    openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'tool' }, null);
    expect(getActivePortId(useAppStore.getState())).toBeNull();
  });

  it('will not close another plugin tab or a pinned owned tab and cannot bypass revoked view grants', async () => {
    const opened = await open({ viewId: 'tool' });
    useAppStore.getState().pinTab(opened.tabId);
    await expect(executePluginViewApi(plugin.id, 'tabs.close', { tabId: opened.tabId }, plugin.manifest)).rejects.toThrow('pinned');
    const serial = useAppStore.getState().openTab('COM3');
    await expect(executePluginViewApi(plugin.id, 'tabs.close', { tabId: serial }, plugin.manifest)).rejects.toThrow('ownership');
    useAppStore.getState().setConfig({ pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: ['ui:tabs', 'rx:bytes'] }] });
    expect(getAvailablePluginViews('COM3', 'workspace-tab')).toEqual([]);
    await expect(open({ viewId: 'table', portId: 'COM3' })).rejects.toThrow('permission');
  });

  it('clears a replacement without resurrecting persisted startup preference', () => {
    const preference = { pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'table' };
    useAppStore.getState().setConfig({ portMeta: [{ portId: 'COM3', isHidden: false, displayView: preference }] });
    const id = useAppStore.getState().openTab('COM3');
    selectSerialPluginView(id, preference);
    const tab = useAppStore.getState().tabs.find(item => item.id === id)!;
    expect(getTabViewPreference(tab)).toEqual(preference);
    selectSerialPluginView(id, null);
    expect(getTabViewPreference(tab)).toBeNull();
    expect(isRawSerialDisplay(tab)).toBe(true);
    expect(useAppStore.getState().ports.find(port => port.id === 'COM3')?.displayView).toBeNull();
  });
});
