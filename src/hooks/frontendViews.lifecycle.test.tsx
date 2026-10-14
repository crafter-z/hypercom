// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import { useOperationStore } from '../stores/useOperationStore';
import { useRuleStore } from '../stores/useRuleStore';
import { useSystemStore } from '../stores/useSystemStore';
import { resetStoresForTests } from '../stores/resetStores';
import { releaseUnusedPortState } from '../stores/releaseTerminalState';
import { serialService, fileService } from '../services/tauri';
import { sendToPort, useSerialSend, releaseSendHistory, type SerialSendActions } from './useSerialSend';
import { useLogReplay, type LogReplayActions } from '../components/MainDisplay/hooks/useLogReplay';
import { useCyclicSend } from '../components/OperationPanel/hooks/useCyclicSend';
import { getViewportManager, snapshotTerminalLines, releaseViewportManager } from '../utils/terminal/viewportManager';
import { getRxPipeline } from '../utils/rxPipeline';
import { trafficStats } from '../utils/trafficStats';
import { ttyService } from '../utils/ttyService';

vi.mock('../services/tauri', () => ({
  serialService: { sendSerialData: vi.fn() },
  fileService: { readTextFile: vi.fn() },
  gitBashSimService: { resizeGitBashSim: vi.fn(async () => {}) },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const log = '[2026-10-10 10:00:00.000] RX old first\n[2026-10-10 10:00:01.000] RX old second';
let root: Root;
let send!: SerialSendActions;
let replay!: LogReplayActions;
let tabId: string;
function Probe({ portId = 'COM1' }: { portId?: string }) {
  send = useSerialSend();
  replay = useLogReplay(portId);
  useCyclicSend({ sendData: sendToPort });
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ttyService.reset();
  trafficStats.reset();
  getRxPipeline().releasePort('COM1');
  releaseSendHistory('COM1');
  releaseViewportManager('COM1');
  resetStoresForTests();
  useAppStore.setState({ ports: [{ id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false, mode: 'trx' }] });
  getViewportManager('COM1');
  tabId = useAppStore.getState().openTab('COM1');
  vi.mocked(serialService.sendSerialData).mockResolvedValue(3);
  vi.mocked(fileService.readTextFile).mockResolvedValue(log);
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(createElement(Probe)); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  getRxPipeline().releasePort('COM1');
  releaseViewportManager('COM1');
  ttyService.reset();
  trafficStats.reset();
  vi.useRealTimers();
});

function retireTab() {
  useAppStore.getState().closeTab(tabId);
  releaseViewportManager('COM1');
  expect(releaseUnusedPortState('COM1')).toBe(true);
}

describe('retired frontend view work', () => {
  it.each(['trx', 'tty'] as const)('does not restore %s history or stats after the last consumer retires', async mode => {
    await act(async () => { useAppStore.getState().setPortMode('COM1', mode); });
    const pending = deferred<number>();
    vi.mocked(serialService.sendSerialData).mockImplementationOnce(() => pending.promise);
    const sending = send.sendData('COM1', 'old', false, 'None');
    await act(async () => { retireTab(); });
    await act(async () => { pending.resolve(3); await sending; });
    trafficStats.flushNow();
    expect(useSystemStore.getState().trafficStats.COM1).toBeUndefined();
    await act(async () => { tabId = useAppStore.getState().openTab('COM1'); });
    await act(async () => { await send.sendData('COM1', 'new', false, 'None'); });
    expect(send.sendHistory.map(entry => entry.content)).toEqual(['new']);
    trafficStats.flushNow();
    expect(useSystemStore.getState().trafficStats.COM1?.txTotal).toBe(3);
  });

  it('does not put old send history into a same-port replacement view', async () => {
    const pending = deferred<number>();
    vi.mocked(serialService.sendSerialData).mockImplementationOnce(() => pending.promise);
    const sending = send.sendData('COM1', 'old', false, 'None');
    await act(async () => { retireTab(); tabId = useAppStore.getState().openTab('COM1'); });
    await act(async () => { await send.sendData('COM1', 'new', false, 'None'); });
    await act(async () => { pending.resolve(3); await sending; });
    expect(send.sendHistory.map(entry => entry.content)).toEqual(['new']);
    trafficStats.flushNow();
    expect(useSystemStore.getState().trafficStats.COM1?.txTotal).toBe(3);
  });

  it('reserves replay ownership before file read and allows stop/restart without an old read taking over', async () => {
    const reading = deferred<string>();
    vi.mocked(fileService.readTextFile).mockImplementationOnce(() => reading.promise);
    let old!: Promise<void>;
    await act(async () => {
      old = replay.startReplay('old.log', 1);
      void replay.startReplay('duplicate.log', 1);
    });
    expect(fileService.readTextFile).toHaveBeenCalledTimes(1);
    await act(async () => { replay.stopReplay(); await replay.startReplay('new.log', 0); });
    const before = snapshotTerminalLines('COM1').map(line => line.content);
    await act(async () => { reading.resolve(log); await old; });
    expect(snapshotTerminalLines('COM1').map(line => line.content)).toEqual(before);
    expect(replay.isReplaying).toBe(false);
  });

  it.each(['switch', 'retire', 'unmount'] as const)('cancels delayed replay rows on %s', async action => {
    let playing!: Promise<void>;
    await act(async () => { playing = replay.startReplay('old.log', 1); });
    expect(snapshotTerminalLines('COM1').map(line => line.content)).toEqual(['old first']);
    if (action === 'switch') await act(async () => { root.render(createElement(Probe, { portId: 'COM2' })); });
    else if (action === 'retire') await act(async () => { retireTab(); tabId = useAppStore.getState().openTab('COM1'); });
    else {
      await act(async () => { root.unmount(); });
      root = createRoot(document.createElement('div'));
      await act(async () => { root.render(createElement(Probe)); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); await playing; });
    expect(snapshotTerminalLines('COM1').some(line => line.content === 'old second')).toBe(false);
    expect(replay.isReplaying).toBe(false);
  });

  it('does not append a pending file read into a retired and reopened port', async () => {
    const reading = deferred<string>();
    vi.mocked(fileService.readTextFile).mockImplementationOnce(() => reading.promise);
    let playing!: Promise<void>;
    await act(async () => { playing = replay.startReplay('old.log', 1); });
    await act(async () => { retireTab(); tabId = useAppStore.getState().openTab('COM1'); });
    await act(async () => { reading.resolve(log); await playing; });
    expect(snapshotTerminalLines('COM1')).toEqual([]);
  });

  it('keeps a replacement cyclic run alive after an old round-limit send settles', async () => {
    const old = deferred<number>();
    const replacement = deferred<number>();
    vi.mocked(serialService.sendSerialData).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => replacement.promise);
    useRuleStore.getState().setSendCommandSets([{
      id: 'set', name: 'set', isLoop: true, loopDelay: 20, repeatCount: 1,
      commands: [{ id: 'cmd', name: 'cmd', content: 'cmd', type: 'string', appendLineEnding: 'None', delay: 0, order: 0 }],
    }]);
    useRuleStore.getState().setActiveSendCommandSetId('set');
    await act(async () => {
      useOperationStore.getState().setCyclicLoop('COM1', true);
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      useOperationStore.getState().setCyclicLoop('COM1', false);
      useRuleStore.getState().updateSendCommandSet('set', { repeatCount: 0 });
      useOperationStore.getState().setCyclicLoop('COM1', true);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(serialService.sendSerialData).toHaveBeenCalledTimes(2);
    await act(async () => { old.resolve(3); });
    expect(useOperationStore.getState().cyclicLoops.COM1).toBe(true);
    await act(async () => { replacement.resolve(3); await vi.advanceTimersByTimeAsync(20); });
    expect(serialService.sendSerialData).toHaveBeenCalledTimes(3);
    expect(useOperationStore.getState().cyclicLoops.COM1).toBe(true);
  });
});
