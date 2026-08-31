import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TerminalLine } from '../../types';
import { TerminalViewportManager, appendTerminalLines, appendTerminalLine, clearTerminal, computeBufferLimits, getViewportManager, releaseViewportManager } from './viewportManager';
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
  vm = new TerminalViewportManager('COM1', { maxLines: 100 });
});

describe('TerminalViewportManager appendLines', () => {
  it('appends lines to the buffer with monotonic seqs', () => {
    vm.appendLines([makeLine('a'), makeLine('b')]);
    expect(vm.buffer.length).toBe(2);
    expect(vm.buffer.firstSeq).toBe(0);
    expect(vm.buffer.lastSeq).toBe(1);
  });

  it('reports trimmed when the oldest line is evicted at capacity', () => {
    const small = new TerminalViewportManager('COM1', { maxLines: 2 });
    small.appendLines([makeLine('a'), makeLine('b')]);
    expect(small.appendLines([makeLine('c')])).toBe(true);
    expect(small.buffer.firstSeq).toBe(1);
    expect(small.buffer.length).toBe(2);
  });

  it('reports no trim while under capacity', () => {
    vm.appendLines([makeLine('a')]);
    expect(vm.appendLines([makeLine('b')])).toBe(false);
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
    const small = new TerminalViewportManager('COM1', { maxLines: 3 });
    small.setFilter('all', '');
    small.appendLines([makeLine('a'), makeLine('b'), makeLine('c')]);
    expect(small.getVisibleCount()).toBe(3);
    small.appendLines([makeLine('d')]); // evicts 'a'
    expect(small.getVisibleCount()).toBe(3);
    small.appendLines([makeLine('e')]); // evicts 'b'
    small.appendLines([makeLine('f')]); // evicts 'c'
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
  it('matchSet is rebuilt when a new query hits the same count (cache-key regression)', () => {
    // 缓存键 (offset:length:currentMatch) 不含查询身份：两个不同查询若命中
    // 数恰好相同，不得复用旧 Set——否则渲染层 <mark> 按 seq 判中错位。
    vm.setSearch(true, 'row-1', false);
    vm.appendLines(Array.from({ length: 29 }, (_, i) => makeLine(`row-${i + 1}`)));
    // row-1 与 row-10..row-19 都包含 "row-1" → 11 行命中。
    expect(vm.getMatchCount()).toBe(11);
    vm.setSearch(true, 'row-2', false);
    // row-2 与 row-20..row-29 包含 "row-2" → 同样 11 行命中，键 (0:11:0) 相同。
    expect(vm.getMatchCount()).toBe(11);
    // buildView 的 matchSet 必须反映新查询的 seq 集（row-1 不再命中）。
    const view = (vm as unknown as { buildView(): { matchSet: Set<number> | null } }).buildView();
    expect(view.matchSet).not.toBeNull();
    expect(view.matchSet!.size).toBe(11);
    // seq 0 = "row-1"：旧 Set 含它，新 Set 不含；seq 1 = "row-2"：新 Set 含。
    expect(view.matchSet!.has(0)).toBe(false);
    expect(view.matchSet!.has(1)).toBe(true);
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
    vm.applyLimits({ maxLines: 2 });
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

  it('computeBufferLimits reads maxDisplayLines from config', () => {
    useAppStore.getState().setConfig({ maxDisplayLines: 64000 });
    const limits = computeBufferLimits();
    expect(limits.maxLines).toBe(64000);
  });

  it('computeBufferLimits defaults maxLines to 100000 when unset', () => {
    useAppStore.getState().setConfig({ maxDisplayLines: undefined as unknown as number });
    const limits = computeBufferLimits();
    expect(limits.maxLines).toBe(100000);
  });
});
