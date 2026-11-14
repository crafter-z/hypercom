import { test, expect, type Page } from '@playwright/test';
import { TAURI_MOCK } from './tauriMock';
import type { SerialPort, SendCommandSet, HighlightRuleSet, ProtocolTemplate, TriggerRule, TabItem } from '../src/types';

// Playwright creates parent directories for screenshots automatically.
const output = '.npm-cache/ui-polish/final';
const errors = new WeakMap<Page, string[]>();

const ports: SerialPort[] = [
  { id: 'COM1', name: 'COM1', alias: 'STM32 调试口', status: 'connected', type: 'real', isHidden: false, baudRate: 115200, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None' },
  { id: 'COM3', name: 'COM3', alias: '传感器总线', status: 'connected', type: 'real', isHidden: false, baudRate: 921600, dataBits: 8, parity: 'Even', stopBits: 'One', handshake: 'None' },
];
const commands: SendCommandSet[] = [{ id: 'ui-commands', name: '设备调试命令', isLoop: false, loopDelay: 1000, repeatCount: 1,
  commands: ['设备信息', '读取状态', '读取温度', '设置模式', '读取电压', '启动采集', '停止采集', '保存参数'].map((name, order) => ({
    id: `command-${order}`, name, order, delay: 25, type: 'string', content: ['AT+INFO?', 'AT+STATUS?', 'AT+TEMP?', 'AT+MODE=1', 'AT+VOLT?', 'AT+START', 'AT+STOP', 'AT+SAVE'][order], appendLineEnding: '\\r\\n',
  })),
}];
const highlights: HighlightRuleSet[] = [{ id: 'ui-highlight', name: '状态与告警', isEnabled: true, rules: [
  { id: 'ui-error', name: '错误', pattern: 'ERROR', isRegex: false, color: '#f48771', bold: true },
  { id: 'ui-warn', name: '警告', pattern: 'WARN', isRegex: false, color: '#dcdcaa', bold: true },
] }];
const protocols: ProtocolTemplate[] = [{ id: 'ui-protocol', name: '传感器帧 AA 55', isEnabled: true, headerBytes: 'AA 55', lengthFieldOffset: 2, lengthFieldSize: 1,
  lengthEndian: 'big', lengthAdjust: 0, checksumAlgorithm: 'xor', checksumOffset: 0, footerBytes: '0D 0A',
  colorHeader: '#4fc3f7', colorLength: '#ce9178', colorPayload: '#4ec9b0', colorChecksum: '#dcdcaa', colorFooter: '#9aa1b3',
}];
const triggers: TriggerRule[] = [{ id: 'ui-trigger', name: '错误自动告警', pattern: 'ERROR', isRegex: false, matchType: 'contains', actionType: 'alert', actionContent: '设备异常，请检查连接', actionIsHex: false, isEnabled: true, portId: 'COM1' }];

async function seed(page: Page, theme: 'dark' | 'light', language = 'zh-CN') {
  await page.evaluate(async ({ ports, commands, highlights, protocols, triggers, theme, language }) => {
    const appPath = '/src/stores/useAppStore.ts';
    const rulesPath = '/src/stores/useRuleStore.ts';
    const systemPath = '/src/stores/useSystemStore.ts';
    const persistencePath = '/src/hooks/useConfigPersistence.ts';
    const i18nPath = '/src/i18n.ts';
    const { useAppStore } = await import(appPath);
    const { useRuleStore } = await import(rulesPath);
    const { useSystemStore } = await import(systemPath);
    const { markOrdinaryConfigSaved } = await import(persistencePath);
    const { default: i18n } = await import(i18nPath);
    // Keep enumeration stable without intercepting any real application's IPC.
    const api = window.__TAURI_INTERNALS__;
    const invoke = api.invoke.bind(api);
    api.invoke = (command, args) => command === 'list_available_ports' ? Promise.resolve(ports) : invoke(command, args);
    useAppStore.setState({ ports });
    useAppStore.getState().setConfig({ theme, language, updateCheckMode: 'none', sendCommandSets: commands, highlightRuleSets: highlights, protocolTemplates: protocols, triggerRules: triggers });
    useRuleStore.getState().setSendCommandSets(commands);
    useRuleStore.getState().setHighlightRuleSets(highlights);
    useRuleStore.getState().setProtocolTemplates(protocols);
    useRuleStore.getState().setTriggerRules(triggers);
    markOrdinaryConfigSaved();
    useSystemStore.getState().setUIState({ operationPanelHeight: 296, configReady: true });
    useAppStore.getState().openTab('COM3');
    useAppStore.getState().openTab('COM1');
    await i18n.changeLanguage(language);
  }, { ports, commands, highlights, protocols, triggers, theme, language });
  await expect(page.locator('.terminal-view:visible').first()).toBeVisible();
  await page.evaluate(() => {
    const lines = [
      '[INFO] HyperCom instrument console ready',
      '[INFO] 传感器初始化完成：115200 baud / 8N1',
      '[DATA] T=24.6°C  H=58%  P=1013 hPa',
      '[WARN] 电池电压偏低：3.42 V',
      '[ERROR] 通信超时：从机地址 0x1A 无响应',
    ];
    window.__TAURI_INTERNALS__.dispatchEvent('serial:data', { port_id: 'COM1', timestamp: Date.now(), direction: 'RX', data: Array.from(new TextEncoder().encode(lines.join('\n') + '\n')), is_hex: false });
  });
  await expect(page.locator('.terminal-line').first()).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/stores/useToastStore.ts';
    const { useToastStore } = await import(path);
    useToastStore.getState().clearAll();
  });
}

async function openSettings(page: Page, tab: string) {
  await page.evaluate(async tab => {
    const path = '/src/stores/useSystemStore.ts';
    const { useSystemStore } = await import(path);
    useSystemStore.getState().setConfigActiveTab(tab);
    useSystemStore.getState().toggleConfigModal(true);
  }, tab);
  await expect(page.locator('.modal-dialog')).toBeVisible();
}

async function screenshot(page: Page, name: string, selector?: string) {
  await page.evaluate(() => document.fonts.ready);
  if (selector) await page.locator(selector).first().screenshot({ path: `${output}/${name}.png`, animations: 'disabled' });
  else await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' });
}

async function expectWithinViewport(page: Page, selector: string) {
  const boxes = await page.locator(selector).evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  }));
  const viewport = page.viewportSize()!;
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes.filter(box => box.width > 0 && box.height > 0)) {
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.top).toBeGreaterThanOrEqual(-1);
    expect(box.bottom).toBeLessThanOrEqual(viewport.height + 1);
  }
}

test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page)!.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.get(page)!.push(message.text()); });
  await page.addInitScript(TAURI_MOCK);
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/stores/useSystemStore.ts';
    const { useSystemStore } = await import(path);
    return useSystemStore.getState().ui.configReady;
  })).toBe(true);
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page) ?? []).toEqual([]);
  expect(await page.evaluate(() => window.__E2E_UNKNOWN_COMMANDS__ ?? [])).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  test(`workspace ${theme}: full, narrow and English layouts stay usable`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await seed(page, theme);
    await expectWithinViewport(page, '.op-send-btn, .op-line-ending-select, .statusbar, .titlebar-right');
    await screenshot(page, `workspace-${theme}`);
    await page.setViewportSize({ width: 1180, height: 720 });
    await expectWithinViewport(page, '.op-send-btn, .op-line-ending-select, .statusbar, .titlebar-right');
    await screenshot(page, `workspace-narrow-${theme}`);
    await page.evaluate(async () => {
      const path = '/src/i18n.ts';
      const { default: i18n } = await import(path);
      await i18n.changeLanguage('en-US');
    });
    await expect(page.locator('.op-send-btn')).toContainText('Send');
    await expectWithinViewport(page, '.op-send-btn, .op-line-ending-select, .statusbar, .titlebar-right');
    await screenshot(page, `workspace-english-${theme}`);
  });

  test(`settings ${theme}: all pages and dense editors render`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: 1440, height: 960 });
    await seed(page, theme);
    for (const tab of ['general', 'display', 'log', 'backup', 'plugins', 'tools', 'triggers', 'commands', 'protocol', 'highlight']) {
      await openSettings(page, tab);
      if (['commands', 'protocol', 'highlight'].includes(tab)) {
        const expand = page.locator('.editor-accordion-header button[aria-expanded="false"]').first();
        if (await expand.count()) await expand.click();
        await expect(page.locator('.editor-accordion-body').first()).toBeVisible();
      }
      await expectWithinViewport(page, '.modal-dialog, .modal-content-footer');
      if (tab === 'commands') {
        const body = await page.locator('.modal-content-body').boundingBox();
        const sixth = await page.locator('.command-step-row').nth(5).boundingBox();
        expect(body).not.toBeNull();
        expect(sixth).not.toBeNull();
        expect(sixth!.y + sixth!.height, 'six complete commands in the default settings window').toBeLessThanOrEqual(body!.y + body!.height + 1);
      }
      await screenshot(page, `settings-${tab}-${theme}`, '.modal-dialog');
    }
  });
}

test('active port follows selected serial tab, not connection state', async ({ page }) => {
  await seed(page, 'dark');
  // Both ports stay connected while changing only the active workspace tab.
  await page.evaluate(async () => {
    const path = '/src/stores/useAppStore.ts';
    const { useAppStore } = await import(path);
    const state = useAppStore.getState();
    const tab = (state.tabs as TabItem[]).find(tab => tab.kind === 'serial' && tab.portId === 'COM3');
    state.setActiveTab(tab!.id);
  });
  await expect(page.locator('.operation-panel-header')).toContainText('COM3');
  await expect(page.locator('.port-item[aria-current="true"]')).toContainText('COM3');
  await expect(page.locator('.port-item.connected')).toHaveCount(2);
});

test('protocol preview, contrast samples and expanded editing preserve drafts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await seed(page, 'dark');
  await openSettings(page, 'protocol');
  await page.locator('.editor-accordion-header button[aria-expanded="false"]').first().click();
  const segments = page.locator('.protocol-structure-summary__segment');
  await expect(segments).toHaveCount(5);
  await expect(page.locator('.protocol-structure-summary__segments')).toHaveCSS('display', 'grid');
  await segments.first().click();
  await expect(page.locator('#protocol-header-ui-protocol')).toBeFocused();
  await page.locator('#protocol-header-ui-protocol').fill('AA 66');
  await expect(segments.first()).toContainText('AA 66');
  const before = await page.locator('.modal-dialog').boundingBox();
  await page.getByRole('button', { name: '扩大编辑空间', exact: true }).click();
  const expanded = await page.locator('.modal-dialog').boundingBox();
  expect(expanded!.width).toBeGreaterThan(before!.width);
  await expect(page.locator('#protocol-header-ui-protocol')).toHaveValue('AA 66');
  await screenshot(page, 'protocol-expanded-dark', '.modal-dialog');
  await page.getByRole('button', { name: '恢复紧凑窗口', exact: true }).click();
  await openSettings(page, 'highlight');
  await page.locator('.editor-accordion-header button[aria-expanded="false"]').first().click();
  await expect(page.locator('.rule-preview__sample--light').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.rule-preview__sample--dark').first()).toHaveCSS('background-color', 'rgb(25, 26, 30)');
  await expect(page.locator('.rule-preview__contrast--warning').first()).toBeVisible();
  await openSettings(page, 'protocol');
  await expect(page.locator('#protocol-header-ui-protocol')).toHaveValue('AA 66');
});

test('notification dismissal does not navigate and status popovers are not clipped', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 720 });
  await seed(page, 'dark');
  await page.evaluate(async () => {
    const path = '/src/stores/useToastStore.ts';
    const { useToastStore } = await import(path);
    useToastStore.getState().push({ severity: 'warning', title: '传感器告警', message: '电池电压偏低：3.42 V', portId: 'COM3', durationMs: 0 });
    useToastStore.getState().push({ severity: 'success', title: '设备自检完成', message: '设备已进入采集模式。', durationMs: 0 });
  });
  await page.locator('.notify-btn').click();
  await expect(page.locator('.notify-severity-icon')).toHaveCount(2);
  await expect(page.locator('.notify-row-actionable')).toHaveCount(1);
  await expectWithinViewport(page, '.notify-panel');
  await screenshot(page, 'notifications-dark');
  // A real click proves the panel is not merely present behind an overflow clip.
  await page.locator('.notify-row:not(.notify-row-actionable) .notify-row-dismiss').click();
  await page.locator('.notify-row-dismiss').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.notify-row')).toHaveCount(0);
  await expect(page.locator('.operation-panel-header')).toContainText('COM1');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '状态详情', exact: true }).click();
  await expect(page.locator('.statusbar-details-panel')).toBeVisible();
  await expectWithinViewport(page, '.statusbar-details-panel');
  await page.keyboard.press('Escape');
  await expect(page.locator('.statusbar-details-panel')).toHaveCount(0);
});

test('split divider supports keyboard nudges from the authoritative pane tree', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await seed(page, 'dark');
  await page.evaluate(async () => {
    const path = '/src/stores/useAppStore.ts';
    const { useAppStore } = await import(path);
    useAppStore.getState().splitPane('vertical');
  });
  const divider = page.getByRole('separator', { name: '调整左右分屏宽度' });
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
  const before = Number(await divider.getAttribute('aria-valuenow'));
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
  await screenshot(page, 'split-dark');
});
