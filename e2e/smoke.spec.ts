import { test, expect } from '@playwright/test';

/**
 * Mock `window.__TAURI_INTERNALS__` so the React layer renders without the
 * Rust backend.  The script runs before any page JS, preventing
 * "Cannot read properties of undefined (reading 'metadata')" from
 * `@tauri-apps/api/window#getCurrentWindow` and similar calls.
 *
 * `invoke` returns type-appropriate defaults per command so the app
 * initialises with empty state instead of crashing on `null.map()`.
 */
const TAURI_MOCK = `
(() => {
  if (window.__TAURI_INTERNALS__) return;

  const callbacks = new Map();
  let nextId = 1;

  // Commands that return arrays — must NOT return null or .map() crashes.
  const ARRAY_COMMANDS = new Set([
    'list_available_ports',
    'load_command_sets',
    'load_highlight_sets',
    'load_protocol_templates',
    'load_port_tool_configs',
    'load_trigger_rules',
    'load_port_presets',
    'get_log_files',
  ]);

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd) => {
      if (ARRAY_COMMANDS.has(cmd)) return [];
      if (cmd === 'plugin:event|listen') return nextId++;
      if (cmd === 'get_system_status')
        return { status: 'normal', memoryUsedMb: 0, memoryLimitMb: 0, cpuUsage: 0 };
      return null;
    },
    transformCallback: (cb, once = false) => {
      const id = nextId++;
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        return cb && cb(data);
      });
      return id;
    },
    unregisterCallback: (id) => { callbacks.delete(id); },
    runCallback: (id, data) => {
      const cb = callbacks.get(id);
      if (cb) cb(data);
    },
    callbacks,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    convertFileSrc: (filePath, protocol = 'asset') =>
      'http://' + protocol + '.localhost/' + encodeURIComponent(filePath),
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
})();
`;

test.describe('HyperCom smoke tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(TAURI_MOCK);
    await page.goto('/');
    // Wait for the React app root to mount
    await expect(page.locator('.app-root')).toBeVisible();
  });

  test('page loads without crashing (no error boundary)', async ({ page }) => {
    // The error boundary renders a distinct layout — ensure it is NOT shown.
    // The normal app has .titlebar as a direct child of .app-root.
    await expect(page.locator('.app-root > .titlebar')).toBeVisible();
  });

  test('TitleBar renders', async ({ page }) => {
    await expect(page.locator('.titlebar')).toBeVisible();
    await expect(page.locator('.titlebar-title')).toBeVisible();
  });

  test('Sidebar renders', async ({ page }) => {
    await expect(page.locator('.sidebar-toolbar')).toBeVisible();
  });

  test('MainDisplay renders', async ({ page }) => {
    await expect(page.locator('.main-display')).toBeVisible();
  });

  test('StatusBar renders', async ({ page }) => {
    await expect(page.locator('.statusbar')).toBeVisible();
  });

  test('OperationPanel renders', async ({ page }) => {
    await expect(page.locator('.operation-panel')).toBeVisible();
  });

  test('StatusBar renders memory budget indicator (issue #6-2/6-6)', async ({ page }) => {
    // 状态栏内存显示：总预算来自 config（mock 下为默认 2048MB）
    await expect(page.locator('.statusbar')).toBeVisible();
    await expect(page.locator('.statusbar-left').getByText(/MB \//)).toBeVisible();
  });

  test('GeneralSettings shows total + per-port memory budget inputs (issue #6-2)', async ({ page }) => {
    // 打开设置弹窗（TitleBar 右侧设置按钮）
    await page.locator('.titlebar-right button[title="设置"]').click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await expect(page.locator('.config-page').getByText('内存总预算 (MB):')).toBeVisible();
    await expect(page.locator('.config-page').getByText('每端口内存预算 (MB):')).toBeVisible();
  });
});
