// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConfigModal from './ConfigModal';
import { useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { resetStoresForTests } from '../../stores/resetStores';
import { configService, storageService, popoutEventService } from '../../services/tauri';
import { applyUiScale } from '../../utils/uiScale';
import type { AppConfig } from '../../types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));
vi.mock('../../utils/uiScale', () => ({ applyUiScale: vi.fn(async () => {}) }));
vi.mock('../../services/tauri', () => ({
  configService: { getConfig: vi.fn(), setConfig: vi.fn(), getConfigPath: vi.fn(async () => 'config.json') },
  storageService: { loadPortPresets: vi.fn(async () => []) },
  popoutEventService: { emitUiScaleChanged: vi.fn(async () => {}) },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ES2020's Promise API does not provide withResolvers.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let root: Root;
let container: HTMLDivElement;
let backend: AppConfig;
let revision: number;
beforeEach(async () => {
  vi.clearAllMocks();
  resetStoresForTests();
  revision = 0;
  backend = { ...useAppStore.getState().config, revision, updateCheckMode: 'none' };
  useAppStore.getState().setConfig(backend);
  useSystemStore.getState().setUIState({ isConfigOpen: true, configActiveTab: 'general' });
  vi.mocked(configService.getConfig).mockImplementation(async () => ({ ...backend, revision }));
  vi.mocked(configService.setConfig).mockImplementation(async candidate => { backend = candidate; revision++; return true; });
  vi.mocked(storageService.loadPortPresets).mockResolvedValue([]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(ConfigModal)); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function startHeldSave() {
  const held = deferred<boolean>();
  vi.mocked(configService.setConfig).mockImplementationOnce(async candidate => {
    const accepted = await held.promise;
    if (accepted) { backend = candidate; revision++; }
    return accepted;
  });
  await act(async () => { container.querySelector<HTMLButtonElement>('.modal-content-footer .btn-primary')!.click(); });
  expect(configService.setConfig).toHaveBeenCalledTimes(1);
  return held;
}

describe('configuration save ownership', () => {
  it('freezes edits, navigation, duplicate saves, cancel, close, overlay and Escape until commit', async () => {
    await act(async () => { useAppStore.getState().setConfig({ uiScalePercent: 125 }); });
    const held = await startHeldSave();
    const draft = useAppStore.getState().config;
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      container.querySelector<HTMLDivElement>('.modal-nav-item:nth-child(2)')!.click();
      container.querySelector<HTMLButtonElement>('.modal-content-header button')!.click();
      container.querySelector<HTMLButtonElement>('.modal-content-footer .btn')!.click();
      container.querySelector<HTMLButtonElement>('.modal-content-footer .btn-primary')!.click();
      container.querySelector<HTMLDivElement>('.modal-overlay')!.click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useAppStore.getState().config).toBe(draft);
    expect(useSystemStore.getState().ui).toMatchObject({ isConfigOpen: true, configActiveTab: 'general' });
    expect(configService.setConfig).toHaveBeenCalledTimes(1);
    await act(async () => { held.resolve(true); });
    expect(backend.uiScalePercent).toBe(125);
    expect(applyUiScale).toHaveBeenCalledWith(125);
    expect(popoutEventService.emitUiScaleChanged).toHaveBeenCalledWith(125);
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(false);
  });

  it('keeps an external newer draft open rather than claiming the old in-flight snapshot saved it', async () => {
    const held = await startHeldSave();
    await act(async () => { useAppStore.getState().setConfig({ uiScalePercent: 150 }); held.resolve(true); });
    expect(useAppStore.getState().config.uiScalePercent).toBe(150);
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(true);
    expect(applyUiScale).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('.modal-content-footer .btn-primary')!.click(); });
    expect(backend.uiScalePercent).toBe(150);
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(false);
  });

  it('cannot close a newly opened settings session after the previous save completes', async () => {
    const held = await startHeldSave();
    await act(async () => {
      useSystemStore.getState().toggleConfigModal(false);
      useAppStore.getState().setConfig({ uiScalePercent: 150 });
      useSystemStore.getState().toggleConfigModal(true);
    });
    await act(async () => { held.resolve(true); });
    expect(useSystemStore.getState().ui.isConfigOpen).toBe(true);
    expect(applyUiScale).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('.modal-content-footer .btn-primary')!.disabled).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>('.modal-content-footer .btn')!.click(); });
    expect(useAppStore.getState().config.uiScalePercent).toBe(150);
  });
});
