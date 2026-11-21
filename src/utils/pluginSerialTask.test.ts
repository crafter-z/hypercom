import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_SERIAL_TASK_WINDOW_BYTES as WINDOW, pluginSerialTaskService, type PluginSerialTaskStep } from '../services/pluginSerialTask';
import { useAppStore } from '../stores/useAppStore';
import type { PluginManifestView } from '../types';
import { isFlowRunning, isSerialTaskRunning, resetFlowRuntime, setFlowStatus } from './flowRuntime';
import { PluginSerialTaskContext, type PluginSerialTaskOp, type PluginSerialTaskReadSource } from './pluginSerialTask';
import { PLUGIN_SERIAL_TASK_SDK_CODE, type PluginSerialClientProgress, type PluginSerialSendTask } from './pluginSerialTaskSdk';
import { trafficStats } from './trafficStats';

const PLUGIN = 'com.example.test';
const PORT = 'COM8';
const GENERATION = 17;
const options = { portId: PORT, expectedConnectionGeneration: GENERATION };
const manifest = { id: PLUGIN, serial: { portWhitelist: [PORT, 'COM9'] } } as PluginManifestView;
const identity = { pluginId: PLUGIN, expectedGeneration: 'install', portId: PORT };
const chunkResult = (bytesWritten: number) => ({ outcome: 'written', bytesWritten } as const);
const makeSdk = new Function('callHost', 'newRequestId', `${PLUGIN_SERIAL_TASK_SDK_CODE}\nreturn serialTasks`) as (
  callHost: (op: PluginSerialTaskOp, args: unknown) => Promise<unknown>, nextId: () => string,
) => {
  sendBytes(args: typeof options & { bytes: Uint8Array | ArrayBuffer; signal?: AbortSignal }): PluginSerialSendTask;
  sendFile(args: typeof options & { handleId: string; signal?: AbortSignal }): PluginSerialSendTask;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let context: PluginSerialTaskContext;
function sdk(readSource?: PluginSerialTaskReadSource) {
  let ids = 0;
  return makeSdk(async (op, args) => context.execute(op, args, manifest, undefined, readSource),
    () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`);
}

beforeEach(() => {
  context = new PluginSerialTaskContext(PLUGIN, 'install', 2);
  useAppStore.getState().setConfig({ pluginConfigs: [{ id: PLUGIN, enabled: true, installGeneration: 'install', grantedPermissions: ['serial:send', 'fs:open'] }] });
  useAppStore.setState({ ports: [PORT, 'COM9'].map(id => ({ id, name: id, status: 'connected', mode: 'trx', type: 'real', isHidden: false, connectionGeneration: GENERATION })) });
  vi.spyOn(pluginSerialTaskService, 'begin').mockImplementation(async (_id, _generation, source) => ({
    totalBytes: source.kind === 'bytes' ? source.totalBytes : WINDOW + 2, connected: true, windowBytes: WINDOW,
  }));
  vi.spyOn(pluginSerialTaskService, 'close').mockResolvedValue(undefined);
});

afterEach(() => {
  context.stop();
  resetFlowRuntime();
  trafficStats.reset();
  vi.restoreAllMocks();
});

describe('Worker serial send tasks', () => {
  it('sends exact bytes in bounded windows and publishes monotonic progress', async () => {
    const backing = new Uint8Array(WINDOW + 9);
    backing[4] = 255;
    backing[WINDOW + 4] = 128;
    const bytes = backing.subarray(4, WINDOW + 7);
    const native = vi.spyOn(pluginSerialTaskService, 'step').mockImplementation(async (_id, _offset, data) => chunkResult(data!.length));
    const progress: number[] = [];
    const task = sdk().sendBytes({ ...options, bytes });
    task.onProgress(event => progress.push(event.bytesWritten));
    await expect(task.done).resolves.toMatchObject({ status: 'completed', totalBytes: WINDOW + 3, bytesWritten: WINDOW + 3 });
    expect(progress).toEqual([0, WINDOW, WINDOW + 3]);
    expect(native).toHaveBeenCalledTimes(2);
    expect(native.mock.calls[0][2]?.buffer.byteLength).toBe(WINDOW);
    expect(native.mock.calls[0][2]?.[0]).toBe(255);
    expect(native.mock.calls[1][2]).toEqual(new Uint8Array([128, 0, 0]));
    expect(isSerialTaskRunning(PORT)).toBe(false);
  });

  it('uses only the selected native read source and stops before writing a tail to a replacement connection', async () => {
    const readSource = vi.fn(() => ({ handleId: 'trusted-handle', sessionId: 'current-worker-session', size: WINDOW + 2 }));
    const native = vi.spyOn(pluginSerialTaskService, 'step').mockImplementation(async () => {
      useAppStore.getState().updatePort(PORT, { connectionGeneration: GENERATION + 1 });
      return chunkResult(WINDOW);
    });
    const task = sdk(readSource).sendFile({ ...options, handleId: 'display-handle' });
    await expect(task.done).resolves.toMatchObject({ status: 'disconnected', bytesWritten: WINDOW, connectionGeneration: GENERATION });
    expect(readSource).toHaveBeenCalledExactlyOnceWith('display-handle');
    expect(pluginSerialTaskService.begin).toHaveBeenCalledExactlyOnceWith({ ...identity, taskId: task.taskId }, GENERATION, {
      kind: 'file', sessionId: 'current-worker-session', handleId: 'trusted-handle',
    });
    expect(native).toHaveBeenCalledExactlyOnceWith({ ...identity, taskId: task.taskId }, 0, undefined);
  });

  it('honors a smaller native progress window instead of forcing 64 KiB per checkpoint', async () => {
    vi.mocked(pluginSerialTaskService.begin).mockResolvedValueOnce({ connected: true, totalBytes: 7, windowBytes: 3 });
    const native = vi.spyOn(pluginSerialTaskService, 'step').mockImplementation(async (_id, _offset, data) => chunkResult(data!.length));
    const counts: number[] = [];
    const task = sdk().sendBytes({ ...options, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7]) });
    task.onProgress(event => counts.push(event.bytesWritten));
    await expect(task.done).resolves.toMatchObject({ status: 'completed', bytesWritten: 7 });
    expect(counts).toEqual([0, 3, 6, 7]);
    expect(native.mock.calls.map(([, offset, bytes]) => [offset, Array.from(bytes!)]))
      .toEqual([[0, [1, 2, 3]], [3, [4, 5, 6]], [6, [7]]]);
  });

  it('revoking fs:open retires an idle file task without touching another byte task', async () => {
    const fileId = 'aaaa0000-0000-4000-8000-000000000001';
    const bytesId = 'bbbb0000-0000-4000-8000-000000000002';
    const readSource = () => ({ handleId: 'read-handle', sessionId: 'read-session', size: WINDOW + 2 });
    const native = vi.spyOn(pluginSerialTaskService, 'step').mockResolvedValue(chunkResult(1));
    await expect(context.execute('serial.beginSend', { ...options, taskId: fileId, kind: 'file', handleId: 'read-handle' }, manifest, undefined, readSource))
      .resolves.toMatchObject({ status: 'running' });
    await expect(context.execute('serial.beginSend', { ...options, portId: 'COM9', taskId: bytesId, kind: 'bytes', totalBytes: 1 }, manifest, undefined))
      .resolves.toMatchObject({ status: 'running' });
    useAppStore.getState().setConfig({ pluginConfigs: [{ id: PLUGIN, enabled: true, installGeneration: 'install', grantedPermissions: ['serial:send'] }] });
    await expect(context.execute('serial.sendStep', { taskId: fileId }, manifest, undefined))
      .resolves.toMatchObject({ status: 'cancelled', bytesWritten: 0 });
    expect(isSerialTaskRunning(PORT)).toBe(false);
    expect(isSerialTaskRunning('COM9')).toBe(true);
    await expect(context.execute('serial.sendStep', { taskId: bytesId, bytes: new Uint8Array([19]) }, manifest, undefined))
      .resolves.toMatchObject({ status: 'completed', bytesWritten: 1 });
    expect(native).toHaveBeenCalledExactlyOnceWith({ ...identity, taskId: bytesId, portId: 'COM9' }, 0, new Uint8Array([19]));
  });

  it('cancels once without hiding a window acknowledged by the driver', async () => {
    const pending = deferred<PluginSerialTaskStep>();
    const started = deferred<void>();
    const native = vi.spyOn(pluginSerialTaskService, 'step').mockImplementation(async () => { started.resolve(); return pending.promise; });
    const task = sdk().sendBytes({ ...options, bytes: new Uint8Array(WINDOW * 2) });
    await started.promise;
    await Promise.all([task.cancel(), task.cancel()]);
    expect(task.getProgress().status).toBe('cancelling');
    expect(isSerialTaskRunning(PORT)).toBe(true);
    expect(isFlowRunning(PORT)).toBe(false);
    pending.resolve(chunkResult(WINDOW));
    await expect(task.done).resolves.toMatchObject({ status: 'cancelled', bytesWritten: WINDOW });
    expect(native).toHaveBeenCalledTimes(1);
    expect(pluginSerialTaskService.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the confirmed prefix when a write result is lost, and never retries the uncertain window', async () => {
    const native = vi.spyOn(pluginSerialTaskService, 'step').mockResolvedValueOnce(chunkResult(WINDOW)).mockRejectedValueOnce('reply interrupted');
    const task = sdk().sendBytes({ ...options, bytes: new Uint8Array(WINDOW + 1) });
    await expect(task.done).resolves.toMatchObject({ status: 'unknown', bytesWritten: WINDOW, message: 'reply interrupted' });
    expect(native).toHaveBeenCalledTimes(2);
    expect(native.mock.calls.map(([, offset]) => offset)).toEqual([0, WINDOW]);
  });

  it('distinguishes an empty send from a failed send and refuses an existing enhanced-flow owner', async () => {
    const native = vi.spyOn(pluginSerialTaskService, 'step');
    const client = sdk();
    await expect(client.sendBytes({ ...options, bytes: new Uint8Array() }).done).resolves.toMatchObject({ status: 'completed', bytesWritten: 0 });
    expect(native).not.toHaveBeenCalled();
    setFlowStatus({ portId: PORT, runId: 'enhanced', phase: 'waiting', exclusive: true });
    await expect(client.sendBytes({ ...options, bytes: new Uint8Array(1) }).done).resolves.toMatchObject({ status: 'failed', bytesWritten: 0 });
    expect(isFlowRunning(PORT)).toBe(true);
    expect(pluginSerialTaskService.begin).toHaveBeenCalledTimes(1);
  });

  it('retires the Worker context during an in-flight step without dispatching its next one', async () => {
    const pending = deferred<PluginSerialTaskStep>();
    const started = deferred<void>();
    const native = vi.spyOn(pluginSerialTaskService, 'step').mockImplementation(async () => { started.resolve(); return pending.promise; });
    const final: PluginSerialClientProgress[] = [];
    const task = sdk().sendBytes({ ...options, bytes: new Uint8Array(WINDOW + 4) });
    task.onProgress(event => final.push(event));
    await started.promise;
    context.stop();
    pending.resolve(chunkResult(WINDOW));
    await expect(task.done).resolves.toMatchObject({ status: 'cancelled', bytesWritten: WINDOW });
    expect(final[final.length - 1]?.connectionGeneration).toBe(GENERATION);
    expect(native).toHaveBeenCalledTimes(1);
  });
});
