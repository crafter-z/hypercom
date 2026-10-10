// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, PortMetaEntry, SendCommandSet, SerialPort } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService, storageService } from '../services/tauri';
import { useConfigPersistence, saveCurrentPortMeta } from './useConfigPersistence';
import { commitUpdateMode, getCommittedUpdateMode, updateTiming } from '../utils/updateService';

vi.mock('../services/tauri', () => ({
  configService: { getConfig: vi.fn(), setConfig: vi.fn() },
  storageService: { loadPortPresets: vi.fn() },
}));
vi.mock('../stores/useToastStore', () => ({ notifyError: vi.fn() }));

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
  localStorage.clear();
  commitUpdateMode('stable');
  backend = { ...useAppStore.getState().config, updateCheckMode: 'stable', sendCommandSets: [rule('old')], portMeta: [] };
  revision = 0;
  writes = [];
  useAppStore.setState({ config: { ...backend, revision: 0 }, ports: [] });
  useRuleStore.getState().setSendCommandSets([rule('old')]);
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
    useRuleStore.getState().setSendCommandSets([rule('local draft')]);
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
    useRuleStore.getState().setSendCommandSets([rule('unsaved')]);
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

  it('returns failure instead of confirming settings after repeated conflicts', async () => {
    vi.mocked(configService.setConfig).mockResolvedValue(false);
    expect(await save({ theme: 'light' })).toBe(false);
    expect(configService.setConfig).toHaveBeenCalledTimes(5);
    expect(backend.theme).not.toBe('light');
  });
});

describe('committed update mode persistence', () => {
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
    useRuleStore.getState().setSendCommandSets([rule('unsaved draft')]);
    backend = { ...backend, sendCommandSets: [rule('already persisted elsewhere')] };
    revision++;
    expect(await save({ updateCheckMode: 'none' }, true)).toBe(true);
    expect(backend.updateCheckMode).toBe('none');
    expect(backend.theme).toBe(persistedTheme);
    expect(backend.sendCommandSets).toEqual([rule('already persisted elsewhere')]);
    expect(getCommittedUpdateMode()).toBe('none');
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
