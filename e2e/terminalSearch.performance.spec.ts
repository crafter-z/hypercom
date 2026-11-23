import { expect, test } from '@playwright/test';
import type { TerminalLine } from '../src/types';
import { TAURI_MOCK } from './tauriMock';

/** Observational Chromium/mock-IPC sample, not a serial/WebView2 FPS guarantee. */
const ROW_COUNT = Math.max(1000, Math.min(1_000_000, Number(process.env.HYPERCOM_SEARCH_BENCH_ROWS) || 100_000));
test(`${ROW_COUNT} retained rows: receive/display cost with advanced search off and on`, async ({ page }, info) => {
  test.skip(process.env.HYPERCOM_SEARCH_BENCH !== '1', 'Opt-in: HYPERCOM_SEARCH_BENCH=1, one worker');
  test.setTimeout(120_000);
  await page.addInitScript(TAURI_MOCK); await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.locator('.port-item-name', { hasText: 'COM1' }).dblclick();
  await expect(page.locator('.terminal-view:visible')).toBeVisible();
  const measurements = await page.evaluate(async rowCount => {
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    const { DEFAULT_SEARCH_SPEC } = await import('/src/utils/terminal/search/searchTypes.ts');
    const vm = getViewportManager('COM1');
    const row = (seq: number): TerminalLine => ({ timestamp: seq, direction: 'RX', content: `INFO packet ${seq}: temperature=24.5 status=normal`, isHex: false });
    vm.applyLimits({ maxLines: rowCount });
    vm.appendLines(Array.from({ length: rowCount }, (_, seq) => row(seq)));
    await new Promise(resolve => setTimeout(resolve, 200));
    let next = rowCount;
    async function sample(active: boolean) {
      vm.setSearch(active, 'pktz', false, { ...DEFAULT_SEARCH_SPEC, mode: 'fuzzy', multiline: true });
      const append: number[] = [], frames: number[] = [], loop: number[] = [];
      let running = true, previous = performance.now();
      const raf = (now: number) => { frames.push(now - previous); previous = now; if (running) requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
      for (let index = 0; index < 70; index++) {
        const start = performance.now();
        vm.appendLines(Array.from({ length: 100 }, () => row(next++)));
        append.push(performance.now() - start);
        const scheduled = performance.now();
        await new Promise(resolve => setTimeout(resolve, 16));
        loop.push(Math.max(0, performance.now() - scheduled - 16));
      }
      running = false;
      const snapshot = vm.getSearchSnapshot();
      vm.setSearch(false, '', false);
      const percentile = (values: number[], ratio: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * ratio))] ?? 0;
      return { active, appended: 7000, appendP50Ms: percentile(append, .5), appendP95Ms: percentile(append, .95),
        frameP95Ms: percentile(frames.slice(1), .95), eventLoopLagP95Ms: percentile(loop, .95),
        scanned: snapshot?.scanned ?? 0, searchStatus: snapshot?.status ?? 'closed',
        mountedRows: document.querySelectorAll('.terminal-line').length };
    }
    return { rowCount, off: await sample(false), on: await sample(true) };
  }, ROW_COUNT);
  console.log('TERMINAL_SEARCH_BENCH', JSON.stringify(measurements));
  await info.attach(`terminal-search-${ROW_COUNT}.json`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  expect(measurements.on.scanned).toBeGreaterThan(0);
  expect(measurements.on.mountedRows).toBeLessThan(100);
  await expect.poll(() => page.workers().length).toBe(0);
});
