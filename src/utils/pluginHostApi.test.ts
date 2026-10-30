import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeHostApi } from './pluginHostApi';
import { useToastStore } from '../stores/useToastStore';
import { useAppStore } from '../stores/useAppStore';

const readAsset = vi.hoisted(() => vi.fn());
const writeAsset = vi.hoisted(() => vi.fn());
const pickFiles = vi.hoisted(() => vi.fn());
const clipboardWrite = vi.hoisted(() => vi.fn());
const executeHttp = vi.hoisted(() => vi.fn());
const executeViewApi = vi.hoisted(() => vi.fn());

vi.mock('../services/tauri', () => ({
  pluginService: { readPluginAsset: readAsset, writePluginAsset: writeAsset },
  fileService: { pickPluginFiles: pickFiles },
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn(), writeText: clipboardWrite }));
vi.mock('./pluginHttp', () => ({ executePluginHttp: executeHttp }));
vi.mock('./pluginViewRuntime', () => ({ executePluginViewApi: executeViewApi }));
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
  writeAsset.mockReset();
  pickFiles.mockReset();
  clipboardWrite.mockReset();
  executeHttp.mockReset();
  executeViewApi.mockReset();
  writeAsset.mockResolvedValue(undefined);
  clipboardWrite.mockResolvedValue(undefined);
  executeHttp.mockResolvedValue(null);
  executeViewApi.mockResolvedValue(null);
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
  it('preserves all byte values and empty binary files without text decoding', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    readAsset.mockResolvedValueOnce(btoa(String.fromCharCode(...bytes))).mockResolvedValueOnce('');
    expect(await executeHostApi('api.plugin', 'fs.read', { rel: 'assets/firmware.bin', format: 'binary' })).toEqual(bytes);
    expect(await executeHostApi('api.plugin', 'fs.read', { rel: 'data/empty', format: 'binary' })).toEqual(new Uint8Array());
  });

  it('keeps binary private reads permission-gated and missing files distinguishable', async () => {
    useAppStore.getState().setConfig({ pluginConfigs: [{
      id: 'api.plugin', installGeneration: 'api-install', enabled: true, grantedPermissions: ['fs:assets'],
    }] });
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'data/private.bin', format: 'binary' })).rejects.toThrow('fs:storage');
    readAsset.mockResolvedValue(null);
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'assets/missing.bin', format: 'binary' })).rejects.toThrow('plugin file not found');
  });

  it('returns chosen bytes losslessly, including BOM and non-UTF8, without a selection count cap', async () => {
    const files = Array.from({ length: 9 }, (_, index) => ({ path: `selected-${index}.bin`, base64: '77u/AP+A' }));
    pickFiles.mockResolvedValue({ files });
    const result = await executeHostApi('api.plugin', 'fs.openDialog', { format: 'binary', encoding: 'gbk', multiple: true });
    expect(result).toEqual({ files: files.map(({ path }) => ({ path, bytes: new Uint8Array([239, 187, 191, 0, 255, 128]) })) });
  });

  it('bounds native dialog filter structures without limiting selected file count', async () => {
    pickFiles.mockResolvedValue({ files: [] });
    const filters = [{ name: 'Logs', extensions: ['log', 'txt'] }];
    await executeHostApi('api.plugin', 'fs.openDialog', { filters });
    expect(pickFiles).toHaveBeenCalledWith('api.plugin', expect.objectContaining({ filters }));
    await expect(executeHostApi('api.plugin', 'fs.openDialog', {
      filters: Array.from({ length: 33 }, () => ({ name: 'x', extensions: ['txt'] })),
    })).rejects.toThrow(/filters/);
    await expect(executeHostApi('api.plugin', 'fs.openDialog', {
      filters: [{ name: 'x', extensions: ['x'.repeat(129)] }],
    })).rejects.toThrow(/extensions/);
  });

  it('keeps text decoding optional and cancellation distinct from an empty binary file', async () => {
    pickFiles.mockResolvedValueOnce({ files: [{ path: '中文.log', base64: '1tDOxA==' }] });
    expect(await executeHostApi('api.plugin', 'fs.openDialog', { encoding: 'gbk' })).toEqual({ files: [{ path: '中文.log', content: '中文' }] });
    pickFiles.mockResolvedValueOnce({ files: [{ path: 'empty', base64: '' }] });
    expect(await executeHostApi('api.plugin', 'fs.openDialog', { format: 'binary' })).toEqual({ files: [{ path: 'empty', bytes: new Uint8Array() }] });
    pickFiles.mockResolvedValueOnce({ files: [] });
    expect(await executeHostApi('api.plugin', 'fs.openDialog', { format: 'binary' })).toEqual({ files: [] });
  });

  it('does not expose file contents after the caller loses authority during reading', async () => {
    readAsset.mockResolvedValue('AP8=');
    pickFiles.mockResolvedValue({ files: [{ path: 'private.bin', base64: 'AP8=' }] });
    const revoked = () => { throw new Error('permission revoked'); };
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'assets/private.bin', format: 'binary' }, null, revoked)).rejects.toThrow('permission revoked');
    await expect(executeHostApi('api.plugin', 'fs.openDialog', { format: 'binary' }, null, revoked)).rejects.toThrow('permission revoked');
  });

  it('rejects unsupported result formats before opening or reading a file', async () => {
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'assets/file', format: 'hex' })).rejects.toThrow('format');
    await expect(executeHostApi('api.plugin', 'fs.openDialog', { format: 'hex' })).rejects.toThrow('format');
    expect(readAsset).not.toHaveBeenCalled();
    expect(pickFiles).not.toHaveBeenCalled();
  });
});

describe('host API content writes', () => {
  it('writes empty and large text without a content cap', async () => {
    await executeHostApi('api.plugin', 'fs.write', { rel: 'data/empty.txt', content: '' });
    expect(writeAsset).toHaveBeenLastCalledWith('api.plugin', 'data/empty.txt', '');
    const large = 'x'.repeat(16 * 1024 * 1024 + 1);
    await executeHostApi('api.plugin', 'fs.write', { rel: 'data/large.txt', content: large });
    expect(writeAsset).toHaveBeenLastCalledWith('api.plugin', 'data/large.txt', large);
  });

  it('encodes Uint8Array and ArrayBuffer bytes losslessly including zero length', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    await executeHostApi('api.plugin', 'fs.write', { rel: 'data/blob.bin', bytes });
    expect(writeAsset).toHaveBeenLastCalledWith(
      'api.plugin', 'data/blob.bin', undefined, btoa(String.fromCharCode(...bytes)),
    );
    const buffer = new Uint8Array([0, 255, 128]).buffer;
    await executeHostApi('api.plugin', 'fs.write', { rel: 'data/raw.bin', bytes: buffer });
    expect(writeAsset).toHaveBeenLastCalledWith('api.plugin', 'data/raw.bin', undefined, 'AP+A');
    await executeHostApi('api.plugin', 'fs.write', { rel: 'data/zero.bin', bytes: new Uint8Array() });
    expect(writeAsset).toHaveBeenLastCalledWith('api.plugin', 'data/zero.bin', undefined, '');
  });

  it('rejects mixed, missing or non-binary write content before touching disk', async () => {
    await expect(executeHostApi('api.plugin', 'fs.write', { rel: 'data/x', content: '', bytes: new Uint8Array() }))
      .rejects.toThrow('互斥');
    await expect(executeHostApi('api.plugin', 'fs.write', { rel: 'data/x' })).rejects.toThrow('content');
    await expect(executeHostApi('api.plugin', 'fs.write', { rel: 'data/x', bytes: 'text' })).rejects.toThrow('bytes');
    expect(writeAsset).not.toHaveBeenCalled();
  });

  it('writes empty and >1 MiB clipboard text unchanged', async () => {
    await executeHostApi('api.plugin', 'clipboard.writeText', { text: '' });
    expect(clipboardWrite).toHaveBeenLastCalledWith('');
    const large = '平'.repeat(1024 * 1024);
    await executeHostApi('api.plugin', 'clipboard.writeText', { text: large });
    expect(clipboardWrite).toHaveBeenLastCalledWith(large);
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
