// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoUpdate } from './useAutoUpdate';
import { useSystemStore } from '../stores/useSystemStore';
import { commitUpdateMode, updateTiming } from '../utils/updateService';
import { updateService } from '../services/tauri';
import type * as UpdateService from '../utils/updateService';

vi.mock('../services/tauri', () => ({ updateService: { checkForUpdate: vi.fn() } }));
vi.mock('../utils/updateService', async (original) => {
  const service = await original<typeof UpdateService>();
  return {
    ...service,
    isUpdateCheckEnabled: () => true,
    runAutoCheck: () => service.runAutoCheck(true),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const testStorage = new Map<string, string>();
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
