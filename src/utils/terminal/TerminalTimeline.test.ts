// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalLine } from '../../types';
import { TerminalViewportManager } from './viewportManager';
import { TerminalRenderer, type RendererConfig, type TerminalViewState } from './TerminalRenderer';
import { countVisibleSeqs, mapScrollTop, physicalRowCount, TERMINAL_MAX_PHYSICAL_HEIGHT, type TerminalSource } from './TerminalSource';
import { TerminalTimeIndex } from './TerminalTimeIndex';

const line = (timestamp: number, content = String(timestamp), direction: 'RX' | 'TX' = 'RX'): TerminalLine => ({ timestamp, content, direction, isHex: false });
const config = (rowHeight = 20): RendererConfig => ({ rowHeight, showTimestamp: true, displayFormat: 'string', encoding: 'UTF-8', timestampFormat: 'absolute', timestampMode: 'perLine', highlightRuleSets: [], connectedAt: null });
const view: TerminalViewState = { visibleSeqs: null, visibleSeqsOffset: 0, frozenSeq: null, matchSet: null, currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null, locked: false, gestureActive: false, followEnabled: false };
let rafs: Map<number, FrameRequestCallback>;
let nextRaf: number;
const managers: TerminalViewportManager[] = [];
function frame(): void {
  const callbacks = [...rafs.values()]; rafs.clear();
  for (const callback of callbacks) callback(0);
}
function mount(vm: TerminalViewportManager, height = 200): HTMLDivElement {
  managers.push(vm);
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientHeight', { value: height, configurable: true });
  document.body.appendChild(container);
  vm.attachRenderer(container, config());
  return container;
}
beforeEach(() => {
  rafs = new Map(); nextRaf = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { const id = ++nextRaf; rafs.set(id, fn); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => rafs.delete(id));
});
afterEach(() => {
  for (const vm of managers.splice(0)) vm.dispose();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('terminal timeline index', () => {
  it('selects predecessor by time, stable latest duplicate, never assumes seq monotonic time', () => {
    const vm = new TerminalViewportManager('index', { maxLines: 10 });
    vm.appendLines([line(100), line(300), line(200), line(200), line(Number.NaN)]);
    expect(vm.lookupTime(200)).toMatchObject({ status: 'exact', seq: 3, actualTimeMs: 200 });
    expect(vm.lookupTime(250)).toMatchObject({ status: 'nearest', seq: 3 });
    expect(vm.lookupTime(99)).toMatchObject({ status: 'before-range', seq: 0 });
    expect(vm.lookupTime(301)).toMatchObject({ status: 'after-range', seq: 1 });
    vm.dispose();
  });
  it('queries only filtered/frozen records rather than walking hidden spans', () => {
    const vm = new TerminalViewportManager('filter', { maxLines: 10 });
    vm.appendLines([line(100, 'keep'), line(290, 'hide', 'TX'), line(200, 'keep')]);
    vm.setPaused(true);
    vm.appendLine(line(250, 'keep'));
    vm.setFilter('RX', 'keep');
    expect(vm.lookupTime(280)).toMatchObject({ status: 'after-range', seq: 2, actualTimeMs: 200 });
    expect(vm.getVisibleCount()).toBe(2);
    vm.setPaused(false);
    expect(vm.lookupTime(280)).toMatchObject({ seq: 3, actualTimeMs: 250 });
    vm.setFilter('all', 'missing');
    expect(vm.lookupTime(200).status).toBe('filtered');
    vm.dispose();
  });
  it('reclaims trimmed keys and invalidates clear/replace without seq reuse', () => {
    const vm = new TerminalViewportManager('trim', { maxLines: 2 });
    vm.appendLines([line(100), line(200), line(300)]);
    expect(vm.lookupTime(100)).toMatchObject({ status: 'before-range', seq: 1 });
    const generation = vm.sourceGeneration;
    vm.clear();
    expect(vm.sourceGeneration).toBeGreaterThan(generation);
    expect(vm.lookupTime(100).status).toBe('no-time');
    vm.replaceAll([line(400)]);
    expect(vm.lookupTime(100)).toMatchObject({ seq: 3, actualTimeMs: 400 });
    vm.dispose();
  });
  it('AVL insertion/deletion agrees with a sorted oracle under adversarial clocks', () => {
    const index = new TerminalTimeIndex();
    const entries = Array.from({ length: 1000 }, (_, seq) => ({ seq, time: seq * 7919 % 101 }));
    for (const e of entries) index.add(e.seq, e.time);
    for (let seq = 0; seq < 500; seq++) index.delete(seq);
    const live = entries.slice(500).sort((a, b) => a.time - b.time || a.seq - b.seq);
    for (let t = -1; t <= 102; t++) {
      const expected = [...live].reverse().find(e => e.time <= t) ?? live[0];
      expect(index.lookup(t)?.entry).toEqual(expected);
    }
    expect(index.size).toBe(500);
    index.clear(); expect(index.lookup(2)).toBeNull();
  });
  it('counts broad frozen lists logarithmically and unfrozen lists without element reads', () => {
    let reads = 0;
    const raw = Array.from({ length: 1_000_000 }, (_, i) => i);
    const seqs = new Proxy(raw, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
    const source: TerminalSource = { length: raw.length, firstSeq: 0, lastSeq: raw.length - 1, getBySeq: () => null, snapshot: () => [] };
    expect(countVisibleSeqs(source, seqs, 1000, null)).toBe(999000);
    expect(reads).toBe(0);
    expect(countVisibleSeqs(source, seqs, 1000, 500000)).toBe(499001);
    expect(reads).toBeLessThan(24);
  });
});

describe('scheduled terminal timeline navigation', () => {
  it('latest-wins shares data/scroll rAF and ACKs only after rendering', async () => {
    const vm = new TerminalViewportManager('seek', { maxLines: 1000 });
    const container = mount(vm);
    vm.appendLines(Array.from({ length: 1000 }, (_, i) => line(i)));
    vm.setTimelineGrouped(true);
    const first = vm.scheduleTimelineSeek(100);
    const second = vm.scheduleTimelineSeek(500);
    let finished = false; void second.then(() => { finished = true; });
    expect(rafs.size).toBe(1);
    expect(await first).toMatchObject({ status: 'superseded' });
    expect(finished).toBe(false);
    frame();
    expect(await second).toMatchObject({ status: 'applied', seq: 500, timeMs: 500 });
    expect(container.querySelector('[data-seq="500"]')).not.toBeNull();
    expect(vm.readTimelineAnchor()).toMatchObject({ seq: 500, timeMs: 500 });
  });
  it('pure scroll notifies geometry listeners but not React readout listeners', () => {
    const vm = new TerminalViewportManager('subscriptions', { maxLines: 100 });
    const container = mount(vm); vm.appendLines(Array.from({ length: 100 }, (_, i) => line(i)));
    const readouts = vi.fn(), renders = vi.fn(); vm.subscribeReadouts(readouts); vm.subscribe(renders);
    frame(); readouts.mockClear(); renders.mockClear();
    container.scrollTop = 100; container.dispatchEvent(new Event('scroll')); frame();
    expect(renders).toHaveBeenCalledOnce(); expect(readouts).not.toHaveBeenCalled();
    vm.setFilter('RX', ''); frame(); expect(readouts).toHaveBeenCalledOnce();
  });
  it('aborts stale/cancelled/cleared/detached seeks without applying them', async () => {
    const vm = new TerminalViewportManager('cancel', { maxLines: 100 }); mount(vm);
    vm.appendLines(Array.from({ length: 100 }, (_, i) => line(i))); vm.setTimelineGrouped(true); frame();
    const abort = new AbortController(); const pending = vm.scheduleTimelineSeek(80, 'center', { signal: abort.signal });
    abort.abort(); expect(await pending).toMatchObject({ status: 'aborted' }); frame();
    const stale = vm.scheduleTimelineSeek(80, 'center', { isCurrent: () => false }); expect(await stale).toMatchObject({ status: 'aborted' });
    const cleared = vm.scheduleTimelineSeek(80); vm.clear(); expect(await cleared).toMatchObject({ status: 'aborted' });
    vm.appendLines([line(1)]); const detached = vm.scheduleTimelineSeek(vm.buffer.firstSeq); vm.detachRenderer();
    expect(await detached).toMatchObject({ status: 'unavailable' });
  });
  it('holds external seeks during a native selection and resumes only latest', async () => {
    const vm = new TerminalViewportManager('selection', { maxLines: 100 }); const container = mount(vm);
    vm.appendLines(Array.from({ length: 100 }, (_, i) => line(i))); vm.setTimelineGrouped(true); frame();
    const text = container.querySelector('[data-seq="2"] .terminal-content')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1); window.getSelection()!.addRange(range);
    expect(await vm.seekTimeline({ timeMs: 70, phase: 'commit' })).toMatchObject({ status: 'held' });
    expect(await vm.seekTimeline({ timeMs: 80, phase: 'commit' })).toMatchObject({ status: 'held' });
    // Render once to install the selection watcher; clearing it schedules a pass.
    container.dispatchEvent(new Event('scroll')); frame();
    window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); frame(); frame();
    expect(vm.readTimelineAnchor()?.timeMs).toBe(80);
  });
  it('does not follow independently when grouped or jump to tail on exit', () => {
    const vm = new TerminalViewportManager('follow', { maxLines: 100 }); const container = mount(vm);
    vm.appendLines(Array.from({ length: 100 }, (_, i) => line(i))); vm.setTimelineGrouped(true); frame();
    expect(container.scrollTop).toBe(0);
    vm.setTimelineGrouped(false); frame(); expect(container.scrollTop).toBe(0);
    vm.setLocked(true); frame(); expect(container.scrollTop).toBe(1800);
  });
});

describe('independent read-only document', () => {
  it('references document records, supports unknown timestamps and local format, ignores ring limits/mutations', () => {
    const records = [line(Number.NaN, 'unknown'), line(200, 'B'), line(100, 'A')];
    const snapshot = vi.fn(() => records);
    const source: TerminalSource = { length: 3, firstSeq: 10, lastSeq: 12, getBySeq: seq => records[seq - 10] ?? null, snapshot, getTimeMs: seq => seq === 10 ? null : records[seq - 10]?.timestamp ?? null };
    const vm = new TerminalViewportManager('document', { maxLines: 1 }, { source, display: { encoding: 'UTF-8', displayFormat: 'string' } });
    const container = mount(vm); vm.setLocked(false); frame();
    expect(vm.buffer).toBe(source);
    vm.appendLine(line(999)); vm.clear(); vm.replaceAll([]); vm.applyLimits({ maxLines: 1 });
    expect(vm.buffer.length).toBe(3); expect(snapshot).not.toHaveBeenCalled();
    expect(container.querySelector('[data-seq="10"] .terminal-timestamp')?.textContent).toBe('—');
    expect(vm.lookupTime(150)).toMatchObject({ seq: 12, actualTimeMs: 100 });
    vm.setSearch(true, 'A', false); expect(vm.getMatchCount()).toBe(1);
  });
  it('builds large indexes in cancellable chunks and commit waits for readiness', async () => {
    vi.useFakeTimers();
    const records = Array.from({ length: 10000 }, (_, i) => line(i));
    const source: TerminalSource = { length: records.length, firstSeq: 0, lastSeq: records.length - 1, getBySeq: seq => records[seq] ?? null, snapshot: vi.fn(() => records) };
    const vm = new TerminalViewportManager('large', { maxLines: 1 }, { source }); mount(vm); vm.setTimelineGrouped(true);
    expect(vm.lookupTime(5000).status).toBe('loading');
    expect((await vm.seekTimeline({ timeMs: 5000, phase: 'preview' })).status).toBe('loading');
    const commit = vm.seekTimeline({ timeMs: 5000, phase: 'commit' });
    await vi.runAllTimersAsync(); frame();
    expect(await commit).toMatchObject({ status: 'exact', actualTimeMs: 5000 });
    expect(source.snapshot).not.toHaveBeenCalled();
    vm.refreshSource(); const abort = new AbortController(); const cancelled = vm.seekTimeline({ timeMs: 1, phase: 'commit', signal: abort.signal });
    abort.abort(); expect((await cancelled).status).toBe('unsupported');
    vm.dispose(); await vi.runAllTimersAsync(); expect(vm.lookupTime(1).status).toBe('no-time');
  });
});

describe('cancellable filter/search rebuilds', () => {
  it('replaces stale versions and merges appends during a chunked scan without duplicate seqs', async () => {
    vi.useFakeTimers();
    const vm = new TerminalViewportManager('scan', { maxLines: 11000 }); mount(vm); vm.setTimelineGrouped(true);
    vm.appendLines(Array.from({ length: 10000 }, (_, i) => line(i, i % 2 ? 'odd' : 'even')));
    vm.setFilter('all', 'odd'); vm.setSearch(true, 'odd', false);
    expect(vm.isLoading).toBe(true); expect(vm.lookupTime(9999).status).toBe('loading');
    vm.setFilter('all', 'even'); vm.setSearch(true, 'even', false);
    vm.appendLines([line(10000, 'even'), line(10001, 'odd')]);
    const commit = vm.seekTimeline({ timeMs: 10000, phase: 'commit' });
    await vi.runAllTimersAsync(); frame();
    expect(await commit).toMatchObject({ status: 'exact', actualTimeMs: 10000 });
    expect(vm.isLoading).toBe(false);
    expect(vm.getVisibleCount()).toBe(5001); expect(vm.getMatchCount()).toBe(5001);
    expect(vm.lookupTime(9999)).toMatchObject({ seq: 9998, actualTimeMs: 9998 });
  });
  it('clear cancels all scan work and cannot resurrect old results or blocked commits', async () => {
    vi.useFakeTimers();
    const vm = new TerminalViewportManager('clear-scan', { maxLines: 10000 }); mount(vm);
    vm.appendLines(Array.from({ length: 10000 }, (_, i) => line(i, 'hit')));
    vm.setFilter('RX', 'hit'); vm.setSearch(true, 'hit', false);
    const commit = vm.seekTimeline({ timeMs: 50, phase: 'commit' });
    vm.clear(); vm.appendLine(line(20000, 'hit'));
    await vi.runAllTimersAsync(); frame();
    expect((await commit).status).toBe('unsupported');
    expect(vm.isLoading).toBe(false); expect(vm.getVisibleCount()).toBe(1); expect(vm.getMatchCount()).toBe(1);
    expect(vm.lookupTime(50)).toMatchObject({ actualTimeMs: 20000, status: 'before-range' });
  });
  it('rolling trim during scan drops stale keys and preserves frozen upper bounds', async () => {
    vi.useFakeTimers();
    const vm = new TerminalViewportManager('trim-scan', { maxLines: 10000 }); mount(vm);
    vm.appendLines(Array.from({ length: 10000 }, (_, i) => line(i, 'hit')));
    vm.setPaused(true); vm.setFilter('all', 'hit'); vm.setSearch(true, 'hit', false);
    vm.appendLines(Array.from({ length: 2000 }, (_, i) => line(10000 + i, 'hit')));
    await vi.runAllTimersAsync(); frame();
    expect(vm.getVisibleCount()).toBe(8000); expect(vm.getMatchCount()).toBe(8000);
    expect(vm.lookupTime(0)).toMatchObject({ seq: 2000, status: 'before-range' });
    expect(vm.lookupTime(20000)).toMatchObject({ seq: 9999, status: 'after-range' });
  });
});

describe('bounded virtual geometry', () => {
  it('maps full million-record range monotonically and materializes first/middle/last at maximum font height', () => {
    const count = 1_000_000, rowHeight = 96;
    const source: TerminalSource = { length: count, firstSeq: 0, lastSeq: count - 1, getBySeq: seq => seq >= 0 && seq < count ? line(seq) : null, snapshot: () => { throw new Error('no snapshot in renderer'); } };
    const renderer = new TerminalRenderer(config(rowHeight));
    const container = document.createElement('div'); Object.defineProperty(container, 'clientHeight', { value: 960 }); document.body.appendChild(container); renderer.attachToContainer(container);
    const physical = physicalRowCount(count, rowHeight);
    let previous = -1;
    for (let seq = 0; seq < count; seq += 10000) {
      const top = mapScrollTop(seq * rowHeight, count, physical, rowHeight, 960); expect(top).toBeGreaterThanOrEqual(previous); previous = top;
    }
    for (const seq of [0, 500000, count - 1]) {
      renderer.scrollToSeq(seq, seq === 0 ? 'start' : seq === count - 1 ? 'end' : 'center', source, view);
      expect(container.querySelector(`[data-seq="${seq}"]`)).not.toBeNull();
      const layer = container.querySelector('.terminal-content-layer')!;
      const totalHeight = [...layer.children].reduce((sum, node) => sum + Number.parseFloat((node as HTMLElement).style.height || '0'), 0);
      expect(totalHeight).toBeLessThanOrEqual(TERMINAL_MAX_PHYSICAL_HEIGHT);
      expect(container.querySelectorAll('[data-seq]').length).toBeLessThan(40);
    }
    renderer.dispose();
  });
});
