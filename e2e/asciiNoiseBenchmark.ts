import { expect, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** Opt-in observational benchmark. Uses real app hooks/queue/DOM with mocked
 * serial:data delivery; it does NOT measure Rust, native IPC, disk IO or a UART.
 * Run alone with --workers=1; no CI performance thresholds. */
export async function runAsciiNoiseBenchmark(page: Page, info: TestInfo, feature: 'noise' | 'wrap' = 'noise') {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.locator('.port-item-name', { hasText: 'COM1' }).dblclick();
  await expect(page.locator('.terminal-noise-filter input')).toBeVisible();
  await page.evaluate(async () => {
    const root = '/src/';
    const { getViewportManager } = await import(root + 'utils/terminal/viewportManager.ts');
    const { getRxPipeline } = await import(root + 'utils/rxPipeline.ts');
    const { useTerminalStore } = await import(root + 'stores/useTerminalStore.ts');
    const manager = getViewportManager('COM1');
    const pipeline = getRxPipeline();
    const state = { manager, pipeline, store: useTerminalStore, appendMs: 0, appendCalls: 0 };
    const append = manager.appendLines;
    manager.appendLines = function (rows: unknown[]) {
      const start = performance.now();
      try { return append.call(this, rows); }
      finally { state.appendMs += performance.now() - start; state.appendCalls++; }
    };
    (window as any).__ASCII_BENCH__ = state;
  });
  const metrics = async () => {
    const response = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(response.metrics.map(metric => [metric.name, metric.value]));
  };
  const waitReady = async () => page.evaluate(async () => {
    const { manager } = (window as any).__ASCII_BENCH__;
    while (manager.isLoading) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const cases = [
    { name: 'ascii-115200', kind: 'ascii', rowBytes: 64, bytesPerSecond: 11520, search: false },
    { name: 'ascii-4Mbaud', kind: 'ascii', rowBytes: 64, bytesPerSecond: 400000, search: false },
    { name: 'noise-4Mbaud', kind: 'noise', rowBytes: 64, bytesPerSecond: 400000, search: false },
    { name: 'mixed-4Mbaud', kind: 'mixed', rowBytes: 64, bytesPerSecond: 400000, search: false },
    { name: 'mixed-search-4Mbaud', kind: 'mixed', rowBytes: 64, bytesPerSecond: 400000, search: true },
    { name: 'ascii-long-4Mbaud', kind: 'ascii', rowBytes: 4096, bytesPerSecond: 400000, search: false },
    { name: 'ascii-stress-4MBps', kind: 'ascii', rowBytes: 64, bytesPerSecond: 4000000, search: false },
    ...(feature === 'wrap' ? [{ name: 'ascii-search-4Mbaud', kind: 'ascii', rowBytes: 64, bytesPerSecond: 400000, search: true }] : []),
  ].filter(spec => feature === 'noise' || spec.kind === 'ascii');
  const streaming: any[] = [];
  // One short throw-away run loads/transforms modules and warms actual hot paths.
  await page.evaluate(async feature => {
    const state = (window as any).__ASCII_BENCH__;
    state.store.getState().setTerminalConfig('COM1', { wordWrap: feature === 'wrap' });
    const data = Array.from(new TextEncoder().encode(('INFO warmup ready\n').repeat(100)));
    for (let i = 0; i < 30; i++) {
      window.__TAURI_INTERNALS__.dispatchEvent('serial:data', { port_id: 'COM1', timestamp: Date.now(), direction: 'RX', data, is_hex: false });
      await new Promise(requestAnimationFrame);
    }
    state.pipeline.flushBeforeSend('COM1');
    state.manager.clear();
  }, feature);

  for (const spec of cases) {
    for (let repeat = 0; repeat < 3; repeat++) {
      // Alternate order to reduce JIT/thermal/background ordering bias.
      for (const enabled of repeat % 2 ? [true, false] : [false, true]) {
        await page.evaluate(({ enabled, search, feature }) => {
          const state = (window as any).__ASCII_BENCH__;
          state.pipeline.flushBeforeSend('COM1');
          state.manager.clear();
          state.manager.applyLimits({ maxLines: 100000 });
          state.store.getState().setTerminalConfig('COM1', { hideAsciiNoise: feature === 'noise' && enabled, wordWrap: feature === 'wrap' && enabled, displayFormat: 'string' });
          state.manager.setSearch(search, search ? 'INFO' : '', false);
        }, { enabled, search: spec.search, feature });
        await waitReady();
        // Allocate deterministic source chunks BEFORE timing, separate from RX allocations.
        await page.evaluate(spec => {
          const chunks: number[][] = [];
          const seed = new TextEncoder().encode('INFO sensor ready sample=0123456789 status=OK ');
          for (let chunkIndex = 0; chunkIndex < 256; chunkIndex++) {
            const data: number[] = [];
            for (let i = 0; i < 1024; i++) {
              const absolute = chunkIndex * 1024 + i;
              const rowIndex = Math.floor(absolute / spec.rowBytes);
              const position = absolute % spec.rowBytes;
              const isNoise = spec.kind === 'noise' || (spec.kind === 'mixed' && rowIndex % 2 === 1);
              data.push(position === spec.rowBytes - 1 ? 10 : isNoise
                ? (position % 9 === 4 ? 65 + (rowIndex % 26) : 0x80 + ((position * 17 + rowIndex) % 128))
                : seed[(position + rowIndex % 5) % seed.length]);
            }
            chunks.push(data);
          }
          (window as any).__ASCII_BENCH__.chunks = chunks;
        }, spec);
        await cdp.send('HeapProfiler.collectGarbage');
        const before = await metrics();
        const sample = await page.evaluate(async ({ spec, enabled, repeat }) => {
          const state = (window as any).__ASCII_BENCH__;
          state.appendMs = 0; state.appendCalls = 0;
          const firstSeq = state.manager.buffer.lastSeq;
          const intervals: number[] = [], longTasks: number[] = [];
          let previous = performance.now(), frameActive = true, frameHandle = 0;
          const frame = (now: number) => {
            intervals.push(now - previous); previous = now;
            if (frameActive) frameHandle = requestAnimationFrame(frame);
          };
          frameHandle = requestAnimationFrame(frame);
          const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) longTasks.push(entry.duration);
          });
          observer.observe({ type: 'longtask', buffered: false });
          const durationMs = 2000, quantum = Math.max(1024, spec.rowBytes);
          const plannedBytes = Math.floor(spec.bytesPerSecond * durationMs / 1000 / quantum) * quantum;
          const start = performance.now();
          let sentBytes = 0, handlerMs = 0;
          while (sentBytes < plannedBytes) {
            const elapsed = performance.now() - start;
            const due = Math.min(plannedBytes, Math.floor(spec.bytesPerSecond * Math.min(elapsed, durationMs) / 1000 / quantum) * quantum);
            while (sentBytes < due) {
              const data = state.chunks[(sentBytes / 1024) % state.chunks.length];
              const callStart = performance.now();
              window.__TAURI_INTERNALS__.dispatchEvent('serial:data', {
                port_id: 'COM1', timestamp: Date.now(), direction: 'RX', data, is_hex: false,
              });
              handlerMs += performance.now() - callStart;
              sentBytes += data.length;
            }
            if (sentBytes < plannedBytes) await new Promise(resolve => setTimeout(resolve, 8));
          }
          const producerElapsedMs = performance.now() - start;
          // Count queued rows BEFORE draining, so a forced flush cannot disguise backlog.
          const assembledBeforeDrain = state.manager.buffer.lastSeq - firstSeq;
          state.pipeline.flushBeforeSend('COM1');
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const elapsedMs = performance.now() - start;
          frameActive = false; cancelAnimationFrame(frameHandle);
          longTasks.push(...observer.takeRecords().map(entry => entry.duration));
          observer.disconnect();
          const sorted = intervals.slice(1).sort((a, b) => a - b);
          const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
          const assembled = state.manager.buffer.lastSeq - firstSeq;
          return {
            ...spec, enabled, repeat, durationMs, elapsedMs, producerElapsedMs,
            sentBytes, expectedRows: sentBytes / spec.rowBytes, assembled,
            backlogBeforeDrain: assembled - assembledBeforeDrain,
            visibleRows: state.manager.getVisibleCount(), retainedRows: state.manager.buffer.length,
            handlerMs, appendMs: state.appendMs, appendCalls: state.appendCalls,
            frameP50Ms: percentile(.5), frameP95Ms: percentile(.95), frameMaxMs: sorted.at(-1) ?? 0,
            longTasks: longTasks.length, longestTaskMs: Math.max(0, ...longTasks),
            domRows: document.querySelectorAll('.terminal-line').length,
          };
        }, { spec, enabled, repeat });
        const after = await metrics();
        const cpu = (after.TaskDuration - before.TaskDuration) * 1000;
        await cdp.send('HeapProfiler.collectGarbage');
        const retained = await metrics();
        const row = { ...sample, taskMs: cpu, taskSharePct: cpu / sample.elapsedMs * 100,
          taskMsPerMiB: cpu / (sample.sentBytes / 1048576),
          retainedHeapDeltaMiB: (retained.JSHeapUsedSize - before.JSHeapUsedSize) / 1048576 };
        expect(row.assembled, 'no RX rows dropped by the frontend queue').toBe(row.expectedRows);
        expect(row.domRows).toBeLessThan(100);
        streaming.push(row);
        console.log(feature === 'wrap' ? 'WRAP_STREAM_BENCH' : 'ASCII_STREAM_BENCH', JSON.stringify(row));
      }
    }
  }

  const switching: any[] = [];
  // Isolated managers use actual buffer/filter/time index but no DOM/React, so
  // settle time and synchronous call time can be separated from rendering.
  for (const count of feature === 'noise' ? [100000, 1000000] : []) {
    for (const kind of ['ascii', 'mixed']) {
      const sample = await page.evaluate(async ({ count, kind }) => {
        const root = '/src/';
        const { TerminalViewportManager } = await import(root + 'utils/terminal/viewportManager.ts');
        const manager = new TerminalViewportManager('BENCH-HISTORY', { maxLines: count });
        const ascii = new TextEncoder().encode('INFO sample=0123456789 status=OK');
        const noise = new Uint8Array([0x80, 65, 0xff, 0x90, 66, 0xfe, 0x7f, 0x81]);
        const historyFrameIntervals: number[] = [];
        let previous = performance.now(), active = true, frameHandle = 0;
        const frame = (now: number) => {
          historyFrameIntervals.push(now - previous); previous = now;
          if (active) frameHandle = requestAnimationFrame(frame);
        };
        // Every history row owns distinct bytes, as actual receive rows do.
        for (let base = 0; base < count; base += 2000) {
          manager.appendLines(Array.from({ length: Math.min(2000, count - base) }, (_, offset) => ({
            timestamp: base + offset, direction: 'RX', isHex: false,
            rawData: (kind === 'mixed' && (base + offset) % 2 ? noise : ascii).slice(),
          })));
          if (base % 20000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        const output: any[] = [];
        frameHandle = requestAnimationFrame(frame);
        try {
          for (let repeat = 0; repeat < 3; repeat++) for (const enabled of [true, false]) {
            const start = performance.now();
            manager.setFilter('all', '', enabled);
            const syncMs = performance.now() - start;
            while (manager.isLoading) await new Promise(resolve => setTimeout(resolve, 4));
            output.push({ count, kind, repeat, enabled, syncMs, settleMs: performance.now() - start,
              visibleRows: manager.getVisibleCount(), retainedRows: manager.buffer.length });
          }
        } finally { active = false; cancelAnimationFrame(frameHandle); manager.dispose(); }
        const sorted = historyFrameIntervals.slice(1).sort((a, b) => a - b);
        return { samples: output, frameP95Ms: sorted[Math.floor(sorted.length * .95)] ?? 0, frameMaxMs: sorted.at(-1) ?? 0 };
      }, { count, kind });
      expect(sample.samples.every(row => row.retainedRows === count)).toBe(true);
      switching.push(sample);
      console.log('ASCII_SWITCH_BENCH', JSON.stringify(sample));
    }
  }
  const artifact = { feature, recordedAt: new Date().toISOString(), browserVersion: page.context().browser()?.version(),
    method: 'Actual app RX hooks + pipeline + DOM, synthetic 1024-byte serial:data events; 2s/sample, 3 paired runs, alternating order; CDP main-thread TaskDuration, not system CPU or native WebView2 FPS. No native IO/IPC/logging.',
    historyMethod: feature === 'noise' ? 'Isolated manager, 3 enable/disable pairs.' : 'Not sampled here; million-record wrap geometry has separate browser regressions.',
    streaming, switching };
  const name = feature === 'wrap' ? 'word-wrap-results' : 'ascii-noise-results';
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify(artifact, null, 2));
  await info.attach(name, { body: JSON.stringify(artifact), contentType: 'application/json' });
  await cdp.detach();
  return artifact;
}
