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
import { serialService } from '../services/tauri';
import { fileService, type ReplayPickedSources } from '../services/file';
import { sendToPort, useSerialSend, releaseSendHistory, type SerialSendActions } from './useSerialSend';
import { useLogReplay } from '../components/MainDisplay/hooks/useLogReplay';
import { useCyclicSend } from '../components/OperationPanel/hooks/useCyclicSend';
import { getViewportManager, snapshotTerminalLines, releaseViewportManager } from '../utils/terminal/viewportManager';
import { getRxPipeline } from '../utils/rxPipeline';
import { trafficStats } from '../utils/trafficStats';
import { ttyService } from '../utils/ttyService';

vi.mock('../services/tauri', () => ({
  serialService: { sendSerialData: vi.fn() },

  gitBashSimService: { resizeGitBashSim: vi.fn(async () => {}) },
}));
vi.mock('../services/file', () => ({ fileService: { pickReplaySources: vi.fn(), readReplaySourceChunk: vi.fn(), releaseReplaySources: vi.fn(async () => {}) } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const picked: ReplayPickedSources = { grantId: 'grant', sources: [{ sourceId: 'source', name: 'old.log', path: 'C:/old.log', size: 5, fingerprint: 'a'.repeat(64) }] };
let root: Root;
let send!: SerialSendActions;
let replay!: ReturnType<typeof useLogReplay>;
let tabId: string;
function Probe() {
  send = useSerialSend();
  replay = useLogReplay();
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
  vi.mocked(fileService.pickReplaySources).mockResolvedValue(picked);
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

  it('releases a native picker result arriving after cancellation and never writes a serial buffer', async () => {
    const selecting = deferred<ReplayPickedSources | null>();
    vi.mocked(fileService.pickReplaySources).mockImplementationOnce(() => selecting.promise);
    let picking!: Promise<void>;
    await act(async () => { picking = replay.startImport(); });
    await act(async () => { replay.cancelImport(); selecting.resolve(picked); await picking; });
    expect(replay.picked).toBeNull();
    expect(fileService.releaseReplaySources).toHaveBeenCalledWith('grant');
    expect(snapshotTerminalLines('COM1')).toEqual([]);
  });

  it('cancels an in-flight chunk on unmount without appending historical rows', async () => {
    const reading = deferred<{ base64: string; nextOffset: number; done: boolean }>();
    vi.mocked(fileService.readReplaySourceChunk).mockImplementationOnce(() => reading.promise);
    await act(async () => { await replay.startImport(); });
    let importing!: Promise<void>;
    await act(async () => { importing = replay.confirmImport([{ title: 'track', sourceIds: ['source'], options: { encoding: 'UTF-8', format: 'text', timezoneOffsetMinutes: 0 } }]); });
    // Observe rejection before unmount, so the cooperative abort isn't unhandled.
    const result = importing.catch(error => error);
    await act(async () => { root.unmount(); });
    root = createRoot(document.createElement('div'));
    await act(async () => { reading.resolve({ base64: btoa('hello'), nextOffset: 5, done: true }); await result; });
    expect((await result).name).toBe('AbortError');
    expect(snapshotTerminalLines('COM1')).toEqual([]);
    expect(fileService.releaseReplaySources).toHaveBeenCalledWith('grant');
  });

  it('keeps import independent when the focused real port retires', async () => {
    await act(async () => { await replay.startImport(); retireTab(); });
    expect(replay.picked?.grantId).toBe('grant');
    await act(async () => { replay.cancelImport(); });
    expect(snapshotTerminalLines('COM1')).toEqual([]);
  });

  it('uses saved rank order and keeps the starting set, content and repeat count until restart', async () => {
    const command = (id: string, order: number) => ({
      id, name: id, content: id, order, delay: 25,
      type: 'string' as const, appendLineEnding: 'None' as const,
    });
    const set = {
      id: 'ordered', name: 'ordered', isLoop: false, loopDelay: 20, repeatCount: 2,
      commands: [command('B', 1), command('A', 0)],
    };
    useRuleStore.getState().setSendCommandSets([set]);
    await act(async () => {
      useOperationStore.getState().setCyclicLoop('COM1', true);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(vi.mocked(serialService.sendSerialData).mock.calls.map(([args]) => args.data)).toEqual(['A']);
    // A save, deletion and active-set change must not splice an ongoing run.
    useRuleStore.getState().setSendCommandSets([{ ...set, id: 'replacement', repeatCount: 1, commands: [command('NEW', 0)] }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(vi.mocked(serialService.sendSerialData).mock.calls.map(([args]) => [args.portId, args.data]))
      .toEqual([['COM1', 'A'], ['COM1', 'B'], ['COM1', 'A'], ['COM1', 'B']]);
    expect(Boolean(useOperationStore.getState().cyclicLoops.COM1)).toBe(false);
    await act(async () => {
      useOperationStore.getState().setCyclicLoop('COM1', true);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(vi.mocked(serialService.sendSerialData).mock.calls.map(([args]) => args.data)).toEqual(['A', 'B', 'A', 'B', 'NEW']);
    expect(Boolean(useOperationStore.getState().cyclicLoops.COM1)).toBe(false);
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
