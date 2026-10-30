import { expect, test } from '@playwright/test';

// Browser contract smoke, not a substitute for the native dialog/WebView2 gate.
const mock = `(() => {
  const callbacks = new Map(); let next = 1;
  const files = {
    a: '[2026-01-01 00:00:00Z] RX track-a-start\\n[2026-01-01 00:00:20Z] RX track-a-end\\n',
    b: '[2026-01-01 00:00:05Z] RX track-b-start\\n[2026-01-01 00:00:30Z] TX track-b-end\\n'
  };
  window.__REPLAY_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: {label:'main'}, currentWebview: {windowLabel:'main',label:'main'} },
    transformCallback: cb => { const id = next++; callbacks.set(id,cb); return id; },
    unregisterCallback: id => callbacks.delete(id),
    runCallback: (id,data) => callbacks.get(id)?.(data),
    convertFileSrc: path => path,
    invoke: async (cmd,args) => {
      window.__REPLAY_CALLS__.push({cmd,args});
      if(cmd==='get_config') { const {useAppStore}=await import('/src/stores/useAppStore.ts'); return {...structuredClone(useAppStore.getState().config),restoreSession:false,autoSaveLog:false}; }
      if(cmd==='list_available_ports' || cmd.startsWith('load_') || cmd==='get_log_files') return [];
      if(cmd==='list_plugins') return {revision:0,plugins:[],pluginConfigs:[]};
      if(cmd==='get_system_status') return {status:'normal',memoryUsedMb:0,cpuUsage:0};
      if(cmd==='plugin:app|version') return 'e2e';
      if(cmd==='plugin:window|is_maximized') return false;
      if(cmd==='plugin:event|listen') return next++;
      if(cmd==='pick_replay_sources') return {grantId:'native-grant',sources:Object.entries(files).map(([id,content])=>({sourceId:id,name:id+'.log',path:'C:/'+id+'.log',size:new TextEncoder().encode(content).length,fingerprint:'a'.repeat(64)}))};
      if(cmd==='read_replay_source_chunk') { const bytes=new TextEncoder().encode(files[args.sourceId]); const part=bytes.slice(args.offset,args.offset+11); return {base64:btoa(String.fromCharCode(...part)),nextOffset:args.offset+part.length,done:args.offset+part.length===bytes.length}; }
      return null;
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener:()=>{}};
})();`;

test('independent multi-track import, shared terminal search and paused transport without serial side effects', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(mock);
  await page.goto('/');
  await expect(page.locator('.app-root')).toBeVisible();
  await page.getByTitle('导入历史日志', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入历史日志' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('a.log', { exact: false }).first()).toBeVisible();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '导入历史日志', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.terminal-line').filter({ hasText: 'track-a-start' })).toBeVisible();
  const imported = await page.evaluate(async () => {
    const {useAppStore,getActivePortId} = await import('/src/stores/useAppStore.ts');
    const replay = await import('/src/utils/replay/replayRuntime.ts');
    const tabs = useAppStore.getState().tabs;
    const ids = tabs.filter(tab=>tab.kind==='replay').map(tab=>tab.id);
    return { count:ids.length, ports:useAppStore.getState().ports.length, target:getActivePortId(useAppStore.getState()), shared:replay.getReplayTransport(ids[0])===replay.getReplayTransport(ids[1]) };
  });
  expect(imported).toEqual({count:2,ports:0,target:null,shared:true});
  const view = page.locator('.serial-content-slot').filter({ has: page.locator('.terminal-line', { hasText: 'track-a-start' }) });
  // Search is the existing shared TerminalView Ctrl+F path, not a replay renderer.
  await page.locator('.terminal-line').filter({ hasText: 'track-a-start' }).click();
  await page.keyboard.press('Control+f');
  await expect(page.locator('.terminal-search-bar')).toBeVisible();
  await page.keyboard.press('Escape');
  const play = page.getByRole('button', { name: '播放', exact: true }).filter({ visible: true });
  await play.click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '终点', exact: true }).click();
  const transport = await page.evaluate(async () => {
    const {useAppStore}=await import('/src/stores/useAppStore.ts');
    const {getReplayTransport}=await import('/src/utils/replay/replayRuntime.ts');
    const state = useAppStore.getState();
    if (!state.activeTabId) throw new Error('Expected an active replay tab');
    const transport = getReplayTransport(state.activeTabId);
    if (!transport) {
      const runtime = await import('/src/utils/replay/replayRuntime.ts');
      const {timelineCoordinator} = await import('/src/utils/timeline/coordinator.ts');
      throw new Error(JSON.stringify({activeTabId:state.activeTabId,tabs:state.tabs,sessions:runtime.exportReplayDescriptions(),groups:timelineCoordinator.getSnapshot(),modules:performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>/replayRuntime|coordinator\\.ts|useAppStore/.test(name))}));
    }
    return transport.getSnapshot();
  });
  expect(transport.playing).toBe(false);
  expect(transport.timeMs).toBe(Date.parse('2026-01-01T00:00:30Z'));
  // External group navigation must update the replay UI, not rewind the paused clock.
  const external = await page.evaluate(async () => {
    const {useAppStore}=await import('/src/stores/useAppStore.ts');
    const {timelineCoordinator}=await import('/src/utils/timeline/coordinator.ts');
    const {getReplayTransport}=await import('/src/utils/replay/replayRuntime.ts');
    const {formatTimelineTime}=await import('/src/utils/timeFormat.ts');
    const id=useAppStore.getState().activeTabId;
    if (!id) throw new Error('Expected an active replay tab');
    const group=timelineCoordinator.groupForSlot(id), replay=getReplayTransport(id);
    if (!group || !replay) throw new Error('Expected a grouped replay transport');
    const timeMs=Date.parse('2026-01-01T00:00:10Z');
    timelineCoordinator.seek(group.id,timeMs,'commit');
    return {timeMs,label:formatTimelineTime(timeMs),clockTimeMs:replay.getSnapshot().timeMs};
  });
  expect(external.clockTimeMs).toBe(transport.timeMs);
  await expect(page.getByRole('slider', {name:'轨道',exact:true}).filter({visible:true})).toHaveValue(String(external.timeMs));
  await expect(page.getByTestId('replay-time').filter({visible:true})).toHaveText(external.label);
  await page.evaluate(async () => {
    const {useAppStore}=await import('/src/stores/useAppStore.ts');
    const {timelineCoordinator}=await import('/src/utils/timeline/coordinator.ts');
    const id=useAppStore.getState().activeTabId;
    if (!id) throw new Error('Expected an active replay tab');
    const group=timelineCoordinator.groupForSlot(id);
    if (!group) throw new Error('Expected an active replay timeline group');
    timelineCoordinator.seek(group.id,Date.parse('2026-01-01T00:00:12Z'),'preview');
  });
  await expect(page.getByRole('slider', {name:'轨道',exact:true}).filter({visible:true})).toHaveValue(String(external.timeMs+2000));
  await page.evaluate(async () => {
    const {useAppStore}=await import('/src/stores/useAppStore.ts');
    const {timelineCoordinator}=await import('/src/utils/timeline/coordinator.ts');
    const id=useAppStore.getState().activeTabId;
    if (!id) throw new Error('Expected an active replay tab');
    const group=timelineCoordinator.groupForSlot(id);
    if (!group) throw new Error('Expected an active replay timeline group');
    for(const slot of group.memberSlots) {
      const participant=timelineCoordinator.participantForSlot(slot);
      if (!participant) throw new Error(`Missing timeline participant for ${slot}`);
      timelineCoordinator.setMapping(group.id,{sourceId:participant.sourceId,sourceTimeMs:Date.parse('2026-01-01T00:00:00Z'),groupTimeMs:0,clockEpoch:participant.clockEpoch});
    }
    timelineCoordinator.seek(group.id,0,'commit');
  });
  await expect(page.getByRole('slider', {name:'轨道',exact:true}).filter({visible:true})).toHaveValue('0');
  await expect(page.getByTestId('replay-time').filter({visible:true})).toHaveText('T+0.000s');
  expect(await page.evaluate(() => window.__REPLAY_CALLS__.filter(call=>['open_serial_port','send_serial_data','send_file','read_text_file'].includes(call.cmd)))).toEqual([]);
  expect(errors).toEqual([]);
  void view;
});
