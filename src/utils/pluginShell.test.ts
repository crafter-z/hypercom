import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import { executePluginShell, parsePluginShellRequest } from './pluginShell';

const execute = vi.hoisted(() => vi.fn());
vi.mock('../services/tauri', () => ({ pluginService: { pluginShellExecute: execute } }));

const entry = {
  id: 'com.example.shell', installGeneration: 'install-a', enabled: true, grantedPermissions: ['shell:execute'],
};
const result = { exitCode: 7, stdout: 'out\n', stderr: 'err\n' };

beforeEach(() => {
  execute.mockReset().mockResolvedValue(result);
  useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry }] });
});

describe('plugin shell request types without capability quotas', () => {
  it('passes literal arguments, relative paths, environment and stdin without constructing a shell expression', () => {
    const request = {
      program: './tool.cmd', args: ['', 'a b', ';echo injected', '中文'], cwd: '../project',
      env: { MODE: 'debug', EMPTY: '' }, stdin: 'hello\0中文\n', timeoutMs: 0,
    };
    expect(parsePluginShellRequest(request)).toEqual(request);
    expect(parsePluginShellRequest({ program: 'git' })).toEqual({ program: 'git' });
  });

  it.each([
    null, [], 'git', {}, { program: '' }, { program: 1 }, { program: 'git\0bad' },
    { program: 'git', command: 'ignored' }, { program: 'git', shell: true },
    { program: 'git', args: null }, { program: 'git', args: 'status' }, { program: 'git', args: [1] },
    { program: 'git', args: ['a\0b'] }, { program: 'git', args: new Array(2) },
    { program: 'git', cwd: null }, { program: 'git', cwd: '' }, { program: 'git', cwd: '\0' },
    { program: 'git', env: null }, { program: 'git', env: [] }, { program: 'git', env: { X: 1 } },
    { program: 'git', env: { '': 'x' } }, { program: 'git', env: { 'X=Y': 'x' } },
    { program: 'git', env: { X: '\0' } }, { program: 'git', stdin: 1 },
    { program: 'git', timeoutMs: null }, { program: 'git', timeoutMs: '100' },
    { program: 'git', timeoutMs: -1 }, { program: 'git', timeoutMs: 1.5 },
    { program: 'git', timeoutMs: Infinity }, { program: 'git', timeoutMs: NaN },
  ])('rejects invalid wire types or OS strings %j', input => {
    expect(() => parsePluginShellRequest(input)).toThrow(/shell.execute/);
  });

  it('does not cap argument count/size, output size, or caller-selected timeout', async () => {
    const args = Array(300).fill('x'.repeat(40000));
    expect(parsePluginShellRequest({ program: './tool', args, timeoutMs: 3600000 }))
      .toEqual({ program: './tool', args, timeoutMs: 3600000 });
    const large = { ...result, stdout: 'x'.repeat(5 * 1024 * 1024) };
    execute.mockResolvedValueOnce(large);
    await expect(executePluginShell(entry.id, { program: './tool' })).resolves.toEqual(large);
  });

  it('keeps environment names as own data properties, including __proto__', () => {
    const env = JSON.parse('{"__proto__":"literal","PATH":"custom"}');
    const request = parsePluginShellRequest({ program: 'tool', env });
    expect(Object.prototype.hasOwnProperty.call(request.env, '__proto__')).toBe(true);
    expect(request.env!.__proto__).toBe('literal');
  });
});

describe('plugin shell execution authority', () => {
  it('needs only the explicit grant, binds the installation and preserves nonzero exit and both streams', async () => {
    const authority = vi.fn();
    await expect(executePluginShell(entry.id, { program: 'git', args: ['--version'] }, authority))
      .resolves.toEqual(result);
    expect(execute).toHaveBeenCalledExactlyOnceWith(entry.id, 'install-a', { program: 'git', args: ['--version'] });
    expect(authority).toHaveBeenCalledTimes(2);
  });

  it('checks types and live Worker authority before native execution', async () => {
    await expect(executePluginShell(entry.id, { program: 'git', args: [1] })).rejects.toThrow(/args/);
    const retired = () => { throw new Error('request retired'); };
    await expect(executePluginShell(entry.id, { program: 'git' }, retired)).rejects.toThrow('request retired');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...entry, enabled: false }, { ...entry, installGeneration: '' },
    { ...entry, grantedPermissions: ['shell:open'] },
  ])('rejects disabled, unidentified or ungranted execution', async config => {
    useAppStore.getState().setConfig({ pluginConfigs: [config] });
    await expect(executePluginShell(entry.id, { program: 'git' })).rejects.toThrow(/shell:execute/);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...entry, enabled: false }, { ...entry, installGeneration: 'install-b' },
    { ...entry, grantedPermissions: [] },
  ])('does not deliver results after authority changes during native work', async config => {
    execute.mockImplementation(async () => {
      useAppStore.getState().setConfig({ pluginConfigs: [config] });
      return result;
    });
    await expect(executePluginShell(entry.id, { program: 'git' })).rejects.toThrow(/已变化/);
  });

  it('checks retired Worker authority again before delivering output', async () => {
    let alive = true;
    execute.mockImplementation(async () => { alive = false; return result; });
    await expect(executePluginShell(entry.id, { program: 'git' }, () => {
      if (!alive) throw new Error('request retired');
    })).rejects.toThrow('request retired');
  });

  it('preserves native spawn, timeout and cancellation failures', async () => {
    execute.mockRejectedValueOnce(new Error('native timeout'));
    await expect(executePluginShell(entry.id, { program: 'git' })).rejects.toThrow('native timeout');
  });
});
