import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executePluginViewApi, issuePluginActionToken, openPluginTabForUser, dismissPluginTab, getAvailablePluginViews, startPluginViewRuntime, selectSerialPluginView, getTabViewPreference, isRawSerialDisplay, getPluginViewState, isRetriablePluginViewFailure, markPluginViewWorkerReady, placePluginView, suppressPluginViews, TRUSTED_READY_TIMEOUT_MS } from './pluginViewRuntime';
import { useAppStore, getActivePortId } from '../stores/useAppStore';
import { resetStoresForTests } from '../stores/resetStores';
import { resetPluginSnapshotForTest, syncPluginListSnapshot } from './pluginConfigSnapshot';
import type { PluginView } from '../types';
import { pluginViewService } from '../services/pluginView';
import { pluginHost, type PluginSession } from './pluginHost';
import { useSystemStore } from '../stores/useSystemStore';
import type { PluginNativeMessage } from '../types/pluginViews';
import { sendToPort } from '../hooks/useSerialSend';
import { timelineCoordinator } from './timeline/coordinator';
import * as configPersistence from '../hooks/useConfigPersistence';
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

  it('routes worker:false timeline independently and retires only its old document lane on navigation', async () => {
    enableNative();
    const pure: PluginView = { ...plugin, manifest: { ...plugin.manifest!, entry: '', ui: { buttons: [], menuItems: [], views: [{ ...declaration, id: 'web', entry: 'ui/index.html', mode: 'trusted-web', worker: false, input: 'none', portBinding: 'none', placements: ['workspace-tab'] }] } } };
    syncPluginListSnapshot({ revision: 2, plugins: [pure], pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: plugin.grantedPermissions, trustedWebGranted: true }] });
    const getWorker = vi.spyOn(pluginHost, 'get');
    const { tabId, instanceId, nativeMessage, stop } = await openNative('web');
    let groupId: string | undefined;
    try {
      placePluginView(tabId, { x: 0, y: 0, width: 600, height: 400, zoomPercent: 100 }, true); await settle();
      const generation = crypto.randomUUID();
      const registration = { action: 'register', capabilityGeneration: generation, registration: { version: 1, clock: { kind: 'custom', id: 'device-ms' }, capabilities: { preview: 'bounded', canDrive: true } } };
      nativeMessage({ type: 'timeline', instanceId, documentId: 'doc-1', payload: registration }); await settle();
      const participant = timelineCoordinator.participantForSlot(tabId)!;
      expect(participant).toMatchObject({ sourceKind: 'custom', availability: { visible: true } });
      groupId = timelineCoordinator.createGroup({ name: 'Web group', memberSlots: [tabId] });
      timelineCoordinator.seek(groupId, 5000); await vi.advanceTimersByTimeAsync(1); await settle();
      const seek = vi.mocked(pluginViewService.send).mock.calls.map(call => call[1]).find(message => message.type === 'timeline-seek')!;
      expect(seek).toMatchObject({ documentId: 'doc-1', timeline: { timeMs: 5000, capabilityGeneration: generation } });
      nativeMessage({ type: 'timeline', instanceId, documentId: 'doc-1', payload: { action: 'ack', capabilityGeneration: generation, requestId: seek.timeline!.requestId, result: { status: 'nearest', actualTimeMs: 4500 } } }); await settle();
      expect(timelineCoordinator.groupForSlot(tabId)?.members[0]).toMatchObject({ actualTimeMs: 4500, status: 'nearest' });
      timelineCoordinator.seek(groupId, 6000); await vi.advanceTimersByTimeAsync(1); await settle();
      await vi.advanceTimersByTimeAsync(2001); await settle();
      expect(getPluginViewState(tabId).status).toBe('ready');
      expect(pluginViewService.destroy).not.toHaveBeenCalled();
      nativeMessage({ type: 'document', instanceId, documentId: 'doc-2' }); await settle();
      expect(timelineCoordinator.participantForSlot(tabId)).toBeUndefined();
      nativeMessage({ type: 'timeline', instanceId, documentId: 'doc-1', payload: registration }); await settle();
      expect(timelineCoordinator.participantForSlot(tabId)).toBeUndefined();
      nativeMessage({ type: 'ready', instanceId, documentId: 'doc-2' }); await settle();
      expect(getPluginViewState(tabId).status).toBe('ready'); expect(getWorker).not.toHaveBeenCalled();
    } finally { if (groupId) timelineCoordinator.deleteGroup(groupId); stop(); }
  });

  it.each([false, true])('starts the trusted ready watchdog only after load, and clears it on ready: %s', async becomesReady => {
    enableNative();
    const pure: PluginView = { ...plugin, manifest: { ...plugin.manifest!, entry: '', ui: { buttons: [], menuItems: [], views: [{ ...declaration, id: 'web', entry: 'ui/index.html', mode: 'trusted-web', worker: false, input: 'none', portBinding: 'none', placements: ['workspace-tab'] }] } } };
    syncPluginListSnapshot({ revision: 2, plugins: [pure], pluginConfigs: [{ id: plugin.id, installGeneration: plugin.installGeneration, enabled: true, grantedPermissions: plugin.grantedPermissions, trustedWebGranted: true }] });
    let nativeMessage!: (message: PluginNativeMessage) => void;
    vi.mocked(pluginViewService.onMessage).mockImplementationOnce(async callback => { nativeMessage = callback; return () => {}; });
    const stop = startPluginViewRuntime();
    try {
      const tabId = openPluginTabForUser({ pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'web' }, null);
      await settle(); const instanceId = getPluginViewState(tabId).instanceId!;
      nativeMessage({ type: 'document', instanceId, documentId: 'doc-1' });
      await vi.advanceTimersByTimeAsync(120_000); expect(getPluginViewState(tabId).status).toBe('loading');
      nativeMessage({ type: 'navigation-complete', instanceId, documentId: 'doc-1' }); await settle();
      if (becomesReady) { nativeMessage({ type: 'ready', instanceId, documentId: 'doc-1' }); await settle(); }
      await vi.advanceTimersByTimeAsync(TRUSTED_READY_TIMEOUT_MS);
      expect(getPluginViewState(tabId).status).toBe(becomesReady ? 'ready' : 'unavailable');
      if (!becomesReady) expect(getPluginViewState(tabId).error).toContain('did not become ready');
    } finally { stop(); }
  });

  it('releases the plugin slot on raw fallback and stale plugin registration cannot reclaim it', async () => {
    enableNative(); workerSession();
    const tabId = useAppStore.getState().openTab('COM3');
    const preference = { pluginId: plugin.id, installGeneration: plugin.installGeneration, viewId: 'table' };
    selectSerialPluginView(tabId, preference);
    let nativeMessage!: (message: PluginNativeMessage) => void;
    vi.mocked(pluginViewService.onMessage).mockImplementationOnce(async callback => { nativeMessage = callback; return () => {}; });
    const stop = startPluginViewRuntime(); let disposeRaw: (() => void) | undefined;
    try {
      await settle(); const instanceId = getPluginViewState(tabId).instanceId!;
      markPluginViewWorkerReady(plugin.id, instanceId);
      nativeMessage({ type: 'document', instanceId, documentId: 'plugin-doc' });
      nativeMessage({ type: 'ready', instanceId, documentId: 'plugin-doc' }); await settle();
      placePluginView(tabId, { x: 0, y: 0, width: 600, height: 400, zoomPercent: 100 }, true);
      const registration = { action: 'register', capabilityGeneration: crypto.randomUUID(), registration: { version: 1, clock: { kind: 'bound-input' }, capabilities: { preview: 'bounded', canDrive: true } } };
      nativeMessage({ type: 'timeline', instanceId, documentId: 'plugin-doc', payload: registration }); await settle();
      expect(timelineCoordinator.participantForSlot(tabId)?.sourceId).toBe('serial:COM3');
      selectSerialPluginView(tabId, null);
      expect(timelineCoordinator.participantForSlot(tabId)).toBeUndefined();
      const raw = timelineCoordinator.registerParticipant({ participantId: 'raw-returned', slotId: tabId, sourceId: 'serial:COM3', sourceKind: 'live', generation: 1, sourceGeneration: 0, clockId: 'host-epoch-ms', capabilities: { preview: 'bounded', canDrive: true }, readAnchor: () => null, seek: () => ({ status: 'no-time', actualTimeMs: null }) });
      disposeRaw = raw.dispose;
      nativeMessage({ type: 'timeline', instanceId, documentId: 'plugin-doc', payload: registration }); await settle();
      expect(timelineCoordinator.participantForSlot(tabId)?.participantId).toBe('raw-returned');
    } finally { disposeRaw?.(); stop(); }
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

describe('remembered plugin pages survive a plugin reinstall', () => {
  // A reinstall keeps the plugin id but replaces the install identity, so every
  // remembered page descriptor (serial displayView / plugin workspace tab) would
  // otherwise be rejected forever: serial content falls back to raw and a tab
  // stays a dead placeholder whose retry can never succeed.
  const declared = plugin.manifest!.ui!.views;
  const page = (installGeneration: string) => ({ pluginId: plugin.id, installGeneration, viewId: 'table' });
  const installed = (installGeneration: string, views = declared): PluginView => ({
    ...plugin, installGeneration,
    manifest: { ...plugin.manifest!, ui: { buttons: [], menuItems: [], views } },
  });
  const entry = (installGeneration: string, grantedPermissions: string[] = plugin.grantedPermissions, enabled = true) =>
    ({ id: plugin.id, installGeneration, enabled, grantedPermissions });
  const pluginTab = () => useAppStore.getState().addPluginTab({
    kind: 'plugin', title: 'Table', pluginId: plugin.id, installGeneration: 'install-a',
    viewId: 'table', boundPortId: 'COM3', instanceKey: 'default', restoreOnStartup: true,
  });

  async function settle(count = 40) { for (let index = 0; index < count; index++) await Promise.resolve(); }

  function armNative(plugins: PluginView[], pluginConfigs: unknown[]) {
    vi.clearAllMocks();
    vi.stubGlobal('window', globalThis);
    const savePortMeta = vi.spyOn(configPersistence, 'saveCurrentPortMeta').mockResolvedValue(undefined);
    vi.mocked(pluginViewService.create).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.update).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.send).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.destroy).mockResolvedValue(undefined);
    vi.mocked(pluginViewService.onMessage).mockResolvedValue(() => {});
    vi.spyOn(pluginHost, 'get').mockReturnValue({ loaded: true, epoch: 1, post: () => true } as unknown as PluginSession);
    syncPluginListSnapshot({ revision: 1, plugins, pluginConfigs: pluginConfigs as never });
    useSystemStore.getState().setUIState({ configReady: true });
    return { savePortMeta };
  }

  it('re-points a remembered serial content page at the reinstalled installation', async () => {
    armNative([installed('install-b')], [entry('install-b')]);
    useAppStore.getState().updatePort('COM3', { displayView: page('install-a') });
    const tabId = useAppStore.getState().openTab('COM3');
    const stop = startPluginViewRuntime();
    try {
      await settle();
      const tab = useAppStore.getState().tabs.find(item => item.id === tabId)!;
      expect(useAppStore.getState().ports.find(port => port.id === 'COM3')?.displayView).toEqual(page('install-b'));
      expect(getTabViewPreference(tab)).toEqual(page('install-b'));
      expect(isRawSerialDisplay(tab)).toBe(false);
      expect(getPluginViewState(tabId).status).toBe('loading');
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });

  it('re-points a remembered serial page kept only for an absent port', async () => {
    const { savePortMeta } = armNative([installed('install-b')], [entry('install-b')]);
    useAppStore.getState().setConfig({ portMeta: [{ portId: 'COM9', isHidden: false, displayView: page('install-a') }] });
    // The tab outlives its port: only the persisted descriptor can carry the page.
    const tabId = 'cccccccc-3333-4333-8333-333333333333';
    useAppStore.getState().restoreSessionSnapshot({
      paneTree: { id: 'main', type: 'leaf', size: 1, tabIds: [tabId] },
      tabs: [{ kind: 'serial', id: tabId, portId: 'COM9', title: 'COM9', splitPaneId: 'main', isPinned: false }],
    });
    const stop = startPluginViewRuntime();
    try {
      await settle();
      expect(useAppStore.getState().config.portMeta.find(item => item.portId === 'COM9')?.displayView).toEqual(page('install-b'));
      expect(getTabViewPreference(useAppStore.getState().tabs.find(item => item.id === tabId)!)).toEqual(page('install-b'));
      expect(savePortMeta).toHaveBeenCalledWith(expect.objectContaining({
        entries: expect.arrayContaining([expect.objectContaining({ portId: 'COM9', displayView: page('install-b') })]),
      }));
    } finally { stop(); }
  });

  it('re-points a remembered plugin workspace tab at the reinstalled installation', async () => {
    armNative([installed('install-b')], [entry('install-b')]);
    const tabId = pluginTab();
    const stop = startPluginViewRuntime();
    try {
      await settle();
      const tab = useAppStore.getState().tabs.find(item => item.id === tabId);
      expect(tab?.kind === 'plugin' ? tab.installGeneration : null).toBe('install-b');
      expect(getPluginViewState(tabId).status).toBe('loading');
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });

  async function expectRefused(plugins: PluginView[], pluginConfigs: unknown[]): Promise<void> {
    armNative(plugins, pluginConfigs);
    const tabId = pluginTab();
    const stop = startPluginViewRuntime();
    try {
      await settle();
      const tab = useAppStore.getState().tabs.find(item => item.id === tabId);
      expect(tab?.kind === 'plugin' ? tab.installGeneration : null).toBe('install-a');
      expect(getPluginViewState(tabId).status).toBe('unavailable');
      expect(vi.mocked(pluginViewService.create)).not.toHaveBeenCalled();
    } finally { stop(); }
  }

  it('refuses to re-point at a disabled installation', async () => {
    await expectRefused([installed('install-b')], [entry('install-b', plugin.grantedPermissions, false)]);
  });

  it('refuses to re-point without ui:view', async () => {
    await expectRefused([installed('install-b')], [entry('install-b', plugin.grantedPermissions.filter(item => item !== 'ui:view'))]);
  });

  it('refuses to re-point without the view input permission', async () => {
    await expectRefused([installed('install-b')], [entry('install-b', plugin.grantedPermissions.filter(item => item !== 'rx:bytes'))]);
  });

  it('refuses to re-point when the current installation dropped the view', async () => {
    await expectRefused([installed('install-b', [{ ...declaration, id: 'other' }])], [entry('install-b')]);
  });

  it('refuses to re-point a trusted webpage without explicit consent', async () => {
    await expectRefused([installed('install-b', [{ ...declaration, mode: 'trusted-web' }])], [entry('install-b')]);
  });

  it('refuses to re-point an uninstalled plugin', async () => {
    await expectRefused([], []);
  });

  it('refuses to re-point when configuration survives but the installed code is gone', async () => {
    // Manifest list empty while the config entry still looks enabled/granted:
    // trusting the config alone would mount a page whose code no longer exists.
    await expectRefused([], [entry('install-b')]);
  });

  it('re-points a trusted webpage only once the current install holds web consent', async () => {
    const trusted = installed('install-b', [{ ...declaration, mode: 'trusted-web' }]);
    armNative([trusted], [{ ...entry('install-b'), trustedWebGranted: true }]);
    const tabId = pluginTab();
    const stop = startPluginViewRuntime();
    try {
      await settle();
      const tab = useAppStore.getState().tabs.find(item => item.id === tabId);
      expect(tab?.kind === 'plugin' ? tab.installGeneration : null).toBe('install-b');
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });

  it('re-points a line-consuming view through its terminal:read grant', async () => {
    const lines = installed('install-b', [{ ...declaration, input: 'lines' as const }]);
    armNative([lines], [entry('install-b', ['ui:view', 'terminal:read'])]);
    const tabId = pluginTab();
    const stop = startPluginViewRuntime();
    try {
      await settle();
      const tab = useAppStore.getState().tabs.find(item => item.id === tabId);
      expect(tab?.kind === 'plugin' ? tab.installGeneration : null).toBe('install-b');
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });

  it('refuses a line-consuming view without terminal:read', async () => {
    const lines = installed('install-b', [{ ...declaration, input: 'lines' as const }]);
    await expectRefused([lines], [entry('install-b', ['ui:view', 'rx:bytes'])]);
  });

  it('reports a permanent rejection once instead of every reconcile pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    armNative([installed('install-b')], [entry('install-b', plugin.grantedPermissions, false)]);
    const tabId = pluginTab();
    const stop = startPluginViewRuntime();
    try {
      await settle();
      const restored = () => warn.mock.calls.filter(([message]) => String(message).includes('remembered page not restored'));
      expect(restored()).toHaveLength(1);
      expect(String(restored()[0][0])).toContain('disabled');
      // Force further reconcile passes: the same descriptor must stay quiet.
      useAppStore.getState().setActiveTab(tabId);
      await settle();
      useAppStore.getState().setPorts([{ ...useAppStore.getState().ports[0] }]);
      await settle();
      expect(restored()).toHaveLength(1);
      expect(useAppStore.getState().tabs.find(item => item.id === tabId)?.kind === 'plugin'
        ? (useAppStore.getState().tabs.find(item => item.id === tabId) as { installGeneration: string }).installGeneration
        : null).toBe('install-a');
    } finally { stop(); }
  });

  it('classifies a rejected page so the surface can explain it and skip a futile retry', async () => {
    armNative([installed('install-b')], [entry('install-b', plugin.grantedPermissions, false)]);
    const tabId = pluginTab();
    const stop = startPluginViewRuntime();
    try {
      await settle();
      const state = getPluginViewState(tabId);
      expect(state.code).toBe('plugin-disabled');
      expect(isRetriablePluginViewFailure(state.code)).toBe(false);
    } finally { stop(); }
  });

  it('keeps retrying available only for causes the user or runtime can change', () => {
    // Capacity and worker/init failures can resolve on their own or after the user
    // closes a view; install, grant, consent, declaration and port-binding
    // rejections cannot — those get the settings entry instead of a retry.
    const retriable = ['worker-unavailable', 'worker-stopped', 'init-timeout', 'capacity', 'runtime'] as const;
    const structural = [
      'plugin-missing', 'plugin-disabled', 'install-changed', 'view-missing', 'grant-missing',
      'trusted-web', 'port-binding', 'port-unavailable', 'port-mode',
    ] as const;
    // Exhaustiveness guard: the two lists together must cover every code exactly once.
    expect([...retriable, ...structural].sort()).toEqual([
      'capacity', 'grant-missing', 'init-timeout', 'install-changed', 'plugin-disabled',
      'plugin-missing', 'port-binding', 'port-mode', 'port-unavailable', 'runtime',
      'trusted-web', 'view-missing', 'worker-stopped', 'worker-unavailable',
    ]);
    for (const code of retriable) expect([code, isRetriablePluginViewFailure(code)]).toEqual([code, true]);
    for (const code of structural) expect([code, isRetriablePluginViewFailure(code)]).toEqual([code, false]);
    expect(isRetriablePluginViewFailure(null)).toBe(false);
  });

  it('remounts a page that a structural failure retired, once the cause is fixed', async () => {
    // The discriminating case for the latch rule: the page had a live native
    // record, a structural rejection retired it, and the user fixes the cause.
    // A latched structural failure would keep `reconcile` from ever remounting.
    armNative([installed('install-b')], [entry('install-b')]);
    useAppStore.getState().updatePort('COM3', { displayView: page('install-b') });
    const tabId = useAppStore.getState().openTab('COM3');
    const stop = startPluginViewRuntime();
    try {
      await settle();
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(1);
      expect(getPluginViewState(tabId).status).toBe('loading');

      // Disabling the plugin retires the live page with a structural code.
      syncPluginListSnapshot({ revision: 2, plugins: [installed('install-b')], pluginConfigs: [entry('install-b', plugin.grantedPermissions, false)] as never });
      useAppStore.getState().setActiveTab(tabId);
      await settle();
      expect(getPluginViewState(tabId).code).toBe('plugin-disabled');

      // Re-enabling it must bring the page back without a retry or a code reload.
      syncPluginListSnapshot({ revision: 3, plugins: [installed('install-b')], pluginConfigs: [entry('install-b')] as never });
      useAppStore.getState().setActiveTab(tabId);
      await settle();
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(2);
      expect(getPluginViewState(tabId).status).toBe('loading');
      expect(getPluginViewState(tabId).code).toBeNull();
    } finally { stop(); }
  });

  it('recovers a page after the user fixes the rejected cause, instead of staying latched', async () => {
    // Regression: structural rejections used to latch `failures`, and the retry
    // button was the only way to clear it. Once the surface stopped offering a
    // retry for structural causes, a latched rejection made re-enabling the plugin
    // or re-granting the view unable to ever bring the page back.
    armNative([installed('install-b')], [entry('install-b', plugin.grantedPermissions, false)]);
    useAppStore.getState().updatePort('COM3', { displayView: page('install-a') });
    const tabId = useAppStore.getState().openTab('COM3');
    const stop = startPluginViewRuntime();
    try {
      await settle();
      expect(getPluginViewState(tabId).code).toBe('plugin-disabled');
      expect(vi.mocked(pluginViewService.create)).not.toHaveBeenCalled();

      // The user re-enables and re-grants the current install in plugin settings.
      syncPluginListSnapshot({ revision: 2, plugins: [installed('install-b')], pluginConfigs: [entry('install-b')] as never });
      useAppStore.getState().setActiveTab(tabId);
      await settle();

      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(1);
      expect(getPluginViewState(tabId).status).toBe('loading');
      expect(useAppStore.getState().ports.find(port => port.id === 'COM3')?.displayView).toEqual(page('install-b'));
    } finally { stop(); }
  });

  it('mounts a capacity-rejected page once a slot frees, without a manual retry', async () => {
    armNative([installed('install-b')], [entry('install-b')]);
    const openTool = (key: string) => useAppStore.getState().addPluginTab({
      kind: 'plugin', title: key, pluginId: plugin.id, installGeneration: 'install-b',
      viewId: 'tool', boundPortId: null, instanceKey: key, restoreOnStartup: true,
    });
    // Fill this plugin's instance budget (MAX_PER_PLUGIN), then add one more page.
    const tabIds = Array.from({ length: 8 }, (_, index) => openTool(`k${index}`));
    const overflow = openTool('overflow');
    const stop = startPluginViewRuntime();
    try {
      await settle(60);
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(8);
      expect(getPluginViewState(overflow).code).toBe('capacity');

      // Closing one page frees a slot; the rejected page must mount by itself.
      useAppStore.getState().closeTab(tabIds[0]);
      await settle(60);
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(9);
      expect(getPluginViewState(overflow).status).toBe('loading');
    } finally { stop(); }
  });

  it('converges without repeated native mounts or store writes', async () => {
    armNative([installed('install-b')], [entry('install-b')]);
    useAppStore.getState().updatePort('COM3', { displayView: page('install-a') });
    useAppStore.getState().openTab('COM3');
    const stop = startPluginViewRuntime();
    try {
      await settle();
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(1);
      let writes = 0;
      const unsubscribe = useAppStore.subscribe(() => { writes++; });
      await settle();
      unsubscribe();
      expect(writes).toBe(0);
      expect(vi.mocked(pluginViewService.create)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(pluginViewService.destroy)).not.toHaveBeenCalled();
    } finally { stop(); }
  });
});
