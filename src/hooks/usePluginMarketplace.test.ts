// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginService } from '../services/tauri';
import type { MarketplaceIndex, MarketplaceUpdate } from '../types';
import { usePluginMarketplace, type PluginMarketplaceApi } from './usePlugins';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../services/tauri', () => ({
  pluginService: {
    fetchPluginMarketplace: vi.fn(),
    checkPluginUpdates: vi.fn(),
  },
}));

const index: MarketplaceIndex = {
  schemaVersion: 1,
  plugins: ['https://market.example/plugins/com.example.demo.json'],
};
const update: MarketplaceUpdate = {
  id: 'com.example.demo',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  updateAvailable: true,
  descriptionUrl: 'https://market.example/plugins/com.example.demo.json',
  downloadUrl: 'https://market.example/plugins/com.example.demo-1.1.0.zip',
  manifest: {
    id: 'com.example.demo',
    name: 'Demo',
    version: '1.1.0',
    description: 'Demo plugin',
    apiVersion: '1.0',
    entry: 'main.js',
    permissions: [],
  },
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function mount(sourceUrl: string): Promise<{
  root: Root;
  getApi: () => PluginMarketplaceApi;
  rerender: (nextSourceUrl: string) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  let api!: PluginMarketplaceApi;
  const root = createRoot(document.createElement('div'));
  function Probe({ source }: { source: string }) {
    api = usePluginMarketplace(source);
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe, { source: sourceUrl }));
  });
  return {
    root,
    getApi: () => api,
    rerender: async (nextSourceUrl) => {
      await act(async () => {
        root.render(createElement(Probe, { source: nextSourceUrl }));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('usePluginMarketplace', () => {
  it('does not call the backend for an empty source', async () => {
    const mounted = await mount('   ');
    await act(async () => {
      expect(await mounted.getApi().fetchIndex()).toBeNull();
    });
    expect(pluginService.fetchPluginMarketplace).not.toHaveBeenCalled();
    expect(mounted.getApi().error).toBe('marketplace source is empty');
    await mounted.unmount();
  });

  it('ignores an index response from a source that was replaced while loading', async () => {
    const first = deferred<MarketplaceIndex>();
    const second = deferred<MarketplaceIndex>();
    vi.mocked(pluginService.fetchPluginMarketplace)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const mounted = await mount('https://market.example/one.json');

    let staleResult!: Promise<MarketplaceIndex | null>;
    await act(async () => {
      staleResult = mounted.getApi().fetchIndex();
    });
    await mounted.rerender('https://market.example/two.json');
    await act(async () => {
      first.resolve(index);
      expect(await staleResult).toBeNull();
    });
    expect(mounted.getApi().index).toBeNull();

    let currentResult!: Promise<MarketplaceIndex | null>;
    await act(async () => {
      currentResult = mounted.getApi().fetchIndex();
      second.resolve({ ...index, plugins: ['https://market.example/plugins/other.json'] });
      expect(await currentResult).toEqual({
        schemaVersion: 1,
        plugins: ['https://market.example/plugins/other.json'],
      });
    });
    expect(pluginService.fetchPluginMarketplace).toHaveBeenNthCalledWith(1, 'https://market.example/one.json');
    expect(pluginService.fetchPluginMarketplace).toHaveBeenNthCalledWith(2, 'https://market.example/two.json');
    expect(mounted.getApi().loading).toBe(false);
    await mounted.unmount();
  });

  it('publishes update results only for the current source epoch', async () => {
    const first = deferred<MarketplaceUpdate[]>();
    const second = deferred<MarketplaceUpdate[]>();
    vi.mocked(pluginService.checkPluginUpdates)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const mounted = await mount('https://market.example/one.json');

    let staleResult!: Promise<MarketplaceUpdate[] | null>;
    await act(async () => {
      staleResult = mounted.getApi().checkUpdates();
    });
    await mounted.rerender('https://market.example/two.json');
    await act(async () => {
      first.resolve([update]);
      expect(await staleResult).toBeNull();
    });
    expect(mounted.getApi().updates).toEqual([]);

    let currentResult!: Promise<MarketplaceUpdate[] | null>;
    await act(async () => {
      currentResult = mounted.getApi().checkUpdates();
      second.resolve([update]);
      expect(await currentResult).toEqual([update]);
    });
    expect(mounted.getApi().updates).toEqual([update]);
    expect(mounted.getApi().error).toBeNull();
    await mounted.unmount();
  });

  it('exposes backend errors without retaining a loading state', async () => {
    vi.mocked(pluginService.fetchPluginMarketplace).mockRejectedValue(new Error('invalid marketplace index'));
    const mounted = await mount('https://market.example/bad.json');
    await act(async () => {
      expect(await mounted.getApi().fetchIndex()).toBeNull();
    });
    expect(mounted.getApi().error).toBe('invalid marketplace index');
    expect(mounted.getApi().loading).toBe(false);
    await mounted.unmount();
  });
});

