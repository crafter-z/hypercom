import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_PROCESS_FACADE_CODE } from './pluginProcessFacade';
import type { PluginProcessOptions, PluginProcessStatus } from '../services/pluginProcess';

type Handle = {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  status(): Promise<PluginProcessStatus>;
  wait(): Promise<PluginProcessStatus>;
  cancel(): Promise<PluginProcessStatus>;
  release(): Promise<void>;
};
function createFacade(api: Record<string, (args: Record<string, unknown>) => Promise<unknown>>) {
  return new Function('api', `${PLUGIN_PROCESS_FACADE_CODE}\nreturn startPluginProcess;`)(api) as
    (request: { program: string }, options?: PluginProcessOptions) => Promise<Handle>;
}

async function consume(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let result = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream) result += decoder.decode(chunk, { stream: true });
  return result + decoder.decode();
}

const running = { state: 'running', exitCode: null, error: null } as const;
const exited = { state: 'exited', exitCode: 7, error: null } as const;
const cancelled = { state: 'cancelled', exitCode: null, error: null } as const;
const chunk = (bytes: Uint8Array) => ({ kind: 'chunk', bytes });
const eof = { kind: 'eof' };

describe('Worker shell stream facade', () => {
  it('supports parallel consumption with separate streaming decoders and final status', async () => {
    const encoder = new TextEncoder();
    const raw = encoder.encode('A桥B');
    const pipes = { stdout: [chunk(raw.subarray(0, 3)), chunk(raw.subarray(3)), eof], stderr: [chunk(encoder.encode('warn')), eof] };
    const open = vi.fn().mockResolvedValue({ taskId: 'first' });
    const read = vi.fn(async ({ stream }: Record<string, unknown>) => pipes[stream as keyof typeof pipes].shift());
    const release = vi.fn().mockResolvedValue(undefined);
    const status = vi.fn(async ({ wait }: Record<string, unknown>) => wait ? exited : running);
    const start = createFacade({ 'shell.start': open, 'shell.read': read, 'shell.release': release, 'shell.status': status });
    const task = await start({ program: './local-tool' });
    expect(open).toHaveBeenCalledWith({ request: { program: './local-tool' }, options: undefined });
    expect(read).not.toHaveBeenCalled();
    expect(await task.status()).toEqual(running);
    const [stdout, stderr, terminal] = await Promise.all([consume(task.stdout), consume(task.stderr), task.wait()]);
    expect([stdout, stderr, terminal]).toEqual(['A桥B', 'warn', exited]);
    expect(read.mock.calls.every(([args]) => args.taskId === 'first')).toBe(true);
    await Promise.all([task.release(), task.release()]);
    await task.release();
    expect(release).toHaveBeenCalledExactlyOnceWith({ taskId: 'first' });
  });

  it('pulls only on next, rejects a concurrent reader, and can cancel while one read is pending', async () => {
    let finish!: (result: { kind: string }) => void;
    const read = vi.fn().mockResolvedValueOnce(chunk(new Uint8Array([1])))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const release = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn(async () => { finish(eof); return cancelled; });
    const open = vi.fn().mockResolvedValue({ taskId: 'next' });
    const start = createFacade({ 'shell.start': open, 'shell.read': read, 'shell.cancel': cancel, 'shell.release': release });
    const task = await start({ program: './local-tool' }, { stderr: 'discard' });
    expect(open).toHaveBeenCalledWith({ request: { program: './local-tool' }, options: { stderr: 'discard' } });
    const first = task.stdout[Symbol.asyncIterator]();
    await expect(first.next()).resolves.toEqual({ value: new Uint8Array([1]), done: false });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    const concurrent = task.stdout[Symbol.asyncIterator]();
    await expect(concurrent.next()).rejects.toThrow('already has a reader');
    const pending = first.next();
    await expect(task.cancel()).resolves.toEqual(cancelled);
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ taskId: 'next' });
    await task.release();
    await expect(task.status()).rejects.toThrow('released');
  });
});
