// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UpdateDialog from './UpdateDialog';
import { useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { updateService } from '../../services/tauri';
import { relaunch } from '@tauri-apps/plugin-process';
import { commitUpdateMode, getCommittedUpdateMode, manualCheck, updateTiming } from '../../utils/updateService';
import type { UpdatePayload, UpdateProgressPayload } from '../../types';

const { saveConfig } = vi.hoisted(() => ({ saveConfig: vi.fn() }));
vi.mock('../../hooks', () => ({ useConfigPersistence: () => ({ saveConfig }) }));
vi.mock('../../services/tauri', () => ({ updateService: { checkForUpdate: vi.fn(), downloadAndInstall: vi.fn(), onProgress: vi.fn() } }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('../../stores/useToastStore', () => ({ notifyError: vi.fn(), notifySuccess: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { percent?: number }) => args?.percent === undefined ? key : `${key}:${args.percent}` }) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const testStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => testStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { testStorage.set(key, String(value)); },
  removeItem: (key: string) => { testStorage.delete(key); },
  clear: () => testStorage.clear(),
});

let container: HTMLDivElement;
let root: Root;
let progress: (payload: UpdateProgressPayload) => void;
const candidate: UpdatePayload = { version: '0.6.1', currentVersion: '0.5.2', date: null, notes: 'original notes', channel: 'stable' };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { platform: 'Win32' });
  localStorage.clear();
  useAppStore.getState().setConfig({ updateCheckMode: 'stable' });
  useSystemStore.getState().setUIState({ isUpdateInstalling: false, isUpdateOpen: false, updateCandidate: null });
  commitUpdateMode('stable');
  useSystemStore.getState().setUIState({ isUpdateOpen: true, updateCandidate: candidate });
  vi.mocked(updateService.onProgress).mockImplementation((callback) => { progress = callback; return () => {}; });
  vi.mocked(relaunch).mockResolvedValue(undefined);
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => { root.render(createElement(UpdateDialog)); });
});

afterEach(async () => { await act(async () => { root.unmount(); }); });

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
  await act(async () => { button.click(); });
}

describe('update dialog transactions', () => {
  it('retains committed mode and dialog after never-remind save failure, then permits a successful retry', async () => {
    saveConfig.mockResolvedValueOnce(false).mockImplementationOnce(async () => { commitUpdateMode('none', true); return true; });
    await click('update.never');
    expect(saveConfig).toHaveBeenCalledWith({ updateCheckMode: 'none' }, true);
    expect(getCommittedUpdateMode()).toBe('stable');
    expect(useAppStore.getState().config.updateCheckMode).toBe('stable');
    expect(container.querySelector('.update-version')?.textContent).toBe(candidate.version);
    expect(useSystemStore.getState().ui.isUpdateOpen).toBe(true);
    await click('update.never');
    expect(getCommittedUpdateMode()).toBe('none');
    expect(useAppStore.getState().config.updateCheckMode).toBe('none');
    expect(useSystemStore.getState().ui.isUpdateOpen).toBe(false);
  });

  it.each(['x', 'overlay', 'later'])('%s dismisses for seven days with an empty check ledger', async (action) => {
    const now = Date.now();
    if (action === 'later') await click('update.later');
    else await act(async () => {
      const target = action === 'x' ? container.querySelector<HTMLButtonElement>('button[title="hotkeys.close"]')! : container.querySelector<HTMLDivElement>('.modal-overlay')!;
      target.click();
    });
    expect(updateTiming.getLastCheckAt()).toBeNull();
    expect(updateTiming.getSnoozeUntil()).toBeGreaterThanOrEqual(now + 7 * 24 * 60 * 60 * 1000);
    expect(useSystemStore.getState().ui.isUpdateOpen).toBe(false);
  });

  it('keeps install parameters/display fixed, renders cumulative progress, blocks closing and recovers on failure', async () => {
    // ES2020 libs lack Promise.withResolvers; capture the rejection for a deterministic in-flight failure.
    let fail!: (reason: Error) => void;
    vi.mocked(updateService.downloadAndInstall).mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
    await click('update.installNow');
    expect(updateService.downloadAndInstall).toHaveBeenCalledWith('stable', '0.6.1');
    expect(useSystemStore.getState().ui.isUpdateInstalling).toBe(true);
    await act(async () => {
      progress({ downloaded: 30, total: 100, phase: 'download' });
      progress({ downloaded: 50, total: 100, phase: 'download' });
      expect((await manualCheck('preview')).discarded).toBe(true);
      commitUpdateMode('preview', true);
      container.querySelector<HTMLDivElement>('.modal-overlay')!.click();
    });
    expect(container.querySelector('.update-version')?.textContent).toBe('0.6.1');
    expect(container.querySelector('.update-download-progress')?.textContent).toBe('update.downloading:50');
    expect(useSystemStore.getState().ui.isUpdateOpen).toBe(true);
    expect(updateTiming.getSnoozeUntil()).toBeNull();
    await act(async () => { fail(new Error('signature failure')); });
    expect(useSystemStore.getState().ui.isUpdateInstalling).toBe(false);
    expect(container.querySelector('.update-download-progress')).toBeNull();
    expect(container.querySelector('.update-error')?.textContent).toBe('update.installFailed');
    expect(relaunch).not.toHaveBeenCalled();
    vi.mocked(updateService.downloadAndInstall).mockResolvedValueOnce(undefined);
    await click('update.installNow');
    expect(updateService.downloadAndInstall).toHaveBeenLastCalledWith('stable', '0.6.1');
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
