// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PluginDirectoryInstallRequest } from '../../../services/plugin';
import i18n from '../../../i18n';
import PluginSettings from './PluginSettings';

const mocks = vi.hoisted(() => ({ open: vi.fn(), install: vi.fn(), cancel: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../../../services/plugin', () => ({ pluginService: { cancelPluginInstall: mocks.cancel } }));
vi.mock('../../../hooks/usePlugins', () => ({
  usePluginList: () => ({ plugins: [], loading: false, installPlugin: mocks.install }),
  usePluginMarketplace: () => ({ index: null, updates: [], loading: false, error: null }),
  isPluginReplaceConfirmationError: () => false,
}));
vi.mock('../../../hooks/useConfigPersistence', () => ({ useConfigPersistence: () => ({ saveConfig: vi.fn() }) }));
vi.mock('../../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let request: PluginDirectoryInstallRequest;
let finish: (result: null) => void;

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(element => element.textContent?.trim() === i18n.t(label));
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue('C:/source/plugin');
  mocks.install.mockImplementation((_path, _replace, _generation, progress: PluginDirectoryInstallRequest) => {
    request = progress;
    return new Promise(resolve => { finish = resolve; });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(PluginSettings)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('reports measured staged bytes and waits for preparation cleanup after cancellation', async () => {
  await click('plugins.installDirectory');
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  expect(mocks.install).toHaveBeenCalledWith('C:/source/plugin', undefined, undefined,
    { requestId: expect.any(String), onProgress: expect.any(Function) });
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector('button')!.disabled).toBe(true); // native task not registered yet
  await act(async () => request.onProgress({ phase: 'copying', copiedBytes: 512, totalBytes: 70_000_000, availableBytes: 90_000_000 }));
  expect(dialog.querySelector('progress')?.value).toBe(512);
  expect(dialog.querySelector('progress')?.max).toBe(70_000_000);
  expect(dialog.textContent).toContain(i18n.t('plugins.installProgress.space', { available: (90_000_000).toLocaleString(i18n.resolvedLanguage) }));

  mocks.cancel.mockResolvedValue('accepted');
  await click('plugins.trustedWebCancel');
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(request.requestId);
  expect(dialog.textContent).toContain(i18n.t('plugins.installProgress.cancelling'));
  expect(dialog.querySelector('button')!.disabled).toBe(true);
  await act(async () => finish(null));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps bilingual progress keys ordered with unchanged placeholders', () => {
  function progressKeys(language: string) {
    return Object.entries(i18n.getResourceBundle(language, 'translation') as Record<string, string>)
      .filter(([key]) => key.startsWith('plugins.installProgress.'))
      .map(([key, text]) => [key, [...text.matchAll(/\{\{\w+\}\}/g)].map(match => match[0]).sort()]);
  }
  expect(progressKeys('zh-CN')).toHaveLength(11);
  expect(progressKeys('en-US')).toEqual(progressKeys('zh-CN'));
});

it('disables both the cancel button and Escape after committing begins', async () => {
  await click('plugins.installDirectory');
  await act(async () => request.onProgress({ phase: 'committing' }));
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('button')!.disabled).toBe(true);
  expect(dialog.textContent).toContain(i18n.t('plugins.installProgress.committing'));
  await click('plugins.trustedWebCancel');
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(container.contains(dialog)).toBe(true);
  await act(async () => finish(null));
});
