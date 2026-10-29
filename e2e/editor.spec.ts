import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const BACKEND_KEY = 'editor-regression.config';

/** Persistence and event boundaries only; all editing is exercised through the real UI. */
async function installBackend(page: Page) {
  await page.addInitScript(({ key }) => {
    let nextId = 1;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const channel = new BroadcastChannel('editor-regression.events');
    const dispatch = ({ event, payload }: { event: string; payload: unknown }) => {
      if (event === 'command-editor:snapshot' && payload && typeof payload === 'object' && 'sessionId' in payload && typeof payload.sessionId === 'string') {
        document.documentElement.dataset.editorHostSession = payload.sessionId;
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
        if (command === 'list_available_ports') return [];
        if (command === 'list_plugins') return { revision: config()?.revision ?? 0, pluginConfigs: [], plugins: [] };
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
          dispatch(event);
          channel.postMessage(event);
          return;
        }
        return null;
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

test.beforeEach(async ({ page }) => {
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
  await page.reload();
  await expect.poll(() => panel.locator('html').getAttribute('data-editor-host-session')).not.toBe(hostSession);
  await expect(panel.locator('.quicksend-row')).toHaveCount(2);
  const editButton = panel.getByRole('button', { name: '修改', exact: true }).first();
  if (await editButton.getAttribute('aria-expanded') !== 'true') await editButton.click();
  await panel.getByRole('textbox', { name: '命令内容', exact: true }).fill('AFTER HOST RELOAD');
  await panel.locator('.quicksend-draft-actions').getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.locator('.quicksend-draft-actions')).toContainText('已保存');
  expect((await persisted(page)).sendCommandSets[0].commands[0].content).toBe('AFTER HOST RELOAD');
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
