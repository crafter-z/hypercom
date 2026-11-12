import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { CommandEditorSnapshot, CommandEditorSyncRequest } from '../src/services/popout';

const BACKEND_KEY = 'editor-regression.config';
const browserErrors = new WeakMap<Page, string[]>();

/** Persistence and event boundaries only; all editing is exercised through the real UI. */
async function installBackend(page: Page) {
  await page.addInitScript(({ key }) => {
    let nextId = 1;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const channel = new BroadcastChannel('editor-regression.events');
    let syncRequest: CommandEditorSyncRequest | undefined;
    const dispatch = ({ event, payload }: { event: string; payload: unknown }) => {
      if (event === 'command-editor:snapshot' && payload && typeof payload === 'object') {
        const snapshot = payload as CommandEditorSnapshot;
        // A broadcast/challenge only announces a host; the panel still uses its
        // old authority until the correlated client-binding confirmation arrives.
        if (syncRequest && snapshot.clientProtocol === 2 && !snapshot.challengeId &&
          snapshot.clientId === syncRequest.clientId && snapshot.syncRequestId === syncRequest.syncRequestId) {
          document.documentElement.dataset.editorHostSession = snapshot.sessionId;
        }
      }
      for (const [id, listener] of listeners) {
        if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
      }
    };
    channel.onmessage = event => dispatch(event.data);
    const config = () => JSON.parse(localStorage.getItem(key) ?? 'null');
    const loads: Record<string, string> = {
      load_command_sets: 'sendCommandSets', load_highlight_sets: 'highlightRuleSets',
      load_protocol_templates: 'protocolTemplates', load_trigger_rules: 'triggerRules',
      load_port_tool_configs: 'portToolConfigs', load_port_presets: 'portPresets',
    };
    const api = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'get_config') return config();
        if (command === 'set_config') {
          if (localStorage.getItem('editor-regression.fail-save')) throw new Error('Disk unavailable');
          const before = config();
          if (args.expectedRevision !== before.revision) return false;
          localStorage.setItem(key, JSON.stringify({ ...(args.newConfig as object), revision: before.revision + 1 }));
          return true;
        }
        if (loads[command]) return config()?.[loads[command]] ?? [];
        if (command === 'list_available_ports') return JSON.parse(localStorage.getItem('editor-regression.ports') ?? '[]');
        if (command === 'list_plugins') return { revision: config()?.revision ?? 0, pluginConfigs: [], plugins: [] };
        if (command === 'plugin:app|version') return '1.0.0-e2e';
        if (command === 'set_serial_params' || command === 'send_serial_data') {
          const traceKey = command === 'set_serial_params' ? 'editor-regression.param-calls' : 'editor-regression.tx-calls';
          const calls = JSON.parse(localStorage.getItem(traceKey) ?? '[]');
          calls.push(args.args);
          localStorage.setItem(traceKey, JSON.stringify(calls));
          return command === 'set_serial_params' ? null : 0;
        }
        if (command === 'open_serial_port' || command === 'close_serial_port'
          || command === 'set_flow_control' || command === 'attempt_reconnect' || command === 'cancel_file_send') return null;
        if (command === 'send_file') return 0;
        if (command === 'acknowledge_editor_close' || command === 'complete_editor_close' || command === 'cancel_editor_close'
          || command === 'plugin:window|set_title' || command === 'prevent_screen_off' || command === 'prevent_sleep'
          || command === 'plugin:webview|set_webview_zoom' || command === 'append_diag_log') return null;
        if (command === 'plugin:window|is_maximized') return false;
        if (command === 'get_session_snapshot' || command === 'update_session_snapshot' || command === 'append_diag_log') return null;
        if (command === 'get_system_status') return { status: 'normal', memoryUsedMb: 0, cpuUsage: 0 };
        if (command === 'get_config_path') return 'editor-regression/config.json';
        if (command === 'get_log_files') return [];
        if (command === 'plugin:event|listen') {
          const id = nextId++;
          listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
          return id;
        }
        if (command === 'plugin:event|unlisten') { listeners.delete(Number(args.eventId)); return; }
        if (command === 'plugin:event|emit' || command === 'plugin:event|emit_to') {
          const event = { event: String(args.event), payload: args.payload };
          if (event.event === 'popout:request-sync') {
            syncRequest = event.payload as CommandEditorSyncRequest;
            if (localStorage.getItem('editor-regression.hold-sync')) {
              document.documentElement.dataset.editorSyncBlocked = 'true';
              await new Promise<void>(resolve => window.addEventListener('editor-regression.release-sync', () => resolve(), { once: true }));
              delete document.documentElement.dataset.editorSyncBlocked;
            }
          }
          dispatch(event);
          channel.postMessage(event);
          return;
        }
        (window.__E2E_UNKNOWN_COMMANDS__ ||= []).push(command);
        throw new Error('Unhandled mocked Tauri command: ' + command);
      },
      transformCallback: (callback: (value: unknown) => void, once = false) => {
        const id = nextId++;
        callbacks.set(id, value => { if (once) callbacks.delete(id); callback(value); });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      metadata: {
        currentWindow: { label: location.search.includes('popout=') ? 'quick-send' : 'main' },
        currentWebview: { windowLabel: location.search.includes('popout=') ? 'quick-send' : 'main', label: 'main' },
      },
      convertFileSrc: (path: string) => path,
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: api,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, { key: BACKEND_KEY });
}

async function openCommands(page: Page) {
  await page.locator('.titlebar-right button[title="设置"]').click();
  await page.locator('.modal-nav-item').filter({ hasText: '发送命令规则' }).click();
  const toggle = page.getByRole('button', { name: 'Fixture commands', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

async function persisted(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), BACKEND_KEY);
}

function consumeExpectedDiskError(page: Page): void {
  const errors = browserErrors.get(page) ?? [];
  const expected = errors.filter((error) =>
    error.startsWith('console.error: [useConfigPersistence] Failed to save config: Error: Disk unavailable')
  );
  expect(expected).toHaveLength(1);
  errors.splice(errors.indexOf(expected[0]), 1);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  await installBackend(page);
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.evaluate(async key => {
    // Static Node imports cannot initialize the browser realm's store.
    const path = '/src/stores/useAppStore.ts';
    const { useAppStore } = await import(path);
    const command = (id: string, order: number) => ({ id, name: id, content: id, order, delay: 25, type: 'string', appendLineEnding: 'None' });
    const config = {
      ...useAppStore.getState().config, revision: 0, language: 'zh-CN', updateCheckMode: 'none',
      sendCommandSets: [{ id: 'commands', name: 'Fixture commands', commands: [command('A', 0), command('B', 1)], isLoop: false, loopDelay: 0, repeatCount: 1 }],
      triggerRules: [{ id: 'trigger', name: 'Fixture trigger', pattern: 'ready', matchType: 'contains', isRegex: false, actionType: 'alert', actionContent: 'old alert', actionIsHex: false, isEnabled: true }],
      highlightRuleSets: [{ id: 'highlight', name: 'Fixture highlight', isEnabled: true, rules: [{ id: 'red', name: 'red', pattern: 'warning', isRegex: false, color: '#ff0000' }] }],
    };
    localStorage.setItem(key, JSON.stringify(config));
  }, BACKEND_KEY);
  await page.reload();
  await expect(page.locator('.app-root')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([]);
  const unknown = await page.evaluate(() => window.__E2E_UNKNOWN_COMMANDS__ ?? []);
  expect(unknown, 'mocked unknown Tauri commands').toEqual([]);
});

test('run settings stay out of the title bar and finite repeats expose the round gap', async ({ page }) => {
  await openCommands(page);
  const header = page.locator('.editor-accordion-header');
  await expect(header.getByRole('spinbutton')).toHaveCount(0);
  await expect(header.getByRole('checkbox')).toHaveCount(0);
  const run = page.getByRole('region', { name: '运行设置', exact: true });
  const repeat = run.getByRole('spinbutton', { name: '重复', exact: true });
  const gap = run.getByRole('spinbutton', { name: '轮间间隔 (ms)', exact: true });
  await expect(gap).toBeDisabled();
  await repeat.fill('3');
  await repeat.press('Tab');
  await expect(gap).toBeEnabled();
  await expect(run.getByRole('checkbox', { name: '循环', exact: true })).not.toBeChecked();
  await gap.fill('250');
  await gap.press('Tab');
  expect((await persisted(page)).sendCommandSets[0].loopDelay).toBe(0);
  await page.locator('.editor-status').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.editor-status')).toContainText('已保存');
  expect((await persisted(page)).sendCommandSets[0]).toMatchObject({ repeatCount: 3, isLoop: false, loopDelay: 250 });
});

test('compact command editor fits six editable commands and stays within narrow settings columns', async ({ page }, testInfo) => {
  await page.evaluate(key => {
    const config = JSON.parse(localStorage.getItem(key)!);
    const names = ['设备信息', '读取状态', '读取温度', '设置模式', '读取电压', '启动采集', '停止采集', '保存参数'];
    const contents = ['AT+INFO?', 'AT+STATUS?', 'AT+TEMP?', 'AT+MODE=1', 'AT+VOLT?', 'AT+START', 'AT+STOP', 'AT+SAVE'];
    config.sendCommandSets[0].name = '设备调试命令';
    config.sendCommandSets[0].commands = names.map((name, order) => ({ id: `dense-${order}`, name, content: contents[order], order, delay: 25, type: 'string', appendLineEnding: '\\r\\n' }));
    localStorage.setItem(key, JSON.stringify(config));
  }, BACKEND_KEY);
  await page.reload();
  await page.locator('.titlebar-right button[title="设置"]').click();
  await page.locator('.modal-nav-item').filter({ hasText: '发送命令规则' }).click();
  const toggle = page.getByRole('button', { name: '设备调试命令', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const card = page.locator('.command-step-row').first();
  await expect(card.getByRole('combobox', { name: '格式', exact: true })).toBeVisible();
  await expect(card.getByRole('combobox', { name: '行尾', exact: true })).toBeVisible();
  await expect(card.getByRole('textbox', { name: '命令内容...', exact: true })).toHaveValue('AT+INFO?');
  // 密度是验收条件：默认 800×600 弹窗内完整显示至少六条可编辑命令。
  const footerBox = await page.locator('.modal-content-footer').boundingBox();
  for (const row of (await page.locator('.command-step-row').all()).slice(0, 6)) {
    const box = await row.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(64);
    expect(box!.y + box!.height).toBeLessThanOrEqual(footerBox!.y);
  }
  const details = page.locator('.command-behavior-details');
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  await details.locator('summary').click();

  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await expect.poll(() => page.locator('.modal-content-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.locator('.modal-dialog').screenshot({ path: testInfo.outputPath(`commands-${theme}.png`) });
  }
  await page.setViewportSize({ width: 720, height: 800 });
  await page.evaluate(async () => {
    const modulePath = '/src/i18n.ts';
    const { default: i18n } = await import(modulePath);
    await i18n.changeLanguage('en-US');
  });
  await expect(card.getByRole('combobox', { name: 'Line ending', exact: true })).toBeVisible();
  for (const width of [720, 600]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.locator('.modal-content-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const cardBox = await card.boundingBox();
    for (const control of await card.locator('input, select, button').all()) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(cardBox!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    }
    await page.locator('.modal-dialog').screenshot({ path: testInfo.outputPath(`commands-${width}-en.png`) });
  }
  await expect.poll(() => page.locator('.modal-content-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.locator('.modal-dialog').screenshot({ path: testInfo.outputPath('commands-run-settings-narrow-en.png') });
});

test('the unified command toolbar adds baud steps with focus and saves their enhanced schema', async ({ page }) => {
  await openCommands(page);
  await page.locator('.command-list-toolbar').getByRole('button', { name: '添加波特率步骤', exact: true }).click();
  const step = page.locator('.command-step-row').last();
  await expect(step.getByRole('textbox', { name: '名称', exact: true })).toBeFocused();
  await expect(step.getByRole('combobox', { name: '步骤类型', exact: true })).toHaveValue('setParams');
  await expect(step.getByRole('spinbutton', { name: '本机波特率', exact: true })).toHaveValue('230400');
  await expect(page.getByPlaceholder('命令内容...')).toHaveCount(2);
  await page.locator('.editor-status').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.editor-status')).toContainText('已保存');
  const set = (await persisted(page)).sendCommandSets[0];
  expect(set.schemaVersion).toBe(2);
  expect(set.commands.map((command: { order: number }) => command.order)).toEqual([0, 1, 2]);
  expect(set.commands[2]).toMatchObject({ kind: 'setParams', baudRate: 230400, delay: 0 });
});

test('baud steps execute from capsules and the separate command panel without sending empty data', async ({ page, context }) => {
  await page.evaluate(key => {
    const config = JSON.parse(localStorage.getItem(key)!);
    config.quickSendInlineCount = 10;
    config.sendCommandSets[0] = {
      ...config.sendCommandSets[0], schemaVersion: 2, commands: [
        { id: 'baud', name: '切换 230400', kind: 'setParams', baudRate: 230400, content: '', type: 'string', appendLineEnding: 'None', delay: 5000, order: 0 },
        { id: 'ping', name: 'PING', content: 'PING', type: 'string', appendLineEnding: 'None', delay: 0, order: 1 },
      ],
    };
    localStorage.setItem(key, JSON.stringify(config));
    localStorage.setItem('editor-regression.ports', JSON.stringify(['COM1', 'COM2'].map(id => ({ id, name: id, port_type: 'real' }))));
  }, BACKEND_KEY);
  await page.reload();
  await page.evaluate(async () => {
    const path = '/src/stores/useAppStore.ts';
    const { useAppStore } = await import(path);
    useAppStore.setState({ ports: ['COM1', 'COM2'].map(id => ({
      id, name: id, type: 'real', status: 'connected', isHidden: false, mode: 'trx', connectionGeneration: 7,
      baudRate: id === 'COM1' ? 9600 : 38400, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None',
    })) });
    useAppStore.getState().openTab('COM1');
  });
  const calls = (key: string) => page.evaluate(value => JSON.parse(localStorage.getItem(value) ?? '[]'), key);
  const capsule = page.locator('.op-quick-send-row > .op-quick-cmd').filter({ hasText: '切换 230400' });
  await expect(capsule).toBeEnabled();
  await expect(capsule).toContainText('230400 baud');
  await capsule.click();
  await expect.poll(() => calls('editor-regression.param-calls')).toHaveLength(1);
  expect((await calls('editor-regression.param-calls'))[0]).toMatchObject({ port_id: 'COM1', baud_rate: 230400, expected_generation: 7, data_bits: 8 });
  expect(await calls('editor-regression.tx-calls')).toEqual([]);

  await page.evaluate(async () => {
    const path = '/src/stores/useAppStore.ts';
    const { useAppStore } = await import(path);
    useAppStore.getState().updatePort('COM1', { baudRate: 9600 });
    useAppStore.getState().openTab('COM2');
  });
  const panel = await context.newPage();
  await installBackend(panel);
  const panelErrors: string[] = [];
  panel.on('pageerror', error => panelErrors.push(error.message));
  await panel.goto('/?popout=quick-send');
  const row = panel.getByRole('group', { name: '切换 230400', exact: true });
  await expect(row).toBeVisible();
  await panel.locator('.quicksend-params select[title="目标串口"]').selectOption('COM1');
  await expect(row).not.toHaveClass(/is-send-disabled/);
  await row.click();
  await expect.poll(() => calls('editor-regression.param-calls')).toHaveLength(2);
  expect((await calls('editor-regression.param-calls'))[1]).toMatchObject({ port_id: 'COM1', baud_rate: 230400 });
  const state = await page.evaluate(async () => {
    const appPath = '/src/stores/useAppStore.ts';
    const operationPath = '/src/stores/useOperationStore.ts';
    const { useAppStore } = await import(appPath);
    const { useOperationStore } = await import(operationPath);
    return { baud: useAppStore.getState().ports.find((port: { id: string }) => port.id === 'COM1')?.baudRate, focusedBaud: useOperationStore.getState().baudRate, loops: useOperationStore.getState().cyclicLoops };
  });
  expect(state).toMatchObject({ baud: 230400, focusedBaud: 38400 });
  expect(Object.values(state.loops).some(Boolean)).toBe(false);
  expect(await calls('editor-regression.tx-calls')).toEqual([]);
  await panel.getByRole('group', { name: 'PING', exact: true }).click();
  await expect.poll(() => calls('editor-regression.tx-calls')).toHaveLength(1);
  expect((await calls('editor-regression.tx-calls'))[0]).toMatchObject({ port_id: 'COM1', data: 'PING' });
  expect(panelErrors).toEqual([]);
  expect(await panel.evaluate(() => window.__E2E_UNKNOWN_COMMANDS__ ?? [])).toEqual([]);
  await panel.close();
});

test('insertion survives navigation; discard restores the saved set and failed save retains the draft', async ({ page }) => {
  await openCommands(page);
  await page.locator('.editor-accordion-body').getByRole('button', { name: '在下方插入', exact: true }).first().click();
  await expect(page.getByPlaceholder('命令内容...').nth(1)).toBeFocused();
  await page.getByPlaceholder('命令内容...').nth(1).fill('INSERTED');
  await page.locator('.modal-nav-item').filter({ hasText: '日志设置' }).click();
  await page.locator('.modal-nav-item').filter({ hasText: '发送命令规则' }).click();
  await expect(page.getByPlaceholder('命令内容...').nth(1)).toHaveValue('INSERTED');
  expect((await persisted(page)).sendCommandSets[0].commands.map((item: { content: string }) => item.content)).toEqual(['A', 'B']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByPlaceholder('命令内容...').nth(1)).toHaveValue('INSERTED');
  await page.evaluate(() => localStorage.setItem('editor-regression.fail-save', '1'));
  await page.locator('.modal-content-footer .btn-primary').click();
  await expect(page.locator('.modal-dialog')).toBeVisible();
  consumeExpectedDiskError(page);
  await expect(page.getByPlaceholder('命令内容...').nth(1)).toHaveValue('INSERTED');
  await page.locator('.modal-content-header button').click();
  await page.getByRole('button', { name: '放弃并关闭', exact: true }).click();
  await expect(page.locator('.modal-dialog')).toHaveCount(0);
  await openCommands(page);
  await expect(page.getByPlaceholder('命令内容...')).toHaveCount(2);
});

test('keyboard sorting changes persisted execution order and reload restores it', async ({ page }) => {
  await openCommands(page);
  const handle = page.locator('.editor-accordion-body .editor-drag-handle').first();
  await handle.focus();
  await handle.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  // KeyboardSensor installs its document keydown listener in a zero-delay
  // timer *after* aria-pressed changes. Drain that timer turn before sending
  // movement; Chromium input can otherwise overtake the deferred attachment.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  await handle.press('ArrowDown');
  await expect.poll(async () => {
    const rows = page.locator('.editor-accordion-body .editor-sortable-row');
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    return first !== null && second !== null && first.y > second.y;
  }).toBe(true);
  await handle.press('Space');
  await expect(page.getByPlaceholder('命令内容...').first()).toHaveValue('B');
  await page.locator('.editor-status').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.editor-status')).toContainText('已保存');
  expect((await persisted(page)).sendCommandSets[0].commands.map((item: { content: string; order: number }) => [item.content, item.order])).toEqual([['B', 0], ['A', 1]]);
  await page.reload();
  await openCommands(page);
  await expect(page.getByPlaceholder('命令内容...').first()).toHaveValue('B');
});

test('reminder and highlight drafts do not apply or save until explicit save; hidden pages are included', async ({ page }) => {
  await page.locator('.titlebar-right button[title="设置"]').click();
  await page.locator('.modal-nav-item').filter({ hasText: '条件触发' }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('Edited trigger');
  await page.locator('.modal-nav-item').filter({ hasText: '语法高亮规则' }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('Edited highlight');
  await page.locator('.modal-nav-item').filter({ hasText: '通用设置' }).click();
  const path = '/src/stores/useRuleStore.ts';
  const runtime = await page.evaluate(async modulePath => {
    // Static imports would inspect the test process, not the running WebView.
    const { useRuleStore } = await import(modulePath);
    return { trigger: useRuleStore.getState().triggerRules[0].name, highlight: useRuleStore.getState().highlightRuleSets[0].name };
  }, path);
  expect(runtime).toEqual({ trigger: 'Fixture trigger', highlight: 'Fixture highlight' });
  expect((await persisted(page)).triggerRules[0].name).toBe('Fixture trigger');
  await page.locator('.modal-content-footer .btn-primary').click();
  await expect(page.locator('.modal-dialog')).toHaveCount(0);
  const saved = await persisted(page);
  expect(saved.triggerRules[0].name).toBe('Edited trigger');
  expect(saved.highlightRuleSets[0].name).toBe('Edited highlight');
});

test('command panel shares unsaved drafts with settings and retains them after a failed host save', async ({ page, context }) => {
  const panel = await context.newPage();
  await installBackend(panel);
  const panelErrors: string[] = [];
  panel.on('pageerror', (error) => panelErrors.push(`pageerror: ${error.message}`));
  panel.on('console', (message) => {
    if (message.type() === 'error') panelErrors.push(`console.error: ${message.text()}`);
  });
  await panel.goto('/?popout=quick-send');
  await expect(panel.locator('.quicksend-row')).toHaveCount(2);
  await panel.getByRole('button', { name: '修改', exact: true }).first().click();
  await panel.getByRole('textbox', { name: '命令内容', exact: true }).fill('PANEL DRAFT');
  await panel.getByRole('tab', { name: '文本模式', exact: true }).click();
  await panel.getByRole('tab', { name: '命令列表', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '命令内容', exact: true })).toHaveValue('PANEL DRAFT');
  await openCommands(page);
  await expect(page.getByPlaceholder('命令内容...').first()).toHaveValue('PANEL DRAFT');
  expect((await persisted(page)).sendCommandSets[0].commands[0].content).toBe('A');
  await page.evaluate(() => localStorage.setItem('editor-regression.fail-save', '1'));
  await panel.locator('.quicksend-draft-actions').getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.locator('[role="alert"]')).toBeVisible();
  await expect(panel.getByRole('textbox', { name: '命令内容', exact: true })).toHaveValue('PANEL DRAFT');
  expect((await persisted(page)).sendCommandSets[0].commands[0].content).toBe('A');
  await page.evaluate(() => localStorage.removeItem('editor-regression.fail-save'));
  await page.locator('.editor-status').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.editor-status')).toContainText('已保存');
  await expect.poll(async () => (await persisted(page)).sendCommandSets[0].commands[0].content).toBe('PANEL DRAFT');
  await expect(panel.locator('.quicksend-draft-actions')).toContainText('已保存');
  // Backup import reloads the main host while the panel can remain open.
  const hostSession = await panel.locator('html').getAttribute('data-editor-host-session');
  await panel.evaluate(() => localStorage.setItem('editor-regression.hold-sync', '1'));
  await page.reload();
  // Hold the transport, not a timer: the reload announcement must not count as
  // ready while the still-visible rows belong to the previous host session.
  await expect(panel.locator('html')).toHaveAttribute('data-editor-sync-blocked', 'true');
  expect(await panel.locator('html').getAttribute('data-editor-host-session')).toBe(hostSession);
  await panel.evaluate(() => {
    localStorage.removeItem('editor-regression.hold-sync');
    window.dispatchEvent(new Event('editor-regression.release-sync'));
  });
  await expect.poll(() => panel.locator('html').getAttribute('data-editor-host-session')).not.toBe(hostSession);
  await expect(panel.locator('.quicksend-row')).toHaveCount(2);
  const editButton = panel.getByRole('button', { name: '修改', exact: true }).first();
  if (await editButton.getAttribute('aria-expanded') !== 'true') await editButton.click();
  await expect(panel.getByRole('textbox', { name: '命令内容', exact: true })).toHaveValue('PANEL DRAFT');
  await expect(panel.locator('[role="alert"]')).toHaveCount(0);
  await panel.getByRole('textbox', { name: '命令内容', exact: true }).fill('AFTER HOST RELOAD');
  await panel.locator('.quicksend-draft-actions').getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.locator('.quicksend-draft-actions')).toContainText('已保存');
  expect((await persisted(page)).sendCommandSets[0].commands[0].content).toBe('AFTER HOST RELOAD');
  expect(panelErrors).toEqual([]);
  expect(await panel.evaluate(() => window.__E2E_UNKNOWN_COMMANDS__ ?? [])).toEqual([]);
  await panel.close();
});

test('editing after an individual save is preserved by a later full settings save', async ({ page }) => {
  await openCommands(page);
  const name = page.locator('.editor-accordion-header').getByRole('textbox', { name: '名称', exact: true });
  await name.fill('Saved once');
  await page.locator('.editor-accordion-header').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.editor-status')).toContainText('已保存');
  await page.locator('.modal-content-header button').click();
  await expect(page.locator('.modal-dialog')).toHaveCount(0);
  await page.locator('.titlebar-right button[title="设置"]').click();
  await expect(name).toHaveValue('Saved once');
  await name.fill('Latest edit');
  await page.locator('.modal-content-footer .btn-primary').click();
  await expect(page.locator('.modal-dialog')).toHaveCount(0);
  await page.reload();
  await page.locator('.titlebar-right button[title="设置"]').click();
  await page.locator('.modal-nav-item').filter({ hasText: '发送命令规则' }).click();
  await expect(name).toHaveValue('Latest edit');
  expect((await persisted(page)).sendCommandSets[0].name).toBe('Latest edit');
});
