import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginService } from './plugin';
import { fileService } from './file';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });

function directoryFrame(path: string, bytes: number[]): ArrayBuffer {
  const metadata = new TextEncoder().encode(JSON.stringify({ path }));
  const frame = new Uint8Array(8 + metadata.length + bytes.length);
  frame.set([72, 67, 70, 68]);
  new DataView(frame.buffer).setUint32(4, metadata.length, true);
  frame.set(metadata, 8);
  frame.set(bytes, 8 + metadata.length);
  return frame.buffer;
}

describe('compatible directory binary transport', () => {
  it('preserves the native display path and returns an exact file-only buffer', async () => {
    invoke.mockResolvedValueOnce(directoryFrame('C:\\日志\\data.bin', [0, 255, 65]));
    const result = await fileService.readPluginDirectoryBytes('com.example.scan', 'grant', 'data.bin');
    expect(result.path).toBe('C:\\日志\\data.bin');
    expect(result.bytes).toEqual(new Uint8Array([0, 255, 65]));
    expect(result.bytes.byteOffset).toBe(0);
    expect(result.bytes.buffer.byteLength).toBe(3);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin_read_directory_file_raw', {
      pluginId: 'com.example.scan', grantId: 'grant', relPath: 'data.bin',
    });
  });

  it('keeps empty files distinct from errors', async () => {
    invoke.mockResolvedValueOnce(directoryFrame('/logs/empty.bin', []));
    await expect(fileService.readPluginDirectoryBytes('com.example.scan', 'grant', 'empty.bin'))
      .resolves.toEqual({ path: '/logs/empty.bin', bytes: new Uint8Array(0) });
  });

  it('uses the old directory wire only for unsupported raw transport', async () => {
    invoke.mockRejectedValueOnce('PLUGIN_FS_RAW_UNSUPPORTED: fallback').mockResolvedValueOnce({ path: '/logs/a', base64: 'AP8=' });
    await expect(fileService.readPluginDirectoryBytes('com.example.scan', 'grant', 'a'))
      .resolves.toEqual({ path: '/logs/a', bytes: new Uint8Array([0, 255]) });
    expect(invoke).toHaveBeenLastCalledWith('plugin_read_directory_file', {
      pluginId: 'com.example.scan', grantId: 'grant', relPath: 'a',
    });
  });

  it('does not turn permission failures into a second read', async () => {
    invoke.mockRejectedValueOnce('permission denied');
    await expect(fileService.readPluginDirectoryBytes('com.example.scan', 'grant', 'a')).rejects.toBe('permission denied');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed frames without falling back to string transport', async () => {
    const frame = directoryFrame('/logs/a', [1]);
    new DataView(frame).setUint32(4, 128 * 1024 + 1, true);
    invoke.mockResolvedValueOnce(frame);
    await expect(fileService.readPluginDirectoryBytes('com.example.scan', 'grant', 'a')).rejects.toThrow('invalid plugin directory raw response');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('compatible plugin whole-file binary reads', () => {
  it('delivers raw bytes without a JSON or base64 round trip', async () => {
    const bytes = new Uint8Array([0, 255, 128, 65]);
    invoke.mockResolvedValueOnce(bytes.buffer);
    const result = await pluginService.readPluginAssetBytes('com.example.scan', 'data/a.bin', 'installation');
    expect(result).toEqual(bytes);
    expect(result!.buffer).toBe(bytes.buffer);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('read_plugin_asset_raw', {
      id: 'com.example.scan', relPath: 'data/a.bin', expectedGeneration: 'installation',
    });
  });

  it('preserves an empty file and distinguishes a missing file', async () => {
    invoke.mockResolvedValueOnce(new ArrayBuffer(0));
    expect(await pluginService.readPluginAssetBytes('com.example.scan', 'empty')).toEqual(new Uint8Array(0));
    invoke.mockRejectedValueOnce('PLUGIN_FILE_NOT_FOUND');
    await expect(pluginService.readPluginAssetBytes('com.example.scan', 'missing')).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('falls back only when native IPC explicitly reports raw transport unsupported', async () => {
    invoke.mockRejectedValueOnce('PLUGIN_FS_RAW_UNSUPPORTED: fallback IPC')
      .mockResolvedValueOnce('AP+AQQ==');
    await expect(pluginService.readPluginAssetBytes('com.example.scan', 'data/a.bin')).resolves.toEqual(new Uint8Array([0, 255, 128, 65]));
    expect(invoke).toHaveBeenLastCalledWith('read_plugin_asset', {
      id: 'com.example.scan', relPath: 'data/a.bin', format: 'binary',
    });
  });

  it('retains missing-file null semantics in the old fallback', async () => {
    invoke.mockRejectedValueOnce(new Error('PLUGIN_FS_RAW_UNSUPPORTED')).mockResolvedValueOnce(null);
    await expect(pluginService.readPluginAssetBytes('com.example.scan', 'missing')).resolves.toBeNull();
  });

  it.each(['permission denied', 'IO error', 'PLUGIN_FS_SESSION_INVALID'])('does not bypass a failure: %s', async error => {
    invoke.mockRejectedValueOnce(error);
    await expect(pluginService.readPluginAssetBytes('com.example.scan', 'data/a.bin')).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects JSON byte arrays instead of pretending they were raw responses', async () => {
    invoke.mockResolvedValueOnce([0, 255, 128]);
    await expect(pluginService.readPluginAssetBytes('com.example.scan', 'data/a.bin')).rejects.toThrow('invalid plugin asset raw response');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing string and base64 service contract unchanged', async () => {
    invoke.mockResolvedValueOnce('text').mockResolvedValueOnce('AP8=');
    await expect(pluginService.readPluginAsset('com.example.scan', 'data/a.txt')).resolves.toBe('text');
    await expect(pluginService.readPluginAsset('com.example.scan', 'data/a.bin', 'binary')).resolves.toBe('AP8=');
    expect(invoke).toHaveBeenNthCalledWith(1, 'read_plugin_asset', {
      id: 'com.example.scan', relPath: 'data/a.txt', format: 'text',
    });
  });
});
