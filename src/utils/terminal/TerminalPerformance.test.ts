// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
// Keep Node-only benchmark probes local; production tsconfig is DOM-only.
const runtimeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined>; memoryUsage(): { heapUsed: number } } }).process;
import { TerminalTimeIndex } from './TerminalTimeIndex';
import { countVisibleSeqs, type TerminalSource } from './TerminalSource';
import { TerminalRenderer, type RendererConfig, type TerminalViewState } from './TerminalRenderer';

/** Opt-in observational benchmark, never a CI timing/fps assertion.
 * cmd /c "set HYPERCOM_TERMINAL_BENCH=1&& npx vitest run src/utils/terminal/TerminalPerformance.test.ts"
 * Heap deltas are noisy JS heap samples, not retained-memory/OS RSS claims. */
const enabled = runtimeProcess.env.HYPERCOM_TERMINAL_BENCH === '1';
const config: RendererConfig = { rowHeight: 72, showTimestamp: false, encoding: 'UTF-8', displayFormat: 'string', timestampFormat: 'absolute', timestampMode: 'perLine', connectedAt: null, highlightRuleSets: [] };
const view: TerminalViewState = { visibleSeqs: null, visibleSeqsOffset: 0, frozenSeq: null, matchSet: null, currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null, locked: false, gestureActive: false, followEnabled: false };
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];

describe.skipIf(!enabled)('observational terminal benchmarks', () => {
  it('reports 100k/1m index, bounded eviction, broad-filter count and three-view render costs', () => {
    for (const count of [100000, 1000000]) {
      const index = new TerminalTimeIndex();
      const beforeHeap = runtimeProcess.memoryUsage().heapUsed;
      const buildStart = performance.now();
      // Monotonic common case with stable duplicate timestamps.
      for (let seq = 0; seq < count; seq++) index.add(seq, Math.floor(seq / 3));
      const buildMs = performance.now() - buildStart;
      const heapDeltaMiB = (runtimeProcess.memoryUsage().heapUsed - beforeHeap) / (1024 * 1024);
      const querySamples: number[] = [];
      for (let i = 0; i < 20000; i++) {
        const target = i * 7919 % Math.ceil(count / 3);
        const start = performance.now(); index.lookup(target); querySamples.push(performance.now() - start);
      }
      const evictStart = performance.now();
      for (let seq = 0; seq < count / 2; seq++) index.delete(seq);
      const evictMs = performance.now() - evictStart;
      expect(index.size).toBe(count / 2);
      index.clear(); expect(index.size).toBe(0);
      const seqs = Array.from({ length: count }, (_, seq) => seq);
      const source: TerminalSource = { length: count, firstSeq: 0, lastSeq: count - 1, getBySeq: seq => seq >= 0 && seq < count ? { timestamp: seq, direction: 'RX', content: `row ${seq}`, isHex: false } : null, snapshot: () => { throw new Error('benchmark hot path must not snapshot'); } };
      const countStart = performance.now();
      let total = 0;
      for (let i = 0; i < 20000; i++) total += countVisibleSeqs(source, seqs, 0, i % 2 ? null : count / 2);
      const broadCountMs = performance.now() - countStart;
      expect(total).toBeGreaterThan(0);
      const views = Array.from({ length: 3 }, () => {
        const container = document.createElement('div'); Object.defineProperty(container, 'clientHeight', { value: 720 }); document.body.appendChild(container);
        const renderer = new TerminalRenderer({ ...config }); renderer.attachToContainer(container);
        return { renderer, container };
      });
      const renderSamples: number[] = [];
      for (let i = 0; i < 100; i++) {
        const seq = i * 7919 % count;
        const start = performance.now();
        for (const { renderer } of views) renderer.scrollToSeq(seq, 'center', source, view);
        renderSamples.push(performance.now() - start);
      }
      for (const { renderer, container } of views) { expect(container.querySelectorAll('[data-seq]').length).toBeLessThan(40); renderer.dispose(); container.remove(); }
      console.log('TERMINAL_BENCH', JSON.stringify({ count, buildMs, heapDeltaMiB, lookups: querySamples.length, lookupP50Ms: percentile(querySamples, .5), lookupP95Ms: percentile(querySamples, .95), lookupP99Ms: percentile(querySamples, .99), evictMs, entriesAfterHalfEvict: count / 2, entriesAfterClear: index.size, broadCount20000Ms: broadCountMs, threeViewJsdomSeekP50Ms: percentile(renderSamples, .5), threeViewJsdomSeekP95Ms: percentile(renderSamples, .95), note: 'jsdom CPU samples; not physical frame timing or WebView2 verification' }));
    }
  }, 60000);
});
