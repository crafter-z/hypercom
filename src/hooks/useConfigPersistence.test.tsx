// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, SendCommandSet } from '../types';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService, storageService } from '../services/tauri';
import { useConfigPersistence } from './useConfigPersistence';

vi.mock('../services/tauri', () => ({
  configService: { getConfig: vi.fn(), setConfig: vi.fn() },
  storageService: { loadPortPresets: vi.fn() },
}));
vi.mock('../stores/useToastStore', () => ({ notifyError: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const rule = (name: string): SendCommandSet => ({
  id: 'rule-1', name, isLoop: false, loopDelay: 0, repeatCount: 0, commands: [],
});

let root: Root;
let container: HTMLDivElement;
let save!: (patch?: Partial<AppConfig>) => Promise<boolean>;
let backend: AppConfig;
let revision: number;
let writes: number[];

function Probe() {
  save = useConfigPersistence().saveConfig;
  return null;
}

beforeEach(async () => {
  backend = { ...useAppStore.getState().config, sendCommandSets: [rule('old')] };
  revision = 0;
  writes = [];
  useAppStore.setState({ config: { ...backend, revision: 0 } });
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
