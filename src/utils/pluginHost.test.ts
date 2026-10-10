import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import { PluginHostManager, PluginSession, MAX_PENDING_MESSAGES, MAX_PENDING_CONTROL_MESSAGES, MAX_PENDING_EVENT_BYTES } from './pluginHost';
import { executeHostApi } from './pluginHostApi';
import { resetPluginSnapshotForTest, syncStorePluginConfigs } from './pluginConfigSnapshot';

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

  it('keeps a deferred HTTP operation and a user-controlled file dialog alive', async () => {
    vi.useFakeTimers();
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...entry, grantedPermissions: ['http:request', 'fs:open'] }] });
    const http = deferredResult<unknown>();
    const dialog = deferredResult<unknown>();
    vi.mocked(executeHostApi).mockImplementation((_id, op) => op === 'http.request' ? http.promise : dialog.promise);
    const session = new PluginSession(pluginId);
    await session.start();
    const worker = TestWorker.created[0];
    worker.emit({ seq: 1, op: 'http.request', args: {} });
    worker.emit({ seq: 2, op: 'fs.openDialog', args: {} });
    await vi.advanceTimersByTimeAsync(15_500);
    http.resolve('http success');
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 1, ok: true, result: 'http success' });
    await vi.advanceTimersByTimeAsync(60_000);
    dialog.resolve('selected');
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledWith({ seq: 2, ok: true, result: 'selected' });
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
    await vi.advanceTimersByTimeAsync(101);
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
        await vi.advanceTimersByTimeAsync(101);
        expect(TestWorker.created).toHaveLength(i + 2);
      }
    }
    await Promise.resolve();
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
