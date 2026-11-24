import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginProcessService } from '../services/pluginProcess';
import type { PluginProcessRead } from '../services/pluginProcess';
import { useAppStore } from '../stores/useAppStore';
import { executePluginProcessApi, PluginProcessContext } from './pluginProcess';

vi.mock('../services/pluginProcess', () => ({
  pluginProcessService: {
    openSession: vi.fn(), start: vi.fn(), read: vi.fn(), status: vi.fn(), cancel: vi.fn(), release: vi.fn(), closeSession: vi.fn(),
  },
}));
const service = vi.mocked(pluginProcessService);
const pluginId = 'com.example.shell';
const expectedGeneration = 'generation-a';
const taskId = 'a971ecf6-b80f-4206-9d67-5776c660f332';
const secondId = 'a9dd655d-2711-47e6-9e8a-67c93eceba00';
const owner = { pluginId, expectedGeneration };
const session = { ...owner, sessionId: 'session-a' };
const task = { ...session, taskId };
const request = { program: './local-tool' };
const cancellation = { state: 'cancelling', exitCode: null, error: null } as const;

function configure(installGeneration = expectedGeneration, granted = true) {
  useAppStore.getState().setConfig({
    pluginConfigs: [{ id: pluginId, enabled: true, installGeneration, grantedPermissions: granted ? ['shell:execute'] : [] }],
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function makeContext() { return new PluginProcessContext(pluginId, expectedGeneration); }
function start(context: PluginProcessContext, beforeSend?: () => void) {
  return executePluginProcessApi(context, 'shell.start', { request, options: { stderr: 'discard' } }, beforeSend);
}

beforeEach(() => {
  configure();
  vi.resetAllMocks();
  service.openSession.mockResolvedValue('session-a');
  service.start.mockResolvedValue(taskId);
  service.cancel.mockResolvedValue(cancellation);
  service.release.mockResolvedValue(undefined);
  service.closeSession.mockResolvedValue(undefined);
});

describe('one shell process context per Worker epoch', () => {
  it('lazily shares only one native session, binds all tasks, and cancels only the specified task', async () => {
    const context = makeContext();
    expect(service.openSession).not.toHaveBeenCalled();
    service.start.mockResolvedValueOnce(taskId).mockResolvedValueOnce(secondId);
    const started = await Promise.all([start(context), start(context)]);
    expect(started).toEqual([{ taskId }, { taskId: secondId }]);
    expect(service.openSession).toHaveBeenCalledExactlyOnceWith(owner);
    expect(service.start).toHaveBeenCalledWith(session, request, { stderr: 'discard' });
    await expect(executePluginProcessApi(context, 'shell.cancel', { taskId })).resolves.toEqual(cancellation);
    expect(service.cancel).toHaveBeenCalledExactlyOnceWith(task);
    await expect(executePluginProcessApi(makeContext(), 'shell.cancel', { taskId })).rejects.toThrow('任务已失效');
    context.stop(); context.stop();
    expect(service.closeSession).toHaveBeenCalledExactlyOnceWith(session);
  });

  it('requires explicit serial control and the exact target, preserves the observed generation and separate outcomes', async () => {
    const context = makeContext();
    const serialLoan = { portId: 'COM9', expectedConnectionGeneration: 4 };
    const allowed = { serial: { portWhitelist: ['COM9'] } };
    const run = (target: unknown, manifest = allowed) => executePluginProcessApi(context, 'shell.start', { request, options: { serialLoan: target } }, undefined, manifest);
    await expect(run(serialLoan)).rejects.toThrow('serial:control');
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...useAppStore.getState().config.pluginConfigs[0], grantedPermissions: ['serial:control', 'shell:execute'] }] });
    await expect(run(serialLoan, { serial: { portWhitelist: [] } })).rejects.toThrow('全部端口拒绝');
    await expect(run({ portId: 'COM9' })).rejects.toThrow('expectedConnectionGeneration');
    expect(service.start).not.toHaveBeenCalled();
    await run(serialLoan);
    expect(service.start).toHaveBeenCalledExactlyOnceWith(session, request, { serialLoan });
    const done = { state: 'exited', exitCode: 0, error: null, serialRecovery: { state: 'failed', error: 'port absent' } } as const;
    service.status.mockResolvedValue(done);
    await expect(executePluginProcessApi(context, 'shell.status', { taskId, wait: true })).resolves.toEqual(done);
    context.stop();
  });

  it('checks the grant and install generation before admission and again before delivering reads', async () => {
    const context = makeContext();
    configure(expectedGeneration, false);
    await expect(start(context)).rejects.toThrow('权限');
    expect(service.openSession).not.toHaveBeenCalled();
    configure();
    await start(context);
    const read = deferred<PluginProcessRead>();
    service.read.mockReturnValueOnce(read.promise);
    const pending = executePluginProcessApi(context, 'shell.read', { taskId, stream: 'stdout' });
    configure('new-install');
    read.resolve({ kind: 'chunk', bytes: new Uint8Array([88]) });
    await expect(pending).rejects.toThrow('安装代次');
    context.stop();
  });

  it('closes a session whose open completes after stop without spawning a task', async () => {
    const context = makeContext();
    const opening = deferred<string>();
    service.openSession.mockReturnValueOnce(opening.promise);
    const started = start(context);
    context.stop();
    opening.resolve('session-old');
    await expect(started).rejects.toThrow('停止');
    expect(service.closeSession).toHaveBeenCalledExactlyOnceWith({ ...owner, sessionId: 'session-old' });
    expect(service.start).not.toHaveBeenCalled();
  });

  it('releases a task returning after request retirement; never replays a stale native session', async () => {
    const context = makeContext();
    let retired = false;
    const opening = deferred<string>();
    service.start.mockReturnValueOnce(opening.promise);
    const pending = start(context, () => { if (retired) throw new Error('request retired'); });
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
    retired = true;
    opening.resolve(taskId);
    await expect(pending).rejects.toThrow('request retired');
    expect(service.release).toHaveBeenCalledExactlyOnceWith(task);

    service.start.mockRejectedValueOnce('PLUGIN_SHELL_SESSION_INACTIVE: retired');
    await expect(start(context)).rejects.toBe('PLUGIN_SHELL_SESSION_INACTIVE: retired');
    expect(service.openSession).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledTimes(2);
    service.openSession.mockResolvedValueOnce('session-reopened');
    await start(context);
    expect(service.start).toHaveBeenLastCalledWith({ ...owner, sessionId: 'session-reopened' }, request, { stderr: 'discard' });
    context.stop();
  });

  it('discards a pending read after release and rejects malformed or foreign routing parameters', async () => {
    const context = makeContext();
    await start(context);
    const read = deferred<PluginProcessRead>();
    service.read.mockReturnValueOnce(read.promise);
    const pending = executePluginProcessApi(context, 'shell.read', { taskId, stream: 'stdout' });
    await executePluginProcessApi(context, 'shell.release', { taskId });
    read.resolve({ kind: 'chunk', bytes: new Uint8Array([88]) });
    await expect(pending).rejects.toThrow('任务已失效');
    await expect(executePluginProcessApi(context, 'shell.status', { taskId, wait: true })).rejects.toThrow('任务已失效');
    await expect(executePluginProcessApi(context, 'shell.read', { taskId, stream: 'third' })).rejects.toThrow('名称');
    await expect(executePluginProcessApi(context, 'shell.start', { request, options: { stdout: true } })).rejects.toThrow('pipe');
    expect(service.status).not.toHaveBeenCalled();
    context.stop();
  });
});
