import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginViewBinding } from '../types/pluginViews';
import { useAppStore } from '../stores/useAppStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useRuleStore } from '../stores/useRuleStore';
import { releaseUnusedPortState } from '../stores/releaseTerminalState';
import { getRxPipeline, RxPipeline } from './rxPipeline';
import { feedPluginBytes, MAX_OBSERVER_QUEUE_BYTES, resetPluginBytesObserverForTest } from './pluginBytesObserver';
import { addPluginRxObserver, resetPluginObserverForTest, MAX_BYTES_PER_DELIVERY } from './pluginObserver';
import { getManagerPortIds } from './terminal/viewportManager';
import { getPluginLineConsumerCount, hasPortDisplayConsumers, notifyPluginViewPortStatus, subscribePluginViewInput } from './pluginViewInput';

const binding = (instance: string, portId: string | null = 'COM1'): PluginViewBinding => ({
  pluginId: 'p', installGeneration: 'generation', viewId: 'plot', placement: 'workspace-tab',
  tabId: instance, tabSessionId: instance, viewInstanceId: instance, workerEpoch: 1, streamEpoch: 4, boundPortId: portId, portMode: portId ? 'trx' : null,
});
const cleanups: Array<() => void> = [];
const callbacks = () => ({ onInput: vi.fn(), onDiscontinuity: vi.fn(), onStatus: vi.fn() });
const feed = (text: string) => getRxPipeline().feedBytes('COM1', new TextEncoder().encode(text), 12);
const flush = () => vi.advanceTimersByTime(20);

beforeEach(() => {
  vi.useFakeTimers();
  useRuleStore.getState().setTriggerRules([]);
  useAppStore.setState({ ports: [{ id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false }], tabs: [], activeTabId: null,
    paneTree: { id: 'main', type: 'leaf', size: 1, tabIds: [] }, focusedPaneId: 'main' });
  useTerminalStore.setState({ terminals: {} });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  getRxPipeline().releasePort('COM1');
  resetPluginObserverForTest();
  resetPluginBytesObserverForTest();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fixed plugin view input leases', () => {
  it('keeps the shared parser and encoding after raw tab close and after another line lease retires', () => {
    const tabId = useAppStore.getState().openTab('COM1');
    useTerminalStore.getState().setTerminalEncoding('COM1', 'GBK');
    const first = callbacks();
    const second = callbacks();
    const retireFirst = subscribePluginViewInput(binding('first'), 'lines', first);
    cleanups.push(retireFirst, subscribePluginViewInput(binding('second'), 'lines', second));
    feed('par');
    useAppStore.getState().closeTab(tabId);
    expect(releaseUnusedPortState('COM1')).toBe(false);
    retireFirst();
    expect(getPluginLineConsumerCount('COM1')).toBe(1);
    feed('tial\n');
    flush();
    expect(second.onInput).toHaveBeenCalledWith([expect.objectContaining({ rawData: new TextEncoder().encode('partial'), encoding: 'gbk' })], 4, false);
    expect(first.onInput).not.toHaveBeenCalled();
    expect(getManagerPortIds()).not.toContain('COM1');
  });

  it('isolates fixed port targets, clones exact byte buffers, and gives late subscribers no queued replay', () => {
    const a = callbacks();
    cleanups.push(subscribePluginViewInput(binding('a'), 'bytes', a));
    const backing = new Uint8Array([1, 2, 3, 4]);
    feedPluginBytes('COM1', backing.subarray(1, 3), 1);
    backing.fill(9);
    const b = callbacks();
    cleanups.push(subscribePluginViewInput(binding('b'), 'bytes', b));
    feedPluginBytes('COM2', [8], 2);
    flush();
    expect(a.onInput.mock.calls[0][0][0].bytes).toEqual(new Uint8Array([2, 3]));
    expect(a.onInput.mock.calls[0][0][0].bytes.buffer.byteLength).toBe(2);
    expect(b.onInput).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues byte input after raw tab removal and cancels pending delivery when the last view closes', () => {
    const tabId = useAppStore.getState().openTab('COM1');
    const cb = callbacks();
    const retire = subscribePluginViewInput(binding('bytes-only'), 'bytes', cb);
    cleanups.push(retire);
    useAppStore.getState().closeTab(tabId);
    expect(releaseUnusedPortState('COM1')).toBe(false);
    feedPluginBytes('COM1', [7, 8], 1);
    flush();
    expect(cb.onInput).toHaveBeenCalledWith([expect.objectContaining({ bytes: new Uint8Array([7, 8]) })], 4, false);
    feedPluginBytes('COM1', [9], 2);
    retire();
    expect(vi.getTimerCount()).toBe(0);
    feedPluginBytes('COM1', [10], 3);
    expect(vi.getTimerCount()).toBe(0);
    expect(cb.onDiscontinuity).not.toHaveBeenCalled();
    expect(getManagerPortIds()).not.toContain('COM1');
  });

  it('delivers bounded batches while hidden without relying on animation frames', () => {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'hidden' }));
    const frame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frame);
    const cb = callbacks();
    cleanups.push(subscribePluginViewInput(binding('hidden'), 'bytes', cb));
    feedPluginBytes('COM1', new Uint8Array(300 * 1024), 1);
    flush();
    expect(cb.onInput.mock.calls[0][0].reduce((sum: number, item: { bytes: Uint8Array }) => sum + item.bytes.length, 0)).toBe(256 * 1024);
    flush();
    expect(cb.onInput).toHaveBeenCalledTimes(2);
    expect(frame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('carries queue trimming and failed Worker posts in the next retained envelope', () => {
    const cb = callbacks();
    cb.onInput.mockReturnValueOnce(false);
    cleanups.push(subscribePluginViewInput(binding('slow'), 'bytes', cb));
    feedPluginBytes('COM1', new Uint8Array(MAX_OBSERVER_QUEUE_BYTES + 1), 1);
    flush();
    flush();
    expect(cb.onInput.mock.calls[0].slice(1)).toEqual([5, true]);
    expect(cb.onInput.mock.calls[1].slice(1)).toEqual([6, true]);
    expect(cb.onDiscontinuity).toHaveBeenCalledWith('queue-overflow', 5);
    expect(cb.onDiscontinuity).toHaveBeenCalledWith('delivery-failed', 6);
  });

  it('orders disconnect, reconnect and both mode boundaries before subsequent payloads', () => {
    const events: string[] = [];
    cleanups.push(subscribePluginViewInput(binding('events'), 'bytes', {
      onInput: (_batch, epoch, gap) => { events.push(`input:${epoch}:${gap}`); },
      onDiscontinuity: (reason, epoch) => { events.push(`${reason}:${epoch}`); },
      onStatus: (status, epoch) => { events.push(`status:${status}:${epoch}`); },
    }));
    events.length = 0;
    feedPluginBytes('COM1', [99], 1);
    notifyPluginViewPortStatus('COM1', 'disconnected');
    useAppStore.getState().updatePort('COM1', { status: 'disconnected' });
    useAppStore.getState().updatePort('COM1', { status: 'connected' });
    useAppStore.getState().updatePort('COM1', { mode: 'tty' });
    useAppStore.getState().updatePort('COM1', { mode: 'trx' });
    feedPluginBytes('COM1', [1], 2);
    flush();
    expect(events).toEqual(['port-disconnected:5', 'status:disconnected:5', 'port-connected:6', 'status:connected:6', 'mode-tty:7', 'mode-trx:8', 'input:8:true']);
  });

  it('does not place an oversized frame gap before earlier intact rows', () => {
    const cb = callbacks();
    cleanups.push(subscribePluginViewInput(binding('lines'), 'lines', cb));
    feed('before\n');
    getRxPipeline().enqueueFrame('COM1', { timestamp: 2, direction: 'RX', isHex: false, rawData: new Uint8Array(MAX_BYTES_PER_DELIVERY + 1) });
    feed('after\n');
    flush();
    flush();
    expect(cb.onInput.mock.calls.map(call => call.slice(1))).toEqual([[4, false], [5, true]]);
  });

  it('input:none retains metadata without allocating input queues and the last lease reclaims metadata', () => {
    const cb = callbacks();
    const retire = subscribePluginViewInput(binding('none'), 'none', cb);
    cleanups.push(retire);
    expect(hasPortDisplayConsumers('COM1')).toBe(true);
    feed('ignored tail');
    feedPluginBytes('COM1', [1], 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(getPluginLineConsumerCount('COM1')).toBe(0);
    retire();
    expect(hasPortDisplayConsumers('COM1')).toBe(false);
    expect(useTerminalStore.getState().terminals.COM1).toBeUndefined();
    expect(cb.onDiscontinuity).not.toHaveBeenCalled();
  });

  it('retains encoding and shared metadata for a loading or unavailable bound tab without an input lease', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalEncoding('COM1', 'GBK');
    const tabId = useAppStore.getState().addPluginTab({ kind: 'plugin', pluginId: 'p', installGeneration: 'g',
      viewId: 'plot', boundPortId: 'COM1', instanceKey: 'pending', restoreOnStartup: false, title: 'Loading' });
    expect(hasPortDisplayConsumers('COM1')).toBe(true);
    expect(getPluginLineConsumerCount('COM1')).toBe(0);
    expect(releaseUnusedPortState('COM1')).toBe(false);
    expect(useTerminalStore.getState().terminals.COM1.encoding).toBe('GBK');
    feed('ignored tail');
    expect(vi.getTimerCount()).toBe(0);
    useAppStore.getState().closeTab(tabId);
    expect(releaseUnusedPortState('COM1')).toBe(true);
    expect(useTerminalStore.getState().terminals.COM1).toBeUndefined();
  });

  it('unbound views allocate no port state and view retirement does not detach legacy observers', () => {
    const cb = callbacks();
    cleanups.push(subscribePluginViewInput(binding('unbound', null), 'lines', cb));
    expect(hasPortDisplayConsumers('COM1')).toBe(false);
    expect(cb.onStatus).not.toHaveBeenCalled();
    const legacy = { onRxLines: vi.fn(), onRxDetached: vi.fn() };
    cleanups.push(addPluginRxObserver(legacy));
    const retire = subscribePluginViewInput(binding('bound'), 'lines', callbacks());
    cleanups.push(retire);
    feed('par');
    retire();
    feed('tial\n');
    flush();
    expect(legacy.onRxLines).toHaveBeenCalledWith([expect.objectContaining({ rawData: new TextEncoder().encode('partial') })]);
    expect(legacy.onRxDetached).not.toHaveBeenCalled();
  });
});

describe('pipeline consumer gates', () => {
  it('holds no stock queue/tick without a target and reclaims tail timers on final release', () => {
    const append = vi.fn();
    const schedule = vi.fn(() => 1);
    let retained = true;
    const pipeline = new RxPipeline({ appendLines: append, getEncodingLabel: () => 'utf-8', getIgnoreEmptyChars: () => false,
      hasTerminalTarget: () => false, hasLineConsumers: () => retained, scheduleFlush: schedule });
    const lines = vi.fn();
    pipeline.addOnLineAssembledListener(lines);
    pipeline.feedBytes('COM1', [65, 10, 66], 1);
    expect(lines).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    retained = false;
    pipeline.feedBytes('COM1', [67], 2);
    expect(vi.getTimerCount()).toBe(0);
    pipeline.flushBeforeSend('COM1');
    expect(append).not.toHaveBeenCalled();
    pipeline.dispose();
  });
});
