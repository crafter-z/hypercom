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
    'load_command_sets',
    'load_highlight_sets',
    'load_protocol_templates',
    'load_port_tool_configs',
    'load_trigger_rules',
    'load_port_presets',
    'get_log_files',
  ]);

  // 事件名 → transformCallback id（issue #6-10 e2e：驱动 serial:data 事件）
  const eventListeners = {};

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (ARRAY_COMMANDS.has(cmd)) return [];
      if (cmd === 'list_available_ports') {
        // 给 e2e 一个可打开标签页的端口（issue #6-10 RX 显示路径测试）
        return [{ id: 'COM1', name: 'COM1', port_type: 'real', manufacturer: null, product: null }];
      }
      if (cmd === 'plugin:event|listen') {
        const id = nextId++;
        if (args && args.event) eventListeners[args.event] = args.handler;
        return id;
      }
      if (cmd === 'get_system_status')
        return { status: 'normal', memoryUsedMb: 0, memoryLimitMb: 0, cpuUsage: 0 };
      return null;
    },
    // 测试驱动：向某个已注册的事件监听器派发 payload（@tauri-apps/api 的
    // handler 收到 { event, payload } 对象）。
    dispatchEvent: (event, payload) => {
      const handlerId = eventListeners[event];
      const cb = callbacks.get(handlerId);
      if (cb) cb({ event, id: handlerId, payload });
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

  // ==================== issue #6-10：RX 显示 + 隐藏窗口排空 ====================

  /** 打开 COM1 标签页（侧边栏双击端口行）并等终端渲染 */
  async function openCom1Tab(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('.port-item-name', { hasText: 'COM1' }).dblclick();
    await expect(page.locator('.tab-item', { hasText: 'COM1' })).toBeVisible();
  }

  /** 通过 mock 事件桥向应用派发一条 serial:data */
  async function dispatchSerialData(
    page: import('@playwright/test').Page,
    portId: string,
    text: string,
  ): Promise<void> {
    await page.evaluate(
      ({ portId, text }) => {
        const bytes = Array.from(new TextEncoder().encode(text));
        window.__TAURI_INTERNALS__.dispatchEvent('serial:data', {
          port_id: portId,
          timestamp: Date.now(),
          direction: 'RX',
          data: bytes,
          is_hex: false,
        });
      },
      { portId, text },
    );
  }

  test('RX serial data renders in the terminal (issue #6-10)', async ({ page }) => {
    await openCom1Tab(page);
    await dispatchSerialData(page, 'COM1', 'hello-rx\n');
    await expect(page.locator('.terminal-line .terminal-content').first()).toContainText(
      'hello-rx',
    );
  });

  test('RX data still drains while the document is hidden (issue #6-10)', async ({ page }) => {
    await openCom1Tab(page);
    // 强制页面进入隐藏态（rAF 停摆的等价条件）+ 派发 visibilitychange 让管线重排
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await dispatchSerialData(page, 'COM1', 'hidden-drain\n');
    // 隐藏时 rAF 停摆，管线靠 setTimeout 兜底排空——行仍应出现在终端
    await expect(page.locator('.terminal-line .terminal-content').first()).toContainText(
      'hidden-drain',
    );
  });
});
