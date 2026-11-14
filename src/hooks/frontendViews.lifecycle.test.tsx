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
import { getFlowStatus, isFlowRunning, resetFlowRuntime } from '../utils/flowRuntime';
import type { SendCommand, SendCommandSet } from '../types';

vi.mock('../services/tauri', () => ({
  serialService: { sendSerialData: vi.fn(), setSerialParams: vi.fn() },

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
  resetFlowRuntime();
  useAppStore.setState({ ports: [{ id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false, mode: 'trx' }] });
  getViewportManager('COM1');
  tabId = useAppStore.getState().openTab('COM1');
  vi.mocked(serialService.sendSerialData).mockResolvedValue(3);
  vi.mocked(serialService.setSerialParams).mockResolvedValue(undefined);
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
  it('does not leave a TX echo when authorization advances the connection generation', async () => {
    useAppStore.getState().updatePort('COM1', { connectionGeneration: 7 });
    const written = await act(async () => sendToPort('COM1', 'stale', false, 'None', false, () => {
      useAppStore.getState().updatePort('COM1', { connectionGeneration: 8 });
    }));
    expect(written).toBe(0);
    expect(serialService.sendSerialData).not.toHaveBeenCalled();
    expect(snapshotTerminalLines('COM1')).toEqual([]);
  });

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

  it('does not advance a legacy loop after a silent zero-byte send refusal', async () => {
    vi.mocked(serialService.sendSerialData).mockResolvedValue(0);
    const command = { id: 'zero', name: 'zero', content: 'zero', order: 0, delay: 0, type: 'string' as const, appendLineEnding: 'None' as const };
    useRuleStore.getState().setSendCommandSets([{
      id: 'zero-set', name: 'zero-set', isLoop: false, loopDelay: 0, repeatCount: 1, commands: [command],
    }]);
    useRuleStore.getState().setActiveSendCommandSetId('zero-set');
    await act(async () => {
      useOperationStore.getState().setCyclicLoop('COM1', true);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(serialService.sendSerialData).toHaveBeenCalledTimes(1);
    expect(useOperationStore.getState().cyclicLoops.COM1).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(vi.mocked(serialService.sendSerialData).mock.calls.length).toBeGreaterThan(1);
    expect(useOperationStore.getState().cyclicLoops.COM1).toBe(true);
  });

  it.each(['string', 'hex'] as const)('advances a legitimate empty %s payload rather than retrying it forever', async type => {
    vi.mocked(serialService.sendSerialData).mockImplementation(async args => args.data.trim() ? 1 : 0);
    const command = (id: string, content: string, order: number): SendCommand => ({ id, name: id, content, order, delay: 0, type, appendLineEnding: 'None' });
    useRuleStore.getState().setSendCommandSets([{
      id: 'empty-set', name: 'empty-set', isLoop: false, loopDelay: 0, repeatCount: 1,
      commands: [command('empty', '', 0), command('next', type === 'hex' ? '41' : 'NEXT', 1)],
    }]);
    useRuleStore.getState().setActiveSendCommandSetId('empty-set');
    await act(async () => {
      useOperationStore.getState().setCyclicLoop('COM1', true);
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(vi.mocked(serialService.sendSerialData).mock.calls.map(([args]) => args.data)).toEqual(['', type === 'hex' ? '41' : 'NEXT']);
    expect(Boolean(useOperationStore.getState().cyclicLoops.COM1)).toBe(false);
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

/**
 * 增强流程（命令集含 setParams 动作）：与旧命令集共用同一 runtime，
 * 但要按步骤真实执行、发布端口独占，并且不得改变旧 send-only 命令集的行为。
 * 等待不再是独立的步骤类型——它是每一步自带的 `delay`（发送与改参都生效）。
 */
describe('enhanced command flow', () => {
  const sendStep = (content: string, order: number, delay = 0): SendCommand => ({
    id: `send-${order}`, name: content, order, delay, type: 'string', content, appendLineEnding: 'None',
  });
  const setParams = (baudRate: number, order: number, delay = 0): SendCommand => ({
    id: `params-${order}`, name: 'params', order, delay, type: 'string', content: '', appendLineEnding: 'None', kind: 'setParams', baudRate,
  });

  /**
   * 推进假计时器，并消费「tick 内部 await 之后才排上的 0ms 跳转」——只调
   * `advanceTimersByTimeAsync` 会在恰好用尽预算时停在两步之间。
   */
  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });
  };

  async function startFlow(commands: SendCommand[], extra: Partial<SendCommandSet> = {}): Promise<void> {
    useRuleStore.getState().setSendCommandSets([{
      id: 'flow', name: 'flow', isLoop: false, loopDelay: 0, repeatCount: 1,
      schemaVersion: 2, commands, ...extra,
    }]);
    useRuleStore.getState().setActiveSendCommandSetId('flow');
    await act(async () => { useOperationStore.getState().setCyclicLoop('COM1', true); });
    await advance(100);
  }

  it('honours the wait attached to a parameter step instead of sending right away', async () => {
    await startFlow([
      { ...sendStep('AA', 0), type: 'hex' },
      setParams(230400, 1, 400),
      sendStep('CC', 2),
    ]);

    expect(serialService.setSerialParams).toHaveBeenCalledWith('COM1', expect.objectContaining({ baudRate: 230400 }));
    // 本机参数与端口元数据同步到新波特率（侧边栏/参数面板/后续步骤同源）。
    expect(useAppStore.getState().ports.find(port => port.id === 'COM1')?.baudRate).toBe(230400);
    expect(useOperationStore.getState().baudRate).toBe(230400);
    // 「之后等待」挂在改参步骤上：下一步还没发，且状态如实显示在等多久。
    expect(vi.mocked(serialService.sendSerialData).mock.calls.map(([args]) => args.data)).toEqual(['AA']);
    expect(getFlowStatus('COM1')).toMatchObject({ phase: 'waiting', detail: '400 ms' });
    expect(isFlowRunning('COM1')).toBe(true);

    // 等没等够由计时器决定：先跑 200ms 仍不得发下一步。
    await advance(200);
    expect(vi.mocked(serialService.sendSerialData).mock.calls.map(([args]) => args.data)).toEqual(['AA']);

    await advance(300);
    expect(vi.mocked(serialService.sendSerialData).mock.calls.map(([args]) => args.data)).toEqual(['AA', 'CC']);
    // 发满 repeatCount 后自然结束并释放独占。
    expect(useOperationStore.getState().cyclicLoops.COM1).toBeFalsy();
    expect(getFlowStatus('COM1')?.phase).toBe('completed');
    expect(isFlowRunning('COM1')).toBe(false);
  });

  it('blocks user sends while the flow owns the port and frees it on stop', async () => {
    await startFlow([sendStep('AA', 0), setParams(230400, 1, 5000), sendStep('CC', 2)]);

    expect(vi.mocked(serialService.sendSerialData)).toHaveBeenCalledTimes(1);
    expect(isFlowRunning('COM1')).toBe(true);
    expect(getFlowStatus('COM1')).toMatchObject({ phase: 'waiting', detail: '5000 ms' });

    // 手动发送（默认 origin='user'）在流程占用期间被统一入口拒绝，且没有到后端。
    const written = await act(async () => sendToPort('COM1', 'manual', false, 'None'));
    expect(written).toBe(0);
    expect(vi.mocked(serialService.sendSerialData)).toHaveBeenCalledTimes(1);

    await act(async () => { useOperationStore.getState().setCyclicLoop('COM1', false); });
    await advance(0);
    expect(isFlowRunning('COM1')).toBe(false);
    expect(getFlowStatus('COM1')?.phase).toBe('stopped');

    // 停止直接清掉未到期的等待计时器，不会在 5s 后继续跑下去。
    await advance(6000);
    expect(vi.mocked(serialService.sendSerialData)).toHaveBeenCalledTimes(1);
  });

  it('never locks the port for a legacy send-only command set', async () => {
    await startFlow([sendStep('LEGACY', 0)], { schemaVersion: undefined, isLoop: true, repeatCount: 0, loopDelay: 1000 });

    expect(getFlowStatus('COM1')).toBeNull();
    expect(isFlowRunning('COM1')).toBe(false);
    expect(vi.mocked(serialService.sendSerialData)).toHaveBeenCalledTimes(1);
    // 旧循环正在运行，用户手动发送不被流程守卫拦截（旧体验不变）。
    const written = await act(async () => sendToPort('COM1', 'manual', false, 'None'));
    expect(written).toBe(3);
    expect(vi.mocked(serialService.sendSerialData)).toHaveBeenCalledTimes(2);

    await act(async () => { useOperationStore.getState().setCyclicLoop('COM1', false); });
    expect(useOperationStore.getState().cyclicLoops.COM1).toBeFalsy();
  });
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
