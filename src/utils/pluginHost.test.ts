import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import { PluginSession, MAX_PENDING_MESSAGES } from './pluginHost';
import { executeHostApi } from './pluginHostApi';

const readAsset = vi.fn();
const disable = vi.fn();
vi.mock('../services/tauri', () => ({
  pluginService: {
    readPluginAsset: (...args: unknown[]) => readAsset(...args),
    setPluginEnabled: (...args: unknown[]) => disable(...args),
  },
}));
vi.mock('./pluginHostApi', () => ({ executeHostApi: vi.fn().mockResolvedValue('response') }));

const pluginId = 'com.example.worker';
const manifest = { id: pluginId, name: 'Worker', entry: 'dist/entry.js', permissions: [], serial: { portWhitelist: [] } };
const entry = { id: pluginId, enabled: true, grantedPermissions: [] as string[] };

class TestWorker {
  static created: TestWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(_url: string) { TestWorker.created.push(this); }
  emit(data: unknown): void { this.onmessage?.({ data }); }
}

beforeEach(() => {
  TestWorker.created = [];
  readAsset.mockReset();
  disable.mockReset();
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:plugin'),
    revokeObjectURL: vi.fn(),
  });
  useAppStore.getState().setConfig({ pluginConfigs: [entry] });
  readAsset.mockImplementation((_id: string, path: string) =>
    Promise.resolve(path === 'manifest.json' ? JSON.stringify(manifest) : 'self.plugin.on("rx.line", () => {});'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PluginSession worker lifetime', () => {
  it('loads manifest.entry and fails closed when manifest cannot be read', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    expect(readAsset.mock.calls.map((args) => args[1])).toEqual(['manifest.json', 'dist/entry.js']);
    expect(session.loaded).toBe(true);
    session.stop();
    expect(TestWorker.created[0].terminate).toHaveBeenCalledOnce();

    readAsset.mockRejectedValue(new Error('manifest missing'));
    await expect(new PluginSession(pluginId).start()).rejects.toThrow('manifest missing');
    expect(TestWorker.created).toHaveLength(1);
  });
  it('rejects an invalid manifest scope without constructing a worker', async () => {
    readAsset.mockResolvedValueOnce(JSON.stringify({ ...manifest, serial: { portWhitelist: 'COM1' } }));
    const session = new PluginSession(pluginId);
    await expect(session.start()).rejects.toThrow('invalid plugin manifest');
    expect(TestWorker.created).toHaveLength(0);
  });

  it('does not construct a worker after stop cancels an in-flight manifest read', async () => {
    let resolveManifest!: (value: string) => void;
    readAsset.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveManifest = resolve; }));
    const session = new PluginSession(pluginId);
    const starting = session.start();
    session.stop();
    resolveManifest(JSON.stringify(manifest));
    await starting;
    expect(readAsset).toHaveBeenCalledTimes(1);
    expect(TestWorker.created).toHaveLength(0);
  });

  it('answers slow API results only to the worker that initiated the request', async () => {
    let finish!: (value: string) => void;
    vi.mocked(executeHostApi).mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const session = new PluginSession(pluginId);
    await session.start();
    const oldWorker = TestWorker.created[0];
    oldWorker.emit({ seq: 3, op: 'ports.list', args: null });
    session.stop();
    await session.start();
    finish('response');
    await Promise.resolve();
    expect(oldWorker.postMessage).not.toHaveBeenCalledWith({ seq: 3, ok: true, result: 'response' });
    expect(TestWorker.created[1].postMessage).not.toHaveBeenCalledWith({ seq: 3, ok: true, result: 'response' });
    session.stop();
  });

  it('bounds unacknowledged events and releases capacity only on worker acknowledgement', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    for (let i = 1; i < MAX_PENDING_MESSAGES; i++) expect(session.post({ type: 'rx.bytes' })).toBe(true);
    expect(session.post({ type: 'rx.bytes' })).toBe(false);
    expect(TestWorker.created[0].postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rx.dropped' }), []);
    TestWorker.created[0].emit({ eventAck: 1 });
    const notice = TestWorker.created[0].postMessage.mock.calls
      .map(([message]) => message as { type: string; eventId: number; payload?: unknown })
      .find((message) => message.type === 'rx.dropped');
    expect(notice?.payload).toEqual({ reason: 'worker-backpressure' });
    // The loss notice itself consumes the newly released slot until acknowledged.
    TestWorker.created[0].emit({ eventAck: notice!.eventId });
    expect(session.post({ type: 'rx.bytes' })).toBe(true);
    session.stop();
  });

  it('retries worker crashes then persists disabled after repeated failures', async () => {
    vi.useFakeTimers();
    disable.mockResolvedValue([{ ...entry, enabled: false }]);
    const session = new PluginSession(pluginId);
    await session.start();
    for (let i = 0; i < 3; i++) {
      const worker = TestWorker.created[i];
      worker.onerror?.({ message: 'boom' });
      expect(worker.terminate).toHaveBeenCalledOnce();
      if (i < 2) {
        await vi.advanceTimersByTimeAsync(101);
        expect(TestWorker.created).toHaveLength(i + 2);
      }
    }
    await Promise.resolve();
    expect(disable).toHaveBeenCalledOnce();
    expect(useAppStore.getState().config.pluginConfigs[0].enabled).toBe(false);
  });
});
