import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalLine } from '../../types';
import { RxPipeline } from '../rxPipeline';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { TerminalViewportManager } from './viewportManager';

const text = (value: string): TerminalLine => ({ timestamp: 1, direction: 'RX', rawData: new TextEncoder().encode(value), isHex: false });
const noise = (): TerminalLine => ({ timestamp: 2, direction: 'RX', rawData: new Uint8Array([0x80, 0x00, 0xff, 65, 0x90, 0x01, 66, 0xfe, 0x7f]), isHex: false });
let managers: TerminalViewportManager[];
const create = (maxLines = 100) => {
  const manager = new TerminalViewportManager('COM1', { maxLines });
  managers.push(manager);
  return manager;
};
const visibleSeqs = (manager: TerminalViewportManager): number[] | null => {
  const view = (manager as unknown as { buildView(): { visibleSeqs: number[] | null; visibleSeqsOffset: number } }).buildView();
  return view.visibleSeqs?.slice(view.visibleSeqsOffset) ?? null;
};
beforeEach(() => {
  vi.useFakeTimers();
  useTerminalStore.setState({ terminals: {} });
  managers = [];
});
afterEach(() => {
  managers.forEach(manager => manager.dispose());
  vi.useRealTimers();
});

describe('display-only ASCII noise filtering', () => {
  it('is opt-in, hides scattered ASCII with the noisy row, and restores the identical raw bytes', () => {
    const manager = create(), row = noise();
    manager.appendLines([text('Boot complete'), row, text('OK')]);
    expect(manager.getVisibleCount()).toBe(3);
    manager.setFilter('all', '', true);
    expect(visibleSeqs(manager)).toEqual([0, 2]);
    expect(manager.buffer.length).toBe(3);
    expect(manager.buffer.getBySeq(1)?.rawData).toBe(row.rawData);
    manager.setFilter('all', '', false);
    expect(manager.getVisibleCount()).toBe(3);
    expect(manager.buffer.getBySeq(1)?.rawData).toEqual(row.rawData);
  });

  it('combines with direction/keyword and never hides TX, TOOL or NOTE rows', () => {
    const manager = create();
    manager.setFilter('all', '', true);
    manager.appendLines([noise(), text('OK'), ...(['TX', 'TOOL', 'NOTE'] as const).map(direction => ({ ...noise(), direction }))]);
    expect(visibleSeqs(manager)).toEqual([1, 2, 3, 4]);
    manager.setFilter('RX', 'ok', true);
    expect(visibleSeqs(manager)).toEqual([1]);
    manager.appendLines([noise(), text('ok again')]);
    expect(visibleSeqs(manager)).toEqual([1, 6]);
  });

  it('keeps long continuous English mixed with binary and content-only replay rows', () => {
    const manager = create();
    manager.setFilter('all', '', true);
    manager.appendLines([
      { ...noise(), rawData: new Uint8Array([...noise().rawData!, ...new TextEncoder().encode('ERROR: failed to boot'), ...noise().rawData!]) },
      { timestamp: 0, direction: 'RX', content: '回放文本', isHex: false },
    ]);
    expect(manager.getVisibleCount()).toBe(2);
  });

  it('updates search both for old and newly appended rows and restores hits when disabled', () => {
    const manager = create();
    manager.appendLines([noise(), text('A')]);
    manager.setSearch(true, 'A', true);
    expect(manager.getMatchCount()).toBe(2);
    manager.setFilter('all', '', true);
    expect(manager.getMatchCount()).toBe(1);
    manager.appendLine(noise());
    expect(manager.getMatchCount()).toBe(1);
    manager.setFilter('all', '', false);
    expect(manager.getMatchCount()).toBe(3);
  });

  it('keeps filtered seqs valid through pause, eviction, replace and clear', () => {
    const manager = create(3);
    manager.setFilter('all', '', true);
    manager.appendLines([noise(), text('first'), noise()]);
    manager.setPaused(true);
    manager.appendLine(text('after pause'));
    expect(manager.getVisibleCount()).toBe(1);
    expect(visibleSeqs(manager)).toEqual([1, 3]);
    manager.setPaused(false);
    expect(manager.getVisibleCount()).toBe(2);
    manager.applyLimits({ maxLines: 1 });
    expect(manager.getVisibleCount()).toBe(1);
    manager.replaceAll([noise()]);
    expect(manager.getVisibleCount()).toBe(0);
    manager.clear();
    manager.appendLine(text('new'));
    expect(manager.getVisibleCount()).toBe(1);
  });

  it('cancels stale large rebuilds and merges new lines appended during a rebuild', async () => {
    const manager = create(20000);
    manager.appendLines(Array.from({ length: 9000 }, (_, index) => index % 2 ? noise() : text('log')));
    manager.setFilter('all', '', true);
    expect(manager.isLoading).toBe(true);
    manager.appendLines([noise(), text('new')]);
    await vi.runAllTimersAsync();
    expect(manager.getVisibleCount()).toBe(4501);
    expect(manager.buffer.length).toBe(9002);
    manager.setFilter('all', '', false);
    manager.setFilter('all', '', true);
    manager.setFilter('all', '', false);
    await vi.runAllTimersAsync();
    expect(manager.getVisibleCount()).toBe(9002);
    expect(manager.isLoading).toBe(false);
  });

  it('leaves the receive assembler and line observers intact across every event split', () => {
    const payload = new Uint8Array([...new TextEncoder().encode('Boot OK\r\n'), ...noise().rawData!, 13, 10, ...new TextEncoder().encode('done\n')]);
    for (let split = 0; split <= payload.length; split++) {
      const manager = create();
      manager.setFilter('all', '', true);
      const onLineAssembled = vi.fn();
      const pipeline = new RxPipeline({
        appendLines: (_port, rows) => { manager.appendLines(rows); },
        getEncodingLabel: () => 'utf-8', getIgnoreEmptyChars: () => false,
        onLineAssembled, scheduleFlush: () => 1, cancelFlush: () => {},
      });
      try {
        pipeline.feedBytes('COM1', payload.slice(0, split), 1);
        pipeline.feedBytes('COM1', payload.slice(split), 2);
        pipeline.flushBeforeSend('COM1');
        expect(manager.getVisibleCount()).toBe(2);
        expect(manager.buffer.length).toBe(3);
        expect(onLineAssembled).toHaveBeenCalledTimes(3);
        expect(manager.buffer.getBySeq(1)?.rawData).toEqual(noise().rawData);
      } finally { pipeline.dispose(); }
    }
  });
});
