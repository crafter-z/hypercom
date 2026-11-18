import { expect, test, type Page } from '@playwright/test';
import { TAURI_MOCK } from './tauriMock';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(TAURI_MOCK); await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.locator('.port-item-name', { hasText: 'COM1' }).dblclick();
  await expect(page.locator('.terminal-view:visible')).toBeVisible();
});

async function localOptions(page: Page) {
  await page.locator('.terminal-search-bar').getByRole('button', { name: '高级选项', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '高级选项', exact: true });
  await expect(panel).toBeVisible(); return panel;
}
async function localMode(page: Page, label: string) {
  const panel = await localOptions(page);
  await panel.getByRole('radio', { name: label, exact: true }).click();
  await panel.getByRole('button', { name: '关闭高级选项', exact: true }).click();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 600 }]) {
  test(`global search uses existing title-bar chrome without a workspace row (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const trigger = page.locator('.titlebar-right .global-terminal-search-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAccessibleName('全局搜索');
    await expect(page.locator('.global-terminal-search-entry')).toHaveCount(0);
    const [button, peer, workspace, panes] = await Promise.all([
      trigger.boundingBox(), page.locator('.titlebar-pin').boundingBox(),
      page.locator('.main-display').boundingBox(), page.locator('.panes-layout').boundingBox(),
    ]);
    expect(button!.height).toBe(peer!.height); expect(button!.width).toBe(peer!.width);
    expect(button!.x + button!.width).toBeLessThanOrEqual(viewport.width);
    expect(Math.abs(panes!.y - workspace!.y)).toBeLessThan(1);
    await page.screenshot({ path: `.npm-cache/global-search-titlebar-${viewport.width}.png` });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '全局终端搜索' });
    await expect(dialog).toBeVisible(); await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
    await page.keyboard.press('Control+Shift+f'); await expect(dialog).toBeVisible();
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 600 }]) {
  test(`advanced controls are a secondary entry, preserve terminal height and fit the viewport (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => {
      const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
      getViewportManager('COM1').appendLines(['INFO boot complete', 'RX packet ready', 'INFO device online', 'RX packet accepted'].map(content => ({ timestamp: 1, direction: 'RX', content, isHex: false })));
    });
    await page.locator('.terminal-view:visible').focus(); await page.keyboard.press('Control+f');
    await page.locator('.terminal-search-input').fill('packet');
    await expect(page.locator('.terminal-search-counter')).toHaveText('1/2');
    await expect(page.locator('.search-advanced-panel')).toHaveCount(0);
    await expect(page.locator('.terminal-search-options')).toHaveCount(0);
    const before = await page.locator('.terminal-view:visible').boundingBox();
    await page.screenshot({ path: `.npm-cache/search-primary-${viewport.width}.png` });
    if (process.env.HYPERCOM_UPDATE_SEARCH_GUIDE === '1' && viewport.width === 1280) {
      await page.locator('.terminal-search-container').screenshot({ path: 'docs/userwiki/images/terminal-search.png' });
    }
    const advanced = await localOptions(page);
    const after = await page.locator('.terminal-view:visible').boundingBox();
    expect(after!.height).toBe(before!.height); expect(after!.y).toBe(before!.y);
    const bounds = await advanced.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await advanced.getByRole('radio', { name: '普通文本', exact: true }).click();
    await page.screenshot({ path: `.npm-cache/search-advanced-${viewport.width}.png` });
    if (process.env.HYPERCOM_UPDATE_SEARCH_GUIDE === '1' && viewport.width === 1280) {
      await advanced.screenshot({ path: 'docs/userwiki/images/terminal-search-advanced.png' });
    }
    await page.keyboard.press('Escape');
    await expect(advanced).toBeHidden(); await expect(page.locator('.terminal-search-bar')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('.terminal-search-bar')).toHaveCount(0);
    await page.locator('.titlebar-right .global-terminal-search-trigger').click();
    const global = page.getByRole('dialog', { name: '全局终端搜索', exact: true });
    await expect(global.getByLabel('搜索内容', { exact: true })).toBeFocused();
    await expect(page.locator('.search-advanced-panel')).toHaveCount(0);
    await page.screenshot({ path: `.npm-cache/global-search-primary-${viewport.width}.png` });
    await global.getByRole('button', { name: '高级选项', exact: true }).click();
    await expect(advanced).toBeVisible();
    const globalBounds = await advanced.boundingBox();
    expect(globalBounds!.y + globalBounds!.height).toBeLessThanOrEqual(viewport.height);
    await advanced.getByRole('radio', { name: '普通文本', exact: true }).click();
    await page.screenshot({ path: `.npm-cache/global-search-advanced-${viewport.width}.png` });
    await page.keyboard.press('Escape');
    await expect(advanced).toBeHidden(); await expect(global).toBeVisible();
    await page.keyboard.press('Escape'); await expect(global).toBeHidden();
  });
}

test('real Worker: cross-batch multiline, fuzzy Unicode spans, HEX and cancellation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async () => {
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    getViewportManager('COM1').appendLines(Array.from({ length: 140 }, (_, seq) => ({ timestamp: seq, direction: 'RX',
      rawData: new TextEncoder().encode(seq === 127 ? 'ERROR' : seq === 128 ? 'device timeout' : `sample ${seq}`), isHex: false })));
  });
  await page.locator('.terminal-view:visible').focus(); await page.keyboard.press('Control+f');
  const advanced = await localOptions(page);
  await advanced.getByLabel('跨行', { exact: true }).check();
  await advanced.getByRole('button', { name: '关闭高级选项', exact: true }).click();
  await page.locator('.terminal-search-input').fill('ERROR\ndevice timeout');
  await expect(page.locator('.terminal-search-counter')).toHaveText('1/1');
  await page.keyboard.press('F3');
  await expect(page.locator('.terminal-line[data-seq="127"] mark')).toHaveText('ERROR');
  await expect(page.locator('.terminal-line[data-seq="128"] mark')).toHaveText('device timeout');
  await expect.poll(() => page.workers().length).toBe(1);
  await page.locator('.terminal-search-input').fill('');
  await expect.poll(() => page.workers().length).toBe(0);

  await page.evaluate(async () => {
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    getViewportManager('COM1').appendLine({ timestamp: 200, direction: 'RX', rawData: new TextEncoder().encode('🙂 unique giant matcher'), isHex: false });
  });
  const fuzzyOptions = await localOptions(page);
  await fuzzyOptions.getByLabel('跨行', { exact: true }).uncheck();
  await fuzzyOptions.getByRole('radio', { name: '模糊匹配', exact: true }).click();
  await fuzzyOptions.getByRole('button', { name: '关闭高级选项', exact: true }).click();
  await page.locator('.terminal-search-input').fill('🙂ugm');
  await expect(page.locator('.terminal-search-counter')).toHaveText('1/1'); await page.keyboard.press('F3');
  await expect(page.locator('.terminal-line[data-seq="140"] mark')).toHaveText(['🙂', 'u', 'g', 'm']);

  await localMode(page, '正则表达式');
  await page.locator('.terminal-search-input').fill('(?:)');
  await expect(page.locator('.terminal-search-counter')).toContainText('无匹配');
  await localMode(page, 'HEX 字节');
  await page.locator('.terminal-search-input').fill('4552524F52');
  await expect(page.locator('.terminal-search-counter')).toHaveText('1/1'); await page.keyboard.press('F3');
  await expect(page.locator('.terminal-line[data-seq="127"] mark')).toHaveText('45 52 52 4F 52');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.workers().length).toBe(0);
  expect(errors).toEqual([]);
});

test('global multi-port Worker search selects sources and activates the correct retained buffer', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    const state = useAppStore.getState();
    state.setPorts([...state.ports, { id: 'COM2', name: 'COM2', status: 'connected', type: 'real', isHidden: false }]);
    state.openTab('COM2');
  });
  await expect(page.locator('.tab-item', { hasText: 'COM2' })).toBeVisible();
  await page.evaluate(async () => {
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    for (const port of ['COM1', 'COM2']) getViewportManager(port).appendLines(['GLOBAL_LEFT', 'GLOBAL_RIGHT'].map(content => ({ timestamp: 1, direction: 'RX', content, isHex: false })));
  });
  await page.keyboard.press('Control+Shift+f');
  const dialog = page.getByRole('dialog', { name: '全局终端搜索' }); await expect(dialog).toBeVisible();
  await expect(page.locator('.search-advanced-panel')).toHaveCount(0);
  await dialog.getByRole('button', { name: '高级选项', exact: true }).click();
  const advanced = page.getByRole('dialog', { name: '高级选项', exact: true });
  await expect(advanced.locator('.global-terminal-search-sources input')).toHaveCount(2);
  await advanced.getByLabel('跨行', { exact: true }).check();
  await advanced.getByRole('button', { name: '关闭高级选项', exact: true }).click();
  await dialog.getByLabel('搜索内容', { exact: true }).fill('GLOBAL_LEFT\nGLOBAL_RIGHT');
  await expect(dialog.locator('.global-terminal-search-result')).toHaveCount(2);
  await dialog.getByRole('button', { name: '高级选项', exact: true }).click();
  await advanced.locator('.global-terminal-search-sources label').filter({ hasText: 'COM1' }).locator('input').uncheck();
  await advanced.getByRole('button', { name: '关闭高级选项', exact: true }).click();
  await expect(dialog.locator('.global-terminal-search-result')).toHaveCount(1);
  await dialog.locator('.global-terminal-search-result').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.serial-content-layer[data-port-id="COM2"] .terminal-line[data-seq="0"] mark')).toHaveText('GLOBAL_LEFT');
  await expect(page.locator('.serial-content-layer[data-port-id="COM2"] .terminal-line[data-seq="1"] mark')).toHaveText('GLOBAL_RIGHT');
  expect(await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    return useAppStore.getState().tabs.find(tab => tab.id === useAppStore.getState().activeTabId)?.portId;
  })).toBe('COM2');
  await expect.poll(() => page.workers().length).toBe(0);
  expect(errors).toEqual([]);
});
