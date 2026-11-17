import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileService } from './file';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });

describe('minimal plugin file-save native contracts', () => {
  it('exports only through a directory grant and relative path with exact wire keys', async () => {
    const result = { path: 'C:\\exports\\report.bin', bytesWritten: 3 };
    invoke.mockResolvedValueOnce(result);
    await expect(fileService.exportPluginFile('demo', 'grant-a', 'report.bin', undefined, 'AP+A')).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin_export_file', {
      pluginId: 'demo', grantId: 'grant-a', relPath: 'report.bin', content: undefined, base64: 'AP+A',
    });
  });
  it('preserves empty UTF-8 text and uses native Save As without a destination argument', async () => {
    const options = { title: 'Save', defaultFileName: 'report.txt', filters: [{ name: 'Text', extensions: ['txt'] }] };
    invoke.mockResolvedValueOnce(null);
    await expect(fileService.savePluginFile('demo', '', undefined, options)).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin_save_file', {
      pluginId: 'demo', content: '', base64: undefined, options,
    });
  });
  it('propagates native failures instead of reporting a cancelled or successful save', async () => {
    invoke.mockRejectedValue(new Error('permission revoked'));
    await expect(fileService.exportPluginFile('demo', 'g', 'a', 'x', undefined)).rejects.toThrow('permission revoked');
    await expect(fileService.savePluginFile('demo', undefined, '', {})).rejects.toThrow('permission revoked');
  });
});
