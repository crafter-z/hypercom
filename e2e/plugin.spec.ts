import { test, expect, type Page } from '@playwright/test';

/**
 * 插件系统 e2e（issue #17，设计 §9）。
 *
 * 复用 smoke.spec 的 mock 手法：注入 `__TAURI_INTERNALS__`，前端全链路真跑
 * （pluginHost Worker + RPC 桥 + rxPipeline + pluginObserver + viewportManager），
 * 仅 Rust 后端被 mock。覆盖设计 §9 的前端可达项：
 *  1. 启用插件 → worker 加载 → RX 注入 → 插件 terminal.append 翻译行（用例①全链路）；
 *  2. 权限拒绝路径（未授予 terminal:read/terminal:write → 无 rx 转发、旁注被拒）；
 *  3. 端口断线 → rx.detached(port-disconnected)（复审补强的断线场景；
 *     TRX→TTY 切换断流由 pluginObserver.test.ts 单测覆盖——e2e mock 无模式切换 UI）。
 * 不可达项（如实声明）：安装对话框（原生 dialog）、zip 校验（后端单测覆盖）、
 * CSP 生产构建断言（需 tauri 生产构建，本 harness 是 vite dev + mock 后端）。
 */

const PLUGIN_ID = 'com.example.hypercom-e2e';
const browserErrors = new WeakMap<Page, string[]>();

/** demo worker：PING → PONG 旁注；断流通知写旁注。普通脚本（无 ESM）。 */
const DEMO_WORKER = `
var reloadRxCount = 0;
self.plugin.on('rx.line', function (lines) {
  for (var i = 0; i < lines.length; i++) {
    var text = new TextDecoder().decode(lines[i].rawData);
    if (text.indexOf('PING') !== -1) {
      self.plugin.api['terminal.append']({
        portId: lines[i].portId,
        text: 'PONG<' + text.trim() + '>#' + (++reloadRxCount),
      });
    }
  }
});
self.plugin.on('rx.detached', function (e) {
  self.plugin.api['terminal.append']({
    portId: e.portId,
    text: 'RX-DETACHED:' + e.reason,
  });
});
`;

const MOCK = `
(() => {
  if (window.__TAURI_INTERNALS__) return;

  const callbacks = new Map();
  let nextId = 1;
  const eventListeners = {};

  // e2e 授权 seed（openApp 在 goto 前注入 __PLUGIN_E2E_SEED__——授予集是 mock
  // 启动态，消除「boot 后再改 state」的竞态）。
  const seed = (typeof window.__PLUGIN_E2E_SEED__ === 'object' && window.__PLUGIN_E2E_SEED__) || {};
  const state = { enabled: true, granted: seed.granted || ['terminal:read', 'terminal:write'], reloads: 0 };
  let revision = 1;
  const PLUGIN_CONFIG = () => ({
    id: '${PLUGIN_ID}', installGeneration: 'e2e-install', enabled: state.enabled,
    grantedPermissions: [...state.granted], installedAt: 1, source: 'zip',
  });
  const configFields = {
    restoreSession: false, sendCommandSets: [], highlightRuleSets: [], protocolTemplates: [],
    triggerRules: [], portToolConfigs: [], portPresets: [], portGroups: [], portMeta: [],
  };
  let configFixturePromise = null;
  let configFixture = null;
  const getConfigFixture = async () => {
    if (!configFixturePromise) {
      configFixturePromise = import('/src/stores/useAppStore.ts').then(({ useAppStore }) => {
        configFixture = structuredClone(useAppStore.getState().config);
        Object.assign(configFixture, configFields);
      });
    }
    await configFixturePromise;
    configFixture.revision = revision;
    configFixture.pluginConfigs = [PLUGIN_CONFIG()];
    return structuredClone(configFixture);
  };
  const PLUGIN_VIEW = () => ({
    id: '${PLUGIN_ID}',
    dir: 'C:/mock/plugins/${PLUGIN_ID}',
    enabled: state.enabled,
    grantedPermissions: [...state.granted],
    declaredPermissions: ['terminal:read', 'terminal:write', 'rx:bytes', 'ui:view'],
    knownPermissions: ['terminal:read', 'terminal:write', 'rx:bytes', 'ui:view'],
    manifest: {
      id: '${PLUGIN_ID}',
      name: 'E2E Demo',
      version: '1.0.0',
      description: 'e2e demo',
      apiVersion: '1.0',
      entry: 'main.js',
      permissions: ['terminal:read', 'terminal:write', 'rx:bytes', 'ui:view'],
      ui: {
        buttons: [],
        menuItems: [],
        views: [
          { id: 'tool', label: 'E2E Tool', entry: 'ui/main.js', styles: [], assets: [], modes: ['trx'], input: 'none', placements: ['workspace-tab'], portBinding: 'none', restoreOnStartup: false },
          { id: 'table', label: 'Sensor table', entry: 'ui/main.js', styles: [], assets: [], modes: ['trx'], input: 'bytes', placements: ['workspace-tab', 'serial-content'], portBinding: 'required', restoreOnStartup: false },
        ],
      },
    },
    manifestError: null,
    installedAt: 1,
    installGeneration: 'e2e-install',
  });

  window.__PLUGIN_E2E__ = state;

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if ([
        'load_command_sets',
        'load_highlight_sets',
        'load_protocol_templates',
        'load_port_tool_configs',
        'load_trigger_rules',
        'load_port_presets',
        'get_log_files',
      ].includes(cmd)) {
        return [];
      }
      if (cmd === 'get_config') return getConfigFixture();
      if (cmd === 'get_config_path') return 'C:/mock/config.json';
      if (cmd === 'set_config') {
        if (!args || args.expectedRevision !== revision) return false;
        await getConfigFixture();
        const nextConfig = { ...(args.newConfig || {}) };
        delete nextConfig.revision;
        delete nextConfig.pluginConfigs;
        Object.assign(configFixture, nextConfig);
        revision++;
        configFixture.revision = revision;
        return true;
      }
      if (cmd === 'update_session_snapshot') return null;
      if (cmd === 'list_plugins') {
        const view = PLUGIN_VIEW();
        return { revision, plugins: [view], pluginConfigs: [PLUGIN_CONFIG()] };
      }
      if (cmd === 'reload_plugin') {
        if (!args || args.id !== '${PLUGIN_ID}' || args.expectedGeneration !== 'e2e-install') {
          throw new Error('reload identity mismatch');
        }
        state.reloads++;
        revision++;
        return { revision, pluginConfigs: [PLUGIN_CONFIG()] };
      }
      if (cmd === 'read_plugin_asset') {
        if (args && args.relPath === 'main.js') return ${JSON.stringify(DEMO_WORKER)};
        if (args && args.relPath === 'manifest.json') return JSON.stringify(PLUGIN_VIEW().manifest);
        return null;
      }
      if (cmd === 'list_available_ports') {
        return [{ id: 'COM1', name: 'COM1', port_type: 'real', manufacturer: null, product: null }];
      }
      if (cmd === 'plugin:event|unlisten') return null;
      if (cmd === 'plugin:event|listen') {
        const id = nextId++;
        if (args && args.event) eventListeners[args.event] = args.handler;
        return id;
      }
      if (cmd === 'create_plugin_view') throw new Error('Native plugin view unavailable in browser e2e');
      if (cmd === 'destroy_plugin_view') return null;
      if (cmd === 'plugin:app|version') return '1.0.0-e2e';
      if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to'
        || cmd === 'acknowledge_editor_close' || cmd === 'complete_editor_close' || cmd === 'cancel_editor_close'
        || cmd === 'plugin:window|set_title' || cmd === 'prevent_screen_off' || cmd === 'prevent_sleep'
        || cmd === 'plugin:webview|set_webview_zoom' || cmd === 'append_diag_log') return null;
      if (cmd === 'plugin:window|is_maximized') return false;
      if (cmd === 'get_session_snapshot') return null;
      if (cmd === 'get_system_status')
        return { status: 'normal', memoryUsedMb: 0, cpuUsage: 0 };
      (window.__E2E_UNKNOWN_COMMANDS__ ||= []).push(cmd);
      throw new Error('Unhandled mocked Tauri command: ' + cmd);
    },
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

/** 打开 COM1 标签页（侧边栏双击端口行）并等终端渲染。 */
async function openCom1Tab(page: Page): Promise<void> {
  await page.locator('.port-item-name', { hasText: 'COM1' }).dblclick();
  await expect(page.locator('.tab-item', { hasText: 'COM1' })).toBeVisible();
}

/** 通过 mock 事件桥向应用派发一条 serial:data。 */
async function dispatchSerialData(page: Page, portId: string, text: string): Promise<void> {
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

test.describe('插件系统（issue #17）', () => {
  /** 打开应用（seed 在 goto 前注入——授予集是 mock 启动态，消除 boot 竞态）。 */
  async function openApp(page: Page, granted: string[]): Promise<void> {
    await page.addInitScript((g) => {
      window.__PLUGIN_E2E_SEED__ = { granted: g };
    }, granted);
    await page.addInitScript(MOCK);
    const errors: string[] = [];
    browserErrors.set(page, errors);
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    await page.goto('/');
    await expect(page.locator('.app-root')).toBeVisible();
  }

  test.afterEach(async ({ page }) => {
    expect(browserErrors.get(page) ?? []).toEqual([]);
    const unknown = await page.evaluate(() => window.__E2E_UNKNOWN_COMMANDS__ ?? []);
    expect(unknown, 'mocked unknown Tauri commands').toEqual([]);
  });

  test('启用插件 → RX 注入 → 插件写 PONG 旁注（worker + RPC + 观察器全链路）', async ({ page }) => {
    await openApp(page, ['terminal:read', 'terminal:write']);
    await openCom1Tab(page);
    // 插件宿主 boot（refresh → 写回 store → 订阅 → syncWithConfig 拉 worker）。
    await dispatchSerialData(page, 'COM1', 'PING alpha\n');
    await expect(page.locator('.terminal-line .terminal-content').filter({ hasText: 'PONG<PING alpha>' })).toBeVisible();
  });

  test('插件设置真实重载按钮刷新 generation/revision 后仍可响应 RX', async ({ page }) => {
    await openApp(page, ['terminal:read', 'terminal:write']);
    await openCom1Tab(page);
    await dispatchSerialData(page, 'COM1', 'PING before-reload\n');
    await expect(page.locator('.terminal-line .terminal-content').filter({ hasText: 'PONG<PING before-reload>#1' })).toBeVisible();

    await page.locator('.titlebar-right button[title="设置"]').click();
    await page.locator('.modal-nav-item').filter({ hasText: '插件' }).click();
    const reload = page.getByRole('button', { name: '重载已安装代码', exact: true });
    await expect(reload).toBeEnabled();
    await reload.click();
    await expect.poll(() => page.evaluate(() => window.__PLUGIN_E2E__.reloads)).toBe(1);
    await expect(reload).toBeEnabled();

    await dispatchSerialData(page, 'COM1', 'PING after-reload\n');
    await expect(page.locator('.terminal-line .terminal-content').filter({ hasText: 'PONG<PING after-reload>#1' })).toBeVisible();
    await expect(page.locator('.terminal-line .terminal-content').filter({ hasText: 'PONG<' })).toHaveCount(2);
  });

  test('权限拒绝路径：未授予 terminal:read/write → 无 rx 转发、旁注被拒', async ({ page }) => {
    // 未授予任何权限：rxEligiblePluginIds 不含该插件（rx.line 不转发），
    // terminal.append 也会被调用时权限校验拒绝——PONG 永不出现。
    await openApp(page, []);
    await openCom1Tab(page);
    await dispatchSerialData(page, 'COM1', 'PING denied\n');
    await expect(page.locator('.terminal-line .terminal-content').first()).toContainText('PING denied');
    await expect(page.locator('.terminal-line .terminal-content').filter({ hasText: 'PONG<PING denied>' })).toHaveCount(0);
  });

  test('端口断线 → rx.detached(port-disconnected) → 插件写断流旁注', async ({ page }) => {
    await openApp(page, ['terminal:read', 'terminal:write']);
    await openCom1Tab(page);
    // 让宿主派发断线状态（useSerialReceive → notifyPortDisconnected → rx.detached）。
    await page.evaluate(() => {
      window.__TAURI_INTERNALS__.dispatchEvent('serial:status', { port_id: 'COM1', status: 'disconnected' });
    });
    await expect(page.locator('.terminal-line .terminal-content').filter({ hasText: 'RX-DETACHED:port-disconnected' })).toBeVisible();
  });
  test('插件工具入口位于标签栏并使用宿主浮层', async ({ page }) => {
    await openApp(page, ['ui:view']);
    const launcher = page.locator('.tab-bar-actions .plugin-view-picker-trigger');
    await expect(launcher).toBeVisible();
    await expect(page.locator('.tab-bar-actions select')).toHaveCount(0);
    await launcher.click();
    await expect(page.getByRole('listbox', { name: '打开插件工具页…' })).toBeVisible();
    await expect(page.locator('.plugin-view-picker-option-label').filter({ hasText: 'E2E Tool' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: '打开插件工具页…' })).toHaveCount(0);
  });

  test('终端插件选择器按内容占宽，与联动按钮没有预留空白', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, ['ui:view', 'rx:bytes']);
    await openCom1Tab(page);
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/stores/useAppStore.ts');
      useAppStore.getState().openTab('COM2');
      useAppStore.getState().splitPane('vertical');
    });
    const bar = page.locator('.terminal-filter-bar:visible').filter({ has: page.locator('.plugin-view-picker') }).first();
    const trigger = bar.locator('.plugin-view-picker-trigger');
    await expect(trigger).toBeVisible();
    for (const language of ['zh-CN', 'en-US']) {
      await page.evaluate(async language => {
        const { default: i18n } = await import('/src/i18n.ts'); await i18n.changeLanguage(language);
      }, language);
      for (const width of [1440, 980, 620]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(() => bar.evaluate(element => {
          const wrapper = element.querySelector('.plugin-view-picker')!.getBoundingClientRect();
          const button = element.querySelector('.plugin-view-picker-trigger')!.getBoundingClientRect();
          const link = element.querySelector('.timeline-entry')!.getBoundingClientRect();
          const gap = parseFloat(getComputedStyle(element).columnGap);
          return Math.abs(wrapper.width - button.width) < 1 && Math.abs(link.left - button.right - gap) < 1
            && Math.abs(link.top - button.top) <= 2 && button.width <= 120;
        })).toBe(true);
      }
    }
    await page.evaluate(async () => { const { default: i18n } = await import('/src/i18n.ts'); await i18n.changeLanguage('zh-CN'); });
    await trigger.click();
    await expect(page.getByRole('option', { name: /Sensor table/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /^终端/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.setViewportSize({ width: 1140, height: 900 });
    await bar.screenshot({ path: '.npm-cache/trx-picker-spacing.png', animations: 'disabled' });
  });

  test('普通 COM 标签绑定 Sensor table 在浏览器 native 边界明确降级不可用', async ({ page }) => {
    await openApp(page, ['ui:view', 'rx:bytes']);
    await openCom1Tab(page);
    await page.locator('.tab-bar-actions .plugin-view-picker-trigger').click();
    const table = page.getByRole('option', { name: 'Sensor table' });
    await expect(table).toBeVisible();
    await table.click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.locator('.tab-item.active')).toContainText('Sensor table');
    await expect(page.locator('.plugin-view-tab:visible .plugin-view-source-port')).toHaveText('· COM1');
    await expect(page.locator('.plugin-view-placeholder strong')).toHaveText('插件视图不可用');
    await expect(page.locator('.plugin-view-placeholder')).toContainText('Native plugin view unavailable in browser e2e');
    await expect(page.locator('.tab-item').filter({ hasText: 'COM1' })).toBeVisible();
    // Closing the unavailable tab exercises the explicit idempotent destroy boundary.
    await page.locator('.tab-item').filter({ hasText: 'Sensor table' }).locator('.tab-close').click();
    await expect(page.locator('.tab-item').filter({ hasText: 'Sensor table' })).toHaveCount(0);
  });
});
