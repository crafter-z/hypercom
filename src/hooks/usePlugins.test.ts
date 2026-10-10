// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { pluginService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { rxEligiblePluginIds, usePluginList, type PluginListApi } from './usePlugins';
import {
  getPluginViews, resetPluginSnapshotForTest, syncPluginListSnapshot, syncStorePluginConfigs,
} from '../utils/pluginConfigSnapshot';
import { getPluginUiSnapshot } from '../utils/pluginUiRegistry';
import type { PluginConfigEntry, PluginListResponse, PluginStateSnapshot, PluginView } from '../types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../services/tauri', () => ({
  pluginService: {
    listPlugins: vi.fn(), installPlugin: vi.fn(), uninstallPlugin: vi.fn(),
    setPluginEnabled: vi.fn(), setPluginPermissions: vi.fn(),
    readPluginAsset: vi.fn(), writePluginAsset: vi.fn(), pluginHttp: vi.fn(), pluginOpenExternal: vi.fn(),
  },
}));

const initialConfig = useAppStore.getState().config;
const id = 'com.example.demo';
const entry = (permissions: string[] = [], enabled = true, generation = 'install-a'): PluginConfigEntry => ({
  id, enabled, grantedPermissions: permissions, installGeneration: generation,
});
const snapshot = (revision: number, plugins: PluginConfigEntry[]): PluginStateSnapshot => ({ revision, pluginConfigs: plugins });
const view = (plugin: PluginConfigEntry): PluginView => ({
  ...plugin, dir: 'plugins/' + plugin.id, installedAt: 1, declaredPermissions: ['terminal:read', 'rx:bytes'],
  knownPermissions: ['terminal:read', 'rx:bytes'], manifestError: null,
  manifest: { id: plugin.id, name: 'Demo', version: '1.0.0', apiVersion: '1.0', description: '',
    entry: 'main.js', permissions: ['terminal:read', 'rx:bytes'],
    ui: { buttons: [{ id: 'button', label: 'Demo action' }], menuItems: [] } },
});
const list = (state: PluginStateSnapshot): PluginListResponse => ({ ...state, plugins: state.pluginConfigs.map(view) });

// Node's test runtime supports this API; application WebViews still target ES2020.
function deferred<T>() {
  const runtimePromise = Promise as unknown as { withResolvers<U>(): { promise: Promise<U>; resolve: (value: U) => void } };
  return runtimePromise.withResolvers<T>();
}

beforeEach(() => {
  vi.resetAllMocks();
  resetPluginSnapshotForTest();
  useAppStore.setState({ config: { ...initialConfig, revision: 0, pluginConfigs: [] } });
  useSystemStore.getState().setUIState({ configReady: false });
  vi.mocked(pluginService.listPlugins).mockImplementation(async () => list({
    revision: useAppStore.getState().config.revision ?? 0,
    pluginConfigs: useAppStore.getState().config.pluginConfigs,
  }));
});

async function mountList() {
  let api!: PluginListApi;
  const root = createRoot(document.createElement('div'));
  function Probe() { api = usePluginList(); return null; }
  await act(async () => { root.render(createElement(Probe)); });
  return { get api() { return api; }, unmount: async () => { await act(async () => { root.unmount(); }); } };
}

describe('ordered plugin authorization snapshots', () => {
  it('does not revive RX authorization when an older mutation arrives after revocation', () => {
    syncStorePluginConfigs(snapshot(1, [entry(['terminal:read'])]));
    expect(rxEligiblePluginIds().has(id)).toBe(true);
    syncStorePluginConfigs(snapshot(3, [entry([])]));
    syncStorePluginConfigs(snapshot(2, [entry(['terminal:read'])]));
    expect(rxEligiblePluginIds().has(id)).toBe(false);
  });

  it('does not revive a removed plugin or its buttons from an older disk list', () => {
    syncPluginListSnapshot(list(snapshot(1, [entry(['terminal:read'])])));
    expect(getPluginUiSnapshot().toolbarButtons[0].buttons[0].label).toBe('Demo action');
    syncStorePluginConfigs(snapshot(3, []));
    syncPluginListSnapshot(list(snapshot(2, [entry(['terminal:read'])])));
    expect(rxEligiblePluginIds().has(id)).toBe(false);
    expect(getPluginUiSnapshot().toolbarButtons).toEqual([]);
    expect(getPluginViews()).toEqual([]);
  });

  it('uses a newer full configuration revision as a publication floor', () => {
    useAppStore.getState().setConfig({ revision: 10, pluginConfigs: [entry([])] });
    syncStorePluginConfigs(snapshot(9, [entry(['terminal:read'])]));
    expect(rxEligiblePluginIds().has(id)).toBe(false);
  });

  it('retires old manifest buttons until a view for the replacement code is available', () => {
    syncPluginListSnapshot(list(snapshot(1, [entry()])));
    syncStorePluginConfigs(snapshot(2, [entry([], false, 'install-b')]));
    expect(getPluginUiSnapshot().toolbarButtons).toEqual([]);
    expect(getPluginViews()).toEqual([]);
    syncPluginListSnapshot(list(snapshot(2, [entry([], false, 'install-b')])));
    expect(getPluginViews()[0].installGeneration).toBe('install-b');
  });

  it('requires both an enabled installation and a current read grant for RX', () => {
    syncStorePluginConfigs(snapshot(1, [entry(['terminal:read'], false)]));
    expect(rxEligiblePluginIds().has(id)).toBe(false);
    syncStorePluginConfigs(snapshot(2, [entry([], true)]));
    expect(rxEligiblePluginIds().has(id)).toBe(false);
    syncStorePluginConfigs(snapshot(3, [entry(['terminal:read'], true)]));
    expect(rxEligiblePluginIds().has(id)).toBe(true);
  });
});

describe('reviewed installation permission edits', () => {
  it('serializes rapid clicks without losing either requested grant', async () => {
    syncStorePluginConfigs(snapshot(1, [entry()]));
    const { promise, resolve } = deferred<PluginStateSnapshot>();
    vi.mocked(pluginService.setPluginPermissions)
      .mockReturnValueOnce(promise)
      .mockImplementationOnce(async (_id, permissions) => snapshot(3, [entry(permissions)]));
    const mounted = await mountList();
    const first = mounted.api.togglePermission(id, 'terminal:read', 'install-a');
    const second = mounted.api.togglePermission(id, 'rx:bytes', 'install-a');
    await vi.waitFor(() => expect(pluginService.setPluginPermissions).toHaveBeenCalledTimes(1));
    await act(async () => { resolve(snapshot(2, [entry(['terminal:read'])])); await Promise.all([first, second]); });
    expect(useAppStore.getState().config.pluginConfigs[0].grantedPermissions).toEqual(['terminal:read', 'rx:bytes']);
    await mounted.unmount();
  });

  it('persists pre-run authorization before enabling a plugin that needs it at startup', async () => {
    syncStorePluginConfigs(snapshot(1, [entry([], false)]));
    const { promise, resolve } = deferred<PluginStateSnapshot>();
    vi.mocked(pluginService.setPluginPermissions).mockReturnValueOnce(promise);
    vi.mocked(pluginService.setPluginEnabled).mockResolvedValue(snapshot(3, [entry(['terminal:read'])]));
    const mounted = await mountList();
    const grant = mounted.api.togglePermission(id, 'terminal:read', 'install-a');
    await vi.waitFor(() => expect(pluginService.setPluginPermissions).toHaveBeenCalledTimes(1));
    const enable = mounted.api.setEnabled(id, true, 'install-a');
    await Promise.resolve();
    expect(pluginService.setPluginEnabled).not.toHaveBeenCalled();
    expect(rxEligiblePluginIds().has(id)).toBe(false);
    await act(async () => {
      resolve(snapshot(2, [entry(['terminal:read'], false)]));
      await Promise.all([grant, enable]);
    });
    expect(rxEligiblePluginIds().has(id)).toBe(true);
    await mounted.unmount();
  });

  it('rejects a queued old-view click when an upgrade replaces the installation', async () => {
    syncStorePluginConfigs(snapshot(1, [entry(['terminal:read'])]));
    const { promise, resolve } = deferred<PluginStateSnapshot>();
    vi.mocked(pluginService.setPluginPermissions).mockReturnValueOnce(promise);
    const mounted = await mountList();
    const first = mounted.api.togglePermission(id, 'terminal:read', 'install-a');
    const second = mounted.api.togglePermission(id, 'rx:bytes', 'install-a');
    await vi.waitFor(() => expect(pluginService.setPluginPermissions).toHaveBeenCalledTimes(1));
    await act(async () => {
      syncStorePluginConfigs(snapshot(3, [entry([], false, 'install-b')]));
      resolve(snapshot(2, [entry([])]));
      await Promise.all([first, second]);
    });
    expect(pluginService.setPluginPermissions).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().config.pluginConfigs[0]).toMatchObject({
      installGeneration: 'install-b', enabled: false, grantedPermissions: [],
    });
    await mounted.unmount();
  });

  it('keeps a completed revocation when an earlier list finishes late', async () => {
    const authorized = snapshot(1, [entry(['terminal:read'])]);
    const revoked = snapshot(2, [entry([])]);
    syncStorePluginConfigs(authorized);
    vi.mocked(pluginService.setPluginPermissions).mockResolvedValue(revoked);
    const mounted = await mountList();
    const { promise, resolve } = deferred<PluginListResponse>();
    vi.mocked(pluginService.listPlugins).mockReturnValueOnce(promise);
    const pending = mounted.api.refresh();
    await act(async () => { await mounted.api.togglePermission(id, 'terminal:read', 'install-a'); });
    await act(async () => { resolve(list(authorized)); await pending; });
    expect(rxEligiblePluginIds().has(id)).toBe(false);
    await mounted.unmount();
  });
});
