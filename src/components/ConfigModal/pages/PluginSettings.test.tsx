// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import PluginSettings from './PluginSettings';
import type { MarketplaceIndex, MarketplaceUpdate, PluginView } from '../../../types';
import { useAppStore } from '../../../stores/useAppStore';

const mocks = vi.hoisted(() => ({
  api: { plugins: [] as PluginView[], loading: false, refresh: vi.fn(), installPlugin: vi.fn(), reloadPlugin: vi.fn(),
    installMarketplacePlugin: vi.fn(), applyPermissionReview: vi.fn(), uninstallPlugin: vi.fn(), setEnabled: vi.fn(),
    revokeTrustedWeb: vi.fn(), clearWebData: vi.fn() },
  open: vi.fn(),
  isReplaceError: vi.fn(), replacementTargetId: vi.fn(),
  marketplace: { index: null as MarketplaceIndex | null, updates: [] as MarketplaceUpdate[], loading: false, error: null, fetchIndex: vi.fn(), checkUpdates: vi.fn() },
  config: { saveConfig: vi.fn() },
}));
vi.mock('../../../hooks/usePlugins', () => ({
  usePluginList: () => mocks.api,
  usePluginMarketplace: () => mocks.marketplace,
  isPluginReplaceConfirmationError: mocks.isReplaceError,
  replacementTargetId: mocks.replacementTargetId,
}));
vi.mock('../../../hooks/useConfigPersistence', () => ({
  useConfigPersistence: () => mocks.config,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
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
  mocks.marketplace.index = null;
  mocks.marketplace.updates = [];
  mocks.api.applyPermissionReview.mockResolvedValue(undefined);
  mocks.api.refresh.mockResolvedValue([trustedPlugin()]);
  mocks.api.setEnabled.mockResolvedValue(undefined);
  mocks.api.reloadPlugin.mockResolvedValue(undefined);
  mocks.isReplaceError.mockReturnValue(false);
  mocks.replacementTargetId.mockReturnValue('demo');
  mocks.config.saveConfig.mockResolvedValue(true);
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

it('persists a valid marketplace source after syncing without footer save', async () => {
  useAppStore.getState().setConfig({ pluginMarketplaceUrl: 'http://127.0.0.1:8787/index.json' });
  mocks.marketplace.index = { schemaVersion: 1, plugins: ['http://127.0.0.1:8787/plugin-demo.json'] };
  mocks.marketplace.fetchIndex.mockResolvedValue(mocks.marketplace.index);
  mocks.marketplace.checkUpdates.mockResolvedValue([]);
  await render();
  await click('plugins.marketplace.fetch');
  expect(mocks.config.saveConfig).toHaveBeenCalledWith(
    { pluginMarketplaceUrl: 'http://127.0.0.1:8787/index.json' },
    true,
  );
  await act(async () => {
    useAppStore.getState().setConfig({ pluginMarketplaceUrl: '' });
  });
});

it('requires explicit trust for a pure trusted-web plugin and focuses cancel', async () => {
  const plugin = trustedPlugin();
  delete plugin.manifest!.entry;
  mocks.api.plugins = [plugin];
  await render();
  await click('plugins.enable');
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(document.activeElement).toBe(dialog?.querySelector('button'));
  expect(dialog?.textContent).toContain('plugins.review.trustRequired');
  expect(checkbox('plugins.trustedWebAccept').checked).toBe(false);
  await click('plugins.review.applyAndEnable');
  await click('plugins.trustedWebCancel');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.api.applyPermissionReview).not.toHaveBeenCalled();
  expect(mocks.api.setEnabled).not.toHaveBeenCalled();
});

it('submits trust only when explicitly selected, without adding ungranted permissions on enable', async () => {
  const plugin = workerPlugin(['serial:control', 'terminal:read'], ['terminal:read']);
  plugin.manifest!.ui = trustedPlugin().manifest!.ui;
  mocks.api.plugins = [plugin];
  const confirm = vi.spyOn(window, 'confirm');
  await render();
  await click('plugins.enable');
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('plugins.review.permission.terminal:read');
  expect(container.querySelector('[role="dialog"]')?.textContent).not.toContain('plugins.review.permission.serial:control');
  await act(async () => checkbox('plugins.trustedWebAccept').click());
  await click('plugins.review.applyAndEnable');
  expect(confirm).not.toHaveBeenCalled();
  expect(mocks.api.applyPermissionReview).toHaveBeenCalledWith({ plugin, intent: 'enable', permissions: ['terminal:read'], trustWeb: true });
});

it('does not show permission or trust prompts on normal re-enable with existing grants', async () => {
  const plugin = workerPlugin(['fs:write-dir', 'terminal:read'], ['terminal:read']);
  const confirm = vi.spyOn(window, 'confirm');
  mocks.api.plugins = [plugin];
  await render();
  await click('plugins.enable');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
  expect(mocks.api.applyPermissionReview).not.toHaveBeenCalled();
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
  await render();
  await click('plugins.installZip');
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(mocks.api.installPlugin).toHaveBeenCalledTimes(1);
  await click('confirmDialog.confirm');
  expect(mocks.api.installPlugin).toHaveBeenNthCalledWith(1, 'archive.zip');
  expect(mocks.api.installPlugin).toHaveBeenNthCalledWith(2, 'archive.zip', true, 'generation-a');
});

it('keeps the installed version when replacement is cancelled', async () => {
  mocks.open.mockResolvedValue('archive.zip');
  mocks.api.installPlugin.mockRejectedValueOnce(new Error('plugin_replace_confirmation_required: 插件 demo 已安装（版本 1.0.0）'));
  mocks.isReplaceError.mockReturnValue(true);
  await render();
  await click('plugins.installZip');
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  await click('confirmDialog.cancel');
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

function workerPlugin(permissions: string[], grantedPermissions: string[] = []): PluginView {
  const base = trustedPlugin();
  return {
    ...base,
    grantedPermissions,
    declaredPermissions: permissions,
    knownPermissions: [...permissions, 'notify'].filter(permission => permission !== 'future:unknown'),
    manifest: { ...base.manifest!, permissions, ui: null },
  };
}

function checkbox(label: string): HTMLInputElement {
  const dialog = container.querySelector('[role="dialog"]');
  const row = [...dialog!.querySelectorAll('label')].find(item => item.textContent?.trim() === label);
  expect(row).toBeDefined();
  return row!.querySelector('input')!;
}

it('uses one installed-package review, never preselects shell, and enables ordinary permissions without shell', async () => {
  const plugin = workerPlugin(['terminal:read', 'fs:export-dir', 'shell:execute', 'future:unknown']);
  mocks.open.mockResolvedValue('archive.zip');
  mocks.api.installPlugin.mockResolvedValue(plugin);
  const confirm = vi.spyOn(window, 'confirm');
  await render();
  await click('plugins.installZip');
  const dialog = container.querySelector('[role="dialog"]');
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(dialog?.querySelector('details')?.open).toBe(false);
  expect(dialog?.querySelector('details code')?.textContent).toBe('terminal:read');
  expect(dialog?.textContent).not.toContain('future:unknown');
  expect(checkbox('plugins.review.permission.fs:export-dir').checked).toBe(true);
  expect(checkbox('plugins.review.permission.shell:execute').checked).toBe(false);
  await click('plugins.review.applyAndEnable');
  expect(confirm).not.toHaveBeenCalled();
  expect(mocks.api.applyPermissionReview).toHaveBeenCalledWith({ plugin, intent: 'install', permissions: ['terminal:read', 'fs:export-dir'], trustWeb: false });
});

it('shows actual-versus-preview differences and cannot grant a permission from marketplace metadata alone', async () => {
  const plugin = workerPlugin(['serial:send', 'shell:execute']);
  plugin.manifest!.serial = { portWhitelist: [] };
  const update: MarketplaceUpdate = {
    id: plugin.id, currentVersion: '1.0.0', latestVersion: '1.2.3', updateAvailable: true,
    descriptionUrl: 'https://example.test/plugin.json', downloadUrl: 'https://example.test/plugin.zip',
    manifest: { ...plugin.manifest!, permissions: ['serial:send', 'clipboard'], serial: { portWhitelist: ['COM2'] } },
  };
  mocks.api.plugins = [{ ...plugin, installGeneration: 'old-generation' }];
  mocks.marketplace.index = { schemaVersion: 1, plugins: [update.descriptionUrl] };
  mocks.marketplace.updates = [update];
  mocks.api.installMarketplacePlugin.mockResolvedValue(plugin);
  await render();
  await click('plugins.marketplace.update');
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain('plugins.review.previewMismatch');
  expect(dialog?.textContent).toContain('plugins.review.previewAdded');
  expect(dialog?.textContent).toContain('plugins.review.previewRemoved');
  expect(dialog?.textContent).toContain('plugins.review.previewSerial');
  expect(dialog?.textContent).toContain('plugins.review.serialNone');
  expect([...dialog!.querySelectorAll('label')].some(label => label.textContent?.includes('clipboard'))).toBe(false);
  expect(mocks.api.installMarketplacePlugin).toHaveBeenCalledWith(update, 'old-generation');
  await click('plugins.review.applyAndEnable');
  expect(mocks.api.applyPermissionReview).toHaveBeenCalledWith({ plugin, intent: 'install', permissions: ['serial:send'], trustWeb: false });
});

it('retains only effective existing grants by default and saves an exact explicit change', async () => {
  const plugin = workerPlugin(['fs:open-dir', 'fs:export-dir', 'shell:execute'], ['fs:open-dir', 'fs:write-dir']);
  mocks.api.plugins = [plugin];
  const confirm = vi.spyOn(window, 'confirm');
  await render();
  await click('plugins.review.manage');
  const dialog = container.querySelector('[role="dialog"]');
  expect(checkbox('plugins.review.permission.fs:open-dir').checked).toBe(true);
  expect(checkbox('plugins.review.permission.fs:export-dir').checked).toBe(false);
  expect(checkbox('plugins.review.permission.shell:execute').checked).toBe(false);
  expect(dialog?.textContent).not.toContain('fs:write-dir');
  await click('plugins.review.save');
  expect(mocks.api.applyPermissionReview).not.toHaveBeenCalled();
  await act(async () => checkbox('plugins.review.permission.fs:open-dir').click());
  await act(async () => checkbox('plugins.review.permission.shell:execute').click());
  expect(dialog?.textContent).toContain('plugins.review.willGrant');
  expect(dialog?.textContent).toContain('plugins.review.willRevoke');
  await click('plugins.review.save');
  expect(confirm).not.toHaveBeenCalled();
  expect(mocks.api.applyPermissionReview).toHaveBeenCalledWith({ plugin, intent: 'manage', permissions: ['shell:execute'], trustWeb: false });
});
