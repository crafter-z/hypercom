// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayTabItem } from '../../types';
import { useAppStore } from '../../stores/useAppStore';
import { resetStoresForTests } from '../../stores/resetStores';
import { restoreReplayDescriptions, closeReplayTab } from '../../utils/replay/replayRuntime';

const startImport = vi.fn(async () => {});
vi.mock('./hooks/useLogReplay', () => ({
  useLogReplay: () => ({
    picked: null,
    isImporting: false,
    isPicking: false,
    startImport,
    confirmImport: vi.fn(async () => {}),
    cancelImport: vi.fn(),
  }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { default: ReplayView } = await import('./ReplayView');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetStoresForTests();
  startImport.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('ReplayView missing/restore recovery card', () => {
  it('shows expected filenames when session description exists and recovery actions when missing', async () => {
    const tabId = useAppStore.getState().addReplayTab({
      sessionId: 'sess-restore',
      trackId: 'track-1',
      title: 'boot.log',
    });
    const tab = useAppStore.getState().tabs.find(t => t.id === tabId) as ReplayTabItem;
    restoreReplayDescriptions([{
      id: 'sess-restore',
      name: 'boot.log',
      tracks: [{
        id: 'track-1',
        title: 'boot.log',
        files: [{ name: 'boot.log', path: 'C:/logs/boot.log', size: 4096, fingerprint: 'a'.repeat(64) }],
        options: { encoding: 'UTF-8', format: 'text', timezoneOffsetMinutes: 480 },
      }],
    }]);

    await act(async () => root.render(<ReplayView tab={tab} />));
    expect(host.querySelector('.replay-missing-file-name')?.textContent).toBe('boot.log');
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.some(b => b.textContent === 'replay.reselectFiles')).toBe(true);
    expect(buttons.some(b => b.textContent === 'replay.closeTab')).toBe(true);
    await act(async () => buttons.find(b => b.textContent === 'replay.reselectFiles')!.click());
    expect(startImport).toHaveBeenCalledTimes(1);

    await act(async () => {
      closeReplayTab(tab.id);
      useAppStore.getState().closeTab(tab.id);
    });
  });

  it('offers Import New Log and Close Tab recovery buttons when session does not exist', async () => {
    const tabId = useAppStore.getState().addReplayTab({
      sessionId: 'missing-session',
      trackId: 'track-x',
      title: 'orphan.log',
    });
    const tab = useAppStore.getState().tabs.find(t => t.id === tabId) as ReplayTabItem;

    await act(async () => root.render(<ReplayView tab={tab} />));
    const importBtn = [...host.querySelectorAll('button')].find(b => b.textContent === 'replay.importNew') as HTMLButtonElement;
    const closeBtn = [...host.querySelectorAll('button')].find(b => b.textContent === 'replay.closeTab') as HTMLButtonElement;
    expect(importBtn).toBeTruthy();
    expect(importBtn.disabled).toBe(false);
    expect(closeBtn).toBeTruthy();
    await act(async () => closeBtn.click());
    expect(useAppStore.getState().tabs.find(t => t.id === tabId)).toBeUndefined();
  });
});
