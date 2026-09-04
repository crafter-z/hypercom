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

/** demo worker：PING → PONG 旁注；断流通知写旁注。普通脚本（无 ESM）。 */
const DEMO_WORKER = `
self.plugin.on('rx.line', function (lines) {
  for (var i = 0; i < lines.length; i++) {
    var text = new TextDecoder().decode(lines[i].rawData);
    if (text.indexOf('PING') !== -1) {
      self.plugin.api['terminal.append']({
        portId: lines[i].portId,
        text: 'PONG<' + text.trim() + '>',
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
  const state = { enabled: true, granted: seed.granted || ['terminal:read', 'terminal:write'] };
  const PLUGIN_VIEW = () => ({
    id: '${PLUGIN_ID}',
    dir: 'C:/mock/plugins/${PLUGIN_ID}',
    enabled: state.enabled,
    declaredPermissions: ['terminal:read', 'terminal:write'],
    knownPermissions: ['terminal:read', 'terminal:write'],
    manifest: {
      id: '${PLUGIN_ID}',
      name: 'E2E Demo',
      version: '1.0.0',
      description: 'e2e demo',
      apiVersion: '1.0',
      entry: 'main.js',
      permissions: ['terminal:read', 'terminal:write'],
    },
    manifestError: null,
    installedAt: 1,
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
      if (cmd === 'list_plugins') {
        const view = PLUGIN_VIEW();
        return {
          plugins: [view],
          pluginConfigs: [
            {
              id: '${PLUGIN_ID}',
              enabled: state.enabled,
              grantedPermissions: [...state.granted],
              installedAt: 1,
              source: 'zip',
            },
          ],
        };
      }
      if (cmd === 'read_plugin_asset') {
        if (args && args.relPath === 'main.js') return ${JSON.stringify(DEMO_WORKER)};
        if (args && args.relPath === 'manifest.json') return JSON.stringify(PLUGIN_VIEW().manifest);
        return '';
      }
      if (cmd === 'list_available_ports') {
        return [{ id: 'COM1', name: 'COM1', port_type: 'real', manufacturer: null, product: null }];
      }
      if (cmd === 'plugin:event|listen') {
        const id = nextId++;
        if (args && args.event) eventListeners[args.event] = args.handler;
        return id;
      }
      if (cmd === 'get_system_status')
        return { status: 'normal', memoryUsedMb: 0, cpuUsage: 0 };
      return null;
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
    await page.goto('/');
    await expect(page.locator('.app-root')).toBeVisible();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.type(), m.text());
    });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  }

  test('启用插件 → RX 注入 → 插件写 PONG 旁注（worker + RPC + 观察器全链路）', async ({ page }) => {
    await openApp(page, ['terminal:read', 'terminal:write']);
    await openCom1Tab(page);
    // 插件宿主 boot（refresh → 写回 store → 订阅 → syncWithConfig 拉 worker）。
    await dispatchSerialData(page, 'COM1', 'PING alpha\n');
    await expect(page.locator('.terminal-line .terminal-content').filter({ hasText: 'PONG<PING alpha>' })).toBeVisible();
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
});
