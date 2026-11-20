import { expect, test } from '@playwright/test';
import { TAURI_MOCK } from './tauriMock';

test('global HEX search can reveal binary data hidden by the text-only noise filter', async ({ page }) => {
  await page.addInitScript(TAURI_MOCK); await page.goto('/');
  await page.locator('.port-item-name', { hasText: 'COM1' }).dblclick();
  await expect(page.locator('.terminal-view:visible')).toBeVisible();
  await page.evaluate(async () => {
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    getViewportManager('COM1').appendLine({ timestamp: 1, direction: 'RX', rawData: new Uint8Array([0xff, 0xaa, 0xbb, 1, 2, 3, 4, 5]), isHex: false });
  });
  await page.locator('.terminal-noise-filter input').check();
  await expect(page.locator('.terminal-line')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+f');
  const dialog = page.getByRole('dialog', { name: '全局终端搜索' });
  await dialog.getByRole('button', { name: '高级选项', exact: true }).click();
  const advanced = page.getByRole('dialog', { name: '高级选项', exact: true });
  await advanced.getByRole('radio', { name: 'HEX 字节', exact: true }).click();
  await advanced.getByRole('button', { name: '关闭高级选项', exact: true }).click();
  await dialog.getByLabel('搜索内容', { exact: true }).fill('AABB');
  await expect(dialog.locator('.global-terminal-search-result')).toHaveCount(1);
  await dialog.locator('.global-terminal-search-result').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.terminal-line[data-seq="0"] mark')).toHaveText('AA BB');
  await expect(page.locator('.terminal-filter-bar').getByRole('radio', { name: 'HEX', exact: true })).toBeChecked();
  await expect(page.locator('.terminal-noise-filter input')).toBeDisabled();
});
