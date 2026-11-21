import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginProcessService as service } from './pluginProcess';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const owner = { pluginId: 'com.example.shell', expectedGeneration: 'generation-a' };
const session = { ...owner, sessionId: 'session-a' };
const task = { ...session, taskId: 'task-a' };
beforeEach(() => invoke.mockReset());

describe('native shell process service', () => {
  it('sends camelCase session and task authority on every path', async () => {
    invoke.mockResolvedValueOnce(session.sessionId).mockResolvedValueOnce(task.taskId)
      .mockResolvedValueOnce({ kind: 'eof' }).mockResolvedValueOnce({ state: 'running', exitCode: null, error: null })
      .mockResolvedValueOnce({ state: 'cancelling', exitCode: null, error: null });
    await expect(service.openSession(owner)).resolves.toBe(session.sessionId);
    const request = { program: './local-tool', timeoutMs: 0 };
    const options = { stderr: 'discard' } as const;
    await expect(service.start(session, request, options)).resolves.toBe(task.taskId);
    await expect(service.read(task, 'stderr')).resolves.toEqual({ kind: 'eof' });
    await expect(service.status(task, false)).resolves.toMatchObject({ state: 'running' });
    await expect(service.cancel(task)).resolves.toMatchObject({ state: 'cancelling' });
    await service.release(task);
    await service.closeSession(session);
    expect(invoke.mock.calls).toEqual([
      ['plugin_shell_open_session', owner],
      ['plugin_shell_start', { ...session, request, options }],
      ['plugin_shell_read', { ...task, stream: 'stderr' }],
      ['plugin_shell_status', { ...task, wait: false }],
      ['plugin_shell_cancel', task],
      ['plugin_shell_release', task],
      ['plugin_shell_close_session', session],
    ]);
  });

  it('decodes bounded bytes losslessly and does not normalize IPC or framing errors to EOF', async () => {
    invoke.mockResolvedValueOnce({ kind: 'chunk', base64: 'AO+/v/8=' });
    const result = await service.read(task, 'stdout');
    expect(result).toEqual({ kind: 'chunk', bytes: new Uint8Array([0, 239, 191, 191, 255]) });
    invoke.mockResolvedValueOnce({ kind: 'chunk', base64: '%' });
    await expect(service.read(task, 'stderr')).rejects.toThrow();
    invoke.mockResolvedValueOnce({ kind: 'chunk', base64: btoa('a'.repeat(16 * 1024 + 1)) });
    await expect(service.read(task, 'stdout')).rejects.toThrow('长度');
    invoke.mockRejectedValueOnce(new Error('native failure'));
    await expect(service.read(task, 'stdout')).rejects.toThrow('native failure');
  });
});
