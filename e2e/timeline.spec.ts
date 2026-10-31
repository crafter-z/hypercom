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
  await expect(entry).toContainText('G1');
  await expect(page.locator('.timeline-workspace-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /返回实时/ })).toHaveCount(0);
  const pin = page.getByTitle('切换整组滚动跟随', { exact:true }).filter({ visible:true }).first();
  await expect(pin).toBeEnabled();
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
