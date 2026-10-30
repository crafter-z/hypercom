// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import { resetStoresForTests } from '../stores/resetStores';
import type { SerialPort } from '../types';
import { useAppInit } from './useAppInit';
import { saveCurrentPortMeta, saveCurrentPortGroups } from './useConfigPersistence';

const mocks = vi.hoisted(() => ({ loadConfig: vi.fn(async () => {}), refreshPorts: vi.fn(async () => true) }));
vi.mock('./useSerialPorts', () => ({ useSerialPorts: () => ({ refreshPorts: mocks.refreshPorts }) }));
vi.mock('./useConfigPersistence', async importOriginal => {
  const original = await importOriginal<typeof import('./useConfigPersistence')>();
  return {
    ...original,
    useConfigPersistence: () => ({ loadConfig: mocks.loadConfig }),
    saveCurrentPortMeta: vi.fn(async () => {}),
    saveCurrentPortGroups: vi.fn(async () => {}),
  };
});
vi.mock('../services/tauri', () => ({ configService: { getSessionSnapshot: vi.fn(async () => null) } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
const port = (alias?: string): SerialPort => ({ id: 'COM1', name: 'COM1', type: 'real', status: 'disconnected', isHidden: false, alias });
function Probe() { useAppInit(); return null; }

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetStoresForTests();
  useAppStore.getState().setConfig({ restoreSession: false });
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(createElement(Probe)); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.useRealTimers();
});

describe('debounced metadata capture', () => {
  it('keeps the last edit when the port disappears before the debounce fires', async () => {
    useAppStore.getState().setPorts([port('edited before unplug')]);
    useAppStore.getState().setPorts([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(saveCurrentPortMeta).toHaveBeenCalledExactlyOnceWith({
      entries: [{ portId: 'COM1', alias: 'edited before unplug', isHidden: false, mode: undefined, displayView: undefined }],
      presentIds: ['COM1'],
    });
  });

  it('restores an edited alias on a replug before the debounce commits', async () => {
    useAppStore.getState().setPorts([port('latest edit')]);
    useAppStore.getState().setPorts([]);
    // Enumeration still sees the old committed baseline until the save settles.
    useAppStore.getState().setPorts([port('old persisted alias')]);
    expect(useAppStore.getState().ports[0].alias).toBe('latest edit');
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(vi.mocked(saveCurrentPortMeta).mock.calls[0][0]?.entries[0].alias).toBe('latest edit');
  });

  it('keeps explicit clearing across a replug before the debounce commits', async () => {
    useAppStore.getState().setPorts([port('old persisted alias')]);
    useAppStore.getState().updatePort('COM1', { alias: undefined });
    useAppStore.getState().setPorts([]);
    useAppStore.getState().setPorts([port('old persisted alias')]);
    expect(useAppStore.getState().ports[0].alias).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(saveCurrentPortMeta).toHaveBeenCalledExactlyOnceWith({ entries: [], presentIds: ['COM1'] });
  });

  it('does not revive an alias explicitly cleared before the port disappears', async () => {
    useAppStore.getState().setPorts([port('old')]);
    useAppStore.getState().updatePort('COM1', { alias: undefined });
    useAppStore.getState().setPorts([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(saveCurrentPortMeta).toHaveBeenCalledExactlyOnceWith({ entries: [], presentIds: ['COM1'] });
  });

  it('routes group auto-save through the shared persistence helper', async () => {
    useAppStore.getState().setGroups([{ id: 'g1', name: 'edited', portIds: [], isExpanded: true, order: 0 }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(saveCurrentPortGroups).toHaveBeenCalledTimes(1);
  });
});
