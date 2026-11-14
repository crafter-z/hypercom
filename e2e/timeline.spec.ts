import { expect, test } from '@playwright/test';

// Keep Node globals local so browser-side timer types stay unchanged.
declare const process: { env: Record<string, string | undefined> };

// Keep native scrollbars visible: headless Chromium normally hides the gutter.
test.use({ channel: process.env.HYPERCOM_E2E_CHANNEL, launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

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
      if(cmd==='plugin:window|is_maximized'||cmd==='plugin:window|is_always_on_top') return false;
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
  await expect(entry).toHaveAttribute('title', 'G1 · 设备对照 · 时间联动…');
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
  // Compact panel: the dialog stays narrow and member rows stay dense.
  expect(await dialog.evaluate(element => element.clientWidth)).toBeLessThanOrEqual(480);
  expect(await dialog.locator('.timeline-member-row').first().evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
  const advanced = dialog.locator('details');
  await expect(advanced).not.toHaveAttribute('open','');
  // Group lifecycle is first-class in the panel body, never behind Advanced settings.
  const groupBar = dialog.locator('.timeline-group-bar');
  await expect(groupBar).toContainText('2 个成员');
  await expect(groupBar.getByRole('button', { name: '解散联动组', exact: true })).toBeVisible();
  // A settled group must not raise misalignment chrome. The badge only reads settled
  // fields, so this poll does not need to wait for in-flight preview ticks to stop.
  await expect.poll(() => page.evaluate(async () => (await import('/src/utils/timeline/coordinator.ts')).timelineCoordinator.getSnapshot().groups[0]?.members.every(member => member.status === 'exact' || member.status === 'nearest'))).toBe(true);
  await expect(dialog.locator('.timeline-group-status')).toHaveCount(0);
  await expect(dialog.locator('.timeline-notice')).toHaveCount(0);
  await expect(dialog.locator('.timeline-member-status')).toHaveCount(0);
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

test('a linked view dissolves its group from the panel body without opening advanced settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(mock);
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    const state = useAppStore.getState();
    state.openTab('COM1'); state.openTab('COM2'); state.splitPane('vertical');
  });
  const entry = page.locator('.timeline-entry').filter({ visible: true }).first();
  await entry.click();
  const dialog = page.getByRole('dialog', { name: '时间联动', exact: true });
  await dialog.getByRole('button', { name: '创建联动组', exact: true }).click();
  await expect(page.locator('.tab-item .timeline-badge')).toHaveCount(1);
  await entry.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('details')).not.toHaveAttribute('open', '');
  const dissolve = dialog.locator('.timeline-group-bar').getByRole('button', { name: '解散联动组', exact: true });
  await expect(dissolve).toBeVisible();
  await dialog.screenshot({ path: '.npm-cache/timeline-dissolve-dark.png', animations: 'disabled' });
  await dissolve.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.tab-item .timeline-badge')).toHaveCount(0);
  await expect(page.locator('.timeline-entry.active')).toHaveCount(0);
  expect(await page.evaluate(async () => (await import('/src/utils/timeline/coordinator.ts')).timelineCoordinator.getSnapshot().groups.length)).toBe(0);
});

test('a clock-domain mismatch stays a behavioural fallback instead of a panel prompt', async ({ page }) => {
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
    // Identical timelines so a healthy group settles exactly; browse (unlocked) so
    // no host-clock LIVE tick keeps chasing the tail of this short fixture.
    for (const port of ['COM1', 'COM2']) {
      useTerminalStore.getState().setTerminalConfig(port, { scrollLocked: false });
      getViewportManager(port).appendLines(Array.from({ length: 200 }, (_, i) => ({
        timestamp: 1000 + i * 10, direction: 'RX' as const, rawData: new TextEncoder().encode('record ' + i), isHex: false,
      })));
    }
  });
  const entry = page.locator('.timeline-entry').filter({ visible: true }).first();
  await entry.click();
  const dialog = page.getByRole('dialog', { name: '时间联动', exact: true });
  await dialog.getByRole('checkbox', { name: /COM2/ }).check();
  await dialog.getByRole('button', { name: '创建联动组', exact: true }).click();
  // The initiating view is the anchor and is never re-seeked by creation, so
  // drive one explicit commit to give both members a settled result first.
  await page.evaluate(async () => {
    const { timelineCoordinator } = await import('/src/utils/timeline/index.ts');
    const group = timelineCoordinator.getSnapshot().groups[0];
    timelineCoordinator.seek(group.id, 1500, 'commit');
  });
  await expect.poll(() => page.evaluate(async () => {
    const { timelineCoordinator } = await import('/src/utils/timeline/coordinator.ts');
    return timelineCoordinator.getSnapshot().groups[0]?.members.map(member => ({ state: member.state, status: member.status }));
  })).toEqual([{ state: 'active', status: 'exact' }, { state: 'active', status: 'exact' }]);
  // A second clock domain (what a device-clock plugin source reports) cannot follow the host clock.
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    const { timelineCoordinator } = await import('/src/utils/timeline/index.ts');
    const tab = useAppStore.getState().tabs.find(item => item.kind === 'serial' && item.portId === 'COM2');
    if (!tab) throw new Error('Expected the COM2 tab');
    timelineCoordinator.registerParticipant({
      participantId: `device-clock:${tab.id}`, slotId: tab.id, sourceId: 'device:clock-b', sourceKind: 'custom',
      generation: 1, sourceGeneration: 1, clockId: 'device-uptime',
      capabilities: { preview: 'bounded', canDrive: true },
      readAnchor: () => null, seek: () => ({ status: 'exact', actualTimeMs: 0 }),
    });
  });
  await expect.poll(() => page.evaluate(async () => {
    const { timelineCoordinator } = await import('/src/utils/timeline/coordinator.ts');
    return timelineCoordinator.getSnapshot().groups[0]?.members.map(member => ({ state: member.state, status: member.status }));
  })).toEqual([{ state: 'active', status: 'exact' }, { state: 'unavailable', status: undefined }]);
  await entry.click();
  await expect(dialog).toBeVisible();
  // Behavioural fallback, not a prompt: the member carries no seek result (it never pretends
  // to be aligned), and the panel body stays silent about the clock domain itself.
  await expect(dialog.locator('.timeline-notice')).toHaveCount(0);
  await expect(dialog.locator('details')).not.toHaveAttribute('open', '');
  const chip = dialog.locator('.timeline-member-status').filter({ hasText: '暂不可用' });
  await expect(chip).toHaveCount(1);
  expect(await chip.getAttribute('title')).toBeNull();
  await expect(dialog.locator('.timeline-group-status')).toContainText('1 个视图未对齐');
  await dialog.screenshot({ path: '.npm-cache/timeline-clock-mismatch-dark.png', animations: 'disabled' });
});

for (const wordWrap of [false, true]) {
test(`linked Pins preserve existing follow and keep the latest RX row visible after every append frame (${wordWrap ? 'mixed soft wrap' : 'fixed'})`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(mock);
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.evaluate(async wordWrap => {
    const { useAppStore } = await import('/src/stores/useAppStore.ts');
    const { useTerminalStore } = await import('/src/stores/useTerminalStore.ts');
    const { getViewportManager } = await import('/src/utils/terminal/viewportManager.ts');
    const state = useAppStore.getState();
    state.openTab('COM1'); state.openTab('COM2'); state.splitPane('vertical');
    for (const port of ['COM1', 'COM2']) {
      useTerminalStore.getState().setTerminalConfig(port, { scrollLocked: true, wordWrap: wordWrap && port === 'COM1' });
      getViewportManager(port).appendLines(Array.from({ length: 200 }, (_, i) => ({ timestamp: Date.now() - 200 + i, direction: 'RX', rawData: new TextEncoder().encode('initial ' + i), isHex: false })));
    }
  }, wordWrap);
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
    const results: { gap: number; latestVisible: boolean }[] = [];
    for (let batch = 0; batch < 12; batch++) {
      for (const port of ['COM1', 'COM2']) getViewportManager(port).appendLines(Array.from({ length: 40 }, (_, i) => ({ timestamp: Date.now(), direction: 'RX', rawData: new TextEncoder().encode(`batch ${batch} row ${i} ` + ' payload 0123456789'.repeat(8)), isHex: false })));
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

}

test.describe('time linking with real scrolling input', () => {
  for (const input of ['scrollbar', 'wheel'] as const) {
  for (const policy of ['continuous', 'on-release'] as const) {
  test(`${policy} respects real ${input} input even under frame pressure`, async ({ page }) => {
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
        useTerminalStore.getState().setTerminalConfig(port, { scrollLocked: false });
        getViewportManager(port).appendLines(Array.from({ length: 1000 }, (_, i) => ({
          timestamp: 100000 + i * 10, direction: 'RX', rawData: new TextEncoder().encode('record ' + i), isHex: false,
        })));
      }
    });
    const entries = page.locator('.timeline-entry:visible');
    await expect(entries).toHaveCount(2);
    await entries.first().click();
    const dialog = page.getByRole('dialog', { name: '时间联动', exact: true });
    await dialog.getByRole('checkbox', { name: /COM1/ }).check();
    await dialog.getByRole('checkbox', { name: /COM2/ }).check();
    await dialog.getByRole('button', { name: '创建联动组', exact: true }).click();
    await entries.first().click();
    await dialog.locator('summary').click();
    await dialog.locator('.timeline-policy-field select').selectOption(policy);
    await dialog.locator('footer').getByRole('button', { name: '关闭', exact: true }).click();
    const views = page.locator('.terminal-view:visible');
    const driver = views.first();
    // Wait for the creation commit before acquiring a new gesture.
    await expect.poll(() => page.evaluate(async () => {
      const { timelineCoordinator: c } = await import('/src/utils/timeline/coordinator.ts');
      return c.getSnapshot().groups[0].members.every(member => !member.pending && !member.inFlight);
    })).toBe(true);
    // Observe ownership in the page, not after a CDP round trip plus several
    // display frames: a real wheel gesture legitimately settles after 120 ms.
    // Keep every owned sample so commits cannot masquerade as live previews.
    const observation = await page.evaluateHandle(async () => {
      const { timelineCoordinator: c } = await import('/src/utils/timeline/coordinator.ts');
      const samples: Array<{
        owner: string; epoch: number; tier: string; paused: boolean;
        anchors: Array<number | null | undefined>; followerTop: number; initialFollowerTop: number;
      }> = [];
      let epoch = -1, initialFollowerTop = 0;
      const stop = c.subscribe(() => {
        const group = c.getSnapshot().groups[0];
        if (!group?.ownerParticipantId) return;
        const follower = Array.from(document.querySelectorAll<HTMLElement>('.terminal-view'))
          .filter(element => element.getClientRects().length > 0)[1];
        if (group.navigationEpoch !== epoch) {
          epoch = group.navigationEpoch;
          initialFollowerTop = follower.scrollTop;
        }
        // Exercise the low-cadence branch while the real gesture is owned;
        // never synthesize source navigation or scroll events.
        for (let i = 0; i < 3; i++) c.scheduler.observeFrame(33);
        samples.push({ owner: group.ownerParticipantId, epoch, tier: group.members[1].preview,
          paused: c.scheduler.previewsPaused, followerTop: follower.scrollTop, initialFollowerTop,
          anchors: group.memberSlots.map(slot => c.readSlotAnchor(slot)?.timeMs) });
      });
      return { samples, stop };
    });
    const geometry = await driver.evaluate((element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const gutter = element.offsetWidth - element.clientWidth;
      const thumbHeight = element.clientHeight * element.clientHeight / element.scrollHeight;
      return { gutter, x: rect.right - gutter / 2, y: rect.top + thumbHeight / 2,
        travel: element.clientHeight - thumbHeight };
    });
    expect(geometry.gutter).toBeGreaterThan(0);
    if (input === 'scrollbar') {
      await page.mouse.move(geometry.x, geometry.y);
      await page.mouse.down();
    } else await driver.hover();
    let previousDriverTime = 0;
    for (const fraction of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
      const offset = await observation.evaluate(value => value.samples.length);
      if (input === 'scrollbar') await page.mouse.move(geometry.x, geometry.y + geometry.travel * fraction, { steps: 3 });
      else await page.mouse.wheel(0, 250);
      await page.evaluate(async () => {
        for (let frame = 0; frame < 4; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
      await expect.poll(() => observation.evaluate((value, { offset, previous }) =>
        value.samples.slice(offset).some(sample => (sample.anchors[0] ?? 0) > previous),
      { offset, previous: previousDriverTime })).toBe(true);
      const samples = await observation.evaluate((value, offset) => value.samples.slice(offset), offset);
      const sample = samples[samples.length - 1];
      expect(sample.owner).not.toBeNull(); // Captured during ownership, never after a commit.
      expect(sample.paused).toBe(true);
      expect(sample.anchors[0]).toBeGreaterThan(previousDriverTime);
      previousDriverTime = sample.anchors[0]!;
      if (policy === 'continuous' && input === 'scrollbar') {
        // A held thumb cannot quiet-settle; require the bounded preview lane
        // to catch up before release rather than accepting the final commit.
        await expect.poll(() => page.evaluate(async () => {
          const { timelineCoordinator: c } = await import('/src/utils/timeline/coordinator.ts');
          const group = c.getSnapshot().groups[0];
          return { owned: group.ownerParticipantId !== null, time: c.readSlotAnchor(group.memberSlots[1])?.timeMs };
        })).toEqual({ owned: true, time: sample.anchors[0] });
      }
    }
    const ownedSamples = await observation.evaluate(value => value.samples);
    expect(ownedSamples.length).toBeGreaterThan(0);
    expect(ownedSamples.every(sample => sample.paused)).toBe(true);
    if (policy === 'continuous') {
      expect(ownedSamples.every(sample => sample.tier !== 'on-release')).toBe(true);
      if (input === 'wheel') {
        const previewSamples = ownedSamples.filter(sample => sample.followerTop !== sample.initialFollowerTop
          && typeof sample.anchors[1] === 'number');
        expect(new Set(previewSamples.map(sample => sample.anchors[1])).size).toBeGreaterThanOrEqual(3);
      }
    } else {
      // Each wheel quiet interval may legitimately finish a gesture on a slow
      // runner. Within every owned epoch the follower must still stay put.
      expect(ownedSamples.every(sample => sample.followerTop === sample.initialFollowerTop)).toBe(true);
    }
    await observation.evaluate(value => value.stop());
    await observation.dispose();
    if (input === 'scrollbar') await page.mouse.up();
    await expect.poll(() => page.evaluate(async () => {
      const { timelineCoordinator: c } = await import('/src/utils/timeline/coordinator.ts');
      const group = c.getSnapshot().groups[0];
      return group.ownerParticipantId === null && group.members.every(member => !member.pending && !member.inFlight)
        && c.readSlotAnchor(group.memberSlots[1])?.timeMs === group.committedAnchor?.timeMs;
    })).toBe(true);
  });
  }
  }
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
