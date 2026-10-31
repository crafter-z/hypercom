import { expect, test } from '@playwright/test';

const mock = `(() => {
  const callbacks = new Map(); let next = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: {currentWindow:{label:'main'},currentWebview:{windowLabel:'main',label:'main'}},
    transformCallback: cb => {const id=next++;callbacks.set(id,cb);return id;},
    unregisterCallback: id => callbacks.delete(id), runCallback: (id,data) => callbacks.get(id)?.(data),
    convertFileSrc: path => path,
    invoke: async cmd => {
      if(cmd==='get_config') {const {useAppStore}=await import('/src/stores/useAppStore.ts');return {...structuredClone(useAppStore.getState().config),restoreSession:false,autoSaveLog:false};}
      if(cmd==='list_available_ports'||cmd.startsWith('load_')||cmd==='get_log_files') return [];
      if(cmd==='list_plugins') return {revision:0,plugins:[],pluginConfigs:[]};
      if(cmd==='get_system_status') return {status:'normal',memoryUsedMb:0,cpuUsage:0};
      if(cmd==='plugin:app|version') return 'e2e';
      if(cmd==='plugin:window|is_maximized') return false;
      if(cmd==='plugin:event|listen') return next++;
      return null;
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
})();`;

test('time linking uses existing Pin and stable chrome, with opaque accessible settings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(mock);
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    const store = useAppStore.getState();
    store.openTab('COM1'); store.openTab('COM2'); store.splitPane('vertical');
    for (const id of ['COM1', 'COM2']) getViewportManager(id).appendLines(Array.from({length:200}, (_, i) => ({
      timestamp: Date.now()-2000+i*10, direction:'RX', rawData:new TextEncoder().encode('record '+i), isHex:false,
    })));
  });
  const entries = page.locator('.timeline-entry').filter({ visible: true });
  await expect(entries).toHaveCount(2);
  const entry = entries.first();
  const before = await entry.boundingBox();
  await entry.click();
  const dialog = page.getByRole('dialog', { name: '时间联动', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '联动组名称' }).fill('设备对照');
  await dialog.getByRole('checkbox', { name: /COM1/ }).check();
  await dialog.getByRole('checkbox', { name: /COM2/ }).check();
  expect(await dialog.locator('input[type=text], input:not([type])').first().evaluate(el => el.getBoundingClientRect().height)).toBe(32);
  await dialog.screenshot({ path: '.npm-cache/timeline-settings-dark.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: '创建联动组', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(entry).toBeFocused();
  await expect(page.locator('.tab-item .timeline-badge').first()).toContainText('G1');
  await expect(entry).toHaveAttribute('title', 'G1 · 时间联动…');
  expect(await entry.evaluate(element => element.getBoundingClientRect().width)).toBe(24);
  await expect(page.locator('.timeline-workspace-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /返回实时/ })).toHaveCount(0);
  const pin = page.getByTitle('切换整组滚动跟随', { exact:true }).filter({ visible:true }).first();
  await expect(pin).toBeEnabled();
  // Creating a live group preserves the initiating terminal's existing Pin.
  await expect(pin).toHaveAttribute('aria-pressed','true');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed','false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed','true');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed','false');
  await page.evaluate(async () => {
    const {timelineCoordinator:c}=await import('/src/utils/timeline/coordinator.ts');
    const group=c.getSnapshot().groups[0]; c.seek(group.id,Date.now()-1000,'preview');
  });
  expect(await entry.boundingBox()).toEqual(before);
  await entry.click();
  const advanced = dialog.locator('details');
  await expect(advanced).not.toHaveAttribute('open','');
  await advanced.locator('summary').click();
  const offsets=dialog.locator('.timeline-offset-row input');
  await expect(offsets).toHaveCount(2);
  await offsets.nth(0).click(); await offsets.nth(1).click();
  await expect(offsets.nth(1)).toBeFocused();
  await offsets.nth(0).fill('25'); await offsets.nth(0).press('Enter');
  await expect(dialog).toBeVisible();
  await expect(offsets.nth(0)).toHaveValue('25');
  await offsets.nth(0).fill('30'); await offsets.nth(1).click();
  await expect(offsets.nth(1)).toBeFocused();
  await advanced.locator('summary').click();
  await dialog.getByRole('checkbox',{name:/COM2/}).uncheck();
  await dialog.getByRole('button',{name:'保存成员',exact:true}).click();
  await entry.click();
  await expect(dialog.getByRole('checkbox',{name:/COM2/})).not.toBeChecked();
  for (const theme of ['dark','light']) {
    await page.evaluate(theme => {document.documentElement.dataset.theme=theme;document.documentElement.dataset.appBg='on';},theme);
    const color=await dialog.evaluate(el=>getComputedStyle(el).backgroundColor);
    expect(color).toBe(theme==='dark'?'rgb(25, 26, 30)':'rgb(255, 255, 255)');
    await dialog.screenshot({path:'.npm-cache/timeline-members-'+theme+'.png',animations:'disabled'});
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(entry).toBeFocused();
  await page.setViewportSize({width:620,height:700});
  await entry.click();
  const size=await dialog.evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,right:el.getBoundingClientRect().right}));
  expect(size.scrollWidth).toBe(size.width); expect(size.right).toBeLessThanOrEqual(620);
  await page.screenshot({path:'.npm-cache/timeline-settings-light.png'});
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('linked Pins preserve existing follow and keep the latest RX row visible after every append frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(mock);
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    const { useTerminalStore } = await import('/src/stores/useTerminalStore.ts');
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    const state = useAppStore.getState();
    state.openTab('COM1'); state.openTab('COM2'); state.splitPane('vertical');
    for (const port of ['COM1', 'COM2']) {
      useTerminalStore.getState().setTerminalConfig(port, { scrollLocked: true });
      getViewportManager(port).appendLines(Array.from({ length: 200 }, (_, i) => ({ timestamp: Date.now() - 200 + i, direction: 'RX', rawData: new TextEncoder().encode('initial ' + i), isHex: false })));
    }
  });
  await expect(page.getByTitle('滚动锁定', { exact: true }).filter({ visible: true })).toHaveCount(2);
  await page.locator('.timeline-entry:visible').first().click();
  const dialog = page.getByRole('dialog', { name: '时间联动', exact: true });
  await dialog.getByRole('checkbox', { name: /COM1/ }).check();
  await dialog.getByRole('checkbox', { name: /COM2/ }).check();
  await dialog.getByRole('button', { name: '创建联动组', exact: true }).click();
  const pins = page.getByTitle('切换整组滚动跟随', { exact: true }).filter({ visible: true });
  await expect(pins.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(pins.nth(1)).toHaveAttribute('aria-pressed', 'true');
  const samples = await page.evaluate(async () => {
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    const results = [];
    for (let batch = 0; batch < 12; batch++) {
      for (const port of ['COM1', 'COM2']) getViewportManager(port).appendLines(Array.from({ length: 40 }, (_, i) => ({ timestamp: Date.now(), direction: 'RX', rawData: new TextEncoder().encode(`batch ${batch} row ${i}`), isHex: false })));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      [...document.querySelectorAll<HTMLElement>('.terminal-view')].filter(view => view.getClientRects().length).forEach((view, index) => {
        const lastSeq = getViewportManager(index === 0 ? 'COM1' : 'COM2').buffer.lastSeq;
        const row = view.querySelector<HTMLElement>(`[data-seq="${lastSeq}"]`);
        const bounds = view.getBoundingClientRect(), actual = row?.getBoundingClientRect();
        results.push({ gap: view.scrollHeight - view.clientHeight - view.scrollTop, latestVisible: !!actual && actual.height > 0 && actual.bottom <= bounds.bottom + 2 && actual.top >= bounds.top - 2 });
      });
    }
    return results;
  });
  expect(samples).toHaveLength(24);
  expect(samples.every(sample => sample.gap <= 2 && sample.latestVisible)).toBe(true);
  await pins.nth(0).click();
  await expect(pins.nth(1)).toHaveAttribute('aria-pressed', 'false');
  const held = await page.locator('.terminal-view:visible').evaluateAll(views => views.map(view => view.scrollTop));
  await page.evaluate(async () => {
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    for (const port of ['COM1', 'COM2']) getViewportManager(port).appendLines(Array.from({ length: 80 }, (_, i) => ({ timestamp: Date.now(), direction: 'RX', rawData: new TextEncoder().encode('while unlocked ' + i), isHex: false })));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(() => page.locator('.terminal-view:visible').evaluateAll(views => views.map(view => view.scrollTop))).toEqual(held);
  await pins.nth(1).click();
  await expect(pins.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.terminal-view:visible').evaluateAll(views => views.every(view => view.scrollHeight - view.clientHeight - view.scrollTop <= 2))).toBe(true);
  // A user gesture exits LIVE for all members; later appends must not pin either view.
  await page.locator('.terminal-view:visible').first().hover();
  await page.mouse.wheel(0, -300);
  await expect(pins.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(pins.nth(1)).toHaveAttribute('aria-pressed', 'false');
});

test('creating a time group from an unlocked terminal keeps browsing instead of enabling follow', async ({ page }) => {
  await page.addInitScript(mock);
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    const { useTerminalStore } = await import('/src/stores/useTerminalStore.ts');
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    useAppStore.getState().openTab('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', { scrollLocked: false });
    getViewportManager('COM1').appendLines(Array.from({ length: 200 }, (_, i) => ({ timestamp: Date.now() - 200 + i, direction: 'RX', rawData: new TextEncoder().encode('history ' + i), isHex: false })));
  });
  await expect(page.getByTitle('滚动锁定', { exact: true }).filter({ visible: true })).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.timeline-entry:visible').click();
  await page.getByRole('dialog', { name: '时间联动', exact: true }).getByRole('button', { name: '创建联动组', exact: true }).click();
  await expect(page.getByTitle('切换整组滚动跟随', { exact: true }).filter({ visible: true })).toHaveAttribute('aria-pressed', 'false');
  const held = await page.locator('.terminal-view:visible').evaluate(element => element.scrollTop);
  await page.evaluate(async () => {
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    getViewportManager('COM1').appendLines(Array.from({ length: 80 }, (_, i) => ({ timestamp: Date.now(), direction: 'RX', rawData: new TextEncoder().encode('new ' + i), isHex: false })));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  expect(await page.locator('.terminal-view:visible').evaluate(element => element.scrollTop)).toBe(held);
});

for (const linked of [false, true]) {
  test(`search and explicit Pin coexist while streaming (${linked ? 'linked' : 'independent'})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(mock);
    await page.goto('/');
    await expect(page.locator('.app-root')).toBeVisible();
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/stores/useAppStore.ts');
      const { useTerminalStore } = await import('/src/stores/useTerminalStore.ts');
      const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
      const state = useAppStore.getState();
      state.openTab('COM1'); state.openTab('COM2'); state.splitPane('vertical');
      for (const port of ['COM1', 'COM2']) {
        useTerminalStore.getState().setTerminalConfig(port, { scrollLocked: true });
        getViewportManager(port).appendLines(Array.from({ length: 300 }, (_, i) => ({ timestamp: Date.now() - 300 + i, direction: 'RX', rawData: new TextEncoder().encode(`${i === 50 || i === 70 ? 'needle' : 'plain'} ${i}`), isHex: false })));
      }
    });
    const container = page.locator('.terminal-view-container:visible').first();
    const viewport = container.locator('.terminal-view');
    if (linked) {
      await container.locator('.timeline-entry').click();
      const dialog = page.getByRole('dialog', { name: '时间联动', exact: true });
      await dialog.getByRole('checkbox', { name: /COM1/ }).check();
      await dialog.getByRole('checkbox', { name: /COM2/ }).check();
      await dialog.getByRole('button', { name: '创建联动组', exact: true }).click();
    }
    const pin = container.locator('.terminal-filter-display-group button').first();
    const append = () => page.evaluate(async () => {
      const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
      for (const port of ['COM1', 'COM2']) getViewportManager(port).appendLines(Array.from({ length: 40 }, (_, i) => ({ timestamp: Date.now(), direction: 'RX', rawData: new TextEncoder().encode('stream ' + i), isHex: false })));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return [...document.querySelectorAll<HTMLElement>('.terminal-view')].filter(element => element.getClientRects().length).map(element => ({ top: element.scrollTop, gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
    });
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await viewport.focus(); await page.keyboard.press('Control+f');
    const search = container.locator('.terminal-search-input');
    await expect(search).toBeVisible();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await search.fill('needle');
    await expect(container.locator('.terminal-search-counter')).toHaveText('1/2');
    expect((await append()).every(sample => sample.gap <= 2)).toBe(true);
    await expect(search).toBeFocused();

    // Pin can be explicitly restarted with the search bar still open.
    await pin.click(); await expect(pin).toHaveAttribute('aria-pressed', 'false');
    const held = await viewport.evaluate(element => element.scrollTop);
    expect((await append())[0].top).toBe(held);
    await pin.click(); await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await expect(search).toBeVisible();
    expect((await append()).every(sample => sample.gap <= 2)).toBe(true);

    // Actual hit navigation must release follow before centering a historical row.
    await search.press('Enter');
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await expect(container.locator('.terminal-line.current-match')).toHaveAttribute('data-seq', '70');
    await expect(container.locator('.terminal-line[data-seq="70"]')).toBeVisible();
    if (linked) await expect.poll(() => page.evaluate(async () => (await import('/src/utils/timeline/coordinator.ts')).timelineCoordinator.getSnapshot().groups[0]?.ownerParticipantId)).toBeNull();
    const hitTop = await viewport.evaluate(element => element.scrollTop);
    expect((await append())[0].top).toBe(hitTop);
    await search.press('Escape');
    await expect(search).toBeHidden();
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    const closedTop = await viewport.evaluate(element => element.scrollTop);
    expect((await append())[0].top).toBe(closedTop);
  });
}

test('terminal controls fit narrow split panes and the direction dropdown preserves filtering', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(mock);
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    const state = useAppStore.getState();
    state.openTab('COM1'); state.openTab('COM2'); state.splitPane('vertical');
    for (const id of ['COM1', 'COM2']) getViewportManager(id).appendLines(Array.from({ length: 200 }, (_, i) => ({
      timestamp: Date.now() - 2000 + i * 10, direction: i % 2 ? 'TX' : 'RX',
      rawData: new TextEncoder().encode('record ' + i), isHex: false,
    })));
  });
  const view = page.locator('.terminal-view-container').filter({ visible: true }).first();
  const bar = view.locator('.terminal-filter-bar');
  const direction = bar.getByRole('combobox', { name: '收发方向', exact: true });
  await expect(direction).toHaveValue('all');
  expect(await direction.evaluate(element => element.getBoundingClientRect().width)).toBe(64);
  for (const value of ['TX', 'RX']) {
    await direction.selectOption(value);
    await expect.poll(() => view.locator('.terminal-direction').allTextContents()).toEqual(expect.arrayContaining([value]));
    await expect.poll(() => view.locator('.terminal-direction').allTextContents()).not.toEqual(expect.arrayContaining([value === 'TX' ? 'RX' : 'TX']));
  }
  await direction.selectOption('all');
  await bar.getByPlaceholder('关键词过滤...').fill('record');
  await expect(bar.locator('.terminal-filter-count')).toBeVisible();
  await bar.getByTitle('暂停显示（数据继续在后台接收）', { exact: true }).click();
  await expect(bar.locator('.terminal-filter-paused')).toBeVisible();
  for (const language of ['zh-CN', 'en-US']) {
    await page.evaluate(async language => {
      const { default: i18n } = await import('/src/i18n.ts'); await i18n.changeLanguage(language);
    }, language);
    expect(await bar.locator('.terminal-direction-select').evaluate((element: HTMLSelectElement) => {
      const style = getComputedStyle(element);
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('Expected a text measurement context');
      context.font = style.font;
      const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return [...element.options].every(option => context.measureText(option.text).width <= available);
    })).toBe(true);
    for (const width of [1800, 1280, 980, 740, 620]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => bar.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const controls = [...element.querySelectorAll('button, input, select')].map(control => control.getBoundingClientRect());
        const escaped = controls.some(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
        const overlaps = controls.some((a, index) => controls.slice(index + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
        return { escaped, overlaps, horizontalOverflow: element.scrollWidth > element.clientWidth + 1 };
      })).toEqual({ escaped: false, overlaps: false, horizontalOverflow: false });
    }
  }
  await page.evaluate(async () => { const { default: i18n } = await import('/src/i18n.ts'); await i18n.changeLanguage('zh-CN'); });
  await bar.getByTitle('恢复显示', { exact: true }).click();
  await bar.getByPlaceholder('关键词过滤...').fill('');
  await expect(bar.locator('.terminal-filter-count')).toBeHidden();
  await page.setViewportSize({ width: 980, height: 900 });
  await bar.screenshot({ path: '.npm-cache/trx-toolbar-narrow.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect.poll(() => bar.evaluate(element => element.clientHeight)).toBeLessThan(40);
  await bar.screenshot({ path: '.npm-cache/trx-toolbar-wide.png', animations: 'disabled' });
});
