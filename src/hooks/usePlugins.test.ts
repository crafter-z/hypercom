// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { pluginService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { rxEligiblePluginIds, usePluginList, isPluginReplaceConfirmationError, type PluginListApi } from './usePlugins';
import { pluginHost } from '../utils/pluginHost';
import { reloadPluginViews } from '../utils/pluginViewRuntime';
import { useToastStore } from '../stores/useToastStore';
import {
  getPluginViews, resetPluginSnapshotForTest, syncPluginListSnapshot, syncStorePluginConfigs,
} from '../utils/pluginConfigSnapshot';
import { getPluginUiSnapshot } from '../utils/pluginUiRegistry';
import type { PluginConfigEntry, PluginListResponse, PluginStateSnapshot, PluginView } from '../types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../services/tauri', () => ({
  pluginService: {
    listPlugins: vi.fn(), installPlugin: vi.fn(), reloadPlugin: vi.fn(), uninstallPlugin: vi.fn(),
    setPluginEnabled: vi.fn(), setPluginPermissions: vi.fn(),
    setPluginTrustedWeb: vi.fn(), clearPluginWebData: vi.fn(),
    readPluginAsset: vi.fn(), writePluginAsset: vi.fn(), pluginHttp: vi.fn(), pluginOpenExternal: vi.fn(),
  },
}));
vi.mock('../utils/pluginHost', () => ({
  pluginHost: { dispose: vi.fn(), disable: vi.fn(), syncWithConfig: vi.fn(), reload: vi.fn(), enable: vi.fn(), get: vi.fn(() => null), setCallbacks: vi.fn() },
}));
vi.mock('../utils/pluginViewRuntime', () => ({ reloadPluginViews: vi.fn() }));

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
  useToastStore.getState().clearAll();
  vi.mocked(pluginHost.reload).mockResolvedValue(undefined);
  vi.mocked(pluginHost.syncWithConfig).mockReturnValue(0);
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

describe('trusted webpage authorization', () => {
  it('rejects consent for an installation replaced while its dialog was open', async () => {
    syncStorePluginConfigs(snapshot(1, [entry([], false, 'install-b')]));
    const mounted = await mountList();
    await act(async () => {
      await expect(mounted.api.setTrustedWeb(id, true, 'install-a')).rejects.toThrow();
    });
    expect(pluginService.setPluginTrustedWeb).not.toHaveBeenCalled();
    expect(useAppStore.getState().config.pluginConfigs[0].enabled).toBe(false);
    await mounted.unmount();
  });

  it('disables before clearing web data and leaves the plugin disabled', async () => {
    syncStorePluginConfigs(snapshot(1, [entry()]));
    const disabled = deferred<PluginStateSnapshot>();
    vi.mocked(pluginService.setPluginEnabled).mockReturnValue(disabled.promise);
    vi.mocked(pluginService.clearPluginWebData).mockResolvedValue(snapshot(3, [entry([], false)]));
    const mounted = await mountList();
    let clearing!: Promise<void>;
    await act(async () => { clearing = mounted.api.clearWebData(id, 'install-a'); });
    expect(pluginService.setPluginEnabled).toHaveBeenCalledWith(id, false, 'install-a');
    expect(pluginService.clearPluginWebData).not.toHaveBeenCalled();
    await act(async () => { disabled.resolve(snapshot(2, [entry([], false)])); await clearing; });
    expect(pluginService.clearPluginWebData).toHaveBeenCalledWith(id, 'install-a');
    expect(useAppStore.getState().config.pluginConfigs[0].enabled).toBe(false);
    await mounted.unmount();
  });
});

const toastKeys = (): Array<string | undefined> => useToastStore.getState().toasts.map(toast => toast.messageKey);

describe('reloading installed code', () => {
  it('retires old code, reloads the backend, then restarts the Worker and remounts views without touching data or grants', async () => {
    const installed = { ...entry(['terminal:read']), trustedWebGranted: true };
    syncStorePluginConfigs(snapshot(1, [installed]));
    const order: string[] = [];
    vi.mocked(pluginHost.disable).mockImplementation(() => { order.push('stop'); });
    vi.mocked(pluginService.reloadPlugin).mockImplementation(async () => {
      order.push('backend');
      return snapshot(2, [installed]);
    });
    vi.mocked(pluginHost.reload).mockImplementation(async () => { order.push('restart'); });
    vi.mocked(reloadPluginViews).mockImplementation(() => { order.push('views'); });
    const mounted = await mountList();
    await act(async () => { await mounted.api.reloadPlugin(id, 'install-a'); });
    expect(order).toEqual(['stop', 'backend', 'restart', 'views']);
    expect(pluginService.reloadPlugin).toHaveBeenCalledWith(id, 'install-a');
    expect(pluginHost.reload).toHaveBeenCalledWith(id);
    expect(useAppStore.getState().config.pluginConfigs[0]).toMatchObject({
      installGeneration: 'install-a', enabled: true, grantedPermissions: ['terminal:read'], trustedWebGranted: true,
    });
    expect(toastKeys()).toContain('plugins.reloaded');
    await mounted.unmount();
  });

  it('leaves a stale installation untouched and reports no success', async () => {
    syncStorePluginConfigs(snapshot(1, [entry([], true, 'install-b')]));
    const mounted = await mountList();
    await act(async () => {
      await expect(mounted.api.reloadPlugin(id, 'install-a')).rejects.toThrow(/installation changed/);
    });
    expect(pluginHost.disable).not.toHaveBeenCalled();
    expect(pluginHost.reload).not.toHaveBeenCalled();
    expect(pluginService.reloadPlugin).not.toHaveBeenCalled();
    expect(toastKeys()).not.toContain('plugins.reloaded');
    await mounted.unmount();
  });

  it('does not announce success when the backend reload fails', async () => {
    syncStorePluginConfigs(snapshot(1, [entry()]));
    vi.mocked(pluginService.reloadPlugin).mockRejectedValue(new Error('generation mismatch'));
    const mounted = await mountList();
    await act(async () => {
      await expect(mounted.api.reloadPlugin(id, 'install-a')).rejects.toThrow('generation mismatch');
    });
    expect(pluginHost.reload).not.toHaveBeenCalled();
    expect(reloadPluginViews).not.toHaveBeenCalled();
    expect(toastKeys()).not.toContain('plugins.reloaded');
    expect(useToastStore.getState().toasts.some(toast => toast.severity === 'error' && toast.message === 'generation mismatch')).toBe(true);
    expect(pluginHost.disable).toHaveBeenCalledWith(id);
    await mounted.unmount();
  });
});

describe('explicit replacement installs', () => {
  const conflict = 'plugin_replace_confirmation_required: installed 1.0.0 is not lower than source 1.0.0';

  it('surfaces the same/lower refusal as a confirmation signal instead of an error toast', async () => {
    syncStorePluginConfigs(snapshot(1, [entry()]));
    vi.mocked(pluginService.installPlugin).mockRejectedValue(conflict);
    const mounted = await mountList();
    let caught: unknown;
    await act(async () => {
      caught = await mounted.api.installPlugin('/plugins/demo').catch(error => error);
    });
    expect(isPluginReplaceConfirmationError(caught)).toBe(true);
    expect(toastKeys()).toEqual([]);
    expect(pluginHost.dispose).not.toHaveBeenCalled();
    expect(pluginHost.syncWithConfig).toHaveBeenCalledWith(true);
    await mounted.unmount();
  });

  it('retries with replaceExisting only when explicitly requested', async () => {
    syncStorePluginConfigs(snapshot(1, [entry([], true, 'install-a')]));
    vi.mocked(pluginService.installPlugin).mockResolvedValue(snapshot(2, [entry([], true, 'install-b')]));
    const mounted = await mountList();
    await act(async () => { await mounted.api.installPlugin('/plugins/demo'); });
    expect(pluginService.installPlugin).toHaveBeenLastCalledWith('/plugins/demo', undefined);
    await act(async () => { await mounted.api.installPlugin('/plugins/demo', true); });
    expect(pluginService.installPlugin).toHaveBeenLastCalledWith('/plugins/demo', true);
    expect(useAppStore.getState().config.pluginConfigs[0].installGeneration).toBe('install-b');
    await mounted.unmount();
  });
});

describe('install session isolation and refresh failures', () => {
  it('does not dispose unrelated Workers while an install is pending or completes', async () => {
    syncStorePluginConfigs(snapshot(1, [entry()]));
    const pending = deferred<PluginStateSnapshot>();
    vi.mocked(pluginService.installPlugin).mockReturnValue(pending.promise);
    const mounted = await mountList();
    let installing!: Promise<PluginView | null>;
    await act(async () => { installing = mounted.api.installPlugin('/plugins/new'); });
    expect(pluginHost.dispose).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(snapshot(2, [entry(), { ...entry([], false, 'other-install'), id: 'com.example.other' }]));
      await installing;
    });
    expect(pluginHost.dispose).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it('applies an authoritative install snapshot even when the follow-up manifest list fails', async () => {
    syncStorePluginConfigs(snapshot(1, [entry()]));
    const mounted = await mountList();
    useSystemStore.getState().setUIState({ configReady: true });
    vi.mocked(pluginService.installPlugin).mockResolvedValue(snapshot(2, [entry([], false, 'install-b')]));
    vi.mocked(pluginService.listPlugins).mockRejectedValue(new Error('manifest scan failed'));
    await act(async () => { await mounted.api.installPlugin('/plugins/demo'); });
    expect(useAppStore.getState().config.pluginConfigs[0]).toMatchObject({
      installGeneration: 'install-b', enabled: false,
    });
    expect(pluginHost.syncWithConfig).toHaveBeenCalledWith(true);
    expect(pluginHost.dispose).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it('does not remount views or report reload success when its manifest refresh fails', async () => {
    syncStorePluginConfigs(snapshot(1, [entry()]));
    const mounted = await mountList();
    vi.mocked(pluginService.reloadPlugin).mockResolvedValue(snapshot(2, [entry()]));
    vi.mocked(pluginService.listPlugins).mockRejectedValue(new Error('manifest scan failed'));
    await act(async () => {
      await expect(mounted.api.reloadPlugin(id, 'install-a')).rejects.toThrow('manifest scan failed');
    });
    expect(reloadPluginViews).not.toHaveBeenCalled();
    expect(toastKeys()).not.toContain('plugins.reloaded');
    expect(pluginHost.dispose).toHaveBeenCalledOnce();
    await mounted.unmount();
  });
});

describe('reload authorization guards', () => {
  it('refuses to reload a disabled plugin without stopping running code', async () => {
    syncStorePluginConfigs(snapshot(1, [entry([], false)]));
    const mounted = await mountList();
    await act(async () => {
      await expect(mounted.api.reloadPlugin(id, 'install-a')).rejects.toThrow(/disabled/);
    });
    expect(pluginHost.reload).not.toHaveBeenCalled();
    expect(pluginService.reloadPlugin).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it('does not announce success for a reload snapshot older than the accepted configuration', async () => {
    syncStorePluginConfigs(snapshot(5, [entry()]));
    vi.mocked(pluginService.reloadPlugin).mockResolvedValue(snapshot(4, [entry()]));
    const mounted = await mountList();
    await act(async () => {
      await expect(mounted.api.reloadPlugin(id, 'install-a')).rejects.toThrow(/stale/);
    });
    expect(reloadPluginViews).not.toHaveBeenCalled();
    expect(toastKeys()).not.toContain('plugins.reloaded');
    await mounted.unmount();
  });
});
