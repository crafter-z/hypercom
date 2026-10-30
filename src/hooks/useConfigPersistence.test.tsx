// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, PortMetaEntry, SendCommandSet, SerialPort } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService, storageService } from '../services/tauri';
import { useConfigPersistence, saveCurrentPortMeta, saveCurrentPortGroups, resetOrdinaryConfigBaselineForTests, isOrdinaryConfigDirty, discardOrdinaryConfigDraft } from './useConfigPersistence';
import { getEntityEditorSnapshot, replaceEntityDraft, resetEntityEditorForTests } from '../utils/entityEditor';
import { commitUpdateMode, getCommittedUpdateMode, updateTiming } from '../utils/updateService';
import { resetStoresForTests } from '../stores/resetStores';

vi.mock('../services/tauri', () => ({
  configService: { getConfig: vi.fn(), setConfig: vi.fn() },
  storageService: { loadPortPresets: vi.fn() },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const testStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => testStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { testStorage.set(key, String(value)); },
  removeItem: (key: string) => { testStorage.delete(key); },
  clear: () => testStorage.clear(),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const rule = (name: string): SendCommandSet => ({
  id: 'rule-1', name, isLoop: false, loopDelay: 0, repeatCount: 0, commands: [],
});

const port = (id: string, extras: Partial<SerialPort> = {}): SerialPort => ({
  id, name: id, type: 'real', status: 'disconnected', isHidden: false, ...extras,
});

let root: Root;
let container: HTMLDivElement;
let save!: (patch?: Partial<AppConfig>, fieldOnly?: boolean) => Promise<boolean>;
let load!: () => Promise<void>;
let backend: AppConfig;
let revision: number;
let writes: number[];

function Probe() {
  ({ saveConfig: save, loadConfig: load } = useConfigPersistence());
  return null;
}

beforeEach(async () => {
  resetStoresForTests();
  commitUpdateMode('stable');
  resetEntityEditorForTests();
  resetOrdinaryConfigBaselineForTests();
  localStorage.clear();
  backend = { ...useAppStore.getState().config, updateCheckMode: 'stable', sendCommandSets: [rule('old')], portMeta: [] };
  revision = 0;
  writes = [];
  useAppStore.setState({ config: { ...backend, revision: 0 }, ports: [] });
  useRuleStore.getState().setSendCommandSets([rule('old')]);
  replaceEntityDraft('sendCommandSets', [rule('old')]);
  vi.mocked(configService.getConfig).mockImplementation(async () => ({ ...backend, revision }));
  vi.mocked(configService.setConfig).mockImplementation(async (candidate, restore, expected) => {
    expect(restore).toBe(false);
    writes.push(expected!);
    if (expected !== revision) return false;
    backend = candidate;
    revision++;
    return true;
  });
  vi.mocked(storageService.loadPortPresets).mockResolvedValue([]);
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => { root.render(createElement(Probe)); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.clearAllMocks();
});

// The CRUD save changes the backend revision and the authoritative live rule store.
function persistRule(name: string) {
  backend = { ...backend, sendCommandSets: [rule(name)] };
  revision++;
  useAppStore.getState().setConfig({ sendCommandSets: backend.sendCommandSets });
  useRuleStore.getState().setSendCommandSets([rule(name)]);
}

describe('whole-config saves versus independently persisted rules', () => {
  it('reads live rules only after the asynchronous preset load and retries if CRUD committed during it', async () => {
    const firstLoad = deferred<AppConfig['portPresets']>();
    vi.mocked(storageService.loadPortPresets)
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValue([]);
    const saving = save({ theme: 'light' });
    await vi.waitFor(() => expect(storageService.loadPortPresets).toHaveBeenCalledTimes(1));
    persistRule('saved while loading');
    firstLoad.resolve([]);
    expect(await saving).toBe(true);

    expect(writes).toEqual([0, 1]);
    expect(backend.sendCommandSets).toEqual([rule('saved while loading')]);
    expect(backend.theme).toBe('light');
  });

  it('rejects a snapshot overtaken between frontend invoke and backend commit, then recomposes', async () => {
    const firstInvoke = deferred<boolean>();
    vi.mocked(configService.setConfig).mockImplementationOnce(async (candidate, restore, expected) => {
      expect(restore).toBe(false);
      expect(expected).toBe(0);
      expect(candidate.sendCommandSets).toEqual([rule('old')]);
      writes.push(expected!);
      return firstInvoke.promise;
    });
    const saving = save({ theme: 'light' });
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledTimes(1));
    persistRule('saved while invoking');
    firstInvoke.resolve(false);
    expect(await saving).toBe(true);

    expect(writes).toEqual([0, 1]);
    expect(backend.sendCommandSets).toEqual([rule('saved while invoking')]);
    expect(backend.theme).toBe('light');
  });

  it('preserves an unsaved local draft for one ID while retaining backend CRUD for a different ID', async () => {
    replaceEntityDraft('sendCommandSets', [rule('local draft')]);
    backend = { ...backend, sendCommandSets: [rule('old'), { ...rule('remote'), id: 'rule-2' }] };
    revision++;
    await save({ theme: 'light' });

    expect(backend.sendCommandSets).toEqual([rule('local draft'), { ...rule('remote'), id: 'rule-2' }]);
    expect(backend.theme).toBe('light');
  });

  it('keeps a backend-only update to the same entity after an in-flight conflict', async () => {
    const firstInvoke = deferred<boolean>();
    vi.mocked(configService.setConfig).mockImplementationOnce(async () => firstInvoke.promise);
    const saving = save({ theme: 'light' });
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledTimes(1));
    backend = { ...backend, sendCommandSets: [rule('from another webview')] };
    revision++;
    firstInvoke.resolve(false);
    expect(await saving).toBe(true);

    expect(backend.sendCommandSets).toEqual([rule('from another webview')]);
    expect(backend.theme).toBe('light');
  });

  it('keeps backend-only changes made during the preset load while preserving local unsaved edits', async () => {
    const firstLoad = deferred<AppConfig['portPresets']>();
    vi.mocked(storageService.loadPortPresets)
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValue([]);
    const saving = save({ theme: 'light' });
    await vi.waitFor(() => expect(storageService.loadPortPresets).toHaveBeenCalledTimes(1));
    replaceEntityDraft('sendCommandSets', [rule('unsaved')]);
    backend = { ...backend, sendCommandSets: [rule('old'), { ...rule('remote'), id: 'rule-2' }] };
    revision++;
    firstLoad.resolve([]);
    expect(await saving).toBe(true);

    expect(writes).toEqual([0, 1]);
    expect(backend.sendCommandSets).toEqual([rule('unsaved'), { ...rule('remote'), id: 'rule-2' }]);
  });

  it('keeps presets loaded from the backend after a conflicting CRUD write', async () => {
    const firstInvoke = deferred<boolean>();
    vi.mocked(configService.setConfig).mockImplementationOnce(async () => firstInvoke.promise);
    const saving = save({ theme: 'light' });
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledTimes(1));
    const preset = { id: 'preset-1' } as AppConfig['portPresets'][number];
    backend = { ...backend, portPresets: [preset] };
    revision++;
    vi.mocked(storageService.loadPortPresets).mockResolvedValue([preset]);
    firstInvoke.resolve(false);
    expect(await saving).toBe(true);

    expect(backend.portPresets).toEqual([preset]);
    expect(backend.theme).toBe('light');
  });

  it('keeps later local edits across consecutive successful full saves', async () => {
    replaceEntityDraft('sendCommandSets', [rule('first edit')]);
    expect(await save()).toBe(true);
    replaceEntityDraft('sendCommandSets', [rule('later edit')]);
    expect(await save()).toBe(true);
    expect(backend.sendCommandSets).toEqual([rule('later edit')]);
  });

  it('adopts a remote winner and permits editing it after the successful save', async () => {
    backend = { ...backend, sendCommandSets: [rule('remote winner')] };
    revision++;
    expect(await save()).toBe(true);
    expect(useRuleStore.getState().sendCommandSets).toEqual([rule('remote winner')]);
    replaceEntityDraft('sendCommandSets', [rule('edited winner')]);
    expect(await save()).toBe(true);
    expect(backend.sendCommandSets).toEqual([rule('edited winner')]);
  });

  it('does not erase edits made while an accepted full save is in flight', async () => {
    const accepted = deferred<boolean>();
    vi.mocked(configService.setConfig).mockImplementationOnce(async (candidate) => {
      await accepted.promise;
      backend = candidate;
      revision++;
      return true;
    });
    replaceEntityDraft('sendCommandSets', [rule('saved draft')]);
    const saving = save();
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledTimes(1));
    replaceEntityDraft('sendCommandSets', [rule('edited during save')]);
    accepted.resolve(true);
    expect(await saving).toBe(true);
    expect(useRuleStore.getState().sendCommandSets).toEqual([rule('saved draft')]);
    expect(getEntityEditorSnapshot<SendCommandSet>('sendCommandSets').items).toEqual([rule('edited during save')]);
    expect(await save()).toBe(true);
    expect(backend.sendCommandSets).toEqual([rule('edited during save')]);
  });
  it('returns failure instead of confirming settings after repeated conflicts', async () => {
    const themeBefore = backend.theme;
    vi.mocked(configService.setConfig).mockResolvedValue(false);
    expect(await save({ theme: 'light' })).toBe(false);
    expect(configService.setConfig).toHaveBeenCalledTimes(5);
    expect(backend.theme).toBe(themeBefore);
  });
});

describe('committed update mode persistence', () => {
  it('does not mark equivalent backend properties as edited merely because serialization reordered them', async () => {
    backend = Object.fromEntries(Object.entries(backend).reverse()) as AppConfig;
    await act(async () => { await load(); });
    expect(isOrdinaryConfigDirty()).toBe(false);
    useAppStore.getState().setConfig({ terminalFontSize: backend.terminalFontSize + 1 });
    expect(isOrdinaryConfigDirty()).toBe(true);
  });

  it('loads persisted mode without discarding a snooze and ignores later draft edits', async () => {
    backend = { ...backend, updateCheckMode: 'preview' };
    updateTiming.setSnooze(7, 1750000000000);
    await act(async () => { await load(); });
    expect(getCommittedUpdateMode()).toBe('preview');
    expect(updateTiming.getSnoozeUntil()).toBe(1750000000000 + 7 * 24 * 60 * 60 * 1000);
    useAppStore.getState().setConfig({ updateCheckMode: 'none' });
    expect(getCommittedUpdateMode()).toBe('preview');
  });

  it('changes committed mode and resets timing only after successful save', async () => {
    useAppStore.getState().setConfig({ updateCheckMode: 'preview' });
    updateTiming.markCheckedAt(1750000000000);
    updateTiming.setSnooze(7, 1750000000000);
    vi.mocked(configService.setConfig).mockRejectedValueOnce(new Error('disk full'));
    expect(await save()).toBe(false);
    expect(getCommittedUpdateMode()).toBe('stable');
    expect(updateTiming.getLastCheckAt()).toBe(1750000000000);
    expect(updateTiming.getSnoozeUntil()).not.toBeNull();
    expect(await save()).toBe(true);
    expect(getCommittedUpdateMode()).toBe('preview');
    expect(updateTiming.getLastCheckAt()).toBeNull();
    expect(updateTiming.getSnoozeUntil()).toBeNull();
  });

  it('never-remind field-only CAS preserves persisted settings and rules instead of stale drafts', async () => {
    const persistedTheme = backend.theme;
    useAppStore.getState().setConfig({ theme: persistedTheme === 'light' ? 'dark' : 'light', updateCheckMode: 'preview' });
    replaceEntityDraft('sendCommandSets', [rule('unsaved draft')]);
    backend = { ...backend, sendCommandSets: [rule('already persisted elsewhere')] };
    revision++;
    expect(await save({ updateCheckMode: 'none' }, true)).toBe(true);
    expect(backend.updateCheckMode).toBe('none');
    expect(backend.theme).toBe(persistedTheme);
    expect(backend.sendCommandSets).toEqual([rule('already persisted elsewhere')]);
    expect(getCommittedUpdateMode()).toBe('none');
  });
});

describe('ordinary settings crash recovery', () => {
  const recoveryKey = 'hypercom.editor-recovery.config';
  it('restores only ordinary drafts against the latest baseline without committing update mode or backend settings', async () => {
    await load();
    const oldSize = backend.terminalFontSize;
    useAppStore.getState().setConfig({ terminalFontSize: oldSize + 2, updateCheckMode: 'none' });
    const recorded = JSON.parse(localStorage.getItem(recoveryKey)!);
    for (const forbidden of ['pluginConfigs', 'sendCommandSets', 'portGroups', 'portMeta', 'portPresets', 'revision']) {
      expect(recorded.payload.draft).not.toHaveProperty(forbidden);
      expect(recorded.payload.baseline).not.toHaveProperty(forbidden);
    }
    resetOrdinaryConfigBaselineForTests(true);
    backend = { ...backend, logDirectory: 'new backend logs', updateCheckMode: 'preview', revision: ++revision };
    await load();
    expect(useAppStore.getState().config.terminalFontSize).toBe(oldSize + 2);
    expect(useAppStore.getState().config.logDirectory).toBe('new backend logs');
    expect(useAppStore.getState().config.updateCheckMode).toBe('none');
    expect(getCommittedUpdateMode()).toBe('preview');
    expect(isOrdinaryConfigDirty()).toBe(true);
    expect(configService.setConfig).not.toHaveBeenCalled();
    expect(useRuleStore.getState().sendCommandSets).toEqual([rule('old')]);
  });

  it('retains conflicting recovered edits, blocks save, and discards to the new disk baseline', async () => {
    await load();
    useAppStore.getState().setConfig({ terminalFontSize: backend.terminalFontSize + 1 });
    resetOrdinaryConfigBaselineForTests(true);
    backend = { ...backend, terminalFontSize: backend.terminalFontSize + 3, revision: ++revision };
    await load();
    expect(useAppStore.getState().config.terminalFontSize).toBe(backend.terminalFontSize - 2);
    expect(isOrdinaryConfigDirty()).toBe(true);
    expect(await save()).toBe(false);
    expect(configService.setConfig).not.toHaveBeenCalled();
    discardOrdinaryConfigDraft();
    expect(useAppStore.getState().config.terminalFontSize).toBe(backend.terminalFontSize);
    expect(isOrdinaryConfigDirty()).toBe(false);
    expect(localStorage.getItem(recoveryKey)).toBeNull();
  });

  it('permits an explicit new edit after a recovered conflict without silently picking the expired draft', async () => {
    await load();
    useAppStore.getState().setConfig({ terminalFontSize: backend.terminalFontSize + 1 });
    resetOrdinaryConfigBaselineForTests(true);
    backend = { ...backend, terminalFontSize: backend.terminalFontSize + 3, revision: ++revision };
    await load();
    useAppStore.getState().setConfig({ terminalFontSize: backend.terminalFontSize + 1 });
    expect(await save()).toBe(true);
    expect(isOrdinaryConfigDirty()).toBe(false);
    expect(localStorage.getItem(recoveryKey)).toBeNull();
  });

  it('retains newer ordinary edits when an accepted save finishes, then clears recovery after their own save', async () => {
    await load();
    const firstSize = backend.terminalFontSize + 1;
    useAppStore.getState().setConfig({ terminalFontSize: firstSize });
    const accepted = deferred<boolean>();
    vi.mocked(configService.setConfig).mockImplementationOnce(async candidate => {
      await accepted.promise; backend = candidate; revision++; return true;
    });
    const saving = save();
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledOnce());
    useAppStore.getState().setConfig({ terminalFontSize: firstSize + 1 });
    accepted.resolve(true);
    expect(await saving).toBe(true);
    expect(JSON.parse(localStorage.getItem(recoveryKey)!).payload.draft.terminalFontSize).toBe(firstSize + 1);
    expect(isOrdinaryConfigDirty()).toBe(true);
    expect(await save()).toBe(true);
    expect(localStorage.getItem(recoveryKey)).toBeNull();
  });

  it('does not consume recorded recovery when backend loading fails', async () => {
    await load();
    useAppStore.getState().setConfig({ terminalFontSize: backend.terminalFontSize + 2 });
    const recorded = localStorage.getItem(recoveryKey);
    resetOrdinaryConfigBaselineForTests(true);
    vi.mocked(configService.getConfig).mockRejectedValueOnce(new Error('offline'));
    await load();
    expect(localStorage.getItem(recoveryKey)).toBe(recorded);
  });

  it.each(['{broken', JSON.stringify({ schema: 0, payload: {} }), JSON.stringify({ schema: 1, payload: {}, extra: true })])('ignores damaged/schema-mismatched recovery %s', async raw => {
    localStorage.setItem(recoveryKey, raw);
    await load();
    expect(isOrdinaryConfigDirty()).toBe(false);
    expect(configService.setConfig).not.toHaveBeenCalled();
  });

  it('rejects foreign fields in a well-formed recovery envelope rather than reviving permissions', async () => {
    await load();
    useAppStore.getState().setConfig({ terminalFontSize: backend.terminalFontSize + 2 });
    const recorded = JSON.parse(localStorage.getItem(recoveryKey)!);
    recorded.payload.draft.pluginConfigs = [{ id: 'malicious', permissions: ['all'] }];
    localStorage.setItem(recoveryKey, JSON.stringify(recorded));
    resetOrdinaryConfigBaselineForTests(true);
    await load();
    expect(useAppStore.getState().config.pluginConfigs).toEqual(backend.pluginConfigs);
    expect(useAppStore.getState().config.terminalFontSize).toBe(backend.terminalFontSize);
    expect(isOrdinaryConfigDirty()).toBe(false);
  });
});

describe('group persistence queue', () => {
  it('serializes with metadata saves and advances only committed baseline fields', async () => {
    const firstInvoke = deferred<boolean>();
    vi.mocked(configService.setConfig).mockImplementationOnce(async (candidate, _, expected) => {
      await firstInvoke.promise;
      expect(expected).toBe(revision);
      backend = candidate;
      revision++;
      return true;
    });
    useAppStore.getState().setConfig({ theme: 'light' });
    useAppStore.getState().setGroups([{ id: 'g1', name: 'new group', portIds: ['COM1'], isExpanded: true, order: 0 }]);
    const meta = saveCurrentPortMeta();
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledTimes(1));
    const groups = saveCurrentPortGroups();
    expect(configService.setConfig).toHaveBeenCalledTimes(1);
    firstInvoke.resolve(true);
    await Promise.all([meta, groups]);
    expect(writes).toEqual([1]);
    expect(backend.portGroups).toEqual(useAppStore.getState().groups);
    expect(useAppStore.getState().config.portGroups).toEqual(backend.portGroups);
    expect(useAppStore.getState().config.revision).toBe(2);
    expect(useAppStore.getState().config.theme).toBe('light');
    expect(backend.theme).toBe('dark');
  });

  it('preserves a group edit made while an earlier save is in flight', async () => {
    const accepted = deferred<boolean>();
    const old = [{ id: 'g1', name: 'saved', portIds: [], isExpanded: true, order: 0 }];
    useAppStore.getState().setGroups(old);
    vi.mocked(configService.setConfig).mockImplementationOnce(async candidate => {
      await accepted.promise;
      backend = candidate;
      revision++;
      return true;
    });
    const saving = saveCurrentPortGroups();
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledTimes(1));
    useAppStore.getState().updateGroup('g1', { name: 'later' });
    accepted.resolve(true);
    await saving;
    expect(useAppStore.getState().groups[0].name).toBe('later');
    expect(useAppStore.getState().config.portGroups).toEqual(old);
    await saveCurrentPortGroups();
    expect(backend.portGroups[0].name).toBe('later');
  });
});

describe('metadata persistence with absent ports', () => {
  const offline: PortMetaEntry = { portId: 'COM9', alias: 'offline', isHidden: true, mode: 'tty' };
  const online: PortMetaEntry = { portId: 'COM1', alias: 'online', isHidden: true, mode: 'tty' };

  it('preserves offline display preferences, updates online choices and persists clearing', async () => {
    const displayView = { pluginId: 'sensor', installGeneration: 'g1', viewId: 'table' };
    const offlineView = { portId: 'COM9', isHidden: false, displayView };
    backend = { ...backend, portMeta: [offlineView] };
    useAppStore.setState({ ports: [port('COM1', { displayView })] });
    await saveCurrentPortMeta();
    expect(backend.portMeta).toEqual([offlineView, { portId: 'COM1', isHidden: false, displayView }]);
    expect(await save()).toBe(true);
    expect(backend.portMeta).toEqual([offlineView, { portId: 'COM1', isHidden: false, displayView }]);
    useAppStore.getState().updatePort('COM1', { displayView: null });
    await saveCurrentPortMeta();
    expect(backend.portMeta).toEqual([offlineView]);
  });

  it('retains offline aliases, hidden and TTY when an online port changes via auto and full save', async () => {
    backend = { ...backend, portMeta: [offline, online] };
    useAppStore.setState({ ports: [port('COM1', { alias: 'changed', isHidden: true, mode: 'tty' })] });

    await saveCurrentPortMeta();
    expect(backend.portMeta).toEqual([offline, { ...online, alias: 'changed' }]);
    expect(useAppStore.getState().config.portMeta).toEqual(backend.portMeta);
    expect(useAppStore.getState().config.revision).toBe(revision);
    expect(await save({ theme: 'light' })).toBe(true);
    expect(backend.portMeta).toEqual([offline, { ...online, alias: 'changed' }]);
  });

  it('keeps startup metadata for an absent port during a full save without auto-save', async () => {
    backend = { ...backend, portMeta: [offline, online] };
    useAppStore.getState().setConfig({ portMeta: [offline, online] });
    useAppStore.setState({ ports: [port('COM1', { alias: 'changed', isHidden: true, mode: 'tty' })] });

    expect(await save({ theme: 'light' })).toBe(true);
    expect(backend.portMeta).toEqual([offline, { ...online, alias: 'changed' }]);
  });

  it('honors online clearing of alias, hide and TTY during a full save without auto-save', async () => {
    backend = { ...backend, portMeta: [offline, online] };
    useAppStore.getState().setConfig({ portMeta: [offline, online] });
    useAppStore.setState({ ports: [port('COM1', { mode: 'trx' })] });

    expect(await save({ theme: 'light' })).toBe(true);
    expect(backend.portMeta).toEqual([offline]);
  });

  it('removes all metadata for an explicitly reset online port without reviving old values', async () => {
    backend = { ...backend, portMeta: [offline, online] };
    useAppStore.setState({ ports: [port('COM1', { alias: 'online', isHidden: true, mode: 'tty' })] });
    useAppStore.getState().updatePort('COM1', { alias: undefined, isHidden: false, mode: 'trx' });

    await saveCurrentPortMeta();
    expect(backend.portMeta).toEqual([offline]);
    expect(await save({ theme: 'light' })).toBe(true);
    expect(backend.portMeta).toEqual([offline]);
  });

  it('serializes pending metadata writes so an earlier snapshot cannot revive a cleared alias', async () => {
    const firstInvoke = deferred<boolean>();
    backend = { ...backend, portMeta: [online] };
    useAppStore.setState({ ports: [port('COM1', { alias: 'online', isHidden: true, mode: 'tty' })] });
    vi.mocked(configService.setConfig).mockImplementationOnce(async (candidate, _, expected) => {
      const accepted = await firstInvoke.promise;
      if (accepted && expected === revision) {
        backend = candidate;
        revision++;
      }
      return accepted;
    });

    const oldWrite = saveCurrentPortMeta();
    await vi.waitFor(() => expect(configService.setConfig).toHaveBeenCalledTimes(1));
    useAppStore.getState().updatePort('COM1', { alias: undefined, isHidden: false, mode: 'trx' });
    const clear = saveCurrentPortMeta();
    expect(configService.setConfig).toHaveBeenCalledTimes(1);
    firstInvoke.resolve(true);
    await oldWrite;
    expect(backend.portMeta).toEqual([online]);
    await clear;
    expect(backend.portMeta).toEqual([]);
  });
});
