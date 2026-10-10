import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeHostApi } from './pluginHostApi';
import { useToastStore } from '../stores/useToastStore';
import { useAppStore } from '../stores/useAppStore';

const readAsset = vi.hoisted(() => vi.fn());

vi.mock('../services/tauri', () => ({
  pluginService: { readPluginAsset: readAsset }, fileService: {},
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock('../hooks/useSerialSend', () => ({ sendToPort: vi.fn() }));
vi.mock('./pluginObserver', () => ({ addPluginRxObserver: vi.fn() }));
vi.mock('./terminal/viewportManager', () => ({ appendTerminalLine: vi.fn() }));
vi.mock('./pluginPanelRegistry', () => ({
  appendPluginPanel: vi.fn(), clearPluginPanel: vi.fn(), getPluginPanelSnapshot: vi.fn(),
}));
vi.mock('./pluginBytesObserver', () => ({ addPluginBytesObserver: vi.fn() }));
vi.mock('./pluginPanelExport', () => ({ exportPluginPanel: vi.fn() }));

let testTime = Date.UTC(2060, 0, 1);
beforeEach(() => {
  vi.useFakeTimers();
  testTime += 10_000;
  vi.setSystemTime(testTime);
  readAsset.mockReset();
  useAppStore.getState().setConfig({ pluginConfigs: [{
    id: 'api.plugin', installGeneration: 'api-install', enabled: true, grantedPermissions: ['fs:assets', 'fs:storage'],
  }] });
  useToastStore.setState({ toasts: [], stashed: [], centerOpen: false });
});

afterEach(() => {
  testTime = Date.now();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('host API asset reads', () => {
  it('rejects a backend-confirmed missing file instead of returning null', async () => {
    readAsset.mockResolvedValue(null);
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'assets/missing.txt' }))
      .rejects.toThrow('plugin file not found');
    expect(readAsset).toHaveBeenCalledWith('api.plugin', 'assets/missing.txt');
  });

  it('returns an existing empty file and preserves read errors', async () => {
    readAsset.mockResolvedValueOnce('');
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'assets/empty.txt' })).resolves.toBe('');
    readAsset.mockRejectedValueOnce(new Error('plugin IO busy'));
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'assets/file.txt' }))
      .rejects.toThrow('plugin IO busy');
  });

  it('does not read a private data file without its storage grant', async () => {
    useAppStore.getState().setConfig({ pluginConfigs: [{
      id: 'api.plugin', installGeneration: 'api-install', enabled: true, grantedPermissions: ['fs:assets'],
    }] });
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'data/state.json' }))
      .rejects.toThrow('fs:storage');
    expect(readAsset).not.toHaveBeenCalled();
  });
});

describe('host API plugin notifications', () => {
  it('enforces real consumer-visible burst bounds for 200 sequential requests without logging drops', async () => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const log = vi.spyOn(console, 'log');
    for (let i = 0; i < 200; i++) {
      await expect(executeHostApi('api.plugin', 'notify', { title: `notification-${i}`, body: 'body' }))
        .resolves.toBeNull();
    }
    const state = useToastStore.getState();
    expect(state.toasts.map((toast) => toast.title)).toEqual([
      'notification-0', 'notification-1', 'notification-2', 'notification-3', 'notification-4',
    ]);
    expect(state.stashed).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('assigns authenticated source identity rather than accepting spoofed plugin or port fields', async () => {
    await executeHostApi('api.plugin', 'notify', {
      pluginId: 'other.plugin', portId: 'COM1', messageKey: 'spoofed.key',
      title: 'title', body: 'body', level: 'warn', durationMs: NaN,
    });
    const toast = useToastStore.getState().toasts[0];
    expect(toast).toMatchObject({ pluginId: 'api.plugin', title: 'title', message: 'body', severity: 'warning', durationMs: 4000 });
    expect(toast.portId).toBeUndefined();
    expect(toast.messageKey).toBeUndefined();
  });

  it('bounds worker text and nonfinite duration at the actual store consumer', async () => {
    await executeHostApi('api.plugin', 'notify', {
      title: 't'.repeat(5000), body: 'b'.repeat(10000), durationMs: Infinity,
    });
    const toast = useToastStore.getState().toasts[0];
    expect(toast.title).toBe('t'.repeat(256));
    expect(toast.message).toBe('b'.repeat(4096));
    expect(toast.durationMs).toBe(4000);
  });

  it('never accumulates more than 20 retained notifications from allowed traffic over time', async () => {
    const coreId = useToastStore.getState().push({ severity: 'error', message: 'core failure', durationMs: 0 });
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(1000);
      await executeHostApi('api.plugin', 'notify', { title: `notification-${i}` });
    }
    const state = useToastStore.getState();
    const all = [...state.stashed, ...state.toasts];
    expect(all.filter((toast) => toast.pluginId === 'api.plugin')).toHaveLength(20);
    expect(all.find((toast) => toast.id === coreId)).toMatchObject({ message: 'core failure', durationMs: 0 });
    expect(all).toHaveLength(21);
    expect(all.some((toast) => toast.title === 'notification-20')).toBe(false);
  });
});
