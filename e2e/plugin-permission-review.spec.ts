import { expect, test, type Page } from '@playwright/test';
import type { PluginConfigEntry, PluginManifestView, PluginView } from '../src/types';
import { TAURI_MOCK } from './tauriMock';

const GENERATION = 'reviewed-installation';
const WORKER_ID = 'com.example.review-worker';
const WEB_ID = 'com.example.review-web';
const ZIP_PATH = 'C:/mock/review-plugin.zip';

interface ReviewSeed {
  id: string;
  generation: string;
  sourcePath: string;
  language: 'en-US' | 'zh-CN';
  trustedWeb: boolean;
}

interface Mutation {
  command: string;
  args: unknown;
}

// Runs before the app scripts. Only IPC is substituted; these tests exercise
// the real settings page, locale resources, snapshot handling, and dialog.
function installReviewIpc(seed: ReviewSeed) {
  const internals = window.__TAURI_INTERNALS__;
  const invoke = internals.invoke.bind(internals);
  const permissions = seed.trustedWeb ? [] : ['terminal:read', 'shell:execute'];
  const manifest: PluginManifestView = {
    id: seed.id, name: seed.trustedWeb ? 'Review Web' : 'Review Worker', version: '2.1.0', apiVersion: '1.0',
    description: '', entry: seed.trustedWeb ? '' : 'main.js', permissions,
    ui: seed.trustedWeb ? { buttons: [], menuItems: [], views: [{
      id: 'web', label: 'Review page', entry: 'index.html', styles: [], assets: [], mode: 'trusted-web',
      modes: ['trx'], input: 'none', placements: ['workspace-tab'], portBinding: 'none', restoreOnStartup: false,
    }] } : null,
  };
  const calls: Mutation[] = [];
  let revision = 0;
  let entry: PluginConfigEntry | null = null;
  const snapshot = () => ({ revision, pluginConfigs: entry ? [entry] : [] });
  const view = (): PluginView | null => entry && ({
    ...entry, dir: 'C:/mock/plugins/' + seed.id, manifest, manifestError: null, installedAt: 1,
    declaredPermissions: permissions, knownPermissions: permissions,
  });
  Object.defineProperty(window, '__PLUGIN_REVIEW_IPC__', {
    value: {
      getState: () => ({ calls, entry }),
      replaceInstallation(generation: string) {
        if (!entry) throw new Error('Cannot replace an uninstalled fixture');
        entry = { ...entry, installGeneration: generation, enabled: false, trustedWebGranted: false, grantedPermissions: [] };
        revision++;
      },
    },
  });
  internals.invoke = async (command, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    switch (command) {
      case 'get_config':
        return { ...(await invoke(command, rawArgs) as object), ...snapshot(), language: seed.language };
      case 'list_plugins': {
        const installed = view();
        return { ...snapshot(), plugins: installed ? [installed] : [] };
      }
      case 'plugin:dialog|open':
        return seed.sourcePath;
      case 'install_plugin':
        if (entry || args.sourcePath !== seed.sourcePath) throw new Error('Unexpected installation request');
        entry = { id: seed.id, installGeneration: seed.generation, enabled: false, grantedPermissions: [], trustedWebGranted: false, source: 'zip' };
        revision++;
        return snapshot();
      case 'set_plugin_permissions':
      case 'set_plugin_enabled':
      case 'set_plugin_trusted_web':
        calls.push({ command, args: structuredClone(rawArgs) });
        if (!entry || args.id !== entry.id || args.expectedGeneration !== entry.installGeneration) throw new Error('Reviewed installation changed');
        if (command === 'set_plugin_permissions') {
          if (!Array.isArray(args.permissions) || args.permissions.some(permission => !permissions.includes(permission))) throw new Error('Unexpected permission');
          entry = { ...entry, grantedPermissions: args.permissions };
        } else if (command === 'set_plugin_trusted_web') {
          if (!seed.trustedWeb || args.trusted !== true) throw new Error('Unexpected webpage trust request');
          entry = { ...entry, trustedWebGranted: true };
        } else {
          if (args.enabled !== true || (seed.trustedWeb && !entry.trustedWebGranted)) throw new Error('Enable requested without trust');
          entry = { ...entry, enabled: true };
        }
        revision++;
        return snapshot();
      case 'read_plugin_asset':
        if (args.id === seed.id && args.relPath === 'manifest.json') return JSON.stringify(manifest);
        if (args.id === seed.id && args.relPath === 'main.js' && entry?.enabled && !seed.trustedWeb) return '// Worker fixture has no startup side effects.';
        break;
    }
    return invoke(command, rawArgs);
  };
}

async function openPluginSettings(page: Page, trustedWeb = false) {
  const language = trustedWeb ? 'zh-CN' : 'en-US';
  const seed: ReviewSeed = { id: trustedWeb ? WEB_ID : WORKER_ID, generation: GENERATION, sourcePath: ZIP_PATH, language, trustedWeb };
  await page.addInitScript({ content: `${TAURI_MOCK}\n(${installReviewIpc.toString()})(${JSON.stringify(seed)});` });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', language);
  await page.locator(`.titlebar-right button[aria-label="${trustedWeb ? '设置' : 'Settings'}"]`).click();
  await page.locator('.modal-nav-item').filter({ hasText: trustedWeb ? /^插件$/ : /^Plugins$/ }).click();
  await page.getByRole('button', { name: trustedWeb ? '安装 ZIP…' : 'Install ZIP…', exact: true }).click();
}

function getIpcState(page: Page): Promise<{ calls: Mutation[]; entry: PluginConfigEntry | null }> {
  return page.evaluate(() => Object.getOwnPropertyDescriptor(window, '__PLUGIN_REVIEW_IPC__')!.value.getState());
}

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.__E2E_UNKNOWN_COMMANDS__ ?? []), 'unexpected mocked IPC commands').toEqual([]);
});

test('reviews ordinary permissions without preselecting local execution and enables with the reviewed generation', async ({ page }) => {
  await openPluginSettings(page);
  const review = page.getByRole('dialog', { name: 'Review permissions for “Review Worker”' });
  await expect(review.getByText('These permissions come from the installed package', { exact: false })).toBeVisible();
  await expect(review.getByRole('checkbox', { name: 'Read incoming serial text lines' })).toBeChecked();
  const shell = review.getByRole('checkbox', { name: /^Run local programs with your user privileges/ });
  await expect(shell).toBeVisible();
  await expect(shell).not.toBeChecked();
  await expect(review.getByText('shell:execute', { exact: true })).toBeHidden();
  expect((await getIpcState(page)).calls).toEqual([]);

  await review.getByRole('button', { name: 'Enable with these choices' }).click();
  await expect(review).toBeHidden();
  await expect(page.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  const { calls, entry } = await getIpcState(page);
  expect(calls).toEqual([
    { command: 'set_plugin_permissions', args: { id: WORKER_ID, permissions: ['terminal:read'], expectedGeneration: GENERATION } },
    { command: 'set_plugin_enabled', args: { id: WORKER_ID, enabled: true, expectedGeneration: GENERATION } },
  ]);
  expect(entry).toMatchObject({ enabled: true, grantedPermissions: ['terminal:read'], trustedWebGranted: false });
});

test('pure trusted-web install remains disabled without explicit webpage trust', async ({ page }) => {
  await openPluginSettings(page, true);
  const review = page.getByRole('dialog', { name: '审阅「Review Web」的权限' });
  const trust = review.getByRole('checkbox', { name: '我信任此插件的网页' });
  const enable = review.getByRole('button', { name: '按此选择启用' });
  await expect(trust).toBeVisible();
  await expect(trust).not.toBeChecked();
  await expect(enable).toBeDisabled();
  await expect(review.getByText('此插件需要网页信任才能启用。不授予信任会保持禁用。')).toBeVisible();
  await review.getByRole('button', { name: '稍后处理' }).click();
  await expect(review).toBeHidden();
  const rejected = await getIpcState(page);
  expect(rejected.calls).toEqual([]);
  expect(rejected.entry).toMatchObject({ enabled: false, trustedWebGranted: false });

  await page.getByRole('button', { name: '启用', exact: true }).click();
  await expect(enable).toBeDisabled();
  await trust.check();
  await enable.click();
  await expect(page.getByRole('button', { name: '禁用', exact: true })).toBeVisible();
  expect((await getIpcState(page)).calls).toEqual([
    { command: 'set_plugin_trusted_web', args: { id: WEB_ID, trusted: true, expectedGeneration: GENERATION } },
    { command: 'set_plugin_enabled', args: { id: WEB_ID, enabled: true, expectedGeneration: GENERATION } },
  ]);
});

test('does not apply the open review after the installation is replaced', async ({ page }) => {
  await openPluginSettings(page);
  const review = page.getByRole('dialog', { name: 'Review permissions for “Review Worker”' });
  await expect(review).toBeVisible();
  await page.evaluate(() => Object.getOwnPropertyDescriptor(window, '__PLUGIN_REVIEW_IPC__')!.value.replaceInstallation('new-installation'));
  await review.getByRole('button', { name: 'Enable with these choices' }).click();
  await expect(review).toBeHidden();
  expect(await getIpcState(page)).toMatchObject({
    calls: [], entry: { installGeneration: 'new-installation', enabled: false, grantedPermissions: [] },
  });
});
