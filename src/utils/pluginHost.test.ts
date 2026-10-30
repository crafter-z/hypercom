import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import { PluginHostManager, PluginSession, MAX_PENDING_MESSAGES, MAX_PENDING_CONTROL_MESSAGES, MAX_PENDING_EVENT_BYTES, PLUGIN_READY_TIMEOUT_MS } from './pluginHost';
import { executeHostApi } from './pluginHostApi';
import { cancelPluginHttp } from './pluginHttp';
import { resetPluginSnapshotForTest, syncStorePluginConfigs } from './pluginConfigSnapshot';

const readAsset = vi.fn();
const disable = vi.fn();
vi.mock('../services/tauri', () => ({
  pluginService: {
    readPluginAsset: (...args: unknown[]) => readAsset(...args),
    setPluginEnabled: (...args: unknown[]) => disable(...args),
  },
}));
vi.mock('./pluginHostApi', () => ({
  executeHostApi: vi.fn().mockResolvedValue('response'),
  // The host uses this for log sanitizing; a module-level mock must expose every
  // symbol the host imports or the catch path would throw while replying.
  cleanHostText: (value: string) => String(value).replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 500),
}));
vi.mock('./pluginHttp', () => ({ cancelPluginHttp: vi.fn() }));

const pluginId = 'com.example.worker';
const manifest = { id: pluginId, name: 'Worker', entry: 'dist/entry.js', permissions: [], serial: { portWhitelist: [] } };
const entry = { id: pluginId, installGeneration: 'install-a', enabled: true, grantedPermissions: [] as string[] };

// tsconfig targets ES2020, before Promise.withResolvers is typed.
function deferredResult<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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
  resetPluginSnapshotForTest();
  readAsset.mockReset();
  disable.mockReset();
  vi.mocked(executeHostApi).mockReset();
  vi.mocked(executeHostApi).mockResolvedValue('response');
  vi.mocked(cancelPluginHttp).mockReset();
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:plugin'),
    revokeObjectURL: vi.fn(),
  });
  useAppStore.getState().setConfig({ revision: 0, pluginConfigs: [entry] });
  readAsset.mockImplementation((_id: string, path: string) =>
    Promise.resolve(path === 'manifest.json' ? JSON.stringify(manifest) : 'self.plugin.on("rx.line", () => {});'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PluginSession worker lifetime', () => {
  it('rejects a managed Worker that never becomes ready and terminates it', async () => {
    vi.useFakeTimers();
    const session = new PluginSession(pluginId, true);
    await session.start();
    const waiting = expect(session.startReady()).rejects.toThrow('ready timed out');
    await vi.advanceTimersByTimeAsync(PLUGIN_READY_TIMEOUT_MS);
    await waiting;
    expect(TestWorker.created[0].terminate).toHaveBeenCalledOnce();
    session.stop();
  });

  it('clears the managed startup deadline once the bridge reports ready', async () => {
    vi.useFakeTimers();
    const session = new PluginSession(pluginId, true);
    await session.start();
    const worker = TestWorker.created[0];
    worker.emit({ type: '__plugin_ready' });
    await vi.advanceTimersByTimeAsync(PLUGIN_READY_TIMEOUT_MS + 1);
    await expect(session.startReady()).resolves.toBeUndefined();
    expect(worker.terminate).not.toHaveBeenCalled();
    session.stop();
  });
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

  it.each([
    { entry: './dist//entry.js', serial: null, http: null, shell: null, ui: null },
    { entry: '.\\dist\\\\entry.js', serial: undefined, http: undefined, shell: undefined },
    { entry: 'dist/./entry.js', serial: {}, http: {}, shell: {}, ui: {} },
    { entry: 'dist/entry.js', serial: { portWhitelist: ['COM1'] }, http: { urlWhitelist: ['https://example.com/*'] },
      shell: { executableWhitelist: ['tool'] }, ui: { buttons: [{ id: 'button', label: 'Button', icon: null, target: null }] } },
  ])('accepts Rust-legal path/scope variants: %j', async (variant) => {
    readAsset.mockResolvedValueOnce(JSON.stringify({ ...manifest, ...variant }));
    const session = new PluginSession(pluginId);
    await session.start();
    expect(readAsset).toHaveBeenLastCalledWith(pluginId, 'dist/entry.js');
    const worker = TestWorker.created[0];
    worker.emit({ seq: 1, op: 'ports.list' });
    const normalized = vi.mocked(executeHostApi).mock.calls[0][3];
    expect(normalized?.serial).toEqual(variant.serial == null ? undefined : { portWhitelist: 'portWhitelist' in variant.serial ? variant.serial.portWhitelist : [] });
    expect(normalized?.http).toEqual(variant.http == null ? undefined : { urlWhitelist: 'urlWhitelist' in variant.http ? variant.http.urlWhitelist : [] });
    expect(normalized?.shell).toEqual(variant.shell == null ? undefined : { executableWhitelist: 'executableWhitelist' in variant.shell ? variant.shell.executableWhitelist : [] });
    if (variant.ui === null) expect(normalized?.ui).toBeUndefined();
    session.stop();
  });

  it.each([
    { entry: '' }, { entry: ' ' }, { entry: '././' }, { entry: '/dist/entry.js' },
    { entry: '\\dist\\entry.js' }, { entry: 'C:\\dist\\entry.js' }, { entry: 'C:entry.js' },
    { entry: 'dist/../entry.js' }, { entry: 'dist\\..\\entry.js' }, { entry: 5 },
    { permissions: {} }, { permissions: [5] }, { serial: [] },
    { serial: { portWhitelist: [5] } }, { http: { urlWhitelist: null } },
    { http: { urlWhitelist: [''] } },
    { shell: 'invalid' }, { ui: [] }, { ui: { buttons: null } },
    { ui: { buttons: [{ id: 'button', label: 'Button', target: 3 }] } },
    { ui: { buttons: [{ id: 3, label: 'Button' }] } },
    { ui: { buttons: [{ id: 'button', label: 'Button', icon: 3 }] } },
  ])('rejects malformed or unsafe manifest variants: %j', async (variant) => {
    readAsset.mockResolvedValueOnce(JSON.stringify({ ...manifest, ...variant }));
    await expect(new PluginSession(pluginId).start()).rejects.toThrow('invalid plugin manifest');
    expect(readAsset).toHaveBeenCalledTimes(1);
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

  it('retires timed-out host slots without cancelling backend work or replying twice', async () => {
    vi.useFakeTimers();
    const deferred = deferredResult<unknown>();
    vi.mocked(executeHostApi).mockImplementation(() => deferred.promise);
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    for (let seq = 1; seq <= MAX_PENDING_MESSAGES; seq++) worker.emit({ seq, op: 'ports.list' });
    worker.emit({ seq: 100, op: 'ports.list' });
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 100, ok: false, error: 'plugin RPC capacity exceeded' });
    expect(executeHostApi).toHaveBeenCalledTimes(MAX_PENDING_MESSAGES);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 1, ok: false, error: 'plugin RPC timed out' });
    worker.emit({ seq: 101, op: 'ports.list' });
    expect(executeHostApi).toHaveBeenCalledTimes(MAX_PENDING_MESSAGES + 1);
    deferred.resolve('late');
    await Promise.resolve();
    expect(worker.postMessage).not.toHaveBeenCalledWith({ seq: 1, ok: true, result: 'late' });
    session.stop();
  });

  it('keeps slow file reads and user-controlled dialogs alive beyond ordinary deadlines', async () => {
    vi.useFakeTimers();
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry, grantedPermissions: ['http:request', 'fs:open', 'fs:assets'] }] });
    const http = deferredResult<unknown>();
    const dialog = deferredResult<unknown>();
    const read = deferredResult<unknown>();
    vi.mocked(executeHostApi).mockImplementation((_id, op) => op === 'http.request' ? http.promise : op === 'fs.read' ? read.promise : dialog.promise);
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    worker.emit({ seq: 1, op: 'http.request', args: {} });
    worker.emit({ seq: 2, op: 'fs.openDialog', args: {} });
    worker.emit({ seq: 3, op: 'fs.read', args: { rel: 'assets/large.txt' } });
    await vi.advanceTimersByTimeAsync(15_500);
    http.resolve('http success');
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 1, ok: true, result: 'http success' });
    await vi.advanceTimersByTimeAsync(60_000);
    dialog.resolve({ files: [] });
    read.resolve('large file completed');
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 2, ok: true, result: { files: [] } });
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 3, ok: true, result: 'large file completed' });
    session.stop();
  });

  it('keeps user-controlled panel export pending past the ordinary RPC deadline', async () => {
    vi.useFakeTimers();
    const exported = deferredResult<unknown>();
    vi.mocked(executeHostApi).mockImplementationOnce(() => exported.promise);
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    worker.emit({ seq: 1, op: 'ui.panel.export' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(worker.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }));
    exported.resolve(null);
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 1, ok: true, result: null });
    session.stop();
  });

  it('reclaims slots at stop and never forwards a prior worker response after restart', async () => {
    const deferred = deferredResult<unknown>();
    vi.mocked(executeHostApi).mockImplementationOnce(() => deferred.promise);
    const session = new PluginSession(pluginId);
    await session.start();
    const oldWorker = TestWorker.created[0];
    oldWorker.emit({ seq: 1, op: 'ports.list' });
    session.stop();
    await session.start();
    const current = TestWorker.created[1];
    for (let seq = 1; seq <= MAX_PENDING_MESSAGES; seq++) current.emit({ seq, op: 'ports.list' });
    await Promise.resolve();
    expect(current.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ error: 'plugin RPC capacity exceeded' }));
    deferred.resolve('obsolete');
    await Promise.resolve();
    expect(current.postMessage).not.toHaveBeenCalledWith({ seq: 1, ok: true, result: 'obsolete' });
    expect(oldWorker.postMessage).not.toHaveBeenCalledWith({ seq: 1, ok: true, result: 'obsolete' });
    session.stop();
  });

  it('retires a crashed worker’s deferred RPC before automatic restart', async () => {
    vi.useFakeTimers();
    const deferred = deferredResult<unknown>();
    vi.mocked(executeHostApi).mockImplementationOnce(() => deferred.promise);
    const session = new PluginSession(pluginId);
    await session.start();
    const oldWorker = TestWorker.created[0];
    oldWorker.emit({ seq: 1, op: 'ports.list' });
    oldWorker.onerror?.({ message: 'worker error' });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(0);
    const replacement = TestWorker.created[1];
    for (let seq = 1; seq <= MAX_PENDING_MESSAGES; seq++) replacement.emit({ seq, op: 'ports.list' });
    await Promise.resolve();
    expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ error: 'plugin RPC capacity exceeded' }));
    deferred.resolve('obsolete');
    await Promise.resolve();
    expect(replacement.postMessage).not.toHaveBeenCalledWith({ seq: 1, ok: true, result: 'obsolete' });
    session.stop();
  });

  it('distinguishes disabled from timeout even for a permissionless operation', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry, enabled: false }] });
    const worker = TestWorker.created[0];
    worker.emit({ seq: 4, op: 'ports.list' });
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 4, ok: false, error: 'plugin disabled' });
    expect(executeHostApi).not.toHaveBeenCalled();
    session.stop();
  });

  it.each(['revoke', 'stop', 'upgrade', 'timeout'])('blocks a queued serial effect after %s before it starts', async transition => {
    vi.useFakeTimers();
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry, grantedPermissions: ['serial:send'] }] });
    const queued = deferredResult<void>();
    const send = vi.fn();
    vi.mocked(executeHostApi).mockImplementationOnce(async (_id, _op, _args, _manifest, beforeSend) => {
      await queued.promise;
      beforeSend!();
      send();
      return { bytesWritten: 4 };
    });
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    worker.emit({ seq: 1, op: 'serial.send', args: { portId: 'COM3', data: 'PING' } });
    if (transition === 'revoke') useAppStore.getState().setConfig({ pluginConfigs: [entry] });
    else if (transition === 'stop') session.stop();
    else if (transition === 'upgrade') useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry, installGeneration: 'install-b', grantedPermissions: ['serial:send'] }] });
    else await vi.advanceTimersByTimeAsync(10_000);
    queued.resolve(undefined);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalledWith({ seq: 1, ok: true, result: { bytesWritten: 4 } });
    session.stop();
  });

  it('reserves control capacity when RX is full and reports drops after acknowledgement', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    for (let i = 0; i < MAX_PENDING_MESSAGES; i++) expect(session.post({ type: 'rx.bytes' })).toBe(true);
    expect(session.post({ type: 'rx.bytes' })).toBe(false);
    expect(session.post({ type: 'rx.detached', payload: { portId: 'COM1' } })).toBe(true);
    expect(session.post({ type: 'ui.buttonClick', payload: { id: 'button' } })).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'rx.detached' }), []);
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ui.buttonClick' }), []);
    worker.emit({ eventAck: 1 });
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'rx.dropped', payload: { reason: 'worker-backpressure' },
    }), []);
    // A control ACK never releases an RX slot.
    expect(session.post({ type: 'rx.bytes' })).toBe(false);
    worker.emit({ eventAck: 2 });
    expect(session.post({ type: 'rx.bytes' })).toBe(true);
    session.stop();
  });

  it('queues control events in order and retries a loss notice when both control bounds are full', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    for (let i = 1; i < MAX_PENDING_CONTROL_MESSAGES; i++) {
      expect(session.post({ type: 'ui.buttonClick', payload: i })).toBe(true);
    }
    expect(session.post({ type: 'rx.detached', payload: 'queued-detach' })).toBe(true);
    for (let i = 1; i < MAX_PENDING_CONTROL_MESSAGES; i++) {
      expect(session.post({ type: 'ui.buttonClick', payload: `queued-${i}` })).toBe(true);
    }
    expect(session.post({ type: 'ui.buttonClick', payload: 'overflow' })).toBe(false);
    expect(worker.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ payload: 'queued-detach' }), []);
    for (let i = 0; i < MAX_PENDING_MESSAGES; i++) expect(session.post({ type: 'rx.bytes' })).toBe(true);
    expect(session.post({ type: 'rx.bytes' })).toBe(false);
    // RX ACK cannot release control capacity, so the internally retained loss notice waits.
    worker.emit({ eventAck: MAX_PENDING_CONTROL_MESSAGES + 1 });
    expect(worker.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rx.dropped' }), []);
    worker.emit({ eventAck: 1 });
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ payload: 'queued-detach' }), []);
    expect(worker.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rx.dropped' }), []);
    // The first control ACK queues the loss notice; draining the earlier controls eventually sends it.
    for (let eventAck = 2; eventAck <= MAX_PENDING_CONTROL_MESSAGES; eventAck++) worker.emit({ eventAck });
    const detach = worker.postMessage.mock.calls
      .map(([message]) => message as { type: string; payload?: unknown; eventId: number })
      .find((message) => message.payload === 'queued-detach')!;
    worker.emit({ eventAck: detach.eventId });
    const controls = worker.postMessage.mock.calls.map(([message]) => message as { type: string; payload?: unknown });
    const detachIndex = controls.findIndex((message) => message.payload === 'queued-detach');
    const droppedIndex = controls.findIndex((message) => message.type === 'rx.dropped');
    expect(detachIndex).toBeGreaterThan(-1);
    expect(droppedIndex).toBeGreaterThan(detachIndex);
    expect(controls.filter((message) => message.type === 'rx.dropped')).toHaveLength(1);
    session.stop();
  });

  it('reserves control capacity even when the RX byte limit is exhausted', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    expect(session.post({ type: 'rx.bytes', payload: [{ bytes: new Uint8Array(MAX_PENDING_EVENT_BYTES) }] })).toBe(true);
    expect(session.post({ type: 'rx.bytes', payload: [{ bytes: new Uint8Array(1) }] })).toBe(false);
    expect(session.post({ type: 'rx.detached' })).toBe(true);
    expect(session.post({ type: 'ui.buttonClick' })).toBe(true);
    session.stop();
  });

  it('clears pending controls at stop instead of delivering them to a replacement worker', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    for (let i = 1; i < MAX_PENDING_CONTROL_MESSAGES; i++) session.post({ type: 'ui.buttonClick' });
    expect(session.post({ type: 'rx.detached', payload: 'old-worker' })).toBe(true);
    session.stop();
    await session.start();
    TestWorker.created[1].emit({ eventAck: MAX_PENDING_CONTROL_MESSAGES + 1 });
    expect(TestWorker.created[1].postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ payload: 'old-worker' }), []);
    session.stop();
  });

  it('retries worker crashes then persists disabled after repeated failures', async () => {
    vi.useFakeTimers();
    disable.mockResolvedValue({ revision: 1, pluginConfigs: [{ ...entry, enabled: false }] });
    const session = new PluginSession(pluginId);
    await session.start();
    for (let i = 0; i < 3; i++) {
      const worker = TestWorker.created[i];
      worker.onerror?.({ message: 'boom' });
      expect(worker.terminate).toHaveBeenCalledOnce();
      if (i < 2) {
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(0);
        expect(TestWorker.created).toHaveLength(i + 2);
      }
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(disable).toHaveBeenCalledOnce();
    expect(useAppStore.getState().config.pluginConfigs[0].enabled).toBe(false);
  });
});

describe('PluginHostManager startup recovery', () => {
  it('recovers an initial busy read without requiring a config change', async () => {
    vi.useFakeTimers();
    readAsset.mockRejectedValueOnce(new Error('plugin disk gate busy'));
    const manager = new PluginHostManager();
    await manager.enable(pluginId);
    expect(manager.get(pluginId)?.loaded).toBe(false);
    await vi.advanceTimersByTimeAsync(501);
    expect(manager.get(pluginId)?.loaded).toBe(true);
    expect(useAppStore.getState().config.pluginConfigs[0].enabled).toBe(true);
    expect(disable).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('counts concurrent starts as one failed attempt rather than prematurely disabling', async () => {
    vi.useFakeTimers();
    readAsset.mockRejectedValueOnce(new Error('busy'));
    const manager = new PluginHostManager();
    await Promise.all([manager.enable(pluginId), manager.enable(pluginId), manager.enable(pluginId)]);
    await vi.advanceTimersByTimeAsync(501);
    expect(manager.get(pluginId)?.loaded).toBe(true);
    expect(disable).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('turns repeated initial failure into a persisted disabled state, not an enabled idle plugin', async () => {
    vi.useFakeTimers();
    readAsset.mockRejectedValue(new Error('unreadable entry'));
    disable.mockResolvedValue({ revision: 1, pluginConfigs: [{ ...entry, enabled: false }] });
    const manager = new PluginHostManager();
    await manager.enable(pluginId);
    await vi.advanceTimersByTimeAsync(1600);
    expect(useAppStore.getState().config.pluginConfigs[0].enabled).toBe(false);
    expect(disable).toHaveBeenCalledWith(pluginId, false, 'install-a');
    expect(TestWorker.created).toEqual([]);
    manager.dispose();
  });

  it('cancels startup retry when the installation is disabled', async () => {
    vi.useFakeTimers();
    readAsset.mockRejectedValueOnce(new Error('busy'));
    const manager = new PluginHostManager();
    await manager.enable(pluginId);
    syncStorePluginConfigs({ revision: 1, pluginConfigs: [{ ...entry, enabled: false }] });
    manager.syncWithConfig();
    await vi.advanceTimersByTimeAsync(2000);
    expect(manager.get(pluginId)).toBeNull();
    expect(TestWorker.created).toEqual([]);
    manager.dispose();
  });

  it('replaces the old worker when code identity changes even if both states are enabled', async () => {
    const manager = new PluginHostManager();
    await manager.enable(pluginId);
    const old = TestWorker.created[0];
    syncStorePluginConfigs({ revision: 1, pluginConfigs: [{ ...entry, installGeneration: 'install-b' }] });
    manager.syncWithConfig();
    await vi.waitFor(() => expect(manager.get(pluginId)?.loaded).toBe(true));
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(manager.get(pluginId)?.installGeneration).toBe('install-b');
    manager.dispose();
  });

  it('does not disable replacement code from an old worker crash', async () => {
    const manager = new PluginHostManager();
    await manager.enable(pluginId);
    const old = TestWorker.created[0];
    syncStorePluginConfigs({ revision: 1, pluginConfigs: [{ ...entry, installGeneration: 'install-b' }] });
    manager.syncWithConfig();
    await vi.waitFor(() => expect(manager.get(pluginId)?.loaded).toBe(true));
    old.onerror?.({ message: 'late old crash' });
    expect(manager.get(pluginId)?.loaded).toBe(true);
    expect(disable).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('fails closed for a confirmed absent entry instead of running an empty script', async () => {
    readAsset.mockImplementation((_id: string, path: string) => Promise.resolve(path === 'manifest.json' ? JSON.stringify(manifest) : null));
    const session = new PluginSession(pluginId);
    await expect(session.start()).rejects.toThrow('entry missing');
    expect(TestWorker.created).toEqual([]);
  });

  it('manual refresh retries a stopped session after the bounded disable command failed', async () => {
    vi.useFakeTimers();
    readAsset.mockRejectedValue(new Error('busy'));
    disable.mockRejectedValue(new Error('temporary config write failure'));
    const manager = new PluginHostManager();
    await manager.enable(pluginId);
    await vi.advanceTimersByTimeAsync(1600);
    expect(manager.get(pluginId)?.loaded).toBe(false);
    readAsset.mockImplementation((_id: string, path: string) => Promise.resolve(path === 'manifest.json' ? JSON.stringify(manifest) : ''));
    manager.syncWithConfig(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get(pluginId)?.loaded).toBe(true);
    manager.dispose();
  });
});

describe('optional Worker and error grading', () => {
  const trustedView = {
    id: 'panel', label: 'Panel', entry: 'index.html', mode: 'trusted-web',
    styles: [], assets: [], modes: ['trx'], placements: ['workspace-tab'],
    input: 'none', portBinding: 'none', restoreOnStartup: false, worker: false,
  };
  const pureManifest = {
    id: pluginId, name: 'Pure HTML', entry: '', permissions: [],
    ui: { buttons: [], menuItems: [], views: [trustedView] },
  };

  it('never constructs a Worker for a manifest without an entry', async () => {
    readAsset.mockImplementationOnce(() => Promise.resolve(JSON.stringify(pureManifest)));
    const session = new PluginSession(pluginId);
    await session.start();
    expect(session.loaded).toBe(false);
    expect(TestWorker.created).toEqual([]);
    expect(readAsset).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty entry that still declares Worker-only UI', async () => {
    readAsset.mockImplementationOnce(() => Promise.resolve(JSON.stringify({
      ...pureManifest, ui: { buttons: [{ id: 'b', label: 'B' }], menuItems: [], views: [trustedView] },
    })));
    await expect(new PluginSession(pluginId).start()).rejects.toThrow('invalid plugin manifest');
    expect(TestWorker.created).toEqual([]);
  });

  it('keeps the worker and its in-memory state after post-ready runtime errors', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    worker.emit({ type: '__plugin_ready' });
    worker.onerror?.({ message: 'async boom' });
    worker.emit({ type: '__plugin_error', payload: { message: 'rejection boom' } });
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(session.loaded).toBe(true);
    expect(disable).not.toHaveBeenCalled();
    session.stop();
  });

  it('cancels owned HTTP requests on stop', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    session.stop();
    expect(cancelPluginHttp).toHaveBeenCalledWith(pluginId);
  });
});

describe('PluginHostManager reload', () => {
  it('restarts the current config with a strictly newer session epoch', async () => {
    const manager = new PluginHostManager();
    await manager.enable(pluginId);
    const oldSession = manager.get(pluginId)!;
    const oldEpoch = oldSession.epoch;
    const oldWorker = TestWorker.created[0];
    const reloading = manager.reload(pluginId);
    await vi.waitFor(() => expect(TestWorker.created).toHaveLength(2));
    TestWorker.created[1].emit({ type: '__plugin_ready' });
    await reloading;
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(manager.get(pluginId)!.epoch).toBeGreaterThan(oldEpoch);
    expect(manager.get(pluginId)!.loaded).toBe(true);
    manager.dispose();
  });

  it('rejects an explicit reload when startup fails before ready', async () => {
    const manager = new PluginHostManager();
    await manager.enable(pluginId);
    const reloading = manager.reload(pluginId);
    await vi.waitFor(() => expect(TestWorker.created).toHaveLength(2));
    TestWorker.created[1].onerror?.({ message: 'parse failed' });
    await expect(reloading).rejects.toThrow('parse failed');
    manager.dispose();
  });

  it('resolves a no-op reload for disabled plugins', async () => {
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry, enabled: false }] });
    const manager = new PluginHostManager();
    await expect(manager.reload(pluginId)).resolves.toBeUndefined();
    expect(manager.get(pluginId)).toBeNull();
    expect(TestWorker.created).toEqual([]);
  });

  it('resolves reload for pure-HTML plugins without constructing a Worker', async () => {
    readAsset.mockImplementation(() => Promise.resolve(JSON.stringify({
      id: pluginId, name: 'Pure HTML', entry: '', permissions: [],
      ui: {
        buttons: [], menuItems: [],
        views: [{
          id: 'panel', label: 'Panel', entry: 'index.html', mode: 'trusted-web',
          styles: [], assets: [], modes: ['trx'], placements: ['workspace-tab'],
          input: 'none', portBinding: 'none', restoreOnStartup: false, worker: false,
        }],
      },
    })));
    const manager = new PluginHostManager();
    await expect(manager.reload(pluginId)).resolves.toBeUndefined();
    expect(TestWorker.created).toEqual([]);
    manager.dispose();
  });
});

describe('PluginSession HTTP cancellation and binary view transport', () => {
  it('admits http.cancel even when every ordinary RPC slot is occupied', async () => {
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry, grantedPermissions: ['http:request'] }] });
    vi.mocked(executeHostApi).mockImplementation(() => new Promise(() => {}));
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    for (let seq = 1; seq <= MAX_PENDING_MESSAGES; seq++) worker.emit({ seq, op: 'ports.list' });
    worker.emit({ seq: 500, op: 'http.cancel', args: { requestId: 'request' } });
    expect(worker.postMessage).not.toHaveBeenCalledWith({ seq: 500, ok: false, error: 'plugin RPC capacity exceeded' });
    expect(vi.mocked(executeHostApi).mock.calls.some((call) => call[1] === 'http.cancel')).toBe(true);
    session.stop();
  });

  it('resolves postViewBinary only after the bridge ack and rejects on handler error', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    const payload = {
      instanceId: 'view-a', transferId: 't1', type: 'data',
      bytes: new Uint8Array([4, 5]), documentId: 'doc-a',
    };
    const pending = session.postViewBinary(payload);
    const sent = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; eventId?: number; payload?: unknown })
      .find((message) => message.type === 'view.binary')!;
    expect(sent.payload).toEqual(payload);
    worker.emit({ eventAck: sent.eventId, ok: true });
    await expect(pending).resolves.toBeUndefined();

    const failing = session.postViewBinary({ ...payload, transferId: 't2' });
    const binaryMessages = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; eventId?: number })
      .filter((message) => message.type === 'view.binary');
    const failedSent = binaryMessages[binaryMessages.length - 1];
    worker.emit({ eventAck: failedSent.eventId, ok: false, error: 'ui handler failed' });
    await expect(failing).rejects.toThrow('ui handler failed');
    session.stop();
  });

  it('rejects pending binary sends when the worker stops', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    const pending = session.postViewBinary({
      instanceId: 'view-a', transferId: 't1', type: 'data',
      bytes: new Uint8Array([1]), documentId: 'doc-a',
    });
    session.stop();
    await expect(pending).rejects.toThrow('plugin worker stopped');
  });
});

describe('PluginSession binary budgets and control admission', () => {
  it('keeps large binary data independent from ordinary control and RX byte budgets', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    const binary = session.postViewBinary({
      instanceId: 'view-a', transferId: 'large', type: 'data', documentId: 'doc-a',
      bytes: new Uint8Array(MAX_PENDING_EVENT_BYTES + 1),
    });
    const outcome = expect(binary).rejects.toThrow('plugin worker stopped');
    expect(session.post({ type: 'ui.buttonClick', payload: { id: 'button' } })).toBe(true);
    expect(session.post({ type: 'rx.bytes', payload: [{ bytes: new Uint8Array([1]) }] })).toBe(true);
    expect(worker.postMessage.mock.calls.some(([message]) => message.type === 'ui.buttonClick')).toBe(true);
    session.stop();
    await outcome;
  });

  it('bounds zero-byte binary transfers by the shared control slot cap', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    // Retire the initial lifecycle event so the entire cap is available.
    const worker = TestWorker.created[0];
    const lifecycle = worker.postMessage.mock.calls[0][0] as { eventId: number };
    worker.emit({ eventAck: lifecycle.eventId });
    const pending: Promise<void>[] = [];
    for (let index = 0; index < MAX_PENDING_CONTROL_MESSAGES; index++) {
      const binary = session.postViewBinary({
        instanceId: `view-${index}`, transferId: `t-${index}`, type: 'data', documentId: 'doc',
        bytes: new Uint8Array(0),
      });
      pending.push(expect(binary).rejects.toThrow('plugin worker stopped'));
    }
    await expect(session.postViewBinary({
      instanceId: 'extra', transferId: 'extra', type: 'data', documentId: 'doc', bytes: new Uint8Array(0),
    })).rejects.toThrow('control capacity');
    session.stop();
    await Promise.all(pending);
  });

  it('flushes older queued controls when document cancellation frees a binary slot', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    const binary = session.postViewBinary({
      instanceId: 'view-a', transferId: 't', type: 'data', documentId: 'old', bytes: new Uint8Array([1]),
    });
    const outcome = expect(binary).rejects.toThrow('view document changed');
    for (let index = 0; index < MAX_PENDING_CONTROL_MESSAGES - 2; index++) {
      expect(session.post({ type: 'ui.buttonClick', payload: { id: `fill-${index}` } })).toBe(true);
    }
    expect(session.post({ type: 'ui.buttonClick', payload: { id: 'queued' } })).toBe(true);
    expect(worker.postMessage.mock.calls.some(([message]) => message.payload?.id === 'queued')).toBe(false);
    session.cancelViewBinary('view-a', 'old');
    expect(worker.postMessage.mock.calls.some(([message]) => message.payload?.id === 'queued')).toBe(true);
    await outcome;
    session.stop();
  });
});

describe('PluginSession deadline and startup generation regressions', () => {
  it('retires unanswered binary RPC slots at the dedicated ten-minute deadline', async () => {
    vi.useFakeTimers();
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry, grantedPermissions: ['ui:view'] }] });
    vi.mocked(executeHostApi).mockImplementation(() => new Promise(() => {}));
    const session = new PluginSession(pluginId); await session.start(); const worker = TestWorker.created[0];
    worker.emit({ seq: 1, op: 'view.sendBinary', args: {} });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 1, ok: false, error: 'plugin RPC timed out' });
    vi.mocked(executeHostApi).mockResolvedValue('next'); worker.emit({ seq: 2, op: 'ports.list' });
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 2, ok: true, result: 'next' }); session.stop();
  });

  it('bounds the cancellation escape hatch even when ordinary RPC slots never settle', async () => {
    vi.useFakeTimers();
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry, grantedPermissions: ['http:request'] }] });
    vi.mocked(executeHostApi).mockImplementation(() => new Promise(() => {}));
    const session = new PluginSession(pluginId); await session.start(); const worker = TestWorker.created[0];
    for (let seq = 1; seq <= MAX_PENDING_MESSAGES; seq++) worker.emit({ seq, op: 'ports.list' });
    for (let index = 0; index < 64; index++) worker.emit({ seq: 1000 + index, op: 'http.cancel', args: { requestId: `cancel-${index}` } });
    worker.emit({ seq: 2000, op: 'http.cancel', args: { requestId: 'excess' } });
    expect(executeHostApi).toHaveBeenCalledTimes(MAX_PENDING_MESSAGES + 64);
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 2000, ok: false, error: 'plugin RPC capacity exceeded' }); session.stop();
  });

  it('expires a stalled Worker binary ACK, flushes controls, and ignores a late ACK', async () => {
    vi.useFakeTimers();
    const session = new PluginSession(pluginId); await session.start();
    const worker = TestWorker.created[0];
    const pending = session.postViewBinary({ instanceId: 'view-a', transferId: 'stalled', type: 'blob', documentId: 'doc-a', bytes: new Uint8Array([1]) });
    const outcome = expect(pending).rejects.toThrow('Worker binary ACK timed out');
    const sent = worker.postMessage.mock.calls.find(([message]) => message.type === 'view.binary')![0];
    for (let index = 0; index < MAX_PENDING_CONTROL_MESSAGES - 2; index++) session.post({ type: 'ui.buttonClick' });
    session.post({ type: 'ui.buttonClick', payload: { id: 'queued-after-binary' } });
    await vi.advanceTimersByTimeAsync(30_000); await outcome;
    expect(worker.postMessage.mock.calls.some(([message]) => message.payload?.id === 'queued-after-binary')).toBe(true);
    worker.emit({ eventAck: sent.eventId, ok: true });
    const queued = worker.postMessage.mock.calls.find(([message]) => message.payload?.id === 'queued-after-binary')![0];
    worker.emit({ eventAck: queued.eventId });
    const next = session.postViewBinary({ instanceId: 'view-a', transferId: 'next', type: 'blob', documentId: 'doc-a', bytes: new Uint8Array(0) });
    const rejected = expect(next).rejects.toThrow('plugin worker stopped'); session.stop(); await rejected;
  });

  it('does not let stale start I/O settle readiness of a replacement startup', async () => {
    const staleRead = deferredResult<string>(); readAsset.mockReturnValueOnce(staleRead.promise);
    const session = new PluginSession(pluginId);
    const stale = session.startReady(); const staleOutcome = expect(stale).rejects.toThrow('stopped');
    session.stop();
    const fresh = session.startReady(); let ready = false; void fresh.then(() => { ready = true; });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    staleRead.resolve(JSON.stringify(manifest)); await staleOutcome;
    expect(ready).toBe(false); expect(TestWorker.created).toHaveLength(1);
    TestWorker.created[0].emit({ type: '__plugin_ready' }); await fresh; expect(ready).toBe(true); session.stop();
  });

  it('detects post-ready silent Worker death through bounded health probes', async () => {
    vi.useFakeTimers();
    const session = new PluginSession(pluginId, true); await session.start();
    const worker = TestWorker.created[0]; worker.emit({ type: '__plugin_ready' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(worker.postMessage.mock.calls.filter(([message]) => message.type === '__plugin_health')).toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledOnce(); session.stop();
  });

  it('keeps a Worker alive when health probes are acknowledged', async () => {
    vi.useFakeTimers();
    const session = new PluginSession(pluginId, true); await session.start();
    const worker = TestWorker.created[0]; worker.emit({ type: '__plugin_ready' });
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(30_000);
      const probes = worker.postMessage.mock.calls.filter(([message]) => message.type === '__plugin_health');
      worker.emit({ eventAck: probes[probes.length - 1][0].eventId });
    }
    expect(worker.terminate).not.toHaveBeenCalled(); session.stop();
  });
});

describe('PluginSession document-scoped binary cancellation', () => {
  it('rejects only transfers of the replaced document and releases their slots', async () => {
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    const oldDocument = session.postViewBinary({
      instanceId: 'view-a', transferId: 'old', type: 'data',
      bytes: new Uint8Array([1]), documentId: 'doc-old',
    });
    const newDocument = session.postViewBinary({
      instanceId: 'view-a', transferId: 'new', type: 'data',
      bytes: new Uint8Array([2]), documentId: 'doc-new',
    });
    const sent = worker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; eventId?: number; payload?: { documentId?: string } })
      .filter((message) => message.type === 'view.binary');
    const oldEvent = sent.find((message) => message.payload?.documentId === 'doc-old')!;
    const newEvent = sent.find((message) => message.payload?.documentId === 'doc-new')!;
    session.cancelViewBinary('view-a', 'doc-old');
    await expect(oldDocument).rejects.toThrow('view document changed');
    worker.emit({ eventAck: oldEvent.eventId, ok: true });
    worker.emit({ eventAck: newEvent.eventId, ok: true });
    await expect(newDocument).resolves.toBeUndefined();
    session.stop();
  });
});
