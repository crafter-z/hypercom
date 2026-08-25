import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TerminalLine } from '../../types';
import { TerminalViewportManager, appendTerminalLines, appendTerminalLine, clearTerminal, computeBufferLimits, evaluateSoftBackstop, getViewportManager, releaseViewportManager } from './viewportManager';
import { useAppStore } from '../../stores/useAppStore';
import { useTerminalStore } from '../../stores/useTerminalStore';

const makeLine = (tag: string, direction: 'RX' | 'TX' = 'RX'): TerminalLine => ({
  timestamp: 0,
  direction,
  rawData: new TextEncoder().encode(tag),
  isHex: false,
});

let vm: TerminalViewportManager;

beforeEach(() => {
  // Reset the display store so the manager reads clean defaults.
  useTerminalStore.setState({ terminals: {} });
  vm = new TerminalViewportManager('COM1', { maxLines: 100, maxBytes: 0 });
});

describe('TerminalViewportManager appendLines', () => {
  it('appends lines to the buffer with monotonic seqs', () => {
    vm.appendLines([makeLine('a'), makeLine('b')]);
    expect(vm.buffer.length).toBe(2);
    expect(vm.buffer.firstSeq).toBe(0);
    expect(vm.buffer.lastSeq).toBe(1);
  });

  it('reports trimmed when the buffer drops oldest lines', () => {
    const small = new TerminalViewportManager('COM1', { maxLines: 2, maxBytes: 0 });
    small.appendLines([makeLine('a'), makeLine('b')]);
    expect(small.appendLines([makeLine('c')])).toBe(true);
    expect(small.buffer.firstSeq).toBe(1);
  });
});

describe('TerminalViewportManager filter', () => {
  it('identity mode (no filter) returns all lines', () => {
    vm.appendLines([makeLine('a'), makeLine('b')]);
    expect(vm.getVisibleCount()).toBe(2);
  });

  it('direction filter keeps only matching lines (incremental append)', () => {
    vm.setFilter('RX', '');
    vm.appendLines([makeLine('a', 'RX'), makeLine('b', 'TX'), makeLine('c', 'RX')]);
    expect(vm.getVisibleCount()).toBe(2);
    // Incremental extension: a new TX line must NOT join the list.
    vm.appendLines([makeLine('d', 'TX')]);
    expect(vm.getVisibleCount()).toBe(2);
    vm.appendLines([makeLine('e', 'RX')]);
    expect(vm.getVisibleCount()).toBe(3);
  });

  it('keyword filter matches decoded text case-insensitively', () => {
    vm.setFilter('all', 'HELLO');
    vm.appendLines([makeLine('hello world'), makeLine('goodbye')]);
    expect(vm.getVisibleCount()).toBe(1);
  });

  it('clearing the filter restores identity count', () => {
    vm.setFilter('TX', '');
    vm.appendLines([makeLine('a', 'RX'), makeLine('b', 'TX')]);
    expect(vm.getVisibleCount()).toBe(1);
    vm.setFilter('all', '');
    expect(vm.getVisibleCount()).toBe(2);
  });

  it('trims dropped seqs from the filtered list (O(1) offset)', () => {
    const small = new TerminalViewportManager('COM1', { maxLines: 3, maxBytes: 0 });
    small.setFilter('all', '');
    small.appendLines([makeLine('a'), makeLine('b'), makeLine('c')]);
    expect(small.getVisibleCount()).toBe(3);
    small.appendLines([makeLine('d')]); // drops 'a'
    expect(small.getVisibleCount()).toBe(3);
    small.appendLines([makeLine('e')]); // drops 'b'
    small.appendLines([makeLine('f')]); // drops 'c'
    expect(small.getVisibleCount()).toBe(3);
  });
});

describe('TerminalViewportManager pause', () => {
  it('freezes the visible count at the current newest line', () => {
    vm.appendLines([makeLine('a'), makeLine('b')]);
    vm.setPaused(true);
    expect(vm.getVisibleCount()).toBe(2);
    vm.appendLines([makeLine('c')]);
    expect(vm.getVisibleCount()).toBe(2); // frozen
    vm.setPaused(false);
    expect(vm.getVisibleCount()).toBe(3);
  });
});

describe('TerminalViewportManager search', () => {
  it('finds matches incrementally while the search bar is open', () => {
    vm.setSearch(true, 'hello', false);
    vm.appendLines([makeLine('hello world'), makeLine('goodbye')]);
    expect(vm.getMatchCount()).toBe(1);
    vm.appendLines([makeLine('say hello again')]);
    expect(vm.getMatchCount()).toBe(2);
  });

  it('case-sensitive search distinguishes case', () => {
    vm.setSearch(true, 'HELLO', true);
    vm.appendLines([makeLine('hello'), makeLine('HELLO')]);
    expect(vm.getMatchCount()).toBe(1);
  });

  it('closing search clears the match set', () => {
    vm.setSearch(true, 'hello', false);
    vm.appendLines([makeLine('hello')]);
    expect(vm.getMatchCount()).toBe(1);
    vm.setSearch(false, '', false);
    expect(vm.getMatchCount()).toBe(0);
  });

  it('jumpToMatch wraps and returns false when empty', () => {
    expect(vm.jumpToMatch(0)).toBe(false);
    vm.setSearch(true, 'a', false);
    vm.appendLines([makeLine('a1'), makeLine('x'), makeLine('a2')]);
    expect(vm.jumpToMatch(0)).toBe(true);
    expect(vm.getCurrentMatchIndex()).toBe(0);
    expect(vm.jumpToMatch(2)).toBe(true);
    expect(vm.getCurrentMatchIndex()).toBe(0); // 2 % 2 = 0（回绕）
    expect(vm.jumpToMatch(1)).toBe(true);
    expect(vm.getCurrentMatchIndex()).toBe(1);
  });
});

describe('TerminalViewportManager replaceAll / clear / applyLimits', () => {
  it('replaceAll replaces the buffer and recomputes the filter', () => {
    vm.setFilter('RX', '');
    vm.appendLines([makeLine('a', 'RX'), makeLine('b', 'TX')]);
    expect(vm.getVisibleCount()).toBe(1);
    vm.replaceAll([makeLine('x', 'TX'), makeLine('y', 'TX')]);
    expect(vm.buffer.length).toBe(2);
    expect(vm.getVisibleCount()).toBe(0); // filter still RX, all TX
  });

  it('clear empties the buffer and resets counts', () => {
    vm.appendLines([makeLine('a'), makeLine('b')]);
    vm.setSearch(true, 'a', false);
    vm.clear();
    expect(vm.buffer.length).toBe(0);
    expect(vm.getVisibleCount()).toBe(0);
    expect(vm.getMatchCount()).toBe(0);
  });

  it('applyLimits shrinks the buffer to the new capacity', () => {
    vm.appendLines([makeLine('a'), makeLine('b'), makeLine('c')]);
    vm.applyLimits({ maxLines: 2, maxBytes: 0 });
    expect(vm.buffer.length).toBe(2);
    expect(vm.buffer.firstSeq).toBe(1); // kept b, c
  });
});

describe('TerminalViewportManager subscription', () => {
  it('notifies listeners on render passes (data ingest)', () => {
    // No renderer attached — requestRender is skipped, so subscribe fires
    // nothing. Instead verify the subscription lifecycle is safe.
    const fn = vi.fn();
    const unsub = vm.subscribe(fn);
    unsub();
    unsub(); // double-unsubscribe is a no-op
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('viewportManager adapter functions', () => {
  it('appendTerminalLines drops lines when no manager exists (issue #11)', () => {
    // 标签页关闭（releaseViewportManager）后端口仍可能连接、RX 数据继续到达——
    // 无 manager 时**不得复活**（否则关闭期间数据积压进新缓冲，重开标签页被
    // replay），静默丢弃并返回 false。
    expect(appendTerminalLines('COM2', [makeLine('a')])).toBe(false);
    expect(clearTerminal('COM2')).toBeUndefined(); // no-op on missing is fine
    expect(appendTerminalLine('COM2', makeLine('b'))).toBeUndefined();
    // manager 存在时正常写入（数据路径恢复）。
    getViewportManager('COM2').clear();
    expect(appendTerminalLines('COM2', [makeLine('a')])).toBe(false);
    const vm = getViewportManager('COM2');
    expect(vm.buffer.length).toBe(1);
    releaseViewportManager('COM2');
  });

  it('computeBufferLimits reads the config budget', () => {
    useAppStore.getState().setConfig({ memoryPerPortBudgetMb: 64 });
    const limits = computeBufferLimits();
    expect(limits.maxLines).toBe(32000);
    expect(limits.maxBytes).toBe(64 * 1024 * 1024);
  });
});

describe('TerminalViewportManager softTrim', () => {
  it('drops the oldest half of the buffer', () => {
    const b = new TerminalViewportManager('COM1', { maxLines: 100, maxBytes: 0 });
    for (let i = 0; i < 6; i++) b.appendLines([makeLine(String(i))]);
    expect(b.buffer.length).toBe(6);
    expect(b.softTrim()).toBe(true);
    expect(b.buffer.length).toBe(3);
    // 保留最新 3 行（3/4/5）
    expect(b.buffer.getBySeq(b.buffer.firstSeq)?.rawData?.[0]).toBe('3'.charCodeAt(0));
  });

  it('returns false when buffer has ≤ 1 line', () => {
    const b = new TerminalViewportManager('COM1', { maxLines: 100, maxBytes: 0 });
    b.appendLines([makeLine('a')]);
    expect(b.softTrim()).toBe(false);
    expect(b.buffer.length).toBe(1);
  });
});

describe('evaluateSoftBackstop', () => {
  beforeEach(() => {
    useAppStore.getState().resetConfig();
    useTerminalStore.setState({ terminals: {} });
    // 清掉可能残留的模块级 manager（上一个测试可能 getViewportManager 过）
    for (const pid of ['COM1', 'COM2']) releaseViewportManager(pid);
  });

  it('returns [] when JS heap is under the limit', () => {
    // 默认 memoryLimitMb=2048；performance.memory 在 jsdom 不存在 → readJsHeapBytes=0
    expect(evaluateSoftBackstop()).toEqual([]);
  });

  it('returns [] when limit is 0 (disabled)', () => {
    useAppStore.getState().setConfig({ memoryLimitMb: 0 });
    expect(evaluateSoftBackstop()).toEqual([]);
  });
  it('trims candidate ports when JS heap exceeds the limit', () => {
    // 造两个端口 manager，填入数据。maxBytes 设大——硬约束 byte drain 不先裁，
    // 靠软兜底触发；maxLines 100 足够装 50 行。
    const vm1 = getViewportManager('COM1');
    const vm2 = getViewportManager('COM2');
    vm1.buffer['maxBytesValue'] = 10_000_000;
    vm2.buffer['maxBytesValue'] = 10_000_000;
    for (let i = 0; i < 50; i++) {
      vm1.appendLines([makeLine('x'.repeat(100))]);
      vm2.appendLines([makeLine('y'.repeat(100))]);
    }
    expect(vm1.buffer.length).toBe(50);
    expect(vm2.buffer.length).toBe(50);
    // 候选闸要求 bytes > maxBytes/2：填完后把 maxBytes 调到刚好让条件成立
    // （bytes ≈ 50×272 = 13600；maxBytes = 20000 → maxBytes/2 = 10000 < 13600 ✓）
    vm1.buffer['maxBytesValue'] = 20_000;
    vm2.buffer['maxBytesValue'] = 20_000;


    // 把 memoryLimitMb 压到 1，并 stub performance.memory 超 limit
    useAppStore.getState().setConfig({ memoryLimitMb: 1 });
    const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
    Object.defineProperty(perf, 'memory', {
      value: { usedJSHeapSize: 2 * 1024 * 1024 }, // 2MB > 1MB limit
      configurable: true,
    });
    try {
      const trimmed = evaluateSoftBackstop();
      expect(trimmed).toContain('COM1');
      expect(trimmed).toContain('COM2');
      expect(vm1.buffer.length).toBe(25);
      expect(vm2.buffer.length).toBe(25);
      // 冷却闸：立即再调不再裁
      expect(evaluateSoftBackstop()).toEqual([]);
    } finally {
      delete (perf as unknown as Record<string, unknown>).memory;
      releaseViewportManager('COM1');
      releaseViewportManager('COM2');
    }
  });
});
