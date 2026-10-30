// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import PluginSettings from './PluginSettings';
import type { PluginView } from '../../../types';

const mocks = vi.hoisted(() => ({
  api: { plugins: [] as PluginView[], loading: false, refresh: vi.fn(), installPlugin: vi.fn(), reloadPlugin: vi.fn(),
    grantAllAndEnable: vi.fn(), uninstallPlugin: vi.fn(), setEnabled: vi.fn(), togglePermission: vi.fn(),
    setTrustedWeb: vi.fn(), clearWebData: vi.fn() },
  open: vi.fn(),
  isReplaceError: vi.fn(), replacementTargetId: vi.fn(),
}));
vi.mock('../../../hooks/usePlugins', () => ({
  usePluginList: () => mocks.api,
  isPluginReplaceConfirmationError: mocks.isReplaceError,
  replacementTargetId: mocks.replacementTargetId,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const trustedPlugin = (): PluginView => ({
  id: 'demo', dir: 'plugins/demo', installGeneration: 'generation-a', enabled: false,
  grantedPermissions: [], declaredPermissions: [], knownPermissions: [], manifestError: null, installedAt: 1,
  manifest: { id: 'demo', name: 'Demo', version: '1.2.3', apiVersion: '1.0', entry: 'main.js', description: '', permissions: [],
    ui: { buttons: [], menuItems: [], views: [{ id: 'web', label: 'Web', entry: 'index.html', mode: 'trusted-web',
      styles: [], assets: [], modes: ['trx'], input: 'none', placements: ['workspace-tab'], portBinding: 'none', restoreOnStartup: false }] } },
});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.api.plugins = [trustedPlugin()];
  mocks.api.setTrustedWeb.mockResolvedValue(undefined);
  mocks.api.refresh.mockResolvedValue([trustedPlugin()]);
  mocks.api.setEnabled.mockResolvedValue(undefined);
  mocks.api.reloadPlugin.mockResolvedValue(undefined);
  mocks.isReplaceError.mockReturnValue(false);
  mocks.replacementTargetId.mockReturnValue('demo');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function render() { await act(async () => root.render(createElement(PluginSettings))); }
async function click(key: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === key);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it('requires independent consent on enable and focuses cancel without granting anything', async () => {
  await render();
  await click('plugins.enable');
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(document.activeElement).toBe(dialog?.querySelector('button'));
  expect(mocks.api.setEnabled).not.toHaveBeenCalled();
  await click('plugins.trustedWebCancel');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.api.setTrustedWeb).not.toHaveBeenCalled();
});

it('uses the reviewed generation only after explicit consent', async () => {
  await render();
  await click('plugins.enable');
  await click('plugins.trustedWebAccept');
  expect(mocks.api.setTrustedWeb).toHaveBeenCalledWith('demo', true, 'generation-a');
  expect(mocks.api.setEnabled).toHaveBeenCalledWith('demo', true, 'generation-a');
});

it('shows separate trust consent before ordinary install permissions', async () => {
  mocks.open.mockResolvedValue('archive.zip');
  mocks.api.installPlugin.mockResolvedValue(trustedPlugin());
  await render();
  await click('plugins.installZip');
  expect(container.querySelector('#trusted-web-title')).not.toBeNull();
  expect(mocks.api.grantAllAndEnable).not.toHaveBeenCalled();
  await click('plugins.trustedWebCancel');
  expect(mocks.api.setTrustedWeb).not.toHaveBeenCalled();
  expect(mocks.api.setEnabled).not.toHaveBeenCalled();
});

it('does not ask again for a previously trusted installation', async () => {
  mocks.api.plugins[0].trustedWebGranted = true;
  await render();
  await click('plugins.enable');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.api.setTrustedWeb).not.toHaveBeenCalled();
  expect(mocks.api.setEnabled).toHaveBeenCalledWith('demo', true, 'generation-a');
});

it('reloads the installed code of an enabled plugin without a destructive uninstall', async () => {
  mocks.api.plugins = [{ ...trustedPlugin(), enabled: true }];
  await render();
  await click('plugins.reloadCode');
  expect(mocks.api.reloadPlugin).toHaveBeenCalledWith('demo', 'generation-a');
  expect(mocks.api.uninstallPlugin).not.toHaveBeenCalled();
});

it('does not enqueue duplicate reload clicks before the first one settles', async () => {
  mocks.api.plugins = [{ ...trustedPlugin(), enabled: true }];
  let resolve!: () => void;
  mocks.api.reloadPlugin.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
  await render();
  const button = [...container.querySelectorAll('button')]
    .find(item => item.textContent?.trim() === 'plugins.reloadCode');
  expect(button).toBeDefined();
  await act(async () => { button!.click(); button!.click(); });
  expect(mocks.api.reloadPlugin).toHaveBeenCalledTimes(1);
  resolve();
  await act(async () => { await Promise.resolve(); });
});

it('asks for explicit confirmation before replacing a same or lower version', async () => {
  mocks.open.mockResolvedValue('archive.zip');
  mocks.api.installPlugin
    .mockRejectedValueOnce(new Error('plugin_replace_confirmation_required: 插件 demo 已安装（版本 1.0.0）'))
    .mockResolvedValueOnce(null);
  mocks.isReplaceError.mockReturnValue(true);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  await render();
  await click('plugins.installZip');
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(mocks.api.installPlugin).toHaveBeenNthCalledWith(1, 'archive.zip');
  expect(mocks.api.installPlugin).toHaveBeenNthCalledWith(2, 'archive.zip', true, 'generation-a');
});

it('keeps the installed version when replacement is cancelled', async () => {
  mocks.open.mockResolvedValue('archive.zip');
  mocks.api.installPlugin.mockRejectedValueOnce(new Error('plugin_replace_confirmation_required: 插件 demo 已安装（版本 1.0.0）'));
  mocks.isReplaceError.mockReturnValue(true);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await render();
  await click('plugins.installZip');
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(mocks.api.installPlugin).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('does not confirm before a first install or a higher-version upgrade', async () => {
  mocks.open.mockResolvedValue('archive.zip');
  mocks.api.installPlugin.mockResolvedValue(null);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await render();
  await click('plugins.installZip');
  expect(confirm).not.toHaveBeenCalled();
  expect(mocks.api.installPlugin).toHaveBeenCalledWith('archive.zip');
});
