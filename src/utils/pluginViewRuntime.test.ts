import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executePluginViewApi, issuePluginActionToken, openPluginTabForUser, dismissPluginTab, getAvailablePluginViews, startPluginViewRuntime, selectSerialPluginView, getTabViewPreference, isRawSerialDisplay, getPluginViewState, markPluginViewWorkerReady, placePluginView, suppressPluginViews } from './pluginViewRuntime';
import { useAppStore, getActivePortId } from '../stores/useAppStore';
import { resetStoresForTests } from '../stores/resetStores';
import { resetPluginSnapshotForTest, syncPluginListSnapshot } from './pluginConfigSnapshot';
import type { PluginView } from '../types';
import { pluginViewService } from '../services/pluginView';
import { pluginHost, type PluginSession } from './pluginHost';
import { useSystemStore } from '../stores/useSystemStore';
import type { PluginNativeMessage } from '../types/pluginViews';
import { sendToPort } from '../hooks/useSerialSend';
import { VIEW_BINARY_CHUNK_BYTES, decodeViewBinaryBase64, encodeViewBinaryBase64 } from './pluginViewBinary';

vi.mock('../services/pluginView', () => ({ pluginViewService: { create: vi.fn(), destroy: vi.fn(), send: vi.fn(), update: vi.fn(), onMessage: vi.fn(async () => () => {}) } }));
vi.mock('../hooks/useSerialSend', () => ({ sendToPort: vi.fn() }));
const declaration = {
  id: 'table', label: 'Table', entry: 'ui.js', styles: [], assets: [],
  modes: ['trx'] as Array<'trx' | 'tty'>, input: 'bytes' as const,
  placements: ['serial-content', 'workspace-tab'] as Array<'serial-content' | 'workspace-tab'>,
  portBinding: 'required' as const, restoreOnStartup: true,
};
const plugin: PluginView = {
  id: 'com.example.views', installGeneration: 'install-a', enabled: true, dir: '',
  grantedPermissions: ['ui:view', 'ui:tabs', 'rx:bytes'], declaredPermissions: ['ui:view', 'ui:tabs', 'rx:bytes'], knownPermissions: ['ui:view', 'ui:tabs', 'rx:bytes'],
  manifestError: null, installedAt: null,
  manifest: { id: 'com.example.views', name: 'Views', version: '1.0.0', description: '', apiVersion: '1.0', entry: 'main.js', permissions: ['ui:view', 'ui:tabs', 'rx:bytes'], ui: { buttons: [], menuItems: [], views: [declaration, { ...declaration, id: 'tool', label: 'Tool', input: 'none', portBinding: 'none' }] } },
};

let clock = Date.UTC(2060, 0, 1);
beforeEach(() => {
  startPluginViewRuntime()();
  clock += 10000;
  vi.useFakeTimers(); vi.setSystemTime(clock);
  resetStoresForTests(); resetPluginSnapshotForTest();
  useAppStore.getState().setPorts([{ id: 'COM3', name: 'COM3', status: 'connected', type: 'real', isHidden: false, mode: 'trx' }, { id: 'COM4', name: 'COM4', status: 'connected', type: 'real', isHidden: false, mode: 'trx' }]);
  syncPluginListSnapshot({ revision: 0, plugins: [plugin], pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: plugin.grantedPermissions }] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function open(options: object) { return await executePluginViewApi(plugin.id, 'tabs.open', options, plugin.manifest) as { tabId: string; created: boolean }; }

describe('plugin workspace tab authority', () => {
  it('coalesces concurrent same-key requests but keeps separate bound ports and no serial side effects', async () => {
    const [a, b] = await Promise.all([open({ viewId: 'table', portId: 'COM3', instanceKey: 'live' }), open({ viewId: 'table', portId: 'COM3', instanceKey: 'live' })]);
    expect(a.tabId).toBe(b.tabId); expect([a.created, b.created]).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    const other = await open({ viewId: 'table', portId: 'COM4', instanceKey: 'live' });
    expect(other.tabId).not.toBe(a.tabId);
    expect(useAppStore.getState().tabs.map(tab => tab.kind)).toEqual(['plugin', 'plugin']);
    expect(useAppStore.getState().activeTabId).toBeNull();
  });
  it('reuses a Worker-keyed unbound tab when the host omits instanceKey', async () => {
    const worker = await open({ viewId: 'tool', instanceKey: 'worker-tool' });
    const host = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'tool' }, null);
    expect(host).toBe(worker.tabId);
    expect(useAppStore.getState().tabs.filter(tab => tab.kind === 'plugin')).toHaveLength(1);
  });

  it('reuses only the matching bound port and keeps explicit keys separate', async () => {
    const com3 = await open({ viewId: 'table', portId: 'COM3', instanceKey: 'worker-com3' });
    const reused = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'table' }, 'COM3');
    const com4 = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'table' }, 'COM4');
    const explicit = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'table' }, 'COM3', 'host-owned');
    expect(reused).toBe(com3.tabId);
    expect(com4).not.toBe(com3.tabId);
    expect(explicit).not.toBe(com3.tabId);
    expect(useAppStore.getState().tabs.filter(tab => tab.kind === 'plugin')).toHaveLength(3);
  });

  it('does not activate an existing host target after view permission revocation', async () => {
    const worker = await open({ viewId: 'tool', instanceKey: 'worker-tool' });
    useAppStore.getState().setConfig({ pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: ['ui:tabs', 'rx:bytes'] }] });
    expect(() => openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'tool' }, null)).toThrow('permission');
    expect(useAppStore.getState().activeTabId).toBeNull();
    expect(useAppStore.getState().tabs.some(tab => tab.id === worker.tabId)).toBe(true);
  });

  it('requires a scoped single-use action for foreground and rejects a replay', async () => {
    const serial = useAppStore.getState().openTab('COM4');
    const token = issuePluginActionToken(plugin.id, 'COM3', 'main');
    const opened = await open({ viewId: 'table', portId: 'COM3', activation: 'foreground', actionToken: token });
    expect(useAppStore.getState().activeTabId).toBe(opened.tabId);
    await expect(open({ viewId: 'table', portId: 'COM4', activation: 'foreground', actionToken: token })).rejects.toThrow('expired or scope');
    expect(useAppStore.getState().activeTabId).not.toBe(serial);
  });

  it('respects user dismissal until an explicit host open and leaves unbound tools without a send target', async () => {
    const opened = await open({ viewId: 'table', portId: 'COM3', instanceKey: 'dismiss-me' });
    dismissPluginTab(opened.tabId); useAppStore.getState().closeTab(opened.tabId);
    await expect(open({ viewId: 'table', portId: 'COM3', instanceKey: 'dismiss-me' })).rejects.toThrow('dismissed');
    vi.advanceTimersByTime(1000);
    const replacement = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'table' }, 'COM3', 'dismiss-me');
    expect(replacement).not.toBe(opened.tabId);
    vi.advanceTimersByTime(1000);
    openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'tool' }, null);
    expect(getActivePortId(useAppStore.getState())).toBeNull();
  });

  it('will not close another plugin tab or a pinned owned tab and cannot bypass revoked view grants', async () => {
    const opened = await open({ viewId: 'tool' });
    useAppStore.getState().pinTab(opened.tabId);
    await expect(executePluginViewApi(plugin.id, 'tabs.close', { tabId: opened.tabId }, plugin.manifest)).rejects.toThrow('pinned');
    const serial = useAppStore.getState().openTab('COM3');
    await expect(executePluginViewApi(plugin.id, 'tabs.close', { tabId: serial }, plugin.manifest)).rejects.toThrow('ownership');
    useAppStore.getState().setConfig({ pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: ['ui:tabs', 'rx:bytes'] }] });
    expect(getAvailablePluginViews('COM3', 'workspace-tab')).toEqual([]);
    await expect(open({ viewId: 'table', portId: 'COM3' })).rejects.toThrow('permission');
  });

  it('clears a replacement without resurrecting persisted startup preference', () => {
    const preference = { pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'table' };
    useAppStore.getState().setConfig({ portMeta: [{ portId: 'COM3', isHidden: false, displayView: preference }] });
    const id = useAppStore.getState().openTab('COM3');
    selectSerialPluginView(id, preference);
    const tab = useAppStore.getState().tabs.find(item => item.id === id)!;
    expect(getTabViewPreference(tab)).toEqual(preference);
    selectSerialPluginView(id, null);
    expect(getTabViewPreference(tab)).toBeNull();
    expect(isRawSerialDisplay(tab)).toBe(true);
    expect(useAppStore.getState().ports.find(port => port.id === 'COM3')?.displayView).toBeNull();
  });
});

describe('native view lifecycle handshakes', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  }

  async function settle() { for (let index = 0; index < 10; index++) await Promise.resolve(); }

  function enableWorker() {
    // Native runtime uses the browser timer surface; these cases otherwise run in node.
    vi.stubGlobal('window', globalThis);
    vi.spyOn(pluginHost, 'get').mockReturnValue({ loaded: true, epoch: 1, post: () => true } as unknown as PluginSession);
    useSystemStore.getState().setUIState({ configReady: true });
    vi.mocked(pluginViewService.create).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.update).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.send).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.destroy).mockResolvedValue(undefined);
  }

  it('requires independent trust before opening and retires a ready page when trust is revoked', async () => {
    enableWorker();
    const trusted: PluginView = { ...plugin, manifest: { ...plugin.manifest!, ui: { buttons: [], menuItems: [], views: [{ ...declaration, id: 'web', mode: 'trusted-web', entry: 'ui/index.html', input: 'none', portBinding: 'none', placements: ['workspace-tab'] }] } } };
    const config = { id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: plugin.grantedPermissions };
    syncPluginListSnapshot({ revision: 1, plugins: [trusted], pluginConfigs: [config] });
    const preference = { pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'web' };
    expect(getAvailablePluginViews(null, 'workspace-tab')).toEqual([]);
    expect(() => openPluginTabForUser(preference, null)).toThrow('explicit approval');
    useAppStore.getState().setConfig({ pluginConfigs: [{ ...config, trustedWebGranted: true }] });
    let nativeMessage!: (message: PluginNativeMessage) => void;
    vi.mocked(pluginViewService.onMessage).mockImplementationOnce(async callback => { nativeMessage = callback; return () => {}; });
    const stop = startPluginViewRuntime();
    try {
      const tabId = openPluginTabForUser(preference, null);
      await settle();
      const instanceId = getPluginViewState(tabId).instanceId!;
      nativeMessage({ instanceId, type: 'ready', documentId: 'doc-1' }); markPluginViewWorkerReady(plugin.id, instanceId);
      await settle();
      expect(getPluginViewState(tabId).status).toBe('ready');
      useAppStore.getState().setConfig({ pluginConfigs: [{ ...config, trustedWebGranted: false }] });
      await settle();
      expect(getPluginViewState(tabId).status).toBe('unavailable');
      expect(getAvailablePluginViews(null, 'workspace-tab')).toEqual([]);
      nativeMessage({ instanceId, type: 'ready', documentId: 'doc-1' });
      await settle();
      expect(getPluginViewState(tabId).status).toBe('unavailable');
    } finally { stop(); }
  });

  it('ignores native events from a stopped startup and releases both late listener registrations', async () => {
    enableWorker();
    const firstListener = deferred<() => void>();
    const secondListener = deferred<() => void>();
    let obsoleteMessage!: (message: PluginNativeMessage) => void;
    vi.mocked(pluginViewService.onMessage)
      .mockImplementationOnce(callback => { obsoleteMessage = callback; return firstListener.promise; })
      .mockImplementationOnce(() => secondListener.promise);
    const stopFirst = startPluginViewRuntime(); stopFirst();
    const stopSecond = startPluginViewRuntime();
    const unlistenFirst = vi.fn(); const unlistenSecond = vi.fn();
    try {
      firstListener.resolve(unlistenFirst); secondListener.resolve(unlistenSecond);
      const tabId = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'tool' }, null);
      await settle();
      expect(getPluginViewState(tabId).error).toBeNull();
      const instanceId = getPluginViewState(tabId).instanceId!;
      obsoleteMessage({ instanceId, type: 'error', error: 'obsolete native event' });
      await settle();
      expect(getPluginViewState(tabId).status).toBe('loading');
      expect(unlistenFirst).toHaveBeenCalledOnce();
      stopFirst();
      expect(getPluginViewState(tabId).instanceId).toBe(instanceId);
    } finally { stopSecond(); }
    expect(unlistenSecond).toHaveBeenCalledOnce();
  });

  it.each([false, true])('waits for actual destruction after a native hide fails (destroy rejection: %s)', async rejectDestroy => {
    enableWorker();
    let nativeMessage!: (message: PluginNativeMessage) => void;
    vi.mocked(pluginViewService.onMessage).mockImplementationOnce(async callback => { nativeMessage = callback; return () => {}; });
    const stop = startPluginViewRuntime();
    try {
      const tabId = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'tool' }, null);
      await settle();
      const instanceId = getPluginViewState(tabId).instanceId!;
      nativeMessage({ instanceId, type: 'ready', documentId: 'doc-1' }); markPluginViewWorkerReady(plugin.id, instanceId);
      await settle();
      placePluginView(tabId, { x: 0, y: 0, width: 100, height: 100, zoomPercent: 100 }, true);
      await settle();
      expect(getPluginViewState(tabId).error).toBeNull();
      expect(getPluginViewState(tabId).status).toBe('ready');
      const destroyed = deferred<void>();
      vi.mocked(pluginViewService.update).mockRejectedValueOnce(new Error('native hide failed'));
      vi.mocked(pluginViewService.destroy).mockReturnValueOnce(destroyed.promise);
      const ready = vi.fn();
      const suppression = suppressPluginViews(true);
      void suppression.then(ready, () => {});
      await settle();
      expect(getPluginViewState(tabId).status).toBe('unavailable');
      expect(ready).not.toHaveBeenCalled();
      if (rejectDestroy) {
        const outcome = expect(suppression).rejects.toThrow('native destroy failed');
        destroyed.reject(new Error('native destroy failed')); await outcome;
        expect(ready).not.toHaveBeenCalled();
      } else {
        destroyed.resolve(undefined); await suppression;
        expect(ready).toHaveBeenCalledOnce();
      }
      const updates = vi.mocked(pluginViewService.update).mock.calls.length;
      await suppressPluginViews(false); await settle();
      expect(pluginViewService.update).toHaveBeenCalledTimes(updates);
      expect(getPluginViewState(tabId).status).toBe('unavailable');
    } finally { await suppressPluginViews(false); stop(); }
  });
  it('forwards current occlusions and waits for destruction after clipping fails', async () => {
    enableWorker();
    let nativeMessage!: (message: PluginNativeMessage) => void;
    vi.mocked(pluginViewService.onMessage).mockImplementationOnce(async callback => { nativeMessage = callback; return () => {}; });
    const stop = startPluginViewRuntime();
    try {
      const tabId = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'tool' }, null);
      await settle();
      const instanceId = getPluginViewState(tabId).instanceId!;
      nativeMessage({ instanceId, type: 'ready', documentId: 'doc-1' }); markPluginViewWorkerReady(plugin.id, instanceId);
      await settle();
      placePluginView(tabId, { x: 0, y: 0, width: 100, height: 100, zoomPercent: 100 }, true);
      await settle();
      expect(vi.mocked(pluginViewService.update).mock.lastCall?.[4]).toEqual([]);
      const occlusions = [{ x: 4, y: 8, width: 20, height: 12 }];
      const destroyed = deferred<void>();
      vi.mocked(pluginViewService.update).mockRejectedValueOnce(new Error('native clipping failed'));
      vi.mocked(pluginViewService.destroy).mockReturnValueOnce(destroyed.promise);
      let settled = false;
      const suppression = suppressPluginViews(false, occlusions);
      void suppression.then(() => { settled = true; });
      await settle();
      expect(vi.mocked(pluginViewService.update).mock.lastCall?.[4]).toEqual(occlusions);
      expect(settled).toBe(false);
      destroyed.resolve(undefined);
      await suppression;
      expect(settled).toBe(true);
    } finally { await suppressPluginViews(false); stop(); }
  });

  it.each(['revoke', 'close', 'worker'])('blocks a queued bound send after %s before serial I/O', async transition => {
    enableWorker();
    const grants = [...plugin.grantedPermissions, 'serial:send'];
    useAppStore.getState().setConfig({ pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: grants }] });
    const stop = startPluginViewRuntime();
    try {
      const tabId = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'table' }, 'COM3');
      await settle();
      expect(getPluginViewState(tabId).error).toBeNull();
      const instanceId = getPluginViewState(tabId).instanceId!;
      const queued = deferred<void>();
      const send = vi.fn();
      vi.mocked(sendToPort).mockImplementationOnce(async (_port, _data, _hex, _ending, _silent, beforeSend) => {
        await queued.promise;
        beforeSend!(); send(); return 4;
      });
      const request = executePluginViewApi(plugin.id, 'view.sendSerial', { instanceId, data: 'PING' }, plugin.manifest);
      const rejected = expect(request).rejects.toThrow();
      if (transition === 'revoke') useAppStore.getState().setConfig({ pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: plugin.grantedPermissions }] });
      else if (transition === 'close') { dismissPluginTab(tabId); useAppStore.getState().closeTab(tabId); }
      else vi.mocked(pluginHost.get).mockReturnValue({ loaded: true, epoch: 2, post: () => true } as unknown as PluginSession);
      queued.resolve(undefined); await rejected;
      expect(send).not.toHaveBeenCalled();
      expect(sendToPort).toHaveBeenCalledWith('COM3', 'PING', false, 'None', true, expect.any(Function));
    } finally { stop(); }
  });
});

describe('independent pages, navigation documents and binary transport', () => {
  async function settle(count = 20) { for (let index = 0; index < count; index++) await Promise.resolve(); }
  function enableNative() {
    vi.clearAllMocks();
    vi.mocked(pluginViewService.create).mockReset();
    vi.mocked(pluginViewService.update).mockReset();
    vi.mocked(pluginViewService.send).mockReset();
    vi.mocked(pluginViewService.destroy).mockReset();
    vi.mocked(pluginViewService.onMessage).mockReset();
    vi.stubGlobal('window', globalThis);
    useSystemStore.getState().setUIState({ configReady: true });
    vi.mocked(pluginViewService.create).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.update).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.send).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.destroy).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.onMessage).mockResolvedValue(() => {});
  }
  function workerSession(postViewBinary?: (payload: { bytes: Uint8Array }) => Promise<void>) {
    const post = vi.fn(() => true);
    const session = { loaded: true, epoch: 1, post, postViewBinary } as unknown as PluginSession;
    vi.spyOn(pluginHost, 'get').mockReturnValue(session);
    return session as PluginSession & { postViewBinary?: typeof postViewBinary };
  }
  function sentMessage(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : null;
  }
  function isBinaryChunk(value: Record<string, unknown> | null): value is Record<string, unknown> & {
    type: 'binary-chunk'; documentId: string; transferId: string; seq: number; done: boolean; data: string;
  } {
    return !!value && value.type === 'binary-chunk' && typeof value.documentId === 'string'
      && typeof value.transferId === 'string' && typeof value.seq === 'number'
      && typeof value.done === 'boolean' && typeof value.data === 'string';
  }
  function initDocument(value: Record<string, unknown> | null): string | null {
    return value && value.type === 'init' && typeof value.documentId === 'string' ? value.documentId : null;
  }
  async function openNative(viewId: string, documentId = 'doc-1') {
    let nativeMessage!: (message: PluginNativeMessage) => void;
    vi.mocked(pluginViewService.onMessage).mockImplementationOnce(async callback => { nativeMessage = callback; return () => {}; });
    const stop = startPluginViewRuntime();
    const tabId = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId }, null);
    await settle();
    const instanceId = getPluginViewState(tabId).instanceId!;
    nativeMessage({ type: 'document', instanceId, documentId });
    nativeMessage({ type: 'ready', instanceId, documentId });
    await settle();
    return { tabId, instanceId, nativeMessage, stop };
  }

  it('runs a pure HTML page without a Worker and survives a Worker restart', async () => {
    enableNative();
    const pure: PluginView = { ...plugin, manifest: { ...plugin.manifest!, entry: '', ui: { buttons: [], menuItems: [], views: [{ ...declaration, id: 'web', entry: 'ui/index.html', mode: 'trusted-web', worker: false, input: 'none', portBinding: 'none', placements: ['workspace-tab'] }] } } };
    syncPluginListSnapshot({ revision: 2, plugins: [pure], pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: plugin.grantedPermissions, trustedWebGranted: true }] });
    const get = vi.spyOn(pluginHost, 'get');
    const { tabId, nativeMessage, stop } = await openNative('web');
    try {
      expect(get).not.toHaveBeenCalled();
      expect(pluginViewService.create).toHaveBeenCalledWith(expect.objectContaining({ workerEpoch: 0 }));
      expect(getPluginViewState(tabId).status).toBe('ready');
      useAppStore.getState().setConfig({ pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: plugin.grantedPermissions, trustedWebGranted: true }] });
      await settle();
      expect(getPluginViewState(tabId).status).toBe('ready');
      expect(pluginViewService.destroy).not.toHaveBeenCalled();
      nativeMessage({ type: 'ready', instanceId: getPluginViewState(tabId).instanceId!, documentId: 'doc-1' });
      await settle();
      expect(getPluginViewState(tabId).status).toBe('ready');
      vi.advanceTimersByTime(6000);
      expect(getPluginViewState(tabId).status).toBe('ready');
    } finally { stop(); }
  });

  it('reinitializes a replacement document and ignores its predecessor ACK', async () => {
    enableNative();
    workerSession();
    const { tabId, instanceId, nativeMessage, stop } = await openNative('tool');
    try {
      markPluginViewWorkerReady(plugin.id, instanceId);
      await settle();
      const initDocuments = () => vi.mocked(pluginViewService.send).mock.calls
        .map(call => initDocument(sentMessage(call[1])))
        .filter((documentId): documentId is string => documentId !== null);
      expect(initDocuments()).toEqual(['doc-1']);
      nativeMessage({ type: 'document', instanceId, documentId: 'doc-2' });
      await settle();
      expect(getPluginViewState(tabId).status).toBe('loading');
      nativeMessage({ type: 'ready', instanceId, documentId: 'doc-2' });
      await settle();
      expect(initDocuments()).toEqual(['doc-1', 'doc-2']);
      expect(getPluginViewState(tabId).status).toBe('ready');
      nativeMessage({ type: 'ack', instanceId, documentId: 'doc-1', revision: 1 });
      nativeMessage({ type: 'ready', instanceId, documentId: 'doc-1' });
      await settle();
      expect(getPluginViewState(tabId).status).toBe('ready');
    } finally { stop(); }
  });

  it('round-trips more than 256 KiB in both directions with exact bytes', async () => {
    enableNative();
    const delivered: Uint8Array[] = [];
    workerSession(async payload => { delivered.push(payload.bytes); });
    const { instanceId, nativeMessage, stop } = await openNative('tool');
    try {
      markPluginViewWorkerReady(plugin.id, instanceId);
      await settle();
      const payload = new Uint8Array(300 * 1024);
      for (let index = 0; index < payload.length; index++) payload[index] = (index * 31 + 7) & 0xff;
      const chunks: Array<{ documentId: string; transferId: string; seq: number; done: boolean; data: string }> = [];
      vi.mocked(pluginViewService.send).mockImplementation(async (_id, message) => {
        const value = sentMessage(message);
        if (!isBinaryChunk(value)) return;
        chunks.push(value);
        queueMicrotask(() => nativeMessage({ type: 'binary-ack', instanceId, documentId: value.documentId, transferId: value.transferId, seq: value.seq, done: value.done, ok: true }));
      });
      await executePluginViewApi(plugin.id, 'view.sendBinary', { instanceId, type: 'upload', bytes: payload }, plugin.manifest);
      expect(chunks.length).toBe(Math.ceil(payload.length / VIEW_BINARY_CHUNK_BYTES));
      const joined = new Uint8Array(payload.length);
      let offset = 0;
      for (const chunk of chunks) {
        expect(chunk.documentId).toBe('doc-1');
        const part = decodeViewBinaryBase64(chunk.data);
        joined.set(part, offset); offset += part.length;
      }
      expect(offset).toBe(payload.length);
      expect(joined).toEqual(payload);

      const transferId = 'upload-1';
      for (let seq = 0; seq * VIEW_BINARY_CHUNK_BYTES < payload.length; seq++) {
        const start = seq * VIEW_BINARY_CHUNK_BYTES;
        const end = Math.min(payload.length, start + VIEW_BINARY_CHUNK_BYTES);
        nativeMessage({ type: 'binary', instanceId, documentId: 'doc-1', transferId, transferType: 'download', seq, done: end >= payload.length, data: encodeViewBinaryBase64(payload.subarray(start, end)) });
        await settle();
      }
      expect(delivered[0]).toEqual(payload);
    } finally { stop(); }
  });

  it('rejects a queued binary send when navigation replaces its document', async () => {
    enableNative();
    workerSession();
    const { tabId, instanceId, nativeMessage, stop } = await openNative('tool');
    try {
      markPluginViewWorkerReady(plugin.id, instanceId);
      await settle();
      const payload = new Uint8Array(VIEW_BINARY_CHUNK_BYTES * 2);
      const request = executePluginViewApi(plugin.id, 'view.sendBinary', { instanceId, type: 'pending', bytes: payload }, plugin.manifest);
      const rejected = expect(request).rejects.toThrow('document changed');
      await settle();
      nativeMessage({ type: 'document', instanceId, documentId: 'doc-2' });
      await rejected;
      nativeMessage({ type: 'binary-ack', instanceId, documentId: 'doc-1', transferId: 'late', seq: 0, done: false, ok: true });
      await settle();
      expect(getPluginViewState(tabId).status).toBe('loading');
    } finally { stop(); }
  });
});
