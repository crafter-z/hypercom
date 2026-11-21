// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginService } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import type { MarketplaceUpdate, PluginConfigEntry, PluginListResponse, PluginStateSnapshot, PluginView } from '../types';
import { resetPluginSnapshotForTest } from '../utils/pluginConfigSnapshot';
import { usePluginList, type PluginListApi } from './usePlugins';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../services/tauri', () => ({
  pluginService: {
    listPlugins: vi.fn(),
    installMarketplacePlugin: vi.fn(),
  },
}));
vi.mock('../utils/pluginHost', () => ({
  pluginHost: {
    syncWithConfig: vi.fn(),
    dispose: vi.fn(),
    setCallbacks: vi.fn(),
  },
}));

const initialConfig = useAppStore.getState().config;
const id = 'com.example.demo';
const oldGeneration = 'generation-old';
const newGeneration = 'generation-new';
const entry = (installGeneration: string): PluginConfigEntry => ({
  id,
  installGeneration,
  enabled: false,
  grantedPermissions: [],
});
const update: MarketplaceUpdate = {
  id,
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  updateAvailable: true,
  descriptionUrl: 'https://market.example/plugins/com.example.demo.json',
  downloadUrl: 'https://market.example/plugins/com.example.demo-1.1.0.zip',
  manifest: {
    id,
    name: 'Demo',
    version: '1.1.0',
    description: 'Demo plugin',
    apiVersion: '1.0',
    entry: 'main.js',
    permissions: [],
  },
};

function snapshot(revision: number, pluginConfigs: PluginConfigEntry[]): PluginStateSnapshot {
  return { revision, pluginConfigs };
}

async function mountList(): Promise<{ api: PluginListApi; unmount: () => Promise<void> }> {
  let api!: PluginListApi;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    api = usePluginList();
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    get api() {
      return api;
    },
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  resetPluginSnapshotForTest();
  useAppStore.setState({
    config: { ...initialConfig, revision: 1, pluginConfigs: [entry(oldGeneration)] },
  });
  useSystemStore.getState().setUIState({ configReady: false });
  vi.mocked(pluginService.listPlugins).mockResolvedValue({
    ...snapshot(1, [entry(oldGeneration)]),
    plugins: [],
  } satisfies PluginListResponse);
});

describe('usePluginList marketplace installation', () => {
  it('binds installation to the reviewed metadata and current generation', async () => {
    const installed = snapshot(2, [entry(newGeneration)]);
    vi.mocked(pluginService.installMarketplacePlugin).mockResolvedValue(installed);
    const mounted = await mountList();

    await act(async () => {
      await expect(mounted.api.installMarketplacePlugin(update, oldGeneration)).resolves.toBeNull();
    });

    expect(pluginService.installMarketplacePlugin).toHaveBeenCalledWith(
      update.descriptionUrl,
      update.id,
      update.latestVersion,
      oldGeneration,
    );
    expect(useAppStore.getState().config.pluginConfigs).toEqual([entry(newGeneration)]);
    expect(pluginService.listPlugins).toHaveBeenCalled();
    await mounted.unmount();
  });

  it('returns the actual package for the target even if another identity changed in the response', async () => {
    const installed = entry(newGeneration);
    const unrelated = { ...entry('other-generation'), id: 'com.example.other' };
    const state = snapshot(2, [unrelated, installed]);
    const makeView = (plugin: PluginConfigEntry): PluginView => ({
      ...plugin, dir: '', installedAt: null, manifestError: null,
      declaredPermissions: ['shell:execute'], knownPermissions: ['shell:execute'],
      manifest: { ...update.manifest, id: plugin.id, permissions: ['shell:execute'] },
    });
    vi.mocked(pluginService.installMarketplacePlugin).mockResolvedValue(state);
    const mounted = await mountList();
    vi.mocked(pluginService.listPlugins).mockResolvedValue({ ...state, plugins: state.pluginConfigs.map(makeView) });
    await act(async () => {
      await expect(mounted.api.installMarketplacePlugin(update, oldGeneration)).resolves.toMatchObject({
        id, installGeneration: newGeneration, declaredPermissions: ['shell:execute'],
      });
    });
    await mounted.unmount();
  });

  it('does not claim success or mutate local state when marketplace installation fails', async () => {
    vi.mocked(pluginService.installMarketplacePlugin).mockRejectedValue(new Error('metadata changed'));
    const mounted = await mountList();

    await act(async () => {
      await expect(mounted.api.installMarketplacePlugin(update, oldGeneration)).rejects.toThrow('metadata changed');
    });

    expect(useAppStore.getState().config.pluginConfigs).toEqual([entry(oldGeneration)]);
    expect(mounted.api.loading).toBe(false);
    await mounted.unmount();
  });
});
