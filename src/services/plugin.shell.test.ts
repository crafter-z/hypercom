import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginService } from './plugin';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => { invoke.mockReset(); });

describe('plugin shell native service', () => {
  it('uses camelCase IPC keys and binds execution to the reviewed installation', async () => {
    const result = { exitCode: null, stdout: '', stderr: 'signal' };
    invoke.mockResolvedValueOnce(result);
    const request = {
      program: './tool.cmd', args: ['--version'], cwd: '../Work',
      env: { MODE: 'test' }, stdin: 'input\n', timeoutMs: 0,
    };
    await expect(pluginService.pluginShellExecute('com.example.shell', 'generation-a', request)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin_shell_execute', {
      pluginId: 'com.example.shell', expectedGeneration: 'generation-a', request,
    });
  });

  it('does not convert a native execution failure to a successful exit', async () => {
    invoke.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(pluginService.pluginShellExecute('com.example.shell', 'generation-a', { program: 'missing' }))
      .rejects.toThrow('spawn failed');
  });
});
