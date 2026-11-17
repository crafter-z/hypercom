import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeHostApi } from './pluginHostApi';
import { useToastStore } from '../stores/useToastStore';
import { useAppStore } from '../stores/useAppStore';
import type { PluginManifestView } from '../types';
import { PluginFsContext } from './pluginFs';

const readAsset = vi.hoisted(() => vi.fn());
const readAssetBytes = vi.hoisted(() => vi.fn());
const writeAsset = vi.hoisted(() => vi.fn());
const pickFiles = vi.hoisted(() => vi.fn());
const pickDirectory = vi.hoisted(() => vi.fn());
const listDirectory = vi.hoisted(() => vi.fn());
const readDirectoryBytes = vi.hoisted(() => vi.fn());
const statDirectoryEntry = vi.hoisted(() => vi.fn());
const writeDirectoryFile = vi.hoisted(() => vi.fn());
const createDirectory = vi.hoisted(() => vi.fn());
const removeDirectoryEntry = vi.hoisted(() => vi.fn());
const renameDirectoryEntry = vi.hoisted(() => vi.fn());
const releaseDirectory = vi.hoisted(() => vi.fn());
const clipboardWrite = vi.hoisted(() => vi.fn());
const executeHttp = vi.hoisted(() => vi.fn());
const executeShell = vi.hoisted(() => vi.fn());
const executeViewApi = vi.hoisted(() => vi.fn());
const sendToPort = vi.hoisted(() => vi.fn());

vi.mock('../services/tauri', () => ({
  pluginService: { readPluginAsset: readAsset, readPluginAssetBytes: readAssetBytes, writePluginAsset: writeAsset },
  fileService: {
    pickPluginFiles: pickFiles,
    pickPluginDirectory: pickDirectory,
    listPluginDirectory: listDirectory,
    readPluginDirectoryBytes: readDirectoryBytes,
    statPluginDirectoryEntry: statDirectoryEntry,
    writePluginDirectoryFile: writeDirectoryFile,
    createPluginDirectory: createDirectory,
    removePluginDirectoryEntry: removeDirectoryEntry,
    renamePluginDirectoryEntry: renameDirectoryEntry,
    releasePluginDirectory: releaseDirectory,
  },
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn(), writeText: clipboardWrite }));
vi.mock('./pluginHttp', () => ({ executePluginHttp: executeHttp }));
vi.mock('./pluginShell', () => ({ executePluginShell: executeShell }));
vi.mock('./pluginViewRuntime', () => ({ executePluginViewApi: executeViewApi }));
vi.mock('../hooks/useSerialSend', () => ({ sendToPort }));
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
  readAssetBytes.mockReset();
  writeAsset.mockReset();
  pickFiles.mockReset();
  pickDirectory.mockReset();
  listDirectory.mockReset();
  readDirectoryBytes.mockReset();
  statDirectoryEntry.mockReset();
  writeDirectoryFile.mockReset();
  createDirectory.mockReset();
  removeDirectoryEntry.mockReset();
  renameDirectoryEntry.mockReset();
  releaseDirectory.mockReset();
  clipboardWrite.mockReset();
  executeHttp.mockReset();
  executeShell.mockReset();
  executeViewApi.mockReset();
  sendToPort.mockReset();
  writeAsset.mockResolvedValue(undefined);
  createDirectory.mockResolvedValue(null);
  removeDirectoryEntry.mockResolvedValue(null);
  renameDirectoryEntry.mockResolvedValue(null);
  releaseDirectory.mockResolvedValue(undefined);
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

describe('host API windowed files', () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const range = { rel: 'assets/a', offset: 10, length: 3 };
  function context() { return new PluginFsContext('api.plugin', 'api-install', 1); }
  it('normalizes new range parameters with background default and explicit context', async () => {
    const fs = context(); const bytes = new Uint8Array([1]);
    const read = vi.spyOn(fs, 'readRange').mockResolvedValue(bytes);
    await expect(executeHostApi('api.plugin', 'fs.readRange', { ...range, requestId }, null, undefined, fs)).resolves.toBe(bytes);
    expect(read).toHaveBeenCalledWith(requestId, range, 'background', expect.any(Function));
    await expect(executeHostApi('api.plugin', 'fs.readRange', { ...range, requestId })).rejects.toThrow('context');
  });
  it.each([
    { offset: -1 }, { offset: 1.5 }, { offset: Number.MAX_SAFE_INTEGER, length: 1 },
    { length: 4 * 1024 * 1024 + 1 }, { length: NaN }, { length: '3' },
    { rel: '' }, { rel: 'x'.repeat(4097) }, { grantId: null }, { priority: 'urgent' },
  ])('rejects malformed range options before dispatch: %j', async invalid => {
    const fs = context(); const read = vi.spyOn(fs, 'readRange');
    await expect(executeHostApi('api.plugin', 'fs.readRange', { ...range, requestId, ...invalid }, null, undefined, fs)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('bounds batches and authorizes every range before any native dispatch', async () => {
    const fs = context(); const read = vi.spyOn(fs, 'readRanges').mockResolvedValue({ results: [] });
    const call = (ranges: unknown) => executeHostApi('api.plugin', 'fs.readRanges', { ranges, requestId }, null, undefined, fs);
    for (const invalid of [[], [null], Array(65).fill(range), Array(3).fill({ ...range, length: 4 * 1024 * 1024 })]) {
      await expect(call(invalid)).rejects.toThrow();
    }
    await expect(call([range, { ...range, rel: 'private', grantId: 'grant' }])).rejects.toThrow('fs:open-dir');
    expect(read).not.toHaveBeenCalled();
    await expect(call([range, { ...range, rel: 'data/a' }])).resolves.toEqual({ results: [] });
    expect(read).toHaveBeenCalledOnce();
  });
  it('uses shared directory helpers for page options and rejects bad limits/cursors', async () => {
    useAppStore.getState().setConfig({ pluginConfigs: [{ id: 'api.plugin', installGeneration: 'api-install', enabled: true, grantedPermissions: ['fs:open-dir'] }] });
    const fs = context(); const list = vi.spyOn(fs, 'listDirectoryPage').mockResolvedValue({ entries: [], nextCursor: null });
    const args = { requestId, grantId: 'grant', rel: '', recursive: true, limit: 1000, cursor: 'opaque', priority: 'interactive' };
    await expect(executeHostApi('api.plugin', 'fs.listDirectoryPage', args, null, undefined, fs)).resolves.toEqual({ entries: [], nextCursor: null });
    expect(list).toHaveBeenCalledWith(requestId, { grantId: 'grant', relPath: '', recursive: true, limit: 1000, cursor: 'opaque', priority: 'interactive' }, expect.any(Function));
    for (const invalid of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { recursive: 1 }, { cursor: '' }, { cursor: 'a'.repeat(4097) }, { rel: 1 }]) {
      await expect(executeHostApi('api.plugin', 'fs.listDirectoryPage', { ...args, ...invalid }, null, undefined, fs)).rejects.toThrow();
    }
    expect(list).toHaveBeenCalledOnce();
  });
  it('matches native UTF-8 path boundaries for new range and page calls before dispatch', async () => {
    const fs = context(); const read = vi.spyOn(fs, 'readRange').mockResolvedValue(new Uint8Array());
    for (const rel of ['a'.repeat(4096), '中'.repeat(1365) + 'a', '😀'.repeat(1024)]) {
      await expect(executeHostApi('api.plugin', 'fs.readRange', { ...range, rel, requestId }, null, undefined, fs)).resolves.toEqual(new Uint8Array());
    }
    for (const rel of ['中'.repeat(1366), '😀'.repeat(1024) + 'a', '\ud800', '\udc00']) {
      await expect(executeHostApi('api.plugin', 'fs.readRange', { ...range, rel, requestId }, null, undefined, fs)).rejects.toThrow(/UTF-8/);
    }
    expect(read).toHaveBeenCalledTimes(3);
    useAppStore.getState().setConfig({ pluginConfigs: [{ id: 'api.plugin', installGeneration: 'api-install', enabled: true, grantedPermissions: ['fs:open-dir'] }] });
    const list = vi.spyOn(fs, 'listDirectoryPage').mockResolvedValue({ entries: [], nextCursor: null });
    for (const rel of ['', '中'.repeat(1365) + 'a', '😀'.repeat(1024)]) {
      await executeHostApi('api.plugin', 'fs.listDirectoryPage', { grantId: 'grant', rel, requestId }, null, undefined, fs);
    }
    for (const rel of ['中'.repeat(1366), '😀'.repeat(1024) + 'a', '\ud800', '\udc00']) {
      await expect(executeHostApi('api.plugin', 'fs.listDirectoryPage', { grantId: 'grant', rel, requestId }, null, undefined, fs)).rejects.toThrow(/UTF-8/);
    }
    expect(list).toHaveBeenCalledTimes(3);
  });
  it('keeps permissionless cancellation on the same epoch context', async () => {
    const fs = context(); const cancel = vi.spyOn(fs, 'cancel').mockResolvedValue();
    await expect(executeHostApi('api.plugin', 'fs.cancel', { requestId }, null, undefined, fs)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(requestId);
  });
});

describe('host API shell dispatch', () => {
  it('forwards shell.execute to the native driver with live Worker authority and no executable scope', async () => {
    const request = { program: 'git', args: ['--version'] };
    const manifest: PluginManifestView = {
      id: 'api.plugin', name: 'API', version: '1', description: '', apiVersion: '1',
      permissions: ['shell:execute'], shell: { executableWhitelist: ['git'] },
    };
    const authority = vi.fn();
    const result = { exitCode: 3, stdout: 'output', stderr: 'error' };
    executeShell.mockResolvedValueOnce(result);
    await expect(executeHostApi('api.plugin', 'shell.execute', request, manifest, authority)).resolves.toEqual(result);
    expect(executeShell).toHaveBeenCalledExactlyOnceWith('api.plugin', request, authority);
  });
});

describe('host API serial sends', () => {
  const allowedManifest: PluginManifestView = {
    id: 'api.plugin',
    name: 'API Plugin',
    version: '1.0.0',
    description: '',
    apiVersion: '1',
    permissions: ['serial:send'],
    serial: { portWhitelist: ['COM3', 'COM4'] },
  };

  it('maps serial.send arguments and returns bytesWritten', async () => {
    sendToPort.mockResolvedValueOnce(4);
    const beforeSend = vi.fn();

    await expect(executeHostApi('api.plugin', 'serial.send', {
      portId: 'COM3', data: 'A1B2', isHex: true, lineEnding: '\\r\\n',
    }, allowedManifest, beforeSend)).resolves.toEqual({ bytesWritten: 4 });
    expect(sendToPort).toHaveBeenCalledWith('COM3', 'A1B2', true, '\\r\\n', true, beforeSend);
  });

  it('uses the default text mode and line ending when options are omitted', async () => {
    sendToPort.mockResolvedValueOnce(2);

    await expect(executeHostApi('api.plugin', 'serial.send', {
      portId: 'COM4', data: 'PING',
    }, allowedManifest)).resolves.toEqual({ bytesWritten: 2 });
    expect(sendToPort).toHaveBeenCalledWith('COM4', 'PING', false, 'None', true, undefined);
  });

  it('preserves a zero-byte result from the send pipeline', async () => {
    sendToPort.mockResolvedValueOnce(0);

    await expect(executeHostApi('api.plugin', 'serial.send', {
      portId: 'COM3', data: 'PING',
    }, allowedManifest)).resolves.toEqual({ bytesWritten: 0 });
    expect(sendToPort).toHaveBeenCalledExactlyOnceWith('COM3', 'PING', false, 'None', true, undefined);
  });

  it('preserves send failures and rejects invalid arguments before sending', async () => {
    sendToPort.mockRejectedValueOnce(new Error('port unavailable'));
    await expect(executeHostApi('api.plugin', 'serial.send', {
      portId: 'COM3', data: 'PING',
    }, allowedManifest)).rejects.toThrow('port unavailable');

    await expect(executeHostApi('api.plugin', 'serial.send', {
      portId: 'COM3', data: 'PING', isHex: 'yes',
    }, allowedManifest)).rejects.toThrow(/isHex/);
    await expect(executeHostApi('api.plugin', 'serial.send', {
      portId: 'COM3', data: 'PING', lineEnding: 'invalid',
    }, allowedManifest)).rejects.toThrow(/lineEnding/);
    expect(sendToPort).toHaveBeenCalledTimes(1);
  });

  it('rejects a port outside the manifest scope without sending', async () => {
    await expect(executeHostApi('api.plugin', 'serial.send', {
      portId: 'COM9', data: 'PING',
    }, allowedManifest)).rejects.toThrow(/不在插件 serial\.portWhitelist 内/);
    expect(sendToPort).not.toHaveBeenCalled();
  });

  it('rejects the default missing manifest before sending', async () => {
    await expect(executeHostApi('api.plugin', 'serial.send', {
      portId: 'COM3', data: 'PING',
    })).rejects.toThrow(/manifest/);
    expect(sendToPort).not.toHaveBeenCalled();
  });
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
    readAssetBytes.mockResolvedValueOnce(bytes).mockResolvedValueOnce(new Uint8Array());
    expect(await executeHostApi('api.plugin', 'fs.read', { rel: 'assets/firmware.bin', format: 'binary' })).toEqual(bytes);
    expect(await executeHostApi('api.plugin', 'fs.read', { rel: 'data/empty', format: 'binary' })).toEqual(new Uint8Array());
    expect(readAssetBytes).toHaveBeenCalledWith('api.plugin', 'assets/firmware.bin', 'api-install');
    expect(readAsset).not.toHaveBeenCalled();
    readAssetBytes.mockRejectedValueOnce(new Error('raw asset permission denied'));
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'assets/firmware.bin', format: 'binary' })).rejects.toThrow('raw asset permission denied');
  });

  it('keeps binary private reads permission-gated and missing files distinguishable', async () => {
    useAppStore.getState().setConfig({ pluginConfigs: [{
      id: 'api.plugin', installGeneration: 'api-install', enabled: true, grantedPermissions: ['fs:assets'],
    }] });
    await expect(executeHostApi('api.plugin', 'fs.read', { rel: 'data/private.bin', format: 'binary' })).rejects.toThrow('fs:storage');
    readAssetBytes.mockResolvedValue(null);
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
    readAssetBytes.mockResolvedValue(new Uint8Array([0, 255]));
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

describe('host API plugin directories', () => {
  it('turns a cancelled directory picker into an empty list and forwards title and multiple', async () => {
    pickDirectory.mockResolvedValueOnce([]);
    await expect(executeHostApi('api.plugin', 'fs.openDirectoryDialog', {})).resolves.toEqual({ directories: [] });
    expect(pickDirectory).toHaveBeenCalledWith('api.plugin', { title: undefined, multiple: false });

    const picked = [{ grantId: 'grant-a', name: 'logs', path: 'C:\\logs' }];
    pickDirectory.mockResolvedValueOnce(picked);
    await expect(executeHostApi('api.plugin', 'fs.openDirectoryDialog', { title: '选择日志目录', multiple: true }))
      .resolves.toEqual({ directories: picked });
    expect(pickDirectory).toHaveBeenLastCalledWith('api.plugin', { title: '选择日志目录', multiple: true });

    await expect(executeHostApi('api.plugin', 'fs.openDirectoryDialog', { multiple: 'yes' }))
      .rejects.toThrow(/multiple/);
    expect(pickDirectory).toHaveBeenCalledTimes(2);
  });

  it('maps directory entries with modifiedMs and forwards rel and recursive', async () => {
    const entries = [
      { name: 'a.txt', rel: 'a.txt', kind: 'file' as const, size: 3, modifiedMs: 111 },
      { name: 'sub', rel: 'sub', kind: 'directory' as const, size: 0, modifiedMs: 222 },
      { name: 'link', rel: 'link', kind: 'other' as const, size: 0, modifiedMs: 333 },
    ];
    listDirectory.mockResolvedValue(entries);
    await expect(executeHostApi('api.plugin', 'fs.listDirectory', { grantId: 'grant-a' }))
      .resolves.toEqual({ entries });
    expect(listDirectory).toHaveBeenLastCalledWith('api.plugin', 'grant-a', undefined, undefined);

    await executeHostApi('api.plugin', 'fs.listDirectory', { grantId: 'grant-a', rel: 'sub', recursive: true });
    expect(listDirectory).toHaveBeenLastCalledWith('api.plugin', 'grant-a', 'sub', true);

    await expect(executeHostApi('api.plugin', 'fs.listDirectory', { grantId: 'grant-a', recursive: 'yes' }))
      .rejects.toThrow(/recursive/);
  });

  it('maps stat metadata and rejects malformed stat arguments before the native call', async () => {
    statDirectoryEntry.mockResolvedValueOnce({
      name: 'a.txt', rel: 'a.txt', kind: 'file', size: 7, modifiedMs: 1234,
    });
    await expect(executeHostApi('api.plugin', 'fs.statDirectoryEntry', { grantId: 'grant-a', rel: 'a.txt' }))
      .resolves.toEqual({ name: 'a.txt', rel: 'a.txt', kind: 'file', size: 7, modifiedMs: 1234 });
    expect(statDirectoryEntry).toHaveBeenLastCalledWith('api.plugin', 'grant-a', 'a.txt');

    await expect(executeHostApi('api.plugin', 'fs.statDirectoryEntry', { grantId: 'grant-a' })).rejects.toThrow(/rel/);
    await expect(executeHostApi('api.plugin', 'fs.statDirectoryEntry', { rel: 'a.txt' })).rejects.toThrow(/grantId/);
    await expect(executeHostApi('api.plugin', 'fs.statDirectoryEntry', {
      grantId: 'g'.repeat(129), rel: 'a.txt',
    })).rejects.toThrow(/grantId/);
    expect(statDirectoryEntry).toHaveBeenCalledTimes(1);
  });

  it('decodes text with the requested encoding and passes binary bytes through losslessly', async () => {
    readDirectoryBytes.mockResolvedValueOnce({ path: 'C:\\logs\\中文.txt', bytes: new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]) });
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: '中文.txt', encoding: 'gbk',
    })).resolves.toEqual({ path: 'C:\\logs\\中文.txt', content: '中文' });
    expect(readDirectoryBytes).toHaveBeenLastCalledWith('api.plugin', 'grant-a', '中文.txt');

    readDirectoryBytes.mockResolvedValueOnce({ path: 'utf8.txt', bytes: new Uint8Array([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]) });
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', { grantId: 'grant-a', rel: 'utf8.txt' }))
      .resolves.toEqual({ path: 'utf8.txt', content: '中文' });

    readDirectoryBytes.mockResolvedValueOnce({ path: 'raw.bin', bytes: new Uint8Array([0, 255, 128]) });
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: 'raw.bin', format: 'binary',
    })).resolves.toEqual({ path: 'raw.bin', bytes: new Uint8Array([0, 255, 128]) });

    readDirectoryBytes.mockResolvedValueOnce({ path: 'empty.bin', bytes: new Uint8Array() });
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: 'empty.bin', format: 'binary',
    })).resolves.toEqual({ path: 'empty.bin', bytes: new Uint8Array() });
  });

  it('preserves binary buffer identity and native paths without imposing range-read limits on whole files', async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024 + 1);
    bytes.set([0xef, 0xbb, 0xbf, 0xff]);
    const path = 'C:\\logs\\whole.bin';
    readDirectoryBytes.mockResolvedValueOnce({ path, bytes });
    const result = await executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: 'whole.bin', format: 'binary',
    }) as { path: string; bytes: Uint8Array };
    expect(result.path).toBe(path);
    expect(result.bytes).toBe(bytes);
    expect(result.bytes.byteLength).toBe(4 * 1024 * 1024 + 1);
  });

  it('keeps empty text and shared decoder BOM/replacement semantics for directory bytes', async () => {
    readDirectoryBytes.mockResolvedValueOnce({ path: 'empty.txt', bytes: new Uint8Array() });
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', { grantId: 'grant-a', rel: 'empty.txt' }))
      .resolves.toEqual({ path: 'empty.txt', content: '' });
    readDirectoryBytes.mockResolvedValueOnce({ path: 'bom.txt', bytes: new Uint8Array([0xef, 0xbb, 0xbf, 65, 255]) });
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', { grantId: 'grant-a', rel: 'bom.txt' }))
      .resolves.toEqual({ path: 'bom.txt', content: 'A\ufffd' });
  });

  it.each(['text', 'binary'])('preserves directory raw read errors for %s without host fallback', async format => {
    readDirectoryBytes.mockRejectedValueOnce(new Error('directory permission denied'));
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: 'denied', format,
    })).rejects.toThrow('directory permission denied');
    expect(readDirectoryBytes).toHaveBeenCalledExactlyOnceWith('api.plugin', 'grant-a', 'denied');
  });

  it('does not expose directory results after authority is revoked during the native call', async () => {
    pickDirectory.mockResolvedValue([{ grantId: 'grant-a', name: 'logs', path: 'C:\\logs' }]);
    listDirectory.mockResolvedValue([{ name: 'a.txt', rel: 'a.txt', kind: 'file', size: 1, modifiedMs: 2 }]);
    readDirectoryBytes.mockResolvedValue({ path: 'a.txt', bytes: new Uint8Array([65]) });
    statDirectoryEntry.mockResolvedValue({ name: 'a.txt', rel: 'a.txt', kind: 'file', size: 1, modifiedMs: 2 });
    writeDirectoryFile.mockResolvedValue({ path: 'C:\\logs\\a.txt', bytesWritten: 1 });
    const revoked = () => { throw new Error('permission revoked'); };
    // Nine sequential revoked picks exceed the eight-slot dialog budget; they can
    // only all reach the post-pick recheck if the finally block released each slot.
    for (let index = 0; index < 9; index++) {
      await expect(executeHostApi('api.plugin', 'fs.openDirectoryDialog', {}, null, revoked))
        .rejects.toThrow('permission revoked');
    }
    await expect(executeHostApi('api.plugin', 'fs.listDirectory', { grantId: 'grant-a' }, null, revoked))
      .rejects.toThrow('permission revoked');
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: 'a.txt', format: 'binary',
    }, null, revoked)).rejects.toThrow('permission revoked');
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: 'a.txt', format: 'text',
    }, null, revoked)).rejects.toThrow('permission revoked');
    await expect(executeHostApi('api.plugin', 'fs.statDirectoryEntry', {
      grantId: 'grant-a', rel: 'a.txt',
    }, null, revoked)).rejects.toThrow('permission revoked');
    await expect(executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'a.txt', content: 'a',
    }, null, revoked)).rejects.toThrow('permission revoked');
    await expect(executeHostApi('api.plugin', 'fs.createDirectory', {
      grantId: 'grant-a', rel: 'sub',
    }, null, revoked)).rejects.toThrow('permission revoked');
    await expect(executeHostApi('api.plugin', 'fs.removeDirectoryEntry', {
      grantId: 'grant-a', rel: 'a.txt',
    }, null, revoked)).rejects.toThrow('permission revoked');
    await expect(executeHostApi('api.plugin', 'fs.renameDirectoryEntry', {
      grantId: 'grant-a', fromRel: 'a.txt', toRel: 'b.txt',
    }, null, revoked)).rejects.toThrow('permission revoked');
    // Release is cleanup, not a data path: revocation does not block it.
    await expect(executeHostApi('api.plugin', 'fs.releaseDirectory', { grantId: 'grant-a' }, null, revoked))
      .resolves.toBeNull();
    expect(pickDirectory).toHaveBeenCalledTimes(9);
    expect(statDirectoryEntry).toHaveBeenCalledTimes(1);
    expect(writeDirectoryFile).toHaveBeenCalledTimes(1);
    expect(createDirectory).toHaveBeenCalledTimes(1);
    expect(removeDirectoryEntry).toHaveBeenCalledTimes(1);
    expect(renameDirectoryEntry).toHaveBeenCalledTimes(1);
  });

  it('validates grant ids, relative paths, formats and encodings before touching the directory', async () => {
    await expect(executeHostApi('api.plugin', 'fs.openDirectoryDialog', { title: 'x'.repeat(257) }))
      .rejects.toThrow(/title/);
    await expect(executeHostApi('api.plugin', 'fs.listDirectory', {})).rejects.toThrow(/grantId/);
    await expect(executeHostApi('api.plugin', 'fs.listDirectory', { grantId: 'g'.repeat(129) })).rejects.toThrow(/grantId/);
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', { grantId: 'grant-a' })).rejects.toThrow(/rel/);
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: 'r'.repeat(4097),
    })).rejects.toThrow(/rel/);
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: 'a.txt', format: 'hex',
    })).rejects.toThrow(/format/);
    await expect(executeHostApi('api.plugin', 'fs.readDirectoryFile', {
      grantId: 'grant-a', rel: 'a.txt', encoding: 'x'.repeat(65),
    })).rejects.toThrow(/encoding/);
    await expect(executeHostApi('api.plugin', 'fs.releaseDirectory', {})).rejects.toThrow(/grantId/);
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(listDirectory).not.toHaveBeenCalled();
    expect(readDirectoryBytes).not.toHaveBeenCalled();
    expect(statDirectoryEntry).not.toHaveBeenCalled();
    expect(writeDirectoryFile).not.toHaveBeenCalled();
    expect(createDirectory).not.toHaveBeenCalled();
    expect(removeDirectoryEntry).not.toHaveBeenCalled();
    expect(renameDirectoryEntry).not.toHaveBeenCalled();
    expect(releaseDirectory).not.toHaveBeenCalled();
  });

  it('releases a grant without reading anything', async () => {
    await expect(executeHostApi('api.plugin', 'fs.releaseDirectory', { grantId: 'grant-a' })).resolves.toBeNull();
    expect(releaseDirectory).toHaveBeenCalledWith('api.plugin', 'grant-a');
    expect(readDirectoryBytes).not.toHaveBeenCalled();
  });

  it('writes text, empty text, Uint8Array and ArrayBuffer content with explicit options', async () => {
    writeDirectoryFile.mockResolvedValue({ path: 'C:\\logs\\a.txt', bytesWritten: 3 });
    await expect(executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'a.txt', content: 'abc',
    })).resolves.toEqual({ path: 'C:\\logs\\a.txt', bytesWritten: 3 });
    expect(writeDirectoryFile).toHaveBeenLastCalledWith(
      'api.plugin', 'grant-a', 'a.txt', 'abc', undefined, undefined, undefined,
    );

    await executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'empty.txt', content: '', mode: 'append', createParents: false,
    });
    expect(writeDirectoryFile).toHaveBeenLastCalledWith(
      'api.plugin', 'grant-a', 'empty.txt', '', undefined, 'append', false,
    );

    await executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'deep/new.txt', content: 'x', createParents: true,
    });
    expect(writeDirectoryFile).toHaveBeenLastCalledWith(
      'api.plugin', 'grant-a', 'deep/new.txt', 'x', undefined, undefined, true,
    );

    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    await executeHostApi('api.plugin', 'fs.writeDirectoryFile', { grantId: 'grant-a', rel: 'blob.bin', bytes });
    expect(writeDirectoryFile).toHaveBeenLastCalledWith(
      'api.plugin', 'grant-a', 'blob.bin', undefined, btoa(String.fromCharCode(...bytes)), undefined, undefined,
    );

    const buffer = new Uint8Array([0, 255, 128]).buffer;
    await executeHostApi('api.plugin', 'fs.writeDirectoryFile', { grantId: 'grant-a', rel: 'raw.bin', bytes: buffer });
    expect(writeDirectoryFile).toHaveBeenLastCalledWith(
      'api.plugin', 'grant-a', 'raw.bin', undefined, 'AP+A', undefined, undefined,
    );

    await executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'zero.bin', bytes: new Uint8Array(),
    });
    expect(writeDirectoryFile).toHaveBeenLastCalledWith(
      'api.plugin', 'grant-a', 'zero.bin', undefined, '', undefined, undefined,
    );
  });

  it('rejects mixed, missing, non-binary or invalid-mode write arguments before touching disk', async () => {
    await expect(executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'x', content: '', bytes: new Uint8Array(),
    })).rejects.toThrow('互斥');
    await expect(executeHostApi('api.plugin', 'fs.writeDirectoryFile', { grantId: 'grant-a', rel: 'x' }))
      .rejects.toThrow('content');
    await expect(executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'x', bytes: 'text',
    })).rejects.toThrow('bytes');
    await expect(executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'x', content: 'a', mode: 'truncate',
    })).rejects.toThrow(/mode/);
    await expect(executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'x', content: 'a', createParents: 'yes',
    })).rejects.toThrow(/createParents/);
    writeDirectoryFile.mockResolvedValueOnce({ path: 'x', bytesWritten: 1 });
    await expect(executeHostApi('api.plugin', 'fs.writeDirectoryFile', {
      grantId: 'grant-a', rel: 'x', content: 'a', bytes: undefined,
    })).resolves.toEqual({ path: 'x', bytesWritten: 1 });
    expect(writeDirectoryFile).toHaveBeenCalledTimes(1);
  });

  it('maps create, remove and rename onto the native directory commands', async () => {
    await expect(executeHostApi('api.plugin', 'fs.createDirectory', {
      grantId: 'grant-a', rel: 'sub/deep',
    })).resolves.toBeNull();
    expect(createDirectory).toHaveBeenLastCalledWith('api.plugin', 'grant-a', 'sub/deep', undefined);
    await executeHostApi('api.plugin', 'fs.createDirectory', { grantId: 'grant-a', rel: 'sub', recursive: false });
    expect(createDirectory).toHaveBeenLastCalledWith('api.plugin', 'grant-a', 'sub', false);

    await expect(executeHostApi('api.plugin', 'fs.removeDirectoryEntry', { grantId: 'grant-a', rel: 'a.txt' }))
      .resolves.toBeNull();
    expect(removeDirectoryEntry).toHaveBeenLastCalledWith('api.plugin', 'grant-a', 'a.txt', undefined);
    await executeHostApi('api.plugin', 'fs.removeDirectoryEntry', { grantId: 'grant-a', rel: 'sub', recursive: true });
    expect(removeDirectoryEntry).toHaveBeenLastCalledWith('api.plugin', 'grant-a', 'sub', true);

    await expect(executeHostApi('api.plugin', 'fs.renameDirectoryEntry', {
      grantId: 'grant-a', fromRel: 'a.txt', toRel: 'b.txt',
    })).resolves.toBeNull();
    expect(renameDirectoryEntry).toHaveBeenLastCalledWith('api.plugin', 'grant-a', 'a.txt', 'b.txt');

    await expect(executeHostApi('api.plugin', 'fs.renameDirectoryEntry', { grantId: 'grant-a', fromRel: 'a.txt' }))
      .rejects.toThrow(/toRel/);
    await expect(executeHostApi('api.plugin', 'fs.renameDirectoryEntry', { grantId: 'grant-a', toRel: 'b.txt' }))
      .rejects.toThrow(/fromRel/);
    await expect(executeHostApi('api.plugin', 'fs.renameDirectoryEntry', {
      grantId: 'grant-a', fromRel: 'f'.repeat(4097), toRel: 'b.txt',
    })).rejects.toThrow(/fromRel/);
    await expect(executeHostApi('api.plugin', 'fs.createDirectory', {
      grantId: 'grant-a', rel: 'x', recursive: 1,
    })).rejects.toThrow(/recursive/);
    await expect(executeHostApi('api.plugin', 'fs.removeDirectoryEntry', {
      grantId: 'grant-a', rel: 'r'.repeat(4097),
    })).rejects.toThrow(/rel/);
    expect(createDirectory).toHaveBeenCalledTimes(2);
    expect(removeDirectoryEntry).toHaveBeenCalledTimes(2);
    expect(renameDirectoryEntry).toHaveBeenCalledTimes(1);
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
