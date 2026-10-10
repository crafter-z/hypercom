// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolTemplate, SerialPort, TerminalLine } from '../types';
import type { SerialDataEvent, SerialStatusEvent } from '../services/tauri';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { getRxPipeline } from '../utils/rxPipeline';
import { addPluginRxObserver, resetPluginObserverForTest } from '../utils/pluginObserver';
import type { RxPipeline, RxPipelineOptions } from '../utils/rxPipeline';
import { lostPortIds } from './disconnectTracking';
import { useSerialReceive, openTabForConnectedPort } from './useSerialReceive';
import { subscribePluginViewInput } from '../utils/pluginViewInput';

const eventHandlers = vi.hoisted(() => ({
  data: null as ((event: SerialDataEvent) => void) | null,
  status: null as ((event: SerialStatusEvent) => void) | null,
}));
vi.mock('../services/tauri', () => ({
  eventService: {
    onSerialData: vi.fn(async (cb) => { eventHandlers.data = cb; return () => { eventHandlers.data = null; }; }),
    onSerialStatus: vi.fn(async (cb) => { eventHandlers.status = cb; return () => { eventHandlers.status = null; }; }),
  },
  serialService: {},
}));
const output = vi.hoisted(() => ({ rows: [] as TerminalLine[] }));
vi.mock('../utils/rxPipeline', async (importOriginal) => {
  const original = await importOriginal<{ RxPipeline: new (opts: RxPipelineOptions) => RxPipeline }>();
  let instance: RxPipeline | undefined;
  return {
    ...original,
    getRxPipeline: () => (instance ??= new original.RxPipeline({
      appendLines: (_port, lines) => output.rows.push(...lines),
      getEncodingLabel: () => 'utf-8',
      getIgnoreEmptyChars: () => false,
      scheduleFlush: () => 1,
      cancelFlush: () => {},
      maxLinesPerTick: 2,
    })),
  };
});
vi.mock('../utils/ttyService', () => ({ ttyService: { feed: vi.fn(), disconnect: vi.fn(), resync: vi.fn() } }));
vi.mock('../utils/trafficStats', () => ({ trafficStats: { addRx: vi.fn(), release: vi.fn() } }));
vi.mock('../utils/pluginBytesObserver', () => ({ hasPluginBytesObservers: () => false, feedPluginBytes: vi.fn(), notifyBytesPortDisconnected: vi.fn(), discardPluginBytesPortInput: vi.fn() }));
vi.mock('../utils/triggerEngine', () => ({ evaluateTriggers: vi.fn(() => []) }));
vi.mock('./useSerialSend', () => ({ sendToPort: vi.fn(), releaseSendHistory: vi.fn() }));

const template = (id: string, header: string): ProtocolTemplate => ({
  id, name: id, isEnabled: true, headerBytes: header,
  lengthFieldOffset: 2, lengthFieldSize: 1, lengthEndian: 'little', lengthAdjust: 0,
  checksumAlgorithm: 'none', checksumOffset: 0, footerBytes: '0D 0A',
  colorHeader: '#111', colorLength: '#222', colorPayload: '#333',
  colorChecksum: '#444', colorFooter: '#555',
});
const port = (extras: Partial<SerialPort> = {}): SerialPort => ({
  id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false, ...extras,
});
const utf8 = (text: string) => Array.from(new TextEncoder().encode(text));
const texts = () => output.rows.map(line => line.content ?? new TextDecoder().decode(line.rawData));
const receive = (data: number[]) => eventHandlers.data!({ port_id: 'COM1', data, timestamp: 42, direction: 'RX', is_hex: false });
let root: Root;
const Probe = () => { useSerialReceive(); return null; };

beforeEach(async () => {
  output.rows.length = 0;
  resetPluginObserverForTest();
  lostPortIds.delete('COM1');
  useAppStore.setState({ ports: [port()], tabs: [], paneTree: { id: 'main', type: 'leaf', tabIds: [], size: 1 }, activeTabId: null, focusedPaneId: 'main' });
  useRuleStore.getState().setProtocolTemplates([template('A', 'AA BB'), template('B', 'CC DD')]);
  useRuleStore.getState().setTriggerRules([]);
  useAppStore.getState().openTab('COM1');
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(createElement(Probe)); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  getRxPipeline().disconnect('COM1');
  resetPluginObserverForTest();
  vi.clearAllMocks();
});

describe('useSerialReceive protocol lifecycle', () => {
  it('A → B → A never revives an old partial frame; retired bytes appear in stream order', () => {
    useAppStore.getState().updatePort('COM1', { protocolTemplateId: 'A' });
    receive([0xaa, 0xbb, 0x06]);
    useAppStore.getState().updatePort('COM1', { protocolTemplateId: 'B' });
    receive([0xcc, 0xdd, 0x06]);
    useAppStore.getState().updatePort('COM1', { protocolTemplateId: 'A' });
    receive([1, 2, 13, 10]);
    eventHandlers.status!({ port_id: 'COM1', status: 'disconnected' });
    expect(output.rows.filter(row => row.parsedFields)).toHaveLength(0);
    expect(output.rows.length).toBeGreaterThanOrEqual(3);
    expect(Array.from(output.rows[0]!.rawData!)).toEqual([0xaa, 0xbb, 0x06]);
    expect(Array.from(output.rows[1]!.rawData!)).toEqual([0xcc, 0xdd, 0x06]);
  });

  it('edit, disable, mode switch and tab close retire buffered bytes without stale parsers', () => {
    useAppStore.getState().updatePort('COM1', { protocolTemplateId: 'A' });
    receive([0xaa, 0xbb, 0x06]);
    useRuleStore.getState().updateProtocolTemplate('A', { headerBytes: 'AA CC' });
    receive([0xaa, 0xcc, 0x06]);
    useRuleStore.getState().updateProtocolTemplate('A', { isEnabled: false });
    receive(utf8('plain\n'));
    useRuleStore.getState().updateProtocolTemplate('A', { isEnabled: true });
    receive([0xaa, 0xcc]);
    useAppStore.getState().updatePort('COM1', { mode: 'tty' });
    useAppStore.getState().updatePort('COM1', { mode: 'trx' });
    receive([0xaa, 0xcc]);
    useAppStore.getState().closeTab(useAppStore.getState().tabs.find(tab => tab.kind === 'serial' && tab.portId === 'COM1')!.id);
    receive([0xaa, 0xcc]);
    expect(texts()).toContain('plain');
    expect(output.rows.filter(row => row.parsedFields)).toHaveLength(0);
    expect(output.rows.some(row => Array.from(row.rawData!).join(',') === '170,187,6')).toBe(true);
    expect(output.rows.some(row => Array.from(row.rawData!).join(',') === '170,204,6')).toBe(true);
  });

  it('parses a fresh complete frame after an in-place template edit', () => {
    useAppStore.getState().updatePort('COM1', { protocolTemplateId: 'A' });
    receive([0xaa, 0xbb, 0x06]);
    useRuleStore.getState().updateProtocolTemplate('A', { headerBytes: 'AA CC' });
    receive([0xaa, 0xcc, 0x06, 0x01, 0x02, 13, 10]);
    eventHandlers.status!({ port_id: 'COM1', status: 'disconnected' });
    expect(output.rows.filter(row => row.parsedFields)).toHaveLength(1);
    expect(Array.from(output.rows[0]!.rawData!)).toEqual([0xaa, 0xbb, 0x06]);
    expect(Array.from(output.rows[1]!.rawData!)).toEqual([0xaa, 0xcc, 0x06, 0x01, 0x02, 13, 10]);
  });

  it('complete frames notify observers once after the row is queued', () => {
    const onLine = vi.fn(() => getRxPipeline().flushBeforeSend('COM1'));
    const remove = getRxPipeline().addOnLineAssembledListener(onLine);
    useAppStore.getState().updatePort('COM1', { protocolTemplateId: 'A' });
    receive([0xaa, 0xbb, 0x06, 0x01, 0x02, 13, 10]);
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(output.rows).toHaveLength(1);
    expect(output.rows[0]!.parsedFields).toBeDefined();
    remove();
  });

  it('delivers each protocol frame once through the real RX observer bus, preserving bytes and order without replay events', () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const lines: Array<{ rawData: number[]; encoding: string; seq: number; ts: number }> = [];
    const detached = vi.fn();
    const dropped = vi.fn();
    const unsubscribe = addPluginRxObserver({
      onRxLines: (batch) => lines.push(...batch.map(({ rawData, encoding, seq, ts }) => ({
        rawData: Array.from(rawData), encoding, seq, ts,
      }))),
      onRxDetached: detached,
      onRxDropped: dropped,
    });
    try {
      useAppStore.getState().updatePort('COM1', { protocolTemplateId: 'A' });
      const firstFrame = [0xaa, 0xbb, 0x06, 0xff, 0x80, 13, 10];
      const secondFrame = [0xaa, 0xbb, 0x06, 0x01, 0x02, 13, 10];
      receive([0x78, 10, ...firstFrame, 0x79, 10, ...secondFrame]);
      getRxPipeline().enqueueLines('COM1', [{
        timestamp: 42, direction: 'RX', content: 'replay', rawData: new Uint8Array([0x72]), isHex: false,
      }]);
      vi.advanceTimersByTime(20);
      expect(lines).toEqual([
        { rawData: [0x78], encoding: 'utf-8', seq: 0, ts: 42 },
        { rawData: firstFrame, encoding: 'utf-8', seq: 1, ts: 42 },
        { rawData: [0x79], encoding: 'utf-8', seq: 2, ts: 42 },
        { rawData: secondFrame, encoding: 'utf-8', seq: 3, ts: 42 },
      ]);
      expect(detached).not.toHaveBeenCalled();
      expect(dropped).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps protocol state for independent line leases after the serial UUID tab closes', () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const onInput = vi.fn();
    const unsubscribe = subscribePluginViewInput({
      pluginId: 'p', installGeneration: 'g', viewId: 'plot', placement: 'workspace-tab',
      tabId: 'plugin-tab', tabSessionId: 'session', viewInstanceId: 'instance',
      workerEpoch: 1, streamEpoch: 1, boundPortId: 'COM1', portMode: 'trx',
    }, 'lines', { onInput, onDiscontinuity: vi.fn(), onStatus: vi.fn() });
    try {
      useAppStore.getState().updatePort('COM1', { protocolTemplateId: 'A' });
      receive([0xaa, 0xbb, 0x06]);
      const serialTab = useAppStore.getState().tabs.find(tab => tab.kind === 'serial' && tab.portId === 'COM1')!;
      useAppStore.getState().closeTab(serialTab.id);
      receive([1, 2, 13, 10]);
      vi.advanceTimersByTime(20);
      expect(onInput).toHaveBeenCalledWith([expect.objectContaining({ rawData: new Uint8Array([0xaa, 0xbb, 0x06, 1, 2, 13, 10]) })], 1, false);
      openTabForConnectedPort('COM1');
      expect(useAppStore.getState().tabs).toHaveLength(0);
    } finally {
      unsubscribe();
      vi.useRealTimers();
      visibility.mockRestore();
    }
  });

  it('keeps trigger-only assembly without tabs and releases partial input when the last applicable rule is disabled', () => {
    vi.useFakeTimers();
    const rule = { id: 'trigger', name: 'Trigger', pattern: 'ready', isRegex: false, matchType: 'contains' as const,
      actionType: 'alert' as const, actionContent: 'ready', actionIsHex: false, isEnabled: true, portId: 'COM1' };
    const assembled = vi.fn();
    const remove = getRxPipeline().addOnLineAssembledListener(assembled);
    try {
      const tabId = useAppStore.getState().tabs[0].id;
      useRuleStore.getState().setTriggerRules([rule]);
      useAppStore.getState().closeTab(tabId);
      receive(utf8('rea'));
      receive(utf8('dy\n'));
      expect(assembled).toHaveBeenCalledWith('COM1', expect.objectContaining({ text: 'ready' }));
      receive(utf8('discard'));
      useRuleStore.getState().updateTriggerRule('trigger', { isEnabled: false });
      expect(vi.getTimerCount()).toBe(0);
      useRuleStore.getState().updateTriggerRule('trigger', { isEnabled: true, portId: 'COM2' });
      receive(utf8('ignored'));
      expect(vi.getTimerCount()).toBe(0);
      useRuleStore.getState().updateTriggerRule('trigger', { portId: undefined });
      receive(utf8('fresh\n'));
      expect(assembled).toHaveBeenLastCalledWith('COM1', expect.objectContaining({ text: 'fresh' }));
    } finally {
      remove();
      useRuleStore.getState().setTriggerRules([]);
      vi.useRealTimers();
    }
  });

  it('tool-owned disconnect suppresses lost banner while still draining RX', () => {
    useAppStore.getState().updatePort('COM1', { toolRunning: true });
    receive(utf8('a\nb\nc\n'));
    eventHandlers.status!({ port_id: 'COM1', status: 'disconnected' });
    expect(lostPortIds.has('COM1')).toBe(false);
    expect(texts()).toEqual(['a', 'b', 'c']);
  });

  it('still marks an unexpected disconnect as lost when no tool owns the port', () => {
    eventHandlers.status!({ port_id: 'COM1', status: 'disconnected' });
    expect(lostPortIds.has('COM1')).toBe(true);
  });

});
