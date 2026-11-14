import { test, expect, type Page } from '@playwright/test';
import { TAURI_MOCK } from './tauriMock';
import type { SerialPort } from '../src/types';

const port: SerialPort = {
  id: 'COM1',
  name: 'COM1',
  alias: '测试串口',
  status: 'connected',
  type: 'real',
  isHidden: false,
  baudRate: 115200,
  dataBits: 8,
  parity: 'None',
  stopBits: 'One',
  handshake: 'None',
};

async function seedEmptyCommandState(page: Page): Promise<void> {
  await page.evaluate(async ({ port }) => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    const { useRuleStore } = await import('/src/stores/useRuleStore.ts');
    const { useSystemStore } = await import('/src/stores/useSystemStore.ts');

    useAppStore.setState({ ports: [port] });
    useAppStore.getState().setConfig({
      language: 'zh-CN',
      theme: 'dark',
      quickSendInlineCount: 1,
      uiFontSize: 14,
      terminalFontSize: 14,
    });
    useRuleStore.getState().setSendCommandSets([]);
    useSystemStore.getState().setUIState({ operationPanelHeight: 160, configReady: true });
    useAppStore.getState().openTab(port.id);
  }, { port });

  await expect(page.locator('.operation-panel')).toBeVisible();
  await expect(page.locator('.op-quick-send-row')).toBeVisible();
  await expect(page.locator('.op-quick-cmd-configure')).toBeVisible();
}

async function rowMetrics(page: Page) {
  return page.locator('.op-quick-send-row').evaluate((row) => {
    const secondary = row.parentElement!;
    const section = secondary.parentElement!;
    const panelButton = row.querySelector('.op-quick-panel-btn')!.getBoundingClientRect();
    const configureButton = row.querySelector('.op-quick-cmd-configure')!.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const secondaryRect = secondary.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    return {
      rowTop: rowRect.top,
      rowBottom: rowRect.bottom,
      rowHeight: rowRect.height,
      secondaryBottom: secondaryRect.bottom,
      sectionBottom: sectionRect.bottom,
      panelButtonBottom: panelButton.bottom,
      configureButtonBottom: configureButton.bottom,
      panelButtonHeight: panelButton.height,
      configureButtonHeight: configureButton.height,
    };
  });
}

test.describe('OperationPanel command row layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(TAURI_MOCK);
    await page.goto('/');
    await expect(page.locator('.app-root')).toBeVisible();
    await expect.poll(() => page.evaluate(async () => {
      const { useSystemStore } = await import('/src/stores/useSystemStore.ts');
      return useSystemStore.getState().ui.configReady;
    })).toBe(true);
    await seedEmptyCommandState(page);
  });

  test('keeps command panel and configure-command-set row fully visible when panel is short', async ({ page }) => {
    for (const uiFontSize of [8, 14, 24, 48]) {
      for (const operationPanelHeight of [160, 280]) {
        await page.evaluate(({ uiFontSize, operationPanelHeight }) => {
          const appPath = '/src/stores/useAppStore.ts';
          const systemPath = '/src/stores/useSystemStore.ts';
          // The modules are already loaded by the fixture; use dynamic imports to
          // keep this test independent from production globals in the page.
          void import(appPath).then(({ useAppStore }) => useAppStore.getState().setConfig({ uiFontSize }));
          void import(systemPath).then(({ useSystemStore }) => useSystemStore.getState().setUIState({ operationPanelHeight }));
        }, { uiFontSize, operationPanelHeight });

        await expect.poll(() => page.evaluate(() => {
          const root = getComputedStyle(document.documentElement);
          const panel = document.querySelector<HTMLElement>('.operation-panel');
          return {
            uiFont: root.getPropertyValue('--font-size-ui').trim(),
            panelHeight: panel?.getBoundingClientRect().height ?? 0,
          };
        })).toEqual({
          uiFont: `${uiFontSize}px`,
          panelHeight: operationPanelHeight,
        });

        await page.locator('.op-quick-send-row').scrollIntoViewIfNeeded();
        const metrics = await rowMetrics(page);
        expect(metrics.rowHeight, `row height at uiFontSize=${uiFontSize}, panelHeight=${operationPanelHeight}`).toBeGreaterThanOrEqual(
          Math.max(metrics.panelButtonHeight, metrics.configureButtonHeight) - 0.5,
        );
        expect(metrics.panelButtonBottom).toBeLessThanOrEqual(metrics.rowBottom + 0.5);
        expect(metrics.configureButtonBottom).toBeLessThanOrEqual(metrics.rowBottom + 0.5);
        expect(metrics.rowBottom).toBeLessThanOrEqual(metrics.secondaryBottom + 0.5);
        expect(metrics.rowBottom).toBeLessThanOrEqual(metrics.sectionBottom + 0.5);
      }
    }
  });
});

export {};
