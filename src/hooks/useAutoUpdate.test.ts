// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoUpdate } from './useAutoUpdate';
import { useSystemStore } from '../stores/useSystemStore';
import { commitUpdateMode, isUpdateCheckEnabled, updateTiming } from '../utils/updateService';
import {
  isPluginUpdateCheckEnabled,
  pluginUpdateTiming,
  resetPluginUpdateTracking,
  runPluginAutoCheck,
} from '../utils/pluginUpdateService';
import { updateService } from '../services/tauri';
import type * as UpdateService from '../utils/updateService';
import type * as PluginUpdateService from '../utils/pluginUpdateService';

vi.mock('../services/tauri', () => ({ updateService: { checkForUpdate: vi.fn() } }));
vi.mock('../utils/updateService', async (original) => {
  const service = await original<typeof UpdateService>();
  return {
    ...service,
    // 测试里显式注入平台/DEV 门控：本文件默认「软件检查可用」，macOS 语义
    // 由单个用例改写。
    isUpdateCheckEnabled: vi.fn(() => true),
    runAutoCheck: vi.fn(() => service.runAutoCheck(true)),
  };
});
vi.mock('../utils/pluginUpdateService', async (original) => {
  const service = await original<typeof PluginUpdateService>();
  return {
    ...service,
    // 本文件聚焦「软件 + 插件联动编排」，插件检查本身的行为由
    // pluginUpdateService.test.ts 覆盖，这里只观察调用与门控。
    isPluginUpdateCheckEnabled: vi.fn(() => true),
    runPluginAutoCheck: vi.fn(async () => ({ skipped: false, failed: false, updates: [], notified: false })),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const testStorage = new Map<string, string>();
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let root: Root;
let container: HTMLDivElement;
function Probe() {
  useAutoUpdate();
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { platform: 'Win32' });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => testStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { testStorage.set(key, String(value)); },
    removeItem: (key: string) => { testStorage.delete(key); },
    clear: () => testStorage.clear(),
  });
  localStorage.clear();
  useSystemStore.getState().setUIState({ configReady: false, isUpdateOpen: false, updateCandidate: null, isUpdateInstalling: false });
  commitUpdateMode('stable');
  resetPluginUpdateTracking();
  vi.mocked(isUpdateCheckEnabled).mockReturnValue(true);
  vi.mocked(isPluginUpdateCheckEnabled).mockReturnValue(true);
  vi.mocked(runPluginAutoCheck).mockClear();
  vi.mocked(updateService.checkForUpdate).mockReset().mockResolvedValue(null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('automatic update startup readiness', () => {
  it.each(['none', 'preview'] as const)('waits beyond fifteen seconds for persisted %s mode', async (mode) => {
    await act(async () => vi.advanceTimersByTimeAsync(16_000));
    expect(updateService.checkForUpdate).not.toHaveBeenCalled();
    expect(updateTiming.getLastCheckAt()).toBeNull();
    await act(async () => {
      commitUpdateMode(mode);
      useSystemStore.getState().setUIState({ configReady: true });
    });
    if (mode === 'none') {
      expect(updateService.checkForUpdate).not.toHaveBeenCalled();
      expect(updateTiming.getLastCheckAt()).toBeNull();
    } else {
      expect(updateService.checkForUpdate).toHaveBeenCalledExactlyOnceWith('preview');
      expect(updateTiming.getLastCheckAt()).not.toBeNull();
    }
  });
});

describe('plugin update linkage', () => {
  it('triggers the app and plugin checks together once config is ready', async () => {
    await act(async () => {
      useSystemStore.getState().setUIState({ configReady: true });
    });
    expect(updateService.checkForUpdate).toHaveBeenCalledExactlyOnceWith('stable');
    expect(runPluginAutoCheck).toHaveBeenCalledTimes(1);
  });

  it('skips both checks in committed mode none', async () => {
    commitUpdateMode('none');
    await act(async () => {
      useSystemStore.getState().setUIState({ configReady: true });
    });
    expect(updateService.checkForUpdate).not.toHaveBeenCalled();
    expect(runPluginAutoCheck).not.toHaveBeenCalled();
  });

  it('re-evaluates after six hours and triggers the still-due plugin check again', async () => {
    await act(async () => {
      useSystemStore.getState().setUIState({ configReady: true });
    });
    expect(runPluginAutoCheck).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);
    });
    expect(runPluginAutoCheck).toHaveBeenCalledTimes(2);
  });

  it('still checks plugins when app update checks are disabled (macOS semantics)', async () => {
    vi.mocked(isUpdateCheckEnabled).mockReturnValue(false);
    await act(async () => {
      useSystemStore.getState().setUIState({ configReady: true });
    });
    expect(updateService.checkForUpdate).not.toHaveBeenCalled();
    expect(runPluginAutoCheck).toHaveBeenCalledTimes(1);
  });

  it('skips the plugin check when only plugin auto-check is disabled', async () => {
    vi.mocked(isPluginUpdateCheckEnabled).mockReturnValue(false);
    await act(async () => {
      useSystemStore.getState().setUIState({ configReady: true });
    });
    expect(updateService.checkForUpdate).toHaveBeenCalledExactlyOnceWith('stable');
    expect(runPluginAutoCheck).not.toHaveBeenCalled();
    // Sanity: plugin ledger stays untouched by the app-only path.
    expect(pluginUpdateTiming.getLastCheckAt()).toBeNull();
  });
});
